import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Style guides & governance policies, measured in a browser (HIVE-5.6, #5309).
 *
 * `tests/style-guides-hive-redesign.test.tsx` pins what the page renders,
 * `tests/style-guides-model.test.ts` pins the derivations behind it, and
 * `tests/style-guides-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a page whose second and third tabs are two- and
 *     three-column policy forms.
 *   • **The two policy grids really collapse** below their `rem` breakpoints, which is the
 *     whole reason they are stated in `rem` rather than in the mockup's 900 px.
 *   • **The guides table scrolls inside its own wrapper** when five columns will not fit.
 *   • **A guide pinned to many projects wraps its chips** instead of widening the table.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet renders it
 *     — for the list, the policy form and the assign dialog.
 *
 * ### Why it injects markup instead of signing in
 *
 * The same reason `hive-api-keys.spec.ts`, `hive-audit.spec.ts` and `hive-roles.spec.ts`
 * give. The states worth measuring — a guide pinned to six projects, a blocking policy beside
 * an advisory one, a member's read-only banner — are the ones a seeded database will not
 * produce on demand, and every read here is tenant-scoped and admin-gated.
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

/** Widths either side of the two `rem` breakpoints this ticket adds, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1024, 1000, 900, 768, 640, 420];

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

/** A book glyph, standing in for the Lucide one. */
const BOOK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<path d="M12 21V7a4 4 0 0 0-4-4H2v15h7"/><path d="m16 12 2 2 4-4"/></svg>';

/** A lock glyph. */
const LOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

/** An info glyph. */
const INFO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';

/** One guides-table row of the fixture. */
interface RowFixture {
  /** The `id` put on the `<tr>`, so a test can reach it. */
  id: string;
  /** The guide's name. */
  name: string;
  /** Its description — the line that has to elide. */
  description: string;
  /** The icon tile's tone, as `styleGuideTone` resolves it. */
  tone: string;
  /** Whether it carries the Built-in badge. */
  builtin: boolean;
  /** Whether it carries the Default badge and the Tenant-default chip. */
  isDefault: boolean;
  /** The projects it is pinned to. */
  projects: string[];
  /** The Rules-on cell. */
  rules: string;
  /** The Updated cell. */
  updated: string;
}

/** A description with no break opportunity, long enough to have no chance of fitting. */
const LONG_DESCRIPTION =
  'House-rules-for-public-REST-APIs-covering-camelCase-operation-ids-contact-information-and-mandatory-4xx-responses-on-every-operation';

/** Four guides: the shipped one, the tenant default, a heavily pinned one, and an orphan. */
const ROWS: readonly RowFixture[] = [
  {
    id: 'sg-row-builtin',
    name: 'Apiome Recommended',
    description: 'Apiome’s baseline OpenAPI & AsyncAPI ruleset.',
    tone: 'honey',
    builtin: true,
    isDefault: false,
    projects: [],
    rules: '41 / 41',
    updated: '—',
  },
  {
    id: 'sg-row-default',
    name: 'Acme REST',
    description: LONG_DESCRIPTION,
    tone: 'ok',
    builtin: false,
    isDefault: true,
    projects: ['Payments API'],
    rules: '34 / 41',
    updated: 'Aug 14, 2026',
  },
  {
    id: 'sg-row-pinned',
    name: 'Events (AsyncAPI)',
    description: 'Channel naming and message-schema descriptions.',
    tone: 'violet',
    builtin: false,
    isDefault: false,
    // Six pins: the case the Assignments column has to wrap rather than widen for.
    projects: [
      'Inventory Events',
      'Orders Service',
      'Shipping Events',
      'Billing Events',
      'Partner Feed',
      'Telemetry',
    ],
    rules: '22 / 41',
    updated: 'Aug 11, 2026',
  },
  {
    id: 'sg-row-orphan',
    name: 'Partner API strict',
    description: 'Everything in Acme REST at error severity.',
    tone: 'neutral',
    builtin: false,
    isDefault: false,
    projects: [],
    rules: '41 / 41',
    updated: 'Aug 3, 2026',
  },
];

/**
 * One `<tr>` of the guides table.
 *
 * @param row See {@link RowFixture}.
 * @returns The row markup.
 */
function guideRow(row: RowFixture): string {
  const chips =
    row.isDefault || row.projects.length > 0
      ? `<span class="sg-chips">${
          row.isDefault
            ? `<span class="${BADGE} bg-ok-soft text-ok-fg">Tenant default</span>`
            : ''
        }${row.projects
          .map((p) => `<span class="${BADGE} bg-accent-soft text-accent-fg">${p}</span>`)
          .join('')}</span>`
      : '<span class="sg-empty-cell">—</span>';

  return `
  <tr id="${row.id}" class="group transition-colors">
    <td class="${TD_CLASS}">
      <div class="sg-identity">
        <span class="tnt-icon-tile" data-tone="${row.tone}">${BOOK}</span>
        <span class="sg-identity__text">
          <span class="sg-identity__line">
            <a class="sg-identity__link" href="#${row.id}">
              <span class="font-medium whitespace-nowrap text-fg sg-identity__name">${row.name}</span>
            </a>
            ${
              row.builtin
                ? `<span class="${BADGE} bg-transparent text-fg-muted shadow-control">${LOCK}Built-in</span>`
                : ''
            }
            ${row.isDefault ? `<span class="${BADGE} bg-ok-soft text-ok-fg">Default</span>` : ''}
          </span>
          <div class="mt-px text-xs text-fg-muted sg-identity__desc">${row.description}</div>
        </span>
      </div>
    </td>
    <td class="${TD_CLASS} text-right"><span class="sg-rules mono">${row.rules}</span></td>
    <td class="${TD_CLASS}">${chips}</td>
    <td class="${TD_CLASS}"><span class="sg-stamp">${row.updated}</span></td>
    <td class="${TD_CLASS} text-right">
      <div data-row-actions="" class="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <button type="button" class="${BUTTON_GHOST}">Assign…</button>
        <button type="button" class="${BUTTON_GHOST} px-1.5" aria-label="Duplicate ${row.name}">${BOOK}</button>
      </div>
    </td>
  </tr>`;
}

/** The guides list: the toolbar, the scrolling wrapper, the table and the foot. */
const TABLE_MARKUP = `
<div class="flex flex-col gap-3" id="sg-table">
  <div class="${TABLE_CARD}">
    <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
      <div class="relative flex items-center">
        <input type="search" aria-label="Filter style guides" placeholder="Filter guides…"
               class="hive-control h-[var(--control-h-sm)] w-[16.25rem] max-w-full rounded-sm bg-surface pl-8 pr-2 text-sm text-fg" />
      </div>
      <button type="button" aria-pressed="true" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-fg text-surface">All <span class="tabular-nums">4</span></button>
      <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]">Custom <span class="tabular-nums text-fg-muted">3</span></button>
      <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]">Assigned <span class="tabular-nums text-fg-muted">2</span></button>
      <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]">Unassigned <span class="tabular-nums text-fg-muted">2</span></button>
    </div>

    <div class="overflow-x-auto" id="sg-scroll" tabindex="0" role="region" aria-label="Style guides for this workspace">
      <table class="w-full border-separate border-spacing-0 text-sm text-fg ${TABLE_MIN_WIDTH}">
        <caption class="sr-only">Style guides for this workspace</caption>
        <thead>
          <tr>
            <th scope="col" class="${TH_CLASS}">Name</th>
            <th scope="col" class="${TH_CLASS} text-right">Rules on</th>
            <th scope="col" class="${TH_CLASS}">Assignments</th>
            <th scope="col" class="${TH_CLASS}">Updated</th>
            <th scope="col" class="${TH_CLASS} text-right"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>${ROWS.map(guideRow).join('')}</tbody>
      </table>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 text-xs text-fg-muted">
      <span class="sg-foot-note">${INFO}The built-in “Apiome Recommended” guide is read-only — duplicate it to customize.</span>
      <span>4 guides</span>
    </div>
  </div>
