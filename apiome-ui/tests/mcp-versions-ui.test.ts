/**
 * Unit tests for the MCP version-history & compare/diff presentation helpers
 * (V2-MCP-24.3 / MCAT-10.3, #3699).
 *
 * Exercises the pure adapter/format/selection functions the Versions tab relies on: defensive
 * payload parsing, newest-first ordering, change-row styling and before/after extraction, the
 * change-count summary tokens, and the two-slot selection + chronological (older→newer) ordering
 * that drives the compare.
 */

import {
  mcpChangeBeforeAfter,
  mcpChangeCountParts,
  mcpChangeCountsFromPayload,
  mcpChangeItemPath,
  mcpChangeKindLabel,
  mcpChangeStyle,
  mcpComparePairKey,
  mcpCompareHeader,
  mcpDiffSelectionForVersion,
  mcpOrderedPair,
  mcpToggleSelection,
  mcpVersionChangeCountParts,
  mcpVersionCompareFromPayload,
  mcpVersionDateTag,
  mcpVersionListFromPayload,
  mcpVersionSeqLabel,
  mcpVersionSummaryFromPayload,
  type McpVersionCompare,
  type McpVersionSummary,
} from '../src/app/components/ade/dashboard/mcp/mcpVersionsUi';

function makeVersion(overrides: Partial<McpVersionSummary> = {}): McpVersionSummary {
  return {
    id: overrides.id ?? 'v-1',
    endpoint_id: 'ep-1',
    version_seq: overrides.version_seq ?? 1,
    version_tag: overrides.version_tag ?? null,
    protocol_version: null,
    server_name: null,
    server_title: null,
    server_version: null,
    surface_fingerprint: overrides.surface_fingerprint ?? null,
    server_branding: overrides.server_branding ?? null,
    score: overrides.score ?? null,
    grade: overrides.grade ?? null,
    scored_at: null,
    change_counts: overrides.change_counts ?? { added: 0, removed: 0, modified: 0, total: 0 },
    is_current: overrides.is_current ?? false,
    discovery_trigger: overrides.discovery_trigger ?? null,
    discovery_job_id: overrides.discovery_job_id ?? null,
    discovered_at: overrides.discovered_at ?? null,
    created_at: overrides.created_at ?? null,
  };
}

describe('mcpChangeCountsFromPayload', () => {
  it('derives total from the three directions, ignoring a stale total', () => {
    expect(mcpChangeCountsFromPayload({ added: 2, removed: 1, modified: 3, total: 99 })).toEqual({
      added: 2,
      removed: 1,
      modified: 3,
      total: 6,
    });
  });

  it('defaults missing/invalid counts to zero', () => {
    expect(mcpChangeCountsFromPayload(undefined)).toEqual({ added: 0, removed: 0, modified: 0, total: 0 });
    expect(mcpChangeCountsFromPayload({ added: 'x' })).toEqual({ added: 0, removed: 0, modified: 0, total: 0 });
  });
});

describe('mcpVersionSummaryFromPayload', () => {
  it('parses a full row and coerces types defensively', () => {
    const summary = mcpVersionSummaryFromPayload({
      id: 'ver-7',
      endpoint_id: 'ep-1',
      version_seq: 7,
      version_tag: '2026-06-27 18:00',
      score: 88.9,
      grade: 'B',
      change_counts: { added: 1, removed: 0, modified: 2 },
      is_current: true,
      discovered_at: '2026-06-27T18:00:00Z',
    });
    expect(summary.id).toBe('ver-7');
    expect(summary.version_seq).toBe(7);
    expect(summary.version_tag).toBe('2026-06-27 18:00');
    expect(summary.score).toBe(88); // truncated
    expect(summary.is_current).toBe(true);
    expect(summary.change_counts).toEqual({ added: 1, removed: 0, modified: 2, total: 3 });
  });

  it('treats a non-boolean is_current as false and empty strings as null', () => {
    const summary = mcpVersionSummaryFromPayload({ id: 'x', version_seq: 0, version_tag: '', is_current: 'yes' });
    expect(summary.is_current).toBe(false);
    expect(summary.version_tag).toBeNull();
    expect(summary.score).toBeNull();
  });

  it('parses the snapshot provenance fields, defaulting an unrecorded origin to null (V2-MCP-34.5)', () => {
    const attributed = mcpVersionSummaryFromPayload({
      id: 'ver-7',
      version_seq: 7,
      discovery_trigger: 'sweep',
      discovery_job_id: 'job-1',
    });
    expect(attributed.discovery_trigger).toBe('sweep');
    expect(attributed.discovery_job_id).toBe('job-1');

    // A pre-provenance snapshot (or an empty string) stays null — unrecorded, never an origin.
    const unrecorded = mcpVersionSummaryFromPayload({ id: 'ver-1', version_seq: 1, discovery_trigger: '' });
    expect(unrecorded.discovery_trigger).toBeNull();
    expect(unrecorded.discovery_job_id).toBeNull();
  });
});

