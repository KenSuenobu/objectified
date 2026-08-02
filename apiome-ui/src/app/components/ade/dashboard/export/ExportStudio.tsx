'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Download,
  FileArchive,
  FileOutput,
  Link2,
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
import { DeliveryGatePanel } from './DeliveryGatePanel';
import { deliveryReportFor } from './exportJob';
import { RecentAsyncJobsPanel } from '../asyncJobs/RecentAsyncJobsPanel';
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
import { ExportManifestPanel } from './ExportManifestPanel';
import { ExportMappingGraphPanel } from './ExportMappingGraphPanel';
import { FidelityLossHeatmapPanel } from './FidelityLossHeatmapPanel';
import { RoundtripComparisonPanel } from './RoundtripComparisonPanel';
import { useExportRoundtrip } from './useExportRoundtrip';
import { useExportPreviewManifest } from './useExportPreviewManifest';
import type { EntityRevealRequest, ExportManifestEntity } from './exportPreviewManifest';
import { OriginalSourceOption } from './OriginalSourceOption';
import { deriveVerifyVerdict, verifyGatePasses } from './exportVerify';
import { describeVerifyConfig } from './exportVerifyCache';
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
import {
  EXPORT_STUDIO_PATH,
  buildExportStudioShareUrl,
  exportStudioHref,
  resolveStudioBack,
  type ExportStudioScope,
} from './exportStudioLink';
import {
  EXPORT_STUDIO_STEP_ORDER,
  describeStudioSourceFailure,
  isExportStudioStep,
  resolveResumableStep,
  type ExportStudioLinkIssue,
  type ExportStudioStep,
} from './exportStudioUrlState';
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
  /**
   * The stepper stop the deep link asked to resume on (MFX-41.4). Clamped to what the link can
   * actually establish — a link cannot carry a verify verdict, so `review` resumes at Verify.
   */
  initialStep?: string | null;
  /**
   * Notices the route's URL parser already produced (unreadable options, redacted credentials),
   * rendered with the ones the Studio derives once the target registry has loaded (MFX-41.4).
   */
  linkIssues?: ExportStudioLinkIssue[];
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

/**
 * The Studio's five stepper stops (MFX-41.1). The key list is owned by `exportStudioUrlState`
 * because the URL's `step` param is validated against it (MFX-41.4); the labels stay here.
 */
type StudioStep = ExportStudioStep;

const STUDIO_STEPS: { key: StudioStep; label: string }[] = [
  { key: 'source', label: 'Source' },
  { key: 'target', label: 'Target' },
  { key: 'options', label: 'Options' },
  { key: 'verify', label: 'Verify' },
  { key: 'review', label: 'Review & Generate' },
];

const STEP_ORDER: readonly StudioStep[] = EXPORT_STUDIO_STEP_ORDER;

/** A stable empty default, so the `linkIssues` prop never changes identity between renders. */
const EMPTY_LINK_ISSUES: ExportStudioLinkIssue[] = [];

/**
 * Seed an options form for a target: every option at its default, overridden by the matching keys
 * of a deep link's overrides. Foreign keys are ignored, so a stale or hand-edited link can never
 * inject an option the target does not have.
 *
 * @param card The selected target card.
 * @param seedOptions The link's overrides (or null for a plain default seed).
 * @returns The option values to render, plus the seed keys the target does not define.
 */
