/**
 * The preferences pane — `src/app/components/ade/PreferencesDrawer.tsx` (HIVE-1.4, #5277).
 *
 * The pane replaces a modal that only set a theme, so the contract this suite pins is
 * mostly about *reach* and *effect*: every way in opens it, every control applies the
 * moment it is used rather than on a Save that does not exist, and what it applies is a
 * `<html>` attribute plus a `localStorage` key — the same pair `PreferencesProvider` and
 * the pre-paint boot script read back, which is what makes a setting survive a reload and
 * a route change.
 *
 * The providers are real, not stubbed. A test that asserted "`setTheme` was called" would
 * pass against a pane wired to a provider that never wrote anything; asserting on the
 * element and on storage is the same thing the browser does.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

// next-themes still owns the `.dark` class for the utilities that have not adopted tokens.
// Stubbing only its hook keeps the real `ThemeProvider` — and therefore the real writes to
// `<html>` and to storage — in the test.
const setNextTheme = jest.fn();
jest.mock('next-themes', () => ({
  useTheme: () => ({ setTheme: setNextTheme }),
}));

import {
  DEFAULT_PREFERENCES,
  FONT_SCALES,
  PREFERENCE_ATTRIBUTES,
  PREFERENCE_STORAGE_KEYS,
  SWITCH_PREFERENCES,
} from '../src/app/config/preferences';
import { themes } from '../src/app/config/themes';
import PreferencesDrawerHost from '../src/app/components/ade/preferences/PreferencesDrawerHost';
import { openPreferences } from '../src/app/components/ade/preferences/preferencesDrawerBus';
import {
  SHELL_SHORTCUTS,
  isTypingTarget,
  matchesPreferencesShortcut,
  matchesShortcutsShortcut,
} from '../src/app/components/ade/preferences/shortcuts';
import { TABS } from '../src/app/components/ade/PreferencesDrawer';
import type { PreferencesTabId } from '../src/app/components/ade/preferences/preferencesDrawerBus';
import { ThemeProvider } from '../src/app/providers/ThemeProvider';

/** Install a `matchMedia` jsdom does not implement; nothing matches by default. */
function mockMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

/** The element every preference and the theme are applied to. */
const html = () => document.documentElement;

/**
 * Render the host with only a `ThemeProvider` above it.
 *
 * Deliberately without a `PreferencesProvider`: that is the tree the commercial Studio
 * gives `TopHeader`, and the pane is supposed to bring its own (`PreferencesBoundary`).
 *
 * @returns The Testing Library result, plus the button that stands in for a trigger.
 */
function renderHost() {
  const result = render(
    <ThemeProvider>
      <button type="button" data-testid="trigger" onClick={() => openPreferences()}>
        Preferences
      </button>
      <PreferencesDrawerHost />
    </ThemeProvider>,
  );

  return { ...result, trigger: screen.getByTestId('trigger') };
}

/** Open the pane from the stand-in trigger and wait for it. */
async function openPane(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('trigger'));
  return screen.findByTestId('preferences-drawer');
}

/** The switch row for one preference. */
const switchFor = (key: string) => screen.getByTestId('preferences-drawer').querySelector(`[data-switch="${key}"]`) as HTMLElement;

/** The theme card for one theme id. */
const themeCard = (id: string) =>
  screen.getByTestId('preferences-drawer').querySelector(`[data-theme-card="${id}"]`) as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  [...Object.values(PREFERENCE_ATTRIBUTES), 'data-theme', 'data-theme-choice'].forEach(
    (attribute) => html().removeAttribute(attribute),
  );
  html().removeAttribute('style');
  setNextTheme.mockClear();
  mockMatchMedia();
});

