'use client';

/**
 * Endpoint-detail "Lint & score" tab (V2-MCP-24.4 / MCAT-10.4; re-skinned by HIVE-7.8, #5325).
 *
 * A version snapshot's deterministic quality report: the gauge and its provenance, the
 * MUST/SHOULD/Advisory tallies, the score axes and their coverage, the per-category count bars,
 * and the findings themselves — each linking to the capability item it flags.
 *
 * Presentational: the report is fetched by the detail page, so the same read drives the summary
 * strip's grade tile and this tab.
 *
 * ### What HIVE-7.8 changed
 *
 * Authority: `docs/mockups/sources/mcp-endpoint.html`'s Lint & Score panel.
 *
 * 1. **Every panel was a `dashboardPanelPaddedClass` div** — `bg-white … dark:bg-gray-800`
 *    spelled through a shared string that names two palettes. They are `ui/Card`.
 * 2. **The four tallies were four hand-rolled tiles.** They are `StatGrid` + `Stat`, the same
 *    object the summary strip above them uses, so the two strips have one rhythm.
 * 3. **The category bars were a raw `Progress.Root` on a `bg-gray-200 dark:bg-gray-700`
 *    track.** They are `ui/metrics`' `Meter`, which is the mockup's `.meter` — including the
 *    part this one left out: the figure beside the bar, and a `role="meter"` that reads it.
 * 4. **A finding row was a tinted band** (`border-l-4 border-red-500 bg-red-50 …`). The tone is
 *    on the tier badge and on a 2 px leading rule now; a queue of eight findings is legible.
 * 5. **The band label was `getNumericScoreTier(...).textClass`** — `text-green-600
 *    dark:text-green-400` and its three siblings. That module is shared with the catalog,
 *    projects and six other surfaces, so re-tokening it belongs to its own ticket; this screen
 *    stops *spending* it instead, and takes the grade band's own tone from
 *    `ui/statusVocabulary`, which is what paints the gauge beside it.
 */

import { ClipboardList, Fingerprint, Gauge, ShieldCheck } from 'lucide-react';
import { Badge } from '@/app/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Meter, Stat, StatGrid } from '@/app/components/ui/metrics';
import { GradeGlyph } from '@/app/components/ui/mcp/GradeGlyph';
import { FindingSeverity } from '@/app/components/ui/mcp/FindingSeverity';
import { getNumericScoreTier } from '@/app/utils/numeric-score-tier';
import {
  mcpLintCategoryBars,
  mcpLintFindingTarget,
  mcpLintGroupByTier,
  mcpLintTierCounts,
  mcpLintTierMeta,
  type McpLintFinding,
  type McpLintReport,
  type McpLintTier,
} from '@/app/components/ade/dashboard/mcp/mcpLintUi';
import { lintAxisEvaluationFromLintReport } from '@/app/utils/lint-axis-ui';
import { LintAxisCoveragePanel } from '@/app/components/ade/dashboard/lint/LintAxisCoveragePanel';
import type { MetricTone } from '@/app/components/ui/metrics';

/** Invoked when a finding links to its offending capability item (deep-link to Capabilities). */
export type NavigateToItem = (itemType: string, name: string) => void;

/** Format the report's scored-at instant for the header metadata; null-safe. */
function formatScoredAt(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleString();
}

/**
 * The report header: the grade gauge with its score-band label, and the report's provenance
 * (version, scored-at, stored vs computed, fingerprint).
 *
 * @param props.report The lint report.
 * @returns The header card.
 */
