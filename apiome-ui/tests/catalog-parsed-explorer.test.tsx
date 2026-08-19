/**
 * Render/interaction tests for the parsed-model explorer (MFI-28.3, #4119).
 *
 * These pin the explorer behaviors the acceptance criteria call for: a large model renders collapsed
 * and fast (field rows mount lazily on expand), a per-group filter narrows entities live by name/tag,
 * every entity is addressable by its stable anchor id (and a deep-link force-expands it past the
 * filter), and a raw-model toggle swaps the entity list for the group's normalized JSON in the shared
 * read-only Monaco viewer. Monaco is stubbed so the raw view never depends on the real editor loading.
 */

// Stub `@monaco-editor/react` (used by the shared McpJsonViewer) with a prop-echoing component.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, language }: { value?: string; language?: string }) => (
    <div data-testid="mock-monaco" data-language={language}>
      {value}
    </div>
  ),
}));

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  CatalogParsedGroups,
  type CatalogParsedGroup,
} from '../src/app/components/ade/dashboard/catalog/CatalogParsedModel';
import { catalogEntityAnchorId } from '../src/app/utils/catalog-lint-panel';

/** A small mixed model: one filled entity, one field-less entity, one type. */
const GROUPS: CatalogParsedGroup[] = [
  {
    title: 'Operations',
    subtitle: 'root fields',
    entities: [
      {
        name: 'orders',
        tag: 'QUERY',
        meta: '→ [Order]',
        fields: [
          { name: 'status', type: 'OrderStatus', description: 'Lifecycle state', required: false },
          { name: 'id', type: 'ID', description: null, required: true },
        ],
      },
      { name: 'placeOrder', tag: 'MUTATION', meta: '→ PlaceOrderPayload', fields: [] },
    ],
  },
];

/** Build a group of `n` entities, each with `fieldsEach` fields (for the large-model test). */
function bigGroup(n: number, fieldsEach: number): CatalogParsedGroup {
  return {
    title: 'Types',
    subtitle: null,
    entities: Array.from({ length: n }, (_, i) => ({
      name: `Type${i}`,
      tag: 'OBJECT',
      meta: `${fieldsEach} fields`,
      fields: Array.from({ length: fieldsEach }, (_, f) => ({
        name: `field${f}`,
        type: 'String',
        description: null,
        required: false,
      })),
    })),
  };
}

