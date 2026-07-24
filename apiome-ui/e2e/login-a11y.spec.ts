import { test, expect, Page, Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Login a11y + visual tests (OLO-3.5, #4203).
 *
 * The front door must be fully keyboard/screen-reader operable and visually stable across
 * releases. This suite is the browser-level acceptance gate for that:
 *
 *   1. axe clean — WCAG 2.1 A/AA scans of the login page in its default (SSO-first,
 *      credentials collapsed), credentials-expanded, and error states report zero violations.
 *   2. Keyboard-only sign-in — the whole credentials path (expand → email → password →
 *      submit) is reachable and operable using Tab/Enter alone, in a logical focus order.
 *   3. Visual snapshots — the auth card is pinned for the default, loading ("Connecting…"),
 *      and error states so unintended visual regressions fail CI.
 *
 * The structural half of (1)/(2) is also covered deterministically in jsdom by
 * tests/login-a11y.test.tsx; this suite adds the real-browser guarantees (contrast, computed
 * focus order, rendered pixels) that jsdom cannot provide.
 */

/** WCAG 2.1 Level A/AA — the conformance target for the login page. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Build an axe scan scoped to the WCAG A/AA ruleset for the current page. */
function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(WCAG_TAGS);
}

/** The auth card — the stable region snapshotted across visual states. */
const authCard = (page: Page) => page.getByTestId('login-card');

/**
 * Reveal the credentials form. When SSO providers are enabled the form starts collapsed
 * beneath the "or use your email" control (OLO-3.1); with none it is already expanded.
 */
async function expandCredentials(page: Page): Promise<void> {
  const expand = page.getByRole('button', { name: 'or use your email' });
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
  }
  await expect(page.getByLabel('Email Address')).toBeVisible();
}

/**
 * Press Tab (up to `maxTabs` times) until `target` holds focus. Returns the number of Tab
 * presses it took, or throws if the element was never reached — which is itself the a11y
 * failure we want surfaced (an element the keyboard cannot reach).
 */
async function tabTo(page: Page, target: Locator, maxTabs = 25): Promise<number> {
  for (let i = 0; i < maxTabs; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      return i;
    }
    await page.keyboard.press('Tab');
  }
  if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
    return maxTabs;
  }
  throw new Error('Element never received focus within the Tab budget');
}

test.describe('Login a11y (OLO-3.5)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
  });

  test('default state is axe-clean (WCAG 2.1 A/AA)', async ({ page }) => {
    const results = await scan(page).analyze();
    expect(results.violations).toEqual([]);
  });

  test('credentials-expanded state is axe-clean', async ({ page }) => {
    await expandCredentials(page);
    const results = await scan(page).analyze();
    expect(results.violations).toEqual([]);
  });

  test('error state is axe-clean', async ({ page }) => {
    await page.goto('/login?error=CredentialsSignin');
    await page.waitForLoadState('networkidle');
    // The failed-credentials banner announces assertively via role="alert".
    const banner = page.getByTestId('login-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveRole('alert');
    const results = await scan(page).analyze();
    expect(results.violations).toEqual([]);
  });

  test('every form field is reachable by its accessible name', async ({ page }) => {
    await expandCredentials(page);
    // getByLabel resolves only via a programmatic label association.
    await expect(page.getByLabel('Email Address')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('keyboard-only sign-in: expand → email → password → submit in focus order', async ({ page }) => {
    // 1. Reach and activate the "or use your email" expand control with the keyboard alone.
    const expand = page.getByRole('button', { name: 'or use your email' });
    if (await expand.isVisible().catch(() => false)) {
      await tabTo(page, expand);
      await page.keyboard.press('Enter');
    }

    const email = page.getByLabel('Email Address');
    const password = page.getByLabel('Password');
    const submit = page.getByRole('button', { name: /sign in/i });

    // 2. Tab forward to the email field and type — no mouse used.
    await tabTo(page, email);
    await expect(email).toBeFocused();
    await page.keyboard.type('user@example.com');

    // 3. Tab to the password field (focus order: email → password) and type.
    await tabTo(page, password);
    await expect(password).toBeFocused();
    await page.keyboard.type('correct-horse-battery');

    // 4. The submit button is reachable and activatable from the keyboard.
    await tabTo(page, submit);
    await expect(submit).toBeFocused();

    // Values were entered via the keyboard alone.
    await expect(email).toHaveValue('user@example.com');
    await expect(password).toHaveValue('correct-horse-battery');

    // Activating submit fires the credentials sign-in request (Better Auth email/password endpoint).
    const signInRequest = page.waitForRequest(
      (req) => req.url().includes('/api/auth/sign-in/email'),
      { timeout: 10_000 },
    );
    await page.keyboard.press('Enter');
    await signInRequest;
  });
});

test.describe('Login visual snapshots (OLO-3.5)', () => {
  test('default state', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(authCard(page)).toHaveScreenshot('login-card-default.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('loading state (SSO "Connecting…")', async ({ page }) => {
    // Hold the provider sign-in request open so the redirect never completes and the
    // "Connecting…" spinner stays on screen long enough to snapshot deterministically.
    // (Better Auth's generic-OAuth sign-in posts to /api/auth/sign-in/oauth2.)
    await page.route('**/api/auth/sign-in/**', () => {
      /* intentionally never resolved — keeps the request pending */
    });

    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);

    const firstSso = page.getByRole('button', { name: /continue with/i }).first();
    await expect(firstSso).toBeVisible();
    await firstSso.click();

    await expect(page.getByText('Connecting…')).toBeVisible();
    await expect(authCard(page)).toHaveScreenshot('login-card-loading.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('error state', async ({ page }) => {
    await page.goto('/login?error=CredentialsSignin');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId('login-banner')).toBeVisible();
    await expect(authCard(page)).toHaveScreenshot('login-card-error.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});
