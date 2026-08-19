/**
 * The repository detail redesign, rendered (HIVE-7.5, #5322).
 *
 * `repository-detail-model.test.ts` holds the decisions and `repository-detail-css.test.ts`
 * pins the declarations; this holds the screen that makes them, against mocked reads of the
 * repository, its imports, its indexed files, its refresh specs, its conflict policy and the
 * workspace's projects.
 *
 * What it pins is the ticket's four acceptance criteria and the mockup's
 * **Notes → Keeps (1:1)** list:
 *
 *   1. **File filters (preset + glob + regex) compose as today** — and the regex's precedence
 *      is now stated rather than expressed by a control silently going inert.
 *   2. **Map & import produces the same import job as the main wizard** — the overlay collects
 *      the same target, version and options, and hands them to the same `startImport`.
 *   3. **Nested form fields inside radio cards are clickable and accessible** — the target
 *      cards are `<div>`s with a scoped `<label>`, so no interactive control is inside a label
 *      and using the project select does not toggle the radio.
 *   4. **Stubbed controls remain visually honest** — every stub says what is missing, in the
 *      words `repositoryDetailModel` holds.
 *
 * Plus the four things the screen this replaces got wrong: two branch controls that could
 * disagree, a failed read that looked like a missing repository, a tab strip that lost its
 * selection on reload, and KPI figures whose only "placeholder" signal was their colour.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------------------
// Mocks — everything the screen reaches for that jsdom cannot run
// ---------------------------------------------------------------------------------------

const mockReplace = jest.fn();
const mockPush = jest.fn();

/** The current query string, mutable so a deep link and a `?tab=` can both be rendered. */
let searchParams = new URLSearchParams();

/** The signed-in user, mutable so the no-workspace gate can be rendered too. */
const mockSessionUser: { user_id?: string; current_tenant_id?: string; email: string } = {
  user_id: 'u-ada',
  current_tenant_id: 't-acme',
  email: 'ada@acme.io',
};

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: mockSessionUser },
    status: 'authenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'repo-1' }),
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => searchParams,
  usePathname: () => '/ade/dashboard/repositories/repo-1/preview',
}));

const mockToastMessage = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

jest.mock('sonner', () => ({
  toast: {
    message: (...args: unknown[]) => mockToastMessage(...(args as [])),
    success: (...args: unknown[]) => mockToastSuccess(...(args as [])),
    error: (...args: unknown[]) => mockToastError(...(args as [])),
  },
}));

// Monaco and React Flow both need a real layout engine. The panes they draw are measured in
// the browser suite; here they are one element each, so the chrome around them stays testable.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => (
    <div data-testid="mock-monaco">{value.slice(0, 64)}</div>
  ),
}));

jest.mock(
  '@/app/components/ade/dashboard/repositories/RepositoryFileSpecRelationshipFlow',
  () => ({
    RepositoryFileSpecRelationshipFlow: () => <div data-testid="mock-relationship-flow" />,
  })
);

const mockStartImport = jest.fn();
jest.mock('@lib/db/import-actions', () => ({
  startImport: (...args: unknown[]) => mockStartImport(...(args as [])),
  getImportStatus: jest.fn(async () => ({ state: 'completed', result: {} })),
}));

jest.mock('@lib/db/helper', () => ({
  createProject: jest.fn(async () => JSON.stringify({ success: true, project: { id: 'p-new' } })),
}));

jest.mock('@/app/components/ade/dashboard/ImportExecutionPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-import-execution" />,
}));

jest.mock('@/app/components/ade/dashboard/ImportCompletePanel', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-import-complete" />,
}));

import { RepositoryDetailClient } from '../src/app/ade/dashboard/repositories/[id]/RepositoryDetailClient';
import { TooltipProvider } from '../src/app/components/ui/Tooltip';
import {
  BRANCH_TIP_NOTE,
  COMPARE_BRANCHES_STUB_TOAST,
  FILES_EMPTY_COPY,
  NO_IMPORTS_RECORDED,
  PREVIEW_INTRO,
  REPOSITORY_NO_DESCRIPTION,
  RESCAN_BRANCH_STUB_TOAST,
  RESCAN_STUB_TOAST,
  SCAN_HISTORY_STUB_TOAST,
  SUBPATH_GLOB_STUB_NOTE,
  WEBHOOK_STUB_NOTE,
} from '../src/app/components/ade/repositories/repositoryDetailModel';
import { REGEX_OVERRIDES_GLOB_HINT } from '../src/app/components/ade/repositories/RepositoryFileFilters';

// ---------------------------------------------------------------------------------------
// Fixtures — the repository the mockup draws
// ---------------------------------------------------------------------------------------

