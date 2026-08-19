'use client';

import * as React from 'react';
import { cn } from '../../../../../../lib/utils';

/**
 * Token-driven SVG chart kit — shared accessible frame (V2-MCP-28.3 / MCAT-14.3).
 *
 * Every chart primitive wraps its SVG in `<ChartFrame>`, which owns the three concerns that would
 * otherwise be re-implemented (and drift) per chart:
 *
 * 1. **Accessibility.** The frame is a `<figure>` labelled by `title`; the SVG carries `role="img"`
 *    plus a `<title>`/`<desc>`, and — when the consumer provides `tableFallback` — a visually hidden
 *    (`sr-only`) data table so screen-reader / no-CSS users get the numbers, not just a shape.
 * 2. **Empty data.** When `isEmpty` is set the SVG is skipped entirely and a small, still-labelled
 *    empty state renders instead — the acceptance criterion "empty-data renders an empty state, not
 *    a crash" lives here so no individual chart has to guard.
 * 3. **Responsiveness.** The SVG is sized by `viewBox` and stretches to its container; consumers set
 *    height via `className`.
 *
 * SSR-safe: no DOM/`window` access and no non-deterministic ids (gradient ids are derived from a
 * `React.useId()` in the consumer when needed).
 */
export interface ChartFrameProps {
  /** Accessible name for the whole figure and the SVG (`aria-label` + `<title>`). Required. */
  title: string;
  /** Longer description rendered as the SVG `<desc>` (e.g. the value summary). */
  description?: string;
  /** The SVG `viewBox` (e.g. `"0 0 120 40"`). */
  viewBox: string;
  /** `preserveAspectRatio` for the SVG; defaults to `xMidYMid meet`. */
  preserveAspectRatio?: string;
  /** Whether the data is empty — renders the empty state instead of the SVG. */
  isEmpty?: boolean;
  /** Label shown in the empty state; defaults to "No data". */
  emptyLabel?: string;
  /**
   * A visually-hidden tabular representation of the data for assistive tech. Render a `<table>`
   * (or any semantic node) with the underlying numbers; it is placed in an `sr-only` container.
   */
  tableFallback?: React.ReactNode;
  /** Extra classes for the wrapping `<figure>` (typically height, e.g. `h-40 w-full`). */
  className?: string;
  /** Extra classes for the `<svg>` element. */
  svgClassName?: string;
  /**
   * Whether the chart hosts interactive marks (focusable/clickable children, e.g. a
   * {@link StackedTimeline} with `onSelectPeriod`). A `role="img"` makes an SVG's subtree
   * presentational, so its interactive children are hidden from assistive tech; when `interactive`
   * is set the frame uses `role="group"` instead so those controls are reachable, while the
   * `aria-label` and the `sr-only` data table still describe the whole figure.
   */
  interactive?: boolean;
  /** The SVG mark content. */
  children?: React.ReactNode;
}

/**
 * The accessible, empty-aware wrapper shared by every chart primitive. See {@link ChartFrameProps}.
 */
export function ChartFrame({
  title,
  description,
  viewBox,
  preserveAspectRatio = 'xMidYMid meet',
  isEmpty = false,
  emptyLabel = 'No data',
  tableFallback,
  className,
  svgClassName,
  interactive = false,
  children,
}: ChartFrameProps) {
  if (isEmpty) {
    return (
      <figure
        role="img"
        aria-label={`${title}: ${emptyLabel}`}
        className={cn(
          'flex items-center justify-center rounded-lg border border-dashed border-border-strong bg-subtle text-xs font-medium text-fg-muted',
          className,
        )}
      >
        {emptyLabel}
      </figure>
    );
  }

  return (
    <figure className={cn('relative m-0', className)}>
      <svg
        viewBox={viewBox}
        preserveAspectRatio={preserveAspectRatio}
        role={interactive ? 'group' : 'img'}
        aria-label={title}
        className={cn('h-full w-full overflow-visible', svgClassName)}
      >
        <title>{title}</title>
        {description ? <desc>{description}</desc> : null}
        {children}
      </svg>
      {tableFallback ? <div className="sr-only">{tableFallback}</div> : null}
    </figure>
  );
}
