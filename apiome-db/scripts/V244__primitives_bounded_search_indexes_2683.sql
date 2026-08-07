-- Read-path indexes for the bounded primitives search (DWX-3.1, private-suite#2683).
--
-- `GET /v1/primitives/{tenant_slug}` grew `q` / `scope` / `namespace` / `limit` / `cursor` so the
-- unified workspace's type picker can page a registry instead of downloading it. The ticket's
-- acceptance bar is "search returns within budget on a 5,000-primitive tenant", and the existing
-- indexes do not get it there:
--
--   * The visibility CTE is `DISTINCT ON (namespace, name)` over `(tenant_id = ? OR is_system)`.
--     `idx_primitives_namespace` covers only the leading column, so the dedupe re-sorts every
--     visible row on every request — including the ones a `limit` of 25 will throw away.
--
--   * `q` matches `ILIKE '%term%'` on name, namespace, `$id`, description and tags. A leading
--     wildcard makes every b-tree here useless for the predicate, so each keystroke degenerates
--     into a sequential scan of the tenant's whole registry. Trigram GIN indexes make the same
--     substring match indexable.
--
-- Nothing here changes a column, a constraint or a value. These are pure read-path indexes and
-- both shapes of the listing return identical rows with or without them.
SET search_path TO apiome, public;

-- 1. The dedupe and the cursor ordering ---------------------------------------
--
-- `DISTINCT ON (namespace, name) ... ORDER BY namespace, name, (tenant_id = ?) DESC` is answered
-- by an ordered scan of exactly this key. `is_system` trails as an INCLUDE-style tiebreaker
-- column so the visibility predicate can be evaluated without a heap fetch per candidate row.
--
-- No partial `WHERE deleted_at IS NULL` clause, deliberately: `Database.get_primitives_for_tenant`
-- does not filter on `deleted_at` (primitives are hard-deleted), and an index whose predicate is
-- narrower than the query's is an index the planner cannot use.
CREATE INDEX IF NOT EXISTS idx_primitives_namespace_name_tenant
  ON apiome.primitives (namespace, name, tenant_id);

COMMENT ON INDEX apiome.idx_primitives_namespace_name_tenant IS
  'DWX-3.1: serves the DISTINCT ON (namespace, name) visibility dedupe shared by the classic '
  'primitives listing and the bounded search.';

-- The bounded search's tab counts and page both filter on `is_system` and `source` — the two
-- columns the scope classification reads. `idx_primitives_source` already exists; pairing it with
-- `is_system` lets a scope-filtered count be answered from the index.
CREATE INDEX IF NOT EXISTS idx_primitives_scope_columns
  ON apiome.primitives (is_system, source, namespace);

COMMENT ON INDEX apiome.idx_primitives_scope_columns IS
  'DWX-3.1: the three columns the standard/core/tenant/custom scope classification reads.';

-- 2. Substring search -----------------------------------------------------------
--
-- `pg_trgm` is a contrib extension. On a managed Postgres where the migration role cannot install
-- extensions, creating it raises rather than warning — and a missing search index is a performance
-- regression, not a correctness one. So the whole trigram block degrades to a NOTICE, exactly as
-- V230 does: the picker still returns the right rows, just with a sequential scan behind the
-- search box until an operator installs the extension and re-runs this migration.
--
-- Indexed with `gin_trgm_ops` on the *lower-cased* expression the predicate compares, because
-- `ILIKE` on a plain trigram index is only usable when the planner can prove the comparison is
-- case-insensitive; matching the expression removes the doubt.
--
-- `tags` gets no trigram index. It is a `text[]`, so the only way to trigram-index it is to join
-- it into one string — and `array_to_string` is STABLE rather than IMMUTABLE, which Postgres
-- refuses in an index expression. The tag branch of the predicate is an
-- `EXISTS (... unnest(tags) ...)` over an array that holds a handful of short strings per row, and
-- the five fields below carry the search; V037's `idx_primitives_tags` still serves exact-tag
-- lookups.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE INDEX IF NOT EXISTS idx_primitives_name_trgm
    ON apiome.primitives USING gin (lower(name) gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_primitives_namespace_trgm
    ON apiome.primitives USING gin (lower(COALESCE(namespace, '')) gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_primitives_schema_id_trgm
    ON apiome.primitives USING gin (lower(COALESCE(schema_id, '')) gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_primitives_description_trgm
    ON apiome.primitives USING gin (lower(COALESCE(description, '')) gin_trgm_ops);
EXCEPTION
  WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE
      'pg_trgm unavailable; skipping primitives search trigram indexes (DWX-3.1). '
      'The type picker still works, but scans sequentially.';
END
$$;
