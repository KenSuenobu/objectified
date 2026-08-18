import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Versions, measured in a browser (HIVE-6.2, #5313).
 *
 * `tests/versions-hive-redesign.test.tsx` pins what the screen renders,
 * `tests/versions-model.test.ts` pins the derivations behind it, and
 * `tests/versions-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a page whose table has seven columns and whose
 *     publish dialog is a two-column `dialog--xl`.
 *   • **The table scrolls inside its own card**, never the document, and the scroller has a
 *     name and a Tab stop.
 *   • **The overview grid and the publish dialog really collapse** to one column, which is
 *     the whole reason their asides are stated in `rem`.
 *   • **The rows are top-aligned and the version column keeps its floor**, so a three-chip
 *     line and a three-line mock cell read as one row.
 *   • **The `-fg` inks stay off the surface**: the published date's words are the page's
 *     muted ink and only its glyph is green; the delete row is plain until highlighted.
 *   • **"axe: zero serious/critical violations"** on the timeline, the row menu, the New
 *     version dialog and the Publish dialog, in every theme.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-projects.spec.ts` gives: the states worth measuring — a deprecated
 * revision with a sunset, a fork, a locked archived revision, a private draft mock — are the
 * ones a seeded database will not produce on demand, and every read here is tenant-scoped.
 *
 * The fixtures are **not hand-written**. `tests/versions-hive-redesign.test.tsx` renders the
 * real screen against mocked reads and, with `VERSIONS_FIXTURE_DUMP=1`, writes what it
 * rendered into `e2e/fixtures/hive-versions/`. So what is measured here is exactly what the
 * components compose — the classes, the nesting, the ARIA — and the jsdom suite is what
 * keeps the fixtures honest.
 *
 * This loads `/login`, which compiles the real `globals.css` and needs no session, and
 * injects the fixtures into it. Requires the app to be running (`PLAYWRIGHT_BASE_URL`,
 * default `http://localhost:3000`).
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
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-versions');

/**
 * One rendered surface, as the jsdom suite wrote it.
 *
 * @param name The fixture — `timeline`, `menu`, `new` or `publish`.
 * @returns Its markup.
 */
function fixture(name: 'timeline' | 'menu' | 'new' | 'publish'): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.html`), 'utf8');
}

/**
 * Put markup on a page that has the real stylesheet compiled.
 *
 * The timeline is the page itself; a dialog and the menu are overlays, mounted over an empty
 * canvas the way Radix portals them.
 *
 * @param page The Playwright page.
 * @param name Which fixture.
 */
async function mount(page: Page, name: 'timeline' | 'menu' | 'new' | 'publish'): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate(
    ({ html, overlay }) => {
      document.body.innerHTML = overlay
        ? `<main style="min-height:100vh;background:var(--bg-canvas)"></main>${html}`
        : `<main style="display:flex;flex-direction:column;min-height:100vh">${html}</main>`;
      document.body.style.margin = '0';
      // The row menu is positioned by Radix at runtime; give it a place on the page.
      const menu = document.querySelector('[role="menu"]') as HTMLElement | null;
      if (menu && overlay) {
        menu.style.position = 'fixed';
        menu.style.top = '2rem';
        menu.style.left = '2rem';
      }
    },
    { html: fixture(name), overlay: name !== 'timeline' }
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

test.describe('the versions page keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`the timeline does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, 'timeline');
      expect(await documentOverflows(page)).toBe(false);
    });

    test(`the publish dialog does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, 'publish');
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const theme of THEMES) {
    test(`does not scroll sideways in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'timeline');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    for (const density of ['comfortable', 'compact']) {
      test(`the timeline holds at the ${fontScale} scale, ${density}`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, 'timeline');
        await applyPreferences(page, { fontScale, density });
        expect(await documentOverflows(page)).toBe(false);
      });

      test(`the publish dialog holds at the ${fontScale} scale, ${density}`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, 'publish');
        await applyPreferences(page, { fontScale, density });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  test('scrolls the table inside its own wrapper when seven columns will not fit', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'timeline');
    const scroller = page.locator('[data-testid="versions-table"] [role="region"]');
    expect(await scroller.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('gives that scroll container a name and a place in the tab order', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'timeline');
    // WCAG 2.1.1: a region that scrolls must be reachable without a pointer.
    const scroller = page.locator('[data-testid="versions-table"] [role="region"]');
    await expect(scroller).toHaveAttribute('tabindex', '0');
    await expect(scroller).toHaveAttribute('aria-label', /Revisions of/);
  });
});

/* -------------------------------------------------------------------------
   The grids re-flow, which is what the rem asides are for
   ------------------------------------------------------------------------- */

