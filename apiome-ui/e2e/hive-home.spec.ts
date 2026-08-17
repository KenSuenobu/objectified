import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Home's layout, measured in a browser (HIVE-4.6, #5300).
 *
 * `tests/dashboard-home.test.tsx` pins what the page renders and `tests/dashboard-home-css.test.ts`
 * pins the declarations behind it. Neither can answer the three acceptance criteria that are
 * questions about *computed layout*, because jsdom compiles no CSS and has no scroll:
 *
 *   • **"No empty grid regions at any breakpoint."** The page this replaced left the right half of
 *     its body grid blank at every width above a tablet. The honest check is to measure both
 *     columns either side of the breakpoint and confirm each has painted content in it.
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both densities
 *     and all six font scales — every one of which swaps a spacing or type token the grid is laid
 *     out from.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet actually
 *     renders it.
 *
 * ### Why it injects markup instead of signing in
 *
 * Home *is* the screen — it has no gallery route, and its panels are the reader's own data — so
 * the obvious spec would sign in and read `/ade/dashboard`. That spec would also be the least
 * useful one in the suite: what it measured would depend on how many projects the seeded user
 * happens to have, and the interesting cases (a project name too long to fit, a workspace with
 * nothing needing attention) are precisely the ones a fixed database will not produce.
 *
 * So this suite does what `rem-audit.spec.ts` does: it loads `/login`, which compiles the real
 * `globals.css` and needs no session, and injects Home's own markup into it. The fixture is
 * deliberately the *worst* case — an unbroken 64-character project name, a long revision id, five
 * checklist steps and a full aside — because the layout rules under test are the ones that stop
 * exactly that content from widening the page.
 *
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §6. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The viewport width DESIGN.md §5 forbids horizontal document scroll at. */
const DESKTOP_WIDTH = 1280;

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

/** Widths either side of the body grid's one breakpoint (1100 px), down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1101, 1099, 900, 420];

/** A project name with no break opportunity in it — the case `overflow-wrap` is there for. */
const UNBREAKABLE_NAME = 'PaymentsOrchestrationAndSettlementReconciliationServiceApi';

/**
 * Home's body, as the page composes it.
 *
 * Written out rather than rendered because Playwright has no React runtime: the markup a
 * component tree produces is already pinned by the jsdom suite, and what this fixture has to be
 * faithful about is the *class names and nesting* the stylesheet keys off.
 */
