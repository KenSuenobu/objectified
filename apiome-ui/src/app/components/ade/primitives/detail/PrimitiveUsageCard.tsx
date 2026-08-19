'use client';

/**
 * The "Used in" strip of the primitive-detail page (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html` §Used in — dependent types, properties
 * and tenants, as three tiles.
 *
 * The three figures were `text-2xl font-bold font-mono text-indigo-600` over `bg-gray-50
 * dark:bg-gray-900/40` wells, with the caption below in `text-2xs text-gray-500`. They are
 * {@link Stat} / {@link StatGrid} now, which is where the tabular figures, the density metrics
 * and the hairline grid come from — and where the KPI strip on the registry screen already
 * draws its five. The counts themselves are `summarizeUsage`'s and are unchanged.
 */

import * as React from 'react';
import { BarChart3 } from 'lucide-react';

import { Card, CardBody, CardHeader } from '@/app/components/ui/Card';
import { Stat, StatGrid } from '@/app/components/ui/metrics';
import type { UsageSummary } from '@/app/ade/dashboard/primitives/primitiveDetailModel';

import { usageTiles } from './primitiveDetailView';

export interface PrimitiveUsageCardProps {
  /** The summarised counters. */
  usage: UsageSummary;
}

/**
 * Render the card. See {@link PrimitiveUsageCardProps}.
 *
 * @returns Three tiles in a hairline grid.
 */
export default function PrimitiveUsageCard({ usage }: PrimitiveUsageCardProps) {
  return (
    <Card data-testid="primitive-detail-usage">
      <CardHeader className="pd-head">
        <h2 className="prm-panel-head__title">
          <BarChart3 aria-hidden />
          Used in
        </h2>
      </CardHeader>
      <CardBody>
        <StatGrid columns={3} className="pd-usage" role="group" aria-label="Usage">
          {usageTiles(usage).map((tile) => (
            <Stat
              key={tile.id}
              data-testid={`primitive-detail-usage-${tile.id}`}
              label={tile.label}
              value={tile.value}
            />
          ))}
        </StatGrid>
      </CardBody>
    </Card>
  );
}
