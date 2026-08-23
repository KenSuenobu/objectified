# How do I… lint & check quality?

Apiome computes a **server-side quality score** (an A–F grade out of 100) plus itemized lint
findings for a version. The score is computed on the server so the UI and the CLI always agree —
there is no client-side scoring to drift. Use it before cutting and publishing a version.

---

## In the UI

Open the **Designer** at `/ade/studio`; the quality grade and findings are shown for the version you
are editing. Fix the findings (most are missing descriptions) and the grade updates.

On the **Versions** screen (`/ade/dashboard/versions`) every revision row carries a grade chip
read from the stored score; click it to open the full report (fetched on demand).

## With the CLI

```bash
apiome lint --project <id-or-slug> --version <id-or-label>

# gate on a minimum grade (exit non-zero if below)
apiome lint --project <id-or-slug> --version <id-or-label> --min-grade B

# compare against a base version to surface breaking changes
apiome lint --project <id-or-slug> --version <id-or-label> --base-version <id-or-label>
```

`--min-grade` (A–F) makes the command suitable for CI gates; `--base-version` adds breaking-change
findings relative to that base.

## With the REST API

```http
GET /v1/versions/{tenant_slug}/{project_id}/{version_record_id}/lint?baseRevisionId=<optional>
X-API-Key: <your-api-key>
```

Returns the numeric score, the letter grade, and a list of findings (e.g. undocumented classes,
breaking changes when `baseRevisionId` is supplied). Every finding carries a stable `rule` id
attributable to the built-in rule catalog.

### When linting runs (and when it does not)

The report is **stored on the version record** and served from there — reading it does not
re-lint. Linting runs only on *version changes* and *imports*:

- **Import / conversion** — the score is captured onto the new revision when the job commits.
- **Push, fork, publish** — a new revision (push/fork) is scored right after it is created; the
  publish precheck stores the report it computes.
- **Content edits** — the stored report carries a fingerprint of the OpenAPI document it was
  scored from. When you next open the report after editing classes/properties, the server
  rebuilds the document, sees the fingerprint no longer matches, re-lints **once**, and stores
  the new report. Opening it again is a plain read.

The versions list (`GET /v1/versions/{tenant_slug}/{project_id}`) carries each revision's
stored `qualityScore` / `qualityGrade`, so the Versions screen renders every badge from the
record — a project with 50 revisions issues **zero** lint requests to render its list. A
revision that has never been scored shows *Lint —*; clicking it lints (and stores) the score on
demand. A `baseRevisionId` comparison is always computed live and never stored, since its
findings depend on the chosen base.

### List the built-in rule catalog

```http
GET /v1/lint/rules
X-API-Key: <your-api-key>
```

Returns every registered built-in rule with its stable id, pack, category, default severity,
one-line rationale, and a docs anchor into [lint-rules.md](lint-rules.md). Blocking (`error`)
rules also include reference, remediation, false-positive guidance, and corpus fixture ids
(CLX-4.3); so do the rules of the `data-contract` pack, which publishes its own remediation
and fixture for every rule even though none of them blocks. The catalog is the same for every
tenant; style guides layer per-tenant overrides on top of it.

### Data contracts score against their own rules

A catalog item imported from ODCS or dbt is a *data contract*, and its quality is a different
set of questions from an API description's. The `data-contract` pack asks them: is there a
reachable owner, a stated service level, a freshness expectation, a documented retention
window, are the columns described, is a row identifiable, are the columns that carry personal
data marked, is there a declared check on the ones that matter, is it versioned, does it say
whether it is draft or active, and does it say where it is served. Findings land in the
`governance` category and score the **supportability** axis (see
[axis-score.md](axis-score.md)).

The pack runs on the `data_schema` *paradigm* rather than on a format key, so a new
data-contract format is covered without a new pack — and it deliberately does **not** run for
a schema language (Avro, XSD, RELAX NG, CDDL, a Kafka Connect schema), which has no syntax in
which to state an owner or an SLA.

Every rule ships at `warning` or `info`: a rule pack does not get to fail every existing
item's gate on upgrade. A tenant that wants a data contract **required before publish**
enables the `data-contract.*` ids in a style guide at `error`, and assigns that guide to the
project — re-scoring under the guide is what makes the requirement binding.

Multi-axis evaluations display algorithm `clx-axis-v1` — see [axis-score.md](axis-score.md).
Scanner-evaluation corpus and adapter deprecation policy:
[scanner_evaluation.md](../../apiome-rest/docs/scanner_evaluation.md).

### Validate a custom-rule style guide

```http
POST /v1/lint/custom-rules/validate
X-API-Key: <your-api-key>
Content-Type: application/json

{"yaml": "rules:\n  servers-use-https:\n    description: Every server URL uses https.\n    given: \"$.servers[*].url\"\n    then: {function: pattern, functionOptions: {match: \"^https://\"}}\n"}
```

Strictly validates a [Spectral-compatible custom-rule guide](custom-rules.md) and echoes the
parsed rules; a malformed guide returns HTTP 422 with a pointer to the offending YAML node.

## Style guides govern every lint run

Every lint entry point — the editor/CLI lint above, the catalog item lint, the quality score
captured at import and conversion time, and the publish precheck — scores under the **style
guide** resolved for the run (GOV-1.4):

1. a guide **assigned to the project** wins, else
2. the guide **assigned tenant-wide**, else
3. the tenant's **default** guide (every tenant is seeded with the read-only
   *Apiome Recommended* guide, which mirrors the shipped rule defaults).

The applied guide governs which registered rules count and at what severity: findings for rules
the guide disables (or omits) are dropped, and each kept finding is weighted by the guide's
severity (`error` ≫ `warning` ≫ `info`) in the same capped scoring formula as always — so with
nothing assigned, scores and grades are exactly what they were before style guides existed.
Custom rules in the guide are evaluated against the raw document and their findings merged.
The lint response reports the applied guide in `guideId` / `guideName` / `guideSource`
(`builtin`, `custom`, or `fallback` for the in-code defaults) and, in `guideRevisionId`, the
[immutable revision](style-guide-revisions.md) of that guide the score was computed
against — so the result stays explainable after the guide is edited. At publish time the precheck also
computes the guide's **error-level violation count**, the signal the upcoming publish quality
gate (GOV-2.5) will enforce.

## Verify

The grade and findings returned by the CLI match what the UI shows for the same version — that
consistency is the point of server-side scoring.

## Related

- [lint-rules.md](lint-rules.md) — reference for every built-in lint rule (ids, severities, rationales)
- [custom-rules.md](custom-rules.md) — author your own rules in the Spectral-compatible DSL
- [edit-classes-and-properties.md](edit-classes-and-properties.md) — clear "missing description" findings
- [publish-a-version.md](publish-a-version.md) — publishing enforces its own gates on top of lint
