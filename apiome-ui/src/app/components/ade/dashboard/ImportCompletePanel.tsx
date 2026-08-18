'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Palette,
  FileText,
  Download,
  Plus,
  Clock,
  ShieldCheck,
  ShieldX,
  Undo2
} from 'lucide-react';
import { getImportStatus, rollbackCompletedImport } from '../../../../../lib/db/import-actions';
import { buildDesignerEditorHref } from '../../../../../lib/external-links';
import { buildImportErrorReport, getImportErrorReportFilename, type ImportErrorReport, type ImportStatusForReport } from '../../../../../lib/db/import-error-report';
import { SchemaVersionScoringPanel } from './SchemaVersionScoringPanel';

interface ImportCompletePanelProps {
  jobId: string;
}

interface VerificationResult {
  passed: boolean;
  classesVerified: number;
  propertiesVerified: number;
  mismatches: Array<{
    type: string;
    className: string;
    propertyName?: string;
    message: string;
  }>;
}

interface RawImportSummary {
  classesCreated?: number;
  warnings?: number;
  failed?: number;
  propertiesCreated?: number;
  pathsImported?: number;
  totalTime?: number;
  sourceName?: string;
  projectName?: string;
  projectId?: string;
  versionId?: string;
  dryRun?: boolean;
  incrementalMode?: boolean;
  classes?: Array<{
    name: string;
    status: 'success' | 'warning' | 'failed';
  }>;
  verification?: VerificationResult;
}

interface ImportStatusResponse {
  state: string;
  result?: {
    projectId?: string;
    versionId?: string;
  };
  summary?: RawImportSummary;
}

interface ImportSummary {
  success: number;
  warnings: number;
  failed: number;
  properties: number;
  paths: number;
  totalTime?: number;
  sourceName?: string;
  projectName?: string;
  projectId?: string;
  versionId?: string;
  dryRun?: boolean;
  incrementalMode?: boolean;
  schemas?: Array<{
    name: string;
    status: 'success' | 'warning' | 'failed';
  }>;
  verification?: VerificationResult;
}

