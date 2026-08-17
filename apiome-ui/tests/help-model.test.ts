/**
 * What the Help & docs page is made of, checked without a DOM (HIVE-4.9, #5303).
 *
 * `help-page.test.tsx` renders the page; this pins the decisions the page only *draws*:
 *
 *   1. **Every card is a card the markup can express.** A destination has an `href`, a card
 *      that runs something here does not, and an unshipped one says so with a chip. The grid
 *      switches on `kind`, so a card whose kind and fields disagree would render as the wrong
 *      element — a link with nowhere to go, or a button with a destination it never uses.
 *   2. **The support block always says both things.** The ticket's acceptance criterion is
 *      that the card shows the tenant id *and* the build; a session with no workspace still
 *      has to produce a usable block rather than a half-empty one.
 *   3. **The glance strip cannot promise a chord the keyboard does not answer.** It is
 *      derived from the live registry, deduplicated, ordered like the sheet, and it drops a
 *      gated binding rather than printing it without its reason.
 */

import {
  HELP_CARDS,
  NO_TENANT_LABEL,
  SHORTCUT_GLANCE_LIMIT,
  SUPPORT_ISSUE_URL,
  VIDEO_WALKTHROUGHS_URL,
  glanceShortcuts,
  supportDetails,
} from '@/app/components/ade/help/helpModel';
import { STATUS_TONES } from '@/app/components/ui/statusVocabulary';
import type { ShortcutBinding } from '@lib/shortcuts';

/**
 * A binding, with only what the strip reads.
 *
 * @param id Its id, which is also what the sheet's display order is keyed by.
 * @param overrides Anything else the case needs.
 * @returns A global-scope binding.
 */
function binding(id: string, overrides: Partial<ShortcutBinding> = {}): ShortcutBinding {
  return {
    id,
    scope: 'global',
    description: id,
    keys: ['X'],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------
   1. The cards
   ------------------------------------------------------------------------- */

describe('the help cards', () => {
  it('draws the six the mockup draws, in its order', () => {
    expect(HELP_CARDS.map((card) => card.id)).toEqual([
      'get-started',
      'user-guide',
      'api-cli',
      'video',
      'community',
      'support',
    ]);
  });

  it('gives every card a title, a line and a tone from the shared vocabulary', () => {
    for (const card of HELP_CARDS) {
      expect(card.title.trim().length).toBeGreaterThan(0);
      expect(card.description.trim().length).toBeGreaterThan(0);
      expect(STATUS_TONES).toContain(card.tone);
    }
  });

  it('gives a destination to exactly the cards that are destinations', () => {
    for (const card of HELP_CARDS) {
      if (card.kind === 'external') {
        expect(card.href).toMatch(/^https:\/\//);
      } else {
        // A button with an href is a card that would render as the wrong element.
        expect(card.href).toBeUndefined();
      }
    }
  });

  it('links the written guides out to the repository', () => {
    const guides = HELP_CARDS.filter((card) => card.id === 'user-guide' || card.id === 'api-cli');
    expect(guides).toHaveLength(2);
    for (const card of guides) {
      expect(card.href).toMatch(/^https:\/\/github\.com\/apiome\/apiome\/blob\/main\/docs\/guide\//);
    }
  });

  it('keeps the launcher’s YouTube destination, as one card among the guides', () => {
    // The mockup's Notes → Keeps: the launcher's *Help & tutorials* row survives here.
    expect(HELP_CARDS.find((card) => card.id === 'video')?.href).toBe(VIDEO_WALKTHROUGHS_URL);
    expect(VIDEO_WALKTHROUGHS_URL).toBe('https://www.youtube.com/@apiomedev');
  });

  it('chips the one card that has not shipped, and only that one', () => {
    const soon = HELP_CARDS.filter((card) => card.kind === 'soon');
    expect(soon.map((card) => card.id)).toEqual(['community']);
    expect(soon[0].badge).toBe('Soon');
    for (const card of HELP_CARDS.filter((entry) => entry.kind !== 'soon')) {
      expect(card.badge).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------
   2. The support block
   ------------------------------------------------------------------------- */

describe('supportDetails', () => {
  it('names both identifiers, labelled', () => {
    expect(supportDetails('ten_01HJ7F8H', 'v0.271.0 RC')).toBe(
      'Tenant id: ten_01HJ7F8H\nBuild: v0.271.0 RC'
    );
  });

  it('states the absence of a workspace rather than dropping the line', () => {
    for (const missing of [null, undefined, '']) {
      expect(supportDetails(missing, 'v0.271.0 RC')).toBe(
        `Tenant id: ${NO_TENANT_LABEL}\nBuild: v0.271.0 RC`
      );
    }
  });

  it('sends a reader somewhere real to ask', () => {
    expect(SUPPORT_ISSUE_URL).toMatch(/^https:\/\/github\.com\/apiome\/apiome\/issues/);
  });
});

/* -------------------------------------------------------------------------
   3. The glance strip
   ------------------------------------------------------------------------- */

describe('glanceShortcuts', () => {
  it('prints nothing when nothing is bound', () => {
    expect(glanceShortcuts([])).toEqual([]);
  });

  it('orders rows the way the sheet does, not the way hosts mounted', () => {
    // `SHORTCUT_DISPLAY_ORDER` puts the palette before preferences before the rail.
    const registered = [binding('rail'), binding('palette'), binding('preferences')];
    expect(glanceShortcuts(registered).map((shortcut) => shortcut.id)).toEqual([
      'palette',
      'preferences',
      'rail',
    ]);
  });

  it('drops a gated binding, which has no room to state its reason here', () => {
    const registered = [
      binding('palette'),
      binding('jump-projects', {
        scope: 'jump',
        disabledReason: 'Select a workspace to use Projects.',
      }),
    ];
    expect(glanceShortcuts(registered).map((shortcut) => shortcut.id)).toEqual(['palette']);
  });

  it('prints one row per id when two hosts are mounted at once', () => {
    const registered = [binding('palette', { description: 'stale' }), binding('palette')];
    const rows = glanceShortcuts(registered);
    expect(rows).toHaveLength(1);
    // The most recent registration wins — the binding the engine would actually fire.
    expect(rows[0].description).toBe('palette');
  });

  it('stops at the limit, however many shortcuts are live', () => {
    const registered = Array.from({ length: SHORTCUT_GLANCE_LIMIT + 4 }, (_, index) =>
      binding(`extra-${index}`)
    );
    expect(glanceShortcuts(registered)).toHaveLength(SHORTCUT_GLANCE_LIMIT);
  });

  it('takes a limit of its own, for a caller with less room', () => {
    const registered = [binding('palette'), binding('preferences'), binding('rail')];
    expect(glanceShortcuts(registered, 2).map((shortcut) => shortcut.id)).toEqual([
      'palette',
      'preferences',
    ]);
  });
});
