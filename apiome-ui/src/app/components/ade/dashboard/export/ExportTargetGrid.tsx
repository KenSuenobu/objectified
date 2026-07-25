'use client';

import { useMemo, type ReactNode } from 'react';
import {
  tierBadgeClass,
  tierLabel,
  type ExportTargetCard,
} from './exportTargetCatalog';
import {
  bandBadgeClass,
  bandLabel,
  cardTitle,
  isCardSelectable,
  orderTargetCards,
  sourceQualitySummary,
  type ExportPreflightReport,
  type ExportPreflightTarget,
  type ExportTargetOrder,
} from './exportReadiness';

export interface ExportTargetGridProps {
  /** The renderable target cards from `exportTargetCards` (registry-driven, MFX-1.2). */
  cards: ExportTargetCard[];
  /** The currently selected target's key, or null. */
  selectedKey: string | null;
  /** Select a target card; unselectable cards never fire this (the button is disabled). */
  onSelect: (card: ExportTargetCard) => void;
  /** Optional heading block rendered above the grid (e.g. the step's title + subtitle). */
  heading?: ReactNode;
  /**
   * Whether to render the selected-target fidelity headline below the grid (tier + preserved-%).
   * Defaults to true.
   */
  showHeadline?: boolean;
  /**
   * Pre-flight ranking keyed by target key (IXH-2.4). When present, cards carry a readiness badge
   * and rationale; when absent the grid renders exactly as it did before the pre-flight existed.
   */
  readiness?: Record<string, ExportPreflightTarget>;
  /** The pre-flight report, for the source-quality line above the grid. */
  preflight?: ExportPreflightReport | null;
  /** Which ordering to apply. Defaults to `readiness` when a ranking is supplied. */
  order?: ExportTargetOrder;
  /** Switch the ordering; when omitted the order toggle is not rendered. */
  onOrderChange?: (order: ExportTargetOrder) => void;
}

/**
 * ExportTargetGrid — the registry-driven target-card grid shared by the ExportDialog (MFX-6.1,
 * #3855) and the Export Studio (MFX-41.1, #4348).
 *
 * Every registered emitter from `GET /api/export/targets` renders as a card carrying its
 * per-source fidelity badge (`lossless` / `lossy` / `types-only`, MFX-2.5) so the trade-off is
 * visible before selection. Unavailable targets (missing toolchain) render disabled and
 * unselectable. Picking a target renders the fidelity headline (tier + preserved-%) below the
 * grid. This is one component, not a fork: the dialog and the Studio's Target step both mount it,
 * so a change to the card layout or badges lands in both surfaces at once.
 *
 * With an IXH-2.4 pre-flight ranking (`readiness`) the grid additionally sorts by expected
 * outcome — ready, then check-first, then policy-blocked, then unavailable — badges each card with
 * its band, and prints the one-line rationale under the label. A target the tenant's export policy
 * blocks is shown **blocked with its reason**, never hidden, and cannot be selected. The previous
 * registry ordering stays one click away via `onOrderChange`.
 */
export function ExportTargetGrid({
  cards,
  selectedKey,
  onSelect,
  heading,
  showHeadline = true,
  readiness,
  preflight = null,
  order,
  onOrderChange,
}: ExportTargetGridProps) {
  // Memoized so an omitted `readiness` prop does not hand the ordering a fresh `{}` every render.
  const ranking = useMemo(() => readiness ?? {}, [readiness]);
  const hasRanking = Object.keys(ranking).length > 0;
  const activeOrder: ExportTargetOrder = order ?? (hasRanking ? 'readiness' : 'registry');
  const ordered = useMemo(
    () => orderTargetCards(cards, ranking, activeOrder),
    [cards, ranking, activeOrder],
  );
  const selected = cards.find((card) => card.key === selectedKey) ?? null;
  const fidelity = selected?.entry.fidelity ?? null;
  const qualityLine = sourceQualitySummary(preflight);

  return (
    <>
      {heading}

      {(qualityLine || (hasRanking && onOrderChange)) && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400"
          data-testid="export-readiness-toolbar"
        >
          <span data-testid="export-source-quality">{qualityLine}</span>
          {hasRanking && onOrderChange && (
            <button
              type="button"
              data-testid="export-order-toggle"
              onClick={() => onOrderChange(activeOrder === 'readiness' ? 'registry' : 'readiness')}
              className="rounded-md border border-gray-200 px-2 py-1 font-medium text-gray-600 transition hover:border-indigo-200 hover:text-indigo-700 dark:border-gray-700 dark:text-gray-300 dark:hover:text-indigo-300"
            >
              {activeOrder === 'readiness' ? 'Sorted by readiness' : 'Sorted by name'}
            </button>
          )}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {ordered.map((card) => {
          const Icon = card.icon;
          const isSelected = card.key === selectedKey;
          const target = ranking[card.key];
          const selectable = isCardSelectable(card, target);
          return (
            <button
              key={card.key}
              type="button"
              data-testid={`export-target-${card.key}`}
              data-band={target?.band}
              onClick={() => onSelect(card)}
              disabled={!selectable}
              title={cardTitle(card, target)}
              className={`relative rounded-lg border p-3 text-center transition ${
                isSelected
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-100'
                  : selectable
                    ? 'border-gray-200 bg-white text-gray-700 hover:border-indigo-200 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200'
                    : 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-600'
              }`}
            >
              <span
                className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tierBadgeClass(card.entry.fidelity.tier)}`}
              >
                {tierLabel(card.entry.fidelity.tier)}
              </span>
              {target && (
                <span
                  data-testid={`export-target-band-${card.key}`}
                  className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${bandBadgeClass(target.band)}`}
                >
                  {bandLabel(target.band)}
                </span>
              )}
              <Icon className="mx-auto mb-2 mt-3 h-5 w-5" aria-hidden />
              <div className="text-sm font-medium">{card.entry.descriptor.label}</div>
              <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                {card.entry.descriptor.paradigm}
                {card.entry.descriptor.multi_file ? ' · multi-file' : ''}
              </div>
              {target && (
                <div
                  data-testid={`export-target-rationale-${card.key}`}
                  className="mt-2 text-[11px] leading-snug text-gray-500 dark:text-gray-400"
                >
                  {target.rationale}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {showHeadline && selected && fidelity && (
        <div
          data-testid="export-fidelity-headline"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700"
        >
          <div className="text-gray-700 dark:text-gray-200">
            Exporting to <strong>{selected.entry.descriptor.label}</strong>
          </div>
          <div className="flex items-center gap-2">
            {ranking[selected.key] && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${bandBadgeClass(ranking[selected.key].band)}`}
              >
                {bandLabel(ranking[selected.key].band)}
              </span>
            )}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tierBadgeClass(fidelity.tier)}`}
            >
              {tierLabel(fidelity.tier)}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {fidelity.preserved_percent}% preserved
            </span>
          </div>
        </div>
      )}
    </>
  );
}

export default ExportTargetGrid;
