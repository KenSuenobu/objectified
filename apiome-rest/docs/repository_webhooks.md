# Repository webhooks (push / PR ingestion)

REPO-4.3 (#2781). Polling has a floor: `APIOME_REFRESH_MIN_INTERVAL` bounds how often the
auto-refresh sweep looks at anything, and a repository's own `refresh_interval_seconds` is
usually minutes or hours. A webhook removes that wait for the pushes a provider tells us
about — the repository becomes due immediately.

A webhook is an **accelerator on the cadence, not a second way into the catalog**. Every
delivery is routed through the same scan and refresh workers a scheduled poll uses, so the
freshness comparator, the divergence guard, per-tenant quotas and the global kill switch all
still apply.

## Delivery pipeline

```
provider push ──► POST /v1/repositories/webhook/{provider}
              ──► resolve repository by (provider, owner/name)
              ──► verify HMAC over the RAW body against that repository's secret
              ──► tracked branch?  ──► queue a branch scan + mark the repo poll-due
                                   └─► next refresh sweep tick re-imports what is stale
```

`{provider}` is one of `github`, `gitlab`, `bitbucket`.

## Signature schemes

The endpoint carries no bearer token — a provider cannot hold one — so the signature *is*
the authentication. Each provider's standard scheme is used:

| Provider | Header | Scheme |
|---|---|---|
| `github` | `X-Hub-Signature-256` | `sha256=` + HMAC-SHA256 of the raw body |
| `gitlab` | `X-Gitlab-Token` | the shared secret token, compared constant-time |
| `bitbucket` | `X-Hub-Signature` | `sha256=` + HMAC-SHA256 of the raw body |

Verification always runs over the **exact received bytes**, never a re-serialisation of the
parsed JSON, and always fails closed: a missing secret, a missing or malformed header, an
unknown provider and a genuine mismatch are indistinguishable failures.

## Status codes

| Code | When |
|---|---|
| `200` | Accepted. Includes deliberately ignored deliveries (a ping, a tag push, an untracked branch) — the provider must stop retrying something that is working as intended. |
| `400` | The body is not a JSON object, or names no repository, or the provider is unsupported. |
| `401` | The signature did not verify for a repository registered here. Written to the audit trail as `repository.webhook.rejected`. |

A delivery naming a repository nobody has registered is a `200`-ignored, not a `401`:
answering "do you track this repository?" for an unsigned POST would be an enumeration
oracle.

## What a delivery triggers

**Push on a tracked branch** — a branch with a stored import spec, since a branch nobody has
imported from has nothing to refresh:

1. a branch scan job is queued, collapsed onto any in-flight scan of the same branch so a
   ten-commit push is one walk rather than ten; and
2. the repository's cadence anchor and backoff deferral are cleared, so the refresh sweep
   picks it up on its next tick.

A push deliberately **cannot** re-enable a repository whose tenant turned auto-refresh off,
and cannot un-pause one the failure backoff auto-paused. Both remain the operator's to lift.

**Pull request** — opt-in per subscription (`prPreviewEnabled`) and per deployment
(`APIOME_REPOSITORY_WEBHOOK_PR_PREVIEW`). An actionable PR event (`opened`, `reopened`,
`synchronize`, …) against a tracked *base* branch queues a scan of the PR **head branch**, so
the specs a review touches are indexed before the merge. The head commit SHA is recorded on
the delivery row. This path only ever indexes: no import spec targets a PR head, so no scan
of one can produce a version, and the repository is never made poll-due by a PR.

A PR whose head lives in a fork is recorded and skipped — that branch is not in this
repository's tree, so the walker cannot reach it under the repository's own credentials.

## The signing secret

Each repository gets its own 256-bit secret, minted at registration time and stored Fernet-
encrypted (`APIOME_WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEY`) in
`apiome.repository_webhook_subscription`.

* **Write-once.** A database trigger refuses any UPDATE that would change `secret_enc` once
  it is set, or repoint a subscription at another repository or tenant. Rotation is
  delete-and-recreate, which is visible in the ledger.
* **Never returned.** No REST response carries it. The subscription projection carries a
  truncated SHA-256 `secretFingerprint`, which lets an operator confirm the provider holds
  the same secret without either side revealing it.
* **No key configured?** `secret_enc` is NULL and every delivery for that repository is
  rejected. Verification fails closed rather than accepting on trust.

## Registration

Provisioning runs on the repository-registration path. Minting and storing the secret always
happens. Asking the provider to create the hook is best-effort and honestly reported in
`registrationState`:

| State | Meaning |
|---|---|
| `registered` | The provider confirmed a hook; `providerHookId` is its identifier. |
| `local` | We hold a secret and will honour signed deliveries, but nobody has pointed the provider at us. |
| `failed` | The provider refused; `registrationError` says why (usually a token without `admin:repo_hook`). |

Automatic hook creation needs a linked-account token *and*
`APIOME_REPOSITORY_WEBHOOK_BASE_URL`; a repository registered from a public URL has no token
and stays `local`. Registering a repository never fails because a hook could not be created.

Because acceptance criterion 4 keeps the secret out of every REST response, a `local`
subscription cannot be completed by an operator pasting the secret into the provider — there
is nothing to paste. The route to an attached hook is to re-register the repository from a
linked account whose token carries `admin:repo_hook`, which lets the server create the hook
and hand over the secret directly. Until then the repository syncs on its polling cadence,
exactly as it did before.

## Inspecting deliveries

```
GET /v1/tenants/{tenant}/repositories/{repositoryId}/webhook?limit=20
```

Returns the subscription projection (state, hook id, fingerprint, endpoint URL, signature
header, counters) and the recent delivery ledger. Every delivery is recorded — accepted,
ignored, duplicate, and rejected — in the append-only `apiome.repository_webhook_event`
table, which carries no secret material of its own.

Redelivery is a no-op: a unique index on `(subscription_id, delivery_id)` makes a second
delivery of the same provider delivery id collide, and it is reported as `duplicate` rather
than queuing a second scan.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `APIOME_REPOSITORY_WEBHOOK_ENABLED` | `true` | Kill switch. When false a delivery is accepted (so the provider stops retrying), recorded, and dispatches nothing. |
| `APIOME_REPOSITORY_WEBHOOK_PR_PREVIEW` | `true` | Deployment-wide gate on PR preview scans; overrides the per-subscription flag. |
| `APIOME_REPOSITORY_WEBHOOK_BASE_URL` | *(unset)* | Public base URL deliveries arrive at, e.g. `https://api.apiome.dev`. Required to auto-create a provider hook and to show an operator the URL to paste. |
| `APIOME_WEBHOOK_SIGNING_SECRET_ENCRYPTION_KEY` | *(unset)* | Fernet key protecting the stored secrets. Without it, verification fails closed. |
