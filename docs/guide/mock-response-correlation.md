# Request-correlated mock responses

A mock that answers `GET /pets/42` with the spec example's id instead of `42` is not a usable
stand-in for the real API. **Response correlation** makes the default response path answer with the
request's own values — with no request header, so a generated SDK, a browser app, or any consumer
you do not control gets it too.

| | |
|---|---|
| Author | The **Correlation** editor on a version's mock cell, or `PUT /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/correlation` |
| Inspect | `GET /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/correlation` |
| Catalogue | `GET /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/operations` |
| Permission | `versions:edit` to save, `versions:view` to read |
| Storage | `versions.mock_settings.responseCorrelation` (travels inside portable bundles) |
| Producer | `app.mock_correlation` (apiome-rest) |
| Consumer | `apiome_mock.correlation` (apiome-mock ≥ 0.11.0) |

Correlation is **configuration on the version**, not an opt-in per request. That is the whole
point: scenario overrides need `X-Mock-Scenario` and stateful CRUD needs `X-Mock-Session`, and
neither header can be added to traffic you do not author.

---

## Block shape

```jsonc
{
  "correlation": {
    "mode": "inferred",                      // off | path-params | inferred | explicit
    "operations": {                          // optional explicit pointer map
      "GET /pets/{petId}": {
        "/id": "{{request.path.petId}}",     // response JSON Pointer -> template expression
        "/owner/ref": "{{request.query.owner}}"
      }
    }
  }
}
```

Omitting `correlation` (or sending `null`, or `{"mode": "off"}`) clears the stored block and
returns the version to static behaviour.

## Modes

| Mode | What binds |
|---|---|
| `off` (default) | Nothing. Byte-identical to a version with no block at all. |
| `path-params` | A response property whose name matches a path parameter takes the request's value, at every depth of the body and inside array members. |
| `inferred` | Everything `path-params` does, plus echoing request-body fields back on `POST`/`PUT`/`PATCH`. |
| `explicit` | Only the `operations` pointer map — no inference, for the cases where a guess would be wrong. |

The `operations` map is honoured in **every** mode except `off`, and always last: an explicit entry
wins over an inferred or path-parameter binding for the same pointer. The passes therefore compose
in the order `path-params` → `inferred` → `explicit`, and `mode` chooses which inference passes run
ahead of the map. Saving bindings alongside `mode: "off"` is refused rather than silently ignored —
they would never run.

### `path-params`

Name matching folds case and separators, and a parameter ending in `id` also claims the bare `id`
most response schemas actually use:

| Path parameter | Response properties it binds |
|---|---|
| `petId` | `petId`, `pet_id`, `Pet-Id`, `id` |
| `id` | `id` |
| `slug` | `slug` |

When several parameters would claim the bare `id` (`/users/{userId}/pets/{petId}`) the **last** one
wins — it addresses the resource the response is about.

A path value always arrives as text, so it is converted to the JSON type of the value it replaces
(`{"id": 1}` with `?petId=42` gives `42`, not `"42"`). A value that will not convert stays text —
and then trips the schema check below rather than disappearing. Container properties are never
clobbered.

```
GET /pets/42        ->  { "id": 42, "name": "Rex", "tags": [{ "petId": 42, "label": "good" }] }
```

### `inferred`

What you sent comes back, enriched — the Counterfact/Prism-shaped behaviour:

```
POST /pets  { "name": "Rex" }
         ->  { "id": 9, "name": "Rex", "createdAt": "2020-01-01T00:00:00Z" }
```

`id`, `createdAt`, `updatedAt` and `deletedAt` are **server-owned** and never echoed (a real server
would have overruled a client-supplied one), and any field absent from the request stays
synthesized. Objects align by name at each level. A response object that matches *nothing* in the
request is treated as an envelope (`{"data": {…}}`) and the same request is offered to its
children; once a level has matched something, unmatched siblings are left alone, so a nested
`owner` cannot silently inherit the top-level `name`. A shape disagreement (an object where a
scalar was sent) keeps the synthesized value.

To bind a server-owned field anyway, name it explicitly.

### `explicit`

Each entry is a response [RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) mapped to
one expression in the same bounded template language scenario responses use — see
[mock-callbacks.md](mock-callbacks.md) for the full expression grammar. `""` addresses the whole
body. Entries apply in stored order, so the outcome is deterministic.

