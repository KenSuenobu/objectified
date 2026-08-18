/**
 * The stylesheet half of the access-audit redesign (HIVE-5.5, #5308).
 *
 * `audit-hive-redesign.test.tsx` renders the page and pins its markup; it cannot pin anything
 * that makes it *look* right, because jsdom compiles no stylesheet. So this suite reads
 * `globals.css` the way `api-keys-css.test.ts` and `members-css.test.ts` do, and pins what
 * the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in twelve places
 *      — `bg-orange-100 text-orange-700` for a role event, `bg-rose-100`, `bg-sky-100`,
 *      `bg-purple-100`, `bg-emerald-100` and `bg-slate-100`, each doubled for dark mode. Every
 *      one froze the surface on one palette, and none agreed with the shared vocabulary.
 *   2. **The mockup's `.ev--*` rules are gone rather than ported.** The families become badge
 *      *tones*, which is why this section declares no event-badge rule at all.
 *   3. **Nothing is frozen in pixels.** The mockup's page-local block fixes the When column at
 *      190px, the search field at 240px, the range select at 150px and the chain gutter at
 *      16px; all are `rem` or a token here, so they follow all six font scales.
 *   4. **The hash and the payload are never truncated and never fade.** A 64-character digest
 *      wraps inside its own box, the JSON block scrolls inside its own box, and neither is
 *      dimmed — these are the characters an auditor compares by eye.
 *   5. **Nothing can scroll the document sideways**: every wide thing here owns its overflow,
 *      and the elided cells have a ceiling to engage against.
 */

