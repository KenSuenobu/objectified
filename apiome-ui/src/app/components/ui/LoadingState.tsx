'use client';

import * as React from 'react';

import { cn } from '../../../../lib/utils';
import { Spinner, type SpinnerProps } from './Spinner';

/**
 * LoadingState — the region that says "this is on its way" (HIVE-2.5, #5284).
 *
 * Authority: `docs/mockups/DESIGN.md` §8 (*"Loading = skeletons shaped like the final
 * content"*) and §9 (*"live regions for save state and async jobs"*).
 *
 * ### Two jobs, one component
 *
 * A loading region has to do two unrelated things, and the app was doing only the first:
 *
 * 1. **Hold the space.** Pass `skeleton` and the region draws it — the shape of what is
 *    coming, so the arrival is a fill rather than a jump. Without it the region falls back
 *    to a centred {@link Spinner}, which DESIGN.md reserves for work whose result has no
 *    shape yet: a request in flight, a button saving, a job with no known length.
 * 2. **Say so.** The region is `role="status"` with `aria-live="polite"` and `aria-busy`,
 *    so a screen reader hears "Loading projects…" once, when it starts — rather than being
 *    told nothing at all, which is what a bare `<Spinner/>` in a `<div>` amounts to.
 *
 * ```tsx
 * // A list whose shape is known:
 * <LoadingState message="Loading repositories…" skeleton={<SkeletonCardGrid count={6} />} />
 *
 * // Work with no shape:
 * <LoadingState message="Publishing version 2.4.0…" />
 * ```
 *
 * The message is *always* rendered for assistive technology, even when it is hidden from
 * sight: a skeleton is decoration, so without the sentence the region would announce
 * nothing.
 */

export interface LoadingStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * What is loading, as a sentence — `"Loading repositories…"`.
   *
   * DESIGN.md §10: name the thing. `"Loading…"` is what the region says when the caller
   * could not be bothered, and it is what a screen reader is left with.
   */
  message?: string;
  /**
   * The placeholder to draw — a `Skeleton` preset shaped like the content.
   *
   * When given, it replaces the spinner *and* the visible message: the shape is the
   * explanation, and a sentence under it would be one more thing to re-read on every load.
   * The message stays in the live region, visually hidden.
   */
  skeleton?: React.ReactNode;
  /** Minimum height of the spinner form, so a short region does not collapse. */
  minHeightClassName?: string;
  /** Size of the spinner. Ignored when `skeleton` is given. */
  spinnerSize?: SpinnerProps['size'];
}

/**
 * The loading region.
 *
 * @param props See {@link LoadingStateProps}.
 * @returns A polite live region containing either the placeholder or a spinner.
 */
export const LoadingState = React.forwardRef<HTMLDivElement, LoadingStateProps>(
  (
    {
      className,
      message = 'Loading…',
      skeleton,
      minHeightClassName = 'min-h-70',
      spinnerSize = 'lg',
      ...props
    },
    ref
  ) => (
    <div
      ref={ref}
      // `role="status"` is a polite live region, and `aria-busy` is what tells assistive
      // technology the subtree is mid-change rather than merely sparse.
      role="status"
      aria-live="polite"
      aria-busy
      className={cn(
        skeleton ? 'w-full' : cn('flex items-center justify-center', minHeightClassName),
        className
      )}
      {...props}
    >
      {skeleton ? (
        <>
          {skeleton}
          <span className="sr-only">{message}</span>
        </>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center">
          {/* The spinner's own `role="status"` would be a second live region inside this
              one, and the pair announce twice. The region speaks; the ring is decoration. */}
          <Spinner size={spinnerSize} role={undefined} aria-label={undefined} aria-hidden />
          <p className="text-sm text-fg-muted">{message}</p>
        </div>
      )}
    </div>
  )
);
LoadingState.displayName = 'LoadingState';
