/**
 * Unit tests for the catalog detail Overview derivations (`catalog-detail-insights`).
 *
 * These pin the pure math the richer Overview tab renders — the entity-kind distribution, the
 * field documentation/requiredness roll-up, the normalized-summary composition, and the coarse
 * relative-time phrasing the provenance timeline shows — apart from any DOM.
 */

import {
  deriveParsedFieldStats,
  deriveSurfaceComposition,
  deriveTagDistribution,
  formatRelativeTimestamp,
  SURFACE_KEYS,
} from '../src/app/utils/catalog-detail-insights';

const GROUPS = [
  {
    title: 'Operations',
    entities: [
      {
        name: 'orders',
        tag: 'QUERY',
        fields: [
          { description: 'Lifecycle state', required: false },
          { description: null, required: true },
        ],
      },
      { name: 'users', tag: 'query', fields: [] }, // lowercase folds into QUERY
      { name: 'placeOrder', tag: 'MUTATION', fields: [] },
    ],
  },
  {
    title: 'Types',
    entities: [
      {
        name: 'Order',
        tag: 'OBJECT',
        fields: [{ description: 'Order total', required: true }],
      },
      { name: 'anonymous', tag: '  ', fields: [] }, // blank tag is skipped
    ],
  },
];

describe('deriveTagDistribution', () => {
  it('tallies tags across groups, case-folded, largest first with stable ties', () => {
    const rows = deriveTagDistribution(GROUPS);
    expect(rows).toEqual([
      { tag: 'QUERY', count: 2, percent: 50 },
      { tag: 'MUTATION', count: 1, percent: 25 },
      { tag: 'OBJECT', count: 1, percent: 25 },
    ]);
  });

  it('returns [] for an absent model or one with no tagged entities', () => {
    expect(deriveTagDistribution(null)).toEqual([]);
    expect(deriveTagDistribution([])).toEqual([]);
    expect(deriveTagDistribution([{ title: 'T', entities: [{ name: 'x', tag: '', fields: [] }] }])).toEqual([]);
  });
});

describe('deriveParsedFieldStats', () => {
  it('rolls entities and fields up into documentation / requiredness coverage', () => {
    const stats = deriveParsedFieldStats(GROUPS);
    expect(stats.entityCount).toBe(5);
    expect(stats.fieldCount).toBe(3);
    expect(stats.documentedFieldCount).toBe(2); // 'Lifecycle state' + 'Order total'
    expect(stats.requiredFieldCount).toBe(2);
    expect(stats.documentedPercent).toBe(67);
    expect(stats.requiredPercent).toBe(67);
  });

  it('treats blank descriptions as undocumented', () => {
    const stats = deriveParsedFieldStats([
      { title: 'T', entities: [{ name: 'x', tag: 'OBJECT', fields: [{ description: '   ' }] }] },
    ]);
    expect(stats.documentedFieldCount).toBe(0);
    expect(stats.documentedPercent).toBe(0);
  });

  it('yields null percentages when there are no fields to measure', () => {
    const stats = deriveParsedFieldStats([
      { title: 'T', entities: [{ name: 'x', tag: 'OBJECT', fields: [] }] },
    ]);
    expect(stats.entityCount).toBe(1);
    expect(stats.fieldCount).toBe(0);
    expect(stats.documentedPercent).toBeNull();
    expect(stats.requiredPercent).toBeNull();
  });
});

describe('deriveSurfaceComposition', () => {
  it('folds the captured counts into share-of-total segments, zero counts dropped', () => {
    const composition = deriveSurfaceComposition({
      services: 2,
      operations: 7,
      types: 12,
      channels: 0,
    });
    expect(composition.total).toBe(21);
    expect(composition.segments).toEqual([
      { key: 'services', count: 2, percent: 10 },
      { key: 'operations', count: 7, percent: 33 },
      { key: 'types', count: 12, percent: 57 },
    ]);
  });

  it('skips uncaptured (null) counts rather than treating them as zero', () => {
    const composition = deriveSurfaceComposition({ services: null, operations: 4, types: null, channels: null });
    expect(composition.total).toBe(4);
    expect(composition.segments).toEqual([{ key: 'operations', count: 4, percent: 100 }]);
  });

  it('returns an empty composition when nothing was captured', () => {
    expect(deriveSurfaceComposition(null)).toEqual({ total: 0, segments: [] });
    expect(
      deriveSurfaceComposition({ services: null, operations: null, types: null, channels: null }),
    ).toEqual({ total: 0, segments: [] });
  });

  it('keeps the display order of the summary keys', () => {
    expect(SURFACE_KEYS).toEqual(['services', 'operations', 'types', 'channels']);
  });
});

describe('formatRelativeTimestamp', () => {
  const NOW = Date.parse('2026-07-26T12:00:00.000Z');

  it.each([
    ['2026-07-26T11:59:30.000Z', 'just now'],
    ['2026-07-26T11:58:00.000Z', '2 minutes ago'],
    ['2026-07-26T09:00:00.000Z', '3 hours ago'],
    ['2026-07-20T12:00:00.000Z', '6 days ago'],
    ['2026-05-01T12:00:00.000Z', '2 months ago'],
    ['2024-07-01T12:00:00.000Z', '2 years ago'],
  ])('renders %s as "%s"', (iso, expected) => {
    expect(formatRelativeTimestamp(iso, NOW)).toBe(expected);
  });

  it('reads future instants (clock skew) as "just now"', () => {
    expect(formatRelativeTimestamp('2026-07-26T12:05:00.000Z', NOW)).toBe('just now');
  });

  it('returns null for absent or invalid input', () => {
    expect(formatRelativeTimestamp(null, NOW)).toBeNull();
    expect(formatRelativeTimestamp(undefined, NOW)).toBeNull();
    expect(formatRelativeTimestamp('not-a-date', NOW)).toBeNull();
  });
});
