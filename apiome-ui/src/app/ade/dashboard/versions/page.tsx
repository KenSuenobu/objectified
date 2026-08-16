'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthSession } from '@lib/auth/session-client';
import { useEffect, useState, useRef, useMemo, useCallback, type ReactNode } from 'react';
import {
  Edit2,
  Trash2,
  Package,
  AlertCircle,
  Lock,
  Unlock,
  CheckCircle,
  Eye,
  Copy,
  MoreVertical,
  Network,
  Snowflake,
  GitBranch,
  GitMerge,
  Tag,
  GitFork,
  Shield,
  Sun,
  LayoutGrid,
  Undo2,
  ScrollText,
  ListOrdered,
  GitCompareArrows,
  FileText,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  FileOutput,
  FlaskConical,
  History,
  Upload,
} from 'lucide-react';
import dynamic from 'next/dynamic';
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
import { EmptyState } from '../../../components/ui/EmptyState';
import { Textarea } from '../../../components/ui/Textarea';
import { Badge } from '../../../components/ui/Badge';
import { TAB_LIST_CLASS, tabTriggerClass } from '../../../components/ui/tabStyles';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/Tabs';
import { cn } from '@lib/utils';
import { VersionLintBadge } from '../../../components/ade/dashboard/VersionLintBadge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/Select';
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
import { Markdown } from '@/app/components/ui/Markdown';
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
import VersionLineageSnippet from './VersionLineageSnippet';
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
import VersionExportPanel from '../../../components/ade/dashboard/export/VersionExportPanel';
import { recordRecentExport } from '../../../components/ade/dashboard/export/recentExports';
import { ProjectRelatedArtifactsSection } from '../../../components/ade/dashboard/ProjectRelatedArtifactsSection';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelClass,
  dashboardPanelPaddedClass,
  dashboardTableWrapClass,
  dashboardTableTheadClass,
  dashboardThClass,
  dashboardThRightClass,
  dashboardTbodyClass,
  dashboardTrHoverClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { FEATURE_GITLIKE } from '@lib/feature-flags';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import {
  sortVersionsDashboardRows,
  type VersionsDashboardSortColumn,
  type VersionsDashboardSortDirection,
} from '@/app/utils/versions-dashboard-sort';
import { VersionMockCell, type VersionMockChange } from '../../../components/ade/dashboard/VersionMockCell';
import { PublishGuideViolationsPanel } from '../../../components/ade/dashboard/PublishGuideViolationsPanel';
import { BreakingPublishGuardrailPanel } from '../../../components/ade/dashboard/BreakingPublishGuardrailPanel';
import VerificationPolicyDecisionPanel from '../../../components/ade/dashboard/VerificationPolicyDecisionPanel';
import {
  guardrailBlocksPublish,
  type BreakingPublishGuardrail,
} from '@/app/utils/breaking-publish-guardrail';
import type { VersionLintReport } from '@/app/utils/version-lint-report';
import type { VerificationPolicyDecision } from '../style-guides/verification-policy-api';
import { useMockUsage } from '@/app/hooks/useMockUsage';
import { mockUsageSeriesKey } from '@/app/utils/mock-usage-series';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

/** Radix Select cannot use empty string as a value; maps to no successor in metadata. */
const SUCCESSOR_SELECT_NONE = '__none__';

const SPEC_JSON_YAML_TOGGLE_ITEM_CLASS =
  'px-3 py-2 text-xs font-semibold rounded-md transition-all duration-200 data-[state=on]:bg-white dark:data-[state=on]:bg-gray-600 data-[state=on]:text-indigo-600 dark:data-[state=on]:text-indigo-400 data-[state=on]:shadow-sm data-[state=off]:text-gray-600 dark:data-[state=off]:text-gray-400 hover:text-gray-900 dark:hover:text-white';

/** The renderings the View Spec dialog offers, in tab order. */
const SPEC_FORMATS = ['json', 'yaml'] as const;

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

const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <LoadingState
      className="h-full"
      minHeightClassName="min-h-0"
      spinnerSize="md"
      message="Loading editor..."
    />
  ),
});

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

// `publishable` is the Project-vs-Catalog boundary (MFI-23.1): `false` for catalog items
// (OpenAPI-worthy non-OpenAPI imports), which are never publish candidates (MFI-23.8, #4017).
// Older payloads may omit it; an absent flag is treated as publishable.
interface Project { id: string; name: string; slug: string; publishable?: boolean; }

interface Version {
  id: string;
  project_id: string;
  creator_id: string;
  version_id: string;
  shortMessage: string | null;
  changelog: string | null;
  enabled: boolean;
  published: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  creator_name: string;
  creator_email: string;
  parent_version_id?: string | null;
  merge_parent_version_id?: string | null;
  forkedFromRevisionId?: string | null;
  upstreamProjectId?: string | null;
  forkSourceVersionLabel?: string | null;
  forkSourceProjectName?: string | null;
  upstreamProjectName?: string | null;
  revisionLocked?: boolean;
  /** Governance lifecycle (#739): stable | beta | deprecated | archived */
  lifecycle?: string;
  /** Revision JSON (#507, #748): deprecation, sunsetAt, successorRevisionId, … */
  metadata?: Record<string, unknown>;
  /** Optional commit author string (REST: author / commit_author, #2579) */
  author?: string | null;
  /** Optional full commit message body (REST: message / commit_message, #2579) */
  message?: string | null;
  /** Hosted mock toggle state (#4422, SIM-2.1) */
  mockEnabled?: boolean;
  /** Private draft mock flag (#4446, SIM-2.5) */
  mockPrivate?: boolean;
  /** Stable mock base URL, set by REST when the mock is enabled (#4422) */
  mockBaseUrl?: string | null;
  /** Quality score stored on the version record (#5259); null when the revision is unscored. */
  qualityScore?: number | null;
  /** A-F grade stored on the version record (#5259); null when the revision is unscored. */
  qualityGrade?: string | null;
}

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

function getVersionActionsMenuMaxPx(): number {
  return Math.min(window.innerHeight * 0.6, 24 * 16);
}

/** Fixed dropdown for row actions: stay inside the viewport (flip above or clamp when near the bottom). */
function computeVersionActionsDropdownPosition(rect: DOMRect): { top?: number; bottom?: number; right: number } {
  const right = window.innerWidth - rect.right;
  const gap = 4;
  const margin = 8;
  const maxH = getVersionActionsMenuMaxPx();
  const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;

  const preferBelow = spaceBelow >= maxH || spaceBelow >= spaceAbove;

  if (preferBelow) {
    let top = rect.bottom + gap;
    if (top + maxH > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - margin - maxH);
    }
    return { top, right };
  }

  const topIfAbove = rect.top - gap - maxH;
  if (topIfAbove < margin) {
    return { top: margin, right };
  }
  return { bottom: window.innerHeight - rect.top + gap, right };
}

interface VersionBranchRow {
  id: string;
  name: string;
  tip_version_id: string;
  tip_version_string?: string;
  created_at?: string;
  created_by?: string | null;
  protected?: boolean;
  /** Project default branch (cannot be deleted). */
  is_default?: boolean;
}

function isVersionBranchNonDeletable(b: Pick<VersionBranchRow, 'name' | 'is_default'>): boolean {
  if (b.is_default) return true;
  return b.name.trim().toLowerCase() === 'main';
}

interface VersionTagRow {
  id: string;
  name: string;
  version_id: string;
  target_version_string?: string;
  message?: string | null;
  channel?: string | null;
  immutable?: boolean;
  protected?: boolean;
  created_by?: string | null;
}

