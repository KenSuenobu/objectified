# Verification Evidence Schema (ECA-1.3)

> apiome#4731 — the third part of Executable Contract Assurance Epic 1 (parent #4458).
> Consumes ECA-1.1 (#4729) suite digests and ECA-1.2 (#4730) target identities; blocks
> ECA-2.1 (HTTP contract runner) and ECA-3.1 (evidence-backed policy evaluator).

## Why

A contract run ends, today, as runner output: a log, a console scrollback, maybe a JUnit file in a
CI artifact bucket. That cannot be queried, compared across runs, or pointed at by a gate, and it
disappears when the CI job's retention window closes. Four questions have no durable answer:

* did this version pass its contract, against **which** target, and **when**?
* what exactly failed — which operation, which assertion, expected versus actual?
* where are the request/response artifacts, and were they safe to keep?
* can anyone quietly turn a red run green afterwards?

Evidence answers all four with four immutable, tenant-scoped tables and two exports.

## Modules

| Module | Role |
|---|---|
| `app/verification_evidence.py` | The pure contract: vocabularies, submission and record models, redaction, derivation, validation, error taxonomy. No I/O. |
| `app/verification_evidence_store.py` | The only door to the tables: validates, snapshots the target, writes the whole run in one transaction, and handles idempotent replay. |
| `app/verification_evidence_export.py` | JSON and JUnit renderings of a stored record. |
| `app/verification_evidence_routes.py` | `/v1/tenants/{tenant}/verification-runs[...]`, gated on the `verification_evidence` RBAC resource. |
| `app/mock_attestation.py` | The pure release-proof **mock attestation** contract (PMR-3.2): bundle digest, runtime, conformance corpus and result, fixture-pack digests, plus the in-toto statement builder. Imports nothing from this module, so the dependency runs one way only. |
| `apiome-db` V212 | `verification_run`, `verification_run_operation`, `verification_run_assertion`, `verification_run_artifact`, the retention sweep, and the RBAC grid update. |
| `apiome-db` V249 | `verification_run_mock` — the mock attestation, one row per run, immutable and tenant-scoped like the other four. |

## The four tables

| Table | Holds |
|---|---|
| `verification_run` | One execution: the ECA-1.1 suite digest, the ECA-1.2 target identity, timing, verdict, counts, runner, actor, provenance, CI context. |
| `verification_run_operation` | One executed case: which operation, which outcome, and — when it did not pass — the failure code and redacted message that say why. |
| `verification_run_assertion` | The individual checks inside a case (status code, response schema, header, content type, latency, custom), each with expected vs actual. |
| `verification_run_artifact` | **References** to redacted artifacts: a URI, a size, a content hash. Never the bytes. |

A fifth table, `verification_run_mock` (V249), holds the release-proof mock attestation — see
[Mock attestation](#mock-attestation-pmr-32) below.

## Evidence is immutable

Every one of the four tables carries a `BEFORE UPDATE` trigger (the shared V128
`mcp_forbid_row_mutation()` guard) that rejects any in-place edit. That is only livable because a
run is recorded **whole, in one transaction**: there is no open-append-close path, so partial
evidence is never stored and never needs fixing up.

The REST surface says the same thing by omission — there is no `PATCH`, `PUT`, or `DELETE` on a
run. The only removal is `apiome.purge_verification_evidence(days)`, which hard-deletes runs older
than the window and lets the cascades take their cases, assertions, and artifact references.

```sql
SELECT apiome.purge_verification_evidence(365);
```

## Evidence is tenant-scoped

`tenant_id` is on all four tables, not only on the run, so every read is scoped by the same
predicate. A CHECK cannot express "child tenant = parent tenant" without a subquery, so the
composite foreign keys do it instead — a child references its parent on `(id, tenant_id)`, which
makes a cross-tenant child structurally impossible rather than merely unlikely.

## A verdict is derived, never asserted

Case counts and the run outcome are computed from the submitted case records
(`derive_counts` / `derive_outcome`). A submitted `outcome` is *checked* against the derived one
and refused when it disagrees, so no upload can record a green run over red cases.

| Derived outcome | When |
|---|---|
| `errored` | any case could not be executed (transport, timeout) |
| `failed` | no errors, but at least one case contradicted the contract |
| `passed` | neither of the above (a run of only skipped cases passes, and its counts say plainly that nothing was exercised) |

`errored` outranks `failed` on purpose: a gate must be able to tell "the implementation is
incompatible" from "we never found out".

`cancelled` is the single exception — no set of records implies that a run was stopped early, so it
is taken on the runner's word, and V212 exempts a cancelled run from the outcome/counts agreement
CHECK.

## A failure always says why

* a case recorded as `failed` or `errored` must carry a `failure_code`;
* a failed assertion must carry a `code`;
* a case recorded as `passed` may **not** carry a failure code, and may not contain a failed
  assertion — the precise lie evidence must not be able to tell.

All three are enforced in the contract *and* as V212 CHECK constraints.

## Artifacts are linked, redacted, and verifiable

An artifact reference has no field for content — `extra="forbid"` on the model and no column in the
table. On top of that:

* a `data:` URI is refused (`evidence-artifact-embedded`): a data URI **is** the content;
* a URI carrying `user:pass@` is refused — an artifact link is not a place to keep a credential;
* the scheme must be `http`, `https`, `s3`, or `gs`, or the value must be a scheme-less
  object-store key;
* `redacted` admits only `TRUE`, so the schema has no representation for an unredacted artifact;
* `content_sha256` lets a reader confirm the bytes they fetched are the bytes the evidence names;
* `redaction` records **counts** of what was removed (`{"headers": 2}`), never the values.

Every free-text field — failure messages, assertion `expected`/`actual`/`message`, labels — is run
through `app.intake_secret_scrub.scrub_message` before storage (named credential shapes plus an
entropy pass) and only then truncated, so a secret cannot survive by sitting past the cut.

## A run names the target it used

The ECA-1.2 record is **read**, not resolved, and its `target_identity()` block is snapshotted onto
the run: id, slug, environment, network class, base URL. Two consequences worth stating:

* a target that is later renamed, repointed, or retired cannot rewrite what a run says it did;
* recording history does not fail because the target has since been disabled, and does not write an
  ECA-1.2 `target.resolve` audit entry claiming a fresh selection happened.

The credential reference is deliberately **not** part of the identity block: evidence that named
the vault entry would tell a reader where to go looking.

## Recording is idempotent

Evidence is immutable, so a runner that uploads and loses the response has no way to correct a
duplicate. Supply an `idempotency_key`: the store looks it up before inserting, and again if a
concurrent upload wins the unique-index race. Either way the original run comes back, and the
endpoint answers `200` instead of `201` so a runner is never told it created evidence that predates
its request.

## Endpoints

| Method | Path | Permission |
|---|---|---|
| `POST` | `/v1/tenants/{tenant}/verification-runs` | `verification_evidence:create` |
| `GET` | `/v1/tenants/{tenant}/verification-runs` | `verification_evidence:view` |
| `GET` | `/v1/tenants/{tenant}/verification-runs/{run_id}` | `verification_evidence:view` |
| `GET` | `/v1/tenants/{tenant}/verification-runs/{run_id}/export?format=json\|junit` | `verification_evidence:view` |
| `GET` | `/v1/tenants/{tenant}/verification-runs/{run_id}/mock-attestation` | `verification_evidence:view` |

The list read takes the filters a gate asks with: `suite_digest`, `target_id`, `outcome`, `limit`.

### RBAC

V212 adds the `verification_evidence` resource to the built-in grids. Owner/Admin manage; **Editor
gets `view` + `create`**, because recording a run is what verification *is* and a CI runner
authenticating with an API key resolves to the Editor grid; Viewer gets `view`. Editing is
meaningless (evidence is immutable) and deleting is a retention decision, so both stay with
Owner/Admin. A tenant with **custom** roles must grant `verification_evidence` explicitly — the
reseed only rewrites built-in grids.

## Exports

Both formats answer one question: can a reader of the export reach a conclusion the stored record
does not support? Neither exporter recomputes a verdict, filters a case, or shortens a list.

### `format=json`

The stored record verbatim (`application/json`), timestamps in ISO-8601, **keys sorted** — so two
exports of the same run are byte-identical and can be diffed without a semantic differ.

### `format=junit`

JUnit XML (`application/xml`), which GitHub Actions, GitLab, Jenkins, and Buildkite render
natively:

* the `<testsuite>` counters come from the **stored counts**, never from a re-tally;
* one `<testcase>` per stored case, in stored order, `classname` = operation key, `name` = case id;
* `failed` → `<failure>`, `errored` → `<error>`, `skipped` → `<skipped>`, passing → an empty
  `<testcase>`;
* the failure body carries the redacted message, the expected/actual status, and one line per
  failed assertion, so a CI viewer explains the break without a trip back to the API;
* suite digest, target identity, runner, and the run window travel as `<properties>`;
* control characters XML 1.0 cannot represent are stripped, so a raw response body quoted by a
  runner cannot produce a file no CI parser will read.

## Error taxonomy

Every refusal carries `{"code", "message"}`; a client branches on the code.

| Code | Meaning | HTTP |
|---|---|---|
| `evidence-suite-digest-invalid` | Not `sha256:<64 hex>` | 400 |
| `evidence-timing-invalid` | A run finished before it started, or a case falls outside its run's window | 400 |
| `evidence-outcome-mismatch` | A declared outcome contradicts the records it summarizes | 400 |
| `evidence-failure-detail-required` | A non-passing case, or a failed assertion, with no code | 400 |
| `evidence-duplicate-case` | The same case id recorded twice in one run | 400 |
| `evidence-no-operations` | A run with no cases that did not declare itself `cancelled` | 400 |
| `evidence-artifact-embedded` | An artifact tried to carry its content inline | 400 |
| `evidence-artifact-uri-invalid` | Malformed link, unsupported scheme, or embedded credentials | 400 |
| `evidence-artifact-unredacted` | An artifact submitted without asserting redaction | 400 |
| `evidence-export-format-unsupported` | A format outside `json` \| `junit` | 400 |
| `evidence-target-not-found` | The run named a target this tenant does not have | 404 |
| `evidence-run-not-found` | No such run in this tenant | 404 |
| `evidence-mock-attestation-absent` | A mock attestation was asked for on a run that recorded none | 404 |
| `mock-bundle-digest-invalid` | The attested bundle digest is not `sha256:<64 hex>` | 400 |
| `mock-bundle-mutable` | The attested bundle pins an unpublished revision, or names no revision id | 400 |
| `mock-runtime-version-invalid` | The runtime version is not a semantic version | 400 |
| `mock-runtime-incompatible` | The runtime falls outside the bundle format's runtime window | 400 |
| `mock-corpus-unidentified` | A conformance result arrived with no corpus digest | 400 |
| `mock-conformance-counts-mismatch` | Conformance counts do not sum, or a failure names no case | 400 |
| `mock-status-mismatch` | A declared mock status contradicts its conformance result | 400 |
| `mock-status-invalid` | A status or reason code outside the closed vocabularies | 400 |
| `mock-fixture-digest-invalid` | A fixture-pack digest is not `sha256:<64 hex>` | 400 |

## Example

```bash
curl -X POST https://api.apiome.io/v1/tenants/acme/verification-runs \
  -H "Authorization: Bearer $APIOME_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target_ref": "staging",
    "suite_digest": "sha256:9f2c…",
    "runner_name": "apiome-contract-runner",
    "runner_version": "1.2.3",
    "started_at": "2026-07-27T12:00:00Z",
    "finished_at": "2026-07-27T12:00:31Z",
    "idempotency_key": "gha-run-8842",
    "context": {"commit": "abc123", "branch": "main"},
    "operations": [
      {
        "case_id": "get-pets-example-1",
        "operation_key": "GET /pets",
        "http_method": "GET",
        "http_path": "/pets",
        "outcome": "passed",
        "expected_status": "200",
        "actual_status": 200,
        "duration_ms": 120
      },
      {
        "case_id": "get-pet-negative-1",
        "operation_key": "GET /pets/{petId}",
        "http_method": "GET",
        "http_path": "/pets/abc",
        "outcome": "failed",
        "failure_code": "status-mismatch",
        "failure_message": "expected 400, got 500",
        "expected_status": "400",
        "actual_status": 500,
        "duration_ms": 300,
        "assertions": [
          {
            "kind": "status_code",
            "outcome": "failed",
            "code": "status-mismatch",
            "expected": "400",
            "actual": "500"
          }
        ],
        "artifacts": [
          {
            "kind": "response",
            "uri": "s3://acme-artifacts/runs/8842/case-2.json",
            "media_type": "application/json",
            "content_sha256": "c3ab…",
            "redaction": {"headers": 2}
          }
        ]
      }
    ]
  }'
```

```bash
# The same evidence, in the shape a CI test tab renders.
curl -H "Authorization: Bearer $APIOME_TOKEN" \
  "https://api.apiome.io/v1/tenants/acme/verification-runs/$RUN_ID/export?format=junit" \
  -o verification.xml
```

## What ECA-2.1 and ECA-3.1 build on this

* **ECA-2.1 (HTTP contract runner)** produces exactly a `VerificationRunInput`: the runner executes
  a compiled suite against a resolved target and posts the result here. Nothing about execution
  lives in this module.
* **ECA-3.1 (evidence-backed policy evaluator)** reads it back: "a passing run of digest *X* against
  an environment of class *Y*, no older than *Z*" is a list read with `suite_digest` and `outcome`
  filters, and a decision cites the run id it relied on.

## Mock attestation (PMR-3.2)

A run recorded against a **`mock` target environment** must say *which* mock. The optional `mock`
field on a submission — and the `mock` block on every read and export — carries four identities:

| Field | What it pins |
|---|---|
| `bundle.digest` | The PMR-1.1 `manifestDigest` of the served bundle |
| `runtime.version` / `runtime.image` | Which apiome-mock produced the behavior |
| `conformance.corpus_digest` + counts | Which PMR-3.1 corpus judged it, and how it went |
| `fixture_packs[].digest` | Which PMR-2.2 seed data it was proved against |

Four rules, each enforced in `app/mock_attestation.py` and again by a V249 CHECK:

1. **Only immutable digests are linked** — `sha256:<64 hex>`, over a **published** revision with a
   revision id. A draft can still change (`mock-bundle-mutable`).
2. **The runtime and corpus are identified** — a semantic runtime version inside the bundle
   format's window, and a corpus digest behind every conformance result.
3. **The status is derived** — `verified` / `failed` / `missing` comes from the conformance counts;
   a contradicting declaration is refused, exactly as a run outcome is.
4. **A gap is explicit** — every non-`verified` status carries a `reason_code`, and a mock-targeted
   run that attaches nothing stores `missing` / `mock-attestation-missing` rather than nothing at
   all. A run against staging stores no mock block, which stays distinguishable from an unverified
   one.

The attestation is written in the **run's own transaction**, so immutable evidence is never left
half-attached.

`GET …/{run_id}/mock-attestation` renders it as an in-toto Statement v1 in a DSSE envelope, whose
subject is the bundle (plain `sha256`) and whose signature uses the shared
`lint_attestation_signing_secret` and key id `apiome-lint-hmac-v1` — so a verifier that already
holds the CLX-4.2 secret needs no new configuration. A `missing` or `failed` mock is still attested,
signed; `404` means the run recorded no mock at all.

Producer side: `apiome-mock attest` emits the block ready to attach; `apiome mock verify-attestation`
verifies the envelope offline. See
[docs/guide/mock-release-attestation.md](../../docs/guide/mock-release-attestation.md).
