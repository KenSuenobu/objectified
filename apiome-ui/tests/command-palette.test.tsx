/**
 * The command palette, driven the way a reader drives it (HIVE-3.6, #5292).
 *
 * The ticket's acceptance criteria are behavioural — `⌘K` opens it from anywhere, `Esc`
 * closes it and gives focus back, the arrows move a row, `↵` navigates, a gated action says
 * why — so this suite mounts the host over a mocked session and then types.
 *
 * What is deliberately *not* asserted here: how the active row *looks*. `[data-selected]`
 * is styled in `globals.css`, which jsdom compiles not at all, so the visible half of
 * "arrow keys move a visible active row" lives in `tests/command-palette-css.test.ts` and
 * `e2e/hive-command-palette.spec.ts`. What jsdom can answer — that the attribute moves, and
 * that `aria-activedescendant` follows it — is answered here.
 */

import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

const mockPush = jest.fn<void, [string]>();
const mockOpenPreferences = jest.fn<boolean, [string?]>();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/ade/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/app/components/ade/preferences/preferencesDrawerBus', () => ({
  openPreferences: (tab?: string) => mockOpenPreferences(tab),
  closePreferences: jest.fn(),
}));

import CommandPaletteHost from '../src/app/components/shell/CommandPaletteHost';
import {
  isCommandPaletteMounted,
  openCommandPalette,
} from '../src/app/components/shell/commandPaletteBus';
import {
  PALETTE_RECENTS_STORAGE_KEY,
  recordCommandPaletteRecent,
} from '../src/app/components/shell/commandPaletteRecents';
import {
  PLATFORM_NAV_GROUPS,
  findPlatformNavItem,
  platformNavGatedReason,
} from '../lib/platform-nav';

/** A workspace-scoped destination, taken from the model rather than named. */
const GATED_ITEM = PLATFORM_NAV_GROUPS.flatMap((group) => group.items).find(
  (item) => item.requiresTenant
)!;

/** The workspace the palette is mounted for. */
const TENANT_ID = 't-1';

/**
 * Mount the palette host with a button beside it, so focus restoration has somewhere to go.
 *
 * @param tenant Whether the session carries a workspace.
 * @returns The render result.
 */
function renderHost({ tenant = true }: { tenant?: boolean } = {}) {
  return render(
    <>
      <button type="button" data-testid="outside">
        Somewhere else
      </button>
      <CommandPaletteHost currentTenantId={tenant ? TENANT_ID : null} />
    </>
  );
}

/** Open the palette with `⌘K` and wait for it to be there. */
async function openWithChord(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Meta>}k{/Meta}');
  return screen.findByRole('dialog');
}

beforeEach(() => {
  mockPush.mockReset();
  mockOpenPreferences.mockReset();
  mockOpenPreferences.mockReturnValue(true);
  window.localStorage.clear();
});

describe('opening and closing', () => {
  it('opens on ⌘K from wherever focus is', async () => {
    const user = userEvent.setup();
    renderHost();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('outside'));
    const dialog = await openWithChord(user);

    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox')).toHaveFocus();
  });

  it('opens on Ctrl+K, for the readers who are not on a Mac', async () => {
    const user = userEvent.setup();
    renderHost();

    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('ignores a bare k, so typing one never opens the palette', async () => {
    const user = userEvent.setup();
    renderHost();

    await user.keyboard('k');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Esc and gives focus back to whatever opened it', async () => {
    const user = userEvent.setup();
    renderHost();

    const outside = screen.getByTestId('outside');
    await user.click(outside);
    await openWithChord(user);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(outside).toHaveFocus());
  });

  it('answers openCommandPalette() while it is mounted, and stops when it is not', async () => {
    const view = renderHost();
    expect(isCommandPaletteMounted()).toBe(true);

    await act(async () => {
      openCommandPalette();
    });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    view.unmount();
    expect(isCommandPaletteMounted()).toBe(false);
    expect(openCommandPalette()).toBe(false);
  });

  it('opens on the request it was given, so a caller can ask for commands', async () => {
    renderHost();

    await act(async () => {
      openCommandPalette({ query: '>' });
    });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox')).toHaveValue('>');
    expect(within(dialog).queryByTestId('palette-group-jump')).not.toBeInTheDocument();
  });

  it('starts empty every time, rather than resuming the last search', async () => {
    const user = userEvent.setup();
    renderHost();

    await openWithChord(user);
    await user.keyboard('cata');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const dialog = await openWithChord(user);
    expect(within(dialog).getByRole('combobox')).toHaveValue('');
  });
});

