/**
 * The bee glyph's geometry and its raster renderer (HIVE-1.5, #5278).
 *
 * The mark is drawn from data (`src/app/components/brand/beeGlyph.ts`) so that the inline
 * SVG the app renders and the PNG the favicon route generates can never diverge. That
 * makes two things worth locking down here, neither of which a screenshot would catch
 * reliably at 20 px:
 *
 *   1. **nothing is clipped.** Every shape is authored upright and rotated onto the mark's
 *      diagonal, so a coordinate that looks safe in the source can land outside the
 *      viewBox. The suite re-walks the paths, applies the transforms and asserts the inked
 *      area stays inside the box — and stays centred in it, which is what lets a caller
 *      drop the glyph into a square avatar or a favicon with no padding of its own.
 *   2. **the raster renderer paints every shape**, in the same order and with the same
 *      brand hues, because it is the one renderer with no stylesheet behind it.
 */

import {
  BEE_GLYPH_BRAND_PALETTE,
  BEE_GLYPH_PART_OPACITY,
  BEE_GLYPH_SHAPES,
  BEE_GLYPH_STROKE_WIDTH,
  BEE_GLYPH_TRANSFORM,
  BEE_GLYPH_VIEWBOX,
  beeGlyphDataUri,
  renderBeeGlyphSvg,
  type BeeGlyphShape,
} from '../src/app/components/brand/beeGlyph';

/** A point in viewBox units. */
interface Point {
  x: number;
  y: number;
}

/** An axis-aligned box in viewBox units. */
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** How many samples a curve or an ellipse is walked with. Fine enough for a 64-unit box. */
const SAMPLES = 64;

/**
 * Apply one SVG transform to a point.
 *
 * Only the two forms the glyph uses are supported — `rotate(angle cx cy)` and
 * `translate(x y)` — so an unrecognised transform fails loudly rather than silently
 * leaving the point where it was.
 *
 * @param point The point to move.
 * @param transform The transform attribute's value.
 * @returns The transformed point.
 */
function applyTransform(point: Point, transform: string | undefined): Point {
  if (!transform) return point;

  const rotate = /^rotate\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(transform);
  if (rotate) {
    const [, degrees, cx, cy] = rotate.map(Number) as unknown as number[];
    const radians = (degrees * Math.PI) / 180;
    const dx = point.x - cx;
    const dy = point.y - cy;
    return {
      x: cx + dx * Math.cos(radians) - dy * Math.sin(radians),
      y: cy + dx * Math.sin(radians) + dy * Math.cos(radians),
    };
  }

  const translate = /^translate\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(transform);
  if (translate) {
    return { x: point.x + Number(translate[1]), y: point.y + Number(translate[2]) };
  }

  throw new Error(`unsupported transform: ${transform}`);
}

/**
 * Points along a cubic Bézier segment.
 *
 * @param from Current point.
 * @param c1 First control point.
 * @param c2 Second control point.
 * @param to End point.
 * @returns `SAMPLES` points along the curve, endpoints included.
 */
function sampleCubic(from: Point, c1: Point, c2: Point, to: Point): Point[] {
  return Array.from({ length: SAMPLES + 1 }, (_, step) => {
    const t = step / SAMPLES;
    const u = 1 - t;
    return {
      x: u ** 3 * from.x + 3 * u ** 2 * t * c1.x + 3 * u * t ** 2 * c2.x + t ** 3 * to.x,
      y: u ** 3 * from.y + 3 * u ** 2 * t * c1.y + 3 * u * t ** 2 * c2.y + t ** 3 * to.y,
    };
  });
}

/**
 * Every point a path visits, sampling its curves.
 *
 * Handles the absolute commands the glyph is authored with — `M`, `L`, `H`, `V`, `C`, `Z` —
 * including the repeated-argument shorthand (`C` followed by several coordinate sets).
 *
 * @param d The path's `d` attribute.
 * @returns Points in path order.
 */
