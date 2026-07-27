'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  FileCode,
  FileUp,
  GitBranch,
  Link2,
  Loader2,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import { useImportSources } from '../useImportSources';
import { baseIntakeTiles } from '../importSourceCatalog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Alert';
import { extractFileMetadata, type FileMetadataPreview } from '../../../../utils/openapi-analyzer';
import { generateSlug } from '../../../../utils/slug';
import { FormatPill } from '../../../ui/catalog/FormatPill';
import {
  catalogAdapterForFormat,
  decideCatalogImportRouting,
  paradigmForFormat,
  CATALOG_STORABLE_SOURCES,
  type CatalogImportRoutingDecision,
} from '../../../../utils/catalog-import-formats';
import { resolveCatalogProtocol, resolveCatalogFormat } from '../../../../utils/catalog-format-registry';
import { monacoLanguageForCatalogFormat } from '../../../../utils/catalog-source-language';
import { ReadOnlyCodeViewer } from '../export/ReadOnlyCodeViewer';
import { useCatalogImportAvailability } from './useCatalogImportAvailability';
import { CatalogImportQualityStep } from './CatalogImportQualityStep';
import { RecentAsyncJobsPanel } from '../asyncJobs/RecentAsyncJobsPanel';
import {
  persistImportQualityPreferences,
  readImportQualityPreferences,
} from '../../../../utils/import-quality-preferences';

interface CatalogImportDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  onJsonSchemaAsCurrent?: (payload: JsonSchemaHandoffPayload) => void;
}

export interface JsonSchemaHandoffPayload {
  text: string;
  label: string;
  document: Record<string, unknown> | null;
}

type SourceMethod = 'file' | 'url' | 'paste' | 'git';

/**
 * Repository provenance returned by `POST /api/catalog/import/git` (MFI-29.3) and echoed back
 * verbatim in `options.git_source`, so the created catalog revision records which repository,
 * ref, and commit it came from.
 */
interface GitSourceProvenance {
  provider: string;
  repo_url: string;
  owner?: string | null;
  repo?: string | null;
  ref: string;
  commit_sha: string;
  path: string;
  browse_url?: string | null;
}

/** One repository file the selection matched but did not ingest, with the reason. */
interface GitSkippedMember {
  path: string;
  reason: string;
}

/**
 * The wizard rail (IXH-2.2). `quality` sits between `options` and `import`: the commit fires from
 * the quality step's confirmation, never from `options`, so nothing reaches the catalog before the
 * user has seen the pre-flight verdict.
 */
type Step = 'source' | 'detect' | 'options' | 'quality' | 'import';

/** Rail order, shared by the step chips and the `stepIndex` progress calculation. */
const STEP_ORDER: readonly Step[] = ['source', 'detect', 'options', 'quality', 'import'];

/** Rail labels, index-aligned with {@link STEP_ORDER}. */
const STEP_LABELS = ['Source', 'Detect & route', 'Options', 'Quality', 'Import'] as const;
type ImportState = 'idle' | 'detecting' | 'fetching-url' | 'fetching-git' | 'storing' | 'done';
type JsonSchemaChoice = 'catalog' | 'types';

interface DetectionCandidate {
  format: string;
  confidence: number;
  reason?: string | null;
  source_key?: string | null;
  importable: boolean;
}

interface DetectionResult {
  matched: boolean;
  detected?: DetectionCandidate | null;
  ambiguous?: boolean;
  candidates?: DetectionCandidate[];
  ambiguous_candidates?: DetectionCandidate[];
  archive_root?: string | null;
  archive_members?: string[];
}

const ARCHIVE_EXTENSIONS = ['.zip', '.tar.gz', '.tgz', '.tar'];

function isArchiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function toBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

function baseName(fileName: string): string {
  const noPath = fileName.split(/[\\/]/).pop() ?? fileName;
  return noPath.replace(/\.[^.]+$/, '') || noPath;
}

function parseJsonDocument(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'unknown confidence';
  return `${Math.round(value * 100)}% confidence`;
}

function formatChoiceLabel(format: string): string {
  return resolveCatalogFormat(format)?.label ?? format;
}

function routingTone(destination: CatalogImportRoutingDecision['destination']): string {
  switch (destination) {
    case 'catalog':
      return 'border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-100';
    case 'project':
      return 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100';
    case 'json-schema-choice':
      return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100';
    default:
      return 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200';
  }
}

