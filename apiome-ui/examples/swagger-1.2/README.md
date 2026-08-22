# Swagger 1.2 — `swagger-1.2`

Fixtures for the Swagger half of **FMT-3.6** ([#5431](https://github.com/apiome/apiome/issues/5431)).
Swagger 1.2 is a *resource listing* plus one *API declaration* per resource — a fileset, not a single
document — with `models` instead of `definitions`, `nickname` instead of `operationId`, and
`subTypes`/`discriminator` instead of `allOf`. The `openapi` adapter reads it by projecting onto the
Swagger 2.0 document shape (`apiome-rest/src/app/swagger12_projection.py`), so these entries are owned
by `adapter_key: openapi` and normalize to a `swagger-2.0` canonical model.

**Detection marker.** Top-level `"swaggerVersion": "1.2"` (a resource listing also has `apis[].path`
with no `operations`; a declaration has `basePath` + `resourcePath`).

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-declaration.json` | minimal | One resource, one GET, no models. |
| `02-typical-orders-declaration.json` | typical | Query/path/body parameters, `responseMessages` with `responseModel`, four models. |
| `03-composition-model-subtypes.json` | composition | `subTypes` + `discriminator` — 1.2's inheritance, which must project onto the same canonical shape 2.0 `allOf` produces. |
| `04-stress-parameter-and-auth-forms.json` | stress | Every `paramType` (query/path/header/form/body), `allowMultiple`, `File`, and the full `authorizations` block with OAuth2 grant types and scopes. |
| `05-petstore-set/` | multi-file | The real 1.2 shape: `api-docs.json` resource listing plus two declarations, imported as one API. |
| `06-real-world-user-directory.json` | real-world | A directory service with three resource paths, cursor paging and an API-key authorization. |
| `negative/` | — | An unclosed `apis` array, an empty resource listing, truncation, a SOAP description, UTF-16, and a listing whose declaration is missing (the case FMT-3.6 names explicitly). |

**Contract the adapter meets.** A resource listing plus its declarations imports as **one** API,
projected onto the existing Swagger 2.0 canonical path, with the source version recorded in the
canonical model's `swagger_1_2` extras. No new registry key — this is a version extension inside the
OpenAPI adapter, declared as `swagger-1.2` in its version coverage.

**Two negatives differ from the staged intent, deliberately.** `01` was authored as an *unquoted JSON
key*, which is valid YAML — and the intake loader falls back to YAML — so it was not a syntactic
failure at all; it now leaves the `apis` array unclosed, which neither parser accepts. `04` was
authored as a Swagger **2.0** document, which cannot be a wrong-format negative here: the same adapter
reads 1.2 and 2.0, so a 2.0 upload imports rather than failing. That routing is asserted directly in
`apiome-rest/tests/test_swagger_1_2_import.py`, and the fixture now carries a SOAP description.
