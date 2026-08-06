-- Workspace custom palette actions — DUW-5.5 (private-suite#2592).
--
-- Problem: the ⌘K palette's `Actions` band is a fixed registry of five built-ins (DUW-5.4,
-- private-suite#2591). "Programmable" means a tenant defining its own rows — `Open runbook for
-- {subject}` against every class whose name contains `Invoice` — without anything resembling code
-- execution. That requires the definitions to live somewhere durable, tenant-scoped, and small
-- enough to fetch alongside a palette open.
--
-- Solution: one `apiome.workspace_custom_actions` table. A row is a *declaration*, never a script:
-- a display name, an applicability matcher (which kind of palette subject it offers itself for,
-- optionally narrowed to labels containing a substring), and an ordered list of effects drawn from
-- a closed vocabulary (`hydrate-set`, `lens-switch`, `open-inspector-tab`,
-- `run-consumption-query`, `open-url`). Three properties are enforced here rather than in the
-- service:
--
--   1. The effects column can only ever hold a bounded JSON array. `jsonb_typeof = 'array'`, an
--      element count of 1–5, and an octet cap mean no write path — including a future one that
--      forgets the service-side schema — can park a script, a megabyte, or a bare object here. The
--      *vocabulary* of the elements is the service schema's job (`workspace_custom_action_rules`),
--      because SQL cannot readably say "an `open-url` effect carries exactly an https URL"; the
--      shape and size floor lives with the data.
--
--   2. The matcher's subject kinds are the palette's, closed by CHECK. A row claiming a subject
--      the palette will never produce (`'folder'`) would be dead weight the UI has to defend
--      against forever; rejecting it at the column keeps every stored row interpretable.
--
--   3. A name is unique per tenant among live rows, case-insensitively. Two actions both drawn as
--      `Open runbook…` in one band are indistinguishable to the reader; the partial index frees
--      the name the moment its holder is soft-deleted.
--
-- Deletion is soft (`deleted_at`), matching `apiome.domains` (V242): a tenant's action list is
-- configuration, and configuration benefits from a tombstone more than from a vacancy.
--
-- Rollback notes (in order):
--   DROP TRIGGER IF EXISTS trigger_update_workspace_custom_actions_updated_at
--       ON apiome.workspace_custom_actions;
--   DROP FUNCTION IF EXISTS apiome.update_workspace_custom_actions_updated_at();
--   DROP TABLE IF EXISTS apiome.workspace_custom_actions;

SET search_path TO apiome, public;

CREATE TABLE IF NOT EXISTS apiome.workspace_custom_actions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id      UUID NOT NULL REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    created_by     UUID REFERENCES apiome.users(id) ON DELETE SET NULL,
    name           VARCHAR(120) NOT NULL,
    subject        VARCHAR(16) NOT NULL,
    name_contains  VARCHAR(200),
    effects        JSONB NOT NULL,
    deleted_at     TIMESTAMP WITH TIME ZONE,
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- The name is the row the palette draws; blank would render an unclickable empty sentence.
    CONSTRAINT workspace_custom_actions_name_not_blank CHECK (btrim(name) <> ''),

    -- The palette's subject kinds, plus `any` for an action indifferent to what matched.
    CONSTRAINT workspace_custom_actions_subject_vocabulary
        CHECK (subject IN ('class', 'path', 'property', 'any')),

    -- An empty narrowing matches nothing forever; absent is the honest spelling of "no narrowing".
    CONSTRAINT workspace_custom_actions_name_contains_not_blank
        CHECK (name_contains IS NULL OR btrim(name_contains) <> ''),

    -- Property 1: a bounded array, never a script, an object, or a payload (header).
    CONSTRAINT workspace_custom_actions_effects_array CHECK (jsonb_typeof(effects) = 'array'),
    CONSTRAINT workspace_custom_actions_effects_count
        CHECK (jsonb_array_length(effects) BETWEEN 1 AND 5),
    CONSTRAINT workspace_custom_actions_effects_size
        CHECK (octet_length(effects::text) <= 16384)
);

COMMENT ON TABLE apiome.workspace_custom_actions IS
    'Tenant-defined ⌘K palette actions (DUW-5.5). A row is a declarative definition — matcher '
    'plus a closed-vocabulary effect list — interpreted by the workspace client; it never holds '
    'executable code.';
COMMENT ON COLUMN apiome.workspace_custom_actions.id IS 'Unique identifier for the action';
COMMENT ON COLUMN apiome.workspace_custom_actions.tenant_id IS
    'Tenant the action belongs to; every read and write is scoped by it';
COMMENT ON COLUMN apiome.workspace_custom_actions.created_by IS
    'User who created the action, for attribution; NULL once that user is deleted';
COMMENT ON COLUMN apiome.workspace_custom_actions.name IS
    'The sentence the palette row draws. May carry one {subject} placeholder, replaced by the '
    'matched subject''s label.';
COMMENT ON COLUMN apiome.workspace_custom_actions.subject IS
    'Which kind of palette subject the action offers itself for: class, path, property, or any';
COMMENT ON COLUMN apiome.workspace_custom_actions.name_contains IS
    'Optional matcher narrowing: the subject''s label must contain this substring, '
    'case-insensitively. NULL applies the action to every subject of the kind.';
COMMENT ON COLUMN apiome.workspace_custom_actions.effects IS
    'Ordered JSON array of declarative effects from the closed vocabulary (hydrate-set, '
    'lens-switch, open-inspector-tab, run-consumption-query, open-url). Element shapes are '
    'validated by the service (workspace_custom_action_rules); this column pins the array shape '
    'and size.';
COMMENT ON COLUMN apiome.workspace_custom_actions.deleted_at IS
    'Soft delete timestamp — NULL means live. A deleted action frees its name for reuse.';
COMMENT ON COLUMN apiome.workspace_custom_actions.created_at IS
    'Timestamp when the action was created';
COMMENT ON COLUMN apiome.workspace_custom_actions.updated_at IS
    'Timestamp when the action was last modified';

-- Property 3: one live action per name per tenant, case-insensitively; the tombstone frees it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_custom_actions_tenant_name
    ON apiome.workspace_custom_actions (tenant_id, lower(name)) WHERE deleted_at IS NULL;

-- The palette's read: every live action of one tenant.
CREATE INDEX IF NOT EXISTS idx_workspace_custom_actions_tenant
    ON apiome.workspace_custom_actions (tenant_id) WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION apiome.update_workspace_custom_actions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apiome.update_workspace_custom_actions_updated_at() IS
    'Keeps workspace_custom_actions.updated_at current on every UPDATE';

DROP TRIGGER IF EXISTS trigger_update_workspace_custom_actions_updated_at
    ON apiome.workspace_custom_actions;
CREATE TRIGGER trigger_update_workspace_custom_actions_updated_at
    BEFORE UPDATE ON apiome.workspace_custom_actions
    FOR EACH ROW
    EXECUTE FUNCTION apiome.update_workspace_custom_actions_updated_at();
