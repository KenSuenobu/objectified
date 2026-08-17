import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Help & docs' layout, measured in a browser (HIVE-4.9, #5303).
 *
 * `tests/help-page.test.tsx` pins what the page renders, `tests/help-catalog.test.ts` and
 * `tests/help-model.test.ts` pin the guide set and the cards behind it, and
 * `tests/help-css.test.ts` pins the declarations. None of the four can answer the acceptance
 * criteria that are questions about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — every one of which swaps a token this page is laid
 *     out from.
 *   • **Six cards are two even rows**, not a row of four and a row of two, and they reflow at
 *     the two widths the rest of the app reflows at.
 *   • **A tenant id stays inside its card.** A uuid has no break opportunity of its own and
 *     the support well is one column of a grid, which is the only case here that can push the
 *     page sideways — and the only honest check is to measure it.
 *   • **The magnifier stays inside the search field** at every font scale, since the glyph's
 *     inset and the field's leading pad are two different tokens that both move.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet actually
 *     renders it, which is the only way a token pair that fails contrast can be caught.
 *
 * ### Why it injects markup instead of signing in
 *
 * The same reason `hive-linked-accounts.spec.ts` and `hive-profile.spec.ts` give: the page's
 * content is a session (a tenant id, a build) and a live shortcut registry, so a signed-in
 * spec would measure whatever the seeded user happens to have — and the interesting case, an
 * identifier longer than its column, is precisely the one a fixed database will not produce.
 * So this loads `/login`, which compiles the real `globals.css` and needs no session, and puts
 * the page's own markup into it. The fixture is deliberately the worst case throughout.
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

/** Widths either side of the grid's two breakpoints (1100 px, 768 px), down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1101, 1099, 900, 769, 767, 420];

/** The card chrome, as `ui/Card` composes it. */
const CARD = 'rounded-lg bg-surface shadow-sm';

/** A tenant id with no break opportunity in it — the case the well's `anywhere` is there for. */
const LONG_TENANT_ID = 'ten_01HJ7F8HQ2ZKXW9M4NPB6VYTGC3RD5SJA8EU7LFZ';

/**
 * The page's body, as the components compose it.
 *
 * Written out rather than rendered because Playwright has no React runtime: the markup a
 * component tree produces is already pinned by the jsdom suite, and what this fixture has to
 * be faithful about is the *class names and nesting* the stylesheet keys off.
 */