describe('CatalogParsedGroups explorer (MFI-28.3)', () => {
  it('renders the empty note when there is no parsed model', () => {
    render(<CatalogParsedGroups parsed={null} />);
    expect(screen.getByTestId('catalog-detail-parsed-empty')).toBeInTheDocument();
  });

  it('gives every entity a stable anchor id (consumed by lint deep-links)', () => {
    render(<CatalogParsedGroups parsed={GROUPS} />);
    expect(document.getElementById(catalogEntityAnchorId('orders'))).not.toBeNull();
    expect(document.getElementById(catalogEntityAnchorId('placeOrder'))).not.toBeNull();
  });

  it('renders a large model collapsed — no field rows mount until expand', () => {
    render(<CatalogParsedGroups parsed={[bigGroup(200, 3)]} />);
    // 200 entity headers present…
    expect(screen.getAllByTestId('catalog-detail-parsed-entity')).toHaveLength(200);
    // …but zero field rows mounted (all collapsed, lazy).
    expect(screen.queryAllByTestId('catalog-detail-parsed-field')).toHaveLength(0);
  });

  it('mounts an entity’s field rows lazily on first expand', () => {
    render(<CatalogParsedGroups parsed={[bigGroup(50, 2)]} />);
    expect(screen.queryByText('field0')).not.toBeInTheDocument();
    const firstToggle = screen.getAllByTestId('catalog-detail-parsed-entity-toggle')[0];
    fireEvent.click(firstToggle);
    // Its two fields are now mounted and visible.
    expect(screen.getAllByTestId('catalog-detail-parsed-field').length).toBeGreaterThanOrEqual(2);
  });

  it('defaults small entities in a small group open (their fields show immediately)', () => {
    render(<CatalogParsedGroups parsed={GROUPS} />);
    // `orders` has 2 fields in a 2-entity group → open by default.
    expect(screen.getByText('status')).toBeInTheDocument();
    expect(screen.getByText('OrderStatus')).toBeInTheDocument();
  });

  it('renders a field-less entity as a plain header with no toggle', () => {
    render(<CatalogParsedGroups parsed={GROUPS} />);
    const placeOrder = document.getElementById(catalogEntityAnchorId('placeOrder'))!;
    expect(within(placeOrder).queryByTestId('catalog-detail-parsed-entity-toggle')).toBeNull();
    expect(placeOrder).toHaveTextContent('placeOrder');
  });

  it('filters entities live by name and shows a match count', () => {
    render(<CatalogParsedGroups parsed={GROUPS} />);
    const filter = screen.getByTestId('catalog-detail-parsed-filter');
    fireEvent.change(filter, { target: { value: 'placeOrder' } });
    // Only the matching entity remains.
    const entities = screen.getAllByTestId('catalog-detail-parsed-entity');
    expect(entities).toHaveLength(1);
    expect(entities[0]).toHaveTextContent('placeOrder');
    expect(screen.getByTestId('catalog-detail-parsed-filter-count')).toHaveTextContent('1 of 2');
  });

  it('filters by tag and shows a no-matches note when nothing matches', () => {
    render(<CatalogParsedGroups parsed={GROUPS} />);
    const filter = screen.getByTestId('catalog-detail-parsed-filter');
    fireEvent.change(filter, { target: { value: 'mutation' } });
    expect(screen.getAllByTestId('catalog-detail-parsed-entity')).toHaveLength(1);
    fireEvent.change(filter, { target: { value: 'zzz-nothing' } });
    expect(screen.queryAllByTestId('catalog-detail-parsed-entity')).toHaveLength(0);
    expect(screen.getByTestId('catalog-detail-parsed-no-matches')).toBeInTheDocument();
  });

  it('clears the filter with the clear button', () => {
    render(<CatalogParsedGroups parsed={GROUPS} />);
    const filter = screen.getByTestId('catalog-detail-parsed-filter') as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'orders' } });
    expect(screen.getAllByTestId('catalog-detail-parsed-entity')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('catalog-detail-parsed-filter-clear'));
    expect(filter.value).toBe('');
    expect(screen.getAllByTestId('catalog-detail-parsed-entity')).toHaveLength(2);
  });

  it('keeps a deep-linked entity visible even when the filter would hide it', () => {
    const highlighted = catalogEntityAnchorId('placeOrder');
    render(<CatalogParsedGroups parsed={GROUPS} highlightedAnchor={highlighted} />);
    // Filter to a term that excludes placeOrder…
    fireEvent.change(screen.getByTestId('catalog-detail-parsed-filter'), {
      target: { value: 'orders' },
    });
    // …the deep-linked entity is pinned in anyway, with its highlight ring.
    const placeOrder = document.getElementById(highlighted)!;
    expect(placeOrder).toBeInTheDocument();
    // HIVE-7.2: the highlight is `.cid-entity[data-highlighted]`, one attribute rather than
    // six palette classes and their dark twins.
    expect(placeOrder.getAttribute('data-highlighted')).toBe('true');
  });

  it('force-expands a deep-linked entity so its fields are visible', () => {
    render(<CatalogParsedGroups parsed={[bigGroup(50, 2)]} highlightedAnchor={catalogEntityAnchorId('Type7')} />);
    const target = document.getElementById(catalogEntityAnchorId('Type7'))!;
    // Type7 lives in a large group (collapsed by default) but the deep-link forces it open.
    expect(within(target).getAllByTestId('catalog-detail-parsed-field').length).toBeGreaterThan(0);
  });

  it('toggles the raw model into the shared read-only viewer and back', async () => {
    render(<CatalogParsedGroups parsed={GROUPS} />);
    expect(screen.queryByTestId('catalog-detail-parsed-raw')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('catalog-detail-parsed-raw-toggle'));
    const raw = screen.getByTestId('catalog-detail-parsed-raw');
    expect(raw).toBeInTheDocument();
    // The viewer (loaded via next/dynamic) carries the group's normalized JSON (entity names present).
    const monaco = await within(raw).findByTestId('mock-monaco');
    expect(monaco).toHaveTextContent('orders');
    expect(monaco).toHaveTextContent('placeOrder');
    // The entity list is hidden while the raw model shows.
    expect(screen.queryAllByTestId('catalog-detail-parsed-entity')).toHaveLength(0);
    // Toggling back restores the entities.
    fireEvent.click(screen.getByTestId('catalog-detail-parsed-raw-toggle'));
    expect(screen.queryByTestId('catalog-detail-parsed-raw')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('catalog-detail-parsed-entity')).toHaveLength(2);
  });
});
