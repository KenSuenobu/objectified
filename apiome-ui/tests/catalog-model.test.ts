/**
 * The rules the Catalog list runs on (HIVE-7.1, #5318).
 *
 * `catalogModel.ts` is where the screen's decisions moved out of a 1,651-line `page.tsx`, so
 * this suite is where they can be asserted without rendering anything: which chip counts what,
 * which rows the four quick filters keep, what the facet's counts answer, which verbs a row
 * offers, what the header sentence reads and what the permanent-delete gate asks for.
 *
 * Every acceptance criterion of the ticket that is a *rule* rather than a *pixel* is here:
 *
 *   - facet counts reflect the active filter set, and Clear-all restores;
 *   - the identity-group chip's label;
 *   - a deleted item offers exactly two verbs;
 *   - the two views cannot disagree about a score, because there is one derivation.
 */

import {
  CATALOG_FACETS,
  CATALOG_FILTER_ANY,
  CATALOG_GRADE_OPTIONS,
  CATALOG_GRADE_UNSCORED,
  CATALOG_PROTOCOL_OPTIONS,
  CATALOG_SORT_OPTIONS,
  CATALOG_SOURCE_OPTIONS,
  DEFAULT_CATALOG_SORT,
  EMPTY_CATALOG_FILTERS,
  catalogBulkPlan,
  catalogBulkResultMessage,
  catalogFacetCounts,
  catalogFootLabel,
  catalogFormatFacetOptions,
  catalogIdentityGroupLabel,
  catalogItemGradeLetter,
  catalogItemHref,
  catalogLifecycle,
  catalogRowActions,
  catalogScores,
  catalogShortId,
  catalogSortLabel,
  catalogSummaryLine,
  catalogSummaryText,
  catalogVersionsHref,
  catalogVersionsLabel,
  isCatalogItemOpenable,
  isCatalogNarrowed,
  matchesCatalogFacet,
  matchesCatalogFilters,
  permanentDeleteCatalogItemConfirm,
  searchCatalog,
  softDeleteCatalogItemConfirm,
  sortCatalog,
  undeleteCatalogItemConfirm,
  type CatalogItem,
} from '../src/app/components/ade/catalog';

/** A catalog item with everything the model reads, overridable per case. */
function item(partial: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    tenant_id: 't-acme',
    name: 'Ledger Graph',
    slug: 'ledger-graph',
    description: 'Double-entry ledger schema exposed to finance tooling.',
    enabled: true,
    deleted_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-08-14T16:02:00.000Z',
    creator_name: 'Ada Lovelace',
    creator_email: 'ada@acme.io',
    metadata: null,
    qualityScore: 91,
    qualityGrade: 'A',
    versionsCount: 3,
    publishable: false,
    sourceFormat: 'graphql',
    protocol: 'graph',
    formatMetadata: { inputKind: 'file', fileName: 'ledger.graphql' },
    ...partial,
  };
}

const LEDGER = item();
const ORDERS = item({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Orders RPC',
  slug: 'orders-rpc',
  description: 'Order lifecycle service, as protobuf.',
  sourceFormat: 'protobuf',
  protocol: 'rpc',
  qualityScore: 74,
  qualityGrade: 'C',
  formatMetadata: { inputKind: 'url', sourceUrl: 'https://acme.io/orders.proto' },
});
const EVENTS = item({
  id: 'cccccccc-dddd-eeee-ffff-000000000000',
  name: 'Events Bus',
  slug: 'events-bus',
  description: 'Domain events published to the bus.',
  enabled: false,
  sourceFormat: 'asyncapi',
  protocol: 'event',
  qualityScore: null,
  qualityGrade: null,
  versionsCount: 1,
  formatMetadata: { inputKind: 'paste' },
});
const RETIRED = item({
  id: 'dddddddd-eeee-ffff-0000-111111111111',
  name: 'Legacy Graph',
  slug: 'legacy-graph',
  description: 'Superseded graph, kept for reference.',
  deleted_at: '2026-08-10T00:00:00.000Z',
  sourceFormat: 'graphql',
  protocol: 'graph',
  qualityScore: 58,
  qualityGrade: 'D',
});

const ALL = [LEDGER, ORDERS, EVENTS, RETIRED];

/* -------------------------------------------------------------------------
   Lifecycle
   ------------------------------------------------------------------------- */

