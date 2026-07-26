/**
 * Unit tests for the Catalog dashboard sorter (MFI-23.3, #4012).
 *
 * Mirrors the Projects sorter's behaviour (stable, "unknowns last") and exercises the catalog-only
 * `grade` and `format` columns plus the shared name/description/quality/status/creator/created/
 * updated columns, in both directions.
 */

import {
  nextCatalogDashboardSort,
  sortCatalogDashboardRows,
  compareCatalogDashboardRows,
  type CatalogSortRow,
} from '@/app/utils/catalog-dashboard-sort';

function row(partial: Partial<CatalogSortRow> & { id: string; name: string }): CatalogSortRow {
  return {
    enabled: true,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    creator_name: 'Ada Lovelace',
    creator_email: 'ada@example.com',
    description: '',
    slug: partial.name.toLowerCase(),
    ...partial,
  };
}

const names = (rows: CatalogSortRow[]) => rows.map((r) => r.name);

describe('sortCatalogDashboardRows', () => {
  it('returns a new array and does not mutate the input', () => {
    const input = [row({ id: '2', name: 'Beta' }), row({ id: '1', name: 'Alpha' })];
    const snapshot = names(input);
    const out = sortCatalogDashboardRows(input, 'name', 'asc');
    expect(out).not.toBe(input);
    expect(names(input)).toEqual(snapshot); // input untouched
    expect(names(out)).toEqual(['Alpha', 'Beta']);
  });

  it('leaves order untouched when column is null', () => {
    const input = [row({ id: '2', name: 'Beta' }), row({ id: '1', name: 'Alpha' })];
    expect(names(sortCatalogDashboardRows(input, null, 'asc'))).toEqual(['Beta', 'Alpha']);
  });

  it('sorts by name case-insensitively and respects direction', () => {
    const input = [
      row({ id: '1', name: 'gamma' }),
      row({ id: '2', name: 'Alpha' }),
      row({ id: '3', name: 'beta' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'name', 'asc'))).toEqual(['Alpha', 'beta', 'gamma']);
    expect(names(sortCatalogDashboardRows(input, 'name', 'desc'))).toEqual(['gamma', 'beta', 'Alpha']);
  });

  it('breaks name ties by slug', () => {
    const input = [
      row({ id: '1', name: 'Same', slug: 'zeta' }),
      row({ id: '2', name: 'Same', slug: 'alpha' }),
    ];
    expect(sortCatalogDashboardRows(input, 'name', 'asc').map((r) => r.slug)).toEqual(['alpha', 'zeta']);
  });
});

describe('quality column', () => {
  it('orders by score with nulls always last regardless of direction', () => {
    const input = [
      row({ id: '1', name: 'A', qualityScore: 50 }),
      row({ id: '2', name: 'B', qualityScore: null }),
      row({ id: '3', name: 'C', qualityScore: 90 }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'quality', 'asc'))).toEqual(['A', 'C', 'B']);
    expect(names(sortCatalogDashboardRows(input, 'quality', 'desc'))).toEqual(['C', 'A', 'B']);
  });
});

describe('grade column', () => {
  it('orders letter grades alphabetically with blanks last', () => {
    const input = [
      row({ id: '1', name: 'A', qualityGrade: 'B' }),
      row({ id: '2', name: 'B', qualityGrade: null }),
      row({ id: '3', name: 'C', qualityGrade: 'A' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'grade', 'asc'))).toEqual(['C', 'A', 'B']);
    expect(names(sortCatalogDashboardRows(input, 'grade', 'desc'))).toEqual(['A', 'C', 'B']);
  });
});

describe('format column', () => {
  it('orders by sourceFormat with unknown formats last', () => {
    const input = [
      row({ id: '1', name: 'A', sourceFormat: 'graphql' }),
      row({ id: '2', name: 'B', sourceFormat: null }),
      row({ id: '3', name: 'C', sourceFormat: 'asyncapi' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'format', 'asc'))).toEqual(['C', 'A', 'B']);
    expect(names(sortCatalogDashboardRows(input, 'format', 'desc'))).toEqual(['A', 'C', 'B']);
  });

  it('breaks format ties by protocol', () => {
    const input = [
      row({ id: '1', name: 'A', sourceFormat: 'asyncapi', protocol: 'mqtt' }),
      row({ id: '2', name: 'B', sourceFormat: 'asyncapi', protocol: 'amqp' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'format', 'asc'))).toEqual(['B', 'A']);
  });

  it('falls back to protocol when both formats are unknown', () => {
    const input = [
      row({ id: '1', name: 'A', sourceFormat: null, protocol: 'mqtt' }),
      row({ id: '2', name: 'B', sourceFormat: null, protocol: 'amqp' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'format', 'asc'))).toEqual(['B', 'A']);
  });
});

describe('nextCatalogDashboardSort', () => {
  it('reverses the direction when the active column is clicked again', () => {
    expect(nextCatalogDashboardSort({ column: 'name', direction: 'asc' }, 'name')).toEqual({
      column: 'name',
      direction: 'desc',
    });
    expect(nextCatalogDashboardSort({ column: 'name', direction: 'desc' }, 'name')).toEqual({
      column: 'name',
      direction: 'asc',
    });
  });

  it('keeps toggling on every further click, never sticking in one direction', () => {
    let state = { column: 'quality', direction: 'asc' } as ReturnType<typeof nextCatalogDashboardSort>;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      state = nextCatalogDashboardSort(state, 'quality');
      seen.push(state.direction);
    }
    expect(seen).toEqual(['desc', 'asc', 'desc', 'asc']);
  });

  it('starts a newly selected column ascending, whichever way the previous one ran', () => {
    expect(nextCatalogDashboardSort({ column: 'name', direction: 'desc' }, 'updated')).toEqual({
      column: 'updated',
      direction: 'asc',
    });
  });

  it('is pure — calling it twice with the same input gives the same result', () => {
    // React invokes state updaters twice under StrictMode; the toggle must not depend on how many
    // times it runs, which is exactly what the nested-setState version got wrong.
    const current = { column: 'grade', direction: 'asc' } as const;
    expect(nextCatalogDashboardSort(current, 'grade')).toEqual(
      nextCatalogDashboardSort(current, 'grade'),
    );
  });
});

