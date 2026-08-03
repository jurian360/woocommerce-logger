import type { MetadataRoute } from 'next';

/**
 * Served at `/robots.txt`.
 *
 * The dashboard exposes who changed what and when, so nothing here should ever
 * be crawled or indexed — the API is not public either. This mirrors the
 * `noindex` in `app/layout.tsx`; neither is access control (use
 * `DASHBOARD_PASSWORD` for that), but it keeps the audit log out of search
 * results.
 *
 * `middleware.ts` deliberately lets this path past the login gate: a robots.txt
 * that redirects to a login page tells a crawler nothing.
 */
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: '/',
      },
    ],
  };
}
