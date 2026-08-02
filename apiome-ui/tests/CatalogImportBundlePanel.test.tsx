/**
 * Bundle file explorer panel — integration UI (IXH-3.5, #5107).
 *
 * Renders `CatalogImportBundlePanel` against a stubbed `/api/import/bundle-inventory` and pins the
 * ticket's acceptance criteria as they reach the user:
 *
 *  1. **Every file appears with a role and a verdict**, and an ignored file *states why*.
 *  2. **Unresolved imports are listed with the search paths that were tried.**
 *  3. **The entry point can be re-selected**, which hands the chosen member back to the wizard so
 *     the pre-flight re-runs — and a bundle whose root could not be resolved says so while still
 *     listing every file.
 *  4. **Per-file contribution to canonical entities is inspectable**, labelled with the server's
 *     attribution method rather than presented as parser provenance.
 *  5. **A few hundred files do not block**: above the budget the tree is windowed, and a truncated
 *     inventory states it and offers the path to the full data.
 *  6. **Keyboard operation**: one Tab stop, arrow movement, and expand/collapse on a real
 *     `role="tree"`.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { describe, expect, it, jest, afterEach } from '@jest/globals';

import { CatalogImportBundlePanel } from '../src/app/components/ade/dashboard/catalog/CatalogImportBundlePanel';
import type {
  BundleFileEntry,
  BundleImportEdge,
  ImportBundleInventory,
} from '../src/app/utils/import-bundle-inventory';

const REQUEST = { document_base64: 'zip-bytes', filename: 'bundle.zip', input_kind: 'fileset' as const };

function file(path: string, overrides: Partial<BundleFileEntry> = {}): BundleFileEntry {
  return {
    path,
    role: 'unreferenced',
    verdict: 'analysed',
    bytes: 512,
    lines: 20,
    ignored_reason: null,
    error: null,
    imports: [],
    imported_by: [],
    entity_keys: [],
    entity_count: 0,
    ...overrides,
  };
}

const UNRESOLVED: BundleImportEdge = {
  from_path: 'proto/user/user.proto',
  directive: 'import',
  target: 'missing/gone.proto',
  to_path: null,
  resolution: 'unresolved',
  provider: null,
  search_paths: ['proto/user/missing/gone.proto', 'proto/missing/gone.proto', 'missing/gone.proto'],
  line: 4,
};

const RESOLVED: BundleImportEdge = {
  from_path: 'proto/user/user.proto',
  directive: 'import',
  target: 'user/types.proto',
  to_path: 'proto/user/types.proto',
  resolution: 'member',
  provider: null,
  search_paths: ['proto/user/user/types.proto', 'proto/user/types.proto'],
  line: 3,
};

const PROVIDED: BundleImportEdge = {
  from_path: 'proto/user/user.proto',
  directive: 'import',
  target: 'google/protobuf/timestamp.proto',
  to_path: null,
  resolution: 'provided',
  provider: 'protobuf well-known types',
  search_paths: ['proto/user/google/protobuf/timestamp.proto'],
  line: 5,
};

const FILES: BundleFileEntry[] = [
  file('__MACOSX/._user.proto', {
    role: 'ignored',
    verdict: 'not-analysed',
    ignored_reason: 'resource-fork',
    bytes: 0,
    lines: 0,
  }),
  file('proto/user/types.proto', {
    role: 'dependency',
    imported_by: ['proto/user/user.proto'],
    entity_count: 2,
    entity_keys: ['user.User', 'user.GetUserRequest'],
  }),
  file('proto/user/user.proto', {
    role: 'entry-point',
    imports: [RESOLVED, PROVIDED, UNRESOLVED],
    entity_count: 1,
    entity_keys: ['user.UserService'],
  }),
  file('vendor/logo.png', {
    role: 'unreadable',
    verdict: 'not-analysed',
    error: 'Binary file type — not specification text, so it was not analysed.',
  }),
];

function inventory(overrides: Partial<ImportBundleInventory> = {}): ImportBundleInventory {
  return {
    entry_point: 'proto/user/user.proto',
    entry_point_pinned: false,
    entry_point_error: null,
    entry_point_candidates: [
      { path: 'proto/user/user.proto', format: 'protobuf', confidence: 0.97, selected: true },
      { path: 'proto/user/types.proto', format: 'protobuf', confidence: 0.9, selected: false },
    ],
    attribution: 'declaration-scan',
    files: FILES,
    total_files: FILES.length,
    role_counts: { 'entry-point': 1, dependency: 1, unreferenced: 0, ignored: 1, unreadable: 1 },
    verdict_counts: { analysed: 2, failed: 0, 'not-analysed': 2 },
    unresolved: [UNRESOLVED],
    total_unresolved: 1,
    total_edges: 3,
    total_entities: 3,
    unattributed_entities: 0,
    page_size: 1000,
    next_cursor: null,
    truncated: false,
    ...overrides,
  };
}

interface MockShape {
  ok?: boolean;
  kind?: string;
  inventory?: ImportBundleInventory | null;
  error?: Record<string, unknown> | null;
  /** Cursor → the page returned for it, for the page-walk test. */
  pages?: Record<string, ImportBundleInventory>;
  failWith?: string;
}

