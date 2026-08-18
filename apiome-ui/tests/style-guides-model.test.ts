/**
 * The style-guides derivations (HIVE-5.6, #5309).
 *
 * `style-guides-hive-redesign.test.tsx` renders the screen and `style-guides-css.test.ts`
 * reads the stylesheet; this holds the claims underneath both, because they are claims and
 * not appearances:
 *
 *   1. **"The built-in guide stays read-only with its duplicate path."** The ticket's first
 *      acceptance criterion, and a property of {@link styleGuideRowActions} rather than of any
 *      component's JSX — so it is asserted here, once, against both gates that can close a
 *      verb: administration and the guide's own `source`.
 *   2. **"Assignment chips reflect tenant-default and per-project assignments."** Which is
 *      also what the `assigned` / `unassigned` chips have to mean, since a lint run resolves
 *      exactly those two ways (GOV-1.4).
 *   3. **A deletion says what it actually costs.** The sentence names the tenant default, the
 *      pinned projects and the guide the server really promotes — and says nothing at all when
 *      there is nothing to say.
 */

import {
  describeGuideCount,
  describeStyleGuideDeletion,
  duplicateGuideName,
  findBuiltinGuide,
  formatGuideDate,
  formatPolicyInstant,
  guideRuleCountLabel,
  guideSourceOptionLabel,
  isAssignedGuide,
  isBuiltinGuide,
  matchesStyleGuideFacet,
  NO_VALUE,
  searchStyleGuides,
  sortStyleGuides,
  STYLE_GUIDE_FACETS,
  STYLE_GUIDE_FACET_LABELS,
  styleGuideDeletionImpact,
  styleGuideFacetCounts,
  styleGuideRowActions,
  styleGuideTone,
  type StyleGuide,
} from '../src/app/components/ade/styleGuides/styleGuidesModel';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

/**
 * Build one guide.
 *
 * @param over What this guide differs by.
 * @returns The guide.
 */
function guide(over: Partial<StyleGuide> & { id: string }): StyleGuide {
  return {
    name: 'Acme REST',
    description: 'House rules for public REST APIs.',
    source: 'custom',
    isDefault: false,
    ruleCount: 41,
    enabledRuleCount: 34,
    tenantAssigned: false,
    projectAssignments: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-08-14T16:22:00Z',
    ...over,
  };
}

/** The shipped guide. */
const BUILTIN = guide({
  id: 'g-builtin',
  name: 'Apiome Recommended',
  source: 'builtin',
  ruleCount: 41,
  enabledRuleCount: 41,
  // The shipped guide is never edited, so the API answers with no `updated_at` — which is
  // why the mockup's Updated cell for it is an em dash.
  updatedAt: null,
});

/** A custom guide that is the tenant default and pinned to one project. */
const DEFAULT_GUIDE = guide({
  id: 'g-default',
  name: 'Acme REST',
  isDefault: true,
  projectAssignments: [{ projectId: 'p-1', projectName: 'Payments API' }],
});

/** A custom guide pinned to a project but not the default. */
const PINNED = guide({
  id: 'g-pinned',
  name: 'Events (AsyncAPI)',
  enabledRuleCount: 22,
  projectAssignments: [{ projectId: 'p-2', projectName: 'Inventory Events' }],
  updatedAt: '2026-08-11T10:05:00Z',
});

/** A custom guide that governs nothing. */
const ORPHAN = guide({
  id: 'g-orphan',
  name: 'Partner API strict',
  enabledRuleCount: 41,
  updatedAt: '2026-08-03T09:48:00Z',
});

/** The whole list, as the API orders it: built-in first. */
const GUIDES = [BUILTIN, DEFAULT_GUIDE, PINNED, ORPHAN];

// ---------------------------------------------------------------------------------------
// 1. The built-in guide — the ticket's first acceptance criterion
// ---------------------------------------------------------------------------------------

