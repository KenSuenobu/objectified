// Read access to imported Arazzo workflows (REPO-3.4, #2773).
'use server';

const connectionPool = require('./db');

/**
 * One step of an imported Arazzo workflow, as the Studio sidebar renders it.
 */
export interface WorkflowStepSummary {
  /** Source `stepId`. */
  stepId: string;
  /** Zero-based position within the workflow. */
  orderIndex: number;
  /** Source `description`/`summary`, when the document has one. */
  description: string | null;
  /** Raw `operationRef`/`operationPath`, kept verbatim even when unresolved. */
  operationRef: string | null;
  /** Raw `operationId`, kept verbatim even when unresolved. */
  operationId: string | null;
  /** Internal `path_operation.id` this step targets, when it resolved. */
  resolvedPathOperationId: string | null;
  /** `resolved` | `unresolved` | `not_applicable` | `parse_error`. */
  resolutionStatus: string;
  /** Stable machine reason when the step is not resolved. */
  resolutionReason: string | null;
}

/**
 * One imported Arazzo workflow with its ordered steps.
 */
export interface WorkflowSummary {
  /** `api_workflows.id`. */
  id: string;
  /** Source `workflowId`. */
  workflowId: string;
  /** Source `summary`. */
  summary: string | null;
  /** Source `description`. */
  description: string | null;
  /** Zero-based declaration order within the source document. */
  ordinal: number;
  /** The workflow's steps, in source order. */
  steps: WorkflowStepSummary[];
}

/**
 * Load the live Arazzo workflows for a version, each with its ordered steps.
 *
 * Reads the entities the REPO-3.4 importer writes; it never parses a source document, so a
 * version with no Arazzo import simply yields an empty list.
 *
 * @param versionId - The `versions.id` to read workflows for.
 * @param tenantId - Owning tenant, enforced in the query so a caller cannot read across tenants.
 * @returns JSON string of `{ success: true, workflows: WorkflowSummary[] }`, or
 *          `{ success: false, error }` when the read fails.
 */
export async function getArazzoWorkflowsForVersion(
  versionId: string,
  tenantId: string
): Promise<string> {
  if (!versionId || !tenantId) {
    return JSON.stringify({ success: true, workflows: [] });
  }

  // One query, ordered so steps arrive grouped under their workflow in source order.
  const query = `
    SELECT
      w.id                            AS workflow_row_id,
      w.workflow_id                   AS workflow_id,
      w.summary                       AS summary,
      w.description                   AS description,
      w.ordinal                       AS ordinal,
      s.step_id                       AS step_id,
      s.order_index                   AS order_index,
      s.description                   AS step_description,
      s.operation_ref                 AS operation_ref,
      s.operation_id                  AS operation_id,
      s.resolved_path_operation_id    AS resolved_path_operation_id,
      s.resolution_status             AS resolution_status,
      s.resolution_reason             AS resolution_reason
    FROM apiome.api_workflows w
    LEFT JOIN apiome.api_workflow_steps s
           ON s.workflow_id = w.id AND s.deleted_at IS NULL
    WHERE w.tenant_id = $1 AND w.version_id = $2 AND w.deleted_at IS NULL
    ORDER BY w.ordinal, w.workflow_id, s.order_index
  `;

  try {
    const result = await connectionPool.query(query, [tenantId, versionId]);
    const byId = new Map<string, WorkflowSummary>();

    for (const row of result.rows) {
      const id = String(row.workflow_row_id);
      let workflow = byId.get(id);
      if (!workflow) {
        workflow = {
          id,
          workflowId: String(row.workflow_id),
          summary: row.summary ?? null,
          description: row.description ?? null,
          ordinal: Number(row.ordinal ?? 0),
          steps: [],
        };
        byId.set(id, workflow);
      }
      // LEFT JOIN: a workflow with no steps still yields one row, with null step columns.
      if (row.step_id !== null && row.step_id !== undefined) {
        workflow.steps.push({
          stepId: String(row.step_id),
          orderIndex: Number(row.order_index ?? 0),
          description: row.step_description ?? null,
          operationRef: row.operation_ref ?? null,
          operationId: row.operation_id ?? null,
          resolvedPathOperationId: row.resolved_path_operation_id
            ? String(row.resolved_path_operation_id)
            : null,
          resolutionStatus: String(row.resolution_status ?? 'unresolved'),
          resolutionReason: row.resolution_reason ?? null,
        });
      }
    }

    return JSON.stringify({ success: true, workflows: Array.from(byId.values()) });
  } catch (error) {
    console.error('Error fetching Arazzo workflows for version:', error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load workflows',
      workflows: [],
    });
  }
}
