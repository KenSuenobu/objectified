import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The lint posture workspace, measured in a browser (HIVE-5.8, #5311).
 *
 * `tests/lint-workspace-hive-redesign.test.tsx` pins what the page renders,
 * `tests/lint-workspace-model.test.ts` pins the derivations behind it, and
 * `tests/lint-workspace-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on the most data-dense screen in the product,
 *     whose queue has seven columns, four facet groups and a nine-verb bulk bar.
 *   • **The three grids really collapse** below their `em` breakpoints, which is the whole
 *     reason they are stated in `em` rather than in the mockup's pixels.
 *   • **The queue scrolls inside its own wrapper** when seven columns will not fit.
 *   • **The inverted bulk bar is legible**: its field and its rule are drawn from
 *     `currentColor`, and that only means anything once a browser has resolved it.
 *   • **The facet dot inverts on a pressed chip**, which is a rule about two selectors
 *     interacting and cannot be read off either one.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet renders
 *     it — for the summary, the queue, the drawer and the two analysis tabs.
 *
 * ### Why it injects markup instead of signing in
 *
 * The same reason `hive-audit.spec.ts` and `hive-style-guides.spec.ts` give. The states
 * worth measuring — a queue of 213 findings across six decision states, a rank card whose
 * score series has a gap in it, a bulk bar with nine verbs — are the ones a seeded database
 * will not produce on demand, and every read here is tenant-scoped.
 *
 * So this loads `/login`, which compiles the real `globals.css` and needs no session, and
 * injects the page's own markup into it. What the markup *is* — that the components really
 * compose these classes in this nesting — is what the jsdom suites pin.
 *
 * Focus trapping and focus restoration in the drawer are not here: they are properties of
 * Radix's `Dialog`, which this markup does not run, and `e2e/hive-primitives.spec.ts`
 * already measures them on the real primitive.
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

/** Widths either side of this ticket's three `rem` breakpoints, down to a phone. */
const WIDTHS = [1600, 1440, DESKTOP_WIDTH, 1024, 960, 860, 768, 640, 420];

/** A `Button size="sm"` with no colour pair, as `ui/Button` composes its chrome. */
const BUTTON_SM =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium ' +
  'h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs';

/** `variant="ghost"`. */
const BUTTON_GHOST = `${BUTTON_SM} text-fg`;

/** `variant="outline"`. */
const BUTTON_OUTLINE = `${BUTTON_SM} bg-surface text-fg shadow-control`;

/** One verb of the inverted bulk bar, as `DataTableBulkAction` re-cuts a ghost button. */
const BULK_ACTION = `${BUTTON_SM} bg-surface/12 text-surface shadow-none`;

/** A `Badge`, as `ui/Badge` composes it. */
const BADGE =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full ' +
  'px-[0.4375rem] text-2xs font-semibold leading-none tracking-[0.01em] h-5';

/** A `Badge size="lg"`. */
const BADGE_LG = `${BADGE.replace('h-5', '')} h-6 px-[0.5625rem] text-xs`;

/** `DataTable`'s card, its cells and its header strip, as the primitive composes them. */
const TABLE_CARD = 'table-density overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-sm)]';
const TH_CLASS =
  'sticky top-0 z-1 whitespace-nowrap border-b border-border bg-surface text-left align-middle ' +
  'text-2xs font-semibold tracking-[var(--track-caps)] uppercase text-fg-muted px-3.5';
const TD_CLASS = 'h-[var(--row-h)] border-b border-border align-middle px-3.5';

/** The minimum width `scrollX` puts on the table, which is what makes the wrapper scroll. */
const TABLE_MIN_WIDTH = 'min-w-[48.75rem]';

/** The toolbar strip above a table. */
const TOOLBAR = 'flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5';

/** A filter chip, idle and pressed, as `DataTableFilterChip` composes them. */
const CHIP_BASE =
  'lw-facet-chip inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full ' +
  'px-2.5 text-xs font-medium whitespace-nowrap';
const CHIP_IDLE = `${CHIP_BASE} bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]`;
const CHIP_ACTIVE = `${CHIP_BASE} bg-fg text-surface`;

/** `ui/Input`, as `CONTROL_FIELD_CLASS` composes it. */
const INPUT =
  'hive-control flex w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg ' +
  'placeholder:text-fg-faint';

/** A link glyph, standing in for the Lucide one. */
const LINK_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg>';

/** A shield glyph. */
const SHIELD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<path d="M20 13c0 5-3.5 7.5-8 8.5-4.5-1-8-3.5-8-8.5V6l8-3 8 3Z"/></svg>';

/* -------------------------------------------------------------------------
   Fixtures
   ------------------------------------------------------------------------- */

/** One posture tile, as `Stat as="button"` composes it inside the strip. */
function tile(
  id: string,
  label: string,
  value: string,
  unit: string,
  foot: string,
  callout = ''
): string {
  return `
  <button type="button" id="${id}" class="hive-stat lw-tile" title="Drill down">
    <span class="hive-stat__label">${SHIELD}${label}</span>
    <span class="hive-stat__value"><span class="text-danger-fg">${value}</span>${
      unit ? `<small>${unit}</small>` : ''
    }</span>
    <span class="hive-stat__foot"><span>${foot}</span>${
      callout
        ? `<span class="lw-tile__callout bg-danger-soft text-danger-fg">${callout}</span>`
        : ''
    }</span>
  </button>`;
}

/** The posture summary: four drill-down tiles, then the grades and axes card. */
const SUMMARY_MARKUP = `
<div class="lw-summary" id="lw-summary">
  <div class="hive-stat-grid" data-columns="4" role="group" aria-label="Posture summary">
    ${tile('lw-tile-security', 'Unwaived security errors', '2', '', 'Open · security axis', 'Needs attention')}
    ${tile('lw-tile-coverage', 'Missing required coverage', '3', 'of 12 subjects', 'Security not assessed')}
    ${tile('lw-tile-new', 'New findings', '7', '', 'since the last scan')}
    ${tile('lw-tile-waivers', 'Waivers', '4', 'active', '3 requested · 1 expiring soon')}
  </div>
  <div class="rounded-lg bg-surface text-fg shadow-sm lw-bands" id="lw-bands">
    <section>
      <h2 class="lw-caps">Grades</h2>
      <div class="lw-chip-row">
        <span class="lw-grade-chip"><span class="lw-grade-chip__letter bg-ok text-fg-on-accent">A</span><span class="lw-grade-chip__count">3</span></span>
        <span class="lw-grade-chip"><span class="lw-grade-chip__letter bg-warn text-fg-on-accent">C</span><span class="lw-grade-chip__count">2</span></span>
        <span class="lw-grade-chip"><span class="lw-grade-chip__letter bg-danger text-fg-on-accent">F</span><span class="lw-grade-chip__count">0</span></span>
        <span class="lw-grade-chip"><span class="lw-grade-chip__letter bg-transparent text-fg-muted shadow-control">Ungraded</span><span class="lw-grade-chip__count">1</span></span>
      </div>
    </section>
    <section>
      <h2 class="lw-caps">Axes <span class="lw-caps__aside">· average score</span></h2>
      <div class="lw-chip-row">
        <span class="${BADGE_LG} bg-accent-soft text-accent-fg">Quality · 84</span>
        <span class="${BADGE_LG} bg-accent-soft text-accent-fg">Supportability · 78</span>
        <span class="${BADGE_LG} bg-transparent text-fg-muted shadow-control">Supply chain · —</span>
      </div>
    </section>
  </div>
