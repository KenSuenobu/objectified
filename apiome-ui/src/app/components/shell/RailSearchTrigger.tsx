'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import { Kbd } from '@/app/components/ui/Kbd';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import { cn } from '@lib/utils';
import {
  isCommandPaletteMounted,
  openCommandPalette,
  subscribeCommandPalette,
} from './commandPaletteBus';
import { RailTooltip } from './railChrome';

/**
 * The rail's search trigger — `AppShell` region 3 (HIVE-3.6, #5292).
 *
 * `docs/mockups/assets/hive.css` §6 (`.search-trigger`) draws it as a *field*, not a nav
 * row: an inset hairline, a surface fill and a `⌘K` chip pushed to the right edge. That is
 * deliberate — it is the one row in the rail that opens a search rather than going
 * somewhere, and it reads as somewhere to type even though it is a button.
 *
 * It is a button and not an input because nothing is typed here: the field the reader types
 * into is the palette's own, which is what makes the trigger and the chord the same gesture.
 *
 * The row renders nothing at all when no palette host is mounted. That is the case
 * `commandPaletteBus.ts` reserves it for — a rail on a surface with no palette (the admin
 * console) should not offer a control that does nothing.
 */

/** Props for {@link RailSearchTrigger}. */
export interface RailSearchTriggerProps {
  /** Whether the rail is drawing icon-only, in which case the label moves to a tooltip. */
  iconRail: boolean;
}

/** What the row promises, and the whole of its accessible name in the icon rail. */
const TRIGGER_LABEL = 'Search or jump to…';

/**
 * The rail's search trigger.
 *
 * @param props See {@link RailSearchTriggerProps}.
 * @returns The 34 px field-shaped button, or nothing when no palette is mounted.
 */
export default function RailSearchTrigger({ iconRail }: RailSearchTriggerProps) {
  // Subscribed rather than read once. Hosts register in an effect, and effects commit
  // child-first: this row is inside the rail and `AppShell` mounts the host after it, so a
  // one-shot read on mount would answer "no palette" for ever. The server snapshot is
  // `false` — nothing is mounted during SSR — so the row appears on hydration rather than
  // being painted and taken away.
  const available = React.useSyncExternalStore(
    subscribeCommandPalette,
    isCommandPaletteMounted,
    () => false
  );

  if (!available) return null;

  return (
    <RailTooltip label={`${TRIGGER_LABEL} (⌘K)`} when={iconRail}>
      <button
        type="button"
        onClick={() => openCommandPalette()}
        data-testid="rail-search"
        className={cn(
          // `min-h-9` rather than a fixed 34 px: the row carries type, so it grows with the
          // font-size preference instead of clipping it (HIVE-1.6).
          'rail-item flex min-h-9 w-full items-center gap-2 rounded-md border border-border',
          // `--fg-muted`, not the mockup's `--fg-subtle`: this is quiet text a reader
          // has to read, and `--fg-subtle` measures 2.8–4.0:1 on the rail in every
          // theme (the finding HIVE-3.3 and HIVE-3.5 both landed on).
          'bg-surface px-2.5 text-sm text-fg-muted shadow-xs',
          'transition-colors duration-[var(--dur-fast)]',
          'hover:border-border-strong hover:text-fg'
        )}
      >
        <Search
          size={ICON_SIZE.rail}
          strokeWidth={ICON_STROKE_WIDTH}
          aria-hidden
          className="shrink-0"
        />
        {/* In the icon rail CSS takes the label away, leaving this as the button's whole
            accessible name — so it is written here rather than only in the tooltip. */}
        <span className="sr-only">{TRIGGER_LABEL}</span>
        <span className="rail-label min-w-0 flex-1 items-center justify-between gap-2">
          <span aria-hidden className="truncate">
            {TRIGGER_LABEL}
          </span>
          <Kbd keys={['⌘', 'K']} />
        </span>
      </button>
    </RailTooltip>
  );
}
