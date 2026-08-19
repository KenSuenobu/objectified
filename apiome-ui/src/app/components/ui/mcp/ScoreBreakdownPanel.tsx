'use client';

/**
 * Score & lint breakdown panel (V2-MCP-31.3 / MCAT-17.3).
 *
 * "Where did this server's quality grade come from?" The Lint & Score tab (MCAT-10.4) shows the
 * single 0-100 grade; this panel — in the endpoint **Insight** tab's *Reliability & trust* section —
 * decomposes it. From the version's persisted `mcp_version_scores.report` (fetched through the same
 * lint route the Lint tab uses) it renders three views over the report's findings:
 *
 * - a **score reconstruction headline** — the grade gauge plus the point total the findings
 *   deducted, reconstructed by replaying the scorer's model so the breakdown agrees with the grade;
 * - **points lost by rule group** — a severity-tinted bar per rule category showing which groups
 *   (naming / structure / annotations / security / hygiene) cost the most points; and
 * - **findings by severity** — a `BarSeries` of the MUST / SHOULD / advisory tally, over a
 *   drill-down list of the findings themselves, each linking to the offending capability item.
 *
 * All the arithmetic lives in the pure, unit-tested helpers in {@link mcpLintUi} (`mcpLintScoreBreakdown`,
 * `mcpLintTierCounts`, `mcpLintGroupByTier`, `mcpLintFindingTarget`), so the bars, the tallies, and the
 * reconstructed score can never disagree with the findings the list shows. The component owns its
 * loading / error / empty states — an unscored version shows an "unavailable" state and a clean report
 * (no findings) shows a "clean bill of health" state. Legacy reports whose stored grade predates the
 * current scorer still render: the stored grade leads and the breakdown attributes the deductions it
 * can, so an older report degrades gracefully rather than erroring.
 */

import * as React from 'react';
import { ArrowUpRight, CheckCircle2, Gauge, ListChecks, ShieldCheck } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { GradeGlyph } from '@/app/components/ui/mcp/GradeGlyph';
import { FindingSeverity } from '@/app/components/ui/mcp/FindingSeverity';
import { BarSeries, type BarDatum, type ChartSeriesTone } from '@/app/components/ui/mcp/charts';
import { getNumericScoreTier } from '@/app/utils/numeric-score-tier';
import { MCP_LINT_TIER_LABEL } from '@/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import {
  MCP_LINT_TIER_ORDER,
  mcpLintFindingTarget,
  mcpLintGroupByTier,
  mcpLintScoreBreakdown,
  mcpLintTierCounts,
  type McpLintFinding,
  type McpLintReport,
  type McpLintScoreCategory,
  type McpLintTier,
} from '@/app/components/ade/dashboard/mcp/mcpLintUi';

/** Invoked when a finding links to its offending capability item (deep-link to the Capabilities tab). */
export type McpScoreNavigateToItem = (itemType: string, name: string) => void;

interface Props {
  /** The selected snapshot's lint report, or `null` while it has not loaded / is unavailable. */
  report: McpLintReport | null;
  loading: boolean;
  error: string | null;
  /** Deep-link a finding to its offending capability item on the Capabilities tab (optional). */
  onNavigateToItem?: McpScoreNavigateToItem;
}

/** The BarSeries tone each requirement tier paints its severity-distribution bar with. */
const TIER_TONE: Record<McpLintTier, ChartSeriesTone> = {
  must: 'red',
  should: 'amber',
  advisory: 'neutral',
};

/** One rule-group row in the "points lost by rule group" breakdown: label, point cost, and its bar. */
function CategoryCostRow({ category }: { category: McpLintScoreCategory }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-fg-muted">{category.label}</span>
        <span className="flex items-center gap-1.5 text-fg-muted">
          <span className="tabular-nums">
            {category.findingCount} {category.findingCount === 1 ? 'finding' : 'findings'}
          </span>
          <span
            className="font-semibold tabular-nums text-fg"
            title={
              category.capped
                ? `−${category.points} pts (capped from −${category.rawPoints})`
                : `−${category.points} pts`
            }
          >
            −{category.points}
            {category.capped ? '*' : ''}
          </span>
        </span>
      </div>
      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-inset"
        role="presentation"
      >
        <div
          className={`h-full rounded-full ${category.barClass} transition-all duration-500`}
          style={{ width: `${category.percent}%` }}
        />
      </div>
    </div>
  );
}

