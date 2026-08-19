'use client';

/**
 * ConversionHistoryList (CPDO-3.3, #4803) — the shared, presentational conversion history list.
 *
 * One newest-first row per convert/re-convert from the provenance ledger, rendered identically
 * on both surfaces: the catalog item's Conversions tab (`perspective="catalog"`, rows select a
 * conversion whose stored evidence renders below) and the versions screen's Conversion tab
 * (`perspective="project"`, rows link back to the catalog item and jump to the target version).
 *
 * Each row states its own trust level: the snapshot chip (replayable hash vs "No stored
 * snapshot"), and the amber "Source changed since" badge when the row's recorded source digest
 * differs from the item's current one. Pure — all data arrives via props.
 */

import { cn } from '@lib/utils';
import Link from 'next/link';
import { gradeChipClass } from '@/app/utils/version-lint-report';
import {
  hasStoredSnapshot,
  snapshotChipClass,
  snapshotHashShort,
  snapshotMissingChipClass,
  sourceChangedBadgeClass,
  sourceChangedSince,
  type ConversionProvenanceRow,
} from '@/app/utils/conversion-provenance';

export interface ConversionHistoryListProps {
  /** Provenance rows, newest first (server order is preserved). */
  rows: ConversionProvenanceRow[];
  /** Digest of the item's currently captured source; null disables the changed-since badge. */
  currentSourceHash: string | null;
  /** Which surface is rendering: decides the per-row affordances. */
  perspective: 'catalog' | 'project';
  /** The selected row (catalog perspective); rows render `aria-pressed` against it. */
  selectedId?: string | null;
  /** Row selection (catalog perspective). */
  onSelect?: (row: ConversionProvenanceRow) => void;
  /** Jump to a target version (project perspective). */
  onOpenVersion?: (versionRecordId: string) => void;
}

/** Format a ledger timestamp for display; the raw string is the honest fallback. */
function formatWhen(createdAt: string | null): string {
  if (!createdAt) return 'Unknown date';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ConversionHistoryList({
  rows,
  currentSourceHash,
  perspective,
  selectedId,
  onSelect,
  onOpenVersion,
}: ConversionHistoryListProps) {
  if (rows.length === 0) return null;

  return (
    <ul className="space-y-2" data-testid="conversion-history-list">
      {rows.map((row) => {
        const selected = selectedId != null && selectedId === row.provenanceId;
        const changed = sourceChangedSince(row, currentSourceHash);
        const stored = hasStoredSnapshot(row);
        const body = (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-fg">
                {formatWhen(row.createdAt)}
              </span>
              {row.targetVersionLabel ? (
                <span className="text-xs text-fg-muted">
                  → {perspective === 'catalog' && row.targetProjectName ? `${row.targetProjectName} ` : ''}
                  v{row.targetVersionLabel}
                </span>
              ) : null}
              {row.fidelityGrade ? (
                <span
                  data-testid="conversion-history-grade"
                  className={cn('px-1.5 py-0.5 rounded text-2xs font-semibold', gradeChipClass(row.fidelityGrade))}
                >
                  {row.fidelityGrade}
                  {row.fidelityScore != null ? ` · ${row.fidelityScore}` : ''}
                </span>
              ) : null}
              {row.reconverted ? (
                <span
                  data-testid="conversion-history-reconverted"
                  className="inline-flex items-center rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent-fg"
                >
                  Re-converted
                </span>
              ) : null}
              {changed ? (
                <span data-testid="conversion-history-source-changed" className={sourceChangedBadgeClass()}>
                  Source changed since
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {stored ? (
                <span data-testid="conversion-history-snapshot-chip" className={snapshotChipClass()}>
                  snapshot {snapshotHashShort(row.manifestHash)}
                </span>
              ) : (
                <span data-testid="conversion-history-snapshot-chip" className={snapshotMissingChipClass()}>
                  No stored snapshot
                </span>
              )}
              {row.conversionMode ? (
                <span className="text-2xs text-fg-muted">{row.conversionMode}</span>
              ) : null}
            </div>
          </>
        );

        return (
          <li key={row.provenanceId}>
            {perspective === 'catalog' ? (
              <button
                type="button"
                data-testid="conversion-history-row"
                data-provenance-id={row.provenanceId}
                aria-pressed={selected}
                onClick={() => onSelect?.(row)}
                className={cn(
                  'w-full rounded-md border px-3 py-2 text-left motion-safe:transition-colors',
                  selected
                    ? 'border-accent bg-accent-soft'
                    : 'border-border hover:bg-subtle',
                )}
              >
                {body}
              </button>
            ) : (
              <div
                data-testid="conversion-history-row"
                data-provenance-id={row.provenanceId}
                className="rounded-md border border-border px-3 py-2"
              >
                {body}
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {row.sourceProjectId ? (
                    <Link
                      data-testid="conversion-history-open-catalog"
                      href={`/ade/dashboard/catalog/${encodeURIComponent(row.sourceProjectId)}?tab=conversions`}
                      className="text-xs font-medium text-accent-fg hover:underline"
                    >
                      Open catalog item{row.sourceProjectName ? `: ${row.sourceProjectName}` : ''}
                    </Link>
                  ) : (
                    <span className="text-xs text-fg-muted">
                      Source catalog item no longer exists
                    </span>
                  )}
                  {row.targetVersionRecordId && onOpenVersion ? (
                    <button
                      type="button"
                      data-testid="conversion-history-open-version"
                      onClick={() => onOpenVersion(row.targetVersionRecordId as string)}
                      className="text-xs font-medium text-accent-fg hover:underline"
                    >
                      View version{row.targetVersionLabel ? ` ${row.targetVersionLabel}` : ''}
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default ConversionHistoryList;
