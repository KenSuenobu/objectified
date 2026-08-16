/**
 * The stylesheet half of the feedback set (HIVE-2.5, #5284).
 *
 * `tests/hive-feedback-set.test.tsx` proves what the components render. jsdom compiles no
 * CSS, so it cannot see the four things that only exist in `globals.css` — and each of them
 * is load-bearing rather than decorative:
 *
 *   1. **The hexagon is one hexagon.** The empty-state art and the workspace avatar clip to
 *      the same `--hex-clip` token, so "the same shape everywhere" is a fact about the
 *      stylesheet and not a coincidence between two copies of six numbers.
 *   2. **The art owns its glyph.** `.hive-empty-art > svg` is a descendant selector —
 *      specificity (0,1,1) — precisely so it outranks the `text-white` / `h-10 w-10`
 *      utilities that forty-two pre-Hive call sites still pass for the gradient tile this
 *      ticket removed. If it were written as `.hive-empty-art svg` inside a layer, or as a
 *      utility, those call sites would paint a white glyph on a honey hexagon.
 *   3. **The art is proportional.** The inner hexagon and the glyph are percentages of the
 *      art box, so one rule set serves the 88 px, 64 px and 52 px sizes, and all three
 *      follow the font-size preference.
 *   4. **Nothing here names a colour.** Every tone is a `var()` at a Hive token, so the nine
 *      themes reach the art without the component knowing they exist.
 *
 * Companion to `tests/hive-design-tokens.test.ts` (the token layer),
 * `tests/hive-primitive-tokens.test.ts` (the HIVE-2.1 control chrome) and
 * `tests/hive-new-primitive-styles.test.ts` (the HIVE-2.2 silhouette and motion).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import {
  findUnfencedHex,
  parseDeclarations,
  readGlobalsCss,
  readTokenLayer,
  resolveToken,
  stripCssComments,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const layer = readTokenLayer(css);

/** Repository root of `apiome-ui`. */
const APP_ROOT = join(__dirname, '..');

/**
 * The one top-level rule with that exact prelude.
 *
 * @param prelude Whitespace-collapsed selector text.
 * @returns The rule.
 * @throws If the stylesheet has no such rule, or more than one.
 */
function rule(prelude: string): CssRule {
  const matches = rules.filter((candidate) => candidate.prelude === prelude);
  if (matches.length !== 1) {
    throw new Error(`globals.css has ${matches.length} rules with prelude \`${prelude}\``);
  }
  return matches[0];
}

/** Declarations of the rule with that prelude. */
const declarationsOf = (prelude: string) => parseDeclarations(rule(prelude).body);

/** Every `.ts`/`.tsx` file under a directory, recursively, as repo-relative paths. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (absolute: string) => {
    for (const entry of readdirSync(absolute)) {
      const child = join(absolute, entry);
      if (statSync(child).isDirectory()) walk(child);
      else if (['.ts', '.tsx'].includes(extname(child))) found.push(relative(APP_ROOT, child));
    }
  };
  walk(join(APP_ROOT, dir));
  return found;
}

/** Every source file naming `needle`, as repository-relative paths. */
function callersOf(needle: string): string[] {
  return sourceFiles('src').filter((path) => readFileSync(join(APP_ROOT, path), 'utf8').includes(needle));
}

