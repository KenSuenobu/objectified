/**
 * Unit tests for the pure catalog-analytics client helpers (V2-MCP-32.1 / MCAT-18.1; the stat
 * footnotes and the CSV export added in HIVE-7.9, #5326).
 *
 * Exercises `mcpCatalogInsightUi` in isolation (no React): the defensive parser (scalar tallies,
 * type counts, the grade map → sorted buckets, the composition breakdowns, and the malformed/empty
 * paths), the presentation projections (empty detection, percentages, grade tones, donut/bar
 * projections), and the CSV the Export action hands over.
 */
import {
  mcpCatalogBars,
  mcpCatalogDiscoveredFootnote,
  mcpCatalogDonutSegments,
  mcpCatalogGradeTone,
  mcpCatalogInsightCsv,
  mcpCatalogInsightFromPayload,
  mcpCatalogIsEmpty,
  mcpCatalogPercent,
  mcpCatalogPlural,
  mcpCatalogPublishedFootnote,
  mcpCatalogScoredFootnote,
  mcpCatalogUndiscoveredCount,
  mcpCatalogUnscoredCount,
} from '../src/app/components/ade/dashboard/mcp/mcpCatalogInsightUi';

function populatedPayload(extra: Record<string, unknown> = {}) {
  return {
    success: true,
    endpoint_count: 12,
    published_count: 7,
    public_count: 5,
    private_count: 7,
    discovered_count: 10,
    scored_count: 9,
    average_score: 78.4,
    type_counts: { tools: 84, resources: 22, resource_templates: 5, prompts: 8, total: 119 },
    grade_distribution: { B: 4, A: 3, D: 1, C: 1 },
    category_distribution: [
      { label: 'search', count: 4 },
      { label: 'Uncategorized', count: 2 },
    ],
    transport_distribution: [{ label: 'streamable_http', count: 8 }],
    protocol_version_distribution: [{ label: '2025-06-18', count: 6 }],
    tool_count_distribution: [
      { label: '0', count: 2 },
      { label: '1–5', count: 4 },
    ],
    discovery_health: [{ label: 'ok', count: 9 }],
    change_leaders: [{ endpoint_id: 'ep-1', name: 'Acme Search', change_count: 23 }],
    top_capabilities: [{ item_type: 'tool', item_name: 'search', endpoint_count: 6 }],
    ...extra,
  };
}

describe('mcpCatalogInsightFromPayload', () => {
  it('parses the full payload into the typed model', () => {
    const insight = mcpCatalogInsightFromPayload(populatedPayload())!;
    expect(insight).not.toBeNull();
    expect(insight.endpointCount).toBe(12);
    expect(insight.discoveredCount).toBe(10);
    expect(insight.averageScore).toBeCloseTo(78.4);
    expect(insight.typeCounts).toEqual({
      tools: 84,
      resources: 22,
      resourceTemplates: 5,
      prompts: 8,
      total: 119,
    });
    expect(insight.categoryDistribution).toEqual([
      { label: 'search', count: 4 },
      { label: 'Uncategorized', count: 2 },
    ]);
    expect(insight.changeLeaders[0]).toEqual({
      endpointId: 'ep-1',
      name: 'Acme Search',
      changeCount: 23,
    });
    expect(insight.topCapabilities[0]).toEqual({
      itemType: 'tool',
      itemName: 'search',
      endpointCount: 6,
    });
  });

  it('sorts the grade distribution ascending by grade', () => {
    const insight = mcpCatalogInsightFromPayload(populatedPayload())!;
    expect(insight.gradeDistribution).toEqual([
      { label: 'A', count: 3 },
      { label: 'B', count: 4 },
      { label: 'C', count: 1 },
      { label: 'D', count: 1 },
    ]);
  });

  it('parses an empty catalog into all-empty breakdowns with a null average', () => {
    const insight = mcpCatalogInsightFromPayload({
      success: true,
      endpoint_count: 0,
      published_count: 0,
      public_count: 0,
      private_count: 0,
      discovered_count: 0,
      scored_count: 0,
      average_score: null,
      type_counts: { tools: 0, resources: 0, resource_templates: 0, prompts: 0, total: 0 },
      grade_distribution: {},
    })!;
    expect(insight.endpointCount).toBe(0);
    expect(insight.averageScore).toBeNull();
    expect(insight.gradeDistribution).toEqual([]);
    expect(insight.categoryDistribution).toEqual([]);
    expect(insight.changeLeaders).toEqual([]);
    expect(insight.topCapabilities).toEqual([]);
    expect(mcpCatalogIsEmpty(insight)).toBe(true);
  });

  it('drops malformed breakdown/leader/capability entries defensively', () => {
    const insight = mcpCatalogInsightFromPayload(
      populatedPayload({
        category_distribution: [{ label: 'ok', count: 3 }, { count: 9 }, { label: '', count: 1 }],
        change_leaders: [{ name: 'no id', change_count: 4 }, { endpoint_id: 'e', name: 'kept', change_count: 1 }],
        top_capabilities: [{ item_type: 'tool', endpoint_count: 2 }, { item_name: 'kept', endpoint_count: 1 }],
      }),
    )!;
    expect(insight.categoryDistribution).toEqual([{ label: 'ok', count: 3 }]);
    expect(insight.changeLeaders).toEqual([{ endpointId: 'e', name: 'kept', changeCount: 1 }]);
    expect(insight.topCapabilities).toEqual([{ itemType: '', itemName: 'kept', endpointCount: 1 }]);
  });

  it('falls back to the endpoint id when a change leader has no name', () => {
    const insight = mcpCatalogInsightFromPayload(
      populatedPayload({ change_leaders: [{ endpoint_id: 'ep-x', change_count: 2 }] }),
    )!;
    expect(insight.changeLeaders[0]).toEqual({ endpointId: 'ep-x', name: 'ep-x', changeCount: 2 });
  });

  it('returns null for a malformed or error-envelope payload', () => {
    expect(mcpCatalogInsightFromPayload(null)).toBeNull();
    expect(mcpCatalogInsightFromPayload('nope')).toBeNull();
    expect(mcpCatalogInsightFromPayload({ success: false, error: 'boom' })).toBeNull();
  });
});

