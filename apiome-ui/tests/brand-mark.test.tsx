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
import { BEE_LOGO_FILE } from '../src/app/components/brand/beeGlyph';
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
  it('draws the shipped artwork rather than a drawing of it', () => {
    // The whole point of the change this suite was rewritten for: one bee, and it is the
    // file the brand ships. `next/image` rewrites the `src` into its own optimiser URL, so
    // the file name is what survives to assert on.
    const { container } = render(<BeeGlyph />);
    const image = container.querySelector('img.bee-glyph')!;
    expect(image.getAttribute('src')).toContain(BEE_LOGO_FILE);
  });

  it('hides itself from assistive technology when it has no name', () => {
    // The common case: a visible "apiome" or a link label already says what it is, and a
    // second announcement is noise. An empty `alt` is what takes an image out of the tree.
    const { container } = render(<BeeGlyph />);
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('announces itself as an image when it is given one', () => {
    render(<BeeGlyph label="Apiome" />);
    expect(screen.getByRole('img', { name: 'Apiome' })).toBeInTheDocument();
  });

  it('sizes itself in pixels, and takes the rail size by default', () => {
    const { container } = render(<BeeGlyph size={72} />);
    const image = container.querySelector('img')!;
    // Square: the caller gives one edge, because the artwork is square.
    expect(image).toHaveAttribute('width', '72');
    expect(image).toHaveAttribute('height', '72');

    const { container: byDefault } = render(<BeeGlyph />);
    expect(byDefault.querySelector('img')).toHaveAttribute('width', '26');
  });

  it('takes a caller-supplied class alongside its own', () => {
    const { container } = render(<BeeGlyph className="mb-10" />);
    expect(container.querySelector('img')).toHaveClass('bee-glyph', 'mb-10');
  });
});

