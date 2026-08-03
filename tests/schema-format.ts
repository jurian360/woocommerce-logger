import assert from 'node:assert/strict';
import AuditLog from '../models/AuditLog.ts';
import { summarizeChanges, formatTimestamp } from '../lib/format.ts';
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_WINDOW_DAYS,
  LOG_PAGE_SIZE,
  MAX_PAGE,
  MS_PER_DAY,
  cutoffFor,
  dayFilterOptions,
  defaultWindowDays,
  logQueryHref,
  pageCount,
  pageNumbers,
  parseDays,
  parseLogQuery,
  parsePage,
  parseSku,
  resolveRetentionDays,
  skipFor,
  windowLabel,
} from '../lib/log-query.ts';
import {
  DEFAULT_TIME_ZONE,
  defaultTimeZone,
  intlTimeZone,
  isValidTimeZone,
  offsetHours,
  offsetLabel,
  parseOffsetZone,
  parseTimeZone,
  resolveTimeZone,
  timeZoneLabel,
  timeZoneOptions,
} from '../lib/timezone.ts';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  constantTimeEquals,
  createSessionToken,
  safeRedirect,
  verifySessionToken,
} from '../lib/auth.ts';

let passed = 0;
function ok(label: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('ok:', label);
}

/** Same, for checks that have to await (the session cookie is HMAC-signed via
 * Web Crypto, which is async). Must be awaited at the call site, or the final
 * count prints before the check has run. */
async function okAsync(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log('ok:', label);
}

/* ---------- Mongoose schema (no connection needed for validate/cast) ------- */

const doc = new AuditLog({
  product_id: '123', // string on purpose: must cast to Number
  sku: 'SHIRT-01',
  admin: { id: 7, user: 'jurian', email: 'Jurian@Example.com' },
  timestamp: '2026-08-03T10:00:00.000Z',
  changes: {
    price: { regular_price: { from: '19.99', to: '24.99' } },
    stock: { stock_quantity: { from: 10, to: 4 } },
    status: { from: 'draft', to: 'publish' },
    catalog_visibility: { from: 'visible', to: 'hidden' },
    // Not declared in the schema: must survive because strict:false.
    weight: { from: '1.0', to: '2.5' },
  },
});

ok('validates', () => assert.equal(doc.validateSync(), undefined));
ok('casts product_id to number', () => assert.strictEqual(doc.product_id, 123));
ok('lowercases admin email', () => assert.equal(doc.admin!.email, 'jurian@example.com'));
ok('casts timestamp to Date', () => assert.ok(doc.timestamp instanceof Date));
ok('defaults received_at', () => assert.ok(doc.received_at instanceof Date));
ok('defaults parent_id', () => assert.strictEqual(doc.parent_id, 0));

const asObject = doc.toObject() as Record<string, any>;
ok('keeps nested price delta', () =>
  assert.deepEqual(asObject.changes.price, { regular_price: { from: '19.99', to: '24.99' } }));
ok('keeps dynamic unknown key (strict:false)', () =>
  assert.deepEqual(asObject.changes.weight, { from: '1.0', to: '2.5' }));
ok('no versionKey', () => assert.equal(asObject.__v, undefined));

ok('product_id is required', () => {
  const bad = new AuditLog({ sku: 'X' });
  assert.ok(bad.validateSync()?.errors?.product_id, 'expected product_id validation error');
});

const indexes = AuditLog.schema.indexes().map(([spec]) => JSON.stringify(spec));
ok('timestamp index exists', () => assert.ok(indexes.includes('{"timestamp":-1}')));
ok('product+timestamp index exists', () =>
  assert.ok(indexes.includes('{"product_id":1,"timestamp":-1}')));
ok('sku+timestamp index exists', () =>
  assert.ok(indexes.includes('{"sku":1,"timestamp":-1}')));
ok('collection name', () => assert.equal(AuditLog.collection.collectionName, 'audit_logs'));

/* ---------- Retention + dashboard filters ---------------------------------- */

