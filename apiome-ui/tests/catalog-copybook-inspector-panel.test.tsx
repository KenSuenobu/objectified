/**
 * Render tests for the COBOL copybook layout inspector (CPDO-2.3, #4799) — both standalone and
 * mounted inside the CPDO-2.1 Format details pane.
 *
 * The ticket's acceptance criteria are what this file asserts:
 *
 *  1. **fixtures cover** nesting, OCCURS/ODO, COMP-3, conditions and REDEFINES;
 *  2. **mapped details link to canonical fields** — a group to its own entity, an elementary item
 *     to the entity that carries it, and nothing at all for a name the parsed model lacks;
 *  3. **ambiguous or unsized layouts surface warnings** rather than plausible numbers;
 *  4. **fixed-format source line navigation works** — an item opens the raw viewer at its own line;
 *  5. **no semantics are guessed** — an unknown length shows as unknown, and a variable offset says
 *     it depends on runtime data instead of showing its minimum.
 */

import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { CatalogCopybookInspectorPanel } from '@/app/components/ade/dashboard/catalog/CatalogCopybookInspectorPanel';
import { CatalogFormatDetailPanel } from '@/app/components/ade/dashboard/catalog/CatalogFormatDetailPanel';
import { resetFormatCapabilitiesCache } from '@/app/components/ade/dashboard/catalog/useFormatCapabilities';
import type { AnalysisRecord } from '@/app/utils/catalog-payload-analysis';
import {
  AVAILABLE_SUMMARY,
  REGISTRY_SNAPSHOT,
  copybookLayoutRecord,
  copybookVariableRecord,
  x12ScannedRecord,
} from './helpers/payload-analysis-fixture';

const ITEM_ID = 'cat-cpy';

/** The parsed-entity names the Overview would render for the layout fixture. */
const ENTITY_NAMES = ['PAYMENT-RECORD', 'CARD-DETAIL', 'BANK-DETAIL'];

// ── Harness ───────────────────────────────────────────────────────────────────────────────────────

const originalFetch = global.fetch;
let onViewSourceLine: jest.Mock;
let onRevealEntity: jest.Mock;

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
  overrides: Partial<React.ComponentProps<typeof CatalogCopybookInspectorPanel>> = {},
) {
  return render(
    <CatalogCopybookInspectorPanel
      document={copybookLayoutRecord().analysis}
      entityNames={ENTITY_NAMES}
      onRevealEntity={onRevealEntity}
      {...overrides}
    />,
  );
}

/** Render the whole Format details pane and wait for the record to land. */
async function renderPane(record: AnalysisRecord = copybookLayoutRecord()) {
  mockTransport(record);
  const utils = render(
    <CatalogFormatDetailPanel
      itemId={ITEM_ID}
      summary={{
        ...AVAILABLE_SUMMARY,
        sourceFormat: 'cobolcopybook',
        analyzerKey: 'cobolcopybook',
        nodeCount: record.analysis.metrics.nodeCount,
      }}
      sourceFormat="cobolcopybook"
      active
      sourceAvailable
      onViewSourceLine={onViewSourceLine}
      onRevealEntity={onRevealEntity}
      entityNames={ENTITY_NAMES}
      nodeHref={(nodeId) => `/ade/dashboard/catalog/${ITEM_ID}?tab=format&node=${nodeId}`}
    />,
  );
  await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
  return utils;
}

/** The tree row whose node id is `id`, or undefined when it is not mounted. */
function treeRow(id: string): HTMLElement | undefined {
  return screen
    .queryAllByRole('treeitem')
    .find((element) => element.getAttribute('data-node-id') === id);
}

/** The storage-map row for one node id. */
function mapRow(id: string): HTMLElement {
  const found = screen
    .getAllByTestId('copybook-storage-row')
    .find((element) => element.getAttribute('data-node-id') === id);
  if (!found) throw new Error(`no storage row for ${id}`);
  return found;
}

