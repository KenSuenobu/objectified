import { test, expect, type Page } from '@playwright/test';

import {
  ICON_SIZE,
  ICON_SIZE_PX,
  ROOT_FONT_SIZE_PX,
} from '../src/app/components/ui/iconSizes';

/**
 * The `rem` audit, measured in a browser (HIVE-1.6, #5279).
 *
 * Every other suite for this ticket reads source: that the tokens say `rem`, that
 * `--text-sm` points at `--fs-sm`, that no component spells a size out. None of that
 * proves the browser agrees, and the ticket's acceptance criteria are all statements about
 * what a reader sees at a given setting. So this suite sets the preference and measures:
 *
 *   • the §3.2 scale renders at its documented pixel sizes, and grows with the scale;
 *   • an icon grows with the label beside it — the one claim that depends on a browser
 *     resolving `rem` inside an SVG `width` **attribute**, which is what `lucide-react`
 *     writes and what a stylesheet cannot reach;
 *   • Compact tightens a data table even where the page froze its own cell padding;
 *   • no font scale produces a horizontal document scrollbar (DESIGN.md §5).
 *
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 * `/login` is used because it renders the shell, type, inputs, buttons and icons without a
 * session — the same reason `preferences.spec.ts` uses it.
 */

/** The DESIGN.md §3.2 steps, as the Tailwind utility each one owns and its size in px. */
const TYPE_SCALE: ReadonlyArray<readonly [utility: string, px: number]> = [
  ['text-2xs', 11],
  ['text-xs', 12],
  ['text-sm', 13],
  ['text-base', 14],
  ['text-lg', 15],
  ['text-xl', 17],
  ['text-2xl', 20],
  ['text-3xl', 24],
  ['text-4xl', 30],
  ['text-5xl', 38],
];

/** Every font-size stop, with the root size it produces on a browser at its 16 px default. */
const FONT_SCALES: ReadonlyArray<readonly [id: string, rootPx: number]> = [
  ['xs', 14],
  ['sm', 15],
  ['md', 16],
  ['lg', 17],
  ['xl', 18],
  ['2xl', 20],
];

/**
 * Set a preference the way `PreferencesProvider` does, without a reload.
 *
 * @param page The page under test.
 * @param attribute The `<html>` attribute.
 * @param value The value to apply, or `null` to fall back to the `:root` default.
 */
