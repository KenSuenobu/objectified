'use client';

/**
 * Primitives & types — the tenant's JSON Schema registry (HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria, and `docs/mockups/DESIGN.md` §5.3 (page header), §7 (component
 * vocabulary) and §8 (the list pattern).
 *
 * ### What this file is now
 *
 * State and writes, and nothing else. Every surface it draws lives in
 * `components/ade/primitives`: the KPI strip, the collections panel, the rail, the types table,
 * the three tab panels and the namespace dialog; every rule they share lives in
 * `primitivesModel.ts`. What that removed from here was 250 lines of markup — a white `<header>`
 * with a `text-indigo-600` database glyph, a hand-built `<table>` with `px-6 py-4` cells and
 * five inline pill palettes, a filter bar of `border-gray-300 dark:border-gray-600` controls,
 * and a namespace chip in `bg-indigo-100 text-indigo-700`.
 *
 * ### The dead deep-link
 *
 * The mockup's *Adds* is the one behavioural change: the KPI strip's amber tile and the rail's
 * `$ref` explainer both linked to `?focus=resolver`, and **nothing on this screen read that
 * parameter**. Both now switch to the Resolver tab directly, and {@link viewFromFocusParam}
 * makes the address itself work when it is pasted or bookmarked.
 *
 * `?edit=<id>` is the same bug on the other side, closed by HIVE-6.6 (#5317): the type-detail
 * page's Edit action linked here with it and nothing read it either, so "edit this type" landed
 * on an unfiltered list. {@link primitiveIdFromEditParam} admits the id and the effect below
 * opens the editor on that row once the registry has loaded it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthSession } from '@lib/auth/session-client';
import { FolderTree, GitFork, Library, Plus, Settings2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/app/components/ui/Button';
import { GatedState } from '@/app/components/ui/EmptyState';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { type DataTableSortState } from '@/app/components/ui/DataTable';
import { useDialog } from '@/app/components/providers/DialogProvider';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import {
  ALL_CATEGORIES,
  NamespacesPanel,
  PRIMITIVES_VIEWS,
  PRIMITIVES_VIEW_LABEL,
  PrimitiveTypesTable,
  PrimitivesKpiStrip,
  RegistryRail,
  RegistrySettingsPanel,
  ResolverPanel,
  TypeCollectionsPanel,
  deletePrimitiveConfirm,
  primitiveIdFromEditParam,
  viewFromFocusParam,
  type NamespaceSelection,
  type PrimitivesView,
} from '@/app/components/ade/primitives';
import type { NamespaceSelectOptions } from '@/app/components/ade/primitives';
import { isWithinNamespace } from '@/app/utils/primitives-namespace-groups';
import {
  DEFAULT_PRIMITIVES_TABLE_SORT,
  nextPrimitivesTableSort,
  sortPrimitivesTableRows,
  type PrimitivesTableSortColumn,
  type PrimitivesTableSortState,
} from '@/app/utils/primitives-table-sort';

import { countUnassignedTypes, detectUnregisteredNamespaces } from './namespaceModel';
import PrimitiveEditorDialog from './PrimitiveEditorDialog';
import PrimitiveImportDialog from './PrimitiveImportDialog';
import {
  countUnresolvedByNamespace,
  type NamespaceScopeFilter,
  type PrimitiveImportActivity,
  type RegistryCoverageStats,
  type TypeNamespaceCollection,
} from './primitivesRegistryTypes';

/** One row of `apiome.primitives`, as `/api/primitives` returns it. */
interface Primitive {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  category: string;
  schema: Record<string, unknown>;
  tags: string[];
  created_by: string | null;
  is_system: boolean;
  is_public: boolean;
  usage_count: number;
  enabled: boolean;
  source?: string;
  namespace?: string | null;
  schema_id?: string | null;
  draft?: string;
  created_at: string;
  updated_at: string;
}

/** The tab strip's glyphs, in the mockup's order. */
const VIEW_ICON: Readonly<Record<PrimitivesView, ComponentType<{ className?: string }>>> = {
  registry: Library,
  namespaces: FolderTree,
  resolver: GitFork,
  settings: Settings2,
};

/** The breadcrumb every pane sits under. */
const BREADCRUMB = [
  { label: 'Home', href: '/ade/dashboard' },
  { label: 'Build' },
  { label: 'Primitives & types' },
];

/**
 * The primitives screen.
 *
 * @returns The page: header with the four tabs, and whichever pane is selected.
 */
