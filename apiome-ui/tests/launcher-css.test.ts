/**
 * The stylesheet half of the `/ade` launcher (HIVE-4.5, #5299).
 *
 * `tests/ade-launcher.test.tsx` renders the page and pins its markup; it cannot pin anything
 * that makes the page *look* right, because jsdom compiles no stylesheet — and this ticket is
 * the look. So this suite reads `globals.css` the way `auth-surfaces-css.test.ts` does, and
 * pins what the components lean on:
 *
 *   1. The skin is tokens only. What it replaced named colours outright (`bg-zinc-50`, four
 *      `rgba()` glows, a Tailwind gradient pair per card), which froze on one palette.
 *   2. A card's hue is a *tone*: `data-tone` resolves to three custom properties, so a
 *      commercial host's card follows every theme without knowing this app's palette, and an
 *      unknown tone lands on the neutral default rather than on nothing.
 *   3. The launcher scrolls inside itself. `/ade/layout.tsx` hands it a `h-screen
 *      overflow-hidden` box, so a page that only said `min-height` would be clipped.
 *   4. Headline, lede and section labels are *classes*, not utilities — the unlayered
 *      `h1`/`h2`/`p` rules at the foot of the stylesheet outrank every `@layer utilities`
 *      declaration, so a utility there is silently dead.
 *   5. Quiet text is `--fg-muted`, not the mockup's `--fg-subtle`, which fails WCAG AA at
 *      these sizes — the same deviation HIVE-3.5 and HIVE-4.1 made.
 */

