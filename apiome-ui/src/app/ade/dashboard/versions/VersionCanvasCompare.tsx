'use client';

/**
 * The compare dialog's **Canvas** tab — the two saved layouts, side by side or stacked.
 *
 * Re-skinned by HIVE-6.3 (#5314) to `docs/mockups/build/version-dialogs.html` §Compare →
 * Canvas. Behaviour is unchanged: the same split/overlay modes, the same synchronised
 * viewport, the same empty and loading copy.
 *
 * What changed is where the colour comes from. A node border used to be `'#10b981'` and the
 * legend swatch beside it `border-emerald-500` — two spellings of the same idea, neither of
 * which followed the reader's theme. Both now resolve through `changeStrokeVar` and
 * `VERSION_CHANGE_TONE` in `versionDialogsModel`, so the swatch and the node it explains are
 * the same token in all nine appearances. React Flow writes node and edge colour into an
 * inline `style` that no stylesheet can reach, which is why the model hands out `var(--ok)`
 * rather than a class: it is a token reference, so the theme swap still reaches it.
 *
 * The pane's heights are viewport-relative (`min(…vh, …rem)` in `.vdlg-canvas-pane`), not the
 * frozen `min-h-[min(320px,40vh)]` strings this carried, so the tab holds its proportion at
 * every font scale.
 */

import { useMemo, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { LayoutState, LayoutDiffSummary } from '../../../../../lib/layout-diff';
import { compareLayouts } from '../../../../../lib/layout-diff';
import {
  changeStrokeVar,
  VERSION_CANVAS_LEGEND,
  VERSION_CHANGE_TONE,
  VERSION_DIALOG_COPY,
  type VersionChangeClass,
} from '@/app/components/ade/version-dialogs/versionDialogsModel';

export type CanvasCompareViewMode = 'split' | 'overlay';

export interface VersionCanvasCompareProps {
  left: LayoutState | null;
  right: LayoutState | null;
  leftLabel: string;
  rightLabel: string;
  mode: CanvasCompareViewMode;
  /** When omitted, diff is derived from left/right (empty layout is treated as empty graph). */
  diff?: LayoutDiffSummary | null;
}

function safeArray<T>(arr: T[] | null | undefined): T[] {
  return Array.isArray(arr) ? arr : [];
}

function buildDiff(left: LayoutState | null, right: LayoutState | null): LayoutDiffSummary {
  const l = left ?? { nodes: [], edges: [] };
  const r = right ?? { nodes: [], edges: [] };
  return compareLayouts(l, r);
}

type DiffSets = {
  nodes: { added: Set<string>; removed: Set<string>; modified: Set<string> };
  edges: { added: Set<string>; removed: Set<string>; modified: Set<string> };
};

function buildDiffSets(diff: LayoutDiffSummary): DiffSets {
  return {
    nodes: {
      added: new Set(diff.nodes.added.map((e) => e.id)),
      removed: new Set(diff.nodes.removed.map((e) => e.id)),
      modified: new Set(diff.nodes.modified.map((e) => e.id)),
    },
    edges: {
      added: new Set(diff.edges.added.map((e) => e.id)),
      removed: new Set(diff.edges.removed.map((e) => e.id)),
      modified: new Set(diff.edges.modified.map((e) => e.id)),
    },
  };
}

function classifyNode(nodeId: string, side: 'left' | 'right', sets: DiffSets): VersionChangeClass {
  if (side === 'left') {
    if (sets.nodes.removed.has(nodeId)) return 'removed';
    if (sets.nodes.modified.has(nodeId)) return 'modified';
    return 'unchanged';
  }
  if (sets.nodes.added.has(nodeId)) return 'added';
  if (sets.nodes.modified.has(nodeId)) return 'modified';
  return 'unchanged';
}

function classifyEdge(edgeId: string, side: 'left' | 'right', sets: DiffSets): VersionChangeClass {
  if (side === 'left') {
    if (sets.edges.removed.has(edgeId)) return 'removed';
    if (sets.edges.modified.has(edgeId)) return 'modified';
    return 'unchanged';
  }
  if (sets.edges.added.has(edgeId)) return 'added';
  if (sets.edges.modified.has(edgeId)) return 'modified';
  return 'unchanged';
}

function toFlow(
  state: LayoutState | null,
  side: 'left' | 'right',
  sets: DiffSets
): { nodes: Node[]; edges: Edge[] } {
  if (!state) {
    return { nodes: [], edges: [] };
  }
  const nodes: Node[] = safeArray(state.nodes).map((n) => {
    const change = classifyNode(n.id, side, sets);
    const label =
      typeof n.data?.name === 'string'
        ? n.data.name
        : typeof (n.data as { label?: string } | undefined)?.label === 'string'
          ? (n.data as { label: string }).label
          : n.id;
    return {
      id: n.id,
      type: 'default',
      position: n.position ?? { x: 0, y: 0 },
      data: { label },
      style: {
        borderWidth: 2,
        borderColor: changeStrokeVar(change),
      },
    };
  });
  const edges: Edge[] = safeArray(state.edges).map((e) => {
    const change = classifyEdge(e.id, side, sets);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
      style: {
        stroke: changeStrokeVar(change),
        strokeWidth: change === 'unchanged' ? 1 : 2,
      },
    };
  });
  return { nodes, edges };
}

