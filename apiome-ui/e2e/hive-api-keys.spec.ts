import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * API keys, measured in a browser (HIVE-5.4, #5307).
 *
 * `tests/api-keys-hive-redesign.test.tsx` pins what the page renders,
 * `tests/api-keys-model.test.ts` pins the derivations behind it, and
 * `tests/api-keys-css.test.ts` pins the declarations. None of the three can answer the
 * acceptance criteria that are questions about *computed layout*, because jsdom compiles no
 * CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — and this page is a nine-column table with two
 *     timestamp columns that cannot be abbreviated.
 *   • **The table scrolls inside its own wrapper** when the viewport cannot hold nine
 *     columns, rather than taking the document with it.
 *   • **"Expired and revoked keys are visually distinct"** — the two row tints have to differ
 *     in computed `background-color` from the ordinary row *and from each other*, and neither
 *     may be a fade.
 *   • **An expired row's Delete is visible without hovering**, because the page's own banner
 *     tells the reader to press it.
 *   • **The reveal-once secret wraps** rather than overflowing its dialog — the reader sees
 *     that string once, and a key they have to scroll sideways to read is one they cannot
 *     select by eye.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet actually
 *     renders it.
 *
 * ### Why it injects markup instead of signing in
 *
 * The same reason `hive-members.spec.ts`, `hive-roles.spec.ts` and `hive-tenants.spec.ts`
 * give. The states worth measuring — an expired key, a disabled one, a description long
 * enough to clamp, a plaintext secret — are precisely the ones a seeded database will not
 * produce on demand, and every read here is tenant-scoped. Creating a *real* key to measure
 * its reveal dialog would also mean minting a live credential on every CI run.
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

/** Widths either side of the reference-card breakpoint this ticket adds (60rem), down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1024, 961, 959, 900, 640, 420];

/** A description with no break opportunity, long enough to have no chance of fitting. */
const LONG_DESCRIPTION =
  'GitHub-Actions-job-that-blocks-merges-on-breaking-classified-diffs-across-every-published-contract-in-the-workspace';

/** A plaintext key the length the server really mints. */
const SECRET = 'sk_9f31c2Qm7ZtR4vB8kW2xLp0sD6hN1yE3cU5aJ7pQ2rT4vX6zB8dF0hK';

/**
 * A `Button size="sm"` with no colour pair, as `ui/Button` composes its chrome.
 *
 * The pair is added per variant below rather than layered on top of a default one: the real
 * component runs its classes through `tailwind-merge`, which *drops* the conflicting utility,
 * and a fixture that keeps both gets whichever the generated stylesheet happens to order
 * last — which is how a hand-written fixture invents a contrast failure the product does not
 * have.
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

/** The row-actions cluster, hidden until hover or focus — the behaviour an expired row undoes. */
const ROW_ACTIONS =
  'flex items-center justify-end gap-0.5 opacity-0 transition-opacity ' +
  'group-hover:opacity-100 group-focus-within:opacity-100';

/** A copy glyph, standing in for the Lucide one. */
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/** A key glyph. */
const KEY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/></svg>';

/** One key's row. */
interface RowFixture {
  /** The `id` put on the `<tr>`, so a test can reach it. */
  id: string;
  /** The key's name. */
  name: string;
  /** The second line under it. */
  description: string;
  /** The stored prefix, drawn with one ellipsis. */
  prefix: string;
  /** The scope cell: `null` for full access, else the scope strings. */
  scopes: string[] | null;
  /** Which tint, if any, the row carries. */
  tint: 'expired' | 'disabled' | null;
  /** The Status badge's label. */
  status: string;
  /** What the Expires cell says. */
  expires: string;
  /** Whether the switch reads On. */
  enabled: boolean;
}

/** The four rows the mockup draws, plus the long description that has to clamp. */
const ROWS: readonly RowFixture[] = [
  {
    id: 'akey-row-active',
    name: 'CI contract gate',
    description: LONG_DESCRIPTION,
    prefix: 'sk_9f31c2Qm…',
    scopes: ['diff:read'],
    tint: null,
    status: 'Active',
    expires: '01/02/27',
    enabled: true,
  },
  {
    id: 'akey-row-disabled',
    name: 'Nightly lint',
    description: 'Cron reads catalog + MCP lint gates every night at 02:00 UTC.',
    prefix: 'sk_2ab7e0Zz…',
    scopes: ['lint:read'],
    tint: 'disabled',
    status: 'Disabled',
    expires: 'Never',
    enabled: false,
  },
  {
    id: 'akey-row-expired',
    name: 'Partner sync',
    description: 'Legacy integration used by Globex to mirror published specs.',
    prefix: 'sk_c41d88Aa…',
    scopes: null,
    tint: 'expired',
    status: 'Expired',
    expires: '08/01/26',
    enabled: true,
  },
  {
    id: 'akey-row-both',
    name: 'Terraform',
    description: 'Plan-time contract + lint checks in the platform IaC pipeline.',
    prefix: 'sk_77e0a1Bb…',
    scopes: ['diff:read', 'lint:read'],
    tint: null,
    status: 'Active',
    expires: '11/12/26',
    enabled: true,
  },
];

/**
 * One `<tr>` of the keys table.
 *
 * @param row See {@link RowFixture}.
 * @returns The row markup.
 */
function keyRow(row: RowFixture): string {
  const scopeCell =
    row.scopes === null
      ? '<span class="akey-scopes__full">Full access</span>'
      : `<span class="akey-scopes">${row.scopes
          .map((scope) => `<span class="${BADGE} mono font-medium bg-accent-soft text-accent-fg">${scope}</span>`)
          .join('')}</span>`;

  const tint = row.tint ? ` akey-row--${row.tint}` : '';
  const expiresClass = row.tint === 'expired' ? 'akey-stamp akey-stamp--past' : 'akey-stamp';

  return `
  <tr id="${row.id}" class="group transition-colors${tint}">
    <td class="${TD_CLASS}">
      <div class="akey-identity">
        <span class="tnt-icon-tile" data-tone="${row.tint === 'expired' ? 'danger' : 'honey'}">${KEY_ICON}</span>
        <span class="akey-identity__text">
          <div class="font-medium whitespace-nowrap text-fg akey-identity__name">${row.name}</div>
          <div class="mt-px text-xs text-fg-muted akey-identity__desc">${row.description}</div>
        </span>
      </div>
    </td>
    <td class="${TD_CLASS}">
      <span class="akey-prefix">
        <code class="akey-prefix__value mono">${row.prefix}</code>
        <button type="button" class="${BUTTON_GHOST} akey-prefix-copy" aria-label="Copy the prefix of ${row.name}">${COPY_ICON}</button>
      </span>
    </td>
    <td class="${TD_CLASS}">${scopeCell}</td>
    <td class="${TD_CLASS}"><span class="${BADGE} bg-neutral-soft text-neutral-fg">${row.status}</span></td>
    <td class="${TD_CLASS}"><span class="akey-stamp" id="${row.id}-last-used">08/15/26 08:02 AM</span></td>
    <td class="${TD_CLASS}"><span class="akey-stamp">07/02/26 10:14 AM</span></td>
    <td class="${TD_CLASS}"><span class="${expiresClass}" id="${row.id}-expires">${row.expires}</span></td>
    <td class="${TD_CLASS}">
      <span class="akey-toggle">
        <label class="relative inline-flex shrink-0 items-center">
          <input type="checkbox" role="switch" class="peer sr-only" ${row.enabled ? 'checked' : ''}
                 ${row.tint === 'expired' ? 'disabled' : ''} aria-label="Enabled: ${row.name}" />
          <span aria-hidden="true" class="h-5 w-9 rounded-full bg-inset"></span>
        </label>
        <span class="akey-toggle__label">${row.enabled ? 'On' : 'Off'}</span>
      </span>
    </td>
    <td class="${TD_CLASS} text-right">
      <div data-row-actions="" class="${ROW_ACTIONS}">
        <button type="button" class="${BUTTON_GHOST} px-1.5" aria-label="Delete ${row.name}">${COPY_ICON}</button>
      </div>
    </td>
  </tr>`;
}

/** The four scope preset cards, with the second one chosen. */
const SCOPE_CARDS = [
  { id: 'akey-card-full', label: 'Full access', scopes: ['*'], checked: false },
  { id: 'akey-card-diff', label: 'CI: classified diff', scopes: ['diff:read'], checked: true },
  { id: 'akey-card-lint', label: 'CI: lint', scopes: ['lint:read'], checked: false },
  {
    id: 'akey-card-both',
    label: 'CI: diff + lint',
    scopes: ['diff:read', 'lint:read'],
    checked: false,
  },
]
  .map(
    (card) => `
    <label id="${card.id}" class="akey-scope-card"${card.checked ? ' data-checked' : ''}>
      <input type="radio" class="akey-scope-radio" name="scope" ${card.checked ? 'checked' : ''} />
      <span class="akey-scope-body">
        <span class="akey-scope-title">${card.label}${card.scopes
          .map(
            (scope) =>
              `<span class="${BADGE} akey-scope-badge mono font-medium bg-accent-soft text-accent-fg">${scope}</span>`
          )
          .join('')}</span>
        <span class="akey-scope-hint">POST /v1/diff/…/classified only — recommended for contract gates.</span>
      </span>
    </label>`
  )
  .join('');

/** The whole page, as the components compose it. */
const PAGE_MARKUP = `
<div class="page">
  <header class="page-header">
    <div class="page-header__inner">
      <div class="page-header__row">
        <div>
          <h1 class="page-title">API keys</h1>
          <p class="page-desc">Keys for external REST access. Prefer scoped CI tokens for pipelines.</p>
        </div>
      </div>
    </div>
  </header>

  <div class="page-body">
    <div class="relative flex w-full items-start gap-2.5 rounded-md px-3.5 py-2.5 text-sm bg-danger-soft text-danger-fg">
      <span><strong>“Partner sync” expired on August 1, 2026.</strong> Requests with that key are refused — create a replacement and delete the old one.</span>
    </div>

    <div class="${TABLE_CARD}">
      <div id="akey-scroll" class="overflow-x-auto">
        <table class="w-full border-separate border-spacing-0 text-sm text-fg min-w-[48.75rem]">
          <caption class="sr-only">API keys for this workspace</caption>
          <thead>
            <tr>
              <th scope="col" class="${TH_CLASS}">Name</th>
              <th scope="col" class="${TH_CLASS}">Prefix</th>
              <th scope="col" class="${TH_CLASS}">Scopes</th>
              <th scope="col" class="${TH_CLASS}">Status</th>
              <th scope="col" class="${TH_CLASS}">Last used</th>
              <th scope="col" class="${TH_CLASS}">Created</th>
              <th scope="col" class="${TH_CLASS}">Expires</th>
              <th scope="col" class="${TH_CLASS}">Enabled</th>
              <th scope="col" class="${TH_CLASS} text-right"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>${ROWS.map(keyRow).join('')}</tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 text-xs text-fg-muted">
        <span>4 keys · 2 active · 1 disabled · 1 expired</span>
        <span class="akey-foot-legend">Scopes: <code class="mono">*</code> (full), <code class="mono">diff:read</code>, <code class="mono">lint:read</code> — <code class="mono">*</code> must stand alone.</span>
      </div>
    </div>

    <section class="akey-reference" id="akey-reference">
      <article class="akey-ref-card" id="akey-ref-use">
        <header class="akey-ref-card__header">
          <h2 class="akey-ref-card__title">Use a key</h2>
          <span class="akey-ref-card__note">Bearer token over HTTPS</span>
        </header>
        <div class="akey-ref-card__body">
          <div class="akey-code-wrap">
            <pre class="akey-code mono" id="akey-code"><code>curl -X POST \\
  https://api.apiome.dev/v1/diff/ver_1a2b/ver_3c4d/classified \\
  -H "Authorization: Bearer sk_live_…" \\
  -H "Accept: application/json"</code></pre>
            <button type="button" class="${BUTTON_OUTLINE} akey-code-copy" aria-label="Copy the example request">${COPY_ICON}Copy</button>
          </div>
          <p class="akey-ref-card__desc">Keys are tenant-scoped: every call runs as <strong>Acme Corp</strong>.</p>
        </div>
      </article>
      <article class="akey-ref-card" id="akey-ref-scopes">
        <header class="akey-ref-card__header">
          <h2 class="akey-ref-card__title">Scope reference</h2>
          <span class="${BADGE} text-fg-muted shadow-[inset_0_0_0_1px_var(--border)]">3 scopes</span>
        </header>
        <div class="akey-ref-card__body akey-ref-card__body--flush">
          <table class="akey-scope-table">
            <caption class="sr-only">What each API key scope allows</caption>
            <thead><tr><th scope="col">Scope</th><th scope="col">Allows</th><th scope="col" class="akey-scope-table__count">Keys</th></tr></thead>
            <tbody>
              <tr><td><span class="${BADGE} mono font-medium bg-neutral-soft text-neutral-fg">*</span></td><td class="akey-scope-table__allows">All REST operations for this tenant. Must stand alone.</td><td class="akey-scope-table__count mono">1</td></tr>
              <tr><td><span class="${BADGE} mono font-medium bg-accent-soft text-accent-fg">diff:read</span></td><td class="akey-scope-table__allows">POST /v1/diff/…/classified only — contract gates.</td><td class="akey-scope-table__count mono">2</td></tr>
              <tr><td><span class="${BADGE} mono font-medium bg-accent-soft text-accent-fg">lint:read</span></td><td class="akey-scope-table__allows">GET …/lint and …/lint/gate (catalog + MCP).</td><td class="akey-scope-table__count mono">2</td></tr>
            </tbody>
          </table>
        </div>
      </article>
    </section>

    <!-- The create dialog's scope group, and the reveal-once secret, drawn in place: both are
         overlays in the product, and what is being measured is their own layout. -->
    <section class="akey-ref-card" id="akey-overlays">
      <div class="akey-ref-card__body">
        <fieldset class="akey-scope-field" id="akey-scope-field">
          <legend class="akey-scope-legend">Scopes</legend>
          <div class="akey-scope-list" role="radiogroup" aria-label="Scopes">${SCOPE_CARDS}</div>
        </fieldset>

        <div class="akey-secret-body" id="akey-secret-body">
          <div class="relative flex w-full items-start gap-2.5 rounded-md px-3.5 py-2.5 text-sm bg-warn-soft text-warn-fg">
            <span><strong>Important:</strong> This is the only time you'll see this API key.</span>
          </div>
          <div class="akey-secret-label">Your API key</div>
          <div class="akey-secret" id="akey-secret">
            <code class="akey-secret__value mono" id="akey-secret-value">${SECRET}</code>
            <button type="button" class="${BUTTON_OUTLINE} akey-secret__copy">${COPY_ICON}Copy</button>
          </div>
          <p class="akey-secret-note">Send it as <code class="mono">Authorization: Bearer &lt;key&gt;</code>.</p>
        </div>
      </div>
    </section>
  </div>
</div>`;

/**
 * Load a page that compiles the real stylesheet, and put the fixture in it.
 *
 * @param page The Playwright page.
 * @param markup The body to inject.
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

test.describe('the API keys page keeps the document to one column', () => {
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

  test('lets the table scroll inside its own wrapper rather than taking the page', async ({
    page,
  }) => {
    // Nine columns have a floor — `DataTable`'s `min-w-[48.75rem]` — and the point is where
    // that floor lands: inside the wrapper, never on the document.
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, PAGE_MARKUP);

    expect(await documentOverflows(page)).toBe(false);
    expect(
      await page.locator('#akey-scroll').evaluate((node) => node.scrollWidth > node.clientWidth + 1)
    ).toBe(true);
  });

  test('scrolls a long request line inside the code block, not the page', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, PAGE_MARKUP);

    expect(await documentOverflows(page)).toBe(false);
    expect(
      await page.locator('#akey-code').evaluate((node) => node.scrollWidth > node.clientWidth + 1)
    ).toBe(true);
  });

  test('clamps a long description rather than widening the Name column', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    const cell = page.locator('#akey-row-active .akey-identity');
    // The ceiling `.akey-identity` declares, in the units the browser actually resolved.
    expect(await cell.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(
      await cell.evaluate((node) => parseFloat(getComputedStyle(node).maxWidth) + 1)
    );
    // Two lines and no more — that is what `-webkit-line-clamp: 2` has to be doing.
    const desc = page.locator('#akey-row-active .akey-identity__desc');
    const lines = await desc.evaluate((node) => {
      const style = getComputedStyle(node);
      return node.getBoundingClientRect().height / parseFloat(style.lineHeight);
    });
    expect(lines).toBeLessThanOrEqual(2.2);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('collapses the two reference cards to one column below the breakpoint', async ({
    page,
  }) => {
    /**
     * Whether the two cards sit side by side.
     *
     * @returns True when the scope card starts to the right of the usage card.
     */
    const sideBySide = () =>
      page.evaluate(() => {
        const first = document.querySelector('#akey-ref-use')!.getBoundingClientRect();
        const second = document.querySelector('#akey-ref-scopes')!.getBoundingClientRect();
        return second.left >= first.right;
      });

    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, PAGE_MARKUP);
    expect(await sideBySide()).toBe(true);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await sideBySide()).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Expired and revoked keys are visually distinct, and still deletable
   ------------------------------------------------------------------------- */

