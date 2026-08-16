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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
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
            ? 'bg-green-100 dark:bg-green-900/30' 
            : isFailed 
            ? 'bg-red-100 dark:bg-red-900/30'
            : isRolledBack
            ? 'bg-gray-100 dark:bg-gray-800'
            : 'bg-yellow-100 dark:bg-yellow-900/30'
        }`}>
          {isSuccess ? (
            <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-400" />
          ) : isFailed ? (
            <XCircle className="h-10 w-10 text-red-600 dark:text-red-400" />
          ) : isRolledBack ? (
            <Undo2 className="h-10 w-10 text-gray-600 dark:text-gray-400" />
          ) : (
            <AlertTriangle className="h-10 w-10 text-yellow-600 dark:text-yellow-400" />
          )}
        </div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          {isDryRun ? 'Dry run complete' : isSuccess ? 'Import Complete!' : isFailed ? 'Import Failed' : isRolledBack ? 'Import Rolled Back' : 'Import Canceled'}
        </h2>
        {isDryRun && (
          <p className="text-gray-600 dark:text-gray-400 mt-2 text-center max-w-md">
            No project or data was created. To import for real, go back and run again with &quot;Dry run (preview only)&quot; unchecked.
          </p>
        )}
        {isIncremental && (summary?.failed ?? 0) > 0 && (
          <p className="text-gray-600 dark:text-gray-400 mt-2 text-center max-w-md">
            {summary?.success ?? 0} class(es) imported; {summary?.failed ?? 0} skipped due to errors.
          </p>
        )}
        {isRolledBack && (
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            The completed import was undone. The created project and all imported data have been removed.
          </p>
        )}
        {!isSuccess && !isRolledBack && !isDryRun && (
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            {isFailed
              ? 'There was an error during the import process.'
              : 'The import was canceled before completion.'}
          </p>
        )}
      </div>

      {/* Import Summary */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Import Summary</h3>
          {isDryRun && (
            <Badge variant="secondary" className="text-xs">Preview only</Badge>
          )}
          {isIncremental && (
            <Badge variant="secondary" className="text-xs">Incremental</Badge>
          )}
        </div>

        {/* Imported Counts */}
        <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-3">
          <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 text-center border border-green-200 dark:border-green-800">
            <div className="text-3xl font-bold text-green-600 dark:text-green-400">
              {(summary?.success || 0).toLocaleString()}
            </div>
            <div className="text-sm text-green-700 dark:text-green-300 flex items-center justify-center gap-1 mt-1">
              <CheckCircle2 className="h-4 w-4" />
              Classes imported
            </div>
          </div>
          <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-lg p-4 text-center border border-indigo-200 dark:border-indigo-800">
            <div className="text-3xl font-bold text-indigo-600 dark:text-indigo-400">
              {(summary?.properties || 0).toLocaleString()}
            </div>
            <div className="text-sm text-indigo-700 dark:text-indigo-300 flex items-center justify-center gap-1 mt-1">
              <FileText className="h-4 w-4" />
              Properties imported
            </div>
          </div>
          <div className="bg-sky-50 dark:bg-sky-900/20 rounded-lg p-4 text-center border border-sky-200 dark:border-sky-800">
            <div className="text-3xl font-bold text-sky-600 dark:text-sky-400">
              {(summary?.paths || 0).toLocaleString()}
            </div>
            <div className="text-sm text-sky-700 dark:text-sky-300 flex items-center justify-center gap-1 mt-1">
              <Plus className="h-4 w-4" />
              Paths imported
            </div>
          </div>
        </div>

        {/* Import Health */}
        <div className="grid grid-cols-1 gap-4 mb-6 sm:grid-cols-2">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4 text-center border border-yellow-200 dark:border-yellow-800">
            <div className="text-3xl font-bold text-yellow-600 dark:text-yellow-400">
              {(summary?.warnings || 0).toLocaleString()}
            </div>
            <div className="text-sm text-yellow-700 dark:text-yellow-300 flex items-center justify-center gap-1 mt-1">
              <AlertTriangle className="h-4 w-4" />
              Warning
            </div>
          </div>
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 text-center border border-red-200 dark:border-red-800">
            <div className="text-3xl font-bold text-red-600 dark:text-red-400">
              {(summary?.failed || 0).toLocaleString()}
            </div>
            <div className="text-sm text-red-700 dark:text-red-300 flex items-center justify-center gap-1 mt-1">
              <XCircle className="h-4 w-4" />
              Failed
            </div>
          </div>
        </div>

        {/* Verification Status */}
        {summary?.verification && (
          <div className={`rounded-lg p-4 mb-6 border ${
            summary.verification.passed 
              ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
          }`}>
            <div className="flex items-center gap-3 mb-2">
              {summary.verification.passed ? (
                <ShieldCheck className="h-6 w-6 text-green-600 dark:text-green-400" />
              ) : (
                <ShieldX className="h-6 w-6 text-red-600 dark:text-red-400" />
              )}
              <div className={`font-semibold ${
                summary.verification.passed 
                  ? 'text-green-900 dark:text-green-200'
                  : 'text-red-900 dark:text-red-200'
              }`}>
                {summary.verification.passed ? 'Import Verification Passed' : 'Import Verification Failed'}
              </div>
            </div>
            <div className={`text-sm ${
              summary.verification.passed 
                ? 'text-green-700 dark:text-green-300'
                : 'text-red-700 dark:text-red-300'
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
                    <div key={idx} className="pl-4 border-l-2 border-red-300 dark:border-red-700 text-xs">
                      <div className="font-medium">{mismatch.className}{mismatch.propertyName ? `.${mismatch.propertyName}` : ''}</div>
                      <div className="text-red-600 dark:text-red-400">{mismatch.message}</div>
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

        {/* Metadata */}
        <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-700 dark:text-gray-300">Total time:</span>
            <span>{formatDuration(summary?.totalTime)}</span>
          </div>
          {summary?.sourceName && (
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-700 dark:text-gray-300">Source:</span>
              <span>{summary.sourceName}</span>
            </div>
          )}
          {(summary?.projectName || summary?.versionId) && (
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-700 dark:text-gray-300">Target:</span>
              <span>
                {summary.projectName || 'Project'} / {summary.versionId || 'Version'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Failure details — the same errors/warnings carried in the downloadable report */}
      {report && (report.errorsAndWarnings.length > 0 || report.failedClasses.length > 0) && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-red-200 dark:border-red-800 p-6">
          <div className="flex items-center gap-2 mb-4">
            <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Failure details</h3>
          </div>

          {report.failedClasses.length > 0 && (
            <div className="mb-4">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
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
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
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
                            ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20'
                            : 'border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {isError ? (
                            <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
                          ) : (
                            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={isError ? 'error' : 'warning'} className="text-2xs uppercase">
                                {entry.level}
                              </Badge>
                              <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{entry.code}</span>
                            </div>
                            <p
                              className={`mt-1 text-sm break-words ${
                                isError
                                  ? 'text-red-800 dark:text-red-200'
                                  : 'text-yellow-800 dark:text-yellow-200'
                              }`}
                            >
                              {entry.message}
                            </p>
                            {entry.context != null && (
                              <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-100 dark:bg-gray-900 p-2 text-2xs text-gray-700 dark:text-gray-300">
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
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Imported Schemas</h3>
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
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 flex items-center gap-3">
          <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
          <p className="text-sm text-red-800 dark:text-red-200">{rollbackError}</p>
        </div>
      )}

      {/* Next Actions */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Next Actions</h3>
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          {isDryRun && (
            <p className="text-sm text-sky-700 dark:text-sky-300 mb-4">
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
                className="flex items-center gap-2 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20"
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

