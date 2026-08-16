import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The command palette, measured in a browser (HIVE-3.6, #5292).
 *
 * `tests/command-palette.test.tsx` drives what the palette *does* and
 * `tests/command-palette-css.test.ts` pins the stylesheet behind it. Neither can answer the
 * half of the acceptance criteria that is about what a reader can *see*, because jsdom
 * compiles no CSS and paints nothing:
 *
 *   • **"Arrow keys move a visible active row."** Visible means a background that changes,
 *     which is `[data-selected]` in the stylesheet rather than anything React renders.
 *   • **"Announced as a dialog; results list is an ARIA listbox."** Worth an axe run on a
 *     composited tree rather than a read-back of attributes.
 *   • The cross-cutting rules of roadmap §6: 640 px in every theme, no horizontal document
 *     scroll at 1280 px, and a surface that still works at the largest font scale and the
 *     compact density.
 *
 * Runs against `/design-system/command-palette` — the gallery route, which needs no session
 * and no data, so this suite is deterministic. Requires the app to be running
 * (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The viewport width DESIGN.md §5 forbids horizontal document scroll at. */
const DESKTOP_WIDTH = 1280;

/** The palette's width in CSS pixels at the default root (DESIGN.md §5.4). */
const PALETTE_WIDTH_PX = 640;

/** Every theme with a block of its own; `light` is the `:root` default. */
const THEMES = [
  null,
  'dark',
  'high-contrast',
  'blueprint',
  'whiteboard',
  'solarized',
  'nord',
  'darcula',
];

/**
 * The blocking half of an axe run.
 *
 * @param violations Everything axe reported.
 * @returns Only the serious and critical entries, which is what DESIGN.md §6 forbids.
 */
function blockingViolations<T extends { impact?: string | null }>(violations: T[]): T[] {
  return violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''));
}

/**
 * Freeze every transition and animation, so a box read straight after an open is final.
 *
 * @param page The page to freeze.
 */
async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
}

/**
 * Open the gallery at the desktop width.
 *
 * @param page The page to drive.
 */
async function openGallery(page: Page): Promise<void> {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto('/design-system/command-palette');
  await expect(page.getByTestId('specimen-open')).toBeVisible();
  await freezeMotion(page);
}

/**
 * Open the palette from the gallery's primary button.
 *
 * @param page The page to drive.
 * @returns The dialog locator.
 */