function ReportHeader({ report }: { report: McpLintReport }) {
  const tier = getNumericScoreTier(report.score);
  const scoredAt = formatScoredAt(report.scored_at);
  const versionLabel = report.version_tag ?? `v${report.version_seq}`;
  return (
    <Card data-testid="mcp-lint-header">
      <CardBody className="flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-5">
          <GradeGlyph variant="gauge" size="lg" grade={report.grade} score={report.score} />
          <div className="min-w-0">
            {/* The band's words, in the page's ink. The *tone* is on the gauge's arc beside it
                — see the module note on `numeric-score-tier`. */}
            <p className="text-lg font-semibold text-fg">
              {tier.shortLabel} — {tier.detailLabel}
            </p>
            <p className="mt-1 max-w-prose text-sm text-fg-muted">
              Deterministic quality score for this version&apos;s capability surface.{' '}
              {tier.rangeLabel} band.
            </p>
          </div>
        </div>
        <dl className="grid shrink-0 grid-cols-1 gap-x-8 gap-y-2 text-sm">
          <div className="flex items-center justify-between gap-6">
            <dt className="text-2xs uppercase tracking-[var(--track-caps)] text-fg-muted">
              Version
            </dt>
            <dd className="font-medium text-fg">{versionLabel}</dd>
          </div>
          {scoredAt ? (
            <div className="flex items-center justify-between gap-6">
              <dt className="text-2xs uppercase tracking-[var(--track-caps)] text-fg-muted">
                Scored
              </dt>
              <dd className="text-fg-muted">{scoredAt}</dd>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-6">
            <dt className="text-2xs uppercase tracking-[var(--track-caps)] text-fg-muted">
              Source
            </dt>
            <dd>
              <Badge
                variant="outline"
                title="Whether the report was served from persistence or scored live"
              >
                {report.source === 'stored' ? 'Stored report' : 'Computed live'}
              </Badge>
            </dd>
          </div>
          {report.report_fingerprint ? (
            <div className="flex items-center justify-between gap-6">
              <dt className="flex items-center gap-1 text-2xs uppercase tracking-[var(--track-caps)] text-fg-muted">
                <Fingerprint aria-hidden className="size-3.5" />
                Fingerprint
              </dt>
              <dd
                className="mono max-w-40 truncate text-xs text-fg-muted"
                title={`Report fingerprint: ${report.report_fingerprint}`}
              >
                {report.report_fingerprint}
              </dd>
            </div>
          ) : null}
        </dl>
      </CardBody>
    </Card>
  );
}

/** The MUST / SHOULD / Advisory / rules-triggered summary strip under the header. */
function SummaryTiles({ report }: { report: McpLintReport }) {
  const counts = mcpLintTierCounts(report.findings);
  const rulesTriggered = Object.keys(report.rule_hits).length;
  const tiers: McpLintTier[] = ['must', 'should', 'advisory'];
  return (
    <StatGrid columns={4} data-testid="mcp-lint-tallies">
      {tiers.map((tier) => (
        <Stat
          key={tier}
          label={mcpLintTierMeta(tier).label}
          value={counts[tier]}
          footnote={mcpLintTierMeta(tier).description}
        />
      ))}
      <Stat
        label="Rules triggered"
        icon={<ClipboardList aria-hidden />}
        value={rulesTriggered}
        footnote="Distinct lint rules with at least one finding."
      />
    </StatGrid>
  );
}

/**
 * The per-category count bars, tinted by the worst severity present in each category.
 *
 * @param props.findings Every finding in the report.
 * @returns The bars card, or `null` when there is nothing to chart.
 */
function CategoryBars({ findings }: { findings: McpLintFinding[] }) {
  const bars = mcpLintCategoryBars(findings);
  if (bars.length === 0) return null;
  return (
    <Card data-testid="mcp-lint-categories">
      <CardHeader className="flex-row items-center gap-2">
        <Gauge aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
        <CardTitle>Findings by category</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {bars.map((bar) => (
          <Meter
            key={bar.category}
            label={bar.label}
            showLabel
            value={bar.percent}
            valueLabel={String(bar.count)}
            valueText={`${bar.count} ${bar.count === 1 ? 'finding' : 'findings'}`}
            // A *score*, not a load: the bands would read backwards, so the tone is the tier's.
            tone={mcpLintTierMeta(mcpLintSeverityTier(bar.severity)).tone as MetricTone}
            warnAt={null}
          />
        ))}
      </CardBody>
    </Card>
  );
}

/** Map a finding severity to its requirement tier (`error` → must, `warning` → should). */
function mcpLintSeverityTier(severity: string): McpLintTier {
  if (severity === 'error') return 'must';
  if (severity === 'warning') return 'should';
  return 'advisory';
}

/**
 * One finding: its rule, the capability it flags, and the message.
 *
 * @param props.rowClass        The tier's leading rule, from `mcpLintTierMeta`.
 * @param props.onNavigateToItem Deep-link handler, when the path resolves to an item.
 * @returns The finding row.
 */
function FindingRow({
  finding,
  rowClass,
  onNavigateToItem,
}: {
  finding: McpLintFinding;
  rowClass: string;
  onNavigateToItem?: NavigateToItem;
}) {
  const target = mcpLintFindingTarget(finding.path);
  return (
    <li className={`mcp-finding ${rowClass}`} data-testid={`mcp-finding-${finding.id}`}>
      <div className="mcp-finding__head">
        <span className="mono text-2xs text-fg-muted">{finding.rule}</span>
        {target && onNavigateToItem ? (
          <button
            type="button"
            onClick={() => onNavigateToItem(target.item_type, target.name)}
            className="mono rounded-sm text-xs font-medium text-accent-fg hover:underline"
            title={`Jump to ${finding.path} in Capabilities`}
          >
            {finding.path} ↗
          </button>
        ) : (
          <span className="mono text-xs text-fg-muted">{finding.path}</span>
        )}
      </div>
      <p className="mcp-finding__message">{finding.message}</p>
    </li>
  );
}

/** One requirement-tier section (MUST / SHOULD / Advisory) with its findings. */
function TierSection({
  tier,
  description,
  rowClass,
  findings,
  onNavigateToItem,
}: {
  tier: McpLintTier;
  description: string;
  rowClass: string;
  findings: McpLintFinding[];
  onNavigateToItem?: NavigateToItem;
}) {
  return (
    <section data-testid={`mcp-lint-tier-${tier}`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <FindingSeverity tier={tier} count={findings.length} />
        <p className="text-xs text-fg-muted">{description}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {findings.map((finding) => (
          <FindingRow
            key={finding.id}
            finding={finding}
            rowClass={rowClass}
            onNavigateToItem={onNavigateToItem}
          />
        ))}
      </ul>
    </section>
  );
}

interface Props {
  report: McpLintReport | null;
  loading: boolean;
  error: string | null;
  /** Deep-link a finding to its offending capability item on the Capabilities tab. */
  onNavigateToItem?: NavigateToItem;
}

/**
 * The "Lint & score" tab.
 *
 * @param props See {@link Props}.
 * @returns The report, or the loading / unavailable state.
 */
export default function McpLintReport({ report, loading, error, onNavigateToItem }: Props) {
  if (loading) {
    return <LoadingState minHeightClassName="min-h-[14rem]" message="Loading lint report…" />;
  }
  if (error || !report) {
    return (
      <EmptyState
        icon={<ShieldCheck aria-hidden />}
        tone={error ? 'danger' : 'neutral'}
        title="Lint report unavailable"
        description={
          error ??
          'This endpoint has no scored version yet. Run discovery to capture a quality report.'
        }
        data-testid="mcp-lint-unavailable"
      />
    );
  }

  const tierGroups = mcpLintGroupByTier(report.findings);
  const clean = report.findings.length === 0;
  const axisEvaluation = lintAxisEvaluationFromLintReport({
    algorithmId: report.algorithm_id,
    axes: report.axes ?? undefined,
    compositeScore: report.composite_score,
    compositeGrade: report.composite_grade,
    requiredCoverageMet: report.required_coverage_met,
    reportFingerprint: report.report_fingerprint,
  });

  return (
    <div className="flex flex-col gap-4">
      <ReportHeader report={report} />
      <SummaryTiles report={report} />
      {axisEvaluation ? <LintAxisCoveragePanel evaluation={axisEvaluation} /> : null}

      {clean ? (
        <EmptyState
          icon={<ShieldCheck aria-hidden />}
          title="No findings"
          description="This version's surface passes every lint rule — a clean bill of health."
          data-testid="mcp-lint-clean"
        />
      ) : (
        <div className="mcp-lint">
          <div className="mcp-lint__rail">
            <CategoryBars findings={report.findings} />
          </div>

          <Card className="min-w-0" data-testid="mcp-lint-findings">
            <CardHeader className="flex-row items-center gap-2">
              <ClipboardList aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
              <CardTitle>Findings</CardTitle>
              <Badge variant="neutral">{report.findings.length}</Badge>
              <span className="ml-auto text-2xs text-fg-muted">
                Grouped MUST → SHOULD → Advisory
              </span>
            </CardHeader>
            <CardBody className="flex flex-col gap-6">
              {tierGroups
                .filter((group) => group.findings.length > 0)
                .map((group) => (
                  <TierSection
                    key={group.meta.key}
                    tier={group.meta.key}
                    description={group.meta.description}
                    rowClass={group.meta.rowClass}
                    findings={group.findings}
                    onNavigateToItem={onNavigateToItem}
                  />
                ))}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
