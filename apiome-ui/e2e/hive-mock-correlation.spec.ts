import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The response correlation editor, measured in a browser (MSC-1.3, #5529).
 *
 * `tests/mock-correlation-editor.test.tsx` pins what the dialog renders,
 * `tests/mock-correlation-model.test.ts` pins the rules behind it, and
 * `tests/mock-correlation-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **No horizontal document scroll**, held across every theme, both densities and all six font
 *     scales — on a dialog whose content is mono operation keys, JSON Pointers, template
 *     expressions and a rendered JSON body, none of which wrap at a space.
 *   • **The four boxes that can overflow scroll inside themselves**: the bindings preview nested
 *     in a chosen mode card, the token panel, the preview's response body, and the request grid.
 *   • **The chosen mode card really takes the tint**, and the ink on it really changes — the
 *     computed halves of the HIVE-2.1 scoped choice control that a stylesheet read cannot prove.
 *   • **axe: zero serious/critical violations** with contrast actually computed, in every theme —
 *     the acceptance criterion "axe passes on the mode cards and the row editor".
 *
 * ### Why it mounts a fixture instead of signing in
 *
 * The state worth measuring — a chosen inference card showing a per-operation bindings preview,
 * two explicit rows, an open token picker and a rendered preview with its trace — needs a seeded
 * version with a mock, a saved correlation block and a reachable preview runtime. The fixture is
 * **not hand-written**: `tests/mock-correlation-editor.test.tsx` renders the real dialog and, with
 * `MOCK_CORRELATION_FIXTURE_DUMP=1`, writes what it rendered into
 * `e2e/fixtures/hive-mock-correlation/`. So what is measured here is exactly what the components
 * compose — the classes, the nesting, the ARIA — and the jsdom suite keeps the fixture honest.
 *
 * This loads `/login`, which compiles the real `globals.css` and needs no session, and injects the
 * fixture into it. Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default
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

/** Widths either side of the dialog's `rem` breakpoints, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1024, 900, 768, 640, 420];

/** Where the jsdom suite writes what it rendered. */
const FIXTURE = path.join(__dirname, 'fixtures', 'hive-mock-correlation', 'correlation-dialog.html');

/**
 * Put the dialog on a page that has the real stylesheet compiled.
 *
 * Mounted inside a `--bg-canvas` main because the dialog is an overlay over the Versions screen,
 * and the tinted mode card has to be measured against the ground it actually sits on.
 *
 * @param page - The Playwright page.
 */
async function mount(page: Page): Promise<void> {
  const html = fs.readFileSync(FIXTURE, 'utf8');
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((markup) => {
    document.body.innerHTML = `<main style="min-height:100vh;background:var(--bg-canvas);padding:1rem;display:flex;flex-direction:column">${markup}</main>`;
    document.body.style.margin = '0';
  }, html);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/**
 * Set the appearance preferences the tokens key off.
 *
 * @param page - The Playwright page.
 * @param options - Which theme, font scale and density to apply.
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
 * @param page - The Playwright page.
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
 * One computed style of the first match.
 *
 * @param page - The Playwright page.
 * @param selector - What to measure.
 * @param property - The CSS property to read.
 * @returns The computed value.
 */
function computed(page: Page, selector: string, property: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate(
      (node, name) => getComputedStyle(node as Element).getPropertyValue(name),
      property
    );
}

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the correlation editor keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page);
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const theme of THEMES) {
    test(`does not scroll sideways in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page);
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`does not scroll sideways at the ${fontScale} font scale`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page);
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page);
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The overflowing boxes scroll inside themselves
   ------------------------------------------------------------------------- */

test.describe('the wide surfaces scroll inside themselves', () => {
  test('the bindings preview scrolls inside the chosen mode card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page);
    expect(await computed(page, '.mock-corr__inferred', 'overflow-y')).toBe('auto');
    expect(await documentOverflows(page)).toBe(false);
  });

  test('the token panel scrolls rather than growing the dialog', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page);
    const panel = page.locator('.mock-tok__panel:not([hidden])');
    expect(await panel.first().evaluate((node) => getComputedStyle(node as Element).overflowY)).toBe(
      'auto'
    );
  });

  test('the rendered response body scrolls inside its own box', async ({ page }) => {
    // A synthesized JSON body is arbitrarily wide and has no space to break at; the `<pre>` is
    // what has to scroll, in both axes.
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page);
    expect(await computed(page, '.mock-prev__body', 'overflow-x')).toBe('auto');
    expect(await documentOverflows(page)).toBe(false);
  });

  test('the preview request fields collapse to one column on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page);
    const columns = await page
      .locator('.mock-prev__fields')
      .first()
      .evaluate((node) =>
        getComputedStyle(node as Element)
          .gridTemplateColumns.split(' ')
          .filter(Boolean).length
      );
    expect(columns).toBe(1);
  });
});

/* -------------------------------------------------------------------------
   The scoped choice control resolves
   ------------------------------------------------------------------------- */

test.describe('the chosen mode card takes the tint and restates its ink', () => {
  for (const theme of THEMES) {
    test(`resolves in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page);
      await applyPreferences(page, { theme });

      const chosen = page.locator('.mock-corr__mode:has(input[type="radio"]:checked)');
      const unchosen = page.locator('.mock-corr__mode:not(:has(input[type="radio"]:checked))');

      const tint = await chosen.evaluate((node) => getComputedStyle(node as Element).backgroundColor);
      const plain = await unchosen
        .first()
        .evaluate((node) => getComputedStyle(node as Element).backgroundColor);
      expect(tint).not.toBe(plain);

      // The description on the tint takes the tint-calibrated ink, not the muted grey.
      const chosenInk = await chosen
        .locator('.mock-corr__mode-desc')
        .evaluate((node) => getComputedStyle(node as Element).color);
      const plainInk = await unchosen
        .first()
        .locator('.mock-corr__mode-desc')
        .evaluate((node) => getComputedStyle(node as Element).color);
      expect(chosenInk).not.toBe(plainInk);
    });
  }
});

/* -------------------------------------------------------------------------
   axe
   ------------------------------------------------------------------------- */

test.describe('the correlation editor passes axe', () => {
  for (const theme of THEMES) {
    test(`no serious or critical violations in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page);
      await applyPreferences(page, { theme });
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const serious = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical'
      );
      expect(serious.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    });
  }

  test('the mode radios keep their nested controls out of their labels', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page);
    const nested = await page
      .locator('.mock-corr__mode-title')
      .evaluateAll((labels) =>
        labels.some((label) => label.querySelector('input, button, select, textarea, a') !== null)
      );
    expect(nested).toBe(false);
  });
});
