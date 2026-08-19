'use client';

/**
 * Bring in → MCP servers → one endpoint (HIVE-7.8, #5325).
 *
 * Authority: `docs/mockups/sources/mcp-endpoint.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header), §7 (one primary action, tabs are
 * underlines) and §3.1 (status vocabulary).
 *
 * ### What this screen is
 *
 * Everything the catalog knows about one MCP server: the capability surface its latest discovery
 * found, fourteen views onto that surface, the history of how it got there, its lint score, its
 * settings, and — proposed rather than shipped — its OWASP trust posture.
 *
 * Three things were true of it before this redesign and are still true:
 *
 *  * **The header's three actions are mutually exclusive.** Re-discover, Enable/Disable and
 *    Publish/Unpublish all disable while any one of them is in flight, because two of the three
 *    write the same record and the third replaces the version the first two describe.
 *  * **Publishing writes two fields.** `published` *and* `visibility: 'public'` go together —
 *    the public catalog requires both (MCAT-9.6) — which is why the toggle goes through
 *    `mcpPublishTogglePatch` rather than sending the flag it is named after.
 *  * **A deep link switches a tab and then scrolls.** A lint finding names a capability; the
 *    Insight tab's churn timeline names a version. Both are handled here, because the tab they
 *    are switching *to* is this component's state.
 *
 * ### What the redesign changed
 *
 * 1. **The screen drew its own header and its own `<main>`.** A `border-b border-gray-200
 *    bg-white` bar with a back link, an `h2`, an indigo `Server` glyph and a three-button
 *    cluster, over a `dashboardMainClass` landmark the shell already draws. It is `Page` +
 *    `PageHeader` + `PageBody`: a real breadcrumb instead of the back link, one `h1`, the grade
 *    beside it, the meta row in the header's own `meta` slot, and one primary action.
 * 2. **The four summary tiles were four `dashboardPanelPaddedClass` divs.** They are `StatGrid`
 *    + `Stat` (HIVE-2.6), which is the same object the mockup draws — hairline-separated cells,
 *    a caps label with a glyph, a tabular figure and a footnote — and which the Largest font
 *    scale grows rather than clips.
 * 3. **The tab strip was `ui/mcp/DetailTabs`**, a Radix `Tabs.Root` *inside* the body. The
 *    mockup puts the strip in the page header, which a Root cannot span (see
 *    {@link McpEndpointTabList}); the strip is hand-built on the shared tab classes and the
 *    panels are `role="tabpanel"` regions in the body.
 * 4. **The trust-posture panel existed and was mounted nowhere.** `McpTrustPosturePanel`
 *    (CLX-3.2, #4856) has had a component, an API and a test suite since #4856 and no route.
 *    It is the sixth tab now, marked **Proposed** in honey, so the gap is on the screen rather
 *    than in a roadmap.
 * 5. **Loading was a spinner in a box.** DESIGN.md §8 asks for skeletons shaped like the
 *    content: the summary strip and the first panel are drawn as skeletons while the endpoint
 *    read is in flight.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Award,
  Clock,
  FileCode2,
  FileText,
  GitCommitHorizontal,
  Globe,
  Loader2,
  Lock,
  MessageSquareText,
  Pause,
  Play,
  Radar,
  Server,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { Stat, StatGrid } from '@/app/components/ui/metrics';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { McpBadge } from '@/app/components/ui/mcp/McpBadge';
import { McpDisclosure } from '@/app/components/ui/mcp/McpDisclosure';
import { McpJsonViewer } from '@/app/components/ui/mcp/McpJsonViewer';
import { GradeGlyph } from '@/app/components/ui/mcp/GradeGlyph';
import { HealthPill } from '@/app/components/ui/mcp/HealthPill';
import { RecencyPill } from '@/app/components/ui/mcp/RecencyPill';

import McpVersionHistory from './McpVersionHistory';
import McpEndpointInsight from './McpEndpointInsight';
import McpLintReport from './McpLintReport';
import McpEndpointSettings from './McpEndpointSettings';
import { McpEndpointNotesPanel } from '@/app/components/ade/dashboard/mcp/McpEndpointNotesPanel';
import { McpTrustPosturePanel } from '@/app/components/ade/dashboard/mcp/McpTrustPosturePanel';
import {
  MCP_ENDPOINT_DEFAULT_TAB,
  McpEndpointTabList,
  McpEndpointTabPanel,
} from '@/app/components/ade/dashboard/mcp/McpEndpointTabs';
import {
  formatTeardownSummary,
  type McpTeardownSummary,
} from '@/app/components/ade/dashboard/mcp/mcpSettingsForm';
import {
  mcpCapabilityAnchorId,
  mcpLintReportFromPayload,
  mcpLintTierCounts,
  type McpLintReport as McpLintReportData,
} from '@/app/components/ade/dashboard/mcp/mcpLintUi';
import {
  mcpCapabilityAnnotationBadge,
  mcpLifecycleBadge,
  mcpTransportBadge,
  mcpVisibilityBadge,
} from '@/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import {
  discoveryFailureMessage,
  isJobSuccess,
  isTerminalJobState,
  type McpDiscoveryJob,
} from '@/app/components/ade/dashboard/mcp/mcpImportFlow';
import {
  mcpAnnotationHints,
  mcpEndpointDetailFromPayload,
  mcpPublishTogglePatch,
  mcpGroupItemsByType,
  mcpItemDetailSections,
  mcpVersionDetailFromPayload,
  type McpCapabilityItem,
  type McpEndpointDetail,
  type McpVersionDetail,
} from '@/app/components/ade/dashboard/mcp/mcpBrowseUi';

interface Props {
  endpointId: string;
}

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/** Where the second-to-last crumb goes, and where a delete returns to. */
const CATALOG_ROUTE = '/ade/dashboard/mcp';

