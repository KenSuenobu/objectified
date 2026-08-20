/**
 * The design tokens the visual-parity harness measures in (HIVE-10.1, #5337).
 *
 * The mockups (`docs/mockups/assets/hive.css`) and the app
 * (`apiome-ui/src/app/globals.css`) declare the *same* token vocabulary — that is what
 * HIVE-1.1 ported. So the honest way to ask "is this page the mockup" is not to diff two
 * screenshots of two different data sets, it is to ask whether the app composes the same
 * tokens, at the same values, in the same places.
 *
 * Every list here therefore names tokens that exist on **both** sides. A token that only one
 * side declares would report as a permanent mismatch and say nothing about parity, so it is
 * deliberately absent.
 */

/** Colour tokens both stylesheets declare, in the order they read best in a report. */
export const COLOUR_TOKENS = [
  'bg-canvas',
  'bg-rail',
  'bg-surface',
  'bg-subtle',
  'bg-inset',
  'bg-overlay',
  'fg',
  'fg-muted',
  'fg-subtle',
  'fg-faint',
  'fg-on-accent',
  'border',
  'border-strong',
  'border-focus',
  'accent',
  'accent-hover',
  'accent-soft',
  'accent-fg',
  'ink',
  'honey',
  'ok',
  'warn',
  'danger',
  'info',
  'neutral',
  'violet',
  'orange',
  'rose',
] as const;

/** The ten-step type ladder of DESIGN.md §4.1. */
export const TYPE_TOKENS = [
  'fs-2xs',
  'fs-xs',
  'fs-sm',
  'fs-md',
  'fs-lg',
  'fs-xl',
  'fs-2xl',
  'fs-3xl',
  'fs-4xl',
  'fs-5xl',
] as const;

/** The spacing scale, plus the two composite paddings built from it. */
export const SPACE_TOKENS = [
  'space-1',
  'space-2',
  'space-3',
  'space-4',
  'space-5',
  'space-6',
  'space-8',
  'space-10',
  'space-12',
  'card-pad',
  'page-pad',
] as const;

/** The corner-radius ladder. */
export const RADIUS_TOKENS = ['r-xs', 'r-sm', 'r-md', 'r-lg', 'r-xl', 'r-full'] as const;

/** The control-height ladder, plus the table row height that sits beside it. */
export const CONTROL_TOKENS = ['control-h-sm', 'control-h', 'control-h-lg', 'row-h'] as const;

/** Layout tokens that decide how wide the page and its content may grow. */
export const LAYOUT_TOKENS = ['page-max', 'content-max', 'nav-item-h'] as const;

/**
 * Every token the collector resolves, in one list.
 *
 * The collector resolves each of these through a probe element, so the value it reports is
 * the browser's own canonical serialisation (`rgb(15, 23, 42)`, `16px`) rather than the
 * authored text (`#0f172a`, `1rem`) — which is what makes the two sides comparable at all.
 */
export const ALL_TOKENS: readonly string[] = [
  ...COLOUR_TOKENS,
  ...TYPE_TOKENS,
  ...SPACE_TOKENS,
  ...RADIUS_TOKENS,
  ...CONTROL_TOKENS,
  ...LAYOUT_TOKENS,
];

/** Tokens whose resolved value is a colour, so the collector probes them as `color`. */
export const COLOUR_TOKEN_SET: ReadonlySet<string> = new Set(COLOUR_TOKENS);

/**
 * The bucket a measured value falls into when it matches no token at all.
 *
 * A page can only earn this by hard-coding a length or a colour, which is exactly what the
 * cross-cutting definition of done forbids — so it is reported, never silently rounded.
 */
export const OFF_SCALE = 'off-scale';
