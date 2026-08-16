'use client';

import { useAuthSession } from '@lib/auth/session-client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Sun, Download, Package, ArrowLeft } from 'lucide-react';
import { Button } from '../../../../components/ui/Button';
import { LoadingState } from '../../../../components/ui/LoadingState';
import { EmptyState, GatedState } from '../../../../components/ui/EmptyState';
import { Badge } from '../../../../components/ui/Badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../components/ui/Select';
import { Alert } from '../../../../components/ui/Alert';
import { MIGRATION_GUIDE_ISSUE_URL } from '../../../../utils/revision-deprecation';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelPaddedClass,
  dashboardTableWrapClass,
  dashboardTableTheadClass,
  dashboardThClass,
  dashboardTbodyClass,
  dashboardTrHoverClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface SunsetEntry {
  revisionId: string;
  projectId: string;
  projectName?: string | null;
  projectSlug?: string | null;
  versionLine: string;
  sunsetDate?: string | null;
  /** Canonical UTC instant (#748); same value as sunsetDate when present */
  sunsetAt?: string | null;
  timelineStatus: string;
  lifecyclePhase: string;
  deprecationMessage?: string | null;
  successorRevisionId?: string | null;
  published: boolean;
  deprecationWarnings: Array<{
    revisionId?: string;
    message?: string;
    migrationGuideUrl?: string;
    sunsetDate?: string | null;
  }>;
}

function statusBadgeClass(timelineStatus: string): string {
  switch (timelineStatus) {
    case 'imminent':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100 border-amber-200 dark:border-amber-700';
    case 'past':
      return 'bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100 border-rose-200 dark:border-rose-700';
    default:
      return 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100 border-slate-200 dark:border-slate-600';
  }
}

function lifecycleLabel(phase: string): string {
  if (phase === 'sunset_reached') return 'Sunset reached (read-only / redirect)';
  return 'Deprecated (migrate before sunset)';
}