</div>`;

/** The saved-views bar, with the current view marked. */
const VIEWS_MARKUP = `
<section class="lw-views" aria-label="Saved views" id="lw-views">
  <h2 class="lw-caps">Views</h2>
  <span class="lw-view-chip is-current" id="lw-view-current" data-current="true">
    <button type="button" class="lw-view-chip__apply">New security errors</button>
    <button type="button" class="lw-view-chip__action" aria-label="Unpin New security errors">${LINK_GLYPH}</button>
    <button type="button" class="lw-view-chip__action" aria-label="Delete New security errors">${LINK_GLYPH}</button>
  </span>
  <span class="lw-view-chip">
    <button type="button" class="lw-view-chip__apply">Payments API only, waiver requested, security axis</button>
    <button type="button" class="lw-view-chip__action" aria-label="Pin Payments API only">${LINK_GLYPH}</button>
  </span>
  <button type="button" class="${BUTTON_OUTLINE}">Save view</button>
  <p class="lw-views__note">Personal to you · filters, sort and paging are in the URL</p>
</section>`;

/** One facet group. */
function facetGroup(label: string, chips: ReadonlyArray<[string, number, string | null]>): string {
  return `
  <div class="lw-facet-group" role="group" aria-label="${label}">
    <span class="lw-caps">${label}</span>
    ${chips
      .map(
        ([name, count, tone], index) => `
      <button type="button" aria-pressed="${index === 0}" class="${index === 0 ? CHIP_ACTIVE : CHIP_IDLE}" id="lw-chip-${label.toLowerCase()}-${index}">
        ${tone ? `<span class="lw-facet-dot" data-tone="${tone}" aria-hidden=""></span>` : ''}
        ${name}<span class="tabular-nums${index === 0 ? '' : ' text-fg-muted'}">${count}</span>
      </button>`
      )
      .join('')}
  </div>`;
}

/** One queue row. */
function queueRow(id: string, rule: string, severity: string, tone: string, state: string): string {
  return `
  <tr id="${id}" class="group">
    <td class="${TD_CLASS} w-9 pr-0 pl-3.5"><span class="inline-block size-4 rounded-xs shadow-control"></span></td>
    <td class="${TD_CLASS}">
      <div class="lw-finding">
        <div class="lw-finding__head">
          <div class="font-medium whitespace-nowrap text-fg lw-finding__rule mono">${rule}</div>
          <span class="${BADGE} bg-honey-soft text-honey-fg">New</span>
        </div>
        <p class="lw-finding__message">HTTP Basic auth scheme detected. Basic credentials travel with every request; prefer OAuth2 client credentials or bearer tokens, which can be scoped and revoked.</p>
        <p class="lw-finding__path mono">components.securitySchemes.basicAuth.description.longer.path.that.keeps.going</p>
      </div>
    </td>
    <td class="${TD_CLASS}"><span class="${BADGE} bg-${tone}-soft text-${tone}-fg">${severity}</span></td>
    <td class="${TD_CLASS}"><span class="${BADGE} bg-orange-soft text-orange-fg">${state}</span></td>
    <td class="${TD_CLASS}">
      <div class="lw-subject">
        <div class="font-medium whitespace-nowrap text-fg">Payments API</div>
        <div class="mt-px text-xs text-fg-muted lw-subject__meta">
          <span>v2.4.0</span>
          <span class="lw-grade-sq bg-ok text-fg-on-accent">B</span>
          <span class="${BADGE} rounded-xs bg-transparent text-fg-muted shadow-control">MCP</span>
        </div>
      </div>
    </td>
    <td class="${TD_CLASS}"><span class="lw-axis">Supportability</span></td>
    <td class="${TD_CLASS}"><span class="lw-source mono">apiome-security</span></td>
  </tr>`;
}

/** The queue: the toolbar, the facet strip, the URL line, the table, the foot and the bar. */
const QUEUE_MARKUP = `
<div class="flex flex-col gap-3" id="lw-queue">
  <div class="${TABLE_CARD}" id="lw-queue-card">
    <div class="${TOOLBAR}">
      <div class="relative flex items-center">
        <input type="search" aria-label="Search findings" placeholder="Search rule, message, subject…" class="${INPUT} h-[var(--control-h-sm)] w-[16.25rem] max-w-full pl-8 text-sm" />
      </div>
      <label class="lw-toolbar-field"><button type="button" role="switch" aria-checked="false" aria-label="New only" class="h-4 w-7 rounded-full bg-inset"></button>New only</label>
      <label class="lw-toolbar-field">Sort<select class="hive-control lw-select" aria-label="Sort"><option>Severity</option></select></label>
      <label class="lw-toolbar-field">Source<select class="hive-control lw-select" aria-label="Source"><option>All scanners</option></select></label>
      <label class="lw-toolbar-field">Coverage<select class="hive-control lw-select" aria-label="Coverage"><option>Any</option></select></label>
      <label class="lw-toolbar-field">Subject<select class="hive-control lw-select" aria-label="Subject"><option>All subjects</option></select></label>
      <span aria-hidden="true" class="flex-1"></span>
      <button type="button" class="${BUTTON_SM} h-auto bg-transparent p-0 px-0 text-accent-fg">Clear filters (2)</button>
    </div>

    <div class="lw-facets" id="lw-facets">
      ${facetGroup('Severity', [
        ['Error', 21, 'danger'],
        ['Warning', 142, 'warn'],
        ['Info', 50, 'accent'],
      ])}
      ${facetGroup('State', [
        ['Open', 168, 'neutral'],
        ['Acknowledged', 18, 'accent'],
        ['Waiver requested', 3, 'orange'],
        ['Waived', 4, 'warn'],
        ['Fixed', 14, 'ok'],
        ['False positive', 6, 'violet'],
      ])}
      ${facetGroup('Axis', [
        ['Quality', 120, null],
        ['Protocol', 22, null],
        ['Security', 31, null],
        ['Supply chain', 9, null],
        ['Supportability', 24, null],
        ['Compatibility', 7, null],
      ])}
      ${facetGroup('Grade', [
        ['A', 40, null],
        ['B', 96, null],
        ['C', 58, null],
        ['D', 19, null],
        ['F', 0, null],
      ])}
    </div>

    <p class="lw-url" id="lw-url">
      ${LINK_GLYPH}
      <span class="lw-url__path mono">/ade/dashboard/lint-workspace<span class="lw-url__query">?severity=error&amp;state=open&amp;axis=security&amp;sort=severity&amp;offset=0</span></span>
      <span class="lw-url__note">Shareable · selection clears when filters change</span>
    </p>

    <div class="overflow-x-auto" id="lw-queue-scroller">
      <table class="w-full border-collapse text-sm ${TABLE_MIN_WIDTH}">
        <caption class="sr-only">Lint findings across this workspace, with their policy decisions</caption>
        <thead>
          <tr>
            <th scope="col" class="${TH_CLASS} w-9 pr-0 pl-3.5"><span class="sr-only">Select</span></th>
            <th scope="col" class="${TH_CLASS}">Finding</th>
            <th scope="col" class="${TH_CLASS}">Severity</th>
            <th scope="col" class="${TH_CLASS}">State</th>
            <th scope="col" class="${TH_CLASS}">Subject</th>
            <th scope="col" class="${TH_CLASS}">Axis</th>
            <th scope="col" class="${TH_CLASS}">Source</th>
          </tr>
        </thead>
        <tbody>
          ${queueRow('lw-row-1', 'no-http-basic', 'Error', 'danger', 'Open')}
          ${queueRow('lw-row-2', 'operation-operationId-camel-case', 'Warning', 'warn', 'Waiver requested')}
        </tbody>
      </table>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 text-xs text-fg-muted">
      <span>1–50 of 213 findings · page size 50</span>
      <nav aria-label="Findings pages" class="inline-flex items-center gap-0.5">
        <button type="button" class="${BUTTON_OUTLINE} min-w-7 px-1.5 tabular-nums" aria-current="page" aria-label="Page 1">1</button>
        <button type="button" class="${BUTTON_GHOST} px-1.5" aria-label="Page 2">2</button>
      </nav>
    </div>
  </div>

  <div role="group" aria-label="Bulk actions" id="lw-bulk" class="sticky bottom-4 z-15 mx-auto flex w-max max-w-full flex-wrap items-center gap-2.5 rounded-lg bg-fg py-2 pr-2 pl-3.5 text-sm text-surface shadow-[var(--shadow-lg)]">
    <span class="tabular-nums">2 findings selected</span>
    <button type="button" class="${BULK_ACTION}">Acknowledge</button>
    <button type="button" class="${BULK_ACTION}">Mark fixed</button>
    <button type="button" class="${BULK_ACTION}">False positive</button>
    <button type="button" class="${BULK_ACTION}">Request waiver</button>
    <button type="button" class="${BULK_ACTION}" title="Requires waiver approval permission (lint_findings:publish)">Approve waiver</button>
    <button type="button" class="${BULK_ACTION}">Reopen / reject</button>
    <span class="lw-bulk-rule" id="lw-bulk-rule" aria-hidden="true"></span>
    <input class="${INPUT} lw-bulk-owner" id="lw-bulk-owner" aria-label="Assign owner (user id)" placeholder="Assign owner (user id)" />
    <button type="button" class="${BULK_ACTION}">Assign</button>
    <button type="button" class="${BULK_ACTION} px-1.5" aria-label="Clear selection">×</button>
  </div>
