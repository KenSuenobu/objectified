'use client';

/**
 * The *Visualize* pane: component schemas and the `$ref` edges between them (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §File detail → Visualize, whose
 * page-local `<style>` block (`.flow-node`, `.flow-edge`, `.flow-text`, `.flow-sub`) this
 * replaces — every one of those rules is a token, and so is every rule below.
 *
 * What it replaces named colour outright in eleven places: `border-indigo-400`,
 * `bg-purple-50 dark:bg-purple-900/30`, `!bg-indigo-500` handles, and four literal hex values
 * (`#6366f1` twice for the edge and its arrowhead, `#4338ca` for the edge label, `#6366f1`
 * again for the minimap). A diagram that keeps an indigo edge on a Nord canvas is the one
 * place in the app where the theme visibly stops applying.
 *
 * React Flow takes colours as strings rather than classes for the edge, its label and the
 * minimap, so those are `var(--token)` expressions: a custom property resolves in an inline
 * style and in an SVG presentation attribute alike, and it is what lets a graph follow a theme
 * swap without re-rendering.
 */

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
import { Badge } from '@/app/components/ui/Badge';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { SVG_TEXT_SIZE } from '@/app/components/ui/svgTypography';

/** The ink every edge, arrowhead and minimap node takes — the theme's own quiet line colour. */
const FLOW_EDGE_INK = 'var(--fg-faint)';

/** The ink an edge's `$ref` label takes: readable against the surface it sits on. */
const FLOW_LABEL_INK = 'var(--fg-muted)';

/** What an edge label is drawn on, so the line behind it does not run through the text. */
const FLOW_LABEL_GROUND = 'var(--bg-surface)';

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
    <div className="repo-flow-node" data-composed={data.hasComposition ? 'true' : undefined}>
      <Handle type="target" position={Position.Top} className="repo-flow-node__handle" />
      <Handle type="target" position={Position.Left} className="repo-flow-node__handle" />

      <div className="repo-flow-node__head">
        {data.hasComposition && data.compositionType ? (
          <Badge variant="violet">{data.compositionType}</Badge>
        ) : null}
        <span className="repo-flow-node__name mono">{data.label}</span>
      </div>
      <p className="repo-flow-node__count">
        {data.propertyCount} {data.propertyCount === 1 ? 'property' : 'properties'}
      </p>

      <Handle type="source" position={Position.Right} className="repo-flow-node__handle" />
      <Handle type="source" position={Position.Bottom} className="repo-flow-node__handle" />
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
      labelStyle: { fill: FLOW_LABEL_INK, fontSize: SVG_TEXT_SIZE.label, fontWeight: 500 },
      labelBgStyle: { fill: FLOW_LABEL_GROUND, fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      style: { stroke: FLOW_EDGE_INK, strokeWidth: 1.25 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: FLOW_EDGE_INK,
        width: 15,
        height: 15,
      },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [document]);

  if (nodes.length === 0) {
    return (
      <EmptyState
        variant="compact"
        title="Nothing to plot"
        description="No components.schemas or definitions map was found in this document. OpenAPI and Swagger bundles with model schemas produce the relationship view."
      />
    );
  }

  return (
    <div className="repo-flow">
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
            nodeColor={() => FLOW_EDGE_INK}
            maskColor="color-mix(in srgb, var(--fg) 10%, transparent)"
            className="repo-flow__minimap"
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
