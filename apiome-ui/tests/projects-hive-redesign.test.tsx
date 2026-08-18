/**
 * The Projects redesign, rendered (HIVE-6.1, #5312).
 *
 * `projects-model.test.ts` holds the decisions and `projects-css.test.ts` pins the
 * declarations; this holds the screen that makes them, against a mocked `/api/projects`
 * returning the documented `{success, projects}` envelope. What it pins is the ticket's five
 * acceptance criteria and the mockup's **Notes → Keeps (1:1)** list:
 *
 *   1. **Both views render the same data set and honour the same filters.** Asserted by
 *      narrowing in one view and reading the other.
 *   2. **Local quality history still feeds the rings and the trend.** The store is seeded and
 *      the card's rings, the table's sparkline and the portfolio card are read from it.
 *   3. **Catalog items stay out.** A `publishable: false` row is in the payload and must not
 *      reach either view.
 *   4. **Soft delete / undelete / permanent delete all work, and permanent requires typing
 *      the slug.** The confirm options the screen hands the shared dialog are captured.
 *   5. **A card and a row open versions; a deleted one does not.**
 *
 * Plus the two things the screen this replaces got wrong and this ticket fixes: the card was
 * a `role="button"` full of buttons, and permanent delete was two identical native confirms.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

const mockPush = jest.fn();
const mockConfirm = jest.fn<Promise<boolean>, [unknown]>(() => Promise.resolve(true));
const mockAlert = jest.fn<Promise<void>, [unknown]>(() => Promise.resolve());

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: { user_id: 'u-ada', current_tenant_id: 't-acme', email: 'ada@acme.io' } },
    status: 'authenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/ade/dashboard/projects',
}));

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({
    confirm: (options: unknown) => mockConfirm(options),
    alert: (options: unknown) => mockAlert(options),
  }),
}));

const mockDeleteProject = jest.fn(async () => JSON.stringify({ success: true }));
const mockRestoreProject = jest.fn(async () => JSON.stringify({ success: true }));
const mockPermanentDelete = jest.fn(async () => JSON.stringify({ success: true }));
const mockCreateProject = jest.fn(async () => JSON.stringify({ success: true }));
const mockUpdateProject = jest.fn(async () => JSON.stringify({ success: true }));

jest.mock('@lib/db/helper', () => ({
  createProject: (...args: unknown[]) => mockCreateProject(...(args as [])),
  updateProject: (...args: unknown[]) => mockUpdateProject(...(args as [])),
  deleteProject: (...args: unknown[]) => mockDeleteProject(...(args as [])),
  restoreProject: (...args: unknown[]) => mockRestoreProject(...(args as [])),
  permanentDeleteProject: (...args: unknown[]) => mockPermanentDelete(...(args as [])),
}));

/** The import wizard and the AI panel are whole screens of their own, and not under test. */
jest.mock('@/app/components/ade/dashboard/ImportDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="import-dialog">import wizard</div> : null,
}));

jest.mock('@/app/components/ade/dashboard/LLMImportDialog', () => ({
  __esModule: true,
  LLMChatPanel: () => <div data-testid="ai-panel">chat</div>,
}));

import ProjectsClient from '../src/app/ade/dashboard/projects/ProjectsClient';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const PAYMENTS = {
  id: '8f2a1c00-0000-4000-8000-000000000001',
  tenant_id: 't-acme',
  creator_id: 'u-ada',
  name: 'Payments API',
  slug: 'payments-api',
  description: 'Card, refund and payout endpoints for the merchant platform.',
  enabled: true,
  deleted_at: null,
  created_at: '2026-06-01T10:00:00.000Z',
  updated_at: '2026-08-15T09:12:00.000Z',
  creator_name: 'Ada Lovelace',
  creator_email: 'ada@example.com',
  versionsCount: 6,
  qualityScore: 88,
  qualityGrade: 'B',
  metadata: { domainCategory: 'finance' },
};

const ORDERS = {
  ...PAYMENTS,
  id: '3b91de00-0000-4000-8000-000000000002',
  name: 'Orders Service',
  slug: 'orders-service',
  description: 'Order lifecycle: cart to fulfilment.',
  creator_name: 'Grace Hopper',
  creator_email: 'grace@example.com',
  versionsCount: 5,
  qualityScore: 94,
  qualityGrade: 'A',
  metadata: undefined,
};

const LEGACY = {
  ...PAYMENTS,
  id: '11aa0900-0000-4000-8000-000000000003',
  name: 'Legacy Gateway',
  slug: 'legacy-gateway',
  description: '',
  deleted_at: '2026-08-09T14:15:00.000Z',
  versionsCount: 0,
  qualityScore: null,
  qualityGrade: null,
  metadata: undefined,
};

