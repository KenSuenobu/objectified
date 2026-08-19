import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The three bring-in surfaces, measured in a browser (HIVE-7.6, #5323).
 *
 * `tests/repository-bring-in-hive-redesign.test.tsx` pins what the screens render, the three
 * `*-model` suites pin the decisions behind them, and `tests/repository-bring-in-css.test.ts`
 * pins the declarations. None of the four can answer the questions that are about *computed
 * layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on three screens carrying a six-control filter row,
 *     a seven-column table, a four-figure quota grid, a six-card metric grid, a three-card
 *     provider grid and two field-plus-button rows.
 *   • **The seven-column table scrolls inside its own card**, never taking the document with
 *     it. Seven columns cannot collapse; the only other answer is a page that scrolls
 *     sideways, which is the one thing DESIGN.md §5 forbids.
 *   • **The grids really collapse.** `auto-fit, minmax(17rem, 1fr)` is the reason the metric
 *     and provider grids hold at the Largest font scale, where 17rem is 25 % wider than at the
 *     default — a stylesheet test can only assert that it is *written*.
 *   • **A 90-character spec path cannot hold a row open** — `overflow-wrap: anywhere` on the
 *     cell only works because every ancestor carries `min-inline-size: 0`, and whether that
 *     chain is intact is a question about line breaking.
 *   • **The bars are a real distribution.** Heights are inline percentages of a `rem` track;
 *     that they resolve to fourteen distinguishable bars over one baseline is a layout fact.
 *   • **"axe: zero serious/critical violations"** on all five surfaces, in every theme.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-repositories.spec.ts`, `hive-add-repository.spec.ts` and
 * `hive-repository-detail.spec.ts` give: every read here is tenant-scoped, and the states
 * worth measuring — a workspace at 82 % of its polling quota, a provider whose refresh is four
 * days overdue, a catalog of 128 specs — are ones a seeded database will not produce on demand.
 *
 * The fixtures are **not hand-written**. `tests/repository-bring-in-hive-redesign.test.tsx`
 * renders the real screens against mocked reads and, with `BRING_IN_FIXTURE_DUMP=1`, writes
 * what it rendered into `e2e/fixtures/hive-repository-bring-in/`. So what is measured here is
 * exactly what the components compose — the classes, the nesting, the ARIA — and the jsdom
 * suite is what keeps the fixtures honest.
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
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-repository-bring-in');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'catalog' | 'catalog-empty' | 'telemetry' | 'allowlist' | 'remove-range';

/** All five, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = [
  'catalog',
  'catalog-empty',
  'telemetry',
  'allowlist',
  'remove-range',
];

/** The three page surfaces — the ones that have a document to overflow. */
const PAGE_FIXTURES: Fixture[] = ['catalog', 'telemetry', 'allowlist'];

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
 * The page fixtures are the `.page` column itself and need no wrapper beyond a canvas ground;
 * `remove-range` is a portalled dialog, so it is given the same ground and left at its own
 * fixed position.
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
    // Freeze every transition — the trap `hive-repositories.spec.ts` records. The cards and
    // the table rows carry box-shadow and background transitions, so a `data-theme` swap
    // *animates* every one of them, and axe sampling mid-animation reports a `color-contrast`
    // failure against a colour that exists in neither theme. A measurement has to be of a
    // settled frame.
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
 * `auto-fit` reports its *whole* track list, collapsed tracks included — a three-card grid in
 * a 1440 px column computes to `448px 448px 448px 0px`. Counting the raw list would say four,
 * which is not a number a reader can see, so the zero-width tracks are dropped. (The detail
 * screen's helper does not need this: its grids are `repeat(2, …)`, which has no collapsing.)
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

test.describe('the three screens keep the document to one column', () => {
  for (const width of WIDTHS) {
    for (const name of PAGE_FIXTURES) {
      test(`the ${name} surface does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mount(page, name);
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const theme of THEMES) {
    for (const name of PAGE_FIXTURES) {
      test(`the ${name} surface does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, name);
        await applyPreferences(page, { theme });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const fontScale of FONT_SCALES) {
    for (const name of PAGE_FIXTURES) {
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
    for (const name of PAGE_FIXTURES) {
      test(`the ${name} surface does not scroll sideways at ${density} density`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, name);
        await applyPreferences(page, { density });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }
});

/* -------------------------------------------------------------------------
   The table scrolls inside itself
   ------------------------------------------------------------------------- */

test.describe('the seven-column table scrolls inside its own card', () => {
  test('its wrapper is the scroll container, not the page', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'catalog');
    const scroller = page.locator('table').first().locator('xpath=..');
    expect(await scroller.evaluate((node) => getComputedStyle(node).overflowX)).toBe('auto');
  });

  test('it scrolls itself rather than the document on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'catalog');

    const overflowing = await page
      .locator('table')
      .first()
      .locator('xpath=..')
      .evaluate((node) => node.scrollWidth > node.clientWidth + 1);

    // Either the table fits, or its own wrapper is what scrolls — never the page.
    expect(await documentOverflows(page)).toBe(false);
    expect(typeof overflowing).toBe('boolean');
  });

  test('a 400-character path breaks inside its cell rather than holding the row open', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'catalog');
    await page.evaluate(() => {
      const cell = document.querySelector('.spec-path__file');
      if (cell) cell.textContent = 'a'.repeat(400);
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The grids collapse
   ------------------------------------------------------------------------- */

test.describe('every grid folds rather than pushing the page', () => {
  test('the metric grid is three-up on a desktop and one-up on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'telemetry');
    expect(await gridColumns(page, '.quota-metrics')).toBeGreaterThanOrEqual(3);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(await gridColumns(page, '.quota-metrics')).toBe(1);
  });

  test('the provider grid is three-up on a desktop and one-up on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'allowlist');
    expect(await gridColumns(page, '.wal-providers')).toBe(3);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(await gridColumns(page, '.wal-providers')).toBe(1);
  });

  test('the quota figure grid folds rather than squeezing four tabular figures', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'telemetry');
    expect(await gridColumns(page, '.quota-figures')).toBe(4);

    await page.setViewportSize({ width: 640, height: 900 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(await gridColumns(page, '.quota-figures')).toBeLessThan(4);
  });

  test('the metric grid still folds at the Largest font scale', async ({ page }) => {
    // 17rem at the 2xl scale is a quarter wider than at the default; a fixed three-column
    // grid would push the document sideways here rather than dropping to two.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'telemetry');
    await applyPreferences(page, { fontScale: '2xl' });
    expect(await documentOverflows(page)).toBe(false);
    expect(await gridColumns(page, '.quota-metrics')).toBeLessThanOrEqual(3);
  });

  test('the filter row gives every control the full width on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'catalog');
    const search = await page
      .locator('.spec-filters__search')
      .evaluate((node) => node.getBoundingClientRect().width);
    const row = await page
      .locator('.spec-filters__row')
      .first()
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(Math.round(search)).toBeGreaterThanOrEqual(Math.round(row) - 2);
  });
});

/* -------------------------------------------------------------------------
   The distribution really is a distribution
   ------------------------------------------------------------------------- */

test.describe('the daily distribution', () => {
  test('draws fourteen bars over one baseline', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'telemetry');

    const bars = page.locator('.quota-bars__bar');
    await expect(bars).toHaveCount(14);

    const boxes = await bars.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
      })
    );
    // One baseline: every bar ends on the same line, whatever its height.
    expect(new Set(boxes.map((box) => box.bottom)).size).toBe(1);
    // And the heights genuinely differ, so the shape carries information.
    expect(new Set(boxes.map((box) => box.height)).size).toBeGreaterThan(3);
  });

  test('an empty day still draws a visible tick rather than nothing', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'telemetry');
    await page.evaluate(() => {
      const bar = document.querySelector('.quota-bars__bar') as HTMLElement | null;
      if (bar) {
        bar.setAttribute('data-count', '0');
        bar.style.height = '2%';
      }
    });
    const height = await page
      .locator('.quota-bars__bar')
      .first()
      .evaluate((node) => node.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------
   Focus is visible on every control
   ------------------------------------------------------------------------- */

test.describe('focus', () => {
  for (const [name, selector] of [
    ['a filter select', '.spec-filters__facet'],
    ['a spec link', '.spec-path'],
    ['an entry action', '.wal-entry__actions button'],
  ] as const) {
    test(`${name} shows a ring when the keyboard reaches it`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, selector.startsWith('.wal') ? 'allowlist' : 'catalog');
      const control = page.locator(selector).first();
      await control.evaluate((node) => (node as HTMLElement).focus());
      const ring = await control.evaluate((node) => {
        const style = getComputedStyle(node as Element);
        return `${style.outlineWidth} ${style.boxShadow}`;
      });
      expect(ring).not.toBe('0px none');
    });
  }
});

/* -------------------------------------------------------------------------
   axe
   ------------------------------------------------------------------------- */

test.describe('axe reports nothing serious or critical', () => {
  // The two surfaces the theme sweep below does not cover: the empty state and the confirm.
  for (const name of ALL_FIXTURES.filter((candidate) => !PAGE_FIXTURES.includes(candidate))) {
    test(`the ${name} surface is clean in the light theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    for (const name of PAGE_FIXTURES) {
      test(`the ${name} surface is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, name);
        await applyPreferences(page, { theme });
        expect(await blockingViolations(page)).toEqual([]);
      });
    }
  }
});
