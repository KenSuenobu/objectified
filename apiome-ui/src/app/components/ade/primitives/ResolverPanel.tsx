'use client';

/**
 * The Resolver tab (HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Resolver — the read-only resolution base,
 * the namespace select, Re-resolve, the three summary chips, the reference graph with its
 * cross-scope highlight, and the status-filtered edge table.
 *
 * ### What this replaces
 *
 * `PrimitivesResolverView`, whose three summary tiles were hand-built `bg-emerald-50` /
 * `bg-amber-50` / `bg-red-50` panels, whose graph was a `bg-gray-50 dark:bg-gray-900/40` well
 * of `text-teal-600` / `text-indigo-600` / `text-emerald-600` spans, and whose status filter
 * was four `bg-indigo-500/10` buttons. Every colour is a tone now, resolved through
 * {@link refStatusTone}, so a *Circular* edge is the same red in the chip, the graph and the
 * table — and the same red as a failed anything else in the product.
 *
 * ### What did not change
 *
 * The ticket's third acceptance criterion: the resolver still calls `POST /api/types/resolve`
 * on mount and on every Re-resolve, the counts are still {@link summarizeStatuses} over the
 * flattened edges, and the toast still distinguishes "3 primitives updated" from "all statuses
 * already current".
 */

import * as React from 'react';
import Link from 'next/link';
import { GitFork, Lock, MoveRight, RefreshCw, Waypoints } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import {
  DataTable,
  DataTableFoot,
  DataTableToolbar,
  DataTableToolbarSpacer,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Label } from '@/app/components/ui/Label';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import { STATUS_TONE_TEXT_CLASS } from '@/app/components/ui/statusVocabulary';
import { cn } from '@lib/utils';
import {
  collectNamespaces,
  deriveResolutionBase,
  emptyResolveResponse,
  filterResolverRows,
  flattenResolverEdges,
  refStatusTone,
  resolverTargetHref,
  resolverTargetLinkLabel,
  statusLabel,
  summarizeStatuses,
  type ResolveResponse,
  type ResolverEdgeRow,
  type ResolverStatusFilter,
} from '@/app/ade/dashboard/primitives/primitivesResolverModel';

import {
  RESOLVER_STATUS_FILTERS,
  reresolveSummary,
  resolverFootLabel,
} from './primitivesModel';

/** Every namespace, as the select's "no filter" value. */
const ALL_NAMESPACES = 'all';

/**
 * A resolved target, as a link to that type's details whenever the edge names a known primitive.
 *
 * Keyed on the target id rather than the status: an unresolved edge has no target row and stays
 * the plain text it always was, while a circular edge does point at a real type — and that is
 * precisely the one a reader wants to open. `testIdPrefix` keeps the graph and the table
 * separately assertable.
 */
function ResolvedTargetLink({
  row,
  className,
  testIdPrefix,
  children,
}: {
  row: ResolverEdgeRow;
  className?: string;
  testIdPrefix: string;
  children: React.ReactNode;
}) {
  const href = resolverTargetHref(row);
  if (!href) return <span className={className}>{children}</span>;

  return (
    <Link
      href={href}
      data-testid={`${testIdPrefix}-${row.key}`}
      title={resolverTargetLinkLabel(row)}
      aria-label={resolverTargetLinkLabel(row)}
      className={cn('prm-ref-link', className)}
    >
      {children}
    </Link>
  );
}

export interface ResolverPanelProps {
  /** Surface success / error notices through the screen's toaster. */
  onMessage?: (type: 'success' | 'error', text: string) => void;
}

/**
 * Render the tab. See {@link ResolverPanelProps}.
 *
 * @returns The control card, the summary chips, the graph and the edge table.
 */
