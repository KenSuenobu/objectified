import Image from 'next/image';
import type { CSSProperties } from 'react';

import BeeGlyph from './BeeGlyph';

/**
 * The Apiome brand mark (HIVE-1.5, #5278).
 *
 * One component for the three shapes the brand appears in, so no surface has to know which
 * asset a theme wants or how big the bee should be next to the word:
 *
 * | Variant | What it is | Where |
 * | --- | --- | --- |
 * | `glyph` | the bee alone | rail brand, avatars, empty-state art, favicons |
 * | `wordmark` | the full "apiome" lock-up artwork | auth brand panel, launcher hero |
 * | `lockup` | bee + "apiome" + an optional subtitle | rail top, admin console |
 *
 * Every variant is the shipped artwork. The bee is `bee-logo.png` ({@link BeeGlyph}); the
 * wordmark is `Apiome-02.png` on a light base and `Apiome-05.png` on a dark one, and this
 * is the only module allowed to name those two files. Their swap happens in CSS from the
 * theme's `--brand-on-dark`, not from a `dark:` utility, so the nine themes all get the
 * right one rather than only the two that set `.dark`. The bee needs no such swap: it is
 * one file on every theme.
 */

/** Which shape of the mark to render. */
export type BrandMarkVariant = 'glyph' | 'wordmark' | 'lockup';

/** Props for {@link BrandMark}. */
export interface BrandMarkProps {
  /** Which shape of the mark. Defaults to `lockup`. */
  variant?: BrandMarkVariant;
  /**
   * Size in pixels: the bee's edge for `glyph` and `lockup`, the artwork's height for
   * `wordmark`. Defaults to the size that variant is used at in the design.
   */
  size?: number;
  /** Subtitle under the word — `lockup` only. `"Platform"` on the rail (DESIGN.md §5.2). */
  sub?: string;
  /** Accessible name for the variants that carry no visible text. Defaults to `"Apiome"`. */
  label?: string;
  /** Hide the mark from assistive technology — for a second copy, or pure ornament. */
  decorative?: boolean;
  /** Ask Next to preload the artwork. Set it on an above-the-fold hero. */
  priority?: boolean;
  /** Extra classes on the outermost element. */
  className?: string;
}

/** The wordmark artwork, light base. */
const WORDMARK_LIGHT = '/Apiome-02.png';

/** The wordmark artwork, dark base — identical but for the colour of the word. */
const WORDMARK_DARK = '/Apiome-05.png';

/** Intrinsic size of both wordmark files, in pixels. */
const WORDMARK_INTRINSIC = { width: 1174, height: 398 } as const;

/** Default pixel size per variant. */
const DEFAULT_SIZE: Record<BrandMarkVariant, number> = {
  glyph: 26,
  wordmark: 32,
  lockup: 28,
};

/**
 * Join the class names that are actually set.
 *
 * @param names Class names, any of which may be absent.
 * @returns A single space-separated class attribute.
 */
const classes = (...names: (string | false | undefined | null)[]): string =>
  names.filter(Boolean).join(' ');

/**
 * The brand mark.
 *
 * @param props Variant, size, subtitle and accessibility — see {@link BrandMarkProps}.
 * @returns The mark, named "Apiome" for assistive technology unless `decorative` is set.
 */
export default function BrandMark({
  variant = 'lockup',
  size,
  sub,
  label = 'Apiome',
  decorative = false,
  priority = false,
  className,
}: BrandMarkProps) {
  const pixels = size ?? DEFAULT_SIZE[variant];
  const name = decorative ? undefined : label;

  if (variant === 'glyph') {
    return <BeeGlyph size={pixels} label={name} priority={priority} className={className} />;
  }

  if (variant === 'wordmark') {
    // Both files are rendered and CSS shows one, rather than picking in JavaScript: the
    // choice is then made before first paint, on a route whose theme the server never knew.
    const width = Math.round(pixels * (WORDMARK_INTRINSIC.width / WORDMARK_INTRINSIC.height));
    return (
      <span
        className={classes('brand-wordmark', className)}
        style={{ '--brand-wordmark-h': `${pixels}px` } as CSSProperties}
        role={name ? 'img' : undefined}
        aria-label={name}
        aria-hidden={name ? undefined : true}
      >
        <Image
          className="brand-wordmark__asset brand-wordmark__asset--light"
          src={WORDMARK_LIGHT}
          alt=""
          width={width}
          height={pixels}
          priority={priority}
        />
        <Image
          className="brand-wordmark__asset brand-wordmark__asset--dark"
          src={WORDMARK_DARK}
          alt=""
          width={width}
          height={pixels}
          priority={priority}
        />
      </span>
    );
  }

  // The lock-up sets the word as text rather than reusing the wordmark artwork, because
  // that artwork already contains a bee: pairing the two would print the mark twice.
  return (
    <span className={classes('brand-lockup', className)} aria-hidden={decorative || undefined}>
      <BeeGlyph size={pixels} priority={priority} />
      <span className="brand-lockup__text">
        <span className="brand-lockup__name">apiome</span>
        {sub ? <span className="brand-lockup__sub">{sub}</span> : null}
      </span>
    </span>
  );
}