function samplePath(d: string): Point[] {
  const points: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  let start: Point = cursor;

  for (const [, command, rawArgs] of d.matchAll(/([MLHVCZ])([^MLHVCZ]*)/gi)) {
    const args = rawArgs.trim().length
      ? rawArgs.trim().split(/[\s,]+/).map(Number)
      : [];
    if (args.some(Number.isNaN)) throw new Error(`unparsable arguments in "${d}"`);

    switch (command) {
      case 'M':
      case 'L': {
        for (let i = 0; i < args.length; i += 2) {
          cursor = { x: args[i], y: args[i + 1] };
          if (command === 'M' && i === 0) start = cursor;
          points.push(cursor);
        }
        break;
      }
      case 'H': {
        for (const x of args) {
          cursor = { x, y: cursor.y };
          points.push(cursor);
        }
        break;
      }
      case 'V': {
        for (const y of args) {
          cursor = { x: cursor.x, y };
          points.push(cursor);
        }
        break;
      }
      case 'C': {
        for (let i = 0; i < args.length; i += 6) {
          const c1 = { x: args[i], y: args[i + 1] };
          const c2 = { x: args[i + 2], y: args[i + 3] };
          const to = { x: args[i + 4], y: args[i + 5] };
          points.push(...sampleCubic(cursor, c1, c2, to));
          cursor = to;
        }
        break;
      }
      case 'Z': {
        cursor = start;
        points.push(cursor);
        break;
      }
      default:
        throw new Error(`unsupported path command: ${command}`);
    }
  }

  return points;
}

/**
 * Every point on an ellipse's outline.
 *
 * @param attrs The shape's geometry attributes.
 * @returns `SAMPLES` points around the ellipse.
 */
function sampleEllipse(attrs: Record<string, string | number>): Point[] {
  const cx = Number(attrs.cx);
  const cy = Number(attrs.cy);
  const rx = Number(attrs.rx);
  const ry = Number(attrs.ry);
  return Array.from({ length: SAMPLES }, (_, step) => {
    const angle = (step / SAMPLES) * 2 * Math.PI;
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });
}

/**
 * The box a shape inks, in final viewBox coordinates.
 *
 * The shape's own transform is applied, then the glyph's root transform, then a stroked
 * shape is grown by half its stroke — the stroke straddles the path.
 *
 * @param shape The shape to measure.
 * @returns Its bounding box.
 */
function inkedBox(shape: BeeGlyphShape): Box {
  const local = shape.el === 'ellipse' ? sampleEllipse(shape.attrs) : samplePath(String(shape.attrs.d));
  const bleed = shape.paint === 'stroke' ? BEE_GLYPH_STROKE_WIDTH / 2 : 0;

  const placed = local
    .map((point) => applyTransform(point, shape.attrs.transform as string | undefined))
    .map((point) => applyTransform(point, BEE_GLYPH_TRANSFORM));

  return {
    minX: Math.min(...placed.map((p) => p.x)) - bleed,
    minY: Math.min(...placed.map((p) => p.y)) - bleed,
    maxX: Math.max(...placed.map((p) => p.x)) + bleed,
    maxY: Math.max(...placed.map((p) => p.y)) + bleed,
  };
}

/** The box the whole mark inks. */
const glyphBox: Box = BEE_GLYPH_SHAPES.map(inkedBox).reduce((union, box) => ({
  minX: Math.min(union.minX, box.minX),
  minY: Math.min(union.minY, box.minY),
  maxX: Math.max(union.maxX, box.maxX),
  maxY: Math.max(union.maxY, box.maxY),
}));

