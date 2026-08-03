import { NextResponse } from 'next/server';

import { dbConnect } from '@/lib/db';
import { cutoffFor, retentionDays } from '@/lib/log-query';
import { secretMatches } from '@/lib/secret';
import AuditLog from '@/models/AuditLog';

/**
 * Retention purge.
 *
 * Deletes every entry older than the retention window (14 days by default,
 * `LOG_RETENTION_DAYS` to change it). Meant to be called by the Vercel cron
 * declared in `vercel.json`, which issues a `GET` with
 * `Authorization: Bearer $CRON_SECRET`; `POST` with `X-Api-Secret` works too,
 * so the job can be triggered by hand.
 *
 * `?dry=1` reports what would be deleted without deleting it — the purge runs
 * unattended, so there has to be a way to check it before trusting it.
 */

/** Mongoose needs the Node.js runtime — it cannot run on the Edge runtime. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauthorized(): NextResponse {
  return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
}

/**
 * Accepts either `X-Api-Secret: <API_SECRET>` or
 * `Authorization: Bearer <CRON_SECRET, or API_SECRET when unset>`. Vercel adds
 * the bearer header to cron requests only when `CRON_SECRET` is configured.
 */
function authorized(request: Request): boolean {
  const apiSecret = process.env.API_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  const provided = request.headers.get('x-api-secret');
  if (apiSecret && provided && secretMatches(provided, apiSecret)) {
    return true;
  }

  const header = request.headers.get('authorization');
  if (header && header.toLowerCase().startsWith('bearer ')) {
    const expected = cronSecret || apiSecret;
    if (expected && secretMatches(header.slice(7).trim(), expected)) {
      return true;
    }
  }

  return false;
}

async function purge(request: Request): Promise<NextResponse> {
  // Fail closed: with no secret configured, anyone could wipe the audit log.
  if (!process.env.API_SECRET && !process.env.CRON_SECRET) {
    console.error('[audit] Neither API_SECRET nor CRON_SECRET is set; refusing to purge.');
    return NextResponse.json(
      { success: false, error: 'Server not configured' },
      { status: 500 }
    );
  }

  if (!authorized(request)) {
    return unauthorized();
  }

  const dryRun = ['1', 'true', 'yes'].includes(
    (new URL(request.url).searchParams.get('dry') ?? '').toLowerCase()
  );

  const days = retentionDays();
  const cutoff = cutoffFor(days);

  try {
    await dbConnect();

    const expired = { timestamp: { $lt: cutoff } };

    const deleted = dryRun
      ? await AuditLog.countDocuments(expired)
      : (await AuditLog.deleteMany(expired)).deletedCount ?? 0;

    // The cron runs unattended, so the outcome goes to the function log either
    // way — a purge that silently stops working is the failure mode to avoid.
    console.log(
      `[audit] retention ${dryRun ? 'dry run' : 'purge'}: ${deleted} entries older than ` +
        `${cutoff.toISOString()} (${days} day window)`
    );

    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      retention_days: days,
      cutoff: cutoff.toISOString(),
      deleted,
    });
  } catch (error) {
    console.error('[audit] Retention purge failed:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to purge audit log' },
      { status: 500 }
    );
  }
}

/** Vercel cron calls this. */
export async function GET(request: Request): Promise<NextResponse> {
  return purge(request);
}

/** Manual runs. */
export async function POST(request: Request): Promise<NextResponse> {
  return purge(request);
}
