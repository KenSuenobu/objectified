# Mock response preview (dry-run render)

Mock templates are validated when they are saved, so a stored scenario or correlation block is
guaranteed well-formed. That answers the wrong question. The one an author has is **what comes
back?** — and answering it used to mean enabling a mock, sending a real request to the data plane
with the right headers, and reading the result.

**Preview** answers it in one call. Send a synthetic request; get the status, headers, media type
and body the mock would serve, plus a **decision trace** naming which layer produced the body.

| | |
|---|---|
| Render | `POST /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/preview` |
| Permission | `versions:view`; `versions:edit` when a draft `settings` override is sent |
| Requires a provisioned mock | No |
| Requires `mock_enabled` | No |
| Writes anything | No |
| Producer | `app.mock_preview` (apiome-rest) |
| Renderer | `apiome_mock.preview` (apiome-mock ≥ 0.12.0) |

---

## Why it cannot disagree with the mock

The preview is **not** a second implementation of the serving sequence. apiome-rest authenticates
and authorizes the caller, builds the version's [portable mock bundle](mock-bundle-format.md), and
asks apiome-mock's internal `/__preview__` endpoint to render it through
`serve_compiled_request` — the very function the hosted data plane and the portable runtime call.

```
apiome-ui / apiome-cli
      │  POST …/mock/preview            (auth · RBAC · rate limit)
      ▼
 apiome-rest ── build bundle(spec, scenarios, chaos, fixtures, callbacks, correlation)
      │  POST /__preview__              (X-Internal-Service-Token)
      ▼
 apiome-mock ── load_bundle_document() → serve_compiled_request()   ← the data plane's own path
      │
      ▼  { operation, status, headers, mediaType, body, trace, chaos }
```

Because the bundle is the unit that crosses the hop, a preview renders exactly the configuration a
downloaded bundle would — there is no second projection to keep in step.

---

## Request

```jsonc
{
  "request": {
    "method": "GET",
    "path": "/pets/42",            // relative to the version root; a ?query suffix is merged in
    "headers": {"Accept": "application/json"},
    "query": {"expand": ["owner"]},
    "body": null,                  // a JSON value (sent as application/json), a string, or null
    "scenario": "quota-exceeded",  // shorthand for X-Mock-Scenario; an explicit header wins
    "seed": 42                     // shorthand for ?__seed=
  },
  "settings": { /* optional unsaved draft — see below */ }
}
```

## Response

```jsonc
{
  "operation": "GET /pets/{petId}",
  "pathParams": {"petId": "42"},
  "status": 200,
  "headers": {"content-type": "application/json", "x-mock-correlation": "path-params"},
  "mediaType": "application/json",
  "body": {"id": 42, "name": "aliquam"},
  "bodyEncoding": "json",          // json | text | base64 | empty
  "trace": { /* below */ },
  "chaos": {"suppressed": false, "delayMs": 0, "jitterMs": 0, "errorRate": 0},
  "draft": false
}
```

---

## The decision trace

Without it you can see *that* a value appeared but not *why*.

| `layer` | What produced the body |
|---|---|
| `scenario` | A scenario override. `scenario` names it; `ruleIndex` is the matched rule's **zero-based** index in the stored `rules` array (the response header `X-Mock-Scenario-Rule` stays one-based). |
| `stateful` | Session-scoped CRUD, because the request carried `X-Mock-Session`. |
| `correlation` | Correlation rewrote the default body. `correlationMode`, `correlationApplied` (the passes that bound) and `correlationPointers` (the explicit pointers written) say how. |
| `example` | An author-provided example, schema `example`, `default`, or first `enum` member. `bodySource` distinguishes them; `exampleName` names a `Prefer: example=` selection. |
| `synthesis` | No example was declared, so the body came from the response schema. `schemaValid` reports whether it validates. |
| `empty` | The matched response declares no body. |
| `forced-status` | `Prefer: code=` or `?__status=` pinned the status. |
| `request-invalid` | Request validation rejected the request (400/415). |
| `no-operation` | Nothing in the spec matches the path — a decision, **not** a 404 about a missing version. |
| `method-not-allowed` | The path exists but declares no operation for that method. |
| `unknown-scenario` | `X-Mock-Scenario` named a scenario this version does not define. |
| `not-acceptable` | No declared content type satisfies `Accept`. |
| `template-limit` | A template exhausted its render budget; the structured limit problem was served. |
| `lifecycle` | The reserved `__mock__` data-lifecycle endpoint answered. |

