'use client';

import { useAuthSession } from '@lib/auth/session-client';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useState,
  useRef,
  useMemo,
  useCallback,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  Plus,
  Edit2,
  Trash2,
  FolderOpen,
  Folders,
  Lock,
  Upload,
  AlertTriangle,
  MoreVertical,
  ExternalLink,
  Bot,
  FileEdit,
  TrendingUp,
  Undo2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Search,
  LayoutGrid,
  List,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../../components/ui/Dialog';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Label } from '../../../components/ui/Label';
import { Switch } from '../../../components/ui/Switch';
import { Alert } from '../../../components/ui/Alert';
import { LoadingState } from '../../../components/ui/LoadingState';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Textarea } from '../../../components/ui/Textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/Select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/Tabs';
import { toast } from 'sonner';
import { createProject, updateProject, deleteProject, permanentDeleteProject, restoreProject } from '../../../../../lib/db/helper';
import OpenAPIImportDialog from '../../../components/ade/dashboard/OpenAPIImportDialog';
import ImportDialog from '../../../components/ade/dashboard/ImportDialog';
import { LLMChatPanel } from '../../../components/ade/dashboard/LLMImportDialog';
import { useDialog } from '../../../components/providers/DialogProvider';
import { filterSlugInput } from '../../../utils/slug';
import { isProjectPublishable } from '../../../utils/catalog-publishable';
import { SPDX_LICENSES, getLicenseUrl, SPDXLicense } from '../../../utils/spdx-licenses';
import { type ProjectOpenApiMetadata } from '../../../utils/project-templates';
import {
  PROJECT_DOMAIN_CATEGORIES,
  PROJECT_DOMAIN_CATEGORY_NONE,
  getProjectDomainCategory,
  getProjectDomainCategoryLabel,
} from '../../../utils/project-domain-categories';
import {
  CreateProjectManualFormFields,
  type CreateProjectManualFormModel,
} from '../../../components/ade/dashboard/projects/CreateProjectManualFormFields';
import { ProjectsDashboardProjectCard } from '../../../components/ade/dashboard/projects/ProjectsDashboardProjectCard';
import {
  getProjectQualityHistory,
  buildPortfolioQualitySeries,
  type ProjectQualityReportSection,
} from '../../../utils/project-quality-score-history';
import { getNumericScoreTier } from '../../../utils/numeric-score-tier';
import { ProjectQualityTrendSparkline } from '../../../components/ade/dashboard/ProjectQualityTrendSparkline';
import { PortfolioQualityTrendChart } from '../../../components/ade/dashboard/PortfolioQualityTrendChart';
import { ProjectQualityHistoryDialog } from '../../../components/ade/dashboard/ProjectQualityHistoryDialog';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelClass,
  dashboardTableWrapClass,
  dashboardTableTheadClass,
  dashboardThClass,
  dashboardThRightClass,
  dashboardTbodyClass,
  dashboardTrHoverClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  sortProjectsDashboardRows,
  type ProjectsDashboardSortColumn,
  type ProjectsDashboardSortDirection,
} from '@/app/utils/projects-dashboard-sort';
import { cn } from '../../../../../lib/utils';

type ProjectMetadata = ProjectOpenApiMetadata;

const PROJECT_CARD_GRADIENTS = [
  'from-indigo-500 to-purple-500',
  'from-emerald-500 to-cyan-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-purple-500 to-fuchsia-500',
  'from-sky-500 to-cyan-500',
] as const;

function projectCardInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
  const w = parts[0] ?? '?';
  return w.slice(0, 2).toUpperCase();
}

function projectCardGradientClass(projectId: string): string {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) {
    h = (h + projectId.charCodeAt(i) * (i + 1)) % 1_000_000;
  }
  return PROJECT_CARD_GRADIENTS[h % PROJECT_CARD_GRADIENTS.length] ?? PROJECT_CARD_GRADIENTS[0];
}

function formatShortProjectId(id: string): string {
  const compact = id.replace(/-/g, '');
  return `prj_${compact.slice(0, 5)}`;
}

interface Project {
  id: string;
  tenant_id: string;
  creator_id: string;
  name: string;
  /** URL slug from API when present */
  slug?: string;
  description: string;
  enabled: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  creator_name: string;
  creator_email: string;
  metadata?: ProjectMetadata;
  /** Project-vs-Catalog boundary (MFI-23.1): `false` marks a catalog item, which never lists here (#4587). */
  publishable?: boolean;
  /** Mean quality score across the project's versions (#3609), camelCase from REST. */
  qualityScore?: number | null;
  qualityGrade?: string | null;
  /** Live version count from the server summary (0 = empty project). */
  versionsCount?: number;
}

function ProjectsSortTh({
  column,
  sortColumn,
  sortDirection,
  onSortClick,
  className,
  testId,
  ariaLabel,
  children,
}: {
  column: ProjectsDashboardSortColumn;
  sortColumn: ProjectsDashboardSortColumn;
  sortDirection: ProjectsDashboardSortDirection;
  onSortClick: (c: ProjectsDashboardSortColumn) => void;
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

function ProjectDashboardActions({
  project,
  isDeleted,
  openProjectDropdown,
  setOpenProjectDropdown,
  dropdownPosition,
  setDropdownPosition,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
}: {
  project: Project;
  isDeleted: boolean;
  openProjectDropdown: string | null;
  setOpenProjectDropdown: Dispatch<SetStateAction<string | null>>;
  dropdownPosition: { top: number; right: number } | null;
  setDropdownPosition: Dispatch<SetStateAction<{ top: number; right: number } | null>>;
  onEdit: (p: Project) => void;
  onDelete: (id: string) => void | Promise<void>;
  onRestore: (p: Project) => void | Promise<void>;
  onPermanentDelete: (p: Project) => void | Promise<void>;
}) {
  return (
    <div className="relative inline-flex items-center justify-end gap-0.5">
      {isDeleted ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void onRestore(project);
          }}
          className="rounded-lg p-2 text-emerald-600 transition-colors hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
          title="Undelete project"
          aria-label={`Undelete project ${project.name}`}
        >
          <Undo2 className="h-4 w-4" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setDropdownPosition({
            top: rect.bottom + 4,
            right: window.innerWidth - rect.right,
          });
          setOpenProjectDropdown(openProjectDropdown === project.id ? null : project.id);
        }}
        className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-white"
        title="Actions"
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {openProjectDropdown === project.id && dropdownPosition ? (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={(e) => {
              e.stopPropagation();
              setOpenProjectDropdown(null);
            }}
          />
          <div
            className="fixed z-20 w-56 min-w-0 overflow-x-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
            style={{
              top: `${dropdownPosition.top}px`,
              right: `${dropdownPosition.right}px`,
            }}
          >
            <div className="py-1">
              {!project.deleted_at ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenProjectDropdown(null);
                      onEdit(project);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
                  >
                    <Edit2 className="h-4 w-4 text-indigo-500" />
                    Edit Project
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenProjectDropdown(null);
                      void onDelete(project.id);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                    Delete Project
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenProjectDropdown(null);
                    void onRestore(project);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
                >
                  <Undo2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  Undelete Project
                </button>
              )}
              <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenProjectDropdown(null);
                  void onPermanentDelete(project);
                }}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300"
              >
                <AlertTriangle className="h-4 w-4" />
                Permanently Delete
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

