'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  FolderTree,
  Shapes,
  Library,
  Building2,
  Download,
  FolderMinus,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from 'lucide-react';
import {
  dashboardPanelClass,
  dashboardTableTheadClass,
  dashboardTbodyClass,
  dashboardTrHoverClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  nextNamespaceCollectionSort,
  type NamespaceCollectionSortColumn,
  type NamespaceCollectionSortRow,
  type NamespaceCollectionSortState,
} from '@/app/utils/primitives-namespaces-sort';
import {
  buildNamespaceGroups,
  sortNamespaceTree,
  type NamespaceTreeEntry,
} from '@/app/utils/primitives-namespace-groups';
import type { NamespaceScopeFilter, TypeNamespaceCollection } from './primitivesRegistryTypes';
import type { DetectedNamespace } from './namespaceModel';

/** How a namespace click should filter the types below: just that namespace, or its whole family. */
export interface NamespaceSelectOptions {
  includeDescendants?: boolean;
}

interface PrimitivesNamespaceCollectionsProps {
  namespaces: TypeNamespaceCollection[];
  unresolvedByNamespace: Record<string, number>;
  scopeFilter: NamespaceScopeFilter;
  onScopeFilterChange: (filter: NamespaceScopeFilter) => void;
  onNamespaceSelect: (namespace: string, options?: NamespaceSelectOptions) => void;
  /**
   * How many types carry no namespace at all. They belong to no collection, so without a row of
   * their own they are invisible here — the list would silently account for only part of the
   * registry.
   */
  unassignedCount: number;
  /**
   * Namespaces that types already use but that have no collection row yet. Surfaced as a row so
   * the reader can see the types exist and register the namespace from "New namespace".
   */
  detectedNamespaces: DetectedNamespace[];
  loading: boolean;
}

/** The sentinel the unassigned row selects with; matches types whose namespace is null or blank. */
export const UNASSIGNED_NAMESPACE_KEY = '';

/** The JSON Schema draft every namespace is currently pinned to. */
const NAMESPACE_DRAFT = '2020-12';

const SCOPE_FILTERS: { id: NamespaceScopeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'system', label: 'System · core' },
  { id: 'tenant', label: 'Tenant' },
  { id: 'imported', label: 'Imported' },
];

/** Header cell classes, narrowed from the shared dashboard tokens to this table's tighter gutters. */
const thClass =
  'px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';
const thFirstClass = `${thClass} pl-5`;
const thRightClass = `${thClass} text-right`;
const thLastClass = `${thRightClass} pr-5`;

function namespaceIcon(namespace: string, isImported: boolean) {
  if (isImported) return Download;
  if (namespace.startsWith('std/')) return namespace.includes('primitives') ? Shapes : Library;
  return Building2;
}

function scopeBadge(scope: 'system' | 'tenant') {
  if (scope === 'system') {
    return (
      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">
        System · core
      </span>
    );
  }
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
      Tenant
    </span>
  );
}

/** A group whose members do not share one scope; the badge says so rather than picking a winner. */
function mixedScopeBadge() {
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-700/60 dark:text-gray-300">
      Mixed
    </span>
  );
}

function statusBadge(unresolvedCount: number) {
  if (unresolvedCount > 0) {
    return (
      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
        {unresolvedCount} unresolved
      </span>
    );
  }
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
      Resolved
    </span>
  );
}

/** A column header that sorts the table, showing which way it is currently ordered. */
function SortTh({
  column,
  sort,
  onSortClick,
  className,
  align = 'left',
  children,
}: {
  column: NamespaceCollectionSortColumn;
  sort: NamespaceCollectionSortState;
  onSortClick: (column: NamespaceCollectionSortColumn) => void;
  className: string;
  align?: 'left' | 'right';
  children: ReactNode;
}) {
  const active = sort.column === column;
  return (
    <th
      scope="col"
      className={className}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSortClick(column)}
        data-testid={`namespace-collections-sort-${column}`}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium uppercase tracking-wider text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        <span className="truncate">{children}</span>
        {active ? (
          sort.direction === 'asc' ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-40" aria-hidden />
        )}
      </button>
    </th>
  );
}

