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
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardHeader } from '@/app/components/ui/Card';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { REFRESH_STATUS_TONE } from '@/app/components/ade/repositories/repositoriesModel';
import { getRefreshStatusPresentation } from './repository-refresh-status-chip-copy';
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
 * The "Refresh now" / "Refresh" action, at the repository and the file level.
 *
 * Shows a spinner and disables itself while its own action is in flight, and stays disabled
 * while any other refresh runs so a reader cannot double-fire. HIVE-7.5 (#5322) made it the
 * shared {@link Button}: the hand-rolled one carried `border-indigo-200 text-indigo-700
 * hover:bg-indigo-50 dark:…`, which was the only indigo left on this tab.
 *
 * @param props.label What the button says.
 * @param props.busy Whether *this* action is the one in flight.
 * @param props.disabled Whether any refresh is in flight.
 * @param props.onClick Run it.
 * @param props.testId The row's test hook.
 * @param props.ariaLabel What it is called for a screen reader.
 * @returns The button.
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
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={ariaLabel}
    >
      <RefreshCw className={busy ? 'animate-spin' : undefined} aria-hidden />
      {label}
    </Button>
  );
}

/**
 * One row's refresh state, as the shared status pill.
 *
 * @param props.status The computed refresh status code.
 * @returns The chip.
 */
function RefreshStatusChip({ status }: { status: string }) {
  const presentation = getRefreshStatusPresentation(status);
  return (
    <Badge
      variant={REFRESH_STATUS_TONE[presentation.tone]}
      dot
      className="repo-specs-chip"
      title={presentation.description}
      aria-label={`Refresh status: ${presentation.label}. ${presentation.description}`}
    >
      {presentation.label}
    </Badge>
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
    <Card className="overflow-hidden" data-testid="repository-specs-table">
      <CardHeader className="repo-det-card__head">
        <div className="flex flex-col gap-1">
          <h3 className="repo-det-card__title">
            <RefreshCw aria-hidden />
            Imported specs
          </h3>
          <p className="repo-det-note">
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
      </CardHeader>

      {notice ? (
        <p
          data-testid="repository-refresh-notice"
          role="status"
          className="repo-specs-notice"
          data-tone={notice.kind === 'success' ? 'ok' : 'danger'}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="repo-det-table-scroll">
        <table className="repo-det-table repo-specs-table table-density table-dense">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Status</th>
              <th scope="col">Last refreshed</th>
              <th scope="col">Next due</th>
              {showActions ? (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {specs.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="repo-det-table__state">
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
                  // No persisted divergence column yet (RAR-4.4 dispatcher wiring pending);
                  // rendered when a future signal supplies it.
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
                  <tr key={spec.id} data-testid="repository-spec-row" data-status={status}>
                    <td>
                      <Link href={reviewHref} className="repo-files-table__link mono">
                        {spec.path}
                      </Link>
                      <span className="repo-det-subcell">
                        {spec.project_name ? `${spec.project_name} · ${spec.branch}` : spec.branch}
                      </span>
                      {spec.backfilled ? (
                        <Badge
                          variant="warn"
                          className="mt-1"
                          data-testid="repository-spec-backfilled"
                          title="This file was imported before import-spec capture existed; a default spec was seeded so it stays refresh-eligible. Re-importing the file records your actual options."
                        >
                          Imported before spec capture
                        </Badge>
                      ) : null}
                    </td>
                    <td>
                      <div className="flex flex-col items-start gap-1">
                        <RefreshStatusChip status={status} />
                        {isDiverged ? (
                          <Link href={reviewHref} className="repo-det-link inline-flex items-center gap-1">
                            <AlertTriangle className="size-3 shrink-0" aria-hidden />
                            Review divergence
                          </Link>
                        ) : null}
                      </div>
                    </td>
                    <td className="repo-det-quiet-cell whitespace-nowrap">
                      {formatRefreshedAgo(lastRefreshed, now)}
                    </td>
                    <td className="repo-det-quiet-cell whitespace-nowrap">
                      {formatNextDue(nextDue, now)}
                    </td>
                    {showActions ? (
                      <td className="whitespace-nowrap">
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

      <div className="repo-det-table__foot">
        <span>
          {specs.length.toLocaleString()} imported spec{specs.length === 1 ? '' : 's'}
        </span>
      </div>
    </Card>
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
      <ErrorState
        title="Could not load refresh status"
        description={error}
        onRetry={() => void fetchSpecs()}
      />
    );
  }

  if (loading && specs.length === 0) {
    return <LoadingState message="Loading refresh status…" />;
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
