/**
 * The access-audit redesign, rendered (HIVE-5.5, #5308).
 *
 * `audit-model.test.ts` holds the derivations; this holds the screen that makes them, against
 * a mocked `global.fetch` returning the `{success, data}` envelope the `/api/access` proxy
 * really answers with. What it pins is the ticket's four acceptance criteria and the mockup's
 * **Keeps (1:1)** list:
 *
 *   1. **The existing five filters behave identically, and the new ones are additive.** The
 *      five chips are still there in the same order with the same meaning; search, the date
 *      range, paging and the sixth `styleGuide` chip are additions that leave them alone.
 *   2. **The drawer shows the full event payload without truncation.** Asserted on a `detail`
 *      big enough that any clamp would show: the JSON block parses back into the record.
 *   3. **The CSV export round-trips the current filter set.** Asserted at the boundary — the
 *      href the button actually carries, with its `filter` and its `since`.
 *   4. **Empty, loading and error states are present**, and a failed read is never drawn as an
 *      empty workspace.
 *
 * Plus the bug the screen this replaces really had: `{ev.target || ev.detail}` put a JSONB
 * object into JSX, which React throws on the moment an entry has an empty target.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import AuditClient from '../src/app/ade/dashboard/audit/AuditClient';
import { AUDIT_PAGE_SIZE } from '../src/app/components/ade/audit/auditModel';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

/** One ledger row, as `GET /api/access/audit` returns it. */
interface Row {
  id: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  target: string;
  source: string;
  detail: unknown;
  prev_hash: string | null;
  entry_hash: string | null;
  created_at: string;
}

/**
 * Build one row.
 *
 * @param over What this row differs by.
 * @returns The row.
 */
function row(over: Partial<Row> & { id: string }): Row {
  return {
    actor_id: 'usr-ada',
    actor_label: 'ada@acme.io',
    action: 'role.assigned',
    target: 'linus@acme.io',
    source: 'web',
    detail: { role: 'Release manager' },
    prev_hash: 'hash-prev',
    entry_hash: 'hash-self',
    created_at: '2026-08-15T09:41:07Z',
    ...over,
  };
}

/** A ledger with one entry of each family the chips claim, plus one they do not. */
const LEDGER: Row[] = [
  row({
    id: 'evt-role',
    action: 'role.assigned',
    target: 'linus@acme.io',
    entry_hash: 'hash-role',
    prev_hash: 'hash-permission',
    created_at: '2026-08-15T09:41:07Z',
  }),
  row({
    id: 'evt-permission',
    action: 'permission.changed',
    target: 'Release manager',
    detail: { granted: ['versions:publish'], revoked: ['versions:create'] },
    entry_hash: 'hash-permission',
    prev_hash: 'hash-member',
    created_at: '2026-08-15T09:40:00Z',
  }),
  row({
    id: 'evt-member',
    action: 'member.invited',
    actor_label: 'grace@acme.io',
    target: 'margaret@acme.io',
    detail: { user_id: 'usr-margaret', role: 'Viewer' },
    entry_hash: 'hash-member',
    prev_hash: 'hash-admin',
    created_at: '2026-08-14T16:22:00Z',
  }),
  row({
    id: 'evt-admin',
    action: 'admin.override',
    actor_label: 'operator@apiome.dev',
    target: 'mcp.anonymous_calls',
    source: 'admin',
    detail: { reason: 'OPS-2291' },
    entry_hash: 'hash-admin',
    prev_hash: 'hash-style',
    created_at: '2026-08-12T18:48:00Z',
  }),
  row({
    id: 'evt-style',
    action: 'style_guide.rules_updated',
    actor_label: 'grace@acme.io',
    target: 'Acme REST',
    detail: { severities: 3 },
    source: 'api',
    entry_hash: 'hash-style',
    prev_hash: 'hash-sso',
    created_at: '2026-08-13T11:15:00Z',
  }),
  row({
    id: 'evt-sso',
    // No chip claims an `sso.*` event; the mockup still colours it, and "All events" holds it.
    action: 'sso.login',
    actor_label: 'sso:okta',
    target: 'linus@acme.io',
    detail: null,
    entry_hash: 'hash-sso',
    prev_hash: null,
    created_at: '2026-07-28T15:12:00Z',
  }),
];

