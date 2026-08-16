'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Deep links that open a page's own dialog (HIVE-3.6, #5292).
 *
 * The command palette's Actions group offers "New project…", "Import a spec…" and "Create
 * API key…". Each of those is a long form that belongs to the page that owns the data
 * behind it, and a palette carrying its own copy would be a second place for the same form
 * to drift. So the palette navigates, and the page opens the dialog it already has:
 *
 * ```
 * /ade/dashboard/projects?open=new-project
 * ```
 *
 * The page reads it with {@link useOpenAction} and the parameter is then *stripped*, which
 * is the part that makes the seam safe: a bookmarked or reloaded URL must not reopen a
 * create dialog the reader has already dismissed, and the back button must not either.
 *
 * The names live here rather than at the two ends so the palette and the page cannot
 * disagree about the spelling; `tests/command-palette-model.test.ts` asserts every action
 * the palette offers names an id this module knows.
 */

/** The query parameter carrying the request. */
export const OPEN_ACTION_PARAM = 'open';

/** Every action a page can be asked to open, by name. */
export const OPEN_ACTIONS = {
  /** The projects page's create-project dialog. */
  newProject: 'new-project',
  /** The projects page's import-a-specification dialog. */
  importSpec: 'import-spec',
  /** The API keys page's create-key dialog. */
  newApiKey: 'new-api-key',
} as const;

/** One of {@link OPEN_ACTIONS}. */
export type OpenAction = (typeof OPEN_ACTIONS)[keyof typeof OPEN_ACTIONS];

/** Every action id, for a caller that needs to validate one. */
export const OPEN_ACTION_IDS: readonly OpenAction[] = Object.values(OPEN_ACTIONS);

/**
 * The URL that asks `route` to open `action`.
 *
 * @param route An in-app pathname, with no query of its own.
 * @param action Which dialog the page should open.
 * @returns The pathname with the request appended.
 */
export function openActionHref(route: string, action: OpenAction): string {
  return `${route}?${OPEN_ACTION_PARAM}=${encodeURIComponent(action)}`;
}

/**
 * Read this page's `?open=` request once, then take it out of the URL.
 *
 * Runs `open` on the commit after the parameter appears, and immediately replaces the
 * history entry with the same URL minus the parameter. `replace` rather than `push` so the
 * back button returns to wherever the reader came from rather than to a URL that would
 * reopen the dialog; `scroll: false` so a page that was scrolled stays where it was.
 *
 * A page may call this more than once — the projects page has two dialogs — and each call
 * answers only its own action.
 *
 * @param action The action this page answers.
 * @param open What to do when it is requested. Called at most once per request.
 */
export function useOpenAction(action: OpenAction, open: () => void): void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams?.toString() ?? '';
  const requested = searchParams?.get(OPEN_ACTION_PARAM) === action;

  // The callback is read from a ref so that a page passing an inline arrow — which every
  // page does — does not re-run the effect on each render and reopen its own dialog. The
  // ref is refreshed from an effect rather than during render, which is the rule React 19's
  // compiler enforces: a render is allowed to read props, not to write to a ref.
  const openRef = React.useRef(open);
  React.useEffect(() => {
    openRef.current = open;
  });

  /**
   * The request this hook has already answered.
   *
   * The effect's dependencies are not enough on their own: `useRouter()` and
   * `useSearchParams()` are not guaranteed to hand back the same object twice, and an
   * effect that re-ran would reopen a dialog the reader has just dismissed. Cleared when
   * the request goes, so a *second* request later in the session is still answered.
   */
  const answeredRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!requested) {
      answeredRef.current = null;
      return;
    }
    if (answeredRef.current === query) return;
    answeredRef.current = query;

    // Strip the request first. `router.replace` is asynchronous, so doing it before the
    // dialog opens means the URL is already clean by the time anything can be bookmarked,
    // and a re-render caused by the dialog cannot see the parameter a second time.
    const rest = new URLSearchParams(query);
    rest.delete(OPEN_ACTION_PARAM);
    const remaining = rest.toString();
    router.replace(remaining ? `${pathname}?${remaining}` : (pathname ?? ''), { scroll: false });

    openRef.current();
  }, [requested, query, pathname, router]);
}
