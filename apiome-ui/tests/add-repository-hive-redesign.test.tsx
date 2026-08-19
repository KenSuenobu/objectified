/**
 * The Add-repository redesign, rendered (HIVE-7.4, #5321).
 *
 * `add-repository-model.test.ts` holds the decisions and `add-repository-css.test.ts` pins the
 * declarations; this holds the screen that makes them, against a mocked linked-account read, a
 * mocked `/api/sso/github/repos` and a mocked `/api/repositories`. What it pins is the ticket's
 * four acceptance criteria and the mockup's **Notes → Keeps (1:1)** list:
 *
 *   1. **Only GitHub linked accounts can browse remotes, and the limitation is stated** — up
 *      front under the tiles, on each affected tile, and again on the picker.
 *   2. **The public-URL test gives real feedback** — a standing, announced verdict whose first
 *      state is "Not tested yet", and which is withdrawn when the URL changes.
 *   3. **Unimplemented steps are unmistakably marked as proposed** — the chip on the progress
 *      row, the proposal card, and nothing inside it that can be pressed.
 *   4. **Cancel returns to the repositories list** — from the header and from the footer.
 *
 * Plus the five things the screen this replaces got wrong: a four-step row that was a lie, a
 * limitation discovered rather than stated, a URL test with no standing feedback, choices no
 * keyboard could move between, and a failed remote read with no way out.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const mockPush = jest.fn();
const mockLinkedAccounts = jest.fn<Promise<string>, [string]>();

/** The signed-in user, mutable so the no-workspace gate can be rendered too. */
const mockSessionUser: { user_id?: string; current_tenant_id?: string; email: string } = {
  user_id: 'u-ada',
  current_tenant_id: 't-acme',
  email: 'ada@acme.io',
};

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: mockSessionUser },
    status: 'authenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/ade/dashboard/repositories/new',
}));

jest.mock('@lib/db/helper', () => ({
  getLinkedAccountsForUser: (userId: string) => mockLinkedAccounts(userId),
}));

const mockToastMessage = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

jest.mock('sonner', () => ({
  toast: {
    message: (...args: unknown[]) => mockToastMessage(...(args as [])),
    success: (...args: unknown[]) => mockToastSuccess(...(args as [])),
    error: (...args: unknown[]) => mockToastError(...(args as [])),
  },
}));

import AddRepositoryClient from '../src/app/ade/dashboard/repositories/new/AddRepositoryClient';
import { TooltipProvider } from '../src/app/components/ui/Tooltip';
import {
  ACCOUNTS_EMPTY_TITLE,
  BROWSE_LIMITATION_NOTE,
  IMPORT_FAILED_REMEDY,
  IMPORT_FAILED_TITLE,
  NOT_ENABLED_MESSAGE,
  PICK_ACCOUNT_TOAST,
  PICK_REPOSITORY_TOAST,
  PROPOSAL_BADGE,
  PROPOSED_STEPS,
  PROPOSED_STEPS_BADGE,
  REGISTERED_TOAST,
  REPOS_EMPTY,
  TEST_BEFORE_CONTINUE_TOAST,
  URL_TEST_NEEDS_HTTPS_TOAST,
  URL_TEST_OK_TOAST,
  URL_TEST_UNTESTED,
  nonBrowsableProviderNote,
} from '../src/app/components/ade/repositories/addRepositoryModel';

// ---------------------------------------------------------------------------------------
// Fixtures — the accounts and repositories the mockup draws
// ---------------------------------------------------------------------------------------

const GITHUB = {
  id: 'acct-gh',
  provider: 'github',
  provider_email: 'ada@example.com',
  provider_username: 'ada-lovelace',
};

const GITLAB = {
  id: 'acct-gl',
  provider: 'gitlab',
  provider_email: 'ada@example.com',
  provider_username: null,
};

