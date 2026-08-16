/**
 * The rail footer's user menu (HIVE-3.4, #5290).
 *
 * The ticket is a *rescue*: the top bar is being retired, and everything its right-hand
 * cluster carried has to come out the other side — the profile menu, the theme entry, the
 * version badge and What's New — together with four destinations that were never in a menu
 * at all (linked accounts, the shortcut list, the admin console and the launcher). So the
 * first thing this suite asserts is inventory: every row exists, and each one still does
 * what its old home did.
 *
 * On top of that, the three behaviours the acceptance criteria name: the honey dot that
 * marks unread release notes and clears once they are read, a menu that is walkable with
 * the arrow keys and closes on `Esc`, and a rail that has had its labels taken away by CSS
 * and still works.
 */

import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

const mockSignOut = jest.fn<Promise<void>, [string]>(async () => undefined);
const mockOpenPreferences = jest.fn<boolean, [string | undefined]>(() => true);

// A real anchor, so the rows keep their link semantics for axe and for the `href`
// assertions — but with the navigation suppressed, which jsdom answers with a
// "Not implemented" console error rather than by navigating.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

jest.mock('@lib/auth/sign-out-client', () => ({
  signOutEverywhere: (callbackUrl: string) => mockSignOut(callbackUrl),
}));

// The pane has its own suite (`preferences-drawer.test.tsx`), including the tab it lands
// on. Here the question is only which request each row makes.
jest.mock('@/app/components/ade/preferences/preferencesDrawerBus', () => ({
  openPreferences: (tab?: string) => mockOpenPreferences(tab),
}));

jest.mock('rehype-raw', () => ({
  __esModule: true,
  default: () => () => {},
}));

import UserMenu from '../src/app/components/shell/UserMenu';
import { WHATS_NEW_SEEN_STORAGE_KEY } from '../src/app/components/shell/whatsNewSeen';
import {
  ADMIN_CONSOLE_ROUTE,
  LAUNCHER_ROUTE,
} from '../src/app/components/shell/appShellRoutes';
import { TooltipProvider } from '../src/app/components/ui/Tooltip';
import { PLATFORM_USER_MENU_ITEMS } from '../lib/platform-nav';
import { APP_VERSION_BADGE } from '../lib/app-version';

/** The signed-in reader every test renders as. */
const USER = { userName: 'Ada Lovelace', userEmail: 'ada@example.com', userId: 'u-ada' };

/**
 * Mount the menu.
 *
 * @param props Overrides — `iconRail` for the collapsed rail, identity fields for a
 *   session that carries less than a full name.
 * @returns The Testing Library result.
 */
function renderMenu(props: Partial<React.ComponentProps<typeof UserMenu>> = {}) {
  return render(
    <TooltipProvider>
      <UserMenu iconRail={false} {...USER} {...props} />
    </TooltipProvider>
  );
}

/** Open the menu from its trigger and hand back the popup. */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('rail-user'));
  return screen.getByTestId('user-menu');
}

/** Every row of the menu, in the order the arrow keys walk them. */
const menuRows = () => within(screen.getByTestId('user-menu')).getAllByRole('menuitem');

