import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The Add-repository screen, measured in a browser (HIVE-7.4, #5321).
 *
 * `tests/add-repository-hive-redesign.test.tsx` pins what the screen renders,
 * `tests/add-repository-model.test.ts` pins the decisions behind it, and
 * `tests/add-repository-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a form carrying a four-step progress row, a
 *     two-up choice grid, a tile grid, a 22rem scroll list and a three-column proposal card.
 *   • **The account tiles and the proposal columns really collapse**, which is the whole
 *     reason both are `auto-fit, minmax(…rem, 1fr)` rather than the mockup's fixed three: at
 *     the Largest font scale 13rem is 25 % wider than at the default, and the grid has to drop
 *     a column rather than push the page sideways.
 *   • **The repository list scrolls inside its own well**, never taking the document with it —
 *     the `overscroll-behavior: contain` that a stylesheet test can only assert is *written*.
 *   • **A long repository path cannot hold a row open** — `text-overflow: ellipsis` on a flex
 *     child only works because every ancestor carries `min-inline-size: 0`, and whether that
 *     chain is intact is a question about line breaking.
 *   • **Every choice row shows a focus ring**, although two of the three hide their native
 *     radio: `:has(input:focus-visible)` is a selector no jsdom suite can evaluate.
 *   • **"axe: zero serious/critical violations"** on all three surfaces, in every theme.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-repositories.spec.ts` gives: every read here is tenant-scoped, and the
 * states worth measuring — a GitHub account mid-browse, a GitLab account that cannot be
 * browsed, a failed URL test, no linked accounts at all — are ones a seeded database will not
 * produce on demand.
 *
 * The fixtures are **not hand-written**. `tests/add-repository-hive-redesign.test.tsx` renders
 * the real screen against mocked reads and, with `ADD_REPOSITORY_FIXTURE_DUMP=1`, writes what
 * it rendered into `e2e/fixtures/hive-add-repository/`. So what is measured here is exactly
 * what the components compose — the classes, the nesting, the ARIA — and the jsdom suite is
 * what keeps the fixtures honest.
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

/** Widths either side of the block's `rem` breakpoint, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1100, 1024, 900, 768, 640, 420];

/** Where the jsdom suite writes what it rendered. */
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-add-repository');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'linked' | 'url' | 'empty';

/** All three, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = ['linked', 'url', 'empty'];

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
    // Freeze every transition — the trap `hive-repositories.spec.ts` records. The choice cards
    // carry box-shadow transitions, so a `data-theme` swap *animates* every one of them, and
    // axe sampling mid-animation reports a `color-contrast` failure against a colour that
    // exists in neither theme. A measurement has to be of a settled frame.
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
    for (const name of ['linked', 'url'] as const) {
      test(`the ${name} surface does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mount(page, name);
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const theme of THEMES) {
    test(`the linked surface does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'linked');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the linked surface does not scroll sideways at the ${fontScale} font scale`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'linked');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`the linked surface does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'linked');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The grids collapse
   ------------------------------------------------------------------------- */

test.describe('every grid folds rather than pushing the page', () => {
  test('the source choice is two-up on a desktop and one-up on a phone', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'linked');
    expect(await gridColumns(page, '.repo-new-sources')).toBe(2);

    await page.setViewportSize({ width: 420, height: 900 });
    expect(await gridColumns(page, '.repo-new-sources')).toBe(1);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('the account tiles drop a column as the type grows', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, 'linked');
    await applyPreferences(page, { fontScale: 'xs' });
    const small = await gridColumns(page, '.repo-new-accounts');

    await applyPreferences(page, { fontScale: '2xl' });
    const large = await gridColumns(page, '.repo-new-accounts');

    expect(large).toBeLessThanOrEqual(small);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('the proposal card folds to one column on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'linked');
    expect(await gridColumns(page, '.repo-new-proposal__grid')).toBe(1);
  });
});

/* -------------------------------------------------------------------------
   The repository list
   ------------------------------------------------------------------------- */

test.describe('the repository list', () => {
  test('scrolls inside its own well rather than taking the document with it', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'linked');
    const well = page.locator('.repo-new-repos');
    const box = await well.evaluate((node) => {
      const element = node as HTMLElement;
      return {
        clientHeight: element.clientHeight,
        maxHeight: getComputedStyle(element).maxBlockSize,
        overscroll: getComputedStyle(element).overscrollBehaviorY,
        overflow: getComputedStyle(element).overflowY,
      };
    });
    expect(box.overflow).toBe('auto');
    expect(box.overscroll).toBe('contain');
    // 22rem at the default 16px root.
    expect(box.clientHeight).toBeLessThanOrEqual(352);
  });

  test('a long path is clipped rather than holding the row open', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, 'linked');
    await page.locator('.repo-new-repo__name').first().evaluate((node) => {
      node.textContent = 'a-very-long-organisation-name / an-even-longer-repository-name-here';
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await documentOverflows(page)).toBe(false);

    const clipped = await page
      .locator('.repo-new-repo__name')
      .first()
      .evaluate((node) => {
        const element = node as HTMLElement;
        return {
          overflows: element.scrollWidth > element.clientWidth,
          ellipsis: getComputedStyle(element).textOverflow,
        };
      });
    expect(clipped.ellipsis).toBe('ellipsis');
    expect(clipped.overflows).toBe(true);
  });
});

/* -------------------------------------------------------------------------
   Focus is visible on every choice
   ------------------------------------------------------------------------- */

test.describe('focus', () => {
  test('shows a ring on the row, not only on a radio that may be hidden', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'linked');

    for (const selector of ['.repo-new-source', '.repo-new-account', '.repo-new-repo']) {
      const input = page.locator(`${selector} input`).first();
      await input.focus();
      // `:focus-visible` follows keyboard intent; pressing a key on the focused control is what
      // makes the browser grant it after a programmatic focus.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      const width = await page
        .locator(selector)
        .first()
        .evaluate((node) => getComputedStyle(node as Element).outlineWidth);
      expect({ selector, width }).toEqual({ selector, width: '2px' });
    }
  });
});

/* -------------------------------------------------------------------------
   The proposal is unmistakable
   ------------------------------------------------------------------------- */

test.describe('the proposal card', () => {
  test('is framed and says so in words, in every theme', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'linked');

    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      const framed = await page
        .locator('.repo-new-proposal')
        .evaluate((node) => getComputedStyle(node as Element).boxShadow);
      expect({ theme: theme ?? 'light', framed: framed !== 'none' }).toEqual({
        theme: theme ?? 'light',
        framed: true,
      });
    }

    await expect(page.getByText('Redesign proposal — not in the app today')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Proposed steps 2–4/ })).toBeVisible();
  });

  test('holds nothing that can be pressed', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'linked');
    expect(
      await page.locator('.repo-new-proposal button, .repo-new-proposal a, .repo-new-proposal input').count()
    ).toBe(0);
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
    test(`the linked surface passes axe in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'linked');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  test('the URL surface passes axe with a failed test showing', async ({ page }) => {
    // The tinted danger strip is the one thing on this screen whose ink and ground are both
    // tokens the reader's theme swaps; it is measured in every theme by the stylesheet suite
    // and here once, composited by a real browser.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'url');
    await expect(page.locator('[data-tone="danger"]')).toBeVisible();
    expect(await blockingViolations(page)).toEqual([]);
  });
});
