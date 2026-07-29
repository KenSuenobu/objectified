'use client';

/**
 * CatalogConversionHistoryPanel (CPDO-3.3, #4803) — a catalog item's conversion evidence history.
 *
 * The Conversions tab of the catalog detail screen: the newest-first provenance list
 * ({@link ConversionHistoryList}), and beneath it the **exact evidence the selected conversion
 * was approved with**, replayed from the persisted content-addressed snapshot through the same
 * `ConversionProjectionGraphPanel` the live preview uses (via its `evidenceSource` override) —
 * same integrity refusal, same truncation statements, same drawer.
 *
 * Historic vs fresh is stated, never implied (the LintReportDialog captured-vs-live pattern):
 * a neutral note always names the selected snapshot as approved-at-commit evidence, and an
 * amber note appears when the item's current source digest differs from the row's — with the
 * Convert preview as the pointer to fresh evidence. A row with no stored snapshot (committed
 * before CPDO-3.3) degrades to an explicit dashed block and fires no evidence request at all.
 */

import { useMemo, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { ConversionHistoryList } from './ConversionHistoryList';
import { ConversionProjectionGraphPanel } from './ConversionProjectionGraphPanel';
import { useConversionHistory } from './useConversionHistory';
import {
  hasStoredSnapshot,
  makeStoredEvidenceSource,
  snapshotHashShort,
  sourceChangedSince,
  type ConversionProvenanceRow,
} from '@/app/utils/conversion-provenance';

export interface CatalogConversionHistoryPanelProps {
  /** The catalog item id (a project id). */
  itemId: string;
  /** True while the Conversions tab is active; the history loads once on first activation. */
  active: boolean;
  /** Open the Convert preview dialog, when the owner wires it (the fresh-evidence pointer). */
  onOpenConvertPreview?: () => void;
}

export function CatalogConversionHistoryPanel({
  itemId,
  active,
  onOpenConvertPreview,
}: CatalogConversionHistoryPanelProps) {
  const { rows, currentSourceHash, loaded, loading, error, retry } = useConversionHistory(
    active,
    useMemo(() => ({ kind: 'catalog' as const, itemId }), [itemId]),
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Auto-select the newest row so the tab is immediately useful; an explicit pick wins.
  const selected: ConversionProvenanceRow | null =
    rows.find((row) => row.provenanceId === selectedId) ?? rows[0] ?? null;

  const evidenceSource = useMemo(
    () => (selected && hasStoredSnapshot(selected) ? makeStoredEvidenceSource(itemId, selected) : null),
    // Rebind only when the selection actually changes rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemId, selected?.provenanceId],
  );

  return (
    <div data-testid="conversion-history-panel" className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Conversion history</h3>
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
          Every conversion of this item, newest first, with the exact evidence each one was
          approved with.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
          Loading conversion history…
        </div>
      ) : null}

      {error ? (
        <div
          data-testid="conversion-history-error"
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium underline"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}

      {loaded && rows.length === 0 ? (
        <p
          data-testid="conversion-history-empty"
          className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-300"
        >
          No conversions have been recorded for this item yet. Approve a conversion from the
          Convert preview to start its history.
        </p>
      ) : null}

      <ConversionHistoryList
        rows={rows}
        currentSourceHash={currentSourceHash}
        perspective="catalog"
        selectedId={selected?.provenanceId ?? null}
        onSelect={(row) => setSelectedId(row.provenanceId)}
      />

      {selected ? (
        <div className="space-y-3">
          <p
            data-testid="conversion-history-historic-note"
            className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300"
          >
            Historic evidence captured{' '}
            {selected.createdAt ? new Date(selected.createdAt).toLocaleDateString() : 'at commit'}
            {selected.manifestHash ? ` · snapshot ${snapshotHashShort(selected.manifestHash)}` : ''}.
            This is the evidence this conversion was approved with.
          </p>
          {sourceChangedSince(selected, currentSourceHash) ? (
            <p
              data-testid="conversion-history-stale-note"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
            >
              The source has changed since this conversion was approved.{' '}
              {onOpenConvertPreview ? (
                <button type="button" onClick={onOpenConvertPreview} className="font-medium underline">
                  Open the Convert preview
                </button>
              ) : (
                'Open the Convert preview'
              )}{' '}
              to compute fresh evidence.
            </p>
          ) : null}

          {evidenceSource ? (
            <div className="projection-panel">
              <ConversionProjectionGraphPanel
                key={selected.provenanceId}
                itemId={itemId}
                enabled
                evidenceSource={evidenceSource}
                defaults={selected.defaults}
              />
            </div>
          ) : (
            <p
              data-testid="conversion-history-snapshot-unavailable"
              className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-300"
            >
              This conversion predates stored evidence snapshots, so its graph cannot be
              replayed. The recorded fidelity grade and tool versions above remain authoritative.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default CatalogConversionHistoryPanel;
