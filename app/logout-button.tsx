import { logout } from './login/actions';

/**
 * Sits in the dashboard header. A plain form posting a server action, so it
 * needs no client JavaScript — and rendering it at all is the page's decision,
 * since there is nothing to sign out of when `DASHBOARD_PASSWORD` is unset.
 */
export default function LogoutButton() {
  return (
    <form action={logout}>
      <button
        type="submit"
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        Sign out
      </button>
    </form>
  );
}
