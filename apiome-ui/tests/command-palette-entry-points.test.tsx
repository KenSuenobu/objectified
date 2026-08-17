/**
 * The three ways into the command palette, and the way out of it (HIVE-3.6, #5292).
 *
 * `tests/command-palette.test.tsx` drives the palette itself, over a host of its own. This
 * suite is about the seams around it, each of which is a component that has to work whether
 * or not a palette happens to be mounted:
 *
 *   1. **`RailSearchTrigger`** — `AppShell` region 3. Renders nothing at all where there is
 *      no palette, which is how the admin console's rail gets no search.
 *   2. **The shortcut sheet's palette row** — the third entry point named in the roadmap.
 *      HIVE-3.7 (#5293) moved it from the preferences pane's Shortcuts tab into the
 *      generated sheet, where the row is a button whenever the binding can run. It closes
 *      the sheet before opening the palette, so the reader is never left with two overlays.
 *   3. **`useOpenAction`** — the deep link the Actions group navigates on. The dialog opens
 *      once and the parameter is stripped, so a reload never reopens it.
 */

import React from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

const mockReplace = jest.fn<void, [string, unknown?]>();
const mockSearchParams = jest.fn<URLSearchParams, []>();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, refresh: jest.fn() }),
  usePathname: () => '/ade/dashboard/projects',
  useSearchParams: () => mockSearchParams(),
}));

import { TooltipProvider } from '../src/app/components/ui/Tooltip';
import RailSearchTrigger from '../src/app/components/shell/RailSearchTrigger';
import ShortcutSheet from '../src/app/components/shell/ShortcutSheet';
import { PALETTE_SHORTCUT } from '../lib/shortcuts';
import { registerShortcuts } from '../src/app/hooks/useShortcuts';
import {
  openCommandPalette,
  registerCommandPaletteHost,
} from '../src/app/components/shell/commandPaletteBus';
import {
  closePreferences,
  openPreferences,
  registerPreferencesDrawerHost,
} from '../src/app/components/ade/preferences/preferencesDrawerBus';
import {
  OPEN_ACTIONS,
  OPEN_ACTION_PARAM,
  useOpenAction,
} from '../src/app/components/shell/openActions';

beforeEach(() => {
  mockReplace.mockReset();
  mockSearchParams.mockReset();
  mockSearchParams.mockReturnValue(new URLSearchParams());
});

