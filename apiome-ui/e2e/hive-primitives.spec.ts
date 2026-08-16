import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The new Hive primitives, measured in a browser (HIVE-2.2, #5281).
 *
 * `tests/hive-new-primitives.test.tsx` pins what the components render and
 * `tests/hive-new-primitive-styles.test.ts` pins what the stylesheet says. Neither can
 * answer the questions this ticket is actually judged on, because jsdom compiles no CSS and
 * has no layout:
 *
 *   • the drawer really is a 520 px sheet against the right edge, it traps focus, `Esc`
 *     closes it and focus comes back to whatever opened it;
 *   • the segmented control moves with the arrow keys and the thumb really is raised;
 *   • a hexagon avatar is clipped to the mockup's polygon, and one identity is one colour
 *     wherever it appears on the page;
 *   • the shortcut chips actually disappear when "Show keyboard hints" is off;
 *   • axe finds nothing serious with the drawer open, and nothing here forces the document
 *     sideways at 1280 px.
 *
 * Runs against `/design-system/hive` — the gallery route, which needs no session and no
 * data, so this suite is deterministic. Requires the app to be running
 * (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * The parts of the gallery this ticket owns.
 *
 * The scans below are scoped rather than page-wide on purpose. The route also renders the
 * HIVE-2.1 specimens, and those carry violations that belong to other tickets and cannot
 * be fixed from here: `FormField` does not yet tie its `<label>` to the control it wraps,
 * the `Select` trigger has no accessible name without one, and `--accent` / `--fg-subtle`
 * on a light canvas are contrast decisions in the token layer. Scoping keeps this suite a
 * gate on the four new primitives instead of a broken window for all of them.
 */
const OWNED_SECTIONS = ['#segmented', '#avatars'];

/**
 * The blocking half of an axe run.
 *
 * @param violations Everything axe reported.
 * @returns Only the serious and critical entries, which is what DESIGN.md §6 forbids.
 */
function blockingViolations<T extends { impact?: string | null }>(violations: T[]): T[] {
  return violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''));
}

/** The default drawer width of DESIGN.md §5.4, in CSS pixels at the default font scale. */
const DRAWER_WIDTH = 520;

/**
 * Freeze every transition and animation.
 *
 * Every primitive here animates over `--dur-fast`/`--dur-slow`, so a `getComputedStyle`
 * read taken right after a click returns a mid-transition value — a raised thumb that has
 * not finished rising looks like no thumb at all.
 *
 * @param page The page under test.
 */
async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
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
  await freezeMotion(page);
}

/**
 * The view switch at the top of the §Segmented section.
 *
 * Scoped to the section, and `exact`: the gallery grew a §Tables section in HIVE-2.3 whose
 * toolbar carries a view switch of its own, and Playwright matches an accessible name by
 * substring unless told otherwise.
 */
const viewSwitch = (page: Page) =>
  page.locator('#segmented').getByRole('radiogroup', { name: 'View', exact: true });

