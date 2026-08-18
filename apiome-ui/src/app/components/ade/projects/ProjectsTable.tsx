'use client';

/**
 * The projects list, as a table (HIVE-6.1, #5312).
 *
 * Authority: `docs/mockups/build/projects.html` §Table view — `Project · Description ·
 * Quality trend · Versions · Status · Created by · Updated · actions`, row selection, and the
 * `4 projects · sorted by name ↑` foot.
 *
 * ### What this replaces
 *
 * Eight hand-built `<th>`s driving a `ProjectsSortTh` of the screen's own, over
 * `dashboardScreenClasses` — `border-gray-200`, `text-indigo-600`, `hover:bg-gray-100`, a
 * `focus-visible:ring-indigo-500` per header and three more inline badge palettes in the
 * cells. It is {@link DataTable} now, which brings the sticky caps header, `aria-sort`, the
 * skeleton, the roving Tab stop, the row shortcuts, selection and the sticky bulk bar; the
 * columns below are what is actually specific to projects.
 *
 * ### Two things the cells decide
 *
 * 1. **The trend cell is the sparkline *and* the number.** A shape with no figure cannot be
 *    read off a screen, and a figure with no shape hides the direction — which on this screen
 *    is the whole point of the column. Both come from `projectScores`, so the cell and the
 *    card can never disagree about a project.
 * 2. **A deleted row does not open.** `onRowActivate` is declared for every row because
 *    `DataTable` uses its presence to decide the pointer, and refused here for the deleted
 *    ones — with `.prj-row--deleted` putting the arrow cursor back, so the row does not offer
 *    a click it will not honour.
 *
 * @see `./projectsModel.ts` — the facets, the scores and the sort bridging.
 */

import * as React from 'react';
import Link from 'next/link';
import { Ellipsis, Pencil, Trash2, TrendingUp, Undo2 } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

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
import { Sparkline, ringTier } from '@/app/components/ui/metrics';
import { cn } from '@lib/utils';
import type { ProjectQualitySnapshot } from '@/app/utils/project-quality-score-history';

import {
  PROJECT_LIFECYCLE_LABEL,
  isProjectOpenable,
  projectDomainLabel,
  projectLifecycle,
  projectScores,
  projectsFootLabel,
  projectVersionsHref,
  type Project,
  type ProjectQualityHistoryMap,
} from './projectsModel';

/** The row-menu item class, shared with the tenants table and the project card. */
const MENU_ITEM_CLASS = 'tnt-menu__item';

/**
 * The absolute stamp the Updated column prints.
 *
 * `MM/DD/YY hh:mm AM` — the format the screen this replaces used, kept because a portfolio is
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

export interface ProjectsTableProps {
  /** The rows to draw, already searched, filtered and sorted. */
  projects: readonly Project[];
  /** Every project's browser-local quality snapshots. */
  historyById: ProjectQualityHistoryMap;
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
  /** Open a project's versions. */
  onOpen: (project: Project) => void;
  /** Open the scores dialog on its Trend tab. */
  onOpenTrend: (project: Project) => void;
  /** Open the edit dialog. */
  onEdit: (project: Project) => void;
  /** Soft-delete it. */
  onDelete: (project: Project) => void;
  /** Restore a soft-deleted project. */
  onRestore: (project: Project) => void;
  /** Destroy it, after the type-to-confirm gate. */
  onPermanentDelete: (project: Project) => void;
  /** True while a write is in flight — every verb goes inert. */
  busy?: boolean;
  /** The toolbar the screen composes; passed through to {@link DataTable}. */
  toolbar?: React.ReactNode;
  /** What to draw when nothing matched. */
  empty?: React.ReactNode;
}

/**
 * Render the projects table. See {@link ProjectsTableProps}.
 *
 * @returns The table card, its toolbar, its foot and its bulk bar.
 */
