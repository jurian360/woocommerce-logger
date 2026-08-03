import { dbConnect } from '@/lib/db';
import AuditLog from '@/models/AuditLog';
import { formatRelative, formatTimestamp, summarizeChanges } from '@/lib/format';
import {
  LOG_PAGE_SIZE,
  dayFilterOptions,
  defaultWindowDays,
  pageCount,
  parseLogQuery,
  retentionDays,
  skipFor,
  windowLabel,
  type LogFilter,
} from '@/lib/log-query';
import type { AuditLogRecord } from '@/types/audit';
import FilterBar from './filter-bar';
import Pagination from './pagination';
import RefreshButton from './refresh-button';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const GROUP_STYLES: Record<string, string> = {
  price: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900',
  stock: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900',
  status:
    'bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900',
  catalog_visibility:
    'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900',
};

const DEFAULT_GROUP_STYLE =
  'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700';

interface LoadResult {
  logs: AuditLogRecord[];
  /** Matches for the current filter, across all pages. */
  total: number;
  /** The page actually rendered — the requested one, clamped to `pages`. */
  page: number;
  pages: number;
  /** Whether the collection holds anything at all, filters aside. Separates
   * "nothing arrived yet" from "nothing matches this filter" — which the
   * default window, being narrower than retention, can no longer do alone. */
  hasAnyLogs: boolean;
  error: string | null;
}

async function loadLogs(filter: LogFilter, requestedPage: number): Promise<LoadResult> {
  try {
    await dbConnect();

    // Counted first, not in parallel with the find: the page number has to be
    // clamped before it can be turned into a skip, otherwise a stale link to a
    // page that no longer exists (entries purged, filter narrowed) renders an
    // empty table instead of the last page.
    const total = await AuditLog.countDocuments(filter);
    const pages = pageCount(total, LOG_PAGE_SIZE);
    const page = Math.min(requestedPage, pages);

    const docs = await AuditLog.find(filter)
      // `_id` breaks ties. Timestamps come from WooCommerce at second
      // precision, so a bulk edit produces duplicates; without a tiebreaker
      // their order is unspecified and skip/limit can repeat or drop rows
      // across page boundaries.
      .sort({ timestamp: -1, _id: -1 })
      .skip(skipFor(page, LOG_PAGE_SIZE))
      .limit(LOG_PAGE_SIZE)
      .lean()
      .exec();

    // `lean()` returns plain objects; normalise _id to a string for React keys.
    const logs = docs.map((doc) => ({
      ...doc,
      _id: String(doc._id),
    })) as unknown as AuditLogRecord[];

    // Only when the view is empty, and only ever a metadata read.
    const hasAnyLogs = total > 0 || (await AuditLog.estimatedDocumentCount()) > 0;

    return { logs, total, page, pages, hasAnyLogs, error: null };
  } catch (error) {
    console.error('[audit] Failed to load logs:', error);
    return {
      logs: [],
      total: 0,
      page: 1,
      pages: 1,
      hasAnyLogs: false,
      error:
        error instanceof Error ? error.message : 'Unknown error while querying MongoDB.',
    };
  }
}

function ProductCell({ log }: { log: AuditLogRecord }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-slate-900 dark:text-slate-100">
        {log.name || `Product #${log.product_id}`}
      </span>
      <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
        #{log.product_id}
        {log.parent_id ? ` (variation of #${log.parent_id})` : ''}
        {log.sku ? ` · ${log.sku}` : ''}
      </span>
    </div>
  );
}

function AdminCell({ log }: { log: AuditLogRecord }) {
  const label = log.admin?.user || (log.admin?.id ? `User #${log.admin.id}` : 'Unknown');

  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-slate-900 dark:text-slate-100">{label}</span>
      {log.admin?.email ? (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {log.admin.email}
        </span>
      ) : null}
    </div>
  );
}

