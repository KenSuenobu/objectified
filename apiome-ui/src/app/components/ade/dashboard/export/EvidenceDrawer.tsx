'use client';

import { ExternalLink, X } from 'lucide-react';
import { advisorySeverityTone } from '../../../../utils/export-advisory';
import type { ProjectionReasonCode, ReasonExplanation } from './capabilityRegistry';
import { isKnownReasonCode, sanitizeDocumentationEvidence } from './capabilityRegistry';
import {
  categoryForReason,
  documentationLink,
  manifestProvenance,
  reasonCategoryPresentation,
  remediationActionsForReason,
  sanitizeEvidenceProse,
} from './lossExplanation';
import type { ProjectionManifestSummary } from './exportFidelityPreview';
import { statusPresentation, type ProjectionEvidenceRow, type ProjectionViewEntry } from './projectionGraph';
import { Badge } from '../../../ui/Badge';

export interface EvidenceDrawerProps {
  /** The selected view entry (a row or an aggregate) the drawer explains. */
  entry: ProjectionViewEntry;
  /**
   * The snapshot the evidence belongs to, when loaded — only its `target` block is read
   * (the emitter/registry/apiome versions the provenance line prints). Typed as that one
   * field so a surface with a different snapshot envelope carrying the same provenance
   * block — the export preview manifest (IXH-4.1/4.2) — can pass it without fabricating
   * the summary's other counts.
   */
  summary: Pick<ProjectionManifestSummary, 'target'> | null;
  /** Reviewed reason explanations from the capability registry (empty map degrades gracefully). */
  reasons: ReadonlyMap<ProjectionReasonCode, ReasonExplanation>;
  /** Close the drawer (clears the selection). */
  onClose: () => void;
  /**
   * Navigate back to the target choice — the safe remediation for a format limit. The
   * navigation itself changes nothing; an actual target change re-previews, invalidates the
   * acknowledgement, and refreshes the graph and report together. Omitted → no button.
   */
  onChangeTarget?: () => void;
  /**
   * Navigate back to the export options — the safe remediation for an option exclusion.
   * Same contract as {@link onChangeTarget}. Omitted → no button.
   */
  onChangeOptions?: () => void;
}

/**
 * EvidenceDrawer — the export evidence drawer (EFP-2.3, #4815).
 *
 * Launched by selecting a projection-graph node or its synchronized table row (EFP-2.2),
 * this drawer explains one projection outcome end to end: status + severity, the cause
 * category (format limit / emitter gap / source incomplete / option excluded / redacted —
 * always distinguished, never a bare `DROP`), the reviewed reason explanation and the
 * emitter's outcome text, source and destination locations (the `[redacted]` placeholder
 * passes through untouched), the reason-scoped destination documentation link
 * (host-allowlisted, version-disclosing, accessibly named, new tab), the reviewed
 * remediation guidance from the capability registry, safe remediation actions
 * (navigation-only — an actual target/option change re-previews and invalidates the old
 * acknowledgement), and the emitter/registry version provenance the evidence was produced
 * against.
 *
 * The drawer renders in-flow beneath the graph/table, so the same markup *is* the inline
 * small-screen experience — no parallel implementation to drift (EFP-2.3 acceptance). All
 * evidence text renders as React text nodes only.
 */
export function EvidenceDrawer({
  entry,
  summary,
  reasons,
  onClose,
  onChangeTarget,
  onChangeOptions,
}: EvidenceDrawerProps) {
  const p = statusPresentation(entry.status);

  return (
    <aside
      data-testid="projection-detail"
      aria-label="Selected construct evidence"
      className="xstd-evidence"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={p.tone}>
            <span aria-hidden>{p.symbol} </span>
            {p.label}
          </Badge>
          {entry.kind === 'row' && entry.row && entry.row.severity !== 'info' && (
            <Badge variant={advisorySeverityTone(entry.row.severity)} className="uppercase">
              {entry.row.severity}
            </Badge>
          )}
          <code className="xstd-evidence__title">
            {entry.kind === 'row' ? entry.row?.construct : entry.label}
          </code>
        </div>
        <button
          type="button"
          data-testid="projection-detail-close"
          aria-label="Close evidence detail"
          onClick={onClose}
          className="xstd-evidence__close"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {entry.kind === 'aggregate' ? (
        <p className="xstd-evidence__body">
          {entry.members?.length ?? 0} constructs with this outcome were aggregated for
          readability. Expand the aggregate row in the table to list every construct.
        </p>
      ) : (
        entry.row && (
          <EvidenceDrawerBody
            row={entry.row}
            summary={summary}
            reasons={reasons}
            onChangeTarget={onChangeTarget}
            onChangeOptions={onChangeOptions}
          />
        )
      )}
    </aside>
  );
}

