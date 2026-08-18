import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Tenants and the manage drawer, measured in a browser (HIVE-5.1, #5304).
 *
 * `tests/tenants-hive-redesign.test.tsx` pins what the page renders, `tests/tenants-model.ts`
 * pins the derivations behind it, and `tests/tenants-css.test.ts` pins the declarations. None
 * of the three can answer the acceptance criteria that are questions about *computed layout*,
 * because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — and the drawer is the hardest case on the page,
 *     because it puts a fixed tab rail beside a four-column tool grid inside an 860 px sheet.
 *   • **The tool row's three flag columns stay put** while the tool id, which can be long and
 *     has no break opportunity of its own, is the column that gives.
 *   • **The sticky unsaved bar is actually sticky** — visible at the bottom of a long toolset
 *     list rather than scrolled off with the control that dirtied it.
 *   • **The tab rail stays put while the panel scrolls**, which is the whole reason it is
 *     `position: sticky` on a grid with `align-items: start`.
 *   • **The mixed toolset switch is visibly a third state**, not a rounded-off "on".
 *   • **Focus is trapped in the sheet and restored on close** — a real focus model, which is
 *     the one thing jsdom cannot honestly report.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet actually
 *     renders it, which is the only way a token pair that fails contrast is caught.
 *
 * ### Why it injects markup instead of signing in
 *
 * The drawer's five sections read four different current-tenant-scoped APIs, and the states
 * worth measuring — a toolset in the *mixed* ceiling state, a tool id too long for its column,
 * a dirty draft under a list long enough to scroll, a policy diff — are precisely the ones a
 * seeded database will not produce on demand.
 *
 * So this suite does what `hive-linked-accounts.spec.ts`, `hive-profile.spec.ts` and
 * `hive-home.spec.ts` do: it loads `/login`, which compiles the real `globals.css` and needs no
 * session, and injects the page's own markup into it. The fixture is deliberately the worst
 * case throughout. What the markup *is* — that the components really compose these classes in
 * this nesting — is what the jsdom suite pins.
 *
 * Requires the app to be running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`).
 */

/** WCAG 2.1 Level A/AA — the conformance target of DESIGN.md §9. */
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

/** Widths either side of the drawer's tab-rail breakpoint (56rem), down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1101, 900, 897, 895, 767, 420];

/** A tool id long enough to have no chance of fitting its column. */
const LONG_TOOL_ID = 'contracts.verification.evidence.compare_against_published_baseline';

/** A tenant slug with no break opportunity, for the row's identity line. */
const LONG_SLUG =
  'acme-corporation-europe-middle-east-and-africa-holdings-payments-and-logistics-division';

/** A `Button size="sm"`, as `ui/Button` composes it. */
const BUTTON_SM =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium ' +
  'bg-surface text-fg shadow-control h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs';

/** A `<th>`, as `DataTable` composes it. */
const TH =
  'sticky top-0 z-1 whitespace-nowrap border-b border-border bg-surface text-left align-middle ' +
  'text-2xs font-semibold tracking-[var(--track-caps)] uppercase text-fg-muted px-3.5';

/** A `<td>`, as `DataTable` composes it. */
const TD = 'h-[var(--row-h)] border-b border-border align-middle px-3.5';

/** A `Badge`, as `ui/Badge` composes it. */
const BADGE =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full ' +
  'px-[0.4375rem] text-2xs font-semibold leading-none tracking-[0.01em] h-5';

/** A vertical `TabsTrigger`, as `tabStyles` composes it. */
const VTAB =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium ' +
  'min-h-[var(--control-h)] px-3 py-1.5 text-sm rounded-sm text-fg-muted';

/** One advanced tool row of the MCP settings section. */
function toolRow(id: string, inCeiling: boolean): string {
  const sw = (on: boolean, label: string) =>
    `<span><button type="button" role="switch" aria-checked="${on}" aria-label="${label}" ` +
    `class="hive-control inline-flex h-5 w-9 shrink-0 items-center rounded-full"></button></span>`;
  return `
    <div class="tnt-tool-row">
      <span class="min-w-0">
        <span class="block truncate font-mono text-xs text-fg">${id}</span>
        <span class="block truncate text-2xs text-fg-muted">Compare a candidate revision against the published baseline</span>
      </span>
      ${sw(inCeiling, `${id} in ceiling`)}
      ${sw(inCeiling, `${id} default enabled`)}
      ${sw(false, `${id} anonymous enabled`)}
    </div>`;
}

/** The tenants list, as `TenantsTable` composes it. */
const LIST_MARKUP = `
<div class="page" id="tenants-probe">
  <header class="page-header">
    <div class="page-header__inner">
      <div class="page-header__row">
        <div class="flex items-start">
          <div class="min-w-0">
            <nav aria-label="Breadcrumb" class="page-header__crumbs mb-1.5 text-xs text-fg-muted">
              <ol class="flex flex-wrap items-center gap-1.5"><li>Home</li><li>Workspace</li><li>Tenants</li></ol>
            </nav>
            <h1 class="page-header__title"><span class="min-w-0 break-words">Tenants</span></h1>
            <p class="page-header__desc">Your workspaces — switch between them or manage the ones you administer.</p>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
          <span class="text-xs text-fg-muted">3 tenants</span>
          <button type="button" class="${BUTTON_SM}">New tenant</button>
        </div>
      </div>
    </div>
  </header>

  <div class="page-body">
    <div class="table-density overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-sm)]">
      <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <input type="search" aria-label="Filter tenants" placeholder="Filter by name or slug…"
               class="hive-control h-[var(--control-h-sm)] w-[16.25rem] max-w-full rounded-sm pl-8 text-sm" />
        <button type="button" aria-pressed="true" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-fg text-surface">All <span class="text-fg-faint">3</span></button>
        <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted">You administer <span class="text-fg-faint">2</span></button>
        <span aria-hidden="true" class="flex-1"></span>
      </div>
      <div class="overflow-x-auto" tabindex="0" role="region" aria-label="Tenants you belong to">
        <table class="w-full border-separate border-spacing-0 text-sm text-fg min-w-[48.75rem]">
          <caption class="sr-only">Tenants you belong to</caption>
          <thead>
            <tr>
              <th scope="col" class="${TH}">Tenant</th>
              <th scope="col" class="${TH}">Description</th>
              <th scope="col" class="${TH}">Your role</th>
              <th scope="col" class="${TH}">Status</th>
              <th scope="col" class="${TH} text-right"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr class="group tnt-row--current bg-accent-soft" id="tnt-row-current">
              <td class="${TD}">
                <div class="flex items-center gap-3">
                  <span class="avatar-hex relative inline-grid size-6.5 shrink-0 place-items-center bg-inset text-2xs font-semibold text-fg-muted" aria-hidden="true">AC</span>
                  <div class="min-w-0">
                    <div class="font-medium whitespace-nowrap text-fg flex items-center gap-2">
                      <span class="truncate">Acme Corporation Europe</span>
                      <span class="${BADGE} bg-accent-soft text-accent-fg">Current</span>
                    </div>
                    <div class="mt-px text-xs text-fg-muted truncate font-mono" id="tnt-slug">${LONG_SLUG}</div>
                  </div>
                </div>
              </td>
              <td class="${TD}"><span class="line-clamp-1 max-w-[22rem] text-sm text-fg-muted">Merchant platform APIs — payments, orders and logistics for every market we operate in.</span></td>
              <td class="${TD}"><span class="${BADGE} bg-violet-soft text-violet-fg">Admin</span></td>
              <td class="${TD}"><span class="${BADGE} bg-ok-soft text-ok-fg"><span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-current"></span>Enabled</span></td>
              <td class="${TD} text-right">
                <div data-row-actions="" class="flex items-center justify-end gap-1">
                  <button type="button" id="tnt-manage" class="${BUTTON_SM}">Manage</button>
                  <button type="button" aria-label="Actions for Acme Corporation Europe" class="${BUTTON_SM} bg-transparent shadow-none px-1.5">⋯</button>
                </div>
              </td>
            </tr>
            <tr class="group">
              <td class="${TD}">
                <div class="flex items-center gap-3">
                  <span class="avatar-hex relative inline-grid size-6.5 shrink-0 place-items-center bg-inset text-2xs font-semibold text-fg-muted" aria-hidden="true">LH</span>
                  <div class="min-w-0">
                    <div class="font-medium whitespace-nowrap text-fg flex items-center gap-2"><button type="button" class="truncate rounded-sm text-left">Legacy Holdings</button></div>
                    <div class="mt-px text-xs text-fg-muted truncate font-mono">legacy-holdings</div>
                  </div>
                </div>
              </td>
              <td class="${TD}"><span class="text-sm text-fg-muted">—</span></td>
              <td class="${TD}"><span class="${BADGE} bg-surface text-fg-muted">Member</span></td>
              <td class="${TD}"><span class="${BADGE} bg-surface text-fg-muted"><span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-current"></span>Disabled</span></td>
              <td class="${TD} text-right"><div data-row-actions="" class="flex items-center justify-end gap-1"><button type="button" aria-label="Actions for Legacy Holdings" class="${BUTTON_SM} bg-transparent shadow-none px-1.5">⋯</button></div></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 text-xs text-fg-muted">
        <span>3 tenants · you administer 2</span>
      </div>
    </div>
  </div>
</div>`;

/**
 * The manage drawer, as `TenantManageDrawer` composes it.
 *
 * Deliberately on the MCP settings tab, with a long toolset list, a *mixed* master switch, a
 * tool id that cannot fit its column, and a dirty bar — every measurable state at once.
 */
const DRAWER_MARKUP = `
<div class="fixed inset-0 z-[9998] bg-overlay backdrop-blur-sm" aria-hidden="true"></div>
<div role="dialog" aria-label="Manage Acme Corporation Europe" id="tnt-drawer"
     class="hive-drawer fixed inset-y-0 right-0 z-[9999] flex h-full w-full flex-col bg-surface text-fg shadow-lg max-w-[53.75rem]">
  <div class="flex shrink-0 flex-row items-start gap-3 border-b border-border px-5 py-4 pr-12 text-left">
    <span class="avatar-hex relative inline-grid size-11 shrink-0 place-items-center bg-inset text-base font-semibold text-fg-muted" aria-hidden="true">AC</span>
    <div class="min-w-0 grow">
      <h2 class="text-lg font-semibold leading-snug text-fg">Manage Acme Corporation Europe</h2>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
        <span class="font-mono">${LONG_SLUG}</span><span aria-hidden="true">·</span><span>5 members</span>
        <span class="${BADGE} bg-accent-soft text-accent-fg">Current</span>
      </div>
    </div>
    <button type="button" class="${BUTTON_SM} mt-0.5 shrink-0">Edit tenant</button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4" id="tnt-drawer-body">
    <div class="tnt-manage-grid">
      <div role="tablist" aria-label="Administration sections" aria-orientation="vertical" class="flex flex-col gap-0.5 tnt-manage-nav">
        <button role="tab" aria-selected="false" class="${VTAB}">Members<span class="tnt-tab-count">5</span></button>
        <button role="tab" aria-selected="false" class="${VTAB}">License &amp; plan</button>
        <button role="tab" aria-selected="true" id="tnt-tab-mcp" class="${VTAB.replace('text-fg-muted', 'text-fg')} bg-subtle">MCP settings<span class="tnt-tab-dot"><span class="sr-only">Unsaved changes</span></span></button>
        <button role="tab" aria-selected="false" class="${VTAB}">Per-key capabilities</button>
        <button role="tab" aria-selected="false" class="${VTAB}">Policy history</button>
      </div>

      <div class="min-w-0">
        <section aria-labelledby="tnt-mcp-heading" class="space-y-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 id="tnt-mcp-heading" class="tnt-section-title">MCP settings</h3>
              <p class="tnt-section-desc">tools/list always returns the full catalog; ceiling, defaults, and anonymous flags only gate tools/call.</p>
            </div>
            <span class="${BADGE} bg-surface text-fg-muted">Admins can edit</span>
          </div>

          <div class="tnt-switch-row">
            <div class="min-w-0">
              <label class="text-sm font-medium text-fg" for="anon">Allow anonymous MCP calls</label>
              <p class="text-xs text-fg-muted">Unauthenticated agents may call tools flagged “Anonymous” below.</p>
            </div>
            <button type="button" id="anon" role="switch" aria-checked="false" aria-label="Allow anonymous MCP calls" class="hive-control inline-flex h-5 w-9 shrink-0 items-center rounded-full"></button>
          </div>

          <div class="space-y-3" id="tnt-toolsets">
            <section aria-label="catalog toolset" class="tnt-toolset-card" data-ceiling="all">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-3">
                  <button type="button" role="switch" aria-checked="true" aria-label="Enable catalog toolset" class="hive-control inline-flex h-5 w-9 shrink-0 items-center rounded-full"></button>
                  <div class="min-w-0"><div class="text-sm font-semibold text-fg">Catalog</div><div class="text-xs text-fg-muted">4 of 4 tools in ceiling</div></div>
                </div>
                <span class="${BADGE} bg-ok-soft text-ok-fg">All in ceiling</span>
              </div>
              <div class="tnt-toolset-tools">
                <div class="tnt-tool-row tnt-tool-row--head" aria-hidden="true"><span>Tool</span><span>In ceiling</span><span>Default</span><span>Anonymous</span></div>
                ${toolRow('catalog.search', true)}
                ${toolRow('catalog.get_item', true)}
                ${toolRow('catalog.list_versions', true)}
                ${toolRow('catalog.export', true)}
              </div>
            </section>

            <section aria-label="lint toolset" class="tnt-toolset-card" data-ceiling="mixed" id="tnt-toolset-mixed">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-3">
                  <button type="button" role="switch" aria-checked="mixed" data-state="indeterminate" aria-label="Enable lint toolset" id="tnt-mixed-switch" class="hive-control inline-flex h-5 w-9 shrink-0 items-center rounded-full"></button>
                  <div class="min-w-0"><div class="text-sm font-semibold text-fg">Lint</div><div class="text-xs text-fg-muted">2 of 3 tools in ceiling</div></div>
                </div>
                <span class="${BADGE} bg-warn-soft text-warn-fg">Mixed</span>
              </div>
              <div class="tnt-toolset-tools">
                <div class="tnt-tool-row tnt-tool-row--head" aria-hidden="true"><span>Tool</span><span>In ceiling</span><span>Default</span><span>Anonymous</span></div>
                ${toolRow('lint.run', true)}
                ${toolRow('lint.gate', true)}
                ${toolRow(LONG_TOOL_ID, false)}
              </div>
            </section>

            <section aria-label="publish toolset" class="tnt-toolset-card" data-ceiling="none" id="tnt-toolset-off">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-3">
                  <button type="button" role="switch" aria-checked="false" aria-label="Enable publish toolset" class="hive-control inline-flex h-5 w-9 shrink-0 items-center rounded-full"></button>
                  <div class="min-w-0"><div class="text-sm font-semibold text-fg">Publish</div><div class="text-xs text-fg-muted">0 of 2 tools in ceiling</div></div>
                </div>
                <span class="${BADGE} bg-surface text-fg-muted">Off</span>
              </div>
            </section>
          </div>

          <div role="status" class="tnt-dirty-bar" id="tnt-dirty">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="size-[var(--icon-dense)] shrink-0"><circle cx="12" cy="12" r="10"/></svg>
            <span class="shrink-0 font-semibold">Unsaved MCP settings changes</span>
            <span class="tnt-dirty-bar__sub" id="tnt-dirty-sub">${LONG_TOOL_ID} removed from ceiling · anonymous calls off</span>
            <div class="ml-auto flex shrink-0 gap-2">
              <button type="button" class="${BUTTON_SM}">Discard</button>
              <button type="button" class="${BUTTON_SM}">Save changes</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>

  <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
    <span class="mr-auto text-xs text-fg-muted">Only administrators of Acme Corporation Europe see this panel.</span>
    <button type="button" class="${BUTTON_SM}">Done</button>
  </div>
</div>`;

/** A policy-history row with its diff expanded — the tinted before/after chips. */
const HISTORY_MARKUP = `
<div class="page" id="tnt-history-probe">
  <div class="page-body">
    <div class="tnt-card tnt-card--flush">
      <div class="tnt-hist-row tnt-hist-row--head tnt-caps" aria-hidden="true"><span>When</span><span>Actor</span><span>Change</span><span></span></div>
      <ul>
        <li>
          <div class="tnt-hist-row">
            <span class="font-mono text-xs tabular-nums text-fg-muted">Aug 15, 2026, 09:41 AM</span>
            <span class="flex min-w-0 items-center gap-2"><span class="relative inline-grid size-5 shrink-0 place-items-center rounded-full bg-inset text-2xs font-semibold text-fg-muted" aria-hidden="true">AL</span><span class="truncate text-sm text-fg">Ada Lovelace</span></span>
            <span class="min-w-0 truncate text-sm text-fg-muted">1 tool flag, 1 policy field</span>
            <button type="button" aria-expanded="true" aria-label="Toggle details" class="${BUTTON_SM} bg-transparent shadow-none px-1.5">▾</button>
          </div>
          <div class="tnt-hist-diff">
            <p class="tnt-caps mb-1">Settings changes</p>
            <div class="tnt-diff-line"><span class="tnt-diff-line__field">Capability profile</span><span class="tnt-diff-line__from" id="tnt-diff-from">Full catalog</span><svg viewBox="0 0 24 24" aria-hidden="true" class="size-[var(--icon-button)] shrink-0"><path d="M5 12h14"/></svg><span class="tnt-diff-line__to" id="tnt-diff-to">CI &amp; contract gates</span></div>
            <p class="tnt-caps mt-2 mb-1">Tool-flag changes</p>
            <div class="tnt-diff-line"><span class="tnt-diff-line__field">${LONG_TOOL_ID} · Ceiling</span><span class="tnt-diff-line__from">on</span><svg viewBox="0 0 24 24" aria-hidden="true" class="size-[var(--icon-button)] shrink-0"><path d="M5 12h14"/></svg><span class="tnt-diff-line__to">off</span></div>
          </div>
        </li>
      </ul>
    </div>
  </div>
</div>`;

/**
 * Load a page that compiles `globals.css`, and replace its body with the fixture.
 *
 * @param page The Playwright page.
 * @param markup What to draw.
 */
async function mount(page: Page, markup: string): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((body) => {
    document.body.innerHTML = `<main>${body}</main>`;
    document.body.style.margin = '0';
  }, markup);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/** Set the appearance preferences the tokens key off. */
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

/** Whether the document scrolls sideways. */
function documentOverflows(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // A one-pixel tolerance: sub-pixel layout rounding is not a horizontal scrollbar.
    return doc.scrollWidth - doc.clientWidth > 1;
  });
}

/* -------------------------------------------------------------------------
   No horizontal document scroll, in every appearance
   ------------------------------------------------------------------------- */

test.describe('the tenants list keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, LIST_MARKUP);
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const theme of THEMES) {
    test(`does not scroll sideways in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, LIST_MARKUP);
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  test('absorbs an 86-character slug at 1280px without scrolling anything', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, LIST_MARKUP);

    const region = page.locator('[role="region"][aria-label="Tenants you belong to"]');
    const regionScrolls = await region.evaluate(
      (node) => node.scrollWidth > node.clientWidth + 1
    );

    // The description column's `max-w-[22rem]` and one-line clamp leave the identity column
    // room for a slug this long, so at the width DESIGN.md §5 names, neither the page nor
    // the table has anywhere to scroll.
    expect(regionScrolls).toBe(false);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('scrolls the table inside its own card, never the page, when it does run out', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, LIST_MARKUP);

    const region = page.locator('[role="region"][aria-label="Tenants you belong to"]');
    // `scrollX` puts a floor under the table (48.75rem) and lets it scroll sideways there.
    expect(await region.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });
});

