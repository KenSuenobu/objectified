'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileArchive,
  FileOutput,
  Loader2,
  Package,
  PanelsTopLeft,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Alert';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelPaddedClass,
} from '../dashboardScreenClasses';
import { useExportTargets } from './useExportTargets';
import { useExportVerify } from './useExportVerify';
import { useExportJob } from './useExportJob';
import { GenerateProgress } from './GenerateProgress';
import { useCatalogSourceContext } from './useCatalogSourceContext';
import type { EmittedValidationReport } from './exportVerify';
import { FormatPill } from '../../../ui/catalog/FormatPill';
import { ProtocolPill } from '../../../ui/catalog/ProtocolPill';
import { ExportTargetGrid } from './ExportTargetGrid';
import type { ExportTargetOrder } from './exportReadiness';
import { useExportPreflight } from './useExportPreflight';
import { ExportOptionsForm } from './ExportOptionsForm';
import { VerifyWorkbench, VerdictBanner } from './VerifyWorkbench';
import { ProjectionGraphPanel } from './ProjectionGraphPanel';
import { ArtifactPreviewCard } from './ArtifactPreviewCard';
import { BundleExplorer } from './BundleExplorer';
import { OriginalSourceOption } from './OriginalSourceOption';
import { deriveVerifyVerdict, verifyGatePasses } from './exportVerify';
import { zipFilenameFor, type EmittedArtifact } from './exportArtifactPreview';
import {
  collectLocatedProblems,
  problemsForFile,
  type LocatedProblem,
  type ProblemRevealRequest,
} from './exportProblemMarkers';
import {
  buildBundleManifest,
  countFindingsByFile,
  isMultiFileBundle,
  normalizeBundlePath,
  type BundleManifest,
} from './exportBundle';
import { buildZip, looksLikeZip, readZip } from './zipBundle';
import { downloadBlob, filenameFromDisposition } from './exportDownload';
import { resolveStudioBack } from './exportStudioLink';
import type { ExportedArtifactSummary } from './ExportDialog';
import {
  changedOptions,
  exportTargetCards,
  filterSameFormatTargets,
  optionFieldsFromSchema,
  tierBadgeClass,
  tierLabel,
  validateExportOptions,
  type ExportTargetCard,
} from './exportTargetCatalog';

interface ExportStudioProps {
  /** The artifact (project / catalog-item) id to export — export is version-scoped. */
  artifact: string;
  /** Human name of the source, shown in the header; falls back to the id. */
  artifactLabel?: string | null;
  /** The revision to export (UUID or version label); the latest revision when omitted. */
  version?: string | null;
  /** A target emitter key to pre-select (carried from the ExportDialog escalation). */
  initialTarget?: string | null;
  /**
   * Non-default option overrides to pre-fill for {@link initialTarget}, so a "re-run in Studio"
   * (MFX-41.3) reproduces the prior run's configuration. Applied over the target's defaults once,
   * during the same seeding pass that selects the target; ignored without an `initialTarget`.
   */
  initialOptions?: Record<string, unknown> | null;
  /** Where the export was launched from — resolves the back link (Versions vs Catalog). */
  origin?: string | null;
  /**
   * The source's original import format (e.g. `graphql`), when known (catalog sources). Hides the
   * redundant same-format target and offers the original source unchanged instead.
   */
  sourceFormat?: string | null;
  /** Called after a successful generate, so an entry point can record it as a recent export. */
  onGenerated?: (summary: ExportedArtifactSummary) => void;
}

/** The Studio's five stepper stops (MFX-41.1). */
type StudioStep = 'source' | 'target' | 'options' | 'verify' | 'review';

const STUDIO_STEPS: { key: StudioStep; label: string }[] = [
  { key: 'source', label: 'Source' },
  { key: 'target', label: 'Target' },
  { key: 'options', label: 'Options' },
  { key: 'verify', label: 'Verify' },
  { key: 'review', label: 'Review & Generate' },
];

const STEP_ORDER: StudioStep[] = STUDIO_STEPS.map((s) => s.key);

/**
 * ExportStudio — the full-page export workspace (MFX-41.1, #4348).
 *
 * The ExportDialog (MFX-6.1) is the quick modal path; the Studio is where an enterprise user can
 * *work* an export: a numbered stepper **Source → Target → Options → Verify → Review & Generate**
 * over the same registry-driven target grid and generated options form the dialog uses (shared
 * components, not forks). Each step gates forward navigation — no Verify until a target is picked,
 * no Options step advance until the options validate, and no Generate until the Verify workbench
 * (MFX-42.1) has run and returned a passing verdict (or a lossy one the user acknowledged). The
 * stepper's state (selected target, option values, verify verdict) survives moving back and forth
 * between steps.
 *
 * The route is always scoped to a source (`artifact` [+ `version`]); it is never a bare global
 * screen. The ExportDialog's "Open in Export Studio" footer action lands here with the source —
 * and, when one was picked, the target — pre-selected.
 */