beforeEach(() => {
  localStorage.clear();
  mockSignOut.mockClear();
  mockOpenPreferences.mockClear();
  global.fetch = jest.fn().mockResolvedValue({ text: async () => 'Notes.' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the footer row', () => {
  it('names the reader and says what the button does', () => {
    renderMenu();

    const trigger = screen.getByTestId('rail-user');
    expect(trigger).toHaveTextContent('Ada Lovelace');
    expect(trigger).toHaveTextContent('ada@example.com');
    expect(trigger).toHaveAccessibleName(/account menu/i);
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('still names something when the session carries no name at all', () => {
    renderMenu({ userName: null, userEmail: null, userId: null });

    expect(screen.getByTestId('rail-user')).toHaveTextContent('Your account');
  });

  it('points aria-controls at the popup only while it is there', async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByTestId('rail-user');

    expect(trigger).not.toHaveAttribute('aria-controls');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-controls', screen.getByTestId('user-menu').id);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('what the menu offers', () => {
  it('gives every destination the header menu had a home, and four it never did', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    // The three the top bar's profile menu carried…
    expect(screen.getByTestId('user-menu-profile')).toHaveAttribute(
      'href',
      '/ade/dashboard/profile'
    );
    expect(screen.getByTestId('user-menu-preferences')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-sign-out')).toBeInTheDocument();
    // …the badge beside it…
    expect(screen.getByTestId('user-menu-whats-new')).toBeInTheDocument();
    // …and the four that were URL-only.
    expect(screen.getByTestId('user-menu-linked-accounts')).toHaveAttribute(
      'href',
      '/ade/dashboard/linked-accounts'
    );
    expect(screen.getByTestId('user-menu-shortcuts')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-admin-console')).toHaveAttribute(
      'href',
      ADMIN_CONSOLE_ROUTE
    );
    expect(screen.getByTestId('user-menu-all-apps')).toHaveAttribute('href', LAUNCHER_ROUTE);
  });

  it('reads the account destinations out of the navigation model', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    // Not a restatement of the labels: if HIVE-3.2's model gains or renames an account
    // destination, this menu is where it must appear.
    PLATFORM_USER_MENU_ITEMS.forEach((item) => {
      const row = screen.getByTestId(`user-menu-${item.id}`);
      expect(row).toHaveAttribute('href', item.href);
      expect(row).toHaveTextContent(item.label);
    });
  });

  it('marks the admin console as leaving the app, in words as well as a glyph', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    expect(screen.getByTestId('user-menu-admin-console')).toHaveAccessibleName(
      /admin console.*opens outside this app/i
    );
  });

  it('closes when a destination is chosen', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.click(screen.getByTestId('user-menu-all-apps'));

    await waitFor(() => expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument());
  });

  it('asks for the preferences pane, and for its Shortcuts tab by name', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.click(screen.getByTestId('user-menu-preferences'));
    expect(mockOpenPreferences).toHaveBeenLastCalledWith(undefined);

    await openMenu(user);
    await user.click(screen.getByTestId('user-menu-shortcuts'));
    expect(mockOpenPreferences).toHaveBeenLastCalledWith('shortcuts');
  });

  it('signs out of every device and lands on the login page', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.click(screen.getByTestId('user-menu-sign-out'));

    expect(mockSignOut).toHaveBeenCalledWith('/login');
  });

  it('does not break the page when signing out fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSignOut.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.click(screen.getByTestId('user-menu-sign-out'));

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.getByTestId('rail-user')).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('prints the running build beneath the rows', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    expect(screen.getByTestId('rail-build-badge')).toHaveTextContent(APP_VERSION_BADGE);
  });
});

