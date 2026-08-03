import type { AuditChanges } from '@/types/audit';

export interface ChangeLine {
  /** Human label, e.g. "Regular price". */
  label: string;
  /** Group the field belongs to, e.g. "price". Used for colour coding. */
  group: string;
  from: string;
  to: string;
}

const FIELD_LABELS: Record<string, string> = {
  price: 'Price',
  regular_price: 'Regular price',
  sale_price: 'Sale price',
  stock: 'Stock',
  stock_quantity: 'Stock quantity',
  stock_status: 'Stock status',
  manage_stock: 'Manage stock',
  status: 'Status',
  catalog_visibility: 'Catalog visibility',
  name: 'Name',
  sku: 'SKU',
};

const VALUE_LABELS: Record<string, string> = {
  instock: 'In stock',
  outofstock: 'Out of stock',
  onbackorder: 'On backorder',
  publish: 'Published',
  draft: 'Draft',
  pending: 'Pending review',
  private: 'Private',
  trash: 'Trashed',
  visible: 'Shop and search',
  catalog: 'Shop only',
  search: 'Search only',
  hidden: 'Hidden',
};

/** Fields whose values should be rendered as money. */
const PRICE_FIELDS = new Set(['regular_price', 'sale_price', 'price']);

export function humanizeField(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function isDelta(value: unknown): value is { from?: unknown; to?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('from' in value || 'to' in value)
  );
}

function formatValue(value: unknown, field: string, currency?: string): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  const asString = String(value);

  if (PRICE_FIELDS.has(field)) {
    const numeric = Number(asString);
    if (Number.isFinite(numeric)) {
      const formatted = numeric.toFixed(2);
      return currency ? `${formatted} ${currency}` : formatted;
    }
  }

  return VALUE_LABELS[asString] ?? asString;
}

/**
 * Flattens the stored `changes` object into a flat list of renderable lines.
 *
 * Handles all three shapes the WordPress plugin (or a future one) can produce:
 *   - grouped deltas:  { price: { regular_price: { from, to } } }
 *   - flat deltas:     { status: { from, to } }
 *   - bare values:     { status: 'publish' }
 */
export function summarizeChanges(
  changes: AuditChanges | null | undefined,
  currency?: string
): ChangeLine[] {
  if (!changes || typeof changes !== 'object') {
    return [];
  }

  const lines: ChangeLine[] = [];

  for (const [groupKey, groupValue] of Object.entries(changes)) {
    if (groupValue === null || groupValue === undefined) {
      continue;
    }

    // { status: { from, to } }
    if (isDelta(groupValue)) {
      lines.push({
        label: humanizeField(groupKey),
        group: groupKey,
        from: formatValue(groupValue.from, groupKey, currency),
        to: formatValue(groupValue.to, groupKey, currency),
      });
      continue;
    }

    // { price: { regular_price: { from, to }, ... } }
    if (typeof groupValue === 'object' && !Array.isArray(groupValue)) {
      for (const [fieldKey, fieldValue] of Object.entries(
        groupValue as Record<string, unknown>
      )) {
        if (fieldValue === null || fieldValue === undefined) {
          continue;
        }

        if (isDelta(fieldValue)) {
          lines.push({
            label: humanizeField(fieldKey),
            group: groupKey,
            from: formatValue(fieldValue.from, fieldKey, currency),
            to: formatValue(fieldValue.to, fieldKey, currency),
          });
        } else {
          lines.push({
            label: humanizeField(fieldKey),
            group: groupKey,
            from: '—',
            to: formatValue(fieldValue, fieldKey, currency),
          });
        }
      }
      continue;
    }

    // { status: 'publish' }
    lines.push({
      label: humanizeField(groupKey),
      group: groupKey,
      from: '—',
      to: formatValue(groupValue, groupKey, currency),
    });
  }

  return lines;
}

/** Renders a timestamp in a fixed timezone so server output is deterministic. */
export function formatTimestamp(date: Date | string | number | undefined): string {
  if (!date) {
    return '—';
  }

  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: process.env.DASHBOARD_TIMEZONE || 'UTC',
  }).format(value);
}

/** "3 minutes ago" — cheap relative time without a date library. */
export function formatRelative(date: Date | string | number | undefined): string {
  if (!date) {
    return '';
  }

  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) {
    return '';
  }

  const seconds = Math.round((Date.now() - value.getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  const divisions: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.34524, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];

  let duration = seconds;
  for (const [amount, unit] of divisions) {
    if (Math.abs(duration) < amount) {
      return formatter.format(-Math.round(duration), unit);
    }
    duration /= amount;
  }

  return '';
}
