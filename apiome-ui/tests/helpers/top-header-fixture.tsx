/**
 * Shared data and render helpers for the `TopHeader` suites.
 *
 * The switcher-behaviour suite (`top-header-tenant-switcher.test.tsx`) and the
 * accessibility suite (`top-header-a11y.test.tsx`) drive the same component with the same
 * membership fixture, so the session, the enriched three-tenant context and the
 * render/open helpers live here.
 *
 * Only data and rendering live here — each suite still declares its own `jest.mock`
 * calls, which Jest hoists per file and cannot be shared from a module.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

import TopHeader, { type TopHeaderTenantContext } from '../../src/app/components/ade/TopHeader';
import type { AppSession } from '@lib/auth/better-auth-session-shape';

/** The tenant the fixture session is already active in. */
export const CURRENT_TENANT_ID = 'tenant-acme';

/** Signed-in user the header renders for. */
export const TOP_HEADER_SESSION = {
  user: {
    user_id: 'user-1',
    name: 'Kenji',
    email: 'kenji@example.com',
    current_tenant_id: CURRENT_TENANT_ID,
  },
} as unknown as AppSession;

/**
 * Enriched three-tenant context: the active tenant, a switchable one, and a suspended
 * membership — one row of each state the switcher styles differently.
 *
 * @param overrides - Fields to replace, e.g. a different create-tenant gate.
 * @returns The context a `loadTenantContext` stub should resolve to.
 */
export function enrichedTenantContext(
  overrides: Partial<TopHeaderTenantContext> = {}
): TopHeaderTenantContext {
  return {
    tenants: [
      {
        id: CURRENT_TENANT_ID,
        name: 'acme-corp',
        slug: 'acme-corp',
        role: 'owner',
        status: 'active',
        licenseName: 'Free',
        licenseType: 'free',
      },
      {
        id: 'tenant-globex',
        name: 'globex',
        slug: 'globex',
        role: 'editor',
        status: 'active',
        licenseName: 'Paid',
        licenseType: 'paid',
      },
      {
        id: 'tenant-initech',
        name: 'initech',
        slug: 'initech',
        role: 'viewer',
        status: 'suspended',
        licenseName: 'Free',
        licenseType: 'free',
      },
    ],
    adminTenantIds: new Set([CURRENT_TENANT_ID]),
    createTenant: { allowed: true, used: 3, max: 5 },
    ...overrides,
  };
}

/**
 * Render the header with an injected session and tenant context.
 *
 * @param context - Tenant context the injected loader resolves to.
 * @param update - Session-update spy; defaults to a no-op.
 * @param session - Session to render for; defaults to {@link TOP_HEADER_SESSION}.
 * @returns The render result plus the two injected doubles.
 */
export function renderTopHeader(
  context: TopHeaderTenantContext,
  update: jest.Mock = jest.fn(async () => null),
  session: AppSession | null = TOP_HEADER_SESSION
) {
  const loadTenantContext = jest.fn(async () => context);
  const view = render(
    <TopHeader
      loadTenantContext={loadTenantContext}
      sessionBridge={{ session, update: update as never }}
    />
  );
  return { view, update, loadTenantContext };
}

/**
 * Wait for the tenant memberships to load, so the switcher trigger is interactive.
 *
 * @returns The switcher trigger button.
 */
export async function findEnabledTenantTrigger(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: 'Switch tenant' });
  await waitFor(() => expect(trigger).toBeEnabled());
  return trigger;
}

/**
 * Open the switcher menu once tenants finish loading.
 *
 * @param user - The `userEvent` session driving the interaction.
 * @returns The opened `role="menu"` element.
 */
export async function openTenantSwitcher(
  user: ReturnType<typeof userEvent.setup>
): Promise<HTMLElement> {
  await user.click(await findEnabledTenantTrigger());
  return screen.getByRole('menu', { name: 'Your tenants' });
}
