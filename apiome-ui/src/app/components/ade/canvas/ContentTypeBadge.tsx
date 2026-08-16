import React from 'react';
import { Link2, Braces, Code2 } from 'lucide-react';
import { CANVAS_TYPE_SCALE, CANVAS_ICON_SIZE } from './canvas-theme';

/**
 * ContentTypeBadge — compact pill describing a body's content-type binding.
 *
 * Two visual variants:
 *   1. Reference: "$class ClassName" (inline, violet accent)
 *   2. Inline:    "inline · N props" (primary accent)
 *
 * Colors are derived from the media type when reasonable (json green, xml orange,
 * multipart purple, form blue, fallback neutral).
 */
export interface ContentTypeBadgeProps {
  mediaType: string;
  reference?: { className: string };
  propertyCount?: number;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  style?: React.CSSProperties;
}

const MEDIA_TYPE_ACCENT: Record<string, string> = {
  'application/json': '#059669',
  'application/xml': '#ea580c',
  'multipart/form-data': '#9333ea',
  'application/x-www-form-urlencoded': '#2563eb',
  'text/plain': '#475569',
  'application/octet-stream': '#475569',
};

function accentFor(mediaType: string): string {
  return MEDIA_TYPE_ACCENT[mediaType] ?? 'var(--node-accent)';
}

export const ContentTypeBadge: React.FC<ContentTypeBadgeProps> = ({
  mediaType,
  reference,
  propertyCount,
  onClick,
  className,
  style,
}) => {
  const accent = accentFor(mediaType);
  const isReference = !!reference;
  return (
    <span
      className={className}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '2px 8px',
        borderRadius: '10px',
        fontSize: CANVAS_TYPE_SCALE.caps,
        fontWeight: 600,
        letterSpacing: '-0.01em',
        background: `color-mix(in srgb, ${accent} 12%, var(--node-surface))`,
        color: accent,
        border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        maxWidth: '180px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        ...style,
      }}
      title={isReference ? `$ref -> ${reference!.className}` : `inline · ${propertyCount ?? 0} props`}
    >
      {isReference ? (
        <Link2 size={CANVAS_ICON_SIZE.caps} strokeWidth={2.5} />
      ) : (
        <Braces size={CANVAS_ICON_SIZE.caps} strokeWidth={2.5} />
      )}
      {isReference ? (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{reference!.className}</span>
      ) : (
        <>
          <Code2 size={CANVAS_ICON_SIZE.micro} strokeWidth={2.5} />
          <span>{propertyCount ?? 0} props</span>
        </>
      )}
    </span>
  );
};

export default ContentTypeBadge;
