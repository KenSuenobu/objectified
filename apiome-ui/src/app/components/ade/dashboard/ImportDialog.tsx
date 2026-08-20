'use client';

/**
 * The import wizard (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html`, design language `docs/mockups/DESIGN.md`.
 *
 * This file keeps every piece of state and every write it had before the redesign — the intake
 * buffers, the analysis, the async job, the MCP endpoint lifecycle, the quality snapshot. What
 * moved out is the skin and the decisions:
 *
 *   - the stepper, the head and the footer are `components/ade/import/ImportWizardChrome`;
 *   - which verb the footer carries, whether Back is allowed, how a job state reads and what the
 *     quality gate says are `importWizardModel`, so `import-wizard-model.test.ts` can assert the
 *     whole table without starting an import;
 *   - the source grid, the intake tab bar, the File intake and the MCP summary are their own
 *     components.
 *
 * The flow itself is unchanged: Source → Analyze → Preview → Import → Done, with MCP short-
 * circuiting Analyze and Preview because a discovery scan has neither.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ListChecks } from 'lucide-react';
import {
  Dialog,
  DialogContent,
} from '../../../components/ui/Dialog';
import { Alert } from '../../../components/ui/Alert';
import { Button } from '../../../components/ui/Button';
import { AnalysisPanel } from './AnalysisPanel';
import { PreviewPanel, ImportOptions } from './PreviewPanel';
import { analyzeSpecification, AnalysisResult, extractFileMetadata, FileMetadataPreview } from '../../../utils/openapi-analyzer';
import ImportExecutionPanel from './ImportExecutionPanel';
import ImportCompletePanel from './ImportCompletePanel';
import UrlImportPanel, { type UrlImportPanelHandle, type UrlImportFooterState } from './UrlImportPanel';
import { useImportSources } from './useImportSources';
import { type ImportVariant } from './importSourceCatalog';
import ClipboardImportPanel from './ClipboardImportPanel';
import GitImportPanel from './GitImportPanel';
import SwaggerHubImportPanel from './SwaggerHubImportPanel';
import PostmanImportPanel from './PostmanImportPanel';
import McpImportPanel from './McpImportPanel';
import McpDiscoveryPanel from './McpDiscoveryPanel';
import {
  buildCreateEndpointBody,
  buildCredentialBody,
  emptyMcpImportForm,
  validateMcpImportForm,
  type McpImportForm,
} from './mcp/mcpImportFlow';
import { startImport, getImportStatus, rollbackImport } from '../../../../../lib/db/import-actions';
import { generateSlug } from '../../../utils/slug';
import { appendProjectQualitySnapshot, buildQualitySnapshotReportExtras } from '../../../utils/project-quality-score-history';
import {
  FileIntakePanel,
  ImportIntakeTabs,
  ImportSourceCards,
  ImportWizardBody,
  ImportWizardFooter,
  ImportWizardHead,
  ImportWizardSteps,
  McpImportDonePanel,
  RecentImportJobsDrawer,
  importFooterFor,
  importQualityGate,
  isAcceptedImportFile,
  detectAndDescribe,
  urlTestAction,
  IMPORT_WIZARD_COPY,
  type ImportWizardStep,
} from '../import';

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  tenantId: string;
  userId: string;
  /** When set, dialog opens and runs analysis with this spec (e.g. from AI Design Chat). */
  initialLLMSpec?: string | null;
  /** Called when initialLLMSpec has been consumed so parent can clear it. */
  onConsumeInitialLLMSpec?: () => void;
  /** True when this dialog was opened from New Project → Design with AI → Import This Spec. Back/Cancel then return to the New Project form (AI tab) instead of source selection. */
  openedFromNewProjectAI?: boolean;
  /** When openedFromNewProjectAI is true, called instead of onClose when user goes Back to "source" or clicks Cancel, so parent can reopen New Project on AI tab. */
  onReturnToNewProjectAI?: () => void;
  /** When set, the dialog opens straight onto this import source (e.g. 'mcp' from MCP Servers). */
  initialSource?: string | null;
  /** Called once initialSource has been applied so the parent can clear it. */
  onConsumeInitialSource?: () => void;
  /**
   * Which importer surface this dialog serves (MFI-23.12). `projects` offers the native
   * OpenAPI/Swagger intake; `catalog` offers the alternative (non-OpenAPI) formats; `all` (default)
   * shows every source card. Drives which source cards the grid lists.
   */
  variant?: ImportVariant;
}

