'use client';

/**
 * `useCatalogImportAvailability` (MFI-5.2) — runtime availability of catalog import sources.
 *
 * The catalog store-raw importer runs the REST adapter pipeline, and some adapters hard-require a
 * bundled toolchain that may be absent in a given runtime (e.g. gRPC/Protobuf needs `buf`). The
 * import-source registry (`GET /api/import/sources`) now reports each adapter's `available` flag, so
 * the importer can disable an unavailable source and the gallery can flag it — instead of letting an
 * import fail at parse.
 *
 * This fetches the registry (only while `enabled`) and exposes a lookup by `source_kind`, plus the
 * full set of registered keys — which is what the supported-formats gallery partitions on (FMT-1.2,
 * #5413), so the gallery stops keeping its own list of which formats are importable.
 */

import { useEffect, useState } from 'react';
import type { ImportSourceDescriptor } from '../importSourceCatalog';

export interface CatalogImportAvailability {
  /** `true` once the registry has been fetched (availability is authoritative). */
  loaded: boolean;
  /**
   * Whether the adapter for a `source_kind` can run here. Unknown keys and a not-yet-loaded registry
   * default to `true` (optimistic) so nothing is spuriously hidden before/without the fetch.
   */
  isAvailable: (sourceKind: string) => boolean;
  /** The reason a `source_kind` is unavailable, or `null`. */
  reasonFor: (sourceKind: string) => string | null;
  /**
   * Every adapter key the registry reports (FMT-1.2, #5413) — empty until the fetch resolves.
   *
   * Membership here is what decides whether a format is importable at all, which is a different
   * question from {@link isAvailable}: a registered adapter whose toolchain is missing is still a
   * supported format, and must be dimmed with a reason rather than demoted to "not yet importable".
   */
  registeredKeys: ReadonlySet<string>;
}

export function useCatalogImportAvailability(enabled: boolean): CatalogImportAvailability {
  const [byKind, setByKind] = useState<Record<string, { available: boolean; reason: string | null }>>({});
  const [registeredKeys, setRegisteredKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/import/sources', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (cancelled || !res.ok) return;
        const sources = (data as { sources?: ImportSourceDescriptor[] }).sources ?? [];
        const map: Record<string, { available: boolean; reason: string | null }> = {};
        for (const s of sources) {
          if (!s || typeof s.key !== 'string') continue;
          map[s.key] = { available: s.available !== false, reason: s.unavailable_reason ?? null };
        }
        setByKind(map);
        setRegisteredKeys(new Set(Object.keys(map)));
        setLoaded(true);
      } catch {
        // Non-fatal: leave availability optimistic (everything importable) if the registry is unreachable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return {
    loaded,
    isAvailable: (sourceKind: string) => byKind[sourceKind]?.available ?? true,
    reasonFor: (sourceKind: string) => byKind[sourceKind]?.reason ?? null,
    registeredKeys,
  };
}