describe('protocol column', () => {
  it('orders by protocol with unknown protocols last, tie-broken by name', () => {
    const input = [
      row({ id: '1', name: 'A', protocol: 'mqtt' }),
      row({ id: '2', name: 'B', protocol: null }),
      row({ id: '3', name: 'C', protocol: 'amqp' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'protocol', 'asc'))).toEqual(['C', 'A', 'B']);
    expect(names(sortCatalogDashboardRows(input, 'protocol', 'desc'))).toEqual(['A', 'C', 'B']);
  });

  it('breaks protocol ties by name', () => {
    const input = [
      row({ id: '1', name: 'Zeta', protocol: 'grpc' }),
      row({ id: '2', name: 'Alpha', protocol: 'grpc' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'protocol', 'asc'))).toEqual(['Alpha', 'Zeta']);
  });
});

describe('source column', () => {
  it('orders by the resolved source label, with unrecorded sources last', () => {
    const input = [
      row({ id: '1', name: 'A', formatMetadata: { sourceLabel: 'zeta.proto', inputKind: 'file' } }),
      row({ id: '2', name: 'B' }), // no provenance recorded at all
      row({ id: '3', name: 'C', formatMetadata: { sourceLabel: 'alpha.graphql', inputKind: 'file' } }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'source', 'asc'))).toEqual(['C', 'A', 'B']);
    expect(names(sortCatalogDashboardRows(input, 'source', 'desc'))).toEqual(['A', 'C', 'B']);
  });

  it('falls back to the generic metadata bag and sorts on the displayed URL label', () => {
    const input = [
      row({ id: '1', name: 'A', metadata: { sourceUri: 'https://zeta.example.com/schema.graphql' } }),
      row({ id: '2', name: 'B', metadata: { sourceUri: 'https://alpha.example.com/schema.graphql' } }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'source', 'asc'))).toEqual(['B', 'A']);
  });

  it('breaks source ties by name', () => {
    const input = [
      row({ id: '1', name: 'Zeta', formatMetadata: { sourceLabel: 'same.proto', inputKind: 'file' } }),
      row({ id: '2', name: 'Alpha', formatMetadata: { sourceLabel: 'same.proto', inputKind: 'file' } }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'source', 'asc'))).toEqual(['Alpha', 'Zeta']);
  });
});

describe('status column', () => {
  it('orders active < disabled < deleted', () => {
    const input = [
      row({ id: '1', name: 'Deleted', deleted_at: '2026-02-01T00:00:00Z' }),
      row({ id: '2', name: 'Disabled', enabled: false }),
      row({ id: '3', name: 'Active', enabled: true }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'status', 'asc'))).toEqual(['Active', 'Disabled', 'Deleted']);
  });
});

describe('created / updated columns', () => {
  it('orders by timestamp ascending and descending', () => {
    const input = [
      row({ id: '1', name: 'Mid', created_at: '2026-03-01T00:00:00Z' }),
      row({ id: '2', name: 'Old', created_at: '2026-01-01T00:00:00Z' }),
      row({ id: '3', name: 'New', created_at: '2026-06-01T00:00:00Z' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'created', 'asc'))).toEqual(['Old', 'Mid', 'New']);
    expect(names(sortCatalogDashboardRows(input, 'created', 'desc'))).toEqual(['New', 'Mid', 'Old']);
  });

  it('puts unparseable dates last', () => {
    const input = [
      row({ id: '1', name: 'Bad', updated_at: 'not-a-date' }),
      row({ id: '2', name: 'Good', updated_at: '2026-01-01T00:00:00Z' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'updated', 'asc'))).toEqual(['Good', 'Bad']);
    expect(names(sortCatalogDashboardRows(input, 'updated', 'desc'))).toEqual(['Good', 'Bad']);
  });
});

describe('creator and description columns', () => {
  it('sorts by creator name then email', () => {
    const input = [
      row({ id: '1', name: 'A', creator_name: 'Same', creator_email: 'z@example.com' }),
      row({ id: '2', name: 'B', creator_name: 'Same', creator_email: 'a@example.com' }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'creator', 'asc'))).toEqual(['B', 'A']);
  });

  it('sorts by description, folding in the metadata summary', () => {
    const input = [
      row({ id: '1', name: 'A', description: 'zebra' }),
      row({ id: '2', name: 'B', description: '', metadata: { summary: 'apple' } }),
    ];
    expect(names(sortCatalogDashboardRows(input, 'description', 'asc'))).toEqual(['B', 'A']);
  });
});

describe('compareCatalogDashboardRows', () => {
  it('treats equal rows as 0 for an unknown column (default branch)', () => {
    const a = row({ id: '1', name: 'A' });
    const b = row({ id: '2', name: 'B' });
    // @ts-expect-error — exercising the defensive default branch with an invalid column.
    expect(compareCatalogDashboardRows(a, b, 'nope', 'asc')).toBe(0);
  });
});
