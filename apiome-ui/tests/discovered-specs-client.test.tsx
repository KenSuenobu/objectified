/**
 * The discovered-specs screen, driven (REPO-6.4, #2797; redesigned HIVE-7.6, #5323).
 *
 * These drive the real screen against a stubbed `/api/repositories/catalog` and assert the
 * behaviours the original ticket's acceptance criteria name — all of which the redesign had to
 * carry over intact:
 *
 *  - rows link into the REPO-6.2 file drawer on the owning repository;
 *  - search, format, repository, project and status all filter *server-side* (the request
 *    changes; the rendered rows are whatever the server returned);
 *  - pagination is server-side, and Prev/Next move the offset rather than slicing an array;
 *  - the view round-trips through the address bar, which is HIVE-7.6's first acceptance
 *    criterion and the reason a filtered catalog is a link.
 *
 * `repository-bring-in-hive-redesign.test.tsx` holds what the *redesign* added; this holds
 * what it must not have broken.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockReplace = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useSearchParams: () => searchParams,
  usePathname: () => '/ade/dashboard/repositories/catalog',
}));

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({ data: { user: { current_tenant_id: 'tenant-1' } } }),
}));

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), message: jest.fn(), success: jest.fn() },
}));

import { DiscoveredSpecsClient } from '@/app/ade/dashboard/repositories/catalog/DiscoveredSpecsClient';

const REPO_ID = '880e8400-e29b-41d4-a716-446655440003';
const PROJECT_ID = '770e8400-e29b-41d4-a716-446655440002';

const IMPORTED_SPEC = {
  id: 'file-1',
  repository_id: REPO_ID,
  repository_full_name: 'acme/api-platform',
  repository_provider: 'github',
  branch: 'main',
  path: 'services/orders/openapi.yaml',
  name: 'openapi.yaml',
  ext: 'yaml',
  size_bytes: 4096,
  blob_sha: 'aaa111',
  detected_kind: 'openapi-3.1',
  format: 'openapi',
  display_kind: 'OpenAPI',
  status: 'imported',
  project_id: PROJECT_ID,
  project_name: 'Orders API',
  project_slug: 'orders-api',
  version_id: 'version-1',
  last_imported_at: '2026-07-20T09:30:00Z',
  discovered_at: '2026-07-01T10:00:00Z',
  quality_score: 87,
  quality_grade: 'B',
  quality_status: 'scored',
  external_ref_unresolved_count: null,
};

const BROKEN_SPEC = {
  ...IMPORTED_SPEC,
  id: 'file-2',
  path: 'workflows/checkout.arazzo.yaml',
  name: 'checkout.arazzo.yaml',
  format: 'arazzo',
  display_kind: 'Arazzo',
  status: 'needs_attention',
  project_id: null,
  project_name: null,
  project_slug: null,
  version_id: null,
  last_imported_at: null,
  external_ref_unresolved_count: 2,
};

const FACETS = {
  formats: [
    { value: 'openapi', label: 'OpenAPI', count: 9 },
    { value: 'arazzo', label: 'Arazzo', count: 2 },
  ],
  statuses: [
    { value: 'needs_attention', label: 'Needs attention', count: 1 },
    { value: 'imported', label: 'Imported', count: 9 },
  ],
  repositories: [{ value: REPO_ID, label: 'acme/api-platform', count: 11 }],
  projects: [{ value: PROJECT_ID, label: 'Orders API', count: 9 }],
};

/** Build a catalog page payload. */
function page(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    catalog_total: 11,
    match_count: 2,
    limit: 50,
    offset: 0,
    sort: 'repository',
    specs: [IMPORTED_SPEC, BROKEN_SPEC],
    facets: FACETS,
    ...overrides,
  };
}

let fetchMock: jest.Mock;

/**
 * The table's data rows.
 *
 * `ui/DataTable` keys a row by `data-row-id` rather than by a test id of the screen's own, so
 * this is how a row is addressed since HIVE-7.6 (#5323).
 *
 * @returns Every rendered row, in order.
 */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('tbody tr[data-row-id]'));
}

/**
 * Wait until the table has drawn `count` rows.
 *
 * @param count How many rows to wait for.
 * @returns The rows.
 */
async function findRows(count?: number): Promise<HTMLElement[]> {
  await waitFor(() => {
    const found = rows();
    expect(found.length).toBeGreaterThan(0);
    if (count !== undefined) expect(found).toHaveLength(count);
  });
  return rows();
}

/** Every request the component has made, as parsed query strings. */
function requestedQueries(): URLSearchParams[] {
  return fetchMock.mock.calls.map(
    (call) => new URL((call as unknown[])[0] as string, 'http://localhost').searchParams
  );
}

/** The most recent request's query. */
function lastQuery(): URLSearchParams {
  const queries = requestedQueries();
  return queries[queries.length - 1];
}

