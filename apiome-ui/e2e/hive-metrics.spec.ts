import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The metrics set, measured in a browser (HIVE-2.6, #5285).
 *
 * `tests/hive-metrics-set.test.tsx` pins what the components render and
 * `tests/hive-metrics-styles.test.ts` pins what the stylesheet says. Neither can answer the
 * questions this ticket is actually judged on, because jsdom compiles no CSS:
 *
 *   • the ring's arc really is **the band's colour**, and the band really does change at the
 *     boundaries #5285 names — which is the acceptance criterion "quality rings match the
 *     mockups' tier colours", and cannot be checked by reading a class name;
 *   • the seat meter really does **turn warn at 80 % and danger at 100 %**;
 *   • every mark really does **re-tint with the theme**, in dark, Nord and High contrast —
 *     the three the ticket names, and the three where a frozen `indigo-500` would survive
 *     unnoticed because it is still *a* colour;
 *   • the whole kit really does **grow with the font-size preference**, because the ring is a
 *     `rem` box and the figure inside it is a proportion of that box;
 *   • the striped bar really does **stop moving** when the reader asks for less motion.
 *
 * The rest is the cross-cutting definition of done: every mark exposes its value as text, axe
 * finds nothing serious on either base, and nothing here forces the document sideways.
 *
 * Runs against `/design-system/hive` — the gallery route, which needs no session and no data.
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The section this ticket owns; the rest of the gallery belongs to its siblings. */
const OWNED_SECTION = '#metrics';

/** A light palette and a dark one — the two bases every tone has to survive. */
const BASES = [
  { id: 'light', dark: false },
  { id: 'dark', dark: true },
] as const;

/**
 * The three palettes #5285 names by hand, plus the light default they are compared against.
 *
 * Nord and High contrast are the interesting ones: both are dark-based, but they re-tint the
 * semantic roles differently, so a mark that had frozen its hue would still *look* fine on
 * "dark" and only give itself away here.
 */
const NAMED_THEMES = [
  { id: 'light', dark: false },
  { id: 'dark', dark: true },
  { id: 'nord', dark: true },
  { id: 'high-contrast', dark: true },
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
 * Load the gallery at a desktop width, with motion frozen.
 *
 * The striped bar is the one specimen that animates, and its own test un-freezes motion for
 * itself; everywhere else a running animation would only make measurements flaky.
 *
 * @param page The page under test.
 */
async function openGallery(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/design-system/hive');
  await page.waitForLoadState('networkidle');
  await page.locator(OWNED_SECTION).scrollIntoViewIfNeeded();
}

/**
 * Paint the page in one palette, the way `ThemeProvider` does.
 *
 * @param page The page under test.
 * @param base The palette to apply.
 */
async function applyBase(page: Page, base: { id: string; dark: boolean }): Promise<void> {
  await page.evaluate(({ id, dark }) => {
    document.documentElement.setAttribute('data-theme', id);
    document.documentElement.classList.toggle('dark', dark);
  }, base);
}

/** One computed property of the first match, as the browser resolved it. */
function computed(page: Page, selector: string, property: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
}

/**
 * What a Hive token resolves to *at this point in the tree*, as a resolved `rgb()` string.
 *
 * Measured with a probe rather than read off the custom property, so the comparison is between
 * two values the browser computed the same way — reading `--ok` back gives the authored text,
 * which would never equal a computed `stroke`.
 *
 * @param page The page under test.
 * @param anchor Selector for the element whose scope the token is read in.
 * @param token Custom-property name, e.g. `--ok`.
 * @returns The resolved colour.
 */
async function tokenColor(page: Page, anchor: string, token: string): Promise<string> {
  return page
    .locator(anchor)
    .first()
    .evaluate((element, name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      element.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    }, token);
}

/** The ring specimen whose caption reads `label`. */
function ringByBand(page: Page, label: string) {
  return page.locator(`${OWNED_SECTION} .hive-ring[aria-label="${label} score"]`);
}

test.describe('the Hive metrics set', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page);
    await page.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduce'));
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() => document.documentElement.removeAttribute('data-motion'));
    await applyBase(page, BASES[0]);
  });

  test('renders all five marks in the section', async ({ page }) => {
    const section = page.locator(OWNED_SECTION);
    await expect(section).toBeVisible();
    await expect(section.locator('.hive-stat-grid')).toBeVisible();
    await expect(section.locator('.hive-ring').first()).toBeVisible();
    await expect(section.locator('.hive-sparkline').first()).toBeVisible();
    await expect(section.locator('.hive-meter').first()).toBeVisible();
    await expect(section.locator('.hive-progress').first()).toBeVisible();
  });

  test.describe('the ring bands', () => {
    test('paints each band the role colour #5285 assigns it', async ({ page }) => {
      // ≥90 ok · 75–89 accent · 60–74 warn · <60 danger, measured as paint rather than as a
      // class name — which is the only way to catch a token that stopped resolving.
      const expected: [string, string][] = [
        ['Excellent', '--ok'],
        ['Good', '--accent'],
        ['Fair', '--warn'],
        ['Poor', '--danger'],
      ];

      for (const [band, token] of expected) {
        const arc = ringByBand(page, band).locator('.hive-ring__arc');
        const painted = await arc.evaluate((element) => getComputedStyle(element).stroke);
        const role = await tokenColor(page, OWNED_SECTION, token);
        expect(painted, `${band} arc should be ${token}`).toBe(role);
      }
    });

    test('gives the four bands four different colours', async ({ page }) => {
      const paints = await Promise.all(
        ['Excellent', 'Good', 'Fair', 'Poor'].map((band) =>
          ringByBand(page, band)
            .locator('.hive-ring__arc')
            .evaluate((element) => getComputedStyle(element).stroke),
        ),
      );
      expect(new Set(paints).size).toBe(4);
    });

    test('draws no arc for a score that was never taken', async ({ page }) => {
      const unscored = page.locator(`${OWNED_SECTION} .hive-ring[data-scored="false"]`).first();
      await expect(unscored).toBeVisible();
      await expect(unscored.locator('.hive-ring__arc')).toHaveCount(0);
      await expect(unscored).toHaveAttribute('role', 'img');
    });

    test('keeps its figure on the page ink, so a low band is still legible', async ({ page }) => {
      const figure = await computed(
        page,
        `${OWNED_SECTION} .hive-ring[aria-label="Poor score"] .hive-ring__figure`,
        'fill',
      );
      const ink = await tokenColor(page, OWNED_SECTION, '--fg');
      expect(figure).toBe(ink);
    });
  });

  test.describe('the meter', () => {
    /** The gallery meter whose accessible name is `label`. */
    const meter = (page: Page, label: string) =>
      page.locator(`${OWNED_SECTION} .hive-meter[aria-label="${label}"]`);

    test('is quiet at a third of its quota, warns at 82 % and turns danger when full', async ({
      page,
    }) => {
      const fill = (label: string) =>
        meter(page, label)
          .locator('.hive-progress__fill')
          .evaluate((element) => getComputedStyle(element).backgroundColor);

      const [seats, calls, storage] = await Promise.all([
        fill('Member seats'),
        fill('Monthly mock calls'),
        fill('Storage'),
      ]);

      expect(seats).toBe(await tokenColor(page, OWNED_SECTION, '--accent'));
      expect(calls).toBe(await tokenColor(page, OWNED_SECTION, '--warn'));
      expect(storage).toBe(await tokenColor(page, OWNED_SECTION, '--danger'));
    });

    test('draws the 80 % line before it is crossed', async ({ page }) => {
      const track = meter(page, 'Member seats').locator('.hive-progress');
      const box = (await track.boundingBox())!;
      const tick = (await track.locator('.hive-progress__tick').boundingBox())!;
      expect((tick.x - box.x) / box.width).toBeCloseTo(0.8, 2);
    });

    test('fills in proportion to the share, not to the label', async ({ page }) => {
      const track = meter(page, 'Member seats').locator('.hive-progress');
      const box = (await track.boundingBox())!;
      const fill = (await track.locator('.hive-progress__fill').boundingBox())!;
      expect(fill.width / box.width).toBeCloseTo(0.3, 1);
    });
  });

  test.describe('every mark follows the theme', () => {
    test('re-tints in dark, Nord and High contrast', async ({ page }) => {
      const MARKS: [string, string][] = [
        [`${OWNED_SECTION} .hive-ring__arc`, 'stroke'],
        [`${OWNED_SECTION} .hive-sparkline__line`, 'stroke'],
        [`${OWNED_SECTION} .hive-progress__fill`, 'background-color'],
        [`${OWNED_SECTION} .hive-progress`, 'background-color'],
        [`${OWNED_SECTION} .hive-stat__value`, 'color'],
      ];

      for (const [selector, property] of MARKS) {
        const seen: Record<string, string> = {};
        for (const theme of NAMED_THEMES) {
          await applyBase(page, theme);
          seen[theme.id] = await computed(page, selector, property);
        }
        // A mark that had frozen its hue would report the same paint in all four.
        expect(new Set(Object.values(seen)).size, `${selector} ${property}`).toBeGreaterThan(1);
        expect(seen.light).not.toBe(seen['high-contrast']);
      }
    });
  });

  test.describe('the preferences reach the kit', () => {
    test('the ring and its figure grow together with the font scale', async ({ page }) => {
      const ring = ringByBand(page, 'Good');
      const figureWidth = async () =>
        (await ring.locator('.hive-ring__figure').boundingBox())!.width;

      const smallBox = (await ring.boundingBox())!;
      const smallFigure = await figureWidth();

      await page.evaluate(() => document.documentElement.setAttribute('data-font-scale', '2xl'));
      const largeBox = (await ring.boundingBox())!;
      const largeFigure = await figureWidth();
      await page.evaluate(() => document.documentElement.setAttribute('data-font-scale', 'md'));

      // The box is `rem`; the figure is a fixed proportion of the box's own viewBox, so the
      // ratio between them holds at both ends and the ring never comes apart.
      expect(largeBox.width).toBeGreaterThan(smallBox.width);
      expect(largeFigure / largeBox.width).toBeCloseTo(smallFigure / smallBox.width, 1);
    });

    test('the stat strip tightens in compact density', async ({ page }) => {
      const stat = page.locator(`${OWNED_SECTION} .hive-stat`).first();
      const comfortable = (await stat.boundingBox())!;
      await page.evaluate(() => document.documentElement.setAttribute('data-density', 'compact'));
      const compact = (await stat.boundingBox())!;
      await page.evaluate(() =>
        document.documentElement.setAttribute('data-density', 'comfortable'),
      );
      expect(compact.height).toBeLessThan(comfortable.height);
    });

    test('the striped bar stops moving when the reader asks for less motion', async ({ page }) => {
      await page.evaluate(() => document.documentElement.removeAttribute('data-motion'));
      const running = await computed(
        page,
        `${OWNED_SECTION} .hive-progress--striped .hive-progress__fill`,
        'animation-duration',
      );
      expect(running).toBe('1s');

      await page.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduce'));
      const stopped = await computed(
        page,
        `${OWNED_SECTION} .hive-progress--striped .hive-progress__fill`,
        'animation-duration',
      );
      expect(stopped).toMatch(/^0m?s$/);
    });
  });

  test.describe('every mark exposes its value as text', () => {
    test('the ring is a meter that says the score and the grade', async ({ page }) => {
      const ring = ringByBand(page, 'Good');
      await expect(ring).toHaveAttribute('role', 'meter');
      await expect(ring).toHaveAttribute('aria-valuenow', '84');
      expect(await ring.getAttribute('aria-valuetext')).toContain('84 out of 100');
      expect(await ring.getAttribute('aria-valuetext')).toContain('grade B');
    });

    test('the meter reports the pair, not the percentage it derived', async ({ page }) => {
      const seats = page.locator(`${OWNED_SECTION} .hive-meter[aria-label="Member seats"]`);
      await expect(seats).toHaveAttribute('aria-valuenow', '3');
      await expect(seats).toHaveAttribute('aria-valuemax', '10');
      await expect(seats).toHaveAttribute('aria-valuetext', '3 of 10 (30%)');
    });

    test('the sparkline states the numbers its shape stands in for', async ({ page }) => {
      const spark = page.locator(`${OWNED_SECTION} .hive-sparkline`).first();
      const name = await spark.getAttribute('aria-label');
      expect(name).toContain('Mock requests, last 30 days');
      expect(name).toMatch(/latest \d+/);
      expect(name).toMatch(/high \d+/);
    });

    test('the bar is a named progressbar', async ({ page }) => {
      const bar = page.getByRole('progressbar', { name: 'Importing operations' });
      await expect(bar).toHaveAttribute('aria-valuenow', '64');
      await expect(bar).toHaveAttribute('aria-valuetext', '64%');
    });
  });

  test.describe('the cross-cutting definition of done', () => {
    for (const base of BASES) {
      test(`has no serious or critical axe violations on ${base.id}`, async ({ page }) => {
        await applyBase(page, base);
        const results = await new AxeBuilder({ page })
          .include(OWNED_SECTION)
          .withTags(WCAG_TAGS)
          .analyze();
        expect(blockingViolations(results.violations)).toEqual([]);
      });
    }

    test('never forces the document sideways at 1280 px', async ({ page }) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
