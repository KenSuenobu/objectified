'use client';

/**
 * CatalogItemDetailClient (MFI-23.9, #4018).
 *
 * The catalog item *detail* view — "what was imported and where it came from". It mirrors the other
 * dashboard detail screens (a back link, an avatar/title header, then panels) and reuses the catalog
 * pills (MFI-23.5) and the shared `ProjectQualityHistoryDialog` (so the quality/lint orbs open the
 * very same dialogs the Projects and Catalog screens use — a catalog item's id *is* a project id).
 *
 * The header (idhead) carries the quality/lint orbs and the CTAs: **Convert** is the primary action
 * (it opens the existing `ConversionPreviewDialog`) and **View code** jumps to the Source tab. Below
 * it a tab bar (MFI-25.1, #4086) organizes the `/api/catalog/{id}` payload (MFI-23.2 envelope + the
 * 23.9 enrichments) into five panes that switch **without a route change**:
 *   1. **Overview** — the normalized services / operations / types / channels counts.
 *   2. **Source & Code** — file name / URL / discovery, viewable + downloadable via the
 *      `/api/catalog/{id}/source` proxy (streams captured content, or redirects to the source URL).
 *   3. **Provenance** — format/protocol, tool versions, import-job reference, timestamps + creator.
 *   4. **Lint & Score** — the score/grade summary, linking into the shared quality-history and lint
 *      dialogs (the very same dialogs the header orbs open).
 *   5. **Versions** — a link into the shared version history (catalog items share the versions table).
 *
 * There is intentionally **no Publish/Edit** here: catalog items are the non-publishable slice of
 * projects (MFI-23.1), minted by the import routing (MFI-23.7), and read-only on this screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { parseCompatibilitySourceQuery } from '@lib/compatibility-source-link';
import {
  ArrowLeft,
  ArrowLeftRight,
  CheckCircle2,
  Code,
  FileOutput,
  Info,
  Wrench,
} from 'lucide-react';
import { cn } from '@lib/utils';
import { catalogOrbScores } from '@/app/utils/catalog-card-presentation';
import { getNumericScoreTier, type NumericScoreTierStyle } from '@/app/utils/numeric-score-tier';
import { getProjectQualityHistory } from '@/app/utils/project-quality-score-history';
import { ProjectQualityHistoryDialog } from '@/app/components/ade/dashboard/ProjectQualityHistoryDialog';
import { CatalogLintReportDialog } from '@/app/components/ade/dashboard/catalog/CatalogLintReportDialog';
import { ConversionPreviewDialog } from '@/app/components/ade/dashboard/catalog/ConversionPreviewDialog';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { ProtocolPill } from '@/app/components/ui/catalog/ProtocolPill';
import { SourceBadge } from '@/app/components/ui/catalog/SourceBadge';
import { resolveCatalogSource } from '@/app/utils/catalog-format-registry';
import {
  catalogCardGradientClass,
  catalogCardInitials,
  formatShortCatalogId,
} from '@/app/utils/catalog-card-presentation';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  CATALOG_EXPORT_VS_CONVERT_COPY,
  convertActionLabel,
  convertedProjectHref,
  convertedProjectLabel,
  isConvertedLinkLive,
  type CatalogConversion,
} from '@/app/utils/catalog-conversion';
import { exportStudioHref } from '@/app/components/ade/dashboard/export/exportStudioLink';
import {
  dashboardMainClass,
  dashboardContentStackClass,
  dashboardPanelClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  CatalogDetailTabs,
  panelElementId,
  tabElementId,
  type DetailTab,
} from '@/app/components/ade/dashboard/catalog/CatalogDetailTabs';
import {
  CatalogParsedGroups,
  deriveParsedSummaryNote,
  type CatalogParsedGroup,
} from '@/app/components/ade/dashboard/catalog/CatalogParsedModel';
import {
  catalogEntityAnchorId,
  catalogQualityOpensServerLintReport,
} from '@/app/utils/catalog-lint-panel';
import { CatalogSourceViewer } from '@/app/components/ade/dashboard/catalog/CatalogSourceViewer';
import { CatalogLintPanel } from '@/app/components/ade/dashboard/catalog/CatalogLintPanel';
import { SchemaTestBench } from '@/app/components/ade/dashboard/test-bench/SchemaTestBench';
import { useAuthSession } from '@lib/auth/session-client';
import { CatalogVersionsPanel } from '@/app/components/ade/dashboard/catalog/CatalogVersionsPanel';
import { CatalogRelatedArtifactsPanel } from '@/app/components/ade/dashboard/catalog/CatalogRelatedArtifactsPanel';
import type { RelatedArtifact } from '@/app/utils/catalog-related-artifacts';

/** The normalized-content counts the import recorded for the item (each null until captured). */
interface CatalogNormalizedSummary {
  services: number | null;
  operations: number | null;
  types: number | null;
  channels: number | null;
}

