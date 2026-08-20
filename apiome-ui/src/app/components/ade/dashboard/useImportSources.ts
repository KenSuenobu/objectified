'use client';

import { useEffect, useState } from 'react';
import {
  baseImportSourceCards,
  mergeImportFileExtensions,
  mergeImportSourceCards,
  filterCardsForVariant,
  type ImportSourceCard,
  type ImportSourceDescriptor,
  type ImportVariant,
} from './importSourceCatalog';

export interface UseImportSourcesResult {
  /** Cards to render: built-ins, plus any registry-contributed cards once loaded. */
  cards: ImportSourceCard[];
  loading: boolean;
  /** Non-fatal load error; the built-in cards are still rendered when this is set. */
  error: string | null;
  /**
   * The file picker `accept` list, unioned across **every** registered adapter (FMT-1.1, #5412).
   *
   * Deliberately not filtered by `variant`: both importers offer the full set, because which
   * adapter claims a file is settled by content sniffing after it is picked, not by the picker.
   * Falls back to the offline ten-entry list until the registry resolves, and stays there if the
   * fetch fails.
   */
  fileExtensions: string[];
}

/**
 * Load the import-source cards for the dialog (MFI-1.3, #3735).
 *
 * Starts from the built-in cards so the grid renders instantly, then fetches
 * `GET /api/import/sources` and merges in any server-registered adapters. A fetch failure is
 * non-fatal: the built-in cards remain, so the dialog keeps working if the registry is unreachable.
 *
 * Also derives the file pickers' `accept` list from the same fetch (FMT-1.1, #5412), so registering
 * an adapter server-side makes its format browsable with no UI change.
 *
 * @param enabled Only fetch while truthy (e.g. while the dialog is open).
 * @param variant Which importer surface to render for (MFI-23.12): `projects` keeps the native
 *   OpenAPI/Swagger intake, `catalog` keeps the alternative (non-OpenAPI) formats, `all` (default)
 *   shows every card unchanged.
 */
export function useImportSources(
  enabled: boolean,
  variant: ImportVariant = 'all',
): UseImportSourcesResult {
  const [cards, setCards] = useState<ImportSourceCard[]>(() =>
    filterCardsForVariant(baseImportSourceCards(), variant),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seeded with the offline fallback so a picker is usable on first paint, then replaced wholesale
  // by the registry union below.
  const [fileExtensions, setFileExtensions] = useState<string[]>(() =>
    mergeImportFileExtensions(null),
  );

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    // All state mutations live inside this async helper (not the effect body) so we never call
    // setState synchronously during the effect — which would trigger cascading renders.
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/import/sources', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data?.error === 'string' ? data.error : 'Could not load import sources.');
        }
        if (cancelled) return;
        const sources = (data as { sources?: ImportSourceDescriptor[] }).sources;
        setCards(filterCardsForVariant(mergeImportSourceCards(sources), variant));
        setFileExtensions(mergeImportFileExtensions(sources));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load import sources.');
        setCards(filterCardsForVariant(baseImportSourceCards(), variant));
        // The picker keeps the offline fallback rather than emptying out: an unreachable registry
        // must not make every file unbrowsable.
        setFileExtensions(mergeImportFileExtensions(null));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [enabled, variant]);

  return { cards, loading, error, fileExtensions };
}