export default function SunsetTimelinePage() {
  const { data: session, status } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [entries, setEntries] = useState<SunsetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    const response = await fetch('/api/projects');
    if (!response.ok) return;
    const data = await response.json();
    if (data.projects) setProjects(data.projects);
  }, []);

  const loadTimeline = useCallback(async () => {
    if (!currentTenantId) return;
    setLoading(true);
    setError(null);
    try {
      const qs =
        projectFilter !== 'all' ? `?projectId=${encodeURIComponent(projectFilter)}` : '';
      const res = await fetch(`/api/versions/sunset-timeline${qs}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(typeof data.error === 'string' ? data.error : 'Failed to load timeline');
        setEntries([]);
        return;
      }
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load timeline');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId, projectFilter]);

  useEffect(() => {
    if (currentTenantId) void loadProjects();
  }, [currentTenantId, loadProjects]);

  useEffect(() => {
    if (currentTenantId) void loadTimeline();
  }, [currentTenantId, loadTimeline]);

  const exportCsv = useCallback(() => {
    const headers = [
      'project',
      'versionLine',
      'sunsetDate',
      'timelineStatus',
      'lifecyclePhase',
      'successorRevisionId',
      'deprecationMessage',
    ];
    const lines = [
      headers.join(','),
      ...entries.map((e) =>
        [
          JSON.stringify(e.projectName ?? e.projectSlug ?? e.projectId),
          JSON.stringify(e.versionLine),
          JSON.stringify(e.sunsetDate ?? ''),
          JSON.stringify(e.timelineStatus),
          JSON.stringify(e.lifecyclePhase),
          JSON.stringify(e.successorRevisionId ?? ''),
          JSON.stringify(e.deprecationMessage ?? ''),
        ].join(',')
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sunset-timeline.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [entries]);

  const hasWarnings = useMemo(
    () => entries.some((e) => e.deprecationWarnings && e.deprecationWarnings.length > 0),
    [entries]
  );

  if (status === 'loading') {
    return (
      <div className="p-6">
        <LoadingState minHeightClassName="min-h-[220px]" message="Loading…" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="p-6">
        <p className="text-slate-600 dark:text-slate-400">Sign in to view the sunset timeline.</p>
      </div>
    );
  }

  if (!currentTenantId) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <GatedState description="Deprecation and sunset dates belong to one workspace." />
      </div>
    );
  }

  return (
    <>
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="px-6 py-4">
          <Link
            href="/ade/dashboard/projects"
            className="inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400 hover:underline mb-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Projects
          </Link>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <Sun className="w-6 h-6 text-amber-500" />
                Sunset timeline
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-sm mt-1 max-w-3xl">
                End-of-life schedule for deprecated schema revisions. Dates come from the server (
                <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">versions.metadata</code>
                , #507). Status <span className="font-medium">imminent</span> means sunset within 30 days.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Select value={projectFilter} onValueChange={setProjectFilter}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Filter by project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="secondary"
                onClick={exportCsv}
                disabled={entries.length === 0}
              >
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className={dashboardMainClass}>
        <div className={dashboardContentStackClass}>
      {error && (
        <Alert variant="error">
          {error}
        </Alert>
      )}

      {hasWarnings && (
        <Alert variant="warning">
          <span className="text-sm">
            Rows include the same structured warnings as compatibility checks (#507). Open a revision in Versions to
            see banners in context.
          </span>
        </Alert>
      )}

      {loading ? (
        <div className={dashboardPanelPaddedClass}>
          <LoadingState minHeightClassName="min-h-[240px]" message="Loading schedule…" />
        </div>
      ) : entries.length === 0 ? (
        <div className={dashboardTableWrapClass}>
          <div className="p-8">
            <EmptyState
              icon={<Sun className="h-10 w-10" />}
              title="No deprecation or sunset entries"
              description="Mark revisions as deprecated or set a sunset date on revision metadata to see them here."
              variant="compact"
            />
          </div>
        </div>
      ) : (
        <div className={dashboardTableWrapClass}>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className={dashboardTableTheadClass}>
              <tr>
                <th className={`${dashboardThClass} align-bottom`}>Project</th>
                <th className={`${dashboardThClass} align-bottom`}>Version line</th>
                <th className={`${dashboardThClass} align-bottom`}>Sunset</th>
                <th className={`${dashboardThClass} align-bottom`}>Timeline</th>
                <th className={`${dashboardThClass} align-bottom`}>Lifecycle</th>
                <th className={`${dashboardThClass} align-bottom`}>Successor</th>
                <th className={`${dashboardThClass} min-w-[200px] align-bottom`}>Notes / #507</th>
              </tr>
            </thead>
            <tbody className={dashboardTbodyClass}>
              {entries.map((e) => (
                <tr
                  key={e.revisionId}
                  className={dashboardTrHoverClass}
                >
                  <td className="px-6 py-4 align-top">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4 text-slate-400 flex-shrink-0" />
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {e.projectName ?? e.projectSlug ?? e.projectId}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 align-top font-mono text-xs">{e.versionLine}</td>
                  <td className="px-6 py-4 align-top text-slate-700 dark:text-slate-300">
                    {e.sunsetAt ?? e.sunsetDate ?? '—'}
                  </td>
                  <td className="px-6 py-4 align-top">
                    <Badge variant="outline" className={statusBadgeClass(e.timelineStatus)}>
                      {e.timelineStatus}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 align-top text-slate-700 dark:text-slate-300 max-w-[220px]">
                    {lifecycleLabel(e.lifecyclePhase)}
                  </td>
                  <td className="px-6 py-4 align-top font-mono text-xs break-all">
                    {e.successorRevisionId ?? '—'}
                  </td>
                  <td className="px-6 py-4 align-top text-slate-600 dark:text-slate-400">
                    {e.deprecationWarnings[0]?.message ? (
                      <p className="text-xs leading-relaxed">{e.deprecationWarnings[0].message}</p>
                    ) : e.deprecationMessage ? (
                      <p className="text-xs leading-relaxed">{e.deprecationMessage}</p>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                    <a
                      href={e.deprecationWarnings[0]?.migrationGuideUrl ?? MIGRATION_GUIDE_ISSUE_URL}
                      className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline mt-1 inline-block"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Migration guide
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
        </div>
      </main>
    </>
  );
}