/** A catalog item — `publishable: false` — which must never list here (#4587). */
const CATALOG_ITEM = {
  ...PAYMENTS,
  id: 'c0ffee00-0000-4000-8000-000000000004',
  name: 'Avro Contracts',
  slug: 'avro-contracts',
  publishable: false,
};

const ALL_ROWS = [PAYMENTS, ORDERS, LEGACY, CATALOG_ITEM];

/** The browser-local store the rings and both trends read. */
const HISTORY_KEY = 'apiome:project-quality-history:v1';

function seedHistory() {
  window.localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify({
      byProject: {
        [PAYMENTS.id]: [
          { recordedAt: '2026-07-20T11:02:00.000Z', overall: 79, grade: 'C' },
          { recordedAt: '2026-08-02T16:40:00.000Z', overall: 85, grade: 'B' },
          { recordedAt: '2026-08-15T09:12:00.000Z', overall: 72, grade: 'B' },
        ],
      },
    })
  );
}

/** Serve `/api/projects`, honouring the `include_deleted` parameter the switch adds. */
function mockProjects(rows: readonly unknown[] = ALL_ROWS) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const includeDeleted = url.includes('include_deleted=true');
    const projects = includeDeleted
      ? rows
      : rows.filter((row) => !(row as { deleted_at: string | null }).deleted_at);
    return {
      ok: true,
      statusText: 'OK',
      json: async () => ({ success: true, projects }),
    } as Response;
  }) as unknown as typeof fetch;
}

/** Render the screen and wait for the first read to land. */
async function renderProjects(rows: readonly unknown[] = ALL_ROWS) {
  mockProjects(rows);
  const user = userEvent.setup();
  render(<ProjectsClient />);
  // The list, or — for a workspace with none — the state that says so. Either way the
  // skeleton is gone, which is what the tests below assume.
  await screen.findByText(rows.length === 0 ? 'No projects yet' : 'Payments API');
  return { user };
}

/** Radix `DropdownMenu.Trigger` opens on `pointerdown`, which jsdom does not synthesise. */
function openMenu(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  seedHistory();
  mockConfirm.mockImplementation(() => Promise.resolve(true));
});

// ---------------------------------------------------------------------------------------

describe('the page header', () => {
  it('states the portfolio in one sentence, with the deleted count gated on the switch', async () => {
    const { user } = await renderProjects();

    // Deleted rows are not read until the switch asks for them, so the sentence counts two.
    expect(screen.getByText('2 projects · avg quality 83 · 2 active')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    await screen.findByText('Legacy Gateway');
    expect(screen.getByText('3 projects · avg quality 83 · 2 active · 1 deleted')).toBeInTheDocument();
  });

  it('offers Import and New project with their shortcut chips', async () => {
    await renderProjects();
    expect(screen.getByTestId('projects-create')).toHaveTextContent('New project');
    expect(screen.getByTestId('projects-create')).toHaveTextContent('N');
    expect(screen.getByTestId('projects-import')).toHaveTextContent('Import');
    expect(screen.getByTestId('projects-import')).toHaveTextContent('I');
  });

  it('keeps catalog items out of the list', async () => {
    await renderProjects();
    expect(screen.queryByText('Avro Contracts')).not.toBeInTheDocument();
  });
});

describe('the card', () => {
  it('draws the mockup line-up: id · slug, domain pill, status, summary, orbs, versions', async () => {
    await renderProjects();
    const card = screen
      .getAllByTestId('project-card')
      .find((node) => node.dataset.projectId === PAYMENTS.id)!;

    expect(within(card).getByText('prj_8f2a1c · payments-api')).toBeInTheDocument();
    expect(within(card).getByText(/^Finance/)).toBeInTheDocument();
    expect(within(card).getByTestId('project-card-status')).toHaveTextContent('Active');
    expect(within(card).getByText(PAYMENTS.description)).toBeInTheDocument();
    expect(within(card).getByTestId('project-card-versions')).toHaveTextContent('6 versions');
    expect(within(card).getByText('Ada Lovelace')).toBeInTheDocument();

    // Quality and Lint are the browser-local latest (72 / B), not the server's 88 / B.
    expect(within(card).getByTitle('Open quality score history')).toHaveTextContent('72');
    expect(within(card).getByTitle('Open lint report')).toHaveTextContent('B');
    // Debt is not computed, so its orb is not a control at all.
    const debt = within(card).getByTitle('Technical debt (not yet computed)');
    expect(debt.tagName).toBe('SPAN');
    expect(debt).toHaveTextContent('—');
  });

  it('is a link, not a button full of buttons', async () => {
    // `nested-interactive` is a serious axe violation and the definition of done asks for
    // none. The card carries no interactive role of its own; the name is the one link.
    await renderProjects();
    const card = screen
      .getAllByTestId('project-card')
      .find((node) => node.dataset.projectId === PAYMENTS.id)!;

    expect(card.tagName).toBe('ARTICLE');
    expect(card).not.toHaveAttribute('role');
    expect(card).not.toHaveAttribute('tabindex');
    expect(within(card).getByRole('link', { name: 'Payments API' })).toHaveAttribute(
      'href',
      `/ade/dashboard/versions?projectId=${PAYMENTS.id}`
    );
  });

  it('shows Empty project instead of scores when a project has no versions', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    const card = await screen
      .findAllByTestId('project-card')
      .then((cards) => cards.find((node) => node.dataset.projectId === LEGACY.id)!);

    expect(within(card).getByTestId('project-card-empty')).toHaveTextContent('Empty project');
    expect(within(card).queryByTitle('Open quality score history')).not.toBeInTheDocument();
    expect(within(card).getByTestId('project-card-versions')).toHaveTextContent('0 versions');
  });

  it('gives a deleted card the recovery footer and no link at all', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    const card = await screen
      .findAllByTestId('project-card')
      .then((cards) => cards.find((node) => node.dataset.projectId === LEGACY.id)!);

    expect(card).toHaveAttribute('data-lifecycle', 'deleted');
    expect(within(card).getByTestId('project-card-status')).toHaveTextContent('Deleted');
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();

    const footer = within(card).getByTestId('project-card-recovery');
    expect(within(footer).getByRole('button', { name: 'Undelete' })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: 'Permanently delete' })).toBeInTheDocument();
  });
});