export default function PrimitivesManagementClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useAuthSession();
  const { confirm } = useDialog();

  const [primitives, setPrimitives] = useState<Primitive[]>([]);
  const [filteredPrimitives, setFilteredPrimitives] = useState<Primitive[]>([]);
  const [loading, setLoading] = useState(true);
  const [registryLoading, setRegistryLoading] = useState(true);

  const [stats, setStats] = useState<RegistryCoverageStats | null>(null);
  const [namespaces, setNamespaces] = useState<TypeNamespaceCollection[]>([]);
  const [imports, setImports] = useState<PrimitiveImportActivity[]>([]);
  const [unresolvedByNamespace, setUnresolvedByNamespace] = useState<Record<string, number>>({});

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_CATEGORIES);
  const [showSystemPrimitives, setShowSystemPrimitives] = useState(true);
  const [namespaceScopeFilter, setNamespaceScopeFilter] = useState<NamespaceScopeFilter>('all');
  /**
   * The namespace the Type collections panel selected, and whether the selection covers the
   * whole family beneath it. A group row stands for many namespaces, so an exact-match filter
   * would show nothing for it.
   */
  const [selectedNamespace, setSelectedNamespace] = useState<NamespaceSelection | null>(null);

  // The address bar is honoured once, on mount: `?focus=resolver` is a deep link into a pane,
  // not a controlled value, so re-reading it would fight every click on the tab strip.
  const focusParam = searchParams?.get('focus') ?? null;
  const [activeView, setActiveView] = useState<PrimitivesView>(
    () => viewFromFocusParam(focusParam) ?? 'registry'
  );

  /** Which column the types table is ordered by; opens on name-ascending as it always did. */
  const [tableSort, setTableSort] = useState<PrimitivesTableSortState>(
    DEFAULT_PRIMITIVES_TABLE_SORT
  );

  const [showEditorDialog, setShowEditorDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [editingPrimitive, setEditingPrimitive] = useState<Primitive | null>(null);

  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;

  const sortByName = (items: Primitive[]) =>
    [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // Page-level outcomes (import summaries, deletes, settings/resolver/namespace actions) go to
  // the app-wide toaster in the bottom-right corner rather than a banner above the content. A
  // banner pushed the KPI strip and tabs down on every message, and an import summary that
  // lands after the dialog closes reads as a transient result, not as page furniture.
  const showMessage = useCallback((type: 'success' | 'error', text: string) => {
    if (type === 'success') {
      toast.success(text);
    } else {
      toast.error(text);
    }
  }, []);

  const loadRegistryOverview = useCallback(async () => {
    setRegistryLoading(true);
    try {
      const [statsRes, namespacesRes, importsRes, unresolvedRes] = await Promise.all([
        fetch('/api/primitives/stats'),
        fetch('/api/types/namespaces'),
        fetch('/api/primitives/imports?limit=8'),
        fetch('/api/primitives/unresolved'),
      ]);

      const [statsData, namespacesData, importsData, unresolvedData] = await Promise.all([
        statsRes.json(),
        namespacesRes.json(),
        importsRes.json(),
        unresolvedRes.json(),
      ]);

      if (statsData.success) {
        setStats(statsData.stats as RegistryCoverageStats);
      }
      if (namespacesData.success) {
        setNamespaces(namespacesData.namespaces as TypeNamespaceCollection[]);
      }
      if (importsData.success) {
        setImports(importsData.imports as PrimitiveImportActivity[]);
      }
      if (unresolvedData.success && unresolvedData.unresolved?.primitives) {
        setUnresolvedByNamespace(countUnresolvedByNamespace(unresolvedData.unresolved.primitives));
      } else {
        setUnresolvedByNamespace({});
      }
    } catch (error) {
      console.error('Error loading registry overview:', error);
    } finally {
      setRegistryLoading(false);
    }
  }, []);

  const loadPrimitives = useCallback(async () => {
    if (!currentTenantId) {
      setPrimitives([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/primitives');

      if (!response.ok) {
        const text = await response.text();
        console.error('API error:', response.status, text);
        showMessage('error', `Failed to load primitives: ${text || response.statusText}`);
        return;
      }

      const data = await response.json();

      if (data.success) {
        setPrimitives(sortByName(data.primitives || []));
      } else {
        showMessage('error', data.error || 'Failed to load primitives');
      }
    } catch (error) {
      console.error('Error loading primitives:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to load primitives';
      showMessage('error', errorMessage);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId, showMessage]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadPrimitives(), loadRegistryOverview()]);
  }, [loadPrimitives, loadRegistryOverview]);

  const filterPrimitives = useCallback(() => {
    let filtered = [...primitives];

    if (!showSystemPrimitives) {
      filtered = filtered.filter((p) => !p.is_system);
    }

    if (selectedCategory !== ALL_CATEGORIES) {
      filtered = filtered.filter((p) => p.category === selectedCategory);
    }

    if (selectedNamespace !== null) {
      const { value, includeDescendants } = selectedNamespace;
      filtered = filtered.filter((p) => {
        const namespace = (p.namespace ?? '').trim();
        return includeDescendants ? isWithinNamespace(namespace, value) : namespace === value;
      });
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.description?.toLowerCase().includes(query) ||
          p.tags.some((tag) => tag.toLowerCase().includes(query)) ||
          p.namespace?.toLowerCase().includes(query)
      );
    }

    setFilteredPrimitives(sortPrimitivesTableRows(filtered, tableSort.column, tableSort.direction));
  }, [
    primitives,
    searchQuery,
    selectedCategory,
    showSystemPrimitives,
    selectedNamespace,
    tableSort,
  ]);

  useEffect(() => {
    if (currentTenantId) {
      void refreshAll();
    }
  }, [currentTenantId, refreshAll]);

  useEffect(() => {
    filterPrimitives();
  }, [filterPrimitives]);

  const handleCreatePrimitive = () => {
    setEditingPrimitive(null);
    setShowEditorDialog(true);
  };

  const handleEditPrimitive = useCallback(
    (primitive: { id: string }) => {
      const target = primitives.find((candidate) => candidate.id === primitive.id);
      if (!target) return;
      if (target.is_system) {
        showMessage('error', 'System primitives cannot be edited');
        return;
      }
      setEditingPrimitive(target);
      setShowEditorDialog(true);
    },
    [primitives, showMessage]
  );

  /**
   * `?edit=<id>` — the type-detail page's Edit action (HIVE-6.6, #5317).
   *
   * Honoured **once**, and only once the registry has rows to match the id against: the editor
   * needs the whole row, not just the id, so the parameter cannot be read on mount the way
   * `?focus=` is. The latch is a ref rather than state because re-opening a dialog the reader
   * has closed is exactly what a re-run would do.
   */
  const editParam = primitiveIdFromEditParam(searchParams?.get('edit'));
  const editParamConsumed = useRef(false);

  useEffect(() => {
    if (!editParam || editParamConsumed.current || primitives.length === 0) return;
    editParamConsumed.current = true;
    handleEditPrimitive({ id: editParam });
  }, [editParam, primitives, handleEditPrimitive]);

  const handleDeletePrimitive = async (primitive: { id: string }) => {
    const target = primitives.find((candidate) => candidate.id === primitive.id);
    if (!target) return;
    if (target.is_system) {
      showMessage('error', 'System primitives cannot be deleted');
      return;
    }

    const request = deletePrimitiveConfirm(target);
    const confirmed = await confirm({
      title: request.title,
      message: request.message,
      confirmLabel: request.confirmLabel,
      cancelLabel: 'Cancel',
      variant: 'danger',
    });

    if (!confirmed) return;

    try {
      const response = await fetch(`/api/primitives/${target.id}`, { method: 'DELETE' });
      const data = await response.json();

      if (data.success) {
        showMessage('success', 'Primitive deleted successfully');
        await refreshAll();
      } else {
        showMessage('error', data.error || 'Failed to delete primitive');
      }
    } catch (error) {
      console.error('Error deleting primitive:', error);
      showMessage('error', 'Failed to delete primitive');
    }
  };

  const handleSavePrimitive = async () => {
    await refreshAll();
    setShowEditorDialog(false);
  };

  const handleImportComplete = async () => {
    await refreshAll();
    setShowImportDialog(false);
  };

  const handleTableSort = useCallback((next: DataTableSortState | null) => {
    setTableSort((current) =>
      // `DataTable` offers a third, unsorted state; this table has always had a default order,
      // so clearing the sort returns to it rather than to the server's arbitrary one.
      next === null
        ? DEFAULT_PRIMITIVES_TABLE_SORT
        : nextPrimitivesTableSort(current, next.column as PrimitivesTableSortColumn)
    );
  }, []);

  const handleNamespaceSelect = (namespace: string, options?: NamespaceSelectOptions) => {
    const includeDescendants = options?.includeDescendants ?? false;
    setSelectedNamespace((current) =>
      // Re-clicking the same selection clears it; a group and its root namespace share a path
      // but are different selections, so the descendants flag is part of the identity.
      current && current.value === namespace && current.includeDescendants === includeDescendants
        ? null
        : { value: namespace, includeDescendants }
    );
  };

  // Type collections lists `apiome.type_namespaces` rows, but a type's namespace is just a string
  // on the primitive and nothing registers it — so a namespace can be in use with no row, and a
  // type can have no namespace at all. Both are derived here from the types already loaded.
  const unassignedTypeCount = useMemo(() => countUnassignedTypes(primitives), [primitives]);
  const detectedNamespaces = useMemo(
    () => detectUnregisteredNamespaces(primitives, namespaces),
    [primitives, namespaces]
  );

  const categories = useMemo(
    () => Array.from(new Set(primitives.map((p) => p.category))).sort(),
    [primitives]
  );

  const headerTabs = (
    <div role="tablist" aria-label="Primitives views" className={TAB_LIST_CLASS}>
      {PRIMITIVES_VIEWS.map((view) => {
        const Icon = VIEW_ICON[view];
        return (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={activeView === view}
            data-testid={`primitives-tab-${view}`}
            onClick={() => setActiveView(view)}
            className={tabTriggerClass({ active: activeView === view })}
          >
            <Icon aria-hidden />
            {PRIMITIVES_VIEW_LABEL[view]}
          </button>
        );
      })}
    </div>
  );

  return (
    <Page>
      <PageHeader
        breadcrumb={BREADCRUMB}
        title="Primitives & types"
        description={
          <>
            JSON Schema 2020-12 type registry · core system &amp; tenant scopes · relative{' '}
            <span className="mono">$ref</span> resolution
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              kbd="I"
              onClick={() => setShowImportDialog(true)}
              disabled={!currentTenantId}
              data-testid="primitives-import"
            >
              <Upload aria-hidden />
              Import from schema
            </Button>
            <Button
              kbd="N"
              onClick={handleCreatePrimitive}
              disabled={!currentTenantId}
              data-testid="primitives-create"
            >
              <Plus aria-hidden />
              Create primitive
            </Button>
          </>
        }
        tabs={headerTabs}
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState
            title="Please select a tenant to manage primitives"
            description="The type registry is scoped to one workspace."
          />
        ) : activeView === 'settings' ? (
          <RegistrySettingsPanel onMessage={showMessage} />
        ) : activeView === 'resolver' ? (
          <ResolverPanel onMessage={showMessage} />
        ) : activeView === 'namespaces' ? (
          <NamespacesPanel
            namespaces={namespaces}
            unresolvedByNamespace={unresolvedByNamespace}
            detectedNamespaces={detectedNamespaces}
            loading={registryLoading}
            onRefresh={refreshAll}
            onMessage={showMessage}
          />
        ) : (
          <>
            <PrimitivesKpiStrip
              stats={stats}
              loading={registryLoading}
              onOpenResolver={() => setActiveView('resolver')}
            />

            <div className="prm-registry-grid">
              <TypeCollectionsPanel
                namespaces={namespaces}
                unresolvedByNamespace={unresolvedByNamespace}
                scopeFilter={namespaceScopeFilter}
                onScopeFilterChange={setNamespaceScopeFilter}
                onNamespaceSelect={handleNamespaceSelect}
                unassignedCount={unassignedTypeCount}
                detectedNamespaces={detectedNamespaces}
                loading={registryLoading}
              />
              <RegistryRail
                imports={imports}
                loading={registryLoading}
                onOpenResolver={() => setActiveView('resolver')}
              />
            </div>

            <PrimitiveTypesTable
              primitives={filteredPrimitives}
              totalCount={primitives.length}
              loading={loading}
              sort={{ column: tableSort.column, direction: tableSort.direction }}
              onSortChange={handleTableSort}
              search={searchQuery}
              onSearchChange={setSearchQuery}
              categories={categories}
              category={selectedCategory}
              onCategoryChange={setSelectedCategory}
              showSystem={showSystemPrimitives}
              onShowSystemChange={setShowSystemPrimitives}
              namespaceSelection={selectedNamespace}
              onClearNamespace={() => setSelectedNamespace(null)}
              onRefresh={() => void refreshAll()}
              onOpen={(primitive) => router.push(`/ade/dashboard/primitives/${primitive.id}`)}
              onEdit={handleEditPrimitive}
              onDelete={(primitive) => void handleDeletePrimitive(primitive)}
            />
          </>
        )}
      </PageBody>

      {showEditorDialog && (
        <PrimitiveEditorDialog
          primitive={editingPrimitive}
          onClose={() => setShowEditorDialog(false)}
          onSave={handleSavePrimitive}
          onMessage={showMessage}
        />
      )}

      {showImportDialog && (
        <PrimitiveImportDialog
          onClose={() => setShowImportDialog(false)}
          onComplete={handleImportComplete}
          onMessage={showMessage}
        />
      )}
    </Page>
  );
}
