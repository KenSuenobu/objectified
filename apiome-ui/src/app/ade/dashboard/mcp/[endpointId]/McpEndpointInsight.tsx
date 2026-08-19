"use client";

/**
 * Endpoint-detail "Insight" tab (V2-MCP-28.4 / MCAT-14.x–17.x; re-skinned by HIVE-7.8, #5325).
 *
 * Fourteen views onto one snapshot's capability surface, filed under the four groups the roadmap
 * arc gives them, with a snapshot selector and a report export above them. Every panel is pure
 * given its props and every read runs in this component's effects, so switching views is instant
 * and never re-fetches.
 *
 * ### What HIVE-7.8 changed
 *
 * Authority: `docs/mockups/sources/mcp-endpoint.html`'s Insight panel, whose `.insight-rail` and
 * fourteen `[data-tab-panel]` blocks this is.
 *
 * 1. **The rail was Tailwind utilities over `TAB_LIST_SCROLL_CLASS`**, including a
 *    `lg:border-gray-200 dark:lg:border-gray-700` edge and `text-gray-400
 *    group-data-[state=active]:text-indigo-600` glyphs. It is `.mcp-insight__rail`, whose
 *    sticky offset is a token rather than the mockup's `top: 140px` and whose width is `rem`
 *    rather than its `240px`.
 * 2. **The snapshot selector was a bare `<select>`** carrying eight palette classes and its own
 *    `h-9`. It is `ui/Select` in a `ui/FormField`, like every other select on the route.
 * 3. **The export control was a `<details>` menu.** A menu that does not trap focus, does not
 *    close on Escape and does not answer the arrow keys. It is a Radix `DropdownMenu` on the
 *    same `.mcp-menu` surface the tenants table uses; the three formats, the print path and the
 *    cataloger-commentary switch are unchanged.
 * 4. **Each panel's heading was `text-gray-900 dark:text-white` over an indigo glyph.** They
 *    are `ui/Card` headers on tokens.
 *
 * The nested-tab question the ticket's fourth acceptance criterion asks about resolves here:
 * this rail is a Radix `Tabs.Root` of its own, mounted inside the outer strip's `insight`
 * panel. The outer strip is *not* Radix (see `McpEndpointTabs`), so the two share no context
 * and switching a view never disturbs the tab it lives in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import {
  Activity,
  BarChart3,
  BookOpen,
  ChevronDown,
  Download,
  FileCode2,
  FileText,
  GitCompareArrows,
  History,
  Printer,
  Layers,
  LayoutGrid,
  LineChart,
  ListTree,
  Gauge,
  Loader2,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Trophy,
} from "lucide-react";
import { Badge } from "@/app/components/ui/Badge";
import { Button } from "@/app/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/app/components/ui/Card";
import { Checkbox } from "@/app/components/ui/Checkbox";
import { FormField } from "@/app/components/ui/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/Select";
import { tabRailTriggerRadixClass } from "@/app/components/ui/tabStyles";
import { Stat, StatGrid } from "@/app/components/ui/metrics";
import { LoadingState } from "@/app/components/ui/LoadingState";
import { EmptyState } from "@/app/components/ui/EmptyState";
import { ServerProfileCard } from "@/app/components/ui/mcp/ServerProfileCard";
import { CapabilityGraphPanel } from "@/app/components/ui/mcp/CapabilityGraphPanel";
import { ToolComplexityPanel } from "@/app/components/ui/mcp/ToolComplexityPanel";
import { SafetyPosturePanel } from "@/app/components/ui/mcp/SafetyPosturePanel";
import { DocCoveragePanel } from "@/app/components/ui/mcp/DocCoveragePanel";
import { CapabilityChurnPanel } from "@/app/components/ui/mcp/CapabilityChurnPanel";
import { CapabilityPresenceMatrixPanel } from "@/app/components/ui/mcp/CapabilityPresenceMatrixPanel";
import { GradeSurfaceTrendPanel } from "@/app/components/ui/mcp/GradeSurfaceTrendPanel";
import { ChangedSinceDigestPanel } from "@/app/components/ui/mcp/ChangedSinceDigestPanel";
import { TrustDriftAlertsPanel } from "@/app/components/ui/mcp/TrustDriftAlertsPanel";
import { DiscoveryHealthPanel } from "@/app/components/ui/mcp/DiscoveryHealthPanel";
import { ToolLatencyPanel } from "@/app/components/ui/mcp/ToolLatencyPanel";
import {
  ScoreBreakdownPanel,
  type McpScoreNavigateToItem,
} from "@/app/components/ui/mcp/ScoreBreakdownPanel";
import { TrustProfilePanel } from "@/app/components/ui/mcp/TrustProfilePanel";
import { PeerPercentilePanel } from "@/app/components/ui/mcp/PeerPercentilePanel";
import {
  mcpVersionDetailFromPayload,
  type McpCapabilityItem,
  type McpEndpointDetail,
  type McpVersionDetail,
} from "@/app/components/ade/dashboard/mcp/mcpBrowseUi";
import {
  mcpVersionDateTag,
  mcpVersionListFromPayload,
  mcpVersionSeqLabel,
  type McpVersionSummary,
} from "@/app/components/ade/dashboard/mcp/mcpVersionsUi";
import {
  mcpInsightSurfaceFromPayload,
  mcpServerProfileFrom,
  mcpTypeCountTiles,
  type McpInsightSurface,
} from "@/app/components/ade/dashboard/mcp/mcpInsightUi";
import {
  mcpInsightGraphFromPayload,
  type McpCapabilityGraph,
} from "@/app/components/ade/dashboard/mcp/mcpCapabilityGraphUi";
import {
  mcpEvolutionSeriesFromPayload,
  type McpEvolutionPoint,
} from "@/app/components/ade/dashboard/mcp/mcpEvolutionUi";
import {
  mcpDigestFromPayload,
  type McpEndpointDigest,
} from "@/app/components/ade/dashboard/mcp/mcpDigestUi";
import {
  mcpReliabilityHealthFromPayload,
  mcpToolReliabilityFromPayload,
  type McpDiscoveryHealth,
  type McpToolReliability,
} from "@/app/components/ade/dashboard/mcp/mcpReliabilityUi";
import {
  mcpLintReportFromPayload,
  type McpLintReport,
} from "@/app/components/ade/dashboard/mcp/mcpLintUi";
import {
  mcpTrustProfileFromPayload,
  type McpTrustProfile,
} from "@/app/components/ade/dashboard/mcp/mcpTrustUi";
import {
  mcpPeerPercentileFromPayload,
  type McpPeerPercentileProfile,
} from "@/app/components/ade/dashboard/mcp/mcpPeerPercentileUi";

interface Props {
  endpointId: string;
  /** The endpoint's current snapshot, used as the version selector's default when present. */
  currentVersionId: string | null;
  /**
   * The loaded endpoint record, threaded from the detail page so the profile-card header can show
   * endpoint-level facts (transport, discovery health, catalog name) the version summary lacks.
   * Optional so the tab still renders (with a degraded card) when it is not supplied.
   */
  endpoint?: McpEndpointDetail | null;
  /**
   * The current version's server `instructions`, threaded from the detail page. Rendered by the
   * profile card only while the current snapshot is selected (instructions are snapshot-specific and
   * the version summary does not carry historical ones).
   */
  currentInstructions?: string | null;
  /**
   * Deep-link a snapshot's churn column to its diff: called with a `version_id` when a column in the
   * churn timeline is activated. The detail page handles it by switching to the Versions tab and
   * selecting that version against its predecessor (MCAT-16.1 → MCAT-10.3). Optional so the tab still
   * works standalone (the columns simply become inert when no handler is supplied).
   */
  onOpenVersionDiff?: (versionId: string) => void;
  /**
   * Deep-link a lint finding (from the score-breakdown panel) to its offending capability item on the
   * Capabilities tab. The detail page handles it by switching to the Capabilities tab and scrolling to
   * the item (the same handler the Lint & Score tab uses). Optional so the tab still works standalone
   * (the finding paths simply render as inert text when no handler is supplied).
   */
  onNavigateToItem?: McpScoreNavigateToItem;
}

