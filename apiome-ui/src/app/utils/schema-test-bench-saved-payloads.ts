/**
 * Browser-local saved payloads for the Schema Test Bench (IXH-5.3, #5115).
 *
 * A saved payload is scoped to **tenant + schema reference**: the storage key carries both, so
 * switching tenants (or schemas) never shows another scope's payloads, and clearing one
 * schema's list leaves the rest untouched. Follows the established browser-local store shape
 * (`git-import-saved-repos.ts`): a versioned prefix, a bounded list, and a validating reader
 * that drops rows it does not recognize instead of crashing on them.
 */

const STORAGE_PREFIX = 'apiome:schema-test-bench:';

/** The most payloads kept per (tenant, schema); older entries fall off the end. */
export const MAX_SAVED_PAYLOADS_PER_SCHEMA = 20;

/** One saved payload. */
export interface SavedBenchPayload {
  /** Stable id (random at save time). */
  id: string;
  /** User-given name. */
  name: string;
  /** The payload text exactly as the editor held it. */
  payloadText: string;
  /** Whether the payload came from the IXH-5.2 generator (the label survives saving). */
  synthetic: boolean;
  /** Save timestamp (epoch ms). */
  savedAt: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Runtime validator for one stored row. */
export function isSavedBenchPayload(v: unknown): v is SavedBenchPayload {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.payloadText === 'string' &&
    typeof v.synthetic === 'boolean' &&
    typeof v.savedAt === 'number' &&
    Number.isFinite(v.savedAt)
  );
}

/** The storage key for one (tenant, schema reference) scope. */
export function savedBenchPayloadsStorageKey(tenantId: string, schemaRef: string): string {
  return `${STORAGE_PREFIX}${tenantId}:${schemaRef}`;
}

/** Read the saved payloads for a scope, newest first. Unrecognized rows are dropped. */
export function loadSavedBenchPayloads(tenantId: string, schemaRef: string): SavedBenchPayload[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(savedBenchPayloadsStorageKey(tenantId, schemaRef));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedBenchPayload).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/**
 * Save a payload into a scope, replacing any same-name entry and enforcing the cap.
 *
 * @returns The updated list (newest first), or the unchanged list when storage is unavailable.
 */
export function saveBenchPayload(
  tenantId: string,
  schemaRef: string,
  payload: SavedBenchPayload
): SavedBenchPayload[] {
  const existing = loadSavedBenchPayloads(tenantId, schemaRef);
  const next = [payload, ...existing.filter((p) => p.name !== payload.name)].slice(
    0,
    MAX_SAVED_PAYLOADS_PER_SCHEMA
  );
  try {
    window.localStorage.setItem(
      savedBenchPayloadsStorageKey(tenantId, schemaRef),
      JSON.stringify(next)
    );
  } catch {
    // Quota/unavailable storage: the in-memory list is still correct for this session.
  }
  return next;
}

/** Delete one saved payload by id. @returns The updated list (newest first). */
export function deleteBenchPayload(
  tenantId: string,
  schemaRef: string,
  id: string
): SavedBenchPayload[] {
  const next = loadSavedBenchPayloads(tenantId, schemaRef).filter((p) => p.id !== id);
  try {
    window.localStorage.setItem(
      savedBenchPayloadsStorageKey(tenantId, schemaRef),
      JSON.stringify(next)
    );
  } catch {
    // Quota/unavailable storage: the in-memory list is still correct for this session.
  }
  return next;
}