test.describe('how an expired or disabled key reads', () => {
  for (const theme of THEMES) {
    test(`tints the three row states differently in ${theme ?? 'light'}`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, PAGE_MARKUP);
      await applyPreferences(page, { theme });

      const plain = await computed(page, '#akey-row-active', 'background-color');
      const expired = await computed(page, '#akey-row-expired', 'background-color');
      const disabled = await computed(page, '#akey-row-disabled', 'background-color');

      // Three different grounds — including the two tints against *each other*, which is
      // what "visually distinct" has to mean for two washes on one card.
      expect(new Set([plain, expired, disabled]).size).toBe(3);
    });
  }

  test('marks the two states by tint, never by fading their ink', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    for (const id of ['#akey-row-expired', '#akey-row-disabled']) {
      expect(await computed(page, id, 'opacity')).toBe('1');
    }
  });

  test('keeps an expired row Delete visible without hovering it', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    // The ordinary row hides its actions until hover; the expired one must not, because the
    // banner at the top of the page tells the reader to press exactly that button.
    expect(await computed(page, '#akey-row-active [data-row-actions]', 'opacity')).toBe('0');
    expect(await computed(page, '#akey-row-expired [data-row-actions]', 'opacity')).toBe('1');
  });

  test('draws a passed expiry in more than one channel', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    const ordinary = await computed(page, '#akey-row-active-expires', 'color');
    const past = await computed(page, '#akey-row-expired-expires', 'color');
    expect(past).not.toBe(ordinary);
    // Weight and a ground of its own as well as hue, for the monochrome themes and for a
    // reader who cannot separate red from grey. The ground is also what makes the ink
    // legible — see the note on `.akey-stamp--past` in globals.css.
    expect(Number(await computed(page, '#akey-row-expired-expires', 'font-weight'))).toBe(600);
    expect(await computed(page, '#akey-row-expired-expires', 'background-color')).not.toBe(
      await computed(page, '#akey-row-active-expires', 'background-color')
    );
  });
});

