/**
 * conversion-provenance — wire contract + helpers for the evidence history (CPDO-3.3, #4803).
 *
 * Pins the three fetchers' URLs and failure modes (server error message, the explicit
 * snapshot-unavailable degrade shape, the expected-hash refusal), and the pure helpers that
 * decide a row's trust presentation: `hasStoredSnapshot` guards the pre-migration empty state
 * twice over, `sourceChangedSince` only ever claims a change when both digests are known, and
 * every class-map helper pairs a `dark:` variant.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  ConversionSnapshotUnavailableError,
  fetchCatalogConversionHistory,
  fetchConversionEvidenceSnapshotPage,
  fetchProjectConversionHistory,
  hasStoredSnapshot,
  makeStoredEvidenceSource,
  snapshotChipClass,
  snapshotHashShort,
  snapshotMissingChipClass,
  sourceChangedBadgeClass,
  sourceChangedSince,
  type ConversionProvenanceRow,
} from '../src/app/utils/conversion-provenance';

const HASH = 'a'.repeat(64);

function row(overrides: Partial<ConversionProvenanceRow> = {}): ConversionProvenanceRow {
  return {
    provenanceId: 'prov-1',
    createdAt: '2026-07-01T00:00:00Z',
    createdBy: 'user-1',
    reconverted: false,
    conversionMode: 'lossy',
    sourceProjectId: 'cat-1',
    sourceProjectName: 'Ping API',
    sourceFormat: 'graphql',
    sourceVersionId: 'rev-1',
    targetProjectId: 'proj-9',
    targetProjectName: 'Ping API (OpenAPI)',
    targetProjectSlug: 'ping-api-openapi',
    targetProjectDeleted: false,
    targetVersionLabel: '1.0.0',
    targetVersionRecordId: 'ver-9',
    fidelityScore: 74,
    fidelityGrade: 'C',
    fidelityTier: 'medium',
    toolVersions: { 'apiome-rest': '1.0.0' },
    defaults: {},
    schemaVersion: '1.0.0',
    manifestHash: HASH,
    sourceHash: 'sha256:' + 'ab'.repeat(32),
    snapshotAvailable: true,
    ...overrides,
  };
}

const SUMMARY = { manifest_hash: HASH, target_format: 'openapi-3.1' };
const PAGE = { manifest_hash: HASH, edges: [], nodes: [], next_cursor: null, total: 0 };

function okFetch(payload: unknown) {
  const fn = jest.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('history fetchers', () => {
  it('fetches the catalog history from the item route', async () => {
    const fn = okFetch({ success: true, conversions: [row()], currentSourceHash: 'sha256:x' });
    const history = await fetchCatalogConversionHistory('item-1');
    expect(fn).toHaveBeenCalledWith(
      '/api/catalog/item-1/conversions',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(history.conversions).toHaveLength(1);
    expect(history.currentSourceHash).toBe('sha256:x');
  });

  it('fetches the project history from the project route', async () => {
    const fn = okFetch({ success: true, conversions: [], currentSourceHash: null });
    const history = await fetchProjectConversionHistory('proj-9');
    expect(fn).toHaveBeenCalledWith(
      '/api/projects/proj-9/conversions',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(history.conversions).toEqual([]);
  });

  it('surfaces the server error message on failure', async () => {
    okFetch({ success: false, error: 'Catalog item not found: item-1' });
    await expect(fetchCatalogConversionHistory('item-1')).rejects.toThrow(
      'Catalog item not found: item-1',
    );
  });
});

describe('fetchConversionEvidenceSnapshotPage', () => {
  it('builds the evidence URL with the page window and adapts to the walk shape', async () => {
    const fn = okFetch({
      success: true,
      provenanceId: 'prov-1',
      itemId: 'item-1',
      snapshot: { status: 'available', reason: null },
      summary: SUMMARY,
      page: PAGE,
    });
    const response = await fetchConversionEvidenceSnapshotPage('item-1', 'prov-1', {
      cursor: 'c1',
      limit: 50,
    });
    expect(fn).toHaveBeenCalledWith(
      '/api/catalog/item-1/conversions/prov-1/evidence?cursor=c1&limit=50',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(response.summary.manifest_hash).toBe(HASH);
    expect(response.page.total).toBe(0);
    expect(response.itemId).toBe('item-1');
  });

  it('throws the typed unavailable error on the explicit degrade shape', async () => {
    okFetch({
      success: true,
      provenanceId: 'prov-0',
      snapshot: { status: 'unavailable', reason: 'predates_snapshots' },
      summary: null,
      page: null,
    });
    const error = await fetchConversionEvidenceSnapshotPage('item-1', 'prov-0').catch((e) => e);
    expect(error).toBeInstanceOf(ConversionSnapshotUnavailableError);
    expect((error as ConversionSnapshotUnavailableError).reason).toBe('predates_snapshots');
    expect((error as ConversionSnapshotUnavailableError).unavailable).toBe(true);
  });

  it('refuses a stored page naming a different snapshot than the approved one', async () => {
    okFetch({
      success: true,
      provenanceId: 'prov-1',
      snapshot: { status: 'available', reason: null },
      summary: { ...SUMMARY, manifest_hash: 'f'.repeat(64) },
      page: { ...PAGE, manifest_hash: 'f'.repeat(64) },
    });
    await expect(
      fetchConversionEvidenceSnapshotPage('item-1', 'prov-1', { expectedManifestHash: HASH }),
    ).rejects.toThrow('does not match');
  });

  it('makeStoredEvidenceSource binds the row into a walk-shaped page source', async () => {
    const fn = okFetch({
      success: true,
      provenanceId: 'prov-1',
      snapshot: { status: 'available', reason: null },
      summary: SUMMARY,
      page: PAGE,
    });
    const source = makeStoredEvidenceSource('item-1', row());
    await source({ cursor: null, limit: 25 });
    expect(fn).toHaveBeenCalledWith(
      '/api/catalog/item-1/conversions/prov-1/evidence?limit=25',
      expect.anything(),
    );
  });
});

describe('trust helpers', () => {
  it('hasStoredSnapshot guards the empty-hash sentinel even when the flag lies', () => {
    expect(hasStoredSnapshot(row())).toBe(true);
    expect(hasStoredSnapshot(row({ snapshotAvailable: false }))).toBe(false);
    expect(hasStoredSnapshot(row({ manifestHash: null }))).toBe(false);
    expect(hasStoredSnapshot(row({ manifestHash: '', snapshotAvailable: true }))).toBe(false);
  });

  it('sourceChangedSince claims a change only when both digests are known and differ', () => {
    expect(sourceChangedSince(row(), 'sha256:' + 'cd'.repeat(32))).toBe(true);
    expect(sourceChangedSince(row(), 'sha256:' + 'ab'.repeat(32))).toBe(false);
    expect(sourceChangedSince(row({ sourceHash: null }), 'sha256:x')).toBe(false);
    expect(sourceChangedSince(row(), null)).toBe(false);
  });

  it('snapshotHashShort renders the 12-char provenance-line form', () => {
    expect(snapshotHashShort(HASH)).toBe('a'.repeat(12));
    expect(snapshotHashShort(null)).toBe('');
  });

  it('every class-map helper pairs a dark: variant', () => {
    for (const helper of [snapshotChipClass, snapshotMissingChipClass, sourceChangedBadgeClass]) {
      expect(helper()).toContain('dark:');
    }
  });
});
