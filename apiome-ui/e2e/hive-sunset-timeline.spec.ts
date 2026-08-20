import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The Sunset timeline surface, measured in a browser (HIVE-8.2, #5328).
 *
 * `tests/sunset-timeline-hive-redesign.test.tsx` pins what the screen renders,
 * `tests/sunset-timeline-model.test.ts` pins the geometry behind it, and
 * `tests/sunset-timeline-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"Degrades to the table alone below 900 px"** — the ticket's own acceptance criterion,
 *     and a question about a media query no other suite here can evaluate.
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a screen carrying a 900px-minimum drawing *and*
 *     a seven-column table.
 *   • **The drawing scrolls inside its own card**, never taking the document with it.
 *   • **Every marker is genuinely reachable and genuinely focused** — the focus ring is a
 *     `<circle>` rather than an `outline`, precisely because an `outline` on an SVG group is
 *     not reliably painted, and whether the substitute works is a question about compositing.
 *   • **"axe: zero serious/critical violations"** on all three surfaces, in every theme —
 *     including a `role="button"` group inside an SVG, which is the one shape in this ticket
 *     that an audit tool has an opinion about.
 *
 * ### Why it mounts fixtures instead of signing in
 *
 * The same reason `hive-published.spec.ts` gives: every read here is tenant-scoped, and the
 * states worth measuring — four revisions across three projects with a past, an imminent and
 * two scheduled sunsets, an empty schedule, and a failed read — are ones a seeded database
 * will not produce on demand. The clock matters too: the drawing is a function of *today*,
 * and the fixtures are rendered against a frozen one.
 *
 * The fixtures are **not hand-written**. `tests/sunset-timeline-hive-redesign.test.tsx`
 * renders the real screen against a mocked read and, with `SUNSET_FIXTURE_DUMP=1`, writes
 * what it rendered into `e2e/fixtures/hive-sunset-timeline/`. So what is measured here is
 * exactly what the components compose — the classes, the nesting, the ARIA — and the jsdom
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

/** The width the drawing steps aside below — this ticket's own acceptance criterion. */
const TIMELINE_BREAKPOINT = 900;

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

/** Widths either side of the block's one `rem` breakpoint, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1100, 1024, TIMELINE_BREAKPOINT, 768, 640, 420];

/** Where the jsdom suite writes what it rendered. */
const FIXTURES = path.join(__dirname, 'fixtures', 'hive-sunset-timeline');

/** The surfaces the jsdom suite dumps. */
type Fixture = 'timeline' | 'empty' | 'error';

/** All three, for the sweeps that do not care which. */
const ALL_FIXTURES: Fixture[] = ['timeline', 'empty', 'error'];

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
 * Each fixture is the `.page` column itself, so it needs no wrapper beyond a canvas ground.
 *
 * @param page The Playwright page.
 * @param name Which fixture.
 */
async function mount(page: Page, name: Fixture): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((html) => {
    document.body.innerHTML = `<main style="min-height:100vh;background:var(--bg-canvas)">${html}</main>`;
    document.body.style.margin = '0';
    // Freeze every transition — the trap `hive-catalog.spec.ts` records. A marker's glyph
    // carries a transform transition, so a `data-theme` swap *animates* it, and axe sampling
    // mid-animation reports a failure against a state that exists in neither theme.
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

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the screen keeps the document to one column', () => {
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
    test(`the timeline does not scroll sideways in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'timeline');
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the timeline does not scroll sideways at the ${fontScale} font scale`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'timeline');
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`the timeline does not scroll sideways at ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'timeline');
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------
   The drawing degrades to the table alone below 900px
   ------------------------------------------------------------------------- */