export default function ResolverPanel({ onMessage }: ResolverPanelProps) {
  const [response, setResponse] = React.useState<ResolveResponse>(emptyResolveResponse());
  const [loading, setLoading] = React.useState(true);
  const [hasLoaded, setHasLoaded] = React.useState(false);
  const [namespaceFilter, setNamespaceFilter] = React.useState(ALL_NAMESPACES);
  const [statusFilter, setStatusFilter] = React.useState<ResolverStatusFilter>('all');

  const resolve = React.useCallback(
    async (announce: boolean) => {
      setLoading(true);
      try {
        const res = await fetch('/api/types/resolve', { method: 'POST' });
        const data = await res.json();
        if (data.success && data.resolve) {
          const payload = data.resolve as ResolveResponse;
          setResponse(payload);
          if (announce) {
            onMessage?.('success', reresolveSummary(payload.reresolved_primitive_count));
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

  React.useEffect(() => {
    void resolve(false);
  }, [resolve]);

  const base = React.useMemo(() => deriveResolutionBase(response.primitives), [response.primitives]);
  const allRows = React.useMemo(
    () => flattenResolverEdges(response.primitives, base),
    [response.primitives, base]
  );
  const namespaces = React.useMemo(
    () => collectNamespaces(response.primitives),
    [response.primitives]
  );
  const rows = React.useMemo(
    () => filterResolverRows(allRows, { namespace: namespaceFilter, status: statusFilter }),
    [allRows, namespaceFilter, statusFilter]
  );
  const summary = React.useMemo(() => summarizeStatuses(allRows), [allRows]);

  const columns: DataTableColumn<ResolverEdgeRow>[] = [
    {
      id: 'source',
      header: 'Source type',
      skeletonWidth: '8rem',
      cell: (row) => <span className="prm-ref-source mono">{row.sourceLabel}</span>,
    },
    {
      id: 'ref',
      header: 'Relative $ref',
      skeletonWidth: '12rem',
      cell: (row) => (
        <span className={cn('mono', STATUS_TONE_TEXT_CLASS[refStatusTone(row.status)])}>
          {row.relativeRef}
        </span>
      ),
    },
    {
      id: 'target',
      header: 'Resolved target',
      skeletonWidth: '12rem',
      cell: (row) => (
        <span className="prm-ref-target">
          {row.resolvedTarget ? (
            <ResolvedTargetLink row={row} testIdPrefix="table-target-link" className="mono">
              {row.resolvedTarget}
            </ResolvedTargetLink>
          ) : (
            <span className="prm-faint">—</span>
          )}
          {row.crossScope ? <span className="prm-micro">cross-scope</span> : null}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      align: 'end',
      skeletonWidth: '5rem',
      cell: (row) => (
        <Badge variant={refStatusTone(row.status)}>{statusLabel(row.status)}</Badge>
      ),
    },
  ];

  return (
    <div className="prm-panels">
      <Card className="prm-resolver-controls">
        <div className="prm-resolver-controls__field">
          <Label htmlFor="resolver-base">Resolution base</Label>
          <p id="resolver-base" className="prm-readonly mono">
            <Lock aria-hidden />
            <span className="prm-readonly__value">{base}</span>
          </p>
          <p className="prm-hint">read-only · API server import-source root</p>
        </div>

        <div className="prm-resolver-controls__field">
          <Label htmlFor="resolver-namespace">Namespace</Label>
          <select
            id="resolver-namespace"
            value={namespaceFilter}
            onChange={(event) => setNamespaceFilter(event.target.value)}
            className="hive-control prm-select"
          >
            <option value={ALL_NAMESPACES}>All namespaces</option>
            {namespaces.map((namespace) => (
              <option key={namespace} value={namespace}>
                {namespace}
              </option>
            ))}
          </select>
        </div>

        <Button onClick={() => void resolve(true)} disabled={loading} className="prm-resolver-go">
          <RefreshCw aria-hidden className={loading ? 'prm-spin' : undefined} />
          Re-resolve
        </Button>

        <section className="prm-resolver-summary" aria-label="Resolution summary">
          <Badge variant="ok" size="lg" data-testid="resolver-summary-resolved">
            Resolved {summary.resolved}
          </Badge>
          <Badge variant="warn" size="lg" data-testid="resolver-summary-unresolved">
            Unresolved {summary.unresolved}
          </Badge>
          <Badge variant="danger" size="lg" data-testid="resolver-summary-circular">
            Circular {summary.circular}
          </Badge>
        </section>
      </Card>

      {loading && !hasLoaded ? (
        <Card>
          <LoadingState minHeightClassName="min-h-[13.75rem]" message="Resolving references…" />
        </Card>
      ) : allRows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<GitFork aria-hidden />}
            title="No references to resolve"
            description="None of this tenant’s primitives carry a relative $ref yet. References appear here once types reference one another."
            variant="compact"
          />
        </Card>
      ) : (
        <>
          <Card className="prm-graph">
            <h3 className="prm-panel-head__title">
              <Waypoints aria-hidden />
              Reference graph
            </h3>
            <p className="prm-panel-head__sub">
              Each edge is one relative <span className="mono">$ref</span>. Cross-scope edges
              (tenant → core) are highlighted · click a resolved target to open its details.
            </p>
            <div className="prm-graph__body" data-testid="resolver-graph">
              {rows.length === 0 ? (
                <p className="prm-quiet">No references match this filter.</p>
              ) : (
                rows.map((row) => (
                  <span key={row.key} className="prm-refline" data-cross-scope={row.crossScope}>
                    <span className="prm-refline__source mono">{row.sourceLabel}</span>
                    <MoveRight aria-hidden />
                    <ResolvedTargetLink
                      row={row}
                      testIdPrefix="graph-target-link"
                      className={cn('mono', STATUS_TONE_TEXT_CLASS[refStatusTone(row.status)])}
                    >
                      {row.resolvedTarget || row.relativeRef}
                    </ResolvedTargetLink>
                    {row.crossScope ? (
                      <span className="prm-quiet">(cross-scope: tenant → core)</span>
                    ) : null}
                  </span>
                ))
              )}
            </div>
          </Card>

          <DataTable<ResolverEdgeRow>
            className="prm-ref-table"
            caption="Reference resolution"
            dense
            scrollX
            columns={columns}
            rows={rows}
            getRowId={(row) => row.key}
            getRowLabel={(row) => `${row.sourceLabel} → ${row.relativeRef}`}
            empty={
              <EmptyState
                icon={<Waypoints aria-hidden />}
                title="No references match this filter."
                description="Choose another status, or clear the namespace filter."
                variant="compact"
              />
            }
            toolbar={
              <DataTableToolbar>
                <span className="prm-panel-head">
                  <Waypoints aria-hidden />
                  <span className="prm-panel-head__text">
                    <h3 className="prm-panel-head__title">Reference resolution</h3>
                    <span className="prm-panel-head__sub">
                      Relative <span className="mono">$ref</span> resolved against each source
                      type’s import-source base URL
                    </span>
                  </span>
                </span>
                <DataTableToolbarSpacer />
                <Segmented
                  size="sm"
                  value={statusFilter}
                  onValueChange={(value) => setStatusFilter(value as ResolverStatusFilter)}
                  aria-label="Reference status"
                >
                  {RESOLVER_STATUS_FILTERS.map((option) => (
                    <SegmentedItem key={option.id} value={option.id}>
                      {option.label}
                    </SegmentedItem>
                  ))}
                </Segmented>
              </DataTableToolbar>
            }
            footer={
              <DataTableFoot data-testid="resolver-foot">
                <span>{resolverFootLabel(rows.length, allRows.length)}</span>
              </DataTableFoot>
            }
          />
        </>
      )}
    </div>
  );
}
