'use client';

/**
 * The revisions table (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Versions table — *Version · Revision /
 * changelog · Status · Mock · Created by · Created · actions*, sortable where the timeline's
 * comparator sorts, with hover row actions beside the overflow menu.
 *
 * ### What this replaces
 *
 * Seven hand-built `<th>`s driving a `VersionsSortTh` of the screen's own over
 * `dashboardScreenClasses`, and a `<tbody>` whose cells named `text-indigo-600`,
 * `bg-blue-100`, `bg-amber-100`, `border-violet-200` and `text-emerald-600` inline. It is
 * {@link DataTable} now, which brings the sticky caps header, `aria-sort`, the skeleton, the
 * roving Tab stop and the row shortcuts; the columns below are what is actually specific to
 * revisions.
 *
 * ### The cells this keeps 1:1
 *
 * The version cell's mono link opens the spec viewer; the lifecycle badge keeps its `#739`
 * tooltip; the Published lock chip, the Locked shield chip, the amber tag chips and the violet
 * fork box are all still here; and `VersionLintBadge` still reads the **stored** score off the
 * row (#5259) — it is the same component, and no lint request is made to draw a list. The
 * mock cell is `VersionMockCell`, unchanged in what it does. Status is the two vocabulary
 * words plus *Disabled*. Created prints the same `MM/DD/YY hh:mm AM` and the green published
 * date.
 *
 * ### The one thing the cells decide
 *
 * Nothing about the rows: which rows, in what order, is the screen's — this draws what it is
 * handed. The only decisions here are presentational — which glyph, which class — and even
 * the row menu's contents come from `versionRowMenuItems`.
 *
 * @see `./versionsModel.ts` — the labels, the stamps and the row-menu rules.
 */

import * as React from 'react';
import { CircleCheck, GitFork, Lock, LockOpen, Pencil, Shield, Sunset } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellPrimary,
  DataTableCellSub,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { VersionLintBadge } from '@/app/components/ade/dashboard/VersionLintBadge';
import { VersionMockCell, type VersionMockChange } from '@/app/components/ade/dashboard/VersionMockCell';
import { mockUsageSeriesKey } from '@/app/utils/mock-usage-series';
import { cn } from '@lib/utils';

import { VersionRowMenu } from './VersionRowMenu';
import {
  VERSION_LIFECYCLE_LABEL,
  VERSION_STATUS_LABEL,
  formatVersionDate,
  formatVersionStamp,
  shortRevisionId,
  versionLabel,
  versionLifecycle,
  versionRowQuickActions,
  versionStatus,
  type GitlikeAffordance,
  type Version,
  type VersionRowMenuAction,
  type VersionRowMenuContext,
  type VersionTagRow,
} from './versionsModel';

export interface VersionsTableProps {
  /** The rows to draw, already filtered and sorted. */
  versions: readonly Version[];
  /** True until the project's first read has landed. */
  loading?: boolean;
  /** The selected project's id — every lint badge and mock cell is scoped to it. */
  projectId: string;
  /** The project's slug, which keys the mock-usage series. */
  projectSlug?: string | null;
  /** The head revision's id, from `projectHeadRevisionId`. */
  headRevisionId: string | null;
  /** Tags by the revision they point at. */
  tagsByVersionId: ReadonlyMap<string, readonly VersionTagRow[]>;
  /** Which revisions already have frozen class schemas. */
  hasClassSchemaMap: Readonly<Record<string, boolean>>;
  /** Whether the viewer is a tenant admin (resolved). */
  effectiveIsAdmin: boolean;
  /** The viewer's user id. */
  currentUserId: string | undefined;
  /** Whether the project has any named branch. */
  hasBranches: boolean;
  /** The revision whose schema freeze is in flight, if any. */
  freezingSchemaVersionId: string | null;
  /** Whether a revision's owning project is publishable (not a catalog item). */
  isVersionPublishable: (version: Version) => boolean;
  /** How git-like affordances are treated in this build. */
  gitlike: GitlikeAffordance;
  /** 30-day mock usage, keyed by `mockUsageSeriesKey(slug, version_id)`; `null` while loading. */
  mockUsageByVersion: ReadonlyMap<string, readonly number[]> | null;
  /** Fold a mock toggle round-trip back into the row. */
  onMockChanged: (versionRecordId: string, change: VersionMockChange) => void;
  /** A row action was chosen — from a hover button or the menu. */
  onRowAction: (action: VersionRowMenuAction, version: Version) => void;
  /** The sort in force. */
  sort: DataTableSortState;
  /** A header was clicked. `null` is the primitive's "unsorted" step. */
  onSortChange: (next: DataTableSortState | null) => void;
  /** The toolbar the screen composes; passed through to {@link DataTable}. */
  toolbar?: React.ReactNode;
  /** The foot the screen composes. */
  footer?: React.ReactNode;
  /** What to draw when nothing matched. */
  empty?: React.ReactNode;
  /** The table's accessible name. */
  caption?: string;
}