A missing key on the pointer's **final** segment is created; an absent intermediate container or an
out-of-range array index leaves the body untouched, because inventing structure the schema does not
describe would turn one mistyped pointer into an invalid body. An unresolvable reference (a query
parameter that was not sent) binds `null`, never an error.

## Determinism

With correlation on, an unseeded request no longer synthesizes from a constant `0`: the seed is
derived from `(method, path template, path parameter values)`. So `GET /pets/42` and
`GET /pets/43` differ, while each is byte-stable across repeated calls and across deployments —
which is what lets a portable bundle in CI reproduce the hosted mock exactly. Query and header
values are deliberately excluded; a body that changed with every incidental query parameter would
make the mock useless as a fixture. An explicit `?__seed=` still wins.

## Precedence

Correlation runs **after** the default body is resolved and **before** the schema re-check. It is
what happens when nothing else applies:

```
scenario override (X-Mock-Scenario)   ─┐
stateful CRUD     (X-Mock-Session)    ─┤ still win
forced status     (Prefer: code= / ?__status=)
                                       │
default response path ──► correlation ──► schema re-check ──► response
```

## What the response tells you

| Header | Meaning |
|---|---|
| `X-Mock-Correlation` | The passes that bound something (`path-params`, `inferred, explicit`), or `none`. Absent when correlation is off. |
| `X-Mock-Schema-Valid` | `false` when the correlated body no longer matches the response schema, `true` when it does. Only set when a pass bound something. |

A drifted body is still **served** — refusing it would make the mock less useful than the static
one it replaces — but it is never served *silently*: the header reports it and the runtime logs
`mock.correlation.schema_drift` with the operation and the violation.

## Limits and leniency

* 200 operation entries per block, 50 pointer bindings per operation, 64 KiB canonical JSON.
* Explicit expressions draw from the same per-render CPU, output, and deadline budget every
  template does; exhausting it answers `500 Template Limits Exceeded` rather than hanging.
* Save time is strict: an unknown mode, an operation the spec does not have, a pointer that is not
  RFC 6901, and a malformed expression all fail with a `422` listing every error.
* Serve time is lenient: a malformed stored block is skipped, never raised, so a bad blob can only
  cost you correlation — never the mock.

## Authoring it in the ADE

Correlation is a per-version setting a version owner configures once and then trusts, so it has a
surface of its own rather than a JSON textarea: **Correlation**, beside *Scenarios* on the version's
mock cell.

* **Mode cards** say what each mode does to a *response*, not what it is called.
* Under `path-params` and `inferred`, a **read-only bindings preview** lists, per operation, which
  response properties would take which request values — *before* anything is saved. It comes from
  `GET .../mock/operations`, which projects the same name-matching rules the runtime applies
  (`app.mock_correlation_rules`, imported by `apiome_mock.correlation`) over the response **schema**
  instead of a response body. Two limits follow from that and are reported rather than hidden: a
  pointer inside an array names member `0` and is flagged as repeating (the runtime binds every
  member), and a `oneOf`/`anyOf` schema is projected through its first branch.
* **Explicit bindings** are rows — pick the operation, point at a response property, insert a token
  — with the operation list, the pointer suggestions and the `{{request.*}}` / `{{fixture.*}}` token
  picker all drawn from what this version actually has. A save-time `422` attaches to the row that
  caused it.
* **Try it** renders a synthetic request against the settings on screen through the dry-run preview
  ([mock-response-preview.md](mock-response-preview.md)), so changing the mode changes the answer
  without a save.

The same token picker and live preview are on the scenario editor, since it is the same template
engine. Raw-JSON editing of match rules stays as the escape hatch there until a rule builder is
scoped separately.

The catalogue route is read-only, needs `versions:view`, and answers for a version whose mock is
switched off — which is when correlation is usually configured for the first time.

## Portability

`responseCorrelation` is one of the bundled settings keys
([mock-bundle-format.md](mock-bundle-format.md)), so a bundle exported from a correlated version
correlates identically offline. The shipped conformance corpus asserts it: four of its cases drive
correlation with no headers at all, and the PMR-3.1 parity harness diffs the hosted and portable
answers response by response.

## See also

* [mock-fixture-packs.md](mock-fixture-packs.md) — the fixture data `{{fixture.*}}` expressions read
* [mock-callbacks.md](mock-callbacks.md) — the same template language, on the outbound half
* [mock-bundle-format.md](mock-bundle-format.md) — what travels offline
* [mock-response-preview.md](mock-response-preview.md) — the dry-run render behind the editor's *Try it*
