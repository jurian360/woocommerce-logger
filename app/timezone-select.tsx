'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { logQueryHref } from '@/lib/log-query';
import type { TimeZoneOptionGroup } from '@/lib/timezone';

interface TimezoneSelectProps {
  /** Zone currently rendering the table. */
  timeZone: string;
  /** `DASHBOARD_TIMEZONE`; selecting it clears `?tz=` again. */
  defaultTimeZone: string;
  /** Grouped choices, built on the server so both sides label them alike. */
  groups: TimeZoneOptionGroup[];
  /** Current view, carried into the new URL — changing a display setting must
   * not throw away the filter or drop the reader back onto page 1. */
  days: number;
  sku: string;
  page: number;
  defaultDays: number;
}

export default function TimezoneSelect({
  timeZone,
  defaultTimeZone,
  groups,
  days,
  sku,
  page,
  defaultDays,
}: TimezoneSelectProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onChange(nextTimeZone: string) {
    const href = logQueryHref({
      days,
      sku,
      page,
      defaultDays,
      tz: nextTimeZone,
      defaultTz: defaultTimeZone,
    });

    startTransition(() => router.push(href));
  }

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="timezone"
        className="text-sm text-slate-500 dark:text-slate-400"
      >
        Timezone
      </label>
      <select
        id="timezone"
        name="tz"
        value={timeZone}
        onChange={(event) => onChange(event.target.value)}
        disabled={isPending}
        className="max-w-[16rem] rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 shadow-sm transition hover:bg-slate-50 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 dark:focus:ring-slate-700"
      >
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
