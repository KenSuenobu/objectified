import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The style-guide detail page, measured in a browser (HIVE-5.7, #5310).
 *
 * `tests/guide-detail-hive-redesign.test.tsx` pins what the page renders,
 * `tests/guide-detail-model.test.ts` pins the derivations behind it,
 * `tests/guide-detail-css.test.ts` pins the declarations, and
 * `tests/monaco-hive-theme.test.ts` pins the editor theme in all nine palettes. None of the
 * four can answer the questions that are about *computed layout*, because jsdom compiles no
 * CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a page whose second tab is a two-pane editor.
 *   • **The two-pane editor really collapses** below its `rem` breakpoint, which is the
 *     whole reason its tracks are `minmax(0, …)` rather than the mockup's `minmax(32rem, …)`.
 *   • **A rule row's rationale elides** instead of widening the card, and the row drops its
 *     severity select under the rule below 44 rem rather than crushing it.
 *   • **The save bar sticks to the bottom of its panel** and stays inside the viewport.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet renders
 *     it — for the catalog, the editor pane and the policy form.
 *
 * ### Why it injects markup instead of signing in
 *
 * The same reason `hive-style-guides.spec.ts`, `hive-api-keys.spec.ts` and
 * `hive-audit.spec.ts` give. The states worth measuring — a 41-rule catalog across five
 * categories, a dry run with findings against an unsaved draft — are the ones a seeded
 * database will not produce on demand, and every read here is tenant-scoped and
 * admin-gated.
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

/** Widths either side of the three `rem` breakpoints this ticket adds, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1120, 1088, 1024, 768, 704, 640, 420];

/** A `Card`, as `ui/Card` composes its default variant. */
const CARD = 'rounded-lg bg-surface text-fg shadow-sm';

/** A `Button size="sm"` with no colour pair, as `ui/Button` composes its chrome. */
const BUTTON_SM =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium ' +
  'h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs';

/** `variant="outline"`. */
const BUTTON_OUTLINE = `${BUTTON_SM} bg-surface text-fg shadow-control`;

/** `variant="primary"`. */
const BUTTON_PRIMARY = `${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid`;

/** A `Badge`, as `ui/Badge` composes it. */
const BADGE =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full ' +
  'px-[0.4375rem] text-2xs font-semibold leading-none tracking-[0.01em] h-5';

/** `DataTableToolbar` and `DataTableFoot`, as the primitive composes them. */
const TOOLBAR = 'flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5';
const FOOT =
  'flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 ' +
  'text-xs text-fg-muted';

/** `DataTableSearch`'s input. */
const SEARCH_INPUT =
  'hive-control flex w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg ' +
  'h-[var(--control-h-sm)] w-[16.25rem] max-w-full pl-8 text-sm';

/** `DataTableFilterChip`, inactive. */
const CHIP =
  'inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 ' +
  'text-xs font-medium whitespace-nowrap bg-surface text-fg-muted ' +
  'shadow-[inset_0_0_0_1px_var(--border-strong)]';

/** A pencil glyph, standing in for the Lucide one. */
const PENCIL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="15" height="15">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

/** A circle-x glyph. */
const CIRCLE_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="15" height="15">' +
  '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>';

/** A rationale with no break opportunity, long enough to have no chance of fitting. */
const LONG_RATIONALE =
  'Operation-ids-are-used-as-SDK-method-names-and-a-single-casing-keeps-every-generated-client-' +
  'predictable-across-languages-and-releases-which-is-why-this-rule-exists-and-why-it-defaults-' +
  'to-warning-rather-than-to-error-on-a-guide-that-has-not-been-tailored-yet';

/** One rule of the catalog fixture. */
interface RuleFixture {
  /** The rule id, in the mono face. */
  id: string;
  /** Its registry default severity — the `default: …` pill. */
  defaultSeverity: 'error' | 'warning' | 'info';
  /** Whether the guide has switched it on. */
  on: boolean;
  /** Whether the guide's state differs from the baseline. */
  modified: boolean;
  /** The one-line rationale. */
  why: string;
}

/** The tone `Badge status={severity}` resolves each severity to. */
const SEVERITY_TONE = {
  error: 'bg-danger-soft text-danger-fg',
  warning: 'bg-warn-soft text-warn-fg',
  info: 'bg-accent-soft text-accent-fg',
} as const;

/**
 * One rule row.
 *
 * @param rule See {@link RuleFixture}.
 * @returns The row markup.
 */
function ruleRow(rule: RuleFixture): string {
  const modified = rule.modified
    ? `<span class="${BADGE} bg-accent-soft text-accent-fg">modified</span>`
    : '';
  return `
    <li class="gd-rule-row"${rule.on ? '' : ' data-off'}>
      <label class="relative inline-flex shrink-0 cursor-pointer items-center">
        <input type="checkbox" role="switch" class="peer sr-only" aria-label="Enable ${rule.id}"${
          rule.on ? ' checked' : ''
        } />
        <span aria-hidden="true" class="block h-5 w-[2.125rem] rounded-full bg-inset peer-checked:bg-accent"></span>
      </label>
      <div class="gd-rule-row__text">
        <div class="gd-rule-row__line">
          <code class="gd-rule-id">${rule.id}</code>
          <span class="${BADGE} ${SEVERITY_TONE[rule.defaultSeverity]}">default: ${
            rule.defaultSeverity
          }</span>
          ${modified}
        </div>
        <p class="gd-rule-row__why">${rule.why}</p>
      </div>
      <select class="hive-control sg-select gd-severity-select" aria-label="Severity for ${rule.id}"${
        rule.on ? '' : ' disabled'
      }>
        <option>Error</option><option selected>Warning</option><option>Info</option>
      </select>
    </li>`;
}

/**
 * One category section.
 *
 * @param category The category name.
 * @param on How many of its rules are switched on.
 * @param rules Its rules.
 * @returns The section markup.
 */
function ruleGroup(category: string, on: number, rules: readonly RuleFixture[]): string {
  return `
    <section class="gd-rule-group" aria-label="${category} rules" id="group-${category}">
      <div class="gd-rule-group__head">
        <span class="gd-rule-group__name">${category}</span>
        <span class="gd-rule-group__count">${on} of ${rules.length} on</span>
      </div>
      <ul>${rules.map(ruleRow).join('')}</ul>
    </section>`;
}

/** The naming category, whose first rule carries the unbreakable rationale. */
const NAMING: readonly RuleFixture[] = [
  {
    id: 'operation-operationId-camel-case',
    defaultSeverity: 'warning',
    on: true,
    modified: true,
    why: LONG_RATIONALE,
  },
  {
    id: 'path-kebab-case',
    defaultSeverity: 'warning',
    on: true,
    modified: false,
    why: 'Path segments should be lowercase kebab-case so URLs read consistently across services.',
  },
  {
    id: 'schema-names-pascal-case',
    defaultSeverity: 'info',
    on: false,
    modified: true,
    why: 'Component schema names become type names in most generators.',
  },
];

/** The security category. */
const SECURITY: readonly RuleFixture[] = [
  {
    id: 'no-http-basic',
    defaultSeverity: 'error',
    on: true,
    modified: false,
    why: 'HTTP Basic sends credentials on every request; prefer bearer tokens or OAuth 2.',
  },
  {
    id: 'servers-https-only',
    defaultSeverity: 'error',
    on: true,
    modified: false,
    why: 'Server URLs must use https; plain http leaks tokens in transit.',
  },
];

/** The rule-catalog tab, as `RuleCatalogTab` composes it. */
const CATALOG_MARKUP = `
<div class="gd-panel" id="catalog-panel">
  <div class="${CARD} gd-catalog">
    <div class="${TOOLBAR}">
      <div class="relative flex items-center">
        <input type="search" class="${SEARCH_INPUT}" aria-label="Search rules"
               placeholder="Search rules by id, rationale, or category…" />
      </div>
      <select class="hive-control sg-select gd-category-select" aria-label="Filter by category">
        <option>All categories</option><option>naming</option><option>security</option>
      </select>
      <button type="button" class="${CHIP}" aria-pressed="false" id="modified-chip">
        ${PENCIL}Modified only <span class="tabular-nums text-fg-muted">2</span>
      </button>
      <span aria-hidden class="flex-1"></span>
      <span class="sg-quiet">Severity is per guide; the default pill shows the catalog baseline.</span>
    </div>
    ${ruleGroup('naming', 2, NAMING)}
    ${ruleGroup('security', 2, SECURITY)}
    <div class="${FOOT}"><span>Showing 5 of 41 rules · 2 categories</span></div>
  </div>
  <div class="gd-save-bar" role="status" aria-live="polite" id="save-bar">
    ${PENCIL}
    <span class="gd-save-bar__label">2 unsaved rule changes</span>
    <button type="button" class="${BUTTON_OUTLINE}">Discard</button>
    <button type="button" class="${BUTTON_PRIMARY}">Save changes</button>
  </div>
</div>`;

/** The custom-rules tab, as `CustomRulesTab` composes it. */
const EDITOR_MARKUP = `
<div class="gd-panel" id="editor-panel">
  <div class="gd-editor-layout" id="editor-layout">
    <div class="${CARD} gd-editor-card">
      <div class="flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)] gd-editor-head">
        <div class="gd-editor-head__text">
          <h3 class="gd-card-title">Custom rules (YAML)</h3>
          <p class="sg-quiet">2 rules saved · Spectral-compatible subset · schema completion from
            <code class="mono">custom-rule-dsl.schema.json</code></p>
        </div>
        <div class="gd-editor-head__actions">
          <button type="button" class="${BUTTON_SM} text-fg">Format</button>
          <button type="button" class="${BUTTON_SM} text-fg">Insert rule</button>
        </div>
      </div>
      <div class="gd-editor" id="editor-well">
        <pre class="mono" style="margin:0;padding:8px 12px;font-size:var(--fs-xs)">rules:
  operation-summary-max-length:
    description: Summaries stay under 60 characters.
    severity: warning</pre>
      </div>
      <div class="gd-editor-status"><span>YAML</span><span aria-hidden>·</span><span>2 problems</span>
        <span class="gd-editor-status__spacer"></span><span>Draft — unsaved</span></div>
    </div>

    <div class="${CARD} gd-preview-card">
      <div class="flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)] gd-editor-head">
        <div class="gd-editor-head__text">
          <h3 class="gd-card-title">Test against…</h3>
          <p class="sg-quiet">dry run · nothing is saved</p>
        </div>
      </div>
      <div class="p-[var(--card-pad)] gd-preview-body">
        <div class="gd-preview-picker" id="preview-picker">
          <div class="sg-field">
            <label class="text-xs font-medium text-fg" for="pp">Project</label>
            <select class="hive-control sg-select" id="pp"><option>Payments API</option></select>
          </div>
          <div class="sg-field">
            <label class="text-xs font-medium text-fg" for="pv">Version</label>
            <select class="hive-control sg-select" id="pv"><option>v2.4.0 — draft</option></select>
          </div>
        </div>
        <div class="gd-preview-run">
          <button type="button" class="${BUTTON_PRIMARY}">Run</button>
          <span class="sg-quiet">Last run 09:41 · 1.2 s · Payments API v2.4.0</span>
        </div>
        <div class="gd-findings">
          <div class="gd-findings__head">
            <span class="gd-findings__title">Findings</span>
            <span class="gd-findings__counts">
              <span class="${BADGE} ${SEVERITY_TONE.error}">1 error</span>
              <span class="${BADGE} ${SEVERITY_TONE.warning}">1 warning</span>
            </span>
          </div>
          <ul class="gd-findings__list">
            <li class="gd-finding" id="finding-1">
              <button type="button" class="gd-finding__button" data-severity="error">
                <span class="gd-finding__glyph">${CIRCLE_X}</span>
                <span class="gd-finding__text">
                  <span class="gd-finding__line">
                    <code class="gd-finding__rule">refund-idempotency-key</code>
                    <span class="gd-finding__path">paths./refunds.post.parameters.0.name.in.header.required.schema.properties.idempotencyKey.type.format.example</span>
                  </span>
                  <span class="gd-finding__message">error — POST /refunds must declare an Idempotency-Key header parameter.</span>
                </span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</div>`;

/** The policy tab, as `PolicyTab` composes it. */
const POLICY_MARKUP = `
<div class="gd-policy" id="policy-panel">
  <div class="${CARD}">
    <div class="flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)] gd-card-header">
      <span class="gd-card-header__lead">
        <span class="tnt-icon-tile" data-tone="accent">${PENCIL}</span>
        <span class="gd-card-header__text">
          <h3 class="gd-card-title">Policy</h3>
          <p class="sg-quiet">Gate settings applied when evaluating lint evidence against this guide.</p>
        </span>
      </span>
    </div>
    <div class="p-[var(--card-pad)] gd-policy-body">
      <div class="gd-policy-grid" id="policy-grid">
        <div class="sg-field">
          <label class="text-xs font-medium text-fg" for="qmg">Quality minimum grade</label>
          <select class="hive-control sg-select" id="qmg"><option>B</option></select>
          <p class="sg-field__hint">Evidence graded below this floor fails the quality gate.</p>
        </div>
        <fieldset class="sg-field">
          <legend class="gd-legend">Required coverage</legend>
          <ul class="gd-coverage">
            <li class="gd-coverage__item">
              <input type="checkbox" id="cov-quality" checked
                     class="size-4 shrink-0 rounded-xs bg-surface shadow-[inset_0_0_0_1px_var(--border-strong)]" />
              <label class="text-xs font-medium text-fg gd-coverage__label" for="cov-quality">quality</label>
            </li>
          </ul>
          <p class="sg-field__hint">More axes arrive with the axis-coverage roadmap.</p>
        </fieldset>
      </div>
      <div>
        <h4 class="sg-section-title">CI outcomes</h4>
        <p class="sg-section-desc">What <code class="mono">GET …/lint/gate</code> reports as failed.</p>
        <ul class="gd-switch-list">
          <li class="gd-switch-row">
            <span class="gd-switch-row__text">
              <label class="gd-switch-row__title" for="ci-1">Fail on unwaived errors</label>
              <span class="gd-switch-row__desc">Any open error-severity finding without an active waiver fails the gate.</span>
            </span>
            <label class="relative inline-flex shrink-0 cursor-pointer items-center">
              <input type="checkbox" role="switch" id="ci-1" checked class="peer sr-only"
                     aria-label="Fail on unwaived errors" />
              <span aria-hidden="true" class="block h-5 w-[2.125rem] rounded-full bg-accent"></span>
            </label>
          </li>
        </ul>
      </div>
    </div>
    <div class="flex items-center justify-between gap-3 border-t border-border px-[var(--card-pad)] py-3 text-sm text-fg-muted">
      <span class="sg-quiet">Saving creates an immutable policy version.</span>
      <button type="button" class="${BUTTON_PRIMARY}">Save</button>
    </div>
  </div>

  <div class="${CARD}">
    <ul class="gd-version-list">
      <li class="gd-version-row">
        <span class="${BADGE} bg-transparent text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)] mono">v3</span>
        <code class="gd-fingerprint">e2b7c9d4a1f6…</code>
        <span class="gd-version-row__when">Aug 12, 2026, 02:10 PM</span>
        <span class="gd-version-row__actor">Ada Lovelace</span>
      </li>
    </ul>
  </div>
</div>`;

/** All three panels at once, for the whole-page overflow sweep. */
const PAGE_MARKUP = `${CATALOG_MARKUP}${EDITOR_MARKUP}${POLICY_MARKUP}`;

/**
 * Load the real stylesheet and inject one of the fixtures into it.
 *
 * @param page The Playwright page.
 * @param markup The fixture.
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
 * How many columns a grid resolves to.
 *
 * @param page The Playwright page.
 * @param selector The grid.
 * @returns The number of tracks `grid-template-columns` computed to.
 */
function gridColumns(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .evaluate((node) =>
      getComputedStyle(node as Element)
        .gridTemplateColumns.split(' ')
        .filter(Boolean).length
    );
}

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the guide detail page keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`every panel stays inside ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, PAGE_MARKUP);
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const theme of THEMES) {
    test(`the ${theme ?? 'light'} theme does not scroll sideways at ${DESKTOP_WIDTH}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, PAGE_MARKUP);
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    test(`the ${fontScale} font scale does not scroll sideways at ${DESKTOP_WIDTH}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, PAGE_MARKUP);
      await applyPreferences(page, { fontScale });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const density of ['comfortable', 'compact']) {
    test(`the ${density} density does not scroll sideways at ${DESKTOP_WIDTH}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, PAGE_MARKUP);
      await applyPreferences(page, { density });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  test('holds at the Largest scale, compact density and the darkest theme together', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);
    await applyPreferences(page, { theme: 'darcula', fontScale: '2xl', density: 'compact' });
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The grids collapse
   ------------------------------------------------------------------------- */

