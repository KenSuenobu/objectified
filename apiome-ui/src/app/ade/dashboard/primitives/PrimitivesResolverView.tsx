'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  RefreshCw,
  Lock,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  GitFork,
  Waypoints,
  MoveRight,
} from 'lucide-react';
import { Button } from '@/app/components/ui/Button';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  dashboardPanelClass,
  dashboardPanelPaddedClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  collectNamespaces,
  deriveResolutionBase,
  emptyResolveResponse,
  filterResolverRows,
  flattenResolverEdges,
  resolverTargetHref,
  resolverTargetLinkLabel,
  statusBadgeClass,
  statusLabel,
  summarizeStatuses,
  type ResolveResponse,
  type ResolverEdgeRow,
  type ResolverStatusFilter,
} from './primitivesResolverModel';

interface PrimitivesResolverViewProps {
  /** Surface success/error notices through the parent screen's alert. */
  onMessage?: (type: 'success' | 'error', text: string) => void;
}

/**
 * A resolved target, as a link to that type's details whenever the edge names a known primitive.
 *
 * Keyed on the target id rather than the status: an unresolved edge has no target row and stays the
 * plain text it always was, while a circular edge does point at a real type — and that is precisely
 * the one a reader wants to open. `testIdPrefix` keeps the graph and the table separately assertable.
 */
function ResolvedTargetLink({
  row,
  className,
  testIdPrefix,
  children,
}: {
  row: ResolverEdgeRow;
  className: string;
  testIdPrefix: string;
  children: ReactNode;
}) {
  const href = resolverTargetHref(row);
  if (!href) return <span className={className}>{children}</span>;

  return (
    <Link
      href={href}
      data-testid={`${testIdPrefix}-${row.key}`}
      title={resolverTargetLinkLabel(row)}
      aria-label={resolverTargetLinkLabel(row)}
      className={`${className} underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded`}
    >
      {children}
    </Link>
  );
}

const STATUS_FILTERS: { id: ResolverStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'unresolved', label: 'Unresolved' },
  { id: 'circular', label: 'Circular' },
];

/**
 * Reference Resolver view (#3470).
 *
 * Renders the resolver output of `POST /api/types/resolve` (REST #3459): a read-only
 * resolution-base control, a namespace filter, a re-resolve action, summary chips
 * (resolved / unresolved / circular), a reference graph, and the per-edge resolution
 * table with resolved/unresolved/(circular) status. The first load and every Re-resolve
 * click hit the same endpoint, which persists status changes — "re-resolve updates
 * statuses".
 */
