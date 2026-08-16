'use client';

import * as React from 'react';
import { cn } from '../../../../lib/utils';

/**
 * Kbd — the Hive shortcut chip (HIVE-2.2, #5281).
 *
 * Authority: `docs/mockups/assets/hive.css` §12 (`.kbd`), `docs/mockups/DESIGN.md` §4.1
 * and §5.4 (menus and buttons carry an optional shortcut chip).
 *
 * The chip is *presentation*. A shortcut is announced by the control it belongs to — a
 * button reads its own label, a menu row reads its command — so the chips render
 * `aria-hidden` and a caller that needs the chord spoken puts the spelling beside them in
 * an `sr-only` span. That split is what makes the "Show keyboard hints" preference safe to
 * honour: `html[data-kbd-hints="off"]` hides `.kbd` / `.kbd-group` in CSS (globals.css),
 * with no component reading the preference and nothing accessible removed with the chip.
 *
 * Both spellings render the same group element, so a single key and a chord lay out
 * identically:
 *
 * ```tsx
 * <Kbd>N</Kbd>
 * <Kbd keys={['⌘', ',']} />
 * ```
 */

/** A key legend: whatever a caller wants drawn inside one chip. */
type KeyLegend = React.ReactNode;

export interface KbdProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  /**
   * The chord, one chip per entry — `['⌘', 'K']`. A single legend may be passed
   * unwrapped, and `children` is the terser spelling of the same thing.
   */
  keys?: KeyLegend | readonly KeyLegend[];
  /** A single legend. Ignored when `keys` is given. */
  children?: KeyLegend;
}

/**
 * Normalise the two spellings into the list of legends to draw.
 *
 * @param keys The `keys` prop, one legend or several.
 * @param children The `children` fallback.
 * @returns One entry per chip, in reading order.
 */
function legendsOf(keys: KbdProps['keys'], children: KbdProps['children']): KeyLegend[] {
  if (keys === undefined || keys === null) return children == null ? [] : [children];
  return Array.isArray(keys) ? [...keys] : [keys];
}

const Kbd = React.forwardRef<HTMLSpanElement, KbdProps>(
  ({ className, keys, children, ...props }, ref) => {
    const legends = legendsOf(keys, children);
    if (legends.length === 0) return null;

    return (
      // `aria-hidden` on the group rather than on each chip: with the preference off the
      // group is `display: none`, and a hidden subtree must not be the only place the
      // shortcut is written down.
      <span ref={ref} className={cn('kbd-group', className)} aria-hidden="true" {...props}>
        {legends.map((legend, index) => (
          <kbd key={index} className="kbd">
            {legend}
          </kbd>
        ))}
      </span>
    );
  }
);
Kbd.displayName = 'Kbd';

export { Kbd };
