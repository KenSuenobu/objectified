'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@lib/utils';
import {
  CheckCircle2,
  Download,
  FileArchive,
  FileOutput,
  Loader2,
  Package,
  PanelsTopLeft,
  SlidersHorizontal,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Alert';
import { useExportTargets } from './useExportTargets';
import { useExportPreview } from './useExportPreview';
import { FidelityWarningPanel } from './FidelityWarningPanel';
import { ProjectionGraphPanel } from './ProjectionGraphPanel';
import { ArtifactPreviewCard } from './ArtifactPreviewCard';
import { ExportTargetGrid } from './ExportTargetGrid';
import type { ExportTargetOrder } from './exportReadiness';
import { useExportPreflight } from './useExportPreflight';
import { ExportOptionsForm } from './ExportOptionsForm';
import { OriginalSourceOption } from './OriginalSourceOption';
import { requiresExportAcknowledgement } from './exportFidelityPreview';
import { zipFilenameFor, type EmittedArtifact } from './exportArtifactPreview';
import { buildZip } from './zipBundle';
import { downloadBlob, filenameFromDisposition } from './exportDownload';
import { exportStudioHref, type ExportStudioOrigin } from './exportStudioLink';
import type { ExportStudioStep } from './exportStudioUrlState';
import {
  changedOptions,
  exportTargetCards,
  filterSameFormatTargets,
  optionFieldsFromSchema,
  resolveExportDialect,
  type ExportFidelityTier,
  type ExportTargetCard,
} from './exportTargetCatalog';

/** What a successful emit produced — handed to `onExported` (e.g. to record it as a recent export, MFX-6.5). */
export interface ExportedArtifactSummary {
  /** Registry key of the emitted target, e.g. `"proto"`. */
  targetKey: string;
  /** Human label of the emitted target, e.g. `"Protobuf"`. */
  targetLabel: string;
  /** Fidelity tier of the conversion (MFX-2.5). */
  tier: ExportFidelityTier;
  /** Share of constructs carried faithfully, 0–100. */
  preservedPercent: number;
  /** Filename of the emitted document. */
  filename: string;
  /**
   * The non-default option overrides the emit used (the `changedOptions` payload, MFX-1.4), so a
   * recent-export record can offer an exact "re-run in Studio" (MFX-41.3). Null when every option
   * ran at its default.
   */
  options?: Record<string, unknown> | null;
}

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** The artifact (project) id to export — export is version-scoped (MFX-6.5). */
  artifact: string;
  /** Human name of the artifact, shown in the header; falls back to the id. */
  artifactLabel?: string;
  /** The revision to export (UUID or version label); the latest revision when omitted. */
  version?: string | null;
  /**
   * The source's original import format (e.g. `graphql`), when known (catalog sources). Hides the
   * redundant same-format target and offers the original source unchanged instead (MFX-41.1).
   */
  sourceFormat?: string | null;
  /** Where the export was launched from — carried into the Studio so its back link returns there. */
  studioOrigin?: ExportStudioOrigin;
  /** Called after a successful export (the document has been emitted and is being previewed). */
  onExported?: (summary: ExportedArtifactSummary) => void;
}

type Step = 'source' | 'target' | 'fidelity' | 'export';

/**
 * The Studio stop that corresponds to a dialog step (HIVE-6.3, #5314).
 *
 * The two steppers are not the same list — the dialog folds the Studio's *options* and *verify*
 * stops into one *Fidelity* view, and its *export* stop has no Studio equivalent because the
 * Studio re-verifies before it generates. The mapping keeps a reader roughly where they were:
 *
 * | dialog     | Studio    |
 * | ---------- | --------- |
 * | `source`   | `source`  |
 * | `target`   | `target`  |
 * | `fidelity` | `options` |
 * | `export`   | `verify`  |
 *
 * With no target chosen the Studio cannot establish anything past `target`, so the stop is
 * clamped there; `exportStudioUrlState` clamps again on read, and this only avoids minting a
 * link that would visibly snap backwards.
 *
 * @param step Where the dialog is.
 * @param hasTarget Whether a target has been selected.
 * @returns The Studio stop to resume at.
 */
