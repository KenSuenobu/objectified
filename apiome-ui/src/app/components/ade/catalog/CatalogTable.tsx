'use client';

/**
 * The catalog list, as a table (HIVE-7.1, #5318).
 *
 * Authority: `docs/mockups/sources/catalog.html` §Table view — `Artifact · Format · Protocol ·
 * Source · Quality · Grade · Status · Updated · actions`, every data column sortable with
 * `aria-sort`, row selection, the inline Undelete on a deleted row, and the
 * `7 items · sorted by artifact ↑` foot.
 *
 * ### What this replaces
 *
 * Eight hand-built `<th>`s driving a `CatalogSortTh` of the screen's own over
 * `dashboardScreenClasses` — `border-gray-200`, `text-indigo-600`, `hover:bg-gray-100`, a
 * `focus-visible:ring-indigo-500` on every header and four more inline badge palettes in the
 * cells. It is {@link DataTable} now, which brings the sticky caps header, `aria-sort`, the
 * per-column skeleton, the roving Tab stop, the row shortcuts, selection and the sticky bulk
 * bar; the columns below are what is actually specific to the catalog.
 *
 * ### Three things the cells decide
 *
 * 1. **Quality and Grade open the same two dialogs the card's orbs do.** Both are buttons only
 *    when there is something behind them; an unscored cell is a quiet dash with the reason in
 *    its title, not a disabled control.
 * 2. **A deleted row does not open.** `onRowActivate` is declared for every row because
 *    `DataTable` uses its presence to decide the pointer, and refused here for the deleted
 *    ones — with `.cat-row--deleted` putting the arrow cursor back, so the row does not offer
 *    a click it will not honour.
 * 3. **The three provenance columns each answer for themselves.** The card states "Format
 *    pending" once for an item that has none of the three; a table cannot, because its columns
 *    are independent — so each prints its own dash.
 *
 * @see `./catalogModel.ts` — the facets, the scores, the row verbs and the sort bridging.
 */

import * as React from 'react';
import Link from 'next/link';
import { Undo2 } from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellPrimary,
  DataTableCellSub,
  DataTableFoot,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { GradeChip } from '@/app/components/ui/catalog/GradeChip';
import { ProtocolPill } from '@/app/components/ui/catalog/ProtocolPill';
import { SourceBadge } from '@/app/components/ui/catalog/SourceBadge';

import { ConvertedBadge } from './CatalogBadges';
import { CatalogRowMenu, type CatalogItemHandlers } from './CatalogCard';
import {
  CATALOG_LIFECYCLE_LABEL,
  catalogFootLabel,
  catalogItemHref,
  catalogItemSource,
  catalogLifecycle,
  catalogScores,
  isCatalogItemOpenable,
  type CatalogItem,
  type CatalogQualityHistoryMap,
} from './catalogModel';

