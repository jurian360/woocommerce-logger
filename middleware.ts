import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optional HTTP Basic Auth for the dashboard.
 *
 * The audit log contains who changed what and when — it should not be world
 * readable. When `DASHBOARD_USER` and `DASHBOARD_PASSWORD` are both set, every
 * page request must authenticate. When either is empty the dashboard stays
 * open, which is fine for local development.
 *
 * The ingest route (`/api/*`) is excluded: it authenticates with the
 * `X-Api-Secret` header instead.
 */

/** Length-independent comparison to avoid leaking the password by timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;

  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return mismatch === 0;
}

function challenge(): NextResponse {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="WooCommerce Audit Log", charset="UTF-8"',
    },
  });
}

export function middleware(request: NextRequest): NextResponse {
  const user = process.env.DASHBOARD_USER;
  const password = process.env.DASHBOARD_PASSWORD;

  if (!user || !password) {
    return NextResponse.next();
  }

  const header = request.headers.get('authorization');

  if (!header || !header.toLowerCase().startsWith('basic ')) {
    return challenge();
  }

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return challenge();
  }

  const separator = decoded.indexOf(':');
  if (separator === -1) {
    return challenge();
  }

  const providedUser = decoded.slice(0, separator);
  const providedPassword = decoded.slice(separator + 1);

  const ok =
    constantTimeEquals(providedUser, user) &&
    constantTimeEquals(providedPassword, password);

  return ok ? NextResponse.next() : challenge();
}

export const config = {
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
};