function VersionsSortTh({
  column,
  sortColumn,
  sortDirection,
  onSortClick,
  className,
  testId,
  ariaLabel,
  children,
}: {
  column: VersionsDashboardSortColumn;
  sortColumn: VersionsDashboardSortColumn;
  sortDirection: VersionsDashboardSortDirection;
  onSortClick: (c: VersionsDashboardSortColumn) => void;
  className: string;
  testId: string;
  ariaLabel: string;
  children: ReactNode;
}) {
  const active = sortColumn === column;
  return (
    <th
      scope="col"
      className={className}
      aria-sort={active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="inline-flex w-full max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium uppercase tracking-wider text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
        onClick={() => onSortClick(column)}
        data-testid={testId}
        aria-label={ariaLabel}
      >
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 truncate">{children}</span>
        {active ? (
          sortDirection === 'asc' ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-40" aria-hidden />
        )}
      </button>
    </th>
  );
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
  const [openVersionDropdown, setOpenVersionDropdown] = useState<string | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top?: number; bottom?: number; right: number } | null>(null);

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
  const [versionsTableSortColumn, setVersionsTableSortColumn] =
    useState<VersionsDashboardSortColumn>('created');
  const [versionsTableSortDirection, setVersionsTableSortDirection] =
    useState<VersionsDashboardSortDirection>('desc');
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

  const currentTenantId = (session?.user as any)?.current_tenant_id;
  const currentUserId = (session?.user as any)?.user_id;
  const isAdmin = Boolean((session?.user as any)?.is_tenant_admin);
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

  useEffect(() => { if (selectedProjectId) loadVersions(); else setVersions([]); }, [selectedProjectId, lifecycleFilter]);

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
    const confirmed = await confirmDialog({ title: 'Unpublish Version', message: 'Best practice is to keep it published. Are you sure?', variant: 'danger', confirmLabel: 'Unpublish', cancelLabel: 'Cancel' });
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
    const confirmed = await confirmDialog({
      title: 'Freeze schema',
      message: 'This will capture the current class schemas for this version into the database so the version can be used in the Database section. Only versions with no schema captured yet can be frozen. Continue?',
      variant: 'info',
      confirmLabel: 'Freeze schema',
      cancelLabel: 'Cancel',
    });
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
    const confirmed = await confirmDialog({ title: 'Delete Version', message: 'This action cannot be undone.', variant: 'danger', confirmLabel: 'Delete', cancelLabel: 'Cancel' });
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
    } catch (error: any) { await alertDialog({ message: error.message || 'An error occurred', variant: 'error' }); }
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
    } catch (error) { setOpenApiSpec(JSON.stringify({ openapi: '3.1.0', info: { title: 'Error Loading Spec', version: version.version_id }, components: { schemas: {} } }, null, 2)); }
    finally { setIsLoadingSpec(false); }
  };

  const handleShowRelationshipGraph = async (version: Version) => {
    setRelationshipGraphVersion(version);
    setShowRelationshipGraphDialog(true);
    setIsLoadingRelationshipGraph(true);
    setRelationshipGraphClasses(null);
    try {
      const classesResult = await getClassesForVersion(version.id);
      const classesData = JSON.parse(classesResult);
      const classesWithProperties = await Promise.all(classesData.map(async (cls: any) => {
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

  /** Other revisions in the same project (for successor picker — labels are version IDs, values are revision UUIDs). */
  const successorCandidates = useMemo(() => {
    const sv = selectedVersion;
    if (!sv) return [];
    return versions
      .filter((v) => v.project_id === sv.project_id && v.id !== sv.id)
      .sort((a, b) => b.version_id.localeCompare(a.version_id, undefined, { numeric: true }));
  }, [versions, selectedVersion]);

  const renderSuccessorRevisionField = (htmlId: string) => {
    const tid = editSuccessorRevisionId.trim();
    const orphan = tid && !successorCandidates.some((v) => v.id === tid) ? tid : null;
    const selectValue = tid ? tid : SUCCESSOR_SELECT_NONE;
    return (
      <div className="space-y-2">
        <Label htmlFor={htmlId}>Successor revision</Label>
        <Select
          value={selectValue}
          onValueChange={(v) => setEditSuccessorRevisionId(v === SUCCESSOR_SELECT_NONE ? '' : v)}
          disabled={isLoading}
        >
          <SelectTrigger id={htmlId} className="w-full">
            <SelectValue placeholder="Choose a revision" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SUCCESSOR_SELECT_NONE}>No successor (end of life)</SelectItem>
            {orphan ? (
              <SelectItem value={orphan}>Other revision ({orphan.slice(0, 8)}…)</SelectItem>
            ) : null}
            {successorCandidates.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                v{v.version_id}
                {v.published ? ' · published' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Optional. Pick the replacement by version label (stored as the successor revision id), or leave as end of life with no
          successor.
        </p>
      </div>
    );
  };

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
    () =>
      sortVersionsDashboardRows(
        displayVersions,
        versionsTableSortColumn,
        versionsTableSortDirection
      ),
    [displayVersions, versionsTableSortColumn, versionsTableSortDirection]
  );

  const handleVersionsTableSortClick = useCallback((column: VersionsDashboardSortColumn) => {
    setVersionsTableSortColumn((prevCol) => {
      if (prevCol === column) {
        setVersionsTableSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevCol;
      }
      setVersionsTableSortDirection('asc');
      return column;
    });
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

  const formatDate = (dateString: string) => {
    const d = new Date(dateString);
    const datePart = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timePart = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
  };

  const revisionLifecycleBadge = (lc: string | undefined) => {
    const v = (lc ?? 'stable').toLowerCase();
    const label =
      v === 'stable' ? 'Stable' : v === 'beta' ? 'Beta' : v === 'deprecated' ? 'Deprecated' : v === 'archived' ? 'Archived' : 'Stable';
    const variant =
      v === 'stable' ? 'success' : v === 'beta' ? 'default' : v === 'deprecated' ? 'warning' : 'secondary';
    return (
      <Badge variant={variant} title="Revision lifecycle (#739)">
        {label}
      </Badge>
    );
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

  if (!session) {
    return (
      <div className="p-6">
        <LoadingState minHeightClassName="min-h-[220px]" message="Loading versions..." />
      </div>
    );
  }

  if (!currentTenantId) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="relative">
          <div className="absolute -top-10 -left-10 w-40 h-40 bg-gradient-to-br from-amber-100 to-yellow-100 dark:from-amber-900/20 dark:to-yellow-900/20 rounded-full blur-3xl opacity-60" />
          <div className="relative bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-900/20 dark:to-yellow-900/20 border border-amber-200 dark:border-amber-700/50 rounded-2xl p-8">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-yellow-500 flex items-center justify-center shadow-lg shadow-amber-500/25 flex-shrink-0">
                <Lock className="h-6 w-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-amber-900 dark:text-amber-100 mb-2">No Tenant Selected</h2>
                <p className="text-amber-800 dark:text-amber-200 mb-4">Please select a tenant before managing versions.</p>
                <Button asChild><a href="/ade/dashboard/tenants">Go to Tenants</a></Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <EmptyState
          icon={<Package className="h-10 w-10" />}
          title="No Projects Available"
          description="Please create a project before managing versions."
          iconContainerClassName="from-indigo-500 to-purple-600 shadow-indigo-500/30"
          action={(
            <Button asChild className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700">
              <a href="/ade/dashboard/projects">Go to Projects</a>
            </Button>
          )}
        />
      </div>
    );
  }

  return (
    <>
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <nav
                className="flex flex-wrap items-center gap-1 text-sm text-gray-500 dark:text-gray-400 mb-1"
                aria-label="Breadcrumb"
              >
                <Link
                  href="/ade/dashboard/projects"
                  className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                >
                  Projects
                </Link>
                <ChevronRight className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                <span className="text-gray-900 dark:text-white font-medium truncate max-w-[min(100%,14rem)]">
                  {selectedProject?.name ?? '…'}
                </span>
              </nav>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <Package className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                Versions
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">
                Revisions and releases for this project
              </p>
              <Link
                href="/ade/dashboard/versions/sunset-timeline"
                className="inline-flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-300 hover:underline mt-2"
              >
                <Sun className="h-4 w-4" />
                Sunset timeline (EOL schedule)
              </Link>
            </div>
            <div className="flex items-center gap-3">
              <Select value={selectedProjectId} onValueChange={handleSelectedProjectChange}>
                <SelectTrigger className="w-56"><SelectValue placeholder="Select Project" /></SelectTrigger>
                <SelectContent>{selectableProjects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
              {/* Import (#5260): start an import here instead of backtracking to Projects. */}
              <Button
                variant="secondary"
                data-testid="versions-import-button"
                onClick={() => setShowImportDialog(true)}
                disabled={!currentUserId}
                title={
                  currentUserId
                    ? 'Import a specification into a new project'
                    : 'Your session is still resolving — try again in a moment'
                }
              >
                <Upload className="h-4 w-4 mr-2" />
                Import
              </Button>
              <Button variant="secondary" onClick={handleCompareDialogOpen} disabled={!selectedProjectId || versions.length < 2}>
                <Copy className="h-4 w-4 mr-2" />
                Compare
              </Button>
              {FEATURE_GITLIKE && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setMergeSourceBranch('');
                    setMergeTargetBranch('');
                    setMergePreviewData(null);
                    setMergeCompat(null);
                    setShowMergeDialog(true);
                  }}
                  disabled={!selectedProjectId || versionBranches.length < 2}
                  title={versionBranches.length < 2 ? 'Create at least two named branches to merge' : undefined}
                >
                  <GitMerge className="h-4 w-4 mr-2" />
                  Merge branches
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={handleNewVersionClick}
                disabled={!selectedProjectId}
                title="Start a new version (fresh release line, defaults to a minor bump)"
              >
                <GitFork className="h-4 w-4 mr-2" />
                New Version
              </Button>
            </div>
          </div>
        </div>
      </header>

      {FEATURE_GITLIKE && conflict && conflict.projectId === selectedProjectId && selectedProjectId && (
        <div className="border-b border-amber-200/80 bg-amber-50/50 px-6 py-3 dark:border-amber-800/50 dark:bg-amber-950/25">
          <div>
            <ServerAheadPushBanner
              detail={conflict.message}
              pullLoading={versionsPullBannerLoading}
              onPull={handleVersionsPullReconcile}
              onOpenMerge={handleVersionsOpenMerge}
            />
          </div>
        </div>
      )}

      <main className={dashboardMainClass}>
        <div className={dashboardContentStackClass}>
      {showChangeReportTab || showChangesTab || showConversionTab ? (
        <div
          className={`${dashboardPanelClass} px-3 pt-2`}
          data-testid="versions-main-tab"
        >
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 sr-only">Versions main view</span>
          {/* The card's own bottom border is this strip's tab rule, so the list drops its own. */}
          <div
            role="tablist"
            aria-label="Versions main view"
            className={cn(TAB_LIST_CLASS, 'border-b-0')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMainTab === 'timeline'}
              data-testid="versions-tab-timeline"
              className={tabTriggerClass({ active: effectiveMainTab === 'timeline' })}
              onClick={() => setVersionsMainTab('timeline')}
            >
              <ScrollText className="h-4 w-4 shrink-0" aria-hidden />
              Timeline
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
                <GitCompareArrows className="h-4 w-4 shrink-0" aria-hidden />
                Changes
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
                <FileText className="h-4 w-4 shrink-0" aria-hidden />
                Change report
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
                <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />
                Test Bench
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
                onClick={() => setVersionsMainTab('conversion')}
              >
                <History className="h-4 w-4 shrink-0" aria-hidden />
                Conversion
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showConversionTab && effectiveMainTab === 'conversion' ? (
        /* Conversion provenance history (CPDO-3.3, #4803): where this project's revisions came
           from. Evidence replay lives on the catalog item's Conversions tab. */
        <div className={`${dashboardPanelPaddedClass}`}>
          <ProjectConversionPanel
            rows={conversionHistory.rows}
            loading={conversionHistory.loading}
            error={conversionHistory.error}
            retry={conversionHistory.retry}
            onSelectVersion={() => setVersionsMainTab('timeline')}
          />
        </div>
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

      {selectedProjectId ? (
        <ProjectRelatedArtifactsSection projectId={selectedProjectId} />
      ) : null}

      {FEATURE_GITLIKE && effectiveMainTab === 'timeline' && selectedProjectId && versionTags.length > 0 && (
        <div className={dashboardPanelPaddedClass}>
          <div className="flex items-center gap-2 mb-3">
            <Tag className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Version tags</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {versionTags.map((tg) => (
              <div
                key={tg.id}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-sm bg-amber-50/80 dark:bg-amber-950/20"
              >
                <span className="font-mono font-medium text-gray-900 dark:text-white">{tg.name}</span>
                <span className="text-gray-500 dark:text-gray-400">→ v{tg.target_version_string ?? '?'}</span>
                {tg.channel && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200">
                    {tg.channel}
                  </span>
                )}
                {tg.immutable && (
                  <span title="Immutable" className="text-xs text-amber-700 dark:text-amber-300">
                    locked
                  </span>
                )}
                {tg.protected && (
                  <span
                    title="Protected: only tenant admins can move or delete"
                    className="inline-flex items-center gap-0.5 text-xs text-indigo-700 dark:text-indigo-300"
                  >
                    <Shield className="h-3 w-3" />
                    protected
                  </span>
                )}
                {effectiveIsAdmin && !tg.immutable && (
                  <button
                    type="button"
                    onClick={() => handleToggleTagProtection(tg.id, !tg.protected)}
                    className="text-indigo-600 dark:text-indigo-400 hover:underline text-xs"
                  >
                    {tg.protected ? 'Unprotect' : 'Protect'}
                  </button>
                )}
                {!tg.immutable && (effectiveIsAdmin || (!tg.protected && tg.created_by === currentUserId)) && (
                  <button
                    type="button"
                    onClick={() => handleDeleteTag(tg.id)}
                    className="text-red-600 dark:text-red-400 hover:underline text-xs"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            Tags are stable names for a schema revision (like Git tags). Use &quot;Tag this revision&quot; on a version row to add one.
            Immutable tags cannot be moved or deleted; <span className="font-medium">protected</span> tags (tenant admin) add policy so only admins can move or delete.
            Pair with deprecation and sunset planning as last-known-good pointers.
          </p>
        </div>
      )}

      {FEATURE_GITLIKE && effectiveMainTab === 'timeline' && selectedProjectId && versionBranches.length > 0 && (
        <div id="ade-named-branches-panel" className={dashboardPanelPaddedClass}>
          <div className="flex items-center gap-2 mb-3">
            <GitBranch className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Named branches</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {versionBranches.map((b) => (
              <div
                key={b.id}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-900/50"
              >
                <span className="font-mono font-medium text-gray-900 dark:text-white">{b.name}</span>
                <span className="text-gray-500 dark:text-gray-400">→ v{b.tip_version_string ?? '?'}</span>
                {b.is_default && (
                  <span
                    title="Default branch for this project — cannot be deleted"
                    className="text-xs px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-200"
                  >
                    default
                  </span>
                )}
                {b.protected && (
                  <span
                    title="Protected branch: only tenant admins can delete"
                    className="inline-flex items-center gap-0.5 text-xs text-indigo-700 dark:text-indigo-300"
                  >
                    <Shield className="h-3 w-3" />
                    protected
                  </span>
                )}
                {effectiveIsAdmin && (
                  <button
                    type="button"
                    onClick={() => handleToggleBranchProtection(b.id, !b.protected)}
                    className="text-indigo-600 dark:text-indigo-400 hover:underline text-xs"
                  >
                    {b.protected ? 'Unprotect' : 'Protect'}
                  </button>
                )}
                {(effectiveIsAdmin || (!b.protected && b.created_by === currentUserId)) &&
                  !isVersionBranchNonDeletable(b) && (
                  <button
                    type="button"
                    onClick={() => handleDeleteBranch(b.id)}
                    className="text-red-600 dark:text-red-400 hover:underline text-xs"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            <span className="font-medium text-gray-700 dark:text-gray-300">Branch vs fork:</span> a named branch stays in this project (same version line).
            A <span className="font-medium">fork</span> copies a revision into a <em>different</em> project for isolated experiments; lineage is stored for audit and merge-back.
          </p>
        </div>
      )}

      {/* Versions List — lifecycle (and related) filters stay visible when filters yield zero rows */}
      {effectiveMainTab === 'timeline' ? (
      versions.length === 0 && !lifecycleFilter ? (
        <EmptyState
          icon={<Package className="h-10 w-10" />}
          title="No Versions Yet"
          description="Get started by creating your first version"
          iconContainerClassName="from-emerald-500 to-teal-600 shadow-emerald-500/30"
        />
      ) : (
        <>
          <div className={`mb-4 ${dashboardPanelClass} px-4 py-3 flex flex-wrap items-end gap-3`}>
            <div className="flex items-center gap-2 min-w-0">
              <ScrollText className="h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
              <span className="text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap">Timeline</span>
            </div>
            <div className="flex flex-col gap-1 min-w-[12rem] flex-1">
              <Label htmlFor="history-timeline-search" className="text-xs text-gray-500 dark:text-gray-400">
                Search
              </Label>
              <Input
                id="history-timeline-search"
                type="search"
                placeholder="Message, changelog, commit…"
                value={historySearchQ}
                onChange={(e) => setHistorySearchQ(e.target.value)}
                className="w-full min-w-0"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1 w-full sm:w-52">
              <Label className="text-xs text-gray-500 dark:text-gray-400">Author</Label>
              <Select
                value={historyAuthorCreatorId || '__all__'}
                onValueChange={(v) => setHistoryAuthorCreatorId(v === '__all__' ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All authors" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All authors</SelectItem>
                  {historyAuthorOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1 w-full sm:w-40">
              <Label htmlFor="history-date-from" className="text-xs text-gray-500 dark:text-gray-400">
                From
              </Label>
              <Input
                id="history-date-from"
                type="date"
                value={historyDateFrom}
                onChange={(e) => setHistoryDateFrom(e.target.value)}
                className="w-full"
              />
            </div>
            <div className="flex flex-col gap-1 w-full sm:w-40">
              <Label htmlFor="history-date-to" className="text-xs text-gray-500 dark:text-gray-400">
                To
              </Label>
              <Input
                id="history-date-to"
                type="date"
                value={historyDateTo}
                onChange={(e) => setHistoryDateTo(e.target.value)}
                className="w-full"
              />
            </div>
            {historyTimelineFiltersActive ? (
              <Button type="button" variant="secondary" className="shrink-0" onClick={resetHistoryTimelineFilters}>
                Reset
              </Button>
            ) : null}
          </div>
          {FEATURE_GITLIKE && (
            <div className="mb-6" ref={historyGraphSectionRef}>
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
            </div>
          )}
        <div className={dashboardTableWrapClass}>
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex flex-wrap items-center gap-3 bg-gray-50 dark:bg-gray-900">
            <span className="text-sm text-gray-600 dark:text-gray-400">Lifecycle filter</span>
            <Select
              value={lifecycleFilter || '__all__'}
              onValueChange={(v) => setLifecycleFilter(v === '__all__' ? '' : v)}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All lifecycles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All lifecycles</SelectItem>
                <SelectItem value="stable">Stable</SelectItem>
                <SelectItem value="beta">Beta</SelectItem>
                <SelectItem value="deprecated">Deprecated</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {versionTags.length > 0 && (
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex flex-wrap items-center gap-3 bg-gray-50 dark:bg-gray-900">
              <span className="text-sm text-gray-600 dark:text-gray-400">History filter</span>
              <Select
                value={historyTagFilter || '__all__'}
                onValueChange={(v) => setHistoryTagFilter(v === '__all__' ? '' : v)}
              >
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="All revisions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All revisions</SelectItem>
                  {versionTags.map((tg) => (
                    <SelectItem key={tg.id} value={tg.id}>
                      Tag {tg.name} → v{tg.target_version_string ?? '?'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <table className="min-w-full">
            <thead className={dashboardTableTheadClass}>
              <tr>
                <VersionsSortTh
                  column="version"
                  sortColumn={versionsTableSortColumn}
                  sortDirection={versionsTableSortDirection}
                  onSortClick={handleVersionsTableSortClick}
                  className={dashboardThClass}
                  testId="versions-sort-version"
                  ariaLabel="Sort by version"
                >
                  Version
                </VersionsSortTh>
                <VersionsSortTh
                  column="revision"
                  sortColumn={versionsTableSortColumn}
                  sortDirection={versionsTableSortDirection}
                  onSortClick={handleVersionsTableSortClick}
                  className={dashboardThClass}
                  testId="versions-sort-revision"
                  ariaLabel="Sort by revision and changelog"
                >
                  Revision / changelog
                </VersionsSortTh>
                <VersionsSortTh
                  column="status"
                  sortColumn={versionsTableSortColumn}
                  sortDirection={versionsTableSortDirection}
                  onSortClick={handleVersionsTableSortClick}
                  className={dashboardThClass}
                  testId="versions-sort-status"
                  ariaLabel="Sort by status"
                >
                  Status
                </VersionsSortTh>
                <th scope="col" className={dashboardThClass} aria-sort="none">
                  Mock
                </th>
                <VersionsSortTh
                  column="creator"
                  sortColumn={versionsTableSortColumn}
                  sortDirection={versionsTableSortDirection}
                  onSortClick={handleVersionsTableSortClick}
                  className={dashboardThClass}
                  testId="versions-sort-creator"
                  ariaLabel="Sort by created by"
                >
                  Created By
                </VersionsSortTh>
                <VersionsSortTh
                  column="created"
                  sortColumn={versionsTableSortColumn}
                  sortDirection={versionsTableSortDirection}
                  onSortClick={handleVersionsTableSortClick}
                  className={dashboardThClass}
                  testId="versions-sort-created"
                  ariaLabel="Sort by created date"
                >
                  Created
                </VersionsSortTh>
                <th scope="col" className={dashboardThRightClass} aria-sort="none">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className={dashboardTbodyClass}>
              {versions.length === 0 && lifecycleFilter ? (
                <tr key="versions-empty-lifecycle">
                  <td colSpan={7} className="px-6 py-12 text-center text-sm text-gray-600 dark:text-gray-300">
                    <p className="mx-auto max-w-md">
                      No revisions match this lifecycle filter. Choose a different lifecycle or select{' '}
                      <span className="font-medium">All lifecycles</span> to load every revision again.
                    </p>
                    <Button type="button" variant="secondary" className="mt-4" onClick={() => setLifecycleFilter('')}>
                      Clear lifecycle filter
                    </Button>
                  </td>
                </tr>
              ) : versions.length > 0 && tagFilteredVersions.length === 0 ? (
                <tr key="versions-empty-tag">
                  <td colSpan={7} className="px-6 py-12 text-center text-sm text-gray-600 dark:text-gray-300">
                    <p className="mx-auto max-w-md">
                      No revision matches the selected history tag. Clear the tag filter above or pick another tag.
                    </p>
                    <Button type="button" variant="secondary" className="mt-4" onClick={() => setHistoryTagFilter('')}>
                      Clear tag filter
                    </Button>
                  </td>
                </tr>
              ) : tableDisplayVersions.length === 0 ? (
                <tr key="versions-empty-timeline">
                  <td colSpan={7} className="px-6 py-12 text-center text-sm text-gray-600 dark:text-gray-300">
                    <p className="mx-auto max-w-md">
                      No revisions match your timeline filters (search, author, or date range). Adjust the filters or
                      reset them to see the full history again.
                    </p>
                    {historyTimelineFiltersActive ? (
                      <Button type="button" variant="secondary" className="mt-4" onClick={resetHistoryTimelineFilters}>
                        Reset timeline filters
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ) : (
                tableDisplayVersions.map((version) => (
                <tr key={version.id} className={dashboardTrHoverClass}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => void handleRowAction('view', version)}
                        className="text-sm font-bold font-mono text-indigo-600 hover:text-indigo-800 hover:underline dark:text-indigo-400 dark:hover:text-indigo-300"
                        title="View spec"
                      >
                        v{version.version_id}
                      </button>
                      {revisionLifecycleBadge(version.lifecycle)}
                      {version.published && <div title="Published" className="p-1 bg-blue-100 dark:bg-blue-900/30 rounded"><Lock className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" /></div>}
                      {version.revisionLocked && (
                        <div title="Revision locked: non-admins cannot delete" className="p-1 bg-indigo-100 dark:bg-indigo-900/30 rounded">
                          <Shield className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                        </div>
                      )}
                      {(tagsByVersionId.get(version.id) ?? []).map((t) => (
                        <span
                          key={t.id}
                          title={t.message || t.name}
                          className="text-xs font-mono px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 border border-amber-200 dark:border-amber-800"
                        >
                          {t.name}
                        </span>
                      ))}
                      {selectedProjectId && (
                        <VersionLintBadge
                          projectId={selectedProjectId}
                          versionId={version.id}
                          versionLabel={version.version_id}
                          storedScore={version.qualityScore}
                          storedGrade={version.qualityGrade}
                        />
                      )}
                    </div>
                    {version.forkedFromRevisionId && (
                      <div className="mt-2 rounded-md border border-violet-200 dark:border-violet-800 bg-violet-50/80 dark:bg-violet-950/30 px-2 py-1.5 text-xs text-violet-900 dark:text-violet-100">
                        <span className="font-medium">Fork</span>
                        {' · '}
                        from v{version.forkSourceVersionLabel ?? '?'}
                        {version.forkSourceProjectName != null && version.forkSourceProjectName !== ''
                          ? ` (${version.forkSourceProjectName})`
                          : ''}
                        {version.upstreamProjectName != null &&
                          version.upstreamProjectName !== '' &&
                          version.upstreamProjectName !== version.forkSourceProjectName && (
                            <span className="text-violet-700 dark:text-violet-300"> · Upstream project: {version.upstreamProjectName}</span>
                          )}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-gray-900 dark:text-white max-w-xs truncate">{version.shortMessage || '—'}</div>
                    {version.changelog && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-xs truncate">{version.changelog}</div>}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex gap-2">
                      {version.published ? (
                        <Badge variant="success" className="flex items-center gap-1"><CheckCircle className="h-3 w-3" />Published</Badge>
                      ) : (
                        <Badge variant="secondary" className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>Draft</Badge>
                      )}
                      {!version.enabled && <Badge variant="error">Disabled</Badge>}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <VersionMockCell
                      versionRecordId={version.id}
                      projectId={version.project_id}
                      versionLabel={version.version_id}
                      published={version.published}
                      mockEnabled={Boolean(version.mockEnabled)}
                      mockPrivate={Boolean(version.mockPrivate)}
                      mockBaseUrl={version.mockBaseUrl ?? null}
                      usageSeries={
                        mockUsageByVersion === null || !selectedProject?.slug
                          ? undefined
                          : mockUsageByVersion.get(mockUsageSeriesKey(selectedProject.slug, version.version_id)) ?? []
                      }
                      onMockChanged={(change) => handleVersionMockChanged(version.id, change)}
                    />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">{version.creator_name}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{version.creator_email}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                    {formatDate(version.created_at)}
                    {version.published_at && <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">Published: {formatDate(version.published_at)}</div>}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setDropdownPosition(
                            openVersionDropdown === version.id ? null : computeVersionActionsDropdownPosition(rect),
                          );
                          setOpenVersionDropdown(openVersionDropdown === version.id ? null : version.id);
                        }}
                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-400 hover:text-gray-600 dark:hover:text-white"
                        title="Actions"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>

                      {openVersionDropdown === version.id && dropdownPosition && (
                        <>
                          <div
                            className="fixed inset-0 z-10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenVersionDropdown(null);
                            }}
                          />
                          <div
                            className="fixed min-w-80 w-max max-w-[min(24rem,calc(100vw-1rem))] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-20"
                            style={{
                              ...(dropdownPosition.top != null ? { top: `${dropdownPosition.top}px` } : {}),
                              ...(dropdownPosition.bottom != null ? { bottom: `${dropdownPosition.bottom}px` } : {}),
                              right: `${dropdownPosition.right}px`,
                            }}
                          >
                            <div className="py-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenVersionDropdown(null);
                                  handleRowAction('view', version);
                                }}
                                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                              >
                                <Eye className="w-4 h-4 text-purple-500" />
                                View Spec
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenVersionDropdown(null);
                                  handleRowAction('export', version);
                                }}
                                title="Convert this version to another API format (fidelity shown per target)"
                                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                              >
                                <FileOutput className="w-4 h-4 text-emerald-600 dark:text-emerald-500" />
                                Export to another format…
                              </button>
                              {FEATURE_GITLIKE && (
                                <button
                                  type="button"
                                  disabled={!headRevisionId || version.id === headRevisionId}
                                  title={
                                    !headRevisionId
                                      ? 'No head revision'
                                      : version.id === headRevisionId
                                        ? 'This revision is already the current head'
                                        : 'OpenAPI diff: this revision → latest (current) head'
                                  }
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenVersionDropdown(null);
                                    void handleCompareWithCurrent(version.id);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  <GitCompareArrows className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />
                                  Compare with current
                                </button>
                              )}
                              {FEATURE_GITLIKE && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenVersionDropdown(null);
                                    handleRowAction('relationshipGraph', version);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                >
                                  <Network className="w-4 h-4 text-teal-500" />
                                  Relationship graph
                                </button>
                              )}
                              {FEATURE_GITLIKE && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenVersionDropdown(null);
                                    handleRowAction('branchFrom', version);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                >
                                  <GitBranch className="w-4 h-4 text-indigo-500" />
                                  Branch from here
                                </button>
                              )}
                              {FEATURE_GITLIKE && versionBranches.length > 0 && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenVersionDropdown(null);
                                    handleRowAction('rollbackBranch', version);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                >
                                  <Undo2 className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                                  Rollback branch to this revision…
                                </button>
                              )}
                              {FEATURE_GITLIKE && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenVersionDropdown(null);
                                    handleRowAction('forkToProject', version);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                >
                                  <GitFork className="w-4 h-4 text-violet-500" />
                                  Fork to another project…
                                </button>
                              )}
                              {FEATURE_GITLIKE && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenVersionDropdown(null);
                                    handleRowAction('tagFrom', version);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                >
                                  <Tag className="w-4 h-4 text-amber-600" />
                                  Tag this revision
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenVersionDropdown(null);
                                  handleRowAction('scheduleSunset', version);
                                }}
                                disabled={
                                  (!!version.published && !effectiveIsAdmin) ||
                                  ((version.lifecycle ?? 'stable') === 'archived' && !effectiveIsAdmin)
                                }
                                title={
                                  version.published && !effectiveIsAdmin
                                    ? 'Only a tenant admin can set sunset on a published revision'
                                    : (version.lifecycle ?? 'stable') === 'archived' && !effectiveIsAdmin
                                      ? 'Archived revisions are read-only'
                                      : 'Deprecation, sunset instant, and successor revision'
                                }
                                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <Sun className="w-4 h-4 text-amber-500 shrink-0" aria-hidden />
                                Schedule sunset (EOL)…
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenVersionDropdown(null);
                                  handleRowAction('edit', version);
                                }}
                                disabled={!!version.published && !effectiveIsAdmin}
                                title={version.published && !effectiveIsAdmin ? 'Only a tenant admin can edit a published revision' : undefined}
                                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <Edit2 className="w-4 h-4 text-blue-500" />
                                Edit
                              </button>
                              {!version.published ? (
                                // Catalog items (non-publishable projects, MFI-23.1) are never publish
                                // candidates (MFI-23.8, #4017): withhold the Publish affordance entirely.
                                isVersionPublishable(version) ? (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenVersionDropdown(null);
                                      handleRowAction('publish', version);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                  >
                                    <Lock className="w-4 h-4 text-green-500" />
                                    Publish
                                  </button>
                                ) : null
                              ) : (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenVersionDropdown(null);
                                    handleRowAction('unpublish', version);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                >
                                  <Unlock className="w-4 h-4 text-orange-500" />
                                  Unpublish
                                </button>
                              )}
                              {FEATURE_GITLIKE && !hasClassSchemaMap[version.id] && (version.creator_id === currentUserId || effectiveIsAdmin) && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenVersionDropdown(null);
                                    handleRowAction('freezeSchema', version);
                                  }}
                                  disabled={freezingSchemaVersionId === version.id}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                  title="Capture class schemas for this version so it can be used in the Database section (only when no schema is frozen yet)"
                                >
                                  <Snowflake className="w-4 h-4 text-cyan-500" />
                                  {freezingSchemaVersionId === version.id ? 'Freezing...' : 'Freeze schema'}
                                </button>
                              )}
                              {FEATURE_GITLIKE && effectiveIsAdmin && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenVersionDropdown(null);
                                    handleToggleRevisionLock(version, !version.revisionLocked);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                >
                                  <Shield className="w-4 h-4 text-indigo-500" />
                                  {version.revisionLocked ? 'Unlock revision (allow delete)' : 'Lock revision (delete policy)'}
                                </button>
                              )}
                              {FEATURE_GITLIKE && (
                                <>
                                  <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenVersionDropdown(null);
                                      handleRowAction('delete', version);
                                    }}
                                    disabled={!!version.revisionLocked && !effectiveIsAdmin}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-3 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                    title={version.revisionLocked && !effectiveIsAdmin ? 'Revision is locked; only a tenant admin can delete' : undefined}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
              )}
            </tbody>
          </table>
        </div>
        </>
      )
      ) : null}
        </div>
      </main>

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
      <Dialog open={showCreateDialog} onOpenChange={(open) => !isLoading && setShowCreateDialog(open)}>
        <DialogContent
          className="flex max-h-[min(90vh,56rem)] max-w-xl flex-col gap-4 overflow-hidden"
          aria-describedby="new-version-dialog-desc"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>New Version</DialogTitle>
            <DialogDescription id="new-version-dialog-desc">
              Start a new schema version for this project. Pick a bump strategy (defaults to minor), then describe the release.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden overscroll-contain py-1 pr-1 [-webkit-overflow-scrolling:touch]">
            {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
            {branchListError && (
              <Alert variant="warning" role="status">
                {branchListError} Branch names may be missing; you can still pick a revision below if your role allows.
              </Alert>
            )}
            <div className="space-y-2">
              {versionBranches.length > 1 ? (
                <>
                  <Label>Base copy on branch tip</Label>
                  <p id="create-copy-branch-hint" className="text-xs text-gray-500 dark:text-gray-400">
                    Multiple branches are defined for this project. Choose which branch tip to copy schema from—like picking which line to extend in git.
                  </p>
                  <Select
                    value={copySourceBranchKey}
                    onValueChange={(val) => {
                      setCopySourceBranchKey(val);
                      if (val === 'blank') setSourceVersionId('');
                      else if (val.startsWith('branch:')) {
                        const bid = val.slice(7);
                        const br = versionBranches.find((b) => b.id === bid);
                        setSourceVersionId(br?.tip_version_id ?? '');
                      }
                    }}
                    disabled={branchListLoading}
                  >
                    <SelectTrigger aria-describedby="create-copy-branch-hint">
                      <SelectValue placeholder={branchListLoading ? 'Loading branches…' : 'Choose branch tip or blank'} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="blank">Create blank version</SelectItem>
                      {versionBranches.map((b) => (
                        <SelectItem key={b.id} value={`branch:${b.id}`}>
                          {b.name} — tip v{b.tip_version_string ?? '?'}
                          {b.protected ? ' (protected)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <>
                  <Label>Copy from version</Label>
                  <Select
                    value={sourceVersionId || '__blank__'}
                    onValueChange={(val) => {
                      setSourceVersionId(val === '__blank__' ? '' : val);
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder={versions.length === 0 ? 'No versions available' : 'Create blank version'} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__blank__">Create blank version</SelectItem>
                      {versions.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.published ? '🔒 ' : ''}v{v.version_id} - {v.shortMessage || 'No description'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>
            {sourceVersionId && (
              <>
                <VersionLineageSnippet
                  sourceVersionId={sourceVersionId}
                  versions={versions.map((v) => ({
                    id: v.id,
                    version_id: v.version_id,
                    parent_version_id: v.parent_version_id ?? null,
                    merge_parent_version_id: v.merge_parent_version_id ?? null,
                  }))}
                  versionBranches={versionBranches}
                  explicitBranchName={
                    versionBranches.length > 1 && copySourceBranchKey.startsWith('branch:')
                      ? versionBranches.find((b) => b.id === copySourceBranchKey.slice(7))?.name ?? null
                      : versionBranches.length === 1 && versionBranches[0].tip_version_id === sourceVersionId
                        ? versionBranches[0].name
                        : null
                  }
                  isLoading={branchListLoading}
                  permissionDenied={branchPermissionDenied}
                />
                <Alert variant="info">Classes and properties will be copied from the selected revision.</Alert>
                <Alert variant="default" role="note">
                  <span className="font-medium text-sm">Compatibility</span>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 leading-relaxed">
                    After you create a new version, the service records a parent→head compatibility check in the workflow audit
                    log. Use <strong>Merge branches</strong> on this page or <strong>Compare versions</strong> to review a
                    full grouped report between two existing revisions before you integrate.
                  </p>
                </Alert>
              </>
            )}
            <div className="space-y-2">
              <Label>Version Strategy</Label>
              <Select value={autoGenerate ? 'auto' : 'manual'} onValueChange={(v) => { const isAuto = v === 'auto'; setAutoGenerate(isAuto); if (isAuto) setNextAutoVersion(calculateNextVersion(bumpStrategy)); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-generate version</SelectItem>
                  <SelectItem value="manual">Manual entry</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {autoGenerate ? (
              <>
                <div className="space-y-2">
                  <Label>Bump Strategy</Label>
                  <Select value={bumpStrategy} onValueChange={(v) => { const s = v as 'patch' | 'minor'; setBumpStrategy(s); setNextAutoVersion(calculateNextVersion(s)); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="patch">Patch - {calculateNextVersion('patch')}</SelectItem>
                      <SelectItem value="minor">Minor - {calculateNextVersion('minor')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Alert variant="info">Version <strong>{nextAutoVersion}</strong> will be created</Alert>
              </>
            ) : (
              <div className="space-y-2">
                <Label>Version ID</Label>
                <Input value={versionId} onChange={(e) => setVersionId(e.target.value)} placeholder="e.g., 1.0.0" disabled={isLoading} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="commit-message">Message *</Label>
              <Textarea
                id="commit-message"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={isLoading}
                rows={4}
                placeholder="Describe this revision (required)"
                aria-invalid={description.length > 0 && !createCommitMessageCheck.ok}
                className="min-h-[6rem]"
              />
              {!createCommitMessageCheck.ok && description.length > 0 && (
                <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                  {createCommitMessageCheck.error}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="commit-external-ref">External reference (optional)</Label>
              <Input
                id="commit-external-ref"
                value={commitExternalRef}
                onChange={(e) => setCommitExternalRef(e.target.value)}
                disabled={isLoading}
                placeholder="e.g. LINEAR-42, JIRA-123"
                aria-invalid={commitExternalRefTrim.length > COMMIT_EXTERNAL_REF_MAX_CHARS}
              />
              {commitExternalRefTrim.length > COMMIT_EXTERNAL_REF_MAX_CHARS && (
                <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                  External reference must be at most {COMMIT_EXTERNAL_REF_MAX_CHARS} characters
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Changelog (markdown, optional)</Label>
              <Textarea value={changeLog} onChange={(e) => setChangeLog(e.target.value)} rows={3} disabled={isLoading} placeholder="Release notes, breaking bullets (- breaking: …)" aria-invalid={commitChangelogOverLimit} />
              {commitChangelogOverLimit && (
                <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                  Changelog exceeds {VERSION_NOTES_LIMITS.maxChangelogChars} characters
                </p>
              )}
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-gray-100 pt-4 dark:border-gray-700">
            <Button variant="outline" onClick={() => setShowCreateDialog(false)} disabled={isLoading}>Cancel</Button>
            <Button onClick={handleCreateSubmit} disabled={isLoading || !createCommitFormValid}>
              {isLoading ? 'Creating…' : 'Create Version'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Version Dialog */}
      <Dialog open={showEditDialog} onOpenChange={(open) => !isLoading && setShowEditDialog(open)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Edit Version</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
            {selectedVersion && (selectedVersion.lifecycle ?? 'stable') === 'archived' && effectiveIsAdmin && !editPublishedMetadataOnly && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This revision is archived (read-only). You can change its lifecycle or use revision lock; notes cannot be edited here.
              </p>
            )}
            {editPublishedMetadataOnly && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Published revision — notes are frozen. As a tenant admin you can update deprecation and sunset metadata only (#748).
              </p>
            )}
            <div className="space-y-2">
              <Label>Version ID</Label>
              <Input value={versionId} disabled className="font-mono" />
            </div>
            <div className="space-y-2">
              <Label>Lifecycle</Label>
              <Select value={editLifecycle} onValueChange={setEditLifecycle} disabled={isLoading}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stable">Stable</SelectItem>
                  <SelectItem value="beta">Beta</SelectItem>
                  <SelectItem value="deprecated">Deprecated</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Semantic governance tag (#739). Setting Deprecated sets revision deprecation (#507) for consumers.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="deprecation-msg">Deprecation message</Label>
              <Textarea
                id="deprecation-msg"
                value={editDeprecationMessage}
                onChange={(e) => setEditDeprecationMessage(e.target.value)}
                rows={2}
                disabled={isLoading}
                placeholder="Why this revision is deprecated (optional)"
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sunset-local">Sunset (local time → stored as UTC)</Label>
              <Input
                id="sunset-local"
                type="datetime-local"
                value={editSunsetLocal}
                onChange={(e) => setEditSunsetLocal(e.target.value)}
                disabled={isLoading}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Requires lifecycle Deprecated when set. Successor is optional (end of life with no replacement is valid). Cleared
                if empty.
              </p>
            </div>
            {renderSuccessorRevisionField('successor-rev')}
            <div className="space-y-2">
              <Label>Revision note *</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={
                  isLoading ||
                  editPublishedMetadataOnly ||
                  ((selectedVersion?.lifecycle ?? 'stable') === 'archived' && effectiveIsAdmin)
                }
                autoFocus={
                  !editPublishedMetadataOnly &&
                  (((selectedVersion?.lifecycle ?? 'stable') !== 'archived') || !effectiveIsAdmin)
                }
                placeholder="Short summary (commit message)"
              />
            </div>
            <div className="space-y-2">
              <Label>Changelog (markdown)</Label>
              <Textarea
                value={changeLog}
                onChange={(e) => setChangeLog(e.target.value)}
                rows={4}
                disabled={
                  isLoading ||
                  editPublishedMetadataOnly ||
                  ((selectedVersion?.lifecycle ?? 'stable') === 'archived' && effectiveIsAdmin)
                }
                placeholder="Release notes, breaking bullets (- breaking: …)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)} disabled={isLoading}>Cancel</Button>
            <Button onClick={handleEditSubmit} disabled={isLoading}>{isLoading ? 'Saving...' : 'Save Changes'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showSunsetScheduleDialog}
        onOpenChange={(open) => {
          if (isLoading) return;
          setShowSunsetScheduleDialog(open);
          if (!open) setErrorMessage('');
        }}
      >
        <DialogContent className="max-w-lg" aria-describedby="sunset-schedule-desc">
          <DialogHeader>
            <DialogTitle>Schedule sunset (EOL)</DialogTitle>
            <DialogDescription id="sunset-schedule-desc">
              Set lifecycle to Deprecated, enter a required sunset date and time (stored in UTC), and optionally the successor
              revision (by version label) consumers should migrate to—or leave no successor for a pure end-of-life. Entries
              appear on the{' '}
              <Link
                href="/ade/dashboard/versions/sunset-timeline"
                className="text-indigo-600 dark:text-indigo-400 underline underline-offset-2"
              >
                sunset timeline
              </Link>
              .
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
            {selectedVersion && editPublishedMetadataOnly && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Published revision — only deprecation and sunset metadata can be changed here.
              </p>
            )}
            {selectedVersion && (
              <div className="space-y-2">
                <Label>Revision</Label>
                <Input value={`v${selectedVersion.version_id}`} readOnly disabled className="font-mono" />
              </div>
            )}
            <div className="space-y-2">
              <Label>Lifecycle</Label>
              <Select value={editLifecycle} onValueChange={setEditLifecycle} disabled={isLoading}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stable">Stable</SelectItem>
                  <SelectItem value="beta">Beta</SelectItem>
                  <SelectItem value="deprecated">Deprecated</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                A sunset date requires <span className="font-medium">Deprecated</span>.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sunset-schedule-deprecation-msg">Deprecation message</Label>
              <Textarea
                id="sunset-schedule-deprecation-msg"
                value={editDeprecationMessage}
                onChange={(e) => setEditDeprecationMessage(e.target.value)}
                rows={2}
                disabled={isLoading}
                placeholder="Why this revision is deprecated (optional)"
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sunset-schedule-local">
                Sunset date and time <span className="text-red-600 dark:text-red-400">*</span>
                <span className="sr-only"> (required)</span>
              </Label>
              <Input
                id="sunset-schedule-local"
                type="datetime-local"
                value={editSunsetLocal}
                onChange={(e) => setEditSunsetLocal(e.target.value)}
                disabled={isLoading}
                required
                aria-required
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Required. Local time is converted to UTC for storage. To clear a sunset, use Edit version from the row menu.
              </p>
            </div>
            {renderSuccessorRevisionField('sunset-schedule-successor')}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSunsetScheduleDialog(false)} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              onClick={handleSunsetScheduleSubmit}
              disabled={isLoading || !editSunsetLocal.trim()}
            >
              {isLoading ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Publish Version Dialog */}
      <Dialog open={showPublishDialog} onOpenChange={(open) => { setShowPublishDialog(open); if (!open) setPublishVersionId(null); }}>
        <DialogContent className={changeReportUiEnabled ? 'max-w-2xl max-h-[90vh] overflow-y-auto' : 'max-w-lg'}>
          <DialogHeader>
            <DialogTitle>Publish Version</DialogTitle>
            <DialogDescription>
              Once published, this version will become read-only. To make any additional edits after publishing, either create a new version, or unpublish this version.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Visibility</Label>
              <Select value={publishVisibility} onValueChange={(v) => setPublishVisibility(v as 'private' | 'public')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="public">Public</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {publishVisibility === 'private' ? 'Access requires an API Key.' : 'OpenAPI Specification will be public without requiring an API Key.'}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Revision note *</Label>
              <Input
                value={publishShortMessage}
                onChange={(e) => setPublishShortMessage(e.target.value)}
                placeholder="Short summary frozen with this publish"
              />
            </div>
            <div className="space-y-2">
              <Label>Changelog (markdown)</Label>
              <Textarea
                value={publishChangelog}
                onChange={(e) => setPublishChangelog(e.target.value)}
                rows={5}
                placeholder="Release notes; use - breaking: lines for migration docs"
                className="font-mono text-sm"
              />
            </div>
            {publishVersionId && (() => {
              const publishVersion = versions.find((v) => v.id === publishVersionId);
              if (!publishVersion) return null;
              return (
                <>
                  <PublishGuideViolationsPanel
                    projectId={publishVersion.project_id}
                    versionId={publishVersionId}
                    onReportChange={(report) => setPublishLintReport(report)}
                  />
                  <BreakingPublishGuardrailPanel
                    projectId={publishVersion.project_id}
                    versionId={publishVersionId}
                    enabled={showPublishDialog}
                    onGuardrailChange={(guardrail) => setPublishBreakingGuardrail(guardrail)}
                  />
                  <VerificationPolicyDecisionPanel
                    projectId={publishVersion.project_id}
                    versionId={publishVersionId}
                    projectSlug={selectedProject?.slug}
                    versionSlug={publishVersion.version_id}
                    enabled={showPublishDialog}
                    onDecisionChange={setPublishVerificationDecision}
                  />
                </>
              );
            })()}
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={publishForce}
                  onChange={(e) => {
                    setPublishForce(e.target.checked);
                    if (!e.target.checked) setPublishForceReason('');
                  }}
                  className="mt-0.5 rounded border-gray-300 dark:border-gray-600"
                />
                <span>Force publish (ignore validation errors)</span>
              </label>
              {publishForce && (
                <>
                  <Alert variant="warning" className="text-sm">
                    Publish prechecks will be bypassed — missing class descriptions, OpenAPI build,
                    backward-compatibility gates, style-guide error violations, the
                    breaking-change guardrail, and evidence-backed verification policy are not
                    enforced.
                    A reason is required and recorded in the audit trail.
                  </Alert>
                  <div className="space-y-2">
                    <Label htmlFor="publish-force-reason">Force publish reason *</Label>
                    <Textarea
                      id="publish-force-reason"
                      value={publishForceReason}
                      onChange={(e) => setPublishForceReason(e.target.value)}
                      rows={3}
                      placeholder="Why are you bypassing publish gates?"
                      className="text-sm"
                    />
                  </div>
                </>
              )}
            </div>
            {changeReportUiEnabled && (
              <div className="space-y-3 rounded-lg border border-indigo-200/80 bg-indigo-50/50 p-4 dark:border-indigo-800/60 dark:bg-indigo-950/20">
                <div>
                  <h3 className="text-sm font-semibold text-indigo-900 dark:text-indigo-100">Publication change report</h3>
                  <p className="text-xs text-indigo-800/90 dark:text-indigo-200/90 mt-1">
                    A change report is generated when you publish. Choose what to compare this revision against, then review the draft below.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="publish-cr-baseline-mode">Compare against</Label>
                  <Select
                    value={publishChangeReportBaselineMode}
                    onValueChange={(v) => {
                      setPublishChangeReportBaselineMode(v as 'auto' | 'initial' | 'manual');
                      if (v !== 'manual') setPublishManualBaselineRevisionId('');
                    }}
                  >
                    <SelectTrigger id="publish-cr-baseline-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Automatic (recommended prior published revision)</SelectItem>
                      <SelectItem value="initial">Initial publication report only (no prior baseline)</SelectItem>
                      <SelectItem value="manual" disabled={publishManualBaselineOptions.length === 0}>
                        Choose a published revision…
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {publishManualBaselineOptions.length === 0 && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      No other published revisions in this project — use &quot;Initial publication report only&quot; or Automatic.
                    </p>
                  )}
                </div>
                {publishChangeReportBaselineMode === 'manual' && publishManualBaselineOptions.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="publish-cr-baseline-pick">Published revision</Label>
                    <Select
                      value={publishManualBaselineRevisionId}
                      onValueChange={setPublishManualBaselineRevisionId}
                    >
                      <SelectTrigger id="publish-cr-baseline-pick">
                        <SelectValue placeholder="Select revision…" />
                      </SelectTrigger>
                      <SelectContent>
                        {publishManualBaselineOptions.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            v{v.version_id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void loadPublishPreview()} disabled={publishPreviewLoading}>
                    {publishPreviewLoading ? 'Loading preview…' : 'Refresh preview'}
                  </Button>
                  {publishPreview && (
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      {publishPreview.initialPublication
                        ? 'Initial publication report'
                        : `Diff: ${publishPreview.fromVersionLabel ?? '—'} → ${publishPreview.toVersionLabel ?? '—'}`}
                    </span>
                  )}
                </div>
                {publishPreviewError && (
                  <Alert variant="warning" className="text-sm">
                    {publishPreviewError}
                  </Alert>
                )}
                {publishPreviewLoading && !publishPreview && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">Generating preview…</p>
                )}
                {publishPreview && (
                  <div className="max-h-[min(320px,40vh)] overflow-y-auto rounded-md border border-gray-200 bg-white p-3 text-left dark:border-gray-700 dark:bg-gray-900/80">
                    <Markdown
                      variant="default"
                      className="border-b border-gray-100 pb-3 mb-3 dark:border-gray-800"
                    >
                      {publishPreview.headerSnapshot || '—'}
                    </Markdown>
                    <Markdown
                      variant="default"
                      className="border-b border-gray-100 pb-3 mb-3 dark:border-gray-800"
                    >
                      {publishPreview.renderedBody || '—'}
                    </Markdown>
                    <Markdown variant="default">{publishPreview.footnoteSnapshot || '—'}</Markdown>
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowPublishDialog(false); setPublishVersionId(null); }}>Cancel</Button>
            <Button
              onClick={handlePublishConfirm}
              disabled={
                publishBlockedByGuideErrors ||
                publishBlockedByVerificationPolicy ||
                publishBlockedByBreakingGuardrail ||
                publishForceReasonMissing
              }
            >
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* OpenAPI Viewer Dialog */}
      <Dialog open={showOpenApiDialog} onOpenChange={setShowOpenApiDialog}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto" aria-describedby={undefined}>
          <DialogHeader className="space-y-0">
            <div className="min-w-0 pr-8">
              <DialogTitle>OpenAPI 3.1.0 Specification</DialogTitle>
              {viewingVersion && (
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {projects.find(p => p.id === viewingVersion.project_id)?.name} - v{viewingVersion.version_id}
                </p>
              )}
            </div>
          </DialogHeader>
          {/* JSON and YAML are panes of the spec, each with its own editor, so the picker is the
              app's standard tab strip rather than a segmented pair of buttons. */}
          <Tabs
            value={openApiFormat}
            onValueChange={(next) => { if (next) setOpenApiFormat(next as 'json' | 'yaml'); }}
          >
            <TabsList aria-label="Specification format">
              {SPEC_FORMATS.map((format) => (
                <TabsTrigger key={format} value={format} data-testid={`spec-format-tab-${format}`}>
                  {format.toUpperCase()}
                </TabsTrigger>
              ))}
            </TabsList>
            {SPEC_FORMATS.map((format) => (
              <TabsContent key={format} value={format} className="h-[60vh]">
                {isLoadingSpec ? (
                  <LoadingState
                    className="h-full"
                    minHeightClassName="min-h-0"
                    spinnerSize="md"
                    message="Loading specification..."
                  />
                ) : (
                  <Editor height="100%" language={format} value={format === 'json' ? openApiSpec : YAML.stringify(JSON.parse(openApiSpec || '{}'))} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: true }, fontSize: CODE_EDITOR_FONT_SIZE }} />
                )}
              </TabsContent>
            ))}
          </Tabs>
          {/* Version-scoped export entry point (MFX-6.5, #3859): the fidelity pre-summary
              (best-fidelity vs lossy targets for this source) + this version's recent exports,
              rendered on the version view before the ExportDialog opens. */}
          {viewingVersion && (
            <div className="mt-3">
              <VersionExportPanel
                artifact={viewingVersion.project_id}
                version={viewingVersion.id}
                artifactLabel={projects.find((p) => p.id === viewingVersion.project_id)?.name}
                active={showOpenApiDialog}
                refreshToken={recentExportsRefresh}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOpenApiDialog(false)}>Close</Button>
            <Button onClick={async () => { await navigator.clipboard.writeText(openApiFormat === 'json' ? openApiSpec : YAML.stringify(JSON.parse(openApiSpec))); toast.success('Copied to clipboard!'); }} disabled={isLoadingSpec}>Copy</Button>
            <Button onClick={() => {
              const content = openApiFormat === 'json' ? openApiSpec : YAML.stringify(JSON.parse(openApiSpec));
              const blob = new Blob([content], { type: openApiFormat === 'json' ? 'application/json' : 'text/yaml' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a'); link.href = url;
              const project = viewingVersion ? projects.find(p => p.id === viewingVersion.project_id) : null;
              link.download = `${project?.slug || 'api'}-${viewingVersion?.version_id?.replace(/\./g, '-') || '1-0-0'}-openapi.${openApiFormat === 'json' ? 'json' : 'yaml'}`;
              document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
            }} disabled={isLoadingSpec}>Download</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </>
  );
};

export default Versions;

