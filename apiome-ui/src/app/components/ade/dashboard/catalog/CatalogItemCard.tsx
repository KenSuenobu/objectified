'use client';

/**
 * CatalogItemCard (MFI-23.4, #4013).
 *
 * The card/row for a single catalog item, cloned from `ProjectsDashboardProjectCard.tsx` so the
 * Catalog grid is visually consistent with the Projects grid. It reproduces every project-card
 * affordance — gradient avatar, name, short id/slug, status badge, the clickable **quality** and
 * **lint-grade** orbs (which open the very same `ProjectQualityHistoryDialog`) — with these
 * catalog-specific differences:
 *
 *  1. There is **no Publish** path. Catalog items are the non-publishable slice of projects
 *     (MFI-23.1); the actions menu (passed in via `actionsSlot`) offers View / Lint /
 *     Convert to OpenAPI / Delete and never Publish.
 *  2. A `formatSlot` renders the imported format/source pills (MFI-23.5) above the orbs.
 *  3. The orbs sit **3-across** under a dashed divider (MFI-24.5): Quality, Lint and a third,
 *     always-inert **Debt** orb (a neutral dash — technical debt is not yet computed). The
 *     converted badge (`conversionSlot`, MFI-23.11) is right-aligned in that same orb row.
 *  4. The footer shows the **creator chip** ("imported by …") on the left and the updated-relative
 *     time on the right (MFI-24.5), instead of the project card's enabled/active status text.
 *
 * A catalog item's id *is* a project id (the Catalog is a projection over the `projects` table), so
 * the orbs reuse the project quality-history machinery for the click-through dialogs. Display values
 * prefer the server-captured `qualityScore` / `qualityGrade` (MFI-23.2) and only fall back to
 * browser-local import snapshots when the server has not scored the item yet.
 */

import type { ReactNode } from 'react';
import { cn } from '@lib/utils';
import { getNumericScoreTier, type NumericScoreTierStyle } from '@/app/utils/numeric-score-tier';
import { catalogOrbScores } from '@/app/utils/catalog-card-presentation';
import type { ProjectQualitySnapshot } from '@/app/utils/project-quality-score-history';
import { formatRelativeTime } from '@/app/ade/dashboard/versions/version-history-dag';

/** The orb border colour for a quality/lint band (mirrors ProjectsDashboardProjectCard). */
function scoreOrbBorderClass(band: NumericScoreTierStyle['band'] | null): string {
  if (!band) return 'border-gray-300 dark:border-gray-600';
  if (band === 'excellent') return 'border-emerald-500';
  if (band === 'good') return 'border-indigo-500';
  if (band === 'fair') return 'border-amber-500';
  return 'border-rose-500';
}

/** The minimal catalog-item shape the card needs (a subset of the page's `CatalogItem`). */
export interface CatalogItemCardItem {
  id: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  enabled: boolean;
  deleted_at: string | null;
  updated_at: string;
  creator_name?: string | null;
  metadata?: { summary?: string } | null;
  /** Server-captured quality score/grade (MFI-23.2), used as the orb fallback. */
  qualityScore?: number | null;
  qualityGrade?: string | null;
  /** Live revision count for this catalog item (parity with project cards). */
  versionsCount?: number;
}

