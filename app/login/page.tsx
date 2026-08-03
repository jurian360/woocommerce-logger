import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  SESSION_COOKIE,
  dashboardPassword,
  safeRedirect,
  verifySessionToken,
} from '@/lib/auth';
import LoginForm from './login-form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in · WooCommerce Audit Log',
  robots: { index: false, follow: false },
};

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const raw = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = safeRedirect(raw);

  const password = dashboardPassword();

  // Nothing to sign in to when the dashboard is open, and no reason to ask
  // again when the cookie is still good — both cases just go to the log.
  if (password === '') {
    redirect(next);
  }

  const store = await cookies();

  if (await verifySessionToken(store.get(SESSION_COOKIE)?.value, password)) {
    redirect(next);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4 py-10">
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          WooCommerce Audit Log
        </h1>
        <p className="mb-5 mt-1 text-sm text-slate-500 dark:text-slate-400">
          Enter the dashboard password to continue.
        </p>

        <LoginForm next={next} />
      </div>
    </main>
  );
}