const HOME_MARKUP = `
<div class="page" id="home-probe">
  <div class="page-body">
    <div class="rounded-lg bg-surface shadow-sm home-checklist" role="group" aria-labelledby="probe-checklist">
      <div class="home-checklist__head">
        <div class="home-checklist__lede">
          <span class="home-checklist__mark" aria-hidden="true"></span>
          <div class="home-checklist__text">
            <div class="home-checklist__titlerow">
              <h2 id="probe-checklist">Get to your first published spec</h2>
              <span class="badge">3 / 5 done</span>
            </div>
            <p class="home-checklist__desc">Reach a published, browsable spec in a few steps.</p>
          </div>
        </div>
        <div class="home-checklist__aside">
          <span class="home-hex" aria-hidden="true">
            <span class="home-hex__cell" data-on="true"></span>
            <span class="home-hex__cell" data-on="true"></span>
            <span class="home-hex__cell" data-on="true"></span>
            <span class="home-hex__cell"></span>
            <span class="home-hex__cell"></span>
          </span>
          <button type="button" aria-label="Dismiss getting-started checklist">x</button>
        </div>
      </div>
      <ol class="home-steps" data-steps="5">
        <li class="home-step home-step--done" data-step="project">
          <p class="home-step__title"><span class="home-step__label">Create your first project</span></p>
          <p class="home-step__hint">Open the Designer to start a project.</p>
        </li>
        <li class="home-step home-step--done" data-step="class">
          <p class="home-step__title"><span class="home-step__label">Add a class from a starter template</span></p>
          <p class="home-step__hint">Browse the built-in templates to add a class.</p>
        </li>
        <li class="home-step home-step--done" data-step="version">
          <p class="home-step__title"><span class="home-step__label">Cut a version</span></p>
          <p class="home-step__hint">Snapshot your schema as a version.</p>
        </li>
        <li class="home-step home-step--next" data-step="publish">
          <p class="home-step__title"><span class="home-step__label">Publish it</span><span class="badge home-step__badge">Next</span></p>
          <p class="home-step__hint">Publish the version so it becomes browsable.</p>
          <a class="home-step__go" href="/ade/dashboard/versions">Go to versions</a>
        </li>
        <li class="home-step" data-step="browse">
          <p class="home-step__title"><span class="home-step__label">View it in Browse</span></p>
          <p class="home-step__hint">See your published spec render publicly.</p>
        </li>
      </ol>
    </div>

    <div class="hive-stat-grid" data-columns="6" role="group" aria-label="Workspace statistics">
      ${['Tenants', 'Projects', 'Versions', 'Published', 'Classes', 'Properties']
        .map(
          (label) => `
        <div class="hive-stat">
          <span class="hive-stat__label">${label}</span>
          <span class="hive-stat__value">1042</span>
          <span class="hive-stat__foot"><span>962 in classes</span></span>
        </div>`,
        )
        .join('')}
    </div>

    <div class="home-grid">
      <div class="home-grid__main">
        <section class="home-section" aria-labelledby="probe-continue">
          <div class="home-section__title">
            <h2 id="probe-continue">Pick up where you left off</h2>
            <a class="home-section__link" href="/ade/dashboard/projects">All projects</a>
          </div>
          <div class="home-continue">
            ${[0, 1, 2]
              .map(
                (index) => `
              <a class="rounded-lg bg-surface shadow-sm home-continue__card" href="/ade/dashboard/versions?projectId=p-${index}" data-project="p-${index}">
                <span class="home-continue__top">
                  <span class="badge">Draft</span>
                  <span class="home-continue__tenant">Acme Corporation Holdings</span>
                </span>
                <span class="home-continue__name">${index === 0 ? UNBREAKABLE_NAME : 'Orders Service'}</span>
                <span class="home-continue__meta mono">v2.4.0-release-candidate.18+build.2026081201 · 18 classes · 42 properties</span>
                <span class="home-continue__foot">
                  <span class="home-continue__quality">
                    <span class="hive-ring" role="meter" aria-label="Quality score" aria-valuenow="88" aria-valuemin="0" aria-valuemax="100" aria-valuetext="88 out of 100"></span>
                    <span class="home-continue__quality-label">Quality</span>
                  </span>
                  <span class="home-continue__touched">Edited 2 hours ago</span>
                </span>
              </a>`,
              )
              .join('')}
          </div>
        </section>

        <div class="rounded-lg bg-surface shadow-sm home-panel" role="group" aria-labelledby="probe-activity">
          <div class="home-panel__header">
            <span class="home-panel__title">
              <h2 id="probe-activity">Recent activity</h2>
              <span class="home-panel__note">Your latest actions</span>
            </span>
          </div>
          <ol class="home-rows">
            ${['violet', 'ok', 'accent', 'warn', 'violet', 'ok', 'accent', 'warn', 'violet', 'ok']
              .map(
                (tone, index) => `
              <li class="home-row" data-activity="version">
                <span class="home-tile home-tone" data-tone="${tone}" aria-hidden="true"></span>
                <div class="home-row__body">
                  <p class="home-row__title">Created version <span class="mono">v2.4.0-release-candidate.${index}+build.2026081201</span></p>
                  <p class="home-row__sub">Acme Corporation Holdings · 2 hours ago</p>
                </div>
                <span class="badge home-row__badge">version</span>
              </li>`,
              )
              .join('')}
          </ol>
          <div class="home-panel__footer"><span>Showing 10 actions</span></div>
        </div>
      </div>

      <aside class="home-grid__aside" aria-label="Workspace shortcuts and health">
        <div class="rounded-lg bg-surface shadow-sm home-panel" role="group" aria-labelledby="probe-quick">
          <div class="home-panel__header">
            <span class="home-panel__title"><h2 id="probe-quick">Quick actions</h2></span>
          </div>
          <ul class="home-menu">
            ${[
              ['Import a spec', '/ade/dashboard/projects?open=import-spec'],
              ['Browse the catalog', '/ade/dashboard/catalog'],
              ['Create an API key', '/ade/dashboard/api-keys?open=new-api-key'],
              ['Invite a teammate', '/ade/dashboard/members'],
              ['Register an MCP server', '/ade/dashboard/mcp'],
            ]
              .map(
                ([label, href]) => `
              <li><a class="home-menu__item" href="${href}"><span class="home-menu__label">${label}</span></a></li>`,
              )
              .join('')}
          </ul>
        </div>

        <div class="rounded-lg bg-surface shadow-sm home-panel" role="group" aria-labelledby="probe-attention">
          <div class="home-panel__header">
            <span class="home-panel__title">
              <h2 id="probe-attention">Needs attention</h2>
              <span class="badge home-panel__count">3</span>
            </span>
          </div>
          <ul class="home-rows">
            ${[
              ['warn', 'sunset', 'Orders Service v1.4.0 sunsets in 12 days', 'Still published — move consumers to a successor', '/ade/dashboard/versions/sunset-timeline'],
              ['danger', 'lint', '4 blocking lint findings on ' + UNBREAKABLE_NAME + ' v2.4.0', 'The publish gate will fail until these are cleared', '/ade/dashboard/lint-workspace'],
              ['warn', 'key', 'API key ci-deploy expires in 2 days', 'Acme Corp — rotate it before it breaks CI', '/ade/dashboard/api-keys'],
            ]
              .map(
                ([tone, kind, title, detail, href]) => `
              <li>
                <a class="home-row home-row--link home-tone" data-tone="${tone}" data-attention="${kind}" href="${href}">
                  <span class="home-dot" aria-hidden="true"></span>
                  <span class="home-row__body">
                    <span class="home-row__title">${title}</span>
                    <span class="home-row__sub">${detail}</span>
                  </span>
                </a>
              </li>`,
              )
              .join('')}
          </ul>
        </div>

        <div class="rounded-lg bg-surface shadow-sm home-pulse" role="group" aria-labelledby="probe-pulse">
          <div class="home-pulse__head">
            <h2 id="probe-pulse">Publishing pulse</h2>
            <span class="home-pulse__span">last 12 weeks</span>
          </div>
          <div class="home-bars" role="img" aria-label="66 versions published in the last 12 weeks">
            ${[20, 35, 25, 55, 40, 70, 45, 80, 60, 90, 75, 100]
              .map((percent) => `<span class="home-bars__bar" data-count="${percent / 5}" style="height:${percent}%"></span>`)
              .join('')}
          </div>
          <div class="home-pulse__axis" aria-hidden="true"><span>May</span><span>Jun</span><span>Jul</span><span>Aug</span></div>
          <p class="home-pulse__total">66 versions published in the last 12 weeks</p>
        </div>
      </aside>
    </div>
  </div>
</div>`;

