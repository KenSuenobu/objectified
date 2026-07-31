# Arazzo fixtures (REPO-3.4, #2773)

The three `*.arazzo.yaml` files are the **official example bundles**, copied verbatim from
[`OAI/Arazzo-Specification`](https://github.com/OAI/Arazzo-Specification) at
`examples/1.0.0/`. They are not hand-written approximations — the round-trip acceptance
criterion is only meaningful against the documents the specification itself publishes.

| Fixture | Upstream name | Why it is here |
| --- | --- | --- |
| `pet-coupons.arazzo.yaml` | `pet-coupons.arazzo.yaml` | Three workflows, `$ref`-ed workflow inputs, steps that call a *sibling workflow* (`workflowId`) rather than an operation, and step reuse across workflows. |
| `login-and-retrieve-pets.arazzo.yaml` | `LoginAndRetrievePets.arazzo.yaml` | The `$sourceDescriptions.<name>.<operationId>` prefixed spelling **and** the `operationPath` pointer spelling (`{$sourceDescriptions.x.url}#/paths/~1pet~1findByStatus`) — a route with no HTTP verb. |
| `oauth.arazzo.yaml` | `oauth.arazzo.yaml` | Multiple workflows sharing `operationId`s, `dependsOn`, and workflow-level `outputs`. |

To refresh them:

```sh
curl -sSO https://raw.githubusercontent.com/OAI/Arazzo-Specification/main/examples/1.0.0/pet-coupons.arazzo.yaml
```

Keep the upstream content byte-identical; put any Apiome-specific scenario (a synthetic
`operationRef`, a deliberately malformed step) in the test module instead, so a refresh never
has to be merged by hand.