describe('lifecycle', () => {
  it('reports one state, not two flags', () => {
    expect(catalogLifecycle(LEDGER)).toBe('active');
    expect(catalogLifecycle(EVENTS)).toBe('disabled');
    expect(catalogLifecycle(RETIRED)).toBe('deleted');
  });

  it('reports a disabled-and-deleted item as deleted — the outer state wins', () => {
    expect(catalogLifecycle(item({ enabled: false, deleted_at: '2026-01-01' }))).toBe('deleted');
  });

  it('opens everything except a deleted item', () => {
    expect(isCatalogItemOpenable(LEDGER)).toBe(true);
    expect(isCatalogItemOpenable(EVENTS)).toBe(true);
    expect(isCatalogItemOpenable(RETIRED)).toBe(false);
  });

  it('routes detail and versions to the two places an item lives', () => {
    expect(catalogItemHref(LEDGER)).toBe(`/ade/dashboard/catalog/${LEDGER.id}`);
    expect(catalogVersionsHref(LEDGER)).toBe(`/ade/dashboard/versions?projectId=${LEDGER.id}`);
  });
});

/* -------------------------------------------------------------------------
   The view chips
   ------------------------------------------------------------------------- */

describe('view chips', () => {
  it('draws the mockup’s four, in order', () => {
    expect([...CATALOG_FACETS]).toEqual(['all', 'active', 'attention', 'deleted']);
  });

  it('counts a deleted item under both "needs attention" and "deleted"', () => {
    // The chips narrow the list; they do not partition it.
    expect(matchesCatalogFacet(RETIRED, 'attention')).toBe(true);
    expect(matchesCatalogFacet(RETIRED, 'deleted')).toBe(true);
    expect(matchesCatalogFacet(RETIRED, 'active')).toBe(false);
  });

  it('counts a disabled item as needing attention without calling it deleted', () => {
    expect(matchesCatalogFacet(EVENTS, 'attention')).toBe(true);
    expect(matchesCatalogFacet(EVENTS, 'deleted')).toBe(false);
  });

  it('counts over whatever it is handed, so the counts follow the other controls', () => {
    expect(catalogFacetCounts(ALL)).toEqual({ all: 4, active: 2, attention: 2, deleted: 1 });
    // Narrow to the two GraphQL rows first: the chips describe *that* set.
    const graphOnly = ALL.filter((row) =>
      matchesCatalogFilters(row, { ...EMPTY_CATALOG_FILTERS, formats: ['graphql'] })
    );
    expect(catalogFacetCounts(graphOnly)).toEqual({ all: 2, active: 1, attention: 1, deleted: 1 });
  });
});

/* -------------------------------------------------------------------------
   Search
   ------------------------------------------------------------------------- */

describe('search', () => {
  it('returns a copy of the list for a blank query', () => {
    const out = searchCatalog(ALL, '   ');
    expect(out).toEqual(ALL);
    expect(out).not.toBe(ALL);
  });

  it('matches the name, the slug and the description', () => {
    expect(searchCatalog(ALL, 'ledger').map((row) => row.name)).toEqual(['Ledger Graph']);
    expect(searchCatalog(ALL, 'orders-rpc').map((row) => row.name)).toEqual(['Orders RPC']);
    expect(searchCatalog(ALL, 'double-entry').map((row) => row.name)).toEqual(['Ledger Graph']);
  });

  it('matches a format by an alias the item does not literally carry', () => {
    // The row is stored as `protobuf`; `grpc` is the word a reader will type.
    expect(ORDERS.sourceFormat).toBe('protobuf');
    expect(searchCatalog(ALL, 'grpc').map((row) => row.name)).toEqual(['Orders RPC']);
  });
});

/* -------------------------------------------------------------------------
   The quick filters
   ------------------------------------------------------------------------- */

