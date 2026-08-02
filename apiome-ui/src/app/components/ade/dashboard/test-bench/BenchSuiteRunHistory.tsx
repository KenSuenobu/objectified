'use client';

/**
 * BenchSuiteRunHistory (IXH-5.7, #5119).
 *
 * One suite's run history: each run as a row (revision, verdict counts, regression flag),
 * expandable to its per-payload results. A result row shows the verdict diff against the
 * baseline run (`passed → failed`) and highlights regressions, which is the ticket's core
 * surface: a revision that broke a previously-passing payload must be visible at a glance.
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, TrendingDown } from 'lucide-react';
import {
  verdictDiffLabel,
  verdictToneClass,
  type SuiteRunDetail,
  type SuiteRunSummary,
} from '@/app/utils/schema-test-suites';

export interface BenchSuiteRunHistoryProps {
  /** The suite whose history is shown. */
  suiteId: string;
  /** Bumped by the parent whenever a new run lands, to refetch. */
  refreshToken: number;
}

/** Render the run history list with expandable per-payload results. */
export function BenchSuiteRunHistory({ suiteId, refreshToken }: BenchSuiteRunHistoryProps) {
  const [runs, setRuns] = useState<SuiteRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SuiteRunDetail>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/schemas/suites/${encodeURIComponent(suiteId)}/runs`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.success) {
          setError(typeof data.error === 'string' ? data.error : 'Could not load run history.');
          return;
        }
        setError(null);
        setRuns(Array.isArray(data.items) ? data.items : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load run history.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [suiteId, refreshToken]);

  const toggleRun = useCallback(
    async (runId: string) => {
      if (expandedRunId === runId) {
        setExpandedRunId(null);
        return;
      }
      setExpandedRunId(runId);
      if (details[runId]) return;
      try {
        const res = await fetch(
          `/api/schemas/suites/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}`
        );
        const data = await res.json();
        if (res.ok && data.success) {
          setDetails((previous) => ({ ...previous, [runId]: data as SuiteRunDetail }));
        }
      } catch {
        // The summary row still renders; the expansion just stays empty.
      }
    },
    [expandedRunId, details, suiteId]
  );

  if (error) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="suite-history-error">
        {error}
      </p>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="suite-history-empty">
        No runs recorded yet — run the suite against a revision to start its history.
      </p>
    );
  }

  return (
    <ul className="space-y-1" data-testid="suite-history-list">
      {runs.map((run) => {
        const expanded = expandedRunId === run.id;
        const detail = details[run.id];
        const label = run.resolved_version_label || run.requested_ref;
        return (
          <li key={run.id} className="rounded-md border border-gray-100 dark:border-gray-800">
            <button
              type="button"
              data-testid={`suite-run-row-${run.id}`}
              onClick={() => void toggleRun(run.id)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-800/60"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-gray-600 dark:text-gray-300">
                {label}
              </span>
              {run.status === 'error' ? (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${verdictToneClass('error')}`}
                >
                  error
                </span>
              ) : (
                <span className="tabular-nums text-gray-500 dark:text-gray-400">
                  {run.passed}/{run.total} passed
                </span>
              )}
              {run.regression ? (
                <span
                  data-testid={`suite-run-regression-${run.id}`}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${verdictToneClass('failed')}`}
                >
                  <TrendingDown className="h-3 w-3" aria-hidden /> regression
                </span>
              ) : null}
              {run.created_at ? (
                <span className="shrink-0 tabular-nums text-[10px] text-gray-400 dark:text-gray-500">
                  {new Date(run.created_at).toLocaleString()}
                </span>
              ) : null}
            </button>

            {expanded ? (
              <div className="border-t border-gray-100 px-2 py-1.5 dark:border-gray-800">
                {run.status === 'error' ? (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {run.message || 'The suite could not run against this revision.'}
                  </p>
                ) : detail ? (
                  <ul className="space-y-1" data-testid={`suite-run-results-${run.id}`}>
                    {detail.results.map((result) => (
                      <li
                        key={result.payload_name}
                        data-testid={
                          result.regression ? 'suite-result-regression' : undefined
                        }
                        className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${
                          result.regression
                            ? 'bg-rose-50 dark:bg-rose-950/40'
                            : ''
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
                          {result.payload_name}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${verdictToneClass(result.status)}`}
                        >
                          {verdictDiffLabel(result)}
                        </span>
                        {result.message ? (
                          <span className="min-w-0 max-w-[50%] truncate text-gray-500 dark:text-gray-400">
                            {result.message}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-gray-500 dark:text-gray-400">Loading results…</p>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