describe('BrandMark', () => {
  it('renders the bee alone for the glyph variant', () => {
    const { container } = render(<BrandMark variant="glyph" size={26} />);
    const bee = container.querySelector('img.bee-glyph')!;
    expect(bee).toHaveAttribute('width', '26');
    expect(bee).toHaveAttribute('alt', 'Apiome');
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
    // `Apiome-02.png` already contains the bee; pairing that artwork with the glyph would
    // show two of them, so the lock-up pairs the bee with the word set as text.
    const { container } = render(<BrandMark variant="lockup" sub="Platform" />);
    expect(screen.getByText('apiome')).toHaveClass('brand-lockup__name');
    expect(screen.getByText('Platform')).toHaveClass('brand-lockup__sub');
    expect(container.querySelector('.brand-wordmark')).toBeNull();
    // The visible word is the accessible name, so the bee beside it stays unnamed.
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img.bee-glyph')).toHaveAttribute('alt', '');
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

describe('the stylesheet places the glyph', () => {
  it('never lets the mark be what gives way in a tight row', () => {
    // The rail's brand row and the ADE header are both flex containers that run out of
    // room; without this the bee is the first thing squashed.
    expect(ruleFor('.bee-glyph').get('flex')).toBe('none');
  });

  it('keeps the artwork square whatever box it lands in', () => {
    // `.hive-empty-art` sizes its art in per cent of a square plate, not in pixels, so the
    // bee is one of the few images here whose box is not set from its own ratio.
    expect(ruleFor('.bee-glyph').get('object-fit')).toBe('contain');
  });

  it('sizes the empty state’s art whether it is an icon or the bee', () => {
    // The art is a Lucide `svg` or the bee `img` depending on the `brand` prop; a rule that
    // named only one of them would leave the other at its intrinsic size.
    const art = ruleFor('.hive-empty-art > :is(svg, img)');
    expect(art.get('width')).toBe('34%');
    expect(art.get('height')).toBe('34%');
  });
});

describe('the brand tokens', () => {
  it('declares the brand ink in the token layer, at the brand navy', () => {
    expect(layer.theme.has('--color-brand-ink')).toBe(true);
    expect(resolveToken('--color-brand-ink', layer)).toBe(resolveToken('--color-brand-navy', layer));
  });

  it('aliases it under the hive spelling', () => {
    expect(layer.root.get('--brand-ink')).toBe('var(--color-brand-ink)');
  });

  it('starts on the light wordmark', () => {
    expect(layer.theme.get('--brand-on-dark')).toBe('0');
  });

  it.each(DARK_THEMES)('%s lightens the ink and asks for the dark wordmark', (id) => {
    const block = blocks.get(id)!;
    expect(block.declarations.get('--brand-on-dark')).toBe('1');
    // Resolved rather than compared literally: each palette points the token at its own
    // ink. The mark itself no longer reads this — it is artwork, and its navy is fixed —
    // but the token is still the brand's ink for anything that has to survive a dark base.
    expect(resolveThemeToken('--color-brand-ink', layer, block)).not.toBe(
      resolveToken('--color-brand-navy', layer),
    );
  });

  it.each(themes.filter((theme) => theme.appearance === 'light').map((theme) => theme.id))(
    '%s leaves the brand ink in navy',
    (id) => {
      const block = blocks.get(id);
      expect(resolveThemeToken('--color-brand-ink', layer, block)).toBe(
        resolveToken('--color-brand-navy', layer),
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

  it('lets only the asset module name the bee', () => {
    // Quoted with `'` or `"` — an actual string literal. Backticks are left out on
    // purpose: every module in the brand folder names the artwork in its doc comment to say
    // where the bee comes from, and prose is not a second copy of the decision. Both the
    // fetched path and the bare file name count, since `beeLogoFile.ts` reads it off disk —
    // and it does that through the constant rather than by spelling the name again.
    const offenders = sources
      .filter((path) => /['"]\/?bee-logo\.png['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(APP_ROOT.length + 1));
    expect(offenders).toEqual(['src/app/components/brand/beeGlyph.ts']);
  });

  it('puts the mark on the surfaces the ticket names', () => {
    for (const surface of [
      join('src', 'app', 'components', 'shell', 'AppShell.tsx'),
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
  ])('%s embeds the shipped artwork rather than art of its own', (_name, source) => {
    // Satori has no `public/`, so the bytes have to be inlined — `beeLogoDataUri` is the
    // one reader that does it, and `tests/bee-glyph.test.ts` checks it reads the real file.
    expect(source).toContain('beeLogoDataUri');
    expect(source).toContain("from 'next/og'");
    expect(source).toContain("export const contentType = 'image/png'");
  });

  it('covers the browser tab and the installed-app icon', () => {
    expect(icon).toContain('generateImageMetadata');
    for (const edge of [32, 192, 512]) {
      expect(icon).toContain(`edge: ${edge}`);
    }
  });

  it('awaits the id Next asks it for, so each size is really that size', () => {
    // Next passes `id` as a promise. Compared unawaited it matches no entry of ICON_SIZES,
    // the `?? ICON_SIZES[0].edge` fallback takes over, and every route serves a 32 px image
    // under a `<link sizes="512x512">` — silently, because the route still returns a PNG.
    expect(icon).toMatch(/export default async function Icon/);
    expect(icon).toMatch(/await id/);
    // The comparison has to use the awaited value, not the promise it came from.
    expect(icon).toMatch(/icon\.id === requested/);
  });

  it('gives the Apple icon an opaque plate, because iOS composites on black', () => {
    expect(appleIcon).toContain('background: PLATE');
    expect(appleIcon).toMatch(/width: 180, height: 180/);
  });
});

describe('the brand classes are declared where the token layer can reach them', () => {
  it('keeps the brand section inside globals.css, not a module', () => {
    // A CSS module would scope the class names and the wordmark swap would never reach them.
    expect(css).toContain('BRAND MARK (HIVE-1.5, #5278)');
    expect(parseBlock(css, ':root').has('--brand-ink')).toBe(true);
  });
});
