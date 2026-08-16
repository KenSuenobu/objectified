/**
 * The Apiome bee glyph, expressed once as data (HIVE-1.5, #5278).
 *
 * The brand mark is a bee on a honeycomb (`docs/mockups/DESIGN.md` §2). It shipped as four
 * PNGs, which blur below ~40 px and cannot follow a theme; this module is the vector
 * redraw, simplified to the three things that still read at 20 px — the layered honeycomb
 * on the thorax, the striped abdomen and the head — with the decorative molecule lattice
 * of `Apiome-07.png` left out. The PNGs stay in `public/` as the raster fallback and as the
 * wordmark (`BrandMark`).
 *
 * It is *data*, not markup, because two renderers need it and they cannot share JSX:
 *
 * | Renderer | Where | Paint |
 * | --- | --- | --- |
 * | {@link BeeGlyph} | the app, as inline SVG | CSS classes, so a theme can swap the ink |
 * | {@link renderBeeGlyphSvg} | `icon.tsx` / `apple-icon.tsx`, as a data URI | literal brand hues, because Satori has no stylesheet |
 *
 * Both walk {@link BEE_GLYPH_SHAPES} in order, so the two can never drift apart. Geometry
 * lives in the shape's `attrs` (identical spelling in SVG and in React); everything about
 * *paint* — fill, opacity, stroke width — is derived from the shape's `part`, which is what
 * lets one description carry both a themed and a fixed palette.
 */

/** The coordinate box every shape below is authored in. */
export const BEE_GLYPH_VIEWBOX = '0 0 64 64';

/**
 * Optical centring for the whole mark.
 *
 * The bee is drawn upright and rotated onto the diagonal, which leaves its ink low and
 * left of the box centre; this nudges the group back so the glyph sits centred in a square
 * button, an avatar or a favicon without anyone having to pad around it.
 */
export const BEE_GLYPH_TRANSFORM = 'translate(-0.5 3)';

/**
 * The brand role a shape is painted with.
 *
 * `ink` is the bee's body and line work — the only part a theme swaps, so the silhouette
 * survives on a dark base. `comb` and `honey` are the honeycomb's azure face and its honey
 * core; `wing` is the translucent azure of the wings.
 */
export type BeeGlyphPart = 'ink' | 'wing' | 'comb' | 'honey';

/** Whether a shape is filled or stroked. Only the antennae are stroked. */
export type BeeGlyphPaint = 'fill' | 'stroke';

/** One drawn shape of the glyph. */
export interface BeeGlyphShape {
  /** Stable name — the React key, and how the tests refer to a shape. */
  readonly id: string;
  /** Which brand role paints it. */
  readonly part: BeeGlyphPart;
  /** The SVG element to draw. */
  readonly el: 'path' | 'ellipse';
  /** Filled or stroked. */
  readonly paint: BeeGlyphPaint;
  /**
   * Geometry only — `d`, `cx`/`cy`/`rx`/`ry` and `transform`.
   *
   * Every name here is spelled the same in raw SVG and in JSX, which is what lets the two
   * renderers spread it verbatim. Paint attributes are deliberately absent: they would
   * need `stroke-width` in one renderer and `strokeWidth` in the other.
   */
  readonly attrs: Readonly<Record<string, string | number>>;
}

/**
 * The bee's own transform.
 *
 * Head, abdomen and antennae are authored upright — far easier to reason about — and the
 * whole body is then rotated 45° about the centre of the box, which is the diagonal the
 * shipped mark uses (head upper right, tail lower left). The honeycomb is *not* in this
 * group: on the original it stays square to the page while the bee tilts under it.
 */
const BODY = 'rotate(45 32 32)';

/**
 * A regular hexagon, vertex up, centred in the box.
 *
 * @param radius Distance from the centre to a vertex, in viewBox units.
 * @returns A closed `d` attribute for the six corners.
 */
/**
 * Trim a computed coordinate to two decimals.
 *
 * @param value The coordinate.
 * @returns The same coordinate without binary-float noise, which would otherwise be
 *          serialised into every generated icon.
 */
const round = (value: number): number => Number(value.toFixed(2));