export function studioStepForDialogStep(step: Step, hasTarget: boolean): ExportStudioStep {
  if (!hasTarget) return step === 'source' ? 'source' : 'target';
  switch (step) {
    case 'source':
      return 'source';
    case 'target':
      return 'target';
    case 'fidelity':
      return 'options';
    case 'export':
    default:
      return 'verify';
  }
}

const STEP_LABELS = ['Source', 'Target', 'Fidelity', 'Export'] as const;
const STEP_ORDER: Step[] = ['source', 'target', 'fidelity', 'export'];

/**
 * ExportDialog — the export mirror of the ImportDialog (MFX-6.1, #3855).
 *
 * A numbered stepper (Source → Target → Fidelity → Export) over a data-driven target-card grid:
 * every registered emitter from `GET /api/export/targets`, each card carrying a per-source
 * fidelity badge (`lossless` / `lossy` / `types-only`, MFX-2.5) so the trade-off is visible
 * before selecting. Picking a target updates the fidelity headline under the grid; the Fidelity
 * step renders the full warning panel (MFX-6.2, #3856): the server-computed advisory (MFX-2.4),
 * a preserved-% ring with count chips, and the expandable per-construct report from the
 * `POST /api/export/preview` dry run. A lossy conversion keeps the download gated behind an
 * explicit "Export anyway" acknowledgement; a lossless one stays quiet. Per-target options
 * (MFX-1.4) render from the target's options schema. Export emits via `POST /api/export/document`
 * and shows the emitted artifact in a preview card (MFX-6.3, #3857) — content, size, and the
 * "valid · round-trip OK" status badge — before the user downloads it as the single file or as
 * a `.zip` bundle built client-side.
 */
