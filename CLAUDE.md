# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A one-way audit pipeline for WooCommerce product changes. It is **two programs
that must agree on a JSON contract**, living in one repo:

1. A **WordPress plugin** (`wordpress/wc-audit-logger.php`) that detects product
   changes and POSTs them.
2. A **Next.js app** (App Router, TypeScript) that receives, stores, and
   displays them.

```
WordPress/WooCommerce  ──POST /api/logs/product-change──►  Next.js on Vercel  ──►  MongoDB Atlas
   (plugin, PHP)          X-Api-Secret header                (route handler)         (audit_logs)
                                                                    │
                                                             GET /  (dashboard)
```

Data flows one way only. The Next.js side never calls WordPress.

## Layout

| Path | Role |
| --- | --- |
| `wordpress/wc-audit-logger.php` | The entire WordPress plugin, single file, no build step |
| `app/api/logs/product-change/route.ts` | Ingest endpoint (`POST`) + health probe (`GET`) |
| `app/api/logs/cleanup/route.ts` | Retention purge, called daily by the cron in `vercel.json` |
| `app/page.tsx` | Server-rendered dashboard, 50 entries per page in the selected window |
| `app/filter-bar.tsx` | Client component: day filter + SKU search, state lives in the URL |
| `app/timezone-select.tsx` | Client component: timezone picker, also URL state (`?tz=`) |
| `app/pagination.tsx` | Server component: `next/link` page links below the table |
| `app/login/` | Password login screen: `page.tsx`, `login-form.tsx`, and the `login`/`logout` server actions |
| `app/robots.ts` | `robots.txt` — `Disallow: /` for everything |
| `app/icon.svg` / `app/favicon.ico` | Favicon. The SVG is the source of truth; the `.ico` is a rasterised copy for clients that ignore SVG icons |
| `lib/db.ts` | Cached Mongoose connection |
| `lib/format.ts` | Renders stored diffs into "from → to" lines |
| `lib/log-query.ts` | Retention window, search-param parsing, Mongo filter building |
| `lib/timezone.ts` | Resolves a requested zone, maps `UTC±H` to its IANA name |
| `lib/secret.ts` | Constant-time secret comparison, shared by both routes |
| `lib/auth.ts` | Dashboard password + signed session cookie (Edge-safe) |
| `models/AuditLog.ts` | Mongoose schema |
| `types/audit.ts` | Shared TS types for the payload/record |
| `middleware.ts` | Sends anyone without a valid session cookie to `/login` |
| `vercel.json` | Cron schedule for the purge |
| `tests/` | Standalone harnesses, no test framework |
| `postman/` | Importable collection for manual API testing |

## Commands

```bash
npm run dev        # local dev server
npm run build      # production build (also typechecks)
npm test           # TS + PHP harnesses
npm run test:ts    # schema + formatter + log queries + paging + timezone + auth (91 assertions)
npm run test:php   # plugin capture/dispatch (28 assertions)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
php -l wordpress/wc-audit-logger.php   # lint the plugin
```

`tests/plugin-live.php` is separate and not in `npm test` — it drives the
plugin's diagnostics against a **running** instance over real HTTP:

```bash
ENDPOINT=http://127.0.0.1:3000/api/logs/product-change SECRET=xxx php tests/plugin-live.php
```

### `tests/` is excluded from the app's tsconfig — keep it that way

The harnesses run under `node --experimental-strip-types`, which requires
explicit `.ts` extensions on imports (`from '../lib/format.ts'`). The Next.js
build rejects those unless `allowImportingTsExtensions` is on, which is not
appropriate for app code. So:

- root `tsconfig.json` has `"exclude": ["node_modules", "tests"]`
- `tests/tsconfig.json` enables `allowImportingTsExtensions` for the harnesses
- `npm run typecheck` runs **both** configs

Adding a `.ts` file under `tests/` that the root config picks up will fail
`next build` on Vercel with *"An import path can only end with a '.ts'
extension"* — the build compiles fine and then dies in the typecheck phase.
Always run `npm run build` locally before pushing, and note that a warm `.next`
cache can hide it: `rm -rf .next` first.

