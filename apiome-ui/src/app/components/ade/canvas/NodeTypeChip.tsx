import React from 'react';
import { classifyTypeLabel, type TypeChipRole, CANVAS_TYPE_SCALE } from './canvas-theme';

/**
 * NodeTypeChip — mono pill used to display a property's resolved type.
 *
 * Auto-classifies the label into a role (ref / array / primitive / composition /
 * object / unassigned) which maps to a chip color. Role can be overridden.
 */
export interface NodeTypeChipProps {
  label: string;
  role?: TypeChipRole;
  /** Title tooltip; defaults to label. */
  title?: string;
  /** When true, render slightly smaller (for nested rows). */
  dense?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const ROLE_STYLES: Record<TypeChipRole, { bg: string; text: string }> = {
  ref: { bg: 'var(--node-chip-ref-bg)', text: 'var(--node-chip-ref-text)' },
  array: { bg: 'var(--node-chip-array-bg)', text: 'var(--node-chip-array-text)' },
  composition: { bg: 'var(--node-chip-comp-bg)', text: 'var(--node-chip-comp-text)' },
  primitive: { bg: 'var(--node-chip-prim-bg)', text: 'var(--node-chip-prim-text)' },
  object: { bg: 'var(--node-chip-prim-bg)', text: 'var(--node-chip-prim-text)' },
  unassigned: { bg: 'var(--node-chip-unassigned-bg)', text: 'var(--node-chip-unassigned-text)' },
};

export const NodeTypeChip: React.FC<NodeTypeChipProps> = ({
  label,
  role,
  title,
  dense = false,
  className,
  style,
}) => {
  const resolvedRole = role ?? classifyTypeLabel(label);
  const { bg, text } = ROLE_STYLES[resolvedRole];
  return (
    <span
      className={className}
      title={title ?? label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: dense ? CANVAS_TYPE_SCALE.micro : CANVAS_TYPE_SCALE.caps,
        lineHeight: 1.4,
        fontFamily: 'var(--app-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontWeight: 500,
        letterSpacing: '-0.01em',
        whiteSpace: 'nowrap',
        background: bg,
        color: text,
        padding: dense ? '1px 5px' : '1px 6px',
        borderRadius: '4px',
        maxWidth: '140px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        ...style,
      }}
    >
      {label}
    </span>
  );
};

export default NodeTypeChip;
