'use client';

/**
 * The five figures above the repository detail tabs (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §KPI row — *Files indexed*,
 * *Importable estimate* with its placeholder-split tooltip, *Branches* (GitHub only),
 * *Imports (30d)* with its distinct-project count, and *Last scan*.
 *
 * ### Why this is `StatGrid` and not five cards
 *
 * The strip this replaces was five bordered `RepositoryKpiCard`s in a `grid gap-4`, each a
 * separate object with its own shadow, and three of them named `text-indigo-600
 * dark:text-indigo-400` for the figure. `ui/metrics`'s {@link StatGrid} draws them as one
 * strip with hairlines between (HIVE-2.6) — what DESIGN.md §8 asks a detail page for — and it
 * brings the tabular figure, the caps label and the density metrics for free. The same move
 * HIVE-7.3 made for the list page's four, so the two screens' strips are one object.
 *
 * ### A figure that is not measured says so
 *
 * Every value, footnote and tooltip comes from {@link repositoryDetailKpis}, which marks a
 * stat `unwired` when its figure is an em dash standing in for something the API cannot answer
 * yet. That reaches the DOM as `data-unwired`, so the honesty is testable rather than a
 * convention — the ticket's "stubbed controls remain visually honest" criterion applied to the
 * one part of the screen that is all numbers.
 *
 * A scan in progress is a third state: the figure is real but still moving, so it is drawn with
 * a spinner beside the label rather than replaced by one. Blanking a figure that is merely
 * out of date loses information a reader already had.
 */

import * as React from 'react';
import { FileStack, GitBranch, Loader2, Radar, Upload, Wand2 } from 'lucide-react';

import { Stat, StatGrid } from '@/app/components/ui/metrics';
import { cn } from '@lib/utils';

import {
  repositoryDetailKpis,
  type RepositoryDetailKpi,
  type RepositoryDetailKpiInputs,
} from './repositoryDetailModel';
import type { DashboardRepository } from './repositoriesModel';

/** The glyph each figure leads with. */
const KPI_ICON: Readonly<
  Record<RepositoryDetailKpi['key'], React.ComponentType<{ 'aria-hidden'?: boolean }>>
> = {
  files: FileStack,
  importable: Wand2,
  branches: GitBranch,
  imports: Upload,
  scan: Radar,
};

export interface RepositoryDetailKpiStripProps extends RepositoryDetailKpiInputs {
  /** The repository whose figures these are. */
  repository: DashboardRepository;
}

/**
 * Render the strip. See {@link RepositoryDetailKpiStripProps}.
 *
 * @returns The five stats, as one hairlined strip.
 */
export function RepositoryDetailKpiStrip({
  repository,
  ...inputs
}: RepositoryDetailKpiStripProps) {
  const kpis = React.useMemo(
    () => repositoryDetailKpis(repository, inputs),
    // The inputs object is rebuilt on every render by the caller's JSX, so the memo keys on
    // its four fields rather than on its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      repository,
      inputs.stats30d,
      inputs.importsLoading,
      inputs.importableMix,
      inputs.lastScanLabel,
    ]
  );

  return (
    <StatGrid columns={5} data-testid="repository-detail-kpis">
      {kpis.map((kpi) => {
        const Icon = KPI_ICON[kpi.key];
        return (
          <Stat
            key={kpi.key}
            label={kpi.label}
            icon={
              kpi.pending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Icon aria-hidden />
              )
            }
            value={
              <span className={cn(kpi.unwired && 'repo-kpi__unwired')}>{kpi.value}</span>
            }
            footnote={kpi.footnote}
            title={kpi.tooltip}
            data-unwired={kpi.unwired || undefined}
            data-pending={kpi.pending || undefined}
            data-testid={`repository-detail-kpi-${kpi.key}`}
          />
        );
      })}
    </StatGrid>
  );
}

export default RepositoryDetailKpiStrip;