/** Where the item was imported from, plus whether the raw source is retrievable. */
interface CatalogSourceDescriptor {
  kind: 'file' | 'url' | 'paste' | 'discovery' | null;
  label: string | null;
  uri: string | null;
  hasContent: boolean;
  downloadable: boolean;
}

/** The detail payload (MFI-23.2 envelope + MFI-23.9 `summary`/`source`). */
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
  source?: CatalogSourceDescriptor;
  /** The convert-to-OpenAPI back-link (MFI-23.11): present once the item has been converted. */
  conversion?: CatalogConversion | null;
  /** Cross-format identity group (MFI-6.4, #4410). */
  identityGroupId?: string | null;
  relatedArtifacts?: RelatedArtifact[];
}

const CATALOG_LIST_HREF = '/ade/dashboard/catalog';

/** Element-id prefix shared by the tab bar and the panes so their ARIA wiring lines up. */
const DETAIL_TABS_ID_PREFIX = 'catalog-detail';

/** The detail panes (mockup `multi-format-import/index.html` + IXH-5.3), in tab order. */
const DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'source', label: 'Source & Code' },
  { id: 'provenance', label: 'Provenance' },
  { id: 'lint', label: 'Lint & Score' },
  { id: 'test-bench', label: 'Test Bench' },
  { id: 'versions', label: 'Versions' },
] as const satisfies readonly DetailTab[];

type DetailTabId = (typeof DETAIL_TABS)[number]['id'];

/** The orb border colour for a quality/lint band (mirrors CatalogItemCard). */
function scoreOrbBorderClass(band: NumericScoreTierStyle['band'] | null): string {
  if (!band) return 'border-gray-300 dark:border-gray-600';
  if (band === 'excellent') return 'border-emerald-500';
  if (band === 'good') return 'border-indigo-500';
  if (band === 'fair') return 'border-amber-500';
  return 'border-rose-500';
}

/** Format an ISO timestamp for display, tolerating null/invalid input. */
function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** The candidate keys an import-job reference may travel under in the provenance bag. */
const IMPORT_JOB_KEYS = ['importJobId', 'import_job_id', 'jobId', 'job_id', 'importJob', 'import_job'];

/** Read the first present, non-empty string value among `keys` from a loose bag. */
function firstString(bag: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!bag) return null;
  for (const k of keys) {
    const v = bag[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/** A labelled metric tile in the normalized-summary grid. */
function SummaryCard({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </span>
      <span className="mt-1 font-mono text-2xl font-semibold tabular-nums text-gray-900 dark:text-white">
        {typeof value === 'number' ? value : '—'}
      </span>
    </div>
  );
}

/** A labelled key/value row used inside the provenance panel. */
function ProvenanceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-4">
      <span className="w-40 shrink-0 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </span>
      <span className="min-w-0 text-sm text-gray-800 dark:text-gray-200">{children}</span>
    </div>
  );
}

/**
 * A single detail pane. All panes stay mounted so deep-linked state and the existing panel testids
 * survive tab switches; the inactive ones are hidden with `hidden` (which also removes them from the
 * accessibility tree). Its `id`/`aria-labelledby` line up with the matching tab via the shared
 * element-id helpers.
 */
function TabPanel({
  tabId,
  active,
  testId,
  children,
}: {
  tabId: DetailTabId;
  active: DetailTabId;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelElementId(DETAIL_TABS_ID_PREFIX, tabId)}
      aria-labelledby={tabElementId(DETAIL_TABS_ID_PREFIX, tabId)}
      tabIndex={0}
      hidden={active !== tabId}
      data-testid={testId}
      className="space-y-6 focus:outline-none"
    >
      {children}
    </div>
  );
}

