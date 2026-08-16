/**
 * Build React Flow nodes and edges from persisted class rows for schema metrics (#323).
 * Mirrors the studio editor’s dependency graph (property $refs + schema allOf/anyOf/oneOf)
 * for use by {@link computeSchemaMetrics}; output may include visual styling metadata.
 */

import type { Edge, Node } from '@xyflow/react';
import { SVG_TEXT_SIZE } from '@/app/components/ui/svgTypography';

function extractClassNameFromRef(ref: string): string | null {
  if (ref.includes('/')) {
    const parts = ref.split('/');
    return parts[parts.length - 1] || null;
  }
  return ref;
}

const METRIC_EDGE_TYPE = 'default';

function createPropertyRefEdgesForMetrics(classes: any[]): Edge[] {
  const edges: Edge[] = [];
  const classNameToId = new Map(classes.map((cls) => [cls.name, cls.id]));

  classes.forEach((cls) => {
    if (!cls.properties || cls.properties.length === 0) return;

    cls.properties.forEach((prop: any) => {
      const propData = typeof prop.data === 'string' ? JSON.parse(prop.data) : prop.data;
      let sourceBaseType = propData.type;
      if (Array.isArray(propData.type)) {
        sourceBaseType = propData.type.find((t: string) => t !== 'null');
      }
      const isSourceArray = sourceBaseType === 'array';

      const createCompositionEdges = (compositionType: 'allOf' | 'anyOf' | 'oneOf', refs: any[]) => {
        refs.forEach((item: any, index: number) => {
          if (item.$ref) {
            const refClassName = extractClassNameFromRef(item.$ref);
            if (refClassName && classNameToId.has(refClassName)) {
              const targetClassId = classNameToId.get(refClassName)!;
              let edgeColor: string;
              let strokeDasharray: string;
              let label: string;
              if (compositionType === 'allOf') {
                edgeColor = '#2563eb';
                strokeDasharray = '0';
                label = 'allOf';
              } else if (compositionType === 'anyOf') {
                edgeColor = '#ea580c';
                strokeDasharray = '5,5';
                label = 'anyOf';
              } else {
                edgeColor = '#9333ea';
                strokeDasharray = '2,3';
                label = 'oneOf';
              }
              edges.push({
                id: `prop-${compositionType}-${cls.id}-${prop.id}-${targetClassId}-${index}`,
                source: cls.id,
                sourceHandle: `prop-${prop.id}`,
                target: targetClassId,
                type: METRIC_EDGE_TYPE,
                animated: false,
                label: `${prop.name} (${label}:${refClassName}${isSourceArray ? '[]' : ''})`,
                data: { sourceNodeId: cls.id, targetNodeId: targetClassId },
                style: { stroke: edgeColor, strokeWidth: 3, strokeDasharray },
                labelStyle: { fill: edgeColor, fontSize: SVG_TEXT_SIZE.label, fontWeight: 600 },
                labelBgStyle: { fill: 'white', fillOpacity: 0.95 },
                zIndex: 0,
              });
            }
          }
        });
      };

      if (propData.allOf && Array.isArray(propData.allOf)) {
        createCompositionEdges('allOf', propData.allOf);
        return;
      }
      if (propData.anyOf && Array.isArray(propData.anyOf)) {
        createCompositionEdges('anyOf', propData.anyOf);
        return;
      }
      if (propData.oneOf && Array.isArray(propData.oneOf)) {
        createCompositionEdges('oneOf', propData.oneOf);
        return;
      }
      if (isSourceArray && propData.items) {
        if (propData.items.anyOf && Array.isArray(propData.items.anyOf)) {
          createCompositionEdges('anyOf', propData.items.anyOf);
          return;
        }
        if (propData.items.oneOf && Array.isArray(propData.items.oneOf)) {
          createCompositionEdges('oneOf', propData.items.oneOf);
          return;
        }
        if (propData.items.allOf && Array.isArray(propData.items.allOf)) {
          createCompositionEdges('allOf', propData.items.allOf);
          return;
        }
      }

      let refClassName: string | null = null;
      if (propData.$ref) {
        refClassName = extractClassNameFromRef(propData.$ref);
      } else if (sourceBaseType === 'array' && propData.items?.$ref) {
        refClassName = extractClassNameFromRef(propData.items.$ref);
      }

      if (refClassName && classNameToId.has(refClassName)) {
        const targetClassId = classNameToId.get(refClassName)!;
        const targetClass = classes.find((c) => c.id === targetClassId);
        let isTargetArray = false;
        let hasReverseRef = false;
        if (targetClass && targetClass.properties) {
          targetClass.properties.forEach((targetProp: any) => {
            const targetPropData =
              typeof targetProp.data === 'string' ? JSON.parse(targetProp.data) : targetProp.data;
            let targetBaseType = targetPropData.type;
            if (Array.isArray(targetPropData.type)) {
              targetBaseType = targetPropData.type.find((t: string) => t !== 'null');
            }
            const targetRefName = targetPropData.$ref
              ? extractClassNameFromRef(targetPropData.$ref)
              : targetBaseType === 'array' && targetPropData.items?.$ref
                ? extractClassNameFromRef(targetPropData.items.$ref)
                : null;
            if (targetRefName === cls.name) {
              hasReverseRef = true;
              isTargetArray = targetBaseType === 'array';
            }
          });
        }

        let cardinality: string;
        let edgeColor: string;
        let markerStart: any;
        let markerEnd: any;
        if (isSourceArray && isTargetArray) {
          cardinality = 'N:N';
          edgeColor = '#ec4899';
          markerStart = { type: 'arrow', color: edgeColor, width: 20, height: 20 };
          markerEnd = { type: 'arrow', color: edgeColor, width: 20, height: 20 };
        } else if (isSourceArray && !isTargetArray) {
          cardinality = hasReverseRef ? '1:N' : 'N:1';
          edgeColor = '#8b5cf6';
          markerStart = hasReverseRef
            ? { type: 'arrowclosed', color: edgeColor, width: 20, height: 20 }
            : undefined;
          markerEnd = { type: 'arrow', color: edgeColor, width: 20, height: 20 };
        } else if (!isSourceArray && isTargetArray) {
          cardinality = 'N:1';
          edgeColor = '#f59e0b';
          markerStart = { type: 'arrow', color: edgeColor, width: 20, height: 20 };
          markerEnd = { type: 'arrowclosed', color: edgeColor, width: 20, height: 20 };
        } else {
          cardinality = hasReverseRef ? '1:1' : '1';
          edgeColor = '#3b82f6';
          markerStart = hasReverseRef
            ? { type: 'arrowclosed', color: edgeColor, width: 20, height: 20 }
            : undefined;
          markerEnd = { type: 'arrowclosed', color: edgeColor, width: 20, height: 20 };
        }
        edges.push({
          id: `prop-${cls.id}-${prop.id}-${targetClassId}`,
          source: cls.id,
          sourceHandle: `prop-${prop.id}`,
          target: targetClassId,
          type: METRIC_EDGE_TYPE,
          animated: false,
          label: `${prop.name} (${cardinality})`,
          data: { sourceNodeId: cls.id, targetNodeId: targetClassId },
          style: { stroke: edgeColor, strokeWidth: 2 },
          markerStart,
          markerEnd,
          labelStyle: { fill: '#6b7280', fontSize: SVG_TEXT_SIZE.body, fontWeight: 500 },
          labelBgStyle: { fill: 'white', fillOpacity: 0.9 },
        });
      }
    });
  });

  return edges;
}