function mockEndpoint(shape: MockShape): jest.Mock {
  const mock = jest.fn((_url: unknown, init?: unknown) => {
    if (shape.failWith) {
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ success: false, error: shape.failWith }),
      });
    }
    const body = JSON.parse(String((init as { body?: string })?.body ?? '{}')) as {
      cursor?: string;
    };
    const page = body.cursor ? shape.pages?.[body.cursor] : undefined;
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          ok: shape.ok ?? true,
          kind: shape.kind ?? 'archive',
          inventory: page ?? (shape.inventory === undefined ? inventory() : shape.inventory),
          error: shape.error ?? null,
        }),
    });
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

async function renderPanel(shape: MockShape = {}, props: Record<string, unknown> = {}) {
  mockEndpoint(shape);
  const view = render(<CatalogImportBundlePanel request={REQUEST} {...props} />);
  await waitFor(() => expect(screen.queryByTestId('bundle-loading')).not.toBeInTheDocument());
  return view;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('every file appears with a role and a verdict', () => {
  it('lists every file in the bundle, each carrying a role badge', async () => {
    await renderPanel();

    const rows = screen.getAllByTestId('bundle-file');
    // Directory order, mirroring the archive's own layout: directories alphabetically, each with
    // its files, and root-level files last.
    expect(rows.map((row) => row.getAttribute('data-path'))).toEqual([
      '__MACOSX/._user.proto',
      'proto/user/types.proto',
      'proto/user/user.proto',
      'vendor/logo.png',
    ]);
    for (const row of rows) {
      expect(within(row).getByTestId('bundle-role')).toBeInTheDocument();
    }
  });

  it('tallies every role in the legend, including the empty ones', async () => {
    await renderPanel();

    const legend = screen.getByTestId('bundle-legend');
    const roles = within(legend)
      .getAllByTestId('bundle-role')
      .map((badge) => badge.getAttribute('data-role'));
    expect(roles).toEqual([
      'entry-point',
      'dependency',
      'unreferenced',
      'ignored',
      'unreadable',
    ]);
    expect(legend).toHaveTextContent('1Entry point');
  });

  it('states why an ignored file was ignored', async () => {
    await renderPanel();

    fireEvent.click(
      screen.getAllByTestId('bundle-file').find((row) => row.dataset.path?.includes('__MACOSX'))!,
    );

    expect(screen.getByTestId('bundle-ignored-reason')).toHaveTextContent(
      'macOS resource fork (__MACOSX)',
    );
  });

  it('shows an unreadable file’s reason as its error', async () => {
    await renderPanel();

    fireEvent.click(
      screen.getAllByTestId('bundle-file').find((row) => row.dataset.path === 'vendor/logo.png')!,
    );

    expect(screen.getByTestId('bundle-file-error')).toHaveTextContent('Binary file type');
  });

  it('marks the file a parse diagnostic names as failed', async () => {
    await renderPanel({
      inventory: inventory({
        files: [
          file('a.proto', { role: 'entry-point' }),
          file('b.proto', { verdict: 'failed', error: 'b.proto:4:1: syntax error' }),
        ],
        verdict_counts: { analysed: 1, failed: 1, 'not-analysed': 0 },
      }),
    });

    expect(screen.getByTestId('bundle-verdict-failed')).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByTestId('bundle-file').find((row) => row.dataset.path === 'b.proto')!,
    );
    expect(screen.getByTestId('bundle-file-error')).toHaveTextContent('syntax error');
  });
});

describe('unresolved imports name the search paths tried', () => {
  it('lists every unresolved reference with where it looked', async () => {
    await renderPanel();

    const panel = screen.getByTestId('bundle-unresolved');
    expect(panel).toHaveTextContent('missing/gone.proto');
    expect(within(panel).getByTestId('bundle-unresolved-search-paths')).toHaveTextContent(
      'proto/user/missing/gone.proto · proto/missing/gone.proto · missing/gone.proto',
    );
  });

  it('renders no unresolved section for a bundle that resolves cleanly', async () => {
    await renderPanel({ inventory: inventory({ unresolved: [], total_unresolved: 0 }) });

    expect(screen.queryByTestId('bundle-unresolved')).not.toBeInTheDocument();
  });

  it('distinguishes resolved, toolchain-provided, and unresolved on the selected file', async () => {
    await renderPanel();

    fireEvent.click(
      screen
        .getAllByTestId('bundle-file')
        .find((row) => row.dataset.path === 'proto/user/user.proto')!,
    );

    const edges = screen.getAllByTestId('bundle-import-edge');
    expect(edges.map((edge) => edge.getAttribute('data-resolution'))).toEqual([
      'member',
      'provided',
      'unresolved',
    ]);
    expect(edges[1]).toHaveTextContent('protobuf well-known types');
    expect(within(edges[2]).getByTestId('bundle-search-paths')).toHaveTextContent('Looked for:');
  });

  it('reveals the importing file from the unresolved list', async () => {
    await renderPanel();

    fireEvent.click(screen.getByTestId('bundle-unresolved-source'));

    expect(screen.getByTestId('bundle-file-detail')).toHaveTextContent('proto/user/user.proto');
  });
});

