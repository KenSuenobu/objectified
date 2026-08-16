'use client';

import * as React from 'react';
import {
  BaseEdge,
  EdgeProps,
  getEdgeCenter,
  getSmoothStepPath,
} from '@xyflow/react';
import { Plus } from 'lucide-react';
import { CANVAS_TYPE_SCALE, CANVAS_ICON_SIZE } from '@/app/components/ade/canvas/canvas-theme';

const BUTTON_SIZE = 20;

export interface MigrationRuleEdgeData {
  /** Display label: rule name when a rule is applied, or null for passthrough (+) */
  ruleName?: string | null;
  ruleKey?: string;
  /** When true, this edge connects a class node to a rule node; do not show a label. */
  isConnector?: boolean;
  onAddRule?: () => void;
}

function MigrationRuleEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  markerStart,
  data,
}: EdgeProps) {
  const edgeData = data as MigrationRuleEdgeData | undefined;
  const isConnector = edgeData?.isConnector === true;
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: isConnector ? 0 : 8,
    offset: isConnector ? 24 : 20,
  });
  const [centerX, centerY] = getEdgeCenter({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });
  const ruleName = edgeData?.ruleName ?? null;
  const onAddRule = edgeData?.onAddRule;
  const isPassthrough = !isConnector && (ruleName === null || ruleName === '');
  const label = isPassthrough ? '+' : ruleName;
  const boxWidth = isPassthrough ? BUTTON_SIZE : Math.min(Math.max((label ?? '').length * 7, 24), 120);
  const halfW = boxWidth / 2;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={style}
      />
      {!isConnector && (
        <foreignObject
          x={centerX - halfW}
          y={centerY - BUTTON_SIZE / 2}
          width={boxWidth}
          height={BUTTON_SIZE}
          className="nodrag nopan"
          style={{ overflow: 'visible', pointerEvents: 'all' }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddRule?.();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={isPassthrough ? 'Add migration rule (passthrough)' : `Edit rule: ${label}`}
            title={isPassthrough ? 'Passthrough: no rule applied. Click to add a rule.' : (label ?? '')}
            style={{
              height: '100%',
              minWidth: '20px',
              padding: '0 6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '4px',
              cursor: 'pointer',
              transition: 'background-color 0.12s ease, border-color 0.12s ease',
              border: isPassthrough
                ? '1px dashed var(--node-border)'
                : `1px solid ${'var(--node-accent-rule)'}`,
              background: isPassthrough
                ? 'var(--node-surface)'
                : 'color-mix(in srgb, var(--node-accent-rule) 14%, var(--node-surface))',
              color: isPassthrough ? 'var(--node-text-muted)' : 'var(--node-accent-rule)',
              fontFamily: 'var(--app-font-mono, monospace)',
              fontSize: CANVAS_TYPE_SCALE.meta,
              fontWeight: 600,
              lineHeight: 1,
            }}
          >
            {isPassthrough ? (
              <Plus size={CANVAS_ICON_SIZE.meta} strokeWidth={2.5} style={{ flexShrink: 0 }} />
            ) : (
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  letterSpacing: '-0.01em',
                }}
              >
                {label}
              </span>
            )}
          </button>
        </foreignObject>
      )}
    </>
  );
}

export default MigrationRuleEdge;