const HELP_MARKUP = `
<div class="mx-auto w-full max-w-[80rem] px-[var(--page-pad)] py-6 flex flex-col gap-6">
  <section class="help-search">
    <label for="help-q" class="sr-only">Search the guide</label>
    <div class="help-search__field">
      <svg class="help-search__icon" width="1rem" height="1rem" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor"></circle></svg>
      <input id="help-q" type="search" class="hive-control flex w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg help-search__input"
             placeholder="Search the guide… e.g. publish a version, import RAML, MCP trust posture" />
    </div>
    <p class="help-search__status">2 guides match “publish”.</p>
    <ul class="help-results">
      <li>
        <a class="help-result" href="#">
          <span class="help-result__body">
            <span class="help-result__title">Publish a version<svg class="help-result__out" width="1rem" height="1rem" aria-hidden="true"></svg></span>
            <span class="help-result__sub">Freeze a version for browse, export and MCP consumers — and the publish gates that refuse one that is not ready.</span>
          </span>
          <span class="help-result__section">How do I…?</span>
        </a>
      </li>
      <li>
        <a class="help-result" href="#">
          <span class="help-result__body">
            <span class="help-result__title">Browse published specs<svg class="help-result__out" width="1rem" height="1rem" aria-hidden="true"></svg></span>
            <span class="help-result__sub">The read surface for published versions: public ones need no authentication, private ones an in-scope API key.</span>
          </span>
          <span class="help-result__section">How do I…?</span>
        </a>
      </li>
    </ul>
  </section>

  <div class="help-grid">
    <button type="button" class="${CARD} help-card help-card--action" data-tone="honey">
      <span class="help-tile" aria-hidden="true"><svg width="1.125rem" height="1.125rem"></svg></span>
      <span class="help-card__title">Get started</span>
      <span class="help-card__desc">First project → first version → publish → browse. Reopens the getting-started checklist on Home.</span>
    </button>
    <a class="${CARD} help-card" href="#" data-tone="accent">
      <span class="help-tile" aria-hidden="true"><svg width="1.125rem" height="1.125rem"></svg></span>
      <span class="help-card__title">User guide<svg class="help-card__out" width="1rem" height="1rem" aria-hidden="true"></svg></span>
      <span class="help-card__desc">Import a spec, edit classes &amp; paths, cut a version, lint &amp; quality, export fidelity, MCP quick-start.</span>
    </a>
    <a class="${CARD} help-card" href="#" data-tone="ok">
      <span class="help-tile" aria-hidden="true"><svg width="1.125rem" height="1.125rem"></svg></span>
      <span class="help-card__title">API &amp; CLI reference<svg class="help-card__out" width="1rem" height="1rem" aria-hidden="true"></svg></span>
      <span class="help-card__desc">REST API, the apiome CLI, and CI diff-gate recipes for GitHub, GitLab and Bitbucket.</span>
    </a>
    <a class="${CARD} help-card" href="#" data-tone="violet">
      <span class="help-tile" aria-hidden="true"><svg width="1.125rem" height="1.125rem"></svg></span>
      <span class="help-card__title">Video walkthroughs<svg class="help-card__out" width="1rem" height="1rem" aria-hidden="true"></svg></span>
      <span class="help-card__desc">Short screencasts on YouTube.</span>
    </a>
    <button type="button" class="${CARD} help-card help-card--soon" disabled aria-label="Community (coming soon)" data-tone="neutral">
      <span class="help-tile" aria-hidden="true"><svg width="1.125rem" height="1.125rem"></svg></span>
      <span class="help-card__title">Community<span class="help-card__badge inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-[0.4375rem] text-2xs font-semibold leading-none bg-transparent text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)] h-5">Soon</span></span>
      <span class="help-card__desc">Connect with other builders.</span>
    </button>
    <div class="${CARD} help-card help-card--static" data-tone="rose" data-testid="help-card-support">
      <span class="help-tile" aria-hidden="true"><svg width="1.125rem" height="1.125rem"></svg></span>
      <p class="help-card__title">Contact support</p>
      <p class="help-card__desc">Open an issue with the details below — a tenant id and a build turn a report into something reproducible.</p>
      <dl class="help-support">
        <div class="help-support__row">
          <dt class="help-support__label">Tenant id</dt>
          <dd class="help-support__value" data-testid="help-support-tenant">${LONG_TENANT_ID}</dd>
        </div>
        <div class="help-support__row">
          <dt class="help-support__label">Build</dt>
          <dd class="help-support__value">v0.271.0 RC</dd>
        </div>
      </dl>
      <div class="help-card__actions">
        <button type="button" class="inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium bg-surface text-fg shadow-control h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs">Copy details</button>
        <a class="help-card__link" href="#">Open an issue</a>
      </div>
    </div>
  </div>

  <section class="${CARD} help-glance" role="region" aria-labelledby="glance-title">
    <div class="help-glance__header">
      <h2 id="glance-title" class="help-glance__title"><svg width="1rem" height="1rem" aria-hidden="true"></svg>Shortcuts at a glance</h2>
      <button type="button" class="inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs">Full sheet</button>
    </div>
    <dl class="help-glance__grid">
      ${[
        ['Open the command palette', ['⌘', 'K']],
        ['Preferences', ['⌘', ',']],
        ['Collapse the sidebar', ['⌘', '\\']],
        ['Search this workspace', ['/']],
        ['New project', ['N']],
        ['Import a specification', ['I']],
        ['Close the overlay in front', ['Esc']],
        ['Keyboard shortcuts', ['?']],
      ]
        .map(
          ([label, keys]) => `
      <div class="help-glance__row">
        <dt class="help-glance__label">${label}</dt>
        <dd class="help-glance__keys">
          <span class="kbd-group" aria-hidden="true">${(keys as string[])
            .map((key) => `<kbd class="kbd">${key}</kbd>`)
            .join('')}</span>
          <span class="sr-only">${label} shortcut</span>
        </dd>
      </div>`
        )
        .join('')}
    </dl>
  </section>
</div>
`;

/**
 * Load a page that compiles `globals.css`, and put the fixture in it.
 *
 * @param page The page under test.
 */
async function mountHelp(page: Page): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((body) => {
    document.body.innerHTML = `<main>${body}</main>`;
    document.body.style.margin = '0';
  }, HELP_MARKUP);
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
    [attribute, value] as const
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
 * How many cards share the grid's first row.
 *
 * @param page The page under test.
 * @returns The number of cards whose top edge matches the first card's.
 */
