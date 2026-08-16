/**
 * Device-local UI preferences (HIVE-1.3, #5276).
 *
 * Theme answers *which palette*; this module answers everything else the user can tune
 * about the shell — how large the interface is, how tightly it packs, whether it animates
 * and whether the sidebar starts collapsed (`docs/mockups/DESIGN.md` §4.1). Each is an
 * attribute on `<html>` that `globals.css` reacts to, so a preference is a token swap in
 * exactly the way a theme is, and no component has to read a setting to look right:
 *
 * | Preference  | Attribute          | Values                        | Storage key      |
 * | ----------- | ------------------ | ----------------------------- | ---------------- |
 * | `fontScale` | `data-font-scale`  | `xs sm md lg xl 2xl`          | `hive.fontScale` |
 * | `density`   | `data-density`     | `comfortable` \| `compact`    | `hive.density`   |
 * | `motion`    | `data-motion`      | `auto` \| `reduce`            | `hive.motion`    |
 * | `rail`      | `data-rail`        | `expanded` \| `collapsed`     | `hive.rail`      |
 * | `monoIds`   | `data-mono-ids`    | `on` \| `off`                 | `hive.monoIds`   |
 * | `kbdHints`  | `data-kbd-hints`   | `on` \| `off`                 | `hive.kbdHints`  |
 *
 * Everything here is a pure function of its arguments or a thin, failure-tolerant wrapper
 * over `localStorage`, so `PreferencesProvider` stays a DOM writer and the rules can be
 * tested without a browser. Two consumers share these definitions and must not drift:
 *
 *   • {@link PreferencesProvider} — after hydration, for reads, writes and live updates.
 *   • {@link preferencesBootScript} — a blocking `<head>` script that applies the same
 *     attributes *before first paint*, which is what stops the flash of default theme and
 *     scale on a hard reload. It is generated from the constants below rather than
 *     hand-written, so it cannot fall behind them.
 *
 * Storage is read through legacy aliases (`app-theme`, `theme`,
 * `apiome.sidebar.density`) so an existing install keeps its settings; the provider then
 * rewrites them under the `hive.*` names on mount.
 */

import { DARK_THEME_ID, LIGHT_THEME_ID, SYSTEM_THEME_ID, themes } from './themes';

/* ==========================================================================
   Vocabulary
   ========================================================================== */

/** Root font-size steps offered by the font-size slider. */
export type FontScaleId = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/** How tightly the shell packs rows, controls and page padding. */
export type DensityId = 'comfortable' | 'compact';

/** Whether the interface animates. */
export type MotionId = 'auto' | 'reduce';

/** Whether the sidebar starts expanded or as an icon rail. */
export type RailId = 'expanded' | 'collapsed';

/**
 * A preference that is simply on or off.
 *
 * Spelled as a two-value vocabulary rather than a boolean so it travels through the same
 * machinery as every other preference: one `<html>` attribute, one stored string, and one
 * CSS block per non-default value. Nothing has to know which preferences are toggles.
 */
export type ToggleId = 'on' | 'off';

