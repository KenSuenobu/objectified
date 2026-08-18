/**
 * The stylesheet half of the Tenants redesign (HIVE-5.1, #5304).
 *
 * `tenants-hive-redesign.test.tsx` renders the page and the drawer and pins their markup; it
 * cannot pin anything that makes them *look* right, because jsdom compiles no stylesheet.
 * So this suite reads `globals.css` the way `linked-accounts-css.test.ts` and
 * `profile-css.test.ts` do, and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in a dozen
 *      places — `bg-amber-50 border-amber-300` for the unsaved bar, `bg-slate-50` toolset
 *      headers, `border-indigo-200 bg-indigo-50` for the secret reveal, an emerald/red pair
 *      for the status chips, and a `from-indigo-500 to-purple-600` gradient for the "Current"
 *      pill. Each of those froze the surface on one palette.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block set the tab rail at
 *      196 px, the tool row's three flag columns at 92/84/96 px and the diff indent at
 *      148 px. All of them are `rem` here, so the drawer follows both densities and all six
 *      font scales.
 *   3. **Nothing can scroll the document sideways.** Every grid track that holds content is
 *      `minmax(0, …)`, and both fixed grids collapse below a stated width.
 *   4. **Every tinted surface clears WCAG AA in all nine themes.** Two of them are here
 *      *because* of that measurement rather than for looks: the lock note carries `--fg`
 *      rather than `--fg-muted`, and each policy-diff value sits on its own `-soft` chip
 *      instead of being coloured on the bare panel, where five of the nine themes measured
 *      as low as 1.47:1. Both facts are proven below, in both directions.
 *   5. **The `@container` trap is avoided**: a container query with no `container-type`
 *      above it never matches, so the two responsive fallbacks are `@media` rules and this
 *      suite proves it rather than trusting it.
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

/** WCAG AA for normal-size text — the dirty bar's sub-line is 12 px. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** The stylesheet with its comments removed, for assertions that match raw source. */
const STRIPPED = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The line the unlayered `h2` / `p` base rules are declared on, found rather than assumed. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'h2');
  if (!rule) throw new Error('globals.css no longer declares a bare `h2` rule');
  return rule.line;
})();

/**
 * Every top-level rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of
 * silently dropping out of the token-only walk below.
 */
const TENANT_PRELUDES = [
  '.tnt-section-title',
  '.tnt-section-desc',
  '.tnt-caps',
  '.tnt-lock-note',
  '.tnt-icon-tile',
  '.tnt-icon-tile > svg',
  '.tnt-icon-tile[data-tone="accent"]',
  '.tnt-icon-tile[data-tone="honey"]',
  '.tnt-icon-tile[data-tone="ok"]',
  '.tnt-icon-tile[data-tone="warn"]',
  '.tnt-icon-tile[data-tone="danger"]',
  '.tnt-icon-tile[data-tone="violet"]',
  '.tnt-icon-tile--hex',
  '.tnt-card',
  '.tnt-card--pad',
  '.tnt-card--flush',
  '.tnt-card__header',
  '.tnt-card__body > * + *',
  '.tnt-limit-row',
  '.tnt-feature-row',
  '.tnt-switch-row',
  '.tnt-toolset-card',
  '.tnt-toolset-card[data-ceiling="none"]',
  '.tnt-toolset-tools',
  '.tnt-tool-row',
  '.tnt-tool-row + .tnt-tool-row',
  '.tnt-tool-row--head',
  '.tnt-dirty-bar',
  '.tnt-dirty-bar__sub',
  '.tnt-hist-row',
  '.tnt-hist-row--head',
  '.tnt-card li + li .tnt-hist-row',
  '.tnt-hist-diff',
  '.tnt-diff-line',
  '.tnt-diff-line__field',
  '.tnt-diff-line__from, .tnt-diff-line__to',
  '.tnt-diff-line__from',
  '.tnt-diff-line__to',
  '.tnt-manage-grid',
  '.tnt-manage-nav',
  '.tnt-manage-nav > *',
  '.tnt-tab-count, .tnt-tab-dot',
  '.tnt-tab-count',
  '.tnt-tab-dot',
  '.tnt-menu',
  '.tnt-menu__item',
  '.tnt-menu__item > svg',
  '.tnt-menu__item[data-highlighted], .tnt-menu__item:hover',
  '.tnt-menu__item--note',
  '.tnt-menu__item--note:hover',
  '.tnt-kv',
  '.tnt-kv dt',
  '.tnt-kv dd',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link TENANT_PRELUDES} lists it.
 * @returns The rule.
 */
