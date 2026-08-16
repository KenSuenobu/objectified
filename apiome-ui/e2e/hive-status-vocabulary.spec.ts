import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The status vocabulary, measured in a browser (HIVE-2.4, #5283).
 *
 * `tests/hive-status-vocabulary.test.tsx` pins the mapping and what each component renders, and
 * `tests/hive-status-vocabulary-styles.test.ts` pins what the stylesheet says. Neither can answer
 * the two questions this ticket is actually judged on, because jsdom compiles no CSS:
 *
 *   • a **status** tone really does follow the reader's theme — the same `published` badge is a
 *     different green on Dark than on Light, which is what keeps it legible there;
 *   • a **format** hue and an **HTTP verb** hue really do not — the AsyncAPI pill and the GET
 *     chip paint the same colour in every palette, which is what makes them learnable.
 *
 * Those are opposite claims about the same section, and only a real cascade can tell them apart.
 * The rest of the suite covers the cross-cutting definition of done: colour is never the only
 * signal, axe finds nothing serious in either base, and nothing here forces the document sideways.
 *
 * Runs against `/design-system/hive` — the gallery route, which needs no session and no data.
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The section this ticket owns; the rest of the gallery belongs to its siblings. */
const OWNED_SECTION = '#status-vocabulary';

/**
 * Every palette of DESIGN.md §4 — the eight the theme picker offers behind its nine entries,
 * since `system` is a choice that resolves to `light` or `dark` rather than a palette of its own
 * — by the id `data-theme` takes, with the base each paints on.
 *
 * Spelled out rather than imported so the suite fails loudly when a palette is added without
 * anyone deciding what it does to the fixed hues.
 */
const THEMES = [
  { id: 'light', dark: false },
  { id: 'whiteboard', dark: false },
  { id: 'dark', dark: true },
  { id: 'high-contrast', dark: true },
  { id: 'blueprint', dark: true },
  { id: 'solarized', dark: true },
  { id: 'nord', dark: true },
  { id: 'darcula', dark: true },
] as const;

/**
 * The blocking half of an axe run.
 *
 * @param violations Everything axe reported.
 * @returns Only the serious and critical entries, which is what DESIGN.md §6 forbids.
 */
function blockingViolations<T extends { impact?: string | null }>(violations: T[]): T[] {
  return violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''));
}

/**
 * Load the gallery at a desktop width with motion frozen.
 *
 * @param page The page under test.
 */
async function openGallery(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/design-system/hive');
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
}

/**
 * Paint the page in one palette, the way `ThemeProvider` does.
 *
 * @param page The page under test.
 * @param theme The palette to apply.
 */
async function applyTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.evaluate(({ id, dark }) => {
    document.documentElement.setAttribute('data-theme', id);
    document.documentElement.classList.toggle('dark', dark);
  }, theme);
}

/** The rendered fill and ink of an element, as the browser resolved them. */
async function paintOf(page: Page, selector: string): Promise<{ fill: string; ink: string }> {
  return page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { fill: style.backgroundColor, ink: style.color };
  });
}