/**
 * The Insight tab's left-nav grouping. Each group heads a cluster of selectable views in the vertical
 * navigation; a `null` label is the ungrouped lead cluster (the Overview lives there). The groups
 * mirror the roadmap arc — capability surface (Epic 15), surface evolution (Epic 16), and reliability
 * & trust (Epic 17) — and every insight panel is assigned to exactly one of them.
 */
const INSIGHT_GROUPS = [
  { key: "summary", label: null },
  { key: "surface", label: "Capability surface" },
  { key: "evolution", label: "Surface evolution" },
  { key: "reliability", label: "Reliability & trust" },
] as const;

type InsightGroupKey = (typeof INSIGHT_GROUPS)[number]["key"];

/**
 * One selectable insight view: a left-nav entry (icon + label, filed under a group) and the panel it
 * reveals on the right. The nodes are assembled in the component render because each closes over the
 * fetched state; this type just gives the nav/content loop a stable shape to iterate.
 */
interface InsightView {
  key: string;
  group: InsightGroupKey;
  label: string;
  icon: typeof BarChart3;
  node: React.ReactNode;
}

/**
 * One insight panel: a titled card with a one-line description, and the chart or table below it.
 *
 * Every one of the fourteen views is this shape, which is why it is a component rather than the
 * `<div className={dashboardPanelPaddedClass}><PanelHeading …/></div>` pair it replaces — that
 * spelled the panel surface fifteen times and named two palettes each time.
 *
 * @param props.icon        The glyph beside the title.
 * @param props.title       What the panel shows.
 * @param props.description One line on how to read it.
 * @param props.children    The panel's content.
 * @returns The card.
 */
