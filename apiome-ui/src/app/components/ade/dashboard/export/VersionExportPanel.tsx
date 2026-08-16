'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Download, FileClock, Loader2, RotateCcw, Shuffle } from 'lucide-react';
import { Alert } from '../../../ui/Alert';
import { Button } from '../../../ui/Button';
import { useExportTargets } from './useExportTargets';
import {
  exportTargetCards,
  fidelityPreSummary,
  tierBadgeClass,
  type ExportTargetCard,
} from './exportTargetCatalog';
import { fidelityBadgeLabel, loadRecentExports, type RecentExport } from './recentExports';
import { exportStudioHref } from './exportStudioLink';
import { formatRelativeTime } from '../../../../ade/dashboard/versions/version-history-dag';

interface VersionExportPanelProps {
  /** The artifact (project) id the viewed version belongs to. */
  artifact: string;
  /** The viewed revision (UUID or version label); the latest revision when null. */
  version: string | null;
  /** Human name of the source, carried into the Studio header (falls back to the id). */
  artifactLabel?: string | null;
  /** Only fetch fidelity data while truthy (i.e. while the version view is showing). */
  active: boolean;
  /** Bump to re-read the recent-exports list after an export was recorded. */
  refreshToken?: number;
}

/**
 * VersionExportPanel — the version-scoped export entry point (MFX-6.5 #3859, MFX-41.3 #4350).
 *
 * Rendered on the version view (never in the global nav — a tenant may have hundreds of
 * projects/versions, so export is an action on the version being viewed). Two cards per the
 * export mockup:
 *
 *  - **Convert to any format** — the fidelity pre-summary: which targets carry *this* source
 *    at best fidelity vs lossily (from `GET /api/export/targets`, MFX-2.5 tiers). Every target
 *    chip deep-links into the Export Studio with that target pre-selected, and "Export this
 *    version" opens the Studio unscoped-to-a-target (the compact row-menu action keeps the quick
 *    ExportDialog, MFX-41.3).
 *  - **Recent exports** — this version's past exports with their fidelity % and relative time
 *    (browser-local, recorded when an export emits; see `recentExports.ts`). Each row offers
 *    *re-run in Studio*, reopening the Studio with that run's target and options pre-filled.
 */
