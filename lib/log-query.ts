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

/**
 * The window a bare `/` shows. Deliberately much narrower than the retention
 * window: the dashboard is read to answer "what changed just now", and the
 * older entries are one click (or one `?days=`) away.
 */
export const DEFAULT_WINDOW_DAYS = 1;

/** Entries per page. Everything older is reachable through `?page=`. */
export const LOG_PAGE_SIZE = 50;

/** Upper bound on `?page=`, so a hand-typed number cannot ask Mongo to skip
 * millions of documents. The real bound is `pageCount()`, applied once the
 * match count is known. */
export const MAX_PAGE = 100_000;

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

/**
 * The window shown when `?days=` is absent. Never wider than what is retained,
 * so a short `LOG_RETENTION_DAYS` still produces a window with data behind it.
 */
export function defaultWindowDays(max: number = retentionDays()): number {
  return DEFAULT_WINDOW_DAYS > max ? max : DEFAULT_WINDOW_DAYS;
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
 * `?days=` → a window in days. Anything missing or unparseable falls back to
 * the default window; anything larger than the retention window is clamped to
 * it, because there is no data behind a wider one.
 */
export function parseDays(
  raw: string | string[] | undefined,
  max: number = retentionDays()
): number {
  const value = firstValue(raw).trim();
  const fallback = defaultWindowDays(max);

  if (value === '') {
    return fallback;
  }

  const parsed = Math.floor(Number(value));

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed > max ? max : parsed;
}

/** `?page=` → a 1-based page number. Anything missing or invalid is page 1. */
export function parsePage(raw: string | string[] | undefined): number {
  const value = firstValue(raw).trim();

  if (value === '') {
    return 1;
  }

  const parsed = Math.floor(Number(value));

  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return parsed > MAX_PAGE ? MAX_PAGE : parsed;
}

/** How many pages `total` matches fill. Always at least one, so an empty
 * result set is "page 1 of 1" rather than "page 1 of 0". */
export function pageCount(total: number, pageSize: number = LOG_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(total / pageSize));
}

/** Documents to skip to reach the start of `page`. */
export function skipFor(page: number, pageSize: number = LOG_PAGE_SIZE): number {
  return (page - 1) * pageSize;
}

/**
 * The page numbers to render, at most `max` of them. The first and last page
 * are always included, the rest cluster around the current one, so gaps in the
 * returned list are where the UI draws an ellipsis.
 */
export function pageNumbers(page: number, pages: number, max = 7): number[] {
  if (pages <= max) {
    return Array.from({ length: Math.max(1, pages) }, (_, index) => index + 1);
  }

  // A page outside the range would otherwise be added to the list verbatim.
  const current = Math.min(Math.max(page, 1), pages);
  const shown = new Set<number>([1, pages, current]);

  for (let radius = 1; shown.size < max && radius <= pages; radius += 1) {
    if (current - radius > 1) {
      shown.add(current - radius);
    }

    if (shown.size < max && current + radius < pages) {
      shown.add(current + radius);
    }
  }

  return [...shown].sort((a, b) => a - b);
}

export interface LogQueryHref {
  days: number;
  sku: string;
  page: number;
  /** The window a bare `/` already means; kept out of the query string. */
  defaultDays: number;
}

/**
 * Builds a dashboard URL from a filter state. Defaults are omitted so the
 * unfiltered first page is always just `/`, and so the filter bar and the
 * pagination links cannot drift apart — both call this.
 */
export function logQueryHref({ days, sku, page, defaultDays }: LogQueryHref): string {
  const params = new URLSearchParams();

  if (days !== defaultDays) {
    params.set('days', String(days));
  }

  const trimmed = sku.trim();
  if (trimmed !== '') {
    params.set('sku', trimmed);
  }

  if (page > 1) {
    params.set('page', String(page));
  }

  const query = params.toString();

  return query === '' ? '/' : `/?${query}`;
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
  page?: string | string[] | undefined;
  /** Retention window; defaults to `LOG_RETENTION_DAYS`. */
  max?: number;
  now?: Date;
}

export interface ParsedLogQuery {
  filter: LogFilter;
  days: number;
  sku: string;
  /** Requested page. Still has to be clamped against the real match count. */
  page: number;
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
  page: rawPage,
  max = retentionDays(),
  now = new Date(),
}: LogFilterInput = {}): ParsedLogQuery {
  const days = parseDays(rawDays, max);
  const sku = parseSku(rawSku);
  const page = parsePage(rawPage);
  const cutoff = cutoffFor(days, now);

  const filter: LogFilter = { timestamp: { $gte: cutoff } };

  if (sku !== '') {
    // Substring match: partial SKUs ("SHIRT") should find "SHIRT-01".
    filter.sku = { $regex: escapeRegex(sku), $options: 'i' };
  }

  return { filter, days, sku, page, cutoff, isFiltered: days !== max || sku !== '' };
}