describe('reaching the pane', () => {
  it('opens when a surface asks for it', async () => {
    const user = userEvent.setup();
    renderHost();

    expect(screen.queryByTestId('preferences-drawer')).not.toBeInTheDocument();
    await openPane(user);

    expect(screen.getByRole('dialog', { name: 'Preferences' })).toBeInTheDocument();
  });

  it('opens on ⌘, and on Ctrl+, — the chord every desktop uses for settings', async () => {
    renderHost();

    act(() => {
      fireEvent.keyDown(document, { key: ',', metaKey: true });
    });
    expect(await screen.findByTestId('preferences-drawer')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('preferences-drawer')).not.toBeInTheDocument());

    act(() => {
      fireEvent.keyDown(document, { key: ',', ctrlKey: true });
    });
    expect(await screen.findByTestId('preferences-drawer')).toBeInTheDocument();
  });

  it('ignores a bare comma, so typing one never opens the pane', () => {
    renderHost();

    fireEvent.keyDown(document, { key: ',' });
    fireEvent.keyDown(document, { key: ',', metaKey: true, shiftKey: true });

    expect(screen.queryByTestId('preferences-drawer')).not.toBeInTheDocument();
  });

  it('reports whether anything answered, so a surface can hide a dead entry point', () => {
    const { unmount } = renderHost();

    expect(openPreferences()).toBe(true);
    unmount();
    expect(openPreferences()).toBe(false);
  });

  it('lands on the tab a caller names (HIVE-3.4 #5290)', async () => {
    renderHost();

    act(() => {
      openPreferences('shortcuts');
    });

    await screen.findByTestId('preferences-drawer');
    expect(screen.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute(
      'data-state',
      'active',
    );
  });

  it('opens on ? with the shortcuts already showing', async () => {
    renderHost();

    act(() => {
      fireEvent.keyDown(document, { key: '?' });
    });

    await screen.findByTestId('preferences-drawer');
    expect(screen.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute(
      'data-state',
      'active',
    );
  });

  it('leaves ? alone while the reader is typing it', () => {
    renderHost();
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();

    fireEvent.keyDown(field, { key: '?' });
    expect(screen.queryByTestId('preferences-drawer')).not.toBeInTheDocument();

    // …and modified, where it belongs to the browser rather than to us.
    fireEvent.keyDown(document, { key: '?', metaKey: true });
    expect(screen.queryByTestId('preferences-drawer')).not.toBeInTheDocument();

    field.remove();
  });

  it('names the same tabs on the bus that the pane renders', () => {
    // The bus restates the tab ids so that every entry point can import it without the
    // drawer's module graph; this is the assertion its docstring promises.
    const busIds: PreferencesTabId[] = ['appearance', 'account', 'notifications', 'shortcuts'];
    expect(TABS.map((tab) => tab.id)).toEqual(busIds);
  });
});

describe('leaving the pane', () => {
  it('closes on Escape, on Done and on the close button', async () => {
    const user = userEvent.setup();
    renderHost();

    await openPane(user);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('preferences-drawer')).not.toBeInTheDocument());

    await openPane(user);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('preferences-drawer')).not.toBeInTheDocument());

    await openPane(user);
    await user.click(screen.getByRole('button', { name: 'Close preferences' }));
    await waitFor(() => expect(screen.queryByTestId('preferences-drawer')).not.toBeInTheDocument());
  });

  it('moves focus into the pane and gives it back to the trigger on close', async () => {
    const user = userEvent.setup();
    const { trigger } = renderHost();

    const drawer = await openPane(user);
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('names and describes itself, so the dialog is not announced as unlabelled', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Preferences');
    expect(dialog).toHaveAccessibleDescription(
      'Personal to you · applies to every workspace on this device',
    );
  });

  it('says the settings are already saved, because they are', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    expect(screen.getByText('Saved automatically')).toBeInTheDocument();
  });
});

describe('the theme picker', () => {
  it('is a radiogroup over the whole catalogue, with the current choice checked', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    const radios = within(group).getAllByRole('radio');

    expect(radios).toHaveLength(themes.length);
    // Nothing stored means "follow system", which is the app default.
    expect(themeCard('system')).toHaveAttribute('aria-checked', 'true');
  });

  it('is one tab stop: only the checked card is reachable with Tab', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    const focusable = within(group)
      .getAllByRole('radio')
      .filter((radio) => radio.getAttribute('tabindex') === '0');

    expect(focusable).toEqual([themeCard('system')]);
  });

  it('applies a theme the moment it is chosen — no Save', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    await user.click(themeCard('nord'));

    expect(html().getAttribute('data-theme')).toBe('nord');
    expect(html().getAttribute('data-theme-choice')).toBe('nord');
    expect(localStorage.getItem('hive.theme')).toBe('nord');
    expect(themeCard('nord')).toHaveAttribute('aria-checked', 'true');
    expect(themeCard('system')).toHaveAttribute('aria-checked', 'false');
  });

  it('says what "follow system" resolves to only while the OS is in charge', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    // Following the system, which reports light here.
    expect(themeCard('system')).toHaveTextContent('Currently: Light');

    await user.click(themeCard('nord'));

    // Nord is the user's choice, not the OS's — the card must not claim otherwise.
    expect(themeCard('system')).not.toHaveTextContent('Currently:');
  });

  it('moves with the arrow keys, selection following focus, wrapping at both ends', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    themeCard('system').focus();

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(themeCard(themes[1].id));
    expect(localStorage.getItem('hive.theme')).toBe(themes[1].id);

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    // Wrapped backwards off the first card onto the last.
    expect(document.activeElement).toBe(themeCard(themes[themes.length - 1].id));

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(themeCard(themes[0].id));
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    themeCard('system').focus();

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(themeCard(themes[themes.length - 1].id));

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(themeCard(themes[0].id));
  });
});

