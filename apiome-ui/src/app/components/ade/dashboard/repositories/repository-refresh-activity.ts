/**
 * Tenant-wide refresh-activity aggregation for the dashboard widget
 * (RAR-5.5, #3536).
 *
 * The widget shows at-a-glance refresh health across every repository in the
 * tenant: counts by refresh state (stale / diverged / failed / refreshing /
 * up-to-date), how many specs were successfully refreshed in the last 24 hours,
 * and a per-repository breakdown so the counts can be drilled into.
 *
 * Each input row is one imported-file lineage's raw refresh signals (from
 * `GET /api/repositories/refresh-activity`); the state is derived here with
 * `computeRefreshStatus` — the exact RAR-2.3 state machine the Specs tab and
 * the REST read model use — so the widget's tallies stay in lock-step with the
 * per-file chips.
 *
 * Kept pure (no React, no I/O, explicit clock) so it is unit-testable in
 * isolation, mirroring `repository-refresh-status.ts`.
 */

import { computeRefreshStatus } from './repository-refresh-status';
import type { RefreshStatusCode } from './repository-refresh-status-chip-copy';

/**
 * One per-lineage refresh signal row as returned by the refresh-activity
 * endpoint (see `listTenantRefreshActivitySignals`).
 */
export type RefreshActivitySignal = {
  repository_id: string;
  repository_full_name: string | null;
  clone_url: string | null;
  branch: string;
  path: string;
  last_imported_committed_at: string | null;
  last_imported_blob_sha: string | null;
  remote_committed_at: string | null;
  remote_blob_sha: string | null;
  is_refreshing: boolean;
  last_refresh_failed: boolean;
  last_refreshed_at: string | null;
  /**
   * RAR-4.4 divergence hold. No persisted column exists yet (the dispatcher
   * wiring is pending), so the wire omits it and it defaults to false; the
   * aggregation is forward-compatible and counts it when a future signal
   * supplies it.
   */
  diverged?: boolean;
};

/** Counts of lineages by refresh state. */
export type RefreshStateCounts = Record<RefreshStatusCode, number>;

/** Per-repository slice of the tenant-wide tallies (drill-in row). */
export interface RepositoryRefreshActivity {
  repositoryId: string;
  /** Human-readable repository name for the drill-in link. */
  repositoryName: string;
  /** Total spec lineages tracked for this repository. */
  total: number;
  /** Counts by refresh state for this repository. */
  counts: RefreshStateCounts;
  /** Lineages successfully refreshed within the recency window. */
  refreshedRecently: number;
  /** Lineages needing attention: stale + diverged + failed. */
  attention: number;
}

/** The tenant-wide summary the widget renders. */
export interface RefreshActivitySummary {
  /** Total spec lineages tracked across the tenant. */
  total: number;
  /** Tenant-wide counts by refresh state. */
  counts: RefreshStateCounts;
  /** Lineages successfully refreshed within the recency window. */
  refreshedRecently: number;
  /**
   * Repositories with at least one lineage needing attention (stale, diverged,
   * or failed), ordered most-affected first — the widget's drill-in list.
   */
  affectedRepositories: RepositoryRefreshActivity[];
}

/** The "recent activity" window: a successful refresh within the last 24h. */
export const REFRESHED_RECENTLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A zeroed by-state counter. */
function emptyCounts(): RefreshStateCounts {
  return { 'up-to-date': 0, stale: 0, refreshing: 0, failed: 0, diverged: 0 };
}

/**
 * Derive a display name for a repository from its registration fields:
 * the provider `owner/name` when known, otherwise the clone URL's last path
 * segment (sans `.git`), otherwise a neutral "Repository".
 *
 * @param fullName The registered `repository_full_name`, possibly null/blank.
 * @param cloneUrl The registered clone URL, possibly null/blank.
 * @returns A short human-readable repository name.
 */
export function repositoryDisplayName(
  fullName: string | null | undefined,
  cloneUrl: string | null | undefined,
): string {
  const name = fullName?.trim();
  if (name) return name;
  const url = cloneUrl?.trim();
  if (url) {
    const segment = url
      .replace(/\/+$/, '')
      .split('/')
      .pop()
      ?.replace(/\.git$/i, '')
      .trim();
    if (segment) return segment;
  }
  return 'Repository';
}

/**
 * Whether a lineage's last successful refresh falls inside the recency window.
 *
 * @param lastRefreshedAt ISO-8601 finished-at of the last successful refresh, or null.
 * @param now Reference epoch milliseconds.
 * @returns True when the refresh happened within {@link REFRESHED_RECENTLY_WINDOW_MS} of `now`.
 */
export function refreshedRecently(
  lastRefreshedAt: string | null | undefined,
  now: number,
): boolean {
  if (!lastRefreshedAt) return false;
  const t = Date.parse(lastRefreshedAt);
  if (Number.isNaN(t)) return false;
  return now - t <= REFRESHED_RECENTLY_WINDOW_MS && t <= now;
}

/**
 * Aggregate per-lineage refresh signals into the tenant-wide widget summary.
 *
 * Every row's state is derived with the RAR-2.3 state machine
 * (`computeRefreshStatus`), then tallied tenant-wide and per repository. The
 * drill-in list (`affectedRepositories`) keeps only repositories with at least
 * one lineage needing attention (stale / diverged / failed), ordered by that
 * attention count descending, then by name for a stable order.
 *
 * @param rows The per-lineage signal rows for the tenant.
 * @param now Reference epoch milliseconds for the "refreshed recently" window
 *   (passed explicitly so the aggregation is deterministic under test).
 * @returns The tenant-wide {@link RefreshActivitySummary}.
 */
export function summarizeRefreshActivity(
  rows: readonly RefreshActivitySignal[],
  now: number,
): RefreshActivitySummary {
  const counts = emptyCounts();
  let refreshed = 0;
  const byRepo = new Map<string, RepositoryRefreshActivity>();

  for (const row of rows) {
    const status = computeRefreshStatus({
      remoteCommittedAt: row.remote_committed_at,
      lastImportedCommittedAt: row.last_imported_committed_at,
      remoteChecksum: row.remote_blob_sha,
      lastImportedChecksum: row.last_imported_blob_sha,
      isRefreshing: row.is_refreshing,
      lastRefreshFailed: row.last_refresh_failed,
      diverged: row.diverged === true,
    });
    counts[status] += 1;
    const recent = refreshedRecently(row.last_refreshed_at, now);
    if (recent) refreshed += 1;

    let repo = byRepo.get(row.repository_id);
    if (!repo) {
      repo = {
        repositoryId: row.repository_id,
        repositoryName: repositoryDisplayName(row.repository_full_name, row.clone_url),
        total: 0,
        counts: emptyCounts(),
        refreshedRecently: 0,
        attention: 0,
      };
      byRepo.set(row.repository_id, repo);
    }
    repo.total += 1;
    repo.counts[status] += 1;
    if (recent) repo.refreshedRecently += 1;
  }

  const affectedRepositories = Array.from(byRepo.values())
    .map((repo) => ({
      ...repo,
      attention: repo.counts.stale + repo.counts.diverged + repo.counts.failed,
    }))
    .filter((repo) => repo.attention > 0)
    .sort(
      (a, b) =>
        b.attention - a.attention || a.repositoryName.localeCompare(b.repositoryName),
    );

  return {
    total: rows.length,
    counts,
    refreshedRecently: refreshed,
    affectedRepositories,
  };
}
