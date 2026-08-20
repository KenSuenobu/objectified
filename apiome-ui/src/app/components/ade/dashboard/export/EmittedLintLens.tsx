/**
 * EmittedLintLens — the Verify workbench's emitted-artifact lint lens (MFX-42.3, #4356).
 *
 * MFX-5.2 lints the *emitted* artifact with the target format's lint packs (e.g. `spectral:oas`
 * for OpenAPI, `buf lint` for protobuf) and returns an advisory report. This lens renders it with
 * the same quality UX the import side gives the source's catalog lint (`CatalogLintPanel`,
 * MFI-25.5):
 *
 *  - a **score/grade chip** — the pack's 0–100 score and A–F letter grade, coloured by
 *    {@link gradeChipClass} exactly as the catalog gauge, when the pack computes one;
 *  - a **severity summary** — error / warning / info counts plus the distinct rules that fired;
 *  - the **findings grouped by severity** (error → warning → info, mirroring the catalog panel's
 *    MUST/SHOULD/advisory tiers), each with its rule id, category, message, and location — the same
 *    file/line/column the validation lens carries, which feeds MFX-43.3's Monaco markers;
 *  - an explicit **empty state** when no lint pack is registered for the target — never a
 *    misleading clean score.
 *
 * A short note distinguishes this *emitted-artifact* lint from the *source's* catalog lint, and —
 * when the Studio supplies one — links to the source's report so the two are never conflated.
 *
 * The lens is purely advisory: it never gates the export (the workbench's overall verdict owns the
 * Generate gate, MFX-42.1). Lint findings inform, they do not block.
 */

'use client';

import { AlertTriangle, ArrowUpRight, CheckCircle2, ExternalLink } from 'lucide-react';
import { FindingLocation } from './FindingLocation';
import type { LocatedProblem } from './exportProblemMarkers';
import {
  emittedLintLensState,
  emittedLintScore,
  groupLintFindingsBySeverity,
  lintRulesTriggered,
  lintSeverityCounts,
  type EmittedArtifactLintReport,
  type EmittedLintFinding,
} from './exportVerify';
import { type LintSeverity } from '../../../../utils/version-lint-report';
import { Badge } from '../../../ui/Badge';
import { GradeChip } from '../../../ui/catalog/GradeChip';

/** A pointer to the source's own (catalog) lint report, for the distinguishing note's link. */
export interface EmittedLintSourceReport {
  /** Where the source's lint report lives (e.g. its catalog detail's Lint &amp; Score tab). */
  href: string;
  /** The source's display name, used in the link label. */
  label: string;
}

export interface EmittedLintLensProps {
  /** The emitted-artifact lint report to render, or null when the endpoint ran no lint pass. */
  lint: EmittedArtifactLintReport | null;
  /** Human label of the export target (e.g. `gRPC / Protobuf`), used in the distinguishing note. */
  targetLabel?: string;
  /** The source's own lint report, linked from the distinguishing note; omitted when unknown. */
  sourceReport?: EmittedLintSourceReport | null;
  /**
   * The located problems that can open in the Review editor (MFX-43.3) — a finding whose problem
   * is in this list renders as a clickable row. Omitted (or absent from the list) findings stay
   * plain: location-less findings are list-only, and nothing is clickable before an artifact
   * exists to open.
   */
  openableProblems?: LocatedProblem[];
  /** Open a located finding in the Review editor (file + line), MFX-43.3. */
  onOpenProblem?: (problem: LocatedProblem) => void;
}

/** Section heading copy per severity, matching the catalog panel's tiered sections. */
const SEVERITY_HEADING: Record<LintSeverity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
};

/**
 * A severity chip: `3 errors` with a count, or a bare `error` tag on a single finding.
 *
 * The tone comes from the shared vocabulary through `Badge`, which is what makes a warning
 * here the same amber as a warning in the workspace lint queue — the migration HIVE-5.8 made
 * for the same three severities.
 */
function SeverityChip({ severity, count }: { severity: LintSeverity; count?: number }) {
  if (typeof count === 'number' && count === 0) return null;
  const label =
    typeof count === 'number' ? `${count} ${severity}${count === 1 ? '' : 's'}` : severity;
  return (
    <Badge status={severity} className="capitalize">
      {label}
    </Badge>
  );
}

/**
 * One finding row: severity + rule id + category, its message, and its location line. When the
 * finding's located problem is openable (MFX-43.3) the row is a button that jumps to its file +
 * line in the Review editor.
 */
