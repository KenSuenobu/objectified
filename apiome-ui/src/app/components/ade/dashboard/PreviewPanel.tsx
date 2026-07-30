'use client';

import { useState, useEffect, useMemo } from 'react';
import { Package, Search, Check, ChevronRight, ChevronDown, ArrowUpAZ, ArrowDownAZ, LayoutGrid, Network, FolderTree } from 'lucide-react';
import * as Checkbox from '@radix-ui/react-checkbox';
import { AnalysisResult } from '../../../utils/openapi-analyzer';
import { buildSchemaTree, buildRelationshipDiagramEdges, extractSchemaReferences, getSchemaType, getSchemaTags, type SchemaTreeNode, type SchemaDisplayType } from '../../../utils/schema-tree-utils';
import { getSmartClassName } from '../../../../../lib/schema-context-naming';
import { collectExternalTypeKeysFromDocument } from '../../../../../lib/importers/openapi';
import { extractDirectProperties } from '../../../utils/openapi-import';
import { generateSlug } from '../../../utils/slug';
import YAML from 'yaml';
import Editor from '@monaco-editor/react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  MarkerType,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/Collapsible';
import { ImportOptionsForm } from './ImportOptionsForm';
import { TAB_LIST_CLASS, tabTriggerClass } from '../../ui/tabStyles';

interface PreviewPanelProps {
  analysis: AnalysisResult;
  onImportOptionsChange?: (options: ImportOptions) => void;
}

/** Naming convention for classes and properties during import (#581) */
export type ImportNamingConvention = 'PascalCase' | 'camelCase' | 'snake_case' | 'kebab-case' | 'none';

export interface ImportOptions {
  projectName: string;
  projectSlug: string;
  versionSource: 'spec' | 'manual';
  targetVersion: string;
  selectedSchemas: string[];
  /** When true, apply naming convention to class and property names */
  applyNamingConvention?: boolean;
  /** Convention for class names (default: PascalCase) */
  classNamingConvention?: ImportNamingConvention;
  /** Convention for property names (default: camelCase) */
  propertyNamingConvention?: ImportNamingConvention;
  /** Optional prefix applied to every class name after naming convention (#755) */
  classPrefix?: string;
  /** Optional suffix applied to every class name after naming convention (#755) */
  classSuffix?: string;
  /** When true, preview changes without committing (dry run). */
  dryRun?: boolean;
  /** When true, import all available and skip failures (each class committed separately). */
  incrementalMode?: boolean;
  /** Optional map: schema key → class name override for import (#754). */
  classNameMap?: Record<string, string>;
  /** Optional type mapping: external type key → internal JSON Schema (#757). */
  typeMapping?: Record<string, any>;
  /** Optional default values per type during import (#758). Key = external type key (e.g. "string", "integer"). */
  defaultValues?: Record<string, any>;
  /** Optional required field overrides during import (#759). schema key -> { property name -> boolean }. */
  requiredOverrides?: Record<string, Record<string, boolean>>;
  /** Optional property description overrides during import (#760). schema key -> { property name -> description }. */
  descriptionOverrides?: Record<string, Record<string, string>>;
  /** When true, auto-generate example values for properties that do not have an example (#761). */
  generateExamples?: boolean;
}

interface SchemaInfo {
  name: string;
  properties: number;
  selected: boolean;
  required: boolean;
  schemaType: SchemaDisplayType;
  tags: string[];
}

const MAX_ENUM_DISPLAY = 4;

/** Internal type options for type mapping (#757). Value is schema to apply; null = keep as-is. */
const INTERNAL_TYPE_OPTIONS: { value: string; label: string; schema: any }[] = [
  { value: '__keep__', label: 'Keep as-is', schema: null as any },
  { value: 'string', label: 'string', schema: { type: 'string' } },
  { value: 'string:date-time', label: 'string (date-time)', schema: { type: 'string', format: 'date-time' } },
  { value: 'string:date', label: 'string (date)', schema: { type: 'string', format: 'date' } },
  { value: 'string:uuid', label: 'string (uuid)', schema: { type: 'string', format: 'uuid' } },
  { value: 'integer', label: 'integer', schema: { type: 'integer' } },
  { value: 'integer:int32', label: 'integer (int32)', schema: { type: 'integer', format: 'int32' } },
  { value: 'integer:int64', label: 'integer (int64)', schema: { type: 'integer', format: 'int64' } },
  { value: 'number', label: 'number', schema: { type: 'number' } },
  { value: 'number:float', label: 'number (float)', schema: { type: 'number', format: 'float' } },
  { value: 'number:double', label: 'number (double)', schema: { type: 'number', format: 'double' } },
  { value: 'boolean', label: 'boolean', schema: { type: 'boolean' } },
];

// Helper function to count properties including those from allOf/oneOf/anyOf
function countSchemaProperties(schema: any): number {
  let count = 0;

  // Count direct properties
  if (schema.properties) {
    count += Object.keys(schema.properties).length;
  }

  // Count properties from allOf (inheritance - all schemas apply)
  if (schema.allOf && Array.isArray(schema.allOf)) {
    schema.allOf.forEach((item: any) => {
      if (item.properties) {
        count += Object.keys(item.properties).length;
      }
    });
  }

  // Count properties from oneOf (variants - show max from any variant)
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    let maxOneOf = 0;
    schema.oneOf.forEach((item: any) => {
      if (item.properties) {
        maxOneOf = Math.max(maxOneOf, Object.keys(item.properties).length);
      }
    });
    count += maxOneOf;
  }

  // Count properties from anyOf (flexible - show max from any option)
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    let maxAnyOf = 0;
    schema.anyOf.forEach((item: any) => {
      if (item.properties) {
        maxAnyOf = Math.max(maxAnyOf, Object.keys(item.properties).length);
      }
    });
    count += maxAnyOf;
  }

  return count;
}

// Simple preview node component for the chart view
function PreviewClassNode({ data }: { data: { label: string; propertyCount: number; selected: boolean; hasComposition?: boolean; compositionType?: string } }) {
  return (
    <div className={`bg-white dark:bg-gray-800 rounded-lg shadow-md border-2 min-w-[120px] max-w-[180px] ${
      data.selected 
        ? 'border-indigo-400 dark:border-indigo-500' 
        : 'border-gray-300 dark:border-gray-600 opacity-50'
    }`}>
      <Handle type="target" position={Position.Top} className="w-2 h-2 !bg-indigo-500" />
      <Handle type="target" position={Position.Left} className="w-2 h-2 !bg-indigo-500" />

      <div className={`px-3 py-2 border-b border-gray-200 dark:border-gray-600 rounded-t-lg ${
        data.hasComposition 
          ? 'bg-purple-50 dark:bg-purple-900/30' 
          : 'bg-indigo-50 dark:bg-indigo-900/30'
      }`}>
        <div className="flex items-center gap-1.5">
          {data.hasComposition && data.compositionType && (
            <span className="text-[9px] px-1 py-0.5 bg-purple-200 dark:bg-purple-800 text-purple-700 dark:text-purple-300 rounded">
              {data.compositionType}
            </span>
          )}
          <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate">
            {data.label}
          </span>
        </div>
      </div>
      <div className="px-3 py-2">
        <div className="text-[10px] text-gray-500 dark:text-gray-400">
          {data.propertyCount} {data.propertyCount === 1 ? 'property' : 'properties'}
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="w-2 h-2 !bg-indigo-500" />
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 !bg-indigo-500" />
    </div>
  );
}

