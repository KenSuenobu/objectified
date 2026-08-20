/**
 * ValidationResultsLens — the Verify workbench's emitted-output validation lens (MFX-42.2, #4355).
 *
 * MFX-5.1/5.3 re-parse the emitted artifact with the target format's own toolchain (`buf build`
 * for protobuf, `xmlschema` for XSD, the Postman collection schema, …) and produce a structured
 * verdict. This lens renders that verdict:
 *
 *  - the overall band as a toned headline (valid / invalid / toolchain-unavailable / not-applicable),
 *    naming the validator that ran (or would have run);
 *  - for a rejection, the structured error list — message plus file-in-bundle, JSON pointer, and
 *    line/column wherever the validator supplies them (these locations feed MFX-43.3's markers);
 *  - external-toolchain unavailability as an explicit **warning** ("validator not installed on the
 *    server"), never a silent pass — so a skipped validation is visibly not the same as a clean one;
 *  - a positive verdict when the artifact re-parsed with zero errors.
 *
 * The lens itself never gates the export — the workbench's overall verdict (MFX-42.1) owns the
 * Generate gate; a rejection here is what drives an `invalid` band there.
 */

import { CheckCircle2, ExternalLink, FileWarning, Gauge, ShieldCheck, ShieldX, Wrench } from 'lucide-react';
import { FindingLocation } from './FindingLocation';
import type { LocatedProblem } from './exportProblemMarkers';
import { validationToneName } from '@/app/components/ade/export-studio';
import {
  validationLensState,
  validationLensTone,
  validatorToolLabel,
  type EmittedValidationReport,
} from './exportVerify';

export interface ValidationResultsLensProps {
  /** The emitted-output validation report to render (mirrors REST `EmittedValidationReport`). */
  validation: EmittedValidationReport;
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

/**
 * ValidationResultsLens — renders one emitted-output validation report (MFX-42.2).
 *
 * Leads with a toned headline (and the validator identity when known), then branches by state:
 * an invalid verdict lists the structured errors with their locations; a toolchain-unavailable
 * verdict shows a distinct warning callout; a clean verdict shows a positive confirmation.
 * Findings whose located problem is openable (MFX-43.3) render as clickable rows that jump to
 * their file + line in the Review editor.
 */
export function ValidationResultsLens({
  validation,
  openableProblems,
  onOpenProblem,
}: ValidationResultsLensProps) {
  const state = validationLensState(validation);
  const tone = validationLensTone(state);
  // Select an existing icon component by tone (assigned, not created — the ternary keeps each
  // branch a static component reference so it survives re-renders without resetting state).
  const Icon = tone === 'invalid' ? ShieldX : tone === 'warn' ? FileWarning : tone === 'ok' ? ShieldCheck : Gauge;
  const tool = validatorToolLabel(validation);

  return (
    <div className="space-y-3" data-testid="verify-validation" data-validation-state={state}>
      {/* The overall verdict headline: band + message, plus the validator identity when known. */}
      <div className="flex items-start gap-2">
        <div className="space-y-0.5">
          {/* The tone lands on the glyph, never on the sentence: the reason the HIVE-8.3
              block's deviation 2 gives. */}
          <div
            className="xstd-lens-head"
            data-tone={validationToneName(tone)}
            data-testid="verify-validation-headline"
          >
            <Icon aria-hidden />
            {validation.headline}
          </div>
          <p className="xstd-quiet">{validation.message}</p>
          {tool && (
            <p className="xstd-quiet flex items-center gap-1" data-testid="verify-validation-tool">
              <Wrench className="h-3 w-3 shrink-0" aria-hidden />
              {state === 'unavailable' ? (
                <span>
                  <code className="font-mono">{tool}</code> is not installed on the server.
                </span>
              ) : (
                <span>
                  Validated with <code className="font-mono">{tool}</code>.
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Toolchain-unavailable is a distinct warning, not silent success: the artifact was not
          validated. Spell out the reason (the report's `detail`) and that the export is not blocked. */}
      {state === 'unavailable' && (
        <div
          data-testid="verify-validation-unavailable"
          className="xstd-notice"
          data-tone="warn"
        >
          <span className="xstd-notice__grow">
            The emitted artifact was <strong>not validated</strong> — the validator could not run
            on this server.
            {validation.detail && <span className="mt-1 block">{validation.detail}</span>}
          </span>
        </div>
      )}

      {/* Not-applicable: no toolchain matches the format, so there is genuinely nothing to check. */}
      {state === 'not_applicable' && (
        <p className="xstd-quiet" data-testid="verify-validation-not-applicable">
          No validator matches this format — there is nothing to validate for this target.
        </p>
      )}

      {/* A clean pass: an explicit positive confirmation (never left as an empty panel). */}
      {state === 'valid' && (
        <p className="xstd-lens-head" data-tone="ok" data-testid="verify-validation-clean">
          <CheckCircle2 aria-hidden />
          The emitted artifact re-parsed with no validation errors.
        </p>
      )}

      {/* A rejection: the structured, actionable error list with per-finding locations. A finding
          whose located problem is openable (MFX-43.3) is a button that jumps to file + line. */}
      {validation.findings.length > 0 && (
        <ul className="space-y-2" data-testid="verify-validation-findings">
          {validation.findings.map((finding, idx) => {
            const problem = openableProblems?.find((p) => p.finding === finding) ?? null;
            const content = (
              <>
                <div className="xstd-finding__message">{finding.message}</div>
                <FindingLocation
                  file={finding.file}
                  path={finding.path}
                  line={finding.line}
                  column={finding.column}
                  rule={finding.keyword}
                />
              </>
            );
            return (
              <li
                key={`${finding.keyword ?? 'err'}-${idx}`}
                className="xstd-finding"
                data-tone="danger"
              >
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
          })}
        </ul>
      )}
    </div>
  );
}

export default ValidationResultsLens;
