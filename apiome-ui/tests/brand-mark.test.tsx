/**
 * The brand mark component and the stylesheet behind it (HIVE-1.5, #5278).
 *
 * `BrandMark` is meant to be the *only* place the app knows what the brand looks like, so
 * the suite covers the three things that claim can fail on:
 *
 *   1. each variant renders what the design asks for — the bee alone, the shipped wordmark
 *      artwork, or the rail's bee + word lock-up — and names itself for assistive
 *      technology exactly once;
 *   2. the stylesheet holds up its half of the bargain: a class per brand role, an ink the
 *      six dark palettes lighten, and the `--brand-on-dark` switch that picks the wordmark
 *      file without JavaScript;
 *   3. nothing else in `src/` reaches for `Apiome-0*.png` or draws its own bee.
 *
 * `tests/bee-glyph.test.ts` covers the glyph's geometry and its raster renderer.
 */

import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import BrandMark from '../src/app/components/brand/BrandMark';
import BeeGlyph from '../src/app/components/brand/BeeGlyph';
import {
  BEE_GLYPH_BRAND_PALETTE,
  BEE_GLYPH_PART_OPACITY,
  BEE_GLYPH_SHAPES,
  BEE_GLYPH_STROKE_WIDTH,
} from '../src/app/components/brand/beeGlyph';
import {
  parseBlock,
  parseDeclarations,
  readGlobalsCss,
  readTokenLayer,
  readThemeBlocks,
  resolveToken,
  resolveThemeToken,
  topLevelRules,
} from './helpers/design-tokens';
import { themes } from '../src/app/config/themes';

const css = readGlobalsCss();
const layer = readTokenLayer(css);
const blocks = readThemeBlocks(css);

/** Every theme that paints on a dark base, from the catalogue rather than a second list. */
const DARK_THEMES = themes
  .filter((theme) => theme.appearance === 'dark')
  .map((theme) => theme.id);

/** Repository root, for the source sweeps. */
const APP_ROOT = join(__dirname, '..');

/**
 * The declarations of one top-level rule.
 *
 * @param selector The rule's exact prelude.
 * @returns Its declarations, property → value.
 */
function ruleFor(selector: string): Map<string, string> {
  const rule = topLevelRules(css).find((candidate) => candidate.prelude === selector);
  if (!rule) throw new Error(`no rule for "${selector}" in globals.css`);
  return parseDeclarations(rule.body);
}

/**
 * A PNG's intrinsic size, read from its header.
 *
 * @param path Absolute path to the file.
 * @returns Width and height in pixels.
 */
