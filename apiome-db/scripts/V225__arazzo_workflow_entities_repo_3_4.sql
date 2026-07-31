-- Arazzo workflow entities (REPO-3.4, #2773): give orchestrated multi-step API workflows a home.
--
-- Arazzo is OpenAPI's sibling specification: it describes *sequences* of API calls
-- (`workflows` → `steps`), where each step points at an operation in some OpenAPI document via
-- `operationId` or `operationRef`. Until this migration Apiome could parse, lint, diff and emit
-- Arazzo (MFI-30.2) but had nowhere to *store* the orchestration — an Arazzo import landed as a
-- store-raw catalog item and its workflows were invisible to browse/search/Studio.
--
-- Two tables mirror the Arazzo document shape, following the MFI-2.2 canonical-persistence
-- conventions established by V135 (`api_artifacts` → services/operations/messages, channels,
-- types/fields):
--
--   api_workflows                       -- one row per Arazzo `workflows[]` entry
--     └─ api_workflow_steps             -- one row per `steps[]` entry, ordered by order_index
--
-- Design notes:
--
-- * **Hung off the artifact, like every other canonical child.** A workflow belongs to the
--   `api_artifacts` row created for its version, so re-importing a version soft-deletes the old
--   artifact and its workflows together (`persist_arazzo_workflows` mirrors
--   `_soft_delete_live_artifact`). `tenant_id` / `version_id` are denormalized onto both tables
--   for the same tenant-scoped-query reason V135 gives, and `project_id` is carried on
--   `api_workflows` because the ticket's entity sketch lists it and because operationRef
--   resolution is a *project*-scoped question (see below).
--
-- * **`operation_ref` is kept verbatim, always.** The importer additionally tries to resolve it
--   to an internal `path_operation` row — that is, to an operation that came from an OpenAPI spec
--   imported in the same repository scan — and records the hit in `resolved_path_operation_id`.
--   A miss is not an error: the raw string stays, the FK stays NULL, and `resolution_status`
--   plus `resolution_reason` explain why so the UI can render a warning instead of a broken link.
--   That is why the FK is `ON DELETE SET NULL` rather than CASCADE: losing the target operation
--   must degrade a step to "unresolved", never delete the workflow's step.
--
-- * **Step payloads ride as JSONB, unremapped.** `parameters`, `success_criteria`, `on_failure`,
--   `outputs` and `depends_on` are stored exactly as written in the source document. Arazzo's
--   runtime-expression grammar (`$response.body#/id`, `$steps.foo.outputs.bar`) is not something
--   we want to parse-and-rebuild; a lossless copy keeps round-trip honest and lets the emitter
--   reproduce the source document.
SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- api_workflows — one Arazzo `workflows[]` entry (Workflow).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_workflows (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    version_id UUID NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    artifact_id UUID NOT NULL REFERENCES api_artifacts(id) ON DELETE CASCADE,

    -- The source `workflowId`, unique within the artifact (live rows only).
    workflow_id VARCHAR(512) NOT NULL,
    summary VARCHAR(4096),
    description TEXT,

    -- Workflow-level `inputs` (a JSON Schema) and `outputs` (name → runtime expression).
    inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Source declaration order, preserved for stable rendering.
    ordinal INTEGER NOT NULL DEFAULT 0,
    extras JSONB NOT NULL DEFAULT '{}'::jsonb,

    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT api_workflows_ordinal_check CHECK (ordinal >= 0)
);

-- A workflowId is unique within its artifact (live rows only) so diffs line up by identity.
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_workflows_artifact_workflow_id
    ON api_workflows(artifact_id, workflow_id) WHERE deleted_at IS NULL;
-- List a version's workflows for browse/diff/Studio.
CREATE INDEX IF NOT EXISTS idx_api_workflows_version_id
    ON api_workflows(version_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_workflows_tenant_id
    ON api_workflows(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_workflows_project_id
    ON api_workflows(project_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE api_workflows IS 'Orchestrated multi-step API workflows imported from an Arazzo document (Workflow) (#2773, REPO-3.4)';
COMMENT ON COLUMN api_workflows.id IS 'Unique identifier for the workflow';
COMMENT ON COLUMN api_workflows.tenant_id IS 'Owning tenant (denormalized for tenant-scoped queries); cascade-deleted with the tenant';
COMMENT ON COLUMN api_workflows.project_id IS 'Owning project; the scope operationRef resolution searches for candidate path_operation rows';
COMMENT ON COLUMN api_workflows.version_id IS 'Owning schema revision (versions.id), denormalized from the artifact';
COMMENT ON COLUMN api_workflows.artifact_id IS 'Parent canonical artifact; cascade-deleted with it';
COMMENT ON COLUMN api_workflows.workflow_id IS 'Source `workflowId`; unique within the artifact';
COMMENT ON COLUMN api_workflows.summary IS 'Source `summary` (short label) if present';
COMMENT ON COLUMN api_workflows.description IS 'Source `description` (long form) if present';
COMMENT ON COLUMN api_workflows.inputs IS 'Workflow-level `inputs` JSON Schema, stored verbatim';
COMMENT ON COLUMN api_workflows.outputs IS 'Workflow-level `outputs` map (name → runtime expression), stored verbatim';
COMMENT ON COLUMN api_workflows.ordinal IS 'Zero-based source declaration order';
COMMENT ON COLUMN api_workflows.extras IS 'Arazzo attributes the columns do not model (dependsOn, successActions, failureActions, …)';
COMMENT ON COLUMN api_workflows.deleted_at IS 'Soft delete timestamp; null means the workflow is live';
COMMENT ON COLUMN api_workflows.created_at IS 'Timestamp when the workflow row was created';
COMMENT ON COLUMN api_workflows.updated_at IS 'Timestamp when the workflow row was last updated';

-- ---------------------------------------------------------------------------------------------------
-- api_workflow_steps — one Arazzo `steps[]` entry within a workflow (WorkflowStep).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_workflow_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    version_id UUID NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES api_workflows(id) ON DELETE CASCADE,

    -- The source `stepId`, unique within the workflow (live rows only), plus its position.
    step_id VARCHAR(512) NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,

    description TEXT,

    -- The step's target, kept exactly as written. `operation_ref` covers Arazzo's
    -- `operationRef` (a URI/JSON-pointer into a source description); `operation_id` covers the
    -- `operationId` spelling. A step may also target another workflow (`workflowId`), which
    -- rides in `extras` since it resolves to a sibling workflow rather than an operation.
    operation_ref TEXT,
    operation_id VARCHAR(512),

    -- Resolution outcome against path_operation rows in the same project (see header note).
    -- SET NULL, not CASCADE: a deleted target degrades the step, it does not delete it.
    resolved_path_operation_id UUID REFERENCES path_operation(id) ON DELETE SET NULL,
    resolution_status VARCHAR(32) NOT NULL DEFAULT 'unresolved',
    resolution_reason VARCHAR(64),

    -- Step payloads, stored verbatim (Arazzo runtime expressions are never re-parsed).
    parameters JSONB NOT NULL DEFAULT '[]'::jsonb,
    success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
    on_failure JSONB NOT NULL DEFAULT '[]'::jsonb,
    outputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
    extras JSONB NOT NULL DEFAULT '{}'::jsonb,

    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT api_workflow_steps_order_index_check CHECK (order_index >= 0),
    -- 'resolved' means the FK is set; every other status must leave it NULL, so a reader can
    -- trust `resolved_path_operation_id IS NOT NULL` and `resolution_status = 'resolved'`
    -- interchangeably. 'parse_error' isolates a single malformed step (AC: a bad step must not
    -- abort its workflow), matching REPO-3.3's per-channel `parse_error` treatment.
    CONSTRAINT api_workflow_steps_resolution_status_check
        CHECK (resolution_status IN ('resolved', 'unresolved', 'not_applicable', 'parse_error')),
    CONSTRAINT api_workflow_steps_resolution_consistency_check
        CHECK ((resolution_status = 'resolved') = (resolved_path_operation_id IS NOT NULL))
);

-- A stepId is unique within its workflow (live rows only).
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_workflow_steps_workflow_step_id
    ON api_workflow_steps(workflow_id, step_id) WHERE deleted_at IS NULL;
-- Render a workflow's steps in source order.
CREATE INDEX IF NOT EXISTS idx_api_workflow_steps_workflow_order
    ON api_workflow_steps(workflow_id, order_index) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_workflow_steps_version_id
    ON api_workflow_steps(version_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_workflow_steps_tenant_id
    ON api_workflow_steps(tenant_id) WHERE deleted_at IS NULL;
-- "Which workflows call this operation?" — the reverse lookup that makes resolution worth doing.
CREATE INDEX IF NOT EXISTS idx_api_workflow_steps_resolved_operation
    ON api_workflow_steps(resolved_path_operation_id) WHERE resolved_path_operation_id IS NOT NULL;

COMMENT ON TABLE api_workflow_steps IS 'Ordered steps of an imported Arazzo workflow, with operationRef resolution state (WorkflowStep) (#2773, REPO-3.4)';
COMMENT ON COLUMN api_workflow_steps.id IS 'Unique identifier for the step';
COMMENT ON COLUMN api_workflow_steps.tenant_id IS 'Owning tenant (denormalized for tenant-scoped queries); cascade-deleted with the tenant';
COMMENT ON COLUMN api_workflow_steps.version_id IS 'Owning schema revision (versions.id), denormalized from the workflow';
COMMENT ON COLUMN api_workflow_steps.workflow_id IS 'Parent api_workflows row; cascade-deleted with it';
COMMENT ON COLUMN api_workflow_steps.step_id IS 'Source `stepId`; unique within the workflow';
COMMENT ON COLUMN api_workflow_steps.order_index IS 'Zero-based position of the step within the workflow';
COMMENT ON COLUMN api_workflow_steps.description IS 'Source `description`/`summary` of the step if present';
COMMENT ON COLUMN api_workflow_steps.operation_ref IS 'Raw `operationRef` exactly as written; retained even when resolution fails';
COMMENT ON COLUMN api_workflow_steps.operation_id IS 'Raw `operationId` exactly as written; retained even when resolution fails';
COMMENT ON COLUMN api_workflow_steps.resolved_path_operation_id IS 'Internal path_operation this step targets when the referenced OpenAPI operation was imported in the same scan; NULL otherwise. SET NULL on delete so a removed operation degrades the step rather than dropping it';
COMMENT ON COLUMN api_workflow_steps.resolution_status IS 'resolved | unresolved | not_applicable | parse_error. not_applicable = the step targets a workflow, not an operation; parse_error = the step could not be read and was isolated';
COMMENT ON COLUMN api_workflow_steps.resolution_reason IS 'Stable machine reason for a non-resolved step (no-operation-target, unknown-operation, ambiguous-operation, unparsable-ref, calls-workflow, malformed-step); NULL when resolved';
COMMENT ON COLUMN api_workflow_steps.parameters IS 'Source `parameters` array, stored verbatim';
COMMENT ON COLUMN api_workflow_steps.success_criteria IS 'Source `successCriteria` array, stored verbatim';
COMMENT ON COLUMN api_workflow_steps.on_failure IS 'Source `onFailure` array, stored verbatim';
COMMENT ON COLUMN api_workflow_steps.outputs IS 'Source `outputs` map (name → runtime expression), stored verbatim';
COMMENT ON COLUMN api_workflow_steps.depends_on IS 'Source `dependsOn` array of sibling step ids, stored verbatim';
COMMENT ON COLUMN api_workflow_steps.extras IS 'Arazzo step attributes the columns do not model (requestBody, workflowId, onSuccess, …)';
COMMENT ON COLUMN api_workflow_steps.deleted_at IS 'Soft delete timestamp; null means the step is live';
COMMENT ON COLUMN api_workflow_steps.created_at IS 'Timestamp when the step row was created';
COMMENT ON COLUMN api_workflow_steps.updated_at IS 'Timestamp when the step row was last updated';