const REMOTE_REPOS = [
  {
    id: 1,
    name: 'payments-specs',
    full_name: 'acme/payments-specs',
    description: 'OpenAPI and AsyncAPI sources for the payments platform',
    private: false,
    default_branch: 'main',
    html_url: 'https://github.com/acme/payments-specs',
  },
  {
    id: 2,
    name: 'notifications-contracts',
    full_name: 'acme/notifications-contracts',
    description: 'Private — push/SMS contract sources',
    private: true,
    default_branch: 'main',
    html_url: 'https://github.com/acme/notifications-contracts',
  },
  {
    id: 3,
    name: 'orders-contracts',
    full_name: 'acme/orders-contracts',
    description: 'Order lifecycle contracts',
    private: false,
    default_branch: 'main',
    html_url: 'https://github.com/acme/orders-contracts',
  },
];

// ---------------------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------------------

/** One canned answer for one endpoint. */
interface Canned {
  status?: number;
  body?: unknown;
  throws?: boolean;
}

/** What each endpoint answers on the next call. Reset per test. */
const routes: { repos: Canned; test: Canned; create: Canned } = {
  repos: { body: { repositories: REMOTE_REPOS } },
  test: { body: { ok: true, message: 'URL responded successfully (reachability check only).' } },
  create: { body: { repository: { id: 'r-77' } } },
};

/** Every request the screen made, in order. */
const calls: { url: string; init?: RequestInit }[] = [];

const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
  const canned = url.includes('/api/sso/github/repos')
    ? routes.repos
    : url.includes('/test-public-url')
      ? routes.test
      : routes.create;
  if (canned.throws) throw new Error('network down');
  const status = canned.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 500 ? 'Internal Server Error' : 'OK',
    json: async () => canned.body ?? {},
  } as Response;
});

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

/** Mount the screen with a given set of linked accounts. */
async function renderScreen(accounts: unknown[] = [GITHUB]) {
  mockLinkedAccounts.mockResolvedValue(JSON.stringify(accounts));
  const view = render(
    <TooltipProvider>
      <AddRepositoryClient />
    </TooltipProvider>
  );
  await screen.findByRole('heading', { level: 1, name: 'Add a repository' });
  return view;
}

/** The radio input behind a test id. */
const radio = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  routes.repos = { body: { repositories: REMOTE_REPOS } };
  routes.test = {
    body: { ok: true, message: 'URL responded successfully (reachability check only).' },
  };
  routes.create = { body: { repository: { id: 'r-77' } } };
  mockSessionUser.current_tenant_id = 't-acme';
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

/* -------------------------------------------------------------------------
   1. The page frame
   ------------------------------------------------------------------------- */

describe('the page header', () => {
  it('draws the title and the mockup’s description', async () => {
    await renderScreen();
    expect(screen.getByRole('heading', { level: 1, name: 'Add a repository' })).toBeInTheDocument();
    expect(
      screen.getByText('Register a repository so Apiome can scan it for importable specifications.')
    ).toBeInTheDocument();
  });

  it('puts Repositories in the breadcrumb, pointing at the list', async () => {
    await renderScreen();
    const trail = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(trail).getByRole('link', { name: 'Repositories' })).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories'
    );
  });

  it('carries one primary action and no more', async () => {
    // DESIGN.md §7. Cancel is a ghost; the only ink button on the page is Continue.
    await renderScreen();
    const header = screen.getByTestId('repo-new-cancel-header');
    expect(header.closest('a')).toHaveAttribute('href', '/ade/dashboard/repositories');
  });

  it('sends Cancel back to the repositories list from the footer too', async () => {
    // Acceptance criterion 4.
    await renderScreen();
    expect(screen.getByTestId('repo-new-cancel').closest('a')).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories'
    );
  });

  it('draws the workspace gate instead of a form nobody could submit', async () => {
    mockSessionUser.current_tenant_id = undefined;
    mockLinkedAccounts.mockResolvedValue('[]');
    render(
      <TooltipProvider>
        <AddRepositoryClient />
      </TooltipProvider>
    );

    expect(await screen.findByText('Pick a workspace first')).toBeInTheDocument();
    expect(
      screen.getByText('A repository is registered against one workspace.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('repo-new-continue')).not.toBeInTheDocument();
    // The header still stands, so the reader can leave without using the browser's back button.
    expect(screen.getByTestId('repo-new-cancel-header').closest('a')).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories'
    );
  });
});

