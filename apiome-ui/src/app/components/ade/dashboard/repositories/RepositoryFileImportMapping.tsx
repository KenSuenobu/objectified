'use client';

/**
 * Map & import — one repository file into the catalog (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Map & import wizard — an overlay
 * carrying *Target project* (existing or create-new), *Version to create*, *Import options*,
 * a diff placeholder, the source facts, and the run itself.
 *
 * ### It is an overlay now, not a page
 *
 * What this replaces returned a full-width pane *instead of* the Files tab. Opening it
 * unmounted the browser, so a reader lost their branch, their filters, their page and their
 * selection; `onBack` put them back at the top of an unfiltered list. It is a `dialog--full`
 * over the tab now — the mockup's own frame, and the same `.imp-wizard*` shell HIVE-6.4 built
 * for the catalog importer, so the two wizards are one object rather than two that resemble
 * each other. Closing returns to the row that opened it.
 *
 * ### The scoped choice control
 *
 * *Target project* is two radio cards, and the first of them contains a project `Select`, a
 * read-only slug field and a *Clear selection* button. The screen this replaces expressed that
 * as a `role="button" tabIndex={0}` `<div>` with `onKeyDown` handling Enter and Space, and an
 * `onClick={(e) => e.stopPropagation()}` on every nested control to stop the card swallowing
 * the click. That is an axe `nested-interactive` violation, and the `stopPropagation` calls
 * are the symptom rather than the fix.
 *
 * The card is now a plain `<div>` whose radio carries a `<label>` scoped to the choice's
 * *title* — the ticket's third acceptance criterion, and the HIVE-2.1 scoped choice-control
 * pattern. The nested fields are ordinary siblings: clickable, reachable by Tab, and no longer
 * inside a label that would toggle the radio when they are used. The card still paints as
 * chosen, still shows one focus ring and still moves under the arrow keys, because all three
 * are `:has()` selectors on the radio rather than markup wrapped around it.
 *
 * ### The import job is unchanged
 *
 * Every field this collects goes to the same `startImport` call, with the same
 * `repositorySource` descriptor and the same options object, as before — the ticket's second
 * acceptance criterion. The execution and summary phases are the shared
 * `ImportExecutionPanel` / `ImportCompletePanel`, drawn inside the overlay rather than in
 * place of it.
 */

import {
  CheckCircle2,
  Download,
  FolderOpen,
  FolderPlus,
  GitPullRequestArrow,
  Loader2,
} from 'lucide-react';
import { useAuthSession } from '@lib/auth/session-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createProject } from '@lib/db/helper';
import { startImport, getImportStatus } from '@lib/db/import-actions';
import { appendProjectQualitySnapshot, buildQualitySnapshotReportExtras } from '@/app/utils/project-quality-score-history';
import { analyzeSpecification, type AnalysisResult } from '@/app/utils/openapi-analyzer';
import { generateSlug } from '@/app/utils/slug';
import ImportExecutionPanel from '@/app/components/ade/dashboard/ImportExecutionPanel';
import ImportCompletePanel from '@/app/components/ade/dashboard/ImportCompletePanel';
import type { ImportOptions } from '@/app/components/ade/dashboard/PreviewPanel';
import { ImportOptionsForm } from '@/app/components/ade/dashboard/ImportOptionsForm';
import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent } from '@/app/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import { MAP_IMPORT_DIFF_STUB_COPY } from '@/app/components/ade/repositories';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { Skeleton } from '@/app/components/ui/Skeleton';
import {
  getRepositoryFileImportableVerdict,
  parseRepositoryFileSpecMetadata,
} from '@lib/repository-file-spec-metadata';
import { deriveRepositoryImportSourceDescriptor } from '@lib/repository-import-source-descriptor';
import {
  projectDraftFromRepositorySpec,
  type RepositorySpecProjectDraft,
} from '@lib/project-draft-from-repository-spec';
import { filterSlugInput } from '@/app/utils/slug';
import {
  CreateProjectManualFormFields,
  EMPTY_CREATE_PROJECT_MANUAL_FORM,
  type CreateProjectManualFormModel,
} from '@/app/components/ade/dashboard/projects/CreateProjectManualFormFields';
import { PROJECT_DOMAIN_CATEGORY_NONE } from '@/app/utils/project-domain-categories';
import type { ProjectOpenApiMetadata } from '@/app/utils/project-templates';
import RepositoryImportSpecMetadataPanel from './RepositoryImportSpecMetadataPanel';
import type { RepositoryFileDetailRow } from './RepositoryFileDetail';
import type { RepositoryFileStagedImportTarget } from './repositoryFileStagedImport';

type FileContentApi = {
  success?: boolean;
  path: string;
  branch: string;
  display_kind: string;
  confidence: string;
  blob_sha?: string | null;
  size_bytes?: number | null;
  content: string;
  truncated?: boolean;
  error?: string;
};

function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—';
  const s = sha.trim();
  return s.length > 7 ? s.slice(0, 7) : s;
}

/** Heuristic one-line “mapping rule” for the target-project card (until server rules exist). */
function suggestedRuleFromPath(path: string, title: string | null): string {
  const base = path.split('/').pop() ?? path;
  const stem = base.replace(/\.(ya?ml|json)$/i, '');
  const glob = base.includes('/') ? `**/${stem}*.{yaml,yml,json}` : `${stem}*.{yaml,yml,json}`;
  const target = title?.trim() || 'New project from spec';
  return `${glob} → ${target}`;
}

