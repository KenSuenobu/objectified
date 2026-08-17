import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Linked accounts' layout, measured in a browser (HIVE-4.8, #5302).
 *
 * `tests/linked-accounts-hive-redesign.test.tsx` pins what the page renders,
 * `tests/linked-accounts-model.test.ts` pins the strings and rules behind it, and
 * `tests/linked-accounts-css.test.ts` pins the declarations. None of the three can answer the
 * acceptance criteria that are questions about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — every one of which swaps a token the provider grid and
 *     the table are laid out from.
 *   • **The guard note and the token row stay inside their boxes.** A 64-character handle in a
 *     table cell and a scope list in a 440 px dialog are the two cases with no break opportunity
 *     of their own, and the only honest check is to measure them.
 *   • **Two provider cards put their token rows on one line** however long their taglines run —
 *     the whole purpose of `.lnk-pat { margin-block-start: auto }`.
 *   • **"Coming-soon providers render disabled at reduced opacity"** — that the fade is real, and
 *     that it is on the mark rather than on the words.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet actually
 *     renders it, which is the only way a token pair that fails contrast can be caught.
 *
 * ### Why it injects markup instead of signing in
 *
 * Linked accounts *is* the reader's own account — its content is a session and a set of external
 * identities — so the obvious spec would sign in and read `/ade/dashboard/linked-accounts`. That
 * spec would measure whatever the seeded user happens to have, and the interesting cases (a
 * handle too long to fit, a provider that is the reader's only way in, a card with a two-line
 * tagline beside one with a single line) are precisely the ones a fixed database will not
 * produce.
 *
 * So this suite does what `hive-profile.spec.ts` and `hive-home.spec.ts` do: it loads `/login`,
 * which compiles the real `globals.css` and needs no session, and injects the page's own markup
 * into it. The fixture is deliberately the worst case throughout.
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

/** Widths either side of the provider grid's breakpoint (768 px), down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1101, 1099, 900, 769, 767, 420];

/** A handle with no break opportunity in it — the case the cell's clip is there for. */
const LONG_HANDLE = 'augusta.ada.king.countess.of.lovelace@engineering.example.com';

/** The card chrome, as `ui/Card` composes it. */
const CARD = 'rounded-lg bg-surface shadow-sm';

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

/**
 * The page's body, as the components compose it.
 *
 * Written out rather than rendered because Playwright has no React runtime: the markup a
 * component tree produces is already pinned by the jsdom suite, and what this fixture has to be
 * faithful about is the *class names and nesting* the stylesheet keys off.
 *
 * Two identities, the first of them guarded (so the note is on screen) and carrying a token, the
 * second with a two-line tagline on its card (so the token rows have something to align across),
 * and a coming-soon teaser.
 */
