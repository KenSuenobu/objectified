/**
 * Persisted view preferences for the Catalog dashboard list (MFI-28.4, #4120).
 *
 * The Catalog toolbar lets you choose a view mode (cards/table), a card grouping (protocol/none),
 * a sort column + direction, and whether soft-deleted items are shown. Before this ticket none of
 * those choices survived a reload. This module is the single, data-driven persistence layer behind
 * the toolbar: a validated, versioned localStorage blob plus pure parse/serialize helpers so the
 * page stays presentational and the round-trip can be unit-tested without a browser.
 *
 * Every field is validated on read against its known value set, so a hand-edited, stale, or
 * partially-written blob degrades to the per-field default instead of poisoning the UI with an
 * impossible state. All the localStorage access is SSR-safe (guarded on `window`) and never throws:
 * a blocked or full storage silently no-ops rather than crashing the render.
 */

import type {
  CatalogDashboardSortColumn,
  CatalogDashboardSortDirection,
} from './catalog-dashboard-sort';

/** How the card view is sectioned (MFI-24.2): by paradigm, or a single flat grid. */
export const CATALOG_GROUP_MODES = ['protocol', 'none'] as const;
export type CatalogGroupMode = (typeof CATALOG_GROUP_MODES)[number];

/** The two list layouts the Catalog offers. */
export const CATALOG_VIEW_MODES = ['cards', 'table'] as const;
export type CatalogViewMode = (typeof CATALOG_VIEW_MODES)[number];

/**
 * The sort columns the Catalog screen can actually select: the toolbar's six (MFI-23.3) plus the
 * ones reachable only by clicking a table column header — protocol, source, and status. The
 * underlying sorter ({@link CatalogDashboardSortColumn}) understands more columns still, so a
 * persisted value outside this set is treated as invalid and reset to the default.
 */
export const CATALOG_SELECTABLE_SORT_COLUMNS = [
  'name',
  'created',
  'updated',
  'quality',
  'grade',
  'format',
  'protocol',
  'source',
  'status',
] as const satisfies readonly CatalogDashboardSortColumn[];

export const CATALOG_SORT_DIRECTIONS = ['asc', 'desc'] as const satisfies readonly CatalogDashboardSortDirection[];

/** The full set of user-persisted Catalog list preferences. */
export interface CatalogViewPreferences {
  viewMode: CatalogViewMode;
  groupMode: CatalogGroupMode;
  sortColumn: CatalogDashboardSortColumn;
  sortDirection: CatalogDashboardSortDirection;
  showDeleted: boolean;
}

/** The values applied on a first visit, or whenever a stored preference is missing/invalid. */
export const DEFAULT_CATALOG_VIEW_PREFERENCES: CatalogViewPreferences = {
  viewMode: 'cards',
  groupMode: 'protocol',
  sortColumn: 'name',
  sortDirection: 'asc',
  showDeleted: false,
};

/**
 * The localStorage key. Versioned (`.v1`) so a future breaking change to the shape can bump the
 * suffix and cleanly ignore the old blob rather than mis-parsing it.
 */
export const CATALOG_VIEW_PREFS_STORAGE_KEY = 'apiome.catalog.view-preferences.v1';

/** Narrow an arbitrary value to a member of a readonly string tuple. */
function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Coerce an arbitrary parsed object into a fully-valid {@link CatalogViewPreferences}, filling any
 * missing or invalid field from {@link DEFAULT_CATALOG_VIEW_PREFERENCES}. Pure and total — it never
 * throws and always returns a complete, usable preferences object.
 *
 * @param value Any value (typically the result of `JSON.parse` on the stored blob).
 * @returns A validated preferences object with every field guaranteed to be a legal value.
 */
export function coerceCatalogViewPreferences(value: unknown): CatalogViewPreferences {
  const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    viewMode: pickEnum(obj.viewMode, CATALOG_VIEW_MODES, DEFAULT_CATALOG_VIEW_PREFERENCES.viewMode),
    groupMode: pickEnum(obj.groupMode, CATALOG_GROUP_MODES, DEFAULT_CATALOG_VIEW_PREFERENCES.groupMode),
    sortColumn: pickEnum(
      obj.sortColumn,
      CATALOG_SELECTABLE_SORT_COLUMNS,
      DEFAULT_CATALOG_VIEW_PREFERENCES.sortColumn,
    ),
    sortDirection: pickEnum(
      obj.sortDirection,
      CATALOG_SORT_DIRECTIONS,
      DEFAULT_CATALOG_VIEW_PREFERENCES.sortDirection,
    ),
    showDeleted:
      typeof obj.showDeleted === 'boolean'
        ? obj.showDeleted
        : DEFAULT_CATALOG_VIEW_PREFERENCES.showDeleted,
  };
}

/**
 * Parse a raw stored string into validated preferences. A `null`, empty, or malformed string
 * resolves to the defaults, so a corrupt blob is self-healing rather than fatal.
 *
 * @param raw The raw localStorage string (or `null` when absent).
 * @returns Validated preferences.
 */
export function parseCatalogViewPreferences(raw: string | null | undefined): CatalogViewPreferences {
  if (!raw) return { ...DEFAULT_CATALOG_VIEW_PREFERENCES };
  try {
    return coerceCatalogViewPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CATALOG_VIEW_PREFERENCES };
  }
}

/** Serialize preferences for storage. */
export function serializeCatalogViewPreferences(prefs: CatalogViewPreferences): string {
  return JSON.stringify(prefs);
}

/**
 * Read the persisted Catalog view preferences from localStorage. SSR-safe: returns the defaults
 * when there is no `window` (server render) and never throws on a blocked/unavailable storage.
 *
 * @returns The stored preferences, or the defaults on the server / first visit / read error.
 */
export function loadCatalogViewPreferences(): CatalogViewPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_CATALOG_VIEW_PREFERENCES };
  try {
    return parseCatalogViewPreferences(window.localStorage.getItem(CATALOG_VIEW_PREFS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_CATALOG_VIEW_PREFERENCES };
  }
}

/**
 * Persist the Catalog view preferences to localStorage. SSR-safe and non-throwing: a missing
 * `window` or a full/blocked storage silently no-ops.
 *
 * @param prefs The preferences to store.
 */
export function persistCatalogViewPreferences(prefs: CatalogViewPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CATALOG_VIEW_PREFS_STORAGE_KEY,
      serializeCatalogViewPreferences(prefs),
    );
  } catch {
    /* storage unavailable (private mode / quota) — preferences just won't persist */
  }
}
