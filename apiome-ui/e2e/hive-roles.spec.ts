import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Roles, measured in a browser (HIVE-5.3, #5306).
 *
 * `tests/roles-hive-redesign.test.tsx` pins what the page renders, `tests/roles-model.test.ts`
 * pins the derivations behind it, and `tests/roles-css.test.ts` pins the declarations. None of
 * the three can answer the acceptance criteria that are questions about *computed layout*,
 * because jsdom compiles no CSS:
 *
 *   • **"No horizontal document scroll at ≥1280 px"**, held across all nine themes, both
 *     densities and all six font scales — and this page is the hardest case in the app,
 *     because a permission matrix is six columns that cannot be narrowed and thirteen labels
 *     that cannot be abbreviated.
 *   • **The matrix scrolls inside its own wrapper** when the viewport cannot hold it, rather
 *     than taking the document with it.
 *   • **The four cell states are visually distinct** — granted, denied, partial and locked
 *     have to differ in computed `background-color`, and locked must not be a fade.
 *   • **A long custom role name elides** rather than widening the list pane past its track.
 *   • **The two panes really collapse** at the width their `@media` rule names, rather than
 *     the rule being dead.
 *   • **"axe: zero serious/critical violations"**, on the markup as the stylesheet actually
 *     renders it.
 *
 * ### Why it injects markup instead of signing in
 *
 * The same reason `hive-members.spec.ts` and `hive-tenants.spec.ts` give. The states worth
 * measuring — a partly granted row, a locked cell, a role name long enough to break its pane
 * — are precisely the ones a seeded database will not produce on demand, and both reads are
 * tenant-scoped.
 *
 * So this loads `/login`, which compiles the real `globals.css` and needs no session, and
 * injects the page's own markup into it. What the markup *is* — that the components really
 * compose these classes in this nesting — is what the jsdom suite pins.
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

/** Widths either side of the pane breakpoint this ticket adds (60rem), down to a phone. */
const WIDTHS = [1440, DESKTOP_WIDTH, 1024, 961, 959, 900, 640, 420];

/** A custom role name with no break opportunity, long enough to have no chance of fitting. */
const LONG_ROLE_NAME =
  'Release-and-sunset-manager-for-partner-integrations-and-payments';

/**
 * A `Button size="sm"` with no colour pair, as `ui/Button` composes its chrome.
 *
 * The pair is added per variant below rather than layered on top of a default one: the real
 * component runs its classes through `tailwind-merge`, which *drops* the conflicting
 * utility, and a fixture that keeps both gets whichever the generated stylesheet happens to
 * order last — which is how a hand-written fixture invents a contrast failure the product
 * does not have.
 */
const BUTTON_SM =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium ' +
  'h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs';

/** `variant="outline"`. */
const BUTTON_OUTLINE = `${BUTTON_SM} bg-surface text-fg shadow-control`;

/** `variant="primary"` — the ink fill. */
const BUTTON_PRIMARY = `${BUTTON_SM} bg-ink text-ink-fg shadow-control-solid`;

/** `variant="danger-soft"`. */
const BUTTON_DANGER = `${BUTTON_SM} bg-danger-soft text-danger-fg`;

/** `variant="ghost"`. */
const BUTTON_GHOST = `${BUTTON_SM} text-fg`;

/** `DataTableBulkAction`, the control cut for an inverted bar. */
const BULK_ACTION = `${BUTTON_SM} bg-surface/12 text-surface`;

/** The same, taking the surface as its ground — the save bar's primary. */
const BULK_PRIMARY = `${BUTTON_SM} bg-surface text-fg`;

/** A `Badge`, as `ui/Badge` composes it. */
const BADGE =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full ' +
  'px-[0.4375rem] text-2xs font-semibold leading-none tracking-[0.01em] h-5';

/**
 * The check glyph, standing in for the Lucide one.
 *
 * `fill="none" stroke="currentColor"` is not decoration here: it is how Lucide draws, and it
 * is what lets `color: transparent` hide the glyph in a denied cell. A fixture whose path
 * takes the default black fill shows a check in every cell and hides the very state this
 * suite is measuring.
 */
const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">' +
  '<path d="M20 6 9 17l-5-5"/></svg>';

/** The thirteen resources, exactly as `rolesModel.RESOURCES` lists them. */
const RESOURCES: readonly [string, string][] = [
  ['projects', 'Projects'],
  ['versions', 'Versions'],
  ['classes', 'Classes'],
  ['properties', 'Properties'],
  ['paths', 'Paths'],
  ['types', 'Primitives / Types'],
  ['imports', 'Imports'],
  ['members', 'Members'],
  ['api_keys', 'API keys'],
  ['billing', 'Billing'],
  ['lint_findings', 'Lint findings'],
  ['verification_targets', 'Verification targets'],
  ['verification_evidence', 'Verification evidence'],
];

/** The five actions. */
const ACTIONS: readonly [string, string][] = [
  ['view', 'View'],
  ['create', 'Create'],
  ['edit', 'Edit'],
  ['delete', 'Delete'],
  ['publish', 'Publish'],
];

/**
 * One `.rol-perm` toggle.
 *
 * @param options.pressed Its `aria-pressed` value.
 * @param options.label Its accessible name.
 * @param options.disabled Whether it is locked.
 * @param options.id An optional dom id, so a test can reach it.
 * @returns The button markup.
 */
function perm(options: {
  pressed: 'true' | 'false' | 'mixed';
  label: string;
  disabled?: boolean;
  id?: string;
}): string {
  const { pressed, label, disabled = false, id } = options;
  return (
    `<button type="button" class="rol-perm"${id ? ` id="${id}"` : ''} ` +
    `aria-pressed="${pressed}" aria-label="${label}"${disabled ? ' disabled' : ''}>${CHECK}</button>`
  );
}

/**
 * One matrix row.
 *
 * The first three resources carry the states worth measuring; the rest are ordinary.
 *
 * @param index Which resource.
 * @returns The `<tr>` markup.
 */
function matrixRow(index: number): string {
  const [key, label] = RESOURCES[index];
  // Row 0 is partly granted (so `mixed` is on screen), row 1 fully, row 2 locked.
  const rowState = index === 0 ? 'mixed' : index === 1 ? 'true' : 'false';
  const locked = index === 2;
  const cells = ACTIONS.map(([, actionLabel], column) => {
    const pressed = index === 1 || (index === 0 && column === 0) ? 'true' : 'false';
    const id = index === 0 && column === 0 ? 'rol-cell-granted' : undefined;
    const deniedId = index === 0 && column === 1 ? 'rol-cell-denied' : undefined;
    const lockedId = locked && column === 0 ? 'rol-cell-locked' : undefined;
    return `<td>${perm({
      pressed,
      label: `${label} ${actionLabel}`,
      disabled: locked,
      id: id ?? deniedId ?? lockedId,
    })}</td>`;
  }).join('');

  return `
  <tr>
    <th scope="row" class="font-normal">
      <span class="rol-res">
        ${perm({
          pressed: rowState as 'true' | 'false' | 'mixed',
          label: `All ${label} permissions`,
          disabled: locked,
          id: index === 0 ? 'rol-row-mixed' : undefined,
        })}
        <span>
          <span class="rol-res__name">${label}</span>
          <span class="rol-res__key mono">${key}</span>
        </span>
      </span>
    </th>
    ${cells}
  </tr>`;
}

/**
 * One role in the list.
 *
 * @param options.slug Its slug, used as the row's dom id.
 * @param options.name Its name.
 * @param options.builtin Whether it is seeded.
 * @param options.count How many members hold it.
 * @param options.current Whether it is the role being edited.
 * @returns The `<li>` markup.
 */
function roleItem(options: {
  slug: string;
  name: string;
  builtin: boolean;
  count: number;
  current?: boolean;
}): string {
  const { slug, name, builtin, count, current = false } = options;
  return `
  <li>
    <button type="button" class="rol-item" id="rol-item-${slug}"${
      current ? ' aria-current="true"' : ''
    }>
      <span class="tnt-icon-tile" aria-hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20"/></svg></span>
      <span class="rol-item__text">
        <span class="rol-item__name"><span class="rol-item__label">${name}</span></span>
        <span class="rol-item__sub">${builtin ? 'Built-in' : 'Custom'}</span>
      </span>
      <span class="rol-item__count">${count}</span>
    </button>
  </li>`;
}

/** The page, as `RolesClient` composes it. */
const PAGE_MARKUP = `
<div class="page-body">
  <div class="rol-panes" id="rol-panes">
    <aside class="flex flex-col gap-3" aria-label="Roles" id="rol-aside">
      <div class="relative flex items-center">
        <input type="search" aria-label="Filter roles" placeholder="Filter roles…"
               class="hive-control h-[var(--control-h-sm)] w-full max-w-full pl-8 text-sm" />
      </div>
      <div>
        <p class="tnt-caps px-3 pb-1.5">Built-in</p>
        <ul class="rol-list" aria-label="Built-in roles">
          ${roleItem({ slug: 'owner', name: 'Owner', builtin: true, count: 1, current: true })}
          ${roleItem({ slug: 'admin', name: 'Admin', builtin: true, count: 4 })}
        </ul>
      </div>
      <div>
        <p class="tnt-caps px-3 pb-1.5">Custom</p>
        <ul class="rol-list" aria-label="Custom roles">
          ${roleItem({ slug: 'long', name: LONG_ROLE_NAME, builtin: false, count: 128 })}
        </ul>
      </div>
    </aside>

    <section class="flex min-w-0 flex-col gap-4" aria-label="Role: Owner" id="rol-editor">
      <div class="rounded-lg bg-surface shadow-sm">
        <div class="flex flex-row items-start gap-4 border-b border-border p-[var(--card-pad)]">
          <span class="tnt-icon-tile" data-tone="accent" aria-hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20"/></svg></span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="rol-name-static" id="rol-name">${LONG_ROLE_NAME}</h2>
              <span class="${BADGE} bg-neutral-soft text-neutral-fg">Built-in</span>
              <span class="${BADGE} bg-honey-soft text-honey-fg">Unsaved</span>
            </div>
            <p class="mono mt-0.5 text-xs text-fg-muted">owner · 1 member</p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button type="button" class="${BUTTON_OUTLINE}">Duplicate</button>
            <button type="button" class="${BUTTON_DANGER}">Delete</button>
            <button type="button" class="${BUTTON_PRIMARY}">Save changes</button>
          </div>
        </div>

        <div class="flex flex-col gap-4 p-[var(--card-pad)]">
          <p class="tnt-lock-note" id="rol-lock">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="mt-0.5 size-[var(--icon-dense)] shrink-0"><path d="M12 2v20"/></svg>
            <span>Built-in roles keep their name — seat licensing and identity-provider group mapping refer to it.</span>
          </p>

          <div class="space-y-2">
            <label class="text-sm font-medium text-fg" for="rol-desc">Description</label>
            <textarea id="rol-desc" rows="2" class="hive-control w-full text-sm">Cuts and publishes versions.</textarea>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="flex items-center gap-2 text-sm text-fg-muted">Permission matrix <span aria-hidden>·</span> <span class="tabular-nums">23 of 65 cells on</span></p>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="${BUTTON_GHOST}">Grant view on all</button>
              <button type="button" class="${BUTTON_GHOST}">Clear all</button>
            </div>
          </div>

          <div class="rol-matrix-wrap" id="rol-scroll">
            <table class="rol-matrix" id="rol-matrix">
              <caption class="sr-only">Permissions this role grants, by resource and action</caption>
              <thead>
                <tr>
                  <th scope="col">Resource</th>
                  ${ACTIONS.map(([, label]) => `<th scope="col"><span>${label}</span></th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${RESOURCES.map((_, index) => matrixRow(index)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="rol-save-bar" role="status" id="rol-save-bar">
        <span class="rol-save-bar__count"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20"/></svg>3 unsaved changes</span>
        <button type="button" class="${BULK_ACTION}">Discard</button>
        <button type="button" class="${BULK_PRIMARY}">Save changes</button>
      </div>
    </section>
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

test.describe('the roles page keeps the document to one column', () => {
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

  test('lets the matrix scroll inside its own wrapper rather than taking the page', async ({
    page,
  }) => {
    // Narrow enough that six columns genuinely cannot fit: thirteen labelled rows and five
    // toggle columns have a floor, and the point is where that floor lands — inside the
    // wrapper, never on the document.
    await page.setViewportSize({ width: 420, height: 900 });
    await mount(page, PAGE_MARKUP);

    expect(await documentOverflows(page)).toBe(false);
    expect(
      await page.locator('#rol-scroll').evaluate((node) => node.scrollWidth > node.clientWidth + 1)
    ).toBe(true);
  });

  test('collapses the two panes to one column below the breakpoint', async ({ page }) => {
    /**
     * Whether the aside and the editor sit side by side.
     *
     * @returns True when the editor starts to the right of the aside.
     */
    const sideBySide = () =>
      page.evaluate(() => {
        const aside = document.querySelector('#rol-aside')!.getBoundingClientRect();
        const editor = document.querySelector('#rol-editor')!.getBoundingClientRect();
        return editor.left >= aside.right;
      });

    await page.setViewportSize({ width: 1024, height: 900 });
    await mount(page, PAGE_MARKUP);
    expect(await sideBySide()).toBe(true);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(await sideBySide()).toBe(false);
  });

  test('elides a long role name rather than widening the list pane', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    // Overflowing its own box is the *point*: that is what `text-overflow: ellipsis` needs.
    expect(
      await page
        .locator('#rol-item-long .rol-item__label')
        .evaluate((node) => node.scrollWidth > node.clientWidth + 1)
    ).toBe(true);
    expect(await documentOverflows(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The four cell states
   ------------------------------------------------------------------------- */

test.describe('how a permission cell shows its state', () => {
  /**
   * Read the painted state of one toggle.
   *
   * @param page The Playwright page.
   * @param selector Which toggle.
   * @returns Its computed ground, ring and opacity.
   */
  const read = (page: Page, selector: string) =>
    page.locator(selector).evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        background: style.backgroundColor,
        shadow: style.boxShadow,
        opacity: style.opacity,
      };
    });

  test('paints granted, denied, partial and locked differently', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    const granted = await read(page, '#rol-cell-granted');
    const denied = await read(page, '#rol-cell-denied');
    const partial = await read(page, '#rol-row-mixed');
    const locked = await read(page, '#rol-cell-locked');

    const grounds = [granted.background, denied.background, partial.background, locked.background];
    expect(new Set(grounds).size).toBe(4);
    // Granted is the only one with no ring; the other three are told apart by ground *and*
    // by the hairline around it.
    expect(granted.shadow).toBe('none');
    expect(denied.shadow).not.toBe('none');
    expect(partial.shadow).not.toBe('none');
  });

  test('draws the locked state rather than fading it, in every theme', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    for (const theme of THEMES) {
      await applyPreferences(page, { theme });
      const locked = await read(page, '#rol-cell-locked');
      const granted = await read(page, '#rol-cell-granted');
      // The measured rule the tenants, members and roles blocks all keep: a fade dims the
      // resource label beside the control along with the control.
      expect({ theme, opacity: locked.opacity }).toEqual({ theme, opacity: '1' });
      expect({ theme, same: locked.background === granted.background }).toEqual({
        theme,
        same: false,
      });
    }
  });

  test('keeps the toggle square as the font scale grows', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
    await mount(page, PAGE_MARKUP);

    for (const fontScale of ['xs', '2xl']) {
      await applyPreferences(page, { fontScale });
      const box = await page
        .locator('#rol-cell-granted')
        .evaluate((node) => node.getBoundingClientRect());
      expect({ fontScale, square: Math.abs(box.width - box.height) < 1 }).toEqual({
        fontScale,
        square: true,
      });
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
        .include('#rol-panes')
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