test.describe('below 900px the table is what remains', () => {
  test('draws the timeline above the breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, 'timeline');
    await expect(page.getByTestId('sunset-timeline-card')).toBeVisible();
    await expect(page.getByTestId('sunset-table')).toBeVisible();
  });

  test('takes it away below the breakpoint, and keeps the table', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'timeline');
    await expect(page.getByTestId('sunset-timeline-card')).toBeHidden();
    await expect(page.getByTestId('sunset-table')).toBeVisible();
    // Every fact the drawing carried is still on the page.
    await expect(page.getByTestId('sunset-status-rev-orders-14')).toHaveText(/imminent/);
  });

  test('takes the markers out of the tab order with the pixels', async ({ page }) => {
    // `display: none` rather than a visual hide: a keyboard reader must not tab through
    // markers that are not on screen.
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, 'timeline');
    const reachable = await page
      .locator('.stl-marker')
      .evaluateAll((nodes) =>
        nodes.some((node) => (node as SVGElement).getClientRects().length > 0)
      );
    expect(reachable).toBe(false);
  });

  test('still hides it at exactly the breakpoint, and shows it one pixel above', async ({
    page,
  }) => {
    await mount(page, 'timeline');
    await page.setViewportSize({ width: TIMELINE_BREAKPOINT, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    await expect(page.getByTestId('sunset-timeline-card')).toBeHidden();

    await page.setViewportSize({ width: TIMELINE_BREAKPOINT + 1, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    await expect(page.getByTestId('sunset-timeline-card')).toBeVisible();
  });
});

/* -------------------------------------------------------------------------
   The drawing scrolls inside its own card
   ------------------------------------------------------------------------- */

test.describe('the drawing scrolls inside its own card', () => {
  test('puts an overflow-x scroller between the plot and the page', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, 'timeline');

    const overflow = await page
      .getByTestId('sunset-timeline-plot')
      .evaluate((node) => getComputedStyle(node as Element).overflowX);
    expect(overflow).toBe('auto');
    expect(await documentOverflows(page)).toBe(false);
  });

  test('keeps the plot at its minimum width and scrolls rather than squashing the lanes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, 'timeline');

    const measured = await page.getByTestId('sunset-timeline-plot').evaluate((node) => {
      const host = node as HTMLElement;
      return { scrollWidth: host.scrollWidth, clientWidth: host.clientWidth };
    });
    expect(measured.scrollWidth).toBeGreaterThanOrEqual(measured.clientWidth);
  });

  test('the seven-column table scrolls inside its own card too', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, 'timeline');

    const scrolls = await page
      .locator('[data-testid="sunset-table"] div')
      .evaluateAll((nodes) =>
        nodes.some((node) => getComputedStyle(node as Element).overflowX === 'auto')
      );
    expect(scrolls).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('a very long project name cannot hold the table open', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, 'timeline');

    await page.locator('.stl-project__name').first().evaluate((node) => {
      node.textContent = 'AnExtremelyLongProjectNameThatNobodyWouldEverTypeButSomebodyEventuallyWill';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await documentOverflows(page)).toBe(false);
  });

  test('a very long successor id breaks rather than widening the document', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, 'timeline');

    await page.locator('.stl-successor').first().evaluate((node) => {
      node.textContent = 'ver_00000000000000000000000000000000000000000000000000000000000000';
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The markers
   ------------------------------------------------------------------------- */

test.describe('every marker is a control', () => {
  test('is reachable by keyboard, in the order the lanes are drawn', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');

    const first = page.locator('.stl-marker').first();
    await first.focus();
    await expect(first).toBeFocused();

    await page.keyboard.press('Tab');
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? null
    );
    expect(focused).toMatch(/^sunset-marker-/);
  });

  test('shows a focus ring — the circle that stands in for an outline an SVG group cannot draw', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');

    const marker = page.locator('.stl-marker').first();
    const ring = marker.locator('.stl-marker__ring');
    expect(await ring.evaluate((node) => getComputedStyle(node as Element).opacity)).toBe('0');

    // A programmatic `focus()` does not always satisfy `:focus-visible`; a keyboard one does.
    await page.locator('body').click();
    await page.keyboard.press('Tab');
    await page.evaluate(() => {
      const first = document.querySelector('.stl-marker') as SVGElement | null;
      first?.focus();
    });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    const anyRingShown = await page
      .locator('.stl-marker__ring')
      .evaluateAll((nodes) =>
        nodes.some((node) => getComputedStyle(node as Element).opacity === '1')
      );
    expect(anyRingShown).toBe(true);
  });

  test('carries a hit target larger than the diamond it draws', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');

    const sizes = await page.locator('.stl-marker').first().evaluate((node) => {
      const hit = (node as SVGElement).querySelector('.stl-marker__hit') as SVGGraphicsElement;
      const glyph = (node as SVGElement).querySelector('.stl-marker__glyph') as SVGGraphicsElement;
      return { hit: hit.getBoundingClientRect().width, glyph: glyph.getBoundingClientRect().width };
    });
    expect(sizes.hit).toBeGreaterThan(sizes.glyph);
  });

  test('draws every diamond with a contour, so its shape survives every theme', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');

    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      const stroked = await page
        .locator('.stl-marker__glyph')
        .evaluateAll((nodes) =>
          nodes.every((node) => {
            const style = getComputedStyle(node as Element);
            return style.stroke !== 'none' && Number(style.strokeWidth.replace('px', '')) > 0;
          })
        );
      expect({ theme: theme ?? 'light', stroked }).toEqual({ theme: theme ?? 'light', stroked: true });
    }
  });
});

/* -------------------------------------------------------------------------
   The pointed-at row
   ------------------------------------------------------------------------- */

test.describe('the row a marker points at', () => {
  test('is tinted and ruled, never tinted alone', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');

    const painted = await page.evaluate(() => {
      const row = document.querySelector('tbody tr') as HTMLTableRowElement;
      row.classList.add('stl-row--current');
      const cell = row.querySelector('td') as HTMLElement;
      const style = getComputedStyle(cell);
      return { background: style.backgroundColor, shadow: style.boxShadow };
    });
    expect(painted.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(painted.shadow).not.toBe('none');
  });
});

/* -------------------------------------------------------------------------
   The cells
   ------------------------------------------------------------------------- */

test.describe('the cells', () => {
  test('top-aligns the multi-line rows rather than centring them', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');

    const aligned = await page
      .locator('[data-testid="sunset-table"] tbody td')
      .first()
      .evaluate((node) => getComputedStyle(node as Element).verticalAlign);
    expect(aligned).toBe('top');
  });

  test('keeps the whole stored instant on one line', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');

    const wrapped = await page
      .locator('.stl-instant')
      .first()
      .evaluate((node) => {
        const element = node as HTMLElement;
        return element.getClientRects().length;
      });
    expect(wrapped).toBe(1);
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  for (const name of ALL_FIXTURES) {
    test(`the ${name} surface has no serious or critical axe violations`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, name);
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`the timeline has no serious or critical axe violations in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, 'timeline');
      await applyPreferences(page, { theme });
      expect(await blockingViolations(page)).toEqual([]);
    });
  }

  test('names every column of the schedule', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');

    const named = await page
      .locator('[data-testid="sunset-table"] thead th')
      .evaluateAll((nodes) => nodes.every((node) => (node.textContent ?? '').trim().length > 0));
    expect(named).toBe(true);
  });

  test('names every marker with its instant, so the drawing is readable without seeing it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, 'timeline');

    const labels = await page
      .locator('.stl-marker')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? ''));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label).toMatch(/sunset \d{2} \w{3} \d{4} \d{2}:\d{2} UTC/);
    }
  });
});
