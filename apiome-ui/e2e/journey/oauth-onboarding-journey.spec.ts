/**
 * OLO end-to-end journey — the MVP acceptance gate for the OAuth Login & Onboarding roadmap
 * (#4184 / epic #4222), rebuilt on **Better Auth** for OLO-10.13 (#5008).
 *
 * The dedicated UI dev server boots on Better Auth (the only engine since the OLO-10.14 cutover), so
 * this whole story exercises the migrated engine end to end. It covers the full auth regression the ticket
 * requires — **credentials, all four providers (github/gitlab/azure/google), linking, and 2FA**:
 *
 *   1. New user signs up via mocked **GitHub** → OAuth signup wizard → first tenant
 *      provisioned with the Free plan (completes via the one-time-code sign-in, now bridged to
 *      Better Auth — OLO-10.13).
 *   2. The same email arrives via mocked **GitLab** → auto-links to the existing account,
 *      never duplicates (asserted at the storage layer).
 *   3. Unverified emails from three providers are rejected with the stable `unverified-email` code.
 *   4. A verified zero-tenant user arrives via mocked **Microsoft (Entra ID)** → the
 *      first-tenant onboarding wizard runs in place: slug availability, Free-license
 *      summary, provision, dashboard.
 *   5. Member invites succeed up to the Free-tier seat limit (5) and the structured
 *      `license-seats-exhausted` refusal surfaces in the members UI.
 *   6. A two-tenant user switches tenants from the header switcher, and the choice
 *      survives a reload (durable last-active tenant).
 *   7. Mocked **Google** (the fourth provider) auto-links to the existing account.
 *   8. A seeded **credentials** user signs in through the login page's email/password form.
 *   9. **2FA enroll** — TOTP enable + verify turns 2FA on for that user.
 *  10. **2FA login with a TOTP code** — password sign-in is withheld pending the second factor,
 *      which a generated TOTP code satisfies.
 *  11. **2FA login with a backup code** — a backup code satisfies the second factor.
 *
 * Stack contract: REST + Postgres must already be up (`docker compose up --wait`), with the V201
 * `two_factor` migration applied; the mock provider server and the dedicated UI dev server are
 * started by `playwright.journey.config.ts`. See `e2e/journey/README.md`.
 */
import { test, expect, type APIResponse, type Page } from '@playwright/test';
import { setMockPersona, type MockPersona } from './support/mock-oauth';
import {
  closeDb,
  countUsersByEmail,
  getTwoFactorState,
  listLinkedProviders,
  seedCredentialUser,
  seedVerifiedUser,
} from './support/db';
import { generateTotp, parseTotpSecret } from './support/totp';
import { BASE_URL } from './support/env';

/** Unique-per-run suffix so repeated runs never collide on emails, slugs, or ids. */
const RUN = Date.now().toString(36);
/** Base for numeric provider-side user ids, unique per run. */
const ID_BASE = Date.now() % 1_000_000_000;

/** Persona factory: one identity as asserted by one provider. */
function persona(overrides: Partial<MockPersona> & { idOffset: number }): MockPersona {
  const { idOffset, ...rest } = overrides;
  return {
    email: `journey.${RUN}@example.test`,
    name: 'Journey User',
    login: `journey-${RUN}`,
    providerUserId: String(ID_BASE + idOffset),
    verified: true,
    ...rest,
  };
}

const RILEY_EMAIL = `riley.${RUN}@example.test`;
const WREN_EMAIL = `wren.${RUN}@example.test`;
const UMA_EMAIL = `uma.${RUN}@example.test`;

const RILEY_ORG = `Riley Org ${RUN}`;
const WREN_ORG = `Wren Works ${RUN}`;

/** Button label per provider on the login page (provider registry display names). */
const PROVIDER_BUTTONS = {
  github: /continue with github/i,
  gitlab: /continue with gitlab/i,
  azure: /continue with microsoft/i,
  google: /continue with google/i,
} as const;

/** Credentials + 2FA user (OLO-10.13): email/password sign-in and the TOTP/backup-code journeys. */
const CRED_EMAIL = `cred.${RUN}@example.test`;
const CRED_PASSWORD = 'Journey-Passw0rd!';

/** TOTP secret + backup codes captured at enrollment (test 9), reused by the login legs (tests 10–11). */
let tfaSecret = '';
let tfaBackupCodes: string[] = [];

