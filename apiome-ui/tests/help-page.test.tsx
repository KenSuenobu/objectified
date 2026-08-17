/**
 * Help & docs — `/ade/dashboard/help` (HIVE-4.9, #5303).
 *
 * Ordered by the ticket's acceptance criteria rather than by the page's layout:
 *
 *   1. **The rail's Help & docs link resolves to a real page.** The route renders a header,
 *      a breadcrumb and three regions — which is what "resolves" means for a route that used
 *      to fall through to the not-found page. (`hive-help.spec.ts` follows the rail link
 *      itself, which jsdom cannot.)
 *   2. **Guide search returns results and links out correctly.**
 *   3. **The support card shows the current tenant id and build label.**
 *   4. The cards behave like what they are: a link leaves, *Get started* clears the Home
 *      checklist's dismissal and returns to Home, and *Community* is disabled rather than a
 *      dead link.
 *   5. **axe: zero violations.**
 *
 * What it cannot answer is how any of it looks: jsdom compiles no stylesheet. `help-css.test.ts`
 * reads `globals.css`, and `e2e/hive-help.spec.ts` measures the rendered page.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

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

/** Where *Get started* sends the reader. */
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), prefetch: jest.fn() }),
}));

/** The session the page renders against; a test may replace it before rendering. */
const sessionState: { current: { user: Record<string, unknown> } | null } = { current: null };
jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: sessionState.current,
    status: sessionState.current ? 'authenticated' : 'unauthenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

/** The build the support card prints, fixed so the assertion is about the wiring. */
jest.mock('@lib/app-version', () => ({
  APP_VERSION: '0.271.0',
  APP_BUILD_LABEL: undefined,
  APP_VERSION_BADGE: 'v0.271.0 RC',
}));

/** The shell's sheet host. The page rings the bus; it never mounts a second sheet. */
const mockOpenShortcutSheet = jest.fn(() => true);
jest.mock('@/app/components/shell/shortcutSheetBus', () => ({
  openShortcutSheet: () => mockOpenShortcutSheet(),
  registerShortcutSheetHost: jest.fn(() => jest.fn()),
  isShortcutSheetMounted: jest.fn(() => true),
  subscribeShortcutSheet: jest.fn(() => jest.fn()),
}));

/** The release-notes dialog fetches on open; its own behaviour is not this ticket's. */
jest.mock('@/app/components/ade/WhatsNewDialog', () => ({
  __esModule: true,
  default: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="whats-new-dialog">What’s new</div> : null,
}));

/** The live shortcut registry, which on a real dashboard route the shell has filled. */
const activeShortcuts = {
  current: [
    { id: 'palette', scope: 'global', description: 'Open the command palette', keys: ['⌘', 'K'] },
    { id: 'preferences', scope: 'global', description: 'Preferences', keys: ['⌘', ','] },
    {
      id: 'jump-projects',
      scope: 'jump',
      description: 'Projects',
      keys: ['G', 'P'],
      disabledReason: 'Select a workspace to use Projects.',
    },
  ] as const,
};
jest.mock('@/app/hooks/useShortcuts', () => ({
  useActiveShortcuts: () => activeShortcuts.current,
  useShortcuts: jest.fn(),
  registerShortcuts: jest.fn(() => jest.fn()),
  getActiveShortcuts: () => activeShortcuts.current,
  subscribeShortcuts: jest.fn(() => jest.fn()),
}));

import HelpPage from '@/app/ade/dashboard/help/page';
import { FIRST_RUN_DISMISS_KEY } from '@/app/components/ade/dashboard/firstRunChecklist';
import { WHATS_NEW_SEEN_STORAGE_KEY } from '@/app/components/shell/whatsNewSeen';

/** A signed-in session with a workspace. */
const TENANT_ID = 'ten_01HJ7F8HQ2ZK';

/** The clipboard the support card writes to. */
const writeText = jest.fn(async () => {});

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  sessionState.current = { user: { user_id: 'usr_1', current_tenant_id: TENANT_ID } };
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

/* -------------------------------------------------------------------------
   1. The route is a page
   ------------------------------------------------------------------------- */

