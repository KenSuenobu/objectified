/**
 * Fixed-height row windowing for long lists (IXH-2.2, #5097).
 *
 * A lint report can carry thousands of findings; mounting a DOM node per finding makes the import
 * wizard's quality step janky and its keyboard navigation slow. Above a bounded count the list
 * renders only the rows that can be on screen, padded top and bottom by two spacer elements so the
 * scrollbar keeps its true length.
 *
 * Deliberately dependency-free and pure: a scroll offset in, a row range out. The component owns the
 * scroll listener and the spacers; this module owns the arithmetic, so the windowing rules are
 * testable without a layout engine (jsdom reports every height as 0).
 */

/** The slice of rows to mount, and the spacer heights that stand in for the rest. */
export interface WindowedRange {
  /** Index of the first mounted row (inclusive). */
  startIndex: number;
  /** Index one past the last mounted row. */
  endIndex: number;
  /** Pixel height of the spacer above the mounted rows. */
  paddingTop: number;
  /** Pixel height of the spacer below the mounted rows. */
  paddingBottom: number;
}

export interface WindowedRangeInput {
  /** Total number of rows in the list. */
  rowCount: number;
  /** Uniform row height in pixels. */
  rowHeight: number;
  /** Height of the scrolling viewport in pixels. */
  viewportHeight: number;
  /** Current scroll offset of the viewport in pixels. */
  scrollTop: number;
  /** Extra rows mounted above and below the viewport, so scrolling does not flash blank. */
  overscan?: number;
}

/**
 * Compute the rows to mount for a scroll position.
 *
 * @param input Row count/height, viewport height, scroll offset, and optional overscan.
 * @returns The mounted range plus the spacer heights. Degenerate inputs (no rows, non-positive row
 *   height, or a viewport jsdom reports as 0) mount **everything** — correctness before
 *   virtualization, so a list is never silently truncated by a bad measurement.
 */
export function computeWindowedRange({
  rowCount,
  rowHeight,
  viewportHeight,
  scrollTop,
  overscan = 4,
}: WindowedRangeInput): WindowedRange {
  if (rowCount <= 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 };
  }
  if (rowHeight <= 0 || viewportHeight <= 0) {
    return { startIndex: 0, endIndex: rowCount, paddingTop: 0, paddingBottom: 0 };
  }
  const safeScrollTop = Math.max(0, scrollTop);
  const visibleRows = Math.ceil(viewportHeight / rowHeight);
  const startIndex = Math.max(0, Math.floor(safeScrollTop / rowHeight) - overscan);
  const endIndex = Math.min(rowCount, startIndex + visibleRows + overscan * 2);
  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * rowHeight,
    paddingBottom: (rowCount - endIndex) * rowHeight,
  };
}

/**
 * Clamp a row index into `[0, rowCount)`, for roving keyboard focus at the list edges.
 *
 * @returns The clamped index, or `null` when the list is empty (nothing can hold focus).
 */
export function clampRowIndex(index: number, rowCount: number): number | null {
  if (rowCount <= 0) return null;
  if (index < 0) return 0;
  if (index >= rowCount) return rowCount - 1;
  return index;
}
