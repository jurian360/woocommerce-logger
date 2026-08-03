'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  constantTimeEquals,
  createSessionToken,
  dashboardPassword,
  safeRedirect,
} from '@/lib/auth';

/** A `'use server'` module may only export async functions, so the initial
 * value of this state lives in the client component, not here. */
export interface LoginState {
  error: string | null;
}

/**
 * Checks the password and, on success, sets the session cookie.
 *
 * `redirect()` works by throwing, so the successful path must not sit inside a
 * `try`. The failing path returns state instead of redirecting, so the message
 * can be rendered next to the field that produced it.
 */
export async function login(
  _previous: LoginState,
  formData: FormData
): Promise<LoginState> {
  const expected = dashboardPassword();
  const next = safeRedirect(String(formData.get('next') ?? ''));

  // No password configured means no login screen; nothing to do but leave.
  if (expected === '') {
    redirect(next);
  }

  const provided = String(formData.get('password') ?? '');

  if (!constantTimeEquals(provided, expected)) {
    return { error: 'That password is not correct.' };
  }

  const store = await cookies();

  store.set({
    name: SESSION_COOKIE,
    value: await createSessionToken(expected),
    httpOnly: true,
    sameSite: 'lax',
    // Plain HTTP is only ever local development; a Secure cookie there would
    // never be sent back and the login would appear to silently fail.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  redirect(next);
}

/** Drops the session cookie. The token stays valid until it expires — it is
 * simply no longer held by anyone. */
export async function logout(): Promise<void> {
  const store = await cookies();

  store.delete(SESSION_COOKIE);

  redirect('/login');
}
