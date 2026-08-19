/**
 * MCP dark-theme token regression guard (V2-MCP-24.10 / MCAT-10.10, #3941).
 *
 * The MCP catalog & detail screens render every color from the pure token mappings in
 * `mcpUiPrimitives`, `mcpVersionsUi`, `mcpLintUi`, the `McpBadge` cva, and the shared
 * `numeric-score-tier` bands — never from literals in the components. Those mappings already carry
 * a `dark:` variant for every on-surface tint, so the screens render correctly under the app's dark
 * theme (the theme switch applies the `.dark` class that the `dark:` utilities key off).
 *
 * This suite locks that in: it asserts every token that paints text/background/border/ring on a
 * surface carries a `dark:` variant (so a future edit can't silently drop one and re-introduce a
 * literal-color leak), that the diff add/remove/modify and grade colors stay legible on dark, and —
 * the "light theme is unchanged" criterion — that the original light utility is still present
 * alongside each dark variant. Solid, saturated chips/dots/bars (e.g. `bg-emerald-500 text-white`)
 * read in both themes by design and are asserted to stay saturated solids rather than needing a
 * dark override.
 *
 * Most of the mappings have since left this mechanism behind, because a `dark:` variant is one
 * palette swapped for a second one and only knows about the app's original light/dark pair.
 * HIVE-2.4 (#5283) moved the grade bands and the health pill onto the Hive token layer, HIVE-7.7
 * (#5324) moved `McpBadge`'s seven tones, and HIVE-7.8 (#5325) moved the last three — the version
 * diff's change kinds, the lint tiers, and the trust-posture chips. Their blocks below assert the
 * stronger property that replaced the `dark:` variant — a token and no palette literal, over all
 * nine themes rather than two — and the tones themselves are pinned in
 * `tests/hive-status-vocabulary.test.tsx`.
 *
 * What still asserts a `dark:` variant is what has not moved yet: the shared
 * `numeric-score-tier` bands, which nine surfaces outside MCP read and which therefore belong to
 * a ticket of their own.
 */

import {
  mcpGradeGlyphStyle,
  mcpHealthMeta,
  type McpGradeLetter,
  type McpHealthStatus,
} from '../src/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import { mcpBadgeVariants } from '../src/app/components/ui/mcp/McpBadge';
import type { McpBadgeTone } from '../src/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import {
  mcpChangeStyle,
  mcpChangeCountParts,
  mcpVersionChangeCountParts,
  type McpVersionCompare,
} from '../src/app/components/ade/dashboard/mcp/mcpVersionsUi';
import {
  mcpLintTierMeta,
  mcpLintSeverityBarClass,
  MCP_LINT_TIER_ORDER,
} from '../src/app/components/ade/dashboard/mcp/mcpLintUi';
import {
  STATUS_TONES,
  STATUS_TONE_DOT_CLASS,
  STATUS_TONE_SOFT_CLASS,
} from '../src/app/components/ui/statusVocabulary';
import {
  originChipClass,
  postureOriginTone,
  postureSeverityTone,
  severityChipClass,
} from '../src/app/utils/mcp-trust-posture';
import {
  getNumericScoreTier,
  NUMERIC_SCORE_TIER_LEGEND,
} from '../src/app/utils/numeric-score-tier';

/** A `dark:`-prefixed Tailwind utility appears somewhere in the class string. */
function hasDarkVariant(className: string): boolean {
  return /(^|\s)dark:/.test(className);
}

const GRADE_LETTERS: McpGradeLetter[] = ['A', 'B', 'C', 'D', 'F'];
const HEALTH_STATUSES: McpHealthStatus[] = ['healthy', 'degraded', 'unreachable', 'unknown'];
const BADGE_TONES: McpBadgeTone[] = ['indigo', 'green', 'amber', 'red', 'blue', 'slate', 'violet'];
const CHANGE_TYPES = ['added', 'removed', 'modified'] as const;