async function openPalette(page: Page) {
  await page.getByTestId('open-palette').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Put a preference on `<html>`, the way `PreferencesProvider` does.
 *
 * @param page The page to restyle.
 * @param attribute The attribute to write.
 * @param value The value, or `null` to remove it.
 */
async function applyPreference(
  page: Page,
  attribute: string,
  value: string | null
): Promise<void> {
  await page.evaluate(
    ({ name, next }) => {
      if (next) document.documentElement.setAttribute(name, next);
      else document.documentElement.removeAttribute(name);
    },
    { name: attribute, next: value }
  );
}

/** Which row cmdk currently marks active. */
function activeRow(page: Page) {
  return page.locator('[cmdk-item][data-selected="true"]');
}

test.describe('command palette', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page);
  });

  test.describe('the surface', () => {
    test('is 640 px wide and rises from the top rather than the middle', async ({ page }) => {
      const dialog = await openPalette(page);
      const box = (await dialog.boundingBox())!;

      expect(Math.round(box.width)).toBe(PALETTE_WIDTH_PX);
      // 12 vh of a 900 px viewport. A centred palette would sit near 300 px and move on
      // every keystroke as the list is filtered.
      expect(box.y).toBeLessThan(200);
      // Horizontally centred in the viewport.
      expect(Math.abs(box.x + box.width / 2 - DESKTOP_WIDTH / 2)).toBeLessThan(2);
    });

    test('never scrolls the document sideways, open or closed', async ({ page }) => {
      const scrolls = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth
        );

      expect(await scrolls()).toBe(false);
      await openPalette(page);
      expect(await scrolls()).toBe(false);
    });

    test('fits a phone, where 640 px does not', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const dialog = await openPalette(page);
      const box = (await dialog.boundingBox())!;

      expect(box.width).toBeLessThan(390);
      expect(box.x).toBeGreaterThan(0);
    });

    test('stays legible in every theme', async ({ page }) => {
      await openPalette(page);
      const row = page.getByTestId('palette-item-jump-catalog');

      for (const theme of THEMES) {
        await applyPreference(page, 'data-theme', theme);

        const painted = await row.evaluate((element) => {
          const surface = element.closest('[role="dialog"]')!;
          return {
            surface: getComputedStyle(surface).backgroundColor,
            ink: getComputedStyle(element).color,
          };
        });

        // A theme that failed to reach the palette would leave the surface transparent and
        // the rows would be read against whatever is behind the scrim.
        expect
          .soft(painted.surface, `${theme ?? 'light'} palette surface`)
          .not.toMatch(/rgba\([^)]*,\s*0\)$/);
        expect.soft(painted.ink, `${theme ?? 'light'} row ink`).not.toBe(painted.surface);
      }

      await applyPreference(page, 'data-theme', null);
    });

    test('survives the largest font scale and the compact density', async ({ page }) => {
      await applyPreference(page, 'data-font-scale', '2xl');
      await applyPreference(page, 'data-density', 'compact');

      const dialog = await openPalette(page);
      const box = (await dialog.boundingBox())!;

      // Still on screen, top and bottom, with the footer legend inside it.
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      await expect(dialog.locator('.palette__foot')).toBeVisible();

      await applyPreference(page, 'data-font-scale', null);
      await applyPreference(page, 'data-density', null);
    });
  });

  test.describe('the keyboard', () => {
    test('moves a *visibly* active row with the arrows', async ({ page }) => {
      await openPalette(page);

      const first = activeRow(page);
      const firstFill = await first.evaluate((el) => getComputedStyle(el).backgroundColor);
      const firstValue = await first.getAttribute('data-value');

      await page.keyboard.press('ArrowDown');

      const second = activeRow(page);
      const secondValue = await second.getAttribute('data-value');
      expect(secondValue).not.toBe(firstValue);

      // The active row is painted, and the row it left is not: that is the visible half of
      // the acceptance criterion, and it is a stylesheet rule rather than anything React did.
      const secondFill = await second.evaluate((el) => getComputedStyle(el).backgroundColor);
      const vacatedFill = await page
        .locator(`[cmdk-item][data-value="${firstValue}"]`)
        .evaluate((el) => getComputedStyle(el).backgroundColor);

      expect(secondFill).toBe(firstFill);
      expect(vacatedFill).not.toBe(secondFill);
    });

    test('opens the active row on ↵', async ({ page }) => {
      await openPalette(page);
      await page.keyboard.type('catalog');

      const chosen = await activeRow(page).innerText();
      await page.keyboard.press('Enter');

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByTestId('palette-choice')).toContainText(chosen.split('\n')[0]);
    });

    test('closes on Esc and gives focus back to the control that opened it', async ({ page }) => {
      await openPalette(page);
      await page.keyboard.press('Escape');

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByTestId('open-palette')).toBeFocused();
    });

    test('switches to the Actions group on tab, as the footer legend promises', async ({
      page,
    }) => {
      const dialog = await openPalette(page);

      await page.keyboard.press('Tab');

      await expect(dialog.getByTestId('palette-group-action')).toBeVisible();
      await expect(dialog.getByTestId('palette-group-jump')).toHaveCount(0);
    });

    test('narrows to commands on >, and keeps them all on screen', async ({ page }) => {
      const dialog = await openPalette(page);

      await page.keyboard.type('>');

      await expect(dialog.getByTestId('palette-group-action')).toBeVisible();
      await expect(dialog.getByTestId('palette-group-jump')).toHaveCount(0);
      await expect(dialog.getByText('Change theme…')).toBeVisible();
    });
  });

  test.describe('the rail trigger', () => {
    test('opens the same palette the buttons do', async ({ page }) => {
      await page.getByTestId('specimen-trigger').getByTestId('rail-search').click();

      await expect(page.getByRole('dialog')).toBeVisible();
    });
  });

  test.describe('gating', () => {
    test('keeps a workspace-scoped row on screen and states its reason', async ({ page }) => {
      await page.getByTestId('open-palette-gated').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      const row = dialog.getByTestId('palette-item-action-new-project');
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute('aria-disabled', 'true');
      await expect(row).toContainText('Select a workspace');
    });
  });

  test('has no serious or critical axe violations, open', async ({ page }) => {
    await openPalette(page);

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(blockingViolations(results.violations)).toEqual([]);
  });

  test('has no serious or critical axe violations with every row gated', async ({ page }) => {
    await page.getByTestId('open-palette-gated').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(blockingViolations(results.violations)).toEqual([]);
  });
});
