/**
 * The stylesheet half of the signed-out surfaces (HIVE-4.1, #5295).
 *
 * `tests/login-hive-redesign.test.tsx` renders the page and pins its markup. It cannot pin
 * anything that makes the page *look* right, because jsdom compiles no stylesheet — and the
 * whole point of this ticket is the look. So this suite reads `globals.css` the way
 * `page-chrome-css.test.ts` does, and pins the contract the components lean on:
 *
 *   1. The skin is tokens only. Every declaration in the `AUTH SURFACES` section resolves
 *      through the token layer, so the front door follows the reader's theme, density and
 *      font scale — which is precisely what the aurora/grain module it replaced could not.
 *   2. The hex canvas has a dark counterpart, keyed on `.dark` so all six dark-based
 *      palettes reach it (and so does `/login`, where no `ThemeProvider` is mounted).
 *   3. The brand panel and the card's own bee are swapped in one media block, so no
 *      viewport width shows the mark twice or not at all.
 *   4. Quiet text is `--fg-muted`, not the mockup's `--fg-subtle`, which fails WCAG AA at
 *      these sizes — the same deviation HIVE-3.5 made for the breadcrumb ink.
 *   5. `.input-wrap` reserves its gutter from the icon token rather than a frozen number.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** WCAG AA for normal-size text — the trust badges and terms line are 12 px. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** Every class this ticket added, so "the section is token-only" has something to walk. */