describe('presentation helpers', () => {
  it('computes whole-number percentages and never divides by zero', () => {
    expect(mcpCatalogPercent(3, 12)).toBe(25);
    expect(mcpCatalogPercent(1, 3)).toBe(33);
    expect(mcpCatalogPercent(5, 0)).toBe(0);
  });

  it('tones grades A/B green, C amber, and D-and-below red', () => {
    expect(mcpCatalogGradeTone('A')).toBe('emerald');
    expect(mcpCatalogGradeTone('b')).toBe('emerald');
    expect(mcpCatalogGradeTone('C')).toBe('amber');
    expect(mcpCatalogGradeTone('D')).toBe('red');
    expect(mcpCatalogGradeTone('F')).toBe('red');
  });

  it('projects buckets onto donut segments with stable categorical tones', () => {
    const segments = mcpCatalogDonutSegments([
      { label: 'a', count: 3 },
      { label: 'b', count: 1 },
    ]);
    expect(segments.map((s) => s.label)).toEqual(['a', 'b']);
    expect(segments.map((s) => s.value)).toEqual([3, 1]);
    // distinct, resolved tones (the exact palette order lives in chartTokens).
    expect(new Set(segments.map((s) => s.tone)).size).toBe(2);
  });

  it('honors a per-bucket tone override for the grade donut', () => {
    const segments = mcpCatalogDonutSegments(
      [{ label: 'A', count: 3 }, { label: 'D', count: 1 }],
      (bucket) => mcpCatalogGradeTone(bucket.label),
    );
    expect(segments.map((s) => s.tone)).toEqual(['emerald', 'red']);
  });

  it('projects buckets onto uniformly-toned bar data', () => {
    const bars = mcpCatalogBars([{ label: '0', count: 2 }], 'indigo');
    expect(bars).toEqual([{ label: '0', value: 2, tone: 'indigo' }]);
  });
});


// ---------------------------------------------------------------------------------------
// The stat footnotes (HIVE-7.9, #5326)
// ---------------------------------------------------------------------------------------

