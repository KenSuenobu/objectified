'use client';

/**
 * The Type collections panel (HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Registry → *Type collections* — the Group
 * toggle, the `All / System · core / Tenant / Imported` segmented, the four kinds of row
 * (registered, group, unregistered, unassigned) and the foot that counts all of them.
 *
 * ### What this replaces
 *
 * `PrimitivesNamespaceCollections`, whose 578 lines were mostly palette: two hand-built scope
 * pills (`bg-teal-100 text-teal-700 dark:bg-teal-900/40 …`), a third for "Mixed", two status
 * pills, four `bg-indigo-100`/`bg-amber-100`/`bg-gray-100` icon tiles, a hand-rolled segmented
 * control and a hand-rolled `<thead>` over `dashboardScreenClasses`. It is {@link DataTable}
 * now — sticky caps header, `aria-sort`, per-column skeletons — with {@link Segmented} for the
 * scope switch and the shared status vocabulary for every pill.
 *
 * ### Why the tree is flattened into rows
 *
 * `DataTable` draws a list, and a group with its members *is* a list once you decide which
 * groups are open. Flattening here keeps the grouping rules in
 * `utils/primitives-namespace-groups.ts` where they are unit-tested, and leaves this file with
 * one job: say what each of the four row kinds looks like.
 */

import * as React from 'react';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderTree,
  Library,
  Shapes,
} from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellSub,
  DataTableFilterChip,
  DataTableFoot,
  DataTableToolbar,
  DataTableToolbarSpacer,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import { cn } from '@lib/utils';
import {
  buildNamespaceGroups,
  sortNamespaceTree,
  type NamespaceTreeEntry,
} from '@/app/utils/primitives-namespace-groups';
import {
  nextNamespaceCollectionSort,
  type NamespaceCollectionSortColumn,
  type NamespaceCollectionSortRow,
  type NamespaceCollectionSortState,
} from '@/app/utils/primitives-namespaces-sort';
import type {
  NamespaceScopeFilter,
  TypeNamespaceCollection,
} from '@/app/ade/dashboard/primitives/primitivesRegistryTypes';
import type { DetectedNamespace } from '@/app/ade/dashboard/primitives/namespaceModel';

import {
  GROUP_TOGGLE_HINT,
  NAMESPACE_SCOPE_FILTERS,
  UNASSIGNED_NAMESPACE_KEY,
  collectionsFootLabel,
  collectionsSubtitle,
  namespaceScopeBadge,
  namespaceStatusBadge,
} from './primitivesModel';

/** How a namespace click should filter the types below: just that namespace, or its whole family. */
export interface NamespaceSelectOptions {
  /** True when a group row was clicked, which stands for every path beneath it. */
  includeDescendants?: boolean;
}

/** The JSON Schema draft every namespace is currently pinned to. */
const NAMESPACE_DRAFT = '2020-12';

/**
 * The three kinds of row, flattened onto the sort model so one click orders all of them.
 *
 * `namespace` is what the click reports; `path` is the namespace path grouping reads (`null`
 * for the unassigned bucket, which sits on no path).
 */
type CollectionRow = NamespaceCollectionSortRow & {
  /** The namespace this row selects. */
  namespace: string;
  /** Its path for grouping, or `null` when it is not on one. */
  path: string | null;
  /** The registry row behind it, for a registered collection. */
  collection?: TypeNamespaceCollection;
  /** True when the row is an imported (vendor) namespace. */
  isImported?: boolean;
  /** A stable hook for the tests that assert the synthetic rows exist. */
  testId?: string;
};

/** One line of the rendered table — a group header, or one collection row. */
type CollectionEntry =
  | {
      kind: 'group';
      id: string;
      prefix: string;
      header: NamespaceCollectionSortRow & { collectionCount: number; scopeMixed: boolean };
      expanded: boolean;
    }
  | { kind: 'member'; id: string; row: CollectionRow; indented: boolean; isGroupRoot: boolean };