</div>`;

/** The whole Queue tab, header included. */
const PAGE_MARKUP = `
<div class="page">
  <header class="page-header">
    <div class="page-header__row">
      <div class="min-w-0">
        <h1 class="page-title">Lint posture <span class="${BADGE} bg-accent-soft text-accent-fg">Preview</span></h1>
        <p class="page-desc">Catalog-wide lint findings with ownership, waiver review and remediation trends.</p>
      </div>
      <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
        <button type="button" class="${BUTTON_OUTLINE}" aria-label="Reload the workspace">${SHIELD}</button>
        <button type="button" class="${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid">Save view</button>
      </div>
    </div>
  </header>
  <div class="page-body">
    ${SUMMARY_MARKUP}
    ${VIEWS_MARKUP}
    ${QUEUE_MARKUP}
  </div>
</div>`;

/** The finding drawer, as the sheet composes it. Mounted on its own so it can be measured. */
const DRAWER_MARKUP = `
<div class="page">
  <div class="page-body">
    <div class="hive-drawer flex h-[40rem] w-full max-w-[42.5rem] flex-col bg-surface text-fg shadow-lg" id="lw-drawer" role="dialog" aria-label="no-http-basic">
      <div class="flex shrink-0 flex-col gap-0.5 border-b border-border px-5 py-4 pr-12 text-left">
        <h2 class="lw-drawer-head text-lg font-semibold leading-snug text-fg">
          <span class="lw-drawer-title mono">no-http-basic</span>
          <span class="${BADGE} bg-danger-soft text-danger-fg">Error</span>
          <span class="${BADGE} bg-neutral-soft text-neutral-fg">Open</span>
          <span class="${BADGE} bg-honey-soft text-honey-fg">New</span>
        </h2>
        <p class="lw-drawer-desc">HTTP Basic auth scheme detected. Basic credentials travel with every request.</p>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 lw-drawer-body" id="lw-drawer-body">
        <section>
          <h3 class="lw-caps">Evidence</h3>
          <dl class="lw-kv" id="lw-kv">
            <dt>Scanner</dt><dd class="mono">apiome-security</dd>
            <dt>Profile</dt><dd>Acme REST · security pack</dd>
            <dt>Evidence run</dt><dd class="mono">run_7c1e92</dd>
            <dt>Fingerprint</dt><dd class="mono"><span class="lw-fingerprint" id="lw-fingerprint">sha256:9d1c4e0b7a3f5e21c8b6d4f0a2e7c9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3</span></dd>
            <dt>Location</dt><dd class="mono">path: components.securitySchemes.basicAuth, line: 412, col: 7</dd>
          </dl>
        </section>

        <section>
          <h3 class="lw-caps">Links</h3>
          <dl class="lw-kv">
            <dt>Subject</dt><dd><a class="lw-link" id="lw-link" href="#">Payments API · v2.4.0${LINK_GLYPH}</a></dd>
            <dt>Policy</dt><dd><span class="lw-inline"><span class="${BADGE} bg-danger-soft text-danger-fg">Failed</span><span class="lw-quiet">evaluation <span class="mono">ev_44b0c1</span></span></span></dd>
          </dl>
        </section>

        <section>
          <div class="lw-section-head">
            <h3 class="lw-caps">Remediation history</h3>
            <button type="button" class="${BUTTON_SM} h-auto bg-transparent p-0 px-0 text-accent-fg">Open lint report</button>
          </div>
          <ol class="lw-timeline" id="lw-timeline">
            <li class="lw-timeline__item" data-tone="orange">
              <p class="lw-timeline__title">Open → Waiver requested<span class="lw-timeline__why">“Legacy partner still on Basic”</span></p>
              <p class="lw-timeline__meta">by Linus Torvalds · Aug 14, 2026, 04:10 PM</p>
            </li>
            <li class="lw-timeline__item" data-tone="neutral">
              <p class="lw-timeline__title">Recorded from evidence</p>
              <p class="lw-timeline__meta">Aug 15, 2026, 08:52 AM</p>
            </li>
          </ol>
        </section>
      </div>

      <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
        <button type="button" class="${BUTTON_OUTLINE}">Request waiver</button>
        <button type="button" class="${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid">Acknowledge</button>
      </div>
    </div>
  </div>
