/**
 * Catalog view state helpers (REPO-6.4, #2797).
 *
 * The cross-repo spec catalog exists in three representations at once — the browser URL, the
 * API query string, and the component's filter state — and every one of its acceptance
 * criteria depends on those staying in step. These tests pin the conversions:
 *
 *  - a shared or bookmarked URL rebuilds the same view;
 *  - the URL carries only what differs from the default, so the plain catalog has a clean link;
 *  - `all` selections are dropped from the API request rather than sent as a literal filter;
 *  - facets are requested once, not on every page turn.
 */

import { describe, test, expect } from '@jest/globals';
import {
  DEFAULT_SPEC_CATALOG_FILTERS,
  SPEC_CATALOG_PAGE_SIZE,
  SPEC_CATALOG_SORT_OPTIONS,
  type SpecCatalogFilters,
  specCatalogApiQuery,
  specCatalogFiltersFromSearchParams,
  specCatalogHasActiveFilters,
  specCatalogStatusBadge,
  specCatalogUrlQuery,
  splitSpecPath,
} from '@/app/components/ade/dashboard/repositories/repositorySpecCatalog';

const REPO_ID = '880e8400-e29b-41d4-a716-446655440003';
const PROJECT_ID = '770e8400-e29b-41d4-a716-446655440002';

/** A fully-filtered view, used to prove every field survives a round trip. */
const FILTERED: SpecCatalogFilters = {
  q: 'orders',
  format: 'openapi',
  repositoryId: REPO_ID,
  projectId: PROJECT_ID,
  status: 'imported',
  sort: 'recent',
  allBranches: true,
  importableOnly: false,
  offset: 100,
};

describe('reading a view out of the URL', () => {
  test('an empty URL is the default catalog', () => {
    expect(specCatalogFiltersFromSearchParams(new URLSearchParams())).toEqual(
      DEFAULT_SPEC_CATALOG_FILTERS
    );
  });

  test('a shared link rebuilds the exact view it was copied from', () => {
    const url = specCatalogUrlQuery(FILTERED);
    expect(specCatalogFiltersFromSearchParams(new URLSearchParams(url))).toEqual(FILTERED);
  });

  test('an unknown sort falls back rather than reaching the API', () => {
    const params = new URLSearchParams({ sort: 'created_at' });
    expect(specCatalogFiltersFromSearchParams(params).sort).toBe(
      DEFAULT_SPEC_CATALOG_FILTERS.sort
    );
  });

  test('every offered sort survives a round trip through the URL', () => {
    for (const option of SPEC_CATALOG_SORT_OPTIONS) {
      const url = specCatalogUrlQuery({ ...DEFAULT_SPEC_CATALOG_FILTERS, sort: option.value });
      expect(specCatalogFiltersFromSearchParams(new URLSearchParams(url)).sort).toBe(
        option.value
      );
    }
  });

  test('a negative or unparseable offset resets to the first page', () => {
    for (const raw of ['-50', 'abc', '']) {
      const params = new URLSearchParams({ offset: raw });
      expect(specCatalogFiltersFromSearchParams(params).offset).toBe(0);
    }
  });

  test('the booleans accept both `true` and `1`', () => {
    const params = new URLSearchParams({ all_branches: '1', importable_only: 'false' });
    const filters = specCatalogFiltersFromSearchParams(params);
    expect(filters.allBranches).toBe(true);
    expect(filters.importableOnly).toBe(false);
  });
});

describe('writing a view into the URL', () => {
  test('the default catalog has a clean link', () => {
    expect(specCatalogUrlQuery(DEFAULT_SPEC_CATALOG_FILTERS)).toBe('');
  });

  test('only what differs from the default is written', () => {
    const url = new URLSearchParams(
      specCatalogUrlQuery({ ...DEFAULT_SPEC_CATALOG_FILTERS, format: 'arazzo' })
    );
    expect(url.get('format')).toBe('arazzo');
    expect(url.has('status')).toBe(false);
    expect(url.has('sort')).toBe(false);
    expect(url.has('limit')).toBe(false);
  });

  test('a whitespace-only search is not a filter', () => {
    expect(specCatalogUrlQuery({ ...DEFAULT_SPEC_CATALOG_FILTERS, q: '   ' })).toBe('');
  });
});

