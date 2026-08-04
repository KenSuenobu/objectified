-- Domain model for schemas and paths — DUW-1.1 (private-suite#2568).
--
-- Problem: the unified workspace organizes a catalog into domain folders (`customers/`,
-- `billing/`, `webhooks/`, `shared/`) and scopes the canvas to one of them. Today the catalog has
-- no hierarchy at all: `apiome.classes` and `apiome.version_path` are flat lists read with
-- `ORDER BY name ASC`. Project tags (V011) and canvas groups (V026/V027) look like candidates but
-- are neither — tags are project-scoped, many-to-many and user-defined for filtering; canvas
-- groups are per-layout visual furniture. A folder that scopes a *fetch* has to be exactly one
-- per item, version-scoped, and stored beside the item it groups. That is what this adds.
--
-- Solution: one `apiome.domains` table per version, plus a nullable `domain_id` on each of the two
-- member tables. Four properties are enforced here rather than in the service, because every one
-- of them would otherwise have to be re-asserted by each caller that ever writes these columns:
--
--   1. `shared/` is not a row. Unassigned members — `domain_id IS NULL` — are what the workspace
--      renders as the `shared/` folder. It is therefore a *derived* bucket that always exists,
--      never empties into nothing, and needs no backfill for items no heuristic could place. The
--      slug `shared` is reserved by CHECK so a real domain can never collide with it and leave two
--      different things drawing the same folder.
--
--   2. Deleting a domain never deletes content. `ON DELETE SET NULL` covers a hard delete, and
--      `trg_domains_soft_delete_release` covers the soft delete the API actually performs: the
--      instant `deleted_at` is set, members are released to `shared/`. Both routes lead to the
--      same place, so "delete a domain" can never be a way to lose a class.
--
--   3. A member's domain belongs to the member's own version. A foreign key cannot say this — it
--      constrains `domain_id` against `domains.id` but knows nothing about `version_id` on either
--      side — so `trg_*_domain_version_guard` says it. Without the guard, a class in version A
--      could be filed under a folder in version B and would then vanish from both trees.
--
--   4. A soft-deleted domain cannot be assigned to. The same guard rejects it, so the tombstone
--      cannot be resurrected by a stale client still holding its id.
--
-- Backfill. Every existing catalog has to land somewhere on the first render, and `shared/` for
-- all of it would be a redesign that shipped one flat list under a new name. So:
--
--   * Paths seed the domains. The first *meaningful* segment of a pathname is the folder:
--     meaningful excludes a templated segment (`/{customerId}` names an instance, not a group) and
--     an API version prefix (`/v1/` is carried by every path in the catalog, so partitioning on it
--     produces one folder containing everything — which is the flat list again). `/v1/customers/
--     {id}/addresses` therefore reads as `customers/`.
--
--   * Classes follow their tags. A class whose project tag slugifies to a seeded domain slug joins
--     it; the tag must belong to the class's own project, since `apiome.tags` is project-scoped and
--     two projects may legitimately both have a `billing` tag. A class carrying several matching
--     tags takes the first by sort order, deterministically, rather than an arbitrary one.
--
--   * Everything unmatched stays NULL and shows up in `shared/`. This is the honest outcome for a
--     catalog with no path structure and no tags, and it is exactly what the mockup's
--     `shared/ 8 classes · 0 ops` depicts.
--
-- The two helper functions exist only to keep the backfill readable and are dropped at the end of
-- this migration; nothing outside it may depend on them.
--
-- Rollback notes (in order):
--   DROP TRIGGER IF EXISTS trg_domains_soft_delete_release ON apiome.domains;
--   DROP TRIGGER IF EXISTS trg_version_path_domain_version_guard ON apiome.version_path;
--   DROP TRIGGER IF EXISTS trg_classes_domain_version_guard ON apiome.classes;
--   DROP FUNCTION IF EXISTS apiome.domain_soft_delete_release();
--   DROP FUNCTION IF EXISTS apiome.domain_membership_version_guard();
--   DROP TRIGGER IF EXISTS trigger_update_domains_updated_at ON apiome.domains;
--   DROP FUNCTION IF EXISTS apiome.update_domains_updated_at();
--   ALTER TABLE apiome.version_path DROP COLUMN IF EXISTS domain_id;
--   ALTER TABLE apiome.classes      DROP COLUMN IF EXISTS domain_id;
--   DROP TABLE IF EXISTS apiome.domains;

SET search_path TO apiome, public;

-- ─── 1. The domains table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS apiome.domains (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id  UUID NOT NULL REFERENCES apiome.versions(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    slug        VARCHAR(255) NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    deleted_at  TIMESTAMP WITH TIME ZONE,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- A name is what the tree prints; blank would render an unclickable empty folder.
    CONSTRAINT domains_name_not_blank CHECK (btrim(name) <> ''),

    -- A slug is what a URL and a `?domain_id=` filter carry, so it is restricted to the characters
    -- that survive both without escaping.
    CONSTRAINT domains_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),

    -- `shared` is the derived bucket for `domain_id IS NULL` (see header, property 1). A stored
    -- domain claiming that slug would put two distinct memberships behind one folder.
    CONSTRAINT domains_slug_not_reserved CHECK (slug <> 'shared')
);

COMMENT ON TABLE apiome.domains IS
    'Domain folders grouping classes and paths within a single version (DUW-1.1). Unassigned '
    'members are not stored here: they are the derived `shared/` bucket, so the reserved slug '
    '`shared` may never be taken by a row.';
COMMENT ON COLUMN apiome.domains.id IS 'Unique identifier for the domain';
COMMENT ON COLUMN apiome.domains.version_id IS
    'Version this domain groups within. Domains never span versions — see the membership guard '
    'trigger on classes and version_path.';
COMMENT ON COLUMN apiome.domains.name IS 'Display name shown in the workspace tree';
COMMENT ON COLUMN apiome.domains.slug IS
    'URL- and filter-safe identifier, unique per version among live domains. Never `shared`.';
COMMENT ON COLUMN apiome.domains.sort_order IS
    'Explicit tree ordering; ties broken by slug so the tree is stable when orders collide';
COMMENT ON COLUMN apiome.domains.deleted_at IS
    'Soft delete timestamp — NULL means live. Setting it releases every member to `shared/`.';
COMMENT ON COLUMN apiome.domains.created_at IS 'Timestamp when the domain was created';
COMMENT ON COLUMN apiome.domains.updated_at IS 'Timestamp when the domain was last modified';

-- Uniqueness applies only among live domains, so deleting `billing/` frees the name and the slug
-- for a later one without having to hard-delete the tombstone.
CREATE UNIQUE INDEX IF NOT EXISTS uq_domains_version_slug
    ON apiome.domains (version_id, slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_domains_version_name
    ON apiome.domains (version_id, lower(name)) WHERE deleted_at IS NULL;

-- The tree's read: every live domain of one version, already ordered.
CREATE INDEX IF NOT EXISTS idx_domains_version_order
    ON apiome.domains (version_id, sort_order, slug) WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION apiome.update_domains_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_domains_updated_at ON apiome.domains;
CREATE TRIGGER trigger_update_domains_updated_at
    BEFORE UPDATE ON apiome.domains
    FOR EACH ROW
    EXECUTE FUNCTION apiome.update_domains_updated_at();

-- ─── 2. Membership columns ───────────────────────────────────────────────────

-- Nullable by design: NULL *is* the `shared/` membership, not a missing value. ON DELETE SET NULL
-- makes a hard delete of a domain degrade to "these items moved to shared/" instead of taking the
-- classes and paths with it.
ALTER TABLE apiome.classes
    ADD COLUMN IF NOT EXISTS domain_id UUID REFERENCES apiome.domains(id) ON DELETE SET NULL;

ALTER TABLE apiome.version_path
    ADD COLUMN IF NOT EXISTS domain_id UUID REFERENCES apiome.domains(id) ON DELETE SET NULL;

COMMENT ON COLUMN apiome.classes.domain_id IS
    'Domain folder this class belongs to (DUW-1.1). NULL means the derived `shared/` bucket.';
COMMENT ON COLUMN apiome.version_path.domain_id IS
    'Domain folder this path belongs to (DUW-1.1). NULL means the derived `shared/` bucket.';

-- Domain-scoped fetches (DUW-1.2) read members by domain; the partial index on classes matches the
-- existing `deleted_at IS NULL` predicate used by every other classes index.
CREATE INDEX IF NOT EXISTS idx_classes_domain_id
    ON apiome.classes (domain_id) WHERE deleted_at IS NULL AND domain_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_version_path_domain_id
    ON apiome.version_path (domain_id) WHERE domain_id IS NOT NULL;

-- The `shared/` bucket is a query, so it needs an index too: "members of this version with no
-- domain" is exactly as common a read as "members of this domain".
CREATE INDEX IF NOT EXISTS idx_classes_version_shared
    ON apiome.classes (version_id) WHERE deleted_at IS NULL AND domain_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_version_path_version_shared
    ON apiome.version_path (version_id) WHERE domain_id IS NULL;

-- ─── 3. Membership integrity ─────────────────────────────────────────────────

-- Properties 3 and 4 from the header. Shared by both member tables: each has `version_id` and
-- `domain_id` columns of the same meaning, so one function serves both triggers.
CREATE OR REPLACE FUNCTION apiome.domain_membership_version_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_domain_version UUID;
BEGIN
    -- NULL is the `shared/` membership and is always legal.
    IF NEW.domain_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT version_id INTO v_domain_version
    FROM apiome.domains
    WHERE id = NEW.domain_id AND deleted_at IS NULL;

    IF v_domain_version IS NULL THEN
        RAISE EXCEPTION
            'domain % does not exist or has been deleted; assign NULL to place this item in shared/',
            NEW.domain_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_domain_version <> NEW.version_id THEN
        RAISE EXCEPTION
            'domain % belongs to version %, but this item belongs to version %',
            NEW.domain_id, v_domain_version, NEW.version_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apiome.domain_membership_version_guard() IS
    'Rejects a domain assignment that crosses versions or targets a soft-deleted domain. Expresses '
    'what the domain_id foreign key cannot: the referenced domain must share the members version.';

DROP TRIGGER IF EXISTS trg_classes_domain_version_guard ON apiome.classes;
CREATE TRIGGER trg_classes_domain_version_guard
    BEFORE INSERT OR UPDATE OF domain_id, version_id ON apiome.classes
    FOR EACH ROW
    EXECUTE FUNCTION apiome.domain_membership_version_guard();

DROP TRIGGER IF EXISTS trg_version_path_domain_version_guard ON apiome.version_path;
CREATE TRIGGER trg_version_path_domain_version_guard
    BEFORE INSERT OR UPDATE OF domain_id, version_id ON apiome.version_path
    FOR EACH ROW
    EXECUTE FUNCTION apiome.domain_membership_version_guard();

-- Property 2: a soft delete releases members instead of stranding them behind a tombstone the
-- guard above would then refuse to re-accept. Written as a trigger rather than left to the service
-- so that any writer — the API, a migration, a psql session — gets the same outcome.
CREATE OR REPLACE FUNCTION apiome.domain_soft_delete_release()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE apiome.classes      SET domain_id = NULL WHERE domain_id = NEW.id;
        UPDATE apiome.version_path SET domain_id = NULL WHERE domain_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apiome.domain_soft_delete_release() IS
    'Releases a soft-deleted domains classes and paths to the shared/ bucket. Deleting a domain '
    'must never remove catalog content.';

DROP TRIGGER IF EXISTS trg_domains_soft_delete_release ON apiome.domains;
CREATE TRIGGER trg_domains_soft_delete_release
    AFTER UPDATE OF deleted_at ON apiome.domains
    FOR EACH ROW
    EXECUTE FUNCTION apiome.domain_soft_delete_release();

-- ─── 4. Backfill helpers (dropped at the end of this migration) ──────────────

-- The first segment of a pathname that names a group rather than an instance or a release.
-- Returns NULL when a path has no such segment (`/`, `/{id}`, `/v1`), which lands it in `shared/`.
CREATE OR REPLACE FUNCTION apiome.duw2568_domain_segment(p_pathname TEXT)
RETURNS TEXT AS $$
DECLARE
    v_segment TEXT;
BEGIN
    FOREACH v_segment IN ARRAY regexp_split_to_array(COALESCE(p_pathname, ''), '/')
    LOOP
        CONTINUE WHEN v_segment = '';
        -- `/{customerId}` identifies one instance; it is not a folder anything else shares.
        CONTINUE WHEN v_segment LIKE '{%';
        -- `/v1/` prefixes every path in a versioned catalog, so it separates nothing.
        CONTINUE WHEN v_segment ~ '^v[0-9]+$';
        RETURN v_segment;
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Reduces free text to the slug format the CHECK above accepts; NULL when nothing survives.
CREATE OR REPLACE FUNCTION apiome.duw2568_slugify(p_text TEXT)
RETURNS TEXT AS $$
DECLARE
    v_slug TEXT;
BEGIN
    v_slug := lower(COALESCE(p_text, ''));
    v_slug := regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g');
    v_slug := btrim(v_slug, '-');
    RETURN NULLIF(v_slug, '');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ─── 5. Backfill: seed domains from path structure ───────────────────────────

-- `sort_order` is assigned alphabetically so the seeded tree matches the order the workspace would
-- have shown anyway; a slug of `shared` is skipped rather than rejected, leaving those paths in the
-- derived bucket they would render under regardless.
INSERT INTO apiome.domains (version_id, name, slug, sort_order)
SELECT
    seeded.version_id,
    seeded.slug,
    seeded.slug,
    (ROW_NUMBER() OVER (PARTITION BY seeded.version_id ORDER BY seeded.slug) - 1)::INTEGER
FROM (
    SELECT DISTINCT
        vp.version_id,
        apiome.duw2568_slugify(apiome.duw2568_domain_segment(vp.pathname)) AS slug
    FROM apiome.version_path vp
) AS seeded
WHERE seeded.slug IS NOT NULL
  AND seeded.slug <> 'shared'
ON CONFLICT DO NOTHING;

-- ─── 6. Backfill: place paths ────────────────────────────────────────────────

UPDATE apiome.version_path vp
SET domain_id = d.id
FROM apiome.domains d
WHERE d.version_id = vp.version_id
  AND d.deleted_at IS NULL
  AND d.slug = apiome.duw2568_slugify(apiome.duw2568_domain_segment(vp.pathname))
  AND vp.domain_id IS NULL;

-- ─── 7. Backfill: place classes by matching tag name ─────────────────────────

-- `apiome.tags` is project-scoped while domains are version-scoped, so the join back through
-- `versions` is what stops another project's identically named tag from filing this class. A class
-- with several matching tags is resolved by sort order — the same order the tree draws — so the
-- result does not depend on row order.
UPDATE apiome.classes c
SET domain_id = matched.domain_id
FROM (
    SELECT DISTINCT ON (ct.class_id)
        ct.class_id,
        d.id AS domain_id
    FROM apiome.class_tags ct
    JOIN apiome.tags t     ON t.id = ct.tag_id
    JOIN apiome.classes cl ON cl.id = ct.class_id
    JOIN apiome.versions v ON v.id = cl.version_id
    JOIN apiome.domains d  ON d.version_id = cl.version_id
                          AND d.deleted_at IS NULL
                          AND d.slug = apiome.duw2568_slugify(t.name)
    WHERE v.project_id = t.project_id
    ORDER BY ct.class_id, d.sort_order, d.slug
) AS matched
WHERE c.id = matched.class_id
  AND c.domain_id IS NULL
  AND c.deleted_at IS NULL;

-- ─── 8. Drop the backfill helpers ────────────────────────────────────────────

DROP FUNCTION IF EXISTS apiome.duw2568_domain_segment(TEXT);
DROP FUNCTION IF EXISTS apiome.duw2568_slugify(TEXT);
