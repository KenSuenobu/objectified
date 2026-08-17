'use client';

/**
 * Home — `/ade/dashboard` (HIVE-4.6, #5300).
 *
 * Mockup: `docs/mockups/home/overview.html`. Design language: `docs/mockups/DESIGN.md` §5.3
 * (page header), §8 (header → stat strip → content), §1 (one obvious next step).
 *
 * ## What was wrong
 *
 * The page was six stat cards and a Recent Activity list — and the activity list sat in the
 * left column of a `lg:grid-cols-2`, so on every screen wider than a tablet **the right half of
 * the page was empty**. A reader arriving at their workspace was told how many versions they
 * had and given nothing to click.
 *
 * ## What it is now
 *
 * The same widgets, plus the work. Reading down: a greeting header with the two actions a
 * reader most often wants, the first-run checklist as the page's one honey card, the six stats,
 * and then a two-column body whose *both* columns are full — "Pick up where you left off" and
 * Recent activity on the left, Quick actions / Needs attention / Publishing pulse on the right.
 *
 * Nothing here is a new data source. The stats and the activity list are the same two calls,
 * unchanged; everything added is assembled by `lib/db/dashboard-home.ts` out of columns other
 * screens already read (`versions.quality_score`, `versions.metadata.sunsetAt`,
 * `versions.published_at`, `api_keys.expires_at`).
 *
 * ## Why the page is still a client component
 *
 * Three of its behaviours are the reader's, not the server's: the checklist's dismissal lives in
 * `localStorage`, the greeting is a function of the reader's own clock (a server-rendered "Good
 * evening" is wrong for half the world), and the loading skeletons the ticket requires exist
 * only if the page renders before its data. So the page loads through server actions and keeps
 * its `isLoading` gate, exactly as it did.
 *
 * The three loads run in one `Promise.all` and share one `finally`: the panels appear together
 * rather than popping in one at a time, which is what a page of skeletons is for.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Upload } from 'lucide-react';
import { useAuthSession } from '@lib/auth/session-client';

import { Button } from '@/app/components/ui/Button';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import PageHeader from '@/app/components/shell/PageHeader';
import { OPEN_ACTIONS, openActionHref } from '@/app/components/shell/openActions';
import { FirstRunChecklist } from '@/app/components/ade/dashboard/FirstRunChecklist';
import { ContinueWorking } from '@/app/components/ade/dashboard/home/ContinueWorking';
import { HomeStatStrip } from '@/app/components/ade/dashboard/home/HomeStatStrip';
import { NeedsAttention } from '@/app/components/ade/dashboard/home/NeedsAttention';
import { PublishingPulse } from '@/app/components/ade/dashboard/home/PublishingPulse';
import { QuickActions } from '@/app/components/ade/dashboard/home/QuickActions';
import { RecentActivity } from '@/app/components/ade/dashboard/home/RecentActivity';
import {
  ACTIVITY_LIMIT,
  EMPTY_STATS,
  workspaceSummarySentence,
  type DashboardStats,
  type RecentActivityRow,
} from '@/app/components/ade/dashboard/home/homeModel';
import { firstNameOf, greetingFor } from '@/app/components/ade/launcher/launcherModel';
import { emptyDashboardHome, type DashboardHome } from '@lib/db/dashboard-home-model';
import { getDashboardHomeForSession } from '@lib/db/dashboard-home';
import { getDashboardStats, getRecentActivity } from '@lib/db/helper';

/** The projects list, which owns both of the header's action dialogs. */
const PROJECTS_HREF = '/ade/dashboard/projects';

/**
 * Parse a server action's JSON payload, falling back rather than throwing.
 *
 * `getDashboardStats` and `getRecentActivity` both return JSON *strings* and both already swallow
 * their own database errors by returning an empty payload — so the only way this can go wrong is
 * a shape the page does not expect, and a page that threw on it would replace a working activity
 * list with a blank screen.
 *
 * The `accepts` predicate is the half that matters: parsing alone is not enough, because valid
 * JSON of the wrong *shape* fails later and further away. An object where the activity list is
 * expected would reach `.map` and throw during render.
 *
 * @param raw The JSON string the action returned.
 * @param accepts Whether the parsed value is the shape this caller asked for.
 * @param fallback What to use when it does not parse, or is not that shape.
 * @returns The parsed value, or `fallback`.
 */
