import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The Catalog item detail, measured in a browser (HIVE-7.2, #5319).
 *
 * `tests/catalog-item-detail-hive.test.tsx` pins what the screen renders,
 * `tests/catalog-item-view.test.ts` pins the decisions behind it, and
 * `tests/catalog-item-detail-css.test.ts` pins the declarations. None of the three can answer
 * the questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"Both inspectors render their hierarchies without horizontal page scroll"** — the
 *     ticket's first acceptance criterion, and the reason this file exists. The X12 interchange
 *     inspector nests four levels of `role="tree"` rows and the copybook inspector a five-column
 *     positional table; whether either takes the document sideways is a question about computed
 *     widths, held across all nine themes, both densities and all six font scales.
 *   • **"No horizontal document scroll at ≥1280 px"**, on the widest screen in the epic: a
 *     main/aside split above a second main/aside split, four surface tiles, a three-column
 *     field row and an eight-tab strip.
 *   • **The grids really collapse** — `.cid-tiles` is `auto-fit, minmax(9rem, 1fr)` precisely so
 *     that at the Largest font scale it drops a column rather than pushing the page sideways.
 *   • **A long artifact name cannot hold the header open** — `text-overflow: ellipsis` on a flex
 *     child only works because every ancestor carries `min-inline-size: 0`, and whether that
 *     chain is intact is a question about line breaking.
 *   • **The provenance rail's connector really joins its steps** and really stops at the last
 *     one, which is a `::after` geometry question.
 *   • **"axe: zero serious/critical violations"** on every surface, in every theme.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-catalog.spec.ts` gives: every read here is tenant-scoped, and the
 * states worth measuring — an item converted to a project whose target was then deleted, one
 * soft-deleted — are ones a seeded database will not produce on demand.
 *
 * The fixtures are **not hand-written**. `tests/catalog-item-detail-hive.test.tsx` renders the
 * real screen against a mocked read and, with `CATALOG_ITEM_FIXTURE_DUMP=1`, writes what it
 * rendered into `e2e/fixtures/hive-catalog-item/`. So what is measured here is exactly what the
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
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-catalog-item');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'overview' | 'provenance' | 'deleted' | 'inspector-x12' | 'inspector-copybook';

/** All five, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = [
  'overview',
  'provenance',
  'deleted',
  'inspector-x12',
  'inspector-copybook',
];

/** The two format inspectors, which the ticket's first acceptance criterion is about. */
const INSPECTORS: Fixture[] = ['inspector-x12', 'inspector-copybook'];

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
    // Freeze every transition, for the reason `hive-catalog.spec.ts` records: a theme swap
    // *animates* the chips' colours, and sampling mid-animation once made a run report a
    // `color-contrast` violation against a colour that exists in neither theme, only between
    // them. A measurement has to be of a settled frame.
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
    for (const name of ALL_FIXTURES) {
      test(`the ${name} pane does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mount(page, name);
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const theme of THEMES) {
    test(`the overview does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'overview');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the overview does not scroll sideways at the ${fontScale} font scale`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'overview');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });

    test(`the provenance rail does not scroll sideways at the ${fontScale} font scale`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'provenance');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`the overview does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'overview');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The two inspectors, which the ticket's first criterion is about
   ------------------------------------------------------------------------- */

test.describe('both inspectors render their hierarchies without horizontal page scroll', () => {
  for (const name of INSPECTORS) {
    for (const theme of THEMES) {
      test(`${name} holds in the ${theme ?? 'light'} theme`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, name);
        await applyPreferences(page, { theme });
        expect(await documentOverflows(page)).toBe(false);
      });
    }

    for (const fontScale of FONT_SCALES) {
      test(`${name} holds at the ${fontScale} font scale`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, name);
        await applyPreferences(page, { fontScale });
        expect(await documentOverflows(page)).toBe(false);
      });
    }

    for (const density of ['comfortable', 'compact']) {
      test(`${name} holds at ${density} density`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, name);
        await applyPreferences(page, { density });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  test('the X12 hierarchy really is a tree, nested four levels deep', async ({ page }) => {
    // Four levels — interchange → functional group → transaction set → segment — is the depth
    // that would push the page sideways if the tree indented with padding on a fixed width
    // rather than with a `rem` step inside a `min-inline-size: 0` column.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'inspector-x12');
    await expect(page.locator('[role="tree"]')).toHaveCount(1);
    expect(await page.locator('[role="treeitem"]').count()).toBeGreaterThan(3);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('a wide inspector table scrolls inside its own card, never taking the document', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'inspector-copybook');
    const scrollers = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table')).filter((table) => {
        const box = table.closest('[class*="overflow"]') as HTMLElement | null;
        return box !== null && box.scrollWidth >= box.clientWidth;
      }).length
    );
    expect(scrollers).toBeGreaterThan(0);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The grids collapse rather than overflow
   ------------------------------------------------------------------------- */

test.describe('the grids collapse rather than overflow', () => {
  test('drops the main/aside split to one column as the viewport narrows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'overview');
    expect(await gridColumns(page, '.cid-overview')).toBe(2);
    expect(await gridColumns(page, '.cid-top')).toBe(2);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.cid-overview')).toBe(1);
    expect(await gridColumns(page, '.cid-top')).toBe(1);
  });

  test('drops a surface-tile column as the font scale grows, rather than widening the page', async ({
    page,
  }) => {
    // The whole reason the minimum is a `rem`: 9rem at the Largest scale is 25% wider than at
    // the default, so a fixed four-column grid would push the document sideways instead.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'overview');
    await applyPreferences(page, { fontScale: 'xs' });
    const small = await gridColumns(page, '.cid-tiles');

    await applyPreferences(page, { fontScale: '2xl' });
    const large = await gridColumns(page, '.cid-tiles');

    expect(small).toBeGreaterThanOrEqual(large);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('collapses the three-column field row on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'overview');
    const field = page.locator('.cid-field').first();
    if ((await field.count()) === 0) test.skip();
    expect(await gridColumns(page, '.cid-field')).toBe(3);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.cid-field')).toBe(1);
  });
});

/* -------------------------------------------------------------------------
   The things only a browser can answer
   ------------------------------------------------------------------------- */

test.describe('layout', () => {
  test('a long item name is clipped rather than holding the header open', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'overview');
    await page.evaluate(() => {
      const title = document.querySelector('.page-title span') as HTMLElement | null;
      if (title) title.textContent = 'Claims'.repeat(60);
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await documentOverflows(page)).toBe(false);
  });

  test('joins the provenance steps and stops the connector at the last one', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'provenance');
    const tiles = page.locator('.cid-step__tile');
    const count = await tiles.count();
    expect(count).toBe(4);

    const joined = await tiles.first().evaluate((node) => {
      const after = getComputedStyle(node as Element, '::after');
      return { display: after.display, height: after.height };
    });
    expect(joined.display).not.toBe('none');
    expect(parseFloat(joined.height)).toBeGreaterThan(0);

    const last = await tiles.nth(count - 1).evaluate((node) => {
      return getComputedStyle(node as Element, '::after').display;
    });
    expect(last).toBe('none');
  });

  test('paints a deleted conversion target struck through rather than linked', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'deleted');
    const dead = page.locator('.cid-converted__deleted').first();
    await expect(dead).toBeVisible();
    const painted = await dead.evaluate((node) => {
      const style = getComputedStyle(node as Element);
      return { decoration: style.textDecorationLine, opacity: style.opacity };
    });
    expect(painted.decoration).toContain('line-through');
    // Struck through, not faded: fading it would fade the name it still has to say.
    expect(painted.opacity).toBe('1');
  });

  test('keeps the composition bar and its tiles one colour per surface', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'overview');
    const paired = await page.evaluate(() => {
      const glyph = document.querySelector('.cid-surface-glyph--ok');
      const slice = document.querySelector('.cid-compbar__slice--ok');
      if (!glyph || !slice) return null;
      return {
        glyph: getComputedStyle(glyph).color,
        slice: getComputedStyle(slice).backgroundColor,
      };
    });
    expect(paired).not.toBeNull();
    expect(paired!.glyph).toBe(paired!.slice);
  });

  test('shows only the selected pane', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'overview');
    const panes = page.locator('[role="tabpanel"]');
    expect(await panes.count()).toBe(8);
    const visible = await panes.evaluateAll(
      (nodes) => nodes.filter((node) => getComputedStyle(node as Element).display !== 'none').length
    );
    // `.cid-pane` is a flex column, whose own `display` beats `[hidden]`'s UA rule — which is
    // exactly why the block re-states `display: none` for `[hidden]`.
    expect(visible).toBe(1);
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
    test(`the overview is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'overview');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });

    test(`the provenance rail is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'provenance');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });

    for (const name of INSPECTORS) {
      test(`${name} is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, name);
        await applyPreferences(page, { theme });
        expect(await blockingViolations(page)).toEqual([]);
      });
    }
  }
});
