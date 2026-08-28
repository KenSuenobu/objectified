# Apiome Mock Runtime action (PMR-3.1)

Start a version-pinned [portable mock](../docs/guide/portable-mock-runtime.md) for the rest of a CI
job, get a loopback-only service URL back, and have the container removed automatically when the
job ends — however it ends.

```yaml
- uses: apiome/apiome/mock-action@v1
  id: mock
  with:
    bundle: petstore-1.0.0-mock-bundle.json
    image: ghcr.io/apiome/apiome-mock:0.5.0   # pin a version or a digest
    conformance: "true"                        # prove the runtime before trusting it

- run: npm test
  env:
    API_BASE_URL: ${{ steps.mock.outputs.service-url }}
```

Export the bundle in an earlier step (or commit it) with
`GET /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/bundle`.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `bundle` | *(required)* | Bundle to serve. Workspace-relative or absolute; paths outside the workspace are refused. |
| `image` | `ghcr.io/apiome/apiome-mock:latest` | Runtime image. **Pin a version tag or digest in CI** — `latest` drifts. |
| `port` | `0` | Host port. `0` picks a free one, so parallel jobs on one runner never collide. |
| `host` | `127.0.0.1` | Interface to publish on. Loopback keeps the mock reachable from the job and nothing else. |
| `wait` | `60` | Seconds to wait for readiness before failing. |
| `conformance` | `false` | Run the shared conformance corpus against the started runtime. |
| `require-signature` | `false` | Refuse to serve an unsigned bundle. |
| `bundle-secret` | `""` | Shared HMAC secret for signature verification. Pass a repository secret. |
| `pull` | `true` | Pull the image before starting it. |

## Outputs

| Output | Meaning |
|---|---|
| `service-url` | Base URL **including** the version mount — what your tests should call. |
| `base-url` | Runtime root, for `/health` and `/ready`. |
| `mount` | `/{tenant}/{project}/{version}` prefix. |
| `bundle-digest` | Digest of the served bundle. |
| `runtime-version` | Version of the runtime serving it. |
| `container` | Container name (removed automatically). |
| `port` | Host port that was published. |

`bundle-digest` and `runtime-version` are two of the four identities a release-proof mock
attestation records. To turn a job's run into that evidence, follow it with `apiome-mock attest` —
see [mock-release-attestation.md](../docs/guide/mock-release-attestation.md).

## What it guarantees

**A safe service URL.** The runtime publishes on `127.0.0.1` by default, so nothing off the runner
can reach the mock. No credential ever appears in the URL, and the bundle carries none: a bundle is
credential-free by construction (see [the bundle format](../docs/guide/mock-bundle-format.md)). A
signing secret, when configured, is forwarded to the container **by name** rather than on a command
line, where the process table would expose it to every process on the runner.

**Automatic cleanup.** The action registers a `post` step, which GitHub runs after the job whether
it passed, failed, or was cancelled. The container's last 200 log lines are attached first, in a
collapsed group: once the container is gone they are the only record of why the mock answered as it
did, and a post step cannot tell whether the job passed, so they are always attached rather than
guessed at. Cleanup itself never fails the job — a container that is already gone is the outcome it
wanted anyway.

**Reported digests.** The runtime version and bundle digest are published as outputs and written to
the job summary. A green suite proves nothing if nobody can tell which artifact answered it; assert
the digest in a later step to prove the job ran against the bundle it intended to:

```yaml
- run: |
    test "${{ steps.mock.outputs.bundle-digest }}" = "sha256:90591f2f…" \
      || { echo "mock served an unexpected bundle"; exit 1; }
```

## Behavior parity

`conformance: "true"` runs the corpus shipped inside the image against the container that just
started — the same corpus the hosted runtime is held to, covering routing, request validation,
scenarios, sessions, chaos, templates, and fixture packs. To compare a *hosted* deployment against
a portable one response by response, use the runtime's parity command:

```bash
apiome-mock parity \
  --hosted-url https://mock.apiome.dev --hosted-mount /acme/petstore/1.0.0 \
  --portable-url http://127.0.0.1:8775
```

## Development

```bash
cd mock-action
yarn test   # node --test, no dependencies
yarn lint   # syntax check every script
```

The action is plain Node with **no dependencies and no bundling step**, so what runs on a runner is
exactly what is committed here and reviewable in a pull request.
