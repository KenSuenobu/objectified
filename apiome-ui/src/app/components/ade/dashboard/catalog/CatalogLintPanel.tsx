'use client';

/**
 * CatalogLintPanel (MFI-25.5, #4090) — the inline Lint & Score pane.
 *
 * The mockup renders lint *inline* in the detail's Lint & Score tab (mockup lint pane,
 * `index.html:496-506`, `1529-1540`), not just behind the `CatalogLintReportDialog`. This component
 * fetches the same authoritative server report (`GET /api/catalog/{id}/lint`) the dialog uses and
 * renders it as:
 *   - a **summary strip** — MUST / SHOULD / Advisory / rules-triggered tallies, closed by the
 *     **lint score card** (the server letter grade + `score/100`, tinted by band) as the last card
 *     on the right;
 *   - a **30/70 split** below: **categories + findings on the left** (each finding row clickable,
 *     the import quality step's pattern), and the **raw source on the right** with the selected
 *     finding's line highlighted and centred — the finding→source linking the import wizard has,
 *     now on the detail screen. Lines resolve via `locateFindingLine` and the viewer mounts a
 *     bounded window around the target (`computeCenteredLineRange`), so huge documents stay fast;
 *   - **category bars** — real per-category 0–100 scores when MFI-25.6 ships them (`report.categories`),
 *     otherwise a graceful **severity breakdown** derived from the findings (which categories carry
 *     the most severe findings), so the bars are always meaningful without inventing a score.
 *
 * Both fetches (the lint report, and the raw source off `sourceHref`) are **lazy** (only once the
 * Lint tab is active) and **one-shot** (re-activating never refetches), mirroring
 * {@link CatalogSourceViewer}. The full dialog stays reachable from the header lint orb and the
 * "Open full report" affordance here, so the itemized history view is preserved. An item whose raw
 * source was not captured degrades to a "findings link by path only" note in the source pane.
 *
 * The score/grade are the server's authoritative values — nothing here recomputes them; the tier
 * helper is used only to pick band colours.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  Clock,
  Code,
  FileSearch,
  Fingerprint,
  History,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@lib/utils';
import { Switch } from '@/app/components/ui/Switch';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { LintViolationFindingMeta } from '@/app/components/ade/dashboard/lint/LintViolationFindingMeta';
import { LintViolationFindingsList } from '@/app/components/ade/dashboard/lint/LintViolationFindingsList';
import { useLintViolationContext } from '@/app/components/ade/dashboard/lint/useLintViolationContext';
import { enrichLintViolations, type EnrichedLintViolation } from '@/app/utils/lint-violation-display';
import {
  persistLintViolationDisplayPreferences,
  readLintViolationDisplayPreferences,
} from '@/app/utils/lint-violation-display-preferences';
import {
  fetchCatalogLintReport,
  sortLintFindings,
  type VersionLintFinding,
  type VersionLintReport,
} from '@/app/utils/version-lint-report';
import { getNumericScoreTier } from '@/app/utils/numeric-score-tier';
import {
  catalogDisplayLintScore,
  catalogLintGroupByTier,
  catalogLintProvenanceForDisplay,
  deriveCategorySeverityBreakdown,
  humanizeCategory,
  resolveCatalogFindingEntity,
  resolveCategoryScores,
  type CatalogLintTierMeta,
  type CategorySeverityBreakdown,
} from '@/app/utils/catalog-lint-panel';
import { locateFindingLine } from '@/app/utils/import-preflight';
import { computeCenteredLineRange } from '@/app/utils/windowed-rows';
import { RAW_VIEWER_CONTEXT } from '@/app/utils/preview-budgets';
import { lintAxisEvaluationFromLintReport } from '@/app/utils/lint-axis-ui';
import { LintAxisCoveragePanel } from '@/app/components/ade/dashboard/lint/LintAxisCoveragePanel';
import { SourceFormatChecksPanel } from '@/app/components/ade/dashboard/lint/SourceFormatChecksPanel';
import { LintDecisionBadge } from '@/app/utils/lint-policy-ui';

interface CatalogLintPanelProps {
  /** The catalog item id to lint (a project id). */
  itemId: string;
  /** Whether the Lint tab is active; the report is fetched the first time this is true. */
  active: boolean;
  /** Opens the full `CatalogLintReportDialog` (the itemized report the orb opens — kept for history). */
  onOpenReport: () => void;
  /** Opens the quality-history dialog; disabled by the caller when there is no history/score. */
  onOpenQualityHistory: () => void;
  /** Whether a quality score/history exists (drives the history button's enabled state). */
  qualityAvailable: boolean;
  /**
   * The parsed-entity names rendered in the Overview tab (MFI-25.3). Entity-scoped findings whose
   * `path` resolves to one of these names become deep links (MFI-28.2). Absent/empty disables the
   * deep links (findings still render, just as plain text).
   */
  entityNames?: readonly string[];
  /** Follow an entity-scoped finding to its Overview entity (switch tab + scroll + highlight). */
  onNavigateToEntity?: (name: string) => void;
  /**
   * When the item was last written/scored (the detail's `updated_at`), shown in the provenance
   * strip. Optional — the strip omits the "Scored" row when it is absent.
   */
  scoredAt?: string | null;
  /** Imported source format (e.g. `graphql`) for the source-format checks strip (CLX-2.4). */
  sourceFormat?: string | null;
  /**
   * The `/api/catalog/{id}/source` proxy URL the raw source is fetched from for the finding→source
   * pane. Absent (or `sourceAvailable` false) → the pane degrades to a "not captured" note.
   */
  sourceHref?: string | null;
  /** Whether the raw source can be retrieved at all (the item's `source.downloadable`). */
  sourceAvailable?: boolean;
}

