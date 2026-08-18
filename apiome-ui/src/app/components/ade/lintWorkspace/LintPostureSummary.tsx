'use client';

import * as React from 'react';
import { FileCheck2, Layers, ShieldAlert, Sparkles } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card } from '@/app/components/ui/Card';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { Stat, StatGrid } from '@/app/components/ui/metrics';
import {
  STATUS_TONE_SOFT_CLASS,
  STATUS_TONE_TEXT_CLASS,
} from '@/app/components/ui/statusVocabulary';
import type { LintWorkspaceSummary } from '@/app/utils/lint-workspace';
import { cn } from '@lib/utils';

import {
  axisChips,
  gradeChips,
  postureTiles,
  type PostureDrillTarget,
  type PostureTileIcon,
} from './lintWorkspaceModel';

/**
 * The posture summary — HIVE-5.8 (#5311).
 *
 * Authority: `docs/mockups/govern/lint-posture.html`, the `.stat-grid--4` strip and the
 * grades/axes card under it.
 *
 * ### What changed from the strip this replaces
 *
 * Four hand-built panels of `text-2xl font-semibold text-gray-900` with two hard-coded
 * callout colours (`text-rose-600` / `text-emerald-600`), a grade row that only drew the
 * bands that happened to occur, and axis chips in `bg-indigo-100 text-indigo-800`. It is now
 * the shared {@link Stat} strip, the shared grade bands and the shared status tones, so the
 * same B is the same green here as in the catalog table and the strip follows all nine
 * themes.
 *
 * ### Every tile is a drill-down
 *
 * The mockup makes all four buttons, and the two that were plain `div`s here — missing
 * coverage and, before this, the grade chips — were exactly the ones a reader most wants to
 * act on: a number with no way to see what it counts is a number you have to trust. Pressing
 * a tile *replaces* the filter bundle rather than adding to it (see `drillDownFilters`), so
 * the queue below answers the question the tile asked and not that question narrowed by
 * whatever three chips were already on.
 */

/** Props for {@link LintPostureSummary}. */
export interface LintPostureSummaryProps {
  /** The posture summary, or `null` while it is still being read. */
  summary: LintWorkspaceSummary | null;
  /** True while the first read is in flight — draws the strip's own shape, not a spinner. */
  loading?: boolean;
  /** Jump the queue to a tile's canned filter. */
  onDrillDown: (target: PostureDrillTarget) => void;
}

/** The glyph each tile leads with, resolved from the model's element-free name. */
const TILE_ICON: Readonly<Record<PostureTileIcon, React.ComponentType<{ className?: string }>>> = {
  'shield-alert': ShieldAlert,
  layers: Layers,
  sparkles: Sparkles,
  'file-check': FileCheck2,
};

/**
 * The strip's own shape while the summary is being read.
 *
 * @returns Four placeholder tiles and the card beneath them.
 */
function SummarySkeleton() {
  return (
    <div className="lw-summary" data-testid="lint-workspace-summary-skeleton">
      <StatGrid columns={4} aria-hidden>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="lw-tile-skeleton">
            <Skeleton className="lw-tile-skeleton__label" />
            <Skeleton className="lw-tile-skeleton__value" />
            <Skeleton className="lw-tile-skeleton__foot" />
          </div>
        ))}
      </StatGrid>
      <Card className="lw-bands">
        <Skeleton className="lw-bands__skeleton" />
        <Skeleton className="lw-bands__skeleton" />
      </Card>
    </div>
  );
}

/**
 * The four drill-down tiles, the grade distribution and the axis scores.
 *
 * @param props See {@link LintPostureSummaryProps}.
 * @returns The summary strip, or its skeleton, or nothing at all when the summary read
 *   failed — a posture header is supplementary, and the queue below is the page's substance.
 */
export default function LintPostureSummary({
  summary,
  loading = false,
  onDrillDown,
}: LintPostureSummaryProps) {
  if (loading && !summary) return <SummarySkeleton />;
  if (!summary) return null;

  const tiles = postureTiles(summary);
  const grades = gradeChips(summary);
  const axes = axisChips(summary);

  return (
    <div className="lw-summary" data-testid="lint-workspace-summary">
      <StatGrid columns={4} role="group" aria-label="Posture summary">
        {tiles.map((tile) => {
          const Icon = TILE_ICON[tile.icon];
          return (
            <Stat
              key={tile.target}
              as="button"
              className="lw-tile"
              data-testid={`summary-${tile.target}`}
              title={tile.drillHint}
              onClick={() => onDrillDown(tile.target)}
              label={tile.label}
              icon={<Icon aria-hidden />}
              value={
                <span className={tile.tone ? STATUS_TONE_TEXT_CLASS[tile.tone] : undefined}>
                  {tile.value}
                </span>
              }
              unit={tile.unit}
              footnote={tile.footnote}
              footnoteEnd={
                tile.footnoteEnd ? (
                  // The callout takes its tone's *soft ground*, not the bare ink. `--danger-fg`
                  // as loose 12px text on the surface measures 3.06:1 in High contrast — the
                  // finding `e2e/hive-lint-workspace.spec.ts` caught, and the same trap
                  // HIVE-5.4 and 5.5 each measured once. The figure above it keeps the bare
                  // ink because at 30px bold it is large text, where 3:1 is the bar.
                  <span
                    className={cn(
                      'lw-tile__callout',
                      tile.tone ? STATUS_TONE_SOFT_CLASS[tile.tone] : undefined
                    )}
                  >
                    {tile.footnoteEnd}
                  </span>
                ) : undefined
              }
            />
          );
        })}
      </StatGrid>

      <Card className="lw-bands">
        <section data-testid="summary-grades">
          <h2 className="lw-caps">Grades</h2>
          <div className="lw-chip-row">
            {grades.map((grade) => (
              <span key={grade.key} className="lw-grade-chip" data-grade={grade.key}>
                <span className={cn('lw-grade-chip__letter', grade.band.solidClass)}>
                  {grade.label}
                </span>
                <span className="lw-grade-chip__count">{grade.count}</span>
              </span>
            ))}
          </div>
        </section>
        <section data-testid="summary-axes">
          <h2 className="lw-caps">
            Axes <span className="lw-caps__aside">· average score</span>
          </h2>
          <div className="lw-chip-row">
            {axes.map((axis) => (
              <Badge
                key={axis.key}
                size="lg"
                variant={axis.assessed ? 'accent' : 'outline'}
                title={axis.title}
                data-testid={`summary-axis-${axis.key}`}
              >
                {axis.label}
              </Badge>
            ))}
          </div>
        </section>
      </Card>
    </div>
  );
}