export function ExportDialog({
  open,
  onClose,
  artifact,
  artifactLabel,
  version = null,
  sourceFormat = null,
  studioOrigin,
  onExported,
}: ExportDialogProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('source');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [optionValues, setOptionValues] = useState<Record<string, unknown>>({});
  const [exporting, setExporting] = useState(false);
  /** The emitted document being previewed on the Export step (MFX-6.3), once emitted. */
  const [emitted, setEmitted] = useState<EmittedArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether the user has acknowledged a lossy conversion ("Export anyway", MFX-6.2). */
  const [acknowledged, setAcknowledged] = useState(false);

  const { response, loading, error: targetsError } = useExportTargets(open, artifact, version);
  // IXH-2.4: the same readiness ranking the Studio uses, so the dialog's grid orders by expected
  // outcome and surfaces a policy-blocked target's reason before a job is submitted.
  const { report: preflight, readiness } = useExportPreflight(open, artifact, version);
  const [targetOrder, setTargetOrder] = useState<ExportTargetOrder>('readiness');
  // Drop the redundant same-format target (e.g. GraphQL→GraphQL); the "Original source" option
  // replaces it when the source's format is known.
  const cards = useMemo(
    () => filterSameFormatTargets(exportTargetCards(response), sourceFormat),
    [response, sourceFormat],
  );
  const selected = useMemo(
    () => cards.find((card) => card.key === selectedKey) ?? null,
    [cards, selectedKey],
  );
  const optionFields = useMemo(
    () =>
      selected
        ? optionFieldsFromSchema(selected.entry.options_schema, selected.entry.default_options)
        : [],
    [selected],
  );

  // Only the non-default option overrides are sent — to the preview, the projection
  // evidence, and the emit — so all three describe one configuration and one projection
  // snapshot (EFP-2.3): an option change refreshes the report and the graph together.
  const changedOpts = useMemo(
    () => (selected ? changedOptions(optionValues, selected.entry.default_options) : null),
    [selected, optionValues],
  );
  // FMT-3.2: which version of its format the selected target will emit, when it offers more
  // than one. The dialog mounts the same grid as the Studio, so the badge lands in both.
  const dialect = useMemo(
    () => resolveExportDialect(selected?.entry, optionValues),
    [selected, optionValues],
  );

  // The dry-run fidelity preview (advisory + per-construct report, MFX-6.2) for the chosen
  // target and options, fetched while the Fidelity step is showing.
  const {
    preview,
    loading: previewLoading,
    error: previewError,
  } = useExportPreview(open && step === 'fidelity', artifact, version, selectedKey, changedOpts);

  const sourceLabel = artifactLabel || artifact;
  const versionLabel = response?.version_label || version || 'latest';

  const reset = useCallback(() => {
    setStep('source');
    setSelectedKey(null);
    setOptionValues({});
    setExporting(false);
    setEmitted(null);
    setError(null);
    setAcknowledged(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  /**
   * Escalate to the full-page Export Studio (MFX-41.1), carrying the current selection.
   *
   * HIVE-6.3 (#5314) made "the current selection" mean all of it. The link used to carry the
   * source coordinates and the chosen target only, so a reader who had picked GraphQL, unticked
   * *Emit input types* and read the fidelity report arrived in the Studio back at defaults, on
   * step one. It now carries the non-default option overrides and the equivalent stepper stop
   * as well — the same `opts` / `step` params the version panel's *Re-run in Studio* and the
   * Studio's own *Copy link* already use, so the three ways of reaching the Studio agree.
   */
  const openInStudio = useCallback(() => {
    const href = exportStudioHref({
      artifact,
      version,
      label: artifactLabel,
      target: selectedKey,
      origin: studioOrigin,
      sourceFormat,
      options: changedOpts,
      step: studioStepForDialogStep(step, Boolean(selectedKey)),
    });
    handleClose();
    router.push(href);
  }, [
    artifact,
    version,
    artifactLabel,
    selectedKey,
    studioOrigin,
    sourceFormat,
    changedOpts,
    step,
    handleClose,
    router,
  ]);

  /** Select a target card and seed the options form with that target's defaults. */
  const handleSelect = useCallback((card: ExportTargetCard) => {
    if (!card.available) return;
    setSelectedKey(card.key);
    setError(null);
    // A different target is a different conversion — its loss must be re-acknowledged.
    setAcknowledged(false);
    const defaults: Record<string, unknown> = {};
    for (const field of optionFieldsFromSchema(card.entry.options_schema, card.entry.default_options)) {
      defaults[field.key] = field.defaultValue;
    }
    setOptionValues(defaults);
  }, []);

  const setOption = useCallback((key: string, value: unknown) => {
    setOptionValues((current) => ({ ...current, [key]: value }));
    // A different option is a different conversion (EFP-2.3): the old acknowledgement no
    // longer describes what would be exported, so it clears; the preview and the projection
    // evidence re-fetch for the new configuration together.
    setAcknowledged(false);
  }, []);

  /** Emit the document for the selected target and show it in the preview card (MFX-6.3). */
  const handleExport = useCallback(async () => {
    if (!selected) return;
    setStep('export');
    setExporting(true);
    setError(null);
    try {
      const res = await fetch('/api/export/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact,
          version: version || null,
          target: selected.key,
          options: changedOptions(optionValues, selected.entry.default_options),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          typeof data?.error === 'string' ? data.error : 'The export failed. Try again.',
        );
      }
      const text = await res.text();
      const filename =
        filenameFromDisposition(res.headers.get('content-disposition')) ||
        `${artifact}-${selected.key}.txt`;
      setEmitted({ filename, mediaType: res.headers.get('content-type') || '', text });
      onExported?.({
        targetKey: selected.key,
        targetLabel: selected.entry.descriptor.label,
        tier: selected.entry.fidelity.tier,
        preservedPercent: selected.entry.fidelity.preserved_percent,
        filename,
        options: changedOptions(optionValues, selected.entry.default_options),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export failed. Try again.');
      setStep('fidelity');
    } finally {
      setExporting(false);
    }
  }, [artifact, onExported, optionValues, selected, version]);

  /** Download the previewed document as its single file (MFX-6.3). */
  const handleDownloadFile = useCallback(() => {
    if (!emitted) return;
    downloadBlob(
      new Blob([emitted.text], { type: emitted.mediaType || 'text/plain' }),
      emitted.filename,
    );
  }, [emitted]);

  /**
   * Download the previewed document as a `.zip` built client-side (MFX-6.3). The bundle
   * holds the file(s) the emit returned — the primary document today; every bundle file
   * once the multi-file endpoint (MFX-4.2) lands.
   */
  const handleDownloadZip = useCallback(() => {
    if (!emitted) return;
    try {
      const bytes = buildZip([{ path: emitted.filename, content: emitted.text }]);
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), zipFilenameFor(emitted.filename));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The zip download failed. Try again.');
    }
  }, [emitted]);

  const stepIndex = STEP_ORDER.indexOf(step);
  const fidelity = selected?.entry.fidelity ?? null;
  // Lossy conversions gate the download behind the explicit "Export anyway" acknowledgement
  // (MFX-6.2). Driven by the coarse tier so the gate never depends on the preview fetch.
  const needsAck = fidelity ? requiresExportAcknowledgement(fidelity.tier) : false;

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? handleClose() : undefined)}>
      <DialogContent className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            Export “{sourceLabel}” {versionLabel !== 'latest' ? `v${versionLabel}` : ''}
          </DialogTitle>
          <DialogDescription>
            Pick a target format and options. Each target shows how faithfully this source
            survives the conversion before you commit to it.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 grid shrink-0 grid-cols-4 gap-2 text-xs">
          {STEP_LABELS.map((label, idx) => (
            <div
              key={label}
              className={`rounded-full border px-3 py-1.5 text-center ${
                idx <= stepIndex
                  ? 'border-accent bg-accent-soft font-medium text-accent-fg'
                  : 'border-border text-fg-muted'
              }`}
            >
              {idx + 1}. {label}
            </div>
          ))}
        </div>

        {(error || targetsError) && (
          <Alert variant="error" className="mt-3 shrink-0">
            {error || targetsError}
          </Alert>
        )}

        <div
          data-testid="export-dialog-body"
          className={cn(
            'mt-4 flex flex-col',
            step === 'export' && emitted
              ? 'h-[60vh] min-h-[420px] overflow-hidden'
              : 'h-[60vh] min-h-[420px] overflow-y-auto',
          )}
        >
        {step === 'source' && (
          <div className="space-y-4">
            <div className="vdlg-export__card">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg">
                <Package className="h-4 w-4 text-accent" aria-hidden />
                Source
              </div>
              <div className="my-3 h-px bg-inset" />
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-fg-muted">
                  <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
                  Measuring export fidelity for this source…
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-sm font-medium text-fg">
                    {sourceLabel}
                  </div>
                  <div className="text-xs text-fg-muted">
                    Version {versionLabel}
                    {response ? ` · ${cards.length} export targets available` : ''}
                  </div>
                </div>
              )}
            </div>
            <p className="text-xs text-fg-muted">
              Export is scoped to this version: the fidelity badge on every target card is
              computed for this source, not a generic estimate.
            </p>
          </div>
        )}

        {step === 'target' && (
          <div className="space-y-4">
            {sourceFormat && <OriginalSourceOption artifact={artifact} sourceFormat={sourceFormat} />}
            <ExportTargetGrid
              cards={cards}
              selectedKey={selectedKey}
              onSelect={handleSelect}
              readiness={readiness}
              preflight={preflight}
              order={targetOrder}
              onOrderChange={setTargetOrder}
              dialect={dialect}
              heading={
                <div className="text-center">
                  <div className="text-sm font-semibold text-fg">
                    Choose a target format
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">
                    Fidelity badges are computed for <strong>this</strong> source (version{' '}
                    {versionLabel}).
                  </p>
                </div>
              }
            />

            {selected && optionFields.length > 0 && (
              <div className="vdlg-export__card">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg">
                  <SlidersHorizontal className="h-4 w-4 text-accent" aria-hidden />
                  Target options
                </div>
                <div className="my-3 h-px bg-inset" />
                <ExportOptionsForm
                  targetKey={selected.key}
                  fields={optionFields}
                  values={optionValues}
                  onChange={setOption}
                />
              </div>
            )}
          </div>
        )}

        {step === 'fidelity' && selected && fidelity && (
          <div className="space-y-4">
            <FidelityWarningPanel
              targetLabel={selected.entry.descriptor.label}
              targetDescription={selected.entry.descriptor.description}
              fidelity={fidelity}
              preview={preview}
              previewLoading={previewLoading}
              previewError={previewError}
              acknowledged={acknowledged}
              onAcknowledgedChange={setAcknowledged}
            />
            {/* The destination-aware projection map (EFP-2.2) with its evidence drawer
                (EFP-2.3): where each construct lands, why, and what to do about it. Fetches
                the evidence for the same (source, target, changed-options) the preview above
                described, so both always show one projection snapshot. The drawer's safe
                remediation navigates back to the Target step (targets and options both live
                there in this dialog); an actual change re-previews and re-gates. */}
            <ProjectionGraphPanel
              artifact={artifact}
              version={version}
              target={selected.key}
              targetLabel={selected.entry.descriptor.label}
              options={changedOpts}
              envelopeProjection={preview?.fidelity.projection ?? null}
              enabled={open && step === 'fidelity'}
              onChangeTarget={() => setStep('target')}
              onChangeOptions={() => setStep('target')}
            />
          </div>
        )}

        {step === 'export' &&
          (emitted ? (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <p className="shrink-0 text-xs text-fg-muted">
                <CheckCircle2 className="mr-1.5 inline h-4 w-4 text-ok align-text-bottom" aria-hidden />
                Review <strong>{emitted.filename}</strong> below, then download the file or a .zip bundle.
              </p>
              <ArtifactPreviewCard
                className="min-h-0 flex-1"
                artifact={emitted}
                report={preview?.fidelity.report ?? null}
                targetKey={selected?.key ?? null}
              />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-accent" aria-hidden />
              <div className="text-sm text-fg">
                Emitting {selected?.entry.descriptor.label ?? 'the document'}…
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex shrink-0 justify-between gap-2 border-t border-border pt-3">
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleClose} disabled={exporting}>
              {emitted ? 'Close' : 'Cancel'}
            </Button>
            {!emitted && (
              <Button
                variant="ghost"
                onClick={openInStudio}
                disabled={exporting}
                title="Open this export in the full-page Export Studio, carrying your selection."
              >
                <PanelsTopLeft className="h-4 w-4" aria-hidden />
                Open in Export Studio
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {(step === 'target' || step === 'fidelity') && (
              <Button
                variant="outline"
                onClick={() => setStep(step === 'fidelity' ? 'target' : 'source')}
              >
                Back
              </Button>
            )}
            {step === 'source' && (
              <Button onClick={() => setStep('target')} disabled={loading || !response}>
                <FileOutput className="h-4 w-4" aria-hidden />
                Choose target
              </Button>
            )}
            {step === 'target' && (
              <Button onClick={() => setStep('fidelity')} disabled={!selected}>
                Continue
              </Button>
            )}
            {step === 'fidelity' && (
              <Button
                onClick={() => void handleExport()}
                disabled={exporting || (needsAck && !acknowledged)}
                title={
                  needsAck && !acknowledged
                    ? 'Acknowledge the fidelity loss to enable the export.'
                    : undefined
                }
              >
                <Download className="h-4 w-4" aria-hidden />
                {needsAck ? 'Export anyway' : 'Export'}
              </Button>
            )}
            {step === 'export' && emitted && (
              <>
                <Button variant="outline" onClick={handleDownloadZip}>
                  <FileArchive className="h-4 w-4" aria-hidden />
                  Download .zip
                </Button>
                <Button variant="outline" onClick={handleDownloadFile}>
                  <Download className="h-4 w-4" aria-hidden />
                  Download {emitted.filename}
                </Button>
                <Button onClick={handleClose}>Done</Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ExportDialog;
