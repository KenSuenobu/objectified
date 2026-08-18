/**
 * The rules behind the Versions redesign (HIVE-6.2, #5313), unit-tested without a render.
 *
 * `versionsModel.ts` is where the screen's decisions live now — the words on the pills, the
 * quick chips and their counts, the sort bridging, the foot sentence, the three banners, the
 * three confirms, and the two rules the ticket adds: how a `FEATURE_GITLIKE` affordance is
 * treated per build, and which row-menu items a revision gets. Each is a pure function, so
 * each is pinned here as data.
 */

import type { VersionChangelogSummary } from '@lib/version-changelog';

import {
  DEFAULT_VERSIONS_SORT,
  GITLIKE_FLAG_TITLE,
  VERSION_FACETS,
  changelogFirstLine,
  compatibilityBanner,
  deleteVersionConfirm,
  deprecationBanner,
  formatSunsetUtc,
  formatVersionDate,
  formatVersionStamp,
  freezeSchemaConfirm,
  gitlikeAffordance,
  headRevisionBadge,
  isVersionBranchNonDeletable,
  lastPublishedVersion,
  matchesVersionFacet,
  newestPublishedSummary,
  nextVersionsSort,
  revisionDeprecationMeta,
  shortRevisionId,
  sortVersions,
  storedQualityBadge,
  unpublishVersionConfirm,
  versionFacetCounts,
  versionLabel,
  versionLifecycle,
  versionMockLabel,
  versionRowMenuItems,
  versionRowQuickActions,
  versionStatus,
  versionsFootLabel,
  versionsHeadLine,
  versionsSortFromMenu,
  versionsSortLabel,
  whatsNewBanner,
  type Version,
  type VersionRowMenuContext,
} from '../src/app/components/ade/versions/versionsModel';

// ---------------------------------------------------------------------------------------
// Fixtures — the mockup's six revisions of Payments API
// ---------------------------------------------------------------------------------------

const BASE: Version = {
  id: '00000000-0000-4000-8000-000000000000',
  project_id: 'prj_8f2a1c',
  creator_id: 'u-ada',
  version_id: '0.0.0',
  shortMessage: null,
  changelog: null,
  enabled: true,
  published: false,
  deleted_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  published_at: null,
  creator_name: 'Ada Lovelace',
  creator_email: 'ada@example.com',
};

const HEAD_DRAFT: Version = {
  ...BASE,
  id: '9d3f7a21-0000-4000-8000-000000000001',
  version_id: '2.4.0',
  shortMessage: 'Add refund reasons and payout webhooks',
  changelog: '- added: RefundReason enum\n- added: payout.settled event',
  created_at: '2026-08-15T09:12:00.000Z',
  qualityScore: 88,
  qualityGrade: 'B',
};

const PUBLISHED_231: Version = {
  ...BASE,
  id: '4c8e1b09-0000-4000-8000-000000000002',
  version_id: '2.3.1',
  shortMessage: 'Patch: fix Refund.amount minimum',
  published: true,
  published_at: '2026-08-03T10:00:00.000Z',
  created_at: '2026-08-02T16:40:00.000Z',
  creator_id: 'u-grace',
  creator_name: 'Grace Hopper',
  creator_email: 'grace@example.com',
  qualityScore: 94,
  qualityGrade: 'A',
  mockEnabled: true,
  mockBaseUrl: 'https://mock.apiome.dev/acme/payments-api/2.3.1',
};

const PUBLISHED_230_DISABLED: Version = {
  ...BASE,
  id: '77ab0c5e-0000-4000-8000-000000000003',
  version_id: '2.3.0',
  shortMessage: 'Payouts resource + settlement reports',
  published: true,
  published_at: '2026-07-22T00:00:00.000Z',
  created_at: '2026-07-21T11:30:00.000Z',
  enabled: false,
  creator_id: 'u-linus',
  creator_name: 'Linus Torvalds',
  creator_email: 'linus@example.com',
};

