'use client';

import * as React from 'react';
import { cn } from '../../../../../lib/utils';
import { mcpFreshnessMeta } from '../../ade/dashboard/mcp/mcpUiPrimitives';

export interface FreshnessPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Freshness label from browse/report (`stale` / `failing` / `backoff` / `quarantined`). */
  freshness: string | null | undefined;
  /** Optional last-known-good timestamp for the title tooltip. */
  lastKnownGoodAt?: string | null;
  /** Hide the text label, leaving just the colored status dot. */
  dotOnly?: boolean;
}

/**
 * `<FreshnessPill>` — catalog staleness as a colored dot + label. Renders nothing when the endpoint
 * is `fresh` (healthy and within cadence).
 *
 * Since HIVE-2.4 (#5283) the tone comes from the shared status vocabulary — `stale`/`backoff` are
 * the vocabulary's warn, `failing`/`quarantined` its danger — so staleness reads the same as every
 * other warning in the product.
 */
export const FreshnessPill = React.forwardRef<HTMLSpanElement, FreshnessPillProps>(
  ({ freshness, lastKnownGoodAt, dotOnly = false, className, ...props }, ref) => {
    const meta = mcpFreshnessMeta(freshness);
    if (!meta) return null;

    const title = lastKnownGoodAt
      ? `${meta.label} — last known good ${lastKnownGoodAt}`
      : meta.label;

    return (
      <span
        ref={ref}
        data-status={meta.status}
        className={cn('inline-flex items-center gap-1.5 text-xs font-medium', meta.textClass, className)}
        title={title}
        {...props}
      >
        <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', meta.dotClass)} aria-hidden />
        {dotOnly ? <span className="sr-only">{meta.label}</span> : meta.label}
      </span>
    );
  },
);
FreshnessPill.displayName = 'FreshnessPill';
