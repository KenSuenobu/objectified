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
 */

import React, { useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { NodeCard } from '../../../components/ade/canvas/NodeCard';
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
      icon: <RefreshCw className="h-3.5 w-3.5" aria-hidden />,
      onSelect: () => data.onCheckoutRevision?.(nodeId),
    });
    items.push('separator');
  }
  if (data.onCompareToPrimaryParent && data.primaryParentId) {
    items.push({
      label: 'Compare with primary parent',
      icon: <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />,
      onSelect: () => data.onCompareToPrimaryParent?.(nodeId),
    });
  }
  if (data.onViewSpec) {
    items.push({
      label: 'View spec',
      icon: <Eye className="h-3.5 w-3.5" aria-hidden />,
      onSelect: () => data.onViewSpec?.(nodeId),
    });
  }
  if (data.onBranchFromRevision) {
    items.push({
      label: 'Branch from here…',
      icon: <GitBranch className="h-3.5 w-3.5" aria-hidden />,
      onSelect: () => data.onBranchFromRevision?.(nodeId),
    });
  }

  if (items.length === 0) return null;

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="shrink-0 inline-flex items-center gap-0.5 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-2xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
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
          className="z-[100] min-w-[12rem] rounded-md border border-gray-200 bg-white p-1 text-sm shadow-md dark:border-gray-600 dark:bg-gray-900"
          sideOffset={4}
          align="end"
          onPointerDownOutside={(e) => e.stopPropagation()}
        >
          {items.map((it, i) =>
            it === 'separator' ? (
              <DropdownMenu.Separator key={`sep-${i}`} className="my-1 h-px bg-gray-200 dark:bg-gray-700" />
            ) : (
              <DropdownMenu.Item
                key={it.label}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-gray-100 focus:bg-gray-100 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
                onSelect={(e) => {
                  e.preventDefault();
                  it.onSelect();
                }}
              >
                <span className="text-gray-500 dark:text-gray-400">{it.icon}</span>
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
    tipAccentClass,
    layoutDirection,
    laneColor,
    tags,
    relativeTime,
    authorName,
  } = data;
  const horizontal = layoutDirection === 'LR';
  const [menuOpen, setMenuOpen] = useState(false);

  const customBorderColor = isMerge
    ? '#8b5cf6'
    : isBranchTip
    ? '#10b981'
    : undefined;
  const borderWidth = isMerge ? 2 : 1;
  const customBackground = isMerge
    ? 'color-mix(in srgb, #8b5cf6 8%, var(--node-surface))'
    : undefined;
  const heatmapTint = !selected && isBranchTip && !isMerge ? 'rgba(16, 185, 129, 0.10)' : undefined;
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
      style={{ padding: '8px 12px' }}
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
      {isBranchTip && tipAccentClass ? (
        <span
          aria-hidden
          className={tipAccentClass}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '4px',
            borderTopLeftRadius: '8px',
            borderBottomLeftRadius: '8px',
          }}
        />
      ) : null}
      <div className="flex items-start gap-2">
        <div className="flex flex-col items-center gap-1 shrink-0 mt-1" aria-hidden>
          <span
            className={`block h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-gray-900 ${laneColor.dot}`}
            title={isMerge ? 'Merge commit' : 'Revision'}
          />
          {isMerge ? <GitMerge className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" /> : null}
          {isBranchTip ? <GitBranch className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1">
            <div
              className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-50 truncate min-w-0"
              title={`v${data.versionString}`}
            >
              v{data.versionString}
            </div>
            <ActionMenu data={data} nodeId={id} open={menuOpen} onOpenChange={setMenuOpen} />
          </div>
          {isMerge ? (
            <div className="text-2xs uppercase tracking-wide text-violet-800 dark:text-violet-200 font-semibold mt-0.5">
              Merge commit
            </div>
          ) : null}
          {isBranchTip && branchNamesForTip.length > 0 ? (
            <div
              className={`text-2xs font-medium mt-0.5 truncate ${laneColor.text}`}
              title={branchNamesForTip.join(', ')}
            >
              Tip: {branchNamesForTip.join(', ')}
            </div>
          ) : null}
          {tags.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {tags.slice(0, 3).map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-2xs font-medium text-amber-900 dark:border-amber-600/60 dark:bg-amber-950/40 dark:text-amber-200"
                  title={t.immutable ? `${t.name} (immutable)` : t.name}
                >
                  {t.immutable ? (
                    <Lock className="h-2.5 w-2.5" aria-hidden />
                  ) : (
                    <TagIcon className="h-2.5 w-2.5" aria-hidden />
                  )}
                  <span className="truncate max-w-[6rem]">{t.name}</span>
                </span>
              ))}
              {tags.length > 3 ? (
                <span className="text-2xs text-gray-500 dark:text-gray-400">+{tags.length - 3}</span>
              ) : null}
            </div>
          ) : null}
          {data.shortMessage ? (
            <div className="text-xs text-gray-600 dark:text-gray-400 truncate mt-0.5" title={data.shortMessage}>
              {data.shortMessage}
            </div>
          ) : null}
          {(authorName || relativeTime) && (
            <div className="mt-0.5 flex items-center gap-1 text-2xs text-gray-500 dark:text-gray-400 truncate">
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
