'use client';

/**
 * The Catalog item detail screen (HIVE-7.2, #5319; originally MFI-23.9, #4018).
 *
 * Authority: `docs/mockups/sources/catalog-item.html` and its **Notes → Keeps (1:1)** list.
 *
 * This is the "what was imported, where it came from, and what became of it" screen — the
 * `publishable = false` slice of projects (MFI-23.1), read-only by design: there is no Publish
 * and no Edit here, because a catalog item is minted by the import routing (MFI-23.7) rather
 * than authored.
 *
 * ### What this file is, after the redesign
 *
 * A shell. It owns the one read (`/api/catalog/{id}`), the deep links, the tab state and the
 * three dialogs; everything it used to *draw* now lives in a pane. The rules it used to decide
 * inline — which of two quality numbers the orbs show, when Convert and Export disappear, what
 * the converted strip says, how the four provenance steps are worded — are
 * `components/ade/catalog/detail/catalogItemView.ts`, so they are assertable without mounting
 * a screen.
 *
 * ### The eight panes
 *
 * All eight stay mounted (`hidden` on the inactive ones, which also removes them from the
 * accessibility tree) so deep-linked state survives a tab switch, and every pane that fetches
 * does so lazily off its `active` flag:
 *
 *  1. **Overview** — the normalized surface, its composition, the model's observability and
 *     the parsed entity groups.
 *  2. **Format details** — the imported payload in its *own* vocabulary (CPDO-2.1), hosting
 *     the X12 interchange inspector, the COBOL copybook inspector and the capability panel.
 *  3. **Source & code** — the raw imported source, read-only, in Monaco (MFI-25.4).
 *  4. **Provenance** — the import as its actual journey: intake → detection → normalization →
 *     catalog record.
 *  5. **Conversions** — the evidence history (CPDO-3.3), each row replaying the exact stored
 *     snapshot it was approved with, with the projection graph and its evidence drawer.
 *  6. **Lint & score** — the axes, the source-format checks, the findings and the Waive dialog.
 *  7. **Test bench** — validate or generate payloads against this item's schemas (IXH-5.3).
 *  8. **Versions** — the tick-any-two revision timeline and its inline diff (MFI-25.7).
 *
 * ### Deep links
 *
 * `?tab=` opens any pane; `?tab=source&sourcePath=&line=` is the CI/compatibility link
 * (CLX-2.3) and wins outright; `?tab=format&node=` addresses one construct inside the native
 * analysis. `catalogDetailTabFromQuery` is the single rule that resolves the three.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Binary,
  Code2,
  FileOutput,
  FlaskConical,
  GitBranch,
  GitMerge,
  LayoutDashboard,
  Route,
  ShieldCheck,
} from 'lucide-react';

import { parseCompatibilitySourceQuery } from '@lib/compatibility-source-link';
import { useAuthSession } from '@lib/auth/session-client';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Ring } from '@/app/components/ui/metrics';
import { TAB_COUNT_CLASS, TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { ProtocolPill } from '@/app/components/ui/catalog/ProtocolPill';
import { SourceBadge } from '@/app/components/ui/catalog/SourceBadge';
import { SuiteRegressionBadge } from '@/app/components/ade/dashboard/SuiteRegressionBadge';
import { ProjectQualityHistoryDialog } from '@/app/components/ade/dashboard/ProjectQualityHistoryDialog';
import { CatalogLintReportDialog } from '@/app/components/ade/dashboard/catalog/CatalogLintReportDialog';
import { ConversionPreviewDialog } from '@/app/components/ade/dashboard/catalog/ConversionPreviewDialog';
import { CatalogConversionHistoryPanel } from '@/app/components/ade/dashboard/catalog/CatalogConversionHistoryPanel';
import { CatalogFormatDetailPanel } from '@/app/components/ade/dashboard/catalog/CatalogFormatDetailPanel';
import { CatalogLintPanel } from '@/app/components/ade/dashboard/catalog/CatalogLintPanel';
import { CatalogRelatedArtifactsPanel } from '@/app/components/ade/dashboard/catalog/CatalogRelatedArtifactsPanel';
import { CatalogSourceViewer } from '@/app/components/ade/dashboard/catalog/CatalogSourceViewer';
import { CatalogVersionsPanel } from '@/app/components/ade/dashboard/catalog/CatalogVersionsPanel';
import { SchemaTestBench } from '@/app/components/ade/dashboard/test-bench/SchemaTestBench';
import { deriveParsedSummaryNote, type CatalogParsedGroup } from '@/app/components/ade/dashboard/catalog/CatalogParsedModel';
import {
  CATALOG_LIST_HREF,
  CatalogConvertedStrip,
  CatalogItemOverview,
  CatalogItemProvenance,
  catalogDetailActions,
  catalogDetailBreadcrumb,
  catalogDetailIdLine,
  catalogDetailDescription,
  catalogDetailLifecycle,
  catalogDetailOrbs,
  catalogDetailStatusLabel,
  catalogDetailTabFromQuery,
  catalogDetailTabs,
  catalogFormatNodeHref,
  isCatalogDetailReadonly,
  type CatalogDetailTabId,
  type CatalogNormalizedSummary,
  type CatalogSourceDescriptor,
} from '@/app/components/ade/catalog/detail';
import { exportStudioHref } from '@/app/components/ade/dashboard/export/exportStudioLink';
import { CATALOG_EXPORT_VS_CONVERT_COPY, type CatalogConversion } from '@/app/utils/catalog-conversion';
import { catalogEntityAnchorId } from '@/app/utils/catalog-lint-panel';
import { resolveCatalogSource } from '@/app/utils/catalog-format-registry';
import { getProjectQualityHistory } from '@/app/utils/project-quality-score-history';
import type { AnalysisSummary } from '@/app/utils/catalog-payload-analysis';
import type { RelatedArtifact } from '@/app/utils/catalog-related-artifacts';
import { cn } from '@lib/utils';

/** The detail payload (MFI-23.2 envelope + the MFI-23.9 `summary`/`source` enrichments). */
interface CatalogItemDetail {
  id: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  enabled: boolean;
  deleted_at: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  creator_name?: string | null;
  creator_email?: string | null;
  metadata?: Record<string, unknown> | null;
  qualityScore?: number | null;
  qualityGrade?: string | null;
  publishable?: boolean;
  sourceFormat?: string | null;
  protocol?: string | null;
  formatMetadata?: Record<string, unknown> | null;
  toolVersions?: Record<string, unknown> | null;
  summary?: CatalogNormalizedSummary;
  /** The normalized, paradigm-tagged parsed entity groups (MFI-25.2); `[]`/absent when unavailable. */
  parsed?: CatalogParsedGroup[] | null;
  /** The tree-free native-payload-analysis summary (CPDO-1.1, #4794). */
  analysis?: AnalysisSummary | null;
  source?: CatalogSourceDescriptor;
  /** The convert-to-OpenAPI back-link (MFI-23.11): present once the item has been converted. */
  conversion?: CatalogConversion | null;
  /** Cross-format identity group (MFI-6.4, #4410). */
  identityGroupId?: string | null;
  relatedArtifacts?: RelatedArtifact[];
}