/** Better Auth API endpoints the 2FA legs drive directly (no 2FA UX exists yet — foundation only). */
const AUTH_API = {
  signInEmail: '/api/auth/sign-in/email',
  twoFactorEnable: '/api/auth/two-factor/enable',
  twoFactorVerifyTotp: '/api/auth/two-factor/verify-totp',
  twoFactorVerifyBackupCode: '/api/auth/two-factor/verify-backup-code',
} as const;

/**
 * POST a Better Auth API endpoint from the browser context (so it carries the context's session
 * cookies), with the trusted `Origin` the engine's CSRF check requires. Used by the 2FA legs, which
 * have no UI to drive.
 */
function postAuthApi(page: Page, path: string, data: Record<string, unknown>): Promise<APIResponse> {
  return page.request.post(path, { headers: { Origin: BASE_URL }, data });
}

/** Assert a Better Auth API response is 2xx, surfacing the status + body on failure for diagnosis. */
async function expectAuthOk(response: APIResponse, label: string): Promise<void> {
  expect(response.ok(), `${label} failed: HTTP ${response.status()} — ${await response.text()}`).toBe(
    true
  );
}

type ProviderId = keyof typeof PROVIDER_BUTTONS;

/**
 * Start an OAuth login from the login page: navigate there and click the provider's SSO
 * button. The mock provider redirects straight back, so callers just wait for the
 * outcome URL they expect.
 */
async function startLogin(page: Page, provider: ProviderId): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: PROVIDER_BUTTONS[provider] }).click();
}

/** The header tenant-switcher trigger (shows the active tenant's name). */
function switcherButton(page: Page) {
  return page.getByRole('button', { name: 'Switch tenant' });
}

/**
 * Navigate to the dashboard shell, where the TopHeader (and its tenant switcher)
 * renders — `/ade` itself is the application launcher without the header.
 */
async function gotoDashboard(page: Page): Promise<void> {
  await page.goto('/ade/dashboard');
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await closeDb();
});

