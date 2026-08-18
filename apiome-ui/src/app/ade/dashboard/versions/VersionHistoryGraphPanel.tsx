'use client';

/**
 * The revision history graph (#743–#745), re-skinned by HIVE-6.3 (#5314).
 *
 * Authority: `docs/mockups/build/version-dialogs.html` §History graph — the help copy, the
 * *Load older* control, the max-limit note, the lane chip strip with *Select all*, the canvas
 * with its Fit all / HEAD / Selected controls, and the two empty states.
 *
 * Behaviour is unchanged. What moved is the paint: the panel frame was
 * `bg-white dark:bg-gray-800 rounded-2xl … border-gray-100`, the lane chip switched between
 * eight Tailwind palette pairs, the max-limit note was `text-amber-600`, and the React Flow
 * surface itself was `bg-slate-50 dark:bg-gray-950` with a `rgba(0,0,0,0.12)` minimap mask.
 * All of it is tokens now: the frame is `.vdlg-panel`, a lane chip takes the `data-tone`
 * `laneToneForBranchIndex` hands it — the same tone the node's dot and the tip stripe take —
 * and the graph surface reads `--bg-canvas` through `.vdlg-flow`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Crosshair, Locate } from 'lucide-react';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { VERSION_DIALOG_COPY } from '../../../components/ade/version-dialogs/versionDialogsModel';
import RevisionHistoryNode from './RevisionHistoryNode';
import {
  buildLayoutedHistoryGraph,
  HISTORY_WINDOW_STEP,
  MAX_HISTORY_GRAPH_NODES,
  expandVersionsForWindow,
  filterVersionsBySelectedBranches,
  laneToneForBranchIndex,
  type RevisionNodeData,
  type VersionHistoryBranchMeta,
  type VersionHistoryTag,
  type VersionHistoryVertex,
} from './version-history-dag';

const nodeTypes = { revisionHistory: RevisionHistoryNode };

/**
 * The minimap's mask.
 *
 * React Flow paints the mask through an SVG `fill` attribute rather than a class, so it has to
 * be a value; `--overlay` is the token the design language already spends on "the page behind
 * this is dimmed", and it is the one colour on the graph that has to work over *both* the
 * canvas and the nodes floating on it.
 */
const DAG_MINIMAP_MASK = 'var(--overlay)';

export type VersionHistoryGraphPanelProps = {
  /** Filtered list (e.g. lifecycle + tag) — same as versions table */
  versions: VersionHistoryVertex[];
  /** Named branches for tips, lane labels, and optional subgraph filter (#744) */
  branches?: VersionHistoryBranchMeta[];
  /** Tags pinned to specific revisions, rendered as pills on the commit nodes. */
  tags?: VersionHistoryTag[];
  windowSize: number;
  onWindowSizeIncrease: (nextSize: number) => void;
  /** Primary parent → this revision (OpenAPI compare) */
  onCompareToPrimaryParent: (revisionId: string) => void;
  /** Open read-only spec for this revision */
  onViewSpec: (revisionId: string) => void;
  /** Create a named branch from this revision (#2571) */
  onBranchFromRevision?: (revisionId: string) => void;
  /** Canvas-only: switch the editor to this revision. When omitted the menu item is hidden. */
  onCheckoutRevision?: (revisionId: string) => void;
  /** Current HEAD revision id — powers the "Center on HEAD" button. */
  headRevisionId?: string | null;
  /** Currently selected revision (canvas pinned / table row) — powers "Center on selected". */
  selectedRevisionId?: string | null;
};

type GraphCanvasProps = {
  nodes: Node<RevisionNodeData>[];
  edges: Edge[];
  keyValue: string;
  onNodesChange: OnNodesChange<Node<RevisionNodeData>>;
  onEdgesChange: OnEdgesChange<Edge>;
  onNodeClick: (e: React.MouseEvent, node: Node) => void;
  headRevisionId?: string | null;
  selectedRevisionId?: string | null;
};

function GraphCanvas({
  nodes,
  edges,
  keyValue,
  onNodesChange,
  onEdgesChange,
  onNodeClick,
  headRevisionId,
  selectedRevisionId,
}: GraphCanvasProps) {
  const { setCenter, getNode, fitView } = useReactFlow();

  const centerOn = useCallback(
    (id: string | null | undefined) => {
      if (!id) return;
      const n = getNode(id);
      if (!n) return;
      const width = n.width ?? 200;
      const height = n.height ?? 52;
      setCenter(n.position.x + width / 2, n.position.y + height / 2, { zoom: 1.2, duration: 400 });
    },
    [getNode, setCenter]
  );

  return (
    <>
      <div className="vdlg-dag__controls">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          title="Fit all revisions in view"
          onClick={() => fitView({ padding: 0.2, maxZoom: 1.35, duration: 400 })}
        >
          <Crosshair aria-hidden />
          Fit all
        </Button>
        {headRevisionId ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            title="Center on current HEAD revision"
            onClick={() => centerOn(headRevisionId)}
          >
            <Locate aria-hidden />
            HEAD
          </Button>
        ) : null}
        {selectedRevisionId && selectedRevisionId !== headRevisionId ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            title="Center on selected revision"
            onClick={() => centerOn(selectedRevisionId)}
          >
            <Locate aria-hidden />
            Selected
          </Button>
        ) : null}
      </div>
      <ReactFlow
        key={keyValue}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.35 }}
        minZoom={0.15}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
        className="vdlg-flow"
      >
        <Background variant={BackgroundVariant.Dots} gap={14} size={1} />
        <Controls />
        <MiniMap className="vdlg-dag__minimap" maskColor={DAG_MINIMAP_MASK} nodeStrokeWidth={2} />
      </ReactFlow>
    </>
  );
}

