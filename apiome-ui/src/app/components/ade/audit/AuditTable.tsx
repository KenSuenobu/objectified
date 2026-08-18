'use client';

import * as React from 'react';
import { ChevronRight, KeySquare, ScrollText, Shield, ShieldHalf, Users } from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellSub,
  DataTableFilterChip,
  DataTableFoot,
  DataTablePager,
  DataTableSearch,
  DataTableToolbar,
  DataTableToolbarSpacer,
  dataTableRangeLabel,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';

import {
  AUDIT_FILTERS,
  AUDIT_FILTER_LABELS,
  AUDIT_PAGE_SIZE,
  AUDIT_RANGES,
  AUDIT_RANGE_LABELS,
  auditActorLabel,
  auditBadgeTone,
  auditDetailEntries,
  auditFilterCounts,
  auditPage,
  auditPageCount,
  formatAuditTimestamp,
  matchesAuditFilter,
  NO_VALUE,
  searchAuditEvents,
  sortAuditEvents,
  type AuditEvent,
  type AuditFilter,
  type AuditRange,
} from './auditModel';

/**
 * The access ledger — HIVE-5.5 (#5308).
 *
 * Authority: `docs/mockups/workspace/audit.html`, the `.table-wrap` section, and DESIGN.md §8.
 *
 * ### What changed from the screen this replaces
 *
 * The old table was five hand-built columns with six inline `bg-<hue>-100 text-<hue>-700`
 * badge classes, a centred spinner for the wait, and a table that ended where the rows did:
 * no search, no date range, no paging, no way to open an entry. It is now {@link DataTable},
 * which brings the sticky header, sortable columns, the skeleton, the in-card empty state and
 * the row-hover action; the badge tones come from the shared status vocabulary, so an event
 * family is the same colour here as it is anywhere else, in all nine themes.
 *
 * ### Rows open rather than navigate
 *
 * A row is clickable and its trailing chevron is the same action, because the ledger's whole
 * problem was that an entry's substance — who, on what, from where, and with what `detail` —
 * was either abbreviated into the Target cell or nowhere at all. `AuditEventDrawer` shows it
 * beside the list, which is what keeps the reader's filters, their page and their place
 * (DESIGN.md §5.4).
 *
 * ### Two departures from the mockup
 *
 * 1. The mockup's date range offers `Custom range…`. There is no custom range here: the
 *    endpoint takes a single `since`, so an end date would be a control that narrows nothing.
 *    The five bounded choices it does offer are all real.
 * 2. The mockup's Source cell is a plain outline badge and stays one. It is *not* tinted by
 *    origin, because a second colour axis in a row that already carries a family-toned event
 *    badge reads as a second status rather than as provenance.
 */

/** Props for {@link AuditTable}. */
export interface AuditTableProps {
  /**
   * Every entry read, newest first — the ledger as the response ordered it.
   *
   * The whole response rather than a page: the chip counts and the foot's total are facts
   * about the read, not about what is currently on screen.
   */
  events: readonly AuditEvent[];
  /** True while the read is in flight. */
  loading?: boolean;
  /** The chosen category. */
  filter: AuditFilter;
  /** Choose a category. */
  onFilterChange: (filter: AuditFilter) => void;
  /** The chosen date range. */
  range: AuditRange;
  /** Choose a date range. This re-reads the ledger — the bound is a server parameter. */
  onRangeChange: (range: AuditRange) => void;
  /** The search box's contents. */
  query: string;
  /** The search box changed. */
  onQueryChange: (query: string) => void;
  /** Open one entry's drawer. */
  onOpenEvent: (event: AuditEvent) => void;
  /** A sentence about the read itself, shown in the foot when the read was capped. */
  readNote?: string;
}

/** The glyph on each category chip, matching the mockup's `data-lucide` names. */
const FILTER_ICONS: Readonly<
  Record<AuditFilter, React.ComponentType<{ className?: string }> | null>
> = {
  all: null,
  role: Shield,
  permission: KeySquare,
  member: Users,
  admin: ShieldHalf,
  styleGuide: ScrollText,
};

/**
 * The Target cell: what the event was about, over what its `detail` recorded.
 *
 * The screen this replaces rendered `target || detail`, which puts a JSONB object straight
 * into JSX — React throws on that the moment an entry has an empty target, which is exactly
 * what `permission.denied` writes when the denial carries no subject. The detail is flattened
 * to a line here, and the drawer shows it in full.
 *
 * @param props.event The row.
 * @returns The cell.
 */
function TargetCell({ event }: { event: AuditEvent }) {
  const sub = auditDetailEntries(event.detail)
    .slice(0, 2)
    .map((entry) => `${entry.key}: ${entry.value}`)
    .join(' · ');
  return (
    <div className="aud-target">
      <span className="aud-target__main">{event.target || NO_VALUE}</span>
      {sub ? <DataTableCellSub className="aud-target__sub">{sub}</DataTableCellSub> : null}
    </div>
  );
}

/**
 * The ledger table, its toolbar, its pager and its states.
 *
 * @param props See {@link AuditTableProps}.
 * @returns The table card.
 */