describe('the headline footnotes', () => {
  const insight = mcpCatalogInsightFromPayload(populatedPayload())!;

  it('derives the discovery and scoring gaps from the tallies beside them', () => {
    expect(mcpCatalogUndiscoveredCount(insight)).toBe(
      insight.endpointCount - insight.discoveredCount,
    );
    expect(mcpCatalogUnscoredCount(insight)).toBe(insight.endpointCount - insight.scoredCount);
  });

  it('never reports a negative gap, however the server counted', () => {
    // `discovered_count` can exceed `endpoint_count` mid-deletion; "-1 never discovered" is worse
    // than saying nothing.
    const skewed = mcpCatalogInsightFromPayload(
      populatedPayload({ endpoint_count: 2, discovered_count: 5, scored_count: 5 }),
    )!;
    expect(mcpCatalogUndiscoveredCount(skewed)).toBe(0);
    expect(mcpCatalogUnscoredCount(skewed)).toBe(0);
  });

  it('drops the gap footnote entirely rather than printing a zero', () => {
    const complete = mcpCatalogInsightFromPayload(
      populatedPayload({ discovered_count: 12, scored_count: 12, endpoint_count: 12 }),
    )!;
    expect(mcpCatalogDiscoveredFootnote(complete)).toBeNull();
    expect(mcpCatalogScoredFootnote(complete)).toBeNull();
  });

  it('prints the gap when there is one', () => {
    const partial = mcpCatalogInsightFromPayload(
      populatedPayload({ endpoint_count: 6, discovered_count: 5, scored_count: 4 }),
    )!;
    expect(mcpCatalogDiscoveredFootnote(partial)).toBe('1 never discovered');
    expect(mcpCatalogScoredFootnote(partial)).toBe('2 unscored');
  });

  it('renders the public/private split the payload always carried', () => {
    const split = mcpCatalogInsightFromPayload(
      populatedPayload({ public_count: 2, private_count: 4 }),
    )!;
    expect(mcpCatalogPublishedFootnote(split)).toBe('2 public · 4 private');
  });
});

describe('mcpCatalogPlural', () => {
  it('agrees with the count', () => {
    expect(mcpCatalogPlural(1, 'change')).toBe('1 change');
    expect(mcpCatalogPlural(0, 'change')).toBe('0 changes');
    expect(mcpCatalogPlural(11, 'change')).toBe('11 changes');
  });

  it('takes an explicit plural for the nouns English does not suffix', () => {
    expect(mcpCatalogPlural(65, 'capability', 'capabilities')).toBe('65 capabilities');
    expect(mcpCatalogPlural(1, 'capability', 'capabilities')).toBe('1 capability');
  });
});

// ---------------------------------------------------------------------------------------
// The CSV export
// ---------------------------------------------------------------------------------------

describe('mcpCatalogInsightCsv', () => {
  const insight = mcpCatalogInsightFromPayload(populatedPayload())!;
  const csv = mcpCatalogInsightCsv(insight);
  const lines = csv.trimEnd().split('\r\n');

  it('opens with the header row and terminates every line per RFC 4180', () => {
    expect(lines[0]).toBe('"Section","Label","Value"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('is long rather than wide, so eight differently-shaped blocks land in one sheet', () => {
    const sections = new Set(lines.slice(1).map((line) => line.split(',')[0]));
    expect(sections).toEqual(
      new Set([
        '"Totals"',
        '"Capabilities"',
        '"Category mix"',
        '"Transport mix"',
        '"Grade distribution"',
        '"Protocol version adoption"',
        '"Tool-count distribution"',
        '"Discovery health"',
        '"Change-frequency leaders"',
        '"Top capabilities"',
      ]),
    );
  });

  it('carries the same figures the tiles render', () => {
    expect(lines).toContain(`"Totals","Endpoints","${insight.endpointCount}"`);
    expect(lines).toContain(`"Totals","Public","${insight.publicCount}"`);
    expect(lines).toContain(`"Capabilities","Total","${insight.typeCounts.total}"`);
    for (const bucket of insight.categoryDistribution) {
      expect(lines).toContain(`"Category mix","${bucket.label}","${bucket.count}"`);
    }
  });

  it('states the average to one decimal, and leaves it blank when nothing is scored', () => {
    expect(lines).toContain(`"Totals","Average score","${insight.averageScore!.toFixed(1)}"`);
    const unscored = mcpCatalogInsightCsv(
      mcpCatalogInsightFromPayload(populatedPayload({ scored_count: 0, average_score: null }))!,
    );
    expect(unscored).toContain('"Totals","Average score",""');
  });

  it('quotes every field and doubles an embedded quote', () => {
    const quoted = mcpCatalogInsightCsv(
      mcpCatalogInsightFromPayload(
        populatedPayload({
          change_leaders: [{ endpoint_id: 'e1', name: 'The "Loud" server, mk2', change_count: 4 }],
        }),
      )!,
    );
    // A name with a comma and a quote in it must not become two columns.
    expect(quoted).toContain('"Change-frequency leaders","The ""Loud"" server, mk2","4"');
  });

  it('survives an empty catalog rather than emitting a header-only file with holes', () => {
    const empty = mcpCatalogInsightCsv(
      mcpCatalogInsightFromPayload({
        success: true,
        endpoint_count: 0,
        type_counts: {},
        grade_distribution: {},
      })!,
    );
    expect(empty.split('\r\n')[0]).toBe('"Section","Label","Value"');
    expect(empty).toContain('"Totals","Endpoints","0"');
  });
});
