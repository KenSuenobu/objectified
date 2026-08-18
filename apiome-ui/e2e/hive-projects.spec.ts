import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Projects, measured in a browser (HIVE-6.1, #5312).
 *
 * `tests/projects-hive-redesign.test.tsx` pins what the screen renders,
 * `tests/projects-model.test.ts` pins the derivations behind it, and
 * `tests/projects-css.test.ts` pins the declarations. None of the three can answer the
 * questions that are about *computed layout*, because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — on a page whose card grid is `auto-fit` and whose
 *     create dialog is a two-column form.
 *   • **The card grid really re-flows** 3 → 2 → 1, which is the whole reason its minimum is
 *     stated in `rem` rather than in the mockup's fixed `grid-3`.
 *   • **The stretched link really is under the controls.** `.prj-card__link::after` covers the
 *     whole card and `.prj-card__above` lifts the orbs and the row menu over it; whether a
 *     click at the orb's centre reaches the orb is a hit-test, and only a browser does those.
 *   • **The description cell elides** instead of widening the table, which an auto-layout
 *     table gets wrong when the ceiling is on the `<td>` (HIVE-5.8 measured 533px against a
 *     400px clamp).
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet renders it
 *     — for the card grid, the table and the create dialog. The card is the reason this
 *     matters most: the screen it replaces was a `role="button"` containing three buttons,
 *     which is `nested-interactive`, a serious violation by itself.
 *
 * ### Why it injects markup instead of signing in
 *
 * The same reason `hive-style-guides.spec.ts`, `hive-api-keys.spec.ts` and `hive-audit.spec.ts`
 * give. The states worth measuring — a soft-deleted project beside three live ones, a project
 * with a description that has no break opportunity, a portfolio with eight imports behind it —
 * are the ones a seeded database will not produce on demand, and every read here is
 * tenant-scoped.
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

/** Widths either side of the card grid's `rem` breakpoints, down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1024, 900, 768, 640, 420];

/** A `Button size="sm"` with no colour pair, as `ui/Button` composes its chrome. */
const BUTTON_SM =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium ' +
  'h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs';

/** `variant="ghost"`. */
const BUTTON_GHOST = `${BUTTON_SM} text-fg`;

/** `variant="outline"`. */
const BUTTON_OUTLINE = `${BUTTON_SM} bg-surface text-fg shadow-control`;

/** `variant="danger-soft"`. */
const BUTTON_DANGER_SOFT = `${BUTTON_SM} bg-danger-soft text-danger-fg`;

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

/** A generic glyph, standing in for the Lucide ones. */
const GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" width="16" height="16">' +
  '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';

/**
 * A `<Ring size="sm">`, as the metrics kit composes it.
 *
 * The figure is SVG `<text class="hive-ring__figure">`, not a `<span>` — the kit draws it
 * inside the arc's own coordinate system so it keeps its proportion at every size and font
 * scale, and the ink is the page's rather than the band's. A fixture that made it a tinted
 * `<span>` would report a colour-contrast failure the product does not have, which is the same
 * trap `BUTTON_SM` above is written to avoid.
 */
function ring(figure: string, label: string): string {
  return (
    `<span class="hive-ring text-ok" data-tone="ok" data-size="sm" data-scored="true" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="88" aria-valuetext="88 out of 100 — grade B, good">` +
    '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
    '<circle class="hive-ring__track" cx="24" cy="24" r="21.75" stroke-width="4.5"/>' +
    '<circle class="hive-ring__arc" cx="24" cy="24" r="21.75" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="136.66" stroke-dashoffset="16.40" transform="rotate(-90 24 24)"/>' +
    `<text class="hive-ring__figure" x="24" y="24" font-size="14" text-anchor="middle" dominant-baseline="central">${figure}</text>` +
    '</svg></span>'
  );
}

/** One card of the grid. */
interface CardFixture {
  /** The `id` put on the `<article>`, so a test can reach it. */
  id: string;
  /** The project's name. */
  name: string;
  /** The mono `prj_… · slug` line. */
  identity: string;
  /** Its domain-category pill, if any. */
  domain?: string;
  /** The two-line blurb — the line that has to clamp. */
  summary: string;
  /** `active`, `disabled` or `deleted`. */
  lifecycle: 'active' | 'disabled' | 'deleted';
  /** The version count. */
  versions: string;
  /** The creator's name. */
  creator: string;
}

/** A summary with no break opportunity, long enough to have no chance of fitting. */
const LONG_SUMMARY =
  'Card-refund-and-payout-endpoints-for-the-merchant-platform-with-idempotent-writes-and-webhook-events-for-settlement-reconciliation';

/** Four projects: two ordinary, one with an unbreakable blurb, one soft-deleted. */
const CARDS: readonly CardFixture[] = [
  {
    id: 'prj-card-payments',
    name: 'Payments API',
    identity: 'prj_8f2a1c · payments-api',
    domain: 'Finance',
    summary: LONG_SUMMARY,
    lifecycle: 'active',
    versions: '6 versions',
    creator: 'Ada Lovelace',
  },
  {
    id: 'prj-card-orders',
    name: 'Orders Service',
    identity: 'prj_3b91de · orders-service',
    domain: 'E-commerce',
    summary: 'Order lifecycle: cart → checkout → fulfilment.',
    lifecycle: 'active',
    versions: '5 versions',
    creator: 'Grace Hopper',
  },
  {
    id: 'prj-card-inventory',
    name: 'Inventory Events',
    identity: 'prj_c07e44 · inventory-events',
    domain: 'Logistics',
    summary: 'Stock-level and reservation events. Needs channel descriptions before publish.',
    lifecycle: 'disabled',
    versions: '2 versions',
    creator: 'Ada Lovelace',
  },
  {
    id: 'prj-card-legacy',
    name: 'Legacy Gateway',
    identity: 'prj_11aa09 · legacy-gateway',
    summary: 'Soft-deleted 6 days ago. Restore it, or permanently delete to free the slug.',
    lifecycle: 'deleted',
    versions: '0 versions',
    creator: 'Ada Lovelace',
  },
];

/**
 * One `<article>` of the card grid.
 *
 * @param card See {@link CardFixture}.
 * @returns The card markup.
 */
function projectCard(card: CardFixture): string {
  const deleted = card.lifecycle === 'deleted';
  const statusTone =
    card.lifecycle === 'active'
      ? 'bg-ok-soft text-ok-fg'
      : card.lifecycle === 'deleted'
        ? 'bg-danger-soft text-danger-fg'
        : 'bg-transparent text-fg-muted shadow-control';

  const footer = deleted
    ? `<footer class="prj-card__footer prj-card__above">
         <button type="button" class="${BUTTON_OUTLINE}">${GLYPH}Undelete</button>
         <button type="button" class="${BUTTON_DANGER_SOFT}">${GLYPH}Permanently delete</button>
       </footer>`
    : `<footer class="prj-card__footer">
         <span class="prj-card__creator">
           <span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-5 rounded-full text-2xs font-semibold bg-accent-soft text-accent-fg">AL</span>
           <span class="prj-card__creator-name">${card.creator}</span>
         </span>
         <span class="prj-card__stamp">updated 2h ago</span>
       </footer>`;

  const meter = deleted
    ? `<span class="prj-quiet">Empty project</span>`
    : `<div class="prj-card__scores prj-card__above">
         <button type="button" class="prj-orb prj-orb--action" id="${card.id}-quality" title="Open quality score history">${ring('88', 'Quality score')}<span class="prj-orb__label">Quality</span></button>
         <button type="button" class="prj-orb prj-orb--action" title="Open lint report">${ring('B', 'Lint grade')}<span class="prj-orb__label">Lint</span></button>
         <span class="prj-orb" title="Technical debt (not yet computed)">${ring('—', 'Technical debt')}<span class="prj-orb__label">Debt</span></span>
       </div>`;

  return `
  <article class="prj-card" id="${card.id}" data-lifecycle="${card.lifecycle}">
    <div class="prj-card__body">
      <div class="prj-card__head">
        <span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-11 text-base font-semibold bg-accent-soft text-accent-fg avatar-hex">PA</span>
        <div class="prj-card__identity">
          <div class="prj-card__title-line">
            <h3 class="prj-card__name">${
              deleted
                ? card.name
                : `<a class="prj-card__link" href="#${card.id}">${card.name}</a>`
            }</h3>
            ${card.domain ? `<span class="${BADGE} bg-violet-soft text-violet-fg">${card.domain}</span>` : ''}
          </div>
          <p class="prj-card__id mono">${card.identity}</p>
        </div>
        <span class="${BADGE} ${statusTone}">${card.lifecycle === 'active' ? 'Active' : card.lifecycle === 'deleted' ? 'Deleted' : 'Disabled'}</span>
      </div>
      <p class="prj-card__summary">${card.summary}</p>
      <div class="prj-card__meter">
        ${meter}
        <span class="prj-card__versions mono">${card.versions}</span>
      </div>
    </div>
    ${footer}
    ${
      deleted
        ? ''
        : `<div class="prj-card__actions prj-card__above">
             <button type="button" class="${BUTTON_GHOST} px-1.5" id="${card.id}-menu" aria-label="Actions for ${card.name}">${GLYPH}</button>
           </div>`
    }
  </article>`;
}

/** The toolbar both views share, as `DataTableToolbar` composes it. */
const TOOLBAR = `
<div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
  <div class="relative flex items-center">
    <input type="search" aria-label="Filter projects" placeholder="Filter projects…  ( / )"
      class="hive-control flex w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg h-[var(--control-h-sm)] w-[16.25rem] max-w-full pl-8" />
  </div>
  <button type="button" aria-pressed="true" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-fg text-surface">All <span class="tabular-nums">4</span></button>
  <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]">Active <span class="tabular-nums text-fg-muted">2</span></button>
  <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]">Needs attention <span class="tabular-nums text-fg-muted">2</span></button>
  <button type="button" aria-pressed="false" class="inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]">Deleted <span class="tabular-nums text-fg-muted">1</span></button>
  <span aria-hidden="true" class="flex-1"></span>
  <button type="button" class="${BUTTON_GHOST}">Sorted by name ↑</button>
  <div role="radiogroup" aria-label="List view" class="inline-flex items-center gap-0.5 rounded-md bg-inset p-0.5">
    <button type="button" role="radio" aria-checked="true" class="${BUTTON_SM} bg-surface text-fg">${GLYPH}Cards</button>
    <button type="button" role="radio" aria-checked="false" class="${BUTTON_SM} text-fg-muted">${GLYPH}Table</button>
  </div>
</div>`;

/** The page header, as `PageHeader` composes it. */
const HEADER = `
<header class="page-header">
  <div class="page-header__inner">
    <div class="page-header__row">
      <div class="min-w-0">
        <h1 class="page-title">Projects</h1>
        <p class="page-desc">4 projects · avg quality 84 · 2 active · 1 deleted</p>
      </div>
      <div class="page-actions">
        <span class="prj-deleted-switch">
          <button type="button" role="switch" aria-checked="true" aria-label="Show soft-deleted projects in the list" id="prj-switch" class="h-5 w-9 rounded-full bg-accent"></button>
          <label for="prj-switch">Show deleted</label>
        </span>
        <button type="button" class="${BUTTON_OUTLINE}">${GLYPH}Import</button>
        <button type="button" class="${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid">${GLYPH}New project</button>
      </div>
    </div>
  </div>
</header>`;

/** The portfolio trend card, whose chart is an `aspect-ratio` box. */
const PORTFOLIO = `
<section class="rounded-lg bg-surface shadow-[var(--shadow-sm)]" id="prj-portfolio">
  <div class="prj-portfolio__header flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)]">
    <h3 class="prj-portfolio__title text-base font-semibold text-fg">${GLYPH}Portfolio quality trend
      <span class="prj-portfolio__note">Average quality across projects after each import (this browser)</span>
    </h3>
    <span class="${BADGE} bg-ok-soft text-ok-fg">avg 84</span>
  </div>
  <div class="p-[var(--card-pad)]">
    <div class="prj-portfolio__chart text-ok">
      <svg viewBox="0 0 800 140" preserveAspectRatio="none" role="img" aria-label="Portfolio quality trend — 8 points, latest average 84" focusable="false">
        <g class="prj-portfolio__grid"><line x1="30" y1="12" x2="792" y2="12"/><line x1="30" y1="53" x2="792" y2="53"/><line x1="30" y1="94" x2="792" y2="94"/></g>
        <g class="prj-portfolio__ticks" font-size="9"><text x="0" y="15">100</text><text x="0" y="56">85</text><text x="0" y="97">70</text></g>
        <path class="prj-portfolio__area" d="M30 95 L400 70 L792 30 L792 128 L30 128Z"/>
        <path class="prj-portfolio__line" d="M30 95 L400 70 L792 30"/>
        <circle class="prj-portfolio__dot" cx="792" cy="30" r="4"/>
      </svg>
    </div>
    <div class="prj-portfolio__axis"><span>start</span><span>mid</span><span>now</span></div>
  </div>
</section>`;

/** The cards view: the header, the panel with its toolbar and grid, and the trend card. */
const CARDS_MARKUP = `
<div class="page">
  ${HEADER}
  <div class="page-body">
    <div class="rounded-lg bg-surface shadow-[var(--shadow-sm)] overflow-hidden" id="prj-panel">
      ${TOOLBAR}
      <div class="prj-grid" id="prj-grid">
        ${CARDS.map(projectCard).join('')}
        <button type="button" class="prj-tile" id="prj-tile">
          <span aria-hidden="true" class="hive-empty-art size-16"><span class="hive-empty-art__hex"></span>${GLYPH}</span>
          <span class="prj-tile__title">New project</span>
          <span class="prj-tile__desc">Start blank, from a template, or design it with AI.</span>
        </button>
      </div>
    </div>
    ${PORTFOLIO}
  </div>
</div>`;

/** One `<tr>` of the table view. */
function projectRow(card: CardFixture): string {
  const deleted = card.lifecycle === 'deleted';
  return `
  <tr id="${card.id}-row" class="group ${deleted ? 'prj-row--deleted' : ''}">
    <td class="${TD_CLASS} w-10 pr-0"><input type="checkbox" aria-label="Select ${card.name}" /></td>
    <td class="${TD_CLASS}">
      <div class="prj-identity">
        <span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-6.5 text-2xs font-semibold bg-accent-soft text-accent-fg avatar-hex">PA</span>
        <span class="prj-identity__text">
          <span class="prj-identity__line">
            <a class="prj-identity__link" href="#${card.id}"><div class="font-medium whitespace-nowrap text-fg">${card.name}</div></a>
            ${card.domain ? `<span class="${BADGE} bg-violet-soft text-violet-fg">${card.domain}</span>` : ''}
          </span>
          <div class="mt-px text-xs text-fg-muted mono">${card.identity.split(' · ')[1]}</div>
        </span>
      </div>
    </td>
    <td class="${TD_CLASS}"><div class="prj-desc" id="${card.id}-desc">${card.summary}</div></td>
    <td class="${TD_CLASS}">
      <button type="button" class="prj-trend prj-trend--action" title="Open quality score history">
        <svg class="hive-sparkline prj-trend__spark text-ok" viewBox="0 0 120 24" role="img" aria-label="Quality trend for ${card.name} — 3 points, latest 88" focusable="false"><path class="hive-sparkline__line" d="M2 20 L60 12 L118 4"/></svg>
        <span class="prj-trend__value mono">88<span class="prj-trend__grade"> (B)</span></span>
      </button>
    </td>
    <td class="${TD_CLASS} text-right"><span class="prj-num mono">${card.versions.split(' ')[0]}</span></td>
    <td class="${TD_CLASS}"><span class="prj-status"><span class="${BADGE} ${deleted ? 'bg-danger-soft text-danger-fg' : 'bg-ok-soft text-ok-fg'}">${deleted ? 'Deleted' : 'Active'}</span></span></td>
    <td class="${TD_CLASS}"><span class="prj-creator"><div class="font-medium whitespace-nowrap text-fg">${card.creator}</div><div class="mt-px text-xs text-fg-muted">ada@example.com</div></span></td>
    <td class="${TD_CLASS}"><span class="prj-stamp">08/15/26 09:12 AM</span></td>
    <td class="${TD_CLASS} text-right">
      <div data-row-actions="" class="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <button type="button" class="${BUTTON_GHOST} ${deleted ? 'prj-restore' : ''} px-1.5" aria-label="${deleted ? 'Undelete' : 'Edit'} ${card.name}">${GLYPH}</button>
        <button type="button" class="${BUTTON_GHOST} px-1.5" aria-label="Actions for ${card.name}">${GLYPH}</button>
      </div>
    </td>
  </tr>`;
}

/** The table view. */
const TABLE_MARKUP = `
<div class="page">
  ${HEADER}
  <div class="page-body">
    <div class="${TABLE_CARD}">
      ${TOOLBAR}
      <div class="overflow-x-auto" id="prj-scroll" tabindex="0" role="region" aria-label="Projects in this workspace">
        <table class="w-full border-separate border-spacing-0 ${TABLE_MIN_WIDTH}">
          <caption class="sr-only">Projects in this workspace</caption>
          <thead>
            <tr>
              <th scope="col" class="${TH_CLASS} w-10 pr-0"><span class="sr-only">Select</span></th>
              <th scope="col" class="${TH_CLASS}">Project</th>
              <th scope="col" class="${TH_CLASS}">Description</th>
              <th scope="col" class="${TH_CLASS}">Quality trend</th>
              <th scope="col" class="${TH_CLASS} text-right">Versions</th>
              <th scope="col" class="${TH_CLASS}">Status</th>
              <th scope="col" class="${TH_CLASS}">Created by</th>
              <th scope="col" class="${TH_CLASS}">Updated</th>
              <th scope="col" class="${TH_CLASS} text-right"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>${CARDS.map(projectRow).join('')}</tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5 text-xs text-fg-muted">
        <span>4 projects · sorted by name ↑</span>
      </div>
    </div>
  </div>
</div>`;

/** The create dialog, whose body is the two-column project form. */
const DIALOG_MARKUP = `
<div class="page">
  <div class="page-body">
    <div class="prj-dialog grid w-full max-w-[60rem] gap-4 rounded-xl bg-surface p-6 shadow-lg" role="dialog" aria-label="New project" id="prj-dialog">
      <div class="prj-dialog__header flex flex-col gap-1 pr-8">
        <span class="tnt-icon-tile" data-tone="honey">${GLYPH}</span>
        <span class="prj-dialog__heading">
          <h2 class="text-xl font-semibold leading-snug text-fg">New project</h2>
          <p class="text-sm text-fg-muted">Start from a template, fill in the basics, or describe the API and let AI draft it.</p>
        </span>
      </div>
      <div class="prj-dialog__body">
        <div class="prj-template" id="prj-template">
          <span class="tnt-icon-tile" data-tone="accent">${GLYPH}</span>
          <div class="prj-template__text">
            <p class="prj-template__title">Starting template</p>
            <p class="prj-template__desc">Presets OpenAPI fields (summary, contact, license, terms). You can edit everything before continuing.</p>
          </div>
          <select class="hive-control prj-template__select h-[var(--control-h)] rounded-md bg-surface px-3 text-sm text-fg" aria-label="Starting template"><option>Blank</option></select>
        </div>
        <div class="prj-form" id="prj-form">
          <section class="prj-form__col">
            <h3 class="prj-form__title">Basic information</h3>
            <div class="flex flex-col gap-1.5">
              <label class="text-sm font-medium text-fg" for="prj-name">Project name</label>
              <input id="prj-name" class="hive-control h-[var(--control-h)] w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-sm font-medium text-fg" for="prj-slug">Slug</label>
              <input id="prj-slug" class="hive-control mono h-[var(--control-h)] w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg" />
              <p class="text-xs text-fg-subtle">URL-friendly identifier — lowercase letters, numbers and dashes. Suggested from the name.</p>
            </div>
          </section>
          <section class="prj-form__col">
            <h3 class="prj-form__title">API metadata <span class="prj-form__title-aside">(OpenAPI info)</span></h3>
            <div class="prj-form__pair" id="prj-pair">
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-medium text-fg" for="prj-contact">Contact name</label>
                <input id="prj-contact" class="hive-control h-[var(--control-h)] w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg" />
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-sm font-medium text-fg" for="prj-email">Contact email</label>
                <input id="prj-email" class="hive-control h-[var(--control-h)] w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg" />
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-sm font-medium text-fg" for="prj-terms">Terms of service URL</label>
              <div class="prj-form__url">
                <input id="prj-terms" class="hive-control h-[var(--control-h)] w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg" />
                <button type="button" class="${BUTTON_OUTLINE} size-[var(--control-h)] p-0" aria-label="Open Terms of service URL in a new tab">${GLYPH}</button>
              </div>
            </div>
          </section>
        </div>
      </div>
      <div class="prj-dialog__footer flex items-center justify-end gap-2">
        <span class="prj-dialog__footnote">You can change everything later in project settings.</span>
        <button type="button" class="${BUTTON_OUTLINE}">Cancel</button>
        <button type="button" class="${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid">Create project</button>
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

test.describe('the projects page keeps the document to one column', () => {
  for (const width of WIDTHS) {
    test(`the cards view does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, CARDS_MARKUP);
      expect(await documentOverflows(page)).toBe(false);
    });

    test(`the create dialog does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, DIALOG_MARKUP);
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const theme of THEMES) {
    test(`does not scroll sideways in the ${theme ?? 'light'} theme`, async ({ page }) => {
      await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
      await mount(page, CARDS_MARKUP);
      await applyPreferences(page, { theme });
      expect(await documentOverflows(page)).toBe(false);
    });
  }

  for (const fontScale of FONT_SCALES) {
    for (const density of ['comfortable', 'compact']) {
      test(`the cards view holds at the ${fontScale} scale, ${density}`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, CARDS_MARKUP);
        await applyPreferences(page, { fontScale, density });
        expect(await documentOverflows(page)).toBe(false);
      });

      test(`the create dialog holds at the ${fontScale} scale, ${density}`, async ({ page }) => {
        await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
        await mount(page, DIALOG_MARKUP);
        await applyPreferences(page, { fontScale, density });
        expect(await documentOverflows(page)).toBe(false);
      });
    }
  }

  test('scrolls the projects table inside its own wrapper when eight columns will not fit', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, TABLE_MARKUP);

    expect(
      await page.locator('#prj-scroll').evaluate((node) => node.scrollWidth > node.clientWidth + 1)
    ).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('gives that scroll container a name and a place in the tab order', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await mount(page, TABLE_MARKUP);
    // WCAG 2.1.1: a region that scrolls must be reachable without a pointer.
    await expect(page.locator('#prj-scroll')).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#prj-scroll')).toHaveAttribute('aria-label', /Projects/);
  });
});

/* -------------------------------------------------------------------------
   The grids re-flow, which is what the rem minimums are for
   ------------------------------------------------------------------------- */

test.describe('the card grid', () => {
  test('runs several across on a desktop and folds to one on a phone', async ({ page }) => {
    // `auto-fit` over a `rem` minimum rather than the mockup's fixed `grid-3`: how many
    // columns fit is a property of the space the rail leaves, not a number to hard-code. What
    // matters is that the count falls as the space does and never leaves a card too narrow to
    // read — which is what the three assertions below say.
    await page.setViewportSize({ width: 1440, height: 900 });
    await mount(page, CARDS_MARKUP);
    expect(await gridColumns(page, '#prj-grid')).toBeGreaterThanOrEqual(3);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '#prj-grid')).toBe(2);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await gridColumns(page, '#prj-grid')).toBe(1);
  });

  test('folds at the largest font scale even on a desktop, which px could not do', async ({
    page,
  }) => {
    // The whole reason the minimum is `rem`: at the Largest scale a 1024px viewport is
    // narrower *in text* than a 900px one at the default, so a px minimum would keep three
    // columns exactly where a card no longer fits in one.
    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, CARDS_MARKUP);
    await applyPreferences(page, { fontScale: '2xl' });
    expect(await gridColumns(page, '#prj-grid')).toBeLessThan(3);
    expect(await documentOverflows(page)).toBe(false);
  });

  test('clamps the blurb to two lines whatever it says', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, CARDS_MARKUP);

    const [clamped, ordinary] = await page.evaluate(() => {
      const read = (id: string) => {
        const node = document.querySelector(`#${id} .prj-card__summary`) as HTMLElement;
        const line = parseFloat(getComputedStyle(node).lineHeight);
        return Math.round(node.getBoundingClientRect().height / line);
      };
      return [read('prj-card-payments'), read('prj-card-orders')];
    });
    // The unbreakable blurb and the ordinary one are the same two lines tall.
    expect(clamped).toBe(2);
    expect(ordinary).toBe(2);
  });

  test('does not fade a card that needs attention', async ({ page }) => {
    // The screen this replaces put `opacity: .9` on a deleted card, which fades the amber
    // warning along with everything else. The frame is what carries it now.
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, CARDS_MARKUP);
    const opacity = await page
      .locator('#prj-card-legacy')
      .evaluate((node) => getComputedStyle(node as Element).opacity);
    expect(opacity).toBe('1');
  });
});

