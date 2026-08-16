import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The DataTable primitive, measured in a browser (HIVE-2.3, #5282).
 *
 * `tests/hive-data-table.test.tsx` pins what the component renders and
 * `tests/hive-data-table-url-state.test.ts` pins the URL codec. Neither can answer the two
 * acceptance criteria that are questions about *layout*, because jsdom compiles no CSS and
 * has no scroll:
 *
 *   • **"Sticky header stays put while the body scrolls inside the card."** There is no
 *     other way to check this than to scroll something and read a bounding box.
 *   • **"Wide tables scroll inside their own container — never the page."** Which means
 *     measuring the document at 1280 px, the width DESIGN.md §5 sets the floor at.
 *
 * It also re-checks in a real browser the three things a stylesheet could quietly undo: the
 * row actions really are invisible until the row is hovered, the bulk bar really rises from
 * the bottom edge, and the dense variant really is shorter than the comfortable one at the
 * same font scale.
 *
 * Runs against `/design-system/hive#tables` — the gallery route, which needs no session and
 * no data, so this suite is deterministic. Requires the app to be running
 * (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The one section of the gallery this ticket owns. */
const OWNED_SECTION = '#tables';

/** The viewport width DESIGN.md §5 forbids horizontal document scroll at. */
const DESKTOP_WIDTH = 1280;

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
 * Freeze every transition and animation.
 *
 * The row actions fade over `--dur-fast`, so a visibility read taken right after a hover
 * returns a mid-transition opacity — half-revealed actions look like no actions at all.
 *
 * @param page The page to freeze.
 */
async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
}

/**
 * Open the gallery at the Tables section.
 *
 * @param page The page to drive.
 */
async function openTables(page: Page): Promise<void> {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto('/design-system/hive');
  await expect(page.getByRole('table', { name: 'Projects' })).toBeVisible();
  await freezeMotion(page);
}

test.describe('DataTable', () => {
  test.beforeEach(async ({ page }) => {
    await openTables(page);
  });

  test.describe('layout', () => {
    test('never forces the document sideways at the desktop width', async ({ page }) => {
      // DESIGN.md §5, checked at the width it names. The Catalog specimen is the widest
      // thing in the section, so if anything here can push the page out, it is this.
      await expect(page.getByRole('table', { name: 'Catalog' })).toBeVisible();
      const documentScrolls = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      );
      expect(documentScrolls).toBe(false);
    });

    test('a wide table scrolls inside its own card, and still never takes the page', async ({
      page,
    }) => {
      // Narrow enough that the table's `min-width` cannot fit — which is the situation the
      // `scrollX` container exists for. At 1280 px the specimen fits, so measuring there
      // would prove nothing about the overflow behaviour.
      await page.setViewportSize({ width: 820, height: 900 });

      const table = page.getByRole('table', { name: 'Catalog' });
      const scroller = page.locator('div.overflow-x-auto').filter({ has: table });

      await expect
        .poll(() => scroller.evaluate((element) => element.scrollWidth > element.clientWidth))
        .toBe(true);

      await scroller.evaluate((element) => {
        element.scrollLeft = 200;
      });
      expect(await scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

      // The card moved; the document did not.
      const documentScrolls = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      );
      expect(documentScrolls).toBe(false);
    });

    test('the header stays put while the body scrolls under it', async ({ page }) => {
      // The gallery's tables are not capped, so cap one here: the criterion is about the
      // sticky rule, not about which specimen happens to be tall.
      const scroller = page
        .locator('div')
        .filter({ has: page.getByRole('table', { name: 'Catalog' }) })
        .last();

      await scroller.evaluate((element) => {
        element.style.maxHeight = '6rem';
        element.style.overflowY = 'auto';
      });

      const header = page
        .getByRole('table', { name: 'Catalog' })
        .getByRole('columnheader', { name: 'Item' });
      const before = await header.boundingBox();

      await scroller.evaluate((element) => {
        element.scrollTop = 120;
      });
      const after = await header.boundingBox();

      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      // Within a pixel: the header did not travel with the rows it is labelling.
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
    });

    test('a dense table is shorter than a comfortable one at the same font scale', async ({
      page,
    }) => {
      const comfortable = await page
        .getByRole('table', { name: 'Projects' })
        .locator('tbody tr')
        .first()
        .evaluate((row) => row.getBoundingClientRect().height);

      const dense = await page
        .getByRole('table', { name: 'API keys' })
        .locator('tbody tr')
        .first()
        .evaluate((row) => row.getBoundingClientRect().height);

      expect(dense).toBeLessThan(comfortable);
    });
  });

  test.describe('rows', () => {
    test('reveals a row’s actions on hover, and hides them again', async ({ page }) => {
      const edit = page.getByRole('button', { name: 'Edit Payments API' });
      const opacity = () => edit.evaluate((button) => getComputedStyle(button.closest('div') as HTMLElement).opacity);

      expect(Number(await opacity())).toBe(0);

      await page.getByText('payments-api').hover();
      expect(Number(await opacity())).toBe(1);

      // Somewhere well away from the table.
      await page.getByRole('heading', { name: /Hive primitives/ }).hover();
      expect(Number(await opacity())).toBe(0);
    });

    test('reveals them for the keyboard too, which never hovers anything', async ({ page }) => {
      const edit = page.getByRole('button', { name: 'Edit Payments API' });

      await page.getByRole('table', { name: 'Projects' }).locator('tbody tr').first().focus();
      await page.keyboard.press('.');

      await expect(edit).toBeFocused();
      const opacity = await edit.evaluate(
        (button) => getComputedStyle(button.closest('div') as HTMLElement).opacity
      );
      expect(Number(opacity)).toBe(1);
    });

    test('moves between rows with the arrow keys', async ({ page }) => {
      const rows = page.getByRole('table', { name: 'Projects' }).locator('tbody tr');

      await rows.first().focus();
      await page.keyboard.press('ArrowDown');
      await expect(rows.nth(1)).toBeFocused();

      await page.keyboard.press('ArrowUp');
      await expect(rows.first()).toBeFocused();
    });
  });

  test.describe('selection', () => {
    test('raises the bulk bar off the bottom edge, and lowers it again', async ({ page }) => {
      const bar = page.getByRole('group', { name: 'Bulk actions' });
      await expect(bar).toBeHidden();

      await page.getByRole('checkbox', { name: 'Select Payments API' }).click();
      await expect(bar).toBeVisible();
      await expect(bar).toContainText('1 row selected');

      // Sticky, not static: it holds itself off the bottom of the scroll port.
      expect(await bar.evaluate((element) => getComputedStyle(element).position)).toBe('sticky');

      await page.getByRole('checkbox', { name: 'Select Orders Service' }).click();
      await expect(bar).toContainText('2 rows selected');

      await bar.getByRole('button', { name: 'Clear selection' }).click();
      await expect(bar).toBeHidden();
    });

    test('selects the focused row with X, as DESIGN.md §8 says', async ({ page }) => {
      await page.getByRole('table', { name: 'Projects' }).locator('tbody tr').nth(1).focus();
      await page.keyboard.press('x');

      await expect(page.getByRole('checkbox', { name: 'Select Orders Service' })).toBeChecked();
      await expect(page.getByRole('group', { name: 'Bulk actions' })).toBeVisible();
    });
  });

  test.describe('states', () => {
    /** Switch the Projects specimen between ready, loading, empty and error. */
    const setState = async (page: Page, label: string) => {
      await page.getByRole('radiogroup', { name: 'Table state' }).getByRole('radio', { name: label }).click();
    };

    test('draws skeleton rows rather than a spinner while loading', async ({ page }) => {
      await setState(page, 'Loading');

      const table = page.getByRole('table', { name: 'Projects' });
      await expect(table.locator('tbody .hive-skeleton').first()).toBeVisible();
      // The header is still there: a loading table keeps the shape of what is coming.
      await expect(table.getByRole('columnheader', { name: /Project/ })).toBeVisible();
    });

    test('puts the empty state inside the card, not in place of it', async ({ page }) => {
      await setState(page, 'Empty');

      const table = page.getByRole('table', { name: 'Projects' });
      await expect(table.getByText('No projects yet')).toBeVisible();
      await expect(table.getByRole('columnheader', { name: /Project/ })).toBeVisible();
    });

    test('reports a failed load as an alert', async ({ page }) => {
      await setState(page, 'Error');
      // Scoped to the table: the gallery's §Overlays section renders six `Alert` banners of
      // its own, and a page-wide `getByRole('alert')` would resolve to all of them.
      const table = page.getByRole('table', { name: 'Projects' });
      await expect(table.getByRole('alert')).toContainText('Could not load projects');
    });
  });

  test('the tables section is axe-clean', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include(OWNED_SECTION)
      .analyze();
    expect(blockingViolations(results.violations)).toEqual([]);
  });

  test('stays axe-clean with rows selected and the bulk bar up', async ({ page }) => {
    await page.getByRole('checkbox', { name: 'Select Payments API' }).click();
    await expect(page.getByRole('group', { name: 'Bulk actions' })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include(OWNED_SECTION)
      .analyze();
    expect(blockingViolations(results.violations)).toEqual([]);
  });
});
