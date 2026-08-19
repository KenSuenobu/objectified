/**
 * tabStyles — the one definition of what a tab looks like in apiome-ui.
 *
 * Every tab strip in the app is the same thing visually: an underline strip. A bottom rule spans the
 * row, each tab is a label sitting on a transparent 2px border, and the selected tab inks that
 * border and its text. Nothing about a tab looks like a button — no filled pills, no segmented
 * tray, no shadowed "raised" state. Those all read as *actions* rather than *where you are*, and
 * having three different ones in the same product made the same interaction look like three
 * different controls.
 *
 * Re-tokened by HIVE-2.1 (#5280) against `docs/mockups/assets/hive.css` §10 and
 * `docs/mockups/DESIGN.md` §7: the ink is now `--fg` rather than brand indigo, heights come from
 * the density-aware `--control-h*` metrics, and two further shapes from the mockups are available
 * — `pills` and `vertical`. The module was kept (rather than replaced, as the ticket's scope list
 * puts it) precisely because 29 surfaces import these constants: re-pointing them is what lets the
 * whole app change look without a single consumer edit.
 *
 * Consume these instead of hand-writing tab classes:
 *   - Radix-driven strips (`ui/Tabs`, `ui/mcp/DetailTabs`, raw `@radix-ui/react-tabs`) take
 *     {@link tabListClass} and {@link tabTriggerRadixClass}, which style off `data-[state=active]`.
 *   - Hand-rolled `<button role="tab">` strips take {@link tabListClass} and
 *     {@link tabTriggerClass}, which take the active/disabled flags directly.
 *   - Route-based strips (tabs that are `next/link` navigations) use {@link tabTriggerClass} too —
 *     drive `active` off `usePathname()`.
 *   - A count beside a tab label is {@link TAB_COUNT_CLASS}.
 *
 * Genuine *toggles* — JSON/YAML, a list/chart/tree view switch built on `ToggleGroup` — are not tabs
 * and keep their segmented look; the distinction is whether the control names a destination pane or
 * changes how the current pane is drawn.
 */

import { cn } from '@lib/utils';

/** Tab density. `md` is the default; `sm` is for dense chrome (panel headers, file strips). */
export type TabSize = 'sm' | 'md';

/**
 * Tab shape.
 *
 * - `underline` — the default, and what a page's primary sections use.
 * - `pills` — a filled chip for the selected item; for a secondary, in-panel switch where there is
 *   no rule to underline (hive.css `.tabs--pills`).
 * - `vertical` — the same tabs stacked in a column, selection shown as a tinted row
 *   (hive.css `.vtabs`); for a settings-style rail of sections.
 */
export type TabVariant = 'underline' | 'pills' | 'vertical';

/** The tablist container: the bottom rule the tabs' underlines sit on. */
export const TAB_LIST_CLASS = 'flex flex-wrap items-end gap-0.5 border-b border-border';

/** A tablist that must not wrap (a long strip scrolls sideways instead), e.g. open-file tabs. */
export const TAB_LIST_SCROLL_CLASS =
  'flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border';

/** The `pills` tablist: no rule, a little more air between chips. */
export const TAB_LIST_PILLS_CLASS = 'flex flex-wrap items-center gap-1';

/** The `vertical` tablist: a column of rows, no rule. */
export const TAB_LIST_VERTICAL_CLASS = 'flex flex-col gap-0.5';

/** Shared trigger geometry: the transparent underline every tab reserves space for. */
export const TAB_TRIGGER_BASE_CLASS =
  '-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-sm border-b-2 ' +
  'border-transparent font-medium transition-colors duration-[var(--dur-fast)] ' +
  'focus-visible:outline-none';

/**
 * Per-size height and type scale.
 *
 * `min-height` rather than `height`: hive.css §10 draws a 36 px tab, but a long label at the
 * Largest font scale has to be allowed to grow rather than clip. The metric is spelled as an
 * arbitrary value so `tailwind-merge` can still resolve a caller's own `min-h-*` against it (see
 * the note on `Button`'s `size` variant).
 */
export const TAB_TRIGGER_SIZE_CLASS: Record<TabSize, string> = {
  md: 'min-h-[var(--control-h)] px-3 py-1.5 text-sm',
  sm: 'min-h-[var(--control-h-sm)] px-2.5 py-1 text-xs',
};

/** Selected: the underline and label inked in `--fg`, the strongest ink the theme has. */
export const TAB_TRIGGER_ACTIVE_CLASS = 'border-fg text-fg';