const previewNodeTypes = {
  previewClass: PreviewClassNode,
};

// Re-export for consumers that import from PreviewPanel
export type { SchemaTreeNode } from '../../../utils/schema-tree-utils';

// Get composition type if any
function getCompositionType(schema: any): string | null {
  if (schema.allOf) return 'allOf';
  if (schema.oneOf) return 'oneOf';
  if (schema.anyOf) return 'anyOf';
  return null;
}

// Expandable property row for import preview (#577)
function ExpandablePropertyRow({
  propName,
  propValue,
  isRequired,
  getPropertyType,
  expandKey,
  isExpanded,
  onOpenChange,
  accentClass = 'text-indigo-600 dark:text-indigo-400',
}: {
  propName: string;
  propValue: any;
  isRequired: boolean;
  getPropertyType: (prop: any) => string;
  expandKey: string;
  isExpanded: boolean;
  onOpenChange: (open: boolean) => void;
  accentClass?: string;
}) {
  const hasAny =
    propValue?.description ||
    propValue?.format ||
    propValue?.default !== undefined ||
    propValue?.example !== undefined ||
    (Array.isArray(propValue?.enum) && propValue.enum.length > 0) ||
    propValue?.nullable === true ||
    propValue?.minimum !== undefined ||
    propValue?.maximum !== undefined ||
    propValue?.minLength !== undefined ||
    propValue?.maxLength !== undefined ||
    propValue?.pattern;

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={onOpenChange}
    >
      <div className="text-sm group">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left rounded px-1 -mx-1 hover:bg-gray-100 dark:hover:bg-gray-700/50"
          >
            {hasAny ? (
              isExpanded ? (
                <ChevronDown className="h-4 w-4 text-gray-500 dark:text-gray-400 flex-shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-gray-500 dark:text-gray-400 flex-shrink-0" />
              )
            ) : (
              <span className="w-4 inline-block flex-shrink-0" aria-hidden />
            )}
            <span className={`font-mono ${accentClass}`}>{propName}</span>
            <span className="text-gray-500 dark:text-gray-400">: </span>
            <span className="text-gray-700 dark:text-gray-300">
              {getPropertyType(propValue)}
            </span>
            {isRequired && (
              <span className="ml-2 text-xs text-red-600 dark:text-red-400 font-medium">
                (required)
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {hasAny && (
            <div className="ml-6 mt-1 mb-2 pl-3 border-l border-gray-200 dark:border-gray-600 space-y-1.5 text-xs text-gray-600 dark:text-gray-400">
              {propValue?.description && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">Description: </span>
                  {propValue.description}
                </div>
              )}
              {propValue?.format && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">Format: </span>
                  <span className="font-mono">{propValue.format}</span>
                </div>
              )}
              {propValue?.default !== undefined && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">Default: </span>
                  <span className="font-mono">
                    {typeof propValue.default === 'object'
                      ? JSON.stringify(propValue.default)
                      : String(propValue.default)}
                  </span>
                </div>
              )}
              {propValue?.example !== undefined && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">Example: </span>
                  <span className="font-mono">
                    {typeof propValue.example === 'object'
                      ? JSON.stringify(propValue.example)
                      : String(propValue.example)}
                  </span>
                </div>
              )}
              {Array.isArray(propValue?.enum) && propValue.enum.length > 0 && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">Enum: </span>
                  <span className="font-mono">
                    {propValue.enum.map((v: unknown) => (typeof v === 'string' ? `"${v}"` : String(v))).join(', ')}
                  </span>
                </div>
              )}
              {propValue?.nullable === true && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">Nullable: </span>
                  true
                </div>
              )}
              {(propValue?.minimum !== undefined || propValue?.maximum !== undefined) && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">Range: </span>
                  {propValue.minimum !== undefined && (
                    <span className="font-mono">min {propValue.minimum}</span>
                  )}
                  {propValue.minimum !== undefined && propValue.maximum !== undefined && ' \u2013 '}
                  {propValue.maximum !== undefined && (
                    <span className="font-mono">max {propValue.maximum}</span>
                  )}
                </div>
              )}
              {(propValue?.minLength !== undefined || propValue?.maxLength !== undefined) && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">Length: </span>
                  <span className="font-mono">
                    {propValue.minLength ?? 0} \u2013 {propValue.maxLength ?? '\u221E'}
                  </span>
                </div>
              )}
              {propValue?.pattern && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">Pattern: </span>
                  <span className="font-mono break-all">{propValue.pattern}</span>
                </div>
              )}
            </div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// Single tree node for hierarchical schema view
