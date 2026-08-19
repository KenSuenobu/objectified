"use client";

/**
 * Endpoint-detail "Versions" tab (V2-MCP-24.3 / MCAT-10.3; re-skinned by HIVE-7.8, #5325).
 *
 * An endpoint's snapshot timeline beside the diff between any two of them. Ticking two rows —
 * or picking a base and a target from the selectors — computes the compare through
 * `/api/mcp/endpoints/{id}/versions/compare`, which auto-orders older → newer whichever way they
 * were picked. The layout switch (side-by-side / unified) is remembered across visits.
 *
 * ### What HIVE-7.8 changed
 *
 * Authority: `docs/mockups/sources/mcp-endpoint.html`'s Versions panel.
 *
 * 1. **The layout switch was a hand-rolled radiogroup** with `bg-indigo-100 text-indigo-700` on
 *    the selected segment. It is `ui/Segmented`, which is the mockup's `.segmented` and already
 *    owns the roving-focus and arrow-key behaviour this one re-implemented in `onClick`.
 * 2. **Each change row was a tinted band** — `border-l-4 border-green-500 bg-green-50` and its
 *    two siblings — so a twelve-change diff was a wall of colour. The tone lives on the kind
 *    badge and on a 2 px leading rule now (see `mcpVersionsUi`), and the row itself is a
 *    hairline card.
 * 3. **The timeline's +/−/~ counts were `text-green-600` / `text-red-600` / `text-blue-600`.**
 *    They resolve through the shared vocabulary, which is what makes them the same three
 *    colours as the digest panel's on the Insight tab.
 * 4. **A ticked row was `border-indigo-400 bg-indigo-50`.** It is `.mcp-timeline__row
 *    [data-selected]` — `--accent-soft` plus an accent hairline, the pair `ui/Card`'s
 *    `selected` variant draws.
 *
 * The compare contract is untouched: the same auto-ordering, the same deep-link handling for a
 * churn-timeline request, the same lazily-mounted Monaco diff.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignJustify,
  ArrowLeftRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  GitCompareArrows,
  History,
  Loader2,
} from "lucide-react";
import { Badge } from "@/app/components/ui/Badge";
import { Button } from "@/app/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/app/components/ui/Card";
import { Checkbox } from "@/app/components/ui/Checkbox";
import { LoadingState } from "@/app/components/ui/LoadingState";
import { EmptyState } from "@/app/components/ui/EmptyState";
import { FormField } from "@/app/components/ui/FormField";
import { Segmented, SegmentedItem } from "@/app/components/ui/Segmented";
import { McpDisclosure } from "@/app/components/ui/mcp/McpDisclosure";
import { McpJsonViewer } from "@/app/components/ui/mcp/McpJsonViewer";
import {
  McpJsonDiffViewer,
  type McpDiffMode,
} from "@/app/components/ui/mcp/McpJsonDiffViewer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/Select";
import { mcpScoreLabel, mcpScoreVariant } from "@/app/components/ade/dashboard/mcp/mcpBrowseUi";
import {
  mcpChangeBeforeAfter,
  mcpChangeCountParts,
  mcpChangeItemPath,
  mcpChangeStyle,
  mcpCompareHeader,
  mcpDiffSelectionForVersion,
  mcpOrderedPair,
  mcpToggleSelection,
  mcpVersionChangeCountParts,
  mcpVersionDateTag,
  mcpVersionListFromPayload,
  mcpVersionCompareFromPayload,
  mcpVersionSeqLabel,
  type McpVersionChange,
  type McpVersionCompare,
  type McpVersionSummary,
} from "@/app/components/ade/dashboard/mcp/mcpVersionsUi";

interface Props {
  endpointId: string;
  /**
   * A deep-link request from the churn timeline (MCAT-16.1): open the diff for this snapshot. When
   * set, the panel selects that version against its predecessor once its history has loaded, then
   * clears the request via {@link onDiffRequestConsumed}. Absent on a normal (non-deep-linked) visit.
   */
  requestedDiffVersionId?: string | null;
  /** Called once a {@link requestedDiffVersionId} has been applied, so the parent can clear it. */
  onDiffRequestConsumed?: () => void;
}

/** localStorage key remembering the preferred diff layout (side-by-side vs unified). */
const DIFF_MODE_STORAGE_KEY = "mcp-versions-diff-mode";

