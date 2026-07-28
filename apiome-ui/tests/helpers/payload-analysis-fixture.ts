/**
 * Shared payload-analysis fixtures (CPDO-2.1, #4797).
 *
 * One place for the analysis records the Format details suites read, so the derivation tests, the
 * component tests, the shell wiring test and the a11y scan all describe the *same* payloads. A
 * fixture that drifted between suites would let one of them keep passing against a shape the others
 * no longer produce.
 *
 * The two trees are deliberately different in the one way the tab's behaviour turns on:
 *
 *  - {@link X12_TREE} locates by envelope path and sibling ordinal (no line), so no node in it can
 *    open the line-addressed raw viewer — and it carries both a withheld element value and an
 *    observed-*empty* one, which must never be described the same way;
 *  - {@link COPYBOOK_TREE} locates by file and line, so its fields can.
 */

import type {
  AnalysisNode,
  AnalysisRecord,
  AnalysisSummary,
} from '../../src/app/utils/catalog-payload-analysis';
import type { FormatCapabilitySnapshot } from '../../src/app/components/ade/dashboard/catalog/formatCapabilityRegistry';

/** An X12 interchange: two functional groups, path-only locations, one withheld element value. */
export const X12_TREE: AnalysisNode[] = [
  {
    id: 'isa',
    kind: 'interchange',
    name: 'ISA',
    label: 'Interchange 000000101',
    attributes: { senderId: 'ACME', elementSeparator: '*' },
    location: { ordinal: 0, path: 'ISA' },
    children: [
      {
        id: 'gs-0',
        kind: 'functional_group',
        name: 'HC',
        label: 'Functional group HC (1)',
        location: { ordinal: 0, path: 'ISA/GS[0]' },
        children: [
          {
            id: 'st-0',
            kind: 'transaction_set',
            name: '837',
            label: 'Transaction set 837 (0001)',
            attributes: { setId: '837', controlNumber: '0001' },
            location: { ordinal: 0, path: 'ISA/GS[0]/ST[0]' },
            children: [
              {
                id: 'seg-nm1',
                kind: 'segment',
                name: 'NM1',
                attributes: { segmentId: 'NM1', elementCount: 2 },
                location: { ordinal: 4, path: 'ISA/GS[0]/ST[0]/NM1[4]' },
                children: [
                  {
                    id: 'el-nm101',
                    kind: 'element',
                    name: 'NM101',
                    attributes: { position: 'NM101' },
                    location: { ordinal: 0, path: 'ISA/GS[0]/ST[0]/NM1[4]/NM101' },
                    valuePresent: true,
                    valueLength: 20,
                    redacted: true,
                  },
                  {
                    id: 'el-nm102',
                    kind: 'element',
                    name: 'NM102',
                    location: { ordinal: 1, path: 'ISA/GS[0]/ST[0]/NM1[4]/NM102' },
                    valuePresent: true,
                    valueLength: 0,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'gs-1',
        kind: 'functional_group',
        name: 'FA',
        label: 'Functional group FA (2)',
        location: { ordinal: 1, path: 'ISA/GS[1]' },
      },
    ],
  },
];

/** Nodes in {@link X12_TREE} — the number the pane's metrics and row counts are asserted against. */
export const X12_NODE_COUNT = 7;

/** A copybook layout: line-addressed locations, so the raw viewer *can* be opened at a field. */
export const COPYBOOK_TREE: AnalysisNode[] = [
  {
    id: 'rec-claim',
    kind: 'record',
    name: 'CLAIM-RECORD',
    attributes: { level: 1 },
    location: { file: 'claim.cpy', line: 1, path: 'CLAIM-RECORD' },
    children: [
      {
        id: 'fld-amount',
        kind: 'field',
        name: 'CLAIM-AMOUNT',
        attributes: { level: 5, picture: 'S9(7)V99', usage: 'COMP-3' },
        location: { file: 'claim.cpy', line: 12, path: 'CLAIM-RECORD/CLAIM-AMOUNT' },
        valuePresent: false,
      },
    ],
  },
];

/**
 * An `available` X12 analysis stored under the default `structural` value-visibility policy.
 *
 * @param overrides Fields to replace on the document (status, metrics, warnings, …).
 */
export function x12Record(overrides: Partial<AnalysisRecord['analysis']> = {}): AnalysisRecord {
  return {
    analysisId: 'an-1',
    analysisSequence: 1,
    versionRecordId: 'ver-1',
    contentFingerprint: 'f'.repeat(64),
    analyzedAt: '2026-07-01T00:00:00Z',
    analysis: {
      schemaVersion: '1.1.0',
      status: 'available',
      statusReason: null,
      sourceFormat: 'edix12',
      sourceHash: `sha256:${'a'.repeat(64)}`,
      analyzer: { key: 'edix12', version: '1.0.0', toolVersions: { pyx12: '4.0.1' } },
      capabilities: {
        supported: ['x12.functional_group'],
        unsupported: ['x12.hl_hierarchy'],
        limits: {},
      },
      tree: X12_TREE,
      metrics: {
        nodeCount: X12_NODE_COUNT,
        maxDepth: 5,
        truncated: false,
        droppedNodeCount: 0,
        kindCounts: {
          interchange: 1,
          functional_group: 2,
          transaction_set: 1,
          segment: 1,
          element: 2,
        },
        warningCount: 0,
      },
      warnings: [],
      redaction: {
        valueVisibility: 'structural',
        redactedNodeCount: 1,
        policySource: 'default',
        valuePreviewLimit: 120,
      },
      ...overrides,
    },
  };
}

/** An `available`, unbounded, warning-free copybook analysis. */
export function copybookRecord(overrides: Partial<AnalysisRecord['analysis']> = {}): AnalysisRecord {
  return {
    analysisId: 'an-2',
    analysisSequence: 1,
    analyzedAt: '2026-07-01T00:00:00Z',
    analysis: {
      schemaVersion: '1.1.0',
      status: 'available',
      statusReason: null,
      sourceFormat: 'cobolcopybook',
      sourceHash: `sha256:${'b'.repeat(64)}`,
      analyzer: { key: 'cobolcopybook', version: '1.0.0', toolVersions: {} },
      capabilities: { supported: ['copybook.occurs'], unsupported: ['copybook.redefines'], limits: {} },
      tree: COPYBOOK_TREE,
      metrics: {
        nodeCount: 2,
        maxDepth: 2,
        truncated: false,
        droppedNodeCount: 0,
        kindCounts: { record: 1, field: 1 },
        warningCount: 0,
      },
      warnings: [],
      redaction: {
        valueVisibility: 'none',
        redactedNodeCount: 0,
        policySource: 'format',
        valuePreviewLimit: 120,
      },
      ...overrides,
    },
  };
}

/**
 * The same copybook analysis as {@link copybookRecord}, but `partial` because the analyzer's node
 * budget bounded it — with one record-scoped error (REDEFINES is not parsed) and one node-scoped
 * warning, so the two warning surfaces can be told apart.
 */
export function boundedCopybookRecord(): AnalysisRecord {
  return copybookRecord({
    status: 'partial',
    statusReason: 'bounds_exceeded',
    metrics: {
      nodeCount: 2,
      maxDepth: 2,
      truncated: true,
      droppedNodeCount: 314,
      kindCounts: { record: 1, field: 1 },
      warningCount: 2,
    },
    warnings: [
      {
        code: 'copybook.redefines_unsupported',
        severity: 'error',
        message: 'REDEFINES is not parsed; the redefining field is not described.',
      },
      {
        code: 'copybook.odo_uncalculable',
        severity: 'warning',
        message: 'The OCCURS DEPENDING ON controller was not resolvable.',
        nodeId: 'fld-amount',
        location: { file: 'claim.cpy', line: 12 },
      },
    ],
  });
}

/**
 * An analysis wide enough to exceed the tree's windowing budget once its root is expanded.
 *
 * @param childCount Segments to hang off the single interchange root.
 */
export function wideRecord(childCount: number): AnalysisRecord {
  const record = x12Record();
  record.analysis.tree = [
    {
      id: 'isa',
      kind: 'interchange',
      name: 'ISA',
      label: 'Interchange wide',
      children: Array.from({ length: childCount }, (_, index) => ({
        id: `seg-${index}`,
        kind: 'segment',
        name: `SEG${index}`,
        location: { ordinal: index, path: `ISA/SEG[${index}]` },
      })),
    },
  ];
  record.analysis.metrics.nodeCount = childCount + 1;
  return record;
}

/** The tree-free summary the catalog detail read embeds for {@link x12Record}. */
export const AVAILABLE_SUMMARY: AnalysisSummary = {
  available: true,
  status: 'available',
  statusReason: null,
  schemaVersion: '1.1.0',
  sourceFormat: 'edix12',
  analyzerKey: 'edix12',
  analyzerVersion: '1.0.0',
  nodeCount: X12_NODE_COUNT,
  maxDepth: 5,
  truncated: false,
  warningCount: 0,
  kindCounts: { interchange: 1 },
  capabilities: { supported: [], unsupported: [], limits: {} },
  valueVisibility: 'structural',
  analysisId: 'an-1',
  versionRecordId: 'ver-1',
  analyzedAt: '2026-07-01T00:00:00Z',
};

/** The summary of a revision whose source material was never captured — no tree is fetchable. */
export const UNAVAILABLE_SUMMARY: AnalysisSummary = {
  ...AVAILABLE_SUMMARY,
  available: false,
  status: 'unavailable',
  statusReason: 'no_source_captured',
  nodeCount: 0,
  maxDepth: 0,
  kindCounts: {},
  analysisId: null,
};

/** A trustworthy CPDO-2.4 snapshot: one reviewed format plus the absences these suites resolve. */
export const REGISTRY_SNAPSHOT: FormatCapabilitySnapshot = {
  version: '1',
  review_date: '2026-07-28',
  analysis_schema_version: '1.1.0',
  absence_categories: [
    'source_missing',
    'not_analyzed',
    'format_unsupported',
    'parse_limit',
    'analyzer_failed',
    'value_redacted',
    'absent_in_source',
    'undeclared',
  ],
  absences: [
    {
      category: 'source_missing',
      category_label: 'Source not captured',
      summary_template:
        'No source material was captured, so there is nothing to analyse for {construct}.',
      remediation: 'Re-import the item so its source is captured.',
      source_missing: true,
    },
    {
      category: 'parse_limit',
      category_label: 'Parser limit',
      summary_template: 'apiome does not describe {construct}; the source may well contain it.',
      remediation: 'Read the original source to confirm.',
      source_missing: false,
    },
  ],
  reason_absence_categories: {
    not_analyzed: 'not_analyzed',
    no_source_captured: 'source_missing',
    unsupported_format: 'format_unsupported',
    bounds_exceeded: 'parse_limit',
    analyzer_failed: 'analyzer_failed',
  },
  formats: [
    {
      format: 'edix12',
      label: 'EDI X12',
      paradigm: 'data_schema',
      provenance: 'reviewed',
      availability: 'available',
      unavailable_reason: null,
      native_hierarchy: 'native',
      native_hierarchy_note: 'Interchange → functional group → transaction set → segment → element.',
      analyzer: { key: 'edix12', version: '1.0.0', tool_versions: { pyx12: '4.0.1' } },
      source_location: { quality: 'path_only', note: 'Envelope path and sibling ordinal only.' },
      value_visibility: {
        default: 'structural',
        maximum: 'full',
        note: 'Element values are observed; the default keeps presence and length.',
      },
      supported_constructs: ['x12.functional_group'],
      unsupported_constructs: ['x12.hl_hierarchy'],
      limits: { maxNodes: 5000, maxDepth: 32 },
      canonical_projection: {
        coverage: 'partial',
        dropped_constructs: ['x12.interchange_envelope'],
        note: 'Normalization reads the first functional group.',
      },
      conversion: {
        support: 'supported',
        canonical_formats: ['edix12'],
        normalizes_in_adapter: false,
        declared_formats: ['edi', 'x12'],
        note: 'Reaches the canonical model through edix12.',
      },
      notes: [],
      registry_version: '1',
      review_date: '2026-07-28',
    },
  ],
};