/** One finding row in the drill-down list, linking to its offending capability item when resolvable. */
function FindingLinkRow({
  finding,
  rowClass,
  onNavigateToItem,
}: {
  finding: McpLintFinding;
  rowClass: string;
  onNavigateToItem?: McpScoreNavigateToItem;
}) {
  const target = mcpLintFindingTarget(finding.path);
  return (
    <div className={`rounded-md p-2.5 ${rowClass}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono rounded-sm bg-inset px-1.5 py-0.5 text-2xs text-fg-muted">
          {finding.rule}
        </span>
        {target && onNavigateToItem ? (
          <button
            type="button"
            onClick={() => onNavigateToItem(target.item_type, target.name)}
            className="mono inline-flex items-center gap-1 rounded-sm text-2xs font-medium text-accent-fg hover:underline"
            title={`Jump to ${finding.path} in Capabilities`}
          >
            {finding.path}
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </button>
        ) : (
          <span className="font-mono text-2xs text-fg-muted">{finding.path}</span>
        )}
      </div>
      <p className="mt-1 text-xs text-fg">{finding.message}</p>
    </div>
  );
}

/**
 * The score & lint breakdown panel. See the module doc for the acceptance criteria it satisfies —
 * the breakdown reconstructs the report faithfully, the severity counts match, and legacy / empty
 * reports degrade gracefully.
 */
export function ScoreBreakdownPanel({ report, loading, error, onNavigateToItem }: Props) {
  if (loading && !report) {
    return <LoadingState minHeightClassName="min-h-[200px]" message="Loading score breakdown…" />;
  }
  if (error || !report) {
    return (
      <EmptyState
        variant="compact"
        icon={<ShieldCheck className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="Score breakdown unavailable"
        description={
          error ??
          "This snapshot has not been scored yet, so there is no grade to break down. Run discovery to capture a quality report."
        }
      />
    );
  }

  const breakdown = mcpLintScoreBreakdown(report.findings);
  const tierCounts = mcpLintTierCounts(report.findings);
  const tier = getNumericScoreTier(report.score);
  const clean = report.findings.length === 0;

  // Findings-by-severity distribution — derived from the findings so the tally always agrees with
  // the drill-down list below (and with the report's own severity_counts, for a current report).
  const severityBars: BarDatum[] = MCP_LINT_TIER_ORDER.map((t) => ({
    label: MCP_LINT_TIER_LABEL[t],
    value: tierCounts[t],
    tone: TIER_TONE[t],
  }));

  const tierGroups = mcpLintGroupByTier(report.findings);

  return (
    <div className="space-y-5" aria-busy={loading}>
      {/* Score reconstruction headline — the grade gauge and the point total the findings deducted. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-4">
          <GradeGlyph variant="gauge" size="lg" grade={report.grade} score={report.score} />
          <div className="min-w-0">
            <div className={`text-sm font-semibold ${tier.textClass}`}>
              {tier.shortLabel} — {tier.detailLabel}
            </div>
            <p className="mt-0.5 text-xs text-fg-muted">
              {clean ? (
                'A clean surface — no rule deducted any points.'
              ) : (
                <>
                  <span className="font-semibold tabular-nums text-fg">
                    −{breakdown.totalPenalty}
                  </span>{' '}
                  {breakdown.totalPenalty === 1 ? 'point' : 'points'} deducted across{' '}
                  <span className="font-semibold tabular-nums text-fg">
                    {breakdown.categories.length}
                  </span>{' '}
                  {breakdown.categories.length === 1 ? 'rule group' : 'rule groups'}
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FindingSeverity tier="must" count={tierCounts.must} />
          <FindingSeverity tier="should" count={tierCounts.should} />
          <FindingSeverity tier="advisory" count={tierCounts.advisory} />
        </div>
      </div>

      {clean ? (
        <EmptyState
          variant="compact"
          icon={<CheckCircle2 className="h-8 w-8 text-fg-on-accent" aria-hidden />}
          title="No findings"
          description="This snapshot's surface passes every lint rule — a clean bill of health, nothing deducted the grade."
        />
      ) : (
        <>
          {/* Points lost by rule group — which categories cost the most points. */}
          {breakdown.categories.length > 0 ? (
            <div className="space-y-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
                <Gauge className="size-3.5 text-fg-muted" aria-hidden />
                Points lost by rule group
                {breakdown.categories.some((c) => c.capped) ? (
                  <span className="font-normal text-fg-subtle">
                    * capped per rule
                  </span>
                ) : null}
              </div>
              <div className="space-y-2.5">
                {breakdown.categories.map((category) => (
                  <CategoryCostRow key={category.category} category={category} />
                ))}
              </div>
            </div>
          ) : null}

          {/* Findings by severity — the MUST / SHOULD / advisory distribution. */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
              <ListChecks className="size-3.5 text-fg-muted" aria-hidden />
              Findings by severity
            </div>
            <BarSeries
              data={severityBars}
              title="Findings by severity — MUST, SHOULD, and advisory counts"
              className="h-24"
            />
            <div className="flex justify-between gap-x-2 text-2xs text-fg-subtle">
              {severityBars.map((bar) => (
                <span key={bar.label} className="tabular-nums">
                  {bar.label}
                </span>
              ))}
            </div>
          </div>

          {/* Drill-down list — the findings themselves, grouped by severity, each linking to its item. */}
          <div className="space-y-3">
            {tierGroups
              .filter((group) => group.findings.length > 0)
              .map((group) => (
                <div key={group.meta.key} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <FindingSeverity tier={group.meta.key} count={group.findings.length} />
                    <span className="text-2xs text-fg-muted">
                      {group.meta.description}
                    </span>
                  </div>
                  <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                    {group.findings.map((finding) => (
                      <FindingLinkRow
                        key={finding.id}
                        finding={finding}
                        rowClass={group.meta.rowClass}
                        onNavigateToItem={onNavigateToItem}
                      />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