describe('quick filters', () => {
  it('starts every axis neutral, which is what Clear-all restores', () => {
    expect(EMPTY_CATALOG_FILTERS).toEqual({
      formats: [],
      protocol: CATALOG_FILTER_ANY,
      source: CATALOG_FILTER_ANY,
      grade: CATALOG_FILTER_ANY,
    });
    for (const row of ALL) expect(matchesCatalogFilters(row, EMPTY_CATALOG_FILTERS)).toBe(true);
  });

  it('offers the neutral option first in all three selects', () => {
    for (const options of [
      CATALOG_PROTOCOL_OPTIONS,
      CATALOG_SOURCE_OPTIONS,
      CATALOG_GRADE_OPTIONS,
    ]) {
      expect(options[0].value).toBe(CATALOG_FILTER_ANY);
    }
  });

  it('narrows by format family, collapsing gRPC and Protobuf into one', () => {
    const kept = ALL.filter((row) =>
      matchesCatalogFilters(row, { ...EMPTY_CATALOG_FILTERS, formats: ['protobuf'] })
    );
    expect(kept.map((row) => row.name)).toEqual(['Orders RPC']);
  });

  it('narrows by protocol through the registry, so an alias still matches', () => {
    const kept = ALL.filter((row) =>
      matchesCatalogFilters(row, { ...EMPTY_CATALOG_FILTERS, protocol: 'graph' })
    );
    expect(kept.map((row) => row.name)).toEqual(['Ledger Graph', 'Legacy Graph']);
  });

  it('narrows by the input kind the item was imported through', () => {
    const byUrl = ALL.filter((row) =>
      matchesCatalogFilters(row, { ...EMPTY_CATALOG_FILTERS, source: 'url' })
    );
    expect(byUrl.map((row) => row.name)).toEqual(['Orders RPC']);
  });

  it('narrows by the grade the orbs actually show, not by the stored letter alone', () => {
    // No captured grade, but a score — the row still has a letter, and the filter finds it.
    const derived = item({ id: 'e', name: 'Derived', qualityGrade: null, qualityScore: 91 });
    expect(catalogItemGradeLetter(derived)).toBe('A');
    expect(matchesCatalogFilters(derived, { ...EMPTY_CATALOG_FILTERS, grade: 'A' })).toBe(true);
  });

  it('keeps only genuinely unscored rows under Unscored', () => {
    const kept = ALL.filter((row) =>
      matchesCatalogFilters(row, { ...EMPTY_CATALOG_FILTERS, grade: CATALOG_GRADE_UNSCORED })
    );
    expect(kept.map((row) => row.name)).toEqual(['Events Bus']);
  });

  it('composes the four axes', () => {
    const kept = ALL.filter((row) =>
      matchesCatalogFilters(row, {
        formats: ['graphql'],
        protocol: 'graph',
        source: 'file',
        grade: 'A',
      })
    );
    expect(kept.map((row) => row.name)).toEqual(['Ledger Graph']);
  });

  it('knows when anything at all is narrowing the list', () => {
    expect(isCatalogNarrowed('', 'all', EMPTY_CATALOG_FILTERS)).toBe(false);
    expect(isCatalogNarrowed('  ', 'all', EMPTY_CATALOG_FILTERS)).toBe(false);
    expect(isCatalogNarrowed('x', 'all', EMPTY_CATALOG_FILTERS)).toBe(true);
    expect(isCatalogNarrowed('', 'deleted', EMPTY_CATALOG_FILTERS)).toBe(true);
    expect(
      isCatalogNarrowed('', 'all', { ...EMPTY_CATALOG_FILTERS, formats: ['graphql'] })
    ).toBe(true);
    expect(isCatalogNarrowed('', 'all', { ...EMPTY_CATALOG_FILTERS, grade: 'C' })).toBe(true);
  });
});

/* -------------------------------------------------------------------------
   The format facet
   ------------------------------------------------------------------------- */

describe('the format facet', () => {
  it('offers only the families present in the rows it is given', () => {
    expect(catalogFormatFacetOptions(ALL).map((option) => option.id).sort()).toEqual([
      'asyncapi',
      'graphql',
      'protobuf',
    ]);
  });

  it('counts each family over exactly those rows', () => {
    const byId = new Map(catalogFormatFacetOptions(ALL).map((o) => [o.id, o.count]));
    expect(byId.get('graphql')).toBe(2);
    expect(byId.get('protobuf')).toBe(1);
    expect(byId.get('asyncapi')).toBe(1);
  });

  it('counts what ticking would show — the rows the other controls left', () => {
    // The ticket's acceptance criterion. With the Deleted chip on, GraphQL is one row, not two.
    const deletedOnly = ALL.filter((row) => matchesCatalogFacet(row, 'deleted'));
    const byId = new Map(catalogFormatFacetOptions(deletedOnly).map((o) => [o.id, o.count]));
    expect(byId.get('graphql')).toBe(1);
    expect(byId.has('protobuf')).toBe(false);
  });

  it('keeps a ticked family listed at zero, so the menu can always un-tick it', () => {
    const options = catalogFormatFacetOptions([], ['graphql']);
    expect(options).toEqual([{ id: 'graphql', label: 'GraphQL', count: 0 }]);
  });

  it('names the gRPC/Protobuf family once, by its shared label', () => {
    expect(catalogFormatFacetOptions([ORDERS])[0]).toEqual({
      id: 'protobuf',
      label: 'gRPC / Protobuf',
      count: 1,
    });
  });

  it('lists the families alphabetically by label', () => {
    // `localeCompare`, so case does not decide the order: `GraphQL` sorts before
    // `gRPC / Protobuf` on the third letter, not on the second's capitalisation.
    expect(catalogFormatFacetOptions(ALL).map((option) => option.label)).toEqual([
      'AsyncAPI',
      'GraphQL',
      'gRPC / Protobuf',
    ]);
  });
});