/**
 * Render the revisions table. See {@link VersionsTableProps}.
 *
 * @returns The table card, its toolbar and its foot.
 */
export default function VersionsTable({
  versions,
  loading = false,
  projectId,
  projectSlug,
  headRevisionId,
  tagsByVersionId,
  hasClassSchemaMap,
  effectiveIsAdmin,
  currentUserId,
  hasBranches,
  freezingSchemaVersionId,
  isVersionPublishable,
  gitlike,
  mockUsageByVersion,
  onMockChanged,
  onRowAction,
  sort,
  onSortChange,
  toolbar,
  footer,
  empty,
  caption = 'Revisions of this project',
}: VersionsTableProps) {
  /** The menu context for one row — everything but the revision. */
  const contextFor = React.useCallback(
    (version: Version): VersionRowMenuContext => ({
      headRevisionId,
      effectiveIsAdmin,
      currentUserId,
      hasBranches,
      schemaFrozen: Boolean(hasClassSchemaMap[version.id]),
      publishable: isVersionPublishable(version),
      freezing: freezingSchemaVersionId === version.id,
      gitlike,
    }),
    [
      currentUserId,
      effectiveIsAdmin,
      freezingSchemaVersionId,
      gitlike,
      hasBranches,
      hasClassSchemaMap,
      headRevisionId,
      isVersionPublishable,
    ]
  );

  const columns = React.useMemo<DataTableColumn<Version>[]>(
    () => [
      {
        id: 'version',
        header: 'Version',
        sortable: true,
        className: 'ver-col-version',
        headerClassName: 'ver-col-version',
        cell: (version) => (
          <VersionCell
            version={version}
            projectId={projectId}
            isHead={headRevisionId !== null && version.id === headRevisionId}
            tags={tagsByVersionId.get(version.id) ?? []}
            onView={() => onRowAction('view', version)}
          />
        ),
        skeletonWidth: '11rem',
      },
      {
        id: 'revision',
        header: 'Revision / changelog',
        sortable: true,
        className: 'ver-col-revision',
        cell: (version) => (
          <div className="ver-note">
            {version.shortMessage ? (
              <DataTableCellPrimary className="ver-note__title" title={version.shortMessage}>
                {version.shortMessage}
              </DataTableCellPrimary>
            ) : (
              <span className="ver-quiet">—</span>
            )}
            {version.changelog ? (
              <DataTableCellSub className="ver-note__sub" title={version.changelog}>
                {version.changelog}
              </DataTableCellSub>
            ) : null}
          </div>
        ),
        skeletonWidth: '14rem',
      },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        className: 'ver-col-status',
        headerClassName: 'ver-col-status',
        cell: (version) => {
          const status = versionStatus(version);
          return (
            <span className="ver-status">
              <Badge status={status} dot data-testid={`versions-status-${version.id}`}>
                {status === 'published' ? <CircleCheck aria-hidden /> : null}
                {VERSION_STATUS_LABEL[status]}
              </Badge>
              {!version.enabled ? (
                <Badge status="disabled" title="enabled = false">
                  Disabled
                </Badge>
              ) : null}
            </span>
          );
        },
        skeletonWidth: '4.5rem',
      },
      {
        id: 'mock',
        header: 'Mock',
        className: 'ver-col-mock',
        headerClassName: 'ver-col-mock',
        cell: (version) => (
          <VersionMockCell
            versionRecordId={version.id}
            projectId={version.project_id}
            versionLabel={version.version_id}
            published={version.published}
            mockEnabled={Boolean(version.mockEnabled)}
            mockPrivate={Boolean(version.mockPrivate)}
            mockBaseUrl={version.mockBaseUrl ?? null}
            usageSeries={
              mockUsageByVersion === null || !projectSlug
                ? undefined
                : (mockUsageByVersion.get(mockUsageSeriesKey(projectSlug, version.version_id)) ?? [])
            }
            onMockChanged={(change) => onMockChanged(version.id, change)}
          />
        ),
        skeletonWidth: '6rem',
      },
      {
        id: 'creator',
        header: 'Created by',
        sortable: true,
        className: 'ver-col-creator',
        headerClassName: 'ver-col-creator',
        cell: (version) => (
          <span className="ver-creator">
            <DataTableCellPrimary>{version.creator_name}</DataTableCellPrimary>
            <DataTableCellSub>{version.creator_email}</DataTableCellSub>
          </span>
        ),
        skeletonWidth: '7rem',
      },
      {
        id: 'created',
        header: 'Created',
        sortable: true,
        className: 'ver-col-created',
        headerClassName: 'ver-col-created',
        cell: (version) => (
          <span className="ver-stamp">
            {formatVersionStamp(version.created_at)}
            {version.published_at ? (
              <span className="ver-stamp__published" data-testid={`versions-published-at-${version.id}`}>
                <CircleCheck aria-hidden />
                Published {formatVersionDate(version.published_at)}
              </span>
            ) : null}
          </span>
        ),
        skeletonWidth: '6.5rem',
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        className: 'ver-col-actions',
        headerClassName: 'ver-col-actions',
        cell: (version) => {
          const context = contextFor(version);
          const quick = versionRowQuickActions(version, context);
          const label = versionLabel(version);
          return (
            <>
              {quick.map((action) => (
                <Button
                  key={action.id}
                  variant="ghost"
                  size="sm"
                  className={cn('px-1.5', action.id === 'publish' && 'ver-row-action--publish')}
                  title={action.label}
                  aria-label={`${action.label} ${label}`}
                  data-testid={`versions-quick-${action.id}-${version.id}`}
                  onClick={() => onRowAction(action.id, version)}
                >
                  {action.id === 'publish' ? (
                    <Lock aria-hidden />
                  ) : action.id === 'unpublish' ? (
                    <LockOpen aria-hidden />
                  ) : action.id === 'scheduleSunset' ? (
                    <Sunset aria-hidden />
                  ) : (
                    <Pencil aria-hidden />
                  )}
                </Button>
              ))}
              <VersionRowMenu version={version} context={context} onAction={onRowAction} />
            </>
          );
        },
        skeletonWidth: '4rem',
      },
    ],
    [
      contextFor,
      headRevisionId,
      mockUsageByVersion,
      onMockChanged,
      onRowAction,
      projectId,
      projectSlug,
      tagsByVersionId,
    ]
  );

  return (
    <DataTable
      className="ver-table"
      columns={columns}
      rows={versions}
      getRowId={(version) => version.id}
      getRowLabel={(version) => versionLabel(version)}
      caption={caption}
      scrollX
      loading={loading}
      loadingLabel="Loading versions..."
      sort={sort}
      onSortChange={onSortChange}
      toolbar={toolbar}
      footer={footer}
      empty={empty}
      data-testid="versions-table"
    />
  );
}

