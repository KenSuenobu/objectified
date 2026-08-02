# CI contract gate on GitLab & Bitbucket

Gate merge requests / pull requests on **GitLab CI** or **Bitbucket Pipelines** when an OpenAPI
change breaks (or warns against) a published Apiome project version. Both recipes run the same
[`apiome diff`](../../apiome-cli/README.md) gate as the [GitHub Action](ci-diff-gate.md), from the
same container image (CTG-2.4).

| CLI exit | Job result | Meaning |
|----------|------------|---------|
| `0` | pass | No changes at or above `--fail-on` |
| `1` | fail | Threshold met (`breaking` or `warn`) |
| `2` | fail | Auth, network, parse, or configuration error |

Exit `2` is deliberately distinct: a misconfigured pipeline never looks like a breaking change.

## Prerequisites

1. A published baseline in Apiome (`project@version` or `project@latest`).
2. Two CI secrets — use a **scoped CI token** (`diff:read`) rather than a full-access key:
   - `APIOME_API_KEY`
   - `APIOME_TENANT_ID` — tenant slug or UUID
3. Optionally `APIOME_BASE_URL` if you self-host (defaults to `https://api.apiome.dev`).

| Platform | Where secrets live |
|---|---|
| GitLab | **Settings → CI/CD → Variables**, with *Masked* and *Protected* checked |
| Bitbucket | **Repository settings → Repository variables**, with *Secured* checked |

## The container image

The image published for the GitHub Action doubles as the CI image for every other platform:

```
ghcr.io/apiome/diff-action:latest
```

Its entrypoint is **dual-mode**:

- **no arguments** → GitHub Action mode (reads `INPUT_*` env vars)
- **any arguments** → passed straight through to the `apiome` CLI

So the image is also the fastest way to reproduce a pipeline failure locally:

```bash
docker run --rm \
  -e APIOME_API_KEY -e APIOME_TENANT_ID -e APIOME_BASE_URL \
  -v "$PWD:/work" -w /work \
  ghcr.io/apiome/diff-action:latest \
  diff ./openapi.yaml --against payments-api@latest --fail-on breaking --format md
```

The pass-through entrypoint checks `APIOME_API_KEY` / `APIOME_TENANT_ID` before invoking the CLI,
defaults `APIOME_BASE_URL`, and sets `APIOME_LOAD_DOTENV=0` so a committed `.env` in the checkout
can never override CI variables.

> **Pin the image.** `latest` drifts. Use a version tag or a digest in real pipelines.

## GitLab CI

Copy this into your repository root as `.gitlab-ci.yml` (or merge the job into your pipeline):

<!-- recipe:gitlab -->
```yaml
# Apiome contract gate for GitLab CI (CTG-2.4 / #4474).
#
# Copy this file to your repository root as `.gitlab-ci.yml`, or merge the
# `apiome-contract-gate` job into your existing pipeline.
#
# Required CI/CD variables (Settings -> CI/CD -> Variables, "Masked" + "Protected"):
#   APIOME_API_KEY    Apiome API key, ideally a CI token scoped to `diff:read`
#   APIOME_TENANT_ID  tenant slug or UUID
#
# The job fails when `apiome diff` exits 1 (changes at or above APIOME_FAIL_ON)
# and when it exits 2 (auth, network, or parse error).

stages:
  - contract

apiome-contract-gate:
  stage: contract
  image:
    # Pin a version tag or digest in real pipelines - `latest` drifts.
    name: ghcr.io/apiome/diff-action:latest
    # The image entrypoint is the GitHub Action wrapper; GitLab needs a shell.
    entrypoint: [""]
  variables:
    APIOME_SPEC: openapi.yaml
    APIOME_PROJECT: payments-api@latest
    APIOME_FAIL_ON: breaking
    APIOME_BASE_URL: https://api.apiome.dev
    APIOME_LOAD_DOTENV: "0"
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - 'test -n "$APIOME_API_KEY" || { echo "APIOME_API_KEY is not set - add it as a masked CI/CD variable" >&2; exit 2; }'
    - 'test -n "$APIOME_TENANT_ID" || { echo "APIOME_TENANT_ID is not set - add it as a masked CI/CD variable" >&2; exit 2; }'
    - 'apiome diff "$APIOME_SPEC" --against "$APIOME_PROJECT" --fail-on "$APIOME_FAIL_ON" --format md > apiome-changelog.md || gate=$?'
    - 'cat apiome-changelog.md'
    - 'exit ${gate:-0}'
  artifacts:
    when: always
    expire_in: 1 week
    paths:
      - apiome-changelog.md
```

What to change: `APIOME_SPEC` (your spec path) and `APIOME_PROJECT` (`project@version|latest`).

Notes:

