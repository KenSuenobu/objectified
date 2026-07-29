'use client';

/**
 * ConversionEvidenceDrawer (CPDO-3.2, #4802) — why one conversion outcome happened, with
 * everything needed to judge it and the safe way out.
 *
 * Opened by selecting a projection-graph node or its synchronized fallback-table row
 * (CPDO-3.1), the drawer explains one conversion projection edge end to end:
 *
 *  - the **status** (wire vocabulary, `Inferred` included), severity, and edge scope;
 *  - the **cause**: the reason category (shared with the export evidence drawer, EFP-2.3 —
 *    the conversion manifest speaks the same canonical reason taxonomy), the exact reason
 *    code, and the manifest's detail sentence;
 *  - the **fidelity finding** the edge reconciles with — the report's own checklist row or
 *    enumerated loss, so the drawer and the report above never tell different stories;
 *  - the **canonical object** and the **source path/range**: the construct key/kind, the
 *    parser-recorded source location, and each evidence reference's structured location
 *    (file/line/column/offset/length). Only paths and ranges are ever shown — the manifest
 *    wire format carries no raw source content, so redacted material cannot leak here, and
 *    a `[redacted]` placeholder from the server passes through untouched;
 *  - the **OpenAPI JSON Pointers** the construct landed on (or would have);
 *  - the **remediation**: the server's conversion-phrased guidance, plus — when the gap is
 *    one a safe default can close (info title/version, servers) — an inline approval form.
 *    Approving hands the merged defaults up via {@link ConversionEvidenceDrawerProps.onApplyDefaults};
 *    the dialog then recomputes the fidelity report and the projection graph **together**
 *    (same defaults, same snapshot) and resets the acknowledgement. Cancel just discards
 *    the draft — nothing anywhere persists until a conversion is committed;
 *  - the **tool-version provenance** and snapshot hash the evidence was produced against.
 *
 * All evidence text renders as React text nodes only, through the shared sanitizers. The
 * drawer renders in-flow beneath the graph/table (the EFP-2.3 precedent), so the same
 * markup is the small-screen experience.
 */

import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { advisorySeverityPillClass } from '../../../../utils/export-advisory';
import {
  categoryForReason,
  reasonCategoryPresentation,
  sanitizeEvidenceProse,
} from '../export/lossExplanation';
import type { StatusPresentation } from '../export/projectionGraph';
import {
  CONVERSION_SCOPE_LABEL,
  applySafeDefault,
  conversionStatusPresentation,
  fidelityFindingForRow,
  formatEvidenceRefLocation,
  formatToolVersions,
  safeDefaultForRow,
  sanitizeProjectionLabel,
  statusPresentation,
  type ConversionLaneKey,
  type ConversionProjectionRow,
  type ProjectionViewEntry,
  type SafeDefaultRemediation,
} from './conversionProjectionGraph';
import { cn } from '@lib/utils';
import type { ConversionManifestSummary } from '@/app/utils/conversion-projection';
import type { ConversionDefaults, FidelityReport } from '@/app/utils/conversion-fidelity';

/** Status symbol + text — the colour-independent pairing used across the projection section. */
export function StatusText({ presentation }: { presentation: StatusPresentation }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
        presentation.badgeClass,
      )}
    >
      <span aria-hidden>{presentation.symbol}</span>
      {presentation.label}
    </span>
  );
}

export interface ConversionEvidenceDrawerProps {
  /** The selected view entry (a row or an aggregate) the drawer explains. */
  entry: ProjectionViewEntry<ConversionLaneKey>;
  /** The manifest summary the evidence belongs to (tool versions + snapshot provenance). */
  summary: ConversionManifestSummary | null;
  /** The dialog's fidelity report, for the linked finding; null degrades gracefully. */
  report?: FidelityReport | null;
  /** The defaults the preview currently applies, pre-filling the safe-default form. */
  currentDefaults?: ConversionDefaults;
  /** True while the dialog is recomputing the report + graph; the form waits. */
  recomputing?: boolean;
  /** Close the drawer (clears the selection). Nothing else changes. */
  onClose: () => void;
  /**
   * Approve a safe-default change. The dialog must recompute the fidelity report and the
   * projection graph together from these defaults and reset the acknowledgement — the
   * drawer itself changes nothing. Omitted → the form is not offered.
   */
  onApplyDefaults?: (defaults: ConversionDefaults) => void;
}

/**
 * Render the conversion evidence drawer for the selected graph node / fallback row.
 */
