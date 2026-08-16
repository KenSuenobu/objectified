'use client';

/**
 * Catalog stats row — four metric cards (MFI-24.1, #4081).
 *
 * Renders the four-card grid the mockup opens the Catalog list with (`renderCatalog`,
 * `docs/planning/mockups/multi-format-import/index.html:1407-1422`): cataloged items (with
 * active/disabled sub-badges), average quality (letter · score), formats represented (distinct
 * `sourceFormat` count + a sample badge) and converted-to-OpenAPI (indigo "promotion path" badge).
 *
 * The numbers come from {@link computeCatalogStats}, a pure function computed from the
 * already-fetched list — no new API. The cards collapse to two columns on small screens and one on
 * the narrowest, mirroring the responsive stats grids used elsewhere in the dashboard.
 */

import { FileJson2 } from 'lucide-react';
import { computeCatalogStats, type CatalogStatsItem } from '@/app/utils/catalog-dashboard-stats';

/** A single stat card: a big number/value, a label, and a detail row of badges. */
function StatCard({
  value,
  label,
  detail,
  testId,
}: {
  value: React.ReactNode;
  label: string;
  detail: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="text-2xl font-semibold tabular-nums leading-none text-gray-900 dark:text-white">
        {value}
      </div>
      <div className="mt-1.5 text-2xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">{detail}</div>
    </div>
  );
}

/** A small rounded pill in one of the stat-row's tints. */
function StatBadge({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'slate' | 'indigo';
  children: React.ReactNode;
}) {
  const toneClass = {
    green:
      'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    amber:
      'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    slate:
      'bg-gray-100 text-gray-600 dark:bg-gray-700/60 dark:text-gray-300',
    indigo:
      'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

/**
 * The four-card Catalog stats grid.
 *
 * @param items The catalog list as fetched from `/api/catalog`; soft-deleted items are excluded
 *   from the headline metrics by {@link computeCatalogStats}.
 */
export function CatalogStatsRow({ items }: { items: readonly CatalogStatsItem[] }) {
  const stats = computeCatalogStats(items);

  return (
    <section
      data-testid="catalog-stats-row"
      aria-label="Catalog statistics"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      <StatCard
        testId="catalog-stat-items"
        value={stats.total}
        label="Cataloged items"
        detail={
          <>
            <StatBadge tone="green">{stats.active} active</StatBadge>
            <StatBadge tone="amber">{stats.disabled} disabled</StatBadge>
          </>
        }
      />

      <StatCard
        testId="catalog-stat-quality"
        value={
          stats.avgScore != null ? (
            <span className={stats.avgTier?.textClass ?? ''}>
              {stats.avgGrade} · {stats.avgScore}
            </span>
          ) : (
            <span className="text-gray-400 dark:text-gray-600">—</span>
          )
        }
        label="Avg quality"
        detail={
          <span className="text-2xs text-gray-500 dark:text-gray-400">
            across {stats.total} item{stats.total === 1 ? '' : 's'}
          </span>
        }
      />

      <StatCard
        testId="catalog-stat-formats"
        value={stats.formatCount}
        label="Formats represented"
        detail={
          stats.sampleFormats.length > 0 ? (
            <StatBadge tone="slate">
              {stats.sampleFormats.join(' · ')}
              {stats.formatCount > stats.sampleFormats.length ? ' …' : ''}
            </StatBadge>
          ) : (
            <span className="text-2xs text-gray-400 dark:text-gray-600">No formats yet</span>
          )
        }
      />

      <StatCard
        testId="catalog-stat-converted"
        value={stats.converted}
        label="Converted to OpenAPI"
        detail={
          <StatBadge tone="indigo">
            <FileJson2 className="h-3 w-3 shrink-0" aria-hidden />
            promotion path
          </StatBadge>
        }
      />
    </section>
  );
}

export default CatalogStatsRow;
