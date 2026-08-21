# How do I… import a specification?

Importing turns an existing API description into something Apiome can search, diff, lint and
convert. Import is **asynchronous**: you create a job, it runs in the background, and you poll it
to completion.

**Apiome imports 43<!--format-count:importable--> formats**, spanning all
6<!--format-count:paradigms--> canonical paradigms, and exports 41<!--format-count:exportable-->
of them again. The full list — with each format's registry key, input kinds, version coverage,
file extensions and export support — is generated from the running registries at
[supported-formats.md](supported-formats.md). Do not maintain a copy of it anywhere else.

The same answer is machine-readable at `GET /v1/formats/matrix` and printed by `apiome formats`:

```bash
apiome formats                              # every format, as a table
apiome formats --direction import           # only what Apiome can read
apiome formats --paradigm event --json      # one paradigm, machine-readable
```

The page above is rendered from that response, so the guide, the API and the CLI cannot disagree.

## Two importers, one registry

Which importer handles a document is decided by the server, from the format it normalizes to:

- **The Projects importer** takes **OpenAPI 3.x** and **Swagger 2.0**. These normalize onto the
  editable class/property/path model, so an import becomes a **publishable Project** you can
  version, lint and publish. This is the path the rest of this page describes.
- **The Catalog importer** takes **everything else** — Protobuf/gRPC, GraphQL, AsyncAPI, Arazzo,
  JSON Schema, Thrift, Smithy, TypeSpec, WSDL, XSD, OData, EDI X12, HL7 v2, FHIR, COBOL copybooks,
  FIX, ISO 20022/8583 and the rest. A catalog import keeps the format's **own** structure rather
  than forcing it into the OpenAPI shape, so what you get back is what you put in. Catalog items
  are searchable, diffable and convertible; they are not publishable until converted.

Both importers read the same import-source registry, so a format is offered as soon as its adapter
is registered — the file pickers derive their `accept` lists from it rather than hard-coding one.
An unrecognized file extension is **not** rejected: the bytes are sent to content detection, and
the detector's verdict is what you are shown.

> Converting a catalog item into a publishable Project is a separate step — see
> [convert-to-openapi.md](convert-to-openapi.md) and [export-fidelity.md](export-fidelity.md) for
> what survives the conversion.

## Formats that need a bundled tool

A few adapters do not parse the document themselves — they shell out to the authoritative parser
for that format, which the container image bundles. The **Runtime** column of
[supported-formats.md](supported-formats.md) says which, and a format whose tool is missing is
reported there (and on the source card) as *Needs toolchain* rather than being offered and then
failing mid-import.

**AsyncAPI is the exception: it is a hard dependency, not a degradable one.** The AsyncAPI
adapter runs `@asyncapi/parser` (the JavaScript reference parser) to validate and dereference the
document, and there is deliberately **no fallback parser** behind it.

### The fallback policy, stated

We considered shipping a minimal pure-Python structural parser for AsyncAPI 2.x/3.x that would
keep the format `available` with reduced capability, and rejected it. A reduced parse would
produce a canonical model that *looks* like a successful import while quietly differing from the
real one — different validation verdicts, unresolved `$ref`s, a different fingerprint, and
therefore a different diff and lint score for the same document depending on which runtime
imported it. A format that is honestly unavailable is recoverable; a format that is silently
half-parsed is not. So:

- **The image ships the parser.** Its exact version is pinned in the REST service's toolchain
  manifest (`apiome-rest/toolchain/package.json`) and installed during the container build, which
  smoke-tests it before the image is finished.
- **Startup verifies it and says so.** The service invokes the parser at boot and logs the
  version it resolved, so a deployment's logs always name the `@asyncapi/parser` it is running.
