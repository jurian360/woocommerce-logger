# WooCommerce Audit Logger

A lightweight Next.js (App Router) service that receives product-change events
from WooCommerce, stores them in MongoDB Atlas, and renders them in a dashboard.

Built to run on Vercel serverless functions with the Atlas free tier.

```
WordPress / WooCommerce            Vercel                       MongoDB Atlas
┌────────────────────────┐   POST (non-blocking)   ┌───────────────────┐
│ wc-audit-logger.php    │ ──────────────────────► │ /api/logs/        │──► audit_logs
│ before/after save hook │   X-Api-Secret header   │ product-change    │
└────────────────────────┘                         │        /          │◄── last 50
                                                   └───────────────────┘
```

## Project layout

| Path | Purpose |
| --- | --- |
| `lib/db.ts` | Cached Mongoose connection (`global.mongoose` singleton) |
| `models/AuditLog.ts` | `AuditLog` schema — indexed `product_id`, dynamic `changes` |
| `app/api/logs/product-change/route.ts` | `POST` ingest endpoint, `X-Api-Secret` auth |
| `app/page.tsx` | Dashboard listing the 50 most recent changes |
| `lib/format.ts` | Turns stored diffs into readable "from → to" lines |
| `middleware.ts` | Optional HTTP Basic Auth for the dashboard |
| `wordpress/wc-audit-logger.php` | The WordPress plugin that sends the events |

## 1. Set up MongoDB Atlas

1. Create a free **M0** cluster.
2. **Database Access** → add a user with *Read and write to any database*.
3. **Network Access** → add `0.0.0.0/0`. Vercel's serverless IPs are dynamic, so
   an allow-list is not practical on Hobby plans; the connection is still
   protected by TLS and credentials.
4. **Connect → Drivers** → copy the connection string and append the database
   name, e.g. `.../woocommerce_audit?retryWrites=true&w=majority`.

## 2. Run locally

```bash
npm install
cp .env.local.example .env.local   # then fill in MONGODB_URI and API_SECRET
npm run dev
```

Generate a secret with:

```bash
openssl rand -hex 32
```

Verify the endpoint is reachable and the secret matches:

```bash
curl -H "X-Api-Secret: $API_SECRET" http://localhost:3000/api/logs/product-change
# {"success":true,"ready":true}
```

Send a synthetic change:

```bash
curl -X POST http://localhost:3000/api/logs/product-change \
  -H "Content-Type: application/json" \
  -H "X-Api-Secret: $API_SECRET" \
  -d '{
    "product_id": 123,
    "sku": "SHIRT-01",
    "name": "Blue Shirt",
    "currency": "EUR",
    "admin": { "id": 1, "user": "jurian", "email": "jurian@example.com" },
    "timestamp": "2026-08-03T10:00:00Z",
    "changes": {
      "price": { "regular_price": { "from": "19.99", "to": "24.99" } },
      "stock": { "stock_quantity": { "from": 10, "to": 4 } },
      "status": { "from": "draft", "to": "publish" },
      "catalog_visibility": { "from": "visible", "to": "hidden" }
    }
  }'
# {"success":true,"id":"..."}
```

## 3. Deploy to Vercel

```bash
vercel
```

Add the environment variables in **Settings → Environment Variables** for
Production (and Preview, if you use it):

| Variable | Required | Notes |
| --- | --- | --- |
| `MONGODB_URI` | yes | Atlas connection string, including the database name |
| `API_SECRET` | yes | Shared secret checked against `X-Api-Secret` |
| `MONGODB_DB` | no | Overrides the database name from the URI |
| `DASHBOARD_USER` | no | Enables Basic Auth on the dashboard when set with the password |
| `DASHBOARD_PASSWORD` | no | See above |
| `DASHBOARD_TIMEZONE` | no | IANA zone for rendering timestamps (default `UTC`) |

> The dashboard shows who changed what and when. Unless you set
> `DASHBOARD_USER` **and** `DASHBOARD_PASSWORD`, anyone with the URL can read it.
> The page also sends `noindex`, but that is not access control.

## 4. Install the WordPress plugin

