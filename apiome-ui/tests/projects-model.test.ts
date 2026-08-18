/**
 * The Projects screen's decisions (HIVE-6.1, #5312).
 *
 * `projects-hive-redesign.test.tsx` renders the screen that makes these decisions and
 * `projects-css.test.ts` pins the declarations that draw them; this pins the decisions
 * themselves, which before this ticket lived inside a 1,731-line component and could only be
 * reached by rendering it.
 *
 * What is worth pinning here is what the two views have to agree about — the ticket's first
 * acceptance criterion is that they "render the same data set and honour the same filters",
 * and the way that is made true is that both call these functions:
 *
 *   1. **the score ladder** — empty beats local history beats the server's mean, which is the
 *      rule the card and the table used to implement separately (and disagree about);
 *   2. **the facets**, including the deliberate overlap between *Deleted* and *Needs
 *      attention*: the chips narrow the list, they do not partition it;
 *   3. **the header sentence**, whose deleted count appears only while the switch is on;
 *   4. **the permanent-delete gate**, which is the ticket's "permanent requires typing the
 *      slug" — and which used to be two identical native confirms;
 *   5. **the bulk split**, and the sentence a partial failure gets.
 */

import {
  DEFAULT_PROJECT_SORT,
  PROJECT_FACETS,
  PROJECT_FACET_LABELS,
  PROJECT_LIFECYCLE_LABEL,
  PROJECT_SORT_OPTIONS,
  bulkResultMessage,
  isProjectOpenable,
  isProjectSortColumn,
  latestQualityByProject,
  matchesProjectFacet,
  permanentDeleteProjectConfirm,
  projectBulkPlan,
  projectDomainLabel,
  projectFacetCounts,
  projectLifecycle,
  projectScores,
  projectShortId,
  projectSortKey,
  projectSortLabel,
  projectSummaryText,
  projectVersionsHref,
  projectVersionsLabel,
  projectsFootLabel,
  projectsSummaryLine,
  searchProjects,
  softDeleteProjectConfirm,
  sortProjects,
  undeleteProjectConfirm,
  type Project,
} from '../src/app/components/ade/projects/projectsModel';
import type { ProjectQualitySnapshot } from '../src/app/utils/project-quality-score-history';

/**
 * A project, with only the fields a test cares about spelled out.
 *
 * @param overrides What this particular row differs by.
 * @returns The row.
 */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: '8f2a1c00-0000-4000-8000-000000000001',
    tenant_id: 'tenant-1',
    creator_id: 'user-1',
    name: 'Payments API',
    slug: 'payments-api',
    description: 'Card, refund and payout endpoints for the merchant platform.',
    enabled: true,
    deleted_at: null,
    created_at: '2026-06-01T10:00:00.000Z',
    updated_at: '2026-08-15T09:12:00.000Z',
    creator_name: 'Ada Lovelace',
    creator_email: 'ada@example.com',
    versionsCount: 6,
    qualityScore: 88,
    qualityGrade: 'B',
    ...overrides,
  };
}

/** A browser-local snapshot. */
function snapshot(overall: number, grade: ProjectQualitySnapshot['grade'] = 'B'): ProjectQualitySnapshot {
  return { recordedAt: '2026-08-15T09:12:00.000Z', overall, grade };
}

describe('lifecycle', () => {
  it('reports the outer state, so a deleted project never reads as merely disabled', () => {
    expect(projectLifecycle(makeProject())).toBe('active');
    expect(projectLifecycle(makeProject({ enabled: false }))).toBe('disabled');
    expect(
      projectLifecycle(makeProject({ enabled: false, deleted_at: '2026-08-09T00:00:00Z' }))
    ).toBe('deleted');
  });

  it('labels every state', () => {
    expect(PROJECT_LIFECYCLE_LABEL).toEqual({
      active: 'Active',
      disabled: 'Disabled',
      deleted: 'Deleted',
    });
  });

  it('refuses to open a deleted project, because its versions are hidden with it', () => {
    expect(isProjectOpenable(makeProject())).toBe(true);
    expect(isProjectOpenable(makeProject({ enabled: false }))).toBe(true);
    expect(isProjectOpenable(makeProject({ deleted_at: '2026-08-09T00:00:00Z' }))).toBe(false);
  });

  it('routes to versions by id, url-encoded', () => {
    expect(projectVersionsHref(makeProject({ id: 'a b' }))).toBe(
      '/ade/dashboard/versions?projectId=a%20b'
    );
  });
});

