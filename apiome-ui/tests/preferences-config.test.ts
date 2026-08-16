/**
 * Device-preference contract — `src/app/config/preferences.ts` (HIVE-1.3, #5276).
 *
 * Two consumers depend on these rules and cannot be allowed to drift: the provider, which
 * runs after hydration, and the blocking boot script, which runs before first paint. This
 * suite therefore checks the rules *and* runs the generated script against a real
 * document, so "the script does what the module says" is a test rather than a comment.
 *
 * The vocabulary itself is re-derived from `docs/mockups/DESIGN.md` §4.1 — the design
 * authority — rather than restated here, so a change to the design fails the build instead
 * of quietly disagreeing with the code.
 */

import { readFileSync } from 'node:fs';
import {
  DEFAULT_PREFERENCES,
  DENSITIES,
  FONT_SCALES,
  LEGACY_PREFERENCE_KEYS,
  LEGACY_THEME_KEYS,
  MOTIONS,
  PREFERENCE_ATTRIBUTES,
  PREFERENCE_STORAGE_KEYS,
  PREFERENCE_VALUES,
  RAILS,
  THEME_STORAGE_KEY,
  applyPreferences,
  normalizePreference,
  persistPreferences,
  preferencesBootScript,
  readPreference,
  readPreferences,
  readStoredThemeChoice,
  storeThemeChoice,
  writePreference,
  type PreferenceKey,
} from '../src/app/config/preferences';
import { DESIGN_DOC_PATH } from './helpers/design-tokens';

/** §4.1 of the design document — the authority for the preference vocabulary. */
const designPane = (() => {
  const markdown = readFileSync(DESIGN_DOC_PATH, 'utf8');
  const section = /###\s*4\.1[^\n]*\n([\s\S]*?)\n###\s/.exec(markdown);
  if (!section) throw new Error('DESIGN.md has no §4.1 preferences section');
  return section[1];
})();

/** Install a `matchMedia` jsdom does not implement. */
function mockMatchMedia(matching: (query: string) => boolean): void {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: matching(query),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

/** Run the generated boot script the way the browser would. */
function runBootScript(): void {
  new Function(preferencesBootScript())();
}

/** The element every preference is applied to. */
const html = () => document.documentElement;

/** Every attribute the module owns, so a test can prove a clean slate. */
const OWNED_ATTRIBUTES = [
  ...Object.values(PREFERENCE_ATTRIBUTES),
  'data-theme',
  'data-theme-choice',
];

beforeEach(() => {
  localStorage.clear();
  OWNED_ATTRIBUTES.forEach((attribute) => html().removeAttribute(attribute));
  html().removeAttribute('style');
  mockMatchMedia(() => false);
});

describe('the vocabulary matches DESIGN.md §4.1', () => {
  it('offers exactly the six font-size stops the slider specifies', () => {
    // e.g. `xs 14 · sm 15 · md 16 · lg 17 · xl 18 · 2xl 20 px`
    const slider = /`((?:[a-z0-9]+ \d+ · )+[a-z0-9]+ \d+ px)`/.exec(designPane);
    expect(slider).not.toBeNull();

    const specified = slider![1]
      .split('·')
      .map((stop) => stop.trim().replace(/ px$/, '').split(' '))
      .map(([id, px]) => ({ id, px: Number(px) }));

    expect(FONT_SCALES.map(({ id, px }) => ({ id, px }))).toEqual(specified);
  });

  it('expresses each stop as a percentage of the 16 px browser default', () => {
    // A percentage keeps the reader's own browser font size in play; a `px` root would
    // silently discard it.
    FONT_SCALES.forEach((scale) => {
      expect(scale.rootPercent).toBeCloseTo((scale.px / 16) * 100, 5);
    });
  });

  it('offers the two density steps, comfortable first', () => {
    expect(designPane).toContain('**Comfortable / Compact**');
    expect(DENSITIES.map((density) => density.id)).toEqual(['comfortable', 'compact']);
  });

  it('persists under the `hive.*` keys the design names', () => {
    const named = new Set([...designPane.matchAll(/`(hive\.[A-Za-z]+)`/g)].map((m) => m[1]));

    expect(named).toContain(THEME_STORAGE_KEY);
    Object.values(PREFERENCE_STORAGE_KEYS).forEach((key) => expect(named).toContain(key));
  });

  it('keeps the pre-Hive keys readable so nobody loses a setting', () => {
    expect(designPane).toContain('app-theme');
    expect(LEGACY_THEME_KEYS).toEqual(['app-theme', 'theme']);
    expect(LEGACY_PREFERENCE_KEYS.density).toEqual(['apiome.sidebar.density']);
  });

  it('describes every option, so the preferences pane needs no copy of its own', () => {
    [...FONT_SCALES, ...DENSITIES, ...MOTIONS, ...RAILS].forEach((option) => {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    });
  });

  it('applies each preference as its own `<html>` attribute', () => {
    expect(PREFERENCE_ATTRIBUTES).toEqual({
      fontScale: 'data-font-scale',
      density: 'data-density',
      motion: 'data-motion',
      rail: 'data-rail',
    });
  });

  it('defaults to the middle scale, comfortable, animated and expanded', () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      fontScale: 'md',
      density: 'comfortable',
      motion: 'auto',
      rail: 'expanded',
    });
    (Object.keys(DEFAULT_PREFERENCES) as PreferenceKey[]).forEach((key) => {
      expect(PREFERENCE_VALUES[key]).toContain(DEFAULT_PREFERENCES[key]);
    });
  });
});

