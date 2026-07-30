/**
 * tabStyles — the one definition of what a tab looks like in apiome-ui.
 *
 * Every tab strip in the app is the same thing visually: an underline strip. A bottom rule spans the
 * row, each tab is a label sitting on a transparent 2px border, and the selected tab inks that
 * border and its text in brand indigo. Nothing about a tab looks like a button — no filled pills, no
 * segmented tray, no shadowed "raised" state. Those all read as *actions* rather than *where you
 * are*, and having three different ones in the same product made the same interaction look like
 * three different controls.
 *
 * Consume these instead of hand-writing tab classes:
 *   - Radix-driven strips (`ui/Tabs`, `ui/mcp/DetailTabs`, raw `@radix-ui/react-tabs`) take
 *     {@link TAB_LIST_CLASS} and {@link tabTriggerRadixClass}, which style off `data-[state=active]`.
 *   - Hand-rolled `<button role="tab">` strips take {@link TAB_LIST_CLASS} and
 *     {@link tabTriggerClass}, which take the active/disabled flags directly.
 *   - Route-based strips (tabs that are `next/link` navigations) use {@link tabTriggerClass} too —
 *     drive `active` off `usePathname()`.
 *
 * Genuine *toggles* — JSON/YAML, a list/chart/tree view switch built on `ToggleGroup` — are not tabs
 * and keep their segmented look; the distinction is whether the control names a destination pane or
 * changes how the current pane is drawn.
 */

import { cn } from '@lib/utils';

/** Tab density. `md` is the default; `sm` is for dense chrome (panel headers, file strips). */
export type TabSize = 'sm' | 'md';

/** The tablist container: the bottom rule the tabs' underlines sit on. */
export const TAB_LIST_CLASS =
  'flex flex-wrap items-center gap-1 border-b border-gray-200 dark:border-gray-700';

/** A tablist that must not wrap (a long strip scrolls sideways instead), e.g. open-file tabs. */
export const TAB_LIST_SCROLL_CLASS =
  'flex shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-700';

/** Shared trigger geometry: the transparent underline every tab reserves space for. */
export const TAB_TRIGGER_BASE_CLASS =
  '-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-md border-b-2 ' +
  'border-transparent font-medium transition-colors focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1';

/** Per-size padding and type scale. */
export const TAB_TRIGGER_SIZE_CLASS: Record<TabSize, string> = {
  md: 'px-3.5 py-2.5 text-sm',
  sm: 'px-2.5 py-1.5 text-xs',
};

/** Selected: the underline and label inked in brand indigo. */
export const TAB_TRIGGER_ACTIVE_CLASS =
  'border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400';

/** Unselected: muted label, and the underline previews in gray on hover. */
export const TAB_TRIGGER_IDLE_CLASS =
  'text-gray-600 hover:border-gray-300 hover:text-gray-900 ' +
  'dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200';

/** Unavailable: no underline, no hover, and the pointer says so. */
export const TAB_TRIGGER_DISABLED_CLASS =
  'cursor-not-allowed border-transparent text-gray-400 opacity-50 ' +
  'hover:border-transparent dark:text-gray-600 dark:hover:border-transparent';

/** The pane below the strip. */
export const TAB_PANEL_CLASS =
  'mt-4 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

export interface TabTriggerClassOptions {
  /** Whether this tab is the selected one. */
  active?: boolean;
  /** Whether this tab cannot be selected. */
  disabled?: boolean;
  /** Density (default `md`). */
  size?: TabSize;
  /** Extra classes, merged last so a caller can still override. */
  className?: string;
}

/**
 * The classes for one tab in a hand-rolled (`<button role="tab">` or `<Link>`) strip.
 *
 * @param options Selected/disabled state, density, and any extra classes.
 * @returns The merged class string for the trigger.
 */
export function tabTriggerClass({
  active = false,
  disabled = false,
  size = 'md',
  className,
}: TabTriggerClassOptions = {}): string {
  return cn(
    TAB_TRIGGER_BASE_CLASS,
    TAB_TRIGGER_SIZE_CLASS[size],
    disabled
      ? TAB_TRIGGER_DISABLED_CLASS
      : active
        ? TAB_TRIGGER_ACTIVE_CLASS
        : TAB_TRIGGER_IDLE_CLASS,
    className,
  );
}

/** The same look expressed as Radix `data-[state=…]` variants, for Radix-driven strips. */
export const TAB_TRIGGER_RADIX_STATE_CLASS =
  'data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-600 ' +
  'dark:data-[state=active]:border-indigo-400 dark:data-[state=active]:text-indigo-400 ' +
  'data-[state=inactive]:text-gray-600 data-[state=inactive]:hover:border-gray-300 ' +
  'data-[state=inactive]:hover:text-gray-900 dark:data-[state=inactive]:text-gray-400 ' +
  'dark:data-[state=inactive]:hover:border-gray-600 dark:data-[state=inactive]:hover:text-gray-200 ' +
  'disabled:cursor-not-allowed disabled:border-transparent disabled:text-gray-400 disabled:opacity-50 ' +
  'disabled:hover:border-transparent dark:disabled:text-gray-600';

/**
 * The classes for one trigger in a Radix tabs strip, where selection comes from `data-state`.
 *
 * @param options Density and any extra classes (`active`/`disabled` are ignored — Radix owns them).
 * @returns The merged class string for the trigger.
 */
export function tabTriggerRadixClass({
  size = 'md',
  className,
}: Pick<TabTriggerClassOptions, 'size' | 'className'> = {}): string {
  return cn(
    TAB_TRIGGER_BASE_CLASS,
    TAB_TRIGGER_SIZE_CLASS[size],
    TAB_TRIGGER_RADIX_STATE_CLASS,
    className,
  );
}

/**
 * A tab *rail* — the same ink, turned on its side. A screen with too many sections for one row
 * stacks them in a sidebar on wide viewports and scrolls them as a strip on narrow ones; the ink
 * moves from the bottom edge to the leading edge at `lg` so the selected item still reads as a tab
 * rather than a highlighted button. Colours come from {@link TAB_TRIGGER_RADIX_STATE_CLASS}, which
 * only names a border *colour* and so inks whichever edge the layout exposes.
 */
export const TAB_RAIL_TRIGGER_BASE_CLASS =
  'flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 border-transparent text-left ' +
  'font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-indigo-500 lg:w-full lg:border-b-0 lg:border-l-2';

/**
 * The classes for one trigger in a Radix tab rail (see {@link TAB_RAIL_TRIGGER_BASE_CLASS}).
 *
 * @param options Density and any extra classes.
 * @returns The merged class string for the rail trigger.
 */
export function tabRailTriggerRadixClass({
  size = 'md',
  className,
}: Pick<TabTriggerClassOptions, 'size' | 'className'> = {}): string {
  return cn(
    TAB_RAIL_TRIGGER_BASE_CLASS,
    TAB_TRIGGER_SIZE_CLASS[size],
    TAB_TRIGGER_RADIX_STATE_CLASS,
    className,
  );
}