function InsightPanel({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof BarChart3;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card data-testid={`mcp-insight-panel-${title}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
          {title}
        </CardTitle>
        <p className="text-xs text-fg-muted">{description}</p>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

/** Option label for a version in the selector: its sequence label plus its date/tag. */
function versionOptionLabel(version: McpVersionSummary): string {
  return `${mcpVersionSeqLabel(version.version_seq)} · ${mcpVersionDateTag(version)}`;
}

/**
 * The snapshot selector — which version's insight the fourteen views describe.
 *
 * `ui/Select` in a `ui/FormField`, like every other select on this route. It was a bare
 * `<select>` carrying its own `h-9` and eight palette classes, which is how the one control on
 * this tab ended up the only one in the app that did not follow the density preference.
 *
 * @param props.versions Every snapshot, newest first.
 * @param props.value    The selected snapshot's id.
 * @param props.disabled Whether a fetch is in flight.
 * @param props.onChange Called with the newly selected id.
 * @returns The labelled selector.
 */
function VersionSelector({
  versions,
  value,
  disabled,
  onChange,
}: {
  versions: McpVersionSummary[];
  value: string | null;
  disabled: boolean;
  onChange: (versionId: string) => void;
}) {
  return (
    <FormField label="Snapshot" htmlFor="mcp-insight-version" className="min-w-[14rem]">
      <Select value={value ?? undefined} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id="mcp-insight-version" aria-label="Snapshot">
          <SelectValue placeholder="Select a snapshot…" />
        </SelectTrigger>
        <SelectContent>
          {versions.map((version) => (
            <SelectItem key={version.id} value={version.id}>
              {versionOptionLabel(version)}
              {version.is_current ? " (current)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

/** Parse the download filename from a `Content-Disposition` header, or fall back to a default. */
function reportFilename(headers: Headers, fallback: string): string {
  const disposition = headers.get("content-disposition") ?? "";
  const match = /filename="?([^"]+)"?/i.exec(disposition);
  return match?.[1] ?? fallback;
}

/**
 * Report-card export control (V2-MCP-33.1 / MCAT-19.1) — a small dropdown that downloads the
 * selected snapshot's shareable report as Markdown or HTML, or opens the HTML in a print window so
 * the browser can save it as PDF ("PDF via the same HTML / print stylesheet"). It proxies
 * `GET /api/mcp/endpoints/{id}/report?format=…&version_id=…`, which streams the rendered document.
 */
function ReportExportMenu({
  endpointId,
  versionId,
  disabled,
}: {
  endpointId: string;
  versionId: string | null;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeCatalogerNotes, setIncludeCatalogerNotes] = useState(false);
  const [open, setOpen] = useState(false);

  const reportUrl = useCallback(
    (format: "markdown" | "html") => {
      const query = new URLSearchParams({ format });
      if (versionId) query.set("version_id", versionId);
      if (includeCatalogerNotes) query.set("include_cataloger_notes", "true");
      return `/api/mcp/endpoints/${endpointId}/report?${query.toString()}`;
    },
    [endpointId, versionId, includeCatalogerNotes],
  );

  const closeMenu = useCallback(() => setOpen(false), []);

  /** Fetch one format's document, surfacing a normalized error on failure. */
  const fetchReport = useCallback(
    async (format: "markdown" | "html"): Promise<Response | null> => {
      const res = await fetch(reportUrl(format), { cache: "no-store" });
      if (!res.ok) {
        let detail = "Report export failed";
        try {
          const body = await res.json();
          if (typeof body?.error === "string") detail = body.error;
        } catch {
          // Non-JSON error body — keep the generic message.
        }
        setError(detail);
        return null;
      }
      return res;
    },
    [reportUrl],
  );

  const download = useCallback(
    async (format: "markdown" | "html") => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetchReport(format);
        if (!res) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = reportFilename(
          res.headers,
          `report-card.${format === "html" ? "html" : "md"}`,
        );
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        closeMenu();
      } catch {
        setError("Report export failed");
      } finally {
        setBusy(false);
      }
    },
    [fetchReport, closeMenu],
  );

  const printPdf = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchReport("html");
      if (!res) return;
      const html = await res.text();
      // Render the print-styled HTML in a fresh window and invoke the browser's print dialog, from
      // which the user saves a PDF. A blocked popup falls back to an explanatory error.
      const printWindow = window.open("", "_blank", "noopener,noreferrer");
      if (!printWindow) {
        setError("Allow pop-ups to print or save the report as PDF.");
        return;
      }
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
      closeMenu();
    } catch {
      setError("Report export failed");
    } finally {
      setBusy(false);
    }
  }, [fetchReport, closeMenu]);

  /** The three formats, so the menu's items are a list rather than three near-identical blocks. */
  const formats = [
    { key: "markdown", icon: FileText, label: "Download Markdown", run: () => void download("markdown") },
    { key: "html", icon: FileCode2, label: "Download HTML", run: () => void download("html") },
    { key: "print", icon: Printer, label: "Print / Save as PDF", run: () => void printPdf() },
  ] as const;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <Button type="button" variant="outline" data-testid="mcp-insight-export">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
          Export report
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="mcp-menu" sideOffset={4} align="end">
          {/* A *setting* the three items below read, not an action — so it is a checkbox item
              that keeps the menu open when it is toggled. */}
          <DropdownMenu.CheckboxItem
            className="mcp-menu__note"
            checked={includeCatalogerNotes}
            onCheckedChange={(checked) => setIncludeCatalogerNotes(checked === true)}
            onSelect={(event) => event.preventDefault()}
            disabled={busy}
          >
            <Checkbox checked={includeCatalogerNotes} tabIndex={-1} aria-hidden />
            <span>Include cataloger commentary (human notes, not from the server)</span>
          </DropdownMenu.CheckboxItem>
          {formats.map((format) => {
            const Glyph = format.icon;
            return (
              <DropdownMenu.Item
                key={format.key}
                className="mcp-menu__item"
                disabled={busy}
                onSelect={(event) => {
                  // The run is async and closes the menu itself on success, so the default
                  // close-on-select would tear the trigger's focus out from under it.
                  event.preventDefault();
                  format.run();
                }}
              >
                <Glyph aria-hidden />
                {format.label}
              </DropdownMenu.Item>
            );
          })}
          {error ? (
            <p className="mcp-menu__error" role="alert">
              {error}
            </p>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The live baseline the scaffold renders for the selected snapshot: total-capability headline and the
 * per-kind count tiles. This is the real 14.2 data proving the lazy fetch and version-selector
 * re-fetch work; the 15.x panels build richer views on the same source (documentation coverage now
 * lives in its own {@link DocCoveragePanel} below, so the baseline no longer duplicates those meters).
 * Handles its own loading / error / empty (zero-capability) states so a slow or missing surface never
 * blanks the whole tab.
 */
function SurfaceBaseline({
  surface,
  loading,
  error,
}: {
  surface: McpInsightSurface | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading && !surface) {
    return <LoadingState minHeightClassName="min-h-[9rem]" message="Loading insight…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="inline"
        tone="danger"
        icon={<BarChart3 aria-hidden />}
        title="Insight unavailable"
        description={error}
      />
    );
  }
  if (!surface) return null;

  const tiles = mcpTypeCountTiles(surface.metrics.type_counts);
  const total = surface.metrics.type_counts.total;

  return (
    <div className="flex flex-col gap-4" aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-muted">
          <span className="text-lg font-semibold tabular-nums text-fg">{total}</span>{" "}
          {total === 1 ? "capability" : "capabilities"} in this snapshot
        </span>
        {surface.is_current ? <Badge status="published">Current</Badge> : null}
      </div>

      {total === 0 ? (
        <EmptyState
          variant="inline"
          tone="neutral"
          icon={<Layers aria-hidden />}
          title="No capabilities"
          description="This snapshot declares no tools, resources, or prompts to summarize."
        />
      ) : (
        <StatGrid columns={4}>
          {tiles.map((tile) => (
            <Stat key={tile.key} label={tile.label} value={tile.value} />
          ))}
        </StatGrid>
      )}
    </div>
  );
}

/**
 * The MCP endpoint "Insight" tab (V2-MCP-28.4 / MCAT-14.4).
 *
 * The home for the server-profile, evolution, and reliability visualizations Epics 15–17 fill. This
 * scaffold lays out the responsive panel grid + section headers, a snapshot version selector, and a
 * live baseline of the 14.2 capability-surface metrics — with loading, empty, and error states —
 * proving the plumbing before the rich charts land. Because it is rendered inside a Radix tab that
 * unmounts when inactive, its data fetch is naturally lazy: nothing loads until the tab is opened.
 *
 * @param endpointId          The MCP endpoint whose insight to show.
 * @param currentVersionId    The endpoint's current snapshot id, used as the selector's default.
 * @param endpoint            The loaded endpoint record, for the profile-card header (optional).
 * @param currentInstructions The current version's server instructions, for the profile card.
 * @param onOpenVersionDiff   Deep-link a churn column to its diff in the Versions tab (optional).
 * @param onNavigateToItem    Deep-link a lint finding to its capability item (optional).
 */
export default function McpEndpointInsight({
  endpointId,
  currentVersionId,
  endpoint = null,
  currentInstructions = null,
  onOpenVersionDiff,
  onNavigateToItem,
}: Props) {
  const [versions, setVersions] = useState<McpVersionSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  /** The snapshot currently summarized; drives the surface fetch below. */
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  /** The active left-nav insight view. Defaults to the Overview; the version selector is independent. */
  const [activeView, setActiveView] = useState<string>("overview");
  const [surface, setSurface] = useState<McpInsightSurface | null>(null);
  const [surfaceLoading, setSurfaceLoading] = useState(false);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [graph, setGraph] = useState<McpCapabilityGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  /** The selected snapshot's capability items, for the safety panel's per-tool annotation matrix. */
  const [items, setItems] = useState<McpCapabilityItem[] | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  /** The endpoint's configured `auth_type` (endpoint-level, loaded once), for the safety cross-reference. */
  const [authType, setAuthType] = useState<string | null>(null);
  /** The endpoint's per-version evolution series (endpoint-level, loaded once), for the churn timeline. */
  const [evolution, setEvolution] = useState<McpEvolutionPoint[] | null>(null);
  const [evolutionLoading, setEvolutionLoading] = useState(true);
  const [evolutionError, setEvolutionError] = useState<string | null>(null);
  /**
   * Every snapshot's full surface (endpoint-level, loaded once after the version list), for the
   * presence matrix — it reconstructs each capability's lifespan from the per-version capability
   * items, which only the version-detail read carries.
   */
  const [matrixVersions, setMatrixVersions] = useState<McpVersionDetail[] | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(true);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  /** The caller's per-user "changed since last view" digest (endpoint-level, loaded once). */
  const [digest, setDigest] = useState<McpEndpointDigest | null>(null);
  const [digestLoading, setDigestLoading] = useState(true);
  const [digestError, setDigestError] = useState<string | null>(null);
  /** The endpoint's discovery health & availability timeline (endpoint-level, loaded once). */
  const [health, setHealth] = useState<McpDiscoveryHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);
  /**
   * The endpoint's per-tool latency & error-rate breakdown (MCAT-17.2), parsed from the *same*
   * reliability fetch as the discovery health above — it shares that fetch's loading / error state.
   */
  const [tools, setTools] = useState<McpToolReliability | null>(null);
  /**
   * The selected snapshot's lint report (MCAT-17.3), fetched per-snapshot from the same lint route the
   * Lint & Score tab uses, so the score-breakdown panel decomposes the grade of whichever version the
   * selector shows. Re-fetched on selector change like the surface / graph / items reads.
   */
  const [report, setReport] = useState<McpLintReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  /**
   * The endpoint's composite trust profile (MCAT-17.4) — five normalized axes synthesized
   * server-side from the quality / safety / documentation / stability / responsiveness signals.
   * Endpoint-level (not per-snapshot), loaded once; the capstone panel of the reliability section.
   */
  const [trust, setTrust] = useState<McpTrustProfile | null>(null);
  const [trustLoading, setTrustLoading] = useState(true);
  const [trustError, setTrustError] = useState<string | null>(null);
  /**
   * The endpoint's peer percentile & category ranking (MCAT-18.3) — where it stands against the
   * other live servers in its catalog category on grade / safety / documentation / latency.
   * Endpoint-level (not per-snapshot), loaded once alongside the trust profile.
   */
  const [peerPercentile, setPeerPercentile] = useState<McpPeerPercentileProfile | null>(null);
  const [peerLoading, setPeerLoading] = useState(true);
  const [peerError, setPeerError] = useState<string | null>(null);
  /** Guards the one-time seen-marker advance so it fires once per load, after the digest is read. */
  const viewRecordedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load the version list once (on first mount / tab open) to populate the selector, then default
  // the selection to the endpoint's current snapshot — or the newest one when there is no current.
  useEffect(() => {
    let active = true;
    setVersionsLoading(true);
    setVersionsError(null);
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
        const preferred =
          (currentVersionId && list.find((v) => v.id === currentVersionId)?.id) ||
          list[0]?.id ||
          null;
        setSelectedVersionId(preferred);
      } catch (e) {
        if (!active) return;
        setVersionsError(e instanceof Error ? e.message : "Could not load snapshots.");
        setVersions([]);
        setSelectedVersionId(null);
      } finally {
        if (active) setVersionsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpointId, currentVersionId]);

  // Fetch the capability-surface insight for the selected snapshot; re-runs whenever the selector
  // changes. The `version_id` query views any historical snapshot (current is implicit but we always
  // pass it so switching back to current re-fetches deterministically).
  const loadSurface = useCallback(
    async (versionId: string) => {
      setSurfaceLoading(true);
      setSurfaceError(null);
      try {
        const res = await fetch(
          `/api/mcp/endpoints/${endpointId}/insight/surface?version_id=${encodeURIComponent(versionId)}`,
          { credentials: "include", cache: "no-store" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        const parsed = mcpInsightSurfaceFromPayload(data);
        if (!mountedRef.current) return;
        if (!parsed) throw new Error("Malformed insight response.");
        setSurface(parsed);
      } catch (e) {
        if (!mountedRef.current) return;
        setSurface(null);
        setSurfaceError(e instanceof Error ? e.message : "Could not load insight.");
      } finally {
        if (mountedRef.current) setSurfaceLoading(false);
      }
    },
    [endpointId],
  );

  useEffect(() => {
    if (!selectedVersionId) {
      setSurface(null);
      setSurfaceError(null);
      return;
    }
    void loadSurface(selectedVersionId);
  }, [selectedVersionId, loadSurface]);

  // Fetch the capability relationship graph (MCAT-15.2) for the selected snapshot in parallel with the
  // surface metrics; the edge inference is done server-side and this only renders the result.
  const loadGraph = useCallback(
    async (versionId: string) => {
      setGraphLoading(true);
      setGraphError(null);
      try {
        const res = await fetch(
          `/api/mcp/endpoints/${endpointId}/insight/graph?version_id=${encodeURIComponent(versionId)}`,
          { credentials: "include", cache: "no-store" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        const parsed = mcpInsightGraphFromPayload(data);
        if (!mountedRef.current) return;
        if (!parsed) throw new Error("Malformed graph response.");
        setGraph(parsed.graph);
      } catch (e) {
        if (!mountedRef.current) return;
        setGraph(null);
        setGraphError(e instanceof Error ? e.message : "Could not load graph.");
      } finally {
        if (mountedRef.current) setGraphLoading(false);
      }
    },
    [endpointId],
  );

  useEffect(() => {
    if (!selectedVersionId) {
      setGraph(null);
      setGraphError(null);
      return;
    }
    void loadGraph(selectedVersionId);
  }, [selectedVersionId, loadGraph]);

  // Fetch the selected snapshot's full capability items (MCAT-15.4) — the safety panel needs the
  // per-tool `annotations` the surface metrics roll up but do not itemize. Re-runs on selector change.
  const loadItems = useCallback(
    async (versionId: string) => {
      setItemsLoading(true);
      setItemsError(null);
      try {
        const res = await fetch(
          `/api/mcp/endpoints/${endpointId}/versions/${encodeURIComponent(versionId)}`,
          { credentials: "include", cache: "no-store" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        const detail = mcpVersionDetailFromPayload(data);
        if (!mountedRef.current) return;
        if (!detail) throw new Error("Malformed version response.");
        setItems(detail.items);
      } catch (e) {
        if (!mountedRef.current) return;
        setItems(null);
        setItemsError(e instanceof Error ? e.message : "Could not load capabilities.");
      } finally {
        if (mountedRef.current) setItemsLoading(false);
      }
    },
    [endpointId],
  );

  useEffect(() => {
    if (!selectedVersionId) {
      setItems(null);
      setItemsError(null);
      return;
    }
    void loadItems(selectedVersionId);
  }, [selectedVersionId, loadItems]);

  // Fetch the selected snapshot's lint report (MCAT-17.3) for the score-breakdown panel. This is the
  // same read the Lint & Score tab uses; the panel reconstructs the grade's point breakdown from the
  // report's findings. Re-runs on selector change so switching snapshots re-scores the breakdown.
  const loadReport = useCallback(
    async (versionId: string) => {
      setReportLoading(true);
      setReportError(null);
      try {
        const res = await fetch(
          `/api/mcp/endpoints/${endpointId}/versions/${encodeURIComponent(versionId)}/lint`,
          { credentials: "include", cache: "no-store" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        const parsed = mcpLintReportFromPayload(data);
        if (!mountedRef.current) return;
        if (!parsed) throw new Error("Malformed lint report.");
        setReport(parsed);
      } catch (e) {
        if (!mountedRef.current) return;
        setReport(null);
        setReportError(e instanceof Error ? e.message : "Could not load the score breakdown.");
      } finally {
        if (mountedRef.current) setReportLoading(false);
      }
    },
    [endpointId],
  );

  useEffect(() => {
    if (!selectedVersionId) {
      setReport(null);
      setReportError(null);
      return;
    }
    void loadReport(selectedVersionId);
  }, [selectedVersionId, loadReport]);

  // Fetch the endpoint's redacted credential status once (auth is endpoint-level, not per-snapshot)
  // so the safety panel can flag destructive tools reachable with no auth. A failed/absent status
  // leaves `authType` null, which the panel treats as "auth unknown" (never a false no-auth alarm).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}/credentials`, {
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!active) return;
        const credential = (data && typeof data === "object" ? data.credential : null) as
          | { auth_type?: unknown }
          | null;
        const resolved =
          credential && typeof credential.auth_type === "string" ? credential.auth_type : null;
        setAuthType(res.ok ? resolved : null);
      } catch {
        if (active) setAuthType(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpointId]);

  // Fetch the whole per-version evolution series once (it is endpoint-level, not per-snapshot) for the
  // churn timeline. A never-discovered endpoint yields an empty series (a 200), which the panel renders
  // as its "no history yet" state rather than an error.
  useEffect(() => {
    let active = true;
    setEvolutionLoading(true);
    setEvolutionError(null);
    (async () => {
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}/insight/evolution`, {
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        if (!active) return;
        setEvolution(mcpEvolutionSeriesFromPayload(data));
      } catch (e) {
        if (!active) return;
        setEvolution(null);
        setEvolutionError(e instanceof Error ? e.message : "Could not load evolution history.");
      } finally {
        if (active) setEvolutionLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpointId]);

  // Load the caller's "changed since last view" digest once (endpoint-level), then advance their
  // seen-marker to the current version *after* the digest is read — so the digest reflects the
  // pre-advance "since your last visit" delta, and the next visit reads relative to this one. A
  // never-discovered endpoint yields a digest with no current version, so no marker is advanced.
  useEffect(() => {
    let active = true;
    setDigestLoading(true);
    setDigestError(null);
    viewRecordedRef.current = false;
    (async () => {
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}/insight/digest`, {
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        if (!active) return;
        const parsed = mcpDigestFromPayload(data);
        setDigest(parsed);
        // Advance the marker to the version the user is now seeing, once, after reading the digest.
        if (parsed?.current_version_id && !viewRecordedRef.current) {
          viewRecordedRef.current = true;
          void fetch(`/api/mcp/endpoints/${endpointId}/views`, {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version_id: parsed.current_version_id }),
          }).catch(() => {});
        }
      } catch (e) {
        if (!active) return;
        setDigest(null);
        setDigestError(e instanceof Error ? e.message : "Could not load the digest.");
      } finally {
        if (active) setDigestLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpointId]);

  // Fetch the endpoint's reliability aggregates once (endpoint-level, not per-snapshot) for the
  // reliability section — it feeds both the discovery health timeline (MCAT-17.1) and the per-tool
  // latency & error-rate panel (MCAT-17.2) from a single read. A never-discovered / never-tested
  // endpoint yields an empty timeline and empty tool list (a 200), which each panel renders as its
  // own "no data yet" state rather than an error.
  useEffect(() => {
    let active = true;
    setHealthLoading(true);
    setHealthError(null);
    (async () => {
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}/insight/reliability`, {
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        if (!active) return;
        setHealth(mcpReliabilityHealthFromPayload(data));
        setTools(mcpToolReliabilityFromPayload(data));
      } catch (e) {
        if (!active) return;
        setHealth(null);
        setTools(null);
        setHealthError(e instanceof Error ? e.message : "Could not load reliability.");
      } finally {
        if (active) setHealthLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpointId]);

  // Fetch the endpoint's composite trust profile once (endpoint-level; the server synthesizes all
  // five axes across the surface, evolution, and invocation history in a single read). A
  // never-discovered / never-measured endpoint yields an all-gap profile (a 200), which the panel
  // renders as its "not enough signal yet" empty state rather than an error.
  useEffect(() => {
    let active = true;
    setTrustLoading(true);
    setTrustError(null);
    (async () => {
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}/insight/trust`, {
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        if (!active) return;
        setTrust(mcpTrustProfileFromPayload(data));
      } catch (e) {
        if (!active) return;
        setTrust(null);
        setTrustError(e instanceof Error ? e.message : "Could not load the trust profile.");
      } finally {
        if (active) setTrustLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpointId]);

  // Fetch the endpoint's peer percentile & category ranking once (endpoint-level; the server ranks it
  // against its category cohort on grade / safety / documentation / latency in a single read). A
  // single-member category or an undiscovered endpoint yields a coherent profile (a 200), which the
  // panel renders as its "not enough peers yet" empty state rather than an error.
  useEffect(() => {
    let active = true;
    setPeerLoading(true);
    setPeerError(null);
    (async () => {
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}/insight/percentile`, {
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : res.statusText);
        }
        if (!active) return;
        setPeerPercentile(mcpPeerPercentileFromPayload(data));
      } catch (e) {
        if (!active) return;
        setPeerPercentile(null);
        setPeerError(e instanceof Error ? e.message : "Could not load the peer ranking.");
      } finally {
        if (active) setPeerLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpointId]);

  // Fetch every snapshot's full surface once the version list is known — the presence matrix
  // reconstructs each capability's lifespan from the per-version capability items, which the list
  // summary omits. The reads run in parallel; a snapshot whose detail fails to load is dropped so the
  // matrix still renders from the snapshots that did load rather than blanking on a single failure.
  useEffect(() => {
    if (versionsLoading) return;
    if (versions.length === 0) {
      setMatrixVersions([]);
      setMatrixLoading(false);
      setMatrixError(null);
      return;
    }
    let active = true;
    setMatrixLoading(true);
    setMatrixError(null);
    (async () => {
      try {
        const results = await Promise.all(
          versions.map(async (v) => {
            try {
              const res = await fetch(
                `/api/mcp/endpoints/${endpointId}/versions/${encodeURIComponent(v.id)}`,
                { credentials: "include", cache: "no-store" },
              );
              if (!res.ok) return null;
              const data = await res.json().catch(() => ({}));
              return mcpVersionDetailFromPayload(data);
            } catch {
              return null;
            }
          }),
        );
        if (!active) return;
        const details = results.filter((d): d is McpVersionDetail => d !== null);
        if (details.length === 0) {
          setMatrixVersions(null);
          setMatrixError("Could not load any version snapshots for the presence matrix.");
        } else {
          setMatrixVersions(details);
        }
      } catch (e) {
        if (!active) return;
        setMatrixVersions(null);
        setMatrixError(e instanceof Error ? e.message : "Could not load presence matrix.");
      } finally {
        if (active) setMatrixLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpointId, versions, versionsLoading]);

  const selectedVersion = useMemo(
    () => versions.find((v) => v.id === selectedVersionId) ?? null,
    [versions, selectedVersionId],
  );

  // Assemble the at-a-glance server profile (MCAT-15.1) for the selected snapshot. Instructions are
  // snapshot-specific and the version summary omits them, so we only surface the threaded current
  // instructions while the current snapshot is selected.
  const profile = useMemo(
    () =>
      mcpServerProfileFrom({
        endpoint,
        version: selectedVersion,
        surface,
        instructions: selectedVersion?.is_current ? currentInstructions : null,
      }),
    [endpoint, selectedVersion, surface, currentInstructions],
  );

  if (versionsLoading) {
    return <LoadingState minHeightClassName="min-h-[14rem]" message="Loading insight…" />;
  }

  // Never-discovered (or unreadable) endpoint: there is no snapshot to summarize — a helpful empty
  // state, not a broken grid.
  if (versionsError || versions.length === 0) {
    return (
      <EmptyState
        icon={<BarChart3 aria-hidden />}
        tone={versionsError ? 'danger' : 'neutral'}
        title="No insight yet"
        description={
          versionsError ??
          "This endpoint has never been discovered, so there is no capability surface to visualize. Run discovery to populate its insight."
        }
        data-testid="mcp-insight-empty"
      />
    );
  }

  // Every insight view, in nav order. Each is a left-nav entry plus the panel it reveals; only the
  // active view's node is mounted (Radix unmounts inactive tabs), so the tab shows one panel at a time
  // instead of the whole ~18k-px stack. The data still loads eagerly in the effects above — the panels
  // are pure given their props — so switching views is instant and never re-fetches.
  const views: InsightView[] = [
    {
      key: "overview",
      group: "summary",
      label: "Overview",
      icon: BarChart3,
      node: (
        <div className="space-y-6">
          {/* At-a-glance server identity (MCAT-15.1). Its trust teaser switches to the trust view. */}
          <ServerProfileCard
            profile={profile}
            onNavigateTrust={() => setActiveView("trust")}
          />
          {/* "Changed since last view" digest (MCAT-16.5) — a per-user welcome-back summary. Loaded
              endpoint-level; reading it advances the user's seen-marker (once) so the next visit
              reads relative to the version they are seeing now. */}
          <InsightPanel
            icon={History}
            title="Changed since your last view"
            description="What changed on this server's surface since you last looked — and how breaking it is."
          >
            <ChangedSinceDigestPanel
              digest={digest}
              loading={digestLoading}
              error={digestError}
              onReviewChanges={(versionId) => onOpenVersionDiff?.(versionId)}
            />
          </InsightPanel>
          {/* Trust-drift alerts (CLX-3.4, #4858) — how the current snapshot differs from the approved
              baseline, each change classified normal / quality / security / coverage-loss. */}
          <InsightPanel
            icon={ShieldAlert}
            title="Trust drift from your approved baseline"
            description="Every material surface or source change since you approved this server's baseline, classified as a normal change, a quality regression, a security regression, or coverage loss."
          >
            <TrustDriftAlertsPanel endpointId={endpointId} />
          </InsightPanel>
        </div>
      ),
    },
    {
      key: "counts",
      group: "surface",
      label: "Capability counts",
      icon: Layers,
      node: (
        <InsightPanel
          icon={Layers}
          title="Capability counts"
          description="What this snapshot exposes — total capabilities and their per-kind breakdown."
        >
          <SurfaceBaseline surface={surface} loading={surfaceLoading} error={surfaceError} />
        </InsightPanel>
      ),
    },
    {
      key: "graph",
      group: "surface",
      label: "Relationship graph",
      icon: Share2,
      // Capability relationship graph (MCAT-15.2).
      node: (
        <InsightPanel
          icon={Share2}
          title="Capability relationship graph"
          description="How tools, resources, and prompts relate — edges inferred from concrete signals."
        >
          <CapabilityGraphPanel graph={graph} loading={graphLoading} error={graphError} />
        </InsightPanel>
      ),
    },
    {
      key: "complexity",
      group: "surface",
      label: "Schema complexity",
      icon: ListTree,
      // Tool schema shape & complexity (MCAT-15.3). Reads the same surface fetch as the counts view;
      // as its own view it now surfaces the surface error itself rather than hiding to avoid a dup.
      node: (
        <InsightPanel
          icon={ListTree}
          title="Tool schema shape & complexity"
          description="How hard each tool is to call — parameters, required/optional split, nesting, and schema features — with a distribution across the server's tools."
        >
          <ToolComplexityPanel
            tools={surface ? surface.metrics.tool_complexity : null}
            loading={surfaceLoading}
            error={surfaceError}
          />
        </InsightPanel>
      ),
    },
    {
      key: "safety",
      group: "surface",
      label: "Safety posture",
      icon: ShieldAlert,
      // Safety & annotation posture (MCAT-15.4).
      node: (
        <InsightPanel
          icon={ShieldAlert}
          title="Safety & annotation posture"
          description="Read-only vs destructive tools from their behavioural hints, cross-referenced with whether the endpoint requires auth."
        >
          <SafetyPosturePanel
            items={items}
            authType={authType}
            loading={itemsLoading}
            error={itemsError}
          />
        </InsightPanel>
      ),
    },
    {
      key: "docs",
      group: "surface",
      label: "Documentation",
      icon: BookOpen,
      // Documentation & schema coverage (MCAT-15.5).
      node: (
        <InsightPanel
          icon={BookOpen}
          title="Documentation & schema coverage"
          description="How well this snapshot is documented — descriptions, titles, parameter docs, and output-schema adoption — each meter linking to the items that fall short."
        >
          <DocCoveragePanel items={items} loading={itemsLoading} error={itemsError} />
        </InsightPanel>
      ),
    },
    {
      key: "churn",
      group: "evolution",
      label: "Churn timeline",
      icon: GitCompareArrows,
      // Capability churn timeline (MCAT-16.1). Each column deep-links to that snapshot's diff.
      node: (
        <InsightPanel
          icon={GitCompareArrows}
          title="Capability churn timeline"
          description="How much the surface changed per snapshot — added, removed, and modified capabilities over time, each column linking to that release's diff."
        >
          <CapabilityChurnPanel
            series={evolution}
            loading={evolutionLoading}
            error={evolutionError}
            onSelectVersion={(versionId) => onOpenVersionDiff?.(versionId)}
          />
        </InsightPanel>
      ),
    },
    {
      key: "presence",
      group: "evolution",
      label: "Lifespan & presence",
      icon: LayoutGrid,
      // Capability lifespan / presence matrix (MCAT-16.2).
      node: (
        <InsightPanel
          icon={LayoutGrid}
          title="Capability lifespan & presence"
          description="When each capability existed across snapshots — a presence matrix revealing volatile vs long-lived tools, resources, and prompts."
        >
          <CapabilityPresenceMatrixPanel
            versions={matrixVersions}
            loading={matrixLoading}
            error={matrixError}
            onSelectVersion={(versionId) => onOpenVersionDiff?.(versionId)}
          />
        </InsightPanel>
      ),
    },
    {
      key: "trend",
      group: "evolution",
      label: "Grade & size trend",
      icon: LineChart,
      // Grade & surface-size trend (MCAT-16.4), with breaking-change markers (MCAT-16.3) overlaid.
      node: (
        <InsightPanel
          icon={LineChart}
          title="Grade & surface-size trend"
          description="Whether the server is improving — its quality score and capability count over snapshots, with breaking-change releases marked. Unscored snapshots are gapped, not zeroed."
        >
          <GradeSurfaceTrendPanel
            series={evolution}
            loading={evolutionLoading}
            error={evolutionError}
            onSelectVersion={(versionId) => onOpenVersionDiff?.(versionId)}
          />
        </InsightPanel>
      ),
    },
    {
      key: "health",
      group: "reliability",
      label: "Discovery health",
      icon: Activity,
      // Discovery health & availability timeline (MCAT-17.1).
      node: (
        <InsightPanel
          icon={Activity}
          title="Discovery health & availability"
          description="Whether the server has been reachable over time — each recent discovery attempt's outcome, an availability percentage, and whether it is currently quarantined after repeated failures."
        >
          <DiscoveryHealthPanel health={health} loading={healthLoading} error={healthError} />
        </InsightPanel>
      ),
    },
    {
      key: "latency",
      group: "reliability",
      label: "Tool latency",
      icon: Timer,
      // Tool latency & error-rate panel (MCAT-17.2). Same insight/reliability read as the health view.
      node: (
        <InsightPanel
          icon={Timer}
          title="Tool latency & error rate"
          description="How fast and how reliable each tool is when called — p50/p95/p99 latency and error ratio per tool, a latency distribution, and the slowest and flakiest tools."
        >
          <ToolLatencyPanel reliability={tools} loading={healthLoading} error={healthError} />
        </InsightPanel>
      ),
    },
    {
      key: "score",
      group: "reliability",
      label: "Score breakdown",
      icon: Gauge,
      // Score & lint breakdown (MCAT-17.3). Same per-version lint report the Lint & Score tab uses.
      node: (
        <InsightPanel
          icon={Gauge}
          title="Score & lint breakdown"
          description="Where this snapshot's quality grade comes from — the points each rule group (naming, structure, annotations, security, hygiene) deducted and the findings behind them, each linking to the capability it flags."
        >
          <ScoreBreakdownPanel
            report={report}
            loading={reportLoading}
            error={reportError}
            onNavigateToItem={onNavigateToItem}
          />
        </InsightPanel>
      ),
    },
    {
      key: "trust",
      group: "reliability",
      label: "Trust profile",
      icon: ShieldCheck,
      // Composite trust profile radar (MCAT-17.4) — the capstone of the single-server view.
      node: (
        <InsightPanel
          icon={ShieldCheck}
          title="Composite trust profile"
          description="A synthesized trust glance across five normalized axes — quality, safety, documentation, stability, and responsiveness — each with its methodology on hover. A heuristic composite, not an official rating; unmeasured axes show as gaps, never zeros."
        >
          <TrustProfilePanel profile={trust} loading={trustLoading} error={trustError} />
        </InsightPanel>
      ),
    },
    {
      key: "peers",
      group: "reliability",
      label: "Peer ranking",
      icon: Trophy,
      // Peer percentile & category ranking (MCAT-18.3) — a peer baseline, not an absolute grade.
      node: (
        <InsightPanel
          icon={Trophy}
          title="Peer ranking in category"
          description="Where this server stands against its category peers — a “top 10% for documentation”-style baseline across grade, safety, documentation, and latency, not an absolute grade. Unmeasured axes are shown as gaps."
        >
          <PeerPercentilePanel
            profile={peerPercentile}
            loading={peerLoading}
            error={peerError}
          />
        </InsightPanel>
      ),
    },
  ];

  return (
    <TabsPrimitive.Root
      value={activeView}
      onValueChange={setActiveView}
      orientation="vertical"
      className="mcp-insight"
      data-testid="mcp-insight"
    >
      <div className="mcp-insight__head">
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          {surfaceLoading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <BarChart3 className="size-4" aria-hidden />
          )}
          <span>
            Insight for{" "}
            <span className="font-medium text-fg">
              {selectedVersion ? mcpVersionSeqLabel(selectedVersion.version_seq) : "—"}
            </span>
          </span>
          {selectedVersion?.is_current ? <Badge status="published">Current</Badge> : null}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <VersionSelector
            versions={versions}
            value={selectedVersionId}
            disabled={surfaceLoading}
            onChange={setSelectedVersionId}
          />
          <ReportExportMenu
            endpointId={endpointId}
            versionId={selectedVersionId}
            disabled={surfaceLoading}
          />
        </div>
      </div>

      {/* The rail of fourteen views: a column on a wide viewport, a scrolling strip on a narrow
          one. It sticks, so a reader three screens down a churn timeline can still reach Peer
          ranking without scrolling back. */}
      <TabsPrimitive.List aria-label="Insight views" className="mcp-insight__rail">
        {INSIGHT_GROUPS.map((group) => {
          const groupViews = views.filter((view) => view.group === group.key);
          if (groupViews.length === 0) return null;
          return (
            <div key={group.key} className="mcp-insight__group">
              {group.label ? (
                <p className="mcp-insight__group-label">{group.label}</p>
              ) : null}
              {groupViews.map((view) => {
                const Icon = view.icon;
                return (
                  <TabsPrimitive.Trigger
                    key={view.key}
                    value={view.key}
                    data-testid={`mcp-insight-view-${view.key}`}
                    className={tabRailTriggerRadixClass()}
                  >
                    <Icon className="mcp-insight__glyph" aria-hidden />
                    {view.label}
                  </TabsPrimitive.Trigger>
                );
              })}
            </div>
          );
        })}
      </TabsPrimitive.List>

      <div className="mcp-insight__panel">
        {views.map((view) => (
          <TabsPrimitive.Content
            key={view.key}
            value={view.key}
            className="focus-visible:outline-none"
          >
            {view.node}
          </TabsPrimitive.Content>
        ))}
      </div>
    </TabsPrimitive.Root>
  );
}
