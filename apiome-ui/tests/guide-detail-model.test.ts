/**
 * The style-guide detail derivations (HIVE-5.7, #5310).
 *
 * `guide-detail-hive-redesign.test.tsx` renders the page and `guide-detail-css.test.ts`
 * pins the stylesheet. This holds the parts of the screen that are *claims* — which rules a
 * filter leaves, which of them count as modified, what the save bar and the discard confirm
 * say, and where a dry run's findings land in the document — none of which need a rendered
 * editor to be true.
 */

import {
  ALL_CATEGORIES,
  EMPTY_RULE_FILTER,
  SEVERITY_OPTIONS,
  catalogFootSentence,
  discardWarningSentence,
  enabledRuleCount,
  filterRules,
  groupRulesByCategory,
  guideReadOnlyReason,
  isRuleModified,
  modifiedRuleIds,
  ruleCategories,
  toRuleStateMap,
  unsavedRulesSentence,
  type GuideRule,
  type RuleStateMap,
} from '../src/app/components/ade/styleGuides/guideDetail/guideDetailModel';
import {
  MARKER_SEVERITY,
  previewMarkers,
} from '../src/app/ade/dashboard/style-guides/customRuleYamlMarkers';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

/**
 * Build one catalog rule.
 *
 * @param over What this rule differs by.
 * @returns The rule.
 */
function rule(over: Partial<GuideRule> & { ruleId: string; category: string }): GuideRule {
  return {
    pack: 'openapi',
    defaultSeverity: 'warning',
    rationale: 'Because the generated clients read better that way.',
    docsAnchor: 'anchor',
    enabled: true,
    severity: 'warning',
    ...over,
  };
}

const CATALOG: GuideRule[] = [
  rule({ ruleId: 'path-kebab-case', category: 'naming' }),
  rule({
    ruleId: 'schema-names-pascal-case',
    category: 'naming',
    defaultSeverity: 'info',
    severity: 'info',
    enabled: false,
  }),
  rule({
    ruleId: 'info-contact',
    category: 'documentation',
    rationale: 'Consumers need someone to reach when a contract breaks.',
    severity: 'error',
  }),
  rule({ ruleId: 'no-http-basic', category: 'security', defaultSeverity: 'error', severity: 'error' }),
];

const BASELINE: RuleStateMap = toRuleStateMap(CATALOG);

// ---------------------------------------------------------------------------------------
// 1. The editable half of a rule
// ---------------------------------------------------------------------------------------

describe('the rule state map', () => {
  it('carries only what a guide can change', () => {
    expect(BASELINE['info-contact']).toEqual({ enabled: true, severity: 'error' });
    expect(BASELINE['schema-names-pascal-case']).toEqual({ enabled: false, severity: 'info' });
  });

  it('counts the rules the draft has switched on, not the ones the server sent', () => {
    expect(enabledRuleCount(BASELINE)).toBe(3);
    expect(
      enabledRuleCount({ ...BASELINE, 'schema-names-pascal-case': { enabled: true, severity: 'info' } })
    ).toBe(4);
  });

  it('offers the three severities the linter speaks, worst first', () => {
    expect(SEVERITY_OPTIONS.map((option) => option.value)).toEqual(['error', 'warning', 'info']);
  });
});

describe('what counts as modified', () => {
  it('sees a switch and a severity alike', () => {
    const toggled = { ...BASELINE, 'path-kebab-case': { enabled: false, severity: 'warning' as const } };
    const resevered = { ...BASELINE, 'path-kebab-case': { enabled: true, severity: 'error' as const } };
    expect(isRuleModified('path-kebab-case', toggled, BASELINE)).toBe(true);
    expect(isRuleModified('path-kebab-case', resevered, BASELINE)).toBe(true);
    expect(isRuleModified('path-kebab-case', BASELINE, BASELINE)).toBe(false);
  });

  it('treats a rule the baseline has never heard of as modified', () => {
    // A rule the catalog gained since the page loaded. Calling it unchanged would let a
    // save write a value the reader never saw.
    const draft = { ...BASELINE, 'brand-new-rule': { enabled: true, severity: 'info' as const } };
    expect(isRuleModified('brand-new-rule', draft, BASELINE)).toBe(true);
  });

  it('ignores a rule the draft no longer holds', () => {
    expect(isRuleModified('gone', BASELINE, BASELINE)).toBe(false);
  });

  it('lists every modified id', () => {
    const draft = {
      ...BASELINE,
      'path-kebab-case': { enabled: false, severity: 'warning' as const },
      'no-http-basic': { enabled: true, severity: 'info' as const },
    };
    expect(modifiedRuleIds(draft, BASELINE).sort()).toEqual(['no-http-basic', 'path-kebab-case']);
  });
});

