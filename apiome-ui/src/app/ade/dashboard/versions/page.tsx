'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthSession } from '@lib/auth/session-client';
import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import {
  Package,
  GitMerge,
  GitFork,
  GitGraph,
  LayoutGrid,
  ScrollText,
  ListOrdered,
  GitCompareArrows,
  FileText,
  ArrowUpDown,
  FlaskConical,
  History,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '../../../components/ui/Dialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../components/ui/AlertDialog';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Label } from '../../../components/ui/Label';
import { Alert } from '../../../components/ui/Alert';
import { LoadingState } from '../../../components/ui/LoadingState';
import { EmptyState, GatedState } from '../../../components/ui/EmptyState';
import { Textarea } from '../../../components/ui/Textarea';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import {
  DataTableFilterChip,
  DataTableFoot,
  DataTableToolbar,
  DataTableToolbarSpacer,
  type DataTableSortState,
} from '../../../components/ui/DataTable';
import { FormatPill } from '../../../components/ui/catalog/FormatPill';
import { gradeBand } from '../../../components/ui/statusVocabulary';
import { TAB_COUNT_CLASS, TAB_LIST_CLASS, tabTriggerClass } from '../../../components/ui/tabStyles';
import PageHeader from '../../../components/shell/PageHeader';
import { Page, PageBody } from '../../../components/shell/pageChrome';
import { cn } from '@lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/Select';
import {
  DEFAULT_VERSIONS_SORT,
  EditVersionDialog,
  GITLIKE_FLAG_TITLE,
  GitlikeFlag,
  NewVersionDialog,
  ProjectFactsCard,
  PublishVersionDialog,
  SUNSET_TIMELINE_ROUTE,
  SpecViewerDialog,
  SunsetScheduleDialog,
  VERSION_FACETS,
  VERSION_FACET_LABELS,
  VERSION_LIFECYCLES,
  VERSION_LIFECYCLE_LABEL,
  VERSION_SORT_OPTIONS,
  VersionGitlikePanels,
  VersionsBanners,
  VersionsTable,
  VersionsTimelineFilters,
  compatibilityBanner,
  deleteVersionConfirm,
  deprecationBanner,
  formatVersionDate,
  freezeSchemaConfirm,
  gitlikeAffordance,
  headRevisionBadge,
  lastPublishedVersion,
  matchesVersionFacet,
  newestPublishedSummary,
  nextVersionsSort,
  sortVersions,
  storedQualityBadge,
  unpublishVersionConfirm,
  versionFacetCounts,
  versionsFootLabel,
  versionsHeadLine,
  versionsSortFromMenu,
  versionsSortLabel,
  whatsNewBanner,
  type Project,
  type Version,
  type VersionBranchRow,
  type VersionFacet,
  type VersionRowMenuAction,
  type VersionTagRow,
} from '../../../components/ade/versions';
import type { VersionChangelogSummary } from '@lib/version-changelog';
import { useDialog } from '../../../components/providers/DialogProvider';
import {
  deleteVersion,
  buildOpenApiSpecJsonForVersion,
  getClassesForVersion,
  getPropertiesForClass,
  getTenantsAdministratedByUser
} from '../../../../../lib/db/helper';
import { coerceProjectMetadataRecord } from '@lib/project-metadata';
import YAML from 'yaml';
import { diffLines, Change } from 'diff';
import {
  compareSchemas,
  buildClassLevelDiff,
  formatClassDiffStatLines,
  formatPropertyDiffLine,
  getClassChangeDiffs,
  type DiffSummary,
  type ClassDiffRow,
  getPathLabel,
} from '../../../../../lib/schema-diff';
import { compareLayouts, type LayoutDiffSummary, type LayoutState } from '../../../../../lib/layout-diff';
import { loadLayoutStateForVersionCompare } from '../../../../../lib/version-canvas-layout';
import {
  COMMIT_EXTERNAL_REF_MAX_CHARS,
  extractBreakingHintsFromChangelog,
  validateVersionNotesClient,
  VERSION_NOTES_LIMITS,
} from '../../../../../lib/version-notes';
import { generateBreakingChangesMarkdownFromSummary } from '../../../../../lib/breaking-changes-doc';
import { generateMigrationGuideMarkdownFromSummary } from '../../../../../lib/migration-guide-doc';
import { downloadMigrationGuidePdf } from '../../../utils/export-migration-guide-pdf';
import { sanitizeFilenameSegment } from '../../../utils/filename-utils';
import RelationshipGraphDialog from './RelationshipGraphDialog';
import VersionHistoryGraphPanel from './VersionHistoryGraphPanel';
import ProjectConversionPanel from './ProjectConversionPanel';
import ImportDialog from '../../../components/ade/dashboard/ImportDialog';
import { findNewlyImportedProject } from './imported-project';
import { useConversionHistory } from '../../../components/ade/dashboard/catalog/useConversionHistory';
import { DEFAULT_HISTORY_WINDOW } from './version-history-dag';
import { toast } from 'sonner';
import { localDatetimeLocalToUtcIso, utcIsoToDatetimeLocalValue } from '../../../utils/revision-deprecation';
import { usePushConflictBanner } from '@/app/providers/PushConflictBannerProvider';
import ServerAheadPushBanner from '@/app/components/ade/ServerAheadPushBanner';
import { parseStaleHeadFromVersionsPostJson } from '@/app/utils/push-conflict';
import { formatVersionWithPrefix } from '@/app/utils/version-display';
import { isProjectPublishable } from '@/app/utils/catalog-publishable';
import { suggestBranchNameFromRevision } from '../../../../../lib/version-branch-utils';
import { projectHeadRevisionId } from '../../../utils/project-head-revision';
import {
  normalizeMergeConflictRows,
  type MergeConflictResolutionChoice,
} from '../../../../../lib/version-merge';
import { VersionMergeConflictList } from '../../../components/ade/dashboard/VersionMergeConflictList';
import { CompatibilityReportPanel } from '../../../components/ade/dashboard/CompatibilityReportPanel';
import { ExternalCompatEvidencePanel } from '../../../components/ade/dashboard/ExternalCompatEvidencePanel';
import { VersionChangeReportPanel } from './VersionChangeReportPanel';
import { VersionChangesPanel } from './VersionChangesPanel';
import { SchemaTestBench } from '@/app/components/ade/dashboard/test-bench/SchemaTestBench';
import { SuiteRegressionBadge } from '@/app/components/ade/dashboard/SuiteRegressionBadge';
import {
  breakingStableIds,
  changelogMatchesComparedPair,
  countsSummary,
  severityBadgeVariant,
  severityLabel,
  stableIdForPointer,
  type VersionChangelog,
} from '@lib/version-changelog';
import ExportDialog, { type ExportedArtifactSummary } from '../../../components/ade/dashboard/export/ExportDialog';
import { recordRecentExport } from '../../../components/ade/dashboard/export/recentExports';
import { ProjectRelatedArtifactsSection } from '../../../components/ade/dashboard/ProjectRelatedArtifactsSection';
import { FEATURE_GITLIKE } from '@lib/feature-flags';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import type { VersionMockChange } from '../../../components/ade/dashboard/VersionMockCell';
import {
  guardrailBlocksPublish,
  type BreakingPublishGuardrail,
} from '@/app/utils/breaking-publish-guardrail';
import type { VersionLintReport } from '@/app/utils/version-lint-report';
import type { VerificationPolicyDecision } from '../style-guides/verification-policy-api';
import { useMockUsage } from '@/app/hooks/useMockUsage';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/** Where the breadcrumb's Projects crumb and the no-projects state go. */
const PROJECTS_ROUTE = '/ade/dashboard/projects';

/**
 * How this build treats `FEATURE_GITLIKE` affordances (HIVE-6.2, #5313) — decided once, from
 * the build constant and `NODE_ENV`; see `gitlikeAffordance` for the four rows.
 */
const GITLIKE = gitlikeAffordance();

/**
 * Whether the environment allows the change-report UI at all. The flag half of the gate is
 * `FEATURE_GITLIKE`; when only the flag hides it, the tab is drawn inert with its marker.
 */
const CHANGE_REPORT_ENV_ALLOWED = process.env.NEXT_PUBLIC_CHANGE_REPORT_UI !== '0';

/** Radix `Select` cannot use the empty string as a value; these stand in for "no filter". */
const ALL_LIFECYCLES = '__all__';
const ALL_REVISIONS = '__all__';

const SPEC_JSON_YAML_TOGGLE_ITEM_CLASS =
  'px-3 py-2 text-xs font-semibold rounded-md transition-all duration-200 data-[state=on]:bg-white dark:data-[state=on]:bg-gray-600 data-[state=on]:text-indigo-600 dark:data-[state=on]:text-indigo-400 data-[state=on]:shadow-sm data-[state=off]:text-gray-600 dark:data-[state=off]:text-gray-400 hover:text-gray-900 dark:hover:text-white';

function SpecJsonYamlToggle({
  value,
  onChange,
}: {
  value: 'json' | 'yaml';
  onChange: (format: 'json' | 'yaml') => void;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as 'json' | 'yaml');
      }}
      className="inline-flex shrink-0 items-center rounded-lg bg-gray-100 p-1 dark:bg-gray-700/50"
    >
      <ToggleGroup.Item value="json" className={SPEC_JSON_YAML_TOGGLE_ITEM_CLASS}>
        JSON
      </ToggleGroup.Item>
      <ToggleGroup.Item value="yaml" className={SPEC_JSON_YAML_TOGGLE_ITEM_CLASS}>
        YAML
      </ToggleGroup.Item>
    </ToggleGroup.Root>
  );
}

const VersionCanvasCompare = dynamic(() => import('./VersionCanvasCompare'), {
  ssr: false,
  loading: () => (
    <LoadingState
      className="min-h-[min(380px,45vh)] w-full"
      minHeightClassName="min-h-[min(380px,45vh)]"
      spinnerSize="md"
      message="Loading canvas compare…"
    />
  ),
});

/** Client-side history timeline filters (#2579) — matches REST list `q` / creator / date range semantics. */
function revisionMatchesHistoryFilters(
  v: Version,
  q: string,
  authorCreatorId: string,
  dateFrom: string,
  dateTo: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (needle) {
    const hay = [v.shortMessage, v.changelog, v.author, v.message]
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .join('\n')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (authorCreatorId && v.creator_id !== authorCreatorId) return false;
  if (dateFrom || dateTo) {
    const t = new Date(v.created_at).getTime();
    if (dateFrom) {
      const parts = dateFrom.split('-').map((x) => parseInt(x, 10));
      if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
        const [y, m, d] = parts;
        const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
        if (t < start) return false;
      }
    }
    if (dateTo) {
      const parts = dateTo.split('-').map((x) => parseInt(x, 10));
      if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
        const [y, m, d] = parts;
        const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
        if (t > end) return false;
      }
    }
  }
  return true;
}