describe('the font-size slider', () => {
  it('starts on the stored stop and names it', async () => {
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.fontScale, 'xl');
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    const slider = screen.getByTestId('preferences-font-scale') as HTMLInputElement;

    expect(slider.value).toBe(String(FONT_SCALES.findIndex((scale) => scale.id === 'xl')));
    expect(screen.getByTestId('preferences-font-scale-label')).toHaveTextContent('Larger · 18px');
  });

  it('rescales the document and stores the stop on every change', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    const slider = screen.getByTestId('preferences-font-scale');
    fireEvent.change(slider, { target: { value: '0' } });

    await waitFor(() => expect(html().getAttribute('data-font-scale')).toBe('xs'));
    expect(localStorage.getItem(PREFERENCE_STORAGE_KEYS.fontScale)).toBe('xs');
    expect(screen.getByTestId('preferences-font-scale-label')).toHaveTextContent('Small · 14px');
  });

  it('offers exactly the stops the stylesheet has rules for', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    const slider = screen.getByTestId('preferences-font-scale') as HTMLInputElement;

    expect(slider.min).toBe('0');
    expect(slider.max).toBe(String(FONT_SCALES.length - 1));
    expect(slider.step).toBe('1');
  });
});

describe('the density control', () => {
  it('is a radiogroup, and switching writes the attribute and the key', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    const group = screen.getByRole('radiogroup', { name: 'Density' });
    const compact = within(group).getByRole('radio', { name: 'Compact' });

    expect(within(group).getByRole('radio', { name: 'Comfortable' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(compact);

    await waitFor(() => expect(html().getAttribute('data-density')).toBe('compact'));
    expect(localStorage.getItem(PREFERENCE_STORAGE_KEYS.density)).toBe('compact');
    expect(compact).toHaveAttribute('aria-checked', 'true');
  });

  it('moves between the two steps with the arrow keys', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    const group = screen.getByRole('radiogroup', { name: 'Density' });
    within(group).getByRole('radio', { name: 'Comfortable' }).focus();

    await user.keyboard('{ArrowRight}');

    expect(localStorage.getItem(PREFERENCE_STORAGE_KEYS.density)).toBe('compact');
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'Compact' }));
  });
});

describe('the switches', () => {
  it('renders one row per two-state preference, off by default where the default is off', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    SWITCH_PREFERENCES.forEach((row) => {
      const control = switchFor(row.key);
      expect(control).toHaveAttribute('role', 'switch');
      expect(control).toHaveAccessibleName(row.title);
      expect(control).toHaveAccessibleDescription(row.description);
      expect(control).toHaveAttribute(
        'aria-checked',
        String(DEFAULT_PREFERENCES[row.key] === row.on),
      );
    });
  });

  it.each(SWITCH_PREFERENCES.map((row) => [row.key, row] as const))(
    'writes the stored spelling for %s, both ways round',
    async (_key, row) => {
      const user = userEvent.setup();
      renderHost();
      await openPane(user);

      const control = switchFor(row.key);
      const startsOn = DEFAULT_PREFERENCES[row.key] === row.on;

      await user.click(control);
      await waitFor(() =>
        expect(html().getAttribute(PREFERENCE_ATTRIBUTES[row.key])).toBe(
          startsOn ? row.off : row.on,
        ),
      );
      expect(localStorage.getItem(PREFERENCE_STORAGE_KEYS[row.key])).toBe(
        startsOn ? row.off : row.on,
      );

      await user.click(switchFor(row.key));
      await waitFor(() =>
        expect(html().getAttribute(PREFERENCE_ATTRIBUTES[row.key])).toBe(
          startsOn ? row.on : row.off,
        ),
      );
    },
  );
});

