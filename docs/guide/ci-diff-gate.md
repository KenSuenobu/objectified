# CI contract gate (GitHub Action)

Gate pull requests when an OpenAPI change breaks (or warns against) a published
Apiome project version. The Action wraps [`apiome diff`](../../apiome-cli/README.md)
(CTG-2.1) and posts one sticky PR comment with the markdown changelog (CTG-2.2).

| CLI exit | Check result | Meaning |
|----------|--------------|---------|
| `0` | pass | No changes at or above `--fail-on` |
| `1` | fail | Threshold met (`breaking` or `warn`) |
| `2` | fail (`::error::`) | Auth, network, parse, or oversize error |

## Prerequisites

1. A published baseline in Apiome (`project@version` or `project@latest`).
2. Repository secrets:
   - `APIOME_API_KEY` — workspace API key (prefer a read-only CI token with `diff:read`)
   - `APIOME_TENANT_ID` — tenant slug or UUID
3. Optional repository variable `APIOME_BASE_URL` (defaults to `https://api.apiome.dev` in the Action).

## Copy-paste workflow

Create `.github/workflows/apiome-diff.yml`:

```yaml
name: Apiome contract gate
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: apiome/apiome/diff-action@main
        with:
          spec: openapi.yaml
          project: payments-api@latest
          fail-on: breaking
          api-key: ${{ secrets.APIOME_API_KEY }}
          tenant: ${{ secrets.APIOME_TENANT_ID }}
          base-url: ${{ vars.APIOME_BASE_URL }}
```

Replace `openapi.yaml` and `payments-api@latest` with your spec path and project.

### Sticky PR comment

The Action upserts a single comment marked with `<!-- apiome-diff-action -->`.
Subsequent pushes to the same PR update that comment in place — they do not spam
new comments. Requires `permissions.pull-requests: write`.

Set `comment: false` to skip the comment and only fail/pass the check.

### Fail on warnings too

```yaml
          fail-on: warn
```

`warn` fails on non-breaking **and** breaking changes. Docs-only changes alone
never fail the gate.

## Not on GitHub?

The same container image backs copy-paste **GitLab CI** and **Bitbucket Pipelines** recipes —
see [ci-gitlab-bitbucket.md](ci-gitlab-bitbucket.md).

## CLI equivalent

```bash
export APIOME_BASE_URL=https://api.apiome.dev
export APIOME_API_KEY=…          # from secrets
export APIOME_TENANT_ID=…        # from secrets
apiome diff ./openapi.yaml --against payments-api@latest --fail-on breaking --format md
```

## Related

- Action source: [`diff-action/`](../../diff-action/)
- GitLab / Bitbucket recipes: [ci-gitlab-bitbucket.md](ci-gitlab-bitbucket.md)
- CLI quick-start: [cli-quickstart.md](cli-quickstart.md)
- Classified diff details: [`apiome-cli` README](../../apiome-cli/README.md#classified-diff-ci-gate)