export default function AuditTable({
  events,
  loading = false,
  filter,
  onFilterChange,
  range,
  onRangeChange,
  query,
  onQueryChange,
  onOpenEvent,
  readNote,
}: AuditTableProps) {
  const [sort, setSort] = React.useState<DataTableSortState | null>(null);
  const [page, setPage] = React.useState(1);

  // Narrowing, in the order the toolbar reads it: the search box first, so the chip counts
  // beside it say what a chip would leave rather than what the whole ledger holds.
  const searched = React.useMemo(() => searchAuditEvents(events, query), [events, query]);
  const counts = React.useMemo(() => auditFilterCounts(searched), [searched]);
  const matching = React.useMemo(
    () => sortAuditEvents(searched.filter((event) => matchesAuditFilter(event, filter)), sort),
    [searched, filter, sort]
  );

  const pageCount = auditPageCount(matching.length);
  // A narrowing that shortens the list must not leave the reader on a page that no longer
  // exists. `auditPage` clamps what it returns; this keeps the pager and the foot's sentence
  // agreeing with it.
  const currentPage = Math.min(page, pageCount);
  const visible = React.useMemo(() => auditPage(matching, currentPage), [matching, currentPage]);

  React.useEffect(() => {
    setPage(1);
  }, [filter, range, query]);

  const narrowed = query.trim().length > 0 || filter !== 'all';

  const columns = React.useMemo<DataTableColumn<AuditEvent>[]>(
    () => [
      {
        id: 'when',
        header: 'When',
        sortable: true,
        cell: (event) => (
          <span className="aud-when mono">{formatAuditTimestamp(event.created_at)}</span>
        ),
        skeletonWidth: '9.5rem',
      },
      {
        id: 'actor',
        header: 'Actor',
        sortable: true,
        cell: (event) => {
          const label = auditActorLabel(event);
          return (
            <span className="aud-actor">
              <Avatar name={label} seed={event.actor_id ?? label} size="xs" aria-hidden />
              <span className="aud-actor__label mono">{label}</span>
            </span>
          );
        },
        skeletonWidth: '8.75rem',
      },
      {
        id: 'event',
        header: 'Event',
        sortable: true,
        cell: (event) => (
          <Badge variant={auditBadgeTone(event.action)} mono data-audit-action={event.action}>
            {event.action}
          </Badge>
        ),
        skeletonWidth: '7rem',
      },
      {
        id: 'target',
        header: 'Target',
        sortable: true,
        cell: (event) => <TargetCell event={event} />,
        skeletonWidth: '13.75rem',
      },
      {
        id: 'source',
        header: 'Source',
        sortable: true,
        cell: (event) =>
          event.source ? (
            <Badge variant="outline">{event.source}</Badge>
          ) : (
            <span className="aud-when">{NO_VALUE}</span>
          ),
        skeletonWidth: '2.5rem',
      },
      {
        id: 'actions',
        headerLabel: 'Details',
        actions: true,
        cell: (event) => (
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            aria-label={`Open ${event.action} of ${formatAuditTimestamp(event.created_at)}`}
            data-testid={`audit-open-${event.id}`}
            onClick={() => onOpenEvent(event)}
          >
            <ChevronRight aria-hidden />
          </Button>
        ),
        skeletonWidth: '1.5rem',
      },
    ],
    [onOpenEvent]
  );

  return (
    <DataTable
      columns={columns}
      rows={visible}
      getRowId={(event) => event.id}
      getRowLabel={(event) => `${event.action} · ${formatAuditTimestamp(event.created_at)}`}
      caption="Access and permission events for this workspace"
      scrollX
      loading={loading}
      loadingLabel="Loading the access ledger…"
      sort={sort}
      onSortChange={setSort}
      onRowActivate={onOpenEvent}
      data-testid="audit-table"
      toolbar={
        <DataTableToolbar>
          <DataTableSearch
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search actor, event, target…"
            aria-label="Search audit events"
            data-testid="audit-search"
          />
          {AUDIT_FILTERS.map((entry) => {
            const Icon = FILTER_ICONS[entry];
            return (
              <DataTableFilterChip
                key={entry}
                active={filter === entry}
                count={counts[entry]}
                data-testid={`audit-filter-${entry}`}
                onClick={() => onFilterChange(entry)}
              >
                {Icon ? <Icon className="aud-chip-glyph" aria-hidden /> : null}
                {AUDIT_FILTER_LABELS[entry]}
              </DataTableFilterChip>
            );
          })}
          <DataTableToolbarSpacer />
          <select
            className="hive-control aud-range"
            aria-label="Date range"
            data-testid="audit-range"
            value={range}
            onChange={(event) => onRangeChange(event.target.value as AuditRange)}
          >
            {AUDIT_RANGES.map((entry) => (
              <option key={entry} value={entry}>
                {AUDIT_RANGE_LABELS[entry]}
              </option>
            ))}
          </select>
        </DataTableToolbar>
      }
      empty={
        narrowed ? (
          <EmptyState
            variant="compact"
            icon={<ScrollText aria-hidden />}
            title="No audit events match these filters"
            description="Clear the search box, choose “All events”, or widen the date range."
            action={
              <Button
                variant="outline"
                size="sm"
                data-testid="audit-clear-filters"
                onClick={() => {
                  onQueryChange('');
                  onFilterChange('all');
                }}
              >
                Show all events
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<ScrollText aria-hidden />}
            title="No audit events for this filter."
            description="Role, permission and membership changes land here the moment they happen. Try a wider date range."
            action={
              <Button
                variant="outline"
                data-testid="audit-widen-range"
                onClick={() => onRangeChange('all')}
              >
                Search all time
              </Button>
            }
          />
        )
      }
      footer={
        <DataTableFoot>
          <span className="aud-foot-count" data-testid="audit-count">
            {dataTableRangeLabel(currentPage, AUDIT_PAGE_SIZE, matching.length, 'event')}
            {matching.length > 0 ? ' · newest first' : ''}
            {readNote ? ` · ${readNote}` : ''}
          </span>
          <DataTablePager
            page={currentPage}
            pageCount={pageCount}
            onPageChange={setPage}
            label="Audit pages"
          />
        </DataTableFoot>
      }
    />
  );
}
