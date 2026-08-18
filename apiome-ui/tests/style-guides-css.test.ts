/**
 * The stylesheet half of the style-guides redesign (HIVE-5.6, #5309).
 *
 * `style-guides-hive-redesign.test.tsx` renders the page and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `audit-css.test.ts` and `api-keys-css.test.ts` do, and pins
 * what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in more than
 *      thirty places across the three panels — `border-slate-200`, `bg-indigo-600`,
 *      `bg-emerald-100`, `bg-rose-100`, `text-gray-400` and a `focus:ring-indigo-500` on
 *      every field. Every one froze the surface on one palette.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the description
 *      clamp at 420px, the actions column at 200px, the fieldset padding at 14/16px and the
 *      policy grid's breakpoint at 900px; all are `rem`, a token or a `rem` media query here.
 *   3. **Every two-column grid collapses**, so neither policy panel can scroll the document
 *      sideways at any font scale.
 *   4. **Quiet text is `--fg-muted`**, not the mockup's `--fg-subtle` or `--fg-faint`,
 *      neither of which clears AA at these sizes.
 *   5. **Nothing fades.** The one way of marking a row that can fail a contrast check is not
 *      spent anywhere in this block.
 */

import {
  compositeOver,
  contrastRatio,
  findUnfencedHex,
  parseDeclarations,
  readGlobalsCss,
  readThemeBlocks,
  readTokenLayer,
  resolveThemeToken,
  topLevelRules,
  type CssRule,
  type Rgb,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** The light default, then every `html[data-theme]` block — the nine appearances. */
const APPEARANCES = [
  ['light', undefined] as const,
  ...[...readThemeBlocks(css).entries()].map(([id, block]) => [id, block] as const),
];

/** WCAG AA for normal-size text. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** Pure white, the last thing behind every surface. */
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

/** The line the unlayered `p` base rule is declared on, found rather than assumed. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'p');
  if (!rule) throw new Error('globals.css no longer declares a bare `p` rule');
  return rule.line;
})();

/**
 * Every top-level rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of
 * silently dropping out of the token-only walk below.
 */
const STYLE_GUIDE_PRELUDES = [
  '.sg-tab-glyph',
  '.sg-tab-count',
  '.sg-identity',
  '.sg-identity__text',
  '.sg-identity__line',
  '.sg-identity__link',
  '.sg-identity__link:hover',
  '.sg-identity__name',
  '.sg-identity__desc',
  '.sg-rules',
  '.sg-chips',
  '.sg-stamp',
  '.sg-empty-cell',
  '.sg-chip-glyph',
  '.sg-foot-note',
  '.sg-foot-note > svg',
  '.sg-form',
  '.sg-field',
  '.sg-field__hint',
  '.sg-field__optional',
  '.sg-select',
  '.sg-select:disabled',
  '.sg-num',
  '.sg-quiet',
  '.sg-section-title',
  '.sg-section-desc',
  '.sg-inline-link',
  '.sg-inline-link:hover',
  '.sg-dialog-note',
  '.sg-dialog-note > svg',
  '.sg-assign-body',
  '.sg-default-row',
  '.sg-assign-picker',
  '.sg-assign-picker__select',
  '.sg-assign-list',
  '.sg-assign-row',
  '.sg-assign-row + .sg-assign-row',
  '.sg-assign-row__name',
  '.sg-assign-row__id',
  '.sg-assign-row__remove',
  '.sg-confirm-body',
  '.qp-panel, .vp-panel',
  '.qp-card-header',
  '.qp-card-header__lead',
  '.qp-card-header__text',
  '.qp-card-title',
  '.qp-card-title__glyph',
  '.qp-card-desc',
  '.qp-list-header',
  '.qp-body, .vp-body',
  '.qp-scopes',
  '.qp-fieldset',
  '.qp-legend',
  '.qp-legend__glyph',
  '.qp-grid',
  '.qp-switch-row',
  '.qp-switch-row__text',
  '.qp-switch-row__title',
  '.qp-switch-row__desc',
  '.qp-overrides',
  '.qp-overrides__head',
  '.qp-overrides__list',
  '.qp-overrides__row',
  '.qp-overrides__format',
  '.qp-overrides__value',
  '.qp-lists',
  '.qp-rows',
  '.qp-rows > li + li',
  '.qp-version-row',
  '.qp-fingerprint',
  '.qp-version-row__when',
  '.qp-version-row__actor',
  '.qp-waiver-row',
  '.qp-waiver-row__text',
  '.qp-waiver-row__head',
  '.qp-waiver-row__subject',
  '.qp-waiver-row__reason',
  '.qp-waiver-row__meta',
  '.qp-skeleton',
  '.qp-skeleton__header',
  '.qp-skeleton__block',
  '.vp-layout',
  '.vp-title-row',
  '.vp-aside',
  '.vp-enforcement',
  '.vp-version-row',
  '.vp-version-row__label',
  '.vp-version-row__when',
  '.vp-skeleton',
  '.vp-skeleton__block',
  '.vp-skeleton__row',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link STYLE_GUIDE_PRELUDES} lists it.
 * @returns The rule.
 */
function guideRule(prelude: string): CssRule {
  const rule = rules.find((candidate) => candidate.prelude === prelude);
  if (!rule) throw new Error(`globals.css declares no rule \`${prelude}\``);
  return rule;
}

/**
 * Read one declaration out of one of this ticket's rules.
 *
 * @param prelude The rule's selector.
 * @param property The property to read.
 * @returns Its value, whitespace-collapsed.
 */
function declaration(prelude: string, property: string): string {
  const value = parseDeclarations(guideRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/**
 * The opaque colour a token resolves to in one appearance, flattened onto its backdrop.
 *
 * @param name The token.
 * @param appearance The theme block, or `undefined` for the light default.
 * @param backdrop What is painted behind it.
 * @returns The resulting opaque channels.
 */
function paint(name: string, appearance: unknown, backdrop: Rgb): Rgb {
  return compositeOver(resolveThemeToken(name, tokens, appearance as never), backdrop);
}

/**
 * The style-guides block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file, for the reason `api-keys-css.test.ts`
 * records: `globals.css` grows one section per redesign ticket, and a slice that ended at EOF
 * would make every assertion below a claim about every *later* section too.
 */
const SECTION = (() => {
  const start = css.indexOf('STYLE GUIDES & GOVERNANCE POLICIES  (HIVE-5.6, #5309)');
  if (start < 0) throw new Error('globals.css has no style-guides section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the style-guides section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = STYLE_GUIDE_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.qp-card-title` is an `h3` and `.sg-quiet` / `.qp-card-desc` are `p`s; both base rules
    // are unlayered, so a rule declared before them would lose whatever its specificity.
    for (const prelude of STYLE_GUIDE_PRELUDES) {
      expect(guideRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of STYLE_GUIDE_PRELUDES) {
      for (const [property, value] of parseDeclarations(guideRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the three panels named', () => {
    for (const banned of [
      'slate-',
      'indigo-',
      'emerald-',
      'rose-1',
      'amber-',
      'gray-',
      'purple-',
    ]) {
      expect(SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });

  it('never fades anything', () => {
    // The one way of marking a region that can fail a contrast check, in a block whose whole
    // job is showing a member a screen they may not edit.
    expect(SECTION_CODE).not.toMatch(/(?<!-)\bopacity\s*:/);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt everywhere — a hairline is one device pixel by definition — and `2px`
    // only in a ring, a border or an underline's clearance. All three are gaps between two
    // strokes rather than font metrics or control heights: they must *not* grow with the
    // font scale, which is the same reason `outline-offset` is exempt app-wide.
    const RULE_PROPERTIES = new Set([
      'outline',
      'outline-offset',
      'box-shadow',
      'border',
      'border-block-start',
      'border-inline-start',
      'text-underline-offset',
    ]);
    for (const prelude of STYLE_GUIDE_PRELUDES) {
      for (const [property, value] of parseDeclarations(guideRule(prelude).body)) {
        const allowed = RULE_PROPERTIES.has(property) ? ['1px', '2px'] : ['1px'];
        const offending = value
          .match(/(?<!\d)(\d*\.?\d+)px/g)
          ?.filter((px) => !allowed.includes(px));
        expect({ prelude, property, offending: offending ?? [] }).toMatchObject({
          prelude,
          property,
          offending: [],
        });
      }
    }
  });

  it('caps the name cell in rem rather than the mockup’s 420px', () => {
    // `max-width`, not `max-inline-size`: the build's CSS transform drops the logical
    // spelling from a rule that also carries `min-width` (measured in HIVE-5.2).
    expect(declaration('.sg-identity', 'max-width')).toBe('26rem');
    expect(declaration('.sg-identity', 'min-width')).toBe('0');
  });

  it('sizes every control and glyph from the shared metrics', () => {
    expect(declaration('.sg-select', 'block-size')).toBe('var(--control-h)');
    for (const prelude of [
      '.sg-tab-glyph',
      '.sg-chip-glyph',
      '.sg-foot-note > svg',
      '.sg-dialog-note > svg',
      '.qp-card-title__glyph',
      '.qp-legend__glyph',
    ]) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-dense)');
    }
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.sg-identity', 'gap'],
      ['.sg-form', 'gap'],
      ['.sg-field', 'gap'],
      ['.sg-assign-body', 'gap'],
      ['.sg-assign-row', 'padding'],
      ['.qp-fieldset', 'padding'],
      ['.qp-fieldset', 'gap'],
      ['.qp-grid', 'gap'],
      ['.qp-scopes', 'gap'],
      ['.qp-overrides', 'padding'],
      ['.vp-layout', 'gap'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--space-/);
    }
  });

  it('states every font size as a scale token', () => {
    for (const prelude of STYLE_GUIDE_PRELUDES) {
      const size = parseDeclarations(guideRule(prelude).body).get('font-size');
      if (size === undefined) continue;
      expect({ prelude, size }).toMatchObject({
        prelude,
        size: expect.stringMatching(/var\(--fs-/),
      });
    }
  });

  it('states each grid’s breakpoint in rem, so it follows the font scale', () => {
    // The mockup's 900px is a device width; at the Largest font scale a two-column policy
    // form has to fold sooner, which only a `rem` query can do.
    const media = SECTION.match(/@media \([^)]*\)/g) ?? [];
    expect(media.length).toBeGreaterThanOrEqual(4);
    for (const query of media) {
      expect(query).toMatch(/rem\)/);
      expect(query).not.toMatch(/\d+px/);
    }
  });
});

/* -------------------------------------------------------------------------
   3. Nothing scrolls the document sideways
   ------------------------------------------------------------------------- */

describe('horizontal containment', () => {
  it('collapses every two-column grid to one column below its breakpoint', () => {
    for (const prelude of ['.qp-scopes', '.qp-grid', '.qp-lists', '.vp-layout']) {
      expect(declaration(prelude, 'grid-template-columns')).toMatch(/minmax\(0, /);
      const collapsed = rules.filter(
        (rule) => rule.prelude.startsWith('@media') && rule.body.includes(`${prelude} {`)
      );
      expect({ prelude, collapsed: collapsed.length }).toMatchObject({ prelude });
      expect(collapsed.length).toBeGreaterThan(0);
      expect(collapsed[0].body).toContain('grid-template-columns: minmax(0, 1fr)');
    }
  });

  it('gives every elidable cell a floor to shrink to', () => {
    for (const prelude of [
      '.sg-identity',
      '.sg-identity__text',
      '.sg-chips',
      '.sg-field',
      '.qp-card-header__text',
      '.qp-overrides__value',
    ]) {
      expect(declaration(prelude, 'min-width')).toBe('0');
    }
  });

  it('elides the identifiers and wraps the prose', () => {
    for (const prelude of ['.sg-identity__desc', '.sg-assign-row__id', '.qp-fingerprint']) {
      expect(declaration(prelude, 'text-overflow')).toBe('ellipsis');
      expect(declaration(prelude, 'white-space')).toBe('nowrap');
    }
    for (const prelude of [
      '.qp-overrides__value',
      '.qp-waiver-row__reason',
      '.qp-waiver-row__meta',
      '.vp-version-row__label',
    ]) {
      expect(declaration(prelude, 'word-break')).toBe('break-word');
    }
  });

  it('wraps every cluster that can outgrow its row', () => {
    for (const prelude of [
      '.sg-identity__line',
      '.sg-chips',
      '.qp-overrides__head',
      '.qp-waiver-row__head',
      '.vp-title-row',
    ]) {
      expect(declaration(prelude, 'flex-wrap')).toBe('wrap');
    }
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text and the one tinted ground
   ------------------------------------------------------------------------- */

describe('quiet text', () => {
  it('uses --fg-muted rather than --fg-subtle or --fg-faint', () => {
    for (const prelude of [
      '.sg-stamp',
      '.sg-empty-cell',
      '.sg-field__hint',
      '.sg-field__optional',
      '.sg-quiet',
      '.sg-section-desc',
      '.sg-dialog-note',
      '.sg-assign-row__id',
      '.qp-card-desc',
      '.qp-card-title__glyph',
      '.qp-legend__glyph',
      '.qp-switch-row__desc',
      '.qp-overrides__value',
      '.qp-fingerprint',
      '.qp-version-row__when',
      '.qp-version-row__actor',
      '.qp-waiver-row__meta',
      '.vp-version-row__when',
    ]) {
      expect(declaration(prelude, 'color')).toBe('var(--fg-muted)');
    }
  });

  it('keeps --fg-muted above AA on the surface in every theme', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const ratio = contrastRatio(paint('--fg-muted', appearance, surface), surface);
      expect({ theme: name, ratio }).toMatchObject({ theme: name });
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('keeps the two recessed grounds readable in every theme', () => {
    // The assign dialog's default row and the read-only per-format overrides both sit on
    // `--bg-inset`; the ink on them is ordinary `--fg` and `--fg-muted`, never a fade.
    expect(declaration('.sg-default-row', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.qp-overrides', 'background')).toBe('var(--bg-inset)');
    for (const [name, appearance] of APPEARANCES) {
      const ground = paint('--bg-inset', appearance, PAPER);
      for (const ink of ['--fg', '--fg-muted']) {
        const ratio = contrastRatio(paint(ink, appearance, ground), ground);
        expect({ theme: name, ink, ratio }).toMatchObject({ theme: name, ink });
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
      }
    }
  });

  it('underlines the inline link rather than tinting it alone', () => {
    // A link inside a block of text distinguished by colour alone is an axe
    // `link-in-text-block` violation, and unreadable to anyone who cannot see the tint.
    expect(declaration('.sg-inline-link', 'text-decoration')).toBe('underline');
    expect(declaration('.sg-inline-link', 'color')).toBe('var(--accent-fg)');
  });

  it('keeps the guide-name link in the row’s own ink until it is hovered', () => {
    // A first column that is entirely accent-tinted reads as a list of links rather than as
    // a list of guides; the underline on hover is what says it is one.
    expect(declaration('.sg-identity__link', 'color')).toBe('inherit');
    expect(declaration('.sg-identity__link', 'text-decoration')).toBe('none');
    expect(declaration('.sg-identity__link:hover', 'text-decoration')).toBe('underline');
  });
});