const AUTH_PRELUDES = [
  '.auth-shell',
  '.auth-split',
  '.auth-center',
  '.auth-brand',
  '.auth-brand__inner',
  '.auth-eyebrow',
  '.auth-display',
  '.auth-display__accent',
  '.auth-lede',
  '.auth-chips',
  '.auth-form',
  '.auth-form__inner',
  '.auth-card',
  '.auth-card__logo',
  '.auth-title',
  '.auth-sub',
  '.auth-sso',
  '.auth-sso__mark',
  '.auth-wait',
  '.auth-divider',
  '.auth-trust',
  '.auth-terms',
  // HIVE-4.2 (#5296) — the two-factor card.
  '.auth-center::before',
  '.auth-brandbar',
  '.auth-icon',
  '.auth-icon > svg',
  '.auth-methods',
  '.auth-methods__tab',
  '.auth-methods__tab:hover',
  '.auth-methods__tab[data-state="active"]',
  '.auth-methods__tab > svg',
  '.auth-code .input-wrap > input',
  // HIVE-4.3 (#5297) — the slug field and its trailing readout.
  '.input-wrap > .input-suffix',
  '.input-wrap:has(> .input-suffix) > :is(input, textarea)',
  '.auth-slug .input-wrap > input',
  '.auth-slug-preview',
  '.auth-slug-preview > b',
  // HIVE-4.4 (#5298) — the first-tenant onboarding wizard.
  '.auth-topbar',
  '.auth-topbar__who',
  '.auth-form__inner--wide',
  '.wiz-card',
  '.wiz-card__progress',
  '.wiz-card__body',
  '.wiz-card__foot',
  '.wiz-card__foot--center',
  '.wiz-kv',
  '.wiz-kv dt',
  '.wiz-kv dd',
  '.wiz-limits',
  '.wiz-limits > div',
  '.wiz-limits dt',
  '.wiz-limits dd',
  '.wiz-plan-title',
  '.auth-icon--honey',
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

describe('auth surfaces — the skin is tokens, not colours', () => {
  it('paints every auth class from the token layer', () => {
    // A colour, gradient or shadow stated literally would freeze on one theme. Lengths are
    // allowed to be literal (`1px` hairlines, `50%` radii, `100vh`); paint is not.
    const paintProperties = /^(color|background|background-color|background-image|border|border-.*color|box-shadow|fill|stroke)$/;
    const offenders: string[] = [];

    for (const prelude of AUTH_PRELUDES) {
      for (const [property, value] of declarationsOf(prelude)) {
        if (!paintProperties.test(property)) continue;
        // `transparent`, `currentColor` and `none` name no colour of their own.
        if (/^(transparent|currentcolor|none|inherit)$/i.test(value.trim())) continue;
        if (!value.includes('var(--')) offenders.push(`${prelude} { ${property}: ${value} }`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('introduces no raw hex outside the allow-list fences', () => {
    // The two hex-canvas data URIs encode their strokes as `%23000` / `%23fff`, which is
    // not a hex literal — so the section needs no fence of its own.
    expect(findUnfencedHex(css)).toEqual([]);
  });

  it('states no font size or control height in px', () => {
    const offenders: string[] = [];
    for (const prelude of AUTH_PRELUDES) {
      for (const [property, value] of declarationsOf(prelude)) {
        if (!/^(font-size|height|min-height|line-height)$/.test(property)) continue;
        if (/\d+px/.test(value)) offenders.push(`${prelude} { ${property}: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('auth surfaces — the hex canvas', () => {
  // The honeycomb is a data URI, which carries its own `;` — so it is read from the raw
  // rule body rather than through the declaration splitter.
  const light = ruleFor('.hex-bg').body;
  const dark = ruleFor('.dark .hex-bg').body;

  it('is the canvas token with a honeycomb over it', () => {
    expect(declarationsOf('.hex-bg').get('background-color')).toBe('var(--bg-canvas)');
    expect(light).toContain('data:image/svg+xml');
    // A background image cannot read a custom property, which is why there are two URIs
    // rather than one tinted by `currentColor`. Light draws the comb in black at 4.5%.
    expect(light).toContain("stroke='%23000'");
  });

  it('has a dark counterpart keyed on `.dark`, so all six dark palettes reach it', () => {
    // `.dark` rather than an `html[data-theme="…"]` list: `ThemeProvider` writes it for
    // every dark-based palette, and next-themes' blocking script writes it on `/login`,
    // where no provider is mounted at all. A tenth dark theme is then covered for free.
    expect(dark).toContain('data:image/svg+xml');
    expect(dark).toContain("stroke='%23fff'");
    expect(dark).not.toContain("stroke='%23000'");
  });

  it('clips both brand glows to their panel', () => {
    // `overflow: clip` is on the classes themselves rather than assumed of the caller, so
    // either glow can be used on its own without leaking a 26 rem circle across the page.
    const glow = declarationsOf('.glow-honey, .glow-azure');
    expect(glow.get('position')).toBe('relative');
    expect(glow.get('overflow')).toBe('clip');

    expect(declarationsOf('.glow-honey::before').get('background')).toContain('var(--honey)');
    expect(declarationsOf('.glow-azure::after').get('background')).toContain('var(--brand-azure)');
  });
});

describe('auth surfaces — the brand panel folds into the card', () => {
  /** The narrow-viewport block, as its own set of rules. */
  const narrow = (() => {
    const media = rules.filter((rule) => rule.prelude === '@media (max-width: 1000px)');
    if (media.length !== 1) throw new Error(`expected 1 auth media block, found ${media.length}`);
    return topLevelRules(media[0].body);
  })();

  it('hides the panel and shows the card’s bee in the *same* block', () => {
    // Two blocks at different breakpoints would leave a band of widths with two marks, or
    // none. One block is the guarantee.
    const brand = narrow.find((rule) => rule.prelude === '.auth-brand');
    const logo = narrow.find((rule) => rule.prelude === '.auth-card__logo');

    expect(parseDeclarations(brand!.body).get('display')).toBe('none');
    expect(parseDeclarations(logo!.body).get('display')).toBe('flex');
  });

  it('collapses the split to a single column', () => {
    const split = narrow.find((rule) => rule.prelude === '.auth-split');
    expect(parseDeclarations(split!.body).get('grid-template-columns')).toBe('1fr');
  });

  it('keeps the card’s bee hidden at full width', () => {
    expect(declarationsOf('.auth-card__logo').get('display')).toBe('none');
  });
});

describe('auth surfaces — quiet text still has to be readable', () => {
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

  it('uses `--fg-muted` for the trust badges and the terms line', () => {
    // The mockup sets both in `--fg-subtle`. axe reports that as a serious violation at
    // 12 px, so this deviates deliberately — same call, same reason, as HIVE-3.5's crumbs.
    expect(declarationsOf('.auth-trust').get('color')).toBe('var(--fg-muted)');
    expect(declarationsOf('.auth-terms').get('color')).toBe('var(--fg-muted)');
    expect(declarationsOf('.auth-divider').get('color')).toBe('var(--fg-muted)');
    // The slug preview is the same 12 px quiet line, and takes the same deviation.
    expect(declarationsOf('.auth-slug-preview').get('color')).toBe('var(--fg-muted)');
  });

  it('clears WCAG AA where the mockup’s subtle ink would not', () => {
    expect(ratio('--fg-muted', '--bg-surface')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    expect(ratio('--fg-muted', '--bg-canvas')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    // The reason the swap was needed, stated rather than implied.
    expect(ratio('--fg-subtle', '--bg-surface')).toBeLessThan(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('keeps the accent headline legible even where `background-clip: text` is not', () => {
    // The gradient is painted through the text, but the *declared* colour is solid accent
    // ink and only goes transparent inside an `@supports` guard — so the second line of
    // the headline is never invisible.
    expect(declarationsOf('.auth-display__accent').get('color')).toBe('var(--accent-fg)');
    expect(ratio('--accent-fg', '--bg-canvas')).toBeGreaterThanOrEqual(3);
  });
});

describe('auth surfaces — the provider mark', () => {
  it('is drawn at the rail size, inside the span that hides it from axe', () => {
    // The mark identifies the provider, so it is bigger than the 15 px a glyph in a button
    // normally gets — and it lives in its own span because some `react-icons` brand glyphs
    // set `role="img"` with no title, which axe reports as a serious violation.
    expect(declarationsOf('.auth-sso__mark > svg').get('width')).toBe('var(--icon-rail)');
    expect(declarationsOf('.auth-sso__mark').get('flex')).toBe('none');
  });
});

describe('auth surfaces — the leading-icon field wrapper', () => {
  it('reserves its gutter from the icon token, not a frozen number', () => {
    // `--icon-dense` is `rem`, so the glyph grows with the font-scale preference. A frozen
    // `padding-left: 32px` would clip the placeholder at the largest scale.
    const padding = declarationsOf('.input-wrap > :is(input, textarea)').get('padding-left');
    expect(padding).toBe('calc(var(--space-3) * 2 + var(--icon-dense))');

    const glyph = declarationsOf('.input-wrap > svg:first-child');
    expect(glyph.get('width')).toBe('var(--icon-dense)');
    expect(glyph.get('left')).toBe('var(--space-3)');
    // Clicking the glyph must still focus the control it decorates.
    expect(glyph.get('pointer-events')).toBe('none');
  });
});

describe('auth surfaces — the two-factor card (HIVE-4.2)', () => {
  it('centres its honey wash and clips it, so the page gains no scrollbar', () => {
    // The wash is 32.5 rem across and hangs 13.75 rem above the viewport. `.glow-honey`
    // is the same ornament for the split layout and sits top-right; this one is centred
    // over a single column, which is why it is stated rather than reused.
    const centre = declarationsOf('.auth-center');
    expect(centre.get('position')).toBe('relative');
    expect(centre.get('overflow')).toBe('clip');

    const wash = declarationsOf('.auth-center::before');
    expect(wash.get('background')).toContain('var(--honey)');
    expect(wash.get('pointer-events')).toBe('none');
    // The card column has to sit over it, not under it.
    expect(declarationsOf('.auth-center > .auth-form').get('z-index')).toBe('1');
  });

  it('cuts the subject glyph from the shared hexagon, not a second copy of it', () => {
    // One silhouette for the rail brand, the empty-state art and this tile: a second
    // spelling of the six points is a copy waiting to drift.
    const icon = declarationsOf('.auth-icon');
    expect(icon.get('clip-path')).toBe('var(--hex-clip)');
    expect(icon.get('background')).toBe('var(--accent-soft)');
    expect(icon.get('color')).toBe('var(--accent-fg)');
  });

  it('draws the method switcher as a well with a raised thumb', () => {
    // `role="tablist"` semantics, segmented looks — the mockup asks for the segmented
    // shape because an underline strip inside a 27 rem card reads as a page's primary
    // sections rather than as one field's choice.
    expect(declarationsOf('.auth-methods').get('background')).toBe('var(--bg-inset)');

    const idle = declarationsOf('.auth-methods__tab');
    expect(idle.get('color')).toBe('var(--fg-muted)');
    expect(idle.get('background')).toBe('transparent');
    // The thumb's radius is the well's less its own 3 px inset, which keeps the two
    // concentric however the radius scale is themed.
    expect(idle.get('border-radius')).toBe('calc(var(--r-md) - 3px)');

    const active = declarationsOf('.auth-methods__tab[data-state="active"]');
    expect(active.get('background')).toBe('var(--bg-surface)');
    expect(active.get('color')).toBe('var(--fg)');
    expect(active.get('box-shadow')).toBe('var(--shadow-raised)');
  });

  it('lets the code box grow with the font scale instead of clipping', () => {
    // The digits are set at `--fs-2xl`, so a frozen height would clip them at the
    // largest font scale — same `height: auto` + `min-height` shape as `.auth-sso`.
    const box = declarationsOf('.auth-code .input-wrap > input');
    expect(box.get('height')).toBe('auto');
    expect(box.get('min-height')).toBe('calc(var(--control-h-lg) * 1.35)');
    expect(box.get('font-size')).toBe('var(--fs-2xl)');
    expect(box.get('font-family')).toBe('var(--font-mono)');
    expect(box.get('text-align')).toBe('center');
    // The digits are centred across the whole box, so the gutter `.input-wrap` reserves
    // for its glyph is given back. The descendant selector is what wins that: it is one
    // class more specific than `.input-wrap > :is(input, textarea)`.
    expect(box.get('padding-left')).toBe('0');
  });

  it('spaces the placeholder like the value, so the box does not jump on the first key', () => {
    expect(
      declarationsOf('.auth-code .input-wrap > input::placeholder').get('letter-spacing')
    ).toBe('0.42em');
  });
});

describe('auth surfaces — the aurora is gone', () => {
  it('has deleted the page-local stylesheet entirely', () => {
    // HIVE-4.1 trimmed `login.module.css` to the two classes `/login/2fa` still imported;
    // HIVE-4.2 (#5296) re-skinned that screen, which was its last consumer. The whole
    // module — aurora blobs, blueprint grid, film grain, shimmer, shine, entrance — is
    // gone, and with it the last colour on a signed-out page that no theme could move.
    expect(existsSync(join(__dirname, '..', 'src', 'app', 'login', 'login.module.css'))).toBe(
      false
    );
  });

  it('leaves no signed-out surface importing a CSS module', () => {
    // Everything these pages need is in the AUTH SURFACES section above, which is what
    // lets the four of them share a skin rather than each carrying a copy of one.
    for (const file of ['LoginClient.tsx', join('2fa', 'TwoFactorClient.tsx')]) {
      const source = readFileSync(join(__dirname, '..', 'src', 'app', 'login', file), 'utf8');
      expect(source).not.toMatch(/^import .*\.module\.css';$/m);
    }
  });
});

describe('auth surfaces — the slug field (HIVE-4.3)', () => {
  it('pins the availability chip inside the control, as a readout not a control', () => {
    const suffix = declarationsOf('.input-wrap > .input-suffix');
    expect(suffix.get('position')).toBe('absolute');
    expect(suffix.get('right')).toBe('var(--space-2)');
    // Same promise as the leading glyph: clicking anywhere in the box focuses the input.
    expect(suffix.get('pointer-events')).toBe('none');
  });

  it('reserves the chip’s room only when there is a chip, and in the chip’s own type size', () => {
    // `:has()` is what makes the gutter conditional — a field with no readout keeps the
    // primitive's own padding rather than a permanent hole on its right. And the reserve
    // is stated in `--fs-2xs` (what `Badge` sets) rather than a frozen number, so it grows
    // with the chip at every font scale instead of letting the value run underneath it.
    const padding = declarationsOf(
      '.input-wrap:has(> .input-suffix) > :is(input, textarea)'
    ).get('padding-right');
    expect(padding).toBe('calc(var(--space-2) * 2 + var(--fs-2xs) * 9)');
  });

  it('sets the slug and its preview in the mono face', () => {
    // The slug is an identifier headed for a URL, not prose. The rule is on the field
    // wrapper rather than the control for the same reason as `.auth-code`: `AuthField`
    // owns the control and hands down only its own class.
    expect(declarationsOf('.auth-slug .input-wrap > input').get('font-family')).toBe(
      'var(--font-mono)'
    );
    expect(declarationsOf('.auth-slug-preview').get('font-family')).toBe('var(--font-mono)');
  });

  it('gives the slug itself full-strength ink inside the preview', () => {
    // The preview is a whole URL, but only one segment of it is being decided.
    expect(declarationsOf('.auth-slug-preview > b').get('color')).toBe('var(--fg)');
    expect(declarationsOf('.auth-slug-preview').get('overflow-wrap')).toBe('anywhere');
  });
});

describe('auth surfaces — the onboarding wizard (HIVE-4.4)', () => {
  it('bands the card so the progress row and the actions stay put', () => {
    // The body between them changes from step to step; the two rails around it do not.
    // The card's own padding is zero, so each band owns its inset — a padded card would
    // inset the hairlines too and they would stop reading as edges.
    expect(declarationsOf('.wiz-card').get('padding')).toBe('0');
    expect(declarationsOf('.wiz-card__progress').get('border-bottom')).toBe('1px solid var(--border)');
    expect(declarationsOf('.wiz-card__foot').get('border-top')).toBe('1px solid var(--border)');
    // Bands square off against the card's own radius unless it clips them.
    expect(declarationsOf('.wiz-card').get('overflow')).toBe('clip');
  });

  it('lets both bands wrap, so the largest font scale never overflows the card', () => {
    // The welcome step puts three buttons in the action band; at `--font-scale` maximum
    // they do not fit on one line, and a card is not a place for a horizontal scrollbar.
    expect(declarationsOf('.wiz-card__foot').get('flex-wrap')).toBe('wrap');
    expect(declarationsOf('.wiz-card__foot--center').get('justify-content')).toBe('center');
  });

  it('tints the progress band off the card rather than boxing it in a second border', () => {
    const progress = declarationsOf('.wiz-card__progress');
    expect(progress.get('background')).toBe(
      'color-mix(in srgb, var(--bg-subtle) 55%, var(--bg-surface))'
    );
  });

  it('widens the card column for a wizard, and only for a wizard', () => {
    // The three signed-out cards keep 27.5 rem; `AuthShell`'s `wide` opts into this one.
    expect(declarationsOf('.auth-form__inner').get('max-width')).toBe('27.5rem');
    expect(declarationsOf('.auth-form__inner--wide').get('max-width')).toBe('35rem');
  });

  it('makes the shell share its height with the top row instead of stacking two 100vh', () => {
    // `:has()` rather than a second shell class: the rule belongs to the *presence* of a
    // top row, so no caller can add one and forget to say so.
    const shell = declarationsOf('.auth-shell:has(> .auth-topbar)');
    expect(shell.get('display')).toBe('flex');
    expect(shell.get('flex-direction')).toBe('column');
    expect(shell.get('min-height')).toBe('100vh');

    const centre = declarationsOf('.auth-shell:has(> .auth-topbar) > .auth-center');
    expect(centre.get('flex')).toBe('1');
    // The `100vh` the centred layout normally claims has to be given back, or the two
    // rows add up to more than the viewport and the page scrolls for no content.
    expect(centre.get('min-height')).toBe('0');
  });

  it('collapses the review pair and the quota row rather than letting either overflow', () => {
    // `auto-fit` with a floor: two columns where there is room for two, one where there
    // is not. No breakpoint to keep in step with the card's width.
    expect(declarationsOf('.wiz-kv').get('grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(12rem, 1fr))'
    );
    expect(declarationsOf('.wiz-limits').get('grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(7rem, 1fr))'
    );
    // A slug is one unbreakable token; without this it decides the column's width.
    expect(declarationsOf('.wiz-kv dd').get('overflow-wrap')).toBe('anywhere');
  });

  it('divides the quota cells with a ring each, not a border showing through the gaps', () => {
    // `auto-fit` wraps the row at a narrow viewport or a large font scale, and a
    // gap-based divider paints the last row's unfilled slot in the border colour — a
    // grey block with nothing in it. A ring per cell has no slot to paint.
    expect(declarationsOf('.wiz-limits').get('gap')).toBe('0');
    expect(declarationsOf('.wiz-limits').get('background')).toBe('var(--bg-surface)');
    expect(declarationsOf('.wiz-limits > div').get('box-shadow')).toBe(
      'inset 0 0 0 1px var(--border)'
    );
    // Label in the DOM, value on top on screen — the only valid order for a `<dl>` pair,
    // drawn the way a stat tile is read.
    expect(declarationsOf('.wiz-limits > div').get('flex-direction')).toBe('column-reverse');
  });

  it('states the plan heading’s size, because an unlayered `h2` outranks `text-sm`', () => {
    // `h2 { font-size: clamp(…) }` sits unlayered at the foot of `globals.css`, and an
    // unlayered rule beats every `@layer utilities` one whatever their specificity — so a
    // card-scale heading has to be a class here. Same family as the `p { color }` trap.
    const heading = declarationsOf('.wiz-plan-title');
    expect(heading.get('font-size')).toBe('var(--fs-sm)');
    expect(heading.get('color')).toBe('var(--fg)');

    // The reason, stated: if the element rule ever loses its size this class is redundant.
    expect(declarationsOf('h2').get('font-size')).toContain('clamp(');
  });

  it('gives the welcome tile the honey spelling of the shared hexagon', () => {
    // DESIGN.md §2: honey is brand presence with no severity attached, which is what a
    // "let's begin" tile is. The silhouette is still `.auth-icon`'s one `--hex-clip`.
    const honey = declarationsOf('.auth-icon--honey');
    expect(honey.get('background')).toBe('var(--honey-soft)');
    expect(honey.get('color')).toBe('var(--honey-fg)');
    expect(honey.has('clip-path')).toBe(false);
  });

  it('keeps the top row’s quiet text above AA, like every other quiet line here', () => {
    expect(declarationsOf('.auth-topbar__who').get('color')).toBe('var(--fg-muted)');
    // An address is one long unbreakable token; without this a narrow viewport scrolls.
    expect(declarationsOf('.auth-topbar__who > span').get('overflow-wrap')).toBe('anywhere');
  });
});
