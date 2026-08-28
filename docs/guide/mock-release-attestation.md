# Release-proof mock attestation (`apiome.mock.verification/v1`)

A release proof may say "this version's mock passed" only if it can say **which mock**. A green CI
log cannot: the bundle may have been rebuilt since, the runtime may have been a different version,
the conformance corpus may have changed — or may never have run at all.

A **mock attestation** is the record that closes that gap. It attaches four identities to a
verification run, and nothing else:

| | |
|---|---|
| Record format | `apiome.mock.verification/v1` |
| Producer | `apiome-mock attest` (apiome-mock ≥ 0.10.0) |
| Attached to | `POST /v1/tenants/{tenant}/verification-runs` — the `mock` field |
| Signed statement | `GET /v1/tenants/{tenant}/verification-runs/{run_id}/mock-attestation` |
| Predicate type | `https://apiome.dev/attestations/mock-runtime/v1` |
| Offline verifier | `apiome mock verify-attestation` |
| Permission | `verification_evidence:create` to record, `verification_evidence:view` to read |

| Identity | What it answers |
|---|---|
| **Bundle digest** (PMR-1.1) | Which immutable bundle was served — `manifestDigest`, `sha256:<hex>` |
| **Runtime version** (PMR-1.2) | Which apiome-mock produced the behavior, and which image |
| **Conformance result** (PMR-3.1) | Which corpus judged it, by digest, and how it went |
| **Fixture-pack digests** (PMR-2.2) | Which seed data the behavior was proved against |

---

## The four rules

Each acceptance criterion is a refusal, not a convention.

**Only immutable digests are linked.** `bundle.digest` must be `sha256:<64 hex>`, and the revision
it pins must be **published** and carry a revision id. A draft can still change, so a digest naming
one proves nothing later — an attestation over one is refused with `mock-bundle-mutable`. Fixture
pack digests are held to the same shape.

**A verification names its runtime and its corpus.** The runtime version must parse as a semantic
version inside the bundle format's runtime window (`0.2.0` ≤ *v* < `1.0.0`), and a conformance
result must carry the corpus digest. "It passed" with no corpus behind it is not a result.

**The status is derived, never asserted.** `verified` / `failed` / `missing` comes from the
conformance counts, exactly as an ECA-1.3 run outcome comes from its case records. A submitted
`status` that disagrees is refused, so no upload can record a verified mock over a red corpus.

**A missing or failed verification is explicit.** Every non-`verified` status carries a
`reason_code` from a closed set. And a run recorded against a **`mock` target environment** with no
attestation attached stores one anyway, saying `missing` / `mock-attestation-missing` — because a
release proof whose mock block is simply absent cannot be told apart from one whose mock
verification was skipped.

| `reason_code` | Meaning |
|---|---|
| `mock-conformance-failed` | The corpus ran and cases failed (the failing case names travel with it) |
| `mock-conformance-missing` | An attestation was attached, but no corpus was run — or it executed no cases |
| `mock-attestation-missing` | The run targeted a mock and attached nothing at all |

---

## Producing a record

`apiome-mock attest` writes the record. It takes the conformance half three ways.

**Run the corpus now**, against an already-started runtime:

```bash
apiome-mock attest \
  --bundle petstore-1.0.0-mock-bundle.json \
  --base-url http://127.0.0.1:8775 \
  --image ghcr.io/apiome/apiome-mock@sha256:… \
  --out mock-attestation.json
```

**Attest from a report a previous job wrote** — the usual CI shape, one job runs the corpus and
another turns it into evidence:

```bash
apiome-mock conformance --base-url http://127.0.0.1:8775 --json > conformance.json
apiome-mock attest --bundle bundle.json --conformance conformance.json --out mock-attestation.json
```

**Attest with no corpus at all**, recording an explicitly unverified mock. This is not an error and
not silence — the record says `missing` with a reason:

```bash
apiome-mock attest --bundle bundle.json --out mock-attestation.json
```

The record is always written, including for a failing corpus, so the evidence of a bad build is as
durable as the evidence of a good one. The **exit code** is what fails the job:

| Code | Meaning |
|---|---|
| `0` | The record says `verified` or `missing` |
| `5` | Conformance failed — the record says `failed`, and it was still written |
| `2` | Configuration error: no bundle, an unreadable report, an unwritable `--out` |
| `3` / `4` | The bundle is invalid, or incompatible with this runtime |

The record is **deterministic**: no wall clock, no hostname, no base URL. Two runs of the same
bundle on the same runtime against the same corpus produce byte-identical records. Timing belongs to
the verification run that carries it.

### Record shape

```jsonc
{
  "record_format": "apiome.mock.verification/v1",
  "mock": {                                       // ← attach this verbatim to a verification run
    "status": "verified",                         // derived: verified | failed | missing
    "reason_code": null,                          // required whenever status != verified
    "reason": null,
    "bundle": {
      "digest": "sha256:19632a39…",               // the manifestDigest — what the proof links
      "format": "apiome.mock.bundle/v1",
      "format_version": 1,
      "signed": true,
      "api": {
        "tenant": "acme", "project": "petstore", "version": "1.0.0",
        "revision_id": "8f14e45f-…",              // must be present …
        "published": true,                        // … and published, or the attestation is refused
        "protocol": "openapi"
      }
    },
    "runtime": {
      "name": "apiome-mock",
      "version": "0.10.0",
      "image": "ghcr.io/apiome/apiome-mock@sha256:…"   // pin a digest; a floating tag identifies nothing
    },
    "conformance": {
      "corpus_format": "apiome.mock.conformance/v1",
      "corpus_version": "1.0.0",                  // the label the corpus document declares
      "corpus_digest": "sha256:c21d3ee1…",        // sha256 over its canonical JSON — the identity
      "corpus_case_count": 30,
      "total": 30, "passed": 30, "failed": 0,
      "failed_cases": []                          // bounded; the full detail is in the run's cases
    },
    "fixture_packs": [
      { "name": "seeded-pets", "digest": "sha256:b1f5da7f…",
        "format": "apiome.mock.fixture-pack/v1", "format_version": 1,
        "origin": "authored", "redaction_status": "not-applicable" }
    ]
  }
}
```

The `mock` block is exactly the shape a verification run accepts, so a CI job merges it into an
evidence submission without reshaping it. That is also why it is snake_case where the rest of the
runtime's JSON is camelCase: it is an evidence submission, not a runtime document.

### Corpus identity

The corpus declares a `corpusVersion` and resolves a `corpusDigest` taken over its canonical JSON.
Reindenting or reordering the file does not change the digest; adding, removing, or editing a case
does. `conformance --json` and `selftest --json` now report that identity, so a stored report
carries it into the attestation.

---

## Attaching it to a release proof

The attestation travels as the `mock` field of an ECA-1.3 verification run:

```bash
jq --slurpfile att mock-attestation.json '.mock = $att[0].mock' run.json \
  | curl -sS -X POST \
      -H "Authorization: Bearer $APIOME_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "$APIOME_URL/v1/tenants/acme/verification-runs"
```

It is written in the run's **own transaction**. Evidence is immutable (apiome-db V212/V249 reject
every `UPDATE`), so an attestation that could arrive later would be a second, mutable truth about
immutable evidence.

A run against a `mock` environment that attaches nothing gets the explicit `missing` record instead.
A run against staging or production stores no mock block at all — `null`, meaning "this run had
nothing to do with a mock", which stays distinguishable from "its mock was not verified".

---

## Reading it back

The stored attestation appears on the run and in **both** exports:

```bash
curl -sS -H "Authorization: Bearer $APIOME_TOKEN" \
  "$APIOME_URL/v1/tenants/acme/verification-runs/$RUN_ID/export?format=json" | jq .mock
```

The JUnit export carries it as `<properties>`, so a CI viewer shows the mock behind a green
contract run — and, more importantly, shows when there wasn't one:

```
apiome.mock.status          verified
apiome.mock.bundle_digest   sha256:19632a39…
apiome.mock.runtime_version 0.10.0
apiome.mock.corpus_digest   sha256:c21d3ee1…
apiome.mock.conformance     30/30 passed
```

---