export default function ProjectsTable({
  projects,
  historyById,
  loading = false,
  error = null,
  onRetry,
  sort,
  onSortChange,
  selectedIds,
  onSelectionChange,
  bulkActions,
  onOpen,
  onOpenTrend,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
  busy = false,
  toolbar,
  empty,
}: ProjectsTableProps) {
  const columns = React.useMemo<DataTableColumn<Project>[]>(
    () => [
      {
        id: 'name',
        header: 'Project',
        sortable: true,
        cell: (project) => {
          const domain = projectDomainLabel(project);
          return (
            <div className="prj-identity">
              <Avatar shape="hex" size="sm" name={project.name} id={project.id} />
              <span className="prj-identity__text">
                <span className="prj-identity__line">
                  {isProjectOpenable(project) ? (
                    <Link href={projectVersionsHref(project)} className="prj-identity__link">
                      <DataTableCellPrimary>{project.name}</DataTableCellPrimary>
                    </Link>
                  ) : (
                    <DataTableCellPrimary>{project.name}</DataTableCellPrimary>
                  )}
                  {domain ? <Badge variant="violet">{domain}</Badge> : null}
                </span>
                <DataTableCellSub className="mono">{project.slug || '—'}</DataTableCellSub>
              </span>
            </div>
          );
        },
        skeletonWidth: '12rem',
      },
      {
        id: 'description',
        header: 'Description',
        sortable: true,
        cell: (project) =>
          project.description?.trim() ? (
            <div className="prj-desc" title={project.description}>
              {project.description}
            </div>
          ) : (
            <span className="prj-quiet">No description</span>
          ),
        skeletonWidth: '16rem',
      },
      {
        id: 'quality',
        header: (
          <>
            <TrendingUp className="prj-col-glyph" aria-hidden />
            Quality trend
          </>
        ),
        headerLabel: 'Quality trend',
        sortable: true,
        cell: (project) => (
          <QualityTrendCell
            project={project}
            history={historyById[project.id] ?? []}
            onOpenTrend={onOpenTrend}
          />
        ),
        skeletonWidth: '7rem',
      },
      {
        id: 'versions',
        header: 'Versions',
        sortable: true,
        align: 'end',
        cell: (project) => (
          <span className="prj-num mono" data-testid="projects-table-versions-count">
            {project.versionsCount ?? 0}
          </span>
        ),
        skeletonWidth: '2.5rem',
      },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        cell: (project) => {
          const lifecycle = projectLifecycle(project);
          return (
            <span className="prj-status">
              <Badge status={lifecycle} dot>
                {PROJECT_LIFECYCLE_LABEL[lifecycle]}
              </Badge>
              {/* A deleted project remembers whether it was enabled, and undelete restores
                  it — so the second pill is what the row will go back to, not a second
                  state it is in now. Only drawn when the two differ. */}
              {lifecycle === 'deleted' && !project.enabled ? (
                <Badge variant="outline">Was disabled</Badge>
              ) : null}
            </span>
          );
        },
        skeletonWidth: '4.5rem',
      },
      {
        id: 'creator',
        header: 'Created by',
        sortable: true,
        cell: (project) => (
          <span className="prj-creator">
            <DataTableCellPrimary>{project.creator_name}</DataTableCellPrimary>
            <DataTableCellSub>{project.creator_email}</DataTableCellSub>
          </span>
        ),
        skeletonWidth: '9rem',
      },
      {
        id: 'updated',
        header: 'Updated',
        sortable: true,
        cell: (project) => <span className="prj-stamp">{formatStamp(project.updated_at)}</span>,
        skeletonWidth: '6.5rem',
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        cell: (project) => {
          const deleted = !isProjectOpenable(project);
          return (
            <>
              {deleted ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="prj-restore px-1.5"
                  disabled={busy}
                  title="Undelete project"
                  aria-label={`Undelete ${project.name}`}
                  data-testid={`projects-restore-${project.id}`}
                  onClick={() => onRestore(project)}
                >
                  <Undo2 aria-hidden />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-1.5"
                  disabled={busy}
                  title="Edit"
                  aria-label={`Edit ${project.name}`}
                  data-testid={`projects-edit-${project.id}`}
                  onClick={() => onEdit(project)}
                >
                  <Pencil aria-hidden />
                </Button>
              )}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-1.5"
                    disabled={busy}
                    aria-label={`Actions for ${project.name}`}
                    data-testid={`projects-menu-${project.id}`}
                  >
                    <Ellipsis aria-hidden />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="tnt-menu" sideOffset={4} align="end">
                    {deleted ? (
                      <DropdownMenu.Item
                        className={MENU_ITEM_CLASS}
                        onSelect={() => onRestore(project)}
                      >
                        <Undo2 aria-hidden />
                        Undelete project
                      </DropdownMenu.Item>
                    ) : (
                      <>
                        <DropdownMenu.Item
                          className={MENU_ITEM_CLASS}
                          onSelect={() => onOpen(project)}
                        >
                          <TrendingUp aria-hidden />
                          Open versions
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className={MENU_ITEM_CLASS}
                          onSelect={() => onEdit(project)}
                        >
                          <Pencil aria-hidden />
                          Edit project
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className={cn(MENU_ITEM_CLASS, 'prj-menu__item--danger')}
                          onSelect={() => onDelete(project)}
                        >
                          <Trash2 aria-hidden />
                          Delete project
                        </DropdownMenu.Item>
                      </>
                    )}
                    <DropdownMenu.Separator className="tnt-menu__sep" />
                    <DropdownMenu.Item
                      className={cn(MENU_ITEM_CLASS, 'prj-menu__item--danger')}
                      onSelect={() => onPermanentDelete(project)}
                    >
                      <Trash2 aria-hidden />
                      Permanently delete
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          );
        },
        skeletonWidth: '4rem',
      },
    ],
    [busy, historyById, onDelete, onEdit, onOpen, onOpenTrend, onPermanentDelete, onRestore]
  );

  return (
    <DataTable
      columns={columns}
      rows={projects}
      getRowId={(project) => project.id}
      getRowLabel={(project) => project.name}
      caption="Projects in this workspace"
      scrollX
      loading={loading}
      loadingLabel="Loading projects…"
      error={error}
      onRetry={onRetry}
      sort={sort}
      onSortChange={onSortChange}
      selectedIds={selectedIds}
      onSelectionChange={onSelectionChange}
      bulkActions={bulkActions}
      bulkNoun="project"
      onRowActivate={(project) => {
        if (!isProjectOpenable(project)) return;
        onOpen(project);
      }}
      rowClassName={(project) => (isProjectOpenable(project) ? undefined : 'prj-row--deleted')}
      toolbar={toolbar}
      empty={empty}
      data-testid="projects-table"
      footer={
        <DataTableFoot>
          <span data-testid="projects-table-foot">
            {projectsFootLabel(projects.length, sort)}
          </span>
        </DataTableFoot>
      }
    />
  );
}

