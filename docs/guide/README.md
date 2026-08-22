# Apiome — User Guide

This is the user-facing documentation set for the Apiome **spine**: the end-to-end path that
takes a specification from import to a published, queryable API surface.

> **Spine in one line:**
> `import OpenAPI → edit a class & a path → lint → cut a version → publish → view in browse →
> export via CLI → query via MCP`

If you only read one other page first, read the project [README](../../README.md) ("Your first
project in ~10 minutes") and the [Golden Path](../GOLDEN_PATH.md) (the executable definition of
"the product works").

---

## How do I…? — one page per spine capability

| Capability | Guide | UI | REST |
|---|---|---|---|
| **See every supported format** (generated from the registries) | [supported-formats.md](supported-formats.md) | `/ade/dashboard/catalog` | `GET /v1/formats/matrix` |
| Import a spec (46<!--format-count:importable--> formats; Projects vs Catalog) | [import-a-spec.md](import-a-spec.md) | `/ade/studio` | `POST /v1/tenants/{tenant}/imports` |
| Edit classes & properties | [edit-classes-and-properties.md](edit-classes-and-properties.md) | `/ade/studio` | `PUT /v1/classes/{tenant}/{class_id}` |
| Edit paths & operations | [edit-paths.md](edit-paths.md) | `/ade/studio/paths` | `PUT /v1/paths/{tenant}/{version}/{path_id}` |
| Lint & quality scoring | [lint-and-quality.md](lint-and-quality.md) | `/ade/studio` | `GET /v1/versions/{tenant}/{project}/{version}/lint` |
| Axis score algorithm (`clx-axis-v1`) | [axis-score.md](axis-score.md) | Lint axes panels | `GET …/lint/axes` |
| Cut a version | [cut-a-version.md](cut-a-version.md) | `/ade/dashboard/versions` | `POST /v1/versions/{tenant}/{project}` |
| Publish a version | [publish-a-version.md](publish-a-version.md) | `/ade/dashboard/versions` | `POST /v1/versions/{tenant}/{project}/{version}/publish` |
| Browse published specs | [browse-published-specs.md](browse-published-specs.md) | `/ade/dashboard/published` | `GET /v1/browse/tenants/{tenant}/projects` |
| Export / download a spec | [export-a-spec.md](export-a-spec.md) | `/ade/dashboard/published` | `GET /v1/schema/{tenant}/{project}/{version}` |
| Understand export fidelity (projection map, reasons, acknowledgement) | [export-fidelity.md](export-fidelity.md) | `/ade/dashboard/export/studio` | `POST /v1/export/{tenant}/projection-evidence` |
| Read a catalog item's format details (X12, COBOL copybooks, statuses, redaction) | [catalog-format-details.md](catalog-format-details.md) | `/ade/dashboard/catalog` | `GET /v1/catalog/{tenant}/{item}/analysis` |
| Convert a catalog item to OpenAPI (projection graph, reasons, evidence history) | [convert-to-openapi.md](convert-to-openapi.md) | `/ade/dashboard/catalog` | `POST /v1/catalog/{tenant}/{item}/convert` |

## References & quick-starts

| Topic | Guide |
|---|---|
| **API reference** (interactive Swagger UI for the REST API) | [api-reference.md](api-reference.md) |
| **Built-in lint rules** (stable ids, severities, rationales — `GET /v1/lint/rules`) | [lint-rules.md](lint-rules.md) |
| **Custom lint rules** (Spectral-compatible DSL — `POST /v1/lint/custom-rules/validate`) | [custom-rules.md](custom-rules.md) |
| **Spectral ruleset import** (`.spectral.yaml` → built-ins + custom rules — `POST /v1/lint/custom-rules/import`) | [spectral-import.md](spectral-import.md) |
| **Schematron import** (`.sch` rule set → a governance style guide — `POST /v1/lint/schematron/import`) | [schematron-import.md](schematron-import.md) |
| **Style-guide revisions & audit** (immutable guide history, lint results pinned to a revision — `GET /v1/style-guides/{tenant}/{guide}/revisions`) | [style-guide-revisions.md](style-guide-revisions.md) |
| **Portable mock bundles** (offline, signed, version-pinned mock runtime — `GET …/mock/bundle`) | [mock-bundle-format.md](mock-bundle-format.md) |
| **Portable mock runtime** (`apiome mock run`, official image, readiness, structured logs, conformance) | [portable-mock-runtime.md](portable-mock-runtime.md) |
| **Mock fixture packs** (versioned seed data, digests, `__mock__/session/reset` lifecycle) | [mock-fixture-packs.md](mock-fixture-packs.md) |
| **Mock CI action** (start a pinned mock in a job, service URL, digests, auto-cleanup) | [mock-action/README.md](../../mock-action/README.md) |
| **CLI** quick-start (`apiome …`) | [cli-quickstart.md](cli-quickstart.md) |
| **CI contract gate** (GitHub Action `apiome/diff-action`) | [ci-diff-gate.md](ci-diff-gate.md) |
| **CI contract gate on GitLab & Bitbucket** (container image + copy-paste pipelines) | [ci-gitlab-bitbucket.md](ci-gitlab-bitbucket.md) |
| **MCP** setup quick-start (Claude Desktop / IDE hosts) | [mcp-quickstart.md](mcp-quickstart.md) |

---

## Before you start

Bring the local spine up with Docker and load the dev seed (the `acme-corp` tenant and the published
`petstore-sample` project):

```bash
docker compose up --build --wait      # postgres, migrate, seed, rest (:8000), mcp (:8765)
docker compose run --rm seed          # idempotent; ensures the dev tenant + sample exist
```

Then sign in to the UI with the dev login `ada@example.com` / `apiome-dev` and open **Control
Panel → Dashboard**. The default service ports are:

| Service | URL |
|---|---|
| REST API | `http://localhost:8000` (interactive docs at `/docs`) |
| MCP server | `http://localhost:8765` (MCP endpoint at `/mcp`) |
| UI | the Next.js app (`/ade/dashboard`, `/ade/studio`) |

Every how-to page below shows the **UI**, **REST**, and (where applicable) **CLI** way to do the
same thing, plus a short *verify* step. Depth grows post-RC — this set is intentionally lean.
