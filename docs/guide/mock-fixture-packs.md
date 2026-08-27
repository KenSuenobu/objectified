# Mock fixture packs and data lifecycle (`apiome.mock.fixture-pack/v1`)

A **fixture pack** is a named, versioned unit of deterministic mock data with a stable content
digest. Packs give tests a portable, reviewable way to seed the stateful mock and reset it
between cases — the same pack always produces the same state, and the digest proves which data a
session was seeded with.

| | |
|---|---|
| Format id | `apiome.mock.fixture-pack/v1` |
| Author | `PUT /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/fixture-packs` |
| Inspect | `GET /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/fixture-packs` |
| Permission | `versions:edit` to save, `versions:view` to read |
| Storage | `versions.mock_settings.fixturePacks` (travels inside portable bundles) |
| Producer | `app.mock_fixture_packs` (apiome-rest) |
| Consumer | `apiome_mock.fixture_packs` + `apiome_mock.lifecycle` (apiome-mock ≥ 0.5.0) |

---

## Pack shape

```jsonc
{
  "packs": {
    "smoke": {                                    // pack name: [A-Za-z0-9][A-Za-z0-9._-]{0,63}
      "packFormat": "apiome.mock.fixture-pack/v1",// optional; defaults to the current format
      "packFormatVersion": 1,                     // optional; defaults to the current version
      "description": "Two pets and one order.",   // optional, ≤ 500 chars
      "data": {                                   // template fixture values by name (PMR-2.1)
        "pets": [{"id": 1, "name": "Rex"}]
      },
      "collections": {                            // seed resources per CRUD collection path
        "/pets": [
          {"id": 1, "name": "Rex"},
          {"id": 2, "name": "Bella"}
        ],
        "/orders": [{"id": 1, "petId": 2}]
      }
    }
  }
}
```

The two payload sections serve the two runtime consumers:

- **`data`** — fixture values readable by response templates as `{{fixture.<name>...}}`. When
  several packs define the same name, packs merge in sorted-name order (later names win), on top
  of the flat `mock_settings.fixtures` map.
- **`collections`** — resources seeded into the session store when a session resets to the pack.
  Keys are collection paths as the CRUD layer sees them (`/pets`). Each resource's session id is
  its own `id` field (string or integer) when present, else its 1-based list position; ids must
  be unique within a collection.

Limits: 20 packs per version, 128 KiB canonical JSON per pack, 50 collections per pack,
500 resources per collection. Unknown top-level keys, malformed collection paths, and duplicate
resource ids fail validation with a 422 listing every error.

## Versioning and digests

Every pack declares `packFormat` and `packFormatVersion`. A breaking layout change mints
`/v2`; additive optional fields bump the version, and a runtime **skips** packs whose version it
does not support rather than misreading them.

A pack declares the **lowest** version that can express it. Today that means v1, unless it carries
the optional `provenance` block described below, which makes it v2. That rule is why adding
provenance left every existing pack's digest — and every runtime that only understands v1 —
untouched.

A pack's **digest** is `sha256:<hex>` over the canonical JSON (recursively sorted keys, compact
separators) of its canonicalized document — cosmetic differences such as an omitted-vs-explicit
format id or an empty `data` object never change it. The digest is returned on save, listed by
the runtime's `__mock__/fixture-packs` endpoint, and echoed by every reset, so a test can pin the
exact data it seeded. Saving the same pack content always yields the same digest, hosted or
portable.

## Provenance: where a pack's data came from

A pack may carry an optional `provenance` block (v2) saying where its data originated. Packs
written by hand have none, and are treated as `authored`. Packs produced by
[guarded proxy capture](mock-proxy-capture.md) carry one:

```jsonc
"provenance": {
  "source": "capture",                            // "authored" | "capture"
  "capturedFrom": ["https://api.example.com/v1"], // allowlisted upstreams it drew from
  "captures": 12,                                 // reviewed captures converted
  "redactions": 37,                               // values redaction removed on the way in
  "approvedBy": "…",
  "approvedAt": "2026-08-26T19:00:00Z"
}
```

The runtime reports it wherever it describes a pack — see the two endpoints below — so a fixture
replayed months later can still say whether it was written by hand or recorded off a real system,
and whether redaction had to remove anything.

