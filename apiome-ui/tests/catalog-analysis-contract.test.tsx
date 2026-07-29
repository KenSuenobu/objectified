/**
 * Payload-analysis wire-contract tests over recorded backend output (CPDO-4.1, #4804).
 *
 * The CPDO-2.x suites run against hand-built trees in `helpers/payload-analysis-fixture.ts`,
 * whose docblock names the risk this file closes: a hand fixture that drifts from what the
 * Python extractors emit would let the UI keep passing against records the backend never
 * produces. Here the *recorded* analysis documents — the apiome-rest golden corpus output for
 * the multi-group X12 interchange and the REDEFINES copybook — drive the same derivation
 * utilities, panels, and axe scans:
 *
 * - the recorded vocabulary (statuses, severities, visibilities, node kinds) is fully known to
 *   the UI, and the recorded metrics recount from the recorded tree;
 * - the X12 derivations read both functional groups (what CPDO-2.2 exists to show) and the
 *   copybook derivations read the REDEFINES overlays from the recorded documents;
 * - the format-detail panel and both inspectors render the recorded documents with no axe
 *   violations (the a11y acceptance criterion, on real backend output);
 * - the shared hand fixture's vocabulary stays a subset of what the backend actually emits.
 *
 * Fixtures: `tests/fixtures/payloadAnalysisX12.json` / `payloadAnalysisCopybook.json` —
 * checked-in copies of the apiome-rest analysis goldens
 * `tests/golden/analysis/edi-x12/04-multi-group-po-ack.edi.json` and
 * `tests/golden/analysis/cobol-copybook/03-payment-redefines.cpy.json`. Regenerate together when
 * the contract changes: in apiome-rest run `pytest tests/test_analysis_golden.py
 * --update-golden`, then re-copy both files here.
 */

import * as React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

import { CatalogFormatDetailPanel } from '@/app/components/ade/dashboard/catalog/CatalogFormatDetailPanel';
import { CatalogX12InspectorPanel } from '@/app/components/ade/dashboard/catalog/CatalogX12InspectorPanel';
import { CatalogCopybookInspectorPanel } from '@/app/components/ade/dashboard/catalog/CatalogCopybookInspectorPanel';
import { resetFormatCapabilitiesCache } from '@/app/components/ade/dashboard/catalog/useFormatCapabilities';
import {
  countAnalysisNodes,
  isKnownAnalysisStatus,
  WARNING_SEVERITIES,
  VALUE_VISIBILITIES,
  type AnalysisDocument,
  type AnalysisNode,
  type AnalysisRecord,
  type AnalysisSummary,
} from '@/app/utils/catalog-payload-analysis';
import { x12Envelope, x12Groups } from '@/app/utils/catalog-x12-analysis';
import { copybookOverlays, copybookRecordSummary } from '@/app/utils/catalog-copybook-analysis';
import {
  COPYBOOK_TREE,
  REGISTRY_SNAPSHOT,
  X12_TREE,
  copybookRecord,
  x12Record,
} from './helpers/payload-analysis-fixture';

/** axe options: WCAG 2.1 A/AA; contrast and the page-landmark rule need a real page. */
const AXE_OPTIONS = {
  rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
} as const;

interface AnalysisGolden {
  snapshot_version: number;
  corpus_path: string;
  adapter: string;
  document: AnalysisDocument;
}

function loadGolden(name: string): AnalysisGolden {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf-8'));
}

const X12_GOLDEN = loadGolden('payloadAnalysisX12');
const COPYBOOK_GOLDEN = loadGolden('payloadAnalysisCopybook');

/** Wrap a recorded document as the record the `/analysis` endpoint serves. */
function recordedRecord(golden: AnalysisGolden): AnalysisRecord {
  return {
    analysisId: `recorded-${golden.adapter}`,
    versionRecordId: 'rev-corpus',
    analysisSequence: 1,
    contentFingerprint: null,
    analyzedAt: '2026-07-01T00:00:00Z',
    analysis: JSON.parse(JSON.stringify(golden.document)) as AnalysisDocument,
  };
}