/* -------------------------------------------------------------------------
   The stretched link, hit-tested
   ------------------------------------------------------------------------- */

test.describe('the card’s stretched link', () => {
  test('takes a click anywhere on the card that is not a control', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, CARDS_MARKUP);

    const hit = await page.evaluate(() => {
      const card = document.querySelector('#prj-card-orders') as HTMLElement;
      const box = card.getBoundingClientRect();
      // The blurb's right-hand end: card, not control.
      const target = document.elementFromPoint(box.right - 12, box.top + box.height / 2);
      return target?.closest('a')?.className ?? null;
    });
    expect(hit).toContain('prj-card__link');
  });

  test('leaves the score orbs and the row menu above it', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, CARDS_MARKUP);

    const reached = await page.evaluate(() => {
      const at = (selector: string) => {
        const node = document.querySelector(selector) as HTMLElement;
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit ? (hit.closest('button')?.id ?? hit.closest('a')?.className ?? 'none') : 'none';
      };
      return {
        orb: at('#prj-card-orders-quality'),
        menu: at('#prj-card-orders-menu'),
      };
    });
    expect(reached.orb).toBe('prj-card-orders-quality');
    expect(reached.menu).toBe('prj-card-orders-menu');
  });

  test('is one tab stop, not a card full of them', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, CARDS_MARKUP);
    const roles = await page
      .locator('#prj-card-orders')
      .evaluate((node) => (node as Element).getAttribute('role'));
    expect(roles).toBeNull();
  });
});

