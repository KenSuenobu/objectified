/**
 * The Apiome brand mark (HIVE-1.5, #5278).
 *
 * Import from here rather than reaching for `public/bee-logo.png` or `public/Apiome-*.png`:
 * the assets, the theme-aware wordmark swap and the accessible naming all live behind
 * `BrandMark`.
 *
 * `./beeLogoFile` is deliberately not re-exported — it reads from disk, and pulling it into
 * this barrel would drag `node:fs` into every client bundle that wants the bee.
 */

export { default as BrandMark } from './BrandMark';
export type { BrandMarkProps, BrandMarkVariant } from './BrandMark';
export { default as BeeGlyph, BEE_GLYPH_DEFAULT_SIZE } from './BeeGlyph';
export type { BeeGlyphProps } from './BeeGlyph';
export { BEE_LOGO_FILE, BEE_LOGO_INTRINSIC, BEE_LOGO_SRC } from './beeGlyph';
