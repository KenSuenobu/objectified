/**
 * Canvas design tokens + helpers for react-flow nodes.
 *
 * These are the single source of truth for how nodes look across every canvas
 * (Studio schema, Paths, Migration, Version history). Node components should
 * read colors and spacing from these helpers rather than hard-coding hexes.
 *
 * The CSS variables themselves live in `canvas.css` (light defaults) and are
 * overridden under `.dark` / `[data-theme]` selectors.
 */

export type NodeAccentRole =
  | 'default'   // Studio ClassNode / generic
  | 'group'     // Group frame
  | 'ref'       // Property-level $ref edges / handles
  | 'comp-all'  // allOf
  | 'comp-any'  // anyOf
  | 'comp-one'  // oneOf
  | 'from'      // Migration "from" side
  | 'to'        // Migration "to" side
  | 'rule'      // Migration rule node
  | 'path'      // Paths template
  | 'param'     // Path parameter
  | 'request'   // Request body
  | 'response'  // Response body (2xx default)
  | 'status-2xx'
  | 'status-3xx'
  | 'status-4xx'
  | 'status-5xx'
  | 'revision'; // Version history

/** Primary accent color for a role, as a CSS `var(...)` reference. */
export function accentVar(role: NodeAccentRole = 'default'): string {
  switch (role) {
    case 'ref': return 'var(--node-accent-ref)';
    case 'comp-all': return 'var(--node-accent-comp-all)';
    case 'comp-any': return 'var(--node-accent-comp-any)';
    case 'comp-one': return 'var(--node-accent-comp-one)';
    case 'from': return 'var(--node-accent-from)';
    case 'to': return 'var(--node-accent-to)';
    case 'rule': return 'var(--node-accent-rule)';
    case 'path': return 'var(--node-accent-path)';
    case 'param': return 'var(--node-accent-param)';
    case 'request': return 'var(--node-accent-request)';
    case 'response':
    case 'status-2xx': return 'var(--node-accent-2xx)';
    case 'status-3xx': return 'var(--node-accent-3xx)';
    case 'status-4xx': return 'var(--node-accent-4xx)';
    case 'status-5xx': return 'var(--node-accent-5xx)';
    case 'revision': return 'var(--node-accent-revision)';
    case 'group': return 'var(--node-accent-group)';
    case 'default':
    default:
      return 'var(--node-accent)';
  }
}

/** A soft tinted background suitable for icon tiles / accent chips. */
export function accentTintVar(role: NodeAccentRole = 'default'): string {
  return `color-mix(in srgb, ${accentVar(role)} 14%, transparent)`;
}

/** RGB triplet for the accent, for rgba() constructions (glows, overlays). */
export function accentRgba(role: NodeAccentRole, alpha: number): string {
  return `color-mix(in srgb, ${accentVar(role)} ${Math.round(alpha * 100)}%, transparent)`;
}

/* ---- Property-type chip role classification -------------------------------- */

export type TypeChipRole = 'ref' | 'array' | 'composition' | 'primitive' | 'object' | 'unassigned';

/**
 * Classify a display type string (e.g. "User", "string[]", "allOf(2)") into a
 * visual role for NodeTypeChip. Cheap heuristic — purely cosmetic.
 */
export function classifyTypeLabel(label: string): TypeChipRole {
  if (!label) return 'primitive';
  const lower = label.toLowerCase();
  if (lower.startsWith('(unassigned')) return 'unassigned';
  if (lower.startsWith('allof') || lower.startsWith('anyof') || lower.startsWith('oneof')) return 'composition';
  const isArray = lower.endsWith('[]') || lower.endsWith('[]?');
  const head = lower.replace(/\[\]\??$/, '');
  const primitives = new Set(['string', 'number', 'integer', 'boolean', 'null', 'any', 'unknown']);
  if (primitives.has(head.replace(/\?$/, ''))) return isArray ? 'array' : 'primitive';
  if (head === 'object') return 'object';
  if (isArray) return 'array';
  return 'ref';
}

/* ---- Dimensions / spacing -------------------------------------------------- */

export const CANVAS_TOKENS = {
  radius: 8,
  headerStripeHeight: 3,
  handleSize: 8,
  handleSizeLarge: 10,
  propertyRowHeight: 26,
  nodeMinWidth: 280,
  nodeMaxWidth: 440,
} as const;

/**
 * The type scale a react-flow node is drawn at (HIVE-1.6, #5279).
 *
 * Everywhere else in the app, type is `rem` and follows the reader's font-size preference
 * (DESIGN.md §3.2). A canvas node cannot: its box is `CANVAS_TOKENS.nodeMinWidth`-wide in
 * **graph coordinates**, its rows are `propertyRowHeight` tall, and the auto-layout in
 * `canvas-layout` packs nodes using those same numbers. Type that grew while the geometry
 * around it stayed fixed would overflow the box and desynchronise the layout — so a node's
 * text is part of the drawing, and the drawing is scaled as a whole by react-flow's zoom
 * transform. That is the "canvas geometry" exemption DESIGN.md grants, and the reader's
 * equivalent control here is the zoom, not the font scale.
 *
 * The steps are collected here, next to the geometry they are proportioned against, so a
 * node component never spells a size out. Values are CSS lengths (they land in an inline
 * `style`), stated in `px` because the surrounding coordinates are.
 */
export const CANVAS_TYPE_SCALE = {
  /** Dense chips and handle captions — the smallest mark on a node. */
  micro: '9px',
  /** Uppercase badges, type chips and metadata. */
  caps: '10px',
  /** Property rows and secondary node text. */
  meta: '11px',
  /** A node's ordinary body text. */
  body: '12px',
  /** A node's title. */
  title: '13px',
  /** The headline of a wide node (e.g. a path template). */
  heading: '15px',
} as const;

/**
 * Lucide icon sizes for react-flow nodes, in graph coordinates.
 *
 * The DESIGN.md §3.5 vocabulary (16 dense / 18 rail / 15 button, `components/ui/iconSizes`)
 * is `rem` and belongs to the document; a glyph on a node is proportioned against
 * {@link CANVAS_TYPE_SCALE} instead, for the reason that scale documents. Each step here is
 * named after the type step it sits beside, so an icon and its label stay a matched pair.
 */
export const CANVAS_ICON_SIZE = {
  /** Beside {@link CANVAS_TYPE_SCALE.micro}. */
  micro: 9,
  /** Beside {@link CANVAS_TYPE_SCALE.caps}. */
  caps: 10,
  /** Beside {@link CANVAS_TYPE_SCALE.meta} and `.body`. */
  meta: 12,
  /** Beside {@link CANVAS_TYPE_SCALE.title}. */
  title: 14,
} as const;

/* ---- Color manipulation (for existing custom-color picker integration) ---- */

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace(/^#/, '');
  const m = clean.match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
    || clean.match(/^([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (!m) return null;
  const expand = (x: string) => (x.length === 1 ? x + x : x);
  return {
    r: parseInt(expand(m[1]), 16),
    g: parseInt(expand(m[2]), 16),
    b: parseInt(expand(m[3]), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b]
    .map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeHex(hex: string, fallback = '#6366f1'): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return fallback;
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

export function relLuminance(hex: string): number {
  const rgb = hexToRgb(normalizeHex(hex));
  if (!rgb) return 0;
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((c) => c / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function readableTextOn(hex: string): string {
  return relLuminance(hex) > 0.6 ? '#0f172a' : '#ffffff';
}