/** One selectable value, with the copy the preferences pane renders for it. */
export interface PreferenceOption<T extends string> {
  /** Stable id, written to the `<html>` attribute and to `localStorage`. */
  id: T;
  /** Human-readable label. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
}

/** One stop on the font-size slider. */
export interface FontScale extends PreferenceOption<FontScaleId> {
  /** Resulting root font size, in CSS pixels, on a browser at its 16 px default. */
  px: number;
  /**
   * Root `font-size` as a percentage of the browser default.
   *
   * A percentage rather than a `px` value on purpose: it keeps the browser's own
   * font-size setting in play, and because every dimension in the token layer is `rem`,
   * the *whole* interface scales — rail, tables, dialogs and body copy together.
   */
  rootPercent: number;
}

/** The six font-size stops (DESIGN.md §4.1, ported from `hive.css` §3). */
export const FONT_SCALES: readonly FontScale[] = [
  { id: 'xs', label: 'Small', description: '14 px base', px: 14, rootPercent: 87.5 },
  { id: 'sm', label: 'Compact', description: '15 px base', px: 15, rootPercent: 93.75 },
  { id: 'md', label: 'Default', description: '16 px base', px: 16, rootPercent: 100 },
  { id: 'lg', label: 'Large', description: '17 px base', px: 17, rootPercent: 106.25 },
  { id: 'xl', label: 'Larger', description: '18 px base', px: 18, rootPercent: 112.5 },
  { id: '2xl', label: 'Largest', description: '20 px base', px: 20, rootPercent: 125 },
];

/** The two density steps (DESIGN.md §3.3). */
export const DENSITIES: readonly PreferenceOption<DensityId>[] = [
  {
    id: 'comfortable',
    label: 'Comfortable',
    description: 'Roomier rows, controls and page padding.',
  },
  {
    id: 'compact',
    label: 'Compact',
    description: 'Tighter spacing; more rows on screen.',
  },
];

/**
 * The motion settings (DESIGN.md §3.4).
 *
 * `auto` defers to `prefers-reduced-motion`, which the stylesheet honours on its own;
 * `reduce` is the stronger statement that this device wants none regardless.
 */
export const MOTIONS: readonly PreferenceOption<MotionId>[] = [
  {
    id: 'auto',
    label: 'Follow system',
    description: 'Animate menus, dialogs and the rail, unless the system asks for less.',
  },
  {
    id: 'reduce',
    label: 'Reduce motion',
    description: 'Turn off transitions and animated progress.',
  },
];

/** The sidebar start states (DESIGN.md §5.2). */
export const RAILS: readonly PreferenceOption<RailId>[] = [
  {
    id: 'expanded',
    label: 'Expanded',
    description: 'Show the sidebar with labels.',
  },
  {
    id: 'collapsed',
    label: 'Collapsed',
    description: 'Start with the icon rail; hover to peek labels.',
  },
];

/** The two states of every {@link ToggleId} preference, "on" first. */
export const TOGGLES: readonly PreferenceOption<ToggleId>[] = [
  { id: 'on', label: 'On', description: 'Enabled.' },
  { id: 'off', label: 'Off', description: 'Disabled.' },
];

/** Every device-local preference this provider owns. */
export interface Preferences {
  /** Root font-size step. */
  fontScale: FontScaleId;
  /** Spacing scale. */
  density: DensityId;
  /** Whether the interface animates. */
  motion: MotionId;
  /** Sidebar start state. */
  rail: RailId;
  /** Whether ids, hashes and versions render in the monospace face. */
  monoIds: ToggleId;
  /** Whether shortcut chips are shown on buttons and menus. */
  kbdHints: ToggleId;
}

/** A preference name — the key of {@link Preferences}. */
export type PreferenceKey = keyof Preferences;

/** What a device gets before it has chosen anything; also the SSR render. */
export const DEFAULT_PREFERENCES: Readonly<Preferences> = {
  fontScale: 'md',
  density: 'comfortable',
  motion: 'auto',
  rail: 'expanded',
  monoIds: 'on',
  kbdHints: 'on',
};

/** The `<html>` attribute each preference is applied as. */
export const PREFERENCE_ATTRIBUTES: Readonly<Record<PreferenceKey, string>> = {
  fontScale: 'data-font-scale',
  density: 'data-density',
  motion: 'data-motion',
  rail: 'data-rail',
  monoIds: 'data-mono-ids',
  kbdHints: 'data-kbd-hints',
};

/** The canonical `localStorage` key each preference is written to. */
export const PREFERENCE_STORAGE_KEYS: Readonly<Record<PreferenceKey, string>> = {
  fontScale: 'hive.fontScale',
  density: 'hive.density',
  motion: 'hive.motion',
  rail: 'hive.rail',
  monoIds: 'hive.monoIds',
  kbdHints: 'hive.kbdHints',
};

/**
 * Keys written by earlier builds, consulted in order when the canonical key is absent.
 *
 * `apiome.sidebar.density` is the three-step scale of `SidebarDensityToggle`, which
 * predates this provider and still drives the legacy sidebars; its values are folded onto
 * the two Hive steps by {@link PREFERENCE_VALUE_ALIASES}.
 */
export const LEGACY_PREFERENCE_KEYS: Readonly<Record<PreferenceKey, readonly string[]>> = {
  fontScale: [],
  density: ['apiome.sidebar.density'],
  motion: [],
  rail: [],
  monoIds: [],
  kbdHints: [],
};

/** The values each preference accepts, in picker order. */
export const PREFERENCE_VALUES: Readonly<Record<PreferenceKey, readonly string[]>> = {
  fontScale: FONT_SCALES.map((scale) => scale.id),
  density: DENSITIES.map((density) => density.id),
  motion: MOTIONS.map((motion) => motion.id),
  rail: RAILS.map((rail) => rail.id),
  monoIds: TOGGLES.map((toggle) => toggle.id),
  kbdHints: TOGGLES.map((toggle) => toggle.id),
};

/**
 * Stored spellings that are not values themselves but map onto one.
 *
 * The legacy sidebar scale has a middle step Hive does not: `standard` was its default, so
 * it folds onto `comfortable` rather than tightening a shell the user never asked to
 * tighten.
 */
export const PREFERENCE_VALUE_ALIASES: Readonly<
  Record<PreferenceKey, Readonly<Record<string, string>>>
> = {
  fontScale: {},
  density: { standard: 'comfortable' },
  motion: {},
  rail: {},
  monoIds: {},
  kbdHints: {},
};

/* ==========================================================================
   Pane vocabulary
   ========================================================================== */

/**
 * One switch row in the preferences pane (`DESIGN.md` §4.1, item 4).
 *
 * Four of the preferences above have exactly two states, and the pane renders all four
 * the same way. Describing them here — rather than branching per row in the component —
 * is what keeps "which preference does this switch set, and which way round" a data
 * question: the pane maps over this list and never names a preference itself.
 *
 * `on`/`off` are the *stored* values, not the switch position: "Reduce motion" is on when
 * `motion` is `reduce`, and "Collapse sidebar by default" is on when `rail` is
 * `collapsed`, so neither reads as a double negative in the pane.
 */
export interface SwitchPreference {
  /** Which preference the row sets. */
  key: PreferenceKey;
  /** Row title, as the design document spells it. */
  title: string;
  /** One-line explanation shown under the title. */
  description: string;
  /** The value stored when the switch is on. */
  on: string;
  /** The value stored when the switch is off. */
  off: string;
}

/** The four switch rows, in the order `DESIGN.md` §4.1 lists them. */
export const SWITCH_PREFERENCES: readonly SwitchPreference[] = [
  {
    key: 'motion',
    title: 'Reduce motion',
    description: 'Turn off transitions and animated progress.',
    on: 'reduce',
    off: 'auto',
  },
  {
    key: 'rail',
    title: 'Collapse sidebar by default',
    description: 'Start with the icon rail; hover to peek labels.',
    on: 'collapsed',
    off: 'expanded',
  },
  {
    key: 'monoIds',
    title: 'Monospace for identifiers',
    description: 'Render ids, hashes and versions in JetBrains Mono.',
    on: 'on',
    off: 'off',
  },
  {
    key: 'kbdHints',
    title: 'Show keyboard hints',
    description: 'Display shortcut chips on buttons and menus.',
    on: 'on',
    off: 'off',
  },
];

/**
 * Look up a font-size stop by id.
 *
 * @param id The stop id.
 * @returns The stop, or the `md` default when the id is unknown — the slider always has a
 *          position, even against a value written by a build with different stops.
 */
export function fontScaleById(id: string): FontScale {
  return (
    FONT_SCALES.find((scale) => scale.id === id) ??
    FONT_SCALES.find((scale) => scale.id === DEFAULT_PREFERENCES.fontScale)!
  );
}

/**
 * The slider position of a font-size stop.
 *
 * @param id The stop id.
 * @returns Its index in {@link FONT_SCALES}, or the default stop's index when unknown.
 */
export function fontScaleIndexOf(id: string): number {
  const index = FONT_SCALES.findIndex((scale) => scale.id === id);
  return index === -1 ? FONT_SCALES.findIndex((scale) => scale.id === DEFAULT_PREFERENCES.fontScale) : index;
}

/** Canonical key holding the theme choice, `system` included. */
export const THEME_STORAGE_KEY = 'hive.theme';

/**
 * Theme keys written by earlier builds, consulted in order.
 *
 * `app-theme` is the pre-Hive choice key; `theme` is next-themes' own, which is all an
 * install that predates `ThemeProvider` has.
 */
export const LEGACY_THEME_KEYS: readonly string[] = ['app-theme', 'theme'];

/* ==========================================================================
   Reading and writing
   ========================================================================== */

/**
 * Read one `localStorage` key, tolerating storage being unavailable.
 *
 * Private-mode Safari and hardened browsers throw on access rather than returning `null`.
 *
 * @param key Storage key.
 * @returns The stored string, or `null` when absent or unreadable.
 */
function readKey(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Write one `localStorage` key, ignoring failures.
 *
 * A preference that cannot be persisted still applies for this session, which is a better
 * outcome than an exception escaping a render.
 *
 * @param key Storage key.
 * @param value Value to store.
 */
function writeKey(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the preference still applies until the tab closes.
  }
}

/**
 * Coerce a stored string to a valid value for a preference.
 *
 * @param key Which preference the value belongs to.
 * @param raw The stored string, or `null`/`undefined` when nothing is stored.
 * @returns The valid value, or `undefined` when `raw` is absent or unrecognised — an
 *          unrecognised value is treated as "not set" so a stale write, or a downgrade
 *          from a build with more steps, cannot leave the shell in a state no CSS block
 *          matches.
 */
export function normalizePreference<K extends PreferenceKey>(
  key: K,
  raw: string | null | undefined,
): Preferences[K] | undefined {
  if (raw == null) return undefined;
  const candidate = PREFERENCE_VALUE_ALIASES[key][raw] ?? raw;
  return PREFERENCE_VALUES[key].includes(candidate) ? (candidate as Preferences[K]) : undefined;
}

/**
 * Read one preference, falling back through its legacy keys.
 *
 * @param key Which preference to read.
 * @returns The stored value, or the default when nothing valid is stored.
 */
export function readPreference<K extends PreferenceKey>(key: K): Preferences[K] {
  for (const storageKey of [PREFERENCE_STORAGE_KEYS[key], ...LEGACY_PREFERENCE_KEYS[key]]) {
    const value = normalizePreference(key, readKey(storageKey));
    if (value !== undefined) return value;
  }
  return DEFAULT_PREFERENCES[key];
}

/**
 * Read every preference this device has stored.
 *
 * Read-only by design: it runs inside the blocking boot script, where a synchronous write
 * would be paid before first paint. The provider persists what this returns on mount,
 * which is what completes the migration off the legacy keys.
 *
 * @returns The stored preferences, with defaults filling any gap.
 */
export function readPreferences(): Preferences {
  return {
    fontScale: readPreference('fontScale'),
    density: readPreference('density'),
    motion: readPreference('motion'),
    rail: readPreference('rail'),
    monoIds: readPreference('monoIds'),
    kbdHints: readPreference('kbdHints'),
  };
}

/**
 * Persist one preference under its canonical key.
 *
 * @param key Which preference to write.
 * @param value The value to store.
 */
export function writePreference<K extends PreferenceKey>(key: K, value: Preferences[K]): void {
  writeKey(PREFERENCE_STORAGE_KEYS[key], value);
}

/**
 * Persist every preference under the canonical `hive.*` keys.
 *
 * Called once on mount with whatever {@link readPreferences} resolved, which rewrites a
 * legacy-keyed setting under its new name.
 *
 * @param preferences The values to store.
 */
export function persistPreferences(preferences: Preferences): void {
  (Object.keys(PREFERENCE_STORAGE_KEYS) as PreferenceKey[]).forEach((key) => {
    writeKey(PREFERENCE_STORAGE_KEYS[key], preferences[key]);
  });
}

/**
 * Read the stored theme choice, falling back through the legacy theme keys.
 *
 * @returns The stored choice id — `system` included — or `undefined` when this device has
 *          never chosen one. Validity is the caller's business: the theme catalogue lives
 *          in `./themes`, and keeping this a plain string read is what lets the boot
 *          script share it.
 */
export function readStoredThemeChoice(): string | undefined {
  for (const key of [THEME_STORAGE_KEY, ...LEGACY_THEME_KEYS]) {
    const value = readKey(key);
    if (value) return value;
  }
  return undefined;
}

/**
 * Persist a theme choice under the canonical key, mirroring it to `app-theme`.
 *
 * The mirror is deliberate: `app-theme` is what a tab still running the previous build
 * reads, so a choice made here is not lost when the two are open side by side. It retires
 * with the legacy aliases.
 *
 * @param choiceId The raw choice id, `system` included.
 */
export function storeThemeChoice(choiceId: string): void {
  writeKey(THEME_STORAGE_KEY, choiceId);
  writeKey(LEGACY_THEME_KEYS[0], choiceId);
}

/* ==========================================================================
   Applying
   ========================================================================== */

/**
 * Write the preference attributes onto an element — in practice `<html>`.
 *
 * @param root The element the `globals.css` preference blocks are selected on.
 * @param preferences The values to apply.
 */
export function applyPreferences(root: HTMLElement, preferences: Preferences): void {
  (Object.keys(PREFERENCE_ATTRIBUTES) as PreferenceKey[]).forEach((key) => {
    root.setAttribute(PREFERENCE_ATTRIBUTES[key], preferences[key]);
  });
}

/* ==========================================================================
   Boot script
   ========================================================================== */

/** One preference, reduced to what the boot script needs to resolve it. */
interface BootPreference {
  /** `<html>` attribute to set. */
  attr: string;
  /** Storage keys to try, canonical first. */
  keys: string[];
  /** Accepted values. */
  values: string[];
  /** Stored spellings that map onto a value. */
  aliases: Record<string, string>;
  /** Value used when nothing valid is stored. */
  fallback: string;
}

/** The theme half of the boot payload — enough to resolve a choice to a palette. */
interface BootTheme {
  /** Storage keys to try, canonical first. */
  keys: string[];
  /** Every selectable choice id, `system` included. */
  ids: string[];
  /** Ids of the themes that paint on a dark base, for `color-scheme`. */
  darkIds: string[];
  /** The id that follows the OS. */
  system: string;
  /** What `system` resolves to when the OS asks for light / dark. */
  light: string;
  /** @see light */
  dark: string;
  /** Choice used when nothing valid is stored. */
  fallback: string;
}

/** Everything the boot script is parameterised by. */
interface BootPayload {
  /** One entry per preference, in {@link Preferences} order. */
  prefs: BootPreference[];
  /** Theme resolution inputs. */
  theme: BootTheme;
}

/**
 * Build the data the boot script runs on, from the constants above.
 *
 * @returns The payload, ready to be embedded as JSON.
 */
function bootPayload(): BootPayload {
  const prefs = (Object.keys(PREFERENCE_ATTRIBUTES) as PreferenceKey[]).map((key) => ({
    attr: PREFERENCE_ATTRIBUTES[key],
    keys: [PREFERENCE_STORAGE_KEYS[key], ...LEGACY_PREFERENCE_KEYS[key]],
    values: [...PREFERENCE_VALUES[key]],
    aliases: { ...PREFERENCE_VALUE_ALIASES[key] },
    fallback: DEFAULT_PREFERENCES[key],
  }));

  return {
    prefs,
    theme: {
      keys: [THEME_STORAGE_KEY, ...LEGACY_THEME_KEYS],
      ids: themes.map((theme) => theme.id),
      darkIds: themes.filter((theme) => theme.appearance === 'dark').map((theme) => theme.id),
      system: SYSTEM_THEME_ID,
      light: LIGHT_THEME_ID,
      dark: DARK_THEME_ID,
      fallback: SYSTEM_THEME_ID,
    },
  };
}

/**
 * Serialise a payload for embedding inside a `<script>` element.
 *
 * `<` is escaped because the HTML parser ends a script at the first `</script`, and would
 * do so inside a string literal.
 *
 * @param payload The value to embed.
 * @returns JSON with every `<` written as `<`.
 */
function embed(payload: BootPayload): string {
  return JSON.stringify(payload).replace(/</g, '\\u003c');
}

/**
 * The blocking script that applies theme and preferences before first paint.
 *
 * It runs in `<head>`, ahead of the first style resolution, so the document is painted
 * once — with the right palette and the right root font size — instead of painting the
 * defaults and correcting them after hydration. Everything it touches is cosmetic, so the
 * whole body is wrapped in a `try`: a storage exception must never be the reason a page
 * fails to render.
 *
 * Deliberately read-only. The provider persists and migrates on mount; doing it here
 * would put a synchronous `localStorage` write on the critical path of every navigation.
 *
 * @returns JavaScript source, for `dangerouslySetInnerHTML`.
 */
export function preferencesBootScript(): string {
  return `(function(){try{
var c=${embed(bootPayload())},r=document.documentElement;
function read(keys){for(var i=0;i<keys.length;i++){var v;try{v=window.localStorage.getItem(keys[i]);}catch(e){return null;}if(v!=null&&v!=="")return v;}return null;}
for(var i=0;i<c.prefs.length;i++){var p=c.prefs[i],v=read(p.keys);if(v!=null&&p.aliases[v])v=p.aliases[v];if(p.values.indexOf(v)===-1)v=p.fallback;r.setAttribute(p.attr,v);}
var t=read(c.theme.keys);if(c.theme.ids.indexOf(t)===-1)t=c.theme.fallback;
var s=t;if(t===c.theme.system)s=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?c.theme.dark:c.theme.light;
r.setAttribute("data-theme",s);r.setAttribute("data-theme-choice",t);
r.style.colorScheme=c.theme.darkIds.indexOf(s)===-1?"light":"dark";
}catch(e){}})();`;
}