describe('facets', () => {
  const active = makeProject({ id: 'p-active' });
  const disabled = makeProject({ id: 'p-disabled', enabled: false });
  const deleted = makeProject({ id: 'p-deleted', deleted_at: '2026-08-09T00:00:00Z' });
  const rows = [active, disabled, deleted];

  it("lists the mockup's four chips, in its order", () => {
    expect(PROJECT_FACETS).toEqual(['all', 'active', 'attention', 'deleted']);
    expect(PROJECT_FACET_LABELS.attention).toBe('Needs attention');
  });

  it('counts a deleted project under both Deleted and Needs attention', () => {
    // Deliberate: the chips narrow the list rather than partitioning it, and a deleted
    // project is exactly a project that needs attention.
    expect(projectFacetCounts(rows)).toEqual({ all: 3, active: 1, attention: 2, deleted: 1 });
  });

  it('keeps only what each chip claims', () => {
    expect(rows.filter((row) => matchesProjectFacet(row, 'active'))).toEqual([active]);
    expect(rows.filter((row) => matchesProjectFacet(row, 'attention'))).toEqual([
      disabled,
      deleted,
    ]);
    expect(rows.filter((row) => matchesProjectFacet(row, 'deleted'))).toEqual([deleted]);
    expect(rows.filter((row) => matchesProjectFacet(row, 'all'))).toEqual(rows);
  });
});

describe('search', () => {
  const rows = [
    makeProject({ id: 'a', name: 'Payments API', slug: 'payments-api', description: 'Refunds.' }),
    makeProject({
      id: 'b',
      name: 'Orders Service',
      slug: 'orders-service',
      description: 'Cart to fulfilment.',
      metadata: { summary: 'Merchant order lifecycle' },
    }),
  ];

  it('returns everything for a blank query', () => {
    expect(searchProjects(rows, '   ')).toEqual(rows);
  });

  it('matches the name, the slug, the description and the OpenAPI summary', () => {
    expect(searchProjects(rows, 'PAYMENTS').map((row) => row.id)).toEqual(['a']);
    expect(searchProjects(rows, 'orders-service').map((row) => row.id)).toEqual(['b']);
    expect(searchProjects(rows, 'refunds').map((row) => row.id)).toEqual(['a']);
    // The summary is what the card prints, so it is what the reader is searching against.
    expect(searchProjects(rows, 'lifecycle').map((row) => row.id)).toEqual(['b']);
  });
});

describe('scores — the ladder both views climb', () => {
  it('never scores an empty project, even when stale local history exists', () => {
    const scores = projectScores(
      makeProject({ versionsCount: 0, qualityScore: 94, qualityGrade: 'A' }),
      [snapshot(72)]
    );
    expect(scores).toMatchObject({ isEmpty: true, quality: null, grade: null, versionsCount: 0 });
    expect(scores.history).toEqual([]);
  });

  it('prefers the browser-local trend over the server mean', () => {
    const scores = projectScores(makeProject({ qualityScore: 94, qualityGrade: 'A' }), [
      snapshot(60),
      snapshot(72),
    ]);
    expect(scores.quality).toBe(72);
    expect(scores.grade).toBe('B');
  });

  it('falls back to the server mean when this browser has never imported', () => {
    expect(projectScores(makeProject({ qualityScore: 88, qualityGrade: 'B' }), []).quality).toBe(88);
  });

  it('derives the letter from the score when the server kept none', () => {
    expect(projectScores(makeProject({ qualityScore: 82, qualityGrade: null }), []).grade).toBe('B');
    expect(projectScores(makeProject({ qualityScore: 95, qualityGrade: '  ' }), []).grade).toBe('A');
  });

  it('reports no score at all rather than zero when nothing has measured it', () => {
    const scores = projectScores(makeProject({ qualityScore: null, qualityGrade: null }), []);
    expect(scores.quality).toBeNull();
    expect(scores.grade).toBeNull();
    expect(scores.isEmpty).toBe(false);
  });

  it('maps every project for the sorter and the header average', () => {
    expect(
      latestQualityByProject(
        [makeProject({ id: 'a' }), makeProject({ id: 'b', versionsCount: 0 })],
        { a: [snapshot(70)] }
      )
    ).toEqual({ a: 70, b: null });
  });
});

