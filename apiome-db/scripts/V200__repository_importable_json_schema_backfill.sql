-- Recount `apiome.tenant_repositories.importable_count` so JSON Schema files count.
--
-- V091 added the stored `total_files` / `importable_count` pair, written once per file scan.
-- The scanner's importable predicate listed OpenAPI, Arazzo, AsyncAPI, GraphQL, Protobuf,
-- Postman, Prisma, SQL DDL, Avro and DBML — but not JSON Schema, even though `json-schema` is
-- a first-class import source (`import_pipeline._DETECTORS`) with its own sniffer, parser and
-- Catalog-vs-Types routing prompt. A repository of schemas therefore indexed thousands of
-- files and reported zero importable, which also emptied the file browser: its "hide
-- non-importable" filter defaults on, so every glob AND-ed against an always-false predicate.
--
-- The scanner labels every `.json` blob `json-candidate`, so the kind alone cannot separate a
-- schema from a `package.json`. Importability is therefore decided on the filename shape —
-- `*.schema.json`, or a `.json` under a `schemas/` directory — matching the two shapes the
-- `json_schema` browser preset already advertises.
--
-- Because that shape is derived from the stored `path`, the already-indexed rows are enough:
-- this recount reads `tenant_repository_files` and never re-walks a Git tree, so no repository
-- needs a re-scan to pick the fix up. It touches only repositories that have indexed files on
-- their default branch, and only where the number actually changes.
--
-- Keep in lockstep with `repository_file_scan._importable_hint` /
-- `Database.tenant_repository_files_stats_and_page`'s `importable_sql`.

UPDATE apiome.tenant_repositories r
SET importable_count = c.importable_count,
    updated_at = NOW()
FROM (
    SELECT f.repository_id,
           f.branch,
           COUNT(*) FILTER (
               WHERE f.detected_kind IS NOT NULL AND (
                   f.detected_kind ILIKE 'openapi%' OR f.detected_kind ILIKE 'arazzo%' OR
                   f.detected_kind ILIKE 'asyncapi%' OR f.detected_kind ILIKE 'graphql%' OR
                   f.detected_kind ILIKE 'protobuf%' OR f.detected_kind ILIKE 'postman%' OR
                   f.detected_kind ILIKE 'prisma%' OR f.detected_kind ILIKE 'sql-ddl%' OR
                   f.detected_kind ILIKE 'avro%' OR f.detected_kind ILIKE 'dbml%' OR
                   (f.detected_kind ILIKE 'json%' AND (
                       f.path ILIKE '%.schema.json' OR
                       f.path ILIKE '%/schemas/%.json' OR f.path ILIKE 'schemas/%.json'
                   ))
               )
           )::INTEGER AS importable_count
    FROM apiome.tenant_repository_files f
    GROUP BY f.repository_id, f.branch
) c
WHERE c.repository_id = r.id
  AND c.branch = COALESCE(NULLIF(r.default_branch, ''), 'main')
  AND r.deleted_at IS NULL
  AND r.importable_count IS DISTINCT FROM c.importable_count;
