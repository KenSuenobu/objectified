/**
 * Linked accounts — `/ade/dashboard/linked-accounts` (HIVE-4.8, #5302).
 *
 * A redesign of a page that already worked, so this suite is ordered by the ticket's acceptance
 * criteria rather than by the page's layout:
 *
 *   1. **One chrome.** The page's own `<header>` is gone — `AppShell` already draws the page's
 *      chrome — and what replaces it is `Page` / `PageHeader` / `PageBody` with HIVE-4.7's
 *      account tab strip, carrying the linked count.
 *   2. **Last-remaining-method still blocks unlink with the explanatory tooltip** — and now with
 *      a visible note and an `aria-describedby` as well, because a disabled control whose reason
 *      lives only in a hover tooltip explains itself to nobody.
 *   3. **PAT add / update / remove flows and their scope copy preserved**, including the
 *      validation string and the two providers' scope lists.
 *   4. **`?linked=true` / `?error=` query handling and URL cleanup unchanged.**
 *   5. **Coming-soon providers render disabled at reduced opacity.**
 *   6. **Nothing names a colour**, so the page follows all nine themes.
 *   7. **axe: zero violations**, loaded and loading.
 *
 * What it cannot answer is how any of it *looks*: jsdom compiles no stylesheet.
 * `linked-accounts-css.test.ts` reads `globals.css` instead, and `e2e/hive-linked-accounts.spec.ts`
 * measures the rendered page. The strings and rules behind it are pinned by
 * `linked-accounts-model.test.ts`.
 *
 * `linked-accounts-providers.test.tsx` (OLO-2.3 / OLO-2.4) passes against the redesigned page
 * *unchanged*, which is the strongest statement this ticket can make about the registry contract.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A real anchor, with navigation suppressed — jsdom logs an error rather than navigating. */
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a
      href={typeof href === 'string' ? href : '#'}
      onClick={(event) => event.preventDefault()}
      {...rest}
    >
      {children}
    </a>
  ),
}));

/** The session the page renders against; a test may replace it before rendering. */
const sessionState: { current: { user: Record<string, unknown> } | null } = { current: null };
const mockSignIn = jest.fn();

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: sessionState.current,
    status: sessionState.current ? 'authenticated' : 'unauthenticated',
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

/** The five server actions the page reads or writes through. */
const mockLinkedAccounts = jest.fn<Promise<string>, [string]>();
const mockHasPassword = jest.fn<Promise<string>, [string]>();
const mockUnlink = jest.fn<Promise<string>, [string, string]>();
const mockUpdatePat = jest.fn<Promise<string>, [string, string, string]>();
const mockRemovePat = jest.fn<Promise<string>, [string, string]>();

jest.mock('@lib/db/helper', () => ({
  getLinkedAccountsForUser: (userId: string) => mockLinkedAccounts(userId),
  getUserHasPassword: (userId: string) => mockHasPassword(userId),
  unlinkExternalAccount: (userId: string, accountId: string) => mockUnlink(userId, accountId),
  updatePersonalAccessToken: (userId: string, accountId: string, token: string) =>
    mockUpdatePat(userId, accountId, token),
  removePersonalAccessToken: (userId: string, accountId: string) =>
    mockRemovePat(userId, accountId),
}));

/** The confirm dialog: records the options it was asked for, answers what the test set. */
const confirmOptions: Record<string, unknown>[] = [];
const confirmAnswer = { current: true };
jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({
    confirm: async (options: Record<string, unknown>) => {
      confirmOptions.push(options);
      return confirmAnswer.current;
    },
  }),
}));

/** The preferences pane's bus — the Preferences tab's only job is to ring it. */
const mockOpenPreferences = jest.fn(() => true);
jest.mock('@/app/components/ade/preferences/preferencesDrawerBus', () => ({
  openPreferences: (...args: unknown[]) => mockOpenPreferences(...(args as [])),
}));

import LinkedAccountsClient from '@/app/ade/dashboard/linked-accounts/LinkedAccountsClient';
import type { ProviderSummary } from '@lib/auth/provider-registry';