</div>`;

/** One trends card. */
function trendCard(title: string, series: ReadonlyArray<[string, string, string]>): string {
  return `
  <div class="rounded-lg bg-surface text-fg shadow-sm">
    <div class="flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)] lw-card-head">
      <p class="lw-card-title text-base font-semibold">${SHIELD}${title}<span class="lw-card-title__window">last 30 days</span></p>
      <span class="${BADGE} bg-transparent text-fg-muted shadow-control">daily</span>
    </div>
    <div class="p-[var(--card-pad)] lw-card-body">
      ${series
        .map(
          ([label, total, tone]) => `
        <div class="lw-series">
          <div class="lw-series__head">
            <span class="lw-series__label">${label}</span>
            <span class="lw-series__total"><strong class="text-${tone}-fg">${total}</strong> in 30d</span>
          </div>
          <svg class="hive-sparkline text-${tone} lw-series__chart" viewBox="0 0 120 24" role="img" aria-label="${label} per day"><path class="hive-sparkline__line" d="M 2 20 L 60 12 L 118 4"/></svg>
        </div>`
        )
        .join('')}
      <p class="lw-note">“Remediated” counts findings that disappeared from evidence without being waived or marked false positive — genuine fixes only.</p>
    </div>
  </div>`;
}

/** The Trends tab. */
const TRENDS_MARKUP = `
<div class="page"><div class="page-body">
  <div class="lw-trends" id="lw-trends">
    ${trendCard('Remediation', [
      ['New findings', '64', 'danger'],
      ['Remediated (genuine fixes)', '41', 'ok'],
    ])}
    ${trendCard('Policy &amp; waivers', [
      ['Waivers granted', '6', 'warn'],
      ['Waivers expired', '2', 'accent'],
      ['Marked false positive', '5', 'violet'],
      ['Policy pack publications', '3', 'accent'],
    ])}
  </div>
