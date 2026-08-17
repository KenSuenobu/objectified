/**
 * Profile — `/ade/dashboard/profile` (HIVE-4.7, #5301).
 *
 * The ticket is a redesign of a page that already worked, so this suite is ordered by its
 * acceptance criteria rather than by the page's layout.
 *
 *   1. **One chrome.** The page's own `<header>` and `<main>` are gone — `AppShell` already
 *      draws a `<main>`, so the old markup nested a second landmark inside it — and what
 *      replaces them is `Page` / `PageHeader` / `PageBody` with the account tab strip.
 *   2. **Preserved exactly.** Every tile, every state of the last-login line, both copy
 *      affordances with their two-second confirmation, and all five dialogs with their
 *      validation copy unchanged. `two-factor-settings.test.tsx` covers the three that belong
 *      to `TwoFactorSettings` and passes against that file *unchanged*, which is the strongest
 *      statement this ticket can make about the 2FA flows.
 *   3. **Dialogs cannot be dismissed mid-request.**
 *   4. **Nothing names a colour**, so the page follows all nine themes.
 *   5. **axe: zero violations**, loaded and loading.
 *
 * What it cannot answer is how any of it *looks*: jsdom compiles no stylesheet. `profile-css.test.ts`
 * reads `globals.css` instead, and `e2e/hive-profile.spec.ts` measures the rendered page.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A real anchor, with navigation suppressed — jsdom logs an error rather than navigating. */
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} onClick={(event) => event.preventDefault()} {...rest}>
      {children}
    </a>
  ),
}));

/** The session the page renders against; a test may replace it before rendering. */
const sessionState: { current: { user: Record<string, unknown>; expires: string } | null } = {
  current: null,
};
const mockUpdate = jest.fn(async () => {});

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: sessionState.current,
    status: sessionState.current ? 'authenticated' : 'unauthenticated',
    update: mockUpdate,
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

/** The five server actions the page reads or writes through. */
const mockLastLogin = jest.fn<Promise<string>, []>();
const mockLinkedAccounts = jest.fn<Promise<string>, [string]>();
const mockHasPassword = jest.fn<Promise<string>, [string]>();
const mockUpdateUserName = jest.fn<Promise<string>, [string, string]>();
const mockUpdateUserPassword = jest.fn<Promise<string>, [string, string, string]>();

jest.mock('@lib/db/helper', () => ({
  getCurrentUserLastLoginAt: () => mockLastLogin(),
  getLinkedAccountsForUser: (userId: string) => mockLinkedAccounts(userId),
  getUserHasPassword: (userId: string) => mockHasPassword(userId),
  updateUserName: (userId: string, name: string) => mockUpdateUserName(userId, name),
  updateUserPassword: (userId: string, current: string, next: string) =>
    mockUpdateUserPassword(userId, current, next),
}));

const mockMembershipContext = jest.fn();
jest.mock('@lib/auth/tenant-membership-context', () => ({
  loadTenantMembershipContext: () => mockMembershipContext(),
}));

/** The preferences pane's bus — the Preferences tab's only job is to ring it. */
const mockOpenPreferences = jest.fn(() => true);
jest.mock('@/app/components/ade/preferences/preferencesDrawerBus', () => ({
  openPreferences: (...args: unknown[]) => mockOpenPreferences(...(args as [])),
}));

/** Signing out navigates, which jsdom cannot; the card takes the call and stops there. */
const mockRevokeAndSignOut = jest.fn(async () => true);
jest.mock('@lib/auth/sign-out-client', () => ({
  signOutEverywhere: jest.fn(async () => {}),
  revokeAllSessionsAndSignOut: (url: string) => mockRevokeAndSignOut(url),
}));

/** `TwoFactorSettings`' own dependencies — its behaviour is pinned by its own suite. */
jest.mock('@lib/auth/auth-client', () => ({
  authClient: {
    twoFactor: {
      enable: jest.fn(),
      disable: jest.fn(),
      verifyTotp: jest.fn(),
      generateBackupCodes: jest.fn(),
    },
  },
}));