/** A deployment with GitHub and GitLab configured, plus one coming-soon teaser. */
const PROVIDERS: ProviderSummary[] = [
  { id: 'github', label: 'GitHub', status: 'available', enabled: true },
  { id: 'gitlab', label: 'GitLab', status: 'available', enabled: true },
  { id: 'azure', label: 'Microsoft', status: 'available', enabled: false },
  { id: 'atlassian', label: 'Atlassian', status: 'coming-soon', enabled: false },
];

/** GitHub with a stored token, GitLab without one — the mockup's own pair of rows. */
const TWO_ACCOUNTS = [
  {
    id: 'acct-github',
    provider: 'github',
    provider_user_id: 'gh-1',
    provider_email: 'ada@example.com',
    provider_username: 'ada-lovelace',
    access_token_suffix: 'a1b2c3',
    created_at: '2026-03-02T17:14:00.000Z',
    last_login_at: '2026-08-15T15:12:00.000Z',
  },
  {
    id: 'acct-gitlab',
    provider: 'gitlab',
    provider_user_id: 'gl-1',
    provider_email: 'ada@example.com',
    provider_username: null,
    access_token_suffix: null,
    created_at: '2026-08-15T15:40:00.000Z',
    last_login_at: null,
  },
];

/** Only GitHub, so the last-method guard can be turned on by dropping the password. */
const ONE_ACCOUNT = [TWO_ACCOUNTS[0]];

/** The URL the page is visited at, unless a test changes the query. */
const PAGE_URL = 'http://localhost/ade/dashboard/linked-accounts';

/**
 * Put the browser at a URL, so the query-string handshake has something to read.
 *
 * @param search The query string, with its leading `?`, or `''` for a plain visit.
 */
function visit(search: string): void {
  window.history.replaceState({}, '', `${PAGE_URL}${search}`);
}

/**
 * Render the page and wait for its two loads to land.
 *
 * @param providers The registry summaries to hand it.
 * @returns The render result.
 */
async function mount(providers: ProviderSummary[] = PROVIDERS) {
  const result = render(<LinkedAccountsClient providers={providers} />);
  await waitFor(() => expect(mockLinkedAccounts).toHaveBeenCalled());
  // `aria-busy` is on the table exactly while its rows are placeholders, so waiting for it to
  // go is waiting for the state the rest of the suite reads — the foot's count is not, because
  // the foot is drawn during the load too.
  await waitFor(() =>
    expect(screen.getByRole('table', { name: 'Linked accounts' })).not.toHaveAttribute('aria-busy')
  );
  return result;
}

/** `{ success: true }`, as every write answers on the happy path. */
const OK = JSON.stringify({ success: true });

beforeEach(() => {
  jest.clearAllMocks();
  confirmOptions.length = 0;
  confirmAnswer.current = true;
  sessionState.current = { user: { user_id: 'usr_1', name: 'Ada Lovelace' } };
  mockLinkedAccounts.mockResolvedValue(JSON.stringify(TWO_ACCOUNTS));
  mockHasPassword.mockResolvedValue(JSON.stringify({ hasPassword: true }));
  mockUnlink.mockResolvedValue(OK);
  mockUpdatePat.mockResolvedValue(OK);
  mockRemovePat.mockResolvedValue(OK);
  visit('');
});

// ---------------------------------------------------------------------------------------
// 1. One chrome
// ---------------------------------------------------------------------------------------

