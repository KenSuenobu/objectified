import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Members, measured in a browser (HIVE-5.2, #5305).
 *
 * `tests/members-hive-redesign.test.tsx` pins what the page renders, `tests/members-model.test.ts`
 * pins the derivations behind it, and `tests/members-css.test.ts` pins the declarations. None of
 * the three can answer the acceptance criteria that are questions about *computed layout*,
 * because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — and this page is a genuinely hard case, because a
 *     member's email address is arbitrary text with no break opportunity sitting in a table
 *     column beside four more.
 *   • **A pending row is distinguished by a tint, not a fade** — a claim about the computed
 *     `background-color` and the computed `opacity`, which only a browser can settle.
 *   • **The identity cell gives before the table does**: a 90-character address elides rather
 *     than widening the User column past the card.
 *   • **The seat strip and the membership list actually reflow** at the widths their `@media`
 *     rules name, rather than the rules being dead.
 *   • **The role select shrinks inside its column** rather than holding it open at 9.5 rem.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet actually
 *     renders it, which is the only way a token pair that fails contrast is caught.
 *
 * ### Why it injects markup instead of signing in
 *
 * The same reason `hive-tenants.spec.ts` gives. The states worth measuring — an address long
 * enough to break a column, a pending invitation beside an active member and a suspended one,
 * a role with a full permission grid — are precisely the ones a seeded database will not
 * produce on demand, and three of the four reads are tenant-scoped.
 *
 * So this loads `/login`, which compiles the real `globals.css` and needs no session, and
 * injects the page's own markup into it. The fixture is deliberately the worst case
 * throughout. What the markup *is* — that the components really compose these classes in this
 * nesting — is what the jsdom suite pins.
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

/** Widths either side of the two breakpoints this ticket adds (40rem, 30rem), down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1024, 900, 641, 639, 480, 420];

/** An address with no break opportunity, long enough to have no chance of fitting its column. */
const LONG_EMAIL =
  'developer-partner-integrations-emea-and-apac-platform-engineering-oncall-rotation@' +
  'globex-holdings-international-logistics-and-payments-division.example';

/** A display name with the same problem. */
const LONG_NAME = 'Margaret Elizabeth Hamilton-Featherstonehaugh de la Fontaine';

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

/**
 * One member row, as `MembersTable` composes it.
 *
 * @param options.id The row's dom id, so a test can reach it.
 * @param options.name The display name.
 * @param options.email The address.
 * @param options.status The lifecycle state.
 * @param options.admin Whether they administer the tenant.
 * @returns The `<tr>` markup.
 */
function memberRow(options: {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'pending' | 'suspended';
  admin?: boolean;
}): string {
  const { id, name, email, status, admin = false } = options;
  const pending = status === 'pending';
  const statusTint =
    status === 'active' ? 'bg-ok-soft text-ok-fg' : 'bg-warn-soft text-warn-fg';
  const mark = pending
    ? `<span class="mbr-invite-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 7-9 5.7L2 7"/></svg></span>`
    : `<span class="relative inline-grid size-8 shrink-0 place-items-center rounded-full bg-inset text-xs font-semibold text-fg-muted" aria-hidden="true">MH</span>`;

  return `
  <tr class="group ${pending ? 'mbr-row--pending' : ''}" id="${id}">
    <td class="${TD}">
      <div class="mbr-identity" data-member-email="${email}">
        ${mark}
        <span class="mbr-identity__text">
          <span class="mbr-identity__name">${name || email}</span>
          <span class="mbr-identity__sub mono">${pending ? 'Invited Aug 13, 2026' : email}</span>
        </span>
      </div>
    </td>
    <td class="${TD}">
      <span>
        <select class="hive-control mbr-role-select" aria-label="Role for ${name || email}">
          <option>Owner</option><option>Editor</option><option>Release manager</option>
        </select>
      </span>
    </td>
    <td class="${TD}">
      <span class="flex flex-wrap items-center gap-1.5">
        <span class="${BADGE} ${statusTint}"><span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-current"></span>${status[0].toUpperCase()}${status.slice(1)}</span>
        ${admin ? `<span class="${BADGE} bg-violet-soft text-violet-fg">Admin</span>` : ''}
      </span>
    </td>
    <td class="${TD}"><span class="whitespace-nowrap text-sm text-fg-muted tabular-nums">3 hours ago</span></td>
    <td class="${TD}"><span class="whitespace-nowrap text-sm text-fg-muted tabular-nums">Mar 18, 2025</span></td>
    <td class="${TD} text-right">
      <div data-row-actions="" class="flex items-center justify-end gap-0.5">
        <div class="mbr-row-actions">
          ${pending ? `<button type="button" class="${BUTTON_SM} bg-transparent shadow-none">Resend</button>` : ''}
          <button type="button" aria-label="Suspend ${name || email}" class="${BUTTON_SM} bg-transparent shadow-none px-1.5">⏻</button>
          <button type="button" aria-label="Offboard ${name || email}" class="${BUTTON_SM} bg-transparent shadow-none px-1.5">🗑</button>
        </div>
      </div>
    </td>
  </tr>`;
}

/** The page, as `MembersClient` composes it: header, seat card, roster, identity cards. */
const PAGE_MARKUP = `
<div class="page" id="mbr-probe">
  <header class="page-header">
    <div class="page-header__inner">
      <div class="page-header__row">
        <div class="flex items-start">
          <div class="min-w-0">
            <nav aria-label="Breadcrumb" class="page-header__crumbs mb-1.5 text-xs text-fg-muted">
              <ol class="flex flex-wrap items-center gap-1.5"><li>Home</li><li>Workspace</li><li>Members</li></ol>
            </nav>
            <h1 class="page-header__title"><span class="min-w-0 break-words">Members</span></h1>
            <p class="page-header__desc">Who can sign in to this workspace, and what they may do.</p>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
          <span class="text-xs text-fg-muted">5 members · 1 pending</span>
          <button type="button" class="${BUTTON_SM}">Roles</button>
          <button type="button" class="${BUTTON_SM}">Invite member</button>
        </div>
      </div>
    </div>
  </header>

  <div class="page-body">
    <section id="mbr-seats" class="rounded-lg bg-surface p-4 shadow-[inset_0_0_0_1px_var(--border)]">
      <div class="mbr-seat-strip">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="size-[var(--icon-dense)] shrink-0 text-fg-muted"><circle cx="12" cy="8" r="4"/></svg>
            <h2 class="text-sm font-semibold text-fg">Member seats</h2>
            <span class="${BADGE} bg-surface text-fg-muted">Team plan</span>
          </div>
          <div class="mt-2">
            <div role="meter" aria-label="Member seats used" aria-valuenow="4" aria-valuemin="0" aria-valuemax="5" aria-valuetext="4 of 5 seats used" class="flex items-center gap-2 text-warn">
              <span class="hive-progress relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-inset"><span class="hive-progress__fill block h-full rounded-full" style="width:80%"></span></span>
            </div>
            <p class="mt-1 text-xs text-fg-muted">4 of 5 seats used · a pending invitation holds its seat until it is accepted or cancelled.</p>
          </div>
        </div>
        <p class="mbr-seat-figure text-warn-fg" id="mbr-seat-figure">4 of 5 seats used</p>
      </div>
    </section>

    <div class="table-density overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-sm)]">
      <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <input type="search" aria-label="Filter members" placeholder="Filter by name or email…"
               class="hive-control h-[var(--control-h-sm)] w-[16.25rem] max-w-full rounded-sm pl-8 text-sm" />
        <button type="button" aria-pressed="true" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-fg text-surface">All <span class="text-fg-faint">5</span></button>
        <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted">Pending <span class="text-fg-faint">1</span></button>
        <span aria-hidden="true" class="flex-1"></span>
      </div>
      <div class="overflow-x-auto" tabindex="0" role="region" aria-label="Members of this workspace" id="mbr-scroll">
        <table class="w-full border-separate border-spacing-0 text-sm text-fg min-w-[48.75rem]">
          <caption class="sr-only">Members of this workspace</caption>
          <thead>
            <tr>
              <th scope="col" class="${TH}">User</th>
              <th scope="col" class="${TH}">Role</th>
              <th scope="col" class="${TH}">Status</th>
              <th scope="col" class="${TH}">Last active</th>
              <th scope="col" class="${TH}">Joined</th>
              <th scope="col" class="${TH} text-right"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${memberRow({ id: 'mbr-row-active', name: LONG_NAME, email: 'grace@acme.io', status: 'active', admin: true })}
            ${memberRow({ id: 'mbr-row-suspended', name: 'Margaret Hamilton', email: 'margaret@acme.io', status: 'suspended' })}
            ${memberRow({ id: 'mbr-row-pending', name: '', email: LONG_EMAIL, status: 'pending' })}
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 text-xs text-fg-muted">
        <span>5 people · 3 active · 1 pending · 1 suspended</span>
      </div>
    </div>

    <section id="mbr-idp">
      <div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 class="text-base font-semibold text-fg">Identity provider</h2>
        <p class="text-sm text-fg-muted">Enterprise identity features — coming soon</p>
      </div>
      <div class="mbr-idp-grid">
        <article class="mbr-idp-card">
          <div class="flex items-start gap-3">
            <span class="tnt-icon-tile" data-tone="honey"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20"/></svg></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-sm font-semibold text-fg">Single Sign-On (OIDC/SAML)</h3>
                <span class="${BADGE} bg-honey-soft text-honey-fg">Coming soon</span>
              </div>
            </div>
          </div>
          <p class="mbr-idp-card__desc">Enforce sign-in through your identity provider and map IdP groups to Apiome roles.</p>
          <div class="flex justify-end"><button type="button" disabled aria-disabled="true" class="${BUTTON_SM}">Configure SSO</button></div>
        </article>
        <article class="mbr-idp-card">
          <div class="flex items-start gap-3">
            <span class="tnt-icon-tile" data-tone="accent"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20"/></svg></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-sm font-semibold text-fg">SCIM 2.0 provisioning</h3>
                <span class="${BADGE} bg-honey-soft text-honey-fg">Coming soon</span>
              </div>
            </div>
          </div>
          <p class="mbr-idp-card__desc">Automatically create, update, and deactivate members from your identity provider.</p>
          <div class="flex justify-end"><button type="button" disabled aria-disabled="true" class="${BUTTON_SM}">Enable SCIM</button></div>
        </article>
      </div>
    </section>
  </div>
</div>`;

/** The detail drawer, as `MemberDetailDrawer` composes it. */
const DRAWER_MARKUP = `
<div class="fixed inset-0 z-[9998] bg-overlay backdrop-blur-sm" aria-hidden="true"></div>
<div role="dialog" aria-label="${LONG_NAME}" id="mbr-drawer"
     class="hive-drawer fixed inset-y-0 right-0 z-[9999] flex h-full w-full flex-col bg-surface text-fg shadow-lg max-w-[32.5rem]">
  <div class="flex shrink-0 flex-row items-center gap-3 border-b border-border px-5 py-4 pr-12 text-left">
    <span class="relative inline-grid size-11 shrink-0 place-items-center rounded-full bg-inset text-base font-semibold text-fg-muted" aria-hidden="true">MH</span>
    <div class="min-w-0 flex-1">
      <h2 class="truncate text-lg font-semibold leading-snug text-fg">${LONG_NAME}</h2>
      <p class="truncate font-mono text-xs text-fg-muted">${LONG_EMAIL}</p>
    </div>
  </div>

  <div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4" id="mbr-drawer-body">
    <div class="flex flex-wrap items-center gap-2">
      <span class="${BADGE} bg-ok-soft text-ok-fg">Active</span>
      <span class="${BADGE} bg-surface text-fg-muted">Editor</span>
      <span class="${BADGE} bg-violet-soft text-violet-fg">Admin</span>
    </div>

    <section>
      <h3 class="mbr-caps mb-2">Membership</h3>
      <dl class="mbr-kv" id="mbr-kv">
        <dt>Role</dt>
        <dd><select class="hive-control mbr-role-select" aria-label="Role for ${LONG_NAME}"><option>Editor</option></select></dd>
        <dt>Status</dt><dd>Active since Mar 18, 2025</dd>
        <dt>Last active</dt><dd>3 hours ago</dd>
        <dt>Joined</dt><dd>Mar 18, 2025</dd>
        <dt>Two-factor</dt><dd><span class="${BADGE} bg-ok-soft text-ok-fg">Enabled</span></dd>
        <dt>User id</dt><dd><span class="font-mono text-xs" id="mbr-user-id">5d21ab6c-9f42-4e18-b7a3-0c1d2e3f4a5b</span></dd>
      </dl>
    </section>

    <section>
      <h3 class="mbr-caps mb-2">Effective permissions</h3>
      <div class="flex flex-wrap gap-1" id="mbr-tags">
        <span class="mbr-tag">projects:view</span><span class="mbr-tag">projects:edit</span>
        <span class="mbr-tag">versions:create</span><span class="mbr-tag">versions:edit</span>
        <span class="mbr-tag">verification_evidence:publish</span>
        <span class="text-xs text-fg-muted">+6 more</span>
      </div>
      <p class="mt-2 text-xs text-fg-muted">From role <a class="text-accent-fg underline underline-offset-2" href="#">Editor</a>. Change the role to change permissions.</p>
    </section>

    <section>
      <h3 class="mbr-caps mb-2">Recent access activity</h3>
      <div id="mbr-activity">
        <div class="mbr-activity"><span class="mbr-activity__action">verification_evidence.compare_against_published_baseline</span><span class="mbr-activity__when">3 hours ago</span></div>
        <div class="mbr-activity"><span class="mbr-activity__action">role.assigned</span><span class="mbr-activity__when">Yesterday</span></div>
      </div>
    </section>
  </div>

  <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
    <button type="button" class="${BUTTON_SM} mr-auto bg-danger-soft text-danger-fg shadow-none">Offboard</button>
    <button type="button" class="${BUTTON_SM}">Suspend</button>
    <a class="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent-fg" href="#">Audit trail</a>
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
    const doc = document.documentElement;
    // A one-pixel tolerance: sub-pixel layout rounding is not a horizontal scrollbar.
    return doc.scrollWidth - doc.clientWidth > 1;
  });
}

/* -------------------------------------------------------------------------
   No horizontal document scroll, in every appearance
   ------------------------------------------------------------------------- */

test.describe('the members page keeps the document to one column', () => {
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
      test(`does not scroll sideways at font scale ${fontScale}, ${density}`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, PAGE_MARKUP);
        await applyPreferences(page, { fontScale, density });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  test('lets the table scroll inside its own card rather than taking the page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, PAGE_MARKUP);

    expect(await documentOverflows(page)).toBe(false);
    // The card's own region is where the six columns overflow to — `scrollX` on `DataTable`.
    expect(
      await page
        .locator('#mbr-scroll')
        .evaluate((node) => node.scrollWidth > node.clientWidth + 1)
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------
   The identity cell gives before the table does
   ------------------------------------------------------------------------- */

test.describe('the identity cell', () => {
  test('elides a 90-character address rather than widening its column', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    // The pending row's *name* is the address — an invitation often has no display name yet —
    // and the active row's sub-line is the one that carries an address. Both are checked,
    // because they are two different rules (`__name` and `__sub`) in the stylesheet.
    const overflowing = (selector: string) =>
      page.locator(selector).evaluate((node) => node.scrollWidth > node.clientWidth + 1);

    // Overflowing its own box is the *point*: that is what `text-overflow: ellipsis` needs.
    expect(await overflowing('#mbr-row-pending .mbr-identity__name')).toBe(true);
    expect(await overflowing('#mbr-row-active .mbr-identity__name')).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('keeps every row’s User column the same width, long name or not', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    const widths = await page
      .locator('#mbr-probe tbody tr')
      .evaluateAll((rows) =>
        rows.map((row) => Math.round(row.children[0].getBoundingClientRect().width))
      );
    expect(new Set(widths).size).toBe(1);
  });

  test('lets the role select shrink instead of holding its column at 9.5rem', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, PAGE_MARKUP);
    await applyPreferences(page, { fontScale: '2xl' });

    const select = page.locator('#mbr-row-active select');
    const cell = page.locator('#mbr-row-active td').nth(1);
    const [selectWidth, cellWidth] = await Promise.all([
      select.evaluate((node) => node.getBoundingClientRect().width),
      cell.evaluate((node) => node.getBoundingClientRect().width),
    ]);
    expect(selectWidth).toBeLessThanOrEqual(cellWidth + 1);
  });
});

/* -------------------------------------------------------------------------
   A pending row is tinted, never faded
   ------------------------------------------------------------------------- */

test.describe('how a pending invitation is distinguished', () => {
  test('carries a tint an active row does not, and no opacity at all', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    const read = (selector: string) =>
      page.locator(selector).evaluate((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, opacity: style.opacity };
      });

    const pending = await read('#mbr-row-pending');
    const active = await read('#mbr-row-active');

    expect(pending.background).not.toBe(active.background);
    // The measured rule of HIVE-4.8: a fade dims the words with the mark.
    expect(pending.opacity).toBe('1');
    expect(await read('#mbr-row-suspended').then((row) => row.opacity)).toBe('1');
  });

  test('paints the envelope mark from the warn pair in every theme', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      const [mark, warnSoft] = await Promise.all([
        page
          .locator('#mbr-row-pending .mbr-invite-mark')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--warn-soft').trim()
        ),
      ]);
      expect({ theme, painted: mark.length > 0 }).toEqual({ theme, painted: true });
      expect({ theme, declared: warnSoft.length > 0 }).toEqual({ theme, declared: true });
    }
  });
});

/* -------------------------------------------------------------------------
   The responsive rules are alive
   ------------------------------------------------------------------------- */

test.describe('the reflows', () => {
  test('stacks the seat strip below 40rem rather than squeezing its figure', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, PAGE_MARKUP);

    const columnsAt = () =>
      page
        .locator('.mbr-seat-strip')
        .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);

    expect(await columnsAt()).toBe(2);
    await page.setViewportSize({ width: 480, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await columnsAt()).toBe(1);
  });

  test('stacks the membership list below 30rem', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const columnsAt = () =>
      page
        .locator('#mbr-kv')
        .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);

    expect(await columnsAt()).toBe(2);
    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await columnsAt()).toBe(1);
  });

  test('reflows the identity-provider cards on a phone instead of overflowing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, PAGE_MARKUP);

    const columns = await page
      .locator('.mbr-idp-grid')
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(1);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The drawer
   ------------------------------------------------------------------------- */

test.describe('the detail drawer', () => {
  test('keeps a long id and a long ledger action inside the sheet', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    const sheet = await page
      .locator('#mbr-drawer')
      .evaluate((node) => node.getBoundingClientRect().width);

    for (const selector of ['#mbr-user-id', '#mbr-activity .mbr-activity__action']) {
      const width = await page
        .locator(selector)
        .first()
        .evaluate((node) => node.getBoundingClientRect().width);
      expect(width).toBeLessThanOrEqual(sheet);
    }
    expect(await documentOverflows(page)).toBe(false);
  });

  test('does not scroll the document sideways at any font scale', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);

    for (const fontScale of FONT_SCALES) {
      await applyPreferences(page, { fontScale });
      expect({ fontScale, overflows: await documentOverflows(page) }).toEqual({
        fontScale,
        overflows: false,
      });
    }
  });

  test('wraps the permission tags rather than letting one widen the sheet', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);
    await applyPreferences(page, { fontScale: '2xl' });

    const rows = await page.locator('#mbr-tags').evaluate((node) => {
      const tops = [...node.children].map((child) => Math.round(child.getBoundingClientRect().top));
      return new Set(tops).size;
    });
    expect(rows).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('axe', () => {
  for (const theme of [null, 'dark']) {
    test(`reports no serious or critical violation on the page in ${theme ?? 'light'}`, async ({
      browser,
    }) => {
      // `@axe-core/playwright` refuses a page opened straight from `browser.newPage()`.
      const context = await browser.newContext({
        viewport: { width: DESKTOP_WIDTH, height: 900 },
      });
      const page = await context.newPage();
      await mount(page, PAGE_MARKUP);
      await applyPreferences(page, { theme });

      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .include('#mbr-probe')
        .analyze();
      const blocking = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      );
      expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
      await context.close();
    });

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
        .include('#mbr-drawer')
        .analyze();
      const blocking = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      );
      expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
      await context.close();
    });
  }
});