type TargetMode = 'existing' | 'new';

type ImportFlowStep = 'mapping' | 'newProjectDraft';

type NewProjectDialogView = 'form' | 'metadata';

function createProjectFormFromSpecDraft(d: RepositorySpecProjectDraft): CreateProjectManualFormModel {
  return {
    ...EMPTY_CREATE_PROJECT_MANUAL_FORM,
    projectName: d.projectName,
    projectSlug: filterSlugInput(d.projectSlug),
    projectDescription: d.projectDescription,
    metadataSummary: d.metadataSummary,
    metadataTermsOfService: d.metadataTermsOfService,
    metadataContactName: d.metadataContactName,
    metadataContactUrl: d.metadataContactUrl,
    metadataContactEmail: d.metadataContactEmail,
    metadataLicenseName: d.metadataLicenseName,
    metadataLicenseIdentifier: d.metadataLicenseIdentifier,
    metadataLicenseUrl: d.metadataLicenseUrl,
  };
}

function metadataFromManualForm(model: CreateProjectManualFormModel): ProjectOpenApiMetadata {
  const metadata: ProjectOpenApiMetadata = {};
  if (model.metadataSummary.trim()) metadata.summary = model.metadataSummary.trim();
  if (model.metadataTermsOfService.trim()) metadata.termsOfService = model.metadataTermsOfService.trim();
  if (
    model.metadataContactName.trim() ||
    model.metadataContactUrl.trim() ||
    model.metadataContactEmail.trim()
  ) {
    metadata.contact = {};
    if (model.metadataContactName.trim()) metadata.contact.name = model.metadataContactName.trim();
    if (model.metadataContactUrl.trim()) metadata.contact.url = model.metadataContactUrl.trim();
    if (model.metadataContactEmail.trim()) metadata.contact.email = model.metadataContactEmail.trim();
  }
  if (
    model.metadataLicenseName.trim() ||
    model.metadataLicenseIdentifier.trim() ||
    model.metadataLicenseUrl.trim()
  ) {
    metadata.license = {};
    if (model.metadataLicenseName.trim()) metadata.license.name = model.metadataLicenseName.trim();
    if (model.metadataLicenseIdentifier.trim()) metadata.license.identifier = model.metadataLicenseIdentifier.trim();
    if (model.metadataLicenseUrl.trim()) metadata.license.url = model.metadataLicenseUrl.trim();
  }
  if (model.projectDomainCategoryId !== PROJECT_DOMAIN_CATEGORY_NONE) {
    metadata.domainCategory = model.projectDomainCategoryId;
  }
  return metadata;
}

export type StagedImportProject = {
  id: string;
  name: string;
  slug: string;
};

