'use client';

/**
 * CatalogFormatDetailPanel (CPDO-2.1, #4797) — the catalog detail's **Format details** pane.
 *
 * The five existing detail tabs show the *canonical* model (Overview), the raw bytes (Source & Code),
 * how the import happened (Provenance), how good it is (Lint & Score) and its history (Versions).
 * None of them shows the payload in its **own** vocabulary, which for an EDI interchange or a COBOL
 * copybook is the only vocabulary that means anything: an interchange has functional groups and
 * transaction sets, a copybook has level numbers and PICTURE clauses, and the canonical projection
 * keeps neither.
 *
 * This pane is driven by **`payload_analysis` and nothing else** (CPDO-1.1 #4794, filled by CPDO-1.2
 * #4795). It renders:
 *
 *  - the **status** as one of the contract's declared states — available / partial / unavailable /
 *    analyzer-failed — overlaid with the analyzer-warning and redacted facts, each stated in text;
 *  - the record's **metrics** (nodes, depth, warnings, dropped-by-bounding) and per-kind counts;
 *  - a **windowed ARIA tree** of the native structure: filterable, keyboard-navigable, progressively
 *    expanded, with per-node warning badges;
 *  - the **selected node's evidence** — its format-specific attributes, its source location, its
 *    value *statement* (withheld, observed-empty and absent are three different sentences), a
 *    shareable deep link, and a "view source" jump when — and only when — the node's location
 *    carries a line the raw viewer can open;
 *  - CPDO-2.4's **capability panel**, carrying the reviewed explanation for any absence, so an
 *    unmodelled construct is never read as missing customer data.
 *
 * **Lazy.** Nothing is fetched or rendered until the tab is selected, and the record is only fetched
 * when the embedded summary says a tree is actually fetchable — an `unavailable` revision is
 * explained from the summary the detail read already carried, at no extra request.
 *
 * **Honest about permission.** The record endpoint is gated on `imports:view` (a native tree is a
 * structural description of the payload), so a 403 is rendered as a refusal, never as an absence of
 * analysis. "You may not read this" and "there is nothing to read" are different facts.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ChevronRight,
  Code,
  EyeOff,
  Filter,
  Link2,
  ListTree,
  Loader2,
  Lock,
  X,
} from 'lucide-react';
import { cn } from '@lib/utils';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { clampRowIndex, computeWindowedRange } from '@/app/utils/windowed-rows';
import { ANALYSIS_TREE_VIRTUALIZE_ABOVE } from '@/app/utils/preview-budgets';
import {
  analysisKindLabel,
  analysisNodeLabel,
  analysisStatusPresentation,
  buildAnalysisTreeRows,
  defaultExpandedAnalysisIds,
  fetchCatalogAnalysis,
  findAnalysisTypeaheadIndex,
  kindCountEntries,
  locateAnalysisNode,
  nodeAttributeEntries,
  nodeSourceLine,
  nodeValueStatement,
  sortAnalysisWarnings,
  sourceLocationText,
  valueVisibilityStatement,
  warningsByNode,
  type AnalysisRecord,
  type AnalysisSummary,
  type AnalysisTreeRow,
  type AnalysisWarning,
} from '@/app/utils/catalog-payload-analysis';
import {
  isX12Analysis,
  x12ElementPresence,
  x12PresencePresentation,
  x12Reference,
  x12SourceRange,
  X12_KIND_COMPONENT,
  X12_KIND_COMPOSITE,
  X12_KIND_ELEMENT,
  X12_KIND_REPETITION,
} from '@/app/utils/catalog-x12-analysis';
import { CatalogX12InspectorPanel } from './CatalogX12InspectorPanel';
import { FormatCapabilityPanel } from './FormatCapabilityPanel';
import { useFormatCapabilities } from './useFormatCapabilities';
import {
  capabilityForFormat,
  explainAnalysisAbsence,
} from './formatCapabilityRegistry';

/** Node kinds whose presence badge the X12 inspector adds to a row. */
const X12_VALUE_KINDS = new Set<string>([
  X12_KIND_ELEMENT,
  X12_KIND_COMPOSITE,
  X12_KIND_COMPONENT,
  X12_KIND_REPETITION,
]);

/** Uniform tree-row height (px) the windowing arithmetic assumes; matches the `h-8` row class. */
const TREE_ROW_HEIGHT = 32;

/** Height (px) of the tree viewport; matches the `h-[380px]` container class. */
export const ANALYSIS_TREE_HEIGHT = 380;

/** How long (ms) the tree's type-ahead buffer keeps accumulating characters. */
const TYPEAHEAD_RESET_MS = 500;

/** The fetch lifecycle of the analysis record. */
type AnalysisFetchStatus = 'idle' | 'loading' | 'loaded' | 'error' | 'forbidden';

