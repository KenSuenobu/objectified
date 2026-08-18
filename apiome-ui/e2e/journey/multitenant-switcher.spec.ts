/**
 * Multi-tenant switcher & permission-divergence e2e (OLO-6.4, #4221).
 *
 * Drives the seeded multi-tenant fixture (`apiome-db/seed/dev/007_multitenant.sql`) through the
 * real app + REST + Postgres with a mocked OAuth provider: **one user (Grace) in three tenants
 * with diverging roles and license tiers.**
 *
 *   Aurora Labs        -> Owner  · Free      license
 *   Borealis Studio    -> Editor · Paid      license
 *   Cascade Foundation -> Viewer · Sponsor   license
 *
 * It asserts the two user-visible halves of multi-tenant membership:
 *
 *   1. **Switcher rendering + license-tier chips** — the rail's workspace switcher lists all three
 *      memberships, each with its own role badge and its own license chip (Free/Paid/Sponsor).
 *   2. **Permission divergence** — the same user manages members in the tenant they own but not
 *      in the tenant they only view: the members invite form is present in Aurora and absent in
 *      Cascade.
 *
 * Stack contract is identical to the OLO journey (`playwright.journey.config.ts` brings up the
 * mock provider + a dev server; REST + Postgres must already be up). This file is self-contained:
 * it seeds its own fixture and logs in as its own persona, independent of the onboarding journey.
 */
import { test, expect, type Page } from '@playwright/test';
import { setMockPersona, type MockPersona } from './support/mock-oauth';
import { closeDb, seedMultiTenantFixture, MULTITENANT_FIXTURE } from './support/db';

const { user, tenants } = MULTITENANT_FIXTURE;
const OWNER = tenants[0]; // Aurora Labs  — owner  / Free
const VIEWER = tenants[2]; // Cascade Foundation — viewer / Sponsor

/** Grace's identity as the mock GitHub provider asserts it (verified → auto-links to the seed). */
const GRACE_PERSONA: MockPersona = {
  email: user.email,
  name: user.name,
  login: 'grace-hopper',
  // Fixed, distinctive provider id (the ticket number) — unique per provider, collision-free on
  // the fresh CI database; a re-link on local re-runs is a harmless no-op.
  providerUserId: '900000004221',
  verified: true,
};

/**
 * The rail's workspace-switcher trigger (shows the active tenant's name).
 *
 * HIVE-3.3 (#5289) moved the switcher out of the retired top bar and into the rail, and
 * renamed it for the reader: the accessible name now starts with "Switch workspace" and
 * continues with the workspace it is currently in, so the match is a substring.
 */
function switcherButton(page: Page) {
  return page.getByRole('button', { name: /switch workspace/i });
}

/** Open the switcher dropdown and return its menu locator. */
async function openSwitcher(page: Page) {
  await switcherButton(page).click();
  return page.getByRole('menu', { name: 'Your workspaces' });
}

/** The switcher menu item for a tenant, matched by its display name. */
function tenantEntry(page: Page, name: string) {
  return page
    .getByRole('menu', { name: 'Your workspaces' })
    // `menuitemradio`: the switcher is a single-choice list, and the current workspace is
    // the checked one (HIVE-3.3).
    .getByRole('menuitemradio', { name: new RegExp(name) });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await seedMultiTenantFixture();
});

test.afterAll(async () => {
  await closeDb();
});

test.describe('OLO-6.4 — multi-tenant switcher & permission divergence', () => {
  test('logs in as the seeded multi-tenant user', async ({ page }) => {
    await page.context().clearCookies();
    await setMockPersona(GRACE_PERSONA);

    // Verified email matches the seeded verified account → auto-link + sign-in (OLO-1.3),
    // straight to the app (Grace already has tenants, so no onboarding wizard).
    await page.goto('/login');
    await page.getByRole('button', { name: /continue with github/i }).click();
    await page.waitForURL(/\/ade/, { timeout: 60_000 });

    await page.goto('/ade/dashboard');
    // The switcher renders (Grace has memberships) with one of her tenants active.
    await expect(switcherButton(page)).toBeVisible();
  });

  test('switcher lists all three tenants with diverging role badges and license chips', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await setMockPersona(GRACE_PERSONA);
    await page.goto('/login');
    await page.getByRole('button', { name: /continue with github/i }).click();
    await page.waitForURL(/\/ade/, { timeout: 60_000 });
    await page.goto('/ade/dashboard');

    const menu = await openSwitcher(page);

    // All three memberships are listed in one round-trip (no per-tenant follow-up).
    for (const t of tenants) {
      await expect(tenantEntry(page, t.name)).toBeVisible();
    }

    // Each membership carries ITS OWN role badge and ITS OWN license chip — the divergence.
    for (const t of tenants) {
      const entry = tenantEntry(page, t.name);
      await expect(entry.getByTestId('tenant-role-badge')).toHaveText(new RegExp(t.role, 'i'));
      await expect(entry.getByTestId('tenant-license-chip')).toContainText(t.license);
    }

    // The three license tiers are genuinely distinct (Free / Paid / Sponsor), not all defaulted.
    await expect(menu.getByTestId('tenant-license-chip')).toHaveCount(tenants.length);
    for (const label of ['Free', 'Paid', 'Sponsor']) {
      await expect(menu.getByTestId('tenant-license-chip').filter({ hasText: label })).toHaveCount(
        1
      );
    }
  });

  test('permission divergence: member management is allowed in the owned tenant, not the viewed one', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await setMockPersona(GRACE_PERSONA);
    await page.goto('/login');
    await page.getByRole('button', { name: /continue with github/i }).click();
    await page.waitForURL(/\/ade/, { timeout: 60_000 });
    await page.goto('/ade/dashboard');

    /**
     * Activate a tenant from the switcher and wait for the trigger to reflect it. Opening the
     * menu auto-waits for the switcher to finish loading (the trigger is disabled while loading);
     * the currently-active tenant's entry is itself disabled (you cannot switch to where you
     * already are), so when the target is already active we just close the menu.
     */
    const activate = async (name: string) => {
      await openSwitcher(page);
      const entry = tenantEntry(page, name);
      await expect(entry).toBeVisible();
      if (await entry.isDisabled()) {
        await page.keyboard.press('Escape'); // already the active tenant — nothing to switch
        return;
      }
      await entry.click();
      await expect(switcherButton(page)).toContainText(name);
    };

    // As OWNER of Aurora Labs, the members page offers the invite. Since HIVE-5.2 (#5305) the
    // invite is a dialog behind the header's primary rather than a card wedged into the page,
    // so the trigger is what the grant controls and the form is what it opens.
    await activate(OWNER.name);
    await page.goto('/ade/dashboard/members');
    await expect(switcherButton(page)).toContainText(OWNER.name);
    await expect(page.getByTestId('members-invite')).toBeVisible();
    await page.getByTestId('members-invite').click();
    await expect(page.getByTestId('members-invite-form')).toBeVisible();
    await page.keyboard.press('Escape');

    // As VIEWER of Cascade Foundation, the very same page hides member management entirely
    // (the viewer role holds no members:* grants, so the trigger is absent, not merely disabled).
    await activate(VIEWER.name);
    await page.goto('/ade/dashboard/members');
    await expect(switcherButton(page)).toContainText(VIEWER.name);
    await expect(page.getByTestId('members-invite')).toHaveCount(0);
    await expect(page.getByTestId('members-invite-form')).toHaveCount(0);
  });
});
