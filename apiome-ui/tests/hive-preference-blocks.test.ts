/**
 * Preference blocks in `src/app/globals.css` (HIVE-1.3, #5276).
 *
 * A preference is a token swap in exactly the way a theme is: `PreferencesProvider` writes
 * an attribute to `<html>` and the stylesheet restates the handful of tokens it changes.
 * jsdom compiles no stylesheet, so this suite reads the source — the same way
 * `tests/hive-theme-blocks.test.ts` does — and pins three things a browser would only
 * reveal by looking wrong:
 *
 *   • the values, against `hive.css` §2–§3 and the numbers the roadmap commits to;
 *   • the *shape*, so density changes spacing and never colour, and the font scale
 *     changes the root size and nothing else;
 *   • the join with `src/app/config/preferences.ts`, so every value the provider can write
 *     is a value the stylesheet answers.
 */

import {
  DEFAULT_PREFERENCES,
  FONT_SCALES,
  PREFERENCE_ATTRIBUTES,
  PREFERENCE_VALUES,
  type PreferenceKey,
} from '../src/app/config/preferences';
import {
  parseDeclarations,
  readGlobalsCss,
  readTokenLayer,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const layer = readTokenLayer(css);

/**
 * The one top-level rule whose prelude starts with a selector.
 *
 * @param prelude Exact, whitespace-collapsed prelude.
 * @returns The rule.
 * @throws If no rule, or more than one, has that prelude.
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

/** A length in `px`, as a number. */
function pixels(value: string | undefined): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value ?? '');
  if (!match) throw new Error(`Not a pixel length: ${value}`);
  return Number(match[1]);
}

describe('density is a spacing swap and nothing else', () => {
  const compact = declarationsOf('html[data-density="compact"]');

  it('lands the numbers the roadmap commits to', () => {
    expect(pixels(compact.get('--row-h'))).toBe(38);
    expect(pixels(compact.get('--control-h'))).toBe(32);
    expect(pixels(compact.get('--page-pad'))).toBe(24);
  });

  it('ports the rest of `hive.css` §2 with it', () => {
    expect(pixels(compact.get('--control-h-sm'))).toBe(26);
    expect(pixels(compact.get('--control-h-lg'))).toBe(38);
    expect(pixels(compact.get('--card-pad'))).toBe(16);
    expect(pixels(compact.get('--nav-item-h'))).toBe(28);
    expect(pixels(compact.get('--space-6'))).toBe(20);
    expect(pixels(compact.get('--space-8'))).toBe(24);
  });

  it('restates only tokens the base layer already declares', () => {
    // A token invented here would resolve nowhere at comfortable density, which is the
    // default — the failure would appear for everyone *except* the person who set it.
    const undeclared = [...compact.keys()].filter(
      (token) => !layer.root.has(token) && !layer.theme.has(token),
    );

    expect(undeclared).toEqual([]);
  });

  it('is strictly tighter than the comfortable default, token for token', () => {
    const looser = [...compact.entries()].filter(
      ([token, value]) => pixels(value) >= pixels(layer.root.get(token) ?? layer.theme.get(token)),
    );

    expect(looser.map(([token]) => token)).toEqual([]);
  });

  it('touches no colour, type or radius: switching density re-flows, never repaints', () => {
    const offenders = [...compact.entries()].filter(
      ([token, value]) =>
        /color|bg-|fg-|border|shadow|font|fs-|radius|track|lh-/.test(token) ||
        /#[0-9a-f]{3}|\brgba?\(/i.test(value),
    );

    expect(offenders).toEqual([]);
  });

  it('needs no block for `comfortable`, which is the `:root` default', () => {
    expect(DEFAULT_PREFERENCES.density).toBe('comfortable');
    expect(css).not.toContain('[data-density="comfortable"]');
  });
});

