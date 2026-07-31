'use client';

/**
 * Repository detail "Specs" tab — per-file refresh status (RAR-5.1, #3532) and
 * one-shot "Refresh Now" (RAR-5.2, #3533).
 *
 * Lists every imported-file lineage for the repository with its materialized
 * refresh state (RAR-2.3), last-refreshed time, next-due time (RAR-3.1 cadence),
 * and a divergence indicator (RAR-4.4). Diverged files are rendered visually
 * distinct and link to the review action (the file's diff view on the Files tab).
 *
 * Each row carries a per-file "Refresh" action and the table header a per-repo
 * "Refresh now" action. Both POST `/api/repositories/{id}/refresh`, which runs
 * the spec-faithful re-import path on demand — using the stored import spec, the
 * freshness gate, and the divergence guard — even when scheduled auto-refresh is
 * off. The freshness gate means refreshing an up-to-date file is a no-op, which
 * the success notice reports.
 *
 * Data comes from `GET /api/repositories/{id}/refresh-specs`; the status is
 * derived on the client with `computeRefreshStatus`, the same logic the REST
 * read model applies server-side, so the chip matches the state machine exactly.
 *
 * The fetching wrapper (`RepositorySpecsTab`) and the pure presentational table
 * (`RepositorySpecsTable`) are split so the table can be unit-tested with fixed
 * rows and a fixed clock.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@lib/utils';
import {
  getRefreshStatusPresentation,
  refreshStatusChipToneClasses,
} from './repository-refresh-status-chip-copy';
import { computeNextDue, computeRefreshStatus } from './repository-refresh-status';

/** One per-file refresh row as returned by the refresh-specs endpoint. */
export type RepositoryRefreshSpec = {
  id: string;
  path: string;
  branch: string;
  project_id: string | null;
  project_name: string | null;
  project_slug: string | null;
  last_imported_committed_at: string | null;
  last_imported_blob_sha: string | null;
  remote_committed_at: string | null;
  remote_blob_sha: string | null;
  is_refreshing: boolean;
  last_refresh_failed: boolean;
  last_refreshed_at: string | null;
  spec_updated_at: string | null;
  /** True when the spec was seeded by the RAR-1.6 backfill (imported before spec capture). */
  backfilled?: boolean;
  refresh_interval_seconds: number;
  repo_last_refreshed_at: string | null;
  auto_refresh_enabled: boolean;
};

/** Deep-link into the Files tab and open the file's review (diff) view. */
export function repositorySpecReviewHref(
  repositoryId: string,
  path: string,
  branch: string,
): string {
  const qs = new URLSearchParams();
  qs.set('tab', 'files');
  qs.set('path', path);
  qs.set('branch', branch);
  return `/ade/dashboard/repositories/${encodeURIComponent(repositoryId)}/preview?${qs.toString()}`;
}

/**
 * Human-readable "x ago" for a past ISO timestamp, relative to `now`. Returns a
 * neutral em dash when the timestamp is absent or unparseable.
 *
 * @param iso An ISO-8601 timestamp or null.
 * @param now Reference epoch milliseconds (defaults to the current time).
 * @returns A short relative string such as "3m ago", or "—".
 */
export function formatRefreshedAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const sec = Math.floor((now - t) / 1000);
  if (sec < 0) return 'just now';
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Human-readable next-due label from a {@link computeNextDue} result.
 *  - `null` (auto-refresh off) → "Paused"
 *  - `'due'` (never swept) or a past time → "Due now"
 *  - a future time → "in 4m" / "in 2h" / "in 3d"
 *
 * @param nextDue The result of {@link computeNextDue}.
 * @param now Reference epoch milliseconds (defaults to the current time).
 * @returns A short label describing when the next refresh is due.
 */