/* -------------------------------------------------------------------------
   Rows keep their shape
   ------------------------------------------------------------------------- */

test.describe('the projects table', () => {
  test('elides a description with no break opportunity rather than widening the row', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, TABLE_MARKUP);

    const cell = page.locator('#prj-card-payments-desc');
    const width = await cell.evaluate((node) => node.getBoundingClientRect().width);
    const cap = await cell.evaluate((node) => parseFloat(getComputedStyle(node).maxWidth));
    expect(width).toBeLessThanOrEqual(cap + 1);
  });

  test('keeps the project-name link in the row’s ink until hovered', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, TABLE_MARKUP);

    const [linkInk, rowInk] = await page.evaluate(() => {
      const link = document.querySelector('#prj-card-orders-row .prj-identity__link') as Element;
      const row = document.querySelector('#prj-card-orders-row') as Element;
      return [getComputedStyle(link).color, getComputedStyle(row).color];
    });
    expect(linkInk).toBe(rowInk);
  });

  test('puts the arrow cursor back on a row that will not open', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, TABLE_MARKUP);
    const cursor = await page
      .locator('#prj-card-legacy-row')
      .evaluate((node) => getComputedStyle(node as Element).cursor);
    expect(cursor).toBe('default');
  });
});

/* -------------------------------------------------------------------------
   Accessibility
   ------------------------------------------------------------------------- */

test.describe('accessibility', () => {
  const SURFACES = [
    ['the cards view', CARDS_MARKUP],
    ['the table view', TABLE_MARKUP],
    ['the create dialog', DIALOG_MARKUP],
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

