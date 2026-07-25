/**
 * CatalogImportPreviewPanel — the quality step's structural entity explorer (IXH-3.2, #5104).
 *
 * Covers the acceptance criteria on the panel itself:
 *  1. **lazy fetch** — exactly one manifest request on mount (mounting *is* reaching the step),
 *     aborted on unmount;
 *  2. **summary header** — format, paradigm, routing target, entity counts, and grade;
 *  3. **ARIA tree** — role="tree", levels, set sizes, expansion only on parents, roving tabindex,
 *     arrow-key navigation, and type-ahead;
 *  4. **coverage** — a badge per node, the four classes never conflated, and the legend;
 *  5. **source links** — a located entity drives the step's raw viewer; an unlocated one offers no
 *     link;
 *  6. **windowing** — 200 rows with a small viewport mount only a window, scrolling shifts it, and
 *     the focused row stays mounted (pinned) when scrolled out;
 *  7. **truncation** — the banner states loaded-of-total and "Load all" walks the cursor pages;
 *  8. **degradation** — `ok: false` explains itself; a transport failure offers retry.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest, afterEach } from '@jest/globals';

import { CatalogImportPreviewPanel } from '../src/app/components/ade/dashboard/catalog/CatalogImportPreviewPanel';
import type { PreflightReport } from '../src/app/utils/import-preflight';
import type {
  ImportPreviewEntity,
  ImportPreviewManifest,
  ImportPreviewManifestResponse,
} from '../src/app/utils/import-preview-manifest';

function buildPreflight(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    ok: true,
    detection: { adapter_key: 'graphql', detected_format: 'graphql', matched: true, importable: true },
    format: 'graphql',
    paradigm: 'graphql',
    routing: { target: 'catalog' },
    counts: { services: 1, operations: 2, channels: 1, types: 2 },
    lint: { score: 88, grade: 'B' },
    policy: { verdict: 'pass', blocking: false, source: 'default', reason: 'Advisory only.' },
    ...overrides,
  };
}

function entity(overrides: Partial<ImportPreviewEntity> & { key: string }): ImportPreviewEntity {
  return {
    name: overrides.key,
    entity_kind: 'type',
    parent_key: null,
    order: 0,
    deprecated: false,
    coverage: 'mapped',
    unmodeled_extras: [],
    ...overrides,
  };
}

/** A service (located line 3) with two operations, a channel, and two types. */
function fixtureEntities(): ImportPreviewEntity[] {
  return [
    entity({ key: 'svc:pets', name: 'PetService', entity_kind: 'service', order: 0, source_location: '3:1' }),
    entity({ key: 'op:listPets', name: 'listPets', entity_kind: 'operation', parent_key: 'svc:pets', order: 1, source_location: '7:3' }),
    entity({ key: 'op:getPet', name: 'getPet', entity_kind: 'operation', parent_key: 'svc:pets', order: 2, coverage: 'not-parsed-by-adapter' }),
    entity({ key: 'ch:petEvents', name: 'petEvents', entity_kind: 'channel', order: 3, coverage: 'unsupported-by-canonical-model' }),
    entity({ key: 'type:Pet', name: 'Pet', entity_kind: 'type', order: 4, coverage: 'partially-mapped', unmodeled_extras: ['x-internal'], native_name: 'PetV2' }),
    entity({ key: 'type:Owner', name: 'Owner', entity_kind: 'type', order: 5, deprecated: true }),
  ];
}

function buildManifest(overrides: Partial<ImportPreviewManifest> = {}): ImportPreviewManifest {
  return {
    manifest_hash: 'hash-1',
    adapter: {
      adapter_key: 'graphql',
      adapter_label: 'GraphQL SDL',
      paradigm: 'graphql',
      formats: ['graphql'],
      capability: { format: 'graphql', mode: 'native', importable: true, related_issues: [] },
      parser_limits: [],
    },
    counts: { services: 1, operations: 2, channels: 1, types: 2 },
    coverage_counts: { mapped: 2, 'partially-mapped': 1, 'unsupported-by-canonical-model': 1, 'not-parsed-by-adapter': 1 },
    status_counts: {},
    reason_counts: {},
    entities: fixtureEntities(),
    total_entities: 6,
    nodes: [],
    edges: [],
    coverage: [
      {
        source_construct: 'Pet',
        coverage: 'partially-mapped',
        status: 'approximated',
        detail: 'x-internal is not carried by the canonical model.',
        entity_key: 'type:Pet',
        document_scoped: false,
      },
    ],
    total_coverage_entries: 1,
    page_size: 1000,
    next_cursor: null,
    truncated: false,
    ...overrides,
  };
}

