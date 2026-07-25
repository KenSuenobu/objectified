# How do I… import a specification?

Importing turns an existing OpenAPI, Swagger 2.0, Arazzo, or JSON Schema document into Apiome
classes, properties, paths, and operations you can edit. Import is **asynchronous**: you create a
job, it runs in the background, and you poll it to completion.

Supported inputs: **OpenAPI 3.x**, **Swagger 2.0**, **Arazzo 1.0**, **JSON Schema 2020-12**.

---

## In the UI

1. Open the **Designer** at `/ade/studio`.
2. Choose **Import** and select a file (or paste a document / URL).
3. Watch the job progress; when it reaches **completed**, the imported classes and paths appear on
   the canvas.

## With the CLI

The CLI auto-detects the format, uploads it, and waits for the job by default:

```bash
apiome import openapi ./petstore.openapi.yaml      # explicit format
apiome import swagger ./legacy-swagger.json
apiome import auto    ./some-spec.yaml             # auto-detect

# useful flags
apiome import openapi ./petstore.openapi.yaml \
  --project-name "Pet Store" \
  --dry-run                                             # validate without writing
```

`--dry-run` validates and reports without persisting; `--no-wait` returns immediately with the job
id; `--poll-interval` tunes how often the job is polled. See [cli-quickstart.md](cli-quickstart.md).

## With the REST API

```http
POST /v1/tenants/{tenant_slug}/imports
Content-Type: application/json
X-API-Key: <your-api-key>

{ "document_base64": "<base64 bytes>", "filename": "petstore.openapi.yaml" }
```

Returns **202 Accepted** with a job id. Poll the job until it reports `completed`, then commit it.
A multipart variant exists for direct file uploads:

```http
POST /v1/tenants/{tenant_slug}/imports/upload
Content-Type: multipart/form-data
```

## Check quality before importing

Pre-flight scores a document **without writing anything**, so you can decide whether it is worth
importing (and fix it first if it is not):

```http
POST /v1/tenants/{tenant_slug}/import/preflight
Content-Type: application/json
X-API-Key: <your-api-key>

{ "document_base64": "<base64 bytes>", "filename": "petstore.openapi.yaml" }
```

Returns **200** with the detected format and confidence, where the import would land
(project / catalog / types), the entity counts, the lint **score and grade**, and the findings
ranked worst-first — each with its rule id, severity, location, and how to fix it. Omit
`source_kind` to auto-detect, or set it to force a specific importer.

A document that cannot be imported is still a 200: `ok` is `false` and `error.code` carries a
stable code (for example `INPUT_MALFORMED`, `FORMAT_UNRECOGNIZED`, `INPUT_TOO_LARGE`) plus
remediation text — key your automation off the code, not the message. Pre-flighting the same bytes
twice is served from cache and says so in `cache.hit`.

### In the catalog import wizard

The wizard runs this for you. Its steps are **Source → Detect & route → Options → Quality →
Import**: the **Quality** step shows the grade orb and score, the error/warning/info tally, the
ranked findings (each links to its line in the source pane beside the list), and the style guide
that scored them. Nothing is written to the catalog until you confirm there — **Cancel** and
**Back** leave no trace.

When a quality policy blocks the document, **Import** is disabled with the reason stated; if the
policy permits an override, **Import anyway** commits it and records a waiver against that report's
fingerprint. If pre-flight itself cannot run, the step says so and offers **Retry pre-flight** or an
explicit import without a score.

Tick **Skip this step for clean imports** to stop pausing here for documents that pass. The
pre-flight still runs, and the step still stops whenever the verdict blocks or cannot be produced.

## Verify

- **UI:** the imported classes are listed in the Designer.
- **CLI:** `apiome schemas list` shows the new classes; `apiome projects list` shows the
  project the import created.

## Related

- [edit-classes-and-properties.md](edit-classes-and-properties.md) — refine what you imported
- [edit-paths.md](edit-paths.md) — refine the imported paths/operations