describe('what it offers', () => {
  it('draws the destinations the navigation model describes, under their sections', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    const jump = within(dialog).getByTestId('palette-group-jump');
    for (const item of PLATFORM_NAV_GROUPS.flatMap((group) => group.items)) {
      // By id, not by text: "Home" is both a destination and a section name, and a
      // by-text lookup would be ambiguous for exactly the row that proves the point.
      expect(within(jump).getByTestId(`palette-item-jump-${item.id}`)).toHaveTextContent(
        item.label
      );
    }
    // The section is on the row, which is what makes it searchable.
    const catalog = within(dialog).getByTestId('palette-item-jump-catalog');
    expect(catalog).toHaveTextContent('Bring in');
  });

  it('lists the actions, and offers no Recent group on a first visit', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    expect(within(dialog).getByText('New project…')).toBeInTheDocument();
    expect(within(dialog).getByText('Change theme…')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('palette-group-recent')).not.toBeInTheDocument();
  });

  it('shows this workspace’s history first, once there is one', async () => {
    recordCommandPaletteRecent('t-1', {
      id: 'proj-1',
      label: 'Payments API',
      href: '/ade/dashboard/projects/1',
      meta: 'v2.4.0 · draft',
    });

    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    const recent = await within(dialog).findByTestId('palette-group-recent');
    expect(within(recent).getByText('Payments API')).toBeInTheDocument();
    expect(
      recent.compareDocumentPosition(within(dialog).getByTestId('palette-group-jump'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows nothing from another workspace’s history', async () => {
    recordCommandPaletteRecent('t-other', {
      id: 'proj-1',
      label: 'Someone else’s API',
      href: '/ade/dashboard/projects/1',
    });

    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    expect(within(dialog).queryByText('Someone else’s API')).not.toBeInTheDocument();
  });
});

describe('typing', () => {
  it('matches on the title', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    await user.keyboard('catalog');

    expect(within(dialog).getByTestId('palette-item-jump-catalog')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('palette-item-jump-members')).not.toBeInTheDocument();
  });

  it('matches on the section, so a reader can search by where a thing lives', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    await user.keyboard('govern');

    // Every destination in the Govern group, and nothing from Build.
    const govern = PLATFORM_NAV_GROUPS.find((group) => group.label === 'Govern')!;
    for (const item of govern.items) {
      expect(within(dialog).getByTestId(`palette-item-jump-${item.id}`)).toBeInTheDocument();
    }
    expect(within(dialog).queryByTestId('palette-item-jump-projects')).not.toBeInTheDocument();
  });

  it('narrows to commands, not to nothing, when the reader types >', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    await user.keyboard('>');

    expect(within(dialog).getByTestId('palette-group-action')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('palette-group-jump')).not.toBeInTheDocument();
    // The prefix is a mode, not a search term: every command is still on screen.
    expect(within(dialog).getByText('New project…')).toBeInTheDocument();
    expect(within(dialog).getByText('Change theme…')).toBeInTheDocument();
  });

  it('filters within commands once there is something after the >', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    await user.keyboard('> theme');

    expect(within(dialog).getByText('Change theme…')).toBeInTheDocument();
    expect(within(dialog).queryByText('New project…')).not.toBeInTheDocument();
  });

  it('says so when nothing matches, rather than showing an empty list', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    await user.keyboard('zzzzqqqq');

    expect(within(dialog).getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it('switches to the Actions group on tab, as the footer legend promises', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    await user.keyboard('{Tab}');
    expect(within(dialog).getByRole('combobox')).toHaveValue('>');
    expect(within(dialog).queryByTestId('palette-group-jump')).not.toBeInTheDocument();

    // And back again, with the same key.
    await user.keyboard('{Tab}');
    expect(within(dialog).getByRole('combobox')).toHaveValue('');
    expect(within(dialog).getByTestId('palette-group-jump')).toBeInTheDocument();
  });
});