const DEPRECATED_220: Version = {
  ...BASE,
  id: 'ded00000-0000-4000-8000-000000000004',
  version_id: '2.2.0',
  shortMessage: 'Card tokenisation + 3DS challenge flow',
  published: true,
  published_at: '2026-06-11T00:00:00.000Z',
  created_at: '2026-06-10T14:15:00.000Z',
  lifecycle: 'deprecated',
  metadata: {
    sunsetAt: '2026-09-30T00:00:00.000Z',
    successorRevisionId: PUBLISHED_231.id,
    deprecationMessage: 'Migrate to /payment-intents before sunset.',
  },
  forkedFromRevisionId: 'ffff0000-0000-4000-8000-000000000009',
  forkSourceVersionLabel: '1.9.0',
  forkSourceProjectName: 'Orders Service',
};

const ARCHIVED_210_LOCKED: Version = {
  ...BASE,
  id: '1f0e9d88-0000-4000-8000-000000000005',
  version_id: '2.1.0',
  shortMessage: 'Initial public release',
  published: true,
  published_at: '2026-03-02T10:00:00.000Z',
  created_at: '2026-03-02T10:00:00.000Z',
  lifecycle: 'archived',
  revisionLocked: true,
};

const BETA_DRAFT: Version = {
  ...BASE,
  id: 'b3d1e6a0-0000-4000-8000-000000000006',
  version_id: '2.0.0-beta.1',
  shortMessage: 'Experimental: instant payouts',
  created_at: '2026-02-14T15:48:00.000Z',
  lifecycle: 'beta',
  creator_id: 'u-linus',
  mockEnabled: true,
  mockPrivate: true,
};

const ALL = [HEAD_DRAFT, PUBLISHED_231, PUBLISHED_230_DISABLED, DEPRECATED_220, ARCHIVED_210_LOCKED, BETA_DRAFT];

const CONTEXT: VersionRowMenuContext = {
  headRevisionId: HEAD_DRAFT.id,
  effectiveIsAdmin: false,
  currentUserId: 'u-ada',
  hasBranches: false,
  schemaFrozen: false,
  publishable: true,
  freezing: false,
  gitlike: { flagOn: true, visible: true, marked: false, enabled: true },
};

// ---------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------

describe('lifecycle, status and labels', () => {
  it('normalises the lifecycle, defaulting anything unknown to stable', () => {
    expect(versionLifecycle({ lifecycle: undefined })).toBe('stable');
    expect(versionLifecycle({ lifecycle: 'Deprecated ' })).toBe('deprecated');
    expect(versionLifecycle({ lifecycle: 'weird' })).toBe('stable');
    expect(versionLifecycle(BETA_DRAFT)).toBe('beta');
    expect(versionLifecycle(ARCHIVED_210_LOCKED)).toBe('archived');
  });

  it('reads publication as one of the two vocabulary words', () => {
    expect(versionStatus(HEAD_DRAFT)).toBe('draft');
    expect(versionStatus(PUBLISHED_231)).toBe('published');
  });

  it('prefixes the version once and never twice', () => {
    expect(versionLabel(HEAD_DRAFT)).toBe('v2.4.0');
    expect(versionLabel({ version_id: 'v1' })).toBe('v1');
  });

  it('shortens a revision id to its first eight characters', () => {
    expect(shortRevisionId(HEAD_DRAFT.id)).toBe('9d3f7a21');
  });

  it('says what the mock switch is doing in the words the mockup uses', () => {
    expect(versionMockLabel(true, true, false)).toBe('Mock on');
    expect(versionMockLabel(false, true, true)).toBe('Private mock on');
    expect(versionMockLabel(true, false, false)).toBe('Mock off');
    expect(versionMockLabel(false, false, false)).toBe('Draft mock off');
  });

  it('withholds Remove from the default branch and from main', () => {
    expect(isVersionBranchNonDeletable({ name: 'main' })).toBe(true);
    expect(isVersionBranchNonDeletable({ name: 'feature', is_default: true })).toBe(true);
    expect(isVersionBranchNonDeletable({ name: 'feature/payouts' })).toBe(false);
  });
});

