/**
 * The stylesheet half of the Roles redesign (HIVE-5.3, #5306).
 *
 * `roles-hive-redesign.test.tsx` renders the page and pins its markup; it cannot pin anything
 * that makes it *look* right, because jsdom compiles no stylesheet. So this suite reads
 * `globals.css` the way `members-css.test.ts` does, and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in eleven
 *      places — `bg-emerald-500` for a granted cell, `border-slate-300` for an ungranted one,
 *      `bg-indigo-600` for the page mark, `bg-indigo-50` for the selected role, and
 *      `text-rose-600` for Delete. Every one of those froze the surface on one palette.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block sets the matrix columns
 *      at 92 px, the cell rows at 42 px, the toggle at 24 px and its glyph at 14 px. All four
 *      are `rem` or a shared metric here, so they follow all six font scales and both
 *      densities.
 *   3. **The four cell states are visually distinct, and distinct by more than one channel.**
 *      Granted fills, denied is a hairline on the surface, partial is a tint inside a ring,
 *      locked is an inset ground — and the granted fill clears 3:1 against the surface it
 *      sits on in every one of the nine appearances, which is what makes the state readable
 *      when the white check inside it is not (the deviation the block states outright).
 *   4. **Locked is drawn, not faded.** The block spends no `opacity` at all: a fade dims the
 *      words around a control along with the control.
 *   5. **The matrix scrolls, the document does not.** Six columns cannot always fit, so the
 *      wrapper owns the overflow and the pane's grid track is `minmax(0, …)`.
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

/** WCAG 1.4.11 for a graphic that carries state — the bar a filled toggle has to clear. */
const WCAG_AA_NON_TEXT_MIN = 3;

/** Pure white, the last thing behind every surface. */
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

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
const ROLE_PRELUDES = [
  '.rol-panes',
  '.rol-list',
  '.rol-item',
  '.rol-item:hover',
  '.rol-item[aria-current="true"]',
  '.rol-item[aria-current="true"] .tnt-icon-tile',
  '.rol-item__text',
  '.rol-item__name',
  '.rol-item__label',
  '.rol-item__sub',
  '.rol-item__count',
  '.rol-dot',
  '.rol-name-edit',
  '.rol-name-edit:hover',
  '.rol-name-edit:focus',
  '.rol-name-static',
  '.rol-matrix-wrap',
  '.rol-matrix',
  '.rol-matrix thead th:not(:first-child), .rol-matrix tbody td',
  '.rol-matrix thead th',
  '.rol-matrix thead th:first-child, .rol-matrix tbody th',
  '.rol-matrix tbody th, .rol-matrix tbody td',
  '.rol-matrix tbody tr:last-child th, .rol-matrix tbody tr:last-child td',
  '.rol-matrix tbody tr:hover th, .rol-matrix tbody tr:hover td',
  '.rol-matrix thead th > span',
  '.rol-matrix thead th > span > svg',
  '.rol-res',
  '.rol-res__name',
  '.rol-res__key',
  '.rol-perm',
  '.rol-perm > svg',
  '.rol-perm:hover:not(:disabled)',
  '.rol-perm[aria-pressed="true"]',
  '.rol-perm[aria-pressed="true"]:hover:not(:disabled)',
  '.rol-perm[aria-pressed="mixed"]',
  '.rol-perm:disabled',
  '.rol-perm[aria-pressed="true"]:disabled',
  '.rol-save-bar',
  '.rol-save-bar__count',
  '.rol-save-bar__count > svg',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link ROLE_PRELUDES} lists it.
 * @returns The rule.
 */