/**
 * The leading glyph for a registered namespace.
 *
 * Returns the element rather than the component: a component chosen *during* render is a new
 * type as far as React's reconciler is concerned, which is what `react-hooks/static-components`
 * is warning about — and here there is nothing to gain by deferring the choice.
 *
 * @param namespace The row's path.
 * @param isImported Whether the row is a vendor namespace.
 * @returns The glyph.
 */
function NamespaceGlyph({ namespace, isImported }: { namespace: string; isImported: boolean }) {
  if (isImported) return <Download className="prm-ns-glyph" aria-hidden />;
  if (namespace.startsWith('std/')) {
    return namespace.includes('primitives') ? (
      <Shapes className="prm-ns-glyph" aria-hidden />
    ) : (
      <Library className="prm-ns-glyph" aria-hidden />
    );
  }
  return <Building2 className="prm-ns-glyph" aria-hidden />;
}

export interface TypeCollectionsPanelProps {
  /** Every registered namespace visible to the tenant. */
  namespaces: readonly TypeNamespaceCollection[];
  /** Unresolved `$ref` counts, keyed by namespace path. */
  unresolvedByNamespace: Readonly<Record<string, number>>;
  /** The scope segmented's value. */
  scopeFilter: NamespaceScopeFilter;
  /** Change it. */
  onScopeFilterChange: (filter: NamespaceScopeFilter) => void;
  /** A row was chosen — filter the types table below. */
  onNamespaceSelect: (namespace: string, options?: NamespaceSelectOptions) => void;
  /**
   * How many types carry no namespace at all. They belong to no collection, so without a row of
   * their own they are invisible here — the list would account for only part of the registry.
   */
  unassignedCount: number;
  /**
   * Namespaces that types already use but that have no collection row yet. Surfaced as a row so
   * the reader can see the types exist and register the namespace from “New namespace”.
   */
  detectedNamespaces: readonly DetectedNamespace[];
  /** True while the registry overview is being read. */
  loading: boolean;
}

/**
 * Render the panel. See {@link TypeCollectionsPanelProps}.
 *
 * @returns The collections card: toolbar, table, foot.
 */