describe('building the API request', () => {
  test('an `all` selection is dropped rather than sent as a filter value', () => {
    const qs = new URLSearchParams(specCatalogApiQuery(DEFAULT_SPEC_CATALOG_FILTERS));
    expect(qs.has('format')).toBe(false);
    expect(qs.has('status')).toBe(false);
    expect(qs.has('repository_id')).toBe(false);
    expect(qs.has('project_id')).toBe(false);
  });

  test('the page size and offset are always explicit', () => {
    const qs = new URLSearchParams(
      specCatalogApiQuery({ ...DEFAULT_SPEC_CATALOG_FILTERS, offset: 50 })
    );
    expect(qs.get('limit')).toBe(String(SPEC_CATALOG_PAGE_SIZE));
    expect(qs.get('offset')).toBe('50');
  });

  test('the search term is trimmed before it is sent', () => {
    const qs = new URLSearchParams(
      specCatalogApiQuery({ ...DEFAULT_SPEC_CATALOG_FILTERS, q: '  orders  ' })
    );
    expect(qs.get('q')).toBe('orders');
  });

  test('every filter reaches the API under its REST parameter name', () => {
    const qs = new URLSearchParams(specCatalogApiQuery(FILTERED));
    expect(qs.get('q')).toBe('orders');
    expect(qs.get('format')).toBe('openapi');
    expect(qs.get('repository_id')).toBe(REPO_ID);
    expect(qs.get('project_id')).toBe(PROJECT_ID);
    expect(qs.get('status')).toBe('imported');
    expect(qs.get('sort')).toBe('recent');
    expect(qs.get('all_branches')).toBe('true');
    expect(qs.get('importable_only')).toBe('false');
  });

  test('facets are only requested when asked for', () => {
    expect(new URLSearchParams(specCatalogApiQuery(FILTERED)).has('include_facets')).toBe(false);
    const withFacets = new URLSearchParams(
      specCatalogApiQuery(FILTERED, { includeFacets: true })
    );
    expect(withFacets.get('include_facets')).toBe('true');
  });
});

describe('detecting an active filter', () => {
  test('the default catalog has none', () => {
    expect(specCatalogHasActiveFilters(DEFAULT_SPEC_CATALOG_FILTERS)).toBe(false);
  });

  test('paging is not a filter — page 3 of an unfiltered catalog is still unfiltered', () => {
    expect(
      specCatalogHasActiveFilters({ ...DEFAULT_SPEC_CATALOG_FILTERS, offset: 100 })
    ).toBe(false);
  });

  test('sorting is not a filter either', () => {
    expect(specCatalogHasActiveFilters({ ...DEFAULT_SPEC_CATALOG_FILTERS, sort: 'path' })).toBe(
      false
    );
  });

  test.each([
    ['a search', { q: 'orders' }],
    ['a format', { format: 'openapi' }],
    ['a repository', { repositoryId: REPO_ID }],
    ['a project', { projectId: PROJECT_ID }],
    ['a status', { status: 'mapped' }],
    ['branch widening', { allBranches: true }],
    ['non-importable files', { importableOnly: false }],
  ])('%s counts as active', (_label, patch) => {
    expect(specCatalogHasActiveFilters({ ...DEFAULT_SPEC_CATALOG_FILTERS, ...patch })).toBe(true);
  });
});

describe('status badges', () => {
  test.each([
    ['needs_attention', 'Needs attention', 'red'],
    ['imported', 'Imported', 'emerald'],
    ['mapped', 'Mapped', 'blue'],
    ['discovered', 'Discovered', 'gray'],
  ])('%s renders as %s', (status, label, tone) => {
    const badge = specCatalogStatusBadge(status);
    expect(badge.label).toBe(label);
    expect(badge.className).toContain(tone);
    expect(badge.title.length).toBeGreaterThan(0);
  });

  test('every badge styles both colour schemes', () => {
    for (const status of ['needs_attention', 'imported', 'mapped', 'discovered']) {
      expect(specCatalogStatusBadge(status).className).toMatch(/dark:/);
    }
  });

  test('an unrecognised status stays legible instead of rendering blank', () => {
    const badge = specCatalogStatusBadge('quarantined');
    expect(badge.label).toBe('quarantined');
    expect(badge.className).toContain('gray');
  });
});

describe('splitting a spec path for display', () => {
  test('a nested path separates its directory from its file name', () => {
    expect(splitSpecPath('services/orders/openapi.yaml')).toEqual({
      dir: 'services/orders/',
      file: 'openapi.yaml',
    });
  });

  test('a root-level path has no directory', () => {
    expect(splitSpecPath('openapi.yaml')).toEqual({ dir: '', file: 'openapi.yaml' });
  });
});