describe('the Help & docs page', () => {
  it('renders the header the rail’s link promises', () => {
    render(<HelpPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Help & docs' })).toBeInTheDocument();
    const crumbs = screen.getByTestId('page-breadcrumb');
    expect(within(crumbs).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      '/ade/dashboard'
    );
    expect(within(crumbs).getByText('Help')).toHaveAttribute('aria-current', 'page');
  });

  it('draws the three regions: search, cards, shortcuts', () => {
    render(<HelpPage />);

    expect(screen.getByTestId('help-guide-search')).toBeInTheDocument();
    expect(screen.getByTestId('help-cards')).toBeInTheDocument();
    expect(screen.getByTestId('help-shortcuts-glance')).toBeInTheDocument();
  });

  it('opens the shell’s one shortcut sheet from the header and from the strip', () => {
    render(<HelpPage />);

    fireEvent.click(screen.getByTestId('help-shortcuts'));
    expect(mockOpenShortcutSheet).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('help-open-sheet'));
    expect(mockOpenShortcutSheet).toHaveBeenCalledTimes(2);
  });

  it('opens the release notes and marks the build read', () => {
    render(<HelpPage />);

    expect(screen.queryByTestId('whats-new-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('help-whats-new'));

    expect(screen.getByTestId('whats-new-dialog')).toBeInTheDocument();
    expect(window.localStorage.getItem(WHATS_NEW_SEEN_STORAGE_KEY)).toBe('v0.271.0 RC');
  });
});

/* -------------------------------------------------------------------------
   2. Guide search
   ------------------------------------------------------------------------- */

describe('guide search', () => {
  it('shows nothing until there is a query to search with', () => {
    render(<HelpPage />);

    expect(screen.queryByTestId('help-guide-results')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('help-guide-search'), { target: { value: 'p' } });
    expect(screen.queryByTestId('help-guide-results')).not.toBeInTheDocument();
  });

  it('returns results and links each one out to its guide', () => {
    render(<HelpPage />);

    fireEvent.change(screen.getByTestId('help-guide-search'), { target: { value: 'publish' } });

    const results = within(screen.getByTestId('help-guide-results')).getAllByRole('link');
    expect(results.length).toBeGreaterThan(0);
    expect(screen.getByTestId('help-guide-publish-a-version')).toHaveAttribute(
      'href',
      'https://github.com/apiome/apiome/blob/main/docs/guide/publish-a-version.md'
    );
    for (const link of results) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    }
  });

  it('announces the count, and says so when nothing matches', () => {
    render(<HelpPage />);
    const field = screen.getByTestId('help-guide-search');

    fireEvent.change(field, { target: { value: 'publish' } });
    expect(screen.getByRole('status')).toHaveTextContent(/guides? match/);

    fireEvent.change(field, { target: { value: 'kubernetes helm' } });
    expect(screen.getByRole('status')).toHaveTextContent('No guides match');
    expect(screen.queryByTestId('help-guide-results')).not.toBeInTheDocument();
  });

  it('names the field for a reader who cannot see the placeholder', () => {
    render(<HelpPage />);
    expect(screen.getByTestId('help-guide-search')).toHaveAccessibleName('Search the guide');
  });
});

/* -------------------------------------------------------------------------
   3. The support card
   ------------------------------------------------------------------------- */

describe('the support card', () => {
  it('shows the current tenant id and the build', () => {
    render(<HelpPage />);

    expect(screen.getByTestId('help-support-tenant')).toHaveTextContent(TENANT_ID);
    expect(screen.getByTestId('help-support-build')).toHaveTextContent('v0.271.0 RC');
  });

  it('says so when the session has no workspace, rather than printing an empty line', () => {
    sessionState.current = { user: { user_id: 'usr_1' } };
    render(<HelpPage />);

    expect(screen.getByTestId('help-support-tenant')).toHaveTextContent('No workspace selected');
    expect(screen.getByTestId('help-support-build')).toHaveTextContent('v0.271.0 RC');
  });

  it('copies both identifiers as one block, and confirms in words', async () => {
    render(<HelpPage />);
    const copy = screen.getByTestId('help-support-copy');

    expect(copy).toHaveAccessibleName('Copy support details');
    fireEvent.click(copy);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`Tenant id: ${TENANT_ID}\nBuild: v0.271.0 RC`);
    });
    await waitFor(() => {
      expect(screen.getByTestId('help-support-copy')).toHaveAccessibleName(
        'Copied support details'
      );
    });
  });

  it('survives a clipboard the browser refuses', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    render(<HelpPage />);

    fireEvent.click(screen.getByTestId('help-support-copy'));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // The values are still on screen, which is the fallback: nothing is thrown and nothing
    // claims to have been copied.
    expect(screen.getByTestId('help-support-copy')).toHaveAccessibleName('Copy support details');
    expect(screen.getByTestId('help-support-tenant')).toHaveTextContent(TENANT_ID);
  });

  it('sends a reader to the tracker in a new tab', () => {
    render(<HelpPage />);
    const issue = screen.getByTestId('help-support-issue');
    expect(issue).toHaveAttribute('href', 'https://github.com/apiome/apiome/issues/new');
    expect(issue).toHaveAttribute('target', '_blank');
  });
});