function createCompositionEdgesForMetrics(classes: any[]): Edge[] {
  const edges: Edge[] = [];
  const classNameToId = new Map(classes.map((cls) => [cls.name, cls.id]));

  classes.forEach((cls) => {
    const schema = typeof cls.schema === 'string' ? JSON.parse(cls.schema) : cls.schema;
    if (!schema) return;

    if (schema.allOf && Array.isArray(schema.allOf)) {
      schema.allOf.forEach((item: any, index: number) => {
        if (item.$ref) {
          const refClassName = extractClassNameFromRef(item.$ref);
          if (refClassName && classNameToId.has(refClassName)) {
            const targetId = classNameToId.get(refClassName)!;
            edges.push({
              id: `allOf-${cls.id}-${refClassName}-${index}`,
              source: cls.id,
              sourceHandle: 'comp-bottom',
              target: targetId,
              type: METRIC_EDGE_TYPE,
              animated: false,
              label: `allOf:${refClassName}`,
              data: { sourceNodeId: cls.id, targetNodeId: targetId },
              style: { stroke: '#2563eb', strokeWidth: 3, strokeDasharray: '0' },
              markerEnd: { type: 'arrowclosed', color: '#2563eb', width: 15, height: 15 },
              labelStyle: { fill: '#2563eb', fontSize: SVG_TEXT_SIZE.label, fontWeight: 600 },
              labelBgStyle: { fill: 'white', fillOpacity: 0.95 },
              zIndex: 0,
            });
          }
        }
      });
    }

    if (schema.anyOf && Array.isArray(schema.anyOf)) {
      schema.anyOf.forEach((item: any, index: number) => {
        if (item.$ref) {
          const refClassName = extractClassNameFromRef(item.$ref);
          if (refClassName && classNameToId.has(refClassName)) {
            const targetId = classNameToId.get(refClassName)!;
            edges.push({
              id: `anyOf-${cls.id}-${refClassName}-${index}`,
              source: cls.id,
              sourceHandle: 'comp-bottom',
              target: targetId,
              type: METRIC_EDGE_TYPE,
              animated: false,
              label: `anyOf:${refClassName}`,
              data: { sourceNodeId: cls.id, targetNodeId: targetId },
              style: { stroke: '#ea580c', strokeWidth: 3, strokeDasharray: '5,5' },
              markerEnd: { type: 'arrowclosed', color: '#ea580c', width: 15, height: 15 },
              labelStyle: { fill: '#ea580c', fontSize: SVG_TEXT_SIZE.label, fontWeight: 600 },
              labelBgStyle: { fill: 'white', fillOpacity: 0.95 },
              zIndex: 0,
            });
          }
        }
      });
    }

    if (schema.oneOf && Array.isArray(schema.oneOf)) {
      schema.oneOf.forEach((item: any, index: number) => {
        if (item.$ref) {
          const refClassName = extractClassNameFromRef(item.$ref);
          if (refClassName && classNameToId.has(refClassName)) {
            const targetId = classNameToId.get(refClassName)!;
            edges.push({
              id: `oneOf-${cls.id}-${refClassName}-${index}`,
              source: cls.id,
              sourceHandle: 'comp-bottom',
              target: targetId,
              type: METRIC_EDGE_TYPE,
              animated: false,
              label: `oneOf:${refClassName}`,
              data: { sourceNodeId: cls.id, targetNodeId: targetId },
              style: { stroke: '#9333ea', strokeWidth: 3, strokeDasharray: '2,3' },
              markerEnd: { type: 'arrowclosed', color: '#9333ea', width: 15, height: 15 },
              labelStyle: { fill: '#9333ea', fontSize: SVG_TEXT_SIZE.label, fontWeight: 600 },
              labelBgStyle: { fill: 'white', fillOpacity: 0.95 },
            });
          }
        }
      });
    }
  });

  return edges;
}

function classesToMetricNodes(classes: any[]): Node[] {
  return classes.map((cls) => ({
    id: cls.id,
    type: 'classNode',
    position: { x: 0, y: 0 },
    data: {
      id: cls.id,
      name: cls.name,
      description: cls.description,
      properties: cls.properties || [],
      schema: cls.schema,
      tags: cls.tags || [],
      updated_at: cls.updated_at,
    },
  }));
}

/**
 * Nodes and edges suitable for {@link computeSchemaMetrics} from API class rows.
 */
export function buildGraphForSchemaMetrics(classes: any[]): { nodes: Node[]; edges: Edge[] } {
  const list = Array.isArray(classes) ? classes : [];
  const nodes = classesToMetricNodes(list);
  const edges = [...createPropertyRefEdgesForMetrics(list), ...createCompositionEdgesForMetrics(list)];
  return { nodes, edges };
}
