'use client';

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import { cn } from '@lib/utils';
import { formatByteSize } from './exportArtifactPreview';
import {
  aggregateFolderCounts,
  flattenBundleTree,
  type BundleTreeNode,
  type BundleTreeRow,
  type FileFindingCounts,
} from './exportBundle';
import { BundleFindingBadge } from './BundleFindingBadge';

/**
 * BundleTree — the left-rail file explorer for a multi-file export bundle (MFX-43.2, #4362).
 *
 * Renders the manifest's folder/file tree (built by {@link buildBundleTree}) as an IDE-style
 * explorer: folders collapse/expand, files select into the viewer, and every node badges its own
 * finding count (a folder rolls up the counts of everything inside it). It is the navigation
 * backbone the MFX-43.3 problem markers hang off — clicking a finding will reveal its file here.
 *
 * Large bundles stay responsive without a windowing dependency: the scroll region uses CSS
 * `content-visibility` so off-screen rows skip layout/paint until scrolled into view (MFX-43.5
 * deepens the large-output guards).
 *
 * Accessibility (MFX-41.5): a real `role="tree"` over the flattened visible rows
 * ({@link flattenBundleTree}), following the `ExportManifestPanel` precedent — one Tab stop
 * (roving `tabindex`), ↑/↓ to move, →/← to expand/collapse or step to the parent, Home/End to
 * jump, Enter/Space to open a file. Every row reports its `aria-level` / `aria-setsize` /
 * `aria-posinset`, so a collapsed subtree never misreports the shape of the bundle, and the
 * interactive element *is* the tree item (no focusable control nested inside one).
 */

export interface BundleTreeProps {
  /** The bundle's root-level tree nodes (from {@link buildBundleTree}). */
  nodes: BundleTreeNode[];
  /** Per-file finding counts (from {@link countFindingsByFile}); folders roll these up. */
  countsByPath: Map<string, FileFindingCounts>;
  /** The currently open file's path, highlighted in the tree. */
  activePath: string | null;
  /** Called with a file's path when the user selects it. */
  onSelect: (path: string) => void;
  /** Extra classes for the scroll container. */
  className?: string;
}

/**
 * The bundle file tree. Folders are open by default (small bundles read best fully expanded); the
 * user can collapse any subtree.
 *
 * @param props The tree nodes, finding counts, active file, and selection callback.
 * @returns The scrollable file explorer.
 */
export function BundleTree({ nodes, countsByPath, activePath, onSelect, className }: BundleTreeProps) {
  // Folders are expanded unless the user collapsed them, so the set holds the exceptions.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const rows = useMemo(() => flattenBundleTree(nodes, collapsed), [nodes, collapsed]);

  // The single Tab stop: the row that owns focus. Clamped on every render so collapsing a folder
  // (which removes rows) can never leave the tab stop pointing past the end of the list.
  // `null` until the user moves focus themselves — see `tabStopIndex`.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const activeIndex = rows.findIndex((row) => row.node.path === activePath);
  // Before the user has moved focus, the tab stop is the open file (when there is one), so tabbing
  // into the tree lands where the user already is rather than at the top of the bundle. Clamped on
  // every render: collapsing a folder removes rows, and the tab stop must not point past the end.
  const tabStopIndex = Math.min(
    Math.max(focusIndex ?? Math.max(activeIndex, 0), 0),
    Math.max(rows.length - 1, 0),
  );

  /** Move the roving tab stop to a row and give it DOM focus. */
  const focusRow = useCallback((index: number) => {
    setFocusIndex(index);
    rowRefs.current.get(index)?.focus();
  }, []);

  const toggleFolder = useCallback((path: string, expand: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (expand) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /** Enter/Space/click: folders toggle, files open in the viewer. */
  const activateRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setFocusIndex(index);
      if (row.node.kind === 'folder') toggleFolder(row.node.path, !row.expanded);
      else onSelect(row.node.path);
    },
    [rows, toggleFolder, onSelect],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (rows.length === 0) return;
    const current = tabStopIndex;
    const row = rows[current];

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateRow(current);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'ArrowDown'
          ? current + 1
          : event.key === 'ArrowUp'
            ? current - 1
            : event.key === 'Home'
              ? 0
              : rows.length - 1;
      focusRow(Math.min(Math.max(next, 0), rows.length - 1));
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (!row) return;
      // A collapsed folder opens; an already-open one steps into its first child.
      if (row.hasChildren && !row.expanded) toggleFolder(row.node.path, true);
      else if (row.expanded) focusRow(Math.min(current + 1, rows.length - 1));
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (!row) return;
      // An open folder closes; anything else steps out to its parent row.
      if (row.hasChildren && row.expanded) {
        toggleFolder(row.node.path, false);
        return;
      }
      const parent = rows.findIndex((candidate) => candidate.node.path === row.parentPath);
      if (parent >= 0) focusRow(parent);
    }
  };

  return (
    <div
      data-testid="bundle-tree"
      className={cn(
        'overflow-auto rounded-lg border border-gray-200 bg-gray-50/60 p-1 dark:border-gray-700 dark:bg-gray-900/40',
        className,
      )}
    >
      <ul role="tree" aria-label="Bundle files" onKeyDown={handleKeyDown}>
        {rows.map((row, index) => (
          <BundleTreeRowItem
            key={row.node.path}
            row={row}
            index={index}
            tabStop={index === tabStopIndex}
            selected={row.node.path === activePath}
            counts={aggregateFolderCounts(row.node, countsByPath)}
            onActivate={activateRow}
            registerRef={(node) => {
              if (node) rowRefs.current.set(index, node);
              else rowRefs.current.delete(index);
            }}
          />
        ))}
      </ul>
    </div>
  );
}