/* -------------------------------------------------------------------------
   The scope cards and the secret box
   ------------------------------------------------------------------------- */

test.describe('the create dialog scope cards', () => {
  test('marks the chosen card in two channels, not one', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    const checkedBg = await computed(page, '#akey-card-diff', 'background-color');
    const plainBg = await computed(page, '#akey-card-full', 'background-color');
    expect(checkedBg).not.toBe(plainBg);

    const checkedRing = await computed(page, '#akey-card-diff', 'box-shadow');
    const plainRing = await computed(page, '#akey-card-full', 'box-shadow');
    expect(checkedRing).not.toBe(plainRing);
  });

  test('keeps the four cards in one column at every width', async ({ page }) => {
    for (const width of [DESKTOP_WIDTH, 640, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, PAGE_MARKUP);
      const lefts = await page
        .locator('.akey-scope-card')
        .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
      expect(new Set(lefts).size).toBe(1);
      expect(await documentOverflows(page)).toBe(false);
    }
  });
});

test.describe('the reveal-once secret', () => {
  test('wraps the key inside its box rather than scrolling it', async ({ page }) => {
    // The reader sees this string once. A key they have to scroll sideways to read is a key
    // they cannot select by eye when the clipboard write is refused.
    for (const width of [DESKTOP_WIDTH, 640, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, PAGE_MARKUP);

      expect(
        await page
          .locator('#akey-secret-value')
          .evaluate((node) => node.scrollWidth > node.clientWidth + 1)
      ).toBe(false);
      expect(
        await page.locator('#akey-secret').evaluate((node) => node.scrollWidth > node.clientWidth + 1)
      ).toBe(false);
      expect(await documentOverflows(page)).toBe(false);
    }
  });

  test('draws the key in the monospace face, at every font scale', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    for (const fontScale of FONT_SCALES) {
      await applyPreferences(page, { fontScale });
      const family = await computed(page, '#akey-secret-value', 'font-family');
      expect(family.toLowerCase()).toMatch(/mono/);
    }
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  for (const theme of THEMES) {
    test(`reports no serious or critical violation in ${theme ?? 'light'}`, async ({ browser }) => {
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
});