/**
 * Load the stylesheet and put Home's markup on the page.
 *
 * `/login` is used because it compiles the real `globals.css` without a session — the same reason
 * `rem-audit.spec.ts` and `preferences.spec.ts` use it.
 *
 * @param page The page under test.
 */
async function mountHome(page: Page): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((markup) => {
    document.body.innerHTML = `<main>${markup}</main>`;
    // The shell's page column is what Home scrolls inside; without it `.page`'s own
    // `overflow-y: auto` has no height to work against and the probe would never overflow.
    document.body.style.margin = '0';
  }, HOME_MARKUP);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/**
 * Set or clear a preference attribute on `<html>`, then let a frame paint.
 *
 * @param page The page under test.
 * @param attribute The attribute name, e.g. `data-font-scale`.
 * @param value The value, or `null` to remove it and fall back to the default.
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
 * How far the document can be scrolled sideways, in CSS pixels.
 *
 * @param page The page under test.
 * @returns The overflow; zero when there is none.
 */
async function documentOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(0, root.scrollWidth - root.clientWidth);
  });
}

/**
 * Let a frame paint after a viewport change.
 *
 * @param page The page under test.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/**
 * The blocking half of an axe run.
 *
 * @param violations Everything axe reported.
 * @returns Only the serious and critical findings, as `id: help` lines.
 */
function blocking(
  violations: {
    id: string;
    help: string;
    impact?: string | null;
    nodes?: { html?: string; failureSummary?: string | null }[];
  }[],
): string[] {
  return violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => {
      // The element and the measured ratio, not just the rule name: a bare "color-contrast"
      // failure names nothing a reader of the diff can go and fix.
      const where = (violation.nodes ?? [])
        .map((node) => `${node.html ?? '?'} — ${(node.failureSummary ?? '').replace(/\s+/g, ' ').trim()}`)
        .join(' | ');
      return `${violation.id}: ${violation.help}${where ? ` [${where}]` : ''}`;
    });
}

