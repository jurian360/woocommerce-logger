# WooCommerce Audit Logger

A lightweight Next.js (App Router) service that receives product-change events
from WooCommerce, stores them in MongoDB Atlas, and renders them in a dashboard.

Built to run on Vercel serverless functions with the Atlas free tier.

```
WordPress / WooCommerce            Vercel                       MongoDB Atlas
┌────────────────────────┐   POST (non-blocking)   ┌───────────────────┐
│ wc-audit-logger.php    │ ──────────────────────► │ /api/logs/        │──► audit_logs
│ before/after save hook │   X-Api-Secret header   │ product-change    │
└────────────────────────┘                         │        /          │◄── paged
                                                   └───────────────────┘
```

## Project layout

| Path | Purpose |
| --- | --- |
| `lib/db.ts` | Cached Mongoose connection (`global.mongoose` singleton) |
| `models/AuditLog.ts` | `AuditLog` schema — indexed `product_id`, dynamic `changes` |
| `app/api/logs/product-change/route.ts` | `POST` ingest endpoint, `X-Api-Secret` auth |
| `app/api/logs/cleanup/route.ts` | Retention purge, run daily by the Vercel cron |
| `app/page.tsx` | Dashboard listing changes, 50 per page |
| `app/filter-bar.tsx` | Day filter + SKU search above the table |
| `app/timezone-select.tsx` | Timezone picker in the header |
| `app/pagination.tsx` | Page links below the table |
| `app/login/` | Password login screen and its server actions |
| `lib/log-query.ts` | Retention window, filter parsing, Mongo query building |
| `lib/format.ts` | Turns stored diffs into readable "from → to" lines |
| `lib/timezone.ts` | Resolves `?tz=` / `DASHBOARD_TIMEZONE` into a zone to render in |
| `lib/auth.ts` | Dashboard password check and signed session cookie |
| `app/robots.ts` | `robots.txt` — disallows everything |
| `app/icon.svg`, `app/favicon.ico` | Favicon (the SVG is the source; the `.ico` is a rasterised copy) |
| `middleware.ts` | Sends anyone without a session cookie to the login screen |
| `vercel.json` | Cron schedule for the retention purge |
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
| `CRON_SECRET` | no* | Authenticates the daily retention cron; without it the purge returns `401` |
| `MONGODB_DB` | no | Overrides the database name from the URI |
| `LOG_RETENTION_DAYS` | no | How long entries are kept (default `14`) |
| `DASHBOARD_PASSWORD` | no | Password for the dashboard login screen. Unset means no login at all |
| `DASHBOARD_TIMEZONE` | no | Timezone the dashboard starts in — an IANA name or a `UTC±H` offset (default `UTC`) |