/**
 * The grade glyph and the health pill left this mechanism behind in HIVE-2.4 (#5283).
 *
 * A `dark:` variant is one palette swapped for a second one, and it only knows about the app's
 * original light/dark pair. Both surfaces now paint from the Hive token layer, where the *token*
 * is swapped per theme — which is strictly stronger, because it covers all nine palettes rather
 * than two. So the assertion worth making here is no longer "has a dark variant" but "spends a
 * token and no palette literal"; the tones themselves are pinned in
 * `tests/hive-status-vocabulary.test.tsx`.
 */
const PALETTE_LITERAL = /\b(?:bg|text|border|ring|stroke|fill)-(?:slate|gray|zinc|neutral|stone|emerald|green|lime|amber|yellow|orange|red|rose|pink|violet|purple|indigo|blue|sky|cyan|teal)-\d{2,3}\b/;

describe('grade glyph — Hive tokens rather than a dark variant', () => {
  it.each(GRADE_LETTERS)('paints grade %s from tokens, with no palette literal', (letter) => {
    const style = mcpGradeGlyphStyle(letter);
    for (const className of [style.chipClass, style.textClass, style.ringClass]) {
      expect(className).not.toMatch(PALETTE_LITERAL);
      expect(hasDarkVariant(className)).toBe(false);
    }
  });

  it.each(GRADE_LETTERS)('gives grade %s a legible ink on its solid chip', (letter) => {
    // The chip is a solid fill, so it must name the ink that sits on it rather than inherit.
    expect(mcpGradeGlyphStyle(letter).chipClass).toMatch(/\btext-(?:fg-on-accent|honey-ink)\b/);
  });

  it('paints the unscored glyph as a well rather than a sixth grade', () => {
    const unscored = mcpGradeGlyphStyle(null);
    expect(unscored.chipClass).toContain('bg-inset');
    expect(unscored.chipClass).not.toMatch(PALETTE_LITERAL);
    expect(unscored.textClass).not.toMatch(PALETTE_LITERAL);
    expect(unscored.ringClass).not.toMatch(PALETTE_LITERAL);
  });
});

describe('health pill — Hive tokens rather than a dark variant', () => {
  it.each(HEALTH_STATUSES)('paints the %s state from tokens, with no palette literal', (status) => {
    const meta = mcpHealthMeta(status);
    for (const className of [meta.dotClass, meta.textClass]) {
      expect(className).not.toMatch(PALETTE_LITERAL);
      expect(hasDarkVariant(className)).toBe(false);
    }
  });

  it('draws the dot in the saturated role colour and the label in its ink', () => {
    // The dot is a swatch (`--ok`); the label is body text on the page surface, so it takes the
    // `-fg` ink that was calibrated to clear AA there.
    expect(mcpHealthMeta('healthy').dotClass).toBe('bg-ok');
    expect(mcpHealthMeta('healthy').textClass).toBe('text-ok-fg');
  });
});

/**
 * The badge tones left this mechanism behind in HIVE-7.7 (#5324), for the reason the grade glyph
 * and the health pill left it in HIVE-2.4: a `dark:` variant knows about two palettes, and the
 * product has nine appearances. Each tone now resolves through `ui/statusVocabulary`'s `-soft`
 * fill and its calibrated `-fg` ink, so the assertion worth making is "a token and no palette
 * literal" rather than "has a dark variant".
 */