beforeEach(() => {
  resetFormatCapabilitiesCache();
  onViewSourceLine = jest.fn();
  onRevealEntity = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// ── AC 1: the layout is rendered as a layout ──────────────────────────────────────────────────────

describe('the record and its storage map', () => {
  it('states the record’s byte length', () => {
    renderInspector();

    expect(screen.getByTestId('copybook-record-length')).toHaveTextContent('55 bytes');
    expect(screen.getByTestId('copybook-record-statement')).toHaveTextContent(
      /55 bytes, the same for every record/i,
    );
  });

  it('lists every item in declaration order with the bytes it occupies', () => {
    renderInspector();

    const rows = screen.getAllByTestId('copybook-storage-row');
    expect(rows).toHaveLength(10);
    expect(mapRow('fld-id')).toHaveTextContent('PAYMENT-ID');
    expect(mapRow('fld-amount')).toHaveTextContent('12–17');
    expect(mapRow('fld-posted')).toHaveTextContent('48–55');
  });

  it('indents by nesting depth, so the map reads like the source does', () => {
    renderInspector();

    expect(mapRow('grp-card')).toHaveAttribute('data-depth', '1');
    expect(mapRow('fld-card-number')).toHaveAttribute('data-depth', '2');
  });

  it('shows a packed field’s picture, usage and derivation', () => {
    renderInspector();
    const amount = mapRow('fld-amount');

    expect(amount).toHaveTextContent('S9(9)V99');
    expect(amount).toHaveTextContent('COMP-3');
    expect(amount).toHaveTextContent('packed');
    expect(amount).toHaveTextContent('signed');
    expect(amount).toHaveTextContent('2 dp');
  });

  it('counts the items it could size against the items there are', () => {
    renderInspector();
    expect(screen.getByTestId('copybook-sized-count')).toHaveTextContent('10 of 10 items sized');
  });

  it('rides condition names on the item they qualify rather than giving them rows', () => {
    renderInspector();

    expect(screen.getAllByTestId('copybook-storage-row')).toHaveLength(10);
    expect(within(mapRow('fld-type')).getByTestId('copybook-conditions')).toHaveTextContent(
      '2 conditions',
    );
  });

  it('renders inside the Format details pane, above the tree', async () => {
    await renderPane();
    expect(screen.getByTestId('catalog-copybook-inspector')).toBeInTheDocument();
  });
});

// ── REDEFINES ─────────────────────────────────────────────────────────────────────────────────────

describe('shared storage', () => {
  it('groups redefining items under the bytes they share', () => {
    renderInspector();

    const overlays = screen.getAllByTestId('copybook-overlay');
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toHaveTextContent('PAYMENT-DETAIL');
    expect(overlays[0]).toHaveTextContent('18–47');
    expect(screen.getAllByTestId('copybook-overlay-item')).toHaveLength(2);
  });

  it('badges each item on the map with what it redefines', () => {
    renderInspector();

    expect(within(mapRow('grp-card')).getByTestId('copybook-redefines')).toHaveTextContent(
      'redefines PAYMENT-DETAIL',
    );
    expect(within(mapRow('grp-bank')).getByTestId('copybook-redefines')).toHaveTextContent(
      'redefines PAYMENT-DETAIL',
    );
  });

  it('flags an overlay that does not fit, without adjusting either length', () => {
    const record = copybookLayoutRecord();
    const card = record.analysis.tree[0].children![4];
    card.attributes = { ...card.attributes, totalLength: 44 };
    renderInspector({ document: record.analysis });

    expect(screen.getByTestId('copybook-overlay-oversized')).toHaveTextContent(
      'CARD-DETAIL — needs 44 bytes',
    );
    expect(screen.getByTestId('copybook-overlay')).toHaveTextContent(
      /neither is adjusted to fit/i,
    );
    // The base still reports its own computed length.
    expect(screen.getByTestId('copybook-overlay')).toHaveTextContent('18–47');
  });

  it('shows no overlay section for a copybook with no REDEFINES', () => {
    renderInspector({ document: copybookVariableRecord().analysis });
    expect(screen.queryByTestId('copybook-overlays')).not.toBeInTheDocument();
  });
});

// ── Tables and ODO controllers ────────────────────────────────────────────────────────────────────

describe('tables', () => {
  it('reports a variable table’s bounds and its controller', () => {
    renderInspector({ document: copybookVariableRecord().analysis, entityNames: [] });

    const table = screen.getByTestId('copybook-table');
    expect(table).toHaveAttribute('data-variable', 'true');
    expect(table).toHaveTextContent('ORDER-LINES');
    expect(table).toHaveTextContent('1–9 occurrences');
    expect(table).toHaveTextContent('OUTER-LINE-COUNT');
  });

  it('says when the controller is not declared in this copybook', () => {
    renderInspector({ document: copybookVariableRecord().analysis, entityNames: [] });

    expect(screen.getByTestId('copybook-controller-unresolved')).toHaveTextContent(
      /may be declared in a surrounding one/i,
    );
  });

  it('badges the table on the storage map with its occurrence bounds', () => {
    renderInspector({ document: copybookVariableRecord().analysis, entityNames: [] });
    expect(within(mapRow('grp-lines')).getByTestId('copybook-occurs')).toHaveTextContent(
      'OCCURS 1–9',
    );
  });

  it('shows no table section for a copybook with no OCCURS', () => {
    renderInspector();
    expect(screen.queryByTestId('copybook-tables')).not.toBeInTheDocument();
  });
});

// ── AC: ambiguous or unsized layouts surface warnings ─────────────────────────────────────────────

describe('unknowable positions and lengths', () => {
  it('says an unsized record’s length was not computed rather than showing a number', () => {
    renderInspector({ document: copybookVariableRecord().analysis, entityNames: [] });

    expect(screen.getByTestId('copybook-record-length')).toHaveTextContent('length not computed');
    expect(screen.getByTestId('copybook-record-statement')).toHaveTextContent(
      /could not be computed/i,
    );
  });

  it('marks an item after a variable table as varying rather than showing its minimum', () => {
    renderInspector({ document: copybookVariableRecord().analysis, entityNames: [] });

    const absent = within(mapRow('fld-note')).getByTestId('copybook-offset-absent');
    expect(absent).toHaveAttribute('data-variable', 'true');
    expect(absent).toHaveTextContent('varies');
  });

  it('shows an unknown length as unknown, never as zero', () => {
    renderInspector({ document: copybookVariableRecord().analysis, entityNames: [] });

    expect(mapRow('fld-note')).toHaveTextContent('unknown');
    expect(mapRow('fld-note')).not.toHaveTextContent(/\b0\b/);
  });

  it('shows the shortfall in the sized-item count', () => {
    renderInspector({ document: copybookVariableRecord().analysis, entityNames: [] });
    // Four items; ORDER-NOTE's PICTURE cannot be sized, so three of them are.
    expect(screen.getByTestId('copybook-sized-count')).toHaveTextContent('3 of 4 items sized');
  });

  it('surfaces the analyzer’s own unsized-item warning in the pane', async () => {
    await renderPane(copybookVariableRecord());

    const warnings = screen.getAllByTestId('catalog-format-detail-warning');
    expect(warnings.some((entry) => entry.textContent?.includes('copybook.unsized_item'))).toBe(
      true,
    );
    // And the record is declared partial rather than presented as complete.
    expect(screen.getByTestId('catalog-format-detail-status')).toHaveTextContent('Partial');
  });
});

// ── AC: assumptions, not assertions ───────────────────────────────────────────────────────────────

describe('the assumptions behind every byte count', () => {
  it('lists them from the analyzer’s own warning', () => {
    renderInspector();

    const list = screen.getByTestId('copybook-assumptions');
    expect(list).toHaveTextContent(/single-byte encoding/i);
    expect(list).toHaveTextContent(/SYNCHRONIZED/);
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(1);
  });

  it('says so plainly when the record recorded none, rather than inventing a list', () => {
    const record = copybookLayoutRecord({ warnings: [] });
    renderInspector({ document: record.analysis });

    expect(screen.getByTestId('copybook-assumptions-absent')).toHaveTextContent(
      /computed rather than observed/i,
    );
    expect(screen.queryByTestId('copybook-assumptions')).not.toBeInTheDocument();
  });
});

// ── AC: mapped details link to canonical fields ───────────────────────────────────────────────────

describe('canonical links', () => {
  it('links a group item to its own parsed entity', () => {
    renderInspector();

    const link = within(mapRow('grp-card')).getByTestId('copybook-canonical-link');
    expect(link).toHaveAttribute('data-entity', 'CARD-DETAIL');
    expect(link).toHaveTextContent('parsed entity');

    fireEvent.click(link);
    expect(onRevealEntity).toHaveBeenCalledWith('CARD-DETAIL');
  });

  it('links an elementary item to the entity that carries it as a field', () => {
    renderInspector();

    const link = within(mapRow('fld-card-number')).getByTestId('copybook-canonical-link');
    expect(link).toHaveTextContent('field on CARD-DETAIL');

    fireEvent.click(link);
    expect(onRevealEntity).toHaveBeenCalledWith('CARD-DETAIL');
  });

  it('offers no link for an item the parsed model does not carry', () => {
    renderInspector({ entityNames: ['SOMETHING-ELSE'] });

    expect(screen.queryAllByTestId('copybook-canonical-link')).toHaveLength(0);
  });

  it('offers no link at all when the screen has nowhere to send the reader', () => {
    renderInspector({ onRevealEntity: undefined });
    expect(screen.queryAllByTestId('copybook-canonical-link')).toHaveLength(0);
  });
});

// ── AC: fixed-format source line navigation ───────────────────────────────────────────────────────

describe('source navigation', () => {
  it('reveals an item in the structure tree from the storage map', async () => {
    await renderPane();

    // Collapse everything, so the item is genuinely unreachable before the link is followed.
    fireEvent.click(screen.getByTestId('catalog-format-detail-collapse-all'));
    await waitFor(() => expect(treeRow('fld-card-number')).toBeUndefined());

    fireEvent.click(within(mapRow('fld-card-number')).getByTestId('copybook-item-reveal'));

    await waitFor(() => expect(treeRow('fld-card-number')).toBeDefined());
    expect(treeRow('fld-card-number')).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the raw viewer at the fixed-format line the item was declared on', async () => {
    await renderPane();

    fireEvent.click(within(mapRow('fld-amount')).getByTestId('copybook-item-reveal'));
    await waitFor(() =>
      expect(treeRow('fld-amount')).toHaveAttribute('aria-selected', 'true'),
    );
    fireEvent.click(await screen.findByTestId('catalog-format-detail-view-source'));

    // A copybook knows its line and not its bytes, so the range is null and the line stands.
    expect(onViewSourceLine).toHaveBeenCalledWith(12, 'payment.cpy', null, 'Field PAYMENT-AMOUNT');
  });
});

// ── Applicability ─────────────────────────────────────────────────────────────────────────────────

describe('when the inspector does not apply', () => {
  it('renders nothing for a record from another analyzer', () => {
    const { container } = renderInspector({ document: x12ScannedRecord().analysis });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a copybook record carrying no level-01 item', () => {
    const record = copybookLayoutRecord();
    record.analysis.tree = [];
    const { container } = renderInspector({ document: record.analysis });
    expect(container).toBeEmptyDOMElement();
  });

  it('is absent from the Format details pane for an X12 interchange', async () => {
    mockTransport(x12ScannedRecord());
    render(
      <CatalogFormatDetailPanel
        itemId={ITEM_ID}
        summary={AVAILABLE_SUMMARY}
        sourceFormat="edix12"
        active
        sourceAvailable
        onViewSourceLine={onViewSourceLine}
        nodeHref={(nodeId) => `?node=${nodeId}`}
      />,
    );
    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());

    expect(screen.queryByTestId('catalog-copybook-inspector')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-x12-inspector')).toBeInTheDocument();
  });
});