const ImportDialog: React.FC<ImportDialogProps> = ({
  open,
  onClose,
  onSuccess,
  tenantId,
  userId,
  initialLLMSpec,
  onConsumeInitialLLMSpec,
  openedFromNewProjectAI,
  onReturnToNewProjectAI,
  initialSource,
  onConsumeInitialSource,
  variant = 'all',
}) => {
  const [currentStep, setCurrentStep] = useState<ImportWizardStep>('source');
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileMetadata, setFileMetadata] = useState<FileMetadataPreview | null>(null);
  // A non-blocking notice about the picked file (FMT-1.1, #5412): either its extension is one no
  // registered adapter declares, or analysis failed and the detector identified the format. Never
  // an error — the file is analyzed regardless, and content sniffing has the final word.
  const [advisoryNotice, setAdvisoryNotice] = useState<string | null>(null);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [importOptions, setImportOptions] = useState<ImportOptions | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [importSucceeded, setImportSucceeded] = useState(false);
  const [importComplete, setImportComplete] = useState(false);
  const [urlContent, setUrlContent] = useState<string | null>(null);
  const [urlFilename, setUrlFilename] = useState<string | null>(null);
  const [urlMetadata, setUrlMetadata] = useState<FileMetadataPreview | null>(null);
  const [clipboardContent, setClipboardContent] = useState<string | null>(null);
  const [clipboardFilename, setClipboardFilename] = useState<string | null>(null);
  const [gitContent, setGitContent] = useState<string | null>(null);
  const [gitFilename, setGitFilename] = useState<string | null>(null);
  const [gitMetadata, setGitMetadata] = useState<FileMetadataPreview | null>(null);
  const [swaggerHubContent, setSwaggerHubContent] = useState<string | null>(null);
  const [swaggerHubFilename, setSwaggerHubFilename] = useState<string | null>(null);
  const [swaggerHubMetadata, setSwaggerHubMetadata] = useState<FileMetadataPreview | null>(null);
  const [postmanContent, setPostmanContent] = useState<string | null>(null);
  const [postmanFilename, setPostmanFilename] = useState<string | null>(null);
  const [postmanMetadata, setPostmanMetadata] = useState<FileMetadataPreview | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** The mockup's *Recent import jobs* side-sheet (HIVE-6.4). */
  const [jobsDrawerOpen, setJobsDrawerOpen] = useState(false);

  // MCP Server import source (V2-MCP-24.1): collect endpoint config, then create → discover → poll.
  const [mcpForm, setMcpForm] = useState<McpImportForm>(emptyMcpImportForm);
  const [mcpEndpointId, setMcpEndpointId] = useState<string | null>(null);
  const [mcpEndpointName, setMcpEndpointName] = useState<string>('');
  const [mcpJobId, setMcpJobId] = useState<string | null>(null);
  const [mcpSubmitting, setMcpSubmitting] = useState(false);
  // A created endpoint is "committed" only once discovery succeeds, or the user explicitly keeps a
  // failed one ("Add this server anyway"). An uncommitted endpoint is discarded (deleted) on
  // back/cancel/close so a failed auth/scan never lingers in the catalog.
  const [mcpEndpointCommitted, setMcpEndpointCommitted] = useState(false);

  const urlImportRef = useRef<UrlImportPanelHandle>(null);
  const dryRunRef = useRef(false);
  const [urlImportFooter, setUrlImportFooter] = useState<UrlImportFooterState>({
    canTestUrl: false,
    isTesting: false,
    urlTestedSuccessfully: false,
  });
  const handleUrlImportFooterState = useCallback((s: UrlImportFooterState) => {
    setUrlImportFooter(s);
  }, []);

  // MFI-1.3: the source-selection grid is data-driven. Built-in cards render immediately; any
  // server-registered adapter is merged in once `GET /api/import/sources` resolves. Only fetched
  // while the dialog is open.
  const { cards: sourceCards, fileExtensions } = useImportSources(open, variant);

  useEffect(() => {
    if (!importComplete || !importSucceeded || !jobId || !analysisResult?.qualityScore) return;
    if (dryRunRef.current) return;

    let cancelled = false;
    void (async () => {
      try {
        const status = await getImportStatus(jobId);
        if (cancelled) return;
        const projectId = (status as { result?: { projectId?: string } }).result?.projectId;
        if (!projectId) return;
        appendProjectQualitySnapshot(projectId, {
          overall: analysisResult.qualityScore.overall,
          grade: analysisResult.qualityScore.grade,
          importJobId: jobId,
          ...buildQualitySnapshotReportExtras(analysisResult),
        });
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [importComplete, importSucceeded, jobId, analysisResult]);

  // When opened with spec from AI Design Chat (Projects dashboard), run analysis immediately
  useEffect(() => {
    if (!open || !initialLLMSpec) return;
    onConsumeInitialLLMSpec?.();
    setSelectedSource('llm');
    setClipboardContent(initialLLMSpec);
    setClipboardFilename('ai-generated-spec.json');
    setCurrentStep('file-upload');
    setErrorMessage(null);
    setIsAnalyzing(true);
    analyzeSpecification(initialLLMSpec, 'ai-generated-spec.json')
      .then((result) => {
        setAnalysisResult(result);
        setCurrentStep('analysis');
      })
      .catch((err) => {
        setErrorMessage(err instanceof Error ? err.message : 'Analysis failed');
      })
      .finally(() => setIsAnalyzing(false));
  }, [open, initialLLMSpec, onConsumeInitialLLMSpec]);

  // When opened with a pre-selected source (e.g. 'mcp' from MCP Servers), jump straight to it.
  useEffect(() => {
    if (!open || !initialSource) return;
    onConsumeInitialSource?.();
    setErrorMessage(null);
    setSelectedSource(initialSource);
    setCurrentStep('file-upload');
  }, [open, initialSource, onConsumeInitialSource]);

  const handleSourceClick = (source: string) => {
    setErrorMessage(null);
    setSelectedSource(source);
    setCurrentStep('file-upload');
  };

  /** Discard a catalog endpoint (best-effort) — used to clean up a failed/abandoned MCP import. */
  const deleteMcpEndpoint = async (id: string) => {
    try {
      await fetch(`/api/mcp/endpoints/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch {
      // Best-effort cleanup — ignore failures (the row is soft-deleted server-side when reached).
    }
  };

  /** Explicitly discard a failed MCP import: delete the endpoint and close the dialog. */
  const discardMcpAndClose = async () => {
    if (mcpEndpointId) {
      await deleteMcpEndpoint(mcpEndpointId);
    }
    resetDialogState();
    onClose();
  };

  const handleBack = () => {
    setErrorMessage(null);
    if (currentStep === 'done') {
      setCurrentStep('import');
    } else if (currentStep === 'import' && selectedSource === 'mcp') {
      // MCP has no analyze/preview steps — Back returns to the endpoint config form. An uncommitted
      // endpoint (failed/in-progress scan the user didn't keep) is discarded on the way out.
      if (mcpEndpointId && !mcpEndpointCommitted) {
        void deleteMcpEndpoint(mcpEndpointId);
        setMcpEndpointId(null);
        setMcpEndpointName('');
      }
      setCurrentStep('file-upload');
      setMcpJobId(null);
      setImportComplete(false);
      setImportSucceeded(false);
    } else if (currentStep === 'import') {
      setCurrentStep('preview');
      setJobId(null);
    } else if (currentStep === 'preview') {
      setCurrentStep('analysis');
    } else if (currentStep === 'analysis') {
      // If the source was LLM and we were opened from New Project AI, return to that conversation instead of source
      if (selectedSource === 'llm' && openedFromNewProjectAI && onReturnToNewProjectAI) {
        onReturnToNewProjectAI();
        return;
      }
      // If the source was LLM, skip file-upload and go straight back to source selection
      if (selectedSource === 'llm') {
        setCurrentStep('source');
        setSelectedSource(null);
        setClipboardContent(null);
        setClipboardFilename(null);
      } else {
        setCurrentStep('file-upload');
      }
      setAnalysisResult(null);
    } else if (currentStep === 'file-upload') {
      // If we were opened from New Project AI (e.g. landed on analysis then went back to file-upload), return to that conversation
      if (openedFromNewProjectAI && onReturnToNewProjectAI) {
        onReturnToNewProjectAI();
        return;
      }
      setCurrentStep('source');
      setSelectedSource(null);
      setSelectedFile(null);
      setFileMetadata(null);
      setAdvisoryNotice(null);
      setUrlContent(null);
      setUrlFilename(null);
      setUrlMetadata(null);
      setClipboardContent(null);
      setClipboardFilename(null);
      setGitContent(null);
      setGitFilename(null);
      setGitMetadata(null);
      setSwaggerHubContent(null);
      setSwaggerHubFilename(null);
      setSwaggerHubMetadata(null);
      setPostmanContent(null);
      setPostmanFilename(null);
      setPostmanMetadata(null);
      setMcpForm(emptyMcpImportForm());
      setMcpEndpointId(null);
      setMcpEndpointName('');
      setMcpJobId(null);
    }
  };

  const resetDialogState = () => {
    setCurrentStep('source');
    setSelectedSource(null);
    setSelectedFile(null);
    setFileMetadata(null);
    setAdvisoryNotice(null);
    setAnalysisResult(null);
    setImportOptions(null);
    setJobId(null);
    setImportSucceeded(false);
    setImportComplete(false);
    setUrlContent(null);
    setUrlFilename(null);
    setUrlMetadata(null);
    setClipboardContent(null);
    setClipboardFilename(null);
    setGitContent(null);
    setGitFilename(null);
    setGitMetadata(null);
    setSwaggerHubContent(null);
    setSwaggerHubFilename(null);
    setSwaggerHubMetadata(null);
    setPostmanContent(null);
    setPostmanFilename(null);
    setPostmanMetadata(null);
    setMcpForm(emptyMcpImportForm());
    setMcpEndpointId(null);
    setMcpEndpointName('');
    setMcpJobId(null);
    setMcpSubmitting(false);
    setMcpEndpointCommitted(false);
    setErrorMessage(null);
    setJobsDrawerOpen(false);
    dryRunRef.current = false;
  };

  const handleClose = async () => {
    // Discard a created-but-uncommitted MCP endpoint: auth/scan failed (or was still running) and the
    // user did not choose "Add this server anyway", so it must not linger in the catalog.
    if (selectedSource === 'mcp' && mcpEndpointId && !mcpEndpointCommitted) {
      await deleteMcpEndpoint(mcpEndpointId);
    }

    // If opened from New Project AI, return to that conversation instead of closing to projects list
    if (openedFromNewProjectAI && onReturnToNewProjectAI) {
      if (jobId && currentStep === 'import') {
        try {
          await rollbackImport(jobId);
        } catch (e) {
          console.error('Failed to rollback import on close:', e);
        }
      }
      resetDialogState();
      onReturnToNewProjectAI();
      return;
    }

    // If there's a pending import job (during import step), roll back the transaction
    if (jobId && currentStep === 'import') {
      try {
        await rollbackImport(jobId);
      } catch (e) {
        console.error('Failed to rollback import on close:', e);
      }
    }

    // Call onSuccess callback if an import landed (a spec import succeeded, or an MCP endpoint was
    // committed — discovered, or explicitly kept via "Add this server anyway") so the list refreshes.
    if ((importSucceeded || mcpEndpointCommitted) && onSuccess) {
      onSuccess();
    }

    resetDialogState();
    onClose();
  };

  const handleAnalyze = async () => {
    if (!selectedFile && !urlContent && !clipboardContent && !gitContent && !swaggerHubContent && !postmanContent) return;

    setErrorMessage(null);
    setIsAnalyzing(true);
    try {
      const content = urlContent || clipboardContent || gitContent || swaggerHubContent || postmanContent || await selectedFile!.text();
      const filename = urlFilename || clipboardFilename || gitFilename || swaggerHubFilename || postmanFilename || selectedFile?.name || 'openapi-spec.yaml';
      const result = await analyzeSpecification(content, filename);
      // FMT-1.1 (#5412): the local analyzer reads only the OpenAPI/Swagger/Arazzo family. When it
      // cannot place a document, ask the registry-wide detector what the bytes actually are and
      // report *its* verdict, instead of leaving the user with a bare parse error.
      if (!result.formatSupported) {
        setAdvisoryNotice(await detectAndDescribe(content, filename));
      } else {
        setAdvisoryNotice(null);
      }
      setAnalysisResult(result);
      setCurrentStep('analysis');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Analysis failed. Please check the specification and try again.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleUrlSpecificationFetched = (content: string, filename: string, metadata?: FileMetadataPreview) => {
    setUrlContent(content);
    setUrlFilename(filename);
    setUrlMetadata(metadata || null);
    // Don't auto-analyze - user needs to click "Next →" button
  };

  const handleClipboardSpecificationReady = (content: string, filename: string) => {
    setClipboardContent(content);
    setClipboardFilename(filename);
  };

  const handleGitSpecificationFetched = (content: string, filename: string, metadata?: FileMetadataPreview) => {
    setGitContent(content);
    setGitFilename(filename);
    setGitMetadata(metadata || null);
    // Don't auto-analyze - user needs to click "Analyze →" button
  };

  const handleSwaggerHubSpecificationFetched = (content: string, filename: string, metadata?: FileMetadataPreview) => {
    setSwaggerHubContent(content);
    setSwaggerHubFilename(filename);
    setSwaggerHubMetadata(metadata || null);
    // Don't auto-analyze - user needs to click "Analyze →" button
  };

  const handlePostmanSpecificationFetched = (content: string, filename: string, metadata?: FileMetadataPreview) => {
    setPostmanContent(content);
    setPostmanFilename(filename);
    setPostmanMetadata(metadata || null);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      void handleFileSelect(files[0]);
    }
  };

  const handleFileSelect = async (file: File) => {
    // FMT-1.1 (#5412): the extension is a *hint*, not a gate. This used to reject anything outside a
    // hard-coded ten-entry list, which made thirty-three registered adapters unreachable. An
    // unrecognized name is now accepted and routed to detection — content sniffing decides the
    // format, and the detector's verdict is what the user is told if it turns out to be nothing.
    const recognized = isAcceptedImportFile(file.name, fileExtensions);

    setErrorMessage(null);
    setSelectedFile(file);
    setFileMetadata(null);
    setAdvisoryNotice(
      recognized
        ? null
        : `No import source claims the extension on "${file.name}". We'll analyze its contents anyway and tell you what it turns out to be.`,
    );

    // A ZIP is a bundle, not a document — it is only opened once Analyze runs.
    if (file.name.toLowerCase().endsWith('.zip')) return;

    setIsLoadingMetadata(true);
    try {
      const content = await file.text();
      setFileMetadata(extractFileMetadata(content));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not read or preview this file. Try another file or format.'
      );
    } finally {
      setIsLoadingMetadata(false);
    }
  };

  const beginImport = async () => {
    if (!analysisResult || !importOptions) return;

    dryRunRef.current = Boolean(importOptions.dryRun);

    // Validate that we have required IDs
    if (!tenantId) {
      setErrorMessage('Import failed: no workspace is selected.');
      return;
    }
    if (!userId) {
      setErrorMessage('Import failed: you are not signed in.');
      return;
    }

    const document = analysisResult.document;
    const sourceKind = analysisResult.format === 'arazzo' ? 'arazzo' : 'openapi';
    const job = await startImport({
      tenantId,
      userId,
      sourceKind,
      document,
      project: {
        name: importOptions.projectName || (document?.info?.title || 'New Project'),
        slug: importOptions.projectSlug || generateSlug(document?.info?.title || 'new-project') || 'imported-project',
        description: document?.info?.description || null
      },
      version: {
        versionId: importOptions.targetVersion || (document?.info?.version || '1.0.0'),
        description: 'Imported from OpenAPI specification'
      },
      options: {
        selectedSchemas: importOptions.selectedSchemas,
        applyNamingConvention: importOptions.applyNamingConvention ?? true,
        classNamingConvention: importOptions.classNamingConvention ?? 'PascalCase',
        propertyNamingConvention: importOptions.propertyNamingConvention ?? 'camelCase',
        classNameMap: importOptions.classNameMap,
        classPrefix: (importOptions.classPrefix ?? '').trim() || undefined,
        classSuffix: (importOptions.classSuffix ?? '').trim() || undefined,
        typeMapping: importOptions.typeMapping,
        defaultValues: importOptions.defaultValues,
        requiredOverrides: importOptions.requiredOverrides,
        descriptionOverrides: importOptions.descriptionOverrides,
        generateExamples: importOptions.generateExamples ?? false,
        dryRun: importOptions.dryRun ?? false,
        incrementalMode: importOptions.incrementalMode ?? false
      }
    });

    setJobId(job.jobId);
    setCurrentStep('import');
  };

  /**
   * MCP source: create the catalog endpoint, store any credential, then kick off a discovery run
   * and advance to the live-status step. The discovery commits catalog version 1 on success.
   *
   * If anything before the scan fails (registration, credential storage, or starting discovery), the
   * just-created endpoint is discarded so a half-wired entry never shows up in the catalog.
   */
  const beginMcpImport = async () => {
    const validationError = validateMcpImportForm(mcpForm);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setErrorMessage(null);
    setMcpSubmitting(true);
    // Tracks the endpoint created in this attempt so a pre-scan failure can discard it.
    let createdId: string | null = null;
    try {
      // 1. Create the endpoint.
      const createBody = buildCreateEndpointBody(mcpForm);
      const createRes = await fetch('/api/mcp/endpoints', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        throw new Error(typeof createData.error === 'string' ? createData.error : 'Could not register the MCP server.');
      }
      const endpoint = createData.endpoint as { id?: string; name?: string } | undefined;
      const endpointId = endpoint?.id;
      if (!endpointId) {
        throw new Error('The MCP server was created but no id was returned.');
      }
      createdId = endpointId;
      setMcpEndpointId(endpointId);
      setMcpEndpointName(endpoint?.name || createBody.name);
      setMcpEndpointCommitted(false);

      // 2. Store the credential, when an auth type was chosen.
      const credentialBody = buildCredentialBody(mcpForm);
      if (credentialBody) {
        const credRes = await fetch(`/api/mcp/endpoints/${encodeURIComponent(endpointId)}/credentials`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(credentialBody),
        });
        if (!credRes.ok) {
          const credData = await credRes.json().catch(() => ({}));
          throw new Error(typeof credData.error === 'string' ? credData.error : 'Could not store the credential.');
        }
      }

      // 3. Kick off discovery.
      const discoverRes = await fetch(`/api/mcp/endpoints/${encodeURIComponent(endpointId)}/discover`, {
        method: 'POST',
        credentials: 'include',
      });
      const discoverData = await discoverRes.json().catch(() => ({}));
      if (!discoverRes.ok) {
        throw new Error(typeof discoverData.error === 'string' ? discoverData.error : 'Could not start discovery.');
      }
      const startedJob = discoverData.job as { id?: string } | undefined;
      if (!startedJob?.id) {
        throw new Error('Discovery did not start.');
      }

      setMcpJobId(startedJob.id);
      setImportComplete(false);
      setImportSucceeded(false);
      setCurrentStep('import');
    } catch (error) {
      // Registration / credential / discovery-trigger failed before the scan could run — discard the
      // half-wired endpoint so it never appears in the catalog, and let the user fix the form.
      if (createdId) {
        await deleteMcpEndpoint(createdId);
        setMcpEndpointId(null);
        setMcpEndpointName('');
      }
      setErrorMessage(error instanceof Error ? error.message : 'Could not import the MCP server.');
    } finally {
      setMcpSubmitting(false);
    }
  };

  /**
   * Whether the chosen intake has produced something Analyze can read.
   *
   * One expression rather than the six `disabled={…}` clauses the old footer carried, so the
   * "Analyze is offered exactly when there is content and the format is importable" rule holds
   * for every source rather than for whichever branch was edited last.
   */
  const intakeReady = useMemo(() => {
    switch (selectedSource) {
      case 'file':
        return Boolean(selectedFile) && (fileMetadata === null || fileMetadata.formatSupported);
      case 'url':
        return Boolean(urlContent) && (urlMetadata === null || urlMetadata.formatSupported);
      case 'clipboard':
      case 'llm':
        return Boolean(clipboardContent);
      case 'git':
        return Boolean(gitContent) && (gitMetadata === null || gitMetadata.formatSupported);
      case 'swaggerhub':
        return Boolean(swaggerHubContent) && (swaggerHubMetadata === null || swaggerHubMetadata.formatSupported);
      case 'postman':
        return Boolean(postmanContent) && (postmanMetadata === null || postmanMetadata.formatSupported);
      default:
        return false;
    }
  }, [
    selectedSource,
    selectedFile,
    fileMetadata,
    urlContent,
    urlMetadata,
    clipboardContent,
    gitContent,
    gitMetadata,
    swaggerHubContent,
    swaggerHubMetadata,
    postmanContent,
    postmanMetadata,
  ]);

  const footer = importFooterFor({
    step: currentStep,
    source: selectedSource,
    importComplete,
    importSucceeded,
    analyzing: isAnalyzing,
    intakeReady,
    analysisImportable: Boolean(analysisResult?.isValid && analysisResult?.formatSupported),
    hasSelection: Boolean(importOptions && importOptions.selectedSchemas.length > 0),
    mcpReady: validateMcpImportForm(mcpForm) === null,
    mcpSubmitting,
  });

  const qualityGate = currentStep === 'analysis' ? importQualityGate(analysisResult) : null;

  /** The one forward action of the step the wizard is on. */
  const handlePrimary = () => {
    if (currentStep === 'analysis') {
      setCurrentStep('preview');
      return;
    }
    if (currentStep === 'preview') {
      void beginImport();
      return;
    }
    if (currentStep === 'import') {
      setCurrentStep('done');
      return;
    }
    if (currentStep === 'done') {
      void handleClose();
      return;
    }
    if (currentStep === 'file-upload') {
      if (selectedSource === 'mcp') void beginMcpImport();
      else void handleAnalyze();
    }
  };

  /** The dismiss verb — *Discard* on a failed MCP import also deletes the endpoint. */
  const handleCancel = () => {
    if (footer.keepAnyway) {
      void discardMcpAndClose();
      return;
    }
    void handleClose();
  };

  const urlTest = urlTestAction(urlImportFooter);
  const showUrlTest = currentStep === 'file-upload' && selectedSource === 'url';

  /** The intake panel for the chosen source, or the card grid when none is chosen yet. */
  const renderStep = () => {
    if (currentStep === 'source') {
      return (
        <ImportSourceCards
          cards={sourceCards}
          selected={selectedSource}
          onSelect={handleSourceClick}
        />
      );
    }

    if (currentStep === 'analysis' && analysisResult) {
      return (
        <div className="flex flex-col gap-4">
          {qualityGate ? (
            <Alert variant={qualityGate.tone}>
              <span className="font-semibold">{qualityGate.title}</span> — {qualityGate.body}
            </Alert>
          ) : null}
          <AnalysisPanel fileName={selectedFile?.name || ''} analysis={analysisResult} />
        </div>
      );
    }

    if (currentStep === 'preview' && analysisResult) {
      return <PreviewPanel analysis={analysisResult} onImportOptionsChange={setImportOptions} />;
    }

    if (currentStep === 'import' && selectedSource === 'mcp' && mcpEndpointId && mcpJobId) {
      return (
        <McpDiscoveryPanel
          endpointId={mcpEndpointId}
          jobId={mcpJobId}
          endpointName={mcpEndpointName}
          onComplete={(succeeded) => {
            setImportSucceeded(succeeded);
            setImportComplete(true);
            // A successful scan commits the endpoint; a failed scan leaves it uncommitted so
            // it is discarded unless the user picks "Add this server anyway".
            if (succeeded) setMcpEndpointCommitted(true);
          }}
        />
      );
    }

    if (currentStep === 'import' && jobId) {
      return (
        <ImportExecutionPanel
          jobId={jobId}
          selectedSchemas={importOptions?.selectedSchemas ?? []}
          isReviewing={importComplete}
          onComplete={(succeeded) => {
            setImportComplete(true);
            setImportSucceeded(succeeded);
          }}
          onRetry={(newJobId) => {
            setJobId(newJobId);
            setImportComplete(false);
          }}
        />
      );
    }

    if (currentStep === 'done') {
      if (selectedSource === 'mcp') {
        return (
          <McpImportDonePanel
            endpointId={mcpEndpointId}
            endpointName={mcpEndpointName}
            succeeded={importSucceeded}
            onNavigate={() => void handleClose()}
          />
        );
      }
      return jobId ? <ImportCompletePanel jobId={jobId} /> : null;
    }

    // Everything below is the intake step: the tab bar, then the chosen source's panel.
    const intake = (() => {
      switch (selectedSource) {
        case 'file':
          return (
            <FileIntakePanel
              extensions={fileExtensions}
              file={selectedFile}
              metadata={fileMetadata}
              loading={isLoadingMetadata}
              dragging={isDragging}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onPick={(file) => void handleFileSelect(file)}
              onRemove={() => {
                setSelectedFile(null);
                setFileMetadata(null);
                setAdvisoryNotice(null);
              }}
            />
          );
        case 'url':
          return (
            <UrlImportPanel
              ref={urlImportRef}
              onSpecificationFetched={handleUrlSpecificationFetched}
              onFooterStateChange={handleUrlImportFooterState}
            />
          );
        case 'clipboard':
        case 'llm':
          return <ClipboardImportPanel onSpecificationReady={handleClipboardSpecificationReady} />;
        case 'git':
          return <GitImportPanel userId={userId} onSpecificationFetched={handleGitSpecificationFetched} />;
        case 'swaggerhub':
          return <SwaggerHubImportPanel onSpecificationFetched={handleSwaggerHubSpecificationFetched} />;
        case 'postman':
          return <PostmanImportPanel onSpecificationFetched={handlePostmanSpecificationFetched} />;
        case 'mcp':
          return <McpImportPanel form={mcpForm} onChange={setMcpForm} />;
        default:
          return null;
      }
    })();

    return (
      <div className="flex min-h-0 flex-col gap-4">
        <ImportIntakeTabs cards={sourceCards} active={selectedSource} onSelect={handleSourceClick} />
        {intake}
      </div>
    );
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) void handleClose();
        }}
      >
        <DialogContent
          size="full"
          className="imp-wizard"
          closeLabel={IMPORT_WIZARD_COPY.closeWarning}
        >
          <ImportWizardHead
            actions={
              <Button variant="ghost" size="sm" onClick={() => setJobsDrawerOpen(true)}>
                <ListChecks aria-hidden />
                {IMPORT_WIZARD_COPY.jobsDrawerTitle}
              </Button>
            }
          />
          <ImportWizardSteps step={currentStep} />
          <ImportWizardBody>
            {errorMessage ? (
              <Alert variant="danger" className="mb-4">
                {errorMessage}
              </Alert>
            ) : null}
            {/*
              FMT-1.1 (#5412): an extension no adapter declares is a *warning*, not a rejection —
              the file is analyzed anyway and detection decides. `info`, never `danger`: nothing has
              failed yet, and the common case is a correctly-named file of a format whose adapter
              simply does not spell that suffix.
            */}
            {advisoryNotice ? (
              <Alert variant="info" className="mb-4" data-testid="import-advisory-notice">
                {advisoryNotice}
              </Alert>
            ) : null}
            {renderStep()}
          </ImportWizardBody>
          <ImportWizardFooter
            footer={footer}
            onBack={handleBack}
            onCancel={handleCancel}
            onPrimary={handlePrimary}
            onKeepAnyway={() => {
              setMcpEndpointCommitted(true);
              setCurrentStep('done');
            }}
            extra={
              showUrlTest ? (
                <Button
                  variant={urlTest.tested ? 'success' : 'outline'}
                  onClick={() => void urlImportRef.current?.testUrl()}
                  disabled={urlTest.disabled}
                >
                  {urlTest.label}
                </Button>
              ) : undefined
            }
          />
        </DialogContent>
      </Dialog>
      <RecentImportJobsDrawer open={jobsDrawerOpen} onOpenChange={setJobsDrawerOpen} />
    </>
  );
};

export default ImportDialog;