describe('badge tones — Hive tokens rather than a dark variant', () => {
  it.each(BADGE_TONES)('paints the %s tone from tokens, with no palette literal', (tone) => {
    const className = mcpBadgeVariants({ tone });
    expect(className).not.toMatch(PALETTE_LITERAL);
    expect(hasDarkVariant(className)).toBe(false);
  });

  it.each(BADGE_TONES)('pairs the %s tone\'s soft fill with its own ink', (tone) => {
    // A `-fg` ink is only legible on its own `-soft` ground; the two always travel together.
    const className = mcpBadgeVariants({ tone });
    const fill = /\bbg-([a-z]+)-soft\b/.exec(className);
    const ink = /\btext-([a-z]+)-fg\b/.exec(className);
    expect(fill).not.toBeNull();
    expect(ink).not.toBeNull();
    expect(ink?.[1]).toBe(fill?.[1]);
  });

  it('maps the seven tone names onto the vocabulary they mean', () => {
    expect(mcpBadgeVariants({ tone: 'green' })).toContain('bg-ok-soft');
    expect(mcpBadgeVariants({ tone: 'amber' })).toContain('bg-warn-soft');
    expect(mcpBadgeVariants({ tone: 'red' })).toContain('bg-danger-soft');
    expect(mcpBadgeVariants({ tone: 'slate' })).toContain('bg-neutral-soft');
    expect(mcpBadgeVariants({ tone: 'violet' })).toContain('bg-violet-soft');
    // DESIGN.md §0 retires indigo: both informational hues are the one azure accent now.
    expect(mcpBadgeVariants({ tone: 'indigo' })).toContain('bg-accent-soft');
    expect(mcpBadgeVariants({ tone: 'blue' })).toContain('bg-accent-soft');
  });

  it('no longer draws a hairline border from a third colour', () => {
    for (const tone of BADGE_TONES) {
      expect(mcpBadgeVariants({ tone })).not.toMatch(/\bborder-/);
    }
  });
});

describe('version diff — Hive tokens rather than a dark variant', () => {
  /**
   * HIVE-7.8 (#5325) moved the change kinds onto the token layer, the same move HIVE-2.4 made for
   * the grade bands and HIVE-7.7 for `McpBadge`. So the assertion is the stronger one those
   * blocks make — a token and no palette literal, over all nine themes rather than two — plus the
   * *shape* the ticket changed with it: a change row is marked with a rule, not tinted with a
   * fill, because a diff of twelve tinted rows buries the JSON a reader came for.
   */
  it.each(CHANGE_TYPES)('paints the %s change row from tokens, with no palette literal', (changeType) => {
    const style = mcpChangeStyle(changeType);
    expect(style.rowClass).not.toMatch(PALETTE_LITERAL);
    expect(hasDarkVariant(style.rowClass)).toBe(false);
  });

  it('gives the unrecognized-change fallback the same treatment', () => {
    const style = mcpChangeStyle('mystery');
    expect(style.rowClass).not.toMatch(PALETTE_LITERAL);
    expect(style.tone).toBe('neutral');
  });

  it('marks a change row with a rule rather than a tint', () => {
    for (const changeType of [...CHANGE_TYPES, 'mystery']) {
      const { rowClass } = mcpChangeStyle(changeType);
      expect(rowClass).toContain('border-l-2');
      expect(rowClass).not.toMatch(/\bbg-/);
    }
  });

  it('keeps the add=ok / remove=danger / modify=accent language on the count tokens', () => {
    const compare = {
      base: { id: 'a', version_seq: 1, version_tag: null, surface_fingerprint: null },
      target: { id: 'b', version_seq: 2, version_tag: null, surface_fingerprint: null },
      fingerprint_changed: true,
      counts: { added: 1, removed: 1, modified: 1, total: 3 },
      changes: [],
    } as McpVersionCompare;
    const parts = mcpChangeCountParts(compare);
    for (const part of parts) {
      expect(part.colorClass).not.toMatch(PALETTE_LITERAL);
      expect(hasDarkVariant(part.colorClass)).toBe(false);
    }
    const byKey = Object.fromEntries(parts.map((p) => [p.key, p.colorClass]));
    // The *pair*, not the ink alone: the browser sweep HIVE-7.8 added measured `+3` at 1.58:1 in
    // Solarized when it was the `-fg` step on whatever was behind it.
    expect(byKey.added).toBe(STATUS_TONE_SOFT_CLASS.ok);
    expect(byKey.removed).toBe(STATUS_TONE_SOFT_CLASS.danger);
    expect(byKey.modified).toBe(STATUS_TONE_SOFT_CLASS.accent);
    // The fingerprint is a fact about the pair, not a change kind — so it stays neutral.
    expect(byKey.fingerprint).toBe(STATUS_TONE_SOFT_CLASS.neutral);
  });

  it('gives a snapshot row the same three tones the compare header uses', () => {
    const counts = { added: 1, removed: 2, modified: 3, total: 6 };
    for (const part of mcpVersionChangeCountParts(counts)) {
      expect(part.colorClass).not.toMatch(PALETTE_LITERAL);
    }
  });
});

