'use client';

import { useSyncExternalStore } from 'react';
import { usePreferences } from '@/app/providers/PreferencesProvider';

/**
 * Whether the rail is currently icon-only (HIVE-3.1, #5287).
 *
 * The *look* of the collapsed rail is pure CSS — `globals.css` swaps `--rail-w-current`
 * and `--rail-label-display` from `html[data-rail="collapsed"]` and from the 900 px media
 * query, so a device that chose the icon rail never paints the expanded one first. Nothing
 * here is needed to draw it.
 *
 * What React still has to know is whether a **tooltip** is the only place a destination's
 * name is written: an icon with a visible label beside it must not also announce that
 * label on hover. That is a behavioural question, it is only asked after hydration, and it
 * has two independent inputs — the stored preference and the viewport — so it lives here.
 *
 * @see globals.css § "Application shell and rail" — the CSS half of the same rule.
 */

/**
 * Viewport below which the rail is forced to icon mode, in CSS pixels.
 *
 * `DESIGN.md` §5.2 (and the mockup's Responsive note): under 900 px the rail keeps its
 * destinations but drops their labels. The same number is written once in `globals.css`;
 * `tests/app-shell-css.test.ts` fails if the two drift.
 */
export const RAIL_ICON_BREAKPOINT_PX = 900;

/** The media query the CSS uses, restated for `matchMedia`. */
const ICON_RAIL_QUERY = `(max-width: ${RAIL_ICON_BREAKPOINT_PX}px)`;

/**
 * Subscribe to viewport changes across the icon-rail breakpoint.
 *
 * @param listener Called when the viewport crosses the breakpoint.
 * @returns The unsubscribe function.
 */
function subscribeNarrowViewport(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};

  const media = window.matchMedia(ICON_RAIL_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

/**
 * Is the viewport narrower than the icon-rail breakpoint right now?
 *
 * @returns True below 900 px; false where the query cannot be asked at all.
 */
function narrowViewportSnapshot(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(ICON_RAIL_QUERY).matches
  );
}

/**
 * The value the server renders: there is no viewport to measure.
 *
 * @returns `false`.
 */
function serverNarrowViewportSnapshot(): boolean {
  return false;
}

/**
 * Whether the rail is rendering icon-only.
 *
 * @returns True when the reader collapsed the rail *or* the viewport forces icon mode.
 */
export function useIconRail(): boolean {
  const { preferences } = usePreferences();
  const narrowViewport = useSyncExternalStore(
    subscribeNarrowViewport,
    narrowViewportSnapshot,
    serverNarrowViewportSnapshot
  );

  return preferences.rail === 'collapsed' || narrowViewport;
}