describe('the header sentence', () => {
  const rows = [
    makeProject({ id: 'a' }),
    makeProject({ id: 'b' }),
    makeProject({ id: 'c', enabled: false }),
    makeProject({ id: 'd', deleted_at: '2026-08-09T00:00:00Z' }),
  ];
  const quality = { a: 88, b: 94, c: 63, d: null };

  it("reads the mockup's sentence when deleted rows are showing", () => {
    expect(projectsSummaryLine(rows, quality, true)).toBe(
      '4 projects · avg quality 82 · 2 active · 1 deleted'
    );
  });

  it('omits the deleted count while the switch is off, so it cannot name unseen rows', () => {
    expect(projectsSummaryLine(rows, quality, false)).toBe(
      '4 projects · avg quality 82 · 2 active'
    );
  });

  it('omits the average when nothing is scored, rather than printing zero', () => {
    expect(projectsSummaryLine([makeProject()], {}, false)).toBe('1 project · 1 active');
  });
});

describe('labels', () => {
  it('prints six hex characters of the uuid, as the mockup does', () => {
    expect(projectShortId('8f2a1c00-0000-4000-8000-000000000001')).toBe('prj_8f2a1c');
  });

  it('pluralises the version count', () => {
    expect(projectVersionsLabel(0)).toBe('0 versions');
    expect(projectVersionsLabel(1)).toBe('1 version');
    expect(projectVersionsLabel(6)).toBe('6 versions');
  });

  it('prefers the OpenAPI summary, then the description, and never an empty paragraph', () => {
    expect(projectSummaryText(makeProject({ metadata: { summary: 'One line' } }))).toBe('One line');
    expect(projectSummaryText(makeProject({ description: 'Two lines' }))).toBe('Two lines');
    expect(projectSummaryText(makeProject({ description: '   ' }))).toBe('No description yet.');
  });

  it('resolves the domain-category pill, and draws none for an uncategorised project', () => {
    expect(projectDomainLabel(makeProject({ metadata: { domainCategory: 'finance' } }))).toMatch(
      /^Finance/
    );
    expect(projectDomainLabel(makeProject())).toBeUndefined();
  });
});

