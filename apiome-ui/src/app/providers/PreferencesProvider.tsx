'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_STORAGE_KEYS,
  applyPreferences,
  persistPreferences,
  readPreferences,
  writePreference,
  type DensityId,
  type FontScaleId,
  type MotionId,
  type PreferenceKey,
  type Preferences,
  type RailId,
  type ToggleId,
} from '../config/preferences';

/**
 * Preferences provider (HIVE-1.3, #5276).
 *
 * Owns the device-local shell settings — font scale, density, motion, the sidebar start
 * state, the identifier face and the keyboard hints — and applies them the way
 * `ThemeProvider` applies a theme: as attributes on
 * `<html>` that `globals.css` swaps tokens for. No component reads a preference to lay
 * itself out; it reads tokens, and the tokens change underneath it.
 *
 * The attributes are already correct before this provider mounts, because the blocking
 * script in `<head>` (`preferencesBootScript`) applied them from the same rules. What
 * mounting adds is the React-side view of those values, the setters, and the migration
 * write-back that moves a legacy-keyed setting under its `hive.*` name.
 *
 * `localStorage` is treated as what it is — an external store — and read through
 * {@link useSyncExternalStore}, matching `components/sidebar/sidebar-theme.ts`. That is
 * what keeps the provider SSR-safe (the server and the hydrating render both see
 * {@link DEFAULT_PREFERENCES}), keeps two tabs of the same app in step, and avoids the
 * cascading render of reading storage into state from an effect.
 *
 * @see {@link module:src/app/config/preferences} for the storage and attribute contract.
 */

/** The query the "reduce motion" operating-system setting is read from. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Same-tab notification that a preference changed; `storage` only reaches other tabs. */
const PREFERENCES_EVENT = 'hive:preferences';

/** The keys a storage event has to name for this provider to care. */
const CANONICAL_KEYS = new Set<string>(Object.values(PREFERENCE_STORAGE_KEYS));

/**
 * The last value read out of storage.
 *
 * {@link useSyncExternalStore} compares snapshots by identity, so re-reading storage on
 * every render would loop forever. The snapshot is therefore cached until something
 * invalidates it.
 */
let cachedPreferences: Preferences | null = null;

/**
 * The current preferences, re-read only when the cache has been invalidated.
 *
 * @returns The stored preferences, stable by identity between changes.
 */
function preferencesSnapshot(): Preferences {
  if (!cachedPreferences) cachedPreferences = readPreferences();
  return cachedPreferences;
}

/** Force the next {@link preferencesSnapshot} to go back to storage. */
function invalidatePreferences(): void {
  cachedPreferences = null;
}

/**
 * The value the server renders, and the value the client hydrates with.
 *
 * @returns The defaults — storage is a device fact the server cannot know.
 */
function serverPreferencesSnapshot(): Preferences {
  return DEFAULT_PREFERENCES;
}

/**
 * Subscribe to preference changes, from this tab or another one.
 *
 * The cache is dropped on subscribe because storage may have moved on while nothing was
 * listening — a second tab, or simply the last time the app was open.
 *
 * @param listener Called whenever the stored preferences may have changed.
 * @returns The unsubscribe function.
 */
function subscribePreferences(listener: () => void): () => void {
  invalidatePreferences();

  const handleStorage = (event: StorageEvent) => {
    // `key === null` is `localStorage.clear()`, which resets every preference at once.
    if (event.key !== null && !CANONICAL_KEYS.has(event.key)) return;
    invalidatePreferences();
    listener();
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(PREFERENCES_EVENT, listener);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(PREFERENCES_EVENT, listener);
  };
}

/**
 * Whether the OS currently asks for reduced motion.
 *
 * @returns `true` when `(prefers-reduced-motion: reduce)` matches; `false` where the query
 *          cannot be asked at all.
 */
function reducedMotionSnapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

/**
 * The value the server renders: no preference, because there is nobody to ask.
 *
 * @returns `false`.
 */
function serverReducedMotionSnapshot(): boolean {
  return false;
}

/**
 * Subscribe to the operating-system motion preference, which can change while the app is
 * open (macOS and Windows both allow it).
 *
 * @param listener Called when the OS preference changes.
 * @returns The unsubscribe function.
 */
function subscribeReducedMotion(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};

  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