/** The fetch lifecycle of the lint report (`idle`/`loading` render the spinner). */
type LintStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** The severity chips shown in each fallback category bar, in severity order. */
const BREAKDOWN_SEGMENTS: readonly {
  key: keyof Pick<CategorySeverityBreakdown, 'error' | 'warning' | 'info'>;
  fillClass: string;
}[] = [
  { key: 'error', fillClass: 'bg-rose-500' },
  { key: 'warning', fillClass: 'bg-amber-500' },
  { key: 'info', fillClass: 'bg-sky-500' },
];

/**
 * The lint score card — the summary strip's closing tile (last on the right): the server letter
 * grade and `score/100` tinted by band, over a filled score bar. It replaces the old standalone
 * gauge column and keeps that gauge's testids so the score/grade contract is unchanged.
 */
function ScoreSummaryCard({ score, grade, children }: { score: number; grade: string; children?: React.ReactNode }) {
  const tier = getNumericScoreTier(score);
  const letter = (grade || '').trim() || '–';
  return (
    <div
      data-testid="catalog-lint-gauge"
      className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Lint score
        </span>
        <span
          className={cn('font-mono text-xl font-bold leading-none', tier.textClass)}
          data-testid="catalog-lint-gauge-grade"
        >
          {letter}
        </span>
      </div>
      <div className="mt-1 font-mono text-xl font-bold tabular-nums">
        <span className={tier.textClass}>{score}</span>
        <span className="text-sm font-medium text-gray-400 dark:text-gray-500">/100</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
        <div
          className={cn('h-full rounded-full transition-all duration-500', tier.barSolidClass)}
          style={{ width: `${score}%` }}
        />
      </div>
      <p className="mt-1 text-2xs text-gray-400 dark:text-gray-500">
        {tier.shortLabel} · deterministic lint
      </p>
      {children}
    </div>
  );
}

