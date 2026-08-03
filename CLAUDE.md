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
| `app/page.tsx` | Server-rendered dashboard, last 50 entries |
| `lib/db.ts` | Cached Mongoose connection |
| `lib/format.ts` | Renders stored diffs into "from → to" lines |
| `models/AuditLog.ts` | Mongoose schema |
| `types/audit.ts` | Shared TS types for the payload/record |
| `middleware.ts` | Optional Basic Auth for the dashboard |
| `tests/` | Standalone harnesses, no test framework |
| `postman/` | Importable collection for manual API testing |

## Commands

```bash
npm run dev        # local dev server
npm run build      # production build (also typechecks)
npm test           # TS + PHP harnesses
npm run test:ts    # schema + formatter (26 assertions)
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

## The four things that are easy to get wrong

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

`MONGODB_URI` and `API_SECRET` are required. `MONGODB_DB`, `DASHBOARD_USER`,
`DASHBOARD_PASSWORD`, `DASHBOARD_TIMEZONE` are optional. See
`.env.local.example`. Vercel needs a **redeploy** after env var changes.

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
