# Intake resource guards (IXH-6.5)

Every untrusted document that enters import, pre-flight, preview, or schema
validation is bounded by a **GuardProfile**. Exceeding a dimension fails with a
resource-category taxonomy code that names the limit and its configured value.

## Dimensions

| Limit | Default | Taxonomy code |
|-------|---------|---------------|
| `max_raw_bytes` / `max_decoded_bytes` | 10 MiB (from `oas_resource_limits.json`) | `INPUT_TOO_LARGE` |
| `max_alias_cost` | 100 | `INPUT_EXPANSION_LIMIT` |
| `max_nesting_depth` | 256 | `INPUT_DEPTH_LIMIT` |
| `max_expansion_ratio` | 10:1 | `INPUT_EXPANSION_LIMIT` |
| `max_entity_count` | 50_000 | `INPUT_ENTITY_LIMIT` |
| `max_ref_depth` / `max_ref_fanout` | 32 / 64 | `INPUT_REF_LIMIT` |
| `stage_wall_clock_seconds` | 20 s | `INPUT_TIME_LIMIT` |
| `job_memory_ceiling_bytes` | 192 MiB | `INPUT_MEMORY_LIMIT` |
| Archive entries / total / per-file / path depth | 500 / 32 MiB / 8 MiB / 32 | `INPUT_TOO_LARGE` |
| `archive_max_compression_ratio` | 100:1 | `INPUT_EXPANSION_LIMIT` |

Defaults are **provisional** until IXH-1.5 scale measurements refine them.

## Configuration

- Artifact: `src/app/data/intake_guard_profile.json` (IXH-6.5 dimensions).
- OAS size/alias/depth remain the DCW mirror `oas_resource_limits.json`.
- Env: `APIOME_GUARD_PROFILE=default|elevated`, optional `APIOME_LICENSE_PLAN_HINT`.
- Archive env: `APIOME_ARCHIVE_MAX_*`, `APIOME_ARCHIVE_MAX_COMPRESSION_RATIO`.
- `elevated` multiplies byte, entity, wall-clock, and memory ceilings by 2.

## Streaming multipart

`POST …/imports/upload` streams the file into a tempfile under `max_raw_bytes`,
stores `document_path` on the job (no base64 doubling), and deletes the tempfile
when the job reaches a terminal state.

## Modules

- `app.intake_resource_guard` — profile resolution and dimension checks
- `app.intake_streaming` — bounded tempfile upload
- `app.archive_intake` — archive sandbox including compression ratio
- `app.secure_xml` — DTD/entity/external forbidden (IXH-1.4)