function buildResponse(
  manifest: ImportPreviewManifest | null = buildManifest(),
  preflight: PreflightReport = buildPreflight(),
): ImportPreviewManifestResponse {
  return { ok: manifest !== null, preflight, manifest };
}

/** Stub the manifest endpoint; `handler` maps each request body to its response payload. */
function mockManifestFetch(
  handler: (body: Record<string, unknown>) => ImportPreviewManifestResponse | { failWith: string },
): jest.Mock {
  const fn = jest.fn((_url: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    const payload = handler(body);
    if ('failWith' in payload) {
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ success: false, error: payload.failWith }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...payload }) });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

async function renderPanel(
  props: Partial<React.ComponentProps<typeof CatalogImportPreviewPanel>> = {},
): Promise<jest.Mock> {
  const onSelectSourceLine = jest.fn();
  render(
    <CatalogImportPreviewPanel
      request={{ document_base64: 'dHlwZSBRdWVyeQ==', import_target: 'catalog' }}
      rawSourceAvailable
      rawLineCount={600}
      onSelectSourceLine={onSelectSourceLine as unknown as (line: number) => void}
      {...props}
    />,
  );
  await waitFor(() =>
    expect(screen.queryByTestId('import-preview-loading')).not.toBeInTheDocument(),
  );
  return onSelectSourceLine;
}

const tree = () => screen.getByRole('tree', { name: /entities this import would add/i });
const treeContainer = () => tree().parentElement as HTMLElement;
const itemByName = (name: RegExp) => screen.getByRole('treeitem', { name });