`seed` and `seedSource` (`request` · `correlation` · `default`) report the synthesis seed, so a body
that changes between previews is explainable.

---

## Previewing an unsaved draft

Send `settings` to render a configuration the version does not have. It overlays the stored
settings **per key**, so previewing a reworked correlation block keeps the version's scenarios:

```jsonc
{
  "settings": {
    "correlation": {
      "mode": "explicit",
      "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}}
    }
  },
  "request": {"path": "/pets/42"}
}
```

* A key the draft declares replaces the stored one; a key it omits keeps the stored value; an
  explicit `null` clears it.
* Draft keys are exactly the ones that travel in a bundle: `scenarios`, `chaos`, `fixturePacks`,
  `callbacks`, `correlation`. Access control (the private-mock `mode`) and the proxy-capture grant
  are hosted concerns with no meaning in a render.
* The draft is **canonicalized and validated with the same rules its save route applies**, so a
  block that could never be saved is a `422` here rather than a block that silently does nothing.
* Nothing is persisted. A follow-up `GET …/mock/correlation` shows the stored settings unchanged.
* `draft: true` in the response says an override was rendered.

Supplying `settings` requires `versions:edit` — it is the caller asserting a configuration the
version does not have.

---

## What a preview will not do

* **Write.** Session state lives and dies inside the render, so a stateful preview behaves but
  leaves the deployment's session store untouched. No callback is delivered, and no usage, audit or
  provisioning row is written.
* **Apply chaos.** A preview that slept for a configured latency, or that randomly answered 500,
  would be answering a different question. Configured chaos is *reported* instead:
  `chaos.suppressed` with the delay, jitter and error rate the data plane would have used.

---

## Errors

| Status | Meaning |
|---|---|
| `404` | The version does not exist in that project. A path that matches no operation is **not** a 404 — it comes back as a normal result with `trace.layer: "no-operation"`. |
| `413` | The synthetic request body exceeds `APIOME_MOCK_PREVIEW_MAX_BODY_BYTES` (default 256 KiB). |
| `422` | A draft override failed validation (`detail.errors`), or the runtime rejected the bundle (`detail.problems`). |
| `429` | The per-version preview rate limit is exhausted. |
| `502` | The mock runtime could not be reached. |
| `503` | Preview is not configured on this deployment. |

---

## Configuration

| Variable | Service | Meaning |
|---|---|---|
| `APIOME_MOCK_INTERNAL_BASE_URL` | apiome-rest | The mock service's **internal** address (e.g. `http://mock:8775`). Never the public one — the endpoint is server-to-server. |
| `APIOME_MOCK_INTERNAL_TOKEN` | apiome-rest **and** apiome-mock | Shared secret presented in `X-Internal-Service-Token`, compared in constant time. |
| `APIOME_MOCK_PREVIEW_TIMEOUT_SECONDS` | apiome-rest | Ceiling on one render round trip (default 10). |
| `APIOME_MOCK_PREVIEW_RATE_LIMIT_PER_MINUTE` | apiome-rest | Renders per version per minute (default 120). |
| `APIOME_MOCK_PREVIEW_MAX_BODY_BYTES` | apiome-rest | Largest synthetic request body (default 256 KiB). |

Both halves are required on the REST side; with either unset the endpoint fails closed with `503`.
On the mock side, an unset `APIOME_MOCK_INTERNAL_TOKEN` disables `/__preview__` entirely — it never
renders for an unauthenticated caller.

The token is deliberately **not** `INTERNAL_SERVICE_TOKEN` (the apiome-ui ↔ apiome-rest secret):
rendering a preview should not carry the secret that unseals auth-provider credentials.

---

## See also

* [Request-correlated responses](mock-response-correlation.md) — the configuration a preview most
  often exists to check.
* [Portable mock bundles](mock-bundle-format.md) — the document that crosses the internal hop.