const REPOSITORY = {
  id: 'repo-1',
  name: 'payments-specs',
  full_name: 'acme/payments-specs',
  description: 'OpenAPI and AsyncAPI sources for the payments platform; scanned on push.',
  provider: 'github',
  default_branch: 'main',
  status: 'ready',
  health: { level: 'warnings', reasons: ['One branch failed its last scan.'] },
  last_scanned_at: '2026-08-19T10:00:00Z',
  recent_scans: [
    { branch: 'main', finished_at: '2026-08-19T10:00:00Z', status: 'completed' },
    { branch: 'release/2.4', finished_at: '2026-08-17T10:00:00Z', status: 'failed' },
  ],
  total_files: 1204,
  importable_count: 41,
  branch_count: 3,
  auto_refresh_enabled: true,
  clone_url: 'https://github.com/acme/payments-specs.git',
  source: 'linked_account',
};

const IMPORTS = [
  {
    id: 'imp-1',
    path: 'specs/payments/openapi.yaml',
    branch: 'main',
    blob_sha: '9f31ac2ff00ba4',
    created_at: '2026-08-19T10:00:00Z',
    project_id: 'p-1',
    project_name: 'Payments API',
    project_slug: 'payments-api',
    catalog_version_label: '2.4.0',
    version_uuid: 'v-1',
    imported_by: 'u-ada',
    imported_by_name: 'Ada Lovelace',
    imported_by_email: 'ada@acme.io',
  },
];

const FILES = [
  {
    id: 'f-1',
    path: 'specs/payments/openapi.yaml',
    name: 'openapi.yaml',
    ext: 'yaml',
    size_bytes: 65536,
    blob_sha: '9f31ac2ff00ba4',
    detected_kind: 'openapi',
    display_kind: 'OpenAPI',
    confidence: 'content',
    quality_score: 86,
    quality_grade: 'B',
  },
  {
    id: 'f-2',
    path: 'events/settlement.asyncapi.yaml',
    name: 'settlement.asyncapi.yaml',
    ext: 'yaml',
    size_bytes: 21504,
    blob_sha: '77d0e4a1122bc',
    detected_kind: 'asyncapi',
    display_kind: 'AsyncAPI',
    confidence: 'filename',
    quality_score: null,
    quality_reason: 'unclassified',
  },
];

const FILE_CONTENT = [
  'openapi: 3.1.0',
  'info:',
  '  title: Payments API',
  '  version: 2.4.0',
  'paths:',
  '  /payments:',
  '    post:',
  '      operationId: createPayment',
  'components:',
  '  schemas:',
  '    Payment:',
  '      type: object',
  '      properties:',
  '        id: { type: string }',
  '',
].join('\n');

const PROJECTS = [
  { id: 'p-1', name: 'Payments API', slug: 'payments-api' },
  { id: 'p-2', name: 'Inventory Events', slug: 'inventory-events' },
];

/** Per-route responses, reset before each test and overridable per case. */
let routes: Record<string, { status?: number; body: unknown }>;

/** Every request the screen made, so a test can assert what it asked for. */
let calls: { url: string; method: string; body?: unknown }[];

/**
 * Route one request to its canned response.
 *
 * Matching is by the first key whose pattern the URL contains, longest first, so
 * `/files/f-1/content` wins over `/files`.
 *
 * @param url The request URL.
 * @returns The canned entry, or a 404.
 */
function routeFor(url: string): { status?: number; body: unknown } {
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (url.includes(key)) return routes[key];
  }
  return { status: 404, body: { error: `No stub for ${url}` } };
}

beforeEach(() => {
  jest.clearAllMocks();
  searchParams = new URLSearchParams();
  mockSessionUser.current_tenant_id = 't-acme';
  calls = [];
  routes = {
    '/api/repositories/repo-1/files/f-1/content': {
      body: {
        success: true,
        path: FILES[0].path,
        branch: 'main',
        display_kind: 'OpenAPI',
        confidence: 'content',
        blob_sha: FILES[0].blob_sha,
        size_bytes: FILES[0].size_bytes,
        content: FILE_CONTENT,
        truncated: false,
      },
    },
    '/api/repositories/repo-1/files': {
      body: {
        success: true,
        branch: 'main',
        branches: ['main', 'develop', 'release/2.4'],
        indexed_total: 1204,
        match_count: 2,
        importable_match_count: 2,
        limit: 50,
        offset: 0,
        files: FILES,
      },
    },
    '/api/repositories/repo-1/imports': {
      body: { success: true, imports: IMPORTS, stats30d: { totalImports: 9, distinctProjects: 4 } },
    },
    '/api/repositories/repo-1/refresh-specs': { body: { success: true, specs: [] } },
    '/api/repositories/repo-1/conflict-policy': {
      body: {
        success: true,
        repositoryId: 'repo-1',
        policy: 'hold-for-review',
        defaultPolicy: 'hold-for-review',
        availablePolicies: ['hold-for-review', 'overwrite', 'new-branch'],
        overrides: [],
      },
    },
    '/api/repositories/repo-1': { body: { success: true, repository: REPOSITORY } },
    '/api/projects': { body: { success: true, projects: PROJECTS } },
  };

  global.fetch = jest.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const route = routeFor(url);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      statusText: route.status && route.status >= 400 ? 'Error' : 'OK',
      json: async () => route.body,
    };
  }) as unknown as typeof fetch;

  mockStartImport.mockResolvedValue({ jobId: 'job-1' } as never);
});

