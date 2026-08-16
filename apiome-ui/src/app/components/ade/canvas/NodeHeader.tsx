import React from 'react';
import { accentTintVar, accentVar, CANVAS_TOKENS, type NodeAccentRole, CANVAS_TYPE_SCALE } from './canvas-theme';

/**
 * NodeHeader — title strip for all canvas node cards.
 *
 * Structure (top to bottom):
 *   [accent stripe — 3px solid role color]
 *   [title row — icon tile | title + subtitle | badges slot]
 *
 * Prefers flat surface-muted background with a colored stripe rather than a
 * saturated gradient. If a node genuinely needs a gradient (legacy look, user
 * custom theme), pass `customBackground` and the stripe will be hidden.
 */
export interface NodeHeaderProps {
  role?: NodeAccentRole;
  /** Custom primary color (hex) — overrides role-based accent. */
  customAccent?: string;
  /** If set, replaces the flat surface-muted title row with this CSS background. */
  customBackground?: string;
  /** If set, uses this color for title text (needed when customBackground is dark). */
  customTextColor?: string;
  icon?: React.ReactNode;
  /** Size of the icon tile in px. */
  iconSize?: number;
  /** Content of the title row. */
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned slot (badges, status chips). */
  badges?: React.ReactNode;
  /** When true, no accent stripe and no icon tile background; used for mini nodes. */
  compact?: boolean;
  /** Align title text. */
  textAlign?: 'left' | 'center' | 'right';
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const NodeHeader: React.FC<NodeHeaderProps> = ({
  role = 'default',
  customAccent,
  customBackground,
  customTextColor,
  icon,
  iconSize = 24,
  title,
  subtitle,
  badges,
  compact = false,
  textAlign = 'left',
  children,
  className,
  style,
}) => {
  const accent = customAccent ?? accentVar(role);
  const iconBg = customAccent
    ? `color-mix(in srgb, ${customAccent} 16%, transparent)`
    : accentTintVar(role);
  const iconColor = customAccent ?? accent;

  const titleBg = customBackground
    ?? (compact ? 'transparent' : 'var(--node-surface-muted)');
  const titleColor = customTextColor ?? 'var(--node-text)';

  return (
    <div className={className} style={style}>
      {!customBackground && !compact && (
        <div
          aria-hidden
          style={{
            height: `${CANVAS_TOKENS.headerStripeHeight}px`,
            background: accent,
          }}
        />
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: compact ? '6px 10px' : '8px 12px',
          background: titleBg,
          color: titleColor,
          borderBottom: compact ? 'none' : '1px solid var(--node-border-muted)',
          position: 'relative',
        }}
      >
        {icon !== undefined && icon !== null && (
          <div
            style={{
              width: `${iconSize}px`,
              height: `${iconSize}px`,
              borderRadius: '6px',
              background: customBackground ? 'rgba(255, 255, 255, 0.18)' : iconBg,
              color: customBackground ? (customTextColor ?? 'white') : iconColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: CANVAS_TYPE_SCALE.caps,
              fontWeight: 700,
              letterSpacing: '-0.3px',
              flexShrink: 0,
            }}
          >
            {icon}
          </div>
        )}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            textAlign,
            display: 'flex',
            flexDirection: 'column',
            gap: subtitle ? '1px' : 0,
          }}
        >
          <div style={{ minWidth: 0 }}>{title}</div>
          {subtitle && (
            <div
              style={{
                fontSize: CANVAS_TYPE_SCALE.caps,
                color: customBackground ? 'rgba(255, 255, 255, 0.75)' : 'var(--node-text-muted)',
                letterSpacing: '-0.01em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {badges && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              flexShrink: 0,
            }}
          >
            {badges}
          </div>
        )}
        {children}
      </div>
    </div>
  );
};

export default NodeHeader;
