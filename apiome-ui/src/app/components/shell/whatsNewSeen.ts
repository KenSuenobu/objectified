'use client';

import * as React from 'react';
import { APP_VERSION_BADGE } from '@lib/app-version';

/**
 * "Has this reader seen the release notes for the build they are running?" (HIVE-3.4, #5290).
 *
 * The rail user menu marks What's new with a honey dot until the notes for the current
 * build have been opened (`DESIGN.md` §5.2; `docs/mockups/assets/hive.js` `dot--honey`).
 * The whole of that state is one string in `localStorage` — the build the reader last
 * looked at — compared against the build they are running now
 * ({@link APP_VERSION_BADGE}).
 *
 * Why the *badge* string rather than the bare semver: the badge is what the notes are
 * labelled with in the menu footer, and on a CI build it is the stamp
 * (`NEXT_PUBLIC_APP_BUILD_LABEL`) rather than the version. Keying on anything else would
 * let two different builds share one "seen" mark.
 *
 * Every read and write is guarded. A browser with storage disabled, a private window that
 * throws on write, or a server render all resolve to "read" rather than to a crash: an
 * unread dot the reader never sees is a smaller failure than a shell that does not render.
 */

/** Where the last-seen build string is kept. Namespaced with the other Hive shell keys. */
export const WHATS_NEW_SEEN_STORAGE_KEY = 'hive.whatsNewSeen';

/**
 * The build whose notes were last opened.
 *
 * @returns The stored build string, or `null` when nothing has been seen — or when
 *   storage cannot be read at all.
 */
export function readLastSeenWhatsNew(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(WHATS_NEW_SEEN_STORAGE_KEY);
  } catch {
    // Storage disabled or blocked by policy. Nothing is "seen", and nothing breaks.
    return null;
  }
}

/**
 * Record that this build's notes have been read.
 *
 * @param version The build string that was shown. Defaults to the running build.
 */
export function markWhatsNewSeen(version: string = APP_VERSION_BADGE): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WHATS_NEW_SEEN_STORAGE_KEY, version);
  } catch {
    // A write that fails only costs the reader a dot that reappears next time.
  }
}

/**
 * Whether the running build has unread release notes.
 *
 * @param version The build string to test. Defaults to the running build.
 * @returns `true` when the reader has not opened the notes for this build.
 */
export function hasUnreadWhatsNew(version: string = APP_VERSION_BADGE): boolean {
  return readLastSeenWhatsNew() !== version;
}

/** What {@link useWhatsNewUnread} gives back. */
export interface WhatsNewUnread {
  /** `true` while this build's notes are unread — the honey dot's whole condition. */
  unread: boolean;
  /** Call when the notes have been shown; clears the dot and persists the mark. */
  markSeen: () => void;
}

/**
 * Track the unread state of the current build's release notes.
 *
 * The initial state is deliberately `false` rather than a `localStorage` read: the shell
 * is server-rendered, and a hook that answered `true` on the server would paint a dot into
 * the HTML that React then has to take away — a visible flash for every reader who is up
 * to date. The real answer arrives in an effect, one commit later, which is also when
 * `window` is guaranteed to exist.
 *
 * @returns The flag and the acknowledgement, per {@link WhatsNewUnread}.
 */
export function useWhatsNewUnread(): WhatsNewUnread {
  const [unread, setUnread] = React.useState(false);

  React.useEffect(() => {
    setUnread(hasUnreadWhatsNew());
  }, []);

  const markSeen = React.useCallback(() => {
    markWhatsNewSeen();
    setUnread(false);
  }, []);

  return { unread, markSeen };
}