interface BundleTreeRowItemProps {
  row: BundleTreeRow;
  index: number;
  tabStop: boolean;
  selected: boolean;
  counts: FileFindingCounts;
  onActivate: (index: number) => void;
  registerRef: (node: HTMLButtonElement | null) => void;
}

/** One tree row — a folder (collapsible) or a selectable file; the button *is* the tree item. */
function BundleTreeRowItem({
  row,
  index,
  tabStop,
  selected,
  counts,
  onActivate,
  registerRef,
}: BundleTreeRowItemProps) {
  const { node, depth, hasChildren, expanded } = row;
  const isFolder = node.kind === 'folder';
  // Data-driven indentation via a CSS var so the depth is class-computed, not a hard-coded value.
  const indentStyle = { '--tree-depth': depth - 1 } as React.CSSProperties;
  const indentClass = 'pl-[calc(0.375rem+var(--tree-depth)*0.875rem)]';
  // Off-screen rows skip paint/layout until scrolled in — cheap virtualization for large bundles.
  const virtualizeClass = '[content-visibility:auto] [contain-intrinsic-size:auto_1.75rem]';

  return (
    <li role="presentation">
      <button
        type="button"
        role="treeitem"
        ref={registerRef}
        aria-level={depth}
        aria-setsize={row.setSize}
        aria-posinset={row.posInSet}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-selected={isFolder ? undefined : selected}
        tabIndex={tabStop ? 0 : -1}
        data-testid={
          isFolder ? `bundle-tree-folder-${node.path}` : `bundle-tree-file-${node.path}`
        }
        data-selected={isFolder ? undefined : selected}
        onClick={() => onActivate(index)}
        style={indentStyle}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
          indentClass,
          virtualizeClass,
          selected
            ? 'bg-indigo-100 font-medium text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200'
            : isFolder
              ? 'font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800'
              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
        )}
      >
        {isFolder ? (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-gray-400 motion-safe:transition-transform',
              expanded && 'rotate-90',
            )}
            aria-hidden
          />
        ) : (
          /* Spacer aligning file names under the folder chevron column. */
          <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        {isFolder ? (
          expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-indigo-500" aria-hidden />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-indigo-500" aria-hidden />
          )
        ) : (
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
        )}
        <span className="truncate">{node.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <BundleFindingBadge counts={counts} testId={`bundle-tree-badge-${node.path}`} />
          {node.kind === 'file' && (
            <span className="text-2xs tabular-nums text-gray-400 dark:text-gray-500">
              {formatByteSize(node.file.sizeBytes)}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

export default BundleTree;