describe('stamps', () => {
  it('prints MM/DD/YY hh:mm and a bare date, and a dash for nothing', () => {
    expect(formatVersionStamp('2026-08-15T09:12:00.000Z')).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2} [AP]M$/);
    expect(formatVersionDate('2026-08-03T10:00:00.000Z')).toMatch(/^\d{2}\/\d{2}\/\d{2}$/);
    expect(formatVersionStamp(null)).toBe('—');
    expect(formatVersionStamp('not a date')).toBe('—');
    expect(formatVersionDate(undefined)).toBe('—');
  });

  it('prints a sunset in UTC, the way the timeline does', () => {
    expect(formatSunsetUtc('2026-09-30T00:00:00.000Z')).toBe('30 Sep 2026 00:00 UTC');
    expect(formatSunsetUtc('garbage')).toBe('garbage');
  });
});

// ---------------------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------------------

describe('the quick chips', () => {
  it('lists All · Drafts · Published in that order', () => {
    expect(VERSION_FACETS).toEqual(['all', 'drafts', 'published']);
  });

  it('matches rows by publication', () => {
    expect(matchesVersionFacet(HEAD_DRAFT, 'all')).toBe(true);
    expect(matchesVersionFacet(HEAD_DRAFT, 'drafts')).toBe(true);
    expect(matchesVersionFacet(HEAD_DRAFT, 'published')).toBe(false);
    expect(matchesVersionFacet(PUBLISHED_231, 'published')).toBe(true);
  });

  it('counts the mockup as 6 · 2 · 4', () => {
    expect(versionFacetCounts(ALL)).toEqual({ all: 6, drafts: 2, published: 4 });
  });
});

// ---------------------------------------------------------------------------------------
// Sort bridging
// ---------------------------------------------------------------------------------------

describe('sort bridging', () => {
  it('starts newest first, which is the API order', () => {
    expect(DEFAULT_VERSIONS_SORT).toEqual({ column: 'created', direction: 'desc' });
  });

  it('reads the primitive’s unsorted step as a flip, so a header only ever toggles', () => {
    expect(nextVersionsSort({ column: 'created', direction: 'desc' }, null)).toEqual({
      column: 'created',
      direction: 'asc',
    });
    expect(nextVersionsSort({ column: 'created', direction: 'asc' }, null)).toEqual({
      column: 'created',
      direction: 'desc',
    });
  });

  it('accepts a sortable column and ignores one it does not know', () => {
    expect(nextVersionsSort(DEFAULT_VERSIONS_SORT, { column: 'version', direction: 'asc' })).toEqual({
      column: 'version',
      direction: 'asc',
    });
    expect(nextVersionsSort(DEFAULT_VERSIONS_SORT, { column: 'mock', direction: 'asc' })).toEqual(
      DEFAULT_VERSIONS_SORT
    );
  });

  it('starts a new column ascending from the menu and flips the same one', () => {
    expect(versionsSortFromMenu(DEFAULT_VERSIONS_SORT, 'status')).toEqual({ column: 'status', direction: 'asc' });
    expect(versionsSortFromMenu(DEFAULT_VERSIONS_SORT, 'created')).toEqual({ column: 'created', direction: 'asc' });
  });

  it('sorts through the timeline’s own comparator', () => {
    const byVersionAsc = sortVersions(ALL, { column: 'version', direction: 'asc' }).map((v) => v.version_id);
    expect(byVersionAsc).toEqual(['2.0.0-beta.1', '2.1.0', '2.2.0', '2.3.0', '2.3.1', '2.4.0']);
    const newestFirst = sortVersions(ALL, DEFAULT_VERSIONS_SORT).map((v) => v.version_id);
    expect(newestFirst[0]).toBe('2.4.0');
    expect(newestFirst[newestFirst.length - 1]).toBe('2.0.0-beta.1');
  });

  it('says the sort and the foot the way the mockup does', () => {
    expect(versionsSortLabel(DEFAULT_VERSIONS_SORT)).toBe('created ↓');
    expect(versionsSortLabel({ column: 'revision', direction: 'asc' })).toBe('revision / changelog ↑');
    expect(versionsFootLabel(6, DEFAULT_VERSIONS_SORT, '')).toBe(
      '6 revisions · sorted by created ↓ · lifecycle filter: all'
    );
    expect(versionsFootLabel(1, DEFAULT_VERSIONS_SORT, 'beta')).toBe(
      '1 revision · sorted by created ↓ · lifecycle filter: beta'
    );
  });
});