describe('one chrome (HIVE-3.5)', () => {
  it('draws Page / PageHeader / PageBody and no second landmark of its own', async () => {
    const { container } = await mount();

    expect(screen.getByTestId('page-header')).toBeInTheDocument();
    expect(container.querySelector('.page')).toBeInTheDocument();
    expect(container.querySelector('.page-body')).toBeInTheDocument();
    // The old page drew a `<header>` and a `<main>` inside the shell's own `<main>`.
    expect(container.querySelector('main')).toBeNull();
  });

  it('titles the page once, as an h1, with the mockup’s description', async () => {
    await mount();

    const heading = screen.getByRole('heading', { level: 1, name: 'Linked accounts' });
    expect(heading).toBeInTheDocument();
    expect(
      screen.getByText('Link external accounts for single sign-on and repository access.')
    ).toBeInTheDocument();
  });

  it('carries the account tab strip, marked on Linked accounts, with the linked count', async () => {
    await mount();

    const strip = screen.getByTestId('account-tabs');
    expect(within(strip).getByTestId('account-tab-linked-accounts')).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(within(strip).getByTestId('account-tab-profile')).not.toHaveAttribute('aria-current');
    expect(within(strip).getByTestId('account-tab-linked-accounts')).toHaveTextContent('2');
  });

  it('rings the preferences bus from the third tab', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('account-tab-preferences'));
    expect(mockOpenPreferences).toHaveBeenCalled();
  });

  it('breadcrumbs back to the dashboard through Account', async () => {
    await mount();

    const crumbs = screen.getByTestId('page-breadcrumb');
    expect(within(crumbs).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      '/ade/dashboard'
    );
    expect(within(crumbs).getByText('Account')).toBeInTheDocument();
  });

  it('shows the loading state, and no table, until there is a session', async () => {
    sessionState.current = null;
    render(<LinkedAccountsClient providers={PROVIDERS} />);

    expect(screen.getByText('Loading linked accounts...')).toBeInTheDocument();
    expect(screen.queryByTestId('linked-accounts-table')).not.toBeInTheDocument();
    expect(mockLinkedAccounts).not.toHaveBeenCalled();
  });

  it('offers "Link a provider" in the header, pointing at the provider grid', async () => {
    await mount();

    const action = within(screen.getByTestId('page-header-actions')).getByRole('link', {
      name: 'Link a provider',
    });
    expect(action).toHaveAttribute('href', '#linked-add-provider');
    // The grid is a labelled section, so the anchor lands somewhere with a name.
    expect(
      screen.getByRole('region', { name: 'Add a provider' }).getAttribute('id')
    ).toBe('linked-add-provider');
  });
});

// ---------------------------------------------------------------------------------------
// 2. The table
// ---------------------------------------------------------------------------------------