describe("what's new", () => {
  it('marks the notes unread until they have been opened, then remembers', async () => {
    const user = userEvent.setup();
    renderMenu();

    // The dot rides the collapsed-rail-proof trigger as well as the row.
    expect(await screen.findByTestId('rail-user-unread')).toBeInTheDocument();
    expect(screen.getByTestId('rail-user')).toHaveAccessibleName(/unread release note/i);

    await openMenu(user);
    expect(screen.getByTestId('whats-new-unread-dot')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-whats-new')).toHaveAccessibleName(/unread/i);

    await user.click(screen.getByTestId('user-menu-whats-new'));

    expect(await screen.findByTestId('whats-new-dialog')).toBeInTheDocument();
    expect(localStorage.getItem(WHATS_NEW_SEEN_STORAGE_KEY)).toBe(APP_VERSION_BADGE);
    expect(screen.queryByTestId('rail-user-unread')).not.toBeInTheDocument();
  });

  it('stays quiet for a reader who has already read this build', async () => {
    localStorage.setItem(WHATS_NEW_SEEN_STORAGE_KEY, APP_VERSION_BADGE);
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    expect(screen.queryByTestId('rail-user-unread')).not.toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-unread-dot')).not.toBeInTheDocument();
  });

  it('speaks up again once the build moves on', async () => {
    localStorage.setItem(WHATS_NEW_SEEN_STORAGE_KEY, 'v0.1.0 RC');
    renderMenu();

    expect(await screen.findByTestId('rail-user-unread')).toBeInTheDocument();
  });

  it('opens the notes from the build badge too, the way the version badge always did', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.click(screen.getByTestId('rail-build-badge'));

    expect(await screen.findByTestId('whats-new-dialog')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/WHATS_NEW.md');
    expect(localStorage.getItem(WHATS_NEW_SEEN_STORAGE_KEY)).toBe(APP_VERSION_BADGE);
  });

  it('survives a browser that refuses local storage', async () => {
    const getItem = jest
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    const setItem = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    const user = userEvent.setup();
    renderMenu();

    // Unreadable storage reads as "nothing seen", which is the safe direction.
    expect(await screen.findByTestId('rail-user-unread')).toBeInTheDocument();
    await openMenu(user);
    await user.click(screen.getByTestId('user-menu-whats-new'));

    expect(await screen.findByTestId('whats-new-dialog')).toBeInTheDocument();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('the keyboard', () => {
  it('moves the caret into the menu when it opens', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    expect(menuRows()[0]).toHaveFocus();
  });

  it('opens onto the last row from ↑, and the first from ↓', async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByTestId('rail-user');

    trigger.focus();
    await user.keyboard('{ArrowUp}');
    const rows = menuRows();
    expect(rows[rows.length - 1]).toHaveFocus();

    await user.keyboard('{Escape}');
    await user.keyboard('{ArrowDown}');
    expect(menuRows()[0]).toHaveFocus();
  });

  it('walks the rows with the arrow keys, wrapping at both ends', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);
    const rows = menuRows();

    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();

    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(rows[rows.length - 1]).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(rows[0]).toHaveFocus();
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);
    const rows = menuRows();

    await user.keyboard('{End}');
    expect(rows[rows.length - 1]).toHaveFocus();

    await user.keyboard('{Home}');
    expect(rows[0]).toHaveFocus();
  });

  it('keeps exactly one row in the tab order', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    const tabbable = menuRows().filter((row) => row.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
  });

  it('closes on Esc and puts the caret back on the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument());
    expect(screen.getByTestId('rail-user')).toHaveFocus();
  });

  it('closes when a pointer lands outside it, without stealing focus back', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);

    await user.click(document.body);

    await waitFor(() => expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument());
    expect(screen.getByTestId('rail-user')).not.toHaveFocus();
  });
});

describe('the collapsed rail', () => {
  it('names the row in a tooltip once CSS has taken its label away', async () => {
    renderMenu({ iconRail: true });

    act(() => {
      screen.getByTestId('rail-user').focus();
    });

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Ada Lovelace — account menu');
  });

  it('opens the same menu, with the same rows', async () => {
    const user = userEvent.setup();
    renderMenu({ iconRail: true });

    await user.click(screen.getByTestId('rail-user'));

    // The labels the rail hides are CSS on `.rail-label`; the menu never carried that
    // class, so a collapsed rail changes nothing about what is inside the popup.
    expect(menuRows()).toHaveLength(8);
    expect(screen.getByTestId('user-menu-profile')).toBeVisible();
  });
});

describe('accessibility', () => {
  it('has no axe violations with the menu open', async () => {
    const user = userEvent.setup();
    const { container } = renderMenu();
    await openMenu(user);

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the collapsed rail', async () => {
    const user = userEvent.setup();
    const { container } = renderMenu({ iconRail: true });
    await user.click(screen.getByTestId('rail-user'));

    expect(await axe(container)).toHaveNoViolations();
  });
});