function ChangesCell({ log }: { log: AuditLogRecord }) {
  const lines = summarizeChanges(log.changes, log.currency);

  if (lines.length === 0) {
    return <span className="text-sm text-slate-400 dark:text-slate-500">No details</span>;
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {lines.map((line, index) => (
        <li key={`${line.group}-${line.label}-${index}`} className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
              GROUP_STYLES[line.group] ?? DEFAULT_GROUP_STYLE
            }`}
          >
            {line.label}
          </span>
          <span className="font-mono text-xs text-slate-500 line-through decoration-slate-300 dark:text-slate-500 dark:decoration-slate-600">
            {line.from}
          </span>
          <span aria-hidden="true" className="text-slate-400 dark:text-slate-600">
            →
          </span>
          <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
            {line.to}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface DashboardPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const params = await searchParams;
  const retention = retentionDays();
  const defaultDays = defaultWindowDays(retention);
  const {
    filter,
    days,
    sku,
    page: requestedPage,
    isFiltered,
  } = parseLogQuery({
    days: params.days,
    sku: params.sku,
    page: params.page,
    max: retention,
  });

  const { logs, total, page, pages, hasAnyLogs, error } = await loadLogs(
    filter,
    requestedPage
  );

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            WooCommerce Audit Log
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Product changes from the last {windowLabel(days)}
            {sku ? (
              <>
                {' '}
                matching SKU <span className="font-mono">{sku}</span>
              </>
            ) : null}
            {error ? null : (
              <>
                {' '}
                — {total} {total === 1 ? 'entry' : 'entries'}
                {pages > 1 ? `, page ${page} of ${pages}` : ''}
              </>
            )}
            .
          </p>
        </div>
        <RefreshButton />
      </header>

      <FilterBar
        days={days}
        sku={sku}
        options={dayFilterOptions(retention)}
        defaultDays={defaultDays}
      />

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <p className="font-semibold">Could not read the audit log.</p>
          <p className="mt-1 font-mono text-xs break-words">{error}</p>
          <p className="mt-2">
            Check that <code className="font-mono">MONGODB_URI</code> is set and that this
            deployment&apos;s IP is allowed in MongoDB Atlas (Network Access).
          </p>
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center dark:border-slate-700 dark:bg-slate-900">
          {hasAnyLogs ? (
            <>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                No changes match this filter.
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {sku ? (
                  <>
                    Nothing with SKU <span className="font-mono">{sku}</span> changed in the
                    last {windowLabel(days)}.{' '}
                  </>
                ) : (
                  <>Nothing changed in the last {windowLabel(days)}. </>
                )}
                {isFiltered ? 'Widen the period or clear the search.' : null}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                No changes logged yet.
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Activate the WordPress plugin, then edit a product&apos;s price, stock,
                status or catalog visibility.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
            <thead className="bg-slate-50 dark:bg-slate-900/60">
              <tr>
                <th
                  scope="col"
                  className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                >
                  Timestamp
                </th>
                <th
                  scope="col"
                  className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                >
                  Product / SKU
                </th>
                <th
                  scope="col"
                  className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                >
                  Admin
                </th>
                <th
                  scope="col"
                  className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                >
                  Changes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {logs.map((log) => (
                <tr
                  key={log._id}
                  className="align-top transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-slate-900 dark:text-slate-100">
                        {formatTimestamp(log.timestamp)}
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {formatRelative(log.timestamp)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <ProductCell log={log} />
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <AdminCell log={log} />
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <ChangesCell log={log} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error || logs.length === 0 ? null : (
        <Pagination
          page={page}
          pages={pages}
          total={total}
          pageSize={LOG_PAGE_SIZE}
          days={days}
          sku={sku}
          defaultDays={defaultDays}
        />
      )}

      <p className="mt-6 text-xs text-slate-400 dark:text-slate-600">
        Timestamps shown in {process.env.DASHBOARD_TIMEZONE || 'UTC'}. Entries are kept for{' '}
        {windowLabel(retention)}; older ones are deleted by the daily cleanup job.
      </p>
    </main>
  );
}
