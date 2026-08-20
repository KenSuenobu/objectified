'use client';

/**
 * The sunset schedule table (HIVE-8.2, #5328).
 *
 * Authority: `docs/mockups/ship/sunset-timeline.html` §Table and its **Notes → Keeps (1:1)**
 * list — *Project · Version line · Sunset · Timeline · Lifecycle · Successor · Notes / #507*,
 * with no sorting, no paging and no column filters.
 *
 * ### What changed, and what deliberately did not
 *
 * The seven columns, their order, their contents and their wording are exactly what the
 * screen this replaces printed. What changed is everything around them: it was seven
 * hand-written `<th>`s over `dashboardScreenClasses` inside a `<tbody>` whose Timeline badge
 * chose between three pairs of Tailwind palette strings (`bg-amber-100 text-amber-900
 * dark:bg-amber-900/40 …`), so the status colours followed one light palette and one dark one
 * rather than the reader's theme. It is {@link DataTable} now — the card, the sticky caps
 * header, the skeleton shaped like the content, the roving Tab stop and the in-card empty and
 * error states all come with it — and the badge resolves its tone from the shared vocabulary.
 *
 * ### The one thing it adds
 *
 * A row can be *pointed at* by the drawing above it. When a marker is activated the matching
 * row is marked current and scrolled into view, which is how a reader checks that the
 * timeline and the table agree about a revision.
 *
 * @see `./sunsetModel.ts` — the rules these cells draw.
 */

import * as React from 'react';
import { ArrowUpRight, Package } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import {
  DataTable,
  DataTableCellPrimary,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { MIGRATION_GUIDE_ISSUE_URL } from '@/app/utils/revision-deprecation';

import {
  SUNSET_LOADING_LABEL,
  SUNSET_LOAD_ERROR,
  sunsetInstant,
  sunsetLifecycleLabel,
  sunsetNote,
  sunsetProjectName,
  sunsetTimelineStatus,
  type SunsetEntry,
} from './sunsetModel';

/** The dash a cell prints when the API has nothing for it. */
const ABSENT = '—';

/**
 * Whether motion should be suppressed right now.
 *
 * The stored preference *or* the operating system's, which is exactly what `globals.css`
 * keys its own `prefers-reduced-motion` rules off — read from the DOM rather than from
 * `usePreferences`, so this component works wherever it is mounted.
 *
 * @returns `true` when the reader has asked for less motion.
 */
function prefersReducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.dataset.motion === 'reduce') return true;
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface SunsetTableProps {
  /** The rows to draw, already narrowed by the project filter. */
  entries: readonly SunsetEntry[];
  /** True until the first read has landed. */
  loading?: boolean;
  /** What went wrong with the read, or `null`. */
  error?: string | null;
  /** Read the schedule again. */
  onRetry?: () => void;
  /** The revision a timeline marker last selected. Its row is marked and scrolled to. */
  selectedRevisionId?: string | null;
  /** The toolbar strip, already wrapped in `DataTableToolbar` by the caller. */
  toolbar?: React.ReactNode;
  /** The foot strip, already wrapped in `DataTableFoot` by the caller. */
  footer?: React.ReactNode;
  /** What the card shows when there is nothing to schedule. */
  empty?: React.ReactNode;
}

/**
 * Render the schedule table. See {@link SunsetTableProps}.
 *
 * @returns The table card.
 */