function seedOptionValues(
  card: ExportTargetCard,
  seedOptions?: Record<string, unknown> | null,
): { values: Record<string, unknown>; foreignKeys: string[] } {
  const values: Record<string, unknown> = {};
  const fields = optionFieldsFromSchema(card.entry.options_schema, card.entry.default_options);
  for (const field of fields) {
    values[field.key] =
      seedOptions && Object.prototype.hasOwnProperty.call(seedOptions, field.key)
        ? seedOptions[field.key]
        : field.defaultValue;
  }
  const known = new Set(fields.map((field) => field.key));
  const foreignKeys = seedOptions ? Object.keys(seedOptions).filter((key) => !known.has(key)) : [];
  return { values, foreignKeys };
}

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
  initialStep = null,
  linkIssues = EMPTY_LINK_ISSUES,
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
  /** The manifest explorer's selected entity (IXH-4.1), shared by the tree and the viewer. */
  const [selectedEntityKey, setSelectedEntityKey] = useState<string | null>(null);
  /** A pending "reveal this entity in the code" request (a manifest tree click). */
  const [entityReveal, setEntityReveal] = useState<EntityRevealRequest | null>(null);
  /**
   * Which Review-step surface owns the evidence drawer for the shared entity selection
   * (IXH-4.3). The mapping graph and the loss heatmap render over the same manifest and the
   * same selection, so the evidence has to appear beside the one the user selected from —
   * otherwise one selection opens two identical drawers. The mapping graph owns it by
   * default; every other selection path (the explorer tree, a code-line click) hands it back.
   */
  const [evidenceSurface, setEvidenceSurface] = useState<'mapping' | 'heatmap'>('mapping');
  /** Monotonic nonce so re-selecting the same entity still re-triggers the reveal. */
  const entityRevealNonce = useRef(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * The validation report from a validation-gate job failure (MFX-46.2). When set, the Verify
   * step renders it in place of the last verify result so the user sees exactly what the real emit
   * was rejected for, and the Generate gate re-locks until they re-verify.
   */
  const [jobValidationOverride, setJobValidationOverride] = useState<EmittedValidationReport | null>(
    null,
  );

  const {
    response,
    loading,
    error: targetsError,
    status: targetsStatus,
  } = useExportTargets(true, artifact, version);
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

  /**
   * Whether verification re-runs itself (debounced) after every configuration change — the
   * explicit "Verify automatically" opt-in (MFX-42.6). Off by default: a verify is a real emit,
   * so the user asks for the convenience rather than paying for it silently.
   */
  const [autoVerify, setAutoVerify] = useState(false);

  // The one-call, pre-generation Verify (MFX-42.1): a manual "Run verification" dry-run that
  // returns all three lenses (fidelity + validation + lint) and a go/no-go verdict without
  // emitting an artifact. Its result lives here so the Review step shows the same verdict.
  //
  // The hook keys every result by its (source, target, options) configuration (MFX-42.6): a
  // verdict is exposed only while it still describes what is configured, so changing a target or
  // an option re-locks Generate on its own, and returning to a configuration verified earlier in
  // the session re-displays its verdict instantly instead of re-running the dry-run.
  const {
    result: verifyResult,
    running: verifyRunning,
    hasRun: verifyHasRun,
    error: verifyError,
    run: runVerify,
    reset: resetVerify,
    fromCache: verifyFromCache,
  } = useExportVerify(artifact, version, selectedKey, changedOpts, {
    // Only while the Verify step is showing: a dry-run is a real emit, so browsing the target grid
    // with the opt-in on must not fire one per card the user tries. A change made on an earlier
    // step verifies itself the moment the user arrives at Verify, which is when it is needed.
    auto: autoVerify && step === 'verify',
  });
  const verifyVerdict = verifyResult ? deriveVerifyVerdict(verifyResult) : null;

  // The on-demand round-trip comparison (IXH-4.4): emit → re-import → diff → reconcile with
  // the fidelity report, run only when the Review step's panel action asks for it (there is
  // deliberately no auto mode — the loop is a real emit *plus* a real re-import). Results are
  // keyed by the same (source, target, options) configuration a verify verdict is, so a
  // changed option drops the comparison on its own and re-entering a configuration measured
  // earlier in the session restores it instantly.
  const roundtrip = useExportRoundtrip(artifact, version, selectedKey, changedOpts);

  // The async export job (MFX-46.2): Generate submits a job that runs the emit → fidelity →
  // validate → package pipeline and reports staged progress. The tracker keeps polling across
  // navigation and toasts on background completion, so `job` reflects the current run for this
  // source even after leaving and returning.
  const { job, submitting, start, retry, cancel, clear } = useExportJob(artifact, version);
  const jobStatus = job?.status ?? null;
  const jobState = jobStatus?.state ?? null;
  const jobCompleted = jobState === 'completed' && !jobStatus?.result?.dry_run;
  // The delivery gate's decision, when it has something to say (IXH-2.5): a warning on a delivered
  // artifact, or the reasons a blocked delivery was refused. A clean allow yields null.
  const deliveryDecision = jobStatus ? deliveryReportFor(jobStatus) : null;

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

  // The one-line "which configuration is this verdict for" caption under the verdict banner
  // (MFX-42.6): the target plus the option overrides the verification was measured with.
  const verifyConfigSummary = useMemo(
    () =>
      selected
        ? describeVerifyConfig({
            targetLabel: selected.entry.descriptor.label,
            options: changedOpts,
          })
        : null,
    [selected, changedOpts],
  );

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
      // A different target is a different conversion: its loss and acknowledgement must be
      // re-established, and any artifact/bundle from the previous target no longer describes it.
      // The verdict needs no explicit reset — it is keyed by configuration (MFX-42.6), so it
      // disappears with the target and reappears (from the session cache) if the user comes back.
      setAcknowledged(false);
      setEmitted(null);
      setBundle(null);
      setProblemReveal(null);
      setOptionValues(seedOptionValues(card, seedOptions).values);
    },
    [],
  );

  // The deep link's own state, captured once at mount (MFX-41.4). The Studio writes its session
  // back into the address bar, which re-renders the route with fresh props — reading these from a
  // ref keeps the restore describing the link the user actually opened.
  const link = useRef({ target: initialTarget, options: initialOptions, step: initialStep });
  /** Notices derived once the registry has loaded: an unknown/unavailable target, foreign options. */
  const [resolvedIssues, setResolvedIssues] = useState<ExportStudioLinkIssue[]>(EMPTY_LINK_ISSUES);
  /** False until the deep link has been restored — the URL is not rewritten before then. */
  const [restored, setRestored] = useState(false);

  // Restore the deep link once the target registry has settled (MFX-41.1 escalation, MFX-41.3
  // re-run overrides, MFX-41.4 resumable step). Runs at most once, so a later manual re-pick is
  // never overwritten, and degrades every unverifiable part of the link into a notice: an
  // unregistered or unavailable target lands the user on the Target step with an explanation
  // instead of a silently empty selection.
  const restoring = useRef(false);
  useEffect(() => {
    if (restoring.current || loading) return;
    // Wait for the registry to settle either way; a failed load is explained by its own notice.
    if (!response && !targetsError) return;
    restoring.current = true;
    // A source that would not load is explained by its own notice; nothing about the link's target
    // can be judged against a registry that never arrived, so do not pile a second notice on top.
    if (!response) {
      setRestored(true);
      return;
    }
    const issues: ExportStudioLinkIssue[] = [];
    const requestedTarget = link.current.target;
    const card = requestedTarget ? cards.find((c) => c.key === requestedTarget) ?? null : null;
    let hasTarget = false;
    let optionsValid = false;
    if (requestedTarget && !card) {
      issues.push({
        code: 'target-unknown',
        message: `This link's target (“${requestedTarget}”) is not available for this source. Choose a target below to continue.`,
      });
    } else if (card && !card.available) {
      issues.push({
        code: 'target-unavailable',
        message: `This link's target (${card.entry.descriptor.label}) cannot run for this source${
          card.entry.descriptor.unavailable_reason
            ? `: ${card.entry.descriptor.unavailable_reason}`
            : '.'
        } Choose another target below.`,
      });
    } else if (card) {
      const { values, foreignKeys } = seedOptionValues(card, link.current.options);
      hasTarget = true;
      optionsValid = validateExportOptions(
        optionFieldsFromSchema(card.entry.options_schema, card.entry.default_options),
        values,
      ).valid;
      if (foreignKeys.length > 0) {
        issues.push({
          code: 'options-foreign',
          message: `${foreignKeys.join(', ')} ${
            foreignKeys.length === 1 ? 'is not an option' : 'are not options'
          } of ${card.entry.descriptor.label} and ${
            foreignKeys.length === 1 ? 'was' : 'were'
          } ignored.`,
        });
      }
      selectCard(card, link.current.options);
    }
    if (issues.length > 0) setResolvedIssues(issues);
    const requestedStep = isExportStudioStep(link.current.step) ? link.current.step : null;
    // A target the link could not honour is worth landing on even when no step was carried: the
    // Target step is where the user resolves it.
    const targetProblem = issues.some(
      (issue) => issue.code === 'target-unknown' || issue.code === 'target-unavailable',
    );
    if (requestedStep || targetProblem) {
      setStep(
        resolveResumableStep(requestedStep ?? 'target', { hasTarget, optionsValid }),
      );
    }
    setRestored(true);
  }, [loading, response, targetsError, cards, selectCard]);

  const setOption = useCallback(
    (key: string, value: unknown) => {
      setOptionValues((current) => ({ ...current, [key]: value }));
      // The configuration changed: the prior verdict no longer describes what Generate would
      // produce, so the gate re-locks on its own — the verdict is keyed by configuration
      // (MFX-42.6) and simply stops matching. Acknowledgement is a decision about *that* verdict,
      // so it clears with it, and any already-generated artifact/bundle is stale. With "Verify
      // automatically" on, the new configuration re-verifies itself after a short debounce.
      setAcknowledged(false);
      setEmitted(null);
      setBundle(null);
      setProblemReveal(null);
      clearActiveJob();
    },
    [clearActiveJob],
  );

  /** Pick a target from the grid — a manual re-pick forgets any job from the previous target. */
  const handleSelectCard = useCallback(
    (card: ExportTargetCard) => {
      clearActiveJob();
      selectCard(card);
      // Whatever the link could not honour about *its* target is now moot: the user just chose one.
      setResolvedIssues(EMPTY_LINK_ISSUES);
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

  /**
   * Run verification, dropping any validation-gate override so the fresh result shows.
   *
   * @param force True for the explicit re-run/retry actions, which re-measure the conversion
   *   instead of re-displaying this session's cached verdict for the same configuration.
   */
  const handleRunVerify = useCallback(
    (force?: boolean) => {
      setJobValidationOverride(null);
      void runVerify(force);
    },
    [runVerify],
  );

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

  // IXH-4.1: the structural manifest of the generated artifact. Fetched lazily — only once
  // the Review step is actually showing an artifact — for the same (artifact, version,
  // target, options) the export ran with, so it describes exactly what is on screen.
  const manifestEnabled = step === 'review' && Boolean(bundle || emitted);
  const {
    page: manifestPage,
    entities: manifestEntities,
    loading: manifestLoading,
    error: manifestError,
    complete: manifestComplete,
    loadMore: manifestLoadMore,
  } = useExportPreviewManifest(manifestEnabled, artifact, version, selectedKey, changedOpts);

  // A different target/config or source is a different manifest — drop the stale selection.
  useEffect(() => {
    setSelectedEntityKey(null);
    setEntityReveal(null);
  }, [artifact, version, selectedKey]);

  /**
   * Tree-side selection (IXH-4.1): record it and reveal a located entity in the viewer. The
   * mapping graph is the evidence surface for every selection except the heatmap's own.
   */
  const selectEntity = useCallback((entity: ExportManifestEntity) => {
    setEvidenceSurface('mapping');
    setSelectedEntityKey(entity.key);
    if (entity.location?.line != null) {
      entityRevealNonce.current += 1;
      setEntityReveal({ entity, nonce: entityRevealNonce.current });
    }
  }, []);

  /** Heatmap-side selection (IXH-4.3): the same selection, with the evidence drawn there. */
  const selectEntityFromHeatmap = useCallback(
    (entity: ExportManifestEntity) => {
      selectEntity(entity);
      setEvidenceSurface('heatmap');
    },
    [selectEntity],
  );

  /** Viewer-side selection (IXH-4.1): a code line click highlights its entity in the tree. */
  const handleEntityLineClick = useCallback((entity: ExportManifestEntity) => {
    setEvidenceSurface('mapping');
    setSelectedEntityKey(entity.key);
  }, []);

  /** Clear the shared entity selection (IXH-4.2: closing the mapping evidence drawer). */
  const clearEntitySelection = useCallback(() => {
    setSelectedEntityKey(null);
    setEntityReveal(null);
  }, []);

  /**
   * The canonical → target mapping graph (IXH-4.2), rendered under whichever artifact
   * viewer the Review step is showing. It reads the same manifest walk the explorer does,
   * so the graph, the tree, and the code viewer describe one snapshot and share one
   * selection: a node click reveals the entity in the code, a code-line click highlights
   * the node. The drawer's remediation navigates back to Target/Options, which resets the
   * verify, the acknowledgement, and any generated artifact.
   */
  const mappingGraph = selected ? (
    <ExportMappingGraphPanel
      page={manifestPage}
      entities={manifestEntities}
      loading={manifestLoading}
      error={manifestError}
      complete={manifestComplete}
      onLoadMore={manifestLoadMore}
      targetLabel={selected.entry.descriptor.label}
      selectedEntityKey={selectedEntityKey}
      onSelectEntity={selectEntity}
      onClearSelection={clearEntitySelection}
      showEvidence={evidenceSurface === 'mapping'}
      onChangeTarget={() => setStep('target')}
      onChangeOptions={() => setStep('options')}
    />
  ) : null;

  /**
   * The ranked fidelity-loss heatmap (IXH-4.3), rendered under the mapping graph. It reads
   * the same manifest walk — so the aggregate ring, the map, and this ranking describe one
   * snapshot — and shares the same entity selection, so selecting a cell or a ranked
   * finding opens the same evidence drawer and reveals the entity in the code viewer.
   */
  const lossHeatmap = selected ? (
    <FidelityLossHeatmapPanel
      page={manifestPage}
      entities={manifestEntities}
      loading={manifestLoading}
      error={manifestError}
      complete={manifestComplete}
      onLoadMore={manifestLoadMore}
      targetLabel={selected.entry.descriptor.label}
      selectedEntityKey={selectedEntityKey}
      onSelectEntity={selectEntityFromHeatmap}
      onClearSelection={clearEntitySelection}
      showEvidence={evidenceSurface === 'heatmap'}
      onChangeTarget={() => setStep('target')}
      onChangeOptions={() => setStep('options')}
    />
  ) : null;

  /**
   * The on-demand round-trip comparison (IXH-4.4), rendered under the loss heatmap. Where
   * the graph and the heatmap *predict* the export's fidelity, this panel checks the
   * prediction empirically — emit, re-import, diff — but only when its explicit action is
   * clicked; it never runs as part of showing the Review step.
   */
  const roundtripPanel = selected ? (
    <RoundtripComparisonPanel
      result={roundtrip.result}
      running={roundtrip.running}
      hasRun={roundtrip.hasRun}
      error={roundtrip.error}
      fromCache={roundtrip.fromCache}
      onRun={roundtrip.run}
      targetLabel={selected.entry.descriptor.label}
      options={changedOpts}
    />
  ) : null;

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

  // MFX-41.4: the session as a link. Source, target, non-default options (credential-shaped keys
  // stripped by the builder), and the current step — everything a teammate needs to arrive where
  // this user is. Verify verdicts and acknowledgements are deliberately absent: they are facts
  // about a dry-run, so the recipient re-verifies rather than inheriting a stale go-ahead.
  const shareScope = useMemo<ExportStudioScope>(
    () => ({
      artifact,
      version,
      label: artifactLabel,
      target: selectedKey,
      origin: origin === 'catalog' ? 'catalog' : 'versions',
      sourceFormat,
      options: changedOpts,
      step,
    }),
    [artifact, version, artifactLabel, selectedKey, origin, sourceFormat, changedOpts, step],
  );
  const shareHref = useMemo(() => exportStudioHref(shareScope), [shareScope]);

  // Mirror that link into the address bar, so a reload — or a copy of the URL straight from the
  // browser — reproduces the session. `history.replaceState` (the convention used by the versions
  // screen) keeps it out of the back-button history: stepping through the Studio should not turn
  // Back into an undo stack. Nothing is written until the incoming link has been restored, so the
  // rewrite can never erase the state it is still reading.
  useEffect(() => {
    if (!restored || typeof window === 'undefined') return;
    if (window.location.pathname !== EXPORT_STUDIO_PATH) return;
    if (`${window.location.pathname}${window.location.search}` === shareHref) return;
    window.history.replaceState(null, '', shareHref);
  }, [restored, shareHref]);

  // Everything the link could not honour: the route's parse-time notices (unreadable options,
  // redacted credentials) plus the registry-resolved ones (unknown/unavailable target).
  const linkNotices = useMemo(
    () => [...linkIssues, ...resolvedIssues],
    [linkIssues, resolvedIssues],
  );

  // A failed source load is usually a stale link, not a broken service: say which.
  const sourceError = targetsError
    ? describeStudioSourceFailure(targetsStatus, targetsError)
    : null;

  const stepIndex = STEP_ORDER.indexOf(step);
  const goBack = useCallback(() => {
    setStep(STEP_ORDER[Math.max(0, stepIndex - 1)]);
  }, [stepIndex]);
  const goNext = useCallback(() => {
    setStep(STEP_ORDER[Math.min(STEP_ORDER.length - 1, stepIndex + 1)]);
  }, [stepIndex]);

  // Stepping is a content swap in place, so a keyboard/screen-reader user gets no signal that the
  // page changed under a Continue button that never moves (MFX-41.5). Move focus to the step panel
  // — which is named "Step N of 5: <label>" — whenever the step actually changes, the WAI wizard
  // pattern. The first render (including a deep link resuming mid-flow) is deliberately skipped:
  // landing focus should stay at the top of the route.
  const stepPanelRef = useRef<HTMLDivElement | null>(null);
  const focusedStepRef = useRef<StudioStep>(step);
  useEffect(() => {
    if (focusedStepRef.current === step) return;
    focusedStepRef.current = step;
    stepPanelRef.current?.focus();
  }, [step]);
  const stepPanelLabel = `Step ${stepIndex + 1} of ${STUDIO_STEPS.length}: ${
    STUDIO_STEPS[stepIndex]?.label ?? ''
  }`;

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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
              <PanelsTopLeft className="h-6 w-6 text-indigo-500" aria-hidden />
              Export Studio
            </h1>
            {/* MFX-41.4: "look at this export config" as a URL. */}
            <CopyStudioLinkButton scope={shareScope} />
          </div>
          <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
            Verify a conversion before you generate it. Exporting{' '}
            <strong className="text-gray-900 dark:text-gray-100">{sourceLabel}</strong>
            {versionLabel !== 'latest' ? ` (version ${versionLabel})` : ''}.
          </p>
        </div>

        {/* The numbered stepper (MFX-41.1) — the ImportDialog/ExportDialog pill pattern, full width.
            The three states are distinguished by glyph and weight as well as palette (MFX-41.5): a
            completed step leads with a check and says so to a screen reader, the current step carries
            `aria-current="step"`, and an upcoming step keeps its number outlined. The steps are
            status, not controls — navigation is the Back / Continue pair below. */}
        <ol
          data-testid="export-studio-stepper"
          aria-label="Export steps"
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
                className={`flex items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-center ${
                  state === 'upcoming'
                    ? 'border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400'
                    : state === 'done'
                      ? 'border-emerald-200 bg-emerald-50 font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                      : 'border-indigo-500 bg-indigo-50 font-semibold text-indigo-800 ring-2 ring-indigo-200 dark:border-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-100 dark:ring-indigo-900'
                }`}
              >
                {state === 'done' ? (
                  <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                ) : (
                  <span aria-hidden>{idx + 1}.</span>
                )}
                {s.label}
                <span className="sr-only">
                  {state === 'done'
                    ? ' — completed'
                    : state === 'current'
                      ? ` — current step, ${idx + 1} of ${STUDIO_STEPS.length}`
                      : ' — not started'}
                </span>
              </li>
            );
          })}
        </ol>

        {(error || sourceError) && (
          <Alert variant="error" data-testid="export-studio-error">
            {error || sourceError}
          </Alert>
        )}

        {/* MFX-41.4: every part of the deep link that could not be honoured, stated plainly. */}
        {linkNotices.length > 0 && (
          <Alert variant="warning" data-testid="export-studio-link-notice">
            <ul className="space-y-1 text-sm">
              {linkNotices.map((notice) => (
                <li key={`${notice.code}-${notice.message}`} data-issue={notice.code}>
                  {notice.message}
                </li>
              ))}
            </ul>
          </Alert>
        )}

        <div
          ref={stepPanelRef}
          role="group"
          aria-label={stepPanelLabel}
          tabIndex={-1}
          className={`${dashboardPanelPaddedClass} focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400`}
          data-testid="export-studio-body"
        >
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
                autoVerify={autoVerify}
                onAutoVerifyChange={setAutoVerify}
                configSummary={verifyConfigSummary}
                // A validation-gate override is a *job* failure standing in for the verdict, not
                // a cached measurement — never label it as one.
                fromCache={verifyFromCache && !jobValidationOverride}
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
                    or the artifact entities on the left, then download the .zip.
                  </p>
                  {/* IXH-4.1: the structural manifest tree beside the code viewer, two-way. */}
                  <div className="grid min-h-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(18rem,22rem)_1fr]">
                    <ExportManifestPanel
                      page={manifestPage}
                      entities={manifestEntities}
                      loading={manifestLoading}
                      error={manifestError}
                      complete={manifestComplete}
                      onLoadMore={manifestLoadMore}
                      selectedKey={selectedEntityKey}
                      onSelectEntity={selectEntity}
                    />
                    <BundleExplorer
                      manifest={bundle}
                      countsByPath={bundleFindingCounts}
                      targetKey={selected.key}
                      problems={locatedProblems}
                      reveal={problemReveal}
                      manifestEntities={manifestEntities}
                      selectedEntityKey={selectedEntityKey}
                      entityReveal={entityReveal}
                      onEntityLineClick={handleEntityLineClick}
                      // MFX-43.5: the same .zip the footer builds, offered where the files are.
                      onDownloadBundle={handleDownloadZip}
                    />
                  </div>
                  {/* IXH-4.2: what became of each canonical entity in this bundle. */}
                  {mappingGraph}
                  {/* IXH-4.3: the same findings ranked by what they cost. */}
                  {lossHeatmap}
                  {/* IXH-4.4: check the prediction empirically — emit, re-import, diff. */}
                  {roundtripPanel}
                </div>
              ) : emitted ? (
                <div className="flex min-h-0 flex-col gap-2">
                  <p className="shrink-0 text-xs text-gray-600 dark:text-gray-300">
                    <CheckCircle2 className="mr-1.5 inline h-4 w-4 align-text-bottom text-green-500" aria-hidden />
                    Generated <strong>{emitted.filename}</strong>. Review it below, then download the
                    file or a .zip bundle.
                  </p>
                  {/* IXH-2.5: a delivered artifact that carries warnings (or an attestation worth
                      naming) says so before the user downloads it. */}
                  {deliveryDecision && (
                    <div className="shrink-0">
                      <DeliveryGatePanel delivery={deliveryDecision} />
                    </div>
                  )}
                  {/* IXH-4.1: same explorer beside the single-document viewer. */}
                  <div className="grid min-h-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(18rem,22rem)_1fr]">
                    <ExportManifestPanel
                      page={manifestPage}
                      entities={manifestEntities}
                      loading={manifestLoading}
                      error={manifestError}
                      complete={manifestComplete}
                      onLoadMore={manifestLoadMore}
                      selectedKey={selectedEntityKey}
                      onSelectEntity={selectEntity}
                    />
                    <ArtifactPreviewCard
                      artifact={emitted}
                      report={verifyResult?.fidelity.report ?? null}
                      targetKey={selected.key}
                      problems={openableProblems}
                      reveal={problemReveal}
                      manifestEntities={manifestEntities}
                      selectedEntityKey={selectedEntityKey}
                      entityReveal={entityReveal}
                      onEntityLineClick={handleEntityLineClick}
                    />
                  </div>
                  {/* IXH-4.2: what became of each canonical entity in this document. */}
                  {mappingGraph}
                  {/* IXH-4.3: the same findings ranked by what they cost. */}
                  {lossHeatmap}
                  {/* IXH-4.4: check the prediction empirically — emit, re-import, diff. */}
                  {roundtripPanel}
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

        {/* IXH-6.3: paginated recent jobs — never fetches the unbounded full history. */}
        <RecentAsyncJobsPanel kind="export" limit={10} className="mt-2" />

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
                {/* A bundle downloads as the .zip here; single files download from the viewer's
                    own actions bar, which knows which file is open (MFX-43.5). */}
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
 * "Copy link" — the Studio session as a shareable URL (MFX-41.4, #4351).
 *
 * The URL is built at click time from the live session scope, so it always matches what is on
 * screen (and matches the address bar, which the Studio keeps in sync). Delivery credentials are
 * never encoded — the link builder strips credential-shaped option keys — so a link is safe to
 * paste into a ticket or a chat. The recipient needs access to the same tenant: the export API
 * resolves the tenant from their session, not from the URL.
 */
function CopyStudioLinkButton({ scope }: { scope: ExportStudioScope }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    const url = buildExportStudioShareUrl(scope);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context / denied permission): the address bar already
      // carries the same URL, so say so rather than failing silently.
      toast.error('Could not copy the link — copy it from the address bar instead.');
    }
  }, [scope]);

  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="export-studio-copy-link"
      onClick={() => void copy()}
      title="Copy a link that reopens this export configuration. Credentials are never included."
    >
      {copied ? (
        <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
      ) : (
        <Link2 className="h-4 w-4" aria-hidden />
      )}
      {copied ? 'Link copied' : 'Copy link'}
    </Button>
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