test.describe('OLO journey — login, invariants, onboarding, license, switcher', () => {
  test('1. new GitHub user completes signup and gets a Free-plan first tenant', async ({
    page,
  }) => {
    await setMockPersona(
      persona({ idOffset: 1, email: RILEY_EMAIL, name: 'Riley Journey', login: `riley-${RUN}` })
    );

    await startLogin(page, 'github');

    // A verified email with no account routes to the OAuth signup wizard (OLO-1.3 rule c).
    await page.waitForURL(/\/signup\/oauth\?token=/);
    // The signup page shows a privacy-masked hint of the provider email (r***o@…).
    await expect(page.getByText(/r\*+y@example\.test|@example\.test/)).toBeVisible();
    // The Free plan is disclosed before the account is created.
    await expect(page.getByText('Free plan')).toBeVisible();

    await page.locator('#displayName').fill('Riley Journey');
    await page.locator('#orgName').fill(RILEY_ORG);
    // Slug auto-derives from the organization name; keep it.
    await expect(page.locator('#slug')).toHaveValue(`riley-org-${RUN}`);
    await page.getByRole('button', { name: 'Create account' }).click();

    // Signup ends in a one-time-code sign-in that lands in the app.
    await page.waitForURL(/\/ade/, { timeout: 60_000 });
    await gotoDashboard(page);
    await expect(switcherButton(page)).toContainText(RILEY_ORG);

    // The tenant switcher shows the Free license chip for the new tenant (OLO-5.x).
    await switcherButton(page).click();
    const menu = page.getByRole('menu', { name: 'Your tenants' });
    const rileyEntry = menu.getByRole('menuitem', { name: new RegExp(RILEY_ORG) });
    await expect(rileyEntry.getByTestId('tenant-license-chip')).toContainText('Free');
  });

  test('2. same email via GitLab auto-links — no duplicate account', async ({ page }) => {
    await setMockPersona(
      persona({ idOffset: 2, email: RILEY_EMAIL, name: 'Riley Journey', login: `riley-${RUN}` })
    );

    await startLogin(page, 'gitlab');

    // Straight into the app as the existing account — no signup wizard.
    await page.waitForURL(/\/ade/, { timeout: 60_000 });
    await gotoDashboard(page);
    await expect(switcherButton(page)).toContainText(RILEY_ORG);

    // Storage-layer invariants (OLO-1.3): one user row, both identities linked to it.
    expect(await countUsersByEmail(RILEY_EMAIL)).toBe(1);
    expect(await listLinkedProviders(RILEY_EMAIL)).toEqual(['github', 'gitlab']);
  });

  test('3. unverified emails are rejected by every provider with unverified-email', async ({
    page,
  }) => {
    const providers: ProviderId[] = ['github', 'gitlab', 'azure'];
    for (const [index, provider] of providers.entries()) {
      await page.context().clearCookies();
      await setMockPersona(
        persona({
          idOffset: 11 + index,
          email: UMA_EMAIL,
          name: 'Uma Unverified',
          login: `uma-${RUN}`,
          verified: false,
        })
      );

      await startLogin(page, provider);

      // Structured rejection (OLO-1.5): stable code in the URL, guidance in the banner.
      await page.waitForURL(/\/login\?.*error=unverified-email/, { timeout: 60_000 });
      await expect(page.getByTestId('login-banner')).toContainText(/verified/i);
    }

    // Rejection means rejection: no account was ever created for the address.
    expect(await countUsersByEmail(UMA_EMAIL)).toBe(0);
  });

  test('4. zero-tenant Microsoft login walks the first-tenant onboarding wizard', async ({
    page,
  }) => {
    // A verified user with zero tenant memberships (offboarded/administrative state —
    // no signup path produces it, so it is seeded directly).
    await seedVerifiedUser(WREN_EMAIL, 'Wren Journey');

    await page.context().clearCookies();
    await setMockPersona(
      persona({ idOffset: 21, email: WREN_EMAIL, name: 'Wren Journey', login: `wren-${RUN}` })
    );

    await startLogin(page, 'azure');

    // Verified email matches the seeded account → auto-link + sign-in; the onboarding
    // guard swaps the dashboard for the wizard in place (OLO-3.3 / OLO-4.1).
    await page.waitForURL(/\/ade/, { timeout: 60_000 });
    await expect(page.getByTestId('first-tenant-onboarding-wizard')).toBeVisible();

    await page.getByRole('button', { name: 'Set up your organization' }).click();
    await expect(page.getByTestId('onboarding-step-organization')).toBeVisible();
    await page.locator('input[name="organization-name"]').fill(WREN_ORG);
    // Live slug availability (OLO-4.2) confirms the auto-suggested slug.
    await expect(page.getByTestId('slug-availability')).toContainText(/available/i);
    await page.getByRole('button', { name: 'Continue' }).click();

    // The Free license is disclosed on the summary before provisioning (OLO-4.1/5.x).
    await expect(page.getByTestId('onboarding-step-summary')).toBeVisible();
    await expect(page.getByTestId('free-license-summary')).toBeVisible();
    await page.getByRole('button', { name: 'Create organization' }).click();

    await expect(page.getByTestId('onboarding-step-done')).toBeVisible();

    // "Go to your dashboard" activates the tenant via the session update. On Better Auth that update is
    // the `setActiveTenant` server action, which writes the durable last-active-tenant cookie (the
    // session's `current_tenant_id` is derived from it at read time) — there is no NextAuth
    // `POST /api/auth/session`. Wait for that cookie before the hard navigation below, or the reload
    // would race the fire-and-forget write and land without an active tenant.
    await page.getByRole('button', { name: 'Go to your dashboard' }).click();
    await expect
      .poll(async () => {
        const cookies = await page.context().cookies();
        return cookies.find((c) => c.name === 'apiome.last-active-tenant')?.value ?? '';
      })
      .not.toBe('');

    // The wizard hands off to the app with the new tenant active.
    await gotoDashboard(page);
    await expect(page.getByTestId('first-tenant-onboarding-wizard')).toHaveCount(0);
    await gotoDashboard(page);
    await expect(switcherButton(page)).toContainText(WREN_ORG);

    expect(await countUsersByEmail(WREN_EMAIL)).toBe(1);
    expect(await listLinkedProviders(WREN_EMAIL)).toEqual(['azure']);
  });

  test('5. member invites stop at the Free-tier seat limit with the structured refusal', async ({
    page,
  }) => {
    // Seat math (Free tier = 5): Wren (owner) + Riley + 3 seeded users fill the tenant;
    // the 6th account exists but must be refused.
    const fillers = await Promise.all(
      [1, 2, 3, 4].map((n) => {
        const email = `filler${n}.${RUN}@example.test`;
        return seedVerifiedUser(email, `Filler ${n}`).then(() => email);
      })
    );

    await page.context().clearCookies();
    await setMockPersona(
      persona({ idOffset: 21, email: WREN_EMAIL, name: 'Wren Journey', login: `wren-${RUN}` })
    );
    await startLogin(page, 'azure');
    await page.waitForURL(/\/ade/, { timeout: 60_000 });

    await page.goto('/ade/dashboard/members');
    await expect(switcherButton(page)).toContainText(WREN_ORG);
    await expect(page.getByTestId('members-invite-form')).toBeVisible();
    await expect(page.getByTestId('member-row')).toHaveCount(1);

    const invite = async (email: string) => {
      await page.locator('#inviteEmail').fill(email);
      await page.getByRole('button', { name: 'Invite member' }).click();
    };

    for (const [index, email] of [RILEY_EMAIL, ...fillers.slice(0, 3)].entries()) {
      await invite(email);
      await expect(page.getByTestId('member-row')).toHaveCount(index + 2);
      await expect(page.getByTestId('members-error')).toHaveCount(0);
    }

    // At the Free-tier limit (Wren + 4 invited = 5/5 seats) the invite form enforces the cap: once the
    // seat data reaches capacity the email input is disabled and the structured
    // `license-seats-exhausted` guidance is shown. This is the deterministic form of the OLO-5.3
    // refusal — the seat count reaches at-capacity before a sixth address can be submitted, so the
    // refusal is the disabled form + guidance rather than a post-submit error banner. `fillers[3]`
    // stays a seeded-but-uninvited account (the seat that can no longer be filled).
    await expect(page.getByTestId('member-row')).toHaveCount(5);
    await expect(page.locator('#inviteEmail')).toBeDisabled();
    await expect(page.getByText(/member seats.*are in use/i)).toBeVisible();
  });

  test('6. a two-tenant user switches tenants from the header, durably', async ({ page }) => {
    // Riley now belongs to two tenants: their own (test 1) and Wren's (invited, test 5).
    await page.context().clearCookies();
    await setMockPersona(
      persona({ idOffset: 1, email: RILEY_EMAIL, name: 'Riley Journey', login: `riley-${RUN}` })
    );
    await startLogin(page, 'github');
    await page.waitForURL(/\/ade/, { timeout: 60_000 });
    await gotoDashboard(page);
    await expect(switcherButton(page)).toContainText(RILEY_ORG);

    const selectTenant = async (name: string) => {
      await switcherButton(page).click();
      await page
        .getByRole('menu', { name: 'Your tenants' })
        .getByRole('menuitem', { name: new RegExp(name) })
        .click();
      await expect(switcherButton(page)).toContainText(name);
    };

    await selectTenant(WREN_ORG);
    await selectTenant(RILEY_ORG);
    await selectTenant(WREN_ORG);

    // The durable last-active cookie (OLO-6.1) is written fire-and-forget after the
    // switch; wait for it before reloading so the reload cannot abort the write.
    await expect
      .poll(async () => {
        const cookies = await page.context().cookies();
        return cookies.find((c) => c.name === 'apiome.last-active-tenant')?.value ?? '';
      })
      .not.toBe('');

    // The choice is durable: a reload keeps the tenant.
    await page.reload();
    await expect(switcherButton(page)).toContainText(WREN_ORG);
  });

  test('7. Google login auto-links to the existing account — the fourth provider', async ({
    page,
  }) => {
    // Riley already holds github + gitlab identities (tests 1–2). A verified Google login for the same
    // email links a third identity onto the one account — exercising the fourth MVP provider on Better
    // Auth and the same no-duplicate invariant.
    await page.context().clearCookies();
    await setMockPersona(
      persona({ idOffset: 3, email: RILEY_EMAIL, name: 'Riley Journey', login: `riley-${RUN}` })
    );

    await startLogin(page, 'google');

    await page.waitForURL(/\/ade/, { timeout: 60_000 });
    await gotoDashboard(page);
    await expect(switcherButton(page)).toContainText(RILEY_ORG);

    // One user, three linked identities — Google linked, nothing duplicated.
    expect(await countUsersByEmail(RILEY_EMAIL)).toBe(1);
    expect(await listLinkedProviders(RILEY_EMAIL)).toEqual(['github', 'gitlab', 'google']);
  });

  test('8. a credentials user signs in through the email/password form', async ({ page }) => {
    // Seed a verified user with a real bcrypt credential (both password homes, OLO-10.5), then sign in
    // via the login page's email form — the credential path on Better Auth's `signIn.email`. The user
    // has no tenant, so success lands on the first-tenant onboarding wizard (proof of authentication).
    await seedCredentialUser(CRED_EMAIL, CRED_PASSWORD, 'Cred Journey');

    await page.context().clearCookies();
    await page.goto('/login');

    // SSO is the primary path, so the credentials form starts collapsed behind this toggle.
    await page.getByRole('button', { name: 'or use your email' }).click();
    await page.locator('#email').fill(CRED_EMAIL);
    await page.locator('#password').fill(CRED_PASSWORD);
    await page.locator('#credentials-form').getByRole('button', { name: /Sign In/ }).click();

    await page.waitForURL(/\/ade/, { timeout: 60_000 });
    await expect(page.getByTestId('first-tenant-onboarding-wizard')).toBeVisible();
  });

  test('9. 2FA enrollment: TOTP enable + verify turns 2FA on', async ({ page }) => {
    // There is no 2FA UX yet (foundation only, #5005), so enrollment drives the Better Auth twoFactor
    // endpoints directly. Establish the credentials user's session through `page.request` itself (an
    // API sign-in) so the request context unambiguously carries the session cookie the enroll endpoints
    // require — the API request context does not inherit the browser page's cookie jar for these calls.
    // The user has no 2FA yet, so this is a full session (no two-factor challenge).
    await page.context().clearCookies();
    const sessionResponse = await postAuthApi(page, AUTH_API.signInEmail, {
      email: CRED_EMAIL,
      password: CRED_PASSWORD,
    });
    await expectAuthOk(sessionResponse, 'sign-in/email (2FA enroll session)');

    // `enable` returns the secret + backup codes; `verify-totp` (with a live code) confirms enrollment
    // and flips `users."twoFactorEnabled"`.
    const enableResponse = await postAuthApi(page, AUTH_API.twoFactorEnable, {
      password: CRED_PASSWORD,
    });
    await expectAuthOk(enableResponse, 'two-factor/enable');
    const enrollment = (await enableResponse.json()) as { totpURI: string; backupCodes: string[] };
    tfaSecret = parseTotpSecret(enrollment.totpURI);
    tfaBackupCodes = enrollment.backupCodes;
    expect(tfaSecret.length).toBeGreaterThan(0);
    expect(tfaBackupCodes.length).toBeGreaterThan(0);

    const verifyResponse = await postAuthApi(page, AUTH_API.twoFactorVerifyTotp, {
      code: generateTotp(tfaSecret),
    });
    await expectAuthOk(verifyResponse, 'two-factor/verify-totp (enroll)');

    // Enabled flag flips and exactly one two_factor row exists (secret/backup codes are ciphertext).
    const state = await getTwoFactorState(CRED_EMAIL);
    expect(state.enabled).toBe(true);
    expect(state.rows).toBe(1);
  });

  test('10. 2FA login: password sign-in is withheld until a TOTP code satisfies it', async ({
    page,
  }) => {
    await page.context().clearCookies();

    // Password sign-in for a 2FA user returns a two-factor challenge, not a full session.
    const signInResponse = await postAuthApi(page, AUTH_API.signInEmail, {
      email: CRED_EMAIL,
      password: CRED_PASSWORD,
    });
    await expectAuthOk(signInResponse, 'sign-in/email (TOTP challenge)');
    expect(((await signInResponse.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
      true
    );

    // A generated TOTP code completes the second factor and establishes the session.
    const verifyResponse = await postAuthApi(page, AUTH_API.twoFactorVerifyTotp, {
      code: generateTotp(tfaSecret),
    });
    await expectAuthOk(verifyResponse, 'two-factor/verify-totp (login)');

    // Now fully authenticated: the zero-tenant onboarding wizard renders instead of a login redirect.
    await page.goto('/ade');
    await expect(page.getByTestId('first-tenant-onboarding-wizard')).toBeVisible();
  });

  test('11. 2FA login: a backup code also satisfies the second factor', async ({ page }) => {
    await page.context().clearCookies();

    const signInResponse = await postAuthApi(page, AUTH_API.signInEmail, {
      email: CRED_EMAIL,
      password: CRED_PASSWORD,
    });
    await expectAuthOk(signInResponse, 'sign-in/email (backup-code challenge)');
    expect(((await signInResponse.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
      true
    );

    const backupResponse = await postAuthApi(page, AUTH_API.twoFactorVerifyBackupCode, {
      code: tfaBackupCodes[0],
    });
    await expectAuthOk(backupResponse, 'two-factor/verify-backup-code');

    await page.goto('/ade');
    await expect(page.getByTestId('first-tenant-onboarding-wizard')).toBeVisible();
  });
});
