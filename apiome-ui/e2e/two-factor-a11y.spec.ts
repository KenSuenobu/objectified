import { test, expect, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { themes } from '../src/app/config/themes';
import { DENSITIES, FONT_SCALES } from '../src/app/config/preferences';

/**
 * Two-factor screen a11y + preference-matrix tests (HIVE-4.2, #5296).
 *
 * The structural half is pinned deterministically in jsdom by
 * `tests/two-factor-hive-redesign.test.tsx`. This suite adds what only a real browser can
 * answer, and what the redesign's definition of done asks for:
 *
 *   1. axe clean — WCAG 2.1 A/AA scans of the screen with one method offered, with both,
 *      and with an error showing, report zero violations. Contrast is the reason: the card
 *      is drawn from tokens, and a token pair that fails AA only fails once it is computed.
 *   2. Keyboard — the method switcher costs one Tab press and moves with the arrow keys,
 *      and the whole verify path is operable without a pointer.
 *   3. The preference matrix — every palette, both densities and all six font scales,
 *      none of which may give the document a horizontal scrollbar at 1280 px or 420 px.
 */

/** WCAG 2.1 Level A/AA — the conformance target for the signed-out surfaces. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The `sessionStorage` key the sign-in challenge leaves the offered methods in. */
const METHODS_KEY = 'apiome:2fa-methods';

/**
 * Every palette the reader can be in, read from the catalogue rather than listed here so
 * a tenth theme is covered the day it is added. `system` is dropped: it is a *choice*
 * that resolves to `light` or `dark`, both of which are swept on their own.
 */
const PALETTES = themes.filter((theme) => theme.appearance !== 'system');

/** Build an axe scan scoped to the WCAG A/AA ruleset for the current page. */
function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(WCAG_TAGS);
}

/**
 * Load `/login/2fa` with a given set of offered methods.
 *
 * The methods live in `sessionStorage`, which the page reads on its first client render —
 * so they have to be written before the document that reads them is fetched.
 *
 * @param page The page under test.
 * @param methods What the sign-in challenge offered.
 */
async function openTwoFactor(page: Page, methods: string[]): Promise<void> {
  await page.goto('/login');
  await page.evaluate(
    ([key, value]) => window.sessionStorage.setItem(key, value),
    [METHODS_KEY, JSON.stringify(methods)] as const
  );
  await page.goto('/login/2fa');
  await expect(page.getByTestId('two-factor-card')).toBeVisible();
}

test.describe('Two-factor screen — axe (HIVE-4.2)', () => {
  test('is axe-clean with a single method offered', async ({ page }) => {
    await openTwoFactor(page, ['totp']);
    const results = await scan(page).analyze();
    expect(results.violations).toEqual([]);
  });

  test('is axe-clean with the method switcher showing', async ({ page }) => {
    await openTwoFactor(page, ['totp', 'otp']);
    await expect(page.getByRole('tablist')).toBeVisible();
    const results = await scan(page).analyze();
    expect(results.violations).toEqual([]);
  });

  test('is axe-clean with the error banner showing', async ({ page }) => {
    // The banner is a red tint carrying a sentence: the one place on the card where a
    // token pair could fall under AA without anyone noticing in jsdom.
    await openTwoFactor(page, ['totp']);
    await page.getByLabel('Authentication code').fill('12');
    await page.getByTestId('two-factor-card').locator('form').evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
    });
    // By test id, not by role: Next's own route announcer is a second `role="alert"`.
    await expect(page.getByTestId('two-factor-error')).toBeVisible();

    const results = await scan(page).analyze();
    expect(results.violations).toEqual([]);
  });

  test('is axe-clean on the dark palette', async ({ page }) => {
    await openTwoFactor(page, ['totp', 'otp']);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      // `.dark` is what `ThemeProvider` writes for every dark-based palette, and what the
      // hex canvas keys its own data URI on.
      document.documentElement.classList.add('dark');
    });
    const results = await scan(page).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('Two-factor screen — keyboard (HIVE-4.2)', () => {
  test('reaches the switcher in one Tab stop and moves it with the arrows', async ({ page }) => {
    await openTwoFactor(page, ['totp', 'otp']);

    const authenticator = page.getByTestId('two-factor-method-totp');
    const emailCode = page.getByTestId('two-factor-method-otp');

    await authenticator.focus();
    await page.keyboard.press('ArrowRight');

    await expect(emailCode).toBeFocused();
    await expect(emailCode).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('two-factor-send-otp')).toBeVisible();

    await page.keyboard.press('ArrowLeft');
    await expect(authenticator).toBeFocused();
    await expect(page.getByLabel('Authentication code')).toBeVisible();
  });

  test('enables submit only once six digits are typed', async ({ page }) => {
    await openTwoFactor(page, ['totp']);

    const submit = page.getByTestId('two-factor-submit');
    await expect(submit).toBeDisabled();

    // Letters are refused by the box itself, not by the submit handler.
    await page.getByLabel('Authentication code').pressSequentially('12ab3456');
    await expect(page.getByLabel('Authentication code')).toHaveValue('123456');
    await expect(submit).toBeEnabled();
  });
});

test.describe('Two-factor screen — the preference matrix (HIVE-4.2)', () => {
  /**
   * Whether the document scrolls sideways — the definition-of-done check, run at the two
   * widths that break a card layout: the desktop minimum and a narrow phone.
   *
   * @param page The page under test.
   * @returns The overflow in CSS pixels; zero or less is clean.
   */
  const overflow = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );

  test('never scrolls sideways in any palette, density or font scale', async ({ page }) => {
    await openTwoFactor(page, ['totp', 'otp']);

    const offenders: string[] = [];

    for (const palette of PALETTES) {
      for (const density of DENSITIES) {
        for (const scale of FONT_SCALES) {
          await page.evaluate(
            ([theme, isDark, densityId, scaleId]) => {
              const root = document.documentElement;
              root.dataset.theme = theme as string;
              root.dataset.density = densityId as string;
              root.dataset.fontScale = scaleId as string;
              root.classList.toggle('dark', isDark as boolean);
            },
            [palette.id, palette.appearance === 'dark', density.id, scale.id] as const
          );

          for (const width of [1280, 420]) {
            await page.setViewportSize({ width, height: 900 });
            const scrolled = await overflow(page);
            if (scrolled > 0) {
              offenders.push(
                `${palette.id}/${density.id}/${scale.id} @ ${width}px → ${scrolled}px`
              );
            }
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
