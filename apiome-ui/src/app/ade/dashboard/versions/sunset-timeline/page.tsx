'use client';

/**
 * Ship → Sunset timeline (HIVE-8.2, #5328).
 *
 * Authority: `docs/mockups/ship/sunset-timeline.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria; DESIGN.md §5.3 (page header), §8 (list page) and §3.1
 * (status vocabulary).
 *
 * ### What this screen is
 *
 * The end-of-life schedule for every deprecated revision in the workspace: what is going
 * away, when, what replaces it, and what a consumer has to do about it. Nothing is *authored*
 * here — a sunset is scheduled from Build → Versions — so the screen has exactly two controls:
 * the project filter and the CSV export.
 *
 * ### What this ticket changed
 *
 * The table and its export are the source of truth and are kept exactly: the same seven
 * columns in the same order, the same seven CSV fields, the same file name. What is *added*
 * is the drawing above them — the one screen in the app where a temporal visualisation is
 * obviously the right answer and was simply absent.
 *
 * The rest is the ordinary Hive migration: the hand-rolled `<header>`/`<main>` pair becomes
 * `Page` + `PageHeader` + `PageBody` (the shell has drawn the chrome since HIVE-3.8), the
 * table becomes `DataTable`, and the Timeline badge stops choosing between three pairs of
 * Tailwind palette strings and reads the shared status vocabulary instead.
 *
 * ### Two things it fixes rather than restyles
 *
 * 1. **A failed read looked like an empty workspace.** The error `Alert` was drawn *above* an
 *    empty-state card that said "No deprecation or sunset entries" — so an outage and a clean
 *    workspace looked nearly the same. The failure is the table's own error state now, with a
 *    retry, and the empty state only draws when the read succeeded.
 * 2. **`imminent` and `past` were amber and rose in one light palette and one dark one.** They
 *    are vocabulary tones now, so they follow all nine themes.
 *
 * ### The one word that is normalised
 *
 * REST calls a non-urgent scheduled sunset `announced`; the mockup, the legend and this
 * screen call it `scheduled`. That rename happens once, in `sunsetTimelineStatus`, and both
 * the badge and the drawing read through it — so the two can never disagree. The **CSV keeps
 * the server's string**, because the export is a contract with whatever consumes it.
 *
 * @see `@/app/components/ade/sunset` — the rules, the drawing and the table.
 */

import * as React from 'react';
import Link from 'next/link';
import { Download, Sunset } from 'lucide-react';

