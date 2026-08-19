'use client';

/**
 * The catalog's four-figure stat strip (MFI-24.1; re-skinned HIVE-7.1, #5318).
 *
 * Authority: `docs/mockups/sources/catalog.html` §Stats row — *Cataloged items* with its
 * active/disabled badges, *Avg quality* as a tier-tinted `Grade · score`, *Formats
 * represented* with up to four family names, and *Converted to OpenAPI* with the
 * `promotion path` badge that names what the catalog is *for*.
 *
 * The numbers are {@link computeCatalogStats}, which predates this ticket and is unchanged:
 * every figure describes the **live** catalog, so turning "Show deleted" on does not move
 * them. What changed is that the four bespoke `rounded-xl border-gray-200 bg-white` cards and
 * their four hand-toned pill palettes are now {@link StatGrid} and {@link Badge} — one strip
 * shape and one status vocabulary, shared with the eleven other screens that draw one.
 *
 * Hidden on an empty catalog by the screen, not here: a strip of zeros above an empty state
 * says the same thing twice, and the empty state says it better.
 */

import * as React from 'react';
import { GitMerge, Gauge, Layers, Library } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Stat, StatGrid } from '@/app/components/ui/metrics';
import { gradeBand } from '@/app/components/ui/statusVocabulary';
import { computeCatalogStats, type CatalogStatsItem } from '@/app/utils/catalog-dashboard-stats';
import { cn } from '@lib/utils';

export interface CatalogStatsRowProps {
  /** The catalog list as fetched from `/api/catalog`; soft-deleted items are excluded. */
  items: readonly CatalogStatsItem[];
}

/**
 * Render the strip. See {@link CatalogStatsRowProps}.
 *
 * @returns Four stats in one grid.
 */
export function CatalogStatsRow({ items }: CatalogStatsRowProps) {
  const stats = computeCatalogStats(items);
  const band = gradeBand(stats.avgGrade);

  return (
    <StatGrid columns={4} aria-label="Catalog statistics" data-testid="catalog-stats-row">
      <Stat
        data-testid="catalog-stat-items"
        icon={<Library aria-hidden />}
        label="Cataloged items"
        value={stats.total}
        footnote={
          <span className="cat-stat__badges">
            <Badge status="ok">{stats.active} active</Badge>
            <Badge status="warn">{stats.disabled} disabled</Badge>
          </span>
        }
      />

      <Stat
        data-testid="catalog-stat-quality"
        icon={<Gauge aria-hidden />}
        label="Avg quality"
        value={
          stats.avgScore != null ? (
            <span className={cn('cat-stat__grade', band.textClass)}>
              {stats.avgGrade}
              <small>· {stats.avgScore}</small>
            </span>
          ) : (
            <span className="cat-quiet">—</span>
          )
        }
        footnote={`across ${stats.total} item${stats.total === 1 ? '' : 's'}`}
      />

      <Stat
        data-testid="catalog-stat-formats"
        icon={<Layers aria-hidden />}
        label="Formats represented"
        value={stats.formatCount}
        footnote={
          stats.sampleFormats.length > 0 ? (
            <Badge variant="outline" className="cat-stat__formats">
              {stats.sampleFormats.join(' · ')}
              {stats.formatCount > stats.sampleFormats.length ? ' …' : ''}
            </Badge>
          ) : (
            <span className="cat-quiet">No formats yet</span>
          )
        }
      />

      <Stat
        data-testid="catalog-stat-converted"
        icon={<GitMerge aria-hidden />}
        label="Converted to OpenAPI"
        value={stats.converted}
        footnote={<Badge status="info">promotion path</Badge>}
      />
    </StatGrid>
  );
}

export default CatalogStatsRow;
