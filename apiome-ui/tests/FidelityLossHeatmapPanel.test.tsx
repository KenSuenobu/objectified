/**
 * FidelityLossHeatmapPanel — the ranked fidelity-loss heatmap (IXH-4.3, #5111).
 *
 * Covers the ticket's acceptance criteria at the component level:
 *
 *  1. Findings are presented in the documented weighting's order, not document order, and
 *     the weighting itself is printed on the surface.
 *  2. Grouping by loss class and filtering by entity kind are both operable, and a
 *     filtered view states what it is hiding.
 *  3. The view states whether it reconciles with the fidelity report totals for the job —
 *     reconciled, partial walk, or a stated mismatch.
 *  4. Severity/heat is never colour alone: every cell prints its level in words and blocks.
 *  5. Selecting a cell opens the **existing** evidence drawer, through the Review step's
 *     shared entity selection.
 *  6. Degraded states and jest-axe cleanliness.
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe, toHaveNoViolations } from 'jest-axe';
import { jest } from '@jest/globals';

import { FidelityLossHeatmapPanel } from '../src/app/components/ade/dashboard/export/FidelityLossHeatmapPanel';
import { resetCapabilityReasonsCache } from '../src/app/components/ade/dashboard/export/useCapabilityReasons';
import { REASON_CODES } from '../src/app/components/ade/dashboard/export/capabilityRegistry';
import { mappingRowId } from '../src/app/components/ade/dashboard/export/exportMappingGraph';
import { heatmapCellKey } from '../src/app/components/ade/dashboard/export/fidelityLossHeatmap';
import type {
  ExportManifestEntity,
  ExportPreviewManifestPage,
} from '../src/app/components/ade/dashboard/export/exportPreviewManifest';

expect.extend(toHaveNoViolations);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entity(overrides: Partial<ExportManifestEntity> = {}): ExportManifestEntity {
  return {
    key: 'Entity',
    name: 'Entity',
    entity_kind: 'type',
    parent_key: null,
    order: 0,
    description: null,
    deprecated: false,
    status: 'retained',
    reason: null,
    severity: 'info',
    detail: 'carried faithfully',
    target_mapping: null,
    emitted: true,
    location: null,
    aggregated: false,
    reported: true,
    native_name: null,
    native_id: null,
    source_location: null,
    ...overrides,
  };
}

/** Document order leads with the trivial losses — exactly the case the ticket describes. */
const ENTITIES: ExportManifestEntity[] = [
  entity({
    key: 'User.description',
    name: 'description',
    entity_kind: 'field',
    parent_key: 'User',
    order: 0,
    status: 'dropped',
    severity: 'info',
    reason: 'destination_unsupported',
    detail: 'the destination carries no field documentation',
    emitted: false,
  }),
  entity({
    key: 'User.summary',
    name: 'summary',
    entity_kind: 'field',
    parent_key: 'User',
    order: 1,
    status: 'dropped',
    severity: 'info',
    reason: 'destination_unsupported',
    detail: 'the destination carries no field documentation',
    emitted: false,
  }),
  entity({
    key: 'GET /pets/{id}',
    name: 'getPet',
    entity_kind: 'operation',
    parent_key: 'Pets',
    order: 2,
    status: 'dropped',
    severity: 'critical',
    reason: 'destination_unsupported',
    detail: 'the destination cannot represent operations',
    emitted: false,
    native_name: 'GetPetRPC',
    source_location: 'openapi.yaml:42',
  }),
  entity({
    key: 'User.email',
    name: 'email',
    entity_kind: 'field',
    parent_key: 'User',
    order: 3,
    status: 'approximated',
    severity: 'warn',
    reason: 'destination_unsupported',
    detail: 'the email format constraint became a doc comment',
    target_mapping: 'constraint → doc comment',
  }),
  entity({
    key: 'User',
    name: 'User',
    entity_kind: 'type',
    order: 4,
    detail: 'object carried to the destination',
  }),
];

