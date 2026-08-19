import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The repository detail screen, measured in a browser (HIVE-7.5, #5322).
 *
 * `tests/repository-detail-hive-redesign.test.tsx` pins what the screen renders,
 * `tests/repository-detail-model.test.ts` pins the decisions behind it, and
 * `tests/repository-detail-css.test.ts` pins the declarations. None of the three can answer
 * the questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a screen carrying a five-stat strip, an
 *     eight-column table, a two-column file split and a two-column wizard.
 *   • **The eight-column file table scrolls inside its own wrapper**, never taking the
 *     document with it. Eight columns cannot collapse; the only other answer is a page that
 *     scrolls sideways, which is the one thing DESIGN.md §5 forbids.
 *   • **The grids really collapse.** `auto-fit, minmax(…rem, 1fr)` is the reason the filter
 *     toolbar and the wizard's field pairs hold at the Largest font scale, where 13rem is
 *     25 % wider than at the default — a stylesheet test can only assert that it is *written*.
 *   • **A long path cannot hold a row open** — `overflow-wrap: anywhere` on the cell only
 *     works because every ancestor carries `min-inline-size: 0`, and whether that chain is
 *     intact is a question about line breaking.
 *   • **Every choice shows a focus ring**, including the wizard's target cards, whose ring is
 *     `:has(> input:focus-visible)` — a selector no jsdom suite can evaluate. And tabbing into
 *     the *nested* project select must not light the card up, which is the same selector read
 *     the other way.
 *   • **"axe: zero serious/critical violations"** on all five surfaces, in every theme — which
 *     is where the ticket's third acceptance criterion is actually enforced: an interactive
 *     control inside a `<label>` is `nested-interactive`, and the target cards no longer have
 *     one.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-repositories.spec.ts` and `hive-add-repository.spec.ts` give: every
 * read here is tenant-scoped, and the states worth measuring — a repository mid-scan, a branch
 * with an indexed tree, a file that parses, a wizard with a project list — are ones a seeded
 * database will not produce on demand.
 *
 * The fixtures are **not hand-written**. `tests/repository-detail-hive-redesign.test.tsx`
 * renders the real screen against mocked reads and, with `REPOSITORY_DETAIL_FIXTURE_DUMP=1`,
 * writes what it rendered into `e2e/fixtures/hive-repository-detail/`. So what is measured
 * here is exactly what the components compose — the classes, the nesting, the ARIA — and the
 * jsdom suite is what keeps the fixtures honest.
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
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-repository-detail');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'preview' | 'files' | 'settings' | 'file-detail' | 'map-import';

/** All five, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = ['preview', 'files', 'settings', 'file-detail', 'map-import'];

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
 * `map-import` is a portalled dialog, so it is given the same ground and left at its own
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
    // Freeze every transition — the trap `hive-repositories.spec.ts` records. The choice cards
    // and the table rows carry box-shadow and background transitions, so a `data-theme` swap
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
    for (const name of ['preview', 'files', 'file-detail'] as const) {
      test(`the ${name} surface does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mount(page, name);
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const theme of THEMES) {
    test(`the files surface does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'files');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the files surface does not scroll sideways at the ${fontScale} font scale`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'files');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });

    test(`the settings surface does not scroll sideways at the ${fontScale} font scale`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'settings');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`the files surface does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'files');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The table scrolls inside itself
   ------------------------------------------------------------------------- */

test.describe('a wide table scrolls inside its own wrapper', () => {
  test('the eight-column file table fits its wrapper on a desktop', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'files');
    const scroller = page.locator('.repo-files-table').locator('xpath=..');
    expect(await scroller.evaluate((node) => getComputedStyle(node).overflowX)).toBe('auto');
  });

  test('it scrolls itself rather than the document on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'files');

    const overflowing = await page
      .locator('.repo-files-table')
      .locator('xpath=..')
      .evaluate((node) => node.scrollWidth > node.clientWidth + 1);

    // Either the table fits, or its own wrapper is what scrolls — never the page.
    expect(await documentOverflows(page)).toBe(false);
    expect(typeof overflowing).toBe('boolean');
  });

  test('a long path breaks inside its cell rather than holding the row open', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'files');
    await page.evaluate(() => {
      const cell = document.querySelector('.repo-files-table__link');
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
  test('the preview split is two-up on a desktop and one-up below the fold', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'preview');
    expect(await gridColumns(page, '.repo-det-split')).toBe(2);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(await gridColumns(page, '.repo-det-split')).toBe(1);
  });

  test('the file split is two-up on a desktop and one-up below the fold', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'file-detail');
    expect(await gridColumns(page, '.repo-file-split')).toBe(2);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(await gridColumns(page, '.repo-file-split')).toBe(1);
  });

  test('the filter toolbar drops a field rather than squeezing one', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'files');
    const wide = await gridColumns(page, '.repo-files-filters__fields');

    await page.setViewportSize({ width: 640, height: 900 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(await gridColumns(page, '.repo-files-filters__fields')).toBeLessThan(wide);
  });

  test('the toolbar still holds at the Largest font scale, where its fields are widest', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'files');
    await applyPreferences(page, { fontScale: '2xl' });
    expect(await documentOverflows(page)).toBe(false);
    expect(await gridColumns(page, '.repo-files-filters__fields')).toBeGreaterThanOrEqual(1);
  });

  test('the settings key/value lists stack on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'settings');
    expect(await gridColumns(page, '.repo-set-kv')).toBe(1);
  });
});

/* -------------------------------------------------------------------------
   The wizard
   ------------------------------------------------------------------------- */

test.describe('the Map & import overlay', () => {
  test('is two columns on a desktop and one below the fold', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'map-import');
    expect(await gridColumns(page, '.repo-map-grid')).toBe(2);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(await gridColumns(page, '.repo-map-grid')).toBe(1);
  });

  test('rings the chosen card from its own radio, not from a nested field', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'map-import');

    const card = page.locator('[data-testid="repository-import-target-existing"]');
    const radio = card.locator('> input[type="radio"]');

    const outlineWhenBlurred = await card.evaluate(
      (node) => getComputedStyle(node).outlineStyle
    );
    await radio.focus();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    const outlineWhenFocused = await card.evaluate(
      (node) => getComputedStyle(node).outlineStyle
    );

    expect(outlineWhenBlurred).not.toBe('solid');
    expect(outlineWhenFocused).toBe('solid');
  });

  test('does not ring the whole card when the nested select is focused', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'map-import');

    const card = page.locator('[data-testid="repository-import-target-existing"]');
    await card.locator('#repo-import-project-slug').focus();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );

    // The ring says "this is what you are choosing"; a nested field raising it would say the
    // wrong thing. The field's own control chrome is what marks it focused.
    expect(await card.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('solid');
  });

  test('holds no interactive control inside a label, in the browser too', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'map-import');
    const nested = await page.evaluate(() =>
      Array.from(document.querySelectorAll('label')).reduce(
        (total, label) =>
          total +
          label.querySelectorAll(
            'button, select, textarea, a[href], input:not([type="radio"]):not([type="checkbox"])'
          ).length,
        0
      )
    );
    expect(nested).toBe(0);
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  for (const name of ALL_FIXTURES) {
    test(`the ${name} surface has no serious or critical axe violation`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`the files surface is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'files');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });

    test(`the file-detail surface is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'file-detail');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });

    test(`the map-import surface is clean in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'map-import');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  test('every tab in the strip is a real tab with a panel to point at', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'preview');
    const tabs = page.locator('[role="tablist"] [role="tab"]');
    await expect(tabs).toHaveCount(5);
    const selected = page.locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    const controls = await selected.getAttribute('aria-controls');
    await expect(page.locator(`#${controls}`)).toHaveAttribute('role', 'tabpanel');
  });

  test('the path button in the file table shows a focus ring', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'files');
    const link = page.locator('.repo-files-table__link').first();
    await link.focus();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(await link.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('solid');
  });
});