describe('normalising a stored value', () => {
  it('accepts every value the picker offers', () => {
    (Object.keys(PREFERENCE_VALUES) as PreferenceKey[]).forEach((key) => {
      PREFERENCE_VALUES[key].forEach((value) => {
        expect(normalizePreference(key, value)).toBe(value);
      });
    });
  });

  it('folds the legacy sidebar `standard` step onto comfortable', () => {
    // The pre-Hive toggle had three steps and defaulted to the middle one; folding it
    // upward never tightens a shell the user did not ask to tighten.
    expect(normalizePreference('density', 'standard')).toBe('comfortable');
    expect(normalizePreference('density', 'compact')).toBe('compact');
    expect(normalizePreference('density', 'comfortable')).toBe('comfortable');
  });

  it('treats an unrecognised value as "not set"', () => {
    // A stale write, or a downgrade from a build with more steps, must not leave the
    // shell in a state no stylesheet block matches.
    expect(normalizePreference('fontScale', '3xl')).toBeUndefined();
    expect(normalizePreference('motion', 'off')).toBeUndefined();
    expect(normalizePreference('rail', '')).toBeUndefined();
    expect(normalizePreference('density', null)).toBeUndefined();
    expect(normalizePreference('density', undefined)).toBeUndefined();
  });
});

