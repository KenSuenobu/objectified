'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, FolderTree } from 'lucide-react';
import { monacoLanguageForArtifact } from '@/app/utils/export-target-language';
import { cn } from '@lib/utils';
import { ReadOnlyCodeViewer } from './ReadOnlyCodeViewer';
import { BundleTree } from './BundleTree';
import { BundleFileTabs } from './BundleFileTabs';
import { ProblemsPanel } from './ProblemsPanel';
import { useProblemMarkers } from './useProblemMarkers';
import { formatByteSize } from './exportArtifactPreview';
import {
  problemsForFile,
  type LocatedProblem,
  type ProblemRevealRequest,
} from './exportProblemMarkers';
import {
  buildBundleTree,
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
  const [copied, setCopied] = useState(false);
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

  const markers = useProblemMarkers({
    problems: activeProblems,
    text: activeFile?.text ?? '',
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
    text: activeFile?.text ?? '',
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

  const copyActive = useCallback(async () => {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(activeFile.text);
      setCopied(true);
    } catch {
      // Clipboard unavailable — leave the button unchanged.
    }
  }, [activeFile]);

  const copyButton = (
    <button
      type="button"
      data-testid="bundle-copy"
      onClick={() => void copyActive()}
      title={copied ? 'Copied' : 'Copy file'}
      aria-label={copied ? 'Copied' : 'Copy file'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium shadow-sm transition-colors',
        copied
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
          : 'border-gray-200 bg-white/95 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900/95 dark:text-gray-200 dark:hover:bg-gray-800',
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );

  const viewer = activeFile ? (
    <>
      <ReadOnlyCodeViewer
        value={activeFile.text}
        language={language}
        overlay={copyButton}
        onMount={(editorInstance, monaco) => {
          markers.onEditorMount(editorInstance, monaco);
          entityMarkers.onEditorMount(editorInstance, monaco);
        }}
        height={360}
        className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-[#1e1e1e]"
        editorTestId="bundle-file-editor"
        fallbackTestId="bundle-file-content"
        documentLabel={activeFile.path}
      />
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
          className="ml-auto truncate text-[11px] text-gray-400 dark:text-gray-500"
        >
          {activeFile.path} · {formatByteSize(activeFile.sizeBytes)}
          {activeFile.mediaType ? ` · ${activeFile.mediaType}` : ''} · {language}
        </span>
      )}
    </div>
  );
}

export default BundleExplorer;
