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
import { Badge } from '@/app/components/ui/Badge';
import { VERSION_DIALOG_COPY } from '@/app/components/ade/version-dialogs/versionDialogsModel';
import {
  verdictDiffLabel,
  verdictTone,
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
      <p className="vdlg-bench__status" data-tone="warn" data-testid="suite-history-error">
        {error}
      </p>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="vdlg-quiet" data-testid="suite-history-empty">
        {VERSION_DIALOG_COPY.benchNoRuns}
      </p>
    );
  }

  return (
    <ul className="vdlg-bench__list" data-testid="suite-history-list">
      {runs.map((run) => {
        const expanded = expandedRunId === run.id;
        const detail = details[run.id];
        const label = run.resolved_version_label || run.requested_ref;
        return (
          <li key={run.id} className="vdlg-bench__run">
            <button
              type="button"
              data-testid={`suite-run-row-${run.id}`}
              onClick={() => void toggleRun(run.id)}
              aria-expanded={expanded}
              className="vdlg-bench__run-head"
            >
              {expanded ? (
                <ChevronDown className="vdlg-bench__chevron" aria-hidden />
              ) : (
                <ChevronRight className="vdlg-bench__chevron" aria-hidden />
              )}
              <span className="vdlg-bench__run-label mono">{label}</span>
              {run.status === 'error' ? (
                <Badge variant={verdictTone('error')}>error</Badge>
              ) : (
                <span className="vdlg-bench__run-count">
                  {run.passed}/{run.total} passed
                </span>
              )}
              {run.regression ? (
                <Badge variant={verdictTone('failed')} data-testid={`suite-run-regression-${run.id}`}>
                  <TrendingDown aria-hidden /> regression
                </Badge>
              ) : null}
              {run.created_at ? (
                <span className="vdlg-bench__list-date">
                  {new Date(run.created_at).toLocaleString()}
                </span>
              ) : null}
            </button>

            {expanded ? (
              <div className="vdlg-bench__run-body">
                {run.status === 'error' ? (
                  <p className="vdlg-bench__status" data-tone="warn">
                    {run.message || 'The suite could not run against this revision.'}
                  </p>
                ) : detail ? (
                  <ul className="vdlg-bench__results" data-testid={`suite-run-results-${run.id}`}>
                    {detail.results.map((result) => (
                      <li
                        key={result.payload_name}
                        data-testid={
                          result.regression ? 'suite-result-regression' : undefined
                        }
                        className="vdlg-bench__result"
                        data-regression={result.regression || undefined}
                      >
                        <span className="vdlg-bench__result-name">{result.payload_name}</span>
                        <Badge variant={verdictTone(result.status)}>{verdictDiffLabel(result)}</Badge>
                        {result.message ? (
                          <span className="vdlg-bench__result-message">{result.message}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="vdlg-quiet">Loading results…</p>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
