'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitCompareArrows, Loader2, ScrollText } from 'lucide-react';
import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  countsSummary,
  groupChangelogEntries,
  severityBadgeVariant,
  severityLabel,
  type ChangelogSeverity,
  type VersionChangelog,
  type VersionChangelogSummary,
} from '@lib/version-changelog';
import { formatVersionWithPrefix } from '@/app/utils/version-display';

export type VersionChangesVersionRow = {
  id: string;
  project_id: string;
  version_id: string;
  published: boolean;
  published_at: string | null;
};

export type VersionChangesPanelProps = {
  projectId: string;
  versions: VersionChangesVersionRow[];
  /**
   * Open the compare dialog for `(baseRevisionId → headRevisionId)` and scroll
   * the diff to `pointer` (a `ctg.changelog.v1` JSON Pointer).
   */
  onOpenDiff: (baseRevisionId: string, headRevisionId: string, pointer: string) => void;
};

/** Severity count pill row (hides zero counts). */
function SeverityCountBadges({ counts }: { counts: Record<string, number> | null | undefined }) {
  if (!counts) return null;
  const severities: ChangelogSeverity[] = ['breaking', 'non-breaking', 'docs-only'];
  const shown = severities.filter((s) => (counts[s] ?? 0) > 0);
  if (shown.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {shown.map((s) => (
        <Badge key={s} variant={severityBadgeVariant(s)} data-testid={`changes-count-${s}`}>
          {counts[s]} {severityLabel(s).toLowerCase()}
        </Badge>
      ))}
    </span>
  );
}

/**
 * "Changes" main tab on the Versions dashboard (CTG-3.2, #4476).
 *
 * Lists every published revision with its stored classification badge, and
 * renders the selected revision's persisted `ctg.changelog.v1` changelog:
 * severity sections (breaking first), grouped by path, with per-entry deep
 * links into the compare dialog.
 */