import {
  contrastRatio,
  findUnfencedHex,
  hexToRgb,
  parseDeclarations,
  readGlobalsCss,
  readTokenLayer,
  resolveToken,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';
import { STATUS_TONES } from '../src/app/components/ui/statusVocabulary';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** WCAG AA for normal-size text — the chips, the footer and the row subtitles are 12 px. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** Every class this ticket added, so "the section is token-only" has something to walk. */
const LAUNCHER_PRELUDES = [
  '.launch-tone',
  '.launch-shell',
  '.launch-row',
  '.launch-top',
  '.launch-top__actions',
  '.launch-ver',
  '.launch-ver:hover',
  '.launch-ver__dot',
  '.launch-account',
  '.launch-account:hover',
  '.launch-account__name',
  '.launch-hero',
  '.launch-comb',
  '.launch-comb__bee',
  '.launch-greet',
  '.launch-display',
  '.launch-lede',
  '.launch-chips',
  '.launch-chip',
  '.launch-chip:hover',
  '.launch-chip > svg',
  '.launch-chip__name',
  '.launch-eyebrow',
  '.launch-caps',
  '.launch-eyebrow__sub',
  '.launch-grid',
  '.launch-card',
  '.launch-card:hover',
  '.launch-card::before',
  '.launch-card__go',
  '.launch-card:hover .launch-card__go',
  '.launch-card__soon',
  '.launch-card__tag',
  '.launch-card__name',
  '.launch-card__desc',
  '.launch-card__foot',
  '.launch-card__foot > span',
  '.launch-card--soon',
  '.launch-tile',
  '.launch-tile > svg',
  '.launch-tile--sm',
  '.launch-lower',
  '.launch-lower > *',
  '.launch-panel',
  '.launch-panel--dashed',
  '.launch-res',
  '.launch-res + .launch-res',
  '.launch-res__body',
  '.launch-res__title',
  '.launch-res__sub',
  '.launch-res:hover:not(:disabled)',
  '.launch-res:hover:not(:disabled) .launch-res__title',
  '.launch-res:disabled',
  '.launch-hexrow',
  '.launch-hexrow > span',
  '.launch-hexrow > span.is-on',
  '.launch-hexrow > span.is-accent',
  '.launch-foot',
];

/**
 * The one rule with a given prelude.
 *
 * @param prelude Selector text, exactly as written in the stylesheet.
 * @returns The rule.
 * @throws When the stylesheet has no such rule, which is the failure worth reporting.
 */
function ruleFor(prelude: string): CssRule {
  const found = rules.filter((rule) => rule.prelude === prelude);
  if (found.length !== 1) {
    throw new Error(`expected exactly one \`${prelude}\` rule in globals.css, found ${found.length}`);
  }
  return found[0];
}

/**
 * A rule's declarations, by property.
 *
 * @param prelude Selector text.
 * @returns Property to value.
 */
function declarationsOf(prelude: string): Map<string, string> {
  return parseDeclarations(ruleFor(prelude).body);
}

/**
 * Contrast of a token pair, both resolved through the light-theme token layer.
 *
 * @param foreground Token name, e.g. `--fg-muted`.
 * @param background Token name, e.g. `--bg-surface`.
 * @returns The WCAG contrast ratio.
 */
function ratio(foreground: string, background: string): number {
  return contrastRatio(
    hexToRgb(resolveToken(foreground, tokens)),
    hexToRgb(resolveToken(background, tokens))
  );
}

describe('launcher — the skin is tokens, not colours', () => {
  it('paints every launcher class from the token layer', () => {
    const paintProperties =
      /^(color|background|background-color|background-image|border|border-.*color|box-shadow|fill|stroke)$/;
    const offenders: string[] = [];

    for (const prelude of LAUNCHER_PRELUDES) {
      for (const [property, value] of declarationsOf(prelude)) {
        if (!paintProperties.test(property)) continue;
        if (/^(transparent|currentcolor|none|inherit)$/i.test(value.trim())) continue;
        if (!value.includes('var(--')) offenders.push(`${prelude} { ${property}: ${value} }`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('introduces no raw hex outside the allow-list fences', () => {
    expect(findUnfencedHex(css)).toEqual([]);
  });

  it('states no font size or control height in px', () => {
    // A `height` that draws a *rule* rather than sizing a control is exempt, exactly as a
    // `1px` border is: the card's identity hairline has to stay a hairline at the largest
    // font scale, so scaling it with the type would be the bug, not the fix.
    const hairlines = new Set(['.launch-card::before']);
    const offenders: string[] = [];
    for (const prelude of LAUNCHER_PRELUDES) {
      if (hairlines.has(prelude)) continue;
      for (const [property, value] of declarationsOf(prelude)) {
        if (!/^(font-size|height|min-height|line-height)$/.test(property)) continue;
        if (/\d+px/.test(value)) offenders.push(`${prelude} { ${property}: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('launcher — a card’s hue is a tone', () => {
  /** The tones that name a hue of their own; `outline` and `ink` carry none. */
  const HUED_TONES = STATUS_TONES.filter((tone) => tone !== 'outline' && tone !== 'ink');

  it('gives every hued tone in the shared vocabulary its own block', () => {
    // The vocabulary is the contract: a tone a commercial host may legitimately declare has
    // to paint. Adding a tenth tone to `statusVocabulary` fails here until it is drawn.
    for (const tone of HUED_TONES) {
      const declarations = declarationsOf(`.launch-tone[data-tone="${tone}"]`);
      expect(declarations.get('--launch-tone')).toBe(`var(--${tone})`);
      expect(declarations.get('--launch-tone-soft')).toBe(`var(--${tone}-soft)`);
      expect(declarations.get('--launch-tone-fg')).toBe(`var(--${tone}-fg)`);
    }
  });

  it('falls back to a neutral hairline for a tone it does not know', () => {
    // `resolveLauncherTone` already narrows a host's value, so this is the second line of
    // the same defence: an unrecognised `data-tone` still renders a complete card.
    const fallback = declarationsOf('.launch-tone');
    expect(fallback.get('--launch-tone')).toBe('var(--border-strong)');
    expect(fallback.get('--launch-tone-soft')).toBe('var(--bg-subtle)');
    expect(fallback.get('--launch-tone-fg')).toBe('var(--fg-muted)');
  });

  it('draws the card’s hairline and its glyph tile from that tone', () => {
    expect(declarationsOf('.launch-card::before').get('background')).toContain(
      'var(--launch-tone)'
    );
    const tile = declarationsOf('.launch-tile');
    expect(tile.get('background')).toBe('var(--launch-tone-soft)');
    expect(tile.get('color')).toBe('var(--launch-tone-fg)');
  });

  it('cuts the glyph tile from the shared hexagon, not a second polygon', () => {
    // One silhouette across the launcher's tiles, the rail's workspace avatar and the
    // empty-state art — changing `--hex-clip` has to reach all three.
    expect(declarationsOf('.launch-tile').get('clip-path')).toBe('var(--hex-clip)');
  });
});

describe('launcher — the page scrolls inside itself', () => {
  it('fills the layout’s box and takes the scroll', () => {
    // `/ade/layout.tsx` wraps every route in `h-screen overflow-hidden`; a launcher that
    // only stated `min-height` would have its footer clipped at the smallest viewport.
    const shell = declarationsOf('.launch-shell');
    expect(shell.get('height')).toBe('100%');
    expect(shell.get('overflow-y')).toBe('auto');
    // …but not horizontally: `.glow-honey` hangs a 26 rem wash off the top-right corner.
    expect(shell.get('overflow-x')).toBe('clip');
  });

  it('keeps every band on the same column', () => {
    const row = declarationsOf('.launch-row');
    expect(row.get('max-width')).toBe('var(--launch-width)');
    expect(row.get('padding-inline')).toBe('var(--page-pad)');
    expect(declarationsOf('.launch-shell').get('--launch-width')).toMatch(/rem$/);
  });

  it('pins the footer to the bottom of a short page', () => {
    expect(declarationsOf('.launch-foot').get('margin-top')).toBe('auto');
  });

  it('stacks the two lower panels by default and splits them once there is room', () => {
    // One column is the *default* rather than the exception, so a phone gets the simpler
    // rule with no media query at all.
    expect(declarationsOf('.launch-lower').get('grid-template-columns')).toBe('1fr');
    const wide = css.slice(css.indexOf('@media (min-width: 60rem)'));
    expect(wide.slice(0, 200)).toContain('.launch-lower');
    expect(wide.slice(0, 200)).toContain('grid-template-columns: 7fr 5fr');
  });
});

describe('launcher — the unlayered element rules are answered with classes', () => {
  it('sizes the headline from a class, not a utility', () => {
    // `h1 { font-size: clamp(…) }` at the foot of this stylesheet is unlayered and outranks
    // every `@layer utilities` size, so `text-5xl` on the `<h1>` would be swallowed.
    expect(declarationsOf('.launch-display').get('font-size')).toBe('var(--fs-5xl)');
    expect(declarationsOf('.launch-caps').get('font-size')).toBe('var(--fs-2xs)');
  });

  it('colours the lede from a class, for the same reason', () => {
    // And `p { color: var(--text-muted) }` is why the lede is a `div` with a class rather
    // than a `<p>` with `text-fg-muted`.
    expect(declarationsOf('.launch-lede').get('color')).toBe('var(--fg-muted)');
  });
});

describe('launcher — quiet text still has to be readable', () => {
  it('uses `--fg-muted` wherever the mockup used `--fg-subtle`', () => {
    for (const prelude of [
      '.launch-caps',
      '.launch-eyebrow__sub',
      '.launch-card__tag',
      '.launch-card__foot',
      '.launch-res__sub',
      '.launch-foot',
      '.launch-chip',
    ]) {
      expect(declarationsOf(prelude).get('color')).toBe('var(--fg-muted)');
    }
  });

  it('clears WCAG AA where the mockup’s subtle ink would not', () => {
    expect(ratio('--fg-muted', '--bg-surface')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    expect(ratio('--fg-muted', '--bg-canvas')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    expect(ratio('--fg-subtle', '--bg-surface')).toBeLessThan(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('links the resource row’s title in accent *ink*, not the accent itself', () => {
    // Fifth landing of the same finding: `--accent` measures 4.1:1 on the surface, which
    // axe calls serious. `--accent-fg` clears it.
    expect(declarationsOf('.launch-res:hover:not(:disabled) .launch-res__title').get('color')).toBe(
      'var(--accent-fg)'
    );
    expect(ratio('--accent-fg', '--bg-surface')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });
});

describe('launcher — the brand ornaments are the shared ones', () => {
  it('reuses the auth pages’ hex canvas and honey wash rather than restating them', () => {
    // The launcher and the front door are the same surface with different content, so there
    // is one `.hex-bg` and one `.glow-honey` in this stylesheet, not two.
    expect(rules.filter((rule) => rule.prelude === '.hex-bg')).toHaveLength(1);
    expect(rules.filter((rule) => rule.prelude === '.glow-honey, .glow-azure')).toHaveLength(1);
    expect(rules.filter((rule) => rule.prelude === '.glow-honey::before')).toHaveLength(1);
  });

  it('shares one gradient-headline rule with the auth display line', () => {
    const shared = ruleFor('.auth-display__accent, .launch-display__accent');
    expect(shared.body).toContain('var(--accent-fg)');
    expect(shared.body).toContain('background-clip: text');
  });

  it('hides the honeycomb before it can sit on the headline', () => {
    // It is absolutely positioned beside the copy, so below the width where the two stop
    // fitting side by side it has to go entirely.
    const narrow = css.slice(css.indexOf('@media (max-width: 68.75rem)'));
    expect(narrow.slice(0, 200)).toContain('.launch-comb');
    expect(narrow.slice(0, 200)).toContain('display: none');
  });
});
