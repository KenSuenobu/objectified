'use client';

/**
 * Source-format checks strip (CLX-2.4 / #4854).
 *
 * Shows which scanners ran for a catalog revision's source format — native pack,
 * Buf / GraphQL ESLint adapters, etc. Absent scans surface as not_run / unavailable,
 * never as a silent clean score. Unsupported formats can show linked pack issues.
 */

import * as React from 'react';
import { cn } from '@lib/utils';
import {
  capabilityForSourceFormat,
  fetchFormatLintCapabilities,
  fetchLintEvidence,
  outcomeChipClass,
  scannerLabel,
  type FormatLintCapability,
  type LintEvidenceCoverageEntry,
} from '@/app/utils/source-format-checks';

export type SourceFormatChecksPanelProps = {
  projectId: string;
  versionRecordId: string;
  sourceFormat?: string | null;
  className?: string;
};

export function SourceFormatChecksPanel({
  projectId,
  versionRecordId,
  sourceFormat,
  className,
}: SourceFormatChecksPanelProps) {
  const [coverage, setCoverage] = React.useState<LintEvidenceCoverageEntry[] | null>(null);
  const [capability, setCapability] = React.useState<FormatLintCapability | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!projectId || !versionRecordId) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [entries, caps] = await Promise.all([
          fetchLintEvidence(projectId, versionRecordId, { signal: controller.signal }),
          fetchFormatLintCapabilities({ signal: controller.signal }),
        ]);
        if (cancelled) return;
        setCoverage(entries);
        setCapability(capabilityForSourceFormat(caps, sourceFormat));
      } catch (e) {
        if (cancelled || controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Failed to load source-format checks.');
        setCoverage([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [projectId, versionRecordId, sourceFormat]);

  const unsupported = capability?.mode === 'unsupported';

  return (
    <section
      className={cn('space-y-2', className)}
      data-testid="source-format-checks-panel"
      aria-label="Source-format checks"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Source-format checks
        </h3>
        {sourceFormat ? (
          <p className="font-mono text-xs text-gray-500 dark:text-gray-400">{sourceFormat}</p>
        ) : null}
      </div>
      <p className="text-2xs text-gray-500 dark:text-gray-400">
        Scanners expected for this format. Not run / unavailable is never shown as a clean
        score.
      </p>

      {loading ? (
        <p
          data-testid="source-format-checks-loading"
          className="text-sm text-gray-500 dark:text-gray-400"
        >
          Loading checks…
        </p>
      ) : null}

      {error ? (
        <p
          data-testid="source-format-checks-error"
          className="text-sm text-rose-700 dark:text-rose-300"
        >
          {error}
        </p>
      ) : null}

      {unsupported ? (
        <div
          data-testid="source-format-checks-unsupported"
          className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-200"
        >
          <p>
            No format-specific lint pack is registered for{' '}
            <strong className="font-medium">{sourceFormat}</strong>
            {capability?.commonPackOnly ? ' (common pack only)' : ''}.
          </p>
          {capability?.relatedIssues && capability.relatedIssues.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-xs text-gray-600 dark:text-gray-400">
              {capability.relatedIssues.map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                  >
                    Planned pack issue
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {coverage && coverage.length > 0 ? (
        <ul
          className="flex flex-wrap gap-2"
          data-testid="source-format-checks-list"
        >
          {coverage.map((entry) => (
            <li
              key={entry.scannerId}
              data-testid={`source-format-check-${entry.scannerId}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800"
            >
              <span className="font-medium text-gray-800 dark:text-gray-100">
                {scannerLabel(entry.scannerId)}
              </span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide',
                  outcomeChipClass(entry.outcome)
                )}
              >
                {entry.outcome.replace(/_/g, ' ')}
              </span>
              {entry.coverage?.state ? (
                <span className="font-mono text-2xs uppercase text-gray-500 dark:text-gray-400">
                  {String(entry.coverage.state)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {!loading && !error && coverage && coverage.length === 0 && !unsupported ? (
        <p
          data-testid="source-format-checks-empty"
          className="text-sm text-gray-500 dark:text-gray-400"
        >
          No scanner evidence recorded for this revision yet.
        </p>
      ) : null}
    </section>
  );
}