const hexagon = (radius: number): string => {
  const half = radius / 2;
  const flank = round(Math.sqrt(3) * half);
  const corners: readonly [number, number][] = [
    [32, 32 - radius],
    [32 + flank, 32 - half],
    [32 + flank, 32 + half],
    [32, 32 + radius],
    [32 - flank, 32 + half],
    [32 - flank, 32 - half],
  ];
  // One `M`, then implicit line-tos: the shortest form, and the one a designer's tool emits.
  // Coordinates are rounded because `32 - flank` otherwise carries binary-float noise into
  // the markup, and the raster renderer serialises that noise into every generated icon.
  return `M${corners.map(([x, y]) => `${round(x)} ${round(y)}`).join(' ')}Z`;
};

/**
 * Every shape of the glyph, in paint order (first drawn is furthest back).
 *
 * The order is the composition: wings behind the body, the body behind the honeycomb, so
 * the comb reads as sitting on the bee's back exactly as it does on `Apiome-07.png`.
 */
export const BEE_GLYPH_SHAPES: readonly BeeGlyphShape[] = [
  // ---- Wings — two azure blades sweeping off the thorax to the upper left.
  //      Both reach under the honeycomb, which is what makes them read as attached to the
  //      bee rather than as two shapes floating beside it. ----
  {
    id: 'wing-upper',
    part: 'wing',
    el: 'ellipse',
    paint: 'fill',
    attrs: { cx: 20, cy: 18, rx: 13, ry: 4.8, transform: 'rotate(-24 20 18)' },
  },
  {
    id: 'wing-lower',
    part: 'wing',
    el: 'ellipse',
    paint: 'fill',
    attrs: { cx: 18, cy: 28, rx: 11.5, ry: 4.4, transform: 'rotate(4 18 28)' },
  },

  // ---- Body ----
  {
    id: 'abdomen',
    part: 'ink',
    el: 'path',
    paint: 'fill',
    attrs: {
      d: 'M32 62C23 53.5 20.2 45 21.4 34.5 25 32 39 32 42.6 34.5 43.8 45 41 53.5 32 62Z',
      transform: BODY,
    },
  },
  {
    // Inset from the silhouette rather than clipped to it: a clip path would need a
    // document-unique id, and every instance of the glyph on a page would have to mint one.
    id: 'stripe-upper',
    part: 'honey',
    el: 'path',
    paint: 'fill',
    attrs: { d: 'M22.8 44.5H41.2L39.5 50H24.5Z', transform: BODY },
  },
  {
    id: 'stripe-lower',
    part: 'honey',
    el: 'path',
    paint: 'fill',
    attrs: { d: 'M26.2 52.5H37.8L34.8 57.5H29.2Z', transform: BODY },
  },
  {
    id: 'antenna-left',
    part: 'ink',
    el: 'path',
    paint: 'stroke',
    attrs: { d: 'M28.8 9.1C25.8 6.3 23.2 5.1 21.5 5.9', transform: BODY },
  },
  {
    id: 'antenna-right',
    part: 'ink',
    el: 'path',
    paint: 'stroke',
    attrs: { d: 'M35.4 9.3C38 6.1 40.4 5.1 42 5.7', transform: BODY },
  },
  {
    id: 'head',
    part: 'ink',
    el: 'ellipse',
    paint: 'fill',
    attrs: { cx: 32, cy: 14, rx: 7, ry: 7.6, transform: BODY },
  },
  {
    id: 'eye',
    part: 'honey',
    el: 'ellipse',
    paint: 'fill',
    attrs: { cx: 33.6, cy: 12.7, rx: 3.2, ry: 2.7, transform: BODY },
  },

  // ---- Honeycomb — three concentric hexagons, square to the page ----
  { id: 'comb-ring', part: 'ink', el: 'path', paint: 'fill', attrs: { d: hexagon(12.2) } },
  { id: 'comb-face', part: 'comb', el: 'path', paint: 'fill', attrs: { d: hexagon(9.8) } },
  { id: 'comb-core', part: 'honey', el: 'path', paint: 'fill', attrs: { d: hexagon(5) } },
];

/**
 * Stroke width for the stroked shapes, in viewBox units.
 *
 * ~4.7% of the glyph's edge, which is a whole pixel at 20 px and never thins to a hairline.
 */