## Verifying it offline

`GET …/verification-runs/{run_id}/mock-attestation` renders the attestation as an **in-toto
Statement v1** inside a **DSSE envelope**:

* the **subject** is the bundle itself, digested with a plain `sha256` over the `manifestDigest`
  value — a holder of the bundle file ties it to the statement with `sha256sum` alone;
* the **predicate** carries the bundle coordinates, runtime, corpus, counts, fixture-pack digests,
  and the verification run it belongs to. Identities and verdicts only: never spec text, fixture
  bodies, or credentials;
* the **signature** is HMAC-SHA256 over the DSSE PAEv1 encoding, keyed by
  `APIOME_LINT_ATTESTATION_SIGNING_SECRET` and naming the key id `apiome-lint-hmac-v1` — the *same*
  secret and key id as a lint gate attestation, so a verifier that already holds it needs no new
  configuration. With no secret configured the envelope is well-formed but its `signatures` list is
  empty.

A run whose mock says `missing` or `failed` still returns a statement — signed — saying exactly
that. `404` comes back only when the run recorded no mock at all.

```bash
curl -sS -H "Authorization: Bearer $APIOME_TOKEN" \
  "$APIOME_URL/v1/tenants/acme/verification-runs/$RUN_ID/mock-attestation" > mock.att

apiome mock verify-attestation --file mock.att --secret "$APIOME_LINT_ATTESTATION_SECRET"
```

```
Mock attestation verified.
Status: verified
Bundle: sha256:19632a39…
Runtime: apiome-mock 0.10.0
Corpus: sha256:c21d3ee1… (30/30 passed)
Fixture pack: seeded-pets sha256:b1f5da7f…
```

The command exits `0` only when the signature verifies **and** the attestation says the mock was
verified. A signed statement that the mock failed, or was never verified, is a valid attestation and
an unacceptable release proof — the two are distinguished by the exit code, not by prose a script
would have to grep. It accepts either the route's wrapper or a bare envelope.

Verification is symmetric and dependency-free: any holder of the shared secret can reproduce it in
about ten lines of standard-library code.

---

## In a CI job

```yaml
env:
  MOCK_IMAGE: ghcr.io/apiome/apiome-mock@sha256:…   # pin a digest, not a tag

steps:
- uses: apiome/apiome/mock-action@v1
  id: mock
  with:
    bundle: petstore-1.0.0-mock-bundle.json
    image: ${{ env.MOCK_IMAGE }}

- name: Attest the mock
  run: |
    apiome-mock conformance --base-url "${{ steps.mock.outputs.base-url }}" --json > conformance.json
    apiome-mock attest \
      --bundle petstore-1.0.0-mock-bundle.json \
      --conformance conformance.json \
      --image "$MOCK_IMAGE" \
      --out mock-attestation.json

- name: Record the release proof
  run: |
    jq --slurpfile att mock-attestation.json '.mock = $att[0].mock' run.json \
      | curl -sS -X POST -H "Authorization: Bearer $APIOME_TOKEN" \
          -H "Content-Type: application/json" --data-binary @- \
          "$APIOME_URL/v1/tenants/acme/verification-runs"
```

Assert `steps.mock.outputs.bundle-digest` against the digest in the record to prove the job attested
the bundle it intended to. The record's `runtime.version` comes from the runtime itself, so it
reports what actually served the requests rather than what the workflow asked for.

---

## What this is not

* **Not a gate.** The attestation is evidence; deciding what to do about a `failed` or `missing`
  mock is the verification policy's job (ECA-3.1).
* **Not a bundle store.** It links digests; it never carries the bundle, the spec, or fixture data.
* **Not mutable.** There is no update route and no partial write. A correction is a new run.

---

## See also

* [mock-bundle-format.md](mock-bundle-format.md) — where `manifestDigest` comes from
* [portable-mock-runtime.md](portable-mock-runtime.md) — the runtime, its conformance corpus, and
  its exit codes
* [mock-fixture-packs.md](mock-fixture-packs.md) — fixture pack digests and provenance
* [mock-action/README.md](../../mock-action/README.md) — starting a pinned runtime in a job