describe('the hex art (hive.css §14 `.empty__art`)', () => {
  const art = declarationsOf('.hive-empty-art');
  const outer = declarationsOf('.hive-empty-art__hex');
  const inner = declarationsOf('.hive-empty-art__hex--inner');

  it('clips to the one shared hexagon rather than a second copy of it', () => {
    expect(outer.get('clip-path')).toBe('var(--hex-clip)');
    expect(resolveToken('--hex-clip', layer)).toBe(
      'polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0 50%)'
    );
    // The avatar reads the same token — DESIGN.md §2 has one hexagon, not two.
    expect(declarationsOf('.avatar-hex').get('clip-path')).toBe('var(--hex-clip)');
  });

  it('positions the hexagons so the glyph can sit on top of them', () => {
    expect(art.get('position')).toBe('relative');
    expect(art.get('display')).toBe('grid');
    expect(outer.get('position')).toBe('absolute');
    expect(outer.get('inset')).toBe('0');
  });

  it('nests the inner hexagon and sizes the glyph in percentages, not lengths', () => {
    // One rule set has to serve the 88 px block art and the 52 px inline art, and both have
    // to follow the font-size preference. A frozen inset would only ever fit one of them.
    expect(inner.get('inset')).toMatch(/%$/);
    const glyph = declarationsOf('.hive-empty-art > svg');
    expect(glyph.get('width')).toMatch(/%$/);
    expect(glyph.get('height')).toMatch(/%$/);
  });

  it('reaches the glyph as a descendant, so a call site’s own classes cannot win', () => {
    // `.hive-empty-art > svg` is (0,1,1); `.text-white` and `.h-10` are (0,1,0). That one
    // point of specificity is the whole migration strategy for the forty-two call sites
    // still passing the old gradient tile's utilities.
    const prelude = rules.find((candidate) => candidate.prelude === '.hive-empty-art > svg');
    expect(prelude).toBeDefined();
    const glyph = declarationsOf('.hive-empty-art > svg');
    expect(glyph.get('color')).toBe('var(--empty-art-ink)');
    // Unlayered, like the rest of this stylesheet's component rules — a rule inside
    // `@layer` would lose to every utility whatever its specificity.
    expect([...stripCssComments(css).matchAll(/@layer\s+[^{]*\{/g)]).toHaveLength(0);
  });

  it('carries honey as its own default, because that is what DESIGN.md §2 reserves it for', () => {
    expect(art.get('--empty-art-tint')).toBe('var(--honey)');
    expect(art.get('--empty-art-fill')).toBe('var(--honey-soft)');
    expect(art.get('--empty-art-ink')).toBe('var(--honey-fg)');
  });

  it.each([
    ['danger', 'danger'],
    ['neutral', 'neutral'],
  ])('re-tints wholesale for the %s tone', (modifier, role) => {
    const tone = declarationsOf(`.hive-empty-art--${modifier}`);
    // All three properties move together: a fill from one role under ink from another is
    // how a contrast pair silently stops being a pair.
    expect(tone.get('--empty-art-tint')).toBe(`var(--${role})`);
    expect(tone.get('--empty-art-fill')).toBe(`var(--${role}-soft)`);
    expect(tone.get('--empty-art-ink')).toBe(`var(--${role}-fg)`);
  });

  it('mixes the inner hexagon from the tone, so a re-tinted theme re-tints it too', () => {
    const background = inner.get('background') ?? '';
    expect(background).toContain('color-mix(in srgb, var(--empty-art-tint)');
    expect(background).toContain('var(--bg-surface)');
  });

  it('is asked for by the feedback set, and by nothing else', () => {
    // One shared definition is what keeps every empty state the same empty state; a second
    // file naming the class is a copy waiting to drift.
    expect(callersOf('hive-empty-art')).toEqual(['src/app/components/ui/EmptyState.tsx']);
  });
});

describe('the skeleton shimmer (hive.css §14 `.skeleton`)', () => {
  const skeleton = declarationsOf('.hive-skeleton');
  const sweep = declarationsOf('.hive-skeleton::after');

  it('is the inset surface at the small radius, both from tokens', () => {
    expect(skeleton.get('background')).toBe('var(--bg-inset)');
    expect(skeleton.get('border-radius')).toBe('var(--r-sm)');
  });

  it('sweeps a band rather than pulsing — arriving, not blinking', () => {
    expect(skeleton.get('overflow')).toBe('hidden');
    expect(sweep.get('transform')).toBe('translateX(-100%)');
    expect(sweep.get('animation')).toContain('hive-shimmer');
    expect(css).toContain('@keyframes hive-shimmer');
  });

  it('tints the band from the surface token, so it reads on all nine themes', () => {
    // A fixed white band is invisible on a light base and a glare on a dark one.
    expect(sweep.get('background')).toContain('var(--bg-surface)');
    expect(sweep.get('background')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('needs no reduced-motion rule of its own', () => {
    // Both blocks zero every animation duration, which parks the band off the left edge and
    // leaves a still placeholder — so the preference reaches this for free.
    expect(css).toMatch(/html\[data-motion="reduce"\] \*[\s\S]*?animation-duration: 0ms !important/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: 0ms !important/
    );
  });

  it('is asked for by the Skeleton primitive, and by nothing else', () => {
    expect(callersOf('hive-skeleton')).toEqual(['src/app/components/ui/Skeleton.tsx']);
  });
});

describe('the feedback section names no colour of its own', () => {
  it('spells no raw hex outside the three fenced allow-lists', () => {
    // The section is new, so this would catch a hue smuggled in with it; the fences are the
    // token layer, the per-theme swaps and the fixed identity hues, and none of them is here.
    expect(findUnfencedHex(css)).toEqual([]);
  });

  it('states every feedback colour as a token reference', () => {
    const section = /FEEDBACK SET \(HIVE-2\.5[\s\S]*?(?=\n\/\* =====)/.exec(css);
    expect(section).not.toBeNull();
    const body = stripCssComments(section![0]);
    // No `rgb()`, no `hsl()`, no named hue — only `var()` and the achromatic `transparent`
    // a gradient needs for its two ends.
    expect(body).not.toMatch(/\b(?:rgba?|hsla?)\(/);
    expect(body).not.toMatch(/:\s*(?:white|black|red|green|blue|orange|gold)\b/);
  });
});
