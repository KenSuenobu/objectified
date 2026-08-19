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
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useImportSources } from '../useImportSources';
import { baseIntakeTiles } from '../importSourceCatalog';
import { Dialog, DialogContent } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Alert';
import { Card } from '../../../ui/Card';
import { EmptyState } from '../../../ui/EmptyState';
import { FormField } from '../../../ui/FormField';
import { Input } from '../../../ui/Input';
import { Spinner } from '../../../ui/Spinner';
import { Textarea } from '../../../ui/Textarea';
import { cn } from '@lib/utils';
import {
  CATALOG_IMPORT_STEPS,
  ImportSourceCards,
  ImportWizardBody,
  ImportWizardFooter,
  ImportWizardHead,
  ImportWizardSteps,
  catalogImportFooterFor,
  catalogRoutingTone,
} from '../../import';
import { extractFileMetadata, type FileMetadataPreview } from '../../../../utils/openapi-analyzer';
import { generateSlug } from '../../../../utils/slug';
import { FormatPill } from '../../../ui/catalog/FormatPill';
import {
  catalogAdapterForFormat,
  decideCatalogImportRouting,
  paradigmForFormat,
  CATALOG_STORABLE_SOURCES,
} from '../../../../utils/catalog-import-formats';
import { resolveCatalogProtocol, resolveCatalogFormat } from '../../../../utils/catalog-format-registry';
import { monacoLanguageForCatalogFormat } from '../../../../utils/catalog-source-language';
import { ReadOnlyCodeViewer } from '../export/ReadOnlyCodeViewer';
import { useCatalogImportAvailability } from './useCatalogImportAvailability';
import { CatalogImportQualityStep } from './CatalogImportQualityStep';
import {
  CatalogBulkImportBanner,
  CatalogBulkImportPanel,
  type BulkPlan,
} from './CatalogBulkImportPanel';
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
  // Bulk mode (MFI-29.5): the partition of a multi-spec payload, and the request body that
  // identifies it. Both are null for a payload holding a single spec, which keeps the
  // single-document wizard exactly as it was.
  const [bulkPlan, setBulkPlan] = useState<BulkPlan | null>(null);
  const [bulkSource, setBulkSource] = useState<Record<string, unknown> | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
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
    setBulkPlan(null);
    setBulkSource(null);
    setBulkMode(false);
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

  /** Drop any bulk partition — the payload it described is no longer the one in hand. */
  const clearBulkPlan = useCallback(() => {
    setBulkPlan(null);
    setBulkSource(null);
    setBulkMode(false);
  }, []);

  /**
   * Ask whether a multi-file payload holds several *independent* specs (MFI-29.5).
   *
   * Only archives and repository selections can: a single pasted or uploaded document is one
   * spec by construction. A plan with two or more items unlocks the bulk banner on the detect
   * step; anything else — one item, or a planning failure — leaves the single-document wizard
   * untouched, so this can never make a working import worse.
   */
  const loadBulkPlan = useCallback(async (source: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch('/api/catalog/import/bulk/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(source),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) return false;
      const plan = data as BulkPlan;
      if (!Array.isArray(plan.items) || plan.items.length < 2) return false;
      setBulkPlan(plan);
      setBulkSource(source);
      return true;
    } catch {
      // Bulk mode is an offer, not a requirement: a failed plan simply is not offered.
      return false;
    }
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
    clearBulkPlan();
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
  }, [clearBulkPlan, clearGitSelection]);

  const detectArchive = useCallback(async (base64: string, label: string) => {
    setState('detecting');
    setError(null);
    setContent('');
    setMetadata(null);
    setFileName(label);
    setSourceMethod('file');
    setDocumentBase64(base64);
    clearGitSelection();
    clearBulkPlan();
    let failure: string | null = null;
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
      failure = e instanceof Error ? e.message : 'Could not detect that archive.';
    }
    // An archive is the one upload that can hold several independent specs (MFI-29.5) — and
    // that is also why whole-archive detection may have just failed with an ambiguous root.
    // Planning runs either way, so the answer to "which spec is this?" can be "all of them".
    const offersBulk = await loadBulkPlan({ document_base64: base64, filename: label });
    if (failure && !offersBulk) {
      setDocumentBase64(null);
      setError(failure);
    }
    setState('idle');
    setStep('detect');
  }, [clearBulkPlan, clearGitSelection, loadBulkPlan]);

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
    clearBulkPlan();
    const selection = {
      repo_url: repoUrl,
      ref: gitRef.trim() || undefined,
      path: gitPath.trim(),
    };
    let failure: string | null = null;
    try {
      const res = await fetch('/api/catalog/import/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selection),
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
    } catch (e) {
      setDetection(null);
      setGitSource(null);
      failure = e instanceof Error ? e.message : 'Could not read that repository.';
    }
    // A repository path is the most likely place to find several independent specs — and a
    // selection that holds them has no single root, which is exactly why the fetch above may
    // have just failed. Plan it either way so bulk mode can answer "import all of them".
    const offersBulk = await loadBulkPlan({ git: selection });
    if (failure && !offersBulk) {
      setError(failure);
      setState('idle');
      return;
    }
    setState('idle');
    setStep('detect');
  }, [clearBulkPlan, gitPath, gitRef, gitRepoUrl, loadBulkPlan]);

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

  /**
   * Re-select the bundle's root document from the quality step's bundle explorer (IXH-3.5).
   *
   * The wizard owns `archiveRoot` for exactly this reason: it is the one value the pre-flight, the
   * preview manifest, the bundle inventory, *and* the eventual commit all read, so changing it here
   * re-runs every one of them against the chosen member — there is no second "preview root" that
   * could disagree with what the import would actually do.
   */
  const handleArchiveRootChange = useCallback((path: string) => {
    setArchiveRoot(path.trim() || null);
  }, []);

  const detected = detection?.detected;

  /*
   * The footer, as data. Which verb each step carries, whether Back is offered and what
   * closing costs are `catalogImportFooterFor` — the same shape the Projects importer's
   * `importFooterFor` produces, so the two wizards' footers cannot drift into two layouts.
   */
  const footer = catalogImportFooterFor({
    step,
    storing: state === 'storing',
    done: state === 'done',
    canContinueFromDetect,
    adapterUnavailable,
    destination: routing.destination,
    canStoreCatalog,
  });

  /** Back goes one stop up the rail; the rail is the array, so this is its index minus one. */
  const handleBack = useCallback(() => {
    setStep((current) => (current === 'options' ? 'detect' : 'source'));
  }, []);

  const handlePrimary = useCallback(() => {
    if (step === 'detect') setStep('options');
    else if (step === 'options') handleContinueFromOptions();
    else if (step === 'import') handleClose();
  }, [handleClose, handleContinueFromOptions, step]);

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? handleClose() : undefined)}>
      {/* The 6.4 wizard frame (`size="full"` + `.imp-wizard`): head, rail, one scrolling body
          and a pinned footer. Sharing it is this ticket's acceptance criterion — and it is what
          gives the detect step's editor a column it can fill instead of the dialog growing. */}
      <DialogContent size="full" className="imp-wizard">
        <ImportWizardHead
          title="Import to catalog"
          description="File, URL, clipboard or a Git repository. Catalog imports are stored in their original format and converted only when you ask."
        />
        <ImportWizardSteps
          steps={CATALOG_IMPORT_STEPS}
          current={step}
          complete={state === 'done'}
          label="Catalog import progress"
        />

        <ImportWizardBody>
          {error ? (
            <Alert variant="danger" className="mb-4">
              {error}
            </Alert>
          ) : null}

          {step === 'source' && (
            <div className="cat-imp-source">
              <div className="cat-imp-source__main">
                <ImportSourceCards
                  heading="Choose a source"
                  cards={sourceTiles.map((tile) => tile.card)}
                  selected={
                    sourceTiles.find((tile) => tile.method === sourceMethod)?.card.panel ?? null
                  }
                  testId={(card) => {
                    const tile = sourceTiles.find((entry) => entry.card.key === card.key);
                    return tile ? `catalog-import-source-${tile.method}` : undefined;
                  }}
                  onSelect={(panel) => {
                    const tile = sourceTiles.find((entry) => entry.card.panel === panel);
                    if (!tile) return;
                    setSourceMethod(tile.method);
                    setError(null);
                  }}
                />

                {sourceMethod === 'file' && (
                  <label
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
                    className={cn('imp-drop', isDragging && 'imp-drop--over')}
                  >
                    <span className="tnt-icon-tile imp-drop__glyph" data-tone="accent" aria-hidden>
                      <FileUp />
                    </span>
                    <span className="text-sm text-fg">Drop a source file here, or browse.</span>
                    <span className="imp-drop__browse">Browse files</span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="sr-only"
                      accept=".proto,.graphql,.gql,.yaml,.yml,.json,.zip,.tar,.tar.gz,.tgz"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFile(file);
                      }}
                    />
                  </label>
                )}

                {sourceMethod === 'url' && (
                  <div className="cat-imp-form">
                    <FormField label="Document URL" htmlFor="catalog-import-url">
                      <Input
                        id="catalog-import-url"
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        placeholder="https://api.example.com/schema.graphql"
                      />
                    </FormField>
                    <Button onClick={handleUrlFetch} disabled={state === 'fetching-url'}>
                      {state === 'fetching-url' ? <Spinner aria-hidden /> : <Link2 aria-hidden />}
                      Fetch and detect
                    </Button>
                  </div>
                )}

                {sourceMethod === 'paste' && (
                  <div className="cat-imp-form">
                    <FormField label="Source content" htmlFor="catalog-import-paste">
                      <Textarea
                        id="catalog-import-paste"
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        placeholder="Paste GraphQL SDL, .proto, AsyncAPI, or JSON Schema content..."
                        rows={9}
                        className="mono"
                      />
                    </FormField>
                    <Button onClick={handlePasteDetect}>
                      <Clipboard aria-hidden />
                      Detect pasted source
                    </Button>
                  </div>
                )}

                {/* Git selection (MFI-29.3): a repository path or glob at a ref, read
                    server-side at an immutable commit and imported as a multi-file selection. */}
                {sourceMethod === 'git' && (
                  <div className="cat-imp-form" data-testid="catalog-import-git-panel">
                    <FormField label="Repository URL" htmlFor="catalog-import-git-repo">
                      <Input
                        id="catalog-import-git-repo"
                        value={gitRepoUrl}
                        onChange={(e) => setGitRepoUrl(e.target.value)}
                        placeholder="https://github.com/owner/repo"
                      />
                    </FormField>
                    <div className="cat-imp-form__pair">
                      <FormField label="Branch, tag, or commit" htmlFor="catalog-import-git-ref">
                        <Input
                          id="catalog-import-git-ref"
                          value={gitRef}
                          onChange={(e) => setGitRef(e.target.value)}
                          placeholder="default branch"
                        />
                      </FormField>
                      <FormField label="Path or glob" htmlFor="catalog-import-git-path">
                        <Input
                          id="catalog-import-git-path"
                          value={gitPath}
                          onChange={(e) => setGitPath(e.target.value)}
                          placeholder="protos/**"
                        />
                      </FormField>
                    </div>
                    <p className="cat-imp-note">
                      Private repositories are read with your linked account credentials. Leave the
                      path empty to consider the whole repository.
                    </p>
                    <Button onClick={handleGitFetch} disabled={state === 'fetching-git'}>
                      {state === 'fetching-git' ? <Spinner aria-hidden /> : <GitBranch aria-hidden />}
                      Fetch and detect
                    </Button>
                  </div>
                )}

                {/* IXH-6.3: paginated recent import jobs on the source step (bounded list). */}
                <RecentAsyncJobsPanel kind="import" limit={5} />
              </div>

              <Card className="cat-imp-guide">
                <h2 className="imp-heading">
                  <GitBranch aria-hidden />
                  Destination guide
                </h2>
                <dl className="cat-imp-guide__list">
                  <dt>Catalog only</dt>
                  <dd>{supportedLabel} stay non-publishable until explicit Convert.</dd>
                  <dt>Projects</dt>
                  <dd>OpenAPI, Swagger, and Arazzo create publishable Project versions.</dd>
                  <dt>JSON Schema asks first</dt>
                  <dd>Choose Catalog for later conversion or Types/Projects as current schema.</dd>
                </dl>
              </Card>
            </div>
          )}

          {/* Detect & route: a column of pinned detection facts above a flex-filling source
              editor. The body already scrolls, so the editor stops at its floor and the column
              scrolls rather than spilling out of the dialog. */}
          {step === 'detect' && (
            <div className="cat-imp-detect">
              <div className="cat-imp-file">
                <span className="cat-imp-file__name">
                  <FileCode aria-hidden />
                  <span className="truncate">{fileName}</span>
                </span>
                <span className="cat-imp-file__end">
                  <FormatPill format={effectiveFormat === 'unknown' ? null : effectiveFormat} />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-1.5"
                    onClick={reset}
                    aria-label="Choose a different source"
                  >
                    <X aria-hidden />
                  </Button>
                </span>
              </div>

              <Card className="cat-imp-card">
                <div className="cat-imp-card__title">
                  {formatOverride && formatOverride !== detectedFormat
                    ? `Import format: ${formatChoiceLabel(effectiveFormat ?? '')}`
                    : `Auto-detected: ${detected?.format || metadata?.formatDisplayName || 'Unknown'}`}
                </div>
                {formatOverride && formatOverride !== detectedFormat && detectedFormat && (
                  <div className="cat-imp-note">
                    Auto-detected {formatChoiceLabel(detectedFormat)} ({formatPercent(detected?.confidence)})
                  </div>
                )}
                <div className="cat-imp-note">
                  {formatPercent(
                    formatChoices.find((c) => c.format === effectiveFormat)?.confidence ??
                      detected?.confidence,
                  )}
                  {paradigmLabel ? ` · paradigm ${paradigmLabel}` : ''}
                  {detected?.reason && !formatOverride ? ` · ${detected.reason}` : ''}
                </div>
              </Card>

              {/* Bulk mode (MFI-29.5): the payload holds several independent specs, so the
                  single routing decision below does not describe it. Importing them all runs one
                  ordinary import per spec and reports each one separately. */}
              {bulkPlan && bulkSource && (
                <CatalogBulkImportBanner
                  plan={bulkPlan}
                  onStart={() => {
                    setError(null);
                    setBulkMode(true);
                    setStep('import');
                  }}
                />
              )}

              {/* Git provenance (MFI-29.3): what the selection actually resolved to — the commit
                  the files were read at, the root document, and anything deliberately skipped. */}
              {gitSource && (
                <Card className="cat-imp-card" data-testid="catalog-import-git-provenance">
                  <div className="cat-imp-card__title">
                    <GitBranch aria-hidden />
                    {gitSource.repo_url}
                  </div>
                  <div className="cat-imp-note">
                    {gitSource.ref} · commit {gitSource.commit_sha.slice(0, 7)}
                    {gitSource.path ? ` · ${gitSource.path}` : ''}
                  </div>
                  <div className="cat-imp-note">
                    {gitMembers.length} file{gitMembers.length === 1 ? '' : 's'} selected · root{' '}
                    {archiveRoot ?? '—'}
                    {gitSkipped.length > 0 ? ` · ${gitSkipped.length} skipped` : ''}
                  </div>
                  {gitSkipped.length > 0 && (
                    <details className="cat-imp-skipped">
                      <summary>Show skipped files</summary>
                      <ul>
                        {gitSkipped.map((item) => (
                          <li key={item.path}>
                            {item.path} — {item.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </Card>
              )}

              {formatChoices.length > 1 && (
                <div data-testid="format-override-select">
                  <FormField
                    label="Import as format"
                    htmlFor="catalog-import-format-override"
                    helperText="Detection matched more than one format. Override the assumed format if the top match is wrong."
                  >
                    <select
                      id="catalog-import-format-override"
                      value={effectiveFormat ?? ''}
                      onChange={(event) => setFormatOverride(event.target.value)}
                      className="hive-control imp-select"
                    >
                      {formatChoices.map((candidate) => (
                        <option key={candidate.format} value={candidate.format}>
                          {formatChoiceLabel(candidate.format)} ({formatPercent(candidate.confidence)})
                        </option>
                      ))}
                    </select>
                  </FormField>
                </div>
              )}

              {ambiguousCandidates.length > 0 && (
                <Alert variant="warn" data-testid="detect-ambiguous">
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

              {/* The routing decision. Its tone is the shared status vocabulary — accent for the
                  catalog, ok for the publishable route, warn for the fork that asks a question,
                  neutral for the dead end — rather than four hand-written palette quads. */}
              <div
                className="cat-imp-routing"
                data-tone={catalogRoutingTone(routing.destination)}
                data-testid="catalog-import-routing"
              >
                {routing.destination === 'not-importable' ? (
                  <AlertTriangle aria-hidden />
                ) : (
                  <GitBranch aria-hidden />
                )}
                <div>
                  <div className="cat-imp-routing__title">Routing decision → {routing.label}</div>
                  <div className="cat-imp-routing__body">{routing.description}</div>
                  {adapterUnavailable && (
                    <div className="cat-imp-routing__note">
                      {unavailableReason || `${adapter?.label} import is unavailable in this runtime.`}
                    </div>
                  )}
                </div>
              </div>

              {/* The imported bytes, syntax-highlighted read-only in Monaco through the shared
                  {@link ReadOnlyCodeViewer} (MFX-43.1) — the same viewer the catalog detail's
                  Source & Code tab and the export surfaces use, so highlighting, theming and the
                  offline `<pre>` fallback are all inherited rather than re-derived. The language
                  is the detected/overridden format mapped through
                  `monacoLanguageForCatalogFormat`, so switching the override re-highlights the
                  preview. Archive uploads carry no text (only base64 bytes), so they get a note
                  instead of an empty editor. */}
              <div className="cat-imp-preview">
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
                  <p className="cat-imp-preview__empty" data-testid="catalog-import-preview-empty">
                    {gitSource
                      ? 'Repository selections have no single text document to preview. Detection ran over the selected files.'
                      : documentBase64
                        ? 'Archive uploads have no single text document to preview. Detection ran over the archive contents.'
                        : 'No source content to preview.'}
                  </p>
                )}
              </div>
            </div>
          )}

          {step === 'options' && (
            <div className="cat-imp-options">
              {routing.destination === 'catalog' && (
                <Alert variant="info">
                  <div className="font-medium">Store in catalog</div>
                  <div className="text-sm">
                    This source will be kept verbatim as {adapter?.label}. It will not create a
                    Project or auto-convert to OpenAPI. Continue to review its quality score before
                    anything is written.
                  </div>
                </Alert>
              )}
              {routing.destination === 'json-schema-choice' && (
                <fieldset className="cat-imp-choice">
                  <legend className="imp-heading">
                    Choose where this JSON Schema should go.
                  </legend>
                  <label className="cat-imp-choice__option">
                    <input
                      type="radio"
                      name="jsonSchemaChoice"
                      className="imp-check"
                      checked={jsonSchemaChoice === 'catalog'}
                      onChange={() => setJsonSchemaChoice('catalog')}
                    />
                    <span>
                      <span className="cat-imp-choice__title">Catalog for later conversion</span>
                      <span className="cat-imp-choice__desc">
                        Stored verbatim as a non-publishable, schemas-only catalog item — converted
                        only when you explicitly request it.
                      </span>
                    </span>
                  </label>
                  <label className="cat-imp-choice__option">
                    <input
                      type="radio"
                      name="jsonSchemaChoice"
                      className="imp-check"
                      checked={jsonSchemaChoice === 'types'}
                      onChange={() => setJsonSchemaChoice('types')}
                    />
                    <span>
                      <span className="cat-imp-choice__title">Types/Projects as current schema</span>
                      <span className="cat-imp-choice__desc">
                        Opens the existing type import review with this schema preloaded.
                      </span>
                    </span>
                  </label>
                </fieldset>
              )}

              {/* JSON Schema is the only format that asks the user anything here (Catalog vs
                  Types/Projects). Every other route reaches this step with nothing to configure,
                  so the otherwise-empty panel says so rather than reading as a rendering
                  failure. */}
              {!hasImportOptions && (
                <EmptyState
                  variant="compact"
                  tone="neutral"
                  icon={<SlidersHorizontal />}
                  title="No additional options"
                  description="Nothing to configure for this data type. Continue to the quality pre-flight — nothing is written to the catalog until you confirm it there."
                  data-testid="catalog-import-no-options"
                />
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
              onArchiveRootChange={handleArchiveRootChange}
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

          {step === 'import' && bulkMode && bulkPlan && bulkSource && (
            <CatalogBulkImportPanel
              plan={bulkPlan}
              source={bulkSource}
              onSuccess={() => {
                setState('done');
                onSuccess?.();
              }}
            />
          )}

          {step === 'import' && !bulkMode && (
            <div className="cat-imp-terminal">
              {state === 'done' ? (
                <>
                  <span className="tnt-icon-tile" data-tone="ok" aria-hidden>
                    <CheckCircle2 />
                  </span>
                  <p>
                    Stored in the catalog in its original format. Use{' '}
                    <strong>Convert to OpenAPI</strong> when ready.
                  </p>
                </>
              ) : (
                <>
                  <Spinner size="lg" aria-hidden />
                  <p role="status">Storing source in catalog…</p>
                </>
              )}
            </div>
          )}
        </ImportWizardBody>

        {/* The quality step owns its own footer so all three of its exits — Cancel, Import
            anyway, Import — sit on one row with the gate that governs them (IXH-2.2). */}
        {step !== 'quality' && (
          <ImportWizardFooter
            footer={footer}
            onBack={handleBack}
            onCancel={handleClose}
            onPrimary={handlePrimary}
            extra={
              /* The skip preference must stay reachable *outside* the quality step: with it on,
                 a non-blocking pre-flight auto-commits, so the step's own checkbox flashes past
                 too fast to uncheck — the preference would otherwise be a one-way switch.
                 Options is the last stop before the quality step on every catalog route, so it
                 is where the preference can always be turned back off. Hidden on the JSON
                 Schema → Types hand-off, which never reaches the quality step at all. */
              step === 'options' && commitSourceKind !== null ? (
                <label className="cat-imp-skip">
                  <input
                    type="checkbox"
                    className="imp-check"
                    checked={skipQualityStep}
                    onChange={(event) => handleSkipPreferenceChange(event.target.checked)}
                    data-testid="catalog-import-options-skip-preference"
                  />
                  Skip the quality step for clean imports
                </label>
              ) : undefined
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export default CatalogImportDialog;