function roleRule(prelude: string): CssRule {
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
  const value = parseDeclarations(roleRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/**
 * The opaque colour a token resolves to in one appearance, flattened onto its backdrop.
 *
 * The `-soft` tints are deliberately translucent in the dark themes, so a contrast claim
 * about one has to composite it first, the way a browser does.
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
 * The roles block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file: `globals.css` grows one section per
 * redesign ticket, and a slice that ended at EOF made every assertion below a claim about
 * every *later* section too — HIVE-5.4's `.akey-row--expired [data-row-actions] { opacity: 1 }`
 * is a deliberate un-fade of a row's actions, and it failed the "no opacity" rule this block
 * states about its own permission cells.
 */
const ROLE_SECTION = (() => {
  const start = css.indexOf('ROLES (HIVE-5.3, #5306)');
  if (start < 0) throw new Error('globals.css has no roles section');
  // Every section opens with the same `/* ===…` banner rule; the first one after this
  // section's own opening line is where the next section begins.
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  const end = next < 0 ? css.length : next;
  return css.slice(bannerStart < 0 ? start : bannerStart, end);
})();

/** The same block with its comments removed. */
const ROLE_SECTION_CODE = ROLE_SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the roles section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = ROLE_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered h2 and p base rules it has to outrank', () => {
    // `.rol-name-static` is the one that has to: a built-in role's name is an `h2`, and the
    // unlayered `h2 { font-size: clamp(…) }` beats anything in `@layer utilities`.
    for (const prelude of ROLE_PRELUDES) {
      expect(roleRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of ROLE_PRELUDES) {
      for (const [property, value] of parseDeclarations(roleRule(prelude).body)) {
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        // `color-mix(in srgb, var(--ok) 88%, black)` is a token expression, not a colour: it
        // names no channel of its own. A literal `rgb(…)`/`hsl(…)` would be.
        expect({ prelude, property, value: value.replace(/color-mix\([^)]*\)/g, '') }).toMatchObject(
          { prelude, property }
        );
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes it replaced', () => {
    for (const banned of ['emerald-', 'indigo-', 'slate-', 'rose-', 'gray-']) {
      expect(ROLE_SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });

  it('borrows the two shared classes rather than restating them under a rol- name', () => {
    // `.tnt-icon-tile` and `.tnt-lock-note` are general primitives that happen to have been
    // written for HIVE-5.1. A second copy would be the same tokens under a second name.
    expect(rules.some((rule) => rule.prelude === '.tnt-icon-tile')).toBe(true);
    expect(rules.some((rule) => rule.prelude === '.tnt-lock-note')).toBe(true);
    expect(ROLE_SECTION_CODE).not.toContain('.rol-icon-tile');
    expect(ROLE_SECTION_CODE).not.toContain('.rol-lock-note');
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` and `1.5px` are exempt, and only those two: a hairline is one device pixel by
    // definition, and the 1.5px weight is the one the design language already spends on a
    // ring that has to read against the hairline colour (`.empty--dashed`, hive.css §14).
    // Neither may grow with the font scale.
    for (const prelude of ROLE_PRELUDES) {
      for (const [property, value] of parseDeclarations(roleRule(prelude).body)) {
        const offending = value
          .match(/(?<!\d)(\d*\.?\d+)px/g)
          ?.filter((px) => px !== '1px' && px !== '1.5px');
        expect({ prelude, property, offending: offending ?? [] }).toMatchObject({
          prelude,
          property,
          offending: [],
        });
      }
    }
  });

  it('sizes the matrix columns and the toggle in rem, not the mockup’s 92px and 24px', () => {
    expect(
      declaration('.rol-matrix thead th:not(:first-child), .rol-matrix tbody td', 'inline-size')
    ).toBe('5.75rem');
    expect(declaration('.rol-perm', 'inline-size')).toBe('1.5rem');
    expect(declaration('.rol-perm', 'block-size')).toBe('1.5rem');
    expect(declaration('.rol-perm > svg', 'inline-size')).toBe('0.875rem');
  });

  it('takes the cell row height from the shared metric rather than the mockup’s 42px', () => {
    expect(declaration('.rol-matrix tbody th, .rol-matrix tbody td', 'block-size')).toBe(
      'var(--row-h)'
    );
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.rol-panes', 'gap'],
      ['.rol-list', 'gap'],
      ['.rol-item', 'gap'],
      ['.rol-res', 'gap'],
      ['.rol-save-bar', 'gap'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--space-\d\)/);
    }
  });

  it('takes every type size from the scale', () => {
    for (const [prelude, expected] of [
      ['.rol-item__name', 'var(--fs-sm)'],
      ['.rol-item__sub', 'var(--fs-2xs)'],
      ['.rol-item__count', 'var(--fs-xs)'],
      ['.rol-name-edit', 'var(--fs-xl)'],
      ['.rol-name-static', 'var(--fs-xl)'],
      ['.rol-matrix thead th', 'var(--fs-2xs)'],
      ['.rol-res__name', 'var(--fs-sm)'],
      ['.rol-res__key', 'var(--fs-2xs)'],
      ['.rol-save-bar', 'var(--fs-sm)'],
    ] as const) {
      expect(declaration(prelude, 'font-size')).toBe(expected);
    }
  });
});

/* -------------------------------------------------------------------------
   3. The four cell states
   ------------------------------------------------------------------------- */

describe('the permission cell', () => {
  it('draws each of the four states off `aria-pressed`, not off a class', () => {
    // The state a screen reader is told and the state the stylesheet draws are then the same
    // attribute — they cannot fall out of step, because there is only one of them.
    expect(ROLE_SECTION_CODE).toContain('.rol-perm[aria-pressed="true"]');
    expect(ROLE_SECTION_CODE).toContain('.rol-perm[aria-pressed="mixed"]');
    expect(ROLE_SECTION_CODE).toContain('.rol-perm:disabled');
  });

  it('separates granted, denied, partial and locked by ground as well as by ink', () => {
    const denied = parseDeclarations(roleRule('.rol-perm').body);
    const granted = parseDeclarations(roleRule('.rol-perm[aria-pressed="true"]').body);
    const partial = parseDeclarations(roleRule('.rol-perm[aria-pressed="mixed"]').body);
    const locked = parseDeclarations(roleRule('.rol-perm:disabled').body);

    expect(denied.get('background')).toBe('var(--bg-surface)');
    expect(denied.get('box-shadow')).toContain('var(--border-strong)');
    expect(granted.get('background')).toBe('var(--ok)');
    expect(granted.get('box-shadow')).toBe('none');
    expect(partial.get('background')).toBe('var(--ok-soft)');
    expect(partial.get('box-shadow')).toContain('var(--ok)');
    expect(locked.get('background')).toBe('var(--bg-inset)');
  });

  it('keeps a granted cell readable as granted in all nine appearances', () => {
    // The measured deviation the block states: the white check *inside* the fill is under
    // 3:1 in three of the palettes. What carries the state is the fill against the surface
    // around it, so that is what has to clear the bar — and it does, everywhere.
    for (const [id, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const fill = paint('--ok', appearance, surface);
      expect({ id, ratio: contrastRatio(fill, surface) >= WCAG_AA_NON_TEXT_MIN }).toEqual({
        id,
        ratio: true,
      });
    }
  });

  it('keeps the partial state’s dash legible on its own tint, everywhere', () => {
    for (const [id, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const tint = paint('--ok-soft', appearance, surface);
      const ink = paint('--ok-fg', appearance, tint);
      expect({ id, ratio: contrastRatio(ink, tint) >= WCAG_AA_NON_TEXT_MIN }).toEqual({
        id,
        ratio: true,
      });
    }
  });

  it('draws the locked state rather than fading it', () => {
    // A fade dims the resource label beside the control along with the control. The block
    // spends no `opacity` at all — locked is an inset ground and a quieter hairline.
    expect(ROLE_SECTION_CODE).not.toMatch(/\bopacity\s*:/);
  });
});

/* -------------------------------------------------------------------------
   4. Nothing can scroll the document sideways
   ------------------------------------------------------------------------- */

describe('containment', () => {
  it('lets the matrix scroll inside its own wrapper', () => {
    expect(declaration('.rol-matrix-wrap', 'overflow-x')).toBe('auto');
  });

  it('gives the editor pane a track that can be narrower than its content', () => {
    // Without `minmax(0, 1fr)` the track's automatic minimum is the table's intrinsic width,
    // and a 6-column matrix widens the page instead of scrolling inside its wrapper.
    expect(declaration('.rol-panes', 'grid-template-columns')).toBe('16.5rem minmax(0, 1fr)');
  });

  it('collapses the two panes to one column before the editor is squeezed', () => {
    expect(ROLE_SECTION_CODE).toMatch(
      /@media \(max-width: 60rem\)\s*\{\s*\.rol-panes\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/
    );
  });

  it('elides a long role name rather than widening the list pane', () => {
    expect(declaration('.rol-item__label', 'text-overflow')).toBe('ellipsis');
    expect(declaration('.rol-item__text', 'min-width')).toBe('0');
    expect(declaration('.rol-name-static', 'min-width')).toBe('0');
  });

  it('uses @media rather than @container, which would never match', () => {
    // A container query with no `container-type` above it silently never matches — the trap
    // the members block records.
    expect(ROLE_SECTION_CODE).not.toContain('@container');
  });
});

/* -------------------------------------------------------------------------
   5. The quiet lines
   ------------------------------------------------------------------------- */

describe('the quiet lines', () => {
  it('are --fg-muted, which clears AA on both grounds in all nine appearances', () => {
    // Not `--fg-subtle`, which measures around 3.1:1 at these sizes — the same measurement
    // the tenants and members blocks record.
    for (const prelude of ['.rol-item__sub', '.rol-item__count', '.rol-res__key']) {
      expect(declaration(prelude, 'color')).toBe('var(--fg-muted)');
    }
    for (const [id, appearance] of APPEARANCES) {
      for (const ground of ['--bg-canvas', '--bg-surface']) {
        const backdrop = paint(ground, appearance, PAPER);
        const ink = paint('--fg-muted', appearance, backdrop);
        expect({ id, ground, ok: contrastRatio(ink, backdrop) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual(
          { id, ground, ok: true }
        );
      }
    }
  });

  it('keeps the inverted save bar legible in all nine appearances', () => {
    for (const [id, appearance] of APPEARANCES) {
      const ground = paint('--fg', appearance, PAPER);
      const ink = paint('--bg-surface', appearance, ground);
      expect({ id, ok: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        id,
        ok: true,
      });
    }
    expect(declaration('.rol-save-bar', 'background')).toBe('var(--fg)');
    expect(declaration('.rol-save-bar', 'color')).toBe('var(--bg-surface)');
  });

  it('sticks the save bar to the pane rather than to the viewport', () => {
    // `fixed` would float it over the rail as well as over the matrix; the page body is the
    // scroller, so `sticky` keeps it inside the editor's column.
    expect(declaration('.rol-save-bar', 'position')).toBe('sticky');
  });
});