const LINKED_MARKUP = `
<div class="page" id="linked-probe">
  <header class="page-header page-header--with-tabs">
    <div class="page-header__inner">
      <div class="page-header__row">
        <div class="flex items-start">
          <div class="min-w-0">
            <nav aria-label="Breadcrumb" class="page-header__crumbs mb-1.5 text-xs text-fg-muted">
              <ol class="flex flex-wrap items-center gap-1.5"><li>Home</li><li>Account</li><li>Linked accounts</li></ol>
            </nav>
            <h1 class="page-header__title"><span class="min-w-0 break-words">Linked accounts</span></h1>
            <p class="page-header__desc">Link external accounts for single sign-on and repository access.</p>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
          <a href="#linked-add-provider" class="${BUTTON_SM}">Link a provider</a>
        </div>
      </div>
      <nav aria-label="Account" class="flex flex-wrap items-end gap-0.5 border-b border-border">
        <a href="#" class="-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-sm border-b-2 border-transparent text-fg-muted font-medium min-h-[var(--control-h)] px-3 py-1.5 text-sm">Profile</a>
        <a href="#" aria-current="page" class="-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-sm border-b-2 border-fg text-fg font-medium min-h-[var(--control-h)] px-3 py-1.5 text-sm">Linked accounts</a>
        <button type="button" class="-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-sm border-b-2 border-transparent text-fg-muted font-medium min-h-[var(--control-h)] px-3 py-1.5 text-sm">Preferences</button>
      </nav>
    </div>
  </header>

  <div class="page-body">
    <div class="flex flex-col gap-3">
      <div class="table-density overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-sm)]">
        <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <span class="text-sm font-semibold text-fg">Linked accounts</span>
          <span class="text-xs text-fg-muted">Providers you can sign in with today</span>
          <span aria-hidden="true" class="flex-1"></span>
        </div>
        <div class="overflow-x-auto" tabindex="0" role="region" aria-label="Linked accounts">
          <table class="w-full border-separate border-spacing-0 text-sm text-fg min-w-[48.75rem]">
            <caption class="sr-only">Linked accounts</caption>
            <thead>
              <tr>
                <th scope="col" class="${TH}">Account</th>
                <th scope="col" class="${TH}">Linked</th>
                <th scope="col" class="${TH}">Last login</th>
                <th scope="col" class="${TH} text-right"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr class="group lnk-row--guarded">
                <td class="${TD}">
                  <div class="lnk-account">
                    <span class="acct-glyph acct-glyph--sm" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg></span>
                    <div class="lnk-account__body">
                      <div class="font-medium whitespace-nowrap text-fg">GitHub</div>
                      <div class="mt-px text-xs text-fg-muted lnk-account__handle">${LONG_HANDLE}</div>
                      <p class="lnk-last-method" id="guard-note"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20Z"/></svg>Only sign-in method — set a password or link another provider to remove it.</p>
                    </div>
                  </div>
                </td>
                <td class="${TD} whitespace-nowrap tabular-nums text-fg-muted">03/02/26 10:14 AM</td>
                <td class="${TD} whitespace-nowrap tabular-nums text-fg-muted">08/15/26 09:12 AM</td>
                <td class="${TD} text-right">
                  <div data-row-actions="" class="flex items-center justify-end gap-0.5 opacity-0">
                    <button type="button" disabled aria-describedby="guard-note" title="This is your only sign-in method. Set a password or link another provider before unlinking it." class="${BUTTON_SM} bg-danger-soft text-danger-fg">Unlink</button>
                  </div>
                </td>
              </tr>
              <tr class="group">
                <td class="${TD}">
                  <div class="lnk-account">
                    <span class="acct-glyph acct-glyph--sm" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg></span>
                    <div class="lnk-account__body">
                      <div class="font-medium whitespace-nowrap text-fg">GitLab</div>
                      <div class="mt-px text-xs text-fg-muted lnk-account__handle">ada@example.com</div>
                    </div>
                  </div>
                </td>
                <td class="${TD} whitespace-nowrap tabular-nums text-fg-muted">08/15/26 09:40 AM</td>
                <td class="${TD} whitespace-nowrap tabular-nums text-fg-muted">—</td>
                <td class="${TD} text-right">
                  <div data-row-actions="" class="flex items-center justify-end gap-0.5 opacity-0">
                    <button type="button" class="${BUTTON_SM} bg-danger-soft text-danger-fg">Unlink</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 text-xs text-fg-muted">
          <span>2 linked accounts</span><span>Hover a row for actions</span>
        </div>
      </div>
    </div>

    <section id="linked-add-provider" aria-labelledby="linked-add-provider-title">
      <div class="lnk-section-title">
        <h2 id="linked-add-provider-title">Add a provider</h2>
        <span class="lnk-section-title__note">Only the providers this deployment enables are listed.</span>
      </div>
      <div class="lnk-providers">
        <div class="${CARD} lnk-provider" data-provider="github">
          <div class="lnk-provider__head">
            <span class="acct-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg></span>
            <div class="lnk-provider__body">
              <div class="lnk-provider__title">
                <span class="lnk-provider__name">GitHub</span>
                <span class="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-[0.4375rem] text-2xs font-semibold text-ok-fg h-5">Linked</span>
                <span class="inline-flex items-center gap-1.5 rounded-full bg-neutral-soft px-[0.4375rem] text-2xs font-semibold text-neutral-fg h-5 mono">PAT ••••••a1b2c3</span>
              </div>
              <p class="lnk-provider__tagline">Repositories, organisations and pull requests</p>
            </div>
          </div>
          <div class="lnk-pat">
            <span class="lnk-pat__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg></span>
            <div class="lnk-pat__body">
              <p class="lnk-pat__label">Personal Access Token</p>
              <p class="lnk-pat__hint">PAT set (ends in <span class="lnk-pat__mask">••••••a1b2c3</span>).</p>
            </div>
            <div class="lnk-pat__actions">
              <button type="button" class="${BUTTON_SM}">Update</button>
              <button type="button" class="${BUTTON_SM} bg-transparent shadow-none text-danger-fg">Remove</button>
            </div>
          </div>
        </div>

        <div class="${CARD} lnk-provider" data-provider="gitlab">
          <div class="lnk-provider__head">
            <span class="acct-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg></span>
            <div class="lnk-provider__body">
              <div class="lnk-provider__title">
                <span class="lnk-provider__name">GitLab self-managed for engineering.example.com</span>
                <span class="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-[0.4375rem] text-2xs font-semibold text-ok-fg h-5">Linked</span>
              </div>
              <p class="lnk-provider__tagline">Projects, groups and merge requests across every group this account can reach</p>
            </div>
          </div>
          <div class="lnk-pat">
            <span class="lnk-pat__glyph" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg></span>
            <div class="lnk-pat__body">
              <p class="lnk-pat__label">Personal Access Token</p>
              <p class="lnk-pat__hint">Optional: add a PAT for direct repo access.</p>
            </div>
            <div class="lnk-pat__actions">
              <button type="button" class="${BUTTON_SM}">Add</button>
            </div>
          </div>
        </div>

        <div class="${CARD} lnk-provider lnk-provider--soon" data-provider="atlassian">
          <div class="lnk-provider__head">
            <span class="acct-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg></span>
            <div class="lnk-provider__body">
              <div class="lnk-provider__title">
                <span class="lnk-provider__name">Atlassian</span>
                <span class="inline-flex items-center gap-1.5 rounded-full bg-neutral-soft px-[0.4375rem] text-2xs font-semibold text-neutral-fg h-5">Coming soon</span>
              </div>
              <p class="lnk-provider__tagline">Enterprise SSO via Atlassian Access</p>
            </div>
            <button type="button" disabled class="${BUTTON_SM} disabled:opacity-50">Link</button>
          </div>
        </div>
      </div>
    </section>

    <div class="relative flex w-full items-start gap-2.5 rounded-md px-3.5 py-2.5 text-sm bg-accent-soft text-accent-fg">
      <svg class="mt-px size-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg>
      <div class="min-w-0 flex-1">You can link multiple providers. Once linked, you can sign in with any of them.</div>
    </div>
  </div>
</div>
`;

