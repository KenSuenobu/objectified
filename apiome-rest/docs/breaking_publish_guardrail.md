# Breaking-publish guardrail (CTG-3.4, #4478)

CTG-3.1 (#4475) made breaking changes *visible* after publish. This guardrail makes them
*consequential* at publish time by answering one question:

> Does this revision break consumers **without** bumping the semver major?

Both halves matter. A breaking change shipped as `2.0.0` is a correct release; the same change
shipped as `1.4.1` is the semver violation that destroys consumer trust — and the platform
already knows it is breaking before the publish happens.

## How the verdict is reached

| Step | Source |
|---|---|
| Baseline | `get_prior_published_baseline_revision_id` — the previous **published** revision on the line, the same baseline CTG-3.1 classifies against |
| Breaking? | CTG-1.1 taxonomy (`classify_openapi_changes`) rendered through the CTG-1.3 changelog builder, so the guardrail lists exactly the changes the published changelog will list |
| Major bumped? | `app.semver_version.is_major_bump` over the two version labels |

The baseline is resolved **independently of the publish request's change-report baseline mode**,
so selecting `initial` cannot dodge the guardrail.

Version labels are free-form, so `is_major_bump` returns three answers: `true`, `false`, and
`null` (a label is not semver). `null` **warns but never blocks** — a tenant on a non-semver
versioning scheme has not committed a semver violation.

## Policy

The level is a **style-guide setting** (`style_guides.breaking_publish_policy`, migration V237)
resolved through the GOV-1.4 chain: project assignment → tenant assignment → tenant default.

| Level | Behavior |
|---|---|
| `off` | The guardrail never runs. |
| `warn` | **Default.** The publish dialog warns and lists the breaking changes; publish proceeds. |
| `block` | Publish is refused with `422` unless force-published with a reason (the GOV-2.5 pattern). |

Edit it at `PUT /v1/style-guides/{tenantSlug}/{guideId}/policy` with `breakingPublishPolicy`,
alongside the CLX-1.3 gates. Builtin guides are read-only, so escalating to `block` means
assigning a custom guide — the same rule every other guide setting follows. The level is frozen
into each `style_guide_revisions` snapshot (GOV-1.6), so an escalation is auditable history.

## Statuses

`status` is the single field a consumer needs; `triggered` and `blocked` are derived from it.

| Status | Meaning | Blocks? |
|---|---|---|
| `disabled` | Policy is `off`. | no |
| `no-baseline` | Initial publication — nothing to compare against. | no |
| `ok` | Not breaking, or breaking *with* a major bump. | no |
| `warning` | Breaking without a major bump under `warn`, or an unknown versioning scheme. | no |
| `blocked` | Breaking without a major bump under `block`. | **yes** |
| `unavailable` | The comparison could not be made (unbuildable spec, DB fault). | no |

A guardrail that failed closed on its own bugs would be worse than the semver violation it
guards against, so **every fault degrades to `unavailable`** and publishes proceed.

## Endpoints

### Preflight

```
GET /v1/versions/{tenantSlug}/{projectId}/{versionRecordId}/breaking-publish-guardrail
```

Read-only; nothing is published or stored. The publish dialog calls it before enabling Publish.

```json
{
  "policy": "block",
  "status": "blocked",
  "triggered": true,
  "blocked": true,
  "breaking": true,
  "majorBumped": false,
  "fromVersion": "1.4.0",
  "toVersion": "1.5.0",
  "baselineRevisionId": "…",
  "breakingChanges": [
    {
      "pointer": "/paths/~1owners",
      "ruleId": "path.removed",
      "pathGroup": "/paths/~1owners",
      "summary": "Path removed"
    }
  ],
  "breakingCount": 1,
  "truncated": false,
  "counts": { "breaking": 1, "non-breaking": 0, "docs-only": 0, "unclassified": 0, "total": 1 },
  "maxSeverity": "breaking",
  "recommendedVersion": "2.0.0",
  "detail": null,
  "message": "1 breaking change(s) versus 1.4.0 published as 1.5.0 without a major-version bump. Publish as 2.0.0 instead."
}
```

At most `MAX_LISTED_BREAKING_CHANGES` (50) changes are listed; `breakingCount` always reports
the true total and `truncated` says whether the list is complete.

### Publish

`POST …/publish` runs the guardrail in `enforce_publish_prechecks`, **after** the
`allowBreaking` compatibility gate — a publisher who has opted into shipping breaking changes is
exactly the one the semver guardrail exists for. Under `block` the publish is refused:

```json
{
  "detail": {
    "message": "… without a major-version bump. Publish as 2.0.0 instead. Bump the major version, relax the tenant breaking-publish policy, or force-publish with a reason.",
    "breakingPublishGuardrail": { "…": "the payload above" }
  }
}
```

Force-publishing (`skipPublishChecks: true` + `forcePublishReason`) gets past it, exactly as it
does for style-guide errors and verification policy.

## Audit trail

Every flagged publish appends one `workflow_audit` row with action
`version.breaking_publish_guardrail`:

```json
{
  "action": "forced",
  "reason": "Incident 4478 — consumers already migrated",
  "guardrail": { "…": "the full assessment payload" }
}
```

`action` is `warned` (the guardrail warned and the publish proceeded) or `forced` (a block was
force-published). The forced case is assessed *after* publish, since `skipPublishChecks` skips
the prechecks wholesale — which is precisely the case where the audit trail matters most.

## Modules

| Module | Responsibility |
|---|---|
| `app/breaking_publish_policy.py` | The `off`/`warn`/`block` vocabulary and its normalizer — dependency-free, so guide surfaces need not import the compatibility engine |
| `app/semver_version.py` | Version-label parsing shared with the browse version ordering |
| `app/breaking_publish_guardrail.py` | Policy resolution, assessment, payload |
| `app/version_publish_prechecks.py` | Runs the guardrail and raises the 422 |
| `app/versions_routes.py` | Preflight endpoint and the audit write |