export interface CatalogFormatDetailPanelProps {
  /** The catalog item id (a project id) whose analysis is fetched. */
  itemId: string;
  /**
   * The tree-free analysis summary the detail read embeds (CPDO-1.1). The pane uses it to decide
   * whether a record is fetchable at all, and to explain an absence without a request.
   */
  summary: AnalysisSummary | null | undefined;
  /** The item's raw `sourceFormat`, for the CPDO-2.4 capability lookup. */
  sourceFormat: string | null | undefined;
  /** Whether the Format details tab is active; the record is fetched the first time this is true. */
  active: boolean;
  /** Whether the raw source was captured — gates the "view source" jumps (nothing to open otherwise). */
  sourceAvailable: boolean;
  /**
   * Jump the Source & Code tab to a 1-based source line (and optionally name the file).
   *
   * `range` refines the jump for an analyzer that records exact positions (CPDO-2.2's X12 scan):
   * the viewer selects those characters instead of merely centring the line, which is the only
   * useful behaviour for an interchange written on a single line. `label` names the construct in
   * the viewer's note. Both are optional, so a line-only analyzer calls this unchanged.
   */
  onViewSourceLine: (
    line: number,
    file: string | null,
    range?: { offset: number; length: number } | null,
    label?: string | null,
  ) => void;
  /** Build the shareable deep-link href for a node (`?tab=format&node=…`). */
  nodeHref: (nodeId: string) => string;
  /** Node id a deep link asked to reveal (the `?node=` query param). */
  focusNodeId?: string | null;
  /**
   * Tree viewport height override; tests pass a small value to exercise real windowing (jsdom
   * reports every element height as 0, so the height cannot be measured).
   */
  viewportHeight?: number;
}

/** Badge tone classes. Text always carries the meaning; colour only reinforces it. */
const BADGE_TONE: Record<'positive' | 'caution' | 'neutral' | 'negative', string> = {
  positive:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  caution:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300',
  neutral:
    'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300',
  negative:
    'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/30 dark:text-rose-300',
};

/** A labelled badge whose `label` is read by assistive tech and whose `value` is visible. */
function StateBadge({
  label,
  value,
  tone,
  icon,
  testId,
}: {
  label: string;
  value: string;
  tone: 'positive' | 'caution' | 'neutral' | 'negative';
  icon?: React.ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        BADGE_TONE[tone],
      )}
    >
      {icon}
      <span className="sr-only">{label}: </span>
      {value}
    </span>
  );
}

