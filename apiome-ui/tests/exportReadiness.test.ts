/**
 * exportReadiness — the pure half of the export pre-flight ranking (IXH-2.4, #5099).
 *
 * Covers the contract the target grid depends on: indexing a report by target key, the readiness
 * ordering (band first, then score, then key, with unranked cards kept at the end), the band badge
 * vocabulary, selectability — a policy-blocked target is *shown* but not choosable — and the
 * card title / source-quality strings.
 */

import {
  bandBadgeClass,
  bandLabel,
  cardTitle,
  isCardSelectable,
  orderTargetCards,
  readinessByTarget,
  sourceQualitySummary,
  type ExportPreflightReport,
  type ExportPreflightTarget,
} from '../src/app/components/ade/dashboard/export/exportReadiness';
import type { ExportTargetCard } from '../src/app/components/ade/dashboard/export/exportTargetCatalog';

function makeCard(key: string, available = true): ExportTargetCard {
  return {
    key,
    available,
    icon: (() => null) as unknown as ExportTargetCard['icon'],
    entry: {
      descriptor: {
        key,
        format: `${key}-1`,
        label: key.toUpperCase(),
        description: `Export as ${key}.`,
        icon: 'file-json',
        paradigm: 'rest',
        multi_file: false,
        needs_toolchain: false,
        available,
        unavailable_reason: available ? null : 'Requires the buf toolchain.',
      },
      capability_profile: { operations: true },
      options_schema: {},
      default_options: {},
      fidelity: {
        tier: 'lossless',
        preserved_percent: 100,
        total: 10,
        preserved: 10,
        dropped: 0,
        approximated: 0,
        synthesized: 0,
      },
    },
  };
}

function makeTarget(
  key: string,
  overrides: Partial<ExportPreflightTarget> = {},
): ExportPreflightTarget {
  return {
    rank: 1,
    key,
    format: `${key}-1`,
    readiness: 90,
    band: 'ready',
    blocked: false,
    selectable: true,
    rationale: `Carries this source without loss (100% preserved).`,
    fidelity: {
      tier: 'lossless',
      preserved_percent: 100,
      total: 10,
      preserved: 10,
      dropped: 0,
      approximated: 0,
      synthesized: 0,
    },
    capability: {
      verdict: 'full',
      required: ['operations'],
      supported: ['operations'],
      missing: [],
      synthesized: [],
      reason: 'carries everything',
    },
    policy: {
      verdict: 'pass',
      blocking: false,
      source: 'default',
      reason: 'No floor configured.',
      scope: 'export',
    },
    ...overrides,
  };
}

function makeReport(targets: ExportPreflightTarget[]): ExportPreflightReport {
  return {
    artifact: 'artifact-1',
    version_record_id: 'rev-1',
    version_label: '1.0.0',
    lint: { score: 82, grade: 'B' },
    style_guide: { guide_id: 'g1', name: 'Acme House Style', source: 'custom', fingerprint: 'fp' },
    capability_demand: ['operations'],
    targets,
    ranking_fingerprint: 'fp-rank',
  };
}

describe('readinessByTarget', () => {
  it('indexes ranked targets by their registry key', () => {
    const map = readinessByTarget(makeReport([makeTarget('openapi'), makeTarget('avro')]));
    expect(Object.keys(map).sort()).toEqual(['avro', 'openapi']);
  });

  it('returns an empty map for a missing report', () => {
    expect(readinessByTarget(null)).toEqual({});
    expect(readinessByTarget(undefined)).toEqual({});
  });
});

