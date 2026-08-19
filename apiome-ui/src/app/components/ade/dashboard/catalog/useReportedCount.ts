'use client';

/**
 * Report a lazily-loaded pane's count back to the tab strip (HIVE-7.2, #5319).
 *
 * `sources/catalog-item.html` puts a count chip on three of the eight tabs — Conversions,
 * Lint & score and Versions — and all three panes fetch *lazily*, on first activation. So the
 * count cannot come from the shell: it does not exist until the reader has opened the pane.
 *
 * This is the one seam that carries it back. A pane calls it with what it has loaded; the
 * effect fires only once the pane is `loaded` and only when the number actually changes, so a
 * re-render never pushes an identical value up through the shell's state.
 *
 * The distinction the shell relies on is that **`0` is a count and "not loaded" is not**: the
 * hook stays silent until `loaded`, which is what lets the tab draw no chip at all before the
 * pane has been opened, and "Conversions 0" after it has.
 *
 * @param loaded Whether the pane's fetch has completed. `false` reports nothing.
 * @param count What it loaded.
 * @param onCountChange The shell's setter, when one was wired.
 */

import { useEffect } from 'react';

export function useReportedCount(
  loaded: boolean,
  count: number,
  onCountChange?: (count: number) => void,
): void {
  useEffect(() => {
    if (!loaded || !onCountChange) return;
    onCountChange(count);
  }, [loaded, count, onCountChange]);
}
