/**
 * Linked-accounts panel provider rendering tests (OLO-2.3, #4195).
 *
 * The panel receives provider-registry summaries from its server page and must offer exactly
 * the enabled providers: enabled ones get a working Link card, `coming-soon` entries render
 * as disabled teasers, and an available-but-env-disabled provider is hidden entirely. Rows
 * for accounts linked under a since-disabled provider still render with their label.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockUseSession = jest.fn();
const mockGetLinkedAccounts = jest.fn();
const mockGetHasPassword = jest.fn();

jest.mock('@lib/auth/session-client', () => ({
  AuthSessionProvider: ({ children }: { children: unknown }) => children,
  signOut: jest.fn(),
  useAuthSession: () => mockUseSession(),
  signIn: jest.fn(),
}));

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({ confirm: jest.fn() }),
}));

jest.mock('../lib/db/helper', () => ({
  getLinkedAccountsForUser: (...args: unknown[]) => mockGetLinkedAccounts(...args),
  getUserHasPassword: (...args: unknown[]) => mockGetHasPassword(...args),
  unlinkExternalAccount: jest.fn(),
  updatePersonalAccessToken: jest.fn(),
  removePersonalAccessToken: jest.fn(),
}));

import LinkedAccountsClient from '../src/app/ade/dashboard/linked-accounts/LinkedAccountsClient';
import type { ProviderSummary } from '../lib/auth/provider-registry';

/** Summaries mirroring a deployment with GitHub + GitLab enabled; azure/google/okta/aws env-disabled.
 * A synthetic Keycloak entry keeps coming-soon teaser coverage (OLO-9.5 will own the real slug). */
const GITHUB_GITLAB_ENABLED: ProviderSummary[] = [
  { id: 'github', label: 'GitHub', status: 'available', enabled: true },
  { id: 'gitlab', label: 'GitLab', status: 'available', enabled: true },
  { id: 'azure', label: 'Microsoft', status: 'available', enabled: false },
  { id: 'google', label: 'Google', status: 'available', enabled: false },
  { id: 'okta', label: 'Okta', status: 'available', enabled: false },
  { id: 'aws', label: 'AWS', status: 'available', enabled: false },
  { id: 'keycloak', label: 'Keycloak', status: 'coming-soon', enabled: false },
];

/** One azure identity linked — used by the last-sign-in-method guard tests. */
const ONE_AZURE_ACCOUNT = JSON.stringify([
  {
    id: 'acct-1',
    provider: 'azure',
    provider_user_id: 'oid-1',
    provider_email: 'user@example.com',
    provider_username: null,
    created_at: '2026-07-01T00:00:00Z',
    last_login_at: null,
  },
]);

beforeEach(() => {
  mockUseSession.mockReset();
  mockGetLinkedAccounts.mockReset();
  mockGetHasPassword.mockReset();
  mockUseSession.mockReturnValue({ data: { user: { user_id: 'user-1' } } });
  mockGetLinkedAccounts.mockResolvedValue('[]');
  // Default: the user also has a password, so no unlink is the "last" sign-in method.
  mockGetHasPassword.mockResolvedValue(JSON.stringify({ hasPassword: true }));
});

describe('LinkedAccountsClient — provider cards from the registry (OLO-2.3)', () => {
  it('offers enabled providers and coming-soon teasers, and hides env-disabled ones', async () => {
    render(<LinkedAccountsClient providers={GITHUB_GITLAB_ENABLED} />);
    await waitFor(() => expect(mockGetLinkedAccounts).toHaveBeenCalled());

    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('GitLab')).toBeInTheDocument();
    expect(screen.getByText('Keycloak')).toBeInTheDocument();
    // azure, google, okta, and aws are available-but-disabled in this deployment: no card at all.
    expect(screen.queryByText('Microsoft')).not.toBeInTheDocument();
    expect(screen.queryByText('Google')).not.toBeInTheDocument();
    expect(screen.queryByText('Okta')).not.toBeInTheDocument();
    expect(screen.queryByText('AWS')).not.toBeInTheDocument();
    // keycloak is the coming-soon teaser stand-in.
    expect(screen.getAllByText('Coming soon')).toHaveLength(1);
  });

  it('renders the Microsoft card once azure is env-enabled', async () => {
    const withAzure = GITHUB_GITLAB_ENABLED.map((provider) =>
      provider.id === 'azure' ? { ...provider, enabled: true } : provider
    );
    render(<LinkedAccountsClient providers={withAzure} />);
    await waitFor(() => expect(mockGetLinkedAccounts).toHaveBeenCalled());

    expect(screen.getByText('Microsoft')).toBeInTheDocument();
    // Three linkable providers → three enabled Link buttons; the keycloak teaser stays disabled.
    const linkButtons = screen.getAllByRole('button', { name: /Link$/ });
    expect(linkButtons.filter((button) => !button.hasAttribute('disabled'))).toHaveLength(3);
    expect(linkButtons.filter((button) => button.hasAttribute('disabled'))).toHaveLength(1);
  });

  it('still labels linked-account rows whose provider was since disabled', async () => {
    mockGetLinkedAccounts.mockResolvedValue(
      JSON.stringify([
        {
          id: 'acct-1',
          provider: 'azure',
          provider_user_id: 'oid-1',
          provider_email: 'user@example.com',
          provider_username: null,
          created_at: '2026-07-01T00:00:00Z',
          last_login_at: null,
        },
      ])
    );
    render(<LinkedAccountsClient providers={GITHUB_GITLAB_ENABLED} />);

    // The row uses the registry label even though azure gets no "Add a provider" card.
    expect(await screen.findByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByText('Microsoft')).toBeInTheDocument();
  });
});

describe('LinkedAccountsClient — last-sign-in-method guard (OLO-2.4)', () => {
  it('disables Unlink and explains why when it is the only sign-in method (no password)', async () => {
    mockGetLinkedAccounts.mockResolvedValue(ONE_AZURE_ACCOUNT);
    mockGetHasPassword.mockResolvedValue(JSON.stringify({ hasPassword: false }));

    render(<LinkedAccountsClient providers={GITHUB_GITLAB_ENABLED} />);

    const unlink = await screen.findByRole('button', { name: /Unlink/ });
    expect(unlink).toBeDisabled();
    expect(screen.getByText(/Only sign-in method/i)).toBeInTheDocument();
  });

  it('keeps Unlink enabled for the only identity when the user has a password', async () => {
    mockGetLinkedAccounts.mockResolvedValue(ONE_AZURE_ACCOUNT);
    mockGetHasPassword.mockResolvedValue(JSON.stringify({ hasPassword: true }));

    render(<LinkedAccountsClient providers={GITHUB_GITLAB_ENABLED} />);

    const unlink = await screen.findByRole('button', { name: /Unlink/ });
    expect(unlink).toBeEnabled();
    expect(screen.queryByText(/Only sign-in method/i)).not.toBeInTheDocument();
  });
});
