import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Profile's layout, measured in a browser (HIVE-4.7, #5301).
 *
 * `tests/profile-hive-redesign.test.tsx` pins what the page renders and `tests/profile-css.test.ts`
 * pins the declarations behind it. Neither can answer the acceptance criteria that are questions
 * about *computed layout*, because jsdom compiles no CSS and has no scroll:
 *
 *   • **"Long email addresses and tenant ids truncate without breaking layout."** The only honest
 *     check is to put a 64-character unbroken address in the tile and measure whether the tile,
 *     its card and the document all stayed where they were.
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both densities
 *     and all six font scales — every one of which swaps a spacing or type token the grid is laid
 *     out from.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet actually
 *     renders it, which is the only way a token pair that fails contrast can be caught.
 *
 * ### Why it injects markup instead of signing in
 *
 * Profile *is* the reader's own account — its content is a session, a membership context and a
 * two-factor enrolment — so the obvious spec would sign in and read `/ade/dashboard/profile`. That
 * spec would measure whatever the seeded user happens to have, and the interesting cases (an
 * address too long to fit, a workspace whose name runs past the tile) are precisely the ones a
 * fixed database will not produce.
 *
 * So this suite does what `hive-home.spec.ts` and `rem-audit.spec.ts` do: it loads `/login`, which
 * compiles the real `globals.css` and needs no session, and injects Profile's own markup into it.
 * The fixture is deliberately the worst case throughout.
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

/** Widths either side of the body grid's breakpoints (1100 px and 768 px), down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1101, 1099, 900, 769, 767, 420];

/** An address with no break opportunity in it — the case the tile's clip is there for. */
const LONG_EMAIL = 'augusta.ada.king.countess.of.lovelace@engineering.example.com';

/** A workspace id of the length the app actually stores. */
const LONG_TENANT_ID = 'ten_01JB8Q4W7Z9K3F5N2M6P8R0T2V4X6Z8B0D2F4H6J8L0N2Q4S6U8W';

/** The card chrome, as `ui/Card` composes it. */
const CARD = 'rounded-lg bg-surface shadow-sm';

/**
 * Profile's body, as the page composes it.
 *
 * Written out rather than rendered because Playwright has no React runtime: the markup a
 * component tree produces is already pinned by the jsdom suite, and what this fixture has to be
 * faithful about is the *class names and nesting* the stylesheet keys off.
 */