const Projects = () => {
  const router = useRouter();
  const { data: session } = useAuthSession();
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createDialogTab, setCreateDialogTab] = useState<'manual' | 'ai'>('manual');
  const aiPanelRef = useRef<{ abort: () => void } | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showNewImportDialog, setShowNewImportDialog] = useState(false);
  const [importOpenedFromNewProjectAI, setImportOpenedFromNewProjectAI] = useState(false);
  const [pendingLLMSpec, setPendingLLMSpec] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [projectEnabled, setProjectEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [projectsListLoading, setProjectsListLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  // Dropdown state
  const [openProjectDropdown, setOpenProjectDropdown] = useState<string | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; right: number } | null>(null);

  // Metadata state
  const [metadataSummary, setMetadataSummary] = useState('');
  const [metadataTermsOfService, setMetadataTermsOfService] = useState('');
  const [metadataContactName, setMetadataContactName] = useState('');
  const [metadataContactUrl, setMetadataContactUrl] = useState('');
  const [metadataContactEmail, setMetadataContactEmail] = useState('');
  const [metadataLicenseName, setMetadataLicenseName] = useState('');
  const [metadataLicenseIdentifier, setMetadataLicenseIdentifier] = useState('');
  const [metadataLicenseUrl, setMetadataLicenseUrl] = useState('');
  const [selectedStartTemplateId, setSelectedStartTemplateId] = useState('blank');
  const [projectDomainCategoryId, setProjectDomainCategoryId] = useState(PROJECT_DOMAIN_CATEGORY_NONE);
  const [qualityHistoryEpoch, setQualityHistoryEpoch] = useState(0);
  const [qualityTrendProject, setQualityTrendProject] = useState<Project | null>(null);
  const [qualityDialogSection, setQualityDialogSection] = useState<ProjectQualityReportSection>('trend');
  const [showDeleted, setShowDeleted] = useState(false);
  const [sortColumn, setSortColumn] = useState<ProjectsDashboardSortColumn>('name');
  const [sortDirection, setSortDirection] = useState<ProjectsDashboardSortDirection>('asc');
  const [projectsViewMode, setProjectsViewMode] = useState<'cards' | 'table'>('cards');
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [projectsFilterChip, setProjectsFilterChip] = useState<'all' | 'active' | 'attention' | 'deleted'>(
    'all'
  );
  const prevImportOpen = useRef(false);

  const currentTenantId = (session?.user as any)?.current_tenant_id;
  const currentUserId = (session?.user as any)?.user_id;
  const selectedProjectDomainCategory = useMemo(
    () => getProjectDomainCategory(projectDomainCategoryId),
    [projectDomainCategoryId]
  );

  useEffect(() => {
    if (prevImportOpen.current && !showNewImportDialog) {
      setQualityHistoryEpoch((e) => e + 1);
    }
    prevImportOpen.current = showNewImportDialog;
  }, [showNewImportDialog]);

  const projectQualityHistoryCacheRef = useRef<Record<string, ReturnType<typeof getProjectQualityHistory>>>({});
  const projectQualityHistoryCacheEpochRef = useRef(qualityHistoryEpoch);

  const projectQualityHistoryMap = useMemo(() => {
    if (projectQualityHistoryCacheEpochRef.current !== qualityHistoryEpoch) {
      projectQualityHistoryCacheRef.current = {};
      projectQualityHistoryCacheEpochRef.current = qualityHistoryEpoch;
    }

    const cache = projectQualityHistoryCacheRef.current;
    const m: Record<string, ReturnType<typeof getProjectQualityHistory>> = {};

    for (const p of projects) {
      if (!(p.id in cache)) {
        cache[p.id] = getProjectQualityHistory(p.id);
      }
      m[p.id] = cache[p.id];
    }
    return m;
  }, [projects, qualityHistoryEpoch]);

  const latestQualityByProjectId = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const p of projects) {
      // Empty projects have no version summary — never surface a score for sorting/averages.
      if ((p.versionsCount ?? 0) === 0) {
        out[p.id] = null;
        continue;
      }
      const qh = projectQualityHistoryMap[p.id] ?? [];
      const last = qh.length > 0 ? qh[qh.length - 1] : null;
      // Prefer the browser-local trend's latest score; fall back to the server version-summary
      // score so imports made outside this browser (e.g. the CLI) still sort/score correctly.
      out[p.id] =
        last != null
          ? last.overall
          : typeof p.qualityScore === 'number'
            ? p.qualityScore
            : null;
    }
    return out;
  }, [projects, projectQualityHistoryMap]);

  const sortedProjects = useMemo(
    () => sortProjectsDashboardRows(projects, sortColumn, sortDirection, latestQualityByProjectId),
    [projects, sortColumn, sortDirection, latestQualityByProjectId]
  );

  const portfolioQualitySeries = useMemo(
    () => buildPortfolioQualitySeries(projectQualityHistoryMap),
    [projectQualityHistoryMap]
  );

  const projectsHeaderSubtitle = useMemo(() => {
    const n = projects.length;
    const scored = projects
      .map((p) => latestQualityByProjectId[p.id])
      .filter((x): x is number => x != null);
    const avg =
      scored.length > 0 ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
    const active = projects.filter((p) => p.enabled && !p.deleted_at).length;
    const parts: string[] = [`${n} project${n === 1 ? '' : 's'}`];
    if (avg != null) parts.push(`avg quality ${avg}`);
    parts.push(`${active} active`);
    if (showDeleted) {
      const del = projects.filter((p) => p.deleted_at).length;
      if (del > 0) parts.push(`${del} deleted`);
    }
    return parts.join(' · ');
  }, [projects, latestQualityByProjectId, showDeleted]);

  const displayedProjects = useMemo(() => {
    let rows = sortedProjects;
    const q = projectSearchQuery.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.slug ?? '').toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q)
      );
    }
    if (projectsFilterChip === 'active') {
      rows = rows.filter((p) => p.enabled && !p.deleted_at);
    } else if (projectsFilterChip === 'attention') {
      rows = rows.filter((p) => !p.enabled || Boolean(p.deleted_at));
    } else if (projectsFilterChip === 'deleted') {
      rows = rows.filter((p) => Boolean(p.deleted_at));
    }
    return rows;
  }, [sortedProjects, projectSearchQuery, projectsFilterChip]);

  const filterChipCounts = useMemo(() => {
    const all = sortedProjects.length;
    const active = sortedProjects.filter((p) => p.enabled && !p.deleted_at).length;
    const attention = sortedProjects.filter((p) => !p.enabled || Boolean(p.deleted_at)).length;
    const deleted = sortedProjects.filter((p) => p.deleted_at).length;
    return { all, active, attention, deleted };
  }, [sortedProjects]);

  const sortSummaryLabel = useMemo(() => {
    const arrow = sortDirection === 'asc' ? '↑' : '↓';
    switch (sortColumn) {
      case 'updated':
        return `last activity ${arrow}`;
      case 'name':
        return `name ${arrow}`;
      case 'created':
        return `created ${arrow}`;
      case 'quality':
        return `quality ${arrow}`;
      case 'status':
        return `status ${arrow}`;
      case 'creator':
        return `creator ${arrow}`;
      case 'description':
        return `description ${arrow}`;
      default:
        return `sorted ${arrow}`;
    }
  }, [sortColumn, sortDirection]);

  const handleProjectsSortHeaderClick = useCallback((column: ProjectsDashboardSortColumn) => {
    setSortColumn((prevCol) => {
      if (prevCol === column) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevCol;
      }
      setSortDirection('asc');
      return column;
    });
  }, []);

  const loadProjects = useCallback(async () => {
    if (!currentTenantId) {
      setProjects([]);
      setProjectsListLoading(false);
      return;
    }
    setProjectsListLoading(true);
    try {
      const qs = showDeleted ? '?include_deleted=true' : '';
      const response = await fetch(`/api/projects${qs}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch projects: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.success && data.projects) {
        // Catalog items (non-OpenAPI imports, publishable=false) never list here (#4587):
        // they live in Dashboard → Catalog until converted to OpenAPI, which mints a project.
        setProjects((data.projects as Project[]).filter(isProjectPublishable));
      } else {
        throw new Error(data.error || 'Failed to load projects');
      }
    } catch (error) {
      console.error('Failed to load projects:', error);
      setProjects([]);
    } finally {
      setProjectsListLoading(false);
    }
  }, [currentTenantId, showDeleted]);

  useEffect(() => {
    if (currentTenantId) void loadProjects();
  }, [currentTenantId, loadProjects]);

  useEffect(() => {
    if (!showDeleted && projectsFilterChip === 'deleted') {
      setProjectsFilterChip('all');
    }
  }, [showDeleted, projectsFilterChip]);

  const handleCreateClick = () => {
    setProjectName('');
    setProjectDescription('');
    setProjectSlug('');
    setProjectEnabled(true);
    setErrorMessage('');
    setCreateDialogTab('manual');
    setMetadataSummary('');
    setMetadataTermsOfService('');
    setMetadataContactName('');
    setMetadataContactUrl('');
    setMetadataContactEmail('');
    setMetadataLicenseName('');
    setMetadataLicenseIdentifier('');
    setMetadataLicenseUrl('');
    setSelectedStartTemplateId('blank');
    setProjectDomainCategoryId(PROJECT_DOMAIN_CATEGORY_NONE);
    setShowCreateDialog(true);
  };

  const handleImportClick = () => setShowImportDialog(true);
  const handleImportSuccess = async () => {
    await loadProjects();
    setQualityHistoryEpoch((e) => e + 1);
  };

  const handleCreateSubmit = async () => {
    if (!projectName.trim()) { setErrorMessage('Project name is required'); return; }
    if (!projectSlug.trim()) { setErrorMessage('Project slug is required'); return; }
    setIsLoading(true);
    setErrorMessage('');

    try {
      const metadata: ProjectMetadata = {};
      if (metadataSummary.trim()) metadata.summary = metadataSummary.trim();
      if (metadataTermsOfService.trim()) metadata.termsOfService = metadataTermsOfService.trim();
      if (metadataContactName.trim() || metadataContactUrl.trim() || metadataContactEmail.trim()) {
        metadata.contact = {};
        if (metadataContactName.trim()) metadata.contact.name = metadataContactName.trim();
        if (metadataContactUrl.trim()) metadata.contact.url = metadataContactUrl.trim();
        if (metadataContactEmail.trim()) metadata.contact.email = metadataContactEmail.trim();
      }
      if (metadataLicenseName.trim() || metadataLicenseIdentifier.trim() || metadataLicenseUrl.trim()) {
        metadata.license = {};
        if (metadataLicenseName.trim()) metadata.license.name = metadataLicenseName.trim();
        if (metadataLicenseIdentifier.trim()) metadata.license.identifier = metadataLicenseIdentifier.trim();
        if (metadataLicenseUrl.trim()) metadata.license.url = metadataLicenseUrl.trim();
      }
      if (projectDomainCategoryId !== PROJECT_DOMAIN_CATEGORY_NONE) {
        metadata.domainCategory = projectDomainCategoryId;
      }

      const result = await createProject(currentTenantId, currentUserId, projectName, projectDescription, projectSlug, metadata);
      const response = JSON.parse(result);
      if (response.success) { setShowCreateDialog(false); await loadProjects(); }
      else setErrorMessage(response.error || 'Failed to create project');
    } catch (error: any) {
      setErrorMessage(error.message || 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditClick = (project: Project) => {
    setSelectedProject(project);
    setProjectName(project.name);
    setProjectDescription(project.description || '');
    setProjectSlug((project as any).slug || '');
    setProjectEnabled(project.enabled);
    setErrorMessage('');
    const metadata = project.metadata || {};
    setMetadataSummary(metadata.summary || '');
    setMetadataTermsOfService(metadata.termsOfService || '');
    setMetadataContactName(metadata.contact?.name || '');
    setMetadataContactUrl(metadata.contact?.url || '');
    setMetadataContactEmail(metadata.contact?.email || '');
    setMetadataLicenseName(metadata.license?.name || '');
    setMetadataLicenseIdentifier(metadata.license?.identifier || '');
    setMetadataLicenseUrl(metadata.license?.url || '');
    setProjectDomainCategoryId(metadata.domainCategory ?? PROJECT_DOMAIN_CATEGORY_NONE);
    setShowEditDialog(true);
  };

  const handleEditSubmit = async () => {
    if (!projectName.trim()) { setErrorMessage('Project name is required'); return; }
    if (!projectSlug.trim()) { setErrorMessage('Project slug is required'); return; }
    if (!selectedProject) return;
    setIsLoading(true);
    setErrorMessage('');

    try {
      const metadata: ProjectMetadata = {};
      if (metadataSummary.trim()) metadata.summary = metadataSummary.trim();
      if (metadataTermsOfService.trim()) metadata.termsOfService = metadataTermsOfService.trim();
      if (metadataContactName.trim() || metadataContactUrl.trim() || metadataContactEmail.trim()) {
        metadata.contact = {};
        if (metadataContactName.trim()) metadata.contact.name = metadataContactName.trim();
        if (metadataContactUrl.trim()) metadata.contact.url = metadataContactUrl.trim();
        if (metadataContactEmail.trim()) metadata.contact.email = metadataContactEmail.trim();
      }
      if (metadataLicenseName.trim() || metadataLicenseIdentifier.trim() || metadataLicenseUrl.trim()) {
        metadata.license = {};
        if (metadataLicenseName.trim()) metadata.license.name = metadataLicenseName.trim();
        if (metadataLicenseIdentifier.trim()) metadata.license.identifier = metadataLicenseIdentifier.trim();
        if (metadataLicenseUrl.trim()) metadata.license.url = metadataLicenseUrl.trim();
      }
      if (projectDomainCategoryId !== PROJECT_DOMAIN_CATEGORY_NONE) {
        metadata.domainCategory = projectDomainCategoryId;
      }

      const result = await updateProject(selectedProject.id, projectName, projectDescription, projectSlug, projectEnabled, metadata);
      const response = JSON.parse(result);
      if (response.success) { setShowEditDialog(false); await loadProjects(); }
      else setErrorMessage(response.error || 'Failed to update project');
    } catch (error: any) {
      setErrorMessage(error.message || 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (projectId: string) => {
    const confirmed = await confirmDialog({
      title: 'Delete Project',
      message:
        'This soft-deletes the project (it is hidden from pickers). You can undelete it later from Projects by turning on "Show deleted".',
      variant: 'danger',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    try {
      const result = await deleteProject(projectId);
      const response = JSON.parse(result);
      if (response.success) await loadProjects();
      else await alertDialog({ message: response.error || 'Failed to delete project', variant: 'error' });
    } catch (error: any) {
      await alertDialog({ message: error.message || 'An error occurred', variant: 'error' });
    }
  };

  const handleRestore = async (project: Project) => {
    const confirmed = await confirmDialog({
      title: 'Undelete Project',
      message: `Undelete "${project.name}"? It will return to normal lists and pickers with the same enabled/disabled state it had before deletion.`,
      variant: 'info',
      confirmLabel: 'Undelete',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    try {
      const result = await restoreProject(project.id);
      const response = JSON.parse(result);
      if (response.success) {
        toast.success('Project undeleted.');
        await loadProjects();
      } else {
        await alertDialog({ message: response.error || 'Failed to undelete project', variant: 'error' });
      }
    } catch (error: any) {
      await alertDialog({ message: error.message || 'An error occurred', variant: 'error' });
    }
  };

  const handlePermanentDelete = async (project: Project) => {
    const confirmed = await confirmDialog({
      title: 'Permanently Delete Project',
      message: `Are you absolutely sure you want to permanently delete "${project.name}"?\n\nThis will permanently delete:\n• All versions of this project\n• All publications associated with those versions\n• All classes and their properties\n• All properties directly linked to this project\n\nThis action CANNOT be undone and all data will be lost forever.`,
      variant: 'danger',
      confirmLabel: 'Permanently Delete',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    // Double confirmation for safety
    const doubleConfirmed = await confirmDialog({
      title: 'Final Confirmation',
      message: `Type "DELETE" mentally and confirm: You are about to permanently destroy all data for project "${project.name}". This is your last chance to cancel.`,
      variant: 'danger',
      confirmLabel: 'Yes, Delete Everything',
      cancelLabel: 'Cancel',
    });
    if (!doubleConfirmed) return;

    try {
      const result = await permanentDeleteProject(project.id);
      const response = JSON.parse(result);
      if (response.success) {
        toast.success('Project and all associated data have been permanently deleted.');
        await loadProjects();
      } else {
        await alertDialog({ message: response.error || 'Failed to permanently delete project', variant: 'error' });
      }
    } catch (error: any) {
      await alertDialog({ message: error.message || 'An error occurred', variant: 'error' });
    }
  };

  const formatDateTime = (dateString: string) => {
    const d = new Date(dateString);
    const datePart = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timePart = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
  };

  const handleLicenseSelect = (identifier: string) => {
    const license = SPDX_LICENSES.find((l: SPDXLicense) => l.identifier === identifier);
    if (license) {
      setMetadataLicenseIdentifier(license.identifier);
      setMetadataLicenseName(license.name);
      const url = getLicenseUrl(license.identifier);
      if (url) setMetadataLicenseUrl(url);
    }
  };

  const createProjectManualModel: CreateProjectManualFormModel = useMemo(
    () => ({
      projectName,
      projectSlug,
      projectDescription,
      selectedStartTemplateId,
      projectDomainCategoryId,
      metadataSummary,
      metadataTermsOfService,
      metadataContactName,
      metadataContactUrl,
      metadataContactEmail,
      metadataLicenseName,
      metadataLicenseIdentifier,
      metadataLicenseUrl,
    }),
    [
      projectName,
      projectSlug,
      projectDescription,
      selectedStartTemplateId,
      projectDomainCategoryId,
      metadataSummary,
      metadataTermsOfService,
      metadataContactName,
      metadataContactUrl,
      metadataContactEmail,
      metadataLicenseName,
      metadataLicenseIdentifier,
      metadataLicenseUrl,
    ]
  );

  const patchCreateProjectManual = (patch: Partial<CreateProjectManualFormModel>) => {
    if (patch.projectName !== undefined) setProjectName(patch.projectName);
    if (patch.projectSlug !== undefined) setProjectSlug(patch.projectSlug);
    if (patch.projectDescription !== undefined) setProjectDescription(patch.projectDescription);
    if (patch.selectedStartTemplateId !== undefined) setSelectedStartTemplateId(patch.selectedStartTemplateId);
    if (patch.projectDomainCategoryId !== undefined) setProjectDomainCategoryId(patch.projectDomainCategoryId);
    if (patch.metadataSummary !== undefined) setMetadataSummary(patch.metadataSummary);
    if (patch.metadataTermsOfService !== undefined) setMetadataTermsOfService(patch.metadataTermsOfService);
    if (patch.metadataContactName !== undefined) setMetadataContactName(patch.metadataContactName);
    if (patch.metadataContactUrl !== undefined) setMetadataContactUrl(patch.metadataContactUrl);
    if (patch.metadataContactEmail !== undefined) setMetadataContactEmail(patch.metadataContactEmail);
    if (patch.metadataLicenseName !== undefined) setMetadataLicenseName(patch.metadataLicenseName);
    if (patch.metadataLicenseIdentifier !== undefined) setMetadataLicenseIdentifier(patch.metadataLicenseIdentifier);
    if (patch.metadataLicenseUrl !== undefined) setMetadataLicenseUrl(patch.metadataLicenseUrl);
  };

  if (!session) {
    return (
      <div className="p-6">
        <LoadingState minHeightClassName="min-h-[220px]" message="Loading projects..." />
      </div>
    );
  }

  if (!currentTenantId) {
    return (
      <div className="p-6">
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <Lock className="h-6 w-6 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-1" />
            <div>
              <h2 className="text-lg font-semibold text-yellow-900 dark:text-yellow-100 mb-2">No Tenant Selected</h2>
              <p className="text-yellow-800 dark:text-yellow-200 mb-3">Please select a tenant before managing projects.</p>
              <Button asChild><a href="/ade/dashboard/tenants">Go to Tenants</a></Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="px-6 py-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Folders className="h-6 w-6 shrink-0 text-indigo-500 dark:text-indigo-400" aria-hidden />
              Projects
            </h2>
            <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">{projectsHeaderSubtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <div className="hidden md:flex h-8 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 dark:border-gray-700 dark:bg-gray-900/40">
              <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
              <input
                value={projectSearchQuery}
                onChange={(e) => setProjectSearchQuery(e.target.value)}
                className="w-40 bg-transparent text-xs outline-none placeholder:text-gray-400 dark:text-gray-200"
                placeholder="Filter projects…"
                aria-label="Filter projects"
              />
            </div>
            <div className="flex items-center gap-1 rounded-md border border-gray-200 p-0.5 dark:border-gray-700">
              <button
                type="button"
                onClick={() => setProjectsViewMode('cards')}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                  projectsViewMode === 'cards'
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                    : 'text-gray-500 hover:text-indigo-500 dark:text-gray-400'
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
                Cards
              </button>
              <button
                type="button"
                onClick={() => setProjectsViewMode('table')}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                  projectsViewMode === 'table'
                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                    : 'text-gray-500 hover:text-indigo-500 dark:text-gray-400'
                )}
              >
                <List className="h-3.5 w-3.5" aria-hidden />
                Table
              </button>
            </div>
            <Button
              onClick={() => {
                setImportOpenedFromNewProjectAI(false);
                setShowNewImportDialog(true);
              }}
              variant="secondary"
              disabled={!currentTenantId}
              title={!currentTenantId ? 'Please select a tenant first' : 'Import specification'}
              className="h-9"
            >
              <Upload className="mr-2 h-4 w-4" />
              Import
            </Button>
            <Button onClick={handleCreateClick} className="h-9 bg-indigo-600 hover:bg-indigo-700">
              <Plus className="mr-2 h-4 w-4" />
              New project
            </Button>
            <div className="flex h-9 items-center gap-2 rounded-md border border-gray-200 px-3 dark:border-gray-700 dark:bg-gray-900/30">
              <Label htmlFor="projects-show-deleted" className="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">
                Show deleted
              </Label>
              <Switch
                id="projects-show-deleted"
                checked={showDeleted}
                onCheckedChange={setShowDeleted}
                aria-label="Show soft-deleted projects in the list"
              />
            </div>
          </div>
        </div>
      </header>

      <main className={dashboardMainClass} aria-busy={projectsListLoading}>
        <div className={dashboardContentStackClass}>
      {/* Projects List */}
      {projectsListLoading ? (
        <div className={dashboardTableWrapClass}>
          <LoadingState minHeightClassName="min-h-[220px]" message="Loading projects…" />
        </div>
      ) : projects.length === 0 ? (
        <div className={dashboardTableWrapClass}>
          <div className="p-8">
            <EmptyState
              icon={<FolderOpen className="h-10 w-10" />}
              title="No Projects Yet"
              description="Get started by creating your first project"
              variant="compact"
              showOrbs={false}
              iconContainerClassName="from-indigo-500 to-purple-600 shadow-indigo-500/30"
            />
          </div>
        </div>
      ) : (
        <>
          <section className="flex flex-wrap items-center gap-2">
            <span className="mr-2 text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Views:
            </span>
            <button
              type="button"
              onClick={() => setProjectsFilterChip('all')}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                projectsFilterChip === 'all'
                  ? 'border-indigo-300 bg-indigo-500/10 text-indigo-600 dark:border-indigo-600 dark:text-indigo-400'
                  : 'border-gray-200 text-gray-500 hover:border-indigo-300 dark:border-gray-700 dark:text-gray-400 dark:hover:border-indigo-600'
              )}
            >
              All{' '}
              <span className="ml-1 font-mono text-gray-400 dark:text-gray-500">{filterChipCounts.all}</span>
            </button>
            <button
              type="button"
              onClick={() => setProjectsFilterChip('active')}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                projectsFilterChip === 'active'
                  ? 'border-indigo-300 bg-indigo-500/10 font-medium text-indigo-600 dark:border-indigo-600 dark:text-indigo-400'
                  : 'border-gray-200 text-gray-500 hover:border-indigo-300 dark:border-gray-700 dark:text-gray-400'
              )}
            >
              Active{' '}
              <span className="ml-1 font-mono">{filterChipCounts.active}</span>
            </button>
            <button
              type="button"
              onClick={() => setProjectsFilterChip('attention')}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                projectsFilterChip === 'attention'
                  ? 'border-amber-400 bg-amber-500/10 font-medium text-amber-800 dark:border-amber-700/40 dark:text-amber-300'
                  : 'border-gray-200 text-gray-500 hover:border-amber-300 dark:border-gray-700 dark:text-gray-400'
              )}
            >
              Needs attention{' '}
              <span className="ml-1 font-mono">{filterChipCounts.attention}</span>
            </button>
            <button
              type="button"
              disabled={!showDeleted}
              title={!showDeleted ? 'Turn on Show deleted to use this view' : undefined}
              onClick={() => showDeleted && setProjectsFilterChip('deleted')}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                projectsFilterChip === 'deleted'
                  ? 'border-indigo-300 bg-indigo-500/10 font-medium text-indigo-600 dark:border-indigo-600 dark:text-indigo-400'
                  : 'border-gray-200 text-gray-500 hover:border-indigo-300 dark:border-gray-700 dark:text-gray-400',
                !showDeleted &&
                  'cursor-not-allowed opacity-40 hover:border-gray-200 dark:hover:border-gray-700'
              )}
            >
              Deleted{' '}
              <span className="ml-1 font-mono">{filterChipCounts.deleted}</span>
            </button>
            <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
              Sorted by{' '}
              <span className="font-medium text-indigo-600 dark:text-indigo-400">{sortSummaryLabel}</span>
            </span>
          </section>

          {displayedProjects.length === 0 ? (
            <div
              className={`${dashboardPanelClass} p-10 text-center text-sm text-gray-600 dark:text-gray-400`}
            >
              No projects match your filters or search.
            </div>
          ) : projectsViewMode === 'cards' ? (
            <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
              {displayedProjects.map((project) => {
                const isDeleted = Boolean(project.deleted_at);
                const qh = projectQualityHistoryMap[project.id] ?? [];
                return (
                  <ProjectsDashboardProjectCard
                    key={project.id}
                    project={project}
                    qualityHistory={qh}
                    avatarGradientClass={projectCardGradientClass(project.id)}
                    avatarInitials={projectCardInitials(project.name)}
                    creatorInitials={projectCardInitials(project.creator_name)}
                    shortProjectId={formatShortProjectId(project.id)}
                    onOpenQualityHistory={() => {
                      setQualityDialogSection('quality');
                      setQualityTrendProject(project);
                    }}
                    onOpenLintReport={() => {
                      setQualityDialogSection('lint');
                      setQualityTrendProject(project);
                    }}
                    onNavigateToVersions={() =>
                      router.push(`/ade/dashboard/versions?projectId=${encodeURIComponent(project.id)}`)
                    }
                    actionsSlot={
                      <ProjectDashboardActions
                        project={project}
                        isDeleted={isDeleted}
                        openProjectDropdown={openProjectDropdown}
                        setOpenProjectDropdown={setOpenProjectDropdown}
                        dropdownPosition={dropdownPosition}
                        setDropdownPosition={setDropdownPosition}
                        onEdit={handleEditClick}
                        onDelete={handleDelete}
                        onRestore={handleRestore}
                        onPermanentDelete={handlePermanentDelete}
                      />
                    }
                  />
                );
              })}
            </section>
          ) : (
            <div className={dashboardTableWrapClass}>
              <div className="overflow-x-auto">
                <table className="min-w-full">
                  <thead className={dashboardTableTheadClass}>
                    <tr>
                      <ProjectsSortTh
                        column="name"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSortClick={handleProjectsSortHeaderClick}
                    className={`${dashboardThClass} w-64`}
                    testId="projects-sort-name"
                    ariaLabel="Sort by project name"
                  >
                    Project Name
                  </ProjectsSortTh>
                  <ProjectsSortTh
                    column="description"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSortClick={handleProjectsSortHeaderClick}
                    className={dashboardThClass}
                    testId="projects-sort-description"
                    ariaLabel="Sort by description"
                  >
                    Description
                  </ProjectsSortTh>
                  <ProjectsSortTh
                    column="quality"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSortClick={handleProjectsSortHeaderClick}
                    className={`${dashboardThClass} w-[11rem]`}
                    testId="projects-sort-quality"
                    ariaLabel="Sort by version-summary quality score"
                  >
                    <TrendingUp className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
                    Quality trend
                  </ProjectsSortTh>
                  <ProjectsSortTh
                    column="versions"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSortClick={handleProjectsSortHeaderClick}
                    className={`${dashboardThClass} w-28`}
                    testId="projects-sort-versions"
                    ariaLabel="Sort by version count"
                  >
                    Versions
                  </ProjectsSortTh>
                  <ProjectsSortTh
                    column="status"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSortClick={handleProjectsSortHeaderClick}
                    className={`${dashboardThClass} w-48`}
                    testId="projects-sort-status"
                    ariaLabel="Sort by status"
                  >
                    Status
                  </ProjectsSortTh>
                  <ProjectsSortTh
                    column="creator"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSortClick={handleProjectsSortHeaderClick}
                    className={`${dashboardThClass} w-56`}
                    testId="projects-sort-creator"
                    ariaLabel="Sort by creator"
                  >
                    Created By
                  </ProjectsSortTh>
                  <ProjectsSortTh
                    column="created"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSortClick={handleProjectsSortHeaderClick}
                    className={`${dashboardThClass} w-40`}
                    testId="projects-sort-created"
                    ariaLabel="Sort by created date"
                  >
                    Created
                  </ProjectsSortTh>
                  <ProjectsSortTh
                    column="updated"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSortClick={handleProjectsSortHeaderClick}
                    className={`${dashboardThClass} w-40`}
                    testId="projects-sort-updated"
                    ariaLabel="Sort by updated date"
                  >
                    Updated
                  </ProjectsSortTh>
                  <th scope="col" className={`${dashboardThRightClass} w-24`} aria-sort="none">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className={dashboardTbodyClass}>
                {displayedProjects.map((project) => {
                  const domainCategoryLabel = getProjectDomainCategoryLabel(project.metadata?.domainCategory);
                  const isDeleted = Boolean(project.deleted_at);
                  return (
                  <tr
                    key={project.id}
                    className={
                      isDeleted
                        ? `${dashboardTrHoverClass} cursor-default opacity-80`
                        : `${dashboardTrHoverClass} cursor-pointer`
                    }
                    onClick={() => {
                      if (isDeleted) return;
                      router.push(
                        `/ade/dashboard/versions?projectId=${encodeURIComponent(project.id)}`
                      );
                    }}
                    title={
                      isDeleted
                        ? 'This project is deleted — use Undelete or the actions menu to restore it, or permanently delete'
                        : 'View versions for this project'
                    }
                  >
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1">
                        <div className="text-sm font-semibold text-gray-900 dark:text-white truncate max-w-xs" title={project.name}>
                          {project.name}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate" title={project.slug}>
                          {project.slug || '—'}
                        </div>
                        {domainCategoryLabel ? (
                          <span
                            className="inline-flex mt-1 max-w-xs items-center rounded-md px-2 py-0.5 text-xs font-medium bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
                            title={domainCategoryLabel}
                          >
                            {domainCategoryLabel}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-600 dark:text-gray-400 truncate max-w-md" title={project.description || ''}>
                        {project.description || <span className="text-gray-400 dark:text-gray-600">No description</span>}
                      </div>
                      {project.metadata?.summary && (
                        <div className="text-xs text-gray-500 dark:text-gray-500 truncate max-w-md mt-1" title={project.metadata.summary}>
                          {project.metadata.summary}
                        </div>
                      )}
                    </td>
                    <td className="w-[11rem] max-w-[11rem] px-6 py-4 align-middle whitespace-nowrap">
                      {(() => {
                        const versionsCount = project.versionsCount ?? 0;
                        if (versionsCount === 0) {
                          return (
                            <span
                              className="text-xs font-medium text-gray-500 dark:text-gray-400"
                              title="This project has no versions yet"
                              data-testid="projects-table-empty"
                            >
                              Empty project
                            </span>
                          );
                        }
                        const qh = projectQualityHistoryMap[project.id] ?? [];
                        const latest = qh.length > 0 ? qh[qh.length - 1] : null;
                        const tier = latest ? getNumericScoreTier(latest.overall) : null;
                        const serverScore =
                          typeof project.qualityScore === 'number' ? project.qualityScore : null;
                        if (!latest) {
                          if (serverScore === null) {
                            return (
                              <span className="text-xs text-gray-400 dark:text-gray-600" title="No quality score captured yet">
                                —
                              </span>
                            );
                          }
                          // Version-summary score (mean across revisions) with no browser-local
                          // trend history — show a static badge instead of a sparkline.
                          const serverTier = getNumericScoreTier(serverScore);
                          return (
                            <span
                              className={`inline-flex items-center gap-1 text-sm font-semibold tabular-nums leading-none ${serverTier?.textClass ?? ''}`}
                              title="Mean quality score across project versions"
                            >
                              {serverScore}
                              {project.qualityGrade ? (
                                <span className="text-xs font-medium opacity-70">({project.qualityGrade})</span>
                              ) : null}
                            </span>
                          );
                        }
                        return (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setQualityDialogSection('trend');
                              setQualityTrendProject(project);
                            }}
                            className="inline-flex max-w-full items-center gap-2 rounded-lg border border-transparent px-1 py-0.5 text-left transition-colors hover:border-indigo-200 hover:bg-indigo-50/60 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/40"
                            title="Open quality score history"
                          >
                            <div className="h-8 w-[4.5rem] shrink-0 overflow-hidden rounded-md border border-gray-200/80 bg-gray-100 dark:border-gray-700 dark:bg-gray-900/80">
                              <ProjectQualityTrendSparkline history={qh} className="block h-full w-full" />
                            </div>
                            <span
                              className={`shrink-0 text-sm font-semibold tabular-nums leading-none ${tier?.textClass ?? ''}`}
                            >
                              {latest.overall}
                            </span>
                          </button>
                        );
                      })()}
                    </td>
                    <td className="w-28 px-6 py-4 align-middle whitespace-nowrap">
                      <span
                        className="font-mono text-sm font-semibold tabular-nums text-gray-900 dark:text-white"
                        data-testid="projects-table-versions-count"
                        title={`${project.versionsCount ?? 0} version${(project.versionsCount ?? 0) === 1 ? '' : 's'}`}
                      >
                        {project.versionsCount ?? 0}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          {project.enabled ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                              Enabled
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
                              Disabled
                            </span>
                          )}
                        </div>
                        {project.deleted_at && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">
                            <Trash2 className="w-3 h-3" />
                            Deleted
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900 dark:text-white truncate" title={project.creator_name}>
                        {project.creator_name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate" title={project.creator_email}>
                        {project.creator_email}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-500 dark:text-gray-400" title={formatDateTime(project.created_at)}>
                        {formatDateTime(project.created_at)}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-500 dark:text-gray-400" title={formatDateTime(project.updated_at)}>
                        {formatDateTime(project.updated_at)}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <ProjectDashboardActions
                        project={project}
                        isDeleted={isDeleted}
                        openProjectDropdown={openProjectDropdown}
                        setOpenProjectDropdown={setOpenProjectDropdown}
                        dropdownPosition={dropdownPosition}
                        setDropdownPosition={setDropdownPosition}
                        onEdit={handleEditClick}
                        onDelete={handleDelete}
                        onRestore={handleRestore}
                        onPermanentDelete={handlePermanentDelete}
                      />
                    </td>
                </tr>
                  );
                })}
            </tbody>
          </table>
              </div>
            </div>
          )}

          <section className={`${dashboardPanelClass} overflow-hidden`}>
            <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-5 py-4 dark:border-gray-700 dark:bg-gray-900">
              <div className="flex items-center gap-3">
                <TrendingUp className="h-5 w-5 shrink-0 text-indigo-500" aria-hidden />
                <div>
                  <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                    Portfolio quality trend
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Average quality score across projects after each import (this browser)
                  </p>
                </div>
              </div>
            </div>
            <div className="p-5">
              <PortfolioQualityTrendChart series={portfolioQualitySeries} />
            </div>
          </section>
        </>
      )}
        </div>
      </main>

      {/* Create Project Dialog */}
      <Dialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          if (!open) {
            if (createDialogTab === 'ai') {
              aiPanelRef.current?.abort();
              setCreateDialogTab('manual');
              return;
            }
            aiPanelRef.current?.abort();
          }
          if (!isLoading) setShowCreateDialog(open);
        }}
      >
        <DialogContent className="w-[1280px] max-w-[95vw] h-[90vh] flex flex-col" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-purple-100 to-indigo-100 dark:from-purple-900/30 dark:to-indigo-900/30">
                <FolderOpen className="h-5 w-5 text-purple-600 dark:text-purple-400" />
              </div>
              Create New Project
            </DialogTitle>
          </DialogHeader>
          <Tabs value={createDialogTab} onValueChange={(v) => setCreateDialogTab(v as 'manual' | 'ai')} className="flex-1 flex flex-col min-h-0 mt-0">
            <TabsList className="w-full">
              <TabsTrigger value="manual">
                <FileEdit className="h-4 w-4" />
                Create manually
              </TabsTrigger>
              <TabsTrigger value="ai">
                <Bot className="h-4 w-4" />
                Design with AI
              </TabsTrigger>
            </TabsList>
            <TabsContent value="manual" className="mt-4 flex-1 min-h-0 overflow-y-auto pr-1">
              <CreateProjectManualFormFields
                fieldIdPrefix="dashboard-projects-create-"
                disabled={isLoading}
                errorMessage={errorMessage}
                model={createProjectManualModel}
                onChange={patchCreateProjectManual}
              />
              <DialogFooter className="mt-6">
                <Button variant="outline" onClick={() => setShowCreateDialog(false)} disabled={isLoading}>
                  Cancel
                </Button>
                <Button onClick={handleCreateSubmit} disabled={isLoading} className="bg-gradient-to-r from-purple-500 to-indigo-600">
                  {isLoading ? 'Creating...' : 'Create Project'}
                </Button>
              </DialogFooter>
            </TabsContent>
            <TabsContent value="ai" className="mt-4 flex-1 min-h-0 flex flex-col p-0 data-[state=inactive]:hidden">
              {currentTenantId && currentUserId && (
                <LLMChatPanel
                  ref={aiPanelRef}
                  tenantId={currentTenantId}
                  userId={currentUserId}
                  embedded
                  className="flex-1 min-h-0"
                  onImportSpec={(specContent) => {
                    setPendingLLMSpec(specContent);
                    setImportOpenedFromNewProjectAI(true);
                    setShowCreateDialog(false);
                    setShowNewImportDialog(true);
                  }}
                />
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <ProjectQualityHistoryDialog
        key={
          qualityTrendProject
            ? `${qualityTrendProject.id}:${qualityDialogSection}`
            : 'project-quality-dialog-closed'
        }
        open={qualityTrendProject !== null}
        onOpenChange={(open) => {
          if (!open) setQualityTrendProject(null);
        }}
        projectName={qualityTrendProject?.name ?? ''}
        projectId={qualityTrendProject?.id ?? ''}
        history={qualityTrendProject ? projectQualityHistoryMap[qualityTrendProject.id] ?? [] : []}
        initialSection={qualityDialogSection}
      />

      {/* New Import Dialog (Step 1 - Source Selection) */}
      {currentTenantId && currentUserId && (
        <ImportDialog
          open={showNewImportDialog}
          onClose={() => setShowNewImportDialog(false)}
          onSuccess={handleImportSuccess}
          tenantId={currentTenantId}
          userId={currentUserId}
          // Projects owns the native OpenAPI/Swagger intake; the alternative (non-OpenAPI) formats
          // live on the Catalog importer instead (MFI-23.12).
          variant="projects"
          initialLLMSpec={pendingLLMSpec}
          onConsumeInitialLLMSpec={() => setPendingLLMSpec(null)}
          openedFromNewProjectAI={importOpenedFromNewProjectAI}
          onReturnToNewProjectAI={() => {
            setShowNewImportDialog(false);
            setShowCreateDialog(true);
            setCreateDialogTab('ai');
            setImportOpenedFromNewProjectAI(false);
          }}
        />
      )}

      {/* OpenAPI Import Dialog (Legacy - will be replaced by multi-step flow) */}
      {currentTenantId && currentUserId && (
        <OpenAPIImportDialog open={showImportDialog} onClose={() => setShowImportDialog(false)} onSuccess={handleImportSuccess} tenantId={currentTenantId} userId={currentUserId} />
      )}

      {/* Edit Project Dialog */}
      <Dialog open={showEditDialog} onOpenChange={(open) => !isLoading && setShowEditDialog(open)}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col" aria-describedby={undefined}>
          <DialogHeader className="shrink-0">
            <DialogTitle>Edit Project</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          {errorMessage && <Alert variant="error" className="mt-4">{errorMessage}</Alert>}
          {selectedProject && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
              <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/50 p-3">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Status</div>
                <div className="text-sm font-medium text-gray-900 dark:text-white">
                  {selectedProject.deleted_at ? (
                    <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                      <Trash2 className="w-4 h-4" /> Deleted
                    </span>
                  ) : selectedProject.enabled ? (
                    <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Enabled
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-400" /> Disabled
                    </span>
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/50 p-3">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Created by</div>
                <div className="text-sm font-medium text-gray-900 dark:text-white truncate" title={selectedProject.creator_name}>{selectedProject.creator_name}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate" title={selectedProject.creator_email}>{selectedProject.creator_email}</div>
              </div>
              <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/50 p-3">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Created</div>
                <div className="text-sm text-gray-900 dark:text-white">{formatDateTime(selectedProject.created_at)}</div>
              </div>
              <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/50 p-3">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Updated</div>
                <div className="text-sm text-gray-900 dark:text-white">{formatDateTime(selectedProject.updated_at)}</div>
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 divide-x divide-gray-200 dark:divide-gray-700 mt-4">
            {/* Left: Basic Information */}
            <div className="flex flex-col pr-4 lg:pr-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">Basic Information</h3>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="editName">Project Name *</Label>
                  <Input id="editName" value={projectName} onChange={(e) => setProjectName(e.target.value)} disabled={isLoading} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editSlug">Slug *</Label>
                  <Input id="editSlug" value={projectSlug} onChange={(e) => setProjectSlug(filterSlugInput(e.target.value))} disabled={isLoading} className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editDescription">Description</Label>
                  <Textarea id="editDescription" value={projectDescription} onChange={(e) => setProjectDescription(e.target.value)} disabled={isLoading} rows={4} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editDomainCategory">Domain category</Label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Optional. Classifies the kind of entities and schemas this project models.
                  </p>
                  <Select
                    value={projectDomainCategoryId}
                    onValueChange={setProjectDomainCategoryId}
                    disabled={isLoading}
                  >
                    <SelectTrigger id="editDomainCategory" className="max-w-xl">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PROJECT_DOMAIN_CATEGORY_NONE}>None</SelectItem>
                      {PROJECT_DOMAIN_CATEGORIES.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedProjectDomainCategory?.hint ? (
                    <p className="text-xs text-gray-500 dark:text-gray-500 max-w-xl">{selectedProjectDomainCategory.hint}</p>
                  ) : null}
                </div>
              </div>
            </div>
            {/* Right: API Metadata */}
            <div className="flex flex-col pl-4 lg:pl-6 pt-4 lg:pt-0">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">API Metadata</h3>
              <div className="space-y-6">
                <div className="space-y-4">
                  <h4 className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wide">OpenAPI</h4>
                  <div className="space-y-2">
                    <Label htmlFor="summary">API Summary</Label>
                    <Input id="summary" value={metadataSummary} onChange={(e) => setMetadataSummary(e.target.value)} disabled={isLoading} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="termsOfService">Terms of Service URL</Label>
                    <div className="flex gap-2">
                      <Input id="termsOfService" type="url" value={metadataTermsOfService} onChange={(e) => setMetadataTermsOfService(e.target.value)} disabled={isLoading} placeholder="https://example.com/terms" className="flex-1 min-w-0" />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={isLoading || !metadataTermsOfService.trim() || (!metadataTermsOfService.trim().startsWith('http://') && !metadataTermsOfService.trim().startsWith('https://'))}
                        onClick={() => window.open(metadataTermsOfService.trim(), '_blank', 'noopener,noreferrer')}
                        title="Open URL in new window"
                        className="shrink-0"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="space-y-4">
                  <h4 className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wide">Contact</h4>
                  <div className="grid grid-cols-1 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="contactName">Name</Label>
                      <Input id="contactName" value={metadataContactName} onChange={(e) => setMetadataContactName(e.target.value)} disabled={isLoading} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contactUrl">URL</Label>
                      <div className="flex gap-2">
                        <Input id="contactUrl" type="url" value={metadataContactUrl} onChange={(e) => setMetadataContactUrl(e.target.value)} disabled={isLoading} className="flex-1 min-w-0" />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          disabled={isLoading || !metadataContactUrl.trim() || (!metadataContactUrl.trim().startsWith('http://') && !metadataContactUrl.trim().startsWith('https://'))}
                          onClick={() => window.open(metadataContactUrl.trim(), '_blank', 'noopener,noreferrer')}
                          title="Open URL in new window"
                          className="shrink-0"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contactEmail">Email</Label>
                      <Input id="contactEmail" type="email" value={metadataContactEmail} onChange={(e) => setMetadataContactEmail(e.target.value)} disabled={isLoading} />
                    </div>
                  </div>
                </div>
                <div className="space-y-4">
                  <h4 className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wide">License</h4>
                  <div className="space-y-2">
                    <Label htmlFor="licenseIdentifier">License (SPDX)</Label>
                    <Select value={metadataLicenseIdentifier} onValueChange={handleLicenseSelect}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a license..." />
                      </SelectTrigger>
                      <SelectContent className="max-h-60">
                        {SPDX_LICENSES.slice(0, 50).map((license: SPDXLicense) => (
                          <SelectItem key={license.identifier} value={license.identifier}>{license.name} ({license.identifier})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="licenseName">License Name</Label>
                      <Input id="licenseName" value={metadataLicenseName} onChange={(e) => setMetadataLicenseName(e.target.value)} disabled={isLoading} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="licenseUrl">License URL</Label>
                      <div className="flex gap-2">
                        <Input id="licenseUrl" type="url" value={metadataLicenseUrl} onChange={(e) => setMetadataLicenseUrl(e.target.value)} disabled={isLoading} className="flex-1 min-w-0" />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          disabled={isLoading || !metadataLicenseUrl.trim() || (!metadataLicenseUrl.trim().startsWith('http://') && !metadataLicenseUrl.trim().startsWith('https://'))}
                          onClick={() => window.open(metadataLicenseUrl.trim(), '_blank', 'noopener,noreferrer')}
                          title="Open URL in new window"
                          className="shrink-0"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
          <DialogFooter className="mt-6 shrink-0">
            <Button variant="outline" onClick={() => setShowEditDialog(false)} disabled={isLoading}>Cancel</Button>
            <Button
              onClick={handleEditSubmit}
              disabled={isLoading || Boolean(selectedProject?.deleted_at)}
            >
              {isLoading ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default Projects;