describe('the font scale re-sizes the root and nothing else', () => {
  it('gives every stop a rule at the percentage the module declares', () => {
    FONT_SCALES.forEach((scale) => {
      const prelude =
        scale.id === DEFAULT_PREFERENCES.fontScale
          ? `html[data-font-scale="${scale.id}"], html:not([data-font-scale])`
          : `html[data-font-scale="${scale.id}"]`;

      expect(parseDeclarations(rule(prelude).body).get('font-size')).toBe(`${scale.rootPercent}%`);
    });
  });

  it('declares a percentage, never a `px` root', () => {
    // A `px` root would discard the reader's own browser font-size setting.
    FONT_SCALES.forEach((scale) => {
      expect(scale.rootPercent).toBeGreaterThan(0);
      expect(`${scale.rootPercent}%`).toMatch(/^\d+(\.\d+)?%$/);
    });
  });

  it('sets nothing but the root size', () => {
    const offenders = rules
      .filter((candidate) => candidate.prelude.includes('[data-font-scale='))
      .flatMap((candidate) =>
        [...parseDeclarations(candidate.body).keys()]
          .filter((property) => property !== 'font-size')
          .map((property) => `${candidate.line}: ${property}`),
      );

    expect(offenders).toEqual([]);
  });

  it('answers a document the boot script never reached', () => {
    // Server-rendered HTML with JavaScript disabled still has to be legible.
    expect(rule('html[data-font-scale="md"], html:not([data-font-scale])').body).toContain('100%');
  });

  it('scales monotonically, so the slider never doubles back', () => {
    const percentages = FONT_SCALES.map((scale) => scale.rootPercent);

    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    expect(new Set(percentages).size).toBe(percentages.length);
  });
});

describe('reduce motion zeroes durations, from either source', () => {
  const preference = rule(
    'html[data-motion="reduce"] *, html[data-motion="reduce"] *::before, html[data-motion="reduce"] *::after',
  );

  it('zeroes both transition and animation timing', () => {
    const declarations = parseDeclarations(preference.body);

    ['transition-duration', 'transition-delay', 'animation-duration', 'animation-delay'].forEach(
      (property) => {
        expect(declarations.get(property)).toBe('0ms !important');
      },
    );
  });

  it('zeroes durations rather than removing animations', () => {
    // A removed transition never fires `transitionend`; anything waiting on one would
    // stall. A zero-length one still completes, immediately.
    expect(preference.body).not.toMatch(/animation\s*:\s*none/);
    expect(preference.body).not.toMatch(/transition\s*:\s*none/);
  });

  it('honours the operating-system setting on its own', () => {
    const media = rules.filter(
      (candidate) =>
        candidate.prelude === '@media (prefers-reduced-motion: reduce)' &&
        candidate.body.includes('transition-duration: 0ms !important'),
    );

    expect(media).toHaveLength(1);
    expect(media[0].body).toContain('*::before');
    // Ungated on purpose: `auto` is the default *and* means "follow the system", so a
    // guard on the attribute would leave the OS setting unhonoured for everyone who never
    // opened the preferences pane.
    expect(media[0].body).not.toContain('data-motion');
  });
});

describe('the rail start state is a width token', () => {
  it('defaults to the expanded width', () => {
    expect(declarationsOf('html').get('--rail-w-current')).toBe('var(--rail-w)');
  });

  it('swaps in the collapsed width', () => {
    expect(declarationsOf('html[data-rail="collapsed"]').get('--rail-w-current')).toBe(
      'var(--rail-w-collapsed)',
    );
  });

  it('resolves to a real length either way', () => {
    expect(pixels(layer.theme.get('--rail-w'))).toBeGreaterThan(
      pixels(layer.theme.get('--rail-w-collapsed')),
    );
  });
});

describe('the stylesheet answers everything the provider can write', () => {
  it('selects on each preference attribute', () => {
    (Object.keys(PREFERENCE_ATTRIBUTES) as PreferenceKey[]).forEach((key) => {
      expect(css).toContain(`[${PREFERENCE_ATTRIBUTES[key]}=`);
    });
  });

  it('gives every non-default value a block of its own', () => {
    const missing: string[] = [];

    (Object.keys(PREFERENCE_VALUES) as PreferenceKey[]).forEach((key) => {
      PREFERENCE_VALUES[key].forEach((value) => {
        const selector = `[${PREFERENCE_ATTRIBUTES[key]}="${value}"]`;
        // The defaults are the `:root` layer itself and need no block; `md` has one anyway
        // because the *absence* of the attribute has to resolve somewhere too.
        if (value === DEFAULT_PREFERENCES[key] || css.includes(selector)) return;
        missing.push(selector);
      });
    });

    expect(missing).toEqual([]);
  });
});
