'use client';

/**
 * Server-backed quality/lint badge for a single version (#3609, #5259).
 *
 * The grade shown here is computed by apiome-rest — the authoritative source of truth, not
 * client-side localStorage scoring. Since #5259 the badge renders from the score/grade **stored
 * on the version record** (carried by the versions list payload) and never fetches on mount:
 * a list of 50 versions issues zero lint requests. The full report (`GET .../lint`) is fetched
 * lazily — only when the badge is clicked — and the server serves the stored report or re-lints
 * once when the revision's content changed, persisting the result. A revision that has never
 * been scored shows a neutral "Lint —" chip; clicking it lints (and stores) the score on demand.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { badgeVariants } from '../../ui/Badge';
import { gradeBand } from '../../ui/statusVocabulary';
import { cn } from '../../../../../lib/utils';
import { LintReportDialog } from './LintReportDialog';
import { fetchVersionLintReport, type VersionLintReport } from '../../../utils/version-lint-report';

interface VersionLintBadgeProps {
  projectId: string;
  versionId: string;
  /** Human-readable version label for the dialog title (e.g. "1.0.0"). */
  versionLabel?: string;
  /** Quality score stored on the version record (`qualityScore`); null/undefined = not scored yet. */
  storedScore?: number | null;
  /** A-F grade stored on the version record (`qualityGrade`); null/undefined = not scored yet. */
  storedGrade?: string | null;
}

/** The headline the chip renders: the stored record values, or a fetched report's values. */
export interface LintHeadline {
  score: number;
  grade: string;
}

/**
 * The chip is a `Badge`-shaped `<button>` (HIVE-6.2, #5313): the tone comes from the shared
 * A–F bands in `ui/statusVocabulary`, so this B is the same green as the catalog's B, and the
 * unscored chip is the vocabulary's outline. `ver-lint-badge` (globals.css) adds only the
 * cursor and the hover lift a button needs and a badge does not.
 */
const chipBaseClass = 'ver-lint-badge focus-visible:outline-none';

/**
 * Resolve the chip headline from the stored record values and an optionally fetched report.
 * A fetched report wins (it is at least as fresh as the record); otherwise the stored values are
 * used when both are present; otherwise there is no headline (unscored).
 */
export function resolveLintHeadline(
  storedScore: number | null | undefined,
  storedGrade: string | null | undefined,
  report: VersionLintReport | null
): LintHeadline | null {
  if (report) return { score: report.score, grade: report.grade };
  if (storedScore != null && storedGrade) return { score: storedScore, grade: storedGrade };
  return null;
}

export function VersionLintBadge({
  projectId,
  versionId,
  versionLabel,
  storedScore,
  storedGrade,
}: VersionLintBadgeProps) {
  const [report, setReport] = useState<VersionLintReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Fetch the full report — only ever invoked from a click / retry / dialog open, never on mount.
  const runFetch = useCallback(
    (controller: AbortController) =>
      fetchVersionLintReport(projectId, versionId, { signal: controller.signal })
        .then((r) => {
          if (!controller.signal.aborted) {
            setReport(r);
            setLoading(false);
          }
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : 'Failed to load lint report');
          setLoading(false);
        }),
    [projectId, versionId]
  );

  // Event-handler seam (click / retry): reset the fetch state synchronously and start a fetch.
  const startFetch = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    void runFetch(controller);
  }, [runFetch]);

  // Open the report; fetch it lazily the first time (a held report is reused on re-open).
  const openReport = useCallback(() => {
    setOpen(true);
    if (!report && !loading) startFetch();
  }, [report, loading, startFetch]);

  // Abort an in-flight fetch on unmount (rows are keyed by revision id, so a badge never
  // changes identity while mounted).
  useEffect(() => () => abortRef.current?.abort(), []);

  const headline = resolveLintHeadline(storedScore, storedGrade, report);

  const dialog = (
    <LintReportDialog
      open={open}
      onOpenChange={setOpen}
      title={`Quality & Lint report${versionLabel ? ` — v${versionLabel}` : ''}`}
      description="Server-computed quality score and itemized findings for this version."
      report={report}
      loading={loading}
      error={error}
      onRetry={startFetch}
      preferenceView="studio-lint"
    />
  );

  if (!headline) {
    return (
      <>
        <button
          type="button"
          onClick={openReport}
          className={cn(badgeVariants({ variant: 'outline' }), chipBaseClass)}
          title="Not scored yet — click to lint this version"
          data-testid="version-lint-badge-unscored"
        >
          Lint —
        </button>
        {dialog}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={openReport}
        className={cn(badgeVariants({ variant: gradeBand(headline.grade).tone }), chipBaseClass)}
        title={`Quality score ${headline.score}/100 — open lint report`}
        data-testid="version-lint-badge"
      >
        <ShieldCheck aria-hidden />
        {headline.grade} · {headline.score}
      </button>
      {dialog}
    </>
  );
}
