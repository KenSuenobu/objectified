import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The import wizard, measured in a browser (HIVE-6.4, #5315).
 *
 * `tests/import-wizard-hive-redesign.test.tsx` pins what the wizard renders,
 * `tests/import-wizard-model.test.ts` pins the decisions behind it, and
 * `tests/import-wizard-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a dialog whose source grid is `auto-fit`, whose
 *     intake bar holds eleven tabs, and whose Import step stacks four cards.
 *   • **The wizard's body is the only part that scrolls** — the head, the stepper and the
 *     footer stay put however long the step is, which is the four-part grid contract the
 *     stylesheet's comment describes.
 *   • **The source grid and the preview tiles really collapse**, which is the whole reason
 *     they are `repeat(auto-fit, minmax(…rem, 1fr))` rather than a fixed column count.
 *   • **The `-fg` inks stay off the surface**: the log's severities are washes, so their text
 *     is the page's own ink and only the `[LEVEL]` prefix is tinted.
 *   • **"axe: zero serious/critical violations"** on the source grid, the File intake, the MCP
 *     intake and the Import step's running and failed states, in every theme.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-versions.spec.ts` gives: the states worth measuring — a running job at
 * 62 %, a failed one with a context payload, a registry adapter drawn disabled — are the ones a
 * seeded database will not produce on demand, and every read here is tenant-scoped.
 *
 * The fixtures are **not hand-written**. `tests/import-wizard-hive-redesign.test.tsx` renders
 * the real wizard against mocked reads and, with `IMPORT_WIZARD_FIXTURE_DUMP=1`, writes what it
 * rendered into `e2e/fixtures/hive-import-wizard/`. So what is measured here is exactly what
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
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-import-wizard');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'source' | 'intake' | 'mcp' | 'import-running' | 'import-failed';

/** The three that are the wizard itself; the other two are the Import step's panel alone. */
const DIALOG_FIXTURES: Fixture[] = ['source', 'intake', 'mcp'];

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
 * The wizard is a dialog, so it is mounted over an empty canvas the way Radix portals it. No
 * positioning is restored by hand: `DialogContent` centres itself with utility classes the
 * fixture carries, so the transplanted copy lands exactly where the real one does — 1200 px
 * wide, inset from the viewport by the `size="full"` cap.
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
        : `<main style="min-height:100vh;background:var(--bg-canvas);padding:2rem">${html}</main>`;
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

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the wizard keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`the source step does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, 'source');
      expect(await documentOverflows(page)).toBe(false);
    });

    test(`the intake step does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, 'intake');
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const theme of THEMES) {
    test(`does not scroll sideways in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'source');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`does not scroll sideways at the ${fontScale} font scale`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'intake');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'mcp');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  test('the Import step does not scroll sideways with a context payload in its failures', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'import-failed');
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Only the body scrolls
   ------------------------------------------------------------------------- */

test.describe('the wizard scrolls its body, not its chrome', () => {
  test('the head, the stepper and the footer stay put while the body scrolls', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 600 });
    await mount(page, 'intake');

    const footBefore = await page.locator('.imp-wizard__foot').boundingBox();
    const stepsBefore = await page.locator('.imp-wizard__steps').boundingBox();
    await page.locator('.imp-wizard__body').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    expect(await page.locator('.imp-wizard__foot').boundingBox()).toEqual(footBefore);
    expect(await page.locator('.imp-wizard__steps').boundingBox()).toEqual(stepsBefore);
  });

  test('the body is the scroll container, and the dialog itself is not', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 600 });
    await mount(page, 'intake');
    expect(
      await page.locator('.imp-wizard').evaluate((node) => getComputedStyle(node).overflow)
    ).toBe('hidden');
    expect(
      await page.locator('.imp-wizard__body').evaluate((node) => getComputedStyle(node).overflowY)
    ).toBe('auto');
  });
});

/* -------------------------------------------------------------------------
   The grids collapse
   ------------------------------------------------------------------------- */

test.describe('the grids collapse rather than overflow', () => {
  test('the source grid loses columns as the viewport narrows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'source');
    const wide = await gridColumns(page, '.imp-cards');

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    const narrow = await gridColumns(page, '.imp-cards');

    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBe(1);
  });

  test('the source grid also loses columns as the font scale grows', async ({ page }) => {
    // The tracks are `rem`, so the grid answers to the reader's font-size preference as well
    // as to the viewport — which is what a fixed `grid-cols-3` could not do.
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'source');
    await applyPreferences(page, { fontScale: 'xs' });
    const small = await gridColumns(page, '.imp-cards');
    await applyPreferences(page, { fontScale: '2xl' });
    const large = await gridColumns(page, '.imp-cards');
    expect(small).toBeGreaterThanOrEqual(large);
  });

  test('the intake tab bar scrolls inside itself rather than wrapping into three rows', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'intake');
    const strip = page.locator('[role="tablist"][aria-label="Import source"]');
    expect(await strip.evaluate((node) => getComputedStyle(node).overflowX)).toBe('auto');
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The log's severities
   ------------------------------------------------------------------------- */

test.describe('the import log', () => {
  test('carries its severity as data-level, and tints the prefix rather than the message', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'import-running');

    const warn = page.locator('.imp-log__line[data-level="warn"]').first();
    await expect(warn).toBeVisible();

    const prefix = await warn
      .locator('.imp-log__level')
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor };
      });
    const line = await warn.evaluate((node) => getComputedStyle(node).color);
    expect(prefix.color).not.toBe(line);
    // The prefix is a chip: it carries its own fill, which is what makes its ink readable.
    expect(prefix.background).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('marks an error line with a rule down its leading edge', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'import-failed');
    const error = page.locator('.imp-log__line[data-level="error"]').first();
    await expect(error).toBeVisible();
    // Every line reserves the space, so what marks the error is the colour, not the width.
    const edge = await error.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        width: parseFloat(style.borderInlineStartWidth),
        color: style.borderInlineStartColor,
      };
    });
    expect(edge.width).toBeGreaterThan(0);
    expect(edge.color).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('keeps a long context payload inside the log rather than widening the card', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'import-failed');
    const card = await page.locator('.imp-log').first().boundingBox();
    expect(card).not.toBeNull();
    expect(card!.width).toBeLessThanOrEqual(640);
  });
});

/* -------------------------------------------------------------------------
   axe
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  for (const name of ['source', 'intake', 'mcp', 'import-running', 'import-failed'] as const) {
    test(`the ${name} surface has no serious or critical violations`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const serious = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      );
      expect(serious.map((violation) => violation.id)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`the source grid has no serious or critical violations in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'source');
      await applyPreferences(page, { theme });
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const serious = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      );
      expect(serious.map((violation) => violation.id)).toEqual([]);
    });
  }
});
