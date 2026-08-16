/**
 * The stylesheet half of the metrics set (HIVE-2.6, #5285).
 *
 * `tests/hive-metrics-set.test.tsx` proves what the components render. jsdom compiles no CSS,
 * so it cannot see the four things that only exist in `globals.css` — and each one is a claim
 * the ticket is judged on rather than a detail of styling:
 *
 *   1. **One paint channel.** Every mark in the kit — the ring's arc, the progress fill, the
 *      sparkline's line and its soft area — paints `currentColor`, and the component sets
 *      `color` with a single token class. If any of them grew a `stroke:` or `background:` of
 *      its own, adding a tone would silently miss it and the acceptance criterion "charts
 *      inherit theme tokens" would hold for some marks and not others.
 *   2. **Nothing here names a colour.** Every colour is a `var()` at a Hive token (or a
 *      `color-mix` of two), which is what lets all nine themes reach the marks.
 *   3. **Nothing here freezes a size.** The three ring sizes, the type inside a stat and the
 *      breakpoint the stat strip folds at are `rem`/`em`, so the font-scale and density
 *      preferences move the whole assembly rather than pulling chrome and text apart.
 *   4. **Every class the components emit exists.** The class names are derived from the
 *      sources rather than listed here, so a renamed element fails this suite instead of
 *      silently rendering unstyled.
 *
 * Companion to `tests/hive-design-tokens.test.ts` (the token layer),
 * `tests/hive-primitive-tokens.test.ts` (the HIVE-2.1 control chrome) and
 * `tests/hive-feedback-styles.test.ts` (the HIVE-2.5 hex art and shimmer).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  findUnfencedHex,
  parseDeclarations,
  readGlobalsCss,
  readTokenLayer,
  resolveToken,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const layer = readTokenLayer(css);

/** Absolute path of the metrics module. */
const METRICS_DIR = join(__dirname, '..', 'src', 'app', 'components', 'ui', 'metrics');

/** Source of every file in the metrics module, keyed by file name. */
const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  readdirSync(METRICS_DIR)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => [name, readFileSync(join(METRICS_DIR, name), 'utf8')]),
);

/**
 * Strip comments from a TypeScript source.
 *
 * The doc comments in this module quote *other* modules' classes by name (`.hive-empty-art`),
 * so scanning them for class names would invent classes nothing renders.
 *
 * @param source Raw file text.
 * @returns The same text with block and line comments removed.
 */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every `hive-*` class name the components put into markup. */
const EMITTED_CLASSES: readonly string[] = Array.from(
  new Set(
    Object.values(SOURCES).flatMap(
      (source) => stripTsComments(source).match(/\bhive-[a-z0-9_-]+/g) ?? [],
    ),
  ),
).sort();

/**
 * Every top-level rule whose selector mentions one of the metrics classes.
 *
 * Anchored on the five block names rather than on `.hive-` alone, so the HIVE-2.5 feedback
 * rules (`.hive-empty-art`, `.hive-skeleton`) stay out of this ticket's assertions.
 */
const METRIC_RULES: readonly CssRule[] = rules.filter((rule) =>
  /\.hive-(?:stat|ring|sparkline|meter|progress)[a-z0-9_-]*/.test(rule.prelude),
);

/**
 * The one top-level rule with that exact selector.
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

/** Declarations of the rule with that selector. */
const declarationsOf = (prelude: string) => parseDeclarations(rule(prelude).body);

