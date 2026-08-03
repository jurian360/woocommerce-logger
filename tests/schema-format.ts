import assert from 'node:assert/strict';
import AuditLog from '../models/AuditLog.ts';
import { summarizeChanges, formatTimestamp } from '../lib/format.ts';

let passed = 0;
function ok(label: string, fn: () => void) {
  fn();
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
ok('collection name', () => assert.equal(AuditLog.collection.collectionName, 'audit_logs'));

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

process.env.DASHBOARD_TIMEZONE = 'UTC';
ok('formats timestamp', () =>
  assert.equal(formatTimestamp(new Date('2026-08-03T10:00:00Z')), '3 Aug 2026, 10:00:00'));
ok('handles invalid timestamp', () => assert.equal(formatTimestamp('not-a-date'), '—'));

console.log(`\nAll ${passed} TS checks passed.`);