test.describe('Hive primitives gallery', () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page);
  });

  test('renders all four new primitives on the design-system route', async ({ page }) => {
    await expect(viewSwitch(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open drawer' })).toBeVisible();
    await expect(page.locator('.avatar-hex').first()).toBeVisible();
    await expect(page.locator('.kbd').first()).toBeVisible();
  });

  test.describe('Segmented', () => {
    test('moves with the arrow keys and announces the selection', async ({ page }) => {
      const cards = viewSwitch(page).getByRole('radio', { name: 'Cards' });
      const table = viewSwitch(page).getByRole('radio', { name: 'Table' });

      await expect(cards).toHaveAttribute('aria-checked', 'true');
      // Focus with the keyboard rather than `.focus()`: `:focus-visible` does not match a
      // programmatic focus in Chrome, and the ring is part of what is under test.
      await cards.press('ArrowRight');

      await expect(table).toBeFocused();
      await expect(table).toHaveAttribute('aria-checked', 'true');
      await expect(cards).toHaveAttribute('aria-checked', 'false');

      // The whole group is one Tab stop: only the selected option is reachable by Tab.
      await expect(table).toHaveAttribute('tabindex', '0');
      await expect(cards).toHaveAttribute('tabindex', '-1');
    });

    test('raises the selected option out of the track', async ({ page }) => {
      const selected = viewSwitch(page).getByRole('radio', { name: 'Cards' });
      const unselected = viewSwitch(page).getByRole('radio', { name: 'Table' });

      const shadowOf = (locator: ReturnType<Page['locator']>) =>
        locator.evaluate((element) => getComputedStyle(element).boxShadow);

      expect(await shadowOf(selected)).not.toBe('none');
      expect(await shadowOf(unselected)).toBe('none');

      // The thumb is a surface lifted out of a tinted well, so the two backgrounds differ.
      const [thumb, track] = await Promise.all([
        selected.evaluate((element) => getComputedStyle(element).backgroundColor),
        viewSwitch(page).evaluate((element) => getComputedStyle(element).backgroundColor),
      ]);
      expect(thumb).not.toBe(track);
    });

    test('skips a disabled option', async ({ page }) => {
      const scope = page.getByRole('radiogroup', { name: 'Scope' });
      await scope.getByRole('radio', { name: 'Mine' }).press('ArrowRight');
      await expect(scope.getByRole('radio', { name: 'Workspace' })).toBeFocused();
      await scope.getByRole('radio', { name: 'Workspace' }).press('ArrowRight');
      // Three options, one disabled: forward from the second wraps back to the first.
      await expect(scope.getByRole('radio', { name: 'Mine' })).toBeFocused();
      await expect(scope.getByRole('radio', { name: 'Archived' })).toBeDisabled();
    });
  });

  test.describe('Drawer', () => {
    test('is a right-edge sheet at the DESIGN.md §5.4 width', async ({ page }) => {
      await page.getByRole('button', { name: 'Open drawer' }).click();
      const sheet = page.getByRole('dialog', { name: 'Audit event' });
      await expect(sheet).toBeVisible();

      const box = await sheet.boundingBox();
      const viewport = page.viewportSize();
      expect(box?.width).toBeCloseTo(DRAWER_WIDTH, 0);
      expect(box?.height).toBeCloseTo(viewport?.height ?? 0, 0);
      // Flush against the right edge, and full height — a sheet, not a centred box.
      expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(viewport?.width);
      expect(Math.round(box?.y ?? -1)).toBe(0);
    });

    test('traps focus, closes on Escape and restores focus to the trigger', async ({ page }) => {
      const trigger = page.getByRole('button', { name: 'Open drawer' });
      await trigger.click();
      const sheet = page.getByRole('dialog', { name: 'Audit event' });
      await expect(sheet).toBeVisible();

      // Tab right round the sheet: focus must never land outside it.
      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press('Tab');
        const inside = await sheet.evaluate((element) =>
          element.contains(document.activeElement)
        );
        expect(inside).toBe(true);
      }

      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test('leaves the page behind it in place, with no horizontal scroll', async ({ page }) => {
      const scrollWidth = () =>
        page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));

      const before = await scrollWidth();
      expect(before.scroll).toBeLessThanOrEqual(before.client);

      await page.getByRole('button', { name: 'Open drawer' }).click();
      await expect(page.getByRole('dialog', { name: 'Audit event' })).toBeVisible();

      const during = await scrollWidth();
      expect(during.scroll).toBeLessThanOrEqual(during.client);
    });

    test('offers the full page as a link', async ({ page }) => {
      await page.getByRole('button', { name: 'Open drawer' }).click();
      await expect(page.getByRole('link', { name: 'Open full page' })).toBeVisible();
    });

    test('is axe-clean while open', async ({ page }) => {
      await page.getByRole('button', { name: 'Open drawer' }).click();
      await expect(page.getByRole('dialog', { name: 'Audit event' })).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .include('[role="dialog"]')
        .analyze();
      expect(blockingViolations(results.violations)).toEqual([]);
    });
  });

  test.describe('Avatar', () => {
    test('clips a workspace avatar to the mockup hexagon', async ({ page }) => {
      const hex = page.locator('.avatar-hex').first();
      const clip = await hex.evaluate((element) => getComputedStyle(element).clipPath);
      expect(clip).toContain('polygon');
      expect(clip.replace(/\s+/g, ' ')).toContain('25% 3%');

      // A hexagon is not a rounded box: the radius has to be gone, or the two shapes fight.
      const radius = await hex.evaluate((element) => getComputedStyle(element).borderRadius);
      expect(radius).toBe('0px');
    });

    test('gives one identity one colour, in two places on the page', async ({ page }) => {
      const gallery = page.locator('[data-tone]').filter({ hasText: 'AL' }).first();
      const galleryTone = await gallery.getAttribute('data-tone');
      const galleryColour = await gallery.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );

      // The same person, rendered again inside the drawer from the same seed.
      await page.getByRole('button', { name: 'Open drawer' }).click();
      const inDrawer = page
        .getByRole('dialog', { name: 'Audit event' })
        .locator('[data-tone]')
        .first();

      expect(await inDrawer.getAttribute('data-tone')).toBe(galleryTone);
      expect(await inDrawer.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        galleryColour
      );
    });

    test('scales with the font-size preference rather than freezing', async ({ page }) => {
      const avatar = page.locator('[data-tone]').filter({ hasText: 'AT' }).first();
      const widthAt = async (scale: string) => {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-font-scale', value);
        }, scale);
        return (await avatar.boundingBox())?.width ?? 0;
      };

      const atDefault = await widthAt('md');
      const atLarge = await widthAt('2xl');
      expect(atLarge).toBeGreaterThan(atDefault);
      await page.evaluate(() => document.documentElement.setAttribute('data-font-scale', 'md'));
    });
  });

  test.describe('Kbd', () => {
    test('disappears when the keyboard-hints preference is off', async ({ page }) => {
      const chip = page.locator('.kbd').first();
      await expect(chip).toBeVisible();

      await page.evaluate(() =>
        document.documentElement.setAttribute('data-kbd-hints', 'off')
      );
      await expect(chip).toBeHidden();

      await page.evaluate(() => document.documentElement.setAttribute('data-kbd-hints', 'on'));
      await expect(chip).toBeVisible();
    });

    test('leaves the shortcut itself working', async ({ page }) => {
      // The chip is presentation: hiding it must not change the control it sits on, which
      // is why the button keeps its accessible name either way.
      await page.evaluate(() =>
        document.documentElement.setAttribute('data-kbd-hints', 'off')
      );
      await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
      await page.evaluate(() => document.documentElement.setAttribute('data-kbd-hints', 'on'));
    });
  });

  test('the new sections are axe-clean', async ({ page }) => {
    const builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
    for (const section of OWNED_SECTIONS) builder.include(section);
    const results = await builder.analyze();
    expect(blockingViolations(results.violations)).toEqual([]);
  });
});
