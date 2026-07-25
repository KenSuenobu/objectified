/**
 * Component tests for the ExportManifestPanel (IXH-4.1, #5109).
 *
 * Pins the explorer's contract: the entity tree renders with status badges and
 * locations, a dropped entity is listed with its reason spelled out (never hidden),
 * selection round-trips through `onSelectEntity` / `selectedKey`, filtering keeps
 * matches plus ancestors, truncation is declared with a load-more path, the tree is
 * windowed above the budget with the focused row pinned, the full ARIA tree keyboard
 * contract works, and the rendered states pass jest-axe (WCAG 2.1 A/AA).
 */

import React from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe, toHaveNoViolations } from 'jest-axe';
import {
  ExportManifestPanel,
  EXPORT_MANIFEST_TREE_VIRTUALIZE_ABOVE,
} from '../src/app/components/ade/dashboard/export/ExportManifestPanel';
import type {
  ExportManifestEntity,
  ExportPreviewManifestPage,
} from '../src/app/components/ade/dashboard/export/exportPreviewManifest';

expect.extend(toHaveNoViolations);

function entity(overrides: Partial<ExportManifestEntity>): ExportManifestEntity {
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

const baseEntities: ExportManifestEntity[] = [
  entity({ key: 'Users', name: 'Users', entity_kind: 'service', order: 0, aggregated: true }),
  entity({
    key: 'GET /users/{id}',
    name: 'getUser',
    entity_kind: 'operation',
    parent_key: 'Users',
    order: 1,
    location: { file: 'openapi.json', line: 9, pointer: '/paths/~1users~1{id}/get' },
  }),
  entity({
    key: 'user/signedup',
    name: 'user/signedup',
    entity_kind: 'channel',
    order: 2,
    status: 'dropped',
    reason: 'destination_unsupported',
    severity: 'warn',
    detail: 'the destination has no event channels',
    emitted: false,
  }),
  entity({
    key: 'User',
    name: 'User',
    entity_kind: 'type',
    order: 3,
    location: { file: 'openapi.json', line: 38, pointer: '/components/schemas/User' },
  }),
];

function pageFor(entities: ExportManifestEntity[]): ExportPreviewManifestPage {
  return {
    manifest_hash: 'hash-1',
    target: {
      key: 'openapi',
      format: 'openapi-3.1',
      label: 'OpenAPI 3.1',
      emitter_version: '1',
      apiome_version: '1.6.5',
      registry_version: '1',
    },
    status_counts: {},
    reason_counts: {},
    entities,
    total_entities: entities.length,
    dropped_entities: entities.filter((e) => !e.emitted).length,
    files: [{ path: 'openapi.json', media_type: 'application/json', line_count: 60, entity_count: 3 }],
    page_size: 1000,
    next_cursor: null,
    truncated: false,
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof ExportManifestPanel>> = {}) {
  const props: React.ComponentProps<typeof ExportManifestPanel> = {
    page: pageFor(baseEntities),
    entities: baseEntities,
    loading: false,
    error: null,
    complete: true,
    onLoadMore: jest.fn(),
    selectedKey: null,
    onSelectEntity: jest.fn(),
    ...overrides,
  };
  return { ...render(<ExportManifestPanel {...props} />), props };
}

describe('ExportManifestPanel — tree content', () => {
  it('renders sections with the loaded entities and status badges', () => {
    renderPanel();
    const sections = screen.getAllByTestId('export-manifest-section');
    expect(sections).toHaveLength(3);
    const rows = screen.getAllByTestId('export-manifest-entity');
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Users'),
        expect.stringContaining('user/signedup'),
        expect.stringContaining('User'),
      ]),
    );
    expect(screen.getByTestId('export-manifest-summary')).toHaveTextContent('4 entities');
  });

  it('lists a dropped entity with its status badge and drop reason (never hidden)', () => {
    const { props } = renderPanel();
    const dropped = screen
      .getAllByTestId('export-manifest-entity')
      .find((row) => row.textContent?.includes('user/signedup'))!;
    expect(within(dropped).getByTestId('export-manifest-status')).toHaveAttribute(
      'data-status',
      'dropped',
    );

    fireEvent.click(dropped);
    expect(props.onSelectEntity).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'user/signedup' }),
    );
  });

  it('spells out the selected entity’s reason and location in the detail strip', () => {
    renderPanel({ selectedKey: 'user/signedup' });
    const detail = screen.getByTestId('export-manifest-detail');
    expect(within(detail).getByTestId('export-manifest-reason')).toHaveTextContent(
      'destination_unsupported',
    );
    expect(detail).toHaveTextContent('the destination has no event channels');
    expect(detail).toHaveTextContent(/not in artifact/i);
  });

  it('shows a located entity’s file:line on its row and in the detail strip', () => {
    renderPanel({ selectedKey: 'User' });
    const detail = screen.getByTestId('export-manifest-detail');
    expect(detail).toHaveTextContent('openapi.json:38');
    expect(detail).toHaveTextContent('/components/schemas/User');
  });

  it('expands a service to reveal its operations', () => {
    const { props } = renderPanel();
    const service = screen
      .getAllByTestId('export-manifest-entity')
      .find((row) => row.textContent?.includes('Users'))!;
    expect(screen.queryByText('getUser')).not.toBeInTheDocument();
    fireEvent.click(service);
    expect(props.onSelectEntity).toHaveBeenCalledWith(expect.objectContaining({ key: 'Users' }));
    expect(screen.getByText('getUser')).toBeInTheDocument();
  });

  it('filters entities, keeping matches plus their ancestors, with a count', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('export-manifest-filter'), {
      target: { value: 'getUser' },
    });
    const rows = screen.getAllByTestId('export-manifest-entity');
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('getUser'), expect.stringContaining('Users')]),
    );
    expect(rows.some((row) => row.textContent?.includes('user/signedup'))).toBe(false);
    expect(screen.getByTestId('export-manifest-filter-count')).toHaveTextContent('2 of 4');
  });
});