/**
 * Mount the screen and wait for the repository read to land.
 *
 * @returns Testing Library's render result.
 */
async function renderScreen() {
  const result = render(
    <TooltipProvider>
      <RepositoryDetailClient />
    </TooltipProvider>
  );
  await screen.findByTestId('page-header');
  return result;
}

/**
 * Open one tab and wait for its panel.
 *
 * @param tab Which tab.
 */
async function openTab(tab: 'preview' | 'files' | 'specs' | 'imports' | 'settings') {
  fireEvent.click(screen.getByTestId(`repository-tab-${tab}`));
  await waitFor(() => expect(screen.getByTestId(`repository-tab-${tab}`)).toHaveAttribute('aria-selected', 'true'));
}

// ---------------------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------------------

describe('the header', () => {
  test('names where the reader is, all the way back to the workspace', async () => {
    await renderScreen();
    const crumbs = within(screen.getByTestId('page-breadcrumb'));
    expect(crumbs.getByText('Home')).toHaveAttribute('href', '/ade/dashboard');
    expect(crumbs.getByText('Repositories')).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories'
    );
    expect(crumbs.getByText('payments-specs')).toBeInTheDocument();
  });

  test('leads its pills with health, then status', async () => {
    await renderScreen();
    expect(screen.getByTestId('repository-health-badge')).toHaveAttribute(
      'data-health-level',
      'warnings'
    );
    // "Ready", not the detail mockup's "Active": `sources/repositories.html` prints "Ready"
    // for the same `data-status="active"` state, and HIVE-7.3 put that word in the shared
    // vocabulary. One state cannot be two words on two screens.
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  test('carries the provider slug and the default branch as chips', async () => {
    await renderScreen();
    expect(screen.getByTestId('repository-provider-slug')).toHaveTextContent(
      'github.com/acme/payments-specs'
    );
    expect(screen.getByTestId('repository-default-branch-chip')).toHaveTextContent('main');
  });

  test('says the provider gave no description rather than leaving a hole', async () => {
    routes['/api/repositories/repo-1'] = {
      body: { success: true, repository: { ...REPOSITORY, description: null } },
    };
    await renderScreen();
    expect(screen.getByText(REPOSITORY_NO_DESCRIPTION)).toBeInTheDocument();
  });

  test('keeps Rescan honest about being a stub', async () => {
    await renderScreen();
    fireEvent.click(screen.getByTestId('repository-rescan'));
    expect(mockToastMessage).toHaveBeenCalledWith(RESCAN_STUB_TOAST);
  });

  test('disables Rescan while a scan is already running', async () => {
    routes['/api/repositories/repo-1'] = {
      body: { success: true, repository: { ...REPOSITORY, status: 'scanning' } },
    };
    await renderScreen();
    expect(screen.getByTestId('repository-rescan')).toBeDisabled();
  });

  test('the header branch control is the Files tab’s branch, not a second one', async () => {
    await renderScreen();
    // Before the files read there is only the registration's default to offer.
    expect(screen.getByTestId('repository-header-branch')).toHaveTextContent('main');

    await openTab('files');
    await screen.findByTestId('repository-files-table-wrap');

    // Once the listing has reported its branches, the header lists them too.
    await userEvent.click(screen.getByRole('combobox', { name: 'Branch' }));
    expect(await screen.findByRole('option', { name: 'release/2.4' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The KPI row
// ---------------------------------------------------------------------------------------

describe('the KPI row', () => {
  test('draws the mockup five figures', async () => {
    await renderScreen();
    const strip = within(screen.getByTestId('repository-detail-kpis'));
    expect(strip.getByText('Files indexed')).toBeInTheDocument();
    expect(strip.getByText('Importable estimate')).toBeInTheDocument();
    expect(strip.getByText('Branches')).toBeInTheDocument();
    expect(strip.getByText('Imports (30d)')).toBeInTheDocument();
    expect(strip.getByText('Last scan')).toBeInTheDocument();
  });

  test('marks a placeholder figure in the DOM, not only by its colour', async () => {
    routes['/api/repositories/repo-1'] = {
      body: {
        success: true,
        repository: { ...REPOSITORY, importable_count: null, branch_count: null },
      },
    };
    await renderScreen();
    expect(screen.getByTestId('repository-detail-kpi-importable')).toHaveAttribute(
      'data-unwired',
      'true'
    );
    expect(screen.getByTestId('repository-detail-kpi-branches')).toHaveAttribute(
      'data-unwired',
      'true'
    );
    expect(screen.getByTestId('repository-detail-kpi-files')).not.toHaveAttribute('data-unwired');
  });

  test('marks every figure pending while a scan runs', async () => {
    routes['/api/repositories/repo-1'] = {
      body: { success: true, repository: { ...REPOSITORY, status: 'scanning' } },
    };
    await renderScreen();
    expect(screen.getByTestId('repository-detail-kpi-files')).toHaveAttribute(
      'data-pending',
      'true'
    );
  });
});

// ---------------------------------------------------------------------------------------
// The tab strip
// ---------------------------------------------------------------------------------------

describe('the tab strip', () => {
  test('draws the five sections and counts the indexed files on Files', async () => {
    await renderScreen();
    const strip = within(screen.getByRole('tablist', { name: 'Repository sections' }));
    for (const label of ['Preview', 'Files', 'Specs', 'Imports', 'Settings']) {
      expect(strip.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByTestId('repository-tab-files')).toHaveTextContent(
      (1204).toLocaleString()
    );
  });

  test('records the chosen tab in the URL, so a reload lands on it', async () => {
    await renderScreen();
    await openTab('settings');
    expect(mockReplace).toHaveBeenCalledWith(
      '/ade/dashboard/repositories/repo-1/preview?tab=settings',
      { scroll: false }
    );
  });

  test('opens the tab the URL names', async () => {
    searchParams = new URLSearchParams('tab=imports');
    await renderScreen();
    expect(screen.getByTestId('repository-tab-imports')).toHaveAttribute('aria-selected', 'true');
  });

  test('a file deep link opens the Files tab whatever else the URL says', async () => {
    searchParams = new URLSearchParams('path=specs/payments/openapi.yaml&branch=main');
    await renderScreen();
    expect(screen.getByTestId('repository-tab-files')).toHaveAttribute('aria-selected', 'true');
  });

  test('each panel is labelled by the tab that opened it', async () => {
    await renderScreen();
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'repository-tab-preview');
  });
});

// ---------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------

describe('the Preview tab', () => {
  test('opens with the intro, the scans and the mix', async () => {
    await renderScreen();
    expect(screen.getByText(PREVIEW_INTRO)).toBeInTheDocument();
    expect(screen.getAllByTestId('repository-recent-scan')).toHaveLength(2);
    expect(within(screen.getByTestId('repository-importable-mix')).getByText('Total importable'))
      .toBeInTheDocument();
  });

  test('the mix names formats with the app’s own format pills, not invented dots', async () => {
    await renderScreen();
    const pills = within(screen.getByTestId('repository-importable-mix')).getAllByTestId(
      'format-pill'
    );
    expect(pills.map((p) => p.getAttribute('data-format'))).toEqual([
      'openapi',
      'arazzo',
      'jsonschema',
    ]);
  });

  test('lists recent imports, each deep-linking to its file on its branch', async () => {
    await renderScreen();
    const table = within(await screen.findByTestId('repository-recent-imports'));
    const link = await table.findByText('specs/payments/openapi.yaml');
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining('path=specs%2Fpayments%2Fopenapi.yaml')
    );
    expect(table.getByText(/blob 9f31ac2… · main/)).toBeInTheDocument();
  });

  test('keeps "View scan history" honest about being a stub', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: /view scan history/i }));
    expect(mockToastMessage).toHaveBeenCalledWith(SCAN_HISTORY_STUB_TOAST);
  });

  test('"See all" moves to the Imports tab rather than opening a second table', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: /see all/i }));
    await waitFor(() =>
      expect(screen.getByTestId('repository-tab-imports')).toHaveAttribute(
        'aria-selected',
        'true'
      )
    );
  });

  test('a repository with no scan history says so rather than drawing an empty box', async () => {
    routes['/api/repositories/repo-1'] = {
      body: { success: true, repository: { ...REPOSITORY, recent_scans: [] } },
    };
    await renderScreen();
    expect(screen.getByText('No recent scans')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------

describe('the Imports tab', () => {
  test('draws the whole history with the mockup columns', async () => {
    await renderScreen();
    await openTab('imports');
    const table = within(await screen.findByTestId('repository-imports-tab'));
    for (const column of ['When', 'File', 'Project · version', 'Outcome', 'By']) {
      expect(table.getByText(column)).toBeInTheDocument();
    }
    expect(table.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(table.getByText('Completed')).toBeInTheDocument();
  });

  test('says how to record the first import when there is none', async () => {
    routes['/api/repositories/repo-1/imports'] = {
      body: { success: true, imports: [], stats30d: { totalImports: 0, distinctProjects: 0 } },
    };
    await renderScreen();
    await openTab('imports');
    expect(await screen.findByText(NO_IMPORTS_RECORDED)).toBeInTheDocument();
  });

  test('a failed read is the table’s own row, not a blank tab', async () => {
    routes['/api/repositories/repo-1/imports'] = {
      status: 500,
      body: { error: 'Import metrics unavailable' },
    };
    await renderScreen();
    await openTab('imports');
    expect(await screen.findByText('Import metrics unavailable')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------

describe('the Files tab', () => {
  /** Open Files and wait for the first listing. */
  const openFiles = async () => {
    await openTab('files');
    await screen.findByTestId('repository-files-table-wrap');
  };

  test('draws the branch bar with its provenance note and its two stubs', async () => {
    await renderScreen();
    await openFiles();
    expect(screen.getByText(BRANCH_TIP_NOTE)).toBeInTheDocument();
    expect(screen.getByText(/files on main/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /rescan branch/i }));
    expect(mockToastMessage).toHaveBeenCalledWith(RESCAN_BRANCH_STUB_TOAST);
  });

  test('the branch popover searches, offers Tags disabled, and marks the default', async () => {
    await renderScreen();
    await openFiles();

    await userEvent.click(screen.getByTestId('repository-branch-trigger'));
    const menu = within(await screen.findByTestId('repository-branch-menu'));
    expect(menu.getByRole('radio', { name: /Tags/ })).toBeDisabled();
    expect(menu.getByText('default')).toBeInTheDocument();

    fireEvent.click(menu.getByRole('button', { name: /compare branches/i }));
    expect(mockToastMessage).toHaveBeenCalledWith(COMPARE_BRANCHES_STUB_TOAST);
  });

  test('the preset, the glob and the regex compose into one request', async () => {
    await renderScreen();
    await openFiles();

    fireEvent.change(screen.getByLabelText(/glob filter/i), {
      target: { value: '**/openapi*.yaml' },
    });
    fireEvent.click(screen.getByTestId('repository-file-apply'));

    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.url.includes('/files?'));
      expect(last?.url).toContain('glob=');
    });
  });

  test('a regex disables the preset and the glob, and says why', async () => {
    await renderScreen();
    await openFiles();

    expect(screen.queryByTestId('repository-file-regex-hint')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/regex/i), { target: { value: 'v\\d+' } });

    expect(await screen.findByTestId('repository-file-regex-hint')).toHaveTextContent(
      REGEX_OVERRIDES_GLOB_HINT
    );
    expect(screen.getByLabelText(/glob filter/i)).toBeDisabled();
    expect(screen.getByTestId('repository-file-preset')).toBeDisabled();
  });

  test('Reset returns every field to its default', async () => {
    await renderScreen();
    await openFiles();

    const glob = screen.getByLabelText(/glob filter/i) as HTMLInputElement;
    fireEvent.change(glob, { target: { value: '**/*.yaml' } });
    fireEvent.click(screen.getByLabelText(/hide non-importable/i));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(glob.value).toBe('');
    expect(screen.getByLabelText(/hide non-importable/i)).toBeChecked();
  });

  test('the table draws the mockup columns and the quality score as a badge', async () => {
    await renderScreen();
    await openFiles();

    for (const column of ['Path', 'Detected kind', 'Quality', 'Confidence', 'Size', 'Blob']) {
      expect(screen.getByRole('columnheader', { name: column })).toBeInTheDocument();
    }
    const quality = screen.getAllByTestId('repository-file-quality');
    expect(quality[0]).toHaveTextContent('86');
    expect(quality[1]).toHaveTextContent('—');
  });

  test('selecting rows counts them, and select-all goes indeterminate part-way', async () => {
    await renderScreen();
    await openFiles();

    const selectAll = screen.getByLabelText('Select all files on this page') as HTMLInputElement;
    fireEvent.click(screen.getByLabelText('Select specs/payments/openapi.yaml'));
    expect(screen.getByTestId('repository-files-summary')).toHaveTextContent('1 selected');
    await waitFor(() => expect(selectAll.indeterminate).toBe(true));

    fireEvent.click(selectAll);
    expect(screen.getByTestId('repository-files-summary')).toHaveTextContent('2 selected');
    await waitFor(() => expect(selectAll.indeterminate).toBe(false));
  });

  test('Import selected warns that the wizard maps one file at a time', async () => {
    await renderScreen();
    await openFiles();

    fireEvent.click(screen.getByLabelText('Select all files on this page'));
    fireEvent.click(screen.getByTestId('repository-import-selected'));

    expect(mockToastMessage).toHaveBeenCalledWith(
      expect.stringContaining('one spec at a time')
    );
    expect(await screen.findByTestId('repository-map-import')).toBeInTheDocument();
  });

  test('Import selected is inert with nothing ticked', async () => {
    await renderScreen();
    await openFiles();
    expect(screen.getByTestId('repository-import-selected')).toBeDisabled();
  });

  test('an empty branch says both reasons a page can be blank', async () => {
    routes['/api/repositories/repo-1/files'] = {
      body: {
        success: true,
        branch: 'main',
        branches: ['main'],
        indexed_total: 0,
        match_count: 0,
        importable_match_count: 0,
        limit: 50,
        offset: 0,
        files: [],
      },
    };
    await renderScreen();
    await openFiles();
    expect(await screen.findByTestId('repository-files-empty')).toHaveTextContent(
      FILES_EMPTY_COPY
    );
  });

  test('a failed listing offers a retry rather than an empty table', async () => {
    routes['/api/repositories/repo-1/files'] = {
      status: 500,
      body: { error: 'Index unavailable' },
    };
    await renderScreen();
    await openTab('files');
    expect(await screen.findByText('Index unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// File detail
// ---------------------------------------------------------------------------------------

describe('the file detail pane', () => {
  /** Open Files, then the first file. */
  const openFile = async () => {
    await openTab('files');
    await screen.findByTestId('repository-files-table-wrap');
    fireEvent.click(screen.getByRole('button', { name: 'specs/payments/openapi.yaml' }));
    return screen.findByTestId('repository-file-detail');
  };

  test('replaces the browser in place, with a way back', async () => {
    await renderScreen();
    await openFile();
    expect(screen.queryByTestId('repository-files-table-wrap')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /back to payments-specs/i }));
    await screen.findByTestId('repository-files-table-wrap');
  });

  test('states the verdict as a strip carrying a tone, not as coloured text', async () => {
    await renderScreen();
    await openFile();
    const verdict = await screen.findByTestId('repository-file-importable-verdict');
    const strip = verdict.querySelector('.repo-file-verdict') as HTMLElement;
    expect(strip).toHaveAttribute('data-tone', 'ok');
    expect(strip).toHaveTextContent(/Importable — the client parse recognised/);
  });

  test('offers the four viewer panes as one control a screen reader can name', async () => {
    await renderScreen();
    await openFile();
    const group = await screen.findByRole('radiogroup', { name: 'File view' });
    for (const label of ['Source', 'Diff vs latest import', 'Visualize', 'Details']) {
      expect(within(group).getByRole('radio', { name: label })).toBeInTheDocument();
    }
  });

  test('the Diff pane says what is missing rather than drawing an empty diff', async () => {
    await renderScreen();
    await openFile();
    await userEvent.click(await screen.findByRole('radio', { name: 'Diff vs latest import' }));
    expect(await screen.findByText('Diff not wired yet')).toBeInTheDocument();
  });

  test('the Details tables name their sort direction, not only their column', async () => {
    await renderScreen();
    await openFile();
    await userEvent.click(await screen.findByRole('radio', { name: 'Details' }));
    const tables = await screen.findByTestId('repository-file-detail-tables');
    expect(within(tables).getAllByRole('button', { name: /sort (ascending|descending)/ }).length)
      .toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------
// Map & import
// ---------------------------------------------------------------------------------------

describe('the Map & import overlay', () => {
  /** Open Files and launch the wizard over the first row. */
  const openWizard = async () => {
    await openTab('files');
    await screen.findByTestId('repository-files-table-wrap');
    fireEvent.click(screen.getByLabelText('Select specs/payments/openapi.yaml'));
    fireEvent.click(screen.getByTestId('repository-import-selected'));
    const dialog = await screen.findByTestId('repository-map-import');
    // The cards replace their skeletons once the file's own content read lands.
    await screen.findByTestId('repository-import-target-existing');
    return dialog;
  };

  test('opens over the tab, leaving the table mounted behind it', async () => {
    await renderScreen();
    await openWizard();
    // The list is still there — closing returns to the row that opened the wizard, rather
    // than to the top of an unfiltered list.
    expect(screen.getByTestId('repository-files-table-wrap')).toBeInTheDocument();
  });

  test('names the file and the commit it is importing', async () => {
    await renderScreen();
    const wizard = await openWizard();
    // The path appears twice by design: once in the head's sentence, once in the Source facts.
    expect(within(wizard).getAllByText('specs/payments/openapi.yaml').length).toBe(2);
    // The head names the commit, and the `repository_imports` note repeats it with the path.
    expect(
      within(wizard).getAllByText(/acme\/payments-specs@9f31ac2/).length
    ).toBeGreaterThan(0);
  });

  test('the target cards hold no interactive control inside a label', async () => {
    await renderScreen();
    const wizard = await openWizard();

    // The ticket's third acceptance criterion, expressed as the thing axe checks: an
    // interactive element inside a <label> is a `nested-interactive` violation *and* a click
    // that lands on it also toggles the label's control.
    for (const label of Array.from(wizard.querySelectorAll('label'))) {
      const nested = label.querySelectorAll(
        'button, select, textarea, a[href], input:not([type="radio"]):not([type="checkbox"])'
      );
      expect(nested).toHaveLength(0);
    }
  });

  test('the nested project select is reachable and does not toggle the radio', async () => {
    await renderScreen();
    const wizard = await openWizard();
    const card = within(await screen.findByTestId('repository-import-target-existing'));

    // Choose the *other* card first, so a stray toggle would be visible.
    await userEvent.click(screen.getByLabelText('Create a new project'));
    expect(screen.getByLabelText('Create a new project')).toBeChecked();

    await userEvent.click(
      await card.findByRole('combobox', { name: /map to existing project/i })
    );
    await userEvent.click(await screen.findByRole('option', { name: /Payments API/ }));

    // Picking a project is what chose the card — deliberately, in the handler — rather than a
    // click bubbling through a label.
    expect(screen.getByLabelText('Existing project')).toBeChecked();
    expect((wizard.querySelector('#repo-import-project-slug') as HTMLInputElement).value).toBe(
      'payments-api'
    );
  });

  test('the title is the radio’s label, so clicking it still chooses the card', async () => {
    await renderScreen();
    await openWizard();
    await userEvent.click(screen.getByLabelText('Create a new project'));
    expect(screen.getByLabelText('Create a new project')).toBeChecked();
    await userEvent.click(screen.getByText('Existing project'));
    expect(screen.getByLabelText('Existing project')).toBeChecked();
  });

  test('import stays inert until a target is chosen, and says what is missing', async () => {
    await renderScreen();
    const wizard = within(await openWizard());
    expect(wizard.getByTestId('repository-import-submit')).toBeDisabled();
    expect(
      await wizard.findByText(/Select an existing project in the dropdown to enable import/)
    ).toBeInTheDocument();
  });

  test('runs the same import job the main wizard runs', async () => {
    await renderScreen();
    const wizard = within(await openWizard());

    await userEvent.click(
      await wizard.findByRole('combobox', { name: /map to existing project/i })
    );
    await userEvent.click(await screen.findByRole('option', { name: /Payments API/ }));

    const submit = wizard.getByTestId('repository-import-submit');
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);

    await waitFor(() => expect(mockStartImport).toHaveBeenCalled());
    const [args] = mockStartImport.mock.calls[0] as [Record<string, unknown>];
    expect(args.existingProjectId).toBe('p-1');
    expect(args.repositorySource).toMatchObject({
      repositoryId: 'repo-1',
      branch: 'main',
      path: 'specs/payments/openapi.yaml',
    });
    expect(args.tenantId).toBe('t-acme');
  });

  test('the diff placeholder is untinted — three coloured tiles would claim a measurement', async () => {
    await renderScreen();
    const wizard = await openWizard();
    const tiles = wizard.querySelectorAll('.repo-map-tile');
    expect(tiles).toHaveLength(3);
    tiles.forEach((tile) => expect(tile.textContent).toContain('—'));
  });
});

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

describe('the Settings tab', () => {
  test('states the source, including how the repository was registered', async () => {
    await renderScreen();
    await openTab('settings');
    const source = within(await screen.findByTestId('repository-settings-source'));
    expect(source.getByText('Github (linked account)')).toBeInTheDocument();
    expect(source.getByText('https://github.com/acme/payments-specs.git')).toBeInTheDocument();
    expect(source.getByRole('link', { name: /open in browser/i })).toHaveAttribute(
      'href',
      'https://github.com/acme/payments-specs'
    );
  });

  test('every unwired control says why in words, not only by dimming', async () => {
    await renderScreen();
    await openTab('settings');
    expect(await screen.findByTestId('repository-subpath-stub')).toHaveTextContent(
      SUBPATH_GLOB_STUB_NOTE
    );
    expect(screen.getByDisplayValue(WEBHOOK_STUB_NOTE)).toBeInTheDocument();
    expect(screen.getByTestId('repository-cadence-stub')).toBeDisabled();
    expect(screen.getByRole('button', { name: /add mapping/i })).toBeDisabled();
  });

  test('the auto-refresh switch writes and reconciles to what the server stored', async () => {
    await renderScreen();
    await openTab('settings');

    const toggle = await screen.findByLabelText(/toggle auto-refresh/i);
    routes['/api/repositories/repo-1'] = {
      body: { success: true, repository: { ...REPOSITORY, auto_refresh_enabled: false } },
    };
    await userEvent.click(toggle);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch?.body).toEqual({ auto_refresh_enabled: false });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Auto-refresh disabled.');
  });

  test('the danger zone asks before it removes', async () => {
    await renderScreen();
    await openTab('settings');
    fireEvent.click(await screen.findByTestId('repository-remove'));
    expect(await screen.findByText('Remove repository?')).toBeInTheDocument();
    expect(screen.getByText(/You can add it again later/)).toBeInTheDocument();
  });

  test('carries the conflict-policy panel rather than a copy of it', async () => {
    await renderScreen();
    await openTab('settings');
    expect(await screen.findByTestId('conflict-policy')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// Degradations
// ---------------------------------------------------------------------------------------

describe('reads that fail', () => {
  test('a failed repository read offers a retry and a way back to the list', async () => {
    routes['/api/repositories/repo-1'] = {
      status: 404,
      body: { error: 'Repository not registered to this workspace' },
    };
    render(
      <TooltipProvider>
        <RepositoryDetailClient />
      </TooltipProvider>
    );
    expect(
      await screen.findByText('Repository not registered to this workspace')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to list/i })).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories'
    );
  });

  test('a session with no workspace is gated rather than shown an empty repository', async () => {
    mockSessionUser.current_tenant_id = undefined;
    render(
      <TooltipProvider>
        <RepositoryDetailClient />
      </TooltipProvider>
    );
    expect(
      await screen.findByText(/Repositories are registered against one workspace/)
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// Browser fixtures
// ---------------------------------------------------------------------------------------

/**
 * `e2e/hive-repository-detail.spec.ts` measures computed layout, which jsdom cannot do.
 * Rather than hand-writing HTML that would drift from the components, this renders the real
 * screen and writes what it rendered into `e2e/fixtures/hive-repository-detail/` when
 * `REPOSITORY_DETAIL_FIXTURE_DUMP=1` is set:
 *
 *     REPOSITORY_DETAIL_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/repository-detail-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is
 * there — so a change that would leave the fixtures stale fails loudly here before it fails
 * quietly in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-repository-detail');
  const dump = process.env.REPOSITORY_DETAIL_FIXTURE_DUMP === '1';

  /**
   * Write one fixture, or just assert it could be written.
   *
   * @param name The fixture's file name, without the extension.
   * @param html The markup to write.
   */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /**
   * Serialise a subtree with its live form state.
   *
   * `outerHTML` writes *attributes*, and a box ticked by a click has only the `checked`
   * **property** — so a fixture of a page with a selected row would arrive in the browser with
   * every box empty, and the browser suite would measure the wrong thing. Mirroring the
   * property onto the attribute first is what makes the fixture the state the test set up.
   *
   * @param node The subtree to serialise.
   * @returns Its markup, with checkbox and radio state written into the attributes.
   */
  const serialize = (node: HTMLElement) => {
    node.querySelectorAll('input').forEach((input) => {
      if (input.type === 'checkbox' || input.type === 'radio') {
        if (input.checked) input.setAttribute('checked', '');
        else input.removeAttribute('checked');
      } else if (input.value) {
        input.setAttribute('value', input.value);
      }
    });
    return node.outerHTML;
  };

  /** The page column the shell would put this screen in. */
  const page = () => serialize(document.querySelector('.page') as HTMLElement);

  /** An overlay, which portals to the body rather than into the page column. */
  const overlay = (testId: string) =>
    serialize(screen.getByTestId(testId).closest('[role="dialog"]') as HTMLElement);

  it('renders the Preview tab (and writes its fixture on request)', async () => {
    await renderScreen();
    await screen.findByTestId('repository-recent-imports');
    write('preview', page());
  });

  it('renders the Files tab (and writes its fixture on request)', async () => {
    await renderScreen();
    await openTab('files');
    await screen.findByTestId('repository-files-table-wrap');
    fireEvent.click(screen.getByLabelText('Select specs/payments/openapi.yaml'));
    write('files', page());
  });

  it('renders the Settings tab (and writes its fixture on request)', async () => {
    await renderScreen();
    await openTab('settings');
    await screen.findByTestId('conflict-policy');
    write('settings', page());
  });

  it('renders the Map & import overlay (and writes its fixture on request)', async () => {
    await renderScreen();
    await openTab('files');
    await screen.findByTestId('repository-files-table-wrap');
    fireEvent.click(screen.getByLabelText('Select specs/payments/openapi.yaml'));
    fireEvent.click(screen.getByTestId('repository-import-selected'));
    await screen.findByTestId('repository-map-import');
    // Wait for the file's own content read, or the fixture is a dialog full of skeletons.
    await screen.findByTestId('repository-import-target-existing');
    await screen.findByTestId('repository-import-options');
    write('map-import', overlay('repository-map-import'));
  });

  it('renders the file detail pane (and writes its fixture on request)', async () => {
    await renderScreen();
    await openTab('files');
    await screen.findByTestId('repository-files-table-wrap');
    fireEvent.click(screen.getByRole('button', { name: 'specs/payments/openapi.yaml' }));
    await screen.findByTestId('repository-file-detail');
    await screen.findByTestId('repository-file-importable-verdict');
    write('file-detail', page());
  });
});