test.describe('the manage drawer keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, DRAWER_MARKUP);
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const scale of FONT_SCALES) {
    test(`does not scroll sideways at font scale ${scale}`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, DRAWER_MARKUP);
      await applyPreferences(page, { fontScale: scale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`does not scroll sideways in ${density} density`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, DRAWER_MARKUP);
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  test('is capped at the 860px the design language gives an xl sheet', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const width = await page.locator('#tnt-drawer').evaluate((node) => node.clientWidth);
    // 53.75rem at the default 16px root.
    expect(width).toBeLessThanOrEqual(860);
    expect(width).toBeGreaterThan(820);
  });

  test('becomes the whole screen on a phone, which is the only honest thing to do', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await mount(page, DRAWER_MARKUP);

    const width = await page.locator('#tnt-drawer').evaluate((node) => node.clientWidth);
    expect(width).toBe(380);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The tool row's columns
   ------------------------------------------------------------------------- */

test.describe('the advanced tool row', () => {
  test('gives its three flag columns fixed width and lets the tool id be the one that yields', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const widths = await page
      .locator('#tnt-toolset-mixed .tnt-tool-row')
      .last()
      .evaluate((row) =>
        Array.from(row.children).map((cell) => Math.round(cell.getBoundingClientRect().width))
      );

    expect(widths).toHaveLength(4);
    // 5.75rem / 5.25rem / 6rem at the default root size.
    expect(widths[1]).toBe(92);
    expect(widths[2]).toBe(84);
    expect(widths[3]).toBe(96);
    // The id column takes what is left, and is narrower than the row.
    expect(widths[0]).toBeGreaterThan(0);
  });

  test('truncates a tool id that cannot fit rather than widening its row', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const id = page.locator('#tnt-toolset-mixed .tnt-tool-row').last().locator('.font-mono');
    expect(await id.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('scales its flag columns with the font-size preference', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const measure = () =>
      page
        .locator('#tnt-toolset-mixed .tnt-tool-row')
        .last()
        .evaluate((row) => Math.round(row.children[1].getBoundingClientRect().width));

    await applyPreferences(page, { fontScale: 'xs' });
    const small = await measure();
    await applyPreferences(page, { fontScale: '2xl' });
    const large = await measure();

    // The mockup froze these at 92px. In `rem` they follow the preference, which is the
    // whole point of the deviation.
    expect(large).toBeGreaterThan(small);
  });

  test('closes the columns up and drops the caps header on a narrow drawer', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await mount(page, DRAWER_MARKUP);

    await expect(page.locator('#tnt-toolset-mixed .tnt-tool-row--head')).toBeHidden();
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The sticky rail and the sticky bar
   ------------------------------------------------------------------------- */

test.describe('the sticky pieces', () => {
  test('keeps the unsaved bar on screen when the toolset list is scrolled', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 600 });
    await mount(page, DRAWER_MARKUP);

    const bar = page.locator('#tnt-dirty');
    await expect(bar).toBeInViewport();

    await page.locator('#tnt-drawer-body').evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(bar).toBeInViewport();

    // Scroll the sheet's body to the middle of the toolset list; the bar must not go with it.
    await page.locator('#tnt-drawer-body').evaluate((node) => {
      node.scrollTop = Math.round(node.scrollHeight / 2);
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    await expect(bar).toBeInViewport();
  });

  test('keeps the tab rail in place while the panel beside it scrolls', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 600 });
    await mount(page, DRAWER_MARKUP);

    const railTop = () =>
      page.locator('.tnt-manage-nav').evaluate((node) => node.getBoundingClientRect().top);
    const before = await railTop();

    await page.locator('#tnt-drawer-body').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );

    // Sticky, so it stays put rather than travelling with the panel.
    expect(Math.abs((await railTop()) - before)).toBeLessThan(4);
  });

  test('stacks the rail above the panel on a narrow drawer', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const [rail, panel] = await Promise.all([
      page.locator('.tnt-manage-nav').boundingBox(),
      page.locator('#tnt-mcp-heading').boundingBox(),
    ]);
    expect(rail).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(rail!.y + rail!.height).toBeLessThanOrEqual(panel!.y + 1);
    // And the tabs run along it rather than down it.
    expect(rail!.width).toBeGreaterThan(400);
  });

  test('elides a long change summary instead of pushing Save off the bar', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const sub = page.locator('#tnt-dirty-sub');
    expect(await sub.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(true);

    const [bar, save] = await Promise.all([
      page.locator('#tnt-dirty').boundingBox(),
      page.locator('#tnt-dirty button', { hasText: 'Save changes' }).boundingBox(),
    ]);
    expect(save!.x + save!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
  });
});

