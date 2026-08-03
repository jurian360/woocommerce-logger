import Link from 'next/link';

import { logQueryHref, pageNumbers } from '@/lib/log-query';

interface PaginationProps {
  /** Current page, already clamped to `pages`. */
  page: number;
  /** Total number of pages for the current filter. */
  pages: number;
  /** Matches for the current filter, across all pages. */
  total: number;
  pageSize: number;
  /** Filter state, carried into every link so paging keeps the filters. */
  days: number;
  sku: string;
  defaultDays: number;
}

const LINK =
  'inline-flex min-w-9 items-center justify-center rounded-md px-2.5 py-1.5 text-sm font-medium transition';

const INACTIVE =
  'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800';

const ACTIVE = 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900';

const DISABLED = 'cursor-not-allowed text-slate-300 dark:text-slate-700';

export default function Pagination({
  page,
  pages,
  total,
  pageSize,
  days,
  sku,
  defaultDays,
}: PaginationProps) {
  if (pages <= 1) {
    return null;
  }

  const href = (target: number) => logQueryHref({ days, sku, page: target, defaultDays });

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3"
    >
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Showing <span className="font-medium text-slate-900 dark:text-slate-100">{first}</span>
        –<span className="font-medium text-slate-900 dark:text-slate-100">{last}</span> of{' '}
        <span className="font-medium text-slate-900 dark:text-slate-100">{total}</span>
      </p>

      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        {page > 1 ? (
          <Link href={href(page - 1)} rel="prev" className={`${LINK} ${INACTIVE}`}>
            ← Previous
          </Link>
        ) : (
          <span aria-hidden="true" className={`${LINK} ${DISABLED}`}>
            ← Previous
          </span>
        )}

        {pageNumbers(page, pages).map((target, index, shown) => (
          <span key={target} className="flex items-center gap-1">
            {index > 0 && target !== shown[index - 1] + 1 ? (
              <span aria-hidden="true" className="px-1 text-slate-400 dark:text-slate-600">
                …
              </span>
            ) : null}
            {target === page ? (
              <span aria-current="page" className={`${LINK} ${ACTIVE}`}>
                {target}
              </span>
            ) : (
              <Link
                href={href(target)}
                aria-label={`Page ${target}`}
                className={`${LINK} ${INACTIVE}`}
              >
                {target}
              </Link>
            )}
          </span>
        ))}

        {page < pages ? (
          <Link href={href(page + 1)} rel="next" className={`${LINK} ${INACTIVE}`}>
            Next →
          </Link>
        ) : (
          <span aria-hidden="true" className={`${LINK} ${DISABLED}`}>
            Next →
          </span>
        )}
      </div>
    </nav>
  );
}