beforeEach(() => {
  jest.clearAllMocks();
  searchParams = new URLSearchParams();
  fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => page(),
  }));
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('rendering the catalog', () => {
  test('lists every spec the server returned, across repositories', async () => {
    render(<DiscoveredSpecsClient />);

    await findRows(2);
    expect(screen.getByText('openapi.yaml')).toBeInTheDocument();
    expect(screen.getByText('checkout.arazzo.yaml')).toBeInTheDocument();
    expect(screen.getAllByText('acme/api-platform').length).toBeGreaterThan(0);
  });

  test('a row links into the file drawer on its owning repository', async () => {
    render(<DiscoveredSpecsClient />);

    const row = (await findRows())[0];
    const link = within(row).getByTitle(
      'Open services/orders/openapi.yaml in acme/api-platform'
    );
    expect(link).toHaveAttribute(
      'href',
      `/ade/dashboard/repositories/${REPO_ID}/preview?tab=files&path=services%2Forders%2Fopenapi.yaml&branch=main`
    );
  });

  test('the derived status is shown per row', async () => {
    render(<DiscoveredSpecsClient />);

    const drawn = await findRows();
    expect(within(drawn[0]).getByTestId('spec-catalog-status')).toHaveTextContent('Imported');
    expect(within(drawn[1]).getByTestId('spec-catalog-status')).toHaveTextContent(
      'Needs attention'
    );
  });

  test('an unresolved external $ref is called out on the row that has one', async () => {
    render(<DiscoveredSpecsClient />);

    const drawn = await findRows();
    expect(within(drawn[1]).getByText(/2 unresolved external \$refs/)).toBeInTheDocument();
    expect(within(drawn[0]).queryByText(/unresolved external/)).not.toBeInTheDocument();
  });

  test('an unmapped spec reads as unmapped rather than blank', async () => {
    render(<DiscoveredSpecsClient />);

    const drawn = await findRows();
    expect(within(drawn[1]).getByText('Unmapped')).toBeInTheDocument();
    expect(within(drawn[0]).getByText('Orders API')).toBeInTheDocument();
  });

  test('the header reports the size of the whole catalog', async () => {
    render(<DiscoveredSpecsClient />);

    expect(await screen.findByText(/11 indexed\./)).toBeInTheDocument();
  });
});

describe('server-side search and filtering', () => {
  test('the first request asks for facets; later ones do not', async () => {
    const user = userEvent.setup();
    render(<DiscoveredSpecsClient />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requestedQueries()[0].get('include_facets')).toBe('true');

    await user.type(screen.getByLabelText('Search discovered specs'), 'orders');
    await waitFor(() => expect(lastQuery().get('q')).toBe('orders'));
    expect(lastQuery().has('include_facets')).toBe(false);
  });

  test('typing a search sends it to the server rather than filtering locally', async () => {
    const user = userEvent.setup();
    render(<DiscoveredSpecsClient />);
    await findRows();

    await user.type(screen.getByLabelText('Search discovered specs'), 'checkout');

    await waitFor(() => expect(lastQuery().get('q')).toBe('checkout'));
    // The server decides what matches; the page renders exactly what came back.
    expect(rows()).toHaveLength(2);
  });

  test('a keystroke is debounced into a single request', async () => {
    const user = userEvent.setup();
    render(<DiscoveredSpecsClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText('Search discovered specs'), 'orders');

    await waitFor(() => expect(lastQuery().get('q')).toBe('orders'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('the format filter is populated from the facets and sent as a query parameter', async () => {
    const user = userEvent.setup();
    render(<DiscoveredSpecsClient />);
    await findRows();

    await user.click(screen.getByLabelText('Format'));
    await user.click(await screen.findByRole('option', { name: /Arazzo \(2\)/ }));

    await waitFor(() => expect(lastQuery().get('format')).toBe('arazzo'));
  });

  test('the status filter offers the facet values and filters server-side', async () => {
    const user = userEvent.setup();
    render(<DiscoveredSpecsClient />);
    await findRows();

    await user.click(screen.getByLabelText('Status'));
    await user.click(await screen.findByRole('option', { name: /Needs attention \(1\)/ }));

    await waitFor(() => expect(lastQuery().get('status')).toBe('needs_attention'));
  });

  test('the repository filter sends the repository id', async () => {
    const user = userEvent.setup();
    render(<DiscoveredSpecsClient />);
    await findRows();

    await user.click(screen.getByLabelText('Repository'));
    await user.click(await screen.findByRole('option', { name: /acme\/api-platform \(11\)/ }));

    await waitFor(() => expect(lastQuery().get('repository_id')).toBe(REPO_ID));
  });

  test('the project filter sends the project id', async () => {
    const user = userEvent.setup();
    render(<DiscoveredSpecsClient />);
    await findRows();

    await user.click(screen.getByLabelText('Project'));
    await user.click(await screen.findByRole('option', { name: /Orders API \(9\)/ }));

    await waitFor(() => expect(lastQuery().get('project_id')).toBe(PROJECT_ID));
  });

  test('changing the sort re-requests rather than reordering in the browser', async () => {
    const user = userEvent.setup();
    render(<DiscoveredSpecsClient />);
    await findRows();

    await user.click(screen.getByLabelText('Sort by'));
    await user.click(await screen.findByRole('option', { name: 'Sort: Path' }));

    await waitFor(() => expect(lastQuery().get('sort')).toBe('path'));
  });

  test('a slow earlier response cannot overwrite a faster later one', async () => {
    const user = userEvent.setup();
    let release: (() => void) | null = null;
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        // Hold the initial load open until the filtered one has already landed.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => page({ specs: [IMPORTED_SPEC, BROKEN_SPEC], match_count: 2 }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => page({ specs: [BROKEN_SPEC], match_count: 1 }),
      };
    });

    render(<DiscoveredSpecsClient />);
    await user.type(screen.getByLabelText('Search discovered specs'), 'checkout');
    await waitFor(() => expect(rows()).toHaveLength(1));

    release!();

    // Give the stale response a chance to land; the filtered result must survive it.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(rows()).toHaveLength(1);
  });

  test('clearing the filters returns to the unfiltered catalog', async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams({ format: 'openapi', q: 'orders' });
    render(<DiscoveredSpecsClient />);
    await findRows();

    await user.click(screen.getByRole('button', { name: /Clear filters/ }));

    await waitFor(() => expect(lastQuery().has('format')).toBe(false));
    expect(lastQuery().has('q')).toBe(false);
  });
});

