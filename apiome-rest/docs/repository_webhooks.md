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

* **Changeable only by rotation.** A database trigger refuses any UPDATE that changes
  `secret_enc` other than as a well-formed rotation — one that simultaneously carries the
  outgoing secret into `previous_secret_enc` and attaches a deadline to it (see below). It
  also refuses any UPDATE that would repoint a subscription at another repository or tenant,
  or rewind its rotation count.
* **Never returned.** No REST response carries it. The subscription projection carries a
  truncated SHA-256 `secretFingerprint`, which lets an operator confirm the provider holds
  the same secret without either side revealing it.
* **No key configured?** `secret_enc` is NULL and every delivery for that repository is
  rejected. Verification fails closed rather than accepting on trust.

## Rotating the signing secret

REPO-4.7 (#2785). A secret that has been in a provider's hook configuration since the
repository was registered is an audit finding waiting to be written down, and the only safe
way to change one is to have two of them for a while:

```
POST /v1/tenants/{tenant}/repositories/{repositoryId}/webhook/rotate
{ "graceSeconds": 86400 }        // optional; the deployment default is 24h
```

1. A new secret is minted and stored, **carrying the outgoing one into a grace window** in the
   same statement. There is no statement in the system that can replace a secret without
   leaving the displaced one verifying.
2. The provider's hook is updated to the new secret. This needs a linked-account token with
   `admin:repo_hook` and a configured `APIOME_REPOSITORY_WEBHOOK_BASE_URL`; when it succeeds,
   `providerSecretSynced` is true and the window is belt-and-braces.
3. **Both secrets verify** until the window closes. A delivery signed with the outgoing secret
   is accepted, and the acceptance audit records `secretGeneration: "previous"` so "the
   provider is still on the old secret" is visible while there is time to act.
4. When the window closes, a background sweep clears the outgoing secret. From that moment a
   delivery signed with it is a `401` like any other bad signature.

The database is written **before** the provider, deliberately. The other order has a failure
mode nothing can rescue — a provider signing with a secret this deployment never stored — while
this order's worst case is a provider still signing with the outgoing secret, which verifies
for the whole window.

The response and the status view carry no secret, only fingerprints:

| Field | Meaning |
|---|---|
| `secretFingerprint` | The current secret. |
| `previousSecretFingerprint` | The outgoing secret, while its window is open. |
| `previousSecretExpiresAt` | When the outgoing secret stops verifying. |
| `providerSecretSynced` | Whether the provider's hook holds the *current* secret. |
| `rotationError` | Why it does not, when it does not. |
| `rotationCount` | How many times this subscription has been rotated. |

`providerSecretSynced: false` with a near `previousSecretExpiresAt` is the state that needs an
operator: the provider is still signing with a secret that is about to be retired. The sweep
retries the provider update on every tick for as long as the window is open, so a token
re-linked with `admin:repo_hook` fixes it without a second rotation.

Every rotation writes a `repository.webhook_secret_rotated` audit row (naming both secrets by
fingerprint, plus the deadline), and every expiry writes
`repository.webhook_secret_rotation_expired`.

Rotation is refused, with nothing changed, when the deployment has no encryption key or the
subscription never held a secret — storing a NULL ciphertext would take a working endpoint to
rejecting every delivery.

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
| `APIOME_REPOSITORY_WEBHOOK_SECRET_GRACE_SECONDS` | `86400` | Default rotation grace window — how long the outgoing secret keeps verifying. |
| `APIOME_REPOSITORY_WEBHOOK_SECRET_MIN_GRACE_SECONDS` | `300` | Floor for a requested window. Zero would make rotation a hard cutover. |
| `APIOME_REPOSITORY_WEBHOOK_SECRET_MAX_GRACE_SECONDS` | `604800` | Ceiling for a requested window. A retired secret that verifies for a month is the finding rotation exists to close. |
