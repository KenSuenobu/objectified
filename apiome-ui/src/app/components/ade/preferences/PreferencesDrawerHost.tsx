'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PreferencesBoundary } from '../../../providers/PreferencesProvider';
import PreferencesDrawer from '../PreferencesDrawer';
import { registerPreferencesDrawerHost, type PreferencesTabId } from './preferencesDrawerBus';
import { matchesPreferencesShortcut, matchesShortcutsShortcut } from './shortcuts';

/**
 * Mounts the preferences pane and answers requests to open it (HIVE-1.4, #5277).
 *
 * The pane is reachable from several places — the rail footer, the rail user menu, the
 * legacy header's profile menu and `⌘,` — and none of them is a component that could
 * sensibly own the drawer for the others. So the drawer lives here, hosts register on
 * {@link registerPreferencesDrawerHost}, and every entry point calls `openPreferences()`
 * without knowing where the pane is.
 *
 * The drawer subtree exists only while the pane is open. Radix keeps a closed dialog out
 * of the DOM anyway; skipping the subtree as well means a route nobody opens preferences
 * from pays nothing for it — including, in the commercial Studio, a `PreferencesProvider`
 * that shell never asked for. `PreferencesBoundary` supplies that provider when the host
 * tree lacks one, which is what lets `TopHeader` mount this host wherever it renders.
 *
 * Focus is returned to the trigger explicitly rather than relying on the dialog's own
 * restoration, because the subtree unmounts in the same commit that closes it — and it is
 * returned from an effect, after that unmount, so the drawer's focus trap is gone by then.
 *
 * Two chords are bound here, both documented in `shortcuts.ts`: `⌘,` opens the pane where
 * it last was, and a bare `?` opens it on the Shortcuts tab (HIVE-3.4, #5290 — the rail
 * user menu's "Keyboard shortcuts" row is the same request made with the mouse). HIVE-3.7
 * (#5293) will point `?` at the generated shortcut sheet instead.
 */
export default function PreferencesDrawerHost() {
  const [open, setOpen] = useState(false);
  /** The tab the current request asked for; `undefined` leaves the pane's own default. */
  const [tab, setTab] = useState<PreferencesTabId | undefined>(undefined);

  /** What had focus when the pane opened, so it can be given back on close. */
  const triggerRef = useRef<HTMLElement | null>(null);

  const openDrawer = useCallback((requestedTab?: PreferencesTabId) => {
    const active = document.activeElement;
    triggerRef.current = active instanceof HTMLElement ? active : null;
    setTab(requestedTab);
    setOpen(true);
  }, []);

  // Give focus back once the pane has actually gone. Restoring it from the close handler
  // would be too early: the drawer is still mounted there, and its focus trap would pull
  // focus straight back in before React unmounted it.
  useEffect(() => {
    if (open) return;

    const trigger = triggerRef.current;
    triggerRef.current = null;
    // A trigger can be gone by now — the user menu that held it closes behind the pane.
    if (trigger && trigger.isConnected) trigger.focus();
  }, [open]);

  // Answer `openPreferences()` for as long as this host is mounted.
  useEffect(() => registerPreferencesDrawerHost(openDrawer), [openDrawer]);

  // `⌘,` / `Ctrl+,`, the chord every desktop platform already uses for settings, and `?`
  // for the shortcuts reference. Bound on the document so they work wherever focus is —
  // `⌘,` deliberately inside text fields too, `?` deliberately not (`isTypingTarget`).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (matchesPreferencesShortcut(event)) {
        event.preventDefault();
        openDrawer();
        return;
      }
      if (matchesShortcutsShortcut(event)) {
        event.preventDefault();
        openDrawer('shortcuts');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openDrawer]);

  if (!open) return null;

  return (
    <PreferencesBoundary>
      <PreferencesDrawer open initialTab={tab} onOpenChange={setOpen} />
    </PreferencesBoundary>
  );
}
