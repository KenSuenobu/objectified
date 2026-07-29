/**
 * Render / interaction / accessibility tests for `<CatalogFormatDetailPanel>` (CPDO-2.1, #4797).
 *
 * The pane's job is to show an imported payload in its *own* vocabulary without ever claiming more
 * than the stored analysis says, so the assertions here are about behaviour and honesty:
 *
 * - **lazy**: nothing is fetched until the tab is selected, and an `unavailable` revision is
 *   explained from the embedded summary with no request at all;
 * - **declared states**: available / partial / unavailable / analyzer-failed each render distinctly,
 *   with the analyzer-warning and redacted facts overlaid in text (never colour alone);
 * - **ARIA tree**: `role="tree"`/`treeitem` with level, setsize, posinset, expanded and selected,
 *   full arrow/Home/End/Enter keyboard navigation, one Tab stop, and focus restoration — both
 *   across a filter change that removes the focused row and across the tab switch the pane itself
 *   initiates;
 * - **windowing**: above the documented budget only a window of rows mounts, the behaviour is
 *   stated, and the focused row is pinned so focus is never dropped;
 * - **authorization**: a 403 is rendered as a permission boundary, never as an absence of analysis,
 *   and the pane never links at raw source itself — the jump goes through the Source & Code tab's
 *   existing authorized proxy;
 * - **no invented affordances**: a node whose analyzer locates by structural path only is *told* it
 *   cannot open the line-addressed viewer, and a deep link into a node the analysis does not carry
 *   says so instead of selecting the nearest one.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { CatalogFormatDetailPanel } from '@/app/components/ade/dashboard/catalog/CatalogFormatDetailPanel';
import { resetFormatCapabilitiesCache } from '@/app/components/ade/dashboard/catalog/useFormatCapabilities';
import { ANALYSIS_TREE_VIRTUALIZE_ABOVE } from '@/app/utils/preview-budgets';
import type { AnalysisRecord } from '@/app/utils/catalog-payload-analysis';
import {
  AVAILABLE_SUMMARY,
  boundedCopybookRecord,
  REGISTRY_SNAPSHOT,
  UNAVAILABLE_SUMMARY,
  wideRecord,
  X12_NODE_COUNT,
  x12Record,
} from './helpers/payload-analysis-fixture';

const ITEM_ID = 'cat-1';

// ── Harness ───────────────────────────────────────────────────────────────────────────────────────

const originalFetch = global.fetch;
let fetchMock: jest.Mock;
let onViewSourceLine: jest.Mock;

/** Route the two GETs the pane makes; `analysis` may be a record or an HTTP failure. */
function mockTransport(analysis: AnalysisRecord | { status: number; error: string }) {
  fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/format-capabilities')) {
      return { ok: true, status: 200, json: async () => ({ success: true, ...REGISTRY_SNAPSHOT }) };
    }
    if (url.includes('/analysis-metrics')) {
      // The CPDO-4.2 latency report is fire-and-forget; acknowledge and ignore it.
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (url.includes('/analysis')) {
      if ('status' in analysis) {
        return {
          ok: false,
          status: analysis.status,
          json: async () => ({ success: false, error: analysis.error }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, record: analysis }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

function nodeHref(nodeId: string) {
  return `/ade/dashboard/catalog/${ITEM_ID}?tab=format&node=${nodeId}`;
}

type PanelOverrides = Partial<React.ComponentProps<typeof CatalogFormatDetailPanel>>;

function renderPanel(overrides: PanelOverrides = {}) {
  return render(
    <CatalogFormatDetailPanel
      itemId={ITEM_ID}
      summary={AVAILABLE_SUMMARY}
      sourceFormat="edix12"
      active
      sourceAvailable
      onViewSourceLine={onViewSourceLine}
      nodeHref={nodeHref}
      {...overrides}
    />,
  );
}

/** Await the record fetch settling by waiting for the tree the fixture carries. */
async function renderLoadedPanel(overrides: PanelOverrides = {}) {
  const utils = renderPanel(overrides);
  await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
  return utils;
}

/** The mounted tree rows, in DOM order. */
function rows(): HTMLElement[] {
  return screen.getAllByRole('treeitem');
}

/** The row whose node id is `id`, or undefined when it is not mounted. */
function row(id: string): HTMLElement | undefined {
  return rows().find((element) => element.getAttribute('data-node-id') === id);
}

beforeEach(() => {
  resetFormatCapabilitiesCache();
  onViewSourceLine = jest.fn();
  mockTransport(x12Record());
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// ── Lazy loading ──────────────────────────────────────────────────────────────────────────────────

describe('lazy loading', () => {
  it('fetches nothing until the tab is selected', async () => {
    const { rerender } = renderPanel({ active: false });

    // Not one request — neither the record nor the capability registry.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();

    rerender(
      <CatalogFormatDetailPanel
        itemId={ITEM_ID}
        summary={AVAILABLE_SUMMARY}
        sourceFormat="edix12"
        active
        sourceAvailable
        onViewSourceLine={onViewSourceLine}
        nodeHref={nodeHref}
      />,
    );

    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/analysis')),
    ).toHaveLength(1);
  });

  it('fetches the record once, however often the tab is re-selected', async () => {
    const { rerender } = await renderLoadedPanel();
    const props = {
      itemId: ITEM_ID,
      summary: AVAILABLE_SUMMARY,
      sourceFormat: 'edix12',
      sourceAvailable: true,
      onViewSourceLine,
      nodeHref,
    };
    rerender(<CatalogFormatDetailPanel {...props} active={false} />);
    rerender(<CatalogFormatDetailPanel {...props} active />);

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/analysis')),
    ).toHaveLength(1);
  });

  it('still loads the record when the reader leaves the tab while it is in flight', async () => {
    // The request is one-shot, so aborting it on deactivation would abort it for good.
    let settle: ((value: unknown) => void) | undefined;
    fetchMock = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/format-capabilities')) {
        return { ok: true, status: 200, json: async () => ({ success: true, ...REGISTRY_SNAPSHOT }) };
      }
      return new Promise((resolve) => {
        settle = resolve;
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const props = {
      itemId: ITEM_ID,
      summary: AVAILABLE_SUMMARY,
      sourceFormat: 'edix12',
      sourceAvailable: true,
      onViewSourceLine,
      nodeHref,
    };
    const { rerender } = render(<CatalogFormatDetailPanel {...props} active />);
    await screen.findByTestId('catalog-format-detail-loading');

    rerender(<CatalogFormatDetailPanel {...props} active={false} />);
    await act(async () => {
      settle!({ ok: true, status: 200, json: async () => ({ success: true, record: x12Record() }) });
    });
    rerender(<CatalogFormatDetailPanel {...props} active />);

    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/analysis')),
    ).toHaveLength(1);
  });

  it('explains an unavailable revision from the embedded summary, with no record request', async () => {
    renderPanel({ summary: UNAVAILABLE_SUMMARY });

    // The registry loads (it is what carries the reviewed wording); the record does not.
    await waitFor(() => expect(screen.getByTestId('catalog-format-detail-status')).toHaveTextContent('Unavailable'));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/analysis'))).toHaveLength(0);
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();

    // …and the absence is the reviewed one for `no_source_captured`, which is the single category
    // that may say the source itself is missing.
    await waitFor(() =>
      expect(screen.getByRole('note', { name: /why this detail is missing/i })).toHaveTextContent(
        /No source material was captured/i,
      ),
    );
  });
});

// ── Declared states ───────────────────────────────────────────────────────────────────────────────

describe('declared states', () => {
  it('renders an available analysis with its metrics and native construct counts', async () => {
    await renderLoadedPanel();

    expect(screen.getByTestId('catalog-format-detail-status')).toHaveTextContent('Available');
    const metrics = screen.getByTestId('catalog-format-detail-metrics');
    expect(metrics).toHaveTextContent('Nodes');
    expect(metrics).toHaveTextContent(String(X12_NODE_COUNT));
    expect(metrics).toHaveTextContent('structural');
    const kinds = screen.getByTestId('catalog-format-detail-kinds');
    expect(kinds).toHaveTextContent('Functional group');
    expect(kinds).toHaveTextContent('Transaction set');
    // An unbounded record states no bounding, and a warning-free one no warnings.
    expect(screen.queryByTestId('catalog-format-detail-truncated')).not.toBeInTheDocument();
    expect(screen.queryByTestId('catalog-format-detail-warning-state')).not.toBeInTheDocument();
  });

  it('states bounding on a partial record, and that the missing nodes are absent from the record', async () => {
    mockTransport(boundedCopybookRecord());
    await renderLoadedPanel({ sourceFormat: 'cobolcopybook', summary: { ...AVAILABLE_SUMMARY, sourceFormat: 'cobolcopybook' } });

    expect(screen.getByTestId('catalog-format-detail-status')).toHaveTextContent('Partial');
    expect(screen.getByTestId('catalog-format-detail-truncated')).toHaveTextContent('314 nodes dropped');
    const note = screen.getByTestId('catalog-format-detail-bounding-note');
    expect(note).toHaveTextContent(/absent from the\s+record, not from your source/i);
  });

  it('lists analyzer warnings worst-first, with their stable codes', async () => {
    mockTransport(boundedCopybookRecord());
    await renderLoadedPanel();

    expect(screen.getByTestId('catalog-format-detail-warning-state')).toHaveTextContent(
      '2 analyzer warnings',
    );
    const listed = screen.getAllByTestId('catalog-format-detail-warning');
    // Only the record-scoped warning is listed here; the node-scoped one rides on its row.
    expect(listed).toHaveLength(1);
    expect(listed[0]).toHaveTextContent('copybook.redefines_unsupported');
    expect(listed[0]).toHaveAttribute('data-severity', 'error');
    expect(listed[0]).toHaveTextContent('Error');
  });

  it('badges a node-scoped warning on its own row', async () => {
    mockTransport(boundedCopybookRecord());
    await renderLoadedPanel();

    const field = row('fld-amount')!;
    expect(within(field).getByTestId('catalog-format-detail-node-warning')).toHaveTextContent('Warning');
  });

  it('states the withheld-value count rather than leaving redaction implicit', async () => {
    await renderLoadedPanel();

    expect(screen.getByTestId('catalog-format-detail-redacted')).toHaveTextContent('1 value withheld');
  });

  it('renders an analyzer failure as a failure, not as an absence', async () => {
    renderPanel({
      summary: {
        ...UNAVAILABLE_SUMMARY,
        status: 'failed',
        statusReason: 'analyzer_failed',
        available: false,
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('catalog-format-detail-status')).toHaveTextContent('Analyzer failed'),
    );
    expect(screen.getByTestId('catalog-format-detail-statement')).toHaveTextContent(
      /ran and errored/i,
    );
  });
});

// ── Authorization ─────────────────────────────────────────────────────────────────────────────────

describe('authorization', () => {
  it('renders a 403 as a permission boundary, never as "there is no analysis"', async () => {
    mockTransport({ status: 403, error: 'Permission denied: imports:view' });
    renderPanel();

    const refusal = await screen.findByTestId('catalog-format-detail-forbidden');
    expect(refusal).toHaveTextContent('imports:view');
    expect(refusal).toHaveTextContent(/may well exist/i);
    expect(screen.queryByTestId('catalog-format-detail-error')).not.toBeInTheDocument();
  });

  it('claims nothing about the source when the read itself failed', async () => {
    mockTransport({ status: 500, error: 'upstream exploded' });
    renderPanel();

    const failure = await screen.findByTestId('catalog-format-detail-error');
    expect(failure).toHaveTextContent('upstream exploded');
    expect(failure).toHaveTextContent(/Nothing is claimed about the source/i);
  });

  it('never links at raw source itself — the jump goes through the Source & Code tab', async () => {
    await renderLoadedPanel();

    for (const anchor of screen.queryAllByRole('link')) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(/\/api\/catalog\//);
    }
  });
});

// ── The tree ──────────────────────────────────────────────────────────────────────────────────────

describe('ARIA tree semantics', () => {
  it('exposes a labelled, described tree of treeitems carrying level/setsize/posinset', async () => {
    await renderLoadedPanel();

    const tree = screen.getByRole('tree');
    expect(tree).toHaveAccessibleName('Native payload structure');
    expect(tree).toHaveAccessibleDescription(/arrow keys/i);

    const isa = row('isa')!;
    expect(isa).toHaveAttribute('aria-level', '1');
    expect(isa).toHaveAttribute('aria-setsize', '1');
    expect(isa).toHaveAttribute('aria-posinset', '1');
    expect(isa).toHaveAttribute('aria-expanded', 'true');

    const group = row('gs-0')!;
    expect(group).toHaveAttribute('aria-level', '2');
    expect(group).toHaveAttribute('aria-setsize', '2');
    expect(group).toHaveAttribute('aria-posinset', '1');
    // The second group is a leaf in this fixture, so it carries no aria-expanded at all.
    expect(row('gs-1')!).not.toHaveAttribute('aria-expanded');
  });

  it('keeps exactly one Tab stop in the tree (roving tabindex)', async () => {
    await renderLoadedPanel();

    expect(rows().filter((element) => element.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('progressively expands: children mount only once their parent is expanded', async () => {
    await renderLoadedPanel();

    // First paint opens the roots and their branching children, so the transaction set is mounted
    // but the segments under it — the bulk of any real interchange — are not.
    expect(row('st-0')).toBeDefined();
    expect(row('seg-nm1')).toBeUndefined();
    expect(row('st-0')!).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(row('st-0')!);
    await waitFor(() => expect(row('seg-nm1')).toBeDefined());
    expect(row('st-0')!).toHaveAttribute('aria-expanded', 'true');

    // Clicking again collapses it, so nothing below it stays mounted.
    fireEvent.click(row('st-0')!);
    await waitFor(() => expect(row('seg-nm1')).toBeUndefined());
  });

  it('navigates with ArrowDown/ArrowUp/Home/End and selects with Enter', async () => {
    await renderLoadedPanel();
    const tree = screen.getByRole('tree');

    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    await waitFor(() => expect(row('gs-0')!).toHaveAttribute('aria-selected', 'true'));
    expect(row('gs-0')!).toHaveFocus();

    fireEvent.keyDown(tree, { key: 'End' });
    await waitFor(() => expect(row('gs-1')!).toHaveAttribute('aria-selected', 'true'));

    fireEvent.keyDown(tree, { key: 'Home' });
    await waitFor(() => expect(row('isa')!).toHaveAttribute('aria-selected', 'true'));

    fireEvent.keyDown(tree, { key: 'ArrowUp' });
    // Already at the top: the clamp keeps focus on the first row rather than falling off the tree.
    expect(row('isa')!).toHaveAttribute('aria-selected', 'true');
  });

  it('expands with ArrowRight, steps into the first child, and collapses with ArrowLeft', async () => {
    await renderLoadedPanel();
    const tree = screen.getByRole('tree');

    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    await waitFor(() => expect(row('gs-0')!).toHaveAttribute('aria-selected', 'true'));

    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    await waitFor(() => expect(row('st-0')).toBeDefined());

    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    await waitFor(() => expect(row('st-0')!).toHaveAttribute('aria-selected', 'true'));

    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    // The transaction set is expanded, so the first ArrowLeft collapses it in place.
    await waitFor(() => expect(row('seg-nm1')).toBeUndefined());
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    await waitFor(() => expect(row('gs-0')!).toHaveAttribute('aria-selected', 'true'));
  });

  it('jumps to a construct by type-ahead', async () => {
    await renderLoadedPanel();
    const tree = screen.getByRole('tree');

    fireEvent.keyDown(tree, { key: 'F' });
    fireEvent.keyDown(tree, { key: 'u' });
    await waitFor(() => expect(row('gs-0')!).toHaveAttribute('aria-selected', 'true'));
  });
});

// ── Filtering and focus restoration ───────────────────────────────────────────────────────────────

describe('filtering', () => {
  it('force-expands to reveal a deep match and reports the visible row count', async () => {
    await renderLoadedPanel();

    fireEvent.change(screen.getByTestId('catalog-format-detail-filter'), {
      target: { value: 'NM101' },
    });

    await waitFor(() => expect(row('el-nm101')).toBeDefined());
    expect(row('gs-1')).toBeUndefined();
    expect(screen.getByTestId('catalog-format-detail-row-count')).toHaveTextContent(`5 of ${X12_NODE_COUNT} nodes shown`);
  });

  it('states that no construct matches, and that values are never searched', async () => {
    await renderLoadedPanel();

    fireEvent.change(screen.getByTestId('catalog-format-detail-filter'), {
      target: { value: 'no-such-construct' },
    });

    const empty = await screen.findByTestId('catalog-format-detail-no-matches');
    expect(empty).toHaveTextContent(/never observed values/i);
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('restores a valid Tab stop after a filter change removes the focused row', async () => {
    await renderLoadedPanel();
    const tree = screen.getByRole('tree');

    // Focus the last row, then filter it away.
    fireEvent.keyDown(tree, { key: 'End' });
    await waitFor(() => expect(row('gs-1')!).toHaveAttribute('aria-selected', 'true'));

    fireEvent.change(screen.getByTestId('catalog-format-detail-filter'), {
      target: { value: 'NM101' },
    });

    await waitFor(() => expect(row('gs-1')).toBeUndefined());
    // Exactly one row still holds the tab stop, and it is a row that exists.
    const stops = rows().filter((element) => element.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBeInTheDocument();
  });

  it('clears the filter from its own control', async () => {
    await renderLoadedPanel();

    fireEvent.change(screen.getByTestId('catalog-format-detail-filter'), {
      target: { value: 'NM101' },
    });
    await waitFor(() => expect(row('el-nm101')).toBeDefined());

    fireEvent.click(screen.getByTestId('catalog-format-detail-filter-clear'));
    await waitFor(() => expect(row('gs-1')).toBeDefined());
  });

  it('collapses the whole tree on request', async () => {
    await renderLoadedPanel();

    fireEvent.click(screen.getByTestId('catalog-format-detail-collapse-all'));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(row('isa')!).toHaveAttribute('aria-expanded', 'false');
  });
});

// ── Node evidence ─────────────────────────────────────────────────────────────────────────────────

describe('selected construct evidence', () => {
  it('states a withheld value as withheld, with its length, and never as empty', async () => {
    await renderLoadedPanel();

    fireEvent.click(row('st-0')!);
    await waitFor(() => expect(row('seg-nm1')).toBeDefined());
    fireEvent.click(row('seg-nm1')!);
    await waitFor(() => expect(row('el-nm101')).toBeDefined());
    fireEvent.click(row('el-nm101')!);

    const evidence = await screen.findByTestId('catalog-format-detail-selected');
    expect(evidence).toHaveTextContent(/20 characters was observed and withheld/i);
    expect(evidence).not.toHaveTextContent(/empty/i);
    expect(screen.queryByTestId('catalog-format-detail-node-value')).not.toBeInTheDocument();
  });

  it('renders the construct’s own attributes and its source location', async () => {
    await renderLoadedPanel();

    fireEvent.click(row('st-0')!);

    const evidence = await screen.findByTestId('catalog-format-detail-selected');
    expect(evidence).toHaveTextContent('setId');
    expect(evidence).toHaveTextContent('837');
    expect(evidence).toHaveTextContent('controlNumber');
    expect(screen.getByTestId('catalog-format-detail-node-location')).toHaveTextContent('ISA/GS[0]/ST[0]');
  });

  it('offers a shareable deep link to the selected construct', async () => {
    await renderLoadedPanel();

    fireEvent.click(row('gs-0')!);
    const link = await screen.findByTestId('catalog-format-detail-node-link');
    expect(link).toHaveAttribute('href', `/ade/dashboard/catalog/${ITEM_ID}?tab=format&node=gs-0`);
  });

  it('tells a path-only construct that the raw viewer cannot be opened at it', async () => {
    await renderLoadedPanel();

    fireEvent.click(row('gs-0')!);
    const note = await screen.findByTestId('catalog-format-detail-no-source-jump');
    expect(note).toHaveTextContent(/structural path rather than by a position in the raw source/i);
    expect(screen.queryByTestId('catalog-format-detail-view-source')).not.toBeInTheDocument();
    expect(onViewSourceLine).not.toHaveBeenCalled();
  });

  it('opens the raw viewer at a line-addressed construct', async () => {
    mockTransport(boundedCopybookRecord());
    await renderLoadedPanel({ sourceFormat: 'cobolcopybook' });

    fireEvent.click(row('fld-amount')!);
    fireEvent.click(await screen.findByTestId('catalog-format-detail-view-source'));

    // A copybook node knows its line and not its bytes, so the range is null and the viewer falls
    // back to centring the line. The construct is still named, so the viewer can say what sent it.
    expect(onViewSourceLine).toHaveBeenCalledWith(12, 'claim.cpy', null, 'Field CLAIM-AMOUNT');
  });

  it('offers no jump at all when the raw source was never captured', async () => {
    mockTransport(boundedCopybookRecord());
    await renderLoadedPanel({ sourceFormat: 'cobolcopybook', sourceAvailable: false });

    fireEvent.click(row('fld-amount')!);
    const note = await screen.findByTestId('catalog-format-detail-no-source-jump');
    expect(note).toHaveTextContent(/not captured at import/i);
    expect(screen.queryByTestId('catalog-format-detail-view-source')).not.toBeInTheDocument();
  });

  it('shows an observed value only when the record actually carries one', async () => {
    const record = x12Record();
    record.analysis.redaction.valueVisibility = 'full';
    record.analysis.redaction.redactedNodeCount = 0;
    record.analysis.tree = [
      {
        id: 'isa',
        kind: 'interchange',
        name: 'ISA',
        children: [{ id: 'el', kind: 'element', name: 'NM103', value: 'ACME CLINIC', valuePresent: true }],
      },
    ];
    mockTransport(record);
    await renderLoadedPanel();

    fireEvent.click(row('el')!);
    expect(await screen.findByTestId('catalog-format-detail-node-value')).toHaveTextContent('ACME CLINIC');
  });

  it('restores focus to the construct it sent the reader away from', async () => {
    mockTransport(boundedCopybookRecord());
    const props = {
      itemId: ITEM_ID,
      summary: AVAILABLE_SUMMARY,
      sourceFormat: 'cobolcopybook',
      sourceAvailable: true,
      onViewSourceLine,
      nodeHref,
    };
    const { rerender } = await renderLoadedPanel({ sourceFormat: 'cobolcopybook' });

    fireEvent.click(row('fld-amount')!);
    fireEvent.click(await screen.findByTestId('catalog-format-detail-view-source'));

    // The reader is on the Source & Code tab; the jump button, not the tree, holds focus.
    rerender(<CatalogFormatDetailPanel {...props} active={false} />);
    rerender(<CatalogFormatDetailPanel {...props} active />);

    await waitFor(() => expect(row('fld-amount')!).toHaveFocus());
  });
});

// ── Deep links ────────────────────────────────────────────────────────────────────────────────────

describe('deep links', () => {
  it('expands a deep-linked construct’s ancestors, then selects and focuses it', async () => {
    renderPanel({ focusNodeId: 'el-nm101' });

    await waitFor(() => expect(row('el-nm101')).toBeDefined());
    expect(row('el-nm101')!).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(row('el-nm101')!).toHaveFocus());
    expect(row('seg-nm1')!).toHaveAttribute('aria-expanded', 'true');
  });

  it('states that a linked construct is not in this analysis rather than selecting another', async () => {
    renderPanel({ focusNodeId: 'seg-from-an-older-analysis' });

    const note = await screen.findByTestId('catalog-format-detail-missing-node');
    expect(note).toHaveTextContent('seg-from-an-older-analysis');
    expect(note).toHaveTextContent(/only stable within one/i);
    expect(rows().filter((element) => element.getAttribute('aria-selected') === 'true')).toHaveLength(0);
  });
});

// ── Windowing ─────────────────────────────────────────────────────────────────────────────────────

describe('windowing', () => {
  const CHILDREN = ANALYSIS_TREE_VIRTUALIZE_ABOVE + 10;

  it('mounts only a window of rows above the budget, and says so', async () => {
    mockTransport(wideRecord(CHILDREN));
    // Three rows' worth of viewport, so the window is unmistakably smaller than the row set.
    await renderLoadedPanel({ viewportHeight: 96 });

    expect(screen.getByTestId('catalog-format-detail-windowed')).toBeInTheDocument();
    expect(rows().length).toBeLessThan(CHILDREN + 1);
    expect(screen.getByTestId('catalog-format-detail-row-count')).toHaveTextContent(
      `${CHILDREN + 1} of ${CHILDREN + 1} nodes shown`,
    );
  });

  it('mounts every row at or below the budget', async () => {
    mockTransport(wideRecord(ANALYSIS_TREE_VIRTUALIZE_ABOVE - 1));
    await renderLoadedPanel({ viewportHeight: 96 });

    expect(screen.queryByTestId('catalog-format-detail-windowed')).not.toBeInTheDocument();
    expect(rows()).toHaveLength(ANALYSIS_TREE_VIRTUALIZE_ABOVE);
  });

  it('pins the focused row so windowing never drops the tree’s Tab stop', async () => {
    mockTransport(wideRecord(CHILDREN));
    await renderLoadedPanel({ viewportHeight: 96 });

    const tree = screen.getByRole('tree');
    const scroller = tree.parentElement!;
    // Scroll far past the focused first row.
    act(() => {
      Object.defineProperty(scroller, 'scrollTop', { value: 1600, writable: true });
      fireEvent.scroll(scroller);
    });

    await waitFor(() => expect(row('isa')).toBeDefined());
    expect(rows().filter((element) => element.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});

// ── Capability registry (CPDO-2.4) ────────────────────────────────────────────────────────────────

describe('format capability registry', () => {
  it('mounts the capability panel for the analysed format', async () => {
    await renderLoadedPanel();

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /EDI X12 — what apiome records/i })).toBeInTheDocument(),
    );
    expect(screen.getByText('x12.hl_hierarchy')).toBeInTheDocument();
  });

  it('renders without the registry when it cannot be loaded — it explains, it never gates', async () => {
    fetchMock = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/format-capabilities')) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ success: true, record: x12Record() }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await renderLoadedPanel();

    expect(screen.getByTestId('catalog-format-detail-status')).toHaveTextContent('Available');
    expect(
      screen.queryByRole('heading', { name: /what apiome records/i }),
    ).not.toBeInTheDocument();
  });
});
