'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, ShieldAlert } from 'lucide-react';
import { Alert } from '../../../ui/Alert';
import type { StatusTone } from '../../../ui/statusVocabulary';
import { Badge } from '../../../ui/Badge';
import { Checkbox } from '../../../ui/Checkbox';
import {
  advisoryPresentation,
  advisorySeverityTone,
  advisoryStrengthTone,
} from '../../../../utils/export-advisory';
import { tierTone, tierLabel, fidelityChips } from './exportTargetCatalog';
import type { TargetFidelitySummary } from './exportTargetCatalog';
import {
  acknowledgementPhraseMatches,
  EXPORT_TYPES_ONLY_ACK_PHRASE,
  kindDescription,
  kindTone,
  kindGlyph,
  kindLabel,
  requiresExportAcknowledgement,
  ringGeometry,
  ringTone,
  sortReportItemsWorstFirst,
} from './exportFidelityPreview';
import type {
  AcknowledgementMode,
  ExportPreviewResponse,
  LossItem,
} from './exportFidelityPreview';

/** The ring circle's radius in SVG user units (viewBox 96×96, 8-unit stroke). */
const RING_RADIUS = 40;

export interface FidelityWarningPanelProps {
  /** Human label of the chosen target format (e.g. `gRPC / Protobuf`). */
  targetLabel: string;
  /** One-line description of the target, shown under the label. */
  targetDescription: string;
  /** The coarse per-target summary from `/api/export/targets` — renders immediately. */
  fidelity: TargetFidelitySummary;
  /** The dry-run preview (advisory + per-construct report) once loaded, else null. */
  preview: ExportPreviewResponse | null;
  /** Whether the preview fetch is in flight. */
  previewLoading: boolean;
  /** Preview fetch error; the panel falls back to the summary and stays exportable. */
  previewError: string | null;
  /** Whether the user has acknowledged the lossy/severe export. */
  acknowledged: boolean;
  /** Toggle the acknowledgement. */
  onAcknowledgedChange: (acknowledged: boolean) => void;
  /**
   * Which acknowledgement control to render (MFX-42.4). Omit for the dialog's tier-driven default
   * (a checkbox for any non-lossless conversion); the Verify workbench passes an explicit mode so a
   * `severe` (types-only) conversion gets the **typed** acknowledgement while a `lossy` one keeps
   * the checkbox.
   */
  acknowledgementMode?: AcknowledgementMode;
}

/**
 * FidelityWarningPanel — the ExportDialog's Fidelity step body (MFX-6.2, #3856).
 *
 * Renders, per the mockup: the server-computed advisory message (MFX-2.4) prominently and
 * verbatim; a preserved-% ring and the count chips (`N dropped · N approximated · N
 * synthesized · N clean`); an expandable per-construct report (DROP/APPROX/SYNTH/OK with the
 * source construct path and how it degrades); and the explicit "Export anyway"
 * acknowledgement for lossy conversions. For a lossless conversion the warning collapses to
 * the server's quiet reassurance line and no acknowledgement is asked.
 *
 * The ring and chips render immediately from the coarse `/api/export/targets` summary; the
 * advisory and report arrive with the `POST /api/export/preview` dry run. A preview failure
 * degrades gracefully — the summary keeps the panel honest and the acknowledgement gate
 * (driven by the summary tier, not the preview) still protects the download.
 */
/**
 * `Alert`'s name for a tone.
 *
 * The status vocabulary calls the informational tone `accent`; `Alert` — which predates the
 * vocabulary — calls the same tint `info`. One line here rather than a second tone table.
 *
 * @param tone The tone the advisory resolved to.
 * @returns The `Alert` variant that paints it.
 */
function alertVariantForTone(tone: StatusTone): 'info' | 'warn' | 'danger' {
  if (tone === 'danger') return 'danger';
  if (tone === 'warn') return 'warn';
  return 'info';
}