async function applyPreference(page: Page, attribute: string, value: string | null): Promise<void> {
  await page.evaluate(
    ([name, next]) => {
      if (next === null) document.documentElement.removeAttribute(name as string);
      else document.documentElement.setAttribute(name as string, next as string);
    },
    [attribute, value] as const,
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/**
 * Render one class on a throwaway element and read its computed font size.
 *
 * @param page The page under test.
 * @param utility The Tailwind utility to apply.
 * @returns The computed font size, in CSS pixels.
 */
async function utilityFontSize(page: Page, utility: string): Promise<number> {
  return page.evaluate((className) => {
    const probe = document.createElement('span');
    probe.className = className;
    probe.style.position = 'absolute';
    probe.style.top = '-9999px';
    document.body.appendChild(probe);
    const size = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return size;
  }, utility);
}

/** Whether the document overflows its own viewport horizontally. */
async function horizontalOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

test.describe('rem audit', () => {
  test.beforeEach(async ({ page }) => {
    // DESIGN.md §5's layout invariant is stated at ≥1280 px, which is where the horizontal
    // scroll assertion below has to hold.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
  });

  test('every text-* utility renders its DESIGN.md §3.2 size', async ({ page }) => {
    await applyPreference(page, 'data-font-scale', 'md');

    for (const [utility, px] of TYPE_SCALE) {
      expect(await utilityFontSize(page, utility), utility).toBeCloseTo(px, 1);
    }
  });

  test('the whole scale moves with the font-size preference', async ({ page }) => {
    for (const [scale, rootPx] of FONT_SCALES) {
      await applyPreference(page, 'data-font-scale', scale);
      const ratio = rootPx / 16;

      // The smallest step and a heading step, so the assertion covers both ends: a scale
      // that only moved body copy would leave one of them behind.
      expect(await utilityFontSize(page, 'text-2xs'), `text-2xs @${scale}`).toBeCloseTo(
        11 * ratio,
        1,
      );
      expect(await utilityFontSize(page, 'text-3xl'), `text-3xl @${scale}`).toBeCloseTo(
        24 * ratio,
        1,
      );
    }
  });

  test('an icon keeps its proportion to the label beside it at every scale', async ({ page }) => {
    // `lucide-react` writes `size` as the SVG `width`/`height` **attributes**, so this is
    // the browser confirming it resolves a `rem` there. A number would pin the glyph while
    // the text around it grew, which is the failure DESIGN.md §3.5 is stated against.
    const measure = () =>
      page.evaluate((sizes) => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;top:-9999px';
        probe.innerHTML = Object.entries(sizes)
          .map(([name, size]) => `<svg data-name="${name}" width="${size}" height="${size}"></svg>`)
          .join('');
        document.body.appendChild(probe);
        const out = Object.fromEntries(
          [...probe.querySelectorAll('svg')].map((svg) => [
            svg.getAttribute('data-name'),
            svg.getBoundingClientRect().width,
          ]),
        );
        probe.remove();
        return out as Record<string, number>;
      }, ICON_SIZE as unknown as Record<string, string>);

    await applyPreference(page, 'data-font-scale', 'md');
    const atDefault = await measure();
    expect(atDefault.dense).toBeCloseTo(ICON_SIZE_PX.dense, 1);
    expect(atDefault.rail).toBeCloseTo(ICON_SIZE_PX.rail, 1);
    expect(atDefault.button).toBeCloseTo(ICON_SIZE_PX.button, 1);

    await applyPreference(page, 'data-font-scale', '2xl');
    const atLargest = await measure();
    const ratio = 20 / ROOT_FONT_SIZE_PX;
    expect(atLargest.dense).toBeCloseTo(ICON_SIZE_PX.dense * ratio, 1);
    expect(atLargest.rail).toBeCloseTo(ICON_SIZE_PX.rail * ratio, 1);
    expect(atLargest.button).toBeCloseTo(ICON_SIZE_PX.button * ratio, 1);
  });

  test('compact density tightens a data table even where the page froze its cell padding', async ({
    page,
  }) => {
    // The shared wrapper class plus the `py-4` that ~40 dashboard pages write on their own
    // cells: the wrapper has to win, or choosing Compact changes nothing a reader can see.
    const measure = () =>
      page.evaluate(() => {
        document.getElementById('hive-table-probe')?.remove();
        const host = document.createElement('div');
        host.id = 'hive-table-probe';
        host.style.cssText = 'position:absolute;top:-9999px';
        host.innerHTML = `
          <div class="table-density">
            <table>
              <thead><tr><th class="px-6">Head</th></tr></thead>
              <tbody><tr><td class="px-6 py-4">Cell</td></tr></tbody>
            </table>
          </div>`;
        document.body.appendChild(host);
        const td = host.querySelector('td') as HTMLTableCellElement;
        const result = {
          headPadding: parseFloat(getComputedStyle(host.querySelector('th')!).paddingTop),
          cellPadding: parseFloat(getComputedStyle(td).paddingTop),
          rowHeight: td.closest('tr')!.getBoundingClientRect().height,
        };
        host.remove();
        return result;
      });

    await applyPreference(page, 'data-font-scale', 'md');
    await applyPreference(page, 'data-density', null);
    const comfortable = await measure();
    // The page's own `py-4` (16px) has been replaced by the density metric.
    expect(comfortable.cellPadding).toBeLessThan(16);

    await applyPreference(page, 'data-density', 'compact');
    const compact = await measure();
    expect(compact.cellPadding).toBeLessThan(comfortable.cellPadding);
    expect(compact.headPadding).toBeLessThan(comfortable.headPadding);
    expect(compact.rowHeight).toBeLessThan(comfortable.rowHeight);

    // And the row still grows with the reader's type, rather than clipping it.
    await applyPreference(page, 'data-density', null);
    await applyPreference(page, 'data-font-scale', '2xl');
    expect((await measure()).rowHeight).toBeGreaterThan(comfortable.rowHeight);
  });

  test('no font scale produces a horizontal document scrollbar', async ({ page }) => {
    for (const density of ['comfortable', 'compact']) {
      await applyPreference(page, 'data-density', density === 'comfortable' ? null : density);

      for (const [scale] of FONT_SCALES) {
        await applyPreference(page, 'data-font-scale', scale);
        const overflow = await horizontalOverflow(page);

        expect(overflow.scrollWidth, `${scale} / ${density}`).toBeLessThanOrEqual(
          overflow.clientWidth,
        );
      }
    }
  });
});