describe('mcpVersionListFromPayload', () => {
  it('parses and orders versions newest-first regardless of payload order', () => {
    const list = mcpVersionListFromPayload({
      versions: [
        { id: 'a', version_seq: 1 },
        { id: 'c', version_seq: 3 },
        { id: 'b', version_seq: 2 },
      ],
    });
    expect(list.map((v) => v.id)).toEqual(['c', 'b', 'a']);
  });

  it('returns an empty list for a malformed payload', () => {
    expect(mcpVersionListFromPayload(null)).toEqual([]);
    expect(mcpVersionListFromPayload({ versions: 'nope' })).toEqual([]);
  });
});

describe('mcpVersionSeqLabel / mcpVersionDateTag', () => {
  it('labels a version by its sequence', () => {
    expect(mcpVersionSeqLabel(5)).toBe('v5');
  });

  it('prefers the server tag, then a formatted timestamp, then the seq label', () => {
    expect(mcpVersionDateTag(makeVersion({ version_seq: 2, version_tag: 'release-2' }))).toBe('release-2');
    const fromTs = mcpVersionDateTag(makeVersion({ version_seq: 2, discovered_at: '2026-06-27T18:00:00Z' }));
    expect(fromTs).not.toBe('v2');
    expect(mcpVersionDateTag(makeVersion({ version_seq: 2, discovered_at: 'not-a-date' }))).toBe('v2');
    expect(mcpVersionDateTag(makeVersion({ version_seq: 2 }))).toBe('v2');
  });
});

describe('mcpVersionCompareFromPayload', () => {
  const payload = {
    success: true,
    base: { id: 'b', version_seq: 2, version_tag: null, surface_fingerprint: 'fp-b' },
    target: { id: 't', version_seq: 5, version_tag: null, surface_fingerprint: 'fp-t' },
    fingerprint_changed: true,
    counts: { added: 1, removed: 1, modified: 1 },
    changes: [
      { change_type: 'added', item_type: 'tool', item_name: 'search', detail: { after: { name: 'search' } } },
      { change_type: 'removed', item_type: 'prompt', item_name: 'greet', detail: { before: { name: 'greet' } } },
      {
        change_type: 'modified',
        item_type: 'tool',
        item_name: 'fetch',
        detail: {
          before: { description: 'old' },
          after: { description: 'new' },
          fields: [{ field: 'description', before: 'old', after: 'new' }],
        },
      },
    ],
  };

  it('parses base/target/counts/changes', () => {
    const compare = mcpVersionCompareFromPayload(payload);
    expect(compare).not.toBeNull();
    expect(compare?.base.id).toBe('b');
    expect(compare?.target.version_seq).toBe(5);
    expect(compare?.fingerprint_changed).toBe(true);
    expect(compare?.counts.total).toBe(3);
    expect(compare?.changes).toHaveLength(3);
    expect(compare?.changes[2].detail.fields).toEqual([{ field: 'description', before: 'old', after: 'new' }]);
  });

  it('returns null when base or target is missing', () => {
    expect(mcpVersionCompareFromPayload({ target: payload.target })).toBeNull();
    expect(mcpVersionCompareFromPayload({})).toBeNull();
  });
});

describe('mcpCompareHeader', () => {
  it('renders the older→newer header from the refs', () => {
    const compare = mcpVersionCompareFromPayload({
      base: { id: 'b', version_seq: 2 },
      target: { id: 't', version_seq: 5 },
      fingerprint_changed: true,
      counts: { added: 0, removed: 0, modified: 0 },
      changes: [],
    }) as McpVersionCompare;
    expect(mcpCompareHeader(compare)).toBe('v2 → v5');
  });
});

