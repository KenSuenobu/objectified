# Version Contract-Suite Compiler (ECA-1.1)

> apiome#4729 — the foundation of Executable Contract Assurance (Epic 1, parent #4458).
> Blocks ECA-1.3 (verification evidence) and ECA-2.1 (HTTP contract runner).

## Why

A published specification is passive. Until somebody hand-writes verification cases, "the API
matches its contract" is an opinion — and the cases that do get written differ between teams,
drift from the spec, and cannot be reproduced a month later.

The **contract suite** removes the hand-writing. One canonical version plus one set of compiler
options produce one versioned manifest of executable request cases: what to send, what must come
back, and where each case came from.

## Modules

| Module | Role |
|---|---|
| `app/contract_suite.py` | The pure compiler: options, manifest models, case emission, findings, canonical bytes, digest. No I/O. |
| `app/contract_suite_examples.py` | Attributes a source document's declared examples to `(path, method, site)` by walking the IXH-5.4 example table. |
| `app/contract_suite_service.py` | Resolves a version reference to its canonical model, looks up publication state, and returns the manifest. Writes nothing. |
| `app/contract_suite_routes.py` | `POST /v1/tenants/{tenant}/contracts/{version_ref}/suite`, gated on `versions:view`. |
| apiome-cli `commands/contract.py` | `apiome contract suite`, which writes the canonical bytes and re-derives the digest locally. |

Everything hard is reused rather than rebuilt: `canonical_json_schema` projects the schemas,
`schema_instance_synthesis` (IXH-5.2) generates and verifies bodies, `example_conformance`
(IXH-5.4) locates and checks declared examples, and `schema_reference` (IXH-5.1) supplies the
addressing grammar.

## The three properties the manifest is built around

### It is deterministic

The same canonical model and the same options produce **byte-identical** output.
`canonical_manifest_bytes()` is that artifact — sorted keys at every level, tight separators, one
trailing newline — and `digest` is its SHA-256 with the `digest` field blanked, so a stored
manifest can be re-verified without stripping fields by hand.

Nothing in the compiler reads the clock, the network, or an unseeded PRNG. Generated values come
from a seed derived from `(suite seed, operation key)`, operations are compiled in canonical-key
order, cases follow a fixed source order, and every mapping is written sorted.

This is what makes "this deployment was verified against suite `sha256:ab12…`" a checkable claim,
and it is why `compiler_version` exists: a change to the compilation rules changes the digest, and
a gate pinned to the old digest must notice.

### Every case is attributed

| Field | What it answers |
|---|---|
| `operation_key`, `operation_name` | Which operation the case exercises. |
| `source` | Where the case came from — see the table below. |
| `source_detail`, `source_pointer` | Which example, which mutation, which parameter. |
| `synthetic` | `false` **only** when the request body is an example the author wrote. |
| `expect.outcome` | `success` or `client_error`. |
| `expect.status_codes`, `expect.status_declared` | The codes asserted, and whether the contract declared them or the compiler fell back to a range. |
| `expect.response_schema_id` | Key into the manifest's `schemas` map for the schema a response must satisfy. |

Case sources, in the order they are emitted per operation:

| Source | What it sends |
|---|---|
| `declared_example` | A request body the author wrote, verbatim. |
| `generated_minimal` | A generated body with required properties only. |
| `generated_full` | A generated body with every optional property. |
| `generated_branch` | One body per `oneOf` / `anyOf` / `if` alternative. |
| `negative_missing_body` | No body, where the contract declares one required. |
| `negative_missing_parameter` | A required query parameter omitted. |
| `negative_parameter_type` | A wrong-typed value for a non-string parameter. |
| `negative_body_mutation` | A body violating exactly one schema constraint. |

Parameter values follow the same preference order, and each records its `origin`: a declared
example, then a declared `default`, then the first `enum` member, then a generated value.

### It is honest

What the compiler cannot express, it reports. Findings carry a stable `code`, a `level`
(`unsupported` / `degraded` / `info`), and the operation and pointer they concern:

| Code | Meaning |
|---|---|
| `UNSUPPORTED_STREAMING`, `UNSUPPORTED_OPERATION_KIND`, `MISSING_HTTP_BINDING`, `UNSUPPORTED_PARADIGM` | The operation is not an HTTP request/response exchange, so no case was compiled for it. |
| `UNSUPPORTED_MEDIA_TYPE` | The body is offered only as a non-JSON encoding. |
| `UNSUPPORTED_PARAMETER_SHAPE`, `UNSUPPORTED_PARAMETER_LOCATION`, `UNDECLARED_PATH_PARAMETER` | A parameter cannot be carried in the request (array/object serialization, cookies, a placeholder the contract never declares). |
| `EXAMPLE_SCHEMA_MISMATCH`, `EXAMPLE_UNATTRIBUTED`, `EXAMPLES_TRUNCATED`, `EXAMPLES_NOT_READ` | Declared examples that were excluded, belong to no operation, or were never read. |
| `STATUS_UNDECLARED`, `ERROR_STATUS_UNDECLARED`, `RESPONSE_SCHEMA_ABSENT` | The expectation is weaker than an exact assertion, and says so. |
| `UNMAPPED_SCALAR`, `SCHEMA_TRUNCATED`, `UNRESOLVED_PAYLOAD_TYPE`, `GENERATION_LIMITED` | The schema behind a case constrains less than the source does. |
| `NO_NEGATIVE_CASES`, `NO_CASES_COMPILED`, `CASE_LIMIT_REACHED`, `OPERATION_LIMIT_REACHED`, `OPERATION_NOT_SELECTED` | Coverage that is partial, and why. |
| `AUTHENTICATION_REQUIRED`, `SERVER_TEMPLATED`, `NO_SERVER` | What the runner must supply, because the suite does not carry it. |

