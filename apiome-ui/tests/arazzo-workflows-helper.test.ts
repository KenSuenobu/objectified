/**
 * Arazzo workflow read helper — REPO-3.4 (#2773).
 *
 * `getArazzoWorkflowsForVersion` is the Studio sidebar's data source. These tests pin the
 * behaviour the sidebar depends on: tenant scoping, source ordering, the LEFT JOIN's
 * step-less-workflow case, and a failed read degrading to an empty list rather than throwing.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../lib/db/db', () => ({
  query: jest.fn(),
}));

import { getArazzoWorkflowsForVersion } from '../lib/db/helper-arazzo-workflows';

const TENANT = 'tenant-1';
const VERSION = 'version-1';

/** One joined workflow+step row as the query returns it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    workflow_row_id: 'wf-1',
    workflow_id: 'apply-coupon',
    summary: 'Apply a coupon to a pet order.',
    description: 'Find a pet, find a coupon, order the pet.',
    ordinal: 0,
    step_id: 'find-pet',
    order_index: 0,
    step_description: 'Find a pet based on the provided tags.',
    operation_ref: null,
    operation_id: 'findPetsByTags',
    resolved_path_operation_id: 'op-1',
    resolution_status: 'resolved',
    resolution_reason: null,
    ...overrides,
  };
}

describe('getArazzoWorkflowsForVersion', () => {
  let mockQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = require('../lib/db/db').query as jest.Mock;
  });

  test('scopes the read to the tenant and version, and reads only live rows', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getArazzoWorkflowsForVersion(VERSION, TENANT);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([TENANT, VERSION]);
    expect(sql).toContain('w.tenant_id = $1');
    expect(sql).toContain('w.version_id = $2');
    expect(sql).toContain('w.deleted_at IS NULL');
    expect(sql).toContain('s.deleted_at IS NULL');
    // Source order, not insertion order.
    expect(sql).toContain('ORDER BY w.ordinal, w.workflow_id, s.order_index');
  });

  test('groups joined rows into workflows with their ordered steps', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        row(),
        row({
          step_id: 'find-coupons',
          order_index: 1,
          operation_id: 'getPetCoupons',
          resolved_path_operation_id: null,
          resolution_status: 'unresolved',
          resolution_reason: 'unknown-operation',
        }),
        row({
          workflow_row_id: 'wf-2',
          workflow_id: 'place-order',
          summary: 'Place an order for a pet.',
          ordinal: 1,
          step_id: 'place-order',
          order_index: 0,
          operation_id: 'placeOrder',
          resolved_path_operation_id: 'op-2',
        }),
      ],
    });

    const result = JSON.parse(await getArazzoWorkflowsForVersion(VERSION, TENANT));

    expect(result.success).toBe(true);
    expect(result.workflows).toHaveLength(2);
    expect(result.workflows[0]).toMatchObject({
      id: 'wf-1',
      workflowId: 'apply-coupon',
      summary: 'Apply a coupon to a pet order.',
      ordinal: 0,
    });
    expect(result.workflows[0].steps.map((s: any) => s.stepId)).toEqual([
      'find-pet',
      'find-coupons',
    ]);
    expect(result.workflows[1].steps).toHaveLength(1);
  });

  test('surfaces each step’s resolution state and raw reference', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        row({
          step_id: 'checkout',
          operation_id: null,
          operation_ref: './cart.openapi.yaml#/paths/~1carts/post',
          resolved_path_operation_id: null,
          resolution_status: 'unresolved',
          resolution_reason: 'unknown-operation',
        }),
      ],
    });

    const result = JSON.parse(await getArazzoWorkflowsForVersion(VERSION, TENANT));
    const step = result.workflows[0].steps[0];

    // AC: the raw reference is kept when resolution fails.
    expect(step.operationRef).toBe('./cart.openapi.yaml#/paths/~1carts/post');
    expect(step.resolvedPathOperationId).toBeNull();
    expect(step.resolutionStatus).toBe('unresolved');
    expect(step.resolutionReason).toBe('unknown-operation');
  });

  test('returns a workflow with no steps rather than dropping it', async () => {
    // The LEFT JOIN yields one row with null step columns for a step-less workflow.
    mockQuery.mockResolvedValue({
      rows: [
        row({
          step_id: null,
          order_index: null,
          step_description: null,
          operation_ref: null,
          operation_id: null,
          resolved_path_operation_id: null,
          resolution_status: null,
          resolution_reason: null,
        }),
      ],
    });

    const result = JSON.parse(await getArazzoWorkflowsForVersion(VERSION, TENANT));

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].steps).toEqual([]);
  });

  test('returns an empty list without querying when ids are missing', async () => {
    const result = JSON.parse(await getArazzoWorkflowsForVersion('', TENANT));

    expect(result).toEqual({ success: true, workflows: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('degrades to an empty list when the read fails', async () => {
    mockQuery.mockRejectedValue(new Error('relation "api_workflows" does not exist'));
    // The helper logs the fault deliberately; keep it out of the test output.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = JSON.parse(await getArazzoWorkflowsForVersion(VERSION, TENANT));
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();

    // The sidebar must not break a canvas that predates the migration.
    expect(result.success).toBe(false);
    expect(result.workflows).toEqual([]);
    expect(result.error).toContain('api_workflows');
  });
});