export function ExportStudio({
  artifact,
  artifactLabel,
  version = null,
  initialTarget = null,
  initialOptions = null,
  origin = null,
  sourceFormat = null,
  onGenerated,
}: ExportStudioProps) {
  const [step, setStep] = useState<StudioStep>('source');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [optionValues, setOptionValues] = useState<Record<string, unknown>>({});
  /** Whether the user acknowledged a lossy conversion ("Export anyway"). */
  const [acknowledged, setAcknowledged] = useState(false);
  /** The emitted document being reviewed on the Review step, once generated + downloaded. */
  const [emitted, setEmitted] = useState<EmittedArtifact | null>(null);
  /** The emitted bundle when the target produced multiple files (MFX-43.2); null for single-file. */
  const [bundle, setBundle] = useState<BundleManifest | null>(null);
  /** A pending "open this finding in the Review editor" request (MFX-43.3), from a lens click. */
  const [problemReveal, setProblemReveal] = useState<ProblemRevealRequest | null>(null);
  /** Monotonic nonce so re-clicking the same finding still re-triggers the reveal. */
  const revealNonce = useRef(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * The validation report from a validation-gate job failure (MFX-46.2). When set, the Verify
   * step renders it in place of the last verify result so the user sees exactly what the real emit
   * was rejected for, and the Generate gate re-locks until they re-verify.
   */
  const [jobValidationOverride, setJobValidationOverride] = useState<EmittedValidationReport | null>(
    null,
  );

  const { response, loading, error: targetsError } = useExportTargets(true, artifact, version);
  // IXH-2.4: rank the same targets by expected outcome — source lint grade, projected fidelity,
  // capability fit, and the tenant's export policy — so the grid leads with the best bet and shows
  // a policy-blocked target as blocked rather than as just another card.
  const { report: preflight, readiness } = useExportPreflight(true, artifact, version);
  const [targetOrder, setTargetOrder] = useState<ExportTargetOrder>('readiness');
  // Drop the redundant same-format target (e.g. GraphQL→GraphQL); the "Original source" option
  // replaces it when the source's format is known.
  const cards = useMemo(
    () => filterSameFormatTargets(exportTargetCards(response), sourceFormat),
    [response, sourceFormat],
  );
  const backTarget = useMemo(() => resolveStudioBack(origin), [origin]);
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
  const validation = useMemo(
    () => validateExportOptions(optionFields, optionValues),
    [optionFields, optionValues],
  );
  // Only the non-default overrides are sent (to verify and to generate), so the two dry-run and
  // real emits share one configuration — a verify verdict always describes what Generate produces.
  const changedOpts = useMemo(
    () => (selected ? changedOptions(optionValues, selected.entry.default_options) : null),
    [selected, optionValues],
  );

  // The one-call, pre-generation Verify (MFX-42.1): a manual "Run verification" dry-run that
  // returns all three lenses (fidelity + validation + lint) and a go/no-go verdict without
  // emitting an artifact. Its result lives here so the Review step shows the same verdict.
  const {
    result: verifyResult,
    running: verifyRunning,
    hasRun: verifyHasRun,
    error: verifyError,
    run: runVerify,
    reset: resetVerify,
  } = useExportVerify(artifact, version, selectedKey, changedOpts);
  const verifyVerdict = verifyResult ? deriveVerifyVerdict(verifyResult) : null;

  // The async export job (MFX-46.2): Generate submits a job that runs the emit → fidelity →
  // validate → package pipeline and reports staged progress. The tracker keeps polling across
  // navigation and toasts on background completion, so `job` reflects the current run for this
  // source even after leaving and returning.
  const { job, submitting, start, retry, cancel, clear } = useExportJob(artifact, version);
  const jobStatus = job?.status ?? null;
  const jobState = jobStatus?.state ?? null;
  const jobCompleted = jobState === 'completed' && !jobStatus?.result?.dry_run;

  // When the Verify step is showing a validation-gate override, the last verify verdict no longer
  // reflects reality: present it as `invalid` and re-lock Generate until the user re-verifies.
  const displayVerifyResult =
    jobValidationOverride && verifyResult
      ? { ...verifyResult, validation: jobValidationOverride, verdict: 'invalid' as const }
      : verifyResult;
  const displayVerifyVerdict = jobValidationOverride ? ('invalid' as const) : verifyVerdict;

  // Catalog-launched exports (MFX-41.2) show the item's provenance on the Source step so a
  // non-OpenAPI import is recognizable before a target is chosen. The context is advisory: it
  // never gates the export, so a failed fetch simply hides the extra pills.
  const isCatalogSource = origin === 'catalog';
  const { context: catalogContext } = useCatalogSourceContext(isCatalogSource, artifact);
  // Prefer the URL-carried format (instant, no round-trip) and fall back to the fetched context.
  const catalogFormat = sourceFormat ?? catalogContext?.sourceFormat ?? null;

  const sourceLabel = artifactLabel || artifact;
  const versionLabel = response?.version_label || version || 'latest';

  // The source's own catalog lint report, linked from the Verify lint lens's distinguishing note so
  // the emitted-artifact lint is never conflated with the source's catalog lint (MFX-42.3). Only
  // catalog sources have a catalog detail (with its Lint & Score tab) to link to.
  const sourceLintReport = useMemo(
    () =>
      isCatalogSource
        ? { href: `/ade/dashboard/catalog/${encodeURIComponent(artifact)}`, label: sourceLabel }
        : null,
    [isCatalogSource, artifact, sourceLabel],
  );

  const fidelity = selected?.entry.fidelity ?? null;

  // Guards the "fetch the completed artifact once" effect so a re-render never re-downloads.
  const downloadedJobRef = useRef<string | null>(null);

  /**
   * Forget the active export job and any generated artifact — called whenever the configuration
   * changes (a new target or option), so a stale job/preview from the previous config never
   * lingers into a new Generate.
   */
  const clearActiveJob = useCallback(() => {
    clear();
    setJobValidationOverride(null);
    setEmitted(null);
    downloadedJobRef.current = null;
  }, [clear]);

  /**
   * Select a target card and seed the options form with that target's defaults. When `seedOptions`
   * is given (a re-run's prior overrides, MFX-41.3), its values replace the defaults for the
   * matching option keys — foreign keys are ignored, so a stale or hand-edited override can never
   * inject an option the target doesn't have.
   */
  const selectCard = useCallback(
    (card: ExportTargetCard, seedOptions?: Record<string, unknown> | null) => {
      if (!card.available) return;
      setSelectedKey(card.key);
      setError(null);
      // A different target is a different conversion: its loss and verify must be re-established,
      // and any artifact/bundle from the previous target no longer describes it.
      setAcknowledged(false);
      setEmitted(null);
      setBundle(null);
      setProblemReveal(null);
      resetVerify();
      const values: Record<string, unknown> = {};
      for (const field of optionFieldsFromSchema(card.entry.options_schema, card.entry.default_options)) {
        values[field.key] =
          seedOptions && Object.prototype.hasOwnProperty.call(seedOptions, field.key)
            ? seedOptions[field.key]
            : field.defaultValue;
      }
      setOptionValues(values);
    },
    [resetVerify],
  );

  // Pre-select the target carried from the dialog escalation (and pre-fill a re-run's prior
  // options, MFX-41.3), once the target list has loaded. Runs at most once (guarded by the ref)
  // so a later manual re-pick is never overwritten.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !initialTarget || cards.length === 0) return;
    const card = cards.find((c) => c.key === initialTarget);
    if (!card) return;
    seeded.current = true;
    selectCard(card, initialOptions);
  }, [initialTarget, initialOptions, cards, selectCard]);

  const setOption = useCallback(
    (key: string, value: unknown) => {
      setOptionValues((current) => ({ ...current, [key]: value }));
      // The configuration changed: any prior verdict no longer describes what Generate would
      // produce, so re-lock the gate until the user re-runs verification (auto re-verify is
      // MFX-42.6). Acknowledgement is tied to that verdict, so it clears with it, and any
      // already-generated artifact/bundle is stale.
      setAcknowledged(false);
      setEmitted(null);
      setBundle(null);
      setProblemReveal(null);
      resetVerify();
      clearActiveJob();
    },
    [resetVerify, clearActiveJob],
  );

  /** Pick a target from the grid — a manual re-pick forgets any job from the previous target. */
  const handleSelectCard = useCallback(
    (card: ExportTargetCard) => {
      clearActiveJob();
      selectCard(card);
    },
    [clearActiveJob, selectCard],
  );

  // Resume a job that is still running (or finished) for this source after navigating away and
  // back (MFX-46.2 / MFX-41.4): once the targets load, re-select the job's target and land on the
  // Review step so the staged progress (or the result) is where the user left it. Runs at most
  // once, and never fights an explicit target already chosen this mount.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !job || cards.length === 0) return;
    resumed.current = true;
    if (selectedKey) return;
    const card = cards.find((c) => c.key === job.params.target);
    if (!card) return;
    selectCard(card, job.params.options);
    setStep('review');
  }, [job, cards, selectedKey, selectCard]);

  /** Submit an export job for the selected target (MFX-46.2); progress renders on Review. */
  const handleGenerate = useCallback(() => {
    if (!selected) return;
    setError(null);
    setEmitted(null);
    setBundle(null);
    setProblemReveal(null);
    downloadedJobRef.current = null;
    const acceptedSnapshot =
      displayVerifyResult?.fidelity?.projection?.manifest_hash ?? null;
    start({
      target: selected.key,
      targetLabel: selected.entry.descriptor.label,
      options: changedOptions(optionValues, selected.entry.default_options),
      // A conversion past the lossy acknowledgement is confirmed, so the transcoding guard
      // (MFX-3.3) does not fail a severe-but-acknowledged job.
      confirm: acknowledged,
      acknowledgedSnapshot: acceptedSnapshot,
    });
  }, [selected, optionValues, acknowledged, displayVerifyResult, start]);

  /** Re-run verification, dropping any validation-gate override so the fresh result shows. */
  const handleRunVerify = useCallback(() => {
    setJobValidationOverride(null);
    void runVerify();
  }, [runVerify]);

  /** Route a validation-gate job failure back to the Verify lenses with its findings loaded. */
  const handleFixInVerify = useCallback(
    (validation: EmittedValidationReport | null) => {
      setJobValidationOverride(validation);
      clear();
      downloadedJobRef.current = null;
      setStep('verify');
    },
    [clear],
  );

  /** Acknowledge a severe conversion and re-submit the job with confirmation (MFX-3.3). */
  const handleAcknowledgeAndRetry = useCallback(() => {
    setAcknowledged(true);
    void retry({ confirm: true });
  }, [retry]);

  /** Route a stale-preview failure back to Verify so the user re-runs and re-acknowledges (EFP-3.1). */
  const handleRefreshPreview = useCallback(() => {
    clear();
    downloadedJobRef.current = null;
    setAcknowledged(false);
    resetVerify();
    setStep('verify');
  }, [clear, resetVerify]);

  // Once a real export job completes, fetch its emitted artifact (single document or bundle) so the
  // Review step can preview and download it, and record the recent export. Runs once per job id.
  useEffect(() => {
    const result = jobStatus?.state === 'completed' ? jobStatus.result : null;
    if (!job?.jobId || !result || result.dry_run) return;
    if (!selected || selected.key !== result.target) return;
    if (downloadedJobRef.current === job.jobId) return;
    const jobId = job.jobId;
    downloadedJobRef.current = jobId;
    let cancelled = false;
    let settled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/export/jobs/${encodeURIComponent(jobId)}/download`, {
          credentials: 'include',
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            typeof data?.error === 'string'
              ? data.error
              : 'The export generated but the artifact could not be downloaded.',
          );
        }
        const contentType = res.headers.get('content-type') || result.media_type || '';
        const bytes = new Uint8Array(await res.arrayBuffer());
        const filename = filenameFromDisposition(res.headers.get('content-disposition'));
        if (cancelled) return;
        let emittedFilename = `${artifact}-${result.target}.txt`;
        if (looksLikeZip(bytes, contentType)) {
          const files = await readZip(bytes);
          const manifest = buildBundleManifest(
            files.map((file) => ({ path: file.path, text: file.text })),
          );
          setBundle(manifest);
          setProblemReveal(null);
          const primary = manifest.files[0];
          emittedFilename = primary.path;
          setEmitted({
            filename: primary.path,
            mediaType: primary.mediaType,
            text: primary.text,
          });
        } else {
          const text = new TextDecoder('utf-8').decode(bytes);
          emittedFilename = filename || `${artifact}-${result.target}.txt`;
          setBundle(null);
          setEmitted({ filename: emittedFilename, mediaType: contentType, text });
        }
        const targetCard = cards.find((card) => card.key === result.target);
        if (targetCard) {
          onGenerated?.({
            targetKey: targetCard.key,
            targetLabel: targetCard.entry.descriptor.label,
            tier: targetCard.entry.fidelity.tier,
            preservedPercent: targetCard.entry.fidelity.preserved_percent,
            filename: emittedFilename,
            options: job.params.options,
          });
        }
        settled = true;
      } catch (e) {
        if (cancelled) return;
        // Allow the fetch to be retried (e.g. by re-generating) after a transient download error.
        downloadedJobRef.current = null;
        setError(
          e instanceof Error ? e.message : 'The generated artifact could not be downloaded.',
        );
        settled = true;
      }
    })();
    return () => {
      cancelled = true;
      if (!settled && downloadedJobRef.current === jobId) {
        downloadedJobRef.current = null;
      }
    };
    // `jobStatus` is derived from `job`; depending on `job` alone keeps this to one run per job id.
  }, [job, jobStatus, artifact, selected, cards, onGenerated]);

  /** Download the generated document as its single file. */
  const handleDownloadFile = useCallback(() => {
    if (!emitted) return;
    downloadBlob(
      new Blob([emitted.text], { type: emitted.mediaType || 'text/plain' }),
      emitted.filename,
    );
  }, [emitted]);

  /**
   * Download the generated export as a `.zip` built client-side. For a multi-file bundle every
   * member is packed (MFX-43.2); for a single document the one file is packed as before.
   */
  const handleDownloadZip = useCallback(() => {
    if (!emitted && !bundle) return;
    try {
      const entries = bundle
        ? bundle.files.map((file) => ({ path: file.path, content: file.text }))
        : [{ path: emitted!.filename, content: emitted!.text }];
      const zipName = zipFilenameFor(bundle ? bundle.primaryPath : emitted!.filename);
      const bytes = buildZip(entries);
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), zipName);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The zip download failed. Try again.');
    }
  }, [bundle, emitted]);

  // Per-file finding counts for the bundle tree/tabs badges (MFX-43.2): the Verify lenses' located
  // validation + lint findings, bucketed by the bundle file they name.
  const bundleFindingCounts = useMemo(
    () =>
      countFindingsByFile(
        verifyResult?.validation.findings ?? [],
        verifyResult?.lint?.findings ?? [],
      ),
    [verifyResult],
  );

  // The Verify lenses' located problems (MFX-43.3): findings with a real line number, unified
  // across validation + lint. These drive the Review viewers' markers/gutter/problems list and
  // the lenses' click-through rows.
  const locatedProblems = useMemo(
    () =>
      collectLocatedProblems(
        verifyResult?.validation.findings ?? [],
        verifyResult?.lint?.findings ?? [],
      ),
    [verifyResult],
  );

  // The problems a Verify lens click can actually open (MFX-43.3). Nothing is openable until a
  // generated artifact exists; a multi-file bundle can open only problems naming one of its files
  // (an unfiled problem has no unambiguous home there); a single document also owns the unfiled
  // ones — the only file the location can mean.
  const openableProblems = useMemo(() => {
    if (bundle && isMultiFileBundle(bundle)) {
      const paths = new Set(bundle.files.map((file) => file.path));
      return locatedProblems.filter((p) => p.file !== null && paths.has(p.file));
    }
    if (emitted) {
      return problemsForFile(locatedProblems, normalizeBundlePath(emitted.filename), {
        includeUnfiled: true,
      });
    }
    return [];
  }, [bundle, emitted, locatedProblems]);

  /** Open a located finding on the Review step: jump there and ask the viewer to reveal it. */
  const openProblem = useCallback((problem: LocatedProblem) => {
    revealNonce.current += 1;
    setProblemReveal({ problem, nonce: revealNonce.current });
    setStep('review');
  }, []);

  /** Whether the current step permits advancing to the next one. */
  const canAdvance = useMemo(() => {
    switch (step) {
      case 'source':
        return Boolean(response) && !loading;
      case 'target':
        return Boolean(selected);
      case 'options':
        return Boolean(selected) && validation.valid;
      case 'verify':
        // Generate is gated on the verdict (MFX-42.1): clean proceeds, lossy needs the
        // acknowledgement, invalid is blocked outright, and an unrun/failed verify stays closed. A
        // validation-gate override (MFX-46.2) keeps it closed until the user re-verifies.
        return !jobValidationOverride && verifyGatePasses(verifyVerdict, acknowledged);
      default:
        return false;
    }
  }, [step, response, loading, selected, validation.valid, verifyVerdict, acknowledged, jobValidationOverride]);

  const stepIndex = STEP_ORDER.indexOf(step);
  const goBack = useCallback(() => {
    setStep(STEP_ORDER[Math.max(0, stepIndex - 1)]);
  }, [stepIndex]);
  const goNext = useCallback(() => {
    setStep(STEP_ORDER[Math.min(STEP_ORDER.length - 1, stepIndex + 1)]);
  }, [stepIndex]);

  return (
    <main className={dashboardMainClass} data-testid="export-studio">
      <div className={dashboardContentStackClass}>
        <div>
          <Link
            href={backTarget.href}
            className="mb-2 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to {backTarget.label}
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
            <PanelsTopLeft className="h-6 w-6 text-indigo-500" aria-hidden />
            Export Studio
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
            Verify a conversion before you generate it. Exporting{' '}
            <strong className="text-gray-900 dark:text-gray-100">{sourceLabel}</strong>
            {versionLabel !== 'latest' ? ` (version ${versionLabel})` : ''}.
          </p>
        </div>

        {/* The numbered stepper (MFX-41.1) — the ImportDialog/ExportDialog pill pattern, full width. */}
        <ol
          data-testid="export-studio-stepper"
          className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5"
        >
          {STUDIO_STEPS.map((s, idx) => {
            const state = idx === stepIndex ? 'current' : idx < stepIndex ? 'done' : 'upcoming';
            return (
              <li
                key={s.key}
                data-testid={`export-studio-step-${s.key}`}
                data-state={state}
                aria-current={state === 'current' ? 'step' : undefined}
                className={`rounded-full border px-3 py-1.5 text-center ${
                  state === 'upcoming'
                    ? 'border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400'
                    : 'border-indigo-200 bg-indigo-50 font-medium text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200'
                }`}
              >
                {idx + 1}. {s.label}
              </li>
            );
          })}
        </ol>

        {(error || targetsError) && (
          <Alert variant="error" data-testid="export-studio-error">
            {error || targetsError}
          </Alert>
        )}

        <div className={dashboardPanelPaddedClass} data-testid="export-studio-body">
          {step === 'source' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
                <Package className="h-4 w-4 text-indigo-500" aria-hidden />
                Source
              </div>
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                  <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden />
                  Measuring export fidelity for this source…
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {sourceLabel}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Version {versionLabel}
                    {response ? ` · ${cards.length} export targets available` : ''}
                  </div>
                  {/* Catalog-item context (MFX-41.2, #4349): format + paradigm pills and the
                      normalized counts — the same provenance the catalog detail idhead shows —
                      so the "not an OpenAPI project" source is recognizable here. */}
                  {isCatalogSource && (catalogFormat || catalogContext) && (
                    <div className="space-y-2" data-testid="export-studio-catalog-context">
                      <div className="flex flex-wrap items-center gap-2">
                        <FormatPill format={catalogFormat} />
                        <ProtocolPill protocol={catalogContext?.protocol} />
                      </div>
                      {catalogContext && <CatalogSummaryCounts summary={catalogContext.summary} />}
                    </div>
                  )}
                </div>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Export is scoped to this version: the fidelity badge on every target card is
                computed for this source, not a generic estimate.
                {isCatalogSource
                  ? ' Exporting a catalog item produces an artifact — it never turns the item into a project.'
                  : ''}
              </p>
            </div>
          )}

          {step === 'target' && (
            <div className="space-y-4">
              {sourceFormat && <OriginalSourceOption artifact={artifact} sourceFormat={sourceFormat} />}
              <ExportTargetGrid
                cards={cards}
                selectedKey={selectedKey}
                onSelect={handleSelectCard}
                readiness={readiness}
                preflight={preflight}
                order={targetOrder}
                onOrderChange={setTargetOrder}
                heading={
                  <div className="text-center">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      Choose a target format
                    </div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Fidelity badges are computed for <strong>this</strong> source (version{' '}
                      {versionLabel}).
                    </p>
                  </div>
                }
              />
            </div>
          )}

          {step === 'options' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
                <SlidersHorizontal className="h-4 w-4 text-indigo-500" aria-hidden />
                {selected ? `${selected.entry.descriptor.label} options` : 'Target options'}
              </div>
              <div className="my-1 h-px bg-gray-200 dark:bg-gray-700" />
              {optionFields.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="export-studio-no-options">
                  This target has no options — it exports with its defaults. Continue to verify the
                  conversion.
                </p>
              ) : (
                <ExportOptionsForm
                  targetKey={selected?.key ?? 'target'}
                  fields={optionFields}
                  values={optionValues}
                  errors={validation.errors}
                  onChange={setOption}
                />
              )}
            </div>
          )}

          {step === 'verify' && selected && fidelity && (
            <>
              {jobValidationOverride && (
                <Alert variant="error" data-testid="verify-gate-failure-notice">
                  The generated artifact failed validation. Review the findings below, then fix the
                  source or options and re-run verification before generating again.
                </Alert>
              )}
              <VerifyWorkbench
                targetLabel={selected.entry.descriptor.label}
                targetDescription={selected.entry.descriptor.description}
                fidelitySummary={fidelity}
                running={verifyRunning}
                hasRun={verifyHasRun || Boolean(jobValidationOverride)}
                error={verifyError}
                result={displayVerifyResult}
                verdict={displayVerifyVerdict}
                acknowledged={acknowledged}
                onAcknowledgedChange={setAcknowledged}
                onRun={handleRunVerify}
                sourceLintReport={sourceLintReport}
                openableProblems={openableProblems}
                onOpenProblem={openProblem}
                projectionPanel={
                  // The destination-aware projection map (EFP-2.2) with its evidence drawer
                  // (EFP-2.3): rendered once a verify has settled, for the same (source,
                  // target, changed-options) the verify ran with — so the evidence pages
                  // describe the snapshot whose summary the fidelity lens shows. The drawer's
                  // safe remediation navigates to the Target/Options steps; an actual change
                  // there resets the verify, the acknowledgement, and any generated artifact.
                  displayVerifyResult ? (
                    <ProjectionGraphPanel
                      artifact={artifact}
                      version={version}
                      target={selected.key}
                      targetLabel={selected.entry.descriptor.label}
                      options={changedOpts}
                      envelopeProjection={displayVerifyResult.fidelity?.projection ?? null}
                      enabled
                      onChangeTarget={() => setStep('target')}
                      onChangeOptions={() => setStep('options')}
                    />
                  ) : null
                }
              />
            </>
          )}

          {step === 'review' && selected && (
            <div className="space-y-4">
              {/* The verify verdict follows the user to Review (MFX-42.1): the same banner it saw
                  on the Verify step, so what gated Generate stays visible while generating. */}
              {verifyVerdict && <VerdictBanner verdict={verifyVerdict} />}
              {bundle && isMultiFileBundle(bundle) ? (
                <div className="flex min-h-0 flex-col gap-2">
                  <p className="shrink-0 text-xs text-gray-600 dark:text-gray-300">
                    <CheckCircle2 className="mr-1.5 inline h-4 w-4 align-text-bottom text-green-500" aria-hidden />
                    Generated a <strong>{bundle.files.length}-file bundle</strong>. Navigate the files
                    on the left, then download the .zip.
                  </p>
                  <BundleExplorer
                    manifest={bundle}
                    countsByPath={bundleFindingCounts}
                    targetKey={selected.key}
                    problems={locatedProblems}
                    reveal={problemReveal}
                  />
                </div>
              ) : emitted ? (
                <div className="flex min-h-0 flex-col gap-2">
                  <p className="shrink-0 text-xs text-gray-600 dark:text-gray-300">
                    <CheckCircle2 className="mr-1.5 inline h-4 w-4 align-text-bottom text-green-500" aria-hidden />
                    Generated <strong>{emitted.filename}</strong>. Review it below, then download the
                    file or a .zip bundle.
                  </p>
                  <ArtifactPreviewCard
                    artifact={emitted}
                    report={verifyResult?.fidelity.report ?? null}
                    targetKey={selected.key}
                    problems={openableProblems}
                    reveal={problemReveal}
                  />
                </div>
              ) : job && jobStatus ? (
                jobCompleted ? (
                  // Completed — the emitted artifact is being fetched for the preview/download.
                  <div
                    className="flex flex-col items-center justify-center gap-3 py-10 text-center"
                    data-testid="export-studio-preparing-download"
                  >
                    <Loader2 className="h-8 w-8 animate-spin text-indigo-500" aria-hidden />
                    <div className="text-sm text-gray-700 dark:text-gray-200">
                      Generated {selected.entry.descriptor.label} — preparing your download…
                    </div>
                  </div>
                ) : (
                  <GenerateProgress
                    status={jobStatus}
                    targetLabel={selected.entry.descriptor.label}
                    submitting={submitting}
                    onRetry={handleGenerate}
                    onCancel={cancel}
                    onReconfigureTarget={() => {
                      clearActiveJob();
                      setStep('target');
                    }}
                    onReconfigureOptions={() => {
                      clearActiveJob();
                      setStep('options');
                    }}
                    onAcknowledgeAndRetry={handleAcknowledgeAndRetry}
                    onFixInVerify={handleFixInVerify}
                    onRefreshPreview={handleRefreshPreview}
                  />
                )
              ) : (
                <ExportReviewSummary
                  sourceLabel={sourceLabel}
                  versionLabel={versionLabel}
                  targetLabel={selected.entry.descriptor.label}
                  tierBadge={
                    fidelity ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tierBadgeClass(fidelity.tier)}`}
                      >
                        {tierLabel(fidelity.tier)} · {fidelity.preserved_percent}% preserved
                      </span>
                    ) : null
                  }
                  changedOptionKeys={Object.keys(
                    changedOptions(optionValues, selected.entry.default_options) ?? {},
                  )}
                />
              )}
            </div>
          )}
        </div>

        {/* Step navigation (MFX-41.1): Back / Continue, with Generate + downloads on the last step. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" onClick={goBack} disabled={stepIndex === 0}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back
          </Button>
          <div className="flex flex-wrap gap-2">
            {step === 'source' && (
              <Button onClick={goNext} disabled={!canAdvance}>
                <FileOutput className="h-4 w-4" aria-hidden />
                Choose target
              </Button>
            )}
            {(step === 'target' || step === 'options') && (
              <Button onClick={goNext} disabled={!canAdvance}>
                Continue
              </Button>
            )}
            {step === 'verify' && (
              <Button
                onClick={goNext}
                disabled={!canAdvance}
                title={
                  !canAdvance
                    ? 'Verify the conversion (or skip it) — acknowledge any fidelity loss — to continue.'
                    : undefined
                }
              >
                Continue to review
              </Button>
            )}
            {step === 'review' && !emitted && !job && (
              <Button
                data-testid="export-studio-generate"
                onClick={handleGenerate}
                disabled={submitting}
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                Generate
              </Button>
            )}
            {step === 'review' && emitted && (
              <>
                <Button variant="outline" onClick={handleDownloadZip}>
                  <FileArchive className="h-4 w-4" aria-hidden />
                  Download .zip
                </Button>
                {/* A bundle downloads only as the .zip here; per-file download lands in MFX-43.5. */}
                {!(bundle && isMultiFileBundle(bundle)) && (
                  <Button variant="outline" onClick={handleDownloadFile}>
                    <Download className="h-4 w-4" aria-hidden />
                    Download {emitted.filename}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The normalized-content counts for a catalog source, shown on the Studio Source step (MFX-41.2).
 * Only the counts the import captured (non-null) are shown; a source with none renders nothing.
 */
function CatalogSummaryCounts({
  summary,
}: {
  summary: { services: number | null; operations: number | null; types: number | null; channels: number | null };
}) {
  const entries: { label: string; value: number }[] = [
    { label: 'Services', value: summary.services ?? -1 },
    { label: 'Operations', value: summary.operations ?? -1 },
    { label: 'Types', value: summary.types ?? -1 },
    { label: 'Channels', value: summary.channels ?? -1 },
  ].filter((entry) => entry.value >= 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="export-studio-catalog-counts">
      {entries.map((entry) => (
        <span
          key={entry.label}
          className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-700/60 dark:text-gray-300"
        >
          <span className="font-mono font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {entry.value}
          </span>
          {entry.label}
        </span>
      ))}
    </div>
  );
}

interface ExportReviewSummaryProps {
  sourceLabel: string;
  versionLabel: string;
  targetLabel: string;
  tierBadge: React.ReactNode;
  changedOptionKeys: string[];
}

/** The pre-generate summary on the Review step: what will be generated, before the user commits. */
function ExportReviewSummary({
  sourceLabel,
  versionLabel,
  targetLabel,
  tierBadge,
  changedOptionKeys,
}: ExportReviewSummaryProps) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2" data-testid="export-studio-review-summary">
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Source
        </dt>
        <dd className="mt-1 text-gray-900 dark:text-gray-100">
          {sourceLabel} {versionLabel !== 'latest' ? `· v${versionLabel}` : ''}
        </dd>
      </div>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Target
        </dt>
        <dd className="mt-1 flex items-center gap-2 text-gray-900 dark:text-gray-100">
          {targetLabel}
          {tierBadge}
        </dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Options
        </dt>
        <dd className="mt-1 text-gray-700 dark:text-gray-300">
          {changedOptionKeys.length === 0
            ? 'Defaults for every option.'
            : `Overridden: ${changedOptionKeys.join(', ')}.`}
        </dd>
      </div>
    </dl>
  );
}

export default ExportStudio;
