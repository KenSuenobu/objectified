'use client';

/**
 * Home's Recent activity list (HIVE-4.6, #5300).
 *
 * Authority: `docs/mockups/home/overview.html` §"Recent activity", whose Notes fix the contract
 * as "10 rows, type icon per project/version/class/property, tenant badge, relative time" —
 * the ticket's first acceptance criterion is that this is preserved exactly.
 *
 * It is the same ten rows from the same `getRecentActivity(userId, 10)`. What changed:
 *
 * - The four type colours were `bg-purple-100 dark:bg-purple-900/30` and three more like them,
 *   inline in the page. They are now tones on `.home-tile`, resolved through the token layer, so
 *   a version reads green in all nine themes instead of in two.
 * - The row is a `<li>` in an `<ol>`. It was a `<div>` per row with a hand-drawn `border-t`
 *   between them; a list of things a reader can scan is a list, and the hairline is the row's
 *   own `border-block-start`, which cannot get out of step with the row count.
 * - The relative time carries the absolute instant as its `title` and `dateTime`
 *   (`DESIGN.md` §10: "relative times with absolute tooltip").
 *
 * Two mockup elements are deliberately not built. The "Mine / Workspace" segmented control is
 * marked *optional* in the mockup's own Notes, and `getRecentActivity` filters by `creator_id`
 * with no workspace-wide counterpart — a tab that cannot change the data would be a control
 * that lies. The "View all activity" footer link has no destination either: the only activity
 * route in the app is the *access* audit, which is a different subject. The footer states the
 * count instead.
 */

import * as React from 'react';

import { Badge } from '@/app/components/ui/Badge';
import { Card, CardFooter, CardHeader } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { PANEL, activityPresentation, formatTimeAgo, type RecentActivityRow } from './homeModel';

/** How many skeleton rows the loading list draws, per the mockup's States note. */
const SKELETON_ROWS = 5;

/** Props for {@link RecentActivity}. */
export interface RecentActivityProps {
  /** The rows, newest first. */
  activity: readonly RecentActivityRow[];
  /** True until the first load resolves. */
  loading: boolean;
}

/** One row's leading tile, tinted by the activity kind. */
function ActivityTile({ tone, icon: Icon }: { tone: string; icon: React.ElementType }) {
  return (
    <span className="home-tile home-tone" data-tone={tone} aria-hidden>
      <Icon />
    </span>
  );
}

/**
 * Draw the panel.
 *
 * @param props See {@link RecentActivityProps}.
 * @returns The card, with rows, five skeleton rows, or the empty state.
 */
export function RecentActivity({ activity, loading }: RecentActivityProps) {
  const Icon = PANEL.activity.icon;

  return (
    <Card className="home-panel" role="group" aria-labelledby="home-activity-title">
      <CardHeader className="home-panel__header">
        <span className="home-panel__title">
          <Icon aria-hidden />
          <h2 id="home-activity-title">{PANEL.activity.title}</h2>
          <span className="home-panel__note">{PANEL.activity.subtitle}</span>
        </span>
      </CardHeader>

      {loading ? (
        <div className="home-rows" aria-hidden>
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div className="home-row" key={index}>
              <Skeleton className="size-7 rounded-sm" />
              <div className="home-row__body">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-2.5 w-2/5" />
              </div>
            </div>
          ))}
        </div>
      ) : activity.length > 0 ? (
        <>
          <ol className="home-rows">
            {activity.map((item) => {
              const kind = activityPresentation(item.type);
              return (
                <li className="home-row" key={item.id} data-activity={item.type}>
                  <ActivityTile tone={kind.tone} icon={kind.icon} />
                  <div className="home-row__body">
                    <p className="home-row__title">
                      {kind.label} <span className="mono">{item.name}</span>
                    </p>
                    <p className="home-row__sub">
                      {item.tenant_name}
                      {' · '}
                      <time dateTime={item.created_at} title={item.created_at}>
                        {formatTimeAgo(item.created_at)}
                      </time>
                    </p>
                  </div>
                  <Badge variant="outline" className="home-row__badge">
                    {kind.badge}
                  </Badge>
                </li>
              );
            })}
          </ol>
          <CardFooter className="home-panel__footer">
            <span>
              Showing {activity.length} {activity.length === 1 ? 'action' : 'actions'}
            </span>
          </CardFooter>
        </>
      ) : (
        <EmptyState
          brand
          variant="compact"
          title="No recent activity"
          description="Start a project to see it here."
        />
      )}
    </Card>
  );
}

export default RecentActivity;