describe('entry-point override', () => {
  it('offers the ranked candidates with the current selection marked', async () => {
    await renderPanel();

    const select = screen.getByTestId('bundle-entry-point-select') as HTMLSelectElement;
    expect(select.value).toBe('proto/user/user.proto');
    expect([...select.options].map((option) => option.value)).toEqual([
      'proto/user/user.proto',
      'proto/user/types.proto',
    ]);
    expect(screen.getByTestId('bundle-entry-point')).toHaveTextContent('auto-detected');
  });

  it('hands a new entry point back to the wizard so the pre-flight re-runs', async () => {
    const onEntryPointChange = jest.fn();
    await renderPanel({}, { onEntryPointChange });

    fireEvent.change(screen.getByTestId('bundle-entry-point-select'), {
      target: { value: 'proto/user/types.proto' },
    });

    expect(onEntryPointChange).toHaveBeenCalledWith('proto/user/types.proto');
  });

  it('reports a pinned entry point as chosen by the user', async () => {
    await renderPanel({ inventory: inventory({ entry_point_pinned: true }) });

    expect(screen.getByTestId('bundle-entry-point')).toHaveTextContent('chosen by you');
  });

  it('is read-only when the host cannot re-run the pre-flight', async () => {
    await renderPanel();

    expect(screen.getByTestId('bundle-entry-point-select')).toBeDisabled();
  });

  it('explains an unresolvable root while still listing every file', async () => {
    await renderPanel({
      inventory: inventory({
        entry_point: null,
        entry_point_error: 'Archive root is ambiguous — choose a root document explicitly.',
      }),
    });

    expect(screen.getByTestId('bundle-entry-point-error')).toHaveTextContent('ambiguous');
    expect(screen.getAllByTestId('bundle-file')).toHaveLength(FILES.length);
  });
});

describe('per-file entity contribution', () => {
  it('names the entities a file contributes and how attribution was derived', async () => {
    await renderPanel();

    fireEvent.click(
      screen
        .getAllByTestId('bundle-file')
        .find((row) => row.dataset.path === 'proto/user/types.proto')!,
    );

    const detail = screen.getByTestId('bundle-file-detail');
    expect(within(detail).getByTestId('bundle-file-entities')).toHaveTextContent(
      'Contributes 2 canonical entities: user.User, user.GetUserRequest',
    );
    expect(detail).toHaveTextContent('declaration-scan');
    expect(detail).toHaveTextContent('evidence, not a record kept by the parser');
  });

  it('says plainly when no entity was attributed to a file', async () => {
    await renderPanel();

    fireEvent.click(
      screen.getAllByTestId('bundle-file').find((row) => row.dataset.path === 'vendor/logo.png')!,
    );

    expect(screen.getByTestId('bundle-file-entities')).toHaveTextContent(
      'No canonical entity was attributed to this file.',
    );
  });
});

describe('scale and bounds', () => {
  const many = Array.from({ length: 300 }, (_, index) =>
    file(`proto/pkg${String(index).padStart(3, '0')}/service.proto`),
  );

  it('windows the tree above the budget rather than mounting a few hundred rows', async () => {
    await renderPanel(
      { inventory: inventory({ files: many, total_files: many.length, unresolved: [] }) },
      { viewportHeight: 160 },
    );

    expect(screen.getByText('windowed')).toBeInTheDocument();
    const mounted = screen.getAllByTestId('bundle-file').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(many.length);
  });

  it('states truncation and walks the remaining pages on request', async () => {
    const rest = inventory({
      files: [file('proto/pkg300/service.proto')],
      total_files: 301,
      next_cursor: null,
      truncated: false,
      unresolved: [],
    });
    await renderPanel(
      {
        inventory: inventory({
          files: many,
          total_files: 301,
          next_cursor: 'cursor-2',
          truncated: true,
          unresolved: [],
        }),
        pages: { 'cursor-2': rest },
      },
      { viewportHeight: 160 },
    );

    expect(screen.getByTestId('bundle-truncation')).toHaveTextContent(
      'Showing 300 of 301 files — this inventory is truncated.',
    );

    fireEvent.click(screen.getByTestId('bundle-load-all'));

    await waitFor(() =>
      expect(screen.queryByTestId('bundle-truncation')).not.toBeInTheDocument(),
    );
  });

  it('filters the tree down to the matching files', async () => {
    await renderPanel();

    fireEvent.change(screen.getByTestId('bundle-filter'), { target: { value: 'types' } });

    expect(screen.getAllByTestId('bundle-file')).toHaveLength(1);
    expect(screen.getByTestId('bundle-filter-count')).toHaveTextContent('1 of 4');

    fireEvent.click(screen.getByTestId('bundle-filter-clear'));
    expect(screen.getAllByTestId('bundle-file')).toHaveLength(FILES.length);
  });

  it('says so when nothing matches the filter', async () => {
    await renderPanel();

    fireEvent.change(screen.getByTestId('bundle-filter'), { target: { value: 'zzz' } });

    expect(screen.getByTestId('bundle-no-matches')).toBeInTheDocument();
  });
});