describe('CatalogImportPreviewPanel — lazy fetch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requests the manifest exactly once on mount, at the maximum page size, without a cursor', async () => {
    const fetchMock = mockManifestFetch(() => buildResponse());
    await renderPanel();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/import/preview-manifest');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toMatchObject({ document_base64: 'dHlwZSBRdWVyeQ==', page_size: 1000 });
    expect(body.cursor).toBeUndefined();
  });

  it('aborts the in-flight request on unmount', async () => {
    let signal: AbortSignal | undefined;
    global.fetch = jest.fn((_url: unknown, init?: unknown) => {
      signal = (init as RequestInit).signal ?? undefined;
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    const { unmount } = render(
      <CatalogImportPreviewPanel
        request={{ document_base64: 'abc' }}
        rawSourceAvailable
        rawLineCount={10}
        onSelectSourceLine={jest.fn() as unknown as (line: number) => void}
      />,
    );
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe('CatalogImportPreviewPanel — summary header', () => {
  afterEach(() => jest.restoreAllMocks());

  it('states format, paradigm, routing target, entity counts, grade, and the adapter', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    const summary = screen.getByTestId('import-preview-summary');
    expect(summary).toHaveTextContent(/Format\s*graphql/);
    expect(summary).toHaveTextContent(/Paradigm\s*graphql/);
    expect(summary).toHaveTextContent(/Routes to\s*catalog/);
    expect(summary).toHaveTextContent('Grade B');
    expect(summary).toHaveTextContent('via GraphQL SDL');
    const counts = within(summary).getByTestId('import-preview-counts');
    expect(counts).toHaveTextContent(/1\s*services/);
    expect(counts).toHaveTextContent(/2\s*operations/);
    expect(counts).toHaveTextContent(/1\s*channels/);
    expect(counts).toHaveTextContent(/2\s*types/);
  });

  it('shows the coverage legend with the full-manifest tallies', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    const legend = screen.getByTestId('import-preview-legend');
    const badges = within(legend).getAllByTestId('import-preview-coverage');
    expect(badges.map((b) => b.getAttribute('data-coverage'))).toEqual([
      'mapped',
      'partially-mapped',
      'unsupported-by-canonical-model',
      'not-parsed-by-adapter',
    ]);
    expect(legend).toHaveTextContent('Not in canonical model');
    expect(legend).toHaveTextContent('Not parsed by adapter');
  });
});

describe('CatalogImportPreviewPanel — ARIA tree semantics', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renders a tree of treeitems with levels, set sizes, and expansion only on parents', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    expect(tree()).toBeInTheDocument();

    const sections = screen.getAllByTestId('import-preview-section');
    expect(sections.map((s) => s.textContent)).toEqual([
      expect.stringContaining('Services'),
      expect.stringContaining('Channels'),
      expect.stringContaining('Types'),
    ]);
    for (const section of sections) {
      expect(section).toHaveAttribute('role', 'treeitem');
      expect(section).toHaveAttribute('aria-level', '1');
      expect(section).toHaveAttribute('aria-setsize', '3');
    }

    const service = itemByName(/PetService/);
    expect(service).toHaveAttribute('aria-level', '2');
    expect(service).toHaveAttribute('aria-expanded', 'false');

    // A leaf never carries aria-expanded.
    const leaf = itemByName(/petEvents/);
    expect(leaf).not.toHaveAttribute('aria-expanded');
    expect(leaf).toHaveAttribute('aria-level', '2');
  });

  it('roves a single tabindex and moves it with the arrow keys, Home, and End', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();

    const items = () => screen.getAllByRole('treeitem');
    const tabStops = () => items().filter((item) => item.tabIndex === 0);
    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0]).toHaveTextContent('Services');

    fireEvent.keyDown(treeContainer(), { key: 'ArrowDown' });
    await waitFor(() => expect(tabStops()[0]).toHaveTextContent('PetService'));
    expect(tabStops()).toHaveLength(1);

    fireEvent.keyDown(treeContainer(), { key: 'End' });
    await waitFor(() => expect(tabStops()[0]).toHaveTextContent('Owner'));
    fireEvent.keyDown(treeContainer(), { key: 'Home' });
    await waitFor(() => expect(tabStops()[0]).toHaveTextContent('Services'));
    fireEvent.keyDown(treeContainer(), { key: 'ArrowUp' });
    expect(tabStops()[0]).toHaveTextContent('Services'); // clamped at the top
  });

  it('expands with ArrowRight, descends into children, and ascends/collapses with ArrowLeft', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();

    // Services section is expanded: ArrowRight moves to its first child.
    fireEvent.keyDown(treeContainer(), { key: 'ArrowRight' });
    await waitFor(() => expect(itemByName(/PetService/).tabIndex).toBe(0));

    // Collapsed service: ArrowRight expands it, revealing operations at depth 3.
    fireEvent.keyDown(treeContainer(), { key: 'ArrowRight' });
    await waitFor(() => expect(itemByName(/PetService/)).toHaveAttribute('aria-expanded', 'true'));
    const op = itemByName(/listPets/);
    expect(op).toHaveAttribute('aria-level', '3');
    expect(op).toHaveAttribute('aria-setsize', '2');
    expect(op).toHaveAttribute('aria-posinset', '1');

    // Expanded service: ArrowRight descends to the first operation.
    fireEvent.keyDown(treeContainer(), { key: 'ArrowRight' });
    await waitFor(() => expect(itemByName(/listPets/).tabIndex).toBe(0));

    // Leaf: ArrowLeft ascends to the parent service.
    fireEvent.keyDown(treeContainer(), { key: 'ArrowLeft' });
    await waitFor(() => expect(itemByName(/PetService/).tabIndex).toBe(0));

    // Expanded parent: ArrowLeft collapses it, hiding the operations again.
    fireEvent.keyDown(treeContainer(), { key: 'ArrowLeft' });
    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: /listPets/ })).not.toBeInTheDocument(),
    );
  });

  it('jumps focus by type-ahead on printable characters', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    fireEvent.keyDown(treeContainer(), { key: 'o' });
    await waitFor(() => expect(itemByName(/Owner/).tabIndex).toBe(0));
  });
});