export default function VersionHistoryGraphPanel({
  versions,
  branches = [],
  tags = [],
  windowSize,
  onWindowSizeIncrease,
  onCompareToPrimaryParent,
  onViewSpec,
  onBranchFromRevision,
  onCheckoutRevision,
  headRevisionId,
  selectedRevisionId,
}: VersionHistoryGraphPanelProps) {
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>(() => branches.map((b) => b.id));

  const branchFiltered = useMemo(
    () => filterVersionsBySelectedBranches(versions, branches, selectedBranchIds),
    [versions, branches, selectedBranchIds]
  );

  const expanded = useMemo(() => expandVersionsForWindow(branchFiltered, windowSize), [branchFiltered, windowSize]);

  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(
    () =>
      buildLayoutedHistoryGraph(expanded, {
        branches,
        tags,
        onBranchFromRevision,
        onCheckoutRevision,
        onViewSpec,
        onCompareToPrimaryParent,
      }),
    [expanded, branches, tags, onBranchFromRevision, onCheckoutRevision, onViewSpec, onCompareToPrimaryParent]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges);

  useEffect(() => {
    setNodes(layoutNodes);
    setEdges(layoutEdges);
  }, [layoutNodes, layoutEdges, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const e = _ as React.MouseEvent & { metaKey?: boolean; ctrlKey?: boolean };
      if (e.metaKey || e.ctrlKey) {
        onViewSpec(node.id);
        return;
      }
      onCompareToPrimaryParent(node.id);
    },
    [onCompareToPrimaryParent, onViewSpec]
  );

  const atMaxNodes = expanded.length >= MAX_HISTORY_GRAPH_NODES;
  const canLoadMore = windowSize < branchFiltered.length && !atMaxNodes;
  const selectionBlocksGraph = branches.length > 0 && selectedBranchIds.length === 0;

  const toggleBranch = useCallback((id: string) => {
    setSelectedBranchIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const selectAllBranches = useCallback(() => {
    setSelectedBranchIds(branches.map((b) => b.id));
  }, [branches]);

  if (versions.length === 0) {
    return null;
  }

  return (
    <div className="vdlg-panel vdlg-dag">
      <div className="vdlg-dag__head">
        <div>
          <h3 className="vdlg-section-title">Revision history graph</h3>
          <p className="vdlg-quiet">
            Left-to-right lanes (older → newer). Solid slate edge = primary parent; dashed violet = merge parent. Click a
            node to compare with its primary parent; Ctrl/Cmd-click to view spec. Merge commits use violet styling; branch
            tips show names and an emerald marker.
          </p>
        </div>
        <div className="vdlg-dag__head-actions">
          {canLoadMore ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onWindowSizeIncrease(windowSize + HISTORY_WINDOW_STEP)}
            >
              Load older ({windowSize} → {windowSize + HISTORY_WINDOW_STEP})
            </Button>
          ) : null}
          {atMaxNodes && (
            <Badge variant="warn">Max render limit reached ({MAX_HISTORY_GRAPH_NODES} nodes)</Badge>
          )}
          <span className="vdlg-quiet">
            Showing {expanded.length} revision{expanded.length !== 1 ? 's' : ''}
            {expanded.length < branchFiltered.length ? ` (of ${branchFiltered.length} in branch filter)` : ''}
            {branchFiltered.length < versions.length ? ` — ${versions.length} total in table filter` : ''}
          </span>
        </div>
      </div>

      {branches.length > 0 ? (
        <div className="vdlg-dag__lanes">
          <span className="vdlg-caps">Lanes</span>
          <div className="vdlg-chips" role="group" aria-label="Filter graph by named branch">
            {branches.map((b, idx) => {
              const on = selectedBranchIds.includes(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={on}
                  title={on ? `Hide history for ${b.name}` : `Show history for ${b.name}`}
                  onClick={() => toggleBranch(b.id)}
                  className="vdlg-chip"
                  data-tone={laneToneForBranchIndex(idx)}
                >
                  <span className="vdlg-chip__dot" aria-hidden />
                  {b.name}
                </button>
              );
            })}
          </div>
          {selectedBranchIds.length < branches.length ? (
            <button type="button" onClick={selectAllBranches} className="vdlg-link">
              Select all
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="vdlg-dag__stage">
        {selectionBlocksGraph ? (
          <p className="vdlg-dag__empty">{VERSION_DIALOG_COPY.historyNoLanes}</p>
        ) : layoutNodes.length === 0 ? (
          <p className="vdlg-dag__empty">{VERSION_DIALOG_COPY.historyEmpty}</p>
        ) : (
          <ReactFlowProvider>
            <GraphCanvas
              nodes={nodes}
              edges={edges}
              keyValue={`${expanded.map((v) => v.id).join('|')}-${windowSize}-${[...selectedBranchIds].sort().join(',')}`}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              headRevisionId={headRevisionId}
              selectedRevisionId={selectedRevisionId}
            />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}

export { HISTORY_WINDOW_STEP };
