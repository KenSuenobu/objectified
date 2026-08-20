/**
 * Surface-provenance adapter and panel — FMT-1.7 (#5418).
 *
 * The acceptance criterion these hold: *where a manifest and a probe both exist for one
 * endpoint, the detail view must show which facts came from which.* The adapter tests pin the
 * two honesty rules — an unrecognised origin never reads as a source, and absence never reads
 * as agreement — and the render tests pin what a reader actually sees for each relationship.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  MCP_ORIGIN_LABEL,
  MCP_SURFACE_MATCH_TITLE,
  formatFactValue,
  groupSurfaceFacts,
  mcpSurfaceProvenanceFromPayload,
  shortFingerprint,
  type McpSurfaceFact,
} from '../src/app/components/ade/dashboard/mcp/mcpSurfaceProvenanceUi';
import {
  MCP_PROVENANCE_OBSERVED_ONLY_NOTE,
  MCP_PROVENANCE_TITLE,
  McpSurfaceProvenancePanel,
} from '../src/app/components/ade/dashboard/mcp/McpSurfaceProvenancePanel';

const ENDPOINT = '11111111-1111-4111-8111-111111111111';
const DECLARED_FP = 'aaaaaaaaaaaabbbbbbbbbbbbccccccccccccdddddddddddd';
const OBSERVED_FP = 'ffffffffffffeeeeeeeeeeeeddddddddddddcccccccccccc';

function fact(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'tool',
    key: 'search_tickets',
    label: 'search_tickets',
    kind_label: 'Tool',
    origin: 'both',
    origin_label: 'Declared and observed',
    agreement: 'agrees',
    declared: null,
    observed: null,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    endpoint_id: ENDPOINT,
    surface_match: 'divergent',
    declared_fingerprint: DECLARED_FP,
    observed_fingerprint: OBSERVED_FP,
    fingerprints_match: false,
    origin_counts: { observed: 1, declared: 1, both: 1 },
    conflict_count: 1,
    facts: [
      fact({
        scope: 'surface',
        key: 'serverInfo.version',
        label: 'Server version',
        kind_label: 'Server identity',
        agreement: 'conflicts',
        declared: '1.4.0',
        observed: '9.9.9',
      }),
      fact({ key: 'close_ticket', label: 'close_ticket', origin: 'declared', agreement: 'uncontested' }),
      fact({ key: 'escalate', label: 'escalate', origin: 'observed', agreement: 'uncontested' }),
    ],
    ...overrides,
  };
}

function mockFetch(status: number, body: unknown) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

describe('mcpSurfaceProvenanceFromPayload', () => {
  it('adapts a full report', () => {
    const report = mcpSurfaceProvenanceFromPayload(payload());
    expect(report.surfaceMatch).toBe('divergent');
    expect(report.declaredFingerprint).toBe(DECLARED_FP);
    expect(report.observedFingerprint).toBe(OBSERVED_FP);
    expect(report.fingerprintsMatch).toBe(false);
    expect(report.conflictCount).toBe(1);
    expect(report.facts).toHaveLength(3);
  });

  it('resolves an unrecognised origin to unrecorded rather than to a source', () => {
    const report = mcpSurfaceProvenanceFromPayload(
      payload({ facts: [fact({ origin: 'wishful-thinking' })] }),
    );
    expect(report.facts[0].origin).toBe('unrecorded');
  });

  it('resolves an unrecognised surface match to none rather than to agreement', () => {
    const report = mcpSurfaceProvenanceFromPayload(payload({ surface_match: 'probably-fine' }));
    expect(report.surfaceMatch).toBe('none');
  });

  it('returns the empty report for a missing or malformed payload', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      const report = mcpSurfaceProvenanceFromPayload(bad);
      expect(report.surfaceMatch).toBe('none');
      expect(report.facts).toEqual([]);
      expect(report.fingerprintsMatch).toBe(false);
    }
  });

  it('drops a fact with no key rather than rendering a nameless row', () => {
    const report = mcpSurfaceProvenanceFromPayload(payload({ facts: [fact({ key: '' }), fact()] }));
    expect(report.facts).toHaveLength(1);
  });

  it('never reports a negative or non-numeric count', () => {
    const report = mcpSurfaceProvenanceFromPayload(
      payload({ conflict_count: -3, origin_counts: { declared: 'many' } }),
    );
    expect(report.conflictCount).toBe(0);
    expect(report.originCounts.declared).toBe(0);
  });
});

describe('groupSurfaceFacts', () => {
  const facts = mcpSurfaceProvenanceFromPayload(payload()).facts;

  it('puts server identity before the capability kinds', () => {
    expect(groupSurfaceFacts(facts).map((group) => group.scope)).toEqual(['surface', 'tool']);
  });

  it('keeps a scope this build does not know rather than dropping it', () => {
    const extra: McpSurfaceFact = {
      scope: 'widget',
      key: 'w',
      label: 'w',
      kindLabel: 'Widget',
      origin: 'declared',
      agreement: 'uncontested',
      declared: null,
      observed: null,
    };
    const groups = groupSurfaceFacts([...facts, extra]);
    expect(groups.map((group) => group.scope)).toContain('widget');
    expect(groups[groups.length - 1].scope).toBe('widget');
  });
});

describe('value and fingerprint formatting', () => {
  it('renders an absent value as an em dash, never as null', () => {
    expect(formatFactValue(null)).toBe('—');
    expect(formatFactValue(undefined)).toBe('—');
  });

  it('pretty-prints a structured value and passes a string through', () => {
    expect(formatFactValue({ a: 1 })).toContain('"a": 1');
    expect(formatFactValue('1.4.0')).toBe('1.4.0');
  });

  it('shortens a fingerprint and never invents an absent one', () => {
    expect(shortFingerprint(DECLARED_FP)).toBe('aaaaaaaaaaaa…');
    expect(shortFingerprint(null)).toBe('—');
    expect(shortFingerprint('short')).toBe('short');
  });
});

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

describe('McpSurfaceProvenancePanel', () => {
  it('attributes each fact to its source and opens a conflict side by side', async () => {
    global.fetch = mockFetch(200, payload()) as unknown as typeof fetch;
    render(<McpSurfaceProvenancePanel endpointId={ENDPOINT} />);

    await waitFor(() => expect(screen.getByTestId('mcp-provenance-panel')).toBeInTheDocument());
    expect(screen.getByText(MCP_PROVENANCE_TITLE)).toBeInTheDocument();
    expect(screen.getByTestId('mcp-provenance-match')).toHaveTextContent(
      MCP_SURFACE_MATCH_TITLE.divergent,
    );

    const rows = screen.getAllByTestId('mcp-provenance-fact');
    const origins = rows.map((row) => row.getAttribute('data-origin'));
    expect(origins).toEqual(expect.arrayContaining(['both', 'declared', 'observed']));

    // The conflicting fact carries both values; nothing picks a winner.
    expect(screen.getByText('1.4.0')).toBeInTheDocument();
    expect(screen.getByText('9.9.9')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-provenance-conflict-count')).toHaveTextContent(
      '1 conflicting fact',
    );
  });

  it('shows both fingerprints so the reader can see they differ', async () => {
    global.fetch = mockFetch(200, payload()) as unknown as typeof fetch;
    render(<McpSurfaceProvenancePanel endpointId={ENDPOINT} />);

    await waitFor(() => expect(screen.getByTestId('mcp-provenance-panel')).toBeInTheDocument());
    expect(screen.getByTestId('mcp-provenance-declared-fingerprint')).toHaveTextContent(
      shortFingerprint(DECLARED_FP),
    );
    expect(screen.getByTestId('mcp-provenance-observed-fingerprint')).toHaveTextContent(
      shortFingerprint(OBSERVED_FP),
    );
  });

  it('does not draw a conflict comparison when the two sources agree', async () => {
    global.fetch = mockFetch(
      200,
      payload({
        surface_match: 'identical',
        fingerprints_match: true,
        conflict_count: 0,
        facts: [fact()],
      }),
    ) as unknown as typeof fetch;
    render(<McpSurfaceProvenancePanel endpointId={ENDPOINT} />);

    await waitFor(() => expect(screen.getByTestId('mcp-provenance-panel')).toBeInTheDocument());
    expect(screen.queryByTestId('mcp-provenance-conflict-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('mcp-provenance-fact')).toHaveAttribute('data-agreement', 'agrees');
    // The label appears on the fact's pill and again in the legend that explains it.
    expect(screen.getAllByText(MCP_ORIGIN_LABEL.both).length).toBeGreaterThanOrEqual(2);
  });

  it('says the surface has never been declared rather than implying agreement', async () => {
    global.fetch = mockFetch(
      200,
      payload({ surface_match: 'observed_only', declared_fingerprint: null }),
    ) as unknown as typeof fetch;
    render(<McpSurfaceProvenancePanel endpointId={ENDPOINT} />);

    await waitFor(() =>
      expect(screen.getByTestId('mcp-provenance-observed-only')).toBeInTheDocument(),
    );
    expect(screen.getByText(MCP_PROVENANCE_OBSERVED_ONLY_NOTE)).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-provenance-panel')).not.toBeInTheDocument();
  });

  it('draws nothing for an endpoint with neither source', async () => {
    global.fetch = mockFetch(200, payload({ surface_match: 'none', facts: [] })) as unknown as typeof fetch;
    const { container } = render(<McpSurfaceProvenancePanel endpointId={ENDPOINT} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('degrades to silence when the attribution is unavailable', async () => {
    global.fetch = mockFetch(500, { error: 'boom' }) as unknown as typeof fetch;
    const { container } = render(<McpSurfaceProvenancePanel endpointId={ENDPOINT} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('requests the attribution for the endpoint it was given', async () => {
    const fetchMock = mockFetch(200, payload());
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<McpSurfaceProvenancePanel endpointId={ENDPOINT} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/mcp/endpoints/${ENDPOINT}/surface-provenance`,
    );
  });
});
