/**
 * The launcher's data layer (HIVE-4.5, #5299).
 *
 * `src/app/components/ade/launcher/launcherModel.ts` decides three things the page itself
 * must not: where a host-injected card lands in the grid, what hue it gets when its host
 * declared none or declared nonsense, and how a disabled tile names itself. All three are
 * assertions about *data*, so they are made here rather than through a render.
 */

import {
  accountMenuLabel,
  ANONYMOUS_ACCOUNT_NAME,
  COMMERCIAL_FALLBACK_TONE,
  commercialCardToApp,
  countLabel,
  firstNameOf,
  greetingFor,
  launcherApps,
  launcherItemLabel,
  resolveLauncherTone,
  ANONYMOUS_FIRST_NAME,
} from '../src/app/components/ade/launcher/launcherModel';
import type { ExternalHomeCard } from '../lib/external-links';

/**
 * A home card as the entitlement layer hands one over.
 *
 * @param overrides Fields to change.
 * @returns A complete card.
 */
function homeCard(overrides: Partial<ExternalHomeCard> = {}): ExternalHomeCard {
  return {
    id: 'suite',
    name: 'Designer Suite',
    tagline: 'Design workspace',
    description: 'Schema design and API path modeling in one suite.',
    href: 'https://studio.example.test/',
    enabled: true,
    external: true,
    icon: 'Layers',
    accent: 'from-violet-500 to-fuchsia-600',
    glow: 'group-hover:shadow-fuchsia-500/20',
    ...overrides,
  };
}

describe('launcher grid order', () => {
  it('puts the host-injected cards between Control Panel and the Browser', () => {
    const apps = launcherApps([homeCard(), homeCard({ id: 'developer-suite', enabled: false })]);

    expect(apps.map((app) => app.id)).toEqual([
      'control-panel',
      'suite',
      'developer-suite',
      'browser',
    ]);
  });

  it('is two cards on an install entitled to nothing', () => {
    // The honest picture of an open-source install: no gap, no placeholder, no route into a
    // product the reader cannot reach.
    expect(launcherApps([]).map((app) => app.id)).toEqual(['control-panel', 'browser']);
    expect(launcherApps().map((app) => app.id)).toEqual(['control-panel', 'browser']);
  });

  it('names no commercial route of its own', () => {
    const apps = launcherApps([homeCard({ href: 'https://studio.example.test/editor' })]);

    // The only hrefs this module writes down are the two in-repo ones; everything else came
    // from the card the host injected.
    expect(apps[0].href).toBe('/ade/dashboard');
    expect(apps[1].href).toBe('https://studio.example.test/editor');
    expect(apps[2].external).toBe(true);
    expect(apps[2].id).toBe('browser');
  });

  it('carries the two core cards’ own identity hues', () => {
    const [controlPanel, browser] = launcherApps();
    expect(controlPanel.tone).toBe('accent');
    expect(browser.tone).toBe('ok');
  });
});

describe('a commercial card’s hue', () => {
  it('uses the tone its host declared', () => {
    expect(commercialCardToApp(homeCard({ tone: 'honey' })).tone).toBe('honey');
  });

  it('falls back to the commercial tone when the host declared none', () => {
    expect(commercialCardToApp(homeCard()).tone).toBe(COMMERCIAL_FALLBACK_TONE);
  });

  it('discards a tone outside the vocabulary rather than pasting it into a class', () => {
    // The suite contract crosses a repository boundary, so `tone` is unvalidated input: a
    // typo in another repository must not be able to produce an unstyled card here.
    expect(commercialCardToApp(homeCard({ tone: 'chartreuse' })).tone).toBe(
      COMMERCIAL_FALLBACK_TONE
    );
    expect(resolveLauncherTone(undefined, 'ok')).toBe('ok');
    expect(resolveLauncherTone('', 'ok')).toBe('ok');
    expect(resolveLauncherTone('violet', 'ok')).toBe('violet');
  });

  it('resolves the host’s icon name, falling back rather than rendering nothing', () => {
    expect(commercialCardToApp(homeCard({ icon: 'Layers' })).icon).toBeTruthy();
    expect(commercialCardToApp(homeCard({ icon: 'NotAnIcon' })).icon).toBeTruthy();
  });
});

describe('what a tile calls itself', () => {
  it('offers to open a shipped product', () => {
    expect(launcherItemLabel('Control Panel', true)).toBe('Open Control Panel');
  });

  it('says why an unshipped one cannot be opened', () => {
    // The acceptance criterion verbatim: the 60 % opacity and the chip that carry this
    // visually reach no screen reader.
    expect(launcherItemLabel('Developer Suite', false)).toBe('Developer Suite (coming soon)');
  });
});

describe('the greeting', () => {
  it('follows the reader’s own clock', () => {
    expect(greetingFor(0)).toBe('Good morning');
    expect(greetingFor(11)).toBe('Good morning');
    expect(greetingFor(12)).toBe('Good afternoon');
    expect(greetingFor(16)).toBe('Good afternoon');
    expect(greetingFor(17)).toBe('Good evening');
    expect(greetingFor(23)).toBe('Good evening');
  });

  it('defaults to now, which is the reader’s hour and not the server’s', () => {
    expect(['Good morning', 'Good afternoon', 'Good evening']).toContain(greetingFor());
  });

  it('uses the first word of the display name', () => {
    expect(firstNameOf('Ada Lovelace')).toBe('Ada');
    expect(firstNameOf('  Grace  Hopper ')).toBe('Grace');
  });

  it('falls back for an account with no display name', () => {
    // A credentials account may never have had one.
    expect(firstNameOf(null)).toBe(ANONYMOUS_FIRST_NAME);
    expect(firstNameOf(undefined)).toBe(ANONYMOUS_FIRST_NAME);
    expect(firstNameOf('   ')).toBe(ANONYMOUS_FIRST_NAME);
  });

  it('falls back differently in the account chip, where “there” would read as a bug', () => {
    expect(firstNameOf(null, ANONYMOUS_ACCOUNT_NAME)).toBe('Account');
    expect(firstNameOf('Ada Lovelace', ANONYMOUS_ACCOUNT_NAME)).toBe('Ada');
  });
});

describe('the account chip’s label', () => {
  it('names the reader in full, since the chip only shows one word of it', () => {
    expect(accountMenuLabel('Ada Lovelace')).toBe('Account menu for Ada Lovelace');
  });

  it('promises the menu without a name rather than “Account menu for Account”', () => {
    expect(accountMenuLabel(null)).toBe('Account menu');
    expect(accountMenuLabel('  ')).toBe('Account menu');
  });
});

describe('summary chip counts', () => {
  it('pluralises', () => {
    expect(countLabel(0, 'project')).toBe('0 projects');
    expect(countLabel(1, 'project')).toBe('1 project');
    expect(countLabel(7, 'project')).toBe('7 projects');
  });
});