describe('the linked-accounts table (HIVE-2.3)', () => {
  it('is a real table with a caption and the mockup’s four columns', async () => {
    await mount();

    const table = screen.getByRole('table', { name: 'Linked accounts' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent?.trim());
    expect(headers).toEqual(['Account', 'Linked', 'Last login', 'Actions']);
  });

  it('prints the handle, the linked stamp, and an em dash for a row never signed in with', async () => {
    await mount();

    const rows = screen.getAllByRole('row');
    const github = rows.find((row) => row.textContent?.includes('ada-lovelace'))!;
    expect(within(github).getByText('ada-lovelace')).toBeInTheDocument();
    expect(github.textContent).toMatch(/\d{2}\/\d{2}\/\d{2} \d{2}:\d{2} [AP]M/);

    const gitlab = rows.find((row) => row.textContent?.includes('GitLab'))!;
    // GitLab has never been signed in with: the Last login cell is the em dash.
    expect(within(gitlab).getByText('—')).toBeInTheDocument();
  });

  it('counts the rows in the foot', async () => {
    await mount();
    expect(screen.getByTestId('linked-accounts-count')).toHaveTextContent('2 linked accounts');
  });

  it('counts one row in the singular', async () => {
    mockLinkedAccounts.mockResolvedValue(JSON.stringify(ONE_ACCOUNT));
    await mount();
    expect(screen.getByTestId('linked-accounts-count')).toHaveTextContent('1 linked account');
  });

  it('hints in the toolbar that a password is also set', async () => {
    await mount();
    expect(screen.getByTestId('linked-password-hint')).toHaveTextContent('Password also set');
  });

  it('draws no password hint for an account that has none', async () => {
    mockHasPassword.mockResolvedValue(JSON.stringify({ hasPassword: false }));
    await mount();
    expect(screen.queryByTestId('linked-password-hint')).not.toBeInTheDocument();
  });

  it('draws skeleton rows and announces the wait while loading', async () => {
    // A load that never resolves, so the loading state can be read.
    mockLinkedAccounts.mockReturnValue(new Promise<string>(() => {}));
    render(<LinkedAccountsClient providers={PROVIDERS} />);

    const table = await screen.findByRole('table', { name: 'Linked accounts' });
    expect(table).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading linked accounts…')).toBeInTheDocument();
    expect(screen.queryByTestId('linked-accounts-empty')).not.toBeInTheDocument();
    // "0 linked accounts" under two skeleton rows would be a statement the page cannot make yet.
    expect(screen.queryByTestId('linked-accounts-count')).not.toBeInTheDocument();
  });

  it('shows the empty state inside the card, with its own way out', async () => {
    mockLinkedAccounts.mockResolvedValue('[]');
    await mount();

    const empty = screen.getByTestId('linked-accounts-empty');
    expect(within(empty).getByText('No linked accounts')).toBeInTheDocument();
    expect(
      within(empty).getByText(
        'Link a provider below to sign in with SSO and manage repository access.'
      )
    ).toBeInTheDocument();
    expect(within(empty).getByRole('link', { name: 'Link a provider' })).toHaveAttribute(
      'href',
      '#linked-add-provider'
    );
    // The toolbar and the header stay where they were (DESIGN.md §8).
    expect(screen.getByRole('table', { name: 'Linked accounts' })).toBeInTheDocument();
    expect(screen.getByTestId('linked-accounts-count')).toHaveTextContent('0 linked accounts');
  });

  it('reports a failed load rather than showing an empty list', async () => {
    mockLinkedAccounts.mockRejectedValue(new Error('boom'));
    render(<LinkedAccountsClient providers={PROVIDERS} />);

    expect(await screen.findByTestId('linked-error')).toHaveTextContent(
      'Failed to load linked accounts'
    );
  });
});

// ---------------------------------------------------------------------------------------
// 3. The last-remaining-method guard
// ---------------------------------------------------------------------------------------

describe('the last-remaining-method guard (OLO-2.4)', () => {
  /** Mount with GitHub as the only identity and no password — the guarded state. */
  const mountGuarded = async () => {
    mockLinkedAccounts.mockResolvedValue(JSON.stringify(ONE_ACCOUNT));
    mockHasPassword.mockResolvedValue(JSON.stringify({ hasPassword: false }));
    return mount();
  };

  it('disables Unlink, titles it with the reason, and describes it by the visible note', async () => {
    await mountGuarded();

    const unlink = screen.getByTestId('linked-unlink-github');
    expect(unlink).toBeDisabled();
    expect(unlink).toHaveAttribute(
      'title',
      'This is your only sign-in method. Set a password or link another provider before unlinking it.'
    );

    // The note is visible without hovering, and is what a screen reader is pointed at.
    const noteId = unlink.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId as string)).toHaveTextContent(
      'Only sign-in method — set a password or link another provider to remove it.'
    );
  });

  it('keeps the guarded row’s actions visible instead of hiding them until hover', async () => {
    await mountGuarded();

    const row = screen.getByTestId('linked-unlink-github').closest('tr');
    expect(row).toHaveClass('lnk-row--guarded');
  });

  it('lifts the guard the moment a password exists', async () => {
    mockLinkedAccounts.mockResolvedValue(JSON.stringify(ONE_ACCOUNT));
    await mount();

    expect(screen.getByTestId('linked-unlink-github')).toBeEnabled();
    expect(screen.queryByText(/Only sign-in method/)).not.toBeInTheDocument();
  });

  it('lifts the guard the moment a second provider is linked', async () => {
    mockHasPassword.mockResolvedValue(JSON.stringify({ hasPassword: false }));
    await mount();

    expect(screen.getByTestId('linked-unlink-github')).toBeEnabled();
    expect(screen.getByTestId('linked-unlink-gitlab')).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------------------
// 4. Unlinking
// ---------------------------------------------------------------------------------------

describe('unlinking', () => {
  it('confirms with the object named and the consequence stated, then unlinks', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('linked-unlink-github'));
    await waitFor(() => expect(mockUnlink).toHaveBeenCalledWith('usr_1', 'acct-github'));

    expect(confirmOptions[0]).toMatchObject({
      title: 'Unlink GitHub account?',
      message: 'Are you sure you want to unlink your GitHub account (ada-lovelace)?',
      consequence:
        'You can still sign in with your password or GitLab. The stored Personal Access Token is removed too.',
      variant: 'danger',
      confirmLabel: 'Unlink',
    });

    expect(await screen.findByTestId('linked-success')).toHaveTextContent(
      'Successfully unlinked GitHub account'
    );
    // The list is re-read, so the row disappears without a navigation.
    expect(mockLinkedAccounts).toHaveBeenCalledTimes(2);
  });

  it('does nothing at all when the confirm is cancelled', async () => {
    confirmAnswer.current = false;
    await mount();

    fireEvent.click(screen.getByTestId('linked-unlink-github'));
    await waitFor(() => expect(confirmOptions).toHaveLength(1));
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('reports the server’s own refusal', async () => {
    mockUnlink.mockResolvedValue(
      JSON.stringify({ success: false, error: 'Cannot unlink your last sign-in method' })
    );
    await mount();

    fireEvent.click(screen.getByTestId('linked-unlink-github'));
    expect(await screen.findByTestId('linked-error')).toHaveTextContent(
      'Cannot unlink your last sign-in method'
    );
  });

  it('reports a thrown error rather than losing the click', async () => {
    mockUnlink.mockRejectedValue(new Error('network down'));
    await mount();

    fireEvent.click(screen.getByTestId('linked-unlink-github'));
    expect(await screen.findByTestId('linked-error')).toHaveTextContent('network down');
  });
});

// ---------------------------------------------------------------------------------------
// 5. The provider cards
// ---------------------------------------------------------------------------------------

describe('the provider cards', () => {
  it('badges a linked provider, its stored token, and names what the provider is', async () => {
    await mount();

    const card = screen.getByTestId('provider-card-github');
    expect(within(card).getByText('Linked')).toBeInTheDocument();
    expect(within(card).getByTestId('provider-pat-badge-github')).toHaveTextContent(
      'PAT ••••••a1b2c3'
    );
    expect(within(card).getByText('Repositories, organisations and pull requests')).toBeInTheDocument();
    // Nothing left to do here: unlinking is the table's.
    expect(within(card).queryByTestId('provider-link-github')).not.toBeInTheDocument();
  });

  it('renders a coming-soon provider disabled, dimmed, and badged', async () => {
    await mount();

    const card = screen.getByTestId('provider-card-atlassian');
    expect(card).toHaveClass('lnk-provider--soon');
    expect(within(card).getByText('Coming soon')).toBeInTheDocument();
    expect(within(card).getByTestId('provider-link-atlassian')).toBeDisabled();
  });

  it('hides a provider this deployment has not configured', async () => {
    await mount();
    // azure is `available` but unconfigured: its NextAuth route is not registered, so a Link
    // button could only dead-end.
    expect(screen.queryByTestId('provider-card-azure')).not.toBeInTheDocument();
  });

  it('holds Link disabled until the identities have landed', async () => {
    // Until the load resolves the card does not know whether this provider is already linked,
    // and a Link on a linked provider is a round trip the server is only going to refuse.
    mockLinkedAccounts.mockReturnValue(new Promise<string>(() => {}));
    render(<LinkedAccountsClient providers={PROVIDERS} />);

    expect(await screen.findByTestId('provider-link-github')).toBeDisabled();
  });

  it('starts the OAuth round trip through the pre-flight, then signIn', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;
    mockLinkedAccounts.mockResolvedValue('[]');
    await mount();

    fireEvent.click(screen.getByTestId('provider-link-gitlab'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/link/gitlab', {
        method: 'GET',
        credentials: 'include',
      })
    );
    expect(mockSignIn).toHaveBeenCalledWith('gitlab', {
      callbackUrl: '/ade/dashboard/linked-accounts',
    });
  });

  it('reports a pre-flight refusal and never leaves the page', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'provider-already-linked' }),
    }) as unknown as typeof fetch;
    mockLinkedAccounts.mockResolvedValue('[]');
    await mount();

    fireEvent.click(screen.getByTestId('provider-link-github'));

    expect(await screen.findByTestId('linked-error')).toHaveTextContent(
      'Failed to initiate account linking: provider-already-linked'
    );
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('reports a pre-flight that never answered', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    mockLinkedAccounts.mockResolvedValue('[]');
    await mount();

    fireEvent.click(screen.getByTestId('provider-link-github'));

    expect(await screen.findByTestId('linked-error')).toHaveTextContent(
      'An error occurred while linking the account'
    );
  });

  it('draws the token row only for a linked PAT provider', async () => {
    await mount();

    expect(screen.getByTestId('provider-pat-github')).toBeInTheDocument();
    // GitLab is linked and takes a token, so it gets the row with the "add one" hint.
    expect(screen.getByTestId('provider-pat-gitlab')).toHaveTextContent(
      'Optional: add a PAT for direct repo access.'
    );
    // Atlassian is not a PAT provider.
    expect(screen.queryByTestId('provider-pat-atlassian')).not.toBeInTheDocument();
  });

  it('says what a stored token ends in, and offers Update and Remove', async () => {
    await mount();

    const row = screen.getByTestId('provider-pat-github');
    expect(row).toHaveTextContent('PAT set (ends in ••••••a1b2c3).');
    expect(within(row).getByTestId('provider-pat-edit-github')).toHaveTextContent('Update');
    expect(within(row).getByTestId('provider-pat-remove-github')).toHaveTextContent('Remove');
  });

  it('offers only Add when there is no token yet', async () => {
    await mount();

    const row = screen.getByTestId('provider-pat-gitlab');
    expect(within(row).getByTestId('provider-pat-edit-gitlab')).toHaveTextContent('Add');
    expect(within(row).queryByTestId('provider-pat-remove-gitlab')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 6. The Personal Access Token flows
// ---------------------------------------------------------------------------------------

describe('the Personal Access Token dialog', () => {
  it('opens as Add, names the provider and the handle, and carries GitLab’s scopes', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-gitlab'));

    const dialog = await screen.findByTestId('pat-dialog');
    expect(within(dialog).getByText('Add Personal Access Token')).toBeInTheDocument();
    expect(within(dialog).getByText('GitLab · ada@example.com')).toBeInTheDocument();
    expect(within(dialog).getByTestId('pat-scopes')).toHaveTextContent(
      'read_api, read_repository, read_user'
    );
    expect(within(dialog).getByTestId('pat-save')).toHaveTextContent('Add token');
  });

  it('opens as Update for an identity that already has one, and carries GitHub’s scopes', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));

    const dialog = await screen.findByTestId('pat-dialog');
    expect(within(dialog).getByText('Update Personal Access Token')).toBeInTheDocument();
    expect(within(dialog).getByText('GitHub · ada-lovelace')).toBeInTheDocument();
    expect(within(dialog).getByTestId('pat-scopes')).toHaveTextContent(
      'repo (or public_repo), read:org, read:user, user:email'
    );
    expect(within(dialog).getByTestId('pat-save')).toHaveTextContent('Update token');
  });

  it('keeps the field a password field with the mockup’s placeholder and helper', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));
    const input = await screen.findByTestId('pat-token-input');

    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('placeholder', 'Paste your token');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(
      screen.getByText(/Used to authenticate with GitHub's API\./)
    ).toBeInTheDocument();
  });

  it('refuses an empty token with the Keeps list’s message, and never calls the action', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));
    fireEvent.click(await screen.findByTestId('pat-save'));

    expect(await screen.findByTestId('pat-error')).toHaveTextContent(
      'Personal Access Token is required'
    );
    expect(mockUpdatePat).not.toHaveBeenCalled();
    // The field says it is invalid, and points at the message.
    const input = screen.getByTestId('pat-token-input');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toBe(
      screen.getByTestId('pat-error').getAttribute('id')
    );
  });

  it('refuses whitespace as a token', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));
    fireEvent.change(await screen.findByTestId('pat-token-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('pat-save'));

    expect(await screen.findByTestId('pat-error')).toHaveTextContent(
      'Personal Access Token is required'
    );
    expect(mockUpdatePat).not.toHaveBeenCalled();
  });

  it('saves an added token, says so, and closes', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-gitlab'));
    fireEvent.change(await screen.findByTestId('pat-token-input'), {
      target: { value: 'glpat-secret' },
    });
    fireEvent.click(screen.getByTestId('pat-save'));

    await waitFor(() =>
      expect(mockUpdatePat).toHaveBeenCalledWith('usr_1', 'acct-gitlab', 'glpat-secret')
    );
    expect(await screen.findByTestId('linked-success')).toHaveTextContent(
      'Successfully added Personal Access Token'
    );
    await waitFor(() => expect(screen.queryByTestId('pat-dialog')).not.toBeInTheDocument());
  });

  it('says "updated" when one was already stored', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));
    fireEvent.change(await screen.findByTestId('pat-token-input'), {
      target: { value: 'ghp-secret' },
    });
    fireEvent.click(screen.getByTestId('pat-save'));

    expect(await screen.findByTestId('linked-success')).toHaveTextContent(
      'Successfully updated Personal Access Token'
    );
  });

  it('submits on Enter, as the field it replaced did', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));
    const input = await screen.findByTestId('pat-token-input');
    fireEvent.change(input, { target: { value: 'ghp-secret' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(mockUpdatePat).toHaveBeenCalledWith('usr_1', 'acct-github', 'ghp-secret')
    );
  });

  it('keeps a rejected save open, with the reason inside it', async () => {
    mockUpdatePat.mockResolvedValue(JSON.stringify({ success: false, error: 'Token rejected' }));
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));
    fireEvent.change(await screen.findByTestId('pat-token-input'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('pat-save'));

    expect(await screen.findByTestId('pat-error')).toHaveTextContent('Token rejected');
    expect(screen.getByTestId('pat-dialog')).toBeInTheDocument();
  });

  it('starts empty every time it opens, so a secret is never carried between visits', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));
    fireEvent.change(await screen.findByTestId('pat-token-input'), {
      target: { value: 'typed-then-abandoned' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('pat-dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));
    expect(await screen.findByTestId('pat-token-input')).toHaveValue('');
  });
});

