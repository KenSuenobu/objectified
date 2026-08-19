'use client';

/**
 * The catalog imports this repository has produced (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Preview → *Recent imports from this
 * repo* and §Imports → *Import history*. The mockup draws those as two tables; they are two
 * *views* of one table — the first is the last eight rows with a "See all →", the second is
 * every row — so this is one component with a `limit`.
 *
 * The screen this replaces had them as two hand-written `<table>`s, 90 lines apart, with
 * different column orders, different empty copy, one `divide-gray-100` and one
 * `divide-gray-800`, and a `blob …` line that one of them dropped. Nothing about that was a
 * design decision; it was two people writing the same table twice.
 *
 * Every state a read can be in — loading, failed, empty, full — is one row of the table rather
 * than a replacement for it, so the header stays put and the reader keeps the column names
 * they were reading. `ui/ErrorState` would be the right answer for a panel that has nothing
 * else in it; this table sits inside a card that still has its own title and action.
 */

import * as React from 'react';
import Link from 'next/link';

import { Badge } from '@/app/components/ui/Badge';
import { cn } from '@lib/utils';

import {
  NO_IMPORTS_RECORDED,
  NO_IMPORTS_YET,
  formatImportedByActor,
  formatRelativeWhen,
  repositoryImportedFileHref,
  shortBlobRef,
} from './repositoryDetailModel';

/** One row of `GET /api/repositories/{id}/imports`. */
export interface RepositoryImportRow {
  id: string;
  path: string;
  branch: string;
  blob_sha: string | null;
  created_at: string;
  project_id: string;
  project_name: string;
  project_slug: string;
  catalog_version_label: string;
  version_uuid: string;
  imported_by: string | null;
  imported_by_name: string | null;
  imported_by_email: string | null;
}

export interface RepositoryImportsTableProps {
  /** The repository these imports came from — needed for the file deep links. */
  repositoryId: string;
  /** The rows, newest first. */
  rows: readonly RepositoryImportRow[];
  /** True while the read is in flight. */
  loading?: boolean;
  /** The read's failure, if it failed. */
  error?: string | null;
  /** Draw at most this many rows. Omit for the whole history. */
  limit?: number;
  /**
   * Which copy an empty table shows.
   *
   * The two are different sentences because they are read in different places: Preview's
   * points at the Files tab as the next step, the history's assumes the reader is already
   * looking for it.
   */
  emptyCopy?: 'preview' | 'history';
  /** Reference clock for the relative "2h ago" column; a seam so tests need no fake timers. */
  now?: number;
  /** Extra classes for the table element. */
  className?: string;
}

/** The five columns, in the mockup's order. */
const COLUMNS = ['When', 'File', 'Project · version', 'Outcome', 'By'] as const;

/**
 * Render the table. See {@link RepositoryImportsTableProps}.
 *
 * @returns The imports table, including its own loading, error and empty rows.
 */
export function RepositoryImportsTable({
  repositoryId,
  rows,
  loading = false,
  error = null,
  limit,
  emptyCopy = 'history',
  now,
  className,
}: RepositoryImportsTableProps) {
  const shown = limit != null ? rows.slice(0, limit) : rows;

  return (
    <div className="repo-det-table-scroll">
      <table
        className={cn('repo-det-table table-density table-dense', className)}
        data-testid="repository-imports-table"
      >
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {error ? (
            <tr>
              <td colSpan={COLUMNS.length} className="repo-det-table__state" data-tone="danger">
                {error}
              </td>
            </tr>
          ) : loading && rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length} className="repo-det-table__state">
                Loading imports…
              </td>
            </tr>
          ) : shown.length === 0 ? (
            <tr>
              <td
                colSpan={COLUMNS.length}
                className="repo-det-table__state"
                data-testid="repository-imports-empty"
              >
                {emptyCopy === 'preview' ? NO_IMPORTS_YET : NO_IMPORTS_RECORDED}
              </td>
            </tr>
          ) : (
            shown.map((row) => {
              const blob = shortBlobRef(row.blob_sha);
              return (
                <tr key={row.id} data-testid="repository-import-row">
                  <td className="repo-det-quiet-cell whitespace-nowrap">
                    {formatRelativeWhen(row.created_at, now)}
                  </td>
                  <td>
                    <Link
                      href={repositoryImportedFileHref(repositoryId, row.path, row.branch)}
                      className="repo-files-table__link mono"
                    >
                      {row.path}
                    </Link>
                    <span className="repo-det-subcell mono">
                      {blob ? `blob ${blob} · ${row.branch}` : row.branch}
                    </span>
                  </td>
                  <td>
                    <Link
                      href={`/ade/dashboard/versions?projectId=${encodeURIComponent(row.project_id)}`}
                      className="repo-files-table__link"
                    >
                      {row.project_name}
                    </Link>
                    <span className="repo-det-subcell mono">v{row.catalog_version_label}</span>
                  </td>
                  <td>
                    <Badge status="completed">Completed</Badge>
                  </td>
                  <td className="repo-det-quiet-cell">{formatImportedByActor(row)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export default RepositoryImportsTable;
