import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The MCP servers catalog, measured in a browser (HIVE-7.7, #5324).
 *
 * `tests/mcp-catalog-hive-redesign.test.tsx` pins what the screen renders, `mcp-catalog-ui.test.ts`
 * pins the decisions behind it, and `tests/mcp-catalog-css.test.ts` pins the declarations. None of
 * the three can answer the questions that are about *computed layout*, because jsdom compiles no
 * CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both densities
 *     and all six font scales — on a screen carrying a five-control toolbar, a ten-facet grid, two
 *     side-by-side strips, a card grid and a dense row with four badges and a timestamp in it.
 *   • **The grids really collapse.** `auto-fit, minmax(15rem, 1fr)` and
 *     `auto-fill, minmax(19rem, 1fr)` are the reason the facet panel and the card grid hold at the
 *     Largest font scale, where 15rem is 25 % wider than at the default — a stylesheet test can
 *     only assert that they are *written*.
 *   • **The dense row sheds rather than scrolls.** Below 60rem the badge cluster and the timestamp
 *     are `display: none`; whether that is enough to keep a 90-character endpoint name from taking
 *     the document sideways is a question about line breaking.
 *   • **A long name cannot hold a card open** — `text-overflow: ellipsis` on the name only works
 *     because every ancestor carries `min-inline-size: 0`, and whether that chain is intact is a
 *     computed-layout fact.
 *   • **"axe: zero serious/critical violations"** on all three surfaces, in every theme.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-repository-bring-in.spec.ts` gives: every read here is tenant-scoped, and
 * the states worth measuring — a workspace with two hosts, a quarantined endpoint and two shadowed
 * names — are ones a seeded database will not produce on demand.
 *
 * The fixtures are **not hand-written**. `tests/mcp-catalog-hive-redesign.test.tsx` renders the
 * real screen against mocked reads and, with `MCP_FIXTURE_DUMP=1`, writes what it rendered into
 * `e2e/fixtures/hive-mcp-catalog/`. So what is measured here is exactly what the components
 * compose — the classes, the nesting, the ARIA — and the jsdom suite is what keeps the fixtures
 * honest.
 *
 * This loads `/login`, which compiles the real `globals.css` and needs no session, and injects the
 * fixtures into it. Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default
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
const WIDTHS = [1440, DESKTOP_WIDTH, 1100, 1024, 960, 900, 768, 640, 420];

/** Where the jsdom suite writes what it rendered. */
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-mcp-catalog');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'catalog-grid' | 'catalog-list' | 'catalog-empty';

/** All three, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = ['catalog-grid', 'catalog-list', 'catalog-empty'];

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
 * @param page The Playwright page.
 * @param name Which fixture.
 */
async function mount(page: Page, name: Fixture): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((html) => {
    document.body.innerHTML = `<main style="min-height:100vh;background:var(--bg-canvas)">${html}</main>`;
    document.body.style.margin = '0';
    // Freeze every transition — the trap `hive-repositories.spec.ts` records. The cards carry
    // box-shadow and background transitions, so a `data-theme` swap *animates* every one of
    // them, and axe sampling mid-animation reports a `color-contrast` failure against a colour
    // that exists in neither theme. A measurement has to be of a settled frame.
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
 * How many columns a grid actually draws.
 *
 * `auto-fit`/`auto-fill` report their *whole* track list, collapsed tracks included, so the
 * zero-width tracks are dropped — they are not a number a reader can see.
 *
 * @param page The Playwright page.
 * @param selector The grid.
 * @returns The number of tracks with a width.
 */
function gridColumns(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate(
      (node) =>
        getComputedStyle(node as Element)
          .gridTemplateColumns.split(' ')
          .filter((track) => track && Number.parseFloat(track) > 0).length
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

test.describe('the catalog keeps the document to one column', () => {
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
    test(`the grid catalog does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'catalog-grid');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    for (const name of ['catalog-grid', 'catalog-list'] as Fixture[]) {
      test(`the ${name} surface does not scroll sideways at the ${fontScale} font scale`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, name);
        await applyPreferences(page, { fontScale });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const density of ['comfortable', 'compact']) {
    test(`the grid catalog does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'catalog-grid');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The grids really collapse
   ------------------------------------------------------------------------- */

test.describe('the grids collapse rather than overflow', () => {
  test('the card grid loses columns as the viewport narrows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'catalog-grid');
    const wide = await gridColumns(page, '.mcp-grid');
    expect(wide).toBeGreaterThanOrEqual(2);

    await page.setViewportSize({ width: 640, height: 900 });
    expect(await gridColumns(page, '.mcp-grid')).toBe(1);
  });

  test('the card grid loses columns as the font scale grows, at one width', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'catalog-grid');
    const atDefault = await gridColumns(page, '.mcp-grid');

    await applyPreferences(page, { fontScale: '2xl' });
    // 19rem is 25 % wider at the Largest stop, which a px breakpoint could not have known.
    expect(await gridColumns(page, '.mcp-grid')).toBeLessThanOrEqual(atDefault);
  });

  test('the facet panel and the strips fold to one column on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'catalog-grid');
    expect(await gridColumns(page, '.mcp-facets')).toBe(1);
    expect(await gridColumns(page, '.mcp-strips')).toBe(1);
  });

  test('the two strips sit side by side on a desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'catalog-grid');
    expect(await gridColumns(page, '.mcp-strips')).toBe(2);
  });
});

/* -------------------------------------------------------------------------
   The dense row sheds rather than scrolls
   ------------------------------------------------------------------------- */

test.describe('the dense row', () => {
  test('shows its badges and timestamp on a desktop', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'catalog-list');
    await expect(page.locator('.mcp-row__badges').first()).toBeVisible();
    await expect(page.locator('.mcp-row__when').first()).toBeVisible();
  });

  test('sheds them below the breakpoint rather than taking the page sideways', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await mount(page, 'catalog-list');
    await expect(page.locator('.mcp-row__badges').first()).toBeHidden();
    await expect(page.locator('.mcp-row__when').first()).toBeHidden();
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   A long name cannot hold a card open
   ------------------------------------------------------------------------- */

test.describe('long content', () => {
  test('a 90-character endpoint name is clipped rather than widening the grid', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'catalog-grid');

    const before = await page.locator('.mcp-card').first().evaluate((node) => node.clientWidth);
    await page.locator('.mcp-card__name').first().evaluate((node) => {
      node.textContent = 'A'.repeat(90);
    });
    const after = await page.locator('.mcp-card').first().evaluate((node) => node.clientWidth);

    expect(after).toBe(before);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('a long saved-view summary wraps inside its strip', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'catalog-grid');

    const strip = page.locator('[data-testid="mcp-saved-searches"]');
    const before = await strip.evaluate((node) => node.clientWidth);
    await page.locator('.mcp-strip__row-sub').first().evaluate((node) => {
      node.textContent = `Filters: ${'Transport streamable_http, '.repeat(12)}`;
    });
    expect(await strip.evaluate((node) => node.clientWidth)).toBe(before);
    expect(await documentOverflows(page)).toBe(false);
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
    test(`the grid catalog is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'catalog-grid');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  test('the dense list is clean in the two darkest themes', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    for (const theme of ['nord', 'darcula']) {
      await mount(page, 'catalog-list');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    }
  });
});