\* Optional only if you do not want automatic pruning. Vercel attaches
`Authorization: Bearer $CRON_SECRET` to cron invocations, and only when the
variable exists — see [Retention](#retention).

> The dashboard shows who changed what and when. Unless you set
> `DASHBOARD_PASSWORD`, anyone with the URL can read it. The page also sends
> `noindex` and `robots.txt` disallows every crawler, but neither is access
> control.

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

### Troubleshooting: nothing is arriving

Go to **WooCommerce → Audit Logger**. That screen shows the resolved endpoint
and secret, whether an event has ever been sent, and two buttons that make a
*blocking* request so you see the real HTTP status code.

The decisive field is **Last send attempt**:

- **Still "never"** after you edit a product price → the request never got as far
  as being sent. The change was not a tracked field, or the save was not made by
  a logged-in user with `edit_products`. Set `WC_AUDIT_LOGGER_DEBUG` to `true`
  and check **WooCommerce → Status → Logs**; every skipped save records why.
- **Populated, but nothing on the dashboard** → the event left WordPress and did
  not land. Press **Test connection** and read the code:

| Result | Cause |
| --- | --- |
| `200` | Endpoint and secret are correct — the problem is downstream (see the `500` row) |
| `401` | The secret does not match `API_SECRET` on the server |
| `404` | Wrong URL; it must end in `/api/logs/product-change` |
| `500` | `API_SECRET` missing on the server, or the MongoDB write failed |
| `3xx` | Unfollowed redirect — trailing slash, or a www/non-www mismatch |
| Timeout / connection error | The host blocks outbound HTTP requests |

If **Test connection** returns `200` but real product edits still never arrive,
your host is likely dropping non-blocking requests. Set:

```php
define( 'WC_AUDIT_LOGGER_BLOCKING', true );
```

Product saves then wait for the audit API (a few hundred milliseconds) but
delivery is confirmed, and failures are written to the WooCommerce log.

### Optional constants

| Constant | Effect |
| --- | --- |
| `WC_AUDIT_LOGGER_DEBUG` | Logs every skipped save and every HTTP response to WooCommerce → Status → Logs. Implies blocking mode |
| `WC_AUDIT_LOGGER_BLOCKING` | Wait for the response on every send, so failures are visible |

### Hooks

| Hook | Type | Purpose |
| --- | --- | --- |
| `wc_audit_logger_tracked_props` | filter | Map of `prop => group` to watch |
| `wc_audit_logger_payload` | filter | Mutate the payload before sending |
| `wc_audit_logger_should_log` | filter | Final veto on logging a request |
| `wc_audit_logger_endpoint` | filter | Endpoint URL |
| `wc_audit_logger_secret` | filter | Shared secret |
| `wc_audit_logger_sslverify` | filter | Set `false` only for local self-signed certs |

## Using the dashboard

The table shows the changes inside the selected window, newest first, **50 per
page**. Page links sit below the table; the filters sit above it. All of it lives
in the URL, so any view can be bookmarked or shared:

| Control | Query parameter | Behaviour |
| --- | --- | --- |
| Period | `?days=` | `1`, `3`, `7` or `14`. **Defaults to `1` — the last 24 hours.** Clamped to the retention window; anything invalid falls back to the default |
| SKU | `?sku=` | Case-insensitive substring match, so `shirt` finds `SHIRT-01`. Regex characters are escaped and searched literally |
| Page | `?page=` | 1-based, 50 entries per page. Defaults to `1`; a page past the end shows the last page |
| Timezone | `?tz=` | Zone the timestamps are rendered in. Defaults to `DASHBOARD_TIMEZONE`, then UTC |

```
/                          the last 24 hours, newest 50
/?page=2                   entries 51–100 of the same window
/?days=14                  the full retention window
/?sku=SHIRT-01             one SKU, last 24 hours
/?tz=UTC-3                 the same entries, three hours behind UTC
/?days=7&sku=shirt&page=2  combined
```

The default view (`/`) carries no parameters: the last 24 hours, first page.
Changing a filter always returns to page 1, and `days` above the retention window
is silently clamped — there is no data behind it. Changing the timezone keeps the
page you are on: it changes how the rows read, not which rows match.

### Timezone

The picker in the header sets the zone the timestamps are rendered in. It offers
two kinds of value, and `?tz=` and `DASHBOARD_TIMEZONE` both accept either:

| Kind | Example | Behaviour |
| --- | --- | --- |
| IANA zone | `Europe/Amsterdam`, `America/Sao_Paulo` | Follows that region's DST — the offset changes across the year |
| Fixed offset | `UTC-3`, `UTC+2`, `UTC` | Always exactly that far from UTC, all year |

So **UTC−3** is `?tz=UTC-3`, and a zone not in the picker can be typed straight
into the URL (`?tz=Africa/Kampala`) — it will be selected when the page loads.
Whole hours only for fixed offsets, `-12` through `+14`; half-hour zones such as
India are available under their IANA name (`Asia/Kolkata`).

Two things this does *not* change: entries are always **stored** in UTC, and the
day filter is always measured from now backwards, so switching zones never moves
an entry in or out of the window. Only the rendered text changes.

Set `DASHBOARD_TIMEZONE` to the zone the shop is run from and the picker starts
there for everyone; anything unrecognised falls back to UTC rather than failing.

## Signing in

Set `DASHBOARD_PASSWORD` and the dashboard asks for it:

```
DASHBOARD_PASSWORD="a long random string"
```

There is no username — one password, one shop, one audit log. Everything except
`/api/*`, `robots.txt` and the icons is behind it; the API routes keep
authenticating with the `X-Api-Secret` header, since a redirect to a login page
would be a strange answer to give the WordPress plugin.

- A successful login sets an **HTTP-only, signed cookie** that lasts **7 days**,
  then the login screen asks again. The password itself is never in the cookie.
- The cookie is signed **with the password**, so changing `DASHBOARD_PASSWORD`
  signs everyone out at once. That is the "revoke access now" switch — on Vercel,
  remember the change only takes effect after a redeploy.
- **Sign out** is in the header, next to Refresh.
- Leaving `DASHBOARD_PASSWORD` empty disables the login screen entirely and the
  dashboard is readable by anyone with the URL. Convenient locally, a mistake in
  production.

Nothing is stored server-side, so this survives Vercel's serverless model without
a session table — but it also means there is no per-user history and no way to
sign out one browser without signing out all of them.

## Retention

**Entries are kept for 14 days.** Anything older is deleted.

Two things enforce this:

1. **Every dashboard query is bounded** by the retention window, so an entry past
   its window is never rendered, even in the hours before it is deleted.
2. **A daily cron** (`vercel.json`, 03:17 UTC) calls
   `GET /api/logs/cleanup`, which deletes everything older than the window.

Change the window with `LOG_RETENTION_DAYS` — it drives the purge, the filter
buttons and the query bound together. Vercel needs a redeploy after changing it.

### Enabling the cron

Set `CRON_SECRET` in **Settings → Environment Variables** and redeploy. Vercel
adds `Authorization: Bearer $CRON_SECRET` to scheduled requests only when that
variable exists; without it the purge answers `401` and nothing is ever deleted.

Check that it works — the endpoint counts without deleting when `dry=1`:

```bash
curl -H "X-Api-Secret: $API_SECRET" \
  "https://your-app.vercel.app/api/logs/cleanup?dry=1"
# {"success":true,"dry_run":true,"retention_days":14,"cutoff":"...","deleted":3}
```

Drop `?dry=1` to purge immediately. Each run writes its outcome to the Vercel
function log, and **Settings → Cron Jobs** shows the last invocation.

### Belt and braces: a TTL index

The cron is enough on its own. If you would rather not depend on it, let MongoDB
expire documents itself — Atlas checks TTL indexes about once a minute:

```js
db.audit_logs.createIndex({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14 })
```

Keep the number in sync with `LOG_RETENTION_DAYS`. To change it later, drop the
index and create it again; MongoDB rejects a second index on the same key with
different options.

## Testing with Postman

Import both files from `postman/`:

- `woocommerce-audit-logger.postman_collection.json`
- `woocommerce-audit-logger.postman_environment.json`

Select the environment, set `apiSecret` to the same value as `API_SECRET` in
Vercel, and adjust `baseUrl` if your deployment URL differs. Then **Run
collection** — requests 01–03 cover the happy paths and 04–08 assert that bad
requests are rejected.

Run it headlessly with [Newman](https://github.com/postmanlabs/newman):

```bash
npx newman run postman/woocommerce-audit-logger.postman_collection.json \
  --env-var baseUrl=https://your-app.vercel.app \
  --env-var apiSecret=$API_SECRET
```

### Doing it by hand

Start with the health probe — it needs no database, so it isolates
"is the endpoint reachable and is my secret right?" from everything else:

| | |
| --- | --- |
| Method | `GET` |
| URL | `https://your-app.vercel.app/api/logs/product-change` |
| Header | `X-Api-Secret: <your secret>` |

Expect `200` and `{"success":true,"ready":true}`.

Then log a change:

| | |
| --- | --- |
| Method | `POST` |
| URL | `https://your-app.vercel.app/api/logs/product-change` |
| Headers | `X-Api-Secret: <your secret>`, `Content-Type: application/json` |
| Body | **raw → JSON**, see below |

```json
{
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
}
```

Expect `202` and `{"success":true,"id":"..."}`, then open the dashboard — the
row should be at the top.

### Reading the response

| Status | Meaning | Fix |
| --- | --- | --- |
| `202` | Stored | — |
| `400` | Malformed JSON, or validation failed | Check the `issues` array in the response; make sure Postman's body is **raw → JSON**, not form-data |
| `401` | Secret missing or wrong | The header is `X-Api-Secret`; confirm it matches `API_SECRET` in Vercel exactly, with no trailing whitespace or newline |
| `404` | Wrong path | It is `/api/logs/product-change`, no trailing slash |
| `405` | Wrong method | Only `GET` and `POST` exist |
| `413` | Body over 64 KB | Send less |
| `500` on `GET` | `API_SECRET` is not set on the deployment | Add it in Vercel, then redeploy — env var changes need a new deployment |
| `500` on `POST` | The MongoDB write failed | Check `MONGODB_URI`, and that Atlas **Network Access** allows `0.0.0.0/0`; Vercel's egress IPs are dynamic |

A **redirect to `/login`** rather than the dashboard HTML means
`DASHBOARD_PASSWORD` is set. Postman cannot fill in a login form; either open the
dashboard in a browser, or copy the `wc_audit_session` cookie a signed-in browser
holds into Postman's **Cookies** jar for the domain.

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

### `GET|POST /api/logs/cleanup`

Deletes every entry older than the retention window. Accepts either
`X-Api-Secret: <API_SECRET>` or `Authorization: Bearer <CRON_SECRET>` — the
latter is what the Vercel cron sends. `?dry=1` counts instead of deleting.

| Status | Meaning |
| --- | --- |
| `200` | `{ "success": true, "dry_run": false, "retention_days": 14, "cutoff": "...", "deleted": 3 }` |
| `401` | Neither secret matched |
| `500` | No secret configured on the deployment, or the delete failed |

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

**Retention is enforced twice.** The purge is a scheduled job, and a scheduled
job that quietly stops running is invisible — so the dashboard applies the same
cutoff to every query rather than trusting that the deletion happened. The two
derive their numbers from one place (`lib/log-query.ts`), which is also why the
day filter can never ask for a window wider than what is retained.

**The purge is not fire-and-forget.** It answers with the cutoff it used and the
number of rows it removed, logs the same line to the function log, and supports
`?dry=1` for checking it before trusting it. See [Retention](#retention).

**The session cookie is signed with the password.** No session store, no user
table — the cookie is `<expiry>.<HMAC-SHA256>` keyed on `DASHBOARD_PASSWORD`,
which is what makes it work on serverless where any request may hit a fresh
instance. It also gives the revocation story for free: change the password and
every outstanding cookie stops verifying. The expiry is inside the signature, so
editing the browser's copy cannot extend a session. Verification happens in
`middleware.ts`, which is Edge — hence Web Crypto in `lib/auth.ts` rather than
the `node:crypto` used by `lib/secret.ts` for the API routes.

**Timestamps are rendered in a zone, never converted into one.** Mongo stores
UTC, the retention cutoff is computed in UTC, and the day filter is measured
backwards from now — so the zone touches nothing but the text in the table. A
fixed offset is written `UTC-3` in the URL and translated to its IANA spelling
(`Etc/GMT+3` — the sign is inverted there, a POSIX inheritance) in exactly one
function, so no reader ever sees the confusing form.

## Scripts

```bash
npm run dev        # local dev server
npm run build      # production build
npm run start      # serve the production build
npm test           # TS + PHP harnesses
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```
