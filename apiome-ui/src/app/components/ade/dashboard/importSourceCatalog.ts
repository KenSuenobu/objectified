/**
 * Import-source card catalog (MFI-1.3, #3735).
 *
 * The ImportDialog source grid is data-driven: a fixed set of built-in cards (the existing
 * intake methods — file/url/clipboard/git/swaggerhub/postman/mcp) merged with whatever the
 * server-side registry (`GET /api/import/sources`) reports. A newly registered adapter therefore
 * appears as a new card with no UI code change, while the built-in cards stay exactly as they were.
 *
 * The merge is pure (no React, no fetch) so it can be unit-tested directly.
 */

import {
  Upload,
  Link2,
  FileText,
  Github,
  Cloud,
  FileJson,
  Network,
  FileCode,
  type LucideIcon,
} from 'lucide-react';
// Namespace import is intentional: registry adapters name their icon (e.g. "file-json") and we
// resolve it dynamically, so any Lucide icon works without a UI change. Next.js optimizes
// `lucide-react` imports, and the built-in cards above still use tree-shaken named imports.
import * as LucideIcons from 'lucide-react';

/** Generic intake panels the dialog already renders; a card routes to one of these on click. */
export type ImportPanelId =
  | 'file'
  | 'url'
  | 'clipboard'
  | 'git'
  | 'swaggerhub'
  | 'postman'
  | 'mcp';

/**
 * Which import surface a source card belongs to (MFI-23.12):
 *  - `native` — the OpenAPI/Swagger-oriented intake that stays on the **Projects** importer
 *    (e.g. SwaggerHub).
 *  - `alternative` — the *other* formats (gRPC, GraphQL, AsyncAPI, Postman, MCP, and every
 *    registry-contributed adapter) that belong to the **Catalog** importer.
 *  - `both` — a generic intake method (File / URL / Clipboard / Git) that auto-detects the format,
 *    so it is offered on either surface.
 */
export type ImportSourceScope = 'native' | 'alternative' | 'both';

/** Which importer variant a grid is being rendered for; drives {@link filterCardsForVariant}. */
export type ImportVariant = 'projects' | 'catalog' | 'all';

/** The descriptor shape returned by `GET /api/import/sources` (REST `ImportSourceDescriptor`). */
export interface ImportSourceDescriptor {
  key: string;
  label: string;
  description: string;
  /** Lucide icon name in kebab-case, e.g. `"file-json"`. */
  icon: string;
  paradigm: string;
  /** Subset of `"file" | "url" | "paste" | "discovery"`. */
  input_kinds: string[];
  supports_live_discovery: boolean;
  formats: string[];
  /**
   * Whether the adapter can actually run in this runtime (MFI-5.2). `false` when a hard-required
   * toolchain is missing (e.g. `buf` for gRPC/Protobuf). Absent (older REST) is treated as `true`.
   */
  available?: boolean;
  /** Human-readable reason the source is unavailable, when `available` is `false`. */
  unavailable_reason?: string | null;
}

/** A renderable source card. */
export interface ImportSourceCard {
  /** Stable key; for built-ins this is also the `selectedSource` id the dialog branches on. */
  key: string;
  label: string;
  description: string;
  /** Resolved Lucide icon component. */
  icon: LucideIcon;
  /** Generic intake panel this card opens, or `null` when none is available yet (disabled card). */
  panel: ImportPanelId | null;
  /** `true` for the built-in cards; `false` for cards contributed by the registry. */
  builtin: boolean;
  /** Which importer surface this card belongs to (Projects / Catalog / both). */
  scope: ImportSourceScope;
}

/**
 * The built-in source cards — the grid exactly as it shipped before MFI-1.3. Order is preserved so
 * the existing layout is unchanged. Each built-in's `key` doubles as the `selectedSource` id the
 * dialog already branches on, so wiring is unchanged.
 */
