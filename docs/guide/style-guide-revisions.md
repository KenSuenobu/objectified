# Style-guide revisions & governance audit

> **GOV-1.6 (#4432).** A style guide is edited in place, so a lint score recorded last month
> names the guide that produced it but not *what that guide contained*. Every edit now appends
> an **immutable revision**, every lint result **pins** the revision it ran against, and
> create / edit / assign land in the tenant's **audit ledger** — which is what a compliance
> narrative ("this version was published under revision 4 of *Payments Guide*") needs.

## What produces a revision

Each of these appends one write-once row to the guide's history:

| Change | `changeKind` |
|---|---|
| Guide created (including duplicate / "start from Recommended") | `created` |
| Rename, description, external validation profile | `edited` |
| Rule-catalog save (`PUT …/rules`) | `rules_changed` |
| Custom-rules save (`PUT …/custom-rules`) | `custom_rules_changed` |
| Policy-gate save (`PUT …/policy`) | `policy_changed` |
| Rules taken from an imported ruleset | `imported` |

A save that changes nothing appends nothing — the history is real changes, not save-button
presses. **Assigning** a guide (tenant default, or to a project) is *not* a revision: it changes
no guide content. It is an audit event.

Each revision freezes the guide's name, description, external lint profile, every rule row
(enable flag, severity, custom definition) and its policy gates, plus who made the change.

## Reading the history

```bash
# Newest first
curl -H "Authorization: Bearer $TOKEN" \
  https://<host>/v1/style-guides/acme/$GUIDE_ID/revisions

# One revision, with the rules it froze
curl -H "Authorization: Bearer $TOKEN" \
  https://<host>/v1/style-guides/acme/$GUIDE_ID/revisions/$REVISION_ID
```

```json
{
  "guideId": "…", "guideName": "Payments Guide", "count": 2,
  "revisions": [
    {"id": "…", "revisionNumber": 2, "changeKind": "rules_changed",
     "name": "Payments Guide", "ruleCount": 37, "enabledRuleCount": 31, "customRuleCount": 2,
     "contentFingerprint": "9f2c…", "snapshotFingerprint": "41ab…",
     "actorLabel": "ada@example.com", "createdAt": "2026-08-01T18:55:34Z"}
  ]
}
```

The single-revision response adds `rules` (the frozen rows) and `policy` (the frozen gates).
Both endpoints are readable by **any tenant member** — compliance review is not an admin-only
activity. Mutating a guide still requires a tenant administrator.

Two fingerprints, two jobs:

* `contentFingerprint` — SHA-256 of the **rule rows alone**. It is byte-identical to the
  fingerprint the linter stamps on the guide it compiled, which is how a lint result resolves
  its revision.
* `snapshotFingerprint` — SHA-256 of the **whole snapshot** (identity + rules + gates). Equal to
  the previous revision means the edit changed nothing, so no revision is appended.

## Pinning a lint result to a revision

A lint report carries the revision that scored it:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://<host>/v1/versions/acme/$PROJECT_ID/$VERSION_RECORD_ID/lint"
```

```json
{"score": 88, "grade": "B",
 "guideId": "…", "guideName": "Payments Guide", "guideSource": "custom",
 "guideRevisionId": "…"}
```

Follow `guideRevisionId` to the revision endpoint and you get the exact ruleset behind the
score, however the live guide has changed since. The same pin is stored on the immutable lint
evidence rows (`guideRevisionId` in `GET …/lint/evidence`), so captured import-time scores are
explainable too, not just live recomputes.

`guideRevisionId` is `null` when no stored guide governed the run — a tenant with no assigned
guide lints under the in-code defaults, and there is no stored guide to have a revision of.

### Guides that predate this feature

History is captured lazily and self-heals: the first time a guide's history is read, edited, or
linted under, its current state is recorded as revision 1. Every edit path captures the
**pre-edit** state first, so the state an edit replaces is preserved even for guides created
before GOV-1.6.

## Audit events

Guide governance writes into the tenant's existing hash-chained access ledger, under the
`style_guide.` action prefix:

| Action | Emitted by |
|---|---|
| `style_guide.created` | `POST /v1/style-guides/{tenant}` |
| `style_guide.updated` | `PATCH /v1/style-guides/{tenant}/{guideId}` |
| `style_guide.deleted` | `DELETE /v1/style-guides/{tenant}/{guideId}` |
| `style_guide.rules_updated` | `PUT …/{guideId}/rules` |
| `style_guide.custom_rules_updated` | `PUT …/{guideId}/custom-rules` |
| `style_guide.policy_updated` | `PUT …/{guideId}/policy` |
| `style_guide.assigned` | `PUT …/{guideId}/default`, `PUT …/{guideId}/assignments/projects/{projectId}` |
| `style_guide.unassigned` | `DELETE …/assignments/projects/{projectId}` |

Read them alongside every other governance change, or on their own:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://<host>/v1/access/acme/audit?filter=styleGuide"
```

Only changes that actually happened are recorded: a request that 404s or is rejected emits no
event. Deleting a guide cascades its revisions away, so the ledger — which keeps the guide's
name — is what remains as evidence the guide existed.

## Verify

1. **Edit** a guide's rules (`PUT …/rules`), then **GET** `…/revisions` — a `rules_changed`
   entry appears above the previous one, with your email as `actorLabel`.
2. **Save the same rules again** — no new entry: nothing changed.
3. **Lint** a revision of a project the guide governs and note `guideRevisionId`; **GET** that
   revision and confirm its `rules` are the ones you saved.
4. **Rename** the guide, lint again, and fetch the *old* revision — it still reports the old
   name and the old rules.

## Related

* [Lint & quality scoring](lint-and-quality.md) — where the score comes from.
* [Built-in lint rules](lint-rules.md) and [custom lint rules](custom-rules.md) — what a guide
  is made of.
* [Importing a Spectral ruleset](spectral-import.md) — how org standards arrive.