describe('keyboard operation', () => {
  it('is one Tab stop with arrow movement and expand/collapse', async () => {
    await renderPanel();

    const tree = screen.getByRole('tree');
    const tabbable = () =>
      within(tree)
        .getAllByRole('treeitem')
        .filter((item) => item.getAttribute('tabindex') === '0');

    expect(tabbable()).toHaveLength(1);

    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    await waitFor(() => expect(tabbable()).toHaveLength(1));

    const directory = screen.getAllByTestId('bundle-directory')[0];
    fireEvent.click(directory);
    await waitFor(() =>
      expect(screen.getAllByTestId('bundle-directory')[0]).toHaveAttribute('aria-expanded', 'false'),
    );
  });

  it('gives the tree ARIA level, setsize, and posinset on every row', async () => {
    await renderPanel();

    for (const item of within(screen.getByRole('tree')).getAllByRole('treeitem')) {
      expect(item).toHaveAttribute('aria-level');
      expect(item).toHaveAttribute('aria-setsize');
      expect(item).toHaveAttribute('aria-posinset');
    }
  });
});

describe('accessibility (IXH-3.6 parity)', () => {
  /** WCAG 2.1 A/AA; contrast and the page-landmark rule need a real page, not a jsdom fragment. */
  const AXE_OPTIONS = {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  } as const;

  it('reports no axe violations with a file selected and the unresolved list mounted', async () => {
    const { container } = await renderPanel();
    fireEvent.click(
      screen
        .getAllByTestId('bundle-file')
        .find((row) => row.dataset.path === 'proto/user/user.proto')!,
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('reports no axe violations while windowed', async () => {
    const many = Array.from({ length: 300 }, (_, index) => file(`pkg${index}/service.proto`));
    const { container } = await renderPanel(
      { inventory: inventory({ files: many, total_files: many.length, unresolved: [] }) },
      { viewportHeight: 160 },
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('guards every motion class with motion-safe (prefers-reduced-motion honoured)', async () => {
    const { container } = await renderPanel();
    fireEvent.click(
      screen
        .getAllByTestId('bundle-file')
        .find((row) => row.dataset.path === 'proto/user/user.proto')!,
    );

    // Movement classes must be motion-safe; colour/opacity/shadow fades are exempt
    // (prefers-reduced-motion targets motion, not fades). Same rule as the IXH-3.6 suite.
    const offenders: string[] = [];
    for (const el of Array.from(container.querySelectorAll('*'))) {
      for (const token of (el.getAttribute('class') ?? '').split(/\s+/)) {
        if (token.startsWith('animate-') || token === 'transition' || token === 'transition-transform') {
          offenders.push(`${el.tagName.toLowerCase()}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('degradation', () => {
  it('offers a retry after a transport failure', async () => {
    await renderPanel({ failWith: 'Not authenticated' });

    expect(screen.getByTestId('bundle-error')).toHaveTextContent('Not authenticated');
    expect(screen.getByTestId('bundle-retry')).toBeInTheDocument();
  });

  it('shows the taxonomy remediation for an archive that could not be unpacked', async () => {
    await renderPanel({
      ok: false,
      inventory: null,
      error: {
        code: 'INPUT_ARCHIVE_INVALID',
        category: 'input',
        message: 'Archive is not a valid .zip file (bundle.zip)',
        remediation: 'Re-create the archive and try again.',
        retriable: false,
      },
    });

    const panel = screen.getByTestId('bundle-unusable');
    expect(panel).toHaveTextContent('not a valid .zip file');
    expect(panel).toHaveTextContent('Re-create the archive and try again.');
  });

  it('says a single document has no bundle files rather than rendering an empty tree', async () => {
    await renderPanel({ kind: 'single-document', inventory: null });

    expect(screen.getByTestId('bundle-single-document')).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });
});
