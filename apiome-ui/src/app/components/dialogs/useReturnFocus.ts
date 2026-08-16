'use client';

import * as React from 'react';

/**
 * Hand focus back to whatever opened the dialog (HIVE-2.7, #5286).
 *
 * The cross-cutting definition of done asks for focus "restored on close", and Radix does
 * that for itself — but only for a dialog opened by a `Dialog.Trigger`. Its `Content`
 * *prevents* `FocusScope`'s own restore and focuses `context.triggerRef` instead, and an
 * imperative `await confirm({…})` has no trigger to point that ref at: the row-action button
 * that asked the question is not part of the dialog's tree. The result is focus landing on
 * `<body>`, which for a keyboard reader means starting the page again from the top.
 *
 * So the origin is captured here instead, and handed back here.
 *
 * The capture is a **layout** effect on purpose: React runs every layout effect before any
 * passive one, and Radix moves focus into the dialog from a passive effect — so this reads
 * `document.activeElement` while it is still the button the reader pressed.
 */

/** `useLayoutEffect` in the browser, `useEffect` on the server — the SSR-safe spelling. */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

/**
 * Remember the focused element while `open` is true, and give back a handler that restores it.
 *
 * @param open Whether the dialog is showing.
 * @returns A handler for Radix's `onCloseAutoFocus`. It prevents the default so Radix's own
 *   trigger-based restore — which would aim at nothing — does not run instead.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  const originRef = React.useRef<HTMLElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    originRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  return React.useCallback((event: Event) => {
    event.preventDefault();
    const origin = originRef.current;
    // A row action can be gone by the time its dialog closes — the row it lived in was just
    // deleted. Focus then stays where the browser puts it rather than throwing.
    if (origin?.isConnected) origin.focus();
  }, []);
}
