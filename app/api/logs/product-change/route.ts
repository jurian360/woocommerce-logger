import { NextResponse } from 'next/server';
import { z } from 'zod';

import { dbConnect } from '@/lib/db';
import { secretMatches } from '@/lib/secret';
import AuditLog from '@/models/AuditLog';

/** Mongoose needs the Node.js runtime — it cannot run on the Edge runtime. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Reject oversized bodies before parsing them. */
const MAX_BODY_BYTES = 64 * 1024;

const deltaOrValue = z.unknown();

const PayloadSchema = z.object({
  product_id: z.coerce.number().int().nonnegative(),
  parent_id: z.coerce.number().int().nonnegative().optional(),
  sku: z.string().max(200).optional(),
  name: z.string().max(500).optional(),
  currency: z.string().max(10).optional(),
  site: z.string().max(300).optional(),
  source: z.string().max(50).optional(),
  permalink: z.string().max(2000).optional(),
  edit_link: z.string().max(2000).optional(),
  is_new: z.coerce.boolean().optional(),
  admin: z
    .object({
      id: z.coerce.number().int().nonnegative().optional(),
      user: z.string().max(200).optional(),
      email: z.string().max(320).optional(),
      roles: z.array(z.string().max(100)).max(50).optional(),
    })
    .optional(),
  /** ISO-8601 string or unix seconds. Falls back to server time when absent. */
  timestamp: z.union([z.string().max(64), z.number()]).optional(),
  changes: z.record(z.string(), deltaOrValue).optional(),
});

function unauthorized(): NextResponse {
  return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
}

/** Accepts ISO-8601, unix seconds, or unix milliseconds. */
function parseTimestamp(value: string | number | undefined): Date {
  if (value === undefined || value === '') {
    return new Date();
  }

  if (typeof value === 'number') {
    const ms = value > 1e11 ? value : value * 1000;
    const fromNumber = new Date(ms);
    return Number.isNaN(fromNumber.getTime()) ? new Date() : fromNumber;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+$/.test(value.trim())) {
    return parseTimestamp(numeric);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function POST(request: Request): Promise<NextResponse> {
  const expectedSecret = process.env.API_SECRET;

  // Fail closed: a missing server secret must never mean "everything allowed".
  if (!expectedSecret) {
    console.error('[audit] API_SECRET is not configured; rejecting request.');
    return NextResponse.json(
      { success: false, error: 'Server not configured' },
      { status: 500 }
    );
  }

  const providedSecret = request.headers.get('x-api-secret');

  if (!providedSecret || !secretMatches(providedSecret, expectedSecret)) {
    return unauthorized();
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: 'Payload too large' },
      { status: 413 }
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const parsed = PayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 }
    );
  }

  const payload = parsed.data;

  try {
    await dbConnect();

    // NOTE: the write is awaited on purpose. On Vercel the function instance is
    // frozen the moment the response is returned, so a fire-and-forget promise
    // would frequently never reach Atlas. The WordPress side is already
    // non-blocking (`'blocking' => false`), so the shop never waits on this.
    const doc = await AuditLog.create({
      product_id: payload.product_id,
      parent_id: payload.parent_id ?? 0,
      sku: payload.sku ?? '',
      name: payload.name ?? '',
      currency: payload.currency ?? '',
      site: payload.site ?? '',
      source: payload.source ?? '',
      permalink: payload.permalink ?? '',
      edit_link: payload.edit_link ?? '',
      is_new: payload.is_new ?? false,
      admin: {
        id: payload.admin?.id ?? 0,
        user: payload.admin?.user ?? '',
        email: payload.admin?.email ?? '',
        roles: payload.admin?.roles,
      },
      timestamp: parseTimestamp(payload.timestamp),
      received_at: new Date(),
      changes: payload.changes ?? {},
    });

    return NextResponse.json(
      { success: true, id: String(doc._id) },
      { status: 202 }
    );
  } catch (error) {
    console.error('[audit] Failed to persist product change:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to persist audit log' },
      { status: 500 }
    );
  }
}

/** Cheap connectivity probe for verifying the endpoint + secret from WordPress. */
export async function GET(request: Request): Promise<NextResponse> {
  const expectedSecret = process.env.API_SECRET;
  const providedSecret = request.headers.get('x-api-secret');

  if (!expectedSecret || !providedSecret || !secretMatches(providedSecret, expectedSecret)) {
    return unauthorized();
  }

  return NextResponse.json({ success: true, ready: true });
}
