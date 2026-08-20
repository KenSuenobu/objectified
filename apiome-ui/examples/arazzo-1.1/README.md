# Arazzo 1.1 workflows — `arazzo-1.1`

Fixtures for **FMT-3.1** ([#5426](https://github.com/apiome/apiome/issues/5426)) — the May 2026
revision that lets one workflow span synchronous (OpenAPI) and asynchronous (AsyncAPI) APIs. The
shipped `arazzo/` corpus covers 1.0 only; these entries are the 1.1 half, plus a 1.0 baseline that
must still round-trip **as 1.0** (the emitter may not silently upgrade).

They sit in their own directory rather than in `arazzo/` because no adapter reads 1.1 yet: entries
carry `adapter_key: null` and the `pending-adapter` tag, so the live corpus suites do not run them
against the 1.0-only adapter.

**Detection marker.** Top-level `arazzo: 1.1.x`.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-single-step.yaml` | minimal | One source description, one step, one criterion. |
| `02-typical-checkout-flow.yaml` | typical | Inputs, step outputs threaded between steps, request bodies. |
| `03-composition-reusable-components.yaml` | composition | `components.{inputs,parameters,successActions,failureActions}` reached by `$ref`, plus `dependsOn` between workflows. |
| `04-stress-criteria-vocabulary.yaml` | stress | `simple`/`regex`/`jsonpath`/`xpath` criteria, versioned criterion objects, `operationPath` and `operationRef`. |
| `05-real-world-order-to-cash.yaml` | real-world | The 1.1 headline: REST step → two AsyncAPI event steps → REST step, with `$message.payload` criteria. |
| `06-sourced-set/` | multi-file | Workflow whose `sourceDescriptions` resolve to a sibling OpenAPI file. |
| `07-version-1.0-baseline.yaml` | typical | A 1.0.1 document; import must record 1.0 and emit 1.0. |
| `negative/` | — | Broken flow sequence, a step that names no operation, truncation, an AsyncAPI document, UTF-16, and an out-of-range `arazzo: 2.0.0`. |

**Grounding note.** The async steps use the 1.1 `sourceDescriptions[].type: asyncapi` form with
`$message.payload` criteria contexts. Re-ground `04` and `05` against the published 1.1 JSON Schema
when the adapter lands, and record any deviation in the manifest `notes` rather than editing silently.
