/**
 * ExportMappingGraphPanel — the source-to-target mapping graph (IXH-4.2, #5110).
 *
 * Covers the ticket's acceptance criteria at the component level:
 *
 *  1. Shared primitives: the graph draws the shared status vocabulary (text label +
 *     symbol, never colour alone) and bounds itself with the shared budgets.
 *  2. Node selection opens the **existing** evidence drawer with the reason code, the
 *     fidelity finding, and the target pointer — and flows through the Review step's
 *     entity selection, so the code viewer and the explorer follow.
 *  3. The always-rendered table is the text alternative: one row per graph node, the same
 *     accessible names, and it is the graph's accessible name (`aria-labelledby`).
 *  4. The graph's statuses reconcile with the manifest's fidelity-report counts for the
 *     same job — stated when they agree, warned when they do not, and reported as a
 *     partial walk (never as a mismatch) while pages remain.
 *  5. Keyboard-only operation, bounded rendering with everything stated, and jest-axe
 *     clean in the rendered states.
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe, toHaveNoViolations } from 'jest-axe';
import { jest } from '@jest/globals';

import { ExportMappingGraphPanel } from '../src/app/components/ade/dashboard/export/ExportMappingGraphPanel';
import { resetCapabilityReasonsCache } from '../src/app/components/ade/dashboard/export/useCapabilityReasons';
import { REASON_CODES } from '../src/app/components/ade/dashboard/export/capabilityRegistry';
import { mappingRowId } from '../src/app/components/ade/dashboard/export/exportMappingGraph';
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

const ENTITIES: ExportManifestEntity[] = [
  entity({
    key: 'Users',
    name: 'Users',
    entity_kind: 'service',
    order: 0,
    location: { file: 'openapi.json', line: 4, pointer: null },
    native_name: 'UserService',
    source_location: 'schema.graphql:3',
  }),
  entity({
    key: 'GET /users/{id}',
    name: 'getUser',
    entity_kind: 'operation',
    parent_key: 'Users',
    order: 1,
    status: 'approximated',
    severity: 'warn',
    reason: 'destination_unsupported',
    detail: 'the response union was flattened',
    location: { file: 'openapi.json', line: 9, pointer: '/paths/~1users~1{id}/get' },
  }),
  entity({
    key: 'user/signedup',
    name: 'user/signedup',
    entity_kind: 'channel',
    order: 2,
    status: 'dropped',
    severity: 'critical',
    reason: 'destination_unsupported',
    detail: 'the destination has no event channels',
    emitted: false,
  }),
  entity({
    key: 'User.avatar',
    name: 'avatar',
    entity_kind: 'field',
    parent_key: 'User',
    order: 3,
    status: 'unavailable',
    reason: 'source_parse_limit',
    detail: 'the source parser did not capture this field',
    emitted: false,
  }),
];

function page(overrides: Partial<ExportPreviewManifestPage> = {}): ExportPreviewManifestPage {
  return {
    manifest_hash: 'hash-4444444444444444',
    target: {
      key: 'openapi',
      format: 'openapi',
      label: 'OpenAPI 3.1',
      emitter_version: '1.4.0',
      apiome_version: '2.1.0',
      registry_version: '2025.07.01',
    },
    status_counts: {
      retained: 1,
      transformed: 0,
      approximated: 1,
      synthesized: 0,
      dropped: 1,
      unavailable: 1,
      'not-applicable': 0,
    },
    reason_counts: { destination_unsupported: 2, source_parse_limit: 1 },
    entities: ENTITIES,
    total_entities: 4,
    dropped_entities: 2,
    files: [{ path: 'openapi.json', media_type: 'application/json', line_count: 80, entity_count: 2 }],
    page_size: 1000,
    next_cursor: null,
    truncated: false,
    ...overrides,
  };
}

/** N clean, info-severity entities — the aggregation/draw-budget fodder. */
function cleanEntities(count: number): ExportManifestEntity[] {
  return Array.from({ length: count }, (_, index) =>
    entity({
      key: `Type${index}`,
      name: `Type${index}`,
      order: 100 + index,
      location: { file: 'openapi.json', line: 100 + index, pointer: `/components/schemas/Type${index}` },
    }),
  );
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

type PanelProps = React.ComponentProps<typeof ExportMappingGraphPanel>;

/**
 * Render the panel and flush the evidence drawer's registry fetch, so no state settles
 * outside `act` (the suite runs warning-free).
 */
async function renderPanel(props: Partial<PanelProps> = {}) {
  const onSelectEntity = props.onSelectEntity ?? jest.fn();
  const onClearSelection = props.onClearSelection ?? jest.fn();
  const onLoadMore = props.onLoadMore ?? jest.fn();
  const utils = render(
    <ExportMappingGraphPanel
      page={page()}
      entities={ENTITIES}
      loading={false}
      error={null}
      complete
      onLoadMore={onLoadMore}
      targetLabel="OpenAPI 3.1"
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
  // The registry is module-cached across mounts; reset it so every test fetches afresh.
  resetCapabilityReasonsCache();
});

// ---------------------------------------------------------------------------
// 1. Graph / table parity (IXH-4.2 AC 3)
// ---------------------------------------------------------------------------

describe('ExportMappingGraphPanel — graph and its text alternative', () => {
  it('draws one node per entity and one table row per node, with the same names', async () => {
    const { container } = await renderPanel();

    const nodes = Array.from(container.querySelectorAll('[data-testid^="export-mapping-node-"]'));
    const rows = Array.from(container.querySelectorAll('[data-testid^="export-mapping-table-row-"]'));
    expect(nodes).toHaveLength(4);
    expect(rows).toHaveLength(4);

    for (const key of ENTITIES.map((e) => mappingRowId(e.key))) {
      const node = screen.getByTestId(`export-mapping-node-${key}`);
      const rowButton = screen.getByTestId(`export-mapping-row-select-${key}`);
      // The graph node and its table row say exactly the same thing.
      expect(rowButton.getAttribute('aria-label')).toBe(node.getAttribute('aria-label'));
    }
  });

  it('states each outcome in text, not by colour alone', async () => {
    await renderPanel();
    const legend = screen.getByTestId('export-mapping-legend');
    for (const status of ['retained', 'approximated', 'dropped', 'unavailable']) {
      expect(within(legend).getByTestId(`export-mapping-legend-${status}`)).toBeInTheDocument();
    }
    // The dropped channel's row spells its outcome and reason out.
    const row = screen.getByTestId(`export-mapping-table-row-${mappingRowId('user/signedup')}`);
    expect(within(row).getByText('Dropped')).toBeInTheDocument();
    expect(within(row).getByText(/destination_unsupported/)).toBeInTheDocument();
    expect(within(row).getByText(/omitted from the destination/i)).toBeInTheDocument();
  });

  it('names the graph by its table caption and keeps the table semantics truthful', async () => {
    await renderPanel();
    const svg = screen.getByTestId('export-mapping-svg');
    const caption = document.getElementById(svg.getAttribute('aria-labelledby') as string);
    expect(caption?.tagName.toLowerCase()).toBe('caption');
    expect(caption).toHaveTextContent(/Source-to-target mapping for OpenAPI 3\.1/);
    expect(screen.getByTestId('export-mapping-table')).toHaveAttribute('aria-rowcount', '5');
  });

  it('prints the target pointer of a carried entity and says so for one that is not', async () => {
    await renderPanel();
    const carried = screen.getByTestId(`export-mapping-table-row-${mappingRowId('GET /users/{id}')}`);
    expect(within(carried).getByText('/paths/~1users~1{id}/get')).toBeInTheDocument();
    const dropped = screen.getByTestId(`export-mapping-table-row-${mappingRowId('user/signedup')}`);
    expect(within(dropped).getByText('— not emitted')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Selection → the existing evidence drawer (IXH-4.2 AC 2)
// ---------------------------------------------------------------------------

describe('ExportMappingGraphPanel — selection and evidence', () => {
  it('routes a node click through the Review step’s entity selection', async () => {
    const { onSelectEntity } = await renderPanel();
    fireEvent.click(screen.getByTestId(`export-mapping-node-${mappingRowId('user/signedup')}`));
    expect(onSelectEntity).toHaveBeenCalledWith(ENTITIES[2]);
  });

  it('routes a table-row click the same way (the text alternative is equivalent)', async () => {
    const { onSelectEntity } = await renderPanel();
    fireEvent.click(screen.getByTestId(`export-mapping-row-select-${mappingRowId('GET /users/{id}')}`));
    expect(onSelectEntity).toHaveBeenCalledWith(ENTITIES[1]);
  });

  it('opens the existing drawer with reason code, fidelity finding, and target pointer', async () => {
    await renderPanel({ selectedEntityKey: 'GET /users/{id}' });

    const drawer = screen.getByTestId('projection-detail');
    expect(within(drawer).getByText('getUser')).toBeInTheDocument();
    expect(within(drawer).getByText('Approximated')).toBeInTheDocument();
    expect(within(drawer).getByText('destination_unsupported')).toBeInTheDocument();
    expect(within(drawer).getByText('the response union was flattened')).toBeInTheDocument();
    expect(within(drawer).getByText('/paths/~1users~1{id}/get')).toBeInTheDocument();
    // The registry's reviewed remediation lands once the capability fetch settles.
    await waitFor(() =>
      expect(screen.getByTestId('projection-detail-remediation')).toHaveTextContent(
        /Choose a destination format/,
      ),
    );
  });

  it('prints the emitter/registry provenance from the manifest’s target block', async () => {
    await renderPanel({ selectedEntityKey: 'user/signedup' });
    expect(screen.getByTestId('projection-detail-provenance')).toHaveTextContent(
      'emitter v1.4.0 · registry v2025.07.01 · apiome v2.1.0',
    );
  });

  it('offers the drawer’s safe remediation navigation when the step provides it', async () => {
    const onChangeTarget = jest.fn();
    await renderPanel({ selectedEntityKey: 'user/signedup', onChangeTarget });
    fireEvent.click(screen.getByTestId('projection-detail-action-change-target'));
    expect(onChangeTarget).toHaveBeenCalled();
  });

  it('clears the step’s selection when the drawer closes', async () => {
    const { onClearSelection } = await renderPanel({ selectedEntityKey: 'user/signedup' });
    fireEvent.click(screen.getByTestId('projection-detail-close'));
    expect(onClearSelection).toHaveBeenCalled();
  });

  it('marks the selected node and its row as pressed', async () => {
    await renderPanel({ selectedEntityKey: 'user/signedup' });
    const key = mappingRowId('user/signedup');
    expect(screen.getByTestId(`export-mapping-node-${key}`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(`export-mapping-row-select-${key}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Keyboard operation
// ---------------------------------------------------------------------------

describe('ExportMappingGraphPanel — keyboard', () => {
  it('moves a roving tabindex across the nodes and selects with Enter', async () => {
    const { onSelectEntity } = await renderPanel();
    const first = screen.getByTestId(`export-mapping-node-${mappingRowId('GET /users/{id}')}`);
    expect(first).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = screen.getByTestId(`export-mapping-node-${mappingRowId('Users')}`);
    expect(second).toHaveAttribute('tabindex', '0');
    expect(first).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(second, { key: 'Enter' });
    expect(onSelectEntity).toHaveBeenCalledWith(ENTITIES[0]);
  });

  it('jumps to the first and last node with Home/End', async () => {
    await renderPanel();
    const first = screen.getByTestId(`export-mapping-node-${mappingRowId('GET /users/{id}')}`);
    fireEvent.keyDown(first, { key: 'End' });
    expect(screen.getByTestId(`export-mapping-node-${mappingRowId('User.avatar')}`)).toHaveAttribute(
      'tabindex',
      '0',
    );
    fireEvent.keyDown(screen.getByTestId(`export-mapping-node-${mappingRowId('User.avatar')}`), {
      key: 'Home',
    });
    expect(first).toHaveAttribute('tabindex', '0');
  });

  it('draws a focus ring while a node holds focus (the UA outline is suppressed)', async () => {
    await renderPanel();
    const node = screen.getByTestId(`export-mapping-node-${mappingRowId('Users')}`);
    expect(screen.queryByTestId('export-mapping-focus-ring')).not.toBeInTheDocument();
    fireEvent.focus(node);
    expect(screen.getByTestId('export-mapping-focus-ring')).toBeInTheDocument();
    fireEvent.blur(node);
    expect(screen.queryByTestId('export-mapping-focus-ring')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4. Reconciliation with the fidelity report (IXH-4.2 AC 4)
// ---------------------------------------------------------------------------

describe('ExportMappingGraphPanel — reconciliation', () => {
  it('states the reconciliation when the graph reproduces the report’s counts', async () => {
    await renderPanel();
    expect(screen.getByTestId('export-mapping-reconciled')).toHaveTextContent(
      '4 canonical entities, 2 not carried by the artifact',
    );
    expect(screen.queryByTestId('export-mapping-mismatch')).not.toBeInTheDocument();
  });

  it('warns — naming the statuses — when they disagree', async () => {
    await renderPanel({
      page: page({
        status_counts: {
          retained: 2,
          transformed: 0,
          approximated: 1,
          synthesized: 0,
          dropped: 0,
          unavailable: 1,
          'not-applicable': 0,
        },
        dropped_entities: 1,
      }),
    });
    const warning = screen.getByTestId('export-mapping-mismatch');
    expect(warning).toHaveTextContent('dropped drawn 1, reported 0');
    expect(warning).toHaveTextContent('retained drawn 1, reported 2');
  });

  it('reports an unfinished walk as partial and offers the rest', async () => {
    const { onLoadMore } = await renderPanel({
      entities: ENTITIES.slice(0, 2),
      complete: false,
      page: page({ next_cursor: 'cursor-2' }),
    });
    expect(screen.queryByTestId('export-mapping-mismatch')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-mapping-partial')).toHaveTextContent(
      'Showing 2 of 4 entities',
    );
    fireEvent.click(screen.getByTestId('export-mapping-load-more'));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('keeps the legend on the whole-artifact counts while pages are still loading', async () => {
    await renderPanel({ entities: ENTITIES.slice(0, 1), complete: false });
    const legend = screen.getByTestId('export-mapping-legend');
    expect(within(legend).getByTestId('export-mapping-legend-dropped')).toHaveTextContent('1');
  });
});

// ---------------------------------------------------------------------------
// 5. Bounded rendering — nothing is hidden silently
// ---------------------------------------------------------------------------

describe('ExportMappingGraphPanel — budgets', () => {
  it('caps the drawn nodes worst-first and states drawn-of-total', async () => {
    const entities = [...ENTITIES, ...cleanEntities(20)];
    const { container } = await renderPanel({
      entities,
      page: page({ total_entities: entities.length }),
      drawBudget: 3,
      aggregationThreshold: 1000,
    });

    const nodes = Array.from(container.querySelectorAll('[data-testid^="export-mapping-node-"]'));
    expect(nodes).toHaveLength(3);
    expect(nodes.map((node) => node.getAttribute('data-status'))).toEqual([
      'approximated',
      'dropped',
      'unavailable',
    ]);
    expect(screen.getByTestId('export-mapping-draw-cap')).toHaveTextContent(
      'Drawing 3 of 24 entities',
    );
    // The table still lists every entity — the stated path to the complete mapping.
    expect(
      container.querySelectorAll('[data-testid^="export-mapping-table-row-"]'),
    ).toHaveLength(24);
  });

  it('aggregates only clean rows, states the rule, and expands them in place', async () => {
    const entities = [...ENTITIES, ...cleanEntities(10)];
    await renderPanel({
      entities,
      page: page({ total_entities: entities.length }),
      aggregationThreshold: 4,
    });

    expect(screen.getByTestId('export-mapping-aggregated-note')).toBeInTheDocument();
    const toggle = screen.getByTestId('export-mapping-aggregate-toggle-target-retained');
    expect(toggle).toHaveTextContent('11 entities retained');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Every loss is still an individual row — aggregation never hides one.
    expect(
      screen.getByTestId(`export-mapping-table-row-${mappingRowId('user/signedup')}`),
    ).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByTestId(`export-mapping-aggregate-member-${mappingRowId('Type0')}`),
    ).toBeInTheDocument();
  });

  it('opens the aggregate’s own evidence without touching the entity selection', async () => {
    const entities = [...ENTITIES, ...cleanEntities(10)];
    const { onSelectEntity } = await renderPanel({
      entities,
      page: page({ total_entities: entities.length }),
      aggregationThreshold: 4,
    });
    await act(async () => {
      // Opening evidence starts the drawer's registry fetch; flush it inside act.
      fireEvent.click(
        screen.getByTestId('export-mapping-aggregate-select-aggregate:target:retained'),
      );
    });
    expect(onSelectEntity).not.toHaveBeenCalled();
    expect(screen.getByTestId('projection-detail')).toHaveTextContent(
      /11 constructs with this outcome were aggregated/,
    );
  });

  it('windows the table above the budget and says so', async () => {
    const entities = [...ENTITIES, ...cleanEntities(30)];
    const { container } = await renderPanel({
      entities,
      page: page({ total_entities: entities.length }),
      aggregationThreshold: 1000,
      tableVirtualizeAbove: 5,
      tableViewportHeight: 108,
    });
    const rendered = container.querySelectorAll('[data-testid^="export-mapping-table-row-"]');
    expect(rendered.length).toBeLessThan(34);
    expect(screen.getByTestId('export-mapping-table-windowed')).toHaveTextContent(
      'every one of its 34 rows is reachable',
    );
    expect(screen.getByTestId('export-mapping-table')).toHaveAttribute('aria-rowcount', '35');
  });
});

// ---------------------------------------------------------------------------
// 6. Degraded states
// ---------------------------------------------------------------------------

describe('ExportMappingGraphPanel — degraded states', () => {
  it('states a manifest failure without implicating the artifact', async () => {
    await renderPanel({ error: 'the manifest request timed out', entities: [], page: null });
    expect(screen.getByTestId('export-mapping-error')).toHaveTextContent(
      /the artifact and its fidelity report are unaffected/i,
    );
    expect(screen.queryByTestId('export-mapping-svg')).not.toBeInTheDocument();
  });

  it('shows a loading note before the first page arrives', async () => {
    await renderPanel({ entities: [], page: null, loading: true, complete: false });
    expect(screen.getByTestId('export-mapping-loading')).toBeInTheDocument();
  });

  it('states an empty manifest rather than drawing an empty graph', async () => {
    await renderPanel({ entities: [], page: page({ entities: [], total_entities: 0 }) });
    expect(screen.getByTestId('export-mapping-empty')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 7. Accessibility sweep
// ---------------------------------------------------------------------------

describe('ExportMappingGraphPanel — accessibility (WCAG 2.1 A/AA)', () => {
  it('has no axe violations with a selection open', async () => {
    const { container } = await renderPanel({ selectedEntityKey: 'user/signedup' });
    await waitFor(() => expect(screen.getByTestId('projection-detail')).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations while aggregated and windowed', async () => {
    const entities = [...ENTITIES, ...cleanEntities(30)];
    const { container } = await renderPanel({
      entities,
      page: page({ total_entities: entities.length }),
      aggregationThreshold: 4,
      tableVirtualizeAbove: 5,
      tableViewportHeight: 108,
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
