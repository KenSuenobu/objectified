import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The access audit, measured in a browser (HIVE-5.5, #5308).
 *
 * `tests/audit-hive-redesign.test.tsx` pins what the page renders,
 * `tests/audit-model.test.ts` pins the derivations behind it, and `tests/audit-css.test.ts`
 * pins the declarations. None of the three can answer the questions that are about *computed
 * layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a page that is a six-column table above a sheet
 *     containing two 64-character hashes and a JSON payload.
 *   • **The table scrolls inside its own wrapper** when the viewport cannot hold six columns,
 *     rather than taking the document with it.
 *   • **The drawer shows the payload without truncation.** A `<pre>` that scrolls inside its
 *     own box is the only way that stays true at every font scale; what has to be *measured*
 *     is that the box scrolls and the sheet does not.
 *   • **A 64-character digest wraps** rather than being clipped — an auditor comparing a hash
 *     by eye must be able to see all of it.
 *   • **The event badges are distinguishable from each other**, which is what "coloured by
 *     action prefix" has to mean once the hues are tokens rather than literals.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet renders it.
 *
 * ### Why it injects markup instead of signing in
 *
 * The same reason `hive-api-keys.spec.ts`, `hive-members.spec.ts` and `hive-roles.spec.ts`
 * give. The states worth measuring — an entry from each family, a broken chain link, a
 * payload deep enough to scroll — are precisely the ones a seeded database will not produce
 * on demand, and every read here is tenant-scoped. Writing real audit rows to produce them
 * would mean mutating an append-only ledger on every CI run, which is the one table in the
 * product that must never be written to for a test's convenience.
 *
 * So this loads `/login`, which compiles the real `globals.css` and needs no session, and
 * injects the page's own markup into it. What the markup *is* — that the components really
 * compose these classes in this nesting — is what the jsdom suites pin.
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

/** Widths from a wide desktop down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1024, 900, 768, 640, 420];

/** A real SHA-256 digest's worth of characters — what the ledger actually stores. */
const HASH_A = 'a90c3f7e1d2b4c6a8e0f2d4b6c8a0e2f4d6b8a0c2e4f6a8d0b2c4e6f8a0b2d4c';

/** The hash before it in the chain. */
const HASH_B = '4b1e9c02a7f3e5d1b8c6a4f2e0d9c7b5a3f1e8d6c4b2a0f9e7d5c3b1a8f6e4d2';

/**
 * A `Button size="sm"` with no colour pair, as `ui/Button` composes its chrome.
 *
 * The pair is added per variant below rather than layered on top of a default one: the real
 * component runs its classes through `tailwind-merge`, which *drops* the conflicting utility,
 * and a fixture that keeps both gets whichever the generated stylesheet happens to order last
 * — which is how a hand-written fixture invents a contrast failure the product does not have
 * (measured in HIVE-5.3).
 */
const BUTTON_SM =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium ' +
  'h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs';

/** `variant="ghost"`. */
const BUTTON_GHOST = `${BUTTON_SM} text-fg`;

/** `variant="outline"`. */
const BUTTON_OUTLINE = `${BUTTON_SM} bg-surface text-fg shadow-control`;

/** A `Badge`, as `ui/Badge` composes it. */
const BADGE =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full ' +
  'px-[0.4375rem] text-2xs font-semibold leading-none tracking-[0.01em] h-5';

/** `DataTable`'s card, its cells and its header strip, as the primitive composes them. */
const TABLE_CARD = 'table-density overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-sm)]';
const TH_CLASS =
  'sticky top-0 z-1 whitespace-nowrap border-b border-border bg-surface text-left align-middle ' +
  'text-2xs font-semibold tracking-[var(--track-caps)] uppercase text-fg-muted px-3.5';
const TD_CLASS = 'h-[var(--row-h)] border-b border-border align-middle px-3.5';

/** The minimum width `scrollX` puts on the table, which is what makes the wrapper scroll. */
const TABLE_MIN_WIDTH = 'min-w-[48.75rem]';

/** A chevron glyph, standing in for the Lucide one. */
const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<path d="m9 18 6-6-6-6"/></svg>';

/** A lock glyph. */
const LOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

/** One ledger row of the fixture. */
interface RowFixture {
  /** The `id` put on the `<tr>`, so a test can reach it. */
  id: string;
  /** The event's action string. */
  action: string;
  /** Its family's tone, as `auditModel.AUDIT_FAMILY_TONE` resolves it. */
  tone: string;
  /** The actor's label. */
  actor: string;
  /** The Target cell's first line. */
  target: string;
  /** Its second line, from `detail`. */
  sub: string;
  /** The Source badge. */
  source: string;
}

/** One row per family the mockup colours, which is what makes the tones comparable. */
const ROWS: readonly RowFixture[] = [
  {
    id: 'aud-row-role',
    action: 'role.assigned',
    tone: 'orange',
    actor: 'ada@example.com',
    target: 'linus@example.com',
    sub: 'role: Release manager',
    source: 'web',
  },
  {
    id: 'aud-row-permission',
    action: 'permission.changed',
    tone: 'rose',
    actor: 'ada@example.com',
    target: 'Release manager',
    sub: 'granted: versions:publish · revoked: versions:create',
    source: 'web',
  },
  {
    id: 'aud-row-member',
    action: 'member.invited',
    tone: 'accent',
    actor: 'grace@example.com',
    target: 'margaret@example.com',
    sub: 'user_id: usr-margaret · role: Viewer',
    source: 'web',
  },
  {
    id: 'aud-row-admin',
    action: 'admin.override',
    tone: 'violet',
    actor: 'operator@apiome.dev',
    target: 'mcp.anonymous_calls',
    sub: 'reason: OPS-2291',
    source: 'admin',
  },
  {
    id: 'aud-row-sso',
    action: 'sso.login',
    tone: 'ok',
    actor: 'sso:okta',
    target: 'linus@example.com',
    sub: 'idp_group: engineering',
    source: 'web',
  },
  {
    id: 'aud-row-style',
    action: 'style_guide.rules_updated',
    tone: 'honey',
    actor: 'grace@example.com',
    target: 'Acme REST',
    sub: 'severities: 3',
    source: 'api',
  },
];

/**
 * One `<tr>` of the ledger.
 *
 * @param row See {@link RowFixture}.
 * @returns The row markup.
 */
function ledgerRow(row: RowFixture): string {
  return `
  <tr id="${row.id}" class="group transition-colors">
    <td class="${TD_CLASS}"><span class="aud-when mono">Aug 15, 2026, 09:41 AM</span></td>
    <td class="${TD_CLASS}">
      <span class="aud-actor">
        <span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center rounded-full size-5 text-2xs font-semibold bg-accent-soft text-accent-fg">AL</span>
        <span class="aud-actor__label mono">${row.actor}</span>
      </span>
    </td>
    <td class="${TD_CLASS}">
      <span id="${row.id}-badge" class="${BADGE} mono font-medium bg-${row.tone}-soft text-${row.tone}-fg">${row.action}</span>
    </td>
    <td class="${TD_CLASS}">
      <div class="aud-target">
        <span class="aud-target__main">${row.target}</span>
        <div class="mt-px text-xs text-fg-muted aud-target__sub">${row.sub}</div>
      </div>
    </td>
    <td class="${TD_CLASS}"><span class="${BADGE} bg-transparent text-fg-muted shadow-control">${row.source}</span></td>
    <td class="${TD_CLASS} text-right">
      <div data-row-actions="" class="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <button type="button" class="${BUTTON_GHOST} px-1.5" aria-label="Open ${row.action}">${CHEVRON}</button>
      </div>
    </td>
  </tr>`;
}

/** The table card: toolbar, the scrolling wrapper, the table, the foot. */
const TABLE_MARKUP = `
<div class="flex flex-col gap-3" id="aud-table">
  <div class="${TABLE_CARD}">
    <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
      <div class="relative flex items-center">
        <input type="search" aria-label="Search audit events" placeholder="Search actor, event, target…"
               class="hive-control h-[var(--control-h-sm)] w-[16.25rem] max-w-full rounded-sm bg-surface pl-8 pr-2 text-sm text-fg" />
      </div>
      <button type="button" aria-pressed="true" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-fg text-surface">All events <span class="tabular-nums">128</span></button>
      <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]">Role changes <span class="tabular-nums text-fg-muted">31</span></button>
      <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]">Permissions <span class="tabular-nums text-fg-muted">44</span></button>
      <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]">Style guides <span class="tabular-nums text-fg-muted">6</span></button>
      <span aria-hidden="true" class="flex-1"></span>
      <select class="hive-control aud-range" aria-label="Date range" id="aud-range">
        <option value="30d">Last 30 days</option>
        <option value="all">All time</option>
      </select>
    </div>

    <div class="overflow-x-auto" id="aud-scroll" tabindex="0" role="region" aria-label="Access and permission events for this workspace">
      <table class="w-full border-separate border-spacing-0 text-sm text-fg ${TABLE_MIN_WIDTH}">
        <caption class="sr-only">Access and permission events for this workspace</caption>
        <thead>
          <tr>
            <th scope="col" class="${TH_CLASS}">When</th>
            <th scope="col" class="${TH_CLASS}">Actor</th>
            <th scope="col" class="${TH_CLASS}">Event</th>
            <th scope="col" class="${TH_CLASS}">Target</th>
            <th scope="col" class="${TH_CLASS}">Source</th>
            <th scope="col" class="${TH_CLASS} text-right"><span class="sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>${ROWS.map(ledgerRow).join('')}</tbody>
      </table>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 text-xs text-fg-muted">
      <span class="aud-foot-count">Showing 1–6 of 128 events · newest first</span>
      <nav aria-label="Audit pages" class="inline-flex items-center gap-0.5">
        <button type="button" class="${BUTTON_GHOST} px-1.5" aria-label="Previous page" disabled>${CHEVRON}</button>
        <button type="button" class="${BUTTON_OUTLINE} min-w-7 px-1.5 tabular-nums" aria-current="page" aria-label="Page 1">1</button>
        <button type="button" class="${BUTTON_GHOST} px-1.5" aria-label="Next page">${CHEVRON}</button>
      </nav>
    </div>
  </div>
</div>`;

/** The page: the header block, the table and the compliance footnote. */
const PAGE_MARKUP = `
<div class="page">
  <header class="page-header">
    <div class="page-header__row">
      <div class="min-w-0">
        <h1 class="page-title">Access audit</h1>
        <p class="page-desc">Immutable record of every access &amp; permission change.</p>
      </div>
      <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
        <a class="${BUTTON_OUTLINE}" href="#" id="aud-export">Export CSV</a>
      </div>
    </div>
  </header>
  <div class="page-body">
    ${TABLE_MARKUP}
    <p class="aud-note" id="aud-note">${LOCK}<span>Entries are append-only and hash-chained; they cannot be edited or deleted, satisfying SOC 2 / ISO 27001 access-review evidence.</span></p>
  </div>
</div>`;

/** The event drawer, as the sheet composes it. Mounted on its own so it can be measured. */
const DRAWER_MARKUP = `
<div class="page">
  <div class="page-body">
    <div class="hive-drawer flex h-[40rem] w-full max-w-[42.5rem] flex-col bg-surface text-fg shadow-lg" id="aud-drawer" role="dialog" aria-label="role.assigned">
      <div class="flex shrink-0 flex-row items-start gap-3 border-b border-border px-5 py-4 pr-12 text-left">
        <div class="min-w-0 flex-1">
          <h2 class="aud-drawer-title text-base font-semibold">
            <span class="${BADGE} h-6 px-[0.5625rem] text-xs mono font-medium bg-orange-soft text-orange-fg">role.assigned</span>
            <span class="aud-drawer-id mono" id="aud-drawer-id">evt-01j5r7q8zx3m4n5p6q7r8s9t0v</span>
          </h2>
          <p class="aud-drawer-when">Aug 15, 2026, 09:41:07 AM UTC · 2 hours ago</p>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-6" id="aud-drawer-body">
        <p class="aud-callout">ada@example.com assigned a role to linus@example.com from the web console.</p>

        <section>
          <h3 class="aud-caps mb-2">Actor</h3>
          <div class="aud-party">
            <span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center rounded-full size-8 text-xs font-semibold bg-accent-soft text-accent-fg">AL</span>
            <span class="aud-party__text">
              <span class="aud-party__name">ada@example.com</span>
              <span class="aud-party__meta mono">usr-01a9f3c2-4d5e-6f70-8192-a3b4c5d6e7f8</span>
            </span>
            <span class="${BADGE} bg-transparent text-fg-muted shadow-control">web</span>
          </div>
        </section>

        <section>
          <h3 class="aud-caps mb-2">Target</h3>
          <div class="aud-party">
            <span class="tnt-icon-tile" data-tone="honey">${LOCK}</span>
            <span class="aud-party__text">
              <span class="aud-party__name">linus@example.com</span>
              <span class="aud-change" id="aud-change">
                <span class="aud-change__before">versions:create</span>
                <span class="aud-change__after">versions:publish</span>
              </span>
            </span>
          </div>
        </section>

        <section>
          <h3 class="aud-caps mb-2">Recorded detail</h3>
          <dl class="aud-kv" id="aud-kv">
            <dt class="mono">role</dt><dd>Release manager</dd>
            <dt class="mono">role_id</dt><dd>role-7d21ac9e-1f2b-3c4d-5e6f-708192a3b4c5</dd>
          </dl>
        </section>

        <section>
          <h3 class="aud-caps mb-2">Hash chain</h3>
          <div class="aud-chain">
            <div class="aud-chain__row">
              <span class="aud-chain__label">Previous entry</span>
              <code class="aud-hash" id="aud-hash-prev">${HASH_B}</code>
            </div>
            <div class="aud-chain__row">
              <span class="aud-chain__label">This entry</span>
              <code class="aud-hash" id="aud-hash-self">${HASH_A}</code>
            </div>
          </div>
          <p class="aud-chain__note" data-tone="ok" id="aud-chain-note">${LOCK}Verified against the entry written before it.</p>
        </section>

        <section>
          <h3 class="aud-caps mb-2">Event JSON</h3>
          <div class="aud-json-head">
            <span class="aud-quiet">The entry exactly as the ledger stores it.</span>
            <button type="button" class="${BUTTON_GHOST}" aria-label="Copy the event JSON">Copy</button>
          </div>
          <pre class="aud-json mono" id="aud-json" tabindex="0" role="region" aria-label="JSON for event evt-01j5r7q">${JSON.stringify(
            {
              id: 'evt-01j5r7q8zx3m4n5p6q7r8s9t0v',
              action: 'role.assigned',
              actor_label: 'ada@example.com',
              target: 'linus@example.com',
              detail: { role: 'Release manager', permissions: Array.from({ length: 30 }, (_, i) => `resource${i}:action`) },
              prev_hash: HASH_B,
              entry_hash: HASH_A,
            },
            null,
            2
          )}</pre>
        </section>
      </div>

      <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
        <span class="aud-readonly">${LOCK}Read-only · append-only ledger</span>
        <a class="${BUTTON_OUTLINE}" href="#">Open roles</a>
      </div>
    </div>
  </div>
</div>`;

/**
 * Put markup on a page that has the real stylesheet compiled.
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
 * One element's computed value for one property.
 *
 * @param page The Playwright page.
 * @param selector What to measure.
 * @param property The CSS property.
 * @returns The computed value.
 */
function computed(page: Page, selector: string, property: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate(
      (node, prop) => getComputedStyle(node as Element).getPropertyValue(prop as string),
      property
    );
}

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the audit page keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, PAGE_MARKUP);
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const theme of THEMES) {
    test(`does not scroll sideways in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, PAGE_MARKUP);
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    for (const density of ['comfortable', 'compact']) {
      test(`does not scroll sideways at the ${fontScale} scale, ${density}`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, PAGE_MARKUP);
        await applyPreferences(page, { fontScale, density });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  test('scrolls the table inside its own wrapper when six columns will not fit', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, PAGE_MARKUP);

    // The wrapper takes the overflow…
    expect(
      await page.locator('#aud-scroll').evaluate((node) => node.scrollWidth > node.clientWidth + 1)
    ).toBe(true);
    // …and the document does not.
    expect(await documentOverflows(page)).toBe(false);
  });

  test('gives that scroll container a name and a place in the tab order', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, PAGE_MARKUP);
    // WCAG 2.1.1: a region that scrolls must be reachable without a pointer.
    await expect(page.locator('#aud-scroll')).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#aud-scroll')).toHaveAttribute('aria-label', /Access and permission/);
  });
});

/* -------------------------------------------------------------------------
   The event badges are told apart
   ------------------------------------------------------------------------- */

test.describe('event badges', () => {
  test('draws a different ground for every family, in every theme', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      const grounds = await Promise.all(
        ROWS.map((row) => computed(page, `#${row.id}-badge`, 'background-color'))
      );
      // "Coloured by action prefix" means the prefixes are told apart. Six families, six
      // grounds — a token that resolved to the same tint in one theme would collapse two.
      expect(new Set(grounds).size).toBe(ROWS.length);
    }
  });

  test('keeps every badge’s ink above 4.5:1 on its own ground, in every theme', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      for (const row of ROWS) {
        const ratio = await page.locator(`#${row.id}-badge`).evaluate((node) => {
          /** `rgb()` / `rgba()` as channels plus alpha. */
          const parse = (value: string): number[] => {
            const parts = (value.match(/[\d.]+/g) ?? []).map(Number);
            return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
          };
          /**
           * The opaque colour actually painted where an element sits.
           *
           * Every `--*-soft` token in a dark theme is a translucent tint, so the computed
           * `background-color` alone is not what the reader sees — it has to be composited
           * over whatever is behind it, or the measurement is nonsense (this is what the
           * first draft of this test got wrong, reading 1.4:1 for a badge that renders at
           * about 6:1).
           */
          const ground = (element: Element): number[] => {
            const stack: number[][] = [];
            for (let node: Element | null = element; node; node = node.parentElement) {
              const colour = parse(getComputedStyle(node).backgroundColor);
              if (colour[3] === 0) continue;
              stack.push(colour);
              if (colour[3] === 1) break;
            }
            // Paper, then each layer painted over it from the back forwards.
            let out = [255, 255, 255];
            for (const layer of stack.reverse()) {
              out = out.map((behind, index) => layer[index] * layer[3] + behind * (1 - layer[3]));
            }
            return out;
          };
          const luminance = ([r, g, b]: number[]): number => {
            const channel = (c: number) => {
              const v = c / 255;
              return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          };
          const style = getComputedStyle(node as Element);
          const behind = ground(node as Element);
          const ink = parse(style.color);
          const painted = behind.map((c, index) => ink[index] * ink[3] + c * (1 - ink[3]));
          const [a, b] = [luminance(painted), luminance(behind)];
          const [light, dark] = a > b ? [a, b] : [b, a];
          return (light + 0.05) / (dark + 0.05);
        });
        expect({ theme: theme ?? 'light', action: row.action, ratio }).toMatchObject({
          theme: theme ?? 'light',
          action: row.action,
        });
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

/* -------------------------------------------------------------------------
   The drawer shows the payload whole
   ------------------------------------------------------------------------- */

test.describe('the event drawer', () => {
  test('wraps a 64-character digest instead of clipping it', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    for (const fontScale of FONT_SCALES) {
      await applyPreferences(page, { fontScale });
      // Every character is inside the box: nothing overflows sideways and nothing is elided.
      expect(
        await page
          .locator('#aud-hash-self')
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
      ).toBe(true);
      expect(await page.locator('#aud-hash-self')).toBeTruthy();
      expect((await page.locator('#aud-hash-self').textContent())?.trim()).toHaveLength(64);
    }
  });

  test('draws the hash in the monospace face, so two digests compare character by character', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);
    expect((await computed(page, '#aud-hash-self', 'font-family')).toLowerCase()).toMatch(/mono/);
  });

  test('scrolls the payload inside its own box, never taking the sheet with it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    // The payload is deep enough to need the scroll…
    expect(
      await page.locator('#aud-json').evaluate((node) => node.scrollHeight > node.clientHeight + 1)
    ).toBe(true);
    // …but the sheet keeps to its own width, and so does the document.
    expect(
      await page
        .locator('#aud-drawer-body')
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
    ).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('shows the payload untruncated — no clamp, no ellipsis', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const text = (await page.locator('#aud-json').textContent()) ?? '';
    expect(text).toContain('resource29:action');
    expect(text).toContain(HASH_A);
    expect(await computed(page, '#aud-json', '-webkit-line-clamp')).not.toMatch(/^\d+$/);
  });

  test('keeps the sheet to one column at every font scale and both densities', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    for (const fontScale of FONT_SCALES) {
      for (const density of ['comfortable', 'compact']) {
        await applyPreferences(page, { fontScale, density });
        expect(await documentOverflows(page)).toBe(false);
        expect(
          await page
            .locator('#aud-drawer-body')
            .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
        ).toBe(true);
      }
    }
  });

  test('stacks the detail list on a narrow sheet rather than squeezing the value', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const columns = await computed(page, '#aud-kv', 'grid-template-columns');
    // One column below the 30rem breakpoint — the term above its value, not beside it.
    expect(columns.split(' ').filter(Boolean)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  for (const theme of THEMES) {
    test(`reports no serious or critical violation on the list in ${theme ?? 'light'}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: DESKTOP_WIDTH, height: 900 },
      });
      const page = await context.newPage();
      await mount(page, PAGE_MARKUP);
      await applyPreferences(page, { theme });

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .include('.page-body')
        .analyze();
      const blocking = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      );
      expect(
        blocking.map(
          (violation) =>
            `${violation.id}: ${violation.help} — ${violation.nodes
              .map((node) => node.target.join(' '))
              .join(' | ')}`
        )
      ).toEqual([]);
      await context.close();
    });
  }

  for (const theme of THEMES) {
    test(`reports no serious or critical violation on the drawer in ${theme ?? 'light'}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: DESKTOP_WIDTH, height: 900 },
      });
      const page = await context.newPage();
      await mount(page, DRAWER_MARKUP);
      await applyPreferences(page, { theme });

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .include('.page-body')
        .analyze();
      const blocking = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      );
      expect(
        blocking.map(
          (violation) =>
            `${violation.id}: ${violation.help} — ${violation.nodes
              .map((node) => node.target.join(' '))
              .join(' | ')}`
        )
      ).toEqual([]);
      await context.close();
    });
  }
});