describe('the glyph is described once, and completely', () => {
  it('draws in a 64-unit square', () => {
    expect(BEE_GLYPH_VIEWBOX).toBe('0 0 64 64');
  });

  it('gives every shape a unique name', () => {
    const ids = BEE_GLYPH_SHAPES.map((shape) => shape.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries geometry only, so both renderers can spread it verbatim', () => {
    // A paint attribute here would be spelled `stroke-width` in SVG and `strokeWidth` in
    // JSX; keeping them out is what lets one description serve React and a string.
    const geometry = new Set(['d', 'cx', 'cy', 'rx', 'ry', 'transform']);
    const strays = BEE_GLYPH_SHAPES.flatMap((shape) =>
      Object.keys(shape.attrs)
        .filter((name) => !geometry.has(name))
        .map((name) => `${shape.id}: ${name}`),
    );
    expect(strays).toEqual([]);
  });

  it.each(BEE_GLYPH_SHAPES.map((shape) => [shape.id, shape] as const))(
    '%s declares the geometry its element needs',
    (_id, shape) => {
      if (shape.el === 'ellipse') {
        for (const attribute of ['cx', 'cy', 'rx', 'ry']) {
          expect(Number.isFinite(Number(shape.attrs[attribute]))).toBe(true);
        }
      } else {
        expect(String(shape.attrs.d)).toMatch(/^M/);
      }
    },
  );

  it('paints the honeycomb over the body, and the body over the wings', () => {
    // Paint order *is* the composition: the comb sits on the bee's back, the wings behind
    // it. Re-ordering the array silently re-draws the mark, so the order is asserted.
    const order = BEE_GLYPH_SHAPES.map((shape) => shape.id);
    expect(order.indexOf('wing-upper')).toBeLessThan(order.indexOf('abdomen'));
    expect(order.indexOf('abdomen')).toBeLessThan(order.indexOf('stripe-upper'));
    expect(order.indexOf('head')).toBeLessThan(order.indexOf('eye'));
    expect(order.indexOf('eye')).toBeLessThan(order.indexOf('comb-ring'));
    expect(order.slice(-3)).toEqual(['comb-ring', 'comb-face', 'comb-core']);
  });

  it('uses every brand role it defines a colour for', () => {
    const used = new Set(BEE_GLYPH_SHAPES.map((shape) => shape.part));
    expect([...used].sort()).toEqual(Object.keys(BEE_GLYPH_BRAND_PALETTE).sort());
  });
});

describe('nothing is clipped, at any size', () => {
  // The glyph is scale-free, so "crisp at 20, 26, 44 and 72 px" reduces to two properties
  // that hold at every size at once: the ink is inside the viewBox, and it is centred in
  // it. A shape that pokes out is cut off identically at 20 px and at 720 px.
  it.each(BEE_GLYPH_SHAPES.map((shape) => [shape.id, shape] as const))(
    '%s stays inside the viewBox',
    (_id, shape) => {
      const box = inkedBox(shape);
      expect(box.minX).toBeGreaterThanOrEqual(0);
      expect(box.minY).toBeGreaterThanOrEqual(0);
      expect(box.maxX).toBeLessThanOrEqual(64);
      expect(box.maxY).toBeLessThanOrEqual(64);
    },
  );

  it('fills the box it is given', () => {
    // A mark that used half its box would render at half the size every caller asked for.
    expect(glyphBox.maxX - glyphBox.minX).toBeGreaterThan(48);
    expect(glyphBox.maxY - glyphBox.minY).toBeGreaterThan(44);
  });

  it('sits centred, so a caller needs no padding of its own', () => {
    expect((glyphBox.minX + glyphBox.maxX) / 2).toBeCloseTo(32, 0);
    expect((glyphBox.minY + glyphBox.maxY) / 2).toBeCloseTo(32, 0);
  });
});

describe('the raster renderer', () => {
  const svg = renderBeeGlyphSvg({ size: 192 });

  it('renders every shape, in paint order', () => {
    const drawn = [...svg.matchAll(/<(path|ellipse)\s/g)].map((match) => match[1]);
    expect(drawn).toEqual(BEE_GLYPH_SHAPES.map((shape) => shape.el));
  });

  it('sizes the document and keeps the viewBox', () => {
    expect(svg).toContain('width="192" height="192"');
    expect(svg).toContain(`viewBox="${BEE_GLYPH_VIEWBOX}"`);
    expect(svg).toContain(`<g transform="${BEE_GLYPH_TRANSFORM}">`);
  });

  it('bakes in the brand hues, because Satori has no stylesheet', () => {
    for (const colour of new Set(Object.values(BEE_GLYPH_BRAND_PALETTE))) {
      expect(svg).toContain(`fill="${colour}"`);
    }
  });

  it('strokes the antennae rather than filling them', () => {
    const antenna = svg.slice(svg.indexOf('M28.8'));
    expect(antenna).toContain('fill="none"');
    expect(antenna).toContain(`stroke-width="${BEE_GLYPH_STROKE_WIDTH}"`);
    expect(antenna).toContain('stroke-linecap="round"');
  });

  it('keeps the wings translucent', () => {
    expect(svg).toContain(`opacity="${BEE_GLYPH_PART_OPACITY.wing}"`);
  });

  it('paints no background unless one is asked for', () => {
    expect(svg).not.toContain('<rect');
    expect(renderBeeGlyphSvg({ size: 180, background: '#FFFFFF', backgroundRadius: 8 })).toContain(
      '<rect width="64" height="64" rx="8" fill="#FFFFFF"/>',
    );
  });

  it('escapes an attribute rather than letting it close the tag', () => {
    const injected = renderBeeGlyphSvg({
      size: 32,
      palette: { ...BEE_GLYPH_BRAND_PALETTE, honey: '"><script>' },
    });
    expect(injected).not.toContain('<script>');
    expect(injected).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('the data URI', () => {
  it('round-trips the markup a browser will read', () => {
    const uri = beeGlyphDataUri({ size: 64 });
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
    expect(decoded).toBe(renderBeeGlyphSvg({ size: 64 }));
  });
});
