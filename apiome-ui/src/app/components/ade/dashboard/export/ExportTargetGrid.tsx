'use client';

import { useMemo, type ReactNode } from 'react';
import { Badge } from '../../../ui/Badge';
import {
  tierTone,
  tierLabel,
  type ExportTargetCard,
} from './exportTargetCatalog';
import {
  bandTone,
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
          className="vdlg-export__toolbar"
          data-testid="export-readiness-toolbar"
        >
          <span data-testid="export-source-quality">{qualityLine}</span>
          {hasRanking && onOrderChange && (
            <button
              type="button"
              data-testid="export-order-toggle"
              onClick={() => onOrderChange(activeOrder === 'readiness' ? 'registry' : 'readiness')}
              className="vdlg-link"
            >
              {activeOrder === 'readiness' ? 'Sorted by readiness' : 'Sorted by name'}
            </button>
          )}
        </div>
      )}

      <div
        role="group"
        aria-label="Export target formats"
        className="vdlg-export__grid"
      >
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
              // Selection is a toggle state, not just an indigo fill (MFX-41.5): a screen reader
              // must be able to tell which target is chosen without seeing the highlight.
              aria-pressed={isSelected}
              onClick={() => onSelect(card)}
              disabled={!selectable}
              title={cardTitle(card, target)}
              className="vdlg-export__target"
              data-selected={isSelected || undefined}
            >
              <Badge variant={tierTone(card.entry.fidelity.tier)} className="vdlg-export__target-tier">
                {tierLabel(card.entry.fidelity.tier)}
              </Badge>
              {target && (
                <Badge
                  variant={bandTone(target.band)}
                  data-testid={`export-target-band-${card.key}`}
                  className="vdlg-export__target-band"
                >
                  {bandLabel(target.band)}
                </Badge>
              )}
              <Icon className="vdlg-export__target-icon" aria-hidden />
              <div className="vdlg-export__target-label">{card.entry.descriptor.label}</div>
              <div className="vdlg-quiet">
                {card.entry.descriptor.paradigm}
                {card.entry.descriptor.multi_file ? ' · multi-file' : ''}
              </div>
              {target && (
                <div
                  data-testid={`export-target-rationale-${card.key}`}
                  className="vdlg-quiet"
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
          className="vdlg-export__headline"
        >
          <div>
            Exporting to <strong>{selected.entry.descriptor.label}</strong>
          </div>
          <div className="vdlg-export__headline-meta">
            {ranking[selected.key] && (
              <Badge variant={bandTone(ranking[selected.key].band)}>
                {bandLabel(ranking[selected.key].band)}
              </Badge>
            )}
            <Badge variant={tierTone(fidelity.tier)}>{tierLabel(fidelity.tier)}</Badge>
            <span className="vdlg-quiet">{fidelity.preserved_percent}% preserved</span>
          </div>
        </div>
      )}
    </>
  );
}

export default ExportTargetGrid;
