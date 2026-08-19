'use client';

import * as React from 'react';
import { cn } from '../../../../../lib/utils';
import {
  mcpHealthFromDiscoveryStatus,
  mcpHealthMeta,
  type McpHealthStatus,
} from '../../ade/dashboard/mcp/mcpUiPrimitives';

export interface HealthPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Explicit health state. Provide this OR {@link discoveryStatus} (this wins when both given). */
  status?: McpHealthStatus;
  /** Raw discovery status to derive the health state from (e.g. `ok` / `degraded` / `failed`). */
  discoveryStatus?: string | null;
  /** Hide the text label, leaving just the colored status dot (e.g. in dense table cells). */
  dotOnly?: boolean;
}

/**
 * `<HealthPill>` — an endpoint's reachability as a dot + label: `Healthy` (green), `Degraded`
 * (amber), `Unreachable` (red), or `Unknown` (neutral) before the first discovery. Pass an
 * explicit {@link HealthPillProps.status}, or a raw {@link HealthPillProps.discoveryStatus} to
 * have it resolved. All colours come from {@link mcpHealthMeta} — no literals in consumers.
 *
 * Since HIVE-2.4 (#5283) those colours are the shared status vocabulary's, so a degraded endpoint
 * is the same amber as a degraded anything-else, and the pill writes `data-status` for the same
 * reason `Badge` does — a page can style or query the state without re-deriving it.
 *
 * ### Why the labelled form is a tinted pill (HIVE-7.7, #5324)
 *
 * It used to be the tone's `-fg` ink drawn straight onto whatever was behind it. Only `:root` and
 * `[data-theme="dark"]` recalibrate the semantic `-soft`/`-fg` pairs; the other six themes inherit
 * the *light* inks, so `--ok-fg` on a card measures 3.21:1 in High contrast, 2.32:1 in Blueprint
 * and 1.99:1 in Solarized — and axe flagged every health pill on the MCP catalog at once.
 *
 * A `-fg` ink is legible on its own `-soft` ground and nowhere else, which is exactly what
 * `.badge[data-status]` is in `hive.css` §11 and what `sources/mcp-servers.html` draws here
 * (`<span class="badge badge--dot" data-status="healthy">`). So the labelled pill wears the pair.
 *
 * `dotOnly` is unchanged: a bare saturated swatch with its label in the accessibility tree, for
 * the dense-list row where a second filled pill would out-shout the endpoint's name.
 */
export const HealthPill = React.forwardRef<HTMLSpanElement, HealthPillProps>(
  ({ status, discoveryStatus, dotOnly = false, className, ...props }, ref) => {
    const resolved: McpHealthStatus = status ?? mcpHealthFromDiscoveryStatus(discoveryStatus);
    const meta = mcpHealthMeta(resolved);
    return (
      <span
        ref={ref}
        data-status={meta.status}
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-medium',
          dotOnly ? meta.textClass : cn('rounded-full px-2 py-0.5', meta.softClass),
          className,
        )}
        title={dotOnly ? meta.label : undefined}
        {...props}
      >
        <span
          className={cn(
            'inline-block h-2 w-2 shrink-0 rounded-full',
            // Inside the tinted pill the dot is the label's own ink; alone it is the saturated
            // role colour, which is the only step that reads as a swatch on a plain surface.
            dotOnly ? meta.dotClass : 'bg-current',
          )}
          aria-hidden
        />
        {dotOnly ? <span className="sr-only">{meta.label}</span> : meta.label}
      </span>
    );
  },
);
HealthPill.displayName = 'HealthPill';