const PROFILE_MARKUP = `
<div class="page" id="profile-probe">
  <header class="page-header page-header--with-tabs">
    <div class="page-header__inner">
      <div class="page-header__row">
        <div class="flex items-start">
          <div class="min-w-0">
            <nav aria-label="Breadcrumb" class="page-header__crumbs mb-1.5 text-xs text-fg-muted">
              <ol class="flex flex-wrap items-center gap-1.5"><li>Acme Corp</li><li>Account</li><li>Profile</li></ol>
            </nav>
            <h1 class="page-header__title"><span class="min-w-0 break-words">Profile</span></h1>
            <p class="page-header__desc">Your identity, password, two-factor and sign-in methods.</p>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
          <button type="button" class="inline-flex shrink-0 items-center gap-2 rounded-md bg-surface px-3 text-sm font-medium text-fg shadow-control h-[var(--control-h)]">Edit name</button>
        </div>
      </div>
      <nav aria-label="Account" class="flex flex-wrap items-end gap-0.5 border-b border-border">
        <a href="#" aria-current="page" class="-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-sm border-b-2 border-fg text-fg font-medium min-h-[var(--control-h)] px-3 py-1.5 text-sm">Profile</a>
        <a href="#" class="-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-sm border-b-2 border-transparent text-fg-muted font-medium min-h-[var(--control-h)] px-3 py-1.5 text-sm">Linked accounts</a>
        <button type="button" class="-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-sm border-b-2 border-transparent text-fg-muted font-medium min-h-[var(--control-h)] px-3 py-1.5 text-sm">Preferences</button>
      </nav>
    </div>
  </header>

  <div class="page-body">
    <section class="${CARD} acct-identity" aria-label="Identity">
      <div class="acct-identity__band"></div>
      <div class="acct-identity__row">
        <span class="avatar-hex acct-identity__avatar inline-grid place-items-center size-18 bg-inset text-2xl font-semibold" aria-hidden="true">AL</span>
        <div class="acct-identity__body">
          <h2 class="acct-identity__name">Augusta Ada King, Countess of Lovelace</h2>
          <div class="acct-identity__meta">
            <span class="acct-identity__email">${LONG_EMAIL}</span>
            <span class="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-[0.4375rem] text-2xs font-semibold text-ok-fg h-5">Tenant active</span>
            <span>Acme Corp · Owner</span>
          </div>
        </div>
        <div class="acct-identity__badges">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-transparent px-[0.5625rem] text-xs font-semibold text-fg-muted h-6 shadow-[inset_0_0_0_1px_var(--border-strong)]">2FA on</span>
        </div>
      </div>
    </section>

    <div class="acct-grid">
      <div class="acct-grid__main">
        <section class="${CARD}" aria-label="Account details">
          <div class="flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)] acct-card__header">
            <h3 class="text-base font-semibold text-fg acct-card__title">Account details</h3>
            <span class="acct-card__note">Your identity and workspace information</span>
          </div>
          <div class="p-[var(--card-pad)]">
            <div class="acct-tiles">
              <div class="acct-tile">
                <div class="acct-tile__label">Full name</div>
                <div class="acct-tile__value"><span class="acct-tile__text">Augusta Ada King, Countess of Lovelace</span><button type="button" class="acct-tile__action inline-flex items-center rounded-sm text-fg-muted h-[var(--control-h-sm)]" aria-label="Edit name">✎</button></div>
              </div>
              <div class="acct-tile">
                <div class="acct-tile__label">Email</div>
                <div class="acct-tile__value"><span class="acct-tile__text">${LONG_EMAIL}</span><span class="inline-flex items-center rounded-full bg-ok-soft px-[0.4375rem] text-2xs font-semibold text-ok-fg h-5">Verified</span></div>
              </div>
              <div class="acct-tile">
                <div class="acct-tile__label">User ID</div>
                <div class="acct-tile__value"><span class="acct-tile__text mono">usr_01JB8Q4W7Z9K3F5N2M6P8R0T2V</span><button type="button" class="acct-tile__action inline-flex items-center rounded-sm text-fg-muted h-[var(--control-h-sm)]" aria-label="Copy User ID">⧉</button></div>
              </div>
              <div class="acct-tile">
                <div class="acct-tile__label">Current tenant</div>
                <div class="acct-tile__value"><span class="acct-tile__text"><span class="acct-tile__tenant"><span class="acct-tile__tenant-name">Acme Corporation International</span><span class="mono acct-tile__tenant-id">${LONG_TENANT_ID}</span></span></span><button type="button" class="acct-tile__action inline-flex items-center rounded-sm text-fg-muted h-[var(--control-h-sm)]" aria-label="Copy Tenant ID">⧉</button></div>
              </div>
              <div class="acct-tile acct-tile--wide">
                <div class="acct-tile__label">Last login</div>
                <div class="acct-tile__value"><span class="acct-tile__text tabular-nums">08/15/26 09:12 AM</span></div>
              </div>
            </div>
          </div>
        </section>

        <section class="${CARD}" aria-label="Security">
          <div class="flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)] acct-card__header">
            <h3 class="text-base font-semibold text-fg acct-card__title">Security</h3>
            <span class="acct-card__note">Password and account security</span>
          </div>
          <div class="p-[var(--card-pad)] acct-section">
            <div class="acct-row">
              <span class="acct-glyph acct-glyph--accent" aria-hidden="true"></span>
              <div class="acct-row__body">
                <div class="acct-row__title">Password</div>
                <p class="acct-row__desc">Use a strong, unique password. Change it periodically or if you suspect it has been compromised.</p>
              </div>
            </div>
            <hr class="acct-rule" />
            <div class="acct-2fa">
              <div class="acct-row">
                <span class="acct-glyph acct-glyph--ok" aria-hidden="true"></span>
                <div class="acct-row__body">
                  <div class="acct-row__title">Authenticator app (TOTP)<span class="inline-flex items-center rounded-full bg-ok-soft px-[0.4375rem] text-2xs font-semibold text-ok-fg h-5">Enabled</span></div>
                  <p class="acct-row__desc">Require a code from Authy or Google Authenticator after your password when signing in.</p>
                </div>
                <button type="button" class="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-surface px-2.5 text-xs font-medium text-fg shadow-control h-[var(--control-h-sm)]">Disable 2FA</button>
              </div>
              <div class="rounded-lg acct-methods">
                <div class="acct-caps">Sign-in methods</div>
                <ul class="acct-methods__list">
                  <li>Authenticator app (TOTP)</li>
                  <li>Email OTP — available at sign-in (no separate enrollment)</li>
                </ul>
              </div>
              <div class="acct-mfa">
                <div class="acct-mfa__box">
                  <div class="acct-mfa__title">Email one-time code</div>
                  <p class="acct-mfa__desc">After your password, you can request a code emailed to your account address instead of (or in addition to) using your authenticator app.</p>
                </div>
                <div class="acct-mfa__box">
                  <div class="acct-mfa__title">Backup codes</div>
                  <p class="acct-mfa__desc">6 remaining</p>
                  <button type="button" class="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-surface px-2.5 text-xs font-medium text-fg shadow-control h-[var(--control-h-sm)]">Regenerate backup codes</button>
                </div>
                <div class="acct-mfa__box">
                  <div class="acct-mfa__title">Trusted device</div>
                  <p class="acct-mfa__desc">This browser is trusted (skips 2FA for ~30 days when signing in).</p>
                  <button type="button" class="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-surface px-2.5 text-xs font-medium text-fg shadow-control h-[var(--control-h-sm)]">Forget this device</button>
                </div>
              </div>
              <div role="alert" class="relative flex w-full items-start gap-2.5 rounded-md px-3.5 py-2.5 text-sm bg-accent-soft text-accent-fg">
                <div class="min-w-0 flex-1"><span class="font-semibold">Recovery.</span> Store backup codes somewhere safe.</div>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-3 border-t border-border px-[var(--card-pad)] py-3 text-sm text-fg-muted acct-card__footer">
            <button type="button" class="inline-flex w-full items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-medium text-ink-fg shadow-control-solid h-[var(--control-h)]">Change password</button>
          </div>
        </section>
      </div>

      <aside class="acct-grid__aside" aria-label="Sign-in methods and session">
        <section class="${CARD}" aria-label="Sign-in methods">
          <div class="flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)] acct-card__header">
            <h3 class="text-base font-semibold text-fg acct-card__title">Sign-in methods</h3>
            <span class="acct-card__note">Linked identity providers</span>
          </div>
          <div class="p-[var(--card-pad)]">
            <p class="acct-prose">Link providers like GitHub, GitLab, or Microsoft for single sign-on, and manage or unlink them at any time.</p>
            <ul class="acct-signin">
              <li class="acct-signin__row">
                <span class="acct-glyph acct-glyph--sm" aria-hidden="true"></span>
                <span class="acct-signin__body"><span class="acct-signin__name">Password</span><span class="acct-signin__sub">Set</span></span>
                <span class="inline-flex shrink-0 items-center rounded-full bg-ok-soft px-[0.4375rem] text-2xs font-semibold text-ok-fg h-5">Active</span>
              </li>
              <li class="acct-signin__row">
                <span class="acct-glyph acct-glyph--sm" aria-hidden="true"></span>
                <span class="acct-signin__body"><span class="acct-signin__name">GitHub</span><span class="acct-signin__sub">${LONG_EMAIL}</span></span>
                <span class="inline-flex shrink-0 items-center rounded-full bg-ok-soft px-[0.4375rem] text-2xs font-semibold text-ok-fg h-5">Linked</span>
              </li>
            </ul>
          </div>
          <div class="flex items-center gap-3 border-t border-border px-[var(--card-pad)] py-3 text-sm text-fg-muted acct-card__footer">
            <a href="#" class="inline-flex w-full items-center justify-center gap-2 rounded-sm bg-surface px-2.5 text-xs font-medium text-fg shadow-control h-[var(--control-h-sm)]">Manage linked accounts</a>
          </div>
        </section>

        <section class="${CARD}" aria-label="Session">
          <div class="flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)] acct-card__header">
            <h3 class="text-base font-semibold text-fg acct-card__title">Session</h3>
            <span class="acct-card__note">Your current sign-in session</span>
          </div>
          <div class="p-[var(--card-pad)] acct-session">
            <div class="acct-caps">Expires</div>
            <p class="acct-session__value">8/22/2026, 9:12:00 AM</p>
            <p class="acct-session__date">Saturday, August 22, 2026</p>
            <div class="acct-session__meter">
              <div role="meter" aria-label="Session time used" aria-valuemin="0" aria-valuemax="30" aria-valuenow="23" aria-valuetext="23 of 30 (77%)" data-tone="warn" class="hive-meter">
                <div data-tone="warn" class="hive-progress hive-meter__track text-warn" style="--progress-value: 77%"><span class="hive-progress__fill"></span></div>
              </div>
              <span class="acct-session__left">7d left of 30</span>
            </div>
            <p class="acct-session__device">Chrome on macOS</p>
          </div>
          <div class="flex items-center gap-3 border-t border-border px-[var(--card-pad)] py-3 text-sm text-fg-muted acct-card__footer">
            <button type="button" class="inline-flex items-center gap-1.5 rounded-sm bg-transparent px-2.5 text-xs font-medium text-fg-muted h-[var(--control-h-sm)]">Sign out everywhere</button>
          </div>
        </section>
      </aside>
    </div>

    <!-- The Change password dialog's body. Kept in the page rather than opened, because what is
         under test is the requirements list, the strength row and the fields inside it — and
         because a scan of a portalled dialog would not be inside the probe. -->
    <section class="${CARD} p-6" id="profile-password-probe" aria-label="Change password">
      <div class="acct-dialog__body">
        <div role="alert" class="relative flex w-full items-start gap-2.5 rounded-md px-3.5 py-2.5 text-sm bg-accent-soft text-accent-fg">
          <div class="min-w-0 flex-1">
            <span class="block font-semibold">Password requirements</span>
            <ul class="acct-reqs">
              <li data-met="true">At least 8 characters</li>
              <li data-met="true">One uppercase and one lowercase letter</li>
              <li data-met="false">One number or special character</li>
            </ul>
          </div>
        </div>
        <div class="acct-field">
          <label for="probe-new" class="text-sm font-medium text-fg">New password</label>
          <input id="probe-new" type="password" class="hive-control flex w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg h-[var(--control-h)]" value="secret" readonly />
          <div class="acct-strength" aria-hidden="true">
            <div data-tone="warn" class="hive-progress text-warn" style="--progress-value: 75%"><span class="hive-progress__fill"></span></div>
            <span class="acct-strength__label">Fair</span>
          </div>
        </div>
        <div class="acct-field">
          <label for="probe-confirm" class="text-sm font-medium text-fg">Confirm new password</label>
          <input id="probe-confirm" type="password" class="hive-control flex w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg h-[var(--control-h)]" value="secret" readonly />
          <p class="acct-hint">Enter on this field submits.</p>
        </div>
      </div>
    </section>

    <!-- The enrolment dialog's second step, laid out as the dialog lays it out. Kept in the
         page rather than opened, because what is under test is the grid inside it. -->
    <section class="${CARD} p-6" id="profile-enroll-probe" aria-label="Enable two-factor authentication">
      <div class="acct-dialog__body">
        <div class="acct-enroll">
          <div class="acct-qr bg-white"><span style="display:block;width:180px;height:180px;background:#111"></span></div>
          <div class="acct-enroll__fields">
            <div class="acct-field">
              <div class="acct-caps">Or enter this URI</div>
              <div class="acct-uri"><code class="mono">otpauth://totp/Apiome:${LONG_EMAIL}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&amp;issuer=Apiome&amp;digits=6&amp;period=30</code><button type="button" class="inline-flex shrink-0 items-center rounded-sm text-fg-muted h-[var(--control-h-sm)] px-2.5" aria-label="Copy URI">⧉</button></div>
            </div>
            <div class="acct-field">
              <label for="probe-code" class="text-sm font-medium text-fg">Authentication code</label>
              <input id="probe-code" class="hive-control acct-code-input mono flex w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg h-[var(--control-h)]" value="000000" readonly />
            </div>
          </div>
        </div>
        <div class="acct-codes-panel">
          <ul class="acct-codes">
            <li>4H7K-2P9Q</li><li>M3XR-8TWA</li><li>Q1ZD-6BNF</li><li>7YCE-3JLS</li>
            <li>K9VU-5HRD</li><li>P2GT-4MXW</li><li>B8NQ-1ZKA</li><li>T6JF-9CYE</li>
          </ul>
          <div class="acct-codes__actions">
            <button type="button" class="inline-flex items-center gap-1.5 rounded-sm bg-surface px-2.5 text-xs font-medium text-fg shadow-control h-[var(--control-h-sm)]">Copy codes</button>
            <button type="button" class="inline-flex items-center gap-1.5 rounded-sm bg-transparent px-2.5 text-xs font-medium text-fg-muted h-[var(--control-h-sm)]">Download .txt</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</div>
`;