test.describe('Hive status vocabulary gallery', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page);
  });

  test.afterEach(async ({ page }) => {
    await applyTheme(page, THEMES[0]);
  });

  test('renders the section with all four families in it', async ({ page }) => {
    const section = page.locator(OWNED_SECTION);
    await expect(section).toBeVisible();
    await expect(section.locator('[data-status="published"]')).toBeVisible();
    await expect(section.locator('.fmt').first()).toBeVisible();
    await expect(section.locator('.method--get')).toBeVisible();
    await expect(section.locator('[data-testid="grade-chip"]').first()).toBeVisible();
  });

  test.describe('identity hues stay put', () => {
    test('a format pill is the same colour in every palette', async ({ page }) => {
      const selector = `${OWNED_SECTION} [data-format="asyncapi"]`;
      const paints = [];
      for (const theme of THEMES) {
        await applyTheme(page, theme);
        paints.push({ theme: theme.id, ...(await paintOf(page, selector)) });
      }

      const [first, ...rest] = paints;
      for (const paint of rest) {
        expect([paint.theme, paint.fill, paint.ink]).toEqual([paint.theme, first.fill, first.ink]);
      }
    });

    test('an HTTP verb chip is the same colour in every palette', async ({ page }) => {
      const selector = `${OWNED_SECTION} .method--get`;
      const paints = [];
      for (const theme of THEMES) {
        await applyTheme(page, theme);
        paints.push({ theme: theme.id, ...(await paintOf(page, selector)) });
      }

      const [first, ...rest] = paints;
      for (const paint of rest) {
        expect([paint.theme, paint.fill, paint.ink]).toEqual([paint.theme, first.fill, first.ink]);
      }
    });

    test('keeps an unrecognised format visible instead of dropping it', async ({ page }) => {
      // The neutral hue is a hue, not the absence of one: a format nobody has registered still
      // gets a readable pill carrying its raw token.
      const pill = page.locator(`${OWNED_SECTION} [data-format="mystery-format"]`);
      await expect(pill).toBeVisible();
      await expect(pill).toHaveText('mystery-format');
      const { fill } = await paintOf(page, `${OWNED_SECTION} [data-format="mystery-format"]`);
      expect(fill).not.toBe('rgba(0, 0, 0, 0)');
    });
  });

  test.describe('status tones move with the palette', () => {
    test('a published badge is repainted on a dark base', async ({ page }) => {
      const selector = `${OWNED_SECTION} [data-status="published"]`;

      await applyTheme(page, { id: 'light', dark: false });
      const light = await paintOf(page, selector);

      await applyTheme(page, { id: 'dark', dark: true });
      const dark = await paintOf(page, selector);

      // Same meaning, different palette — the tone is a token, so it follows. (Which palettes
      // restate which tokens is HIVE-1.2's decision: `dark` restates the whole `ok` family,
      // while Nord and Darcula restate only the saturated hue.)
      expect(dark.fill).not.toBe(light.fill);
      expect(dark.ink).not.toBe(light.ink);
    });

    test('the same string is the same tone wherever it is drawn', async ({ page }) => {
      const section = page.locator(OWNED_SECTION);
      // The badge fills with `--warn-soft`; the health pill inks with `--warn-fg`. Both are the
      // warn family, so each must match the token the layer resolves — that is the whole claim.
      const [badgeFill, pillInk, warnSoft, warnFg] = await section.evaluate((element) => {
        // `Badge` renders a div, `HealthPill` a span — both carry `data-status="degraded"`.
        const badge = element.querySelector('div[data-status="degraded"]')!;
        const pill = element.querySelector('span[data-status="degraded"]')!;
        // A token is only a string until something paints with it, so resolve both through a
        // throwaway element rather than reading the custom property text.
        const probe = document.createElement('span');
        document.body.append(probe);
        const resolve = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = [
          getComputedStyle(badge).backgroundColor,
          getComputedStyle(pill).color,
          resolve('--warn-soft'),
          resolve('--warn-fg'),
        ];
        probe.remove();
        return result;
      });

      expect(badgeFill).toBe(warnSoft);
      expect(pillInk).toBe(warnFg);
    });
  });

  test('colour is never the only signal', async ({ page }) => {
    const section = page.locator(OWNED_SECTION);
    for (const selector of ['.fmt', '.method', '[data-testid="grade-chip"]', '[data-status]']) {
      const texts = await section.locator(selector).allTextContents();
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) expect(text.trim()).not.toBe('');
    }
  });

  test('the chips scale with the font-size preference rather than freezing', async ({ page }) => {
    const chip = page.locator(`${OWNED_SECTION} .method--get`);
    const heightAt = async (scale: string) => {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-font-scale', value);
      }, scale);
      return (await chip.boundingBox())?.height ?? 0;
    };

    const atDefault = await heightAt('md');
    const atLarge = await heightAt('2xl');
    expect(atLarge).toBeGreaterThan(atDefault);
    await page.evaluate(() => document.documentElement.setAttribute('data-font-scale', 'md'));
  });

  test('adds no horizontal document scroll at 1280 px', async ({ page }) => {
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(client);
  });

  test('the section is axe-clean on a light base', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include(OWNED_SECTION)
      .analyze();
    expect(blockingViolations(results.violations)).toEqual([]);
  });

  test('the section is axe-clean on a dark base', async ({ page }) => {
    // The fixed hues are the reason this run matters: they do not re-tint, so if one of them
    // stopped clearing contrast on a dark canvas, only a real render would say so.
    await applyTheme(page, { id: 'dark', dark: true });
    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .include(OWNED_SECTION)
      .analyze();
    expect(blockingViolations(results.violations)).toEqual([]);
  });
});
