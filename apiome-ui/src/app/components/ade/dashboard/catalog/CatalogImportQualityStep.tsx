'use client';

/**
 * CatalogImportQualityStep (IXH-2.2, #5097) — the wizard's pre-commit quality gate.
 *
 * The catalog import wizard used to fire the commit straight from the options step, so the user saw
 * the lint grade only *after* the item existed and removing it was a separate cleanup task. This
 * step sits between `options` and `import`: it pre-flights the candidate through the IXH-2.1 API
 * (`POST /api/import/preflight`, a server-side dry run that writes nothing) and renders the verdict
 * while cancelling is still free.
 *
 * It shows:
 *  - a **grade orb** — the score ring with the letter grade and `score/100`, coloured by band;
 *  - the **severity tally** — error / warning / info counts from the server's roll-up;
 *  - the **ranked findings** — severity first, then capped rule penalty, each row keyboard-reachable
 *    and linked to its source location in the raw viewer beside it. Above
 *    {@link VIRTUALIZE_ABOVE} rows the list is windowed (see `windowed-rows`), so a report with
 *    thousands of findings stays responsive;
 *  - the **resolved style guide** that governed the lint;
 *  - the **policy comparison** — score against the tenant threshold (IXH-2.3 populates it);
 *  - the **entity preview** (IXH-3.2, #5104) — `CatalogImportPreviewPanel`, the structural
 *    explorer of what the import would create, whose source-location links drive the same raw
 *    viewer the findings link into;
 *  - the **bundle files** tab (IXH-3.5, #5107) — `CatalogImportBundlePanel`, mounted only for a
 *    multi-file candidate, giving every file in the archive a role, a verdict, its resolved
 *    imports, and an entry-point picker that re-runs this step against the chosen root.
 *
 * Layout: the gate facts (grade, tally, style guide, threshold, verdict, waiver) are pinned, and the
 * two tall exploration surfaces — ranked findings + linked source viewer, and the entity preview —
 * sit behind a {@link CatalogDetailTabs} bar rather than stacking into one long scroll. This is the
 * MCP endpoint Insight treatment, applied here for the same reason: a report worth reading beats a
 * report that has to be scrolled past. Both panels stay mounted (inactive one `hidden`), so tabbing
 * back never re-runs the preview's manifest fetch or loses the selected finding's source line.
 *
 * Three exits: **Import** (commit), **Import anyway** (commit against a blocking policy, recording a
 * waiver), and **Cancel**. The blocking exit never appears when policy forbids an override, and the
 * step owns the footer for the whole gate so the exits are never split across two rows.
 *
 * Degradation: a transport failure is *unscored*, not blocked — it offers Retry and
 * proceed-without-score. A `ok: false` report means the candidate cannot be imported at all, so no
 * exit commits; the taxonomy remediation is shown and Retry appears only when the error is
 * retriable. The gate rules themselves live in `decidePreflightGate` so they can be tested apart
 * from the DOM.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, CheckCircle2, FileSearch, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Alert';
import { getNumericScoreTier } from '@/app/utils/numeric-score-tier';
import { gaugeDashOffset } from '@/app/utils/catalog-lint-panel';
import { gradeChipClass, severityBadgeClass } from '@/app/utils/version-lint-report';
import {
  buildImportQualityWaiver,
  decidePreflightGate,
  fetchImportPreflight,
  locateFindingLine,
  preflightSeverityTally,
  preflightThresholdComparison,
  recordImportQualityWaiver,
  type ImportQualityWaiver,
  type PreflightFinding,
  type PreflightReport,
  type PreflightRequest,
} from '@/app/utils/import-preflight';
import { clampRowIndex, computeCenteredLineRange, computeWindowedRange } from '@/app/utils/windowed-rows';
import {
  FINDINGS_VIRTUALIZE_ABOVE,
  RAW_VIEWER_CONTEXT,
} from '@/app/utils/preview-budgets';
import { CatalogImportBundlePanel } from './CatalogImportBundlePanel';
import { CatalogImportPreviewPanel } from './CatalogImportPreviewPanel';
import { CatalogDetailTabs, panelElementId, tabElementId, type DetailTab } from './CatalogDetailTabs';

/** SVG progress-ring geometry, matching `CatalogLintPanel`'s gauge (viewBox 0 0 40 40, r 16). */
const GAUGE_R = 16;
const GAUGE_C = 2 * Math.PI * GAUGE_R;

