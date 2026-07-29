-- Scope type-name uniqueness to the namespace, not the category.
--
-- Problem: V037 created the registry's uniqueness rule before namespaces existed:
--
--     CONSTRAINT primitives_name_category_unique UNIQUE (tenant_id, category, name)
--
-- Namespaces arrived later (#3451, V114) and became the registry's actual grouping — a type's
-- identity is its ``$id``, which ``schema_validation.derive_schema_id`` builds as
-- ``{REGISTRY_BASE_URL}{namespace}/{slug(name)}``. Category is not in that identity at all. The old
-- key is therefore wrong in both directions:
--
--   * Too strict. A tenant cannot hold ``uri`` in their own namespace because the seeded
--     system-core ``std/v0/types/uri`` already occupies (tenant, 'string', 'uri') — the two are
--     distinct types with distinct ``$id`` values, but the same name and category. Any import that
--     reuses a core type's name is rejected at INSERT, even though the import review classified it
--     New (the review looks the existing row up by ``schema_id``, so it is already namespace-aware
--     — only the constraint was not).
--   * Too loose. Two rows may share (tenant, namespace, name) as long as their categories differ,
--     and those two rows derive the *same* ``$id``. The old key permitted duplicate identities.
--
-- Solution: key on what identity actually is — (tenant_id, namespace, name).
--
--   NULLS NOT DISTINCT (PG15+) is required, not incidental: ``namespace`` is nullable and rows
--   predating the namespace registry carry NULL. Under the default NULLS DISTINCT, every
--   NULL-namespace row would become mutually unique and the table would silently accept duplicate
--   names among exactly the types that have no namespace to tell them apart. Treating NULL as a
--   single "unassigned" group preserves the guarantee V037 gave those rows.
--
-- Category keeps its column and its index; it is descriptive metadata, not part of identity.
--
-- Safe to apply: verified against existing data that no (tenant_id, namespace, name) group holds
-- more than one row, so the tightened half of the change has nothing to reject.

ALTER TABLE apiome.primitives
  DROP CONSTRAINT IF EXISTS primitives_name_category_unique;

ALTER TABLE apiome.primitives
  ADD CONSTRAINT primitives_tenant_namespace_name_unique
  UNIQUE NULLS NOT DISTINCT (tenant_id, namespace, name);

COMMENT ON CONSTRAINT primitives_tenant_namespace_name_unique ON apiome.primitives IS
  'A type name is unique within its namespace, mirroring the derived $id ({base_uri}{slug(name)}). NULL namespaces are one "unassigned" group, so untethered rows keep the V037 name guarantee.';

DO $$
BEGIN
    RAISE NOTICE 'apiome.primitives uniqueness rescoped from (tenant, category, name) to (tenant, namespace, name).';
END $$;