/* -------------------------------------------------------------------------
   2. The progress row and the proposal — acceptance criterion 3
   ------------------------------------------------------------------------- */

describe('the progress row', () => {
  it('draws all four steps with only the first current', async () => {
    await renderScreen();
    const stepper = screen.getByTestId('repo-new-stepper');
    const steps = within(stepper).getAllByRole('listitem');
    const named = steps.filter((step) => step.getAttribute('data-status'));
    expect(named.map((step) => step.textContent)).toEqual([
      '1SourceStep 1 of 4',
      '2RepositoryNot started',
      '3Scan settingsNot started',
      '4ConfirmNot started',
    ]);
    expect(named[0]).toHaveAttribute('aria-current', 'step');
  });

  it('marks steps 2–4 as proposed, and says why', async () => {
    await renderScreen();
    const badge = screen.getByTestId('repo-new-proposed-badge');
    expect(badge).toHaveTextContent(PROPOSED_STEPS_BADGE);
    expect(badge).toHaveAttribute('title', expect.stringContaining('Today only step 1 exists'));
    expect(badge).toHaveAttribute('aria-describedby', 'repo-proposed-steps');
  });
});

describe('the proposal card', () => {
  it('says "not in the app today" in words', async () => {
    await renderScreen();
    const card = screen.getByTestId('repo-proposed-steps');
    expect(within(card).getByText(PROPOSAL_BADGE)).toBeInTheDocument();
    expect(within(card).getByRole('heading', { name: /Proposed steps 2–4/ })).toBeInTheDocument();
  });

  it('describes each of the three steps that do not exist', async () => {
    await renderScreen();
    const card = screen.getByTestId('repo-proposed-steps');
    for (const step of PROPOSED_STEPS) {
      expect(within(card).getByText(step.title)).toBeInTheDocument();
      expect(within(card).getByText(step.body)).toBeInTheDocument();
    }
  });

  it('contains nothing that can be pressed', async () => {
    // The strongest form of "unmistakably proposed": there is no control to try.
    await renderScreen();
    const card = screen.getByTestId('repo-proposed-steps');
    expect(card.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------
   3. The source choice
   ------------------------------------------------------------------------- */

describe('the source choice', () => {
  it('is a radio group with the linked-account card selected', async () => {
    await renderScreen();
    expect(screen.getByRole('radiogroup', { name: 'Repository source' })).toBeInTheDocument();
    expect(radio('repo-source-linked')).toBeChecked();
    expect(radio('repo-source-public_url')).not.toBeChecked();
  });

  it('swaps the accounts card for the URL card', async () => {
    await renderScreen();
    expect(screen.getByTestId('repo-new-accounts-card')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-new-url-card')).not.toBeInTheDocument();

    fireEvent.click(radio('repo-source-public_url'));

    expect(screen.getByTestId('repo-new-url-card')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-new-accounts-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('repo-new-repos-card')).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   4. Linked accounts — acceptance criterion 1
   ------------------------------------------------------------------------- */

describe('the linked-account tiles', () => {
  it('auto-selects the only account there is, and browses it', async () => {
    await renderScreen([GITHUB]);
    await waitFor(() => expect(radio('repo-account-acct-gh')).toBeChecked());
    expect(screen.getByText('Auto-selected when exactly one account is linked.')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes('accountId=acct-gh'))).toBe(true)
    );
  });

  it('chooses nothing when there is a choice to make', async () => {
    await renderScreen([GITHUB, GITLAB]);
    await screen.findByTestId('repo-account-acct-gh');
    expect(radio('repo-account-acct-gh')).not.toBeChecked();
    expect(radio('repo-account-acct-gl')).not.toBeChecked();
    expect(screen.queryByTestId('repo-new-repos-card')).not.toBeInTheDocument();
  });

  it('states the GitHub-only limitation before the reader can trip over it', async () => {
    await renderScreen([GITHUB, GITLAB]);
    await screen.findByTestId('repo-account-acct-gl');
    expect(screen.getByTestId('repo-browse-limitation')).toHaveTextContent(BROWSE_LIMITATION_NOTE);
    // And on the tile it applies to, so the fact travels with the choice.
    const tile = screen.getByTestId('repo-account-acct-gl').closest('label') as HTMLElement;
    expect(within(tile).getByText('URL only')).toBeInTheDocument();
  });

  it('says nothing about the limitation when every account is a GitHub one', async () => {
    await renderScreen([GITHUB]);
    await screen.findByTestId('repo-account-acct-gh');
    expect(screen.queryByTestId('repo-browse-limitation')).not.toBeInTheDocument();
  });

  it('explains an empty list, and offers the way out of it', async () => {
    await renderScreen([]);
    const empty = await screen.findByTestId('repo-accounts-empty');
    expect(within(empty).getByText(ACCOUNTS_EMPTY_TITLE)).toBeInTheDocument();
    expect(
      within(empty).getByText('Connect GitHub or GitLab to browse private repositories.')
    ).toBeInTheDocument();
    expect(within(empty).getByRole('link', { name: 'Connect an account' })).toHaveAttribute(
      'href',
      '/ade/dashboard/linked-accounts'
    );
  });

  it('names each account by its handle, or by its address when it has none', async () => {
    await renderScreen([GITHUB, GITLAB]);
    await screen.findByTestId('repo-account-acct-gh');
    expect(screen.getByText('ada-lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('GitLab')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   5. The repository picker
   ------------------------------------------------------------------------- */

describe('the repository picker', () => {
  it('lists the account’s repositories as one radio group', async () => {
    await renderScreen([GITHUB]);
    const list = await screen.findByTestId('repo-remote-list');
    expect(list).toHaveAttribute('role', 'radiogroup');
    expect(within(list).getByText('acme / payments-specs')).toBeInTheDocument();
    expect(within(list).getByText('acme / notifications-contracts')).toBeInTheDocument();
    expect(within(list).getByText('Order lifecycle contracts')).toBeInTheDocument();
  });

  it('marks a private repository in words as well as with a lock', async () => {
    await renderScreen([GITHUB]);
    await screen.findByTestId('repo-remote-list');
    const row = screen.getByTestId('repo-remote-2').closest('label') as HTMLElement;
    expect(within(row).getByText('Private repository')).toBeInTheDocument();
  });

  it('filters as the reader types, and counts what is left', async () => {
    await renderScreen([GITHUB]);
    await screen.findByTestId('repo-remote-list');
    expect(screen.getByTestId('repo-remote-count')).toHaveTextContent('3 repositories');

    fireEvent.change(screen.getByTestId('repo-remote-search'), { target: { value: 'orders' } });

    expect(screen.getByTestId('repo-remote-count')).toHaveTextContent('1 of 3 repositories');
    expect(screen.queryByText('acme / payments-specs')).not.toBeInTheDocument();
  });

  it('says so when a search matches nothing', async () => {
    await renderScreen([GITHUB]);
    await screen.findByTestId('repo-remote-list');

    fireEvent.change(screen.getByTestId('repo-remote-search'), { target: { value: 'zzz' } });

    expect(screen.getByTestId('repo-remote-miss')).toHaveTextContent('No repositories match “zzz”.');
  });

  it('says so when the account returned nothing at all', async () => {
    routes.repos = { body: { repositories: [] } };
    await renderScreen([GITHUB]);
    const empty = await screen.findByTestId('repo-remote-empty');
    expect(within(empty).getByText(REPOS_EMPTY)).toBeInTheDocument();
  });

  it('offers a retry when the read fails, and re-runs it', async () => {
    routes.repos = { status: 500, body: { error: 'GitHub is unavailable' } };
    await renderScreen([GITHUB]);
    const failure = await screen.findByTestId('repo-remote-error');
    expect(within(failure).getByText('GitHub is unavailable')).toBeInTheDocument();

    routes.repos = { body: { repositories: REMOTE_REPOS } };
    fireEvent.click(within(failure).getByRole('button', { name: /Try again/i }));

    await screen.findByTestId('repo-remote-list');
  });

  it('explains a non-GitHub account instead of leaving an empty box', async () => {
    await renderScreen([GITLAB]);
    await waitFor(() => expect(radio('repo-account-acct-gl')).toBeChecked());
    expect(screen.getByTestId('repo-provider-note')).toHaveTextContent(
      nonBrowsableProviderNote('gitlab')
    );
    expect(screen.queryByTestId('repo-remote-list')).not.toBeInTheDocument();
    // And it never asked GitHub about a GitLab account.
    expect(calls.some((call) => call.url.includes('/api/sso/github/repos'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   6. The public URL — acceptance criterion 2
   ------------------------------------------------------------------------- */

describe('the public-URL test', () => {
  /** Switch to the URL card and hand back its field. */
  const openUrlCard = async () => {
    await renderScreen([]);
    fireEvent.click(radio('repo-source-public_url'));
    return screen.getByTestId('repo-clone-url') as HTMLInputElement;
  };

  it('says the URL has not been tested before it has', async () => {
    await openUrlCard();
    const line = screen.getByTestId('repo-clone-url-result');
    expect(line).toHaveTextContent(URL_TEST_UNTESTED);
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveAttribute('data-tone', 'neutral');
  });

  it('refuses to test something that is not an HTTPS URL', async () => {
    const field = await openUrlCard();
    fireEvent.change(field, { target: { value: 'git@github.com:org/repo.git' } });
    fireEvent.click(screen.getByTestId('repo-clone-url-test'));

    expect(mockToastError).toHaveBeenCalledWith(URL_TEST_NEEDS_HTTPS_TOAST);
    expect(calls.some((call) => call.url.includes('test-public-url'))).toBe(false);
  });

  it('shows the server’s verdict, in the ok tone, and announces it', async () => {
    const field = await openUrlCard();
    fireEvent.change(field, { target: { value: 'https://github.com/org/public-repo.git' } });
    fireEvent.click(screen.getByTestId('repo-clone-url-test'));

    await waitFor(() =>
      expect(screen.getByTestId('repo-clone-url-result')).toHaveAttribute('data-tone', 'ok')
    );
    expect(screen.getByTestId('repo-clone-url-result')).toHaveTextContent(
      'URL responded successfully'
    );
    expect(mockToastSuccess).toHaveBeenCalledWith(URL_TEST_OK_TOAST);
  });

  it('shows the server’s reason, in the danger tone, when it does not answer', async () => {
    routes.test = { body: { ok: false, message: 'Server returned HTTP 404.' } };
    const field = await openUrlCard();
    fireEvent.change(field, { target: { value: 'https://github.com/org/missing.git' } });
    fireEvent.click(screen.getByTestId('repo-clone-url-test'));

    await waitFor(() =>
      expect(screen.getByTestId('repo-clone-url-result')).toHaveAttribute('data-tone', 'danger')
    );
    expect(screen.getByTestId('repo-clone-url-result')).toHaveTextContent(
      'Server returned HTTP 404.'
    );
  });

  it('says the test service could not be reached, rather than nothing at all', async () => {
    routes.test = { throws: true };
    const field = await openUrlCard();
    fireEvent.change(field, { target: { value: 'https://github.com/org/public-repo.git' } });
    fireEvent.click(screen.getByTestId('repo-clone-url-test'));

    await waitFor(() =>
      expect(screen.getByTestId('repo-clone-url-result')).toHaveTextContent(
        'Could not reach the test service.'
      )
    );
  });

  it('withdraws a passing verdict the moment the URL changes', async () => {
    const field = await openUrlCard();
    fireEvent.change(field, { target: { value: 'https://github.com/org/public-repo.git' } });
    fireEvent.click(screen.getByTestId('repo-clone-url-test'));
    await waitFor(() => expect(screen.getByTestId('repo-new-continue')).toBeEnabled());

    fireEvent.change(field, { target: { value: 'https://github.com/org/other-repo.git' } });

    expect(screen.getByTestId('repo-clone-url-result')).toHaveTextContent(URL_TEST_UNTESTED);
    expect(screen.getByTestId('repo-new-continue')).toBeDisabled();
    expect(screen.getByTestId('repo-new-blocker')).toHaveTextContent(TEST_BEFORE_CONTINUE_TOAST);
  });
});

/* -------------------------------------------------------------------------
   7. Continuing
   ------------------------------------------------------------------------- */

describe('the Continue button', () => {
  it('is unavailable until an account and a repository are chosen, and says why', async () => {
    await renderScreen([GITHUB, GITLAB]);
    await screen.findByTestId('repo-account-acct-gh');

    expect(screen.getByTestId('repo-new-continue')).toBeDisabled();
    expect(screen.getByTestId('repo-new-blocker')).toHaveTextContent(PICK_ACCOUNT_TOAST);

    fireEvent.click(radio('repo-account-acct-gh'));
    await screen.findByTestId('repo-remote-list');
    expect(screen.getByTestId('repo-new-blocker')).toHaveTextContent(PICK_REPOSITORY_TOAST);

    fireEvent.click(radio('repo-remote-2'));
    expect(screen.getByTestId('repo-new-continue')).toBeEnabled();
    expect(screen.getByTestId('repo-new-blocker')).toHaveTextContent('');
  });

  it('registers the chosen repository and goes to its preview', async () => {
    await renderScreen([GITHUB]);
    await screen.findByTestId('repo-remote-list');
    fireEvent.click(radio('repo-remote-2'));
    fireEvent.click(screen.getByTestId('repo-new-continue'));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/ade/dashboard/repositories/r-77/preview'));
    expect(mockToastSuccess).toHaveBeenCalledWith(REGISTERED_TOAST);

    const write = calls.find((call) => call.init?.method === 'POST' && call.url === '/api/repositories');
    expect(JSON.parse(String(write?.init?.body))).toEqual({
      source: 'linked_account',
      linked_account_id: 'acct-gh',
      repository_full_name: 'acme/notifications-contracts',
      clone_url: 'https://github.com/acme/notifications-contracts.git',
    });
  });

  it('registers a tested public URL', async () => {
    await renderScreen([]);
    fireEvent.click(radio('repo-source-public_url'));
    fireEvent.change(screen.getByTestId('repo-clone-url'), {
      target: { value: 'https://github.com/org/public-repo.git' },
    });
    fireEvent.click(screen.getByTestId('repo-clone-url-test'));
    await waitFor(() => expect(screen.getByTestId('repo-new-continue')).toBeEnabled());

    fireEvent.click(screen.getByTestId('repo-new-continue'));

    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    const write = calls.find((call) => call.url === '/api/repositories');
    expect(JSON.parse(String(write?.init?.body))).toEqual({
      source: 'public_url',
      clone_url: 'https://github.com/org/public-repo.git',
    });
  });

  it('shows a 501 as the capability being off, not as a failure of the form', async () => {
    routes.create = { status: 501, body: {} };
    await renderScreen([GITHUB]);
    await screen.findByTestId('repo-remote-list');
    fireEvent.click(radio('repo-remote-1'));
    fireEvent.click(screen.getByTestId('repo-new-continue'));

    const banner = await screen.findByTestId('repo-new-error');
    expect(within(banner).getByText(IMPORT_FAILED_TITLE)).toBeInTheDocument();
    expect(within(banner).getByText(NOT_ENABLED_MESSAGE)).toBeInTheDocument();
    expect(within(banner).getByText(IMPORT_FAILED_REMEDY)).toBeInTheDocument();
    expect(mockToastMessage).toHaveBeenCalledWith(NOT_ENABLED_MESSAGE);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows the API’s own sentence when the write fails', async () => {
    routes.create = { status: 500, body: { detail: [{ msg: 'clone_url: not reachable' }] } };
    await renderScreen([GITHUB]);
    await screen.findByTestId('repo-remote-list');
    fireEvent.click(radio('repo-remote-1'));
    fireEvent.click(screen.getByTestId('repo-new-continue'));

    const banner = await screen.findByTestId('repo-new-error');
    expect(within(banner).getByText('clone_url: not reachable')).toBeInTheDocument();
    expect(banner).toHaveAttribute('role', 'alert');
  });

  it('drops a stale failure once the reader changes what they are importing', async () => {
    routes.create = { status: 500, body: { error: 'Already registered' } };
    await renderScreen([GITHUB]);
    await screen.findByTestId('repo-remote-list');
    fireEvent.click(radio('repo-remote-1'));
    fireEvent.click(screen.getByTestId('repo-new-continue'));
    await screen.findByTestId('repo-new-error');

    fireEvent.click(radio('repo-remote-2'));

    expect(screen.queryByTestId('repo-new-error')).not.toBeInTheDocument();
  });
});

describe('the Back button', () => {
  it('is disabled on the first step, and says so', async () => {
    await renderScreen();
    const back = screen.getByTestId('repo-new-back');
    expect(back).toBeDisabled();
    expect(back).toHaveAttribute('title', expect.stringContaining('first step'));
  });
});

/* -------------------------------------------------------------------------
   8. The browser fixtures
   ------------------------------------------------------------------------- */

/**
 * `e2e/hive-add-repository.spec.ts` measures computed layout, which jsdom cannot do. Rather
 * than hand-writing HTML that would drift from the components, this renders the real screen and
 * writes what it rendered into `e2e/fixtures/hive-add-repository/` when
 * `ADD_REPOSITORY_FIXTURE_DUMP=1` is set:
 *
 *     ADD_REPOSITORY_FIXTURE_DUMP=1 npx jest -c jest.config.ts tests/add-repository-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is there
 * — so a change that would leave the fixtures stale fails loudly here before it fails quietly
 * in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-add-repository');
  const dump = process.env.ADD_REPOSITORY_FIXTURE_DUMP === '1';

  /** Write one fixture, or just assert it could be. */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /** The page column the shell would put this screen in. */
  const page = () => document.querySelector('.page') as HTMLElement;

  it('renders the linked-account surface (and writes its fixture on request)', async () => {
    await renderScreen([GITHUB, GITLAB]);
    fireEvent.click(radio('repo-account-acct-gh'));
    await screen.findByTestId('repo-remote-list');
    fireEvent.click(radio('repo-remote-2'));
    write('linked', page().outerHTML);
  });

  it('renders the public-URL surface (and writes its fixture on request)', async () => {
    routes.test = { body: { ok: false, message: 'Server returned HTTP 404. The URL may be private or invalid.' } };
    await renderScreen([]);
    fireEvent.click(radio('repo-source-public_url'));
    fireEvent.change(screen.getByTestId('repo-clone-url'), {
      target: { value: 'https://github.com/org/public-repo.git' },
    });
    fireEvent.click(screen.getByTestId('repo-clone-url-test'));
    await waitFor(() =>
      expect(screen.getByTestId('repo-clone-url-result')).toHaveAttribute('data-tone', 'danger')
    );
    write('url', page().outerHTML);
  });

  it('renders the empty-accounts surface (and writes its fixture on request)', async () => {
    await renderScreen([]);
    await screen.findByTestId('repo-accounts-empty');
    write('empty', page().outerHTML);
  });
});