/**
 * The absolute stamp the Updated column prints.
 *
 * `MM/DD/YY hh:mm AM` — the format the screen this replaces used, kept because a catalog is
 * scanned for *when* rather than for *how long ago*, and because the card beside it already
 * carries the relative phrasing.
 *
 * @param iso The timestamp.
 * @returns The formatted stamp, or the raw string if it will not parse.
 */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  })} ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`;
}

export interface CatalogTableProps extends CatalogItemHandlers {
  /** The rows to draw, already searched, filtered and sorted. */
  items: readonly CatalogItem[];
  /** Every item's browser-local quality snapshots. */
  historyById: CatalogQualityHistoryMap;
  /** True while the first read is in flight. */
  loading?: boolean;
  /** Why the list could not be read. Replaces the body with a retry. */
  error?: string | null;
  /** Retry the read. */
  onRetry?: () => void;
  /** The current sort, shared with the toolbar's sort menu. */
  sort: DataTableSortState | null;
  /** Change the sort — from a column header or from that menu. */
  onSortChange: (next: DataTableSortState | null) => void;
  /** The selected row ids. */
  selectedIds: readonly string[];
  /** Change the selection. */
  onSelectionChange: (next: string[]) => void;
  /** The bulk bar's buttons, composed by the screen. */
  bulkActions?: React.ReactNode;
  /** Open the quality dialog — the server lint report, or the local history. */
  onOpenQuality: (item: CatalogItem) => void;
  /** True while a write is in flight — every verb goes inert. */
  busy?: boolean;
  /** The toolbar the screen composes; passed through to {@link DataTable}. */
  toolbar?: React.ReactNode;
  /** What to draw when nothing matched. */
  empty?: React.ReactNode;
}

/**
 * Render the catalog table. See {@link CatalogTableProps}.
 *
 * @returns The table card, its toolbar, its foot and its bulk bar.
 */
export default function CatalogTable({
  items,
  historyById,
  loading = false,
  error = null,
  onRetry,
  sort,
  onSortChange,
  selectedIds,
  onSelectionChange,
  bulkActions,
  onOpenQuality,
  onOpenDetail,
  onOpenVersions,
  onOpenLint,
  onExport,
  onConvert,
  onDelete,
  onRestore,
  onPermanentDelete,
  busy = false,
  toolbar,
  empty,
}: CatalogTableProps) {
  const columns = React.useMemo<DataTableColumn<CatalogItem>[]>(
    () => [
      {
        id: 'name',
        header: 'Artifact',
        sortable: true,
        cell: (item) => (
          <div className="cat-identity">
            <Avatar shape="hex" size="sm" name={item.name} id={item.id} />
            <span className="cat-identity__text">
              {isCatalogItemOpenable(item) ? (
                <Link href={catalogItemHref(item)} className="cat-identity__link">
                  <DataTableCellPrimary>{item.name}</DataTableCellPrimary>
                </Link>
              ) : (
                <DataTableCellPrimary>{item.name}</DataTableCellPrimary>
              )}
              <DataTableCellSub className="mono">{item.slug || '—'}</DataTableCellSub>
              {item.conversion ? <ConvertedBadge conversion={item.conversion} /> : null}
            </span>
          </div>
        ),
        skeletonWidth: '11rem',
      },
      {
        id: 'format',
        header: 'Format',
        sortable: true,
        cell: (item) =>
          item.sourceFormat ? <FormatPill format={item.sourceFormat} /> : <CatalogDash />,
        skeletonWidth: '5rem',
      },
      {
        id: 'protocol',
        header: 'Protocol',
        sortable: true,
        cell: (item) =>
          item.protocol ? <ProtocolPill protocol={item.protocol} /> : <CatalogDash />,
        skeletonWidth: '4.5rem',
      },
      {
        id: 'source',
        header: 'Source',
        sortable: true,
        cell: (item) => {
          const source = catalogItemSource(item);
          return source ? <SourceBadge source={source} /> : <CatalogDash />;
        },
        skeletonWidth: '6rem',
      },
      {
        id: 'quality',
        header: 'Quality',
        sortable: true,
        align: 'end',
        cell: (item) => {
          const { quality } = catalogScores(item, historyById[item.id] ?? []);
          if (quality == null) return <CatalogDash title="No quality score captured yet" />;
          return (
            <button
              type="button"
              className="cat-score"
              title="Open quality score"
              data-testid={`catalog-quality-${item.id}`}
              onClick={() => onOpenQuality(item)}
            >
              <span className="cat-score__value mono">{quality}</span>
            </button>
          );
        },
        skeletonWidth: '2.5rem',
      },
      {
        id: 'grade',
        header: 'Grade',
        sortable: true,
        cell: (item) => {
          const { grade } = catalogScores(item, historyById[item.id] ?? []);
          if (!grade) return <GradeChip grade={null} />;
          return (
            <button
              type="button"
              className="cat-score"
              title="Open lint report"
              data-testid={`catalog-grade-${item.id}`}
              onClick={() => onOpenLint(item)}
            >
              <GradeChip grade={grade} />
            </button>
          );
        },
        skeletonWidth: '2rem',
      },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        cell: (item) => {
          const lifecycle = catalogLifecycle(item);
          return (
            <span className="cat-status">
              <Badge status={lifecycle} dot>
                {CATALOG_LIFECYCLE_LABEL[lifecycle]}
              </Badge>
              {/* A deleted item remembers whether it was enabled, and undelete restores it —
                  so the second pill is what the row will go back to, not a second state it is
                  in now. Only drawn when the two differ. */}
              {lifecycle === 'deleted' && !item.enabled ? (
                <Badge variant="outline">Was disabled</Badge>
              ) : null}
            </span>
          );
        },
        skeletonWidth: '4.5rem',
      },
      {
        id: 'updated',
        header: 'Updated',
        sortable: true,
        cell: (item) => <span className="cat-stamp">{formatStamp(item.updated_at)}</span>,
        skeletonWidth: '6.5rem',
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        cell: (item) => (
          <>
            {isCatalogItemOpenable(item) ? null : (
              <Button
                variant="ghost"
                size="sm"
                className="cat-restore px-1.5"
                disabled={busy}
                title="Undelete catalog item"
                aria-label={`Undelete ${item.name}`}
                data-testid={`catalog-restore-${item.id}`}
                onClick={() => onRestore(item)}
              >
                <Undo2 aria-hidden />
              </Button>
            )}
            <CatalogRowMenu
              item={item}
              busy={busy}
              testId={`catalog-menu-${item.id}`}
              onOpenDetail={onOpenDetail}
              onOpenVersions={onOpenVersions}
              onOpenLint={onOpenLint}
              onExport={onExport}
              onConvert={onConvert}
              onDelete={onDelete}
              onRestore={onRestore}
              onPermanentDelete={onPermanentDelete}
            />
          </>
        ),
        skeletonWidth: '4rem',
      },
    ],
    [
      busy,
      historyById,
      onConvert,
      onDelete,
      onExport,
      onOpenDetail,
      onOpenLint,
      onOpenQuality,
      onOpenVersions,
      onPermanentDelete,
      onRestore,
    ]
  );

  return (
    <DataTable
      columns={columns}
      rows={items}
      getRowId={(item) => item.id}
      getRowLabel={(item) => item.name}
      caption="Catalog items in this workspace"
      scrollX
      loading={loading}
      loadingLabel="Loading catalog…"
      error={error}
      onRetry={onRetry}
      sort={sort}
      onSortChange={onSortChange}
      selectedIds={selectedIds}
      onSelectionChange={onSelectionChange}
      bulkActions={bulkActions}
      bulkNoun="catalog item"
      onRowActivate={(item) => {
        if (!isCatalogItemOpenable(item)) return;
        onOpenDetail(item);
      }}
      rowClassName={(item) => (isCatalogItemOpenable(item) ? undefined : 'cat-row--deleted')}
      toolbar={toolbar}
      empty={empty}
      data-testid="catalog-table"
      footer={
        <DataTableFoot>
          <span data-testid="catalog-table-foot">{catalogFootLabel(items.length, sort)}</span>
        </DataTableFoot>
      }
    />
  );
}

/** The quiet em dash a provenance or score cell prints when it has nothing to show. */
function CatalogDash({ title }: { title?: string }) {
  return (
    <span className="cat-quiet" title={title}>
      —
    </span>
  );
}

/** Re-exported so the Updated column's format can be asserted without mounting the table. */
export { formatStamp as catalogTableStamp };