ok('retention defaults to 14 days', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 14);
  assert.equal(resolveRetentionDays(undefined), 14);
  assert.equal(resolveRetentionDays(''), 14);
  assert.equal(resolveRetentionDays('not-a-number'), 14);
});
ok('retention accepts an override', () => {
  assert.equal(resolveRetentionDays('30'), 30);
  assert.equal(resolveRetentionDays(7), 7);
  assert.equal(resolveRetentionDays('7.9'), 7);
});
ok('retention is clamped', () => {
  assert.equal(resolveRetentionDays('0'), 1);
  assert.equal(resolveRetentionDays('-5'), 1);
  assert.equal(resolveRetentionDays('99999'), 3650);
});

const now = new Date('2026-08-03T10:00:00.000Z');

ok('cutoff is N days back', () =>
  assert.equal(cutoffFor(14, now).toISOString(), '2026-07-20T10:00:00.000Z'));
ok('a day is 86_400_000 ms', () => assert.equal(MS_PER_DAY, 86_400_000));

ok('day options stop at the retention window', () => {
  assert.deepEqual(dayFilterOptions(14), [1, 3, 7, 14]);
  assert.deepEqual(dayFilterOptions(30), [1, 3, 7, 14, 30]);
  assert.deepEqual(dayFilterOptions(1), [1]);
});
ok('window labels read naturally', () => {
  assert.equal(windowLabel(1), '24 hours');
  assert.equal(windowLabel(14), '14 days');
});

ok('days defaults to 24 hours', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 1);
  assert.equal(parseDays(undefined, 14), 1);
  assert.equal(parseDays('', 14), 1);
  assert.equal(parseDays('nonsense', 14), 1);
  assert.equal(parseDays('0', 14), 1);
});
ok('the default window never exceeds retention', () => {
  assert.equal(defaultWindowDays(14), 1);
  assert.equal(defaultWindowDays(1), 1);
});
ok('days never exceeds retention', () => assert.equal(parseDays('365', 14), 14));
ok('days accepts a wider window than the default', () =>
  assert.equal(parseDays('7', 14), 7));
ok('days takes the first repeated param', () =>
  assert.equal(parseDays(['3', '7'], 14), 3));

/* ---------- Pagination ------------------------------------------------------ */

ok('page defaults to 1', () => {
  assert.equal(parsePage(undefined), 1);
  assert.equal(parsePage(''), 1);
  assert.equal(parsePage('nonsense'), 1);
  assert.equal(parsePage('0'), 1);
  assert.equal(parsePage('-3'), 1);
});
ok('page parses and floors', () => {
  assert.equal(parsePage('4'), 4);
  assert.equal(parsePage('4.9'), 4);
  assert.equal(parsePage(['2', '9']), 2);
});
ok('page is capped so skip stays sane', () =>
  assert.equal(parsePage('99999999'), MAX_PAGE));

ok('page size is 50', () => assert.equal(LOG_PAGE_SIZE, 50));
ok('page count covers the remainder', () => {
  assert.equal(pageCount(0, 50), 1);
  assert.equal(pageCount(1, 50), 1);
  assert.equal(pageCount(50, 50), 1);
  assert.equal(pageCount(51, 50), 2);
  assert.equal(pageCount(342, 50), 7);
});
ok('skip is zero-based', () => {
  assert.equal(skipFor(1, 50), 0);
  assert.equal(skipFor(3, 50), 100);
});