/** Unselected: muted label, and the underline previews on hover. */
export const TAB_TRIGGER_IDLE_CLASS =
  'text-fg-muted hover:border-border-strong hover:text-fg';

/** Unavailable: no underline, no hover, and the pointer says so. */
export const TAB_TRIGGER_DISABLED_CLASS =
  'cursor-not-allowed border-transparent text-fg-faint opacity-50 hover:border-transparent';

/** The pane below the strip. */
export const TAB_PANEL_CLASS = 'mt-4 focus-visible:rounded-md focus-visible:outline-none';

/**
 * The glyph a route-strip tab leads with, sized from the tab's own type.
 *
 * `--fs-md` rather than a `size-4`, so the icon keeps its proportion to the label through all six
 * font scales. HIVE-7.3 spelled the same three declarations as a `.repo-tab__glyph` rule in
 * `globals.css`; HIVE-7.7 (#5324) needed it a second time and put it here instead, where the rest
 * of the tab strip's classes already live.
 */
export const TAB_GLYPH_CLASS = 'size-[var(--fs-md)] shrink-0';

/** A count beside a tab's label — inset pill when idle, inverted when the tab is selected. */
export const TAB_COUNT_CLASS =
  'ml-0.5 inline-flex items-center rounded-full bg-inset px-1.5 text-2xs font-semibold text-fg-muted';

/** `pills`: a chip that fills with ink when selected. There is no underline to show. */
const PILL_BASE_CLASS =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border-0 ' +
  'font-medium transition-colors duration-[var(--dur-fast)] focus-visible:outline-none';
const PILL_ACTIVE_CLASS = 'bg-fg text-surface';
const PILL_IDLE_CLASS = 'text-fg-muted hover:bg-subtle hover:text-fg';
const PILL_DISABLED_CLASS = 'cursor-not-allowed text-fg-faint opacity-50';

/** `vertical`: a full-width row that tints when selected. */
const VERTICAL_BASE_CLASS =
  'flex w-full shrink-0 items-center gap-2 whitespace-nowrap rounded-md border-0 text-left ' +
  'font-medium transition-colors duration-[var(--dur-fast)] focus-visible:outline-none';
const VERTICAL_ACTIVE_CLASS = 'bg-subtle text-fg';
const VERTICAL_IDLE_CLASS = 'text-fg-muted hover:bg-subtle hover:text-fg';
const VERTICAL_DISABLED_CLASS = 'cursor-not-allowed text-fg-faint opacity-50';

/** Base / active / idle / disabled classes, by shape. */
const SHAPE: Record<
  TabVariant,
  { base: string; active: string; idle: string; disabled: string }
> = {
  underline: {
    base: TAB_TRIGGER_BASE_CLASS,
    active: TAB_TRIGGER_ACTIVE_CLASS,
    idle: TAB_TRIGGER_IDLE_CLASS,
    disabled: TAB_TRIGGER_DISABLED_CLASS,
  },
  pills: {
    base: PILL_BASE_CLASS,
    active: PILL_ACTIVE_CLASS,
    idle: PILL_IDLE_CLASS,
    disabled: PILL_DISABLED_CLASS,
  },
  vertical: {
    base: VERTICAL_BASE_CLASS,
    active: VERTICAL_ACTIVE_CLASS,
    idle: VERTICAL_IDLE_CLASS,
    disabled: VERTICAL_DISABLED_CLASS,
  },
};

/**
 * The container classes for a tablist of a given shape.
 *
 * @param variant Tab shape (default `underline`).
 * @param options `scroll` for a strip that must not wrap, plus any extra classes.
 * @returns The merged class string for the `role="tablist"` element.
 */
export function tabListClass(
  variant: TabVariant = 'underline',
  options: { scroll?: boolean; className?: string } = {}
): string {
  const { scroll = false, className } = options;
  if (variant === 'pills') return cn(TAB_LIST_PILLS_CLASS, className);
  if (variant === 'vertical') return cn(TAB_LIST_VERTICAL_CLASS, className);
  return cn(scroll ? TAB_LIST_SCROLL_CLASS : TAB_LIST_CLASS, className);
}

export interface TabTriggerClassOptions {
  /** Whether this tab is the selected one. */
  active?: boolean;
  /** Whether this tab cannot be selected. */
  disabled?: boolean;
  /** Density (default `md`). */
  size?: TabSize;
  /** Shape (default `underline`). */
  variant?: TabVariant;
  /** Extra classes, merged last so a caller can still override. */
  className?: string;
}