## The eight things that are easy to get wrong

### 1. WooCommerce erases `get_changes()` before the "after" hook

`WC_Product::save()` calls `$this->data_store->update()`, which ends with
`$product->apply_changes()` — emptying `get_changes()` — and only *then* fires
`woocommerce_after_product_object_save`. Reading changes in the `after` hook
yields nothing.

So the plugin uses **two hooks**:

- `woocommerce_before_..._object_save` → `capture()`. Here `get_data()` still
  holds the persisted (old) values and `get_changes()` the pending (new) ones.
  The diff is stashed in `self::$pending`, keyed by `spl_object_id( $product )`.
- `woocommerce_after_..._object_save` → `dispatch()`. Sends the stash, but only
  now — after the save succeeded, and after a newly created product has a real
  ID (it is `0` during `capture()`).

Do not "simplify" this into one hook. `tests/plugin-unit.php` calls
`apply_changes()` between the two to lock the behavior in.

Variations save under a different object type, so all four hook names are
registered (`..._product_object_save` and `..._product_variation_object_save`).

### 2. `'blocking' => false` discards every failure

This is the requirement that makes the plugin hard to debug: WordPress throws
the response away, so a 401, a 404, an unfollowed redirect, and a host that
blocks outbound HTTP all look exactly like success.

Consequences baked into the code — do not undo them:

- **`'redirection' => 3`, and `get_endpoint()` strips trailing slashes.** Next.js
  answers `/api/logs/product-change/` with a 308, and a non-blocking WP request
  cannot follow redirects. A trailing slash in the config silently killed every
  event before this was fixed.
- **Timeout 5s non-blocking** (not 2s), which could abort during the TLS
  handshake before the body was written.
- **`record_attempt()` writes an option on every dispatch.** This is the single
  most valuable diagnostic: it separates "the hook never fired" from "it fired
  but did not arrive."
- `WC_AUDIT_LOGGER_DEBUG` / `WC_AUDIT_LOGGER_BLOCKING` make delivery
  observable/confirmable, and **WooCommerce → Audit Logger** is a status screen
  with blocking probe buttons.

When touching the transport, ask: *if this fails in production, how would anyone
find out?*

### 3. Vercel freezes the function when the response is sent

`route.ts` **awaits** the Mongo insert. A fire-and-forget write looks faster but
is frequently dropped, because the instance is suspended as soon as the response
returns. The latency requirement is satisfied on the WordPress side
(`'blocking' => false`), not by skipping the await here.

Similarly `lib/db.ts` caches both the connection **and the in-flight promise** on
`globalThis`, so concurrent cold-start requests share one pool rather than each
opening their own — Atlas M0 caps at 500 connections.

### 4. The `changes` sub-document is deliberately non-strict

`models/AuditLog.ts` declares `price` / `stock` / `status` /
`catalog_visibility` as `Mixed` with `{ strict: false }`. The plugin can start
tracking a new property (via the `wc_audit_logger_tracked_props` filter) and it
will be stored and rendered **without a change here**. `lib/format.ts` handles
three shapes for exactly this reason: grouped deltas, flat deltas, and bare
scalars.

Do not tighten this schema to "clean it up" — it would silently drop fields.

### 5. Retention is two mechanisms, from one source of truth

Entries live 14 days (`LOG_RETENTION_DAYS` to change it). That is enforced by:

- **The purge** — `app/api/logs/cleanup/route.ts`, run daily by the cron in
  `vercel.json`. Vercel only sends `Authorization: Bearer $CRON_SECRET` when
  `CRON_SECRET` exists, so without it the job 401s and nothing is deleted, in
  silence. The route also takes `X-Api-Secret`, and `?dry=1` counts instead of
  deleting.
- **The query bound** — every dashboard query carries `timestamp: { $gte: cutoff }`.
  A daily job means "expired" and "deleted" are up to 24 hours apart; the bound
  is what makes them look the same to a reader. Do not drop it "because the cron
  handles it."