ok('page numbers are contiguous while they fit', () => {
  assert.deepEqual(pageNumbers(1, 1), [1]);
  assert.deepEqual(pageNumbers(3, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageNumbers(1, 7), [1, 2, 3, 4, 5, 6, 7]);
});
ok('page numbers keep the ends and cluster on the current page', () => {
  assert.deepEqual(pageNumbers(1, 20), [1, 2, 3, 4, 5, 6, 20]);
  assert.deepEqual(pageNumbers(10, 20), [1, 8, 9, 10, 11, 12, 20]);
  assert.deepEqual(pageNumbers(20, 20), [1, 15, 16, 17, 18, 19, 20]);
});
ok('page numbers clamp a page past the end', () =>
  assert.deepEqual(pageNumbers(999, 20), [1, 15, 16, 17, 18, 19, 20]));
ok('page numbers never exceed the maximum shown', () => {
  for (const page of [1, 2, 9, 50, 99, 100]) {
    assert.equal(pageNumbers(page, 100).length, 7, `page ${page}`);
  }
});

ok('href omits the defaults', () =>
  assert.equal(logQueryHref({ days: 1, sku: '', page: 1, defaultDays: 1 }), '/'));
ok('href carries filters and page', () => {
  assert.equal(
    logQueryHref({ days: 7, sku: ' shirt ', page: 3, defaultDays: 1 }),
    '/?days=7&sku=shirt&page=3'
  );
  assert.equal(logQueryHref({ days: 1, sku: '', page: 2, defaultDays: 1 }), '/?page=2');
});
ok('href escapes the search term', () =>
  assert.equal(
    logQueryHref({ days: 1, sku: 'A+B 2', page: 1, defaultDays: 1 }),
    '/?sku=A%2BB+2'
  ));

ok('sku is trimmed and capped', () => {
  assert.equal(parseSku('  SHIRT-01 '), 'SHIRT-01');
  assert.equal(parseSku(undefined), '');
  assert.equal(parseSku('x'.repeat(500)).length, 200);
});

ok('filter defaults to the last 24 hours', () => {
  const { filter, days, page } = parseLogQuery({ max: 14, now });
  assert.equal(days, 1);
  assert.equal(page, 1);
  assert.deepEqual(filter, { timestamp: { $gte: new Date('2026-08-02T10:00:00.000Z') } });
});
ok('filter widens to the requested days', () => {
  const { filter, days, isFiltered } = parseLogQuery({ days: '14', max: 14, now });
  assert.equal(days, 14);
  // Nothing is hidden at the full retention window, so this is not "filtered".
  assert.equal(isFiltered, false);
  assert.deepEqual(filter.timestamp, { $gte: new Date('2026-07-20T10:00:00.000Z') });
});
ok('filter reports a narrowed window as filtered', () =>
  assert.equal(parseLogQuery({ days: '3', max: 14, now }).isFiltered, true));
ok('filter carries the requested page', () =>
  assert.equal(parseLogQuery({ page: '4', max: 14, now }).page, 4));
ok('filter searches SKU case-insensitively', () => {
  const { filter, sku } = parseLogQuery({ sku: ' shirt ', max: 14, now });
  assert.equal(sku, 'shirt');
  assert.deepEqual(filter.sku, { $regex: 'shirt', $options: 'i' });
});
ok('filter escapes regex metacharacters in a SKU', () => {
  const { filter } = parseLogQuery({ sku: 'A+B (2).x', max: 14, now });
  assert.deepEqual(filter.sku, { $regex: 'A\\+B \\(2\\)\\.x', $options: 'i' });
});
ok('filter omits sku when not searching', () =>
  assert.equal(parseLogQuery({ max: 14, now }).filter.sku, undefined));

/* ---------- Dashboard formatting ------------------------------------------ */

const lines = summarizeChanges(asObject.changes, 'EUR');
const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));

ok('formats prices with currency', () =>
  assert.deepEqual(
    { from: byLabel['Regular price'].from, to: byLabel['Regular price'].to },
    { from: '19.99 EUR', to: '24.99 EUR' }
  ));
ok('groups price line', () => assert.equal(byLabel['Regular price'].group, 'price'));
ok('humanizes status values', () =>
  assert.deepEqual(
    { from: byLabel['Status'].from, to: byLabel['Status'].to },
    { from: 'Draft', to: 'Published' }
  ));
ok('humanizes visibility values', () =>
  assert.equal(byLabel['Catalog visibility'].to, 'Hidden'));
ok('renders stock numbers', () =>
  assert.deepEqual(
    { from: byLabel['Stock quantity'].from, to: byLabel['Stock quantity'].to },
    { from: '10', to: '4' }
  ));
ok('humanizes unknown dynamic field', () => assert.ok(byLabel['Weight']));