function tenantRule(prelude: string): CssRule {
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
  const value = parseDeclarations(tenantRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/**
 * The opaque colour a token resolves to in one appearance, flattened onto its backdrop.
 *
 * The `-soft` tints are deliberately translucent in the dark themes — a wash works on every
 * surface — so a contrast claim about one has to composite it first, the way a browser does.
 *
 * @param name The token.
 * @param appearance The theme block, or `undefined` for the light default.
 * @param backdrop What is painted behind it.
 * @returns The resulting opaque channels.
 */
function paint(name: string, appearance: unknown, backdrop: Rgb): Rgb {
  return compositeOver(resolveThemeToken(name, tokens, appearance as never), backdrop);
}

/** Pure white, the last thing behind every surface. */
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

/**
 * The tenants block, from its banner to the end of the stylesheet.
 *
 * Comments and all — the `@media` assertions below read the source as written. Where an
 * assertion is about the *absence* of something the prose also discusses, it reads
 * {@link TENANT_SECTION_CODE} instead.
 */
const TENANT_SECTION = (() => {
  const start = css.indexOf('TENANTS & THE MANAGE DRAWER');
  if (start < 0) throw new Error('globals.css has no tenants section');
  // Bounded at the next banner rather than run to EOF, the same correction HIVE-6.3 (#5314)
  // made to `members-css.test.ts`: an EOF slice makes every assertion below a claim about
  // every later section of the stylesheet as well.
  const next = css.indexOf('/* =', start);
  return css.slice(start, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const TENANT_SECTION_CODE = TENANT_SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the tenants section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = TENANT_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered h2 and p base rules it has to outrank', () => {
    for (const prelude of TENANT_PRELUDES) {
      expect(tenantRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of TENANT_PRELUDES) {
      for (const [property, value] of parseDeclarations(tenantRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        // `color-mix(in srgb, var(--warn) …)` is a token expression, not a colour: it names
        // no channel of its own. A literal `rgb(…)`/`hsl(…)` would be.
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt and only `1px`: a hairline is one device pixel by definition and must
    // not grow with the font scale.
    for (const prelude of TENANT_PRELUDES) {
      for (const [property, value] of parseDeclarations(tenantRule(prelude).body)) {
        const offending = value.match(/(?<!\d)(\d*\.?\d+)px/g)?.filter((px) => px !== '1px');
        expect({ prelude, property, offending: offending ?? [] }).toMatchObject({
          prelude,
          property,
          offending: [],
        });
      }
    }
  });

  it('sizes the tab rail in rem, not the mockup’s 196px', () => {
    expect(declaration('.tnt-manage-grid', 'grid-template-columns')).toBe(
      '12rem minmax(0, 1fr)'
    );
  });

  it('sizes the tool row’s three flag columns in rem, not 92/84/96px', () => {
    expect(declaration('.tnt-tool-row', 'grid-template-columns')).toBe(
      'minmax(0, 1fr) 5.75rem 5.25rem 6rem'
    );
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.tnt-manage-grid', 'gap'],
      ['.tnt-lock-note', 'padding'],
      ['.tnt-card--pad', 'padding'],
      ['.tnt-toolset-card', 'padding'],
      ['.tnt-hist-row', 'gap'],
    ] as const) {
      expect(declaration(prelude, property)).toContain('var(--space-');
    }
  });

  it('draws every quiet line from the type scale', () => {
    for (const [prelude, expected] of [
      ['.tnt-section-title', 'var(--fs-lg)'],
      ['.tnt-section-desc', 'var(--fs-xs)'],
      ['.tnt-caps', 'var(--fs-2xs)'],
      ['.tnt-lock-note', 'var(--fs-sm)'],
      ['.tnt-tool-row', 'var(--fs-sm)'],
      ['.tnt-dirty-bar', 'var(--fs-sm)'],
      ['.tnt-dirty-bar__sub', 'var(--fs-xs)'],
      ['.tnt-hist-diff', 'var(--fs-xs)'],
    ] as const) {
      expect(declaration(prelude, 'font-size')).toBe(expected);
    }
  });

  it('reuses the shared radii rather than inventing corners', () => {
    for (const prelude of ['.tnt-lock-note', '.tnt-card', '.tnt-toolset-card', '.tnt-menu']) {
      expect(declaration(prelude, 'border-radius')).toMatch(/^var\(--r-/);
    }
  });
});

/* -------------------------------------------------------------------------
   3. Nothing can scroll the document sideways
   ------------------------------------------------------------------------- */

describe('no horizontal document scroll at ≥1280px', () => {
  it('gives every content-bearing grid track a zero minimum', () => {
    // A grid track's automatic minimum is its *content*, so a long tool id or a long change
    // summary would hold its column open at intrinsic width without this.
    for (const prelude of ['.tnt-manage-grid', '.tnt-tool-row', '.tnt-hist-row', '.tnt-kv']) {
      expect(declaration(prelude, 'grid-template-columns')).toContain('minmax(0,');
    }
  });

  it('elides the dirty bar’s summary rather than letting it push Save off the row', () => {
    const decls = parseDeclarations(tenantRule('.tnt-dirty-bar__sub').body);
    expect(decls.get('min-width')).toBe('0');
    expect(decls.get('overflow')).toBe('hidden');
    expect(decls.get('text-overflow')).toBe('ellipsis');
    expect(decls.get('white-space')).toBe('nowrap');
  });

  it('lets the dirty bar wrap instead of overflowing', () => {
    expect(declaration('.tnt-dirty-bar', 'flex-wrap')).toBe('wrap');
  });

  it('breaks a long slug in the change confirm rather than widening the dialog', () => {
    const decls = parseDeclarations(tenantRule('.tnt-kv dd').body);
    expect(decls.get('min-width')).toBe('0');
    expect(decls.get('word-break')).toBe('break-word');
  });
});

/* -------------------------------------------------------------------------
   4. The responsive fallbacks are reachable
   ------------------------------------------------------------------------- */

describe('the responsive fallbacks', () => {
  it('uses @media, not @container — nothing above these rules is a container', () => {
    // A `@container` query with no `container-type` ancestor never matches at all, which is
    // the quiet way a "responsive" rule turns out to be dead code.
    expect(TENANT_SECTION_CODE).not.toContain('@container');
  });

  it('collapses the tab rail to a single column on a narrow viewport', () => {
    const block = TENANT_SECTION.match(
      /@media \(max-width: 56rem\) \{[\s\S]*?\n\}/g
    )?.join('\n');
    expect(block).toBeDefined();
    expect(block).toContain('.tnt-manage-grid');
    expect(block).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(block).toContain('flex-direction: row;');
  });

  it('closes the tool row’s flag columns up rather than crushing the tool id', () => {
    const block = TENANT_SECTION.match(/@media \(max-width: 48rem\) \{[\s\S]*?\n\}/)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('.tnt-tool-row');
    expect(block).toContain('minmax(0, 1fr) repeat(3, auto)');
    // The caps header cannot survive the reflow — its labels no longer sit over anything.
    expect(block).toContain('.tnt-tool-row--head');
    expect(block).toContain('display: none;');
  });

  it('stacks the feature row before its Enabled pill is squeezed off the sheet', () => {
    expect(TENANT_SECTION).toContain('.tnt-feature-row {\n    flex-direction: column;');
  });
});

/* -------------------------------------------------------------------------
   5. The tinted surfaces stay legible in all nine themes
   ------------------------------------------------------------------------- */

describe('contrast in every theme', () => {
  it('paints the unsaved bar’s ink on its own tint, both from tokens', () => {
    expect(declaration('.tnt-dirty-bar', 'background')).toBe('var(--warn-soft)');
    expect(declaration('.tnt-dirty-bar', 'color')).toBe('var(--warn-fg)');
  });

  it.each(APPEARANCES)('clears AA for the unsaved bar in %s', (_id, appearance) => {
    // The tint is translucent in the dark themes, so it has to be flattened onto the
    // surface it actually sits on before the ink is measured against it.
    const surface = paint('--bg-surface', appearance, PAPER);
    const tint = paint('--warn-soft', appearance, surface);
    const ink = paint('--warn-fg', appearance, tint);
    expect(contrastRatio(ink, tint)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('inks the lock note in --fg, which is the measured choice rather than a preference', () => {
    expect(declaration('.tnt-lock-note', 'color')).toBe('var(--fg)');
  });

  it.each(APPEARANCES)('clears AA for the lock note in %s', (_id, appearance) => {
    const surface = paint('--bg-subtle', appearance, PAPER);
    const ink = paint('--fg', appearance, surface);
    expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('would not have held with --fg-muted, which is why the note is not a quiet line', () => {
    // Solarized measures 4.35:1 for `--fg-muted` on `--bg-subtle`. A measurement, not taste.
    const failures = APPEARANCES.filter(([, appearance]) => {
      const surface = paint('--bg-subtle', appearance, PAPER);
      return (
        contrastRatio(paint('--fg-muted', appearance, surface), surface) <
        WCAG_AA_NORMAL_TEXT_MIN
      );
    }).map(([name]) => name);

    expect(failures.length).toBeGreaterThan(0);
  });

  it('tints each diff value rather than colouring it on the bare surface', () => {
    expect(declaration('.tnt-diff-line__from', 'background')).toBe('var(--danger-soft)');
    expect(declaration('.tnt-diff-line__from', 'color')).toBe('var(--danger-fg)');
    expect(declaration('.tnt-diff-line__to', 'background')).toBe('var(--ok-soft)');
    expect(declaration('.tnt-diff-line__to', 'color')).toBe('var(--ok-fg)');
  });

  it.each(APPEARANCES)('clears AA for a policy diff’s before and after in %s', (_id, appearance) => {
    const surface = paint('--bg-surface', appearance, PAPER);
    for (const [soft, fg] of [
      ['--danger-soft', '--danger-fg'],
      ['--ok-soft', '--ok-fg'],
    ] as const) {
      const tint = paint(soft, appearance, surface);
      const ink = paint(fg, appearance, tint);
      expect(contrastRatio(ink, tint)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('would not have held on the bare surface, which is why the chips are tinted', () => {
    // Nord measures 1.47:1 for `--danger-fg` on `--bg-surface`. Five themes fail outright.
    const failures = APPEARANCES.filter(([, appearance]) => {
      const surface = paint('--bg-surface', appearance, PAPER);
      return (
        contrastRatio(paint('--danger-fg', appearance, surface), surface) <
        WCAG_AA_NORMAL_TEXT_MIN
      );
    }).map(([name]) => name);

    expect(failures.length).toBeGreaterThan(0);
  });

  it('gives every icon-tile tone a soft/fg pair from the same family', () => {
    for (const tone of ['accent', 'honey', 'ok', 'warn', 'danger', 'violet']) {
      const decls = parseDeclarations(
        tenantRule(`.tnt-icon-tile[data-tone="${tone}"]`).body
      );
      expect(decls.get('--tnt-tone-soft')).toBe(`var(--${tone}-soft)`);
      expect(decls.get('--tnt-tone-fg')).toBe(`var(--${tone}-fg)`);
    }
  });

  it('gives an unnamed tile a fallback pair, so it draws a tile rather than nothing', () => {
    const decls = parseDeclarations(tenantRule('.tnt-icon-tile').body);
    expect(decls.get('--tnt-tone-soft')).toBe('var(--neutral-soft)');
    expect(decls.get('--tnt-tone-fg')).toBe('var(--neutral-fg)');
  });
});

/* -------------------------------------------------------------------------
   6. Shared vocabulary, not a second spelling of it
   ------------------------------------------------------------------------- */

describe('what the block borrows rather than reinvents', () => {
  it('clips the hex tile with the one hexagon in the interface', () => {
    expect(declaration('.tnt-icon-tile--hex', 'clip-path')).toBe('var(--hex-clip)');
  });

  it('sizes every inline glyph from the §3.5 icon vocabulary', () => {
    for (const prelude of ['.tnt-icon-tile > svg', '.tnt-menu__item > svg']) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-dense)');
    }
  });

  it('tracks its caps labels with the shared caps tracking', () => {
    for (const prelude of ['.tnt-caps', '.tnt-tool-row--head', '.tnt-kv dt']) {
      expect(declaration(prelude, 'letter-spacing')).toBe('var(--track-caps)');
    }
  });

  it('eases the menu hover on the shared fast duration', () => {
    expect(declaration('.tnt-menu__item', 'transition')).toBe(
      'background-color var(--dur-fast) var(--ease-out)'
    );
  });

  it('marks an unsaved draft in the same warn hue as the bar it points at', () => {
    expect(declaration('.tnt-tab-dot', 'background')).toBe('var(--warn)');
  });

  it('quiets an off toolset with a border, never by fading or tinting it', () => {
    // Measured, twice: `opacity: .85` drags `--fg-muted` to 4.45:1 on paper, and a
    // `--bg-subtle` tint drags it to 4.35:1 in Solarized. Both under AA. A border changes
    // neither the ink nor the backdrop, so it is the one that cannot fail.
    const decls = parseDeclarations(tenantRule('.tnt-toolset-card[data-ceiling="none"]').body);
    expect(decls.get('box-shadow')).toBe('inset 0 0 0 1px var(--border-strong)');
    expect(decls.has('opacity')).toBe(false);
    expect(decls.has('background')).toBe(false);
  });

  it('spends no opacity anywhere in the block, for the same reason', () => {
    for (const prelude of TENANT_PRELUDES) {
      expect({ prelude, opacity: parseDeclarations(tenantRule(prelude).body).get('opacity') })
        .toEqual({ prelude, opacity: undefined });
    }
  });

  it('does not reintroduce the palette classes it replaced', () => {
    const start = STRIPPED.indexOf('.tnt-section-title');
    expect(start).toBeGreaterThan(-1);
    const block = STRIPPED.slice(start);
    for (const banned of ['slate-', 'indigo-', 'amber-', 'emerald-', 'gray-', 'purple-']) {
      expect(block).not.toContain(banned);
    }
  });
});

/* -------------------------------------------------------------------------
   7. The sticky pieces have something to stick to
   ------------------------------------------------------------------------- */

describe('the sticky rail and bar', () => {
  it('sticks the unsaved bar to the bottom of the scrolling drawer body', () => {
    const decls = parseDeclarations(tenantRule('.tnt-dirty-bar').body);
    expect(decls.get('position')).toBe('sticky');
    expect(decls.get('bottom')).toBe('0');
    // Above the toolset cards it floats over, and above the tab rail's own stacking.
    expect(Number(decls.get('z-index'))).toBeGreaterThan(
      Number(parseDeclarations(tenantRule('.tnt-manage-nav').body).get('z-index'))
    );
  });

  it('leaves the tab rail room to move by not stretching it', () => {
    // A stretched grid item fills its row, and `position: sticky` on something with no slack
    // does nothing at all.
    expect(declaration('.tnt-manage-grid', 'align-items')).toBe('start');
    expect(declaration('.tnt-manage-nav', 'position')).toBe('sticky');
  });

  it('paints the rail opaquely, so panel content does not show through it', () => {
    expect(declaration('.tnt-manage-nav', 'background')).toBe('var(--bg-surface)');
  });
});