function parseProjectsList(payload: unknown): StagedImportProject[] {
  if (!Array.isArray(payload)) return [];
  const out: StagedImportProject[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = String(o.id ?? '').trim();
    if (!id) continue;
    const name = String(o.name ?? 'Untitled').trim() || 'Untitled';
    const slug = String(o.slug ?? '').trim() || name.toLowerCase().replace(/\s+/g, '-');
    out.push({ id, name, slug });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

function analysisFilenameForRepoImport(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'openapi.yaml';
}

function defaultImportOptionsFromAnalysis(analysis: AnalysisResult): ImportOptions {
  const schemaObj = analysis.document?.components?.schemas || analysis.document?.definitions || {};
  const schemaNames = Object.keys(schemaObj);
  const title = analysis.document?.info?.title || 'New Project';
  return {
    projectName: title,
    projectSlug: generateSlug(title) || 'new-project',
    versionSource: 'spec',
    targetVersion: analysis.document?.info?.version || '1.0.0',
    selectedSchemas: schemaNames,
    applyNamingConvention: true,
    classNamingConvention: 'PascalCase',
    propertyNamingConvention: 'camelCase',
    classPrefix: '',
    classSuffix: '',
    dryRun: false,
    incrementalMode: false,
  };
}

export function RepositoryFileImportMapping({
  repositoryId,
  repositoryName,
  repositoryFullName,
  branch,
  file,
  open,
  onOpenChange,
  onStagedImportTargetChange,
}: {
  repositoryId: string;
  repositoryName: string;
  /** e.g. org/repo for GitHub-linked repositories */
  repositoryFullName: string;
  branch: string;
  file: RepositoryFileDetailRow;
  /** Whether the overlay is showing. */
  open: boolean;
  /** Close (or re-open) the overlay. */
  onOpenChange: (open: boolean) => void;
  /** Fired when the user has mapped this file to a project (or cleared mapping), while import has not started. */
  onStagedImportTargetChange?: (target: RepositoryFileStagedImportTarget | null) => void;
}) {
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)?.current_tenant_id;
  const currentUserId = (session?.user as { user_id?: string } | undefined)?.user_id;

  const [payload, setPayload] = useState<FileContentApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>('existing');
  /** Picked in the UI; not sent to the server until Import. */
  const [stagedProject, setStagedProject] = useState<StagedImportProject | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsList, setProjectsList] = useState<StagedImportProject[]>([]);
  const [markDraft, setMarkDraft] = useState(true);
  const [autoLinkBranch, setAutoLinkBranch] = useState(false);
  const [flowStep, setFlowStep] = useState<ImportFlowStep>('mapping');
  const [newProjectForm, setNewProjectForm] = useState<CreateProjectManualFormModel>(() => ({
    ...EMPTY_CREATE_PROJECT_MANUAL_FORM,
  }));
  /** Confirmed via “Map to This Project” in the dialog; project row is created when the user clicks Import. */
  const [stagedNewProject, setStagedNewProject] = useState<CreateProjectManualFormModel | null>(null);
  const [newProjectDialogView, setNewProjectDialogView] = useState<NewProjectDialogView>('form');
  const [importSubmitting, setImportSubmitting] = useState(false);

  type CatalogImportPhase = 'idle' | 'executing' | 'summary';
  const [catalogImportPhase, setCatalogImportPhase] = useState<CatalogImportPhase>('idle');
  const [catalogImportJobId, setCatalogImportJobId] = useState<string | null>(null);
  const [catalogImportSchemas, setCatalogImportSchemas] = useState<string[]>([]);
  const [catalogImportAnalysis, setCatalogImportAnalysis] = useState<AnalysisResult | null>(null);
  const [catalogImportExecutionComplete, setCatalogImportExecutionComplete] = useState(false);
  const [catalogImportSucceeded, setCatalogImportSucceeded] = useState(false);
  const dryRunRef = useRef(false);

  // User-adjustable import options for this file. Initialized from the spec
  // analysis once the file content loads and editable via the Import options card.
  // Persisted with the import (RAR-1.2) so an auto-refresh can replay them.
  const [importOptions, setImportOptions] = useState<ImportOptions | null>(null);
  const importOptionsFilePathRef = useRef<string | null>(null);

  const updateImportOption = useCallback(
    <K extends keyof ImportOptions>(key: K, value: ImportOptions[K]) => {
      setImportOptions((prev) => (prev ? { ...prev, [key]: value } : prev));
    },
    []
  );

  const specMetadata = useMemo(
    () => parseRepositoryFileSpecMetadata(payload?.content ?? '', file.path),
    [payload?.content, file.path]
  );

  const importableVerdict = useMemo(
    () =>
      getRepositoryFileImportableVerdict(specMetadata, {
        loadError: error,
        truncated: payload?.truncated === true,
      }),
    [specMetadata, error, payload?.truncated]
  );

  const suggestedTitle = specMetadata.title?.trim() || repositoryName;
  const suggestedRule = useMemo(
    () => suggestedRuleFromPath(file.path, specMetadata.title),
    [file.path, specMetadata.title]
  );

  const specVersionLabel = specMetadata.version?.trim() || null;
  const willCreateLabel = specVersionLabel ? `v${specVersionLabel}` : 'v… (set info.version in the spec)';

  // Initialize the editable import options from the spec analysis once per loaded
  // file. Re-analyzing only when the file path changes preserves the user's edits
  // across unrelated re-renders.
  useEffect(() => {
    const content = payload?.content;
    if (importableVerdict.status !== 'importable' || typeof content !== 'string' || !content.trim()) {
      return;
    }
    if (importOptionsFilePathRef.current === file.path) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const analysis = await analyzeSpecification(content, analysisFilenameForRepoImport(file.path));
        if (cancelled) return;
        importOptionsFilePathRef.current = file.path;
        setImportOptions(defaultImportOptionsFromAnalysis(analysis));
      } catch {
        // Parsing problems are already surfaced via importableVerdict; leave options unset.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload?.content, file.path, importableVerdict.status]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/repositories/${encodeURIComponent(repositoryId)}/files/${encodeURIComponent(file.id)}/content`,
        { credentials: 'include' }
      );
      const json = (await res.json().catch(() => ({}))) as FileContentApi & { error?: string };
      if (!res.ok) {
        throw new Error(typeof json.error === 'string' ? json.error : res.statusText);
      }
      if (typeof json.content !== 'string') {
        throw new Error('Invalid response from server');
      }
      setPayload(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load file';
      setError(msg);
      setPayload(null);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [repositoryId, file.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const res = await fetch('/api/projects', { credentials: 'include' });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        projects?: unknown;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(typeof json.error === 'string' ? json.error : res.statusText);
      }
      if (!json.success || json.projects == null) {
        throw new Error(typeof json.error === 'string' ? json.error : 'Failed to load projects');
      }
      setProjectsList(parseProjectsList(json.projects));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load projects';
      setProjectsError(msg);
      setProjectsList([]);
      toast.error(msg);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const stagedImportTargetForParent = useMemo((): RepositoryFileStagedImportTarget | null => {
    if (catalogImportPhase !== 'idle') return null;
    if (importableVerdict.status !== 'importable' || loading || error || !payload) return null;

    const blobSha = payload.blob_sha ?? file.blob_sha ?? null;
    if (targetMode === 'existing' && stagedProject) {
      return {
        repositoryId,
        fileId: file.id,
        branch,
        blobSha,
        targetMode: 'existing',
        existingProject: {
          id: stagedProject.id,
          name: stagedProject.name,
          slug: stagedProject.slug,
        },
      };
    }
    if (targetMode === 'new' && stagedNewProject) {
      return {
        repositoryId,
        fileId: file.id,
        branch,
        blobSha,
        targetMode: 'new',
        newProject: {
          name: stagedNewProject.projectName.trim(),
          slug: stagedNewProject.projectSlug.trim(),
        },
      };
    }
    return null;
  }, [
    catalogImportPhase,
    importableVerdict.status,
    loading,
    error,
    payload,
    repositoryId,
    file.id,
    file.blob_sha,
    branch,
    targetMode,
    stagedProject,
    stagedNewProject,
  ]);

  useEffect(() => {
    if (!onStagedImportTargetChange) return;
    onStagedImportTargetChange(stagedImportTargetForParent);
  }, [onStagedImportTargetChange, stagedImportTargetForParent]);

  const sourceRepoDisplay =
    repositoryFullName.trim() && !repositoryFullName.includes('://')
      ? repositoryFullName
      : repositoryName;

  const commitSha = shortSha(payload?.blob_sha ?? file.blob_sha);

  const canAttemptImport = importableVerdict.status === 'importable' && !loading && !error;

  const importButtonEnabled =
    canAttemptImport &&
    !importSubmitting &&
    (targetMode === 'existing' ? stagedProject !== null : stagedNewProject !== null);

  const primaryActionLabel = specVersionLabel
    ? `Import as v${specVersionLabel}`
    : 'Import';

  const openNewProjectDialog = (prefill: CreateProjectManualFormModel | null) => {
    setNewProjectForm(prefill ? { ...prefill } : { ...EMPTY_CREATE_PROJECT_MANUAL_FORM });
    setNewProjectDialogView('form');
    setFlowStep('newProjectDraft');
  };

  const createCatalogProjectFromStagedForm = async (
    form: CreateProjectManualFormModel
  ): Promise<string | null> => {
    if (!currentTenantId || !currentUserId) {
      toast.error('Select a tenant and sign in to create a project.');
      return null;
    }
    try {
      const metadata = metadataFromManualForm(form);
      const result = await createProject(
        currentTenantId,
        currentUserId,
        form.projectName.trim(),
        form.projectDescription.trim(),
        form.projectSlug.trim(),
        metadata
      );
      const response = JSON.parse(result) as { success?: boolean; error?: string; project?: { id?: string } };
      if (response.success && response.project?.id) {
        toast.success(`Created project "${form.projectName.trim()}". Starting import…`);
        await loadProjects();
        return response.project.id;
      }
      toast.error(response.error ?? 'Failed to create project');
      return null;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create project');
      return null;
    }
  };

  const resetCatalogImportFlow = () => {
    setCatalogImportPhase('idle');
    setCatalogImportJobId(null);
    setCatalogImportSchemas([]);
    setCatalogImportAnalysis(null);
    setCatalogImportExecutionComplete(false);
    setCatalogImportSucceeded(false);
  };

  const handleCatalogImportExecutionComplete = useCallback((succeeded: boolean) => {
    setCatalogImportExecutionComplete(true);
    setCatalogImportSucceeded(succeeded);

    void (async () => {
      const id = catalogImportJobId;
      if (!id) {
        setImportSubmitting(false);
        return;
      }
      try {
        const status = await getImportStatus(id);
        if (status.state === 'pending-approval') {
          return;
        }
      } catch {
        setImportSubmitting(false);
        return;
      }
      setImportSubmitting(false);
      setCatalogImportPhase('summary');
    })();
  }, [catalogImportJobId]);

  useEffect(() => {
    if (catalogImportPhase !== 'summary' || !catalogImportSucceeded || !catalogImportJobId || !catalogImportAnalysis?.qualityScore) return;
    if (dryRunRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await getImportStatus(catalogImportJobId);
        if (cancelled) return;
        const projectId = (status as { result?: { projectId?: string } }).result?.projectId;
        if (!projectId) return;
        appendProjectQualitySnapshot(projectId, {
          overall: catalogImportAnalysis.qualityScore.overall,
          grade: catalogImportAnalysis.qualityScore.grade,
          importJobId: catalogImportJobId,
          ...buildQualitySnapshotReportExtras(catalogImportAnalysis),
        });
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogImportPhase, catalogImportSucceeded, catalogImportJobId, catalogImportAnalysis]);

  const onImport = () => {
    void (async () => {
      if (!canAttemptImport || importSubmitting) {
        if (!canAttemptImport) {
          toast.error('Fix importability issues before importing, or wait for the file to finish loading.');
        }
        return;
      }
      if (!currentTenantId || !currentUserId) {
        toast.error('Select a tenant and sign in to import.');
        return;
      }
      const content = payload?.content;
      if (typeof content !== 'string' || !content.trim()) {
        toast.error('Load the repository file before importing.');
        return;
      }
      if (targetMode === 'existing' && !stagedProject) {
        toast.error('Choose which existing project should receive this import.');
        return;
      }
      if (targetMode === 'new' && !stagedNewProject) {
        toast.error('Set up the new project in the Create a new project section, then click Import.');
        return;
      }

      setImportSubmitting(true);
      try {
        let catalogProjectId: string;
        let newProjectFormSnapshot: CreateProjectManualFormModel | null = null;

        if (targetMode === 'existing') {
          catalogProjectId = stagedProject!.id;
        } else {
          const form = stagedNewProject!;
          const newId = await createCatalogProjectFromStagedForm(form);
          if (!newId) {
            setImportSubmitting(false);
            return;
          }
          catalogProjectId = newId;
          newProjectFormSnapshot = { ...form };
          setStagedNewProject(null);
        }

        const analysis = await analyzeSpecification(content, analysisFilenameForRepoImport(file.path));
        if (!analysis.formatSupported && analysis.format !== 'unknown') {
          toast.error(
            `This format is not available for catalog import: ${analysis.formatDisplayName}. Use a format supported by the Projects dashboard import (OpenAPI, Swagger, JSON Schema, Arazzo, etc.).`
          );
          setImportSubmitting(false);
          return;
        }

        // Use the user-edited options when available, falling back to the spec
        // defaults (e.g. if the file was submitted before analysis finished).
        const effectiveOptions: ImportOptions = importOptions ?? defaultImportOptionsFromAnalysis(analysis);
        if (targetMode === 'existing' && stagedProject) {
          effectiveOptions.projectName = stagedProject.name;
          effectiveOptions.projectSlug = stagedProject.slug;
        } else if (newProjectFormSnapshot) {
          effectiveOptions.projectName = newProjectFormSnapshot.projectName.trim();
          effectiveOptions.projectSlug = newProjectFormSnapshot.projectSlug.trim();
        }

        dryRunRef.current = Boolean(effectiveOptions.dryRun);

        const document = analysis.document;
        const sourceKind = analysis.format === 'arazzo' ? 'arazzo' : 'openapi';

        // Capture the source descriptor the importer actually resolved (RAR-1.3)
        // so a future auto-refresh routes/parses this file identically instead of
        // re-sniffing from scratch. `path` already carries the filename and
        // `sourceKind` the importer kind; this adds the resolved format + the
        // content type the document was read as.
        const sourceDescriptor = deriveRepositoryImportSourceDescriptor(analysis);

        const job = await startImport({
          tenantId: currentTenantId,
          userId: currentUserId,
          sourceKind,
          document,
          repositorySource: {
            repositoryId,
            branch,
            path: file.path,
            blobSha: payload?.blob_sha ?? file.blob_sha ?? null,
            formatOverride: sourceDescriptor.formatOverride,
            contentType: sourceDescriptor.contentType,
          },
          project: {
            name: effectiveOptions.projectName || (document?.info?.title || 'New Project'),
            slug:
              effectiveOptions.projectSlug ||
              generateSlug(document?.info?.title || 'new-project') ||
              'imported-project',
            description: document?.info?.description || null,
          },
          version: {
            versionId: effectiveOptions.targetVersion || (document?.info?.version || '1.0.0'),
            description: 'Imported from OpenAPI specification',
          },
          options: {
            selectedSchemas: effectiveOptions.selectedSchemas,
            applyNamingConvention: effectiveOptions.applyNamingConvention ?? true,
            classNamingConvention: effectiveOptions.classNamingConvention ?? 'PascalCase',
            propertyNamingConvention: effectiveOptions.propertyNamingConvention ?? 'camelCase',
            classNameMap: effectiveOptions.classNameMap,
            classPrefix: (effectiveOptions.classPrefix ?? '').trim() || undefined,
            classSuffix: (effectiveOptions.classSuffix ?? '').trim() || undefined,
            typeMapping: effectiveOptions.typeMapping,
            defaultValues: effectiveOptions.defaultValues,
            requiredOverrides: effectiveOptions.requiredOverrides,
            descriptionOverrides: effectiveOptions.descriptionOverrides,
            generateExamples: effectiveOptions.generateExamples ?? false,
            dryRun: effectiveOptions.dryRun ?? false,
            incrementalMode: effectiveOptions.incrementalMode ?? false,
          },
          existingProjectId: catalogProjectId,
        });

        setCatalogImportJobId(job.jobId);
        setCatalogImportSchemas(effectiveOptions.selectedSchemas);
        setCatalogImportAnalysis(analysis);
        setCatalogImportExecutionComplete(false);
        setCatalogImportSucceeded(false);
        setCatalogImportPhase('executing');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Import failed to start');
        setImportSubmitting(false);
      }
    })();
  };

  const commitMapToNewProject = () => {
    if (!newProjectForm.projectName.trim()) {
      toast.error('Project name is required.');
      return;
    }
    if (!newProjectForm.projectSlug.trim()) {
      toast.error('Project slug is required.');
      return;
    }
    setStagedNewProject({ ...newProjectForm });
    setFlowStep('mapping');
    toast.success('New project mapped. Click Import to create it and continue.');
  };

  const copyNewProjectFormFromSpecification = () => {
    const content = payload?.content;
    if (typeof content !== 'string' || !content.trim()) {
      toast.error('Load the repository file before copying fields from the specification.');
      return;
    }
    const result = projectDraftFromRepositorySpec(content, file.path);
    if (!result.ok) {
      toast.message(result.reason);
      return;
    }
    setNewProjectForm(createProjectFormFromSpecDraft(result.draft));
    toast.success(`Copied fields from specification (${result.format}).`);
  };

  const clearNewProjectForm = () => {
    setNewProjectForm({ ...EMPTY_CREATE_PROJECT_MANUAL_FORM });
    toast.message('Form cleared.');
  };

  const closeNewProjectDraft = () => {
    setFlowStep('mapping');
    setNewProjectDialogView('form');
  };  /** The wizard's own dismissal, used by Cancel and by the corner close. */
  const closeWizard = () => onOpenChange(false);

  /**
   * The run itself, or the mapping form.
   *
   * All three are the dialog's body rather than three different screens, so the head — which
   * names the file being imported — stays put while the job runs. The panel this replaces
   * swapped the whole pane for an execution card that did not say what it was importing.
   */
  const body =
    catalogImportPhase === 'executing' && catalogImportJobId ? (
      <div className="flex flex-col gap-3" data-testid="repository-import-executing">
        <h3 className="repo-det-card__title">Catalog import</h3>
        <p className="repo-det-note">
          Same import job engine as Projects → Import. This panel updates live until the run
          finishes.
        </p>
        <ImportExecutionPanel
          jobId={catalogImportJobId}
          selectedSchemas={catalogImportSchemas}
          isReviewing={catalogImportExecutionComplete}
          onComplete={handleCatalogImportExecutionComplete}
          onRetry={(newJobId) => {
            setCatalogImportJobId(newJobId);
            setCatalogImportExecutionComplete(false);
          }}
        />
      </div>
    ) : catalogImportPhase === 'summary' && catalogImportJobId ? (
      <div className="flex flex-col gap-3" data-testid="repository-import-summary">
        <h3 className="repo-det-card__title">Import summary</h3>
        <p className="repo-det-note">
          Results from the catalog import job — the same completion view as the Projects
          dashboard.
        </p>
        <ImportCompletePanel jobId={catalogImportJobId} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={resetCatalogImportFlow}>
            Back to mapping
          </Button>
          <Button type="button" variant="outline" onClick={closeWizard}>
            Back to file
          </Button>
        </div>
      </div>
    ) : (
      <div className="repo-map-grid">
        <div className="repo-map-column">
          {importableVerdict.status !== 'importable' && !loading ? (
            <Alert variant="warn" data-testid="repository-import-unavailable">
              {importableVerdict.status === 'content_unavailable' ? (
                <>Content unavailable — {importableVerdict.loadError}</>
              ) : importableVerdict.status === 'parse_failed' ? (
                <>Could not parse as YAML/JSON: {importableVerdict.parseError}</>
              ) : importableVerdict.notImportableMessage ? (
                <>{importableVerdict.notImportableMessage}</>
              ) : (
                <>
                  This file is not recognised as an importable spec from the loaded content.
                  Map &amp; import is meant for OpenAPI 3.x, AsyncAPI, Arazzo, JSON Schema, or
                  GraphQL SDL.
                </>
              )}
            </Alert>
          ) : null}

          <Card variant="flat">
            <CardContent className="flex flex-col gap-3">
              <h3 className="repo-det-card__title">Target project</h3>
              {loading ? (
                <div className="flex flex-col gap-3" aria-hidden>
                  <Skeleton className="h-[4.5rem] w-full rounded-md" />
                  <Skeleton className="h-[4.5rem] w-full rounded-md" />
                </div>
              ) : (
                <div
                  role="radiogroup"
                  aria-label="Target project"
                  className="flex flex-col gap-2"
                >
                  {/* The scoped choice control: a `<div>`, not a `<label>`, because it holds
                      controls of its own. Only `.repo-map-choice__title` is the radio's
                      label. */}
                  <div className="repo-map-choice" data-testid="repository-import-target-existing">
                    <input
                      type="radio"
                      id="repo-import-target-existing"
                      name="repo-import-target"
                      checked={targetMode === 'existing'}
                      onChange={() => {
                        setTargetMode('existing');
                        setStagedNewProject(null);
                      }}
                    />
                    <div className="repo-map-choice__body">
                      <label
                        htmlFor="repo-import-target-existing"
                        className="repo-map-choice__title"
                      >
                        <FolderOpen aria-hidden />
                        Existing project
                      </label>
                      <p className="repo-map-choice__desc">
                        Suggested mapping rule: <span className="mono">{suggestedRule}</span>.
                        Pick a catalog project before importing; nothing is saved until you
                        click Import.
                      </p>

                      <div className="repo-map-choice__fields">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="repo-import-project-select">
                            Map to existing project
                          </Label>
                          {projectsLoading ? (
                            <Skeleton className="h-10 w-full rounded-md" />
                          ) : projectsError ? (
                            <p className="repo-file-verdict__detail text-danger-fg">
                              {projectsError}
                            </p>
                          ) : (
                            <Select
                              // `?? ''` keeps the Root *controlled* at all times. With
                              // `undefined` it flips to uncontrolled the moment the staged
                              // project is cleared — by the "Create a new project" radio, or by
                              // "Clear selection" — while Radix keeps the previously chosen id
                              // internally. Re-picking that same project is then a no-op: no
                              // `onValueChange`, nothing staged, and the Import button stays
                              // disabled forever unless the reader happens to choose a
                              // *different* project.
                              value={stagedProject?.id ?? ''}
                              onValueChange={(projectId) => {
                                const p = projectsList.find((x) => x.id === projectId);
                                if (p) {
                                  setTargetMode('existing');
                                  setStagedProject(p);
                                }
                              }}
                              disabled={projectsList.length === 0}
                            >
                              <SelectTrigger id="repo-import-project-select">
                                <SelectValue placeholder="Select a project…" />
                              </SelectTrigger>
                              <SelectContent className="max-h-72 max-w-lg">
                                {projectsList.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="repo-import-project-slug">Project slug</Label>
                          <Input
                            id="repo-import-project-slug"
                            readOnly
                            aria-readonly="true"
                            value={stagedProject?.slug ?? ''}
                            placeholder="Select a project to fill slug"
                            className="mono"
                          />
                        </div>
                      </div>

                      {projectsList.length === 0 && !projectsLoading && !projectsError ? (
                        <p className="repo-map-choice__desc">
                          No projects in this workspace yet. Create one under Projects, or
                          choose &quot;Create a new project&quot; below.
                        </p>
                      ) : null}

                      {stagedProject ? (
                        <div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setStagedProject(null)}
                          >
                            Clear selection
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="repo-map-choice" data-testid="repository-import-target-new">
                    <input
                      type="radio"
                      id="repo-import-target-new"
                      name="repo-import-target"
                      checked={targetMode === 'new'}
                      onChange={() => {
                        setTargetMode('new');
                        setStagedProject(null);
                        setStagedNewProject(null);
                      }}
                    />
                    <div className="repo-map-choice__body">
                      <label htmlFor="repo-import-target-new" className="repo-map-choice__title">
                        <FolderPlus aria-hidden />
                        Create a new project
                      </label>
                      <p className="repo-map-choice__desc">
                        Set up the project this file should create, then import into it. The
                        catalog project is created when you click Import.
                      </p>
                      {stagedNewProject ? (
                        <>
                          <p className="repo-map-choice__desc">
                            Mapped:{' '}
                            <span className="font-semibold">{stagedNewProject.projectName}</span>{' '}
                            <span className="mono">({stagedNewProject.projectSlug})</span>
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => openNewProjectDialog(stagedNewProject)}
                            >
                              Edit mapping
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setStagedNewProject(null)}
                            >
                              Clear mapping
                            </Button>
                          </div>
                        </>
                      ) : (
                        <div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setTargetMode('new');
                              setStagedProject(null);
                              openNewProjectDialog(null);
                            }}
                            data-testid="repository-import-setup-new-project"
                          >
                            Set up new project…
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card variant="flat">
            <CardContent className="flex flex-col gap-3">
              <h3 className="repo-det-card__title">Version to create</h3>
              {loading ? (
                <div className="repo-map-facts" aria-hidden>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-md" />
                  ))}
                </div>
              ) : (
                <>
                  <div className="repo-map-facts">
                    <div>
                      <p className="repo-map-fact__label">From spec</p>
                      <p className="repo-map-fact__value mono">{specVersionLabel ?? '—'}</p>
                    </div>
                    <div>
                      <p className="repo-map-fact__label">Latest existing</p>
                      <p className="repo-map-fact__value mono">—</p>
                    </div>
                    <div>
                      <p className="repo-map-fact__label">Will create</p>
                      <p className="repo-map-fact__value mono">{willCreateLabel}</p>
                    </div>
                  </div>
                  <div className="repo-files-filters__switches">
                    <label className="repo-files-check">
                      <input
                        type="checkbox"
                        checked={markDraft}
                        onChange={(e) => setMarkDraft(e.target.checked)}
                      />
                      Mark as draft (don&apos;t promote)
                    </label>
                    <label className="repo-files-check">
                      <input
                        type="checkbox"
                        checked={autoLinkBranch}
                        onChange={(e) => setAutoLinkBranch(e.target.checked)}
                      />
                      Auto-link to next branch import on this file path
                    </label>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card variant="flat">
            <CardContent className="flex flex-col gap-3">
              <h3 className="repo-det-card__title">Import options</h3>
              <p className="repo-det-note">
                Saved with the import and replayed when the file is auto-refreshed.
              </p>
              {loading ? (
                <div className="flex flex-col gap-3" aria-hidden>
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                </div>
              ) : importOptions ? (
                <div className="flex flex-col gap-2" data-testid="repository-import-options">
                  <ImportOptionsForm options={importOptions} onOptionChange={updateImportOption} />
                </div>
              ) : (
                <p className="repo-det-note">
                  Load an importable spec (OpenAPI, Swagger, JSON Schema, Arazzo, GraphQL SDL)
                  to adjust import options.
                </p>
              )}
            </CardContent>
          </Card>

          <Card variant="flat">
            <CardContent className="flex flex-col gap-3">
              <h3 className="repo-det-card__title">Diff vs current {suggestedTitle}</h3>
              <p className="repo-det-note">{MAP_IMPORT_DIFF_STUB_COPY}</p>
              {/* Deliberately untinted: three coloured tiles reading "—" would claim a
                  measurement that does not exist yet. */}
              <div className="repo-map-tiles">
                {(['added', 'modified', 'removed'] as const).map((label) => (
                  <div key={label} className="repo-map-tile">
                    <span className="repo-map-tile__value">—</span>
                    <span className="repo-map-tile__label">{label}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="repo-map-column">
          {/* `flat`, not `soft`: on `--bg-subtle` the quiet `--fg-muted` step measures
              4.34:1 in Solarized, which axe reports. A hairline over the plain surface reads
              the same and is 5.45 worst-of-nine. */}
          <Card variant="flat">
            <CardContent className="flex flex-col gap-2">
              <p className="repo-det-caps">Source</p>
              <dl className="imp-kv">
                <dt>Repository</dt>
                <dd>{sourceRepoDisplay}</dd>
                <dt>Branch</dt>
                <dd>{branch}</dd>
                <dt>Path</dt>
                <dd>{file.path}</dd>
                <dt>Commit</dt>
                <dd>
                  {loading ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                  ) : (
                    commitSha
                  )}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Alert variant="info">
            On import, Apiome records a row in <span className="mono">repository_imports</span>{' '}
            and links the new project version&apos;s <span className="mono">source_ref</span>{' '}
            back to{' '}
            <span className="mono">
              {sourceRepoDisplay}@{commitSha}:{file.path}
            </span>
            .
          </Alert>

          <div className="repo-map-actions">
            <Button
              type="button"
              className="w-full"
              disabled={!importButtonEnabled}
              title={
                importableVerdict.summary === 'unsupported_openapi_version'
                  ? importableVerdict.notImportableMessage
                  : undefined
              }
              onClick={onImport}
              data-testid="repository-import-submit"
            >
              {importSubmitting ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Download aria-hidden />
              )}
              {importSubmitting ? 'Starting import…' : primaryActionLabel}
            </Button>
            <Button type="button" variant="outline" className="w-full" onClick={closeWizard}>
              Cancel
            </Button>
            {canAttemptImport && targetMode === 'existing' && !stagedProject ? (
              <p className="repo-map-actions__help">
                Select an existing project in the dropdown to enable import.
              </p>
            ) : null}
            {canAttemptImport && targetMode === 'new' && !stagedNewProject ? (
              <p className="repo-map-actions__help">
                Use <span className="font-medium">Set up new project…</span>, then{' '}
                <span className="font-medium">Map to this project</span>. Import runs after the
                project is configured there.
              </p>
            ) : null}
            {canAttemptImport && targetMode === 'existing' && stagedProject ? (
              <p className="repo-map-actions__help" data-tone="ok">
                <CheckCircle2 aria-hidden />
                <span>
                  Ready to import into{' '}
                  <span className="font-medium">{stagedProject.name}</span>{' '}
                  <span className="mono">({stagedProject.slug})</span>.
                </span>
              </p>
            ) : null}
            {canAttemptImport && targetMode === 'new' && stagedNewProject ? (
              <p className="repo-map-actions__help" data-tone="ok">
                <CheckCircle2 aria-hidden />
                <span>
                  Import will create{' '}
                  <span className="font-medium">{stagedNewProject.projectName}</span>{' '}
                  <span className="mono">({stagedNewProject.projectSlug})</span>.
                </span>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          size="full"
          className="imp-wizard"
          closeLabel={
            catalogImportPhase === 'executing' ? 'Close (the job keeps running)' : 'Close'
          }
          aria-describedby={undefined}
          data-testid="repository-map-import"
        >
          <DialogHeader className="imp-wizard__head">
            <span className="tnt-icon-tile" data-tone="accent" aria-hidden>
              <GitPullRequestArrow />
            </span>
            <div className="imp-wizard__heading">
              <DialogTitle className="flex flex-wrap items-center gap-2 text-lg">
                Map &amp; import
                {stagedImportTargetForParent ? (
                  <Badge variant="ok" data-testid="repository-file-ready-to-import-badge">
                    <CheckCircle2 aria-hidden />
                    Ready to import
                  </Badge>
                ) : null}
              </DialogTitle>
              <DialogDescription>
                Choose how <span className="mono">{file.path}</span> from{' '}
                <span className="mono">
                  {sourceRepoDisplay}@{commitSha}
                </span>{' '}
                should land in the catalog.
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="imp-wizard__body" aria-busy={loading || undefined}>
            {body}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={flowStep === 'newProjectDraft'}
        onOpenChange={(next) => {
          if (!next) closeNewProjectDraft();
        }}
      >
        <DialogContent size="full" className="imp-wizard" aria-describedby={undefined}>
          <DialogHeader className="imp-wizard__head">
            <span className="tnt-icon-tile" data-tone="honey" aria-hidden>
              <FolderPlus />
            </span>
            <div className="imp-wizard__heading">
              <DialogTitle className="text-lg">Create new project</DialogTitle>
              <DialogDescription>
                The same manual form as Projects → New project. Fill it from scratch, copy the
                fields from this specification, or clear and start over. Nothing is created
                until you run the import.
              </DialogDescription>
            </div>
            <div className="imp-wizard__head-actions">
              <Segmented
                value={newProjectDialogView}
                onValueChange={(v) => setNewProjectDialogView(v as NewProjectDialogView)}
                aria-label="Create project view"
                size="sm"
              >
                <SegmentedItem value="form">Form</SegmentedItem>
                <SegmentedItem value="metadata">Metadata</SegmentedItem>
              </Segmented>
            </div>
          </DialogHeader>

          <div className="imp-wizard__body">
            {newProjectDialogView === 'form' ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={copyNewProjectFormFromSpecification}
                  >
                    Copy from specification
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={clearNewProjectForm}>
                    Clear form
                  </Button>
                </div>
                <CreateProjectManualFormFields
                  fieldIdPrefix="repo-import-new-project-"
                  model={newProjectForm}
                  onChange={(patch) => setNewProjectForm((prev) => ({ ...prev, ...patch }))}
                  showStartTemplatePicker={false}
                />
              </div>
            ) : typeof payload?.content === 'string' ? (
              <RepositoryImportSpecMetadataPanel
                content={payload.content}
                path={file.path}
                specMetadata={specMetadata}
                truncated={payload.truncated === true}
              />
            ) : (
              <p className="repo-det-note">Load the repository file to view original metadata.</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeNewProjectDraft}>
              Cancel
            </Button>
            <Button type="button" onClick={commitMapToNewProject}>
              Map to this project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