export function ConversionEvidenceDrawer({
  entry,
  summary,
  report,
  currentDefaults,
  recomputing,
  onClose,
  onApplyDefaults,
}: ConversionEvidenceDrawerProps) {
  const row = entry.kind === 'row' ? (entry.row as ConversionProjectionRow) : null;
  const presentation = row
    ? conversionStatusPresentation(row.conversionStatus)
    : statusPresentation(entry.status);

  return (
    // A <section>, not an <aside>: the drawer lives inside the projection panel's own
    // landmark, and a complementary landmark must be top-level (axe).
    <section
      data-testid="conversion-projection-evidence"
      aria-label="Selected construct evidence"
      className="mt-3 space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 text-xs text-gray-700 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-gray-200"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all font-mono text-xs font-semibold text-gray-900 dark:text-gray-100">
            {row ? row.construct : sanitizeProjectionLabel(entry.label)}
          </code>
          <StatusText presentation={presentation} />
          {row && row.severity !== 'info' && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${advisorySeverityPillClass(row.severity)}`}
            >
              {row.severity}
            </span>
          )}
          {row && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {CONVERSION_SCOPE_LABEL[row.scope]} evidence
            </span>
          )}
          {row && row.edgeCount > 1 && (
            <span className="text-[10px] text-gray-500 dark:text-gray-400">
              stands for {row.edgeCount.toLocaleString()} instances
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="conversion-projection-evidence-close"
          aria-label="Close evidence detail"
          onClick={onClose}
          className="rounded-md p-1 text-gray-500 hover:bg-white hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {entry.kind === 'aggregate' ? (
        <p className="text-xs text-gray-600 dark:text-gray-300">
          {entry.members?.length ?? 0} constructs, aggregated to keep the graph readable.
          Expand the aggregate row in the table below to list every member.
        </p>
      ) : (
        row && (
          <DrawerBody
            row={row}
            summary={summary}
            report={report}
            currentDefaults={currentDefaults}
            recomputing={recomputing}
            onApplyDefaults={onApplyDefaults}
          />
        )
      )}
    </section>
  );
}

/** The row-level body: cause, finding, locations, evidence references, remediation, provenance. */
function DrawerBody({
  row,
  summary,
  report,
  currentDefaults,
  recomputing,
  onApplyDefaults,
}: {
  row: ConversionProjectionRow;
  summary: ConversionManifestSummary | null;
  report?: FidelityReport | null;
  currentDefaults?: ConversionDefaults;
  recomputing?: boolean;
  onApplyDefaults?: (defaults: ConversionDefaults) => void;
}) {
  const category = categoryForReason(row.reason);
  const categoryView = category ? reasonCategoryPresentation(category) : null;
  const detail = sanitizeEvidenceProse(row.conversionEdge.detail);
  const finding = fidelityFindingForRow(row, report);
  const remediationText = sanitizeEvidenceProse(row.remediation);
  const safeDefault = onApplyDefaults ? safeDefaultForRow(row) : null;
  const toolVersions = summary ? formatToolVersions(summary.tool_versions) : null;

  return (
    <div className="space-y-2">
      {/* Why — the cause category, the exact code, and the manifest's own sentence. */}
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          {categoryView && (
            <span
              data-testid="conversion-projection-category"
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${categoryView.badgeClass}`}
            >
              {categoryView.label}
            </span>
          )}
          {row.reason && (
            <span
              className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              data-testid="conversion-projection-reason"
            >
              {row.reason}
            </span>
          )}
        </div>
        {categoryView && (
          <p className="mt-1 font-medium text-gray-800 dark:text-gray-100">
            {categoryView.distinction}
          </p>
        )}
        {detail && <p className="mt-1">{detail}</p>}
      </div>

      {/* The fidelity report's own verdict for this construct — never a second opinion. */}
      {finding && (
        <p
          data-testid="conversion-projection-finding"
          className="rounded-md bg-white/60 p-2 text-[11px] text-gray-600 dark:bg-gray-900/40 dark:text-gray-300"
        >
          <span className="font-semibold text-gray-700 dark:text-gray-200">
            Fidelity finding ({finding.kind === 'checklist' ? 'checklist' : 'loss'}):
          </span>{' '}
          {finding.label} — {finding.badge}. {finding.text}
        </p>
      )}

      {/* Where — canonical object, source path/range, and OpenAPI JSON Pointer. */}
      <dl className="space-y-1 text-[11px]">
        {(row.constructKey || row.canonicalKind) && (
          <div data-testid="conversion-projection-canonical">
            <dt className="inline font-medium text-gray-500 dark:text-gray-400">
              Canonical object:{' '}
            </dt>
            <dd className="inline">
              {row.constructKey && (
                <code className="break-all font-mono">{sanitizeProjectionLabel(row.constructKey)}</code>
              )}
              {row.canonicalKind && (
                <span className="text-gray-500 dark:text-gray-400">
                  {row.constructKey ? ' ' : ''}({sanitizeProjectionLabel(row.canonicalKind)})
                </span>
              )}
            </dd>
          </div>
        )}
        {(row.sourceLabel || row.sourceLocation) && (
          <div data-testid="conversion-projection-source">
            <dt className="inline font-medium text-gray-500 dark:text-gray-400">
              From the source:{' '}
            </dt>
            <dd className="inline">
              {row.sourceLabel}
              {row.sourceLocation ? (
                <span className="text-gray-500 dark:text-gray-400"> ({row.sourceLocation})</span>
              ) : null}
            </dd>
          </div>
        )}
        {row.targetLocation && (
          <div data-testid="conversion-projection-pointer">
            <dt className="inline font-medium text-gray-500 dark:text-gray-400">
              In the OpenAPI document:{' '}
            </dt>
            <dd className="inline">
              <code className="break-all font-mono">{row.targetLocation}</code>
            </dd>
          </div>
        )}
      </dl>

      {/* Evidence references — structured paths and ranges only, never source content. */}
      {row.conversionEdge.evidence.length > 0 && (
        <ul
          className="space-y-0.5 rounded-md bg-gray-50 p-2 text-[11px] text-gray-600 dark:bg-gray-900/50 dark:text-gray-300"
          data-testid="conversion-projection-evidence-refs"
        >
          {row.conversionEdge.evidence.slice(0, 5).map((ref) => {
            const location = formatEvidenceRefLocation(ref.location);
            return (
              <li key={`${ref.kind}:${ref.ref}`}>
                {ref.kind}: <span className="font-mono">{sanitizeProjectionLabel(ref.ref)}</span>
                {location && <span className="text-gray-500 dark:text-gray-400"> — {location}</span>}
              </li>
            );
          })}
          {row.conversionEdge.evidence.length > 5 && (
            <li>… {row.conversionEdge.evidence.length - 5} more references</li>
          )}
        </ul>
      )}

      {/* Remedy — the server's guidance, plus the safe-default approval when one applies. */}
      {(remediationText || safeDefault) && (
        <div
          data-testid="conversion-projection-remediation"
          className="rounded-md border border-indigo-200 bg-white/60 p-2 dark:border-indigo-900 dark:bg-gray-900/40"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            What you can do
          </div>
          {remediationText && <p className="mt-1">{remediationText}</p>}
          {safeDefault && onApplyDefaults && (
            <SafeDefaultForm
              key={row.id}
              remediation={safeDefault}
              currentDefaults={currentDefaults ?? {}}
              recomputing={recomputing}
              onApply={onApplyDefaults}
            />
          )}
        </div>
      )}

      {/* Provenance — the versions and snapshot this evidence was produced against. */}
      {(toolVersions || summary) && (
        <p
          data-testid="conversion-projection-provenance"
          className="text-[10px] text-gray-500 dark:text-gray-400"
        >
          {toolVersions ? `Evidence produced by ${toolVersions}` : 'Evidence'}
          {summary ? ` · snapshot ${summary.manifest_hash.slice(0, 12)}` : ''}.
        </p>
      )}
    </div>
  );
}