/** Every `var(--token)` name referenced in a chunk of CSS. */
function referencedTokens(source: string): string[] {
  return Array.from(source.matchAll(/var\(\s*(--[-a-z0-9]+)/g)).map((match) => match[1]);
}

// ============================================================================
// 1. Every class the components emit has a rule
// ============================================================================

describe('the metrics classes', () => {
  it('emits a non-trivial set — the derivation itself is load-bearing', () => {
    // If the regex above ever stopped matching, every assertion below would pass vacuously.
    expect(EMITTED_CLASSES.length).toBeGreaterThanOrEqual(12);
    expect(EMITTED_CLASSES).toContain('hive-ring');
    expect(EMITTED_CLASSES).toContain('hive-stat-grid');
  });

  it('has a rule in globals.css for every class the components render', () => {
    const styled = new Set(
      METRIC_RULES.flatMap((entry) => entry.prelude.match(/hive-[a-z0-9_-]+/g) ?? []),
    );
    const unstyled = EMITTED_CLASSES.filter((name) => !styled.has(name));
    expect(unstyled).toEqual([]);
  });

  it('styles nothing the components never render', () => {
    const emitted = new Set<string>(EMITTED_CLASSES);
    const orphans = Array.from(
      new Set(METRIC_RULES.flatMap((entry) => entry.prelude.match(/hive-[a-z0-9_-]+/g) ?? [])),
    ).filter((name) => !emitted.has(name));
    expect(orphans).toEqual([]);
  });
});

// ============================================================================
// 2. One paint channel
// ============================================================================

describe('every mark paints currentColor', () => {
  it.each([
    ['.hive-progress__fill', 'background'],
    ['.hive-ring__arc', 'stroke'],
    ['.hive-sparkline__line', 'stroke'],
    ['.hive-sparkline__area', 'fill'],
    ['.hive-sparkline__point', 'fill'],
  ])('%s takes its %s from the tone the component set', (selector, property) => {
    expect(declarationsOf(selector).get(property)).toBe('currentColor');
  });

  it('leaves no mark with a colour of its own to drift from the tone', () => {
    const MARKS = [
      '.hive-progress__fill',
      '.hive-ring__arc',
      '.hive-sparkline__line',
      '.hive-sparkline__area',
      '.hive-sparkline__point',
    ];
    for (const selector of MARKS) {
      for (const [property, value] of declarationsOf(selector)) {
        if (!['background', 'stroke', 'fill'].includes(property)) continue;
        // `fill: none` on a stroked path is the absence of a mark, not a colour.
        if (value === 'none') continue;
        expect([value]).toContain('currentColor');
      }
    }
  });

  it('draws the track and the ink from tokens, because they are not the tone', () => {
    // The track is the *absence* of the mark, and the ring's figure is page ink — a two-digit
    // number at 9 px has no contrast budget to spend on a hue.
    expect(declarationsOf('.hive-progress').get('background')).toBe('var(--bg-inset)');
    expect(declarationsOf('.hive-ring__track').get('stroke')).toBe('var(--bg-inset)');
    expect(declarationsOf('.hive-ring__figure').get('fill')).toBe('var(--fg)');
    expect(declarationsOf('.hive-ring[data-scored="false"] .hive-ring__figure').get('fill')).toBe(
      'var(--fg-muted)',
    );
  });

  it('spends no text ink below the AA floor', () => {
    // `--fg-subtle` measures 3.4:1 on the canvas and `--fg-faint` 2.1:1 — both are serious axe
    // findings for copy, which is why the stat's unit and footnote and the unscored ring's
    // glyph take `--fg-muted` even though hive.css sets them quieter. The one place `subtle`
    // survives is the stat label's *glyph*, which is decoration beside its own label and is
    // judged against the 3:1 non-text threshold.
    const TEXT_RULES = [
      '.hive-stat__value small',
      '.hive-stat__foot',
      '.hive-meter__label',
      '.hive-ring[data-scored="false"] .hive-ring__figure',
    ];
    for (const selector of TEXT_RULES) {
      const ink = declarationsOf(selector).get('color') ?? declarationsOf(selector).get('fill');
      expect({ selector, ink }).not.toEqual({ selector, ink: 'var(--fg-subtle)' });
      expect({ selector, ink }).not.toEqual({ selector, ink: 'var(--fg-faint)' });
    }
  });
});

// ============================================================================
// 3. Nothing names a colour; every token resolves
// ============================================================================

describe('the metrics rules name no colour', () => {
  it('spells every colour as a token, never as a literal', () => {
    for (const entry of METRIC_RULES) {
      expect(entry.body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(entry.body).not.toMatch(/\b(rgba?|hsla?)\(/);
    }
  });

  it('adds no hex to the stylesheet outside the allow-listed fences', () => {
    // The whole-file guard `tests/hive-design-tokens.test.ts` also runs, but stating it here
    // keeps the failure next to the section that would have caused it.
    expect(findUnfencedHex(css)).toEqual([]);
  });

  it('references only tokens that actually resolve', () => {
    // The kit's own local properties (`--ring-size`, `--progress-value`, `--progress-tick`) are
    // declared by these rules or set inline by the components; they are not design tokens and
    // have nothing to resolve to in the token layer.
    const local = new Set(
      METRIC_RULES.flatMap((entry) =>
        Array.from(parseDeclarations(entry.body).keys()).filter((name) => name.startsWith('--')),
      ),
    );
    local.add('--progress-value');
    local.add('--progress-tick');

    const referenced = Array.from(
      new Set(METRIC_RULES.flatMap((e) => referencedTokens(e.body))),
    ).filter((token) => !local.has(token));
    expect(referenced.length).toBeGreaterThan(0);
    for (const token of referenced) {
      // Throws with a readable message if the token is undeclared or its chain dangles.
      expect(typeof resolveToken(token, layer)).toBe('string');
    }
  });

  it('reaches the semantic role tokens the tone table names, so `text-ok` is a real utility', () => {
    for (const tone of ['neutral', 'ok', 'warn', 'danger', 'accent', 'honey', 'violet']) {
      expect(resolveToken(`--color-${tone}`, layer)).toBeTruthy();
    }
  });

  it('mixes the stripe highlight from the ink that sits on a solid fill', () => {
    // A literal white would be the obvious way to write this, and would be wrong the moment a
    // theme's `--fg-on-accent` stopped being white.
    const striped = declarationsOf('.hive-progress--striped .hive-progress__fill');
    expect(striped.get('background-image')).toContain('var(--fg-on-accent)');
  });
});

// ============================================================================
// 4. Nothing freezes a size
// ============================================================================

describe('the metrics rules freeze no size', () => {
  /**
   * `px` lengths that are genuinely physical rather than typographic, and may stay.
   *
   * A hairline is one device pixel by definition — growing it with the font scale would turn a
   * rule into a border. Everything else in the section has to be relative.
   */
  const PHYSICAL_PX = new Set(['gap', 'width', 'stroke-width']);

  it('states every type size and box in rem, em, % or ch', () => {
    const offenders: string[] = [];
    for (const entry of METRIC_RULES) {
      for (const [property, value] of parseDeclarations(entry.body)) {
        if (!/\b\d*\.?\d+px\b/.test(value)) continue;
        // The two hairlines: the 1 px grid gap and the 1 px threshold tick.
        if (PHYSICAL_PX.has(property) && /^1px$/.test(value.trim())) continue;
        offenders.push(`${entry.prelude} { ${property}: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sizes the three rings in rem, so a figure and the hoop round it grow together', () => {
    expect(declarationsOf('.hive-ring').get('--ring-size')).toMatch(/rem$/);
    expect(declarationsOf('.hive-ring[data-size="sm"]').get('--ring-size')).toMatch(/rem$/);
    expect(declarationsOf('.hive-ring[data-size="lg"]').get('--ring-size')).toMatch(/rem$/);
  });

  it('folds the stat strip at an em breakpoint, so a larger scale folds sooner', () => {
    const collapse = rules.filter(
      (entry) => entry.prelude.startsWith('@media') && /hive-stat-grid/.test(entry.body),
    );
    expect(collapse).toHaveLength(1);
    expect(collapse[0].prelude).toMatch(/\d+(\.\d+)?em\)/);
    expect(collapse[0].prelude).not.toMatch(/\d+px\)/);
  });

  it('derives the stat block from the density-aware card and space tokens', () => {
    const stat = declarationsOf('.hive-stat');
    expect(stat.get('padding')).toContain('var(--card-pad)');
    expect(stat.get('gap')).toContain('var(--space-1)');
    expect(declarationsOf('.hive-stat__value').get('font-size')).toBe('var(--fs-4xl)');
  });

  it('sizes the stat glyph from the §3.5 icon vocabulary rather than a literal', () => {
    const glyph = declarationsOf('.hive-stat__label > svg');
    expect(glyph.get('width')).toBe('var(--icon-dense)');
    expect(glyph.get('height')).toBe('var(--icon-dense)');
  });
});

// ============================================================================
// 5. Behaviour that only the stylesheet can carry
// ============================================================================

describe('what only the stylesheet can do', () => {
  it('animates the stripe, so the reduce-motion block can stop it', () => {
    // `html[data-motion="reduce"] *` zeroes every animation duration. An inline React
    // `transition`/`animation` would be out of that block's reach.
    expect(declarationsOf('.hive-progress--striped .hive-progress__fill').get('animation')).toMatch(
      /hive-stripes/,
    );
    expect(rules.some((entry) => entry.prelude === '@keyframes hive-stripes')).toBe(true);
  });

  it('transitions the bar and the arc from the motion tokens', () => {
    expect(declarationsOf('.hive-progress__fill').get('transition')).toContain('var(--dur-slow)');
    expect(declarationsOf('.hive-ring__arc').get('transition')).toContain('var(--dur-slow)');
  });

  it('reads its geometry from the custom properties the components set', () => {
    expect(declarationsOf('.hive-progress__fill').get('width')).toContain('--progress-value');
    expect(declarationsOf('.hive-progress__tick').get('left')).toContain('--progress-tick');
  });

  it('gives the sparkline one proportion for the whole product', () => {
    expect(declarationsOf('.hive-sparkline').get('aspect-ratio')).toBeTruthy();
  });

  it('keeps the sparkline stroke the same weight of pen at any width', () => {
    expect(declarationsOf('.hive-sparkline__line').get('vector-effect')).toBe('non-scaling-stroke');
  });

  it('draws the stat strip as hairlines rather than as N bordered cards', () => {
    const grid = declarationsOf('.hive-stat-grid');
    expect(grid.get('gap')).toBe('1px');
    expect(grid.get('background')).toBe('var(--border)');
    expect(declarationsOf('.hive-stat-grid > *').get('background')).toBe('var(--bg-surface)');
  });

  it('out-specifies a call site that styles its own stat glyph', () => {
    // `.hive-stat__label > svg` is (0,1,1), which beats the `h-5 w-5 text-indigo-500` utilities
    // a pre-Hive caller might still pass on its icon. Written as a single class it would lose.
    expect(rule('.hive-stat__label > svg').prelude).toBe('.hive-stat__label > svg');
  });
});

// ============================================================================
// 6. No component spells a colour either
// ============================================================================

describe('the metrics components', () => {
  it('name no hex and no frozen Tailwind ramp step', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      // Strip the doc comments: they quote the palettes this ticket *removed*, by name.
      const code = stripTsComments(source);
      expect({ name, hex: code.match(/#[0-9a-fA-F]{6}\b/g) }).toEqual({ name, hex: null });
      expect({ name, ramp: code.match(/\b(?:text|bg|fill|stroke|border)-[a-z]+-\d{3}\b/g) }).toEqual(
        { name, ramp: null },
      );
      expect({ name, dark: code.match(/\bdark:/g) }).toEqual({ name, dark: null });
    }
  });

  it('leaves the drawing to the stylesheet — no inline paint on a mark', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      expect({ name, fill: /fill="(?!none)[^"]*[a-z]/.test(source) }).toEqual({
        name,
        fill: false,
      });
      expect({ name, stroke: /stroke="(?!none)[^"]*[a-z]/.test(source) }).toEqual({
        name,
        stroke: false,
      });
    }
  });
});