import {
  contrastRatio,
  findUnfencedHex,
  parseDeclarations,
  readGlobalsCss,
  readThemeBlocks,
  readTokenLayer,
  resolveThemeToken,
  topLevelRules,
  compositeOver,
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
const AUDIT_PRELUDES = [
  '.aud-when',
  '.aud-actor',
  '.aud-actor__label',
  '.aud-target',
  '.aud-target__main',
  '.aud-target__sub',
  '.aud-chip-glyph',
  '.aud-range',
  '.aud-foot-count',
  '.aud-note',
  '.aud-note > svg',
  '.aud-caps',
  '.aud-drawer-title',
  '.aud-drawer-id',
  '.aud-drawer-when',
  '.aud-callout',
  '.aud-party',
  '.aud-party__text',
  '.aud-party__name',
  '.aud-party__meta',
  '.aud-change',
  '.aud-change__before, .aud-change__after',
  '.aud-change__before',
  '.aud-change__after',
  '.aud-change__arrow',
  '.aud-kv',
  '.aud-kv dt',
  '.aud-kv dd',
  '.aud-quiet',
  '.aud-chain',
  '.aud-chain__row',
  '.aud-chain__label',
  '.aud-hash',
  '.aud-chain__note',
  '.aud-chain__note > svg',
  '.aud-chain__note[data-tone="ok"]',
  '.aud-chain__note[data-tone="danger"]',
  '.aud-json-head',
  '.aud-json',
  '.aud-readonly',
  '.aud-readonly > svg',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link AUDIT_PRELUDES} lists it.
 * @returns The rule.
 */
function auditRule(prelude: string): CssRule {
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
  const value = parseDeclarations(auditRule(prelude).body).get(property);
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
 * The audit block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file, for the reason `api-keys-css.test.ts`
 * records: `globals.css` grows one section per redesign ticket, and a slice that ended at EOF
 * would make every assertion below a claim about every *later* section too.
 */
const AUDIT_SECTION = (() => {
  const start = css.indexOf('ACCESS AUDIT  (HIVE-5.5, #5308)');
  if (start < 0) throw new Error('globals.css has no access-audit section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const AUDIT_SECTION_CODE = AUDIT_SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the access-audit section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = AUDIT_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered p base rule it has to outrank', () => {
    // `.aud-quiet`, `.aud-chain__note`, `.aud-note` and `.aud-callout` are all `p` elements;
    // the bare `p { color: var(--text-muted) }` rule near line 2511 is unlayered, so a rule
    // declared before it would lose whatever its specificity.
    for (const prelude of AUDIT_PRELUDES) {
      expect(auditRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of AUDIT_PRELUDES) {
      for (const [property, value] of parseDeclarations(auditRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the old badges named', () => {
    for (const banned of [
      'emerald-',
      'amber-',
      'orange-1',
      'rose-1',
      'sky-1',
      'purple-',
      'slate-',
      'gray-',
    ]) {
      expect(AUDIT_SECTION_CODE).not.toContain(banned);
    }
  });

  it('ports none of the mockup’s `.ev--*` rules, because a family is a badge tone now', () => {
    // The mockup's page-local block is six rules that each name a hue twice. They are replaced
    // by `auditModel.AUDIT_FAMILY_TONE`, one line of data each — so the stylesheet gains
    // nothing at all for the thing the ticket is most about.
    expect(AUDIT_SECTION_CODE).not.toContain('.ev--');
    expect(rules.some((rule) => rule.prelude.startsWith('.ev'))).toBe(false);
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
    // `1px` is exempt everywhere — a hairline is one device pixel by definition — and `2px`
    // only in a border or ring, which is the weight the design language spends on a rail.
    const RULE_PROPERTIES = new Set([
      'outline',
      'outline-offset',
      'box-shadow',
      'border-inline-start',
      'border-block-end',
    ]);
    for (const prelude of AUDIT_PRELUDES) {
      for (const [property, value] of parseDeclarations(auditRule(prelude).body)) {
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

  it('sizes the range select in rem rather than the mockup’s 150px, and lets it shrink', () => {
    expect(declaration('.aud-range', 'inline-size')).toBe('10.5rem');
    expect(declaration('.aud-range', 'max-inline-size')).toBe('100%');
    // The control's height is the shared metric, so it matches the search box beside it at
    // both densities rather than being a second, nearly-equal number.
    expect(declaration('.aud-range', 'block-size')).toBe('var(--control-h-sm)');
  });

  it('sizes every glyph from the icon token, so a mark grows with its text', () => {
    for (const prelude of [
      '.aud-chip-glyph',
      '.aud-note > svg',
      '.aud-change__arrow',
      '.aud-chain__note > svg',
      '.aud-readonly > svg',
    ]) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-dense)');
    }
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.aud-actor', 'gap'],
      ['.aud-party', 'gap'],
      ['.aud-party', 'padding'],
      ['.aud-chain', 'gap'],
      ['.aud-chain__row', 'padding'],
      ['.aud-json', 'padding'],
      ['.aud-note', 'gap'],
      ['.aud-kv', 'gap'],
      ['.aud-chain__note', 'padding'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--space-/);
    }
  });

  it('states every font size as a scale token', () => {
    for (const prelude of AUDIT_PRELUDES) {
      const size = parseDeclarations(auditRule(prelude).body).get('font-size');
      if (size === undefined) continue;
      expect({ prelude, size }).toMatchObject({ prelude, size: expect.stringMatching(/var\(--fs-/) });
    }
  });
});

/* -------------------------------------------------------------------------
   3. The hash and the payload are legible and complete
   ------------------------------------------------------------------------- */

describe('the hash chain and the payload', () => {
  it('wraps a 64-character digest rather than clipping or eliding it', () => {
    // A hash the reader can see only half of is one they cannot check against a server-side
    // digest, which is the entire reason the drawer shows it.
    expect(declaration('.aud-hash', 'word-break')).toBe('break-all');
    const hash = parseDeclarations(auditRule('.aud-hash').body);
    expect(hash.get('text-overflow')).toBeUndefined();
    expect(hash.get('white-space')).toBeUndefined();
  });

  it('draws the hash in the mono family, so two digests line up character for character', () => {
    expect(declaration('.aud-hash', 'font-family')).toBe('var(--font-mono)');
  });

  it('scrolls the payload inside its own box, never taking the document sideways', () => {
    expect(declaration('.aud-json', 'overflow')).toBe('auto');
    expect(declaration('.aud-json', 'max-block-size')).toMatch(/rem$/);
    // `pre`, so the JSON keeps its indentation; the box moves, the payload is never shortened.
    expect(declaration('.aud-json', 'white-space')).toBe('pre');
  });

  it('never fades anything — a dimmed hash is a hash that can fail a contrast check', () => {
    expect(AUDIT_SECTION_CODE).not.toMatch(/(?<!-)\bopacity\s*:/);
    expect(declaration('.aud-hash', 'color')).toBe('var(--fg)');
    expect(declaration('.aud-json', 'color')).toBe('var(--fg)');
  });

  it('keeps the hash and the payload readable on their recessed ground in all nine themes', () => {
    for (const [name, appearance] of APPEARANCES) {
      const ground = paint('--bg-inset', appearance, PAPER);
      const ink = paint('--fg', appearance, ground);
      expect({ theme: name, ratio: contrastRatio(ink, ground) }).toMatchObject({
        theme: name,
        ratio: expect.any(Number),
      });
      expect(contrastRatio(ink, ground)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('gives a toned chain verdict its own soft ground, never bare tinted text', () => {
    // `--ok-fg` and `--danger-fg` are chosen to clear AA on their *own* soft fill. As loose
    // text on the sheet they do not, which is the finding `hive-audit.spec.ts` caught — and
    // the same trap HIVE-5.4 measured on the expired-key date.
    for (const tone of ['ok', 'danger']) {
      const prelude = `.aud-chain__note[data-tone="${tone}"]`;
      expect(declaration(prelude, 'background')).toBe(`var(--${tone}-soft)`);
      expect(declaration(prelude, 'color')).toBe(`var(--${tone}-fg)`);
    }
    // The untoned verdict stays on the sheet, where `--fg-muted` is AA.
    expect(declaration('.aud-chain__note', 'background')).toBe('transparent');
  });

  it('keeps each toned verdict above AA on the ground it actually sits on, in every theme', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      for (const tone of ['ok', 'danger']) {
        const ground = paint(`--${tone}-soft`, appearance, surface);
        const ink = paint(`--${tone}-fg`, appearance, ground);
        const ratio = contrastRatio(ink, ground);
        expect({ theme: name, tone, ratio }).toMatchObject({ theme: name, tone });
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
      }
    }
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text is muted, not subtle
   ------------------------------------------------------------------------- */

describe('quiet text', () => {
  it('uses --fg-muted rather than --fg-subtle, which does not clear AA at these sizes', () => {
    for (const prelude of [
      '.aud-when',
      '.aud-quiet',
      '.aud-note',
      '.aud-caps',
      '.aud-party__meta',
      '.aud-drawer-id',
      '.aud-drawer-when',
      '.aud-chain__label',
      '.aud-chain__note',
      '.aud-readonly',
      '.aud-kv dt',
    ]) {
      expect(declaration(prelude, 'color')).toBe('var(--fg-muted)');
    }
  });

  it('keeps --fg-muted above AA on the surface in every theme', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const ink = paint('--fg-muted', appearance, surface);
      expect({ theme: name, ratio: contrastRatio(ink, surface) }).toMatchObject({
        theme: name,
        ratio: expect.any(Number),
      });
      expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('keeps the “after” chip’s ink above AA on its own accent ground in every theme', () => {
    expect(declaration('.aud-change__after', 'background')).toBe('var(--accent-soft)');
    expect(declaration('.aud-change__after', 'color')).toBe('var(--accent-fg)');
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const chip = paint('--accent-soft', appearance, surface);
      const ink = paint('--accent-fg', appearance, chip);
      expect({ theme: name, ratio: contrastRatio(ink, chip) }).toMatchObject({
        theme: name,
        ratio: expect.any(Number),
      });
      expect(contrastRatio(ink, chip)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });
});

/* -------------------------------------------------------------------------
   5. Nothing scrolls the document sideways
   ------------------------------------------------------------------------- */

describe('horizontal containment', () => {
  it('caps the two elided cells so their ellipsis has something to engage against', () => {
    // `max-width`, not `max-inline-size`: the build's CSS transform drops the logical spelling
    // from a rule that also carries `min-width` (measured in HIVE-5.2 and restated in 5.4).
    expect(declaration('.aud-actor', 'max-width')).toMatch(/rem$/);
    expect(declaration('.aud-target', 'max-width')).toMatch(/rem$/);
    expect(declaration('.aud-actor', 'min-width')).toBe('0');
    expect(declaration('.aud-target', 'min-width')).toBe('0');
  });

  it('lets long values in the drawer wrap rather than widening the sheet', () => {
    for (const prelude of ['.aud-party__name', '.aud-party__meta', '.aud-kv dd']) {
      expect(declaration(prelude, 'word-break')).toBe('break-word');
    }
    expect(declaration('.aud-drawer-id', 'word-break')).toBe('break-all');
  });

  it('wraps every cluster that can outgrow its row', () => {
    for (const prelude of ['.aud-drawer-title', '.aud-change', '.aud-json-head']) {
      expect(declaration(prelude, 'flex-wrap')).toBe('wrap');
    }
  });

  it('stacks the detail list below the narrow breakpoint instead of squeezing it', () => {
    const media = rules.find((rule) => rule.prelude.startsWith('@media') && rule.body.includes('.aud-kv'));
    expect(media).toBeDefined();
    expect(media?.prelude).toContain('rem');
    expect(media?.body).toContain('grid-template-columns: minmax(0, 1fr)');
  });
});
