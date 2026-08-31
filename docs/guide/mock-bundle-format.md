# Portable mock bundle format (`apiome.mock.bundle/v1`)

A **mock bundle** is a single JSON document that pins everything the Apiome mock runtime needs to
serve one version — offline. No database, no network, no tenant credentials. That is what lets a
mock run in CI, on a laptop, or inside an air-gapped network with exactly the behavior the hosted
mock has.

| | |
|---|---|
| Format id | `apiome.mock.bundle/v1` |
| Export | `GET /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/bundle` |
| Permission | `versions:view` (the version must have mock serving enabled) |
| Producer | `app.mock_bundle` (apiome-rest) |
| Consumer | `apiome_mock.bundle` (apiome-mock ≥ 0.2.0) |

---

## Exporting a bundle

```bash
curl -sS -H "Authorization: Bearer $APIOME_TOKEN" \
  "http://localhost:8000/v1/versions/acme-corp/$PROJECT_ID/$VERSION_RECORD_ID/mock/bundle" \
  -o petstore-1.0.0-mock-bundle.json
```

The response is the bundle document, with a `Content-Disposition` filename derived from the
project slug and version label.

## Document shape

```jsonc
{
  "bundleFormat": "apiome.mock.bundle/v1",
  "manifest": {                          // the authoritative, byte-stable description
    "bundleFormat": "apiome.mock.bundle/v1",
    "bundleFormatVersion": 1,
    "runtime": {                         // which runtimes may load this bundle
      "minRuntimeVersion": "0.2.0",      // inclusive
      "maxRuntimeVersion": "1.0.0"       // exclusive; null means open-ended
    },
    "api": {
      "tenant": "acme-corp",
      "project": "petstore",
      "version": "1.0.0",
      "revisionId": "…",                 // the immutable versions.id
      "published": true,
      "protocol": "openapi"
    },
    "versionDigest": "sha256:…",         // over the canonical {api, spec} snapshot
    "contents": {
      "spec":     {"digest": "sha256:…", "mediaType": "application/json"},
      "settings": {"digest": "sha256:…"},
      "fixtures": [{"name": "pets.json", "mediaType": "application/json",
                    "digest": "sha256:…", "bytes": 19}]
    },
    "fixturesDigest": "sha256:…",
    "redactions": ["/scenarios/…/headers/Authorization"]   // what was stripped, and from where
  },
  "manifestDigest": "sha256:…",          // SHA-256 over the manifest's canonical JSON
  "signature": {                          // null when no signing secret is configured
    "payloadType": "application/vnd.apiome.mock-bundle+json",
    "keyId": "apiome-mock-bundle-hmac-v1",
    "alg": "hmac-sha256",
    "sig": "…"
  },
  "spec": { "openapi": "3.1.0", "…": "…" },              // the version's generated document
  "settings": { "scenarios": {…}, "activeScenario": "…", "chaos": {…}, "fixturePacks": {…}, "callbacks": {…}, "responseCorrelation": {…} },  // portable settings subset
  "fixtures": { "pets.json": "<base64>" }                // embedded, so nothing else is needed
}
```

## Determinism

Exporting the same version with the same settings and fixtures always produces the **same bytes**,
and therefore the same `manifestDigest`. That property is what makes a bundle digest usable as a
release-proof identifier, so it is protected deliberately:

* The manifest carries **no wall clock** — no `generatedAt`, no export timestamp.
* JSON is canonicalized everywhere (recursively sorted keys, compact separators).
* Fixture entries are sorted by name, so call-site ordering cannot change the digest.
* The signature lives *outside* the manifest, so signing (or not) never changes the digest.

## Signing and verification

`manifestDigest` proves integrity; the signature proves origin. The signature is an HMAC-SHA256
over the [DSSE PAEv1](https://github.com/secure-systems-lab/dsse) encoding of the manifest bytes,
keyed by a shared secret — the same scheme the lint gate attestations use, so verification needs
nothing but the standard library.

Configure the secret on apiome-rest and share it with your runtime/CI verifiers:

```bash
APIOME_MOCK_BUNDLE_SIGNING_SECRET=<shared-secret>
```

Unset, bundles export with `"signature": null` — well-formed, just not verifiable.

Verification recomputes every content digest, recomputes the manifest digest, checks the signature
when a secret is supplied, and re-scans for credentials. Every failure is reported (not just the
first), each with a stable code:

| Code | Meaning |
|---|---|
| `bundle-malformed` | Not a bundle, or a payload/manifest field is missing or unusable |
| `bundle-format-unsupported` | `bundleFormatVersion` is outside what this runtime supports |
| `runtime-too-old` | Runtime is older than `manifest.runtime.minRuntimeVersion` |
| `runtime-too-new` | Runtime is at or past `manifest.runtime.maxRuntimeVersion` |
| `runtime-version-invalid` | A version bound is not `major.minor.patch` |
| `digest-mismatch` | A payload does not hash to its manifest digest (tampering or corruption) |
| `signature-missing` | Unsigned, but a verified signature was required |
| `signature-invalid` | Signature does not verify against the configured secret |
| `credential-present` | Credential-shaped content survived into settings or a fixture |

## No tenant credentials

Three independent layers keep secrets out of a bundle:

1. **Allowlist.** Only `scenarios`, `chaos`, `fixturePacks` (#4745, PMR-2.2), `callbacks`
   (#4746, PMR-2.3), `responseCorrelation` (#5527, MSC-1.1), and `activeScenario`
   (#5531, MSC-2.1) travel from
   `versions.mock_settings`. Hosted-plane access control (the private-mock `mode`) is meaningless
   offline and never leaves the server.
2. **Redaction.** Credential-shaped fields inside that subset — `Authorization`, `*token*`,
   `*secret*`, `*password*`, `*apiKey*`, PEM blocks, `Bearer …` values — are *removed* (not masked,
   so not even a length leaks) and their JSON pointers are published in `manifest.redactions`.
3. **Re-scan on load.** The runtime rejects a received bundle carrying credential-shaped content,
   whatever produced it.

The OpenAPI document itself is deliberately exempt from the credential scan: it is the version's
published contract, where `Authorization` names a security *scheme* rather than carrying a secret.

## Loading a bundle offline

```python
from apiome_mock.bundle import (
    MockBundleError,
    MockBundleIncompatibleError,
    load_bundle_file,
)

try:
    bundle = load_bundle_file("petstore-1.0.0-mock-bundle.json", secret=SHARED_SECRET)
except MockBundleIncompatibleError as exc:
    ...   # this bundle is fine; this runtime cannot run it — exc.codes says why
except MockBundleError as exc:
    ...   # corrupt, tampered, unsigned-when-required, or credential-bearing

compiled = bundle.to_compiled_spec()   # same serving unit the hosted path builds
```

`to_compiled_spec()` returns the identical `CompiledSpec` the database path produces, so routing,
request validation, sessions, scenarios, chaos, and
[response correlation](mock-response-correlation.md) behave exactly as they do hosted. A loaded
bundle reports the Unix epoch as its `updated_at` — bundles are immutable and timestamp-free by
design.

## Compatibility policy

* `bundleFormatVersion` bumps for **additive** manifest changes; a runtime rejects versions it does
  not list as supported.
* A **breaking** layout change mints a new format id (`apiome.mock.bundle/v2`) instead of reusing
  this one.
* `minRuntimeVersion` / `maxRuntimeVersion` bound which apiome-mock builds may load the bundle. A
  mismatch is always an explicit, coded error naming both the required range and the running
  version — never a silent degradation.