/* -------------------------------------------------------------------------
   Scores and copy
   ------------------------------------------------------------------------- */

describe('scores', () => {
  it('prefers the server-captured score — a catalog item is usually server-imported', () => {
    const scores = catalogScores(LEDGER, [
      { overall: 12, grade: 'F', at: '2026-01-01T00:00:00.000Z' } as never,
    ]);
    expect(scores.quality).toBe(91);
    expect(scores.grade).toBe('A');
  });

  it('falls back to this browser’s history when the server has not scored it', () => {
    const scores = catalogScores(item({ qualityScore: null, qualityGrade: null }), [
      { overall: 64, grade: 'C', at: '2026-01-01T00:00:00.000Z' } as never,
    ]);
    expect(scores.quality).toBe(64);
    expect(scores.grade).toBe('C');
  });

  it('reports no score rather than a zero when nothing has measured it', () => {
    const scores = catalogScores(EVENTS);
    expect(scores.quality).toBeNull();
    expect(scores.grade).toBeNull();
  });

  it('carries the revision count both views print', () => {
    expect(catalogScores(LEDGER).versionsCount).toBe(3);
    expect(catalogScores(item({ versionsCount: undefined })).versionsCount).toBe(0);
    expect(catalogVersionsLabel(1)).toBe('1 version');
    expect(catalogVersionsLabel(0)).toBe('0 versions');
  });
});

describe('copy', () => {
  it('prints the mockup’s short id', () => {
    expect(catalogShortId(LEDGER.id)).toBe('cat_111111');
    expect(catalogShortId('4d1e9a2b-0000-0000-0000-000000000000')).toBe('cat_4d1e9a');
  });

  it('prefers the summary, then the description, then says there is neither', () => {
    expect(catalogSummaryText(item({ metadata: { summary: 'Ledger, in GraphQL.' } }))).toBe(
      'Ledger, in GraphQL.'
    );
    expect(catalogSummaryText(item({ metadata: null }))).toBe(
      'Double-entry ledger schema exposed to finance tooling.'
    );
    expect(catalogSummaryText(item({ metadata: null, description: '  ' }))).toBe(
      'No description yet.'
    );
  });

  it('writes the header sentence over the live catalog only', () => {
    expect(catalogSummaryLine(ALL, false)).toBe('3 items · 3 formats · avg quality B · 83');
  });

  it('names the deleted count only when the switch that reveals them is on', () => {
    expect(catalogSummaryLine(ALL, false)).not.toContain('deleted');
    expect(catalogSummaryLine(ALL, true)).toContain('1 deleted');
  });

  it('names a conversion when there is one', () => {
    const converted = item({ id: 'z', conversion: { projectId: 'p-1', projectName: 'Ledger API' } });
    expect(catalogSummaryLine([converted], false)).toContain('1 converted');
  });

  it('labels the identity-group chip the way the mockup does', () => {
    expect(catalogIdentityGroupLabel('idg_7c21e9aa-bbbb')).toBe('Identity group idg_7c21…');
  });
});

/* -------------------------------------------------------------------------
   Sorting
   ------------------------------------------------------------------------- */

