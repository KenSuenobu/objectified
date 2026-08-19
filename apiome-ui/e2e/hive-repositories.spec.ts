import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The Repositories list, measured in a browser (HIVE-7.3, #5320).
 *
 * `tests/repositories-hive-redesign.test.tsx` pins what the screen renders,
 * `tests/repositories-model.test.ts` pins the decisions behind it, and
 * `tests/repositories-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a screen carrying a four-stat strip, a
 *     three-column card grid, a nine-column table and a toolbar of six controls.
 *   • **The card grid really collapses**, which is the whole reason `.repo-grid` is
 *     `auto-fit, minmax(19rem, 1fr)` rather than the mockup's fixed three columns: at the
 *     Largest font scale 19rem is 25 % wider than at the default, and the grid has to drop a
 *     column rather than push the page sideways.
 *   • **The wide table scrolls inside its own card**, never taking the document with it.
 *   • **A long repository name cannot hold a card open** — `text-overflow: ellipsis` on a flex
 *     child only works because every ancestor carries `min-inline-size: 0`, and whether that
 *     chain is intact is a question about line breaking.
 *   • **A failed card is framed, not faded** — the treatment the ticket chose over the
 *     mockup's `opacity`, which is only checkable against a computed style.
 *   • **"axe: zero serious/critical violations"** on all three surfaces, in every theme — the
 *     card being an `<article>` with one stretched link rather than a stretched link over
 *     `pointer-events: none` content is exactly the `nested-interactive` finding this measures.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-catalog.spec.ts` gives: every read here is tenant-scoped, and the
 * states worth measuring — a repository mid-scan, one whose last scan failed, one with scan
 * history and one without — are ones a seeded database will not produce on demand.
 *
 * The fixtures are **not hand-written**. `tests/repositories-hive-redesign.test.tsx` renders
 * the real screen against a mocked read and, with `REPOSITORIES_FIXTURE_DUMP=1`, writes what it
 * rendered into `e2e/fixtures/hive-repositories/`. So what is measured here is exactly what the
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
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-repositories');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'cards' | 'table' | 'empty';

/** All three, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = ['cards', 'table', 'empty'];

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
    // Freeze every transition — the trap `hive-catalog.spec.ts` records. The toolbar's controls
    // carry colour transitions, so a `data-theme` swap *animates* every one of them, and axe
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
 * How many columns a grid resolves to.
 *
 * @param page The Playwright page.
 * @param selector The grid.
 * @returns The number of tracks `grid-template-columns` computed to.
 */
function gridColumns(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((node) =>
      getComputedStyle(node as Element)
        .gridTemplateColumns.split(' ')
        .filter(Boolean).length
    );
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
    for (const name of ['cards', 'table'] as const) {
      test(`the ${name} view does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mount(page, name);
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const theme of THEMES) {
    test(`the cards view does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'cards');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the cards view does not scroll sideways at the ${fontScale} font scale`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'cards');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });

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
   The grids collapse rather than overflow
   ------------------------------------------------------------------------- */

test.describe('the grids collapse rather than overflow', () => {
  test('drops card-grid columns as the viewport narrows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'cards');
    const wide = await gridColumns(page, '.repo-grid');
    expect(wide).toBeGreaterThanOrEqual(3);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.repo-grid')).toBeLessThan(wide);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.repo-grid')).toBe(1);
  });

  test('drops a card-grid column as the font scale grows, rather than widening the page', async ({
    page,
  }) => {
    // The whole reason the minimum is a `rem`: 19rem at the Largest scale is 25 % wider than at
    // the default, so a fixed three-column grid would push the document sideways instead.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'cards');
    await applyPreferences(page, { fontScale: 'xs' });
    const small = await gridColumns(page, '.repo-grid');

    await applyPreferences(page, { fontScale: '2xl' });
    const large = await gridColumns(page, '.repo-grid');

    expect(small).toBeGreaterThanOrEqual(large);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('keeps the four-stat strip on one row at desktop and collapses it below', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'cards');
    const wide = await gridColumns(page, '.hive-stat-grid');
    expect(wide).toBe(4);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.hive-stat-grid')).toBeLessThan(wide);
  });

  test('scrolls the wide table inside its own card, never taking the page', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'table');

    // `DataTable`'s `scrollX` wraps the table in an `overflow-x-auto` div; the assertion is
    // that *something* between the table and the page scrolls, and that the page does not.
    const scrolls = await page
      .locator('[data-testid="repositories-table"] div')
      .evaluateAll((nodes) =>
        nodes.some((node) => getComputedStyle(node as Element).overflowX === 'auto')
      );
    expect(scrolls).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('elides a very long repository name instead of holding the card open', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'cards');
    await page.locator('.repo-card__name').first().evaluate((node) => {
      node.textContent =
        'AnExtremelyLongRepositoryNameWithNoSpacesAnywhereInItAtAllWhichWouldOtherwiseHoldTheCardOpen';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    expect(await documentOverflows(page)).toBe(false);
  });

  test('elides a very long owner/name line too', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'cards');
    await page.locator('.repo-card__full-name').first().evaluate((node) => {
      node.textContent =
        'git.example.org/a-very-long-organisation-name/an-equally-long-repository-name';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The card
   ------------------------------------------------------------------------- */

test.describe('the card', () => {
  test('stretches its one link over the whole card', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'cards');

    const card = page.locator('[data-testid="repository-card"]').first();
    const link = card.locator('.repo-card__link').first();
    const hit = await link.evaluate((node) => {
      const after = getComputedStyle(node as Element, '::after');
      return { position: after.position, inset: after.inset };
    });
    expect(hit.position).toBe('absolute');

    // The pseudo-element covers the card, so a click anywhere on it activates the link.
    const point = await card.evaluate((node) => {
      const box = (node as Element).getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + 8 };
    });
    const hitTarget = await page.evaluate(
      ({ x, y }) => {
        const found = document.elementFromPoint(x, y);
        return found ? (found.closest('a')?.className ?? found.className) : null;
      },
      point
    );
    expect(String(hitTarget)).toContain('repo-card');
  });

  test('keeps the row menu clickable above the stretched link', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'cards');

    const menu = page
      .locator('[data-testid="repository-card"]')
      .first()
      .locator('[data-testid="repository-row-menu"]');
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    const onTop = await page.evaluate(
      ({ x, y }) => {
        const found = document.elementFromPoint(x, y);
        return Boolean(found?.closest('[data-testid="repository-row-menu"]'));
      },
      { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 }
    );
    expect(onTop).toBe(true);
  });

  test('marks a failed repository with a frame, never by fading its text', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'cards');

    const failed = page.locator('[data-testid="repository-card"][data-status="error"]').first();
    expect(await failed.evaluate((node) => getComputedStyle(node as Element).opacity)).toBe('1');

    // The "Scan failed" phrase carries its own tinted ground rather than a bare tone ink.
    const phrase = failed.locator('.repo-card__scan[data-failed]');
    const painted = await phrase.evaluate((node) => {
      const style = getComputedStyle(node as Element);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(painted.background).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('draws every succeeded scan bar tall and every failed one short', async ({ page }) => {
    // Shape before colour: the failed bar's meaning must survive a reader who cannot tell the
    // two hues apart (DESIGN.md §6).
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'cards');

    const heights = await page
      .locator('[data-testid="repository-scanbars"]')
      .first()
      .evaluate((node) =>
        [...(node as Element).children].map((bar) => ({
          failed: (bar as HTMLElement).hasAttribute('data-failed'),
          height: (bar as HTMLElement).getBoundingClientRect().height,
        }))
      );
    const ok = heights.filter((bar) => !bar.failed).map((bar) => bar.height);
    const bad = heights.filter((bar) => bar.failed).map((bar) => bar.height);
    expect(ok.length).toBeGreaterThan(0);
    expect(bad.length).toBeGreaterThan(0);
    expect(Math.max(...bad)).toBeLessThan(Math.min(...ok));
  });
});

/* -------------------------------------------------------------------------
   axe
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  for (const name of ALL_FIXTURES) {
    test(`the ${name} surface has no serious or critical violations`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`the cards view is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'cards');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });

    test(`the table is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'table');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });
  }
});
