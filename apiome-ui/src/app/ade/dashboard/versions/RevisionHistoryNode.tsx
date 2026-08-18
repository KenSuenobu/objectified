'use client';

/**
 * Revision history DAG node — polished rendering for the `revisionHistory` xyflow node type.
 *
 * Responsibilities (#745):
 *   - Lane-colored commit dot that matches the branch legend.
 *   - Tag pills (immutable tags get a lock icon).
 *   - Richer hover tooltip (branches, tags, full message, author, parents, time).
 *   - Unified action menu exposed both via the "Actions" button and right-click (context menu).
 *
 * The node stays pure/presentational — all side-effects come in through `data.*` callbacks.
 *
 * Re-skinned by HIVE-6.3 (#5314) to `docs/mockups/build/version-dialogs.html` §History graph.
 * The merge border was `'#8b5cf6'`, the tip marker `'#10b981'` and the tip tint
 * `'rgba(16, 185, 129, 0.10)'` — three hues no theme could reach, beside a lane dot spelled as
 * a fifth. All of them are tokens now: `var(--violet)` / `var(--ok)` and a `color-mix` on the
 * same token, and the dot, the tip stripe and the tag pill take a `data-tone` the stylesheet
 * paints. The one thing still in `px` is the node's own geometry, which is graph coordinates
 * and exempt for the reason `canvas-theme.ts` documents.
 */

