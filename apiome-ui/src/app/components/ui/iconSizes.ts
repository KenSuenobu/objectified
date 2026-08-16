/**
 * The three icon sizes of the Hive design language (HIVE-1.6, #5279).
 *
 * `docs/mockups/DESIGN.md` §3.5 fixes Lucide glyphs at **16 px in dense UI, 18 px in the
 * rail and 15 px in buttons**, stroke 1.75. Those three numbers are the whole vocabulary:
 * an icon that is not one of them is either decorative art or a mistake.
 *
 * Why this module exists rather than a CSS class
 * ----------------------------------------------
 * `lucide-react` renders its `size` prop as the `width`/`height` **attributes** of the
 * `<svg>`, which a stylesheet can only reach by fighting the element it is drawn on. The
 * honest seam is therefore a shared constant the call site passes straight through:
 *
 * ```tsx
 * import { ICON_SIZE } from '@/app/components/ui/iconSizes';
 *
 * <Search size={ICON_SIZE.dense} aria-hidden />
 * ```
 *
 * Why the values are `rem`
 * ------------------------
 * The font-size preference (HIVE-1.3) scales the interface by moving the root font size,
 * so a glyph frozen at `16` keeps its pixel size while the label beside it grows — by the
 * Largest scale the pair reads as a small icon stranded next to large text. Expressed in
 * `rem` the two move together, and at the default 16 px root each constant still measures
 * exactly the pixel size §3.5 specifies. SVG lengths are CSS lengths, so `width="1rem"` is
 * resolved by the browser the same way `width: 1rem` would be.
 *
 * `globals.css` carries the same three values as `--icon-dense` / `--icon-rail` /
 * `--icon-button` for CSS-side consumers; `tests/icon-sizes.test.ts` fails if the two
 * spellings drift, or if either stops matching the numbers written in DESIGN.md §3.5.
 */

/** The design-language name of an icon's context. */
export type IconSizeName = 'dense' | 'rail' | 'button';

/**
 * Icon sizes as CSS lengths, for the `size` prop of a `lucide-react` icon.
 *
 * - `dense` — tables, lists, chips, inline affordances; the default for a UI glyph.
 * - `rail` — the sidebar/rail nav, where an icon carries a whole destination.
 * - `button` — inside a button, where the glyph is subordinate to the label.
 */
export const ICON_SIZE: Readonly<Record<IconSizeName, string>> = {
  dense: '1rem',
  rail: '1.125rem',
  button: '0.9375rem',
};

/**
 * The same three sizes in CSS pixels, as DESIGN.md §3.5 writes them.
 *
 * Exported for the places that genuinely need a number — geometry maths, a canvas, or a
 * test — and used by `tests/icon-sizes.test.ts` to tie {@link ICON_SIZE} back to the
 * design document. Reading one of these into a `size` prop re-freezes the glyph, so
 * prefer {@link ICON_SIZE}.
 */
export const ICON_SIZE_PX: Readonly<Record<IconSizeName, number>> = {
  dense: 16,
  rail: 18,
  button: 15,
};

/** Stroke width every Hive icon is drawn with (DESIGN.md §3.5). */
export const ICON_STROKE_WIDTH = 1.75;

/** Root font size, in CSS pixels, that the `rem` values above are stated against. */
export const ROOT_FONT_SIZE_PX = 16;

/**
 * The props an icon component accepts when a caller only ever sets its size and colour.
 *
 * `size` is `string | number` — the signature `lucide-react` and `react-icons` both use —
 * so a component that declares its icon slot with this type can be handed an
 * {@link ICON_SIZE} value. Declaring it as `number` is what freezes an icon in `px`, and
 * the failure surfaces at the *call site* rather than at the declaration, which makes it
 * an easy one to reintroduce.
 */
export interface IconComponentProps {
  /** Rendered width/height, as any CSS length. */
  size?: string | number;
  /** Classes applied to the root `<svg>`. */
  className?: string;
}