export function SunsetTable({
  entries,
  loading,
  error,
  onRetry,
  selectedRevisionId,
  toolbar,
  footer,
  empty,
}: SunsetTableProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);

  // Bring the row a marker points at into view.
  //
  // Two guards, both deliberate. The method is checked rather than assumed, because jsdom
  // implements no scrolling and this must not be the reason a test throws. And the scroll is
  // only *smooth* when nobody has asked for less motion — DESIGN.md §3.4 — which is read off
  // the same two sources the stylesheet honours (`html[data-motion]` and the OS query),
  // rather than through `usePreferences`, so the table needs no provider around it.
  React.useEffect(() => {
    if (!selectedRevisionId) return;
    const row = Array.from(
      hostRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row-id]') ?? []
    ).find((candidate) => candidate.dataset.rowId === selectedRevisionId);
    if (!row || typeof row.scrollIntoView !== 'function') return;
    row.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [selectedRevisionId]);

  const columns = React.useMemo<Array<DataTableColumn<SunsetEntry>>>(
    () => [
      {
        id: 'project',
        header: 'Project',
        cell: (entry) => (
          <div className="stl-project">
            <Package className="stl-project__icon" aria-hidden />
            <DataTableCellPrimary className="stl-project__name">
              {sunsetProjectName(entry)}
            </DataTableCellPrimary>
          </div>
        ),
      },
      {
        id: 'version',
        header: 'Version line',
        className: 'stl-col-version',
        cell: (entry) => <span className="mono stl-version">{entry.versionLine}</span>,
      },
      {
        id: 'sunset',
        header: 'Sunset',
        className: 'stl-col-sunset',
        // The stored instant rather than a formatted one: this column is the reader's check
        // against the API. The *spoken* form is on the marker (`sunsetMarkerLabel`).
        cell: (entry) => {
          const instant = sunsetInstant(entry);
          return instant ? (
            <span className="stl-instant">{instant}</span>
          ) : (
            <span className="stl-absent">{ABSENT}</span>
          );
        },
      },
      {
        id: 'timeline',
        header: 'Timeline',
        cell: (entry) => (
          <Badge
            status={sunsetTimelineStatus(entry.timelineStatus)}
            dot
            data-testid={`sunset-status-${entry.revisionId}`}
          >
            {sunsetTimelineStatus(entry.timelineStatus)}
          </Badge>
        ),
      },
      {
        id: 'lifecycle',
        header: 'Lifecycle',
        className: 'stl-col-lifecycle',
        cell: (entry) => (
          <span className="stl-lifecycle">{sunsetLifecycleLabel(entry.lifecyclePhase)}</span>
        ),
      },
      {
        id: 'successor',
        header: 'Successor',
        className: 'stl-col-successor',
        cell: (entry) =>
          entry.successorRevisionId ? (
            <span className="mono stl-successor">{entry.successorRevisionId}</span>
          ) : (
            <span className="stl-absent">{ABSENT}</span>
          ),
      },
      {
        id: 'notes',
        header: 'Notes / #507',
        className: 'stl-col-notes',
        cell: (entry) => {
          const note = sunsetNote(entry);
          return (
            <div className="stl-note">
              {note ? <p className="stl-note__text">{note}</p> : <span className="stl-absent">{ABSENT}</span>}
              {/* "Opens in a new tab" is on the `aria-label`, not in an `sr-only` span.
                  `.sr-only` is `position: absolute`, and an absolutely positioned box inside
                  a `<td>` is laid out against the *page*, not against the table's own scroll
                  container — so it escapes the card and drives the document's scroll width
                  at narrow widths. HIVE-7.3 recorded the same finding; `e2e/hive-sunset-
                  timeline.spec.ts` measures it at 420px. The visible text is a prefix of the
                  label, which is what WCAG 2.5.3 asks for. */}
              <a
                className="stl-note__link"
                href={entry.deprecationWarnings?.[0]?.migrationGuideUrl ?? MIGRATION_GUIDE_ISSUE_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Migration guide (opens in a new tab)"
              >
                Migration guide
                <ArrowUpRight aria-hidden />
              </a>
            </div>
          );
        },
      },
    ],
    []
  );

  return (
    // `min-inline-size: 0` on this host is load-bearing, not decoration: a `scrollX` table
    // carries a `min-width`, and a flex item's automatic minimum size is its content — so
    // without it the card cannot shrink and the *document* scrolls sideways instead of the
    // card. `e2e/hive-sunset-timeline.spec.ts` measures exactly that at 420px.
    <div ref={hostRef} className="stl-table-host">
      <DataTable<SunsetEntry>
        className="stl-table"
        caption="Deprecated revisions and their sunset dates"
        columns={columns}
        rows={entries}
        getRowId={(entry) => entry.revisionId}
        getRowLabel={(entry) => `${sunsetProjectName(entry)} ${entry.versionLine}`}
        rowClassName={(entry) =>
          entry.revisionId === selectedRevisionId ? 'stl-row--current' : undefined
        }
        scrollX
        loading={loading}
        loadingLabel={SUNSET_LOADING_LABEL}
        skeletonRows={4}
        error={error}
        errorTitle={SUNSET_LOAD_ERROR}
        onRetry={onRetry}
        empty={empty}
        toolbar={toolbar}
        footer={footer}
        data-testid="sunset-table"
      />
    </div>
  );
}