// Budgets live in the central registry (IXH-3.6, #5108); `VIRTUALIZE_ABOVE` keeps its
// historical exported name for the step's callers and tests.
export { FINDINGS_VIRTUALIZE_ABOVE as VIRTUALIZE_ABOVE } from '@/app/utils/preview-budgets';

/**
 * Uniform finding-row pitch (px) the windowing arithmetic assumes; matches the `h-20` row
 * class (a full-height button inside 4px of vertical padding). The pitch and the row class
 * must agree exactly, or the spacer arithmetic drifts by the difference on every row.
 */
const ROW_HEIGHT = 80;

/** Height (px) of the findings viewport; matches the `h-[380px]` list class. */
const LIST_HEIGHT = 380;

/**
 * The step's two heavy surfaces, split across a tab bar (the MCP endpoint Insight treatment):
 * lint verdict detail on one side, the structural preview of what the import would create on the
 * other. Everything the gate itself depends on — grade, tally, verdict, waiver — stays pinned above
 * the bar, so tabbing can never hide the reason an import is blocked.
 */
type QualityTabId = 'findings' | 'preview' | 'bundle';

/** Element-id prefix wiring the tab buttons to their panels (`aria-controls`/`aria-labelledby`). */
const QUALITY_TABS_ID_PREFIX = 'import-quality';

export interface CatalogImportQualityStepProps {
  /** The candidate document's bytes, base64-encoded — exactly what the commit would send. */
  documentBase64: string;
  /** Candidate filename / label, shown in the header and recorded on a waiver. */
  label: string;
  /** Importer discriminator the commit would use (`graphql`, `json-schema`, …), when known. */
  sourceKind: string | null;
  /** How the document reached the wizard, for parity with the import job's option. */
  inputKind: 'file' | 'url' | 'paste' | 'fileset';
  /** Source URL when the intake kind is `url`. */
  url?: string | null;
  /**
   * Root document inside a multi-file payload (an uploaded archive, or a git selection —
   * MFI-29.1 / MFI-29.3). Forwarded so the pre-flight scores the same root the commit imports.
   */
  archiveRoot?: string | null;
  /**
   * Re-select the bundle's root document (IXH-3.5). The wizard owns `archiveRoot`, so the bundle
   * panel's entry-point picker calls this and the pre-flight, the preview manifest, and the
   * inventory all re-derive against the chosen member. Omitted where the host cannot re-run, which
   * renders the picker read-only rather than as a dead control.
   */
  onArchiveRootChange?: (path: string) => void;
  /** Raw source text for the viewer and the finding→line resolution; empty for archives. */
  rawSource: string;
  /**
   * When true, a **non-blocking** report commits without stopping here (the power-user preference).
   * A blocking verdict, an unimportable candidate, and a failed pre-flight all still stop, so the
   * step is never skipped silently when it matters.
   */
  autoAdvance: boolean;
  /** Current "skip next time" preference, rendered as a checkbox on the step. */
  skipPreference: boolean;
  /** Persist a change to the skip preference. */
  onSkipPreferenceChange: (value: boolean) => void;
  /**
   * Commit the import. Receives the waiver record when the user overrode a blocking policy, else
   * `null`. The parent owns the actual import job; this step never writes.
   */
  onCommit: (waiver: ImportQualityWaiver | null) => void;
  /** Return to the options step with wizard state intact. */
  onBack: () => void;
  /** Abandon the import. */
  onCancel: () => void;
  /**
   * The catalog project slug the commit would use (the dialog's own derivation, IXH-3.4).
   * When set, the preview panel requests the re-import delta against any existing item
   * under that slug; a no-op re-import then offers this step's Cancel exit as "skip".
   */
  projectSlug?: string | null;
}

