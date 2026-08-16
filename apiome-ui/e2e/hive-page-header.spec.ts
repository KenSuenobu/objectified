import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The page chrome, measured in a browser (HIVE-3.5, #5291).
 *
 * `tests/page-header.test.tsx` pins what the header renders and
 * `tests/page-chrome-css.test.ts` pins the stylesheet contract behind it. Neither can
 * answer the two acceptance criteria that are questions about *layout*, because jsdom
 * compiles no CSS and has no scroll:
 *
 *   • **"Long titles + 4 actions at 1280 px produce no horizontal scroll."** The only
 *     honest check is to render the worst case at that width and measure the document.
 *   • **"Sticky header stays legible over scrolled content in all themes."** Which means
 *     scrolling something, reading a bounding box, and reading a composited colour — once
 *     per palette, because the wash is mixed from a token each theme re-declares.
 *
 * It also checks the third criterion a jsdom render can only half state: that the
 * breadcrumb's steps are real `<a href>` navigation, not click handlers.
 *
 * Runs against `/design-system/page-header` — the gallery route, which needs no session and
 * no data, so this suite is deterministic. Requires the app to be running
 * (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The viewport width DESIGN.md §5 forbids horizontal document scroll at. */
const DESKTOP_WIDTH = 1280;

/** The narrow body's cap, in CSS pixels (`--page-narrow`, DESIGN.md §5.3). */
const NARROW_MAX_PX = 920;

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
 * Freeze every transition and animation, so a box read straight after a scroll is final.
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
  await page.goto('/design-system/page-header');
  await expect(page.getByTestId('specimen-list')).toBeVisible();
  await freezeMotion(page);
}

/**
 * Whether the document itself scrolls sideways.
 *
 * @param page The page to measure.
 * @returns True when the document has horizontal overflow.
 */
function documentScrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
}

/**
 * Put a theme on `<html>`, the way `ThemeProvider` does.
 *
 * @param page The page to restyle.
 * @param theme Theme id, or `null` for the `:root` default.
 */
async function applyTheme(page: Page, theme: string | null): Promise<void> {
  await page.evaluate((id) => {
    if (id) document.documentElement.setAttribute('data-theme', id);
    else document.documentElement.removeAttribute('data-theme');
  }, theme);
}

test.describe('page chrome', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page);
  });

  test.describe('layout', () => {
    test('a long title beside four actions never scrolls the document sideways', async ({
      page,
    }) => {
      // The whole reason this component exists: the list specimen's title is the shape of
      // name that used to push the action cluster off the right edge of every screen.
      await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
      expect(await documentScrollsSideways(page)).toBe(false);
    });

    test('holds at the narrowest width the rail still leaves for a page', async ({ page }) => {
      // Below 900 px the rail is icon-only (HIVE-3.1), so a page column can get this
      // narrow on a real device. Nothing about the header may start scrolling then.
      await page.setViewportSize({ width: 760, height: 900 });
      expect(await documentScrollsSideways(page)).toBe(false);
    });

    test('drops the action cluster below the title rather than overlapping it', async ({
      page,
    }) => {
      const frame = page.getByTestId('specimen-list');
      const title = frame.getByRole('heading', { level: 1 });
      const actions = frame.getByTestId('page-header-actions');

      const titleBox = (await title.boundingBox())!;
      const actionsBox = (await actions.boundingBox())!;
      expect(titleBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();

      // Either the cluster sits to the right of the title, or it wrapped underneath it.
      // What it must never do is share the same pixels.
      const sideBySide = actionsBox.x >= titleBox.x + titleBox.width - 1;
      const wrapped = actionsBox.y >= titleBox.y + titleBox.height - 1;
      expect(sideBySide || wrapped).toBe(true);
    });

    test('caps a narrow body at 920 px while its header keeps the page width', async ({
      page,
    }) => {
      const frame = page.getByTestId('specimen-form');
      const body = frame.locator('.page-body');
      const headerInner = frame.locator('.page-header__inner');

      const bodyBox = (await body.boundingBox())!;
      const headerBox = (await headerInner.boundingBox())!;

      expect(bodyBox.width).toBeLessThanOrEqual(NARROW_MAX_PX);
      // `sources/repository-new.html`: the form's column narrows, its title bar does not.
      expect(headerBox.width).toBeGreaterThan(bodyBox.width);
    });
  });

  test.describe('the sticky header', () => {
    test('stays put while the page scrolls under it', async ({ page }) => {
      const frame = page.getByTestId('specimen-list');
      const scroller = frame.locator('.page');
      const header = frame.getByTestId('page-header');

      const before = (await header.boundingBox())!;

      await scroller.evaluate((element) => {
        element.scrollTop = 240;
      });
      expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

      const after = (await header.boundingBox())!;
      // Within a pixel: the header did not travel with the content it is labelling.
      expect(Math.abs(after.y - before.y)).toBeLessThan(2);
    });

    test('stays opaque enough to read over that content, in every theme', async ({ page }) => {
      const frame = page.getByTestId('specimen-list');
      const header = frame.getByTestId('page-header');

      await frame.locator('.page').evaluate((element) => {
        element.scrollTop = 240;
      });

      for (const theme of THEMES) {
        await applyTheme(page, theme);

        const style = await header.evaluate((element) => {
          const computed = getComputedStyle(element);
          return {
            background: computed.backgroundColor,
            blur:
              computed.backdropFilter ||
              computed.getPropertyValue('-webkit-backdrop-filter'),
          };
        });

        // The wash is 86 % of the theme's canvas. A theme whose canvas token were missing
        // or itself translucent would land well under this and the content would show
        // through the title — which is exactly what "stays legible" forbids.
        const alpha = Number(/rgba?\([^)]*?,\s*([\d.]+)\)$/.exec(style.background)?.[1] ?? '1');
        expect
          .soft(alpha, `${theme ?? 'light'} header background: ${style.background}`)
          .toBeGreaterThanOrEqual(0.8);
        expect.soft(style.blur, `${theme ?? 'light'} backdrop-filter`).toContain('blur');
      }

      await applyTheme(page, null);
    });
  });

  test.describe('the breadcrumb', () => {
    test('is a navigation landmark whose steps are real links', async ({ page }) => {
      const trail = page
        .getByTestId('specimen-list')
        .getByRole('navigation', { name: 'Breadcrumb' });

      await expect(trail).toBeVisible();

      const link = trail.getByRole('link', { name: 'Acme Corp' });
      await expect(link).toHaveAttribute('href', '/design-system/page-header');

      // A step that is a group name rather than a destination is not a link, and the last
      // step is where the reader already is.
      await expect(trail.getByRole('link', { name: 'Build' })).toHaveCount(0);
      await expect(trail.getByText('Projects')).toHaveAttribute('aria-current', 'page');
    });

    test('navigates when a step is followed', async ({ page }) => {
      await page
        .getByTestId('specimen-detail')
        .getByRole('navigation', { name: 'Breadcrumb' })
        .getByRole('link', { name: 'Catalog' })
        .click();

      await expect(page).toHaveURL(/\/design-system\/page-header$/);
      await expect(page.getByTestId('specimen-list')).toBeVisible();
    });
  });

  test('has no serious or critical axe violations', async ({ page }) => {
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(blockingViolations(results.violations)).toEqual([]);
  });
});
