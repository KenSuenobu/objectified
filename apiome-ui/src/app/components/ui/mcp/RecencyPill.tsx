'use client';

import * as React from 'react';
import { Clock } from 'lucide-react';
import { cn } from '../../../../../lib/utils';
import { mcpRelativeTime } from '../../ade/dashboard/mcp/mcpUiPrimitives';

export interface RecencyPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** ISO-8601 instant to describe (e.g. the endpoint's `last_discovered_at`). */
  timestamp: string | null | undefined;
  /** Leading label before the relative time (default `Last discovered`). */
  prefix?: string;
  /**
   * Current time in epoch ms, injected for deterministic rendering/tests. Defaults to "now".
   * Reading the clock at render time is intentional and safe in the browser runtime.
   */
  nowMs?: number;
  /** Hide the leading clock icon. */
  hideIcon?: boolean;
}

/**
 * `<RecencyPill>` — the "Last discovered …" recency chip: a clock icon + a short relative span
 * (`just now` / `5m ago` / `2h ago` / `3d ago`), falling back to an absolute date for old or absent
 * timestamps. The relative formatting is delegated to {@link mcpRelativeTime} so it is unit-tested
 * deterministically.
 */
export const RecencyPill = React.forwardRef<HTMLSpanElement, RecencyPillProps>(
  ({ timestamp, prefix = 'Last discovered', nowMs, hideIcon = false, className, ...props }, ref) => {
    // `nowMs` is optional; mcpRelativeTime supplies the wall clock by default (kept out of the
    // component body so render stays pure for the React compiler).
    const relative = mcpRelativeTime(timestamp, nowMs);
    return (
      <span
        ref={ref}
        className={cn(
          // `text-fg-muted` rather than a grey from the palette (HIVE-2.4, #5283): recency is
          // supporting text, and the token keeps it that way on every theme. The quieter
          // `--fg-subtle` step would not clear AA at this size.
          'inline-flex items-center gap-1.5 text-xs font-medium text-fg-muted',
          className,
        )}
        {...props}
      >
        {hideIcon ? null : <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        <span>
          {prefix} {relative}
        </span>
      </span>
    );
  },
);
RecencyPill.displayName = 'RecencyPill';