describe('the toolbar, which both views share', () => {
  it('narrows both views with one search box', async () => {
    const { user } = await renderProjects();

    await user.type(screen.getByTestId('projects-search'), 'orders');
    expect(screen.queryByText('Payments API')).not.toBeInTheDocument();
    expect(screen.getByText('Orders Service')).toBeInTheDocument();

    await user.click(screen.getByTestId('projects-view-table'));
    const table = await screen.findByTestId('projects-table');
    expect(within(table).getByText('Orders Service')).toBeInTheDocument();
    expect(within(table).queryByText('Payments API')).not.toBeInTheDocument();
    expect(screen.getByTestId('projects-table-foot')).toHaveTextContent(
      '1 project · sorted by name ↑'
    );
  });

  it('counts every facet and locks Deleted until the switch is on', async () => {
    const { user } = await renderProjects();

    expect(screen.getByTestId('projects-facet-all')).toHaveTextContent('All2');
    expect(screen.getByTestId('projects-facet-active')).toHaveTextContent('Active2');
    expect(screen.getByTestId('projects-facet-deleted')).toBeDisabled();
    expect(screen.getByTestId('projects-facet-deleted')).toHaveAttribute(
      'title',
      'Turn on Show deleted to use this view'
    );

    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    await screen.findByText('Legacy Gateway');
    expect(screen.getByTestId('projects-facet-deleted')).toBeEnabled();
    expect(screen.getByTestId('projects-facet-attention')).toHaveTextContent('Needs attention1');

    await user.click(screen.getByTestId('projects-facet-deleted'));
    expect(screen.getByText('Legacy Gateway')).toBeInTheDocument();
    expect(screen.queryByText('Payments API')).not.toBeInTheDocument();
  });

  it('drops the Deleted chip when the switch is turned back off', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    await screen.findByText('Legacy Gateway');
    await user.click(screen.getByTestId('projects-facet-deleted'));
    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));

    await waitFor(() =>
      expect(screen.getByTestId('projects-facet-all')).toHaveAttribute('aria-pressed', 'true')
    );
  });

  it('says what it is sorted by, and re-sorts from the menu', async () => {
    const { user } = await renderProjects();
    const trigger = screen.getByTestId('projects-sort-menu');
    expect(trigger).toHaveTextContent('Sorted by name ↑');

    openMenu(trigger);
    await user.click(await screen.findByTestId('projects-sort-quality'));
    await waitFor(() =>
      expect(screen.getByTestId('projects-sort-menu')).toHaveTextContent('Sorted by quality ↑')
    );
  });
});

