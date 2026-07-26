'use client';

/**
 * Compact paginated recent-jobs table (IXH-6.3, #5122).
 *
 * Consumes the BFF list proxies (`GET /api/export/jobs` or `GET /api/catalog/import`)
 * with offset/limit — never fetches the unbounded full history.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../ui/Button';
import {
  dashboardTableTheadClass,
  dashboardTableWrapClass,
  dashboardTbodyClass,
  dashboardThClass,
  dashboardTrHoverClass,
} from '../dashboardScreenClasses';

const DEFAULT_LIMIT = 10;
const cellClass = 'px-4 py-2 text-sm text-gray-700 dark:text-gray-300';

export type RecentAsyncJobKind = 'export' | 'import';

export interface RecentAsyncJobRow {
  job_id: string;
  state: string;
  percent?: number;
  artifact?: string | null;
  target?: string | null;
}

interface ListPayload {
  jobs?: RecentAsyncJobRow[];
  total?: number;
  limit?: number;
  offset?: number;
  success?: boolean;
  error?: string;
}

export interface RecentAsyncJobsPanelProps {
  kind: RecentAsyncJobKind;
  /** Page size (default 10). */
  limit?: number;
  title?: string;
  className?: string;
  /** Optional test id prefix (defaults from kind). */
  testId?: string;
}

function listUrl(kind: RecentAsyncJobKind, limit: number, offset: number): string {
  const base = kind === 'export' ? '/api/export/jobs' : '/api/catalog/import';
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  return `${base}?${params.toString()}`;
}

/** Paginated recent async jobs for export studio / catalog import. */
export function RecentAsyncJobsPanel({
  kind,
  limit = DEFAULT_LIMIT,
  title,
  className,
  testId,
}: RecentAsyncJobsPanelProps) {
  const pageLimit = Math.max(1, Math.min(limit, 50));
  const [offset, setOffset] = useState(0);
  const [jobs, setJobs] = useState<RecentAsyncJobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = testId ?? (kind === 'export' ? 'export-recent-jobs' : 'import-recent-jobs');
  const heading = title ?? (kind === 'export' ? 'Recent export jobs' : 'Recent import jobs');

  const load = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(listUrl(kind, pageLimit, nextOffset), { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as ListPayload | null;
        if (!res.ok || !body || body.success === false) {
          setError(body?.error || `Failed to load jobs (${res.status})`);
          setJobs([]);
          setTotal(0);
          return;
        }
        setJobs(Array.isArray(body.jobs) ? body.jobs : []);
        setTotal(typeof body.total === 'number' ? body.total : 0);
        setOffset(typeof body.offset === 'number' ? body.offset : nextOffset);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load jobs');
        setJobs([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [kind, pageLimit],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <section className={className} data-testid={id} aria-labelledby={`${id}-heading`}>
      <h2
        id={`${id}-heading`}
        className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100"
      >
        {heading}
      </h2>
      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" data-testid={`${id}-error`} role="alert">
          {error}
        </p>
      ) : (
        <div className={dashboardTableWrapClass}>
          <table className="min-w-full">
            <thead className={dashboardTableTheadClass}>
              <tr>
                <th className={dashboardThClass}>Job</th>
                <th className={dashboardThClass}>State</th>
                {kind === 'export' ? (
                  <>
                    <th className={dashboardThClass}>Target</th>
                    <th className={dashboardThClass}>Artifact</th>
                  </>
                ) : (
                  <th className={dashboardThClass}>Progress</th>
                )}
              </tr>
            </thead>
            <tbody className={dashboardTbodyClass}>
              {jobs.map((job) => (
                <tr key={job.job_id} className={dashboardTrHoverClass}>
                  <td className={`${cellClass} font-mono text-xs`}>{job.job_id}</td>
                  <td className={cellClass}>{job.state}</td>
                  {kind === 'export' ? (
                    <>
                      <td className={cellClass}>{job.target ?? '—'}</td>
                      <td className={`${cellClass} font-mono text-xs`}>{job.artifact ?? '—'}</td>
                    </>
                  ) : (
                    <td className={cellClass}>
                      {typeof job.percent === 'number' ? `${job.percent}%` : '—'}
                    </td>
                  )}
                </tr>
              ))}
              {jobs.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={kind === 'export' ? 4 : 3}
                    className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400"
                  >
                    No jobs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <span data-testid={`${id}-pagination-summary`}>
              {total === 0
                ? 'No jobs'
                : `${offset + 1}–${Math.min(offset + pageLimit, total)} of ${total}`}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid={`${id}-prev-page`}
                disabled={offset <= 0 || loading}
                onClick={() => void load(Math.max(0, offset - pageLimit))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid={`${id}-next-page`}
                disabled={offset + pageLimit >= total || loading}
                onClick={() => void load(offset + pageLimit)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default RecentAsyncJobsPanel;
