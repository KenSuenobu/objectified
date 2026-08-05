# Apiome 07-2026 RC4

We continue to improve the platform based on your feedback with improvements and new features!

---

## Features/Improvements

- Import: Arazzo workflow documents now import as first-class Workflow and Workflow Step entities; each step's `operationRef`/`operationId` links to the matching operation when that OpenAPI spec was imported in the same scan, and an unresolved reference keeps its raw value with a warning instead of being dropped
- Repository: specs that reference schemas on external hosts are now governed by a per-tenant policy — `block` (the default; nothing is fetched and the file is flagged with exactly which references are missing), `inline` (permitted references are fetched once and snapshotted into the scanned spec), or `proxy-fetch` (the same, restricted to an allowlist of hostnames, wildcards like `*.acme.com` included). Every fetch is recorded in the audit trail
- Repository: registered repositories now accept signed webhook deliveries, so a push to a branch you import from makes the repository due for a refresh immediately instead of at the end of its polling interval. Pull-request events can additionally index the PR's head branch so you can inspect the specs a review touches before it merges. Each repository gets its own signing secret, and the delivery history — including anything that failed to verify — is visible per repository
- Repository: a repository's webhook signing secret can now be rotated without a break in service — the new secret is installed at the provider, the old one keeps working for a grace window (24 hours by default) so deliveries already in flight still arrive, and it then expires on its own. If the provider could not be updated, the repository says so, and how long is left before deliveries start failing
- Repository: a new **Spec catalog** (Repositories → Spec catalog) lists every discovered spec across *all* your repositories in one searchable table. Search by path, format, repository or project; filter by format, repository, project, or status (needs attention / imported / mapped / discovered); sort by any of them. Each row links straight to that spec's detail view on its own repository, and the whole view lives in the URL, so a filtered catalog is a link you can paste to a colleague. Paging is server-side and stays fast on workspaces with tens of thousands of files
- Repository: every repository now carries a **health badge** — healthy, warnings or error — on the repositories list and on the repository detail header. It rolls up how many scans succeeded over the last 30 days, how many discovered specs failed to parse, and whether the linked account's access token is still good. Hover it and the tooltip leads with the most recent thing that went wrong, so you can see *what changed* without opening the repository. A credential problem never shows as healthy, however clean everything else is
- Repository: your webhook channels are now told when a repository needs attention — when auto-refresh pauses itself after repeated failures, when a sync introduces a breaking change, and when a repository has been failing for a while but has not paused yet. Each repository can opt out of each of those individually, and any one of them is sent at most once an hour per repository, so a repository stuck in a failure loop cannot flood the channel. A channel pointed at a Slack incoming webhook receives a proper Slack message rather than raw JSON
- Repository: repository polling now has a per-tenant hourly ceiling (60 by default, 600 on the elevated plan), so one busy workspace can no longer crowd everyone else out of the refresh scheduler. Repositories over the ceiling are simply picked up on a later pass — they are never marked as failed, never backed off, and never paused — and manual "Refresh Now" is never limited
- Repository: tenant administrators can now download the complete repository audit trail — refresh cycles, webhook activity, secret rotations, external-reference fetches and more — as a dated CSV or JSON file for SOC 2 / ISO 27001 reviews. Pick a date range and a format and the export streams no matter how large the ledger is; every export (even one that was cut off mid-download) is itself recorded in the audit trail, so the evidence includes who exported the evidence
- Repository: a new **Quota & limits** page (Repositories → Quota & limits) shows what the polling ceiling and the scanner have actually been doing over the last 7, 30 or 90 days — polls, scans and content scanned, with the repositories and files the quota *deferred* charted separately so "we were throttled" is never mistaken for "we were quiet". The panel leads with how much of the current hour's budget is spent and warns as you approach the ceiling, rather than after work has already been postponed. Counters survive restarts and are combined across servers, and if they cannot be read the page says so instead of showing you a flat line
- Repository: webhook deliveries can now be filtered by **source address** before their signature is ever checked (Repositories → Webhook IPs). The provider's own published ranges — GitHub's `meta` endpoint, Atlassian's for Bitbucket — are fetched daily and cached, so the list stays right as the providers move; your workspace can add its own ranges for a self-hosted runner or an egress gateway, and each one records why it exists. The page states in a sentence whether the filter is actually protecting anything right now, rather than leaving you to combine three switches, and flags a provider whose range list has stopped refreshing. Turning the filter off for your workspace is a tenant-administrator action and asks for a reason, which goes into the audit trail
- Repository: you can now choose what an auto-refresh does when it finds a spec you edited in Apiome after it was first imported (repository detail → Settings → **Refresh conflicts**). **Hold for review** stays the default and changes nothing: the refresh is skipped and the file is flagged, so nothing is overwritten until someone looks. **Overwrite** lets the repository win — the divergence is still recorded, so you can always see what was replaced. **New branch** keeps both, landing the refresh on a new branch instead of touching your edited version. Set it once for the repository, and override it for the one file that needs to differ; clearing an override puts that file back on whatever the repository is set to next, not on a stale copy of today's choice
- UI/UX: Updates look and feel for tabs
- UI/UX: Added tabbed sections to Style Guides
- UI/UX: Softened the font of the entire application
- Primitives
  - Major UX improvements in the import functionality
  - Shows unregistered namespaces that were detected
  - Import now cautions when a type declares no "type" of its own, since it will accept any value
  - Now shows unassigned/unspecified namespaces in JSON Type definitions
  - Grouping primitives in a namespace now works logically as expected
  - Primitives are now clickable inside the reference graph
  - Example form now builds inputs from the schema and allows for testing
  - Cards for reference resolution and base chain details now include traversable $refs if any apply
  - Clarifies language when importing and creating $ref for a system type based on "format" in a property
  - Documentation-only schemas that contain no type still get imported, but are treated as warnings
  - Review section of import for primitives now classifies unresolved $ref as a warning, so now shows warning counts
  - Changed "Test this type" to be expand/collapse with a chevron for testing
  - Now shows any warnings generated during import

## Bug Fixes

- Primitives
  - Added $ref lookups during primitive import, warning of unresolved $refs if any exist
  - Now shows the JSON Schema using monaco-editor
  - Added the ability to test a primitive by presenting a usable form that represents the content of the JSON Schema
  - Duplicate names are no longer treated as duplicates unless the namespace is identical
  - Removed invalid previously created primitives
  - Corrected resolution for $ref values in native system types
  - Updated import so that names with dashes are imported properly
  - Schemas that carry only documentation now import as the empty object type it describes instead of being rejected
  - Dependents card now shows properly
  - Added clarifying verbiage on unresolved $refs at import
  - $ref resolution is now local-only: references resolve to types by their place in this registry (namespace + name), never to a remote URL — imported documents' foreign $ids are ignored for resolution, and the review agrees with the import screen's preview
  - "Test this type" now handles additionalProperties: map objects offer named add/remove rows, each value validated live against the entry schema
- Repositories: Fixed file listing and scanning issues

---

View our YouTube channel [here](https://www.youtube.com/) for detailed tutorials and walkthroughs!

---

## Feedback

We'd love to hear your thoughts! Your feedback helps us make Apiome better.

---

**Thank you for using Apiome!**

*Last updated: June 23, 2026*