describe('removing a Personal Access Token', () => {
  it('confirms, removes, and says which provider it was for', async () => {
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-remove-github'));
    await waitFor(() => expect(mockRemovePat).toHaveBeenCalledWith('usr_1', 'acct-github'));

    expect(confirmOptions[0]).toMatchObject({
      title: 'Remove Personal Access Token?',
      message:
        'Are you sure you want to remove the Personal Access Token for your GitHub account (ada-lovelace) (••••••a1b2c3)?',
      consequence: 'Repository imports that rely on it fall back to the OAuth grant.',
      confirmLabel: 'Remove token',
      variant: 'danger',
    });
    expect(await screen.findByTestId('linked-success')).toHaveTextContent(
      'Successfully removed Personal Access Token for GitHub'
    );
  });

  it('does nothing when the confirm is cancelled', async () => {
    confirmAnswer.current = false;
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-remove-github'));
    await waitFor(() => expect(confirmOptions).toHaveLength(1));
    expect(mockRemovePat).not.toHaveBeenCalled();
  });

  it('reports the server’s refusal', async () => {
    mockRemovePat.mockResolvedValue(JSON.stringify({ success: false }));
    await mount();

    fireEvent.click(screen.getByTestId('provider-pat-remove-github'));
    expect(await screen.findByTestId('linked-error')).toHaveTextContent(
      'Failed to remove Personal Access Token'
    );
  });
});

