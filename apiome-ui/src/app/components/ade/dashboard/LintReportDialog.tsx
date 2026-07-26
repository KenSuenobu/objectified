'use client';

/**
 * Presentational dialog for a server-computed lint report (#3609, MFI-23.10).
 *
 * Extracted from {@link VersionLintBadge} so the per-version badge and the Catalog card/detail lint
 * orbs render the *identical* report surface (score + A-F grade, severity counts, optional
 * stale-score note, and the itemized findings list with GOV-2.4 violation metadata). The component
 * is purely presentational: the caller owns fetching and passes the `report` (plus optional
 * `loading`/`error`/`onRetry` for the lazily-fetched catalog case). The grade/score are the
 * authoritative values computed by apiome-rest — this component never recomputes them.
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../ui/Dialog';
import {
  gradeChipClass,
  severityBadgeClass,
  sortLintFindings,
  type VersionLintReport,
} from '../../../utils/version-lint-report';
import { catalogDisplayLintScore } from '../../../utils/catalog-lint-panel';
import type { LintViolationDisplayView } from '../../../utils/lint-violation-display-preferences';
import {
  LintViolationFindingsList,
  lintReportGuideContext,
} from './lint/LintViolationFindingsList';

interface LintReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog title (e.g. "Quality & Lint report — v1.0.0"). */
  title: string;
  /** Optional sub-line under the title. */
  description?: string;
  /** The server lint report, or null while loading / on error. */
  report: VersionLintReport | null;
  /** True while the report is being fetched (catalog lazy-fetch). */
  loading?: boolean;
  /** A fetch error message, when the report could not be loaded. */
  error?: string | null;
  /** Retry handler shown alongside an error, when provided. */
  onRetry?: () => void;
  /** Which surface's group-by-rule preference to use (GOV-2.4). */
  preferenceView?: LintViolationDisplayView;
  /**
   * Catalog surfaces prefer the import-captured score when present — non-OpenAPI items are scored on
   * their native model at import, while the live OpenAPI recompute in the same payload can differ.
   */
  preferCapturedScore?: boolean;
  /**
   * Fill the screen: the dialog is pinned to 90vh (and widened) with the findings list flexing to
   * consume all remaining height, instead of the compact `max-w-3xl` / 50vh-capped default. Used by
   * the catalog "Open full report" surface, where reading room matters more than compactness.
   */
  expanded?: boolean;
}

/**
 * Render a server lint report inside a dialog. Shows a loading line, an error + retry affordance, or
 * the score header and itemized findings depending on the caller's fetch state.
 */
export function LintReportDialog({
  open,
  onOpenChange,
  title,
  description,
  report,
  loading = false,
  error = null,
  onRetry,
  preferenceView = 'catalog-lint',
  preferCapturedScore = false,
  expanded = false,
}: LintReportDialogProps) {
  const findings = report ? sortLintFindings(report.findings) : [];
  const severity = report?.severityCounts ?? {};
  const guide = lintReportGuideContext(report);
  const displayLint = report
    ? preferCapturedScore
      ? catalogDisplayLintScore(report)
      : { score: report.score, grade: report.grade, usesCaptured: false }
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Expanded: 90vh tall + widened, with the header row auto-sized and the body row taking all
          remaining height (the DialogContent is a grid), so the findings list can flex-fill. */}
      <DialogContent
        className={
          expanded
            ? 'h-[90vh] max-w-6xl grid-rows-[auto_minmax(0,1fr)]'
            : 'max-w-3xl'
        }
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {loading ? (
          <p
            className="py-8 text-center text-sm text-gray-500 dark:text-gray-400"
            data-testid="lint-report-loading"
          >
            Loading lint report…
          </p>
        ) : error || !report ? (
          <div
            className="flex flex-col items-center gap-3 py-8 text-center"
            data-testid="lint-report-error"
          >
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {error || 'Lint report unavailable.'}
            </p>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : (
          /* `contents` keeps the compact layout exactly as before (children stay direct grid
             items); expanded turns this wrapper into the 1fr grid row as a flex column. */
          <div className={expanded ? 'flex min-h-0 flex-col' : 'contents'}>
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-lg font-bold ${gradeChipClass(
                  displayLint!.grade,
                )}`}
              >
                {displayLint!.grade}
              </span>
              <span className="text-sm text-gray-600 dark:text-gray-300">
                Score <span className="font-semibold">{displayLint!.score}</span>/100
              </span>
              <span className="flex items-center gap-2 text-xs">
                <span className={`rounded px-1.5 py-0.5 ${severityBadgeClass('error')}`}>
                  {severity.error ?? 0} error
                </span>
                <span className={`rounded px-1.5 py-0.5 ${severityBadgeClass('warning')}`}>
                  {severity.warning ?? 0} warning
                </span>
                <span className={`rounded px-1.5 py-0.5 ${severityBadgeClass('info')}`}>
                  {severity.info ?? 0} info
                </span>
              </span>
              {report.guideName ? (
                <span
                  data-testid="lint-report-guide-name"
                  className="rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200"
                >
                  Guide: {report.guideName}
                </span>
              ) : null}
              {report.compatibilityOverall && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Compatibility vs base: {report.compatibilityOverall}
                </span>
              )}
            </div>

            {preferCapturedScore &&
            displayLint?.usesCaptured &&
            report.scoreIsStale &&
            (report.score !== displayLint.score || report.grade !== displayLint.grade) ? (
              <p
                className="mt-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-300"
                data-testid="lint-report-live-recompute-note"
              >
                Converted OpenAPI lint of this item scores {report.grade} · {report.score}/100. The
                score above is the one captured when the source was imported.
              </p>
            ) : null}

            {!preferCapturedScore && report.scoreIsStale && (
              <p
                className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                data-testid="version-lint-stale-note"
              >
                The stored quality score
                {report.capturedGrade && report.capturedScore != null
                  ? ` (${report.capturedGrade} · ${report.capturedScore})`
                  : ''}{' '}
                is out of date — this report was recomputed from the current revision.
              </p>
            )}

            <div
              className={
                expanded
                  ? 'mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-200 p-4 dark:border-gray-700'
                  : 'mt-3 max-h-[50vh] overflow-y-auto rounded-lg border border-gray-200 p-4 dark:border-gray-700'
              }
              data-testid="lint-report-findings-scroll"
            >
              <LintViolationFindingsList
                findings={findings}
                guideName={guide.guideName}
                guideId={guide.guideId}
                preferenceView={preferenceView}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
