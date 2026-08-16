/**
 * The fixed identity hues — `src/app/globals.css` (HIVE-2.4, #5283).
 *
 * The vocabulary's *status* half is data and is tested as data in
 * `tests/hive-status-vocabulary.test.tsx`. Its other half is deliberately not data: a format's
 * hue and an HTTP verb's hue are frozen hex, because a colour that means "this is AsyncAPI"
 * stops working the moment it re-tints per theme. That freedom to spell a literal is the whole
 * reason the raw-hex allow-list has a `.fmt--*` / `.method--*` exception, so this suite is what
 * keeps the exception honest:
 *
 *   1. every hue a component can ask for actually exists in the stylesheet — a format whose
 *      tone has no rule would render an unstyled, invisible pill;
 *   2. every one of those pairs clears WCAG AA for the 11 px bold text it is printed with,
 *      which a frozen hue must do on its own since no theme will come and fix it;
 *   3. the geometry around them is `rem` and tokens, so the two families still answer to the
 *      font-scale and density preferences (roadmap §6: no hard-coded px type or control size);
 *   4. the hex stays inside the two labelled fences and inside those two families.
 */

import {
  contrastRatio,
  hexToRgb,
  parseDeclarations,
  readGlobalsCss,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';
import { WCAG_AA_NORMAL_TEXT_MIN } from './helpers/tailwind-contrast';
import { HTTP_METHODS } from '../src/app/components/ui/MethodChip';
import { CATALOG_FORMATS, catalogFormatHueClass } from '../src/app/utils/catalog-format-registry';

const css = readGlobalsCss();
const rules = topLevelRules(css);

/**
 * Index the single-class rules of one family by their class name.
 *
 * A rule may list several selectors (`.method--head, .method--options { … }`), so each name in
 * the list gets the same declarations.
 *
 * @param prefix The family's class prefix, e.g. `.fmt--`.
 * @returns Class name (without the leading dot) to its declarations.
 */
function familyRules(prefix: string): Map<string, Map<string, string>> {
  const found = new Map<string, Map<string, string>>();
  for (const rule of rules) {
    const selectors = rule.prelude.split(',').map((selector) => selector.trim());
    if (!selectors.every((selector) => selector.startsWith(prefix))) continue;
    const declarations = parseDeclarations(rule.body);
    for (const selector of selectors) found.set(selector.slice(1), declarations);
  }
  return found;
}

/** The one rule whose prelude is exactly `selector`. */
function baseRule(selector: string): CssRule {
  const rule = rules.find((candidate) => candidate.prelude === selector);
  if (!rule) throw new Error(`globals.css declares no \`${selector}\` rule`);
  return rule;
}

/** Only the rules that paint — `.method--fit` is a geometry modifier, not a hue. */
function hueRules(family: Map<string, Map<string, string>>): Map<string, Map<string, string>> {
  return new Map([...family].filter(([, declarations]) => declarations.has('background')));
}

const FMT_RULES = hueRules(familyRules('.fmt--'));
const METHOD_RULES = hueRules(familyRules('.method--'));

/** Every tone the format registry can hand the pill, deduplicated. */
const REGISTRY_TONES = [...new Set(CATALOG_FORMATS.map((format) => format.tone))].sort();

/** The verbs the chip renders, plus the neutral class it falls back to. */
const METHOD_CLASSES = [...HTTP_METHODS, 'unknown'];

describe('format hues — every tone the registry can ask for exists', () => {
  it.each(REGISTRY_TONES)('declares a .fmt--%s rule', (tone) => {
    expect(FMT_RULES.has(`fmt--${tone}`)).toBe(true);
  });

  it('declares the neutral hue the unknown-format fallback resolves to', () => {
    expect(FMT_RULES.has(catalogFormatHueClass(undefined))).toBe(true);
  });

  it.each([...FMT_RULES.keys()])('%s sets both a fill and an ink', (name) => {
    const declarations = FMT_RULES.get(name)!;
    expect(declarations.get('background')).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(declarations.get('color')).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it.each([...FMT_RULES.keys()])('%s clears WCAG AA for the pill text', (name) => {
    const declarations = FMT_RULES.get(name)!;
    const ratio = contrastRatio(
      hexToRgb(declarations.get('color')!),
      hexToRgb(declarations.get('background')!),
    );
    expect([name, ratio >= WCAG_AA_NORMAL_TEXT_MIN]).toEqual([name, true]);
  });

  it('gives every tone a hue of its own, so two formats are never confusable', () => {
    const fills = [...FMT_RULES.values()].map((declarations) => declarations.get('background'));
    expect(new Set(fills).size).toBe(fills.length);
  });
});

describe('method hues — every verb the chip renders exists', () => {
  it.each(METHOD_CLASSES)('declares a .method--%s rule', (method) => {
    expect(METHOD_RULES.has(`method--${method}`)).toBe(true);
  });

  it.each([...METHOD_RULES.keys()])('%s clears WCAG AA for the chip text', (name) => {
    const declarations = METHOD_RULES.get(name)!;
    const ratio = contrastRatio(
      hexToRgb(declarations.get('color')!),
      hexToRgb(declarations.get('background')!),
    );
    // The chip is 11 px bold — "normal" text by WCAG's reckoning, not large. The mockup's own
    // verb hues sit between 3.2:1 and 3.9:1, which is why these are darkened.
    expect([name, ratio >= WCAG_AA_NORMAL_TEXT_MIN]).toEqual([name, true]);
  });

  it('names the ink on the chip rather than inheriting the page ink', () => {
    for (const [name, declarations] of METHOD_RULES) {
      expect([name, declarations.get('color')]).toEqual([name, '#FFFFFF']);
    }
  });
});

describe('geometry — the two families still answer to the preferences', () => {
  it.each(['.fmt', '.method'])('%s sizes itself in rem and tokens, never in px', (selector) => {
    const declarations = parseDeclarations(baseRule(selector).body);
    for (const property of ['height', 'min-width', 'padding', 'font-size', 'gap']) {
      const value = declarations.get(property);
      if (value === undefined) continue;
      expect([selector, property, value]).toEqual([selector, property, expect.not.stringMatching(/\d(?:px)\b/)]);
    }
  });

  it('takes the format pill radius and the verb chip radius from the radius scale', () => {
    expect(parseDeclarations(baseRule('.fmt').body).get('border-radius')).toBe('var(--r-sm)');
    expect(parseDeclarations(baseRule('.method').body).get('border-radius')).toBe('var(--r-xs)');
  });

  it('draws the verb chip in the mono face, which the identifier preference swaps', () => {
    expect(parseDeclarations(baseRule('.method').body).get('font-family')).toBe('var(--font-mono)');
  });

  it('lets a verb chip give up its aligned left edge when it sits inline', () => {
    expect(parseDeclarations(baseRule('.method--fit').body).get('min-width')).toBe('0');
  });
});

describe('dark palettes — the hue survives, the glare does not', () => {
  it('settles the format pill on a dark base without moving its hue', () => {
    const filter = parseDeclarations(baseRule('.dark .fmt').body).get('filter');
    expect(filter).toBeDefined();
    // Brightness/saturation move fill and ink together, so the ratios measured above hold.
    expect(filter).toContain('brightness');
    expect(filter).not.toContain('hue-rotate');
  });
});

describe('the raw-hex exception stays inside its fences', () => {
  it('labels both new fences with the family they cover', () => {
    expect(css).toContain('hex-allow-start: `.fmt--*`');
    expect(css).toContain('hex-allow-start: `.method--*`');
  });

  it('spends the exception only on the two identity families', () => {
    // Anything else that wanted a literal would have to open a fence of its own, which the
    // allow-list in `tests/hive-design-tokens.test.ts` refuses outside the documented three.
    for (const [, declarations] of [...FMT_RULES, ...METHOD_RULES]) {
      for (const property of declarations.keys()) {
        expect(['background', 'color']).toContain(property);
      }
    }
  });
});
