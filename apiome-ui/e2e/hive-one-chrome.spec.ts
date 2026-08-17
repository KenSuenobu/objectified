import { expect, test, type Page } from '@playwright/test';
import { testUsers } from './fixtures/test-fixtures';

/**
 * One chrome, end to end (HIVE-3.8, #5294).
 *
 * Epic 3 replaced two navigation systems with one, and #5294 deleted the loser: the 48px
 * `TopHeader`, the `ConditionalHeader` that decided which of the two drew, and
 * `DashboardSideNav`. Its acceptance criterion is a statement about routes — *"`/ade`
 * (launcher) still renders without a rail; every other `/ade/**` route renders with one"* —
 * and that is what this suite checks, on the real routes, in a real browser.
 *
 * `tests/ade-chrome-retired.test.ts` already guards the source: the modules are gone and
 * nothing imports them. What it cannot see is the rendered page — whether a route that is
 * *supposed* to have a rail actually mounts one, and whether any route mounts two. A
 * double-render is precisely the failure the ticket exists to prevent, and it is invisible
 * to a source scan.
 *
 * Requires the app running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`) with the
 * seeded test user. Tests skip rather than fail when that user cannot sign in, matching
 * `authenticated.spec.ts` and `rail-user-menu.spec.ts`.
 */

/** Every `/ade` route that must draw the rail. */
const RAIL_ROUTES = ['/ade/dashboard', '/ade/dashboard/projects', '/ade/database', '/ade/migration'];

/**
 * Sign in with the seeded test user.
 *
 * @param page The page under test.
 * @returns Whether a session was established.
 */
async function signIn(page: Page): Promise<boolean> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.getByPlaceholder('you@example.com').fill(testUsers.valid.email);
  await page.locator('input[type="password"]').fill(testUsers.valid.password);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForURL(/\/ade/, { timeout: 15000 }).catch(() => undefined);
  return !page.url().includes('/login');
}

test.describe('one chrome on every /ade route', () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signIn(page);
    test.skip(!signedIn, 'Seeded test user could not sign in — skipping');
  });

  for (const route of RAIL_ROUTES) {
    test(`${route} renders exactly one rail`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState('networkidle');

      // Exactly one: the bug this ticket forecloses is two navigation systems drawing at
      // once, which a `toBeVisible()` on `.first()` would happily pass.
      await expect(page.getByTestId('app-rail')).toHaveCount(1);
      await expect(page.getByTestId('app-rail')).toBeVisible();
    });
  }

  test('the launcher renders no rail', async ({ page }) => {
    await page.goto('/ade');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('app-rail')).toHaveCount(0);
  });

  test('no shell route draws a bar above the page', async ({ page }) => {
    // The retired header sat above `#main-content` rather than inside it, which is what
    // distinguishes it from a page header (HIVE-3.5) without naming a class. Only shell
    // routes are checked: the launcher is its own chrome, draws its own `<header>`, and has
    // no `#main-content` at all — it is the route the rail deliberately does not reach.
    for (const route of RAIL_ROUTES) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');

      const headersOutsideMain = await page.evaluate(() => {
        const main = document.getElementById('main-content');
        return [...document.querySelectorAll('header')].filter(
          (header) => !main || !main.contains(header)
        ).length;
      });

      expect(headersOutsideMain, `${route} draws chrome above the page`).toBe(0);
    }
  });

  test('a shell route starts its content at the top, reserving no bar', async ({ page }) => {
    // The half of the retirement a source scan cannot see. Tools used to clear a 48px bar
    // with `margin-top` and `calc(100vh - 48px)`; if either came back, or if a bar returned
    // without them, the page column would no longer start at the top of the viewport.
    for (const route of ['/ade/database', '/ade/migration']) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');

      const tops = await page.evaluate(() => {
        const main = document.getElementById('main-content');
        const first = main?.firstElementChild;
        return {
          main: main ? Math.round(main.getBoundingClientRect().top) : null,
          first: first ? Math.round(first.getBoundingClientRect().top) : null,
        };
      });

      expect(tops.main, `${route} pushes the page column down`).toBe(0);
      expect(tops.first, `${route} reserves space above its toolbar`).toBe(0);
    }
  });
});
