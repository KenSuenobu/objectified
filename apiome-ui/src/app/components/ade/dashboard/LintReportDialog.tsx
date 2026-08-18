'use client';

/**
 * Presentational dialog for a server-computed lint report (#3609, MFI-23.10; re-skinned
 * HIVE-5.8, #5311).
 *
 * Extracted from {@link VersionLintBadge} so the per-version badge and the Catalog card/detail lint
 * orbs render the *identical* report surface (score + A-F grade, severity counts, optional
 * stale-score note, and the itemized findings list with GOV-2.4 violation metadata). The component
 * is purely presentational: the caller owns fetching and passes the `report` (plus optional
 * `loading`/`error`/`onRetry` for the lazily-fetched catalog case). The grade/score are the
 * authoritative values computed by apiome-rest — this component never recomputes them.
 */

import { AlertCircle, ShieldCheck } from 'lucide-react';
import { Alert } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../ui/Dialog';
import { LoadingState } from '../../ui/LoadingState';
import { gradeBand } from '../../ui/statusVocabulary';
import { sortLintFindings, type VersionLintReport } from '../../../utils/version-lint-report';
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
          <LoadingState message="Loading lint report…" data-testid="lint-report-loading" />
        ) : error || !report ? (
          <Alert
            variant="error"
            data-testid="lint-report-error"
            icon={<AlertCircle className="mt-px size-4 shrink-0" aria-hidden />}
            actions={
              onRetry ? (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            <span>
              <strong>Lint report unavailable.</strong> {error || 'The report could not be read.'}
            </span>
          </Alert>
        ) : (
          /* `contents` keeps the compact layout exactly as before (children stay direct grid
             items); expanded turns this wrapper into the 1fr grid row as a flex column. */
          <div className={expanded ? 'flex min-h-0 flex-col' : 'contents'}>
            <div className="lr-headline">
              <span
                data-testid="lint-report-grade"
                className={`lr-grade ${gradeBand(displayLint!.grade).solidClass}`}
              >
                {displayLint!.grade}
              </span>
              <div className="lr-headline__text">
                <p className="lr-score">
                  Score <strong>{displayLint!.score}</strong>
                  <span className="lr-score__max">/100</span>
                </p>
                <div className="lr-headline__marks">
                  <Badge status="error">{severity.error ?? 0} error</Badge>
                  <Badge status="warning">{severity.warning ?? 0} warning</Badge>
                  <Badge status="info">{severity.info ?? 0} info</Badge>
                  {report.guideName ? (
                    <Badge variant="outline" data-testid="lint-report-guide-name">
                      <ShieldCheck aria-hidden />
                      Guide: {report.guideName}
                    </Badge>
                  ) : null}
                  {report.compatibilityOverall && (
                    <Badge variant="outline">
                      Compatibility vs base: {report.compatibilityOverall}
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {preferCapturedScore &&
            displayLint?.usesCaptured &&
            report.scoreIsStale &&
            (report.score !== displayLint.score || report.grade !== displayLint.grade) ? (
              <Alert
                variant="neutral"
                className="mt-2"
                data-testid="lint-report-live-recompute-note"
              >
                Converted OpenAPI lint of this item scores {report.grade} · {report.score}/100. The
                score above is the one captured when the source was imported.
              </Alert>
            ) : null}

            {!preferCapturedScore && report.scoreIsStale && (
              <Alert variant="warn" className="mt-2" data-testid="version-lint-stale-note">
                The stored quality score
                {report.capturedGrade && report.capturedScore != null
                  ? ` (${report.capturedGrade} · ${report.capturedScore})`
                  : ''}{' '}
                is out of date — this report was recomputed from the current revision.
              </Alert>
            )}

            <div
              className={
                expanded
                  ? 'lr-findings lr-findings--expanded'
                  : 'lr-findings'
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
