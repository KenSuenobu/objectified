'use client';

import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { buildRelationshipDiagramEdges } from '@/app/utils/schema-tree-utils';
import { SVG_TEXT_SIZE } from '@/app/components/ui/svgTypography';

function countSchemaProperties(schema: unknown): number {
  if (!schema || typeof schema !== 'object') return 0;
  const s = schema as Record<string, unknown>;
  let count = 0;
  if (s.properties && typeof s.properties === 'object') {
    count += Object.keys(s.properties as object).length;
  }
  if (Array.isArray(s.allOf)) {
    for (const item of s.allOf) {
      if (item && typeof item === 'object' && (item as Record<string, unknown>).properties) {
        count += Object.keys(((item as Record<string, unknown>).properties as object) ?? {}).length;
      }
    }
  }
  if (Array.isArray(s.oneOf)) {
    let maxOneOf = 0;
    for (const item of s.oneOf) {
      if (item && typeof item === 'object' && (item as Record<string, unknown>).properties) {
        maxOneOf = Math.max(
          maxOneOf,
          Object.keys(((item as Record<string, unknown>).properties as object) ?? {}).length
        );
      }
    }
    count += maxOneOf;
  }
  if (Array.isArray(s.anyOf)) {
    let maxAnyOf = 0;
    for (const item of s.anyOf) {
      if (item && typeof item === 'object' && (item as Record<string, unknown>).properties) {
        maxAnyOf = Math.max(
          maxAnyOf,
          Object.keys(((item as Record<string, unknown>).properties as object) ?? {}).length
        );
      }
    }
    count += maxAnyOf;
  }
  return count;
}

function getCompositionType(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as Record<string, unknown>;
  if (s.allOf) return 'allOf';
  if (s.oneOf) return 'oneOf';
  if (s.anyOf) return 'anyOf';
  return null;
}

function PreviewClassNode({
  data,
}: {
  data: {
    label: string;
    propertyCount: number;
    selected: boolean;
    hasComposition?: boolean;
    compositionType?: string;
  };
}) {
  return (
    <div
      className={`min-w-[120px] max-w-[180px] rounded-lg border-2 bg-white shadow-md dark:bg-gray-800 ${
        data.selected
          ? 'border-indigo-400 dark:border-indigo-500'
          : 'border-gray-300 opacity-50 dark:border-gray-600'
      }`}
    >
      <Handle type="target" position={Position.Top} className="h-2 w-2 !bg-indigo-500" />
      <Handle type="target" position={Position.Left} className="h-2 w-2 !bg-indigo-500" />

      <div
        className={`rounded-t-lg border-b border-gray-200 px-3 py-2 dark:border-gray-600 ${
          data.hasComposition ? 'bg-purple-50 dark:bg-purple-900/30' : 'bg-indigo-50 dark:bg-indigo-900/30'
        }`}
      >
        <div className="flex items-center gap-1.5">
          {data.hasComposition && data.compositionType ? (
            <span className="rounded bg-purple-200 px-1 py-0.5 text-2xs text-purple-700 dark:bg-purple-800 dark:text-purple-300">
              {data.compositionType}
            </span>
          ) : null}
          <span className="truncate text-xs font-semibold text-gray-800 dark:text-gray-200">{data.label}</span>
        </div>
      </div>
      <div className="px-3 py-2">
        <div className="text-2xs text-gray-500 dark:text-gray-400">
          {data.propertyCount} {data.propertyCount === 1 ? 'property' : 'properties'}
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="h-2 w-2 !bg-indigo-500" />
      <Handle type="source" position={Position.Bottom} className="h-2 w-2 !bg-indigo-500" />
    </div>
  );
}

const previewNodeTypes = {
  previewClass: PreviewClassNode,
};

function getSchemaMap(document: unknown): Record<string, unknown> | null {
  if (!document || typeof document !== 'object') return null;
  const d = document as Record<string, unknown>;
  const comps = d.components;
  if (comps && typeof comps === 'object') {
    const schemas = (comps as Record<string, unknown>).schemas;
    if (schemas && typeof schemas === 'object' && !Array.isArray(schemas)) {
      return schemas as Record<string, unknown>;
    }
  }
  const def = d.definitions;
  if (def && typeof def === 'object' && !Array.isArray(def)) {
    return def as Record<string, unknown>;
  }
  return null;
}

/**
 * Read-only React Flow relationship diagram for a parsed OpenAPI-style `document`
 * (same layout approach as the import preview “Relationship diagram”).
 */
export function RepositoryFileSpecRelationshipFlow({ document }: { document: unknown }) {
  const { nodes, edges } = useMemo(() => {
    const schemaObj = getSchemaMap(document);
    if (!schemaObj) return { nodes: [] as Node[], edges: [] as Edge[] };

    const schemaNames = Object.keys(schemaObj).sort((a, b) => a.localeCompare(b));
    if (schemaNames.length === 0) return { nodes: [] as Node[], edges: [] as Edge[] };

    const cols = Math.ceil(Math.sqrt(schemaNames.length));
    const nodeWidth = 160;
    const nodeHeight = 80;
    const gapX = 80;
    const gapY = 60;

    const flowNodes: Node[] = schemaNames.map((name, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const schema = schemaObj[name];
      const compositionType = getCompositionType(schema);
      return {
        id: name,
        type: 'previewClass',
        position: {
          x: col * (nodeWidth + gapX) + 50,
          y: row * (nodeHeight + gapY) + 50,
        },
        data: {
          label: name,
          propertyCount: countSchemaProperties(schema),
          selected: true,
          hasComposition: !!compositionType,
          compositionType: compositionType ?? undefined,
        },
      };
    });

    const diagramEdges = buildRelationshipDiagramEdges(schemaObj, schemaNames);
    const flowEdges: Edge[] = diagramEdges.map(({ source, target, label }, i) => ({
      id: `${source}-${target}-${i}`,
      source,
      target,
      type: 'smoothstep',
      animated: false,
      label,
      labelStyle: { fill: '#4338ca', fontSize: SVG_TEXT_SIZE.label, fontWeight: 500 },
      labelBgStyle: { fill: 'white', fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      style: { stroke: '#6366f1', strokeWidth: 1.5 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: '#6366f1',
        width: 15,
        height: 15,
      },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [document]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-[min(520px,70vh)] min-h-[240px] items-center justify-center px-4 text-center text-sm leading-relaxed text-gray-500 dark:text-gray-400">
        No <span className="mx-1 font-mono">components.schemas</span> or{' '}
        <span className="mx-1 font-mono">definitions</span> map found in this document, so there is nothing to plot.
        OpenAPI and Swagger bundles with model schemas produce the relationship view.
      </div>
    );
  }

  return (
    <div className="h-[min(520px,70vh)] min-h-[320px] w-full">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={previewNodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={() => '#6366f1'}
            maskColor="rgba(0, 0, 0, 0.1)"
            className="bg-gray-100 dark:bg-gray-700"
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
