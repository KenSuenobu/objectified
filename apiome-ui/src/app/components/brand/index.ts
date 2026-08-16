/**
 * The Apiome brand mark (HIVE-1.5, #5278).
 *
 * Import from here rather than reaching for `public/Apiome-*.png`: the assets, the
 * theme-aware swap and the accessible naming all live behind `BrandMark`.
 */

export { default as BrandMark } from './BrandMark';
export type { BrandMarkProps, BrandMarkVariant } from './BrandMark';
export { default as BeeGlyph, BEE_GLYPH_DEFAULT_SIZE } from './BeeGlyph';
export type { BeeGlyphProps, BeeGlyphTone } from './BeeGlyph';
export {
  BEE_GLYPH_BRAND_PALETTE,
  BEE_GLYPH_PART_OPACITY,
  BEE_GLYPH_SHAPES,
  BEE_GLYPH_STROKE_WIDTH,
  BEE_GLYPH_TRANSFORM,
  BEE_GLYPH_VIEWBOX,
  beeGlyphDataUri,
  renderBeeGlyphSvg,
} from './beeGlyph';
export type {
  BeeGlyphPaint,
  BeeGlyphPart,
  BeeGlyphShape,
  RenderBeeGlyphOptions,
} from './beeGlyph';