function SchemaTreeItem({
  node,
  depth,
  parentKey,
  expandedSchemaNames,
  onToggleExpand,
  getSchemaInfo,
  onToggleSchema,
  onSelectSchema,
  selectedSchemaName,
}: {
  node: SchemaTreeNode;
  depth: number;
  parentKey: string;
  expandedSchemaNames: string[];
  onToggleExpand: (name: string) => void;
  getSchemaInfo: (name: string) => SchemaInfo | undefined;
  onToggleSchema: (name: string) => void;
  onSelectSchema: (name: string | null) => void;
  selectedSchemaName: string | null;
}) {
  const schemaInfo = getSchemaInfo(node.name);
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedSchemaNames.includes(node.name);
  const isSelected = selectedSchemaName === node.name;
  const paddingLeft = depth * 16 + 12;

  return (
    <div className="space-y-0.5">
      <div
        className={`flex items-center gap-2 rounded-lg cursor-pointer transition-colors ${
          isSelected
            ? 'bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800'
            : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
        }`}
        style={{ paddingLeft: `${paddingLeft}px`, paddingRight: 12, paddingTop: 8, paddingBottom: 8 }}
        onClick={() => onSelectSchema(node.name)}
      >
        <div className="flex items-center gap-1 flex-shrink-0 w-5">
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(node.name);
              }}
              className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          ) : (
            <span className="w-4 inline-block" aria-hidden />
          )}
        </div>
        <Checkbox.Root
          checked={schemaInfo?.selected ?? false}
          onCheckedChange={() => onToggleSchema(node.name)}
          onClick={(e) => e.stopPropagation()}
          className="w-5 h-5 rounded border-2 border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 data-[state=checked]:bg-indigo-600 data-[state=checked]:border-indigo-600 flex items-center justify-center flex-shrink-0"
        >
          <Checkbox.Indicator>
            <Check className="w-4 h-4 text-white" />
          </Checkbox.Indicator>
        </Checkbox.Root>
        <Package className="h-4 w-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 dark:text-white truncate text-sm">
            {node.name}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {schemaInfo != null ? `${schemaInfo.properties} properties` : ''}
          </div>
        </div>
      </div>
      {hasChildren && (
        <Collapsible open={isExpanded}>
          <CollapsibleContent>
            {node.children.map((child, idx) => (
              <SchemaTreeItem
                key={`${parentKey}-${child.name}-${idx}`}
                node={child}
                depth={depth + 1}
                parentKey={`${parentKey}-${node.name}-${idx}`}
                expandedSchemaNames={expandedSchemaNames}
                onToggleExpand={onToggleExpand}
                getSchemaInfo={getSchemaInfo}
                onToggleSchema={onToggleSchema}
                onSelectSchema={onSelectSchema}
                selectedSchemaName={selectedSchemaName}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

export function PreviewPanel({ analysis, onImportOptionsChange }: PreviewPanelProps) {
  const [searchFilter, setSearchFilter] = useState('');
  const [filterType, setFilterType] = useState<SchemaDisplayType | ''>('');
  const [filterTag, setFilterTag] = useState<string>('');
  const [selectedSchemaName, setSelectedSchemaName] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'summary' | 'json' | 'yaml'>('summary');
  const [panelView, setPanelView] = useState<'list' | 'chart' | 'tree'>('list');
  const [expandedSchemaNames, setExpandedSchemaNames] = useState<string[]>([]);
  const [expandedPropertyKeys, setExpandedPropertyKeys] = useState<Set<string>>(new Set());
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | null>(null);
  const [schemas, setSchemas] = useState<SchemaInfo[]>(() => {
    const schemaObj = analysis.document?.components?.schemas || analysis.document?.definitions || {};
    return Object.keys(schemaObj).map((name) => {
      const raw = schemaObj[name];
      return {
        name,
        properties: countSchemaProperties(raw),
        selected: true,
        required: false,
        schemaType: getSchemaType(raw),
        tags: getSchemaTags(raw),
      };
    });
  });

  const [importOptions, setImportOptions] = useState<ImportOptions>(() => {
    const title = analysis.document?.info?.title || 'New Project';
    return {
      projectName: title,
      projectSlug: generateSlug(title) || 'new-project',
      versionSource: 'spec',
      targetVersion: analysis.document?.info?.version || '1.0.0',
      selectedSchemas: schemas.map(s => s.name),
      applyNamingConvention: true,
      classNamingConvention: 'PascalCase',
      propertyNamingConvention: 'camelCase',
      classPrefix: '',
      classSuffix: '',
      dryRun: false,
      typeMapping: undefined,
      defaultValues: undefined,
      requiredOverrides: undefined,
      descriptionOverrides: undefined,
      generateExamples: false
    };
  });

  // Track if user has manually edited the slug
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  // Notify parent of initial import options on mount
  useEffect(() => {
    if (onImportOptionsChange) {
      onImportOptionsChange(importOptions);
    }
  }, []); // Empty dependency array - run only on mount


  const selectedSchema = selectedSchemaName
    ? (analysis.document?.components?.schemas?.[selectedSchemaName] ||
       analysis.document?.definitions?.[selectedSchemaName])
    : null;

  const allTags = Array.from(new Set(schemas.flatMap((s) => s.tags))).sort();

  const filteredSchemas = schemas
    .filter((schema) => {
      const matchesName = schema.name.toLowerCase().includes(searchFilter.toLowerCase());
      const matchesType = !filterType || schema.schemaType === filterType;
      const matchesTag = !filterTag || schema.tags.includes(filterTag);
      return matchesName && matchesType && matchesTag;
    })
    .sort((a, b) => {
      if (sortOrder === 'asc') return a.name.localeCompare(b.name);
      if (sortOrder === 'desc') return b.name.localeCompare(a.name);
      return 0; // Keep original order if no sort applied
    });

  const selectedCount = schemas.filter(s => s.selected).length;

  const schemaObj = analysis.document?.components?.schemas || analysis.document?.definitions || {};

  // Hierarchical tree for Tree View (#576): filter roots by name, type, tags (#580)
  const schemaTreeRoots = useMemo(() => {
    const allSchemaNames = Object.keys(schemaObj);
    const hasFilter = searchFilter.trim() || filterType || filterTag;
    const nameFilter = hasFilter
      ? (name: string) => {
          const info = schemas.find((s) => s.name === name);
          if (!info) return true;
          const matchesName = !searchFilter.trim() || name.toLowerCase().includes(searchFilter.toLowerCase());
          const matchesType = !filterType || info.schemaType === filterType;
          const matchesTag = !filterTag || info.tags.includes(filterTag);
          return matchesName && matchesType && matchesTag;
        }
      : undefined;
    return buildSchemaTree(schemaObj, allSchemaNames, nameFilter);
  }, [analysis.document, searchFilter, filterType, filterTag, schemas]);

  /** External type keys present in selected schemas for type mapping (#757). */
  const externalTypeKeys = useMemo(
    () => collectExternalTypeKeysFromDocument(analysis.document, importOptions.selectedSchemas),
    [analysis.document, importOptions.selectedSchemas]
  );

  /** Per-schema property list for required field override (#759). Matches importer direct-property set. */
  const requiredOverrideRows = useMemo(() => {
    const schemasObj = analysis.document?.components?.schemas || analysis.document?.definitions || {};
    const selected = new Set(importOptions.selectedSchemas);
    const rows: { schemaKey: string; propName: string; requiredInSpec: boolean }[] = [];
    for (const schemaKey of importOptions.selectedSchemas) {
      if (!selected.has(schemaKey)) continue;
      const schema = schemasObj[schemaKey];
      if (!schema) continue;
      const { properties, required } = extractDirectProperties(schema);
      for (const propName of Object.keys(properties)) {
        rows.push({
          schemaKey,
          propName,
          requiredInSpec: Array.isArray(required) && required.includes(propName),
        });
      }
    }
    return rows;
  }, [analysis.document, importOptions.selectedSchemas]);

  /** Per-schema property list for description override (#760). Includes description from spec for display. */
  const descriptionOverrideRows = useMemo(() => {
    const schemasObj = analysis.document?.components?.schemas || analysis.document?.definitions || {};
    const selected = new Set(importOptions.selectedSchemas);
    const rows: { schemaKey: string; propName: string; descriptionInSpec: string }[] = [];
    for (const schemaKey of importOptions.selectedSchemas) {
      if (!selected.has(schemaKey)) continue;
      const schema = schemasObj[schemaKey];
      if (!schema) continue;
      const { properties } = extractDirectProperties(schema);
      for (const propName of Object.keys(properties)) {
        const propSchema = properties[propName];
        const descriptionInSpec = typeof propSchema?.description === 'string' ? propSchema.description : '';
        rows.push({ schemaKey, propName, descriptionInSpec });
      }
    }
    return rows;
  }, [analysis.document, importOptions.selectedSchemas]);

  const toggleExpanded = (name: string) => {
    setExpandedSchemaNames((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  };

  const getSchemaInfo = (name: string): SchemaInfo | undefined =>
    schemas.find((s) => s.name === name);

  // Generate nodes and edges for the relationship diagram (#578) – use filtered schemas and edge labels
  const { chartNodes, chartEdges } = useMemo(() => {
    const schemaObj = analysis.document?.components?.schemas || analysis.document?.definitions || {};
    const allSchemaNames = Object.keys(schemaObj);
    const schemaNames = filteredSchemas.map((s) => s.name);

    if (schemaNames.length === 0) {
      return { chartNodes: [], chartEdges: [] };
    }

    const selectionMap = new Map(schemas.map((s) => [s.name, s.selected]));

    const cols = Math.ceil(Math.sqrt(schemaNames.length));
    const nodeWidth = 160;
    const nodeHeight = 80;
    const gapX = 80;
    const gapY = 60;

    const nodes: Node[] = schemaNames.map((name, index) => {
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
          selected: selectionMap.get(name) ?? true,
          hasComposition: !!compositionType,
          compositionType: compositionType,
        },
      };
    });

    // Build edges from $ref relationships with property labels (#578) via shared util
    const diagramEdges = buildRelationshipDiagramEdges(schemaObj, schemaNames);
    const edges: Edge[] = diagramEdges.map(({ source, target, label }) => ({
      id: `${source}-${target}`,
      source,
      target,
      type: 'smoothstep',
      animated: false,
      label,
      labelStyle: { fill: '#4338ca', fontSize: 10, fontWeight: 500 },
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

    return { chartNodes: nodes, chartEdges: edges };
  }, [analysis.document, schemas, filteredSchemas]);

  const handleSelectAll = () => {
    const newSchemas = schemas.map(s => ({ ...s, selected: true }));
    setSchemas(newSchemas);
    updateSelectedSchemas(newSchemas);
  };

  const handleSelectNone = () => {
    const newSchemas = schemas.map(s => ({ ...s, selected: s.required }));
    setSchemas(newSchemas);
    updateSelectedSchemas(newSchemas);
  };

  const handlePropertyExpand = (expandKey: string, open: boolean) => {
    setExpandedPropertyKeys((prev) => {
      const next = new Set(prev);
      if (open) next.add(expandKey);
      else next.delete(expandKey);
      return next;
    });
  };

  const handleToggleSchema = (name: string) => {
    const newSchemas = schemas.map(s =>
      s.name === name ? { ...s, selected: !s.selected } : s
    );
    setSchemas(newSchemas);
    updateSelectedSchemas(newSchemas);
  };

  const updateSelectedSchemas = (schemaList: SchemaInfo[]) => {
    const selected = schemaList.filter(s => s.selected).map(s => s.name);
    const newOptions = { ...importOptions, selectedSchemas: selected };
    setImportOptions(newOptions);
    onImportOptionsChange?.(newOptions);
  };

  const handleOptionChange = (key: keyof ImportOptions, value: any) => {
    let newOptions = { ...importOptions, [key]: value };

    // Auto-update slug when project name changes (if not manually edited)
    if (key === 'projectName' && !slugManuallyEdited) {
      newOptions.projectSlug = generateSlug(value) || 'new-project';
    }

    setImportOptions(newOptions);
    onImportOptionsChange?.(newOptions);
  };

  const handleSlugChange = (value: string) => {
    // Filter to only allow valid slug characters
    const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    setSlugManuallyEdited(true);
    const newOptions = { ...importOptions, projectSlug: sanitized };
    setImportOptions(newOptions);
    onImportOptionsChange?.(newOptions);
  };

  const handleVersionSourceChange = (source: 'spec' | 'manual') => {
    const specVersion = analysis.document?.info?.version || '1.0.0';
    const newOptions = {
      ...importOptions,
      versionSource: source,
      targetVersion: source === 'spec' ? specVersion : ''
    };
    setImportOptions(newOptions);
    onImportOptionsChange?.(newOptions);
  };

  const handleVersionChange = (version: string) => {
    // Only allow: 0-9, A-Z, a-z, ., -
    const sanitized = version.replace(/[^0-9A-Za-z.\-]/g, '');
    const newOptions = { ...importOptions, targetVersion: sanitized };
    setImportOptions(newOptions);
    onImportOptionsChange?.(newOptions);
  };

  /** Update type mapping for an external type (#757). null = keep as-is (remove mapping). */
  const handleTypeMappingChange = (externalKey: string, internalValue: string) => {
    const nextMap = { ...(importOptions.typeMapping || {}) };
    if (internalValue === '__keep__') {
      delete nextMap[externalKey];
    } else {
      const option = INTERNAL_TYPE_OPTIONS.find((o) => o.value === internalValue);
      if (option && option.schema) nextMap[externalKey] = option.schema;
    }
    const newOptions = { ...importOptions, typeMapping: Object.keys(nextMap).length > 0 ? nextMap : undefined };
    setImportOptions(newOptions);
    onImportOptionsChange?.(newOptions);
  };

  /** Update class name override for a schema (#754). Empty or same as smart name clears the override. */
  const handleClassNameOverride = (schemaKey: string, schema: any, value: string) => {
    const trimmed = value.trim();
    const smart = getSmartClassName(schemaKey, schema);
    const nextMap = { ...(importOptions.classNameMap || {}) };
    if (trimmed === '' || trimmed === smart) {
      delete nextMap[schemaKey];
    } else {
      nextMap[schemaKey] = trimmed;
    }
    const newOptions = { ...importOptions, classNameMap: Object.keys(nextMap).length > 0 ? nextMap : undefined };
    setImportOptions(newOptions);
    onImportOptionsChange?.(newOptions);
  };

  const getPropertyType = (prop: any): string => {
    if (prop.$ref) {
      const refName = prop.$ref.split('/').pop();
      return `$ref → ${refName}`;
    }

    if (prop.type === 'array') {
      if (prop.items?.$ref) {
        const refName = prop.items.$ref.split('/').pop();
        return `array<$ref → ${refName}>`;
      }
      return `array<${prop.items?.type || 'any'}>`;
    }

    if (prop.enum) {
      const enumValues = prop.enum.slice(0, MAX_ENUM_DISPLAY).join(', ');
      const remaining = prop.enum.length - MAX_ENUM_DISPLAY;

      if (remaining > 0) {
        return `enum (${enumValues}, ... ${remaining} more)`;
      }

      return `enum (${enumValues})`;
    }
    return prop.type || 'any';
  };

  return (
    <div className="space-y-6">
      {/* View Mode Tabs and Schema Selection Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          {/* View Mode Tabs */}
          <div role="tablist" aria-label="Schema view" className={TAB_LIST_CLASS}>
            <button
              type="button"
              role="tab"
              aria-selected={panelView === 'list'}
              onClick={() => setPanelView('list')}
              className={tabTriggerClass({ active: panelView === 'list' })}
            >
              <LayoutGrid className="h-4 w-4" />
              List View
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panelView === 'chart'}
              onClick={() => setPanelView('chart')}
              className={tabTriggerClass({ active: panelView === 'chart' })}
            >
              <Network className="h-4 w-4" />
              Relationship Diagram
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panelView === 'tree'}
              onClick={() => setPanelView('tree')}
              className={tabTriggerClass({ active: panelView === 'tree' })}
            >
              <FolderTree className="h-4 w-4" />
              Tree View
            </button>
          </div>

          {/* Selection Controls - show in list and tree view */}
          {(panelView === 'list' || panelView === 'tree') && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleSelectAll}
                className="px-3 py-1.5 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-colors"
              >
                Select All
              </button>
              <button
                onClick={handleSelectNone}
                className="px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Select None
              </button>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {selectedCount} of {schemas.length} selected
              </span>
            </div>
          )}

          {/* Search and filter by name, type, tags (#580) */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[140px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by name..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <select
              value={filterType}
              onChange={(e) => setFilterType((e.target.value || '') as SchemaDisplayType | '')}
              className="py-2 pl-3 pr-8 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              title="Filter by type"
            >
              <option value="">All types</option>
              <option value="object">object</option>
              <option value="array">array</option>
              <option value="allOf">allOf</option>
              <option value="oneOf">oneOf</option>
              <option value="anyOf">anyOf</option>
              <option value="enum">enum</option>
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="integer">integer</option>
              <option value="boolean">boolean</option>
              <option value="null">null</option>
              <option value="unknown">unknown</option>
            </select>
            <select
              value={filterTag}
              onChange={(e) => setFilterTag(e.target.value)}
              className="py-2 pl-3 pr-8 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              title="Filter by tag"
            >
              <option value="">All tags</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </div>

          {/* Schema count - always visible */}
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {selectedCount} of {schemas.length} schemas selected
          </span>
        </div>
      </div>

      {/* Relationship Diagram (#578) */}
      {panelView === 'chart' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="border-b border-gray-200 dark:border-gray-700 p-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Relationship Diagram
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Preview of schema relationships. Arrows show references; labels show the property or &quot;items&quot;. Filter by search, type, or tag above.
            </p>
          </div>
          <div className="h-[500px]">
            <ReactFlowProvider>
              <ReactFlow
                nodes={chartNodes}
                edges={chartEdges}
                nodeTypes={previewNodeTypes}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                nodesDraggable={true}
                nodesConnectable={false}
                elementsSelectable={true}
                minZoom={0.2}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
                <Controls showInteractive={false} />
                <MiniMap
                  nodeColor={(node) => node.data?.selected ? '#6366f1' : '#9ca3af'}
                  maskColor="rgba(0, 0, 0, 0.1)"
                  className="bg-gray-100 dark:bg-gray-700"
                />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
        </div>
      )}

      {/* List View and Tree View - Schema Selection and Preview */}
      {(panelView === 'list' || panelView === 'tree') && (
      <div className="grid grid-cols-3 gap-6">
        {/* Left: Schema List or Tree - 1/3 width */}
        <div className="col-span-1 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <div className="border-b border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {panelView === 'tree' ? 'Schema Tree' : 'Schemas to Import'}
              </h3>
              {panelView === 'list' && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setSortOrder(sortOrder === 'asc' ? null : 'asc')}
                    className={`p-1.5 rounded transition-colors ${
                      sortOrder === 'asc'
                        ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
                        : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                    title="Sort A → Z"
                  >
                    <ArrowUpAZ className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setSortOrder(sortOrder === 'desc' ? null : 'desc')}
                    className={`p-1.5 rounded transition-colors ${
                      sortOrder === 'desc'
                        ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
                        : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                    title="Sort Z → A"
                  >
                    <ArrowDownAZ className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
            {panelView === 'tree' && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Expand schemas to see referenced types ($ref)
              </p>
            )}
          </div>
          <div className="p-4 space-y-2 max-h-[400px] overflow-y-auto">
            {panelView === 'list' &&
              filteredSchemas.map((schema) => (
                <div
                  key={schema.name}
                  className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                    selectedSchemaName === schema.name
                      ? 'bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                  }`}
                  onClick={() => setSelectedSchemaName(schema.name)}
                >
                  <Checkbox.Root
                    checked={schema.selected}
                    onCheckedChange={() => handleToggleSchema(schema.name)}
                    onClick={(e) => e.stopPropagation()}
                    className="w-5 h-5 rounded border-2 border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 data-[state=checked]:bg-indigo-600 data-[state=checked]:border-indigo-600 flex items-center justify-center"
                  >
                    <Checkbox.Indicator>
                      <Check className="w-4 h-4 text-white" />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                  <Package className="h-5 w-5 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900 dark:text-white truncate">
                      {schema.name}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {schema.properties} properties
                    </div>
                  </div>
                  {selectedSchemaName === schema.name && (
                    <ChevronRight className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  )}
                </div>
              ))}
            {panelView === 'tree' &&
              schemaTreeRoots.map((node, rootIndex) => (
                <SchemaTreeItem
                  key={`root-${node.name}-${rootIndex}`}
                  node={node}
                  depth={0}
                  parentKey={`root-${rootIndex}`}
                  expandedSchemaNames={expandedSchemaNames}
                  onToggleExpand={toggleExpanded}
                  getSchemaInfo={getSchemaInfo}
                  onToggleSchema={handleToggleSchema}
                  onSelectSchema={setSelectedSchemaName}
                  selectedSchemaName={selectedSchemaName}
                />
              ))}
          </div>
        </div>

        {/* Right: Schema Preview - 2/3 width */}
        <div className="col-span-2 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <div className="border-b border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Schema Preview
              </h3>
              {selectedSchema && selectedSchemaName && (
                <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
                  <button
                    onClick={() => setViewMode('summary')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                      viewMode === 'summary'
                        ? 'bg-white dark:bg-gray-600 text-indigo-600 dark:text-indigo-400 shadow-sm'
                        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                    }`}
                  >
                    Summary
                  </button>
                  <button
                    onClick={() => setViewMode('json')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                      viewMode === 'json'
                        ? 'bg-white dark:bg-gray-600 text-indigo-600 dark:text-indigo-400 shadow-sm'
                        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                    }`}
                  >
                    JSON
                  </button>
                  <button
                    onClick={() => setViewMode('yaml')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                      viewMode === 'yaml'
                        ? 'bg-white dark:bg-gray-600 text-indigo-600 dark:text-indigo-400 shadow-sm'
                        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                    }`}
                  >
                    YAML
                  </button>
                </div>
              )}
            </div>
            {/* Custom name override for imported class (#754) - visible in all view modes */}
            {selectedSchema && selectedSchemaName && (
              <div className="mt-4">
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Import as class name
                </label>
                <input
                  type="text"
                  value={importOptions.classNameMap?.[selectedSchemaName] ?? getSmartClassName(selectedSchemaName, selectedSchema)}
                  onChange={(e) => handleClassNameOverride(selectedSchemaName, selectedSchema, e.target.value)}
                  placeholder={getSmartClassName(selectedSchemaName, selectedSchema)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Override the class name when importing. From schema title / x-class-name when not set.
                </p>
              </div>
            )}
          </div>
          <div className="p-4 max-h-[400px] overflow-y-auto">
            {selectedSchema && selectedSchemaName ? (
              <div className="space-y-4">
                {viewMode === 'summary' ? (
                  <>
                    <div>
                      <h4 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                        {selectedSchemaName}
                      </h4>
                      {selectedSchema.description && (
                        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                          {selectedSchema.description}
                        </p>
                      )}
                    </div>

                    {selectedSchema.properties && (
                      <div>
                        <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                          Properties:
                        </h5>
                        <div className="space-y-0.5 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
                          {Object.entries(selectedSchema.properties).map(([propName, propValue]: [string, any]) => {
                            const expandKey = `${selectedSchemaName}|${propName}`;
                            return (
                              <ExpandablePropertyRow
                                key={propName}
                                propName={propName}
                                propValue={propValue}
                                isRequired={selectedSchema.required?.includes(propName) ?? false}
                                getPropertyType={getPropertyType}
                                expandKey={expandKey}
                                isExpanded={expandedPropertyKeys.has(expandKey)}
                                onOpenChange={(open) => handlePropertyExpand(expandKey, open)}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Show relationships from $ref in properties */}
                    {selectedSchema.properties && (
                      (() => {
                        const relationships: { name: string; type: string }[] = [];
                        Object.entries(selectedSchema.properties).forEach(([propName, propValue]: [string, any]) => {
                          if (propValue.$ref) {
                            const refName = propValue.$ref.split('/').pop();
                            relationships.push({ name: refName, type: 'composition' });
                          } else if (propValue.type === 'array' && propValue.items?.$ref) {
                            const refName = propValue.items.$ref.split('/').pop();
                            relationships.push({ name: refName, type: 'aggregation' });
                          }
                        });

                        if (relationships.length > 0) {
                          return (
                            <div>
                              <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                                Relationships:
                              </h5>
                              <div className="space-y-1 pl-4 border-l-2 border-green-200 dark:border-green-700">
                                {relationships.map((rel, idx) => (
                                  <div key={idx} className="text-sm flex items-center gap-2">
                                    <span className="text-green-600 dark:text-green-400">→</span>
                                    <span className="font-mono text-gray-900 dark:text-white">{rel.name}</span>
                                    <span className="text-xs px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                                      {rel.type}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        }
                        return null;
                      })()
                    )}

                    {/* Show inheritance from allOf */}
                    {selectedSchema.allOf && (
                      <div>
                        <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                          Inherits From (allOf):
                        </h5>
                        <div className="space-y-2 pl-4 border-l-2 border-blue-200 dark:border-blue-700">
                          {selectedSchema.allOf.map((item: any, idx: number) => {
                            if (item.$ref) {
                              const refName = item.$ref.split('/').pop();
                              return (
                                <div key={idx} className="text-sm flex items-center gap-2">
                                  <span className="text-blue-600 dark:text-blue-400">↑</span>
                                  <span className="font-mono text-gray-900 dark:text-white">{refName}</span>
                                  <span className="text-xs px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                                    extends
                                  </span>
                                </div>
                              );
                            } else if (item.type === 'object' && item.properties) {
                              const propEntries = Object.entries(item.properties || {});
                              return (
                                <div key={idx} className="space-y-1">
                                  <div className="text-sm flex items-center gap-2">
                                    <span className="text-blue-600 dark:text-blue-400">+</span>
                                    <span className="text-gray-700 dark:text-gray-300 font-medium">
                                      additional properties:
                                    </span>
                                  </div>
                                  <div className="ml-6 space-y-1 pl-3 border-l border-blue-100 dark:border-blue-800">
                                    {propEntries.map(([propName, propValue]: [string, any]) => (
                                      <div key={propName} className="text-sm">
                                        <span className="font-mono text-blue-600 dark:text-blue-400">
                                          {propName}
                                        </span>
                                        <span className="text-gray-500 dark:text-gray-400">: </span>
                                        <span className="text-gray-700 dark:text-gray-300">
                                          {getPropertyType(propValue)}
                                        </span>
                                        {item.required?.includes(propName) && (
                                          <span className="ml-2 text-xs text-red-600 dark:text-red-400 font-medium">
                                            (required)
                                          </span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            }
                            return null;
                          })}
                        </div>
                      </div>
                    )}

                    {/* Show polymorphism from oneOf */}
                    {selectedSchema.oneOf && (
                      <div>
                        <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                          Variants (oneOf):
                        </h5>
                        <div className="space-y-2 pl-4 border-l-2 border-purple-200 dark:border-purple-700">
                          {selectedSchema.oneOf.map((item: any, idx: number) => {
                            if (item.$ref) {
                              const refName = item.$ref.split('/').pop();
                              return (
                                <div key={idx} className="text-sm flex items-center gap-2">
                                  <span className="text-purple-600 dark:text-purple-400">◇</span>
                                  <span className="font-mono text-gray-900 dark:text-white">{refName}</span>
                                  <span className="text-xs px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">
                                    variant
                                  </span>
                                </div>
                              );
                            }
                            // Show inline schema details
                            const hasRequired = item.required && item.required.length > 0;
                            const hasProperties = item.properties && Object.keys(item.properties).length > 0;
                            return (
                              <div key={idx} className="space-y-1">
                                <div className="text-sm flex items-center gap-2">
                                  <span className="text-purple-600 dark:text-purple-400">◇</span>
                                  <span className="text-gray-700 dark:text-gray-300 font-medium">
                                    {hasRequired ? `requires: [${item.required.join(', ')}]` : 'inline schema'}
                                  </span>
                                </div>
                                {hasProperties && (
                                  <div className="ml-6 space-y-1 pl-3 border-l border-purple-100 dark:border-purple-800">
                                    {Object.entries(item.properties).map(([propName, propValue]: [string, any]) => (
                                      <div key={propName} className="text-sm">
                                        <span className="font-mono text-purple-600 dark:text-purple-400">
                                          {propName}
                                        </span>
                                        <span className="text-gray-500 dark:text-gray-400">: </span>
                                        <span className="text-gray-700 dark:text-gray-300">
                                          {getPropertyType(propValue)}
                                        </span>
                                        {item.required?.includes(propName) && (
                                          <span className="ml-2 text-xs text-red-600 dark:text-red-400 font-medium">
                                            (required)
                                          </span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Show flexible matching from anyOf */}
                    {selectedSchema.anyOf && (
                      <div>
                        <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                          Options (anyOf):
                        </h5>
                        <div className="space-y-2 pl-4 border-l-2 border-indigo-200 dark:border-indigo-700">
                          {selectedSchema.anyOf.map((item: any, idx: number) => {
                            if (item.$ref) {
                              const refName = item.$ref.split('/').pop();
                              return (
                                <div key={idx} className="text-sm flex items-center gap-2">
                                  <span className="text-indigo-600 dark:text-indigo-400">○</span>
                                  <span className="font-mono text-gray-900 dark:text-white">{refName}</span>
                                  <span className="text-xs px-2 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300">
                                    option
                                  </span>
                                </div>
                              );
                            }
                            // Show inline schema details
                            const hasRequired = item.required && item.required.length > 0;
                            const hasProperties = item.properties && Object.keys(item.properties).length > 0;
                            return (
                              <div key={idx} className="space-y-1">
                                <div className="text-sm flex items-center gap-2">
                                  <span className="text-indigo-600 dark:text-indigo-400">○</span>
                                  <span className="text-gray-700 dark:text-gray-300 font-medium">
                                    {hasRequired ? `requires: [${item.required.join(', ')}]` : 'inline schema'}
                                  </span>
                                </div>
                                {hasProperties && (
                                  <div className="ml-6 space-y-1 pl-3 border-l border-indigo-100 dark:border-indigo-800">
                                    {Object.entries(item.properties).map(([propName, propValue]: [string, any]) => (
                                      <div key={propName} className="text-sm">
                                        <span className="font-mono text-indigo-600 dark:text-indigo-400">
                                          {propName}
                                        </span>
                                        <span className="text-gray-500 dark:text-gray-400">: </span>
                                        <span className="text-gray-700 dark:text-gray-300">
                                          {getPropertyType(propValue)}
                                        </span>
                                        {item.required?.includes(propName) && (
                                          <span className="ml-2 text-xs text-red-600 dark:text-red-400 font-medium">
                                            (required)
                                          </span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                ) : viewMode === 'json' ? (
                  <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                    <Editor
                      height="350px"
                      defaultLanguage="json"
                      value={JSON.stringify(selectedSchema, null, 2)}
                      theme="vs-dark"
                      options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        fontSize: 12,
                        lineNumbers: 'on',
                        folding: true,
                        wordWrap: 'on',
                        wrappingIndent: 'indent',
                      }}
                    />
                  </div>
                ) : (
                  <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                    <Editor
                      height="350px"
                      defaultLanguage="yaml"
                      value={YAML.stringify(selectedSchema)}
                      theme="vs-dark"
                      options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        fontSize: 12,
                        lineNumbers: 'on',
                        folding: true,
                        wordWrap: 'on',
                        wrappingIndent: 'indent',
                      }}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-12 text-gray-400 dark:text-gray-500">
                Select a schema to preview
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Import Options */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Import Options
        </h3>

        <div className="grid grid-cols-4 gap-6">
          {/* Project Name - 50% (2 columns) */}
          <div className="col-span-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Project Name
            </label>
            <input
              type="text"
              value={importOptions.projectName}
              onChange={(e) => handleOptionChange('projectName', e.target.value)}
              placeholder="Enter project name"
              className="w-full px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              A new project will be created with this name
            </div>
          </div>

          {/* Project Slug - 25% (1 column) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Slug
            </label>
            <input
              type="text"
              value={importOptions.projectSlug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="project-slug"
              className="w-full px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              URL-friendly identifier
            </div>
          </div>

          {/* Version Configuration - 25% (1 column) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Version
            </label>
            <div className="space-y-2">
              {/* Version Input */}
              <input
                type="text"
                value={importOptions.targetVersion}
                onChange={(e) => handleVersionChange(e.target.value)}
                placeholder={importOptions.versionSource === 'spec' ? 'Version from spec' : 'Enter version (e.g., 1.0.0)'}
                disabled={importOptions.versionSource === 'spec'}
                className="w-full px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-gray-50 dark:disabled:bg-gray-800"
              />
              {/* Radio buttons for version source */}
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="versionSource"
                    value="spec"
                    checked={importOptions.versionSource === 'spec'}
                    onChange={() => handleVersionSourceChange('spec')}
                    className="w-4 h-4 text-indigo-600 focus:ring-2 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-gray-700 dark:text-gray-300">
                    From spec
                  </span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="versionSource"
                    value="manual"
                    checked={importOptions.versionSource === 'manual'}
                    onChange={() => handleVersionSourceChange('manual')}
                    className="w-4 h-4 text-indigo-600 focus:ring-2 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-gray-700 dark:text-gray-300">
                    Manual
                  </span>
                </label>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {importOptions.versionSource === 'spec'
                  ? `Using "${analysis.document?.info?.version || '1.0.0'}" from specification`
                  : 'Allowed: 0-9, A-Z, a-z, . (dot), - (dash)'}
              </div>
            </div>
          </div>

          {/* Naming convention enforcement (#581) — shared ImportOptionsForm */}
          <ImportOptionsForm options={importOptions} onOptionChange={handleOptionChange} sections={['naming']} />

          {/* Property mapping: type mapping, default values, required override, description override (#757, #758, #759, #760) */}
          {(externalTypeKeys.length > 0 || requiredOverrideRows.length > 0 || descriptionOverrideRows.length > 0) && (
            <div className="col-span-4 flex flex-col gap-3 pt-2">
              {externalTypeKeys.length > 0 && (
              <Collapsible defaultOpen={false} className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <span>Type mapping</span>
                  <ChevronDown className="h-4 w-4 shrink-0 data-[state=open]:rotate-180 transition-transform" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-700">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                      Map external types from the spec to internal types for imported properties.
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-200 dark:border-gray-600">
                            <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">External type</th>
                            <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">Map to</th>
                          </tr>
                        </thead>
                        <tbody>
                          {externalTypeKeys.map((externalKey) => {
                            const currentMapped = importOptions.typeMapping?.[externalKey];
                            const currentValue = currentMapped
                              ? INTERNAL_TYPE_OPTIONS.find((o) => o.schema && JSON.stringify(o.schema) === JSON.stringify(currentMapped))?.value ?? '__keep__'
                              : '__keep__';
                            return (
                              <tr key={externalKey} className="border-b border-gray-100 dark:border-gray-700/50">
                                <td className="py-2 text-gray-900 dark:text-white font-mono text-xs">{externalKey}</td>
                                <td className="py-2">
                                  <select
                                    value={currentValue}
                                    onChange={(e) => handleTypeMappingChange(externalKey, e.target.value)}
                                    className="w-full max-w-[220px] px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                  >
                                    <option value="__keep__">Keep as-is</option>
                                    {INTERNAL_TYPE_OPTIONS.filter((o) => o.value !== '__keep__').map((o) => (
                                      <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                  </select>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
              )}

              {/* Default values: set defaults for properties that have none (#758) */}
              {externalTypeKeys.length > 0 && (
              <Collapsible defaultOpen={false} className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <span>Default values</span>
                  <ChevronDown className="h-4 w-4 shrink-0 data-[state=open]:rotate-180 transition-transform" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-700">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                      Set a default value for properties that do not define one. Use JSON (e.g. &quot;&quot;, 0, false, null) or plain text for strings.
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-200 dark:border-gray-600">
                            <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">Type</th>
                            <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">Default value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {externalTypeKeys.map((externalKey) => {
                            const current = importOptions.defaultValues?.[externalKey];
                            const displayValue =
                              current === undefined || current === null
                                ? ''
                                : typeof current === 'string'
                                  ? current
                                  : JSON.stringify(current);
                            return (
                              <tr key={externalKey} className="border-b border-gray-100 dark:border-gray-700/50">
                                <td className="py-2 text-gray-900 dark:text-white font-mono text-xs">{externalKey}</td>
                                <td className="py-2">
                                  <input
                                    type="text"
                                    value={displayValue}
                                    onChange={(e) => {
                                      const raw = e.target.value.trim();
                                      let value: any = undefined;
                                      if (raw !== '') {
                                        try {
                                          value = JSON.parse(raw);
                                        } catch {
                                          value = raw;
                                        }
                                      }
                                      const next = { ...(importOptions.defaultValues || {}) };
                                      if (value === undefined) delete next[externalKey];
                                      else next[externalKey] = value;
                                      const newOptions = {
                                        ...importOptions,
                                        defaultValues: Object.keys(next).length > 0 ? next : undefined
                                      };
                                      setImportOptions(newOptions);
                                      onImportOptionsChange?.(newOptions);
                                    }}
                                    placeholder="(none)"
                                    className="w-full max-w-[220px] px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
                                  />
                                </td>
                              </tr>
                            );
                          })}
                                </tbody>
                      </table>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
              )}

              {/* Required field override: set required/optional per property (#759) */}
              {requiredOverrideRows.length > 0 && (
                <Collapsible defaultOpen={false} className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                    <span>Required field override</span>
                    <ChevronDown className="h-4 w-4 shrink-0 data-[state=open]:rotate-180 transition-transform" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-700">
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                        Override required/optional for individual properties. &quot;As in spec&quot; uses the value from the specification.
                      </p>
                      <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-200 dark:border-gray-600 sticky top-0 bg-gray-50 dark:bg-gray-800/95">
                              <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">Schema</th>
                              <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">Property</th>
                              <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">Required</th>
                            </tr>
                          </thead>
                          <tbody>
                            {requiredOverrideRows.map(({ schemaKey, propName, requiredInSpec }) => {
                              const override = importOptions.requiredOverrides?.[schemaKey]?.[propName];
                              const value = override === undefined ? '__spec__' : override ? 'required' : 'optional';
                              return (
                                <tr key={`${schemaKey}.${propName}`} className="border-b border-gray-100 dark:border-gray-700/50">
                                  <td className="py-1.5 text-gray-900 dark:text-white font-mono text-xs">{schemaKey}</td>
                                  <td className="py-1.5 text-gray-900 dark:text-white font-mono text-xs">{propName}</td>
                                  <td className="py-1.5">
                                    <select
                                      value={value}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        const nextBySchema = { ...(importOptions.requiredOverrides || {}) };
                                        const nextSchema = { ...(nextBySchema[schemaKey] || {}) };
                                        if (v === '__spec__') {
                                          delete nextSchema[propName];
                                        } else {
                                          nextSchema[propName] = v === 'required';
                                        }
                                        if (Object.keys(nextSchema).length === 0) delete nextBySchema[schemaKey];
                                        else nextBySchema[schemaKey] = nextSchema;
                                        const newOptions = {
                                          ...importOptions,
                                          requiredOverrides: Object.keys(nextBySchema).length > 0 ? nextBySchema : undefined,
                                        };
                                        setImportOptions(newOptions);
                                        onImportOptionsChange?.(newOptions);
                                      }}
                                      className="w-full max-w-[140px] px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                    >
                                      <option value="__spec__">As in spec ({requiredInSpec ? 'required' : 'optional'})</option>
                                      <option value="required">Required</option>
                                      <option value="optional">Optional</option>
                                    </select>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}

              {/* Property descriptions: add or modify descriptions during import (#760) */}
              {descriptionOverrideRows.length > 0 && (
                <Collapsible defaultOpen={false} className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                    <span>Property descriptions</span>
                    <ChevronDown className="h-4 w-4 shrink-0 data-[state=open]:rotate-180 transition-transform" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-700">
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                        Add or change descriptions for imported properties. Leave empty to keep the specification value.
                      </p>
                      <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-200 dark:border-gray-600 sticky top-0 bg-gray-50 dark:bg-gray-800/95">
                              <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">Schema</th>
                              <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">Property</th>
                              <th className="text-left py-2 font-medium text-gray-700 dark:text-gray-300">Description</th>
                            </tr>
                          </thead>
                          <tbody>
                            {descriptionOverrideRows.map(({ schemaKey, propName, descriptionInSpec }) => {
                              const override = importOptions.descriptionOverrides?.[schemaKey]?.[propName];
                              const displayValue = override !== undefined ? override : '';
                              const placeholder = descriptionInSpec ? `As in spec: ${descriptionInSpec.slice(0, 40)}${descriptionInSpec.length > 40 ? '…' : ''}` : '(no description in spec)';
                              return (
                                <tr key={`desc-${schemaKey}.${propName}`} className="border-b border-gray-100 dark:border-gray-700/50">
                                  <td className="py-1.5 text-gray-900 dark:text-white font-mono text-xs align-top">{schemaKey}</td>
                                  <td className="py-1.5 text-gray-900 dark:text-white font-mono text-xs align-top">{propName}</td>
                                  <td className="py-1.5 min-w-[180px]">
                                    <input
                                      type="text"
                                      value={displayValue}
                                      onChange={(e) => {
                                        const raw = e.target.value;
                                        const nextBySchema = { ...(importOptions.descriptionOverrides || {}) };
                                        const nextSchema = { ...(nextBySchema[schemaKey] || {}) };
                                        if (raw === '') {
                                          delete nextSchema[propName];
                                        } else {
                                          nextSchema[propName] = raw;
                                        }
                                        if (Object.keys(nextSchema).length === 0) delete nextBySchema[schemaKey];
                                        else nextBySchema[schemaKey] = nextSchema;
                                        const newOptions = {
                                          ...importOptions,
                                          descriptionOverrides: Object.keys(nextBySchema).length > 0 ? nextBySchema : undefined,
                                        };
                                        setImportOptions(newOptions);
                                        onImportOptionsChange?.(newOptions);
                                      }}
                                      placeholder={placeholder}
                                      className="w-full min-w-[180px] px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          )}

          {/* Generate examples / dry run / incremental mode — shared ImportOptionsForm */}
          <ImportOptionsForm options={importOptions} onOptionChange={handleOptionChange} sections={['flags']} />
        </div>
      </div>
    </div>
  );
}

