# Evidence-backed verification policy — ECA-3.1 (#4734)

> Status: **Shipped.** Turns ECA-1.3 verification runs (and CTG-3.1 whole-spec publish
> classification) into an auditable publish/deploy decision that cites exact evidence IDs.
> The dashboard and API return the **same** decision payload — the server owns the verdict.

## Problem

A verification result is not useful as a release control until policy can evaluate freshness,
required suite digests, and breaking-change posture, then point at the exact evidence it used.

## What the policy says

Per tenant (append-only versions; highest `version_number` is in force):

| Field | Default | Meaning |
|---|---|---|
| `requiredSuiteDigests` | `[]` | ECA-1.1 digests (`sha256:<64 hex>`) that need a recent **passing** run |
| `maxEvidenceAgeSeconds` | `null` | Freshness ceiling; `null` = no age gate |
| `requiredTargetNetworkClass` | `null` | Optional `public` / `private` filter on cited evidence |
| `purpose` | `both` | `publish`, `deploy`, or `both` |
| `breakingChangeAction` | `warn` | Whole-spec breaking via `version_changelogs.max_severity` (#4475): `ignore` / `warn` / `block` |
| `enforcement` | `advisory` | `advisory` reports failures; `block` refuses publish when evaluate fails |

A tenant with **no** saved row runs the documented default — upgrade changes no behaviour.

## Gates

Every evaluate produces `gateResults`:

1. **`suite_digest`** — each required digest must have a newest passing `verification_run`.
2. **`evidence_age`** — that cited run must be no older than `maxEvidenceAgeSeconds`.
3. **`breaking_change`** — when changelog `max_severity` is `breaking`, apply the policy action.

Cited run IDs land in `evidenceRunIds`. Every evaluate persists a
`verification_policy_evaluations` row and writes `governance.verification_policy.evaluate`
to access audit.

## Not consumer-aware (yet)

Breaking findings here are **whole-spec** (#4475). Consumer registry / per-consumer
acknowledgment (#4479 / #4480) and the CTG-3.4 semver guardrail (#4478) are follow-ups.
`gateResults[].detail.consumerAware` is always `false` so callers do not mistake this for
consumer impact.

## API

| Method | Path |
|---|---|
| `GET` | `/v1/tenants/{slug}/governance/verification-policy` |
| `PUT` | `/v1/tenants/{slug}/governance/verification-policy` |
| `GET` | `/v1/tenants/{slug}/governance/verification-policy/versions` |
| `POST` | `/v1/tenants/{slug}/governance/verification-policy/evaluate` |
| `GET` | `/v1/tenants/{slug}/governance/verification-policy/evaluations` |

Evaluate body:

```json
{
  "purpose": "publish",
  "projectSlug": "payments",
  "versionSlug": "1.2.0"
}
```

Decision (camelCase — identical for UI and CI):

```json
{
  "passed": false,
  "enforcement": "block",
  "policyVersionId": "...",
  "evaluationId": "...",
  "evidenceRunIds": ["..."],
  "gateResults": [
    {"gate": "suite_digest", "passed": true, "detail": {}},
    {"gate": "breaking_change", "passed": false, "action": "block", "detail": {}}
  ],
  "warnings": [],
  "purpose": "publish",
  "skipped": false
}
```

## Publish wiring

`enforce_publish_prechecks` evaluates with `purpose=publish` after existing style-guide and
legacy compatibility checks. When `enforcement=block` and `passed=false`, publish answers
**422** with `verificationPolicyDecision` in the detail. Force publish
(`skipPublishChecks`) continues to bypass, already audited.

## Storage

* `apiome.verification_policies` — V213, append-only, immutable UPDATE trigger
* `apiome.verification_policy_evaluations` — V213, append-only audit of decisions

## Modules

| Module | Role |
|---|---|
| `app.verification_policy` | Policy body, defaults, fingerprint |
| `app.verification_policy_evaluate` | Pure evaluator (no DB) |
| `app.verification_policy_store` | Load / save / evaluate-and-record |
| `app.verification_policy_routes` | HTTP surface |
| `app.version_publish_prechecks` | Publish gate |
