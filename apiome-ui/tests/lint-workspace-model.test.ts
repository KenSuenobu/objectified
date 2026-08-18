/**
 * The derivations behind the lint posture workspace (HIVE-5.8, #5311).
 *
 * `lint-workspace-hive-redesign.test.tsx` renders the screen and pins its markup;
 * `lint-workspace-css.test.ts` pins the declarations. This suite pins the *rules* — the ones
 * that decide what a tile says, which chips exist, what the toast reads after a partial
 * failure, and where a page of an offset-paged queue starts. Every one of them is a fact
 * about the product rather than about React, which is why they are here and not in JSX.
 */

import {
  BULK_VERBS,
  LINT_QUEUE_PAGE_SIZE,
  NO_VALUE,
  QUALITY_RANK_WINDOWS,
  RANK_GRADE_BUCKETS,
  TREND_SERIES,
  attributionSpec,
  axisChips,
  axisLabel,
  bulkToast,
  canonicalFilterKey,
  clearableFilterCount,
  decisionEventLines,
  decisionEventTone,
  decisionEventsFromPayload,
  drillDownFilters,
  driftSpec,
  facetGroups,
  findingLocationLine,
  findingPath,
  findingPolicyVerdict,
  findingRemediation,
  findingSubjectHref,
  findingSubjectName,
  findingWaiverExpiringSoon,
  gradeBars,
  gradeChips,
  missingCoverageAxes,
  postureTiles,
  queueOffsetForPage,
  queuePageCount,
  queuePageNumber,
  queueRangeLabel,
  rankStats,
  rankWindowSummary,
  savedViewMatches,
  scopeLabel,
  severityLabel,
  shareableUrl,
  toggleFacet,
  trendSeriesData,
  waiverDialogCopy,
  withFacetToggled,
} from '../src/app/components/ade/lintWorkspace/lintWorkspaceModel';
import {
  EMPTY_WORKSPACE_FILTERS,
  type WorkspaceFilters,
} from '../src/app/utils/lint-workspace';
import {
  bulkResponse,
  finding,
  rankFormat,
  rankSeries,
  savedView,
  summary,
  trends,
} from './helpers/lint-workspace-fixtures';

/** The empty filter bundle, plus whatever a case is about. */
function filters(overrides: Partial<WorkspaceFilters> = {}): WorkspaceFilters {
  return { ...EMPTY_WORKSPACE_FILTERS, ...overrides };
}

describe('vocabularies', () => {
  it('opens an axis key out rather than showing the enum', () => {
    expect(axisLabel('supply_chain')).toBe('Supply chain');
    // A key this build has not been taught still reads as words, not as `foo_bar`.
    expect(axisLabel('foo_bar')).toBe('foo bar');
  });

  it('says nothing rather than zero when a finding has no severity', () => {
    expect(severityLabel('warning')).toBe('Warning');
    expect(severityLabel(null)).toBe(NO_VALUE);
    expect(severityLabel('catastrophic')).toBe('catastrophic');
  });
});

