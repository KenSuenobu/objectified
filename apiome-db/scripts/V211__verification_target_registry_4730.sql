-- Environment and target registry — ECA-1.2 (#4730).
--
-- Problem: the URL a contract suite is executed against, and the credential used to reach it, are
-- currently ad hoc — a CI variable here, a shell export there. Nothing records which target a run
-- used, nothing stops a target from pointing at an internal address, and nothing distinguishes a
-- staging box anyone may hit from a production endpoint only a release runner may touch.
--
-- Solution: two additive tables.
--
--   * ``verification_target``       — the named, tenant-scoped definition of *where* verification
--                                     runs: base URL, environment class, network class, the
--                                     *reference* to a credential, and the execution/failure
--                                     policy. Mutable (a staging URL moves), soft-deleted (an
--                                     ECA-1.3 evidence row must still resolve the target it names).
--   * ``verification_target_audit`` — the append-only ledger of every create, update, delete, and
--                                     **resolve**. "Which target did this run use, who selected it,
--                                     and was that allowed" is answered from here, not inferred.
--
-- The invariant that shapes both tables: **a target never holds a secret.** ``auth_kind`` says where
-- the credential lives, ``auth_ref`` names it, and the CHECK constraints below make an accidental
-- paste of a raw token structurally impossible to store:
--
--   * ``env``    — ``auth_ref`` must match the environment-variable grammar ``^[A-Z_][A-Z0-9_]*$``.
--                  A bearer token, a base64 blob, or a JWT cannot satisfy it (all contain characters
--                  outside the class, and a JWT contains ``.``). The runner reads the variable from
--                  its own environment; the platform never sees the value.
--   * ``stored`` — ``auth_ref`` must be a UUID: the id of a row in the existing encrypted credential
--                  vault (``apiome.mcp_endpoint_credentials``, V129), which keeps ciphertext and key
--                  version. The target holds the pointer; the vault keeps the secret.
--   * ``none``   — no reference at all, and the scheme/ref columns must be NULL.
--
-- ``auth_scheme`` and ``auth_header_name`` describe how the resolved secret is *presented*
-- (``Authorization: Bearer …``, a named header, or HTTP Basic). Those are shapes, not secrets, and
-- the header name is constrained to the RFC 9110 token grammar so a stored name can never split a
-- request. Nothing in this schema can hold credential material.
--
-- SSRF: ``base_url`` must be http/https and may not embed ``user:pass@`` credentials (CHECKs below);
-- resolving to a private address is rejected at the API boundary by ``app.ssrf_guard``, which
-- resolves DNS and is therefore the only place that check can be made honestly. A target that
-- genuinely must reach a private network sets ``network_class = 'private'`` and then *must* carry an
-- approver and a reason — the escape hatch exists, but it cannot be taken silently.
--
-- RBAC: adds the ``verification_targets`` resource to the built-in role grids (Owner/Admin manage,
-- Editor and Viewer may only view — and *view* is what a run needs to resolve one). This follows the
-- V175 pattern: replace ``apiome.seed_builtin_roles`` wholesale and reseed every tenant.
--
-- Rollback notes (reverse carefully in shared environments):
--   DROP FUNCTION IF EXISTS apiome.purge_verification_target_audit(INTEGER);
--   DROP TABLE IF EXISTS apiome.verification_target_audit;
--   DROP TABLE IF EXISTS apiome.verification_target;
--   -- and re-apply the V175 body of apiome.seed_builtin_roles to drop the new resource.
-- (The V128 guard function apiome.mcp_forbid_row_mutation() is shared — do not drop it here.)

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- verification_target — the named definition of where a contract suite is executed.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_target (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Scope. A target belongs to exactly one tenant and is never visible outside it.
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- The stable handle CI uses (``--target staging``). Lowercase kebab so it survives a shell,
    -- a YAML file, and a URL path segment unquoted.
    slug VARCHAR(128) NOT NULL,
    name TEXT NOT NULL,
    description TEXT,

    -- What kind of environment this is. Drives policy defaults and makes "was this run against
    -- production" answerable from the record instead of by reading the URL.
    environment TEXT NOT NULL
        CONSTRAINT verification_target_environment_check
            CHECK (environment IN ('mock', 'development', 'test', 'staging', 'production')),

    -- Where it lives. Scheme-restricted and credential-free by construction; the private-address
    -- check needs DNS and therefore happens at the API boundary (app.ssrf_guard).
    base_url TEXT NOT NULL,

    -- public = must resolve to a globally routable address (the default, and what the SSRF guard
    -- enforces). private = an explicitly approved internal target; approver and reason are then
    -- mandatory, so the exception is always attributable.
    network_class TEXT NOT NULL DEFAULT 'public'
        CONSTRAINT verification_target_network_class_check
            CHECK (network_class IN ('public', 'private')),
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMP WITH TIME ZONE,
    approval_reason TEXT,

    -- The credential *reference*. See the header: none | env | stored, never a secret.
    auth_kind TEXT NOT NULL DEFAULT 'none'
        CONSTRAINT verification_target_auth_kind_check
            CHECK (auth_kind IN ('none', 'env', 'stored')),
    auth_scheme TEXT
        CONSTRAINT verification_target_auth_scheme_check
            CHECK (auth_scheme IS NULL OR auth_scheme IN ('bearer', 'header', 'basic')),
    auth_ref TEXT,
    auth_header_name TEXT,

    -- Execution and failure policy: timeouts, concurrency, retries, whether mutating methods may be
    -- exercised, and what a failure does to a gate. Shape is validated by
    -- app.verification_target.VerificationPolicy; the schema only guarantees it is an object.
    policy JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- A disabled target stays defined and referenceable but cannot be resolved for a run.
    enabled BOOLEAN NOT NULL DEFAULT TRUE,

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Soft delete: evidence written by ECA-1.3 names a target id, and that reference must keep
    -- resolving after the target is retired.
    deleted_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT verification_target_slug_shape_check
        CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$' OR slug ~ '^[a-z0-9]$'),

    -- http/https only: no file:, gopher:, or data: target can be stored.
    CONSTRAINT verification_target_base_url_scheme_check
        CHECK (base_url ~* '^https?://'),

    -- No ``user:pass@host`` in the authority — a credential in a URL is both a secret in a target
    -- record and a classic redirect-smuggling trick.
    CONSTRAINT verification_target_base_url_no_credentials_check
        CHECK (base_url !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*@'),

    -- A private-network target must be approved by someone, with a stated reason.
    CONSTRAINT verification_target_private_requires_approval_check
        CHECK (
            network_class <> 'private'
            OR (
                approved_by IS NOT NULL
                AND approved_at IS NOT NULL
                AND approval_reason IS NOT NULL
                AND length(btrim(approval_reason)) > 0
            )
        ),

    -- Secret-free guarantees on the credential reference.
    --   none   -> no scheme, no ref, no header name.
    --   env    -> a scheme and an environment-variable *name* (never a value).
    --   stored -> a scheme and a UUID pointing at the encrypted credential vault.
    CONSTRAINT verification_target_auth_none_is_empty_check
        CHECK (
            auth_kind <> 'none'
            OR (auth_scheme IS NULL AND auth_ref IS NULL AND auth_header_name IS NULL)
        ),
    CONSTRAINT verification_target_auth_requires_scheme_check
        CHECK (auth_kind = 'none' OR auth_scheme IS NOT NULL),
    CONSTRAINT verification_target_auth_env_ref_shape_check
        CHECK (auth_kind <> 'env' OR auth_ref ~ '^[A-Z_][A-Z0-9_]*$'),
    CONSTRAINT verification_target_auth_stored_ref_shape_check
        CHECK (
            auth_kind <> 'stored'
            OR auth_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        ),
    -- A named header needs a name, and only the 'header' scheme may have one. RFC 9110 token
    -- grammar, so a stored name can never break the header framing.
    CONSTRAINT verification_target_auth_header_name_check
        CHECK (
            (auth_scheme = 'header' AND auth_header_name ~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$')
            OR (auth_scheme IS DISTINCT FROM 'header' AND auth_header_name IS NULL)
        ),

    CONSTRAINT verification_target_policy_object_check
        CHECK (jsonb_typeof(policy) = 'object')
);

COMMENT ON TABLE verification_target IS
    'Tenant-scoped, secret-free definition of a verification target: base URL, environment/network class, credential reference, and execution policy (ECA-1.2, #4730)';
COMMENT ON COLUMN verification_target.id IS 'Unique identifier; the target identity an ECA-1.3 evidence row records';
COMMENT ON COLUMN verification_target.tenant_id IS 'Tenant that owns the target; a target is never visible outside it';
COMMENT ON COLUMN verification_target.slug IS 'Stable handle used from CLI/CI (lowercase kebab); unique per tenant among live targets';
COMMENT ON COLUMN verification_target.name IS 'Human-readable display name';
COMMENT ON COLUMN verification_target.description IS 'Optional operator note about what this target is';
COMMENT ON COLUMN verification_target.environment IS 'mock | development | test | staging | production; makes "was this production" answerable from the record';
COMMENT ON COLUMN verification_target.base_url IS 'Base URL the compiled suite''s relative paths are joined onto; http/https and credential-free by CHECK';
COMMENT ON COLUMN verification_target.network_class IS 'public (must resolve to a globally routable address) | private (explicitly approved internal target)';
COMMENT ON COLUMN verification_target.approved_by IS 'User who approved a private-network target; required when network_class = private';
COMMENT ON COLUMN verification_target.approved_at IS 'When the private-network exception was approved';
COMMENT ON COLUMN verification_target.approval_reason IS 'Why a private-network target is justified; required when network_class = private';
COMMENT ON COLUMN verification_target.auth_kind IS 'none | env (runner-resolved environment variable) | stored (id in the encrypted credential vault); never a secret';
COMMENT ON COLUMN verification_target.auth_scheme IS 'How the resolved secret is presented: bearer | header | basic';
COMMENT ON COLUMN verification_target.auth_ref IS 'The reference itself: an environment-variable NAME, or a credential-vault UUID; CHECK-constrained so a raw token cannot be stored here';
COMMENT ON COLUMN verification_target.auth_header_name IS 'Header field-name for the header scheme (RFC 9110 token grammar)';
COMMENT ON COLUMN verification_target.policy IS 'Execution and failure policy: timeouts, concurrency, retries, mutating-method permission, TLS verification, gate behaviour';
COMMENT ON COLUMN verification_target.enabled IS 'FALSE keeps the definition but refuses resolution for new runs';
COMMENT ON COLUMN verification_target.created_by IS 'User who created the target; NULL if later deleted or system-created';
COMMENT ON COLUMN verification_target.updated_by IS 'User who last modified the target';
COMMENT ON COLUMN verification_target.created_at IS 'When the target was defined';
COMMENT ON COLUMN verification_target.updated_at IS 'When the target was last modified';
COMMENT ON COLUMN verification_target.deleted_at IS 'Soft-delete timestamp; retired targets stay resolvable for the evidence rows that name them';

-- One live target per slug per tenant. Partial, so a retired slug can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_target_tenant_slug_live
    ON verification_target (tenant_id, slug)
    WHERE deleted_at IS NULL;

-- The list read: a tenant's live targets, newest first.
CREATE INDEX IF NOT EXISTS idx_verification_target_tenant_live
    ON verification_target (tenant_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------------
-- verification_target_audit — append-only ledger of definition changes and target selection.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_target_audit (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- The target acted on. NULL only when the action never reached one (a resolve of a slug that
    -- does not exist is still audited — a probe for target names is worth seeing).
    target_id UUID REFERENCES verification_target(id) ON DELETE SET NULL,
    -- Snapshot of the slug as it was at the time, so the ledger stays readable after a rename or a
    -- purge of the target row.
    target_slug VARCHAR(128),

    action TEXT NOT NULL
        CONSTRAINT verification_target_audit_action_check
            CHECK (action IN (
                'target.create', 'target.update', 'target.delete', 'target.resolve'
            )),
    outcome TEXT NOT NULL
        CONSTRAINT verification_target_audit_outcome_check
            CHECK (outcome IN ('success', 'denied', 'failure')),
    -- Stable machine code for a denial/failure (target-disabled, target-private-network, …).
    -- Required whenever the outcome is not success: a refusal always says why.
    reason TEXT,

    -- Who acted. actor_kind separates an interactive user from a CI runner authenticating with an
    -- API key, which is exactly the distinction "only authorized users and runners" is about.
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_label TEXT,
    actor_kind TEXT NOT NULL DEFAULT 'user'
        CONSTRAINT verification_target_audit_actor_kind_check
            CHECK (actor_kind IN ('user', 'api_key', 'system')),

    -- Non-secret context: changed field names, the environment/network class resolved, the suite
    -- digest a run named. Never credential material.
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT verification_target_audit_reason_required_check
        CHECK (outcome = 'success' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
    CONSTRAINT verification_target_audit_detail_object_check
        CHECK (jsonb_typeof(detail) = 'object')
);

COMMENT ON TABLE verification_target_audit IS
    'Append-only ledger of verification-target definition changes and target selection (resolve), including denials (ECA-1.2, #4730)';
COMMENT ON COLUMN verification_target_audit.target_id IS 'Target acted on; NULL when the action named a target that does not exist';
COMMENT ON COLUMN verification_target_audit.target_slug IS 'Slug as it was at the time, so the ledger survives a rename';
COMMENT ON COLUMN verification_target_audit.action IS 'target.create | target.update | target.delete | target.resolve';
COMMENT ON COLUMN verification_target_audit.outcome IS 'success | denied | failure; anything but success must carry a reason code';
COMMENT ON COLUMN verification_target_audit.reason IS 'Stable machine code explaining a denial or failure';
COMMENT ON COLUMN verification_target_audit.actor_id IS 'Acting user; NULL for an unattributable API-key call or a system action';
COMMENT ON COLUMN verification_target_audit.actor_label IS 'Email or name of the actor as displayed at the time';
COMMENT ON COLUMN verification_target_audit.actor_kind IS 'user | api_key (a CI runner) | system';
COMMENT ON COLUMN verification_target_audit.detail IS 'Non-secret context (changed fields, environment/network class, suite digest); never credential material';
COMMENT ON COLUMN verification_target_audit.created_at IS 'When the action happened (insert-only)';

-- The audit read: a tenant's ledger newest first, and one target's history.
CREATE INDEX IF NOT EXISTS idx_verification_target_audit_tenant
    ON verification_target_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_target_audit_target
    ON verification_target_audit (target_id, created_at DESC);

-- Immutability: audit rows are write-once. A BEFORE UPDATE trigger rejects any in-place edit;
-- DELETE stays available to the FK cascades and to the retention sweep below.
DROP TRIGGER IF EXISTS trigger_verification_target_audit_immutable ON verification_target_audit;
CREATE TRIGGER trigger_verification_target_audit_immutable
    BEFORE UPDATE ON verification_target_audit
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();

-- ---------------------------------------------------------------------------------------------------
-- Retention: the ledger is bounded by age, not by row count.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_verification_target_audit(p_retention_days INTEGER DEFAULT 365)
RETURNS INTEGER AS $$
DECLARE
    v_purged INTEGER;
    v_cutoff TIMESTAMP WITH TIME ZONE := CURRENT_TIMESTAMP - (GREATEST(p_retention_days, 0) * INTERVAL '1 day');
BEGIN
    DELETE FROM apiome.verification_target_audit WHERE created_at < v_cutoff;
    GET DIAGNOSTICS v_purged = ROW_COUNT;
    RETURN v_purged;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION purge_verification_target_audit(INTEGER) IS
    'Hard-delete verification-target audit entries older than p_retention_days (default 365). Returns the number of purged rows (ECA-1.2, #4730).';

-- ---------------------------------------------------------------------------------------------------
-- RBAC: verification_targets resource in the built-in role grids.
-- ---------------------------------------------------------------------------------------------------
-- Full replacement of the V175 function body with 'verification_targets' added. The function
-- rewrites the built-in grids from scratch on every call and apiome-rest re-invokes it on demand,
-- so replacing it here and reseeding below is idempotent and self-healing for all tenants.
--
-- Grid rationale: managing a target is a security decision (it names a URL and a credential), so
-- create/edit/delete are Owner/Admin. *Viewing* a target is what resolving one for a run requires,
-- and every member needs that to verify their own work — so Editor and Viewer get view.
CREATE OR REPLACE FUNCTION apiome.seed_builtin_roles(p_tenant UUID)
RETURNS void AS $$
DECLARE
    v_owner UUID;
    v_admin UUID;
    v_editor UUID;
    v_viewer UUID;
    -- Resources that behave like editable content (full CRUD for Editor).
    content_resources TEXT[] := ARRAY['projects','versions','classes','properties','paths','imports','api_keys'];
    all_resources TEXT[] := ARRAY['projects','versions','classes','properties','paths','types','imports','members','api_keys','billing','lint_findings','verification_targets'];
    r TEXT;
BEGIN
    -- Upsert the four built-in roles.
    INSERT INTO apiome.roles (tenant_id, slug, name, description, is_builtin) VALUES
        (p_tenant, 'owner',  'Owner',  'Full control of the tenant, including billing and members.', true),
        (p_tenant, 'admin',  'Admin',  'Manage members, roles, and all content; no billing administration.', true),
        (p_tenant, 'editor', 'Editor', 'Create and edit content, but cannot publish, manage members, or change settings.', true),
        (p_tenant, 'viewer', 'Viewer', 'Read-only access to the tenant.', true)
    ON CONFLICT (tenant_id, slug) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            is_builtin = true;

    SELECT id INTO v_owner  FROM apiome.roles WHERE tenant_id = p_tenant AND slug = 'owner';
    SELECT id INTO v_admin  FROM apiome.roles WHERE tenant_id = p_tenant AND slug = 'admin';
    SELECT id INTO v_editor FROM apiome.roles WHERE tenant_id = p_tenant AND slug = 'editor';
    SELECT id INTO v_viewer FROM apiome.roles WHERE tenant_id = p_tenant AND slug = 'viewer';

    -- Rewrite built-in grids from scratch (idempotent / self-healing).
    DELETE FROM apiome.role_permissions WHERE role_id IN (v_owner, v_admin, v_editor, v_viewer);

    -- Owner: every action on every resource, plus version publishing and waiver approval.
    FOREACH r IN ARRAY all_resources LOOP
        INSERT INTO apiome.role_permissions (role_id, resource, action)
        SELECT v_owner, r, a FROM unnest(ARRAY['view','create','edit','delete']) AS a;
    END LOOP;
    INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_owner, 'versions', 'publish');
    INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_owner, 'lint_findings', 'publish');

    -- Admin: same as Owner but billing is view-only (billing administration is Owner-only).
    FOREACH r IN ARRAY all_resources LOOP
        IF r = 'billing' THEN
            INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_admin, 'billing', 'view');
        ELSE
            INSERT INTO apiome.role_permissions (role_id, resource, action)
            SELECT v_admin, r, a FROM unnest(ARRAY['view','create','edit','delete']) AS a;
        END IF;
    END LOOP;
    INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_admin, 'versions', 'publish');
    INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_admin, 'lint_findings', 'publish');

    -- Editor: full CRUD on content resources; view-only on governance resources; no publish.
    -- lint_findings: view + edit (assign, acknowledge, request waivers) but no approval.
    -- verification_targets: view only — enough to run verification, not to redefine where it points.
    FOREACH r IN ARRAY content_resources LOOP
        INSERT INTO apiome.role_permissions (role_id, resource, action)
        SELECT v_editor, r, a FROM unnest(ARRAY['view','create','edit','delete']) AS a;
    END LOOP;
    INSERT INTO apiome.role_permissions (role_id, resource, action)
    SELECT v_editor, res, 'view' FROM unnest(ARRAY['types','members','billing','verification_targets']) AS res;
    INSERT INTO apiome.role_permissions (role_id, resource, action)
    SELECT v_editor, 'lint_findings', a FROM unnest(ARRAY['view','edit']) AS a;

    -- Viewer: view-only on every resource.
    FOREACH r IN ARRAY all_resources LOOP
        INSERT INTO apiome.role_permissions (role_id, resource, action) VALUES (v_viewer, r, 'view');
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apiome.seed_builtin_roles(UUID) IS
    'Idempotently (re)seed the four built-in roles and their canonical permission grids for a tenant (#3611; lint_findings added by #4859; verification_targets added by #4730)';

COMMENT ON COLUMN apiome.role_permissions.resource IS
    'One of: projects, versions, classes, properties, paths, types, imports, members, api_keys, billing, lint_findings, verification_targets';

-- Reseed every existing tenant so the new resource lands in all built-in grids.
DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT id FROM apiome.tenants LOOP
        PERFORM apiome.seed_builtin_roles(t.id);
    END LOOP;
END;
$$;
