'use client';

import { useEffect } from 'react';

/**
 * Ask the browser to confirm before an unsaved draft is thrown away by leaving the tab.
 *
 * Three screens now hold an editable draft that only exists in memory until it is saved —
 * the style-guide editor, its custom-rules tab, and the roles matrix (HIVE-5.3, #5306) — and
 * each had written the same nine-line effect. Written once, the registration cannot be
 * subtly different in one of them: the listener is attached *only* while the draft is dirty,
 * so a clean page never pays the cost of one and never trips the browser's own heuristics
 * about pages that always block unload.
 *
 * ### What this can and cannot catch
 *
 * `beforeunload` fires for a reload, a close, and a navigation that leaves the document. It
 * does **not** fire for an in-app route change, because the App Router never leaves the
 * document — there is no supported interception point for that in Next 16. A screen that
 * needs to guard an in-app move has to guard the move itself, which is what the roles page's
 * own switch confirm does.
 *
 * Modern browsers ignore any custom message and show their own, so none is offered here; the
 * two lines below are the pair every engine still recognises as "please ask".
 *
 * @param dirty Whether there is unsaved work. The listener is attached only while this is
 *   true, and removed as soon as it is not.
 */
export function useUnsavedChangesPrompt(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