/**
 * The row the screen this replaces could not draw: an empty target and an object `detail`.
 *
 * `permission.denied` writes exactly this when the denial has no subject.
 */
const OBJECT_DETAIL_ROW = row({
  id: 'evt-denied',
  action: 'permission.denied',
  target: '',
  detail: { resource: 'versions', action: 'create' },
});

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

/** Every audit URL the component asked for, in order. */
let requested: string[] = [];

/** What the next read answers with. Reassigned per test. */
let response: { ok: boolean; rows: Row[]; error?: string } = { ok: true, rows: LEDGER };

/**
 * Install a `fetch` double for the access proxy.
 *
 * @returns The mock, so a test can count calls.
 */
function mockFetch() {
  const fn = jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    requested.push(url);
    if (!response.ok) {
      return Promise.resolve({
        status: 500,
        json: () => Promise.resolve({ success: false, error: response.error }),
      } as Response);
    }
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({ success: true, data: response.rows }),
    } as Response);
  });
  // @ts-expect-error - assigning a test double to the global
  global.fetch = fn;
  return fn;
}

beforeEach(() => {
  requested = [];
  response = { ok: true, rows: LEDGER };
  mockFetch();
});

/** Render the page and wait for its first read to land. */
async function renderPage() {
  const view = render(<AuditClient />);
  await waitFor(() => expect(requested.length).toBeGreaterThan(0));
  return view;
}

/**
 * A filter chip by its testid.
 *
 * @param key The category key.
 * @returns The chip.
 */
function chip(key: string): HTMLElement {
  return screen.getByTestId(`audit-filter-${key}`);
}

// ---------------------------------------------------------------------------------------
// 1. The page, and what it kept
// ---------------------------------------------------------------------------------------

describe('the page', () => {
  it('keeps the title, the description and the compliance footnote', async () => {
    await renderPage();

    expect(screen.getByRole('heading', { name: 'Access audit', level: 1 })).toBeInTheDocument();
    expect(
      screen.getByText(/Immutable record of every access & permission change/)
    ).toBeInTheDocument();
    expect(screen.getByTestId('audit-compliance-note')).toHaveTextContent(
      /append-only and hash-chained/
    );
    expect(screen.getByTestId('audit-compliance-note')).toHaveTextContent(
      /SOC 2 \/ ISO 27001 access-review evidence/
    );
  });

  it('draws every event with its When, Actor, Event, Target and Source', async () => {
    await renderPage();

    const table = await screen.findByTestId('audit-table');
    expect(await within(table).findByText('role.assigned')).toBeInTheDocument();
    // Two entries name the same subject — the role assignment and the SSO login.
    expect(within(table).getAllByText('linus@acme.io')).toHaveLength(2);
    // `actor_label`, mono, as the mockup asks.
    expect(within(table).getAllByText('ada@acme.io').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('web').length).toBeGreaterThan(0);
  });

  it('reads the ledger once, unnarrowed by category, so every chip can carry a count', async () => {
    await renderPage();

    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('filter=all');
    expect(requested[0]).toContain('limit=1000');
  });
});

// ---------------------------------------------------------------------------------------
// 2. The filters — the ticket's first acceptance criterion
// ---------------------------------------------------------------------------------------