/**
 * The token dialog, as `PatDialog` composes it, at the `sm` width DESIGN.md §7 gives a confirm.
 *
 * Its own probe rather than part of the page: the scope list is the narrowest box on this screen
 * and the widest identifier on it, and that pairing only exists inside the dialog.
 */
const PAT_DIALOG_MARKUP = `
<div id="pat-probe" class="${CARD} w-[27.5rem] max-w-full p-[var(--card-pad)]">
  <div class="flex flex-col gap-1.5 acct-dialog__header">
    <span class="acct-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg></span>
    <div class="acct-dialog__heading">
      <h2 class="text-xl font-semibold text-fg">Update Personal Access Token</h2>
      <p class="text-sm text-fg-muted lnk-dialog__subject">GitLab · ${LONG_HANDLE}</p>
    </div>
  </div>
  <div class="acct-dialog__body">
    <div class="acct-field">
      <label class="text-sm font-medium text-fg" for="pat-probe-token">Token</label>
      <input id="pat-probe-token" type="password" class="mono h-[var(--control-h)] w-full rounded-md bg-surface px-3 text-sm text-fg shadow-control" placeholder="Paste your token" />
      <p class="acct-hint">Used to authenticate with GitLab&rsquo;s API. Stored encrypted; only the last 6 characters are shown afterwards.</p>
    </div>
    <div class="relative flex w-full items-start gap-2.5 rounded-md px-3.5 py-2.5 text-sm bg-accent-soft text-accent-fg">
      <svg class="mt-px size-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg>
      <div class="min-w-0 flex-1">
        <span class="block font-semibold">Required scopes</span>
        <span class="lnk-scopes mono">read_api, read_repository, read_user</span>
      </div>
    </div>
  </div>
</div>
`;

/**
 * Load a page that compiles `globals.css`, and put the fixture in it.
 *
 * @param page The page under test.
 */
async function mountLinkedAccounts(page: Page): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.evaluate(
    ([body, dialog]) => {
      document.body.innerHTML = `<main>${body}${dialog}</main>`;
      document.body.style.margin = '0';
    },
    [LINKED_MARKUP, PAT_DIALOG_MARKUP] as const
  );
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

