'use client';

import * as React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { openRuleDialogRef } from '../openRuleDialogRef';
import { accentVar } from '../../../components/ade/canvas/canvas-theme';
import { CANVAS_TYPE_SCALE } from '@/app/components/ade/canvas/canvas-theme';

export interface MigrationRuleNodeData {
  ruleKey: string;
  ruleName: string;
  sourceProp: string;
  outputProperties: string[];
}

const FROM_ACCENT = accentVar('from');
const TO_ACCENT = accentVar('to');

function MigrationRuleNode(props: NodeProps) {
  const data = props.data as unknown as MigrationRuleNodeData;
  const { ruleKey, ruleName, sourceProp, outputProperties } = data;
  const outputCount = Math.max(1, outputProperties.length);

  const handleEdit = React.useCallback(() => {
    const fn = openRuleDialogRef.current;
    if (fn) fn(ruleKey, sourceProp, outputProperties[0] ?? sourceProp);
  }, [ruleKey, sourceProp, outputProperties]);

  return (
    <div
      style={{
        position: 'relative',
        zIndex: 10,
        height: '22px',
        minWidth: '128px',
        background: 'var(--node-surface-muted)',
        border: '1px solid var(--node-border)',
        borderLeft: `3px solid ${accentVar('rule')}`,
        borderRadius: '4px',
        boxShadow: 'var(--node-shadow-sm)',
        overflow: 'hidden',
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="input"
        style={{
          background: FROM_ACCENT,
          width: 9,
          height: 9,
          minWidth: 0,
          minHeight: 0,
          border: '1.5px solid var(--node-surface)',
          borderRadius: '50%',
          left: -10,
          top: '50%',
          transform: 'translateY(-50%)',
        }}
        isConnectable={false}
      />
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleEdit();
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="nodrag nopan"
        title="Edit rule"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 8px',
          fontSize: CANVAS_TYPE_SCALE.meta,
          fontWeight: 500,
          color: 'var(--node-text)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          pointerEvents: 'auto',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'var(--node-row-hover)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        }}
      >
        <span
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {ruleName || 'Rule'}
        </span>
      </button>
      {outputProperties.map((propName, i) => {
        const topPct = outputCount === 1 ? 50 : (100 * (i + 1)) / (outputCount + 1);
        return (
          <Handle
            key={propName}
            type="source"
            position={Position.Right}
            id={`out-${propName}`}
            style={{
              background: TO_ACCENT,
              width: 9,
              height: 9,
              minWidth: 0,
              minHeight: 0,
              border: '1.5px solid var(--node-surface)',
              borderRadius: '50%',
              right: -10,
              top: `${topPct}%`,
              transform: 'translateY(-50%)',
            }}
            isConnectable={false}
          />
        );
      })}
    </div>
  );
}

export default MigrationRuleNode;