/**
 * The three kinds of row this panel renders, flattened onto the sort model so one click orders all
 * of them together. `namespace` is what {@link PrimitivesNamespaceCollectionsProps.onNamespaceSelect}
 * receives; `path` is the namespace path grouping reads (null for the unassigned bucket, which sits
 * on no path); the remaining fields carry what each kind needs to render.
 */
type CollectionRow = NamespaceCollectionSortRow & {
  namespace: string;
  path: string | null;
  collection?: TypeNamespaceCollection;
  isImported?: boolean;
  testId?: string;
};

export default function PrimitivesNamespaceCollections({
  namespaces,
  unresolvedByNamespace,
  scopeFilter,
  onScopeFilterChange,
  onNamespaceSelect,
  unassignedCount,
  detectedNamespaces,
  loading,
}: PrimitivesNamespaceCollectionsProps) {
  // Unsorted by default, so the panel opens in the order the registry returned.
  const [sort, setSort] = useState<NamespaceCollectionSortState>({ column: null, direction: 'asc' });
  const [grouped, setGrouped] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());

  const filtered = useMemo(
    () =>
      namespaces.filter((ns) => {
        if (scopeFilter === 'system') return ns.scope === 'system';
        if (scopeFilter === 'tenant') return ns.scope === 'tenant';
        if (scopeFilter === 'imported') {
          return ns.scope === 'tenant' && !ns.is_default && !ns.namespace.startsWith('tenant/');
        }
        return true;
      }),
    [namespaces, scopeFilter],
  );

  // The unassigned and unregistered rows describe types rather than registered collections, so they
  // have no scope to filter by; they show under "All" and are hidden by the scope filters.
  const showExtras = scopeFilter === 'all';
  const extraRowCount =
    (showExtras ? detectedNamespaces.length : 0) + (showExtras && unassignedCount > 0 ? 1 : 0);

  const rows = useMemo<CollectionRow[]>(() => {
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

    // Types with no namespace at all. They cannot be registered — there is nothing to register — so
    // they get their own row rather than being quietly dropped. They sit on no path, so grouping
    // leaves them alone.
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
  }, [filtered, detectedNamespaces, unresolvedByNamespace, unassignedCount, scopeFilter, showExtras]);

  const tree = useMemo<NamespaceTreeEntry<CollectionRow>[]>(() => {
    const entries: NamespaceTreeEntry<CollectionRow>[] = grouped
      ? buildNamespaceGroups(rows)
      : rows.map((row) => ({ kind: 'row' as const, row }));
    return sortNamespaceTree(entries, sort.column, sort.direction);
  }, [rows, grouped, sort.column, sort.direction]);

  const groupCount = tree.filter((entry) => entry.kind === 'group').length;

  const handleSortClick = (column: NamespaceCollectionSortColumn) => {
    setSort((current) => nextNamespaceCollectionSort(current, column));
  };

  const toggleGroup = (prefix: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(prefix)) next.add(prefix);
      return next;
    });
  };

  /** One collection / unregistered / unassigned row; `indented` marks it as inside a group. */
  const renderRow = (row: CollectionRow, indented: boolean, isGroupRoot: boolean) => {
    const nameCellClass = `py-3 pr-3 ${indented ? 'pl-12' : 'px-5'}`;

    if (row.kind === 'registered' && row.collection) {
      const ns = row.collection;
      const Icon = namespaceIcon(ns.namespace, !!row.isImported);
      return (
        <tr
          key={row.key}
          className={`${dashboardTrHoverClass} cursor-pointer`}
          onClick={() => onNamespaceSelect(ns.namespace)}
        >
          <td className={nameCellClass}>
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-md bg-indigo-100 dark:bg-indigo-900/40 inline-flex items-center justify-center text-indigo-600 dark:text-indigo-300">
                <Icon className="w-4 h-4" />
              </span>
              <div>
                <p className="font-medium font-mono text-gray-900 dark:text-white">
                  {ns.namespace}
                  {isGroupRoot ? (
                    <span className="ml-2 text-[9px] px-1 rounded bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300 uppercase">
                      root
                    </span>
                  ) : null}
                  {row.isImported ? (
                    <span className="ml-2 text-[9px] px-1 rounded bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-300 uppercase">
                      imported
                    </span>
                  ) : null}
                </p>
                {ns.description ? (
                  <p className="text-[10px] text-gray-400 line-clamp-1">{ns.description}</p>
                ) : null}
              </div>
            </div>
          </td>
          <td className="px-3 py-3">{scopeBadge(ns.scope)}</td>
          <td className="px-3 py-3 text-right font-mono text-xs text-gray-700 dark:text-gray-300">
            {ns.type_count}
          </td>
          <td className="px-3 py-3 font-mono text-xs text-gray-400">{row.draft}</td>
          <td className="px-5 py-3 text-right">{statusBadge(row.unresolvedCount)}</td>
        </tr>
      );
    }

    if (row.kind === 'detected') {
      return (
        <tr
          key={row.key}
          data-testid={row.testId}
          className={`${dashboardTrHoverClass} cursor-pointer`}
          onClick={() => onNamespaceSelect(row.namespace)}
        >
          <td className={nameCellClass}>
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-md bg-amber-100 dark:bg-amber-900/40 inline-flex items-center justify-center text-amber-600 dark:text-amber-300">
                <Download className="w-4 h-4" />
              </span>
              <div>
                <p className="font-medium font-mono text-gray-900 dark:text-white">
                  {row.namespace}
                  <span className="ml-2 text-[9px] px-1 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 uppercase">
                    unregistered
                  </span>
                </p>
                <p className="text-[10px] text-gray-400">
                  In use by types but not registered — add it from “New namespace”.
                </p>
              </div>
            </div>
          </td>
          <td className="px-3 py-3 text-[10px] uppercase tracking-wider text-gray-400">—</td>
          <td className="px-3 py-3 text-right font-mono text-xs text-gray-700 dark:text-gray-300">
            {row.typeCount}
          </td>
          <td className="px-3 py-3 font-mono text-xs text-gray-400">{row.draft}</td>
          <td className="px-5 py-3 text-right">{statusBadge(row.unresolvedCount)}</td>
        </tr>
      );
    }

    return (
      <tr
        key={row.key}
        data-testid={row.testId}
        className={`${dashboardTrHoverClass} cursor-pointer`}
        onClick={() => onNamespaceSelect(UNASSIGNED_NAMESPACE_KEY)}
      >
        <td className={nameCellClass}>
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-md bg-gray-100 dark:bg-gray-800 inline-flex items-center justify-center text-gray-500 dark:text-gray-400">
              <FolderMinus className="w-4 h-4" />
            </span>
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Unassigned namespaces</p>
              <p className="text-[10px] text-gray-400">
                Types saved without a namespace — they belong to no collection.
              </p>
            </div>
          </div>
        </td>
        <td className="px-3 py-3 text-[10px] uppercase tracking-wider text-gray-400">—</td>
        <td className="px-3 py-3 text-right font-mono text-xs text-gray-700 dark:text-gray-300">
          {row.typeCount}
        </td>
        <td className="px-3 py-3 font-mono text-xs text-gray-400">{row.draft}</td>
        <td className="px-5 py-3 text-right">{statusBadge(0)}</td>
      </tr>
    );
  };

  return (
    <section className={`${dashboardPanelClass} xl:col-span-2 overflow-hidden`}>
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <FolderTree className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Type collections</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {grouped
                ? 'Grouped by parent namespace · click a row to filter types below, a column to sort'
                : 'One row per namespace · click a row to filter types below, a column to sort'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setGrouped((current) => !current)}
            data-testid="namespace-group-toggle"
            aria-pressed={grouped}
            title="Collapse namespaces that share a parent path into one row"
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
              grouped
                ? 'border-indigo-200 dark:border-indigo-800 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-medium'
                : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-indigo-500'
            }`}
          >
            <FolderTree className="w-3.5 h-3.5" aria-hidden />
            Group
          </button>
          <div className="flex items-center gap-1 border border-gray-200 dark:border-gray-700 rounded-md p-0.5 text-xs">
            {SCOPE_FILTERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => onScopeFilterChange(id)}
                className={`px-2 py-1 rounded transition-colors ${
                  scopeFilter === id
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-medium'
                    : 'text-gray-500 dark:text-gray-400 hover:text-indigo-500'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading namespaces…</div>
      ) : filtered.length === 0 && extraRowCount === 0 ? (
        <div className="p-6 text-sm text-gray-500 dark:text-gray-400">No namespace collections match this filter.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className={dashboardTableTheadClass}>
              <tr>
                <SortTh column="namespace" sort={sort} onSortClick={handleSortClick} className={thFirstClass}>
                  Namespace
                </SortTh>
                <SortTh column="scope" sort={sort} onSortClick={handleSortClick} className={thClass}>
                  Scope
                </SortTh>
                <SortTh
                  column="types"
                  sort={sort}
                  onSortClick={handleSortClick}
                  className={thRightClass}
                  align="right"
                >
                  Types
                </SortTh>
                <SortTh column="draft" sort={sort} onSortClick={handleSortClick} className={thClass}>
                  Draft
                </SortTh>
                <SortTh
                  column="status"
                  sort={sort}
                  onSortClick={handleSortClick}
                  className={thLastClass}
                  align="right"
                >
                  Status
                </SortTh>
              </tr>
            </thead>
            <tbody className={dashboardTbodyClass}>
              {tree.map((entry) => {
                if (entry.kind === 'row') return renderRow(entry.row, false, false);

                const { prefix, header, members, rootKeys } = entry.group;
                const expanded = expandedGroups.has(prefix);
                const Chevron = expanded ? ChevronDown : ChevronRight;
                const GroupIcon = expanded ? FolderOpen : Folder;

                return (
                  <Fragment key={`group-${prefix}`}>
                    <tr
                      data-testid={`namespace-group-${prefix}`}
                      className={`${dashboardTrHoverClass} cursor-pointer bg-gray-50/60 dark:bg-gray-900/30`}
                      // Selecting the group filters the types below to the whole family, which is
                      // the only reading of a click on a row that stands for many namespaces.
                      onClick={() => onNamespaceSelect(prefix, { includeDescendants: true })}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            data-testid={`namespace-group-expand-${prefix}`}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${prefix}`}
                            onClick={(event) => {
                              // The row itself selects the family; only the chevron expands it.
                              event.stopPropagation();
                              toggleGroup(prefix);
                            }}
                            className="p-0.5 rounded text-gray-400 hover:text-indigo-500 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                          >
                            <Chevron className="w-4 h-4" aria-hidden />
                          </button>
                          <span className="w-8 h-8 rounded-md bg-indigo-100 dark:bg-indigo-900/40 inline-flex items-center justify-center text-indigo-600 dark:text-indigo-300">
                            <GroupIcon className="w-4 h-4" aria-hidden />
                          </span>
                          <div>
                            <p className="font-semibold font-mono text-gray-900 dark:text-white">
                              {prefix}
                              <span className="ml-2 font-sans text-[9px] px-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 uppercase">
                                group
                              </span>
                            </p>
                            <p className="text-[10px] text-gray-400">
                              {header.collectionCount} namespace{header.collectionCount === 1 ? '' : 's'} ·{' '}
                              {header.typeCount} type{header.typeCount === 1 ? '' : 's'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {header.scopeMixed
                          ? mixedScopeBadge()
                          : header.scope
                            ? scopeBadge(header.scope)
                            : <span className="text-[10px] uppercase tracking-wider text-gray-400">—</span>}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs font-semibold text-gray-700 dark:text-gray-300">
                        {header.typeCount}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-gray-400">{header.draft || '—'}</td>
                      <td className="px-5 py-3 text-right">{statusBadge(header.unresolvedCount)}</td>
                    </tr>
                    {expanded
                      ? members.map((member) => renderRow(member, true, rootKeys.has(member.key)))
                      : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700/60 text-xs text-gray-500 dark:text-gray-400 flex items-center justify-between">
        <span>
          {filtered.length} of {namespaces.length} collection{namespaces.length === 1 ? '' : 's'}
          {grouped && groupCount > 0 ? (
            <span data-testid="namespace-group-count"> · {groupCount} group{groupCount === 1 ? '' : 's'}</span>
          ) : null}
          {showExtras && detectedNamespaces.length > 0 ? (
            <span data-testid="detected-namespace-count"> · {detectedNamespaces.length} unregistered</span>
          ) : null}
          {showExtras && unassignedCount > 0 ? (
            <span data-testid="unassigned-type-count"> · {unassignedCount} unassigned</span>
          ) : null}
        </span>
      </div>
    </section>
  );
}
