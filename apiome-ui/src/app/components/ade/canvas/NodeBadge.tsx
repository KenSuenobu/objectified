import React from 'react';
import { CANVAS_TYPE_SCALE } from './canvas-theme';

/**
 * NodeBadge — compact pill for header metrics, warnings, or status markers.
 *
 * Used in headers where gradients/dark backgrounds used to rely on
 * semi-transparent white. Now the badge sits on the flat surface-muted header
 * with a subtle color-tinted background.
 */
export type NodeBadgeVariant =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'accent'
  | 'overlay';   // white-on-tinted, for use atop gradient/dark headers

export interface NodeBadgeProps {
  variant?: NodeBadgeVariant;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  style?: React.CSSProperties;
}

const VARIANT_STYLES: Record<NodeBadgeVariant, { bg: string; fg: string; border?: string }> = {
  neutral: {
    bg: 'color-mix(in srgb, var(--node-text-subtle) 14%, transparent)',
    fg: 'var(--node-text-muted)',
  },
  info: {
    bg: 'color-mix(in srgb, var(--node-accent) 14%, transparent)',
    fg: 'var(--node-accent)',
  },
  accent: {
    bg: 'color-mix(in srgb, var(--node-accent) 18%, transparent)',
    fg: 'var(--node-accent)',
  },
  success: {
    bg: 'color-mix(in srgb, var(--node-success) 16%, transparent)',
    fg: 'var(--node-success)',
  },
  warning: {
    bg: 'color-mix(in srgb, var(--node-warning) 18%, transparent)',
    fg: '#b45309',
  },
  danger: {
    bg: 'color-mix(in srgb, var(--node-danger) 14%, transparent)',
    fg: 'var(--node-danger)',
  },
  overlay: {
    bg: 'rgba(255, 255, 255, 0.22)',
    fg: '#ffffff',
  },
};

export const NodeBadge: React.FC<NodeBadgeProps> = ({
  variant = 'neutral',
  icon,
  children,
  title,
  onClick,
  className,
  style,
}) => {
  const v = VARIANT_STYLES[variant];
  const clickable = Boolean(onClick);
  return (
    <span
      className={className}
      title={title}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        padding: '2px 6px',
        borderRadius: '4px',
        fontSize: CANVAS_TYPE_SCALE.caps,
        fontWeight: 600,
        lineHeight: 1.2,
        letterSpacing: '-0.01em',
        background: v.bg,
        color: v.fg,
        border: v.border ?? 'none',
        cursor: clickable ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {icon}
      {children}
    </span>
  );
};

export default NodeBadge;