/** Rollback confirm dialog (#2581): revision row time in UTC for display. */
function formatRevisionTimestampUtc(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

const Versions = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useAuthSession();
  const { conflict, setPushConflictFrom409, clearPushConflict } = usePushConflictBanner();
  const [versionsPullBannerLoading, setVersionsPullBannerLoading] = useState(false);
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  /** Spec importer opened from this screen's header (#5260) — same dialog the Projects screen uses. */
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showSunsetScheduleDialog, setShowSunsetScheduleDialog] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishVersionId, setPublishVersionId] = useState<string | null>(null);
  const [publishVisibility, setPublishVisibility] = useState<'private' | 'public'>('private');
  const [publishShortMessage, setPublishShortMessage] = useState('');
  const [publishChangelog, setPublishChangelog] = useState('');
  /** Force publish: bypass publish prechecks (missing descriptions, OpenAPI build, compatibility, style-guide errors). */
  const [publishForce, setPublishForce] = useState(false);
  /** Required when force publish is checked (GOV-2.5). */
  const [publishForceReason, setPublishForceReason] = useState('');
  const [publishLintReport, setPublishLintReport] = useState<VersionLintReport | null>(null);
  const [publishVerificationDecision, setPublishVerificationDecision] =
    useState<VerificationPolicyDecision | null>(null);
  /** Breaking-publish guardrail assessment for this revision (CTG-3.4). */
  const [publishBreakingGuardrail, setPublishBreakingGuardrail] =
    useState<BreakingPublishGuardrail | null>(null);
  /** Publication change report baseline (CR): mirrors REST publish-preview / publish bodies. */
  const [publishChangeReportBaselineMode, setPublishChangeReportBaselineMode] = useState<
    'auto' | 'initial' | 'manual'
  >('auto');
  const [publishManualBaselineRevisionId, setPublishManualBaselineRevisionId] = useState('');
  const [publishPreviewLoading, setPublishPreviewLoading] = useState(false);
  const [publishPreviewError, setPublishPreviewError] = useState<string | null>(null);
  const [publishPreview, setPublishPreview] = useState<{
    headerSnapshot: string;
    renderedBody: string;
    footnoteSnapshot: string;
    initialPublication?: boolean;
    fromVersionLabel?: string;
    toVersionLabel?: string;
  } | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<Version | null>(null);
  /** Timeline vs publication change report (CR-05, #2703; gated by `NEXT_PUBLIC_CHANGE_REPORT_UI`) vs stored changelog (CTG-3.2, #4476) vs the Schema Test Bench (IXH-5.3, #5115). */
  const [versionsMainTab, setVersionsMainTab] = useState<
    'timeline' | 'change-report' | 'changes' | 'test-bench' | 'conversion'
  >('timeline');
  /* Change reports are part of the git-like publication flow, so the UI gate
     is the union of the env opt-out and the master git-like feature flag.
     When git-like is off, all change-report panels, tabs, and publish-preview
     fetches collapse into no-ops. */
  const changeReportUiEnabled =
    FEATURE_GITLIKE && process.env.NEXT_PUBLIC_CHANGE_REPORT_UI !== '0';
  const [versionId, setVersionId] = useState('');
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [bumpStrategy, setBumpStrategy] = useState<'patch' | 'minor'>('patch');
  const [nextAutoVersion, setNextAutoVersion] = useState<string>('');
  const [description, setDescription] = useState('');
  const [changeLog, setChangeLog] = useState('');
  /** Optional ticket / issue id (Jira, Linear, …) stored as external_ref on create (#2564). */
  const [commitExternalRef, setCommitExternalRef] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [sourceVersionId, setSourceVersionId] = useState<string>('');
  /** When multiple named branches exist, select by branch id before resolving tip (#505). */
  const [copySourceBranchKey, setCopySourceBranchKey] = useState<string>('blank');
  const [branchListLoading, setBranchListLoading] = useState(false);
  const [branchListError, setBranchListError] = useState<string | null>(null);
  const [branchPermissionDenied, setBranchPermissionDenied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Dropdown state

  const [showOpenApiDialog, setShowOpenApiDialog] = useState(false);
  const [openApiSpec, setOpenApiSpec] = useState<string>('');
  /** The revision the ExportDialog is open for — export is version-scoped (MFX-6.5, #3859). */
  const [exportVersion, setExportVersion] = useState<Version | null>(null);
  /** Bumped after an export is recorded so the recent-exports list re-reads storage. */
  const [recentExportsRefresh, setRecentExportsRefresh] = useState(0);
  const [openApiFormat, setOpenApiFormat] = useState<'json' | 'yaml'>('json');
  const [viewingVersion, setViewingVersion] = useState<Version | null>(null);
  const [isLoadingSpec, setIsLoadingSpec] = useState(false);

  const [showCompareDialog, setShowCompareDialog] = useState(false);
  const [compareVersion1Id, setCompareVersion1Id] = useState<string>('');
  const [compareVersion2Id, setCompareVersion2Id] = useState<string>('');
  const [compareSpec1, setCompareSpec1] = useState<string>('');
  const [compareSpec2, setCompareSpec2] = useState<string>('');
  const [compareFormat, setCompareFormat] = useState<'json' | 'yaml'>('json');
  const [isLoadingComparison, setIsLoadingComparison] = useState(false);
  const [diffResult, setDiffResult] = useState<Change[]>([]);
  const [schemaDiffSummary, setSchemaDiffSummary] = useState<DiffSummary | null>(null);
  const [classDiffRows, setClassDiffRows] = useState<ClassDiffRow[] | null>(null);
  const [classDiffSearch, setClassDiffSearch] = useState('');
  const [classDiffShowUnchanged, setClassDiffShowUnchanged] = useState(true);
  const [expandedClassDiffId, setExpandedClassDiffId] = useState<string | null>(null);
  /** When true, show all property drill lines for that class (performance for large schemas / #741). */
  const [propDrillShowAllByClass, setPropDrillShowAllByClass] = useState<Record<string, boolean>>({});
  const [classListScrollTop, setClassListScrollTop] = useState(0);
  const classListScrollRef = useRef<HTMLDivElement | null>(null);
  const [diffViewMode, setDiffViewMode] = useState<'overlay' | 'side-by-side'>('overlay');
  const [diffFilter, setDiffFilter] = useState<{
    showAdded: boolean;
    showRemoved: boolean;
    showModified: boolean;
  }>({ showAdded: true, showRemoved: true, showModified: true });
  const [activeCompareTab, setActiveCompareTab] = useState<
    'diff' | 'summary' | 'breaking' | 'migration' | 'canvas'
  >('diff');
  /** Stored publish-time classification for the compared pair (CTG-3.2, #4476); null when the pair has none. */
  const [compareStoredChangelog, setCompareStoredChangelog] = useState<VersionChangelog | null>(null);
  /** Pending deep-link target inside the compare dialog (a `ctg.changelog.v1` JSON Pointer). */
  const [compareFocusPointer, setCompareFocusPointer] = useState<string | null>(null);
  const [canvasCompareLeft, setCanvasCompareLeft] = useState<LayoutState | null>(null);
  const [canvasCompareRight, setCanvasCompareRight] = useState<LayoutState | null>(null);
  const [canvasCompareDiff, setCanvasCompareDiff] = useState<LayoutDiffSummary | null>(null);
  const [canvasCompareLoading, setCanvasCompareLoading] = useState(false);
  /** When this matches `baseId:compareId`, canvas snapshots for that pair are loaded (lazy). */
  const [canvasComparePairKey, setCanvasComparePairKey] = useState('');
  const [canvasCompareViewMode, setCanvasCompareViewMode] = useState<'split' | 'overlay'>('split');

  const [showRelationshipGraphDialog, setShowRelationshipGraphDialog] = useState(false);
  const [relationshipGraphVersion, setRelationshipGraphVersion] = useState<Version | null>(null);
  const [relationshipGraphClasses, setRelationshipGraphClasses] = useState<Array<{ id: string; name: string; properties?: Array<{ id: string; name: string; data: unknown }> }> | null>(null);
  const [isLoadingRelationshipGraph, setIsLoadingRelationshipGraph] = useState(false);

  const [hasClassSchemaMap, setHasClassSchemaMap] = useState<Record<string, boolean>>({});
  const [freezingSchemaVersionId, setFreezingSchemaVersionId] = useState<string | null>(null);

  const [versionBranches, setVersionBranches] = useState<VersionBranchRow[]>([]);
  const [showBranchDialog, setShowBranchDialog] = useState(false);
  const [branchFromVersionId, setBranchFromVersionId] = useState<string>('');
  const [branchNameInput, setBranchNameInput] = useState('');
  const [branchSaving, setBranchSaving] = useState(false);
  /** Scroll target after creating a branch (panel may not exist yet for the first named branch). */
  const historyGraphSectionRef = useRef<HTMLDivElement | null>(null);

  const [showForkDialog, setShowForkDialog] = useState(false);
  const [forkFromVersionId, setForkFromVersionId] = useState('');
  const [forkTargetProjectId, setForkTargetProjectId] = useState('');
  const [forkAutoGenerate, setForkAutoGenerate] = useState(true);
  const [forkVersionId, setForkVersionId] = useState('');
  const [forkBumpStrategy, setForkBumpStrategy] = useState<'patch' | 'minor'>('patch');
  const [forkDescription, setForkDescription] = useState('');
  const [forkChangeLog, setForkChangeLog] = useState('');
  const [forkSaving, setForkSaving] = useState(false);
  const [forkPreviewNext, setForkPreviewNext] = useState<string>('');

  const [versionTags, setVersionTags] = useState<VersionTagRow[]>([]);
  const [showTagDialog, setShowTagDialog] = useState(false);
  const [tagFromVersionId, setTagFromVersionId] = useState<string>('');
  const [tagNameInput, setTagNameInput] = useState('');
  const [tagMessageInput, setTagMessageInput] = useState('');
  const [tagChannelInput, setTagChannelInput] = useState('');
  const [tagImmutable, setTagImmutable] = useState(false);
  const [tagProtected, setTagProtected] = useState(false);
  const [tagSaving, setTagSaving] = useState(false);
  const [historyTagFilter, setHistoryTagFilter] = useState<string>('');
  /** Timeline: message / changelog / commit body / commit author (#2579) */
  const [historySearchQ, setHistorySearchQ] = useState('');
  const [historyAuthorCreatorId, setHistoryAuthorCreatorId] = useState('');
  const [historyDateFrom, setHistoryDateFrom] = useState('');
  const [historyDateTo, setHistoryDateTo] = useState('');
  /** The table's sort, bridged to the timeline's own comparator by `sortVersions` (HIVE-6.2). */
  const [versionsSort, setVersionsSort] = useState<DataTableSortState>(DEFAULT_VERSIONS_SORT);
  /** The toolbar's quick chip — All · Drafts · Published (HIVE-6.2). */
  const [versionFacet, setVersionFacet] = useState<VersionFacet>('all');
  /**
   * False until the selected project's first revisions read lands, so the table draws its
   * skeleton rather than an empty state that a moment later is not (HIVE-6.2). Only the first
   * read of a project (or a lifecycle change) resets it — a reload after a write draws the
   * rows it has while the new ones arrive.
   */
  const [versionsLoaded, setVersionsLoaded] = useState(false);
  /**
   * The project's stored change classifications (`/api/projects/{id}/changelogs`) — what the
   * compatibility banner reads (HIVE-6.2). The Changes tab reads the same list itself.
   */
  const [changelogSummaries, setChangelogSummaries] = useState<VersionChangelogSummary[] | null>(null);
  const [lifecycleFilter, setLifecycleFilter] = useState<string>('');
  const [editLifecycle, setEditLifecycle] = useState<string>('stable');
  const [editDeprecationMessage, setEditDeprecationMessage] = useState('');
  const [editSunsetLocal, setEditSunsetLocal] = useState('');
  const [editSuccessorRevisionId, setEditSuccessorRevisionId] = useState('');
  const [editPublishedMetadataOnly, setEditPublishedMetadataOnly] = useState(false);
  const [compareBaseTagId, setCompareBaseTagId] = useState<string>('');
  const [compareToTagId, setCompareToTagId] = useState<string>('');
  /** #743: newest-first window for history DAG + "Load older" */
  const [historyGraphWindowSize, setHistoryGraphWindowSize] = useState(DEFAULT_HISTORY_WINDOW);

  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [mergeSourceBranch, setMergeSourceBranch] = useState('');
  const [mergeTargetBranch, setMergeTargetBranch] = useState('');
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);
  const [mergeApplyLoading, setMergeApplyLoading] = useState(false);
  const [mergePreviewData, setMergePreviewData] = useState<{
    classification?: { canAutoMerge: boolean; conflictPaths: string[]; addedSchemaNames: string[] };
    sourceTipVersionId?: string;
    targetTipVersionId?: string;
    mergeBaseVersionId?: string | null;
    conflicts?: Array<{ path: string; kinds: string[] }>;
    /** Branches used for the last successful preview — apply requires a matching preview (#2576). */
    previewSourceBranch?: string;
    previewTargetBranch?: string;
  } | null>(null);
  const [mergeConflictResolutions, setMergeConflictResolutions] = useState<
    Record<string, MergeConflictResolutionChoice | null>
  >({});
  const [mergeCompatLoading, setMergeCompatLoading] = useState(false);
  const [mergeCompat, setMergeCompat] = useState<{
    overall: string;
    findings: Array<{ id?: string; category: string; rule: string; path: string; message: string }>;
    breakingChangeDocumentationIssueUrl?: string | null;
    tenantCompatGateActive?: boolean;
    mergeBlockedByCompatGate?: boolean;
    ruleHits?: Record<string, number>;
  } | null>(null);
  const [mergeCompatGateOverride, setMergeCompatGateOverride] = useState(false);
  const [mergeCompatGateOverrideReason, setMergeCompatGateOverrideReason] = useState('');

  const [showRollbackDialog, setShowRollbackDialog] = useState(false);
  const [rollbackTargetVersion, setRollbackTargetVersion] = useState<Version | null>(null);
  const [rollbackBranchName, setRollbackBranchName] = useState('');
  const [rollbackPreviewLoading, setRollbackPreviewLoading] = useState(false);
  const [rollbackApplyLoading, setRollbackApplyLoading] = useState(false);
  const [rollbackPreview, setRollbackPreview] = useState<{
    branchTipRevisionId?: string;
    compatOverall?: string;
    findings?: Array<{ id?: string; path: string; message: string; rule?: string }>;
    deprecationWarnings?: unknown[];
    rollbackBlockedByCompatGate?: boolean;
    breakingChangeDocumentationIssueUrl?: string | null;
    impactSummary?: {
      added: number;
      removed: number;
      modified: number;
      unchanged: number;
      changedEntityCount: number;
    };
  } | null>(null);
  const [rollbackSkipCompat, setRollbackSkipCompat] = useState(false);
  const [rollbackShortMessage, setRollbackShortMessage] = useState('');
  const [showRollbackConfirmAlert, setShowRollbackConfirmAlert] = useState(false);

  // Fork targets are real Projects only — forking into a catalog item would bypass the
  // import routing that mints catalog items (#4587).
  const otherProjects = useMemo(
    () => projects.filter((p) => p.id !== selectedProjectId && isProjectPublishable(p)),
    [projects, selectedProjectId]
  );

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId),
    [projects, selectedProjectId]
  );

  // 30-day mock usage series for the selected project's versions (#4443, SIM-2.2).
  const { seriesByVersion: mockUsageByVersion } = useMockUsage({
    enabled: Boolean(selectedProject?.slug),
    projectSlug: selectedProject?.slug ?? null,
  });

  /** Fold a successful mock toggle round-trip back into the versions table state (#4443). */
  const handleVersionMockChanged = useCallback((versionRecordId: string, change: VersionMockChange) => {
    setVersions((prev) =>
      prev.map((v) =>
        v.id === versionRecordId
          ? {
              ...v,
              mockEnabled: change.mockEnabled,
              mockBaseUrl: change.mockBaseUrl,
              mockPrivate: change.mockPrivate,
            }
          : v
      )
    );
  }, []);

  /**
   * Project selector options (#4587): catalog items (publishable=false) are excluded — they are
   * browsed and exported from Dashboard → Catalog, not the Projects surface. A deep-linked catalog
   * item (the catalog's "View" / "Open version history" actions pass `?projectId=`) stays
   * selectable so those flows keep working; it is appended only while it is the selection.
   */
  const selectableProjects = useMemo(() => {
    const publishable = projects.filter(isProjectPublishable);
    const selected = projects.find((p) => p.id === selectedProjectId);
    return selected && !isProjectPublishable(selected) ? [...publishable, selected] : publishable;
  }, [projects, selectedProjectId]);

  /**
   * Whether a revision's owning project is a publishable Project (vs a non-publishable catalog
   * item — the `publishable = false` slice of projects, MFI-23.1). Catalog items are never publish
   * candidates (MFI-23.8, #4017), so the Publish affordance is withheld for them. An absent flag is
   * treated as publishable for back-compat with older payloads; REST enforces the rule regardless.
   */
  const isVersionPublishable = useCallback(
    (version: Version) => isProjectPublishable(projects.find((p) => p.id === version.project_id)),
    [projects]
  );

  const handleSelectedProjectChange = useCallback(
    (id: string) => {
      setSelectedProjectId(id);
      const params = new URLSearchParams(searchParams.toString());
      params.set('projectId', id);
      router.replace(`/ade/dashboard/versions?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const isSyncingScroll = useRef(false);

  const sessionUser = session?.user as
    | { current_tenant_id?: string; user_id?: string; is_tenant_admin?: boolean }
    | undefined;
  const currentTenantId = sessionUser?.current_tenant_id;
  const currentUserId = sessionUser?.user_id;
  const isAdmin = Boolean(sessionUser?.is_tenant_admin);
  const [effectiveIsAdmin, setEffectiveIsAdmin] = useState<boolean>(isAdmin);

  useEffect(() => {
    let cancelled = false;
    const resolveAdmin = async () => {
      try {
        if (isAdmin) { if (!cancelled) setEffectiveIsAdmin(true); return; }
        if (!currentUserId || !currentTenantId) { if (!cancelled) setEffectiveIsAdmin(false); return; }
        const res = await getTenantsAdministratedByUser(currentUserId);
        const rows = JSON.parse(res) as Array<{ tenant_id: string; user_id: string }>;
        const isAdminForTenant = rows.some(
          (r) => r.tenant_id === currentTenantId && r.user_id === currentUserId
        );
        if (!cancelled) setEffectiveIsAdmin(isAdminForTenant);
      } catch { if (!cancelled) setEffectiveIsAdmin(false); }
    };
    resolveAdmin();
    return () => { cancelled = true; };
  }, [isAdmin, currentUserId, currentTenantId]);

  /**
   * Canvas snapshots load only when the Canvas tab is opened (#742) — not during OpenAPI compare —
   * to keep the initial compare fast and defer React Flow + layout queries.
   */
  useEffect(() => {
    if (activeCompareTab !== 'canvas' || diffResult.length === 0) return;
    if (!compareVersion1Id || !compareVersion2Id) return;
    const key = `${compareVersion1Id}:${compareVersion2Id}`;
    if (canvasComparePairKey === key) return;

    let cancelled = false;
    setCanvasCompareLoading(true);
    (async () => {
      try {
        const [left, right] = await Promise.all([
          loadLayoutStateForVersionCompare(compareVersion1Id, currentUserId, currentTenantId),
          loadLayoutStateForVersionCompare(compareVersion2Id, currentUserId, currentTenantId),
        ]);
        if (cancelled) return;
        setCanvasCompareLeft(left);
        setCanvasCompareRight(right);
        const l = left ?? { nodes: [], edges: [] };
        const r = right ?? { nodes: [], edges: [] };
        setCanvasCompareDiff(compareLayouts(l, r));
        setCanvasComparePairKey(key);
      } catch (e) {
        console.error('Canvas compare load failed:', e);
        if (!cancelled) {
          setCanvasCompareDiff(null);
          toast.error('Could not load canvas layouts for comparison');
        }
      } finally {
        if (!cancelled) setCanvasCompareLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeCompareTab,
    diffResult.length,
    compareVersion1Id,
    compareVersion2Id,
    canvasComparePairKey,
    currentUserId,
    currentTenantId,
  ]);

  useEffect(() => { if (currentTenantId) loadProjects(); }, [currentTenantId]);

  /** Prefer `projectId` from the URL (e.g. drill-down from Projects); otherwise first project. */
  useEffect(() => {
    if (projects.length === 0) return;
    const pid = searchParams.get('projectId');
    if (pid && projects.some((p) => p.id === pid)) {
      setSelectedProjectId(pid);
      return;
    }
    setSelectedProjectId((prev) => {
      if (prev && projects.some((p) => p.id === prev)) return prev;
      // Default to the first real Project — never auto-select a catalog item (#4587).
      return projects.find((p) => isProjectPublishable(p))?.id ?? '';
    });
  }, [projects, searchParams]);

  useEffect(() => {
    if (selectedProjectId) {
      setVersionsLoaded(false);
      loadVersions();
    } else {
      setVersions([]);
      setVersionsLoaded(true);
    }
  }, [selectedProjectId, lifecycleFilter]);

  /**
   * The compatibility banner's data (HIVE-6.2): re-read when the project changes and when the
   * set of published revisions changes — a publish or unpublish — but not on every row edit.
   */
  const publishedSignature = useMemo(
    () => versions.filter((v) => v.published).map((v) => v.id).sort().join('|'),
    [versions]
  );
  useEffect(() => {
    if (!selectedProjectId) {
      setChangelogSummaries(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(selectedProjectId)}/changelogs`)
      .then((r) => r.json())
      .then((json: { success?: boolean; changelogs?: VersionChangelogSummary[] }) => {
        if (cancelled) return;
        setChangelogSummaries(json?.success && Array.isArray(json.changelogs) ? json.changelogs : null);
      })
      .catch(() => {
        if (!cancelled) setChangelogSummaries(null);
      });
    return () => {
      cancelled = true;
    };
    // `publishedSignature` is the dependency: it says which revisions have a classification.
  }, [selectedProjectId, publishedSignature]);

  useEffect(() => {
    if (!forkTargetProjectId || !showForkDialog) {
      setForkPreviewNext('');
      return;
    }
    let cancelled = false;
    fetch(`/api/versions?projectId=${forkTargetProjectId}`)
      .then((r) => r.json())
      .then((data: { success?: boolean; versions?: Array<{ version_id: string }> }) => {
        if (cancelled || !data.success || !Array.isArray(data.versions)) return;
        const list = data.versions;
        if (list.length === 0) {
          setForkPreviewNext('0.1.0');
          return;
        }
        const latest = list[0].version_id;
        const match = latest.match(/^(\d+)\.(\d+)\.(\d+)$/);
        if (!match) {
          setForkPreviewNext('0.1.0');
          return;
        }
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        const patch = parseInt(match[3], 10);
        const next =
          forkBumpStrategy === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
        setForkPreviewNext(next);
      })
      .catch(() => {
        if (!cancelled) setForkPreviewNext('');
      });
    return () => {
      cancelled = true;
    };
  }, [forkTargetProjectId, showForkDialog, forkBumpStrategy]);

  const loadBranches = async () => {
    if (!selectedProjectId) return;
    setBranchListLoading(true);
    setBranchListError(null);
    setBranchPermissionDenied(false);
    setVersionBranches([]);
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-branches`);
      if (r.status === 401 || r.status === 403) {
        setBranchPermissionDenied(true);
        setBranchListError('You do not have permission to view branch metadata for this project.');
        return;
      }
      const d = await r.json();
      if (d.success && Array.isArray(d.branches)) {
        setVersionBranches(d.branches);
      } else {
        setBranchListError(typeof d.error === 'string' ? d.error : 'Could not load branches');
      }
    } catch {
      setBranchListError('Could not load branches');
    } finally {
      setBranchListLoading(false);
    }
  };

  useEffect(() => {
    if (selectedProjectId) loadBranches();
    else setVersionBranches([]);
  }, [selectedProjectId]);

  const loadVersionTags = async () => {
    if (!selectedProjectId) return;
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-tags`);
      const d = await r.json();
      if (d.success && Array.isArray(d.tags)) setVersionTags(d.tags);
      else setVersionTags([]);
    } catch {
      setVersionTags([]);
    }
  };

  useEffect(() => {
    if (!selectedProjectId) {
      setVersionTags([]);
      setHistoryTagFilter('');
      setLifecycleFilter('');
    } else {
      setHistoryTagFilter('');
      setLifecycleFilter('');
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!currentTenantId || versions.length === 0) {
      setHasClassSchemaMap({});
      return;
    }
    const versionIds = versions.map((v) => v.id);
    const url = `/api/database/versions/has-class-schema?versionIds=${versionIds.join(',')}`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.map) setHasClassSchemaMap(data.map);
        else setHasClassSchemaMap({});
      })
      .catch(() => setHasClassSchemaMap({}));
  }, [currentTenantId, versions]);

  /**
   * Reload the tenant's projects into state.
   *
   * @returns The freshly loaded projects, or `null` when the load was skipped or failed. Callers
   *   that must inspect the result immediately (the post-import selector switch, #5260) read the
   *   return value rather than the state, which React has not committed yet.
   */
  const loadProjects = async (): Promise<Project[] | null> => {
    if (!currentTenantId) return null;
    try {
      // include_catalog: the proxy strips catalog items by default (#4587); this page needs the
      // full list — see the comment in loadProjects' success branch below.
      const response = await fetch('/api/projects?include_catalog=true');
      if (!response.ok) {
        throw new Error(`Failed to fetch projects: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.success && data.projects) {
        // The full unfiltered list (catalog items included): revision rows resolve their owning
        // project here for the publish gate (MFI-23.8) and catalog deep-links must keep working.
        // The *selector options* exclude catalog items instead — see `selectableProjects` (#4587).
        setProjects(data.projects);
        return data.projects as Project[];
      } else {
        throw new Error(data.error || 'Failed to load projects');
      }
    } catch (error) {
      console.error('Failed to load projects:', error);
      setProjects([]);
      return null;
    }
  };

  /**
   * Land an import started from this screen's header (#5260).
   *
   * A spec import creates a new project, so the selector is switched to it and its revisions load
   * through the usual `selectedProjectId` effect. When the diff cannot name a single new project —
   * the reload failed, or the import went somewhere this list does not offer (a catalog item, an MCP
   * endpoint) — the current project's revisions are refreshed instead, so an incremental import into
   * the open project still shows up without a manual reload.
   */
  const handleImportSuccess = async () => {
    const before = projects;
    const refreshed = await loadProjects();
    const imported = refreshed ? findNewlyImportedProject(before, refreshed) : null;
    if (imported) {
      handleSelectedProjectChange(imported.id);
      toast.success(`Imported "${imported.name}" — showing its revisions`);
      return;
    }
    if (selectedProjectId) await loadVersions();
  };

  const loadVersions = async (): Promise<boolean> => {
    if (!selectedProjectId) return false;
    try {
      const qs = new URLSearchParams({ projectId: selectedProjectId });
      if (lifecycleFilter) qs.set('lifecycle', lifecycleFilter);
      const response = await fetch(`/api/versions?${qs.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch versions: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.success && data.versions) {
        setVersions(data.versions);
        await loadVersionTags();
        return true;
      } else {
        throw new Error(data.error || 'Failed to load versions');
      }
    } catch (error) {
      console.error('Failed to load versions:', error);
      setVersions([]);
      return false;
    } finally {
      setVersionsLoaded(true);
    }
  };

  const handleVersionsPullReconcile = async () => {
    if (!selectedProjectId) return;
    setVersionsPullBannerLoading(true);
    try {
      const ok = await loadVersions();
      if (ok) {
        clearPushConflict();
        toast.success('Version list refreshed. Update your commit base from the latest revision, then try again.');
      } else {
        toast.error('Failed to refresh versions. Please try again.');
      }
    } finally {
      setVersionsPullBannerLoading(false);
    }
  };

  const handleVersionsOpenMerge = () => {
    setMergeSourceBranch('');
    setMergeTargetBranch('');
    setMergePreviewData(null);
    setMergeCompat(null);
    setShowMergeDialog(true);
  };

  useEffect(() => {
    if (typeof window === 'undefined' || projects.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('merge') !== '1') return;
    const pid = params.get('projectId');
    if (pid && projects.some((p) => p.id === pid)) {
      setSelectedProjectId(pid);
    }
    setMergeSourceBranch('');
    setMergeTargetBranch('');
    setMergePreviewData(null);
    setMergeCompat(null);
    setShowMergeDialog(true);
    params.delete('merge');
    params.delete('projectId');
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [projects]);

  const calculateNextVersion = (strategy: 'patch' | 'minor' = 'patch'): string => {
    if (versions.length === 0) return '0.1.0';
    const latestVersion = versions[0].version_id;
    const match = latestVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return '0.1.0';
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    const patch = parseInt(match[3], 10);
    return strategy === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  };

  const handleNewVersionClick = () => {
    setVersionId(''); setAutoGenerate(true); setBumpStrategy('minor');
    setNextAutoVersion(calculateNextVersion('minor')); setDescription('');
    setChangeLog(''); setCommitExternalRef(''); setEnabled(true); setSourceVersionId('');
    setCopySourceBranchKey('blank');
    setErrorMessage(''); setBranchListError(null);
    void loadBranches();
    setShowCreateDialog(true);
  };

  const createCommitMessageCheck = validateVersionNotesClient(description, '');
  const commitChangelogOverLimit = changeLog.trim().length > VERSION_NOTES_LIMITS.maxChangelogChars;
  const commitExternalRefTrim = commitExternalRef.trim();
  const createCommitFormValid =
    createCommitMessageCheck.ok &&
    !commitChangelogOverLimit &&
    commitExternalRefTrim.length <= COMMIT_EXTERNAL_REF_MAX_CHARS &&
    (autoGenerate || versionId.trim().length > 0);

  const handleCreateSubmit = async () => {
    if (!autoGenerate && !versionId.trim()) { setErrorMessage('Version ID is required when not auto-generating'); return; }
    const notesCheck = validateVersionNotesClient(description, changeLog);
    if (!notesCheck.ok) { setErrorMessage(notesCheck.error); return; }
    if (commitExternalRefTrim.length > COMMIT_EXTERNAL_REF_MAX_CHARS) {
      setErrorMessage(`External reference must be at most ${COMMIT_EXTERNAL_REF_MAX_CHARS} characters`);
      return;
    }

    let baseRevisionId = '';
    let branchName: string | undefined;
    if (versionBranches.length > 1) {
      if (copySourceBranchKey === 'blank') {
        const msg =
          'Select a branch line to push to (choose a branch tip or copy from a branch).';
        setErrorMessage(msg);
        toast.error(msg);
        return;
      }
      if (!copySourceBranchKey.startsWith('branch:')) {
        const msg = 'Select a valid branch.';
        setErrorMessage(msg);
        toast.error(msg);
        return;
      }
      const bid = copySourceBranchKey.slice('branch:'.length);
      const br = versionBranches.find((b) => b.id === bid);
      if (!br?.tip_version_id) {
        const msg = 'Could not resolve branch tip for push.';
        setErrorMessage(msg);
        toast.error(msg);
        return;
      }
      baseRevisionId = br.tip_version_id;
      branchName = br.name;
    } else if (versionBranches.length === 1) {
      baseRevisionId = versionBranches[0].tip_version_id;
      branchName = versionBranches[0].name;
    } else {
      // No named branches: fetch the unfiltered head so lifecycle filtering on the
      // current view doesn't cause a false STALE_HEAD when versions[0] is not the
      // true project head.
      try {
        const headRes = await fetch(`/api/versions?projectId=${encodeURIComponent(selectedProjectId)}`);
        const headJson = (await headRes.json()) as {
          success?: boolean;
          error?: string;
          versions?: Array<{ id?: string }>;
        };
        if (!headRes.ok || !headJson.success) {
          const msg =
            typeof headJson.error === 'string'
              ? headJson.error
              : 'Could not resolve latest revision for push.';
          setErrorMessage(msg);
          toast.error(msg);
          return;
        }
        baseRevisionId = headJson.versions?.[0]?.id ?? '';
      } catch {
        const msg = 'Network error: could not resolve latest revision for push.';
        setErrorMessage(msg);
        toast.error(msg);
        return;
      }
    }

    setIsLoading(true); setErrorMessage('');
    try {
      const body: Record<string, unknown> = {
        projectId: selectedProjectId,
        shortMessage: description.trim(),
        changelog: changeLog.trim() || null,
        baseRevisionId,
      };
      if (branchName) body.branchName = branchName;
      if (commitExternalRefTrim) body.externalRef = commitExternalRefTrim;
      if (!autoGenerate) body.version_id = versionId.trim();
      if (autoGenerate) body.bump_strategy = bumpStrategy;
      if (sourceVersionId?.trim()) body.source_version_id = sourceVersionId.trim();

      const res = await fetch('/api/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        code?: string;
        version?: { copied_classes?: number; copy_warning?: string };
      };
      if (!res.ok || !json.success) {
        if (res.status === 409) {
          const stale = parseStaleHeadFromVersionsPostJson(json, res.status);
          if (stale && selectedProjectId) {
            setPushConflictFrom409({
              projectId: selectedProjectId,
              message: stale.message,
              currentHeadRevisionId: stale.currentHeadRevisionId,
              currentHead: stale.currentHead
                ? {
                    revisionId:
                      typeof stale.currentHead.revisionId === 'string'
                        ? stale.currentHead.revisionId
                        : undefined,
                    versionId:
                      typeof stale.currentHead.versionId === 'string'
                        ? stale.currentHead.versionId
                        : undefined,
                    shortMessage:
                      typeof stale.currentHead.shortMessage === 'string'
                        ? stale.currentHead.shortMessage
                        : null,
                    createdAt:
                      typeof stale.currentHead.createdAt === 'string'
                        ? stale.currentHead.createdAt
                        : null,
                  }
                : null,
            });
          }
        }
        const err = typeof json.error === 'string' ? json.error : 'Failed to create version';
        setErrorMessage(err);
        toast.error(err);
        return;
      }
      setShowCreateDialog(false);
      clearPushConflict();
      await loadVersions();
      const v = json.version;
      const successNoun = 'Version created';
      if (v && typeof v.copied_classes === 'number' && v.copied_classes > 0) {
        toast.success(`${successNoun}. Copied ${v.copied_classes} class(es).`);
      } else if (v?.copy_warning) {
        toast.warning(`${successNoun}, but: ${v.copy_warning}`);
      } else {
        toast.success(`${successNoun}.`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'An error occurred';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const populateVersionEditForm = useCallback(
    (version: Version, options?: { defaultSuccessorRevisionId?: string | null }) => {
      const meta = version.metadata ?? {};
      setEditDeprecationMessage(
        typeof meta.deprecationMessage === 'string'
          ? meta.deprecationMessage
          : typeof meta.message === 'string'
            ? meta.message
            : '',
      );
      const sunsetRaw =
        typeof meta.sunsetAt === 'string'
          ? meta.sunsetAt
          : typeof meta.sunsetDate === 'string'
            ? meta.sunsetDate
            : typeof meta.sunset_date === 'string'
              ? meta.sunset_date
              : '';
      setEditSunsetLocal(sunsetRaw ? utcIsoToDatetimeLocalValue(sunsetRaw) : '');
      const fromMetaSuccessor =
        typeof meta.successorRevisionId === 'string'
          ? meta.successorRevisionId
          : typeof meta.successor_revision_id === 'string'
            ? meta.successor_revision_id
            : '';
      let successor = fromMetaSuccessor;
      if (
        !successor.trim() &&
        options?.defaultSuccessorRevisionId &&
        options.defaultSuccessorRevisionId !== version.id
      ) {
        successor = options.defaultSuccessorRevisionId;
      }
      setEditSuccessorRevisionId(successor);
      setEditPublishedMetadataOnly(Boolean(version.published && effectiveIsAdmin));
      setSelectedVersion(version);
      setVersionId(version.version_id);
      setDescription(version.shortMessage || '');
      setChangeLog(version.changelog || '');
      setEnabled(version.enabled);
      setEditLifecycle(version.lifecycle ?? 'stable');
    },
    [effectiveIsAdmin],
  );

  const handleEditClick = (version: Version) => {
    if (version.published && !effectiveIsAdmin) {
      setErrorMessage('Cannot edit published version');
      return;
    }
    const lc = version.lifecycle ?? 'stable';
    if (lc === 'archived' && !effectiveIsAdmin) {
      toast.warning('Archived revisions are read-only.');
      return;
    }
    populateVersionEditForm(version);
    setErrorMessage('');
    setShowSunsetScheduleDialog(false);
    setShowEditDialog(true);
  };

  const handleOpenSunsetSchedule = (version: Version) => {
    if (version.published && !effectiveIsAdmin) {
      toast.error('Only a tenant admin can set sunset metadata on a published revision.');
      return;
    }
    const lc = version.lifecycle ?? 'stable';
    if (lc === 'archived' && !effectiveIsAdmin) {
      toast.warning('Archived revisions are read-only.');
      return;
    }
    const headId = projectHeadRevisionId(versions);
    populateVersionEditForm(version, { defaultSuccessorRevisionId: headId });
    setErrorMessage('');
    setShowEditDialog(false);
    setShowSunsetScheduleDialog(true);
  };

  const performVersionUpdateSave = async (): Promise<boolean> => {
    if (!selectedVersion) return false;
    const prevMeta = { ...(selectedVersion.metadata ?? {}) };
    const metadata: Record<string, unknown> = { ...prevMeta };
    metadata.lifecycle = editLifecycle;
    if (editDeprecationMessage.trim()) {
      metadata.deprecationMessage = editDeprecationMessage.trim();
    } else {
      delete metadata.deprecationMessage;
    }
    if (editSunsetLocal.trim()) {
      const iso = localDatetimeLocalToUtcIso(editSunsetLocal.trim());
      if (!iso) {
        setErrorMessage('Invalid sunset date/time');
        return false;
      }
      metadata.sunsetAt = iso;
    } else {
      metadata.sunsetAt = null;
      metadata.sunsetDate = null;
    }
    if (editSuccessorRevisionId.trim()) {
      metadata.successorRevisionId = editSuccessorRevisionId.trim();
    } else {
      metadata.successorRevisionId = null;
    }

    const body: Record<string, unknown> = {
      projectId: selectedProjectId,
    };
    if (editPublishedMetadataOnly) {
      body.metadata = metadata;
    } else {
      body.shortMessage = description.trim();
      body.changelog = changeLog.trim() || null;
      body.enabled = enabled;
      body.metadata = metadata;
    }
    try {
      const res = await fetch(`/api/versions/${selectedVersion.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        await loadVersions();
        return true;
      }
      setErrorMessage(typeof data.error === 'string' ? data.error : 'Failed to update version');
      return false;
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'An error occurred');
      return false;
    }
  };

  const runEditVersionValidations = (options?: { requireSunsetDatetime?: boolean }): boolean => {
    if (!selectedVersion) return false;
    if (!editPublishedMetadataOnly) {
      const notesCheck = validateVersionNotesClient(description, changeLog);
      if (!notesCheck.ok) {
        setErrorMessage(notesCheck.error);
        return false;
      }
    }
    const isArchived = (selectedVersion.lifecycle ?? 'stable') === 'archived';
    if (isArchived && !effectiveIsAdmin) return false;
    if (options?.requireSunsetDatetime) {
      if (!editSunsetLocal.trim()) {
        setErrorMessage('Sunset date and time are required.');
        return false;
      }
      const isoProbe = localDatetimeLocalToUtcIso(editSunsetLocal.trim());
      if (!isoProbe) {
        setErrorMessage('Invalid sunset date/time');
        return false;
      }
    }
    if (editSunsetLocal.trim()) {
      if (editLifecycle !== 'deprecated') {
        setErrorMessage('Set lifecycle to Deprecated when scheduling a sunset.');
        return false;
      }
    }
    return true;
  };

  const handleEditSubmit = async () => {
    if (!selectedVersion) return;
    if (!runEditVersionValidations()) return;
    setIsLoading(true);
    setErrorMessage('');
    try {
      const ok = await performVersionUpdateSave();
      if (ok) setShowEditDialog(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSunsetScheduleSubmit = async () => {
    if (!selectedVersion) return;
    if (!runEditVersionValidations({ requireSunsetDatetime: true })) return;
    setIsLoading(true);
    setErrorMessage('');
    try {
      const ok = await performVersionUpdateSave();
      if (ok) {
        setShowSunsetScheduleDialog(false);
        toast.success('Sunset schedule saved.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handlePublishClick = (versionRecordId: string) => {
    const ver = versions.find(v => v.id === versionRecordId);
    if (!ver) return;
    // Catalog items (non-publishable projects, MFI-23.1) are never publish candidates (MFI-23.8,
    // #4017): never open the publish dialog for one, even if reached defensively.
    if (!isVersionPublishable(ver)) {
      toast.warning('Catalog items cannot be published. Convert to OpenAPI to create a publishable project.');
      return;
    }
    if (ver.creator_id !== currentUserId && !effectiveIsAdmin) return;
    setPublishVersionId(versionRecordId);
    setPublishVisibility('private');
    setPublishShortMessage(ver.shortMessage?.trim() ?? '');
    setPublishChangelog(ver.changelog?.trim() ?? '');
    setPublishChangeReportBaselineMode('auto');
    setPublishManualBaselineRevisionId('');
    setPublishForce(false);
    setPublishForceReason('');
    setPublishLintReport(null);
    setPublishVerificationDecision(null);
    setPublishBreakingGuardrail(null);
    setPublishPreview(null);
    setPublishPreviewError(null);
    setShowPublishDialog(true);
  };

  const publishManualBaselineOptions = useMemo(() => {
    if (!publishVersionId) return [];
    const subject = versions.find((x) => x.id === publishVersionId);
    if (!subject) return [];
    return versions
      .filter((v) => v.published && v.project_id === subject.project_id && v.id !== publishVersionId)
      .sort((a, b) => b.version_id.localeCompare(a.version_id, undefined, { numeric: true }));
  }, [versions, publishVersionId]);

  const loadPublishPreview = useCallback(async () => {
    if (!changeReportUiEnabled || !publishVersionId) return;
    const version = versions.find((v) => v.id === publishVersionId);
    if (!version) return;
    if (publishChangeReportBaselineMode === 'manual' && !publishManualBaselineRevisionId.trim()) {
      setPublishPreview(null);
      setPublishPreviewError(null);
      return;
    }
    setPublishPreviewLoading(true);
    setPublishPreviewError(null);
    try {
      const body: Record<string, unknown> = {
        projectId: version.project_id,
        changeReportBaselineMode: publishChangeReportBaselineMode,
      };
      if (publishChangeReportBaselineMode === 'manual') {
        body.changeReportBaselineRevisionId = publishManualBaselineRevisionId.trim();
      }
      const res = await fetch(
        `/api/versions/${encodeURIComponent(publishVersionId)}/change-report/publish-preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        preview?: {
          headerSnapshot?: string;
          renderedBody?: string;
          footnoteSnapshot?: string;
          initialPublication?: boolean;
          fromVersionLabel?: string;
          toVersionLabel?: string;
        };
      };
      if (!json.success || !json.preview) {
        setPublishPreview(null);
        setPublishPreviewError(typeof json.error === 'string' ? json.error : 'Preview failed');
        return;
      }
      const p = json.preview;
      setPublishPreview({
        headerSnapshot: p.headerSnapshot ?? '',
        renderedBody: p.renderedBody ?? '',
        footnoteSnapshot: p.footnoteSnapshot ?? '',
        initialPublication: p.initialPublication,
        fromVersionLabel: p.fromVersionLabel,
        toVersionLabel: p.toVersionLabel,
      });
    } catch (e) {
      setPublishPreview(null);
      setPublishPreviewError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPublishPreviewLoading(false);
    }
  }, [
    changeReportUiEnabled,
    publishVersionId,
    versions,
    publishChangeReportBaselineMode,
    publishManualBaselineRevisionId,
  ]);

  useEffect(() => {
    if (!showPublishDialog || !publishVersionId || !changeReportUiEnabled) return;
    void loadPublishPreview();
  }, [showPublishDialog, publishVersionId, changeReportUiEnabled, loadPublishPreview]);

  useEffect(() => {
    if (publishChangeReportBaselineMode !== 'manual' || publishManualBaselineOptions.length === 0) return;
    if (!publishManualBaselineOptions.some((o) => o.id === publishManualBaselineRevisionId)) {
      setPublishManualBaselineRevisionId(publishManualBaselineOptions[0].id);
    }
  }, [publishChangeReportBaselineMode, publishManualBaselineOptions, publishManualBaselineRevisionId]);

  const publishLintErrorCount = publishLintReport?.severityCounts?.error ?? 0;
  const publishBlockedByGuideErrors = publishLintErrorCount > 0 && !publishForce;
  const publishBlockedByVerificationPolicy =
    !!publishVerificationDecision &&
    publishVerificationDecision.enforcement === 'block' &&
    !publishVerificationDecision.passed &&
    !publishForce;
  const publishBlockedByBreakingGuardrail = guardrailBlocksPublish(
    publishBreakingGuardrail,
    publishForce,
  );
  const publishForceReasonMissing = publishForce && !publishForceReason.trim();

  const handlePublishConfirm = async () => {
    if (!publishVersionId) return;
    const version = versions.find((v) => v.id === publishVersionId);
    if (!version) {
      await alertDialog({ message: 'Version not found', variant: 'error' });
      return;
    }
    const notesCheck = validateVersionNotesClient(publishShortMessage, publishChangelog);
    if (!notesCheck.ok) {
      await alertDialog({ message: notesCheck.error, variant: 'error' });
      return;
    }
    if (
      changeReportUiEnabled &&
      publishChangeReportBaselineMode === 'manual' &&
      !publishManualBaselineRevisionId.trim()
    ) {
      await alertDialog({
        message: 'Select a published revision to compare against, or choose another baseline mode.',
        variant: 'error',
      });
      return;
    }
    if (publishForceReasonMissing) {
      await alertDialog({
        message: 'Enter a reason for force publishing — it is recorded in the audit trail.',
        variant: 'error',
      });
      return;
    }
    if (publishBlockedByGuideErrors) {
      await alertDialog({
        message: 'Resolve style-guide error violations or enable force publish with a reason.',
        variant: 'error',
      });
      return;
    }
    if (publishBlockedByVerificationPolicy) {
      await alertDialog({
        message:
          'Resolve verification-policy gates or enable force publish with a reason.',
        variant: 'error',
      });
      return;
    }
    if (publishBlockedByBreakingGuardrail) {
      await alertDialog({
        message:
          `This revision has breaking changes without a major-version bump. Publish as ` +
          `${publishBreakingGuardrail?.recommendedVersion ?? 'the next major version'} ` +
          'or enable force publish with a reason.',
        variant: 'error',
      });
      return;
    }
    try {
      const res = await fetch(`/api/versions/${publishVersionId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: version.project_id,
          visibility: publishVisibility,
          shortMessage: publishShortMessage.trim(),
          changelog: publishChangelog.trim() || null,
          ...(publishForce
            ? { skipPublishChecks: true, forcePublishReason: publishForceReason.trim() }
            : {}),
          ...(changeReportUiEnabled
            ? {
                changeReportBaselineMode: publishChangeReportBaselineMode,
                ...(publishChangeReportBaselineMode === 'manual' && publishManualBaselineRevisionId.trim()
                  ? { changeReportBaselineRevisionId: publishManualBaselineRevisionId.trim() }
                  : {}),
              }
            : {}),
        }),
      });
      const response = await res.json();
      if (response.success) {
        setShowPublishDialog(false);
        setPublishVersionId(null);
        await loadVersions();
      } else {
        await alertDialog({ message: response.error || 'Failed to publish', variant: 'error' });
      }
    } catch (error: unknown) {
      await alertDialog({ message: error instanceof Error ? error.message : 'An error occurred', variant: 'error' });
    }
  };

  const handleUnpublish = async (versionRecordId: string) => {
    const ver = versions.find((v) => v.id === versionRecordId);
    if (!ver) { await alertDialog({ message: 'Version not found', variant: 'error' }); return; }
    if (ver.creator_id !== currentUserId && !effectiveIsAdmin) { toast.warning('Only owner or admin can unpublish'); return; }
    const confirmed = await confirmDialog(unpublishVersionConfirm(ver));
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/versions/${versionRecordId}/unpublish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: ver.project_id }),
      });
      const response = await res.json();
      if (response.success) await loadVersions();
      else await alertDialog({ message: response.error || 'Failed to unpublish', variant: 'error' });
    } catch (error: unknown) { await alertDialog({ message: error instanceof Error ? error.message : 'An error occurred', variant: 'error' }); }
  };

  const handleFreezeSchema = async (version: Version) => {
    if (version.creator_id !== currentUserId && !effectiveIsAdmin) {
      toast.warning('Only the version owner or a tenant admin can freeze schema.');
      return;
    }
    if (hasClassSchemaMap[version.id]) {
      toast.info('Schema is already frozen for this version.');
      return;
    }
    const confirmed = await confirmDialog(freezeSchemaConfirm(version));
    if (!confirmed) return;
    setFreezingSchemaVersionId(version.id);
    try {
      const res = await fetch(`/api/versions/${version.id}/freeze-schema`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: version.project_id }),
      });
      const response = await res.json();
      if (response.success) {
        await loadVersions();
        toast.success('Schema frozen successfully. This version can now be used in the Database section.');
      } else {
        await alertDialog({ message: response.error || 'Failed to freeze schema', variant: 'error' });
      }
    } catch (error: unknown) {
      await alertDialog({ message: error instanceof Error ? error.message : 'An error occurred', variant: 'error' });
    } finally {
      setFreezingSchemaVersionId(null);
    }
  };

  const handleDelete = async (versionRecordId: string) => {
    const target = versions.find((v) => v.id === versionRecordId);
    const confirmed = await confirmDialog(
      deleteVersionConfirm(target ?? { version_id: versionRecordId.slice(0, 8) })
    );
    if (!confirmed) return;
    try {
      const result = await deleteVersion(versionRecordId);
      const response = JSON.parse(result) as { success?: boolean; error?: string; code?: string };
      if (response.success) await loadVersions();
      else {
        const msg =
          response.code === 'REVISION_LOCKED'
            ? 'This revision is locked by policy and cannot be deleted (tenant admins may override).'
            : response.error || 'Failed to delete';
        await alertDialog({ message: msg, variant: 'error' });
      }
    } catch (error: unknown) {
      await alertDialog({ message: error instanceof Error && error.message ? error.message : 'An error occurred', variant: 'error' });
    }
  };

  const handleViewOpenApi = async (version: Version) => {
    setViewingVersion(version); setShowOpenApiDialog(true); setIsLoadingSpec(true); setOpenApiFormat('json');
    try {
      const project = projects.find(p => p.id === version.project_id);
      const spec = await buildOpenApiSpecJsonForVersion(
        version,
        project?.name ?? null,
        coerceProjectMetadataRecord((project as { metadata?: unknown })?.metadata)
      );
      setOpenApiSpec(spec);
    } catch { setOpenApiSpec(JSON.stringify({ openapi: '3.1.0', info: { title: 'Error Loading Spec', version: version.version_id }, components: { schemas: {} } }, null, 2)); }
    finally { setIsLoadingSpec(false); }
  };

  const handleShowRelationshipGraph = async (version: Version) => {
    setRelationshipGraphVersion(version);
    setShowRelationshipGraphDialog(true);
    setIsLoadingRelationshipGraph(true);
    setRelationshipGraphClasses(null);
    try {
      const classesResult = await getClassesForVersion(version.id);
      const classesData = JSON.parse(classesResult) as Array<{ id: string; name: string }>;
      const classesWithProperties = await Promise.all(classesData.map(async (cls) => {
        const propsResult = await getPropertiesForClass(cls.id);
        return { ...cls, properties: JSON.parse(propsResult) };
      }));
      setRelationshipGraphClasses(classesWithProperties);
    } catch {
      setRelationshipGraphClasses([]);
    } finally {
      setIsLoadingRelationshipGraph(false);
    }
  };

  const loadVersionSpec = async (versionId: string): Promise<string> => {
    const version = versions.find(v => v.id === versionId);
    if (!version) throw new Error('Version not found');
    const project = projects.find(p => p.id === version.project_id);
    return buildOpenApiSpecJsonForVersion(
      version,
      project?.name ?? null,
      coerceProjectMetadataRecord((project as { metadata?: unknown })?.metadata)
    );
  };

  /**
   * Best-effort fetch of the stored publish-time classification for the head of a
   * compared pair. Badges only render when the stored baseline matches the pair's
   * base (CTG-3.2, #4476); missing rows (404) are a normal state, not an error.
   */
  const loadStoredChangelogForPair = async (baseId: string, targetId: string) => {
    const head = versions.find((v) => v.id === targetId);
    const projectId = head?.project_id ?? selectedProjectId;
    if (!projectId || !head?.published) return;
    try {
      const qs = new URLSearchParams({ projectId });
      const res = await fetch(`/api/versions/${encodeURIComponent(targetId)}/changelog?${qs.toString()}`);
      const json = (await res.json()) as { success?: boolean; changelog?: VersionChangelog };
      const stored = json?.success && json.changelog ? json.changelog : null;
      setCompareStoredChangelog(
        changelogMatchesComparedPair(stored, baseId, targetId) ? stored : null,
      );
    } catch {
      setCompareStoredChangelog(null);
    }
  };

  const runCompareBetween = async (baseId: string, targetId: string) => {
    if (!baseId || !targetId) {
      toast.warning('Please select two versions');
      return;
    }
    if (baseId === targetId) {
      toast.warning('Select two different versions');
      return;
    }
    setDiffResult([]);
    setSchemaDiffSummary(null);
    setClassDiffRows(null);
    setCompareStoredChangelog(null);
    setCanvasCompareLeft(null);
    setCanvasCompareRight(null);
    setCanvasCompareDiff(null);
    setCanvasComparePairKey('');
    setIsLoadingComparison(true);
    void loadStoredChangelogForPair(baseId, targetId);
    try {
      const [spec1, spec2] = await Promise.all([loadVersionSpec(baseId), loadVersionSpec(targetId)]);
      setCompareSpec1(spec1);
      setCompareSpec2(spec2);
      const diffSummary = compareSchemas(spec1, spec2);
      setSchemaDiffSummary(diffSummary);
      setClassDiffRows(buildClassLevelDiff(spec1, spec2));
      const content1 = compareFormat === 'json' ? spec1 : YAML.stringify(JSON.parse(spec1));
      const content2 = compareFormat === 'json' ? spec2 : YAML.stringify(JSON.parse(spec2));
      setDiffResult(diffLines(content1, content2));
    } catch (error) {
      console.error('Comparison error:', error);
      await alertDialog({ message: 'Failed to load specs for comparison', variant: 'error' });
    } finally {
      setIsLoadingComparison(false);
    }
  };

  const runCompareBetweenRef = useRef(runCompareBetween);
  runCompareBetweenRef.current = runCompareBetween;

  /** Deep link from canvas divergence chip: compareOpen=1&compareBase=&compareHead= (#2723). */
  useEffect(() => {
    if (typeof window === 'undefined' || projects.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('compareOpen') !== '1') return;
    const compareBase = params.get('compareBase');
    const compareHead = params.get('compareHead');
    /** Optional changelog JSON Pointer to focus inside the diff (CTG-3.2, #4476). */
    const comparePointer = params.get('comparePointer');
    if (!compareBase?.trim() || !compareHead?.trim()) return;
    if (compareBase.trim() === compareHead.trim()) return;
    const pid = params.get('projectId');
    if (pid && projects.some((p) => p.id === pid) && selectedProjectId !== pid) {
      setSelectedProjectId(pid);
      return;
    }
    if (!selectedProjectId) return;
    if (versions.length === 0 || versions[0]?.project_id !== selectedProjectId) return;

    const b = compareBase.trim();
    const h = compareHead.trim();
    const hasBase = versions.some((v) => v.id === b);
    const hasHead = versions.some((v) => v.id === h);

    params.delete('compareOpen');
    params.delete('compareBase');
    params.delete('compareHead');
    params.delete('comparePointer');
    if (pid) params.delete('projectId');
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);

    if (!hasBase || !hasHead) {
      toast.warning('Compare link referred to revisions that are not in the loaded list. Refresh the timeline.');
      return;
    }

    setCompareVersion1Id(b);
    setCompareVersion2Id(h);
    setCompareBaseTagId('');
    setCompareToTagId('');
    if (comparePointer?.trim()) {
      setCompareFocusPointer(comparePointer.trim());
    }
    setActiveCompareTab('diff');
    setShowCompareDialog(true);
    void runCompareBetweenRef.current?.(b, h);
  }, [projects, selectedProjectId, versions]);

  /** Latest revision by `created_at` in the loaded list — used as “current” for compare (#2580). */
  const headRevisionId = useMemo(() => projectHeadRevisionId(versions), [versions]);

  // ---- what the header and the banners say (HIVE-6.2) — derived, never fetched ----------------
  const headBadge = useMemo(() => headRevisionBadge(versions, headRevisionId), [versions, headRevisionId]);
  const headQuality = useMemo(
    () => storedQualityBadge(versions.find((v) => v.id === headRevisionId)),
    [versions, headRevisionId]
  );
  const headLine = useMemo(() => versionsHeadLine(versions, headRevisionId), [versions, headRevisionId]);
  const compatBanner = useMemo(
    () => compatibilityBanner(newestPublishedSummary(changelogSummaries, versions)),
    [changelogSummaries, versions]
  );
  const whatsNew = useMemo(() => whatsNewBanner(versions, headRevisionId), [versions, headRevisionId]);
  const deprecation = useMemo(() => deprecationBanner(versions), [versions]);

  /** Other revisions in the same project (for successor picker — labels are version IDs, values are revision UUIDs). */
  const successorCandidates = useMemo(() => {
    const sv = selectedVersion;
    if (!sv) return [];
    return versions
      .filter((v) => v.project_id === sv.project_id && v.id !== sv.id)
      .sort((a, b) => b.version_id.localeCompare(a.version_id, undefined, { numeric: true }));
  }, [versions, selectedVersion]);

  const handleCompareVersions = async () => {
    await runCompareBetween(compareVersion1Id, compareVersion2Id);
  };

  /** Deep link from the Changes tab: open the diff for the classified pair at a changelog pointer (CTG-3.2, #4476). */
  const handleOpenDiffFromChanges = async (baseId: string, headId: string, pointer: string) => {
    setCompareBaseTagId('');
    setCompareToTagId('');
    setCompareVersion1Id(baseId);
    setCompareVersion2Id(headId);
    setCompareFocusPointer(pointer);
    setActiveCompareTab('diff');
    setShowCompareDialog(true);
    await runCompareBetween(baseId, headId);
  };

  /**
   * Resolve a pending changelog deep link once the comparison is loaded: schema
   * pointers land on the expanded class row in "Schema Changes" (expansion turns
   * off list virtualization, so the row is in the DOM); everything else falls
   * back to the text diff tab.
   */
  useEffect(() => {
    if (!compareFocusPointer || !showCompareDialog || isLoadingComparison || diffResult.length === 0) {
      return;
    }
    const pointer = compareFocusPointer;
    setCompareFocusPointer(null);
    const stableId = stableIdForPointer(pointer);
    if (stableId && classDiffRows?.some((r) => r.stableId === stableId)) {
      setActiveCompareTab('summary');
      setClassDiffSearch('');
      setClassDiffShowUnchanged(true);
      setExpandedClassDiffId(stableId);
      window.setTimeout(() => {
        document
          .getElementById(`class-diff-row-${stableId}`)
          ?.scrollIntoView({ block: 'center' });
      }, 120);
    } else {
      setActiveCompareTab('diff');
    }
  }, [compareFocusPointer, showCompareDialog, isLoadingComparison, diffResult, classDiffRows]);

  const handleHistoryGraphCompareToParent = async (revisionId: string) => {
    const v = versions.find((x) => x.id === revisionId);
    if (!v?.parent_version_id?.trim()) {
      toast.info('This revision has no primary parent to compare against.');
      return;
    }
    setCompareVersion1Id(v.parent_version_id);
    setCompareVersion2Id(v.id);
    setShowCompareDialog(true);
    await runCompareBetween(v.parent_version_id, v.id);
  };

  /** Diff selected revision (base) → project head (current); closing the dialog leaves timeline filters intact (#2580). */
  const handleCompareWithCurrent = async (revisionId: string) => {
    const headId = headRevisionId;
    if (!headId) {
      toast.warning('No revisions loaded.');
      return;
    }
    if (revisionId === headId) {
      toast.info('This revision is already the project head (current).');
      return;
    }
    setCompareBaseTagId('');
    setCompareToTagId('');
    setCompareVersion1Id(revisionId);
    setCompareVersion2Id(headId);
    setActiveCompareTab('diff');
    setShowCompareDialog(true);
    await runCompareBetween(revisionId, headId);
  };

  const handleHistoryGraphViewSpec = async (revisionId: string) => {
    const v = versions.find((x) => x.id === revisionId);
    if (!v) return;
    await handleViewOpenApi(v);
  };

  const handleCompareDialogOpen = () => {
    setShowCompareDialog(true); setCompareVersion1Id(''); setCompareVersion2Id('');
    setCompareSpec1(''); setCompareSpec2(''); setCompareFormat('json');
    setDiffResult([]); setSchemaDiffSummary(null); setClassDiffRows(null);
    setCompareStoredChangelog(null); setCompareFocusPointer(null);
    setClassDiffSearch(''); setClassDiffShowUnchanged(true); setExpandedClassDiffId(null);
    setPropDrillShowAllByClass({});
    setClassListScrollTop(0); setDiffViewMode('overlay');
    setCompareBaseTagId(''); setCompareToTagId('');
    setCanvasCompareLeft(null);
    setCanvasCompareRight(null);
    setCanvasCompareDiff(null);
    setCanvasComparePairKey('');
    setCanvasCompareViewMode('split');
    setActiveCompareTab('diff');
  };

  const tagsByVersionId = useMemo(() => {
    const map = new Map<string, VersionTagRow[]>();
    for (const t of versionTags) {
      const list = map.get(t.version_id) ?? [];
      list.push(t);
      map.set(t.version_id, list);
    }
    return map;
  }, [versionTags]);

  const CLASS_DIFF_ROW_PX = 40;
  const CLASS_DIFF_VIEWPORT_PX = 288;
  const CLASS_PROP_DRILL_LIMIT = 64;

  const mergeConflictRows = useMemo(
    () =>
      normalizeMergeConflictRows(
        mergePreviewData?.conflicts,
        mergePreviewData?.classification?.conflictPaths ?? []
      ),
    [mergePreviewData?.conflicts, mergePreviewData?.classification?.conflictPaths]
  );

  const mergePreviewMatchesBranches = useMemo(() => {
    if (!mergePreviewData?.previewSourceBranch || !mergePreviewData?.previewTargetBranch) return false;
    return (
      mergePreviewData.previewSourceBranch === mergeSourceBranch.trim() &&
      mergePreviewData.previewTargetBranch === mergeTargetBranch.trim()
    );
  }, [mergePreviewData, mergeSourceBranch, mergeTargetBranch]);

  const mergeHasEngineConflicts = Boolean(
    mergePreviewData?.classification && !mergePreviewData.classification.canAutoMerge
  );

  const mergeApplyBlockedByUnresolvedChoices = useMemo(() => {
    if (!mergeHasEngineConflicts || mergeConflictRows.length === 0) return false;
    return mergeConflictRows.some((r) => {
      const c = mergeConflictResolutions[r.path];
      return c !== 'mine' && c !== 'theirs' && c !== 'manual';
    });
  }, [mergeHasEngineConflicts, mergeConflictRows, mergeConflictResolutions]);

  const mergeApplyBlockedByEngineWithoutRows = Boolean(
    mergeHasEngineConflicts && mergeConflictRows.length === 0
  );

  const mergeUnresolvedChoiceCount = useMemo(() => {
    if (!mergeHasEngineConflicts || mergeConflictRows.length === 0) return 0;
    return mergeConflictRows.filter((r) => {
      const c = mergeConflictResolutions[r.path];
      return c !== 'mine' && c !== 'theirs' && c !== 'manual';
    }).length;
  }, [mergeHasEngineConflicts, mergeConflictRows, mergeConflictResolutions]);

  const handleMergeConflictResolve = useCallback((path: string, choice: MergeConflictResolutionChoice) => {
    setMergeConflictResolutions((prev) => ({ ...prev, [path]: choice }));
  }, []);

  const handleMergeConflictBulkResolve = useCallback(
    (paths: string[], choice: MergeConflictResolutionChoice) => {
      if (paths.length === 0) return;
      setMergeConflictResolutions((prev) => {
        const next = { ...prev };
        for (const p of paths) {
          next[p] = choice;
        }
        return next;
      });
    },
    []
  );

  const filteredClassDiffRows = useMemo(() => {
    if (!classDiffRows) return [];
    let rows = classDiffRows;
    if (!classDiffShowUnchanged) rows = rows.filter((r) => r.status !== 'unchanged');
    const q = classDiffSearch.trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.stableId.toLowerCase().includes(q));
    return rows;
  }, [classDiffRows, classDiffSearch, classDiffShowUnchanged]);

  useEffect(() => {
    setClassListScrollTop(0);
    if (classListScrollRef.current) {
      classListScrollRef.current.scrollTop = 0;
    }
  }, [classDiffSearch, classDiffShowUnchanged]);

  const classListVirtual = useMemo(() => {
    const overscan = 6;
    const total = filteredClassDiffRows.length;
    const start = Math.max(0, Math.floor(classListScrollTop / CLASS_DIFF_ROW_PX) - overscan);
    const end = Math.min(
      total,
      Math.ceil((classListScrollTop + CLASS_DIFF_VIEWPORT_PX) / CLASS_DIFF_ROW_PX) + overscan
    );
    return {
      visibleRows: filteredClassDiffRows.slice(start, end),
      padTop: start * CLASS_DIFF_ROW_PX,
      padBottom: Math.max(0, (total - end) * CLASS_DIFF_ROW_PX),
      total,
    };
  }, [filteredClassDiffRows, classListScrollTop]);

  /** Class-diff rows with at least one stored breaking entry (badges sourced from the stored classification, #4476). */
  const storedBreakingIds = useMemo(
    () => breakingStableIds(compareStoredChangelog?.changelog?.entries),
    [compareStoredChangelog],
  );

  const classDiffCounts = useMemo(() => {
    if (!classDiffRows) return null;
    return {
      added: classDiffRows.filter((r) => r.status === 'added').length,
      removed: classDiffRows.filter((r) => r.status === 'removed').length,
      modified: classDiffRows.filter((r) => r.status === 'modified').length,
      unchanged: classDiffRows.filter((r) => r.status === 'unchanged').length,
    };
  }, [classDiffRows]);

  const breakingChangesMarkdown = useMemo(() => {
    if (!schemaDiffSummary) return '';
    const vBase = versions.find((v) => v.id === compareVersion1Id);
    const vTo = versions.find((v) => v.id === compareVersion2Id);
    return generateBreakingChangesMarkdownFromSummary(schemaDiffSummary, {
      baseLabel: vBase ? `v${vBase.version_id} (base)` : 'base',
      targetLabel: vTo ? `v${vTo.version_id} (compare)` : 'target',
    });
  }, [schemaDiffSummary, compareVersion1Id, compareVersion2Id, versions]);

  const migrationGuideMarkdown = useMemo(() => {
    if (!schemaDiffSummary) return '';
    const vBase = versions.find((v) => v.id === compareVersion1Id);
    const vTo = versions.find((v) => v.id === compareVersion2Id);
    const hintSet = new Set<string>();
    for (const h of extractBreakingHintsFromChangelog(vBase?.changelog)) {
      hintSet.add(h);
    }
    for (const h of extractBreakingHintsFromChangelog(vTo?.changelog)) {
      hintSet.add(h);
    }
    return generateMigrationGuideMarkdownFromSummary(schemaDiffSummary, {
      baseLabel: vBase ? `v${vBase.version_id} (base)` : 'base',
      targetLabel: vTo ? `v${vTo.version_id} (compare)` : 'target',
      baseRevisionId: compareVersion1Id,
      targetRevisionId: compareVersion2Id,
      breakingHintsFromChangelog: [...hintSet].sort((a, b) => a.localeCompare(b)),
    });
  }, [schemaDiffSummary, compareVersion1Id, compareVersion2Id, versions]);

  const appendBreakingDocToCompareTargetChangelog = () => {
    const vTo = versions.find((v) => v.id === compareVersion2Id);
    if (!vTo || !breakingChangesMarkdown.trim()) {
      toast.warning('Nothing to append');
      return;
    }
    if (vTo.published) {
      toast.warning('Cannot edit changelog on a published revision.');
      return;
    }
    const lc = vTo.lifecycle ?? 'stable';
    if (lc === 'archived') {
      toast.warning('Archived revisions cannot update changelog here. Copy the generated doc instead.');
      return;
    }
    const md = breakingChangesMarkdown.trim();
    const existing = vTo.changelog?.trim() ?? '';
    const sep = existing ? '\n\n---\n\n' : '';
    const merged = `${existing}${sep}${md}`;
    setSelectedVersion(vTo);
    setVersionId(vTo.version_id);
    setDescription(vTo.shortMessage || '');
    setChangeLog(merged);
    setEnabled(vTo.enabled);
    setEditLifecycle(lc);
    setErrorMessage('');
    setShowCompareDialog(false);
    setShowEditDialog(true);
    toast.success('Review changelog in Edit Version, then save.');
  };

  const appendMigrationGuideToCompareTargetChangelog = () => {
    const vTo = versions.find((v) => v.id === compareVersion2Id);
    if (!vTo || !migrationGuideMarkdown.trim()) {
      toast.warning('Nothing to append');
      return;
    }
    if (vTo.published) {
      toast.warning('Cannot edit changelog on a published revision.');
      return;
    }
    const lc = vTo.lifecycle ?? 'stable';
    if (lc === 'archived') {
      toast.warning('Archived revisions cannot update changelog here. Copy the generated guide instead.');
      return;
    }
    const md = migrationGuideMarkdown.trim();
    const existing = vTo.changelog?.trim() ?? '';
    const sep = existing ? '\n\n---\n\n' : '';
    const merged = `${existing}${sep}${md}`;
    setSelectedVersion(vTo);
    setVersionId(vTo.version_id);
    setDescription(vTo.shortMessage || '');
    setChangeLog(merged);
    setEnabled(vTo.enabled);
    setEditLifecycle(lc);
    setErrorMessage('');
    setShowCompareDialog(false);
    setShowEditDialog(true);
    toast.success('Review changelog in Edit Version, then save.');
  };

  const downloadMigrationGuideMarkdownFile = () => {
    const vBase = versions.find((v) => v.id === compareVersion1Id);
    const vTo = versions.find((v) => v.id === compareVersion2Id);
    const proj = projects.find((p) => p.id === selectedProjectId);
    const name = `migration-guide-${sanitizeFilenameSegment(proj?.name ?? 'project')}-${sanitizeFilenameSegment(vBase?.version_id ?? 'base')}-to-${sanitizeFilenameSegment(vTo?.version_id ?? 'target')}.md`;
    const blob = new Blob([migrationGuideMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Markdown downloaded');
  };

  const classDiffListRender = useMemo(() => {
    const hasVisibleExpandedClassDiff =
      expandedClassDiffId !== null &&
      filteredClassDiffRows.some((row) => row.stableId === expandedClassDiffId);
    const virtualize =
      !hasVisibleExpandedClassDiff && filteredClassDiffRows.length > 64;
    if (virtualize) {
      return {
        virtualize: true as const,
        rows: classListVirtual.visibleRows,
        padTop: classListVirtual.padTop,
        padBottom: classListVirtual.padBottom,
      };
    }
    return {
      virtualize: false as const,
      rows: filteredClassDiffRows,
      padTop: 0,
      padBottom: 0,
    };
  }, [expandedClassDiffId, filteredClassDiffRows, classListVirtual]);

  const tagFilteredVersions = useMemo(() => {
    if (!historyTagFilter) return versions;
    const t = versionTags.find((x) => x.id === historyTagFilter);
    if (!t) return versions;
    return versions.filter((v) => v.id === t.version_id);
  }, [versions, versionTags, historyTagFilter]);

  const historyAuthorOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const v of tagFilteredVersions) {
      if (!v.creator_id || byId.has(v.creator_id)) continue;
      const label =
        (v.creator_name && v.creator_name.trim()) ||
        (v.creator_email && v.creator_email.trim()) ||
        v.creator_id;
      byId.set(v.creator_id, label);
    }
    return Array.from(byId.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [tagFilteredVersions]);

  const displayVersions = useMemo(() => {
    return tagFilteredVersions.filter((v) =>
      revisionMatchesHistoryFilters(v, historySearchQ, historyAuthorCreatorId, historyDateFrom, historyDateTo)
    );
  }, [tagFilteredVersions, historySearchQ, historyAuthorCreatorId, historyDateFrom, historyDateTo]);

  const tableDisplayVersions = useMemo(
    () => sortVersions(displayVersions, versionsSort),
    [displayVersions, versionsSort]
  );

  /** The quick chip narrows the sorted rows; its counts come from the rows before it. */
  const facetCounts = useMemo(() => versionFacetCounts(displayVersions), [displayVersions]);
  const visibleVersions = useMemo(
    () => tableDisplayVersions.filter((v) => matchesVersionFacet(v, versionFacet)),
    [tableDisplayVersions, versionFacet]
  );

  /** A header click, through the primitive's asc → desc → null cycle, kept to two states. */
  const handleVersionsSortChange = useCallback((next: DataTableSortState | null) => {
    setVersionsSort((current) => nextVersionsSort(current, next));
  }, []);

  const historyTimelineFiltersActive =
    historySearchQ.trim() !== '' || !!historyAuthorCreatorId || !!historyDateFrom || !!historyDateTo;

  const resetHistoryTimelineFilters = useCallback(() => {
    setHistorySearchQ('');
    setHistoryAuthorCreatorId('');
    setHistoryDateFrom('');
    setHistoryDateTo('');
  }, []);

  useEffect(() => {
    resetHistoryTimelineFilters();
  }, [selectedProjectId, resetHistoryTimelineFilters]);

  useEffect(() => {
    setHistoryGraphWindowSize(DEFAULT_HISTORY_WINDOW);
  }, [selectedProjectId, historyTagFilter, lifecycleFilter, historySearchQ, historyAuthorCreatorId, historyDateFrom, historyDateTo]);

  useEffect(() => {
    if (historyAuthorCreatorId && !historyAuthorOptions.some((o) => o.id === historyAuthorCreatorId)) {
      setHistoryAuthorCreatorId('');
    }
  }, [historyAuthorCreatorId, historyAuthorOptions]);

  const handleCompareFormatChange = (newFormat: 'json' | 'yaml') => {
    setCompareFormat(newFormat);
    if (compareSpec1 && compareSpec2) {
      const content1 = newFormat === 'json' ? compareSpec1 : YAML.stringify(JSON.parse(compareSpec1));
      const content2 = newFormat === 'json' ? compareSpec2 : YAML.stringify(JSON.parse(compareSpec2));
      setDiffResult(diffLines(content1, content2));
    }
  };

  const handleLeftScroll = () => {
    if (isSyncingScroll.current || !leftPanelRef.current || !rightPanelRef.current) return;
    isSyncingScroll.current = true;
    rightPanelRef.current.scrollTop = leftPanelRef.current.scrollTop;
    requestAnimationFrame(() => { isSyncingScroll.current = false; });
  };

  const handleRightScroll = () => {
    if (isSyncingScroll.current || !leftPanelRef.current || !rightPanelRef.current) return;
    isSyncingScroll.current = true;
    leftPanelRef.current.scrollTop = rightPanelRef.current.scrollTop;
    requestAnimationFrame(() => { isSyncingScroll.current = false; });
  };

  const canModify = (version: Version) => version.creator_id === currentUserId || !!effectiveIsAdmin;

  const openBranchFromRevisionDialog = useCallback(
    (revisionId: string) => {
      const v = versions.find((x) => x.id === revisionId);
      if (!v) {
        toast.warning('Revision not found in the current list.');
        return;
      }
      setBranchFromVersionId(v.id);
      setBranchNameInput(suggestBranchNameFromRevision(v.shortMessage, v.version_id));
      setShowBranchDialog(true);
    },
    [versions]
  );

  /** The New version dialog's branch-tip pick: the key, and the tip it resolves to. */
  const handleCopySourceBranchKeyChange = (val: string) => {
    setCopySourceBranchKey(val);
    if (val === 'blank') setSourceVersionId('');
    else if (val.startsWith('branch:')) {
      const bid = val.slice(7);
      const br = versionBranches.find((b) => b.id === bid);
      setSourceVersionId(br?.tip_version_id ?? '');
    }
  };

  /** Auto vs manual version id; auto re-derives the preview from the bump strategy. */
  const handleAutoGenerateChange = (isAuto: boolean) => {
    setAutoGenerate(isAuto);
    if (isAuto) setNextAutoVersion(calculateNextVersion(bumpStrategy));
  };

  /** Patch vs minor; the preview follows. */
  const handleBumpStrategyChange = (strategy: 'patch' | 'minor') => {
    setBumpStrategy(strategy);
    setNextAutoVersion(calculateNextVersion(strategy));
  };

  /**
   * A row action, from a hover button or the row menu (HIVE-6.2).
   *
   * Two ids are the table's own names for handlers this screen already has; every other id is
   * a `handleRowAction` case, unchanged.
   */
  const handleTableRowAction = (action: VersionRowMenuAction, version: Version) => {
    switch (action) {
      case 'compareWithCurrent':
        void handleCompareWithCurrent(version.id);
        return;
      case 'toggleLock':
        void handleToggleRevisionLock(version, !version.revisionLocked);
        return;
      default:
        void handleRowAction(action, version);
    }
  };

  const handleRowAction = async (action: string, version: Version) => {
    const isPublished = !!version.published;
    const canPub = !isPublished && canModify(version);
    const canUnpub = isPublished && canModify(version);
    switch (action) {
      case 'view': await handleViewOpenApi(version); break;
      // Export is version-scoped (MFX-6.5, #3859): an action on the viewed revision, never a
      // global nav item — a tenant may have hundreds of projects/versions.
      case 'export': setExportVersion(version); break;
      case 'relationshipGraph': await handleShowRelationshipGraph(version); break;
      case 'edit':
        if (!isPublished) handleEditClick(version);
        else if (effectiveIsAdmin) handleEditClick(version);
        else setErrorMessage('Cannot edit published version');
        break;
      case 'scheduleSunset':
        handleOpenSunsetSchedule(version);
        break;
      case 'publish':
        if (!isVersionPublishable(version)) {
          toast.warning('Catalog items cannot be published. Convert to OpenAPI to create a publishable project.');
        } else if (canPub) {
          handlePublishClick(version.id);
        } else {
          toast.warning('Only owner or admin can publish');
        }
        break;
      case 'unpublish': if (canUnpub) await handleUnpublish(version.id); else toast.warning('Only owner or admin can unpublish'); break;
      case 'freezeSchema': if (canModify(version)) await handleFreezeSchema(version); else toast.warning('Only owner or admin can freeze schema'); break;
      case 'delete':
        if (version.revisionLocked && !effectiveIsAdmin) {
          toast.warning('This revision is locked by policy; only a tenant admin can delete it.');
          break;
        }
        await handleDelete(version.id);
        break;
      case 'branchFrom':
        setBranchFromVersionId(version.id);
        setBranchNameInput(suggestBranchNameFromRevision(version.shortMessage, version.version_id));
        setShowBranchDialog(true);
        break;
      case 'forkToProject':
        if (otherProjects.length === 0) {
          toast.warning('Create another project in this tenant to fork into — forks are isolated copies in a different project.');
          break;
        }
        setForkFromVersionId(version.id);
        setForkTargetProjectId(otherProjects[0]?.id ?? '');
        setForkAutoGenerate(true);
        setForkVersionId('');
        setForkBumpStrategy('patch');
        setForkDescription(`Fork from v${version.version_id}`);
        setForkChangeLog('');
        setShowForkDialog(true);
        break;
      case 'tagFrom':
        setTagFromVersionId(version.id);
        setTagNameInput('');
        setTagMessageInput('');
        setTagChannelInput('');
        setTagImmutable(false);
        setTagProtected(false);
        setShowTagDialog(true);
        break;
      case 'rollbackBranch':
        if (versionBranches.length === 0) {
          toast.warning('Create a named branch first');
          break;
        }
        setRollbackTargetVersion(version);
        setRollbackBranchName(versionBranches[0]?.name ?? '');
        setRollbackPreview(null);
        setRollbackShortMessage('');
        setRollbackSkipCompat(false);
        setShowRollbackDialog(true);
        break;
    }
  };

  const handleCreateBranchSubmit = async () => {
    const name = branchNameInput.trim();
    if (!name || !branchFromVersionId || !selectedProjectId) {
      toast.warning('Enter a branch name');
      return;
    }
    setBranchSaving(true);
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-branches/from-revision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchName: name, sourceRevisionId: branchFromVersionId }),
      });
      const d = await r.json();
      if (d.success && d.branch?.id && d.branch?.tip_version_id) {
        toast.success(`Branch "${name}" created`);
        setShowBranchDialog(false);
        await loadBranches();
        setCopySourceBranchKey(`branch:${d.branch.id}`);
        setSourceVersionId(d.branch.tip_version_id);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const panel = document.getElementById('ade-named-branches-panel');
            if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            else historyGraphSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        });
      } else {
        toast.error(typeof d.error === 'string' ? d.error : 'Could not create branch');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create branch');
    } finally {
      setBranchSaving(false);
    }
  };

  const handleForkSubmit = async () => {
    if (!forkFromVersionId || !forkTargetProjectId) {
      toast.warning('Choose a target project');
      return;
    }
    const notesCheck = validateVersionNotesClient(forkDescription, forkChangeLog);
    if (!notesCheck.ok) {
      toast.error(notesCheck.error);
      return;
    }
    if (!forkAutoGenerate && !forkVersionId.trim()) {
      toast.warning('Enter a version ID or enable auto-generate');
      return;
    }
    setForkSaving(true);
    try {
      const body: Record<string, string | undefined | null> = {
        targetProjectId: forkTargetProjectId,
        sourceRevisionId: forkFromVersionId,
        shortMessage: forkDescription.trim(),
        changelog: forkChangeLog.trim() || undefined,
      };
      if (!forkAutoGenerate) {
        body.versionId = forkVersionId.trim();
      } else {
        body.bumpStrategy = forkBumpStrategy;
      }
      const r = await fetch('/api/versions/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.success) {
        toast.success(`Fork created in ${projects.find((p) => p.id === forkTargetProjectId)?.name ?? 'target project'}`);
        setShowForkDialog(false);
        handleSelectedProjectChange(forkTargetProjectId);
      } else {
        toast.error(typeof d.error === 'string' ? d.error : 'Could not create fork');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create fork');
    } finally {
      setForkSaving(false);
    }
  };

  const handleCreateTagSubmit = async () => {
    const name = tagNameInput.trim();
    if (!name || !tagFromVersionId || !selectedProjectId) {
      toast.warning('Enter a tag name');
      return;
    }
    setTagSaving(true);
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          versionId: tagFromVersionId,
          message: tagMessageInput.trim() || undefined,
          channel: tagChannelInput.trim() || undefined,
          immutable: tagImmutable,
          ...(effectiveIsAdmin && tagProtected ? { protected: true } : {}),
        }),
      });
      const d = await r.json();
      if (d.success) {
        toast.success(`Tag "${name}" created`);
        setShowTagDialog(false);
        await loadVersionTags();
      } else {
        toast.error(d.error || 'Could not create tag');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create tag');
    } finally {
      setTagSaving(false);
    }
  };

  const handleDeleteTag = async (tagId: string) => {
    if (!selectedProjectId) return;
    const ok = await confirmDialog({
      title: 'Delete tag',
      message: 'Remove this named tag? Version rows are not deleted.',
      variant: 'danger',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-tags/${tagId}`, {
        method: 'DELETE',
      });
      const d = await r.json();
      if (d.success) {
        toast.success('Tag removed');
        if (historyTagFilter === tagId) setHistoryTagFilter('');
        await loadVersionTags();
      } else {
        toast.error(d.error || 'Could not delete tag');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete tag');
    }
  };

  const handleDeleteBranch = async (branchId: string) => {
    if (!selectedProjectId) return;
    const ok = await confirmDialog({
      title: 'Delete branch',
      message: 'Remove this named branch? The version records are not deleted.',
      variant: 'danger',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-branches/${branchId}`, {
        method: 'DELETE',
      });
      const d = await r.json();
      if (d.success) {
        toast.success('Branch removed');
        await loadBranches();
      } else {
        toast.error(d.error || 'Could not delete branch');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete branch');
    }
  };

  const handleToggleBranchProtection = async (branchId: string, nextProtected: boolean) => {
    if (!selectedProjectId || !effectiveIsAdmin) return;
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-branches/${branchId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protected: nextProtected }),
      });
      const d = await r.json();
      if (d.success) {
        toast.success(nextProtected ? 'Branch is now protected' : 'Branch protection removed');
        await loadBranches();
      } else {
        toast.error(d.error || 'Could not update branch protection');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update branch');
    }
  };

  const handleToggleTagProtection = async (tagId: string, nextProtected: boolean) => {
    if (!selectedProjectId || !effectiveIsAdmin) return;
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-tags/${tagId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protected: nextProtected }),
      });
      const d = await r.json();
      if (d.success) {
        toast.success(nextProtected ? 'Tag is now protected' : 'Tag protection removed');
        await loadVersionTags();
      } else {
        toast.error(d.error || 'Could not update tag protection');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update tag');
    }
  };

  const handleToggleRevisionLock = async (version: Version, nextLocked: boolean) => {
    if (!selectedProjectId || !effectiveIsAdmin) return;
    try {
      const r = await fetch(
        `/api/projects/${selectedProjectId}/versions/${version.id}/revision-lock`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revisionLocked: nextLocked }),
        }
      );
      const d = await r.json();
      if (d.success) {
        toast.success(nextLocked ? 'Revision locked against deletion' : 'Revision lock removed');
        await loadVersions();
      } else {
        toast.error(d.error || 'Could not update revision lock');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update lock');
    }
  };

  const runMergePreview = async () => {
    if (!selectedProjectId || !mergeSourceBranch.trim() || !mergeTargetBranch.trim()) {
      toast.warning('Select source and target branch names');
      return;
    }
    if (mergeSourceBranch.trim() === mergeTargetBranch.trim()) {
      toast.warning('Source and target must be different branches');
      return;
    }
    setMergePreviewLoading(true);
    setMergePreviewData(null);
    setMergeConflictResolutions({});
    setMergeCompat(null);
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-branches/merge-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceBranchName: mergeSourceBranch.trim(),
          targetBranchName: mergeTargetBranch.trim(),
        }),
      });
      const d = await r.json();
      if (d.success) {
        setMergePreviewData({
          classification: d.classification,
          sourceTipVersionId: d.sourceTipVersionId,
          targetTipVersionId: d.targetTipVersionId,
          mergeBaseVersionId: d.mergeBaseVersionId ?? null,
          conflicts: Array.isArray(d.conflicts) ? d.conflicts : undefined,
          previewSourceBranch: mergeSourceBranch.trim(),
          previewTargetBranch: mergeTargetBranch.trim(),
        });
        if (!d.classification?.canAutoMerge) {
          toast.info('Merge preview: conflicts detected — apply is blocked until resolved.');
        }
        const targetTip = typeof d.targetTipVersionId === 'string' ? d.targetTipVersionId : '';
        const sourceTip = typeof d.sourceTipVersionId === 'string' ? d.sourceTipVersionId : '';
        if (targetTip && sourceTip) {
          setMergeCompatLoading(true);
          try {
            const cr = await fetch(`/api/projects/${selectedProjectId}/compatibility`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                baseRevisionId: targetTip,
                headRevisionId: sourceTip,
              }),
            });
            const cd = await cr.json();
            if (cr.ok && cd.success === true && typeof cd.overall === 'string') {
              const rh =
                cd.ruleHits && typeof cd.ruleHits === 'object' && !Array.isArray(cd.ruleHits)
                  ? (cd.ruleHits as Record<string, number>)
                  : undefined;
              setMergeCompat({
                overall: cd.overall,
                findings: Array.isArray(cd.findings) ? cd.findings : [],
                breakingChangeDocumentationIssueUrl: cd.breakingChangeDocumentationIssueUrl ?? null,
                tenantCompatGateActive: Boolean(cd.tenantCompatGateActive),
                mergeBlockedByCompatGate: Boolean(cd.mergeBlockedByCompatGate),
                ruleHits: rh,
              });
            } else {
              setMergeCompat(null);
            }
          } catch {
            setMergeCompat(null);
          } finally {
            setMergeCompatLoading(false);
          }
        }
      } else {
        toast.error(d.error || 'Preview failed');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setMergePreviewLoading(false);
    }
  };

  const runMergeApply = async () => {
    if (!selectedProjectId || !mergeSourceBranch.trim() || !mergeTargetBranch.trim()) {
      toast.warning('Select source and target branch names');
      return;
    }
    if (mergeSourceBranch.trim() === mergeTargetBranch.trim()) {
      toast.warning('Source and target must be different branches');
      return;
    }
    if (!mergePreviewMatchesBranches) {
      toast.warning('Run Preview merge for the current source and target branches before applying.');
      return;
    }
    if (mergeHasEngineConflicts) {
      toast.warning('Merge preview reported conflicts — the server does not yet accept resolution choices. Resolve conflicts server-side before applying.');
      return;
    }
    const target = versionBranches.find((b) => b.name === mergeTargetBranch.trim());
    if (!target) {
      toast.error('Target branch not found in list — refresh branches');
      return;
    }
    const skipCompatGateOverride =
      Boolean(mergeCompat?.mergeBlockedByCompatGate) &&
      effectiveIsAdmin &&
      mergeCompatGateOverride &&
      mergeCompatGateOverrideReason.trim().length > 0;

    setMergeApplyLoading(true);
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-branches/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceBranchName: mergeSourceBranch.trim(),
          targetBranchName: mergeTargetBranch.trim(),
          baseRevisionId: target.tip_version_id,
          ...(skipCompatGateOverride
            ? {
                skipCompatGate: true,
                compatGateOverrideReason: mergeCompatGateOverrideReason.trim(),
              }
            : {}),
        }),
      });
      const d = await r.json();
      if (d.success) {
        toast.success(`Merged into ${mergeTargetBranch.trim()} — new version ${d.version?.version_id ?? ''}`);
        setShowMergeDialog(false);
        setMergePreviewData(null);
        setMergeConflictResolutions({});
        clearPushConflict();
        await loadVersions();
        await loadBranches();
      } else {
        const err = typeof d.detail === 'object' && d.detail !== null ? d.detail : d;
        const code = typeof err === 'object' && err && 'code' in err ? (err as { code?: string }).code : undefined;
        const reason = typeof err === 'object' && err && 'reason' in err ? (err as { reason?: string }).reason : undefined;
        const conflictPaths =
          typeof err === 'object' && err && 'conflictPaths' in err
            ? (err as { conflictPaths?: string[] }).conflictPaths
            : undefined;
        const unresolvedCount =
          typeof err === 'object' && err && 'unresolvedCount' in err
            ? Number((err as { unresolvedCount?: unknown }).unresolvedCount)
            : NaN;
        const n =
          Number.isFinite(unresolvedCount) && unresolvedCount >= 0
            ? unresolvedCount
            : (conflictPaths?.length ?? 0);
        if (
          r.status === 409 &&
          (code === 'MERGE_CONFLICT' ||
            code === 'MERGE_UNRESOLVED_CONFLICTS' ||
            code === 'MERGE_BLEND')
        ) {
          toast.error(
            n > 0
              ? `Merge blocked: ${n} unresolved conflict(s). Resolve all conflicts before applying.`
              : 'Merge blocked: unresolved conflicts. Resolve all conflicts before applying.'
          );
          const paths = conflictPaths ?? [];
          const conflictKind = reason === 'MERGE_CONFLICT' ? 'threeWay' : reason === 'MERGE_BLEND' ? 'blend' : 'twoWay';
          setMergePreviewData((prev) => ({
            ...(prev ?? {}),
            classification: {
              canAutoMerge: false,
              conflictPaths: paths,
              addedSchemaNames: prev?.classification?.addedSchemaNames ?? [],
            },
            conflicts: paths.map((p) => ({ path: p, kinds: [conflictKind] })),
            previewSourceBranch: prev?.previewSourceBranch ?? mergeSourceBranch.trim(),
            previewTargetBranch: prev?.previewTargetBranch ?? mergeTargetBranch.trim(),
          }));
        } else {
          const msg =
            typeof err === 'object' && err && 'message' in err
              ? String((err as { message?: string }).message)
              : typeof d.error === 'string'
                ? d.error
                : 'Merge failed';
          toast.error(msg);
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Merge failed');
    } finally {
      setMergeApplyLoading(false);
    }
  };

  const runRollbackPreview = async () => {
    if (!selectedProjectId || !rollbackTargetVersion || !rollbackBranchName.trim()) {
      toast.warning('Choose a branch');
      return;
    }
    setRollbackPreviewLoading(true);
    setRollbackPreview(null);
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-branches/rollback-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: rollbackBranchName.trim(),
          targetRevisionId: rollbackTargetVersion.id,
        }),
      });
      const d = await r.json();
      if (d.success) {
        const rawImpact = d.impactSummary as Record<string, unknown> | undefined;
        const impactSummary =
          rawImpact && typeof rawImpact === 'object'
            ? {
                added: Number(rawImpact.added) || 0,
                removed: Number(rawImpact.removed) || 0,
                modified: Number(rawImpact.modified) || 0,
                unchanged: Number(rawImpact.unchanged) || 0,
                changedEntityCount: Number(rawImpact.changedEntityCount) || 0,
              }
            : undefined;
        setRollbackPreview({
          branchTipRevisionId: typeof d.branchTipRevisionId === 'string' ? d.branchTipRevisionId : undefined,
          compatOverall: typeof d.compatOverall === 'string' ? d.compatOverall : undefined,
          findings: Array.isArray(d.findings) ? d.findings : [],
          deprecationWarnings: Array.isArray(d.deprecationWarnings) ? d.deprecationWarnings : [],
          rollbackBlockedByCompatGate: Boolean(d.rollbackBlockedByCompatGate),
          breakingChangeDocumentationIssueUrl:
            typeof d.breakingChangeDocumentationIssueUrl === 'string' ? d.breakingChangeDocumentationIssueUrl : null,
          ...(impactSummary ? { impactSummary } : {}),
        });
        setRollbackSkipCompat(false);
      } else {
        const msg = (() => {
          if (typeof d.detail === 'string') return d.detail;
          const detail = d.detail as Record<string, unknown> | null | undefined;
          if (detail && typeof detail.message === 'string') return detail.message;
          if (typeof d.error === 'string') return d.error;
          return 'Preview failed';
        })();
        toast.error(msg);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setRollbackPreviewLoading(false);
    }
  };

  const runRollbackApply = async () => {
    if (!selectedProjectId || !rollbackTargetVersion || !rollbackBranchName.trim() || !rollbackPreview?.branchTipRevisionId) {
      toast.warning('Run preview first');
      return;
    }
    const overall = rollbackPreview.compatOverall ?? 'unknown';
    if (rollbackPreview.rollbackBlockedByCompatGate) {
      toast.error('Project policy blocks rollback when compatibility is not safe');
      return;
    }
    if (overall !== 'safe' && !rollbackSkipCompat) {
      toast.warning('Acknowledge compatibility risk using the checkbox below');
      return;
    }
    setRollbackApplyLoading(true);
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/version-branches/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: rollbackBranchName.trim(),
          targetRevisionId: rollbackTargetVersion.id,
          baseRevisionId: rollbackPreview.branchTipRevisionId,
          skipCompatWarning: overall !== 'safe',
          ...(rollbackShortMessage.trim() ? { shortMessage: rollbackShortMessage.trim() } : {}),
        }),
      });
      const d = await r.json();
      if (d.success) {
        toast.success(`Rollback complete — new revision v${d.version?.version_id ?? ''}`);
        setShowRollbackConfirmAlert(false);
        setShowRollbackDialog(false);
        setRollbackPreview(null);
        setRollbackTargetVersion(null);
        await loadVersions();
        await loadBranches();
      } else {
        const err = d.detail;
        const msg =
          typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message?: string }).message)
            : typeof d.error === 'string'
              ? d.error
              : 'Rollback failed';
        toast.error(msg);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rollback failed');
    } finally {
      setRollbackApplyLoading(false);
    }
  };

  const showChangeReportTab = changeReportUiEnabled && Boolean(selectedProjectId);
  /** Stored classified changelogs (CTG-3.2, #4476) — available for any selected project, no feature flag. */
  const showChangesTab = Boolean(selectedProjectId);
  /** Schema Test Bench (IXH-5.3, #5115) — addresses schemas by project slug, so it needs one. */
  const showTestBenchTab = Boolean(selectedProjectId && selectedProject?.slug);
  /** Conversion provenance history (CPDO-3.3, #4803): the tab exists only when this project was
      actually produced by a conversion, so the list itself gates visibility. A fetch error hides
      the tab silently — absence is this page's pre-CPDO-3.3 status quo, not an error state. */
  const conversionHistory = useConversionHistory(
    Boolean(selectedProjectId),
    useMemo(
      () => (selectedProjectId ? { kind: 'project' as const, projectId: selectedProjectId } : null),
      [selectedProjectId],
    ),
  );
  const showConversionTab = conversionHistory.rows.length > 0;
  /** The tab actually rendered: falls back to the timeline when the selected tab's surface is unavailable. */
  const effectiveMainTab =
    (versionsMainTab === 'change-report' && !showChangeReportTab) ||
    (versionsMainTab === 'changes' && !showChangesTab) ||
    (versionsMainTab === 'test-bench' && !showTestBenchTab) ||
    (versionsMainTab === 'conversion' && !showConversionTab)
      ? 'timeline'
      : versionsMainTab;

  // ---- the page (HIVE-6.2, #5313) -----------------------------------------------------------
  //
  // Everything above this line is the screen as it was: its state, its reads and its writes.
  // Everything below is the Hive skin — `Page` / `PageHeader` / `PageBody`, the components in
  // `components/ade/versions`, and the compare / merge / branch / tag / fork / rollback dialogs
  // that HIVE-6.3 (#5314) will re-skin in their turn.

  const breadcrumb = [
    { label: 'Home', href: HOME_ROUTE },
    { label: 'Build' },
    { label: 'Projects', href: PROJECTS_ROUTE },
    { label: selectedProject?.name ?? 'Versions' },
  ];

  const pageDescription = (
    <>
      Revisions and releases for this project ·{' '}
      <Link href={SUNSET_TIMELINE_ROUTE} className="ver-desc-link">
        Sunset timeline (EOL schedule)
      </Link>
    </>
  );

  if (!session) {
    return (
      <Page>
        <PageHeader breadcrumb={breadcrumb} title="Versions" description={pageDescription} />
        <PageBody>
          <LoadingState minHeightClassName="min-h-[13.75rem]" message="Loading versions..." />
        </PageBody>
      </Page>
    );
  }

  if (!currentTenantId) {
    return (
      <Page>
        <PageHeader breadcrumb={breadcrumb} title="Versions" description={pageDescription} />
        <PageBody>
          <GatedState description="Versions are scoped to one workspace. Please select a tenant before managing versions." />
        </PageBody>
      </Page>
    );
  }

  if (projects.length === 0) {
    return (
      <Page>
        <PageHeader breadcrumb={breadcrumb} title="Versions" description={pageDescription} />
        <PageBody>
          <EmptyState
            icon={<Package />}
            title="No projects yet"
            description="Create a project before managing versions."
            data-testid="versions-no-projects"
            action={
              <Button asChild>
                <Link href={PROJECTS_ROUTE}>Go to Projects</Link>
              </Button>
            }
          />
        </PageBody>
      </Page>
    );
  }

  const publishedCount = versions.filter((v) => v.published).length;
  const viewingProject = viewingVersion
    ? projects.find((p) => p.id === viewingVersion.project_id)
    : undefined;
  const publishVersion = publishVersionId
    ? (versions.find((v) => v.id === publishVersionId) ?? null)
    : null;
  const lastPublished = lastPublishedVersion(versions);
  const projectPublishable = isProjectPublishable(selectedProject);
  const noVersionsYet = versionsLoaded && versions.length === 0 && !lifecycleFilter;

  const headerBadges = (
    <span className="ver-header__badges">
      {selectedProject && projectPublishable ? <FormatPill format="openapi" /> : null}
      {headBadge ? (
        <Badge status={headBadge.status} dot title={headBadge.title} data-testid="versions-head-badge">
          {headBadge.label}
        </Badge>
      ) : null}
      {headQuality ? (
        <Badge
          variant={gradeBand(headQuality.grade).tone}
          title="Stored quality score of the head revision (#5259)"
          data-testid="versions-head-quality"
        >
          <ShieldCheck aria-hidden />
          {headQuality.label}
        </Badge>
      ) : null}
    </span>
  );

  const headerActions = (
    <>
      <Select value={selectedProjectId} onValueChange={handleSelectedProjectChange}>
        <SelectTrigger
          className="ver-project-select"
          aria-label="Select project"
          title="Catalog items are excluded — convert one to OpenAPI to make it publishable"
          data-testid="versions-project-select"
        >
          <SelectValue placeholder="Select Project" />
        </SelectTrigger>
        <SelectContent>
          {selectableProjects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Import (#5260): start an import here instead of backtracking to Projects. */}
      <Button
        variant="outline"
        data-testid="versions-import-button"
        onClick={() => setShowImportDialog(true)}
        disabled={!currentUserId}
        title={
          currentUserId
            ? 'Import a specification into a new project'
            : 'Your session is still resolving — try again in a moment'
        }
      >
        <Upload aria-hidden />
        Import
      </Button>
      <Button
        variant="outline"
        onClick={handleCompareDialogOpen}
        disabled={!selectedProjectId || versions.length < 2}
        title="Compare two revisions (needs at least 2 versions)"
        data-testid="versions-compare-button"
      >
        <GitCompareArrows aria-hidden />
        Compare
      </Button>
      {GITLIKE.visible ? (
        <span className="ver-header__gitlike">
          <Button
            variant="outline"
            onClick={handleVersionsOpenMerge}
            disabled={!GITLIKE.enabled || !selectedProjectId || versionBranches.length < 2}
            title={
              !GITLIKE.enabled
                ? GITLIKE_FLAG_TITLE
                : versionBranches.length < 2
                  ? 'Create at least two named branches to merge'
                  : 'Merge branches'
            }
            data-testid="versions-merge-button"
          >
            <GitMerge aria-hidden />
            Merge branches
          </Button>
          {GITLIKE.marked ? <GitlikeFlag enabled={GITLIKE.enabled} /> : null}
        </span>
      ) : null}
      <Button
        onClick={handleNewVersionClick}
        disabled={!selectedProjectId}
        title="Start a new version (fresh release line, defaults to a minor bump)"
        data-testid="versions-new-button"
      >
        <GitFork aria-hidden />
        New version
      </Button>
    </>
  );

  /* A hand-built strip on the shared tab classes rather than `ui/Tabs`: Radix's `Tabs.Root`
     is one element that would have to wrap the header *and* the body, and `.page` is a flex
     column whose two children are exactly those two. The ids and copy are the screen's own. */
  const headerTabs = selectedProjectId ? (
    <div role="tablist" aria-label="Versions main view" className={TAB_LIST_CLASS} data-testid="versions-main-tab">
      <button
        type="button"
        role="tab"
        aria-selected={effectiveMainTab === 'timeline'}
        data-testid="versions-tab-timeline"
        className={tabTriggerClass({ active: effectiveMainTab === 'timeline' })}
        onClick={() => setVersionsMainTab('timeline')}
      >
        <ScrollText className="ver-tab-glyph" aria-hidden />
        Timeline
        <span className={TAB_COUNT_CLASS}>{versions.length}</span>
      </button>
      {showChangesTab ? (
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMainTab === 'changes'}
          data-testid="versions-tab-changes"
          className={tabTriggerClass({ active: effectiveMainTab === 'changes' })}
          onClick={() => setVersionsMainTab('changes')}
        >
          <GitCompareArrows className="ver-tab-glyph" aria-hidden />
          Changes
          <span className={TAB_COUNT_CLASS}>{publishedCount}</span>
        </button>
      ) : null}
      {showChangeReportTab ? (
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMainTab === 'change-report'}
          data-testid="versions-tab-change-report"
          className={tabTriggerClass({ active: effectiveMainTab === 'change-report' })}
          onClick={() => setVersionsMainTab('change-report')}
        >
          <FileText className="ver-tab-glyph" aria-hidden />
          Change report
          {GITLIKE.marked ? <GitlikeFlag enabled /> : null}
        </button>
      ) : GITLIKE.visible && !GITLIKE.flagOn && CHANGE_REPORT_ENV_ALLOWED ? (
        /* Compiled but hidden: the tab is drawn inert with its flag, so the gap is legible. */
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          title={GITLIKE_FLAG_TITLE}
          data-testid="versions-tab-change-report"
          className={tabTriggerClass({ active: false, disabled: true })}
        >
          <FileText className="ver-tab-glyph" aria-hidden />
          Change report
          <GitlikeFlag />
        </button>
      ) : null}
      {showTestBenchTab ? (
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMainTab === 'test-bench'}
          data-testid="versions-tab-test-bench"
          className={tabTriggerClass({ active: effectiveMainTab === 'test-bench' })}
          onClick={() => setVersionsMainTab('test-bench')}
        >
          <FlaskConical className="ver-tab-glyph" aria-hidden />
          Test bench
          {/* IXH-5.7: appears only when a saved test suite's newest run regressed. */}
          {selectedProject?.slug ? (
            <SuiteRegressionBadge surface="project" artifact={selectedProject.slug} />
          ) : null}
        </button>
      ) : null}
      {showConversionTab ? (
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMainTab === 'conversion'}
          data-testid="versions-tab-conversion"
          className={tabTriggerClass({ active: effectiveMainTab === 'conversion' })}
          title="Only when the project was produced by a catalog conversion"
          onClick={() => setVersionsMainTab('conversion')}
        >
          <History className="ver-tab-glyph" aria-hidden />
          Conversion
        </button>
      ) : null}
    </div>
  ) : undefined;

  const tableToolbar = (
    <DataTableToolbar>
      <Select
        value={lifecycleFilter || ALL_LIFECYCLES}
        onValueChange={(v) => setLifecycleFilter(v === ALL_LIFECYCLES ? '' : v)}
      >
        <SelectTrigger className="ver-toolbar-select" aria-label="Lifecycle filter" data-testid="versions-lifecycle-filter">
          <SelectValue placeholder="All lifecycles" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_LIFECYCLES}>All lifecycles</SelectItem>
          {VERSION_LIFECYCLES.map((lifecycle) => (
            <SelectItem key={lifecycle} value={lifecycle}>
              {VERSION_LIFECYCLE_LABEL[lifecycle]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {versionTags.length > 0 ? (
        <Select
          value={historyTagFilter || ALL_REVISIONS}
          onValueChange={(v) => setHistoryTagFilter(v === ALL_REVISIONS ? '' : v)}
        >
          <SelectTrigger
            className="ver-toolbar-select ver-toolbar-select--history"
            aria-label="History filter"
            title="Filter revisions reachable from a tag"
            data-testid="versions-history-filter"
          >
            <SelectValue placeholder="All revisions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_REVISIONS}>All revisions</SelectItem>
            {versionTags.map((tg) => (
              <SelectItem key={tg.id} value={tg.id}>
                Tag {tg.name} → v{tg.target_version_string ?? '?'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {VERSION_FACETS.map((entry) => (
        <DataTableFilterChip
          key={entry}
          active={versionFacet === entry}
          count={facetCounts[entry]}
          data-testid={`versions-facet-${entry}`}
          onClick={() => setVersionFacet(entry)}
        >
          {VERSION_FACET_LABELS[entry]}
        </DataTableFilterChip>
      ))}
      <DataTableToolbarSpacer />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="sm" data-testid="versions-sort-menu">
            <ArrowUpDown aria-hidden />
            Sorted by {versionsSortLabel(versionsSort)}
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="tnt-menu" sideOffset={4} align="end">
            {VERSION_SORT_OPTIONS.map((option) => (
              <DropdownMenu.Item
                key={option.id}
                className="tnt-menu__item"
                data-testid={`versions-sort-${option.id}`}
                onSelect={() => setVersionsSort((current) => versionsSortFromMenu(current, option.id))}
              >
                {option.label}
                {versionsSort.column === option.id ? (
                  <span className="ver-sort-mark" aria-hidden>
                    {versionsSort.direction === 'asc' ? '↑' : '↓'}
                  </span>
                ) : null}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </DataTableToolbar>
  );

  const tableFooter = (
    <DataTableFoot>
      <span data-testid="versions-table-foot">
        {versionsFootLabel(visibleVersions.length, versionsSort, lifecycleFilter)}
      </span>
      <span className="ver-foot-side" data-testid="versions-table-foot-head">
        Head <span className="mono">{headLine.head ?? '—'}</span> · last published{' '}
        <span className="mono">{headLine.lastPublished ?? '—'}</span>
      </span>
    </DataTableFoot>
  );

  /* The four ways the table can have nothing to draw, each with the way out — lifecycle filter
     (server-side), tag filter, timeline filters, and the quick chip. Same copy as before. */
  const tableEmpty =
    versions.length === 0 && lifecycleFilter ? (
      <EmptyState
        variant="compact"
        surface={false}
        tone="neutral"
        title="No revisions match this lifecycle filter"
        description="Choose a different lifecycle or select All lifecycles to load every revision again."
        data-testid="versions-empty-lifecycle"
        action={
          <Button variant="outline" size="sm" onClick={() => setLifecycleFilter('')}>
            Clear lifecycle filter
          </Button>
        }
      />
    ) : versions.length > 0 && tagFilteredVersions.length === 0 ? (
      <EmptyState
        variant="compact"
        surface={false}
        tone="neutral"
        title="No revision matches the selected history tag"
        description="Clear the tag filter above or pick another tag."
        data-testid="versions-empty-tag"
        action={
          <Button variant="outline" size="sm" onClick={() => setHistoryTagFilter('')}>
            Clear tag filter
          </Button>
        }
      />
    ) : displayVersions.length === 0 ? (
      <EmptyState
        variant="compact"
        surface={false}
        tone="neutral"
        title="No revisions match your timeline filters (search, author, or date range)"
        description="Adjust the filters or reset them to see the full history again."
        data-testid="versions-empty-timeline"
        action={
          historyTimelineFiltersActive ? (
            <Button variant="outline" size="sm" onClick={resetHistoryTimelineFilters}>
              Reset timeline filters
            </Button>
          ) : undefined
        }
      />
    ) : (
      <EmptyState
        variant="compact"
        surface={false}
        tone="neutral"
        title={versionFacet === 'drafts' ? 'No drafts in this view' : 'No published revisions in this view'}
        description="Pick another chip above to see the rest of the timeline."
        data-testid="versions-empty-facet"
        action={
          <Button variant="outline" size="sm" onClick={() => setVersionFacet('all')}>
            Show all
          </Button>
        }
      />
    );

  return (
    <Page>
      <PageHeader
        className="ver-header"
        breadcrumb={breadcrumb}
        title={selectedProject?.name ?? 'Versions'}
        badge={headerBadges}
        description={pageDescription}
        actions={headerActions}
        tabs={headerTabs}
      />

      {FEATURE_GITLIKE && conflict && conflict.projectId === selectedProjectId && selectedProjectId ? (
        <ServerAheadPushBanner
          bar
          flagged={GITLIKE.marked}
          detail={conflict.message}
          pullLoading={versionsPullBannerLoading}
          onPull={handleVersionsPullReconcile}
          onOpenMerge={handleVersionsOpenMerge}
        />
      ) : null}

      <PageBody>
        {showConversionTab && effectiveMainTab === 'conversion' ? (
          /* Conversion provenance history (CPDO-3.3, #4803): where this project's revisions came
             from. Evidence replay lives on the catalog item's Conversions tab. */
          <Card className="ver-panel">
            <ProjectConversionPanel
              rows={conversionHistory.rows}
              loading={conversionHistory.loading}
              error={conversionHistory.error}
              retry={conversionHistory.retry}
              onSelectVersion={() => setVersionsMainTab('timeline')}
            />
          </Card>
        ) : null}

        {showChangeReportTab && effectiveMainTab === 'change-report' ? (
          <VersionChangeReportPanel
            projectId={selectedProjectId}
            versions={versions}
            currentUserId={currentUserId}
            effectiveIsAdmin={!!effectiveIsAdmin}
          />
        ) : null}

        {showChangesTab && effectiveMainTab === 'changes' ? (
          <VersionChangesPanel
            projectId={selectedProjectId}
            versions={versions}
            onOpenDiff={handleOpenDiffFromChanges}
          />
        ) : null}

        {showTestBenchTab && effectiveMainTab === 'test-bench' && selectedProject?.slug ? (
          /* Schema Test Bench (IXH-5.3, #5115): validate/generate payloads against this
             project's schemas, addressed as project/{slug}/{revision-id}/{type}. */
          <SchemaTestBench
            key={selectedProject.id}
            surface="project"
            artifact={selectedProject.slug}
            artifactName={selectedProject.name}
            versionOptions={[
              { value: 'latest', label: 'Latest revision' },
              ...versions
                .filter((v) => !v.deleted_at)
                .map((v) => ({
                  value: v.id,
                  label: `v${v.version_id} · ${v.id.slice(0, 8)}`,
                })),
            ]}
            tenantId={currentTenantId ?? null}
            active
          />
        ) : null}

        {effectiveMainTab === 'timeline' ? (
          <>
            <VersionsBanners
              compatibility={compatBanner}
              whatsNew={whatsNew}
              deprecation={deprecation}
              changesAvailable={showChangesTab}
              onOpenChanges={() => setVersionsMainTab('changes')}
            />

            {selectedProjectId ? (
              <div className="ver-overview">
                <ProjectRelatedArtifactsSection projectId={selectedProjectId} />
                {selectedProject ? (
                  <ProjectFactsCard
                    project={selectedProject}
                    headLine={headLine}
                    headRevisionId={headRevisionId}
                    lastPublishedAt={
                      lastPublished?.published_at ? formatVersionDate(lastPublished.published_at) : null
                    }
                    publishable={projectPublishable}
                  />
                ) : null}
              </div>
            ) : null}

            {noVersionsYet ? (
              <EmptyState
                icon={<Package />}
                title="No versions yet"
                description="Get started by creating your first version — or import a spec into this project."
                data-testid="versions-empty"
                action={
                  <Button onClick={handleNewVersionClick} disabled={!selectedProjectId}>
                    <GitFork aria-hidden />
                    New version
                  </Button>
                }
                secondaryAction={
                  <Button variant="outline" onClick={() => setShowImportDialog(true)} disabled={!currentUserId}>
                    <Upload aria-hidden />
                    Import
                  </Button>
                }
              />
            ) : (
              <>
                <VersionsTimelineFilters
                  query={historySearchQ}
                  onQueryChange={setHistorySearchQ}
                  authorId={historyAuthorCreatorId}
                  onAuthorChange={setHistoryAuthorCreatorId}
                  authorOptions={historyAuthorOptions}
                  dateFrom={historyDateFrom}
                  onDateFromChange={setHistoryDateFrom}
                  dateTo={historyDateTo}
                  onDateToChange={setHistoryDateTo}
                  active={historyTimelineFiltersActive}
                  onReset={resetHistoryTimelineFilters}
                />

                {FEATURE_GITLIKE && selectedProjectId ? (
                  <VersionGitlikePanels
                    tags={versionTags}
                    branches={versionBranches}
                    effectiveIsAdmin={!!effectiveIsAdmin}
                    currentUserId={currentUserId}
                    gitlike={GITLIKE}
                    onToggleTagProtection={(tagId, next) => void handleToggleTagProtection(tagId, next)}
                    onDeleteTag={(tagId) => void handleDeleteTag(tagId)}
                    onToggleBranchProtection={(branchId, next) =>
                      void handleToggleBranchProtection(branchId, next)
                    }
                    onDeleteBranch={(branchId) => void handleDeleteBranch(branchId)}
                  />
                ) : null}

                {FEATURE_GITLIKE ? (
                  <Card className="ver-graph-card" ref={historyGraphSectionRef} data-testid="versions-history-graph">
                    <div className="ver-graph-card__head">
                      <GitGraph aria-hidden />
                      <span className="ver-graph-card__title">Revision history graph</span>
                      {GITLIKE.marked ? <GitlikeFlag enabled /> : null}
                      <span>Left-to-right lanes, merge parents dashed.</span>
                    </div>
                    <VersionHistoryGraphPanel
                      key={versionBranches.map((b) => b.id).sort().join('|') || 'graph-branches'}
                      versions={displayVersions.map((v) => ({
                        id: v.id,
                        version_id: v.version_id,
                        parent_version_id: v.parent_version_id ?? null,
                        merge_parent_version_id: v.merge_parent_version_id ?? null,
                        created_at: v.created_at,
                        shortMessage: v.shortMessage,
                        commitMessage: v.message ?? null,
                        authorName: v.author ?? v.creator_name ?? null,
                        creatorId: v.creator_id ?? null,
                      }))}
                      branches={versionBranches.map((b) => ({
                        id: b.id,
                        name: b.name,
                        tip_version_id: b.tip_version_id,
                      }))}
                      tags={versionTags.map((t) => ({
                        id: t.id,
                        name: t.name,
                        version_id: t.version_id,
                        immutable: t.immutable,
                        protected: t.protected,
                      }))}
                      headRevisionId={headRevisionId}
                      windowSize={historyGraphWindowSize}
                      onWindowSizeIncrease={setHistoryGraphWindowSize}
                      onCompareToPrimaryParent={handleHistoryGraphCompareToParent}
                      onViewSpec={handleHistoryGraphViewSpec}
                      onBranchFromRevision={openBranchFromRevisionDialog}
                    />
                  </Card>
                ) : null}

                <VersionsTable
                  versions={visibleVersions}
                  loading={!versionsLoaded}
                  projectId={selectedProjectId}
                  projectSlug={selectedProject?.slug}
                  headRevisionId={headRevisionId}
                  tagsByVersionId={tagsByVersionId}
                  hasClassSchemaMap={hasClassSchemaMap}
                  effectiveIsAdmin={!!effectiveIsAdmin}
                  currentUserId={currentUserId}
                  hasBranches={versionBranches.length > 0}
                  freezingSchemaVersionId={freezingSchemaVersionId}
                  isVersionPublishable={isVersionPublishable}
                  gitlike={GITLIKE}
                  mockUsageByVersion={mockUsageByVersion}
                  onMockChanged={handleVersionMockChanged}
                  onRowAction={handleTableRowAction}
                  sort={versionsSort}
                  onSortChange={handleVersionsSortChange}
                  toolbar={tableToolbar}
                  footer={tableFooter}
                  empty={tableEmpty}
                  caption={`Revisions of ${selectedProject?.name ?? 'this project'}`}
                />
              </>
            )}
          </>
        ) : null}
      </PageBody>

      {/* Import dialog (#5260): the same importer the Projects screen opens, so both surfaces share
          one intake. `projects` variant = native OpenAPI/Swagger sources; the alternative formats
          stay on the Catalog importer (MFI-23.12). */}
      {currentTenantId && currentUserId && (
        <ImportDialog
          open={showImportDialog}
          onClose={() => setShowImportDialog(false)}
          onSuccess={handleImportSuccess}
          tenantId={currentTenantId}
          userId={currentUserId}
          variant="projects"
        />
      )}

      {/* New Version dialog — core version workflow; not gated by FEATURE_GITLIKE (merge/tags/etc. still are). */}
      <NewVersionDialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          if (!isLoading) setShowCreateDialog(open);
        }}
        busy={isLoading}
        error={errorMessage}
        versions={versions}
        branches={versionBranches}
        branchListLoading={branchListLoading}
        branchListError={branchListError}
        branchPermissionDenied={branchPermissionDenied}
        copySourceBranchKey={copySourceBranchKey}
        onCopySourceBranchKeyChange={handleCopySourceBranchKeyChange}
        sourceVersionId={sourceVersionId}
        onSourceVersionIdChange={setSourceVersionId}
        autoGenerate={autoGenerate}
        onAutoGenerateChange={handleAutoGenerateChange}
        bumpStrategy={bumpStrategy}
        onBumpStrategyChange={handleBumpStrategyChange}
        nextAutoVersion={nextAutoVersion}
        previewFor={calculateNextVersion}
        versionId={versionId}
        onVersionIdChange={setVersionId}
        message={description}
        onMessageChange={setDescription}
        messageError={
          description.length > 0 && !createCommitMessageCheck.ok ? createCommitMessageCheck.error : null
        }
        externalRef={commitExternalRef}
        onExternalRefChange={setCommitExternalRef}
        externalRefOverLimit={commitExternalRefTrim.length > COMMIT_EXTERNAL_REF_MAX_CHARS}
        changelog={changeLog}
        onChangelogChange={setChangeLog}
        changelogOverLimit={commitChangelogOverLimit}
        canSubmit={createCommitFormValid}
        onSubmit={() => void handleCreateSubmit()}
        gitlike={GITLIKE}
      />

      {/* Edit Version Dialog */}
      <EditVersionDialog
        open={showEditDialog}
        onOpenChange={(open) => {
          if (!isLoading) setShowEditDialog(open);
        }}
        busy={isLoading}
        error={errorMessage}
        version={selectedVersion}
        effectiveIsAdmin={!!effectiveIsAdmin}
        publishedMetadataOnly={editPublishedMetadataOnly}
        versionId={versionId}
        lifecycle={editLifecycle}
        onLifecycleChange={setEditLifecycle}
        deprecationMessage={editDeprecationMessage}
        onDeprecationMessageChange={setEditDeprecationMessage}
        sunsetLocal={editSunsetLocal}
        onSunsetLocalChange={setEditSunsetLocal}
        successorRevisionId={editSuccessorRevisionId}
        onSuccessorRevisionIdChange={setEditSuccessorRevisionId}
        successorCandidates={successorCandidates}
        note={description}
        onNoteChange={setDescription}
        changelog={changeLog}
        onChangelogChange={setChangeLog}
        onSubmit={() => void handleEditSubmit()}
      />

      <SunsetScheduleDialog
        open={showSunsetScheduleDialog}
        onOpenChange={(open) => {
          if (isLoading) return;
          setShowSunsetScheduleDialog(open);
          if (!open) setErrorMessage('');
        }}
        busy={isLoading}
        error={errorMessage}
        version={selectedVersion}
        publishedMetadataOnly={editPublishedMetadataOnly}
        lifecycle={editLifecycle}
        onLifecycleChange={setEditLifecycle}
        deprecationMessage={editDeprecationMessage}
        onDeprecationMessageChange={setEditDeprecationMessage}
        sunsetLocal={editSunsetLocal}
        onSunsetLocalChange={setEditSunsetLocal}
        successorRevisionId={editSuccessorRevisionId}
        onSuccessorRevisionIdChange={setEditSuccessorRevisionId}
        successorCandidates={successorCandidates}
        onSubmit={() => void handleSunsetScheduleSubmit()}
      />

      {/* Publish Version Dialog */}
      <PublishVersionDialog
        open={showPublishDialog}
        onOpenChange={(open) => {
          setShowPublishDialog(open);
          if (!open) setPublishVersionId(null);
        }}
        version={publishVersion}
        projectSlug={selectedProject?.slug}
        visibility={publishVisibility}
        onVisibilityChange={setPublishVisibility}
        note={publishShortMessage}
        onNoteChange={setPublishShortMessage}
        changelog={publishChangelog}
        onChangelogChange={setPublishChangelog}
        force={publishForce}
        onForceChange={(next) => {
          setPublishForce(next);
          if (!next) setPublishForceReason('');
        }}
        forceReason={publishForceReason}
        onForceReasonChange={setPublishForceReason}
        onLintReportChange={(report) => setPublishLintReport(report)}
        onGuardrailChange={(guardrail) => setPublishBreakingGuardrail(guardrail)}
        onDecisionChange={setPublishVerificationDecision}
        blockers={{
          guideErrors: publishBlockedByGuideErrors,
          verificationPolicy: publishBlockedByVerificationPolicy,
          breakingGuardrail: publishBlockedByBreakingGuardrail,
          forceReasonMissing: publishForceReasonMissing,
        }}
        recommendedVersion={publishBreakingGuardrail?.recommendedVersion}
        changeReportEnabled={changeReportUiEnabled}
        changeReport={
          changeReportUiEnabled
            ? {
                baselineMode: publishChangeReportBaselineMode,
                onBaselineModeChange: (mode) => {
                  setPublishChangeReportBaselineMode(mode);
                  if (mode !== 'manual') setPublishManualBaselineRevisionId('');
                },
                manualBaselineRevisionId: publishManualBaselineRevisionId,
                onManualBaselineRevisionIdChange: setPublishManualBaselineRevisionId,
                manualBaselineOptions: publishManualBaselineOptions,
                previewLoading: publishPreviewLoading,
                previewError: publishPreviewError,
                preview: publishPreview,
                onRefreshPreview: () => void loadPublishPreview(),
              }
            : undefined
        }
        gitlike={GITLIKE}
        onSubmit={() => void handlePublishConfirm()}
      />

      {/* OpenAPI Viewer Dialog */}
      <SpecViewerDialog
        open={showOpenApiDialog}
        onOpenChange={setShowOpenApiDialog}
        version={viewingVersion}
        projectName={viewingProject?.name}
        projectSlug={viewingProject?.slug}
        spec={openApiSpec}
        loading={isLoadingSpec}
        format={openApiFormat}
        onFormatChange={setOpenApiFormat}
        recentExportsRefresh={recentExportsRefresh}
      />

      {/* Version-scoped ExportDialog (MFX-6.5, #3859) — the compact quick path, opened from a
          revision's row-menu "Export to another format…" action. (The version view's "Export this
          version" button and its target chips open the full Export Studio instead, MFX-41.3.)
          Mounted per revision so all stepper state resets when a different revision is exported. */}
      {exportVersion && (
        <ExportDialog
          open
          onClose={() => setExportVersion(null)}
          artifact={exportVersion.project_id}
          artifactLabel={projects.find((p) => p.id === exportVersion.project_id)?.name}
          version={exportVersion.id}
          studioOrigin="versions"
          onExported={(summary: ExportedArtifactSummary) => {
            // Feed the version view's recent-exports list (browser-local until MFX-46.1).
            recordRecentExport(exportVersion.project_id, exportVersion.id, summary);
            setRecentExportsRefresh((n) => n + 1);
          }}
        />
      )}

      {/* Version Comparison Dialog */}
      <Dialog open={showCompareDialog} onOpenChange={setShowCompareDialog}>
        <DialogContent className="max-w-6xl h-[90vh] min-h-[90vh] flex flex-col" aria-describedby={undefined}>
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center justify-between">
              <div>
                <div>Compare Version Schemas</div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mt-1 font-normal">View differences between two version specifications</div>
              </div>
              {diffResult.length > 0 && activeCompareTab === 'diff' && (
                <div className="flex gap-2">
                  <div className="flex border border-gray-300 dark:border-gray-600 rounded overflow-hidden">
                    <button onClick={() => setDiffViewMode('overlay')} className={`px-2 py-1 text-xs ${diffViewMode === 'overlay' ? 'bg-purple-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}>Overlay</button>
                    <button onClick={() => setDiffViewMode('side-by-side')} className={`px-2 py-1 text-xs border-l border-gray-300 dark:border-gray-600 ${diffViewMode === 'side-by-side' ? 'bg-purple-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}>Side-by-Side</button>
                  </div>
                  <SpecJsonYamlToggle value={compareFormat} onChange={handleCompareFormatChange} />
                </div>
              )}
              {diffResult.length > 0 && activeCompareTab === 'canvas' && (
                <div className="flex border border-gray-300 dark:border-gray-600 rounded overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setCanvasCompareViewMode('split')}
                    className={`px-2 py-1 text-xs ${canvasCompareViewMode === 'split' ? 'bg-teal-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}
                  >
                    Split
                  </button>
                  <button
                    type="button"
                    onClick={() => setCanvasCompareViewMode('overlay')}
                    className={`px-2 py-1 text-xs border-l border-gray-300 dark:border-gray-600 ${canvasCompareViewMode === 'overlay' ? 'bg-teal-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}
                  >
                    Overlay
                  </button>
                </div>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            {diffResult.length === 0 ? (
              <div className="space-y-4 p-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Version 1 (Base)</Label>
                    <Select
                      value={compareVersion1Id}
                      onValueChange={(id) => {
                        setCompareVersion1Id(id);
                        setCompareBaseTagId('');
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Select version..." /></SelectTrigger>
                      <SelectContent>{versions.map((v) => <SelectItem key={v.id} value={v.id}>{v.published ? '🔒 ' : ''}v{v.version_id}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Version 2 (Compare To)</Label>
                    <Select
                      value={compareVersion2Id}
                      onValueChange={(id) => {
                        setCompareVersion2Id(id);
                        setCompareToTagId('');
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Select version..." /></SelectTrigger>
                      <SelectContent>{versions.map((v) => <SelectItem key={v.id} value={v.id}>{v.published ? '🔒 ' : ''}v{v.version_id}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
                {versionTags.length > 0 && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Set base from tag</Label>
                      <Select
                        value={compareBaseTagId || '__none__'}
                        onValueChange={(id) => {
                          if (id === '__none__') {
                            setCompareBaseTagId('');
                            return;
                          }
                          setCompareBaseTagId(id);
                          const t = versionTags.find((x) => x.id === id);
                          if (t) setCompareVersion1Id(t.version_id);
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">—</SelectItem>
                          {versionTags.map((tg) => (
                            <SelectItem key={tg.id} value={tg.id}>
                              {tg.name} → v{tg.target_version_string ?? '?'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Set compare target from tag</Label>
                      <Select
                        value={compareToTagId || '__none__'}
                        onValueChange={(id) => {
                          if (id === '__none__') {
                            setCompareToTagId('');
                            return;
                          }
                          setCompareToTagId(id);
                          const t = versionTags.find((x) => x.id === id);
                          if (t) setCompareVersion2Id(t.version_id);
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">—</SelectItem>
                          {versionTags.map((tg) => (
                            <SelectItem key={tg.id} value={tg.id}>
                              {tg.name} → v{tg.target_version_string ?? '?'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                <div className="flex justify-center py-8">
                  <Button onClick={handleCompareVersions} disabled={!compareVersion1Id || !compareVersion2Id || isLoadingComparison}>{isLoadingComparison ? 'Loading...' : 'Compare Versions'}</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col h-full">
                {(() => {
                  const vBase = versions.find((v) => v.id === compareVersion1Id);
                  const vTo = versions.find((v) => v.id === compareVersion2Id);
                  if (!vBase || !vTo) return null;
                  const breakBase = extractBreakingHintsFromChangelog(vBase.changelog);
                  const breakTo = extractBreakingHintsFromChangelog(vTo.changelog);
                  return (
                    <div className="mb-4 space-y-3 flex-shrink-0">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40 p-3 text-sm">
                          <div className="font-semibold text-gray-900 dark:text-gray-100 mb-1">
                            v{vBase.version_id} (base)
                          </div>
                          <div className="text-gray-600 dark:text-gray-400">
                            <span className="text-gray-500 dark:text-gray-500">Revision note:</span>{' '}
                            {vBase.shortMessage?.trim() || '—'}
                          </div>
                          {vBase.changelog?.trim() ? (
                            <pre className="mt-2 whitespace-pre-wrap text-xs text-gray-700 dark:text-gray-300 font-sans max-h-32 overflow-y-auto">
                              {vBase.changelog}
                            </pre>
                          ) : (
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">No changelog</p>
                          )}
                          {breakBase.length > 0 && (
                            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                              Breaking hints: {breakBase.join(' · ')}
                            </p>
                          )}
                        </div>
                        <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40 p-3 text-sm">
                          <div className="font-semibold text-gray-900 dark:text-gray-100 mb-1">
                            v{vTo.version_id} (compare to)
                          </div>
                          <div className="text-gray-600 dark:text-gray-400">
                            <span className="text-gray-500 dark:text-gray-500">Revision note:</span>{' '}
                            {vTo.shortMessage?.trim() || '—'}
                          </div>
                          {vTo.changelog?.trim() ? (
                            <pre className="mt-2 whitespace-pre-wrap text-xs text-gray-700 dark:text-gray-300 font-sans max-h-32 overflow-y-auto">
                              {vTo.changelog}
                            </pre>
                          ) : (
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">No changelog</p>
                          )}
                          {breakTo.length > 0 && (
                            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                              Breaking hints: {breakTo.join(' · ')}
                            </p>
                          )}
                        </div>
                      </div>
                      {compareStoredChangelog?.maxSeverity ? (
                        <div
                          className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400"
                          data-testid="compare-stored-severity"
                        >
                          <span className="font-medium">Published classification:</span>
                          <Badge variant={severityBadgeVariant(compareStoredChangelog.maxSeverity)}>
                            {severityLabel(compareStoredChangelog.maxSeverity)}
                          </Badge>
                          {countsSummary(compareStoredChangelog.changelog?.counts) ? (
                            <span>{countsSummary(compareStoredChangelog.changelog?.counts)}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
                {/* Tab Navigation */}
                <div role="tablist" aria-label="Comparison views" className={cn(TAB_LIST_CLASS, 'mb-4')}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeCompareTab === 'diff'}
                    onClick={() => setActiveCompareTab('diff')}
                    className={tabTriggerClass({ active: activeCompareTab === 'diff' })}
                  >
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span>Diff View</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeCompareTab === 'summary'}
                    onClick={() => setActiveCompareTab('summary')}
                    className={tabTriggerClass({ active: activeCompareTab === 'summary' })}
                  >
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                      </svg>
                      <span>Schema Changes</span>
                      {schemaDiffSummary && (
                        <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300">
                          {classDiffRows
                            ? classDiffRows.filter((r) => r.status !== 'unchanged').length
                            : schemaDiffSummary.added.length +
                              schemaDiffSummary.removed.length +
                              schemaDiffSummary.modified.length}
                        </span>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeCompareTab === 'breaking'}
                    onClick={() => setActiveCompareTab('breaking')}
                    className={tabTriggerClass({ active: activeCompareTab === 'breaking' })}
                  >
                    <div className="flex items-center gap-2">
                      <ScrollText className="h-4 w-4" aria-hidden />
                      <span>Breaking doc</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeCompareTab === 'migration'}
                    onClick={() => setActiveCompareTab('migration')}
                    className={tabTriggerClass({ active: activeCompareTab === 'migration' })}
                  >
                    <div className="flex items-center gap-2">
                      <ListOrdered className="h-4 w-4" aria-hidden />
                      <span>Migration guide</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeCompareTab === 'canvas'}
                    onClick={() => setActiveCompareTab('canvas')}
                    className={tabTriggerClass({ active: activeCompareTab === 'canvas' })}
                  >
                    <div className="flex items-center gap-2">
                      <LayoutGrid className="h-4 w-4" aria-hidden />
                      <span>Canvas</span>
                    </div>
                  </button>
                </div>

                {/* Tab Content */}
                {activeCompareTab === 'diff' ? (
                  // Diff View Tab
                  <div>
                    <div className="flex items-center justify-between mb-2 pb-2 border-b border-gray-200 dark:border-gray-700">
                      <div className="flex gap-4 text-sm">
                        <div className="flex items-center gap-2"><div className="w-4 h-4 bg-red-200 dark:bg-red-900 border border-red-400"></div><span>Removed</span></div>
                        <div className="flex items-center gap-2"><div className="w-4 h-4 bg-green-200 dark:bg-green-900 border border-green-400"></div><span>Added</span></div>
                        <div className="flex items-center gap-2"><div className="w-4 h-4 bg-gray-100 dark:bg-gray-800 border border-gray-300"></div><span>Unchanged</span></div>
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">{formatVersionWithPrefix(versions.find(v => v.id === compareVersion1Id)?.version_id)} → {formatVersionWithPrefix(versions.find(v => v.id === compareVersion2Id)?.version_id)}</div>
                    </div>
                    <div className="border border-gray-300 dark:border-gray-600 rounded font-mono text-xs h-[calc(90vh-280px)]">
                      {diffViewMode === 'overlay' ? (
                        // Overlay/Unified diff view
                        <div className="h-full overflow-y-auto">
                          {diffResult.map((part, i) => (
                            <div key={i} className={part.added ? 'bg-green-100 dark:bg-green-900/30 text-green-900 dark:text-green-200' : part.removed ? 'bg-red-100 dark:bg-red-900/30 text-red-900 dark:text-red-200' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'}>
                              {part.value.split('\n').filter(Boolean).map((line, j) => (
                                <div key={j} className="px-3 py-0.5" style={{ whiteSpace: 'pre-wrap' }}>
                                  {part.added && '+ '}{part.removed && '- '}{line}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      ) : (
                        // Side-by-side view
                        <div className="flex h-full">
                          {/* Left panel - Version 1 (Base) */}
                          <div
                            ref={leftPanelRef}
                            onScroll={handleLeftScroll}
                            className="w-1/2 border-r border-gray-300 dark:border-gray-600 h-full overflow-y-auto"
                          >
                            <div className="sticky top-0 bg-gray-100 dark:bg-gray-700 px-3 py-1 text-xs font-semibold border-b border-gray-300 dark:border-gray-600 z-10">
                              v{versions.find(v => v.id === compareVersion1Id)?.version_id} (Base)
                            </div>
                            {(() => {
                              const content1 = compareFormat === 'json' ? compareSpec1 : YAML.stringify(JSON.parse(compareSpec1));
                              return content1.split('\n').map((line, i) => {
                                const isRemoved = diffResult.some(part => part.removed && part.value.includes(line));
                                return (
                                  <div
                                    key={i}
                                    className={`px-3 py-0.5 ${isRemoved ? 'bg-red-100 dark:bg-red-900/30 text-red-900 dark:text-red-200' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
                                    style={{ whiteSpace: 'pre-wrap' }}
                                  >
                                    <span className="text-gray-400 dark:text-gray-500 select-none mr-2 inline-block w-8 text-right">{i + 1}</span>
                                    {line || ' '}
                                  </div>
                                );
                              });
                            })()}
                          </div>
                          {/* Right panel - Version 2 (Compare To) */}
                          <div
                            ref={rightPanelRef}
                            onScroll={handleRightScroll}
                            className="w-1/2 h-full overflow-y-auto"
                          >
                            <div className="sticky top-0 bg-gray-100 dark:bg-gray-700 px-3 py-1 text-xs font-semibold border-b border-gray-300 dark:border-gray-600 z-10">
                              v{versions.find(v => v.id === compareVersion2Id)?.version_id} (Compare To)
                            </div>
                            {(() => {
                              const content2 = compareFormat === 'json' ? compareSpec2 : YAML.stringify(JSON.parse(compareSpec2));
                              return content2.split('\n').map((line, i) => {
                                const isAdded = diffResult.some(part => part.added && part.value.includes(line));
                                return (
                                  <div
                                    key={i}
                                    className={`px-3 py-0.5 ${isAdded ? 'bg-green-100 dark:bg-green-900/30 text-green-900 dark:text-green-200' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
                                    style={{ whiteSpace: 'pre-wrap' }}
                                  >
                                    <span className="text-gray-400 dark:text-gray-500 select-none mr-2 inline-block w-8 text-right">{i + 1}</span>
                                    {line || ' '}
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : activeCompareTab === 'summary' ? (
                  // Schema Changes Summary Tab
                  <div className="h-[calc(90vh-280px)] overflow-y-auto">
                    {schemaDiffSummary && (
                  <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                    {classDiffRows && classDiffCounts && (
                      <div className="mb-6 pb-6 border-b border-gray-200 dark:border-gray-700">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-3">
                          <div>
                            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Classes</h3>
                            <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                              Structural diff (git-style). Stable ID = OpenAPI schema name.{' '}
                              <span className="text-green-700 dark:text-green-400">+{classDiffCounts.added}</span>
                              {' · '}
                              <span className="text-red-700 dark:text-red-400">−{classDiffCounts.removed}</span>
                              {' · '}
                              <span className="text-yellow-700 dark:text-yellow-400">~{classDiffCounts.modified}</span>
                              {' · '}
                              <span className="text-gray-600 dark:text-gray-500">{classDiffCounts.unchanged} unchanged</span>
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              className="text-xs h-8"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(formatClassDiffStatLines(classDiffRows));
                                  toast.success('Class diff copied to clipboard');
                                } catch {
                                  toast.error('Failed to copy class diff to clipboard');
                                }
                              }}
                            >
                              Copy class stat
                            </Button>
                          </div>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2 mb-2">
                          <Input
                            type="search"
                            placeholder="Search classes…"
                            value={classDiffSearch}
                            onChange={(e) => setClassDiffSearch(e.target.value)}
                            className="text-sm h-9 flex-1 min-w-0"
                            aria-label="Filter classes by name"
                          />
                          <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap shrink-0">
                            <input
                              type="checkbox"
                              className="rounded border-gray-300 dark:border-gray-600"
                              checked={classDiffShowUnchanged}
                              onChange={(e) => setClassDiffShowUnchanged(e.target.checked)}
                            />
                            Show unchanged
                          </label>
                        </div>
                        <p className="text-2xs text-gray-500 dark:text-gray-500 mb-1">
                          Showing {filteredClassDiffRows.length} of {classDiffRows.length} classes
                          {classDiffListRender.virtualize ? ' · Virtualized list' : ''}
                        </p>
                        <div
                          ref={classListScrollRef}
                          className="max-h-72 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-950"
                          style={
                            classDiffListRender.virtualize ? { height: CLASS_DIFF_VIEWPORT_PX } : undefined
                          }
                          onScroll={(e) => setClassListScrollTop(e.currentTarget.scrollTop)}
                        >
                          <div style={{ height: classDiffListRender.padTop }} aria-hidden />
                          {classDiffListRender.rows.map((row) => {
                            const sym =
                              row.status === 'added'
                                ? '+'
                                : row.status === 'removed'
                                  ? '−'
                                  : row.status === 'modified'
                                    ? '~'
                                    : ' ';
                            const rowBg =
                              row.status === 'added'
                                ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900 border-l-green-600'
                                : row.status === 'removed'
                                  ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 border-l-red-600'
                                  : row.status === 'modified'
                                    ? 'bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-900 border-l-yellow-500'
                                    : 'bg-gray-50 dark:bg-gray-900/40 border-gray-200 dark:border-gray-700 border-l-gray-400';
                            const expanded = expandedClassDiffId === row.stableId;
                            const drill = expanded ? getClassChangeDiffs(schemaDiffSummary, row.stableId) : [];
                            const showAllProps = propDrillShowAllByClass[row.stableId] === true;
                            const drillVisible =
                              drill.length <= CLASS_PROP_DRILL_LIMIT || showAllProps
                                ? drill
                                : drill.slice(0, CLASS_PROP_DRILL_LIMIT);
                            return (
                              <div
                                key={row.stableId}
                                id={`class-diff-row-${row.stableId}`}
                                className="border-b border-gray-100 dark:border-gray-800 last:border-b-0"
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedClassDiffId((id) => (id === row.stableId ? null : row.stableId))
                                  }
                                  className={`w-full text-left px-3 py-2 flex items-center gap-2 border-l-4 ${rowBg} hover:opacity-95 transition-opacity`}
                                  style={{ minHeight: CLASS_DIFF_ROW_PX }}
                                  aria-expanded={expanded}
                                >
                                  <span
                                    className={`font-mono text-xs w-4 shrink-0 ${
                                      row.status === 'added'
                                        ? 'text-green-700 dark:text-green-400'
                                        : row.status === 'removed'
                                          ? 'text-red-700 dark:text-red-400'
                                          : row.status === 'modified'
                                            ? 'text-yellow-800 dark:text-yellow-300'
                                            : 'text-gray-400 dark:text-gray-500'
                                    }`}
                                  >
                                    {sym}
                                  </span>
                                  <span className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex-1">
                                    {row.stableId}
                                  </span>
                                  {storedBreakingIds.has(row.stableId) && (
                                    <Badge variant="error" data-testid={`class-diff-breaking-${row.stableId}`}>
                                      Breaking
                                    </Badge>
                                  )}
                                  {row.status === 'modified' && (
                                    <span className="text-2xs text-gray-600 dark:text-gray-400 shrink-0 hidden sm:inline">
                                      {row.propertyAdded ? `+${row.propertyAdded} ` : ''}
                                      {row.propertyRemoved ? `−${row.propertyRemoved} ` : ''}
                                      {row.propertyModified ? `~${row.propertyModified} ` : ''}
                                      {row.schemaChanges?.length ? `schema ${row.schemaChanges.join(', ')}` : ''}
                                    </span>
                                  )}
                                  {row.status === 'added' && (
                                    <span className="text-2xs text-green-800 dark:text-green-300 shrink-0">
                                      +{row.propertyAdded} props
                                    </span>
                                  )}
                                  {row.status === 'removed' && (
                                    <span className="text-2xs text-red-800 dark:text-red-300 shrink-0">
                                      −{row.propertyRemoved} props
                                    </span>
                                  )}
                                </button>
                                {expanded && drill.length > 0 && (
                                  <div className="px-3 pb-3 pt-0 space-y-1 bg-gray-50/80 dark:bg-gray-900/50 border-t border-dashed border-gray-200 dark:border-gray-700">
                                    <p className="text-2xs font-medium text-gray-600 dark:text-gray-400 pt-2">
                                      Property-level changes
                                    </p>
                                    {drillVisible.map((d, i) => (
                                      <div
                                        key={`${d.path}-${d.type}-${i}`}
                                        className={`text-xs rounded px-2 py-1 font-mono flex flex-wrap gap-x-2 items-start ${
                                          d.type === 'added'
                                            ? 'bg-green-50 dark:bg-green-950/20 text-green-900 dark:text-green-100'
                                            : d.type === 'removed'
                                              ? 'bg-red-50 dark:bg-red-950/20 text-red-900 dark:text-red-100'
                                              : 'bg-yellow-50 dark:bg-yellow-950/20 text-yellow-900 dark:text-yellow-100'
                                        }`}
                                      >
                                        <span className="shrink-0 pt-px">
                                          {d.type === 'added' ? '+' : d.type === 'removed' ? '−' : '~'}
                                        </span>
                                        <span className="min-w-0 break-words">{formatPropertyDiffLine(d)}</span>
                                      </div>
                                    ))}
                                    {drill.length > CLASS_PROP_DRILL_LIMIT && (
                                      <button
                                        type="button"
                                        className="text-2xs text-indigo-600 dark:text-indigo-400 hover:underline mt-1"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setPropDrillShowAllByClass((prev) => ({
                                            ...prev,
                                            [row.stableId]: !showAllProps,
                                          }));
                                        }}
                                      >
                                        {showAllProps
                                          ? `Show first ${CLASS_PROP_DRILL_LIMIT} only`
                                          : `Show all ${drill.length} changes`}
                                      </button>
                                    )}
                                  </div>
                                )}
                                {expanded && drill.length === 0 && row.status === 'unchanged' && (
                                  <p className="text-2xs text-gray-500 px-3 pb-2">No property-level changes.</p>
                                )}
                              </div>
                            );
                          })}
                          <div style={{ height: classDiffListRender.padBottom }} aria-hidden />
                        </div>
                      </div>
                    )}
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Schema Changes Summary</h3>

                      {/* Filter Controls */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-600 dark:text-gray-400 mr-1">Filter:</span>
                        <button
                          onClick={() => setDiffFilter(prev => ({ ...prev, showAdded: !prev.showAdded }))}
                          className={`px-2 py-1 text-xs rounded border transition-all flex items-center gap-1.5 ${
                            diffFilter.showAdded
                              ? 'bg-green-600 dark:bg-green-700 text-white border-green-700 dark:border-green-600 shadow-sm'
                              : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-500 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700'
                          }`}
                          title={diffFilter.showAdded ? 'Hide additions' : 'Show additions'}
                        >
                          {diffFilter.showAdded && (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                          <span>+ Added ({schemaDiffSummary.added.length})</span>
                        </button>
                        <button
                          onClick={() => setDiffFilter(prev => ({ ...prev, showRemoved: !prev.showRemoved }))}
                          className={`px-2 py-1 text-xs rounded border transition-all flex items-center gap-1.5 ${
                            diffFilter.showRemoved
                              ? 'bg-red-600 dark:bg-red-700 text-white border-red-700 dark:border-red-600 shadow-sm'
                              : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-500 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700'
                          }`}
                          title={diffFilter.showRemoved ? 'Hide removals' : 'Show removals'}
                        >
                          {diffFilter.showRemoved && (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                          <span>- Removed ({schemaDiffSummary.removed.length})</span>
                        </button>
                        <button
                          onClick={() => setDiffFilter(prev => ({ ...prev, showModified: !prev.showModified }))}
                          className={`px-2 py-1 text-xs rounded border transition-all flex items-center gap-1.5 ${
                            diffFilter.showModified
                              ? 'bg-yellow-600 dark:bg-yellow-700 text-white border-yellow-700 dark:border-yellow-600 shadow-sm'
                              : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-500 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700'
                          }`}
                          title={diffFilter.showModified ? 'Hide modifications' : 'Show modifications'}
                        >
                          {diffFilter.showModified && (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                          <span>~ Modified ({schemaDiffSummary.modified.length})</span>
                        </button>
                        {/* Reset filter button */}
                        {(!diffFilter.showAdded || !diffFilter.showRemoved || !diffFilter.showModified) && (
                          <button
                            onClick={() => setDiffFilter({ showAdded: true, showRemoved: true, showModified: true })}
                            className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
                            title="Show all changes"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg border border-green-200 dark:border-green-800">
                        <div className="text-2xl font-bold text-green-600 dark:text-green-400">{schemaDiffSummary.added.length}</div>
                        <div className="text-xs text-green-700 dark:text-green-300">Added</div>
                      </div>
                      <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                        <div className="text-2xl font-bold text-red-600 dark:text-red-400">{schemaDiffSummary.removed.length}</div>
                        <div className="text-xs text-red-700 dark:text-red-300">Removed</div>
                      </div>
                      <div className="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded-lg border border-yellow-200 dark:border-yellow-800">
                        <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">{schemaDiffSummary.modified.length}</div>
                        <div className="text-xs text-yellow-700 dark:text-yellow-300">Modified</div>
                      </div>
                    </div>

                    {/* Detailed changes */}
                    <div className="space-y-4">
                      {/* Empty state when all filters are off or no matching changes */}
                      {(!diffFilter.showAdded && !diffFilter.showRemoved && !diffFilter.showModified) ? (
                        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                          <div className="text-sm">All change types are filtered out</div>
                          <div className="text-xs mt-1">Enable at least one filter to see changes</div>
                        </div>
                      ) : (
                        (diffFilter.showAdded && schemaDiffSummary.added.length === 0) &&
                        (diffFilter.showRemoved && schemaDiffSummary.removed.length === 0) &&
                        (diffFilter.showModified && schemaDiffSummary.modified.length === 0) &&
                        (!diffFilter.showAdded || schemaDiffSummary.added.length === 0) &&
                        (!diffFilter.showRemoved || schemaDiffSummary.removed.length === 0) &&
                        (!diffFilter.showModified || schemaDiffSummary.modified.length === 0)
                      ) ? (
                        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                          <div className="text-sm">No changes match the current filter</div>
                        </div>
                      ) : null}

                      {/* Added items */}
                      {diffFilter.showAdded && schemaDiffSummary.added.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-green-700 dark:text-green-300 mb-2 flex items-center gap-2">
                            <span className="inline-block w-2 h-2 bg-green-500 rounded-full"></span>
                            Added ({schemaDiffSummary.added.length})
                          </h4>
                          <div className="space-y-1">
                            {schemaDiffSummary.added.map((diff, idx) => (
                              <div key={idx} className="flex items-center gap-2 text-sm bg-green-50 dark:bg-green-900/10 px-3 py-1.5 rounded border border-green-200 dark:border-green-800">
                                <span className="text-green-600 dark:text-green-400 font-mono text-xs">+</span>
                                <span className="text-green-900 dark:text-green-100 font-medium">{getPathLabel(diff.path)}</span>
                                <span className="text-green-700 dark:text-green-300 text-xs">({diff.itemType})</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Removed items */}
                      {diffFilter.showRemoved && schemaDiffSummary.removed.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-red-700 dark:text-red-300 mb-2 flex items-center gap-2">
                            <span className="inline-block w-2 h-2 bg-red-500 rounded-full"></span>
                            Removed ({schemaDiffSummary.removed.length})
                          </h4>
                          <div className="space-y-1">
                            {schemaDiffSummary.removed.map((diff, idx) => (
                              <div key={idx} className="flex items-center gap-2 text-sm bg-red-50 dark:bg-red-900/10 px-3 py-1.5 rounded border border-red-200 dark:border-red-800">
                                <span className="text-red-600 dark:text-red-400 font-mono text-xs">-</span>
                                <span className="text-red-900 dark:text-red-100 font-medium">{getPathLabel(diff.path)}</span>
                                <span className="text-red-700 dark:text-red-300 text-xs">({diff.itemType})</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Modified items */}
                      {diffFilter.showModified && schemaDiffSummary.modified.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-yellow-700 dark:text-yellow-300 mb-2 flex items-center gap-2">
                            <span className="inline-block w-2 h-2 bg-yellow-500 rounded-full"></span>
                            Modified ({schemaDiffSummary.modified.length})
                          </h4>
                          <div className="space-y-1">
                            {schemaDiffSummary.modified.map((diff, idx) => (
                              <div key={idx} className="flex items-start gap-2 text-sm bg-yellow-50 dark:bg-yellow-900/10 px-3 py-1.5 rounded border border-yellow-200 dark:border-yellow-800">
                                <span className="text-yellow-600 dark:text-yellow-400 font-mono text-xs mt-0.5">~</span>
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-yellow-900 dark:text-yellow-100 font-medium">{getPathLabel(diff.path)}</span>
                                    <span className="text-yellow-700 dark:text-yellow-300 text-xs">({diff.itemType})</span>
                                  </div>
                                  {diff.changes && diff.changes.length > 0 && (
                                    <div className="text-xs text-yellow-700 dark:text-yellow-400 mt-1">
                                      Changed: {diff.changes.join(', ')}
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                    )}
                  </div>
                ) : activeCompareTab === 'breaking' ? (
                  <div className="h-[calc(90vh-280px)] overflow-y-auto flex flex-col gap-3 p-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between shrink-0">
                      <p className="text-xs text-gray-600 dark:text-gray-400 max-w-prose">
                        Generated from the schema diff. Stable identifiers use{' '}
                        <span className="font-mono text-2xs">components.schemas…</span> paths. The same revision pair always yields the same text (template version is in the header).
                      </p>
                      <div className="flex flex-wrap gap-2 shrink-0">
                        <Button
                          type="button"
                          variant="outline"
                          className="text-xs h-8"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(breakingChangesMarkdown);
                              toast.success('Breaking-changes doc copied');
                            } catch {
                              toast.error('Copy failed');
                            }
                          }}
                          disabled={!breakingChangesMarkdown}
                        >
                          Copy
                        </Button>
                        <Button
                          type="button"
                          variant="default"
                          className="text-xs h-8"
                          onClick={appendBreakingDocToCompareTargetChangelog}
                          disabled={!breakingChangesMarkdown}
                        >
                          Append to compare-to changelog
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      readOnly
                      className="flex-1 min-h-[min(420px,50vh)] font-mono text-xs"
                      value={breakingChangesMarkdown}
                      placeholder="Compare two versions to generate breaking-changes Markdown."
                      aria-label="Generated breaking changes markdown"
                    />
                  </div>
                ) : activeCompareTab === 'migration' ? (
                  <div className="h-[calc(90vh-280px)] overflow-y-auto flex flex-col gap-3 p-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between shrink-0">
                      <p className="text-xs text-gray-600 dark:text-gray-400 max-w-prose">
                        Ordered steps for <strong className="font-medium text-gray-800 dark:text-gray-200">breaking</strong>{' '}
                        contract changes, tied to this revision pair. Companion to the{' '}
                        <strong className="font-medium text-gray-800 dark:text-gray-200">Breaking doc</strong> tab (#746) and
                        compatibility checks (#506). Template version is in the header; edit the Markdown after export if
                        needed (#502).
                      </p>
                      <div className="flex flex-wrap gap-2 shrink-0">
                        <Button
                          type="button"
                          variant="outline"
                          className="text-xs h-8"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(migrationGuideMarkdown);
                              toast.success('Migration guide copied');
                            } catch {
                              toast.error('Copy failed');
                            }
                          }}
                          disabled={!migrationGuideMarkdown}
                        >
                          Copy
                        </Button>
                        <Button
                          type="button"
                          variant="default"
                          className="text-xs h-8"
                          onClick={appendMigrationGuideToCompareTargetChangelog}
                          disabled={!migrationGuideMarkdown}
                        >
                          Append to compare-to changelog
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="text-xs h-8"
                          onClick={downloadMigrationGuideMarkdownFile}
                          disabled={!migrationGuideMarkdown}
                        >
                          Download Markdown
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="text-xs h-8"
                          onClick={() => {
                            const vBase = versions.find((v) => v.id === compareVersion1Id);
                            const vTo = versions.find((v) => v.id === compareVersion2Id);
                            const proj = projects.find((p) => p.id === selectedProjectId);
                            downloadMigrationGuidePdf({
                              body: migrationGuideMarkdown,
                              projectName: proj?.name ?? 'Project',
                              baseVersionLabel: vBase ? `v${vBase.version_id}` : 'base',
                              targetVersionLabel: vTo ? `v${vTo.version_id}` : 'target',
                            });
                            toast.success('PDF downloaded');
                          }}
                          disabled={!migrationGuideMarkdown}
                        >
                          Download PDF
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      readOnly
                      className="flex-1 min-h-[min(420px,50vh)] font-mono text-xs"
                      value={migrationGuideMarkdown}
                      placeholder="Compare two versions to generate a migration guide."
                      aria-label="Generated migration guide markdown"
                    />
                  </div>
                ) : (
                  <div className="h-[calc(90vh-280px)] overflow-y-auto px-1 pt-1">
                    {canvasCompareLoading ? (
                      <LoadingState
                        className="min-h-[min(380px,45vh)] w-full py-8"
                        minHeightClassName="min-h-[min(380px,45vh)]"
                        spinnerSize="md"
                        message="Loading canvas layouts…"
                      />
                    ) : (
                      <VersionCanvasCompare
                        left={canvasCompareLeft}
                        right={canvasCompareRight}
                        leftLabel={`v${versions.find((v) => v.id === compareVersion1Id)?.version_id ?? '?'} (base)`}
                        rightLabel={`v${versions.find((v) => v.id === compareVersion2Id)?.version_id ?? '?'} (compare)`}
                        mode={canvasCompareViewMode}
                        diff={canvasCompareDiff}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="flex-shrink-0">
            {diffResult.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  setDiffResult([]);
                  setCompareSpec1('');
                  setCompareSpec2('');
                  setSchemaDiffSummary(null);
                  setClassDiffRows(null);
                  setClassDiffSearch('');
                  setExpandedClassDiffId(null);
                  setPropDrillShowAllByClass({});
                  setCanvasCompareLeft(null);
                  setCanvasCompareRight(null);
                  setCanvasCompareDiff(null);
                  setCanvasComparePairKey('');
                  setActiveCompareTab('diff');
                }}
              >
                Compare Different Versions
              </Button>
            )}
            <Button variant="outline" onClick={() => setShowCompareDialog(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={FEATURE_GITLIKE && showForkDialog} onOpenChange={(open) => !forkSaving && setShowForkDialog(open)}>
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Fork to another project</DialogTitle>
            <DialogDescription>
              Create an isolated copy of this revision in a different project. Edits stay separate from the upstream line until you merge or publish intentionally.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="fork-target-project">Target project</Label>
              <Select value={forkTargetProjectId} onValueChange={setForkTargetProjectId}>
                <SelectTrigger id="fork-target-project">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {otherProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Version ID</Label>
              <Select
                value={forkAutoGenerate ? 'auto' : 'manual'}
                onValueChange={(v) => {
                  const isAuto = v === 'auto';
                  setForkAutoGenerate(isAuto);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-generate in target project</SelectItem>
                  <SelectItem value="manual">Manual entry</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {forkAutoGenerate ? (
              <div className="space-y-1">
                <Label>Bump strategy</Label>
                <Select value={forkBumpStrategy} onValueChange={(v) => setForkBumpStrategy(v as 'patch' | 'minor')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="patch">Patch — next {forkPreviewNext || '…'}</SelectItem>
                    <SelectItem value="minor">Minor — next minor in target</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="fork-version-id">Version ID (semantic)</Label>
                <Input
                  id="fork-version-id"
                  value={forkVersionId}
                  onChange={(e) => setForkVersionId(e.target.value)}
                  placeholder="e.g. 1.0.0"
                  autoComplete="off"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="fork-short">Revision note</Label>
              <Input
                id="fork-short"
                value={forkDescription}
                onChange={(e) => setForkDescription(e.target.value)}
                placeholder="Short message"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fork-changelog">Changelog (optional)</Label>
              <Textarea
                id="fork-changelog"
                value={forkChangeLog}
                onChange={(e) => setForkChangeLog(e.target.value)}
                placeholder="Markdown release notes"
                rows={3}
                className="resize-y min-h-[72px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForkDialog(false)} disabled={forkSaving}>
              Cancel
            </Button>
            <Button onClick={handleForkSubmit} disabled={forkSaving || !forkTargetProjectId}>
              {forkSaving ? 'Creating…' : 'Create fork'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={FEATURE_GITLIKE && showBranchDialog} onOpenChange={(open) => !branchSaving && setShowBranchDialog(open)}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Create named branch</DialogTitle>
            <DialogDescription>
              Point a new branch name at this version snapshot in this project. Further work can advance the tip via merge workflows.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="branch-name">Branch name</Label>
              <Input
                id="branch-name"
                value={branchNameInput}
                onChange={(e) => setBranchNameInput(e.target.value)}
                placeholder="e.g. feature/payments"
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBranchDialog(false)} disabled={branchSaving}>
              Cancel
            </Button>
            <Button onClick={handleCreateBranchSubmit} disabled={branchSaving || !branchNameInput.trim()}>
              {branchSaving ? 'Saving…' : 'Create branch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={FEATURE_GITLIKE && showTagDialog} onOpenChange={(open) => !tagSaving && setShowTagDialog(open)}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Create version tag</DialogTitle>
            <DialogDescription>
              Attach a stable name to this schema revision (like <span className="font-mono">v1.0</span> or{' '}
              <span className="font-mono">stable</span>). Immutable tags cannot be moved or deleted afterward.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="tag-name">Tag name</Label>
              <Input
                id="tag-name"
                value={tagNameInput}
                onChange={(e) => setTagNameInput(e.target.value)}
                placeholder="e.g. v1.0.0 or stable"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tag-msg">Message (optional)</Label>
              <Input
                id="tag-msg"
                value={tagMessageInput}
                onChange={(e) => setTagMessageInput(e.target.value)}
                placeholder="Release notes or annotation"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tag-channel">Channel (optional)</Label>
              <Input
                id="tag-channel"
                value={tagChannelInput}
                onChange={(e) => setTagChannelInput(e.target.value)}
                placeholder="e.g. stable, beta"
                autoComplete="off"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={tagImmutable}
                onChange={(e) => setTagImmutable(e.target.checked)}
                className="rounded border-gray-300 dark:border-gray-600"
              />
              Lock tag (immutable — cannot move or delete)
            </label>
            {effectiveIsAdmin && (
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tagProtected}
                  onChange={(e) => setTagProtected(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600"
                />
                Protected (only tenant admins can move or delete)
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTagDialog(false)} disabled={tagSaving}>
              Cancel
            </Button>
            <Button onClick={handleCreateTagSubmit} disabled={tagSaving || !tagNameInput.trim()}>
              {tagSaving ? 'Saving…' : 'Create tag'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={FEATURE_GITLIKE && showMergeDialog}
        onOpenChange={(open) => {
          if (!open) {
            setMergeCompat(null);
            setMergeCompatGateOverride(false);
            setMergeCompatGateOverrideReason('');
          }
          if (!mergePreviewLoading && !mergeApplyLoading) setShowMergeDialog(open);
        }}
      >
        <DialogContent className="max-w-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Merge branches</DialogTitle>
            <DialogDescription>
              Preview uses a three-way merge of OpenAPI components against the merge-base (LCA) revision. Run Preview merge before Apply — when conflicts exist, choose a resolution for every path before applying.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Source branch</Label>
              <Select value={mergeSourceBranch || '__pick__'} onValueChange={(v) => setMergeSourceBranch(v === '__pick__' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Choose branch" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__pick__">Choose branch</SelectItem>
                  {versionBranches.map((b) => (
                    <SelectItem key={b.id} value={b.name}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Target branch</Label>
              <Select value={mergeTargetBranch || '__pick__'} onValueChange={(v) => setMergeTargetBranch(v === '__pick__' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Choose branch" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__pick__">Choose branch</SelectItem>
                  {versionBranches.map((b) => (
                    <SelectItem key={`t-${b.id}`} value={b.name}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mergePreviewData?.classification && (
              <Alert variant={mergePreviewData.classification.canAutoMerge ? 'success' : 'error'}>
                {mergePreviewData.classification.canAutoMerge
                  ? 'No overlapping modified or removed paths — apply is allowed if the target tip has not moved.'
                  : `Conflicts: ${mergePreviewData.classification.conflictPaths.length} path(s). Apply stays disabled until every conflict row has a resolution (mine / theirs / manual).`}
              </Alert>
            )}
            {mergePreviewData?.classification &&
              !mergePreviewData.classification.canAutoMerge &&
              mergeConflictRows.length > 0 && (
                <VersionMergeConflictList
                  conflicts={mergeConflictRows}
                  targetBranchName={mergeTargetBranch.trim()}
                  sourceBranchName={mergeSourceBranch.trim()}
                  resolutions={mergeConflictResolutions}
                  onResolve={handleMergeConflictResolve}
                  onBulkResolve={handleMergeConflictBulkResolve}
                />
              )}
            {mergePreviewData?.mergeBaseVersionId != null && mergePreviewData?.classification && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Merge-base revision: <span className="font-mono">{mergePreviewData.mergeBaseVersionId}</span>
              </p>
            )}
            {mergeCompatLoading && (
              <p className="text-xs text-gray-500 dark:text-gray-400">Checking backward compatibility (target tip → source tip)…</p>
            )}
            {mergeCompat && !mergeCompatLoading && (
              <Alert
                variant={
                  mergeCompat.overall === 'safe'
                    ? 'success'
                    : mergeCompat.overall === 'unknown'
                      ? 'default'
                      : 'error'
                }
              >
                <span className="font-medium text-sm">Backward compatibility (target tip → source tip)</span>
                <div className="mt-2">
                  <CompatibilityReportPanel
                    overall={mergeCompat.overall}
                    findings={mergeCompat.findings}
                    ruleHits={mergeCompat.ruleHits}
                    docUrl={mergeCompat.breakingChangeDocumentationIssueUrl ?? undefined}
                    intro={
                      <span>
                        Compares generated OpenAPI for <strong>target tip</strong> (base) vs <strong>source tip</strong> (head).
                        Merge execution uses the three-way engine plus an optional project compatibility gate on the merged result.
                      </span>
                    }
                  />
                  <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
                    <ExternalCompatEvidencePanel
                      projectId={selectedProjectId}
                      baseRevisionId={mergePreviewData?.targetTipVersionId}
                      headRevisionId={mergePreviewData?.sourceTipVersionId}
                    />
                  </div>
                </div>
                {mergeCompat.mergeBlockedByCompatGate && (
                  <p className="text-xs mt-2 text-amber-800 dark:text-amber-200">
                    Project metadata enables compat gating — merge is blocked until compatibility is safe, unless a tenant
                    administrator overrides with a written justification (recorded in the workflow audit log).
                  </p>
                )}
                {mergeCompat.mergeBlockedByCompatGate && effectiveIsAdmin ? (
                  <div className="mt-3 space-y-2 border-t border-amber-200/60 dark:border-amber-800/40 pt-3">
                    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={mergeCompatGateOverride}
                        onChange={(e) => {
                          setMergeCompatGateOverride(e.target.checked);
                          if (!e.target.checked) {
                            setMergeCompatGateOverrideReason('');
                          }
                        }}
                        className="rounded border-gray-300 dark:border-gray-600 mt-0.5"
                      />
                      <span>
                        Override compatibility gate (tenant admin) — required when the gate blocks merge due to unsafe
                        target/source pair analysis
                      </span>
                    </label>
                    {mergeCompatGateOverride ? (
                      <div className="space-y-1">
                        <Label htmlFor="merge-compat-override-reason">Justification *</Label>
                        <Textarea
                          id="merge-compat-override-reason"
                          value={mergeCompatGateOverrideReason}
                          onChange={(e) => setMergeCompatGateOverrideReason(e.target.value)}
                          rows={3}
                          placeholder="Explain why merge should proceed despite the compatibility gate (audit record)"
                          className="text-sm"
                          aria-invalid={
                            mergeCompatGateOverride && mergeCompatGateOverrideReason.trim().length === 0
                          }
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Alert>
            )}
          </div>
          <DialogFooter className="gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setShowMergeDialog(false)} disabled={mergePreviewLoading || mergeApplyLoading}>
              Close
            </Button>
            <Button variant="secondary" onClick={runMergePreview} disabled={mergePreviewLoading || mergeApplyLoading || !mergeSourceBranch || !mergeTargetBranch}>
              {mergePreviewLoading ? 'Previewing…' : 'Preview merge'}
            </Button>
            <Button
              onClick={runMergeApply}
              disabled={
                mergeApplyLoading ||
                mergePreviewLoading ||
                mergeCompatLoading ||
                !mergeSourceBranch ||
                !mergeTargetBranch ||
                !mergePreviewMatchesBranches ||
                mergeHasEngineConflicts ||
                (mergeCompat?.mergeBlockedByCompatGate === true &&
                  !(
                    effectiveIsAdmin &&
                    mergeCompatGateOverride &&
                    mergeCompatGateOverrideReason.trim().length > 0
                  ))
              }
            >
              {mergeApplyLoading ? 'Merging…' : 'Apply merge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={FEATURE_GITLIKE && showRollbackDialog}
        onOpenChange={(open) => {
          if (!rollbackPreviewLoading && !rollbackApplyLoading) {
            setShowRollbackDialog(open);
            if (!open) {
              setRollbackPreview(null);
              setShowRollbackConfirmAlert(false);
            }
          }
        }}
      >
        <DialogContent className="max-w-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Rollback branch (revert-style)</DialogTitle>
            <DialogDescription>
              Creates a <strong>new</strong> revision whose schema matches the selected row; the branch tip moves forward
              with <span className="font-mono">parent</span> pointing at the prior head. History is not rewritten.
              {rollbackTargetVersion ? (
                <span className="block mt-2 text-gray-700 dark:text-gray-300">
                  Restore snapshot from <span className="font-mono">{formatVersionWithPrefix(rollbackTargetVersion.version_id)}</span>
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Branch to update</Label>
              <Select
                value={rollbackBranchName || '__pick__'}
                onValueChange={(v) => setRollbackBranchName(v === '__pick__' ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose branch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__pick__">Choose branch</SelectItem>
                  {versionBranches.map((b) => (
                    <SelectItem key={`rb-${b.id}`} value={b.name}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rollback-msg">Revision note (optional)</Label>
              <Input
                id="rollback-msg"
                value={rollbackShortMessage}
                onChange={(e) => setRollbackShortMessage(e.target.value)}
                placeholder="Defaults to a rollback summary"
                autoComplete="off"
              />
            </div>
            {rollbackPreview && (
              <>
                <Alert
                  variant={
                    rollbackPreview.compatOverall === 'safe'
                      ? 'success'
                      : rollbackPreview.compatOverall === 'unknown'
                        ? 'default'
                        : 'error'
                  }
                >
                  <span className="font-medium text-sm">
                    Schema impact (current tip → restored content): {rollbackPreview.compatOverall ?? '—'}
                  </span>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    Same compatibility rules as elsewhere (#506): rolling back can remove paths or fields consumers rely on.
                  </p>
                  <div className="mt-2">
                    <CompatibilityReportPanel
                      findings={(rollbackPreview.findings ?? []).map((f) => ({
                        id: f.id,
                        category: (f as { category?: string }).category,
                        rule: f.rule ?? '—',
                        path: f.path,
                        message: f.message,
                      }))}
                      docUrl={rollbackPreview.breakingChangeDocumentationIssueUrl ?? undefined}
                    />
                  </div>
                </Alert>
                {rollbackPreview.rollbackBlockedByCompatGate ? (
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    Project metadata sets <span className="font-mono">compatGateOnRollback</span> — apply is blocked until the
                    rollback pair is safe or policy is updated.
                  </p>
                ) : null}
                {(rollbackPreview.deprecationWarnings ?? []).length > 0 ? (
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    Deprecation warnings: {(rollbackPreview.deprecationWarnings ?? []).length} (see compatibility API / sunset
                    timeline)
                  </p>
                ) : null}
                {rollbackPreview.compatOverall && rollbackPreview.compatOverall !== 'safe' ? (
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rollbackSkipCompat}
                      onChange={(e) => setRollbackSkipCompat(e.target.checked)}
                      className="rounded border-gray-300 dark:border-gray-600"
                    />
                    I understand this rollback may break existing consumers; proceed anyway
                  </label>
                ) : null}
              </>
            )}
          </div>
          <DialogFooter className="gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => setShowRollbackDialog(false)}
              disabled={rollbackPreviewLoading || rollbackApplyLoading}
            >
              Close
            </Button>
            <Button
              variant="secondary"
              onClick={() => void runRollbackPreview()}
              disabled={rollbackPreviewLoading || rollbackApplyLoading || !rollbackBranchName || !rollbackTargetVersion}
            >
              {rollbackPreviewLoading ? 'Previewing…' : 'Preview impact'}
            </Button>
            <Button
              onClick={() => setShowRollbackConfirmAlert(true)}
              disabled={
                rollbackApplyLoading ||
                rollbackPreviewLoading ||
                !rollbackPreview?.branchTipRevisionId ||
                rollbackPreview.rollbackBlockedByCompatGate === true ||
                (Boolean(rollbackPreview.compatOverall) &&
                  rollbackPreview.compatOverall !== 'safe' &&
                  !rollbackSkipCompat)
              }
            >
              Apply rollback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={showRollbackConfirmAlert}
        onOpenChange={(open) => {
          if (!rollbackApplyLoading) setShowRollbackConfirmAlert(open);
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left text-sm text-gray-700 dark:text-gray-300">
                <p>
                  <span className="text-gray-500 dark:text-gray-400">Target revision: </span>
                  <span className="font-mono text-xs break-all">{rollbackTargetVersion?.id ?? '—'}</span>
                </p>
                <p>
                  <span className="text-gray-500 dark:text-gray-400">Committed: </span>
                  {rollbackTargetVersion ? formatRevisionTimestampUtc(rollbackTargetVersion.created_at) : '—'}
                </p>
                <p>
                  <span className="text-gray-500 dark:text-gray-400">Impact: </span>
                  {rollbackPreview?.impactSummary != null ? (
                    <>
                      ~{rollbackPreview.impactSummary.changedEntityCount} entities differ vs branch tip (+
                      {rollbackPreview.impactSummary.added} added, −{rollbackPreview.impactSummary.removed} removed,{' '}
                      {rollbackPreview.impactSummary.modified} modified)
                    </>
                  ) : (
                    <>Run preview impact first to load entity counts.</>
                  )}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollbackApplyLoading}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={rollbackApplyLoading || !rollbackPreview?.branchTipRevisionId}
              onClick={() => void runRollbackApply()}
            >
              {rollbackApplyLoading ? 'Rolling back…' : 'Roll back'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Relationship graph (#322) — gated with the rest of git-like UI. */}
      <RelationshipGraphDialog
        open={FEATURE_GITLIKE && showRelationshipGraphDialog}
        onOpenChange={setShowRelationshipGraphDialog}
        version={relationshipGraphVersion}
        projectName={projects.find(p => p.id === relationshipGraphVersion?.project_id)?.name ?? ''}
        classesWithProperties={relationshipGraphClasses}
        isLoading={isLoadingRelationshipGraph}
      />
    </Page>
  );
};

export default Versions;