describe('the facet strip', () => {
  it('lists every value of every closed vocabulary, counts and all', () => {
    const groups = facetGroups(filters(), {
      severity: { error: 21 },
      effectiveState: { open: 168 },
    });
    expect(groups.map((group) => group.key)).toEqual(['severity', 'state', 'axis', 'grade']);
    expect(groups[0].chips.map((chip) => chip.value)).toEqual(['error', 'warning', 'info']);
    expect(groups[1].chips).toHaveLength(6);
    expect(groups[2].chips).toHaveLength(6);
    expect(groups[3].chips.map((chip) => chip.value)).toEqual(['A', 'B', 'C', 'D', 'F']);
  });

  it('carries the facet count when the read has one and leaves it absent otherwise', () => {
    const [severity] = facetGroups(filters(), { severity: { error: 21 } });
    expect(severity.chips[0].count).toBe(21);
    // Not `0`: "the read did not report this facet" and "the facet holds none" differ.
    expect(severity.chips[1].count).toBeUndefined();
  });

  it('marks the chips that are narrowing the queue', () => {
    const groups = facetGroups(filters({ severity: ['error'], state: ['waived'] }), {});
    expect(groups[0].chips.find((chip) => chip.value === 'error')?.active).toBe(true);
    expect(groups[0].chips.find((chip) => chip.value === 'info')?.active).toBe(false);
    expect(groups[1].chips.find((chip) => chip.value === 'waived')?.active).toBe(true);
  });

  it('gives severity and state a tone, and axis and grade none', () => {
    const groups = facetGroups(filters(), {});
    expect(groups[0].chips.map((chip) => chip.tone)).toEqual(['danger', 'warn', 'accent']);
    expect(groups[1].chips.map((chip) => chip.tone)).toEqual([
      'neutral',
      'accent',
      'orange',
      'warn',
      'ok',
      'violet',
    ]);
    expect(groups[2].chips.every((chip) => chip.tone === null)).toBe(true);
    expect(groups[3].chips.every((chip) => chip.tone === null)).toBe(true);
  });

  it('toggles a facet on and back off', () => {
    expect(toggleFacet([], 'error')).toEqual(['error']);
    expect(toggleFacet(['error', 'info'], 'error')).toEqual(['info']);
  });

  it('flips a chip on the field it belongs to and leaves the others alone', () => {
    const next = withFacetToggled(filters({ axis: ['quality'] }), 'axis', 'security');
    expect(next.axis).toEqual(['quality', 'security']);
    expect(next.severity).toEqual([]);
    expect(withFacetToggled(next, 'axis', 'quality').axis).toEqual(['security']);
  });
});

describe('the posture summary', () => {
  it('reports the four tiles with their figures and drill targets', () => {
    const tiles = postureTiles(summary());
    expect(tiles.map((tile) => tile.target)).toEqual([
      'security-errors',
      'coverage',
      'new',
      'waiver-requests',
    ]);
    expect(tiles[0].value).toBe(2);
    expect(tiles[1].value).toBe(3);
    expect(tiles[1].unit).toBe('of 12 subjects');
    expect(tiles[2].value).toBe(7);
    expect(tiles[3].value).toBe(4);
    expect(tiles[3].footnote).toBe('3 requested · 1 expiring soon');
  });

  it('calls out the security tile only while it has something to call out', () => {
    expect(postureTiles(summary()).at(0)).toMatchObject({
      tone: 'danger',
      footnoteEnd: 'Needs attention',
    });
    const clean = summary({ findings: { unwaived_security_errors: 0 } });
    expect(postureTiles(clean).at(0)).toMatchObject({ tone: 'ok', footnoteEnd: undefined });
  });

  it('names the axes that are missing coverage, and says so when none are', () => {
    expect(missingCoverageAxes(summary())).toEqual(['Security']);
    expect(postureTiles(summary())[1].footnote).toBe('Security not assessed');

    const covered = summary({ coverage: { missingCount: 0, subjects: [] } });
    expect(postureTiles(covered)[1].footnote).toBe('Every required axis is assessed');
  });

  it('reports an axis the vocabulary has not been taught rather than dropping it', () => {
    const odd = summary({
      coverage: {
        missingCount: 1,
        subjects: [
          {
            subjectType: 'catalog_revision',
            subjectId: 'v1',
            projectId: 'p1',
            subjectLabel: 'v1',
            missingAxes: ['sustainability'],
          },
        ],
      },
    });
    expect(missingCoverageAxes(odd)).toEqual(['sustainability']);
  });

  it('draws every grade band including the empty ones, with Ungraded last', () => {
    const chips = gradeChips(summary());
    expect(chips.map((chip) => chip.key)).toEqual(['A', 'B', 'C', 'D', 'F', 'ungraded']);
    expect(chips.find((chip) => chip.key === 'F')?.count).toBe(0);
    expect(chips.at(-1)).toMatchObject({ label: 'Ungraded', count: 1 });
  });

  it('shows an em dash, never a zero, for an axis nothing was assessed on', () => {
    const [quality, supply] = axisChips(summary());
    expect(quality).toMatchObject({
      label: 'Quality · 84',
      assessed: true,
      title: 'Quality: 12 assessed, 0 not assessed',
    });
    expect(supply).toMatchObject({
      label: `Supply chain · ${NO_VALUE}`,
      assessed: false,
      title: 'Supply chain: not assessed anywhere',
    });
  });

  it('replaces the filter bundle on a drill-down, keeping only the project scope', () => {
    const start = filters({ projectId: 'p1', severity: ['info'], grade: ['D'], q: 'basic' });
    expect(drillDownFilters('security-errors', EMPTY_WORKSPACE_FILTERS, start.projectId)).toMatchObject(
      { projectId: 'p1', severity: ['error'], axis: ['security'], state: ['open'], grade: [], q: '' }
    );
    expect(drillDownFilters('coverage', EMPTY_WORKSPACE_FILTERS, '').coverage).toBe('missing');
    expect(drillDownFilters('new', EMPTY_WORKSPACE_FILTERS, '').newOnly).toBe(true);
    expect(drillDownFilters('waiver-requests', EMPTY_WORKSPACE_FILTERS, '').state).toEqual([
      'waiver_requested',
    ]);
  });
});