describe('the filters', () => {
  it('keeps the original five, in order, and adds the styleGuide one the server always had', async () => {
    await renderPage();

    for (const [key, label] of [
      ['all', 'All events'],
      ['role', 'Role changes'],
      ['permission', 'Permissions'],
      ['member', 'Members'],
      ['admin', 'Admin overrides'],
      ['styleGuide', 'Style guides'],
    ]) {
      expect(chip(key)).toHaveTextContent(label);
    }
  });

  it('counts each category, which the screen it replaces could not', async () => {
    await renderPage();
    await screen.findByText('role.assigned');

    expect(chip('all')).toHaveTextContent('6');
    expect(chip('role')).toHaveTextContent('1');
    expect(chip('styleGuide')).toHaveTextContent('1');
  });

  it('narrows to a category without a second request', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');

    await user.click(chip('member'));

    const table = screen.getByTestId('audit-table');
    expect(within(table).getByText('member.invited')).toBeInTheDocument();
    expect(within(table).queryByText('role.assigned')).not.toBeInTheDocument();
    // The narrowing is over rows already in hand; the ledger is not re-read.
    expect(requested).toHaveLength(1);
  });

  it('states which chip is pressed, whether or not it is the active one', async () => {
    await renderPage();
    expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('role')).toHaveAttribute('aria-pressed', 'false');
  });
});

// ---------------------------------------------------------------------------------------
// 3. Search, range and paging — the additions
// ---------------------------------------------------------------------------------------

describe('search', () => {
  it('narrows on the actor, the action and the target', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');

    await user.type(screen.getByTestId('audit-search'), 'margaret');

    const table = screen.getByTestId('audit-table');
    expect(within(table).getByText('member.invited')).toBeInTheDocument();
    expect(within(table).queryByText('admin.override')).not.toBeInTheDocument();
  });

  it('offers a way back out of a search that matched nothing', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');

    await user.type(screen.getByTestId('audit-search'), 'zzzznothing');
    expect(screen.getByText('No audit events match these filters')).toBeInTheDocument();

    await user.click(screen.getByTestId('audit-clear-filters'));
    expect(await screen.findByText('role.assigned')).toBeInTheDocument();
  });
});

describe('the date range', () => {
  it('opens on the last 30 days and sends the bound as `since`', async () => {
    await renderPage();

    expect(screen.getByTestId('audit-range')).toHaveValue('30d');
    expect(requested[0]).toContain('since=');
  });

  it('re-reads the ledger when it changes, because the bound is a server parameter', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.selectOptions(screen.getByTestId('audit-range'), '24h');

    await waitFor(() => expect(requested).toHaveLength(2));
    const [first, second] = requested.map((url) => new URL(url, 'http://localhost'));
    expect(
      new Date(second.searchParams.get('since') as string).getTime()
    ).toBeGreaterThan(new Date(first.searchParams.get('since') as string).getTime());
  });

  it('sends no bound at all for “All time”, rather than a very old date', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.selectOptions(screen.getByTestId('audit-range'), 'all');

    await waitFor(() => expect(requested).toHaveLength(2));
    expect(requested[1]).not.toContain('since=');
  });
});

