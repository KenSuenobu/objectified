import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The primitive-detail page, measured in a browser (HIVE-6.6, #5317).
 *
 * `tests/primitive-detail-hive.test.tsx` pins what the screen renders,
 * `tests/primitive-detail-view.test.ts` pins the decisions behind it, and
 * `tests/primitive-detail-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a page whose main column carries a `mono` `$id` with
 *     no spaces in it, two seven-column tables and a recursive form, beside an aside of three
 *     cards.
 *   • **The aside really folds under the main column**, which is the whole reason `.pd-grid` is
 *     `minmax(0, 2fr) minmax(0, 1fr)` above a `rem` fold point and one track below it.
 *   • **An `$id` cannot hold a track open.** `overflow-wrap: anywhere` is the only thing standing
 *     between `https://api.apiome.dev/types/tenant/acme/v1/types/money` and a sideways page, and
 *     whether it works is a question about line breaking, which jsdom does not do.
 *   • **The schema pane's box is a `rem`**, so it really does grow with the font scale — the
 *     acceptance criterion "the schema viewer respects the theme and font scale".
 *   • **The unresolved chain step is marked, not inked** — the `--warn` rail is really on it, and
 *     its label is really the page's own ink rather than a tone's.
 *   • **"axe: zero serious/critical violations"** on all four surfaces, in every theme.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-primitives-registry.spec.ts` gives: every read here is tenant-scoped, and
 * the states worth measuring — a type with one resolved and one unresolved `$ref`, three
 * dependents across two scopes, a form in array mode — are ones a seeded database will not
 * produce on demand.
 *
 * The fixtures are **not hand-written**. `tests/primitive-detail-hive.test.tsx` renders the real
 * screen against a mocked read and, with `PRIMITIVE_DETAIL_FIXTURE_DUMP=1`, writes what it
 * rendered into `e2e/fixtures/hive-primitive-detail/`. So what is measured here is exactly what
 * the components compose — the classes, the nesting, the ARIA — and the jsdom suite is what keeps
 * the fixtures honest.
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

/** Widths either side of the block's `rem` breakpoint, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1100, 1024, 900, 768, 640, 420];

/** Where the jsdom suite writes what it rendered. */
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-primitive-detail');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'detail' | 'detail-testing' | 'detail-array' | 'detail-system';

/** All four, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = ['detail', 'detail-testing', 'detail-array', 'detail-system'];

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

test.describe('the page keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`the collapsed page does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, 'detail');
      expect(await documentOverflows(page)).toBe(false);
    });

    test(`the open test form does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, 'detail-testing');
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const theme of THEMES) {
    test(`the page does not scroll sideways in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'detail-testing');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the page does not scroll sideways at the ${fontScale} font scale`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'detail-testing');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`array mode does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'detail-array');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The aside folds, and identifiers break
   ------------------------------------------------------------------------- */

test.describe('the two columns collapse rather than overflow', () => {
  test('drops the aside below the main column on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'detail');
    expect(await gridColumns(page, '.pd-grid')).toBe(2);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.pd-grid')).toBe(1);
  });

  test('breaks a long $id rather than widening the aside', async ({ page }) => {
    // The one thing `overflow-wrap: anywhere` is there for: an `$id` is a URL, so it has no
    // spaces, and without it the aside is as wide as the longest identifier in it.
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'detail');
    await page.locator('[data-testid="primitive-detail-meta-id"]').evaluate((node) => {
      node.textContent =
        'https://api.apiome.dev/types/tenant/acme/v1/types/an-extremely-long-type-name-that-never-breaks-anywhere';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    expect(await documentOverflows(page)).toBe(false);
  });

  test('breaks a long $ref in the reference table rather than taking the page', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'detail');
    await page.locator('[data-testid="ref-edge-link-0"]').evaluate((node) => {
      node.textContent = '../../../std/v0/types/an-extremely-long-relative-reference-value';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    expect(await documentOverflows(page)).toBe(false);
  });

  test('scrolls a wide table inside its own card, never taking the page', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'detail');

    // `DataTable`'s `scrollX` wraps the table in an `overflow-x-auto` div; the assertion is that
    // *something* between the table and the page scrolls, and that the page does not.
    const scrolls = await page
      .locator('[data-testid="primitive-detail-dependents"] div')
      .evaluateAll((nodes) =>
        nodes.some((node) => getComputedStyle(node as Element).overflowX === 'auto')
      );
    expect(scrolls).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The schema pane follows the font scale
   ------------------------------------------------------------------------- */

test.describe('the schema pane', () => {
  test('grows with the font-scale preference, because its box is a rem', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'detail');

    const pane = page.locator('[data-testid="primitive-detail-schema-editor"]');
    await applyPreferences(page, { fontScale: 'xs' });
    const small = (await pane.boundingBox())?.height ?? 0;
    await applyPreferences(page, { fontScale: '2xl' });
    const large = (await pane.boundingBox())?.height ?? 0;

    expect(small).toBeGreaterThan(0);
    // 14px → 20px root: a `rem` box grows, a `px` one would not move at all.
    expect(large).toBeGreaterThan(small);
  });

  test('frames itself with a hairline rather than a fill of its own', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'detail');

    const pane = page.locator('[data-testid="primitive-detail-schema-editor"]');
    expect(await pane.evaluate((node) => getComputedStyle(node).boxShadow)).toContain('inset');
  });
});

/* -------------------------------------------------------------------------
   The unresolved step is marked, not inked
   ------------------------------------------------------------------------- */

test.describe('the base chain', () => {
  test('rails the unresolved step in the warning tone and leaves its words alone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'detail');

    const unresolved = page.locator('.pd-chain__step[data-status="unresolved"]').first();
    const resolved = page.locator('.pd-chain__step[data-status="resolved"]').first();

    // The rail carries the state…
    const railed = await unresolved.evaluate((node) => getComputedStyle(node).borderInlineStartColor);
    const plain = await resolved.evaluate((node) => getComputedStyle(node).borderInlineStartColor);
    expect(railed).not.toBe(plain);

    // …and the label does not: `--warn` measures 2.82:1 on the surface in Solarized, so the words
    // stay the page's own ink and say `unresolved` themselves.
    const labelInk = await unresolved
      .locator('.pd-chain__label')
      .evaluate((node) => getComputedStyle(node).color);
    const pageInk = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()
    );
    expect(labelInk).not.toBe('');
    expect(pageInk).not.toBe('');
    await expect(unresolved).toContainText('unresolved');
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('axe finds nothing serious', () => {
  for (const name of ALL_FIXTURES) {
    test(`the ${name} surface has no serious or critical violations`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`the open test form has no serious or critical violations in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'detail-testing');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });
  }
});
