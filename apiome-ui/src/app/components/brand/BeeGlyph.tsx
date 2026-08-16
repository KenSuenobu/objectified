import Image from 'next/image';

import { BEE_LOGO_SRC } from './beeGlyph';

/** Props for {@link BeeGlyph}. */
export interface BeeGlyphProps {
  /** Edge length of the square glyph in pixels. A CSS rule on `className` still wins. */
  size?: number;
  /**
   * Accessible name.
   *
   * Given one, the glyph is announced as an image; without one it is hidden from assistive
   * technology, which is right wherever a visible label already says "Apiome".
   */
  label?: string;
  /** Ask Next to preload the artwork. Set it where the mark is above the fold. */
  priority?: boolean;
  /** Extra classes on the `<img>`. */
  className?: string;
}

/** The default edge length: the rail's brand mark (`hive.css` §5.2). */
export const BEE_GLYPH_DEFAULT_SIZE = 26;

/**
 * The Apiome bee.
 *
 * The shipped artwork — `public/bee-logo.png` — rather than a drawing of it. Between
 * HIVE-1.5 and this change the app rendered a hand-authored vector approximation, which
 * read as a different insect: no molecule lattice, different wings, different proportions.
 * There is now one bee, and it is the brand's.
 *
 * `next/image` serves it at the requested edge with a 2× source in the `srcset`, so the
 * mark is sharp on a retina display without every caller shipping the full 256 px file.
 *
 * Prefer {@link BrandMark} — this is the glyph on its own, for the places that want the bee
 * and nothing else: an avatar, empty-state art, a favicon.
 *
 * @param props Size, accessible name, preload and class — see {@link BeeGlyphProps}.
 * @returns The artwork, decorative unless it was given a `label`.
 */
export default function BeeGlyph({
  size = BEE_GLYPH_DEFAULT_SIZE,
  label,
  priority = false,
  className,
}: BeeGlyphProps) {
  return (
    <Image
      className={['bee-glyph', className].filter(Boolean).join(' ')}
      src={BEE_LOGO_SRC}
      // An empty `alt` is the raster spelling of `aria-hidden`: it takes the image out of
      // the accessibility tree entirely, rather than leaving an unnamed `img` behind.
      alt={label ?? ''}
      width={size}
      height={size}
      priority={priority}
    />
  );
}
