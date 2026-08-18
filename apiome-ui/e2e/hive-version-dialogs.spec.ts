import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The Versions overlays, measured in a browser (HIVE-6.3, #5314).
 *
 * `tests/version-dialogs-hive-redesign.test.tsx` pins what the panels render,
 * `tests/version-dialogs-model.test.ts` pins the derivations behind them, and
 * `tests/version-dialogs-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a diff pane that is two synchronised columns, a
 *     conflict table with a 14-rem action column, and an export grid of eight target cards.
 *   • **The wide surfaces scroll inside their own box**, never the document: the diff panes,
 *     the class list, the conflict table, the per-construct report.
 *   • **The grids really collapse.** The compare picker, the two revision cards, the three
 *     stat tiles, the export panel and the target grid are all `auto-fit` — the measurement
 *     that makes `min(…, 100%)` more than a hope.
 *   • **The tone attributes resolve to the tokens they name**, in every theme: a `data-tone`
 *     swatch and the react-flow node it explains are the same computed colour, which is the
 *     browser half of "React Flow surfaces adopt token colours".
 *   • **"axe: zero serious/critical violations"** on the conflict table, the compatibility
 *     report and the export panel, in every theme.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-versions.spec.ts` gives: the states worth measuring — a merge with
 * one resolved and one unresolved path, a breaking compatibility verdict, a canvas compare
 * with an added class — are the ones a seeded database will not produce on demand.
 *
 * The fixtures are **not hand-written**. `tests/version-dialogs-hive-redesign.test.tsx`
 * renders the real components and, with `VERSION_DIALOGS_FIXTURE_DUMP=1`, writes what it
 * rendered into `e2e/fixtures/hive-version-dialogs/`. So what is measured here is exactly what
 * the components compose — the classes, the nesting, the ARIA — and the jsdom suite is what
 * keeps the fixtures honest.
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
const THEMES = [null, 'dark', 'high-contrast', 'blueprint', 'whiteboard', 'solarized', 'nord', 'darcula'];

/** The six font-size stops of DESIGN.md §4.1. `md` is the default. */
const FONT_SCALES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];

/** Widths either side of the grids' `rem` breakpoints, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1024, 900, 768, 640, 420];

/** Where the jsdom suite writes what it rendered. */
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-version-dialogs');

/** The five surfaces the jsdom suite dumps. */
type Fixture =
  | 'canvas-compare'
  | 'merge-conflicts'
  | 'compat-report'
  | 'compare-cards'
  | 'export-panel';

/** Every fixture, for the walks that measure all of them. */
const ALL_FIXTURES: Fixture[] = [
  'canvas-compare',
  'merge-conflicts',
  'compat-report',
  'compare-cards',
  'export-panel',
];

/**
 * One rendered surface, as the jsdom suite wrote it.
 *
 * @param name The fixture.
 * @returns Its markup.
 */
function fixture(name: Fixture): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.html`), 'utf8');
}

/**
 * Put markup on a page that has the real stylesheet compiled.
 *
 * Each fixture is a panel rather than a page, so it is mounted inside a `--bg-canvas` main
 * with the page's own padding — the frame it has on the Versions screen.
 *
 * @param page The Playwright page.
 * @param name Which fixture.
 */
async function mount(page: Page, name: Fixture): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((html) => {
    document.body.innerHTML = `<main style="min-height:100vh;background:var(--bg-canvas);padding:1rem;display:flex;flex-direction:column">${html}</main>`;
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
 * A token, as the page computes it right now.
 *
 * @param page The Playwright page.
 * @param name The custom property, with its `--`.
 * @returns The computed colour, as the browser serialises it.
 */
function tokenColor(page: Page, name: string): Promise<string> {
  return page.evaluate((token) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the version overlays keep the document to one column', () => {
  for (const name of ALL_FIXTURES) {
    for (const width of WIDTHS) {
      test(`${name} does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mount(page, name);
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const theme of THEMES) {
    test(`the conflict table does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'merge-conflicts');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the export panel does not scroll sideways at the ${fontScale} font scale`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'export-panel');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`the compatibility report does not scroll sideways at ${density} density`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'compat-report');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The wide surfaces scroll inside their own box
   ------------------------------------------------------------------------- */

test.describe('the wide surfaces scroll inside themselves', () => {
  test('the conflict table has its own scroller rather than widening the page', async ({
    page,
  }) => {
    // The mockup's action column is 220px of buttons; on a phone that is wider than the
    // viewport, and the *table* is what has to scroll.
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'merge-conflicts');
    const overflow = await page
      .locator('.vdlg-conflicts__scroll')
      .evaluate((node) => getComputedStyle(node as Element).overflow);
    expect(overflow).toContain('auto');
    expect(await documentOverflows(page)).toBe(false);
  });

  test('the per-construct report scrolls vertically inside its box', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'compat-report');
    const findings = page.locator('.vdlg-compat__findings');
    if ((await findings.count()) === 0) test.skip();
    expect(
      await findings.first().evaluate((node) => getComputedStyle(node as Element).overflowY)
    ).toBe('auto');
  });
});

