'use client';

/**
 * Style-guide violation summary for the publish dialog (GOV-2.5, #4437).
 *
 * Loads the server lint report for the revision being published and surfaces per-severity
 * counts plus an expandable list of error-level violations (rule id + location).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Alert } from '../../ui/Alert';
import { LoadingState } from '../../ui/LoadingState';
import {
  fetchVersionLintReport,
  severityBadgeClass,
  type VersionLintReport,
} from '@/app/utils/version-lint-report';

export interface PublishGuideViolationsPanelProps {
  projectId: string;
  versionId: string;
  /** Called when the lint report finishes loading (or fails). */
  onReportChange?: (report: VersionLintReport | null, error: string | null) => void;
}

function severityCount(counts: Record<string, number>, key: string): number {
  return counts[key] ?? 0;
}

/**
 * Render the guide-violation summary strip and expandable error list for publish.
 */
export function PublishGuideViolationsPanel({
  projectId,
  versionId,
  onReportChange,
}: PublishGuideViolationsPanelProps) {
  const [report, setReport] = useState<VersionLintReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const onReportChangeRef = useRef(onReportChange);
  onReportChangeRef.current = onReportChange;

  const loadReport = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    void fetchVersionLintReport(projectId, versionId, { signal: controller.signal })
      .then((r) => {
        if (controller.signal.aborted) return;
        setReport(r);
        setLoading(false);
        onReportChangeRef.current?.(r, null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        const message = e instanceof Error ? e.message : 'Failed to load style-guide report';
        setReport(null);
        setError(message);
        setLoading(false);
        onReportChangeRef.current?.(null, message);
      });
  }, [projectId, versionId]);

  useEffect(() => {
    loadReport();
    return () => abortRef.current?.abort();
  }, [loadReport]);

  const errorFindings = useMemo(
    () => (report?.findings ?? []).filter((f) => f.severity === 'error'),
    [report],
  );

  const severityCounts = report?.severityCounts ?? {};
  const errorCount = severityCount(severityCounts, 'error');
  const warnCount = severityCount(severityCounts, 'warning');
  const infoCount = severityCount(severityCounts, 'info');
  const guideName = report?.guideName ?? 'style guide';

  if (loading) {
    return (
      <LoadingState
        className="py-4"
        minHeightClassName="min-h-0"
        spinnerSize="sm"
        message="Checking style-guide violations…"
      />
    );
  }

  if (error) {
    return (
      <Alert variant="warning" className="text-sm" data-testid="publish-guide-violations-error">
        Could not load style-guide violations: {error}
      </Alert>
    );
  }

  if (!report) return null;

  return (
    <div
      className="space-y-3 rounded-lg border border-gray-200 bg-gray-50/80 p-4 dark:border-gray-700 dark:bg-gray-900/40"
      data-testid="publish-guide-violations-panel"
    >
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Style guide</h3>
        <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
          Violations under <span className="font-medium">{guideName}</span>
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className={`rounded-md px-2 py-0.5 font-medium ${severityBadgeClass('error')}`}>
          {errorCount} error{errorCount === 1 ? '' : 's'}
        </span>
        <span className={`rounded-md px-2 py-0.5 font-medium ${severityBadgeClass('warning')}`}>
          {warnCount} warning{warnCount === 1 ? '' : 's'}
        </span>
        <span className={`rounded-md px-2 py-0.5 font-medium ${severityBadgeClass('info')}`}>
          {infoCount} info
        </span>
      </div>

      {errorCount > 0 ? (
        <Alert variant="error" className="text-sm">
          {errorCount} error-level violation{errorCount === 1 ? '' : 's'} block publishing. Fix them
          or use force publish with a reason.
        </Alert>
      ) : warnCount > 0 || infoCount > 0 ? (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Only warnings or info remain — publishing is allowed.
        </p>
      ) : (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">No style-guide violations.</p>
      )}

      {errorCount > 0 && (
        <div className="rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900/60">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-800 dark:text-gray-200"
            onClick={() => setErrorsExpanded((v) => !v)}
            aria-expanded={errorsExpanded}
            data-testid="publish-guide-errors-toggle"
          >
            {errorsExpanded ? (
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
            )}
            Blocking error violations ({errorCount})
          </button>
          {errorsExpanded && (
            <ul className="max-h-48 space-y-2 overflow-y-auto border-t border-gray-200 px-3 py-2 dark:border-gray-700">
              {errorFindings.map((finding) => (
                <li
                  key={finding.id}
                  className="text-xs text-gray-700 dark:text-gray-300"
                  data-testid="publish-guide-error-finding"
                >
                  <span className="font-mono text-2xs text-indigo-700 dark:text-indigo-300">
                    {finding.rule}
                  </span>
                  {finding.path ? (
                    <span className="mt-0.5 block font-mono text-2xs text-gray-500 dark:text-gray-400">
                      {finding.path}
                    </span>
                  ) : null}
                  <span className="mt-0.5 block text-gray-600 dark:text-gray-400">
                    {finding.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