describe('lint report — Hive tokens rather than a dark variant', () => {
  /** The same move, for the three requirement tiers (HIVE-7.8, #5325). */
  it.each([...MCP_LINT_TIER_ORDER])('paints the %s tier from tokens, with no palette literal', (tier) => {
    const meta = mcpLintTierMeta(tier);
    for (const className of [meta.rowClass, meta.barClass]) {
      expect(className).not.toMatch(PALETTE_LITERAL);
      expect(hasDarkVariant(className)).toBe(false);
    }
  });

  it.each([...MCP_LINT_TIER_ORDER])('files the %s tier under a shared status tone', (tier) => {
    expect(STATUS_TONES).toContain(mcpLintTierMeta(tier).tone);
  });

  it('marks a finding row with a rule rather than a tint', () => {
    for (const tier of MCP_LINT_TIER_ORDER) {
      const { rowClass } = mcpLintTierMeta(tier);
      expect(rowClass).toContain('border-l-2');
      expect(rowClass).not.toMatch(/\bbg-/);
    }
  });

  it('paints each severity bar as the tone-s saturated fill', () => {
    expect(mcpLintSeverityBarClass('error')).toBe(STATUS_TONE_DOT_CLASS.danger);
    expect(mcpLintSeverityBarClass('warning')).toBe(STATUS_TONE_DOT_CLASS.warn);
    expect(mcpLintSeverityBarClass('info')).toBe(STATUS_TONE_DOT_CLASS.neutral);
  });
});

describe('trust posture — Hive tokens rather than a dark variant', () => {
  /** The two chip helpers, moved with the rest (HIVE-7.8, #5325). */
  it.each(['error', 'warning', 'info'])('paints the %s severity chip from tokens', (severity) => {
    expect(severityChipClass(severity)).not.toMatch(PALETTE_LITERAL);
    expect(hasDarkVariant(severityChipClass(severity))).toBe(false);
  });

  it.each(['metadata', 'source', 'dependency', 'protocol'])(
    'paints the %s origin chip from tokens',
    (origin) => {
      expect(originChipClass(origin)).not.toMatch(PALETTE_LITERAL);
      expect(hasDarkVariant(originChipClass(origin))).toBe(false);
    },
  );

  it('gives a posture error the same tone as a lint MUST and a failed job', () => {
    expect(postureSeverityTone('error')).toBe('danger');
    expect(postureSeverityTone('error')).toBe(mcpLintTierMeta('must').tone);
  });

  it('keeps the four evidence lanes distinguishable', () => {
    const tones = ['metadata', 'source', 'dependency', 'protocol'].map(postureOriginTone);
    expect(new Set(tones).size).toBe(4);
  });
});

describe('numeric score-tier dark-theme tokens', () => {
  // One representative score per band (excellent / good / fair / poor).
  it.each([95, 80, 60, 20])('gives the score-%d tier text & gauge stroke a dark variant', (score) => {
    const tier = getNumericScoreTier(score);
    expect(hasDarkVariant(tier.textClass)).toBe(true);
    expect(hasDarkVariant(tier.gaugeStrokeClass)).toBe(true);
  });

  it('gives every legend band a dark variant on its surface tints', () => {
    for (const band of NUMERIC_SCORE_TIER_LEGEND) {
      expect(hasDarkVariant(band.textClass)).toBe(true);
      expect(hasDarkVariant(band.gaugeStrokeClass)).toBe(true);
    }
  });

  it('keeps the light score-tier tints (light theme is unchanged)', () => {
    expect(getNumericScoreTier(95).textClass).toContain('text-green-600');
    expect(getNumericScoreTier(95).textClass).toContain('dark:text-green-400');
  });
});