</div>`;

/** The page: the header block with its tab strip, and the guides list. */
const PAGE_MARKUP = `
<div class="page">
  <header class="page-header page-header--with-tabs">
    <div class="page-header__inner">
      <div class="page-header__row">
        <div class="min-w-0">
          <h1 class="page-title">Style guides</h1>
          <p class="page-desc">Governance rules your specs are scored against.</p>
        </div>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
          <button type="button" class="${BUTTON_OUTLINE}">Start from Recommended</button>
          <button type="button" class="${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid">New guide</button>
        </div>
      </div>
      <div role="tablist" aria-label="Style guide sections" class="flex flex-wrap items-end gap-0.5 border-b border-border" id="sg-tabs">
        <button type="button" role="tab" aria-selected="true" class="inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-2 text-sm font-medium border-fg text-fg">${BOOK}Style guides<span class="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-subtle px-1 text-2xs font-semibold text-fg-muted sg-tab-count">4</span></button>
        <button type="button" role="tab" aria-selected="false" class="inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 pb-2.5 pt-2 text-sm font-medium text-fg-muted">${LOCK}Import &amp; export policy</button>
        <button type="button" role="tab" aria-selected="false" class="inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 pb-2.5 pt-2 text-sm font-medium text-fg-muted">${LOCK}Verification policy</button>
      </div>
    </div>
  </header>
  <div class="page-body">
    <div class="rounded-md bg-accent-soft px-4 py-3 text-sm text-accent-fg" role="status" id="sg-readonly">
      <strong>Read-only for members.</strong> Only tenant administrators can create, assign or
      edit style guides and policies. You can open any guide and browse its rules.
    </div>
    ${TABLE_MARKUP}
  </div>