- **A missing parser fails loudly, never silently.** With `APIOME_REQUIRE_TOOLCHAIN=1` — the
  default in the shipped image and in any production deployment — the service **refuses to
  start** and names the tool, the formats it gates, and the override to point at a sidecar
  binary. Set `APIOME_REQUIRE_TOOLCHAIN=0` to accept a deployment without AsyncAPI import: the
  service then starts, logs the loss as an `ERROR`, and reports the format as unavailable
  everywhere it is listed. It never comes up quietly missing a format.
- **The health surface reports it.** `GET /health` carries a `toolchain` block
  (`status`, `enforced`, `required`, `available`, `missing`). It states availability and nothing
  more — the endpoint is unauthenticated, so resolved paths and exact parser versions stay
  behind `GET /v1/ops/toolchain` (platform-admin), which also names which formats each tool
  gates. The version the runtime resolved is in the startup log either way.

Every other bundled tool (`buf` for Protobuf/gRPC and Connect, the linters, the diff CLIs)
remains optional: its absence degrades exactly one format to a stated *Needs toolchain*, and the
service starts normally.

Running the service outside the container? `apiome-rest/scripts/install_dev_toolchain.sh`
installs the pinned parser (and `buf`) into `apiome-rest/.tools`; `./run.sh` and `yarn dev` call
it for you.

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

### Set the tenant quality policy

By default nothing is blocked: a fresh tenant scores every import and reports the result without
refusing anything. To make the gate real, open **Governance → Style Guides** and edit **Import &
export quality policy**:

- **Minimum grade / minimum score / refuse findings at** — the three floors. Leave one blank to
  not use it; a scope with no floor can never block.
- **Refuse the import when a floor is missed** — off means *advisory* (the shortfall is reported,
  the import proceeds); on means the commit is refused.
- **Overrides** — whether a blocked user may proceed by recording a waiver, which role slugs may
  (tenant administrators resolve to `owner`), and how long a waiver is honoured.
- **Per-format overrides** — a format may tighten a floor without restating the rest; resolution is
  *format override → tenant → default*, and the pre-flight verdict names the tier that won
  (`policy.source`).

Saving appends an immutable version, listed underneath with its fingerprint and author, and writes
an audit entry. Every verdict names the `policyVersionId` it applied.

The policy is enforced **on the server**, at `POST /v1/tenants/{tenant_slug}/imports` — not only in
the wizard. An import that policy refuses comes back as **409** with
`detail.code = QUALITY_POLICY_BLOCKED`, the reason, the remediation, and the full verdict, and no
job is created. A dry run is never gated (it writes nothing).

### Waivers

"Import anyway" records a waiver in the tenant's ledger with the actor, the reason, the scope, and
an expiry taken from the policy's waiver lifetime. It is matched on the candidate's content hash
and the format it was granted for, so the same bytes commit through the gate until it expires — at
which point the shared waiver-expiry sweep has already warned the tenant (`lint.waiver.expiring`,
`kind: quality:import`). Active waivers are listed under the policy in Governance:

```bash
curl -X POST "$APIOME_API/v1/tenants/$TENANT/governance/quality-waivers" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"scope":"import","subjectKey":"<cache.content_hash from the pre-flight report>",
       "formatKey":"openapi","reason":"vendor spec we do not control"}'
```

The grant is refused with **403** unless the policy permits overrides *and* names your role — the
check is server-side, so a client cannot grant itself one.

## Verify

- **UI:** the imported classes are listed in the Designer.
- **CLI:** `apiome schemas list` shows the new classes; `apiome projects list` shows the
  project the import created.

## Related

- [supported-formats.md](supported-formats.md) — every format Apiome imports and exports,
  generated from the registries (its **Runtime** column is where a missing bundled tool shows up)
- [catalog-format-details.md](catalog-format-details.md) — what a catalog item records per format
- [convert-to-openapi.md](convert-to-openapi.md) — promote a catalog item to a publishable Project
- [edit-classes-and-properties.md](edit-classes-and-properties.md) — refine what you imported
- [edit-paths.md](edit-paths.md) — refine the imported paths/operations