jest.mock('@lib/auth/two-factor-profile-actions', () => ({
  getBackupCodeStatus: jest.fn(async () => ({ remaining: 6 })),
  getTrustedDeviceStatus: jest.fn(async () => ({ trusted: false })),
  getEmailOtpAvailability: jest.fn(async () => ({ available: false })),
  revokeThisTrustedDevice: jest.fn(async () => ({ ok: true })),
}));

jest.mock('react-qr-code', () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => <div data-testid="qr-mock">{value}</div>,
}));

import Profile from '@/app/ade/dashboard/profile/page';

/** The session user every test starts from. */
const USER = {
  user_id: 'usr_7d3e9a1c4b',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  emailVerified: true,
  current_tenant_id: 'ten_4a1b9f',
  twoFactorEnabled: true,
};

/**
 * A week and a half-day out, so the session meter has something to draw.
 *
 * The extra twelve hours are the point: the remainder is floored, and an expiry exactly seven
 * days from module load is six-point-nine-nine days away by the time the assertion runs.
 */
const EXPIRES = new Date(Date.now() + 7.5 * 24 * 60 * 60 * 1000).toISOString();

/** Two linked identities, as `getLinkedAccountsForUser` serialises them. */
const LINKED = [
  { provider: 'github', provider_username: 'ada-lovelace', provider_email: 'ada@example.com' },
  { provider: 'gitlab', provider_username: null, provider_email: 'ada@example.com' },
];

/** The membership context, as the rail's switcher loads it. */
const MEMBERSHIPS = {
  tenants: [{ id: 'ten_4a1b9f', name: 'Acme Corp', role: 'owner', status: 'active' }],
  adminTenantIds: ['ten_4a1b9f'],
  createTenant: null,
};

/** The clipboard the copy buttons write to. */
const writeText = jest.fn(async () => {});

/**
 * A real browser's user-agent string.
 *
 * jsdom advertises `Mozilla/5.0 (linux) … jsdom/26.1.0`, which names no browser at all — so
 * the device line correctly draws nothing under it, and a test run against that would be
 * asserting jsdom's identity rather than the parser's.
 */
const CHROME_ON_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