describe('reading what a device stored', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads each preference from its canonical key', () => {
    localStorage.setItem('hive.fontScale', 'xl');
    localStorage.setItem('hive.density', 'compact');
    localStorage.setItem('hive.motion', 'reduce');
    localStorage.setItem('hive.rail', 'collapsed');

    expect(readPreferences()).toEqual({
      fontScale: 'xl',
      density: 'compact',
      motion: 'reduce',
      rail: 'collapsed',
    });
  });

  it('falls back to the legacy sidebar density key', () => {
    localStorage.setItem('apiome.sidebar.density', 'compact');

    expect(readPreference('density')).toBe('compact');
  });

  it('prefers the canonical key over the legacy one', () => {
    localStorage.setItem('hive.density', 'comfortable');
    localStorage.setItem('apiome.sidebar.density', 'compact');

    expect(readPreference('density')).toBe('comfortable');
  });

  it('skips a corrupt canonical value rather than applying it', () => {
    localStorage.setItem('hive.density', 'roomy');
    localStorage.setItem('apiome.sidebar.density', 'compact');

    expect(readPreference('density')).toBe('compact');
  });

  it('survives storage being unreadable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        // Private-mode Safari and hardened browsers throw on access.
        throw new Error('SecurityError');
      },
    });

    try {
      expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
      expect(() => writePreference('density', 'compact')).not.toThrow();
      expect(readStoredThemeChoice()).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('writing preferences back', () => {
  it('writes one preference under its canonical key', () => {
    writePreference('fontScale', '2xl');

    expect(localStorage.getItem('hive.fontScale')).toBe('2xl');
  });

  it('rewrites a legacy-keyed setting under the new name', () => {
    localStorage.setItem('apiome.sidebar.density', 'compact');

    persistPreferences(readPreferences());

    expect(localStorage.getItem('hive.density')).toBe('compact');
    // The legacy key is left alone: the sidebars that still read it keep working.
    expect(localStorage.getItem('apiome.sidebar.density')).toBe('compact');
  });

  it('stores every preference, so a later read needs no fallback', () => {
    persistPreferences({
      fontScale: 'sm',
      density: 'compact',
      motion: 'reduce',
      rail: 'collapsed',
    });

    expect(Object.values(PREFERENCE_STORAGE_KEYS).map((key) => localStorage.getItem(key))).toEqual([
      'sm',
      'compact',
      'reduce',
      'collapsed',
    ]);
  });
});

describe('the theme choice shares the same storage rules', () => {
  it('reads the canonical key first, then the pre-Hive ones in order', () => {
    localStorage.setItem('theme', 'dark');
    expect(readStoredThemeChoice()).toBe('dark');

    localStorage.setItem('app-theme', 'nord');
    expect(readStoredThemeChoice()).toBe('nord');

    localStorage.setItem('hive.theme', 'solarized');
    expect(readStoredThemeChoice()).toBe('solarized');
  });

  it('reports "never chosen" rather than a guess', () => {
    expect(readStoredThemeChoice()).toBeUndefined();
  });

  it('mirrors a choice to `app-theme` for tabs still on the previous build', () => {
    storeThemeChoice('nord');

    expect(localStorage.getItem('hive.theme')).toBe('nord');
    expect(localStorage.getItem('app-theme')).toBe('nord');
  });
});

describe('applying preferences to an element', () => {
  it('writes all four attributes and nothing else', () => {
    applyPreferences(html(), {
      fontScale: 'lg',
      density: 'compact',
      motion: 'reduce',
      rail: 'collapsed',
    });

    expect(html().getAttribute('data-font-scale')).toBe('lg');
    expect(html().getAttribute('data-density')).toBe('compact');
    expect(html().getAttribute('data-motion')).toBe('reduce');
    expect(html().getAttribute('data-rail')).toBe('collapsed');
    expect(html().getAttribute('data-theme')).toBeNull();
  });
});

describe('the blocking boot script', () => {
  it('applies the defaults when the device has stored nothing', () => {
    runBootScript();

    expect(html().getAttribute('data-font-scale')).toBe('md');
    expect(html().getAttribute('data-density')).toBe('comfortable');
    expect(html().getAttribute('data-motion')).toBe('auto');
    expect(html().getAttribute('data-rail')).toBe('expanded');
  });

  it('applies exactly what the module would read — canonical, legacy and corrupt alike', () => {
    localStorage.setItem('hive.fontScale', 'xl');
    localStorage.setItem('hive.motion', 'sideways');
    localStorage.setItem('apiome.sidebar.density', 'standard');

    runBootScript();
    const stored = readPreferences();

    expect(html().getAttribute('data-font-scale')).toBe(stored.fontScale);
    expect(html().getAttribute('data-density')).toBe(stored.density);
    expect(html().getAttribute('data-motion')).toBe(stored.motion);
    expect(html().getAttribute('data-rail')).toBe(stored.rail);
    expect(stored).toEqual({
      fontScale: 'xl',
      density: 'comfortable',
      motion: 'auto',
      rail: 'expanded',
    });
  });

  it('paints the stored theme before first paint, resolved and never `system`', () => {
    localStorage.setItem('app-theme', 'system');
    mockMatchMedia((query) => query.includes('dark'));

    runBootScript();

    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(html().getAttribute('data-theme-choice')).toBe('system');
    expect(html().style.colorScheme).toBe('dark');
  });

  it('resolves "follow system" to light when the OS asks for light', () => {
    runBootScript();

    expect(html().getAttribute('data-theme')).toBe('light');
    expect(html().getAttribute('data-theme-choice')).toBe('system');
    expect(html().style.colorScheme).toBe('light');
  });

  it('carries a named theme through, with the colour scheme its palette paints on', () => {
    localStorage.setItem('hive.theme', 'nord');

    runBootScript();

    expect(html().getAttribute('data-theme')).toBe('nord');
    expect(html().getAttribute('data-theme-choice')).toBe('nord');
    expect(html().style.colorScheme).toBe('dark');
  });

  it('ignores a theme id that no longer exists', () => {
    localStorage.setItem('hive.theme', 'midnight-commander');

    runBootScript();

    expect(html().getAttribute('data-theme')).toBe('light');
    expect(html().getAttribute('data-theme-choice')).toBe('system');
  });

  it('renders the shell rather than throwing when storage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });

    try {
      expect(() => runBootScript()).not.toThrow();
      expect(html().getAttribute('data-font-scale')).toBe('md');
      expect(html().getAttribute('data-theme')).toBe('light');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('runs on a browser without `matchMedia`', () => {
    const original = window.matchMedia;
    // @ts-expect-error — deleting the API is exactly what the guard exists for.
    delete window.matchMedia;

    try {
      expect(() => runBootScript()).not.toThrow();
      expect(html().getAttribute('data-theme')).toBe('light');
    } finally {
      window.matchMedia = original;
    }
  });

  it('cannot close its own `<script>` element', () => {
    const source = preferencesBootScript();
    const payload = source.slice(
      source.indexOf('var c=') + 'var c='.length,
      source.indexOf(',r=document.documentElement'),
    );

    // The HTML parser ends a script at the first `</script`, string literal or not, so the
    // embedded data carries no raw `<` at all. (The script's own `i<keys.length` is safe:
    // only the closing sequence matters.)
    expect(source).not.toContain('</');
    expect(payload).not.toContain('<');
    expect(JSON.parse(payload.replace(/\\u003c/g, '<')).prefs).toHaveLength(4);
  });

  it('stays small enough to sit on the critical path', () => {
    expect(preferencesBootScript().length).toBeLessThan(2048);
  });

  it('writes nothing: a blocking script must not pay for a storage write', () => {
    localStorage.setItem('apiome.sidebar.density', 'compact');

    runBootScript();

    // The provider performs the migration write-back once it mounts.
    expect(localStorage.getItem('hive.density')).toBeNull();
  });
});