const BASE_CARDS: ReadonlyArray<ImportSourceCard> = [
  // Generic intake methods auto-detect the format, so they belong to both importer surfaces.
  { key: 'file', label: 'File Upload', description: 'Drop files or click to browse', icon: Upload, panel: 'file', builtin: true, scope: 'both' },
  { key: 'url', label: 'URL Import', description: 'Fetch from URL or repository', icon: Link2, panel: 'url', builtin: true, scope: 'both' },
  { key: 'clipboard', label: 'Clipboard Paste', description: 'Paste JSON or YAML content', icon: FileText, panel: 'clipboard', builtin: true, scope: 'both' },
  { key: 'git', label: 'Git Repository', description: 'Import from GitHub/GitLab', icon: Github, panel: 'git', builtin: true, scope: 'both' },
  // SwaggerHub only serves OpenAPI/Swagger, so it stays on the Projects importer.
  { key: 'swaggerhub', label: 'SwaggerHub', description: 'Import from SwaggerHub', icon: Cloud, panel: 'swaggerhub', builtin: true, scope: 'native' },
  // Postman collections and MCP discovery are alternative (non-OpenAPI) formats → Catalog importer.
  { key: 'postman', label: 'Postman Collection', description: 'Import from Postman v2.1', icon: FileJson, panel: 'postman', builtin: true, scope: 'alternative' },
  { key: 'mcp', label: 'MCP Server', description: 'Discover an MCP endpoint', icon: Network, panel: 'mcp', builtin: true, scope: 'alternative' },
];

/**
 * Registry keys whose import is already handled by a built-in card, so they must NOT produce a
 * second (duplicate) card:
 *  - `openapi` is consumed through the generic File / URL / Clipboard intake (auto-detected).
 *  - `sample` is the internal no-op acceptance adapter, never a user-facing source.
 */
export const REGISTRY_KEYS_COVERED_BY_BUILTINS: ReadonlySet<string> = new Set(['openapi', 'sample']);

/**
 * Resolve a Lucide icon name (kebab-case, e.g. `"file-json"`) to its component, falling back to a
 * neutral file icon when the name is unknown — so an unrecognized icon never breaks a card.
 */
