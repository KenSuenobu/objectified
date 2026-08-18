'use client';

/**
 * Compact paginated recent-jobs table (IXH-6.3, #5122).
 *
 * Consumes the BFF list proxies (`GET /api/export/jobs` or `GET /api/catalog/import`)
 * with offset/limit — never fetches the unbounded full history.
 *
 * Re-skinned by HIVE-6.4 (#5315) onto `DataTable`, which is what the import wizard's *Recent
 * import jobs* drawer needed anyway: the table brings the caps header, the dense rows, the
 * loading placeholders, the empty state and the failure state that this had hand-rolled or
 * lacked. The pager stays bespoke — the endpoint pages by offset and reports a total, so the
 * two buttons are the honest control for it, where `DataTablePager` wants a page count.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import {
  DataTable,
  DataTableFoot,
  dataTableRangeLabel,
  type DataTableColumn,
} from '../../../ui/DataTable';
import { EmptyState } from '../../../ui/EmptyState';

const DEFAULT_LIMIT = 10;

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

  const columns: DataTableColumn<RecentAsyncJobRow>[] = [
    {
      id: 'job',
      header: 'Job',
      cell: (job) => <span className="font-mono text-xs">{job.job_id}</span>,
    },
    {
      id: 'state',
      header: 'State',
      // `status` resolves through the shared vocabulary, so a running import here is the
      // same amber as a running import in the wizard's own progress badge.
      cell: (job) => <Badge status={job.state}>{job.state}</Badge>,
    },
    ...(kind === 'export'
      ? ([
          { id: 'target', header: 'Target', cell: (job) => job.target ?? '—' },
          {
            id: 'artifact',
            header: 'Artifact',
            cell: (job) => <span className="font-mono text-xs">{job.artifact ?? '—'}</span>,
          },
        ] as DataTableColumn<RecentAsyncJobRow>[])
      : ([
          {
            id: 'progress',
            header: 'Progress',
            cell: (job) => (typeof job.percent === 'number' ? `${job.percent}%` : '—'),
          },
        ] as DataTableColumn<RecentAsyncJobRow>[])),
  ];

  return (
    <section className={className} data-testid={id} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="mb-2 text-sm font-semibold text-fg">
        {heading}
      </h2>
      <DataTable
        dense
        caption={heading}
        columns={columns}
        rows={jobs}
        getRowId={(job) => job.job_id}
        getRowLabel={(job) => job.job_id}
        loading={loading && jobs.length === 0}
        loadingLabel={`Loading ${kind} jobs…`}
        error={error ? <span data-testid={`${id}-error`}>{error}</span> : undefined}
        onRetry={() => void load(offset)}
        empty={<EmptyState variant="compact" tone="neutral" title="No jobs yet." />}
        footer={
          <DataTableFoot>
            <span data-testid={`${id}-pagination-summary`}>
              {dataTableRangeLabel(Math.floor(offset / pageLimit) + 1, pageLimit, total, 'job')}
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
          </DataTableFoot>
        }
      />
    </section>
  );
}

export default RecentAsyncJobsPanel;
