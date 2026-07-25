'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, FileCode2 } from 'lucide-react';
import { monacoLanguageForArtifact } from '@/app/utils/export-target-language';
import { cn } from '@lib/utils';
import { ReadOnlyCodeViewer } from './ReadOnlyCodeViewer';
import { ProblemsPanel } from './ProblemsPanel';
import { useProblemMarkers } from './useProblemMarkers';
import { useEntityMarkers } from './useEntityMarkers';
import type { LossinessReport } from './exportFidelityPreview';
import type { LocatedProblem, ProblemRevealRequest } from './exportProblemMarkers';
import {
  normalizedLocationFile,
  type EntityRevealRequest,
  type ExportManifestEntity,
} from './exportPreviewManifest';
import {
  artifactBadgeClass,
  buildArtifactBadge,
  formatByteSize,
  utf8ByteLength,
  validateEmittedArtifact,
  type EmittedArtifact,
} from './exportArtifactPreview';

interface ArtifactPreviewCardProps {
  /** The emitted document as captured from `POST /api/export/document`. */
  artifact: EmittedArtifact;
  /**
   * The per-construct loss report from the dry-run preview (MFX-2.5), used for the
   * badge's round-trip claim; null when the preview fetch failed or has not loaded.
   */
  report: LossinessReport | null;
  /** The chosen export target's registry key — drives Monaco syntax highlighting. */
  targetKey?: string | null;
  /**
   * The Verify lenses' located problems belonging to this document (MFX-43.3, already filtered by
   * the caller) — rendered as squiggle markers, gutter bars, and the problems list.
   */
  problems?: LocatedProblem[];
  /**
   * A "open this problem" request from outside (a Verify lens click, MFX-43.3): highlights the
   * problem and reveals its line. Repeat requests re-trigger via nonce.
   */
  reveal?: ProblemRevealRequest | null;
  /**
   * The export preview manifest's entities (IXH-4.1): located entities drive the line-click →
   * entity resolution and the selected entity's declaration-line highlight. For a single
   * document every located entity lives in the manifest's one file.
   */
  manifestEntities?: ExportManifestEntity[];
  /** The selected entity's canonical key (shared with the manifest tree). */
  selectedEntityKey?: string | null;
  /** A "reveal this entity in the code" request (a manifest tree click); nonce re-triggers. */
  entityReveal?: EntityRevealRequest | null;
  /** A line click resolved to a located entity (code → entity direction). */
  onEntityLineClick?: (entity: ExportManifestEntity) => void;
  className?: string;
}

/**
 * ArtifactPreviewCard — the emitted-artifact preview (MFX-6.3, #3857).
 *
 * Shows the document the export produced *before* the user downloads it: a compact header
 * (filename + fidelity badge), the full emitted buffer in the shared read-only Monaco viewer
 * (MFX-43.1) with syntax highlighting, a copy-to-clipboard control, and size/meta hints underneath.
 * The highlight language is resolved registry-driven — the emitter key, then the artifact's own
 * media type / filename / bytes — so a newly-registered emitter highlights without a change here.
 *
 * When the caller passes the document's located Verify problems (MFX-43.3), they render exactly as
 * in the bundle explorer: squiggle markers + gutter bars in the viewer and a {@link ProblemsPanel}
 * underneath, with the same two-way problem ↔ line navigation.
 */