// ---------------------------------------------------------------------------------------
// Head and last published
// ---------------------------------------------------------------------------------------

describe('head and last published', () => {
  it('finds the newest published revision by publish time', () => {
    expect(lastPublishedVersion(ALL)?.version_id).toBe('2.3.1');
    expect(lastPublishedVersion([HEAD_DRAFT, BETA_DRAFT])).toBeNull();
  });

  it('labels both ends of the line', () => {
    expect(versionsHeadLine(ALL, HEAD_DRAFT.id)).toEqual({ head: 'v2.4.0', lastPublished: 'v2.3.1' });
    expect(versionsHeadLine([], null)).toEqual({ head: null, lastPublished: null });
  });

  it('badges the head with its label and publication state', () => {
    expect(headRevisionBadge(ALL, HEAD_DRAFT.id)).toEqual({
      label: 'v2.4.0 draft',
      status: 'draft',
      title: 'Head revision v2.4.0 is a draft',
    });
    expect(headRevisionBadge(ALL, PUBLISHED_231.id)?.label).toBe('v2.3.1 published');
    expect(headRevisionBadge(ALL, 'nope')).toBeNull();
  });

  it('badges the stored quality, and nothing for an unscored revision', () => {
    expect(storedQualityBadge(HEAD_DRAFT)).toEqual({ label: 'B · 88', grade: 'B', score: 88 });
    expect(storedQualityBadge(ARCHIVED_210_LOCKED)).toBeNull();
    expect(storedQualityBadge(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------------------

describe('the banners', () => {
  it('reads deprecation metadata under every spelling the API has used', () => {
    expect(revisionDeprecationMeta(DEPRECATED_220)).toEqual({
      sunsetAt: '2026-09-30T00:00:00.000Z',
      successorRevisionId: PUBLISHED_231.id,
      message: 'Migrate to /payment-intents before sunset.',
    });
    expect(
      revisionDeprecationMeta({ metadata: { sunset_date: '2027-01-01T00:00:00.000Z', successor_revision_id: 'x', message: 'm' } })
    ).toEqual({ sunsetAt: '2027-01-01T00:00:00.000Z', successorRevisionId: 'x', message: 'm' });
    expect(revisionDeprecationMeta({})).toEqual({ sunsetAt: null, successorRevisionId: null, message: null });
  });

  it('builds the deprecation banner from the newest deprecated revision', () => {
    expect(deprecationBanner(ALL)).toEqual({
      versionId: DEPRECATED_220.id,
      versionLabel: 'v2.2.0',
      sunsetLabel: '30 Sep 2026 00:00 UTC',
      successorLabel: 'v2.3.1',
      message: 'Migrate to /payment-intents before sunset.',
    });
  });

  it('shows no deprecation banner when nothing is deprecated, or when a deprecated revision has nothing to say', () => {
    expect(deprecationBanner([HEAD_DRAFT, PUBLISHED_231])).toBeNull();
    expect(deprecationBanner([{ ...DEPRECATED_220, metadata: {} }])).toBeNull();
  });

  it('takes the first line of a changelog without its list marker', () => {
    expect(changelogFirstLine('- added: RefundReason enum\n- more')).toBe('added: RefundReason enum');
    expect(changelogFirstLine('\n\n* fixed: x')).toBe('fixed: x');
    expect(changelogFirstLine(null)).toBe('');
  });

  it('builds the what’s-new banner from the head, and nothing when the head is silent', () => {
    expect(whatsNewBanner(ALL, HEAD_DRAFT.id)).toEqual({
      versionId: HEAD_DRAFT.id,
      versionLabel: 'v2.4.0',
      status: 'draft',
      summary: 'Add refund reasons and payout webhooks',
    });
    expect(whatsNewBanner([{ ...HEAD_DRAFT, shortMessage: null }], HEAD_DRAFT.id)?.summary).toBe(
      'added: RefundReason enum'
    );
    expect(whatsNewBanner([{ ...HEAD_DRAFT, shortMessage: null, changelog: null }], HEAD_DRAFT.id)).toBeNull();
    expect(whatsNewBanner(ALL, null)).toBeNull();
  });

  const summary = (over: Partial<VersionChangelogSummary>): VersionChangelogSummary => ({
    publishedRevisionId: PUBLISHED_231.id,
    versionLabel: '2.3.1',
    publishedAt: PUBLISHED_231.published_at,
    baselineRevisionId: PUBLISHED_230_DISABLED.id,
    baselineVersionLabel: '2.3.0',
    status: 'ready',
    maxSeverity: 'non-breaking',
    counts: { 'non-breaking': 2, 'docs-only': 1 },
    ...over,
  });

  it('reads a compatible classification as Compatible', () => {
    expect(compatibilityBanner(summary({}))).toEqual({
      tone: 'ok',
      title: 'Compatible.',
      body: 'v2.3.0 → v2.3.1 has 2 non-breaking · 1 docs-only and no breaking changes.',
      publishedRevisionId: PUBLISHED_231.id,
    });
  });

  it('reads a breaking classification as danger, an initial one as neutral, and a pending one as pending', () => {
    expect(compatibilityBanner(summary({ counts: { breaking: 1 }, maxSeverity: 'breaking' }))).toMatchObject({
      tone: 'danger',
      title: 'Breaking changes.',
    });
    expect(compatibilityBanner(summary({ status: 'initial' }))).toMatchObject({
      tone: 'neutral',
      title: 'Initial publication.',
    });
    expect(compatibilityBanner(summary({ status: null }))).toMatchObject({
      tone: 'neutral',
      title: 'Classification pending.',
    });
    expect(compatibilityBanner(summary({ status: 'failed' }))).toMatchObject({ tone: 'warn' });
    expect(compatibilityBanner(null)).toBeNull();
  });

  it('picks the newest published revision’s summary out of the list', () => {
    const older = summary({ publishedRevisionId: PUBLISHED_230_DISABLED.id, versionLabel: '2.3.0' });
    const newest = summary({});
    expect(newestPublishedSummary([older, newest], ALL)).toBe(newest);
    // With no matching revision, the newest publish time wins.
    expect(
      newestPublishedSummary(
        [
          summary({ publishedRevisionId: 'a', publishedAt: '2026-01-01T00:00:00.000Z' }),
          summary({ publishedRevisionId: 'b', publishedAt: '2026-02-01T00:00:00.000Z' }),
        ],
        []
      )?.publishedRevisionId
    ).toBe('b');
    expect(newestPublishedSummary([], ALL)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Confirms
// ---------------------------------------------------------------------------------------

describe('the confirms', () => {
  it('names the version in the delete confirm and states the consequence', () => {
    expect(deleteVersionConfirm(BETA_DRAFT)).toMatchObject({
      title: 'Delete version "v2.0.0-beta.1"?',
      message: 'This action cannot be undone.',
      variant: 'danger',
      confirmLabel: 'Delete',
    });
  });

  it('names the version in the unpublish confirm and says what consumers see', () => {
    const options = unpublishVersionConfirm(PUBLISHED_231);
    expect(options.title).toBe('Unpublish "v2.3.1"?');
    expect(options.message).toContain('404');
    expect(options.variant).toBe('danger');
    expect(options.confirmLabel).toBe('Unpublish');
  });

  it('keeps the freeze confirm informational and names the version', () => {
    expect(freezeSchemaConfirm(HEAD_DRAFT)).toMatchObject({
      title: 'Freeze schema for v2.4.0?',
      variant: 'info',
      confirmLabel: 'Freeze schema',
    });
  });
});

// ---------------------------------------------------------------------------------------
// FEATURE_GITLIKE
// ---------------------------------------------------------------------------------------

describe('gitlikeAffordance — the four rows', () => {
  it('production + off: hidden, exactly as before', () => {
    expect(gitlikeAffordance(false, true)).toEqual({ flagOn: false, visible: false, marked: false, enabled: false });
  });

  it('production + on: drawn, working, unmarked — exactly as before', () => {
    expect(gitlikeAffordance(true, true)).toEqual({ flagOn: true, visible: true, marked: false, enabled: true });
  });

  it('non-production + off: drawn, marked, inert — the gap is legible', () => {
    expect(gitlikeAffordance(false, false)).toEqual({ flagOn: false, visible: true, marked: true, enabled: false });
  });

  it('non-production + on: drawn, marked, working', () => {
    expect(gitlikeAffordance(true, false)).toEqual({ flagOn: true, visible: true, marked: true, enabled: true });
  });

  it('defaults to the build constant and NODE_ENV', () => {
    // The test build has the flag off and NODE_ENV=test — the third row.
    expect(gitlikeAffordance()).toEqual({ flagOn: false, visible: true, marked: true, enabled: false });
  });
});

// ---------------------------------------------------------------------------------------
// The row menu
// ---------------------------------------------------------------------------------------

describe('versionRowMenuItems', () => {
  const ids = (version: Version, context: Partial<VersionRowMenuContext> = {}) =>
    versionRowMenuItems(version, { ...CONTEXT, ...context }).map((item) => item.id);

  it('lists the mockup’s order for a draft the viewer owns, with the flag on', () => {
    expect(ids(HEAD_DRAFT)).toEqual([
      'view',
      'export',
      'compareWithCurrent',
      'relationshipGraph',
      'branchFrom',
      'forkToProject',
      'tagFrom',
      'scheduleSunset',
      'edit',
      'publish',
      'freezeSchema',
      'delete',
    ]);
  });

  it('offers Unpublish rather than Publish for a published revision', () => {
    const list = ids(PUBLISHED_231);
    expect(list).toContain('unpublish');
    expect(list).not.toContain('publish');
  });

  it('withholds Publish for a catalog item (not publishable)', () => {
    const list = ids(HEAD_DRAFT, { publishable: false });
    expect(list).not.toContain('publish');
    expect(list).not.toContain('unpublish');
  });

  it('adds Rollback only with a named branch, Lock only for an admin, Freeze only when unfrozen and owned', () => {
    expect(ids(HEAD_DRAFT, { hasBranches: true })).toContain('rollbackBranch');
    expect(ids(HEAD_DRAFT)).not.toContain('toggleLock');
    expect(ids(HEAD_DRAFT, { effectiveIsAdmin: true })).toContain('toggleLock');
    expect(ids(HEAD_DRAFT, { schemaFrozen: true })).not.toContain('freezeSchema');
    expect(ids(HEAD_DRAFT, { currentUserId: 'someone-else' })).not.toContain('freezeSchema');
  });

  it('disables Compare with current on the head, with the reason', () => {
    const compare = versionRowMenuItems(HEAD_DRAFT, CONTEXT).find((item) => item.id === 'compareWithCurrent');
    expect(compare).toMatchObject({ disabled: true, title: 'This revision is already the current head' });
    const compareOlder = versionRowMenuItems(PUBLISHED_231, CONTEXT).find((item) => item.id === 'compareWithCurrent');
    expect(compareOlder?.disabled).toBe(false);
  });

  it('disables sunset and edit for a published revision unless the viewer is an admin', () => {
    const items = versionRowMenuItems(PUBLISHED_231, CONTEXT);
    expect(items.find((item) => item.id === 'scheduleSunset')).toMatchObject({
      disabled: true,
      title: 'Only a tenant admin can set sunset on a published revision',
    });
    expect(items.find((item) => item.id === 'edit')).toMatchObject({
      disabled: true,
      title: 'Only a tenant admin can edit a published revision',
    });
    const admin = versionRowMenuItems(PUBLISHED_231, { ...CONTEXT, effectiveIsAdmin: true });
    expect(admin.find((item) => item.id === 'edit')?.disabled).toBe(false);
  });

  it('disables sunset for an archived revision unless the viewer is an admin, and Delete for a locked one', () => {
    const items = versionRowMenuItems(ARCHIVED_210_LOCKED, CONTEXT);
    expect(items.find((item) => item.id === 'scheduleSunset')?.disabled).toBe(true);
    expect(items.find((item) => item.id === 'delete')).toMatchObject({
      disabled: true,
      title: 'Revision is locked; only a tenant admin can delete',
      danger: true,
    });
    const admin = versionRowMenuItems(ARCHIVED_210_LOCKED, { ...CONTEXT, effectiveIsAdmin: true });
    expect(admin.find((item) => item.id === 'delete')?.disabled).toBe(false);
    expect(admin.find((item) => item.id === 'toggleLock')?.label).toBe('Unlock revision (allow delete)');
  });

  it('says Freezing... while a freeze is in flight', () => {
    const items = versionRowMenuItems(HEAD_DRAFT, { ...CONTEXT, freezing: true });
    expect(items.find((item) => item.id === 'freezeSchema')).toMatchObject({ label: 'Freezing...', disabled: true });
  });

  it('production + flag off: the git-like items — Delete included — are gone, as before', () => {
    const list = ids(HEAD_DRAFT, { gitlike: gitlikeAffordance(false, true) });
    expect(list).toEqual(['view', 'export', 'scheduleSunset', 'edit', 'publish']);
  });

  it('non-production + flag off: the git-like items are listed, marked, inert, and say why', () => {
    const items = versionRowMenuItems(HEAD_DRAFT, { ...CONTEXT, gitlike: gitlikeAffordance(false, false) });
    const gitlike = items.filter((item) => item.gitlike);
    expect(gitlike.map((item) => item.id)).toEqual([
      'compareWithCurrent',
      'relationshipGraph',
      'branchFrom',
      'forkToProject',
      'tagFrom',
      'freezeSchema',
      'delete',
    ]);
    for (const item of gitlike) {
      expect(item.disabled).toBe(true);
      expect(item.title).toBe(GITLIKE_FLAG_TITLE);
    }
    // And the plain items are untouched by the build rule.
    expect(items.find((item) => item.id === 'publish')?.disabled).toBe(false);
  });

  it('marks separators where the mockup draws them', () => {
    const items = versionRowMenuItems(HEAD_DRAFT, CONTEXT);
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual([
      'compareWithCurrent',
      'scheduleSunset',
      'delete',
    ]);
  });
});

describe('versionRowQuickActions', () => {
  it('offers Publish + Edit on an owned draft, Unpublish + Edit for an admin on a published one', () => {
    expect(versionRowQuickActions(HEAD_DRAFT, CONTEXT).map((a) => a.id)).toEqual(['publish', 'edit']);
    expect(versionRowQuickActions(PUBLISHED_231, { ...CONTEXT, effectiveIsAdmin: true }).map((a) => a.id)).toEqual([
      'unpublish',
      'edit',
    ]);
  });

  it('offers nothing a non-owner cannot do, and the sunset verb on a deprecated revision', () => {
    // Grace owns 2.3.1; Ada does not, and cannot edit a published revision either.
    expect(versionRowQuickActions(PUBLISHED_231, CONTEXT)).toEqual([]);
    expect(versionRowQuickActions(DEPRECATED_220, { ...CONTEXT, effectiveIsAdmin: true }).map((a) => a.id)).toEqual([
      'unpublish',
      'scheduleSunset',
    ]);
  });

  it('withholds Publish from a catalog item', () => {
    expect(versionRowQuickActions(HEAD_DRAFT, { ...CONTEXT, publishable: false }).map((a) => a.id)).toEqual(['edit']);
  });
});