export const BEE_GLYPH_STROKE_WIDTH = 3;

/** Parts that are painted back at less than full strength. */
export const BEE_GLYPH_PART_OPACITY: Readonly<Partial<Record<BeeGlyphPart, number>>> = {
  wing: 0.55,
};

/**
 * The fixed brand hues, for renderers that have no stylesheet.
 *
 * These are the literals of `--color-brand-*` in `globals.css`, and the two must agree —
 * `tests/brand-mark.test.tsx` reads both and fails if they drift. In the app the glyph
 * takes its colour from CSS instead, so a dark theme can lighten the ink.
 */
export const BEE_GLYPH_BRAND_PALETTE: Readonly<Record<BeeGlyphPart, string>> = {
  ink: '#16265C',
  wing: '#1E90E8',
  comb: '#1E90E8',
  honey: '#F5B301',
};

/** Options for {@link renderBeeGlyphSvg}. */
export interface RenderBeeGlyphOptions {
  /** Edge length of the square SVG, in pixels. */
  size: number;
  /** Colour per brand role. Defaults to {@link BEE_GLYPH_BRAND_PALETTE}. */
  palette?: Readonly<Record<BeeGlyphPart, string>>;
  /** Fill painted behind the glyph — a favicon needs one, an inline mark does not. */
  background?: string;
  /** Corner radius of that background, in viewBox units (0–32). Ignored without a background. */
  backgroundRadius?: number;
}

/**
 * Serialise an attribute value for raw SVG markup.
 *
 * @param value The attribute value.
 * @returns The value with `"` and `&` escaped, so it is safe inside a quoted attribute.
 */
const escapeAttribute = (value: string | number): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Render the glyph as a standalone SVG document.
 *
 * Used where React cannot reach and CSS does not apply: the `icon` / `apple-icon` metadata
 * routes hand the result to Satori as a data URI. Colour is baked in, because those images
 * are cached by the browser as files and have no theme.
 *
 * @param options Size, palette and optional background — see {@link RenderBeeGlyphOptions}.
 * @returns A complete `<svg>` document as a string.
 */
export function renderBeeGlyphSvg(options: RenderBeeGlyphOptions): string {
  const { size, palette = BEE_GLYPH_BRAND_PALETTE, background, backgroundRadius = 0 } = options;

  const plate = background
    ? `<rect width="64" height="64" rx="${backgroundRadius}" fill="${escapeAttribute(background)}"/>`
    : '';

  const shapes = BEE_GLYPH_SHAPES.map((shape) => {
    const geometry = Object.entries(shape.attrs)
      .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
      .join(' ');
    const colour = escapeAttribute(palette[shape.part]);
    const paint =
      shape.paint === 'stroke'
        ? `fill="none" stroke="${colour}" stroke-width="${BEE_GLYPH_STROKE_WIDTH}" stroke-linecap="round"`
        : `fill="${colour}"`;
    const opacity = BEE_GLYPH_PART_OPACITY[shape.part];
    const alpha = opacity === undefined ? '' : ` opacity="${opacity}"`;
    return `<${shape.el} ${geometry} ${paint}${alpha}/>`;
  }).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BEE_GLYPH_VIEWBOX}" width="${size}" height="${size}">`,
    plate,
    `<g transform="${BEE_GLYPH_TRANSFORM}">${shapes}</g>`,
    '</svg>',
  ].join('');
}

/**
 * The glyph as a `data:` URI, ready for an `<img src>`.
 *
 * Base64 rather than percent-encoded UTF-8: Satori (the renderer behind `ImageResponse`)
 * accepts both, but base64 cannot be broken by a stray `#` in a colour literal.
 *
 * @param options Same options as {@link renderBeeGlyphSvg}.
 * @returns A `data:image/svg+xml;base64,…` URI.
 */
export function beeGlyphDataUri(options: RenderBeeGlyphOptions): string {
  const markup = renderBeeGlyphSvg(options);
  const encoded =
    typeof Buffer === 'undefined'
      ? btoa(String.fromCharCode(...new TextEncoder().encode(markup)))
      : Buffer.from(markup, 'utf8').toString('base64');
  return `data:image/svg+xml;base64,${encoded}`;
}
