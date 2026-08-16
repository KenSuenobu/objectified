'use client';

import React from 'react';
import { Bell } from 'lucide-react';

/**
 * The Notifications tab of the preferences pane (HIVE-1.4, #5277; `DESIGN.md` §4.1).
 *
 * The design document specifies four opt-in notifications — email digest, publish/sunset
 * alerts, lint gate failures and key expiry — none of which the platform can deliver yet:
 * unlike everything in Appearance, these are account state that has to be stored and acted
 * on server-side, not a `<html>` attribute.
 *
 * So the tab names what is coming and offers no controls. A switch here that only wrote to
 * `localStorage` would read as "you will be emailed" and would not be true, which is worse
 * than an empty tab — and the tab still has to exist, because the four-tab strip is the
 * shape the pane is specified with.
 */

/** The notifications the design document specifies, in its order. */
const PLANNED_NOTIFICATIONS: readonly string[] = [
  'Email digest of workspace activity',
  'Publish and sunset alerts for versions you own',
  'Lint gate failures on a version you pushed',
  'API key expiry warnings',
];

export default function NotificationsTab() {
  return (
    <div
      data-testid="preferences-notifications"
      className="rounded-md border border-border bg-subtle p-4"
    >
      <div className="flex items-center gap-2">
        <Bell className="h-4 w-4 text-fg-muted" aria-hidden />
        <h3 className="text-sm font-semibold text-fg">Notifications are not available yet</h3>
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        These are account settings rather than device ones, so they arrive with the
        notifications service. Nothing is sent to you in the meantime.
      </p>
      <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-xs text-fg-muted">
        {PLANNED_NOTIFICATIONS.map((notification) => (
          <li key={notification}>{notification}</li>
        ))}
      </ul>
    </div>
  );
}