- `entrypoint: [""]` is required — the image's own entrypoint is the Action wrapper, and GitLab
  needs to start a shell in the container.
- The `rules:` block limits the gate to merge-request pipelines. Add a `changes:` filter (for
  example `changes: [openapi.yaml]`) to skip runs that cannot affect the contract.
- The markdown changelog is uploaded as a job artifact `apiome-changelog.md`, `when: always`, so a
  failing gate still leaves the reviewer the classified change list.

## Bitbucket Pipelines

Copy this into your repository root as `bitbucket-pipelines.yml` (or merge the step in):

<!-- recipe:bitbucket -->
```yaml
# Apiome contract gate for Bitbucket Pipelines (CTG-2.4 / #4474).
#
# Copy this file to your repository root as `bitbucket-pipelines.yml`, or merge
# the `apiome-contract-gate` step into your existing pipeline.
#
# Required repository variables (Repository settings -> Repository variables,
# check "Secured"):
#   APIOME_API_KEY    Apiome API key, ideally a CI token scoped to `diff:read`
#   APIOME_TENANT_ID  tenant slug or UUID
#
# Bitbucket runs its own shell inside the container, so the image entrypoint is
# bypassed and the job configuration lives in the step's script.

# Pin a version tag or digest in real pipelines - `latest` drifts.
image: ghcr.io/apiome/diff-action:latest

definitions:
  steps:
    - step: &apiome-contract-gate
        name: Apiome contract gate
        script:
          - 'export APIOME_SPEC="${APIOME_SPEC:-openapi.yaml}"'
          - 'export APIOME_PROJECT="${APIOME_PROJECT:-payments-api@latest}"'
          - 'export APIOME_FAIL_ON="${APIOME_FAIL_ON:-breaking}"'
          - 'export APIOME_BASE_URL="${APIOME_BASE_URL:-https://api.apiome.dev}"'
          - 'export APIOME_LOAD_DOTENV=0'
          - 'test -n "$APIOME_API_KEY" || { echo "APIOME_API_KEY is not set - add it as a secured repository variable" >&2; exit 2; }'
          - 'test -n "$APIOME_TENANT_ID" || { echo "APIOME_TENANT_ID is not set - add it as a secured repository variable" >&2; exit 2; }'
          - 'apiome diff "$APIOME_SPEC" --against "$APIOME_PROJECT" --fail-on "$APIOME_FAIL_ON" --format md > apiome-changelog.md || gate=$?'
          - 'cat apiome-changelog.md'
          - 'exit ${gate:-0}'
        artifacts:
          - apiome-changelog.md

pipelines:
  pull-requests:
    '**':
      - step: *apiome-contract-gate
```

What to change: the `APIOME_SPEC` / `APIOME_PROJECT` defaults in the script, or set them as
(non-secured) repository variables and leave the file alone.

Notes:

- Bitbucket overrides the container entrypoint and runs its own shell, so no entrypoint clearing is
  needed — the step's `script` is the configuration surface.
- `pipelines.pull-requests` runs the gate on every PR branch (`'**'`). Add it to `branches:` too if
  you also gate direct pushes to `main`.
- `artifacts: [apiome-changelog.md]` keeps the classified changelog attached to the step.

## Fail on warnings too

Set `APIOME_FAIL_ON: warn` (GitLab) or `APIOME_FAIL_ON=warn` (Bitbucket) to fail on non-breaking
**and** breaking changes. Docs-only changes alone never fail the gate.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `APIOME_API_KEY is not set …` (exit 2) | Secret missing or not exposed to the job | Add the masked/secured variable; on GitLab, *Protected* variables only reach protected branches |
| `apiome: command not found` | Job is not using the diff-action image | Check `image:` and, on GitLab, `entrypoint: [""]` |
| Exit `2` with an auth error | Key lacks the `diff:read` scope, or wrong tenant | Re-issue a scoped CI token; verify `APIOME_TENANT_ID` |
| Gate passes with no output | The spec path does not exist in the checkout | Fix `APIOME_SPEC`; the CLI exits 2 for a missing file |
| Job fails only on forks | Fork pipelines do not receive protected secrets | Run the gate on internal MRs/PRs only |

## Verify locally

```bash
export APIOME_API_KEY=…            # CI token with diff:read
export APIOME_TENANT_ID=…          # tenant slug or UUID
apiome diff ./openapi.yaml --against payments-api@latest --fail-on breaking --format md
echo "exit: $?"                    # 0 pass · 1 gate failed · 2 error
```

## Related

- [CI contract gate (GitHub Action)](ci-diff-gate.md)
- Recipe sources (kept in sync with this page by CI): [`diff-action/recipes/`](../../diff-action/recipes/)
- Action & image source: [`diff-action/`](../../diff-action/)
- CLI quick-start: [cli-quickstart.md](cli-quickstart.md)
