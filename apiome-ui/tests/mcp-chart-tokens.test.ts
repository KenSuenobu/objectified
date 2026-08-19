/**
 * Unit tests for the chart-kit token mapping (V2-MCP-28.3 / MCAT-14.3; retoned HIVE-7.9, #5326).
 *
 * Proves the "consumers pass domain values, primitives pick color" contract: every tone resolves to
 * `fill-*`/`stroke-*`/`text-*` utilities (never a hex literal), unknown tones fall back to neutral,
 * and categorical assignment is stable and cyclic.
 *
 * Since HIVE-7.9 it also proves what those utilities *point at*. The kit used to answer in Tailwind
 * ramp classes with a `dark:` variant beside each (`fill-indigo-500 dark:fill-indigo-400`), which
 * knows about two palettes; the product has nine appearances, and `globals.css` re-points only the
 * `--color-*` role tokens per theme, never Tailwind's own ramps. So the assertion worth making is
 * no longer "has a dark variant" but "spends a role token and no palette literal" — the same move
 * `tests/mcp-dark-theme-tokens.test.ts` records for the grade glyph, the health pill and the seven
 * badge tones.
 */
import {
  chartSeriesStyle,
  chartCategoricalTone,
  chartCategoricalStyle,
  CHART_CATEGORICAL_ORDER,
  CHART_SURFACE,
  CHART_TONE_ROLE,
  type ChartSeriesTone,
} from '../src/app/components/ui/mcp/charts/chartTokens';

/** A Tailwind ramp class — the thing this kit must no longer emit. */
const PALETTE_LITERAL =
  /\b(?:bg|text|border|ring|stroke|fill)-(?:slate|gray|zinc|neutral|stone|emerald|green|lime|amber|yellow|orange|red|rose|pink|violet|purple|indigo|blue|sky|cyan|teal)-\d{2,3}\b/;

/** The role tokens `ui/statusVocabulary` and the Hive token layer actually define. */
const ROLES = new Set([
  'accent',
  'ok',
  'warn',
  'danger',
  'violet',
  'orange',
  'rose',
  'honey',
  'neutral',
  'ink',
]);

const ALL_TONES: ChartSeriesTone[] = [
  'indigo',
  'emerald',
  'amber',
  'red',
  'blue',
  'violet',
  'green',
  'orange',
  'cyan',
  'pink',
  'neutral',
];

describe('chartSeriesStyle', () => {
  it('maps every tone to fill/stroke/text utility classes', () => {
    for (const tone of ALL_TONES) {
      const s = chartSeriesStyle(tone);
      expect(s.tone).toBe(tone);
      expect(s.fillClass).toMatch(/^fill-/);
      expect(s.strokeClass).toMatch(/^stroke-/);
      expect(s.textClass).toMatch(/^text-/);
    }
  });

  it('never emits a hex or rgb color literal', () => {
    for (const tone of ALL_TONES) {
      const s = chartSeriesStyle(tone);
      const joined = `${s.fillClass} ${s.strokeClass} ${s.textClass}`;
      expect(joined).not.toMatch(/#[0-9a-f]{3,6}|rgb|hsl/i);
    }
  });

  it('falls back to neutral for an unknown/nullish tone', () => {
    expect(chartSeriesStyle(null).tone).toBe('neutral');
    expect(chartSeriesStyle(undefined).tone).toBe('neutral');
    expect(chartSeriesStyle('chartreuse' as ChartSeriesTone).tone).toBe('neutral');
  });

  it('spends a role token and never a Tailwind ramp or a dark: variant', () => {
    for (const tone of ALL_TONES) {
      const s = chartSeriesStyle(tone);
      const joined = `${s.fillClass} ${s.strokeClass} ${s.textClass}`;
      expect(joined).not.toMatch(PALETTE_LITERAL);
      expect(joined).not.toMatch(/(^|\s)dark:/);
    }
  });

  it('paints all three channels from one role, so they cannot drift', () => {
    for (const tone of ALL_TONES) {
      const role = CHART_TONE_ROLE[tone];
      expect(ROLES.has(role)).toBe(true);
      expect(chartSeriesStyle(tone)).toMatchObject({
        fillClass: `fill-${role}`,
        strokeClass: `stroke-${role}`,
        textClass: `text-${role}`,
      });
    }
  });

  it('resolves the three informational blues and the two greens onto one role each', () => {
    // DESIGN.md §0 retires indigo in favour of one azure; `McpBadge` made the same call for its
    // own `indigo`/`blue` pair in HIVE-7.7.
    expect(CHART_TONE_ROLE.indigo).toBe('accent');
    expect(CHART_TONE_ROLE.blue).toBe('accent');
    expect(CHART_TONE_ROLE.cyan).toBe('accent');
    expect(CHART_TONE_ROLE.emerald).toBe('ok');
    expect(CHART_TONE_ROLE.green).toBe('ok');
  });
});

describe('chartCategoricalTone', () => {
  it('cycles through the categorical order', () => {
    expect(chartCategoricalTone(0)).toBe(CHART_CATEGORICAL_ORDER[0]);
    const n = CHART_CATEGORICAL_ORDER.length;
    expect(chartCategoricalTone(n)).toBe(CHART_CATEGORICAL_ORDER[0]);
    expect(chartCategoricalTone(n + 2)).toBe(CHART_CATEGORICAL_ORDER[2]);
  });

  it('handles negative and non-finite indices without escaping the palette', () => {
    expect(CHART_CATEGORICAL_ORDER).toContain(chartCategoricalTone(-1));
    expect(chartCategoricalTone(Number.NaN)).toBe(CHART_CATEGORICAL_ORDER[0]);
  });

  it('never auto-assigns the reserved neutral tone', () => {
    expect(CHART_CATEGORICAL_ORDER).not.toContain('neutral');
  });

  it('chartCategoricalStyle resolves the tone at an index', () => {
    expect(chartCategoricalStyle(1).tone).toBe(CHART_CATEGORICAL_ORDER[1]);
  });

  it('hands out a distinct role at every position, so no two slices collide', () => {
    // Five of the eleven tone *names* collapse onto three roles. A categorical order that still
    // listed all of them would give a five-slice donut two identical colours — which is exactly
    // what a legend cannot repair.
    const roles = CHART_CATEGORICAL_ORDER.map((tone) => CHART_TONE_ROLE[tone]);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('opens on the order `sources/mcp-analytics.html` draws its category donut in', () => {
    expect(CHART_CATEGORICAL_ORDER.slice(0, 5).map((tone) => CHART_TONE_ROLE[tone])).toEqual([
      'accent',
      'ok',
      'violet',
      'warn',
      'rose',
    ]);
  });
});

describe('CHART_SURFACE', () => {
  it('exposes token classes for furniture, not literals', () => {
    const joined = Object.values(CHART_SURFACE).join(' ');
    expect(joined).not.toMatch(/#[0-9a-f]{3,6}|rgb|hsl/i);
    expect(joined).not.toMatch(PALETTE_LITERAL);
    expect(CHART_SURFACE.trackStrokeClass).toMatch(/^stroke-/);
    expect(CHART_SURFACE.labelClass).toMatch(/^fill-/);
  });

  it('sets both label steps above `--fg-subtle`, which fails AA at chart-label sizes', () => {
    expect(CHART_SURFACE.labelClass).toBe('fill-fg-muted');
    expect(CHART_SURFACE.labelStrongClass).toBe('fill-fg');
  });
});