// ---------------------------------------------------------------------------------------
// 7. The query-string handshake
// ---------------------------------------------------------------------------------------

describe('the ?linked / ?error handshake', () => {
  it('announces a completed link and scrubs the query', async () => {
    visit('?linked=true');
    await mount();

    expect(screen.getByTestId('linked-success')).toHaveTextContent('Account linked successfully!');
    expect(window.location.pathname).toBe('/ade/dashboard/linked-accounts');
    expect(window.location.search).toBe('');
  });

  it('announces the callback’s error and scrubs the query', async () => {
    visit('?error=identity-linked-elsewhere');
    await mount();

    expect(screen.getByTestId('linked-error')).toHaveTextContent('identity-linked-elsewhere');
    expect(window.location.search).toBe('');
  });

  it('leaves a plain visit’s URL alone and shows no banner', async () => {
    visit('?tab=providers');
    await mount();

    expect(screen.queryByTestId('linked-success')).not.toBeInTheDocument();
    expect(screen.queryByTestId('linked-error')).not.toBeInTheDocument();
    expect(window.location.search).toBe('?tab=providers');
  });

  it('lets either banner be dismissed', async () => {
    visit('?linked=true');
    await mount();

    fireEvent.click(within(screen.getByTestId('linked-success')).getByRole('button'));
    expect(screen.queryByTestId('linked-success')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 8. Nothing names a colour
// ---------------------------------------------------------------------------------------

describe('the skin is tokens only', () => {
  /** The four source files this ticket owns. */
  const SOURCES = [
    'src/app/ade/dashboard/linked-accounts/LinkedAccountsClient.tsx',
    'src/app/components/ade/account/LinkedAccountsTable.tsx',
    'src/app/components/ade/account/ProviderCard.tsx',
    'src/app/components/ade/account/PatDialog.tsx',
  ];

  /**
   * Read one of this ticket's files.
   *
   * @param relative Its path from the package root.
   * @returns The source, with its comments removed so prose about the old colours does not
   *   read as a use of them.
   */
  const readSource = (relative: string): string =>
    readFileSync(join(__dirname, '..', relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it.each(SOURCES)('%s names no Tailwind palette colour', (relative) => {
    const source = readSource(relative);
    // The palette names the old page was painted in. `gray-`/`amber-`/`red-` etc. in a
    // utility can only come from outside the token set.
    expect(
      source.match(
        /\b(?:bg|text|border|ring|from|to|via|shadow|divide|outline|decoration|accent|caret|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/
      )
    ).toBeNull();
  });

  it.each(SOURCES)('%s names no hex colour', (relative) => {
    expect(readSource(relative).match(/#[0-9a-fA-F]{3,8}\b/)).toBeNull();
  });

  it.each(SOURCES)('%s freezes no font size or control height in px', (relative) => {
    const source = readSource(relative);
    expect(source.match(/\btext-\[\d+px\]/)).toBeNull();
    expect(source.match(/\bh-\[\d+px\]/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// 9. Accessibility
// ---------------------------------------------------------------------------------------

describe('accessibility', () => {
  it('has no axe violations once loaded', async () => {
    const { container } = await mount();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations while loading', async () => {
    mockLinkedAccounts.mockReturnValue(new Promise<string>(() => {}));
    const { container } = render(<LinkedAccountsClient providers={PROVIDERS} />);
    await screen.findByRole('table', { name: 'Linked accounts' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with the guard showing', async () => {
    mockLinkedAccounts.mockResolvedValue(JSON.stringify(ONE_ACCOUNT));
    mockHasPassword.mockResolvedValue(JSON.stringify({ hasPassword: false }));
    const { container } = await mount();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with nothing linked', async () => {
    mockLinkedAccounts.mockResolvedValue('[]');
    const { container } = await mount();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with the token dialog open', async () => {
    const { baseElement } = await mount();
    fireEvent.click(screen.getByTestId('provider-pat-edit-github'));
    await screen.findByTestId('pat-dialog');
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
