/**
 * Verify configuration keys + the per-session verify result cache (MFX-42.6, #4359).
 *
 * A verify run is real compute (MFX-42.5 emits the artifact for real, it just never stores it), so
 * two things must hold while a user iterates on options:
 *
 * 1. **A verdict never outlives its configuration.** Every result is filed under a stable key
 *    derived from the whole configuration — source fingerprint (artifact + version), target, and
 *    the non-default options — so the Studio can compare the key a displayed verdict belongs to
 *    with the key of what is on screen. A mismatch means "no verdict yet", which re-locks Generate.
 * 2. **Re-entering a configuration is free.** Results are cached under the same key for the
 *    session, so stepping target A → B → A shows A's verdict instantly instead of re-paying the
 *    verify latency.
 *
 * Everything here is pure (no React, no fetch) so it unit-tests directly; `useExportVerify` is the
 * only consumer that wires it to state.
 */

import type { ExportVerifyResponse } from './exportVerify';

/** The coordinates that make one verify result what it is. */
export interface VerifyConfig {
  /** The artifact (project / catalog-item) id being exported. */
  artifact: string;
  /** The revision selector (UUID or label); null/undefined means the latest revision. */
  version?: string | null;
  /** The chosen target emitter key; null when no target is selected yet. */
  target: string | null;
  /** The non-default option overrides sent with the verification; null when all defaults. */
  options?: Record<string, unknown> | null;
}

/**
 * Serialise a value deterministically: object keys are emitted in sorted order at every depth, so
 * two option maps that differ only in key order produce one string. Arrays keep their order (an
 * option list's order is meaningful to the emitter).
 *
 * @param value The value to serialise.
 * @returns A stable JSON string for the value.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

/**
 * The cache/identity key for one verify configuration (MFX-42.6).
 *
 * The key is order-insensitive over the options map and treats an empty override map exactly like
 * "no overrides" — the two describe the same emit, so they must share one cached verdict.
 *
 * @param config The source, target, and option coordinates.
 * @returns The stable key, or null when the configuration cannot be verified (no artifact/target).
 */
export function verifyConfigKey(config: VerifyConfig): string | null {
  if (!config.artifact || !config.target) return null;
  const options = config.options && Object.keys(config.options).length > 0 ? config.options : null;
  return stableStringify({
    artifact: config.artifact,
    version: config.version ?? null,
    target: config.target,
    options,
  });
}

/** How many option overrides {@link describeVerifyConfig} names before it summarises the rest. */
const DESCRIBED_OPTION_LIMIT = 3;

/**
 * Render one option override as `key = value` for the configuration summary. Values are shown as
 * their JSON form so `null`, `""`, and `"null"` stay distinguishable, and long values are clipped.
 */
function describeOption(key: string, value: unknown): string {
  const rendered = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
  const clipped = rendered.length > 24 ? `${rendered.slice(0, 23)}…` : rendered;
  return `${key} = ${clipped}`;
}

/**
 * A human, one-line description of the configuration a verdict belongs to (MFX-42.6 acceptance:
 * "show which config a displayed verdict belongs to") — e.g.
 * `gRPC / Protobuf · package = com.example, emit_services = false`, or
 * `OpenAPI 3.1 · default options` when nothing is overridden.
 *
 * @param input.targetLabel The chosen target's human label.
 * @param input.options The non-default option overrides, or null when all defaults.
 * @returns The single-line summary.
 */