export default function ImportCompletePanel({ jobId }: ImportCompletePanelProps) {
  const router = useRouter();
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [report, setReport] = useState<ImportErrorReport | null>(null);
  const [state, setState] = useState<'completed' | 'failed' | 'canceled' | 'rolled-back' | string>('completed');
  const [loading, setLoading] = useState(true);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = await getImportStatus(jobId) as ImportStatusResponse;
        setState(status.state);

        // Surface the same failures the downloadable report contains (errors,
        // warnings, failed classes, verification mismatches) directly in the UI.
        try {
          setReport(buildImportErrorReport(status as unknown as ImportStatusForReport));
        } catch (reportErr) {
          console.error('Error building import error report:', reportErr);
        }

        // Extract summary from status; use result for projectId/versionId when completed
        const result = status.result;
        if (status.summary) {
          const rawSummary = status.summary;
          setSummary({
            success: rawSummary.classesCreated ?? 0,
            warnings: rawSummary.warnings ?? 0,
            failed: rawSummary.failed ?? 0,
            properties: rawSummary.propertiesCreated ?? 0,
            paths: rawSummary.pathsImported ?? 0,
            totalTime: rawSummary.totalTime,
            sourceName: rawSummary.sourceName,
            projectName: rawSummary.projectName,
            projectId: result?.projectId ?? rawSummary.projectId,
            versionId: result?.versionId ?? rawSummary.versionId,
            dryRun: rawSummary.dryRun === true,
            incrementalMode: rawSummary.incrementalMode === true,
            schemas: rawSummary.classes?.map((c) => ({
              name: c.name,
              status: c.status
            })) || [],
            verification: rawSummary.verification ? {
              passed: rawSummary.verification.passed,
              classesVerified: rawSummary.verification.classesVerified,
              propertiesVerified: rawSummary.verification.propertiesVerified,
              mismatches: rawSummary.verification.mismatches || []
            } : undefined
          });
        }
      } catch (e) {
        console.error('Error fetching import status:', e);
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
  }, [jobId]);

  const handleViewInCanvas = () => {
    if (summary?.projectId && summary?.versionId) {
      const href = buildDesignerEditorHref(summary.projectId, summary.versionId);
      if (href) {
        router.push(href);
      }
    }
  };

  const handleRollbackCompleted = async () => {
    if (!jobId) return;
    setIsRollingBack(true);
    setRollbackError(null);
    try {
      const result = await rollbackCompletedImport(jobId);
      if (result.success) {
        setState('rolled-back');
      } else {
        setRollbackError(result.error ?? 'Rollback failed');
      }
    } catch (e) {
      console.error('Rollback failed:', e);
      setRollbackError(e instanceof Error ? e.message : 'Rollback failed');
    } finally {
      setIsRollingBack(false);
    }
  };

  const handleDownloadErrorReport = async () => {
    try {
      const status = await getImportStatus(jobId);
      const exportedAt = new Date().toISOString();
      const report = buildImportErrorReport(status as ImportStatusForReport, exportedAt);
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = getImportErrorReportFilename(status.jobId, exportedAt);
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to download error report:', e);
    }
  };

  const formatDuration = (ms?: number) => {
    if (!ms) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)} seconds`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
      </div>
    );
  }

  const isSuccess = state === 'completed';
  const isDryRun = isSuccess && summary?.dryRun === true;
  const isIncremental = isSuccess && summary?.incrementalMode === true && !summary?.dryRun;
  const isFailed = state === 'failed';
  const isRolledBack = state === 'rolled-back';

  return (
    <div className="space-y-6">
      {/* Success/Failure/Rolled-back Header */}
      <div className="flex flex-col items-center justify-center py-8">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${
          isSuccess 
            ? 'bg-ok-soft' 
            : isFailed 
            ? 'bg-danger-soft'
            : isRolledBack
            ? 'bg-inset'
            : 'bg-warn-soft'
        }`}>
          {isSuccess ? (
            <CheckCircle2 className="h-10 w-10 text-ok" />
          ) : isFailed ? (
            <XCircle className="h-10 w-10 text-danger" />
          ) : isRolledBack ? (
            <Undo2 className="h-10 w-10 text-fg-muted" />
          ) : (
            <AlertTriangle className="h-10 w-10 text-warn" />
          )}
        </div>
        <h2 className="text-2xl font-bold text-fg">
          {isDryRun ? 'Dry run complete' : isSuccess ? 'Import Complete!' : isFailed ? 'Import Failed' : isRolledBack ? 'Import Rolled Back' : 'Import Canceled'}
        </h2>
        {isDryRun && (
          <p className="text-fg-muted mt-2 text-center max-w-md">
            No project or data was created. To import for real, go back and run again with &quot;Dry run (preview only)&quot; unchecked.
          </p>
        )}
        {isIncremental && (summary?.failed ?? 0) > 0 && (
          <p className="text-fg-muted mt-2 text-center max-w-md">
            {summary?.success ?? 0} class(es) imported; {summary?.failed ?? 0} skipped due to errors.
          </p>
        )}
        {isRolledBack && (
          <p className="text-fg-muted mt-2">
            The completed import was undone. The created project and all imported data have been removed.
          </p>
        )}
        {!isSuccess && !isRolledBack && !isDryRun && (
          <p className="text-fg-muted mt-2">
            {isFailed
              ? 'There was an error during the import process.'
              : 'The import was canceled before completion.'}
          </p>
        )}
      </div>

      {/* Import Summary */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-lg font-semibold text-fg">Import Summary</h3>
          {isDryRun && (
            <Badge variant="secondary" className="text-xs">Preview only</Badge>
          )}
          {isIncremental && (
            <Badge variant="secondary" className="text-xs">Incremental</Badge>
          )}
        </div>

        {/* Imported Counts */}
        <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-3">
          <div className="bg-ok-soft rounded-lg p-4 text-center border border-ok">
            <div className="text-3xl font-bold text-ok">
              {(summary?.success || 0).toLocaleString()}
            </div>
            <div className="text-sm text-ok flex items-center justify-center gap-1 mt-1">
              <CheckCircle2 className="h-4 w-4" />
              Classes imported
            </div>
          </div>
          <div className="bg-accent-soft rounded-lg p-4 text-center border border-accent">
            <div className="text-3xl font-bold text-accent">
              {(summary?.properties || 0).toLocaleString()}
            </div>
            <div className="text-sm text-accent flex items-center justify-center gap-1 mt-1">
              <FileText className="h-4 w-4" />
              Properties imported
            </div>
          </div>
          <div className="bg-accent-soft rounded-lg p-4 text-center">
            <div className="text-3xl font-bold text-accent">
              {(summary?.paths || 0).toLocaleString()}
            </div>
            <div className="text-sm text-accent flex items-center justify-center gap-1 mt-1">
              <Plus className="h-4 w-4" />
              Paths imported
            </div>
          </div>
        </div>

        {/* Import Health */}
        <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-2">
          <div className="bg-warn-soft rounded-lg p-4 text-center border border-warn">
            <div className="text-3xl font-bold text-warn">
              {(summary?.warnings || 0).toLocaleString()}
            </div>
            <div className="text-sm text-warn flex items-center justify-center gap-1 mt-1">
              <AlertTriangle className="h-4 w-4" />
              Warning
            </div>
          </div>
          <div className="bg-danger-soft rounded-lg p-4 text-center border border-danger">
            <div className="text-3xl font-bold text-danger">
              {(summary?.failed || 0).toLocaleString()}
            </div>
            <div className="text-sm text-danger flex items-center justify-center gap-1 mt-1">
              <XCircle className="h-4 w-4" />
              Failed
            </div>
          </div>
        </div>

        {/* Verification Status */}
        {summary?.verification && (
          <div className={`rounded-lg p-4 mb-6 border ${
            summary.verification.passed 
              ? 'bg-ok-soft border-ok'
              : 'bg-danger-soft border-danger'
          }`}>
            <div className="flex items-center gap-3 mb-2">
              {summary.verification.passed ? (
                <ShieldCheck className="h-6 w-6 text-ok" />
              ) : (
                <ShieldX className="h-6 w-6 text-danger" />
              )}
              <div className={`font-semibold ${
                summary.verification.passed 
                  ? 'text-ok-fg'
                  : 'text-danger'
              }`}>
                {summary.verification.passed ? 'Import Verification Passed' : 'Import Verification Failed'}
              </div>
            </div>
            <div className={`text-sm ${
              summary.verification.passed 
                ? 'text-ok'
                : 'text-danger'
            }`}>
              {summary.verification.passed ? (
                <span>
                  Successfully verified {summary.verification.classesVerified} classes and{' '}
                  {summary.verification.propertiesVerified} properties match the imported schema.
                </span>
              ) : (
                <div className="space-y-2">
                  <span>
                    Found {summary.verification.mismatches.length} mismatches during verification.
                  </span>
                  {summary.verification.mismatches.slice(0, 5).map((mismatch, idx) => (
                    <div key={idx} className="ps-4 border-s-2 border-danger text-xs">
                      <div className="font-medium">{mismatch.className}{mismatch.propertyName ? `.${mismatch.propertyName}` : ''}</div>
                      <div className="text-danger">{mismatch.message}</div>
                    </div>
                  ))}
                  {summary.verification.mismatches.length > 5 && (
                    <div className="text-xs italic">
                      ...and {summary.verification.mismatches.length - 5} more
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Metadata — the mockup's `.kv-mini`: label in quiet ink, value in mono. */}
        <dl className="imp-kv">
          <dt>Total time</dt>
          <dd>{formatDuration(summary?.totalTime)}</dd>
          {summary?.sourceName && (
            <>
              <dt>Source</dt>
              <dd>{summary.sourceName}</dd>
            </>
          )}
          {(summary?.projectName || summary?.versionId) && (
            <>
              <dt>Target</dt>
              <dd>
                {summary.projectName || 'Project'} / {summary.versionId || 'Version'}
              </dd>
            </>
          )}
        </dl>
      </div>

      {/* Failure details — the same errors/warnings carried in the downloadable report */}
      {report && (report.errorsAndWarnings.length > 0 || report.failedClasses.length > 0) && (
        <div className="bg-surface rounded-xl border border-danger p-6">
          <div className="flex items-center gap-2 mb-4">
            <XCircle className="h-5 w-5 text-danger" />
            <h3 className="text-lg font-semibold text-fg">Failure details</h3>
          </div>

          {report.failedClasses.length > 0 && (
            <div className="mb-4">
              <h4 className="text-sm font-medium text-fg mb-2">
                Failed classes ({report.failedClasses.length})
              </h4>
              <div className="flex flex-wrap gap-2">
                {report.failedClasses.map((c, idx) => (
                  <Badge key={idx} variant="error" className="flex items-center gap-1">
                    <XCircle className="h-3 w-3" />
                    {c.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {report.errorsAndWarnings.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-fg mb-2">
                Errors &amp; warnings ({report.errorsAndWarnings.length})
              </h4>
              <div className="space-y-2">
                {[...report.errorsAndWarnings]
                  .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
                  .map((entry, idx) => {
                    const isError = entry.level === 'error';
                    return (
                      <div
                        key={idx}
                        className={`rounded-lg border p-3 ${
                          isError
                            ? 'border-danger bg-danger-soft'
                            : 'border-warn bg-warn-soft'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {isError ? (
                            <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-danger" />
                          ) : (
                            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warn" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={isError ? 'error' : 'warning'} className="text-2xs uppercase">
                                {entry.level}
                              </Badge>
                              <span className="font-mono text-xs text-fg-muted">{entry.code}</span>
                            </div>
                            <p
                              className={`mt-1 text-sm break-words ${
                                isError
                                  ? 'text-danger'
                                  : 'text-warn-fg'
                              }`}
                            >
                              {entry.message}
                            </p>
                            {entry.context != null && (
                              <pre className="mt-2 max-h-40 overflow-auto rounded bg-inset p-2 text-2xs text-fg">
                                {typeof entry.context === 'string'
                                  ? entry.context
                                  : JSON.stringify(entry.context, null, 2)}
                              </pre>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Quality lint report (GOV-2.4) — server findings with rule metadata after a successful import. */}
      {isSuccess && !isDryRun && summary?.projectId && summary?.versionId && !isRolledBack && (
        <SchemaVersionScoringPanel
          projectId={summary.projectId}
          versionId={summary.versionId}
          versionLabel={summary.versionId}
          active
          preferenceView="import-report"
        />
      )}

      {/* Imported Schemas */}
      {summary?.schemas && summary.schemas.length > 0 && (
        <div className="bg-surface rounded-xl border border-border p-6">
          <h3 className="text-lg font-semibold text-fg mb-4">Imported Schemas</h3>
          <div className="flex flex-wrap gap-2">
            {summary.schemas.map((schema, index) => (
              <Badge
                key={index}
                variant={
                  schema.status === 'success' ? 'success' :
                  schema.status === 'warning' ? 'warning' :
                  'error'
                }
                className="flex items-center gap-1"
              >
                {schema.status === 'success' ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : schema.status === 'warning' ? (
                  <AlertTriangle className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {schema.name}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Rollback error */}
      {rollbackError && (
        <div className="rounded-xl border border-danger bg-danger-soft p-4 flex items-center gap-3">
          <XCircle className="h-5 w-5 text-danger shrink-0" />
          <p className="text-sm text-danger">{rollbackError}</p>
        </div>
      )}

      {/* Next Actions */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <h3 className="text-lg font-semibold text-fg mb-4">Next Actions</h3>
        <div className="text-center py-8 text-fg-muted">
          {isDryRun && (
            <p className="text-sm text-accent mb-4">
              This was a preview only. No project was created — View on Canvas and Undo are not available.
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-4 mb-4">
            {isSuccess && !isDryRun && summary?.projectId && summary?.versionId && !isRolledBack ? (
              <Button
                variant="outline"
                className="flex items-center gap-2"
                onClick={handleViewInCanvas}
              >
                <Palette className="h-4 w-4" />
                View on Canvas
              </Button>
            ) : (
              <Button variant="outline" disabled className="flex items-center gap-2">
                <Palette className="h-4 w-4" />
                View on Canvas
              </Button>
            )}
            {isSuccess && !isDryRun && summary?.projectId && !isRolledBack && (
              <Button
                variant="outline"
                className="flex items-center gap-2 text-warn hover:bg-warn-soft"
                onClick={handleRollbackCompleted}
                disabled={isRollingBack}
              >
                <Undo2 className={`h-4 w-4 ${isRollingBack ? 'animate-pulse' : ''}`} />
                {isRollingBack ? 'Rolling back...' : 'Undo import'}
              </Button>
            )}
            <Button variant="outline" disabled className="flex items-center gap-2 opacity-50">
              <FileText className="h-4 w-4" />
              Generate Docs
            </Button>
            <Button
              variant="outline"
              className="flex items-center gap-2"
              onClick={handleDownloadErrorReport}
            >
              <Download className="h-4 w-4" />
              Download error report
            </Button>
          </div>
          <div className="flex flex-wrap justify-center gap-4 opacity-50">
            <Button variant="outline" disabled className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Import Another
            </Button>
            <Button variant="outline" disabled className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Schedule Re-import
            </Button>
          </div>
          <p className="mt-6 text-sm italic">Coming soon</p>
        </div>
      </div>
    </div>
  );
}

