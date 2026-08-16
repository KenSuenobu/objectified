import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Device preferences E2E (HIVE-1.3, #5276).
 *
 * The acceptance criteria are all things only a browser can answer: that the font-size
 * slider rescales the *whole* interface rather than body copy alone, that compact density
 * tightens rows and padding without pushing content off-screen, that reduce-motion really
 * stops transitions, and — the one a Jest suite cannot see at all — that a hard reload
 * paints the stored preferences straight away instead of correcting itself afterwards.
 *
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 * `/login` is used because it renders the shell, inputs and buttons without a session.
 */

/** What a device with settings looks like, and what each one should produce. */
const STORED = {
  'hive.fontScale': '2xl',
  'hive.density': 'compact',
  'hive.motion': 'reduce',
  'hive.rail': 'collapsed',
} as const;

/**
 * Seed `localStorage` for the next navigation, before any page script runs.
 *
 * @param page The page under test.
 * @param entries Keys to write.
 */
async function seedStorage(page: Page, entries: Record<string, string>): Promise<void> {
  await page.addInitScript((seed) => {
    for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value);
  }, entries);
}

/**
 * Record every change to the preference attributes, from before the first script runs.
 *
 * A flash is exactly this: the document parsed with one value and repainted with another.
 * Watching the attributes from `document-start` is what makes "no flash" a measurement
 * rather than a screenshot judgement.
 *
 * @param page The page under test.
 */
async function watchForFlash(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const watched = ['data-font-scale', 'data-density', 'data-motion', 'data-rail', 'data-theme'];
    const log: Array<{ attribute: string; value: string | null }> = [];
    (window as unknown as { __hiveFlashLog: typeof log }).__hiveFlashLog = log;

    // `document` rather than `document.documentElement`: an init script runs before the
    // `<html>` element is parsed, so there is nothing else to attach to yet.
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target !== document.documentElement) continue;
        const attribute = record.attributeName ?? '';
        log.push({
          attribute,
          value: document.documentElement.getAttribute(attribute),
        });
      }
    }).observe(document, {
      attributes: true,
      subtree: true,
      attributeFilter: watched,
    });
  });
}

/**
 * Open a page in a context of its own, with storage seeded before anything runs.
 *
 * The shared page has already visited the app, and the provider persists the canonical
 * keys on mount — so a test about what a *first* visit does has to start from a context
 * nothing has written to yet.
 *
 * @param browser The browser under test.
 * @param seed Storage to write before the first navigation.
 * @param options Extra context options, e.g. an emulated OS preference.
 * @returns The context (the caller closes it) and its page, already on `/login`.
 */
