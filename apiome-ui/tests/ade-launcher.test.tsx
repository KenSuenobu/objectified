/**
 * The `/ade` launcher (HIVE-4.5, #5299).
 *
 * The ticket is a re-skin, so the first thing this suite asserts is *inventory*: every line
 * of the mockup's "Keeps (1:1)" list is still on the page and still does what it did — the
 * build badge that opens What's new, preferences, the account chip, sign out, the greeting
 * and headline, the ordered application grid, the resource rows, the dashed roadmap panel
 * and the footer.
 *
 * On top of that, the four acceptance criteria that are statements about markup rather than
 * about looks: commercial cards come from entitlements and no product route is written down,
 * an unshipped card is genuinely non-interactive and says "(coming soon)", an external card
 * opens a new tab and says so, and the three overlay hosts this route alone is responsible
 * for are mounted. The fifth — "no rail renders on /ade" — is answered by the absence of
 * `AppShell` from the tree, which is asserted here as the absence of its navigation landmark.
 *
 * What the suite cannot answer is anything about how it *looks*: jsdom compiles no
 * stylesheet. `tests/launcher-css.test.ts` reads the stylesheet instead.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

const mockSignOutEverywhere = jest.fn<Promise<void>, [string]>(async () => undefined);
const mockOpenPreferences = jest.fn<boolean, [string | undefined]>(() => true);

// A real anchor, so every card and row keeps its link semantics for axe and for the `href`
// assertions — with the navigation suppressed, which jsdom answers with a "Not implemented"
// console error rather than by navigating.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} onClick={(event) => event.preventDefault()} {...rest}>
      {children}
    </a>
  ),
}));

/** The session the page renders against; a test may replace it before rendering. */
const sessionUser: { current: Record<string, unknown> | null } = {
  current: {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    current_tenant_id: 'tenant-1',
  },
};

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: sessionUser.current ? { user: sessionUser.current } : null,
    status: 'authenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@lib/auth/sign-out-client', () => ({
  signOutEverywhere: (callbackUrl: string) => mockSignOutEverywhere(callbackUrl),
}));

jest.mock('@/app/components/ade/preferences/preferencesDrawerBus', () => ({
  openPreferences: (tab?: string) => mockOpenPreferences(tab),
}));

jest.mock('rehype-raw', () => ({ __esModule: true, default: () => () => {} }));

// The three overlay hosts have their own suites (`preferences-drawer-host`,
// `command-palette-entry-points`, `shortcut-sheet`). Here the only question is whether this
// route — the one `/ade` route with no `AppShell` to host them — mounts all three.
jest.mock('@/app/components/ade/preferences/PreferencesDrawerHost', () => ({
  __esModule: true,
  default: () => <div data-testid="preferences-host" />,
}));
jest.mock('@/app/components/shell/CommandPaletteHost', () => ({
  __esModule: true,
  default: ({ currentTenantId }: { currentTenantId: string | null }) => (
    <div data-testid="palette-host" data-tenant={currentTenantId ?? ''} />
  ),
}));
jest.mock('@/app/components/shell/ShortcutsHost', () => ({
  __esModule: true,
  default: ({ currentTenantId }: { currentTenantId: string | null }) => (
    <div data-testid="shortcuts-host" data-tenant={currentTenantId ?? ''} />
  ),
}));

import AdeHome from '../src/app/components/ade/AdeHome';
import { APP_VERSION_BADGE } from '../lib/app-version';
import { WHATS_NEW_SEEN_STORAGE_KEY } from '../src/app/components/shell/whatsNewSeen';
import type { ExternalHomeCard } from '../lib/external-links';
import type { LauncherSummary } from '../lib/db/launcher-summary';

/** A commercial card exactly as `getCommercialAccessForSession()` hands one over. */
const SUITE_CARD: ExternalHomeCard = {
  id: 'suite',
  name: 'Designer Suite',
  tagline: 'Design workspace',
  description: 'Schema design and API path modeling in one suite.',
  href: 'https://studio.example.test/',
  enabled: true,
  external: true,
  icon: 'Layers',
  accent: 'from-violet-500 to-fuchsia-600',
  glow: 'group-hover:shadow-fuchsia-500/20',
  tone: 'violet',
};

/** The always-listed, never-shipped card the built-in catalog contributes. */
const DEVELOPER_CARD: ExternalHomeCard = {
  ...SUITE_CARD,
  id: 'developer-suite',
  name: 'Developer Suite',
  tagline: 'Developer tools',
  description: 'SDKs, tooling, and developer workflows — coming soon.',
  href: '#',
  enabled: false,
  external: false,
  icon: 'Workflow',
};

/** A resolved hero summary. */
const SUMMARY: LauncherSummary = {
  workspace: { id: 'tenant-1', name: 'Acme Corp', role: 'owner', licenseName: 'Free' },
  projectCount: 3,
  publishedCount: 5,
};

/**
 * Render the launcher.
 *
 * @param props Overrides for the page's props.
 * @returns The Testing Library result.
 */
