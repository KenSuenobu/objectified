/**
 * Wire contract + fetch helpers for the conversion provenance evidence history (CPDO-3.3, #4803).
 *
 * The server side is `GET /v1/catalog/{tenant}/{item}/conversions` (the catalog item's history),
 * `GET /v1/projects/{tenant}/{project}/conversions` (the converted Project's history), and
 * `GET …/conversions/{id}/evidence` (one page of the *stored* snapshot graph — never a rebuild).
 * This module mirrors those contracts field-for-field (apiome-rest `app/models.py`
 * `ConversionProvenanceEntry` / `ConversionEvidenceResponse`): top-level row fields are camelCase
 * aliases, while the nested `summary`/`page` stay snake_case exactly as
 * `app/conversion_projection.py` dumps them (the `conversion-projection.ts` shapes).
 *
 * Everything here is pure apart from the three fetchers. The class-map helpers keep Tailwind
 * literals out of components, per the CPDO convention.
 */

import type {
  CatalogProjectionResponse,
  ConversionEvidencePage,
  ConversionEvidencePageSource,
  ConversionManifestSummary,
} from './conversion-projection';
import type { ConversionDefaults } from './conversion-fidelity';

// ---------------------------------------------------------------------------
// Wire shapes (top level camelCase, mirroring app/models.py aliases)
// ---------------------------------------------------------------------------

/** One row of a conversion's provenance history, newest first. */
export interface ConversionProvenanceRow {
  provenanceId: string;
  createdAt: string | null;
  createdBy: string | null;
  reconverted: boolean;
  /** passthrough / typespec_native / lossy, or null on rows without tool provenance. */
  conversionMode: string | null;
  /** The source catalog item; null when the item was hard-deleted. */
  sourceProjectId: string | null;
  sourceProjectName: string | null;
  sourceFormat: string | null;
  sourceVersionId: string | null;
  targetProjectId: string;
  targetProjectName: string | null;
  targetProjectSlug: string | null;
  targetProjectDeleted: boolean;
  targetVersionLabel: string | null;
  /** The target revision this conversion's snapshot is linked to. */
  targetVersionRecordId: string | null;
  fidelityScore: number | null;
  fidelityGrade: string | null;
  fidelityTier: string | null;
  toolVersions: Record<string, string>;
  /** The gap-filling defaults the conversion was committed with. */
  defaults: ConversionDefaults;
  schemaVersion: string | null;
  /** Content-addressed snapshot id; null on rows recorded before manifests existed. */
  manifestHash: string | null;
  /** sha256:-prefixed digest of the exact source converted; null on pre-CPDO-3.3 rows. */
  sourceHash: string | null;
  /** True when the full evidence snapshot is stored and its graph can be replayed. */
  snapshotAvailable: boolean;
}

/** Both history lists' shared shape (`itemId`/`projectId` vary; rows are identical). */
export interface ConversionHistoryResponse {
  conversions: ConversionProvenanceRow[];
  /** Digest of the item's currently captured source; null when unknowable. Catalog side only. */
  currentSourceHash: string | null;
}

/** The evidence endpoint's degrade vocabulary (always HTTP 200). */
export type ConversionSnapshotUnavailableReason =
  | 'predates_snapshots'
  | 'snapshot_missing'
  | 'unreadable';

/** The evidence endpoint's response. */
export interface ConversionEvidenceSnapshotResponse {
  provenanceId: string;
  itemId: string | null;
  projectId: string | null;
  manifestHash: string | null;
  sourceHash: string | null;
  snapshot: {
    status: 'available' | 'unavailable';
    reason: ConversionSnapshotUnavailableReason | null;
  };
  summary: ConversionManifestSummary | null;
  page: ConversionEvidencePage | null;
}

/** Thrown when the server reports an explicit snapshot degrade state. */
export class ConversionSnapshotUnavailableError extends Error {
  readonly unavailable = true;

  readonly reason: ConversionSnapshotUnavailableReason | null;