export function ArtifactPreviewCard({
  artifact,
  report,
  targetKey,
  problems = [],
  reveal = null,
  manifestEntities = [],
  selectedEntityKey = null,
  entityReveal = null,
  onEntityLineClick,
  className,
}: ArtifactPreviewCardProps) {
  const [copied, setCopied] = useState(false);
  /** The highlighted problem (MFX-43.3), kept in sync between the editor and the problems list. */
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  /** The last external reveal request seen, so a re-render never replays it. */
  const [seenRevealNonce, setSeenRevealNonce] = useState<number | null>(null);

  // An external reveal request (a Verify lens click): select the problem — the "adjust state
  // during render" pattern. The editor-side line reveal is applied by {@link useProblemMarkers}.
  if (reveal && reveal.nonce !== seenRevealNonce) {
    setSeenRevealNonce(reveal.nonce);
    setSelectedProblemId(reveal.problem.id);
  }

  const badge = useMemo(
    () => buildArtifactBadge(validateEmittedArtifact(artifact), report),
    [artifact, report],
  );
  const size = useMemo(() => formatByteSize(utf8ByteLength(artifact.text)), [artifact.text]);
  const language = useMemo(
    () =>
      monacoLanguageForArtifact({
        targetFormat: targetKey ?? null,
        mediaType: artifact.mediaType,
        filename: artifact.filename,
        sample: artifact.text,
      }),
    [artifact.filename, artifact.mediaType, artifact.text, targetKey],
  );

  const markers = useProblemMarkers({
    problems,
    text: artifact.text,
    selectedProblemId,
    onMarkerSelect: (problem) => setSelectedProblemId(problem.id),
    reveal,
  });

  // IXH-4.1: a single document holds every located entity in the manifest's one file —
  // that file's (normalized) path is the card's "active file" for click resolution.
  const manifestFile = useMemo(() => {
    const located = manifestEntities.find((entity) => entity.location != null);
    return located ? normalizedLocationFile(located) : null;
  }, [manifestEntities]);
  const selectedEntity = useMemo(
    () =>
      selectedEntityKey
        ? manifestEntities.find((entity) => entity.key === selectedEntityKey) ?? null
        : null,
    [manifestEntities, selectedEntityKey],
  );
  const entityMarkers = useEntityMarkers({
    entities: manifestEntities,
    activeFile: manifestFile,
    text: artifact.text,
    selectedEntity,
    onEntityLineClick,
    reveal: entityReveal,
  });

  const openProblem = useCallback(
    (problem: LocatedProblem) => {
      setSelectedProblemId(problem.id);
      markers.reveal(problem);
    },
    [markers],
  );

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(artifact.text);
      setCopied(true);
    } catch {
      // Clipboard unavailable — leave the button unchanged.
    }
  }, [artifact.text]);

  const copyButton = (
    <button
      type="button"
      data-testid="export-artifact-copy"
      onClick={() => void copyToClipboard()}
      title={copied ? 'Copied' : 'Copy to clipboard'}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium shadow-sm transition-colors',
        copied
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
          : 'border-gray-200 bg-white/95 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900/95 dark:text-gray-200 dark:hover:bg-gray-800',
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );

  return (
    <div
      data-testid="export-artifact-preview"
      className={cn('flex min-h-0 flex-col rounded-xl border border-gray-200 p-3 dark:border-gray-700', className)}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <FileCode2 className="h-4 w-4 text-indigo-500" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
          Emitted {artifact.filename}
        </span>
        <span
          data-testid="export-artifact-badge"
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${artifactBadgeClass(badge.tone)}`}
        >
          {badge.label}
        </span>
      </div>

      <ReadOnlyCodeViewer
        value={artifact.text}
        language={language}
        overlay={copyButton}
        onMount={(editorInstance, monaco) => {
          markers.onEditorMount(editorInstance, monaco);
          entityMarkers.onEditorMount(editorInstance, monaco);
        }}
        height={360}
        className="mt-2 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-[#1e1e1e]"
        editorTestId="export-artifact-editor"
        fallbackTestId="export-artifact-content"
      />
      <ProblemsPanel
        problems={problems}
        selectedId={selectedProblemId}
        onSelect={openProblem}
        className="mt-2"
      />

      <p className="mt-2 shrink-0 text-xs text-gray-500 dark:text-gray-400">{badge.hint}</p>
      <p className="mt-0.5 shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
        {size}
        {artifact.mediaType ? ` · ${artifact.mediaType}` : ''}
        {` · ${language}`}
      </p>
    </div>
  );
}

export default ArtifactPreviewCard;