describe('saved views and the shareable URL', () => {
  it('recognises the view a reader is actually looking at', () => {
    const view = savedView();
    const applied = filters({ severity: ['error'], axis: ['security'], state: ['open'] });
    expect(savedViewMatches(view, applied, 'severity')).toBe(true);
    expect(savedViewMatches(view, filters({ severity: ['error'] }), 'severity')).toBe(false);
    expect(savedViewMatches(view, applied, 'newest')).toBe(false);
  });

  it('ignores the order of a multi-value facet, which the query does too', () => {
    const a = canonicalFilterKey(filters({ severity: ['error', 'warning'] }));
    const b = canonicalFilterKey(filters({ severity: ['warning', 'error'] }));
    expect(a).toBe(b);
  });

  it('treats an absent sort as the default one', () => {
    expect(savedViewMatches(savedView({ sort: '' }), filters(savedViewFilters()), '')).toBe(true);
    expect(savedViewMatches(savedView({ sort: '' }), filters(savedViewFilters()), 'severity')).toBe(
      true
    );
  });

  it('prints the address the current view is shareable at', () => {
    const url = shareableUrl('/ade/dashboard/lint-workspace', filters({ severity: ['error'] }), 'severity', 50);
    expect(url.path).toBe('/ade/dashboard/lint-workspace');
    expect(url.query).toContain('severity=error');
    expect(url.query).toContain('sort=severity');
    expect(url.query).toContain('offset=50');
  });

  it('prints a bare path when nothing narrows the queue', () => {
    const url = shareableUrl('/x', filters(), '', 0);
    expect(url.query).toBe('?sort=severity&offset=0');
  });
});

/** The filter bundle the fixture's saved view rehydrates to. */
function savedViewFilters(): Partial<WorkspaceFilters> {
  return { severity: ['error'], axis: ['security'], state: ['open'] };
}