describe('paging', () => {
  it('pages a long ledger and moves between the pages', async () => {
    const user = userEvent.setup();
    response = {
      ok: true,
      rows: Array.from({ length: AUDIT_PAGE_SIZE + 3 }, (_, index) =>
        row({
          id: `evt-${index}`,
          target: `subject-${index}`,
          created_at: `2026-08-${String(15 - (index % 14)).padStart(2, '0')}T09:00:00Z`,
        })
      ),
    };
    await renderPage();
    await screen.findByText('subject-0');

    const table = screen.getByTestId('audit-table');
    expect(within(table).queryByText(`subject-${AUDIT_PAGE_SIZE}`)).not.toBeInTheDocument();
    expect(screen.getByTestId('audit-count')).toHaveTextContent(
      `Showing 1–${AUDIT_PAGE_SIZE} of ${AUDIT_PAGE_SIZE + 3} events`
    );

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByText(`subject-${AUDIT_PAGE_SIZE}`)).toBeInTheDocument();
    expect(screen.queryByText('subject-0')).not.toBeInTheDocument();
  });

  it('does not offer a pager for a ledger that fits on one page', async () => {
    await renderPage();
    await screen.findByText('role.assigned');
    expect(screen.queryByRole('navigation', { name: 'Audit pages' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 4. The drawer — the ticket's second acceptance criterion
// ---------------------------------------------------------------------------------------

describe('the event drawer', () => {
  /** Open the first row's drawer. */
  async function openFirstEvent() {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');
    await user.click(screen.getByTestId('audit-open-evt-role'));
    return { user, drawer: await screen.findByTestId('audit-drawer') };
  }

  it('opens from the row’s own control and names the entry', async () => {
    const { drawer } = await openFirstEvent();

    expect(within(drawer).getByTestId('audit-drawer-id')).toHaveTextContent('evt-role');
    expect(within(drawer).getByText('role.assigned')).toBeInTheDocument();
    // To the second and in UTC — what an auditor correlates against a server log.
    expect(drawer).toHaveTextContent('Aug 15, 2026, 09:41:07 AM UTC');
  });

  it('opens from the row itself, so the reader keeps their filters and their place', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');

    await user.click(screen.getByText('member.invited'));

    expect(await screen.findByTestId('audit-drawer-id')).toHaveTextContent('evt-member');
  });

  it('says what happened in one sentence, built from the entry’s own fields', async () => {
    const { drawer } = await openFirstEvent();
    expect(within(drawer).getByTestId('audit-drawer-summary')).toHaveTextContent(
      'ada@acme.io assigned a role to linus@acme.io from the web console.'
    );
  });

  it('lists the recorded detail as key/value lines rather than as raw JSON', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');
    await user.click(screen.getByTestId('audit-open-evt-permission'));

    const detail = await screen.findByTestId('audit-drawer-detail');
    expect(detail).toHaveTextContent('granted');
    expect(detail).toHaveTextContent('versions:publish');
    expect(detail).toHaveTextContent('revoked');
  });

  it('draws a matrix edit as before → after', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');
    await user.click(screen.getByTestId('audit-open-evt-permission'));

    const change = await screen.findByTestId('audit-drawer-change');
    expect(change).toHaveTextContent('versions:create');
    expect(change).toHaveTextContent('versions:publish');
  });

  it('shows the full payload without truncation — the second acceptance criterion', async () => {
    const user = userEvent.setup();
    const permissions = Array.from({ length: 40 }, (_, index) => `resource${index}:action`);
    response = {
      ok: true,
      rows: [row({ id: 'evt-big', action: 'role.created', detail: { permissions } })],
    };
    await renderPage();
    await screen.findByText('role.created');
    await user.click(screen.getByTestId('audit-open-evt-big'));

    const json = await screen.findByTestId('audit-drawer-json');
    const parsed = JSON.parse(json.textContent as string);
    expect(parsed.detail.permissions).toHaveLength(40);
    expect(parsed.entry_hash).toBe('hash-self');
    expect(json.textContent).toContain('resource39:action');
  });

  it('shows where the entry sits in the chain, and says the link was checked', async () => {
    const { drawer } = await openFirstEvent();

    const chain = within(drawer).getByTestId('audit-drawer-chain');
    expect(chain).toHaveTextContent('hash-permission');
    expect(chain).toHaveTextContent('hash-role');
    expect(
      within(drawer).getByText(/Verified against the entry written before it/)
    ).toBeInTheDocument();
  });

  it('says the link was *not* checked when the previous entry is outside the read', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');

    // The oldest row of the response. Its predecessor exists in the tenant's chain but was
    // not read, so nothing here may claim the link holds.
    await user.click(screen.getByTestId('audit-open-evt-sso'));

    expect(
      await screen.findByText(/The first entry in this workspace’s chain/)
    ).toBeInTheDocument();
  });

  it('copies the payload to the clipboard', async () => {
    const user = userEvent.setup();
    // Re-stubbed *after* `userEvent.setup()`, which installs a clipboard stub of its own.
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await renderPage();
    await screen.findByText('role.assigned');
    await user.click(screen.getByTestId('audit-open-evt-role'));
    await user.click(await screen.findByTestId('audit-copy-json'));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse((writeText.mock.calls[0] as unknown as string[])[0]).id).toBe('evt-role');
  });

  it('offers the way out to the surface the entry is about', async () => {
    const { drawer } = await openFirstEvent();
    expect(within(drawer).getByTestId('audit-drawer-roles-link')).toHaveAttribute(
      'href',
      '/ade/dashboard/roles'
    );
  });

  it('says the ledger is read-only, because nothing in the sheet may be edited', async () => {
    const { drawer } = await openFirstEvent();
    expect(drawer).toHaveTextContent('Read-only · append-only ledger');
  });

  it('closes on Escape and leaves the list where it was', async () => {
    const { user, drawer } = await openFirstEvent();
    expect(drawer).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('audit-drawer')).not.toBeInTheDocument());
    expect(screen.getByTestId('audit-table')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 5. The CSV export — the ticket's third acceptance criterion
// ---------------------------------------------------------------------------------------

describe('the CSV export', () => {
  it('is a link to the export endpoint, carrying the date range', async () => {
    await renderPage();

    const href = screen.getByTestId('audit-export').getAttribute('href') as string;
    expect(href).toContain('/api/access/audit/export');
    expect(href).toContain('filter=all');
    expect(href).toContain('since=');
  });

  it('round-trips the chosen category, so the file holds what the reader was looking at', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');

    await user.click(chip('styleGuide'));

    expect(screen.getByTestId('audit-export')).toHaveAttribute(
      'href',
      expect.stringContaining('filter=styleGuide')
    );
  });

  it('says outright that the file is not narrowed by the search box', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');

    expect(screen.getByTestId('audit-compliance-note')).not.toHaveTextContent(
      /not narrowed by the search box/
    );
    await user.type(screen.getByTestId('audit-search'), 'margaret');
    expect(screen.getByTestId('audit-compliance-note')).toHaveTextContent(
      /not narrowed by the search box/
    );
  });
});

// ---------------------------------------------------------------------------------------
// 6. The three states — the ticket's fourth acceptance criterion
// ---------------------------------------------------------------------------------------

describe('the states', () => {
  it('waits with a labelled skeleton rather than an unnamed spinner', async () => {
    render(<AuditClient />);
    expect(await screen.findByText('Loading the access ledger…')).toBeInTheDocument();
    await waitFor(() => expect(requested.length).toBeGreaterThan(0));
  });

  it('says the workspace has no events only when the read succeeded', async () => {
    response = { ok: true, rows: [] };
    await renderPage();

    expect(await screen.findByText('No audit events for this filter.')).toBeInTheDocument();
    expect(screen.getByTestId('audit-widen-range')).toBeInTheDocument();
  });

  it('reports a refused read as a failure, never as an empty ledger', async () => {
    response = { ok: false, rows: [], error: 'Ledger unavailable' };
    await renderPage();

    const banner = await screen.findByTestId('audit-error');
    expect(banner).toHaveTextContent('Failed to load audit log.');
    expect(banner).toHaveTextContent('Nothing was lost — the ledger is append-only.');
    expect(banner).toHaveTextContent('Ledger unavailable');
    // The claim the old screen made instead.
    expect(screen.queryByText('No audit events for this filter.')).not.toBeInTheDocument();
  });

  it('retries the read from the banner', async () => {
    const user = userEvent.setup();
    response = { ok: false, rows: [], error: 'Ledger unavailable' };
    await renderPage();
    await screen.findByTestId('audit-error');

    response = { ok: true, rows: LEDGER };
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('role.assigned')).toBeInTheDocument();
  });

  it('re-reads from the header’s Refresh', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText('role.assigned');

    await user.click(screen.getByTestId('audit-refresh'));

    await waitFor(() => expect(requested).toHaveLength(2));
  });
});

// ---------------------------------------------------------------------------------------
// 7. The bug the old screen had
// ---------------------------------------------------------------------------------------

describe('an entry whose detail is an object and whose target is empty', () => {
  it('renders, where `{ev.target || ev.detail}` threw', async () => {
    response = { ok: true, rows: [OBJECT_DETAIL_ROW] };
    await renderPage();

    expect(await screen.findByText('permission.denied')).toBeInTheDocument();
    // The detail is flattened to a line rather than handed to JSX as an object.
    expect(screen.getByTestId('audit-table')).toHaveTextContent('resource: versions');
  });
});
