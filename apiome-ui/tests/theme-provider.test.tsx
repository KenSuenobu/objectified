/**
 * ThemeProvider — `src/app/providers/ThemeProvider.tsx` (HIVE-1.2, #5275).
 *
 * The provider's whole job is to decide *which* token swap applies and to say so on
 * `<html>`. This suite pins that contract from the outside: what it writes, what it
 * deliberately no longer writes, how it resolves "follow system" (including live, with no
 * reload), and how it hands the `.dark` class to next-themes for the utilities that have
 * not been migrated to tokens yet.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../src/app/providers/ThemeProvider';

/** Captures what the provider asks next-themes to do. */
const setNextTheme = jest.fn();

jest.mock('next-themes', () => ({
  useTheme: () => ({ setTheme: setNextTheme }),
}));

/** Listeners registered against the `prefers-color-scheme` query, newest last. */
let mediaListeners: Array<() => void> = [];

/** What `(prefers-color-scheme: dark)` currently reports. */
let prefersDark = false;

/**
 * Install a `matchMedia` jsdom does not implement, with a switchable preference.
 *
 * @param dark Whether the OS should report a dark preference.
 */
function mockMatchMedia(dark: boolean): void {
  prefersDark = dark;
  mediaListeners = [];
  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return query.includes('dark') && prefersDark;
    },
    addEventListener: (_event: string, listener: () => void) => {
      mediaListeners.push(listener);
    },
    removeEventListener: (_event: string, listener: () => void) => {
      mediaListeners = mediaListeners.filter((registered) => registered !== listener);
    },
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

/**
 * Flip the OS preference and notify the provider, exactly as a browser would.
 *
 * @param dark The new preference.
 */
function changeSystemPreference(dark: boolean): void {
  prefersDark = dark;
  act(() => {
    mediaListeners.forEach((listener) => listener());
  });
}

/** Renders the context so assertions can read it out of the DOM. */
function Probe() {
  const { currentTheme, resolvedTheme, isSystemTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="choice">{currentTheme.id}</span>
      <span data-testid="resolved">{resolvedTheme.id}</span>
      <span data-testid="is-system">{String(isSystemTheme)}</span>
      <button onClick={() => setTheme('solarized')}>solarized</button>
      <button onClick={() => setTheme('midnight-commander')}>unknown</button>
    </div>
  );
}

/**
 * Mount the provider with a probe inside it.
 *
 * @returns The render result.
 */
function renderProvider() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

/** The `<html>` element the provider writes to. */
const html = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  setNextTheme.mockClear();
  html().removeAttribute('data-theme');
  html().removeAttribute('data-theme-choice');
  html().removeAttribute('style');
  html().className = '';
  document.body.removeAttribute('style');
  document.body.removeAttribute('data-theme');
  document.body.className = '';
  mockMatchMedia(false);
});

describe('what the provider writes to <html>', () => {
  it('resolves "follow system" to a real theme id and records the raw choice', () => {
    renderProvider();

    expect(html().getAttribute('data-theme')).toBe('light');
    expect(html().getAttribute('data-theme-choice')).toBe('system');
    expect(screen.getByTestId('is-system')).toHaveTextContent('true');
  });

  it('never writes `system` to data-theme — no stylesheet block would match it', () => {
    mockMatchMedia(true);
    renderProvider();

    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(html().getAttribute('data-theme-choice')).toBe('system');
  });

  it('declares the colour scheme so browser built-ins follow the palette', () => {
    localStorage.setItem('app-theme', 'nord');
    renderProvider();

    expect(html().style.colorScheme).toBe('dark');
  });

  it('declares a light colour scheme for the light-based palettes', () => {
    localStorage.setItem('app-theme', 'whiteboard');
    renderProvider();

    expect(html().style.colorScheme).toBe('light');
  });

  it('applies a stored palette choice as itself', () => {
    localStorage.setItem('app-theme', 'darcula');
    renderProvider();

    expect(html().getAttribute('data-theme')).toBe('darcula');
    expect(html().getAttribute('data-theme-choice')).toBe('darcula');
    expect(screen.getByTestId('is-system')).toHaveTextContent('false');
  });
});

