'use client';

import { useRef, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { TAB_LIST_SCROLL_CLASS, tabTriggerClass } from '../../../ui/tabStyles';
import { bundleFileName, type FileFindingCounts } from './exportBundle';
import { BundleFindingBadge } from './BundleFindingBadge';

/**
 * BundleFileTabs — the strip of recently-opened bundle files above the viewer (MFX-43.2, #4362).
 *
 * Opening a file from the tree adds a tab here; the active tab is the file in the viewer. Tabs keep
 * recent files one click away without re-hunting the tree, and each carries its own finding badge.
 * A tab can be closed; closing the active one is handled by the parent (it re-activates a neighbour).
 *
 * Accessibility (MFX-41.5): a real tablist — one Tab stop (roving `tabindex`), ←/→/Home/End walk
 * the open files, and Delete/Backspace closes the focused one. The ✕ is a pointer shortcut rather
 * than a button so the tablist owns nothing but tabs and a long strip never costs a Tab press per
 * file.
 */

export interface BundleFileTabsProps {
  /** The open file paths, most-recent first. */
  openPaths: string[];
  /** The active file's path. */
  activePath: string | null;
  /** Per-file finding counts (from {@link countFindingsByFile}). */
  countsByPath: Map<string, FileFindingCounts>;
  /** Activate a tab (bring its file into the viewer). */
  onActivate: (path: string) => void;
  /** Close a tab. */
  onClose: (path: string) => void;
}

/**
 * The recent-files tab strip. Renders nothing when no file is open (the viewer shows its own empty
 * state), so a single-file bundle never grows a lone redundant tab.
 *
 * @param props The open paths, active path, counts, and activate/close callbacks.
 * @returns The horizontally-scrollable tab strip, or null when empty.
 */
export function BundleFileTabs({
  openPaths,
  activePath,
  countsByPath,
  onActivate,
  onClose,
}: BundleFileTabsProps) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  // Roving tabindex + arrow keys, the WAI-ARIA tabs pattern (MFX-41.5): the strip is one Tab stop
  // and ←/→/Home/End walk the open files, so a long strip never costs a dozen Tab presses.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (openPaths.length === 0) return;
    const current = Math.max(
      openPaths.findIndex((path) => path === activePath),
      0,
    );
    // Delete/Backspace closes the focused tab — the keyboard equivalent of the ✕ affordance.
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onClose(openPaths[current]);
      return;
    }
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % openPaths.length;
        break;
      case 'ArrowLeft':
        next = (current - 1 + openPaths.length) % openPaths.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = openPaths.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const path = openPaths[next];
    onActivate(path);
    tabRefs.current.get(path)?.focus();
  };

  if (openPaths.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open bundle files"
      data-testid="bundle-file-tabs"
      onKeyDown={handleKeyDown}
      className={TAB_LIST_SCROLL_CLASS}
    >
      {openPaths.map((path) => {
        const active = path === activePath;
        const counts = countsByPath.get(path) ?? { errors: 0, warnings: 0 };
        return (
          // The wrapper only groups the tab with its close button — it is presentational, so the
          // tablist's owned children stay exactly the tabs ARIA requires.
          <div
            key={path}
            role="presentation"
            data-testid={`bundle-tab-${path}`}
            data-active={active}
            className={tabTriggerClass({ active, size: 'sm', className: 'group gap-1.5' })}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              ref={(node) => {
                if (node) tabRefs.current.set(path, node);
                else tabRefs.current.delete(path);
              }}
              data-testid={`bundle-tab-activate-${path}`}
              onClick={() => onActivate(path)}
              className="flex items-center gap-1.5"
              title={`${path} — press Delete to close`}
            >
              <span className="max-w-[12rem] truncate">{bundleFileName(path)}</span>
              <BundleFindingBadge counts={counts} testId={`bundle-tab-badge-${path}`} />
            </button>
            {/* The close affordance is a pointer shortcut, not a control: a focusable button here
                would be a non-tab child of the tablist (and a second Tab stop per open file). The
                keyboard equivalent is Delete/Backspace on the focused tab, which the tab's title
                states (MFX-41.5, mirroring the import tree's "no nested interactive" rule). */}
            <span
              role="presentation"
              data-testid={`bundle-tab-close-${path}`}
              onClick={() => onClose(path)}
              className="cursor-pointer rounded p-0.5 text-gray-400 opacity-60 hover:bg-gray-200 hover:text-gray-700 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            >
              <X className="h-3 w-3" aria-hidden />
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default BundleFileTabs;