export function CatalogImportDialog({
  open,
  onClose,
  onSuccess,
  onJsonSchemaAsCurrent,
}: CatalogImportDialogProps) {
  const [step, setStep] = useState<Step>('source');
  const [sourceMethod, setSourceMethod] = useState<SourceMethod>('file');
  const [state, setState] = useState<ImportState>('idle');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [documentBase64, setDocumentBase64] = useState<string | null>(null);
  const [archiveRoot, setArchiveRoot] = useState<string | null>(null);
  // Git source (MFI-29.3): the repository selection the user typed, and what the server
  // resolved it to — the packed members and the commit provenance to record on the revision.
  const [gitRepoUrl, setGitRepoUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [gitPath, setGitPath] = useState('');
  const [gitSource, setGitSource] = useState<GitSourceProvenance | null>(null);
  const [gitMembers, setGitMembers] = useState<string[]>([]);
  const [gitSkipped, setGitSkipped] = useState<GitSkippedMember[]>([]);
  const [metadata, setMetadata] = useState<FileMetadataPreview | null>(null);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [formatOverride, setFormatOverride] = useState<string | null>(null);
  const [jsonSchemaChoice, setJsonSchemaChoice] = useState<JsonSchemaChoice>('catalog');
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Power-user preference: a clean, non-blocking pre-flight commits without stopping on the quality
  // step. Read once per opening so a change made mid-wizard cannot retroactively skip the step the
  // user is standing on.
  const [skipQualityStep, setSkipQualityStep] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const availability = useCatalogImportAvailability(open);
  // The source grid is data-driven from `GET /v1/import/sources` (MFI-26.1). We render the
  // `catalog` importer surface and keep only the base intake methods — File / URL / Clipboard —
  // so no reflection/introspection/registry tiles ever appear (§0.3 routing policy, #4101).
  const { cards: sourceCards } = useImportSources(open, 'catalog');
  const sourceTiles = useMemo(() => baseIntakeTiles(sourceCards), [sourceCards]);

  const detectedFormat = detection?.detected?.format || metadata?.format || null;
  const effectiveFormat = formatOverride ?? detectedFormat;
  // The catalog identity the commit will use, hoisted from `storeCatalog` so the quality
  // step's re-import delta (IXH-3.4) resolves the exact item the commit would reuse.
  const importName = useMemo(
    () =>
      (
        metadata?.title ||
        // A git selection's filename carries repo/ref/commit for provenance; the catalog item is
        // named after the repository instead, so re-imports of later commits keep one identity.
        gitSource?.repo ||
        baseName(fileName) ||
        'Imported source'
      ).trim(),
    [metadata, gitSource, fileName],
  );
  const importSlug = useMemo(() => generateSlug(importName) || 'imported-source', [importName]);
  const routing = useMemo(() => decideCatalogImportRouting(effectiveFormat), [effectiveFormat]);
  // The paradigm the source's adapter emits (matches the server's routing_decision), resolved to a
  // display label via the shared protocol registry, for the "· paradigm Y" note (MFI-26.3).
  const paradigmLabel = useMemo(() => {
    const id = paradigmForFormat(effectiveFormat);
    return id ? resolveCatalogProtocol(id)?.label ?? null : null;
  }, [effectiveFormat]);
  // Monaco language for the detect step's source preview: derived from the format the routing will
  // actually use (override included) and refined by the bytes for the JSON-or-YAML formats, so an
  // override re-highlights the preview instead of leaving it on the auto-detected grammar.
  const previewLanguage = useMemo(
    () => monacoLanguageForCatalogFormat(effectiveFormat, content),
    [effectiveFormat, content],
  );
  const formatChoices = useMemo(() => {
    if (!detection?.ambiguous) return [] as DetectionCandidate[];
    const cluster = detection.ambiguous_candidates?.length
      ? detection.ambiguous_candidates
      : detection.candidates ?? [];
    const byFormat = new Map<string, DetectionCandidate>();
    for (const candidate of cluster) {
      const existing = byFormat.get(candidate.format);
      if (!existing || candidate.confidence > existing.confidence) {
        byFormat.set(candidate.format, candidate);
      }
    }
    return [...byFormat.values()].sort((a, b) => b.confidence - a.confidence);
  }, [detection]);
  // When detection is ambiguous, surface the close cluster so the user knows the top pick is an
  // assumption; the routing still proceeds on the highest-confidence candidate until overridden.
  const ambiguousCandidates = useMemo(() => {
    if (!detection?.ambiguous) return [] as DetectionCandidate[];
    const cluster = detection.ambiguous_candidates?.length
      ? detection.ambiguous_candidates
      : detection.candidates ?? [];
    return cluster.filter((c) => c.format !== effectiveFormat);
  }, [detection, effectiveFormat]);
  const adapter = routing.destination === 'catalog'
    ? routing.adapter ?? catalogAdapterForFormat(effectiveFormat)
    : null;
  const adapterUnavailable = adapter !== null && !availability.isAvailable(adapter.sourceKind);
  const unavailableReason = adapter ? availability.reasonFor(adapter.sourceKind) : null;
  const supportedLabel = CATALOG_STORABLE_SOURCES.filter((s) => availability.isAvailable(s.sourceKind))
    .map((s) => s.label)
    .join(', ') || CATALOG_STORABLE_SOURCES.map((s) => s.label).join(', ');
  const canStoreCatalog = routing.destination === 'catalog' && adapter !== null && !adapterUnavailable;
  const canContinueFromDetect =
    routing.destination === 'catalog' || routing.destination === 'json-schema-choice';
  // Whether the options step has anything for the user to decide. Only the JSON Schema fork does
  // (Catalog vs Types/Projects); catalog imports are stored verbatim with no knobs, so the step
  // renders the "no options" card instead of an empty panel.
  const hasImportOptions = routing.destination === 'json-schema-choice';
  // The importer the commit would run, and therefore the one the pre-flight must score. Null when
  // the options step leads somewhere that never writes a catalog item (the JSON Schema → Types
  // hand-off), in which case there is nothing to pre-flight.
  const commitSourceKind = useMemo(() => {
    if (routing.destination === 'catalog') return adapter?.sourceKind ?? null;
    if (routing.destination === 'json-schema-choice' && jsonSchemaChoice === 'catalog') {
      return 'json-schema';
    }
    return null;
  }, [adapter, jsonSchemaChoice, routing.destination]);

  useEffect(() => {
    if (!open) return;
    setSkipQualityStep(readImportQualityPreferences().skipQualityStep);
  }, [open]);

  const reset = useCallback(() => {
    setStep('source');
    setSourceMethod('file');
    setState('idle');
    setFileName('');
    setContent('');
    setUrlInput('');
    setPasteText('');
    setDocumentBase64(null);
    setArchiveRoot(null);
    setGitRepoUrl('');
    setGitRef('');
    setGitPath('');
    setGitSource(null);
    setGitMembers([]);
    setGitSkipped([]);
    setMetadata(null);
    setDetection(null);
    setFormatOverride(null);
    setJsonSchemaChoice('catalog');
    setError(null);
    setIsDragging(false);
  }, []);

  /** Drop any resolved repository selection — another intake method is taking over. */
  const clearGitSelection = useCallback(() => {
    setGitSource(null);
    setGitMembers([]);
    setGitSkipped([]);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const detectContent = useCallback(async (text: string, label: string, method: SourceMethod) => {
    setState('detecting');
    setError(null);
    setDocumentBase64(null);
    setArchiveRoot(null);
    clearGitSelection();
    const preview = extractFileMetadata(text);
    setMetadata(preview);
    setContent(text);
    setFileName(label);
    setSourceMethod(method);
    try {
      const res = await fetch('/api/import/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, filename: label, url: method === 'url' ? label : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || 'Could not detect that source.');
      }
      setDetection(data as DetectionResult);
      setFormatOverride(null);
    } catch (e) {
      setDetection(null);
      setError(e instanceof Error ? e.message : 'Could not detect that source.');
    } finally {
      setState('idle');
      setStep('detect');
    }
  }, [clearGitSelection]);

  const detectArchive = useCallback(async (base64: string, label: string) => {
    setState('detecting');
    setError(null);
    setContent('');
    setMetadata(null);
    setFileName(label);
    setSourceMethod('file');
    setDocumentBase64(base64);
    clearGitSelection();
    try {
      const res = await fetch('/api/import/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_base64: base64, filename: label }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || 'Could not detect that archive.');
      }
      const result = data as DetectionResult;
      setDetection(result);
      setFormatOverride(null);
      setArchiveRoot(result.archive_root ?? null);
    } catch (e) {
      setDetection(null);
      setDocumentBase64(null);
      setError(e instanceof Error ? e.message : 'Could not detect that archive.');
    } finally {
      setState('idle');
      setStep('detect');
    }
  }, [clearGitSelection]);

  const handleFile = useCallback(
    async (file: File) => {
      try {
        if (isArchiveFileName(file.name)) {
          const buffer = await file.arrayBuffer();
          await detectArchive(bytesToBase64(new Uint8Array(buffer)), file.name);
          return;
        }
        const text = await file.text();
        await detectContent(text, file.name, 'file');
      } catch {
        setError('Could not read that file. Try another file.');
      }
    },
    [detectArchive, detectContent],
  );

  const handleUrlFetch = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) {
      setError('Enter a URL to import.');
      return;
    }
    try {
      new URL(url);
    } catch {
      setError('Enter a valid URL.');
      return;
    }
    setState('fetching-url');
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Fetch failed with HTTP ${res.status}.`);
      const text = await res.text();
      await detectContent(text, url, 'url');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not fetch that URL.');
    } finally {
      setState('idle');
    }
  }, [detectContent, urlInput]);

  /**
   * Fetch a repository selection and enter the detect step with it (MFI-29.3).
   *
   * The server resolves the ref to a commit, selects the files, and returns them packed as the
   * same archive payload a `.zip` upload produces — so from here on the wizard treats a git
   * selection exactly like an archive, with the commit provenance carried alongside.
   */
  const handleGitFetch = useCallback(async () => {
    const repoUrl = gitRepoUrl.trim();
    if (!repoUrl) {
      setError('Enter a repository URL to import.');
      return;
    }
    setState('fetching-git');
    setError(null);
    try {
      const res = await fetch('/api/catalog/import/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo_url: repoUrl,
          ref: gitRef.trim() || undefined,
          path: gitPath.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || 'Could not read that repository.');
      }
      setContent('');
      setMetadata(null);
      setSourceMethod('git');
      setFileName(String(data.filename || 'repository.zip'));
      setDocumentBase64(String(data.document_base64 || ''));
      setArchiveRoot(data.archive_root ?? null);
      setGitSource((data.git_source as GitSourceProvenance) ?? null);
      setGitMembers(Array.isArray(data.members) ? (data.members as string[]) : []);
      setGitSkipped(Array.isArray(data.skipped) ? (data.skipped as GitSkippedMember[]) : []);
      setDetection(data.detection as DetectionResult);
      setFormatOverride(null);
      setStep('detect');
    } catch (e) {
      setDetection(null);
      setGitSource(null);
      setError(e instanceof Error ? e.message : 'Could not read that repository.');
    } finally {
      setState('idle');
    }
  }, [gitPath, gitRef, gitRepoUrl]);

  const handlePasteDetect = useCallback(async () => {
    const text = pasteText.trim();
    if (!text) {
      setError('Paste source content before continuing.');
      return;
    }
    await detectContent(text, 'Pasted source', 'paste');
  }, [detectContent, pasteText]);

  // Store-raw catalog import for a given adapter `source_kind`. Shared by the adapter-backed
  // catalog formats (gRPC/GraphQL/AsyncAPI) and the JSON Schema "Catalog" choice (MFI-26.7),
  // which both run the same `/api/catalog/import` job — the source is kept verbatim and never
  // converted at import time; only the `source_kind` differs.
  const storeCatalog = useCallback(async (sourceKind: string) => {
    if (!content && !documentBase64) return;
    setStep('import');
    setState('storing');
    setError(null);
    try {
      // The hoisted identity (importName/importSlug) — one derivation for the commit and
      // for the quality step's re-import delta, so the two can never diverge.
      const name = importName;
      const slug = importSlug;
      // 'git' is a wizard source, not a REST input kind: a repository selection arrives as the
      // same multi-file payload an archive does, so it commits as `fileset` with provenance.
      const options: Record<string, unknown> = {
        input_kind: sourceMethod === 'git' ? 'fileset' : sourceMethod,
      };
      if (archiveRoot) {
        options.archive_root = archiveRoot;
      }
      if (gitSource) {
        options.git_source = gitSource;
      }
      const startRes = await fetch('/api/catalog/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: {
            source_kind: sourceKind,
            project: { name, slug, description: metadata?.description ?? null },
            version: { version_id: metadata?.specVersion || '1.0.0' },
            options,
          },
          document_base64: documentBase64 ?? toBase64(content),
          filename: fileName || 'source',
        }),
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || startData?.success === false) {
        throw new Error(startData?.error || 'Failed to start the import.');
      }
      const jobId: string | undefined = startData?.job_id;
      if (!jobId) throw new Error('The import did not start (no job id returned).');

      const terminal = new Set(['completed', 'failed', 'canceled', 'rolled-back', 'pending-approval']);
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const pollRes = await fetch(`/api/catalog/import/${encodeURIComponent(jobId)}`);
        const pollData = await pollRes.json().catch(() => ({}));
        if (!pollRes.ok || pollData?.success === false) {
          throw new Error(pollData?.error || 'Failed to check import status.');
        }
        const jobState: string | undefined = pollData?.state;
        if (jobState && terminal.has(jobState)) {
          if (jobState === 'completed') {
            setState('done');
            onSuccess?.();
            return;
          }
          // IXH-6.4: prefer the structured taxonomy error over scraping event messages.
          const taxonomyError = pollData?.error;
          if (
            taxonomyError &&
            typeof taxonomyError === 'object' &&
            (typeof taxonomyError.message === 'string' ||
              typeof taxonomyError.remediation === 'string' ||
              typeof taxonomyError.code === 'string')
          ) {
            const parts: string[] = [];
            if (typeof taxonomyError.message === 'string' && taxonomyError.message.trim()) {
              parts.push(taxonomyError.message.trim());
            }
            if (
              typeof taxonomyError.remediation === 'string' &&
              taxonomyError.remediation.trim()
            ) {
              parts.push(taxonomyError.remediation.trim());
            }
            if (typeof taxonomyError.code === 'string' && taxonomyError.code.trim()) {
              parts.push(`(code ${taxonomyError.code.trim()})`);
            }
            throw new Error(parts.join(' ') || `Import ${jobState}.`);
          }
          const failEvent = Array.isArray(pollData?.events)
            ? [...pollData.events].reverse().find((e: { level?: string }) => e?.level === 'error')
            : null;
          throw new Error(failEvent?.message || `Import ${jobState}.`);
        }
      }
      throw new Error('The import is taking longer than expected. Check the catalog shortly.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to store the source.');
      setState('idle');
      setStep('options');
    }
  }, [archiveRoot, content, documentBase64, fileName, gitSource, importName, importSlug, metadata, onSuccess, sourceMethod]);

  /**
   * Leave the options step (IXH-2.2).
   *
   * Everything that would write a catalog item now goes through `quality` first — the commit is the
   * quality step's confirmation, not this button. The one exception is the JSON Schema
   * "Types/Projects" choice (MFI-26.8), which writes no catalog item at all: it hands the schema to
   * the existing type-import review and closes the wizard, so there is nothing to pre-flight.
   */
  const handleContinueFromOptions = useCallback(() => {
    if (routing.destination === 'json-schema-choice' && jsonSchemaChoice === 'types') {
      onJsonSchemaAsCurrent?.({
        text: content,
        label: fileName || 'JSON Schema',
        document: parseJsonDocument(content),
      });
      handleClose();
      return;
    }
    setError(null);
    setStep('quality');
  }, [
    content,
    fileName,
    handleClose,
    jsonSchemaChoice,
    onJsonSchemaAsCurrent,
    routing.destination,
  ]);

  /**
   * Commit from the quality step. The step has already recorded a waiver when the user imported
   * against a blocking policy, so the parent only has to run the job it always ran.
   */
  const handleQualityCommit = useCallback(() => {
    if (!commitSourceKind) return;
    void storeCatalog(commitSourceKind);
  }, [commitSourceKind, storeCatalog]);

  const handleSkipPreferenceChange = useCallback((value: boolean) => {
    setSkipQualityStep(value);
    persistImportQualityPreferences({ skipQualityStep: value });
  }, []);

  const stepIndex = STEP_ORDER.indexOf(step);
  const detected = detection?.detected;

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? handleClose() : undefined)}>
      {/* Fixed 90vh shell: the header/rail/footer are pinned and each step body owns the space
          between them, so the detect step's editor can fill it instead of the dialog growing. */}
      <DialogContent className="flex h-[90vh] max-h-[90vh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Import to catalog</DialogTitle>
          <DialogDescription>
            Start with File Upload, URL Import, Clipboard paste, or a Git repository. Catalog
            imports are stored in their original format and converted only when explicitly
            requested.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 grid shrink-0 grid-cols-5 gap-2 text-xs">
          {STEP_LABELS.map((label, idx) => (
            <div
              key={label}
              className={`rounded-full border px-3 py-1.5 text-center ${
                idx <= stepIndex
                  ? 'border-indigo-200 bg-indigo-50 font-medium text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200'
                  : 'border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400'
              }`}
            >
              {idx + 1}. {label}
            </div>
          ))}
        </div>

        {error && (
          <Alert variant="error" className="mt-3 shrink-0">
            {error}
          </Alert>
        )}

        {step === 'source' && (
          <div className="mt-4 grid min-h-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-[1.35fr_.9fr]">
            <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
                <Upload className="h-4 w-4 text-indigo-500" aria-hidden />
                Choose a source
              </div>
              <div className="my-3 h-px bg-gray-200 dark:bg-gray-700" />
              <div className="grid gap-2 sm:grid-cols-3">
                {sourceTiles.map(({ method, card }) => {
                  const Icon = card.icon;
                  return (
                    <button
                      key={card.key}
                      type="button"
                      data-testid={`catalog-import-source-${method}`}
                      onClick={() => {
                        setSourceMethod(method);
                        setError(null);
                      }}
                      className={`rounded-lg border p-3 text-center transition ${
                        sourceMethod === method
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-100'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-indigo-200 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200'
                      }`}
                    >
                      <Icon className="mx-auto mb-2 h-5 w-5" aria-hidden />
                      <div className="text-sm font-medium">{card.label}</div>
                      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{card.description}</div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4">
                {sourceMethod === 'file' && (
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragging(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) void handleFile(file);
                    }}
                    className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center ${
                      isDragging
                        ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30'
                        : 'border-gray-300 dark:border-gray-700'
                    }`}
                  >
                    <FileUp className="h-8 w-8 text-gray-400" aria-hidden />
                    <div className="text-sm text-gray-600 dark:text-gray-300">
                      Drop a source file here, or browse.
                    </div>
                    <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                      Browse files
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      accept=".proto,.graphql,.gql,.yaml,.yml,.json,.zip,.tar,.tar.gz,.tgz"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFile(file);
                      }}
                    />
                  </div>
                )}

                {sourceMethod === 'url' && (
                  <div className="space-y-3">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-200" htmlFor="catalog-import-url">
                      Document URL
                    </label>
                    <input
                      id="catalog-import-url"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="https://api.example.com/schema.graphql"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                    />
                    <Button onClick={handleUrlFetch} disabled={state === 'fetching-url'}>
                      {state === 'fetching-url' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />}
                      Fetch and detect
                    </Button>
                  </div>
                )}

                {sourceMethod === 'paste' && (
                  <div className="space-y-3">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-200" htmlFor="catalog-import-paste">
                      Source content
                    </label>
                    <textarea
                      id="catalog-import-paste"
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      placeholder="Paste GraphQL SDL, .proto, AsyncAPI, or JSON Schema content..."
                      rows={9}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-950"
                    />
                    <Button onClick={handlePasteDetect}>
                      <Clipboard className="h-4 w-4" aria-hidden />
                      Detect pasted source
                    </Button>
                  </div>
                )}

                {/* Git selection (MFI-29.3): a repository path or glob at a ref, read server-side
                    at an immutable commit and imported as a multi-file selection. */}
                {sourceMethod === 'git' && (
                  <div className="space-y-3" data-testid="catalog-import-git-panel">
                    <div className="space-y-1">
                      <label
                        className="text-sm font-medium text-gray-700 dark:text-gray-200"
                        htmlFor="catalog-import-git-repo"
                      >
                        Repository URL
                      </label>
                      <input
                        id="catalog-import-git-repo"
                        value={gitRepoUrl}
                        onChange={(e) => setGitRepoUrl(e.target.value)}
                        placeholder="https://github.com/owner/repo"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label
                          className="text-sm font-medium text-gray-700 dark:text-gray-200"
                          htmlFor="catalog-import-git-ref"
                        >
                          Branch, tag, or commit
                        </label>
                        <input
                          id="catalog-import-git-ref"
                          value={gitRef}
                          onChange={(e) => setGitRef(e.target.value)}
                          placeholder="default branch"
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          className="text-sm font-medium text-gray-700 dark:text-gray-200"
                          htmlFor="catalog-import-git-path"
                        >
                          Path or glob
                        </label>
                        <input
                          id="catalog-import-git-path"
                          value={gitPath}
                          onChange={(e) => setGitPath(e.target.value)}
                          placeholder="protos/**"
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Private repositories are read with your linked account credentials. Leave the
                      path empty to consider the whole repository.
                    </p>
                    <Button onClick={handleGitFetch} disabled={state === 'fetching-git'}>
                      {state === 'fetching-git' ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <GitBranch className="h-4 w-4" aria-hidden />
                      )}
                      Fetch and detect
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
                <GitBranch className="h-4 w-4 text-indigo-500" aria-hidden />
                Destination guide
              </div>
              <div className="my-3 h-px bg-gray-200 dark:bg-gray-700" />
              <div className="space-y-3 text-sm">
                <div>
                  <div className="font-medium">Catalog only</div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {supportedLabel} stay non-publishable until explicit Convert.
                  </p>
                </div>
                <div>
                  <div className="font-medium">Projects</div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    OpenAPI, Swagger, and Arazzo create publishable Project versions.
                  </p>
                </div>
                <div>
                  <div className="font-medium">JSON Schema asks first</div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Choose Catalog for later conversion or Types/Projects as current schema.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Detect & route: a column of pinned detection facts above a flex-filling source editor.
            `overflow-y-auto` is the safety valve for short viewports — the editor stops at its
            240px floor and the column scrolls rather than spilling out of the 90vh dialog. */}
        {step === 'detect' && (
          <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            <div className="flex shrink-0 items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="flex min-w-0 items-center gap-2">
                <FileCode className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
                <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{fileName}</span>
              </div>
              <div className="flex items-center gap-2">
                <FormatPill format={effectiveFormat === 'unknown' ? null : effectiveFormat} />
                <button
                  type="button"
                  onClick={reset}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  aria-label="Choose a different source"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>

            <div className="shrink-0 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {formatOverride && formatOverride !== detectedFormat
                  ? `Import format: ${formatChoiceLabel(effectiveFormat ?? '')}`
                  : `Auto-detected: ${detected?.format || metadata?.formatDisplayName || 'Unknown'}`}
              </div>
              {formatOverride && formatOverride !== detectedFormat && detectedFormat && (
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Auto-detected {formatChoiceLabel(detectedFormat)} ({formatPercent(detected?.confidence)})
                </div>
              )}
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {formatPercent(
                  formatChoices.find((c) => c.format === effectiveFormat)?.confidence ?? detected?.confidence,
                )}
                {paradigmLabel ? ` · paradigm ${paradigmLabel}` : ''}
                {detected?.reason && !formatOverride ? ` · ${detected.reason}` : ''}
              </div>
            </div>

            {/* Git provenance (MFI-29.3): what the selection actually resolved to — the commit
                the files were read at, the root document, and anything deliberately skipped. */}
            {gitSource && (
              <div
                className="shrink-0 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
                data-testid="catalog-import-git-provenance"
              >
                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                  <GitBranch className="h-4 w-4 text-indigo-500" aria-hidden />
                  {gitSource.repo_url}
                </div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {gitSource.ref} · commit {gitSource.commit_sha.slice(0, 7)}
                  {gitSource.path ? ` · ${gitSource.path}` : ''}
                </div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {gitMembers.length} file{gitMembers.length === 1 ? '' : 's'} selected · root{' '}
                  {archiveRoot ?? '—'}
                  {gitSkipped.length > 0 ? ` · ${gitSkipped.length} skipped` : ''}
                </div>
                {gitSkipped.length > 0 && (
                  <details className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    <summary className="cursor-pointer">Show skipped files</summary>
                    <ul className="mt-1 space-y-0.5">
                      {gitSkipped.map((item) => (
                        <li key={item.path}>
                          {item.path} — {item.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {formatChoices.length > 1 && (
              <div className="shrink-0 space-y-2" data-testid="format-override-select">
                <label
                  className="text-sm font-medium text-gray-900 dark:text-gray-100"
                  htmlFor="catalog-import-format-override"
                >
                  Import as format
                </label>
                <select
                  id="catalog-import-format-override"
                  value={effectiveFormat ?? ''}
                  onChange={(event) => setFormatOverride(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                >
                  {formatChoices.map((candidate) => (
                    <option key={candidate.format} value={candidate.format}>
                      {formatChoiceLabel(candidate.format)} ({formatPercent(candidate.confidence)})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Detection matched more than one format. Override the assumed format if the top match
                  is wrong.
                </p>
              </div>
            )}

            {ambiguousCandidates.length > 0 && (
              <Alert variant="warning" className="shrink-0" data-testid="detect-ambiguous">
                <div className="font-medium">
                  Ambiguous source — using {formatChoiceLabel(effectiveFormat ?? 'the selected format')}
                </div>
                <div className="text-sm">
                  This could also be{' '}
                  {ambiguousCandidates
                    .map((c) => `${formatChoiceLabel(c.format)} (${formatPercent(c.confidence)})`)
                    .join(', ')}
                  .
                </div>
              </Alert>
            )}

            <div className={`shrink-0 rounded-lg border p-4 ${routingTone(routing.destination)}`}>
              <div className="flex items-start gap-2">
                {routing.destination === 'not-importable' ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                ) : (
                  <GitBranch className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                )}
                <div>
                  <div className="text-sm font-semibold">Routing decision → {routing.label}</div>
                  <div className="mt-1 text-xs opacity-90">{routing.description}</div>
                  {adapterUnavailable && (
                    <div className="mt-2 text-xs font-medium">
                      {unavailableReason || `${adapter?.label} import is unavailable in this runtime.`}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* The imported bytes, syntax-highlighted read-only in Monaco through the shared
                {@link ReadOnlyCodeViewer} (MFX-43.1) — the same viewer the catalog detail's
                Source & Code tab and the export surfaces use, so highlighting, theming and the
                offline `<pre>` fallback are all inherited rather than re-derived. The language is
                the detected/overridden format mapped through `monacoLanguageForCatalogFormat`, so
                switching the format override re-highlights the preview. Archive uploads carry no
                text (only base64 bytes), so they get a note instead of an empty editor. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              {content ? (
                <ReadOnlyCodeViewer
                  value={content}
                  language={previewLanguage}
                  height="100%"
                  wordWrap="off"
                  className="h-full"
                  editorTestId="catalog-import-preview-editor"
                  fallbackTestId="catalog-import-preview-fallback"
                />
              ) : (
                <div
                  data-testid="catalog-import-preview-empty"
                  className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500 dark:text-gray-400"
                >
                  {gitSource
                    ? 'Repository selections have no single text document to preview. Detection ran over the selected files.'
                    : documentBase64
                      ? 'Archive uploads have no single text document to preview. Detection ran over the archive contents.'
                      : 'No source content to preview.'}
                </div>
              )}
            </div>
          </div>
        )}

        {step === 'options' && (
          <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            {routing.destination === 'catalog' && (
              <Alert variant="info" className="shrink-0">
                <div className="font-medium">Store in catalog</div>
                <div className="text-sm">
                  This source will be kept verbatim as {adapter?.label}. It will not create a
                  Project or auto-convert to OpenAPI. Continue to review its quality score before
                  anything is written.
                </div>
              </Alert>
            )}
            {routing.destination === 'json-schema-choice' && (
              <div className="shrink-0 space-y-3">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Choose where this JSON Schema should go.
                </div>
                <label className="flex gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  <input
                    type="radio"
                    name="jsonSchemaChoice"
                    checked={jsonSchemaChoice === 'catalog'}
                    onChange={() => setJsonSchemaChoice('catalog')}
                  />
                  <span>
                    <span className="block text-sm font-medium">Catalog for later conversion</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      Stored verbatim as a non-publishable, schemas-only catalog item — converted
                      only when you explicitly request it.
                    </span>
                  </span>
                </label>
                <label className="flex gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  <input
                    type="radio"
                    name="jsonSchemaChoice"
                    checked={jsonSchemaChoice === 'types'}
                    onChange={() => setJsonSchemaChoice('types')}
                  />
                  <span>
                    <span className="block text-sm font-medium">Types/Projects as current schema</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      Opens the existing type import review with this schema preloaded.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {/* JSON Schema is the only format that asks the user anything here (Catalog vs
                Types/Projects). Every other route reaches this step with nothing to configure, so
                the otherwise-empty panel says so rather than reading as a rendering failure. */}
            {!hasImportOptions && (
              <div className="flex flex-1 items-center justify-center">
                <div
                  data-testid="catalog-import-no-options"
                  className="max-w-lg rounded-xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center dark:border-gray-700 dark:bg-gray-900"
                >
                  <SlidersHorizontal className="mx-auto h-8 w-8 text-gray-400" aria-hidden />
                  <h3 className="mt-4 text-xl font-semibold text-gray-900 dark:text-gray-100">
                    No additional options
                  </h3>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    No additional options are available for this data type. Continue to the quality
                    pre-flight — nothing is written to the catalog until you confirm it there.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'quality' && (
          <CatalogImportQualityStep
            documentBase64={documentBase64 ?? toBase64(content)}
            label={fileName || 'Imported source'}
            sourceKind={commitSourceKind}
            inputKind={sourceMethod === 'git' ? 'fileset' : sourceMethod}
            archiveRoot={archiveRoot}
            url={sourceMethod === 'url' ? fileName : null}
            rawSource={content}
            autoAdvance={skipQualityStep}
            skipPreference={skipQualityStep}
            onSkipPreferenceChange={handleSkipPreferenceChange}
            onCommit={handleQualityCommit}
            onBack={() => setStep('options')}
            onCancel={handleClose}
            projectSlug={importSlug}
          />
        )}

        {step === 'import' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
            {state === 'done' ? (
              <>
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-green-500 text-white">
                  <CheckCircle2 className="h-7 w-7" aria-hidden />
                </div>
                <div className="text-sm text-gray-700 dark:text-gray-200">
                  Stored in the catalog in its original format. Use <strong>Convert to OpenAPI</strong> when ready.
                </div>
              </>
            ) : (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-indigo-500" aria-hidden />
                <div className="text-sm text-gray-700 dark:text-gray-200">Storing source in catalog…</div>
              </>
            )}
          </div>
        )}

        {/* IXH-6.3: paginated recent import jobs on the source step (bounded list). */}
        {step === 'source' && (
          <RecentAsyncJobsPanel kind="import" limit={5} className="mt-4 shrink-0" />
        )}

        {/* The quality step owns its own footer so all three of its exits — Cancel, Import anyway,
            Import — sit on one row with the gate that governs them (IXH-2.2). */}
        {step !== 'quality' && (
          <div className="mt-4 flex shrink-0 justify-between gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
            <div className="flex items-center gap-4">
              <Button variant="outline" onClick={handleClose} disabled={state === 'storing'}>
                {state === 'done' ? 'Close' : 'Cancel'}
              </Button>
              {/* The skip preference must stay reachable *outside* the quality step: with it on, a
                  non-blocking pre-flight auto-commits, so the step's own checkbox flashes past too
                  fast to uncheck — the preference would otherwise be a one-way switch. Options is
                  the last stop before the quality step on every catalog route, so it is where the
                  preference can always be turned back off. Hidden on the JSON Schema → Types
                  hand-off, which never reaches the quality step at all. */}
              {step === 'options' && commitSourceKind !== null && (
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={skipQualityStep}
                    onChange={(event) => handleSkipPreferenceChange(event.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
                    data-testid="catalog-import-options-skip-preference"
                  />
                  Skip the quality step for clean imports
                </label>
              )}
            </div>
            <div className="flex gap-2">
              {step !== 'source' && step !== 'import' && (
                <Button variant="outline" onClick={() => setStep(step === 'options' ? 'detect' : 'source')}>
                  Back
                </Button>
              )}
              {step === 'detect' && (
                <Button onClick={() => setStep('options')} disabled={!canContinueFromDetect || adapterUnavailable}>
                  Continue
                </Button>
              )}
              {step === 'options' && (routing.destination === 'catalog' || routing.destination === 'json-schema-choice') && (
                <Button
                  onClick={handleContinueFromOptions}
                  disabled={
                    routing.destination === 'catalog' && (!canStoreCatalog || state === 'storing')
                  }
                >
                  Continue
                </Button>
              )}
              {step === 'import' && state === 'done' && (
                <Button onClick={handleClose}>Done</Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default CatalogImportDialog;
