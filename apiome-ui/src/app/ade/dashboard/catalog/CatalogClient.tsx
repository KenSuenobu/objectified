'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { LayoutGrid, Link2, List, Rows3, Trash2, TriangleAlert, Undo2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

import { useAuthSession } from '@lib/auth/session-client';
import type { ShortcutBinding } from '@lib/shortcuts';
import { deleteProject, permanentDeleteProject, restoreProject } from '@lib/db/helper';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { useShortcuts } from '@/app/hooks/useShortcuts';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import {
  DataTableBulkAction,
  DataTableFilterChip,
  DataTableSearch,
  DataTableToolbar,
  DataTableToolbarSpacer,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { EmptyState, GatedState } from '@/app/components/ui/EmptyState';
import { Label } from '@/app/components/ui/Label';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { Switch } from '@/app/components/ui/Switch';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { ProjectQualityHistoryDialog } from '@/app/components/ade/dashboard/ProjectQualityHistoryDialog';
import { CatalogLintReportDialog } from '@/app/components/ade/dashboard/catalog/CatalogLintReportDialog';
import { ConversionPreviewDialog } from '@/app/components/ade/dashboard/catalog/ConversionPreviewDialog';
import {
  CatalogImportDialog,
  type JsonSchemaHandoffPayload,
} from '@/app/components/ade/dashboard/catalog/CatalogImportDialog';
import PrimitiveImportDialog, {
  type PrimitiveImportInitialSource,
} from '../primitives/PrimitiveImportDialog';
import {
  CATALOG_FACETS,
  CATALOG_FACET_LABELS,
  CATALOG_FILTER_ANY,
  CATALOG_GRADE_OPTIONS,
  CATALOG_PROTOCOL_OPTIONS,
  CATALOG_SORT_OPTIONS,
  CATALOG_SOURCE_OPTIONS,
  CatalogCard,
  CatalogFormatFacet,
  CatalogNonPublishableBanner,
  CatalogStatsRow,
  CatalogSupportedFormats,
  CatalogTable,
  EMPTY_CATALOG_FILTERS,
  catalogBulkPlan,
  catalogBulkResultMessage,
  catalogFacetCounts,
  catalogFormatFacetOptions,
  catalogIdentityGroupLabel,
  catalogItemHref,
  catalogSortKey,
  catalogSortLabel,
  catalogSummaryLine,
  catalogVersionsHref,
  isCatalogNarrowed,
  matchesCatalogFacet,
  matchesCatalogFilters,
  permanentDeleteCatalogItemConfirm,
  searchCatalog,
  softDeleteCatalogItemConfirm,
  sortCatalog,
  undeleteCatalogItemConfirm,
  type CatalogFacet,
  type CatalogFilterState,
  type CatalogItem,
} from '@/app/components/ade/catalog';
import { exportStudioHref } from '@/app/components/ade/dashboard/export/exportStudioLink';
import { normalizeCatalogListItem } from '@/app/utils/catalog-list-item';
import { catalogQualityOpensServerLintReport } from '@/app/utils/catalog-lint-panel';
import { groupCatalogItemsByParadigm } from '@/app/utils/catalog-paradigm-grouping';
import {
  getProjectQualityHistory,
  type ProjectQualitySnapshot,
} from '@/app/utils/project-quality-score-history';
import {
  loadCatalogViewPreferences,
  persistCatalogViewPreferences,
  type CatalogGroupMode,
  type CatalogViewMode,
} from '@/app/utils/catalog-view-preferences';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/**
 * Catalog — `/ade/dashboard/catalog` (HIVE-7.1, #5318).
 *
 * Authority: `docs/mockups/sources/catalog.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header), §8 (list page, destructive
 * confirms, keyboard), §3.1 (status vocabulary).
 *
 * ### What this screen is
 *
 * The `publishable = false` slice of projects (MFI-23.1): imports whose format does not map
 * 1:1 onto OpenAPI, stored as they arrived. Everything on it points at one promotion path —
 * **Convert to OpenAPI** — and there is deliberately no Publish and no Edit anywhere: an item
 * is minted by the import routing (MFI-23.7), not here, and only a conversion produces
 * something publishable. The `role="note"` banner at the top says exactly that, and is the one
 * piece of copy on this screen the mockup quotes verbatim.
 *
 * ### What this screen owns, and what it no longer does
 *
 * It owns the items, the three writes, which view is drawing them, and which overlay is open.
 * It does **not** own any of the rules: which chip counts what, which quality number wins,
 * what the header sentence reads, which verbs a row offers, what the permanent-delete gate
 * asks for — all of that is `catalogModel`, where it can be tested without rendering a
 * screen. The 1,651-line `page.tsx` this replaces had them inline, which is how the card and
 * the table came to disagree about a deleted item.
 *
 * ### The two views are one list
 *
 * Search, chips, the four quick filters, sort and selection live here, above both views, and
 * both are handed the same already-narrowed array. Making that true by construction is
 * cheaper than testing for it: there is only one `visible`.
 *
 * ### Five things this fixes rather than restyles
 *
 * 1. **Permanent delete was two native confirms.** The second restated the first — a delay
 *    dressed as a check. It is one gated dialog now, and the phrase is the item's **slug**.
 * 2. **The card was a button full of buttons.** `role="button"` with a `tabIndex` around three
 *    real buttons is `nested-interactive`, a serious axe finding. See `CatalogCard`.
 * 3. **A fetch failure was a `console.error` and an empty list.** An empty catalog and an
 *    unreachable one looked identical. The read's failure is now the table's error state, with
 *    a retry.
 * 4. **The list could not be acted on in bulk.** Restoring six items after a mistaken sweep
 *    meant six menus and six confirms; the mockup's bulk bar is one of each.
 * 5. **Three facets the mockup draws did not exist.** Protocol, Source and Grade were in the
 *    toolbar drawing and nowhere in the product; the format facet had no counts.
 */
export default function CatalogClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const identityGroupFilter = searchParams.get('identityGroupId');
  const { data: session } = useAuthSession();
  const { confirm, alert } = useDialog();

  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;
  const currentUserId = (session?.user as { user_id?: string } | undefined)?.user_id;

  // ---- the list ---------------------------------------------------------------------------

  const [items, setItems] = React.useState<CatalogItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  /*
   * The four persisted toolbar preferences (MFI-28.4) are hydrated once from localStorage so a
   * reload restores the last choices, then written back whenever any of them changes. The lazy
   * initializer runs only on the first render and is SSR-safe.
   */
  const [hydrated] = React.useState(() => loadCatalogViewPreferences());
  const [showDeleted, setShowDeleted] = React.useState(hydrated.showDeleted);
  const [view, setView] = React.useState<CatalogViewMode>(hydrated.viewMode);
  const [groupMode, setGroupMode] = React.useState<CatalogGroupMode>(hydrated.groupMode);
  const [sort, setSort] = React.useState<DataTableSortState | null>({
    column: hydrated.sortColumn,
    direction: hydrated.sortDirection,
  });

  const [query, setQuery] = React.useState('');
  const [facet, setFacet] = React.useState<CatalogFacet>('all');
  const [filters, setFilters] = React.useState<CatalogFilterState>(EMPTY_CATALOG_FILTERS);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);

  const searchRef = React.useRef<HTMLInputElement | null>(null);

  /**
   * Bumped whenever something may have written new quality snapshots, which is the only way
   * this screen learns that `localStorage` changed — an import finishing inside a dialog does
   * not re-render anything out here.
   */
  const [historyEpoch, setHistoryEpoch] = React.useState(0);

  const loadCatalog = React.useCallback(async () => {
    if (!currentTenantId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (showDeleted) params.set('include_deleted', 'true');
      if (identityGroupFilter) params.set('identityGroupId', identityGroupFilter);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const response = await fetch(`/api/catalog${qs}`);
      if (!response.ok) throw new Error(`Failed to load the catalog: ${response.statusText}`);
      const data = await response.json();
      if (!data.success || !Array.isArray(data.catalog)) {
        throw new Error(data.error || 'Failed to load the catalog');
      }
      setItems(
        (data.catalog as Record<string, unknown>[]).map(normalizeCatalogListItem) as CatalogItem[]
      );
      setLoadError(null);
    } catch (error) {
      // A read that failed and a catalog that is empty used to look identical here — the
      // screen logged to the console and rendered "Your catalog is empty".
      setItems([]);
      setLoadError(error instanceof Error ? error.message : 'Failed to load the catalog');
    } finally {
      setLoading(false);
    }
  }, [currentTenantId, identityGroupFilter, showDeleted]);

  React.useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  /** The Deleted chip cannot outlive the switch that reveals deleted rows. */
  React.useEffect(() => {
    if (!showDeleted && facet === 'deleted') setFacet('all');
  }, [showDeleted, facet]);

  React.useEffect(() => {
    // `catalogSortKey` is what turns `DataTable`'s open-ended `{column, direction}` back into
    // the closed union the preference store keeps, so a column that only the table's headers
    // offer (protocol, source, status) persists and an unknown one falls back to the default.
    const { column, direction } = catalogSortKey(sort);
    persistCatalogViewPreferences({
      viewMode: view,
      groupMode,
      showDeleted,
      sortColumn: column,
      sortDirection: direction,
    });
  }, [groupMode, showDeleted, sort, view]);

  // ---- quality history --------------------------------------------------------------------

  const historyById = React.useMemo<Record<string, ProjectQualitySnapshot[]>>(() => {
    const map: Record<string, ProjectQualitySnapshot[]> = {};
    for (const item of items) map[item.id] = getProjectQualityHistory(item.id);
    return map;
    // `historyEpoch` is a real dependency: it is what says the store has been written to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, historyEpoch]);

  // ---- narrowing --------------------------------------------------------------------------

  const searched = React.useMemo(() => searchCatalog(items, query), [items, query]);

  /**
   * The rows every control *except* the format facet has left.
   *
   * This is what the facet's counts are computed over, so a checkbox's number answers "how
   * many would I see if I ticked this" rather than "how many exist somewhere".
   */
  const beforeFormatFacet = React.useMemo(
    () =>
      searched.filter(
        (item) =>
          matchesCatalogFacet(item, facet) &&
          matchesCatalogFilters(
            item,
            { ...filters, formats: [] },
            historyById[item.id] ?? []
          )
      ),
    [facet, filters, historyById, searched]
  );

  const formatOptions = React.useMemo(
    () => catalogFormatFacetOptions(beforeFormatFacet, filters.formats),
    [beforeFormatFacet, filters.formats]
  );

  /** The chip counts, over the rows the search and the four quick filters left. */
  const counts = React.useMemo(
    () =>
      catalogFacetCounts(
        searched.filter((item) => matchesCatalogFilters(item, filters, historyById[item.id] ?? []))
      ),
    [filters, historyById, searched]
  );

  const visible = React.useMemo(
    () =>
      sortCatalog(
        searched.filter(
          (item) =>
            matchesCatalogFacet(item, facet) &&
            matchesCatalogFilters(item, filters, historyById[item.id] ?? [])
        ),
        sort
      ),
    [facet, filters, historyById, searched, sort]
  );

  const narrowed = isCatalogNarrowed(query, facet, filters);

  /** Selection follows the list: an id that has been filtered away must not be acted on. */
  React.useEffect(() => {
    setSelectedIds((current) => {
      const onScreen = new Set(visible.map((item) => item.id));
      const next = current.filter((id) => onScreen.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visible]);

  /*
   * Drop any ticked format that is no longer present, so the facet's count can never exceed
   * what its menu can un-tick. Guarded on a *loaded* list: while the first read is in flight
   * every row is absent, and clearing the selection then would silently discard a filter the
   * reader had set before a reload.
   */
  React.useEffect(() => {
    if (loading) return;
    const present = new Set(catalogFormatFacetOptions(items).map((option) => option.id));
    setFilters((current) => {
      const next = current.formats.filter((id) => present.has(id));
      return next.length === current.formats.length ? current : { ...current, formats: next };
    });
  }, [items, loading]);

  const summary = React.useMemo(
    () => catalogSummaryLine(items, showDeleted),
    [items, showDeleted]
  );

  const paradigmGroups = React.useMemo(() => groupCatalogItemsByParadigm(visible), [visible]);

  // ---- overlays ---------------------------------------------------------------------------

  const [qualityFor, setQualityFor] = React.useState<CatalogItem | null>(null);
  const [lintFor, setLintFor] = React.useState<CatalogItem | null>(null);
  const [convertFor, setConvertFor] = React.useState<CatalogItem | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [primitiveSource, setPrimitiveSource] =
    React.useState<PrimitiveImportInitialSource | null>(null);

  const openImport = React.useCallback(() => setImportOpen(true), []);

  /** Open quality details — the server lint report when scored, otherwise local history. */
  const openQuality = React.useCallback((item: CatalogItem) => {
    if (catalogQualityOpensServerLintReport([], item.qualityScore)) {
      setLintFor(item);
      return;
    }
    setQualityFor(item);
  }, []);

  const openLint = React.useCallback((item: CatalogItem) => setLintFor(item), []);
  const openDetail = React.useCallback(
    (item: CatalogItem) => router.push(catalogItemHref(item)),
    [router]
  );
  const openVersions = React.useCallback(
    (item: CatalogItem) => router.push(catalogVersionsHref(item)),
    [router]
  );

  /**
   * "Export to another format…" (MFX-41.2) — opens the Export Studio scoped to the item's
   * latest revision. Unlike Convert this emits a document and never mutates the item, which is
   * why both verbs are offered and why the menu row carries the sentence that tells them apart.
   */
  const openExport = React.useCallback(
    (item: CatalogItem) => {
      router.push(
        exportStudioHref({
          artifact: item.id,
          label: item.name,
          origin: 'catalog',
          sourceFormat: item.sourceFormat ?? null,
        })
      );
    },
    [router]
  );

  /** "Convert to OpenAPI" — opens the reviewed-conversion preview (MFI-22.4). */
  const openConvert = React.useCallback((item: CatalogItem) => setConvertFor(item), []);

  /*
   * `I` and `/` — DESIGN.md §8's list-page keys, and the two the mockup's header prints.
   * Registered only while a workspace is chosen, because both act on a list that does not
   * exist without one. There is no `N`: nothing on this screen creates an item by hand.
   */
  const shortcuts = React.useMemo<readonly ShortcutBinding[]>(
    () =>
      currentTenantId && currentUserId
        ? [
            {
              id: 'catalog-import',
              scope: 'list',
              description: 'Import to catalog',
              chord: { key: 'i' },
              run: openImport,
            },
            {
              id: 'catalog-filter',
              scope: 'list',
              description: 'Filter catalog',
              chord: { key: '/' },
              run: () => searchRef.current?.focus(),
            },
          ]
        : [],
    [currentTenantId, currentUserId, openImport]
  );
  useShortcuts(shortcuts);

  // ---- writes ------------------------------------------------------------------------------

  /**
   * Run one write, then reload the list.
   *
   * Every write on this screen returns the same JSON-in-a-string envelope from `lib/db/helper`
   * (a catalog item's id is a project id, so these are the project server actions), so
   * unwrapping it — and reporting a refusal as a sentence rather than as a thrown object — is
   * done once here.
   *
   * @param write The call.
   * @param fallback What to say if the refusal carried no message.
   * @returns `null` on success, or the sentence to show.
   */
  const runWrite = React.useCallback(
    async (write: () => Promise<string>, fallback: string): Promise<string | null> => {
      try {
        const parsed = JSON.parse(await write());
        if (parsed?.success) return null;
        return typeof parsed?.error === 'string' && parsed.error ? parsed.error : fallback;
      } catch (error) {
        return error instanceof Error && error.message ? error.message : fallback;
      }
    },
    []
  );

  const handleDelete = React.useCallback(
    async (item: CatalogItem) => {
      if (!(await confirm(softDeleteCatalogItemConfirm(item)))) return;
      setBusy(true);
      const failure = await runWrite(
        () => deleteProject(item.id),
        'Failed to delete the catalog item.'
      );
      setBusy(false);
      if (failure) return void alert({ message: failure, variant: 'error' });
      toast.success(`Deleted "${item.name}".`);
      await loadCatalog();
    },
    [alert, confirm, loadCatalog, runWrite]
  );

  const handleRestore = React.useCallback(
    async (item: CatalogItem) => {
      if (!(await confirm(undeleteCatalogItemConfirm(item)))) return;
      setBusy(true);
      const failure = await runWrite(
        () => restoreProject(item.id),
        'Failed to undelete the catalog item.'
      );
      setBusy(false);
      if (failure) return void alert({ message: failure, variant: 'error' });
      toast.success('Catalog item undeleted.');
      await loadCatalog();
    },
    [alert, confirm, loadCatalog, runWrite]
  );

  const handlePermanentDelete = React.useCallback(
    async (item: CatalogItem) => {
      if (!(await confirm(permanentDeleteCatalogItemConfirm(item)))) return;
      setBusy(true);
      const failure = await runWrite(
        () => permanentDeleteProject(item.id),
        'Failed to permanently delete the catalog item.'
      );
      setBusy(false);
      if (failure) return void alert({ message: failure, variant: 'error' });
      toast.success('Catalog item and all associated data have been permanently deleted.');
      await loadCatalog();
    },
    [alert, confirm, loadCatalog, runWrite]
  );

  /**
   * One bulk verb over the rows it applies to.
   *
   * Writes are sequential rather than parallel: these are the same endpoints a single-row
   * action calls, and firing eight of them at once at a soft-delete that cascades is how a
   * list page turns into a load test. The result states the split.
   */
  const runBulk = React.useCallback(
    async (
      rows: readonly CatalogItem[],
      write: (item: CatalogItem) => Promise<string>,
      verb: string,
      fallback: string
    ) => {
      setBusy(true);
      let applied = 0;
      let firstError: string | null = null;
      for (const item of rows) {
        const failure = await runWrite(() => write(item), fallback);
        if (failure) firstError ??= failure;
        else applied += 1;
      }
      setBusy(false);
      setSelectedIds([]);
      const message = catalogBulkResultMessage(verb, applied, rows.length, firstError);
      if (applied === rows.length) toast.success(message);
      else toast.error(message);
      await loadCatalog();
    },
    [loadCatalog, runWrite]
  );

  const bulk = React.useMemo(() => catalogBulkPlan(visible, selectedIds), [visible, selectedIds]);

  /** After a successful conversion, refresh so the promotion back-link appears. */
  const handleConverted = React.useCallback(() => {
    toast.success('Conversion complete — a new OpenAPI project was created.');
    void loadCatalog();
  }, [loadCatalog]);

  /*
   * Re-read the score store whenever the import wizard closes, not only when it reports
   * success: the wizard writes a snapshot the moment its analysis finishes, which is before —
   * and independently of — the success callback.
   */
  const importWasOpen = React.useRef(false);
  React.useEffect(() => {
    if (importWasOpen.current && !importOpen) setHistoryEpoch((epoch) => epoch + 1);
    importWasOpen.current = importOpen;
  }, [importOpen]);

  const clearFilters = React.useCallback(() => {
    setQuery('');
    setFacet('all');
    setFilters(EMPTY_CATALOG_FILTERS);
  }, []);

  // ---- the toolbar, shared by both views ---------------------------------------------------

  const handlers = {
    onOpenDetail: openDetail,
    onOpenVersions: openVersions,
    onOpenLint: openLint,
    onExport: openExport,
    onConvert: openConvert,
    onDelete: (item: CatalogItem) => void handleDelete(item),
    onRestore: (item: CatalogItem) => void handleRestore(item),
    onPermanentDelete: (item: CatalogItem) => void handlePermanentDelete(item),
  };

  const toolbar = (
    <>
      {/* Row one — what to look for. */}
      <DataTableToolbar data-testid="catalog-toolbar">
        <DataTableSearch
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter catalog…  ( / )"
          aria-label="Filter catalog"
          data-testid="catalog-search"
        />
        <CatalogFormatFacet
          options={formatOptions}
          selected={filters.formats}
          onChange={(formats) => setFilters((current) => ({ ...current, formats }))}
        />
        <CatalogQuickFilter
          label="Protocol"
          testId="catalog-filter-protocol"
          value={filters.protocol}
          options={CATALOG_PROTOCOL_OPTIONS}
          onChange={(protocol) => setFilters((current) => ({ ...current, protocol }))}
        />
        <CatalogQuickFilter
          label="Source"
          testId="catalog-filter-source"
          value={filters.source}
          options={CATALOG_SOURCE_OPTIONS}
          onChange={(source) => setFilters((current) => ({ ...current, source }))}
        />
        <CatalogQuickFilter
          label="Grade"
          testId="catalog-filter-grade"
          value={filters.grade}
          options={CATALOG_GRADE_OPTIONS}
          onChange={(grade) => setFilters((current) => ({ ...current, grade }))}
        />
      </DataTableToolbar>

      {/* Row two — which of them, in what order, drawn how. */}
      <DataTableToolbar data-testid="catalog-views">
        {CATALOG_FACETS.map((entry) => (
          <DataTableFilterChip
            key={entry}
            active={facet === entry}
            count={counts[entry]}
            disabled={entry === 'deleted' && !showDeleted}
            title={
              entry === 'deleted' && !showDeleted
                ? 'Turn on Show deleted to use this view'
                : undefined
            }
            data-testid={`catalog-facet-${entry}`}
            onClick={() => setFacet(entry)}
          >
            {entry === 'attention' ? <TriangleAlert className="cat-chip-glyph" aria-hidden /> : null}
            {CATALOG_FACET_LABELS[entry]}
          </DataTableFilterChip>
        ))}
        {identityGroupFilter ? (
          /* The cross-format identity group (MFI-6.4) is a *server*-side narrowing — it is in
             the request, not in this component's state — so clearing it is a link back to the
             unfiltered route rather than a setState. The mockup draws it as a chip in this row
             rather than as the full-width banner the screen used to carry. */
          <DataTableFilterChip
            active
            data-testid="catalog-identity-group-chip"
            title="Applied from ?identityGroupId= — remove to show the whole catalog"
            onClick={() => router.push('/ade/dashboard/catalog')}
          >
            <Link2 className="cat-chip-glyph" aria-hidden />
            {catalogIdentityGroupLabel(identityGroupFilter)}
            <X className="cat-chip-glyph" aria-hidden />
          </DataTableFilterChip>
        ) : null}

        <DataTableToolbarSpacer />

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button variant="ghost" size="sm" data-testid="catalog-sort-menu">
              Sorted by {catalogSortLabel(sort)}
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="tnt-menu" sideOffset={4} align="end">
              {CATALOG_SORT_OPTIONS.map((option) => (
                <DropdownMenu.Item
                  key={option.id}
                  className="tnt-menu__item"
                  data-testid={`catalog-sort-${option.id}`}
                  onSelect={() =>
                    setSort((current) =>
                      current && current.column === option.id
                        ? {
                            column: option.id,
                            direction: current.direction === 'asc' ? 'desc' : 'asc',
                          }
                        : { column: option.id, direction: 'asc' }
                    )
                  }
                >
                  {option.label}
                  {sort && sort.column === option.id ? (
                    <span className="cat-sort-mark" aria-hidden>
                      {sort.direction === 'asc' ? '↑' : '↓'}
                    </span>
                  ) : null}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {/* Grouping sections the *cards*; the table is always flat, so the control is not
            offered while it is the one drawing. */}
        {view === 'cards' ? (
          <Segmented
            value={groupMode}
            onValueChange={(next) => setGroupMode(next as CatalogGroupMode)}
            size="sm"
            aria-label="Group cards"
          >
            <SegmentedItem value="protocol" data-testid="catalog-group-protocol">
              <Rows3 aria-hidden />
              Protocol
            </SegmentedItem>
            <SegmentedItem value="none" data-testid="catalog-group-none">
              None
            </SegmentedItem>
          </Segmented>
        ) : null}

        <Segmented
          value={view}
          onValueChange={(next) => setView(next as CatalogViewMode)}
          size="sm"
          aria-label="List view"
        >
          <SegmentedItem value="cards" data-testid="catalog-view-cards">
            <LayoutGrid aria-hidden />
            Cards
          </SegmentedItem>
          <SegmentedItem value="table" data-testid="catalog-view-table">
            <List aria-hidden />
            Table
          </SegmentedItem>
        </Segmented>
      </DataTableToolbar>
    </>
  );

  const emptyState = narrowed ? (
    <EmptyState
      variant="compact"
      surface={false}
      tone="neutral"
      title="No catalog items match your filters or search"
      description="Clear the search box, the format facet or the three filters above."
      action={
        <Button variant="outline" onClick={clearFilters} data-testid="catalog-clear-filters">
          Clear all filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      variant="compact"
      surface={false}
      title="Your catalog is empty"
      description={
        <>
          The catalog holds <strong>OpenAPI-worthy non-OpenAPI imports</strong> — specs in
          formats other than OpenAPI/Swagger, stored in their original format and converted to
          OpenAPI only when you are ready. OpenAPI and Swagger imports go to{' '}
          <Link href="/ade/dashboard/projects">Projects</Link> instead.
        </>
      }
      action={
        currentUserId ? (
          <Button onClick={openImport} data-testid="catalog-empty-import">
            <Upload aria-hidden />
            Import to catalog
          </Button>
        ) : undefined
      }
    />
  );

  const bulkActions = (
    <>
      {bulk.deletable.length > 0 ? (
        <DataTableBulkAction
          variant="danger-soft"
          disabled={busy}
          data-testid="catalog-bulk-delete"
          onClick={() =>
            void runBulk(
              bulk.deletable,
              (item) => deleteProject(item.id),
              'Deleted',
              'Failed to delete the catalog item.'
            )
          }
        >
          <Trash2 aria-hidden />
          Delete {bulk.deletable.length}
        </DataTableBulkAction>
      ) : null}
      {bulk.restorable.length > 0 ? (
        <DataTableBulkAction
          disabled={busy}
          data-testid="catalog-bulk-restore"
          onClick={() =>
            void runBulk(
              bulk.restorable,
              (item) => restoreProject(item.id),
              'Undeleted',
              'Failed to undelete the catalog item.'
            )
          }
        >
          <Undo2 aria-hidden />
          Undelete {bulk.restorable.length}
        </DataTableBulkAction>
      ) : null}
    </>
  );

  // ---- the page -----------------------------------------------------------------------------

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: 'Catalog' },
        ]}
        title="Catalog"
        description={summary}
        actions={
          <>
            <span className="cat-deleted-switch">
              <Switch
                id="catalog-show-deleted"
                checked={showDeleted}
                onCheckedChange={setShowDeleted}
                aria-label="Show soft-deleted catalog items in the list"
              />
              <Label htmlFor="catalog-show-deleted">Show deleted</Label>
            </span>
            {/* Import is the only write this screen starts, and it needs a signed-in user to
                attribute the revision to — so it is absent, not disabled, without one. */}
            {currentUserId ? (
              <Button
                kbd="I"
                disabled={!currentTenantId}
                onClick={openImport}
                data-testid="catalog-import"
              >
                <Upload aria-hidden />
                Import to catalog
              </Button>
            ) : null}
          </>
        }
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description="The catalog is scoped to one workspace." />
        ) : (
          <>
            <CatalogNonPublishableBanner />
            <CatalogSupportedFormats />

            {/* A strip of zeros above an empty state says the same thing twice. */}
            {items.length > 0 ? <CatalogStatsRow items={items} /> : null}

            {view === 'table' ? (
              <CatalogTable
                items={visible}
                historyById={historyById}
                loading={loading}
                error={loadError}
                onRetry={() => void loadCatalog()}
                sort={sort}
                onSortChange={setSort}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                bulkActions={bulkActions}
                onOpenQuality={openQuality}
                busy={busy}
                toolbar={toolbar}
                empty={emptyState}
                {...handlers}
              />
            ) : (
              <Card className="cat-cards-panel" data-testid="catalog-cards">
                {toolbar}
                {loading ? (
                  <div className="cat-grid" aria-busy>
                    {[0, 1, 2].map((index) => (
                      <div key={index} className="cat-card cat-card--skeleton" aria-hidden />
                    ))}
                    <p className="sr-only" role="status">
                      Loading catalog…
                    </p>
                  </div>
                ) : loadError ? (
                  <div className="cat-cards-panel__empty">
                    <EmptyState
                      variant="compact"
                      surface={false}
                      tone="danger"
                      title="The catalog could not be loaded"
                      description={loadError}
                      action={
                        <Button variant="outline" onClick={() => void loadCatalog()}>
                          Try again
                        </Button>
                      }
                    />
                  </div>
                ) : visible.length === 0 ? (
                  <div className="cat-cards-panel__empty">{emptyState}</div>
                ) : groupMode === 'protocol' ? (
                  /* One section per paradigm, in the fixed graph → rpc → event → rest →
                     data-schema order with a trailing Other, empty paradigms omitted. */
                  paradigmGroups.map((group) => (
                    <section key={group.id} data-testid={`catalog-paradigm-group-${group.id}`}>
                      <h2 className="cat-group__head">
                        <span>{group.label}</span>
                        <span className="cat-group__count">
                          {group.items.length} item{group.items.length === 1 ? '' : 's'}
                        </span>
                      </h2>
                      <div className="cat-grid cat-grid--grouped">
                        {group.items.map((item) => (
                          <CatalogCard
                            key={item.id}
                            item={item}
                            qualityHistory={historyById[item.id] ?? []}
                            busy={busy}
                            onOpenQuality={openQuality}
                            {...handlers}
                          />
                        ))}
                      </div>
                    </section>
                  ))
                ) : (
                  <div className="cat-grid">
                    {visible.map((item) => (
                      <CatalogCard
                        key={item.id}
                        item={item}
                        qualityHistory={historyById[item.id] ?? []}
                        busy={busy}
                        onOpenQuality={openQuality}
                        {...handlers}
                      />
                    ))}
                  </div>
                )}
              </Card>
            )}
          </>
        )}
      </PageBody>

      <ProjectQualityHistoryDialog
        key={qualityFor ? qualityFor.id : 'catalog-quality-closed'}
        open={qualityFor !== null}
        onOpenChange={(open) => {
          if (!open) setQualityFor(null);
        }}
        projectName={qualityFor?.name ?? ''}
        projectId={qualityFor?.id ?? ''}
        history={qualityFor ? (historyById[qualityFor.id] ?? []) : []}
        initialSection="quality"
      />

      <CatalogLintReportDialog
        key={lintFor ? lintFor.id : 'catalog-lint-closed'}
        itemId={lintFor?.id ?? null}
        itemName={lintFor?.name ?? ''}
        open={lintFor !== null}
        onOpenChange={(open) => {
          if (!open) setLintFor(null);
        }}
      />

      <ConversionPreviewDialog
        key={convertFor ? convertFor.id : 'catalog-convert-closed'}
        itemId={convertFor?.id ?? null}
        itemName={convertFor?.name ?? ''}
        sourceFormat={convertFor?.sourceFormat ?? null}
        open={convertFor !== null}
        onOpenChange={(open) => {
          if (!open) setConvertFor(null);
        }}
        onConverted={handleConverted}
      />

      {/* The catalog importer (MFI-23.12): store-raw intake — the source is kept in its
          original format and converted only when the user is ready, not at import time. */}
      {currentTenantId && currentUserId ? (
        <CatalogImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onSuccess={() => void loadCatalog()}
          onJsonSchemaAsCurrent={(payload: JsonSchemaHandoffPayload) => {
            setPrimitiveSource({
              sourceKind: 'json-schema',
              sourceMethod: 'paste',
              text: payload.text,
              document: payload.document,
              label: payload.label,
            });
          }}
        />
      ) : null}

      {primitiveSource ? (
        <PrimitiveImportDialog
          initialSource={primitiveSource}
          onClose={() => setPrimitiveSource(null)}
          onComplete={() => setPrimitiveSource(null)}
          onMessage={(type, message) => {
            if (type === 'success') toast.success(message);
            else toast.error(message);
          }}
        />
      ) : null}
    </Page>
  );
}

/** Props for {@link CatalogQuickFilter}. */
interface CatalogQuickFilterProps {
  /** The axis this select narrows — `Protocol`, `Source`, `Grade`. */
  label: string;
  /** Its `data-testid`. */
  testId: string;
  /** The current value, or `CATALOG_FILTER_ANY`. */
  value: string;
  /** Every option, the neutral one first. */
  options: readonly { value: string; label: string }[];
  /** Report the next value. */
  onChange: (next: string) => void;
}

/**
 * One of the toolbar's three single-choice quick filters.
 *
 * All three are the same control over different vocabularies, so they are one component: what
 * differs is the option list, which is a constant in `catalogModel` and therefore something a
 * test can enumerate without opening a menu. The trigger is marked `data-active` when the
 * filter is doing something, which is what the stylesheet tints — a `Select` that is narrowing
 * the list should not look identical to one that is not.
 *
 * @param props See {@link CatalogQuickFilterProps}.
 * @returns The select.
 */
function CatalogQuickFilter({
  label,
  testId,
  value,
  options,
  onChange,
}: CatalogQuickFilterProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="cat-filter"
        aria-label={label}
        data-testid={testId}
        data-active={value !== CATALOG_FILTER_ANY ? '' : undefined}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