async function cardsPerRow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.help-grid > *')];
    if (cards.length === 0) return 0;
    const first = cards[0].getBoundingClientRect().top;
    return cards.filter((card) => Math.abs(card.getBoundingClientRect().top - first) < 2).length;
  });
}

/**
 * The blocking half of an axe run.
 *
 * @param violations Everything axe reported.
 * @returns Only the serious and critical findings, as `id: help [where]` lines.
 */
function blocking(
  violations: {
    id: string;
    help: string;
    impact?: string | null;
    nodes?: { html?: string; failureSummary?: string | null }[];
  }[]
): string[] {
  return violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => {
      const where = (violation.nodes ?? [])
        .map(
          (node) =>
            `${node.html ?? '?'} — ${(node.failureSummary ?? '').replace(/\s+/g, ' ').trim()}`
        )
        .join(' | ');
      return `${violation.id}: ${violation.help}${where ? ` [${where}]` : ''}`;
    });
}

test.describe('Help & docs layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
    await mountHelp(page);
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

  test('holds every width without sideways scroll', async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      await settle(page);
      expect(await documentOverflow(page), `${width}px`).toBe(0);
    }
  });

  test('draws six cards as two even rows, and reflows at the two shared widths', async ({
    page,
  }) => {
    expect(await cardsPerRow(page), '1280px').toBe(3);

    await page.setViewportSize({ width: 1099, height: 1000 });
    await settle(page);
    expect(await cardsPerRow(page), '1099px').toBe(2);

    await page.setViewportSize({ width: 767, height: 1000 });
    await settle(page);
    expect(await cardsPerRow(page), '767px').toBe(1);
  });

  test('keeps a tenant id with no break opportunity inside its card', async ({ page }) => {
    const overflow = await page.evaluate(() => {
      const value = document.querySelector('[data-testid="help-support-tenant"]');
      const card = document.querySelector('[data-testid="help-card-support"]');
      if (!value || !card) return null;
      const inner = value.getBoundingClientRect();
      const outer = card.getBoundingClientRect();
      return Math.max(0, inner.right - outer.right);
    });
    expect(overflow).toBe(0);
  });

  test('lines the support card’s actions up with the bottom of the row', async ({ page }) => {
    // `margin-block-start: auto` on the actions row is what does this — without it the row
    // would float half-way up a card that is taller than its own content.
    const gap = await page.evaluate(() => {
      const actions = document.querySelector('.help-card__actions');
      const card = document.querySelector('[data-testid="help-card-support"]');
      if (!actions || !card) return null;
      const style = getComputedStyle(card as Element);
      const pad = parseFloat(style.paddingBottom);
      return card.getBoundingClientRect().bottom - actions.getBoundingClientRect().bottom - pad;
    });
    expect(gap).toBeLessThan(2);
  });

  test('keeps the magnifier inside the field at every font scale', async ({ page }) => {
    for (const scale of FONT_SCALES) {
      await applyPreference(page, 'data-font-scale', scale);
      const inside = await page.evaluate(() => {
        const icon = document.querySelector('.help-search__icon');
        const field = document.querySelector('.help-search__input');
        if (!icon || !field) return null;
        const glyph = icon.getBoundingClientRect();
        const box = field.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(field as Element).paddingInlineStart);
        // The glyph sits inside the field, and clear of where the text begins.
        return glyph.left >= box.left && glyph.right <= box.left + pad;
      });
      expect(inside, `font scale ${scale}`).toBe(true);
    }
    await applyPreference(page, 'data-font-scale', null);
  });

  test('fades the unshipped card without fading it out of reach of AA', async ({ page }) => {
    const opacity = await page.evaluate(() => {
      const card = document.querySelector('.help-card--soon');
      return card ? getComputedStyle(card).opacity : null;
    });
    expect(Number(opacity)).toBeGreaterThanOrEqual(0.6);
  });

  test('has no serious or critical axe violations, in light and in dark', async ({ page }) => {
    for (const theme of [null, 'dark']) {
      await applyPreference(page, 'data-theme', theme);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(blocking(results.violations), `theme ${theme ?? 'light'}`).toEqual([]);
    }
    await applyPreference(page, 'data-theme', null);
  });
});