/** The row-level body: reason + outcome + locations + documentation + remediation + provenance. */
function EvidenceDrawerBody({
  row,
  summary,
  reasons,
  onChangeTarget,
  onChangeOptions,
}: {
  row: ProjectionEvidenceRow;
  summary: Pick<ProjectionManifestSummary, 'target'> | null;
  reasons: ReadonlyMap<ProjectionReasonCode, ReasonExplanation>;
  onChangeTarget?: () => void;
  onChangeOptions?: () => void;
}) {
  const category = categoryForReason(row.reason);
  const categoryView = category ? reasonCategoryPresentation(category) : null;
  const registryReason =
    row.reason && isKnownReasonCode(row.reason) ? (reasons.get(row.reason) ?? null) : null;

  // The reviewed explanation and the emitter's outcome text are distinct evidence: show
  // both, but never the same sentence twice.
  const explanation = sanitizeEvidenceProse(row.edge.explanation);
  const detail = sanitizeEvidenceProse(row.edge.detail);
  const outcomeText = detail && detail !== explanation ? detail : null;

  const documentation = row.edge.documentation
    ? sanitizeDocumentationEvidence(row.edge.documentation)
    : null;
  const docLink = documentationLink(documentation);
  const docNote = documentation && !docLink ? sanitizeEvidenceProse(documentation.note) : null;

  const actions = remediationActionsForReason(row.reason).filter((action) =>
    action.kind === 'change-target' ? Boolean(onChangeTarget) : Boolean(onChangeOptions),
  );
  const remediationText = sanitizeEvidenceProse(registryReason?.remediation);

  const provenance = manifestProvenance(summary?.target);
  const provenanceParts = [
    provenance.emitterVersion ? `emitter v${provenance.emitterVersion}` : null,
    provenance.registryVersion ? `registry v${provenance.registryVersion}` : null,
    provenance.apiomeVersion ? `apiome v${provenance.apiomeVersion}` : null,
  ].filter(Boolean);

  return (
    <div className="mt-2 space-y-2 text-xs">
      {/* Why — the cause category, distinguished from every other cause (EFP-2.3). */}
      <div data-testid="projection-detail-reason">
        <div className="flex flex-wrap items-center gap-1.5">
          {categoryView && (
            <Badge data-testid="projection-detail-category" variant={categoryView.tone}>
              {categoryView.label}
            </Badge>
          )}
          {row.reason && isKnownReasonCode(row.reason) && (
            <span className="xstd-evidence__code">
              {row.reason}
            </span>
          )}
        </div>
        {categoryView && (
          <p
            data-testid="projection-detail-distinction"
            className="mt-1 font-medium text-fg"
          >
            {categoryView.distinction}
          </p>
        )}
        {explanation && <p className="mt-1 text-fg">{explanation}</p>}
        {outcomeText && (
          <p data-testid="projection-detail-outcome" className="mt-1 text-fg-muted">
            {outcomeText}
          </p>
        )}
      </div>

      {/* Where — destination and source locations. */}
      <dl className="space-y-1">
        {(row.targetLocation || row.targetLabel) && (
          <div>
            <dt className="inline font-medium">In the destination: </dt>
            <dd className="inline">
              <code className="break-all font-mono">
                {row.targetLocation ?? row.targetLabel}
              </code>
            </dd>
          </div>
        )}
        {(row.sourceLabel || row.sourceLocation) && (
          <div>
            <dt className="inline font-medium">From the source: </dt>
            <dd className="inline">
              {row.sourceLabel}
              {row.sourceLocation ? (
                <span className="text-fg-muted"> ({row.sourceLocation})</span>
              ) : null}
            </dd>
          </div>
        )}
      </dl>

      {/* Reference — the official destination documentation, only when a safe link exists. */}
      {docLink && (
        <div>
          <a
            data-testid="projection-detail-doc"
            href={docLink.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={docLink.ariaLabel}
            className="xstd-link inline-flex items-center gap-1"
          >
            {docLink.text}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>
      )}
      {docNote && (
        <p data-testid="projection-detail-doc-note" className="text-fg-muted">
          {docNote}
        </p>
      )}

      {/* Remedy — reviewed guidance + navigation-only actions. */}
      {(remediationText || actions.length > 0) && (
        <div
          data-testid="projection-detail-remediation"
          className="xstd-evidence__remediation"
        >
          <div className="xstd-caps">
            What you can do
          </div>
          {remediationText && (
            <p className="mt-1 text-fg">{remediationText}</p>
          )}
          {actions.map((action) => (
            <div key={action.kind} className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid={`projection-detail-action-${action.kind}`}
                onClick={action.kind === 'change-target' ? onChangeTarget : onChangeOptions}
                className="xstd-evidence__action"
              >
                {action.label}
              </button>
              <span className="text-fg-muted">{action.description}</span>
            </div>
          ))}
        </div>
      )}

      {/* Provenance — the versions this evidence was produced against. */}
      {provenanceParts.length > 0 && (
        <p
          data-testid="projection-detail-provenance"
          className="xstd-note"
        >
          Evidence produced by {provenanceParts.join(' · ')}.
        </p>
      )}
    </div>
  );
}

export default EvidenceDrawer;
