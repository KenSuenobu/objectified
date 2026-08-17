import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The shortcuts sheet, measured in a browser (HIVE-3.7, #5293).
 *
 * `tests/shortcut-sheet.test.tsx` drives what the sheet *says* and
 * `tests/shortcut-sheet-css.test.ts` pins the stylesheet behind it. Neither can answer the
 * half of the acceptance criteria that is about what a reader can *see*, because jsdom
 * compiles no CSS and paints nothing:
 *
 *   • **Two columns that become one.** The grid is `auto-fit` over a `rem` measure, so the
 *     column count follows the font-size preference rather than a breakpoint — which is only
 *     observable once something has laid the grid out.
 *   • **`?` opens the sheet from anywhere except a text field**, with a real focus ring, a
 *     real focus trap and focus given back on close.
 *   • The cross-cutting rules of roadmap §6: every theme, both densities, the largest font
 *     scale, no horizontal document scroll at 1280 px and no serious axe violation.
 *
 * Runs against `/design-system/shortcuts` — the gallery route, which needs no session and no
 * data, so this suite is deterministic. Requires the app to be running
 * (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The viewport width DESIGN.md §5 forbids horizontal document scroll at. */
const DESKTOP_WIDTH = 1280;

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
  await page.goto('/design-system/shortcuts');
  await expect(page.getByTestId('specimen-sheet')).toBeVisible();
  await freezeMotion(page);
}

/**
 * Open the sheet from the gallery's primary button.
 *
 * @param page The page to drive.
 * @returns The dialog locator.
 */
async function openSheet(page: Page) {
  await page.getByTestId('open-shortcut-sheet').click();
  const dialog = page.getByTestId('shortcut-sheet');
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

/**
 * How many columns the sheet's grid is drawing.
 *
 * @param page The page to measure.
 * @returns The track count `auto-fit` resolved to.
 */
async function columnCount(page: Page): Promise<number> {
  return page
    .locator('.shortcut-sheet__grid')
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
}

test.describe('shortcuts sheet', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page);
  });

  test.describe('the surface', () => {
    test('lays the sections out in columns, and folds to one on a phone', async ({ page }) => {
      await openSheet(page);
      expect(await columnCount(page)).toBeGreaterThan(1);

      await page.setViewportSize({ width: 390, height: 844 });
      expect(await columnCount(page)).toBe(1);

      // …and the dialog is still inside the phone rather than hanging off it. `Dialog` is
      // `w-full` up to its size cap (HIVE-2.1), so full-bleed is the primitive's own
      // behaviour on a narrow screen; what must not happen is overflow.
      const box = (await page.getByTestId('shortcut-sheet').boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(390);
      expect(box.x).toBeGreaterThanOrEqual(0);
    });

    test('folds to one column at the largest font scale, without being told to', async ({
      page,
    }) => {
      await openSheet(page);
      const wide = await columnCount(page);

      // The measure is in `rem`, so the reader's own type size is what decides the count —
      // no media query per stop, and nothing to keep in step with the six scales.
      await applyPreference(page, 'data-font-scale', '2xl');
      expect(await columnCount(page)).toBeLessThanOrEqual(wide);

      await applyPreference(page, 'data-font-scale', null);
    });

    test('never scrolls the document sideways, open or closed', async ({ page }) => {
      const scrolls = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth
        );

      expect(await scrolls()).toBe(false);
      await openSheet(page);
      expect(await scrolls()).toBe(false);
    });

    test('stays legible in every theme', async ({ page }) => {
      await openSheet(page);
      const row = page.locator('[data-shortcut="jump-projects"] .shortcut-sheet__label');

      for (const theme of THEMES) {
        await applyPreference(page, 'data-theme', theme);

        const painted = await row.evaluate((element) => {
          const surface = element.closest('[data-testid="shortcut-sheet"]')!;
          return {
            surface: getComputedStyle(surface).backgroundColor,
            ink: getComputedStyle(element).color,
          };
        });

        expect
          .soft(painted.surface, `${theme ?? 'light'} sheet surface`)
          .not.toMatch(/rgba\([^)]*,\s*0\)$/);
        expect.soft(painted.ink, `${theme ?? 'light'} row ink`).not.toBe(painted.surface);
      }

      await applyPreference(page, 'data-theme', null);
    });

    test('survives the largest font scale and the compact density', async ({ page }) => {
      await applyPreference(page, 'data-font-scale', '2xl');
      await applyPreference(page, 'data-density', 'compact');

      const dialog = await openSheet(page);
      const box = (await dialog.boundingBox())!;

      expect(box.y).toBeGreaterThanOrEqual(0);
      await expect(dialog.getByRole('button', { name: 'Done' })).toBeVisible();

      await applyPreference(page, 'data-font-scale', null);
      await applyPreference(page, 'data-density', null);
    });

    test('hides the chips, and only the chips, with the keyboard-hints preference', async ({
      page,
    }) => {
      await openSheet(page);
      const row = page.locator('[data-shortcut="jump-projects"]');

      await expect(row.locator('.kbd-group')).toBeVisible();
      await applyPreference(page, 'data-kbd-hints', 'off');

      await expect(row.locator('.kbd-group')).toBeHidden();
      // The chord is still written down for a screen reader, outside the hidden group.
      await expect(row).toContainText('Projects');
      expect(
        await row.locator('.sr-only').evaluate((el) => getComputedStyle(el).display)
      ).not.toBe('none');

      await applyPreference(page, 'data-kbd-hints', null);
    });
  });

  test.describe('the keyboard', () => {
    test('opens on ? from the page, and not from a text field', async ({ page }) => {
      await page.keyboard.press('Shift+Slash');
      await expect(page.getByTestId('shortcut-sheet')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('shortcut-sheet')).toBeHidden();

      // A field on the page — the gallery has none, so one is added the way a filter box is.
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'typing-here';
        document.body.append(input);
        input.focus();
      });

      await page.keyboard.press('Shift+Slash');
      await expect(page.getByTestId('shortcut-sheet')).toBeHidden();
      expect(await page.inputValue('#typing-here')).toBe('?');
    });

    test('traps focus while open and gives it back on close', async ({ page }) => {
      const trigger = page.getByTestId('open-shortcut-sheet');
      await trigger.click();
      await expect(page.getByTestId('shortcut-sheet')).toBeVisible();

      // Ten tabs cannot walk out of a trapped dialog.
      for (let index = 0; index < 10; index += 1) await page.keyboard.press('Tab');
      const inside = await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-testid="shortcut-sheet"]'))
      );
      expect(inside).toBe(true);

      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
    });

    test('runs a jump from the sheet, for a reader who cannot press the chord', async ({
      page,
    }) => {
      await openSheet(page);
      await page.getByTestId('shortcut-run-jump-catalog').click();

      await expect(page.getByTestId('shortcut-sheet')).toBeHidden();
      await expect(page.getByTestId('shortcut-choice')).toHaveText('Last run: Jump to Catalog');
    });
  });

  test.describe('generated, not written down', () => {
    test('loses a section when the thing that registered it goes', async ({ page }) => {
      await openSheet(page);
      await expect(page.getByTestId('shortcut-sheet')).toContainText('On a list');

      await page.keyboard.press('Escape');
      await page.getByTestId('toggle-list').click();

      await openSheet(page);
      await expect(page.locator('[data-shortcut="list-move"]')).toHaveCount(0);
    });

    test('keeps a gated shortcut on screen and states why it cannot be used', async ({ page }) => {
      await page.getByTestId('toggle-workspace').click();
      await openSheet(page);

      const row = page.locator('[data-shortcut="jump-projects"]');
      await expect(row).toContainText('Select a workspace to use Projects.');
      await expect(page.getByTestId('shortcut-run-jump-projects')).toHaveCount(0);
    });
  });

  test.describe('accessibility', () => {
    test('has no serious axe violations, open', async ({ page }) => {
      await openSheet(page);

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .include('[data-testid="shortcut-sheet"]')
        .analyze();

      expect(blockingViolations(results.violations)).toEqual([]);
    });

    test('has no serious axe violations with every workspace row gated', async ({ page }) => {
      await page.getByTestId('toggle-workspace').click();
      await openSheet(page);

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .include('[data-testid="shortcut-sheet"]')
        .analyze();

      expect(blockingViolations(results.violations)).toEqual([]);
    });
  });
});