describe('ExportManifestPanel — loading, error, truncation', () => {
  it('shows the loading state before any entities arrive', () => {
    renderPanel({ page: null, entities: [], loading: true, complete: false });
    expect(screen.getByTestId('export-manifest-loading')).toBeInTheDocument();
  });

  it('states a transport error', () => {
    renderPanel({ page: null, entities: [], error: 'Could not load the artifact manifest.' });
    expect(screen.getByTestId('export-manifest-error')).toHaveTextContent(
      'Could not load the artifact manifest.',
    );
  });

  it('declares truncation with the loaded-of-total counts and a load-more path', () => {
    const onLoadMore = jest.fn();
    const page = { ...pageFor(baseEntities), total_entities: 5000, next_cursor: 'cursor', truncated: true };
    renderPanel({ page, complete: false, onLoadMore });
    const banner = screen.getByTestId('export-manifest-truncation');
    expect(banner).toHaveTextContent('Showing 4 of 5,000 entities');
    fireEvent.click(screen.getByTestId('export-manifest-load-all'));
    expect(onLoadMore).toHaveBeenCalled();
  });
});

describe('ExportManifestPanel — windowing above the budget', () => {
  /** Enough types to exceed the virtualization budget with sections included. */
  const manyEntities: ExportManifestEntity[] = Array.from({ length: 400 }, (_, index) =>
    entity({ key: `Type${index}`, name: `Type${index}`, entity_kind: 'type', order: index }),
  );

  it('mounts a bounded row window with spacers, keeping the DOM small', () => {
    renderPanel({
      page: pageFor(manyEntities),
      entities: manyEntities,
      viewportHeight: 160,
    });
    expect(screen.getByText('windowed')).toBeInTheDocument();
    const mounted = screen.getAllByTestId('export-manifest-entity');
    expect(mounted.length).toBeLessThan(EXPORT_MANIFEST_TREE_VIRTUALIZE_ABOVE);
    expect(mounted.length).toBeGreaterThan(0);
  });

  it('pins the focused row so windowing never drops the tab stop', () => {
    renderPanel({
      page: pageFor(manyEntities),
      entities: manyEntities,
      viewportHeight: 160,
      selectedKey: 'Type0',
    });
    const tree = screen.getByRole('tree');
    const scroller = tree.parentElement!;
    // Scroll far past the focused row — it must stay mounted (pinned absolutely).
    act(() => {
      fireEvent.scroll(scroller, { target: { scrollTop: 8000 } });
    });
    const rows = screen.getAllByTestId('export-manifest-entity');
    const pinned = rows.find((row) => row.getAttribute('data-entity-key') === 'Type0');
    expect(pinned).toBeDefined();
    expect(pinned!.closest('li')).toHaveStyle({ position: 'absolute' });
  });
});

describe('ExportManifestPanel — keyboard contract', () => {
  function treeEl() {
    return screen.getByRole('tree').parentElement!;
  }

  it('moves the selection with ArrowDown and reports entities through onSelectEntity', () => {
    const { props } = renderPanel({ selectedKey: 'Users' });
    fireEvent.keyDown(treeEl(), { key: 'ArrowDown' });
    // Users (index 1) → Channels section (index 2) → no entity callback for sections…
    fireEvent.keyDown(treeEl(), { key: 'ArrowDown' });
    // …then the channel row.
    expect(props.onSelectEntity).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'user/signedup' }),
    );
  });

  it('expands with ArrowRight and collapses with ArrowLeft', () => {
    renderPanel({ selectedKey: 'Users' });
    expect(screen.queryByText('getUser')).not.toBeInTheDocument();
    fireEvent.keyDown(treeEl(), { key: 'ArrowRight' });
    expect(screen.getByText('getUser')).toBeInTheDocument();
    fireEvent.keyDown(treeEl(), { key: 'ArrowLeft' });
    expect(screen.queryByText('getUser')).not.toBeInTheDocument();
  });

  it('jumps with Home/End and type-ahead', () => {
    const { props } = renderPanel({ selectedKey: 'Users' });
    fireEvent.keyDown(treeEl(), { key: 'End' });
    expect(props.onSelectEntity).toHaveBeenCalledWith(expect.objectContaining({ key: 'User' }));
    fireEvent.keyDown(treeEl(), { key: 'u' });
    fireEvent.keyDown(treeEl(), { key: 's' });
    expect(props.onSelectEntity).toHaveBeenCalledWith(expect.objectContaining({ key: 'Users' }));
  });

  it('keeps full ARIA tree semantics on the rows', () => {
    renderPanel();
    const section = screen.getAllByTestId('export-manifest-section')[0];
    expect(section).toHaveAttribute('aria-level', '1');
    expect(section).toHaveAttribute('aria-setsize', '3');
    expect(section).toHaveAttribute('aria-posinset', '1');
    expect(section).toHaveAttribute('aria-expanded', 'true');
    const rows = screen.getAllByRole('treeitem');
    expect(rows.filter((row) => row.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});

describe('ExportManifestPanel — accessibility (jest-axe)', () => {
  it.each([
    ['loaded tree', () => renderPanel({ selectedKey: 'user/signedup' })],
    ['loading', () => renderPanel({ page: null, entities: [], loading: true, complete: false })],
    ['error', () => renderPanel({ page: null, entities: [], error: 'boom' })],
  ])('has no WCAG A/AA violations: %s', async (_label, mount) => {
    const { container } = mount();
    expect(await axe(container)).toHaveNoViolations();
  });
});
