/**
 * The rules behind the repository batch wizard (BLK-1.4, #5526).
 *
 * `repositoryBatchImportModel` decides what each review row says, what a per-row override
 * means and how it becomes the BLK-1.3 request, what the header counts, which policy is in
 * force, what is excluded and why, and what the footer offers on each step. None of it needs
 * a DOM, so none of it is tested through one.
 */

import type {
  BulkPlan,
  BulkPlanItem,
} from '@/app/components/ade/dashboard/catalog/bulkImportModel';
import {
  BATCH_IMPORT_STEPS,
  BATCH_TARGET_PLAN,
  batchExcludedRows,
  batchFooterFor,
  batchHeaderCounts,
  batchHeaderSummary,
  batchImportTitle,
  batchOffersSkipVerify,
  batchOverridesForRequest,
  batchPolicyLine,
  batchRowTarget,
  batchTargetOptions,
  batchUndecidedKeys,
  parseBatchTargetChoice,
  type BatchFooterState,
} from '@/app/components/ade/repositories/repositoryBatchImportModel';

const PROJECTS = [
  { id: 'p-orders', name: 'Orders API', slug: 'orders-api' },
  { id: 'p-shipping', name: 'Shipping', slug: 'shipping' },
];

function item(overrides: Partial<BulkPlanItem> & { key: string }): BulkPlanItem {
  return {
    root_path: overrides.key,
    members: [overrides.key],
    total_bytes: 100,
    source_kind: 'openapi',
    format: 'openapi-3.0',
    confidence: 0.99,
    importable: true,
    predicted_target: 'project',
    input_kind: 'file',
    suggested_name: 'Spec',
    suggested_slug: 'spec',
    reason: 'independent document',
    ...overrides,
  };
}

/** A re-imported spec that matched, a new one, and one no adapter can import. */
const ORDERS = item({
  key: 'openapi/orders.yaml',
  suggested_name: 'Orders API',
  suggested_slug: 'orders-api',
  resolution: 'append-version',
  matched_project: { project_id: 'p-orders', name: 'Orders API', slug: 'orders-api' },
  match_basis: 'repository-provenance',
  match_detail: 'A previous import of this path created Orders API.',
  match_confidence: 1,
  proposed_version: { version_id: '1.1.0', derived_from: 'version-bump', previous_version_id: '1.0.0' },
});

const EVENTS = item({
  key: 'events/shipping.asyncapi.yaml',
  source_kind: 'asyncapi',
  format: 'asyncapi-2',
  predicted_target: 'catalog',
  suggested_name: 'Shipping Events',
  suggested_slug: 'shipping-events',
  resolution: 'create-project',
  matched_project: null,
  proposed_version: { version_id: '1.0.0', derived_from: 'default' },
});

const FUTURE = item({
  key: 'future/spec.yaml',
  source_kind: null,
  format: 'future-format',
  importable: false,
  resolution: 'create-project',
  proposed_version: { version_id: '1.0.0', derived_from: 'default' },
});

function plan(overrides: Partial<BulkPlan> = {}): BulkPlan {
  return {
    items: [ORDERS, EVENTS, FUTURE],
    skipped: [
      { path: 'protos/common/types.proto', reason: 'not-an-item-root' },
      { path: 'README.md', reason: 'no-recognisable-format' },
    ],
    truncated: false,
    total_items: 3,
    max_items: 50,
    source_label: 'acme/widgets@abc1234',
    version_policy: 'append-when-matched',
    version_policy_source: 'tenant',
    plan_fingerprint: 'bp1.reviewed',
    summary: {
      items: 3,
      importable: 2,
      unimportable: 1,
      skipped_files: 2,
      by_target: { project: 2, catalog: 1 },
      by_format: {},
      by_resolution: { 'append-version': 1, 'create-project': 2 },
      matched: 1,
    },
    ...overrides,
  };
}

describe('the steps and the title', () => {
  it('walks Review → Verify → Apply', () => {
    expect(BATCH_IMPORT_STEPS.map((step) => step.id)).toEqual(['review', 'verify', 'apply']);
  });

  it('names how many files the reader ticked', () => {
    expect(batchImportTitle(1)).toBe('Import 1 selected file');
    expect(batchImportTitle(12)).toBe('Import 12 selected files');
  });
});

