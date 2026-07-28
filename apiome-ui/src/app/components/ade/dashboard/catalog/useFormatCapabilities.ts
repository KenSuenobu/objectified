'use client';

import { useEffect, useState } from 'react';
import {
  validateFormatCapabilitySnapshot,
  type FormatCapabilitySnapshot,
} from './formatCapabilityRegistry';

/** What the hook exposes: the loaded snapshot plus its registry identity. */
export interface UseFormatCapabilitiesResult {
  /** The validated registry snapshot, or null while loading / after a failure. */
  snapshot: FormatCapabilitySnapshot | null;
  /** The registry contract version, when loaded. */
  registryVersion: string | null;
  /** When the registry's seeds/explanations were last reviewed, when loaded. */
  reviewDate: string | null;
}

/**
 * The registry is static reference data (the same for every tenant and every catalog item), so one
 * fetch per page load is shared by every consumer via this module-level cache. `null` records a
 * settled failure — consumers degrade to registry-less rendering; a page reload retries.
 */
let cachedSnapshot: FormatCapabilitySnapshot | null = null;
let pendingFetch: Promise<FormatCapabilitySnapshot | null> | null = null;

/** Reset the module cache — test hook only. */
export function resetFormatCapabilitiesCache(): void {
  cachedSnapshot = null;
  pendingFetch = null;
}

/** Fetch + contract-validate the registry snapshot; null on any failure or contract issue. */
async function fetchSnapshot(): Promise<FormatCapabilitySnapshot | null> {
  try {
    const res = await fetch('/api/import/format-capabilities', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) return null;
    const snapshot = data as FormatCapabilitySnapshot;
    if (!Array.isArray(snapshot.absences) || !Array.isArray(snapshot.formats)) return null;
    // An untrustworthy registry — an unknown category, or one that claims the source is missing
    // when it is not — is refused whole. Rendering nothing is honest; rendering a bad
    // "source not captured" line about a parser limit is not.
    if (validateFormatCapabilitySnapshot(snapshot).length > 0) return null;
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * Load the source-format capability & parsing-limit registry (CPDO-2.4, #4796).
 *
 * The catalog's format-detail surfaces explain a missing construct from
 * `GET /api/import/format-capabilities`: what the format's analyzer models, what it knowingly does
 * not, and the reviewed wording for each way a detail can be absent. The registry is
 * version-static reference data, so the fetch happens once per page load and is shared by every
 * consumer through a module cache. The result is contract-validated before it is trusted; a failed
 * fetch or an invalid snapshot yields `null` and the caller degrades gracefully — the registry is
 * explanatory, never a gate.
 *
 * @param enabled Only fetch while truthy (e.g. while the format-detail surface is showing).
 */
export function useFormatCapabilities(enabled: boolean): UseFormatCapabilitiesResult {
  const [snapshot, setSnapshot] = useState<FormatCapabilitySnapshot | null>(cachedSnapshot);

  useEffect(() => {
    if (!enabled || cachedSnapshot) return;
    let cancelled = false;
    pendingFetch ??= fetchSnapshot().then((result) => {
      cachedSnapshot = result;
      return result;
    });
    void pendingFetch.then((result) => {
      if (!cancelled && result) setSnapshot(result);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return {
    snapshot,
    registryVersion: snapshot?.version ?? null,
    reviewDate: snapshot?.review_date ?? null,
  };
}