/** Cap on discovery polling so a stuck job can never spin forever (≈ 60s at 1.5s/poll). */
const DISCOVERY_POLL_INTERVAL_MS = 1500;
const DISCOVERY_MAX_POLLS = 40;

/** How long a followed deep-link keeps its accent ring before it retires itself. */
const HIGHLIGHT_MS = 2500;

/** How many skeleton rows the capability list draws while the endpoint read is in flight. */
const SKELETON_ROWS = 3;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The glyph each capability kind leads with, so a section is recognisable before it is read. */
const KIND_GLYPH: Readonly<Record<string, typeof Wrench>> = {
  tool: Wrench,
  resource: FileText,
  resource_template: FileCode2,
  prompt: MessageSquareText,
};

/**
 * One collapsible JSON detail (input/output schema or annotations) under a capability item. The
 * Monaco viewer is heavyweight, so the disclosure mounts it only after the first expand.
 *
 * @param props.label What the section holds, e.g. `Input schema`.
 * @param props.json  The pretty-printed document.
 * @returns The disclosure.
 */
function CapabilityDetailSection({ label, json }: { label: string; json: string }) {
  const lineCount = json ? json.split('\n').length : 1;
  return (
    <McpDisclosure label={label} meta={`${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}>
      <McpJsonViewer value={json} className="rounded-none border-0" />
    </McpDisclosure>
  );
}

/**
 * One capability: its name and behavioural badges, its identifier, its description, and the
 * schemas it declares.
 *
 * @param props.groupKey    The capability kind, for the detail sections' React keys.
 * @param props.item        The capability.
 * @param props.anchorId    Stable DOM id, so a lint finding can deep-link to this item.
 * @param props.highlighted True while this item is the target of a just-followed deep-link.
 * @returns The item's row.
 */
function CapabilityItemCard({
  groupKey,
  item,
  anchorId,
  highlighted,
}: {
  groupKey: string;
  item: McpCapabilityItem;
  anchorId: string;
  highlighted: boolean;
}) {
  const hints = mcpAnnotationHints(item);
  const sections = mcpItemDetailSections(item);
  // Lifecycle badge (34.4): only a detected stage renders a chip — "unspecified" shows nothing,
  // because a server that says nothing has made no stability statement.
  const lifecycleBadge = mcpLifecycleBadge(item.lifecycle?.stage);
  const lifecycleTitle = (item.lifecycle?.signals ?? [])
    .map((signal) => `${signal.source}: ${signal.matched}`)
    .join('; ');
  return (
    <article
      id={anchorId}
      // The ring is emphasis; `aria-current` is the fact, so a reader who cannot see the accent
      // hairline still learns that this is the item they followed a link to.
      aria-current={highlighted ? 'location' : undefined}
      data-highlighted={highlighted ? '' : undefined}
      data-testid={`mcp-capability-${item.item_type}-${item.name}`}
      className="mcp-cap-item"
    >
      <div className="mcp-cap-item__head">
        <span className="mcp-cap-item__name">{item.title ?? item.name}</span>
        {lifecycleBadge ? (
          <McpBadge
            tone={lifecycleBadge.tone}
            title={lifecycleTitle || `lifecycle: ${lifecycleBadge.label}`}
          >
            {lifecycleBadge.label}
          </McpBadge>
        ) : null}
        {/* Only the hints the server set to *true* are asserted, as tone-coded chips: readOnly
            green / idempotent blue / destructive red / openWorld amber. */}
        {hints.map((hint) => {
          const badge = mcpCapabilityAnnotationBadge(hint.key, hint.value);
          if (!badge) return null;
          return (
            <McpBadge key={hint.key} tone={badge.tone} title={`${hint.label}: ${hint.value}`}>
              {badge.label}
            </McpBadge>
          );
        })}
      </div>
      <div className="mcp-cap-item__id mono">
        {item.uri ?? item.uri_template ?? item.name}
      </div>
      {item.description ? <p className="mcp-cap-item__desc">{item.description}</p> : null}
      {sections.length > 0 ? (
        <div className="mcp-cap-item__detail">
          {sections.map((section) => (
            <CapabilityDetailSection
              key={`${groupKey}:${item.name}:${section.key}`}
              label={section.label}
              json={section.json}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

/**
 * One capability kind as a card: a titled header with its count, and its items as hairline-
 * separated rows.
 *
 * @param props.group        The kind and its items.
 * @param props.highlighted  The anchor id currently wearing the deep-link ring, if any.
 * @returns The section card.
 */
function CapabilitySection({
  group,
  highlighted,
}: {
  group: { key: string; label: string; items: McpCapabilityItem[] };
  highlighted: string | null;
}) {
  const Glyph = KIND_GLYPH[group.key] ?? Wrench;
  return (
    <Card data-testid={`mcp-capability-group-${group.key}`}>
      <CardHeader className="flex-row items-center gap-2">
        <Glyph aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
        <CardTitle>{group.label}</CardTitle>
        <Badge variant="neutral">{group.items.length}</Badge>
      </CardHeader>
      <div className="mcp-cap-list">
        {group.items.map((item) => {
          const anchorId = mcpCapabilityAnchorId(item.item_type, item.name);
          return (
            <CapabilityItemCard
              key={`${group.key}:${item.name}`}
              groupKey={group.key}
              item={item}
              anchorId={anchorId}
              highlighted={highlighted === anchorId}
            />
          );
        })}
      </div>
    </Card>
  );
}

/** The summary strip and one panel, drawn as skeletons while the endpoint read is in flight. */
function DetailSkeleton() {
  return (
    <div className="mcp-ep-panel" aria-busy data-testid="mcp-endpoint-skeleton">
      <StatGrid columns={4}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="hive-stat">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-7 w-16" />
          </div>
        ))}
      </StatGrid>
      <Card>
        <CardBody className="flex flex-col gap-3">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </CardBody>
      </Card>
      <p className="sr-only" role="status">
        Loading endpoint…
      </p>
    </div>
  );
}

export default function McpEndpointDetailClient({ endpointId }: Props) {
  const router = useRouter();
  const [endpoint, setEndpoint] = React.useState<McpEndpointDetail | null>(null);
  const [version, setVersion] = React.useState<McpVersionDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  /** Which control is mid-flight ("discover" | "enabled" | "published"), or null when idle. */
  const [busy, setBusy] = React.useState<string | null>(null);
  /** Current version's lint report (drives the summary tile *and* the Lint & score tab). */
  const [lintReport, setLintReport] = React.useState<McpLintReportData | null>(null);
  const [lintLoading, setLintLoading] = React.useState(false);
  const [lintError, setLintError] = React.useState<string | null>(null);
  /** Controlled tab, so a lint finding can switch to "capabilities" and scroll to its item. */
  const [activeTab, setActiveTab] = React.useState(MCP_ENDPOINT_DEFAULT_TAB);
  /** Anchor a pending deep-link wants to scroll to once the Capabilities tab has mounted. */
  const [pendingAnchor, setPendingAnchor] = React.useState<string | null>(null);
  /** A churn-timeline deep-link: the version whose diff the Versions tab should open. */
  const [pendingDiffVersionId, setPendingDiffVersionId] = React.useState<string | null>(null);
  /** The item currently wearing the deep-link ring (cleared after a short delay). */
  const [highlightedAnchor, setHighlightedAnchor] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Fetch the lint report for a version; best-effort (a failure shows in the tab). */
  const loadLint = React.useCallback(
    async (versionId: string) => {
      setLintLoading(true);
      setLintError(null);
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}/versions/${versionId}/lint`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
        }
        if (!mountedRef.current) return;
        setLintReport(mcpLintReportFromPayload(data));
      } catch (e) {
        if (!mountedRef.current) return;
        setLintReport(null);
        setLintError(e instanceof Error ? e.message : 'Could not load lint report.');
      } finally {
        if (mountedRef.current) setLintLoading(false);
      }
    },
    [endpointId],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const epRes = await fetch(`/api/mcp/endpoints/${endpointId}`, { credentials: 'include' });
      const epData = await epRes.json().catch(() => ({}));
      if (!epRes.ok) {
        throw new Error(typeof epData.error === 'string' ? epData.error : epRes.statusText);
      }
      const ep = mcpEndpointDetailFromPayload(epData);
      if (!mountedRef.current) return;
      setEndpoint(ep);

      if (ep?.current_version_id) {
        const vRes = await fetch(
          `/api/mcp/endpoints/${endpointId}/versions/${ep.current_version_id}`,
          { credentials: 'include' },
        );
        const vData = await vRes.json().catch(() => ({}));
        if (!mountedRef.current) return;
        setVersion(vRes.ok ? mcpVersionDetailFromPayload(vData) : null);
        await loadLint(ep.current_version_id);
      } else {
        setVersion(null);
        setLintReport(null);
        setLintError(null);
      }
    } catch (e) {
      console.error(e);
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : 'Could not load endpoint.');
      setEndpoint(null);
      setVersion(null);
      setLintReport(null);
      setLintError(null);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [endpointId, loadLint]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * PATCH one or more mutable fields (enable/disable or publish/unpublish) and reflect the
   * returned record. `busyKey` drives the per-button spinner; `fields` is the patch body —
   * publishing sends `published` *and* `visibility` together so the endpoint actually becomes
   * publicly discoverable (the public catalog view requires both, MCAT-9.6).
   */
  const patchToggle = React.useCallback(
    async (busyKey: 'enabled' | 'published', fields: Record<string, unknown>, verb: string) => {
      setBusy(busyKey);
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
        }
        const updated = mcpEndpointDetailFromPayload(data);
        if (!mountedRef.current) return;
        if (updated) setEndpoint(updated);
        toast.success(`Endpoint ${verb}.`);
      } catch (e) {
        if (mountedRef.current) {
          toast.error(e instanceof Error ? e.message : `Could not ${verb}.`);
        }
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [endpointId],
  );

  /** Kick off a fresh discovery run and poll it to completion, then reload the surface. */
  const rediscover = React.useCallback(async () => {
    setBusy('discover');
    try {
      const res = await fetch(`/api/mcp/endpoints/${endpointId}/discover`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      let job = (data.job ?? null) as McpDiscoveryJob | null;
      const jobId = job?.id;
      if (!jobId) throw new Error('Discovery did not start.');

      for (
        let attempt = 0;
        job && !isTerminalJobState(job.state) && attempt < DISCOVERY_MAX_POLLS;
        attempt += 1
      ) {
        await delay(DISCOVERY_POLL_INTERVAL_MS);
        if (!mountedRef.current) return;
        const jr = await fetch(`/api/mcp/endpoints/${endpointId}/discover/${jobId}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const jd = await jr.json().catch(() => ({}));
        if (!jr.ok) {
          throw new Error(typeof jd.error === 'string' ? jd.error : jr.statusText);
        }
        job = (jd.job ?? null) as McpDiscoveryJob | null;
      }

      if (isJobSuccess(job)) {
        if (mountedRef.current) toast.success('Discovery complete.');
        await load();
      } else if (job && !isTerminalJobState(job.state)) {
        throw new Error('Discovery is still running — check back shortly.');
      } else {
        throw new Error(discoveryFailureMessage(job));
      }
    } catch (e) {
      if (mountedRef.current) {
        toast.error(e instanceof Error ? e.message : 'Discovery failed.');
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [endpointId, load]);

  /** Reflect a Settings-tab identity edit or enable/disable toggle in the header & summary. */
  const handleSettingsSaved = React.useCallback((updated: McpEndpointDetail) => {
    setEndpoint(updated);
  }, []);

  /** After a Settings-tab delete, surface the teardown summary and return to the catalog. */
  const handleSettingsDeleted = React.useCallback(
    (summary: McpTeardownSummary) => {
      toast.success(`Endpoint deleted. ${formatTeardownSummary(summary)}`);
      router.push(CATALOG_ROUTE);
    },
    [router],
  );

  /** Follow a lint finding to its capability: switch to Capabilities and scroll to the item. */
  const navigateToItem = React.useCallback((itemType: string, name: string) => {
    setPendingAnchor(mcpCapabilityAnchorId(itemType, name));
    setActiveTab('capabilities');
  }, []);

  /**
   * Follow a churn-timeline column (Insight tab) to its diff: record the requested version and
   * switch to the Versions tab, which opens that snapshot against its predecessor (MCAT-16.1 →
   * MCAT-10.3). The Versions tab clears the request once applied.
   */
  const openVersionDiff = React.useCallback((versionId: string) => {
    setPendingDiffVersionId(versionId);
    setActiveTab('versions');
  }, []);

  const clearPendingDiff = React.useCallback(() => setPendingDiffVersionId(null), []);

  // Once the Capabilities tab is active and its content has mounted, scroll the pending target
  // into view and highlight it. Runs after commit, so the anchor element exists.
  React.useEffect(() => {
    if (activeTab !== 'capabilities' || !pendingAnchor) return;
    const el = document.getElementById(pendingAnchor);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedAnchor(pendingAnchor);
    }
    setPendingAnchor(null);
  }, [activeTab, pendingAnchor]);

  // Clear the deep-link highlight after a short, self-cancelling delay.
  React.useEffect(() => {
    if (!highlightedAnchor) return undefined;
    const timer = setTimeout(() => setHighlightedAnchor(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightedAnchor]);

  const itemGroups = version ? mcpGroupItemsByType(version.items) : [];
  const capabilityCount = version ? version.items.length : null;
  const discovering = busy === 'discover';
  const lintCounts = lintReport ? mcpLintTierCounts(lintReport.findings) : null;
  const transport = endpoint ? mcpTransportBadge(endpoint.transport) : null;
  const visibility = endpoint ? mcpVisibilityBadge(endpoint.visibility) : null;
  // The mockup's tile prints the *sequence* as the figure and the release tag under it —
  // "v5" is what a reader compares snapshots by, and the tag is how the server names it.
  const versionLabel = version ? `v${version.version_seq}` : '—';
  /** The graded score, or `null` when the current snapshot has not been scored. */
  const gradeScore = typeof lintReport?.score === 'number' ? lintReport.score : null;
  const serverLabel = version?.server_title ?? version?.server_name ?? '—';

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: 'MCP servers', href: CATALOG_ROUTE },
          { label: endpoint?.name ?? 'Endpoint' },
        ]}
        leading={
          endpoint ? (
            <Avatar name={endpoint.name} seed={endpoint.id} size="lg" shape="hex" />
          ) : undefined
        }
        title={endpoint?.name ?? 'MCP endpoint'}
        truncateTitle
        badge={
          lintReport ? (
            <GradeGlyph grade={lintReport.grade} score={lintReport.score} size="sm" />
          ) : null
        }
        meta={
          endpoint ? (
            <>
              <span className="mcp-ep-meta__url mono">{endpoint.endpoint_url}</span>
              {transport ? <McpBadge tone={transport.tone}>{transport.label}</McpBadge> : null}
              {visibility ? <McpBadge tone={visibility.tone}>{visibility.label}</McpBadge> : null}
              <RecencyPill timestamp={endpoint.last_discovered_at} />
              <Badge status={endpoint.enabled ? 'active' : 'disabled'} dot>
                {endpoint.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
              <Badge status={endpoint.published ? 'published' : 'draft'}>
                {endpoint.published ? 'Published' : 'Unpublished'}
              </Badge>
            </>
          ) : undefined
        }
        actions={
          endpoint ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void patchToggle(
                    'published',
                    // Publish sets `published` AND `visibility: 'public'` together (the public
                    // catalog requires both); unpublish reverts to private.
                    mcpPublishTogglePatch(endpoint.published),
                    endpoint.published ? 'unpublished' : 'published',
                  )
                }
                disabled={busy !== null}
                title={
                  endpoint.published
                    ? 'Remove this endpoint from the public catalog (make it private)'
                    : "Publish this endpoint to the public catalog so it's listed in the browser"
                }
                data-testid="mcp-endpoint-publish"
              >
                {busy === 'published' ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : endpoint.published ? (
                  <Lock aria-hidden />
                ) : (
                  <Globe aria-hidden />
                )}
                {endpoint.published ? 'Unpublish' : 'Publish'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void patchToggle(
                    'enabled',
                    { enabled: !endpoint.enabled },
                    endpoint.enabled ? 'disabled' : 'enabled',
                  )
                }
                disabled={busy !== null}
                title={
                  endpoint.enabled
                    ? 'Stop scheduled discovery for this endpoint'
                    : 'Resume scheduled discovery for this endpoint'
                }
                data-testid="mcp-endpoint-enable"
              >
                {busy === 'enabled' ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : endpoint.enabled ? (
                  <Pause aria-hidden />
                ) : (
                  <Play aria-hidden />
                )}
                {endpoint.enabled ? 'Disable' : 'Enable'}
              </Button>
              {/* The screen's one primary action (DESIGN.md §7). */}
              <Button
                type="button"
                onClick={() => void rediscover()}
                disabled={busy !== null}
                title="Re-run discovery against this endpoint"
                data-testid="mcp-endpoint-rediscover"
              >
                {discovering ? <Loader2 className="animate-spin" aria-hidden /> : <Radar aria-hidden />}
                {discovering ? 'Discovering…' : 'Re-discover'}
              </Button>
            </>
          ) : undefined
        }
        tabs={
          endpoint ? (
            <McpEndpointTabList
              value={activeTab}
              onValueChange={setActiveTab}
              counts={{ capabilities: capabilityCount }}
            />
          ) : undefined
        }
      />

      <PageBody>
        {loading ? (
          <DetailSkeleton />
        ) : error || !endpoint ? (
          <ErrorState
            title="Endpoint unavailable"
            description={error ?? 'This MCP endpoint could not be found in your catalog.'}
            onRetry={() => void load()}
            data-testid="mcp-endpoint-error"
          />
        ) : (
          <>
            {/* ---- Summary strip ------------------------------------------------------ */}
            <StatGrid columns={4} data-testid="mcp-endpoint-summary">
              <Stat
                label="Quality grade"
                icon={<Award aria-hidden />}
                value={gradeScore ?? <span className="text-fg-muted">—</span>}
                unit={gradeScore === null ? undefined : '/100'}
                footnote={
                  lintCounts ? (
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge status={lintCounts.must > 0 ? 'failed' : 'ok'}>
                        {lintCounts.must} MUST
                      </Badge>
                      <Badge status={lintCounts.should > 0 ? 'degraded' : 'unknown'}>
                        {lintCounts.should} SHOULD
                      </Badge>
                    </span>
                  ) : (
                    'Not scored yet'
                  )
                }
              />
              <Stat
                label="Current version"
                icon={<GitCommitHorizontal aria-hidden />}
                value={versionLabel}
                footnote={version?.version_tag ? <span className="mono">{version.version_tag}</span> : null}
                footnoteEnd={
                  version?.discovered_at
                    ? new Date(version.discovered_at).toLocaleDateString()
                    : null
                }
              />
              <Stat
                label="Server"
                icon={<Server aria-hidden />}
                value={serverLabel}
                unit={version?.server_version ? `(${version.server_version})` : undefined}
                footnote={
                  version?.protocol_version ? `MCP protocol ${version.protocol_version}` : null
                }
              />
              <Stat
                label="Last discovered"
                icon={<Clock aria-hidden />}
                value={
                  <RecencyPill
                    timestamp={endpoint.last_discovered_at}
                    prefix=""
                    hideIcon
                    className="text-inherit"
                  />
                }
                footnote={<HealthPill discoveryStatus={endpoint.last_discovery_status} />}
              />
            </StatGrid>

            {/* ---- Cataloger commentary ----------------------------------------------- */}
            <McpEndpointNotesPanel endpointId={endpointId} />

            {/* ---- The six panels ------------------------------------------------------ */}
            <McpEndpointTabPanel value="capabilities" active={activeTab}>
              {version?.instructions ? (
                <Card>
                  <CardHeader className="flex-row items-center gap-2">
                    <FileText aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
                    <CardTitle>Instructions</CardTitle>
                    <span className="ml-auto text-2xs text-fg-muted">
                      Server-provided, current snapshot
                    </span>
                  </CardHeader>
                  <CardBody>
                    <p className="whitespace-pre-wrap text-sm text-fg-muted">
                      {version.instructions}
                    </p>
                  </CardBody>
                </Card>
              ) : null}

              {!version ? (
                <EmptyState
                  icon={<Radar aria-hidden />}
                  title="Not yet discovered"
                  description="This endpoint has no current version snapshot. Run discovery to populate its tools, resources, and prompts."
                  action={
                    <Button type="button" onClick={() => void rediscover()} disabled={busy !== null}>
                      <Radar aria-hidden />
                      Re-discover
                    </Button>
                  }
                  data-testid="mcp-endpoint-undiscovered"
                />
              ) : itemGroups.length === 0 ? (
                <EmptyState
                  icon={<Wrench aria-hidden />}
                  title="No capabilities"
                  description="The current version snapshot declares no tools, resources, or prompts."
                  data-testid="mcp-endpoint-no-capabilities"
                />
              ) : (
                <>
                  {/* Tools lead on their own; the three smaller kinds sit beside each other,
                      as the mockup's two-column block draws them. */}
                  {itemGroups
                    .filter((group) => group.key === 'tool')
                    .map((group) => (
                      <CapabilitySection
                        key={group.key}
                        group={group}
                        highlighted={highlightedAnchor}
                      />
                    ))}
                  {itemGroups.some((group) => group.key !== 'tool') ? (
                    <div className="mcp-cap-columns">
                      {itemGroups
                        .filter((group) => group.key !== 'tool')
                        .map((group) => (
                          <CapabilitySection
                            key={group.key}
                            group={group}
                            highlighted={highlightedAnchor}
                          />
                        ))}
                    </div>
                  ) : null}
                </>
              )}
            </McpEndpointTabPanel>

            <McpEndpointTabPanel value="insight" active={activeTab}>
              <McpEndpointInsight
                endpointId={endpointId}
                currentVersionId={endpoint.current_version_id ?? null}
                endpoint={endpoint}
                currentInstructions={version?.instructions ?? null}
                onOpenVersionDiff={openVersionDiff}
                onNavigateToItem={navigateToItem}
              />
            </McpEndpointTabPanel>

            <McpEndpointTabPanel value="versions" active={activeTab}>
              <McpVersionHistory
                endpointId={endpointId}
                requestedDiffVersionId={pendingDiffVersionId}
                onDiffRequestConsumed={clearPendingDiff}
              />
            </McpEndpointTabPanel>

            <McpEndpointTabPanel value="lint" active={activeTab}>
              <McpLintReport
                report={lintReport}
                loading={lintLoading}
                error={lintError}
                onNavigateToItem={navigateToItem}
              />
            </McpEndpointTabPanel>

            <McpEndpointTabPanel value="settings" active={activeTab}>
              <McpEndpointSettings
                endpoint={endpoint}
                onSaved={handleSettingsSaved}
                onDeleted={handleSettingsDeleted}
              />
            </McpEndpointTabPanel>

            <McpEndpointTabPanel value="trust" active={activeTab}>
              {endpoint.current_version_id ? (
                <McpTrustPosturePanel
                  endpointId={endpointId}
                  versionId={endpoint.current_version_id}
                />
              ) : (
                <EmptyState
                  icon={<Radar aria-hidden />}
                  title="No snapshot to assess"
                  description="Trust posture is scored against a discovered version. Run discovery to capture one."
                  data-testid="mcp-endpoint-trust-undiscovered"
                />
              )}
            </McpEndpointTabPanel>
          </>
        )}
      </PageBody>
    </Page>
  );
}