describe('what a review row says', () => {
  it('states a matched item as a new version of its project, with the label and the basis', () => {
    const target = batchRowTarget(ORDERS, BATCH_TARGET_PLAN, PROJECTS);
    expect(target).toEqual({
      kind: 'append',
      label: 'New version of Orders API',
      version: '1.1.0',
      basis: 'imported from this path before',
      overridden: false,
    });
  });

  it('states an unmatched item as a new project under its slug', () => {
    const target = batchRowTarget(EVENTS, BATCH_TARGET_PLAN, PROJECTS);
    expect(target.kind).toBe('create');
    expect(target.label).toBe('New project shipping-events');
    expect(target.version).toBe('1.0.0');
    expect(target.basis).toBeNull();
  });

  it('says a match the policy ignores is being ignored', () => {
    const ignored = item({ ...ORDERS, resolution: 'create-project' });
    const target = batchRowTarget(ignored, BATCH_TARGET_PLAN, PROJECTS);
    expect(target.kind).toBe('create');
    expect(target.basis).toBe('matches Orders API · policy creates anyway');
  });

  it('says an always-ask row still needs a choice', () => {
    const asked = item({ ...ORDERS, resolution: 'unresolved' });
    const target = batchRowTarget(asked, BATCH_TARGET_PLAN, PROJECTS);
    expect(target.kind).toBe('unresolved');
    expect(target.label).toBe('Needs a choice — matches Orders API');
  });

  it('reads a plan without reconciliation as everything new', () => {
    const bare = item({ key: 'x.yaml', suggested_slug: 'x' });
    expect(batchRowTarget(bare, BATCH_TARGET_PLAN, PROJECTS).label).toBe('New project x');
  });

  it('an override to a new project says so, and defers its version to verify', () => {
    const target = batchRowTarget(ORDERS, 'new', PROJECTS);
    expect(target).toEqual({
      kind: 'create',
      label: 'New project orders-api',
      version: null,
      basis: 'chosen here',
      overridden: true,
    });
  });

  it('an override onto a project names that project', () => {
    const target = batchRowTarget(EVENTS, 'existing:p-shipping', PROJECTS);
    expect(target.kind).toBe('append');
    expect(target.label).toBe('New version of Shipping');
    expect(target.overridden).toBe(true);
    expect(target.version).toBeNull();
  });

  it('an override onto the row’s own match still names it when the list lacks it', () => {
    const target = batchRowTarget(ORDERS, 'existing:p-orders', []);
    expect(target.label).toBe('New version of Orders API');
  });
});

describe('the target control', () => {
  it('reads plan, new and existing:<id>, and nothing else', () => {
    expect(parseBatchTargetChoice('plan')).toEqual({ mode: 'plan' });
    expect(parseBatchTargetChoice('new')).toEqual({ mode: 'new' });
    expect(parseBatchTargetChoice('existing:p-1')).toEqual({ mode: 'existing', projectId: 'p-1' });
    expect(parseBatchTargetChoice('existing:')).toEqual({ mode: 'plan' });
    expect(parseBatchTargetChoice('nonsense')).toEqual({ mode: 'plan' });
  });

  it('leads with the plan, then offers the other shape and the other projects', () => {
    expect(batchTargetOptions(ORDERS, PROJECTS)).toEqual([
      { value: 'plan', label: 'Plan: New version of Orders API' },
      { value: 'new', label: 'New project orders-api' },
      { value: 'existing:p-shipping', label: 'New version of Shipping' },
    ]);
  });

  it('does not offer a new project to a row that already creates one', () => {
    const values = batchTargetOptions(EVENTS, PROJECTS).map((option) => option.value);
    expect(values).toEqual(['plan', 'existing:p-orders', 'existing:p-shipping']);
  });

  it('offers an unresolved row its match, once', () => {
    const asked = item({ ...ORDERS, resolution: 'unresolved' });
    const values = batchTargetOptions(asked, PROJECTS).map((option) => option.value);
    expect(values).toEqual(['plan', 'new', 'existing:p-orders', 'existing:p-shipping']);
  });
});

describe('the request the overrides amount to', () => {
  it('sends nothing for a plan applied as reviewed', () => {
    expect(batchOverridesForRequest(plan(), {})).toEqual([]);
  });

  it('sends one entry per row the reader moved, and only those', () => {
    expect(
      batchOverridesForRequest(plan(), {
        [ORDERS.key]: 'new',
        [EVENTS.key]: 'existing:p-shipping',
      }),
    ).toEqual([
      { key: ORDERS.key, mode: 'new' },
      { key: EVENTS.key, mode: 'existing', project_id: 'p-shipping' },
    ]);
  });

  it('never sends an override for a row the batch cannot import', () => {
    expect(batchOverridesForRequest(plan(), { [FUTURE.key]: 'new' })).toEqual([]);
  });

  it('names the rows an always-ask policy left undecided', () => {
    const asked = plan({
      items: [item({ ...ORDERS, resolution: 'unresolved' }), item({ ...EVENTS, resolution: 'unresolved' })],
    });
    expect(batchUndecidedKeys(asked, {})).toEqual([ORDERS.key, EVENTS.key]);
    expect(batchUndecidedKeys(asked, { [ORDERS.key]: 'existing:p-orders' })).toEqual([EVENTS.key]);
  });
});