/**
 * Load a page that compiles `globals.css` and put Profile's markup in it.
 *
 * @param page The page under test.
 */
async function mountProfile(page: Page): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate((markup) => {
    document.body.innerHTML = `<main>${markup}</main>`;
    document.body.style.margin = '0';
  }, PROFILE_MARKUP);
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

test.describe('Profile layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mountProfile(page);
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

  test('sits the aside beside the main column above the breakpoint and under it below', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    let main = (await page.locator('.acct-grid__main').boundingBox())!;
    let aside = (await page.locator('.acct-grid__aside').boundingBox())!;
    expect(aside.x, 'aside should start after the main column ends').toBeGreaterThan(
      main.x + main.width - 1
    );

    await page.setViewportSize({ width: 900, height: 900 });
    await settle(page);
    main = (await page.locator('.acct-grid__main').boundingBox())!;
    aside = (await page.locator('.acct-grid__aside').boundingBox())!;
    expect(aside.y, 'aside should stack under the main column').toBeGreaterThan(main.y);
    expect(Math.abs(aside.x - main.x), 'stacked columns should share a leading edge').toBeLessThan(
      2
    );
  });

  test('reflows the info tiles two, then one', async ({ page }) => {
    /** How many tiles share the topmost row at this width. */
    const tilesInFirstRow = async () =>
      page.evaluate(() => {
        const tiles = [...document.querySelectorAll('.acct-tile')];
        if (tiles.length === 0) return 0;
        const top = Math.round(tiles[0].getBoundingClientRect().top);
        return tiles.filter(
          (tile) => Math.abs(Math.round(tile.getBoundingClientRect().top) - top) < 2
        ).length;
      });

    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    expect(await tilesInFirstRow()).toBe(2);

    await page.setViewportSize({ width: 420, height: 900 });
    await settle(page);
    expect(await tilesInFirstRow()).toBe(1);
  });

  test('keeps a 64-character address inside its tile at every font scale', async ({ page }) => {
    for (const scale of FONT_SCALES) {
      await applyPreference(page, 'data-font-scale', scale);

      const tile = (await page.locator('.acct-tile').nth(1).boundingBox())!;
      const value = (await page.locator('.acct-tile').nth(1).locator('.acct-tile__text').boundingBox())!;

      // The clip is what keeps it inside; a tile whose text ran past its own right edge would
      // widen the grid track and, through it, the document.
      expect(value.x + value.width, `email at ${scale}`).toBeLessThanOrEqual(tile.x + tile.width + 1);
      expect(await documentOverflow(page), `email at ${scale}`).toBe(0);
    }
    await applyPreference(page, 'data-font-scale', null);
  });

  test('keeps a long tenant id inside its tile, beside its copy button', async ({ page }) => {
    const tile = (await page.locator('.acct-tile').nth(3).boundingBox())!;
    const id = (await page.locator('.acct-tile__tenant-id').boundingBox())!;
    const action = (await page.locator('.acct-tile').nth(3).locator('.acct-tile__action').boundingBox())!;

    expect(id.x + id.width).toBeLessThanOrEqual(tile.x + tile.width + 1);
    // The copy button is the reader's way to the whole id, so it must never be pushed out.
    expect(action.x + action.width).toBeLessThanOrEqual(tile.x + tile.width + 1);
    expect(action.width).toBeGreaterThan(0);
  });

  test('bottom-aligns the buttons across the two-factor boxes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);

    const bottoms = await page
      .locator('.acct-mfa__box button')
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().bottom)));

    expect(bottoms.length).toBeGreaterThan(1);
    // The whole point of `.acct-mfa__desc { flex: 1 }`: three boxes whose descriptions run to
    // different lengths still put their actions on one line.
    for (const bottom of bottoms) expect(Math.abs(bottom - bottoms[0])).toBeLessThan(2);
  });

  test('keeps the enrolment grid and the codes inside the dialog at every font scale', async ({
    page,
  }) => {
    for (const scale of FONT_SCALES) {
      await applyPreference(page, 'data-font-scale', scale);

      const dialog = (await page.locator('#profile-enroll-probe').boundingBox())!;
      for (const selector of ['.acct-enroll', '.acct-codes', '.acct-uri']) {
        const box = (await page.locator(selector).boundingBox())!;
        expect(box.x + box.width, `${selector} at ${scale}`).toBeLessThanOrEqual(
          dialog.x + dialog.width + 1
        );
      }
      expect(await documentOverflow(page), `enrolment at ${scale}`).toBe(0);
    }
    await applyPreference(page, 'data-font-scale', null);
  });

  test('paints the hero band and every icon tile rather than leaving them transparent', async ({
    page,
  }) => {
    const band = await page
      .locator('.acct-identity__band')
      .evaluate((node) => getComputedStyle(node).backgroundImage);
    expect(band).toContain('gradient');

    const glyphs = await page
      .locator('.acct-glyph')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
    expect(glyphs.length).toBeGreaterThan(2);
    for (const background of glyphs) {
      expect(background).not.toBe('rgba(0, 0, 0, 0)');
      expect(background).not.toBe('transparent');
    }
    // Neutral, accent, ok — the roles the cluster actually uses.
    expect(new Set(glyphs).size).toBeGreaterThanOrEqual(3);
  });

  test('has no serious or critical axe violations, in every theme', async ({ page }) => {
    for (const theme of THEMES) {
      await applyPreference(page, 'data-theme', theme);
      const results = await new AxeBuilder({ page })
        .include('#profile-probe')
        .withTags(WCAG_TAGS)
        .analyze();
      expect(blocking(results.violations), `theme ${theme ?? 'light'}`).toEqual([]);
    }
    await applyPreference(page, 'data-theme', null);
  });
});
