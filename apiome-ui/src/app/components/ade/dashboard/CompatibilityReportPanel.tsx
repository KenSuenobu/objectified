'use client';

import React from 'react';
import {
  groupCompatibilityFindings,
  type CompatibilityFindingRow,
} from '@lib/compatibility-report-group';
import { buildCompatibilitySourceHref } from '@lib/compatibility-source-link';

export type CompatibilityReportPanelProps = {
  overall?: string;
  findings: CompatibilityFindingRow[];
  ruleHits?: Record<string, number> | null;
  docUrl?: string | null;
  intro?: React.ReactNode;
  className?: string;
  /**
   * Optional builder for per-path source links. When omitted, links use the current
   * query string with ``sourcePath`` / ``line`` (CLX-2.3).
   */
  sourceHrefForPath?: (path: string, finding: CompatibilityFindingRow) => string | null;
  /** Preserve existing search params when building default source links. */
  currentSearch?: string;
  /** Pathname prefix for default source links (e.g. catalog detail URL). */
  sourcePathname?: string;
};

function defaultSourceHref(
  path: string,
  finding: CompatibilityFindingRow,
  currentSearch?: string,
  sourcePathname?: string,
): string {
  const line =
    typeof (finding as { startLine?: number }).startLine === 'number'
      ? (finding as { startLine?: number }).startLine
      : null;
  return buildCompatibilitySourceHref({
    path,
    line,
    currentSearch,
    pathname: sourcePathname,
  });
}

export function CompatibilityReportPanel({
  overall,
  findings,
  ruleHits,
  docUrl,
  intro,
  className = '',
  sourceHrefForPath,
  currentSearch,
  sourcePathname,
}: CompatibilityReportPanelProps) {
  const grouped = React.useMemo(() => groupCompatibilityFindings(findings), [findings]);
  const ruleEntries = React.useMemo(() => {
    if (!ruleHits || typeof ruleHits !== 'object') {
      return [];
    }
    return Object.entries(ruleHits).sort(([a], [b]) => a.localeCompare(b));
  }, [ruleHits]);

  return (
    <div className={`compat-report-panel space-y-3 text-xs ${className}`}>
      {intro ? <div className="compat-report-intro text-gray-600 dark:text-gray-400">{intro}</div> : null}
      {overall ? (
        <p className="compat-report-overall text-gray-700 dark:text-gray-300">
          <span className="font-medium">Overall:</span> {overall}
        </p>
      ) : null}
      {ruleEntries.length > 0 ? (
        <div className="compat-report-rule-hits rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-2 py-1.5">
          <p className="font-medium text-gray-800 dark:text-gray-200 mb-1">Rule hits</p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-2xs text-gray-600 dark:text-gray-400">
            {ruleEntries.map(([rule, n]) => (
              <li key={rule}>
                <span className="text-gray-800 dark:text-gray-200">{rule}</span>
                {' × '}
                {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {grouped.length === 0 ? (
        <p className="compat-report-empty text-gray-500 dark:text-gray-400">
          No structural findings in this report.
        </p>
      ) : (
        <div className="compat-report-findings space-y-3 max-h-64 overflow-y-auto pr-1">
          {grouped.map((section) => (
            <div key={section.severity} className="compat-report-section">
              <p className="font-medium text-gray-800 dark:text-gray-200 mb-1">{section.label}</p>
              <ul className="space-y-2 pl-0 list-none">
                {section.paths.map(({ path, findings: pathFindings }) => {
                  const primary = pathFindings[0];
                  const href =
                    sourceHrefForPath?.(path, primary) ??
                    defaultSourceHref(path, primary, currentSearch, sourcePathname);
                  return (
                    <li
                      key={`${section.severity}-${path}`}
                      className="compat-report-path border-l-2 border-gray-200 dark:border-gray-600 pl-2"
                    >
                      <div className="font-mono text-2xs text-gray-700 dark:text-gray-300 break-all">
                        {href ? (
                          <a
                            href={href}
                            className="compat-report-path-link text-blue-600 dark:text-blue-400 underline underline-offset-2 hover:text-blue-700 dark:hover:text-blue-300"
                            data-testid="compat-source-path-link"
                          >
                            {path}
                          </a>
                        ) : (
                          path
                        )}
                      </div>
                      <ul className="mt-0.5 space-y-0.5 list-disc pl-4 text-gray-600 dark:text-gray-400">
                        {pathFindings.map((f) => (
                          <li key={f.id ?? `${f.path}-${f.rule}-${f.message}`}>
                            <span className="font-mono text-2xs text-gray-500 dark:text-gray-500">
                              {f.rule}
                            </span>
                            {' — '}
                            {f.message}
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {docUrl ? (
        <a
          href={docUrl}
          target="_blank"
          rel="noreferrer"
          className="compat-report-doc-link text-xs underline inline-block text-blue-600 dark:text-blue-400"
        >
          Breaking changes documentation (#746)
        </a>
      ) : null}
    </div>
  );
}