/** Element-id prefix shared by the tab bar and the panes so their ARIA wiring lines up. */
const ID_PREFIX = 'catalog-detail';

/** The DOM id of a tab button, so a panel's `aria-labelledby` can point back at it. */
function tabId(id: CatalogDetailTabId): string {
  return `${ID_PREFIX}-tab-${id}`;
}

/** The DOM id of a tab panel, so a tab's `aria-controls` can point at it. */
function panelId(id: CatalogDetailTabId): string {
  return `${ID_PREFIX}-panel-${id}`;
}

/** The glyph each tab leads with — the mockup's icons, resolved from the view model's key. */
const TAB_GLYPH: Readonly<Record<string, typeof LayoutDashboard>> = {
  overview: LayoutDashboard,
  format: Binary,
  source: Code2,
  provenance: Route,
  conversions: GitMerge,
  lint: ShieldCheck,
  'test-bench': FlaskConical,
  versions: GitBranch,
};

/** The empty summary a payload without one degrades to. */
const EMPTY_SUMMARY: CatalogNormalizedSummary = {
  services: null,
  operations: null,
  types: null,
  channels: null,
};

/**
 * One detail pane.
 *
 * Every pane stays mounted so deep-linked state survives a tab switch; the inactive ones are
 * `hidden`, which also takes them out of the accessibility tree.
 */
function TabPanel({
  id,
  active,
  children,
}: {
  id: CatalogDetailTabId;
  active: CatalogDetailTabId;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(id)}
      aria-labelledby={tabId(id)}
      tabIndex={0}
      hidden={active !== id}
      data-testid={`catalog-detail-pane-${id}`}
      className="cid-pane"
    >
      {children}
    </div>
  );
}

