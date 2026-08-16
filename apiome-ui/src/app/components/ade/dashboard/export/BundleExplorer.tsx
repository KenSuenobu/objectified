'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { FolderTree } from 'lucide-react';
import type { editor as MonacoEditorApi } from 'monaco-editor';
import { monacoLanguageForArtifact } from '@/app/utils/export-target-language';
import { cn } from '@lib/utils';
import { ReadOnlyCodeViewer } from './ReadOnlyCodeViewer';
import { BundleTree } from './BundleTree';
import { BundleFileTabs } from './BundleFileTabs';
import { ProblemsPanel } from './ProblemsPanel';
import { ViewerActionsBar } from './ViewerActionsBar';
import { DeferredFilePanel, TruncatedContentNotice } from './ViewerContentGuard';
import { useProblemMarkers } from './useProblemMarkers';
import { formatByteSize } from './exportArtifactPreview';
import { downloadBlob } from './exportDownload';
import {
  describeInlineBudget,
  planBundleInlineBudget,
  planViewerContent,
} from './exportViewerGuards';
import {
  problemsForFile,
  type LocatedProblem,
  type ProblemRevealRequest,
} from './exportProblemMarkers';
import {
  buildBundleTree,
  bundleFileName,
  isMultiFileBundle,
  type BundleManifest,
  type FileFindingCounts,
} from './exportBundle';
import { useEntityMarkers } from './useEntityMarkers';
import {
  normalizedLocationFile,
  type EntityRevealRequest,
  type ExportManifestEntity,
} from './exportPreviewManifest';

/** How many recently-opened files the tab strip keeps before dropping the oldest. */
const MAX_OPEN_TABS = 8;

export interface BundleExplorerProps {
  /** The emitted bundle to explore. */
  manifest: BundleManifest;
  /** Per-file finding counts (from {@link countFindingsByFile}); drives tree/tab badges. */
  countsByPath: Map<string, FileFindingCounts>;
  /** The chosen export target's registry key — drives Monaco syntax highlighting. */
  targetKey?: string | null;
  /**
   * The Verify lenses' located problems for the whole bundle (MFX-43.3); the explorer filters
   * them to the active file for its markers, gutter bars, and problems list.
   */
  problems?: LocatedProblem[];
  /**
   * A "open this problem" request from outside (a Verify lens click, MFX-43.3): the explorer opens
   * the problem's file, highlights it, and reveals its line. Repeat requests re-trigger via nonce.
   */
  reveal?: ProblemRevealRequest | null;
  /**
   * The export preview manifest's entities (IXH-4.1). Located entities drive the code → entity
   * direction (a line click resolves to its innermost entity) and the selected entity's
   * declaration-line highlight.
   */
  manifestEntities?: ExportManifestEntity[];
  /** The selected entity's canonical key (shared with the manifest tree). */
  selectedEntityKey?: string | null;
  /**
   * A "reveal this entity in the code" request (a manifest tree click, IXH-4.1): the explorer
   * opens the entity's bundle file and scrolls its declaration line to center. Nonce re-triggers.
   */
  entityReveal?: EntityRevealRequest | null;
  /** A line click resolved to a located entity (code → entity direction). */
  onEntityLineClick?: (entity: ExportManifestEntity) => void;
  /**
   * Download the whole bundle as a `.zip` (MFX-43.5). The Studio owns the zip building, so the
   * explorer just offers the action; omitted when the host has no bundle download to give.
   */
  onDownloadBundle?: (() => void) | null;
  className?: string;
}

/**
 * BundleExplorer — the multi-file review surface (MFX-43.2, #4362).
 *
 * Composes the three parts of reviewing a bundle: the {@link BundleTree} left rail to navigate the
 * files, the {@link BundleFileTabs} strip of recently-opened files, and the shared read-only Monaco
 * viewer (MFX-43.1) showing the active file with per-file syntax highlighting. Opening a file from
 * the tree activates it and pushes it onto the recent-files strip.
 *
 * A single-file bundle skips the tree and tabs entirely (MFX-43.2 acceptance) — it is just the
 * viewer over the one file, so the navigation chrome never appears for a lone document.
 *
 * The Verify lenses' located problems (MFX-43.3) ride along as squiggle markers + gutter bars on
 * the active file and as a per-file {@link ProblemsPanel} under the viewer; clicking a problem row
 * reveals its line, clicking a marked line highlights its row, and an external
 * {@link ProblemRevealRequest} (a lens click) opens file + line from outside.
 *
 * Large bundles are guarded (MFX-43.5): the inline budget admits files to the viewer in emit order,
 * and anything past it — or past the per-file cap — is navigable in the tree but loads only when
 * the user opens it. Every file, loaded or not, still copies and downloads in full through the
 * shared {@link ViewerActionsBar}.
 */
