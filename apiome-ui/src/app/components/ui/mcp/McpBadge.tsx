'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../../../lib/utils';
import { STATUS_TONE_SOFT_CLASS } from '../statusVocabulary';
import type { McpBadgeTone } from '../../ade/dashboard/mcp/mcpUiPrimitives';

/**
 * The seven-tone MCP badge — a soft tinted fill with the ink chosen to stay legible on it, used
 * for transport, visibility, auth-scheme and capability-annotation chips. {@link McpBadgeTone}
 * keeps the tones in lockstep with the resolver helpers in `mcpUiPrimitives`
 * (e.g. `mcpTransportBadge`), so a screen passes a domain value through a resolver and renders
 * the result here without choosing colours itself.
 *
 * ### Since HIVE-7.7 (#5324) the seven tones are the vocabulary's
 *
 * They used to be seven pairs of Tailwind palette classes — `bg-indigo-50 text-indigo-700
 * border-indigo-100 dark:bg-indigo-900/30 …` and six more like it. That froze the chip on one
 * light palette and one dark one, so on the seven themes that are neither (Nord, Solarized,
 * Darcula, Blueprint, Whiteboard, High contrast, and the system default resolving to either) a
 * transport chip was painted from a palette the rest of the card had never heard of.
 *
 * Each tone now names its place in `ui/statusVocabulary` — `green` *is* `ok`, `red` *is*
 * `danger`, `slate` *is* `neutral` — and takes that tone's `-soft` fill and `-fg` ink, the pair
 * calibrated to clear AA together in all nine appearances. The tone *names* are unchanged
 * because ~40 call sites and four suites spell them, and because they are the mockup's own
 * `.badge--*` names; only what they resolve to has moved.
 *
 * The hairline border is gone with the palette: a `-soft` fill is already a distinct ground, and
 * a border drawn from a *third* colour was the part that could not be made to hold across nine
 * themes. `Badge` — the app-wide pill this one mirrors — has never drawn one either.
 *
 * Two of the seven land on the same tone, deliberately. DESIGN.md §0 retires indigo in favour of
 * one azure accent, so `indigo` and `blue` — the two "informational, not a state" hues the old
 * palette spent — are both `accent` now. Nothing is lost by it: the pair never distinguished two
 * values inside one chip row, and where both appear on a screen (a snapshot's provenance strip:
 * *manual run* against *added via import*) each chip says in words which it is. Colour was never
 * carrying that difference to a reader who cannot separate two blues.
 */
const mcpBadgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
  {
    variants: {
      /**
       * The tone, named as the MCP surface has always named it and resolved through the shared
       * vocabulary. `indigo` is the pre-Hive name for what the design language calls *accent*.
       */
      tone: {
        indigo: STATUS_TONE_SOFT_CLASS.accent,
        green: STATUS_TONE_SOFT_CLASS.ok,
        amber: STATUS_TONE_SOFT_CLASS.warn,
        red: STATUS_TONE_SOFT_CLASS.danger,
        blue: STATUS_TONE_SOFT_CLASS.accent,
        slate: STATUS_TONE_SOFT_CLASS.neutral,
        violet: STATUS_TONE_SOFT_CLASS.violet,
      },
    },
    defaultVariants: {
      tone: 'slate',
    },
  },
);

export interface McpBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof mcpBadgeVariants> {
  /** Semantic tone (kept null-safe: an absent tone falls back to the neutral slate default). */
  tone?: McpBadgeTone;
  /** Optional leading glyph (e.g. a small lucide icon or a status dot). */
  icon?: React.ReactNode;
}

export const McpBadge = React.forwardRef<HTMLSpanElement, McpBadgeProps>(
  ({ className, tone, icon, children, ...props }, ref) => {
    return (
      <span ref={ref} className={cn(mcpBadgeVariants({ tone }), className)} {...props}>
        {icon ? (
          <span className="inline-flex shrink-0 items-center" aria-hidden>
            {icon}
          </span>
        ) : null}
        {children}
      </span>
    );
  },
);
McpBadge.displayName = 'McpBadge';

export { mcpBadgeVariants };
