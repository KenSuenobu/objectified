/**
 * Pure logic + storage for the dashboard first-run checklist (#3614).
 *
 * Completion is DERIVED from the same dashboard stats the page already loads (no manual ticks), so
 * the checklist always reflects real state — a freshly-seeded tenant (which gets the published
 * sample project) shows the early steps already done and points the user straight to "view in
 * Browse". Dismissal is persisted in localStorage, mirroring the namespaced-key pattern used by the
 * studio canvas preferences.
 */

/** localStorage key for the user's dismissal of the first-run checklist. */
export const FIRST_RUN_DISMISS_KEY = 'ade.dashboard.firstRunChecklist.dismissed';

/** The subset of dashboard stats that drives checklist completion. */
export interface ChecklistSignal {
  total_projects: number;
  total_classes: number;
  total_versions: number;
  published_versions: number;
}

export type StepId = 'project' | 'class' | 'version' | 'publish' | 'browse';

/** Derive per-step completion from real dashboard counts. */
export function deriveCompletion(signal: ChecklistSignal): Record<StepId, boolean> {
  return {
    project: signal.total_projects > 0,
    class: signal.total_classes > 0,
    version: signal.total_versions > 0,
    publish: signal.published_versions > 0,
    // "View it in Browse" only becomes meaningful once something is published.
    browse: signal.published_versions > 0,
  };
}

/** Count of completed steps for a progress label. */
export function completedCount(signal: ChecklistSignal): number {
  return Object.values(deriveCompletion(signal)).filter(Boolean).length;
}

/** True when every step is complete. */
export function allComplete(signal: ChecklistSignal): boolean {
  return completedCount(signal) === TOTAL_STEPS;
}

/** Total number of checklist steps. */
export const TOTAL_STEPS = 5;

/** Whether the user has dismissed the checklist. Safe if storage is unavailable. */
export function isDismissed(storage: Storage | undefined = safeLocalStorage()): boolean {
  try {
    return storage?.getItem(FIRST_RUN_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist that the user dismissed the checklist. No-op if storage is unavailable. */
export function setDismissed(storage: Storage | undefined = safeLocalStorage()): void {
  try {
    storage?.setItem(FIRST_RUN_DISMISS_KEY, '1');
  } catch {
    /* ignore quota / unavailable storage */
  }
}

/**
 * Forget that the user dismissed the checklist, so Home draws it again (HIVE-4.9, #5303).
 *
 * The Help & docs page's *Get started* card is the only caller: "reopens the getting-started
 * checklist on Home" is what the card promises, and the checklist reads {@link isDismissed}
 * once, when it mounts — so clearing the flag and then navigating to Home is enough to bring
 * it back. Removing the key rather than writing `'0'` keeps one spelling of "not dismissed",
 * which is what {@link isDismissed} tests for.
 *
 * @param storage Where the flag lives. Defaults to `localStorage`; a test passes its own.
 */
export function clearDismissed(storage: Storage | undefined = safeLocalStorage()): void {
  try {
    storage?.removeItem(FIRST_RUN_DISMISS_KEY);
  } catch {
    /* ignore quota / unavailable storage */
  }
}

/** Return localStorage when present (browser), else undefined (SSR / tests without DOM). */
function safeLocalStorage(): Storage | undefined {
  return typeof window !== 'undefined' ? window.localStorage : undefined;
}