describe('the built-in guide', () => {
  it('is recognised by the server’s own word for it', () => {
    expect(isBuiltinGuide(BUILTIN)).toBe(true);
    expect(isBuiltinGuide(DEFAULT_GUIDE)).toBe(false);
    expect(findBuiltinGuide(GUIDES)).toBe(BUILTIN);
    expect(findBuiltinGuide([DEFAULT_GUIDE, PINNED])).toBeNull();
  });

  it('stays read-only, and keeps its duplicate path', () => {
    const actions = styleGuideRowActions(BUILTIN, true);
    expect(actions.canEdit).toBe(false);
    expect(actions.canDelete).toBe(false);
    // The two verbs that are the whole of the "duplicate path" the criterion asks for.
    expect(actions.canDuplicate).toBe(true);
    expect(actions.canAssign).toBe(true);
    expect(actions.readOnlyReason).toMatch(/duplicate it to customize/);
  });

  it('leaves a custom guide every verb', () => {
    const actions = styleGuideRowActions(DEFAULT_GUIDE, true);
    expect(actions).toMatchObject({
      canAssign: true,
      canDuplicate: true,
      canEdit: true,
      canDelete: true,
      readOnlyReason: null,
    });
  });

  it('closes every verb for a viewer who does not administer the tenant', () => {
    for (const subject of [BUILTIN, DEFAULT_GUIDE]) {
      const actions = styleGuideRowActions(subject, false);
      expect(actions.canAssign).toBe(false);
      expect(actions.canDuplicate).toBe(false);
      expect(actions.canEdit).toBe(false);
      expect(actions.canDelete).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------
// 2. Assignment — the ticket's second acceptance criterion
// ---------------------------------------------------------------------------------------

describe('assignment', () => {
  it('counts a guide as assigned when a lint run could resolve to it', () => {
    // The two ways `resolve_style_guide` (GOV-1.4) picks a guide, and no others.
    expect(isAssignedGuide(DEFAULT_GUIDE)).toBe(true);
    expect(isAssignedGuide(PINNED)).toBe(true);
    expect(isAssignedGuide(ORPHAN)).toBe(false);
    expect(isAssignedGuide(BUILTIN)).toBe(false);
  });

  it('offers the four chips the mockup shows, in order', () => {
    expect(STYLE_GUIDE_FACETS).toEqual(['all', 'custom', 'assigned', 'unassigned']);
    for (const facet of STYLE_GUIDE_FACETS) {
      expect(STYLE_GUIDE_FACET_LABELS[facet]).toBeTruthy();
    }
  });

  it('partitions the list the way the chips promise', () => {
    expect(matchesStyleGuideFacet(BUILTIN, 'custom')).toBe(false);
    expect(matchesStyleGuideFacet(ORPHAN, 'custom')).toBe(true);
    expect(matchesStyleGuideFacet(ORPHAN, 'unassigned')).toBe(true);
    expect(matchesStyleGuideFacet(PINNED, 'unassigned')).toBe(false);
    for (const subject of GUIDES) {
      expect(matchesStyleGuideFacet(subject, 'all')).toBe(true);
    }
  });

  it('counts each chip, and the counts partition the list', () => {
    const counts = styleGuideFacetCounts(GUIDES);
    expect(counts.all).toBe(4);
    expect(counts.custom).toBe(3);
    expect(counts.assigned).toBe(2);
    expect(counts.unassigned).toBe(2);
    // Assigned and unassigned are complements, which is what makes the pair honest.
    expect(counts.assigned + counts.unassigned).toBe(counts.all);
  });
});

// ---------------------------------------------------------------------------------------
// 3. Search & sort
// ---------------------------------------------------------------------------------------

describe('search', () => {
  it('keeps everything for a blank query', () => {
    expect(searchStyleGuides(GUIDES, '  ')).toHaveLength(4);
  });

  it('matches the name and the description', () => {
    expect(searchStyleGuides(GUIDES, 'async').map((g) => g.id)).toEqual(['g-pinned']);
    expect(searchStyleGuides(GUIDES, 'house rules').map((g) => g.id)).toContain('g-default');
  });

  it('reaches the pinned projects — “which guide governs Payments API?”', () => {
    expect(searchStyleGuides(GUIDES, 'payments api').map((g) => g.id)).toEqual(['g-default']);
  });

  it('is case-insensitive and does not mutate its input', () => {
    const before = [...GUIDES];
    expect(searchStyleGuides(GUIDES, 'ACME')).toHaveLength(1);
    expect(GUIDES).toEqual(before);
  });
});

describe('sorting', () => {
  it('leaves the API’s own order when nothing is sorted', () => {
    expect(sortStyleGuides(GUIDES, null).map((g) => g.id)).toEqual([
      'g-builtin',
      'g-default',
      'g-pinned',
      'g-orphan',
    ]);
  });

  it('sorts by name, in both directions', () => {
    expect(sortStyleGuides(GUIDES, { column: 'name', direction: 'asc' })[0].name).toBe(
      'Acme REST'
    );
    expect(sortStyleGuides(GUIDES, { column: 'name', direction: 'desc' })[0].name).toBe(
      'Partner API strict'
    );
  });

  it('sorts rules on numerically, not as text', () => {
    // "22" sorts before "34" numerically and after it as text — the trap a string compare
    // would fall into.
    expect(
      sortStyleGuides(GUIDES, { column: 'rules', direction: 'asc' }).map((g) => g.enabledRuleCount)
    ).toEqual([22, 34, 41, 41]);
  });

  it('sorts by updated', () => {
    expect(
      sortStyleGuides(GUIDES, { column: 'updated', direction: 'desc' })[0].id
    ).toBe('g-default');
  });

  it('ignores a column it does not sort by, rather than reordering at random', () => {
    expect(sortStyleGuides(GUIDES, { column: 'nonsense', direction: 'asc' }).map((g) => g.id)).toEqual(
      GUIDES.map((g) => g.id)
    );
  });

  it('never mutates the array it was given', () => {
    const before = GUIDES.map((g) => g.id);
    sortStyleGuides(GUIDES, { column: 'name', direction: 'asc' });
    expect(GUIDES.map((g) => g.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------
// 4. Presentation
// ---------------------------------------------------------------------------------------

describe('presentation', () => {
  it('tints a guide’s tile by what it is, not at random', () => {
    expect(styleGuideTone(BUILTIN)).toBe('honey');
    expect(styleGuideTone(DEFAULT_GUIDE)).toBe('ok');
    expect(styleGuideTone(PINNED)).toBe('violet');
    expect(styleGuideTone(ORPHAN)).toBe('neutral');
  });

  it('reads the rules-on cell as enabled over total', () => {
    expect(guideRuleCountLabel(DEFAULT_GUIDE)).toBe('34 / 41');
    expect(guideRuleCountLabel(BUILTIN)).toBe('41 / 41');
  });

  it('labels a source option with what copying it would bring', () => {
    expect(guideSourceOptionLabel(BUILTIN)).toBe('Apiome Recommended (41 rules on)');
  });

  it('opens a duplicate on the mockup’s own name', () => {
    expect(duplicateGuideName('Acme REST')).toBe('Acme REST (copy)');
  });

  it('formats a date, and says so rather than drawing “Invalid Date”', () => {
    expect(formatGuideDate('2026-08-14T16:22:00Z')).toMatch(/2026/);
    expect(formatGuideDate(null)).toBe(NO_VALUE);
    expect(formatGuideDate('not a date')).toBe(NO_VALUE);
  });

  it('keeps an unparsable policy instant verbatim rather than hiding it', () => {
    // A version list is evidence: a timestamp the UI cannot parse is still what the server
    // sent, and dropping it would hide a real data problem.
    expect(formatPolicyInstant('whenever')).toBe('whenever');
    expect(formatPolicyInstant(null)).toBe(NO_VALUE);
  });

  it('counts guides in the singular and the plural', () => {
    expect(describeGuideCount(0)).toBe('0 guides');
    expect(describeGuideCount(1)).toBe('1 guide');
    expect(describeGuideCount(4)).toBe('4 guides');
  });
});

// ---------------------------------------------------------------------------------------
// 5. Deletion — what it actually costs
// ---------------------------------------------------------------------------------------

describe('deleting a guide', () => {
  it('is harmless when the guide governs nothing, and says nothing', () => {
    const impact = styleGuideDeletionImpact(ORPHAN, GUIDES);
    expect(impact.harmless).toBe(true);
    expect(describeStyleGuideDeletion(impact, ORPHAN.name)).toBeNull();
  });

  it('names the tenant default and the guide the server promotes in its place', () => {
    const impact = styleGuideDeletionImpact(DEFAULT_GUIDE, GUIDES);
    expect(impact).toMatchObject({
      wasDefault: true,
      projectNames: ['Payments API'],
      fallbackGuideName: 'Apiome Recommended',
      harmless: false,
    });
    const sentence = describeStyleGuideDeletion(impact, DEFAULT_GUIDE.name);
    expect(sentence).toContain('is the tenant default');
    expect(sentence).toContain('is pinned to Payments API');
    expect(sentence).toContain('scored by Apiome Recommended');
  });

  it('counts the projects rather than listing all of them', () => {
    const many = guide({
      id: 'g-many',
      projectAssignments: [
        { projectId: 'p-1', projectName: 'One' },
        { projectId: 'p-2', projectName: 'Two' },
        { projectId: 'p-3', projectName: 'Three' },
      ],
    });
    const sentence = describeStyleGuideDeletion(
      styleGuideDeletionImpact(many, [...GUIDES, many]),
      many.name
    );
    expect(sentence).toContain('is pinned to 3 projects');
    expect(sentence).not.toContain('is the tenant default');
  });

  it('does not promise a fallback guide the workspace does not have', () => {
    // A tenant with no built-in guide in the list: the sentence says what happens without
    // naming a guide that is not there.
    const impact = styleGuideDeletionImpact(DEFAULT_GUIDE, [DEFAULT_GUIDE, PINNED]);
    expect(impact.fallbackGuideName).toBeNull();
    expect(describeStyleGuideDeletion(impact, DEFAULT_GUIDE.name)).toContain(
      'fall back to the tenant default'
    );
  });
});
