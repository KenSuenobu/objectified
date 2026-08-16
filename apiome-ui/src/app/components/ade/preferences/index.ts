/**
 * The preferences pane (HIVE-1.4, #5277).
 *
 * A surface needs two things from here: {@link PreferencesDrawerHost}, mounted once in the
 * shell, and `openPreferences()`, called from whatever offers the entry point.
 */

export { default as PreferencesDrawerHost } from './PreferencesDrawerHost';
export {
  isPreferencesDrawerMounted,
  openPreferences,
  registerPreferencesDrawerHost,
} from './preferencesDrawerBus';
export {
  SHELL_SHORTCUTS,
  SURFACE_SHORTCUTS,
  matchesPreferencesShortcut,
  type ShortcutEntry,
} from './shortcuts';
