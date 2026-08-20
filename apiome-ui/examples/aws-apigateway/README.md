# AWS API Gateway — `aws-apigateway`

Fixtures for **FMT-7.1** ([#5455](https://github.com/apiome/apiome/issues/5455)) — asked for since
backlog issue **#350**. In AWS estates the exported API Gateway definition is the most accurate
description of what an API actually does, because it carries the integration, authorizer,
request-validator, CORS and throttle configuration the hand-written spec omits. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** An OpenAPI document that also carries at least one `x-amazon-apigateway-*`
extension. **Detection must not be greedy**: a plain OpenAPI document with no AWS extensions belongs
to the `openapi` adapter, which is why `negative/04-wrong-format-plain-openapi.yaml` is in the
negative tier rather than the valid ladder.

**Extension → canonical mapping the adapter owes**

| Extension | Canonical target | Provenance |
| --- | --- | --- |
| `x-amazon-apigateway-integration` | backend / servers | `declared` |
| `x-amazon-apigateway-authorizer` + `-authtype` | security scheme | `declared` |
| `x-amazon-apigateway-request-validator(s)` | validation posture | `declared` |
| `x-amazon-apigateway-cors` / mock OPTIONS | CORS metadata | `declared` |
| `x-amazon-apigateway-policy`, `-gateway-responses`, `-binary-media-types`, … | extras | `declared` |
| anything unrecognised | extras, **reported** | `declared` |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-rest-api.yaml` | minimal | One mock integration. |
| `02-typical-rest-api-export.json` | typical | REST export: Lambda proxy, HTTP proxy over a VPC link, mock CORS preflight, custom authorizer, request validators. |
| `03-composition-stage-variables-and-refs.yaml` | composition | `${stageVariables.*}` in integration URIs and connection ids, a shared `$ref` parameter, server variables with an enum. |
| `04-stress-extension-coverage.yaml` | stress | `any-method`, `{proxy+}` greedy path, an `aws` service integration with request/response templates, gateway responses, resource policy, endpoint configuration, two authorizer types, **and an unknown extension that must survive**. |
| `05-real-world-payments-rest-api.json` | real-world | A production payments API: five paths, Lambda authorizer with two identity sources, idempotency header, SQS webhook integration, CORS, regional endpoint. |
| `06-typical-http-api-export.yaml` | typical | The **HTTP API** (v2) flavour: JWT authorizer, `payloadFormatVersion: "2.0"`, `overwrite:path` request parameters, `$default` route, top-level `x-amazon-apigateway-cors`. |
| `07-split-set/` | multi-file | An API definition whose schemas and parameters live in a sibling file, reached by relative `$ref`. |
| `negative/` | — | Bad YAML, an integration with no `type`, truncation, a **plain OpenAPI document** (the greedy-detection case), and UTF-16. |