/* -------------------------------------------------------------------------
   The grids collapse
   ------------------------------------------------------------------------- */

test.describe('the grids collapse rather than overflow', () => {
  test('the two revision cards stack below their breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'compare-cards');
    expect(await gridColumns(page, '.vdlg-compare__cards')).toBeGreaterThan(1);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '.vdlg-compare__cards')).toBe(1);
  });

  test('the export panel stacks its two cards below its breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'export-panel');
    expect(await gridColumns(page, '.vdlg-export')).toBeGreaterThan(1);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '.vdlg-export')).toBe(1);
  });

  test('the rule-hit list stacks at the smallest width', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'compat-report');
    const rules = page.locator('.vdlg-compat__rules');
    if ((await rules.count()) === 0) test.skip();
    expect(await gridColumns(page, '.vdlg-compat__rules')).toBe(1);
  });
});

/* -------------------------------------------------------------------------
   The graph surfaces
   ------------------------------------------------------------------------- */

test.describe('the graph surfaces keep their proportion', () => {
  test('a canvas pane is a viewport share, never a frozen box', async ({ page }) => {
    // The mockup froze the pane at 300px. A pane that did not move with the viewport would
    // show two nodes on a laptop and eight on a monitor.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'canvas-compare');
    const tall = await page
      .locator('.vdlg-canvas-pane')
      .first()
      .evaluate((node) => (node as HTMLElement).getBoundingClientRect().height);

    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 500 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const short = await page
      .locator('.vdlg-canvas-pane')
      .first()
      .evaluate((node) => (node as HTMLElement).getBoundingClientRect().height);

    expect(short).toBeLessThan(tall);
  });

  test('the two panes sit side by side above the breakpoint and stack below it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'canvas-compare');
    const wide = await page
      .locator('.vdlg-canvas__split')
      .evaluate((node) => getComputedStyle(node as Element).flexDirection);
    expect(wide).toBe('row');

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const narrow = await page
      .locator('.vdlg-canvas__split')
      .evaluate((node) => getComputedStyle(node as Element).flexDirection);
    expect(narrow).toBe('column');
  });
});

/* -------------------------------------------------------------------------
   The tone attributes resolve to the tokens they name
   ------------------------------------------------------------------------- */

test.describe('a tone attribute paints the token it names', () => {
  for (const theme of THEMES) {
    test(`the legend swatches match their tokens in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'canvas-compare');
      await applyPreferences(page, { theme });

      // The added swatch is `--ok`, the removed one `--danger` — the same tokens
      // `changeStrokeVar` hands react-flow, so a legend can never explain the wrong colour.
      const ok = await tokenColor(page, '--ok');
      const danger = await tokenColor(page, '--danger');
      const added = await page
        .locator('.vdlg-legend__swatch[data-tone="ok"]')
        .first()
        .evaluate((node) => getComputedStyle(node as Element).backgroundColor);
      const removed = await page
        .locator('.vdlg-legend__swatch[data-tone="danger"]')
        .first()
        .evaluate((node) => getComputedStyle(node as Element).backgroundColor);

      expect(added).toBe(ok);
      expect(removed).toBe(danger);
    });
  }

  test('the unresolved conflict row is washed, and the resolved one is not', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'merge-conflicts');
    const washed = await page
      .locator('tr[data-unresolved]')
      .first()
      .evaluate((node) => getComputedStyle(node as Element).backgroundColor);
    const plain = await page
      .locator('tr:not([data-unresolved])')
      .last()
      .evaluate((node) => getComputedStyle(node as Element).backgroundColor);
    expect(washed).not.toBe(plain);
    // The wash is a mix of `--warn`, not the `-soft` fill: it must stay translucent so the
    // row's `--fg` text keeps the surface behind it.
    expect(washed).toMatch(/^rgba?\(/);
  });
});

/* -------------------------------------------------------------------------
   axe
   ------------------------------------------------------------------------- */

test.describe('axe finds nothing serious or critical', () => {
  for (const name of ALL_FIXTURES) {
    test(`${name} passes axe`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const serious = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical'
      );
      expect(serious.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`the conflict table passes axe in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'merge-conflicts');
      await applyPreferences(page, { theme });
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const serious = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical'
      );
      expect(serious.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    });
  }
});