describe('the other tabs', () => {
  it('offers Appearance, Account, Notifications and Shortcuts', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Appearance',
      'Account',
      'Notifications',
      'Shortcuts',
    ]);
  });

  it('links to the account pages rather than duplicating them', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    await user.click(screen.getByRole('tab', { name: 'Account' }));

    expect(screen.getByRole('link', { name: /Profile/ })).toHaveAttribute(
      'href',
      '/ade/dashboard/profile',
    );
    expect(screen.getByRole('link', { name: /Linked accounts/ })).toHaveAttribute(
      'href',
      '/ade/dashboard/linked-accounts',
    );
    // No second copy of the settings those pages own.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('offers no notification controls while none can be delivered', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    await user.click(screen.getByRole('tab', { name: 'Notifications' }));
    const panel = screen.getByTestId('preferences-notifications');

    expect(panel).toHaveTextContent('Notifications are not available yet');
    expect(within(panel).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('documents only shortcuts that work', async () => {
    const user = userEvent.setup();
    renderHost();
    await openPane(user);

    await user.click(screen.getByRole('tab', { name: 'Shortcuts' }));
    const panel = screen.getByTestId('preferences-shortcuts');

    expect(panel.querySelector('[data-shortcut="preferences"]')).toHaveTextContent(
      'Open preferences',
    );
    // The row is not just copy: the matcher it documents accepts that very chord.
    const documented = SHELL_SHORTCUTS.find((entry) => entry.id === 'preferences')!;
    expect(documented.keys).toEqual(['⌘', ',']);
    expect(
      matchesPreferencesShortcut({
        key: ',',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        defaultPrevented: false,
      } as KeyboardEvent),
    ).toBe(true);

    // …and the same for the chord this tab is itself reachable by (HIVE-3.4, #5290).
    expect(panel.querySelector('[data-shortcut="shortcuts"]')).toHaveTextContent(
      'Show the keyboard shortcuts',
    );
    expect(SHELL_SHORTCUTS.find((entry) => entry.id === 'shortcuts')!.keys).toEqual(['?']);
    expect(
      matchesShortcutsShortcut({
        key: '?',
        target: document.body,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
        repeat: false,
        defaultPrevented: false,
      } as unknown as KeyboardEvent),
    ).toBe(true);
  });
});

describe('where a printable shortcut may fire', () => {
  it.each([
    ['a text input', () => document.createElement('input')],
    ['a search input', () => Object.assign(document.createElement('input'), { type: 'search' })],
    ['a textarea', () => document.createElement('textarea')],
    ['a select', () => document.createElement('select')],
  ])('treats %s as somewhere the reader is typing', (_label, make) => {
    expect(isTypingTarget(make())).toBe(true);
  });

  it.each([
    ['a checkbox', 'checkbox'],
    ['a radio', 'radio'],
    ['a button', 'button'],
    ['a range', 'range'],
  ])('leaves %s alone — nothing is being typed there', (_label, type) => {
    const input = document.createElement('input');
    input.type = type;
    expect(isTypingTarget(input)).toBe(false);
  });

  it('treats a contenteditable subtree as typing, and a plain element as not', () => {
    const editable = document.createElement('div');
    // jsdom does not implement `isContentEditable`; the attribute alone leaves it false,
    // so the property is what the matcher reads and what this stands in for.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);

    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('persistence', () => {
  it('reads its own writes back after the pane and its host are remounted', async () => {
    const user = userEvent.setup();
    const first = renderHost();

    await openPane(user);
    await user.click(themeCard('darcula'));
    fireEvent.change(screen.getByTestId('preferences-font-scale'), { target: { value: '5' } });
    await user.click(switchFor('monoIds'));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    first.unmount();

    renderHost();
    await openPane(user);

    expect(themeCard('darcula')).toHaveAttribute('aria-checked', 'true');
    expect((screen.getByTestId('preferences-font-scale') as HTMLInputElement).value).toBe('5');
    expect(switchFor('monoIds')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('accessibility', () => {
  it.each(['Appearance', 'Account', 'Notifications', 'Shortcuts'])(
    'has no axe violations on the %s tab',
    async (tab) => {
      const user = userEvent.setup();
      const { baseElement } = renderHost();
      await openPane(user);
      await user.click(screen.getByRole('tab', { name: tab }));

      expect(await axe(baseElement)).toHaveNoViolations();
    },
  );
});
