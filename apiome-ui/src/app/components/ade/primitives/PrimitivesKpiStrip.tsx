'use client';

/**
 * The registry KPI strip (HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Registry — five tiles reading
 * *Core system types · Tenant types · Imported schemas · Properties bound · Unresolved `$ref`*.
 *
 * ### What this replaces
 *
 * A local `KpiCard` drawing `dashboardPanelClass` with `text-gray-600`, `text-indigo-600`,
 * `text-amber-600` and five differently-tinted lucide glyphs — a strip that could not follow a
 * theme and whose amber tile was a `next/link` to `?focus=resolver`, a query nothing on the
 * screen read. It is {@link Stat} / {@link StatGrid} now, which brings the density metrics, the
 * tabular figures and the 1 px hairline grid.
 *
 * ### Two decisions
 *
 * 1. **The amber tile is a button, not a link.** The mockup's *Adds* asks the unresolved tile to
 *    switch to the Resolver tab; a same-page pane switch is a button's job, and making it one is
 *    what finally makes the affordance do something.
 * 2. **The tile is marked, not washed.** The mockup fills it `--warn-soft`. Outside the light
 *    and dark themes the `-soft`/`-fg` pairs are not calibrated against the neutrals, so
 *    `--fg-muted` on `--warn-soft` measures about 1.1:1 — the label and the foot would be the
 *    least readable text on a screen whose whole point is to be noticed. It takes an inset
 *    `--warn` hairline instead, and the figure keeps the tone's ink, which at `--fs-4xl` bold is
 *    large text where 3:1 is the bar.
 */

import * as React from 'react';
import { AlertTriangle, Building2, Download, Link2, Shield } from 'lucide-react';

import { Skeleton } from '@/app/components/ui/Skeleton';
import { Stat, StatGrid } from '@/app/components/ui/metrics';
import { STATUS_TONE_TEXT_CLASS } from '@/app/components/ui/statusVocabulary';
import { cn } from '@lib/utils';
import type { RegistryCoverageStats } from '@/app/ade/dashboard/primitives/primitivesRegistryTypes';

import { registryKpis, type RegistryKpi } from './primitivesModel';

/** The glyph each tile carries, keyed by the model's tile id. */
const KPI_ICON: Readonly<Record<RegistryKpi['id'], React.ComponentType<{ className?: string }>>> = {
  core: Shield,
  tenant: Building2,
  imported: Download,
  bound: Link2,
  unresolved: AlertTriangle,
};

export interface PrimitivesKpiStripProps {
  /** The coverage stats, or `null` before the first read lands. */
  stats: RegistryCoverageStats | null;
  /** True while that read is in flight. */
  loading: boolean;
  /** Switch the screen to the Resolver tab — what the amber tile does. */
  onOpenResolver: () => void;
}

/**
 * Render the strip. See {@link PrimitivesKpiStripProps}.
 *
 * @returns Five tiles, or five skeletons shaped like them.
 */
export default function PrimitivesKpiStrip({
  stats,
  loading,
  onOpenResolver,
}: PrimitivesKpiStripProps) {
  const kpis = registryKpis(stats);

  if (loading || kpis.length === 0) {
    return (
      <StatGrid columns={5} aria-hidden data-testid="primitives-kpi-skeleton">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="prm-kpi-skeleton">
            <Skeleton className="prm-kpi-skeleton__label" />
            <Skeleton className="prm-kpi-skeleton__value" />
            <Skeleton className="prm-kpi-skeleton__foot" />
          </div>
        ))}
      </StatGrid>
    );
  }

  return (
    <StatGrid columns={5} role="group" aria-label="Registry coverage" data-testid="primitives-kpis">
      {kpis.map((kpi) => {
        const Icon = KPI_ICON[kpi.id];
        const value = kpi.tone ? (
          <span className={STATUS_TONE_TEXT_CLASS[kpi.tone]}>{kpi.value}</span>
        ) : (
          kpi.value
        );

        // Only the unresolved tile ever acts, and only when there is something to act on:
        // a button that filters nothing is a promise the Resolver tab cannot keep.
        if (kpi.alert) {
          return (
            <Stat
              key={kpi.id}
              as="button"
              className={cn('prm-kpi', 'prm-kpi--alert')}
              data-testid={`primitives-kpi-${kpi.id}`}
              onClick={onOpenResolver}
              title="Open the reference resolver"
              label={kpi.label}
              icon={<Icon aria-hidden />}
              value={value}
              footnote={kpi.foot}
            />
          );
        }

        return (
          <Stat
            key={kpi.id}
            className="prm-kpi"
            data-testid={`primitives-kpi-${kpi.id}`}
            label={kpi.label}
            icon={<Icon aria-hidden />}
            value={value}
            footnote={<span className="mono">{kpi.foot}</span>}
          />
        );
      })}
    </StatGrid>
  );
}