describe('sorting', () => {
  it('starts on name ascending, as the mockup’s toolbar says', () => {
    expect(DEFAULT_CATALOG_SORT).toEqual({ column: 'name', direction: 'asc' });
    expect(catalogSortLabel(null)).toBe('artifact ↑');
  });

  it('offers the mockup’s six menu entries', () => {
    expect(CATALOG_SORT_OPTIONS.map((option) => option.id)).toEqual([
      'name',
      'created',
      'updated',
      'quality',
      'grade',
      'format',
    ]);
  });

  it('orders by the chosen column and direction', () => {
    const byName = sortCatalog(ALL, { column: 'name', direction: 'asc' });
    expect(byName.map((row) => row.name)).toEqual([
      'Events Bus',
      'Ledger Graph',
      'Legacy Graph',
      'Orders RPC',
    ]);
    const desc = sortCatalog(ALL, { column: 'name', direction: 'desc' });
    expect(desc[0].name).toBe('Orders RPC');
  });

  it('falls back to the default for a column no comparator knows', () => {
    expect(sortCatalog(ALL, { column: 'nonsense', direction: 'desc' }).map((r) => r.name)).toEqual(
      sortCatalog(ALL, DEFAULT_CATALOG_SORT).map((r) => r.name)
    );
  });

  it('names a header-only column in the summary, so the phrase is never bare', () => {
    expect(catalogSortLabel({ column: 'protocol', direction: 'desc' })).toBe('protocol ↓');
  });

  it('writes the table foot', () => {
    expect(catalogFootLabel(7, DEFAULT_CATALOG_SORT)).toBe('7 items · sorted by artifact ↑');
    expect(catalogFootLabel(1, DEFAULT_CATALOG_SORT)).toBe('1 item · sorted by artifact ↑');
  });
});

/* -------------------------------------------------------------------------
   Row verbs
   ------------------------------------------------------------------------- */

describe('row verbs', () => {
  it('offers the mockup’s seven on a live item, and never Publish or Edit', () => {
    expect(catalogRowActions(LEDGER)).toEqual({
      details: true,
      versions: true,
      lint: true,
      export: true,
      convert: true,
      delete: true,
      undelete: false,
      permanentDelete: true,
    });
  });

  it('leaves a deleted item exactly two: put it back, or finish the job', () => {
    expect(catalogRowActions(RETIRED)).toEqual({
      details: false,
      versions: false,
      lint: false,
      export: false,
      convert: false,
      delete: false,
      undelete: true,
      permanentDelete: true,
    });
  });
});

/* -------------------------------------------------------------------------
   Destructive confirms
   ------------------------------------------------------------------------- */

describe('destructive confirms', () => {
  it('names the item and says how to get it back, without a gate', () => {
    const confirm = softDeleteCatalogItemConfirm(LEDGER);
    expect(confirm.title).toBe('Delete catalog item "Ledger Graph"?');
    expect(confirm.message).toContain('Show deleted');
    expect(confirm.typeToConfirm).toBeUndefined();
  });

  it('gates a permanent delete on the slug, not on the display name', () => {
    // Two items may share a display name; only one may hold a slug — and the slug is printed
    // on the very card the click came from.
    const confirm = permanentDeleteCatalogItemConfirm(LEDGER);
    expect(confirm.typeToConfirm).toBe('ledger-graph');
    expect(confirm.consequence).toBe('This is permanent and cannot be undone.');
    expect(confirm.confirmLabel).toBe('Delete everything');
  });

  it('falls back to the name rather than opening an ungated confirm', () => {
    const confirm = permanentDeleteCatalogItemConfirm(item({ slug: '   ' }));
    expect(confirm.typeToConfirm).toBe('Ledger Graph');
  });

  it('says what a permanent delete does not touch', () => {
    // A conversion already made is a *project*, and it survives.
    expect(permanentDeleteCatalogItemConfirm(LEDGER).message).toContain('OpenAPI project');
  });

  it('confirms an undelete without dressing it as destruction', () => {
    const confirm = undeleteCatalogItemConfirm(RETIRED);
    expect(confirm.variant).toBe('info');
    expect(confirm.confirmLabel).toBe('Undelete item');
  });
});

/* -------------------------------------------------------------------------
   Selection
   ------------------------------------------------------------------------- */

describe('bulk selection', () => {
  it('splits a mixed selection into the two verbs that apply to it', () => {
    const plan = catalogBulkPlan(ALL, [LEDGER.id, RETIRED.id, EVENTS.id]);
    expect(plan.deletable.map((row) => row.name)).toEqual(['Ledger Graph', 'Events Bus']);
    expect(plan.restorable.map((row) => row.name)).toEqual(['Legacy Graph']);
  });

  it('ignores an id that is no longer on screen', () => {
    expect(catalogBulkPlan(ALL, ['not-here'])).toEqual({ deletable: [], restorable: [] });
  });

  it('states the split when a bulk write is only partly applied', () => {
    expect(catalogBulkResultMessage('Deleted', 5, 5)).toBe('Deleted 5 catalog items.');
    expect(catalogBulkResultMessage('Deleted', 1, 1)).toBe('Deleted 1 catalog item.');
    expect(catalogBulkResultMessage('Deleted', 3, 5, 'Forbidden')).toBe(
      'Deleted 3 of 5 catalog items · 2 refused — Forbidden'
    );
  });
});
