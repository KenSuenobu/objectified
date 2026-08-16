import {
  BEE_GLYPH_SHAPES,
  BEE_GLYPH_TRANSFORM,
  BEE_GLYPH_VIEWBOX,
  type BeeGlyphShape,
} from './beeGlyph';

/** How the glyph takes its colour. */
export type BeeGlyphTone =
  /** The brand hues, from `--brand-ink` / `--brand-azure` / `--brand-honey`. */
  | 'brand'
  /** One colour — `currentColor`, shaded per part. For tinted surfaces and ornament. */
  | 'mono';

/** Props for {@link BeeGlyph}. */
export interface BeeGlyphProps {
  /** Edge length of the square glyph in pixels. A CSS rule on `className` still wins. */
  size?: number;
  /** Which palette to paint with. Defaults to `brand`. */
  tone?: BeeGlyphTone;
  /**
   * Accessible name.
   *
   * Given one, the glyph is announced as an image; without one it is hidden from assistive
   * technology, which is right wherever a visible label already says "Apiome".
   */
  label?: string;
  /** Extra classes on the `<svg>`. */
  className?: string;
}

/** The default edge length: the rail's brand mark (`hive.css` §5.2). */
export const BEE_GLYPH_DEFAULT_SIZE = 26;

/**
 * One shape of the glyph.
 *
 * @param shape The shape to draw, from `BEE_GLYPH_SHAPES`.
 * @returns An `<ellipse>` or `<path>` carrying the classes that colour it.
 */
function Shape({ shape }: { shape: BeeGlyphShape }) {
  const className = `bee-glyph__${shape.part} bee-glyph__${shape.paint}`;
  return shape.el === 'ellipse' ? (
    <ellipse className={className} {...shape.attrs} />
  ) : (
    <path className={className} {...shape.attrs} />
  );
}

/**
 * The Apiome bee, as inline SVG.
 *
 * Inline rather than an `<img>` so the ink follows the theme: every shape is painted from
 * a CSS class (`globals.css` → "BRAND MARK"), and a dark base lightens `--brand-ink` so the
 * bee keeps its silhouette instead of sinking into the background.
 *
 * Prefer {@link BrandMark} — this is the glyph on its own, for the places that want the bee
 * and nothing else: a favicon, an avatar, empty-state art.
 *
 * @param props Size, tone, accessible name and class — see {@link BeeGlyphProps}.
 * @returns The glyph, `aria-hidden` unless it was given a `label`.
 */
export default function BeeGlyph({
  size = BEE_GLYPH_DEFAULT_SIZE,
  tone = 'brand',
  label,
  className,
}: BeeGlyphProps) {
  const classes = ['bee-glyph', tone === 'mono' ? 'bee-glyph--mono' : null, className]
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox={BEE_GLYPH_VIEWBOX}
      xmlns="http://www.w3.org/2000/svg"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <g transform={BEE_GLYPH_TRANSFORM}>
        {BEE_GLYPH_SHAPES.map((shape) => (
          <Shape key={shape.id} shape={shape} />
        ))}
      </g>
    </svg>
  );
}