/** Props for {@link QualityTrendCell}. */
interface QualityTrendCellProps {
  /** The row. */
  project: Project;
  /** Its browser-local snapshots, oldest first. */
  history: readonly ProjectQualitySnapshot[];
  /** Open the scores dialog on its Trend tab. */
  onOpenTrend: (project: Project) => void;
}

/**
 * The Quality trend cell: the shape, the figure and the letter.
 *
 * Three states, and each one says something different:
 *
 * - **no versions** — "Empty project". There is nothing to score, and a dash here would read
 *   as "scored, and we lost it";
 * - **a score but no local history** — the figure and its letter alone. The trend is a
 *   browser-local series; an import made from the CLI has a score and no shape, and drawing a
 *   one-point line for it would invent a flat trend that was never measured;
 * - **history** — the sparkline pinned to a 0–100 domain, so two rows' shapes are comparable,
 *   with the figure beside it.
 *
 * @param props See {@link QualityTrendCellProps}.
 * @returns The cell.
 */
function QualityTrendCell({ project, history, onOpenTrend }: QualityTrendCellProps) {
  const scores = projectScores(project, history);

  if (scores.isEmpty) {
    return (
      <span className="prj-quiet" data-testid="projects-table-empty">
        Empty project
      </span>
    );
  }
  if (scores.quality == null) {
    return (
      <span className="prj-quiet" title="No quality score captured yet">
        —
      </span>
    );
  }

  const tone = ringTier(scores.quality).tone;
  const figure = (
    <span className={cn('prj-trend__value', 'mono')}>
      {scores.quality}
      {scores.grade ? <span className="prj-trend__grade"> ({scores.grade})</span> : null}
    </span>
  );

  if (scores.history.length === 0) {
    return (
      <span className="prj-trend" title="Mean quality score across project versions">
        {figure}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="prj-trend prj-trend--action"
      title="Open quality score history"
      data-testid={`projects-trend-${project.id}`}
      onClick={() => onOpenTrend(project)}
    >
      <Sparkline
        data={scores.history.map((snapshot) => snapshot.overall)}
        label={`Quality trend for ${project.name}`}
        tone={tone}
        domainMax={100}
        className="prj-trend__spark"
      />
      {figure}
    </button>
  );
}