/* -------------------------------------------------------------------------
   The states a reader has to be able to tell apart
   ------------------------------------------------------------------------- */

test.describe('the three toolset ceiling states', () => {
  test('outlines an off toolset instead of fading or tinting it', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const read = (selector: string) =>
      page.locator(selector).evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          opacity: style.opacity,
          background: style.backgroundColor,
          shadow: style.boxShadow,
        };
      });

    const [off, mixed] = await Promise.all([read('#tnt-toolset-off'), read('#tnt-toolset-mixed')]);

    // The border is the difference. Neither of the other two ways of saying "off" survives a
    // contrast check: the mockup's 85 % fade takes `--fg-muted` to 4.45:1 on paper, and a
    // `--bg-subtle` tint takes it to 4.35:1 in Solarized. Both are under AA.
    expect(off.shadow).not.toBe(mixed.shadow);
    expect(off.background).toBe(mixed.background);
    expect(off.opacity).toBe('1');
    expect(mixed.opacity).toBe('1');
  });

  test('gives the unsaved dot the same warn hue as the bar it points at', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const dot = await page
      .locator('.tnt-tab-dot')
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    const warn = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--warn').trim()
    );
    expect(dot).not.toBe('rgba(0, 0, 0, 0)');
    expect(warn).not.toBe('');
  });
});

