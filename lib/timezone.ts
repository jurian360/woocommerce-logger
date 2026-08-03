/**
 * Timezone resolution for the dashboard.
 *
 * Two kinds of value are accepted and both are called a "zone" here:
 *
 *   - an IANA name, e.g. `Europe/Amsterdam`, which follows DST;
 *   - a fixed offset, written the way a reader would say it: `UTC-3`, `UTC+5:30`
 *     is *not* accepted, `UTC` means zero. A fixed offset never shifts.
 *
 * The canonical form of a fixed offset is `UTC-3`, not the IANA spelling, for
 * two reasons: it survives a round trip through `?tz=` without percent-encoding,
 * and the IANA spelling is `Etc/GMT+3` — the sign is **inverted** there (POSIX
 * heritage), so putting it in a URL would show every reader the wrong number.
 * `intlTimeZone()` does that inversion, in one place, at the point of use.
 *
 * Only whole-hour offsets are supported, because `Etc/GMT*` only defines those.
 * Half-hour zones (India, Nepal, parts of Australia) are reachable by their IANA
 * name, which is also the more correct choice for them.
 *
 * Pure and free of Node/Next imports so `tests/` can exercise it directly.
 */

/** Used when nothing is configured and nothing is requested. */
export const DEFAULT_TIME_ZONE = 'UTC';

/** `Etc/GMT+12` … `Etc/GMT-14` is the whole of what IANA defines. */
export const MIN_OFFSET_HOURS = -12;
export const MAX_OFFSET_HOURS = 14;

/**
 * Named zones offered in the picker. A short list on purpose — the full IANA
 * database is ~600 entries, and anything missing is still reachable by typing
 * it into `?tz=`, or by picking the matching fixed offset.
 */
const NAMED_ZONE_CHOICES = [
  // No `UTC` here: it is the zero entry of the fixed-offset group, and the same
  // value in two `<optgroup>`s makes a `<select>` ambiguous about which is set.
  'Europe/London',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/**
 * `UTC-3`, `utc -03:00`, `GMT+2`, `-3`, `+02` → a canonical `UTC-3`.
 * Returns `null` when the value is not an offset at all (an IANA name, say).
 */
export function parseOffsetZone(raw: string): string | null {
  const value = raw.trim();

  if (value === '') {
    return null;
  }

  if (/^(?:utc|gmt|z)$/i.test(value)) {
    return 'UTC';
  }

  const match = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(value);

  if (!match) {
    return null;
  }

  // A non-zero minute part is a real offset we cannot express as `Etc/GMT*`.
  if (match[3] !== undefined && match[3] !== '00') {
    return null;
  }

  const hours = Number(match[2]) * (match[1] === '-' ? -1 : 1);

  if (hours < MIN_OFFSET_HOURS || hours > MAX_OFFSET_HOURS) {
    return null;
  }

  if (hours === 0) {
    return 'UTC';
  }

  return `UTC${hours > 0 ? '+' : '-'}${Math.abs(hours)}`;
}

/** The offset in hours of a canonical `UTC±H`, or `null` for a named zone. */
export function offsetHours(zone: string): number | null {
  if (zone === 'UTC') {
    return 0;
  }

  const match = /^UTC([+-])(\d{1,2})$/.exec(zone);

  return match ? Number(match[2]) * (match[1] === '-' ? -1 : 1) : null;
}

/**
 * The identifier to hand to `Intl`. Fixed offsets become `Etc/GMT∓H`, where the
 * sign is inverted — `Etc/GMT+3` is UTC−3. This is the only place that knows.
 */
export function intlTimeZone(zone: string): string {
  const hours = offsetHours(zone);

  if (hours === null) {
    return zone;
  }

  if (hours === 0) {
    return 'UTC';
  }

  // Inverted on purpose: POSIX counts west of Greenwich as positive.
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}

/** Whether `Intl` will accept this zone. The only reliable test is to try it. */
export function isValidTimeZone(zone: string): boolean {
  if (zone === '') {
    return false;
  }

  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: intlTimeZone(zone) });
    return true;
  } catch {
    return false;
  }
}

/**
 * A raw value — from `?tz=`, from `DASHBOARD_TIMEZONE` — to a zone that is safe
 * to format with. Anything unusable falls back rather than throwing: a bad
 * `?tz=` in a shared link must not break the page.
 */
export function resolveTimeZone(
  raw: string | null | undefined,
  fallback: string = DEFAULT_TIME_ZONE
): string {
  const value = (raw ?? '').trim();

  if (value === '') {
    return fallback;
  }

  const offset = parseOffsetZone(value);

  if (offset !== null) {
    return offset;
  }

  if (!isValidTimeZone(value)) {
    return fallback;
  }

  // Canonicalise the casing/aliasing ("europe/amsterdam", "Asia/Calcutta") so
  // the value echoed into the URL matches what the picker compares against.
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return value;
  }
}

/** The configured default. `DASHBOARD_TIMEZONE` accepts either form. */
export function defaultTimeZone(): string {
  return resolveTimeZone(process.env.DASHBOARD_TIMEZONE, DEFAULT_TIME_ZONE);
}

/** First value of a Next.js search param, resolved against the default. */
export function parseTimeZone(
  raw: string | string[] | undefined,
  fallback: string = defaultTimeZone()
): string {
  const value = Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';

  return resolveTimeZone(value, fallback);
}

/** `'UTC+02:00'` — the zone's actual offset at `at`, so DST is reflected. */
export function offsetLabel(zone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: intlTimeZone(zone),
      timeZoneName: 'longOffset',
    }).formatToParts(at);

    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';

    // "GMT" on the dot, "GMT+02:00" otherwise.
    if (name === 'GMT' || name === 'UTC') {
      return 'UTC+00:00';
    }

    return name.replace(/^(GMT|UTC)/, 'UTC');
  } catch {
    return 'UTC+00:00';
  }
}

/** How the zone is named in the picker and the footer. */
export function timeZoneLabel(zone: string, at: Date = new Date()): string {
  const offset = offsetLabel(zone, at);

  if (offsetHours(zone) !== null) {
    // A fixed offset is its own label; `UTC-3` and `UTC-03:00` would be twice
    // the same information.
    return offset;
  }

  return `${zone.replace(/_/g, ' ')} (${offset})`;
}

export interface TimeZoneOption {
  value: string;
  label: string;
}

export interface TimeZoneOptionGroup {
  label: string;
  options: TimeZoneOption[];
}

/**
 * The picker's contents: named zones first, then every fixed offset. `current`
 * is appended to the named group when it is neither — a hand-typed `?tz=` stays
 * selectable instead of silently snapping back.
 */
export function timeZoneOptions(
  current: string = DEFAULT_TIME_ZONE,
  at: Date = new Date()
): TimeZoneOptionGroup[] {
  const named = NAMED_ZONE_CHOICES.filter(isValidTimeZone);

  if (offsetHours(current) === null && !named.includes(current)) {
    named.push(current);
  }

  const offsets: string[] = [];
  for (let hours = MAX_OFFSET_HOURS; hours >= MIN_OFFSET_HOURS; hours -= 1) {
    offsets.push(hours === 0 ? 'UTC' : `UTC${hours > 0 ? '+' : '-'}${Math.abs(hours)}`);
  }

  return [
    {
      label: 'Region',
      options: named.map((zone) => ({ value: zone, label: timeZoneLabel(zone, at) })),
    },
    {
      label: 'Fixed offset',
      options: offsets.map((zone) => ({ value: zone, label: offsetLabel(zone, at) })),
    },
  ];
}