function page(overrides: Partial<ExportPreviewManifestPage> = {}): ExportPreviewManifestPage {
  return {
    manifest_hash: 'hash-5111511151115111',
    target: {
      key: 'protobuf',
      format: 'protobuf',
      label: 'Protobuf',
      emitter_version: '1.4.0',
      apiome_version: '2.1.0',
      registry_version: '2025.07.01',
    },
    status_counts: {
      retained: 1,
      transformed: 0,
      approximated: 1,
      synthesized: 0,
      dropped: 3,
      unavailable: 0,
      'not-applicable': 0,
    },
    reason_counts: { destination_unsupported: 4 },
    entities: ENTITIES,
    total_entities: 5,
    dropped_entities: 3,
    files: [],
    page_size: 1000,
    next_cursor: null,
    truncated: false,
    ...overrides,
  };
}

/** The reviewed capability registry the evidence drawer reads its remediation from. */
const REGISTRY = {
  version: '2025.07.01',
  review_date: '2026-07-01',
  reason_codes: [...REASON_CODES],
  reasons: [
    {
      reason: 'destination_unsupported',
      category_label: 'Destination limit',
      summary_template: 'The destination format cannot represent {construct}.',
      remediation: 'Choose a destination format that supports this construct, or accept the loss.',
      destination_documentation_applies: true,
    },
  ],
  destinations: [],
};

function mockRegistryFetch(): jest.Mock {
  const fetchMock = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...REGISTRY }) }),
  ) as unknown as jest.Mock;
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

type PanelProps = React.ComponentProps<typeof FidelityLossHeatmapPanel>;

/** Render the panel and flush the drawer's registry fetch, so nothing settles outside `act`. */
async function renderPanel(props: Partial<PanelProps> = {}) {
  const onSelectEntity = props.onSelectEntity ?? jest.fn();
  const onClearSelection = props.onClearSelection ?? jest.fn();
  const onLoadMore = props.onLoadMore ?? jest.fn();
  const utils = render(
    <FidelityLossHeatmapPanel
      page={page()}
      entities={ENTITIES}
      loading={false}
      error={null}
      complete
      onLoadMore={onLoadMore}
      targetLabel="Protobuf"
      selectedEntityKey={null}
      onSelectEntity={onSelectEntity}
      onClearSelection={onClearSelection}
      {...props}
    />,
  );
  await act(async () => {});
  return { ...utils, onSelectEntity, onClearSelection, onLoadMore };
}

beforeEach(() => {
  mockRegistryFetch();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetCapabilityReasonsCache();
});

/** The ranked list's findings, top to bottom. */
function rankedOrder(): string[] {
  return Array.from(
    screen.getByTestId('fidelity-heatmap-ranked').querySelectorAll('[data-testid^="fidelity-heatmap-finding-"]'),
  ).map((node) => node.getAttribute('data-testid')!.replace('fidelity-heatmap-finding-', ''));
}

// ---------------------------------------------------------------------------
// 1. Ranking (AC 1)
// ---------------------------------------------------------------------------

describe('FidelityLossHeatmapPanel — ranking', () => {
  it('leads with the critical operation, not with the descriptions that come first in the document', async () => {
    await renderPanel();
    expect(rankedOrder()[0]).toBe(mappingRowId('GET /pets/{id}'));
    expect(screen.getByTestId(`fidelity-heatmap-rank-${mappingRowId('GET /pets/{id}')}`)).toHaveTextContent(
      '#1',
    );
    // The document's first entity is a trivial description; it ranks last of the losses.
    fireEvent.click(screen.getByTestId('fidelity-heatmap-group-rank'));
    expect(rankedOrder()).toEqual([
      mappingRowId('GET /pets/{id}'),
      mappingRowId('User.email'),
      mappingRowId('User.description'),
      mappingRowId('User.summary'),
    ]);
  });

  it('never ranks a preserved construct among the losses', async () => {
    await renderPanel();
    expect(rankedOrder()).not.toContain(mappingRowId('User'));
  });

  it('prints each finding’s own score and construct weight, so the order is inspectable', async () => {
    await renderPanel();
    const worst = screen.getByTestId(`fidelity-heatmap-finding-${mappingRowId('GET /pets/{id}')}`);
    expect(worst).toHaveTextContent('operation · weight 10 · score 200');
  });

  it('documents the weighting on the surface itself', async () => {
    await renderPanel();
    const disclosure = screen.getByTestId('fidelity-heatmap-weighting');
    expect(disclosure).toHaveTextContent('construct × severity × outcome');
    expect(within(disclosure).getByTestId('fidelity-heatmap-weight-operation')).toHaveTextContent(
      'Operation × 10',
    );
    expect(
      within(disclosure).getByTestId(
        'fidelity-heatmap-weight-documentation-only-field-description-summary-example',
      ),
    ).toHaveTextContent('× 1');
  });
});

