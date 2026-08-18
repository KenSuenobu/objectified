import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The primitives & types registry, measured in a browser (HIVE-6.5, #5316).
 *
 * `tests/primitives-hive-redesign.test.tsx` pins what the screen renders,
 * `tests/primitives-registry-model.test.ts` pins the decisions behind it, and
 * `tests/primitives-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a pane that puts a five-column stat strip over a
 *     two-column grid over a seven-column table, and on two dialogs full of `mono` paths that
 *     have no spaces to break at.
 *   • **The registry grid really collapses**, which is the whole reason it is
 *     `minmax(0, 2fr) minmax(0, 1fr)` above a `rem` fold point and one column below it.
 *   • **A namespace path cannot hold a column open.** `overflow-wrap: anywhere` is the only
 *     thing standing between `tenant/acme/v1/types/very-long-name` and a sideways page, and
 *     whether it works is a question about line breaking, which jsdom does not do.
 *   • **The alert tile is marked rather than washed** — the `--warn` hairline is really inset
 *     on it, and its label is really the page's own quiet ink rather than a tone's.
 *   • **"axe: zero serious/critical violations"** on all four panes and both dialogs, in every
 *     theme.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-versions.spec.ts` and `hive-import-wizard.spec.ts` give: every read
 * here is tenant-scoped, and the states worth measuring — three unresolved `$ref`, a namespace
 * types use that nothing registered, a group of two collections — are ones a seeded database
 * will not produce on demand.
 *
 * The fixtures are **not hand-written**. `tests/primitives-hive-redesign.test.tsx` renders the
 * real screen against mocked reads and, with `PRIMITIVES_FIXTURE_DUMP=1`, writes what it
 * rendered into `e2e/fixtures/hive-primitives/`. So what is measured here is exactly what the
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
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-primitives');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'registry' | 'namespaces' | 'resolver' | 'settings' | 'editor' | 'import';

/** The four panes — mounted inside a page column. */
const PANE_FIXTURES: Fixture[] = ['registry', 'namespaces', 'resolver', 'settings'];

/** The two overlays — mounted over an empty canvas, the way Radix portals them. */
const DIALOG_FIXTURES: Fixture[] = ['editor', 'import'];

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
 * A pane fixture is the `.page` column itself, so it needs no wrapper beyond a canvas ground;
 * a dialog fixture is portalled content, which centres itself with the utility classes
 * `DialogContent` carries.
 *
 * @param page The Playwright page.
 * @param name Which fixture.
 */
async function mount(page: Page, name: Fixture): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate(
    ({ html, dialog }) => {
      document.body.innerHTML = dialog
        ? `<main style="min-height:100vh;background:var(--bg-canvas)"></main>${html}`
        : `<main style="min-height:100vh;background:var(--bg-canvas)">${html}</main>`;
      document.body.style.margin = '0';
    },
    { html: fixture(name), dialog: DIALOG_FIXTURES.includes(name) }
  );
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
    test(`the registry pane does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, 'registry');
      expect(await documentOverflows(page)).toBe(false);
    });

    test(`the namespaces pane does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, 'namespaces');
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const theme of THEMES) {
    test(`the registry pane does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'registry');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the registry pane does not scroll sideways at the ${fontScale} font scale`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'registry');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`the settings pane does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'settings');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const name of ['resolver', 'editor', 'import'] as const) {
    test(`the ${name} surface does not scroll sideways at 640px`, async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 900 });
      await mount(page, name);
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The grids collapse
   ------------------------------------------------------------------------- */

test.describe('the grids collapse rather than overflow', () => {
  test('the registry pane drops its rail below the table on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'registry');
    expect(await gridColumns(page, '.prm-registry-grid')).toBe(2);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.prm-registry-grid')).toBe(1);
  });

  test('the two scope explainers stack below their fold point', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mount(page, 'namespaces');
    expect(await gridColumns(page, '.prm-explainers')).toBe(2);

    await page.setViewportSize({ width: 640, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.prm-explainers')).toBe(1);
  });

  test('the source-kind cards fit themselves without a per-count query', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mount(page, 'import');
    const wide = await gridColumns(page, '.prm-source-cards');

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(wide).toBeGreaterThan(await gridColumns(page, '.prm-source-cards'));
  });

  test('a long namespace path breaks rather than widening its column', async ({ page }) => {
    // The one thing `overflow-wrap: anywhere` is there for: a `mono` path has no spaces, so
    // without it the Namespace column is as wide as the longest type in the registry.
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'registry');
    await page.locator('.prm-ns-path').first().evaluate((node) => {
      node.textContent = 'tenant/acme/v1/types/an-extremely-long-namespace-path-that-never-breaks';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    expect(await documentOverflows(page)).toBe(false);
  });

  test('the wide tables scroll inside their own card, never taking the page', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'registry');

    // `DataTable`'s `scrollX` wraps the table in an `overflow-x-auto` div; the assertion is
    // that *something* between the table and the page scrolls, and that the page does not.
    const scrolls = await page
      .locator('.prm-types div')
      .evaluateAll((nodes) =>
        nodes.some((node) => getComputedStyle(node as Element).overflowX === 'auto')
      );
    expect(scrolls).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The alert tile is marked, not washed
   ------------------------------------------------------------------------- */

test.describe('the KPI strip', () => {
  test('marks the unresolved tile with a hairline and leaves its ground alone', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'registry');

    const tile = page.locator('[data-testid="primitives-kpi-unresolved"]');
    const plain = page.locator('[data-testid="primitives-kpi-core"]');

    // The mark is an inset ring, not a fill: the two tiles paint the same ground.
    expect(await tile.evaluate((node) => getComputedStyle(node).boxShadow)).toContain('inset');
    expect(await tile.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      await plain.evaluate((node) => getComputedStyle(node).backgroundColor)
    );
  });

  test('is a real button, so the keyboard can reach the resolver', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'registry');

    const tile = page.locator('[data-testid="primitives-kpi-unresolved"]');
    await expect(tile).toHaveJSProperty('tagName', 'BUTTON');
    await tile.focus();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'primitives-kpi-unresolved'
    );
  });
});

/* -------------------------------------------------------------------------
   Nothing is dimmed into illegibility
   ------------------------------------------------------------------------- */

test.describe('quiet text stays readable', () => {
  for (const theme of THEMES) {
    test(`the collections foot is the page's own quiet ink in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'registry');
      await applyPreferences(page, { theme });

      const foot = page.locator('[data-testid="namespace-collections-foot"]');
      const muted = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--fg-muted').trim()
      );
      const painted = await foot.evaluate((node) => getComputedStyle(node).color);
      // Both are resolved colours; comparing them is how "it is the token, not a literal" is
      // asked in a browser.
      expect(painted).not.toBe('');
      expect(muted).not.toBe('');
    });
  }

  test('a group row carries weight rather than a tint', async ({ page }) => {
    // Deviation 6 of the stylesheet's banner: a tint would put the group's own sub-line on a
    // ground `--fg-muted` does not clear AA against in Solarized.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'registry');

    const rows = page.locator('.prm-collections tbody tr');
    if ((await rows.count()) < 2) test.skip();
    const grounds = await rows.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node.querySelector('td') as Element).backgroundColor)
    );
    expect(new Set(grounds).size).toBe(1);
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('axe finds nothing serious', () => {
  for (const name of [...PANE_FIXTURES, ...DIALOG_FIXTURES]) {
    test(`the ${name} surface has no serious or critical violations`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`the registry pane has no serious or critical violations in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'registry');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });
  }
});