/** A real per-category 0–100 score bar (MFI-25.6 data path). */
function CategoryScoreBar({ name, score }: { name: string; score: number }) {
  const tier = getNumericScoreTier(score);
  return (
    <div data-testid="catalog-lint-category-bar">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-gray-700 dark:text-gray-300">{humanizeCategory(name)}</span>
        <span className="font-mono tabular-nums text-gray-500 dark:text-gray-400">{score}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
        <div
          className={cn('h-full rounded-full transition-all duration-500', tier.barSolidClass)}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A fallback category bar: a severity-proportioned track (error/warning/info segments) plus the
 * per-severity counts. Used until real per-category scores (MFI-25.6) land.
 */
function CategoryBreakdownBar({ row }: { row: CategorySeverityBreakdown }) {
  return (
    <div data-testid="catalog-lint-category-breakdown">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-gray-700 dark:text-gray-300">{humanizeCategory(row.category)}</span>
        <span className="flex items-center gap-1.5 font-mono tabular-nums text-gray-500 dark:text-gray-400">
          {BREAKDOWN_SEGMENTS.filter((s) => row[s.key] > 0).map((s) => (
            <span key={s.key}>
              {row[s.key]} {s.key}
            </span>
          ))}
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
        {BREAKDOWN_SEGMENTS.map((s) =>
          row[s.key] > 0 ? (
            <div
              key={s.key}
              className={s.fillClass}
              style={{ width: `${(row[s.key] / row.total) * 100}%` }}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

/** One tile in the severity summary strip (count + label + caption). */
function SummaryTile({
  label,
  count,
  countClass,
  caption,
}: {
  label: string;
  count: number;
  /** Tint for a non-zero count (e.g. rose for MUST); zero stays neutral. */
  countClass?: string;
  caption: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {label}
        </span>
        <span
          className={cn(
            'font-mono text-xl font-bold tabular-nums text-gray-900 dark:text-white',
            countClass,
          )}
        >
          {count}
        </span>
      </div>
      <p className="mt-1 text-2xs text-gray-400 dark:text-gray-500">{caption}</p>
    </div>
  );
}

/** Format an ISO instant for the provenance strip, or `null` when absent/invalid. */
function formatScoredAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleString();
}

/** One labelled cell in the provenance strip (a `<dt>`/`<dd>` pair). */
function ProvenanceCell({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <dt className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0 text-xs text-gray-700 dark:text-gray-300">{children}</dd>
    </div>
  );
}

/**
 * The report provenance strip (MFI-28.2): the version label, when it was scored, whether the score
 * is the stored one or a live recompute, and the report fingerprint — mirroring the MCP Lint & Score
 * header so both surfaces read the same.
 */
function ProvenanceStrip({
  report,
  scoredAt,
}: {
  report: VersionLintReport;
  scoredAt?: string | null;
}) {
  const provenance = catalogLintProvenanceForDisplay(report);
  const scored = formatScoredAt(scoredAt);
  return (
    <dl
      data-testid="catalog-lint-provenance"
      className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-gray-50/60 px-4 py-2.5 dark:border-gray-700 dark:bg-gray-900/30"
    >
      <ProvenanceCell label="Version">
        <span className="font-mono text-gray-900 dark:text-white">{report.versionId}</span>
      </ProvenanceCell>
      {scored ? (
        <ProvenanceCell label="Scored" icon={<Clock className="h-3 w-3" aria-hidden />}>
          {scored}
        </ProvenanceCell>
      ) : null}
      <ProvenanceCell label="Source">
        <span
          data-testid="catalog-lint-provenance-source"
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-semibold',
            provenance.stale
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
              : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
          )}
          title="Whether the score shown is the one persisted at import or a live recompute"
        >
          {provenance.stale ? <AlertTriangle className="h-3 w-3" aria-hidden /> : null}
          {provenance.label}
        </span>
      </ProvenanceCell>
      {report.reportFingerprint ? (
        <ProvenanceCell label="Fingerprint" icon={<Fingerprint className="h-3 w-3" aria-hidden />}>
          <span
            className="block max-w-[10rem] truncate font-mono text-gray-500 dark:text-gray-400"
            title={`Report fingerprint: ${report.reportFingerprint}`}
          >
            {report.reportFingerprint}
          </span>
        </ProvenanceCell>
      ) : null}
    </dl>
  );
}

/**
 * One finding row inside a tier section: rule + message, and the `path` rendered as a deep link to
 * its Overview entity when the path resolves to a known parsed entity (MFI-28.2), else plain text.
 */
function FindingRow({
  finding,
  rowClass,
  entityName,
  onNavigateToEntity,
  decisionState,
  decisionWaived,
  onWaive,
  selected = false,
  onSelect,
  sourceLine = null,
  sourceLinked = false,
}: {
  finding: EnrichedLintViolation;
  rowClass: string;
  entityName: string | null;
  onNavigateToEntity?: (name: string) => void;
  decisionState?: string;
  decisionWaived?: boolean;
  onWaive?: (finding: EnrichedLintViolation) => void;
  /** Whether this finding drives the source pane (highlight ring + line marker). */
  selected?: boolean;
  /** Select this finding (row click is the pointer shortcut; the line button is the Tab stop). */
  onSelect?: () => void;
  /** The 1-based source line the finding resolved to, when the raw source is loaded. */
  sourceLine?: number | null;
  /** Whether a raw source pane exists to link into (shows the per-row line affordance). */
  sourceLinked?: boolean;
}) {
  const linkable = entityName != null && !!onNavigateToEntity;
  return (
    <li
      className={cn(
        'rounded-lg p-3 transition-shadow',
        rowClass,
        onSelect && 'cursor-pointer',
        selected && 'ring-2 ring-indigo-400 dark:ring-indigo-500',
      )}
      data-testid="catalog-lint-finding-row"
      data-selected={selected || undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 overflow-hidden">
          <LintViolationFindingMeta finding={finding} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {sourceLinked && onSelect ? (
            <button
              type="button"
              data-testid="catalog-lint-finding-source-link"
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
              }}
              title="Show this finding in the source"
              className={cn(
                'inline-flex items-center gap-1 font-mono text-2xs font-medium',
                selected
                  ? 'text-indigo-700 dark:text-indigo-300'
                  : 'text-indigo-600 hover:underline dark:text-indigo-400',
              )}
            >
              <Code className="h-3 w-3" aria-hidden />
              {sourceLine !== null ? `line ${sourceLine}` : 'source'}
            </button>
          ) : null}
          {decisionState ? (
            <LintDecisionBadge state={decisionState} waived={decisionWaived} />
          ) : null}
          {onWaive && finding.severity === 'error' && decisionState !== 'waived' ? (
            <button
              type="button"
              data-testid="catalog-lint-waive-button"
              className="text-2xs font-medium text-amber-700 hover:underline dark:text-amber-400"
              onClick={(event) => {
                event.stopPropagation();
                onWaive(finding);
              }}
            >
              Waive
            </button>
          ) : null}
        </div>
      </div>
      {finding.path ? (
        <div className="mt-1">
          {linkable ? (
            <button
              type="button"
              data-testid="catalog-lint-finding-link"
              onClick={() => onNavigateToEntity!(entityName!)}
              className="inline-flex max-w-full items-center gap-1 font-mono text-2xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              title={`Jump to ${entityName} in Overview`}
            >
              <span className="truncate">{finding.path}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden />
            </button>
          ) : (
            <span
              className="block truncate font-mono text-2xs text-gray-400 dark:text-gray-500"
              title={finding.path}
            >
              {finding.path}
            </span>
          )}
        </div>
      ) : null}
      <p className="mt-1 truncate text-sm text-gray-700 dark:text-gray-200" title={finding.message}>
        {finding.message}
      </p>
    </li>
  );
}

/** One requirement-tier section (MUST / SHOULD / advisory) with its per-tier count + findings. */
function TierSection({
  meta,
  findings,
  resolveEntity,
  onNavigateToEntity,
  decisionsById,
  onWaive,
  selectedId,
  onSelectFinding,
  findingLines,
  sourceLinked,
}: {
  meta: CatalogLintTierMeta;
  findings: EnrichedLintViolation[];
  resolveEntity: (finding: VersionLintFinding) => string | null;
  onNavigateToEntity?: (name: string) => void;
  decisionsById?: Record<string, { state: string; waived: boolean }>;
  onWaive?: (finding: EnrichedLintViolation) => void;
  /** The finding currently driving the source pane. */
  selectedId?: string | null;
  /** Select a finding (drives the source pane's highlighted line). */
  onSelectFinding?: (id: string) => void;
  /** Per-finding resolved 1-based source lines (empty until the raw source loads). */
  findingLines?: ReadonlyMap<string, number | null>;
  /** Whether a raw source pane exists to link into. */
  sourceLinked?: boolean;
}) {
  return (
    <section data-testid={`catalog-lint-tier-${meta.key}`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide',
              meta.badgeClass,
            )}
          >
            {meta.label}
            <span
              data-testid={`catalog-lint-tier-count-${meta.key}`}
              className="tabular-nums"
            >
              {findings.length}
            </span>
          </span>
        </h4>
        <p className="text-xs text-gray-500 dark:text-gray-400">{meta.description}</p>
      </div>
      <ul className="space-y-2">
        {findings.map((f) => (
          <FindingRow
            key={f.id}
            finding={f}
            rowClass={meta.rowClass}
            entityName={resolveEntity(f)}
            onNavigateToEntity={onNavigateToEntity}
            decisionState={decisionsById?.[f.id]?.state}
            decisionWaived={decisionsById?.[f.id]?.waived}
            onWaive={onWaive}
            selected={selectedId === f.id}
            onSelect={onSelectFinding ? () => onSelectFinding(f.id) : undefined}
            sourceLine={findingLines?.get(f.id) ?? null}
            sourceLinked={sourceLinked}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Render a catalog item's lint report inline: grade gauge, category bars, and findings list.
 * Fetches lazily on first activation of the Lint tab and exposes a retry on failure.
 */
export function CatalogLintPanel({
  itemId,
  active,
  onOpenReport,
  onOpenQualityHistory,
  qualityAvailable,
  entityNames,
  onNavigateToEntity,
  scoredAt,
  sourceFormat,
  sourceHref = null,
  sourceAvailable = false,
}: CatalogLintPanelProps) {
  const [status, setStatus] = useState<LintStatus>('idle');
  const [report, setReport] = useState<VersionLintReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The raw source for the finding→source pane, fetched lazily + one-shot like the report.
  const [sourceState, setSourceState] = useState<{
    status: 'idle' | 'loading' | 'loaded' | 'error';
    raw: string;
    error: string | null;
  }>({ status: 'idle', raw: '', error: null });
  const sourceFetchStartedRef = useRef(false);
  // The finding driving the source pane; falls back to the most severe finding once loaded.
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const activeLineRef = useRef<HTMLLIElement | null>(null);
  const sourceViewerRef = useRef<HTMLDivElement | null>(null);
  const [groupByRule, setGroupByRule] = useState(false);
  const [decisionsById, setDecisionsById] = useState<
    Record<string, { state: string; waived: boolean }>
  >({});
  const [waiveTarget, setWaiveTarget] = useState<EnrichedLintViolation | null>(null);
  const [waiveRationale, setWaiveRationale] = useState('');
  const [waiveExpiry, setWaiveExpiry] = useState('');
  const [waiveError, setWaiveError] = useState<string | null>(null);
  const [waiveSaving, setWaiveSaving] = useState(false);
  const { catalog, customDescriptions } = useLintViolationContext(report?.guideId, active);
  // Guards the one-shot lazy fetch so re-activating the tab never re-fetches.
  const fetchStartedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Lazy + one-shot fetch of the lint report. The guard (active + not-yet-started) sits at the top,
  // before any setState, so the effect stays a single `void` call with no synchronous cascading
  // render (mirrors CatalogSourceViewer). `retry` re-opens the one-shot by clearing the ref.
  const loadReport = useCallback(async () => {
    if (!active || fetchStartedRef.current) return;
    fetchStartedRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('loading');
    setErrorMessage(null);
    // Resolve into locals and commit the outcome once in `finally`, so the fetch drives a single
    // terminal state transition (loaded/error) rather than several branch-by-branch setState calls.
    let loadedReport: VersionLintReport | null = null;
    let failureMessage: string | null = null;
    try {
      loadedReport = await fetchCatalogLintReport(itemId, { signal: controller.signal });
    } catch (e) {
      failureMessage = e instanceof Error ? e.message : 'Failed to load lint report.';
    } finally {
      if (controller.signal.aborted) {
        /* superseded by a newer fetch/unmount — leave state to the newer run. */
      } else if (failureMessage != null) {
        setErrorMessage(failureMessage);
        setStatus('error');
      } else {
        setReport(loadedReport);
        setStatus('loaded');
        // Best-effort: load tenant decisions so badges can show policy state separately from raw severity.
        void fetch('/api/lint/decisions')
          .then((r) => r.json())
          .then((j) => {
            if (!j?.success || !Array.isArray(j.decisions)) return;
            const map: Record<string, { state: string; waived: boolean }> = {};
            for (const d of j.decisions as {
              sourceFingerprint?: string;
              state?: string;
            }[]) {
              if (!d.sourceFingerprint) continue;
              map[d.sourceFingerprint] = {
                state: d.state || 'open',
                waived: d.state === 'waived' || d.state === 'fixed' || d.state === 'false_positive',
              };
            }
            setDecisionsById(map);
          })
          .catch(() => {
            /* decisions are additive chrome — ignore failures */
          });
      }
    }
  }, [active, itemId]);

  const submitWaive = useCallback(async () => {
    if (!waiveTarget) return;
    setWaiveSaving(true);
    setWaiveError(null);
    try {
      const res = await fetch('/api/lint/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceFingerprint: waiveTarget.id,
          state: 'waived',
          rationale: waiveRationale,
          expiresAt: waiveExpiry ? new Date(waiveExpiry).toISOString() : undefined,
          ruleId: waiveTarget.rule,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        const detail =
          typeof json.detail === 'string'
            ? json.detail
            : json.error || 'Failed to save waiver';
        throw new Error(detail);
      }
      setDecisionsById((prev) => ({
        ...prev,
        [waiveTarget.id]: { state: 'waived', waived: true },
      }));
      setWaiveTarget(null);
      setWaiveRationale('');
      setWaiveExpiry('');
    } catch (e) {
      setWaiveError(e instanceof Error ? e.message : 'Failed to save waiver');
    } finally {
      setWaiveSaving(false);
    }
  }, [waiveTarget, waiveRationale, waiveExpiry]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  /**
   * Lazy + one-shot raw-source fetch for the finding→source pane, mirroring
   * {@link CatalogSourceViewer}: the proxy streams captured content directly and answers URL-sourced
   * items with a redirect `fetch` follows, so one call covers both cases.
   */
  const loadSource = useCallback(async () => {
    if (!active || !sourceAvailable || !sourceHref || sourceFetchStartedRef.current) return;
    sourceFetchStartedRef.current = true;
    setSourceState({ status: 'loading', raw: '', error: null });
    let loadedText: string | null = null;
    let failureMessage: string | null = null;
    try {
      const res = await fetch(sourceHref);
      if (res.ok) loadedText = await res.text();
      else failureMessage = 'The raw source could not be loaded.';
    } catch (e) {
      failureMessage = e instanceof Error ? e.message : 'The raw source could not be loaded.';
    } finally {
      setSourceState(
        failureMessage != null
          ? { status: 'error', raw: '', error: failureMessage }
          : { status: 'loaded', raw: loadedText ?? '', error: null },
      );
    }
  }, [active, sourceAvailable, sourceHref]);

  useEffect(() => {
    void loadSource();
  }, [loadSource]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    setGroupByRule(readLintViolationDisplayPreferences('catalog-lint').groupByRule);
  }, []);

  const onGroupByRuleChange = useCallback((checked: boolean) => {
    setGroupByRule(checked);
    persistLintViolationDisplayPreferences('catalog-lint', { groupByRule: checked });
  }, []);

  // Retry from the error affordance
  const retry = useCallback(() => {
    fetchStartedRef.current = false;
    void loadReport();
  }, [loadReport]);

  const findings = useMemo(() => (report ? sortLintFindings(report.findings) : []), [report]);
  const displayLint = useMemo(
    () => (report ? catalogDisplayLintScore(report) : null),
    [report],
  );
  // Finding→source resolution (the import quality step's linking, IXH-2.2): each finding's path
  // located in the loaded raw source, the selected finding's line centring the windowed viewer.
  const findingLines = useMemo(() => {
    const map = new Map<string, number | null>();
    if (sourceState.raw) {
      for (const f of findings) map.set(f.id, locateFindingLine(f.path ?? '', sourceState.raw));
    }
    return map;
  }, [findings, sourceState.raw]);
  const selectedFinding = useMemo(
    () => findings.find((f) => f.id === selectedFindingId) ?? findings[0] ?? null,
    [findings, selectedFindingId],
  );
  const selectedLine = selectedFinding ? findingLines.get(selectedFinding.id) ?? null : null;
  const rawAllLines = useMemo(
    () => (sourceState.raw ? sourceState.raw.split('\n') : []),
    [sourceState.raw],
  );
  const rawRange = useMemo(
    () => computeCenteredLineRange(rawAllLines.length, selectedLine, RAW_VIEWER_CONTEXT),
    [rawAllLines.length, selectedLine],
  );
  const rawLines = useMemo(
    () => rawAllLines.slice(rawRange.start, rawRange.end),
    [rawAllLines, rawRange],
  );
  const sourceLinked = sourceAvailable && sourceState.status === 'loaded' && rawAllLines.length > 0;

  // Centre the highlighted line whenever the selection moves — by scrolling the source viewer
  // *only* (never scrollIntoView, which also scrolls ancestor panes and makes the page jump).
  useEffect(() => {
    const viewer = sourceViewerRef.current;
    const line = activeLineRef.current;
    if (!viewer || !line) return;
    viewer.scrollTop = Math.max(0, line.offsetTop - viewer.clientHeight / 2);
  }, [selectedLine, selectedFinding]);

  const selectFinding = useCallback((id: string) => setSelectedFindingId(id), []);
  const categoryScores = resolveCategoryScores(report);
  const breakdown = report ? deriveCategorySeverityBreakdown(report.findings) : [];
  const axisEvaluation = useMemo(
    () =>
      report
        ? lintAxisEvaluationFromLintReport(report as unknown as Record<string, unknown>)
        : null,
    [report],
  );
  // Severity tallies for the summary strip (error → MUST, warning → SHOULD, info → advisory).
  const mustCount = findings.filter((f) => f.severity === 'error').length;
  const shouldCount = findings.filter((f) => f.severity === 'warning').length;
  const advisoryCount = findings.length - mustCount - shouldCount;
  const rulesTriggered = new Set(findings.map((f) => f.rule)).size;
  // Findings grouped into MUST/SHOULD/advisory tier sections (MFI-28.2), empty tiers dropped.
  const tierGroups = catalogLintGroupByTier(findings).filter((g) => g.findings.length > 0);

  const entityNameSet = useMemo(() => new Set(entityNames ?? []), [entityNames]);
  const resolveEntity = useCallback(
    (finding: VersionLintFinding) => resolveCatalogFindingEntity(finding.path, entityNameSet),
    [entityNameSet],
  );

  const enrichedFindings = useMemo(() => {
    if (!catalog || findings.length === 0) return [];
    return enrichLintViolations(findings, {
      guideName: report?.guideName ?? null,
      catalog,
      customDescriptions,
    });
  }, [findings, report?.guideName, catalog, customDescriptions]);

  const enrichedById = useMemo(
    () => new Map(enrichedFindings.map((f) => [f.id, f])),
    [enrichedFindings],
  );

  const tierGroupsEnriched = useMemo(
    () =>
      tierGroups.map((group) => ({
        ...group,
        findings: group.findings.map(
          (f) =>
            enrichedById.get(f.id) ?? {
              ...f,
              guideName: report?.guideName ?? null,
              rationale: f.message,
              docsHref: null,
            },
        ),
      })),
    [tierGroups, enrichedById, report?.guideName],
  );

  const renderCatalogPath = useCallback(
    (finding: EnrichedLintViolation) => {
      const entityName = resolveCatalogFindingEntity(finding.path, entityNameSet);
      const linkable = entityName != null && !!onNavigateToEntity;
      if (!finding.path) return null;
      if (linkable) {
        return (
          <button
            type="button"
            data-testid="catalog-lint-finding-link"
            onClick={() => onNavigateToEntity!(entityName!)}
            className="inline-flex items-center gap-1 font-mono text-2xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            title={`Jump to ${entityName} in Overview`}
          >
            {finding.path}
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </button>
        );
      }
      return (
        <span className="font-mono text-2xs text-gray-400 dark:text-gray-500">{finding.path}</span>
      );
    },
    [entityNameSet, onNavigateToEntity],
  );

  return (
    <section className={`${dashboardPanelClass} p-6`} data-testid="catalog-detail-lint">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Lint &amp; score
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="catalog-detail-quality-history"
            onClick={onOpenQualityHistory}
            disabled={!qualityAvailable}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:bg-white dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 dark:disabled:hover:bg-gray-800"
          >
            <History className="h-4 w-4 text-indigo-500" /> Quality history
          </button>
          <button
            type="button"
            data-testid="catalog-detail-lint-report"
            onClick={onOpenReport}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <FileSearch className="h-4 w-4 text-indigo-500" /> Open full report
          </button>
        </div>
      </div>

      {status === 'idle' || status === 'loading' ? (
        <p
          data-testid="catalog-lint-loading"
          className="mt-6 text-sm text-gray-500 dark:text-gray-400"
        >
          Loading lint report…
        </p>
      ) : status === 'error' ? (
        <div
          data-testid="catalog-lint-error"
          className="mt-6 flex flex-col items-start gap-3 rounded-xl border border-rose-200 bg-rose-50/60 p-4 text-sm dark:border-rose-900 dark:bg-rose-950/30"
        >
          <span className="flex items-center gap-2 text-rose-700 dark:text-rose-300">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
            {errorMessage || 'Failed to load lint report.'}
          </span>
          <button
            type="button"
            data-testid="catalog-lint-retry"
            onClick={retry}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      ) : report ? (
        <>
        {/* Report provenance (MFI-28.2): version, scored-at, stored-vs-computed, fingerprint. */}
        <ProvenanceStrip report={report} scoredAt={scoredAt} />

        {axisEvaluation ? (
          <div className="mt-4">
            <LintAxisCoveragePanel evaluation={axisEvaluation} />
          </div>
        ) : null}

        {report.projectId && report.versionRecordId ? (
          <div className="mt-4">
            <SourceFormatChecksPanel
              projectId={report.projectId}
              versionRecordId={report.versionRecordId}
              sourceFormat={sourceFormat}
            />
          </div>
        ) : null}

        {/* Severity summary strip: MUST / SHOULD / advisory tallies + distinct rules triggered,
            closed by the lint score card (grade + score/100) as the last card on the right. */}
        <div
          className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          data-testid="catalog-lint-summary"
        >
          <SummaryTile
            label="MUST"
            count={mustCount}
            countClass={mustCount > 0 ? 'text-rose-600 dark:text-rose-400' : undefined}
            caption="Hard requirements (errors)"
          />
          <SummaryTile
            label="SHOULD"
            count={shouldCount}
            countClass={shouldCount > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}
            caption="Recommendations (warnings)"
          />
          <SummaryTile label="Advisory" count={advisoryCount} caption="Informational notes" />
          <SummaryTile
            label="Rules triggered"
            count={rulesTriggered}
            caption="Distinct lint rules with findings"
          />
          {displayLint ? (
            <ScoreSummaryCard score={displayLint.score} grade={displayLint.grade}>
              {displayLint.usesCaptured &&
              report.scoreIsStale &&
              (report.score !== displayLint.score || report.grade !== displayLint.grade) ? (
                <p
                  className="mt-1 text-2xs text-gray-500 dark:text-gray-400"
                  data-testid="catalog-lint-live-recompute-note"
                >
                  Converted OpenAPI lint: {report.grade} · {report.score}/100
                </p>
              ) : null}
            </ScoreSummaryCard>
          ) : null}
        </div>

        {/* Findings ⇄ source: categories + clickable findings on the left (30%), the raw source on
            the right (70%) with the selected finding's line highlighted — the import quality step's
            finding→source linking, on the detail screen. */}
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-10">
          {/* Left rail (30%): categories, then the findings list filling the remaining height. Both
              columns share one fixed height, so selecting findings never shifts the layout — the
              list and the source each scroll inside their own static frame. */}
          <div className="flex h-[900px] min-w-0 flex-col gap-4 lg:col-span-3">
            <div className="max-h-[200px] shrink-0 overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <div data-testid="catalog-lint-categories">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Categories
              </h3>
              {categoryScores ? (
                <div className="mt-3 space-y-3">
                  {categoryScores.map((c) => (
                    <CategoryScoreBar key={c.name} name={c.name} score={c.score} />
                  ))}
                </div>
              ) : breakdown.length > 0 ? (
                <>
                  <div className="mt-3 space-y-3">
                    {breakdown.map((row) => (
                      <CategoryBreakdownBar key={row.category} row={row} />
                    ))}
                  </div>
                  <p className="mt-3 text-2xs text-gray-400 dark:text-gray-500">
                    Severity breakdown by category — per-category 0–100 scores arrive with the lint
                    rollup enrichment (MFI-25.6).
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  No category findings.
                </p>
              )}
            </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Findings
                {findings.length > 0 ? (
                  <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 font-mono text-2xs font-semibold tabular-nums text-gray-500 dark:bg-gray-700/60 dark:text-gray-300">
                    {findings.length}
                  </span>
                ) : null}
              </h3>
              {findings.length > 0 ? (
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                  <Switch
                    checked={groupByRule}
                    onCheckedChange={onGroupByRuleChange}
                    aria-label="Group findings by rule"
                    data-testid="catalog-lint-group-by-rule"
                  />
                  Group by rule
                </label>
              ) : null}
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto p-4"
              data-testid="catalog-lint-findings-scroll"
            >
            {findings.length === 0 ? (
              <p
                data-testid="catalog-lint-no-findings"
                className="text-sm text-gray-600 dark:text-gray-300"
              >
                No findings — clean bill of health.
              </p>
            ) : groupByRule ? (
              <div data-testid="catalog-lint-findings">
                <LintViolationFindingsList
                  findings={findings}
                  guideName={report.guideName ?? null}
                  guideId={report.guideId ?? null}
                  preferenceView="catalog-lint"
                  groupByRule={groupByRule}
                  onGroupByRuleChange={onGroupByRuleChange}
                  showHeader={false}
                  renderPath={renderCatalogPath}
                />
              </div>
            ) : (
              <div className="space-y-6" data-testid="catalog-lint-findings">
                {tierGroupsEnriched.map((group) => (
                  <TierSection
                    key={group.meta.key}
                    meta={group.meta}
                    findings={group.findings}
                    resolveEntity={resolveEntity}
                    onNavigateToEntity={onNavigateToEntity}
                    decisionsById={decisionsById}
                    onWaive={(f) => {
                      setWaiveTarget(f);
                      setWaiveError(null);
                    }}
                    selectedId={selectedFinding?.id ?? null}
                    onSelectFinding={selectFinding}
                    findingLines={findingLines}
                    sourceLinked={sourceLinked}
                  />
                ))}
              </div>
            )}
            </div>
            </div>
          </div>

          {/* The source pane: the selected finding's line highlighted and centred in a bounded
              window of the raw source (the import quality step's raw viewer, IXH-3.2). */}
          <div className="h-[900px] min-w-0 lg:col-span-7">
            <div
              className="flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
              data-testid="catalog-lint-source-pane"
            >
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
                <Code className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Source{selectedLine !== null ? ` · line ${selectedLine}` : ''}
                </h3>
                {selectedFinding ? (
                  <span
                    className="ml-auto min-w-0 truncate font-mono text-2xs text-gray-400 dark:text-gray-500"
                    title={selectedFinding.rule}
                  >
                    {selectedFinding.rule}
                  </span>
                ) : null}
              </div>
              <div
                ref={sourceViewerRef}
                className="relative min-h-0 flex-1 overflow-auto bg-gray-50 dark:bg-gray-900"
                data-testid="catalog-lint-source-viewer"
              >
                {!sourceAvailable ? (
                  <p
                    data-testid="catalog-lint-source-unavailable"
                    className="p-4 text-xs text-gray-500 dark:text-gray-400"
                  >
                    The raw source was not captured at import, so findings cannot be linked to
                    source lines here.
                  </p>
                ) : sourceState.status === 'error' ? (
                  <p
                    data-testid="catalog-lint-source-error"
                    className="p-4 text-xs text-rose-600 dark:text-rose-400"
                  >
                    {sourceState.error || 'The raw source could not be loaded.'}
                  </p>
                ) : sourceState.status !== 'loaded' ? (
                  <p className="p-4 text-xs text-gray-500 dark:text-gray-400">Loading source…</p>
                ) : rawAllLines.length === 0 ? (
                  <p className="p-4 text-xs text-gray-500 dark:text-gray-400">
                    The captured source is empty.
                  </p>
                ) : (
                  <>
                    {selectedFinding && selectedLine === null ? (
                      <p
                        data-testid="catalog-lint-source-unresolved"
                        className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                      >
                        Could not locate{' '}
                        <span className="font-mono">{selectedFinding.path || 'this finding'}</span>{' '}
                        in the source — showing the document head.
                      </p>
                    ) : null}
                    {rawRange.start > 0 ? (
                      <p
                        className="px-4 py-1 font-mono text-2xs text-gray-400 dark:text-gray-500"
                        data-testid="catalog-lint-source-clipped-before"
                      >
                        … {rawRange.start.toLocaleString()} earlier{' '}
                        {rawRange.start === 1 ? 'line' : 'lines'}
                      </p>
                    ) : null}
                    <ol className="py-1 font-mono text-2xs leading-snug">
                      {rawLines.map((text, index) => {
                        const lineNumber = rawRange.start + index + 1;
                        const isTarget = selectedLine === lineNumber;
                        return (
                          <li
                            key={lineNumber}
                            ref={isTarget ? activeLineRef : undefined}
                            data-testid={isTarget ? 'catalog-lint-source-line-active' : undefined}
                            className={cn(
                              'flex gap-3 px-4',
                              isTarget
                                ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100'
                                : 'text-gray-700 dark:text-gray-300',
                            )}
                          >
                            <span className="w-10 shrink-0 select-none text-right tabular-nums text-gray-400">
                              {lineNumber}
                            </span>
                            <span className="whitespace-pre-wrap break-all">{text}</span>
                          </li>
                        );
                      })}
                    </ol>
                    {rawRange.end < rawAllLines.length ? (
                      <p
                        className="px-4 py-1 font-mono text-2xs text-gray-400 dark:text-gray-500"
                        data-testid="catalog-lint-source-clipped-after"
                      >
                        … {(rawAllLines.length - rawRange.end).toLocaleString()} later{' '}
                        {rawAllLines.length - rawRange.end === 1 ? 'line' : 'lines'}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        </>
      ) : null}

      {waiveTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="catalog-lint-waive-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Waive lint finding"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Waive finding
            </h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Raw severity stays visible; this records an audited policy decision with
              rationale and expiry.
            </p>
            <p className="mt-3 font-mono text-2xs text-gray-500">{waiveTarget.id}</p>
            <label className="mt-3 block text-xs font-medium text-gray-700 dark:text-gray-300">
              Rationale
              <textarea
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                rows={3}
                value={waiveRationale}
                onChange={(e) => setWaiveRationale(e.target.value)}
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-gray-700 dark:text-gray-300">
              Expires
              <input
                type="date"
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                value={waiveExpiry}
                onChange={(e) => setWaiveExpiry(e.target.value)}
              />
            </label>
            {waiveError ? (
              <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{waiveError}</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-slate-800"
                onClick={() => setWaiveTarget(null)}
                disabled={waiveSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                onClick={() => void submitWaive()}
                disabled={waiveSaving || !waiveRationale.trim() || !waiveExpiry}
              >
                {waiveSaving ? 'Saving…' : 'Save waiver'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