describe('the table', () => {
  it("draws the mockup's columns and the trend cell", async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByTestId('projects-view-table'));
    const table = await screen.findByTestId('projects-table');

    for (const header of [
      'Project',
      'Description',
      'Quality trend',
      'Versions',
      'Status',
      'Created by',
      'Updated',
    ]) {
      expect(within(table).getByRole('columnheader', { name: new RegExp(header) })).toBeInTheDocument();
    }

    // The sparkline is the browser-local series; the figure and the letter come with it.
    const trend = within(table).getByTestId(`projects-trend-${PAYMENTS.id}`);
    expect(trend).toHaveTextContent('72');
    expect(trend).toHaveTextContent('(B)');
    expect(
      within(trend).getByRole('img', { name: /Quality trend for Payments API/ })
    ).toBeInTheDocument();

    // A project with a server score but no local trend prints the figure with no shape.
    expect(within(table).queryByTestId(`projects-trend-${ORDERS.id}`)).not.toBeInTheDocument();
    expect(within(table).getByText('94')).toBeInTheDocument();
  });

  it('opens versions from a live row and refuses from a deleted one', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    await user.click(screen.getByTestId('projects-view-table'));
    const table = await screen.findByTestId('projects-table');

    await user.click(within(table).getByText('Orders Service'));
    expect(mockPush).toHaveBeenCalledWith(
      `/ade/dashboard/versions?projectId=${ORDERS.id}`
    );

    mockPush.mockClear();
    const deletedRow = table.querySelector(`tr[data-row-id="${LEGACY.id}"]`)!;
    expect(deletedRow).toHaveClass('prj-row--deleted');
    fireEvent.click(deletedRow);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('says Empty project in the trend cell of a project with no versions', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    await user.click(screen.getByTestId('projects-view-table'));
    const table = await screen.findByTestId('projects-table');
    expect(within(table).getByTestId('projects-table-empty')).toHaveTextContent('Empty project');
  });
});

describe('the three lifecycle writes', () => {
  it('soft-deletes behind an ungated confirm that says how to undo it', async () => {
    const { user } = await renderProjects();
    openMenu(screen.getByTestId(`project-card-menu-${PAYMENTS.id}`));
    await user.click(await screen.findByText('Delete project'));

    await waitFor(() => expect(mockDeleteProject).toHaveBeenCalledWith(PAYMENTS.id));
    const options = mockConfirm.mock.calls[0][0] as Record<string, unknown>;
    expect(options.typeToConfirm).toBeUndefined();
    expect(options.message).toContain('Show deleted');
  });

  it('gates a permanent delete on typing the slug, in one dialog rather than two confirms', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    const card = await screen
      .findAllByTestId('project-card')
      .then((cards) => cards.find((node) => node.dataset.projectId === LEGACY.id)!);

    await user.click(within(card).getByRole('button', { name: 'Permanently delete' }));

    await waitFor(() => expect(mockPermanentDelete).toHaveBeenCalledWith(LEGACY.id));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const options = mockConfirm.mock.calls[0][0] as Record<string, unknown>;
    expect(options.typeToConfirm).toBe('legacy-gateway');
    expect(options.variant).toBe('danger');
  });

  it("undeletes from the card's amber footer", async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    const card = await screen
      .findAllByTestId('project-card')
      .then((cards) => cards.find((node) => node.dataset.projectId === LEGACY.id)!);

    await user.click(within(card).getByRole('button', { name: 'Undelete' }));
    await waitFor(() => expect(mockRestoreProject).toHaveBeenCalledWith(LEGACY.id));
  });

  it('writes nothing when the confirm is declined', async () => {
    mockConfirm.mockImplementation(() => Promise.resolve(false));
    const { user } = await renderProjects();
    openMenu(screen.getByTestId(`project-card-menu-${PAYMENTS.id}`));
    await user.click(await screen.findByText('Delete project'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockDeleteProject).not.toHaveBeenCalled();
  });
});

describe('bulk actions', () => {
  it('offers the verb each half of a mixed selection can take', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByRole('switch', { name: /show soft-deleted/i }));
    await user.click(screen.getByTestId('projects-view-table'));
    const table = await screen.findByTestId('projects-table');

    await user.click(within(table).getByRole('checkbox', { name: 'Select Orders Service' }));
    await user.click(within(table).getByRole('checkbox', { name: 'Select Legacy Gateway' }));

    expect(screen.getByTestId('projects-bulk-delete')).toHaveTextContent('Delete 1');
    expect(screen.getByTestId('projects-bulk-restore')).toHaveTextContent('Undelete 1');

    await user.click(screen.getByTestId('projects-bulk-restore'));
    await waitFor(() => expect(mockRestoreProject).toHaveBeenCalledWith(LEGACY.id));
    expect(mockDeleteProject).not.toHaveBeenCalled();
  });
});