`source: "capture"` cannot be set by hand: `PUT …/mock/fixture-packs` refuses a pack claiming it
unless the block matches what publishing captures already stored under that name. Editing a
capture-derived pack through the normal editor therefore keeps its provenance intact.

## Data lifecycle endpoints

Every mock version reserves the `__mock__` path segment for the runtime's control plane, under
the same version prefix as the mocked API — identically on the hosted runtime and the portable
(`apiome-mock run`) runtime, because both serve it from the same code path. Control routes bypass
scenario overrides and chaos injection.

### `GET …/{version}/__mock__/fixture-packs`

Lists the version's packs — name, digest, format version, fixture data names, and per-collection
resource counts (never resource bodies):

```json
{
  "packs": [
    {
      "name": "smoke",
      "description": "Two pets and one order.",
      "digest": "sha256:…",
      "packFormat": "apiome.mock.fixture-pack/v1",
      "packFormatVersion": 1,
      "fixtures": ["pets"],
      "collections": {"/orders": 1, "/pets": 2},
      "resources": 3,
      "origin": "authored",
      "redactionStatus": "not-applicable"
    }
  ]
}
```

`origin` is `authored` or `capture`; `redactionStatus` is `not-applicable` for authored data,
and `clean` or `redacted` for captured data. A pack with a `provenance` block also echoes it here
in full.

### `POST …/{version}/__mock__/session/reset`

Resets the calling session, named by the required `X-Mock-Session` header. With no body (or an
empty JSON object) the session is cleared; with `{"pack": "smoke"}` it is atomically replaced by
the pack's collections:

```bash
curl -X POST -H "X-Mock-Session: test-1" -H "Content-Type: application/json" \
  -d '{"pack": "smoke"}' "$MOCK/demo/petstore/1.0.0/__mock__/session/reset"
```

```json
{
  "session": "test-1",
  "reset": true,
  "pack": "smoke",
  "packDigest": "sha256:…",
  "collections": 2,
  "resources": 3,
  "origin": "authored",
  "redactionStatus": "not-applicable"
}
```

The same two facts are also stamped on the response as `X-Mock-Fixture-Origin` and
`X-Mock-Fixture-Redaction`, and a captured pack's full `provenance` block is included in the body —
so a test seeding from recorded traffic always knows it is doing so.

A reset discards *everything* in the session namespace — CRUD resources and scenario sequence
counters — and the replacement is all-or-nothing: when the seed would exceed the session's
resource or byte caps the reset fails with a 400 problem and the previous state is untouched.
Integer id allocation continues after the highest seeded numeric id, so a `POST /pets` following
the example above creates id `3`.

Errors are RFC 7807 problems: `session-required` (missing header), `unknown-fixture-pack` (with
`availablePacks`), `bad-request` (malformed body or capacity breach), `method-not-allowed`, and
`session-store-unavailable` (deployment without a session store).

## Isolation guarantees

Session state — and therefore every lifecycle operation — is namespaced by
**tenant + project + version + session token**:

- A reset builds its key from the request URL's coordinates plus the caller's own
  `X-Mock-Session` token; no other namespace is read or written.
- The same token under two versions (or tenants, or projects) is two independent sessions.
- Packs are part of a version's mock settings: another version, tenant, or project never sees
  them, and the hosted access checks (published/private mock, API keys) apply to `__mock__`
  routes exactly as to spec routes.

## In CI (portable runtime)

Packs travel inside the portable bundle's settings (they are part of the manifest's settings
digest and are credential-scanned like every bundled setting), so a pinned bundle carries its
seed data with it:

```bash
apiome-mock run --bundle petstore-1.0.0-mock-bundle.json &
curl -X POST -H "X-Mock-Session: ci-$GITHUB_RUN_ID" -d '{"pack": "smoke"}' \
  "http://127.0.0.1:8775/demo/petstore/1.0.0/__mock__/session/reset"
# … run the test suite against deterministic state …
```

Related guides: [mock-bundle-format.md](mock-bundle-format.md),
[portable-mock-runtime.md](portable-mock-runtime.md).
