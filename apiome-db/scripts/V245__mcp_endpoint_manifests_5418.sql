-- Static MCP server manifests as a catalog source — FMT-1.7 (#5418).
--
-- Every fact the MCP catalog holds today was *observed*: a transport was opened, `initialize` was
-- answered, four list methods were paged, and what came back became an `mcp_endpoint_versions`
-- snapshot with its `mcp_capability_items` children. That is the only way in. An operator holding a
-- complete description of a server that is offline, air-gapped, or unreachable from Apiome has no
-- path into the catalog at all, and MCP appears nowhere in the import-source registry.
--
-- This migration adds the second lane: a **declared** surface, attached to an endpoint, sourced from
-- a manifest instead of a probe.
--
--   mcp_endpoint_manifests — the surface an operator DECLARES, and where that declaration came from.
--
-- ---------------------------------------------------------------------------------------------------
-- A manifest is a source of FACTS, not a version snapshot (AC: "provenance distinguishes declared
-- manifest facts from observed probe facts")
-- ---------------------------------------------------------------------------------------------------
-- The obvious shortcut would be to write a manifest into `mcp_endpoint_versions` with a new
-- `discovery_trigger` value. That is precisely the mistake the split exists to prevent: a version
-- snapshot means "this is what the server was doing when we looked", every consumer of that table
-- reads it that way (the change feed, the freshness report, the conformance engine, the score), and
-- a declared surface would silently start driving all of them as though somebody had looked. So the
-- declaration lives in its own table, is never a version, and never moves `current_version_id`.
--
-- What it *is* allowed to do is answer "how do we know this?" — `app.mcp_surface_provenance` reads a
-- row here beside the endpoint's current version and attributes each fact to `declared`, `observed`,
-- or `both`. Where the two disagree, both values are reported and neither wins.
--
-- ---------------------------------------------------------------------------------------------------
-- One endpoint, many manifests, no duplicates (AC: "importing a manifest does not create a duplicate
-- endpoint when one already exists from probing; it attaches as a source of the same endpoint")
-- ---------------------------------------------------------------------------------------------------
-- `endpoint_id` is the whole point: a manifest attaches to the endpoint the probe already created,
-- resolved by normalized endpoint URL (`app.mcp_duplicate_detection.normalize_mcp_endpoint_url_for_dedup`).
-- Re-importing the same manifest must not pile up rows, so a partial unique index makes
-- (endpoint_id, surface_fingerprint) unique among live rows — re-importing an unchanged manifest
-- updates the existing row's `updated_at` instead of inserting a second identical declaration, while
-- a *revised* manifest gets its own row and the previous one is retired rather than overwritten.
--
-- ---------------------------------------------------------------------------------------------------
-- The declared surface is stored whole, not exploded
-- ---------------------------------------------------------------------------------------------------
-- `surface` holds the canonical semantic projection (`DiscoverySurface.canonical_dict()`), which is
-- exactly the input its `surface_fingerprint` is taken over. Storing the projection rather than
-- per-item rows keeps the declaration unambiguously separate from `mcp_capability_items` (whose rows
-- are, by definition, observed) and makes the fingerprint recomputable from what is stored — a
-- stored fingerprint that cannot be re-derived is a claim nobody can check.
--
-- Rollback notes:
--   DROP TABLE IF EXISTS apiome.mcp_endpoint_manifests;
-- (Additive and self-contained: no existing table, column, constraint or value is touched.)
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout.

SET search_path TO apiome, public;

CREATE TABLE IF NOT EXISTS mcp_endpoint_manifests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Denormalized from the endpoint so tenant-scoped listing never needs a join, and so a manifest
    -- cascades away with its tenant.
    tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    -- The endpoint this manifest describes. A manifest is a fact about the ENDPOINT (like a source
    -- association, V172), not about any one of its version snapshots.
    endpoint_id UUID NOT NULL REFERENCES mcp_endpoints (id) ON DELETE CASCADE,

    -- Where the declaration came from, as the importer received it: a filename, a URL, or the
    -- literal 'pasted'. Descriptive only — nothing here is ever fetched.
    source_label TEXT,

    -- The declared surface's stable fingerprint, computed by the SAME code a probe's surface uses
    -- (app.mcp_client.normalize.DiscoverySurface.fingerprint). Equal to the endpoint's observed
    -- fingerprint exactly when the manifest describes what discovery saw.
    surface_fingerprint TEXT NOT NULL,

    -- Server identity as the manifest declares it. Mirrors the mcp_endpoint_versions columns so the
    -- two can be compared field by field without unpacking JSON on the read path.
    protocol_version VARCHAR(64),
    server_name VARCHAR(255),
    server_title VARCHAR(255),
    server_version VARCHAR(128),
    instructions TEXT,
    capabilities JSONB,

    -- The full canonical semantic projection of the declared surface — the exact input the
    -- fingerprint above is taken over, so the claim is re-derivable from the row.
    surface JSONB NOT NULL,

    -- Declared capability counts, promoted for listings that must not parse `surface` to show them.
    tool_count INTEGER NOT NULL DEFAULT 0,
    resource_count INTEGER NOT NULL DEFAULT 0,
    resource_template_count INTEGER NOT NULL DEFAULT 0,
    prompt_count INTEGER NOT NULL DEFAULT 0,

    -- Who imported it. RESTRICT, not CASCADE: deleting a user must not erase the provenance of a
    -- declaration that the detail view attributes facts to.
    imported_by UUID REFERENCES users (id) ON DELETE RESTRICT,

    -- Soft retirement. A superseded manifest stays readable so an attribution made against it
    -- remains interpretable; hard-deleting it would orphan that history.
    retired_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT mcp_endpoint_manifests_counts_check
        CHECK (
            tool_count >= 0
            AND resource_count >= 0
            AND resource_template_count >= 0
            AND prompt_count >= 0
        ),

    CONSTRAINT mcp_endpoint_manifests_fingerprint_check
        CHECK (length(btrim(surface_fingerprint)) > 0)
);

COMMENT ON TABLE mcp_endpoint_manifests IS
    'A capability surface an operator DECLARED for an MCP endpoint via a static manifest, as opposed '
    'to one Apiome OBSERVED by probing (mcp_endpoint_versions). Never a version snapshot (#5418, FMT-1.7)';

COMMENT ON COLUMN mcp_endpoint_manifests.surface IS
    'The canonical semantic projection of the declared surface — the exact input surface_fingerprint '
    'is taken over, so the fingerprint is re-derivable from the row (#5418, FMT-1.7)';

-- Re-importing an unchanged manifest must update, never duplicate. Partial on `retired_at IS NULL`
-- so a superseded declaration with the same fingerprint can be re-attached later without colliding
-- with its own retired predecessor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_endpoint_manifests_live_fingerprint
    ON mcp_endpoint_manifests (endpoint_id, surface_fingerprint)
    WHERE retired_at IS NULL;

-- The detail view's read: this endpoint's live declarations, newest first.
CREATE INDEX IF NOT EXISTS idx_mcp_endpoint_manifests_endpoint
    ON mcp_endpoint_manifests (endpoint_id, created_at DESC);

-- Tenant-scoped listing / teardown.
CREATE INDEX IF NOT EXISTS idx_mcp_endpoint_manifests_tenant
    ON mcp_endpoint_manifests (tenant_id, created_at DESC);
