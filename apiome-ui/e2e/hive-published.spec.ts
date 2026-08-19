import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The Published versions surface, measured in a browser (HIVE-8.1, #5327).
 *
 * `tests/published-hive-redesign.test.tsx` pins what the screen renders,
 * `tests/published-model.test.ts` pins the decisions behind it, and
 * `tests/published-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a screen carrying a six-column table whose cells
 *     hold a mono URL, a sparkline and a three-line mock block.
 *   • **The wide table scrolls inside its own card**, never taking the document with it. This
 *     is the one screen where that matters most: an access URL is a long unbroken string, and
 *     the column that holds it is the one a reader narrows the window on.
 *   • **A long access URL, project name or revision note cannot hold a column open** —
 *     `text-overflow: ellipsis` works only because every ancestor carries `min-inline-size: 0`,
 *     and whether that chain is intact is a question about line breaking.
 *   • **The copied state is visible without hover**, which is the whole point of making the
 *     Access URL cell the copy control.
 *   • **"axe: zero serious/critical violations"** on all three surfaces, in every theme —
 *     including the visibility toggle, which is a `<button>` wearing badge chrome rather than
 *     the invalid `<button><div/></button>` the screen this replaces drew.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-repositories.spec.ts` gives: every read here is tenant-scoped, and the
 * states worth measuring — a public row with a mock, a private row that needs a key, a
 * deprecated row, and a failed visibility write — are ones a seeded database will not produce
 * on demand.
 *
 * The fixtures are **not hand-written**. `tests/published-hive-redesign.test.tsx` renders the
 * real screen against a mocked read and, with `PUBLISHED_FIXTURE_DUMP=1`, writes what it
 * rendered into `e2e/fixtures/hive-published/`. So what is measured here is exactly what the
 * components compose — the classes, the nesting, the ARIA — and the jsdom suite is what keeps
 * the fixtures honest.
 *
 * This loads `/login`, which compiles the real `globals.css` and needs no session, and injects
 * the fixtures into it. Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default
 * `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §9. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The viewport width DESIGN.md §5 forbids horizontal document scroll at. */
const DESKTOP_WIDTH = 1280;

/** Every theme with a block of its own; `null` is the `:root` light default. */
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

/** The six font-size stops of DESIGN.md §4.1. `md` is the default. */
const FONT_SCALES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];

/** Widths either side of the block's `rem` breakpoints, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1100, 1024, 900, 768, 640, 420];

/** Where the jsdom suite writes what it rendered. */
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-published');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'table' | 'empty' | 'error';

/** All three, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = ['table', 'empty', 'error'];

/**
 * One rendered surface, as the jsdom suite wrote it.
 *
 * @param name Which fixture.
 * @returns Its markup.
 */
function fixture(name: Fixture): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.html`), 'utf8');
}

/**
 * Put markup on a page that has the real stylesheet compiled.
 *
 * Each fixture is the `.page` column itself, so it needs no wrapper beyond a canvas ground.
 *
 * @param page The Playwright page.
 * @param name Which fixture.
 */
async function mount(page: Page, name: Fixture): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((html) => {
    document.body.innerHTML = `<main style="min-height:100vh;background:var(--bg-canvas)">${html}</main>`;
    document.body.style.margin = '0';
    // Freeze every transition — the trap `hive-catalog.spec.ts` records. The toggle and the
    // URL chip both carry colour transitions, so a `data-theme` swap *animates* them, and axe
    // sampling mid-animation reports a `color-contrast` failure against a colour that exists in
    // neither theme. A measurement has to be of a settled frame.
    const frozen = document.createElement('style');
    frozen.id = 'e2e-frozen';
    frozen.textContent =
      '*,*::before,*::after{transition:none!important;animation:none!important}';
    document.head.appendChild(frozen);
  }, fixture(name));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/**
 * Set the appearance preferences the tokens key off.
 *
 * @param page The Playwright page.
 * @param options Which theme, font scale and density to apply.
 */
async function applyPreferences(
  page: Page,
  options: { theme?: string | null; fontScale?: string; density?: string }
): Promise<void> {
  await page.evaluate(
    ({ theme, fontScale, density }) => {
      const root = document.documentElement;
      if (theme) root.setAttribute('data-theme', theme);
      else root.removeAttribute('data-theme');
      if (fontScale) root.setAttribute('data-font-scale', fontScale);
      if (density) root.setAttribute('data-density', density);
    },
    options as { theme?: string | null; fontScale?: string; density?: string }
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/**
 * Whether the document scrolls sideways.
 *
 * @param page The Playwright page.
 * @returns True when the document is wider than the viewport.
 */
function documentOverflows(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // A one-pixel tolerance: sub-pixel layout rounding is not a horizontal scrollbar.
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth > 1;
  });
}