describe('what the provider no longer writes', () => {
  it('leaves body styling to the stylesheet', () => {
    localStorage.setItem('app-theme', 'nord');
    renderProvider();

    expect(document.body.style.backgroundColor).toBe('');
    expect(document.body.style.color).toBe('');
  });

  it('toggles no per-theme class on <html> or <body>', () => {
    localStorage.setItem('app-theme', 'blueprint');
    renderProvider();

    for (const element of [html(), document.body]) {
      expect([...element.classList].filter((name) => name.startsWith('theme-'))).toEqual([]);
    }
  });

  it('marks the theme on <html> only, so one element owns the palette', () => {
    localStorage.setItem('app-theme', 'nord');
    renderProvider();

    expect(document.body.getAttribute('data-theme')).toBeNull();
  });
});

describe('the .dark class stays with next-themes', () => {
  it('delegates "follow system" wholesale', () => {
    renderProvider();

    expect(setNextTheme).toHaveBeenCalledWith('system');
  });

  it.each([
    ['nord', 'dark'],
    ['high-contrast', 'dark'],
    ['whiteboard', 'light'],
    ['light', 'light'],
  ])('asks for the %s base: %s', (themeId, appearance) => {
    localStorage.setItem('app-theme', themeId);
    renderProvider();

    expect(setNextTheme).toHaveBeenCalledWith(appearance);
  });
});

describe('following the system preference', () => {
  it('re-resolves live when the OS preference changes, with no reload', () => {
    renderProvider();
    expect(html().getAttribute('data-theme')).toBe('light');

    changeSystemPreference(true);

    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(html().style.colorScheme).toBe('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    // The choice itself is untouched — the user still follows the system.
    expect(html().getAttribute('data-theme-choice')).toBe('system');
  });

  it('re-resolves back when the OS returns to light', () => {
    mockMatchMedia(true);
    renderProvider();

    changeSystemPreference(false);

    expect(html().getAttribute('data-theme')).toBe('light');
    expect(html().style.colorScheme).toBe('light');
  });

  it('ignores the OS once a fixed theme is chosen', () => {
    localStorage.setItem('app-theme', 'solarized');
    renderProvider();

    changeSystemPreference(true);

    expect(html().getAttribute('data-theme')).toBe('solarized');
  });

  it('stops listening when the provider unmounts', () => {
    const { unmount } = renderProvider();
    expect(mediaListeners.length).toBeGreaterThan(0);

    unmount();

    expect(mediaListeners).toHaveLength(0);
  });
});

describe('choosing a theme', () => {
  it('applies and persists the choice immediately', () => {
    renderProvider();

    act(() => {
      screen.getByText('solarized').click();
    });

    expect(html().getAttribute('data-theme')).toBe('solarized');
    expect(html().getAttribute('data-theme-choice')).toBe('solarized');
    expect(localStorage.getItem('app-theme')).toBe('solarized');
    expect(setNextTheme).toHaveBeenLastCalledWith('dark');
  });

  it('ignores an id that no theme carries', () => {
    localStorage.setItem('app-theme', 'nord');
    renderProvider();

    act(() => {
      screen.getByText('unknown').click();
    });

    expect(html().getAttribute('data-theme')).toBe('nord');
    expect(localStorage.getItem('app-theme')).toBe('nord');
  });
});

describe('reading the stored choice', () => {
  it('defaults to following the system and records that default', () => {
    renderProvider();

    expect(localStorage.getItem('app-theme')).toBe('system');
  });

  it('falls back to the next-themes key for installs that predate this provider', () => {
    localStorage.setItem('theme', 'dark');
    renderProvider();

    expect(html().getAttribute('data-theme-choice')).toBe('dark');
    expect(localStorage.getItem('app-theme')).toBe('dark');
  });

  it('prefers its own key, which is the only one that can hold a palette id', () => {
    localStorage.setItem('app-theme', 'nord');
    localStorage.setItem('theme', 'dark');
    renderProvider();

    expect(html().getAttribute('data-theme-choice')).toBe('nord');
  });

  it('follows the system when the stored id no longer exists', () => {
    localStorage.setItem('app-theme', 'midnight-commander');
    renderProvider();

    expect(html().getAttribute('data-theme-choice')).toBe('system');
    expect(html().getAttribute('data-theme')).toBe('light');
  });
});

describe('using the hook', () => {
  it('refuses to run outside a provider', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('useTheme must be used within a ThemeProvider');
    error.mockRestore();
  });
});
