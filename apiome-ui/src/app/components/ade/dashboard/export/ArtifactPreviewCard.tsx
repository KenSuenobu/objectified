'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import type { editor as MonacoEditorApi } from 'monaco-editor';
import { monacoLanguageForArtifact } from '@/app/utils/export-target-language';
import { cn } from '@lib/utils';
import { Badge } from '../../../ui/Badge';
import { ReadOnlyCodeViewer } from './ReadOnlyCodeViewer';
import { ViewerActionsBar } from './ViewerActionsBar';
import { DeferredFilePanel, TruncatedContentNotice } from './ViewerContentGuard';
import { planViewerContent } from './exportViewerGuards';
import { downloadBlob } from './exportDownload';
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
  ARTIFACT_BADGE_TONE,
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
 *
 * A document past the per-file cap (MFX-43.5) is not handed to Monaco at all until the user asks,
 * and then only as an explicitly-labelled leading slice — copy and download still take the whole
 * document, so the guard bounds what is *rendered*, never what the user can take away.
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
  /** The highlighted problem (MFX-43.3), kept in sync between the editor and the problems list. */
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  /** The last external reveal request seen, so a re-render never replays it. */
  const [seenRevealNonce, setSeenRevealNonce] = useState<number | null>(null);
  /** Viewer actions state (MFX-43.5): soft wrap and code folding are the user's to set. */
  const [wordWrap, setWordWrap] = useState(false);
  const [folding, setFolding] = useState(true);
  /** Whether the user asked for an over-cap document to be shown (MFX-43.5). */
  const [contentRequested, setContentRequested] = useState(false);
  /** The mounted editor, so the Find action can open Monaco's own find widget. */
  const editorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null);

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
  const sizeBytes = useMemo(() => utf8ByteLength(artifact.text), [artifact.text]);
  const size = formatByteSize(sizeBytes);
  // MFX-43.5: what may go into Monaco. An over-cap document renders only once the user asks, and
  // then only as an explicitly-labelled head slice.
  const plan = useMemo(
    () =>
      planViewerContent({
        text: artifact.text,
        sizeBytes,
        requested: contentRequested,
      }),
    [artifact.text, sizeBytes, contentRequested],
  );
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

  // Markers are computed against the text that is actually in the editor: a finding past the end
  // of a truncated slice has no line to sit on, and clamping it to one would be a fake position.
  const markers = useProblemMarkers({
    problems,
    text: plan.text,
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
    text: plan.text,
    selectedEntity,
    onEntityLineClick,
    reveal: entityReveal,
  });

  const openProblem = useCallback(
    (problem: LocatedProblem) => {
      setSelectedProblemId(problem.id);
      // Clicking a finding in a document the guard is holding back loads it first — otherwise the
      // click would reveal a line in an editor that is not on screen (MFX-43.5).
      setContentRequested(true);
      markers.reveal(problem);
    },
    [markers],
  );

  /** Download the emitted document as its own file (MFX-43.5) — always the whole document. */
  const downloadFile = useCallback(() => {
    downloadBlob(
      new Blob([artifact.text], { type: artifact.mediaType || 'text/plain' }),
      artifact.filename,
    );
  }, [artifact.filename, artifact.mediaType, artifact.text]);

  /** Open Monaco's find widget; null while no editor is mounted (offline fallback / deferred). */
  const findInFile =
    plan.mode === 'deferred'
      ? null
      : () => {
          editorRef.current?.getAction?.('actions.find')?.run();
        };

  return (
    <div
      data-testid="export-artifact-preview"
      className={cn('vdlg-export__card', className)}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <FileCode2 className="h-4 w-4 text-accent" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wide text-fg">
          Emitted {artifact.filename}
        </span>
        <Badge
          data-testid="export-artifact-badge"
          variant={ARTIFACT_BADGE_TONE[badge.tone]}
          className="ml-auto"
        >
          {badge.label}
        </Badge>
      </div>

      <ViewerActionsBar
        file={{ name: artifact.filename, text: artifact.text, mediaType: artifact.mediaType }}
        wordWrap={wordWrap}
        onWordWrapChange={setWordWrap}
        folding={folding}
        onFoldingChange={setFolding}
        onFind={findInFile}
        testIdPrefix="export-artifact"
        className="mt-2 shrink-0"
      />

      {plan.mode === 'deferred' ? (
        <DeferredFilePanel
          fileName={artifact.filename}
          plan={plan}
          onLoad={() => setContentRequested(true)}
          onDownload={downloadFile}
          testIdPrefix="export-artifact"
          className="mt-2"
        />
      ) : (
        <>
          <TruncatedContentNotice
            plan={plan}
            onDownload={downloadFile}
            testIdPrefix="export-artifact"
            className="mt-2"
          />
          <ReadOnlyCodeViewer
            value={plan.text}
            language={language}
            wordWrap={wordWrap ? 'on' : 'off'}
            folding={folding}
            onMount={(editorInstance, monaco) => {
              editorRef.current = editorInstance;
              markers.onEditorMount(editorInstance, monaco);
              entityMarkers.onEditorMount(editorInstance, monaco);
            }}
            height={360}
            className="vdlg-export__preview"
            editorTestId="export-artifact-editor"
            fallbackTestId="export-artifact-content"
            documentLabel={artifact.filename}
          />
        </>
      )}
      <ProblemsPanel
        problems={problems}
        selectedId={selectedProblemId}
        onSelect={openProblem}
        className="mt-2"
      />

      <p className="mt-2 shrink-0 text-xs text-fg-muted">{badge.hint}</p>
      <p
        data-testid="export-artifact-meta"
        data-truncated={plan.truncated ? 'true' : 'false'}
        className="mt-0.5 shrink-0 text-2xs text-fg-muted"
      >
        {size}
        {/* When the viewer holds less than the document, the meta line says so too — the size on
            screen and the size of the file are different facts (MFX-43.5). */}
        {plan.mode === 'head' ? ` (${formatByteSize(plan.shownBytes)} shown)` : ''}
        {artifact.mediaType ? ` · ${artifact.mediaType}` : ''}
        {` · ${language}`}
      </p>
    </div>
  );
}

export default ArtifactPreviewCard;