Two rules follow from this and are worth stating plainly:

* **A declared example that does not satisfy its own schema is not compiled.** It is a
  documentation bug (IXH-5.4 found 24 in Apiome's own OpenAPI document), and sending it would
  manufacture a failure against a correct implementation. It is reported with its pointer.
* **A negative case isolates one fault.** A case that omits a required query parameter carries an
  otherwise-valid body, and every generated mutant is verified to break exactly the constraint it
  targets — a negative that fails for the wrong reason proves nothing.

## What is deliberately not in a suite

* **Targets and credentials.** Paths are relative; the runner supplies the base URL. A version
  with security requirements gets `AUTHENTICATION_REQUIRED` rather than an invented token. Target
  definitions are ECA-1.2.
* **Results.** Compilation is a pure read — no job, no revision, no audit row. A run's evidence is
  ECA-1.3, which references a suite by digest.
* **Non-HTTP paradigms.** Event, RPC-streaming, and GraphQL operations are recognized and
  reported, never half-compiled.

## Using it

### REST

```bash
curl -X POST \
  "$APIOME/v1/tenants/acme/contracts/project/petstore/1.0.0/suite" \
  -H "X-API-Key: $APIOME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"options": {"seed": 0, "include_negative": true}}'
```

`version_ref` is the schema-reference grammar without a trailing type segment:
`project/{project_slug}/{version}` or `catalog/{item}/{version}`, where `version` is a label, a
revision UUID, or `latest`.

A version that yields no suite (a data-schema artifact with no operations) is a **200** with
`ok: false` and an intake-taxonomy `error`. Only addressing faults are HTTP errors: 400 for a
malformed or type-qualified reference, 404 for one that names nothing visible, 422 for one that
resolves to material no canonical model can be rebuilt from.

### CLI

```bash
apiome contract suite --project petstore --version 1.0.0 --out contract-suite.json
```

The command writes the **canonical bytes** — the exact bytes the digest covers — and then
re-derives the digest from them locally, failing if it disagrees with the one the server reported.
Committing `contract-suite.json` therefore makes a contract change visible as a `git diff`.

Useful flags: `--seed`, `--no-examples`, `--no-generated`, `--no-negative`, `--operation` (repeatable),
`--max-operations`, `--kind catalog`, and the global `--json`.

## Options

| Option | Default | Effect |
|---|---|---|
| `seed` | `0` | Seed for generated values. Part of the digest. |
| `include_declared_examples` | `true` | Compile the document's own examples. |
| `include_generated` | `true` | Compile minimal/full/branch bodies. |
| `include_branches` | `true` | Include one body per polymorphic alternative. |
| `include_negative` | `true` | Compile the negative cases. |
| `verify_examples` | `true` | Check declared examples against their schemas before compiling them. |
| `include_response_schemas` | `true` | Carry response schemas in the manifest. |
| `max_example_cases_per_operation` | `10` | Cap on declared-example cases. |
| `max_generated_cases_per_operation` | `4` | Cap on generated valid bodies (minimal and full first). |
| `max_negative_cases_per_operation` | `6` | Cap on negative cases (structural ones first). |
| `max_operations` | `500` | Cap on compiled operations; truncation is reported. |
| `operations` | all | Restrict to these operation keys. Normalized to a sorted set, so order does not change the digest. |

Every option is echoed on the manifest and hashed into its digest.

## Tests

| File | Covers |
|---|---|
| `tests/test_contract_suite.py` | The corpus: determinism and byte-identity, declared examples, generated values validated against their own schemas, invalid requests, unsupported semantics, expectations, caps. |
| `tests/test_contract_suite_examples.py` | Pointer attribution across OpenAPI 3.x and Swagger 2, and the non-conforming set. |
| `tests/test_contract_suite_service.py` | Reference grammar, provenance, publication lookup, `ok: false`. |
| `tests/test_contract_suite_routes.py` | Auth, permission, addressing faults, option validation, response shape. |
| apiome-cli `tests/test_contract_suite_command.py` | Reference construction, option forwarding, canonical bytes, digest re-derivation. |