describe('orderTargetCards', () => {
  const cards = [makeCard('avro'), makeCard('graphql'), makeCard('openapi'), makeCard('proto')];

  it('leaves the registry order untouched when asked for it', () => {
    const readiness = readinessByTarget(
      makeReport([makeTarget('openapi', { readiness: 99 }), makeTarget('avro', { readiness: 20 })]),
    );
    expect(orderTargetCards(cards, readiness, 'registry').map((c) => c.key)).toEqual([
      'avro',
      'graphql',
      'openapi',
      'proto',
    ]);
  });

  it('sorts by band first, then by descending readiness', () => {
    const readiness = readinessByTarget(
      makeReport([
        makeTarget('avro', { band: 'caution', readiness: 55 }),
        makeTarget('graphql', { band: 'unavailable', readiness: 95 }),
        makeTarget('openapi', { band: 'ready', readiness: 88 }),
        makeTarget('proto', { band: 'blocked', readiness: 92 }),
      ]),
    );
    expect(orderTargetCards(cards, readiness, 'readiness').map((c) => c.key)).toEqual([
      'openapi',
      'avro',
      'proto',
      'graphql',
    ]);
  });

  it('breaks a tie on the target key so the order is total', () => {
    const readiness = readinessByTarget(
      makeReport([
        makeTarget('proto', { readiness: 70 }),
        makeTarget('avro', { readiness: 70 }),
        makeTarget('graphql', { readiness: 70 }),
        makeTarget('openapi', { readiness: 70 }),
      ]),
    );
    expect(orderTargetCards(cards, readiness, 'readiness').map((c) => c.key)).toEqual([
      'avro',
      'graphql',
      'openapi',
      'proto',
    ]);
  });

  it('keeps unranked cards at the end rather than dropping them', () => {
    const readiness = readinessByTarget(makeReport([makeTarget('openapi', { readiness: 91 })]));
    const ordered = orderTargetCards(cards, readiness, 'readiness').map((c) => c.key);
    expect(ordered[0]).toBe('openapi');
    expect(ordered.slice(1).sort()).toEqual(['avro', 'graphql', 'proto']);
  });

  it('does not mutate the input array', () => {
    const readiness = readinessByTarget(makeReport([makeTarget('proto', { readiness: 99 })]));
    const input = [...cards];
    orderTargetCards(input, readiness, 'readiness');
    expect(input.map((c) => c.key)).toEqual(['avro', 'graphql', 'openapi', 'proto']);
  });
});

describe('bandLabel / bandBadgeClass', () => {
  it('labels every band', () => {
    expect(bandLabel('ready')).toBe('ready');
    expect(bandLabel('caution')).toBe('check first');
    expect(bandLabel('blocked')).toBe('blocked');
    expect(bandLabel('unavailable')).toBe('unavailable');
  });

  it('uses the go / look / refused / cannot-run palette', () => {
    expect(bandBadgeClass('ready')).toContain('emerald');
    expect(bandBadgeClass('caution')).toContain('amber');
    expect(bandBadgeClass('blocked')).toContain('rose');
    expect(bandBadgeClass('unavailable')).toContain('gray');
  });
});

describe('isCardSelectable', () => {
  it('refuses a policy-blocked target', () => {
    const blocked = makeTarget('avro', { band: 'blocked', blocked: true, selectable: false });
    expect(isCardSelectable(makeCard('avro'), blocked)).toBe(false);
  });

  it('refuses a target the runtime cannot emit', () => {
    expect(isCardSelectable(makeCard('proto', false), makeTarget('proto'))).toBe(false);
  });

  it('allows an available target with no ranking yet', () => {
    expect(isCardSelectable(makeCard('openapi'), undefined)).toBe(true);
  });
});

describe('cardTitle', () => {
  it('prefers the runtime unavailability reason', () => {
    expect(cardTitle(makeCard('proto', false), makeTarget('proto'))).toBe(
      'Requires the buf toolchain.',
    );
  });

  it('uses the pre-flight rationale when the target is runnable', () => {
    const target = makeTarget('avro', { rationale: 'Blocked by the tenant export policy: D < B.' });
    expect(cardTitle(makeCard('avro'), target)).toBe(
      'Blocked by the tenant export policy: D < B.',
    );
  });

  it('falls back to the descriptor description without a ranking', () => {
    expect(cardTitle(makeCard('openapi'), undefined)).toBe('Export as openapi.');
  });
});

describe('sourceQualitySummary', () => {
  it('names the grade, the score, and the guide that produced them', () => {
    expect(sourceQualitySummary(makeReport([]))).toBe(
      'Source quality B (82/100) under Acme House Style.',
    );
  });

  it('is null when the source was not scored', () => {
    const report = { ...makeReport([]), lint: {} };
    expect(sourceQualitySummary(report)).toBeNull();
    expect(sourceQualitySummary(null)).toBeNull();
  });
});
