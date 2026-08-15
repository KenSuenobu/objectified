import { test, expect, type Page } from '@playwright/test';

/**
 * Theme parity E2E (HIVE-1.2, #5275).
 *
 * The acceptance criterion is that "switching theme changes **only** colour: a screenshot
 * diff between two themes shows identical element geometry". A pixel diff cannot state
 * that — every pixel legitimately changes — so this suite measures it directly: it walks
 * the rendered page, records the box of every element, swaps `data-theme` on `<html>`
 * without reloading, and requires every box back, to the pixel.
 *
 * It also checks the half a Jest suite cannot see at all: that the blocks in `globals.css`
 * survive the Tailwind build and really do reach `:root` in a browser.
 *
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 * `/login` is used because it renders the shell, the brand mark, inputs and buttons
 * without needing a session.
 */

/** Every theme with a block of its own; `light` is the `:root` default it is compared to. */
const THEMES = ['dark', 'high-contrast', 'blueprint', 'whiteboard', 'solarized', 'nord', 'darcula'];

/** Themes whose block declares `color-scheme: dark`. */
const DARK_BASED = new Set(['dark', 'high-contrast', 'blueprint', 'solarized', 'nord', 'darcula']);

/** One element's identity and geometry, rounded to the pixel Playwright can compare. */
interface Box {
  /** Position of the element in document order, so two runs line up. */
  index: number;
  /** Tag name, for a readable failure message. */
  tag: string;
  /** Rounded bounding box. */
  rect: [number, number, number, number];
}

/**
 * Measure every element on the page.
 *
 * @param page The page under test.
 * @returns One entry per element, in document order.
 */
async function measure(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('body *')].map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        tag: element.tagName.toLowerCase(),
        rect: [
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height),
        ] as [number, number, number, number],
      };
    }),
  );
}

/**
 * Stop every animation and transition on the page.
 *
 * The login shell drifts decorative blobs on a 26-second loop, so two measurements taken
 * a frame apart legitimately differ by a pixel. Freezing motion is what makes "did the
 * theme move anything?" answerable at all.
 *
 * @param page The page under test.
 */
async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }`,
  });
}

/**
 * Apply a theme the way `ThemeProvider` does, without a reload.
 *
 * @param page The page under test.
 * @param themeId The resolved theme id, or `null` to fall back to the `:root` default.
 */
async function applyTheme(page: Page, themeId: string | null): Promise<void> {
  await page.evaluate((id) => {
    if (id) document.documentElement.setAttribute('data-theme', id);
    else document.documentElement.removeAttribute('data-theme');
    // next-themes writes an inline `color-scheme`, which outranks the stylesheet. Clearing
    // it exercises what the CSS itself declares — the pre-hydration and no-JS path.
    document.documentElement.style.removeProperty('color-scheme');
  }, themeId);
  // One frame for style recalculation before anything is measured.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/**
 * Read a custom property off `<html>`.
 *
 * @param page The page under test.
 * @param token Custom-property name.
 * @returns The computed value, trimmed.
 */
async function tokenValue(page: Page, token: string): Promise<string> {
  return page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    token,
  );
}

test.describe('Theme parity', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    // Web fonts settle before the baseline is taken; otherwise the first measurement
    // races the swap from the fallback stack.
    await page.evaluate(() => document.fonts.ready);
    await freezeMotion(page);
  });

  test('a theme swap changes no element geometry', async ({ page }) => {
    await applyTheme(page, null);
    const baseline = await measure(page);
    expect(baseline.length).toBeGreaterThan(10);

    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const measured = await measure(page);

      expect(measured.length, `${theme} renders the same elements`).toBe(baseline.length);
      expect(measured, `${theme} moves nothing`).toEqual(baseline);
    }
  });

  test('each theme repaints the token layer', async ({ page }) => {
    await applyTheme(page, null);
    const light = await tokenValue(page, '--bg-canvas');
    expect(light).not.toBe('');

    const seen = new Map<string, string>([['light', light]]);
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const canvas = await tokenValue(page, '--bg-canvas');

      expect(canvas, `${theme} paints its own canvas`).not.toBe('');
      expect(canvas, `${theme} differs from light`).not.toBe(light);
      seen.set(theme, canvas);
    }

    // Every palette is distinct: a block that failed to load would silently share one.
    expect(new Set(seen.values()).size).toBe(seen.size);
  });

  test('the swap reaches the aliases the components read', async ({ page }) => {
    await applyTheme(page, 'nord');

    // `--background` is the pre-Hive alias ~120 call sites still use; it has to follow.
    expect(await tokenValue(page, '--background')).toBe(await tokenValue(page, '--bg-canvas'));
    expect(await tokenValue(page, '--text-muted')).toBe(await tokenValue(page, '--fg-muted'));
    // The focus ring is built with `color-mix()`; it must mix the *theme's* accent.
    expect(await tokenValue(page, '--shadow-focus')).toContain(await tokenValue(page, '--accent'));
  });

  test('each theme declares the colour scheme its palette implies', async ({ page }) => {
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);

      expect(scheme, `${theme} colour scheme`).toBe(DARK_BASED.has(theme) ? 'dark' : 'light');
    }
  });

  test('body ink and canvas follow the theme without inline styles', async ({ page }) => {
    for (const theme of [null, ...THEMES]) {
      await applyTheme(page, theme);

      const painted = await page.evaluate(() => ({
        inline: document.body.getAttribute('style') ?? '',
        background: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color,
      }));

      // The pre-Hive provider force-wrote both onto `body.style`; the stylesheet owns them now.
      expect(painted.inline, `${theme ?? 'light'} leaves body.style alone`).not.toContain('background');
      expect(painted.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(painted.color).not.toBe('');
    }
  });
});
