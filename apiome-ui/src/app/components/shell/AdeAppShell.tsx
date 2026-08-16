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
import { loadTenantMembershipContext } from '@lib/auth/tenant-membership-context';
import AppShell from './AppShell';
import RailFooter from './RailFooter';
import RailWorkspaceLink from './RailWorkspaceLink';

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
 * Everything it loads, it loads the way `TopHeader` did — the header used to make exactly
 * these two calls on exactly these routes, so nothing new is fetched by moving them here:
 *
 * - `getCommercialAccessForSession()` → entitlement-filtered suite destinations, injected
 *   into the model's reserved Build slot (`toPlatformNavInjections`, HIVE-3.2). This
 *   repository still names no commercial route.
 * - `loadTenantMembershipContext()` → the active workspace's display name for the rail's
 *   workspace row. HIVE-3.3 (#5289) needs the whole context for its menu; until then only
 *   the name is read from it.
 *
 * Both failures are non-fatal by design: a rail without suite entries or without a
 * workspace name is still a working rail, and neither is worth a broken page.
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
  const [tenantName, setTenantName] = React.useState<string>('');

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

  // The active workspace's name for the rail's workspace row.
  React.useEffect(() => {
    if (!session?.user || !currentTenantId) {
      setTenantName('');
      return;
    }

    let cancelled = false;
    loadTenantMembershipContext()
      .then(({ tenants }) => {
        if (cancelled) return;
        setTenantName(tenants.find((tenant) => tenant.id === currentTenantId)?.name ?? '');
      })
      .catch((error: unknown) => {
        console.error('Failed to load the active workspace:', error);
        if (!cancelled) setTenantName('');
      });

    return () => {
      cancelled = true;
    };
  }, [session, currentTenantId]);

  const groups = React.useMemo(
    () => getPlatformNavGroups({ currentTenantId, injected }),
    [currentTenantId, injected]
  );

  return (
    <AppShell
      groups={groups}
      pathname={pathname}
      workspace={({ iconRail }) => (
        <RailWorkspaceLink
          tenantName={tenantName}
          tenantId={currentTenantId}
          iconRail={iconRail}
        />
      )}
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