beforeAll(() => {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  Object.defineProperty(window.navigator, 'userAgent', {
    value: CHROME_ON_MAC,
    configurable: true,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionState.current = { user: { ...USER }, expires: EXPIRES };
  mockLastLogin.mockResolvedValue(
    JSON.stringify({ success: true, lastLoginAt: new Date(2026, 7, 15, 9, 12).toISOString() })
  );
  mockLinkedAccounts.mockResolvedValue(JSON.stringify(LINKED));
  mockHasPassword.mockResolvedValue(JSON.stringify({ hasPassword: true }));
  mockMembershipContext.mockResolvedValue(MEMBERSHIPS);
  mockUpdateUserName.mockResolvedValue(JSON.stringify({ success: true }));
  mockUpdateUserPassword.mockResolvedValue(JSON.stringify({ success: true }));
});

/**
 * Render the page and wait for its three loads to land.
 *
 * @returns Testing Library's render result.
 */
async function renderProfile() {
  const result = render(<Profile />);
  await waitFor(() => expect(screen.getByTestId('profile-signin-github')).toBeInTheDocument());
  return result;
}

/* -------------------------------------------------------------------------
   1. One chrome
   ------------------------------------------------------------------------- */

describe('the page frame', () => {
  it('draws exactly one h1 and no landmark of its own', async () => {
    const { container } = await renderProfile();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Profile');
    // `AppShell` owns the `<main>`; the page's own one used to nest inside it.
    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('.page')).toBeInTheDocument();
    expect(container.querySelector('.page-body')).toBeInTheDocument();
  });

  it('describes itself in one line and trails the workspace it belongs to', async () => {
    await renderProfile();

    expect(
      screen.getByText('Your identity, password, two-factor and sign-in methods.')
    ).toBeInTheDocument();
    const crumbs = within(screen.getByTestId('page-breadcrumb'));
    expect(crumbs.getByText('Acme Corp')).toBeInTheDocument();
    expect(crumbs.getByText('Account')).toBeInTheDocument();
    expect(crumbs.getByText('Profile')).toHaveAttribute('aria-current', 'page');
  });

  it('offers the account tab strip, with Profile the current entry', async () => {
    await renderProfile();

    const tabs = within(screen.getByTestId('account-tabs'));
    expect(tabs.getByTestId('account-tab-profile')).toHaveAttribute('aria-current', 'page');
    expect(tabs.getByTestId('account-tab-linked-accounts')).toHaveAttribute(
      'href',
      '/ade/dashboard/linked-accounts'
    );
    expect(tabs.getByTestId('account-tab-linked-accounts')).not.toHaveAttribute('aria-current');
    expect(tabs.getByTestId('account-tab-preferences')).toBeInTheDocument();
  });

  it('counts the reader’s linked providers beside the Linked accounts tab', async () => {
    await renderProfile();
    expect(screen.getByTestId('account-tab-linked-accounts')).toHaveTextContent('2');
  });

  it('draws no count chip for a reader who has linked nothing', async () => {
    // "Linked accounts 0" reads as a defect; the plain label reads as an invitation.
    mockLinkedAccounts.mockResolvedValue(JSON.stringify([]));
    render(<Profile />);

    await waitFor(() =>
      expect(screen.getByTestId('profile-signin-password')).toBeInTheDocument()
    );
    expect(screen.getByTestId('account-tab-linked-accounts')).toHaveTextContent(
      /^Linked accounts$/
    );
  });

  it('opens the preferences pane from the third entry rather than navigating', async () => {
    await renderProfile();

    fireEvent.click(screen.getByTestId('account-tab-preferences'));
    expect(mockOpenPreferences).toHaveBeenCalled();
    expect(screen.getByTestId('account-tab-preferences')).not.toHaveAttribute('href');
  });

  it('shows a loading state, and asks for nothing, until there is a session', () => {
    sessionState.current = null;
    render(<Profile />);

    expect(screen.getByText('Loading profile...')).toBeInTheDocument();
    expect(mockLinkedAccounts).not.toHaveBeenCalled();
    expect(mockMembershipContext).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------
   2. Preserved exactly — the hero and the tiles
   ------------------------------------------------------------------------- */

describe('the identity hero', () => {
  it('names the reader, their address and their workspace', async () => {
    await renderProfile();

    const hero = within(screen.getByTestId('profile-identity'));
    expect(hero.getByRole('heading', { level: 2 })).toHaveTextContent('Ada Lovelace');
    expect(hero.getByText('ada@example.com')).toBeInTheDocument();
    expect(hero.getByText('Tenant active')).toBeInTheDocument();
    expect(hero.getByText('Acme Corp · Owner')).toBeInTheDocument();
    expect(screen.getByTestId('profile-2fa-summary')).toHaveTextContent('2FA on');
  });

  it('falls back to “Unnamed user” rather than to an empty heading', async () => {
    sessionState.current = { user: { ...USER, name: null }, expires: EXPIRES };
    await renderProfile();

    expect(
      within(screen.getByTestId('profile-identity')).getByRole('heading', { level: 2 })
    ).toHaveTextContent('Unnamed user');
  });

  it('drops the tenant badge when no workspace is selected', async () => {
    sessionState.current = { user: { ...USER, current_tenant_id: undefined }, expires: EXPIRES };
    await renderProfile();

    expect(screen.queryByText('Tenant active')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-tile-tenant')).toHaveTextContent('None selected');
  });

  it('says 2FA off when the account is not enrolled', async () => {
    sessionState.current = { user: { ...USER, twoFactorEnabled: false }, expires: EXPIRES };
    await renderProfile();

    expect(screen.getByTestId('profile-2fa-summary')).toHaveTextContent('2FA off');
  });
});

describe('the account details tiles', () => {
  it('prints every fact the card has always printed', async () => {
    await renderProfile();

    expect(screen.getByTestId('profile-tile-name')).toHaveTextContent('Ada Lovelace');
    expect(screen.getByTestId('profile-tile-email')).toHaveTextContent('ada@example.com');
    expect(screen.getByTestId('profile-tile-email')).toHaveTextContent('Verified');
    expect(screen.getByTestId('profile-tile-user-id')).toHaveTextContent('usr_7d3e9a1c4b');
    expect(screen.getByTestId('profile-tile-tenant')).toHaveTextContent('ten_4a1b9f');
    expect(screen.getByTestId('profile-tile-tenant')).toHaveTextContent('Acme Corp');
  });

  it('shows no verified badge for an unverified address', async () => {
    sessionState.current = { user: { ...USER, emailVerified: false }, expires: EXPIRES };
    await renderProfile();
    expect(screen.getByTestId('profile-tile-email')).not.toHaveTextContent('Verified');
  });

  it('walks the last-login line through its three states', async () => {
    // In flight.
    let resolveLogin: (value: string) => void = () => {};
    mockLastLogin.mockReturnValue(new Promise<string>((resolve) => {
      resolveLogin = resolve;
    }));
    render(<Profile />);
    expect(screen.getByTestId('profile-tile-last-login')).toHaveTextContent('…');

    // Present.
    await act(async () => {
      resolveLogin(
        JSON.stringify({ success: true, lastLoginAt: new Date(2026, 7, 15, 9, 12).toISOString() })
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId('profile-tile-last-login')).toHaveTextContent('08/15/26 09:12 AM')
    );
  });

  it('prints an em dash when the account has never logged in', async () => {
    mockLastLogin.mockResolvedValue(JSON.stringify({ success: true, lastLoginAt: null }));
    await renderProfile();

    await waitFor(() =>
      expect(screen.getByTestId('profile-tile-last-login')).toHaveTextContent('—')
    );
  });

  it('copies each identifier and confirms for two seconds', async () => {
    jest.useFakeTimers();
    try {
      render(<Profile />);
      const button = screen.getByTestId('profile-copy-user-id');
      expect(button).toHaveAccessibleName('Copy User ID');

      await act(async () => {
        fireEvent.click(button);
      });
      expect(writeText).toHaveBeenCalledWith('usr_7d3e9a1c4b');
      expect(screen.getByTestId('profile-copy-user-id')).toHaveAccessibleName('Copied User ID');

      act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(screen.getByTestId('profile-copy-user-id')).toHaveAccessibleName('Copy User ID');
    } finally {
      jest.useRealTimers();
    }
  });

  it('copies the tenant id from its own button', async () => {
    await renderProfile();

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-copy-tenant-id'));
    });
    expect(writeText).toHaveBeenCalledWith('ten_4a1b9f');
  });

  it('claims nothing when the clipboard refuses', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    await renderProfile();

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-copy-user-id'));
    });
    expect(screen.getByTestId('profile-copy-user-id')).toHaveAccessibleName('Copy User ID');
  });
});

/* -------------------------------------------------------------------------
   2b. Preserved exactly — the two page dialogs
   ------------------------------------------------------------------------- */

describe('the Edit name dialog', () => {
  it('opens from the header action and from the tile’s pencil', async () => {
    await renderProfile();

    fireEvent.click(screen.getByTestId('profile-edit-name-header'));
    expect(await screen.findByTestId('profile-edit-name-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByTestId('profile-edit-name-dialog')).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('profile-edit-name-tile'));
    expect(await screen.findByTestId('profile-edit-name-dialog')).toBeInTheDocument();
  });

  it('refuses an empty name with the string it has always used', async () => {
    await renderProfile();
    fireEvent.click(screen.getByTestId('profile-edit-name-header'));

    fireEvent.change(await screen.findByTestId('profile-name-input'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('profile-name-save'));

    expect(await screen.findByText('Name cannot be empty')).toBeInTheDocument();
    expect(mockUpdateUserName).not.toHaveBeenCalled();
  });

  it('saves a trimmed name and refreshes the session that prints it', async () => {
    await renderProfile();
    fireEvent.click(screen.getByTestId('profile-edit-name-header'));

    fireEvent.change(await screen.findByTestId('profile-name-input'), {
      target: { value: '  Ada King  ' },
    });
    fireEvent.click(screen.getByTestId('profile-name-save'));

    await waitFor(() => {
      expect(mockUpdateUserName).toHaveBeenCalledWith('usr_7d3e9a1c4b', 'Ada King');
      expect(mockUpdate).toHaveBeenCalled();
    });
    await waitFor(() =>
      expect(screen.queryByTestId('profile-edit-name-dialog')).not.toBeInTheDocument()
    );
  });

  it('submits on Enter', async () => {
    await renderProfile();
    fireEvent.click(screen.getByTestId('profile-edit-name-header'));

    const input = await screen.findByTestId('profile-name-input');
    fireEvent.change(input, { target: { value: 'Ada King' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockUpdateUserName).toHaveBeenCalled());
  });

  it('surfaces the server’s message and stays open', async () => {
    mockUpdateUserName.mockResolvedValue(JSON.stringify({ success: false, error: 'Name is taken' }));
    await renderProfile();
    fireEvent.click(screen.getByTestId('profile-edit-name-header'));

    fireEvent.change(await screen.findByTestId('profile-name-input'), {
      target: { value: 'Ada King' },
    });
    fireEvent.click(screen.getByTestId('profile-name-save'));

    expect(await screen.findByText('Name is taken')).toBeInTheDocument();
    expect(screen.getByTestId('profile-edit-name-dialog')).toBeInTheDocument();
  });

  it('cannot be dismissed while the save is in flight', async () => {
    let finish: (value: string) => void = () => {};
    mockUpdateUserName.mockReturnValue(new Promise<string>((resolve) => {
      finish = resolve;
    }));

    await renderProfile();
    fireEvent.click(screen.getByTestId('profile-edit-name-header'));
    fireEvent.change(await screen.findByTestId('profile-name-input'), {
      target: { value: 'Ada King' },
    });
    fireEvent.click(screen.getByTestId('profile-name-save'));

    await waitFor(() => expect(screen.getByTestId('profile-name-save')).toHaveTextContent('Saving…'));
    fireEvent.keyDown(screen.getByTestId('profile-edit-name-dialog'), { key: 'Escape' });
    expect(screen.getByTestId('profile-edit-name-dialog')).toBeInTheDocument();

    await act(async () => {
      finish(JSON.stringify({ success: true }));
    });
  });
});

describe('the Change password dialog', () => {
  /**
   * Open it.
   *
   * @returns Nothing; the dialog is on screen when this resolves.
   */
  async function openPasswordDialog() {
    fireEvent.click(screen.getByTestId('profile-change-password-open'));
    await screen.findByTestId('profile-password-dialog');
  }

  it('lists the three requirements, unchanged', async () => {
    await renderProfile();
    await openPasswordDialog();

    expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
    expect(screen.getByText('One uppercase and one lowercase letter')).toBeInTheDocument();
    expect(screen.getByText('One number or special character')).toBeInTheDocument();
  });

  it.each([
    ['', '', '', 'Please enter your current password'],
    ['current', '', '', 'Please enter a new password'],
    ['current', 'Abcdefg1', 'Abcdefg2', 'New passwords do not match'],
  ])('refuses (%s, %s, %s) with “%s”', async (current, next, confirm, message) => {
    await renderProfile();
    await openPasswordDialog();

    if (current) {
      fireEvent.change(screen.getByTestId('profile-current-password'), {
        target: { value: current },
      });
    }
    if (next) {
      fireEvent.change(screen.getByTestId('profile-new-password'), { target: { value: next } });
    }
    if (confirm) {
      fireEvent.change(screen.getByTestId('profile-confirm-password'), {
        target: { value: confirm },
      });
    }
    fireEvent.click(screen.getByTestId('profile-password-save'));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mockUpdateUserPassword).not.toHaveBeenCalled();
  });

  it('rates the new password against the rules the server enforces', async () => {
    await renderProfile();
    await openPasswordDialog();

    expect(screen.queryByTestId('profile-password-strength')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('profile-new-password'), { target: { value: 'abc' } });
    expect(screen.getByTestId('profile-password-strength')).toHaveTextContent('Weak');

    fireEvent.change(screen.getByTestId('profile-new-password'), { target: { value: 'Abcdefg1' } });
    expect(screen.getByTestId('profile-password-strength')).toHaveTextContent('Fair');

    fireEvent.change(screen.getByTestId('profile-new-password'), {
      target: { value: 'Abcdefghijk1' },
    });
    expect(screen.getByTestId('profile-password-strength')).toHaveTextContent('Strong');
  });

  it('changes the password on Enter and announces it', async () => {
    await renderProfile();
    await openPasswordDialog();

    fireEvent.change(screen.getByTestId('profile-current-password'), { target: { value: 'old' } });
    fireEvent.change(screen.getByTestId('profile-new-password'), { target: { value: 'Abcdefg1' } });
    const confirm = screen.getByTestId('profile-confirm-password');
    fireEvent.change(confirm, { target: { value: 'Abcdefg1' } });
    fireEvent.keyDown(confirm, { key: 'Enter' });

    await waitFor(() =>
      expect(mockUpdateUserPassword).toHaveBeenCalledWith('usr_7d3e9a1c4b', 'old', 'Abcdefg1')
    );
    expect(await screen.findByTestId('profile-success')).toHaveTextContent(
      'Password changed successfully.'
    );
  });

  it('lets the reader dismiss the success banner', async () => {
    await renderProfile();
    await openPasswordDialog();

    fireEvent.change(screen.getByTestId('profile-current-password'), { target: { value: 'old' } });
    fireEvent.change(screen.getByTestId('profile-new-password'), { target: { value: 'Abcdefg1' } });
    fireEvent.change(screen.getByTestId('profile-confirm-password'), {
      target: { value: 'Abcdefg1' },
    });
    fireEvent.click(screen.getByTestId('profile-password-save'));

    const banner = await screen.findByTestId('profile-success');
    fireEvent.click(within(banner).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('profile-success')).not.toBeInTheDocument());
  });

  it('cannot be dismissed while the change is in flight', async () => {
    let finish: (value: string) => void = () => {};
    mockUpdateUserPassword.mockReturnValue(new Promise<string>((resolve) => {
      finish = resolve;
    }));

    await renderProfile();
    await openPasswordDialog();
    fireEvent.change(screen.getByTestId('profile-current-password'), { target: { value: 'old' } });
    fireEvent.change(screen.getByTestId('profile-new-password'), { target: { value: 'Abcdefg1' } });
    fireEvent.change(screen.getByTestId('profile-confirm-password'), {
      target: { value: 'Abcdefg1' },
    });
    fireEvent.click(screen.getByTestId('profile-password-save'));

    await waitFor(() =>
      expect(screen.getByTestId('profile-password-save')).toHaveTextContent('Updating…')
    );
    fireEvent.keyDown(screen.getByTestId('profile-password-dialog'), { key: 'Escape' });
    expect(screen.getByTestId('profile-password-dialog')).toBeInTheDocument();

    await act(async () => {
      finish(JSON.stringify({ success: true }));
    });
  });
});

/* -------------------------------------------------------------------------
   2c. The aside
   ------------------------------------------------------------------------- */

describe('the Sign-in methods card', () => {
  it('keeps its prose and its link to the linked-accounts page', async () => {
    await renderProfile();

    const card = within(screen.getByTestId('profile-signin-methods'));
    expect(
      card.getByText(/Link providers like GitHub, GitLab, or Microsoft for single sign-on/)
    ).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Manage linked accounts/ })).toHaveAttribute(
      'href',
      '/ade/dashboard/linked-accounts'
    );
  });

  it('lists the reader’s own methods, password first', async () => {
    await renderProfile();

    expect(screen.getByTestId('profile-signin-password')).toHaveTextContent('Password');
    expect(screen.getByTestId('profile-signin-password')).toHaveTextContent('Active');
    expect(screen.getByTestId('profile-signin-github')).toHaveTextContent('GitHub');
    expect(screen.getByTestId('profile-signin-github')).toHaveTextContent('ada-lovelace');
    expect(screen.getByTestId('profile-signin-gitlab')).toHaveTextContent('ada@example.com');
  });

  it('shows an announced placeholder while the two lookups are in flight', () => {
    mockLinkedAccounts.mockReturnValue(new Promise<string>(() => {}));
    render(<Profile />);

    const loading = screen.getByTestId('profile-signin-loading');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveTextContent('Loading sign-in methods…');
  });

  it('degrades to an empty line rather than to a broken card', async () => {
    mockLinkedAccounts.mockResolvedValue('not json');
    mockHasPassword.mockResolvedValue('not json');
    render(<Profile />);

    expect(await screen.findByTestId('profile-signin-empty')).toBeInTheDocument();
  });
});

describe('the Session card', () => {
  it('prints the expiry, the long date and how much is left', async () => {
    await renderProfile();

    const expected = new Date(EXPIRES);
    expect(screen.getByTestId('profile-session-expires')).toHaveTextContent(
      expected.toLocaleString()
    );
    const meter = screen.getByTestId('profile-session-meter');
    expect(meter).toHaveAttribute('role', 'meter');
    expect(meter).toHaveAccessibleName('Session time used');
    // The meter carries the pair it is a share of; the figure beside it is the sentence a
    // reader wants, and it is drawn in muted ink rather than in the derived tone's — see
    // `SessionCard` for the High contrast measurement behind that.
    expect(meter).toHaveAttribute('aria-valuetext', '23 of 30 (77%)');
    expect(screen.getByTestId('profile-session-left')).toHaveTextContent('7d left of 30');
  });

  it('names the browser the reader is on', async () => {
    await renderProfile();
    expect(screen.getByTestId('profile-session-device')).toHaveTextContent('Chrome on macOS');
  });

  it('signs every session out', async () => {
    await renderProfile();

    fireEvent.click(screen.getByTestId('profile-sign-out-everywhere'));
    await waitFor(() => expect(mockRevokeAndSignOut).toHaveBeenCalledWith('/login'));
  });

  it('says so when the other sessions could not be revoked', async () => {
    mockRevokeAndSignOut.mockResolvedValue(false);
    await renderProfile();

    fireEvent.click(screen.getByTestId('profile-sign-out-everywhere'));
    expect(
      await screen.findByText('Other sessions could not be revoked. This browser was signed out.')
    ).toBeInTheDocument();
  });

  it('draws no meter for a session with no readable expiry', async () => {
    sessionState.current = { user: { ...USER }, expires: 'whenever' };
    await renderProfile();

    expect(screen.queryByTestId('profile-session-meter')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-session-left')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-session-expires')).toHaveTextContent('—');
  });
});