describe('sorting', () => {
  it("starts on the mockup's `name ↑`", () => {
    expect(DEFAULT_PROJECT_SORT).toEqual({ column: 'name', direction: 'asc' });
  });

  it('offers every comparator, including the Created column the table drops', () => {
    expect(PROJECT_SORT_OPTIONS.map((option) => option.id)).toEqual([
      'name',
      'description',
      'quality',
      'versions',
      'status',
      'creator',
      'created',
      'updated',
    ]);
  });

  it('falls back to the default for a cleared sort or an unsortable column', () => {
    expect(projectSortKey(null)).toEqual({ column: 'name', direction: 'asc' });
    expect(projectSortKey({ column: 'actions', direction: 'desc' })).toEqual({
      column: 'name',
      direction: 'asc',
    });
    expect(isProjectSortColumn('actions')).toBe(false);
    expect(isProjectSortColumn('quality')).toBe(true);
  });

  it('orders by the requested column, with quality nulls last in both directions', () => {
    const rows = [
      makeProject({ id: 'a', name: 'Beta' }),
      makeProject({ id: 'b', name: 'Alpha' }),
      makeProject({ id: 'c', name: 'Gamma', versionsCount: 0 }),
    ];
    expect(sortProjects(rows, { column: 'name', direction: 'asc' }, {}).map((r) => r.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    const quality = { a: 60, b: 90, c: null };
    expect(
      sortProjects(rows, { column: 'quality', direction: 'desc' }, quality).map((r) => r.id)
    ).toEqual(['b', 'a', 'c']);
  });

  it('says what it is sorted by, in the toolbar and in the foot', () => {
    expect(projectSortLabel({ column: 'updated', direction: 'desc' })).toBe('updated ↓');
    expect(projectSortLabel({ column: 'creator', direction: 'asc' })).toBe('created by ↑');
    expect(projectsFootLabel(4, DEFAULT_PROJECT_SORT)).toBe('4 projects · sorted by name ↑');
    expect(projectsFootLabel(1, DEFAULT_PROJECT_SORT)).toBe('1 project · sorted by name ↑');
  });
});

describe('the three confirms', () => {
  it('gates a permanent delete on the slug, not the display name', () => {
    // The ticket's acceptance criterion. A slug is unique in the workspace and is printed on
    // the card the click came from; two projects may share a display name.
    const options = permanentDeleteProjectConfirm(makeProject());
    expect(options.typeToConfirm).toBe('payments-api');
    expect(options.title).toBe('Permanently delete project "Payments API"?');
    expect(options.variant).toBe('danger');
    expect(options.confirmLabel).toBe('Delete everything');
    expect(options.consequence).toBe('This is permanent and cannot be undone.');
  });

  it('falls back to the name rather than opening an ungated confirm', () => {
    expect(permanentDeleteProjectConfirm(makeProject({ slug: '  ' })).typeToConfirm).toBe(
      'Payments API'
    );
    expect(permanentDeleteProjectConfirm(makeProject({ slug: undefined })).typeToConfirm).toBe(
      'Payments API'
    );
  });

  it('does not gate a soft delete, and says how to undo it instead', () => {
    const options = softDeleteProjectConfirm(makeProject());
    expect(options.typeToConfirm).toBeUndefined();
    expect(options.message).toContain('Show deleted');
    expect(options.confirmLabel).toBe('Delete project');
  });

  it('confirms an undelete without dressing it as destruction', () => {
    const options = undeleteProjectConfirm(makeProject());
    expect(options.variant).toBe('info');
    expect(options.confirmLabel).toBe('Undelete project');
    expect(options.title).toBe('Undelete project "Payments API"?');
  });
});

describe('bulk actions', () => {
  const live = makeProject({ id: 'live' });
  const gone = makeProject({ id: 'gone', deleted_at: '2026-08-09T00:00:00Z' });

  it('splits a mixed selection into the verb each row can take', () => {
    expect(projectBulkPlan([live, gone], ['live', 'gone'])).toEqual({
      deletable: [live],
      restorable: [gone],
    });
  });

  it('ignores ids that are not on screen', () => {
    expect(projectBulkPlan([live], ['live', 'filtered-away'])).toEqual({
      deletable: [live],
      restorable: [],
    });
  });

  it('states the split, and names the first refusal, when a batch is partly applied', () => {
    expect(bulkResultMessage('Deleted', 5, 5)).toBe('Deleted 5 projects.');
    expect(bulkResultMessage('Undeleted', 1, 1)).toBe('Undeleted 1 project.');
    expect(bulkResultMessage('Deleted', 3, 5, 'projects:delete required')).toBe(
      'Deleted 3 of 5 projects · 2 refused — projects:delete required'
    );
    expect(bulkResultMessage('Deleted', 0, 2, null)).toBe('Deleted 0 of 2 projects · 2 refused');
  });
});
