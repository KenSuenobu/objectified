/**
 * Multi-axis score/coverage — pure types & presentation helpers (CLX-1.2, #4849).
 *
 * Parses the CLX axis evaluation payload nested on lint reports (or GET …/lint/axes). The hard
 * rule: an axis that is not assessed is an explicit gap (`score: null`, `assessed: false`), never
 * a zero — so "not assessed" never renders as a clean bill of health.
 */

import { buildDocsHref } from './docsLinks';

export interface LintAxisSeverityCounts {
  error: number;
  warning: number;
  info: number;
}

export interface LintAxis {
  key: string;
  label: string;
  weight: number;
  assessed: boolean;
  score: number | null;
  grade: string | null;
  severityCounts: LintAxisSeverityCounts;
  coverageState: string;
  notAssessedReason: string | null;
}

export interface LintAxisEvaluation {
  algorithmId: string;
  algorithmVersion: string;
  /** Repository-relative docs page for the scoring algorithm (CLX-4.3). */
  algorithmDocsPage: string | null;
  axes: LintAxis[];
  compositeScore: number | null;
  compositeGrade: string | null;
  requiredCoverageMet: boolean;
  sourceReportFingerprint: string | null;
}

export type LintAxisBand = 'strong' | 'fair' | 'weak' | 'gap';

/** Default algorithm docs page when the API omits algorithmDocsPage (CLX-4.3). */
export const DEFAULT_ALGORITHM_DOCS_PAGE = 'docs/guide/axis-score.md';

/** Style-guide / policy docs linked from displayed policy versions (CLX-4.3). */
export const POLICY_DOCS_PAGE = 'docs/guide/lint-and-quality.md';

/** Build an external docs href for algorithm or policy documentation. */
export function buildGovernanceDocsHref(docsPage: string | null | undefined): string {
  return buildDocsHref(docsPage || DEFAULT_ALGORITHM_DOCS_PAGE);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asCounts(raw: unknown): LintAxisSeverityCounts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
  return { error: n(r.error), warning: n(r.warning), info: n(r.info) };
}

/** Parse one axis; forces a gap when assessed is false or the score is non-finite. */
export function lintAxisFromPayload(raw: unknown): LintAxis | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const key = asString(r.key);
  if (!key) return null;
  const wireAssessed = r.assessed === true;
  const score = asScore(r.score);
  // Gap discipline: assessed only when the wire says so AND the score is finite.
  const assessed = wireAssessed && score !== null;
  const coverage = (r.coverage ?? {}) as Record<string, unknown>;
  const coverageState =
    asString(coverage.state) ?? (assessed ? 'full' : 'none');
  return {
    key,
    label: asString(r.label) ?? key,
    weight: typeof r.weight === 'number' && Number.isFinite(r.weight) ? r.weight : 1,
    assessed,
    score: assessed ? score : null,
    grade: assessed ? asString(r.grade) : null,
    severityCounts: asCounts(r.severityCounts ?? r.severity_counts),
    coverageState,
    notAssessedReason: assessed
      ? null
      : asString(r.notAssessedReason ?? r.not_assessed_reason) ?? 'Not assessed',
  };
}

/** Parse a full evaluation dict (row or nested lint-report fields). */
export function lintAxisEvaluationFromPayload(raw: unknown): LintAxisEvaluation | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const axesRaw = Array.isArray(r.axes) ? r.axes : null;
  if (!axesRaw) return null;
  const axes = axesRaw
    .map(lintAxisFromPayload)
    .filter((a): a is LintAxis => a !== null);
  if (axes.length === 0) return null;

  const requiredCoverageMet = r.requiredCoverageMet === true || r.required_coverage_met === true;
  const compositeScore = asScore(r.compositeScore ?? r.composite_score);
  return {
    algorithmId: asString(r.algorithmId ?? r.algorithm_id) ?? 'clx-axis-v1',
    algorithmVersion: asString(r.algorithmVersion ?? r.algorithm_version) ?? '1',
    algorithmDocsPage:
      asString(r.algorithmDocsPage ?? r.algorithm_docs_page) ?? DEFAULT_ALGORITHM_DOCS_PAGE,
    axes,
    compositeScore: requiredCoverageMet ? compositeScore : null,
    compositeGrade: requiredCoverageMet
      ? asString(r.compositeGrade ?? r.composite_grade)
      : null,
    requiredCoverageMet,
    sourceReportFingerprint: asString(
      r.sourceReportFingerprint ?? r.source_report_fingerprint,
    ),
  };
}

/** Build an evaluation from fields nested on a lint report response. */
export function lintAxisEvaluationFromLintReport(
  report: Record<string, unknown> | null | undefined,
): LintAxisEvaluation | null {
  if (!report) return null;
  if (!Array.isArray(report.axes)) return null;
  return lintAxisEvaluationFromPayload({
    algorithmId: report.algorithmId ?? report.algorithm_id,
    algorithmVersion: report.algorithmVersion ?? report.algorithm_version ?? '1',
    algorithmDocsPage: report.algorithmDocsPage ?? report.algorithm_docs_page,
    axes: report.axes,
    compositeScore: report.compositeScore ?? report.composite_score,
    compositeGrade: report.compositeGrade ?? report.composite_grade,
    requiredCoverageMet: report.requiredCoverageMet ?? report.required_coverage_met,
    sourceReportFingerprint:
      report.sourceReportFingerprint ?? report.reportFingerprint ?? report.report_fingerprint,
  });
}

/** Score band for styling; gaps are never treated as a numeric band. */
export function lintAxisBand(axis: LintAxis): LintAxisBand {
  if (!axis.assessed || axis.score === null) return 'gap';
  if (axis.score >= 80) return 'strong';
  if (axis.score >= 60) return 'fair';
  return 'weak';
}

/** Display text for an axis score cell. */
export function lintAxisScoreLabel(axis: LintAxis): string {
  if (!axis.assessed || axis.score === null) return 'Not assessed';
  const grade = axis.grade ? ` · ${axis.grade}` : '';
  if (
    axis.severityCounts.error === 0 &&
    axis.severityCounts.warning === 0 &&
    axis.severityCounts.info === 0 &&
    axis.score === 100
  ) {
    return `100/100${grade} · No findings`;
  }
  return `${axis.score}/100${grade}`;
}

export function lintAxisCompositeLabel(evaluation: LintAxisEvaluation): string | null {
  if (!evaluation.requiredCoverageMet || evaluation.compositeScore === null) {
    return null;
  }
  const grade = evaluation.compositeGrade ? ` · ${evaluation.compositeGrade}` : '';
  return `${evaluation.compositeScore}/100${grade}`;
}