1. Copy `wordpress/wc-audit-logger.php` to
   `wp-content/plugins/wc-audit-logger/wc-audit-logger.php` and activate it
   under **Plugins**, or drop it straight into `wp-content/mu-plugins/` to have
   it always on.
2. Add the configuration to `wp-config.php`, above the `/* That's all */` line:

   ```php
   define( 'WC_AUDIT_LOGGER_ENDPOINT', 'https://your-app.vercel.app/api/logs/product-change' );
   define( 'WC_AUDIT_LOGGER_SECRET',   'the same value as API_SECRET' );
   ```

   Alternatively store them in the `wc_audit_logger_endpoint` and
   `wc_audit_logger_secret` options. An admin notice appears while either is
   missing.
3. Edit a product's price, stock, status or catalog visibility and reload the
   dashboard.

### What gets logged

Only interactive changes by a signed-in user with the `edit_products`
capability. The plugin returns early for WP-CLI, WP-Cron, imports,
unauthenticated requests, and `auto-draft` products, so bulk jobs and scheduled
tasks never pollute the log.

Tracked properties, grouped as they appear in `changes`:

| Group | Properties |
| --- | --- |
| `price` | `regular_price`, `sale_price` |
| `stock` | `stock_quantity`, `stock_status`, `manage_stock` |
| `status` | `status` |
| `catalog_visibility` | `catalog_visibility` |

Each entry is a `{ from, to }` pair. Cosmetic-only price edits (`19.9` → `19.90`)
are ignored.

### Hooks

| Hook | Type | Purpose |
| --- | --- | --- |
| `wc_audit_logger_tracked_props` | filter | Map of `prop => group` to watch |
| `wc_audit_logger_payload` | filter | Mutate the payload before sending |
| `wc_audit_logger_should_log` | filter | Final veto on logging a request |
| `wc_audit_logger_endpoint` | filter | Endpoint URL |
| `wc_audit_logger_secret` | filter | Shared secret |
| `wc_audit_logger_sslverify` | filter | Set `false` only for local self-signed certs |

## API

### `POST /api/logs/product-change`

Requires the `X-Api-Secret` header. Bodies above 64 KB are rejected.

| Status | Meaning |
| --- | --- |
| `202` | Stored — returns `{ "success": true, "id": "..." }` |
| `400` | Malformed JSON or a payload that failed validation |
| `401` | Missing or incorrect `X-Api-Secret` |
| `413` | Body too large |
| `500` | `API_SECRET` not configured, or the write to MongoDB failed |

Only `product_id` is required; everything else is optional and defaults
sensibly. `changes` accepts arbitrary keys — the schema is deliberately
non-strict, so the plugin can start tracking new properties without a redeploy
here, and the dashboard will render them.

### `GET /api/logs/product-change`

Connectivity probe. Same header, returns `{ "success": true, "ready": true }`.

## Design notes

**Connection pooling.** Each Vercel container caches one Mongoose connection —
and the in-flight connect promise — on `globalThis`, so concurrent cold-start
requests share a single pool instead of racing to open several. Atlas M0 caps at
500 connections, which this stays comfortably under.

**The write is awaited.** A fire-and-forget insert looks faster but is unsafe on
Vercel: the instance is frozen as soon as the response is sent, and pending
promises are often dropped. WordPress already sends the request with
`'blocking' => false`, so the shop admin never waits for this service regardless.

**Why the plugin uses two hooks.** WooCommerce calls `$product->apply_changes()`
inside `save()`, which empties `get_changes()` *before*
`woocommerce_after_product_object_save` fires. The plugin therefore computes the
diff on `woocommerce_before_product_object_save` — where `get_data()` still holds
the persisted values and `get_changes()` the pending ones — stashes it keyed by
`spl_object_id()`, and sends it from the `after` hook, once the save has
succeeded and a newly created product has a real ID.

**Retention.** Nothing is pruned automatically. To expire old entries, add a TTL
index in Atlas:

```js
db.audit_logs.createIndex({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 })
```

## Scripts

```bash
npm run dev        # local dev server
npm run build      # production build
npm run start      # serve the production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```
