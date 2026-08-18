'use client';

/**
 * The class `$ref` graph for one revision (#322), re-skinned by HIVE-6.3 (#5314).
 *
 * Authority: `docs/mockups/build/version-dialogs.html` §History graph → *Relationship graph* —
 * a `max-w-4xl` dialog holding a TB auto-layout, with its two empty states and the "no
 * references" note pinned to the corner of the canvas.
 *
 * The note used to be a hand-built amber strip (`bg-amber-50 … border-amber-200/80 …
 * text-amber-800`); it is an `Alert` now, so it inherits the one warning treatment the app
 * has. The canvas surface reads `--bg-canvas` through `.vdlg-flow` instead of
 * `bg-gray-50 dark:bg-gray-900`, and its height is a viewport-relative token rather than the
 * frozen `420px` that pushed the dialog past 85vh at the Largest font scale.
 */

import React, { useMemo, useEffect } from 'react';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Dialog, DialogContent } from '../../../components/ui/Dialog';
import { Alert } from '../../../components/ui/Alert';
import { VersionDialogHead } from '../../../components/ade/versions';
import { buildRelationshipGraphData, type ClassWithProperties } from '@/app/utils/relationship-graph';
import { applyAutoLayout } from '@/app/utils/canvas-auto-layout';
import { Waypoints } from 'lucide-react';

const NODE_WIDTH = 140;
const NODE_HEIGHT = 40;

interface RelationshipGraphDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: { id: string; version_id: string } | null;
  projectName: string;
  /** Classes with properties for the selected version; loaded when user opens the graph */
  classesWithProperties: ClassWithProperties[] | null;
  isLoading?: boolean;
}

export default function RelationshipGraphDialog({
  open,
  onOpenChange,
  version,
  projectName,
  classesWithProperties,
  isLoading = false,
}: RelationshipGraphDialogProps) {
  const graphData = useMemo(
    () => (classesWithProperties?.length ? buildRelationshipGraphData(classesWithProperties) : { nodes: [], edges: [] }),
    [classesWithProperties]
  );

  const { initialNodes, initialEdges } = useMemo(() => {
    if (graphData.nodes.length === 0) {
      return { initialNodes: [], initialEdges: [] };
    }
    const rfNodes: Node[] = graphData.nodes.map((n) => ({
      id: n.id,
      type: 'default',
      position: { x: 0, y: 0 },
      data: { label: n.name },
      measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }));
    const rfEdges: Edge[] = graphData.edges.map((e, i) => ({
      id: `e-${i}-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
    }));
    const laidOut = applyAutoLayout(rfNodes, rfEdges, {
      direction: 'TB',
      nodeSpacingX: 60,
      nodeSpacingY: 80,
      padding: 40,
      minimizeCrossings: true,
    });
    return { initialNodes: laidOut, initialEdges: rfEdges };
  }, [graphData]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const empty = !classesWithProperties?.length || graphData.nodes.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="vdlg-dialog vdlg-dialog--lg vdlg-relgraph" aria-describedby={undefined}>
        <VersionDialogHead
          icon={<Waypoints aria-hidden />}
          tone="accent"
          title="Relationship graph"
          description={
            version
              ? `${projectName} — v${version.version_id} · class $ref graph for one revision`
              : undefined
          }
        />
        <div className="vdlg-relgraph__frame">
          {isLoading ? (
            <p className="vdlg-relgraph__state">Loading schema…</p>
          ) : empty ? (
            <div className="vdlg-relgraph__state">
              <p className="vdlg-relgraph__state-title">
                {classesWithProperties === null
                  ? 'No schema data loaded.'
                  : 'This version has no classes yet.'}
              </p>
              <p className="vdlg-quiet">
                Add classes in the Studio and use reference properties ($ref) to other classes to see a relationship graph here.
              </p>
            </div>
          ) : (
            <div className="vdlg-relgraph__body">
              {graphData.edges.length === 0 && graphData.nodes.length > 0 && (
                <Alert variant="warn" className="vdlg-relgraph__note">
                  This version has {graphData.nodes.length} class{graphData.nodes.length !== 1 ? 'es' : ''} but no references ($ref) between them. Add reference properties in the Studio to see relationships here.
                </Alert>
              )}
              <div className="vdlg-relgraph__stage">
              <ReactFlow
                key={version?.id ?? 'graph'}
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={true}
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                className="vdlg-flow"
              >
                <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
                <Controls />
                <MiniMap />
              </ReactFlow>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