export default function PrimitivesResolverView({ onMessage }: PrimitivesResolverViewProps) {
  const [response, setResponse] = useState<ResolveResponse>(emptyResolveResponse());
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [namespaceFilter, setNamespaceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<ResolverStatusFilter>('all');

  const resolve = useCallback(
    async (announce: boolean) => {
      setLoading(true);
      try {
        const res = await fetch('/api/types/resolve', { method: 'POST' });
        const data = await res.json();
        if (data.success && data.resolve) {
          const payload = data.resolve as ResolveResponse;
          setResponse(payload);
          if (announce) {
            onMessage?.(
              'success',
              payload.reresolved_primitive_count > 0
                ? `Re-resolved · ${payload.reresolved_primitive_count} primitive${
                    payload.reresolved_primitive_count === 1 ? '' : 's'
                  } updated`
                : 'Re-resolved · all statuses already current'
            );
          }
        } else {
          onMessage?.('error', data.error || 'Failed to resolve references');
        }
      } catch (error) {
        console.error('Error resolving references:', error);
        onMessage?.('error', 'Failed to resolve references');
      } finally {
        setLoading(false);
        setHasLoaded(true);
      }
    },
    [onMessage]
  );

  useEffect(() => {
    void resolve(false);
  }, [resolve]);

  const base = useMemo(() => deriveResolutionBase(response.primitives), [response.primitives]);
  const allRows = useMemo(
    () => flattenResolverEdges(response.primitives, base),
    [response.primitives, base]
  );
  const namespaces = useMemo(() => collectNamespaces(response.primitives), [response.primitives]);
  const rows = useMemo(
    () => filterResolverRows(allRows, { namespace: namespaceFilter, status: statusFilter }),
    [allRows, namespaceFilter, statusFilter]
  );
  const summary = useMemo(() => summarizeStatuses(allRows), [allRows]);

  return (
    <div className="space-y-6">
      {/* Top control card: resolution base · namespace filter · re-resolve */}
      <section className={dashboardPanelPaddedClass}>
        <div className="flex flex-col lg:flex-row lg:items-end gap-4">
          <div className="flex-1 min-w-0">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              Resolution base
            </label>
            <div className="flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2">
              <Lock className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
              <span className="font-mono text-xs text-gray-600 dark:text-gray-300 truncate">
                {base}
              </span>
            </div>
            <p className="text-[10px] text-gray-400 mt-1 font-mono">
              read-only · API server import-source root
            </p>
          </div>

          <div className="w-full lg:w-64">
            <label
              htmlFor="resolver-namespace"
              className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
            >
              Namespace
            </label>
            <select
              id="resolver-namespace"
              value={namespaceFilter}
              onChange={(e) => setNamespaceFilter(e.target.value)}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white"
            >
              <option value="all">All namespaces</option>
              {namespaces.map((namespace) => (
                <option key={namespace} value={namespace}>
                  {namespace}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-shrink-0">
            <Button onClick={() => resolve(true)} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Re-resolve
            </Button>
          </div>
        </div>
      </section>

      {/* Summary stat chips */}
      <section className="flex flex-wrap gap-3" aria-label="Resolution summary">
        <div className="flex items-center gap-3 rounded-lg border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-900/20 px-4 py-3">
          <span className="w-9 h-9 rounded-md bg-emerald-100 dark:bg-emerald-900/40 inline-flex items-center justify-center text-emerald-600 dark:text-emerald-300">
            <CheckCircle2 className="w-5 h-5" />
          </span>
          <div>
            <p className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400 leading-none">
              {summary.resolved}
            </p>
            <p className="text-[11px] text-emerald-700 dark:text-emerald-300 mt-1">Resolved</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
          <span className="w-9 h-9 rounded-md bg-amber-100 dark:bg-amber-900/40 inline-flex items-center justify-center text-amber-600 dark:text-amber-300">
            <AlertTriangle className="w-5 h-5" />
          </span>
          <div>
            <p className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400 leading-none">
              {summary.unresolved}
            </p>
            <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-1">Unresolved</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-900/20 px-4 py-3">
          <span className="w-9 h-9 rounded-md bg-red-100 dark:bg-red-900/40 inline-flex items-center justify-center text-red-600 dark:text-red-300">
            <RotateCcw className="w-5 h-5" />
          </span>
          <div>
            <p className="text-2xl font-bold font-mono text-red-600 dark:text-red-400 leading-none">
              {summary.circular}
            </p>
            <p className="text-[11px] text-red-700 dark:text-red-300 mt-1">Circular</p>
          </div>
        </div>
      </section>

      {loading && !hasLoaded ? (
        <div className={dashboardPanelClass}>
          <LoadingState minHeightClassName="min-h-[220px]" message="Resolving references…" />
        </div>
      ) : allRows.length === 0 ? (
        <section className={`${dashboardPanelClass} p-8 text-center`}>
          <GitFork className="w-8 h-8 mx-auto text-gray-400" />
          <h3 className="mt-3 text-base font-semibold text-gray-900 dark:text-white">
            No references to resolve
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            None of this tenant&apos;s primitives carry a relative <span className="font-mono">$ref</span>{' '}
            yet. References appear here once types reference one another.
          </p>
        </section>
      ) : (
        <>
          {/* Reference graph */}
          <section className={dashboardPanelPaddedClass}>
            <h3 className="text-sm font-semibold mb-1 flex items-center gap-2 text-gray-900 dark:text-white">
              <GitFork className="w-4 h-4 text-indigo-500" /> Reference graph
            </h3>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-4">
              Each edge is one relative <span className="font-mono">$ref</span>. Cross-scope edges
              (tenant → core) are highlighted · click a resolved target to open its details.
            </p>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40 p-4 font-mono text-[12px] leading-7 overflow-x-auto">
              {rows.length === 0 ? (
                <p className="text-gray-400">No references match this filter.</p>
              ) : (
                rows.map((row) => (
                  <div key={row.key} className="whitespace-nowrap flex items-center gap-2">
                    <span
                      className={
                        row.sourceNamespace?.startsWith('tenant/')
                          ? 'text-teal-600 dark:text-teal-300'
                          : 'text-indigo-600 dark:text-indigo-300'
                      }
                    >
                      {row.sourceLabel}
                    </span>
                    <MoveRight
                      className={`w-4 h-4 flex-shrink-0 ${
                        row.crossScope ? 'text-teal-500' : 'text-gray-400'
                      }`}
                    />
                    <ResolvedTargetLink
                      row={row}
                      testIdPrefix="graph-target-link"
                      className={
                        row.status === 'resolved'
                          ? 'text-emerald-600 dark:text-emerald-300'
                          : row.status === 'circular'
                            ? 'text-red-600 dark:text-red-300'
                            : 'text-amber-600 dark:text-amber-300'
                      }
                    >
                      {row.resolvedTarget || row.relativeRef}
                    </ResolvedTargetLink>
                    {row.crossScope ? (
                      <span className="text-teal-500 text-[10px]">(cross-scope: tenant → core)</span>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Reference resolution table */}
          <section className={`${dashboardPanelClass} overflow-hidden`}>
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Waypoints className="w-5 h-5 text-indigo-500" />
                <div>
                  <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                    Reference resolution
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Relative <span className="font-mono">$ref</span> resolved against each source
                    type&apos;s import-source base URL · click a resolved target to open its details
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 border border-gray-200 dark:border-gray-700 rounded-md p-0.5 text-xs">
                {STATUS_FILTERS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setStatusFilter(id)}
                    className={`px-2 py-1 rounded transition-colors ${
                      statusFilter === id
                        ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-medium'
                        : 'text-gray-500 dark:text-gray-400 hover:text-indigo-500'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
                No references match this filter.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 bg-gray-50/60 dark:bg-gray-900/40">
                    <tr>
                      <th className="text-left px-5 py-2 font-semibold">Source type</th>
                      <th className="text-left px-3 py-2 font-semibold">Relative $ref</th>
                      <th className="text-left px-3 py-2 font-semibold">Resolved target</th>
                      <th className="text-right px-5 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                    {rows.map((row) => (
                      <tr key={row.key} className="hover:bg-gray-50/60 dark:hover:bg-gray-900/30">
                        <td className="px-5 py-3 font-mono text-xs text-gray-900 dark:text-white">
                          {row.sourceLabel}
                        </td>
                        <td
                          className={`px-3 py-3 font-mono text-xs ${
                            row.status === 'resolved'
                              ? 'text-emerald-600 dark:text-emerald-300'
                              : row.status === 'circular'
                                ? 'text-red-600 dark:text-red-300'
                                : 'text-amber-600 dark:text-amber-300'
                          }`}
                        >
                          {row.relativeRef}
                        </td>
                        <td className="px-3 py-3 font-mono text-xs">
                          {row.resolvedTarget ? (
                            <ResolvedTargetLink
                              row={row}
                              testIdPrefix="table-target-link"
                              className="text-indigo-600 dark:text-indigo-300"
                            >
                              {row.resolvedTarget}
                            </ResolvedTargetLink>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                          {row.crossScope ? (
                            <span className="ml-2 text-[9px] px-1 rounded bg-teal-100 dark:bg-teal-900/40 text-teal-600 dark:text-teal-300">
                              cross-scope
                            </span>
                          ) : null}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <span
                            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${statusBadgeClass(
                              row.status
                            )}`}
                          >
                            {statusLabel(row.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700/60 text-xs text-gray-500 dark:text-gray-400">
              {rows.length} of {allRows.length} reference{allRows.length === 1 ? '' : 's'} shown
            </div>
          </section>
        </>
      )}
    </div>
  );
}
