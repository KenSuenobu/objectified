'use client';

import React, { memo } from 'react';
import { Position, NodeProps } from '@xyflow/react';
import { NodeCard } from '../canvas/NodeCard';
import { NodeHeader } from '../canvas/NodeHeader';
import { NodeHandleDot } from '../canvas/NodeHandleDot';
import { NodeBadge } from '../canvas/NodeBadge';
import { CANVAS_TYPE_SCALE } from '../canvas/canvas-theme';

export interface PathNodeData {
  label: string;
  nodeType: 'path' | 'method' | 'parameter' | 'response';
  color?: string;
  dbPathId?: string;
  dbOperationId?: string;
  connectedPathId?: string;
  pendingDbSave?: boolean;
  path?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  pathVariables?: PathVariable[];
  externalDocs?: ExternalDocs;
  method?: string;
  operationId?: string;
  parameters?: any[];
  responses?: any[];
  requestBody?: string;
  security?: string;
  [key: string]: unknown;
}

export interface ExternalDocs {
  url: string;
  description?: string;
}

export interface PathVariable {
  name: string;
  description: string;
  type: string;
  required: boolean;
  example?: string;
}

export function extractPathVariables(path: string): string[] {
  const regex = /\{([^}]+)\}/g;
  const variables: string[] = [];
  let match;
  while ((match = regex.exec(path)) !== null) {
    variables.push(match[1]);
  }
  return variables;
}

const METHOD_COLORS: Record<string, string> = {
  GET: '#16a34a',
  POST: '#2563eb',
  PUT: '#ea580c',
  DELETE: '#dc2626',
  PATCH: '#9333ea',
  HEAD: '#64748b',
  OPTIONS: '#64748b',
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: CANVAS_TYPE_SCALE.micro,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--node-text-muted)',
  marginBottom: '3px',
};

const PANEL_BOX: React.CSSProperties = {
  border: '1px solid var(--node-border-muted)',
  borderRadius: '6px',
  padding: '6px 8px',
  minHeight: '28px',
  background: 'var(--node-surface)',
};