function pngSize(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

/**
 * Every source file under a directory.
 *
 * @param directory Absolute path to walk.
 * @param extensions Extensions to keep, with the leading dot.
 * @returns Absolute paths, in traversal order.
 */
function walk(directory: string, extensions: string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

describe('BeeGlyph', () => {
  it('draws every shape of the mark', () => {
    const { container } = render(<BeeGlyph />);
    expect(container.querySelectorAll('svg.bee-glyph > g > *')).toHaveLength(
      BEE_GLYPH_SHAPES.length,
    );
  });

  it('tags each shape with the brand role that paints it, and how', () => {
    const { container } = render(<BeeGlyph />);
    for (const shape of BEE_GLYPH_SHAPES) {
      const drawn = container.querySelectorAll(
        `.bee-glyph__${shape.part}.bee-glyph__${shape.paint}`,
      );
      expect(drawn.length).toBeGreaterThan(0);
    }
    expect(container.querySelectorAll('.bee-glyph__stroke')).toHaveLength(
      BEE_GLYPH_SHAPES.filter((shape) => shape.paint === 'stroke').length,
    );
  });

  it('hides itself from assistive technology when it has no name', () => {
    // The common case: a visible "apiome" or a link label already says what it is, and a
    // second announcement is noise.
    const { container } = render(<BeeGlyph />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
  });

  it('announces itself as an image when it is given one', () => {
    render(<BeeGlyph label="Apiome" />);
    const glyph = screen.getByRole('img', { name: 'Apiome' });
    expect(glyph).not.toHaveAttribute('aria-hidden');
  });

  it('sizes itself in pixels, and takes the rail size by default', () => {
    const { container } = render(<BeeGlyph size={72} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '72');

    const { container: byDefault } = render(<BeeGlyph />);
    expect(byDefault.querySelector('svg')).toHaveAttribute('width', '26');
  });

  it('switches to the one-colour tone on request', () => {
    const { container } = render(<BeeGlyph tone="mono" />);
    expect(container.querySelector('svg')).toHaveClass('bee-glyph', 'bee-glyph--mono');

    const { container: brand } = render(<BeeGlyph />);
    expect(brand.querySelector('svg')).not.toHaveClass('bee-glyph--mono');
  });
});

describe('BrandMark', () => {
  it('renders the bee alone for the glyph variant', () => {
    const { container } = render(<BrandMark variant="glyph" size={26} />);
    const svg = container.querySelector('svg.bee-glyph')!;
    expect(svg).toHaveAttribute('width', '26');
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAttribute('aria-label', 'Apiome');
  });

  it('renders both wordmark files, one per base, and names the pair once', () => {
    const { container } = render(<BrandMark variant="wordmark" />);

    const named = screen.getByRole('img', { name: 'Apiome' });
    expect(named).toHaveClass('brand-wordmark');

    const light = container.querySelector('.brand-wordmark__asset--light')!;
    const dark = container.querySelector('.brand-wordmark__asset--dark')!;
    expect(light.getAttribute('src')).toContain('Apiome-02.png');
    expect(dark.getAttribute('src')).toContain('Apiome-05.png');
    // Neither carries alt text: the wrapper is the image as far as a reader is concerned,
    // so alt text here would announce the brand two or three times over.
    expect(light).toHaveAttribute('alt', '');
    expect(dark).toHaveAttribute('alt', '');
  });

  it('drives the wordmark height from a custom property, not a hard-coded rule', () => {
    const { container } = render(<BrandMark variant="wordmark" size={48} />);
    expect(container.querySelector('.brand-wordmark')).toHaveStyle({
      '--brand-wordmark-h': '48px',
    });
  });

  it('sets the word as text in the lock-up, so the bee is not printed twice', () => {
    // `Apiome-02.png` already contains the bee; pairing the artwork with the glyph would
    // show two of them.
    const { container } = render(<BrandMark variant="lockup" sub="Platform" />);
    expect(screen.getByText('apiome')).toHaveClass('brand-lockup__name');
    expect(screen.getByText('Platform')).toHaveClass('brand-lockup__sub');
    expect(container.querySelector('img')).toBeNull();
    // The visible word is the accessible name, so the glyph beside it stays hidden.
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('omits the subtitle when the lock-up has none', () => {
    const { container } = render(<BrandMark variant="lockup" />);
    expect(container.querySelector('.brand-lockup__sub')).toBeNull();
  });

  it('goes silent for assistive technology when it is decoration', () => {
    const { container } = render(<BrandMark variant="wordmark" decorative />);
    expect(container.querySelector('.brand-wordmark')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();

    const { container: lockup } = render(<BrandMark variant="lockup" decorative />);
    expect(lockup.querySelector('.brand-lockup')).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes a caller-supplied class on every variant', () => {
    for (const variant of ['glyph', 'wordmark', 'lockup'] as const) {
      const { container } = render(<BrandMark variant={variant} className="mb-10" />);
      expect(container.firstElementChild).toHaveClass('mb-10');
    }
  });
});

describe('the stylesheet paints the glyph', () => {
  it.each(['ink', 'wing', 'comb', 'honey'])('gives the %s role a colour', (part) => {
    expect(ruleFor(`.bee-glyph__${part}`).get('--bee-part')).toBeDefined();
  });

  it('fills with the role colour and strokes with it too', () => {
    expect(ruleFor('.bee-glyph__fill').get('fill')).toBe('var(--bee-part)');

    const stroked = ruleFor('.bee-glyph__stroke');
    expect(stroked.get('fill')).toBe('none');
    expect(stroked.get('stroke')).toBe('var(--bee-part)');
    // The raster renderer writes this number inline; a drift would make the generated
    // favicon's antennae a different weight from the one on screen.
    expect(stroked.get('stroke-width')).toBe(String(BEE_GLYPH_STROKE_WIDTH));
  });

  it('keeps the wings at the same opacity both renderers use', () => {
    expect(ruleFor('.bee-glyph__wing').get('opacity')).toBe(String(BEE_GLYPH_PART_OPACITY.wing));
  });

  it('shades the one-colour tone so the comb still reads as rings', () => {
    const opacities = ['ink', 'comb', 'honey', 'wing'].map((part) =>
      Number(ruleFor(`.bee-glyph--mono .bee-glyph__${part}`).get('opacity')),
    );
    expect(new Set(opacities).size).toBe(opacities.length);
    for (const part of ['ink', 'comb', 'honey', 'wing']) {
      expect(ruleFor(`.bee-glyph--mono .bee-glyph__${part}`).get('--bee-part')).toBe('currentColor');
    }
  });
});

describe('the brand tokens', () => {
  it('declares the ink in the token layer, at the navy the mark is drawn in', () => {
    expect(layer.theme.has('--color-brand-ink')).toBe(true);
    expect(resolveToken('--color-brand-ink', layer)).toBe(BEE_GLYPH_BRAND_PALETTE.ink);
  });

  it('aliases it under the hive spelling the glyph reads', () => {
    expect(layer.root.get('--brand-ink')).toBe('var(--color-brand-ink)');
  });

  it('matches the raster palette to the tokens, hue for hue', () => {
    // The favicon and the on-screen mark are the same bee; the only reason two palettes
    // exist is that one of them has no stylesheet.
    expect(resolveToken('--color-brand-azure', layer)).toBe(BEE_GLYPH_BRAND_PALETTE.comb);
    expect(resolveToken('--color-brand-azure', layer)).toBe(BEE_GLYPH_BRAND_PALETTE.wing);
    expect(resolveToken('--color-brand-honey', layer)).toBe(BEE_GLYPH_BRAND_PALETTE.honey);
  });

  it('starts on the light wordmark', () => {
    expect(layer.theme.get('--brand-on-dark')).toBe('0');
  });

  it.each(DARK_THEMES)('%s lightens the ink and asks for the dark wordmark', (id) => {
    const block = blocks.get(id)!;
    expect(block.declarations.get('--brand-on-dark')).toBe('1');
    // Resolved rather than compared literally: each palette points the mark at its own ink.
    expect(resolveThemeToken('--color-brand-ink', layer, block)).not.toBe(
      BEE_GLYPH_BRAND_PALETTE.ink,
    );
  });

  it.each(themes.filter((theme) => theme.appearance === 'light').map((theme) => theme.id))(
    '%s leaves the mark in brand navy',
    (id) => {
      const block = blocks.get(id);
      expect(resolveThemeToken('--color-brand-ink', layer, block)).toBe(
        BEE_GLYPH_BRAND_PALETTE.ink,
      );
    },
  );

  it('rides the dark wordmark on `.dark` too, for the routes with no ThemeProvider', () => {
    expect(blocks.get('dark')?.prelude).toContain('html.dark:not([data-theme])');
  });
});

describe('the stylesheet swaps the wordmark', () => {
  it('shows exactly one of the two files, from the theme switch', () => {
    expect(ruleFor('.brand-wordmark__asset--light').get('opacity')).toBe(
      'calc(1 - var(--brand-on-dark))',
    );
    expect(ruleFor('.brand-wordmark__asset--dark').get('opacity')).toBe('var(--brand-on-dark)');
  });

  it('stacks them in one grid cell, at the artwork’s own ratio', () => {
    expect(ruleFor('.brand-wordmark__asset').get('grid-area')).toBe('1 / 1');

    const { width, height } = pngSize(join(APP_ROOT, 'public', 'Apiome-02.png'));
    expect(ruleFor('.brand-wordmark').get('aspect-ratio')).toBe(`${width} / ${height}`);
    // Both files must share that ratio, or the swap would resize the header.
    expect(pngSize(join(APP_ROOT, 'public', 'Apiome-05.png'))).toEqual({ width, height });
  });

  it('sizes from the custom property the component sets', () => {
    expect(ruleFor('.brand-wordmark').get('height')).toContain('var(--brand-wordmark-h');
  });
});

describe('the lock-up follows the type scale, not fixed pixels', () => {
  it('sets the word and its subtitle from tokens', () => {
    // A `px` font size here would ignore the font-scale preference (HIVE-1.3).
    for (const selector of ['.brand-lockup__name', '.brand-lockup__sub']) {
      const declarations = ruleFor(selector);
      expect(declarations.get('font-size')).toMatch(/^var\(--fs-/);
      expect(declarations.get('letter-spacing')).toMatch(/^var\(--track-/);
    }
    expect(ruleFor('.brand-lockup').get('gap')).toMatch(/^var\(--space-/);
  });
});

describe('the mark has exactly one owner', () => {
  const sources = walk(join(APP_ROOT, 'src'), ['.ts', '.tsx']);

  it('lets only BrandMark name the wordmark files', () => {
    // The public path, not the word: prose that mentions `Apiome-07.png` is documentation,
    // and `"/Apiome-02.png"` is a component deciding for itself what the brand looks like.
    const offenders = sources
      .filter((path) => /\/Apiome-0\d\.png/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(APP_ROOT.length + 1));
    expect(offenders).toEqual(['src/app/components/brand/BrandMark.tsx']);
  });

  it('leaves no raster bee behind either', () => {
    const offenders = sources
      .filter((path) => /\/bee-logo\.png/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(APP_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('puts the mark on the surfaces the ticket names', () => {
    for (const surface of [
      join('src', 'app', 'components', 'ade', 'TopHeader.tsx'),
      join('src', 'app', 'components', 'ade', 'AdeHome.tsx'),
      join('src', 'app', 'login', 'LoginClient.tsx'),
      join('src', 'app', 'login', '2fa', 'TwoFactorClient.tsx'),
      join('src', 'app', 'admin', 'AdminLoginClient.tsx'),
    ]) {
      expect(readFileSync(join(APP_ROOT, surface), 'utf8')).toContain('<BrandMark');
    }
  });
});

describe('the icon routes draw from the same glyph', () => {
  const icon = readFileSync(join(APP_ROOT, 'src', 'app', 'icon.tsx'), 'utf8');
  const appleIcon = readFileSync(join(APP_ROOT, 'src', 'app', 'apple-icon.tsx'), 'utf8');

  it.each([
    ['icon.tsx', icon],
    ['apple-icon.tsx', appleIcon],
  ])('%s renders the shared glyph rather than a traced PNG', (_name, source) => {
    expect(source).toContain('beeGlyphDataUri');
    expect(source).toContain("from 'next/og'");
    expect(source).toContain("export const contentType = 'image/png'");
  });

  it('covers the browser tab and the installed-app icon', () => {
    expect(icon).toContain('generateImageMetadata');
    for (const edge of [32, 192, 512]) {
      expect(icon).toContain(`edge: ${edge}`);
    }
  });

  it('gives the Apple icon an opaque plate, because iOS composites on black', () => {
    expect(appleIcon).toContain('background: PLATE');
    expect(appleIcon).toMatch(/width: 180, height: 180/);
  });
});

describe('the glyph classes are declared where the token layer can reach them', () => {
  it('keeps the brand section inside globals.css, not a module', () => {
    // A CSS module would scope the class names and the theme swap would never reach them.
    expect(css).toContain('BRAND MARK (HIVE-1.5, #5278)');
    expect(parseBlock(css, ':root').has('--brand-ink')).toBe(true);
  });
});
