-- Move every stored registry URL from apiome.app to apiome.dev.
--
-- The registry's identity constants moved to ``https://api.apiome.dev/types/``
-- (``schema_validation.REGISTRY_BASE_URL``, ``type_namespaces_routes.REGISTRY_BASE_URL``,
-- ``primitivesResolverModel.REGISTRY_BASE_URL``). Stored data must move in the same commit, because
-- identity here is a *string comparison*: ``type_resolver`` resolves an edge by matching its
-- ``resolved_target`` against ``apiome.primitives.schema_id``. Leave the rows on the old host and
-- every newly derived ``$id`` lands on apiome.dev while every stored target still says apiome.app —
-- the exact mismatch that made date/money/email/uuid report "unresolved" before V218.
--
-- Columns rewritten (found by scanning every text/jsonb column in the database for the old host;
-- the ``authoring`` and ``public`` schemas hold none):
--
--   apiome.primitives.schema_id   — the type's ``$id``
--   apiome.primitives.base_uri    — the namespace root relative ``$ref`` values resolve against
--   apiome.primitives.schema      — the ``$id`` stamped inside the document itself
--   apiome.primitives.refs        — each edge's ``resolved_target``
--   apiome.type_namespaces.base_uri
--   apiome.classes.schema, apiome.class_schema.schema
--   apiome.properties.data, apiome.class_properties.data — project data citing type ``$id`` values
--
-- Deliberately NOT rewritten: ``apiome.users.email``. The one match (``admin@apiome.app``) is a login
-- credential, not a registry URL — changing it silently changes who can sign in. That is an account
-- change for an operator to make knowingly, not a side effect of a rebrand migration.
--
-- Earlier migrations that wrote the old host (V001, V113, V114, V115, V197, V218) are left exactly as
-- they are: they are already applied, and the runner validates checksums — editing one makes every
-- existing database refuse to migrate. Forward-only is also self-healing for a fresh database, which
-- replays those seeds on the old host and is corrected here.
--
-- JSONB is rewritten through its text form. Safe because the host only ever appears inside string
-- values (in a URL), never in a key or structural position, so the document round-trips unchanged
-- apart from the substitution. Idempotent: re-running finds no remaining occurrences.

SET search_path TO apiome, public;

DO $$
DECLARE
    old_host CONSTANT text := 'apiome.app';
    new_host CONSTANT text := 'apiome.dev';
    n integer;
    total integer := 0;
BEGIN
    UPDATE apiome.primitives
    SET schema_id = REPLACE(schema_id, old_host, new_host)
    WHERE schema_id LIKE '%' || old_host || '%';
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE '  primitives.schema_id: %', n;

    UPDATE apiome.primitives
    SET base_uri = REPLACE(base_uri, old_host, new_host)
    WHERE base_uri LIKE '%' || old_host || '%';
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE '  primitives.base_uri: %', n;

    UPDATE apiome.primitives
    SET schema = REPLACE(schema::text, old_host, new_host)::jsonb
    WHERE schema::text LIKE '%' || old_host || '%';
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE '  primitives.schema: %', n;

    UPDATE apiome.primitives
    SET refs = REPLACE(refs::text, old_host, new_host)::jsonb
    WHERE refs::text LIKE '%' || old_host || '%';
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE '  primitives.refs: %', n;

    UPDATE apiome.type_namespaces
    SET base_uri = REPLACE(base_uri, old_host, new_host)
    WHERE base_uri LIKE '%' || old_host || '%';
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE '  type_namespaces.base_uri: %', n;

    UPDATE apiome.classes
    SET schema = REPLACE(schema::text, old_host, new_host)::jsonb
    WHERE schema::text LIKE '%' || old_host || '%';
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE '  classes.schema: %', n;

    UPDATE apiome.class_schema
    SET schema = REPLACE(schema::text, old_host, new_host)::jsonb
    WHERE schema::text LIKE '%' || old_host || '%';
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE '  class_schema.schema: %', n;

    UPDATE apiome.properties
    SET data = REPLACE(data::text, old_host, new_host)::jsonb
    WHERE data::text LIKE '%' || old_host || '%';
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE '  properties.data: %', n;

    UPDATE apiome.class_properties
    SET data = REPLACE(data::text, old_host, new_host)::jsonb
    WHERE data::text LIKE '%' || old_host || '%';
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE '  class_properties.data: %', n;

    RAISE NOTICE 'Rebranded % row(s) from % to %. apiome.users.email left untouched by design.',
        total, old_host, new_host;
END $$;