describe('the rail’s search trigger', () => {
  it('renders nothing where no palette is mounted', () => {
    const { container } = render(<RailSearchTrigger iconRail={false} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('appears as soon as a palette registers, and goes when it unregisters', () => {
    render(<RailSearchTrigger iconRail={false} />);
    expect(screen.queryByTestId('rail-search')).not.toBeInTheDocument();

    let unregister = () => {};
    act(() => {
      unregister = registerCommandPaletteHost(() => {});
    });
    expect(screen.getByTestId('rail-search')).toBeInTheDocument();

    act(() => unregister());
    expect(screen.queryByTestId('rail-search')).not.toBeInTheDocument();
  });

  it('opens the palette when it is pressed', async () => {
    const open = jest.fn();
    const user = userEvent.setup();
    render(<RailSearchTrigger iconRail={false} />);

    let unregister = () => {};
    act(() => {
      unregister = registerCommandPaletteHost(open);
    });

    await user.click(screen.getByTestId('rail-search'));
    expect(open).toHaveBeenCalledTimes(1);

    act(() => unregister());
  });

  it('still names itself once the rail has taken its label away', () => {
    let unregister = () => {};
    act(() => {
      unregister = registerCommandPaletteHost(() => {});
    });

    try {
      // The tooltip only wraps the row in the icon rail, so the provider is only needed
      // here — `AppShell` supplies it in the app.
      render(
        <TooltipProvider>
          <RailSearchTrigger iconRail />
        </TooltipProvider>
      );

      // The visible label is `aria-hidden`, so the accessible name comes from the `sr-only`
      // copy beside it — which is what the icon rail leaves the reader with.
      expect(screen.getByRole('button', { name: 'Search or jump to…' })).toBeInTheDocument();
    } finally {
      act(() => unregister());
    }
  });
});

describe('the shortcut sheet’s palette row', () => {
  it('lists nothing at all where no palette is mounted, rather than a chord that does nothing', () => {
    render(<ShortcutSheet open onOpenChange={() => {}} />);

    expect(screen.queryByTestId('shortcut-run-palette')).not.toBeInTheDocument();
    expect(screen.getByTestId('shortcut-sheet')).not.toHaveTextContent(
      'Open the command palette'
    );
  });

  it('closes the sheet and opens the palette, rather than stacking one on the other', async () => {
    const openPalette = jest.fn();
    const onOpenChange = jest.fn();
    const user = userEvent.setup();

    // What `CommandPaletteHost` registers, without the host's own dialog in the way.
    let unregister = () => {};
    act(() => {
      unregister = registerShortcuts([{ ...PALETTE_SHORTCUT, run: () => openPalette() }]);
    });

    render(<ShortcutSheet open onOpenChange={onOpenChange} />);
    await user.click(screen.getByTestId('shortcut-run-palette'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(openPalette).toHaveBeenCalledTimes(1);

    act(() => unregister());
  });
});

describe('the preferences bus’ close seam', () => {
  it('accepts a bare open callback, as every caller before HIVE-3.6 passed', () => {
    const open = jest.fn();
    const unregister = registerPreferencesDrawerHost(open);

    expect(openPreferences('shortcuts')).toBe(true);
    expect(open).toHaveBeenCalledWith('shortcuts');
    // Such a host simply has nothing to close, and says so without throwing.
    expect(closePreferences()).toBe(true);

    unregister();
    expect(closePreferences()).toBe(false);
  });
});

describe('the palette bus', () => {
  it('reports no host rather than throwing when nothing is mounted', () => {
    expect(openCommandPalette()).toBe(false);
  });

  it('answers only the most recently mounted host, so two never open together', () => {
    const first = jest.fn();
    const second = jest.fn();
    const unregisterFirst = registerCommandPaletteHost(first);
    const unregisterSecond = registerCommandPaletteHost(second);

    openCommandPalette({ query: '>' });

    expect(second).toHaveBeenCalledWith({ query: '>' });
    expect(first).not.toHaveBeenCalled();

    unregisterSecond();
    unregisterFirst();
  });
});

describe('useOpenAction — the Actions group’s deep link', () => {
  /**
   * Drive the hook with a query string.
   *
   * @param query What the URL carries.
   * @param action Which action the caller answers.
   * @returns The spy the hook is expected to call, and the hook result.
   */
  function renderAction(query: string, action = OPEN_ACTIONS.newProject) {
    mockSearchParams.mockReturnValue(new URLSearchParams(query));
    const open = jest.fn();
    const view = renderHook(() => useOpenAction(action, open));
    return { open, view };
  }

  it('opens the page’s own dialog when the palette asks for it', () => {
    const { open } = renderAction(`${OPEN_ACTION_PARAM}=${OPEN_ACTIONS.newProject}`);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('answers only its own action, so a page with two dialogs opens one', () => {
    const { open } = renderAction(
      `${OPEN_ACTION_PARAM}=${OPEN_ACTIONS.importSpec}`,
      OPEN_ACTIONS.newProject
    );

    expect(open).not.toHaveBeenCalled();
  });

  it('does nothing at all on an ordinary visit', () => {
    const { open } = renderAction('');

    expect(open).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('strips the request, so a reload or the back button cannot reopen the dialog', () => {
    renderAction(`${OPEN_ACTION_PARAM}=${OPEN_ACTIONS.newProject}`);

    expect(mockReplace).toHaveBeenCalledWith('/ade/dashboard/projects', { scroll: false });
  });

  it('keeps the rest of the query, which the page may be filtering by', () => {
    renderAction(`q=payments&${OPEN_ACTION_PARAM}=${OPEN_ACTIONS.newProject}&page=2`);

    expect(mockReplace).toHaveBeenCalledWith('/ade/dashboard/projects?q=payments&page=2', {
      scroll: false,
    });
  });

  it('opens once, however often the page re-renders with a new callback', () => {
    mockSearchParams.mockReturnValue(
      new URLSearchParams(`${OPEN_ACTION_PARAM}=${OPEN_ACTIONS.newProject}`)
    );
    const open = jest.fn();
    // A page passing an inline arrow — which every page does — hands a new function each
    // render. Were the effect to depend on it, the dialog would reopen on every keystroke.
    const { rerender } = renderHook(() => useOpenAction(OPEN_ACTIONS.newProject, () => open()));

    rerender();
    rerender();

    expect(open).toHaveBeenCalledTimes(1);
  });
});