/** One header orb: the ring plus its caps label, as a button when there is something to open. */
function HeaderOrb({
  label,
  title,
  testId,
  onClick,
  children,
}: {
  label: string;
  title: string;
  testId: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  if (!onClick) {
    return (
      <span className="cid-orb" data-testid={testId}>
        {children}
        <span className="cid-orb__label">{label}</span>
      </span>
    );
  }
  return (
    <button type="button" className="cid-orb" data-testid={testId} onClick={onClick} title={title}>
      {children}
      <span className="cid-orb__label">{label}</span>
    </button>
  );
}

export function CatalogItemDetailClient({ itemId }: { itemId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The Test bench scopes its saved payloads to the current tenant (IXH-5.3).
  const { data: session } = useAuthSession();
  const currentTenantId =
    (session?.user as { current_tenant_id?: string } | undefined)?.current_tenant_id ?? null;

  const sourceDeepLink = useMemo(() => parseCompatibilitySourceQuery(searchParams), [searchParams]);

  const [item, setItem] = useState<CatalogItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [lintOpen, setLintOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CatalogDetailTabId>('overview');
  // The counts the three counted panes report once they have loaded (MFI-25.1 tab chips).
  const [tabCounts, setTabCounts] = useState<{
    conversions: number | null;
    lint: number | null;
    versions: number | null;
  }>({ conversions: null, lint: null, versions: null });
  // A lint finding deep-link (MFI-28.2) wants to scroll to this Overview entity once it mounts.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const [highlightedAnchor, setHighlightedAnchor] = useState<string | null>(null);
  // A source location the Format details pane asked the Source viewer to reveal (CPDO-2.1); it
  // overrides the `?line=` compatibility deep link while set. `range` carries the exact
  // characters when the analyzer recorded them (CPDO-2.2), so the viewer selects the construct
  // rather than merely centring the line it starts on.
  const [sourceFocus, setSourceFocus] = useState<{
    line: number;
    file: string | null;
    range: { offset: number; length: number } | null;
    label: string | null;
  } | null>(null);

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /** "View code" (and any deep link into the raw source) jumps to the Source & code pane. */
  const showSourceTab = useCallback(() => setActiveTab('source'), []);

  // Compatibility / CI deep links open the Source pane; any other `?tab=` naming a known pane
  // opens that pane. An unknown value leaves the reader where they are.
  useEffect(() => {
    const requested = catalogDetailTabFromQuery(searchParams.get('tab'), sourceDeepLink);
    if (requested) setActiveTab(requested);
  }, [searchParams, sourceDeepLink]);

  /** The analysis node a `?node=` deep link wants the Format details pane to reveal. */
  const focusNodeId = searchParams.get('node');

  /** Reveal a native-analysis node's source location in the Source & code pane. */
  const showSourceLine = useCallback(
    (
      line: number,
      file: string | null,
      range?: { offset: number; length: number } | null,
      label?: string | null,
    ) => {
      setSourceFocus({ line, file, range: range ?? null, label: label ?? null });
      setActiveTab('source');
    },
    [],
  );

  /** The shareable address of one analysis node — `?tab=format&node=<id>` on this route. */
  const nodeHref = useCallback((nodeId: string) => catalogFormatNodeHref(itemId, nodeId), [itemId]);

  /** Follow a lint finding to its parsed entity: switch to Overview and queue the scroll. */
  const navigateToEntity = useCallback((name: string) => {
    setPendingAnchor(catalogEntityAnchorId(name));
    setActiveTab('overview');
  }, []);

  // Once Overview is active and its content has mounted, scroll the pending entity into view
  // and highlight it. Runs after commit so the anchor element exists.
  useEffect(() => {
    if (activeTab !== 'overview' || !pendingAnchor) return;
    const el = document.getElementById(pendingAnchor);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedAnchor(pendingAnchor);
    }
    setPendingAnchor(null);
  }, [activeTab, pendingAnchor]);

  // Clear the deep-link highlight after a short, self-cancelling delay.
  useEffect(() => {
    if (!highlightedAnchor) return undefined;
    const timer = setTimeout(() => setHighlightedAnchor(null), 2500);
    return () => clearTimeout(timer);
  }, [highlightedAnchor]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/catalog/${encodeURIComponent(itemId)}`);
      const data = await res.json();
      if (!res.ok || !data?.success || !data.item) {
        setError(data?.error || 'Catalog item not found.');
        setItem(null);
      } else {
        setItem(data.item as CatalogItemDetail);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load catalog item.');
      setItem(null);
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** After a conversion (MFI-23.11), reload so the back-link appears and Convert relabels. */
  const handleConverted = useCallback(() => {
    void load();
  }, [load]);

  const setConversionsCount = useCallback(
    (count: number) => setTabCounts((prev) => (prev.conversions === count ? prev : { ...prev, conversions: count })),
    [],
  );
  const setLintCount = useCallback(
    (count: number) => setTabCounts((prev) => (prev.lint === count ? prev : { ...prev, lint: count })),
    [],
  );
  const setVersionsCount = useCallback(
    (count: number) => setTabCounts((prev) => (prev.versions === count ? prev : { ...prev, versions: count })),
    [],
  );

  /**
   * Open the Export Studio (MFX-41.2, #4349) scoped to this item's latest revision — the power
   * path where the item is emitted in another format with the full verify-then-generate flow.
   * Carries the launch origin (so the Studio's back link returns to Catalog) and the source
   * format (so the redundant same-format target is hidden). Unlike Convert, this never mints a
   * Project and never mutates the item.
   */
  const handleExport = useCallback(() => {
    if (!item) return;
    router.push(
      exportStudioHref({
        artifact: item.id,
        label: item.name,
        origin: 'catalog',
        sourceFormat: item.sourceFormat ?? null,
      }),
    );
  }, [item, router]);

  // The orbs reuse the project quality machinery — a catalog item's id *is* a project id.
  const qualityHistory = useMemo(() => (item ? getProjectQualityHistory(item.id) : []), [item]);
  const orbs = useMemo(
    () => (item ? catalogDetailOrbs(item, qualityHistory) : null),
    [item, qualityHistory],
  );

  const openQualityReport = useCallback(() => {
    if (!item || !orbs) return;
    if (orbs.qualityOpensLintReport) setLintOpen(true);
    else setQualityOpen(true);
  }, [item, orbs]);

  const tabs = useMemo(() => catalogDetailTabs(tabCounts), [tabCounts]);

  /** Select and focus the tab at `index`, wrapping around the ends (WAI-ARIA automatic activation). */
  const focusTab = useCallback(
    (index: number) => {
      const count = tabs.length;
      const next = ((index % count) + count) % count;
      setActiveTab(tabs[next].id);
      tabRefs.current[next]?.focus();
    },
    [tabs],
  );

  if (loading) {
    return (
      <Page>
        <PageBody>
          <LoadingState message="Loading catalog item…" />
        </PageBody>
      </Page>
    );
  }

  if (error || !item) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: 'Catalog', href: CATALOG_LIST_HREF }]}
          title="Catalog item"
        />
        <PageBody>
          <ErrorState
            data-testid="catalog-detail-error"
            title="Catalog item not found."
            description={error || 'Catalog item not found.'}
            onRetry={() => void load()}
            action={
              <Button variant="outline" onClick={() => router.push(CATALOG_LIST_HREF)}>
                Back to Catalog
              </Button>
            }
          />
        </PageBody>
      </Page>
    );
  }

  const lifecycle = catalogDetailLifecycle(item);
  const actions = catalogDetailActions(item);
  const source = item.source ?? null;
  const resolvedSource = resolveCatalogSource(item.formatMetadata, item.metadata);
  const summary = item.summary ?? EMPTY_SUMMARY;
  const parsed = item.parsed ?? [];
  const entityNames = parsed.flatMap((group) => group.entities.map((entity) => entity.name));
  const sourceHref = `/api/catalog/${encodeURIComponent(item.id)}/source`;

  return (
    <Page>
      <PageHeader
        leading={<Avatar shape="hex" size="xl" name={item.name} seed={item.id} />}
        breadcrumb={catalogDetailBreadcrumb(item)}
        title={item.name}
        truncateTitle
        badge={
          <Badge status={lifecycle} dot data-testid="catalog-detail-status">
            {catalogDetailStatusLabel(item)}
          </Badge>
        }
        description={
          <>
            <span className="mono cid-idline">{catalogDetailIdLine(item)}</span>
            {' — '}
            {catalogDetailDescription(item)}
          </>
        }
        meta={
          <div className="cid-meta">
            <FormatPill format={item.sourceFormat} />
            <ProtocolPill protocol={item.protocol} />
            {resolvedSource ? <SourceBadge source={resolvedSource} /> : null}
            {/* IXH-5.7: appears only when a saved suite's newest run regressed. The mockup makes
                it a link — the verdict diff it names lives in the Test bench pane. */}
            <SuiteRegressionBadge
              surface="catalog"
              artifact={item.slug || item.id}
              onSelect={() => setActiveTab('test-bench')}
            />
          </div>
        }
        actions={
          <>
            <div className="cid-orbs">
              <HeaderOrb
                label="Quality"
                title="Open quality score history"
                testId="catalog-detail-quality-orb"
                onClick={orbs?.quality != null ? openQualityReport : undefined}
              >
                <Ring score={orbs?.quality ?? null} label="Quality score" size="lg" />
              </HeaderOrb>
              <HeaderOrb
                label="Lint"
                title="Open lint report"
                testId="catalog-detail-lint-orb"
                onClick={orbs?.grade ? () => setLintOpen(true) : undefined}
              >
                <Ring
                  score={orbs?.quality ?? null}
                  grade={orbs?.grade ?? null}
                  display="grade"
                  label="Lint grade"
                  size="lg"
                />
              </HeaderOrb>
            </div>
            {actions.convert.shown ? (
              <Button
                variant="primary"
                onClick={() => setConvertOpen(true)}
                data-testid="catalog-detail-convert"
              >
                <GitMerge aria-hidden />
                {actions.convert.label}
              </Button>
            ) : null}
            {actions.export.shown ? (
              <Button
                variant="outline"
                onClick={handleExport}
                title={CATALOG_EXPORT_VS_CONVERT_COPY}
                data-testid="catalog-detail-export"
              >
                <FileOutput aria-hidden />
                Export
              </Button>
            ) : null}
            <Button variant="outline" onClick={showSourceTab} data-testid="catalog-detail-view-code">
              <Code2 aria-hidden />
              View code
            </Button>
          </>
        }
        tabs={
          /* A hand-built strip on the shared tab classes rather than `ui/Tabs`, for the reason
             the style-guides editor records: `Tabs.Root` is one element that would have to wrap
             the header *and* the body, and `.page` is a flex column whose two children are
             exactly those. The roles, the roving tabindex and the panel association are all
             stated here. */
          <div
            role="tablist"
            aria-label="Catalog item detail sections"
            data-testid="catalog-detail-tabs"
            className={cn(TAB_LIST_CLASS, 'cid-tabs')}
          >
            {tabs.map((tab, index) => {
              const Glyph = TAB_GLYPH[tab.icon];
              const isActive = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[index] = el;
                  }}
                  type="button"
                  role="tab"
                  id={tabId(tab.id)}
                  aria-selected={isActive}
                  aria-controls={panelId(tab.id)}
                  tabIndex={isActive ? 0 : -1}
                  data-testid={`catalog-detail-tab-${tab.id}`}
                  className={tabTriggerClass({ active: isActive })}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => {
                    switch (event.key) {
                      case 'ArrowRight':
                      case 'ArrowDown':
                        event.preventDefault();
                        focusTab(index + 1);
                        break;
                      case 'ArrowLeft':
                      case 'ArrowUp':
                        event.preventDefault();
                        focusTab(index - 1);
                        break;
                      case 'Home':
                        event.preventDefault();
                        focusTab(0);
                        break;
                      case 'End':
                        event.preventDefault();
                        focusTab(tabs.length - 1);
                        break;
                      default:
                        break;
                    }
                  }}
                >
                  <Glyph aria-hidden className="cid-tab__glyph" />
                  {tab.label}
                  {tab.count !== null ? (
                    <span className={TAB_COUNT_CLASS}>{tab.count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        }
      />

      <PageBody>
        {/* The converted strip and Related artifacts sit above the panes, as the mockup's
            "Adds" note puts it: both are facts about the item as a whole, not about one pane. */}
        <div className="cid-top">
          <div className="cid-top__main">
            <CatalogConvertedStrip
              conversion={item.conversion}
              conversionCount={tabCounts.conversions ?? 0}
              onOpenHistory={() => setActiveTab('conversions')}
            />
          </div>
          <CatalogRelatedArtifactsPanel
            projectId={item.id}
            identityGroupId={item.identityGroupId}
            relatedArtifacts={item.relatedArtifacts ?? []}
            readonly={isCatalogDetailReadonly(item)}
            onChanged={() => void load()}
          />
        </div>

        <TabPanel id="overview" active={activeTab}>
          <CatalogItemOverview
            summary={summary}
            parsed={parsed}
            summaryNote={deriveParsedSummaryNote(parsed)}
            source={source}
            qualityScore={orbs?.quality ?? null}
            qualityGrade={item.qualityGrade ?? null}
            highlightedAnchor={highlightedAnchor}
            onOpenLint={() => setActiveTab('lint')}
            onOpenSource={showSourceTab}
          />
        </TabPanel>

        <TabPanel id="format" active={activeTab}>
          <CatalogFormatDetailPanel
            itemId={item.id}
            summary={item.analysis ?? null}
            sourceFormat={item.sourceFormat ?? null}
            active={activeTab === 'format'}
            sourceAvailable={Boolean(source?.downloadable)}
            onViewSourceLine={showSourceLine}
            nodeHref={nodeHref}
            focusNodeId={focusNodeId}
            onRevealEntity={navigateToEntity}
            entityNames={entityNames}
          />
        </TabPanel>

        <TabPanel id="source" active={activeTab}>
          <CatalogSourceViewer
            sourceHref={sourceHref}
            sourceFormat={item.sourceFormat}
            resolvedSource={resolvedSource}
            downloadable={Boolean(source?.downloadable)}
            hasContent={Boolean(source?.hasContent)}
            sourceUri={source?.uri ?? null}
            active={activeTab === 'source'}
            highlightLine={sourceFocus?.line ?? sourceDeepLink.line}
            focusSourcePath={sourceFocus?.file ?? sourceDeepLink.sourcePath}
            highlightOrigin={sourceFocus ? 'format-analysis' : 'compatibility'}
            highlightRange={sourceFocus?.range ?? null}
            highlightLabel={sourceFocus?.label ?? null}
          />
        </TabPanel>

        <TabPanel id="provenance" active={activeTab}>
          <CatalogItemProvenance
            source={source}
            resolvedSource={resolvedSource}
            sourceFormat={item.sourceFormat ?? null}
            protocol={item.protocol ?? null}
            toolVersions={item.toolVersions}
            formatMetadata={item.formatMetadata}
            creatorName={item.creator_name}
            creatorEmail={item.creator_email}
            createdAt={item.created_at}
            updatedAt={item.updated_at}
          />
        </TabPanel>

        <TabPanel id="conversions" active={activeTab}>
          <CatalogConversionHistoryPanel
            itemId={item.id}
            active={activeTab === 'conversions'}
            onOpenConvertPreview={() => setConvertOpen(true)}
            onCountChange={setConversionsCount}
          />
        </TabPanel>

        <TabPanel id="lint" active={activeTab}>
          <CatalogLintPanel
            itemId={item.id}
            active={activeTab === 'lint'}
            onOpenReport={() => setLintOpen(true)}
            onOpenQualityHistory={openQualityReport}
            qualityAvailable={orbs?.quality != null}
            entityNames={entityNames}
            onNavigateToEntity={navigateToEntity}
            scoredAt={item.updated_at ?? item.created_at ?? null}
            sourceFormat={item.sourceFormat ?? null}
            sourceHref={sourceHref}
            sourceAvailable={Boolean(source?.downloadable)}
            onCountChange={setLintCount}
          />
        </TabPanel>

        <TabPanel id="test-bench" active={activeTab}>
          <SchemaTestBench
            surface="catalog"
            artifact={item.slug || item.id}
            artifactName={item.name}
            tenantId={currentTenantId}
            active={activeTab === 'test-bench'}
          />
        </TabPanel>

        <TabPanel id="versions" active={activeTab}>
          <CatalogVersionsPanel
            itemId={item.id}
            itemName={item.name}
            itemMetadata={item.metadata}
            active={activeTab === 'versions'}
            onCountChange={setVersionsCount}
          />
        </TabPanel>
      </PageBody>

      <ProjectQualityHistoryDialog
        key={qualityOpen ? `${item.id}:quality` : 'catalog-detail-dialog-closed'}
        open={qualityOpen}
        onOpenChange={setQualityOpen}
        projectName={item.name}
        projectId={item.id}
        history={qualityHistory}
        initialSection="quality"
      />

      <CatalogLintReportDialog
        key={lintOpen ? `${item.id}:lint` : 'catalog-detail-lint-closed'}
        itemId={lintOpen ? item.id : null}
        itemName={item.name}
        open={lintOpen}
        onOpenChange={setLintOpen}
      />

      <ConversionPreviewDialog
        key={convertOpen ? `${item.id}:convert` : 'catalog-detail-convert-closed'}
        itemId={convertOpen ? item.id : null}
        itemName={item.name}
        sourceFormat={item.sourceFormat ?? null}
        open={convertOpen}
        onOpenChange={setConvertOpen}
        onConverted={handleConverted}
      />
    </Page>
  );
}
