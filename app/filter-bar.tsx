'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition, type FormEvent } from 'react';

import { windowLabel } from '@/lib/log-query';

interface FilterBarProps {
  /** Currently selected window, in days. */
  days: number;
  /** Currently applied SKU search. */
  sku: string;
  /** Selectable windows, widest last. */
  options: number[];
  /** The widest window there is data for — also the default. */
  retentionDays: number;
}

const BASE_BUTTON =
  'rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60';

export default function FilterBar({ days, sku, options, retentionDays }: FilterBarProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [skuInput, setSkuInput] = useState(sku);

  // Re-sync when the URL changes underneath the component (back/forward button).
  useEffect(() => {
    setSkuInput(sku);
  }, [sku]);

  function navigate(nextDays: number, nextSku: string) {
    const params = new URLSearchParams();

    // The default window and an empty search stay out of the URL, so the
    // unfiltered dashboard is always just `/`.
    if (nextDays !== retentionDays) {
      params.set('days', String(nextDays));
    }

    const trimmed = nextSku.trim();
    if (trimmed !== '') {
      params.set('sku', trimmed);
    }

    const query = params.toString();
    startTransition(() => router.push(query ? `/?${query}` : '/'));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(days, skuInput);
  }

  const isFiltered = days !== retentionDays || sku !== '';

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
      <div
        role="group"
        aria-label="Filter by period"
        className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        {options.map((option) => {
          const active = option === days;

          return (
            <button
              key={option}
              type="button"
              onClick={() => navigate(option, skuInput)}
              disabled={isPending}
              aria-pressed={active}
              className={`${BASE_BUTTON} ${
                active
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              {windowLabel(option)}
            </button>
          );
        })}
      </div>

      <form onSubmit={onSubmit} className="flex flex-1 flex-wrap items-center gap-2">
        <label htmlFor="sku-search" className="sr-only">
          Search by SKU
        </label>
        <input
          id="sku-search"
          name="sku"
          type="search"
          value={skuInput}
          onChange={(event) => setSkuInput(event.target.value)}
          placeholder="Search SKU…"
          autoComplete="off"
          spellCheck={false}
          className="w-full min-w-0 max-w-xs rounded-md border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 shadow-sm placeholder:font-sans placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:ring-slate-700 sm:w-auto"
        />
        <button
          type="submit"
          disabled={isPending}
          className={`${BASE_BUTTON} border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
        >
          Search
        </button>
        {isFiltered ? (
          <button
            type="button"
            onClick={() => {
              setSkuInput('');
              navigate(retentionDays, '');
            }}
            disabled={isPending}
            className={`${BASE_BUTTON} text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100`}
          >
            Clear
          </button>
        ) : null}
      </form>
    </div>
  );
}
