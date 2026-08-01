'use client';

/**
 * Dashboard "Refresh activity" widget (RAR-5.5, #3536) — at-a-glance refresh
 * health across every repository in the tenant, extending the REPO-11 KPI
 * strip on the Repositories page.
 *
 * Shows the tenant-wide counts by refresh state — stale / diverged / failed /
 * refreshing — plus how many specs were successfully refreshed in the last
 * 24 hours, and a drill-in list of the most-affected repositories, each
 * linking straight to that repository's Specs tab where the per-file states
 * and the "Refresh now" actions live.
 *
 * Data comes from `GET /api/repositories/refresh-activity`; states are derived
 * on the client with the same RAR-2.3 state machine the Specs tab uses
 * (`summarizeRefreshActivity` → `computeRefreshStatus`), so the widget's
 * tallies always agree with the per-file chips.
 *
 * The fetching wrapper (`RepositoryRefreshActivityCard`) and the pure
 * presentational view (`RepositoryRefreshActivityCardView`) are split so the
 * view can be unit-tested with a fixed summary.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@lib/utils';
import {
  getRefreshStatusPresentation,
  refreshStatusChipToneClasses,
  type RefreshStatusCode,
} from './repository-refresh-status-chip-copy';
import {
  summarizeRefreshActivity,
  type RefreshActivitySignal,
  type RefreshActivitySummary,
} from './repository-refresh-activity';

/** How many affected repositories the drill-in list shows before summarizing. */
export const AFFECTED_REPOS_SHOWN = 5;

/** Deep-link to a repository's Specs tab (per-file refresh states + actions). */
export function repositoryRefreshSpecsHref(repositoryId: string): string {
  return `/ade/dashboard/repositories/${encodeURIComponent(repositoryId)}/preview?tab=specs`;
}

/**
 * One state-count chip (e.g. "Stale 4"), toned with the shared refresh-status
 * chip classes so the widget reads as family with the Specs tab. Zero counts
 * render muted so attention lands on the non-zero states.
 */
function StateCountChip({ code, count }: { code: RefreshStatusCode; count: number }) {
  const presentation = getRefreshStatusPresentation(code);
  return (
    <span
      data-testid={`refresh-activity-count-${code}`}
      title={presentation.description}
      className={cn(
        refreshStatusChipToneClasses(presentation.tone),
        count === 0 && 'opacity-50 grayscale',
      )}
      aria-label={`${presentation.label}: ${count}`}
    >
      {presentation.label}
      <span className="font-semibold tabular-nums">{count.toLocaleString()}</span>
    </span>
  );
}

/**
 * Pure presentational card for the tenant-wide refresh-activity summary.
 *
 * @param summary The aggregated tallies from {@link summarizeRefreshActivity}.
 */
export function RepositoryRefreshActivityCardView({
  summary,
}: {
  summary: RefreshActivitySummary;
}) {
  const shown = summary.affectedRepositories.slice(0, AFFECTED_REPOS_SHOWN);
  const hiddenCount = summary.affectedRepositories.length - shown.length;
  return (
    <div
      data-testid="refresh-activity-card"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] uppercase leading-tight tracking-wider text-gray-500 dark:text-gray-400">
          <RefreshCw className="h-3 w-3 shrink-0" aria-hidden />
          Refresh activity
        </p>
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {summary.total === 0
            ? 'No imported specs tracked yet'
            : `${summary.total.toLocaleString()} spec${summary.total === 1 ? '' : 's'} tracked · ${summary.refreshedRecently.toLocaleString()} refreshed (24h)`}
        </p>
      </div>
      {summary.total === 0 ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Import a spec from a repository and its auto-refresh health will appear here.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StateCountChip code="stale" count={summary.counts.stale} />
            <StateCountChip code="diverged" count={summary.counts.diverged} />
            <StateCountChip code="failed" count={summary.counts.failed} />
            <StateCountChip code="refreshing" count={summary.counts.refreshing} />
            <StateCountChip code="up-to-date" count={summary.counts['up-to-date']} />
          </div>
          {shown.length > 0 ? (
            <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-700/60 dark:border-gray-700/60">
              {shown.map((repo) => (
                <li key={repo.repositoryId}>
                  <Link
                    data-testid="refresh-activity-repo-link"
                    href={repositoryRefreshSpecsHref(repo.repositoryId)}
                    title={`Open the Specs tab for ${repo.repositoryName}`}
                    className="flex items-center justify-between gap-3 py-1.5 text-xs outline-none ring-indigo-500/40 hover:bg-gray-50/80 focus-visible:ring-2 dark:hover:bg-gray-900/40"
                  >
                    <span className="min-w-0 truncate font-medium text-indigo-600 dark:text-indigo-400">
                      {repo.repositoryName}
                    </span>
                    <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
                      {[
                        repo.counts.stale > 0 ? `${repo.counts.stale} stale` : null,
                        repo.counts.diverged > 0 ? `${repo.counts.diverged} diverged` : null,
                        repo.counts.failed > 0 ? `${repo.counts.failed} failed` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">
              All repositories healthy — nothing stale, diverged, or failed.
            </p>
          )}
          {hiddenCount > 0 ? (
            <p className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              +{hiddenCount.toLocaleString()} more{' '}
              {hiddenCount === 1 ? 'repository needs' : 'repositories need'} attention.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Fetching wrapper for the widget: loads the tenant-wide refresh signals,
 * aggregates them with {@link summarizeRefreshActivity}, and renders
 * {@link RepositoryRefreshActivityCardView} with loading and error states.
 */
export function RepositoryRefreshActivityCard() {
  const [summary, setSummary] = useState<RefreshActivitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/repositories/refresh-activity', {
          credentials: 'include',
        });
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          signals?: RefreshActivitySignal[];
          error?: string;
        };
        if (!res.ok || data.success !== true) {
          throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
        }
        if (!cancelled) {
          setSummary(
            summarizeRefreshActivity(
              Array.isArray(data.signals) ? data.signals : [],
              Date.now(),
            ),
          );
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load refresh activity');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div
        data-testid="refresh-activity-loading"
        className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
        aria-busy
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading refresh activity…
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div
        data-testid="refresh-activity-error"
        className="rounded-lg border border-rose-200 bg-rose-50/80 p-4 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-300"
      >
        {error ?? 'Could not load refresh activity'}
      </div>
    );
  }

  return <RepositoryRefreshActivityCardView summary={summary} />;
}