/** Rendered inside a ReactFlow instance to expose its setViewport for overlay synchronisation. */
function ViewportCapture({
  syncRef,
}: {
  syncRef: React.MutableRefObject<((vp: Viewport) => void) | null>;
}) {
  const { setViewport } = useReactFlow();
  useEffect(() => {
    syncRef.current = (vp: Viewport) => setViewport(vp, { duration: 0 });
    return () => {
      syncRef.current = null;
    };
  }, [setViewport, syncRef]);
  return null;
}

function FlowPane({
  state,
  side,
  diff,
  title,
  showTitle,
  interactive,
  viewportSyncRef,
  onMoveCallback,
}: {
  state: LayoutState | null;
  side: 'left' | 'right';
  diff: LayoutDiffSummary;
  title: string;
  showTitle: boolean;
  interactive: boolean;
  /** Underlay: expose this instance's setViewport for cross-instance sync. */
  viewportSyncRef?: React.MutableRefObject<((vp: Viewport) => void) | null>;
  /** Overlay: called on every pan/zoom so the underlay can mirror the viewport. */
  onMoveCallback?: (vp: Viewport) => void;
}) {
  const diffSets = useMemo(() => buildDiffSets(diff), [diff]);
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => toFlow(state, side, diffSets),
    [state, side, diffSets]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const empty =
    !state || (safeArray(state.nodes).length === 0 && safeArray(state.edges).length === 0);

  return (
    <div className="vdlg-canvas-pane">
      {showTitle && <div className="vdlg-canvas-pane__title">{title}</div>}
      {empty ? (
        <p className="vdlg-canvas-pane__empty">{VERSION_DIALOG_COPY.canvasEmpty}</p>
      ) : (
        <div className="vdlg-canvas-pane__flow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={interactive}
            zoomOnScroll={interactive}
            zoomOnPinch={interactive}
            zoomOnDoubleClick={interactive}
            preventScrolling={!interactive}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
            onMove={onMoveCallback ? (_, vp) => onMoveCallback(vp) : undefined}
            className="vdlg-flow"
          >
            {viewportSyncRef && <ViewportCapture syncRef={viewportSyncRef} />}
            <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
            <Controls showInteractive={interactive} />
          </ReactFlow>
        </div>
      )}
    </div>
  );
}

/**
 * The four-swatch legend.
 *
 * The swatch is a `data-tone` attribute, not a colour: `globals.css` paints
 * `.vdlg-legend__swatch[data-tone]` from the same token `changeStrokeVar` hands React Flow, so
 * the two can no longer disagree about what "added" looks like.
 */
function CanvasLegend() {
  return (
    <div className="vdlg-legend">
      <span className="vdlg-legend__title">Legend</span>
      {VERSION_CANVAS_LEGEND.map((entry) => (
        <span key={entry.change} className="vdlg-legend__item">
          <span
            className="vdlg-legend__swatch"
            data-tone={VERSION_CHANGE_TONE[entry.change]}
            aria-hidden
          />
          {entry.label}
        </span>
      ))}
    </div>
  );
}

export default function VersionCanvasCompare({
  left,
  right,
  leftLabel,
  rightLabel,
  mode,
  diff: diffProp,
}: VersionCanvasCompareProps) {
  const diff = useMemo(() => diffProp ?? buildDiff(left, right), [diffProp, left, right]);
  const underlaySetViewportRef = useRef<((vp: Viewport) => void) | null>(null);

  return (
    <div className="vdlg-canvas" data-mode={mode}>
      <CanvasLegend />
      <p className="vdlg-quiet">{VERSION_DIALOG_COPY.canvasNote}</p>
      {mode === 'split' ? (
        <div className="vdlg-canvas__split">
          <FlowPane state={left} side="left" diff={diff} title={leftLabel} showTitle interactive />
          <FlowPane
            state={right}
            side="right"
            diff={diff}
            title={rightLabel}
            showTitle
            interactive
          />
        </div>
      ) : (
        <>
          <div className="vdlg-canvas__overlay-key">
            <span>
              <span className="vdlg-canvas__overlay-side">Base</span> — {leftLabel}{' '}
              <span className="vdlg-quiet">(underlay, dimmed)</span>
            </span>
            <span>
              <span className="vdlg-canvas__overlay-side">Compare</span> — {rightLabel}{' '}
              <span className="vdlg-quiet">(on top, pan/zoom)</span>
            </span>
          </div>
          <div className="vdlg-canvas__stack">
            <div className="vdlg-canvas__layer vdlg-canvas__layer--under">
              <FlowPane
                state={left}
                side="left"
                diff={diff}
                title={leftLabel}
                showTitle={false}
                interactive={false}
                viewportSyncRef={underlaySetViewportRef}
              />
            </div>
            <div className="vdlg-canvas__layer vdlg-canvas__layer--over">
              <FlowPane
                state={right}
                side="right"
                diff={diff}
                title={rightLabel}
                showTitle={false}
                interactive
                onMoveCallback={(vp) => underlaySetViewportRef.current?.(vp)}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