// ---------------------------------------------------------------------------------------
// 2. The toolbar
// ---------------------------------------------------------------------------------------

describe('filtering', () => {
  it('leaves everything when nothing is asked of it', () => {
    expect(filterRules(CATALOG, EMPTY_RULE_FILTER, BASELINE, BASELINE)).toHaveLength(4);
    expect(EMPTY_RULE_FILTER.category).toBe(ALL_CATEGORIES);
  });

  it('searches the id, the rationale and the category alike', () => {
    const byId = filterRules(CATALOG, { ...EMPTY_RULE_FILTER, search: 'pascal' }, BASELINE, BASELINE);
    const byRationale = filterRules(
      CATALOG,
      { ...EMPTY_RULE_FILTER, search: 'contract breaks' },
      BASELINE,
      BASELINE
    );
    const byCategory = filterRules(
      CATALOG,
      { ...EMPTY_RULE_FILTER, search: 'security' },
      BASELINE,
      BASELINE
    );
    expect(byId.map((r) => r.ruleId)).toEqual(['schema-names-pascal-case']);
    expect(byRationale.map((r) => r.ruleId)).toEqual(['info-contact']);
    expect(byCategory.map((r) => r.ruleId)).toEqual(['no-http-basic']);
  });

  it('ignores case and surrounding space in the search term', () => {
    const found = filterRules(
      CATALOG,
      { ...EMPTY_RULE_FILTER, search: '  KEBAB  ' },
      BASELINE,
      BASELINE
    );
    expect(found.map((r) => r.ruleId)).toEqual(['path-kebab-case']);
  });

  it('narrows by category', () => {
    const found = filterRules(CATALOG, { ...EMPTY_RULE_FILTER, category: 'naming' }, BASELINE, BASELINE);
    expect(found.map((r) => r.ruleId)).toEqual(['path-kebab-case', 'schema-names-pascal-case']);
  });

  it('narrows to what has been modified', () => {
    const draft = { ...BASELINE, 'no-http-basic': { enabled: false, severity: 'error' as const } };
    const found = filterRules(CATALOG, { ...EMPTY_RULE_FILTER, modifiedOnly: true }, draft, BASELINE);
    expect(found.map((r) => r.ruleId)).toEqual(['no-http-basic']);
  });

  it('applies all three clauses together rather than replacing one with another', () => {
    const draft = {
      ...BASELINE,
      'path-kebab-case': { enabled: false, severity: 'warning' as const },
      'no-http-basic': { enabled: false, severity: 'error' as const },
    };
    const found = filterRules(
      CATALOG,
      { search: 'case', category: 'naming', modifiedOnly: true },
      draft,
      BASELINE
    );
    // `no-http-basic` is modified but not in `naming`; `schema-names-pascal-case` is in
    // `naming` and matches the search but is not modified.
    expect(found.map((r) => r.ruleId)).toEqual(['path-kebab-case']);
  });

  it('lists every category once, sorted', () => {
    expect(ruleCategories(CATALOG)).toEqual(['documentation', 'naming', 'security']);
  });
});

// ---------------------------------------------------------------------------------------
// 3. Grouping
// ---------------------------------------------------------------------------------------

describe('grouping', () => {
  it('sorts the sections so they do not reorder as a search narrows them', () => {
    expect(groupRulesByCategory(CATALOG, BASELINE).map((group) => group.category)).toEqual([
      'documentation',
      'naming',
      'security',
    ]);
  });

  it('counts each section from the draft, not from the payload', () => {
    const naming = groupRulesByCategory(CATALOG, BASELINE).find((g) => g.category === 'naming');
    expect(naming).toMatchObject({ enabled: 1 });
    expect(naming!.rules).toHaveLength(2);

    const draft = { ...BASELINE, 'schema-names-pascal-case': { enabled: true, severity: 'info' as const } };
    expect(groupRulesByCategory(CATALOG, draft).find((g) => g.category === 'naming')!.enabled).toBe(2);
  });

  it('drops a category the filter emptied', () => {
    const visible = filterRules(CATALOG, { ...EMPTY_RULE_FILTER, category: 'security' }, BASELINE, BASELINE);
    expect(groupRulesByCategory(visible, BASELINE).map((g) => g.category)).toEqual(['security']);
  });
});

// ---------------------------------------------------------------------------------------
// 4. The sentences
// ---------------------------------------------------------------------------------------