export default function TypeCollectionsPanel({
  namespaces,
  unresolvedByNamespace,
  scopeFilter,
  onScopeFilterChange,
  onNamespaceSelect,
  unassignedCount,
  detectedNamespaces,
  loading,
}: TypeCollectionsPanelProps) {
  // Unsorted by default, so the panel opens in the order the registry returned.
  const [sort, setSort] = React.useState<NamespaceCollectionSortState>({
    column: null,
    direction: 'asc',
  });
  const [grouped, setGrouped] = React.useState(true);
  const [expandedGroups, setExpandedGroups] = React.useState<ReadonlySet<string>>(new Set());

  const filtered = React.useMemo(
    () =>
      namespaces.filter((ns) => {
        if (scopeFilter === 'system') return ns.scope === 'system';
        if (scopeFilter === 'tenant') return ns.scope === 'tenant';
        if (scopeFilter === 'imported') {
          return ns.scope === 'tenant' && !ns.is_default && !ns.namespace.startsWith('tenant/');
        }
        return true;
      }),
    [namespaces, scopeFilter]
  );

  // The unassigned and unregistered rows describe types rather than registered collections, so
  // they have no scope to filter by; they show under "All" and are hidden by the scope filters.
  const showExtras = scopeFilter === 'all';

  const rows = React.useMemo<CollectionRow[]>(() => {
    const registered: CollectionRow[] = filtered.map((ns) => ({
      key: ns.id,
      kind: 'registered',
      namespace: ns.namespace,
      path: ns.namespace,
      sortName: ns.namespace,
      scope: ns.scope,
      typeCount: ns.type_count,
      draft: NAMESPACE_DRAFT,
      unresolvedCount: unresolvedByNamespace[ns.namespace] ?? 0,
      collection: ns,
      isImported:
        scopeFilter === 'imported' ||
        (!ns.is_system && !ns.namespace.startsWith('std/') && !ns.namespace.startsWith('tenant/')),
    }));

    if (!showExtras) return registered;

    // Namespaces the types use that were never registered as collections. Listing them is what
    // stops an imported namespace from vanishing from this screen.
    const detected: CollectionRow[] = detectedNamespaces.map((row) => ({
      key: `detected-${row.namespace}`,
      kind: 'detected',
      namespace: row.namespace,
      path: row.namespace,
      sortName: row.namespace,
      scope: null,
      typeCount: row.typeCount,
      draft: NAMESPACE_DRAFT,
      unresolvedCount: unresolvedByNamespace[row.namespace] ?? 0,
      testId: `detected-namespace-${row.namespace}`,
    }));

    // Types with no namespace at all. They cannot be registered — there is nothing to register —
    // so they get their own row rather than being quietly dropped. They sit on no path, so
    // grouping leaves them alone.
    const unassigned: CollectionRow[] =
      unassignedCount > 0
        ? [
            {
              key: 'unassigned',
              kind: 'unassigned',
              namespace: UNASSIGNED_NAMESPACE_KEY,
              path: null,
              sortName: 'Unassigned namespaces',
              scope: null,
              typeCount: unassignedCount,
              draft: NAMESPACE_DRAFT,
              unresolvedCount: 0,
              testId: 'unassigned-namespaces-row',
            },
          ]
        : [];

    return [...registered, ...detected, ...unassigned];
  }, [
    filtered,
    detectedNamespaces,
    unresolvedByNamespace,
    unassignedCount,
    scopeFilter,
    showExtras,
  ]);

  const tree = React.useMemo<NamespaceTreeEntry<CollectionRow>[]>(() => {
    const entries: NamespaceTreeEntry<CollectionRow>[] = grouped
      ? buildNamespaceGroups(rows)
      : rows.map((row) => ({ kind: 'row' as const, row }));
    return sortNamespaceTree(entries, sort.column, sort.direction);
  }, [rows, grouped, sort.column, sort.direction]);

  const groupCount = tree.filter((entry) => entry.kind === 'group').length;

  /** The tree, flattened into the rows `DataTable` draws. */
  const entries = React.useMemo<CollectionEntry[]>(() => {
    const flat: CollectionEntry[] = [];
    for (const entry of tree) {
      if (entry.kind === 'row') {
        flat.push({ kind: 'member', id: entry.row.key, row: entry.row, indented: false, isGroupRoot: false });
        continue;
      }
      const { prefix, header, members, rootKeys } = entry.group;
      const expanded = expandedGroups.has(prefix);
      flat.push({ kind: 'group', id: `group-${prefix}`, prefix, header, expanded });
      if (!expanded) continue;
      for (const member of members) {
        flat.push({
          kind: 'member',
          id: member.key,
          row: member,
          indented: true,
          isGroupRoot: rootKeys.has(member.key),
        });
      }
    }
    return flat;
  }, [tree, expandedGroups]);

  const toggleGroup = (prefix: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(prefix)) next.add(prefix);
      return next;
    });
  };

  /** `DataTable`'s sort state, which allows "no column" where this panel's own state uses `null`. */
  const tableSort: DataTableSortState | null = sort.column
    ? { column: sort.column, direction: sort.direction }
    : null;

  const handleSortChange = (next: DataTableSortState | null) => {
    // A third click clears the sort, which is `DataTable`'s cycle and the only way back to the
    // registry's own order; the two-state cycle this panel used had no way of expressing it.
    if (!next) {
      setSort({ column: null, direction: 'asc' });
      return;
    }
    setSort((current) =>
      nextNamespaceCollectionSort(current, next.column as NamespaceCollectionSortColumn)
    );
  };

  // Not memoised: every cell reads from the row it is handed, and the group chevron closes over
  // `toggleGroup`, which would go stale behind a `useMemo` the moment the panel re-rendered.
  const columns: DataTableColumn<CollectionEntry>[] = [
    {
      id: 'namespace',
      header: 'Namespace',
      sortable: true,
      skeletonWidth: '13rem',
      cell: (entry) =>
        entry.kind === 'group' ? (
          <div className="prm-ns-identity">
            <Button
              variant="ghost"
              size="sm"
              className="prm-ns-chevron"
              data-testid={`namespace-group-expand-${entry.prefix}`}
              aria-expanded={entry.expanded}
              aria-label={`${entry.expanded ? 'Collapse' : 'Expand'} ${entry.prefix}`}
              onClick={(event) => {
                // The row itself selects the family; only the chevron expands it.
                event.stopPropagation();
                toggleGroup(entry.prefix);
              }}
            >
              {entry.expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            </Button>
            {entry.expanded ? (
              <FolderOpen className="prm-ns-glyph" aria-hidden />
            ) : (
              <Folder className="prm-ns-glyph" aria-hidden />
            )}
            <span className="prm-ns-identity__text">
              <span className="prm-ns-identity__line">
                <span className="prm-ns-path mono">{entry.prefix}</span>
                <span className="prm-micro">group</span>
              </span>
              <DataTableCellSub>
                {entry.header.collectionCount} namespace
                {entry.header.collectionCount === 1 ? '' : 's'} · {entry.header.typeCount} type
                {entry.header.typeCount === 1 ? '' : 's'}
              </DataTableCellSub>
            </span>
          </div>
        ) : (
          <CollectionIdentity entry={entry} />
        ),
    },
    {
      id: 'scope',
      header: 'Scope',
      sortable: true,
      skeletonWidth: '5rem',
      cell: (entry) => {
        const badge =
          entry.kind === 'group'
            ? namespaceScopeBadge(entry.header.scope, entry.header.scopeMixed)
            : namespaceScopeBadge(entry.row.scope);
        return badge ? (
          <Badge variant={badge.tone}>{badge.label}</Badge>
        ) : (
          <Badge variant="outline">—</Badge>
        );
      },
    },
    {
      id: 'types',
      header: 'Types',
      sortable: true,
      align: 'end',
      skeletonWidth: '2rem',
      cell: (entry) => (
        <span className="prm-num mono">
          {entry.kind === 'group' ? entry.header.typeCount : entry.row.typeCount}
        </span>
      ),
    },
    {
      id: 'draft',
      header: 'Draft',
      sortable: true,
      skeletonWidth: '3.5rem',
      cell: (entry) => (
        <span className="prm-quiet mono">
          {entry.kind === 'group' ? entry.header.draft || '—' : entry.row.draft}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      align: 'end',
      skeletonWidth: '5rem',
      cell: (entry) => {
        const unresolved =
          entry.kind === 'group' ? entry.header.unresolvedCount : entry.row.unresolvedCount;
        const badge = namespaceStatusBadge(unresolved);
        return <Badge variant={badge.tone}>{badge.label}</Badge>;
      },
    },
  ];

  const toolbar = (
    <DataTableToolbar className="prm-collections__toolbar">
      <span className="prm-panel-head">
        <FolderTree aria-hidden />
        <span className="prm-panel-head__text">
          <h3 className="prm-panel-head__title">Type collections</h3>
          <span className="prm-panel-head__sub">{collectionsSubtitle(grouped)}</span>
        </span>
      </span>
      <DataTableToolbarSpacer />
      <DataTableFilterChip
        active={grouped}
        data-testid="namespace-group-toggle"
        title={GROUP_TOGGLE_HINT}
        onClick={() => setGrouped((current) => !current)}
      >
        <FolderTree aria-hidden />
        Group
      </DataTableFilterChip>
      <Segmented
        size="sm"
        value={scopeFilter}
        onValueChange={(value) => onScopeFilterChange(value as NamespaceScopeFilter)}
        aria-label="Namespace scope"
      >
        {NAMESPACE_SCOPE_FILTERS.map((option) => (
          <SegmentedItem key={option.id} value={option.id}>
            {option.label}
          </SegmentedItem>
        ))}
      </Segmented>
    </DataTableToolbar>
  );

  return (
    <DataTable<CollectionEntry>
      className="prm-collections"
      caption="Type collections"
      dense
      scrollX
      columns={columns}
      rows={entries}
      getRowId={(entry) => entry.id}
      getRowLabel={(entry) => (entry.kind === 'group' ? entry.prefix : entry.row.sortName)}
      sort={tableSort}
      onSortChange={handleSortChange}
      loading={loading}
      loadingLabel="Loading namespaces…"
      skeletonRows={4}
      rowClassName={(entry) =>
        cn(
          entry.kind === 'group' && 'prm-ns-row--group',
          entry.kind === 'member' && entry.indented && 'prm-ns-row--nested'
        )
      }
      onRowActivate={(entry) =>
        entry.kind === 'group'
          ? // Selecting the group filters the types below to the whole family, which is the only
            // reading of a click on a row that stands for many namespaces.
            onNamespaceSelect(entry.prefix, { includeDescendants: true })
          : onNamespaceSelect(entry.row.namespace)
      }
      empty={
        <EmptyState
          icon={<FolderTree aria-hidden />}
          title="No namespace collections match this filter."
          description="Clear the scope filter to see every namespace in the registry."
          variant="compact"
        />
      }
      toolbar={toolbar}
      footer={
        <DataTableFoot data-testid="namespace-collections-foot">
          <span>
            {collectionsFootLabel({
              shown: filtered.length,
              total: namespaces.length,
              groups: grouped ? groupCount : 0,
              unregistered: showExtras ? detectedNamespaces.length : 0,
              unassigned: showExtras ? unassignedCount : 0,
            })}
          </span>
        </DataTableFoot>
      }
    />
  );
}

/** The identity cell of a registered, detected or unassigned row. */
function CollectionIdentity({
  entry,
}: {
  entry: Extract<CollectionEntry, { kind: 'member' }>;
}) {
  const { row, isGroupRoot } = entry;

  if (row.kind === 'registered' && row.collection) {
    const ns = row.collection;
    return (
      <div className="prm-ns-identity">
        <NamespaceGlyph namespace={ns.namespace} isImported={Boolean(row.isImported)} />
        <span className="prm-ns-identity__text">
          <span className="prm-ns-identity__line">
            <span className="prm-ns-path mono">{ns.namespace}</span>
            {isGroupRoot ? <span className="prm-micro">root</span> : null}
            {row.isImported ? <span className="prm-micro">imported</span> : null}
          </span>
          {ns.description ? <DataTableCellSub>{ns.description}</DataTableCellSub> : null}
        </span>
      </div>
    );
  }

  if (row.kind === 'detected') {
    return (
      <div className="prm-ns-identity" data-testid={row.testId}>
        <Download className="prm-ns-glyph prm-ns-glyph--warn" aria-hidden />
        <span className="prm-ns-identity__text">
          <span className="prm-ns-identity__line">
            <span className="prm-ns-path mono">{row.namespace}</span>
            <span className="prm-micro prm-micro--warn">unregistered</span>
          </span>
          <DataTableCellSub>
            In use by types but not registered — add it from “New namespace”.
          </DataTableCellSub>
        </span>
      </div>
    );
  }

  return (
    <div className="prm-ns-identity" data-testid={row.testId}>
      <FolderMinus className="prm-ns-glyph" aria-hidden />
      <span className="prm-ns-identity__text">
        <span className="prm-ns-identity__line">
          <span className="prm-ns-path">Unassigned namespaces</span>
        </span>
        <DataTableCellSub>
          Types saved without a namespace — they belong to no collection.
        </DataTableCellSub>
      </span>
    </div>
  );
}