describe('mcpChangeCountParts', () => {
  it('always emits the three count tokens and appends fingerprint when changed', () => {
    const compare = mcpVersionCompareFromPayload({
      base: { id: 'b', version_seq: 1 },
      target: { id: 't', version_seq: 2 },
      fingerprint_changed: true,
      counts: { added: 2, removed: 0, modified: 1 },
      changes: [],
    }) as McpVersionCompare;
    const parts = mcpChangeCountParts(compare);
    expect(parts.map((p) => p.label)).toEqual(['+2 added', '−0 removed', '~1 modified', 'fingerprint changed']);
    expect(parts.map((p) => p.key)).toEqual(['added', 'removed', 'modified', 'fingerprint']);
  });

  it('omits the fingerprint token when the fingerprint did not change', () => {
    const compare = mcpVersionCompareFromPayload({
      base: { id: 'b', version_seq: 1 },
      target: { id: 't', version_seq: 1 },
      fingerprint_changed: false,
      counts: { added: 0, removed: 0, modified: 0 },
      changes: [],
    }) as McpVersionCompare;
    expect(mcpChangeCountParts(compare).map((p) => p.key)).toEqual(['added', 'removed', 'modified']);
  });
});

describe('mcpChangeStyle', () => {
  // Since HIVE-7.8 (#5325) the three kinds name a *tone* from `ui/statusVocabulary` rather than a
  // pair of palette classes, so the assertion is the tone rather than the hue: added is `ok`,
  // removed is the danger the vocabulary answers `breaking` with, and modified is `accent` — the
  // mockup's green / red / blue, following the reader's theme instead of one light palette.
  it('files added / removed / modified under the shared status tones', () => {
    expect(mcpChangeStyle('added').badgeVariant).toBe('success');
    expect(mcpChangeStyle('added').tone).toBe('ok');
    expect(mcpChangeStyle('removed').badgeVariant).toBe('error');
    expect(mcpChangeStyle('removed').tone).toBe('danger');
    expect(mcpChangeStyle('modified').badgeVariant).toBe('default');
    expect(mcpChangeStyle('modified').tone).toBe('accent');
  });

  it('marks a change row with a rule rather than tinting it', () => {
    // A diff of twelve tinted rows is a wall of colour; the tone lives on the kind badge and on
    // a 2px leading rule, which is what keeps the JSON under it legible.
    for (const kind of ['added', 'removed', 'modified'] as const) {
      const { rowClass } = mcpChangeStyle(kind);
      expect(rowClass).toContain('border-l-2');
      expect(rowClass).not.toMatch(/\bbg-/);
    }
  });

  it('falls back to neutral styling for an unknown direction', () => {
    const style = mcpChangeStyle('exploded');
    expect(style.label).toBe('Changed');
    expect(style.badgeVariant).toBe('secondary');
    expect(style.tone).toBe('neutral');
  });
});

describe('mcpVersionChangeCountParts', () => {
  it('prints the compact +N −N ~N triple, zeros included', () => {
    const parts = mcpVersionChangeCountParts({ added: 3, removed: 0, modified: 2, total: 5 });
    expect(parts.map((p) => p.label)).toEqual(['+3', '−0', '~2']);
  });

  it('takes the same three tones the compare header uses', () => {
    const counts = { added: 1, removed: 1, modified: 1, total: 3 };
    const compare = mcpVersionCompareFromPayload({
      base: { id: 'b', version_seq: 1 },
      target: { id: 't', version_seq: 2 },
      fingerprint_changed: false,
      counts,
      changes: [],
    }) as McpVersionCompare;
    const header = Object.fromEntries(mcpChangeCountParts(compare).map((p) => [p.key, p.colorClass]));
    for (const part of mcpVersionChangeCountParts(counts)) {
      expect(part.colorClass).toBe(header[part.key]);
    }
  });
});