</div>`;

/** One scope fieldset of the quality policy form. */
function scopeFieldset(scope: 'import' | 'export', blocking: boolean): string {
  return `
  <fieldset class="qp-fieldset">
    <legend class="qp-legend">${LOCK}${scope === 'import' ? 'Import intake' : 'Export delivery'}
      <span class="${BADGE} ${blocking ? 'bg-rose-soft text-rose-fg' : 'bg-neutral-soft text-neutral-fg'}">${blocking ? 'Blocking' : 'Advisory'}</span>
    </legend>
    <div class="qp-grid">
      <div class="sg-field">
        <label class="text-xs font-medium text-fg" for="${scope}-grade">Minimum grade</label>
        <select id="${scope}-grade" class="hive-control sg-select"><option>C</option></select>
      </div>
      <div class="sg-field">
        <label class="text-xs font-medium text-fg" for="${scope}-score">Minimum score</label>
        <input id="${scope}-score" type="number" value="70" class="hive-control sg-num h-[var(--control-h)] w-full rounded-sm bg-surface px-3 text-sm text-fg" />
      </div>
    </div>
    <div class="sg-field">
      <label class="text-xs font-medium text-fg" for="${scope}-sev">Refuse findings at</label>
      <select id="${scope}-sev" class="hive-control sg-select"><option>error or worse</option></select>
    </div>
    <div class="qp-switch-row">
      <span class="qp-switch-row__text">
        <label class="qp-switch-row__title" for="${scope}-enforce">Refuse the ${scope} when a floor is missed</label>
        <span class="qp-switch-row__desc">Off keeps the policy advisory: the verdict is recorded but intake proceeds.</span>
      </span>
      <label class="relative inline-flex shrink-0 items-center">
        <input id="${scope}-enforce" type="checkbox" role="switch" class="peer sr-only" ${blocking ? 'checked' : ''} />
        <span aria-hidden="true" class="h-5 w-9 rounded-full bg-inset"></span>
      </label>
    </div>
  </fieldset>`;
}

/** The import & export policy panel. */
const QUALITY_MARKUP = `
<div class="page">
  <div class="page-body">
    <div class="qp-panel" id="sg-quality">
      <div class="rounded-lg bg-surface shadow-[var(--shadow-sm)]">
        <div class="qp-card-header flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)]">
          <span class="qp-card-header__lead">
            <span class="tnt-icon-tile" data-tone="accent">${LOCK}</span>
            <span class="qp-card-header__text">
              <h3 class="qp-card-title">Import &amp; export quality policy</h3>
              <p class="qp-card-desc">Applied when a document is imported and when an artifact is delivered. Resolution is per-format override → tenant → default.</p>
            </span>
          </span>
          <span class="${BADGE} mono font-medium bg-transparent text-fg-muted shadow-control">v3</span>
        </div>
        <div class="qp-body p-[var(--card-pad)]">
          <div class="qp-scopes" id="sg-scopes">
            ${scopeFieldset('import', true)}
            ${scopeFieldset('export', false)}
          </div>
          <div class="qp-overrides" id="sg-overrides">
            <div class="qp-overrides__head">
              <span class="sg-section-title">Per-format overrides</span>
              <span class="sg-quiet">read-only · set via the REST policy API</span>
            </div>
            <ul class="qp-overrides__list">
              <li class="qp-overrides__row"><code class="qp-overrides__format mono">asyncapi</code><span class="qp-overrides__value mono">{"import":{"minGrade":"D","enforcement":"advisory"},"export":{"minScore":60,"blockOnSeverity":"error"}}</span></li>
            </ul>
            <p class="sg-field__hint">Resolution is format override → tenant → default; the pre-flight verdict names the tier that won.</p>
          </div>
        </div>
        <div class="flex items-center justify-between gap-3 border-t border-border px-[var(--card-pad)] py-3 text-sm text-fg-muted">
          <span class="sg-quiet">Saving creates an immutable policy version; the current one is v3.</span>
          <button type="button" class="${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid">Save policy</button>
        </div>
      </div>

      <div class="qp-lists" id="sg-lists">
        <div class="rounded-lg bg-surface shadow-[var(--shadow-sm)]">
          <div class="qp-list-header flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)]">
            <span class="qp-card-header__text">
              <h3 class="qp-card-title">${LOCK}Policy versions</h3>
              <p class="qp-card-desc">Immutable snapshots; every verdict names the version it applied.</p>
            </span>
          </div>
          <ul class="qp-rows">
            <li class="qp-version-row">
              <span class="${BADGE} mono font-medium bg-transparent text-fg-muted shadow-control">v3</span>
              <code class="qp-fingerprint mono" title="sha256:9f2c1a7e44b0d3c8e5a1f6b2c9d0e7a3">9f2c1a7e44b0…</code>
              <span class="qp-version-row__when">Aug 14, 2026, 04:22 PM</span>
              <span class="qp-version-row__actor">Ada Lovelace</span>
            </li>
          </ul>
        </div>
        <div class="rounded-lg bg-surface shadow-[var(--shadow-sm)]">
          <div class="qp-list-header flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)]">
            <span class="qp-card-header__text">
              <h3 class="qp-card-title">${LOCK}Active waivers</h3>
              <p class="qp-card-desc">Accepted risk with a deadline.</p>
            </span>
            <span class="${BADGE} bg-warn-soft text-warn-fg">2</span>
          </div>
          <ul class="qp-rows">
            <li class="qp-waiver-row">
              <span class="tnt-icon-tile" data-tone="warn">${LOCK}</span>
              <span class="qp-waiver-row__text">
                <span class="qp-waiver-row__head">
                  <span class="qp-waiver-row__subject">Payments API · v2.4.0 import</span>
                  <span class="${BADGE} bg-transparent text-fg-muted shadow-control">import · openapi</span>
                  <span class="sg-quiet">graded D (61)</span>
                </span>
                <span class="qp-waiver-row__reason">“Legacy vendor spec; descriptions to be back-filled before publish.”</span>
                <span class="qp-waiver-row__meta">Grace Hopper (admin) · expires Aug 17, 2026, 04:22 PM</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</div>`;

/** The assign dialog, as the sheet composes it. */
const ASSIGN_MARKUP = `
<div class="page">
  <div class="page-body">
    <div class="flex w-full max-w-[35rem] flex-col gap-4 rounded-lg bg-surface p-6 shadow-lg" role="dialog" aria-label="Assign Acme REST" id="sg-assign">
      <div class="flex flex-col gap-1.5">
        <h2 class="flex items-center gap-2 text-base font-semibold text-fg">
          <span class="tnt-icon-tile" data-tone="ok">${LOCK}</span>
          Assign “Acme REST”
        </h2>
        <p class="text-sm text-fg-muted">Assignments take effect on the next lint run: a project-level assignment wins over the tenant default.</p>
      </div>
      <div class="sg-assign-body">
        <section>
          <h3 class="sg-section-title">Tenant default</h3>
          <p class="sg-section-desc">Applies to every project without its own assignment.</p>
          <div class="sg-default-row">
            <span class="${BADGE} h-6 px-[0.5625rem] text-xs bg-ok-soft text-ok-fg">This guide is the tenant default</span>
          </div>
        </section>
        <section>
          <h3 class="sg-section-title">Project assignments</h3>
          <p class="sg-section-desc">Pin this guide to individual projects, overriding the tenant default.</p>
          <div class="sg-assign-picker">
            <select class="hive-control sg-select sg-assign-picker__select" aria-label="Project to assign"><option>Select a project…</option></select>
            <button type="button" class="${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid">Assign</button>
          </div>
          <ul class="sg-assign-list" id="sg-assign-list">
            <li class="sg-assign-row">
              <span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-5 text-2xs font-semibold bg-accent-soft text-accent-fg avatar-hex">PA</span>
              <span class="sg-assign-row__name">Payments API</span>
              <code class="sg-assign-row__id mono">prj_8f2a1c7e-4d5b-6a90-b1c2-d3e4f5a6b7c8</code>
              <button type="button" class="${BUTTON_GHOST} sg-assign-row__remove px-1.5" aria-label="Unassign Payments API">${LOCK}</button>
            </li>
          </ul>
        </section>
      </div>
      <div class="flex items-center justify-end gap-2">
        <button type="button" class="${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid">Done</button>
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

