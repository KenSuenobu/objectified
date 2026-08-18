'use client';

/**
 * The branch-context lineage snippet inside the New version dialog.
 *
 * Re-skinned by HIVE-6.2 (#5313) to `docs/mockups/build/versions.html`'s branch-context card
 * (`.card--soft` with the caps *Branch context* label, the branch chip, the mono
 * `v2.1.0 → v2.2.0 → v2.3.1 (source)` chain and the ASCII graph). What it derives — the chain,
 * the branch names at the tip, the merge parent — is `./version-lineage`, unchanged.
 */

import { GitBranch } from 'lucide-react';
import { Alert } from '@/app/components/ui/Alert';
import { buildLineageSnippet, branchNamesForTip, type VersionLineageInput } from './version-lineage';

export type VersionLineageSnippetProps = {
  /** Selected source revision id (copy-from). */
  sourceVersionId: string;
  versions: VersionLineageInput[];
  versionBranches: Array<{ name: string; tip_version_id: string }>;
  /** When set, shown as primary branch context (not color-only). */
  explicitBranchName?: string | null;
  isLoading?: boolean;
  /** No tenant / empty project */
  permissionDenied?: boolean;
};

export default function VersionLineageSnippet({
  sourceVersionId,
  versions,
  versionBranches,
  explicitBranchName,
  isLoading = false,
  permissionDenied = false,
}: VersionLineageSnippetProps) {
  if (permissionDenied) {
    return (
      <Alert variant="warning" role="status" className="ver-lineage__note">
        You do not have access to load branch metadata for this project. You can still create a
        version if your role allows it.
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <p role="status" className="ver-lineage__loading" aria-live="polite">
        Loading revision context…
      </p>
    );
  }

  const namesAtTip = branchNamesForTip(sourceVersionId, versionBranches);
  const branchLabel =
    explicitBranchName && explicitBranchName.trim().length > 0
      ? explicitBranchName.trim()
      : namesAtTip.length > 0
        ? namesAtTip.join(', ')
        : null;

  const model = buildLineageSnippet(sourceVersionId, versions, {
    branchNamesAtTip: namesAtTip.length > 0 ? namesAtTip : undefined,
  });

  if (!model) {
    return (
      <Alert variant="neutral" role="status" className="ver-lineage__note">
        Revision lineage could not be resolved (missing parent links in this project).
      </Alert>
    );
  }

  return (
    <div className="ver-lineage" aria-labelledby="create-copy-lineage-heading" data-testid="version-lineage-snippet">
      <div className="ver-lineage__head">
        <h3 id="create-copy-lineage-heading" className="ver-lineage__label">
          Branch context
        </h3>
        {branchLabel ? (
          <span className="ver-chip ver-chip--static">
            <GitBranch aria-hidden />
            <span>{branchLabel}</span>
          </span>
        ) : null}
        {branchLabel ? <span className="ver-lineage__hint">branches at this tip</span> : null}
      </div>

      <p className="sr-only">{model.screenSummary}</p>

      <nav aria-label="Source revision chain">
        <ol className="ver-lineage__chain">
          {model.breadcrumbLabels.map((label, i) => (
            <li key={`${model.revisionIds[i]}-${i}`} className="ver-lineage__step">
              {i > 0 ? (
                <span className="ver-lineage__arrow" aria-hidden="true">
                  →
                </span>
              ) : null}
              <span className={i === model.breadcrumbLabels.length - 1 ? 'ver-lineage__cur' : undefined}>
                {label}
                {i === model.breadcrumbLabels.length - 1 ? (
                  <span className="ver-lineage__source"> (source)</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </nav>

      {model.mergeParentLabel ? (
        <p className="ver-lineage__merge">
          <span className="ver-lineage__merge-word">Merge:</span> includes {model.mergeParentLabel}
        </p>
      ) : null}

      {model.asciiLines.length > 0 ? (
        <pre className="ver-lineage__ascii mono" aria-hidden="true">
          {model.asciiLines.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}
