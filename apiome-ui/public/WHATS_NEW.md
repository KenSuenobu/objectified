# Apiome 07-2026 RC4

We continue to improve the platform based on your feedback with improvements and new features!

---

## Features/Improvements

- Import: Arazzo workflow documents now import as first-class Workflow and Workflow Step entities; each step's `operationRef`/`operationId` links to the matching operation when that OpenAPI spec was imported in the same scan, and an unresolved reference keeps its raw value with a warning instead of being dropped
- Repository: specs that reference schemas on external hosts are now governed by a per-tenant policy — `block` (the default; nothing is fetched and the file is flagged with exactly which references are missing), `inline` (permitted references are fetched once and snapshotted into the scanned spec), or `proxy-fetch` (the same, restricted to an allowlist of hostnames, wildcards like `*.acme.com` included). Every fetch is recorded in the audit trail
- Repository: registered repositories now accept signed webhook deliveries, so a push to a branch you import from makes the repository due for a refresh immediately instead of at the end of its polling interval. Pull-request events can additionally index the PR's head branch so you can inspect the specs a review touches before it merges. Each repository gets its own signing secret, and the delivery history — including anything that failed to verify — is visible per repository
- Repository: a repository's webhook signing secret can now be rotated without a break in service — the new secret is installed at the provider, the old one keeps working for a grace window (24 hours by default) so deliveries already in flight still arrive, and it then expires on its own. If the provider could not be updated, the repository says so, and how long is left before deliveries start failing
- Repository: a new **Spec catalog** (Repositories → Spec catalog) lists every discovered spec across *all* your repositories in one searchable table. Search by path, format, repository or project; filter by format, repository, project, or status (needs attention / imported / mapped / discovered); sort by any of them. Each row links straight to that spec's detail view on its own repository, and the whole view lives in the URL, so a filtered catalog is a link you can paste to a colleague. Paging is server-side and stays fast on workspaces with tens of thousands of files
- Repository: repository polling now has a per-tenant hourly ceiling (60 by default, 600 on the elevated plan), so one busy workspace can no longer crowd everyone else out of the refresh scheduler. Repositories over the ceiling are simply picked up on a later pass — they are never marked as failed, never backed off, and never paused — and manual "Refresh Now" is never limited
- UI/UX: Updates look and feel for tabs
- UI/UX: Added tabbed sections to Style Guides
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

