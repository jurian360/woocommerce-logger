/**
 * Password-only session auth for the dashboard.
 *
 * One shared password, `DASHBOARD_PASSWORD`, entered on `/login`. There is no
 * user list and no database: the audit log has exactly one audience, the shop
 * owner, and a second credential to lose would not make it safer.
 *
 * The session is a cookie holding `<expiry>.<hmac>`, signed with the password
 * itself as the key. Nothing is stored server-side, which matters on Vercel
 * where every request may hit a different instance. Two consequences follow,
 * both deliberate:
 *
 *   - changing `DASHBOARD_PASSWORD` invalidates every existing session, because
 *     the key that signed them is gone. That is the logout-everywhere switch.
 *   - the cookie carries its own expiry *inside* the signature, so trimming the
 *     browser-side `Max-Age` cannot extend a session.
 *
 * Everything here runs on the Edge runtime (`middleware.ts` verifies the
 * cookie), so: Web Crypto, `TextEncoder`, `btoa` — no `node:crypto`, no
 * `Buffer`. Which is also why `lib/secret.ts` is not reused; that one is Node
 * only and guards the API routes.
 */

export const SESSION_COOKIE = 'wc_audit_session';

/** How long a login lasts. Re-entering a password weekly is not a burden. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Namespaces the HMAC key, so the cookie signature is not a naked password
 * oracle shared with anything else that might key off the same value. */
const KEY_PREFIX = 'wc-audit-dashboard/session/v1:';

/** Signed alongside the expiry, so a future format change cannot be replayed. */
const TOKEN_VERSION = 'v1';

const encoder = new TextEncoder();

/**
 * Length-independent comparison, so neither the password nor a signature can be
 * recovered one byte at a time from response timing.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;

  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return mismatch === 0;
}

/** The configured password, or `''` when the dashboard is left open. */
export function dashboardPassword(): string {
  return (process.env.DASHBOARD_PASSWORD ?? '').trim();
}

/** Whether the login screen is in force. Unset password → open dashboard,
 * which is what local development wants. */
export function authEnabled(): boolean {
  return dashboardPassword() !== '';
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(password: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(KEY_PREFIX + password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));

  return base64url(new Uint8Array(signature));
}

/** `<expires-at-ms>.<signature>`. */
export async function createSessionToken(
  password: string,
  now: number = Date.now(),
  maxAgeSeconds: number = SESSION_MAX_AGE_SECONDS
): Promise<string> {
  const expiresAt = now + maxAgeSeconds * 1000;

  return `${expiresAt}.${await sign(password, `${TOKEN_VERSION}.${expiresAt}`)}`;
}

/** True only for a token this password signed, that has not expired yet. */
export async function verifySessionToken(
  token: string | null | undefined,
  password: string,
  now: number = Date.now()
): Promise<boolean> {
  if (!token || password === '') {
    return false;
  }

  const separator = token.indexOf('.');
  if (separator === -1) {
    return false;
  }

  const rawExpiry = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  // Digits only: `Number(' 1 ')` and `Number('1e99')` both parse, and neither
  // should be accepted as a timestamp.
  if (!/^\d+$/.test(rawExpiry) || signature === '') {
    return false;
  }

  const expiresAt = Number(rawExpiry);

  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    return false;
  }

  return constantTimeEquals(
    signature,
    await sign(password, `${TOKEN_VERSION}.${rawExpiry}`)
  );
}

/**
 * Where to send someone after a successful login. Only same-origin paths are
 * allowed through: `?next=` comes from the URL bar, and echoing it back
 * unchecked turns the login screen into an open redirect.
 */
export function safeRedirect(raw: string | null | undefined, fallback = '/'): string {
  const value = (raw ?? '').trim();

  if (!value.startsWith('/')) {
    return fallback;
  }

  // `//host` is protocol-relative and `/\host` is treated as such by browsers.
  if (/^\/[/\\]/.test(value)) {
    return fallback;
  }

  return value;
}