</div></div>`;

/** One grade histogram bar. */
function bar(percent: number, fill: string): string {
  return `<span class="lw-bars__col"><span class="lw-bars__fill ${fill}" style="block-size:${percent}%"></span></span>`;
}

/** The Quality ranks tab. */
const RANKS_MARKUP = `
<div class="page"><div class="page-body">
  <div class="lw-ranks" id="lw-ranks">
    <div class="lw-ranks__head">
      <div>
        <h2 class="lw-ranks__title">Quality ranks &amp; grade drift</h2>
        <p class="lw-quiet">73 grades recorded between Jul 16 and Aug 15 · 42 pre-flight · 31 committed</p>
      </div>
      <div role="radiogroup" aria-label="Grade window" class="inline-flex items-center gap-0.5 rounded-md bg-inset p-0.5">
        <button type="button" role="radio" aria-checked="false" class="${BUTTON_SM} text-fg-muted">7d</button>
        <button type="button" role="radio" aria-checked="true" class="${BUTTON_SM} bg-surface text-fg shadow-raised">30d</button>
        <button type="button" role="radio" aria-checked="false" class="${BUTTON_SM} text-fg-muted">90d</button>
        <button type="button" role="radio" aria-checked="false" class="${BUTTON_SM} text-fg-muted">180d</button>
      </div>
    </div>
    <div class="lw-ranks__grid" id="lw-ranks-grid">
      ${[0, 1, 2]
        .map(
          (index) => `
      <div class="rounded-lg bg-surface text-fg shadow-sm lw-rank" id="lw-rank-${index}">
        <div class="flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)] lw-card-head">
          <span class="lw-inline"><span class="${BADGE} bg-accent-soft text-accent-fg">Import</span><span class="fmt fmt--openapi">OpenAPI</span></span>
          <span class="${BADGE_LG} bg-transparent text-fg-muted shadow-control">Latest B</span>
        </div>
        <div class="p-[var(--card-pad)] lw-card-body">
          <div class="lw-rank__meta">
            <span class="lw-quiet">28 grades · openapi-adapter</span>
            <span class="${BADGE} bg-ok-soft text-ok-fg">+6 pts over the window</span>
          </div>
          <div class="lw-rank__stats">
            <div class="lw-mini-stat"><span class="lw-mini-stat__label">Average score</span><span class="lw-mini-stat__value">84</span></div>
            <div class="lw-mini-stat"><span class="lw-mini-stat__label">Blocked</span><span class="lw-mini-stat__value">1</span></div>
            <div class="lw-mini-stat"><span class="lw-mini-stat__label">Warned</span><span class="lw-mini-stat__value">4</span></div>
          </div>
          <div class="lw-rank__charts">
            <div>
              <span class="lw-mini-stat__label">Grade distribution</span>
              <div class="lw-bars" role="img" aria-label="A: 11, B: 20, C: 8, D: 3, F: 0, ungraded: 2" id="lw-bars-${index}">
                ${bar(55, 'bg-ok text-fg-on-accent')}${bar(100, 'bg-ok text-fg-on-accent')}${bar(40, 'bg-warn text-fg-on-accent')}${bar(15, 'bg-orange text-fg-on-accent')}${bar(0, 'bg-danger text-fg-on-accent')}${bar(10, 'bg-transparent text-fg-muted shadow-control')}
              </div>
              <div class="lw-bars__axis" aria-hidden="true"><span>A</span><span>B</span><span>C</span><span>D</span><span>F</span><span>—</span></div>
            </div>
            <div>
              <span class="lw-mini-stat__label">Score trend</span>
              <svg class="hive-sparkline text-ok lw-rank__spark" viewBox="0 0 120 24" role="img" aria-label="Average score per day"><path class="hive-sparkline__line" d="M 2 20 L 60 12 L 118 4"/></svg>
            </div>
          </div>
          <div>
            <div class="lw-rank__attribution-head">
              <span class="lw-mini-stat__label">Finding attribution</span>
              <span class="lw-quiet">38% adapter · 62% specification</span>
            </div>
            <div class="lw-split" role="presentation" id="lw-split-${index}">
              <span class="lw-split__adapter" style="inline-size:38%"></span>
              <span class="lw-split__spec" style="inline-size:62%"></span>
            </div>
            <p class="lw-quiet">41 adapter-attributable · 67 specification-attributable · 2 constructs this adapter declares it cannot read yet</p>
          </div>
        </div>
      </div>`
        )
        .join('')}
    </div>
  </div>
