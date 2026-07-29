'use client';

import {
  FolderTree,
  Shapes,
  Library,
  Building2,
  Download,
  FolderMinus,
} from 'lucide-react';
import {
  dashboardPanelClass,
  dashboardTableTheadClass,
  dashboardThClass,
  dashboardThRightClass,
  dashboardTbodyClass,
  dashboardTrHoverClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import type { NamespaceScopeFilter, TypeNamespaceCollection } from './primitivesRegistryTypes';
import type { DetectedNamespace } from './namespaceModel';

interface PrimitivesNamespaceCollectionsProps {
  namespaces: TypeNamespaceCollection[];
  unresolvedByNamespace: Record<string, number>;
  scopeFilter: NamespaceScopeFilter;
  onScopeFilterChange: (filter: NamespaceScopeFilter) => void;
  onNamespaceSelect: (namespace: string) => void;
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

const SCOPE_FILTERS: { id: NamespaceScopeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'system', label: 'System · core' },
  { id: 'tenant', label: 'Tenant' },
  { id: 'imported', label: 'Imported' },
];

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
  const filtered = namespaces.filter((ns) => {
    if (scopeFilter === 'system') return ns.scope === 'system';
    if (scopeFilter === 'tenant') return ns.scope === 'tenant';
    if (scopeFilter === 'imported') {
      return ns.scope === 'tenant' && !ns.is_default && !ns.namespace.startsWith('tenant/');
    }
    return true;
  });

  // The unassigned and unregistered rows describe types rather than registered collections, so they
  // have no scope to filter by; they show under "All" and are hidden by the scope filters.
  const showExtras = scopeFilter === 'all';
  const extraRowCount =
    (showExtras ? detectedNamespaces.length : 0) + (showExtras && unassignedCount > 0 ? 1 : 0);

  return (
    <section className={`${dashboardPanelClass} xl:col-span-2 overflow-hidden`}>
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <FolderTree className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Type collections</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Grouped by namespace · click a row to filter types below
            </p>
          </div>
        </div>
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

      {loading ? (
        <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading namespaces…</div>
      ) : filtered.length === 0 && extraRowCount === 0 ? (
        <div className="p-6 text-sm text-gray-500 dark:text-gray-400">No namespace collections match this filter.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className={dashboardTableTheadClass}>
              <tr>
                <th className={dashboardThClass}>Namespace</th>
                <th className={dashboardThClass}>Scope</th>
                <th className={dashboardThRightClass}>Types</th>
                <th className={dashboardThClass}>Draft</th>
                <th className={dashboardThRightClass}>Status</th>
              </tr>
            </thead>
            <tbody className={dashboardTbodyClass}>
              {filtered.map((ns) => {
                const unresolved = unresolvedByNamespace[ns.namespace] ?? 0;
                const isImported =
                  scopeFilter === 'imported' ||
                  (!ns.is_system && !ns.namespace.startsWith('std/') && !ns.namespace.startsWith('tenant/'));
                const Icon = namespaceIcon(ns.namespace, isImported);
                return (
                  <tr
                    key={ns.id}
                    className={`${dashboardTrHoverClass} cursor-pointer`}
                    onClick={() => onNamespaceSelect(ns.namespace)}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="w-8 h-8 rounded-md bg-indigo-100 dark:bg-indigo-900/40 inline-flex items-center justify-center text-indigo-600 dark:text-indigo-300">
                          <Icon className="w-4 h-4" />
                        </span>
                        <div>
                          <p className="font-medium font-mono text-gray-900 dark:text-white">
                            {ns.namespace}
                            {isImported ? (
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
                    <td className="px-3 py-3 font-mono text-xs text-gray-400">2020-12</td>
                    <td className="px-5 py-3 text-right">{statusBadge(unresolved)}</td>
                  </tr>
                );
              })}

              {/* Namespaces the types use that were never registered as collections. Listing them
                  is what stops an imported namespace from vanishing from this screen. */}
              {showExtras
                ? detectedNamespaces.map((detected) => (
                    <tr
                      key={`detected-${detected.namespace}`}
                      data-testid={`detected-namespace-${detected.namespace}`}
                      className={`${dashboardTrHoverClass} cursor-pointer`}
                      onClick={() => onNamespaceSelect(detected.namespace)}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <span className="w-8 h-8 rounded-md bg-amber-100 dark:bg-amber-900/40 inline-flex items-center justify-center text-amber-600 dark:text-amber-300">
                            <Download className="w-4 h-4" />
                          </span>
                          <div>
                            <p className="font-medium font-mono text-gray-900 dark:text-white">
                              {detected.namespace}
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
                        {detected.typeCount}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-gray-400">2020-12</td>
                      <td className="px-5 py-3 text-right">
                        {statusBadge(unresolvedByNamespace[detected.namespace] ?? 0)}
                      </td>
                    </tr>
                  ))
                : null}

              {/* Types with no namespace at all. They cannot be registered — there is nothing to
                  register — so they get their own row rather than being quietly dropped. */}
              {showExtras && unassignedCount > 0 ? (
                <tr
                  data-testid="unassigned-namespaces-row"
                  className={`${dashboardTrHoverClass} cursor-pointer`}
                  onClick={() => onNamespaceSelect(UNASSIGNED_NAMESPACE_KEY)}
                >
                  <td className="px-5 py-3">
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
                    {unassignedCount}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-gray-400">2020-12</td>
                  <td className="px-5 py-3 text-right">{statusBadge(0)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700/60 text-xs text-gray-500 dark:text-gray-400 flex items-center justify-between">
        <span>
          {filtered.length} of {namespaces.length} collection{namespaces.length === 1 ? '' : 's'}
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