describe('queue rows', () => {
  it('reads the location as one line, in the order the scanner recorded it', () => {
    expect(findingLocationLine(finding())).toBe(
      'path: components.securitySchemes.basicAuth, line: 412'
    );
    expect(findingLocationLine(finding({ location: {} }))).toBe(NO_VALUE);
  });

  it('finds the document path, and reports none rather than guessing', () => {
    expect(findingPath(finding())).toBe('components.securitySchemes.basicAuth');
    expect(findingPath(finding({ location: { line: 3 } }))).toBeNull();
  });

  it('takes the remediation hint from either key the scanners use', () => {
    expect(findingRemediation(finding())).toContain('OAuth2');
    expect(findingRemediation(finding({ remediation: { summary: 'Pin the ref.' } }))).toBe(
      'Pin the ref.'
    );
    expect(findingRemediation(finding({ remediation: null }))).toBeNull();
  });

  it('links a revision to versions and an MCP finding to the MCP page', () => {
    expect(findingSubjectHref(finding())).toBe('/ade/dashboard/versions?projectId=p1');
    expect(
      findingSubjectHref(finding({ versionRecordId: null, mcpVersionId: 'mcp-1' }))
    ).toBe('/ade/dashboard/mcp');
    expect(
      findingSubjectHref(finding({ versionRecordId: null, mcpVersionId: null }))
    ).toBeNull();
  });

  it('names the subject by project, then by label, then not at all', () => {
    expect(findingSubjectName(finding())).toBe('Payments API');
    expect(findingSubjectName(finding({ projectName: null }))).toBe('v2.4.0');
    expect(findingSubjectName(finding({ projectName: null, subjectLabel: null }))).toBe(NO_VALUE);
  });

  it('says a policy was not evaluated rather than calling it a failure', () => {
    expect(findingPolicyVerdict(finding({ policyPassed: null }))).toMatchObject({
      label: 'Not evaluated',
      status: 'unknown',
    });
    expect(findingPolicyVerdict(finding({ policyPassed: true }))).toMatchObject({
      label: 'Passed',
      status: 'passed',
    });
    expect(findingPolicyVerdict(finding())).toMatchObject({
      label: 'Failed',
      status: 'failed',
      evaluationId: 'ev_44b0c1',
    });
  });

  it('flags a waiver about to lapse, and only a granted one', () => {
    const now = new Date('2026-08-15T00:00:00Z');
    const soon = { id: 'd', state: 'waived', expiresAt: '2026-08-20T00:00:00Z' };
    expect(findingWaiverExpiringSoon(finding({ waived: true, decision: soon }), now)).toBe(true);
    expect(findingWaiverExpiringSoon(finding({ waived: false, decision: soon }), now)).toBe(false);
    expect(
      findingWaiverExpiringSoon(
        finding({ waived: true, decision: { ...soon, expiresAt: '2027-01-01T00:00:00Z' } }),
        now
      )
    ).toBe(false);
  });
});

describe('offset paging', () => {
  it('states the window the way the address bar does', () => {
    expect(queueRangeLabel(0, 50, 213)).toBe('1–50 of 213 findings · page size 50');
    expect(queueRangeLabel(200, 50, 213)).toBe('201–213 of 213 findings · page size 50');
    expect(queueRangeLabel(0, 50, 1)).toBe('1–1 of 1 finding · page size 50');
    expect(queueRangeLabel(0, 50, 0)).toBe('No findings');
  });

  it('converts between an offset and a page number without ever leaving the list', () => {
    expect(queuePageNumber(0, 50)).toBe(1);
    expect(queuePageNumber(50, 50)).toBe(2);
    expect(queuePageNumber(-10, 50)).toBe(1);
    expect(queuePageCount(213, 50)).toBe(5);
    expect(queuePageCount(0, 50)).toBe(1);
    expect(queueOffsetForPage(3, 50)).toBe(100);
    expect(queueOffsetForPage(0, 50)).toBe(0);
  });

  it('counts what the Clear button would actually clear', () => {
    expect(clearableFilterCount(filters({ severity: ['error'], newOnly: true }))).toBe(2);
    // The project scope survives a clear, so it is not offered as one of them.
    expect(clearableFilterCount(filters({ projectId: 'p1', severity: ['error'] }))).toBe(1);
    expect(clearableFilterCount(filters({ projectId: 'p1' }))).toBe(0);
  });

  it('agrees with the page size the queue reads with', () => {
    expect(LINT_QUEUE_PAGE_SIZE).toBe(50);
  });
});