/* -------------------------------------------------------------------------
   4. The cards behave like what they are
   ------------------------------------------------------------------------- */

describe('the help cards', () => {
  it('reopens the Home checklist and returns to Home', () => {
    window.localStorage.setItem(FIRST_RUN_DISMISS_KEY, '1');
    render(<HelpPage />);

    fireEvent.click(screen.getByTestId('help-card-get-started'));

    expect(window.localStorage.getItem(FIRST_RUN_DISMISS_KEY)).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('/ade/dashboard');
  });

  it('leaves the app for the guides and the screencasts', () => {
    render(<HelpPage />);

    for (const [id, href] of [
      ['user-guide', 'https://github.com/apiome/apiome/blob/main/docs/guide/README.md'],
      ['api-cli', 'https://github.com/apiome/apiome/blob/main/docs/guide/api-reference.md'],
      ['video', 'https://www.youtube.com/@apiomedev'],
    ] as const) {
      const card = screen.getByTestId(`help-card-${id}`);
      expect(card.tagName).toBe('A');
      expect(card).toHaveAttribute('href', href);
      expect(card).toHaveAttribute('target', '_blank');
      expect(card).toHaveAttribute('rel', expect.stringContaining('noopener'));
    }
  });

  it('draws the unshipped card as a disabled button that says why', () => {
    render(<HelpPage />);

    const community = screen.getByTestId('help-card-community');
    expect(community.tagName).toBe('BUTTON');
    expect(community).toBeDisabled();
    expect(community).toHaveAccessibleName('Community (coming soon)');
    expect(within(community).getByText('Soon')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   5. The shortcut strip
   ------------------------------------------------------------------------- */

describe('shortcuts at a glance', () => {
  it('prints what is bound right now, and spells each chord for a screen reader', () => {
    render(<HelpPage />);
    const strip = screen.getByTestId('help-shortcuts-glance');

    expect(within(strip).getByText('Open the command palette')).toBeInTheDocument();
    expect(within(strip).getByText('Preferences')).toBeInTheDocument();
    // The chips are `aria-hidden`, so the chord is also written out beside them.
    expect(strip.querySelectorAll('.sr-only').length).toBeGreaterThan(0);
  });

  it('leaves out a shortcut this session cannot use', () => {
    render(<HelpPage />);
    const strip = screen.getByTestId('help-shortcuts-glance');
    expect(within(strip).queryByText('Projects')).not.toBeInTheDocument();
  });

  it('is absent altogether when nothing is bound', () => {
    const saved = activeShortcuts.current;
    activeShortcuts.current = [] as unknown as typeof saved;
    try {
      render(<HelpPage />);
      expect(screen.queryByTestId('help-shortcuts-glance')).not.toBeInTheDocument();
    } finally {
      activeShortcuts.current = saved;
    }
  });
});

/* -------------------------------------------------------------------------
   6. Accessibility
   ------------------------------------------------------------------------- */

describe('accessibility', () => {
  it('has no axe violations at rest', async () => {
    const { container } = render(<HelpPage />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with results on screen', async () => {
    const { container } = render(<HelpPage />);
    fireEvent.change(screen.getByTestId('help-guide-search'), { target: { value: 'publish' } });
    expect(await axe(container)).toHaveNoViolations();
  });
});