describe('mcpChangeKindLabel / mcpChangeItemPath', () => {
  it('humanizes item kinds', () => {
    expect(mcpChangeKindLabel('tool')).toBe('Tool');
    expect(mcpChangeKindLabel('resource_template')).toBe('Resource template');
    expect(mcpChangeKindLabel('server')).toBe('Server');
    expect(mcpChangeKindLabel('weird')).toBe('weird');
  });

  it('builds a kind · name item path', () => {
    expect(
      mcpChangeItemPath({ change_type: 'added', item_type: 'tool', item_name: 'search', detail: {} }),
    ).toBe('Tool · search');
  });
});

describe('mcpChangeBeforeAfter', () => {
  it('returns only after for an addition', () => {
    const ba = mcpChangeBeforeAfter({
      change_type: 'added',
      item_type: 'tool',
      item_name: 'x',
      detail: { after: { a: 1 } },
    });
    expect(ba.before).toBeNull();
    expect(ba.after).toContain('"a": 1');
  });

  it('returns only before for a removal', () => {
    const ba = mcpChangeBeforeAfter({
      change_type: 'removed',
      item_type: 'tool',
      item_name: 'x',
      detail: { before: { a: 1 } },
    });
    expect(ba.before).toContain('"a": 1');
    expect(ba.after).toBeNull();
  });

  it('returns both for a modification', () => {
    const ba = mcpChangeBeforeAfter({
      change_type: 'modified',
      item_type: 'tool',
      item_name: 'x',
      detail: { before: { a: 1 }, after: { a: 2 } },
    });
    expect(ba.before).toContain('"a": 1');
    expect(ba.after).toContain('"a": 2');
  });
});

describe('mcpToggleSelection', () => {
  it('adds up to two ids and removes an already-selected id', () => {
    expect(mcpToggleSelection([], 'a')).toEqual(['a']);
    expect(mcpToggleSelection(['a'], 'b')).toEqual(['a', 'b']);
    expect(mcpToggleSelection(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('rolls selection forward when a third id is ticked', () => {
    expect(mcpToggleSelection(['a', 'b'], 'c')).toEqual(['b', 'c']);
  });
});

describe('mcpOrderedPair', () => {
  const v1 = makeVersion({ id: 'a', version_seq: 1 });
  const v2 = makeVersion({ id: 'b', version_seq: 2 });
  const v3 = makeVersion({ id: 'c', version_seq: 3 });
  const versions = [v3, v2, v1];

  it('returns null for an empty selection', () => {
    expect(mcpOrderedPair([], versions)).toBeNull();
  });

  it('returns the same version as base and target for a single pick', () => {
    expect(mcpOrderedPair(['b'], versions)).toEqual({ base: v2, target: v2 });
  });

  it('orders two picks older→newer regardless of pick order (auto-swap)', () => {
    expect(mcpOrderedPair(['c', 'a'], versions)).toEqual({ base: v1, target: v3 });
    expect(mcpOrderedPair(['a', 'c'], versions)).toEqual({ base: v1, target: v3 });
  });

  it('ignores ids that are not in the version list', () => {
    expect(mcpOrderedPair(['ghost', 'b'], versions)).toEqual({ base: v2, target: v2 });
  });
});

describe('mcpComparePairKey', () => {
  it('builds a stable base::target key', () => {
    expect(mcpComparePairKey('a', 'b')).toBe('a::b');
  });
});

describe('mcpDiffSelectionForVersion', () => {
  // Newest-first, as the version list is stored.
  const v3 = makeVersion({ id: 'c', version_seq: 3 });
  const v2 = makeVersion({ id: 'b', version_seq: 2 });
  const v1 = makeVersion({ id: 'a', version_seq: 1 });
  const versions = [v3, v2, v1];

  it('selects a version against its immediate predecessor', () => {
    // v2's churn is measured v1 → v2, so the diff opens on [v2, v1].
    expect(mcpDiffSelectionForVersion('b', versions)).toEqual(['b', 'a']);
    expect(mcpDiffSelectionForVersion('c', versions)).toEqual(['c', 'b']);
  });

  it('selects the first snapshot alone (no predecessor to diff against)', () => {
    expect(mcpDiffSelectionForVersion('a', versions)).toEqual(['a']);
  });

  it('returns an empty selection for an unknown version id', () => {
    expect(mcpDiffSelectionForVersion('ghost', versions)).toEqual([]);
  });

  it('handles a single-version history', () => {
    expect(mcpDiffSelectionForVersion('c', [v3])).toEqual(['c']);
  });
});
