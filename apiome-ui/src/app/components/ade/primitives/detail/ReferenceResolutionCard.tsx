'use client';

/**
 * The reference-resolution table of the primitive-detail page (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html` §Reference resolution — the relative
 * `$ref`, what it resolved to, its status, the base in the foot, and the empty sentence.
 *
 * ### What this replaces
 *
 * A hand-built `<table>` with `px-5 py-3` cells, a `bg-gray-50/60 dark:bg-gray-900/40` header
 * strip, `text-emerald-600 dark:text-emerald-400` on every `$ref` — resolved or not — and two
 * status pills spelled as `bg-amber-100 text-amber-700 dark:bg-amber-900/40 …`. It is
 * {@link DataTable} now, which brings the caps header, the density metrics and the per-column
 * skeletons, and the status is a `Badge` whose tone comes from {@link refEdgeStatus} — the same
 * function the resolver pane reads, so a resolved edge is one green across the product.
 *
 * The `$ref` still links only when the API annotated the edge with a target: an unresolved
 * `$ref` has nothing to open, which is what unresolved means, and a dead link that looks live
 * is worse than plain text.
 */

import * as React from 'react';
import Link from 'next/link';
import { Waypoints } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import {
  DataTable,
  DataTableFoot,
  DataTableToolbar,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import {
  refEdgeTargetHref,
  refEdgeTargetLabel,
  type RefEdge,
} from '@/app/ade/dashboard/primitives/primitiveDetailModel';

import {
  EMPTY_VALUE,
  NO_REFS_DESCRIPTION,
  NO_REFS_TITLE,
  refEdgeStatus,
  refsFootLabel,
} from './primitiveDetailView';

export interface ReferenceResolutionCardProps {
  /** The type's outgoing `$ref` edges, in declaration order. */
  refs: readonly RefEdge[];
  /** The absolute base the relative values were resolved against, for the foot. */
  baseUri?: string | null;
}

/** One edge, keyed for the table — the stored rows carry no id of their own. */
interface RefRow {
  key: string;
  edge: RefEdge;
  index: number;
}

/**
 * Render the card. See {@link ReferenceResolutionCardProps}.
 *
 * @returns The table of edges, or the empty sentence in its place.
 */
export default function ReferenceResolutionCard({ refs, baseUri }: ReferenceResolutionCardProps) {
  const rows = React.useMemo<RefRow[]>(
    () => refs.map((edge, index) => ({ key: `${edge.relative_ref ?? index}-${index}`, edge, index })),
    [refs]
  );

  const columns: DataTableColumn<RefRow>[] = [
    {
      id: 'ref',
      header: 'Relative $ref',
      skeletonWidth: '12rem',
      cell: ({ edge, index }) => {
        if (!edge.relative_ref) return <span className="prm-faint">{EMPTY_VALUE}</span>;
        const href = refEdgeTargetHref(edge);
        if (!href) return <span className="mono">{edge.relative_ref}</span>;
        return (
          <Link
            href={href}
            data-testid={`ref-edge-link-${index}`}
            title={refEdgeTargetLabel(edge)}
            aria-label={refEdgeTargetLabel(edge)}
            className="prm-ref-link mono"
          >
            {edge.relative_ref}
          </Link>
        );
      },
    },
    {
      id: 'target',
      header: 'Resolved target',
      skeletonWidth: '12rem',
      cell: ({ edge }) =>
        edge.resolved_target ? (
          <span className="mono">{edge.resolved_target}</span>
        ) : (
          <span className="prm-faint">{EMPTY_VALUE}</span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      align: 'end',
      skeletonWidth: '5rem',
      cell: ({ edge }) => {
        const status = refEdgeStatus(edge.status);
        return <Badge variant={status.tone}>{status.label}</Badge>;
      },
    },
  ];

  const foot = refsFootLabel(baseUri);

  return (
    <DataTable<RefRow>
      caption="Reference resolution"
      dense
      scrollX
      columns={columns}
      rows={rows}
      getRowId={(row) => row.key}
      getRowLabel={(row) => row.edge.relative_ref ?? `reference ${row.index + 1}`}
      data-testid="primitive-detail-refs"
      empty={
        <EmptyState
          icon={<Waypoints aria-hidden />}
          title={NO_REFS_TITLE}
          description={NO_REFS_DESCRIPTION}
          variant="compact"
        />
      }
      toolbar={
        <DataTableToolbar>
          <span className="prm-panel-head">
            <Waypoints aria-hidden />
            <span className="prm-panel-head__text">
              <h2 className="prm-panel-head__title">Reference resolution</h2>
              <span className="prm-panel-head__sub">
                Relative <span className="mono">$ref</span> values resolved against the type’s base
                URL · click a resolved <span className="mono">$ref</span> to open the type it points
                at
              </span>
            </span>
          </span>
        </DataTableToolbar>
      }
      footer={
        foot ? (
          <DataTableFoot data-testid="primitive-detail-refs-foot">
            <span className="mono">{foot}</span>
          </DataTableFoot>
        ) : undefined
      }
    />
  );
}