export interface CatalogItemCardProps {
  /** The catalog item to render. */
  item: CatalogItemCardItem;
  /** Browser-local quality snapshots for this item's id (empty for server-only imports). */
  qualityHistory: ProjectQualitySnapshot[];
  /** Tailwind `from-…/to-…` gradient classes for the avatar tile. */
  avatarGradientClass: string;
  /** Up-to-two-letter initials shown in the avatar tile. */
  avatarInitials: string;
  /** Up-to-two-letter initials shown in the creator chip. */
  creatorInitials: string;
  /** The shortened, human-friendly id shown under the name. */
  shortItemId: string;
  /** Opens the quality-history dialog (quality orb). */
  onOpenQualityHistory: () => void;
  /** Opens the lint-report dialog (lint orb). */
  onOpenLintReport: () => void;
  /** Opens the item's detail view (card body click). */
  onOpenDetail: () => void;
  /** The format/source pills (MFI-23.5) rendered below the orbs. */
  formatSlot: ReactNode;
  /** The "Converted → {project}" back-link (MFI-23.11), rendered below the pills; null when unconverted. */
  conversionSlot?: ReactNode;
  /** The per-item actions menu (View / Lint / Convert to OpenAPI / Delete — never Publish). */
  actionsSlot: ReactNode;
}

/**
 * Renders a single catalog item as a card. See the file header for the project-card parity and the
 * two catalog-specific differences (no Publish, a format/source pill slot).
 */