export function BundleExplorer({
  manifest,
  countsByPath,
  targetKey,
  problems = [],
  reveal = null,
  manifestEntities = [],
  selectedEntityKey = null,
  entityReveal = null,
  onEntityLineClick,
  onDownloadBundle = null,
  className,
}: BundleExplorerProps) {
  const multi = isMultiFileBundle(manifest);
  const tree = useMemo(() => buildBundleTree(manifest.files), [manifest.files]);
  const filesByPath = useMemo(
    () => new Map(manifest.files.map((file) => [file.path, file])),
    [manifest.files],
  );

  const [activePath, setActivePath] = useState<string | null>(manifest.primaryPath);
  // The recent-files strip; the primary opens first. Single-file bundles never show it.
  const [openPaths, setOpenPaths] = useState<string[]>(multi ? [manifest.primaryPath] : []);
  /** Viewer actions state (MFX-43.5): soft wrap and code folding are the user's to set. */
  const [wordWrap, setWordWrap] = useState(false);
  const [folding, setFolding] = useState(true);
  /** Files the user explicitly asked the viewer to load, past the guards (MFX-43.5). */
  const [requestedPaths, setRequestedPaths] = useState<ReadonlySet<string>>(() => new Set());
  /** The mounted editor, so the Find action can open Monaco's own find widget. */
  const editorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null);
  /** The highlighted problem (MFX-43.3), kept in sync between the editor and the problems list. */
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  /** The last external reveal request seen, so a re-render never replays it. */
  const [seenRevealNonce, setSeenRevealNonce] = useState<number | null>(null);
  /** The last external entity-reveal request seen (IXH-4.1), same replay guard. */
  const [seenEntityRevealNonce, setSeenEntityRevealNonce] = useState<number | null>(null);

  // A fresh manifest (a new generate) resets navigation to its primary file.
  const [manifestKey, setManifestKey] = useState(manifest.primaryPath);
  if (manifest.primaryPath !== manifestKey) {
    setManifestKey(manifest.primaryPath);
    setActivePath(manifest.primaryPath);
    setOpenPaths(multi ? [manifest.primaryPath] : []);
    setSelectedProblemId(null);
    // A new bundle re-earns its guards: what the user chose to load in the previous one says
    // nothing about this one's files (MFX-43.5).
    setRequestedPaths(new Set());
  }

  // An external reveal request (a Verify lens click): make the problem's file active and select
  // the problem — the "adjust state during render" pattern, like the manifest reset above. The
  // editor-side line reveal itself is applied by {@link useProblemMarkers} once the file's
  // problems are in place. A remount with the request still set (leaving Review and coming back)
  // replays it, restoring the last jumped-to finding. Unfiled problems have no unambiguous home
  // in a multi-file bundle and are ignored (no fake positions).
  if (reveal && reveal.nonce !== seenRevealNonce) {
    setSeenRevealNonce(reveal.nonce);
    const revealPath = reveal.problem.file ?? (multi ? null : manifest.primaryPath);
    if (revealPath && filesByPath.has(revealPath)) {
      setSelectedProblemId(reveal.problem.id);
      // "Open this finding" is a request for a specific line, so a guarded file loads rather than
      // answering with the "load this file" panel the user did not ask for (MFX-43.5).
      setRequestedPaths((current) =>
        current.has(revealPath) ? current : new Set(current).add(revealPath),
      );
      if (activePath !== revealPath) {
        setActivePath(revealPath);
        setOpenPaths((current) =>
          [revealPath, ...current.filter((p) => p !== revealPath)].slice(0, MAX_OPEN_TABS),
        );
      }
    }
  }

  // An external entity-reveal request (a manifest tree click, IXH-4.1): make the entity's bundle
  // file active — the same "adjust state during render" pattern as the problem reveal above. The
  // editor-side line scroll is applied by {@link useEntityMarkers} once the file is active. An
  // entity whose file is not in this bundle (a path mismatch) is ignored — no fake navigation.
  if (entityReveal && entityReveal.nonce !== seenEntityRevealNonce) {
    setSeenEntityRevealNonce(entityReveal.nonce);
    const entityPath = normalizedLocationFile(entityReveal.entity);
    if (entityPath && filesByPath.has(entityPath) && activePath !== entityPath) {
      setActivePath(entityPath);
      setOpenPaths((current) =>
        multi
          ? [entityPath, ...current.filter((p) => p !== entityPath)].slice(0, MAX_OPEN_TABS)
          : current,
      );
    }
  }

  const selectFile = useCallback(
    (path: string) => {
      setActivePath(path);
      setSelectedProblemId(null);
      setOpenPaths((current) => {
        const withoutPath = current.filter((p) => p !== path);
        return [path, ...withoutPath].slice(0, MAX_OPEN_TABS);
      });
    },
    [],
  );

  const closeTab = useCallback(
    (path: string) => {
      setOpenPaths((current) => {
        const index = current.indexOf(path);
        const next = current.filter((p) => p !== path);
        // Closing the active tab moves focus to a neighbour (the one before it, else the new first).
        if (path === activePath) {
          const fallback = next[Math.max(0, index - 1)] ?? next[0] ?? null;
          setActivePath(fallback);
        }
        return next;
      });
    },
    [activePath],
  );

  const activeFile = activePath ? filesByPath.get(activePath) ?? null : null;

  // MFX-43.5: spend the bundle's inline budget over the files in emit order, then decide what the
  // active file may put into Monaco — whole, an explicit head slice, or nothing until asked.
  const budget = useMemo(() => planBundleInlineBudget(manifest.files), [manifest.files]);
  const budgetNotice = useMemo(
    () => describeInlineBudget(budget, manifest.files.length),
    [budget, manifest.files.length],
  );
  const plan = useMemo(
    () =>
      planViewerContent({
        text: activeFile?.text ?? '',
        sizeBytes: activeFile?.sizeBytes ?? 0,
        inlineAllowed: activePath ? budget.inline.has(activePath) : true,
        requested: activePath ? requestedPaths.has(activePath) : false,
      }),
    [activeFile, activePath, budget, requestedPaths],
  );

  /** Load the active file into the viewer despite the guards (an explicit user action). */
  const loadActiveFile = useCallback(() => {
    if (!activePath) return;
    setRequestedPaths((current) => new Set(current).add(activePath));
  }, [activePath]);

  /** Download the active file on its own (MFX-43.5) — always the whole file, never the slice. */
  const downloadActiveFile = useCallback(() => {
    if (!activeFile) return;
    downloadBlob(
      new Blob([activeFile.text], { type: activeFile.mediaType || 'text/plain' }),
      bundleFileName(activeFile.path),
    );
  }, [activeFile]);

  const language = useMemo(
    () =>
      activeFile
        ? monacoLanguageForArtifact({
            targetFormat: targetKey ?? null,
            mediaType: activeFile.mediaType,
            filename: activeFile.path,
            sample: activeFile.text,
          })
        : 'plaintext',
    [activeFile, targetKey],
  );

  // The active file's located problems (MFX-43.3). Problems that name no file are attributable
  // only when the bundle *is* one document — a multi-file bundle leaves them list-only rather
  // than guessing (no fake positions).
  const activeProblems = useMemo(
    () => (activePath ? problemsForFile(problems, activePath, { includeUnfiled: !multi }) : []),
    [problems, activePath, multi],
  );

  // Markers are computed against the text that is actually in the editor: a finding past the end
  // of a truncated slice has no line to sit on, and clamping it to one would be a fake position.
  const markers = useProblemMarkers({
    problems: activeProblems,
    text: plan.text,
    selectedProblemId,
    onMarkerSelect: (problem) => setSelectedProblemId(problem.id),
    reveal,
  });

  // The active file's located manifest entities (IXH-4.1) and the shared selection.
  const activeEntities = useMemo(
    () =>
      activePath
        ? manifestEntities.filter((entity) => normalizedLocationFile(entity) === activePath)
        : [],
    [manifestEntities, activePath],
  );
  const selectedEntity = useMemo(
    () =>
      selectedEntityKey
        ? manifestEntities.find((entity) => entity.key === selectedEntityKey) ?? null
        : null,
    [manifestEntities, selectedEntityKey],
  );
  const entityMarkers = useEntityMarkers({
    entities: activeEntities,
    activeFile: activePath,
    text: plan.text,
    selectedEntity,
    onEntityLineClick,
    reveal: entityReveal,
  });

  const openProblem = useCallback(
    (problem: LocatedProblem) => {
      setSelectedProblemId(problem.id);
      // Clicking a finding in a file the guard is holding back loads it first — otherwise the
      // click would reveal a line in an editor that is not on screen (MFX-43.5).
      loadActiveFile();
      markers.reveal(problem);
    },
    [loadActiveFile, markers],
  );

  /** Open Monaco's find widget; null while no editor is mounted (offline fallback / deferred). */
  const findInFile =
    !activeFile || plan.mode === 'deferred'
      ? null
      : () => {
          editorRef.current?.getAction?.('actions.find')?.run();
        };

  const actionsBar = (
    <ViewerActionsBar
      file={
        activeFile
          ? {
              name: bundleFileName(activeFile.path),
              text: activeFile.text,
              mediaType: activeFile.mediaType,
            }
          : null
      }
      wordWrap={wordWrap}
      onWordWrapChange={setWordWrap}
      folding={folding}
      onFoldingChange={setFolding}
      onFind={findInFile}
      onDownloadBundle={onDownloadBundle}
      testIdPrefix="bundle"
      className="mb-2 shrink-0"
    />
  );

  const viewer = activeFile ? (
    <>
      {actionsBar}
      {plan.mode === 'deferred' ? (
        <DeferredFilePanel
          fileName={bundleFileName(activeFile.path)}
          plan={plan}
          onLoad={loadActiveFile}
          onDownload={downloadActiveFile}
          testIdPrefix="bundle"
        />
      ) : (
        <>
          <TruncatedContentNotice
            plan={plan}
            onDownload={downloadActiveFile}
            testIdPrefix="bundle"
            className="mb-2"
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
            className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-[#1e1e1e]"
            editorTestId="bundle-file-editor"
            fallbackTestId="bundle-file-content"
            documentLabel={activeFile.path}
          />
        </>
      )}
      <ProblemsPanel
        problems={activeProblems}
        selectedId={selectedProblemId}
        onSelect={openProblem}
        className="mt-2"
      />
    </>
  ) : (
    <div
      data-testid="bundle-empty"
      className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-gray-200 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
    >
      Select a file from the tree to view it.
    </div>
  );

  // Single-file bundle: no tree, no tabs — just the one file in the viewer.
  if (!multi) {
    return (
      <div
        data-testid="bundle-explorer"
        data-multi="false"
        className={cn('flex min-h-0 flex-col rounded-xl border border-gray-200 p-3 dark:border-gray-700', className)}
      >
        <BundleHeader fileCount={manifest.files.length} activeFile={activeFile} language={language} />
        <div className="mt-2 flex min-h-0 flex-1 flex-col">{viewer}</div>
      </div>
    );
  }

  return (
    <div
      data-testid="bundle-explorer"
      data-multi="true"
      className={cn('flex min-h-0 flex-col rounded-xl border border-gray-200 p-3 dark:border-gray-700', className)}
    >
      <BundleHeader fileCount={manifest.files.length} activeFile={activeFile} language={language} />
      {/* MFX-43.5: say up front that some of this bundle loads on demand — a tree row that opens
          into a "load this file" panel should never be a surprise. */}
      {budgetNotice && (
        <p
          data-testid="bundle-budget-notice"
          className="mt-1 shrink-0 text-2xs text-gray-500 dark:text-gray-400"
        >
          {budgetNotice}
        </p>
      )}
      <div className="mt-2 grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-[minmax(11rem,15rem)_1fr]">
        <BundleTree
          nodes={tree}
          countsByPath={countsByPath}
          activePath={activePath}
          onSelect={selectFile}
          className="max-h-[420px]"
        />
        <div className="flex min-h-0 flex-col">
          <BundleFileTabs
            openPaths={openPaths}
            activePath={activePath}
            countsByPath={countsByPath}
            onActivate={setActivePath}
            onClose={closeTab}
          />
          <div className="mt-2 flex min-h-0 flex-1 flex-col">{viewer}</div>
        </div>
      </div>
    </div>
  );
}

interface BundleHeaderProps {
  fileCount: number;
  activeFile: { path: string; sizeBytes: number; mediaType: string } | null;
  language: string;
}

/** The bundle header: file count and the active file's path/size/language meta. */
function BundleHeader({ fileCount, activeFile, language }: BundleHeaderProps) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <FolderTree className="h-4 w-4 text-indigo-500" aria-hidden />
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
        Bundle · {fileCount} file{fileCount === 1 ? '' : 's'}
      </span>
      {activeFile && (
        <span
          data-testid="bundle-active-meta"
          className="ml-auto truncate text-2xs text-gray-400 dark:text-gray-500"
        >
          {activeFile.path} · {formatByteSize(activeFile.sizeBytes)}
          {activeFile.mediaType ? ` · ${activeFile.mediaType}` : ''} · {language}
        </span>
      )}
    </div>
  );
}

export default BundleExplorer;