/**
 * One metric in the record's summary strip.
 *
 * The optional `hint` lives *inside* the `<dd>` rather than beside it: a `<dl>`'s wrapping `<div>`
 * may only hold `<dt>`/`<dd>` groups, and the hint is part of the term's definition anyway.
 */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </dt>
      <dd className="mt-0.5">
        <span className="font-mono text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
          {value}
        </span>
        {hint ? (
          <span className="mt-0.5 block text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            {hint}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

/** Severity presentation for a warning row — the symbol is printed, never colour alone. */
const SEVERITY_META: Record<string, { symbol: string; label: string; tone: keyof typeof BADGE_TONE }> = {
  error: { symbol: '✕', label: 'Error', tone: 'negative' },
  warning: { symbol: '!', label: 'Warning', tone: 'caution' },
  info: { symbol: 'i', label: 'Info', tone: 'neutral' },
};

/** One analyzer warning: its severity, stable code, message and (when known) source location. */
function WarningRow({ warning, testId }: { warning: AnalysisWarning; testId: string }) {
  const meta = SEVERITY_META[warning.severity] ?? {
    symbol: '?',
    label: warning.severity || 'Unknown severity',
    tone: 'neutral' as const,
  };
  const location = sourceLocationText(warning.location);
  return (
    <li
      data-testid={testId}
      data-severity={warning.severity}
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5"
    >
      <StateBadge label="Severity" value={`${meta.symbol} ${meta.label}`} tone={meta.tone} />
      <code className="font-mono text-[11px] text-gray-600 dark:text-gray-400">{warning.code}</code>
      <span className="min-w-0 flex-1 text-xs text-gray-700 dark:text-gray-300">
        {warning.message || 'The analyzer recorded no message for this warning.'}
      </span>
      {location ? (
        <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400">{location}</span>
      ) : null}
    </li>
  );
}

/**
 * Render the Format details pane.
 *
 * @param props See {@link CatalogFormatDetailPanelProps}.
 * @returns The pane body.
 */
export function CatalogFormatDetailPanel({
  itemId,
  summary,
  sourceFormat,
  active,
  sourceAvailable,
  onViewSourceLine,
  nodeHref,
  focusNodeId = null,
  viewportHeight = ANALYSIS_TREE_HEIGHT,
}: CatalogFormatDetailPanelProps) {
  const [status, setStatus] = useState<AnalysisFetchStatus>('idle');
  const [record, setRecord] = useState<AnalysisRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // Bumped by every keyboard/deep-link move so the imperative `.focus()` effect fires exactly then,
  // and never when `focusIndex` merely recomputes (e.g. while typing in the filter).
  const [focusArm, setFocusArm] = useState(0);
  const [missingDeepLink, setMissingDeepLink] = useState<string | null>(null);
  // Latches the first activation. The fetch effect keys off *this* rather than `active`, so a reader
  // who leaves the tab while the request is in flight does not abort it and come back to a pane that
  // will never load — the request is one-shot, and cancelling it would mean cancelling it for good.
  const [requested, setRequested] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const lastFocusIndex = useRef(0);
  const focusArmHandled = useRef(0);
  // The item the record has been requested for, so re-activating the tab never re-fetches.
  const fetchedForRef = useRef<string | null>(null);
  // The deep link already honoured, so re-renders do not fight the user's later navigation.
  const revealedRef = useRef<string | null>(null);
  // Armed when this pane sends the reader to the Source tab, so focus returns to the row they left.
  const restoreOnReturnRef = useRef(false);

  // The CPDO-2.4 registry is fetched only while this pane is showing, and shared process-wide.
  const { snapshot } = useFormatCapabilities(active);

  const summaryStatus = summary?.status ?? null;
  // A record is only worth a request when the summary says a tree is fetchable. An `unavailable` or
  // `failed` revision is fully explained by the summary the detail read already carried — asking for
  // its (empty) tree would cost a request and, for a reader without `imports:view`, a confusing 403
  // about an item that has nothing to show anyway. A missing summary is unknown, so it is fetched.
  const treeFetchable = summary == null || summary.available;

  // Lazy: the record is requested the first time the tab is selected, and only when a tree is
  // fetchable at all.
  useEffect(() => {
    if (active && treeFetchable) setRequested(true);
  }, [active, treeFetchable]);

  useEffect(() => {
    if (!requested || fetchedForRef.current === itemId) return undefined;
    fetchedForRef.current = itemId;
    const controller = new AbortController();
    setStatus('loading');
    setErrorMessage(null);
    fetchCatalogAnalysis(itemId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.record) {
          setRecord(result.record);
          setExpandedIds(defaultExpandedAnalysisIds(result.record.analysis.tree));
          setStatus('loaded');
          return;
        }
        setErrorMessage(result.error);
        setStatus(result.forbidden ? 'forbidden' : 'error');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setErrorMessage(
          error instanceof Error ? error.message : 'The native payload analysis could not be loaded.',
        );
        setStatus('error');
      });
    return () => controller.abort();
  }, [itemId, requested]);

  const analysisDocument = record?.analysis ?? null;
  // Memoised so the empty-tree fallback is not a fresh array on every render (which would make the
  // row derivation below recompute — and, with it, every row's identity — on unrelated state changes).
  const tree = useMemo(() => analysisDocument?.tree ?? [], [analysisDocument]);
  const rows = useMemo(
    () => buildAnalysisTreeRows(tree, expandedIds, filter),
    [tree, expandedIds, filter],
  );
  const nodeWarnings = useMemo(
    () => warningsByNode(analysisDocument?.warnings ?? []),
    [analysisDocument],
  );
  /** Warnings about the record rather than a node — listed separately so neither set is lost. */
  const recordWarnings = useMemo(
    () => sortAnalysisWarnings((analysisDocument?.warnings ?? []).filter((warning) => !warning.nodeId)),
    [analysisDocument],
  );

  // The row holding the roving tabindex: the selected row while it is still in the row set,
  // otherwise the nearest index the last focus sat at — which is what restores a sensible tab stop
  // after a filter change or a collapse has removed the previously focused row.
  const selectedIndex = useMemo(
    () => rows.findIndex((row) => row.id === selectedId),
    [rows, selectedId],
  );
  const focusIndex =
    selectedIndex >= 0 ? selectedIndex : clampRowIndex(lastFocusIndex.current, rows.length) ?? 0;
  useEffect(() => {
    if (selectedIndex >= 0) lastFocusIndex.current = selectedIndex;
  }, [selectedIndex]);

  // Imperative focus once the row set and scroll offset from a move have rendered, so the target is
  // mounted (windowed in, or pinned) before `.focus()` runs.
  useEffect(() => {
    if (focusArm === focusArmHandled.current) return;
    focusArmHandled.current = focusArm;
    rowRefs.current.get(focusIndex)?.focus();
  }, [focusArm, focusIndex]);

  /** Select a row, scroll it into the window, and arm the focus move. */
  const focusRow = useCallback(
    (index: number, nextRows: readonly AnalysisTreeRow[]) => {
      const row = nextRows[index];
      if (!row) return;
      const maxScroll = Math.max(0, nextRows.length * TREE_ROW_HEIGHT - viewportHeight);
      const target = Math.max(0, Math.min(index * TREE_ROW_HEIGHT, maxScroll));
      if (listRef.current) listRef.current.scrollTop = target;
      setScrollTop(target);
      setSelectedId(row.id);
      setFocusArm((n) => n + 1);
    },
    [viewportHeight],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Row activation (click / Enter / Space): select, and toggle a parent's children. */
  const activateRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setSelectedId(row.id);
      lastFocusIndex.current = index;
      if (row.hasChildren) toggleExpanded(row.id);
    },
    [rows, toggleExpanded],
  );

  /**
   * Honour a `?node=` deep link once the record is in hand: expand the node's ancestors, clear any
   * filter that would hide it, then select and focus it. A node the analysis does not carry (bounding
   * dropped it, or a later analyzer renamed it) is *stated* as unresolvable rather than silently
   * resolving to the nearest row.
   */
  useEffect(() => {
    if (!analysisDocument || !focusNodeId || revealedRef.current === focusNodeId) return;
    revealedRef.current = focusNodeId;
    const found = locateAnalysisNode(analysisDocument.tree, focusNodeId);
    if (!found) {
      setMissingDeepLink(focusNodeId);
      return;
    }
    setMissingDeepLink(null);
    const nextExpanded = new Set(expandedIds);
    for (const ancestorId of found.ancestorIds) nextExpanded.add(ancestorId);
    setExpandedIds(nextExpanded);
    setFilter('');
    const nextRows = buildAnalysisTreeRows(analysisDocument.tree, nextExpanded, '');
    const index = nextRows.findIndex((row) => row.id === focusNodeId);
    if (index >= 0) focusRow(index, nextRows);
    else setSelectedId(focusNodeId);
    // `expandedIds` is read, not tracked: the reveal is one-shot per deep link (revealedRef), and
    // tracking it would re-run the effect on every later expansion the reader made themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisDocument, focusNodeId, focusRow]);

  /**
   * Focus restoration across the tab switch this pane initiates. Following a node's source location
   * moves the reader to the Source & Code tab; when they come back, focus returns to the tree row
   * they left rather than to the top of the pane. Armed only by that action, so merely selecting the
   * tab never steals focus from the tab button.
   */
  useEffect(() => {
    if (!active || !restoreOnReturnRef.current || rows.length === 0) return;
    restoreOnReturnRef.current = false;
    setFocusArm((n) => n + 1);
  }, [active, rows.length]);

  /** Follow a node's source location into the Source & Code tab, arming the focus return. */
  const viewSource = useCallback(
    (
      line: number,
      file: string | null,
      range?: { offset: number; length: number } | null,
      label?: string | null,
    ) => {
      restoreOnReturnRef.current = true;
      onViewSourceLine(line, file, range ?? null, label ?? null);
    },
    [onViewSourceLine],
  );

  const typeahead = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: '',
    timer: null,
  });
  useEffect(
    () => () => {
      if (typeahead.current.timer) clearTimeout(typeahead.current.timer);
    },
    [],
  );

  const handleTreeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return;
      const current = focusIndex;
      const row = rows[current];

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateRow(current);
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === 'ArrowDown'
            ? current + 1
            : event.key === 'ArrowUp'
              ? current - 1
              : event.key === 'Home'
                ? 0
                : rows.length - 1;
        const clamped = clampRowIndex(next, rows.length);
        if (clamped !== null) focusRow(clamped, rows);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (!row) return;
        if (row.hasChildren && !row.expanded) {
          setSelectedId(row.id);
          toggleExpanded(row.id);
        } else if (row.expanded) {
          // The first child is the next row of the flat projection.
          const clamped = clampRowIndex(current + 1, rows.length);
          if (clamped !== null) focusRow(clamped, rows);
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (!row) return;
        if (row.expanded) {
          setSelectedId(row.id);
          toggleExpanded(row.id);
          return;
        }
        for (let i = current - 1; i >= 0; i--) {
          if (rows[i].depth === row.depth - 1) {
            focusRow(i, rows);
            return;
          }
        }
        return;
      }
      // Type-ahead: printable characters accumulate briefly and jump to the next matching label.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const state = typeahead.current;
        if (state.timer) clearTimeout(state.timer);
        state.buffer += event.key;
        state.timer = setTimeout(() => {
          state.buffer = '';
          state.timer = null;
        }, TYPEAHEAD_RESET_MS);
        const match = findAnalysisTypeaheadIndex(rows, current, state.buffer);
        if (match !== null) focusRow(match, rows);
      }
    },
    [activateRow, focusIndex, focusRow, rows, toggleExpanded],
  );

  const virtualized = rows.length > ANALYSIS_TREE_VIRTUALIZE_ABOVE;
  const rowWindow = useMemo(
    () =>
      virtualized
        ? computeWindowedRange({
            rowCount: rows.length,
            rowHeight: TREE_ROW_HEIGHT,
            viewportHeight,
            scrollTop,
          })
        : { startIndex: 0, endIndex: rows.length, paddingTop: 0, paddingBottom: 0 },
    [rows.length, scrollTop, viewportHeight, virtualized],
  );
  // Focus pinning: the row holding the roving tabindex must stay mounted even when scrolled out of
  // the window, or focus (and the tree's only Tab stop) would fall off it.
  const pinnedIndex =
    virtualized &&
    rows.length > 0 &&
    (focusIndex < rowWindow.startIndex || focusIndex >= rowWindow.endIndex)
      ? focusIndex
      : null;

  // ── Declared state ────────────────────────────────────────────────────────────────────────────
  // The status is the record's when one is loaded, and the summary's until then — so the pane states
  // a declared status from first paint rather than an empty frame. Every nested read below is
  // optional-chained: `isAnalysisRecord` only guarantees a readable status and tree, so a payload
  // missing a block degrades to the summary's value rather than blanking the screen.
  const declaredStatus = analysisDocument?.status ?? summaryStatus ?? 'unavailable';
  const declaredReason = analysisDocument?.statusReason ?? summary?.statusReason ?? null;
  const presentation = analysisStatusPresentation(declaredStatus);
  const metrics = analysisDocument?.metrics ?? null;
  const nodeCount = metrics?.nodeCount ?? summary?.nodeCount ?? 0;
  const maxDepth = metrics?.maxDepth ?? summary?.maxDepth ?? 0;
  const truncated = metrics?.truncated ?? summary?.truncated ?? false;
  const droppedNodeCount = metrics?.droppedNodeCount ?? 0;
  const warningCount = metrics?.warningCount ?? summary?.warningCount ?? 0;
  const kindCounts = kindCountEntries(metrics?.kindCounts ?? summary?.kindCounts);
  const visibility = analysisDocument?.redaction?.valueVisibility ?? summary?.valueVisibility ?? 'structural';
  const redactedNodeCount = analysisDocument?.redaction?.redactedNodeCount ?? 0;
  const analyzerKey = analysisDocument?.analyzer?.key ?? summary?.analyzerKey ?? null;
  const analyzerVersion = analysisDocument?.analyzer?.version ?? summary?.analyzerVersion ?? null;
  const analysedFormat = analysisDocument?.sourceFormat ?? summary?.sourceFormat ?? sourceFormat ?? null;

  const capability = snapshot ? capabilityForFormat(snapshot, analysedFormat) : null;
  const absence = snapshot ? explainAnalysisAbsence(snapshot, declaredStatus, declaredReason) : null;

  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;
  const selectedNode = selectedRow?.node ?? null;
  const selectedLocation = selectedNode?.location ?? null;
  const selectedLine = nodeSourceLine(selectedLocation);
  // An exact character range, when the analyzer recorded one. It is a strictly better jump than a
  // line — an X12 interchange is routinely one line, where a line jump reveals nothing.
  const selectedRange = x12SourceRange(selectedLocation);
  const selectedValue = selectedNode ? nodeValueStatement(selectedNode, visibility) : null;
  const selectedAttributes = selectedNode ? nodeAttributeEntries(selectedNode) : [];
  const selectedWarnings = selectedNode ? nodeWarnings.get(selectedNode.id) ?? [] : [];
  const filtering = filter.trim() !== '';
  const anythingExpanded = expandedIds.size > 0;
  const isX12Record = isX12Analysis(analysisDocument, analysedFormat);
  // X12-only evidence for the selected construct: its reference designator (`BEG04`, `CLM05-2`) and
  // which of the four value states it is in. Both are null for any other analyzer's record.
  const selectedPresence =
    isX12Record && selectedNode && X12_VALUE_KINDS.has(selectedNode.kind)
      ? x12ElementPresence(selectedNode)
      : null;
  const selectedReference = isX12Record && selectedNode ? x12Reference(selectedNode) : null;

  /**
   * Select and focus one node from outside the tree — what the X12 inspector's transaction-set
   * links do. It expands the node's ancestors first, so the row exists before it is focused, and
   * does nothing at all for a node this analysis does not carry rather than moving focus somewhere
   * arbitrary.
   */
  const revealNode = useCallback(
    (nodeId: string) => {
      if (!analysisDocument) return;
      const found = locateAnalysisNode(analysisDocument.tree, nodeId);
      if (!found) return;
      const nextExpanded = new Set(expandedIds);
      for (const ancestorId of found.ancestorIds) nextExpanded.add(ancestorId);
      nextExpanded.add(nodeId);
      setExpandedIds(nextExpanded);
      setFilter('');
      const nextRows = buildAnalysisTreeRows(analysisDocument.tree, nextExpanded, '');
      const index = nextRows.findIndex((row) => row.id === nodeId);
      if (index >= 0) focusRow(index, nextRows);
    },
    [analysisDocument, expandedIds, focusRow],
  );

  const treeDescriptionId = 'catalog-format-detail-tree-help';

  const renderRow = (row: AnalysisTreeRow, index: number, pinned: boolean) => {
    const selected = row.id === selectedId;
    const location = sourceLocationText(row.node.location);
    const warnings = nodeWarnings.get(row.id) ?? [];
    const worst = warnings[0];
    // For an X12 element the *presence* of a value is the fact that distinguishes a position
    // written and left empty from one that was never written — so it rides on the row rather than
    // waiting for the reader to select it. Only the states that are not the ordinary case are
    // badged, so a tree of ordinary elements stays readable.
    const presence =
      isX12Record && X12_VALUE_KINDS.has(row.node.kind) ? x12ElementPresence(row.node) : null;
    const presenceBadge =
      presence === 'empty' || presence === 'absent' ? x12PresencePresentation(presence) : null;
    return (
      <li
        key={row.id}
        role="presentation"
        style={
          pinned
            ? { position: 'absolute', top: index * TREE_ROW_HEIGHT, left: 0, right: 0 }
            : undefined
        }
      >
        <button
          type="button"
          role="treeitem"
          aria-level={row.depth}
          aria-setsize={row.setSize}
          aria-posinset={row.posInSet}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          aria-selected={selected}
          tabIndex={index === focusIndex ? 0 : -1}
          onClick={() => activateRow(index)}
          ref={(node) => {
            if (node) rowRefs.current.set(index, node);
            else rowRefs.current.delete(index);
          }}
          data-testid="catalog-format-detail-node"
          data-node-id={row.id}
          data-node-kind={row.node.kind}
          style={{ '--tree-depth': row.depth } as React.CSSProperties}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-xs motion-safe:transition',
            'pl-[calc(0.5rem+(var(--tree-depth)-1)*1.125rem)]',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
            selected
              ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100'
              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
          )}
        >
          {row.hasChildren ? (
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-gray-400 motion-safe:transition-transform',
                row.expanded && 'rotate-90',
              )}
              aria-hidden
            />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-gray-600 dark:bg-gray-700/60 dark:text-gray-300">
            {analysisKindLabel(row.node.kind)}
          </span>
          <span className="truncate font-mono">{analysisNodeLabel(row.node)}</span>
          {row.node.redacted ? (
            <span className="shrink-0 rounded bg-violet-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
              redacted
            </span>
          ) : null}
          {presenceBadge ? (
            <span
              data-testid="catalog-format-detail-node-presence"
              data-presence={presence}
              className="shrink-0 rounded bg-sky-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-sky-800 dark:bg-sky-900/40 dark:text-sky-300"
            >
              {presenceBadge.label}
            </span>
          ) : null}
          {worst ? (
            <span
              data-testid="catalog-format-detail-node-warning"
              className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
            >
              {(SEVERITY_META[worst.severity] ?? SEVERITY_META.warning).label}
              {warnings.length > 1 ? ` ×${warnings.length}` : ''}
            </span>
          ) : null}
          {location ? (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-gray-500 dark:text-gray-400">
              {location}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  return (
    <section className={`${dashboardPanelClass} p-6`} data-testid="catalog-detail-format">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          <ListTree className="h-4 w-4 text-indigo-500" aria-hidden />
          Format details
        </h2>
        <p className="text-xs text-gray-400 dark:text-gray-500">
          The imported payload in its own vocabulary
        </p>
      </div>

      {/* Declared state — every one of the contract's five statements is a distinct, textual badge. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <StateBadge
          label="Analysis status"
          value={presentation.label}
          tone={presentation.tone}
          testId="catalog-format-detail-status"
        />
        {truncated ? (
          <StateBadge
            label="Bounding"
            value={
              droppedNodeCount > 0
                ? `Bounded — ${droppedNodeCount.toLocaleString()} nodes dropped`
                : 'Bounded'
            }
            tone="caution"
            testId="catalog-format-detail-truncated"
          />
        ) : null}
        {warningCount > 0 ? (
          <StateBadge
            label="Analyzer warnings"
            value={`${warningCount.toLocaleString()} analyzer warning${warningCount === 1 ? '' : 's'}`}
            tone="caution"
            icon={<AlertTriangle className="h-3 w-3" aria-hidden />}
            testId="catalog-format-detail-warning-state"
          />
        ) : null}
        {redactedNodeCount > 0 ? (
          <StateBadge
            label="Redaction"
            value={`${redactedNodeCount.toLocaleString()} value${redactedNodeCount === 1 ? '' : 's'} withheld`}
            tone="neutral"
            icon={<EyeOff className="h-3 w-3" aria-hidden />}
            testId="catalog-format-detail-redacted"
          />
        ) : null}
        {analyzerKey ? (
          <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">
            {analyzerKey}@{analyzerVersion ?? '0.0.0'}
          </span>
        ) : null}
      </div>

      <p
        data-testid="catalog-format-detail-statement"
        className="mt-2 text-xs leading-snug text-gray-600 dark:text-gray-300"
      >
        {presentation.statement}
      </p>

      {/* Metrics — a text alternative to the tree: the shape of the structure without walking it. */}
      <dl
        data-testid="catalog-format-detail-metrics"
        className="mt-3 grid grid-cols-2 gap-4 rounded-lg border border-gray-100 bg-gray-50/60 p-3 sm:grid-cols-4 dark:border-gray-700/60 dark:bg-gray-900/30"
      >
        <Metric label="Nodes" value={nodeCount.toLocaleString()} />
        <Metric label="Depth" value={maxDepth.toLocaleString()} />
        <Metric label="Warnings" value={warningCount.toLocaleString()} />
        <Metric
          label="Values"
          value={visibility}
          hint={valueVisibilityStatement(visibility)}
        />
      </dl>

      {kindCounts.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Native constructs
          </h3>
          <ul
            data-testid="catalog-format-detail-kinds"
            className="mt-1.5 flex flex-wrap items-center gap-1.5"
          >
            {kindCounts.map(([kind, count]) => (
              <li
                key={kind}
                className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-600 dark:bg-gray-700/60 dark:text-gray-300"
              >
                {analysisKindLabel(kind)}
                <span className="font-mono font-semibold tabular-nums normal-case">
                  {count.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {truncated ? (
        <p
          data-testid="catalog-format-detail-bounding-note"
          className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            The analyzer&apos;s node budget bounded this tree
            {droppedNodeCount > 0
              ? `, so ${droppedNodeCount.toLocaleString()} node${droppedNodeCount === 1 ? '' : 's'} the source had are not recorded here`
              : ''}
            . What is shown is the top of the structure; the missing nodes are absent from the
            record, not from your source, and scrolling cannot reach them.
          </span>
        </p>
      ) : null}

      {/* Transport states. A refusal is never rendered as an absence of analysis. */}
      {status === 'loading' ? (
        <div
          data-testid="catalog-format-detail-loading"
          className="mt-4 flex items-center justify-center gap-2 py-8 text-sm text-gray-600 dark:text-gray-300"
        >
          <Loader2 className="h-5 w-5 motion-safe:animate-spin text-indigo-500" aria-hidden />
          Loading the native payload analysis…
        </div>
      ) : status === 'forbidden' ? (
        <p
          data-testid="catalog-format-detail-forbidden"
          className="mt-4 flex items-start gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
        >
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden />
          <span>
            You do not have permission to read this item&apos;s native payload structure, which is
            gated on <span className="font-mono">imports:view</span>. This is a permission boundary —
            the analysis itself may well exist.
          </span>
        </p>
      ) : status === 'error' ? (
        <p
          data-testid="catalog-format-detail-error"
          className="mt-4 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50/60 px-3 py-2 text-sm text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/20 dark:text-rose-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {errorMessage || 'The native payload analysis could not be loaded.'} Nothing is claimed
            about the source from a failed read.
          </span>
        </p>
      ) : null}

      {recordWarnings.length > 0 ? (
        <section aria-labelledby="catalog-format-detail-warnings-heading" className="mt-4">
          <h3
            id="catalog-format-detail-warnings-heading"
            className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
          >
            Analyzer warnings
          </h3>
          <ul className="mt-1 divide-y divide-gray-100 dark:divide-gray-700/60">
            {recordWarnings.map((warning, index) => (
              <WarningRow
                key={`${warning.code}-${index}`}
                warning={warning}
                testId="catalog-format-detail-warning"
              />
            ))}
          </ul>
        </section>
      ) : null}

      {missingDeepLink ? (
        <p
          data-testid="catalog-format-detail-missing-node"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-300"
        >
          The linked node <span className="font-mono">{missingDeepLink}</span> is not in this
          analysis. A re-import or an analyzer upgrade mints a new analysis, and node ids are only
          stable within one.
        </p>
      ) : null}

      {/* CPDO-2.2: the interchange read as an interchange — envelope controls, declared delimiters,
          every functional group and transaction set, and what the conversion was derived from. It
          renders nothing for a record from any other analyzer. */}
      {isX12Record && analysisDocument ? (
        <CatalogX12InspectorPanel
          document={analysisDocument}
          sourceFormat={analysedFormat}
          onRevealNode={revealNode}
          className="mt-4"
        />
      ) : null}

      {/* The native tree. Absent when the record carries none — nothing here invents structure. */}
      {tree.length > 0 ? (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Filter
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
                aria-hidden
              />
              <input
                type="text"
                data-testid="catalog-format-detail-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter structure…"
                aria-label="Filter the native structure by name, construct, or source location"
                className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-8 text-xs text-gray-700 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              />
              {filtering ? (
                <button
                  type="button"
                  data-testid="catalog-format-detail-filter-clear"
                  onClick={() => setFilter('')}
                  aria-label="Clear the structure filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 motion-safe:transition-colors hover:text-gray-700 dark:hover:text-gray-200"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            <span
              data-testid="catalog-format-detail-row-count"
              className="shrink-0 font-mono text-[10px] tabular-nums text-gray-400 dark:text-gray-500"
            >
              {rows.length.toLocaleString()} of {nodeCount.toLocaleString()} nodes shown
            </span>
            <button
              type="button"
              data-testid="catalog-format-detail-collapse-all"
              onClick={() => setExpandedIds(new Set<string>())}
              disabled={!anythingExpanded || filtering}
              className="shrink-0 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Collapse all
            </button>
            {virtualized ? (
              <span
                data-testid="catalog-format-detail-windowed"
                className="shrink-0 text-[10px] text-gray-500 dark:text-gray-400"
              >
                windowed
              </span>
            ) : null}
          </div>

          <p id={treeDescriptionId} className="sr-only">
            A tree of the imported payload&apos;s native structure. Use the arrow keys to move
            between constructs, Right and Left to expand and collapse, Home and End to jump to the
            ends, and Enter to select a construct and show its evidence below the tree. Rows outside
            the viewport are windowed; every row is reachable by scrolling or by the arrow keys.
          </p>

          {rows.length > 0 ? (
            <div
              ref={listRef}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              onKeyDown={handleTreeKeyDown}
              className="h-[380px] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700"
              style={viewportHeight !== ANALYSIS_TREE_HEIGHT ? { height: viewportHeight } : undefined}
            >
              <ul
                role="tree"
                aria-label="Native payload structure"
                aria-describedby={treeDescriptionId}
                className="relative"
              >
                {rowWindow.paddingTop > 0 ? (
                  <li aria-hidden role="presentation" style={{ height: rowWindow.paddingTop }} />
                ) : null}
                {rows
                  .slice(rowWindow.startIndex, rowWindow.endIndex)
                  .map((row, offset) => renderRow(row, rowWindow.startIndex + offset, false))}
                {rowWindow.paddingBottom > 0 ? (
                  <li aria-hidden role="presentation" style={{ height: rowWindow.paddingBottom }} />
                ) : null}
                {pinnedIndex !== null ? renderRow(rows[pinnedIndex], pinnedIndex, true) : null}
              </ul>
            </div>
          ) : (
            <p
              data-testid="catalog-format-detail-no-matches"
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300"
            >
              No construct matches “{filter.trim()}”. The filter searches names, constructs and
              source locations — never observed values.
            </p>
          )}

          {/* The selected construct's evidence. */}
          {selectedNode && selectedValue ? (
            <section
              aria-labelledby="catalog-format-detail-node-heading"
              data-testid="catalog-format-detail-selected"
              className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3
                  id="catalog-format-detail-node-heading"
                  className="text-sm font-semibold text-gray-900 dark:text-gray-100"
                >
                  <span className="text-gray-500 dark:text-gray-400">
                    {analysisKindLabel(selectedNode.kind)}
                  </span>{' '}
                  <span className="font-mono">{analysisNodeLabel(selectedNode)}</span>
                </h3>
                {selectedValue.withheld ? (
                  <StateBadge
                    label="Redaction"
                    value="Value withheld"
                    tone="neutral"
                    icon={<EyeOff className="h-3 w-3" aria-hidden />}
                  />
                ) : null}
                {selectedPresence ? (
                  <StateBadge
                    label="Element position"
                    value={x12PresencePresentation(selectedPresence).label}
                    tone={
                      x12PresencePresentation(selectedPresence).tone === 'positive'
                        ? 'positive'
                        : x12PresencePresentation(selectedPresence).tone === 'caution'
                          ? 'caution'
                          : 'neutral'
                    }
                    testId="catalog-format-detail-selected-presence"
                  />
                ) : null}
                {selectedReference ? (
                  <span
                    data-testid="catalog-format-detail-selected-reference"
                    className="font-mono text-[11px] text-gray-500 dark:text-gray-400"
                  >
                    {selectedReference}
                  </span>
                ) : null}
                <Link
                  href={nodeHref(selectedNode.id)}
                  data-testid="catalog-format-detail-node-link"
                  title="A shareable address for this construct in this analysis"
                  className="ml-auto inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-indigo-700 transition-colors hover:bg-indigo-50 dark:border-gray-700 dark:bg-gray-800 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
                >
                  <Link2 className="h-3.5 w-3.5" aria-hidden /> Link to this construct
                </Link>
              </div>

              <p className="mt-2 text-xs text-gray-700 dark:text-gray-300">{selectedValue.text}</p>
              {selectedValue.value !== null ? (
                <pre
                  data-testid="catalog-format-detail-node-value"
                  className="mt-1 overflow-x-auto rounded bg-gray-50 p-2 font-mono text-[11px] text-gray-800 dark:bg-gray-900/60 dark:text-gray-200"
                >
                  {selectedValue.value}
                </pre>
              ) : null}

              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Source location
                  </dt>
                  <dd
                    data-testid="catalog-format-detail-node-location"
                    className="mt-0.5 break-words font-mono text-[11px] text-gray-700 dark:text-gray-300"
                  >
                    {sourceLocationText(selectedLocation) ??
                      'This analyzer recorded no source location for this construct.'}
                  </dd>
                </div>
                {selectedAttributes.map(([name, value]) => (
                  <div key={name} className="min-w-0">
                    <dt className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                      {name}
                    </dt>
                    <dd className="mt-0.5 break-words font-mono text-[11px] text-gray-700 dark:text-gray-300">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              {selectedWarnings.length > 0 ? (
                <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-700/60">
                  {selectedWarnings.map((warning, index) => (
                    <WarningRow
                      key={`${warning.code}-${index}`}
                      warning={warning}
                      testId="catalog-format-detail-node-warning-detail"
                    />
                  ))}
                </ul>
              ) : null}

              {/* The raw-source jump. Offered only when the location addresses the raw source —
                  an exact character range, or failing that a line — *and* the source was captured.
                  The viewer streams through the existing `/api/catalog/{id}/source` proxy, so
                  authorization is unchanged by this link. */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {(selectedRange !== null || selectedLine !== null) && sourceAvailable ? (
                  <button
                    type="button"
                    data-testid="catalog-format-detail-view-source"
                    onClick={() =>
                      viewSource(
                        selectedRange?.line ?? selectedLine ?? 1,
                        selectedLocation?.file ?? null,
                        selectedRange,
                        `${analysisKindLabel(selectedNode.kind)} ${analysisNodeLabel(selectedNode)}`,
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    <Code className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
                    {selectedRange !== null
                      ? `Highlight ${selectedRange.length.toLocaleString()} character${
                          selectedRange.length === 1 ? '' : 's'
                        } in the source`
                      : `View source at line ${selectedLine}`}
                  </button>
                ) : (
                  <p
                    data-testid="catalog-format-detail-no-source-jump"
                    className="text-[11px] text-gray-500 dark:text-gray-400"
                  >
                    {!sourceAvailable
                      ? 'The raw source was not captured at import, so there is nothing to open.'
                      : 'This analyzer locates this construct by structural path rather than by a position in the raw source, so the raw viewer cannot be opened at it.'}
                  </p>
                )}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {/* CPDO-2.4: what apiome can ever say about this format, and the reviewed wording for any
          absence. Explanatory, never a gate — a registry that failed to load simply renders nothing. */}
      {capability ? (
        <FormatCapabilityPanel
          capability={capability}
          absence={absence}
          className="mt-4"
        />
      ) : null}
    </section>
  );
}

export default CatalogFormatDetailPanel;
