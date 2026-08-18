'use client';

/**
 * The compatibility verdict shared by merge, rollback and publish (#506), re-skinned by
 * HIVE-6.3 (#5314).
 *
 * Authority: `docs/mockups/build/version-dialogs.html` §Merge branches and §Rollback — the
 * intro sentence, the *Overall* verdict, the rule-hit tags, the per-severity finding groups
 * with their `$ref` paths, and the documentation link.
 *
 * The verdict was printed as a bare word in `text-gray-700`; it is a `Badge` now, taking the
 * tone `COMPAT_VERDICT_TONE` assigns so *breaking* reads red on every screen that shows it.
 * The source links were `text-blue-600 dark:text-blue-400` — a hue with no token behind it —
 * and are `.vdlg-link` (`--accent-fg`, which clears 7:1 in all nine appearances).
 */

import React from 'react';
import { Badge } from '../../ui/Badge';
import {
  COMPAT_VERDICT_TONE,
  VERSION_DIALOG_COPY,
  compatVerdict,
} from '../version-dialogs/versionDialogsModel';
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
    <div className={`compat-report-panel vdlg-compat ${className}`}>
      {intro ? <div className="compat-report-intro vdlg-quiet">{intro}</div> : null}
      {overall ? (
        <p className="compat-report-overall vdlg-compat__overall">
          <span className="vdlg-compat__overall-label">Overall:</span>{' '}
          <Badge variant={COMPAT_VERDICT_TONE[compatVerdict(overall)]}>{overall}</Badge>
        </p>
      ) : null}
      {ruleEntries.length > 0 ? (
        <div className="compat-report-rule-hits vdlg-subcard">
          <p className="vdlg-caps">Rule hits</p>
          <ul className="vdlg-compat__rules">
            {ruleEntries.map(([rule, n]) => (
              <li key={rule}>
                <span className="mono">{rule}</span>
                {' × '}
                {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {grouped.length === 0 ? (
        <p className="compat-report-empty vdlg-quiet">{VERSION_DIALOG_COPY.compatNoFindings}</p>
      ) : (
        <div className="compat-report-findings vdlg-compat__findings">
          {grouped.map((section) => (
            <div key={section.severity} className="compat-report-section">
              <p className="vdlg-compat__severity" data-severity={section.severity}>
                {section.label}
              </p>
              <ul className="vdlg-compat__paths">
                {section.paths.map(({ path, findings: pathFindings }) => {
                  const primary = pathFindings[0];
                  const href =
                    sourceHrefForPath?.(path, primary) ??
                    defaultSourceHref(path, primary, currentSearch, sourcePathname);
                  return (
                    <li
                      key={`${section.severity}-${path}`}
                      className="compat-report-path vdlg-compat__path"
                    >
                      <div className="vdlg-compat__path-name mono">
                        {href ? (
                          <a
                            href={href}
                            className="compat-report-path-link vdlg-link"
                            data-testid="compat-source-path-link"
                          >
                            {path}
                          </a>
                        ) : (
                          path
                        )}
                      </div>
                      <ul className="vdlg-compat__messages">
                        {pathFindings.map((f) => (
                          <li key={f.id ?? `${f.path}-${f.rule}-${f.message}`}>
                            <span className="mono">{f.rule}</span>
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
          className="compat-report-doc-link vdlg-link"
        >
          Breaking changes documentation (#746)
        </a>
      ) : null}
    </div>
  );
}
