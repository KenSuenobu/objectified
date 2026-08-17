/**
 * The stylesheet half of the `Stepper` primitive (HIVE-4.4, #5298).
 *
 * `tests/hive-stepper.test.tsx` renders the row and pins its markup. It cannot pin
 * anything that makes the row *look* right, because jsdom compiles no stylesheet — so
 * this suite reads the `STEPPER` section of `globals.css` the way
 * `auth-surfaces-css.test.ts` does, and pins the four promises the component leans on:
 *
 *   1. Every colour on the row is a token, so it follows all nine themes.
 *   2. The badge is sized off the type it sits beside, not frozen — six font scales.
 *   3. The two solid badges carry ink that clears WCAG AA on their own fill.
 *   4. The row wraps, and an upcoming step is `--fg-muted` rather than the mockup's
 *      `--fg-subtle`, which does not clear AA at this size.
 */

import {
  contrastRatio,
  hexToRgb,
  parseDeclarations,
  readGlobalsCss,
  readTokenLayer,
  resolveToken,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** WCAG AA for normal-size text — the badge's numeral is `--fs-2xs`. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** WCAG AA 1.4.11 for a graphical object — the done badge's tick. */
const WCAG_NON_TEXT_MIN = 3;

/** Every rule the section introduces, so "the row is token-only" has something to walk. */
const STEPPER_PRELUDES = [
  '.stepper',
  '.stepper--fill',
  '.stepper--fill .step__line',
  '.step',
  '.step__num',
  '.step__num > svg',
  '.step.is-done .step__num',
  '.step.is-active',
  '.step.is-active .step__num',
  '.step__line',
  '.step__line.is-done',
];

/**
 * The one top-level rule with this prelude.
 *
 * @param prelude Exact prelude, whitespace-collapsed.
 * @returns The rule.
 * @throws When the stylesheet has none, or more than one.
 */
function ruleFor(prelude: string): CssRule {
  const matches = rules.filter((rule) => rule.prelude === prelude);
  if (matches.length !== 1) {
    throw new Error(`globals.css has ${matches.length} \`${prelude}\` rules; expected exactly 1`);
  }
  return matches[0];
}

/**
 * The declarations of a top-level rule.
 *
 * @param prelude Exact prelude.
 * @returns Property to value.
 */
function declarationsOf(prelude: string): Map<string, string> {
  return parseDeclarations(ruleFor(prelude).body);
}

/**
 * Contrast of a token pair, both resolved through the light-theme token layer.
 *
 * @param foreground Token name, e.g. `--fg-on-accent`.
 * @param background Token name, e.g. `--ok`.
 * @returns The WCAG contrast ratio.
 */
function ratio(foreground: string, background: string): number {
  return contrastRatio(
    hexToRgb(resolveToken(foreground, tokens)),
    hexToRgb(resolveToken(background, tokens))
  );
}

describe('stepper — the row is tokens, not colours', () => {
  it('paints every stepper class from the token layer', () => {
    const paintProperties = /^(color|background|background-color|border|border-.*color|box-shadow|fill|stroke)$/;
    const offenders: string[] = [];

    for (const prelude of STEPPER_PRELUDES) {
      for (const [property, value] of declarationsOf(prelude)) {
        if (!paintProperties.test(property)) continue;
        if (/^(transparent|currentcolor|none|inherit)$/i.test(value.trim())) continue;
        if (!value.includes('var(--')) offenders.push(`${prelude} { ${property}: ${value} }`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('states no font size in px', () => {
    const offenders: string[] = [];
    for (const prelude of STEPPER_PRELUDES) {
      for (const [property, value] of declarationsOf(prelude)) {
        if (!/^(font-size|line-height)$/.test(property)) continue;
        if (/\d+px/.test(value)) offenders.push(`${prelude} { ${property}: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('stepper — the badge follows the type beside it', () => {
  it('derives its size from `--fs-sm` rather than freezing the mockup’s 24 px', () => {
    // A frozen 24 px badge is a circle beside 11 px type at the smallest font scale and a
    // dot beside 20 px type at the largest. Derived, it keeps its proportion at all six.
    const badge = declarationsOf('.step__num');
    expect(badge.get('width')).toBe('calc(var(--fs-sm) * 1.7)');
    expect(badge.get('height')).toBe('calc(var(--fs-sm) * 1.7)');
    expect(badge.get('font-size')).toBe('var(--fs-2xs)');
    // Squeezed into an ellipse by a long label otherwise.
    expect(badge.get('flex')).toBe('none');
  });

  it('sizes the tick as a share of the badge, not from the icon vocabulary', () => {
    // The tick belongs to the badge rather than to the text around it, so it scales with
    // the badge and can never outgrow it.
    const tick = declarationsOf('.step__num > svg');
    expect(tick.get('width')).toBe('55%');
    expect(tick.get('height')).toBe('55%');
  });
});

describe('stepper — the two solid badges', () => {
  it('draws a completed step in the `ok` role with the on-fill ink', () => {
    const done = declarationsOf('.step.is-done .step__num');
    expect(done.get('background')).toBe('var(--ok)');
    expect(done.get('color')).toBe('var(--fg-on-accent)');
    // The outline is replaced, not layered under the fill.
    expect(done.get('box-shadow')).toBe('none');
  });

  it('draws the reader’s own step in full-contrast ink, which is what makes it findable', () => {
    const active = declarationsOf('.step.is-active .step__num');
    expect(active.get('background')).toBe('var(--fg)');
    expect(active.get('color')).toBe('var(--bg-surface)');
    expect(declarationsOf('.step.is-active').get('color')).toBe('var(--fg)');
  });

  it('keeps the numeral legible, and the tick above the graphical threshold', () => {
    // The active badge carries a *numeral* — real text at `--fs-2xs`, so 1.4.3 applies.
    expect(ratio('--bg-surface', '--fg')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);

    // The done badge never carries text: its numeral is replaced by a tick, and the word
    // "Completed" is spoken from the `sr-only` note beside it. So the threshold is 1.4.11's
    // 3:1 for a graphical object, which `--fg-on-accent` on `--ok` clears at 4.36:1. The
    // pairing itself is not this component's invention — it is the app's own solid `ok`
    // (`STATUS_TONE_SOLID_CLASS`), and a stepper that disagreed with the grade chip about
    // what a finished thing looks like would be the worse outcome.
    expect(ratio('--fg-on-accent', '--ok')).toBeGreaterThanOrEqual(WCAG_NON_TEXT_MIN);
  });
});

describe('stepper — the two deviations from the mockup', () => {
  it('sets an upcoming step in `--fg-muted`, which `--fg-subtle` does not clear AA for', () => {
    // Same call, same reason, as HIVE-3.5's breadcrumbs and HIVE-4.1's terms line. The
    // three states stay apart by their badge, which is what carries the meaning.
    expect(declarationsOf('.step').get('color')).toBe('var(--fg-muted)');
    expect(ratio('--fg-muted', '--bg-surface')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    expect(ratio('--fg-subtle', '--bg-surface')).toBeLessThan(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('wraps rather than pushing a horizontal scrollbar onto the page', () => {
    // Three labels at the largest font scale are wider than a phone, and a progress
    // header is not worth a scrollbar.
    expect(declarationsOf('.stepper').get('flex-wrap')).toBe('wrap');
    // A flex item's `min-width` is `auto`, so without this a long label refuses to wrap.
    expect(declarationsOf('.step').get('min-width')).toBe('0');
  });

  it('lets the connectors, not the labels, absorb the spare width when filled', () => {
    expect(declarationsOf('.stepper--fill').get('justify-content')).toBe('space-between');
    expect(declarationsOf('.stepper--fill .step__line').get('flex')).toBe('1');
  });
});