test.describe('the style-guides page keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`the list does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, PAGE_MARKUP);
      expect(await documentOverflows(page)).toBe(false);
    });

    test(`the policy panel does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, QUALITY_MARKUP);
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
      test(`the policy panel holds at the ${fontScale} scale, ${density}`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, QUALITY_MARKUP);
        await applyPreferences(page, { fontScale, density });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  test('scrolls the guides table inside its own wrapper when five columns will not fit', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, PAGE_MARKUP);

    expect(
      await page.locator('#sg-scroll').evaluate((node) => node.scrollWidth > node.clientWidth + 1)
    ).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('gives that scroll container a name and a place in the tab order', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, PAGE_MARKUP);
    // WCAG 2.1.1: a region that scrolls must be reachable without a pointer.
    await expect(page.locator('#sg-scroll')).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#sg-scroll')).toHaveAttribute('aria-label', /Style guides/);
  });
});

/* -------------------------------------------------------------------------
   The grids collapse, which is what the rem breakpoints are for
   ------------------------------------------------------------------------- */

test.describe('the policy grids', () => {
  test('put the two scopes side by side on a desktop and stack them on a phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, QUALITY_MARKUP);
    expect(await gridColumns(page, '#sg-scopes')).toBe(2);
    expect(await gridColumns(page, '#sg-lists')).toBe(2);

    await page.setViewportSize({ width: 640, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '#sg-scopes')).toBe(1);
    expect(await gridColumns(page, '#sg-lists')).toBe(1);
  });

  test('folds at the largest font scale even on a desktop, which px could not do', async ({
    page,
  }) => {
    // The whole reason the breakpoints are `rem`: at the Largest scale a 1024px viewport is
    // narrower *in text* than a 900px one at the default, so a px query would keep two
    // columns exactly where the form no longer fits in them.
    await page.setViewportSize({ width: 1000, height: 900 });
    await mount(page, QUALITY_MARKUP);
    await applyPreferences(page, { fontScale: '2xl' });
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Rows keep their shape
   ------------------------------------------------------------------------- */

test.describe('the guides table', () => {
  test('wraps a heavily pinned guide’s chips instead of widening the column', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    const lines = await page.locator('#sg-row-pinned .sg-chips').evaluate((node) => {
      const tops = Array.from(node.children).map((child) =>
        Math.round(child.getBoundingClientRect().top)
      );
      return new Set(tops).size;
    });
    // Six chips on more than one line — the definition of wrapping.
    expect(lines).toBeGreaterThan(1);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('elides a description with no break opportunity rather than widening the row', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    const cell = page.locator('#sg-row-default .sg-identity');
    const width = await cell.evaluate((node) => node.getBoundingClientRect().width);
    const cap = await cell.evaluate((node) => parseFloat(getComputedStyle(node).maxWidth));
    expect(width).toBeLessThanOrEqual(cap + 1);
  });

  test('keeps the guide-name link in the row’s ink until hovered', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    const [linkInk, rowInk] = await page.evaluate(() => {
      const link = document.querySelector('#sg-row-default .sg-identity__link') as Element;
      const row = document.querySelector('#sg-row-default') as Element;
      return [getComputedStyle(link).color, getComputedStyle(row).color];
    });
    expect(linkInk).toBe(rowInk);
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  const SURFACES = [
    ['the guides list', PAGE_MARKUP],
    ['the policy panel', QUALITY_MARKUP],
    ['the assign dialog', ASSIGN_MARKUP],
  ] as const;

  for (const [label, markup] of SURFACES) {
    for (const theme of THEMES) {
      test(`reports no serious or critical violation on ${label} in ${theme ?? 'light'}`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          viewport: { width: DESKTOP_WIDTH, height: 900 },
        });
        const page = await context.newPage();
        await mount(page, markup);
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
  }
});