export function resolveLucideIcon(name: string | undefined | null): LucideIcon {
  if (!name) return FileCode;
  const pascal = String(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const candidate = (LucideIcons as unknown as Record<string, unknown>)[pascal];
  if (typeof candidate === 'function' || (typeof candidate === 'object' && candidate !== null)) {
    return candidate as LucideIcon;
  }
  return FileCode;
}

/**
 * Pick the generic intake panel for an adapter from its declared `input_kinds`, preferring a
 * file upload, then a URL, then a paste box. A discovery-only adapter has no generic panel yet
 * (MCP's discovery flow is bespoke), so it returns `null` and the card renders disabled.
 */
export function panelForInputKinds(kinds: ReadonlyArray<string> | undefined | null): ImportPanelId | null {
  const set = new Set(kinds ?? []);
  if (set.has('file')) return 'file';
  if (set.has('url')) return 'url';
  if (set.has('paste')) return 'clipboard';
  return null;
}

/**
 * Merge the built-in cards with the registry descriptors.
 *
 * Built-ins always come first and unchanged. A descriptor becomes an appended card unless its key
 * is already a built-in or is covered by a built-in ({@link REGISTRY_KEYS_COVERED_BY_BUILTINS}).
 * Appended cards are de-duplicated and sorted by key for a stable layout.
 *
 * @param descriptors The registry list from `GET /api/import/sources` (may be empty/undefined).
 * @returns The cards to render, built-ins followed by registry-contributed cards.
 */
export function mergeImportSourceCards(
  descriptors: ReadonlyArray<ImportSourceDescriptor> | undefined | null,
): ImportSourceCard[] {
  const baseKeys = new Set(BASE_CARDS.map((card) => card.key));
  const appended: ImportSourceCard[] = [];
  const seen = new Set<string>();

  for (const descriptor of descriptors ?? []) {
    if (!descriptor || typeof descriptor.key !== 'string' || descriptor.key.length === 0) continue;
    if (baseKeys.has(descriptor.key)) continue;
    if (REGISTRY_KEYS_COVERED_BY_BUILTINS.has(descriptor.key)) continue;
    if (seen.has(descriptor.key)) continue;
    seen.add(descriptor.key);
    appended.push({
      key: descriptor.key,
      label: descriptor.label,
      description: descriptor.description,
      icon: resolveLucideIcon(descriptor.icon),
      panel: panelForInputKinds(descriptor.input_kinds),
      builtin: false,
      // Every registry-contributed adapter is a non-OpenAPI (alternative) format → Catalog importer.
      scope: 'alternative',
    });
  }

  appended.sort((a, b) => a.key.localeCompare(b.key));
  return [...BASE_CARDS, ...appended];
}

/** The built-in cards on their own — the fallback rendered before/without the registry list. */
export function baseImportSourceCards(): ImportSourceCard[] {
  return BASE_CARDS.map((card) => ({ ...card }));
}

/**
 * The base intake methods the catalog import stepper offers (MFI-26.1, §0.3 routing policy;
 * `git` added by MFI-29.3).
 *
 * `paste` is the source-method id the {@link ../catalog/CatalogImportDialog} branches on; it is
 * backed by the `clipboard` source card. `git` selects a repository path or glob at a ref and
 * imports it as a multi-file selection, so every registry adapter — not just the OpenAPI family —
 * can be imported straight from a repository.
 */
export type BaseIntakeMethod = 'file' | 'url' | 'paste' | 'git';

/** A base intake tile: the source-method id the dialog uses, plus the card it renders from. */
export interface BaseIntakeTile {
  method: BaseIntakeMethod;
  card: ImportSourceCard;
}

/**
 * The base intake methods, in the fixed order the stepper renders them, paired with the source-card
 * key each is backed by. Per §0.3 (and MFI-26.6), the catalog import source panel offers ONLY these
 * base methods — never a per-format, live-discovery, or registry-contributed tile.
 */
const BASE_INTAKE_METHODS: ReadonlyArray<{ key: string; method: BaseIntakeMethod }> = [
  { key: 'file', method: 'file' },
  { key: 'url', method: 'url' },
  { key: 'clipboard', method: 'paste' },
  { key: 'git', method: 'git' },
];

/**
 * Resolve the catalog importer's source tiles — File Upload / URL Import / Clipboard paste /
 * Git Repository — in a fixed order, from the loaded source cards (MFI-26.1, #4094; MFI-29.3).
 *
 * The grid is data-driven: each tile carries the label / description / icon reported by
 * `GET /v1/import/sources` (via the built-in fallback cards when the registry is unreachable), so it
 * reflects the registry instead of being hard-coded. It is intentionally restricted to the base
 * intake methods, so no reflection / introspection / schema-registry / registry-contributed tiles
 * ever appear — enforcing the §0.3 import-routing policy at the UI.
 *
 * @param cards The merged source cards from {@link ../useImportSources}.
 * @returns One tile per base intake method whose backing card is present, in fixed order.
 */
export function baseIntakeTiles(cards: ReadonlyArray<ImportSourceCard>): BaseIntakeTile[] {
  const byKey = new Map(cards.map((card) => [card.key, card] as const));
  const tiles: BaseIntakeTile[] = [];
  for (const { key, method } of BASE_INTAKE_METHODS) {
    const card = byKey.get(key);
    if (card) tiles.push({ method, card });
  }
  return tiles;
}

/**
 * Restrict a card list to the importer surface being rendered (MFI-23.12).
 *
 * The Projects importer keeps only the native (OpenAPI/Swagger) intake, the Catalog importer keeps
 * only the alternative (non-OpenAPI) formats, and `both`-scoped generic intake (File/URL/Clipboard/
 * Git) shows on either. `variant: 'all'` is the pass-through used where no split applies.
 *
 * @param cards The merged card list.
 * @param variant Which surface the grid is for.
 * @returns The subset of cards to render for that surface (order preserved).
 */
export function filterCardsForVariant(
  cards: ReadonlyArray<ImportSourceCard>,
  variant: ImportVariant,
): ImportSourceCard[] {
  if (variant === 'all') return cards.map((card) => ({ ...card }));
  const wanted: ImportSourceScope = variant === 'projects' ? 'native' : 'alternative';
  return cards.filter((card) => card.scope === wanted || card.scope === 'both').map((card) => ({ ...card }));
}