describe('the keyboard', () => {
  it('moves a marked active row with the arrows, and tells the field which one it is', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    const input = within(dialog).getByRole('combobox');
    const options = within(dialog).getAllByRole('option');
    // The first row is active before anything is pressed, so `↵` always has a target.
    expect(options[0]).toHaveAttribute('data-selected', 'true');

    await user.keyboard('{ArrowDown}');

    expect(options[0]).toHaveAttribute('data-selected', 'false');
    expect(options[1]).toHaveAttribute('data-selected', 'true');
    // The field owns the focus, so it is the field that has to name the active row.
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);

    await user.keyboard('{ArrowUp}');
    expect(options[0]).toHaveAttribute('data-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
  });

  it('navigates to the active row on ↵, and closes on the way', async () => {
    const user = userEvent.setup();
    renderHost();
    await openWithChord(user);

    await user.keyboard('catalog');
    await user.keyboard('{Enter}');

    expect(mockPush).toHaveBeenCalledWith(findPlatformNavItem('catalog')!.href);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('runs an in-place command rather than navigating', async () => {
    const user = userEvent.setup();
    renderHost();
    await openWithChord(user);

    await user.keyboard('change theme');
    await user.keyboard('{Enter}');

    expect(mockOpenPreferences).toHaveBeenCalledWith('appearance');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('remembers a destination it opened, and does not remember an action', async () => {
    const user = userEvent.setup();
    renderHost();
    await openWithChord(user);

    await user.keyboard('catalog');
    await user.keyboard('{Enter}');

    const stored = JSON.parse(window.localStorage.getItem(PALETTE_RECENTS_STORAGE_KEY)!);
    expect(stored['t-1'].map((row: { label: string }) => row.label)).toEqual(['Catalog']);

    // Reopening and running an action leaves the history where it was.
    await openWithChord(user);
    await user.keyboard('change theme');
    await user.keyboard('{Enter}');

    const after = JSON.parse(window.localStorage.getItem(PALETTE_RECENTS_STORAGE_KEY)!);
    expect(after['t-1']).toHaveLength(1);
  });
});

describe('gating', () => {
  it('keeps a workspace-scoped destination on screen and says why it cannot be used', async () => {
    const user = userEvent.setup();
    renderHost({ tenant: false });
    const dialog = await openWithChord(user);

    const row = within(dialog).getByTestId(`palette-item-jump-${GATED_ITEM.id}`);
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveTextContent(platformNavGatedReason(GATED_ITEM.label));
  });

  it('gates the workspace-scoped actions, and leaves the reader’s own settings alone', async () => {
    const user = userEvent.setup();
    renderHost({ tenant: false });
    const dialog = await openWithChord(user);

    expect(within(dialog).getByTestId('palette-item-action-new-project')).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(within(dialog).getByTestId('palette-item-action-change-theme')).toHaveAttribute(
      'aria-disabled',
      'false'
    );
  });

  it('does nothing at all when a gated row is chosen', async () => {
    const user = userEvent.setup();
    renderHost({ tenant: false });
    const dialog = await openWithChord(user);

    await user.click(within(dialog).getByTestId('palette-item-action-new-project'));

    expect(mockPush).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it('skips gated rows when the arrows move, so they are never a dead end', async () => {
    const user = userEvent.setup();
    renderHost({ tenant: false });
    const dialog = await openWithChord(user);

    for (const option of within(dialog).getAllByRole('option')) {
      if (option.getAttribute('aria-disabled') === 'true') {
        expect(option).toHaveAttribute('data-selected', 'false');
      }
    }
  });
});

describe('accessibility', () => {
  it('announces itself as a named, described dialog over an ARIA listbox', async () => {
    const user = userEvent.setup();
    renderHost();
    const dialog = await openWithChord(user);

    expect(dialog).toHaveAccessibleName('Command palette');
    expect(dialog).toHaveAccessibleDescription(/greater-than sign/);

    const list = within(dialog).getByRole('listbox');
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(0);
    expect(within(dialog).getByRole('combobox')).toHaveAttribute('aria-controls', list.id);
  });

  it('has no axe violations, open', async () => {
    const user = userEvent.setup();
    const { baseElement } = renderHost();
    await openWithChord(user);

    // The dialog portals to the body, so the whole document is the subject.
    const results = await axe(baseElement);
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations with every workspace-scoped row gated', async () => {
    const user = userEvent.setup();
    const { baseElement } = renderHost({ tenant: false });
    await openWithChord(user);

    const results = await axe(baseElement);
    expect(results).toHaveNoViolations();
  });
});
