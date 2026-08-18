'use client';

import React from 'react';
import { Alert } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { COMPAT_VERDICT_TONE, compatVerdict } from '../version-dialogs/versionDialogsModel';
import { buildCompatibilitySourceHref } from '@lib/compatibility-source-link';

type EvidenceFinding = {
  ruleId?: string;
  rule_id?: string;
  message?: string;
  changeClass?: string;
  change_class?: string;
  severity?: string;
  location?: {
    path?: string;
    startLine?: number;
    start_line?: number;
    apiPath?: string;
    operation?: string;
  };
};

type EvidenceRun = {
  id?: string;
  scannerId?: string;
  outcome?: string;
  findings?: EvidenceFinding[];
  coverage?: {
    changelogMarkdown?: string;
    baseRevisionId?: string;
    headRevisionId?: string;
  };
};

export type ExternalCompatEvidencePanelProps = {
  projectId: string;
  baseRevisionId?: string | null;
  headRevisionId?: string | null;
  currentSearch?: string;
  sourcePathname?: string;
  className?: string;
};

/**
 * Compact oasdiff evidence list with source-path links (CLX-2.3 / #4853).
 * Runs evidence when a base/head pair is provided; otherwise lists stored runs for head.
 */
export function ExternalCompatEvidencePanel({
  projectId,
  baseRevisionId,
  headRevisionId,
  currentSearch,
  sourcePathname,
  className = '',
}: ExternalCompatEvidencePanelProps) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [findings, setFindings] = React.useState<EvidenceFinding[]>([]);
  const [changelog, setChangelog] = React.useState<string | null>(null);
  const [overall, setOverall] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!projectId || !headRevisionId) {
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        if (baseRevisionId) {
          const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/compatibility/evidence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              baseRevisionId,
              headRevisionId,
            }),
          });
          if (!res.ok) {
            throw new Error(`Evidence request failed (${res.status})`);
          }
          const data = await res.json();
          if (cancelled) return;
          setFindings(Array.isArray(data.findings) ? data.findings : []);
          setChangelog(
            typeof data.changelogMarkdown === 'string' ? data.changelogMarkdown : null
          );
          setOverall(typeof data.overall === 'string' ? data.overall : null);
        } else {
          const res = await fetch(
            `/api/projects/${encodeURIComponent(projectId)}/compatibility/evidence?versionId=${encodeURIComponent(headRevisionId)}`
          );
          if (!res.ok) {
            throw new Error(`Evidence list failed (${res.status})`);
          }
          const data = await res.json();
          if (cancelled) return;
          const runs: EvidenceRun[] = Array.isArray(data.runs) ? data.runs : [];
          const latest = runs[0];
          setFindings(latest?.findings || []);
          setChangelog(latest?.coverage?.changelogMarkdown || null);
          setOverall(latest?.outcome || null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load evidence');
          setFindings([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [projectId, baseRevisionId, headRevisionId]);

  if (!headRevisionId) {
    return null;
  }

  return (
    <div
      className={`external-compat-evidence vdlg-evidence ${className}`}
      data-testid="external-compat-evidence"
    >
      <p className="vdlg-evidence__title">
        External compatibility evidence (oasdiff)
        {overall ? (
          <Badge variant={COMPAT_VERDICT_TONE[compatVerdict(overall)]}>{overall}</Badge>
        ) : null}
      </p>
      {loading ? <p className="vdlg-quiet">Loading independent evidence…</p> : null}
      {error ? <Alert variant="warn">{error}</Alert> : null}
      {!loading && !error && findings.length === 0 ? (
        <p className="vdlg-quiet">No oasdiff findings for this pair.</p>
      ) : null}
      {findings.length > 0 ? (
        <ul className="vdlg-evidence__list">
          {findings.map((f, idx) => {
            const rule = f.ruleId || f.rule_id || 'unknown';
            const changeClass = f.changeClass || f.change_class || f.severity || '';
            const loc = f.location || {};
            const path = loc.path || loc.apiPath || '(document)';
            const line = loc.startLine ?? loc.start_line ?? null;
            const href = buildCompatibilitySourceHref({
              path,
              line: typeof line === 'number' ? line : null,
              currentSearch,
              pathname: sourcePathname,
            });
            return (
              <li
                key={`${rule}-${path}-${idx}`}
                className="vdlg-evidence__item"
              >
                <a
                  href={href}
                  className="vdlg-link mono"
                  data-testid="external-compat-source-link"
                >
                  {path}
                  {typeof line === 'number' ? `:${line}` : ''}
                </a>
                <div className="vdlg-quiet">
                  <span className="mono">[{changeClass}] {rule}</span>
                  {' — '}
                  {f.message}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {changelog ? (
        <details className="external-compat-changelog vdlg-evidence__changelog">
          <summary>Changelog (markdown)</summary>
          <pre className="vdlg-evidence__pre">
            {changelog}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