describe('bulk decisions', () => {
  it('offers the six verbs the mockup lists, in its order', () => {
    expect(BULK_VERBS.map((verb) => verb.label)).toEqual([
      'Acknowledge',
      'Mark fixed',
      'False positive',
      'Request waiver',
      'Approve waiver',
      'Reopen / reject',
    ]);
  });

  it('routes the two waiver verbs through the dialog and the rest straight to the write', () => {
    const dialogVerbs = BULK_VERBS.filter((verb) => verb.opensWaiverDialog);
    expect(dialogVerbs.map((verb) => verb.waiverMode)).toEqual(['request', 'approve']);
    expect(BULK_VERBS.filter((verb) => verb.title).map((verb) => verb.state)).toEqual([
      'waived',
      'open',
    ]);
  });

  it('offers Undo after a clean write', () => {
    expect(bulkToast(bulkResponse(), 'Acknowledge', 1)).toEqual({
      tone: 'success',
      title: 'Applied to 1 finding',
      description: 'Acknowledge · replays the previous states if you undo.',
      undoable: true,
    });
  });

  it('leads with the split and names the first error after a partial failure', () => {
    const partial = bulkResponse({
      appliedCount: 3,
      failedCount: 2,
      results: [
        ...bulkResponse().results,
        {
          sourceFingerprint: 'f9',
          projectId: null,
          decisionId: null,
          beforeState: null,
          afterState: null,
          ok: false,
          error: 'lint_findings:publish required',
        },
      ],
    });
    expect(bulkToast(partial, 'Approve waiver', 3)).toEqual({
      tone: 'warning',
      title: 'Applied to 3 of 5 findings',
      description: '2 refused — lint_findings:publish required',
      undoable: true,
    });
  });

  it('still offers Undo on a partial failure, because part of it did happen', () => {
    const partial = bulkResponse({ appliedCount: 1, failedCount: 1 });
    expect(bulkToast(partial, 'Acknowledge', 1).undoable).toBe(true);
    expect(bulkToast(partial, 'Acknowledge', 0).undoable).toBe(false);
  });

  it('says how many were refused even when the server gave no reason', () => {
    const partial = bulkResponse({
      appliedCount: 1,
      failedCount: 1,
      results: [
        {
          sourceFingerprint: 'f9',
          projectId: null,
          decisionId: null,
          beforeState: null,
          afterState: null,
          ok: false,
          error: null,
        },
      ],
    });
    expect(bulkToast(partial, 'Acknowledge', 0).description).toBe('1 refused.');
  });

  it('changes the waiver dialog’s three strings and its expiry rule by mode', () => {
    expect(waiverDialogCopy('request', 2)).toMatchObject({
      title: 'Request waiver for 2 findings',
      submitLabel: 'Request waiver',
      expiryRequired: false,
    });
    expect(waiverDialogCopy('approve', 1)).toMatchObject({
      title: 'Approve waiver for 1 finding',
      submitLabel: 'Approve waiver',
      expiryRequired: true,
    });
  });
});

describe('the remediation history', () => {
  it('coerces a malformed events payload without throwing', () => {
    expect(decisionEventsFromPayload(null)).toEqual([]);
    expect(decisionEventsFromPayload([{}, null])).toEqual([
      { id: '', beforeState: null, afterState: 'open', rationale: null, actorLabel: null, createdAt: null },
      { id: '', beforeState: null, afterState: 'open', rationale: null, actorLabel: null, createdAt: null },
    ]);
  });

  it('reads a transition as two labels and the first entry as its origin', () => {
    const [transition, origin] = decisionEventsFromPayload([
      {
        id: 'e1',
        beforeState: 'open',
        afterState: 'waiver_requested',
        rationale: 'Legacy partner',
        actorLabel: 'Linus Torvalds',
        createdAt: 'Aug 14, 2026',
      },
      { id: 'e2', afterState: 'open', createdAt: 'Aug 15, 2026' },
    ]);
    expect(decisionEventLines(transition)).toEqual({
      transition: 'Open → Waiver requested',
      rationale: '“Legacy partner”',
      meta: 'by Linus Torvalds · Aug 14, 2026',
    });
    expect(decisionEventLines(origin)).toEqual({
      transition: 'Recorded from evidence',
      rationale: null,
      meta: 'Aug 15, 2026',
    });
    expect(decisionEventTone(transition)).toBe('orange');
  });
});

