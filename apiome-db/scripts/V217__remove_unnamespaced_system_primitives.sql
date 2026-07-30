-- Remove the seeded system types that carry no namespace.
--
-- Problem: V039 preloaded 36 ISO standard primitives (Email Address, UUID, Boolean, Monetary
-- Amount, …) for every tenant before the namespace registry existed (#3451, V114), so it never set
-- one. Every row it inserted has ``namespace IS NULL``.
--
-- A type's identity is its ``$id``, which ``schema_validation.derive_schema_id`` builds as
-- ``{REGISTRY_BASE_URL}{namespace}/{slug(name)}``. A row with no namespace therefore has no
-- derivable ``$id``, belongs to no collection, and cannot be referenced by a relative ``$ref``. On
-- the Primitives dashboard these are exactly the rows the Type collections panel has to account for
-- under a synthetic "Unassigned namespaces" bucket, because they sit on no path.
--
-- The registry's namespaced system-core set (``std/*``, seeded separately) is what the product
-- actually resolves against, so these 36 are duplicated, unreachable copies rather than the
-- authoritative core types.
--
-- Solution: delete them. Forward-only, so a fresh database nets to zero — V039 inserts, this
-- deletes — and every environment converges on the same state whether it is new or already seeded.
-- V039 is left untouched: an already-applied migration must never be edited (the runner validates
-- checksums and refuses).
--
-- Scope is deliberately narrow, and both halves matter:
--
--   * ``is_system = true`` — a *tenant's* own unassigned types are the user's data, not seed data.
--     They keep showing in the unassigned bucket, where the dashboard offers registering a
--     namespace for them.
--   * ``namespace IS NULL OR btrim(namespace) = ''`` — the blank string is included because
--     ``isUnassignedNamespace`` treats blank and NULL alike, so the UI already counts a
--     whitespace-only namespace as unassigned.
--
-- Safe to apply: verified against existing data that no ``apiome.class_properties`` row binds any
-- matching primitive (``class_properties.primitive_id`` is ON DELETE NO ACTION, so a bound row
-- would abort this migration rather than cascade), and that every matching row has
-- ``usage_count = 0``. Should a later environment have bindings, this migration fails loudly and
-- that data must be re-pointed at the ``std/*`` equivalent first — which is the correct outcome,
-- not something to paper over with a cascade.

SET search_path TO apiome, public;

DO $$
DECLARE
    bound_count integer;
    removed_count integer;
BEGIN
    -- Fail with an actionable message rather than a bare FK violation.
    SELECT count(*) INTO bound_count
    FROM apiome.class_properties cp
    JOIN apiome.primitives p ON p.id = cp.primitive_id
    WHERE p.is_system = true
      AND (p.namespace IS NULL OR btrim(p.namespace) = '');

    IF bound_count > 0 THEN
        RAISE EXCEPTION
            'Cannot remove unnamespaced system primitives: % class_properties row(s) still bind them. '
            'Re-point those properties at the namespaced std/* equivalents first.', bound_count;
    END IF;

    DELETE FROM apiome.primitives
    WHERE is_system = true
      AND (namespace IS NULL OR btrim(namespace) = '');

    GET DIAGNOSTICS removed_count = ROW_COUNT;
    RAISE NOTICE 'Removed % unnamespaced system primitive(s) seeded by V039.', removed_count;
END $$;