const PathNode: React.FC<NodeProps> = ({ data, selected }) => {
  const nodeData = data as unknown as PathNodeData;
  const { nodeType, label, color, path, method } = nodeData;

  if (nodeType === 'method') {
    const methodColor = METHOD_COLORS[method || ''] || '#64748b';
    const needsRequestBody = method && ['POST', 'PUT', 'PATCH'].includes(method);
    return (
      <>
        <NodeHandleDot type="target" position={Position.Top} color={methodColor} />
        <NodeCard
          role="path"
          selected={selected}
          customBorderColor={methodColor}
          borderWidth={2}
          minWidth={220}
          maxWidth={300}
        >
          <NodeHeader
            role="path"
            customBackground={methodColor}
            customTextColor="#ffffff"
            icon={
              <span style={{ fontSize: CANVAS_TYPE_SCALE.caps, fontWeight: 700 }}>
                {(method || label || 'M').substring(0, 2).toUpperCase()}
              </span>
            }
            iconSize={28}
            title={
              <>
                <div style={{ fontSize: CANVAS_TYPE_SCALE.caps, fontWeight: 600, opacity: 0.88, letterSpacing: '0.04em' }}>
                  HTTP METHOD
                </div>
                <div style={{ fontSize: CANVAS_TYPE_SCALE.heading, fontWeight: 700, letterSpacing: '-0.01em' }}>
                  {method || label}
                </div>
                {nodeData.operationId && (
                  <div
                    style={{
                      fontSize: CANVAS_TYPE_SCALE.caps,
                      opacity: 0.8,
                      fontFamily: 'var(--app-font-mono, monospace)',
                      marginTop: '2px',
                    }}
                  >
                    {nodeData.operationId}
                  </div>
                )}
              </>
            }
          />
          <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {needsRequestBody && (
              <div>
                <div style={SECTION_LABEL}>Request</div>
                <div style={PANEL_BOX}>
                  {nodeData.requestBody ? (
                    <div style={{ fontSize: CANVAS_TYPE_SCALE.caps, color: 'var(--node-text)' }}>{nodeData.requestBody}</div>
                  ) : (
                    <div
                      style={{
                        fontSize: CANVAS_TYPE_SCALE.caps,
                        color: 'var(--node-text-subtle)',
                        fontStyle: 'italic',
                      }}
                    >
                      (No request body)
                    </div>
                  )}
                </div>
              </div>
            )}

            <div>
              <div style={SECTION_LABEL}>Parameters</div>
              <div style={{ ...PANEL_BOX, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {nodeData.parameters &&
                Array.isArray(nodeData.parameters) &&
                nodeData.parameters.length > 0 ? (
                  nodeData.parameters.map((param: any, idx: number) => (
                    <div
                      key={idx}
                      style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: CANVAS_TYPE_SCALE.caps }}
                    >
                      <span
                        style={{
                          color: 'var(--node-text-subtle)',
                          fontFamily: 'var(--app-font-mono, monospace)',
                          width: '10px',
                        }}
                      >
                        {param.in === 'path'
                          ? ':'
                          : param.in === 'query'
                          ? '?'
                          : param.in === 'header'
                          ? 'H'
                          : 'C'}
                      </span>
                      <span
                        style={{ color: 'var(--node-text)', fontFamily: 'var(--app-font-mono, monospace)' }}
                      >
                        {param.name}
                      </span>
                      {param.required && (
                        <span
                          style={{ color: 'var(--node-danger)', fontSize: CANVAS_TYPE_SCALE.caps, fontWeight: 700 }}
                          title="required"
                        >
                          *
                        </span>
                      )}
                    </div>
                  ))
                ) : (
                  <div
                    style={{
                      fontSize: CANVAS_TYPE_SCALE.caps,
                      color: 'var(--node-text-subtle)',
                      fontStyle: 'italic',
                    }}
                  >
                    (No parameters)
                  </div>
                )}
              </div>
            </div>

            <div>
              <div style={SECTION_LABEL}>Responses</div>
              <div style={{ ...PANEL_BOX, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {nodeData.responses &&
                Array.isArray(nodeData.responses) &&
                nodeData.responses.length > 0 ? (
                  nodeData.responses.map((response: any, idx: number) => (
                    <div
                      key={idx}
                      style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: CANVAS_TYPE_SCALE.caps }}
                    >
                      <span
                        style={{
                          color: 'var(--node-text-muted)',
                          fontFamily: 'var(--app-font-mono, monospace)',
                          minWidth: '28px',
                          fontWeight: 600,
                        }}
                      >
                        {response.status || response.statusCode}
                      </span>
                      <span style={{ color: 'var(--node-text)' }}>
                        {response.schema || response.description || 'Response'}
                      </span>
                    </div>
                  ))
                ) : (
                  <div
                    style={{
                      fontSize: CANVAS_TYPE_SCALE.caps,
                      color: 'var(--node-text-subtle)',
                      fontStyle: 'italic',
                    }}
                  >
                    (No responses)
                  </div>
                )}
              </div>
            </div>

            {nodeData.security && (
              <div
                style={{
                  paddingTop: '6px',
                  borderTop: '1px solid var(--node-border-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: CANVAS_TYPE_SCALE.caps,
                  color: 'var(--node-text-muted)',
                }}
              >
                <span aria-hidden>🔐</span>
                <span>{nodeData.security}</span>
              </div>
            )}
          </div>
        </NodeCard>
        <NodeHandleDot type="source" position={Position.Bottom} color={methodColor} />
      </>
    );
  }

  // For other node types (path, parameter, response), use a compact chip.
  const chipAccent = (() => {
    if (nodeType === 'path') return 'var(--node-accent-path)';
    if (color) {
      const colorMap: Record<string, string> = {
        'bg-green-500': '#16a34a',
        'bg-blue-500': '#2563eb',
        'bg-orange-500': '#ea580c',
        'bg-red-500': '#dc2626',
        'bg-purple-500': '#9333ea',
        'bg-gray-500': '#64748b',
        'bg-yellow-500': '#eab308',
      };
      return colorMap[color] || 'var(--node-accent)';
    }
    return 'var(--node-accent)';
  })();

  const pathVars = path ? extractPathVariables(path) : [];

  return (
    <>
      {(nodeType === 'parameter' || nodeType === 'response') && (
        <NodeHandleDot type="target" position={Position.Top} color={chipAccent} />
      )}

      <NodeCard
        role={nodeType === 'path' ? 'path' : 'default'}
        selected={selected}
        customBorderColor={chipAccent}
        borderWidth={1}
        minWidth={150}
        maxWidth={280}
        style={{ opacity: nodeData.deprecated ? 0.75 : 1 }}
      >
        <NodeHeader
          role={nodeType === 'path' ? 'path' : 'default'}
          customBackground={chipAccent}
          customTextColor="#ffffff"
          compact
          title={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <div
                style={{
                  fontSize: CANVAS_TYPE_SCALE.micro,
                  fontWeight: 600,
                  opacity: 0.9,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}
              >
                {nodeType}
                {nodeType === 'path' && nodeData.deprecated && (
                  <span style={{ marginLeft: '6px' }}>
                    <NodeBadge variant="overlay">Deprecated</NodeBadge>
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: CANVAS_TYPE_SCALE.body,
                  fontWeight: nodeType === 'response' ? 700 : 600,
                  fontFamily:
                    nodeType === 'path'
                      ? 'var(--app-font-mono, monospace)'
                      : 'inherit',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textDecoration: nodeData.deprecated ? 'line-through' : 'none',
                }}
              >
                {path || label}
              </div>
              {nodeType === 'path' && pathVars.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '3px' }}>
                  {pathVars.map((v) => (
                    <span
                      key={v}
                      style={{
                        fontSize: CANVAS_TYPE_SCALE.caps,
                        padding: '1px 6px',
                        background: 'rgba(255, 255, 255, 0.22)',
                        borderRadius: '3px',
                        fontFamily: 'var(--app-font-mono, monospace)',
                        textDecoration: nodeData.deprecated ? 'line-through' : 'none',
                      }}
                    >
                      {v}
                    </span>
                  ))}
                </div>
              )}
            </div>
          }
        />
      </NodeCard>

      {(nodeType === 'path' || nodeType === 'parameter') && (
        <NodeHandleDot type="source" position={Position.Bottom} color={chipAccent} />
      )}
    </>
  );
};

export default memo(PathNode);