/* -------------------------------------------------------------------------
   2d. The Security card keeps its two-factor block
   ------------------------------------------------------------------------- */

describe('the Security card', () => {
  it('frames the password guidance and the whole two-factor cluster', async () => {
    await renderProfile();

    const card = within(screen.getByTestId('profile-security'));
    expect(card.getByText(/Use a strong, unique password/)).toBeInTheDocument();
    expect(card.getByTestId('two-factor-settings')).toBeInTheDocument();
    expect(card.getByTestId('two-factor-status')).toHaveTextContent('Enabled');
    await waitFor(() =>
      expect(card.getByTestId('two-factor-backup-remaining')).toHaveTextContent('6 remaining')
    );
    expect(card.getByTestId('two-factor-recovery-guidance')).toBeInTheDocument();
    expect(card.getByTestId('two-factor-disable-open')).toBeInTheDocument();
  });

  it('carries the page’s one primary action', async () => {
    await renderProfile();
    expect(screen.getByTestId('profile-change-password-open')).toHaveTextContent('Change password');
  });
});

/* -------------------------------------------------------------------------
   3. Degradation
   ------------------------------------------------------------------------- */

describe('when a lookup fails', () => {
  it('leaves the workspace unnamed rather than taking the page with it', async () => {
    mockMembershipContext.mockRejectedValue(new Error('REST is down'));
    await renderProfile();

    // The id is still the truth the session carries; only the name is missing.
    expect(screen.getByTestId('profile-tile-tenant')).toHaveTextContent('ten_4a1b9f');
    expect(screen.queryByText('Acme Corp · Owner')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-identity')).toBeInTheDocument();
  });

  it('still lists the methods it did resolve', async () => {
    mockMembershipContext.mockResolvedValue({ tenants: [], adminTenantIds: [], createTenant: null });
    await renderProfile();

    expect(screen.getByTestId('profile-signin-github')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   4. Nothing names a colour
   ------------------------------------------------------------------------- */

describe('the sources', () => {
  /** Every file this ticket wrote or rewrote, as paths from the package root. */
  const SOURCES = [
    'src/app/ade/dashboard/profile/page.tsx',
    'src/app/ade/dashboard/profile/TwoFactorSettings.tsx',
    'src/app/components/ade/account/AccountDetailsCard.tsx',
    'src/app/components/ade/account/AccountTabs.tsx',
    'src/app/components/ade/account/BackupCodes.tsx',
    'src/app/components/ade/account/ChangePasswordDialog.tsx',
    'src/app/components/ade/account/EditNameDialog.tsx',
    'src/app/components/ade/account/IdentityHero.tsx',
    'src/app/components/ade/account/SecurityCard.tsx',
    'src/app/components/ade/account/SessionCard.tsx',
    'src/app/components/ade/account/SignInMethodsCard.tsx',
  ] as const;

  /**
   * Read one of them, with its comments removed.
   *
   * The comments have to go, and for a reason worth stating: these files *document* the named
   * colours they replaced (`from-indigo-500 via-violet-500 to-purple-500`, `ring-gray-800`),
   * which is exactly the record a later reader needs and exactly what a naive scan of the raw
   * text would flag. The rule is about what the component renders, so the check reads the code.
   *
   * @param relative The path from the package root.
   * @returns Its text with block and line comments stripped.
   */
  function source(relative: string): string {
    const path = join(__dirname, '..', relative);
    expect(existsSync(path)).toBe(true);
    return readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it.each(SOURCES)('%s names no palette colour', (relative) => {
    const text = source(relative);
    // The Tailwind palette classes the page used to be built from — `text-indigo-600`,
    // `bg-gray-50/70`, `dark:ring-gray-800`. A role token (`text-ok`, `bg-subtle`) has no
    // numeric step, which is what tells the two apart.
    const named =
      /\b(?:bg|text|border|ring|from|via|to|shadow|divide|outline|decoration|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
    expect(text.match(named) ?? []).toEqual([]);
  });

  it('has no `dark:` variant left anywhere in the cluster', () => {
    // A `dark:` pair is a two-theme answer to a nine-theme question: the token layer swaps
    // per `html[data-theme]`, so a component never has to know which appearance it is in.
    for (const relative of SOURCES) {
      expect(source(relative).match(/\bdark:/g) ?? []).toEqual([]);
    }
  });

  it('never puts a bare paragraph inside a tinted banner', () => {
    // `globals.css` ends with an unlayered `p { color: var(--text-muted) }`, which outranks the
    // `text-accent-fg` utility `Alert` carries — so a `<p>` inside a banner renders muted ink on
    // the accent tint, 3.86:1 in Solarized and a serious axe finding. `AlertTitle` is an `h5`,
    // which no base rule touches, and a `<span>` inherits. This is the check that stops the
    // idiom coming back.
    for (const relative of SOURCES) {
      for (const block of source(relative).match(/<Alert\b[\s\S]*?<\/Alert>/g) ?? []) {
        expect({ relative, block }).toEqual({ relative, block: expect.not.stringMatching(/<p[\s>]/) });
      }
    }
  });

  it('keeps the one white it needs, and says why', () => {
    // A QR code is read by a camera; its quiet zone has to stay light in every theme. It is the
    // only literal colour in the cluster, and the comment beside it is what makes it a decision
    // rather than an oversight.
    const path = join(__dirname, '..', 'src/app/ade/dashboard/profile/TwoFactorSettings.tsx');
    const raw = readFileSync(path, 'utf8');
    expect(raw.match(/\bbg-white\b/g)).toHaveLength(1);
    expect(raw).toContain('read by a camera');
  });
});

/* -------------------------------------------------------------------------
   5. axe
   ------------------------------------------------------------------------- */

describe('accessibility', () => {
  it('has no violations once loaded', async () => {
    const { container } = await renderProfile();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations while loading', async () => {
    mockLinkedAccounts.mockReturnValue(new Promise<string>(() => {}));
    const { container } = render(<Profile />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with no session at all', async () => {
    sessionState.current = null;
    const { container } = render(<Profile />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
