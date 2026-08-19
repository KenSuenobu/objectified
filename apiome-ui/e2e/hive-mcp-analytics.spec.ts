import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The MCP analytics, capability directory and server comparison, measured in a browser
 * (HIVE-7.9, #5326).
 *
 * `tests/mcp-analytics-hive-redesign.test.tsx`,
 * `tests/mcp-capabilities-hive-redesign.test.tsx` and
 * `tests/mcp-compare-hive-redesign.test.tsx` pin what the three screens render, and
 * `tests/mcp-analytics-compare-css.test.ts` pins the declarations. None of the four can answer
 * the questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on three screens carrying a five-cell stat strip, six
 *     charts, two leaderboards, a five-control filter bar over a four-column table, a sticky
 *     picker beside a three-column metric matrix and a presence matrix under it.
 *   • **The five grids really fold.** `.mcpa-row`, `.mcpa-row--pair`, `.mcpc-presets` and
 *     `.mcpx-unique` are `minmax(min(100%, Nrem), 1fr)` tracks, resolved during *layout* — where
 *     a `rem` is the current root font size, so they fold sooner at the Largest scale on their
 *     own. `.mcpx-layout` widens behind a `min-width: 64rem` query instead, and a `rem` in a
 *     media query resolves against the root's **initial** font size, so that one stays at 1024px
 *     at every stop and has to survive being two columns wide at 2xl. A stylesheet test can only
 *     assert that both are *written*; which of the two behaviours each gets is a browser fact.
 *   • **The wide metric table scrolls inside its own card, never taking the document with it.**
 *     `overflow-x: auto` only contains a table because every ancestor carries
 *     `min-inline-size: 0`, and whether that chain is intact is a computed-layout fact.
 *   • **The picker sticks, and does not clip its first row.** Its offset is a token measured
 *     from `.page`, not the mockup's `top: 150px`.
 *   • **"axe: zero serious/critical violations"** on all four surfaces, in every theme. This is
 *     the sweep the memory of HIVE-7.7 and HIVE-7.8 exists for: a semantic `-fg` ink drawn on a
 *     plain surface measures 1.5–3.2:1 in the seven appearances that inherit the light pairs,
 *     and only a browser can see it. It is also the only check that reaches the *chart* colours
 *     this ticket re-pointed at role tokens.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-mcp-catalog.spec.ts` and `hive-mcp-endpoint.spec.ts` give: every read
 * here is tenant-scoped, and the states worth measuring — a catalog of six servers with a full
 * grade histogram, a directory page with a preset lit, a three-way comparison with a protocol
 * mismatch in it — are ones a seeded database will not produce on demand.
 *
 * The fixtures are **not hand-written**. The three jsdom suites render the real screens against
 * mocked reads and, with `MCP_FIXTURE_DUMP=1`, write what they rendered into
 * `e2e/fixtures/hive-mcp-analytics/`. So what is measured here is exactly what the components
 * compose — the classes, the nesting, the ARIA — and the jsdom suites are what keep the fixtures
 * honest.
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
const WIDTHS = [1440, DESKTOP_WIDTH, 1100, 1024, 960, 900, 768, 640, 420];

/** Where the jsdom suites write what they rendered. */
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-mcp-analytics');

/** The four surfaces the jsdom suites dump. */
type Fixture = 'dashboard' | 'empty' | 'capabilities' | 'compare';

/** All four, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = ['dashboard', 'empty', 'capabilities', 'compare'];

/**
 * One rendered surface, as its jsdom suite wrote it.
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
    // Freeze every transition — the trap `hive-repositories.spec.ts` records. The cards, the
    // preset tiles and the picker rows carry background and box-shadow transitions, so a
    // `data-theme` swap *animates* every one of them, and axe sampling mid-animation reports a
    // `color-contrast` failure against a colour that exists in neither theme. A measurement has
    // to be of a settled frame.
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
    .flatMap((violation) => violation.nodes.map(() => violation.id));
}

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the three screens keep the document to one column', () => {
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
    for (const name of ['dashboard', 'compare'] as Fixture[]) {
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
    for (const name of ALL_FIXTURES) {
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
    for (const name of ['capabilities', 'compare'] as Fixture[]) {
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
   The grids really fold
   ------------------------------------------------------------------------- */

test.describe('the grids fold rather than overflow', () => {
  test('the analytics rows are three across on a desktop and one on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'dashboard');
    expect(await gridColumns(page, '.mcpa-row')).toBe(3);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.mcpa-row')).toBe(1);
  });

  test('the analytics rows fold sooner at the largest font scale, not at the same pixel', async ({
    page,
  }) => {
    // This is what an intrinsic track buys over a media query: `minmax(min(100%, 20rem), 1fr)` is
    // resolved during layout, where a `rem` *is* the current root font size — so at the 2xl stop a
    // 20rem tile is 500px rather than 320px and the track folds on its own. A `min-width` query
    // could not do this, because a `rem` in a media query never moves (see the compare split
    // below).
    await page.setViewportSize({ width: 1100, height: 900 });
    await mount(page, 'dashboard');
    expect(await gridColumns(page, '.mcpa-row')).toBe(3);

    await applyPreferences(page, { fontScale: '2xl' });
    expect(await gridColumns(page, '.mcpa-row')).toBeLessThan(3);
  });

  test('the preset row is four across on a desktop and one on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'capabilities');
    expect(await gridColumns(page, '.mcpc-presets')).toBe(4);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.mcpc-presets')).toBe(1);
  });

  test('the compare split is picker-beside-results on a desktop and stacked below 64rem', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'compare');
    expect(await gridColumns(page, '.mcpx-layout')).toBe(2);

    await page.setViewportSize({ width: 960, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await gridColumns(page, '.mcpx-layout')).toBe(1);
  });

  test('the compare split holds its two columns at every font scale without overflowing', async ({
    page,
  }) => {
    // A `rem` in a *media query* resolves against the root element's **initial** font size, not
    // its current one, so `min-width: 64rem` is 1024px at every `data-font-scale` stop. That is
    // the right behaviour — a breakpoint that moved with the type would make the layout jump
    // under a preference change — but it means the split has to survive being two columns wide
    // at the largest scale rather than folding out of trouble.
    await page.setViewportSize({ width: 1100, height: 900 });
    await mount(page, 'compare');
    expect(await gridColumns(page, '.mcpx-layout')).toBe(2);

    for (const fontScale of FONT_SCALES) {
      await applyPreferences(page, { fontScale });
      expect(await gridColumns(page, '.mcpx-layout')).toBe(2);
      expect(await documentOverflows(page)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------
   The wide table scrolls inside its own card
   ------------------------------------------------------------------------- */

test.describe('the metric table', () => {
  test('scrolls inside its card rather than taking the document with it', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'compare');

    // Narrow enough that a three-column matrix cannot fit — and the document still does not move.
    expect(await documentOverflows(page)).toBe(false);
    const scrolls = await page
      .locator('.mcpx-table-card .mcpx-scroll')
      .first()
      .evaluate((node) => (node as Element).scrollWidth > (node as Element).clientWidth);
    expect(scrolls).toBe(true);
  });

  test('a long tool name cannot hold a unique-tools card open', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'compare');
    await page.evaluate(() => {
      const item = document.querySelector('.mcpx-unique__list li');
      if (item) item.textContent = 'a'.repeat(120);
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The picker sticks without clipping
   ------------------------------------------------------------------------- */

test.describe('the compare picker', () => {
  test('sticks to the page rather than to a hard-coded header offset', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await mount(page, 'compare');

    const position = await page
      .locator('.mcpx-picker')
      .evaluate((node) => getComputedStyle(node as Element).position);
    expect(position).toBe('sticky');
  });

  test('keeps its first row reachable at compact density', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await mount(page, 'compare');
    await applyPreferences(page, { density: 'compact' });

    const top = await page
      .locator('.mcpx-picks li')
      .first()
      .evaluate((node) => (node as Element).getBoundingClientRect().top);
    expect(top).toBeGreaterThan(0);
  });

  test('scrolls its own list rather than growing past the comparison beside it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, 'compare');
    const overflowY = await page
      .locator('.mcpx-picker__body')
      .evaluate((node) => getComputedStyle(node as Element).overflowY);
    expect(overflowY).toBe('auto');
  });
});

/* -------------------------------------------------------------------------
   axe, in every appearance
   ------------------------------------------------------------------------- */

test.describe('axe reports nothing serious or critical', () => {
  for (const theme of THEMES) {
    for (const name of ALL_FIXTURES) {
      test(`the ${name} surface passes axe in the ${theme ?? 'light'} theme`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, name);
        await applyPreferences(page, { theme });
        expect(await blockingViolations(page)).toEqual([]);
      });
    }
  }

  test('the dashboard passes axe at the largest font scale and compact density', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'dashboard');
    await applyPreferences(page, { fontScale: '2xl', density: 'compact' });
    expect(await blockingViolations(page)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   The differing-row wash is emphasis, never the only signal
   ------------------------------------------------------------------------- */

test.describe('the differing-row marker', () => {
  test('is readable as data, not only as a tint', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'compare');

    // The wash is a 9 % mix — about 1.1:1 against the row beside it, far under the 3:1 a non-text
    // signal is asked for. It cannot be raised without failing the `--fg` text on top of it in the
    // dark palettes, so the fact is carried by the attribute and by the table's foot in words.
    const marked = await page.locator('.mcpx-table tr[data-differs="true"]').count();
    expect(marked).toBeGreaterThan(0);
    await expect(page.locator('.mcpx-table-foot')).toContainText('Rows whose cells differ');
  });

  test('tints a differing row and leaves an agreeing one alone, in every theme', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'compare');

    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      const [differing, agreeing] = await page.evaluate(() => {
        const table = document.querySelector('.mcpx-table') as Element;
        const marked = table.querySelector('tr[data-differs="true"] > td') as Element;
        const plain = table.querySelector('tr:not([data-differs]) > td') as Element;
        return [
          getComputedStyle(marked).backgroundColor,
          plain ? getComputedStyle(plain).backgroundColor : '',
        ];
      });
      expect(differing).not.toBe(agreeing);
    }
  });
});

/* -------------------------------------------------------------------------
   The chart marks follow the theme
   ------------------------------------------------------------------------- */

test.describe('the charts follow the reader’s theme', () => {
  test('a donut segment is repainted by a theme swap, not frozen on one palette', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'dashboard');

    const fillIn = async (theme: string | null) => {
      await applyPreferences(page, { theme });
      return page
        .locator('[data-testid="mcp-analytics-category-mix"] svg .fill-accent')
        .first()
        .evaluate((node) => getComputedStyle(node as Element).fill);
    };

    // This is the whole reason the kit was re-pointed at role tokens: `fill-indigo-500` is the
    // same hue in all nine appearances, and `fill-accent` is not.
    const light = await fillIn(null);
    const nord = await fillIn('nord');
    const solarized = await fillIn('solarized');
    expect(new Set([light, nord, solarized]).size).toBeGreaterThan(1);
  });

  test('the legend swatch and its segment stay one colour in every theme', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'dashboard');

    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      const [swatch, segment] = await page.evaluate(() => {
        const tile = document.querySelector('[data-testid="mcp-analytics-category-mix"]') as Element;
        const first = tile.querySelector('.mcpa-legend__swatch') as Element;
        const slice = tile.querySelector('svg .fill-accent') as Element;
        return [getComputedStyle(first).backgroundColor, getComputedStyle(slice).fill];
      });
      // `rgb(a, b, c)` from a background and `rgb(a, b, c)` from a fill serialise the same way.
      expect(swatch).toBe(segment);
    }
  });
});