/** Default selection: the two newest snapshots (so the diff opens on the latest change). */
function defaultSelection(versions: McpVersionSummary[]): string[] {
  if (versions.length >= 2) return [versions[0].id, versions[1].id];
  if (versions.length === 1) return [versions[0].id];
  return [];
}

/**
 * The JSON detail under one change row. A modification renders a real base→target diff (split or
 * unified per the panel's layout toggle); an addition or removal has only one side, so it renders
 * that side's definition as a plain read-only block. All editors mount lazily on first expand.
 */
function ChangeDetail({
  change,
  diffMode,
  defaultOpen,
}: {
  change: McpVersionChange;
  diffMode: McpDiffMode;
  /** Seed open state (from the panel's expand-all control); the row stays toggleable after. */
  defaultOpen: boolean;
}) {
  const { before, after } = mcpChangeBeforeAfter(change);
  if (before !== null && after !== null) {
    const lineCount = Math.max(before.split("\n").length, after.split("\n").length);
    return (
      <McpDisclosure
        label="Diff"
        icon={<GitCompareArrows className="size-3.5 shrink-0 text-fg-muted" aria-hidden />}
        meta={`${lineCount} ${lineCount === 1 ? "line" : "lines"}`}
        defaultOpen={defaultOpen}
      >
        <McpJsonDiffViewer
          original={before}
          modified={after}
          mode={diffMode}
          className="rounded-none border-0"
        />
      </McpDisclosure>
    );
  }
  const only = before ?? after;
  if (only === null) return null;
  const lineCount = only.split("\n").length;
  return (
    <McpDisclosure
      label={before !== null ? "Removed definition" : "Added definition"}
      meta={`${lineCount} ${lineCount === 1 ? "line" : "lines"}`}
      defaultOpen={defaultOpen}
    >
      <McpJsonViewer value={only} className="rounded-none border-0" />
    </McpDisclosure>
  );
}

/**
 * One change: its kind, the capability it touched, and the diff under it.
 *
 * The kind's tone is on the badge and on the row's 2 px leading rule — never as a fill behind
 * the JSON, which is the thing a reader is actually here to read.
 */
function ChangeRow({
  change,
  diffMode,
  detailKey,
  detailDefaultOpen,
}: {
  change: McpVersionChange;
  diffMode: McpDiffMode;
  /** Remount key for the detail disclosure — bumped by expand/collapse-all to reseed open state. */
  detailKey: string;
  detailDefaultOpen: boolean;
}) {
  const style = mcpChangeStyle(change.change_type);
  const fields = change.change_type === "modified" ? change.detail.fields ?? [] : [];
  return (
    <article
      className={`mcp-change ${style.rowClass}`}
      data-change-type={change.change_type}
      data-testid={`mcp-change-${change.item_type}-${change.item_name}`}
    >
      <div className="mcp-change__head">
        <Badge variant={style.badgeVariant} title={style.label}>
          <span aria-hidden>{style.sign}</span> {style.label}
        </Badge>
        <span className="mcp-change__path mono">{mcpChangeItemPath(change)}</span>
        {fields.length > 0 ? (
          <span className="mcp-change__fields">
            {fields.map((field) => field.field).join(", ")} changed
          </span>
        ) : null}
      </div>
      <ChangeDetail
        key={detailKey}
        change={change}
        diffMode={diffMode}
        defaultOpen={detailDefaultOpen}
      />
    </article>
  );
}

/**
 * The side-by-side / unified layout switch.
 *
 * `ui/Segmented` — the mockup's `.segmented` — rather than the hand-rolled radiogroup this was:
 * a genuine *toggle* (it changes how the current pane is drawn, it does not name a destination),
 * which is exactly the distinction `tabStyles` records for when a control keeps its segmented
 * look instead of becoming a tab.
 *
 * @param props.mode     The selected layout.
 * @param props.onChange Called with the newly selected layout.
 * @returns The two-option switch.
 */
function DiffModeToggle({
  mode,
  onChange,
}: {
  mode: McpDiffMode;
  onChange: (mode: McpDiffMode) => void;
}) {
  return (
    <Segmented
      size="sm"
      value={mode}
      onValueChange={(value) => onChange(value as McpDiffMode)}
      aria-label="Diff layout"
      data-testid="mcp-diff-layout"
    >
      <SegmentedItem value="split">
        <Columns2 aria-hidden />
        Side-by-side
      </SegmentedItem>
      <SegmentedItem value="unified">
        <AlignJustify aria-hidden />
        Unified
      </SegmentedItem>
    </Segmented>
  );
}