export function formatNextDue(nextDue: Date | 'due' | null, now: number = Date.now()): string {
  if (nextDue === null) return 'Paused';
  if (nextDue === 'due') return 'Due now';
  const sec = Math.floor((nextDue.getTime() - now) / 1000);
  if (sec <= 0) return 'Due now';
  if (sec < 60) return 'in <1m';
  if (sec < 3600) return `in ${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `in ${Math.floor(sec / 3600)}h`;
  return `in ${Math.floor(sec / 86400)}d`;
}

/** Busy-key sentinel identifying the per-repo ("Refresh now") action. */
export const REPO_REFRESH_KEY = '__repo__';

/** A transient feedback notice shown after a refresh action. */
export type RefreshNotice = { kind: 'success' | 'error'; text: string };

/**
 * Small "Refresh now"/"Refresh" button used at the repo and file level. Shows a
 * spinner and disables itself while its own action is in flight, and stays
 * disabled while any other refresh action runs so a user cannot double-fire.
 */
function RefreshNowButton({
  label,
  busy,
  disabled,
  onClick,
  testId,
  ariaLabel,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  testId: string;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
        'border-indigo-200 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800/60 dark:text-indigo-300 dark:hover:bg-indigo-950/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      <RefreshCw className={cn('h-3.5 w-3.5 shrink-0', busy && 'animate-spin')} aria-hidden />
      {label}
    </button>
  );
}

/** A single refresh-status chip for a spec row. */
function RefreshStatusChip({ status }: { status: string }) {
  const presentation = getRefreshStatusPresentation(status);
  return (
    <span
      className={refreshStatusChipToneClasses(presentation.tone)}
      title={presentation.description}
      aria-label={`Refresh status: ${presentation.label}. ${presentation.description}`}
    >
      {presentation.label}
    </span>
  );
}

/**
 * Pure presentational table of per-file refresh status. Takes already-fetched
 * rows and an optional fixed clock so it renders deterministically in tests.
 *
 * @param repositoryId The repository whose files these specs belong to (for review links).
 * @param specs The per-file refresh rows to render.
 * @param now Reference epoch milliseconds for relative formatting; captured once
 *   by the fetching wrapper so render stays pure (also a test seam).
 */
export function RepositorySpecsTable({
  repositoryId,
  specs,
  now,
  busyKey = null,
  notice = null,
  onRefreshRepo,
  onRefreshFile,
}: {
  repositoryId: string;
  specs: RepositoryRefreshSpec[];
  now: number;
  /** Key of the in-flight refresh: {@link REPO_REFRESH_KEY} or a spec id; null when idle. */
  busyKey?: string | null;
  /** Transient feedback from the last refresh action. */
  notice?: RefreshNotice | null;
  /** Trigger a whole-repository refresh; omit to hide the per-repo button. */
  onRefreshRepo?: () => void;
  /** Trigger a single-file refresh; omit to hide the per-file buttons. */
  onRefreshFile?: (spec: RepositoryRefreshSpec) => void;
}) {
  const anyBusy = busyKey !== null;
  const showActions = typeof onRefreshFile === 'function';
  const columnCount = showActions ? 5 : 4;
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Imported specs</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Per-file auto-refresh status, last refresh, and next due.
          </p>
        </div>
        {onRefreshRepo && specs.length > 0 ? (
          <RefreshNowButton
            label="Refresh now"
            testId="repository-refresh-all"
            ariaLabel="Refresh all imported specs in this repository now"
            busy={busyKey === REPO_REFRESH_KEY}
            disabled={anyBusy}
            onClick={onRefreshRepo}
          />
        ) : null}
      </div>
      {notice ? (
        <div
          data-testid="repository-refresh-notice"
          role="status"
          className={cn(
            'border-b px-4 py-2 text-xs',
            notice.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50/70 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300'
              : 'border-rose-200 bg-rose-50/70 text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300',
          )}
        >
          {notice.text}
        </div>
      ) : null}
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-400">
          <tr>
            <th className="px-4 py-2 align-middle text-left font-semibold">File</th>
            <th className="px-4 py-2 align-middle text-left font-semibold">Status</th>
            <th className="px-4 py-2 align-middle text-left font-semibold">Last refreshed</th>
            <th className="px-4 py-2 align-middle text-left font-semibold">Next due</th>
            {showActions ? (
              <th className="px-4 py-2 align-middle text-right font-semibold">Actions</th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {specs.length === 0 ? (
            <tr>
              <td
                colSpan={columnCount}
                className="px-4 py-12 align-middle text-center text-sm leading-relaxed text-gray-500 dark:text-gray-400"
              >
                No imported specs yet. Open the Files tab, import a specification, and its
                refresh status will appear here.
              </td>
            </tr>
          ) : (
            specs.map((spec) => {
              const status = computeRefreshStatus({
                remoteCommittedAt: spec.remote_committed_at,
                lastImportedCommittedAt: spec.last_imported_committed_at,
                remoteChecksum: spec.remote_blob_sha,
                lastImportedChecksum: spec.last_imported_blob_sha,
                isRefreshing: spec.is_refreshing,
                lastRefreshFailed: spec.last_refresh_failed,
                // No persisted divergence column yet (RAR-4.4 dispatcher wiring
                // pending); rendered when a future signal supplies it.
                diverged: false,
              });
              const isDiverged = status === 'diverged';
              const nextDue = computeNextDue(
                spec.repo_last_refreshed_at,
                spec.refresh_interval_seconds,
                spec.auto_refresh_enabled,
              );
              const lastRefreshed = spec.last_refreshed_at ?? spec.spec_updated_at;
              const reviewHref = repositorySpecReviewHref(repositoryId, spec.path, spec.branch);
              return (
                <tr
                  key={spec.id}
                  data-testid="repository-spec-row"
                  data-status={status}
                  className={cn(
                    'hover:bg-gray-50/80 dark:hover:bg-gray-900/40',
                    isDiverged && 'bg-purple-50/60 dark:bg-purple-950/20',
                  )}
                >
                  <td className="max-w-[260px] px-4 py-2 align-middle">
                    <Link
                      href={reviewHref}
                      className="break-all font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {spec.path}
                    </Link>
                    <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                      {spec.project_name ? (
                        <span>
                          {spec.project_name} · {spec.branch}
                        </span>
                      ) : (
                        spec.branch
                      )}
                    </div>
                    {spec.backfilled ? (
                      <span
                        data-testid="repository-spec-backfilled"
                        title="This file was imported before import-spec capture existed; a default spec was seeded so it stays refresh-eligible. Re-importing the file records your actual options."
                        className="mt-1 inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300"
                      >
                        Imported before spec capture
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 align-middle">
                    <div className="flex flex-col items-start gap-1">
                      <RefreshStatusChip status={status} />
                      {isDiverged ? (
                        <Link
                          href={reviewHref}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-purple-700 hover:underline dark:text-purple-300"
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                          Review divergence
                        </Link>
                      ) : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 align-middle text-gray-600 dark:text-gray-400">
                    {formatRefreshedAgo(lastRefreshed, now)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 align-middle text-gray-600 dark:text-gray-400">
                    {formatNextDue(nextDue, now)}
                  </td>
                  {showActions ? (
                    <td className="whitespace-nowrap px-4 py-2 align-middle text-right">
                      <RefreshNowButton
                        label="Refresh"
                        testId="repository-refresh-file"
                        ariaLabel={`Refresh ${spec.path} now`}
                        busy={busyKey === spec.id}
                        disabled={anyBusy}
                        onClick={() => onRefreshFile?.(spec)}
                      />
                    </td>
                  ) : null}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Fetching wrapper for the Specs tab: loads per-file refresh status for the
 * repository and renders {@link RepositorySpecsTable}, with loading and error
 * states mirroring the Imports tab.
 *
 * @param repositoryId The repository to load refresh specs for.
 */
export function RepositorySpecsTab({ repositoryId }: { repositoryId: string }) {
  const [specs, setSpecs] = useState<RepositoryRefreshSpec[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which refresh action is in flight (REPO_REFRESH_KEY or a spec id), and the
  // last action's feedback notice.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<RefreshNotice | null>(null);
  // Capture a single render-stable clock for relative-time formatting so the
  // table stays pure (no Date.now() during render).
  const [now] = useState<number>(() => Date.now());

  const fetchSpecs = useCallback(async () => {
    if (!repositoryId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/repositories/${encodeURIComponent(repositoryId)}/refresh-specs?limit=200`,
        { credentials: 'include' },
      );
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        specs?: RepositoryRefreshSpec[];
        error?: string;
      };
      if (!res.ok || data.success !== true) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      setSpecs(Array.isArray(data.specs) ? data.specs : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load refresh specs');
      setSpecs([]);
    } finally {
      setLoading(false);
    }
  }, [repositoryId]);

  useEffect(() => {
    void fetchSpecs();
  }, [fetchSpecs]);

  // Trigger a one-shot refresh (whole-repo when body is empty, single file when
  // path/branch are given), then re-load the rows so statuses update.
  const runRefresh = useCallback(
    async (busy: string, body: { path?: string; branch?: string }) => {
      if (!repositoryId || busyKey !== null) return;
      setBusyKey(busy);
      setNotice(null);
      try {
        const res = await fetch(`/api/repositories/${encodeURIComponent(repositoryId)}/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          enqueued?: number;
          skipped?: number;
          error?: string;
        };
        if (!res.ok || data.success !== true) {
          throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
        }
        const enqueued = Number(data.enqueued ?? 0);
        setNotice({
          kind: 'success',
          text:
            enqueued > 0
              ? `Refresh queued for ${enqueued} file${enqueued === 1 ? '' : 's'}.`
              : 'Already up to date — nothing to refresh.',
        });
        await fetchSpecs();
      } catch (e) {
        setNotice({
          kind: 'error',
          text: e instanceof Error ? e.message : 'Could not start the refresh',
        });
      } finally {
        setBusyKey(null);
      }
    },
    [repositoryId, busyKey, fetchSpecs],
  );

  const handleRefreshRepo = useCallback(() => {
    void runRefresh(REPO_REFRESH_KEY, {});
  }, [runRefresh]);

  const handleRefreshFile = useCallback(
    (spec: RepositoryRefreshSpec) => {
      void runRefresh(spec.id, { path: spec.path, branch: spec.branch });
    },
    [runRefresh],
  );

  if (error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50/80 p-6 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-300">
        {error}
      </div>
    );
  }

  if (loading && specs.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-12 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading refresh status…
      </div>
    );
  }

  return (
    <RepositorySpecsTable
      repositoryId={repositoryId}
      specs={specs}
      now={now}
      busyKey={busyKey}
      notice={notice}
      onRefreshRepo={handleRefreshRepo}
      onRefreshFile={handleRefreshFile}
    />
  );
}
