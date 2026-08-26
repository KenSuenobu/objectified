/**
 * Reading a batch's rows (MFI-29.5, BLK-1.3).
 *
 * `bulkImportModel` folds a submit's start rows and the roll-up's status rows into the result
 * rows both bulk surfaces render, and phrases what each row did. Pinned here so the repository
 * batch wizard's verify and apply steps, and the catalog wizard's batch, read the same rows the
 * same way.
 */

import {
  bulkErrorText,
  bulkRowCounts,
  bulkRowDestination,
  bulkRunSummaryLine,
  bulkStalePlanDrift,
  mergeBulkRows,
  type BulkStartItem,
  type BulkStatusItem,
} from '@/app/components/ade/dashboard/catalog/bulkImportModel';

const ACCEPTED: BulkStartItem = {
  key: 'openapi/orders.yaml',
  root_path: 'openapi/orders.yaml',
  format: 'openapi-3.0',
  predicted_target: 'project',
  name: 'Orders API',
  slug: 'orders-api',
  state: 'accepted',
  job_id: 'job-1',
  resolution: 'append-version',
  target_project_id: 'p-orders',
  version_id: '1.2.0',
  overridden: false,
  resolution_detail: 'Appends version 1.2.0 to Orders API.',
};

const REFUSED: BulkStartItem = {
  key: 'events/shipping.asyncapi.yaml',
  root_path: 'events/shipping.asyncapi.yaml',
  format: 'asyncapi-2',
  predicted_target: 'catalog',
  name: 'Shipping Events',
  slug: 'shipping-events',
  state: 'failed',
  error: {
    code: 'QUALITY_POLICY_BLOCKED',
    category: 'policy',
    message: 'Import scores D, below the tenant floor of B.',
    remediation: 'Fix the findings and import again.',
    retriable: false,
  },
};

const DONE: BulkStatusItem = {
  key: 'openapi/orders.yaml',
  job_id: 'job-1',
  state: 'completed',
  percent: 100,
  target: 'project',
  project_slug: 'orders-api',
  project_id: 'p-orders',
  version_id: '1.2.0',
  outcome: 'version-appended',
};

describe('merging start rows with their job states', () => {
  it('gives an item that never started its start error as its result', () => {
    const [, refused] = mergeBulkRows([ACCEPTED, REFUSED], []);
    expect(refused.state).toBe('failed');
    expect(refused.jobId).toBeNull();
    expect(refused.error?.code).toBe('QUALITY_POLICY_BLOCKED');
    expect(refused.resolution).toBeNull();
  });

  it('reads an accepted item as queued until its job reports', () => {
    const [accepted] = mergeBulkRows([ACCEPTED], []);
    expect(accepted.state).toBe('queued');
    expect(accepted.jobId).toBe('job-1');
    // The decision the job was started with is known before the job runs.
    expect(accepted.resolution).toBe('append-version');
    expect(accepted.targetProjectId).toBe('p-orders');
    expect(accepted.versionId).toBe('1.2.0');
    expect(accepted.outcome).toBeNull();
  });

  it('takes the job’s own state, destination and label once it has them', () => {
    const [accepted] = mergeBulkRows([ACCEPTED], [{ ...DONE, version_id: '1.2.0-2' }]);
    expect(accepted.state).toBe('completed');
    expect(accepted.percent).toBe(100);
    expect(accepted.projectSlug).toBe('orders-api');
    expect(accepted.outcome).toBe('version-appended');
    // What was created beats what was asked for.
    expect(accepted.versionId).toBe('1.2.0-2');
  });

  it('reads a server without the BLK-1.3 fields as rows with no destination until a job names one', () => {
    const bare: BulkStartItem = { ...ACCEPTED, resolution: undefined, target_project_id: undefined, version_id: undefined };
    const [row] = mergeBulkRows([bare], []);
    expect(row.resolution).toBeNull();
    expect(bulkRowDestination(row)).toBe('');
    // The pre-BLK-1.3 reading: the job produced a slug, so something was created under it.
    const [done] = mergeBulkRows([bare], [{ ...DONE, version_id: undefined, outcome: undefined }]);
    expect(bulkRowDestination(done)).toBe('Created orders-api');
  });
});

