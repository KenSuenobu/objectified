/**
 * Partition the catalog format gallery from the import-source registry (FMT-1.2, #5413).
 *
 * The gallery used to split its formats on a hard-coded `importable` flag in
 * `catalog-format-registry.ts`. That made a third source of truth — beside the server registry and
 * the guide docs — with nothing keeping the three aligned: registering an adapter server-side left
 * the gallery still calling its format "recognized, not yet importable", and retiring one left the
 * gallery promising an import that would fail.
 *
 * The registry answers the question directly. `GET /api/import/sources` lists every adapter that
 * exists, so membership comes from there and the local registry keeps only what it is actually good
 * at: the icon, the fixed identity hue (HIVE-2.4) and the one-line description.
 *
 * This module is pure — no React, no fetch — so the partition can be unit-tested against a fixture
 * payload rather than a rendered component.
 */

import {
  ALTERNATIVE_CATALOG_FORMATS,
  type CatalogFormat,
} from './catalog-format-registry';
import { catalogAdapterForFormat } from './catalog-import-formats';

/** The gallery's two groups. */
export interface CatalogFormatSupport {
  /** Formats a registered adapter can import today. */
  importable: CatalogFormat[];
  /** Formats the UI recognizes and can label, but which no registered adapter imports yet. */
  recognized: CatalogFormat[];
  /**
   * Whether the split came from the registry (`true`) or from the local fallback flag (`false`).
   * The gallery uses this only to avoid claiming registry authority it does not have.
   */
  fromRegistry: boolean;
}

/**
 * The registry key a gallery entry would be imported under, or `null` when none is mapped.
 *
 * Reuses {@link catalogAdapterForFormat} — the same map the catalog importer routes through — so
 * the gallery and the importer cannot disagree about which adapter backs a format.
 *
 * @param fmt The gallery entry.
 * @returns The REST import-source key, or `null` when the UI knows the format but no adapter is
 *   mapped to it.
 */
export function registryKeyForCatalogFormat(fmt: CatalogFormat): string | null {
  return catalogAdapterForFormat(fmt.id)?.sourceKind ?? null;
}

/**
 * Split the gallery's formats into importable / recognized using the registry's key set.
 *
 * A format is **importable** when its mapped adapter key is present in the registry response. An
 * unavailable adapter (`available: false`, e.g. gRPC with no `buf`) still counts as importable:
 * the format *is* supported, this deployment merely cannot run it, and the gallery dims it with a
 * reason rather than demoting it to "not yet importable" — which would be a different, and false,
 * statement about the product.
 *
 * @param registryKeys Keys from `GET /api/import/sources`, or `null`/empty when the registry has
 *   not resolved. In that case the local `importable` flag is used as an offline fallback so the
 *   gallery still renders something honest rather than emptying out.
 * @param formats The gallery entries to partition; defaults to every alternative (non-OpenAPI)
 *   format.
 * @returns The two groups, each in the source registry's declared order, plus whether the split is
 *   registry-derived.
 */
export function partitionCatalogFormats(
  registryKeys: ReadonlySet<string> | null | undefined,
  formats: readonly CatalogFormat[] = ALTERNATIVE_CATALOG_FORMATS,
): CatalogFormatSupport {
  const fromRegistry = Boolean(registryKeys && registryKeys.size > 0);

  const isImportable = (fmt: CatalogFormat): boolean => {
    if (!fromRegistry) return Boolean(fmt.importable);
    const key = registryKeyForCatalogFormat(fmt);
    return key !== null && registryKeys!.has(key);
  };

  const importable: CatalogFormat[] = [];
  const recognized: CatalogFormat[] = [];
  for (const fmt of formats) {
    (isImportable(fmt) ? importable : recognized).push(fmt);
  }

  return { importable, recognized, fromRegistry };
}