export function VersionChangesPanel({ projectId, versions, onOpenDiff }: VersionChangesPanelProps) {
  const published = useMemo(
    () =>
      versions
        .filter((v) => v.published && v.project_id === projectId)
        .sort((a, b) => b.version_id.localeCompare(a.version_id, undefined, { numeric: true })),
    [versions, projectId],
  );

  const [summaries, setSummaries] = useState<VersionChangelogSummary[] | null>(null);
  const [summariesError, setSummariesError] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string>('');
  const [detail, setDetail] = useState<VersionChangelog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (published.length === 0) {
      setRevisionId('');
      return;
    }
    if (!revisionId || !published.some((p) => p.id === revisionId)) {
      setRevisionId(published[0].id);
    }
  }, [published, revisionId]);

  useEffect(() => {
    if (!projectId) {
      setSummaries(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/changelogs`);
        const json = (await res.json()) as {
          success?: boolean;
          error?: string;
          changelogs?: VersionChangelogSummary[];
        };
        if (cancelled) return;
        if (!json.success || !Array.isArray(json.changelogs)) {
          setSummaries(null);
          setSummariesError(typeof json.error === 'string' ? json.error : 'Failed to load changelogs');
          return;
        }
        setSummaries(json.changelogs);
        setSummariesError(null);
      } catch (e) {
        if (!cancelled) {
          setSummaries(null);
          setSummariesError(e instanceof Error ? e.message : 'Failed to load changelogs');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const summaryByRevision = useMemo(() => {
    const map = new Map<string, VersionChangelogSummary>();
    for (const s of summaries ?? []) {
      map.set(s.publishedRevisionId, s);
    }
    return map;
  }, [summaries]);

  const loadDetail = useCallback(async () => {
    if (!revisionId || !projectId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    try {
      const qs = new URLSearchParams({ projectId });
      const res = await fetch(
        `/api/versions/${encodeURIComponent(revisionId)}/changelog?${qs.toString()}`,
      );
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        changelog?: VersionChangelog;
      };
      if (!json.success || !json.changelog) {
        setDetail(null);
        // A 404 means classification is still pending (or predates the backfill);
        // that is a state, not an error banner.
        if (res.status === 404) {
          setDetailError(null);
        } else {
          setDetailError(typeof json.error === 'string' ? json.error : 'Failed to load changelog');
        }
        return;
      }
      setDetail(json.changelog);
    } catch (e) {
      setDetail(null);
      setDetailError(e instanceof Error ? e.message : 'Failed to load changelog');
    } finally {
      setDetailLoading(false);
    }
  }, [revisionId, projectId]);

  useEffect(() => {
    setDetail(null);
    void loadDetail();
  }, [loadDetail]);

  if (published.length === 0) {
    return (
      <EmptyState
        icon={<ScrollText className="h-10 w-10" />}
        title="No Published Versions"
        description="Publish a version to see its classified changelog here."
      />
    );
  }

  const payload = detail?.changelog ?? null;
  const sections = groupChangelogEntries(payload?.entries);
  const selectedSummary = summaryByRevision.get(revisionId) ?? null;

  return (
    <div className={`${dashboardPanelClass} p-4`} data-testid="version-changes-panel">
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Published revision list with severity badges */}
        <div className="lg:w-72 shrink-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden />
            Published versions
          </h3>
          {summariesError ? (
            <Alert variant="error" className="mb-2 text-xs">
              {summariesError}
            </Alert>
          ) : null}
          <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
            {published.map((v) => {
              const s = summaryByRevision.get(v.id);
              const active = v.id === revisionId;
              return (
                <button
                  key={v.id}
                  type="button"
                  data-testid={`changes-version-${v.id}`}
                  aria-pressed={active}
                  onClick={() => setRevisionId(v.id)}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
                    active
                      ? 'bg-indigo-50 dark:bg-indigo-950/40'
                      : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                  }`}
                >
                  <span className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex-1">
                    {formatVersionWithPrefix(v.version_id)}
                  </span>
                  {s?.maxSeverity ? (
                    <Badge variant={severityBadgeVariant(s.maxSeverity)}>
                      {severityLabel(s.maxSeverity)}
                    </Badge>
                  ) : s?.status === 'initial' ? (
                    <Badge variant="secondary">Initial</Badge>
                  ) : s?.status === 'ready' ? (
                    <Badge variant="success">No changes</Badge>
                  ) : s?.status === 'failed' ? (
                    <Badge variant="outline">Failed</Badge>
                  ) : (
                    <Badge variant="outline">Pending</Badge>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Stored changelog for the selected revision */}
        <div className="flex-1 min-w-0" data-testid="changes-detail">
          {detailLoading ? (
            <LoadingState minHeightClassName="min-h-[160px]" message="Loading changelog…" />
          ) : detailError ? (
            <Alert variant="error">{detailError}</Alert>
          ) : !detail ? (
            <p className="text-sm text-gray-600 dark:text-gray-400 py-8 text-center">
              Changelog not available yet — classification runs right after publish.
              {selectedSummary?.status === 'failed'
                ? ' The last classification attempt failed; it is retried on the next publish.'
                : ''}
            </p>
          ) : detail.status === 'failed' ? (
            <Alert variant="error" data-testid="changes-failed">
              Changelog classification failed for this version
              {detail.error ? `: ${detail.error}` : '.'}
            </Alert>
          ) : detail.status === 'initial' || payload?.initialPublication ? (
            <div className="py-8 text-center space-y-2" data-testid="changes-initial">
              <Badge variant="secondary">Initial publication</Badge>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {formatVersionWithPrefix(detail.versionLabel ?? undefined)} is the first published
                version on this line — there is no baseline to compare against.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 pb-3 border-b border-gray-200 dark:border-gray-700">
                <span className="text-sm font-semibold text-gray-900 dark:text-white">
                  {formatVersionWithPrefix(payload?.fromVersion ?? detail.baselineVersionLabel ?? undefined)}
                  {' → '}
                  {formatVersionWithPrefix(payload?.toVersion ?? detail.versionLabel ?? undefined)}
                </span>
                {detail.maxSeverity ? (
                  <Badge variant={severityBadgeVariant(detail.maxSeverity)} data-testid="changes-max-severity">
                    {severityLabel(detail.maxSeverity)}
                  </Badge>
                ) : null}
                <SeverityCountBadges counts={payload?.counts} />
              </div>

              {sections.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400 py-6 text-center" data-testid="changes-empty">
                  No changes detected between these versions.
                </p>
              ) : (
                sections.map((section) => (
                  <section key={section.severity} data-testid={`changes-section-${section.severity}`}>
                    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white mb-2">
                      <Badge variant={severityBadgeVariant(section.severity)}>
                        {severityLabel(section.severity)}
                      </Badge>
                      <span className="text-xs text-gray-500 dark:text-gray-400 font-normal">
                        {section.entries.length} change{section.entries.length === 1 ? '' : 's'}
                      </span>
                    </h4>
                    <div className="space-y-3">
                      {section.groups.map((group) => (
                        <div
                          key={group.pathGroup}
                          className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
                        >
                          <div className="px-3 py-1.5 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
                            <code className="text-xs font-medium text-gray-700 dark:text-gray-300">
                              {group.pathGroup}
                            </code>
                          </div>
                          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                            {group.entries.map((entry, i) => (
                              <li
                                key={`${entry.pointer}-${entry.ruleId}-${i}`}
                                className="px-3 py-2 flex flex-wrap items-start gap-2"
                                data-testid="changes-entry"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm text-gray-900 dark:text-gray-100">
                                    {entry.summary || entry.changeKind || entry.ruleId}
                                    {entry.unclassified ? (
                                      <span className="ml-2 text-2xs uppercase tracking-wide text-amber-700 dark:text-amber-300">
                                        unclassified
                                      </span>
                                    ) : null}
                                  </p>
                                  <code className="text-2xs text-gray-500 dark:text-gray-400 break-all">
                                    {entry.pointer}
                                  </code>
                                </div>
                                {detail.baselineRevisionId ? (
                                  <button
                                    type="button"
                                    data-testid="changes-entry-diff-link"
                                    onClick={() =>
                                      onOpenDiff(
                                        detail.baselineRevisionId as string,
                                        detail.publishedRevisionId,
                                        entry.pointer,
                                      )
                                    }
                                    className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                                    title="Open this change in the diff view"
                                  >
                                    <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />
                                    View in diff
                                  </button>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </section>
                ))
              )}

              {detailLoading ? (
                <p className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Refreshing…
                </p>
              ) : null}
              {countsSummary(payload?.counts) ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Totals: {countsSummary(payload?.counts)}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