test.describe('Linked accounts layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mountLinkedAccounts(page);
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

  test('sits two provider cards abreast above the breakpoint and one below it', async ({
    page,
  }) => {
    /** How many cards share the topmost row at this width. */
    const cardsInFirstRow = async () =>
      page.evaluate(() => {
        const cards = [...document.querySelectorAll('.lnk-provider')];
        if (cards.length === 0) return 0;
        const top = Math.round(cards[0].getBoundingClientRect().top);
        return cards.filter(
          (card) => Math.abs(Math.round(card.getBoundingClientRect().top) - top) < 2
        ).length;
      });

    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    expect(await cardsInFirstRow()).toBe(2);

    await page.setViewportSize({ width: 420, height: 900 });
    await settle(page);
    expect(await cardsInFirstRow()).toBe(1);
  });

  test('bottom-aligns the token rows across two cards with different taglines', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);

    const bottoms = await page
      .locator('.lnk-pat')
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().bottom)));

    expect(bottoms.length).toBe(2);
    // The whole point of `.lnk-pat { margin-block-start: auto }`: one card's tagline runs to two
    // lines and the other's to one, and their token rows still sit on the same line.
    expect(Math.abs(bottoms[0] - bottoms[1])).toBeLessThan(2);
  });

  test('keeps a 64-character handle inside its cell at every font scale', async ({ page }) => {
    for (const scale of FONT_SCALES) {
      await applyPreference(page, 'data-font-scale', scale);

      const cell = (await page.locator('.lnk-account').first().boundingBox())!;
      const handle = (await page
        .locator('.lnk-account__handle')
        .first()
        .boundingBox())!;

      expect(handle.x + handle.width, `handle at ${scale}`).toBeLessThanOrEqual(
        cell.x + cell.width + 1
      );
      expect(await documentOverflow(page), `handle at ${scale}`).toBe(0);
    }
    await applyPreference(page, 'data-font-scale', null);
  });

  test('keeps the guard note inside its cell, wrapped rather than one long line', async ({
    page,
  }) => {
    const cell = (await page.locator('.lnk-account').first().boundingBox())!;
    const note = (await page.locator('.lnk-last-method').boundingBox())!;

    expect(note.x + note.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
    // 46ch at 11 px is narrower than the sentence, so it has to be more than one line tall.
    const lineHeight = await page
      .locator('.lnk-last-method')
      .evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
    expect(note.height).toBeGreaterThan(lineHeight * 1.5);
  });

  test('keeps the scope list inside the token dialog at every font scale', async ({ page }) => {
    for (const scale of FONT_SCALES) {
      await applyPreference(page, 'data-font-scale', scale);

      const dialog = (await page.locator('#pat-probe').boundingBox())!;
      const scopes = (await page.locator('.lnk-scopes').boundingBox())!;

      expect(scopes.x + scopes.width, `scopes at ${scale}`).toBeLessThanOrEqual(
        dialog.x + dialog.width + 1
      );
      expect(await documentOverflow(page), `scopes at ${scale}`).toBe(0);
    }
    await applyPreference(page, 'data-font-scale', null);
  });

  test('keeps the guarded row’s actions visible while the other row hides its own', async ({
    page,
  }) => {
    const opacities = await page
      .locator('[data-row-actions]')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).opacity));

    expect(opacities).toHaveLength(2);
    // The guarded row opts out of the hover reveal; the ordinary row does not.
    expect(Number(opacities[0])).toBe(1);
    expect(Number(opacities[1])).toBe(0);
  });

  test('paints the guard note’s own tint rather than leaving it on the row', async ({ page }) => {
    for (const theme of THEMES) {
      await applyPreference(page, 'data-theme', theme);
      const background = await page
        .locator('.lnk-last-method')
        .evaluate((node) => getComputedStyle(node).backgroundColor);

      expect(background, `theme ${theme ?? 'light'}`).not.toBe('rgba(0, 0, 0, 0)');
      expect(background, `theme ${theme ?? 'light'}`).not.toBe('transparent');
    }
    await applyPreference(page, 'data-theme', null);
  });

  test('fades a coming-soon card’s mark and not its words', async ({ page }) => {
    const card = page.locator('.lnk-provider--soon');

    expect(
      await card.evaluate((node) => getComputedStyle(node).opacity),
      'the card itself must stay fully opaque — dimming it would take its copy under AA'
    ).toBe('1');
    expect(await card.locator('.acct-glyph').evaluate((node) => getComputedStyle(node).opacity)).toBe(
      '0.55'
    );
    expect(
      await card.locator('.lnk-provider__name').evaluate((node) => getComputedStyle(node).opacity)
    ).toBe('1');
    // And it gives up its elevation, which costs no contrast at all.
    expect(await card.evaluate((node) => getComputedStyle(node).boxShadow)).toBe('none');
  });

  test('paints every icon tile rather than leaving it transparent', async ({ page }) => {
    const glyphs = await page
      .locator('.acct-glyph')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));

    expect(glyphs.length).toBeGreaterThan(3);
    for (const background of glyphs) {
      expect(background).not.toBe('rgba(0, 0, 0, 0)');
      expect(background).not.toBe('transparent');
    }
  });

  test('has no serious or critical axe violations, in every theme', async ({ page }) => {
    for (const theme of THEMES) {
      await applyPreference(page, 'data-theme', theme);
      const results = await new AxeBuilder({ page })
        .include('#linked-probe')
        .withTags(WCAG_TAGS)
        .analyze();
      expect(blocking(results.violations), `theme ${theme ?? 'light'}`).toEqual([]);
    }
    await applyPreference(page, 'data-theme', null);
  });

  test('has no serious or critical axe violations in the token dialog', async ({ page }) => {
    for (const theme of THEMES) {
      await applyPreference(page, 'data-theme', theme);
      const results = await new AxeBuilder({ page })
        .include('#pat-probe')
        .withTags(WCAG_TAGS)
        .analyze();
      expect(blocking(results.violations), `theme ${theme ?? 'light'}`).toEqual([]);
    }
    await applyPreference(page, 'data-theme', null);
  });
});
