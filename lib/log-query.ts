/**
 * Retention policy and dashboard query building.
 *
 * Both concerns live in one module on purpose: the dashboard must never show an
 * entry older than the retention window (the purge job runs once a day, so
 * "expired" and "already deleted" are not the same thing), which means the day
 * filter and the purge cutoff have to be derived from the same numbers.
 *
 * Everything here is pure and free of Mongoose imports so `tests/` can exercise
 * it directly under `node --experimental-strip-types`.
 */

export const DEFAULT_RETENTION_DAYS = 14;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Quick-filter buttons offered above the table, clamped to the retention window. */
const DAY_CHOICES = [1, 3, 7, 14, 30, 90];

/** Normalises a raw retention setting into a whole number of days. */
export function resolveRetentionDays(raw?: string | number | null): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_RETENTION_DAYS;
  }

  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());

  if (!Number.isFinite(parsed)) {
    return DEFAULT_RETENTION_DAYS;
  }

  const whole = Math.floor(parsed);

  if (whole < MIN_RETENTION_DAYS) {
    return MIN_RETENTION_DAYS;
  }

  return whole > MAX_RETENTION_DAYS ? MAX_RETENTION_DAYS : whole;
}

/** Retention window in days. `LOG_RETENTION_DAYS` overrides the 14-day default. */
export function retentionDays(): number {
  return resolveRetentionDays(process.env.LOG_RETENTION_DAYS);
}

/** The oldest timestamp that is still inside a `days`-wide window. */
export function cutoffFor(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/** Day options to render, never exceeding what is actually retained. */
export function dayFilterOptions(max: number = retentionDays()): number[] {
  const options = DAY_CHOICES.filter((days) => days < max);
  options.push(max);
  return options;
}

/** "24 hours" / "7 days" — used by the filter buttons and the page header. */
export function windowLabel(days: number): string {
  return days === 1 ? '24 hours' : `${days} days`;
}

/** First value of a Next.js search param (`?days=7&days=1` → `'7'`). */
function firstValue(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) {
    return raw[0] ?? '';
  }

  return raw ?? '';
}

/**
 * `?days=` → a window in days. Anything missing, unparseable, or larger than
 * the retention window falls back to the full retention window.
 */
export function parseDays(
  raw: string | string[] | undefined,
  max: number = retentionDays()
): number {
  const value = firstValue(raw).trim();

  if (value === '') {
    return max;
  }

  const parsed = Math.floor(Number(value));

  if (!Number.isFinite(parsed) || parsed < 1) {
    return max;
  }

  return parsed > max ? max : parsed;
}

/** `?sku=` → a trimmed, length-capped search term. */
export function parseSku(raw: string | string[] | undefined): string {
  return firstValue(raw).trim().slice(0, 200);
}

/** Neutralises regex metacharacters so a SKU like `A+B` searches literally. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface LogFilter {
  timestamp: { $gte: Date };
  sku?: { $regex: string; $options: string };
}

export interface LogFilterInput {
  days?: string | string[] | undefined;
  sku?: string | string[] | undefined;
  /** Retention window; defaults to `LOG_RETENTION_DAYS`. */
  max?: number;
  now?: Date;
}

export interface ParsedLogQuery {
  filter: LogFilter;
  days: number;
  sku: string;
  cutoff: Date;
  /** True when the view is narrower than "everything we keep". */
  isFiltered: boolean;
}

/**
 * Turns raw search params into a Mongo filter plus the normalised values the
 * UI needs to echo back into the form.
 */
export function parseLogQuery({
  days: rawDays,
  sku: rawSku,
  max = retentionDays(),
  now = new Date(),
}: LogFilterInput = {}): ParsedLogQuery {
  const days = parseDays(rawDays, max);
  const sku = parseSku(rawSku);
  const cutoff = cutoffFor(days, now);

  const filter: LogFilter = { timestamp: { $gte: cutoff } };

  if (sku !== '') {
    // Substring match: partial SKUs ("SHIRT") should find "SHIRT-01".
    filter.sku = { $regex: escapeRegex(sku), $options: 'i' };
  }

  return { filter, days, sku, cutoff, isFiltered: days !== max || sku !== '' };
}