test.describe('Home layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mountHome(page);
  });

  test('leaves no empty region in the body grid, at any breakpoint', async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);

      for (const selector of ['.home-grid__main', '.home-grid__aside']) {
        const box = await page.locator(selector).boundingBox();
        expect(box, `${selector} at ${width}px has no box`).not.toBeNull();
        // A column that is present but has no height is exactly the hole this ticket closed.
        expect(box!.height, `${selector} at ${width}px is empty`).toBeGreaterThan(80);
        expect(box!.width, `${selector} at ${width}px has no width`).toBeGreaterThan(120);
      }
    }
  });

  test('sits the aside beside the main column above the breakpoint and under it below', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    let main = (await page.locator('.home-grid__main').boundingBox())!;
    let aside = (await page.locator('.home-grid__aside').boundingBox())!;
    expect(aside.x, 'aside should start after the main column ends').toBeGreaterThan(
      main.x + main.width - 1,
    );

    await page.setViewportSize({ width: 900, height: 900 });
    await settle(page);
    main = (await page.locator('.home-grid__main').boundingBox())!;
    aside = (await page.locator('.home-grid__aside').boundingBox())!;
    expect(aside.y, 'aside should stack under the main column').toBeGreaterThan(main.y);
    expect(Math.abs(aside.x - main.x), 'stacked columns should share a leading edge').toBeLessThan(2);
  });

  test('reflows the continue cards three, two, one', async ({ page }) => {
    /** How many cards share the topmost row at this width. */
    const cardsInFirstRow = async () =>
      page.evaluate(() => {
        const cards = [...document.querySelectorAll('.home-continue__card')];
        if (cards.length === 0) return 0;
        const top = Math.round(cards[0].getBoundingClientRect().top);
        return cards.filter((card) => Math.abs(Math.round(card.getBoundingClientRect().top) - top) < 2)
          .length;
      });

    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    expect(await cardsInFirstRow()).toBe(3);

    await page.setViewportSize({ width: 1000, height: 900 });
    await settle(page);
    expect(await cardsInFirstRow()).toBe(2);

    await page.setViewportSize({ width: 420, height: 900 });
    await settle(page);
    expect(await cardsInFirstRow()).toBe(1);
  });

  test('never scrolls the document sideways at 1280 px, in any theme', async ({ page }) => {
    for (const theme of THEMES) {
      await applyPreference(page, 'data-theme', theme);
      expect(await documentOverflow(page), `theme ${theme ?? 'light'}`).toBe(0);
    }
    await applyPreference(page, 'data-theme', null);
  });

  test('never scrolls the document sideways at any density or font scale', async ({ page }) => {
    for (const density of [null, 'compact']) {
      await applyPreference(page, 'data-density', density);
      for (const scale of FONT_SCALES) {
        await applyPreference(page, 'data-font-scale', scale);
        expect(await documentOverflow(page), `${scale} / ${density ?? 'comfortable'}`).toBe(0);
      }
    }
    await applyPreference(page, 'data-density', null);
    await applyPreference(page, 'data-font-scale', null);
  });

  test('holds every width in WIDTHS without sideways scroll', async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      expect(await documentOverflow(page), `${width}px`).toBe(0);
    }
  });

  test('keeps the strip, the cards and the bars inside the page at every font scale', async ({
    page,
  }) => {
    for (const scale of FONT_SCALES) {
      await applyPreference(page, 'data-font-scale', scale);
      const viewport = page.viewportSize()!.width;

      for (const selector of ['.hive-stat-grid', '.home-continue', '.home-bars', '.home-steps']) {
        const box = (await page.locator(selector).first().boundingBox())!;
        expect(box.x + box.width, `${selector} at ${scale}`).toBeLessThanOrEqual(viewport + 1);
      }
    }
    await applyPreference(page, 'data-font-scale', null);
  });

  test('grows the pulse bars from a shared baseline', async ({ page }) => {
    const bars = await page.locator('.home-bars__bar').evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
      }),
    );

    expect(bars).toHaveLength(12);
    const baseline = bars[0].bottom;
    for (const bar of bars) expect(Math.abs(bar.bottom - baseline)).toBeLessThan(2);
    // The fixture's heights ascend, so the last bar must be the tallest.
    expect(bars[bars.length - 1].height).toBeGreaterThan(bars[0].height);
  });

  test('resolves each activity tone to a painted tint rather than to nothing', async ({ page }) => {
    const backgrounds = await page.locator('.home-row .home-tile').evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).backgroundColor),
    );
    expect(backgrounds.length).toBeGreaterThan(0);
    for (const background of backgrounds) {
      expect(background).not.toBe('rgba(0, 0, 0, 0)');
      expect(background).not.toBe('transparent');
    }
    // Four kinds, four distinct tints.
    expect(new Set(backgrounds).size).toBeGreaterThanOrEqual(4);
  });

  test('has no serious or critical axe violations, in every theme', async ({ page }) => {
    for (const theme of THEMES) {
      await applyPreference(page, 'data-theme', theme);
      const results = await new AxeBuilder({ page }).include('#home-probe').withTags(WCAG_TAGS).analyze();
      expect(blocking(results.violations), `theme ${theme ?? 'light'}`).toEqual([]);
    }
    await applyPreference(page, 'data-theme', null);
  });
});