export function CatalogItemCard({
  item,
  qualityHistory,
  avatarGradientClass,
  avatarInitials,
  creatorInitials,
  shortItemId,
  onOpenQualityHistory,
  onOpenLintReport,
  onOpenDetail,
  formatSlot,
  conversionSlot,
  actionsSlot,
}: CatalogItemCardProps) {
  const isDeleted = Boolean(item.deleted_at);
  const attentionVisual = !item.enabled || isDeleted;

  const { qualityValue, lintLetter } = catalogOrbScores(item, qualityHistory);
  const scoreTier = qualityValue != null ? getNumericScoreTier(qualityValue) : null;

  const versionsCount = typeof item.versionsCount === 'number' ? item.versionsCount : 0;
  const versionsLabel = `${versionsCount} version${versionsCount === 1 ? '' : 's'}`;

  const summaryLine = item.metadata?.summary?.trim() || item.description?.trim() || 'No description yet.';

  const orbBase =
    'inline-flex h-10 w-10 items-center justify-center rounded-full border-2 font-mono text-xs font-semibold tabular-nums';
  // The neutral (no-value) orb ring/text, shared by an empty Quality/Lint orb and the always-inert Debt orb.
  const orbNeutral = 'border-gray-300 text-gray-400 dark:border-gray-600';
  // The small caption rendered beneath each orb (MFI-24.5 puts the label below the orb, per the mockup).
  const orbLabel = 'mt-1 text-2xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';

  return (
    <article
      data-testid="catalog-card"
      className={cn(
        'overflow-hidden rounded-lg border bg-white transition-colors dark:bg-gray-800',
        attentionVisual
          ? 'border-amber-200/60 dark:border-amber-700/40'
          : 'border-gray-200 hover:border-indigo-300 dark:border-gray-700 dark:hover:border-indigo-600',
        isDeleted && 'opacity-90'
      )}
    >
      <div className="relative p-5">
        <div
          className="absolute right-4 top-4 z-[1] flex items-center gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          {actionsSlot}
        </div>

        <div
          role={isDeleted ? undefined : 'button'}
          tabIndex={isDeleted ? undefined : 0}
          className={cn(!isDeleted && 'cursor-pointer')}
          onClick={() => {
            if (!isDeleted) onOpenDetail();
          }}
          onKeyDown={(e) => {
            if (isDeleted) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenDetail();
            }
          }}
        >
          <div className="flex items-start gap-3 pr-10">
            <span
              className={cn(
                'inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br font-mono font-bold text-white',
                avatarGradientClass
              )}
              aria-hidden
            >
              {avatarInitials}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-bold text-gray-900 dark:text-white" title={item.name}>
                {item.name}
              </h3>
              <p
                className="truncate font-mono text-2xs text-gray-500 dark:text-gray-400"
                title={item.slug ?? item.id}
              >
                {shortItemId}
                {item.slug ? ` · ${item.slug}` : ''}
              </p>
            </div>
            <div className="shrink-0">
              {isDeleted ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                  Deleted
                </span>
              ) : !item.enabled ? (
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                  Disabled
                </span>
              ) : (
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  Active
                </span>
              )}
            </div>
          </div>

          <p className="mt-3 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{summaryLine}</p>

          {/* Format/source pills (MFI-23.5) — supplied by the page. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">{formatSlot}</div>

          {/*
            Orb row (MFI-24.5): the Quality, Lint and Debt orbs sit 3-across, separated from the
            pills above by a dashed divider. Quality and Lint stay clickable and open the existing
            quality-history / lint-report dialogs (wiring unchanged). Debt is an inert placeholder —
            technical debt is not yet computed — so it renders a neutral dash with an explanatory
            tooltip and no button semantics. The converted badge (MFI-23.11), when present, is
            right-aligned in the same row rather than on its own line below.
          */}
          <div className="mt-4 flex items-start gap-3.5 border-t border-dashed border-gray-200 pt-3 dark:border-gray-700">
            <div className="text-center">
              {qualityValue != null ? (
                <button
                  type="button"
                  className={cn(
                    orbBase,
                    scoreOrbBorderClass(scoreTier!.band),
                    scoreTier!.textClass,
                    'hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30'
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenQualityHistory();
                  }}
                  title="Open quality score history"
                >
                  {qualityValue}
                </button>
              ) : (
                <span className={cn(orbBase, orbNeutral)}>—</span>
              )}
              <p className={orbLabel}>Quality</p>
            </div>
            <div className="text-center">
              {lintLetter ? (
                <button
                  type="button"
                  className={cn(
                    orbBase,
                    scoreOrbBorderClass(scoreTier?.band ?? null),
                    scoreTier?.textClass ?? 'text-gray-500 dark:text-gray-400',
                    'hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30'
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenLintReport();
                  }}
                  title="Open lint report"
                >
                  {lintLetter}
                </button>
              ) : (
                <span className={cn(orbBase, orbNeutral)}>—</span>
              )}
              <p className={orbLabel}>Lint</p>
            </div>
            <div className="text-center">
              {/* Debt orb: always inert — technical debt is not yet computed (no dialog to open). */}
              <span
                className={cn(orbBase, orbNeutral)}
                title="Technical debt (not yet computed)"
                aria-label="Technical debt not yet computed"
              >
                —
              </span>
              <p className={orbLabel}>Debt</p>
            </div>

            <div className="ml-auto flex flex-col items-end gap-2 self-center">
              <p
                className="shrink-0 text-right text-xs text-gray-400 dark:text-gray-500"
                data-testid="catalog-card-versions-count"
                title={versionsLabel}
              >
                <span className="font-semibold font-mono tabular-nums text-gray-700 dark:text-gray-200">
                  {versionsCount}
                </span>{' '}
                {versionsCount === 1 ? 'version' : 'versions'}
              </p>
              {conversionSlot ? <div className="flex items-center">{conversionSlot}</div> : null}
            </div>
          </div>
        </div>
      </div>

      <div
        className={cn(
          'flex items-center justify-between border-t px-5 py-3 text-xs',
          attentionVisual
            ? 'border-amber-200/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-900/10'
            : 'border-gray-100 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/40'
        )}
      >
        {/* Footer (MFI-24.5): creator chip on the left, updated-relative on the right (per the mockup). */}
        <span className="flex min-w-0 items-center gap-2 text-gray-500 dark:text-gray-400">
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-2xs font-semibold text-white ring-2 ring-white dark:ring-gray-800"
            aria-hidden
          >
            {(creatorInitials.slice(0, 2) || '?').toUpperCase()}
          </span>
          <span className="truncate">imported by {item.creator_name || 'Unknown'}</span>
        </span>
        <span className="shrink-0 pl-2 text-gray-500 dark:text-gray-400" title={item.updated_at}>
          updated {formatRelativeTime(item.updated_at) ?? '—'}
        </span>
      </div>
    </article>
  );
}