export function FidelityWarningPanel({
  targetLabel,
  targetDescription,
  fidelity,
  preview,
  previewLoading,
  previewError,
  acknowledged,
  onAcknowledgedChange,
  acknowledgementMode,
}: FidelityWarningPanelProps) {
  const [reportOpen, setReportOpen] = useState(false);

  const advisory = preview?.fidelity.advisory ?? null;
  const reportItems = useMemo(
    () => sortReportItemsWorstFirst(preview?.fidelity.report.items ?? []),
    [preview],
  );
  // The workbench passes an explicit mode; the dialog omits it and falls back to the tier-driven
  // default (a checkbox for any non-lossless conversion) it has always used.
  const ackMode: AcknowledgementMode =
    acknowledgementMode ??
    (requiresExportAcknowledgement(fidelity.tier) ? 'checkbox' : 'hidden');
  const ring = ringGeometry(fidelity.preserved_percent, RING_RADIUS);

  return (
    <div className="vdlg-export__card">
      <div className="vdlg-export__fidelity-head">
        <div>
          <div className="vdlg-section-title">Exporting to {targetLabel}</div>
          <div className="vdlg-quiet">{targetDescription}</div>
        </div>
        <Badge variant={tierTone(fidelity.tier)}>{tierLabel(fidelity.tier)}</Badge>
      </div>

      {/* The advisory (MFX-2.4): server-side copy rendered verbatim, palette by severity. */}
      {previewLoading && (
        <div className="vdlg-loading-row" role="status">
          <Loader2 className="animate-spin" aria-hidden />
          Computing the detailed fidelity report…
        </div>
      )}
      {!previewLoading && previewError && (
        <Alert variant="warn" data-testid="export-advisory-error" className="vdlg-note">
          The detailed fidelity report could not be loaded — the summary below still reflects
          this conversion. {previewError}
        </Alert>
      )}
      {advisory && advisory.show && (
        <Alert
          variant={alertVariantForTone(advisoryStrengthTone(advisoryPresentation(advisory).strength))}
          data-testid="export-advisory"
          className="vdlg-note"
          icon={<AlertTriangle aria-hidden />}
        >
          <span className="vdlg-alert__title">{advisory.headline}</span>
          <Badge variant={advisorySeverityTone(advisory.severity)}>
            {advisory.severity ?? 'info'}
          </Badge>
          <p className="vdlg-alert__note">{advisory.message}</p>
        </Alert>
      )}
      {advisory && !advisory.show && (
        <p data-testid="export-advisory" className="vdlg-bench__status" data-tone="ok">
          {advisory.headline}
        </p>
      )}

      {/* Preserved-% ring + count chips, from the coarse summary (renders immediately). */}
      <div className="vdlg-export__fidelity">
        <div className="vdlg-ring" data-tone={ringTone(fidelity.tier)}>
          <svg
            viewBox="0 0 96 96"
            className="vdlg-ring__svg"
            role="img"
            aria-label={`${fidelity.preserved_percent}% of constructs preserved`}
          >
            <circle
              cx="48"
              cy="48"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="8"
              className="vdlg-ring__track"
            />
            <circle
              cx="48"
              cy="48"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={ring.circumference}
              strokeDashoffset={ring.dashOffset}
              className="vdlg-ring__value"
            />
          </svg>
          <div className="vdlg-ring__label">
            <div data-testid="export-preserved-percent" className="vdlg-ring__value-text">
              {fidelity.preserved_percent}%
            </div>
            <div className="vdlg-caps">preserved</div>
          </div>
        </div>

        <div className="vdlg-export__fidelity-body">
          <div className="vdlg-chips">
            {fidelityChips(fidelity).map((chip) => (
              <Badge
                key={chip.key}
                variant={chip.tone}
                data-testid={`export-fidelity-chip-${chip.key}`}
              >
                {/* Glyph first, count and word after: shape + text + colour, never colour alone. */}
                <span aria-hidden>{chip.glyph}</span>
                {chip.count} {chip.label}
              </Badge>
            ))}
          </div>
          <p className="vdlg-quiet">
            {fidelity.total} construct{fidelity.total === 1 ? '' : 's'} considered for this
            source.
          </p>
        </div>
      </div>

      {/* Expandable per-construct report: DROP/APPROX/SYNTH/OK, worst-first. */}
      {reportItems.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            data-testid="export-report-toggle"
            onClick={() => setReportOpen((open) => !open)}
            className="vdlg-link"
          >
            {reportOpen ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            {reportOpen ? 'Hide per-construct report' : 'Show per-construct report'} (
            {reportItems.length} construct{reportItems.length === 1 ? '' : 's'})
          </button>
          {reportOpen && (
            <ul
              data-testid="export-fidelity-report"
              className="vdlg-export__report"
            >
              {reportItems.map((item) => (
                <FidelityReportRow key={`${item.construct}-${item.kind}-${item.message}`} item={item} />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* The acknowledgement gate: the "Export anyway" checkbox for a lossy conversion, the typed
          acknowledgement for a severe (types-only) one, and nothing for a clean/invalid export. */}
      {ackMode === 'checkbox' && (
        <label
          data-testid="export-ack"
          className="vdlg-export__ack"
          data-tone="warn"
        >
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(checked) => onAcknowledgedChange(checked === true)}
          />
          <span>
            <span className="vdlg-export__ack-title">
              I understand this conversion is lossy and want to export anyway.
            </span>
            <span className="vdlg-export__ack-note">
              The export stays disabled until you acknowledge the fidelity loss above.
            </span>
          </span>
        </label>
      )}
      {ackMode === 'typed' && (
        <TypedAcknowledgement acknowledged={acknowledged} onAcknowledgedChange={onAcknowledgedChange} />
      )}
    </div>
  );
}

/**
 * The typed acknowledgement for a **severe** (types-only / near-empty) conversion (MFX-42.4).
 *
 * A severe export produces a types-only artifact — only the source's schemas survive, every
 * operation and channel is dropped — so, unlike a merely lossy conversion, it is not gated by a
 * one-click checkbox but by an explicit **typed** confirmation: the user must type
 * {@link EXPORT_TYPES_ONLY_ACK_PHRASE} exactly (case-insensitively) before Generate unlocks. The
 * phrase and its match check come from the single shared source so the prompt and the gate can
 * never drift, and the consequence copy above it is the server advisory (MFX-2.4) rendered verbatim.
 *
 * The input holds its own text; it seeds from {@link acknowledged} so navigating back to a
 * previously-confirmed export keeps the phrase in place, and reports each keystroke's match up to
 * the parent-owned `acknowledged` flag that drives the gate.
 */
function TypedAcknowledgement({
  acknowledged,
  onAcknowledgedChange,
}: {
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
}) {
  const [typed, setTyped] = useState(() => (acknowledged ? EXPORT_TYPES_ONLY_ACK_PHRASE : ''));
  const matches = acknowledgementPhraseMatches(typed);

  const handleChange = (value: string) => {
    setTyped(value);
    // Report every keystroke's match up to the parent-owned flag; re-reporting the same value is a
    // no-op setState, and this keeps the gate correct even if the parent does not echo the flag back.
    onAcknowledgedChange(acknowledgementPhraseMatches(value));
  };

  return (
    <div
      data-testid="export-ack-typed"
      className="vdlg-export__ack vdlg-export__ack--typed"
      data-tone="danger"
    >
      <div className="vdlg-export__ack-head">
        <ShieldAlert aria-hidden />
        <span className="vdlg-export__ack-title">This export produces a types-only artifact.</span>
      </div>
      <p className="vdlg-export__ack-note">
        Only the schemas will be exported — every operation and channel is dropped. To confirm you
        understand, type <code className="mono">{EXPORT_TYPES_ONLY_ACK_PHRASE}</code>{' '}
        below. Generate stays disabled until it matches.
      </p>
      <label className="mt-2 block">
        <span className="sr-only">Type “{EXPORT_TYPES_ONLY_ACK_PHRASE}” to acknowledge</span>
        <input
          type="text"
          data-testid="export-ack-typed-input"
          value={typed}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={EXPORT_TYPES_ONLY_ACK_PHRASE}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={typed.length > 0 && !matches}
          className="vdlg-input--mono vdlg-export__ack-input"
          data-matches={matches || undefined}
        />
      </label>
      {matches && (
        <p
          data-testid="export-ack-typed-confirmed"
          className="vdlg-bench__status"
          data-tone="ok"
        >
          Acknowledged — you can generate this export.
        </p>
      )}
    </div>
  );
}

/**
 * One row of the per-construct report: the kind badge (DROP/APPROX/SYNTH/OK), the source
 * construct path, the explanation of what happens to it, and — when the construct is not
 * dropped — how it lands in the target. Warn/critical rows carry a severity pill.
 *
 * The kind badge carries three channels (MFX-41.5): a glyph (`✕ ≈ ✚ ✓`), the kind word, and the
 * palette — so it stays readable in greyscale and to a user who cannot separate red from amber.
 * The badge's screen-reader text expands the three-letter jargon ("dropped — not representable in
 * the target") so the meaning does not depend on having read a legend.
 */
function FidelityReportRow({ item }: { item: LossItem }) {
  return (
    <li className="vdlg-export__report-row">
      <span
        data-testid={`export-fidelity-kind-${item.kind}`}
        className="vdlg-export__kind"
        data-tone={kindTone(item.kind)}
      >
        <span aria-hidden>{kindGlyph(item.kind)}</span>
        <span aria-hidden>{kindLabel(item.kind)}</span>
        <span className="sr-only">{kindDescription(item.kind)}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <code className="vdlg-export__construct mono">{item.construct}</code>
          {item.severity !== 'info' && (
            <Badge variant={advisorySeverityTone(item.severity)}>{item.severity}</Badge>
          )}
        </span>
        <span className="vdlg-export__report-message">{item.message}</span>
        {item.target_mapping && (
          <span className="vdlg-quiet">
            In the target: {item.target_mapping}
          </span>
        )}
      </span>
    </li>
  );
}

export default FidelityWarningPanel;
