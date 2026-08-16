import { expect, test, type Page } from '@playwright/test';
import { testUsers } from './fixtures/test-fixtures';

/**
 * The rail footer's user menu, end to end (HIVE-3.4, #5290).
 *
 * `tests/rail-user-menu.test.tsx` already pins the inventory, the honey dot and the
 * keyboard model. What only a browser can answer is what jsdom compiles no stylesheet for:
 * that the 260 px popup opens *upward* from a row at the bottom of the rail and stays
 * inside the viewport, that it still opens — at the same size, in the same place — once
 * the rail has collapsed to 64 px and CSS has taken the labels away, and that a menu wider
 * than the rail does not make the document scroll sideways.
 *
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`)
 * with the seeded test user, since the rail is only drawn for a signed-in reader. Tests
 * skip rather than fail when that user cannot sign in, matching `authenticated.spec.ts`.
 */

/** The chord that collapses and expands the rail (`DESIGN.md` §5.2). */
const RAIL_CHORD = process.platform === 'darwin' ? 'Meta+Backslash' : 'Control+Backslash';

/** The design width of the menu (`DESIGN.md` §5.4 — "260 px"). */
const MENU_WIDTH = 260;

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

/**
 * Sign in and land on a dashboard route, or skip the test.
 *
 * @param page The page under test.
 */
async function signInOrSkip(page: Page): Promise<void> {
  const signedIn = await signIn(page);
  test.skip(!signedIn, 'Seeded test user could not sign in — skipping authenticated test');

  await page.goto('/ade/dashboard/projects');
  await page.waitForLoadState('networkidle');
}

/** The footer's user button. */
const trigger = (page: Page) => page.getByTestId('rail-user');

/** The popup, once open. */
const menu = (page: Page) => page.getByTestId('user-menu');

test.describe('rail user menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInOrSkip(page);
  });

  test('opens upward from the footer at its design width, inside the viewport', async ({
    page,
  }) => {
    await trigger(page).click();
    await expect(menu(page)).toBeVisible();

    const triggerBox = (await trigger(page).boundingBox())!;
    const menuBox = (await menu(page).boundingBox())!;

    expect(Math.round(menuBox.width)).toBe(MENU_WIDTH);
    // Upward: the menu's bottom edge sits at or above the row it belongs to.
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y + 1);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('still opens once the rail has collapsed to its icons', async ({ page }) => {
    await page.keyboard.press(RAIL_CHORD);
    await expect(page.locator('html')).toHaveAttribute('data-rail', 'collapsed');

    await trigger(page).click();
    await expect(menu(page)).toBeVisible();

    // Wider than the 64 px rail, and drawn outside it rather than clipped by it.
    const menuBox = (await menu(page).boundingBox())!;
    expect(Math.round(menuBox.width)).toBe(MENU_WIDTH);
    await expect(page.getByTestId('user-menu-profile')).toBeVisible();

    await page.keyboard.press(RAIL_CHORD);
  });

  test('walks with the arrow keys and closes on Escape', async ({ page }) => {
    await trigger(page).click();
    await expect(menu(page)).toBeVisible();

    // The menu takes focus when it opens; two steps down is the third row.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('user-menu-preferences')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  });

  test('opens the release notes from the build badge, and clears the unread dot', async ({
    page,
  }) => {
    await page.evaluate(() => window.localStorage.removeItem('hive.whatsNewSeen'));
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('rail-user-unread')).toBeVisible();

    await trigger(page).click();
    await page.getByTestId('rail-build-badge').click();

    await expect(page.getByTestId('whats-new-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rail-user-unread')).toBeHidden();
  });
});