Both come from `lib/log-query.ts`, which is pure and has no Mongoose import so
`tests/schema-format.ts` can exercise it. That is also why `?days=` is clamped to
the retention window — a wider window has nothing behind it.

The dashboard state (`?days=`, `?sku=`, `?page=`) lives in the URL, is parsed by
`parseLogQuery()`, and is rendered by the client component `app/filter-bar.tsx`
and the server component `app/pagination.tsx`. Consequences:

- `windowLabel()` lives in `lib/log-query.ts`, not in `filter-bar.tsx`. A server
  component importing a value from a `'use client'` module gets a client
  reference, not the function, and calling it during SSR fails.
- SKU search is a `$regex` substring match, so the term **must** go through
  `escapeRegex()`. `tests/schema-format.ts` locks that in.
- Both components build their URLs with `logQueryHref()`, which omits defaults
  so the unfiltered first page stays `/`. The filter bar always passes
  `page: 1` — a filter change has no relationship to the page it started on.

`middleware.ts` must keep excluding `robots.txt` and the icons from the login
gate: a crawler that gets redirected for `robots.txt` learns nothing, and the
browser fetches the icon without cookies.

### 6. Paging is `skip`/`limit`, and needs a tiebreaker plus a clamp

- The window default is **24 hours** (`DEFAULT_WINDOW_DAYS`), not the retention
  window; `LOG_PAGE_SIZE` (50) entries per page. Because the default view is now
  narrower than retention, "nothing matches" and "nothing has ever arrived" are
  different states — the empty state distinguishes them with an
  `estimatedDocumentCount()`, a metadata read run only when the page is empty.
- The sort is `{ timestamp: -1, _id: -1 }`. WooCommerce timestamps are
  second-precision, so a bulk edit writes ties; without `_id` the order within a
  tie is unspecified and `skip`/`limit` can repeat or drop rows between pages.
- `page.tsx` counts **before** it finds, so the page number can be clamped to
  `pageCount()`. A stale link to a page that no longer exists (entries purged,
  filter narrowed) then shows the last page instead of an empty table.
- `?page=` is capped at `MAX_PAGE` on parse, so a hand-typed number cannot ask
  Mongo for a multi-million-document skip before the clamp is known.

### 7. The dashboard timezone is display-only, and `Etc/GMT` has the sign backwards

`?tz=` (and `DASHBOARD_TIMEZONE`) select the zone timestamps are *rendered* in.
Nothing else may depend on it: Mongo stores UTC, `cutoffFor()` subtracts from
`now`, and the retention purge compares UTC — so switching zones can never move
an entry in or out of the window. Keep it that way; a zone-aware query would
make "the last 24 hours" mean two different things on two screens.

Two values are accepted, both by `?tz=` and by the env var:

- an IANA name (`Europe/Amsterdam`), which follows DST;
- a fixed whole-hour offset, canonically written `UTC-3`.

`UTC-3` is stored and shown in that form, **never** as `Etc/GMT+3`, even though
that is its IANA name — the `Etc/GMT*` zones invert the sign (POSIX heritage), so
`Etc/GMT+3` is UTC−3 and putting it in a URL shows every reader the wrong number.
`intlTimeZone()` is the single place that does the inversion, right before
handing the value to `Intl`. Only whole hours in `-12…+14` are expressible that
way; half-hour zones must use their IANA name, and `parseOffsetZone()` returns
`null` for the rest rather than guessing.

Everything in `lib/timezone.ts` falls back instead of throwing — a shared link
carrying a zone that no longer exists must still render the page. That is also
why `lib/format.ts` takes an already-resolved zone (and imports nothing at
runtime, so `tests/` can load it under `--experimental-strip-types`, where the
`@/` alias does not resolve). The picker's option labels are built on the server
and passed down as props; recomputing them on the client would risk a hydration
mismatch across a DST boundary.

### 8. The login is one password, and the cookie is signed with it

`DASHBOARD_PASSWORD` set → `/login` asks for it and `middleware.ts` redirects
everything else. Unset → no gate at all, which is what local development wants.
There is no username and no session store; the cookie is `<expiry>.<HMAC>`, keyed
on the password itself, which has three consequences worth keeping:

