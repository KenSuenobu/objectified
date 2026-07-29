/**
 * ConversionEvidenceDrawer (CPDO-3.2, #4802) — the conversion evidence drawer.
 *
 * Covers the acceptance criteria on the component itself:
 *  1. **Complete evidence** — a drop/inference row shows status, scope, reason category +
 *     code, the manifest detail, the linked fidelity finding, canonical object, source
 *     path/range (structured locations only), the OpenAPI JSON Pointer, evidence
 *     references, remediation, and tool-version + snapshot provenance.
 *  2. **Redaction** — the server's `[redacted]` placeholder passes through untouched, and
 *     the drawer renders only the paths/ranges the wire carries — never raw source content.
 *  3. **Safe defaults** — the form appears only for default-fixable rows, pre-fills from
 *     the applied defaults, hands the merged defaults up on Apply, and discards the draft
 *     on Cancel; while the owner recomputes, the form waits.
 *  4. **Aggregates and close** — an aggregate explains itself; the close affordance only
 *     clears the selection.
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest } from '@jest/globals';

import { ConversionEvidenceDrawer } from '../src/app/components/ade/dashboard/catalog/ConversionEvidenceDrawer';
import {
  buildConversionProjectionRows,
  buildConversionProjectionView,
} from '../src/app/components/ade/dashboard/catalog/conversionProjectionGraph';
import type {
  ConversionManifestSummary,
  ConversionProjectionEdge,
  ConversionProjectionNode,
} from '../src/app/utils/conversion-projection';
import type { FidelityReport } from '../src/app/utils/conversion-fidelity';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUMMARY = {
  schema_version: '1.0.0',
  manifest_hash: 'c0ffee'.padEnd(64, '0'),
  source: {
    project_id: 'p1',
    version_record_id: 'v1',
    source_format: 'graphql',
    source_protocol: null,
    source_version_label: null,
    paradigm: 'graphql',
    analysis: {
      available: true,
      status: 'available',
      status_reason: null,
      analyzer_key: 'graphql',
      analyzer_version: '1',
      node_count: 4,
      truncated: false,
      unsupported_constructs: [],
    },
  },
  target_format: 'openapi-3.1',
  conversion_mode: 'lossy',
  tool_versions: { emitter: '3.1.4', converter: '2.0' },
  defaults: {},
  status_counts: {},
  reason_counts: {},
  scope_counts: {},
  node_count: 2,
  edge_count: 1,
  total_constructs: 1,
  is_lossless: false,
  worst_severity: 'warn',
  truncated: false,
  dropped_edge_count: 0,
} as unknown as ConversionManifestSummary;

const REPORT: FidelityReport = {
  score: 55,
  grade: 'D',
  tier: 'low',
  penalty: 45,
  coverage_counts: {},
  items: [
    {
      key: 'info.version',
      title: 'API version',
      coverage: 'missing',
      weight: 3,
      count: 1,
      examples: ['/info/version'],
      reason: 'source declares no API version; a placeholder was emitted',
    },
  ],
  losses: [],
};

/** Build the single view entry for one edge + its nodes. */
function entryFor(nodes: ConversionProjectionNode[], edges: ConversionProjectionEdge[]) {
  const rows = buildConversionProjectionRows(nodes, edges);
  const view = buildConversionProjectionView(rows);
  expect(view.entries).toHaveLength(1);
  return view.entries[0];
}

function versionGapEntry(
  overrides: {
    sourceLocation?: string | null;
    nativeName?: string | null;
    evidence?: ConversionProjectionEdge['evidence'];
  } = {},
) {
  const nodes: ConversionProjectionNode[] = [
    {
      id: 'source:checklist:info.version',
      kind: 'source',
      label: 'API version',
      construct_key: 'info.version',
      source: {
        native_id: null,
        native_name: overrides.nativeName ?? 'API version',
        source_location: overrides.sourceLocation ?? 'document header',
        construct_kind: 'checklist',
      },
      target: null,
    },
    {
      id: 'target:/info/version',
      kind: 'target',
      label: '/info/version',
      construct_key: null,
      source: null,
      target: { json_pointer: '/info/version', native_path: null },
    },
  ];
  const edges: ConversionProjectionEdge[] = [
    {
      id: 'checklist:info.version',
      scope: 'checklist',
      source: 'source:checklist:info.version',
      target: 'target:/info/version',
      status: 'unavailable',
      reason: 'source_incomplete',
      severity: 'warn',
      detail: 'the source never declared an API version',
      remediation: 'Supply a version default before converting.',
      evidence: overrides.evidence ?? [
        {
          kind: 'document-pointer',
          ref: '/info/version',
          location: {
            file: 'schema.graphql',
            line: 12,
            column: 3,
            offset: null,
            length: null,
            ordinal: null,
            path: null,
          },
        },
      ],
      count: 1,
    },
  ];
  return entryFor(nodes, edges);
}

