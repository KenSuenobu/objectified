import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { CANVAS_TOKENS, CANVAS_TYPE_SCALE, CANVAS_ICON_SIZE } from './canvas-theme';

/**
 * PropertyRow — canonical row layout for property lists in canvas nodes.
 *
 *   [chevron slot | name / required / badges | actions-or-type slot]
 *
 * The node component owns the data (hover state, drag-drop, expanded set)
 * and passes presentational props. This keeps the visual consistent across
 * Studio ClassNode, Paths body nodes, Migration class nodes, etc.
 */
export interface PropertyRowProps {
  depth?: number;
  /** Container (has children / object-array); shows chevron. */
  container?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  name: React.ReactNode;
  /** Show red asterisk before name. */
  required?: boolean;
  /** Visually strike through when deprecated. */
  deprecated?: boolean;
  deprecationMessage?: string;
  /** Small count pill shown after name, e.g. child count. */
  childCount?: number;
  /** Right-hand content — type chip (default) or hover-action buttons. */
  right?: React.ReactNode;
  /** Drag-drop state. */
  isValidDropZone?: boolean;
  isInvalidDropZone?: boolean;
  last?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const PropertyRow: React.FC<PropertyRowProps> = ({
  depth = 0,
  container,
  expanded,
  onToggleExpanded,
  name,
  required,
  deprecated,
  deprecationMessage,
  childCount,
  right,
  isValidDropZone,
  isInvalidDropZone,
  last,
  onMouseEnter,
  onMouseLeave,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
  className,
  style,
}) => {
  const paddingLeft = 10 + depth * 14;
  const dropBg = isInvalidDropZone
    ? 'color-mix(in srgb, var(--node-danger) 10%, transparent)'
    : isValidDropZone
    ? 'color-mix(in srgb, var(--node-success) 12%, transparent)'
    : 'transparent';

  return (
    <div
      className={className}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        display: 'grid',
        gridTemplateColumns: '14px 1fr auto',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        paddingLeft: `${paddingLeft}px`,
        minHeight: `${CANVAS_TOKENS.propertyRowHeight}px`,
        background: dropBg,
        borderBottom: last ? 'none' : '1px solid var(--node-border-muted)',
        transition: 'background 0.12s ease',
        position: 'relative',
        ...style,
      }}
    >
      <div style={{ width: '14px', display: 'flex', alignItems: 'center' }}>
        {container && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpanded?.();
            }}
            title={expanded ? 'Collapse' : 'Expand'}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '1px',
              borderRadius: '3px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--node-text-subtle)',
              transition: 'color 0.12s ease, background 0.12s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--node-surface-strong)';
              e.currentTarget.style.color = 'var(--node-text)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--node-text-subtle)';
            }}
          >
            {expanded ? <ChevronDown size={CANVAS_ICON_SIZE.meta} /> : <ChevronRight size={CANVAS_ICON_SIZE.meta} />}
          </button>
        )}
      </div>

      <div
        title={deprecated ? (deprecationMessage || 'Deprecated') : undefined}
        style={{
          fontWeight: 500,
          color: deprecated ? 'var(--node-text-subtle)' : 'var(--node-text)',
          fontSize: CANVAS_TYPE_SCALE.meta,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          textDecoration: deprecated ? 'line-through' : 'none',
          letterSpacing: '-0.01em',
        }}
      >
        {required && (
          <span
            style={{
              color: 'var(--node-danger)',
              fontSize: CANVAS_TYPE_SCALE.meta,
              fontWeight: 700,
              lineHeight: 1,
            }}
            aria-label="required"
          >
            *
          </span>
        )}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        {typeof childCount === 'number' && childCount > 0 && (
          <span
            style={{
              color: 'var(--node-text-subtle)',
              fontSize: CANVAS_TYPE_SCALE.micro,
              fontWeight: 600,
              background: 'var(--node-surface-strong)',
              padding: '0px 5px',
              borderRadius: '8px',
              lineHeight: 1.5,
            }}
          >
            {childCount}
          </span>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: '4px',
          minWidth: 0,
        }}
      >
        {right}
      </div>

      {children}
    </div>
  );
};

export default PropertyRow;