  constructor(reason: ConversionSnapshotUnavailableReason | null) {
    super(
      reason === 'predates_snapshots'
        ? 'This conversion predates stored evidence snapshots.'
        : reason === 'unreadable'
          ? 'The stored evidence snapshot could not be read.'
          : 'No stored evidence snapshot exists for this conversion.',
    );
    this.name = 'ConversionSnapshotUnavailableError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Whether a row's stored evidence graph can actually be replayed.
 *
 * Guards the pre-migration empty state twice over: the flag must be set AND a real hash must be
 * present, so a stale/buggy flag can never send the reader after the empty sentinel.
 */
export function hasStoredSnapshot(row: ConversionProvenanceRow): boolean {
  return row.snapshotAvailable && row.manifestHash != null && row.manifestHash !== '';
}

/**
 * Whether the item's source has changed since this conversion was approved.
 *
 * True only when both digests are known and differ — an unknown side is "cannot say", never
 * "changed".
 */
export function sourceChangedSince(
  row: ConversionProvenanceRow,
  currentSourceHash: string | null,
): boolean {
  return Boolean(row.sourceHash && currentSourceHash && row.sourceHash !== currentSourceHash);
}

/** The 12-char short form of a snapshot hash (the `conversion-projection-provenance` idiom). */
export function snapshotHashShort(hash: string | null): string {
  return (hash ?? '').slice(0, 12);
}

/** Chip class for a row's snapshot reference. */
export function snapshotChipClass(): string {
  return 'inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-2xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300';
}

/** Muted chip class for a row with no stored snapshot. */
export function snapshotMissingChipClass(): string {
  return 'inline-flex items-center rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-2xs text-gray-500 dark:border-gray-600 dark:text-gray-400';
}

/** Amber badge class for "the source changed since this conversion". */
export function sourceChangedBadgeClass(): string {
  return 'inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

type HistoryEnvelope = ConversionHistoryResponse & {
  success?: boolean;
  error?: string;
  detail?: string;
};

async function readHistoryResponse(response: Response, what: string): Promise<ConversionHistoryResponse> {
  const data = (await response.json().catch(() => null)) as HistoryEnvelope | null;
  if (!response.ok || !data || data.success === false) {
    const message =
      (data && (data.error || data.detail)) || `Failed to load ${what} (HTTP ${response.status})`;
    throw new Error(typeof message === 'string' ? message : `Failed to load ${what}`);
  }
  return {
    conversions: data.conversions ?? [],
    currentSourceHash: data.currentSourceHash ?? null,
  };
}

/**
 * Fetch a catalog item's conversion history, newest first.
 *
 * @param itemId The catalog item id (a project id).
 * @param signal Optional abort signal.
 * @throws Error with the server's message when the request fails.
 */
export async function fetchCatalogConversionHistory(
  itemId: string,
  signal?: AbortSignal,
): Promise<ConversionHistoryResponse> {
  const response = await fetch(`/api/catalog/${encodeURIComponent(itemId)}/conversions`, {
    credentials: 'include',
    signal,
  });
  return readHistoryResponse(response, 'the conversion history');
}

/**
 * Fetch the conversions that produced a Project, newest first.
 *
 * @param projectId The (target) project id.
 * @param signal Optional abort signal.
 * @throws Error with the server's message when the request fails.
 */
export async function fetchProjectConversionHistory(
  projectId: string,
  signal?: AbortSignal,
): Promise<ConversionHistoryResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/conversions`, {
    credentials: 'include',
    signal,
  });
  return readHistoryResponse(response, 'the conversion history');
}

/** Options for one stored-snapshot evidence page fetch. */
export interface FetchConversionEvidenceSnapshotOptions {
  cursor?: string | null;
  limit?: number;
  /**
   * The manifest hash the provenance row was approved under. A stored page naming a different
   * snapshot is refused with an error rather than rendered.
   */
  expectedManifestHash?: string | null;
  signal?: AbortSignal;
}

/**
 * Fetch one page of a historical conversion's *stored* evidence snapshot.
 *
 * Returns the `CatalogProjectionResponse` shape the projection walk consumes, so a stored
 * snapshot pages through the same hook/panel as a live rebuild.
 *
 * @throws ConversionSnapshotUnavailableError on the explicit degrade shape.
 * @throws Error when the page's snapshot does not match `expectedManifestHash`, or on transport
 *   failure.
 */
export async function fetchConversionEvidenceSnapshotPage(
  itemId: string,
  provenanceId: string,
  options?: FetchConversionEvidenceSnapshotOptions,
): Promise<CatalogProjectionResponse> {
  const query = new URLSearchParams();
  if (options?.cursor) query.set('cursor', options.cursor);
  if (options?.limit != null) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  const response = await fetch(
    `/api/catalog/${encodeURIComponent(itemId)}/conversions/` +
      `${encodeURIComponent(provenanceId)}/evidence${suffix}`,
    { credentials: 'include', signal: options?.signal },
  );
  const data = (await response.json().catch(() => null)) as
    | (ConversionEvidenceSnapshotResponse & { success?: boolean; error?: string; detail?: string })
    | null;
  if (!response.ok || !data || data.success === false) {
    const message =
      (data && (data.error || data.detail)) ||
      `Failed to load the stored evidence snapshot (HTTP ${response.status})`;
    throw new Error(
      typeof message === 'string' ? message : 'Failed to load the stored evidence snapshot',
    );
  }
  if (data.snapshot?.status !== 'available' || !data.summary || !data.page) {
    throw new ConversionSnapshotUnavailableError(data.snapshot?.reason ?? null);
  }
  const expected = options?.expectedManifestHash;
  if (expected && data.summary.manifest_hash !== expected) {
    throw new Error(
      `Stored snapshot '${snapshotHashShort(data.summary.manifest_hash)}…' does not match the ` +
        `approved conversion's snapshot '${snapshotHashShort(expected)}…'.`,
    );
  }
  return {
    itemId: data.itemId ?? itemId,
    versionRecordId: null,
    target: data.summary.target_format,
    summary: data.summary,
    page: data.page,
  };
}

/**
 * Bind one history row into a page source the projection walk can consume (CPDO-3.3).
 *
 * The returned source pages the row's stored snapshot and refuses pages naming any other
 * snapshot, so the walk's own cross-page identity check and this expected-hash check together
 * pin the rendered evidence to the approved conversion.
 */
export function makeStoredEvidenceSource(
  itemId: string,
  row: ConversionProvenanceRow,
): ConversionEvidencePageSource {
  return ({ cursor, limit }) =>
    fetchConversionEvidenceSnapshotPage(itemId, row.provenanceId, {
      cursor,
      limit,
      expectedManifestHash: row.manifestHash,
    });
}