export function describeVerifyConfig(input: {
  targetLabel: string;
  options?: Record<string, unknown> | null;
}): string {
  const entries = Object.entries(input.options ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return `${input.targetLabel} · default options`;
  const shown = entries
    .slice(0, DESCRIBED_OPTION_LIMIT)
    .map(([key, value]) => describeOption(key, value));
  const hidden = entries.length - shown.length;
  const suffix = hidden > 0 ? `, +${hidden} more` : '';
  return `${input.targetLabel} · ${shown.join(', ')}${suffix}`;
}

/** How many verify results one session cache holds before the oldest entries are evicted. */
export const VERIFY_CACHE_LIMIT = 24;

/**
 * How long a cached verify result stays servable. A verification describes an emit of *this*
 * revision, and a `latest`-scoped configuration can silently move to a new revision under the
 * user, so entries expire rather than living for the whole session.
 */
export const VERIFY_CACHE_TTL_MS = 5 * 60_000;

/** A bounded, expiring store of verify results keyed by {@link verifyConfigKey}. */
export interface VerifyResultCache<T> {
  /** The cached value for a key, or null when absent or expired. Never mutates the cache. */
  get(key: string | null, now?: number): T | null;
  /** Store a value for a key, pruning expired entries and evicting the oldest over the limit. */
  set(key: string, value: T, now?: number): void;
  /** Forget one key (an explicit invalidation — the next run must re-fetch). */
  delete(key: string | null): void;
  /** Forget everything. */
  clear(): void;
  /** How many entries are currently held (including any not yet pruned expired ones). */
  readonly size: number;
}

/**
 * Create a verify result cache (MFX-42.6).
 *
 * Insertion-ordered with a hard entry limit and a per-entry TTL: {@link VerifyResultCache.get} is a
 * pure lookup (safe to call while rendering — it never re-orders or deletes), and the pruning of
 * expired/overflowing entries happens on write.
 *
 * @param limit Maximum entries retained; the oldest inserted are evicted first.
 * @param ttlMs How long an entry stays servable after it is stored.
 * @returns The cache.
 */
export function createVerifyResultCache<T>(
  limit: number = VERIFY_CACHE_LIMIT,
  ttlMs: number = VERIFY_CACHE_TTL_MS,
): VerifyResultCache<T> {
  const entries = new Map<string, { value: T; storedAt: number }>();

  const prune = (now: number) => {
    for (const [key, entry] of entries) {
      if (now - entry.storedAt >= ttlMs) entries.delete(key);
    }
    while (entries.size > limit) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  return {
    get(key, now = Date.now()) {
      if (!key) return null;
      const entry = entries.get(key);
      if (!entry) return null;
      if (now - entry.storedAt >= ttlMs) return null;
      return entry.value;
    },
    set(key, value, now = Date.now()) {
      // Re-insert so a refreshed key counts as the newest entry for eviction.
      entries.delete(key);
      entries.set(key, { value, storedAt: now });
      prune(now);
    },
    delete(key) {
      if (key) entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/** The browser-side store behind {@link sessionVerifyCache}. */
const browserVerifyCache = createVerifyResultCache<ExportVerifyResponse>();

/** A cache that holds nothing — see {@link sessionVerifyCache} for why the server gets one. */
const inertVerifyCache: VerifyResultCache<ExportVerifyResponse> = {
  get: () => null,
  set: () => undefined,
  delete: () => undefined,
  clear: () => undefined,
  get size() {
    return 0;
  },
};

/**
 * The per-browser-session verify cache the Studio uses. It is module-level on purpose: leaving the
 * Studio and coming back to the same source/target/options should still be instant, which a cache
 * tied to a component instance could not do. It is memory-only — verify results describe a
 * customer's API surface, so they are never written to storage that outlives the tab.
 *
 * On the server it is inert. This module only ever runs in a client component, but Next.js also
 * executes client components on the server for the initial render, where a single module instance
 * would be shared by every request — and therefore by every tenant. Nothing writes to it during a
 * server render today (runs are triggered from effects and event handlers); the inert instance
 * makes that a property of the module rather than a coincidence.
 */
export const sessionVerifyCache: VerifyResultCache<ExportVerifyResponse> =
  typeof window === 'undefined' ? inertVerifyCache : browserVerifyCache;

/** Empty the session cache — for tests, which must not inherit another test's cached verdicts. */
export function __resetVerifyCacheForTests(): void {
  browserVerifyCache.clear();
}