interface PreferencesContextType {
  /** The current values. */
  preferences: Preferences;
  /**
   * Whether motion should be suppressed right now — the stored preference *or* the OS
   * setting. CSS honours both on its own; this is for the JS-driven animations no
   * stylesheet can reach.
   */
  prefersReducedMotion: boolean;
  /** Set one preference; persists and applies immediately. */
  setPreference: <K extends PreferenceKey>(key: K, value: Preferences[K]) => void;
  /** Set the root font-size step. */
  setFontScale: (value: FontScaleId) => void;
  /** Set the spacing scale. */
  setDensity: (value: DensityId) => void;
  /** Set whether the interface animates. */
  setMotion: (value: MotionId) => void;
  /** Set the sidebar start state. */
  setRail: (value: RailId) => void;
  /** Flip the sidebar between expanded and collapsed. */
  toggleRail: () => void;
  /** Set whether ids, hashes and versions render in the monospace face. */
  setMonoIds: (value: ToggleId) => void;
  /** Set whether shortcut chips are shown. */
  setKbdHints: (value: ToggleId) => void;
}

const PreferencesContext = createContext<PreferencesContextType | undefined>(undefined);

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const preferences = useSyncExternalStore(
    subscribePreferences,
    preferencesSnapshot,
    serverPreferencesSnapshot,
  );
  const osReducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    reducedMotionSnapshot,
    serverReducedMotionSnapshot,
  );

  // Keep `<html>` in step with the store. The boot script has already written these once,
  // so the first pass is a no-op that costs four attribute writes and leaves this provider
  // as the single explanation for what is on the element.
  useEffect(() => {
    applyPreferences(document.documentElement, preferences);
  }, [preferences]);

  // Rewrite whatever was resolved under the canonical `hive.*` keys — which is what
  // migrates a setting off `apiome.sidebar.density`. Once per mount: the boot script is
  // deliberately read-only, so this is the first write of the page's life.
  useEffect(() => {
    persistPreferences(readPreferences());
  }, []);

  /**
   * Set one preference.
   *
   * The write goes to storage and the store notifies itself, rather than this updating a
   * copy in React state: storage is the source of truth, and every tab reads the same one.
   *
   * @param key Which preference to set.
   * @param value The new value.
   */
  const setPreference = useCallback(<K extends PreferenceKey>(key: K, value: Preferences[K]) => {
    writePreference(key, value);
    invalidatePreferences();
    window.dispatchEvent(new Event(PREFERENCES_EVENT));
  }, []);

  const value = useMemo<PreferencesContextType>(
    () => ({
      preferences,
      prefersReducedMotion: preferences.motion === 'reduce' || osReducedMotion,
      setPreference,
      setFontScale: (fontScale: FontScaleId) => setPreference('fontScale', fontScale),
      setDensity: (density: DensityId) => setPreference('density', density),
      setMotion: (motion: MotionId) => setPreference('motion', motion),
      setRail: (rail: RailId) => setPreference('rail', rail),
      toggleRail: () =>
        setPreference('rail', preferences.rail === 'collapsed' ? 'expanded' : 'collapsed'),
      setMonoIds: (monoIds: ToggleId) => setPreference('monoIds', monoIds),
      setKbdHints: (kbdHints: ToggleId) => setPreference('kbdHints', kbdHints),
    }),
    [preferences, osReducedMotion, setPreference],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

/**
 * Read the current preferences.
 *
 * @returns The preferences context.
 * @throws If called outside a `PreferencesProvider`.
 */
export function usePreferences(): PreferencesContextType {
  const context = useContext(PreferencesContext);
  if (context === undefined) {
    throw new Error('usePreferences must be used within a PreferencesProvider');
  }
  return context;
}

/**
 * Whether a {@link PreferencesProvider} is mounted above this component.
 *
 * @returns `true` when {@link usePreferences} would succeed here.
 */
export function useHasPreferences(): boolean {
  return useContext(PreferencesContext) !== undefined;
}

/**
 * Guarantee a {@link PreferencesProvider} above `children`, mounting one only if the tree
 * does not already have it.
 *
 * The preferences pane (HIVE-1.4) is mounted by this app under its root layout — where the
 * provider always is — *and* by the commercial Studio's own top bar, under a layout of its
 * own, where it may not be. Rather than make every host remember, the pane brings the
 * provider with it.
 *
 * Nesting is harmless when it happens: `localStorage` is the source of truth, the snapshot
 * cache and the change event are module-level, and both instances write the same four
 * attributes to the same `<html>` — so two providers cannot disagree, they can only agree
 * twice.
 *
 * @param props.children The subtree that needs {@link usePreferences}.
 */
export function PreferencesBoundary({ children }: { children: React.ReactNode }) {
  // Constant for the life of this component: a provider does not appear above an already
  // mounted child, so the branch cannot change between renders.
  const hasProvider = useHasPreferences();
  if (hasProvider) return <>{children}</>;
  return <PreferencesProvider>{children}</PreferencesProvider>;
}