describe('the scores dialog and the portfolio trend', () => {
  it('opens on the tab the orb names', async () => {
    const { user } = await renderProjects();
    const card = screen
      .getAllByTestId('project-card')
      .find((node) => node.dataset.projectId === PAYMENTS.id)!;

    await user.click(within(card).getByTitle('Open lint report'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Project scores — Payments API')).toBeInTheDocument();
    expect(within(dialog).getByTestId('project-scores-tab-lint')).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('draws the portfolio average from the same local history', async () => {
    await renderProjects();
    const panel = screen.getByTestId('projects-portfolio-trend');
    // One project has history; the running average after its last import is 72.
    expect(within(panel).getByTestId('projects-portfolio-avg')).toHaveTextContent('avg 72');
    expect(
      within(panel).getByRole('img', { name: /Portfolio quality trend/ })
    ).toBeInTheDocument();
  });

  it('says why there is no trend when this browser has never imported', async () => {
    window.localStorage.clear();
    await renderProjects();
    expect(
      screen.getByText('No quality history in this browser yet')
    ).toBeInTheDocument();
  });
});

describe('the empty states', () => {
  it('offers both ways in when the workspace has no projects', async () => {
    await renderProjects([]);
    const empty = screen.getByText('No projects yet').closest('div')!;
    expect(within(empty).getByRole('button', { name: /New project/ })).toBeInTheDocument();
    expect(within(empty).getByRole('button', { name: /Import/ })).toBeInTheDocument();
  });

  it('offers a way back out when a filter matched nothing', async () => {
    const { user } = await renderProjects();
    await user.type(screen.getByTestId('projects-search'), 'zzz');
    expect(screen.getByText('No projects match your filters or search')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Payments API')).toBeInTheDocument();
  });
});

describe('the create dialog', () => {
  it('carries both tabs and creates from the manual one', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByTestId('projects-create'));

    const dialog = await screen.findByTestId('projects-create-dialog');
    expect(within(dialog).getByText('New project')).toBeInTheDocument();
    expect(within(dialog).getByTestId('project-start-template')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/Project name/), 'Notifications API');
    await user.click(within(dialog).getByTestId('projects-create-submit'));

    await waitFor(() => expect(mockCreateProject).toHaveBeenCalled());
    const [tenantId, userId, name, , slug] = mockCreateProject.mock.calls[0] as string[];
    expect(tenantId).toBe('t-acme');
    expect(userId).toBe('u-ada');
    expect(name).toBe('Notifications API');
    // The slug follows the name until somebody takes it over.
    expect(slug).toBe('notifications-api');
  });

  it('refuses to submit without a name, and says which field', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByTestId('projects-create'));
    const dialog = await screen.findByTestId('projects-create-dialog');

    await user.click(within(dialog).getByTestId('projects-create-submit'));
    expect(await within(dialog).findByText('Project name is required.')).toBeInTheDocument();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it('hands the AI tab the chat panel and no Create button to press', async () => {
    const { user } = await renderProjects();
    await user.click(screen.getByTestId('projects-create'));
    const dialog = await screen.findByTestId('projects-create-dialog');

    await user.click(within(dialog).getByTestId('projects-create-tab-ai'));
    expect(within(dialog).getByTestId('ai-panel')).toBeInTheDocument();
    expect(within(dialog).getByTestId('projects-create-submit')).toBeDisabled();
  });
});

describe('the edit dialog', () => {
  it('opens filled in, with the four read-only facts above the form', async () => {
    const { user } = await renderProjects();
    openMenu(screen.getByTestId(`project-card-menu-${PAYMENTS.id}`));
    await user.click(await screen.findByText('Edit project'));

    const dialog = await screen.findByTestId('projects-edit-dialog');
    expect(within(dialog).getByLabelText(/Project name/)).toHaveValue('Payments API');
    expect(within(dialog).getByLabelText(/^Slug/)).toHaveValue('payments-api');
    // The template row belongs to creation only.
    expect(within(dialog).queryByTestId('project-start-template')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Created by')).toBeInTheDocument();
    expect(within(dialog).getByText('Ada Lovelace')).toBeInTheDocument();

    await user.click(within(dialog).getByTestId('projects-edit-submit'));
    await waitFor(() => expect(mockUpdateProject).toHaveBeenCalled());
    expect((mockUpdateProject.mock.calls[0] as string[])[0]).toBe(PAYMENTS.id);
  });
});