describe('trends', () => {
  it('splits the six series between remediation and policy', () => {
    expect(TREND_SERIES.filter((spec) => spec.group === 'remediation').map((s) => s.key)).toEqual([
      'newFindings',
      'remediatedFindings',
    ]);
    expect(TREND_SERIES.filter((spec) => spec.group === 'policy')).toHaveLength(4);
  });

  it('totals a series over the window it was read for', () => {
    const spec = TREND_SERIES[0];
    expect(trendSeriesData(trends(3), spec)).toEqual({ values: [1, 2, 3], total: 6, days: 30 });
  });
});

describe('quality ranks', () => {
  it('offers the four windows the server can answer', () => {
    expect([...QUALITY_RANK_WINDOWS]).toEqual([7, 30, 90, 180]);
  });

  it('scales the histogram to its own tallest bar and keeps the empty buckets', () => {
    const bars = gradeBars({ A: 11, B: 20, C: 8, D: 3, F: 0, ungraded: 2 });
    expect(bars.map((bar) => bar.key)).toEqual([...RANK_GRADE_BUCKETS]);
    expect(bars.find((bar) => bar.key === 'B')?.percent).toBe(100);
    expect(bars.find((bar) => bar.key === 'A')?.percent).toBe(55);
    expect(bars.find((bar) => bar.key === 'F')).toMatchObject({ count: 0, percent: 0 });
    expect(bars.at(-1)?.label).toBe(NO_VALUE);
  });

  it('draws six flat bars rather than dividing by nothing', () => {
    expect(gradeBars({}).every((bar) => bar.percent === 0)).toBe(true);
  });

  it('says a format never drifted rather than calling it unchanged', () => {
    expect(driftSpec(null)).toMatchObject({ direction: 'none', tone: 'outline' });
    expect(driftSpec(6)).toMatchObject({ direction: 'up', label: '+6 pts over the window', tone: 'ok' });
    expect(driftSpec(-4)).toMatchObject({ direction: 'down', label: '-4 pts over the window', tone: 'danger' });
    expect(driftSpec(0)).toMatchObject({ direction: 'flat', tone: 'neutral' });
  });

  it('splits findings between the adapter and the document, and says which is which', () => {
    const spec = attributionSpec(rankFormat());
    expect(spec).toMatchObject({ adapterPercent: 38, specPercent: 62 });
    expect(spec.summary).toBe('38% adapter · 62% specification');
    expect(spec.detail).toContain('41 adapter-attributable');
    expect(spec.detail).toContain('2 constructs this adapter declares it cannot read yet');
  });

  it('reports no share at all when a format produced no findings', () => {
    const empty = attributionSpec(
      rankFormat({ adapterFindingCount: 0, specFindingCount: 0, declaredParserLimits: 0 })
    );
    expect(empty).toMatchObject({ adapterPercent: null, specPercent: null });
    expect(empty.summary).toBe('No findings recorded');
  });

  it('reports the outcomes an import has and the ones an export has', () => {
    expect(rankStats(rankFormat()).map((stat) => stat.label)).toEqual([
      'Average score',
      'Blocked',
      'Warned',
    ]);
    expect(
      rankStats(rankFormat({ scope: 'export', averageReadiness: 96, bestRank: 1 })).map(
        (stat) => stat.label
      )
    ).toEqual(['Average score', 'Average readiness', 'Best rank']);
  });

  it('labels a scope, including one it has not been taught', () => {
    expect(scopeLabel('import')).toBe('Import');
    expect(scopeLabel('export')).toBe('Export');
    expect(scopeLabel('')).toBe('Unknown');
    expect(scopeLabel('preflight')).toBe('preflight');
  });

  it('summarises the window the grades were recorded in', () => {
    expect(rankWindowSummary(rankSeries())).toBe(
      '73 grades recorded between Jul 16 and Aug 15 · 42 pre-flight · 31 committed'
    );
    expect(rankWindowSummary(rankSeries({ observationCount: 1, stages: {} }))).toContain(
      '1 grade recorded'
    );
  });
});