- **Rotating the password invalidates every session.** The key that signed them
  is gone. This is the revoke switch, and it is the reason not to "improve" the
  key derivation into something password-independent.
- **The expiry is inside the signature**, so editing the cookie's `Max-Age`
  cannot extend a session.
- **`middleware.ts` is Edge**, so verification uses Web Crypto and `btoa` in
  `lib/auth.ts` — not `node:crypto`/`Buffer`. `lib/secret.ts` stays Node-only and
  keeps guarding the API routes; the two do not merge.

`/api/*` is outside the matcher and keeps using `X-Api-Secret`: the WordPress
plugin sends with `'blocking' => false` and would never see a redirect to a login
form, let alone follow it.

`app/login/actions.ts` is `'use server'`, so **every export must be an async
function** — the initial `useActionState` value lives in the client component for
that reason. `redirect()` works by throwing, so it must stay outside `try`, and
the post-login target goes through `safeRedirect()`: `?next=` comes from the URL
bar, and echoing it back unchecked is an open redirect.

## The payload contract

Produced by `build_payload()` in PHP, validated by zod in `route.ts`, typed in
`types/audit.ts`, rendered by `lib/format.ts`. **A change to the shape touches
all four.**

```json
{
  "product_id": 123,
  "sku": "SHIRT-01",
  "admin": { "id": 1, "user": "jurian", "email": "j@example.com" },
  "timestamp": "2026-08-03T10:00:00+00:00",
  "changes": {
    "price":  { "regular_price": { "from": "19.99", "to": "24.99" } },
    "stock":  { "stock_quantity": { "from": 10, "to": 4 } },
    "status": { "from": "draft", "to": "publish" },
    "catalog_visibility": { "from": "visible", "to": "hidden" }
  }
}
```

Only `product_id` is required server-side; everything else defaults. `price` and
`stock` nest their fields; `status` and `catalog_visibility` are flat. That
asymmetry is intentional and `build_diff()` encodes it via the `prop === group`
check.

## Conventions

- **PHP**: WordPress coding standards — tabs, Yoda conditions, `wp_` functions
  over raw PHP, everything escaped on output, prefixed hooks. The plugin targets
  PHP 7.4, so no arrow functions, union types, or `match`.
- **TypeScript**: strict mode, `@/*` path alias, 2-space indent, single quotes.
- **Mongoose**: import the default and destructure (`const { Schema } =
  mongoose`). Named imports break outside a bundler, which is how `tests/` runs.
- Route handlers need `export const runtime = 'nodejs'` — Mongoose cannot run on
  the Edge runtime. `middleware.ts` *is* Edge, so it uses `atob`, not `Buffer`.

## Environment

`MONGODB_URI` and `API_SECRET` are required. `CRON_SECRET` (needed for the
retention cron to authenticate), `LOG_RETENTION_DAYS` (default `14`),
`MONGODB_DB`, `DASHBOARD_PASSWORD` (unset = no login screen),
`DASHBOARD_TIMEZONE` (IANA name or `UTC±H`, default `UTC`) are optional. See
`.env.local.example`. Vercel needs a **redeploy** after env var
changes.

Plugin config comes from `wp-config.php` constants, falling back to options, all
overridable by filters — see the file's header block.

## Sandbox limits when working on this

The dev container's egress proxy blocks `fastdl.mongodb.org` and `*.vercel.app`.
That means:

- **No real MongoDB.** `mongodb-memory-server` cannot download its binary. DB
  behavior is covered by schema-level assertions in `tests/schema-format.ts`;
  actual inserts are not verifiable here. A `500` from `POST` on a local server
  is expected — it means Mongo is unreachable, not that the code is broken.
- **The deployed app is unreachable.** `curl` to the Vercel URL returns `000`
  (a proxy CONNECT denial). Do not report that as the app being down.

Everything else — build, typecheck, lint, both harnesses, `next start`, and
Newman against a local server — works normally.