describe('CatalogImportPreviewPanel — coverage and provenance', () => {
  afterEach(() => jest.restoreAllMocks());

  it('badges every entity with its coverage class', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    const badgeOf = (name: RegExp) =>
      within(itemByName(name)).getByTestId('import-preview-coverage');
    expect(badgeOf(/PetService/)).toHaveTextContent('Mapped');
    expect(badgeOf(/petEvents/)).toHaveTextContent('Not in canonical model');
    expect(badgeOf(/Pet\b/)).toHaveTextContent('Partially mapped');
  });

  it('shows the selected entity’s provenance: source name, unmodeled facets, ledger detail', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    fireEvent.click(itemByName(/Pet\b/));
    const provenance = await screen.findByTestId('import-preview-provenance');
    expect(provenance).toHaveTextContent('PetV2');
    expect(provenance).toHaveTextContent('x-internal');
    expect(provenance).toHaveTextContent('x-internal is not carried by the canonical model.');
  });

  it('marks deprecated entities', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    expect(itemByName(/Owner/)).toHaveTextContent('deprecated');
  });
});

describe('CatalogImportPreviewPanel — source-location links', () => {
  afterEach(() => jest.restoreAllMocks());

  it('links a located entity into the raw viewer on click', async () => {
    mockManifestFetch(() => buildResponse());
    const onSelectSourceLine = await renderPanel();
    const link = within(itemByName(/PetService/)).getByTestId('import-preview-source-link');
    expect(link).toHaveTextContent('3:1');
    fireEvent.click(link);
    expect(onSelectSourceLine).toHaveBeenCalledWith(3);
  });

  it('follows the link on Enter too', async () => {
    mockManifestFetch(() => buildResponse());
    const onSelectSourceLine = await renderPanel();
    fireEvent.keyDown(treeContainer(), { key: 'ArrowDown' }); // → PetService
    fireEvent.keyDown(treeContainer(), { key: 'Enter' });
    expect(onSelectSourceLine).toHaveBeenCalledWith(3);
  });

  it('offers no link when the entity has no location or the source cannot show it', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel({ rawLineCount: 2 }); // every location is past the end
    expect(screen.queryAllByTestId('import-preview-source-link')).toHaveLength(0);
    // The location is still stated as plain text provenance.
    expect(itemByName(/PetService/)).toHaveTextContent('3:1');
  });
});

describe('CatalogImportPreviewPanel — filter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('narrows the tree to matches plus ancestors and counts them', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    fireEvent.change(screen.getByTestId('import-preview-filter'), {
      target: { value: 'listPets' },
    });
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(3));
    expect(itemByName(/listPets/)).toBeInTheDocument();
    expect(itemByName(/PetService/)).toBeInTheDocument(); // ancestor stays visible
    expect(screen.getByTestId('import-preview-filter-count')).toHaveTextContent('2 of 6');

    fireEvent.click(screen.getByTestId('import-preview-filter-clear'));
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(7));
  });

  it('says so when nothing matches', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    fireEvent.change(screen.getByTestId('import-preview-filter'), { target: { value: 'zzz' } });
    await waitFor(() =>
      expect(screen.getByTestId('import-preview-no-matches')).toHaveTextContent('zzz'),
    );
  });
});

