-- Store `refs[].resolved_target` as the absolute registry $id the resolver looks up.
--
-- Problem: the nine seeded `std/v0/types` types (date, date-time, time, email, uri, uuid,
-- currency-code, decimal, money) showed every relative $ref as **unresolved** in Reference
-- resolution, even though each target exists.
--
-- Two contracts disagreed, written a release apart:
--
--   * V113 seeded each edge with the *namespace-path* form and said so in its own header —
--     "resolved_target is the namespace-path form (e.g. std/v0/primitives/string) the resolver
--     surfaces" — while the comment three lines above it shows the absolute form as the resolved
--     value. It also stamped status 'resolved', so the data looked correct at rest.
--   * The resolver that arrived later (#3459, ``app.type_resolver._reresolve_edges``) does not
--     recompute the target: it takes the stored ``resolved_target`` and hands it to a lookup keyed
--     on ``apiome.primitives.schema_id``, which ``schema_validation.derive_schema_id`` builds
--     absolute (``https://api.apiome.app/types/{namespace}/{slug(name)}``).
--
-- So the lookup compared `std/v0/primitives/string` against
-- `https://api.apiome.app/types/std/v0/primitives/string`, missed every time, and re-derived the
-- edge as unresolved — then persisted that verdict over the seeded 'resolved'.
--
-- Absolute is the correct storage form, not merely the more convenient one: it is what
-- ``derive_schema_id`` produces, what the resolver's ``target_lookup`` documents ("maps an absolute
-- registry ``$id``"), and what the UI assumes — ``primitivesResolverModel.shortenTarget`` strips the
-- registry base for *display*, which only makes sense if storage keeps it.
--
-- Solution: rewrite any registry-relative ``resolved_target`` to its absolute form. Edges already
-- absolute (`http…`) and edges with no target (a genuinely unresolvable ``$ref``) are left alone, so
-- this is idempotent and safe to re-run.
--
-- The registry root is derived per row from the type's own ``base_uri`` — up to and including the
-- first ``/types/`` segment, the same rule ``deriveResolutionBase`` uses in the UI — so a
-- self-hosted registry on another host normalizes to *its* root rather than to apiome.app. The
-- constant is only the fallback for a row with no usable ``base_uri``.
--
-- Edge order is preserved (``jsonb_agg … ORDER BY ord``). That is load-bearing, not tidiness: the
-- resolver view keys each table row as ``{primitive.id}:{index}``, so reordering a type's edges
-- would silently reshuffle its rows.
--
-- The statuses themselves are deliberately left untouched. ``POST /v1/types/{tenant}/resolve``
-- recomputes and persists them on the next run (the "Re-resolve" button), which is the one component
-- that owns that column — this migration fixes the input it reads, not its output.

SET search_path TO apiome, public;

DO $$
DECLARE
    fixed_count integer;
BEGIN
    WITH normalized AS (
        SELECT p.id,
               jsonb_agg(
                   CASE
                       -- No target: a $ref that genuinely resolves to nothing. Leave it.
                       WHEN COALESCE(t.edge->>'resolved_target', '') = '' THEN t.edge
                       -- Already absolute: idempotent re-runs, and rows written by the API.
                       WHEN t.edge->>'resolved_target' LIKE 'http%' THEN t.edge
                       ELSE jsonb_set(
                           t.edge,
                           '{resolved_target}',
                           to_jsonb(
                               CASE
                                   WHEN POSITION('/types/' IN COALESCE(p.base_uri, '')) > 0
                                       THEN SUBSTRING(
                                           p.base_uri FROM 1 FOR POSITION('/types/' IN p.base_uri) + 6
                                       )
                                   ELSE 'https://api.apiome.app/types/'
                               END || LTRIM(t.edge->>'resolved_target', '/')
                           )
                       )
                   END
                   ORDER BY t.ord
               ) AS refs
        FROM apiome.primitives p
        CROSS JOIN LATERAL jsonb_array_elements(p.refs) WITH ORDINALITY AS t(edge, ord)
        WHERE jsonb_typeof(p.refs) = 'array'
          AND jsonb_array_length(p.refs) > 0
        GROUP BY p.id
    )
    UPDATE apiome.primitives p
    SET refs = n.refs
    FROM normalized n
    WHERE p.id = n.id
      AND p.refs IS DISTINCT FROM n.refs;

    GET DIAGNOSTICS fixed_count = ROW_COUNT;
    RAISE NOTICE 'Rewrote registry-relative resolved_target values on % primitive(s).', fixed_count;
END $$;
