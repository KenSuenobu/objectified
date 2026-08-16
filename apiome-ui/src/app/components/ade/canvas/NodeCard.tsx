import React from 'react';
import { accentVar, CANVAS_TOKENS, type NodeAccentRole, CANVAS_TYPE_SCALE } from './canvas-theme';

/**
 * NodeCard — the universal shell for every react-flow node card.
 *
 * Handles:
 *  - Surface + border + shadow (token-based)
 *  - Selection ring + glow (accent-colored)
 *  - Drag target overlays (valid/invalid)
 *  - Optional warning ring (e.g. circular dependency)
 *  - Optional heatmap overlay (full-card tint, non-interactive)
 *
 * Does NOT render a header, handles, or properties — those are composed in by
 * the concrete node components.
 */
export interface NodeCardProps {
  role?: NodeAccentRole;
  selected?: boolean;
  /** Custom border color (user-chosen theme). Overrides role-based border on selection. */
  customBorderColor?: string;
  /** Border width override (1-5 px). */
  borderWidth?: number;
  /** Border style override. */
  borderStyle?: 'solid' | 'dashed' | 'dotted';
  /** Explicit background override (user-chosen theme). */
  customBackground?: string;
  /** Drag + drop state. */
  isValidDropTarget?: boolean;
  invalidDropReason?: string | null;
  /** Show an extra amber ring (e.g. circular dependency). */
  warning?: boolean;
  /** Optional heatmap tint (e.g. complexity, change frequency). */
  heatmapTint?: string;
  minWidth?: number | string;
  maxWidth?: number | string;
  className?: string;
  style?: React.CSSProperties;
  innerRef?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  title?: string;
  role_attr?: string;
  'aria-label'?: string;
}

export const NodeCard: React.FC<NodeCardProps> = ({
  role = 'default',
  selected,
  customBorderColor,
  borderWidth = 1,
  borderStyle = 'solid',
  customBackground,
  isValidDropTarget,
  invalidDropReason,
  warning,
  heatmapTint,
  minWidth = CANVAS_TOKENS.nodeMinWidth,
  maxWidth = CANVAS_TOKENS.nodeMaxWidth,
  className,
  style,
  innerRef,
  children,
  onDragOver,
  onDragLeave,
  onDrop,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
  title,
  role_attr,
  'aria-label': ariaLabel,
}) => {
  const accent = customBorderColor ?? accentVar(role);

  const baseBorder = customBorderColor ?? 'var(--node-border)';
  const borderColor = selected ? accent : invalidDropReason ? 'var(--node-danger)' : baseBorder;

  const shadow = selected
    ? `0 0 0 2px ${accent}, 0 10px 28px -10px color-mix(in srgb, ${accent} 45%, transparent), var(--node-shadow-sm)`
    : invalidDropReason
    ? '0 0 0 2px var(--node-danger), var(--node-shadow-md)'
    : isValidDropTarget
    ? '0 0 0 2px var(--node-success), var(--node-shadow-md)'
    : warning
    ? '0 0 0 2px var(--node-warning), var(--node-shadow-sm)'
    : 'var(--node-shadow-sm)';

  return (
    <div
      ref={innerRef}
      className={className}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      title={title}
      role={role_attr}
      aria-label={ariaLabel}
      style={{
        position: 'relative',
        background: customBackground ?? 'var(--node-surface)',
        color: 'var(--node-text)',
        border: `${borderWidth}px ${borderStyle} ${borderColor}`,
        borderRadius: `${CANVAS_TOKENS.radius}px`,
        minWidth,
        maxWidth,
        boxShadow: shadow,
        overflow: 'hidden',
        transition: 'box-shadow 0.18s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.18s ease',
        fontSize: CANVAS_TYPE_SCALE.body,
        ...style,
      }}
    >
      {heatmapTint && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            borderRadius: `${CANVAS_TOKENS.radius}px`,
            background: heatmapTint,
            zIndex: 0,
          }}
        />
      )}
      {children}
      {(isValidDropTarget || invalidDropReason) && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            borderRadius: `${CANVAS_TOKENS.radius}px`,
            border: `2px dashed ${invalidDropReason ? 'var(--node-danger)' : 'var(--node-success)'}`,
            background: invalidDropReason
              ? 'color-mix(in srgb, var(--node-danger) 8%, transparent)'
              : 'color-mix(in srgb, var(--node-success) 8%, transparent)',
            zIndex: 12,
          }}
        >
          {invalidDropReason && (
            <div
              style={{
                position: 'absolute',
                bottom: '8px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'var(--node-danger)',
                color: 'white',
                fontSize: CANVAS_TYPE_SCALE.meta,
                padding: '3px 10px',
                borderRadius: '6px',
                whiteSpace: 'nowrap',
                maxWidth: '90%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
              }}
            >
              {invalidDropReason}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default NodeCard;