describe('server-side pagination', () => {
  test('Next advances the offset by one page', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => page({ match_count: 500 }),
    }));
    render(<DiscoveredSpecsClient />);
    await findRows();

    await user.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(lastQuery().get('offset')).toBe('50'));
  });

  test('Prev is disabled on the first page', async () => {
    render(<DiscoveredSpecsClient />);
    await findRows();

    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();
  });

  test('Next is disabled once the last row is on screen', async () => {
    render(<DiscoveredSpecsClient />);
    await findRows();

    // match_count is 2 and both rows are rendered — there is no next page.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  test('the footer reports the server-side range, not the array length', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => page({ match_count: 10234, offset: 50 }),
    }));
    render(<DiscoveredSpecsClient />);

    expect(await screen.findByText(/Showing 51–52 of 10,234/)).toBeInTheDocument();
  });

  test('changing a filter drops back to the first page', async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams({ offset: '200' });
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => page({ match_count: 500, offset: 200 }),
    }));
    render(<DiscoveredSpecsClient />);
    await findRows();
    expect(requestedQueries()[0].get('offset')).toBe('200');

    await user.type(screen.getByLabelText('Search discovered specs'), 'orders');

    await waitFor(() => expect(lastQuery().get('q')).toBe('orders'));
    expect(lastQuery().get('offset')).toBe('0');
  });
});

describe('bookmarkable views', () => {
  test('a filtered URL is honoured on first load', async () => {
    searchParams = new URLSearchParams({
      q: 'orders',
      format: 'openapi',
      status: 'imported',
      sort: 'recent',
      all_branches: 'true',
      offset: '50',
    });
    render(<DiscoveredSpecsClient />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const query = requestedQueries()[0];
    expect(query.get('q')).toBe('orders');
    expect(query.get('format')).toBe('openapi');
    expect(query.get('status')).toBe('imported');
    expect(query.get('sort')).toBe('recent');
    expect(query.get('all_branches')).toBe('true');
    expect(query.get('offset')).toBe('50');
  });

  test('the current view is written back to the address bar', async () => {
    const user = userEvent.setup();
    render(<DiscoveredSpecsClient />);
    await findRows();

    await user.type(screen.getByLabelText('Search discovered specs'), 'orders');

    await waitFor(() =>
      expect(mockReplace).toHaveBeenLastCalledWith(
        '/ade/dashboard/repositories/catalog?q=orders',
        { scroll: false }
      )
    );
  });
});

describe('empty and failed states', () => {
  test('an empty catalog invites the operator to register a repository', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => page({ specs: [], match_count: 0, catalog_total: 0 }),
    }));
    render(<DiscoveredSpecsClient />);

    expect(await screen.findByText('No specs discovered yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Register a repository/ })).toBeInTheDocument();
  });

  test('an empty filtered result offers to clear the filters instead', async () => {
    searchParams = new URLSearchParams({ q: 'nothing-matches' });
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => page({ specs: [], match_count: 0 }),
    }));
    render(<DiscoveredSpecsClient />);

    expect(await screen.findByText('No specs match these filters')).toBeInTheDocument();
  });

  test('a failed request surfaces the error with a retry', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ success: false, error: 'Repository API unavailable' }),
    }));
    render(<DiscoveredSpecsClient />);

    expect(await screen.findByText('Repository API unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});