describe('the copy', () => {
  it('pluralises the save bar', () => {
    expect(unsavedRulesSentence(1)).toBe('1 unsaved rule change');
    expect(unsavedRulesSentence(2)).toBe('2 unsaved rule changes');
  });

  it('names both drafts in the discard confirm, and neither when both are clean', () => {
    expect(discardWarningSentence(0, false)).toBeNull();
    expect(discardWarningSentence(1, false)).toBe(
      'You have unsaved 1 rule change. Leaving this page discards them.'
    );
    expect(discardWarningSentence(0, true)).toBe(
      'You have unsaved edits to the custom rules. Leaving this page discards them.'
    );
    expect(discardWarningSentence(3, true)).toBe(
      'You have unsaved 3 rule changes and edits to the custom rules. Leaving this page discards them.'
    );
  });

  it('counts what is shown and what exists in the foot', () => {
    expect(catalogFootSentence(16, 41, 5)).toBe('Showing 16 of 41 rules · 5 categories');
    expect(catalogFootSentence(1, 1, 1)).toBe('Showing 1 of 1 rule · 1 category');
  });
});

// ---------------------------------------------------------------------------------------
// 5. Who may edit
// ---------------------------------------------------------------------------------------

describe('the read-only gate', () => {
  it('reports the built-in guide before it reports the viewer', () => {
    // The built-in guide is read-only even to an administrator: `style_guide_routes.py`
    // refuses the write with a 409 whoever asks.
    expect(guideReadOnlyReason('builtin', true)).toBe('builtin');
    expect(guideReadOnlyReason('builtin', false)).toBe('builtin');
  });

  it('reports a member on a custom guide', () => {
    expect(guideReadOnlyReason('custom', false)).toBe('member');
  });

  it('lets an administrator edit a custom guide', () => {
    expect(guideReadOnlyReason('custom', true)).toBeNull();
  });

  it('treats a guide that has not loaded as a member would see it', () => {
    expect(guideReadOnlyReason(undefined, false)).toBe('member');
  });
});

// ---------------------------------------------------------------------------------------
// 6. Dry-run findings as markers — the third acceptance criterion
// ---------------------------------------------------------------------------------------

const YAML = [
  'rules:',
  '  operation-summary-max-length:',
  '    description: Summaries stay under 60 characters.',
  '    severity: warning',
  '  refund-idempotency-key:',
  '    description: POST /refunds must declare an Idempotency-Key header.',
  '    severity: error',
  '',
].join('\n');

describe('preview markers', () => {
  it('lands each finding on the rule that produced it, not on the path it names', () => {
    const markers = previewMarkers(
      [
        {
          rule: 'refund-idempotency-key',
          severity: 'error',
          message: 'Missing Idempotency-Key.',
          path: 'paths./refunds.post.parameters',
        },
      ],
      {},
      YAML
    );

    // Line 5 is `  refund-idempotency-key:` — the rule's own declaration. The spec path has
    // no line in *this* document, so it travels in the message instead.
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      startLine: 5,
      severity: MARKER_SEVERITY.error,
      source: 'refund-idempotency-key',
    });
    expect(markers[0].message).toContain('paths./refunds.post.parameters');
  });

  it('maps the three severities onto Monaco', () => {
    const markers = previewMarkers(
      [
        { rule: 'operation-summary-max-length', severity: 'warning', message: 'Too long.' },
        { rule: 'operation-summary-max-length', severity: 'info', message: 'Consider shortening.' },
      ],
      {},
      YAML
    );
    expect(markers.map((m) => m.severity)).toEqual([MARKER_SEVERITY.warning, MARKER_SEVERITY.info]);
    expect(MARKER_SEVERITY).toEqual({ error: 8, warning: 4, info: 2 });
  });

  it('marks a rule that could not run at all as an error', () => {
    const markers = previewMarkers([], { 'refund-idempotency-key': 'bad function' }, YAML);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ severity: MARKER_SEVERITY.error, startLine: 5 });
    expect(markers[0].message).toContain('bad function');
  });

  it('falls back to the first line for a rule that is not in the document', () => {
    // A finding can name a rule the reader has just deleted from the draft. A marker on
    // line 1 is wrong-ish; no marker at all would lose the finding entirely.
    const markers = previewMarkers([{ rule: 'deleted-rule', severity: 'error', message: 'x' }], {}, YAML);
    expect(markers[0].startLine).toBe(1);
  });

  it('returns nothing for a clean run', () => {
    expect(previewMarkers([], {}, YAML)).toEqual([]);
  });
});
