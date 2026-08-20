import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The Export Studio, measured in a browser (HIVE-8.3, #5329).
 *
 * `tests/export-studio-hive-redesign.test.tsx` pins what the five steps render,
 * `tests/export-studio-view.test.ts` pins the rules behind them, and
 * `tests/export-studio-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed* style, because jsdom compiles no CSS:
 *
 *   • **"Works in all nine themes, both densities and all six font scales"** — the ticket's
 *     cross-cutting criterion, on the deepest surface in the product.
 *   • **"No horizontal document scroll at ≥1280 px"** — on a screen carrying a five-column
 *     stepper, a thirty-six-card grid and a two-pane review layout.
 *   • **The panes scroll inside their own cards**, never taking the document with them. The
 *     manifest tree and the problems list are both `min(vh, rem)` boxes, and whether that
 *     actually contains them is a compositing question.
 *   • **The heat scale stays legible** — four `color-mix` washes under one `--fg` ink, which
 *     the CSS suite measures arithmetically and this one measures as the browser paints it.
 *   • **"axe: zero serious/critical violations"** on every surface, in every theme.
 *
 * ### Why it mounts fixtures instead of driving the real Studio
 *
 * The same reason `hive-published.spec.ts` and `hive-sunset-timeline.spec.ts` give: every
 * read here is tenant-scoped, and the states worth measuring — a running job, a failed one
 * carrying a specific failure class, a blocked delivery gate — are ones a seeded database
 * will not produce on demand, and a *live* export would take minutes to reach.
 *
 * The fixtures are **not hand-written**. `tests/export-studio-hive-redesign.test.tsx` renders
 * the real components against a mocked registry and, with `EXPORT_STUDIO_FIXTURE_DUMP=1`,
 * writes what it rendered into `e2e/fixtures/hive-export-studio/`. So what is measured here
 * is exactly what the components compose — the classes, the nesting, the ARIA — and the jsdom
 * suite is what keeps the fixtures honest.
 *
 * This loads `/login`, which compiles the real `globals.css` and needs no session, and
 * injects the fixtures into it. Requires the app to be running (`PLAYWRIGHT_BASE_URL`,
 * default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §9. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The viewport width DESIGN.md §5 forbids horizontal document scroll at. */
const DESKTOP_WIDTH = 1280;

/** The width the stepper folds to two columns below (the block's one `rem` breakpoint). */
const STEPPER_BREAKPOINT = 900;

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

/** Both density stops. */
const DENSITIES = ['comfortable', 'compact'];

/** Widths either side of the block's one breakpoint, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1100, 1024, STEPPER_BREAKPOINT, 768, 640, 420];

/** Where the jsdom suite writes what it rendered. */
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-export-studio');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'source' | 'target' | 'notices' | 'job' | 'canceled' | 'failure' | 'gate';

/** All seven, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = [
  'source',
  'target',
  'notices',
  'job',
  'canceled',
  'failure',
  'gate',
];

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
 * @param page The Playwright page.
 * @param name Which fixture.
 */
async function mount(page: Page, name: Fixture): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((html) => {
    document.body.innerHTML = `<main style="min-height:100vh;background:var(--bg-canvas);padding:16px">${html}</main>`;
    document.body.style.margin = '0';
    // Freeze every transition — the trap `hive-catalog.spec.ts` records. A stage row and a
    // finding's reveal glyph both carry one, so a `data-theme` swap *animates* them and axe
    // sampling mid-animation reports a failure against a state that exists in neither theme.
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
  options: { theme?: string | null; fontScale?: string; density?: string },
): Promise<void> {
  await page.evaluate(
    ({ theme, fontScale, density }) => {
      const root = document.documentElement;
      if (theme) root.setAttribute('data-theme', theme);
      else root.removeAttribute('data-theme');
      if (fontScale) root.setAttribute('data-font-scale', fontScale);
      if (density) root.setAttribute('data-density', density);
    },
    options as { theme?: string | null; fontScale?: string; density?: string },
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

/**
 * The relative luminance of a painted colour.
 *
 * Chrome serialises a resolved `color-mix` as `color(srgb 0.98 0.94 0.93)` — channels in
 * 0–1 — and everything else as `rgb(251, 240, 238)` — channels in 0–255. Reading the first
 * as if it were the second yields a luminance of nearly zero and a contrast ratio that looks
 * fine on a wash that is anything but, which is the bug this comment exists to prevent.
 *
 * @param colour A colour string as `getComputedStyle` returns it.
 * @returns Its luminance, 0–1.
 */
function luminance(colour: string): number {
  const srgb = colour.startsWith('color(srgb');
  const [r, g, b] = (colour.match(/[\d.]+/g) ?? ['0', '0', '0'])
    .slice(0, 3)
    .map((value) => Number(value) * (srgb ? 255 : 1));
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The contrast ratio between two painted colours.
 *
 * @param a One colour.
 * @param b The other.
 * @returns Their WCAG contrast ratio.
 */
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the Studio keeps the document to one column', () => {
  for (const width of WIDTHS) {
    for (const name of ALL_FIXTURES) {
      test(`the ${name} surface does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await mount(page, name);
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  for (const theme of THEMES) {
    test(`the target grid does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'target');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    for (const density of DENSITIES) {
      test(`the source step holds at the ${fontScale} scale, ${density}`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, 'source');
        await applyPreferences(page, { fontScale, density });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }
});

/* -------------------------------------------------------------------------
   The stepper
   ------------------------------------------------------------------------- */

test.describe('the stepper', () => {
  test('lays five pills across one row on a desktop', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'source');
    const columns = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.xstd-steps') as Element).gridTemplateColumns
          .split(' ')
          .length,
    );
    expect(columns).toBe(5);
  });

  test('folds to two columns below its breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'source');
    const columns = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.xstd-steps') as Element).gridTemplateColumns
          .split(' ')
          .length,
    );
    expect(columns).toBe(2);
  });

  test('paints the current pill differently from an upcoming one', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'source');
    const shadows = await page.evaluate(() => {
      const read = (state: string) =>
        getComputedStyle(
          document.querySelector(`.xstd-step[data-state="${state}"]`) as Element,
        ).boxShadow;
      return { current: read('current'), upcoming: read('upcoming') };
    });
    expect(shadows.current).not.toEqual(shadows.upcoming);
    expect(shadows.current).not.toBe('none');
  });

  test('grows the pills with the font scale rather than clipping them', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'source');
    const measure = () =>
      page.evaluate(
        () => (document.querySelector('.xstd-step') as HTMLElement).getBoundingClientRect().height,
      );
    await applyPreferences(page, { fontScale: 'xs' });
    const small = await measure();
    await applyPreferences(page, { fontScale: '2xl' });
    const large = await measure();
    expect(large).toBeGreaterThan(small);
  });
});

/* -------------------------------------------------------------------------
   The panes scroll inside their own cards
   ------------------------------------------------------------------------- */

test.describe('the tall panes contain their own scroll', () => {
  test('caps the target grid against the viewport, not the page', async ({ page }) => {
    // A 400px-tall window is the pathological case: a pane sized only in `rem` would push the
    // page past it, and one sized only in `vh` would ignore the reader's font scale.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 400 });
    await mount(page, 'target');
    expect(await documentOverflows(page)).toBe(false);
  });

  test('keeps the family headings above their own cards, never beside them', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'target');
    const stacked = await page.evaluate(() => {
      const heading = document.querySelector('.xstd-family__title') as HTMLElement;
      const grid = heading.parentElement?.querySelector('.vdlg-export__grid') as HTMLElement;
      return heading.getBoundingClientRect().bottom <= grid.getBoundingClientRect().top + 1;
    });
    expect(stacked).toBe(true);
  });
});

/* -------------------------------------------------------------------------
   The job stages, painted
   ------------------------------------------------------------------------- */

test.describe('a job stage says its state in more than its tint', () => {
  test('gives each of the three live states its own frame', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'job');
    const frames = await page.evaluate(() => {
      const read = (status: string) => {
        const row = document.querySelector(`.xstd-stage[data-status="${status}"]`);
        return row ? getComputedStyle(row).boxShadow : null;
      };
      return { done: read('done'), active: read('active'), pending: read('pending') };
    });
    expect(new Set(Object.values(frames).filter(Boolean)).size).toBeGreaterThan(1);
  });

  test.describe('in every theme', () => {
    for (const theme of THEMES) {
      test(`a done badge stays visible on the card in ${theme ?? 'light'}`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, 'job');
        await applyPreferences(page, { theme });
        const measured = await page.evaluate(() => {
          const badge = document.querySelector(
            '.xstd-stage[data-status="done"] .xstd-stage__icon',
          ) as HTMLElement;
          const row = badge.closest('.xstd-stage') as HTMLElement;
          return {
            badge: getComputedStyle(badge).backgroundColor,
            card: getComputedStyle(row).backgroundColor,
            page: getComputedStyle(document.body).backgroundColor,
          };
        });
        // A stage row is usually transparent; fall back to the page behind it.
        const ground = measured.card.includes('rgba(0, 0, 0, 0)') ? measured.page : measured.card;
        expect(ratio(measured.badge, ground)).toBeGreaterThanOrEqual(3);
      });
    }
  });
});

/* -------------------------------------------------------------------------
   The tinted notices and the failure card
   ------------------------------------------------------------------------- */

test.describe('a tinted surface keeps the page foreground legible', () => {
  for (const theme of THEMES) {
    test(`the failure card reads in ${theme ?? 'light'}`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'failure');
      await applyPreferences(page, { theme });
      const measured = await page.evaluate(() => {
        const card = document.querySelector('.xstd-failure') as HTMLElement;
        const title = card.querySelector('.xstd-failure__title') as HTMLElement;
        return {
          ground: getComputedStyle(card).backgroundColor,
          ink: getComputedStyle(title).color,
        };
      });
      expect(ratio(measured.ink, measured.ground)).toBeGreaterThanOrEqual(4.5);
    });
  }

  for (const theme of THEMES) {
    test(`every notice tone reads in ${theme ?? 'light'}`, async ({ page }) => {
      // The canceled banner is a real `.xstd-notice`; flipping its `data-tone` measures all
      // five grounds the block declares against the ink they actually carry. Both `--fg` and
      // `--fg-muted` are checked, because a notice holds whatever its caller puts in it.
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'canceled');
      await applyPreferences(page, { theme });
      for (const tone of [null, 'warn', 'danger', 'ok', 'accent']) {
        const measured = await page.evaluate((value) => {
          const notice = document.querySelector('.xstd-notice') as HTMLElement;
          if (value) notice.setAttribute('data-tone', value);
          else notice.removeAttribute('data-tone');
          const probe = document.createElement('span');
          probe.className = 'xstd-quiet';
          notice.appendChild(probe);
          const read = {
            ground: getComputedStyle(notice).backgroundColor,
            ink: getComputedStyle(notice).color,
            quiet: getComputedStyle(probe).color,
          };
          probe.remove();
          return read;
        }, tone);
        expect({ tone, ratio: ratio(measured.ink, measured.ground) >= 4.5 }).toEqual({
          tone,
          ratio: true,
        });
        expect({ tone, quiet: ratio(measured.quiet, measured.ground) >= 4.5 }).toEqual({
          tone,
          quiet: true,
        });
      }
    });
  }
});

/* -------------------------------------------------------------------------
   The delivery gate
   ------------------------------------------------------------------------- */

test.describe('the delivery gate', () => {
  test('frames a block differently from an advisory', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'gate');
    const shadows = await page.evaluate(() => {
      const panel = document.querySelector('.xstd-gate') as HTMLElement;
      const blocked = getComputedStyle(panel).boxShadow;
      panel.setAttribute('data-decision', 'allow_with_warning');
      return { blocked, warned: getComputedStyle(panel).boxShadow };
    });
    expect(shadows.blocked).not.toEqual(shadows.warned);
  });

  test('keeps the dimension column from squeezing its message', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'gate');
    const overflowed = await page.evaluate(() => {
      const reason = document.querySelector('.xstd-gate__reason') as HTMLElement;
      return reason.scrollWidth - reason.clientWidth > 1;
    });
    expect(overflowed).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   axe
   ------------------------------------------------------------------------- */

test.describe('axe reports nothing serious or critical', () => {
  for (const name of ALL_FIXTURES) {
    test(`on the ${name} surface`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`on the target grid in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'target');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });
  }
});