/** Initial form text for a safe-default field, from the currently applied defaults. */
function initialDraft(field: SafeDefaultRemediation['field'], defaults: ConversionDefaults): string {
  if (field === 'servers') return (defaults.servers ?? []).join(', ');
  return defaults[field] ?? '';
}

/**
 * The inline safe-default approval form. Local draft only — Apply hands the merged
 * defaults up for the atomic recompute; Cancel restores the draft to the applied value.
 */
function SafeDefaultForm({
  remediation,
  currentDefaults,
  recomputing,
  onApply,
}: {
  remediation: SafeDefaultRemediation;
  currentDefaults: ConversionDefaults;
  recomputing?: boolean;
  onApply: (defaults: ConversionDefaults) => void;
}) {
  const applied = initialDraft(remediation.field, currentDefaults);
  const [draft, setDraft] = useState(applied);
  // A recompute that changed the applied defaults re-anchors the draft (render-adjust
  // pattern — no effect, no extra committed render with a stale draft).
  const [lastApplied, setLastApplied] = useState(applied);
  if (lastApplied !== applied) {
    setLastApplied(applied);
    setDraft(applied);
  }

  const dirty = draft !== applied;

  return (
    <div className="mt-1.5" data-testid="conversion-projection-safe-default">
      <label className="flex flex-col gap-1 text-[11px] text-gray-600 dark:text-gray-300">
        {remediation.label}
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={remediation.placeholder}
          disabled={recomputing}
          data-testid="conversion-projection-safe-default-input"
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
      </label>
      <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
        {remediation.description} Applying recomputes the fidelity report and this graph
        together and re-asks for acknowledgement; cancelling changes nothing.
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          data-testid="conversion-projection-safe-default-apply"
          disabled={recomputing || !dirty}
          onClick={() => onApply(applySafeDefault(currentDefaults, remediation.field, draft))}
          className="flex items-center gap-1 rounded-md border border-indigo-300 px-2 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
        >
          {recomputing && <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />}
          {recomputing ? 'Recomputing…' : 'Apply & recompute'}
        </button>
        <button
          type="button"
          data-testid="conversion-projection-safe-default-cancel"
          disabled={recomputing || !dirty}
          onClick={() => setDraft(applied)}
          className="rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default ConversionEvidenceDrawer;