/** The tree-free summary the catalog detail read would embed for a recorded document. */
function recordedSummary(golden: AnalysisGolden): AnalysisSummary {
  const { document } = golden;
  return {
    available: true,
    status: document.status,
    statusReason: document.statusReason ?? null,
    schemaVersion: document.schemaVersion,
    sourceFormat: document.sourceFormat ?? null,
    analyzerKey: document.analyzer.key,
    analyzerVersion: document.analyzer.version,
    nodeCount: document.metrics.nodeCount,
    maxDepth: document.metrics.maxDepth,
    truncated: document.metrics.truncated,
    warningCount: document.metrics.warningCount,
    kindCounts: document.metrics.kindCounts,
    capabilities: document.capabilities,
    valueVisibility: document.redaction.valueVisibility,
    analysisId: `recorded-${golden.adapter}`,
    versionRecordId: 'rev-corpus',
    analyzedAt: '2026-07-01T00:00:00Z',
  };
}

function walk(nodes: readonly AnalysisNode[]): AnalysisNode[] {
  const out: AnalysisNode[] = [];
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.shift() as AnalysisNode;
    out.push(node);
    stack.unshift(...(node.children ?? []));
  }
  return out;
}

const originalFetch = global.fetch;

function mockTransport(record: AnalysisRecord) {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/format-capabilities')) {
      return { ok: true, status: 200, json: async () => ({ success: true, ...REGISTRY_SNAPSHOT }) };
    }
    if (url.includes('/analysis')) {
      return { ok: true, status: 200, json: async () => ({ success: true, record }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetFormatCapabilitiesCache();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// ── The recorded vocabulary is fully known to the UI ─────────────────────────────────────────────

describe.each([
  ['X12', X12_GOLDEN],
  ['copybook', COPYBOOK_GOLDEN],
] as const)('recorded %s document', (_label, golden) => {
  it('uses only vocabulary the UI declares', () => {
    const { document } = golden;
    expect(isKnownAnalysisStatus(document.status)).toBe(true);
    expect(VALUE_VISIBILITIES).toContain(document.redaction.valueVisibility);
    for (const warning of document.warnings) {
      expect(WARNING_SEVERITIES).toContain(warning.severity);
    }
  });

  it('recounts to its own metrics', () => {
    const { document } = golden;
    expect(countAnalysisNodes(document.tree)).toBe(document.metrics.nodeCount);

    const kindTally: Record<string, number> = {};
    for (const node of walk(document.tree)) {
      kindTally[node.kind] = (kindTally[node.kind] ?? 0) + 1;
    }
    expect(kindTally).toEqual(document.metrics.kindCounts);
    expect(document.metrics.warningCount).toBe(document.warnings.length);
  });

  it('withholds observed values under the structural policy', () => {
    // Structural visibility samples lengths, never full values, unless the preview limit admits
    // them; either way `value` and `valuePresent` must be coherent on every node.
    for (const node of walk(golden.document.tree)) {
      if (node.value != null) {
        expect(node.valuePresent).toBe(true);
      }
      if (node.valuePresent === false) {
        expect(node.value ?? null).toBeNull();
      }
    }
  });
});

// ── Format derivations over recorded trees ───────────────────────────────────────────────────────

describe('X12 derivations over the recorded multi-group interchange', () => {
  it('read the whole envelope: two functional groups, two transaction sets', () => {
    const envelope = x12Envelope(X12_GOLDEN.document.tree);
    expect(envelope).not.toBeNull();

    const groups = x12Groups(X12_GOLDEN.document.tree);
    expect(groups.map((group) => group.functionalId)).toEqual(['PO', 'FA']);
    const setIds = groups.flatMap((group) => group.transactions.map((set) => set.setId));
    expect(setIds).toEqual(['850', '997']);
    // The subset honesty flag: only the first group's first set fed the canonical conversion.
    const converted = groups.flatMap((group) => group.transactions.filter((set) => set.converted));
    expect(converted.map((set) => set.setId)).toEqual(['850']);
  });

  it('carry the canonical-subset warning the analysis exists to surface', () => {
    const codes = X12_GOLDEN.document.warnings.map((warning) => warning.code);
    expect(codes).toContain('x12.canonical_projection_subset');
  });
});

describe('copybook derivations over the recorded REDEFINES record', () => {
  it('read the storage overlays', () => {
    const overlays = copybookOverlays(COPYBOOK_GOLDEN.document.tree);
    expect(overlays).toHaveLength(1);
    expect(overlays[0].baseName).toBe('PAYMENT-DETAIL');
    expect(overlays[0].overlays.map((overlay) => overlay.name)).toEqual([
      'CARD-DETAIL',
      'BANK-DETAIL',
    ]);
  });

  it('summarise the record from recorded attributes', () => {
    const summary = copybookRecordSummary(COPYBOOK_GOLDEN.document.tree);
    expect(summary).not.toBeNull();
    expect(summary?.name).toBe('PAYMENT-RECORD');
  });
});

// ── Panels render recorded documents accessibly ──────────────────────────────────────────────────

describe('panels over recorded documents', () => {
  it('format-detail panel renders the recorded X12 record with no axe violations', async () => {
    mockTransport(recordedRecord(X12_GOLDEN));
    const { container } = render(
      <CatalogFormatDetailPanel
        itemId="cat-recorded"
        summary={recordedSummary(X12_GOLDEN)}
        sourceFormat="edix12"
        active
        sourceAvailable
        onViewSourceLine={jest.fn()}
        nodeHref={(nodeId) => `/ade/dashboard/catalog/cat-recorded?tab=format&node=${nodeId}`}
      />,
    );
    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('X12 inspector renders both recorded functional groups with no axe violations', async () => {
    const { container } = render(
      <CatalogX12InspectorPanel document={recordedRecord(X12_GOLDEN).analysis} sourceFormat="edix12" />,
    );
    expect(screen.getByTestId('catalog-x12-inspector')).toBeInTheDocument();
    expect(screen.getAllByTestId('x12-functional-group')).toHaveLength(2);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('copybook inspector renders the recorded overlays with no axe violations', async () => {
    const { container } = render(
      <CatalogCopybookInspectorPanel
        document={recordedRecord(COPYBOOK_GOLDEN).analysis}
        sourceFormat="cobolcopybook"
      />,
    );
    expect(screen.getByTestId('catalog-copybook-inspector')).toBeInTheDocument();
    expect(screen.getAllByTestId('copybook-redefines').length).toBeGreaterThan(0);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// ── The shared hand fixture stays inside the recorded vocabulary ─────────────────────────────────

describe('shared fixture drift guard', () => {
  it('hand-built X12 tree uses only node kinds the backend actually emits', () => {
    const recordedKinds = new Set(Object.keys(X12_GOLDEN.document.metrics.kindCounts));
    // Kinds the recorded interchange happens not to carry but the analyzer declares as
    // capabilities (composite/component/repetition live in the composite-claim golden).
    for (const extra of ['composite', 'component', 'repetition']) recordedKinds.add(extra);
    for (const node of walk(X12_TREE)) {
      expect(recordedKinds).toContain(node.kind);
    }
    for (const node of walk(x12Record().analysis.tree)) {
      expect(recordedKinds).toContain(node.kind);
    }
  });

  it('hand-built copybook tree uses only node kinds the backend actually emits', () => {
    const recordedKinds = new Set(Object.keys(COPYBOOK_GOLDEN.document.metrics.kindCounts));
    for (const node of walk(COPYBOOK_TREE)) {
      expect(recordedKinds).toContain(node.kind);
    }
    for (const node of walk(copybookRecord().analysis.tree)) {
      expect(recordedKinds).toContain(node.kind);
    }
  });

  it('hand-built records claim only statuses and visibilities the backend vocabulary has', () => {
    for (const record of [x12Record(), copybookRecord()]) {
      expect(isKnownAnalysisStatus(record.analysis.status)).toBe(true);
      expect(VALUE_VISIBILITIES).toContain(record.analysis.redaction.valueVisibility);
    }
  });
});