describe('what a row says it did', () => {
  it('states the decision before the job finishes', () => {
    const [row] = mergeBulkRows([ACCEPTED], []);
    expect(bulkRowDestination(row)).toBe('New version v1.2.0 of p-orders');
  });

  it('states the realized destination once the job did', () => {
    const [row] = mergeBulkRows([ACCEPTED], [DONE]);
    expect(bulkRowDestination(row)).toBe('Appended v1.2.0 to orders-api');
  });

  it('states a created project', () => {
    const created: BulkStartItem = {
      ...REFUSED,
      state: 'accepted',
      job_id: 'job-2',
      error: null,
      resolution: 'create-project',
      version_id: '1.0.0',
    };
    const [row] = mergeBulkRows([created], []);
    expect(bulkRowDestination(row)).toBe('New project at v1.0.0');
    const [done] = mergeBulkRows(
      [created],
      [{ key: created.key, job_id: 'job-2', state: 'completed', percent: 100, project_slug: 'shipping-events', version_id: '1.0.0', outcome: 'project-created' }],
    );
    expect(bulkRowDestination(done)).toBe('Created shipping-events at v1.0.0');
  });

  it('renders an error as message, remediation and code', () => {
    expect(bulkErrorText(REFUSED.error)).toBe(
      'Import scores D, below the tenant floor of B. Fix the findings and import again. (code QUALITY_POLICY_BLOCKED)',
    );
    expect(bulkErrorText(null)).toBe('');
  });
});

describe('the batch summary', () => {
  it('counts completed, failed and pending', () => {
    const rows = mergeBulkRows([ACCEPTED, REFUSED], [DONE]);
    expect(bulkRowCounts(rows)).toEqual({ completed: 1, failed: 1, pending: 0 });
  });

  it('says validated on a verify pass and imported on an apply', () => {
    const rows = mergeBulkRows([ACCEPTED, REFUSED], [DONE]);
    expect(bulkRunSummaryLine(rows, false)).toBe('Bulk import finished: 1 imported, 1 failed of 2.');
    expect(bulkRunSummaryLine(rows, true)).toBe('Verify finished: 1 validated, 1 failed of 2.');
  });
});

describe('a stale plan', () => {
  it('reads the drift rows out of a TARGET_PLAN_STALE refusal', () => {
    const drift = bulkStalePlanDrift({
      success: false,
      error: 'The plan you reviewed no longer describes this batch.',
      detail: {
        code: 'TARGET_PLAN_STALE',
        drift: [
          { key: 'openapi/orders.yaml', change: 'resolution', reviewed: 'create-project at 1.0.0', current: 'append-version onto project p-orders at 1.1.0', detail: 'Re-plan the batch.' },
          'not a row',
        ],
      },
    });
    expect(drift).toEqual([
      {
        key: 'openapi/orders.yaml',
        change: 'resolution',
        reviewed: 'create-project at 1.0.0',
        current: 'append-version onto project p-orders at 1.1.0',
        detail: 'Re-plan the batch.',
      },
    ]);
  });

  it('is not any other refusal', () => {
    expect(bulkStalePlanDrift({ success: false, error: 'boom' })).toBeNull();
    expect(bulkStalePlanDrift({ detail: { code: 'QUALITY_POLICY_BLOCKED' } })).toBeNull();
    expect(bulkStalePlanDrift({ detail: 'a string' })).toBeNull();
  });

  it('reads a refusal with no drift list as an empty one', () => {
    expect(bulkStalePlanDrift({ detail: { code: 'TARGET_PLAN_STALE' } })).toEqual([]);
  });
});