// ---------------------------------------------------------------------------
// 1. Complete evidence
// ---------------------------------------------------------------------------

describe('ConversionEvidenceDrawer — evidence completeness', () => {
  it('shows status, scope, cause, finding, locations, pointers, references, remediation, provenance', () => {
    render(
      <ConversionEvidenceDrawer
        entry={versionGapEntry()}
        summary={SUMMARY}
        report={REPORT}
        onClose={() => {}}
      />,
    );
    const drawer = screen.getByTestId('conversion-projection-evidence');

    // Status (wire vocabulary), severity, and scope.
    expect(drawer).toHaveTextContent('Unavailable');
    expect(drawer).toHaveTextContent('warn');
    expect(drawer).toHaveTextContent('Checklist evidence');

    // Cause: category chip + exact code + the manifest's own sentence.
    expect(screen.getByTestId('conversion-projection-category')).toHaveTextContent(
      'Source incomplete',
    );
    expect(screen.getByTestId('conversion-projection-reason')).toHaveTextContent(
      'source_incomplete',
    );
    expect(drawer).toHaveTextContent('the source never declared an API version');

    // The linked fidelity finding — the report's verdict, not a second opinion.
    expect(screen.getByTestId('conversion-projection-finding')).toHaveTextContent(
      'API version — missing. source declares no API version; a placeholder was emitted',
    );

    // Canonical object, source path/range, and the OpenAPI JSON Pointer.
    expect(screen.getByTestId('conversion-projection-canonical')).toHaveTextContent(
      'info.version (checklist)',
    );
    expect(screen.getByTestId('conversion-projection-source')).toHaveTextContent(
      'document header',
    );
    expect(screen.getByTestId('conversion-projection-pointer')).toHaveTextContent(
      '/info/version',
    );

    // Evidence references carry their structured source range.
    expect(screen.getByTestId('conversion-projection-evidence-refs')).toHaveTextContent(
      'document-pointer: /info/version — schema.graphql · line 12, col 3',
    );

    // Remediation and provenance.
    expect(screen.getByTestId('conversion-projection-remediation')).toHaveTextContent(
      'Supply a version default before converting.',
    );
    expect(screen.getByTestId('conversion-projection-provenance')).toHaveTextContent(
      'Evidence produced by converter v2.0 · emitter v3.1.4 · snapshot c0ffee000000',
    );
  });

  it('degrades gracefully without a report, tool versions, or evidence references', () => {
    const entry = versionGapEntry({ evidence: [] });
    render(
      <ConversionEvidenceDrawer
        entry={entry}
        summary={{ ...SUMMARY, tool_versions: {} }}
        report={null}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('conversion-projection-finding')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conversion-projection-evidence-refs')).not.toBeInTheDocument();
    // The snapshot is still attributed even when no tool versions are declared.
    expect(screen.getByTestId('conversion-projection-provenance')).toHaveTextContent('snapshot');
  });
});

// ---------------------------------------------------------------------------
// 2. Redaction
// ---------------------------------------------------------------------------

describe('ConversionEvidenceDrawer — redaction policy', () => {
  it("passes the server's [redacted] placeholder through untouched", () => {
    const entry = versionGapEntry({
      nativeName: '[redacted]',
      sourceLocation: '[redacted]',
    });
    render(
      <ConversionEvidenceDrawer entry={entry} summary={SUMMARY} onClose={() => {}} />,
    );
    expect(screen.getByTestId('conversion-projection-source')).toHaveTextContent(
      '[redacted] ([redacted])',
    );
  });

  it('never renders hostile evidence text as markup', () => {
    const entry = versionGapEntry({
      sourceLocation: 'line 5 <img src=x onerror=alert(1)>',
    });
    const { container } = render(
      <ConversionEvidenceDrawer entry={entry} summary={SUMMARY} onClose={() => {}} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('conversion-projection-source')).toHaveTextContent('line 5');
  });
});

// ---------------------------------------------------------------------------
// 3. Safe defaults
// ---------------------------------------------------------------------------

describe('ConversionEvidenceDrawer — safe-default remediation', () => {
  it('pre-fills from the applied defaults and hands the merged defaults up on Apply', () => {
    const onApplyDefaults = jest.fn();
    render(
      <ConversionEvidenceDrawer
        entry={versionGapEntry()}
        summary={SUMMARY}
        report={REPORT}
        currentDefaults={{ title: 'Kept title' }}
        onClose={() => {}}
        onApplyDefaults={onApplyDefaults}
      />,
    );
    const form = screen.getByTestId('conversion-projection-safe-default');
    expect(form).toHaveTextContent('API version');
    const input = screen.getByTestId('conversion-projection-safe-default-input');
    expect(input).toHaveValue('');

    // Nothing typed yet — nothing to apply.
    const apply = screen.getByTestId('conversion-projection-safe-default-apply');
    expect(apply).toBeDisabled();

    fireEvent.change(input, { target: { value: ' 2.0.0 ' } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    // The unrelated applied default is kept; the approved one is merged in, trimmed.
    expect(onApplyDefaults).toHaveBeenCalledWith({ title: 'Kept title', version: '2.0.0' });
  });

  it('Cancel discards the draft without applying anything', () => {
    const onApplyDefaults = jest.fn();
    render(
      <ConversionEvidenceDrawer
        entry={versionGapEntry()}
        summary={SUMMARY}
        currentDefaults={{ version: '1.0.0' }}
        onClose={() => {}}
        onApplyDefaults={onApplyDefaults}
      />,
    );
    const input = screen.getByTestId('conversion-projection-safe-default-input');
    expect(input).toHaveValue('1.0.0');
    fireEvent.change(input, { target: { value: '9.9.9' } });
    fireEvent.click(screen.getByTestId('conversion-projection-safe-default-cancel'));
    expect(input).toHaveValue('1.0.0');
    expect(onApplyDefaults).not.toHaveBeenCalled();
  });

  it('waits while the owner recomputes', () => {
    render(
      <ConversionEvidenceDrawer
        entry={versionGapEntry()}
        summary={SUMMARY}
        recomputing
        onClose={() => {}}
        onApplyDefaults={() => {}}
      />,
    );
    expect(screen.getByTestId('conversion-projection-safe-default-input')).toBeDisabled();
    const apply = screen.getByTestId('conversion-projection-safe-default-apply');
    expect(apply).toBeDisabled();
    expect(apply).toHaveTextContent('Recomputing…');
  });

  it('offers no form without an approval callback or for non-fixable rows', () => {
    const { rerender } = render(
      <ConversionEvidenceDrawer entry={versionGapEntry()} summary={SUMMARY} onClose={() => {}} />,
    );
    expect(screen.queryByTestId('conversion-projection-safe-default')).not.toBeInTheDocument();

    // A loss with no default counterpart gets guidance only.
    const nodes: ConversionProjectionNode[] = [
      {
        id: 'source:loss:0',
        kind: 'source',
        label: 'graphql-subscription',
        construct_key: null,
        source: {
          native_id: null,
          native_name: 'graphql-subscription',
          source_location: null,
          construct_kind: 'loss',
        },
        target: null,
      },
    ];
    const edges: ConversionProjectionEdge[] = [
      {
        id: 'loss:0000:graphql-subscription',
        scope: 'loss',
        source: 'source:loss:0',
        target: null,
        status: 'dropped',
        reason: 'destination_unsupported',
        severity: 'critical',
        detail: 'subscriptions have no OpenAPI representation',
        remediation: 'Track subscription support separately.',
        evidence: [],
        count: 1,
      },
    ];
    rerender(
      <ConversionEvidenceDrawer
        entry={entryFor(nodes, edges)}
        summary={SUMMARY}
        onClose={() => {}}
        onApplyDefaults={() => {}}
      />,
    );
    expect(screen.queryByTestId('conversion-projection-safe-default')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversion-projection-remediation')).toHaveTextContent(
      'Track subscription support separately.',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Aggregates + close
// ---------------------------------------------------------------------------

describe('ConversionEvidenceDrawer — aggregates and close', () => {
  it('explains an aggregate and closes via the affordance', () => {
    const nodes: ConversionProjectionNode[] = [];
    const edges: ConversionProjectionEdge[] = [];
    for (let i = 0; i < 4; i += 1) {
      nodes.push({
        id: `source:construct:type:T${i}`,
        kind: 'source',
        label: `T${i}`,
        construct_key: null,
        source: null,
        target: null,
      });
      edges.push({
        id: `construct:type:type:T${i}`,
        scope: 'construct',
        source: `source:construct:type:T${i}`,
        target: null,
        status: 'retained',
        reason: null,
        severity: 'info',
        detail: 'carried onto the document',
        remediation: null,
        evidence: [],
        count: 1,
      });
    }
    const rows = buildConversionProjectionRows(nodes, edges);
    const view = buildConversionProjectionView(rows, 2);
    const aggregate = view.entries.find((entry) => entry.kind === 'aggregate');
    expect(aggregate).toBeDefined();

    const onClose = jest.fn();
    render(
      <ConversionEvidenceDrawer entry={aggregate!} summary={SUMMARY} onClose={onClose} />,
    );
    const drawer = screen.getByTestId('conversion-projection-evidence');
    expect(drawer).toHaveTextContent('4 constructs, aggregated');
    fireEvent.click(within(drawer).getByTestId('conversion-projection-evidence-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
