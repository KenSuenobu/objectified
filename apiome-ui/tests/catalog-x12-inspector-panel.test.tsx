/**
 * Render tests for the EDI X12 inspector (CPDO-2.2, #4798) — both standalone and mounted inside
 * the CPDO-2.1 Format details pane.
 *
 * The ticket's acceptance criteria, in order, are what this file asserts:
 *
 *  1. a multi-group / multi-transaction interchange shows **all** observed structures;
 *  2. selecting a segment offers a jump that highlights the **raw source range** it was read from;
 *  3. a **repeated segment** and an **empty element** are each distinguishable from what they are
 *     not — a different repeat, and an absent or withheld value;
 *  4. the pane distinguishes what the interchange **observed** from what an implementation guide
 *     would have **validated**;
 *  5. business values stay behind the **value-visibility policy** — the inspector reads envelope
 *     structure and never an observed element value.
 */

import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { CatalogX12InspectorPanel } from '@/app/components/ade/dashboard/catalog/CatalogX12InspectorPanel';
import { CatalogFormatDetailPanel } from '@/app/components/ade/dashboard/catalog/CatalogFormatDetailPanel';
import { resetFormatCapabilitiesCache } from '@/app/components/ade/dashboard/catalog/useFormatCapabilities';
import type { AnalysisRecord } from '@/app/utils/catalog-payload-analysis';
import {
  AVAILABLE_SUMMARY,
  copybookRecord,
  REGISTRY_SNAPSHOT,
  X12_SCANNED_SOURCE,
  x12ScannedRecord,
} from './helpers/payload-analysis-fixture';

const ITEM_ID = 'cat-x12';

// ── Harness ───────────────────────────────────────────────────────────────────────────────────────

const originalFetch = global.fetch;
let onViewSourceLine: jest.Mock;

/** Route the two GETs the Format details pane makes. */
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

/** Render the inspector on its own, with no fetch involved. */
function renderInspector(
  overrides: Partial<React.ComponentProps<typeof CatalogX12InspectorPanel>> = {},
) {
  return render(
    <CatalogX12InspectorPanel document={x12ScannedRecord().analysis} {...overrides} />,
  );
}

/** Render the whole Format details pane and wait for the record to land. */
async function renderPane(record: AnalysisRecord = x12ScannedRecord()) {
  mockTransport(record);
  const utils = render(
    <CatalogFormatDetailPanel
      itemId={ITEM_ID}
      summary={{ ...AVAILABLE_SUMMARY, nodeCount: record.analysis.metrics.nodeCount }}
      sourceFormat="edix12"
      active
      sourceAvailable
      onViewSourceLine={onViewSourceLine}
      nodeHref={(nodeId) => `/ade/dashboard/catalog/${ITEM_ID}?tab=format&node=${nodeId}`}
    />,
  );
  await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
  return utils;
}

/** The tree row whose node id is `id`, or undefined when it is not mounted. */
function row(id: string): HTMLElement | undefined {
  return screen
    .queryAllByRole('treeitem')
    .find((element) => element.getAttribute('data-node-id') === id);
}

/**
 * Expand rows in order until `id` is mounted.
 *
 * The pane paints two levels (`defaultExpandedAnalysisIds`), so a segment sits under a transaction
 * set that starts collapsed — clicking a parent row both selects and expands it.
 */
async function expandTo(id: string, ...ancestors: string[]) {
  for (const ancestor of ancestors) {
    await waitFor(() => expect(row(ancestor)).toBeDefined());
    fireEvent.click(row(ancestor)!);
  }
  await waitFor(() => expect(row(id)).toBeDefined());
  return row(id)!;
}