describe('CatalogImportPreviewPanel — windowing', () => {
  afterEach(() => jest.restoreAllMocks());

  /** 200 types under one section — 201 tree rows, far above the windowing threshold. */
  function manyResponse(): ImportPreviewManifestResponse {
    const entities = Array.from({ length: 200 }, (_, i) =>
      entity({ key: `type:T${i}`, name: `Type${i}`, order: i }),
    );
    return buildResponse(
      buildManifest({ entities, counts: { types: 200 }, total_entities: 200 }),
    );
  }

  it('mounts only a window of rows for a small viewport, and scrolling shifts it', async () => {
    mockManifestFetch(manyResponse);
    await renderPanel({ viewportHeight: 160 });

    // 201 rows exist; only the window (viewport + overscan) is mounted.
    const mounted = screen.getAllByRole('treeitem');
    expect(mounted.length).toBeLessThan(30);
    expect(screen.getByText('Type0')).toBeInTheDocument();
    expect(screen.queryByText('Type150')).not.toBeInTheDocument();

    fireEvent.scroll(treeContainer(), { target: { scrollTop: 150 * 32 } });
    await waitFor(() => expect(screen.getByText('Type150')).toBeInTheDocument());
    expect(screen.queryByText('Type50')).not.toBeInTheDocument();
  });

  it('keeps the focused row mounted (pinned) when it scrolls out of the window', async () => {
    mockManifestFetch(manyResponse);
    await renderPanel({ viewportHeight: 160 });

    // The roving tabindex starts on the Types section row (index 0).
    expect(screen.getByTestId('import-preview-section')).toHaveTextContent('Types');
    fireEvent.scroll(treeContainer(), { target: { scrollTop: 150 * 32 } });
    await waitFor(() => expect(screen.getByText('Type150')).toBeInTheDocument());

    // The section row is far outside the window, yet still mounted and still the tab stop.
    const section = screen.getByTestId('import-preview-section');
    expect(section).toBeInTheDocument();
    expect(section.tabIndex).toBe(0);
  });
});

describe('CatalogImportPreviewPanel — truncation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('states loaded-of-total and loads the remaining pages on demand', async () => {
    const all = fixtureEntities();
    const fetchMock = mockManifestFetch((body) =>
      body.cursor === 'c2'
        ? buildResponse(
            buildManifest({ entities: all.slice(3), next_cursor: null, truncated: true }),
          )
        : buildResponse(
            buildManifest({ entities: all.slice(0, 3), next_cursor: 'c2', truncated: true }),
          ),
    );
    await renderPanel();

    const banner = screen.getByTestId('import-preview-truncation');
    expect(banner).toHaveTextContent('Showing 3 of 6 entities');
    expect(banner).toHaveTextContent('truncated');

    fireEvent.click(screen.getByTestId('import-preview-load-all'));
    await waitFor(() =>
      expect(screen.queryByTestId('import-preview-truncation')).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(secondBody.cursor).toBe('c2');
    // The late pages' entities joined the tree.
    expect(itemByName(/Owner/)).toBeInTheDocument();
  });

  it('shows no banner when the manifest is complete', async () => {
    mockManifestFetch(() => buildResponse());
    await renderPanel();
    expect(screen.queryByTestId('import-preview-truncation')).not.toBeInTheDocument();
  });
});

describe('CatalogImportPreviewPanel — degradation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('explains an unpreviewable candidate (ok: false) without a tree', async () => {
    mockManifestFetch(() =>
      buildResponse(
        null,
        buildPreflight({
          ok: false,
          error: {
            code: 'FORMAT_UNRECOGNIZED',
            category: 'format',
            message: 'No importer recognized this document.',
            remediation: 'Pick the format explicitly.',
            retriable: false,
          },
        }),
      ),
    );
    await renderPanel();
    expect(screen.getByTestId('import-preview-unavailable')).toHaveTextContent(
      'No importer recognized this document.',
    );
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('offers retry after a transport failure, and recovers', async () => {
    let calls = 0;
    mockManifestFetch(() => {
      calls += 1;
      return calls === 1 ? { failWith: 'The preview service is unavailable.' } : buildResponse();
    });
    await renderPanel();
    expect(screen.getByTestId('import-preview-error')).toHaveTextContent(
      'The preview service is unavailable.',
    );

    fireEvent.click(screen.getByTestId('import-preview-retry'));
    await waitFor(() => expect(screen.getByTestId('import-preview-summary')).toBeInTheDocument());
    expect(screen.queryByTestId('import-preview-error')).not.toBeInTheDocument();
  });
});