function parsePayload<T>(raw: string, accepts: (value: unknown) => boolean, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return accepts(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Whether a parsed payload is a plain object — the shape `getDashboardStats` returns. */
function isRecord(value: unknown): boolean {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The Home page.
 *
 * @returns The page's header and body.
 */
const Dashboard = () => {
  const { data: session } = useAuthSession();
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
  const [recentActivity, setRecentActivity] = useState<RecentActivityRow[]>([]);
  const [home, setHome] = useState<DashboardHome>(() => emptyDashboardHome());
  const [isLoading, setIsLoading] = useState(true);

  const user = session?.user as { user_id?: string; current_tenant_id?: string } | undefined;
  const userId = user?.user_id;
  const hasTenant = Boolean(user?.current_tenant_id);
  const firstName = firstNameOf(session?.user?.name);

  useEffect(() => {
    const loadDashboardData = async () => {
      if (!userId) return;

      setIsLoading(true);
      try {
        const [statsData, activityData, homeData] = await Promise.all([
          getDashboardStats(userId),
          getRecentActivity(userId, ACTIVITY_LIMIT),
          getDashboardHomeForSession(),
        ]);

        // A partial statistics object is merged over the zero payload rather than replacing it,
        // so a column the server stopped sending reads as 0 instead of as `undefined` — which
        // would render as the text "undefined" in a stat's footnote.
        const parsedStats = parsePayload<Partial<DashboardStats>>(statsData, isRecord, {});
        setStats({ ...EMPTY_STATS, ...parsedStats });
        setRecentActivity(parsePayload<RecentActivityRow[]>(activityData, Array.isArray, []));
        setHome(homeData);
      } catch (error) {
        console.error('Error loading dashboard data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadDashboardData();
  }, [userId]);

  return (
    <Page>
      <PageHeader
        breadcrumb={
          home.workspaceName
            ? [{ label: home.workspaceName, href: '/ade/dashboard' }, { label: 'Home' }]
            : [{ label: 'Home' }]
        }
        title={`${greetingFor()}, ${firstName}`}
        description={workspaceSummarySentence(stats)}
        actions={
          hasTenant ? (
            <>
              <Button variant="outline" kbd="I" asChild>
                <Link href={openActionHref(PROJECTS_HREF, OPEN_ACTIONS.importSpec)}>
                  <Upload aria-hidden />
                  Import a spec
                </Link>
              </Button>
              <Button variant="primary" kbd="N" asChild>
                <Link href={openActionHref(PROJECTS_HREF, OPEN_ACTIONS.newProject)}>
                  <Plus aria-hidden />
                  New project
                </Link>
              </Button>
            </>
          ) : undefined
        }
      />

      <PageBody>
        {/* First-run onboarding checklist (dismissible; completion derived from stats). Gated on
            the load so the checklist never renders against zeroed counts and shows five
            incomplete steps to a reader who has finished them all. */}
        {!isLoading && <FirstRunChecklist stats={stats} />}

        <HomeStatStrip stats={stats} loading={isLoading} />

        <div className="home-grid">
          <div className="home-grid__main">
            <ContinueWorking projects={home.continueProjects} loading={isLoading} />
            <RecentActivity activity={recentActivity} loading={isLoading} />
          </div>

          <aside className="home-grid__aside" aria-label="Workspace shortcuts and health">
            <QuickActions hasTenant={hasTenant} />
            <NeedsAttention items={home.attention} loading={isLoading} />
            <PublishingPulse weeks={home.pulse} loading={isLoading} />
          </aside>
        </div>
      </PageBody>
    </Page>
  );
};

export default Dashboard;
