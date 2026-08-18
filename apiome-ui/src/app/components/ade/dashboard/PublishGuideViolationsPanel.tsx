'use client';

/**
 * Style-guide violation summary for the publish dialog (GOV-2.5, #4437).
 *
 * Loads the server lint report for the revision being published and surfaces per-severity
 * counts plus an expandable list of error-level violations (rule id + location).
 *
 * Re-skinned in place by HIVE-6.2 (#5313) to `docs/mockups/build/versions.html`'s first
 * publish gate (`.gate`): the titled head with the three severity badges, the guide line, the
 * blocking banner and the *Blocking error violations (n)* disclosure. What it loads, what it
 * reports through `onReportChange` and when it blocks are unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpenCheck, ChevronDown, ChevronRight } from 'lucide-react';
import { Alert } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { LoadingState } from '../../ui/LoadingState';
import { fetchVersionLintReport, type VersionLintReport } from '@/app/utils/version-lint-report';

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
  // Held in a ref, and synced in an effect rather than during render, so a parent that
  // recreates the callback every render cannot retrigger the fetch in a loop.
  const onReportChangeRef = useRef(onReportChange);
  useEffect(() => {
    onReportChangeRef.current = onReportChange;
  }, [onReportChange]);

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
    // The fetch flips `loading` before it awaits, which the lint rule reads as a setState in an
    // effect. That is the intended behavior for a load-on-open panel: the dialog must show the
    // spinner immediately, and the in-flight request is aborted on close by the cleanup below.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-open fetch, aborted on close
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
      <div className="ver-gate" data-testid="publish-guide-violations-loading">
        <div className="ver-gate__head">
          <h3 className="ver-gate__title">
            <BookOpenCheck aria-hidden />
            Style guide
          </h3>
        </div>
        <LoadingState
          className="ver-gate__loading"
          minHeightClassName="min-h-0"
          spinnerSize="sm"
          message="Checking style-guide violations…"
        />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="warning" data-testid="publish-guide-violations-error">
        Could not load style-guide violations: {error}
      </Alert>
    );
  }

  if (!report) return null;

  return (
    <div className="ver-gate" data-testid="publish-guide-violations-panel">
      <div className="ver-gate__head">
        <h3 className="ver-gate__title">
          <BookOpenCheck aria-hidden />
          Style guide
        </h3>
        <span className="ver-gate__badges">
          <Badge status="error">
            {errorCount} error{errorCount === 1 ? '' : 's'}
          </Badge>
          <Badge status="warning">
            {warnCount} warning{warnCount === 1 ? '' : 's'}
          </Badge>
          <Badge status="info">{infoCount} info</Badge>
        </span>
      </div>
      <p className="ver-gate__sub">
        Violations under <span className="ver-gate__em">{guideName}</span>
      </p>

      {errorCount > 0 ? (
        <Alert variant="error" className="ver-gate__banner">
          {errorCount} error-level violation{errorCount === 1 ? '' : 's'} block publishing. Fix them
          or use force publish with a reason.
        </Alert>
      ) : warnCount > 0 || infoCount > 0 ? (
        <p className="ver-gate__note">Only warnings or info remain — publishing is allowed.</p>
      ) : (
        <p className="ver-gate__note">No style-guide violations.</p>
      )}

      {errorCount > 0 && (
        <div className="ver-gate__disclosure">
          <button
            type="button"
            className="ver-gate__toggle"
            onClick={() => setErrorsExpanded((v) => !v)}
            aria-expanded={errorsExpanded}
            data-testid="publish-guide-errors-toggle"
          >
            {errorsExpanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            Blocking error violations ({errorCount})
          </button>
          {errorsExpanded && (
            <ul className="ver-gate__findings">
              {errorFindings.map((finding) => (
                <li key={finding.id} className="ver-gate__finding" data-testid="publish-guide-error-finding">
                  <span className="ver-gate__tag mono">{finding.rule}</span>
                  {finding.path ? <span className="ver-gate__path mono">{finding.path}</span> : null}
                  <span className="ver-gate__message">{finding.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