export function VersionExportPanel({
  artifact,
  version,
  artifactLabel,
  active,
  refreshToken = 0,
}: VersionExportPanelProps) {
  const { response, loading, error } = useExportTargets(active, artifact, version);
  const cards = useMemo(() => exportTargetCards(response), [response]);
  const { best, lossy } = useMemo(() => fidelityPreSummary(cards), [cards]);

  // refreshToken is a deliberate extra dependency: the parent bumps it after recording an
  // export so the list re-reads storage without the panel remounting.
  const recent = useMemo(
    () => (active ? loadRecentExports(artifact, version) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, artifact, version, refreshToken],
  );

  // The Studio deep link for this version, with no target pre-selected — the "Export this version"
  // call to action. Each target chip and recent-export row builds its own targeted variant.
  const studioHref = useMemo(
    () =>
      exportStudioHref({
        artifact,
        version,
        label: artifactLabel,
        origin: 'versions',
      }),
    [artifact, version, artifactLabel],
  );

  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="version-export-panel">
      <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
          <Shuffle className="h-4 w-4 text-indigo-500" aria-hidden />
          Convert to any format
        </div>
        <div className="my-3 h-px bg-gray-200 dark:bg-gray-700" />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          This version is held in the normalized model, so it can be transcoded to any target
          format. Fidelity varies — less-expressive targets drop or approximate detail. Pick a
          target to open it in the Export Studio.
        </p>

        {error && (
          <Alert variant="error" className="mt-3">
            {error}
          </Alert>
        )}
        {loading && !error && (
          <div className="mt-3 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden />
            Measuring export fidelity for this version…
          </div>
        )}
        {!loading && !error && response && (
          <dl className="mt-3 space-y-2 text-sm" data-testid="version-export-presummary">
            <TargetBadgeRow
              label="Best-fidelity targets"
              cards={best}
              artifact={artifact}
              version={version}
              artifactLabel={artifactLabel}
            />
            <TargetBadgeRow
              label="Lossy targets"
              cards={lossy}
              artifact={artifact}
              version={version}
              artifactLabel={artifactLabel}
            />
          </dl>
        )}

        <div className="mt-4">
          <Button asChild>
            <Link href={studioHref} data-testid="version-export-open-studio">
              <Download className="h-4 w-4" aria-hidden />
              Export this version
            </Link>
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
          <FileClock className="h-4 w-4 text-indigo-500" aria-hidden />
          Recent exports
        </div>
        <div className="my-3 h-px bg-gray-200 dark:bg-gray-700" />
        {recent.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            No exports of this version yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm" data-testid="version-recent-exports">
            {recent.map((entry) => (
              <li
                key={`${entry.targetKey}-${entry.exportedAt}`}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="flex items-center gap-2">
                  <span
                    className="font-medium text-gray-700 dark:text-gray-200"
                    title={entry.filename}
                  >
                    {entry.targetLabel}
                  </span>
                  <Link
                    href={rerunHref(entry, artifact, version, artifactLabel)}
                    data-testid="version-recent-export-rerun"
                    title={`Re-run this ${entry.targetLabel} export in the Studio with its options pre-filled`}
                    className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden />
                    Re-run in Studio
                  </Link>
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-2xs font-semibold ${tierBadgeClass(entry.tier)}`}
                  >
                    {fidelityBadgeLabel(entry)}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {formatRelativeTime(new Date(entry.exportedAt).toISOString()) ?? ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The Studio deep link that reproduces a recorded export (MFX-41.3): the same source and target,
 * carrying that run's non-default option overrides so the Studio pre-fills them.
 */
function rerunHref(
  entry: RecentExport,
  artifact: string,
  version: string | null,
  artifactLabel?: string | null,
): string {
  return exportStudioHref({
    artifact,
    version,
    label: artifactLabel,
    target: entry.targetKey,
    options: entry.options,
    origin: 'versions',
  });
}

interface TargetBadgeRowProps {
  /** The pre-summary row label, e.g. `Best-fidelity targets`. */
  label: string;
  /** The targets in this row; an empty row renders a quiet "None". */
  cards: ExportTargetCard[];
  /** The artifact (project) id, for each chip's Studio deep link. */
  artifact: string;
  /** The viewed revision selector, for each chip's Studio deep link. */
  version: string | null;
  /** Human name of the source, carried into the Studio header. */
  artifactLabel?: string | null;
}

/**
 * One pre-summary row: a label plus each target as a tier-colored chip that deep-links into the
 * Export Studio with that target pre-selected (MFX-41.3).
 */
function TargetBadgeRow({ label, cards, artifact, version, artifactLabel }: TargetBadgeRowProps) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="flex flex-wrap gap-1">
        {cards.length === 0 ? (
          <span className="text-xs text-gray-400 dark:text-gray-500">None</span>
        ) : (
          cards.map((card) => (
            <Link
              key={card.key}
              href={exportStudioHref({
                artifact,
                version,
                label: artifactLabel,
                target: card.key,
                origin: 'versions',
              })}
              data-testid="version-export-target-chip"
              title={`Export to ${card.entry.descriptor.label} — ${card.entry.fidelity.preserved_percent}% preserved`}
              className={`rounded-full px-2 py-0.5 text-2xs font-semibold hover:ring-2 hover:ring-indigo-300 dark:hover:ring-indigo-700 ${tierBadgeClass(card.entry.fidelity.tier)}`}
            >
              {card.entry.descriptor.label}
            </Link>
          ))
        )}
      </dd>
    </div>
  );
}

export default VersionExportPanel;
