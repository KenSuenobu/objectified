'use client';

import {
  ArrowLeft,
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
import { Button } from '@/app/components/ui/Button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { cn } from '@lib/utils';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
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
  onBack,
  onStagedImportTargetChange,
}: {
  repositoryId: string;
  repositoryName: string;
  /** e.g. org/repo for GitHub-linked repositories */
  repositoryFullName: string;
  branch: string;
  file: RepositoryFileDetailRow;
  onBack: () => void;
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
  };

  if (catalogImportPhase === 'executing' && catalogImportJobId) {
    return (
      <div className="space-y-6" aria-busy>
        <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="border-b border-gray-200 px-6 pb-4 pt-5 dark:border-gray-700">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">Catalog import</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Same import job engine as Projects → Import. This panel updates live until the run finishes.
            </p>
          </div>
          <div className="px-6 py-6">
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
        </div>
      </div>
    );
  }

  if (catalogImportPhase === 'summary' && catalogImportJobId) {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="border-b border-gray-200 px-6 pb-4 pt-5 dark:border-gray-700">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">Import summary</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Results from the catalog import job (same completion view as the Projects dashboard).
            </p>
          </div>
          <div className="px-6 py-6">
            <ImportCompletePanel jobId={catalogImportJobId} />
          </div>
          <div className="flex flex-wrap gap-2 border-t border-gray-200 px-6 py-4 dark:border-gray-700">
            <Button type="button" variant="outline" onClick={resetCatalogImportFlow}>
              Back to mapping
            </Button>
            <Button type="button" variant="outline" onClick={onBack}>
              Back to file
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" aria-busy={loading}>
      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-gray-200 px-6 pb-5 pt-6 dark:border-gray-700">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400"
            >
              <ArrowLeft className="h-3 w-3 shrink-0" aria-hidden />
              Back to file
            </button>
          </div>
          <div className="flex flex-wrap items-start gap-4">
            <span className="inline-flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-pink-500 text-white">
              <GitPullRequestArrow className="h-6 w-6" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Map &amp; import</h2>
                {stagedImportTargetForParent ? (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200"
                    data-testid="repository-file-ready-to-import-badge"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    Ready to Import
                  </span>
                ) : null}
              </div>
              <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-gray-400">
                Choose how{' '}
                <span className="font-mono text-gray-700 dark:text-gray-200">{file.path}</span> from{' '}
                <span className="font-mono text-gray-700 dark:text-gray-200">
                  {repositoryName}@{commitSha}
                </span>{' '}
                should land in the catalog.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 px-6 py-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {importableVerdict.status !== 'importable' && !loading ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-900/25 dark:text-amber-100">
                {importableVerdict.status === 'content_unavailable' ? (
                  <>Content unavailable — {importableVerdict.loadError}</>
                ) : importableVerdict.status === 'parse_failed' ? (
                  <>Could not parse as YAML/JSON: {importableVerdict.parseError}</>
                ) : importableVerdict.notImportableMessage ? (
                  <>{importableVerdict.notImportableMessage}</>
                ) : (
                  <>
                    This file is not recognised as an importable spec from the loaded content. Map &amp; import is
                    meant for OpenAPI 3.x, AsyncAPI, Arazzo, JSON Schema, or GraphQL SDL.
                  </>
                )}
              </div>
            ) : null}

            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Target project</h3>
              {loading ? (
                <div className="space-y-3" aria-hidden>
                  <Skeleton className="h-[4.5rem] w-full rounded-lg" />
                  <Skeleton className="h-[4.5rem] w-full rounded-lg" />
                </div>
              ) : (
                <div className="space-y-3">
                  <div
                    role="button"
                    tabIndex={0}
                    className={cn(
                      'cursor-pointer rounded-lg border-2 p-3 text-left outline-none transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900',
                      targetMode === 'existing'
                        ? 'border-indigo-500 bg-indigo-50/40 dark:border-indigo-500 dark:bg-indigo-900/10'
                        : 'border-gray-200 hover:border-indigo-300 dark:border-gray-700 dark:hover:border-indigo-600'
                    )}
                    onClick={() => {
                      setTargetMode('existing');
                      setStagedNewProject(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setTargetMode('existing');
                        setStagedNewProject(null);
                      }
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="tgt"
                        className="mt-1"
                        checked={targetMode === 'existing'}
                        onChange={() => {
                          setTargetMode('existing');
                          setStagedNewProject(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="inline-flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                          <FolderOpen className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
                          Existing project
                        </p>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          Suggested mapping rule: <span className="font-mono">{suggestedRule}</span>. Pick a catalog
                          project before importing; nothing is saved until you click Import.
                        </p>
                        {!stagedProject ? (
                          <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                            Select a project from the dropdown below to map this file.
                          </p>
                        ) : null}
                        <div className="mt-3 space-y-3" onClick={(e) => e.stopPropagation()}>
                          <div className="space-y-1.5">
                            <Label
                              htmlFor="repo-import-project-select"
                              className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
                            >
                              Map to existing project
                            </Label>
                            {projectsLoading ? (
                              <Skeleton className="h-10 w-full rounded-md" />
                            ) : projectsError ? (
                              <p className="text-xs text-rose-600 dark:text-rose-400">{projectsError}</p>
                            ) : (
                              <Select
                                value={stagedProject?.id}
                                onValueChange={(id) => {
                                  const p = projectsList.find((x) => x.id === id);
                                  if (p) setStagedProject(p);
                                }}
                                disabled={projectsList.length === 0}
                              >
                                <SelectTrigger
                                  id="repo-import-project-select"
                                  className="h-auto min-h-10 items-start py-2 text-left dark:border-gray-600 dark:bg-gray-900/40"
                                >
                                  <SelectValue placeholder="Select a project…" />
                                </SelectTrigger>
                                <SelectContent className="max-h-72 max-w-lg">
                                  {projectsList.map((p) => (
                                    <SelectItem
                                      key={p.id}
                                      value={p.id}
                                      className="items-start py-2 pl-8 [&>span:last-child]:w-full [&>span:last-child]:min-w-0"
                                    >
                                      <span className="flex w-full min-w-0 flex-col gap-0.5 text-left">
                                        <span className="truncate font-medium leading-snug text-slate-900 dark:text-slate-100">
                                          {p.name}
                                        </span>
                                        <span className="font-mono text-2xs leading-snug text-slate-500 dark:text-slate-400">
                                          {p.slug}
                                        </span>
                                      </span>
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                            {projectsList.length === 0 && !projectsLoading && !projectsError ? (
                              <p className="text-xs text-gray-500 dark:text-gray-400">
                                No projects in this workspace yet. Create one under Projects, or choose &quot;Create a
                                new project&quot; above.
                              </p>
                            ) : null}
                          </div>
                          <div className="space-y-1.5">
                            <Label
                              htmlFor="repo-import-project-slug"
                              className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
                            >
                              Project slug
                            </Label>
                            <Input
                              id="repo-import-project-slug"
                              readOnly
                              aria-readonly="true"
                              value={stagedProject?.slug ?? ''}
                              placeholder="Select a project to fill slug"
                              className="font-mono text-sm dark:border-gray-600 dark:bg-gray-900/50"
                            />
                          </div>
                          {stagedProject ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-8 px-0 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                              onClick={() => setStagedProject(null)}
                            >
                              Clear selection
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                  <label
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-lg border p-3',
                      targetMode === 'new'
                        ? 'border-2 border-indigo-500 bg-indigo-50/40 dark:border-indigo-500 dark:bg-indigo-900/10'
                        : 'border-gray-200 hover:border-indigo-300 dark:border-gray-700 dark:hover:border-indigo-600'
                    )}
                  >
                    <input
                      type="radio"
                      name="tgt"
                      className="mt-1"
                      checked={targetMode === 'new'}
                      onChange={() => {
                        setTargetMode('new');
                        setStagedProject(null);
                        setStagedNewProject(null);
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="inline-flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                        <FolderPlus className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                        Create a new project
                      </p>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Open the form with <strong className="font-medium text-gray-700 dark:text-gray-300">Set up new project…</strong>, then{' '}
                        <strong className="font-medium text-gray-700 dark:text-gray-300">Map to This Project</strong> to confirm. When that is done, use{' '}
                        <strong className="font-medium text-gray-700 dark:text-gray-300">Import</strong> in the panel on the right — the catalog project is
                        created on import (version ingest is still to be wired).
                      </p>
                      {stagedNewProject ? (
                        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/80 px-3 py-2 text-xs dark:border-emerald-800 dark:bg-emerald-900/20">
                          <p className="font-medium text-emerald-900 dark:text-emerald-100">
                            Mapped:{' '}
                            <span className="font-semibold">{stagedNewProject.projectName}</span>{' '}
                            <span className="font-mono text-emerald-800 dark:text-emerald-200">
                              ({stagedNewProject.projectSlug})
                            </span>
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs"
                              onClick={() => openNewProjectDialog(stagedNewProject)}
                            >
                              Edit mapping
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-8 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                              onClick={() => setStagedNewProject(null)}
                            >
                              Clear mapping
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 space-y-2">
                          <Button
                            type="button"
                            size="sm"
                            className="h-9 bg-emerald-600 text-white hover:bg-emerald-700"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openNewProjectDialog(null);
                            }}
                          >
                            Set up new project…
                          </Button>
                          <p className="text-xs text-amber-800 dark:text-amber-200">
                            Fill the form, then <strong className="font-medium">Map to This Project</strong>. After that,
                            click <strong className="font-medium">Import</strong> to create the catalog project (version
                            ingest is still to be wired).
                          </p>
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Version to create</h3>
              {loading ? (
                <div className="grid grid-cols-3 gap-3" aria-hidden>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-md" />
                  ))}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                    <div>
                      <p className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        From spec
                      </p>
                      <p className="mt-1 font-mono">{specVersionLabel ?? '—'}</p>
                    </div>
                    <div>
                      <p className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        Latest existing
                      </p>
                      <p className="mt-1 font-mono text-gray-500 dark:text-gray-400">—</p>
                    </div>
                    <div>
                      <p className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        Will create
                      </p>
                      <p className="mt-1 font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                        {willCreateLabel}
                        {specVersionLabel ? <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">(from spec)</span> : null}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300 dark:border-gray-600"
                        checked={markDraft}
                        onChange={(e) => setMarkDraft(e.target.checked)}
                      />
                      Mark as draft (don&apos;t promote)
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300 dark:border-gray-600"
                        checked={autoLinkBranch}
                        onChange={(e) => setAutoLinkBranch(e.target.checked)}
                      />
                      Auto-link to next branch import on this file path
                    </label>
                  </div>
                </>
              )}
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Import options</h3>
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                How classes and properties are named and generated when this file is imported. These options are saved
                with the import and replayed when the file is auto-refreshed.
              </p>
              {loading ? (
                <div className="space-y-3" aria-hidden>
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                </div>
              ) : importOptions ? (
                <div className="flex flex-col gap-2" data-testid="repository-import-options">
                  <ImportOptionsForm options={importOptions} onOptionChange={updateImportOption} />
                </div>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Load an importable spec (OpenAPI, Swagger, JSON Schema, Arazzo, GraphQL SDL) to adjust import options.
                </p>
              )}
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
                Diff vs current {suggestedTitle}
              </h3>
              <p className="mb-3 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                Unified structural diff vs the last catalog version imported from this repository path needs{' '}
                <span className="font-mono">repository_import</span> rows joined to blob SHAs. Until that API exists,
                counts and line items are not shown.
              </p>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-center dark:border-emerald-800 dark:bg-emerald-900/20">
                  <p className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">—</p>
                  <p className="text-emerald-700 dark:text-emerald-300">added</p>
                </div>
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-center dark:border-amber-800 dark:bg-amber-900/20">
                  <p className="text-lg font-semibold text-amber-700 dark:text-amber-300">—</p>
                  <p className="text-amber-700 dark:text-amber-300">modified</p>
                </div>
                <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-center dark:border-rose-800 dark:bg-rose-900/20">
                  <p className="text-lg font-semibold text-rose-700 dark:text-rose-300">—</p>
                  <p className="text-rose-700 dark:text-rose-300">removed</p>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Source</h3>
              <dl className="space-y-1.5 text-sm">
                <div>
                  <dt className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Repository
                  </dt>
                  <dd className="break-all font-mono text-xs text-gray-800 dark:text-gray-200">{sourceRepoDisplay}</dd>
                </div>
                <div>
                  <dt className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Branch
                  </dt>
                  <dd className="font-mono text-xs text-gray-800 dark:text-gray-200">{branch}</dd>
                </div>
                <div>
                  <dt className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Path
                  </dt>
                  <dd className="break-all font-mono text-xs text-gray-800 dark:text-gray-200">{file.path}</dd>
                </div>
                <div>
                  <dt className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Commit
                  </dt>
                  <dd className="font-mono text-xs text-gray-800 dark:text-gray-200">
                    {loading ? (
                      <span className="inline-flex items-center gap-1 text-gray-400">
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      </span>
                    ) : (
                      commitSha
                    )}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-900/20">
              <p className="text-xs text-indigo-800 dark:text-indigo-200">
                On import, Apiome will record a row in <code className="font-mono">repository_imports</code> and
                link the new project version&apos;s <code className="font-mono">source_ref</code> back to{' '}
                <span className="font-mono">
                  {repositoryName}@{commitSha}:{file.path}
                </span>
                .
              </p>
            </div>

            <div className="space-y-2">
              <Button
                type="button"
                className="w-full gap-1.5 bg-indigo-600 hover:bg-indigo-700"
                disabled={!importButtonEnabled}
                title={
                  importableVerdict.summary === 'unsupported_openapi_version'
                    ? importableVerdict.notImportableMessage
                    : undefined
                }
                onClick={onImport}
              >
                {importSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
                {importSubmitting ? 'Starting import…' : primaryActionLabel}
              </Button>
              <Button type="button" variant="outline" className="w-full" onClick={onBack}>
                Cancel
              </Button>
              {canAttemptImport && targetMode === 'existing' && !stagedProject ? (
                <p className="text-2xs text-gray-500 dark:text-gray-400">
                  Select an existing project in the dropdown to enable import.
                </p>
              ) : null}
              {canAttemptImport && targetMode === 'new' && !stagedNewProject ? (
                <p className="text-2xs text-gray-500 dark:text-gray-400">
                  Use <span className="font-medium">Set up new project…</span> under Create a new project, then{' '}
                  <span className="font-medium">Map to This Project</span>. <span className="font-medium">Import</span>{' '}
                  runs after the project is configured there.
                </p>
              ) : null}
              {canAttemptImport && targetMode === 'existing' && stagedProject ? (
                <p className="inline-flex items-center gap-1 text-2xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Ready to import into{' '}
                  <span className="font-medium">{stagedProject.name}</span>
                  <span className="font-mono text-gray-600 dark:text-gray-400"> ({stagedProject.slug})</span>.
                </p>
              ) : null}
              {canAttemptImport && targetMode === 'new' && stagedNewProject ? (
                <p className="inline-flex items-center gap-1 text-2xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Import will create{' '}
                  <span className="font-medium">{stagedNewProject.projectName}</span>
                  <span className="font-mono text-gray-600 dark:text-gray-400">
                    {' '}
                    ({stagedNewProject.projectSlug})
                  </span>
                  .
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={flowStep === 'newProjectDraft'}
        onOpenChange={(open) => {
          if (!open) closeNewProjectDraft();
        }}
      >
        <DialogContent
          className="flex h-[min(90vh,880px)] max-h-[90vh] w-[1280px] max-w-[95vw] flex-col gap-0 p-0"
          aria-describedby={undefined}
        >
          <DialogHeader className="border-b border-gray-200 px-6 py-4 dark:border-gray-700">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-2 text-xl">
                  <span className="rounded-lg bg-gradient-to-br from-purple-100 to-indigo-100 p-1.5 dark:from-purple-900/30 dark:to-indigo-900/30">
                    <FolderOpen className="h-5 w-5 text-purple-600 dark:text-purple-400" aria-hidden />
                  </span>
                  Create New Project
                </DialogTitle>
                <DialogDescription className="text-left text-sm text-gray-600 dark:text-gray-400">
                  Same manual form as Projects → New Project. Fill from scratch, copy fields from this specification,
                  or clear and start over. Click <span className="font-medium">Map to This Project</span> to lock in
                  this mapping; the catalog project is created later when you click Import on the previous screen.
                  Cancel closes without saving the mapping.
                </DialogDescription>
              </div>
              <div
                className={cn(TAB_LIST_CLASS, 'shrink-0 flex-nowrap')}
                role="tablist"
                aria-label="Create project view"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={newProjectDialogView === 'form'}
                  className={tabTriggerClass({ active: newProjectDialogView === 'form' })}
                  onClick={() => setNewProjectDialogView('form')}
                >
                  Form
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={newProjectDialogView === 'metadata'}
                  className={tabTriggerClass({ active: newProjectDialogView === 'metadata' })}
                  onClick={() => setNewProjectDialogView('metadata')}
                >
                  Metadata
                </button>
              </div>
            </div>
          </DialogHeader>

          {newProjectDialogView === 'form' ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-6 py-3 dark:border-gray-700">
              <Button type="button" variant="outline" size="sm" onClick={copyNewProjectFormFromSpecification}>
                Copy from specification
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={clearNewProjectForm}>
                Clear form
              </Button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {newProjectDialogView === 'form' ? (
              <CreateProjectManualFormFields
                fieldIdPrefix="repo-import-new-project-"
                model={newProjectForm}
                onChange={(patch) => setNewProjectForm((prev) => ({ ...prev, ...patch }))}
                showStartTemplatePicker={false}
              />
            ) : typeof payload?.content === 'string' ? (
              <RepositoryImportSpecMetadataPanel
                content={payload.content}
                path={file.path}
                specMetadata={specMetadata}
                truncated={payload.truncated === true}
              />
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Load the repository file to view original metadata.
              </p>
            )}
          </div>

          <DialogFooter className="flex flex-col-reverse gap-2 border-t border-gray-200 px-6 py-4 sm:flex-row sm:justify-end dark:border-gray-700">
            <Button type="button" variant="outline" onClick={closeNewProjectDraft}>
              Cancel
            </Button>
            <Button type="button" className="bg-indigo-600 hover:bg-indigo-700" onClick={commitMapToNewProject}>
              Map to This Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