/** The grade orb: score ring, letter grade, and `score/100`, or an explicit unscored state. */
function GradeOrb({ score, grade }: { score: number | null; grade: string | null }) {
  const hasScore = typeof score === 'number';
  const tier = getNumericScoreTier(hasScore ? score! : 0);
  const letter = (grade || '').trim() || '–';
  return (
    <div className="flex flex-col items-center gap-2" data-testid="import-quality-orb">
      <div className="relative h-24 w-24 shrink-0">
        <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90" aria-hidden>
          <circle
            cx="20"
            cy="20"
            r={GAUGE_R}
            fill="none"
            className="stroke-gray-200 dark:stroke-gray-700"
            strokeWidth="3.5"
          />
          {hasScore && (
            <circle
              cx="20"
              cy="20"
              r={GAUGE_R}
              fill="none"
              className={cn('stroke-current', tier.gaugeStrokeClass)}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={GAUGE_C}
              strokeDashoffset={gaugeDashOffset(score!, GAUGE_C)}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={cn(
              'font-mono text-2xl font-bold leading-none tabular-nums',
              hasScore ? tier.textClass : 'text-gray-400 dark:text-gray-500',
            )}
            data-testid="import-quality-grade"
          >
            {letter}
          </span>
          <span className="mt-1 font-mono text-2xs tabular-nums text-gray-500 dark:text-gray-400">
            {hasScore ? `${score}/100` : 'unscored'}
          </span>
        </div>
      </div>
      <span
        className={cn(
          'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold',
          gradeChipClass(letter),
        )}
      >
        Grade {letter}
      </span>
    </div>
  );
}

/** One ranked finding row: rank, severity, rule, message, and its source location. */
function FindingRow({
  finding,
  line,
  selected,
  setSize,
  posInSet,
  onSelect,
  registerRef,
  pinnedStyle,
}: {
  finding: PreflightFinding;
  line: number | null;
  selected: boolean;
  /** Total findings → `aria-setsize`, so a windowed listbox still reports its true size. */
  setSize: number;
  /** 1-based position → `aria-posinset`. */
  posInSet: number;
  onSelect: () => void;
  registerRef: (node: HTMLButtonElement | null) => void;
  /** Absolute-position style when the row is pinned (focused but scrolled out of the window). */
  pinnedStyle?: React.CSSProperties;
}) {
  return (
    <li className="h-20 px-1 py-0.5" role="presentation" style={pinnedStyle}>
      <button
        type="button"
        ref={registerRef}
        role="option"
        aria-selected={selected}
        aria-setsize={setSize}
        aria-posinset={posInSet}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        onFocus={onSelect}
        data-testid="import-quality-finding"
        className={cn(
          'flex h-full w-full flex-col justify-center gap-1 rounded-lg border px-3 text-left motion-safe:transition',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
          selected
            ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-950/40'
            : 'border-gray-200 bg-white hover:border-indigo-200 dark:border-gray-700 dark:bg-gray-950',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs tabular-nums text-gray-400">#{finding.rank}</span>
          <span
            className={cn(
              'inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-semibold uppercase',
              severityBadgeClass(finding.severity),
            )}
          >
            {finding.severity}
          </span>
          <span className="truncate font-mono text-2xs text-gray-500 dark:text-gray-400">
            {finding.rule}
          </span>
        </div>
        <div className="truncate text-sm text-gray-800 dark:text-gray-100">{finding.message}</div>
        <div className="truncate font-mono text-2xs text-gray-500 dark:text-gray-400">
          {finding.path || 'document root'}
          {line !== null ? ` · line ${line}` : ''}
        </div>
      </button>
    </li>
  );
}

export function CatalogImportQualityStep({
  documentBase64,
  label,
  sourceKind,
  inputKind,
  url,
  archiveRoot,
  onArchiveRootChange,
  rawSource,
  autoAdvance,
  skipPreference,
  onSkipPreferenceChange,
  onCommit,
  onBack,
  onCancel,
  projectSlug = null,
}: CatalogImportQualityStepProps) {
  // One pre-flight run's outcome, tagged with the run it belongs to. Tagging (rather than a separate
  // `loading` flag set from the effect body) means "still scoring" is *derived* — the step can never
  // render a stale report as if it were the answer for the current candidate.
  const [outcome, setOutcome] = useState<{
    runId: object | null;
    report: PreflightReport | null;
    error: string | null;
  }>({ runId: null, report: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<QualityTabId>('findings');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // A line the preview panel's entity explorer linked to; overrides the selected finding's line
  // until the user selects a finding again, so both surfaces drive the one raw viewer.
  const [previewLine, setPreviewLine] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [justification, setJustification] = useState('');
  // Waiver-grant state: the server decides whether this user may waive, so the override exit has
  // its own in-flight and failure state separate from the pre-flight run.
  const [waiving, setWaiving] = useState(false);
  const [waiverError, setWaiverError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const lineRef = useRef<HTMLLIElement | null>(null);
  // A commit must fire at most once per mount, even if auto-advance and a re-render race.
  const committed = useRef(false);

  const request = useMemo<PreflightRequest>(
    () => ({
      document_base64: documentBase64,
      source_kind: sourceKind ?? undefined,
      filename: label || undefined,
      url: inputKind === 'url' ? url ?? undefined : undefined,
      input_kind: inputKind,
      archive_root: archiveRoot ?? undefined,
      import_target: 'catalog',
    }),
    [archiveRoot, documentBase64, inputKind, label, sourceKind, url],
  );

  /** The current pre-flight run — a fresh identity per candidate and per retry. */
  const runId = useMemo(() => ({ request, attempt }), [request, attempt]);
  const loading = outcome.runId !== runId;
  const report = loading ? null : outcome.report;
  const transportError = loading ? null : outcome.error;

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    fetchImportPreflight(request, controller.signal)
      .then((result) => {
        if (!live) return;
        setOutcome({ runId, report: result, error: null });
        setSelectedIndex(0);
        setPreviewLine(null);
      })
      .catch((e: unknown) => {
        if (!live || controller.signal.aborted) return;
        setOutcome({
          runId,
          report: null,
          error:
            e instanceof Error ? e.message : 'Could not score this source before importing.',
        });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [request, runId]);

  const gate = useMemo(() => decidePreflightGate(report, transportError), [report, transportError]);
  const findings = useMemo(() => report?.lint?.findings ?? [], [report]);
  const tally = useMemo(() => preflightSeverityTally(report?.lint), [report]);
  const comparison = useMemo(() => preflightThresholdComparison(report), [report]);
  const findingLines = useMemo(
    () => findings.map((finding) => locateFindingLine(finding.path, rawSource)),
    [findings, rawSource],
  );
  // The findings tab carries its count in the label, so the split never hides *how much* is on the
  // other side of a tab — the one thing a tabbed layout can otherwise cost you.
  // The bundle tab only exists for a bundle candidate — a single document has no file inventory to
  // explore, and an empty third tab would be a dead end rather than an explanation.
  const isBundle = inputKind === 'fileset' || Boolean(archiveRoot);
  const qualityTabs = useMemo<readonly DetailTab[]>(
    () => [
      { id: 'findings', label: findings.length > 0 ? `Findings (${findings.length})` : 'Findings' },
      { id: 'preview', label: 'What this import adds' },
      ...(isBundle ? [{ id: 'bundle', label: 'Bundle files' }] : []),
    ],
    [findings.length, isBundle],
  );
  // The preview panel's link wins until a finding is selected again (selecting one clears it).
  const selectedLine = previewLine ?? findingLines[selectedIndex] ?? null;

  // Auto-advance only for a real, non-blocking verdict: a block, an unimportable candidate, and a
  // failed pre-flight always stop here, so the preference can never hide a gate.
  useEffect(() => {
    if (loading || committed.current) return;
    if (!autoAdvance || !report || !report.ok || report.policy.blocking) return;
    committed.current = true;
    onCommit(null);
  }, [autoAdvance, loading, onCommit, report]);

  /**
   * Commit the import, recording a waiver first when the user is overriding a block.
   *
   * The waiver has to reach the tenant's server-side ledger *before* the commit, because the
   * server enforces the same policy at the import endpoint (IXH-2.3) and matches the waiver on
   * the candidate's content hash. A refused grant — a role the policy does not name, or an
   * unreachable ledger — therefore stops here with the server's reason rather than sending a
   * commit that the gate would reject anyway.
   */
  const commit = useCallback(
    async (waiver: ImportQualityWaiver | null) => {
      if (committed.current) return;
      if (waiver) {
        setWaiverError(null);
        setWaiving(true);
        const outcomeOfGrant = await recordImportQualityWaiver(
          waiver,
          report?.policy?.format_key ?? report?.detection?.adapter_key ?? null,
        );
        setWaiving(false);
        if (!outcomeOfGrant.recorded) {
          setWaiverError(
            outcomeOfGrant.error ?? 'The waiver could not be recorded, so the import was not started.',
          );
          return;
        }
      }
      committed.current = true;
      onCommit(waiver);
    },
    [onCommit, report],
  );

  const handleImport = useCallback(() => {
    void commit(null);
  }, [commit]);

  const handleImportAnyway = useCallback(() => {
    if (!report) return;
    void commit(
      buildImportQualityWaiver(report, label, justification, new Date().toISOString()),
    );
  }, [commit, justification, label, report]);

  const handleRetry = useCallback(() => setAttempt((n) => n + 1), []);

  // Roving focus: the list owns arrow/Home/End, each row is a real button so Tab and Enter work.
  // Selecting a finding reclaims the raw viewer from a preview-panel link.
  const selectFinding = useCallback((index: number) => {
    setSelectedIndex(index);
    setPreviewLine(null);
  }, []);

  // Imperative focus after the window/selection state from a keyboard move has rendered, so
  // the target row is mounted (windowed in, or pinned) before `.focus()` runs. A counter
  // (not a boolean) so consecutive moves each fire; guarded so unrelated re-renders never
  // steal focus (the tree explorer's pattern, IXH-3.2).
  const [focusArm, setFocusArm] = useState(0);
  const focusArmHandled = useRef(0);
  useEffect(() => {
    if (focusArm === focusArmHandled.current) return;
    focusArmHandled.current = focusArm;
    rowRefs.current.get(selectedIndex)?.focus();
  }, [focusArm, selectedIndex]);

  const focusRow = useCallback(
    (index: number) => {
      // Scroll the target into the window and mirror it into state in the same tick, so the
      // post-render focus effect finds the row mounted rather than racing the scroll event.
      const target = Math.max(
        0,
        Math.min(index * ROW_HEIGHT, findings.length * ROW_HEIGHT - LIST_HEIGHT),
      );
      if (listRef.current) listRef.current.scrollTop = target;
      setScrollTop(target);
      selectFinding(index);
      setFocusArm((n) => n + 1);
    },
    [findings.length, selectFinding],
  );

  const handleListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(event.key) || findings.length === 0) return;
      event.preventDefault();
      const next =
        event.key === 'ArrowDown'
          ? selectedIndex + 1
          : event.key === 'ArrowUp'
            ? selectedIndex - 1
            : event.key === 'Home'
              ? 0
              : findings.length - 1;
      const clamped = clampRowIndex(next, findings.length);
      if (clamped === null) return;
      focusRow(clamped);
    },
    [findings.length, focusRow, selectedIndex],
  );

  // Bring the linked source line into view whenever the selection changes.
  useEffect(() => {
    lineRef.current?.scrollIntoView({ block: 'center' });
  }, [selectedLine]);

  const virtualized = findings.length > FINDINGS_VIRTUALIZE_ABOVE;
  const rowWindow = useMemo(
    () =>
      virtualized
        ? computeWindowedRange({
            rowCount: findings.length,
            rowHeight: ROW_HEIGHT,
            viewportHeight: LIST_HEIGHT,
            scrollTop,
          })
        : { startIndex: 0, endIndex: findings.length, paddingTop: 0, paddingBottom: 0 },
    [findings.length, scrollTop, virtualized],
  );
  // Focus pinning: the selected row (the listbox's only Tab stop) must stay mounted even
  // when scrolled out of the window, or keyboard focus would fall off the list. It renders
  // absolutely at its true offset so the spacer arithmetic is untouched.
  const pinnedFindingIndex =
    virtualized &&
    findings.length > 0 &&
    (selectedIndex < rowWindow.startIndex || selectedIndex >= rowWindow.endIndex)
      ? selectedIndex
      : null;

  // The viewer mounts a bounded window of lines *around* the selected location (IXH-3.2) rather
  // than only the head of the document, so a preview-manifest link to line 12,000 still resolves.
  const rawAllLines = useMemo(() => (rawSource ? rawSource.split('\n') : []), [rawSource]);
  const rawRange = useMemo(
    () => computeCenteredLineRange(rawAllLines.length, selectedLine, RAW_VIEWER_CONTEXT),
    [rawAllLines.length, selectedLine],
  );
  const rawLines = useMemo(
    () => rawAllLines.slice(rawRange.start, rawRange.end),
    [rawAllLines, rawRange],
  );

  const toneAlertVariant =
    gate.tone === 'pass'
      ? 'success'
      : gate.tone === 'warn'
        ? 'warning'
        : gate.tone === 'block' || gate.tone === 'error'
          ? 'error'
          : 'info';

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col" data-testid="catalog-import-quality-step">
      {loading ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center"
          data-testid="import-quality-loading"
        >
          <Loader2 className="h-8 w-8 motion-safe:animate-spin text-indigo-500" aria-hidden />
          <div className="text-sm text-gray-700 dark:text-gray-200">
            Scoring this source before import — nothing has been written yet.
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {/* Pinned gate facts. These are what the footer's exits are decided by, so they never
              move behind a tab — only the two tall exploration surfaces below do. */}
          <div className="shrink-0 space-y-3">
            <div className="flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
              <GradeOrb
                score={typeof report?.lint?.score === 'number' ? report.lint.score : null}
                grade={report?.lint?.grade ?? null}
              />
              <div className="min-w-[16rem] flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <FileSearch className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
                  <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {label}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2" data-testid="import-quality-severity-tally">
                  {tally.map((row) => (
                    <span
                      key={row.severity}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
                        severityBadgeClass(row.severity),
                      )}
                    >
                      <span className="tabular-nums">{row.count}</span> {row.severity}
                    </span>
                  ))}
                </div>
                {report?.style_guide && (
                  <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="import-quality-style-guide">
                    Style guide: <span className="font-medium">{report.style_guide.name}</span> (
                    {report.style_guide.source})
                  </div>
                )}
                {comparison ? (
                  <div
                    className={cn(
                      'text-xs font-medium',
                      comparison.meets
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-rose-700 dark:text-rose-400',
                    )}
                    data-testid="import-quality-threshold"
                  >
                    Policy threshold {comparison.threshold} · this source scores {comparison.score} (
                    {comparison.delta >= 0 ? `+${comparison.delta}` : comparison.delta})
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="import-quality-threshold">
                    No policy score threshold applies to this import.
                  </div>
                )}
              </div>
            </div>

            <Alert variant={toneAlertVariant} data-testid="import-quality-verdict">
              <div className="font-medium">
                {gate.tone === 'block'
                  ? 'Policy blocks this import'
                  : gate.tone === 'error'
                    ? 'This source cannot be imported'
                    : gate.tone === 'unscored'
                      ? 'Quality could not be scored'
                      : gate.tone === 'warn'
                        ? 'Import allowed with warnings'
                        : 'Import allowed'}
              </div>
              <div className="text-sm">{gate.reason}</div>
              {report?.error?.remediation && (
                <div className="mt-1 text-sm" data-testid="import-quality-remediation">
                  {report.error.remediation} (code {report.error.code})
                </div>
              )}
            </Alert>

            {gate.tone === 'block' && gate.canOverride && (
              <div className="space-y-2 rounded-lg border border-amber-300 p-3 dark:border-amber-700">
                <label
                  className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100"
                  htmlFor="import-quality-justification"
                >
                  <ShieldAlert className="h-4 w-4 text-amber-500" aria-hidden />
                  Why is this import necessary?
                </label>
                <input
                  id="import-quality-justification"
                  value={justification}
                  onChange={(event) => setJustification(event.target.value)}
                  placeholder="Recorded with the waiver, e.g. vendor spec we do not control"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Importing anyway records a waiver against this report&apos;s fingerprint in your
                  tenant&apos;s ledger
                  {report?.policy?.override_roles?.length
                    ? `, which only these roles may do: ${report.policy.override_roles.join(', ')}.`
                    : '.'}
                </p>
                {waiverError && (
                  <p
                    className="text-xs font-medium text-rose-600 dark:text-rose-400"
                    data-testid="import-quality-waiver-error"
                    role="alert"
                  >
                    {waiverError}
                  </p>
                )}
              </div>
            )}
          </div>

          <CatalogDetailTabs
            tabs={qualityTabs}
            active={activeTab}
            onSelect={(id) => setActiveTab(id as QualityTabId)}
            ariaLabel="Pre-flight sections"
            idPrefix={QUALITY_TABS_ID_PREFIX}
            className="shrink-0"
          />

          {/* Both panels stay mounted (the inactive one `hidden`), matching the catalog detail
              shell: the preview's manifest fetch is not re-run every time the user tabs back, and
              a finding selected on one tab keeps its linked source line on return. */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <section
              role="tabpanel"
              id={panelElementId(QUALITY_TABS_ID_PREFIX, 'findings')}
              aria-labelledby={tabElementId(QUALITY_TABS_ID_PREFIX, 'findings')}
              tabIndex={0}
              hidden={activeTab !== 'findings'}
              data-testid="import-quality-findings-panel"
              className="space-y-4 focus:outline-none"
            >
              {(findings.length > 0 || rawSource !== '') && (
                <div className="grid gap-3 lg:grid-cols-2">
                  <div>
                    {findings.length > 0 ? (
                      <>
                        <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
                          <span>Ranked findings ({findings.length})</span>
                          {virtualized && (
                            <span className="font-normal normal-case text-gray-500 dark:text-gray-400">
                              windowed
                            </span>
                          )}
                        </div>
                        <div
                          ref={listRef}
                          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                          onKeyDown={handleListKeyDown}
                          className="h-[380px] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700"
                        >
                          {/* No inter-row margins: the row pitch must equal ROW_HEIGHT exactly
                              or the windowing spacer arithmetic drifts on every row. */}
                          <ul role="listbox" aria-label="Ranked lint findings" className="relative">
                            {rowWindow.paddingTop > 0 && (
                              <li aria-hidden role="presentation" style={{ height: rowWindow.paddingTop }} />
                            )}
                            {findings.slice(rowWindow.startIndex, rowWindow.endIndex).map((finding, offset) => {
                              const index = rowWindow.startIndex + offset;
                              return (
                                <FindingRow
                                  key={finding.id || `${finding.rule}:${index}`}
                                  finding={finding}
                                  line={findingLines[index] ?? null}
                                  selected={index === selectedIndex}
                                  setSize={findings.length}
                                  posInSet={index + 1}
                                  onSelect={() => selectFinding(index)}
                                  registerRef={(node) => {
                                    if (node) rowRefs.current.set(index, node);
                                    else rowRefs.current.delete(index);
                                  }}
                                />
                              );
                            })}
                            {rowWindow.paddingBottom > 0 && (
                              <li aria-hidden role="presentation" style={{ height: rowWindow.paddingBottom }} />
                            )}
                            {pinnedFindingIndex !== null && findings[pinnedFindingIndex] ? (
                              <FindingRow
                                key="pinned-finding"
                                finding={findings[pinnedFindingIndex]}
                                line={findingLines[pinnedFindingIndex] ?? null}
                                selected
                                setSize={findings.length}
                                posInSet={pinnedFindingIndex + 1}
                                onSelect={() => selectFinding(pinnedFindingIndex)}
                                registerRef={(node) => {
                                  if (node) rowRefs.current.set(pinnedFindingIndex, node);
                                  else rowRefs.current.delete(pinnedFindingIndex);
                                }}
                                pinnedStyle={{
                                  position: 'absolute',
                                  top: pinnedFindingIndex * ROW_HEIGHT,
                                  left: 0,
                                  right: 0,
                                }}
                              />
                            ) : null}
                          </ul>
                        </div>
                        {findings[selectedIndex]?.remediation && (
                          <p
                            className="mt-2 text-xs text-gray-600 dark:text-gray-300"
                            data-testid="import-quality-finding-remediation"
                          >
                            {findings[selectedIndex].remediation}
                            {findings[selectedIndex].docs_url ? ` · ${findings[selectedIndex].docs_url}` : ''}
                          </p>
                        )}
                      </>
                    ) : report?.ok ? (
                      <div
                        className="flex items-center gap-2 rounded-lg border border-emerald-200 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:text-emerald-200"
                        data-testid="import-quality-no-findings"
                      >
                        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                        No lint findings — this source is clean against the resolved style guide.
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
                      Source{selectedLine !== null ? ` · line ${selectedLine}` : ''}
                    </div>
                    <div
                      className="h-[380px] overflow-auto rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900"
                      data-testid="import-quality-raw-viewer"
                    >
                      {rawLines.length > 0 ? (
                        <>
                          {rawRange.start > 0 && (
                            <p
                              className="px-3 py-1 font-mono text-2xs text-gray-400 dark:text-gray-500"
                              data-testid="import-quality-raw-clipped-before"
                            >
                              … {rawRange.start.toLocaleString()} earlier{' '}
                              {rawRange.start === 1 ? 'line' : 'lines'}
                            </p>
                          )}
                          <ol className="py-1 font-mono text-2xs leading-snug">
                            {rawLines.map((text, index) => {
                              const lineNumber = rawRange.start + index + 1;
                              const isTarget = selectedLine === lineNumber;
                              return (
                                <li
                                  key={lineNumber}
                                  ref={isTarget ? lineRef : undefined}
                                  data-testid={isTarget ? 'import-quality-raw-line-active' : undefined}
                                  className={cn(
                                    'flex gap-3 px-3',
                                    isTarget
                                      ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100'
                                      : 'text-gray-700 dark:text-gray-300',
                                  )}
                                >
                                  <span className="w-8 shrink-0 select-none text-right text-gray-400 tabular-nums">
                                    {lineNumber}
                                  </span>
                                  <span className="whitespace-pre-wrap break-all">{text}</span>
                                </li>
                              );
                            })}
                          </ol>
                          {rawRange.end < rawAllLines.length && (
                            <p
                              className="px-3 py-1 font-mono text-2xs text-gray-400 dark:text-gray-500"
                              data-testid="import-quality-raw-clipped-after"
                            >
                              … {(rawAllLines.length - rawRange.end).toLocaleString()} later{' '}
                              {rawAllLines.length - rawRange.end === 1 ? 'line' : 'lines'}
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="p-3 text-xs text-gray-500 dark:text-gray-400">
                          The raw source is not available for this candidate (archives are read
                          server-side), so findings link by path only.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {report?.ok && findings.length === 0 && rawSource === '' && (
                <div
                  className="flex items-center gap-2 rounded-lg border border-emerald-200 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:text-emerald-200"
                  data-testid="import-quality-no-findings"
                >
                  <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                  No lint findings — this source is clean against the resolved style guide.
                </div>
              )}
            </section>

            <section
              role="tabpanel"
              id={panelElementId(QUALITY_TABS_ID_PREFIX, 'preview')}
              aria-labelledby={tabElementId(QUALITY_TABS_ID_PREFIX, 'preview')}
              tabIndex={0}
              hidden={activeTab !== 'preview'}
              data-testid="import-quality-preview-panel"
              className="focus:outline-none"
            >
              <CatalogImportPreviewPanel
                request={request}
                rawSourceAvailable={rawSource !== ''}
                rawLineCount={rawAllLines.length}
                onSelectSourceLine={setPreviewLine}
                projectSlug={projectSlug}
                onSkipCommit={onCancel}
              />
            </section>

            {isBundle ? (
              <section
                role="tabpanel"
                id={panelElementId(QUALITY_TABS_ID_PREFIX, 'bundle')}
                aria-labelledby={tabElementId(QUALITY_TABS_ID_PREFIX, 'bundle')}
                tabIndex={0}
                hidden={activeTab !== 'bundle'}
                data-testid="import-quality-bundle-panel"
                className="focus:outline-none"
              >
                <CatalogImportBundlePanel
                  request={request}
                  onEntryPointChange={onArchiveRootChange}
                />
              </section>
            ) : null}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={skipPreference}
              onChange={(event) => onSkipPreferenceChange(event.target.checked)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
            />
            Skip this step for clean imports
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            Back
          </Button>
          {gate.canRetry && (
            <Button variant="outline" onClick={handleRetry} data-testid="import-quality-retry">
              <RefreshCw className="h-4 w-4" aria-hidden />
              Retry pre-flight
            </Button>
          )}
          {gate.canOverride && (
            <Button
              variant="outline"
              onClick={handleImportAnyway}
              disabled={waiving}
              data-testid="import-quality-override"
            >
              <AlertTriangle className="h-4 w-4" aria-hidden />
              {waiving ? 'Recording waiver…' : 'Import anyway'}
            </Button>
          )}
          <Button
            onClick={handleImport}
            disabled={loading || waiving || !gate.canImport}
            title={gate.canImport ? undefined : gate.reason}
            data-testid="import-quality-import"
          >
            {gate.tone === 'unscored' && !loading ? 'Import without score' : 'Import'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default CatalogImportQualityStep;