import { useAuthSession } from '@lib/auth/session-client';
import type { ShortcutBinding } from '@lib/shortcuts';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { useShortcuts } from '@/app/hooks/useShortcuts';
import { Alert, AlertDescription } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { DataTableFoot, DataTableToolbar } from '@/app/components/ui/DataTable';
import { EmptyState, GatedState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import {
  ALL_PROJECTS,
  HOME_HREF,
  SUNSET_CSV_FILENAME,
  SUNSET_CSV_HEADERS,
  SUNSET_DESCRIPTION,
  SUNSET_EMPTY,
  SUNSET_LOAD_ERROR,
  SUNSET_NO_TENANT,
  SUNSET_SIGNED_OUT,
  SUNSET_WARNINGS_BANNER,
  SunsetTable,
  SunsetTimelineChart,
  VERSIONS_HREF,
  hasSunsetWarnings,
  sunsetCsv,
  sunsetFootLabel,
  sunsetTimelineLayout,
  type SunsetEntry,
  type SunsetMarker,
  type SunsetProject,
} from '@/app/components/ade/sunset';

/**
 * Render the sunset timeline surface.
 *
 * @returns The page.
 */
export default function SunsetTimelinePage() {
  const { data: session, status } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;

  const [projects, setProjects] = React.useState<SunsetProject[]>([]);
  const [projectFilter, setProjectFilter] = React.useState<string>(ALL_PROJECTS);
  const [entries, setEntries] = React.useState<SunsetEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = React.useState<string | null>(null);

  const filterRef = React.useRef<HTMLButtonElement | null>(null);

  // ---- the reads --------------------------------------------------------------------------

  const loadProjects = React.useCallback(async () => {
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data?.projects)) setProjects(data.projects);
    } catch {
      // The filter is a convenience: a workspace whose project list will not load still gets
      // its whole schedule, which is the thing this screen is for.
    }
  }, []);

  const loadTimeline = React.useCallback(async () => {
    if (!currentTenantId) return;
    setLoading(true);
    setError(null);
    try {
      const qs =
        projectFilter !== ALL_PROJECTS
          ? `?projectId=${encodeURIComponent(projectFilter)}`
          : '';
      const response = await fetch(`/api/versions/sunset-timeline${qs}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(typeof data.error === 'string' ? data.error : SUNSET_LOAD_ERROR);
        setEntries([]);
        return;
      }
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : SUNSET_LOAD_ERROR);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId, projectFilter]);

  React.useEffect(() => {
    if (currentTenantId) void loadProjects();
  }, [currentTenantId, loadProjects]);

  React.useEffect(() => {
    if (currentTenantId) void loadTimeline();
  }, [currentTenantId, loadTimeline]);

  // A row selected from the drawing must not stay selected once the rows change underneath it.
  React.useEffect(() => {
    setSelectedRevisionId((current) =>
      current && entries.some((entry) => entry.revisionId === current) ? current : null
    );
  }, [entries]);

  // ---- the export -------------------------------------------------------------------------

  const exportCsv = React.useCallback(() => {
    const blob = new Blob([sunsetCsv(entries)], { type: 'text/csv;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = SUNSET_CSV_FILENAME;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }, [entries]);

  // ---- the drawing ------------------------------------------------------------------------

  /**
   * The clock the layout is computed against, taken once per set of rows.
   *
   * Read here rather than inside the layout so the geometry stays a pure function of
   * `(rows, now)` — which is what makes every coordinate unit testable.
   */
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNow(Date.now());
  }, [entries]);

  const layout = React.useMemo(
    () => (now === null ? null : sunsetTimelineLayout(entries, now)),
    [entries, now]
  );

  const handleSelectMarker = React.useCallback((marker: SunsetMarker) => {
    setSelectedRevisionId(marker.revisionId);
  }, []);

  // `/` — DESIGN.md §8's list-page key. This list has one control, so `/` reaches it.
  const shortcuts = React.useMemo<readonly ShortcutBinding[]>(
    () =>
      currentTenantId
        ? [
            {
              id: 'sunset-filter',
              scope: 'list',
              description: 'Filter the sunset schedule by project',
              chord: { key: '/' },
              run: () => filterRef.current?.focus(),
            },
          ]
        : [],
    [currentTenantId]
  );
  useShortcuts(shortcuts);

  // ---- the page ---------------------------------------------------------------------------

  if (status === 'loading') {
    return (
      <Page>
        <PageBody>
          <LoadingState minHeightClassName="min-h-[220px]" message="Loading…" />
        </PageBody>
      </Page>
    );
  }

  if (!session) {
    return (
      <Page>
        <PageBody>
          <EmptyState
            variant="compact"
            icon={<Sunset />}
            tone="neutral"
            title={SUNSET_SIGNED_OUT}
          />
        </PageBody>
      </Page>
    );
  }

  const toolbar = (
    <DataTableToolbar data-testid="sunset-toolbar">
      <Select value={projectFilter} onValueChange={setProjectFilter}>
        <SelectTrigger ref={filterRef} className="stl-filter" aria-label="Filter by project">
          <SelectValue placeholder="Filter by project" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </DataTableToolbar>
  );

  const footer = (
    <DataTableFoot data-testid="sunset-foot">
      <span>
        {sunsetFootLabel(entries.length)} · CSV columns: {SUNSET_CSV_HEADERS.join(', ')} →{' '}
        <span className="mono">{SUNSET_CSV_FILENAME}</span>
      </span>
      <span className="stl-foot__hint">
        Schedules are set on <Link href={VERSIONS_HREF}>Versions</Link>
      </span>
    </DataTableFoot>
  );

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: 'Home', href: HOME_HREF }, { label: 'Ship' }, { label: 'Sunset timeline' }]}
        title="Sunset timeline"
        description={SUNSET_DESCRIPTION}
        actions={
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={entries.length === 0}
            data-testid="sunset-export"
          >
            <Download aria-hidden />
            Export CSV
          </Button>
        }
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState
            title={SUNSET_NO_TENANT.title}
            description={SUNSET_NO_TENANT.description}
          />
        ) : (
          <>
            {hasSunsetWarnings(entries) ? (
              <Alert variant="warning" data-testid="sunset-warnings">
                <AlertDescription>
                  {SUNSET_WARNINGS_BANNER.lead}{' '}
                  <Link href={VERSIONS_HREF}>{SUNSET_WARNINGS_BANNER.linkLabel}</Link>{' '}
                  {SUNSET_WARNINGS_BANNER.tail}
                </AlertDescription>
              </Alert>
            ) : null}

            {layout && layout.plotted > 0 ? (
              <SunsetTimelineChart
                layout={layout}
                total={entries.length}
                selectedRevisionId={selectedRevisionId}
                onSelect={handleSelectMarker}
              />
            ) : null}

            <SunsetTable
              entries={entries}
              loading={loading}
              error={error}
              onRetry={() => void loadTimeline()}
              selectedRevisionId={selectedRevisionId}
              toolbar={toolbar}
              footer={footer}
              empty={
                <EmptyState
                  variant="compact"
                  surface={false}
                  icon={<Sunset />}
                  title={SUNSET_EMPTY.title}
                  description={SUNSET_EMPTY.description}
                  action={
                    <Button asChild data-testid="sunset-empty-versions">
                      <Link href={VERSIONS_HREF}>{SUNSET_EMPTY.actionLabel}</Link>
                    </Button>
                  }
                />
              }
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}
