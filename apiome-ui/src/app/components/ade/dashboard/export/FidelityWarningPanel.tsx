'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, ShieldAlert } from 'lucide-react';
import {
  advisoryBannerClass,
  advisoryPresentation,
  advisorySeverityPillClass,
} from '../../../../utils/export-advisory';
import { tierBadgeClass, tierLabel, fidelityChips } from './exportTargetCatalog';
import type { TargetFidelitySummary } from './exportTargetCatalog';
import {
  acknowledgementPhraseMatches,
  EXPORT_TYPES_ONLY_ACK_PHRASE,
  kindBadgeClass,
  kindDescription,
  kindGlyph,
  kindLabel,
  requiresExportAcknowledgement,
  ringGeometry,
  ringStrokeClass,
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
    <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Exporting to {targetLabel}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{targetDescription}</div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tierBadgeClass(fidelity.tier)}`}
        >
          {tierLabel(fidelity.tier)}
        </span>
      </div>

      {/* The advisory (MFX-2.4): server-side copy rendered verbatim, palette by severity. */}
      {previewLoading && (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden />
          Computing the detailed fidelity report…
        </div>
      )}
      {!previewLoading && previewError && (
        <div
          data-testid="export-advisory-error"
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          The detailed fidelity report could not be loaded — the summary below still reflects
          this conversion. {previewError}
        </div>
      )}
      {advisory && advisory.show && (
        <div
          data-testid="export-advisory"
          className={`mt-4 rounded-lg border p-3 ${advisoryBannerClass(advisoryPresentation(advisory).strength)}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            <span className="text-sm font-semibold">{advisory.headline}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase ${advisorySeverityPillClass(advisory.severity)}`}
            >
              {advisory.severity ?? 'info'}
            </span>
          </div>
          <p className="mt-1.5 text-sm">{advisory.message}</p>
        </div>
      )}
      {advisory && !advisory.show && (
        <p
          data-testid="export-advisory"
          className="mt-4 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {advisory.headline}
        </p>
      )}

      {/* Preserved-% ring + count chips, from the coarse summary (renders immediately). */}
      <div className="mt-4 flex flex-wrap items-center gap-5">
        <div className="relative h-24 w-24 shrink-0">
          <svg
            viewBox="0 0 96 96"
            className="h-24 w-24 -rotate-90"
            role="img"
            aria-label={`${fidelity.preserved_percent}% of constructs preserved`}
          >
            <circle
              cx="48"
              cy="48"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="8"
              className="stroke-gray-200 dark:stroke-gray-700"
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
              className={ringStrokeClass(fidelity.tier)}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div
              data-testid="export-preserved-percent"
              className="text-xl font-bold text-gray-900 dark:text-gray-100"
            >
              {fidelity.preserved_percent}%
            </div>
            <div className="text-2xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              preserved
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {fidelityChips(fidelity).map((chip) => (
              <span
                key={chip.key}
                data-testid={`export-fidelity-chip-${chip.key}`}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${chip.className}`}
              >
                {/* Glyph first, count and word after: shape + text + colour, never colour alone. */}
                <span aria-hidden>{chip.glyph}</span>
                {chip.count} {chip.label}
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
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
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
          >
            {reportOpen ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            )}
            {reportOpen ? 'Hide per-construct report' : 'Show per-construct report'} (
            {reportItems.length} construct{reportItems.length === 1 ? '' : 's'})
          </button>
          {reportOpen && (
            <ul
              data-testid="export-fidelity-report"
              className="mt-2 max-h-60 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-700"
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
          className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => onAcknowledgedChange(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">
              I understand this conversion is lossy and want to export anyway.
            </span>
            <span className="mt-0.5 block text-xs opacity-80">
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
      className="mt-4 rounded-lg border border-red-400 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-100"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
        <span className="font-semibold">This export produces a types-only artifact.</span>
      </div>
      <p className="mt-1.5 text-xs opacity-90">
        Only the schemas will be exported — every operation and channel is dropped. To confirm you
        understand, type <code className="font-mono font-semibold">{EXPORT_TYPES_ONLY_ACK_PHRASE}</code>{' '}
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
          className={`w-full rounded-md border bg-white px-2.5 py-1.5 font-mono text-xs text-gray-900 outline-none dark:bg-gray-900 dark:text-gray-100 ${
            matches
              ? 'border-emerald-400 focus:border-emerald-500 dark:border-emerald-600'
              : 'border-red-300 focus:border-red-500 dark:border-red-700'
          }`}
        />
      </label>
      {matches && (
        <p
          data-testid="export-ack-typed-confirmed"
          className="mt-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
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
    <li className="flex items-start gap-3 p-2.5 text-sm">
      <span
        data-testid={`export-fidelity-kind-${item.kind}`}
        className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold ${kindBadgeClass(item.kind)}`}
      >
        <span aria-hidden>{kindGlyph(item.kind)}</span>
        <span aria-hidden>{kindLabel(item.kind)}</span>
        <span className="sr-only">{kindDescription(item.kind)}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <code className="break-all font-mono text-xs font-medium text-gray-900 dark:text-gray-100">
            {item.construct}
          </code>
          {item.severity !== 'info' && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-2xs font-semibold uppercase ${advisorySeverityPillClass(item.severity)}`}
            >
              {item.severity}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-300">
          {item.message}
        </span>
        {item.target_mapping && (
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            In the target: {item.target_mapping}
          </span>
        )}
      </span>
    </li>
  );
}

export default FidelityWarningPanel;
