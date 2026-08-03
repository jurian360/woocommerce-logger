import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time secret comparison, shared by every route that authenticates
 * with a pre-shared string, so the secret cannot be recovered by timing.
 *
 * Node.js only — `node:crypto` is unavailable on the Edge runtime.
 */
export function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

export default secretMatches;
