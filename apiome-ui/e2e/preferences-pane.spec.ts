import { expect, test, type Page } from '@playwright/test';
import { testUsers } from './fixtures/test-fixtures';

/**
 * The preferences pane, end to end (HIVE-1.4, #5277).
 *
 * `tests/preferences-drawer.test.tsx` already pins what the pane writes and what it reads
 * back. What only a browser can answer is the part jsdom compiles nothing for: that the
 * drawer really is a 520 px sheet on the right edge and does not push the page sideways,
 * that choosing a theme repaints the canvas rather than merely setting an attribute, that
 * the font-size slider re-sizes the root element, that focus is genuinely trapped inside
 * the sheet, and that a setting made here survives a route change and a hard reload.
 *
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`)
 * with the seeded test user, since the pane is only reachable from a signed-in shell.
 * Tests skip rather than fail when that user cannot sign in, matching `authenticated.spec.ts`.
 */

/** The chord that opens the pane, on whichever platform the run is on. */
const PREFERENCES_CHORD = process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma';

/** The design width of the sheet (`DESIGN.md` §4.1). */
const DRAWER_WIDTH = 520;

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

/** The drawer, once open. */
const drawer = (page: Page) => page.getByTestId('preferences-drawer');

/**
 * Open the pane with the keyboard and wait for it.
 *
 * @param page The page under test.
 */
async function openPane(page: Page): Promise<void> {
  await page.keyboard.press(PREFERENCES_CHORD);
  await expect(drawer(page)).toBeVisible();
}

test.describe('preferences pane', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInOrSkip(page);
  });

  test('opens on ⌘, and from the sidebar footer, and closes on Escape', async ({ page }) => {
    await openPane(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toBeHidden();

    // The rail footer's Preferences row (HIVE-3.1, #5287) — the sidebar that used to carry
    // this entry point no longer renders inside the application shell.
    await page.getByTestId('rail-preferences').click();
    await expect(drawer(page)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(drawer(page)).toBeHidden();
  });

  test('is a full-height sheet on the right edge and never widens the document', async ({
    page,
  }) => {
    await openPane(page);

    const box = (await drawer(page).boundingBox())!;
    const viewport = page.viewportSize()!;

    expect(box.width).toBeLessThanOrEqual(DRAWER_WIDTH);
    // Flush with the right edge, and as tall as the viewport.
    expect(Math.round(box.x + box.width)).toBe(viewport.width);
    expect(Math.round(box.height)).toBe(viewport.height);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('traps focus inside the sheet while it is open', async ({ page }) => {
    await openPane(page);

    // Twenty tabs is more than the pane holds, so this leaves the sheet if anything can.
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="preferences-drawer"]');
        return Boolean(sheet && document.activeElement && sheet.contains(document.activeElement));
      });
      expect(inside).toBe(true);
    }
  });

  test('repaints the canvas the moment a theme is chosen', async ({ page }) => {
    await openPane(page);

    const before = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
    );

    await drawer(page).locator('[data-theme-card="nord"]').click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
    const after = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
    );
    expect(after).not.toBe(before);
  });

  test('re-sizes the whole interface from the font-size slider', async ({ page }) => {
    await openPane(page);

    const rootSize = () =>
      page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const before = await rootSize();

    // `fill` on a range input sets the value and fires `input`, which is what the slider
    // listens to — dragging would depend on the track's pixel geometry.
    await drawer(page).getByTestId('preferences-font-scale').fill('5');

    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '2xl');
    expect(await rootSize()).toBeGreaterThan(before);
  });

  test('keeps a setting across a route change and a hard reload', async ({ page }) => {
    await openPane(page);

    await drawer(page).locator('[data-density-option="compact"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    await page.keyboard.press('Escape');

    await page.goto('/ade/dashboard/tenants');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  });

  test('hides the keyboard hints when the reader asks it to', async ({ page }) => {
    await openPane(page);
    await page.getByRole('tab', { name: 'Shortcuts' }).click();

    const chip = drawer(page).locator('[data-shortcut="preferences"] .kbd').first();
    await expect(chip).toBeVisible();

    await page.getByRole('tab', { name: 'Appearance' }).click();
    await drawer(page).locator('[data-switch="kbdHints"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-kbd-hints', 'off');

    await page.getByRole('tab', { name: 'Shortcuts' }).click();
    await expect(drawer(page).locator('[data-shortcut="preferences"] .kbd').first()).toBeHidden();
  });
});
