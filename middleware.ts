import { NextResponse, type NextRequest } from 'next/server';

import {
  SESSION_COOKIE,
  dashboardPassword,
  verifySessionToken,
} from '@/lib/auth';

/**
 * Gate for the dashboard.
 *
 * The audit log contains who changed what and when — it should not be world
 * readable. When `DASHBOARD_PASSWORD` is set, every page request must carry a
 * valid session cookie, and anything else is sent to `/login`. When it is empty
 * the dashboard stays open, which is fine for local development.
 *
 * The ingest and cleanup routes (`/api/*`) are excluded by the matcher: they
 * authenticate with the `X-Api-Secret` header instead, and a redirect to an
 * HTML login page would be a confusing answer to a machine.
 *
 * This runs on the Edge runtime, so the cookie is verified with Web Crypto via
 * `lib/auth.ts` — `node:crypto` and `Buffer` are unavailable here.
 */

/** The one path that must stay reachable while logged out. */
const LOGIN_PATH = '/login';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const password = dashboardPassword();

  if (password === '') {
    return NextResponse.next();
  }

  const { pathname, search } = request.nextUrl;

  // Also lets the login form's server action (a POST to this same path) run.
  if (pathname === LOGIN_PATH) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (await verifySessionToken(token, password)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = '';

  // Come back to the filtered view that was asked for, not just `/`.
  const target = `${pathname}${search}`;
  if (target !== '/') {
    url.searchParams.set('next', target);
  }

  const response = NextResponse.redirect(url);

  // Expired or signed with a previous password: drop it, so the browser stops
  // sending a cookie that can never succeed again.
  if (token) {
    response.cookies.delete(SESSION_COOKIE);
  }

  return response;
}

export const config = {
  // `robots.txt` and the icons stay outside the gate: a crawler that gets a
  // redirect for robots.txt learns nothing, and browsers request the icon
  // without cookies, which would otherwise render the login page as an icon.
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml).*)',
  ],
};
