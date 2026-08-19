'use client';

/**
 * The four figures above the repository list (HIVE-7.3, #5320).
 *
 * Authority: `docs/mockups/sources/repositories.html` §KPI strip — *Repositories* with its
 * provider-split hover, *Files indexed*, *Imports (30d)* permanently `—` with the reason, and
 * *Last scan* with a healthy / attention / never dot.
 *
 * ### Why this is `StatGrid` and not four cards
 *
 * The strip this replaces was four bordered `RepositoryKpiCard`s in a `grid gap-4`, each a
 * separate object with its own shadow. `ui/metrics`'s {@link StatGrid} draws them as one strip
 * with hairlines between (HIVE-2.6), which is what DESIGN.md §8 asks a list page for — and it
 * brings the tabular figure, the caps label and the density metrics for free.
 *
 * ### Imports (30d) is honest about being unwired
 *
 * There is no import-event aggregation per tenant and repository yet, so the figure is an em
 * dash with {@link IMPORTS_30D_TOOLTIP} on it — the stub the screen this replaces already drew,
 * kept verbatim per the mockup's **Keeps (1:1)** list. Drawing a `0` there would be a
 * measurement, and there is none.
 */

import * as React from 'react';
import { FileStack, FolderGit2, Radar, Upload } from 'lucide-react';

import { Stat, StatGrid } from '@/app/components/ui/metrics';
import { STATUS_TONE_DOT_CLASS } from '@/app/components/ui/statusVocabulary';
import { cn } from '@lib/utils';

import {
  FILES_INDEXED_FOOTNOTE,
  FILES_INDEXED_TOOLTIP,
  IMPORTS_30D_PLACEHOLDER,
  IMPORTS_30D_TOOLTIP,
  repositoryKpis,
  type DashboardRepository,
} from './repositoriesModel';

export interface RepositoryKpiStripProps {
  /** Every registered repository — a KPI answers for the workspace, not for the filtered view. */
  repositories: readonly DashboardRepository[];
}

/**
 * Render the strip. See {@link RepositoryKpiStripProps}.
 *
 * @returns The four stats, as one hairlined strip.
 */
export function RepositoryKpiStrip({ repositories }: RepositoryKpiStripProps) {
  const kpis = React.useMemo(() => repositoryKpis(repositories), [repositories]);

  return (
    <StatGrid columns={4} data-testid="repositories-kpis">
      <Stat
        label="Repositories"
        icon={<FolderGit2 aria-hidden />}
        value={kpis.count.toLocaleString()}
        footnote={kpis.providerSplit}
        title={kpis.providerTooltip}
        data-testid="repositories-kpi-count"
      />
      <Stat
        label="Files indexed"
        icon={<FileStack aria-hidden />}
        value={kpis.files.toLocaleString()}
        footnote={FILES_INDEXED_FOOTNOTE}
        title={FILES_INDEXED_TOOLTIP}
        data-testid="repositories-kpi-files"
      />
      <Stat
        label="Imports (30d)"
        icon={<Upload aria-hidden />}
        value={<span className="repo-kpi__unwired">{IMPORTS_30D_PLACEHOLDER}</span>}
        footnote="aggregation not wired yet"
        title={IMPORTS_30D_TOOLTIP}
        data-testid="repositories-kpi-imports"
      />
      <Stat
        label="Last scan"
        icon={<Radar aria-hidden />}
        value={kpis.lastScanLabel}
        footnote={
          <span className="repo-kpi__note">
            <span
              aria-hidden
              className={cn('repo-kpi__dot', STATUS_TONE_DOT_CLASS[kpis.lastScanTone])}
            />
            {kpis.lastScanNote}
          </span>
        }
        data-testid="repositories-kpi-last-scan"
      />
    </StatGrid>
  );
}

export default RepositoryKpiStrip;
