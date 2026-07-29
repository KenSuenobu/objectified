/**
 * Conversion projection graph — automated a11y suite (CPDO-3.1, #4801).
 *
 * Following the IXH-3.6 precedent (tests/import-preview-a11y.test.tsx), the deterministic
 * jsdom half of the section's a11y gate:
 *
 *  1. **axe clean** — the panel reports zero violations (WCAG 2.1 A/AA rules; contrast and
 *     the page-level `region` landmark rule need a real page and are exempted) in its
 *     loaded, selected, and aggregated states.
 *  2. **Keyboard contract** — exactly one Tab stop across the graph nodes (roving
 *     tabindex), and a drawn focus indicator when a node holds focus.
 *  3. **Text alternative** — the SVG graph is named by the synchronized table's caption
 *     (`aria-labelledby`), and graph/table aria labels are identical for the same entry.
 *  4. **Reduced motion** — no motion class renders without a `motion-safe:` guard.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ConversionProjectionGraphPanel } from '../src/app/components/ade/dashboard/catalog/ConversionProjectionGraphPanel';
import type {
  ConversionManifestSummary,
  ConversionProjectionEdge,
  ConversionProjectionNode,
} from '../src/app/utils/conversion-projection';

/** axe options: WCAG 2.1 A/AA; contrast and page-landmark rules need a real page. */
const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

const HASH = 'c'.repeat(64);

function sourceNode(id: string, label: string): ConversionProjectionNode {
  return {
    id,
    kind: 'source',
    label,
    construct_key: null,
    source: { native_id: null, native_name: null, source_location: null, construct_kind: null },
    target: null,
  };
}

function edge(
  id: string,
  source: string,
  status: ConversionProjectionEdge['status'],
): ConversionProjectionEdge {
  return {
    id,
    scope: 'construct',
    source,
    target: null,
    status,
    reason: status === 'retained' ? null : 'destination_unsupported',
    severity: 'info',
    detail: `${status} detail`,
    remediation: status === 'retained' ? null : 'Adjust the source.',
    evidence: [],
    count: 1,
  };
}

function fixture(count: number) {
  const nodes: ConversionProjectionNode[] = [];
  const edges: ConversionProjectionEdge[] = [];
  for (let i = 0; i < count; i += 1) {
    const status = i === 0 ? 'dropped' : 'retained';
    nodes.push(sourceNode(`source:construct:type:T${i}`, `T${i}`));
    edges.push(edge(`construct:type:type:T${i}`, `source:construct:type:T${i}`, status));
  }
  const statusCounts = { retained: count - 1, transformed: 0, inferred: 0, dropped: 1, unavailable: 0, 'not-applicable': 0 };
  const summary: ConversionManifestSummary = {
    schema_version: '1.0.0',
    manifest_hash: HASH,
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
        node_count: count,
        truncated: false,
        unsupported_constructs: [],
      },
    },
    target_format: 'openapi-3.1',
    conversion_mode: 'lossy',
    tool_versions: {},
    defaults: {},
    status_counts: statusCounts,
    reason_counts: {},
    scope_counts: {},
    node_count: count,
    edge_count: count,
    total_constructs: count,
    is_lossless: false,
    worst_severity: 'info',
    truncated: false,
    dropped_edge_count: 0,
  };
  return {
    success: true,
    itemId: 'item-1',
    versionRecordId: 'v1',
    target: 'openapi',
    summary,
    page: { manifest_hash: HASH, edges, nodes, next_cursor: null, total: count },
  };
}

function installFetch(payload: unknown) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

async function renderLoaded(count = 3, props: Record<string, unknown> = {}) {
  installFetch(fixture(count));
  const utils = render(
    <ConversionProjectionGraphPanel itemId="item-1" enabled {...props} />,
  );
  await waitFor(() =>
    expect(screen.getByTestId('conversion-projection-table')).toBeInTheDocument(),
  );
  return utils;
}

afterEach(() => jest.restoreAllMocks());

describe('conversion projection graph — axe', () => {
  it('is axe-clean when loaded', async () => {
    const { container } = await renderLoaded();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is axe-clean with a selection and an expanded aggregate', async () => {
    const { container } = await renderLoaded(6, { aggregationThreshold: 2 });
    fireEvent.click(screen.getByTestId('conversion-projection-node-construct:type:type:T0'));
    fireEvent.click(
      screen.getByTestId('conversion-projection-aggregate-toggle-target-retained'),
    );
    expect(screen.getByTestId('conversion-projection-evidence')).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('conversion projection graph — keyboard contract', () => {
  it('keeps exactly one Tab stop across the graph nodes and draws focus', async () => {
    await renderLoaded();
    const nodes = screen.getAllByTestId(/^conversion-projection-node-/);
    expect(nodes.filter((n) => n.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(nodes.filter((n) => n.getAttribute('tabindex') === '-1')).toHaveLength(nodes.length - 1);

    fireEvent.focus(nodes[0]);
    expect(screen.getByTestId('conversion-projection-focus-ring')).toBeInTheDocument();
  });

  it('names the SVG by the table caption and says the same thing in both surfaces', async () => {
    await renderLoaded();
    const svg = screen.getByTestId('conversion-projection-svg');
    const caption = document.getElementById(svg.getAttribute('aria-labelledby') ?? '');
    expect(caption?.tagName.toLowerCase()).toBe('caption');

    // Graph node and its table-row button carry identical accessible names.
    const node = screen.getByTestId('conversion-projection-node-construct:type:type:T0');
    const row = screen.getByTestId('conversion-projection-table-row-construct:type:type:T0');
    const rowButton = row.querySelector('button');
    expect(node.getAttribute('aria-label')).toBe(rowButton?.getAttribute('aria-label'));
  });
});

describe('conversion projection graph — reduced motion', () => {
  it('renders no motion class without a motion-safe: guard', async () => {
    const { container } = await renderLoaded(6, { aggregationThreshold: 2 });
    const offenders: string[] = [];
    container.querySelectorAll<HTMLElement>('*').forEach((el) => {
      for (const cls of Array.from(el.classList)) {
        const isMotion = /^animate-|^transition($|-)/.test(cls);
        if (isMotion) offenders.push(cls);
      }
    });
    expect(offenders).toEqual([]);
  });
});