import React, { useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { NodeCard } from '../../../components/ade/canvas/NodeCard';
import { CANVAS_TOKENS } from '../../../components/ade/canvas/canvas-theme';
import {
  ChevronDown,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  Lock,
  MoreHorizontal,
  RefreshCw,
  Tag as TagIcon,
  Eye,
} from 'lucide-react';
import type { RevisionNodeData } from './version-history-dag';

function buildHoverTitle(data: RevisionNodeData): string {
  const parts: string[] = [];
  parts.push(`v${data.versionString}`);
  if (data.isMerge) parts.push('Merge commit (two parents)');
  if (data.isBranchTip && data.branchNamesForTip.length > 0) {
    parts.push(`Tip of: ${data.branchNamesForTip.join(', ')}`);
  }
  if (data.tags.length > 0) {
    parts.push(`Tags: ${data.tags.map((t) => t.name).join(', ')}`);
  }
  if (data.authorName) parts.push(`By ${data.authorName}`);
  if (data.createdAt) parts.push(data.createdAt);
  if (data.externalRef) parts.push(`Ref: ${data.externalRef}`);
  if (data.fullMessage) {
    parts.push('');
    parts.push(data.fullMessage);
  } else if (data.shortMessage) {
    parts.push('');
    parts.push(data.shortMessage);
  }
  return parts.join('\n');
}

type ActionMenuProps = {
  data: RevisionNodeData;
  nodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function ActionMenu({ data, nodeId, open, onOpenChange }: ActionMenuProps) {
  const items: Array<{ label: string; icon: React.ReactNode; onSelect: () => void } | 'separator'> = [];
  if (data.onCheckoutRevision) {
    items.push({
      label: 'Switch to this revision',
      icon: <RefreshCw aria-hidden />,
      onSelect: () => data.onCheckoutRevision?.(nodeId),
    });
    items.push('separator');
  }
  if (data.onCompareToPrimaryParent && data.primaryParentId) {
    items.push({
      label: 'Compare with primary parent',
      icon: <GitCompareArrows aria-hidden />,
      onSelect: () => data.onCompareToPrimaryParent?.(nodeId),
    });
  }
  if (data.onViewSpec) {
    items.push({
      label: 'View spec',
      icon: <Eye aria-hidden />,
      onSelect: () => data.onViewSpec?.(nodeId),
    });
  }
  if (data.onBranchFromRevision) {
    items.push({
      label: 'Branch from here…',
      icon: <GitBranch aria-hidden />,
      onSelect: () => data.onBranchFromRevision?.(nodeId),
    });
  }

  if (items.length === 0) return null;

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="vdlg-node__menu-trigger"
          title="Revision actions"
          aria-label="Revision actions"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-3 w-3 opacity-80" aria-hidden />
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="tnt-menu vdlg-node__menu"
          sideOffset={4}
          align="end"
          onPointerDownOutside={(e) => e.stopPropagation()}
        >
          {items.map((it, i) =>
            it === 'separator' ? (
              <DropdownMenu.Separator key={`sep-${i}`} className="vdlg-node__menu-sep" />
            ) : (
              <DropdownMenu.Item
                key={it.label}
                className="tnt-menu__item"
                onSelect={(e) => {
                  e.preventDefault();
                  it.onSelect();
                }}
              >
                {it.icon}
                <span>{it.label}</span>
              </DropdownMenu.Item>
            )
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default function RevisionHistoryNode({ id, data, selected }: NodeProps<Node<RevisionNodeData>>) {
  const {
    isMerge,
    isBranchTip,
    branchNamesForTip,
    tipTone,
    layoutDirection,
    laneTone,
    tags,
    relativeTime,
    authorName,
  } = data;
  const horizontal = layoutDirection === 'LR';
  const [menuOpen, setMenuOpen] = useState(false);

  // React Flow writes these into an inline `style`, which no stylesheet can reach — so they
  // are token *references* rather than classes. `--violet` and `--ok` follow the theme swap.
  const customBorderColor = isMerge ? 'var(--violet)' : isBranchTip ? 'var(--ok)' : undefined;
  const borderWidth = isMerge ? 2 : 1;
  const customBackground = isMerge
    ? 'color-mix(in srgb, var(--violet) 8%, var(--node-surface))'
    : undefined;
  const heatmapTint =
    !selected && isBranchTip && !isMerge
      ? 'color-mix(in srgb, var(--ok) 10%, transparent)'
      : undefined;
  const warning = !selected && isBranchTip && isMerge;

  const hoverTitle = buildHoverTitle(data);

  return (
    <NodeCard
      role="revision"
      selected={selected}
      title={hoverTitle}
      minWidth={184}
      maxWidth={240}
      customBorderColor={customBorderColor}
      borderWidth={borderWidth}
      customBackground={customBackground}
      heatmapTint={heatmapTint}
      warning={warning}
      style={{ padding: `${CANVAS_TOKENS.nodePadY}px ${CANVAS_TOKENS.nodePadX}px` }}
    >
      {horizontal ? (
        <>
          <Handle type="target" position={Position.Left} className="opacity-0" />
          <Handle type="source" position={Position.Right} className="opacity-0" />
        </>
      ) : (
        <>
          <Handle type="target" position={Position.Top} className="opacity-0" />
          <Handle type="source" position={Position.Bottom} className="opacity-0" />
        </>
      )}
      {isBranchTip && tipTone ? (
        <span aria-hidden className="vdlg-node__tip" data-tone={tipTone} />
      ) : null}
      <div className="vdlg-node__body">
        <div className="vdlg-node__rail" aria-hidden>
          <span
            className="vdlg-node__dot"
            data-tone={laneTone}
            title={isMerge ? 'Merge commit' : 'Revision'}
          />
          {isMerge ? <GitMerge className="vdlg-node__glyph" data-tone="violet" /> : null}
          {isBranchTip ? <GitBranch className="vdlg-node__glyph" data-tone="ok" /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1">
            <div className="vdlg-node__version" title={`v${data.versionString}`}>
              v{data.versionString}
            </div>
            <ActionMenu data={data} nodeId={id} open={menuOpen} onOpenChange={setMenuOpen} />
          </div>
          {isMerge ? (
            <div className="vdlg-node__merge">Merge commit</div>
          ) : null}
          {isBranchTip && branchNamesForTip.length > 0 ? (
            <div className="vdlg-node__tip-label" data-tone={laneTone} title={branchNamesForTip.join(', ')}>
              Tip: {branchNamesForTip.join(', ')}
            </div>
          ) : null}
          {tags.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {tags.slice(0, 3).map((t) => (
                <span
                  key={t.id}
                  className="vdlg-node__tag"
                  title={t.immutable ? `${t.name} (immutable)` : t.name}
                >
                  {t.immutable ? <Lock aria-hidden /> : <TagIcon aria-hidden />}
                  <span className="vdlg-node__tag-name">{t.name}</span>
                </span>
              ))}
              {tags.length > 3 ? (
                <span className="vdlg-node__meta">+{tags.length - 3}</span>
              ) : null}
            </div>
          ) : null}
          {data.shortMessage ? (
            <div className="vdlg-node__message" title={data.shortMessage}>
              {data.shortMessage}
            </div>
          ) : null}
          {(authorName || relativeTime) && (
            <div className="vdlg-node__meta">
              {authorName ? <span className="truncate">{authorName}</span> : null}
              {authorName && relativeTime ? <span aria-hidden>·</span> : null}
              {relativeTime ? <span>{relativeTime}</span> : null}
            </div>
          )}
        </div>
      </div>
    </NodeCard>
  );
}