</div></div>`;

/* -------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */

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

/**
 * How many grid columns an element resolves to.
 *
 * @param page The Playwright page.
 * @param selector The grid.
 * @returns The number of tracks.
 */
async function columnCount(page: Page, selector: string): Promise<number> {
  const template = await computed(page, selector, 'grid-template-columns');
  return template.split(' ').filter(Boolean).length;
}

/* -------------------------------------------------------------------------
   The document keeps to one column
   ------------------------------------------------------------------------- */

test.describe('the workspace keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, PAGE_MARKUP);
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  test('holds at 1280px in all nine themes', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);
    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      expect({ theme, overflows: await documentOverflows(page) }).toEqual({
        theme,
        overflows: false,
      });
    }
  });

  test('holds at 1280px at every font scale and both densities', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);
    for (const density of ['comfortable', 'compact']) {
      for (const fontScale of FONT_SCALES) {
        await applyPreferences(page, { fontScale, density });
        expect({ fontScale, density, overflows: await documentOverflows(page) }).toEqual({
          fontScale,
          density,
          overflows: false,
        });
      }
    }
  });

  test('holds with the drawer, the trends tab and the ranks tab open', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    for (const markup of [DRAWER_MARKUP, TRENDS_MARKUP, RANKS_MARKUP]) {
      await mount(page, markup);
      expect(await documentOverflows(page)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------
   The grids really collapse
   ------------------------------------------------------------------------- */

test.describe('the three grids collapse rather than squeezing', () => {
  test('the grades/axes card folds to one column below its breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await mount(page, PAGE_MARKUP);
    expect(await columnCount(page, '#lw-bands')).toBe(2);

    await page.setViewportSize({ width: 940, height: 900 });
    expect(await columnCount(page, '#lw-bands')).toBe(1);
  });

  test('the trends pair folds to one column below its breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await mount(page, TRENDS_MARKUP);
    expect(await columnCount(page, '#lw-trends')).toBe(2);

    await page.setViewportSize({ width: 1000, height: 900 });
    expect(await columnCount(page, '#lw-trends')).toBe(1);
  });

  test('the two-column card still fits its content at the Largest scale', async ({ page }) => {
    // A media-query length is resolved against the browser's *initial* font size, not against
    // `html { font-size }` — so the in-app preference does not move the fold, and the claim
    // to check is the one that matters: at 20px root type the card still holds two columns
    // without pushing the document sideways.
    await page.setViewportSize({ width: 1000, height: 900 });
    await mount(page, PAGE_MARKUP);
    await applyPreferences(page, { fontScale: '2xl' });
    expect(await columnCount(page, '#lw-bands')).toBe(2);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('the rank grid reflows on its own rather than fixing a column count', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mount(page, RANKS_MARKUP);
    const wide = await columnCount(page, '#lw-ranks-grid');
    await page.setViewportSize({ width: 700, height: 900 });
    const narrow = await columnCount(page, '#lw-ranks-grid');
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBe(1);
  });
});

/* -------------------------------------------------------------------------
   The queue's own containment
   ------------------------------------------------------------------------- */

test.describe('the findings queue', () => {
  test('scrolls seven columns inside its own wrapper, never the document', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, PAGE_MARKUP);
    const scrolls = await page
      .locator('#lw-queue-scroller')
      .evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(scrolls).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('clamps a long message to two lines and elides the path to one', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);
    const message = page.locator('#lw-row-1 .lw-finding__message');
    const box = await message.boundingBox();
    const lineHeight = Number.parseFloat(await computed(page, '#lw-row-1 .lw-finding__message', 'line-height'));
    expect(box).not.toBeNull();
    // Two lines and no more, whatever the message says.
    expect(box!.height).toBeLessThanOrEqual(lineHeight * 2 + 2);

    const path = page.locator('#lw-row-1 .lw-finding__path');
    const clipped = await path.evaluate((node) => node.scrollWidth > node.clientWidth);
    expect(clipped).toBe(true);
  });

  test('keeps the Finding block under its ceiling so the ellipsis engages', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mount(page, PAGE_MARKUP);
    // The ceiling is on the block, not on the `<td>`: an auto-layout table ignores a cell's
    // `max-width`, which is how this measured 533px against a 400px clamp the first time.
    const block = await page.locator('#lw-row-1 .lw-finding').boundingBox();
    const rootSize = Number.parseFloat(await computed(page, 'html', 'font-size'));
    expect(block).not.toBeNull();
    // 25rem is the mockup's 400px clamp, in `rem`.
    expect(block!.width).toBeLessThanOrEqual(25 * rootSize + 2);
  });

  test('the facet dot takes the chip’s own ink once the chip is pressed', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);
    // The pressed chip's dot resolves to the chip's text colour; an idle one keeps its tone.
    const pressedDot = await computed(page, '#lw-chip-severity-0 .lw-facet-dot', 'background-color');
    const pressedInk = await computed(page, '#lw-chip-severity-0', 'color');
    expect(pressedDot).toBe(pressedInk);

    const idleDot = await computed(page, '#lw-chip-severity-1 .lw-facet-dot', 'background-color');
    const idleInk = await computed(page, '#lw-chip-severity-1', 'color');
    expect(idleDot).not.toBe(idleInk);
  });

  test('the bulk bar’s field and rule are drawn from the bar’s ink, in every theme', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);
    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      const barInk = await computed(page, '#lw-bulk', 'color');
      const fieldInk = await computed(page, '#lw-bulk-owner', 'color');
      // `color: inherit` — the field's text is the bar's, whatever the palette resolves it to.
      expect({ theme, fieldInk }).toEqual({ theme, fieldInk: barInk });
      // The rule is a wash of that same ink rather than a fixed white, so it survives the six
      // dark palettes as well as the three light ones.
      const rule = await computed(page, '#lw-bulk-rule', 'background-color');
      expect({ theme, transparent: rule === 'rgba(0, 0, 0, 0)' }).toEqual({
        theme,
        transparent: false,
      });
    }
  });

  test('the bulk bar wraps rather than widening the page at the Largest scale', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);
    await applyPreferences(page, { fontScale: '2xl' });
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The drawer and the analysis tabs
   ------------------------------------------------------------------------- */

test.describe('the finding drawer', () => {
  test('wraps a 64-character digest instead of widening the sheet', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);
    const digest = page.locator('#lw-fingerprint');
    const clipped = await digest.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(clipped).toBe(false);
    const height = (await digest.boundingBox())!.height;
    const lineHeight = Number.parseFloat(await computed(page, '#lw-fingerprint', 'line-height'));
    // It wrapped rather than being cut: more than one line, and nothing scrolled.
    expect(height).toBeGreaterThan(lineHeight);
  });

  test('keeps the evidence list to two columns and never scrolls the sheet sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);
    expect(await columnCount(page, '#lw-kv')).toBe(2);
    const overflows = await page
      .locator('#lw-drawer-body')
      .evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(overflows).toBe(false);
  });

  test('draws a marker per history entry, toned by the state it moved to', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, DRAWER_MARKUP);
    const orange = await page
      .locator('#lw-timeline li[data-tone="orange"]')
      .evaluate((node) => getComputedStyle(node, '::before').backgroundColor);
    const neutral = await page
      .locator('#lw-timeline li[data-tone="neutral"]')
      .evaluate((node) => getComputedStyle(node, '::before').backgroundColor);
    expect(orange).not.toBe(neutral);
    expect(orange).not.toBe('rgba(0, 0, 0, 0)');
  });
});

test.describe('the quality-rank card', () => {
  test('draws six equal histogram columns, keeping an empty bucket’s place', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mount(page, RANKS_MARKUP);
    expect(await columnCount(page, '#lw-bars-0')).toBe(6);
    const widths = await page
      .locator('#lw-bars-0 .lw-bars__col')
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
    expect(widths).toHaveLength(6);
    expect(new Set(widths).size).toBe(1);
  });

  test('splits the attribution bar in the proportion its sentence names', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mount(page, RANKS_MARKUP);
    const [adapter, spec] = await page
      .locator('#lw-split-0 > span')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    expect(adapter).toBeGreaterThan(0);
    expect(spec).toBeGreaterThan(adapter);
    expect(Math.round((adapter / (adapter + spec)) * 100)).toBeGreaterThanOrEqual(36);
    expect(Math.round((adapter / (adapter + spec)) * 100)).toBeLessThanOrEqual(40);
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  for (const [name, markup] of [
    ['the queue', PAGE_MARKUP],
    ['the finding drawer', DRAWER_MARKUP],
    ['the trends tab', TRENDS_MARKUP],
    ['the quality-ranks tab', RANKS_MARKUP],
  ] as const) {
    test(`${name} has no serious or critical axe violation`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, markup);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const blocking = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      );
      expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    });
  }

  // One test per theme rather than a loop inside one: `@axe-core/playwright` injects axe into
  // the page once and keeps its own view of what is painted where, so the second and later
  // runs in a single page report the *first* palette's grounds — measured here as a stat
  // strip whose ground read as a blend that `getComputedStyle` said was opaque. A test gets a
  // fresh page, which is also what makes a failure name the theme it happened in.
  for (const theme of THEMES) {
    test(`the queue has no serious or critical violation in ${theme ?? 'light'}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, PAGE_MARKUP);
      await applyPreferences(page, { theme });
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const blocking = results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      );
      expect(
        blocking.flatMap((violation) =>
          violation.nodes.map((node) => `${violation.id} @ ${node.target}`)
        )
      ).toEqual([]);
    });
  }
});

