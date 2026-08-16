/**
 * Type sizes for text drawn *inside* an SVG coordinate system (HIVE-1.6, #5279).
 *
 * The Hive type scale is `rem`, so it follows the reader's font-size preference
 * (DESIGN.md §3.2, HIVE-1.3). Text inside a chart or a projection graph must not: its
 * neighbours are boxes, arrows and ticks whose coordinates were computed in **user
 * units** by a layout function, and a label that grew by a quarter while the box holding
 * it stayed put would simply overflow the box. Under a `viewBox` the whole drawing is
 * scaled by the browser anyway, which is what makes a graph legible at any size — the
 * proportion between a label and the box around it is the thing that has to stay fixed.
 *
 * DESIGN.md's "keep `px` only where it is genuinely physical … canvas geometry" is
 * exactly this case, so these are numbers rather than tokens. They are collected here so
 * the exemption stays a small, named vocabulary instead of a literal at every `<text>`:
 * pass one as the `fontSize` attribute of the `<text>` or `<g>` that needs it.
 *
 * ```tsx
 * <text x={x} y={y} fontSize={SVG_TEXT_SIZE.label} className="fill-fg-subtle">{label}</text>
 * ```
 *
 * Chrome *around* a graph — its title, legend, toolbar, the text alternative table — is
 * ordinary HTML and uses the Hive scale (`text-2xs` … `text-3xl`) like everything else.
 *
 * @see `components/ui/code/editorTypography.ts` — the same exemption for Monaco.
 * @see `components/ade/canvas/canvas-theme.ts` — the same exemption for react-flow nodes.
 */

/** The design-language name of a size of SVG-resident text. */
export type SvgTextSizeName = 'tick' | 'label' | 'body' | 'value' | 'display';

/**
 * Sizes, in SVG user units, for text drawn into a graph's coordinate system.
 *
 * - `tick` — axis ticks and secondary annotations, the smallest legible mark.
 * - `label` — column headings and node captions; the default for graph text.
 * - `body` — a node's primary label, one step up from its caption.
 * - `value` — an emphasized figure at the centre of a donut.
 * - `display` — the single headline number of a gauge.
 */
export const SVG_TEXT_SIZE: Readonly<Record<SvgTextSizeName, number>> = {
  tick: 9,
  label: 10,
  body: 11,
  value: 16,
  display: 22,
};