// ---------------------------------------------------------------------------
// 2. Grouping and filtering (AC 2)
// ---------------------------------------------------------------------------

describe('FidelityLossHeatmapPanel — grouping and filtering', () => {
  it('groups the ranking by loss class by default, and can drop back to one ranking', async () => {
    await renderPanel();
    expect(screen.getByTestId('fidelity-heatmap-group-body-dropped')).toBeInTheDocument();
    expect(screen.getByTestId('fidelity-heatmap-group-body-approximated')).toBeInTheDocument();
    expect(screen.getByTestId('fidelity-heatmap-group-loss-class')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByTestId('fidelity-heatmap-group-rank'));
    expect(screen.getByTestId('fidelity-heatmap-group-body-rank')).toBeInTheDocument();
    expect(screen.queryByTestId('fidelity-heatmap-group-body-dropped')).not.toBeInTheDocument();
    // Grouping is a presentation choice — the order is the same either way.
    expect(rankedOrder()[0]).toBe(mappingRowId('GET /pets/{id}'));
  });

  it('filters the ranking by entity kind and says what it is hiding', async () => {
    await renderPanel();
    expect(screen.queryByTestId('fidelity-heatmap-filtered')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('fidelity-heatmap-kind-field'));
    expect(screen.getByTestId('fidelity-heatmap-kind-field')).toHaveAttribute('aria-pressed', 'true');
    // Grouped by loss class: the dropped descriptions, then the approximated field.
    expect(rankedOrder()).toEqual([
      mappingRowId('User.description'),
      mappingRowId('User.summary'),
      mappingRowId('User.email'),
    ]);
    expect(screen.getByTestId('fidelity-heatmap-filtered')).toHaveTextContent(
      'Showing 3 of 5 findings',
    );

    // …and the report totals in the matrix footer are untouched by the filter.
    expect(screen.getByTestId('fidelity-heatmap-total-dropped')).toHaveTextContent('3');
    fireEvent.click(screen.getByTestId('fidelity-heatmap-kind-field'));
    expect(screen.queryByTestId('fidelity-heatmap-filtered')).not.toBeInTheDocument();
  });

  it('keeps the filter chips for every kind present, so a filter can always be undone', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('fidelity-heatmap-kind-operation'));
    for (const kind of ['operation', 'field', 'type']) {
      expect(screen.getByTestId(`fidelity-heatmap-kind-${kind}`)).toBeInTheDocument();
    }
  });

  it('caps the ranked list explicitly and offers the rest', async () => {
    await renderPanel({ rankedPageSize: 2 });
    expect(rankedOrder()).toHaveLength(2);
    expect(screen.getByTestId('fidelity-heatmap-more-note')).toHaveTextContent(
      'Showing the 2 worst of 4 losses',
    );
    fireEvent.click(screen.getByTestId('fidelity-heatmap-show-more'));
    expect(rankedOrder()).toHaveLength(4);
    expect(screen.queryByTestId('fidelity-heatmap-more-note')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. Reconciliation with the fidelity report (AC 3)
// ---------------------------------------------------------------------------

describe('FidelityLossHeatmapPanel — reconciliation', () => {
  it('states that the view reconciles with the fidelity report for the job', async () => {
    await renderPanel();
    const strip = screen.getByTestId('fidelity-heatmap-reconciled');
    expect(strip).toHaveTextContent('Reconciles with the fidelity report for this job');
    expect(strip).toHaveTextContent('3 dropped');
    expect(strip).toHaveTextContent('over 5 canonical entities');
  });

  it('reports an incomplete walk as a prefix, never as a mismatch', async () => {
    await renderPanel({ entities: ENTITIES.slice(0, 3), complete: false });
    expect(screen.getByTestId('fidelity-heatmap-partial')).toHaveTextContent(
      'Ranking 3 of 5 entities',
    );
    expect(screen.queryByTestId('fidelity-heatmap-mismatch')).not.toBeInTheDocument();
    expect(screen.getByTestId('fidelity-heatmap-load-more')).toBeInTheDocument();
  });

  it('walks further pages on request', async () => {
    const { onLoadMore } = await renderPanel({ entities: ENTITIES.slice(0, 3), complete: false });
    fireEvent.click(screen.getByTestId('fidelity-heatmap-load-more'));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('states a genuine disagreement with the report instead of hiding it', async () => {
    await renderPanel({
      page: page({
        status_counts: { ...page().status_counts, dropped: 2, approximated: 2 },
      }),
    });
    expect(screen.getByTestId('fidelity-heatmap-mismatch')).toHaveTextContent(
      'does not reconcile with the fidelity report',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Colour is never the only encoding (AC 4)
// ---------------------------------------------------------------------------

describe('FidelityLossHeatmapPanel — encoding', () => {
  it('states every cell’s heat in words and blocks beside its count', async () => {
    const { container } = await renderPanel();
    const hottest = screen.getByTestId(`fidelity-heatmap-cell-${heatmapCellKey('operation', 'dropped')}`);
    expect(hottest).toHaveTextContent('severe');
    expect(hottest).toHaveTextContent('▪▪▪▪');
    expect(hottest).toHaveAttribute('data-heat', '4');

    const coolest = screen.getByTestId(`fidelity-heatmap-cell-${heatmapCellKey('field', 'dropped')}`);
    expect(coolest).toHaveTextContent('low');
    expect(coolest).toHaveAttribute('data-heat', '1');

    // Every populated cell carries a text count too — nothing is only a colour.
    for (const cell of container.querySelectorAll('[data-testid^="fidelity-heatmap-cell-"]')) {
      expect(cell.textContent).toMatch(/\d/);
    }
  });

  it('names each cell for a screen reader with its count, class, heat, and worst finding', async () => {
    await renderPanel();
    const cell = screen.getByTestId(`fidelity-heatmap-cell-${heatmapCellKey('field', 'dropped')}`);
    expect(cell.getAttribute('aria-label')).toContain('2 fields dropped');
    expect(cell.getAttribute('aria-label')).toContain('worst: description');
  });

  it('labels the matrix columns with the outcome symbol and its word', async () => {
    await renderPanel();
    const header = screen.getByTestId('fidelity-heatmap-column-dropped');
    expect(header).toHaveTextContent('Dropped');
    expect(header).toHaveTextContent('×');
  });
});

// ---------------------------------------------------------------------------
// 5. Selection → the existing evidence drawer (AC 5)
// ---------------------------------------------------------------------------

describe('FidelityLossHeatmapPanel — selection and evidence', () => {
  it('selects a cell’s worst finding and scopes the ranking to that cell', async () => {
    const { onSelectEntity } = await renderPanel();
    fireEvent.click(screen.getByTestId(`fidelity-heatmap-cell-${heatmapCellKey('field', 'dropped')}`));
    // The cell's worst finding is the entity the Review step now has selected.
    expect(onSelectEntity).toHaveBeenCalledWith(ENTITIES[0]);
    expect(rankedOrder()).toEqual([
      mappingRowId('User.description'),
      mappingRowId('User.summary'),
    ]);
    expect(screen.getByTestId('fidelity-heatmap-ranked')).toHaveTextContent('Fields dropped');

    fireEvent.click(screen.getByTestId('fidelity-heatmap-clear-scope'));
    expect(rankedOrder()).toHaveLength(4);
  });

  it('routes a ranked finding’s click through the Review step’s entity selection', async () => {
    const { onSelectEntity } = await renderPanel();
    fireEvent.click(screen.getByTestId(`fidelity-heatmap-select-${mappingRowId('User.email')}`));
    expect(onSelectEntity).toHaveBeenCalledWith(ENTITIES[3]);
  });

  it('opens the existing evidence drawer for the selected finding', async () => {
    await renderPanel({ selectedEntityKey: 'GET /pets/{id}' });

    const drawer = screen.getByTestId('projection-detail');
    expect(within(drawer).getByText('getPet')).toBeInTheDocument();
    expect(within(drawer).getByText('Dropped')).toBeInTheDocument();
    expect(within(drawer).getByText('destination_unsupported')).toBeInTheDocument();
    expect(
      within(drawer).getByText('the destination cannot represent operations'),
    ).toBeInTheDocument();
    // The reviewed remediation lands once the capability fetch settles.
    await waitFor(() =>
      expect(
        within(drawer).getByText(/Choose a destination format that supports this construct/),
      ).toBeInTheDocument(),
    );
  });

  it('clears the shared selection when the drawer is closed', async () => {
    const { onClearSelection } = await renderPanel({ selectedEntityKey: 'User.email' });
    fireEvent.click(screen.getByTestId('projection-detail-close'));
    expect(onClearSelection).toHaveBeenCalled();
  });

  it('leaves the evidence to the surface that owns it, so one selection opens one drawer', async () => {
    await renderPanel({ selectedEntityKey: 'GET /pets/{id}', showEvidence: false });
    expect(screen.queryByTestId('projection-detail')).not.toBeInTheDocument();
    // The finding itself is still marked as the selected one.
    expect(screen.getByTestId(`fidelity-heatmap-select-${mappingRowId('GET /pets/{id}')}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('offers the drawer’s safe remediation navigation when the step provides it', async () => {
    const onChangeTarget = jest.fn();
    await renderPanel({ selectedEntityKey: 'GET /pets/{id}', onChangeTarget });
    await waitFor(() =>
      expect(screen.getByTestId('projection-detail-action-change-target')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('projection-detail-action-change-target'));
    expect(onChangeTarget).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Degraded states and accessibility
// ---------------------------------------------------------------------------

describe('FidelityLossHeatmapPanel — degraded states', () => {
  it('states a manifest error without gating anything else', async () => {
    await renderPanel({ entities: [], error: 'network unreachable' });
    expect(screen.getByTestId('fidelity-heatmap-error')).toHaveTextContent('network unreachable');
    expect(screen.getByTestId('fidelity-heatmap-error')).toHaveTextContent(
      'the artifact and its fidelity report are unaffected',
    );
  });

  it('says it is still ranking while the first page is in flight', async () => {
    await renderPanel({ entities: [], loading: true, complete: false });
    expect(screen.getByTestId('fidelity-heatmap-loading')).toBeInTheDocument();
  });

  it('says so plainly when the manifest carried no entities', async () => {
    await renderPanel({ entities: [], complete: true });
    expect(screen.getByTestId('fidelity-heatmap-empty')).toBeInTheDocument();
  });

  it('celebrates a lossless export rather than showing an empty ranking', async () => {
    const clean = [entity({ key: 'User', name: 'User', entity_kind: 'type' })];
    await renderPanel({
      entities: clean,
      page: page({
        entities: clean,
        total_entities: 1,
        dropped_entities: 0,
        status_counts: {
          retained: 1,
          transformed: 0,
          approximated: 0,
          synthesized: 0,
          dropped: 0,
          unavailable: 0,
          'not-applicable': 0,
        },
      }),
    });
    expect(screen.getByTestId('fidelity-heatmap-no-loss')).toHaveTextContent('Nothing was lost');
  });

  it('is accessible in its populated state, with evidence open', async () => {
    const { container } = await renderPanel({ selectedEntityKey: 'GET /pets/{id}' });
    await waitFor(() =>
      expect(screen.getByTestId('projection-detail-remediation')).toBeInTheDocument(),
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('is accessible while a partial walk is being reported', async () => {
    const { container } = await renderPanel({ entities: ENTITIES.slice(0, 3), complete: false });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