export function CatalogItemDetailClient({ itemId }: { itemId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The Test Bench scopes its saved payloads to the current tenant (IXH-5.3).
  const { data: session } = useAuthSession();
  const currentTenantId =
    ((session?.user as { current_tenant_id?: string } | undefined)?.current_tenant_id as
      | string
      | undefined) ?? null;
  const sourceDeepLink = useMemo(
    () => parseCompatibilitySourceQuery(searchParams),
    [searchParams]
  );
  const [item, setItem] = useState<CatalogItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qualityOpen, setQualityOpen] = useState(false);
  // Server-backed lint report (same report Projects use, MFI-23.10).
  const [lintOpen, setLintOpen] = useState(false);
  // The convert-to-OpenAPI fidelity preview (MFI-22.4/23.11).
  const [convertOpen, setConvertOpen] = useState(false);
  // The active detail pane (MFI-25.1). Tab switches never change the route.
  const [activeTab, setActiveTab] = useState<DetailTabId>('overview');
  // A lint finding deep-link (MFI-28.2) wants to scroll to this Overview entity once the tab mounts.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  // The Overview entity currently highlighted by a just-followed deep-link (cleared after a delay).
  const [highlightedAnchor, setHighlightedAnchor] = useState<string | null>(null);

  // "View code" (and any future deep link into the raw source) jumps to the Source & Code tab.
  const showSourceTab = useCallback(() => setActiveTab('source'), []);

  // Compatibility / CI deep links (?tab=source&sourcePath=&line=) open the Source tab (CLX-2.3).
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'source' || sourceDeepLink.sourcePath || sourceDeepLink.line) {
      setActiveTab('source');
    }
  }, [searchParams, sourceDeepLink.line, sourceDeepLink.sourcePath]);

  // Follow a lint finding to its parsed entity: switch to the Overview tab and queue the scroll.
  const navigateToEntity = useCallback((name: string) => {
    setPendingAnchor(catalogEntityAnchorId(name));
    setActiveTab('overview');
  }, []);

  // Once the Overview tab is active and its content has mounted, scroll the pending entity into
  // view and highlight it. Runs after commit so the anchor element exists.
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

  /**
   * After a successful conversion (MFI-23.11), reload the item so its new "Converted → {project}"
   * back-link is reflected and the convert action relabels to "Re-convert".
   */
  const handleConverted = useCallback(() => {
    void load();
  }, [load]);

  /**
   * Open the Export Studio (MFX-41.2, #4349) scoped to this catalog item's latest revision — the
   * power path where the item is emitted in another format with the full verify-then-generate
   * flow. Carries the launch origin (so the Studio's back link returns to Catalog) and the source
   * format (so the redundant same-format target is hidden). Unlike Convert, this never mints a
   * Project or mutates the item.
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

  // The orbs reuse the project quality-history machinery (a catalog item's id is a project id),
  // falling back to the server-captured score/grade when there is no browser-local history.
  const qualityHistory = useMemo(
    () => (item ? getProjectQualityHistory(item.id) : []),
    [item],
  );
  const { qualityValue, lintLetter } = useMemo(
    () => (item ? catalogOrbScores(item, qualityHistory) : { qualityValue: null, lintLetter: null }),
    [item, qualityHistory],
  );
  const scoreTier = qualityValue != null ? getNumericScoreTier(qualityValue) : null;

  const openQualityReport = useCallback(() => {
    if (!item) return;
    if (catalogQualityOpensServerLintReport(qualityHistory, item.qualityScore)) {
      setLintOpen(true);
      return;
    }
    setQualityOpen(true);
  }, [item, qualityHistory]);

  if (loading) {
    return (
      <main className={dashboardMainClass}>
        <LoadingState message="Loading catalog item…" />
      </main>
    );
  }

  if (error || !item) {
    return (
      <main className={dashboardMainClass}>
        <div className={dashboardContentStackClass}>
          <Link
            href={CATALOG_LIST_HREF}
            className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
          >
            <ArrowLeft className="h-4 w-4" /> Catalog
          </Link>
          <div
            data-testid="catalog-detail-error"
            className={`${dashboardPanelClass} p-10 text-center text-sm text-gray-600 dark:text-gray-400`}
          >
            {error || 'Catalog item not found.'}
          </div>
        </div>
      </main>
    );
  }

  const isDeleted = Boolean(item.deleted_at);
  const source = item.source ?? null;
  const resolvedSource = resolveCatalogSource(item.formatMetadata, item.metadata);
  const summary = item.summary ?? { services: null, operations: null, types: null, channels: null };
  const hasAnyCount =
    typeof summary.services === 'number' ||
    typeof summary.operations === 'number' ||
    typeof summary.types === 'number' ||
    typeof summary.channels === 'number';
  // The parsed entity groups (MFI-25.2) rendered in the Overview, plus the derived `summaryNote`.
  const parsed = item.parsed ?? [];
  const summaryNote = deriveParsedSummaryNote(parsed);
  // The parsed-entity names the Lint tab's findings can deep-link to (MFI-28.2).
  const entityNames = parsed.flatMap((group) => group.entities.map((entity) => entity.name));
  const toolVersionEntries = Object.entries(item.toolVersions ?? {}).filter(
    ([, v]) => v != null && String(v).trim() !== '',
  );
  const importJobRef = firstString(item.formatMetadata, IMPORT_JOB_KEYS);
  const sourceHref = `/api/catalog/${encodeURIComponent(item.id)}/source`;

  return (
    <main className={dashboardMainClass}>
      <div className={dashboardContentStackClass}>
        <Link
          href={CATALOG_LIST_HREF}
          className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
        >
          <ArrowLeft className="h-4 w-4" /> Catalog
        </Link>

        {/* Header */}
        <section className={`${dashboardPanelClass} p-6`} data-testid="catalog-detail-header">
          <div className="flex flex-wrap items-start gap-4">
            <span
              className={cn(
                'inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br font-mono text-lg font-bold text-white',
                catalogCardGradientClass(item.id),
              )}
              aria-hidden
            >
              {catalogCardInitials(item.name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-bold text-gray-900 dark:text-white" title={item.name}>
                  {item.name}
                </h1>
                {isDeleted ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                    Deleted
                  </span>
                ) : !item.enabled ? (
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                    Disabled
                  </span>
                ) : (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                    Active
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                {formatShortCatalogId(item.id)}
                {item.slug ? ` · ${item.slug}` : ''}
              </p>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                {item.description?.trim() || 'No description.'}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <FormatPill format={item.sourceFormat} />
                <ProtocolPill protocol={item.protocol} />
                {resolvedSource ? <SourceBadge source={resolvedSource} /> : null}
              </div>
            </div>

            {/* Quality + lint orbs (open the shared dialog). */}
            <div className="flex shrink-0 items-start gap-4">
              <div className="text-center">
                <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Quality
                </p>
                {qualityValue != null ? (
                  <button
                    type="button"
                    data-testid="catalog-detail-quality-orb"
                    onClick={openQualityReport}
                    className={cn(
                      'mt-1 inline-flex h-11 w-11 items-center justify-center rounded-full border-2 font-mono text-xs font-semibold tabular-nums hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30',
                      scoreOrbBorderClass(scoreTier!.band),
                      scoreTier!.textClass,
                    )}
                    title="Open quality score history"
                  >
                    {qualityValue}
                  </button>
                ) : (
                  <span className="mt-1 inline-flex h-11 w-11 items-center justify-center rounded-full border-2 border-gray-300 font-mono text-xs text-gray-400 dark:border-gray-600">
                    —
                  </span>
                )}
              </div>
              <div className="text-center">
                <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Lint
                </p>
                {lintLetter ? (
                  <button
                    type="button"
                    data-testid="catalog-detail-lint-orb"
                    onClick={() => setLintOpen(true)}
                    className={cn(
                      'mt-1 inline-flex h-11 w-11 items-center justify-center rounded-full border-2 font-mono text-xs font-semibold tabular-nums hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30',
                      scoreOrbBorderClass(scoreTier?.band ?? null),
                      scoreTier?.textClass ?? 'text-gray-500 dark:text-gray-400',
                    )}
                    title="Open lint report"
                  >
                    {lintLetter}
                  </button>
                ) : (
                  <span className="mt-1 inline-flex h-11 w-11 items-center justify-center rounded-full border-2 border-gray-300 font-mono text-xs text-gray-400 dark:border-gray-600">
                    —
                  </span>
                )}
              </div>
            </div>

            {/* Primary CTAs (MFI-25.1): Convert is the primary action; Export (MFX-41.2, #4349)
                emits the item in another format without minting a Project; "View code" opens the
                Source tab. */}
            <div className="flex shrink-0 flex-col gap-2">
              {!item.deleted_at ? (
                <button
                  type="button"
                  data-testid="catalog-detail-convert"
                  onClick={() => setConvertOpen(true)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
                >
                  <ArrowLeftRight className="h-4 w-4" /> {convertActionLabel(item.conversion, item.sourceFormat)}
                </button>
              ) : null}
              {!item.deleted_at ? (
                <button
                  type="button"
                  data-testid="catalog-detail-export"
                  onClick={handleExport}
                  title={CATALOG_EXPORT_VS_CONVERT_COPY}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  <FileOutput className="h-4 w-4 text-emerald-600 dark:text-emerald-500" /> Export
                </button>
              ) : null}
              <button
                type="button"
                data-testid="catalog-detail-view-code"
                onClick={showSourceTab}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                <Code className="h-4 w-4 text-indigo-500" /> View code
              </button>
            </div>
          </div>

          {/* Converted → {project} back-link (MFI-23.11) — shown once the item has been converted. */}
          {item.conversion ? (
            <div
              data-testid="catalog-detail-converted"
              className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm dark:border-emerald-800 dark:bg-emerald-950/30"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span className="text-emerald-800 dark:text-emerald-300">
                {item.conversion.reconverted ? 'Re-converted to OpenAPI project' : 'Converted to OpenAPI project'}
                {item.conversion.versionId ? ` · ${item.conversion.versionId}` : ''}:
              </span>
              {isConvertedLinkLive(item.conversion) ? (
                <Link
                  href={convertedProjectHref(item.conversion)}
                  className="font-semibold text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
                >
                  {convertedProjectLabel(item.conversion)}
                </Link>
              ) : (
                <span className="font-semibold text-gray-500 line-through dark:text-gray-400" title="The converted project was deleted">
                  {convertedProjectLabel(item.conversion)}
                </span>
              )}
            </div>
          ) : null}

          <CatalogRelatedArtifactsPanel
            projectId={item.id}
            identityGroupId={item.identityGroupId}
            relatedArtifacts={item.relatedArtifacts ?? []}
            readonly={Boolean(item.deleted_at)}
            onChanged={() => void load()}
          />
        </section>

        {/* Tabbed detail shell (MFI-25.1) — panes switch without a route change. */}
        <CatalogDetailTabs
          tabs={DETAIL_TABS}
          active={activeTab}
          onSelect={(id) => setActiveTab(id as DetailTabId)}
          idPrefix={DETAIL_TABS_ID_PREFIX}
        />

        {/* OVERVIEW — normalized summary */}
        <TabPanel tabId="overview" active={activeTab} testId="catalog-detail-pane-overview">
          <section className={`${dashboardPanelClass} p-6`} data-testid="catalog-detail-summary">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Normalized summary
            </h2>
            {hasAnyCount ? (
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <SummaryCard label="Services" value={summary.services} />
                <SummaryCard label="Operations" value={summary.operations} />
                <SummaryCard label="Types" value={summary.types} />
                <SummaryCard label="Channels" value={summary.channels} />
              </div>
            ) : (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                The normalized-content summary has not been captured for this item yet.
              </p>
            )}
            {summaryNote ? (
              <p
                data-testid="catalog-detail-summary-note"
                className="mt-3 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
              >
                <Info className="h-3.5 w-3.5 shrink-0" aria-hidden /> {summaryNote}
              </p>
            ) : null}
          </section>

          {/* Parsed entities (MFI-25.3) — the actual normalized model, human-readable. A lint
              finding deep-link (MFI-28.2) highlights its target entity here. */}
          <CatalogParsedGroups parsed={parsed} highlightedAnchor={highlightedAnchor} />
        </TabPanel>

        {/* SOURCE & CODE — the raw imported source rendered read-only in Monaco (MFI-25.4) */}
        <TabPanel tabId="source" active={activeTab} testId="catalog-detail-pane-source">
          <CatalogSourceViewer
            sourceHref={sourceHref}
            sourceFormat={item.sourceFormat}
            resolvedSource={resolvedSource}
            downloadable={Boolean(source?.downloadable)}
            hasContent={Boolean(source?.hasContent)}
            sourceUri={source?.uri ?? null}
            active={activeTab === 'source'}
            highlightLine={sourceDeepLink.line}
            focusSourcePath={sourceDeepLink.sourcePath}
          />
        </TabPanel>

        {/* PROVENANCE */}
        <TabPanel tabId="provenance" active={activeTab} testId="catalog-detail-pane-provenance">
          <section className={`${dashboardPanelClass} p-6`} data-testid="catalog-detail-provenance">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Provenance
            </h2>
            <div className="mt-2 divide-y divide-gray-100 dark:divide-gray-700/60">
              <ProvenanceRow label="Format">
                {item.sourceFormat ? <FormatPill format={item.sourceFormat} /> : <span className="text-gray-400">—</span>}
              </ProvenanceRow>
              <ProvenanceRow label="Protocol">
                {item.protocol ? <ProtocolPill protocol={item.protocol} /> : <span className="text-gray-400">—</span>}
              </ProvenanceRow>
              <ProvenanceRow label="Tool versions">
                {toolVersionEntries.length > 0 ? (
                  <span className="flex flex-wrap gap-1.5">
                    {toolVersionEntries.map(([tool, version]) => (
                      <span
                        key={tool}
                        className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-700/60 dark:text-gray-300"
                      >
                        <Wrench className="h-3 w-3" aria-hidden /> {tool} {String(version)}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-gray-400">Not recorded</span>
                )}
              </ProvenanceRow>
              <ProvenanceRow label="Import job">
                {importJobRef ? (
                  <span className="font-mono text-xs">{importJobRef}</span>
                ) : (
                  <span className="text-gray-400">Not recorded</span>
                )}
              </ProvenanceRow>
              <ProvenanceRow label="Created">{formatTimestamp(item.created_at)}</ProvenanceRow>
              <ProvenanceRow label="Updated">{formatTimestamp(item.updated_at)}</ProvenanceRow>
              <ProvenanceRow label="Created by">
                {item.creator_name || item.creator_email || 'Unknown'}
              </ProvenanceRow>
            </div>
          </section>
        </TabPanel>

        {/* LINT & SCORE — the inline gauge + category bars + findings (MFI-25.5); the full itemized
            report and quality history stay reachable via the panel's actions and the header orbs. */}
        <TabPanel tabId="lint" active={activeTab} testId="catalog-detail-pane-lint">
          <CatalogLintPanel
            itemId={item.id}
            active={activeTab === 'lint'}
            onOpenReport={() => setLintOpen(true)}
            onOpenQualityHistory={openQualityReport}
            qualityAvailable={qualityValue != null}
            entityNames={entityNames}
            onNavigateToEntity={navigateToEntity}
            scoredAt={item.updated_at ?? item.created_at ?? null}
            sourceFormat={item.sourceFormat ?? null}
          />
        </TabPanel>

        {/* TEST BENCH — validate/generate payloads against this item's schemas (IXH-5.3). The
            reference addresses the item by slug (or id) at its latest revision. */}
        <TabPanel tabId="test-bench" active={activeTab} testId="catalog-detail-pane-test-bench">
          <SchemaTestBench
            surface="catalog"
            artifact={item.slug || item.id}
            artifactName={item.name}
            tenantId={currentTenantId}
            active={activeTab === 'test-bench'}
          />
        </TabPanel>

        {/* VERSIONS — inline newest-first timeline with tick-any-two-to-diff (MFI-25.7); catalog items
            are versioned on the same table as Projects, so this reads the shared versions endpoint. */}
        <TabPanel tabId="versions" active={activeTab} testId="catalog-detail-pane-versions">
          <CatalogVersionsPanel
            itemId={item.id}
            itemName={item.name}
            itemMetadata={item.metadata}
            active={activeTab === 'versions'}
          />
        </TabPanel>
      </div>

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
    </main>
  );
}