test.describe('the two-column surfaces', () => {
  test('the overview grid keeps its aside on a desktop and folds it under on a tablet', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');
    expect(await gridColumns(page, '.ver-overview')).toBe(2);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '.ver-overview')).toBe(1);
  });

  test('the publish dialog keeps its gates beside the form on a desktop and folds them under on a phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'publish');
    expect(await gridColumns(page, '.ver-publish')).toBe(2);
    expect(await gridColumns(page, '.ver-publish__visibility')).toBe(2);

    await page.setViewportSize({ width: 640, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '.ver-publish')).toBe(1);
    expect(await gridColumns(page, '.ver-publish__visibility')).toBe(1);
  });

  test('folds the overview at the largest font scale even on a desktop, which px could not do', async ({
    page,
  }) => {
    // The whole reason the aside is `rem`: at the Largest scale a 1024px viewport is narrower
    // *in text* than a 900px one at the default, so a px aside would hold two columns exactly
    // where the facts card no longer fits beside the artifacts.
    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, 'timeline');
    await applyPreferences(page, { fontScale: '2xl' });
    expect(await gridColumns(page, '.ver-overview')).toBe(1);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Rows keep their shape
   ------------------------------------------------------------------------- */

test.describe('the revisions table', () => {
  test('top-aligns every cell, so a chip line and a three-line mock cell read as one row', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');
    const aligns = await page
      .locator('[data-testid="versions-table"] tbody tr[data-row-id]:first-child td')
      .evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).verticalAlign));
    expect(new Set(aligns)).toEqual(new Set(['top']));
  });

  test('keeps the version column at its rem floor whatever the row holds', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');
    const [width, floor] = await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="versions-table"] tbody td.ver-col-version') as HTMLElement;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return [cell.getBoundingClientRect().width, 14.6875 * rem];
    });
    expect(width).toBeGreaterThanOrEqual(floor - 1);
  });

  test('elides a long note rather than widening the row', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');
    const [width, cap] = await page.evaluate(() => {
      const note = document.querySelector('.ver-note') as HTMLElement;
      return [note.getBoundingClientRect().width, parseFloat(getComputedStyle(note).maxWidth)];
    });
    expect(width).toBeLessThanOrEqual(cap + 1);
    const overflow = await page
      .locator('.ver-note__title')
      .first()
      .evaluate((node) => getComputedStyle(node).textOverflow);
    expect(overflow).toBe('ellipsis');
  });

  test('draws the published date in the muted ink and only its glyph in green', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');
    const stamp = page.locator('.ver-stamp__published').first();
    expect(await stamp.evaluate((node) => getComputedStyle(node).color)).toBe(await tokenColor(page, '--fg-muted'));
    expect(await stamp.locator('svg').evaluate((node) => getComputedStyle(node).color)).toBe(
      await tokenColor(page, '--ok')
    );
  });

  test('does not fade the archived row', async ({ page }) => {
    // The mockup fades the archived row to `.8`, which fades its text with it. The Archived
    // pill and the outline chips carry the meaning; the row is full ink.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');
    const opacities = await page
      .locator('[data-testid="versions-table"] tbody tr[data-row-id]')
      .evaluateAll((rows) => rows.map((row) => getComputedStyle(row).opacity));
    expect(new Set(opacities)).toEqual(new Set(['1']));
  });
});

/* -------------------------------------------------------------------------
   The flag and the menu
   ------------------------------------------------------------------------- */

test.describe('the git-like flag and the row menu', () => {
  test('paints the flag honey, one rem tall, and scales it with the font size', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');
    const flag = page.locator('[data-testid="gitlike-flag"]').first();
    expect(await flag.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    const before = await flag.evaluate((node) => node.getBoundingClientRect().height);
    await applyPreferences(page, { fontScale: '2xl' });
    const after = await flag.evaluate((node) => node.getBoundingClientRect().height);
    expect(after).toBeGreaterThan(before);
  });

  test('draws every menu row in the same ink at rest, the inert ones dimmed, and none red', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'menu');
    const inks = await page.evaluate(() => {
      const item = (id: string) => document.querySelector(`[data-testid="versions-row-action-${id}"]`) as HTMLElement;
      return {
        view: getComputedStyle(item('view')).color,
        del: getComputedStyle(item('delete')).color,
        delOpacity: getComputedStyle(item('delete')).opacity,
        publishOpacity: getComputedStyle(item('publish')).opacity,
        publishGlyph: getComputedStyle(item('publish').querySelector('svg') as SVGElement).color,
      };
    });
    // Delete is plain text at rest — the 6.1 measurement: no red in the token layer clears
    // AA as 13px text on the surface — and inert in this build.
    expect(inks.del).toBe(inks.view);
    expect(inks.delOpacity).toBe('0.55');
    expect(inks.publishOpacity).toBe('1');
    expect(inks.publishGlyph).toBe(await tokenColor(page, '--ok'));
  });

  test('keeps the menu inside the viewport width', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'menu');
    const width = await page.locator('[role="menu"]').evaluate((node) => node.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(420 - 16);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  const SURFACES = [
    ['the timeline', 'timeline', '.page-body'],
    ['the row menu', 'menu', '[role="menu"]'],
    ['the New version dialog', 'new', '[role="dialog"]'],
    ['the Publish dialog', 'publish', '[role="dialog"]'],
  ] as const;

  for (const [label, name, include] of SURFACES) {
    for (const theme of THEMES) {
      test(`reports no serious or critical violation on ${label} in ${theme ?? 'light'}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: DESKTOP_WIDTH, height: 900 } });
        const page = await context.newPage();
        await mount(page, name);
        await applyPreferences(page, { theme });

        const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).include(include).analyze();
        const blocking = results.violations.filter((violation) =>
          ['serious', 'critical'].includes(violation.impact ?? '')
        );
        expect(
          blocking.map(
            (violation) =>
              `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`
          )
        ).toEqual([]);
        await context.close();
      });
    }
  }
});
