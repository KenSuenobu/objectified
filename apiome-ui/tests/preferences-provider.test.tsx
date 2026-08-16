/**
 * PreferencesProvider — `src/app/providers/PreferencesProvider.tsx` (HIVE-1.3, #5276).
 *
 * The provider's job is to say, on `<html>`, which spacing and type scale the shell should
 * use — and to keep that answer in step with storage, with other tabs and with the
 * operating system. This suite pins that contract from the outside: what lands on the
 * element, what lands in storage, and what `usePreferences()` hands a component.
 *
 * The pre-paint half of the same contract — the blocking boot script — is covered by
 * `tests/preferences-config.test.ts`.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PreferencesProvider, usePreferences } from '../src/app/providers/PreferencesProvider';

/** Listeners registered against the reduced-motion query, newest last. */
let mediaListeners: Array<() => void> = [];

/** What `(prefers-reduced-motion: reduce)` currently reports. */
let prefersReducedMotion = false;

/**
 * Install a `matchMedia` jsdom does not implement, with a switchable preference.
 *
 * @param reduced Whether the OS should ask for reduced motion.
 */
function mockMatchMedia(reduced: boolean): void {
  prefersReducedMotion = reduced;
  mediaListeners = [];
  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return query.includes('reduced-motion') && prefersReducedMotion;
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
 * Flip the OS motion preference and notify the provider, exactly as a browser would.
 *
 * @param reduced The new preference.
 */
function changeSystemMotion(reduced: boolean): void {
  prefersReducedMotion = reduced;
  act(() => {
    mediaListeners.forEach((listener) => listener());
  });
}

/** Renders the context so assertions can read it out of the DOM. */
function Probe() {
  const {
    preferences,
    prefersReducedMotion: reduced,
    setFontScale,
    setDensity,
    setMotion,
    setRail,
    toggleRail,
    setPreference,
  } = usePreferences();

  return (
    <div>
      <span data-testid="font-scale">{preferences.fontScale}</span>
      <span data-testid="density">{preferences.density}</span>
      <span data-testid="motion">{preferences.motion}</span>
      <span data-testid="rail">{preferences.rail}</span>
      <span data-testid="reduced">{String(reduced)}</span>
      <button onClick={() => setFontScale('2xl')}>font</button>
      <button onClick={() => setDensity('compact')}>density</button>
      <button onClick={() => setMotion('reduce')}>motion</button>
      <button onClick={() => setRail('collapsed')}>rail</button>
      <button onClick={toggleRail}>toggle</button>
      <button onClick={() => setPreference('fontScale', 'sm')}>generic</button>
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
    <PreferencesProvider>
      <Probe />
    </PreferencesProvider>,
  );
}

/** The `<html>` element the provider writes to. */
const html = () => document.documentElement;

/** Read one applied preference off the element. */
const applied = (attribute: string) => html().getAttribute(attribute);

beforeEach(() => {
  localStorage.clear();
  ['data-font-scale', 'data-density', 'data-motion', 'data-rail'].forEach((attribute) =>
    html().removeAttribute(attribute),
  );
  mockMatchMedia(false);
});

describe('what the provider applies on mount', () => {
  it('applies the defaults when the device has stored nothing', () => {
    renderProvider();

    expect(applied('data-font-scale')).toBe('md');
    expect(applied('data-density')).toBe('comfortable');
    expect(applied('data-motion')).toBe('auto');
    expect(applied('data-rail')).toBe('expanded');
  });

  it('adopts what this device stored', () => {
    localStorage.setItem('hive.fontScale', 'xl');
    localStorage.setItem('hive.density', 'compact');
    localStorage.setItem('hive.motion', 'reduce');
    localStorage.setItem('hive.rail', 'collapsed');

    renderProvider();

    expect(applied('data-font-scale')).toBe('xl');
    expect(applied('data-density')).toBe('compact');
    expect(applied('data-motion')).toBe('reduce');
    expect(applied('data-rail')).toBe('collapsed');
    expect(screen.getByTestId('font-scale')).toHaveTextContent('xl');
  });

  it('migrates the legacy sidebar density and rewrites it under the new key', () => {
    localStorage.setItem('apiome.sidebar.density', 'compact');

    renderProvider();

    expect(applied('data-density')).toBe('compact');
    expect(localStorage.getItem('hive.density')).toBe('compact');
  });

  it('folds the legacy `standard` step onto comfortable', () => {
    localStorage.setItem('apiome.sidebar.density', 'standard');

    renderProvider();

    expect(applied('data-density')).toBe('comfortable');
    expect(localStorage.getItem('hive.density')).toBe('comfortable');
  });

  it('writes every preference back, so the next read needs no fallback', () => {
    renderProvider();

    expect(localStorage.getItem('hive.fontScale')).toBe('md');
    expect(localStorage.getItem('hive.density')).toBe('comfortable');
    expect(localStorage.getItem('hive.motion')).toBe('auto');
    expect(localStorage.getItem('hive.rail')).toBe('expanded');
  });
});

describe('changing a preference', () => {
  it('applies and persists the new font scale', () => {
    renderProvider();

    fireEvent.click(screen.getByText('font'));

    expect(applied('data-font-scale')).toBe('2xl');
    expect(localStorage.getItem('hive.fontScale')).toBe('2xl');
    expect(screen.getByTestId('font-scale')).toHaveTextContent('2xl');
  });

  it('applies and persists density, motion and rail through their own setters', () => {
    renderProvider();

    fireEvent.click(screen.getByText('density'));
    fireEvent.click(screen.getByText('motion'));
    fireEvent.click(screen.getByText('rail'));

    expect([applied('data-density'), applied('data-motion'), applied('data-rail')]).toEqual([
      'compact',
      'reduce',
      'collapsed',
    ]);
    expect(localStorage.getItem('hive.density')).toBe('compact');
    expect(localStorage.getItem('hive.motion')).toBe('reduce');
    expect(localStorage.getItem('hive.rail')).toBe('collapsed');
  });

  it('sets a preference by name, for callers that hold the key', () => {
    renderProvider();

    fireEvent.click(screen.getByText('generic'));

    expect(applied('data-font-scale')).toBe('sm');
  });

  it('flips the rail both ways', () => {
    renderProvider();

    fireEvent.click(screen.getByText('toggle'));
    expect(applied('data-rail')).toBe('collapsed');

    fireEvent.click(screen.getByText('toggle'));
    expect(applied('data-rail')).toBe('expanded');
  });

  it('leaves the other preferences alone', () => {
    renderProvider();

    fireEvent.click(screen.getByText('density'));

    expect(applied('data-font-scale')).toBe('md');
    expect(applied('data-motion')).toBe('auto');
    expect(applied('data-rail')).toBe('expanded');
  });
});

describe('reduced motion is the OS setting *or* the preference', () => {
  it('reports the operating-system setting even with motion left on auto', () => {
    mockMatchMedia(true);
    renderProvider();

    expect(screen.getByTestId('motion')).toHaveTextContent('auto');
    expect(screen.getByTestId('reduced')).toHaveTextContent('true');
  });

  it('reports the stored preference when the OS asks for nothing', () => {
    renderProvider();
    fireEvent.click(screen.getByText('motion'));

    expect(screen.getByTestId('reduced')).toHaveTextContent('true');
  });

  it('follows the OS live, with no reload', () => {
    renderProvider();
    expect(screen.getByTestId('reduced')).toHaveTextContent('false');

    changeSystemMotion(true);
    expect(screen.getByTestId('reduced')).toHaveTextContent('true');

    changeSystemMotion(false);
    expect(screen.getByTestId('reduced')).toHaveTextContent('false');
  });

  it('does not write the OS setting into the stored preference', () => {
    // The reader asked the OS, not this app: storing it would strand them on `reduce`
    // after they turn the OS setting off again.
    mockMatchMedia(true);
    renderProvider();

    expect(localStorage.getItem('hive.motion')).toBe('auto');
  });
});

describe('a second tab is the same device', () => {
  it('adopts a preference another tab stored', () => {
    renderProvider();

    localStorage.setItem('hive.density', 'compact');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'hive.density' }));
    });

    expect(applied('data-density')).toBe('compact');
    expect(screen.getByTestId('density')).toHaveTextContent('compact');
  });

  it('re-reads everything when another tab clears storage', () => {
    localStorage.setItem('hive.fontScale', 'xl');
    renderProvider();

    localStorage.clear();
    act(() => {
      // `key === null` is how a browser reports `localStorage.clear()`.
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });

    expect(applied('data-font-scale')).toBe('md');
  });

  it('ignores storage traffic that is none of its business', () => {
    renderProvider();

    localStorage.setItem('apiome.sidebar.density', 'compact');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'apiome.sidebar.density' }));
    });

    // Migration happens once, on mount. A legacy write afterwards belongs to the legacy
    // sidebars, and must not silently re-tighten a shell the user already set.
    expect(applied('data-density')).toBe('comfortable');
  });

  it('stops listening once unmounted', () => {
    const { unmount } = renderProvider();
    unmount();

    localStorage.setItem('hive.density', 'compact');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'hive.density' }));
    });

    expect(applied('data-density')).toBe('comfortable');
  });
});

describe('using the hook outside the provider', () => {
  it('throws, rather than silently handing back defaults', () => {
    // A component reading preferences without the provider would look right until the user
    // changed one, then never update; failing loudly is the smaller bug.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => render(<Probe />)).toThrow(
        'usePreferences must be used within a PreferencesProvider',
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