/** Props for {@link VersionCell}. */
interface VersionCellProps {
  version: Version;
  projectId: string;
  isHead: boolean;
  tags: readonly VersionTagRow[];
  onView: () => void;
}

/**
 * The Version cell: the mono link, the chips beside it, and the identifier or fork line.
 *
 * @param props See {@link VersionCellProps}.
 * @returns The cell.
 */
function VersionCell({ version, projectId, isHead, tags, onView }: VersionCellProps) {
  const lifecycle = versionLifecycle(version);
  const label = versionLabel(version);
  return (
    <div className="ver-cell" data-testid={`versions-cell-${version.id}`}>
      <div className="ver-cell__line">
        <button
          type="button"
          className="ver-cell__link mono"
          title="View spec"
          data-testid={`versions-view-${version.id}`}
          onClick={onView}
        >
          {label}
        </button>
        <Badge status={lifecycle} title="Revision lifecycle (#739)">
          {VERSION_LIFECYCLE_LABEL[lifecycle]}
        </Badge>
        {isHead ? (
          <Badge variant="outline" title="The newest revision on this line">
            HEAD
          </Badge>
        ) : null}
        {version.published ? (
          <Badge variant="outline" title="Published — read-only" data-testid={`versions-published-chip-${version.id}`}>
            <Lock aria-hidden />
            Published
          </Badge>
        ) : null}
        {version.revisionLocked ? (
          <Badge variant="outline" title="Revision locked: non-admins cannot delete">
            <Shield aria-hidden />
            Locked
          </Badge>
        ) : null}
        {tags.map((tag) => (
          <span key={tag.id} className="ver-tag mono" title={tag.message || tag.name}>
            {tag.name}
          </span>
        ))}
        {projectId ? (
          <VersionLintBadge
            projectId={projectId}
            versionId={version.id}
            versionLabel={version.version_id}
            storedScore={version.qualityScore}
            storedGrade={version.qualityGrade}
          />
        ) : null}
      </div>
      {version.forkedFromRevisionId ? (
        <div className="ver-fork" title="Forked revision" data-testid={`versions-fork-${version.id}`}>
          <GitFork aria-hidden />
          <span>
            <span className="ver-fork__word">Fork</span>
            {' · '}
            from v{version.forkSourceVersionLabel ?? '?'}
            {version.forkSourceProjectName ? ` (${version.forkSourceProjectName})` : ''}
            {version.upstreamProjectName &&
            version.upstreamProjectName !== version.forkSourceProjectName
              ? ` · Upstream project: ${version.upstreamProjectName}`
              : ''}
          </span>
        </div>
      ) : (
        <DataTableCellSub className="ver-cell__id mono" title={version.id}>
          {shortRevisionId(version.id)}
        </DataTableCellSub>
      )}
    </div>
  );
}