ok('handles bare scalar change', () => {
  const [line] = summarizeChanges({ status: 'publish' });
  assert.deepEqual(line, { label: 'Status', group: 'status', from: '—', to: 'Published' });
});
ok('handles empty/null changes', () => {
  assert.deepEqual(summarizeChanges(null), []);
  assert.deepEqual(summarizeChanges({}), []);
});
ok('renders empty price as dash', () => {
  const [line] = summarizeChanges({ price: { sale_price: { from: '', to: '20.00' } } }, 'EUR');
  assert.deepEqual({ from: line.from, to: line.to }, { from: '—', to: '20.00 EUR' });
});
ok('renders null stock as dash', () => {
  const [line] = summarizeChanges({ stock: { stock_quantity: { from: 10, to: null } } });
  assert.equal(line.to, '—');
});
ok('renders booleans', () => {
  const [line] = summarizeChanges({ stock: { manage_stock: { from: true, to: false } } });
  assert.deepEqual({ from: line.from, to: line.to }, { from: 'Yes', to: 'No' });
});

ok('formats timestamp in UTC by default', () =>
  assert.equal(formatTimestamp(new Date('2026-08-03T10:00:00Z')), '3 Aug 2026, 10:00:00'));
ok('formats timestamp in the given zone', () => {
  // UTC-3, spelled the way IANA spells it.
  assert.equal(
    formatTimestamp(new Date('2026-08-03T10:00:00Z'), 'Etc/GMT+3'),
    '3 Aug 2026, 07:00:00'
  );
  // Crossing midnight backwards must move the date too.
  assert.equal(
    formatTimestamp(new Date('2026-08-03T01:00:00Z'), 'Etc/GMT+3'),
    '2 Aug 2026, 22:00:00'
  );
});
ok('falls back to UTC for an unusable zone', () =>
  assert.equal(
    formatTimestamp(new Date('2026-08-03T10:00:00Z'), 'Mars/Olympus'),
    '3 Aug 2026, 10:00:00'
  ));
ok('handles invalid timestamp', () => assert.equal(formatTimestamp('not-a-date'), '—'));

/* ---------- Timezones ------------------------------------------------------ */

ok('parses the ways an offset gets written', () => {
  assert.equal(parseOffsetZone('UTC-3'), 'UTC-3');
  assert.equal(parseOffsetZone('utc -03:00'), 'UTC-3');
  assert.equal(parseOffsetZone('GMT+2'), 'UTC+2');
  assert.equal(parseOffsetZone('-3'), 'UTC-3');
  assert.equal(parseOffsetZone('+05'), 'UTC+5');
});
ok('parses zero as plain UTC', () => {
  assert.equal(parseOffsetZone('UTC'), 'UTC');
  assert.equal(parseOffsetZone('gmt'), 'UTC');
  assert.equal(parseOffsetZone('-0'), 'UTC');
  assert.equal(parseOffsetZone('+00:00'), 'UTC');
});
ok('rejects what is not an offset', () => {
  assert.equal(parseOffsetZone('Europe/Amsterdam'), null);
  assert.equal(parseOffsetZone(''), null);
  assert.equal(parseOffsetZone('nonsense'), null);
});
ok('rejects offsets Etc/GMT cannot express', () => {
  // Half-hour zones exist, `Etc/GMT*` does not cover them — use the IANA name.
  assert.equal(parseOffsetZone('UTC+05:30'), null);
  assert.equal(parseOffsetZone('UTC-13'), null);
  assert.equal(parseOffsetZone('UTC+15'), null);
});

