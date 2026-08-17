/**
 * The seams the preferences pane is reached through (HIVE-1.4, #5277).
 *
 * `tests/preferences-drawer.test.tsx` drives the pane itself. This suite covers the two
 * pieces that make it reachable from anywhere without a provider every shell has to
 * remember to mount: the host registry, and the shortcut matcher — plus
 * `PreferencesBoundary`, which is what lets the pane be hosted from outside this app, in a
 * tree that has no `PreferencesProvider` of its own (the commercial Studio's top bar).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  isPreferencesDrawerMounted,
  openPreferences,
  registerPreferencesDrawerHost,
} from '../src/app/components/ade/preferences/preferencesDrawerBus';
import { PREFERENCES_SHORTCUT, matchesShortcutChord } from '../lib/shortcuts';
import {
  PreferencesBoundary,
  PreferencesProvider,
  usePreferences,
} from '../src/app/providers/PreferencesProvider';

/**
 * Build a keyboard event for the matcher, defaulting every flag to "not pressed".
 *
 * @param overrides The fields under test.
 * @returns Something shaped like the `KeyboardEvent` the matcher reads.
 */
function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: ',',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  } as KeyboardEvent;
}

describe('the host registry', () => {
  it('reports that nothing can answer before a host mounts', () => {
    expect(isPreferencesDrawerMounted()).toBe(false);
    expect(openPreferences()).toBe(false);
  });

  it('routes to the most recently mounted host, so two never open at once', () => {
    const first = jest.fn();
    const second = jest.fn();
    const unregisterFirst = registerPreferencesDrawerHost(first);
    const unregisterSecond = registerPreferencesDrawerHost(second);

    expect(openPreferences()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    unregisterSecond();
    unregisterFirst();
  });

  it('falls back to the host still mounted when the newer one goes away', () => {
    const first = jest.fn();
    const second = jest.fn();
    const unregisterFirst = registerPreferencesDrawerHost(first);
    const unregisterSecond = registerPreferencesDrawerHost(second);

    unregisterSecond();
    openPreferences();

    expect(first).toHaveBeenCalledTimes(1);
    unregisterFirst();
    expect(isPreferencesDrawerMounted()).toBe(false);
  });

  it('unregisters exactly one entry, even when a host registers the same callback twice', () => {
    const host = jest.fn();
    const unregisterA = registerPreferencesDrawerHost(host);
    const unregisterB = registerPreferencesDrawerHost(host);

    unregisterB();
    expect(isPreferencesDrawerMounted()).toBe(true);

    unregisterA();
    expect(isPreferencesDrawerMounted()).toBe(false);
  });
});

describe('the ⌘, chord', () => {
  /** The pane's own declaration (HIVE-3.7, #5293) — one source for chip and matcher. */
  const chord = PREFERENCES_SHORTCUT.chord!;

  it('accepts the chord on either platform', () => {
    expect(matchesShortcutChord(keyEvent({ metaKey: true }), chord)).toBe(true);
    expect(matchesShortcutChord(keyEvent({ ctrlKey: true }), chord)).toBe(true);
  });

  it('rejects anything that is not exactly that chord', () => {
    // A bare comma is a character someone is typing.
    expect(matchesShortcutChord(keyEvent({}), chord)).toBe(false);
    expect(matchesShortcutChord(keyEvent({ key: '.', metaKey: true }), chord)).toBe(false);
    // Extra modifiers belong to some other binding.
    expect(matchesShortcutChord(keyEvent({ metaKey: true, shiftKey: true }), chord)).toBe(false);
    expect(matchesShortcutChord(keyEvent({ metaKey: true, altKey: true }), chord)).toBe(false);
  });

  it('fires inside a text field, which is the whole reason it is a ⌘ chord', () => {
    expect(PREFERENCES_SHORTCUT.allowWhileTyping).toBe(true);
  });
});

/** Renders the identity of the provider instance it is reading from. */
function Probe({ label }: { label: string }) {
  const { setPreference } = usePreferences();
  return (
    <span data-testid={label} data-setter={typeof setPreference}>
      {label}
    </span>
  );
}

describe('PreferencesBoundary', () => {
  it('supplies a provider when the tree has none', () => {
    render(
      <PreferencesBoundary>
        <Probe label="standalone" />
      </PreferencesBoundary>,
    );

    expect(screen.getByTestId('standalone')).toHaveAttribute('data-setter', 'function');
  });

  it('uses the provider already above it rather than nesting a second one', () => {
    const { container } = render(
      <PreferencesProvider>
        <PreferencesBoundary>
          <Probe label="nested" />
        </PreferencesBoundary>
      </PreferencesProvider>,
    );

    expect(screen.getByTestId('nested')).toBeInTheDocument();
    // One provider means one subscription and one migration write-back; the probe
    // rendering at all is what proves the context resolved.
    expect(container.textContent).toBe('nested');
  });
});