/**
 * The classes for one tab in a hand-rolled (`<button role="tab">` or `<Link>`) strip.
 *
 * @param options Selected/disabled state, density, shape, and any extra classes.
 * @returns The merged class string for the trigger.
 */
export function tabTriggerClass({
  active = false,
  disabled = false,
  size = 'md',
  variant = 'underline',
  className,
}: TabTriggerClassOptions = {}): string {
  const shape = SHAPE[variant];
  return cn(
    shape.base,
    TAB_TRIGGER_SIZE_CLASS[size],
    disabled ? shape.disabled : active ? shape.active : shape.idle,
    className
  );
}

/** The same look expressed as Radix `data-[state=…]` variants, for Radix-driven strips. */
export const TAB_TRIGGER_RADIX_STATE_CLASS =
  'data-[state=active]:border-fg data-[state=active]:text-fg ' +
  'data-[state=inactive]:text-fg-muted data-[state=inactive]:hover:border-border-strong ' +
  'data-[state=inactive]:hover:text-fg ' +
  'disabled:cursor-not-allowed disabled:border-transparent disabled:text-fg-faint ' +
  'disabled:opacity-50 disabled:hover:border-transparent';

/** `pills`, as Radix state variants. */
const PILL_RADIX_STATE_CLASS =
  'data-[state=active]:bg-fg data-[state=active]:text-surface ' +
  'data-[state=inactive]:text-fg-muted data-[state=inactive]:hover:bg-subtle ' +
  'data-[state=inactive]:hover:text-fg ' +
  'disabled:cursor-not-allowed disabled:text-fg-faint disabled:opacity-50';

/** `vertical`, as Radix state variants. */
const VERTICAL_RADIX_STATE_CLASS =
  'data-[state=active]:bg-subtle data-[state=active]:text-fg ' +
  'data-[state=inactive]:text-fg-muted data-[state=inactive]:hover:bg-subtle ' +
  'data-[state=inactive]:hover:text-fg ' +
  'disabled:cursor-not-allowed disabled:text-fg-faint disabled:opacity-50';

/** Radix state classes, by shape. */
const RADIX_STATE: Record<TabVariant, string> = {
  underline: TAB_TRIGGER_RADIX_STATE_CLASS,
  pills: PILL_RADIX_STATE_CLASS,
  vertical: VERTICAL_RADIX_STATE_CLASS,
};

/**
 * The classes for one trigger in a Radix tabs strip, where selection comes from `data-state`.
 *
 * @param options Density, shape and any extra classes (`active`/`disabled` are ignored — Radix
 *   owns them).
 * @returns The merged class string for the trigger.
 */
export function tabTriggerRadixClass({
  size = 'md',
  variant = 'underline',
  className,
}: Pick<TabTriggerClassOptions, 'size' | 'variant' | 'className'> = {}): string {
  return cn(
    SHAPE[variant].base,
    TAB_TRIGGER_SIZE_CLASS[size],
    RADIX_STATE[variant],
    className
  );
}

/**
 * A tab *rail* — the same ink, turned on its side. A screen with too many sections for one row
 * stacks them in a sidebar on wide viewports and scrolls them as a strip on narrow ones; the ink
 * moves from the bottom edge to the leading edge at `lg` so the selected item still reads as a tab
 * rather than a highlighted button. Colours come from {@link TAB_TRIGGER_RADIX_STATE_CLASS}, which
 * only names a border *colour* and so inks whichever edge the layout exposes.
 */
/**
 * Rail padding, which stays padding-based: a rail item is as tall as its (often wrapping) label,
 * so pinning it to a control metric would clip rather than scale.
 */
export const TAB_RAIL_TRIGGER_SIZE_CLASS: Record<TabSize, string> = {
  md: 'px-3 py-2 text-sm',
  sm: 'px-2.5 py-1.5 text-xs',
};

export const TAB_RAIL_TRIGGER_BASE_CLASS =
  'flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 border-transparent text-left ' +
  'font-medium transition-colors focus-visible:outline-none lg:w-full lg:border-b-0 lg:border-l-2';

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
    TAB_RAIL_TRIGGER_SIZE_CLASS[size],
    TAB_TRIGGER_RADIX_STATE_CLASS,
    className
  );
}
