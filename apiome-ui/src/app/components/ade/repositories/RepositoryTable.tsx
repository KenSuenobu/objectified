'use client';

/**
 * The repository list, as a table (HIVE-7.3, #5320).
 *
 * Authority: `docs/mockups/sources/repositories.html` §List view — `Repository · Provider ·
 * Branch · Files · Health · Status · Last scan · Importable · actions`, and the
 * `Showing X of Y repositories` foot.
 *
 * ### What this replaces
 *
 * Nine hand-built `<th>`s over `dashboardScreenClasses` — `border-gray-200`, `text-indigo-600`,
 * `hover:bg-gray-50` — with no `aria-sort` anywhere, no skeleton, and a `Detail →` link
 * duplicating a row that was already clickable. It is {@link DataTable} now, which brings the
 * sticky caps header, the roving Tab stop, the row shortcuts and the per-column skeleton; what
 * is below is only what is specific to a repository.
 *
 * ### The row opens the repository; the menu does the rest
 *
 * `onRowActivate` makes the whole row the link the mockup's `is-clickable` implies, so the
 * inline `Detail →` is gone: it was a second control for what the row already did. The three
 * verbs live in the same {@link RepositoryRowMenu} the card draws, which is what stops the two
 * views offering different actions for the same repository.
 *
 * ### No selection column
 *
 * `DataTable` adds one the moment `selectedIds` is passed, and there is deliberately no bulk
 * verb here: removing several repositories at once is not a thing the API supports, and a
 * checkbox column that leads to nothing is a promise the screen cannot keep.
 */

import * as React from 'react';

import { Badge } from '@/app/components/ui/Badge';
import {
  DataTable,
  DataTableCellPrimary,
  DataTableCellSub,
  DataTableFoot,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { Avatar } from '@/app/components/ui/Avatar';
import { Spinner } from '@/app/components/ui/Spinner';
import { RepositoryHealthBadge } from '@/app/components/ade/dashboard/repositories/RepositoryHealthBadge';
import { formatLastScan } from '@/app/components/ade/dashboard/repositories/repositoryStoreUi';

import { ProviderBadge } from './ProviderBadge';
import { RepositoryIndexMark } from './RepositoryIndexMark';
import { RepositoryRowMenu, type RepositoryRowHandlers } from './RepositoryRowMenu';
import {
  REPOSITORY_STATUS_LABEL,
  REPOSITORY_STATUS_TONE,
  repositoryFootLabel,
  type DashboardRepository,
} from './repositoriesModel';

export interface RepositoryTableProps extends RepositoryRowHandlers {
  /** The rows to draw, already searched, filtered and sorted. */
  repositories: readonly DashboardRepository[];
  /** How many are registered in total — the foot's second figure. */
  total: number;
  /** True while the first read is in flight. */
  loading?: boolean;
  /** Why the list could not be read. Replaces the body with a retry. */
  error?: string | null;
  /** Retry the read. */
  onRetry?: () => void;
  /** True while a write is in flight — every verb goes inert. */
  busy?: boolean;
  /** The toolbar the screen composes; passed through to {@link DataTable}. */
  toolbar?: React.ReactNode;
  /** What to draw when nothing matched. */
  empty?: React.ReactNode;
}

/**
 * Render the repository table. See {@link RepositoryTableProps}.
 *
 * @returns The table card, its toolbar and its foot.
 */
export function RepositoryTable({
  repositories,
  total,
  loading = false,
  error = null,
  onRetry,
  busy = false,
  toolbar,
  empty,
  onOpenDetail,
  onRescan,
  onRemove,
}: RepositoryTableProps) {
  const columns = React.useMemo<DataTableColumn<DashboardRepository>[]>(
    () => [
      {
        id: 'name',
        header: 'Repository',
        skeletonWidth: '12rem',
        cell: (repository) => (
          <div className="repo-row__identity">
            <Avatar shape="hex" size="sm" name={repository.name} id={repository.id} />
            <div className="repo-row__names">
              <DataTableCellPrimary>{repository.name}</DataTableCellPrimary>
              <DataTableCellSub className="mono">{repository.full_name}</DataTableCellSub>
            </div>
          </div>
        ),
      },
      {
        id: 'provider',
        header: 'Provider',
        skeletonWidth: '5rem',
        cell: (repository) => <ProviderBadge provider={repository.provider} />,
      },
      {
        id: 'branch',
        header: 'Branch',
        skeletonWidth: '4rem',
        cell: (repository) => <span className="repo-row__branch mono">{repository.default_branch}</span>,
      },
      {
        id: 'files',
        header: 'Files',
        align: 'end',
        skeletonWidth: '3rem',
        cell: (repository) => (
          <span className="repo-row__num">{(repository.total_files ?? 0).toLocaleString()}</span>
        ),
      },
      {
        id: 'health',
        header: 'Health',
        skeletonWidth: '5rem',
        cell: (repository) =>
          repository.health ? (
            <RepositoryHealthBadge health={repository.health} />
          ) : (
            // Health is computed by the API; a payload without it means "not known", which is
            // a different fact from "healthy" and must not be drawn as one.
            <span className="repo-quiet" title="Health has not been computed for this repository">
              —
            </span>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        skeletonWidth: '4.5rem',
        cell: (repository) => (
          <Badge
            variant={REPOSITORY_STATUS_TONE[repository.status]}
            data-testid="repository-row-status"
          >
            {repository.status === 'scanning' ? (
              <Spinner size="xs" label="Scanning" aria-hidden />
            ) : null}
            {REPOSITORY_STATUS_LABEL[repository.status]}
          </Badge>
        ),
      },
      {
        id: 'scanned',
        header: 'Last scan',
        skeletonWidth: '4rem',
        cell: (repository) => (
          <span
            className="repo-row__scan"
            data-failed={repository.status === 'error' ? '' : undefined}
          >
            {formatLastScan(repository.last_scanned_at, repository.status === 'error')}
          </span>
        ),
      },
      {
        id: 'importable',
        header: 'Importable',
        skeletonWidth: '5rem',
        cell: (repository) => <RepositoryIndexMark repository={repository} />,
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        align: 'end',
        skeletonWidth: '2rem',
        cell: (repository) => (
          <RepositoryRowMenu
            repository={repository}
            busy={busy}
            onOpenDetail={onOpenDetail}
            onRescan={onRescan}
            onRemove={onRemove}
          />
        ),
      },
    ],
    [busy, onOpenDetail, onRemove, onRescan]
  );

  return (
    <DataTable
      columns={columns}
      rows={repositories}
      getRowId={(repository) => repository.id}
      getRowLabel={(repository) => repository.full_name || repository.name}
      caption="Repositories registered to this workspace"
      scrollX
      loading={loading}
      loadingLabel="Loading repositories…"
      error={error}
      onRetry={onRetry}
      empty={empty}
      toolbar={toolbar}
      onRowActivate={onOpenDetail}
      data-testid="repositories-table"
      footer={<DataTableFoot>{repositoryFootLabel(repositories.length, total)}</DataTableFoot>}
    />
  );
}

export default RepositoryTable;