describe('what is excluded', () => {
  it('lists unimportable items and skipped files, each with a reason', () => {
    expect(batchExcludedRows(plan())).toEqual([
      { path: 'future/spec.yaml', reason: 'no importer for future-format' },
      { path: 'protos/common/types.proto', reason: 'compiled into another selected spec' },
      { path: 'README.md', reason: 'no recognisable format' },
    ]);
  });

  it('passes an unknown reason through rather than dropping the row', () => {
    const rows = batchExcludedRows(plan({ items: [], skipped: [{ path: 'x', reason: 'brand-new' }] }));
    expect(rows).toEqual([{ path: 'x', reason: 'brand-new' }]);
  });
});

describe('the header line', () => {
  it('counts the plan as reviewed', () => {
    const counts = batchHeaderCounts(plan(), {});
    expect(counts).toEqual({ items: 2, appends: 1, creates: 1, unresolved: 0, excluded: 3 });
    expect(batchHeaderSummary(counts)).toBe('2 items · 1 new version · 1 new project · 3 excluded');
  });

  it('moves with the overrides', () => {
    const counts = batchHeaderCounts(plan(), { [ORDERS.key]: 'new' });
    expect(batchHeaderSummary(counts)).toBe('2 items · 2 new projects · 3 excluded');
  });

  it('counts rows still needing a choice', () => {
    const asked = plan({ items: [item({ ...ORDERS, resolution: 'unresolved' })], skipped: [] });
    expect(batchHeaderSummary(batchHeaderCounts(asked, {}))).toBe('1 item · 1 needing a choice');
  });
});

describe('the policy line', () => {
  it('names the policy, its tier and what it does', () => {
    expect(batchPolicyLine(plan())).toBe(
      'Policy: append-when-matched (workspace default) — matched files add a version, the rest create a project',
    );
    expect(
      batchPolicyLine(plan({ version_policy: 'always-create', version_policy_source: 'repository' })),
    ).toBe('Policy: always-create (repository override) — every file creates a project; matches are shown but not used');
  });

  it('says nothing for a server that reported no policy', () => {
    expect(batchPolicyLine(plan({ version_policy: undefined }))).toBe('');
  });
});

describe('the footer', () => {
  const base: BatchFooterState = {
    step: 'review',
    planReady: true,
    running: false,
    verified: false,
    verifySkipped: false,
    applied: false,
    itemCount: 2,
  };

  it('leads from Review to Verify once the plan is in', () => {
    const footer = batchFooterFor(base);
    expect(footer.back).toBeNull();
    expect(footer.primary).toEqual({ label: 'Next: Verify →', disabled: false });
    expect(batchFooterFor({ ...base, planReady: false }).primary?.disabled).toBe(true);
  });

  it('keeps Apply unreachable until verify has run or was skipped', () => {
    expect(batchFooterFor({ ...base, step: 'verify' }).primary).toEqual({
      label: 'Run verify',
      disabled: false,
    });
    expect(batchFooterFor({ ...base, step: 'verify', verified: true }).primary?.label).toBe('Next: Apply →');
    expect(batchFooterFor({ ...base, step: 'verify', verifySkipped: true }).primary?.label).toBe(
      'Next: Apply →',
    );
  });

  it('offers Skip verify only before verify has run', () => {
    expect(batchOffersSkipVerify({ ...base, step: 'verify' })).toBe(true);
    expect(batchOffersSkipVerify({ ...base, step: 'verify', running: true })).toBe(false);
    expect(batchOffersSkipVerify({ ...base, step: 'verify', verified: true })).toBe(false);
    expect(batchOffersSkipVerify({ ...base, step: 'review' })).toBe(false);
  });

  it('disables Back and Cancel while a run is in flight rather than removing them', () => {
    const footer = batchFooterFor({ ...base, step: 'verify', running: true });
    expect(footer.back).toEqual({ label: '← Back', disabled: true });
    expect(footer.cancel.disabled).toBe(true);
    expect(footer.primary?.disabled).toBe(true);
  });

  it('names how many specs Apply will start, then closes once it did', () => {
    expect(batchFooterFor({ ...base, step: 'apply' }).primary).toEqual({
      label: 'Import 2 specs',
      disabled: false,
    });
    const done = batchFooterFor({ ...base, step: 'apply', applied: true });
    expect(done.primary).toBeNull();
    expect(done.cancel).toEqual({ label: 'Close', disabled: false });
    expect(done.back?.disabled).toBe(true);
  });
});