test.describe('the policy diff', () => {
  test('tints each value rather than colouring it on the bare panel', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, HISTORY_MARKUP);

    for (const id of ['#tnt-diff-from', '#tnt-diff-to']) {
      const background = await page
        .locator(id)
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(background).not.toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('strikes the old value through, so before and after read without their colours', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, HISTORY_MARKUP);

    const decoration = await page
      .locator('#tnt-diff-from')
      .evaluate((node) => getComputedStyle(node).textDecorationLine);
    expect(decoration).toContain('line-through');
  });

  test('wraps a long diff line rather than widening the sheet', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, HISTORY_MARKUP);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   axe
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  test('the list has no serious or critical axe violations', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, LIST_MARKUP);

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical'
    );
    expect(serious.map((violation) => violation.id)).toEqual([]);
  });

  test('the drawer has no serious or critical axe violations', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical'
    );
    expect(serious.map((violation) => violation.id)).toEqual([]);
  });

  for (const theme of THEMES) {
    test(`the drawer has no contrast violations in the ${theme ?? 'light'} theme`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, DRAWER_MARKUP);
      await applyPreferences(page, { theme });

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .include('#tnt-drawer')
        .analyze();
      const contrast = results.violations.filter((violation) => violation.id === 'color-contrast');
      expect(contrast.flatMap((violation) => violation.nodes.map((node) => node.html))).toEqual([]);
    });
  }

  test('the policy diff clears contrast in every theme', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });

    for (const theme of THEMES) {
      await mount(page, HISTORY_MARKUP);
      await applyPreferences(page, { theme });

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .include('.tnt-hist-diff')
        .analyze();
      const contrast = results.violations.filter((violation) => violation.id === 'color-contrast');
      expect({
        theme: theme ?? 'light',
        offenders: contrast.flatMap((violation) => violation.nodes.map((node) => node.html)),
      }).toEqual({ theme: theme ?? 'light', offenders: [] });
    }
  });
});