/**
 * One row of the version timeline, with a checkbox that ticks it into the compare selection.
 *
 * The whole row is the label, so the click target is the row rather than the 16 px box — and
 * ticked is `--accent-soft` plus an accent hairline rather than the `border-indigo-400
 * bg-indigo-50` pair it was.
 *
 * @param props.version  The snapshot.
 * @param props.checked  Whether it is in the current selection.
 * @param props.onToggle Called with the snapshot's id when the row is clicked.
 * @returns The timeline row.
 */
function TimelineRow({
  version,
  checked,
  onToggle,
}: {
  version: McpVersionSummary;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  const checkboxId = `mcp-version-${version.id}`;
  const counts = mcpVersionChangeCountParts(version.change_counts);
  return (
    <label
      htmlFor={checkboxId}
      data-selected={checked ? '' : undefined}
      data-testid={`mcp-version-row-${version.id}`}
      className="mcp-timeline__row"
    >
      <Checkbox
        id={checkboxId}
        checked={checked}
        onCheckedChange={() => onToggle(version.id)}
        className="mt-0.5"
      />
      <div className="mcp-timeline__main">
        <div className="mcp-timeline__head">
          <span className="text-sm font-semibold text-fg">
            {mcpVersionSeqLabel(version.version_seq)}
          </span>
          {version.is_current ? <Badge status="published">Current</Badge> : null}
          <Badge variant={mcpScoreVariant(version.score)}>
            {mcpScoreLabel(version.score, version.grade)}
          </Badge>
        </div>
        <div className="mcp-timeline__sub">{mcpVersionDateTag(version)}</div>
        <div className="mcp-timeline__counts">
          {counts.map((part) => (
            <span key={part.key} className={`mcp-tone-figure ${part.colorClass}`}>
              {part.label}
            </span>
          ))}
        </div>
      </div>
    </label>
  );
}

/**
 * The compare-bar selectors (base / target), wired to the same selection model as the timeline.
 *
 * @param props.versions Every snapshot, newest first.
 * @param props.baseId   The chronologically older of the current pair, or `null`.
 * @param props.targetId The newer of the pair, or `null`.
 * @param props.onPick   Called with the slot (0 = base, 1 = target) and the chosen id.
 * @returns The two selectors and the glyph between them.
 */
function CompareBar({
  versions,
  baseId,
  targetId,
  onPick,
}: {
  versions: McpVersionSummary[];
  baseId: string | null;
  targetId: string | null;
  onPick: (slot: 0 | 1, id: string) => void;
}) {
  const optionLabel = (version: McpVersionSummary) =>
    `${mcpVersionSeqLabel(version.version_seq)} · ${mcpVersionDateTag(version)}`;
  return (
    <div className="mcp-compare-bar">
      <FormField label="Base version" htmlFor="mcp-compare-base">
        <Select value={baseId ?? undefined} onValueChange={(value) => onPick(0, value)}>
          <SelectTrigger id="mcp-compare-base" aria-label="Base version">
            <SelectValue placeholder="Select base…" />
          </SelectTrigger>
          <SelectContent>
            {versions.map((version) => (
              <SelectItem key={version.id} value={version.id}>
                {optionLabel(version)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <ArrowLeftRight className="mcp-compare-bar__glyph size-5" aria-hidden />
      <FormField label="Target version" htmlFor="mcp-compare-target">
        <Select value={targetId ?? undefined} onValueChange={(value) => onPick(1, value)}>
          <SelectTrigger id="mcp-compare-target" aria-label="Target version">
            <SelectValue placeholder="Select target…" />
          </SelectTrigger>
          <SelectContent>
            {versions.map((version) => (
              <SelectItem key={version.id} value={version.id}>
                {optionLabel(version)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    </div>
  );
}

/** The rendered diff for the selected pair: header, change counts, and color-coded rows. */
function DiffPanel({
  compare,
  comparing,
  error,
  hasSelection,
  diffMode,
  expandAll,
  expandGeneration,
}: {
  compare: McpVersionCompare | null;
  comparing: boolean;
  error: string | null;
  hasSelection: boolean;
  diffMode: McpDiffMode;
  /** Whether the expand-all control last asked for open (seeds each row's disclosure). */
  expandAll: boolean;
  /** Bumped on every expand/collapse-all click so the disclosures remount into the new state. */
  expandGeneration: number;
}) {
  if (!hasSelection) {
    return (
      <EmptyState
        variant="inline"
        tone="neutral"
        icon={<GitCompareArrows aria-hidden />}
        title="Pick two versions"
        description="Choose a base and a target — from the selectors or by ticking two versions in the timeline — to see exactly what changed."
        data-testid="mcp-diff-unselected"
      />
    );
  }
  if (comparing && !compare) {
    return <LoadingState minHeightClassName="min-h-[10rem]" message="Computing diff…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="inline"
        tone="danger"
        icon={<GitCompareArrows aria-hidden />}
        title="Diff unavailable"
        description={error}
        data-testid="mcp-diff-error"
      />
    );
  }
  if (!compare) return null;

  const identical = !compare.fingerprint_changed && compare.changes.length === 0;
  return (
    <div className="flex flex-col gap-3" aria-busy={comparing}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="mono text-base font-semibold text-fg">{mcpCompareHeader(compare)}</h4>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {mcpChangeCountParts(compare).map((part) => (
            <span key={part.key} className={`mcp-tone-figure ${part.colorClass}`}>
              {part.label}
            </span>
          ))}
        </div>
      </div>
      {identical ? (
        <EmptyState
          variant="inline"
          tone="neutral"
          icon={<GitCompareArrows aria-hidden />}
          title="Identical surface"
          description="These two versions expose the same capabilities and metadata — nothing changed between them."
          data-testid="mcp-diff-identical"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {compare.changes.map((change) => (
            <ChangeRow
              key={`${change.item_type}:${change.item_name}`}
              change={change}
              diffMode={diffMode}
              detailKey={`gen-${expandGeneration}`}
              detailDefaultOpen={expandAll}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function McpVersionHistory({
  endpointId,
  requestedDiffVersionId = null,
  onDiffRequestConsumed,
}: Props) {
  const [versions, setVersions] = useState<McpVersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Up to two ticked version ids, in pick order (chronological order is derived for the diff). */
  const [selection, setSelection] = useState<string[]>([]);
  const [compare, setCompare] = useState<McpVersionCompare | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  /** Diff layout (side-by-side vs unified), remembered across visits. */
  const [diffMode, setDiffMode] = useState<McpDiffMode>(() =>
    typeof window !== "undefined" && window.localStorage.getItem(DIFF_MODE_STORAGE_KEY) === "unified"
      ? "unified"
      : "split",
  );
  /** Expand-all state: the seed every diff disclosure remounts into when the generation bumps. */
  const [expandAll, setExpandAll] = useState(false);
  const [expandGeneration, setExpandGeneration] = useState(0);
  const mountedRef = useRef(true);
  // A deep-link request (from the churn timeline) is read inside the history-load effect below. Held
  // in refs so honoring it never re-keys that effect (which would needlessly re-fetch the history)
  // and so the latest handler is always called. The detail page unmounts this tab when inactive, so
  // each deep-link arrives on a fresh mount and is applied as the initial selection — no flash of the
  // default two-newest diff before the requested one.
  const requestedDiffRef = useRef(requestedDiffVersionId);
  requestedDiffRef.current = requestedDiffVersionId;
  const onDiffRequestConsumedRef = useRef(onDiffRequestConsumed);
  onDiffRequestConsumedRef.current = onDiffRequestConsumed;

  const toggleExpandAll = useCallback(() => {
    setExpandAll((prev) => !prev);
    setExpandGeneration((gen) => gen + 1);
  }, []);

  const changeDiffMode = useCallback((mode: McpDiffMode) => {
    setDiffMode(mode);
    try {
      window.localStorage.setItem(DIFF_MODE_STORAGE_KEY, mode);
    } catch {
      // Storage unavailable (private mode / quota) — the toggle still works for this visit.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}/versions`, {
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        const list = mcpVersionListFromPayload(data);
        if (!active) return;
        setVersions(list);
        // Honor a churn-timeline deep-link when one is pending: open that version against its
        // predecessor instead of the default two-newest diff, then let the parent clear the request.
        const requested = requestedDiffRef.current;
        const requestedSelection = requested ? mcpDiffSelectionForVersion(requested, list) : [];
        if (requestedSelection.length > 0) {
          setSelection(requestedSelection);
          onDiffRequestConsumedRef.current?.();
        } else {
          setSelection(defaultSelection(list));
        }
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Could not load version history.");
        setVersions([]);
        setSelection([]);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpointId]);

  /** Chronologically ordered base→target for the current selection (auto-swaps older→newer). */
  const pair = useMemo(() => mcpOrderedPair(selection, versions), [selection, versions]);
  const baseId = pair?.base.id ?? null;
  const targetId = pair?.target.id ?? null;

  const runCompare = useCallback(
    async (base: string, target: string) => {
      setComparing(true);
      setCompareError(null);
      try {
        const res = await fetch(
          `/api/mcp/endpoints/${endpointId}/versions/compare?base=${encodeURIComponent(
            base,
          )}&target=${encodeURIComponent(target)}`,
          { credentials: "include", cache: "no-store" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        const parsed = mcpVersionCompareFromPayload(data);
        if (!mountedRef.current) return;
        if (!parsed) throw new Error("Malformed compare response.");
        setCompare(parsed);
      } catch (e) {
        if (!mountedRef.current) return;
        setCompare(null);
        setCompareError(e instanceof Error ? e.message : "Could not compare versions.");
      } finally {
        if (mountedRef.current) setComparing(false);
      }
    },
    [endpointId],
  );

  useEffect(() => {
    if (!baseId || !targetId) {
      setCompare(null);
      setCompareError(null);
      return;
    }
    void runCompare(baseId, targetId);
  }, [baseId, targetId, runCompare]);

  const toggleVersion = useCallback((id: string) => {
    setSelection((prev) => mcpToggleSelection(prev, id));
  }, []);

  /** Set one selector slot (0 = base, 1 = target), preserving the other slot's pick. */
  const pickSlot = useCallback((slot: 0 | 1, id: string) => {
    setSelection((prev) => {
      const slots: [string | null, string | null] = [prev[0] ?? null, prev[1] ?? null];
      slots[slot] = id;
      return slots.filter((value): value is string => Boolean(value));
    });
  }, []);

  if (loading) {
    return <LoadingState minHeightClassName="min-h-[14rem]" message="Loading version history…" />;
  }
  if (error || versions.length === 0) {
    return (
      <EmptyState
        icon={<History aria-hidden />}
        tone={error ? 'danger' : 'neutral'}
        title="No version history"
        description={
          error ?? "This endpoint has no recorded version snapshots yet. Run discovery to create one."
        }
        data-testid="mcp-versions-empty"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody>
          <CompareBar versions={versions} baseId={baseId} targetId={targetId} onPick={pickSlot} />
          <p className="mt-3 text-xs text-fg-muted">
            The selection auto-orders older → newer — pick from either control, or tick two
            versions in the timeline.
          </p>
        </CardBody>
      </Card>

      <div className="mcp-versions">
        <Card data-testid="mcp-version-timeline">
          <CardHeader className="flex-row items-center gap-2">
            <History aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
            <CardTitle>Timeline</CardTitle>
            <Badge variant="neutral">{versions.length}</Badge>
          </CardHeader>
          <div className="mcp-timeline">
            {versions.map((version) => (
              <TimelineRow
                key={version.id}
                version={version}
                checked={selection.includes(version.id)}
                onToggle={toggleVersion}
              />
            ))}
          </div>
        </Card>

        <Card className="min-w-0" data-testid="mcp-version-diff">
          <CardHeader className="flex-row flex-wrap items-center gap-2">
            {comparing ? (
              <Loader2 aria-hidden className="size-[var(--fs-md)] shrink-0 animate-spin text-fg-muted" />
            ) : (
              <GitCompareArrows aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
            )}
            <CardTitle>Diff</CardTitle>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={toggleExpandAll}
                disabled={!compare || compare.changes.length === 0}
                title={expandAll ? "Collapse every change's detail" : "Expand every change's detail"}
              >
                {expandAll ? (
                  <ChevronsDownUp aria-hidden />
                ) : (
                  <ChevronsUpDown aria-hidden />
                )}
                {expandAll ? 'Collapse all' : 'Expand all'}
              </Button>
              <DiffModeToggle mode={diffMode} onChange={changeDiffMode} />
            </div>
          </CardHeader>
          <CardBody>
            <DiffPanel
              compare={compare}
              comparing={comparing}
              error={compareError}
              hasSelection={selection.length > 0}
              diffMode={diffMode}
              expandAll={expandAll}
              expandGeneration={expandGeneration}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
