'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { useAuthSession } from '@lib/auth/session-client';
import {
  getPlatformNavGroups,
  platformProfilePath,
  toPlatformNavInjections,
  type PlatformNavInjection,
} from '@lib/platform-nav';
import { getCommercialAccessForSession } from '@lib/db/commercial-access';
import AppShell from './AppShell';
import RailFooter from './RailFooter';
import WorkspaceSwitcher from './WorkspaceSwitcher';

/**
 * The `/ade/dashboard/**` application shell (HIVE-3.1, #5287).
 *
 * {@link AppShell} knows how to draw a rail; this is the component that knows *this*
 * application — who is signed in, which workspace they are in, which commercial
 * destinations their licence entitles them to, and which of the rail's regions have landed
 * yet. Keeping the two apart is what lets the shell be mounted by the admin console
 * (HIVE-9.1) and by a commercial host without either inheriting the dashboard's session
 * plumbing.
 *
 * The one thing it loads, it loads the way `TopHeader` did — the header made exactly this
 * call on exactly these routes, so nothing new is fetched by moving it here:
 *
 * - `getCommercialAccessForSession()` → entitlement-filtered suite destinations, injected
 *   into the model's reserved Build slot (`toPlatformNavInjections`, HIVE-3.2). This
 *   repository still names no commercial route.
 *
 * Failure is non-fatal by design: a rail without suite entries is still a working rail, and
 * it is not worth a broken page.
 *
 * The membership context that names the active workspace is *not* loaded here. HIVE-3.3
 * (#5289) put it inside `WorkspaceSwitcher`, which is the component that needs all of it —
 * rows, roles, licences and the create-workspace cap — rather than the one name this shell
 * used to read out of it.
 */

/** Props for {@link AdeAppShell}. */
export interface AdeAppShellProps {
  /** The dashboard page being rendered. */
  children: React.ReactNode;
}

/**
 * The application shell, wired to the dashboard's session.
 *
 * @param props.children The page.
 * @returns The rail and the page, as one chrome.
 */
export default function AdeAppShell({ children }: AdeAppShellProps) {
  const pathname = usePathname();
  const { data: session } = useAuthSession();

  const user = session?.user as
    | { user_id?: string; id?: string; name?: string | null; email?: string; current_tenant_id?: string }
    | undefined;
  const currentTenantId = user?.current_tenant_id;
  const userId = user?.user_id ?? user?.id;

  const [injected, setInjected] = React.useState<PlatformNavInjection[]>([]);

  // Commercial destinations, if this licence has any. `cancelled` guards the state write:
  // a route change can unmount the shell while the entitlement call is still in flight.
  React.useEffect(() => {
    if (!session?.user) {
      setInjected([]);
      return;
    }

    let cancelled = false;
    getCommercialAccessForSession()
      .then(({ navItems }) => {
        if (!cancelled) setInjected(toPlatformNavInjections(navItems));
      })
      .catch((error: unknown) => {
        console.error('Failed to load commercial nav entitlements:', error);
        if (!cancelled) setInjected([]);
      });

    return () => {
      cancelled = true;
    };
  }, [session]);

  const groups = React.useMemo(
    () => getPlatformNavGroups({ currentTenantId, injected }),
    [currentTenantId, injected]
  );

  return (
    <AppShell
      groups={groups}
      pathname={pathname}
      workspace={({ iconRail }) => <WorkspaceSwitcher iconRail={iconRail} />}
      footer={({ iconRail }) => (
        <RailFooter
          userName={user?.name}
          userEmail={user?.email}
          userId={userId}
          profileHref={platformProfilePath()}
          iconRail={iconRail}
        />
      )}
    >
      {children}
    </AppShell>
  );
}
