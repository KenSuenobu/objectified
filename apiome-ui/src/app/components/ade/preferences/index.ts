/**
 * The preferences pane (HIVE-1.4, #5277).
 *
 * A surface needs two things from here: {@link PreferencesDrawerHost}, mounted once in the
 * shell, and `openPreferences()`, called from whatever offers the entry point.
 *
 * The chords themselves are no longer declared here. Since HIVE-3.7 (#5293) every shortcut
 * in the app is one declaration in `lib/shortcuts.ts`, registered through
 * `src/app/hooks/useShortcuts.ts` by whichever component answers it — this pane's host
 * registers `⌘,` the same way every other owner registers its own.
 */

export { default as PreferencesDrawerHost } from './PreferencesDrawerHost';
export {
  closePreferences,
  isPreferencesDrawerMounted,
  openPreferences,
  registerPreferencesDrawerHost,
} from './preferencesDrawerBus';
export type { PreferencesTabId } from './preferencesDrawerBus';
