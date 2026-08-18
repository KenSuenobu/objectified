'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LayoutGrid, List, Plus, TriangleAlert, Trash2, Undo2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

import { useAuthSession } from '@lib/auth/session-client';
import type { ShortcutBinding } from '@lib/shortcuts';
import {
  createProject,
  deleteProject,
  permanentDeleteProject,
  restoreProject,
  updateProject,
} from '@lib/db/helper';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { OPEN_ACTIONS, useOpenAction } from '@/app/components/shell/openActions';
import { useShortcuts } from '@/app/hooks/useShortcuts';
import { Button } from '@/app/components/ui/Button';
import {
  DataTableBulkAction,
  DataTableFilterChip,
  DataTableSearch,
  DataTableToolbar,
  DataTableToolbarSpacer,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { Card } from '@/app/components/ui/Card';
import { EmptyState, GatedState } from '@/app/components/ui/EmptyState';
import { Label } from '@/app/components/ui/Label';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import { Switch } from '@/app/components/ui/Switch';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { ProjectQualityHistoryDialog } from '@/app/components/ade/dashboard/ProjectQualityHistoryDialog';
import ImportDialog from '@/app/components/ade/dashboard/ImportDialog';
import {
  EMPTY_CREATE_PROJECT_MANUAL_FORM,
  type CreateProjectManualFormModel,
} from '@/app/components/ade/dashboard/projects/CreateProjectManualFormFields';
import {
  DEFAULT_PROJECT_SORT,
  PROJECT_FACETS,
  PROJECT_FACET_LABELS,
  PortfolioTrendCard,
  ProjectCard,
  ProjectCreateDialog,
  ProjectCreateTile,
  ProjectEditDialog,
  ProjectsTable,
  PROJECT_SORT_OPTIONS,
  bulkResultMessage,
  latestQualityByProject,
  matchesProjectFacet,
  permanentDeleteProjectConfirm,
  projectBulkPlan,
  projectFacetCounts,
  projectSortLabel,
  projectVersionsHref,
  projectsSummaryLine,
  searchProjects,
  softDeleteProjectConfirm,
  sortProjects,
  undeleteProjectConfirm,
  type CreateProjectTab,
  type Project,
  type ProjectFacet,
} from '@/app/components/ade/projects';
import { isProjectPublishable } from '@/app/utils/catalog-publishable';
import {
  buildPortfolioQualitySeries,
  getProjectQualityHistory,
  type ProjectQualityReportSection,
  type ProjectQualitySnapshot,
} from '@/app/utils/project-quality-score-history';
import { PROJECT_DOMAIN_CATEGORY_NONE } from '@/app/utils/project-domain-categories';
import type { ProjectOpenApiMetadata } from '@/app/utils/project-templates';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/** Which of the two views is drawing the list. */
type ProjectsView = 'cards' | 'table';

/**
 * Projects — `/ade/dashboard/projects` (HIVE-6.1, #5312).
 *
 * Authority: `docs/mockups/build/projects.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header), §8 (list page, destructive
 * confirms, keyboard), §3.1 (status vocabulary).
 *
 * ### What this screen owns, and what it no longer does
 *
 * It owns the projects, the six writes, which view is drawing them, and which overlay is
 * open. It does **not** own any of the rules: which chip counts what, which of two quality
 * numbers wins, what the header sentence reads, what the permanent-delete gate asks for —
 * all of that is `projectsModel`, where it can be tested without rendering a screen. The
 * 1,731-line `page.tsx` this replaces had them inline, which is how the card and the table
 * came to disagree about an empty project.
 *
 * ### The two views are one list
 *
 * Search, chips, sort and selection live here, above both views, and both are handed the same
 * already-narrowed array. That is the ticket's first acceptance criterion, and making it
 * true by construction is cheaper than testing for it: there is only one `visible`.
 *
 * ### Four things this fixes rather than restyles
 *
 * 1. **Permanent delete was two native confirms.** The second was identical to the first —
 *    a delay dressed as a check. It is one gated dialog now, and the phrase is the project's
 *    **slug**: two projects may share a display name, and only one may hold a slug.
 * 2. **The card was a button full of buttons.** `role="button"` with a `tabIndex` around
 *    three real buttons is `nested-interactive`, a serious axe finding. See `ProjectCard`.
 * 3. **A dead legacy dialog was still mounted.** `OpenAPIImportDialog` was rendered on every
 *    paint behind a flag nothing ever set; the only handler that set it was never called.
 * 4. **The list could not be acted on in bulk.** Restoring six projects after a mistaken
 *    sweep meant six menus and six confirms; the mockup's bulk bar is one of each.
 */
export default function ProjectsClient() {
  const router = useRouter();
  const { data: session } = useAuthSession();
  const { confirm, alert } = useDialog();

  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;
  const currentUserId = (session?.user as { user_id?: string } | undefined)?.user_id;

  // ---- the list ---------------------------------------------------------------------------

  const [projects, setProjects] = React.useState<Project[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showDeleted, setShowDeleted] = React.useState(false);

  const [view, setView] = React.useState<ProjectsView>('cards');
  const [query, setQuery] = React.useState('');
  const [facet, setFacet] = React.useState<ProjectFacet>('all');
  const [sort, setSort] = React.useState<DataTableSortState | null>(DEFAULT_PROJECT_SORT);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);

  const searchRef = React.useRef<HTMLInputElement | null>(null);

  /**
   * Bumped whenever something may have written new quality snapshots, which is the only way
   * this screen learns that `localStorage` changed — an import finishing inside a dialog does
   * not re-render anything out here.
   */
  const [historyEpoch, setHistoryEpoch] = React.useState(0);

  const loadProjects = React.useCallback(async () => {
    if (!currentTenantId) {
      setProjects([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/projects${showDeleted ? '?include_deleted=true' : ''}`);
      if (!response.ok) throw new Error(`Failed to load projects: ${response.statusText}`);
      const data = await response.json();
      if (!data.success || !data.projects) throw new Error(data.error || 'Failed to load projects');
      // Catalog items (non-OpenAPI imports, `publishable=false`) never list here (#4587):
      // they live in Dashboard → Catalog until converted to OpenAPI, which mints a project.
      setProjects((data.projects as Project[]).filter(isProjectPublishable));
      setLoadError(null);
    } catch (error) {
      setProjects([]);
      setLoadError(error instanceof Error ? error.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, [currentTenantId, showDeleted]);

  React.useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  /** The Deleted chip cannot outlive the switch that reveals deleted rows. */
  React.useEffect(() => {
    if (!showDeleted && facet === 'deleted') setFacet('all');
  }, [showDeleted, facet]);

  // ---- quality history --------------------------------------------------------------------

  const historyById = React.useMemo<Record<string, ProjectQualitySnapshot[]>>(() => {
    const map: Record<string, ProjectQualitySnapshot[]> = {};
    for (const project of projects) map[project.id] = getProjectQualityHistory(project.id);
    return map;
    // `historyEpoch` is a real dependency: it is what says the store has been written to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, historyEpoch]);

  const latestQuality = React.useMemo(
    () => latestQualityByProject(projects, historyById),
    [projects, historyById]
  );

  const portfolioSeries = React.useMemo(
    () => buildPortfolioQualitySeries(historyById),
    [historyById]
  );

  // ---- narrowing --------------------------------------------------------------------------

  const searched = React.useMemo(() => searchProjects(projects, query), [projects, query]);
  const counts = React.useMemo(() => projectFacetCounts(searched), [searched]);
  const visible = React.useMemo(
    () =>
      sortProjects(
        searched.filter((project) => matchesProjectFacet(project, facet)),
        sort,
        latestQuality
      ),
    [searched, facet, sort, latestQuality]
  );
  const narrowed = query.trim().length > 0 || facet !== 'all';

  /** Selection follows the list: an id that has been filtered away must not be acted on. */
  React.useEffect(() => {
    setSelectedIds((current) => {
      const onScreen = new Set(visible.map((project) => project.id));
      const next = current.filter((id) => onScreen.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visible]);

  const summary = React.useMemo(
    () => projectsSummaryLine(projects, latestQuality, showDeleted),
    [projects, latestQuality, showDeleted]
  );

  // ---- overlays ---------------------------------------------------------------------------

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createTab, setCreateTab] = React.useState<CreateProjectTab>('manual');
  const [editing, setEditing] = React.useState<Project | null>(null);
  const [form, setForm] = React.useState<CreateProjectManualFormModel>(
    EMPTY_CREATE_PROJECT_MANUAL_FORM
  );
  const [formError, setFormError] = React.useState<string | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [importFromAi, setImportFromAi] = React.useState(false);
  const [pendingSpec, setPendingSpec] = React.useState<string | null>(null);
  const [scoresFor, setScoresFor] = React.useState<Project | null>(null);
  const [scoresSection, setScoresSection] =
    React.useState<ProjectQualityReportSection>('trend');
  const aiPanelRef = React.useRef<{ abort: () => void } | null>(null);

  const patchForm = React.useCallback(
    (patch: Partial<CreateProjectManualFormModel>) => setForm((prev) => ({ ...prev, ...patch })),
    []
  );

  const openCreate = React.useCallback(() => {
    setForm(EMPTY_CREATE_PROJECT_MANUAL_FORM);
    setFormError(null);
    setCreateTab('manual');
    setCreateOpen(true);
  }, []);

  const openImport = React.useCallback(() => {
    setImportFromAi(false);
    setImportOpen(true);
  }, []);

  const openEdit = React.useCallback((project: Project) => {
    const metadata = project.metadata ?? {};
    setEditing(project);
    setFormError(null);
    setForm({
      ...EMPTY_CREATE_PROJECT_MANUAL_FORM,
      projectName: project.name,
      projectSlug: project.slug ?? '',
      projectDescription: project.description ?? '',
      projectDomainCategoryId: metadata.domainCategory ?? PROJECT_DOMAIN_CATEGORY_NONE,
      metadataSummary: metadata.summary ?? '',
      metadataTermsOfService: metadata.termsOfService ?? '',
      metadataContactName: metadata.contact?.name ?? '',
      metadataContactUrl: metadata.contact?.url ?? '',
      metadataContactEmail: metadata.contact?.email ?? '',
      metadataLicenseName: metadata.license?.name ?? '',
      metadataLicenseIdentifier: metadata.license?.identifier ?? '',
      metadataLicenseUrl: metadata.license?.url ?? '',
    });
  }, []);

  const openScores = React.useCallback(
    (project: Project, section: ProjectQualityReportSection) => {
      setScoresSection(section);
      setScoresFor(project);
    },
    []
  );

  /*
   * The command palette's "New project…" and "Import a spec…" actions (HIVE-3.6, #5292).
   * The palette navigates here with `?open=…` and this page opens the dialog it already owns,
   * so the two entry points cannot drift into two different forms. `useOpenAction` strips the
   * parameter, so a reload or the back button does not reopen the dialog.
   */
  useOpenAction(OPEN_ACTIONS.newProject, openCreate);
  useOpenAction(OPEN_ACTIONS.importSpec, openImport);

  /**
   * `N`, `I` and `/` — DESIGN.md §8's list-page keys.
   *
   * Registered together and only while a workspace is chosen, because all three act on a list
   * that does not exist without one. Registration is a stack and the most recent wins, so `/`
   * belongs to this screen's filter box for as long as it is mounted and returns to the
   * command palette when it is not.
   */
  const shortcuts = React.useMemo<readonly ShortcutBinding[]>(
    () =>
      currentTenantId
        ? [
            {
              id: 'projects-new',
              scope: 'list',
              description: 'New project',
              chord: { key: 'n' },
              run: openCreate,
            },
            {
              id: 'projects-import',
              scope: 'list',
              description: 'Import a specification',
              chord: { key: 'i' },
              run: openImport,
            },
            {
              id: 'projects-filter',
              scope: 'list',
              description: 'Filter projects',
              chord: { key: '/' },
              run: () => searchRef.current?.focus(),
            },
          ]
        : [],
    [currentTenantId, openCreate, openImport]
  );
  useShortcuts(shortcuts);

  // ---- writes ------------------------------------------------------------------------------

  /**
   * Run one write, then reload the list.
   *
   * Every write on this screen returns the same JSON-in-a-string envelope from
   * `lib/db/helper`, so unwrapping it — and reporting a refusal as a sentence rather than as
   * a thrown object — is done once here.
   *
   * @param write The call.
   * @param fallback What to say if the refusal carried no message.
   * @returns `null` on success, or the sentence to show.
   */
  const runWrite = React.useCallback(
    async (write: () => Promise<string>, fallback: string): Promise<string | null> => {
      try {
        const parsed = JSON.parse(await write());
        if (parsed?.success) return null;
        return typeof parsed?.error === 'string' && parsed.error ? parsed.error : fallback;
      } catch (error) {
        return error instanceof Error && error.message ? error.message : fallback;
      }
    },
    []
  );

  /** The OpenAPI metadata the two form dialogs build out of the shared model. */
  const metadataFromForm = React.useCallback(
    (model: CreateProjectManualFormModel): ProjectOpenApiMetadata => {
      const metadata: ProjectOpenApiMetadata = {};
      if (model.metadataSummary.trim()) metadata.summary = model.metadataSummary.trim();
      if (model.metadataTermsOfService.trim()) {
        metadata.termsOfService = model.metadataTermsOfService.trim();
      }
      const contact = {
        name: model.metadataContactName.trim(),
        url: model.metadataContactUrl.trim(),
        email: model.metadataContactEmail.trim(),
      };
      if (contact.name || contact.url || contact.email) {
        metadata.contact = {};
        if (contact.name) metadata.contact.name = contact.name;
        if (contact.url) metadata.contact.url = contact.url;
        if (contact.email) metadata.contact.email = contact.email;
      }
      const license = {
        name: model.metadataLicenseName.trim(),
        identifier: model.metadataLicenseIdentifier.trim(),
        url: model.metadataLicenseUrl.trim(),
      };
      if (license.name || license.identifier || license.url) {
        metadata.license = {};
        if (license.name) metadata.license.name = license.name;
        if (license.identifier) metadata.license.identifier = license.identifier;
        if (license.url) metadata.license.url = license.url;
      }
      if (model.projectDomainCategoryId !== PROJECT_DOMAIN_CATEGORY_NONE) {
        metadata.domainCategory = model.projectDomainCategoryId;
      }
      return metadata;
    },
    []
  );

  const handleCreate = React.useCallback(async () => {
    if (!form.projectName.trim()) return setFormError('Project name is required.');
    if (!form.projectSlug.trim()) return setFormError('Project slug is required.');
    if (!currentTenantId || !currentUserId) {
      return setFormError('Select a workspace before creating a project.');
    }
    setBusy(true);
    setFormError(null);
    const failure = await runWrite(
      () =>
        createProject(
          currentTenantId,
          currentUserId,
          form.projectName,
          form.projectDescription,
          form.projectSlug,
          metadataFromForm(form)
        ),
      'Failed to create the project.'
    );
    setBusy(false);
    if (failure) return setFormError(failure);
    setCreateOpen(false);
    toast.success(`Created "${form.projectName.trim()}".`);
    await loadProjects();
  }, [currentTenantId, currentUserId, form, loadProjects, metadataFromForm, runWrite]);

  const handleEditSubmit = React.useCallback(async () => {
    if (!editing) return;
    if (!form.projectName.trim()) return setFormError('Project name is required.');
    if (!form.projectSlug.trim()) return setFormError('Project slug is required.');
    setBusy(true);
    setFormError(null);
    const failure = await runWrite(
      () =>
        updateProject(
          editing.id,
          form.projectName,
          form.projectDescription,
          form.projectSlug,
          editing.enabled,
          metadataFromForm(form)
        ),
      'Failed to save the project.'
    );
    setBusy(false);
    if (failure) return setFormError(failure);
    setEditing(null);
    toast.success('Project saved.');
    await loadProjects();
  }, [editing, form, loadProjects, metadataFromForm, runWrite]);

  const handleDelete = React.useCallback(
    async (project: Project) => {
      if (!(await confirm(softDeleteProjectConfirm(project)))) return;
      setBusy(true);
      const failure = await runWrite(
        () => deleteProject(project.id),
        'Failed to delete the project.'
      );
      setBusy(false);
      if (failure) return void alert({ message: failure, variant: 'error' });
      toast.success(`Deleted "${project.name}".`);
      await loadProjects();
    },
    [alert, confirm, loadProjects, runWrite]
  );

  const handleRestore = React.useCallback(
    async (project: Project) => {
      if (!(await confirm(undeleteProjectConfirm(project)))) return;
      setBusy(true);
      const failure = await runWrite(
        () => restoreProject(project.id),
        'Failed to undelete the project.'
      );
      setBusy(false);
      if (failure) return void alert({ message: failure, variant: 'error' });
      toast.success(`Undeleted "${project.name}".`);
      await loadProjects();
    },
    [alert, confirm, loadProjects, runWrite]
  );

  const handlePermanentDelete = React.useCallback(
    async (project: Project) => {
      if (!(await confirm(permanentDeleteProjectConfirm(project)))) return;
      setBusy(true);
      const failure = await runWrite(
        () => permanentDeleteProject(project.id),
        'Failed to permanently delete the project.'
      );
      setBusy(false);
      if (failure) return void alert({ message: failure, variant: 'error' });
      toast.success(`"${project.name}" and everything in it have been permanently deleted.`);
      await loadProjects();
    },
    [alert, confirm, loadProjects, runWrite]
  );

  /**
   * One bulk verb over the rows it applies to.
   *
   * Writes are sequential rather than parallel: these are the same endpoints a single-row
   * action calls, and firing eight of them at once at a soft-delete that cascades is how a
   * list page turns into a load test. The result states the split — see `bulkResultMessage`.
   */
  const runBulk = React.useCallback(
    async (
      rows: readonly Project[],
      write: (project: Project) => Promise<string>,
      verb: string,
      fallback: string
    ) => {
      setBusy(true);
      let applied = 0;
      let firstError: string | null = null;
      for (const project of rows) {
        const failure = await runWrite(() => write(project), fallback);
        if (failure) firstError ??= failure;
        else applied += 1;
      }
      setBusy(false);
      setSelectedIds([]);
      const message = bulkResultMessage(verb, applied, rows.length, firstError);
      if (applied === rows.length) toast.success(message);
      else toast.error(message);
      await loadProjects();
    },
    [loadProjects, runWrite]
  );

  const bulk = React.useMemo(
    () => projectBulkPlan(visible, selectedIds),
    [visible, selectedIds]
  );

  const handleImportSuccess = React.useCallback(async () => {
    await loadProjects();
    setHistoryEpoch((epoch) => epoch + 1);
  }, [loadProjects]);

  /*
   * Re-read the score store whenever the import wizard closes, not only when it reports
   * success. The wizard writes a snapshot the moment its analysis finishes, which is before
   * — and independently of — the success callback; a reader who imported and then dismissed
   * the wizard should still see the ring move.
   */
  const importWasOpen = React.useRef(false);
  React.useEffect(() => {
    if (importWasOpen.current && !importOpen) setHistoryEpoch((epoch) => epoch + 1);
    importWasOpen.current = importOpen;
  }, [importOpen]);

  const openVersions = React.useCallback(
    (project: Project) => router.push(projectVersionsHref(project)),
    [router]
  );

  // ---- the toolbar, shared by both views ---------------------------------------------------

  const toolbar = (
    <DataTableToolbar>
      <DataTableSearch
        ref={searchRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter projects…  ( / )"
        aria-label="Filter projects"
        data-testid="projects-search"
      />
      {PROJECT_FACETS.map((entry) => (
        <DataTableFilterChip
          key={entry}
          active={facet === entry}
          count={counts[entry]}
          disabled={entry === 'deleted' && !showDeleted}
          title={
            entry === 'deleted' && !showDeleted
              ? 'Turn on Show deleted to use this view'
              : undefined
          }
          data-testid={`projects-facet-${entry}`}
          onClick={() => setFacet(entry)}
        >
          {entry === 'attention' ? <TriangleAlert className="prj-chip-glyph" aria-hidden /> : null}
          {PROJECT_FACET_LABELS[entry]}
        </DataTableFilterChip>
      ))}
      <DataTableToolbarSpacer />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="sm" data-testid="projects-sort-menu">
            Sorted by {projectSortLabel(sort)}
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="tnt-menu" sideOffset={4} align="end">
            {PROJECT_SORT_OPTIONS.map((option) => (
              <DropdownMenu.Item
                key={option.id}
                className="tnt-menu__item"
                data-testid={`projects-sort-${option.id}`}
                onSelect={() =>
                  setSort((current) =>
                    current && current.column === option.id
                      ? {
                          column: option.id,
                          direction: current.direction === 'asc' ? 'desc' : 'asc',
                        }
                      : { column: option.id, direction: 'asc' }
                  )
                }
              >
                {option.label}
                {sort && sort.column === option.id ? (
                  <span className="prj-sort-mark" aria-hidden>
                    {sort.direction === 'asc' ? '↑' : '↓'}
                  </span>
                ) : null}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Segmented
        value={view}
        onValueChange={(next) => setView(next as ProjectsView)}
        size="sm"
        aria-label="List view"
      >
        <SegmentedItem value="cards" data-testid="projects-view-cards">
          <LayoutGrid aria-hidden />
          Cards
        </SegmentedItem>
        <SegmentedItem value="table" data-testid="projects-view-table">
          <List aria-hidden />
          Table
        </SegmentedItem>
      </Segmented>
    </DataTableToolbar>
  );

  const emptyState = narrowed ? (
    <EmptyState
      variant="compact"
      surface={false}
      tone="neutral"
      title="No projects match your filters or search"
      description="Clear the search box or pick another view above."
      action={
        <Button
          variant="outline"
          onClick={() => {
            setQuery('');
            setFacet('all');
          }}
        >
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      variant="compact"
      surface={false}
      title="No projects yet"
      description="Create one, or import an OpenAPI specification you already have."
      action={
        <Button onClick={openCreate}>
          <Plus aria-hidden />
          New project
        </Button>
      }
      secondaryAction={
        <Button variant="outline" onClick={openImport}>
          <Upload aria-hidden />
          Import
        </Button>
      }
    />
  );

  const bulkActions = (
    <>
      {bulk.deletable.length > 0 ? (
        <DataTableBulkAction
          variant="danger-soft"
          disabled={busy}
          data-testid="projects-bulk-delete"
          onClick={() =>
            void runBulk(
              bulk.deletable,
              (project) => deleteProject(project.id),
              'Deleted',
              'Failed to delete the project.'
            )
          }
        >
          <Trash2 aria-hidden />
          Delete {bulk.deletable.length}
        </DataTableBulkAction>
      ) : null}
      {bulk.restorable.length > 0 ? (
        <DataTableBulkAction
          disabled={busy}
          data-testid="projects-bulk-restore"
          onClick={() =>
            void runBulk(
              bulk.restorable,
              (project) => restoreProject(project.id),
              'Undeleted',
              'Failed to undelete the project.'
            )
          }
        >
          <Undo2 aria-hidden />
          Undelete {bulk.restorable.length}
        </DataTableBulkAction>
      ) : null}
    </>
  );

  // ---- the page -----------------------------------------------------------------------------

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: 'Home', href: HOME_ROUTE }, { label: 'Build' }, { label: 'Projects' }]}
        title="Projects"
        description={summary}
        actions={
          <>
            <span className="prj-deleted-switch">
              <Switch
                id="projects-show-deleted"
                checked={showDeleted}
                onCheckedChange={setShowDeleted}
                aria-label="Show soft-deleted projects in the list"
              />
              <Label htmlFor="projects-show-deleted">Show deleted</Label>
            </span>
            <Button
              variant="outline"
              kbd="I"
              disabled={!currentTenantId}
              onClick={openImport}
              data-testid="projects-import"
            >
              <Upload aria-hidden />
              Import
            </Button>
            <Button
              kbd="N"
              disabled={!currentTenantId}
              onClick={openCreate}
              data-testid="projects-create"
            >
              <Plus aria-hidden />
              New project
            </Button>
          </>
        }
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description="Projects are scoped to one workspace." />
        ) : (
          <>
            {view === 'table' ? (
              <ProjectsTable
                projects={visible}
                historyById={historyById}
                loading={loading}
                error={loadError}
                onRetry={() => void loadProjects()}
                sort={sort}
                onSortChange={setSort}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                bulkActions={bulkActions}
                onOpen={openVersions}
                onOpenTrend={(project) => openScores(project, 'trend')}
                onEdit={openEdit}
                onDelete={(project) => void handleDelete(project)}
                onRestore={(project) => void handleRestore(project)}
                onPermanentDelete={(project) => void handlePermanentDelete(project)}
                busy={busy}
                toolbar={toolbar}
                empty={emptyState}
              />
            ) : (
              <Card className="prj-cards-panel" data-testid="projects-cards">
                {toolbar}
                {loading ? (
                  <div className="prj-grid" aria-busy>
                    {[0, 1, 2].map((index) => (
                      <div key={index} className="prj-card prj-card--skeleton" aria-hidden />
                    ))}
                    <p className="sr-only" role="status">
                      Loading projects…
                    </p>
                  </div>
                ) : visible.length === 0 ? (
                  <div className="prj-cards-panel__empty">{emptyState}</div>
                ) : (
                  <div className="prj-grid">
                    {visible.map((project) => (
                      <ProjectCard
                        key={project.id}
                        project={project}
                        qualityHistory={historyById[project.id] ?? []}
                        busy={busy}
                        onOpenQuality={(target) => openScores(target, 'quality')}
                        onOpenLint={(target) => openScores(target, 'lint')}
                        onEdit={openEdit}
                        onDelete={(target) => void handleDelete(target)}
                        onRestore={(target) => void handleRestore(target)}
                        onPermanentDelete={(target) => void handlePermanentDelete(target)}
                      />
                    ))}
                    <ProjectCreateTile onCreate={openCreate} />
                  </div>
                )}
              </Card>
            )}

            <PortfolioTrendCard series={portfolioSeries} />
          </>
        )}
      </PageBody>

      <ProjectCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        tab={createTab}
        onTabChange={setCreateTab}
        model={form}
        onModelChange={patchForm}
        onSubmit={() => void handleCreate()}
        busy={busy}
        error={formError}
        tenantId={currentTenantId}
        userId={currentUserId}
        aiPanelRef={aiPanelRef}
        onImportSpec={(spec) => {
          setPendingSpec(spec);
          setImportFromAi(true);
          setCreateOpen(false);
          setImportOpen(true);
        }}
      />

      <ProjectEditDialog
        project={editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        model={form}
        onModelChange={patchForm}
        onSubmit={() => void handleEditSubmit()}
        busy={busy}
        error={formError}
      />

      <ProjectQualityHistoryDialog
        key={scoresFor ? `${scoresFor.id}:${scoresSection}` : 'project-scores-closed'}
        open={scoresFor !== null}
        onOpenChange={(open) => {
          if (!open) setScoresFor(null);
        }}
        projectName={scoresFor?.name ?? ''}
        projectId={scoresFor?.id ?? ''}
        history={scoresFor ? (historyById[scoresFor.id] ?? []) : []}
        initialSection={scoresSection}
      />

      {currentTenantId && currentUserId ? (
        <ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onSuccess={handleImportSuccess}
          tenantId={currentTenantId}
          userId={currentUserId}
          // Projects owns the native OpenAPI/Swagger intake; the alternative (non-OpenAPI)
          // formats live on the Catalog importer instead (MFI-23.12).
          variant="projects"
          initialLLMSpec={pendingSpec}
          onConsumeInitialLLMSpec={() => setPendingSpec(null)}
          openedFromNewProjectAI={importFromAi}
          onReturnToNewProjectAI={() => {
            setImportOpen(false);
            setCreateOpen(true);
            setCreateTab('ai');
            setImportFromAi(false);
          }}
        />
      ) : null}
    </Page>
  );
}