function renderLauncher(props: Partial<React.ComponentProps<typeof AdeHome>> = {}) {
  return render(
    <AdeHome commercialHomeCards={[SUITE_CARD, DEVELOPER_CARD]} summary={SUMMARY} {...props} />
  );
}

beforeEach(() => {
  sessionUser.current = {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    current_tenant_id: 'tenant-1',
  };
  mockSignOutEverywhere.mockClear();
  mockOpenPreferences.mockClear();
  window.localStorage.clear();
  // `WhatsNewDialog` fetches the release notes on open; jsdom ships no `fetch`.
  global.fetch = jest.fn().mockResolvedValue({ text: async () => 'Notes.' }) as unknown as typeof fetch;
});

describe('launcher — the top row', () => {
  it('carries the brand, the build, preferences, the account and sign out', () => {
    renderLauncher();

    expect(screen.getByRole('link', { name: 'Apiome home' })).toHaveAttribute('href', '/ade');
    expect(screen.getByRole('button', { name: /see what's new/ })).toHaveTextContent(
      APP_VERSION_BADGE
    );
    expect(screen.getByRole('button', { name: 'Preferences' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Account menu for Ada Lovelace' })
    ).toHaveAttribute('href', '/ade/dashboard/profile');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('opens What’s new from the build badge, and marks the build read as it does', async () => {
    const user = userEvent.setup();
    renderLauncher();

    expect(window.localStorage.getItem(WHATS_NEW_SEEN_STORAGE_KEY)).toBeNull();
    await user.click(screen.getByRole('button', { name: /see what's new/ }));

    // The launcher's badge and the rail's user menu show the same notes for the same build,
    // so reading them here has to clear the rail's unread dot as well (HIVE-3.4).
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_STORAGE_KEY)).toBe(APP_VERSION_BADGE);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('asks the preferences bus for the pane rather than routing anywhere', async () => {
    const user = userEvent.setup();
    renderLauncher();

    await user.click(screen.getByRole('button', { name: 'Preferences' }));
    expect(mockOpenPreferences).toHaveBeenCalled();
  });

  it('still names the account chip for a reader with no display name', () => {
    // A credentials account may never have had one. The chip says "Account"; the greeting
    // below says "there" — the two fallbacks the pre-Hive launcher used, in the same places.
    sessionUser.current = { current_tenant_id: 'tenant-1' };
    renderLauncher();

    const chip = screen.getByRole('link', { name: 'Account menu' });
    expect(chip).toHaveTextContent('Account');
    expect(screen.getByText(/Good (morning|afternoon|evening), there/)).toBeInTheDocument();
  });

  it('signs out everywhere, back to the front door', async () => {
    const user = userEvent.setup();
    renderLauncher();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mockSignOutEverywhere).toHaveBeenCalledWith('/login');
  });
});

describe('launcher — the hero', () => {
  it('greets the reader by their first name', () => {
    renderLauncher();
    expect(screen.getByText(/Good (morning|afternoon|evening), Ada/)).toBeInTheDocument();
  });

  it('sets the headline and the lede', () => {
    renderLauncher();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Your API');
    expect(heading).toHaveTextContent('specification workspace');
    expect(screen.getByText(/Govern projects and versions/)).toBeInTheDocument();
  });

  it('summarises the workspace and the counts, each linking into the app', () => {
    renderLauncher();

    const workspace = screen.getByRole('link', { name: /Acme Corp/ });
    expect(workspace).toHaveAttribute('href', '/ade/dashboard/tenants');
    // Role and plan are worded by the workspace switcher's own formatter, so the rail and
    // the launcher can never describe the same membership two different ways.
    expect(workspace).toHaveTextContent('Owner · Free');

    expect(screen.getByRole('link', { name: '3 projects' })).toHaveAttribute(
      'href',
      '/ade/dashboard/projects'
    );
    expect(screen.getByRole('link', { name: '5 published' })).toHaveAttribute(
      'href',
      '/ade/dashboard/published'
    );
  });

  it('draws no chips at all when the summary could not be resolved', () => {
    // Every source behind them fails soft, so "no chips" is a state the page has to survive.
    renderLauncher({ summary: undefined });
    expect(screen.queryByRole('link', { name: /projects$/ })).not.toBeInTheDocument();
  });

  it('drops the workspace chip, but keeps the counts, for a reader with no workspace', () => {
    renderLauncher({ summary: { ...SUMMARY, workspace: null } });

    expect(screen.queryByRole('link', { name: /Acme Corp/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '3 projects' })).toBeInTheDocument();
  });
});

describe('launcher — the application grid', () => {
  it('orders Control Panel, then the host’s cards, then the Browser', () => {
    renderLauncher();

    const ids = screen
      .getAllByTestId(/^launch-app-/)
      .map((node) => node.getAttribute('data-testid'));
    expect(ids).toEqual([
      'launch-app-control-panel',
      'launch-app-suite',
      'launch-app-developer-suite',
      'launch-app-browser',
    ]);
  });

  it('renders commercial cards from entitlements alone', () => {
    // Nothing about the suite is written down in the page: withhold the cards and the slot
    // is empty, rather than showing a product the reader cannot reach.
    renderLauncher({ commercialHomeCards: [] });

    const ids = screen
      .getAllByTestId(/^launch-app-/)
      .map((node) => node.getAttribute('data-testid'));
    expect(ids).toEqual(['launch-app-control-panel', 'launch-app-browser']);
    expect(screen.queryByText('Designer Suite')).not.toBeInTheDocument();
  });

  it('takes the host card’s destination verbatim', () => {
    renderLauncher();
    expect(screen.getByTestId('launch-app-suite')).toHaveAttribute(
      'href',
      'https://studio.example.test/'
    );
  });

  it('opens an external card in a new tab, and says so before it is clicked', () => {
    renderLauncher();

    const browser = screen.getByTestId('launch-app-browser');
    expect(browser).toHaveAttribute('target', '_blank');
    // `noopener` keeps the new tab from reaching back through `window.opener`.
    expect(browser.getAttribute('rel')).toContain('noopener');
    expect(within(browser).getByText('Opens in a new tab')).toBeInTheDocument();
  });

  it('routes an internal card through the client router', () => {
    renderLauncher();
    expect(screen.getByTestId('launch-app-control-panel')).toHaveAttribute(
      'href',
      '/ade/dashboard'
    );
    expect(screen.getByTestId('launch-app-control-panel')).not.toHaveAttribute('target');
  });

  it('makes an unshipped card non-interactive and says why', () => {
    renderLauncher();

    const developer = screen.getByTestId('launch-app-developer-suite');
    // A disabled *button*, not a `<div aria-label>`: `aria-label` on a role-less element is
    // an axe violation, and the suffix has to reach a screen reader somehow.
    expect(developer.tagName).toBe('BUTTON');
    expect(developer).toBeDisabled();
    expect(developer).toHaveAccessibleName('Developer Suite (coming soon)');
    expect(within(developer).getByText('Coming soon')).toBeInTheDocument();
  });

  it('tints each card from its tone rather than from a colour', () => {
    renderLauncher();

    expect(screen.getByTestId('launch-app-control-panel')).toHaveAttribute('data-tone', 'accent');
    expect(screen.getByTestId('launch-app-browser')).toHaveAttribute('data-tone', 'ok');
    expect(screen.getByTestId('launch-app-suite')).toHaveAttribute('data-tone', 'violet');
  });

  it('falls back to the commercial tone for a host that declared none', () => {
    renderLauncher({ commercialHomeCards: [{ ...SUITE_CARD, tone: undefined }] });
    expect(screen.getByTestId('launch-app-suite')).toHaveAttribute('data-tone', 'violet');
  });
});

describe('launcher — resources and the roadmap', () => {
  it('lists help, community and the marketplace', () => {
    renderLauncher();

    // HIVE-4.9 (#5303): the row points at the in-app Help & docs page, which carries the
    // YouTube channel as one card among the guides — it no longer leaves for the channel
    // itself, so nothing here opens a new tab.
    const help = screen.getByTestId('launch-resource-help');
    expect(help).toHaveAttribute('href', '/ade/dashboard/help');
    expect(help).not.toHaveAttribute('target');

    for (const id of ['community', 'marketplace']) {
      const row = screen.getByTestId(`launch-resource-${id}`);
      expect(row.tagName).toBe('BUTTON');
      expect(row).toBeDisabled();
      expect(row).toHaveAccessibleName(/\(coming soon\)$/);
      expect(within(row).getByText('Soon')).toBeInTheDocument();
    }
  });

  it('keeps Audit in the dashed roadmap panel, disabled', () => {
    renderLauncher();

    const audit = screen.getByTestId('launch-resource-audit');
    expect(audit).toBeDisabled();
    expect(within(audit).getByText('Planned')).toBeInTheDocument();
    expect(
      screen.getByText('Governance and compliance tooling is in development.')
    ).toBeInTheDocument();
  });
});

describe('launcher — the page frame', () => {
  it('prints the build and the copyright in the footer', () => {
    renderLauncher();

    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText(APP_VERSION_BADGE)).toBeInTheDocument();
    expect(within(footer).getByText('© 2021 – 2026 NobuData LLC')).toBeInTheDocument();
  });

  it('draws no rail — this is the route AppShell does not own', () => {
    renderLauncher();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('mounts the three overlay hosts AppShell would otherwise provide', () => {
    renderLauncher();

    // Without these, `⌘,`, `⌘K` and `?` would do nothing on the first page a reader lands on.
    expect(screen.getByTestId('preferences-host')).toBeInTheDocument();
    expect(screen.getByTestId('palette-host')).toHaveAttribute('data-tenant', 'tenant-1');
    expect(screen.getByTestId('shortcuts-host')).toHaveAttribute('data-tenant', 'tenant-1');
  });
});

describe('launcher — accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = renderLauncher();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations without a summary or a commercial card', async () => {
    const { container } = renderLauncher({ commercialHomeCards: [], summary: undefined });
    expect(await axe(container)).toHaveNoViolations();
  });
});