async function freshVisit(
  browser: Browser,
  seed: Record<string, string>,
  options: Parameters<Browser['newContext']>[0] = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  if (Object.keys(seed).length > 0) await seedStorage(page, seed);
  return { context, page };
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

/**
 * Apply a preference the way the provider does, without a reload.
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
 * Measure a `rem`-sized probe, and the page's own body copy, at the current scale.
 *
 * The probe answers "does *everything* scale", which is what makes the font scale a
 * shell-wide setting rather than a body-copy one; the body reading proves the real page
 * follows it too.
 *
 * @param page The page under test.
 * @returns The probe's width and the computed body font size, both in CSS pixels.
 */
async function measureScale(page: Page): Promise<{ probe: number; body: number }> {
  return page.evaluate(() => {
    let probe = document.getElementById('hive-scale-probe');
    if (!probe) {
      probe = document.createElement('div');
      probe.id = 'hive-scale-probe';
      probe.style.cssText = 'position:absolute;top:-9999px;width:10rem;height:1rem';
      document.body.appendChild(probe);
    }
    return {
      probe: probe.getBoundingClientRect().width,
      body: parseFloat(getComputedStyle(document.body).fontSize),
    };
  });
}

test.describe('Device preferences', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
  });

  test('the font scale rescales the whole interface, not just body copy', async ({ page }) => {
    await applyPreference(page, 'data-font-scale', 'md');
    const medium = await measureScale(page);
    expect(medium.probe).toBeCloseTo(160, 0); // 10rem at a 16px root

    await applyPreference(page, 'data-font-scale', 'xs');
    const small = await measureScale(page);
    expect(small.probe).toBeCloseTo(140, 0); // 14px root
    expect(small.body).toBeLessThan(medium.body);

    await applyPreference(page, 'data-font-scale', '2xl');
    const largest = await measureScale(page);
    expect(largest.probe).toBeCloseTo(200, 0); // 20px root
    expect(largest.body).toBeGreaterThan(medium.body);
  });

  test('an unset attribute renders at the default scale', async ({ page }) => {
    await applyPreference(page, 'data-font-scale', null);

    expect((await measureScale(page)).probe).toBeCloseTo(160, 0);
  });

  test('compact density tightens rows and padding without reflowing content off-screen', async ({
    page,
  }) => {
    await applyPreference(page, 'data-density', null);
    expect(await tokenValue(page, '--row-h')).toBe('46px');
    expect(await tokenValue(page, '--page-pad')).toBe('32px');
    expect(await tokenValue(page, '--control-h')).toBe('36px');

    await applyPreference(page, 'data-density', 'compact');
    expect(await tokenValue(page, '--row-h')).toBe('38px');
    expect(await tokenValue(page, '--page-pad')).toBe('24px');
    expect(await tokenValue(page, '--control-h')).toBe('32px');

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test('reduce motion stops transitions', async ({ page }) => {
    const transitionDuration = () =>
      page.evaluate(() => {
        let probe = document.getElementById('hive-motion-probe');
        if (!probe) {
          probe = document.createElement('div');
          probe.id = 'hive-motion-probe';
          probe.style.cssText = 'position:absolute;top:-9999px;transition:opacity 500ms linear';
          document.body.appendChild(probe);
        }
        return getComputedStyle(probe).transitionDuration;
      });

    await applyPreference(page, 'data-motion', 'auto');
    expect(await transitionDuration()).toBe('0.5s');

    await applyPreference(page, 'data-motion', 'reduce');
    expect(await transitionDuration()).toBe('0s');
  });

  test('the operating-system setting is honoured on its own', async ({ browser }) => {
    // No preference stored: `auto` is the default, and `auto` means "follow the system".
    const { context, page } = await freshVisit(browser, {}, { reducedMotion: 'reduce' });

    try {
      await page.goto('/login');
      await page.waitForLoadState('networkidle');

      const duration = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;top:-9999px;transition:opacity 500ms linear';
        document.body.appendChild(probe);
        return getComputedStyle(probe).transitionDuration;
      });

      expect(duration).toBe('0s');
    } finally {
      await context.close();
    }
  });

  test('the rail width follows the collapse preference', async ({ page }) => {
    await applyPreference(page, 'data-rail', null);
    expect(await tokenValue(page, '--rail-w-current')).toBe('264px');

    await applyPreference(page, 'data-rail', 'collapsed');
    expect(await tokenValue(page, '--rail-w-current')).toBe('64px');
  });

  test('a hard reload paints the stored preferences with no flash', async ({ browser }) => {
    const { context, page } = await freshVisit(browser, {
      ...STORED,
      'hive.theme': 'nord',
    });
    await watchForFlash(page);
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    try {
      // The values arrived with the document...
      const expected: Record<string, string> = {
        'data-font-scale': '2xl',
        'data-density': 'compact',
        'data-motion': 'reduce',
        'data-rail': 'collapsed',
        'data-theme': 'nord',
      };
      const applied = await page.evaluate(
        (attributes) =>
          Object.fromEntries(
            attributes.map((attribute) => [
              attribute,
              document.documentElement.getAttribute(attribute),
            ]),
          ),
        Object.keys(expected),
      );
      expect(applied).toEqual(expected);

      // ...and nothing ever held a different one, which is what a flash would look like.
      const changes = await page.evaluate(
        () =>
          (
            window as unknown as {
              __hiveFlashLog: Array<{
                attribute: string;
                value: string | null;
              }>;
            }
          ).__hiveFlashLog,
      );
      expect(changes.filter((change) => change.value !== expected[change.attribute])).toEqual([]);
      // Every write came from the boot script or the provider agreeing with it, not from a
      // document that started out unstyled.
      expect(changes.length).toBeGreaterThan(0);
      expect((await measureScale(page)).probe).toBeCloseTo(200, 0);
    } finally {
      await context.close();
    }
  });

  test('a legacy sidebar density is migrated to the new key', async ({ browser }) => {
    const { context, page } = await freshVisit(browser, {
      'apiome.sidebar.density': 'compact',
    });

    try {
      await page.goto('/login');
      await page.waitForLoadState('networkidle');

      // The boot script reads through to the legacy key before first paint...
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-density'))).toBe(
        'compact',
      );
      // ...and the provider rewrites it under the canonical name once it mounts.
      await expect
        .poll(() => page.evaluate(() => window.localStorage.getItem('hive.density')))
        .toBe('compact');
    } finally {
      await context.close();
    }
  });
});