ok('reads back the offset it stores', () => {
  assert.equal(offsetHours('UTC'), 0);
  assert.equal(offsetHours('UTC-3'), -3);
  assert.equal(offsetHours('UTC+14'), 14);
  assert.equal(offsetHours('Europe/Amsterdam'), null);
});
ok('inverts the sign for the IANA spelling', () => {
  // The whole reason `Etc/GMT+3` is never shown to a reader.
  assert.equal(intlTimeZone('UTC-3'), 'Etc/GMT+3');
  assert.equal(intlTimeZone('UTC+2'), 'Etc/GMT-2');
  assert.equal(intlTimeZone('UTC'), 'UTC');
  assert.equal(intlTimeZone('Europe/Amsterdam'), 'Europe/Amsterdam');
});
ok('every offset in range is a real zone', () => {
  for (let hours = -12; hours <= 14; hours += 1) {
    const zone = hours === 0 ? 'UTC' : `UTC${hours > 0 ? '+' : '-'}${Math.abs(hours)}`;
    assert.ok(isValidTimeZone(zone), zone);
  }
});
ok('validates IANA names', () => {
  assert.equal(isValidTimeZone('Europe/Amsterdam'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
});

ok('resolves a requested zone', () => {
  assert.equal(resolveTimeZone('UTC-3'), 'UTC-3');
  assert.equal(resolveTimeZone('Europe/Amsterdam'), 'Europe/Amsterdam');
  assert.equal(resolveTimeZone('europe/amsterdam'), 'Europe/Amsterdam');
});
ok('falls back instead of throwing on a bad zone', () => {
  assert.equal(DEFAULT_TIME_ZONE, 'UTC');
  assert.equal(resolveTimeZone(undefined), 'UTC');
  assert.equal(resolveTimeZone(''), 'UTC');
  assert.equal(resolveTimeZone('Mars/Olympus'), 'UTC');
  assert.equal(resolveTimeZone('Mars/Olympus', 'Europe/Amsterdam'), 'Europe/Amsterdam');
});

ok('DASHBOARD_TIMEZONE accepts either form', () => {
  process.env.DASHBOARD_TIMEZONE = 'UTC-3';
  assert.equal(defaultTimeZone(), 'UTC-3');
  process.env.DASHBOARD_TIMEZONE = 'Europe/Amsterdam';
  assert.equal(defaultTimeZone(), 'Europe/Amsterdam');
  process.env.DASHBOARD_TIMEZONE = 'not-a-zone';
  assert.equal(defaultTimeZone(), 'UTC');
  delete process.env.DASHBOARD_TIMEZONE;
  assert.equal(defaultTimeZone(), 'UTC');
});
ok('?tz= overrides the configured default', () => {
  assert.equal(parseTimeZone('UTC-3', 'Europe/Amsterdam'), 'UTC-3');
  assert.equal(parseTimeZone(undefined, 'Europe/Amsterdam'), 'Europe/Amsterdam');
  assert.equal(parseTimeZone(['UTC-3', 'UTC+9'], 'UTC'), 'UTC-3');
  // A shared link with a broken zone must render, not 500.
  assert.equal(parseTimeZone('Mars/Olympus', 'UTC'), 'UTC');
});

const winter = new Date('2026-01-15T12:00:00Z');
const summer = new Date('2026-07-15T12:00:00Z');

ok('labels an offset without repeating itself', () => {
  assert.equal(offsetLabel('UTC-3', summer), 'UTC-03:00');
  assert.equal(offsetLabel('UTC', summer), 'UTC+00:00');
  assert.equal(timeZoneLabel('UTC-3', summer), 'UTC-03:00');
});
ok('labels a named zone with its offset at that moment', () => {
  assert.equal(timeZoneLabel('Europe/Amsterdam', winter), 'Europe/Amsterdam (UTC+01:00)');
  assert.equal(timeZoneLabel('Europe/Amsterdam', summer), 'Europe/Amsterdam (UTC+02:00)');
  assert.equal(timeZoneLabel('America/New_York', summer), 'America/New York (UTC-04:00)');
});

ok('the picker offers every offset and no duplicates', () => {
  const [named, offsets] = timeZoneOptions('UTC', summer);
  assert.equal(offsets.options.length, 27); // -12 … +14
  assert.equal(offsets.options[0].value, 'UTC+14');
  assert.ok(offsets.options.some((option) => option.value === 'UTC-3'));

  const values = [...named.options, ...offsets.options].map((option) => option.value);
  assert.equal(new Set(values).size, values.length);
});
ok('the picker keeps a hand-typed zone selectable', () => {
  const [named] = timeZoneOptions('Africa/Kampala', summer);
  assert.ok(named.options.some((option) => option.value === 'Africa/Kampala'));
});

ok('href carries a non-default timezone', () => {
  assert.equal(
    logQueryHref({ days: 1, sku: '', page: 1, defaultDays: 1, tz: 'UTC-3', defaultTz: 'UTC' }),
    '/?tz=UTC-3'
  );
  assert.equal(
    logQueryHref({ days: 7, sku: 'shirt', page: 2, defaultDays: 1, tz: 'UTC-3', defaultTz: 'UTC' }),
    '/?days=7&sku=shirt&page=2&tz=UTC-3'
  );
});
ok('href omits the configured timezone', () => {
  assert.equal(
    logQueryHref({ days: 1, sku: '', page: 1, defaultDays: 1, tz: 'UTC', defaultTz: 'UTC' }),
    '/'
  );
  assert.equal(
    logQueryHref({
      days: 1,
      sku: '',
      page: 1,
      defaultDays: 1,
      tz: 'Europe/Amsterdam',
      defaultTz: 'Europe/Amsterdam',
    }),
    '/'
  );
});

/* ---------- Dashboard login ------------------------------------------------ */

const PASSWORD = 'correct horse battery staple';
const nowMs = Date.parse('2026-08-03T10:00:00.000Z');

ok('compares in constant time, correctly', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abd'), false);
  assert.equal(constantTimeEquals('abc', 'abcd'), false);
  assert.equal(constantTimeEquals('', ''), true);
});

ok('a session lasts a week', () =>
  assert.equal(SESSION_MAX_AGE_SECONDS, 7 * 24 * 60 * 60));
ok('the cookie has a stable name', () =>
  assert.equal(SESSION_COOKIE, 'wc_audit_session'));

const token = await createSessionToken(PASSWORD, nowMs);

ok('token carries its own expiry', () => {
  const [expiry, signature] = token.split('.');
  assert.equal(Number(expiry), nowMs + SESSION_MAX_AGE_SECONDS * 1000);
  assert.ok(signature.length > 20);
  // The password must not be recoverable by reading the cookie.
  assert.ok(!token.includes(PASSWORD));
});

await okAsync('token verifies for the password that signed it', async () =>
  assert.equal(await verifySessionToken(token, PASSWORD, nowMs), true));
await okAsync('token fails for a different password', async () =>
  assert.equal(await verifySessionToken(token, 'wrong', nowMs), false));
await okAsync('token fails once expired', async () => {
  const justAfter = nowMs + SESSION_MAX_AGE_SECONDS * 1000 + 1;
  assert.equal(await verifySessionToken(token, PASSWORD, justAfter), false);
});
await okAsync('a stretched expiry does not verify', async () => {
  const [, signature] = token.split('.');
  const stretched = `${nowMs + 10 * 365 * 24 * 3600 * 1000}.${signature}`;
  assert.equal(await verifySessionToken(stretched, PASSWORD, nowMs), false);
});
await okAsync('malformed tokens are rejected', async () => {
  for (const bad of ['', 'nonsense', `${nowMs}.`, '.sig', '1e99.sig', ` ${nowMs}.sig`]) {
    assert.equal(await verifySessionToken(bad, PASSWORD, nowMs), false, bad);
  }
  assert.equal(await verifySessionToken(undefined, PASSWORD, nowMs), false);
});
await okAsync('no password means no valid session', async () =>
  assert.equal(await verifySessionToken(token, '', nowMs), false));

ok('post-login redirect stays on this site', () => {
  assert.equal(safeRedirect('/?days=7&sku=shirt'), '/?days=7&sku=shirt');
  assert.equal(safeRedirect(undefined), '/');
  assert.equal(safeRedirect(''), '/');
  assert.equal(safeRedirect('https://evil.example.com'), '/');
  assert.equal(safeRedirect('//evil.example.com'), '/');
  assert.equal(safeRedirect('/\\evil.example.com'), '/');
});

console.log(`\nAll ${passed} TS checks passed.`);