beforeEach(() => {
  resetFormatCapabilitiesCache();
  onViewSourceLine = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// ── AC 1: every observed structure is shown ───────────────────────────────────────────────────────

describe('multi-group and multi-transaction interchanges', () => {
  it('shows every functional group the interchange carried, not just the converted one', () => {
    renderInspector();

    const groups = screen.getAllByTestId('x12-functional-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent('PO');
    expect(groups[1]).toHaveTextContent('FA');
  });

  it('shows every transaction set with the id, control number and version it declared', () => {
    renderInspector();

    const sets = screen.getAllByTestId('x12-transaction-set');
    expect(sets).toHaveLength(2);
    expect(sets[0]).toHaveTextContent('850');
    expect(sets[0]).toHaveTextContent('0001');
    expect(sets[1]).toHaveTextContent('997');
    expect(sets[1]).toHaveTextContent('0002');
    expect(screen.getAllByTestId('x12-functional-group')[0]).toHaveTextContent('version 004010');
  });

  it('flags exactly the one transaction set the conversion was derived from', () => {
    renderInspector();

    const converted = screen
      .getAllByTestId('x12-transaction-set')
      .filter((set) => set.getAttribute('data-converted') === 'true');
    expect(converted).toHaveLength(1);
    expect(converted[0]).toHaveTextContent('850');
    expect(screen.getByTestId('x12-converted-set')).toBeInTheDocument();
  });

  it('states in words that the conversion read a subset of the interchange', () => {
    renderInspector();

    const scope = screen.getByTestId('x12-conversion-scope');
    expect(scope).toHaveAttribute('data-subset', 'true');
    expect(scope).toHaveTextContent(/derived from transaction set 850 \(0001\) alone/i);
    expect(scope).toHaveTextContent(/described here and nowhere else/i);
  });

  it('says the conversion covers the whole interchange when it does', () => {
    const record = x12ScannedRecord();
    record.analysis.tree[0].children = [record.analysis.tree[0].children![0]];
    renderInspector({ document: record.analysis });

    const scope = screen.getByTestId('x12-conversion-scope');
    expect(scope).toHaveAttribute('data-subset', 'false');
    expect(scope).toHaveTextContent(/describes the whole interchange/i);
  });

  it('renders every group inside the Format details pane, not only in the tree', async () => {
    await renderPane();

    expect(screen.getByTestId('catalog-x12-inspector')).toBeInTheDocument();
    expect(screen.getAllByTestId('x12-functional-group')).toHaveLength(2);
  });

  it('reveals a transaction set in the structure tree when its link is followed', async () => {
    await renderPane();

    // Collapse everything, so the 997 is genuinely unreachable before the link is followed.
    fireEvent.click(screen.getByTestId('catalog-format-detail-collapse-all'));
    await waitFor(() => expect(row('st-1')).toBeUndefined());

    fireEvent.click(screen.getAllByTestId('x12-transaction-reveal')[1]);

    await waitFor(() => expect(row('st-1')).toBeDefined());
    expect(row('st-1')).toHaveAttribute('aria-selected', 'true');
  });
});

// ── AC 2: a segment highlights the raw source range it came from ──────────────────────────────────

describe('raw source ranges', () => {
  it('offers a range highlight for a segment that knows its bytes', async () => {
    await renderPane();

    fireEvent.click(await expandTo('seg-beg', 'st-0'));
    const jump = await screen.findByTestId('catalog-format-detail-view-source');
    expect(jump).toHaveTextContent(/highlight 27 characters in the source/i);

    fireEvent.click(jump);
    expect(onViewSourceLine).toHaveBeenCalledWith(
      4,
      null,
      { offset: expect.any(Number), length: 27, line: 4 },
      'Segment BEG',
    );

    // The offset it hands over must select that segment and nothing else.
    const [, , range] = onViewSourceLine.mock.calls[0];
    expect(X12_SCANNED_SOURCE.slice(range.offset, range.offset + range.length)).toBe(
      'BEG*00*NE*PO-0002**20260116',
    );
  });

  it('sends the two repeats of one segment to two different ranges', async () => {
    await renderPane();

    fireEvent.click(await expandTo('seg-po1-0', 'st-0'));
    fireEvent.click(await screen.findByTestId('catalog-format-detail-view-source'));
    fireEvent.click(row('seg-po1-1')!);
    fireEvent.click(await screen.findByTestId('catalog-format-detail-view-source'));

    const [firstRange, secondRange] = onViewSourceLine.mock.calls.map((call) => call[2]);
    expect(firstRange.offset).not.toBe(secondRange.offset);
    expect(X12_SCANNED_SOURCE.slice(firstRange.offset, firstRange.offset + firstRange.length)).toBe(
      'PO1*1*10*EA*4.99',
    );
    expect(
      X12_SCANNED_SOURCE.slice(secondRange.offset, secondRange.offset + secondRange.length),
    ).toBe('PO1*2*20*EA*9.99');
  });

  it('tells a construct with no recorded position that the viewer cannot be opened at it', async () => {
    await renderPane();

    // The scan positions *segments*; the elements under one locate by path and ordinal only.
    fireEvent.click(await expandTo('el-beg04', 'st-0', 'seg-beg'));

    const note = await screen.findByTestId('catalog-format-detail-no-source-jump');
    expect(note).toHaveTextContent(/structural path rather than by a position in the raw source/i);
  });

  it('offers no jump at all when the raw source was never captured', async () => {
    mockTransport(x12ScannedRecord());
    render(
      <CatalogFormatDetailPanel
        itemId={ITEM_ID}
        summary={AVAILABLE_SUMMARY}
        sourceFormat="edix12"
        active
        sourceAvailable={false}
        onViewSourceLine={onViewSourceLine}
        nodeHref={(nodeId) => `?node=${nodeId}`}
      />,
    );
    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());

    fireEvent.click(await expandTo('seg-beg', 'st-0'));
    const note = await screen.findByTestId('catalog-format-detail-no-source-jump');
    expect(note).toHaveTextContent(/not captured at import/i);
    expect(screen.queryByTestId('catalog-format-detail-view-source')).not.toBeInTheDocument();
  });
});

// ── AC 3: repeated segments and empty elements are distinguishable ────────────────────────────────

describe('repeated segments and empty elements', () => {
  it('names which repeat a segment is, in the tree row itself', async () => {
    await renderPane();
    await expandTo('seg-po1-0', 'st-0');

    expect(row('seg-po1-0')).toHaveTextContent('PO1 (1 of 2)');
    expect(row('seg-po1-1')).toHaveTextContent('PO1 (2 of 2)');
  });

  it('summarises which segments repeat, and how often, per transaction set', () => {
    renderInspector();

    const repeats = screen.getAllByTestId('x12-repeated-segment');
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toHaveTextContent('PO1');
    expect(repeats[0]).toHaveTextContent('×2');
  });

  it('badges an element the source wrote and left empty', async () => {
    await renderPane();

    await expandTo('el-beg04', 'st-0', 'seg-beg');

    const badge = within(row('el-beg04')!).getByTestId('catalog-format-detail-node-presence');
    expect(badge).toHaveAttribute('data-presence', 'empty');
    expect(badge).toHaveTextContent(/present, empty/i);
  });

  it('never describes a withheld value as an empty one', async () => {
    await renderPane();

    await expandTo('el-beg03', 'st-0', 'seg-beg');

    // The withheld element carries the redaction badge and no presence badge.
    expect(row('el-beg03')).toHaveTextContent(/redacted/i);
    expect(
      within(row('el-beg03')!).queryByTestId('catalog-format-detail-node-presence'),
    ).not.toBeInTheDocument();

    fireEvent.click(row('el-beg03')!);
    const evidence = await screen.findByTestId('catalog-format-detail-selected');
    expect(evidence).toHaveTextContent(/withheld by the value-visibility policy/i);
    expect(evidence).not.toHaveTextContent(/it was empty/i);
  });

  it('states the empty element’s own sentence in its evidence, with its reference designator', async () => {
    await renderPane();

    fireEvent.click(await expandTo('el-beg04', 'st-0', 'seg-beg'));

    const evidence = await screen.findByTestId('catalog-format-detail-selected');
    expect(evidence).toHaveTextContent(/A value was present in the source and it was empty/i);
    expect(screen.getByTestId('catalog-format-detail-selected-reference')).toHaveTextContent(
      'BEG04',
    );
    expect(screen.getByTestId('catalog-format-detail-selected-presence')).toHaveTextContent(
      /present, empty/i,
    );
  });
});

// ── AC 4: observed, not validated ─────────────────────────────────────────────────────────────────

describe('observed versus validated', () => {
  it('always states that nothing was checked against an implementation guide', () => {
    renderInspector();

    const statement = screen.getByTestId('x12-conformance-statement');
    expect(statement).toHaveTextContent(/what the interchange itself declared/i);
    expect(statement).toHaveTextContent(/no 4010 or 5010 implementation guide was consulted/i);
    expect(statement).toHaveTextContent(/ST03 implementation convention reference is recorded/i);
  });

  it('shows a declared control total beside the observed count, and flags a disagreement', () => {
    renderInspector();

    const mismatch = screen.getByTestId('x12-segment-total-mismatch');
    expect(mismatch).toHaveTextContent(/SE01 says 4/i);

    const totals = screen.getAllByTestId('x12-control-total');
    const agreeing = totals.filter((total) => total.getAttribute('data-mismatched') === 'false');
    expect(agreeing.length).toBeGreaterThan(0);
    expect(agreeing[0]).toHaveTextContent(/matches IEA01/i);
  });

  it('does not read a missing declaration as agreement', () => {
    const record = x12ScannedRecord();
    delete record.analysis.tree[0].attributes!.declaredFunctionalGroupCount;
    renderInspector({ document: record.analysis });

    const totals = screen.getAllByTestId('x12-control-total');
    expect(totals[0]).toHaveAttribute('data-mismatched', 'false');
    expect(totals[0]).toHaveTextContent(/IEA01 declared nothing readable/i);
    expect(totals[0]).not.toHaveTextContent(/matches IEA01/i);
  });

  it('spells out the usage indicator rather than printing the bare code', () => {
    renderInspector();
    expect(screen.getByTestId('x12-usage-indicator')).toHaveTextContent('Production (P)');
  });

  it('shows each declared delimiter with its code point', () => {
    renderInspector();

    const separators = screen.getByTestId('x12-separators');
    expect(separators).toHaveTextContent('U+002A');
    expect(separators).toHaveTextContent('U+007E');
    // A version that defines no repetition separator says so instead of leaving a blank.
    expect(screen.getByTestId('x12-separator-absent')).toHaveTextContent(
      /does not define a repetition separator/i,
    );
  });
});

// ── AC 5: business values stay behind the policy ──────────────────────────────────────────────────

describe('redaction', () => {
  it('renders no observed element value anywhere in the inspector', () => {
    const { container } = renderInspector();

    // The fixture is stored at `structural`, so the record carries no value at all — and the
    // inspector reads envelope structure, so it could not render one even if the record did.
    expect(container.textContent).not.toContain('PO-0002');
    expect(screen.queryByTestId('catalog-format-detail-node-value')).not.toBeInTheDocument();
  });

  it('reads only envelope structure, never a node’s value field', () => {
    const record = x12ScannedRecord();
    // A record stored at `full` puts observed values on the element nodes. The inspector describes
    // the envelope, so nothing it renders may change.
    const beg03 = record.analysis.tree[0].children![0].children![0].children![0].children![0];
    beg03.value = 'PO-0002';
    beg03.redacted = false;
    record.analysis.redaction = {
      valueVisibility: 'full',
      redactedNodeCount: 0,
      policySource: 'request',
      valuePreviewLimit: 120,
    };

    const { container } = renderInspector({ document: record.analysis });
    expect(container.textContent).not.toContain('PO-0002');
  });
});

// ── Applicability and absence ─────────────────────────────────────────────────────────────────────

describe('when the inspector does not apply', () => {
  it('renders nothing for a record from another analyzer', () => {
    const { container } = renderInspector({ document: copybookRecord().analysis });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an X12 record carrying no interchange', () => {
    const record = x12ScannedRecord();
    record.analysis.tree = [];
    const { container } = renderInspector({ document: record.analysis });
    expect(container).toBeEmptyDOMElement();
  });

  it('is absent from the Format details pane for a copybook', async () => {
    await renderPane(copybookRecord());
    expect(screen.queryByTestId('catalog-x12-inspector')).not.toBeInTheDocument();
  });

  it('explains an interchange whose groups the node budget dropped', () => {
    const record = x12ScannedRecord();
    record.analysis.tree[0].children = [];
    renderInspector({ document: record.analysis });

    expect(screen.getByTestId('x12-no-groups')).toHaveTextContent(
      /keeps envelopes before leaves/i,
    );
  });

  it('explains a group whose transaction sets the node budget dropped', () => {
    const record = x12ScannedRecord();
    record.analysis.tree[0].children![0].children = [];
    renderInspector({ document: record.analysis });

    expect(screen.getAllByTestId('x12-group-no-transactions')[0]).toHaveTextContent(
      /bounds leaves before envelopes/i,
    );
  });
});
