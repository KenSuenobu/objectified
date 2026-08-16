'use client';

import * as React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/Tooltip';

/**
 * The two pieces of rail chrome every region shares (HIVE-3.1, #5287).
 *
 * The rail is a stack of rows that all behave the same way — 32 px tall, icon then label,
 * a 5 % ink tint on hover, and a name that moves into a tooltip once the labels are gone.
 * Nav destinations, the workspace row and the footer actions are different components with
 * different jobs, so the sameness lives here rather than being typed three times and
 * drifting apart the first time one of them is touched.
 *
 * `DESIGN.md` §5.2; `docs/mockups/assets/hive.css` §6 (`.nav-item`).
 */

/**
 * A rail row: the metric, the shape and the type.
 *
 * `h-nav-item` is the density-aware token (32 px comfortable, 28 px compact) and
 * `.rail-item` is the unlayered rule in `globals.css` that centres the row when the rail
 * is icon-only — neither is a value this component can freeze.
 */
export const RAIL_ITEM_CLASS =
  'rail-item group/item flex h-nav-item w-full items-center gap-2.5 rounded-md px-2.5 ' +
  'text-sm font-medium transition-colors duration-[var(--dur-fast)]';

/**
 * Hover: a 5 % tint of the theme's *own* ink.
 *
 * Mixed rather than named so it lands correctly on all nine palettes — a fixed grey would
 * be invisible on the dark themes and muddy on the warm light ones.
 */
export const RAIL_ITEM_HOVER_CLASS =
  'hover:bg-[color-mix(in_srgb,var(--fg)_5%,transparent)] hover:text-fg';

/** Props for {@link RailTooltip}. */
export interface RailTooltipProps {
  /** What the tooltip says. No tooltip is rendered when this is empty. */
  label?: string | null;
  /**
   * Whether the tooltip is wanted at all — normally "is the rail icon-only".
   *
   * A tooltip that repeats a label the reader can already see is noise on every hover, so
   * the expanded rail deliberately has none except where the row has something *extra* to
   * say (a gated destination's reason).
   */
  when: boolean;
  /** The row the tooltip describes. Must accept a ref: Radix anchors to it. */
  children: React.ReactElement;
}

/**
 * Wrap a rail row in the Hive ink-pill tooltip, but only when it is needed.
 *
 * Radix opens the tooltip on hover *and* on keyboard focus, which is what makes an icon
 * rail usable without a mouse (`DESIGN.md` §9) — the collapsed rail would otherwise be a
 * column of unlabelled glyphs to anyone tabbing through it.
 *
 * @param props See {@link RailTooltipProps}.
 * @returns The row, tooltipped or untouched.
 */
export function RailTooltip({ label, when, children }: RailTooltipProps) {
  if (!when || !label) return children;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
