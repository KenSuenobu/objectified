import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The feedback set, measured in a browser (HIVE-2.5, #5284).
 *
 * `tests/hive-feedback-set.test.tsx` pins what the components render and
 * `tests/hive-feedback-styles.test.ts` pins what the stylesheet says. Neither can answer the
 * questions this ticket is actually judged on, because jsdom compiles no CSS:
 *
 *   • the hex art is really a **hexagon**, really honey, and really re-tints with the theme —
 *     which is what makes it brand ornament rather than a grey box;
 *   • the art really does **out-specify a call site's own glyph classes**, which is the whole
 *     reason forty-two pre-Hive `icon={<X className="text-white" />}` call sites did not need
 *     editing;
 *   • the whole assembly really does **grow with the font-size preference**, because every
 *     dimension inside it is a percentage of a `rem` box;
 *   • the skeleton really does **stop moving** when the reader asks for less motion.
 *
 * The rest is the cross-cutting definition of done: the states announce themselves, axe finds
 * nothing serious on either base, and nothing here forces the document sideways.
 *
 * Runs against `/design-system/hive` — the gallery route, which needs no session and no data.
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The section this ticket owns; the rest of the gallery belongs to its siblings. */
const OWNED_SECTION = '#feedback';

/** A light palette and a dark one — the two bases every tone has to survive. */
const BASES = [
  { id: 'light', dark: false },
  { id: 'dark', dark: true },
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
 * Load the gallery at a desktop width.
 *
 * Motion is *not* frozen here the way the sibling suites freeze it: one of the claims below
 * is about the shimmer, so the suite that measures it has to let it run.
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
 * Paint the page in one base, the way `ThemeProvider` does.
 *
 * @param page The page under test.
 * @param base The palette to apply.
 */
async function applyBase(page: Page, base: (typeof BASES)[number]): Promise<void> {
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
    .evaluate(
      (element, name) => getComputedStyle(element).getPropertyValue(name),
      property
    );
}

test.describe('the Hive feedback set', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page);
  });

  test.afterEach(async ({ page }) => {
    await applyBase(page, BASES[0]);
  });

  test('renders all four surfaces in the section', async ({ page }) => {
    const section = page.locator(OWNED_SECTION);
    await expect(section).toBeVisible();
    await expect(section.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
    await expect(section.getByRole('heading', { name: 'Pick a workspace first' })).toBeVisible();
    await expect(
      section.getByRole('heading', { name: 'Catalog analytics unavailable' })
    ).toBeVisible();
    await expect(section.locator('.hive-skeleton').first()).toBeVisible();
  });

  test.describe('the hex art', () => {
    test('is clipped to the shared hexagon, not left as a square', async ({ page }) => {
      const clip = await computed(page, `${OWNED_SECTION} .hive-empty-art__hex`, 'clip-path');
      // Resolved through `--hex-clip`, so this also proves the token reaches the rule.
      expect(clip).toContain('polygon');
      expect(clip).toContain('25%');
    });

    test('colours its own glyph, whatever the call site asked for', async ({ page }) => {
      // The rule is a descendant selector so it out-specifies a caller's `text-white`. Here
      // that is measured rather than asserted about the source: the glyph's colour has to be
      // the art's ink, and the art's ink has to be the honey role.
      const glyph = await computed(page, `${OWNED_SECTION} .hive-empty-art > svg`, 'color');

      // What `--honey-fg` resolves to right here, measured by a probe rather than read off
      // the custom property, so the comparison is between two resolved `rgb()` strings.
      const honeyInk = await page
        .locator(`${OWNED_SECTION} .hive-empty-art`)
        .first()
        .evaluate((element) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--honey-fg)';
          element.append(probe);
          const resolved = getComputedStyle(probe).color;
          probe.remove();
          return resolved;
        });

      expect(honeyInk).toMatch(/^rgb/);
      expect(glyph).toBe(honeyInk);
      expect(glyph).not.toBe('rgb(255, 255, 255)');
    });

    test('re-tints with the theme — it is ornament, not a fixed identity', async ({ page }) => {
      const selector = `${OWNED_SECTION} .hive-empty-art__hex`;
      const paints: Record<string, string> = {};
      for (const base of BASES) {
        await applyBase(page, base);
        paints[base.id] = await computed(page, selector, 'background-color');
      }
      // Unlike a format pill or a verb chip (HIVE-2.4), the art is a *tone*: it has to keep
      // its contrast on a dark base rather than keep its hue.
      expect(paints.dark).not.toBe(paints.light);
    });

    test('grows with the font-size preference, all of it together', async ({ page }) => {
      const box = async () =>
        (await page.locator(`${OWNED_SECTION} .hive-empty-art`).first().boundingBox())!;
      const glyph = async () =>
        (await page.locator(`${OWNED_SECTION} .hive-empty-art > svg`).first().boundingBox())!;

      const smallBox = await box();
      const smallGlyph = await glyph();

      await page.evaluate(() => document.documentElement.setAttribute('data-font-scale', '2xl'));
      const largeBox = await box();
      const largeGlyph = await glyph();
      await page.evaluate(() => document.documentElement.setAttribute('data-font-scale', 'md'));

      // The box is `rem`, the glyph is a percentage of the box — so the ratio between them
      // is the same at both ends and the art never comes apart.
      expect(largeBox.width).toBeGreaterThan(smallBox.width);
      expect(largeGlyph.width / largeBox.width).toBeCloseTo(smallGlyph.width / smallBox.width, 2);
    });
  });

  test.describe('the skeleton', () => {
    test('sweeps a band across the placeholder', async ({ page }) => {
      const duration = await page
        .locator(`${OWNED_SECTION} .hive-skeleton`)
        .first()
        .evaluate((element) => getComputedStyle(element, '::after').animationDuration);
      expect(duration).toBe('1.4s');
    });

    test('stops moving when the reader asks for less motion', async ({ page }) => {
      await page.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduce'));
      const duration = await page
        .locator(`${OWNED_SECTION} .hive-skeleton`)
        .first()
        .evaluate((element) => getComputedStyle(element, '::after').animationDuration);
      await page.evaluate(() => document.documentElement.removeAttribute('data-motion'));
      expect(duration).toMatch(/^0m?s$/);
    });
  });

  test.describe('the states announce themselves', () => {
    test('loading is a polite live region that names what is coming', async ({ page }) => {
      const region = page.locator(`${OWNED_SECTION} [role="status"]`).first();
      await expect(region).toHaveAttribute('aria-live', 'polite');
      await expect(region).toHaveAttribute('aria-busy', 'true');
      await expect(region).toContainText('Publishing version 2.4.0');
    });

    test('a failure is an alert with a retry beside it', async ({ page }) => {
      const alert = page.locator(`${OWNED_SECTION} [role="alert"]`).first();
      await expect(alert).toBeVisible();
      await expect(alert.getByRole('button', { name: /Try again/i })).toBeVisible();
    });

    test('a gate offers the way through it', async ({ page }) => {
      await expect(
        page.locator(OWNED_SECTION).getByRole('link', { name: 'Go to Tenants' })
      ).toHaveAttribute('href', '/ade/dashboard/tenants');
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
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