test.describe('the grids collapse rather than scroll', () => {
  test('the editor is two panes above its breakpoint and one below', async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 900 });
    await mount(page, EDITOR_MARKUP);
    expect(await gridColumns(page, '#editor-layout')).toBe(2);

    await page.setViewportSize({ width: 1088, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '#editor-layout')).toBe(1);
  });

  test('the editor still fits at the Largest scale, which a 32rem floor would not', async ({
    page,
  }) => {
    // This is the whole reason the tracks are `minmax(0, 1.2fr) minmax(0, 1fr)` rather than
    // the mockup's `minmax(32rem, 1.2fr)`. At the Largest scale the root is 20 px, so the
    // mockup's floor is 640 px *per pane* — 1280 px of track inside a 1120 px viewport,
    // which is a horizontally scrolling document. With a zero minimum the panes shrink.
    await page.setViewportSize({ width: 1120, height: 900 });
    await mount(page, EDITOR_MARKUP);
    await applyPreferences(page, { fontScale: '2xl' });

    expect(await gridColumns(page, '#editor-layout')).toBe(2);
    expect(await documentOverflows(page)).toBe(false);

    const panes = await page.locator('#editor-layout > *').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().width)
    );
    expect(panes).toHaveLength(2);
    for (const width of panes) expect(width).toBeLessThan(640);
  });

  test('the policy form collapses to one column', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await mount(page, POLICY_MARKUP);
    expect(await gridColumns(page, '#policy-grid')).toBe(2);

    await page.setViewportSize({ width: 704, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '#policy-grid')).toBe(1);
  });

  test('a rule row drops its severity select under the rule rather than crushing it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mount(page, CATALOG_MARKUP);
    expect(await gridColumns(page, '.gd-rule-row >> nth=0')).toBe(3);

    await page.setViewportSize({ width: 640, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '.gd-rule-row >> nth=0')).toBe(2);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Long content elides instead of widening its container
   ------------------------------------------------------------------------- */

test.describe('long content stays inside its column', () => {
  test('an unbreakable rationale elides', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, CATALOG_MARKUP);

    const why = page.locator('.gd-rule-row__why').first();
    const [scrollWidth, clientWidth] = await why.evaluate((node) => [
      node.scrollWidth,
      node.clientWidth,
    ]);
    // Elided, not wrapped and not overflowing: the text is wider than its box, and the box
    // is inside the card.
    expect(scrollWidth).toBeGreaterThan(clientWidth);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('a deep finding path elides rather than setting the pane width', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, EDITOR_MARKUP);

    const path = page.locator('.gd-finding__path').first();
    const [scrollWidth, clientWidth] = await path.evaluate((node) => [
      node.scrollWidth,
      node.clientWidth,
    ]);
    expect(scrollWidth).toBeGreaterThan(clientWidth);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The save bar
   ------------------------------------------------------------------------- */

test.describe('the unsaved bar', () => {
  test('is sticky, centred and inside the viewport', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 600 });
    await mount(page, CATALOG_MARKUP);

    const bar = page.locator('#save-bar');
    expect(await bar.evaluate((node) => getComputedStyle(node).position)).toBe('sticky');

    const box = (await bar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(DESKTOP_WIDTH + 1);
  });

  test('wraps rather than overflowing on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await mount(page, CATALOG_MARKUP);
    const box = (await page.locator('#save-bar').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(420 + 1);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   axe
   ------------------------------------------------------------------------- */

test.describe('axe finds nothing serious', () => {
  for (const [name, markup] of [
    ['rule catalog', CATALOG_MARKUP],
    ['custom rules', EDITOR_MARKUP],
    ['policy', POLICY_MARKUP],
  ] as const) {
    test(`the ${name} tab has no serious or critical violations`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, markup);

      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).include('main').analyze();
      const serious = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical'
      );
      expect(serious.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    });
  }

  test('the rule catalog is clean in the dark theme too', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, CATALOG_MARKUP);
    await applyPreferences(page, { theme: 'dark' });

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).include('main').analyze();
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical'
    );
    expect(serious.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });
});