/**
 * The serious and critical half of an axe run.
 *
 * @param page The Playwright page.
 * @returns The rule ids that block, which DESIGN.md §9 requires to be empty.
 */
async function blockingViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations
    .filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))
    .map((violation) => violation.id);
}

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the screen keeps the document to one column', () => {
  for (const width of WIDTHS) {
    for (const name of ALL_FIXTURES) {
      test(`the ${name} surface does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mount(page, name);
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const theme of THEMES) {
    test(`the table does not scroll sideways in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'table');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the table does not scroll sideways at the ${fontScale} font scale`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'table');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`the table does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'table');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The table scrolls inside its own card
   ------------------------------------------------------------------------- */

test.describe('the table scrolls inside its own card', () => {
  test('puts an overflow-x scroller between the table and the page', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'table');

    const scrolls = await page
      .locator('[data-testid="published-table"] div')
      .evaluateAll((nodes) =>
        nodes.some((node) => getComputedStyle(node as Element).overflowX === 'auto')
      );
    expect(scrolls).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('elides a very long access URL rather than holding the column open', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'table');

    await page.locator('.pub-url__code').first().evaluate((node) => {
      node.textContent =
        'schema/an-extremely-long-tenant-slug/an-equally-long-project-slug/2026.08.19-release-candidate-4';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    expect(await documentOverflows(page)).toBe(false);
    const clipped = await page
      .locator('.pub-url__code')
      .first()
      .evaluate((node) => {
        const element = node as HTMLElement;
        return element.scrollWidth > element.clientWidth;
      });
    expect(clipped).toBe(true);
  });

  test('elides a very long revision note too', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'table');

    await page.locator('.pub-version__desc').first().evaluate((node) => {
      node.textContent =
        'AnExtremelyLongRevisionNoteWithNoSpacesAnywhereInItAtAllWhichWouldOtherwiseHoldTheColumnOpenForever';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    expect(await documentOverflows(page)).toBe(false);
  });

  test('elides a very long project name too', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'table');

    await page.locator('.pub-version .font-medium').first().evaluate((node) => {
      node.textContent = 'AnExtremelyLongProjectNameThatNobodyWouldEverTypeButSomebodyEventuallyWill';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The cells
   ------------------------------------------------------------------------- */

test.describe('the cells', () => {
  test('tops-aligns the multi-line rows rather than centring them', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'table');

    const aligned = await page
      .locator('[data-testid="published-table"] tbody td')
      .first()
      .evaluate((node) => getComputedStyle(node as Element).verticalAlign);
    expect(aligned).toBe('top');
  });

  test('shows the copy glyph on hover and keeps it shown once copied', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'table');

    const cell = page.locator('.pub-url').first();
    const glyph = cell.locator('.pub-url__glyph');
    expect(await glyph.evaluate((node) => getComputedStyle(node as Element).opacity)).toBe('0');

    await cell.hover();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await glyph.evaluate((node) => getComputedStyle(node as Element).opacity)).toBe('1');

    // The copied state must not depend on the pointer still being there.
    await cell.evaluate((node) => (node as HTMLElement).setAttribute('data-copied', ''));
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await glyph.evaluate((node) => getComputedStyle(node as Element).opacity)).toBe('1');
  });

  test('draws the visibility toggle as a real button, not a div inside one', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'table');

    const toggles = page.locator('[data-testid^="published-visibility-"]');
    expect(await toggles.count()).toBeGreaterThan(0);
    const tags = await toggles.evaluateAll((nodes) => nodes.map((node) => node.tagName));
    expect(new Set(tags)).toEqual(new Set(['BUTTON']));
    // A `<button>` may only contain phrasing content; a nested block element is what the
    // screen this replaces drew.
    const nested = await toggles.evaluateAll((nodes) =>
      nodes.some((node) => node.querySelector('div') !== null)
    );
    expect(nested).toBe(false);
  });

  test('gives the deprecated row a pill that is a link to the sunset timeline', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'table');

    const pill = page.locator('.pub-version__lifecycle').first();
    await expect(pill).toHaveAttribute('href', '/ade/dashboard/versions/sunset-timeline');
    expect(await pill.evaluate((node) => getComputedStyle(node as Element).textDecorationLine)).toBe(
      'none'
    );
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  for (const name of ALL_FIXTURES) {
    test(`the ${name} surface has no serious or critical axe violations`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`the table has no serious or critical axe violations in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'table');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  test('names every column, including the actions column that has no visible header', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'table');

    const named = await page
      .locator('[data-testid="published-table"] thead th')
      .evaluateAll((nodes) =>
        nodes.every((node) => (node.textContent ?? '').trim().length > 0)
      );
    expect(named).toBe(true);
  });
});