function LintFindingRow({
  finding,
  problem,
  onOpenProblem,
}: {
  finding: EmittedLintFinding;
  problem: LocatedProblem | null;
  onOpenProblem?: (problem: LocatedProblem) => void;
}) {
  const content = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityChip severity={finding.severity} />
        <code className="xstd-quiet">{finding.rule}</code>
        {finding.category && <span className="xstd-rule-chip">{finding.category}</span>}
      </div>
      <div className="mt-1 xstd-finding__message">{finding.message}</div>
      <FindingLocation
        file={finding.file}
        path={finding.path}
        line={finding.line}
        column={finding.column}
      />
    </>
  );
  return (
    <li className="xstd-finding">
      {problem && onOpenProblem ? (
        <button
          type="button"
          data-testid={`verify-open-${problem.id}`}
          title="Open in the Review editor"
          onClick={() => onOpenProblem(problem)}
          className="xstd-finding__button"
        >
          {content}
          <ExternalLink className="xstd-finding__open" aria-hidden />
          <span className="sr-only">Open in the Review editor</span>
        </button>
      ) : (
        <div className="p-3">{content}</div>
      )}
    </li>
  );
}

/**
 * EmittedLintLens — renders one emitted-artifact lint report (MFX-42.3).
 *
 * Leads with the score/grade + severity summary, then the findings grouped by severity — or an
 * explicit empty state when no lint pack applies to the target.
 */
export function EmittedLintLens({
  lint,
  targetLabel,
  sourceReport,
  openableProblems,
  onOpenProblem,
}: EmittedLintLensProps) {
  const state = emittedLintLensState(lint);

  // No lint pack for this target: an explicit empty state, never a misleading clean score.
  if (state === 'not_applicable') {
    return (
      <p className="xstd-quiet" data-testid="verify-lint-empty">
        No lint pack is registered for {targetLabel ? <strong>{targetLabel}</strong> : 'this target'}
        {' '}— there is nothing to lint. The export is not blocked by lint.
      </p>
    );
  }

  // From here the report is applicable; `lint` is non-null (narrowed by the state above).
  const report = lint as EmittedArtifactLintReport;
  const counts = lintSeverityCounts(report.findings);
  const score = emittedLintScore(report);
  const groups = groupLintFindingsBySeverity(report.findings);
  const rules = lintRulesTriggered(report.findings);

  return (
    <div className="space-y-3" data-testid="verify-lint" data-lint-state={state}>
      {/* Distinguishing note: this is the emitted artifact's lint, not the source's catalog lint. */}
      <p
        className="xstd-quiet flex items-start gap-1.5"
        data-testid="verify-lint-source-note"
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          These findings lint the <strong>emitted {targetLabel ?? 'artifact'}</strong>
          {report.pack ? (
            <>
              {' '}with <code className="font-mono">{report.pack}</code>
            </>
          ) : null}
          — not the source&apos;s catalog lint.
          {sourceReport && (
            <>
              {' '}
              <a
                href={sourceReport.href}
                data-testid="verify-lint-source-link"
                className="xstd-link inline-flex items-center gap-0.5"
              >
                View {sourceReport.label}&apos;s lint report
                <ArrowUpRight className="h-3 w-3" aria-hidden />
              </a>
            </>
          )}
        </span>
      </p>

      {/* Score/grade + severity summary chips. */}
      <div className="flex flex-wrap items-center gap-2">
        {score && (
          <span className="flex items-center gap-1.5" data-testid="verify-lint-grade">
            <GradeChip grade={score.grade} />{' '}
            <span className="xstd-quiet">· {score.score}/100</span>
          </span>
        )}
        <SeverityChip severity="error" count={counts.error} />
        <SeverityChip severity="warning" count={counts.warning} />
        <SeverityChip severity="info" count={counts.info} />
        {rules > 0 && (
          <span className="xstd-quiet" data-testid="verify-lint-rules">
            {rules} rule{rules === 1 ? '' : 's'} triggered
          </span>
        )}
      </div>

      {/* Clean: a positive confirmation (never left as an empty panel). */}
      {state === 'clean' ? (
        <p className="xstd-lens-head" data-tone="ok" data-testid="verify-lint-clean">
          <CheckCircle2 aria-hidden />
          The lint pack reported no findings.
        </p>
      ) : (
        // Findings grouped by severity (error → warning → info), each section labelled with its
        // count — mirroring the catalog lint panel's MUST/SHOULD/advisory sections.
        <div className="space-y-4" data-testid="verify-lint-findings">
          {groups.map((group) => (
            <section key={group.severity} data-testid={`verify-lint-group-${group.severity}`}>
              <h4 className="xstd-caps mb-2">
                {SEVERITY_HEADING[group.severity]}
                <span className="tabular-nums" data-testid={`verify-lint-group-count-${group.severity}`}>
                  {group.findings.length}
                </span>
              </h4>
              <ul className="space-y-2">
                {group.findings.map((finding, idx) => (
                  <LintFindingRow
                    key={`${finding.rule}-${idx}`}
                    finding={finding}
                    problem={openableProblems?.find((p) => p.finding === finding) ?? null}
                    onOpenProblem={onOpenProblem}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default EmittedLintLens;
