# Catalog import examples

Sample source documents for exercising the catalog **Import** flow (the ImportDialog source cards → format auto-detection → catalog item). Each file is a small, self-contained document with a header comment explaining what it demonstrates.

> **Generated file — do not edit.** This README is the human index of [`corpus.manifest.json`](corpus.manifest.json) (schema: [`corpus.schema.json`](corpus.schema.json)). Edit the manifest, then run `python3 scripts/generate_examples_readme.py` from the repo root; CI fails on drift.

The corpus holds **430 files** across **36 format directories**. Every file has a manifest entry declaring its format family, the adapter that must claim it, its validity class, the detection contract (format key + minimum confidence), feature tags, and the expected import outcome.

## How the corpus is used

- **Format auto-detection** (`apiome-rest` `format_detection.py`) sniffs each file's content and names the format; the manifest's `expected_detection` records the contract detection must meet.
- **Tests select fixtures by tag, not by path**: `load_corpus(...)` in `apiome-rest/tests/corpus_loader.py` (pytest) and `loadCorpus(...)` in `apiome-ui/lib/corpus/corpus.ts` (Jest) filter entries by `format`, `validity_class`, `feature`, or `adapter_key`.
- **Catalog pills** (`apiome-ui` `catalog-format-registry.ts`) render the format, protocol/paradigm, and source-material badges off the imported item.

## Layout

### REST / HTTP

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `api-blueprint/` | API Blueprint | rest | `FORMAT: 1A` metadata line | 11 |
| `arazzo/` | Arazzo workflows | rest | top-level `arazzo:` version | 11 |
| `odata/` | OData v4 (EDMX) | rest | `<edmx:Edmx>` root | 11 |
| `openapi/` | OpenAPI 3.x | rest | top-level `openapi:` version | 37 |
| `postman/` | Postman v2.1 | rest | collection `info.schema` URL | 11 |
| `raml/` | RAML 1.0 | rest | `#%RAML 1.0` header | 11 |
| `swagger/` | Swagger 2.0 | rest | `swagger: "2.0"` | 1 |
| `typespec/` | TypeSpec | rest | `import "@typespec/..."` | 11 |
| `wadl/` | WADL | rest | `<application>` root (WADL namespace) | 11 |
| `wsdl/` | WSDL 1.1 (SOAP) | soap | `<wsdl:definitions>` root | 11 |
| `zos-connect/` | z/OS Connect | rest | `apiRequester` / `apiProvider` descriptor | 11 |

### RPC

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `connectrpc/` | Connect-RPC | rpc | Protobuf `service` (Connect) | 12 |
| `corba-idl/` | CORBA / OMG IDL | rpc | `module` + `interface` | 11 |
| `onc-rpc/` | ONC RPC / XDR | rpc | `program {} = N` + XDR types | 11 |
| `openrpc/` | OpenRPC (JSON-RPC) | rpc | top-level `openrpc:` version | 11 |
| `protobuf/` | Protobuf / gRPC | rpc | `syntax = "proto3"` | 12 |
| `smithy/` | Smithy 2.0 | rpc | `$version` + Smithy shapes | 11 |
| `thrift/` | Apache Thrift | rpc | `service` / `struct` shapes | 11 |
| `xml-rpc/` | XML-RPC | rpc | `<methodCall>` / `<methodResponse>` root | 11 |

### Event / messaging

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `asyncapi/` | AsyncAPI 2.x/3.0 | event | top-level `asyncapi:` version | 13 |
| `cloudevents/` | CloudEvents 1.0 | event | `specversion` + `type` + `source` envelope | 11 |

### Graph

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `graphql/` | GraphQL SDL | graph | root `type Query` / `schema {}` | 19 |

### Data schema

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `asn1/` | ASN.1 | data_schema | `DEFINITIONS ::= BEGIN … END` | 12 |
| `avro/` | Avro schema | data_schema | `type: record` + `fields` | 11 |
| `capnproto/` | Cap'n Proto | data_schema | `@0x…` file id + `struct` | 11 |
| `cobol-copybook/` | COBOL copybook | data_schema | level numbers + `PIC` clauses | 11 |
| `flatbuffers/` | FlatBuffers | data_schema | `table`/`struct` + `root_type` | 11 |
| `json-schema/` | JSON Schema | data_schema | `$schema` / `type` + `properties` | 16 |
| `jtd/` | JSON Type Definition | data_schema | `properties`/`optionalProperties` | 11 |
| `xsd/` | XML Schema (XSD) | data_schema | `xs:schema` root element | 11 |

### Industry / domain messaging

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `edi-x12/` | EDI ASC X12 | message | `ISA`/`GS`/`ST` envelopes | 11 |
| `fhir/` | FHIR R4 | data_schema | `resourceType` (+ StructureDefinition) | 11 |
| `fix/` | FIX / FIX Orchestra | message | `8=FIX.` tags / `<fixr:repository>` | 11 |
| `hl7v2/` | HL7 v2.x | message | `MSH\|^~\&\|` message header | 11 |
| `iso20022/` | ISO 20022 | message | `urn:iso:std:iso:20022` XML namespace | 11 |
| `iso8583/` | ISO 8583 | message | `mti` + numbered `dataElements` | 11 |

## File index

Validity classes: `valid` imports cleanly · `invalid` must be rejected · `adversarial` tries to confuse detection · `scale` stresses limits.

Ladder rungs (IXH-1.2): `minimal` canonical hello-world · `typical` realistic service · `composition` inheritance/refs/imports · `stress` less common grammar · `real-world` public spec or faithful reconstruction · `multi-file` a set imported together.

### `api-blueprint/` — API Blueprint

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-simple-api.apib` | typical | `api-blueprint` ≥ 0.95 | valid | `responses`, `parameters`, `resources` |
| `02-minimal-ping.apib` | minimal | `api-blueprint` ≥ 0.95 | valid | `resources`, `responses` |
| `03-bookstore-service.apib` | typical | `api-blueprint` ≥ 0.95 | valid | `resources`, `parameters`, `responses`, `data-structures` |
| `04-mson-inheritance.apib` | composition | `api-blueprint` ≥ 0.95 | valid | `mson-inheritance`, `data-structures`, `resources`, `responses` |
| `05-grammar-corners.apib` | stress | `api-blueprint` ≥ 0.95 | valid | `enum`, `parameters`, `responses`, `action-path-override`, `data-structures` |
| `06-polls-reconstruction.apib` | real-world | `api-blueprint` ≥ 0.95 | valid | `resources`, `parameters`, `data-structures`, `responses` |
| `negative/01-syntactic-unclosed-resource-bracket.apib` | — | `api-blueprint` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-resource-bracket` |
| `negative/02-semantic-no-resources.apib` | — | `api-blueprint` (no guarantee) | invalid | `negative`, `semantic`, `no-resources` |
| `negative/03-truncated-mid-resource.apib` | — | `api-blueprint` (no guarantee) | invalid | `negative`, `truncated`, `mid-resource` |
| `negative/04-wrong-format-protobuf.proto` | — | `api-blueprint` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf` |
| `negative/05-encoding-utf16.apib` | — | `api-blueprint` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

### `arazzo/` — Arazzo workflows

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `06-pet-coupons-real-world.yaml` | real-world | `arazzo` ≥ 0.95 | valid | `pet-coupons`, `workflows`, `steps`, `success-criteria`, `outputs`, `inputs` |
| `07-spec-grammar-stress.yaml` | stress | `arazzo` ≥ 0.95 | valid | `spec-grammar-stress`, `workflows`, `success-criteria`, `components`, `operationRef`, `dependsOn` |
| `edge-cases.yaml` | stress | `arazzo` ≥ 0.95 | valid | `edge-cases`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `mixed-scenarios.yaml` | composition | `arazzo` ≥ 0.95 | valid | `mixed-scenarios`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `negative/02-semantic-root-not-a-mapping.yaml` ⚠ | — | `arazzo` (no guarantee) | invalid | `negative`, `semantic`, `root-not-a-mapping` |
| `negative/03-truncated-mid-string.yaml` | — | `arazzo` (no guarantee) | invalid | `negative`, `truncated`, `mid-quoted-scalar` |
| `negative/04-wrong-format-openapi.yaml` ⚠ | — | `arazzo` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi` |
| `negative/05-encoding-utf16.yaml` | — | `arazzo` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/property-conflicts.yaml` ⚠ | — | `arazzo` (no guarantee) | invalid | `property-conflicts`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `property-reuse.yaml` | typical | `arazzo` ≥ 0.95 | valid | `property-reuse`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `simple-workflow.yaml` | minimal | `arazzo` ≥ 0.95 | valid | `simple-workflow`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |

> ⚠ **`negative/02-semantic-root-not-a-mapping.yaml`** — The shared ingestion loader rejects top-level YAML sequences at the parse phase, so the code is INPUT_MALFORMED rather than a normalize-phase INPUT_SEMANTIC_INVALID.

> ⚠ **`negative/04-wrong-format-openapi.yaml`** — The YAML parses cleanly, so the failure surfaces at normalize (`no arazzo version marker`) as INPUT_SEMANTIC_INVALID rather than FORMAT_MISMATCH; the arazzo sniffer correctly reports no match (detect_matched false).

> ⚠ **`negative/property-conflicts.yaml`** — The line-scrambled YAML fails to parse, so the arazzo sniffer cannot claim it; the greedy graphql sniffer claims the text at 0.9 confidence, so the pipeline classifies FORMAT_MISMATCH instead of INPUT_MALFORMED.

### `asn1/` — ASN.1

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-person.asn1` | typical | `asn1` ≥ 0.9 | valid | `sequence-of`, `sequence`, `choice`, `enumerated`, `optional`, `defaults` |
| `02-identifier.asn1` | typical | `asn1` ≥ 0.9 | valid | `sequence`, `choice`, `enumerated`, `defaults` |
| `03-minimal-module.asn1` | minimal | `asn1` ≥ 0.9 | valid | `sequence`, `single-member` |
| `04-imports-reuse.asn1` | composition | `asn1` ≥ 0.9 | valid | `imports`, `exports`, `sequence`, `sequence-of`, `enumerated`, `defaults` |
| `05-stress-grammar.asn1` | stress | `asn1` ≥ 0.9 | valid | `set`, `choice`, `explicit-tags`, `constraints`, `inline-enumerated`, `defaults` |
| `06-x509-certificate-shape.asn1` | real-world | `asn1` ≥ 0.9 | valid | `sequence`, `choice`, `sequence-of`, `optional`, `defaults`, `explicit-tags` |
| `07-scalar-alias-typedefs.asn1` ⚠ | stress | `asn1` ≥ 0.9 | valid | `scalar-typedefs`, `sequence-of`, `bit-string`, `constraints`, `sequence` |
| `negative/01-syntactic-unclosed-brace.asn1` | — | `asn1` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-empty-module.asn1` | — | `asn1` (no guarantee) | invalid | `negative`, `semantic`, `empty-module` |
| `negative/03-truncated-mid-sequence.asn1` | — | `asn1` (no guarantee) | invalid | `negative`, `truncated`, `mid-sequence` |
| `negative/04-wrong-format-graphql.graphql` | — | `asn1` (no guarantee) | invalid | `negative`, `wrong-format`, `graphql` |
| `negative/05-encoding-utf16.asn1` | — | `asn1` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`07-scalar-alias-typedefs.asn1`** — Import currently fails: the asn1 normalizer builds `Type(scalar=...)` for top-level scalar typedefs and `Type(alias_of=...)` for top-level SEQUENCE OF typedefs, but the canonical `Type` model has no `scalar` field and names the alias field `aliased`, so normalize raises a pydantic ValidationError; expected_outcome records the intended contract.

### `asyncapi/` — AsyncAPI 2.x/3.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-user-events-2.6.yaml` | typical | `asyncapi-2` ≥ 0.95 | valid | `channels`, `subscribe`, `messages`, `components`, `servers`, `payload` |
| `02-order-events-3.0.yaml` | composition | `asyncapi-3` ≥ 0.95 | valid | `channels`, `operations`, `messages`, `components`, `servers`, `payload` |
| `03-heartbeat-minimal-2.6.yaml` | minimal | `asyncapi-2` ≥ 0.95 | valid | `channels`, `publish`, `payload` |
| `04-iot-telemetry-stress-2.6.yaml` | stress | `asyncapi-2` ≥ 0.95 | valid | `parameters`, `traits`, `correlationId`, `oneOf`, `allOf`, `bindings` |
| `05-slack-rtm-real-world-2.6.yaml` | real-world | `asyncapi-2` ≥ 0.95 | valid | `channels`, `publish`, `subscribe`, `oneOf`, `websocket` |
| `06-payment-events-set/asyncapi.yaml` | multi-file (root) | `asyncapi-3` ≥ 0.95 | valid | `channels`, `operations`, `servers`, `cross-file-ref` |
| `06-payment-events-set/messages.yaml` ⚠ | multi-file (member) | `asyncapi-3` (no guarantee) | valid | `messages`, `payload`, `cross-file-ref` |
| `06-payment-events-set/schemas.yaml` ⚠ | multi-file (member) | `asyncapi-3` (no guarantee) | valid | `schemas`, `cross-file-ref` |
| `negative/01-syntactic-unclosed-flow-sequence.yaml` ⚠ | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-flow-sequence` |
| `negative/02-semantic-channels-not-a-mapping.yaml` ⚠ | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `semantic`, `channels-not-a-mapping` |
| `negative/03-truncated-mid-ref.yaml` ⚠ | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `truncated`, `mid-ref` |
| `negative/04-wrong-format-protobuf.proto` | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf` |
| `negative/05-encoding-utf16.yaml` | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`06-payment-events-set/messages.yaml`** — Fileset member without an `asyncapi` marker — not independently detectable; imported only through the set root asyncapi.yaml, whose bundler chases this file's $refs into schemas.yaml.

> ⚠ **`06-payment-events-set/schemas.yaml`** — Fileset member without an `asyncapi` marker — not independently detectable; imported only through the set root asyncapi.yaml.

> ⚠ **`negative/01-syntactic-unclosed-flow-sequence.yaml`** — Verified without asyncapi-parser installed (parse raises tool-unavailable), but the flaw is broken YAML, so classification is text-grounded and tool-independent.

> ⚠ **`negative/02-semantic-channels-not-a-mapping.yaml`** — Verified without asyncapi-parser installed; the asyncapi sniffer still claims the document (detect_matched true) and the blatantly wrong `channels` type also fails validation when the tool is present.

> ⚠ **`negative/03-truncated-mid-ref.yaml`** — The truncated YAML no longer parses, so the asyncapi sniffer cannot claim it; the greedy graphql sniffer claims the text at 0.9 confidence, so the pipeline classifies FORMAT_MISMATCH instead of INPUT_MALFORMED.

### `avro/` — Avro schema

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-user-record.avsc` | typical | `avro` ≥ 0.9 | valid | `record`, `enum`, `array`, `logical-types`, `nullable-union`, `defaults`, `docs` |
| `02-order-record.avsc` | typical | `avro` ≥ 0.9 | valid | `record`, `array`, `nested-records`, `logical-types`, `defaults`, `docs` |
| `03-minimal-record.avsc` | minimal | `avro` ≥ 0.9 | valid | `record`, `single-field` |
| `04-shared-types.avsc` | composition | `avro` ≥ 0.9 | valid | `record`, `enum`, `named-type-refs`, `map`, `array`, `logical-types` |
| `05-stress-mixed-types.avsc` | stress | `avro` ≥ 0.9 | valid | `record`, `fixed`, `map`, `multi-branch-union`, `aliases`, `logical-types` |
| `06-stripe-charge-shape.avsc` | real-world | `avro` ≥ 0.9 | valid | `record`, `enum`, `nested-records`, `nullable-union`, `map`, `logical-types` |
| `negative/01-syntactic-unclosed-brace.avsc` | — | `avro` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-missing-name.avsc` | — | `avro` (no guarantee) | invalid | `negative`, `semantic`, `missing-name` |
| `negative/03-truncated-mid-union.avsc` | — | `avro` (no guarantee) | invalid | `negative`, `truncated`, `mid-union` |
| `negative/04-wrong-format-json-schema.json` | — | `avro` (no guarantee) | invalid | `negative`, `wrong-format`, `json-schema` |
| `negative/05-encoding-utf16.avsc` | — | `avro` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

### `capnproto/` — Cap'n Proto

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-address-book.capnp` | typical | `capnproto` ≥ 0.95 | valid | `file-id`, `struct`, `enum`, `interface`, `list` |
| `02-minimal-ping.capnp` | minimal | `capnproto` ≥ 0.95 | valid | `file-id`, `struct` |
| `03-invoice-imports.capnp` | composition | `capnproto` ≥ 0.95 | valid | `file-id`, `imports`, `using-alias`, `nested-struct`, `interface` |
| `04-event-stress.capnp` ⚠ | stress | `capnproto` ≥ 0.95 | valid | `union`, `group`, `nested-enum`, `list`, `AnyPointer`, `const` |
| `05-compiler-schema.capnp` | real-world | `capnproto` ≥ 0.95 | valid | `file-id`, `struct`, `enum`, `nested-struct`, `list` |
| `06-task-queue.capnp` | typical | `capnproto` ≥ 0.95 | valid | `file-id`, `struct`, `enum`, `interface` |
| `negative/01-syntactic-unclosed-struct.capnp` | — | `capnproto` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-struct` |
| `negative/02-semantic-no-definitions.capnp` | — | `capnproto` (no guarantee) | invalid | `negative`, `semantic`, `no-definitions` |
| `negative/03-truncated-mid-struct.capnp` | — | `capnproto` (no guarantee) | invalid | `negative`, `truncated`, `mid-struct` |
| `negative/04-wrong-format-thrift.thrift` | — | `capnproto` (no guarantee) | invalid | `negative`, `wrong-format`, `thrift` |
| `negative/05-encoding-utf16.capnp` | — | `capnproto` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`04-event-stress.capnp`** — Import fidelity gap: the `drain` method's `List(Event)` result contains parentheses, which the interface-method regex cannot span, so that method is silently dropped from the imported Collector interface.

### `cloudevents/` — CloudEvents 1.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-order-created.json` | typical | `cloudevents` ≥ 0.95 | valid | `envelope`, `data-content-type`, `data-payload` |
| `02-minimal-ping.json` | minimal | `cloudevents` ≥ 0.95 | valid | `envelope`, `required-attributes` |
| `03-order-lifecycle-batch.json` ⚠ | composition | `cloudevents` ≥ 0.95 | valid | `batch`, `envelope`, `data-payload` |
| `04-binary-scan-stress.json` | stress | `cloudevents` ≥ 0.95 | valid | `envelope`, `extensions`, `data-base64`, `dataschema`, `subject` |
| `05-azure-blob-created.json` | real-world | `cloudevents` ≥ 0.95 | valid | `envelope`, `data-payload`, `subject` |
| `06-user-signedup.json` | typical | `cloudevents` ≥ 0.95 | valid | `envelope`, `data-content-type`, `data-payload` |
| `negative/01-syntactic-unclosed-brace.json` | — | `cloudevents` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-missing-source.json` ⚠ | — | `cloudevents` (no guarantee) | invalid | `negative`, `semantic`, `missing-source` |
| `negative/03-truncated-azure-blob.json` | — | `cloudevents` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-json-schema.json` | — | `cloudevents` (no guarantee) | invalid | `negative`, `wrong-format`, `json-schema-document` |
| `negative/05-encoding-utf16-ping.json` | — | `cloudevents` (no guarantee) | invalid | `negative`, `encoding`, `utf-16-bytes` |

> ⚠ **`03-order-lifecycle-batch.json`** — CloudEvents batch arrays are documented in cloudevents_parser (and is_cloudevents_document accepts lists), but both detect and parse delegate to parse_document, which rejects top-level JSON arrays — the adapter's detect returns no match (only the standalone sniffer reports cloudevents 0.85) and import currently fails; expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`negative/02-semantic-missing-source.json`** — Rejected at parse (`Content does not appear to be a CloudEvents document`), so the grounded code is INPUT_MALFORMED rather than INPUT_SEMANTIC_INVALID; detect also declines because is_cloudevents_document requires source.

### `cobol-copybook/` — COBOL copybook

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-customer-record.cpy` | typical | `cobolcopybook` ≥ 0.95 | valid | `occurs-depending-on`, `occurs`, `comp-3`, `pic`, `level-88`, `values` |
| `02-order-line.cpy` | minimal | `cobolcopybook` ≥ 0.95 | valid | `comp-3`, `pic` |
| `03-payment-redefines.cpy` | composition | `cobolcopybook` ≥ 0.95 | valid | `redefines`, `level-88`, `comp-3`, `pic`, `filler` |
| `04-warehouse-stress.cpy` | stress | `cobolcopybook` ≥ 0.95 | valid | `occurs-depending-on`, `comp-3`, `comp`, `binary`, `filler`, `level-88` |
| `05-ach-entry-detail.cpy` | real-world | `cobolcopybook` ≥ 0.95 | valid | `pic`, `level-88`, `values` |
| `06-account-master.cpy` | typical | `cobolcopybook` ≥ 0.95 | valid | `pic`, `comp-3`, `level-88`, `nested-groups` |
| `negative/01-syntactic-garbled-level.cpy` | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `syntactic`, `garbled-level-number` |
| `negative/02-semantic-level-05-before-01.cpy` | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `semantic`, `level-05-before-01` |
| `negative/03-truncated-order-line.cpy` ⚠ | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-inventory.idl` | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `wrong-format`, `corba-idl-document` |
| `negative/05-encoding-utf16-order-line.cpy` | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `encoding`, `utf-16-bytes` |

> ⚠ **`negative/03-truncated-order-line.cpy`** — The parser accepts any prefix containing a level-01 item plus one PIC clause, so the cut lands just before the first PIC completes (~54%) to defeat the lenient line-by-line parser.

### `connectrpc/` — Connect-RPC

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-greeter.proto` | minimal | `connectrpc` ≥ 0.95 | valid | `proto3`, `message`, `service`, `rpc`, `streaming`, `repeated`, `package` |
| `02-tasks-service.proto` | typical | `connectrpc` ≥ 0.95 | valid | `proto3`, `service`, `rpc`, `message`, `enum`, `repeated` |
| `03-scheduling-composition.proto` | composition | `connectrpc` ≥ 0.95 | valid | `proto3`, `service`, `import`, `well-known-types`, `message` |
| `04-chat-stress.proto` | stress | `connectrpc` ≥ 0.95 | valid | `proto3`, `streaming`, `oneof`, `reserved`, `optional`, `map` |
| `05-eliza-style.proto` | real-world | `connectrpc` ≥ 0.95 | valid | `proto3`, `service`, `rpc`, `streaming`, `message` |
| `06-payments-set/payment_service.proto` | multi-file (root) | `connectrpc` ≥ 0.95 | valid | `proto3`, `service`, `rpc`, `import`, `streaming` |
| `06-payments-set/payment_types.proto` | multi-file (member) | `connectrpc` ≥ 0.95 | valid | `proto3`, `message`, `enum`, `package` |
| `negative/01-syntactic-unclosed-brace.proto` | — | `connectrpc` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-duplicate-field-number.proto` | — | `connectrpc` (no guarantee) | invalid | `negative`, `semantic`, `duplicate-field-number` |
| `negative/03-truncated-greeter.proto` | — | `connectrpc` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-user-directory.thrift` ⚠ | — | `connectrpc` (no guarantee) | invalid | `negative`, `wrong-format`, `thrift-idl-document` |
| `negative/05-encoding-utf16-greeter.proto` | — | `connectrpc` (no guarantee) | invalid | `negative`, `encoding`, `utf-16-bytes` |

> ⚠ **`negative/04-wrong-format-user-directory.thrift`** — The connectrpc _CONNECT_MARKER_RE claims any proto-looking text whose comments mention 'Connect-RPC' at 0.98, so the fixture's comment deliberately avoids the phrase to keep detect_matched false.

### `corba-idl/` — CORBA / OMG IDL

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-bank.idl` | typical | `corbaidl` ≥ 0.95 | valid | `module`, `interface`, `struct`, `enum`, `exceptions`, `raises` |
| `02-inventory.idl` | typical | `corbaidl` ≥ 0.95 | valid | `module`, `interface`, `struct`, `exceptions`, `raises`, `sequence` |
| `03-minimal-echo.idl` | minimal | `corbaidl` ≥ 0.95 | valid | `module`, `interface` |
| `04-nested-modules.idl` | composition | `corbaidl` ≥ 0.95 | valid | `module`, `nested-modules`, `typedef`, `sequence`, `interface`, `raises` |
| `05-trading-stress.idl` | stress | `corbaidl` ≥ 0.95 | valid | `oneway`, `parameter-directions`, `attributes`, `sequence`, `exceptions`, `enum` |
| `06-cosnaming.idl` | real-world | `corbaidl` ≥ 0.95 | valid | `module`, `interface`, `struct`, `exceptions`, `raises`, `sequence` |
| `negative/01-syntactic-unclosed-interface.idl` | — | `corbaidl` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-interface-brace` |
| `negative/02-unresolvable-ref-missing-include.idl` ⚠ | — | `corbaidl` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-include` |
| `negative/03-truncated-inventory.idl` | — | `corbaidl` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-greeter.proto` | — | `corbaidl` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf-document` |
| `negative/05-encoding-utf16-echo.idl` | — | `corbaidl` (no guarantee) | invalid | `negative`, `encoding`, `utf-16-bytes` |

> ⚠ **`negative/02-unresolvable-ref-missing-include.idl`** — is_corbaidl hard-rejects any text containing `include "` (an anti-Thrift guard) so the corbaidl sniffer never claims the file, and the thrift sniffer claims the #include line at 0.95 — the pipeline therefore grounds FORMAT_MISMATCH rather than an unresolved-reference code.

### `edi-x12/` — EDI ASC X12

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-850-purchase-order.edi` | typical | `edix12` ≥ 0.9 | valid | `850-purchase-order`, `isa-envelope`, `iea-trailer` |
| `02-810-invoice.edi` | typical | `edix12` ≥ 0.9 | valid | `810-invoice`, `isa-envelope`, `iea-trailer` |
| `03-997-acknowledgment.edi` | minimal | `edix12` ≥ 0.9 | valid | `997-acknowledgment`, `isa-envelope`, `iea-trailer` |
| `04-multi-group-po-ack.edi` | composition | `edix12` ≥ 0.9 | valid | `multi-functional-group`, `850-purchase-order`, `997-acknowledgment`, `isa-envelope` |
| `05-856-asn-hierarchical.edi` | stress | `edix12` ≥ 0.9 | valid | `856-ship-notice`, `hl-loops`, `ta1-acknowledgment`, `multi-transaction-set` |
| `06-834-benefit-enrollment.edi` | real-world | `edix12` ≥ 0.9 | valid | `834-benefit-enrollment`, `hipaa-5010`, `isa-envelope`, `iea-trailer` |
| `negative/01-syntactic-missing-se.edi` ⚠ | — | `edix12` (no guarantee) | invalid | `negative`, `syntactic`, `missing-se-trailer` |
| `negative/02-semantic-nested-gs.edi` ⚠ | — | `edix12` (no guarantee) | invalid | `negative`, `semantic`, `nested-gs-groups` |
| `negative/03-truncated-850-purchase-order.edi` | — | `edix12` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-adt-admit.hl7` | — | `edix12` (no guarantee) | invalid | `negative`, `wrong-format`, `hl7v2-message` |
| `negative/05-encoding-utf16-invoice.edi` | — | `edix12` (no guarantee) | invalid | `negative`, `encoding`, `utf-16-bytes` |

> ⚠ **`negative/01-syntactic-missing-se.edi`** — ISA-level syntactic faults were avoided on purpose: pyx12 raises X12Error/IndexError out of X12Reader iteration for a short or reordered ISA envelope and the exception escapes parse_edix12 unwrapped (UNHANDLED in the pipeline); the missing-SE variant fails cleanly via the adapter's own EdiX12ParseError.

> ⚠ **`negative/02-semantic-nested-gs.edi`** — The canonical semantic negative (SE segment-count mismatch, e.g. SE*9 over 6 segments) does NOT fail here: pyx12 treats the count mismatch as non-fatal and the import completes all the way to persist, so the nested-GS contradiction is used instead.

### `fhir/` — FHIR R4

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-patient.json` | typical | `fhir` ≥ 0.95 | valid | `patient` |
| `02-patient-structuredefinition.json` | composition | `fhir` ≥ 0.95 | valid | `structure-definition`, `profiles-observation`, `differential` |
| `03-patient-profile.json` | composition | `fhir` ≥ 0.95 | valid | `structure-definition`, `profiles-patient`, `differential` |
| `04-minimal-patient.json` | minimal | `fhir` ≥ 0.95 | valid | `patient`, `resource-instance` |
| `05-vitals-panel-stress.json` | stress | `fhir` ≥ 0.95 | valid | `structure-definition`, `snapshot`, `choice-types`, `profiles-observation` |
| `06-capability-statement.json` | real-world | `fhir` ≥ 0.95 | valid | `capability-statement`, `rest-capabilities`, `search-parameters` |
| `negative/01-syntactic-unclosed-brace.json` | — | `fhir` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-structuredefinition-missing-type.json` | — | `fhir` (no guarantee) | invalid | `negative`, `semantic`, `structuredefinition-missing-type` |
| `negative/03-truncated-structuredefinition.json` | — | `fhir` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-openrpc.json` | — | `fhir` (no guarantee) | invalid | `negative`, `wrong-format`, `openrpc-document` |
| `negative/05-encoding-utf16-patient.json` | — | `fhir` (no guarantee) | invalid | `negative`, `encoding`, `utf-16-bytes` |

### `fix/` — FIX / FIX Orchestra

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-newordersingle.fix` | minimal | `fix` ≥ 0.95 | valid | `new-order-single` |
| `02-executionreport.fix` | typical | `fix` ≥ 0.95 | valid | `execution-report` |
| `02-orchestra.xml` ⚠ | composition | `fix` ≥ 0.9 | valid | `fixr-repository`, `code-sets`, `messages` |
| `03-cancel-replace-flow.fix` | typical | `fix` ≥ 0.95 | valid | `order-cancel-replace`, `order-cancel-request`, `session-log` |
| `04-repeating-groups-stress.fix` | stress | `fix` ≥ 0.95 | valid | `repeating-groups`, `party-ids`, `user-defined-tags`, `execution-report` |
| `05-order-lifecycle-session.fix` | real-world | `fix` ≥ 0.95 | valid | `logon`, `heartbeat`, `order-lifecycle`, `execution-report`, `logout` |
| `negative/01-syntactic-bare-token.fix` ⚠ | — | `fix` (no guarantee) | invalid | `negative`, `syntactic`, `bare-token` |
| `negative/02-semantic-missing-msgtype.fix` | — | `fix` (no guarantee) | invalid | `negative`, `semantic`, `missing-msgtype` |
| `negative/03-truncated-mid-tag.fix` ⚠ | — | `fix` (no guarantee) | invalid | `negative`, `truncated`, `mid-tag` |
| `negative/04-wrong-format-hl7-ack.hl7` | — | `fix` (no guarantee) | invalid | `negative`, `wrong-format`, `hl7-ack` |
| `negative/05-encoding-utf16-order.fix` ⚠ | — | `fix` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`02-orchestra.xml`** — FIX Orchestra XML is not yet recognized — currently misdetected as protobuf (weak 0.70 grpc-adapter keyword match) and the fix adapter has no Orchestra parser; expected_detection records the intended contract.

> ⚠ **`negative/01-syntactic-bare-token.fix`** — The fix sniffer is_fix() raises FixParseError on the bare token instead of returning False; the pipeline grounds the failure to INPUT_MALFORMED, but a direct adapter.detect() probe raises FixParseError.

> ⚠ **`negative/03-truncated-mid-tag.fix`** — The fix sniffer is_fix() raises FixParseError on the trailing bare tag instead of returning False; the pipeline grounds the failure to INPUT_MALFORMED, but a direct adapter.detect() probe raises FixParseError.

> ⚠ **`negative/05-encoding-utf16-order.fix`** — A direct adapter.detect() probe on the replacement-character text raises FixParseError (known is_fix sniffer bug); the pipeline classifies the file as INPUT_ENCODING_INVALID before that matters.

### `flatbuffers/` — FlatBuffers

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-monster.fbs` | typical | `flatbuffers` ≥ 0.95 | valid | `table`, `struct`, `enum`, `root-type`, `vector` |
| `02-minimal-ping.fbs` | minimal | `flatbuffers` ≥ 0.95 | valid | `table`, `root-type` |
| `03-shop-includes.fbs` | composition | `flatbuffers` ≥ 0.95 | valid | `include`, `namespace`, `table`, `vector`, `enum` |
| `04-robot-stress.fbs` | stress | `flatbuffers` ≥ 0.95 | valid | `union`, `struct`, `enum`, `vector`, `file-identifier`, `defaults` |
| `05-reflection.fbs` | real-world | `flatbuffers` ≥ 0.95 | valid | `table`, `enum`, `vector`, `root-type`, `defaults` |
| `06-telemetry.fbs` | typical | `flatbuffers` ≥ 0.95 | valid | `table`, `struct`, `enum`, `vector`, `root-type` |
| `negative/01-syntactic-unclosed-table.fbs` | — | `flatbuffers` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-table` |
| `negative/02-semantic-missing-root-table.fbs` | — | `flatbuffers` (no guarantee) | invalid | `negative`, `semantic`, `missing-root-table` |
| `negative/03-truncated-mid-field.fbs` | — | `flatbuffers` (no guarantee) | invalid | `negative`, `truncated`, `mid-field` |
| `negative/04-wrong-format-proto-widget.proto` | — | `flatbuffers` (no guarantee) | invalid | `negative`, `wrong-format`, `proto-schema` |
| `negative/05-encoding-utf16-ping.fbs` | — | `flatbuffers` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `graphql/` — GraphQL SDL

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-simple-user.graphql` | minimal | `graphql` ≥ 0.85 | valid | `simple-user`, `query`, `list-type` |
| `02-scalar-types.graphql` | typical | `graphql` ≥ 0.85 | valid | `scalar-types`, `query`, `scalar`, `list-type` |
| `03-enum-types.graphql` ⚠ | typical | `graphql` ≥ 0.85 | valid | `enum-types`, `query`, `enum`, `list-type` |
| `04-input-types.graphql` ⚠ | typical | `graphql` ≥ 0.85 | valid | `input-types`, `query`, `mutation`, `enum`, `input`, `defaults`, `list-type` |
| `05-interfaces.graphql` | composition | `graphql` ≥ 0.85 | valid | `interfaces`, `query`, `interface`, `list-type` |
| `06-union-types.graphql` ⚠ | composition | `graphql` ≥ 0.85 | valid | `union-types`, `query`, `union`, `defaults`, `list-type` |
| `07-nested-types.graphql` ⚠ | typical | `graphql` ≥ 0.85 | valid | `nested-types`, `query`, `enum`, `list-type` |
| `08-arguments-defaults.graphql` ⚠ | typical | `graphql` ≥ 0.85 | valid | `arguments-defaults`, `query`, `enum`, `defaults`, `list-type` |
| `09-custom-scalars.graphql` | typical | `graphql` ≥ 0.85 | valid | `custom-scalars`, `query`, `mutation`, `scalar`, `list-type` |
| `10-comprehensive-ecommerce.graphql` ⚠ | stress | `graphql` ≥ 0.85 | valid | `comprehensive-ecommerce`, `query`, `mutation`, `subscription`, `interface`, `union`, `enum`, `input`, `scalar`, `defaults`, `list-type` |
| `11-github-style-api.graphql` ⚠ | real-world | `graphql` ≥ 0.85 | valid | `github-style-api`, `query`, `mutation`, `interface`, `enum`, `input` |
| `12-storefront-set/products.graphql` | multi-file (member) | `graphql` ≥ 0.85 | valid | `storefront-set`, `extend-type`, `query`, `defaults`, `list-type` |
| `12-storefront-set/reviews.graphql` | multi-file (member) | `graphql` ≥ 0.85 | valid | `storefront-set`, `extend-type`, `defaults`, `list-type` |
| `12-storefront-set/schema.graphql` | multi-file (root) | `graphql` ≥ 0.85 | valid | `storefront-set`, `query`, `scalar`, `interface` |
| `negative/01-syntactic-unclosed-brace.graphql` | — | `graphql` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-unknown-type.graphql` | — | `graphql` (no guarantee) | invalid | `negative`, `semantic`, `unknown-type` |
| `negative/03-truncated-mid-definition.graphql` | — | `graphql` (no guarantee) | invalid | `negative`, `truncated`, `mid-definition` |
| `negative/04-wrong-format-proto-catalog.proto` | — | `graphql` (no guarantee) | invalid | `negative`, `wrong-format`, `proto-schema` |
| `negative/05-encoding-utf16-schema.graphql` | — | `graphql` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`03-enum-types.graphql`** — Currently outranked: detection ranks `smithy` (0.95) above `graphql` (0.90); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`04-input-types.graphql`** — Currently outranked: detection ranks `smithy` (0.95) above `graphql` (0.90); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`06-union-types.graphql`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`07-nested-types.graphql`** — Currently outranked: detection ranks `smithy` (0.95) above `graphql` (0.90); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`08-arguments-defaults.graphql`** — Currently outranked: detection ranks `smithy` (0.95) above `graphql` (0.90); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`10-comprehensive-ecommerce.graphql`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`11-github-style-api.graphql`** — Currently outranked: detection ranks `corbaidl` and `thrift` (0.95) above `graphql` (0.90) because the file pairs `interface Node {` with `enum` keywords; expected_detection records the intended winner for the detection-hardening work.

### `hl7v2/` — HL7 v2.x

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-adt-a01.hl7` | typical | `hl7v2` ≥ 0.95 | valid | `adt-a01`, `pid`, `pv1`, `nk1` |
| `02-oru-r01.hl7` | typical | `hl7v2` ≥ 0.95 | valid | `oru-r01`, `pid`, `obx`, `obr` |
| `03-minimal-ack.hl7` | minimal | `hl7v2` ≥ 0.95 | valid | `ack`, `msa` |
| `04-orm-o01-order.hl7` | typical | `hl7v2` ≥ 0.95 | valid | `orm-o01`, `orc`, `obr`, `nte` |
| `05-adt-a08-repetitions-escapes.hl7` | stress | `hl7v2` ≥ 0.95 | valid | `adt-a08`, `field-repetition`, `escape-sequences`, `subcomponents`, `z-segment` |
| `06-vxu-v04-immunization.hl7` | real-world | `hl7v2` ≥ 0.95 | valid | `vxu-v04`, `rxa`, `rxr`, `obx` |
| `negative/01-syntactic-empty-segment-id.hl7` | — | `hl7v2` (no guarantee) | invalid | `negative`, `syntactic`, `empty-segment-id` |
| `negative/02-semantic-msh-only.hl7` | — | `hl7v2` (no guarantee) | invalid | `negative`, `semantic`, `msh-only` |
| `negative/03-truncated-mid-msh.hl7` | — | `hl7v2` (no guarantee) | invalid | `negative`, `truncated`, `mid-msh` |
| `negative/04-wrong-format-fix-order.fix` | — | `hl7v2` (no guarantee) | invalid | `negative`, `wrong-format`, `fix-message` |
| `negative/05-encoding-utf16-ack.hl7` | — | `hl7v2` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `iso20022/` — ISO 20022

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-pain.001-credit-transfer.xml` | typical | `iso20022` ≥ 0.95 | valid | `pain.001`, `group-header` |
| `02-camt.053-statement.xml` | typical | `iso20022` ≥ 0.95 | valid | `camt.053`, `group-header` |
| `03-admi.004-system-event.xml` | minimal | `iso20022` ≥ 0.95 | valid | `admi.004`, `system-event` |
| `04-pain.008-direct-debit.xml` | composition | `iso20022` ≥ 0.95 | valid | `pain.008`, `group-header`, `component-reuse`, `sepa-mandate` |
| `05-camt.054-notification.xml` | stress | `iso20022` ≥ 0.95 | valid | `camt.054`, `prefixed-namespace`, `supplementary-data`, `currency-attributes` |
| `06-pacs.008-interbank-transfer.xml` | real-world | `iso20022` ≥ 0.95 | valid | `pacs.008`, `group-header`, `settlement-information`, `uetr` |
| `negative/01-syntactic-unclosed-tag.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-tag` |
| `negative/02-semantic-empty-document.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `semantic`, `empty-document` |
| `negative/03-truncated-mid-tag.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `truncated`, `mid-tag` |
| `negative/04-wrong-format-xsd-schema.xsd` | — | `iso20022` (no guarantee) | invalid | `negative`, `wrong-format`, `xsd-schema` |
| `negative/05-encoding-utf16-event.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `iso8583/` — ISO 8583

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-authorization-0100.json` | typical | `iso8583` ≥ 0.95 | valid | `mti-0100`, `data-elements` |
| `02-authorization-response-0110.json` | typical | `iso8583` ≥ 0.95 | valid | `mti-0110`, `data-elements` |
| `03-network-echo-0800.json` | minimal | `iso8583` ≥ 0.95 | valid | `mti-0800`, `data-elements`, `network-management` |
| `04-financial-request-0200.json` | typical | `iso8583` ≥ 0.95 | valid | `mti-0200`, `data-elements`, `track2`, `pos-entry-mode` |
| `05-reversal-advice-0420.json` | stress | `iso8583` ≥ 0.95 | valid | `mti-0420`, `snake-case-data-elements`, `variable-length`, `secondary-bitmap` |
| `06-atm-withdrawal-0200.json` | real-world | `iso8583` ≥ 0.95 | valid | `mti-0200`, `data-elements`, `atm-withdrawal`, `pin-block` |
| `negative/01-syntactic-unclosed-brace.json` | — | `iso8583` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-null-value.json` | — | `iso8583` (no guarantee) | invalid | `negative`, `semantic`, `null-data-element-value` |
| `negative/03-truncated-mid-element.json` ⚠ | — | `iso8583` (no guarantee) | invalid | `negative`, `truncated`, `cut-mid-token` |
| `negative/04-wrong-format-cloudevent.json` | — | `iso8583` (no guarantee) | invalid | `negative`, `wrong-format`, `cloudevents-event` |
| `negative/05-encoding-utf16.json` | — | `iso8583` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`negative/03-truncated-mid-element.json`** — Grounded FORMAT_MISMATCH rather than INPUT_MALFORMED: the greedy graphql sniffer claims the truncated JSON at 0.9 (`type` keyword match) and grpc claims it at 0.7, while iso8583's own detect cannot claim broken JSON.

### `json-schema/` — JSON Schema

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-simple-person.json` | minimal | `json-schema-2020-12` ≥ 0.9 | valid | `simple-person` |
| `02-product-types.json` | typical | `json-schema-2020-12` ≥ 0.9 | valid | `product-types`, `enum` |
| `03-multiple-defs.json` | composition | `json-schema-2020-12` ≥ 0.9 | valid | `multiple-defs`, `enum`, `defs` |
| `04-draft07-definitions.json` | composition | `json-schema` ≥ 0.9 | valid | `draft07-definitions`, `enum`, `defs` |
| `05-allof-inheritance.json` | composition | `json-schema-2020-12` ≥ 0.9 | valid | `allof-inheritance`, `oneOf`, `allOf`, `enum`, `const`, `defs` |
| `06-oneof-polymorphism.json` | composition | `json-schema-2020-12` ≥ 0.9 | valid | `oneof-polymorphism`, `oneOf`, `enum`, `const`, `defs` |
| `07-anyof-flexible.json` | composition | `json-schema-2020-12` ≥ 0.9 | valid | `anyof-flexible`, `anyOf`, `enum`, `const`, `defs` |
| `08-if-then-else.json` | stress | `json-schema-2020-12` ≥ 0.9 | valid | `if-then-else`, `allOf`, `enum`, `const`, `defs` |
| `09-advanced-features.json` | stress | `json-schema-2020-12` ≥ 0.9 | valid | `features`, `nullable`, `enum`, `const`, `contains`, `prefixItems`, `patternProperties`, `propertyNames`, `additionalProperties`, `dependentSchemas`, `dependentRequired`, `defs` |
| `10-comprehensive-ecommerce.json` | stress | `json-schema-2020-12` ≥ 0.9 | valid | `comprehensive-ecommerce`, `allOf`, `enum`, `patternProperties`, `additionalProperties`, `defs`, `multipleOf` |
| `11-geojson-feature.json` | real-world | `json-schema-2020-12` ≥ 0.9 | valid | `geojson-feature`, `oneOf`, `const`, `defs`, `nullable` |
| `negative/01-syntactic-unclosed-brace.json` | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-top-level-array.json` | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `semantic`, `top-level-array` |
| `negative/03-truncated-mid-token.json` ⚠ | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `truncated`, `cut-mid-token` |
| `negative/04-wrong-format-protobuf.proto` | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf-idl` |
| `negative/05-encoding-utf16.json` | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`negative/03-truncated-mid-token.json`** — Grounded FORMAT_MISMATCH rather than INPUT_MALFORMED: the greedy graphql sniffer claims the truncated JSON at 0.9 (`type` keyword match), while json-schema's own detect cannot claim broken JSON.

### `jtd/` — JSON Type Definition

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-user.jtd.json` | typical | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `elements`, `enum` |
| `02-order.jtd.json` | composition | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `elements`, `discriminator`, `definitions`, `ref` |
| `03-minimal-ping.jtd.json` | minimal | `jtd` ≥ 0.9 | valid | `properties`, `metadata` |
| `04-support-ticket.jtd.json` | typical | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `enum`, `elements`, `values`, `nullable` |
| `05-sensor-envelope-stress.jtd.json` | stress | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `definitions`, `discriminator`, `values`, `empty-form` |
| `06-github-push-event.jtd.json` | real-world | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `definitions`, `ref`, `elements`, `nullable` |
| `negative/01-syntactic-unclosed-brace.jtd.json` | — | `jtd` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-top-level-array.jtd.json` | — | `jtd` (no guarantee) | invalid | `negative`, `semantic`, `top-level-array` |
| `negative/03-truncated-mid-token.jtd.json` ⚠ | — | `jtd` (no guarantee) | invalid | `negative`, `truncated`, `cut-mid-token` |
| `negative/04-wrong-format-oncrpc.x` | — | `jtd` (no guarantee) | invalid | `negative`, `wrong-format`, `oncrpc-rpcl` |
| `negative/05-encoding-utf16.jtd.json` | — | `jtd` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`negative/03-truncated-mid-token.jtd.json`** — Grounded FORMAT_MISMATCH rather than INPUT_MALFORMED: the greedy graphql sniffer claims the truncated JSON at 0.9 (`type` keyword match), while jtd's own detect cannot claim broken JSON.

### `odata/` — OData v4 (EDMX)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-northwind.edmx` | real-world | `odata` ≥ 0.95 | valid | `entity-type`, `navigation`, `entity-set`, `keys` |
| `02-orders.edmx` | typical | `odata` ≥ 0.95 | valid | `entity-type`, `complex-type`, `entity-set`, `keys` |
| `03-minimal-service.edmx` | minimal | `odata` ≥ 0.95 | valid | `entity-type`, `entity-set`, `keys` |
| `04-inheritance-two-schemas.edmx` | composition | `odata` ≥ 0.95 | valid | `inheritance`, `base-type`, `multiple-schemas`, `complex-type`, `navigation` |
| `05-stress-service-surface.edmx` | stress | `odata` ≥ 0.95 | valid | `enum-type`, `type-definition`, `singleton`, `function`, `action`, `annotations` |
| `06-trippin-reference.edmx` | real-world | `odata` ≥ 0.95 | valid | `entity-type`, `complex-type`, `enum-type`, `singleton`, `navigation` |
| `negative/01-syntactic-mismatched-tag.edmx` | — | `odata` (no guarantee) | invalid | `negative`, `syntactic`, `mismatched-tag` |
| `negative/02-semantic-no-schema.edmx` | — | `odata` (no guarantee) | invalid | `negative`, `semantic`, `empty-data-services` |
| `negative/03-truncated-mid-tag.edmx` | — | `odata` (no guarantee) | invalid | `negative`, `truncated`, `cut-mid-token` |
| `negative/04-wrong-format-wsdl.wsdl` | — | `odata` (no guarantee) | invalid | `negative`, `wrong-format`, `wsdl-definitions` |
| `negative/05-encoding-utf16.edmx` | — | `odata` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `onc-rpc/` — ONC RPC / XDR

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-key-value-store.x` ⚠ | typical | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `union`, `typedef`, `enum`, `opaque` |
| `02-file-stat.x` ⚠ | minimal | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `enum` |
| `03-inventory-composition.x` ⚠ | composition | `oncrpc` ≥ 0.9 | valid | `typedef`, `struct`, `union`, `enum`, `program` |
| `04-job-queue-stress.x` ⚠ | stress | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `union`, `opaque`, `hyper`, `bool` |
| `05-portmapper-style.x` ⚠ | real-world | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `opaque` |
| `06-metrics-collector.x` ⚠ | typical | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `enum`, `hyper` |
| `negative/01-syntactic-unclosed-struct.x` | — | `oncrpc` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-struct` |
| `negative/02-semantic-missing-program-number.x` | — | `oncrpc` (no guarantee) | invalid | `negative`, `semantic`, `missing-program-number` |
| `negative/03-truncated-mid-field.x` | — | `oncrpc` (no guarantee) | invalid | `negative`, `truncated`, `cut-mid-token` |
| `negative/04-wrong-format-flatbuffers.fbs` | — | `oncrpc` (no guarantee) | invalid | `negative`, `wrong-format`, `flatbuffers-schema` |
| `negative/05-encoding-utf16.x` | — | `oncrpc` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`01-key-value-store.x`** — Currently outranked: detection ranks `flatbuffers` (0.96) above `oncrpc` (0.95); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`02-file-stat.x`** — Currently outranked: detection ranks `flatbuffers` (0.96) above `oncrpc` (0.95); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`03-inventory-composition.x`** — Currently outranked: detection ranks `flatbuffers` (0.96) above `oncrpc` (0.95); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`04-job-queue-stress.x`** — Currently outranked: detection ranks `flatbuffers` (0.96) above `oncrpc` (0.95); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`05-portmapper-style.x`** — Currently outranked: detection ranks `flatbuffers` (0.96) above `oncrpc` (0.95); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`06-metrics-collector.x`** — Currently outranked: detection ranks `flatbuffers` (0.96) above `oncrpc` (0.95); expected_detection records the intended winner for the detection-hardening work.

### `openapi/` — OpenAPI 3.x

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-numeric-constraints.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `numeric-constraints`, `multipleOf` |
| `02-array-contains.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `array-contains`, `enum`, `contains` |
| `03-object-properties.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `object-properties`, `patternProperties` |
| `04-constant-not.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `constant-not`, `not`, `const` |
| `05-dependent-schemas.yaml` ⚠ | stress | `openapi-3.1` ≥ 0.95 | valid | `dependent-schemas`, `if-then-else`, `enum`, `const`, `dependentSchemas` |
| `06-dependent-required.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `dependent-required`, `dependentRequired` |
| `07-nullable-types.yaml` | typical | `openapi-3.1` ≥ 0.95 | valid | `nullable-types`, `nullable` |
| `08-multiple-examples.yaml` | typical | `openapi-3.1` ≥ 0.95 | valid | `multiple-examples`, `enum` |
| `09-unevaluated-properties.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `unevaluated-properties`, `allOf`, `unevaluatedProperties` |
| `10-if-then-else.yaml` ⚠ | stress | `openapi-3.1` ≥ 0.95 | valid | `if-then-else`, `allOf`, `enum`, `const` |
| `10b-if-then-else-separate-rules.yaml` ⚠ | composition | `openapi-3.1` ≥ 0.95 | valid | `if-then-else-separate-rules`, `oneOf`, `allOf`, `discriminator`, `enum`, `const` |
| `11-unevaluated-items.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `unevaluated-items`, `const`, `prefixItems`, `unevaluatedItems` |
| `12-additional-properties-ref.yaml` | composition | `openapi-3.1` ≥ 0.95 | valid | `additional-properties-ref`, `const`, `additionalProperties` |
| `13-property-name-constraints.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `property-name-constraints`, `propertyNames`, `additionalProperties` |
| `14-custom-extensions.yaml` | typical | `openapi-3.1` ≥ 0.95 | valid | `custom-extensions`, `additionalProperties`, `x-extensions` |
| `15-external-docs.yaml` | typical | `openapi-3.1` ≥ 0.95 | valid | `external-docs`, `enum`, `externalDocs` |
| `16-discriminator-mapping.yaml` | composition | `openapi-3.1` ≥ 0.95 | valid | `discriminator-mapping`, `allOf`, `discriminator`, `x-extensions` |
| `17-deprecated-features.yaml` | typical | `openapi-3.1` ≥ 0.95 | valid | `deprecated-features`, `deprecated`, `x-extensions` |
| `18-prefix-items-tuples.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `prefix-items-tuples`, `nullable`, `enum`, `prefixItems` |
| `19-enumeration-sorting.yaml` | typical | `openapi-3.1` ≥ 0.95 | valid | `enumeration-sorting`, `enum` |
| `20-comprehensive-features.yaml` | stress | `openapi-3.1` ≥ 0.95 | valid | `comprehensive-features`, `if-then-else`, `enum`, `const`, `contains`, `prefixItems`, `propertyNames`, `additionalProperties`, `unevaluatedProperties`, `unevaluatedItems`, `dependentSchemas`, `dependentRequired`, `externalDocs`, `x-extensions`, `multipleOf` |
| `21-advanced-allof-inheritance.yaml` ⚠ | composition | `openapi-3.1` ≥ 0.95 | valid | `allof-inheritance`, `allOf`, `enum`, `additionalProperties` |
| `22-advanced-oneof-polymorphism.yaml` ⚠ | composition | `openapi-3.1` ≥ 0.95 | valid | `oneof-polymorphism`, `oneOf`, `discriminator`, `enum`, `const`, `additionalProperties` |
| `23-advanced-anyof-flexible.yaml` ⚠ | composition | `openapi-3.1` ≥ 0.95 | valid | `anyof-flexible`, `anyOf`, `enum`, `const` |
| `24-advanced-combined-composition.yaml` ⚠ | composition | `openapi-3.1` ≥ 0.95 | valid | `combined-composition`, `oneOf`, `anyOf`, `allOf`, `discriminator`, `enum`, `const`, `additionalProperties` |
| `25-test-property-conflict-diff.yaml` ⚠ | typical | `openapi-3.1` ≥ 0.95 | valid | `property-conflict-diff`, `enum`, `defs` |
| `26-test-property-edge-cases.yaml` ⚠ | stress | `openapi-3.1` ≥ 0.95 | valid | `property-edge-cases` |
| `27-test-property-mixed.yaml` ⚠ | typical | `openapi-3.1` ≥ 0.95 | valid | `property-mixed`, `additionalProperties`, `defs` |
| `28-test-property-reuse-same.yaml` ⚠ | typical | `openapi-3.1` ≥ 0.95 | valid | `property-reuse-same`, `enum` |
| `30-openapi-3.0-petstore.yaml` | real-world | `openapi-3.0` ≥ 0.95 | valid | `openapi-3.0-petstore`, `nullable` |
| `31-paths-comprehensive.yaml` | typical | `openapi-3.1` ≥ 0.95 | valid | `paths-comprehensive`, `enum` |
| `32-openapi-3.2.0-minimal.yaml` | minimal | `openapi-3.2` ≥ 0.95 | valid | `openapi-3.2.0-minimal` |
| `negative/01-syntactic-unclosed-flow-sequence.yaml` | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-flow-sequence` |
| `negative/02-truncated-mid-quoted-ref.yaml` | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `truncated`, `cut-mid-token` |
| `negative/03-wrong-format-graphql-sdl.graphql` | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `wrong-format`, `graphql-sdl` |
| `negative/04-encoding-utf16.yaml` | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |
| `negative/05-version-out-of-range.yaml` ⚠ | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `version-out-of-range`, `openapi-9.0.0` |

> ⚠ **`05-dependent-schemas.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`10-if-then-else.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`10b-if-then-else-separate-rules.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`21-advanced-allof-inheritance.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`22-advanced-oneof-polymorphism.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`23-advanced-anyof-flexible.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`24-advanced-combined-composition.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`25-test-property-conflict-diff.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`26-test-property-edge-cases.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`27-test-property-mixed.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`28-test-property-reuse-same.yaml`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`negative/05-version-out-of-range.yaml`** — Fails at the normalize phase (parse succeeds since the YAML is well-formed); the adapter's detect declines the 9.0.0 marker, so normalize raises and the pipeline grounds INPUT_SEMANTIC_INVALID.

### `openrpc/` — OpenRPC (JSON-RPC)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-wallet-api.json` | typical | `openrpc` ≥ 0.95 | valid | `methods`, `params`, `result`, `components` |
| `02-minimal-ping.json` | minimal | `openrpc` ≥ 0.95 | valid | `methods`, `result` |
| `03-components-refs.json` | composition | `openrpc` ≥ 0.95 | valid | `methods`, `components`, `refs`, `errors`, `contentDescriptors` |
| `04-stress-notifications.json` | stress | `openrpc` ≥ 0.95 | valid | `methods`, `params`, `notifications`, `paramStructure`, `errors`, `examples` |
| `05-ethereum-json-rpc.json` | real-world | `openrpc` ≥ 0.95 | valid | `methods`, `components`, `refs`, `oneOf` |
| `06-booking-service.json` | typical | `openrpc` ≥ 0.95 | valid | `methods`, `params`, `result`, `components`, `servers` |
| `negative/01-syntactic-unclosed-brace.json` | — | `openrpc` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-missing-info-title.json` | — | `openrpc` (no guarantee) | invalid | `negative`, `semantic`, `missing-info-title` |
| `negative/03-truncated-mid-token.json` | — | `openrpc` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-protobuf.proto` | — | `openrpc` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf-idl` |
| `negative/05-encoding-utf16.json` | — | `openrpc` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `postman/` — Postman v2.1

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-tasks-collection.postman_collection.json` | typical | `postman` ≥ 0.95 | valid | `items`, `requests`, `variables` |
| `02-minimal-ping.postman_collection.json` | minimal | `postman` ≥ 0.95 | valid | `requests`, `items` |
| `03-orders-service.postman_collection.json` | typical | `postman` ≥ 0.95 | valid | `requests`, `variables`, `headers`, `request-bodies`, `path-variables` |
| `04-folders-and-variables.postman_collection.json` | composition | `postman` ≥ 0.95 | valid | `folders`, `variables`, `requests` |
| `05-grammar-corners.postman_collection.json` | stress | `postman` ≥ 0.95 | valid | `query-parameters`, `path-variables`, `response-examples`, `headers`, `folders` |
| `06-stripe-style-payments.postman_collection.json` | real-world | `postman` ≥ 0.95 | valid | `requests`, `variables`, `headers`, `request-bodies`, `folders` |
| `negative/01-syntactic-unclosed-brace.postman_collection.json` | — | `postman` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-no-requests.postman_collection.json` | — | `postman` (no guarantee) | invalid | `negative`, `semantic`, `empty-item-array` |
| `negative/03-truncated-mid-token.postman_collection.json` | — | `postman` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-openrpc.json` | — | `postman` (no guarantee) | invalid | `negative`, `wrong-format`, `openrpc-document` |
| `negative/05-encoding-utf16.postman_collection.json` | — | `postman` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `protobuf/` — Protobuf / gRPC

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-simple-user.proto` | minimal | `protobuf` ≥ 0.95 | valid | `proto3`, `message`, `enum`, `repeated`, `package` |
| `02-grpc-service.proto` | typical | `protobuf` ≥ 0.95 | valid | `proto3`, `message`, `service`, `rpc`, `repeated`, `map`, `package` |
| `03-well-known-types.proto` | composition | `protobuf` ≥ 0.95 | valid | `proto3`, `message`, `import`, `well-known-types`, `package` |
| `04-telemetry-stress.proto` | stress | `protobuf` ≥ 0.95 | valid | `proto3`, `oneof`, `reserved`, `optional`, `map`, `streaming` |
| `05-pubsub-style.proto` | real-world | `protobuf` ≥ 0.95 | valid | `proto3`, `service`, `rpc`, `message`, `map`, `import` |
| `06-orders-set/order_service.proto` | multi-file (root) | `protobuf` ≥ 0.95 | valid | `proto3`, `service`, `rpc`, `import`, `package` |
| `06-orders-set/order_types.proto` | multi-file (member) | `protobuf` ≥ 0.95 | valid | `proto3`, `message`, `enum`, `repeated`, `package` |
| `negative/01-syntactic-unclosed-message.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-message` |
| `negative/02-semantic-duplicate-field-number.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `semantic`, `duplicate-field-number` |
| `negative/03-truncated-mid-message.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `truncated`, `mid-message` |
| `negative/04-unresolvable-ref-missing-import.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-import` |
| `negative/05-encoding-utf16-user.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `raml/` — RAML 1.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-simple-api.raml` | typical | `raml` ≥ 0.95 | valid | `types`, `methods`, `responses`, `base-uri` |
| `02-minimal-ping.raml` | minimal | `raml` ≥ 0.95 | valid | `methods`, `responses` |
| `03-orders-service.raml` | typical | `raml` ≥ 0.95 | valid | `types`, `methods`, `query-parameters`, `responses` |
| `04-resource-types-and-traits.raml` | composition | `raml` ≥ 0.95 | valid | `traits`, `resource-types`, `type-inheritance`, `enum` |
| `05-grammar-corners.raml` | stress | `raml` ≥ 0.95 | valid | `enum`, `optional-properties`, `security-schemes`, `annotations`, `file-type`, `nested-resources` |
| `06-github-style-api.raml` | real-world | `raml` ≥ 0.95 | valid | `types`, `methods`, `responses`, `nested-resources`, `query-parameters` |
| `negative/01-syntactic-unclosed-flow-sequence.raml` | — | `raml` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-flow-sequence` |
| `negative/02-semantic-missing-title.raml` | — | `raml` (no guarantee) | invalid | `negative`, `semantic`, `missing-title` |
| `negative/03-truncated-mid-token.raml` | — | `raml` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-openapi.yaml` | — | `raml` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi-document` |
| `negative/05-encoding-utf16.raml` | — | `raml` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `smithy/` — Smithy 2.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-weather-service.smithy` | typical | `smithy` ≥ 0.9 | valid | `service`, `operations`, `structure`, `list`, `enum`, `required` |
| `02-minimal-greeting.smithy` | minimal | `smithy` ≥ 0.9 | valid | `structure`, `required`, `namespace` |
| `03-bookstore-resource.smithy` | composition | `smithy` ≥ 0.9 | valid | `resource`, `service`, `operations`, `structure`, `list` |
| `04-grammar-corners.smithy` ⚠ | stress | `smithy` ≥ 0.9 | valid | `union`, `map`, `enum`, `error`, `traits`, `operations` |
| `05-dynamodb-style.smithy` ⚠ | real-world | `smithy` ≥ 0.9 | valid | `service`, `operations`, `union`, `map`, `list` |
| `06-orders-service.smithy` | typical | `smithy` ≥ 0.9 | valid | `service`, `operations`, `structure`, `list`, `enum` |
| `negative/01-syntactic-unclosed-brace.smithy` | — | `smithy` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-no-shapes.smithy` | — | `smithy` (no guarantee) | invalid | `negative`, `semantic`, `no-shapes` |
| `negative/03-truncated-mid-token.smithy` | — | `smithy` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-postman.postman_collection.json` | — | `smithy` (no guarantee) | invalid | `negative`, `wrong-format`, `postman-collection` |
| `negative/05-encoding-utf16.smithy` | — | `smithy` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`04-grammar-corners.smithy`** — Currently outranked: detection ranks `flatbuffers` (0.96, `union` definition) above `smithy` (0.95); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`05-dynamodb-style.smithy`** — Currently outranked: detection ranks `flatbuffers` (0.96, `union` definition) above `smithy` (0.95); expected_detection records the intended winner for the detection-hardening work.

### `swagger/` — Swagger 2.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-swagger-2-petstore.yaml` ⚠ | real-world | `swagger-2.0` ≥ 0.9 | valid | `nullable`, `enum`, `additionalProperties`, `defs`, `x-extensions` |

> ⚠ **`01-swagger-2-petstore.yaml`** — Currently outranked: detection ranks `api-blueprint` (0.98) above `swagger-2.0` (0.95); expected_detection records the intended winner for the detection-hardening work.

### `thrift/` — Apache Thrift

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-user-service.thrift` ⚠ | typical | `thrift` ≥ 0.9 | valid | `struct`, `service`, `enum`, `exceptions`, `optional`, `containers` |
| `02-minimal-ping.thrift` | minimal | `thrift` ≥ 0.9 | valid | `struct`, `namespace`, `required` |
| `03-order-includes.thrift` ⚠ | composition | `thrift` ≥ 0.9 | valid | `include`, `typedef`, `containers`, `struct`, `service` |
| `04-telemetry-stress.thrift` ⚠ | stress | `thrift` ≥ 0.9 | valid | `union`, `oneway`, `exceptions`, `containers`, `enum`, `typedef` |
| `05-evernote-notestore.thrift` ⚠ | real-world | `thrift` ≥ 0.9 | valid | `service`, `struct`, `exceptions`, `containers` |
| `06-payment-service.thrift` ⚠ | typical | `thrift` ≥ 0.9 | valid | `service`, `struct`, `enum`, `exceptions`, `optional` |
| `negative/01-syntactic-unclosed-brace.thrift` | — | `thrift` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-no-definitions.thrift` | — | `thrift` (no guarantee) | invalid | `negative`, `semantic`, `no-definitions` |
| `negative/03-truncated-mid-token.thrift` | — | `thrift` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-graphql.graphql` | — | `thrift` (no guarantee) | invalid | `negative`, `wrong-format`, `graphql-sdl` |
| `negative/05-encoding-utf16.thrift` | — | `thrift` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`01-user-service.thrift`** — Currently outranked: detection ranks `oncrpc` (0.95) and `smithy` (0.95) above `thrift` (0.95); expected_detection records the intended winner for the detection-hardening work. Import fidelity gap: the parser drops service-method parameters written inline before the closing paren (no `,`/`;`/newline after the last parameter name), so all three methods import with empty parameter lists.

> ⚠ **`03-order-includes.thrift`** — Currently outranked: detection ranks `oncrpc` (0.95) and `smithy` (0.95) above `thrift` (0.95); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`04-telemetry-stress.thrift`** — Currently outranked: detection ranks `flatbuffers` (0.96), `oncrpc` (0.95), and `smithy` (0.95) above `thrift` (0.95) — the Thrift `union` block also matches the FlatBuffers union marker; expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`05-evernote-notestore.thrift`** — Currently outranked: detection ranks `smithy` (0.95) above `thrift` (0.95); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`06-payment-service.thrift`** — Currently outranked: detection ranks `oncrpc` (0.95) and `smithy` (0.95) above `thrift` (0.95); expected_detection records the intended winner for the detection-hardening work.

### `typespec/` — TypeSpec

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-pets-api.tsp` | typical | `typespec` ≥ 0.95 | valid | `model`, `interface`, `routes`, `http-verbs`, `enum`, `namespace` |
| `02-orders-api.tsp` | typical | `typespec` ≥ 0.95 | valid | `model`, `interface`, `routes`, `http-verbs`, `enum`, `namespace` |
| `03-minimal-hello.tsp` | minimal | `typespec` ≥ 0.95 | valid | `model`, `namespace` |
| `04-composition-library.tsp` | composition | `typespec` ≥ 0.95 | valid | `model`, `spread`, `interface`, `routes`, `namespace` |
| `05-grammar-corners.tsp` | stress | `typespec` ≥ 0.95 | valid | `model`, `interface`, `routes`, `http-verbs`, `enum`, `headers` |
| `06-github-style.tsp` | real-world | `typespec` ≥ 0.95 | valid | `model`, `interface`, `routes`, `http-verbs`, `enum`, `namespace` |
| `negative/01-syntactic-unclosed-brace.tsp` | — | `typespec` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-no-definitions.tsp` | — | `typespec` (no guarantee) | invalid | `negative`, `semantic`, `no-definitions` |
| `negative/03-truncated-mid-token.tsp` | — | `typespec` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-raml.raml` | — | `typespec` (no guarantee) | invalid | `negative`, `wrong-format`, `raml-document` |
| `negative/05-encoding-utf16.tsp` | — | `typespec` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `wadl/` — WADL

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-bookstore.wadl` | typical | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `params`, `representations` |
| `02-status-ping.wadl` | minimal | `wadl` ≥ 0.95 | valid | `resources`, `methods` |
| `03-nested-catalog.wadl` | composition | `wadl` ≥ 0.95 | valid | `nested-resources`, `template-params`, `grammars`, `representations`, `element-refs` |
| `04-kitchen-sink.wadl` | stress | `wadl` ≥ 0.95 | valid | `params`, `matrix-params`, `header-params`, `status-codes`, `representations`, `doc` |
| `05-yahoo-news-search.wadl` | real-world | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `query-params`, `representations`, `grammars` |
| `06-task-tracker.wadl` | typical | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `params`, `representations` |
| `negative/01-syntactic-mismatched-close-tag.wadl` | — | `wadl` (no guarantee) | invalid | `negative`, `syntactic`, `mismatched-close-tag` |
| `negative/02-semantic-no-resources.wadl` | — | `wadl` (no guarantee) | invalid | `negative`, `semantic`, `no-resources` |
| `negative/03-truncated-mid-element.wadl` | — | `wadl` (no guarantee) | invalid | `negative`, `truncated`, `mid-element` |
| `negative/04-wrong-format-wsdl-definitions.wsdl` | — | `wadl` (no guarantee) | invalid | `negative`, `wrong-format`, `wsdl-definitions` |
| `negative/05-encoding-utf16-bom.wadl` | — | `wadl` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bom` |

### `wsdl/` — WSDL 1.1 (SOAP)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-calculator.wsdl` | minimal | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `soap` |
| `02-order-service.wsdl` | typical | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `faults` |
| `03-shared-types-import.wsdl` | composition | `wsdl` ≥ 0.95 | valid | `xsd-import`, `namespaces`, `type-reuse`, `port-type`, `binding` |
| `04-kitchen-sink.wsdl` | stress | `wsdl` ≥ 0.95 | valid | `rpc-style`, `one-way`, `soap12`, `multi-port`, `typed-parts`, `enumeration` |
| `05-global-weather.wsdl` | real-world | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `soap` |
| `06-bank-transfer.wsdl` | typical | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `faults` |
| `negative/01-syntactic-mismatched-close-tag.wsdl` | — | `wsdl` (no guarantee) | invalid | `negative`, `syntactic`, `mismatched-close-tag` |
| `negative/02-semantic-no-types-or-porttypes.wsdl` | — | `wsdl` (no guarantee) | invalid | `negative`, `semantic`, `no-types-or-porttypes` |
| `negative/03-truncated-mid-element.wsdl` | — | `wsdl` (no guarantee) | invalid | `negative`, `truncated`, `mid-element` |
| `negative/04-wrong-format-wadl-application.wadl` | — | `wsdl` (no guarantee) | invalid | `negative`, `wrong-format`, `wadl-application` |
| `negative/05-encoding-utf16-bom.wsdl` | — | `wsdl` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bom` |

### `xml-rpc/` — XML-RPC

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-method-call.xml` | typical | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params`, `struct`, `array` |
| `02-method-response.xml` ⚠ | typical | `xmlrpc` ≥ 0.95 | valid | `method-response`, `params`, `struct`, `fault` |
| `03-minimal-call.xml` | minimal | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params` |
| `04-system-multicall.xml` | composition | `xmlrpc` ≥ 0.95 | valid | `method-call`, `multicall`, `array`, `struct` |
| `05-all-types-response.xml` | stress | `xmlrpc` ≥ 0.95 | valid | `method-response`, `scalar-types`, `base64`, `dateTime.iso8601`, `nil`, `nested-arrays` |
| `06-wordpress-get-post.xml` | real-world | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params`, `array` |
| `negative/01-syntactic-unclosed-value-tag.xml` | — | `xmlrpc` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-value-tag` |
| `negative/02-semantic-missing-methodname.xml` | — | `xmlrpc` (no guarantee) | invalid | `negative`, `semantic`, `missing-methodname` |
| `negative/03-truncated-mid-element.xml` | — | `xmlrpc` (no guarantee) | invalid | `negative`, `truncated`, `mid-element` |
| `negative/04-wrong-format-protobuf-service.proto` | — | `xmlrpc` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf-service` |
| `negative/05-encoding-utf16-bom.xml` | — | `xmlrpc` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bom` |

> ⚠ **`02-method-response.xml`** — Features list claims `fault` but the file contains no <fault> element (a fault is only described in the header comment); either drop the tag or add a dedicated fault-response example so feature-based fixture selection is not misled.

### `xsd/` — XML Schema (XSD)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-purchase-order.xsd` | typical | `xsd` ≥ 0.95 | valid | `complex-type`, `simple-type`, `sequence`, `restrictions`, `enumeration`, `occurrence`, `attribute` |
| `02-minimal-note.xsd` | minimal | `xsd` ≥ 0.95 | valid | `complex-type`, `sequence` |
| `03-library-extension.xsd` | composition | `xsd` ≥ 0.95 | valid | `complex-content`, `extension`, `simple-type`, `type-reuse`, `attribute` |
| `04-kitchen-sink.xsd` | stress | `xsd` ≥ 0.95 | valid | `restrictions`, `union`, `list`, `choice`, `wildcard`, `annotation` |
| `05-ubl-invoice-shape.xsd` | real-world | `xsd` ≥ 0.95 | valid | `complex-type`, `attribute`, `enumeration`, `occurrence`, `sequence` |
| `06-employee-directory.xsd` | typical | `xsd` ≥ 0.95 | valid | `complex-type`, `simple-type`, `enumeration`, `occurrence`, `attribute` |
| `negative/01-syntactic-mismatched-close-tag.xsd` | — | `xsd` (no guarantee) | invalid | `negative`, `syntactic`, `mismatched-close-tag` |
| `negative/02-semantic-no-types-or-elements.xsd` | — | `xsd` (no guarantee) | invalid | `negative`, `semantic`, `no-types-or-elements` |
| `negative/03-truncated-mid-element.xsd` | — | `xsd` (no guarantee) | invalid | `negative`, `truncated`, `mid-element` |
| `negative/04-wrong-format-openapi-document.json` | — | `xsd` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi-document` |
| `negative/05-encoding-utf16-bom.xsd` | — | `xsd` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bom` |

### `zos-connect/` — z/OS Connect

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-api-requester.json` | typical | `zosconnect` ≥ 0.95 | valid | `api-requester`, `operations` |
| `02-api-provider.json` | typical | `zosconnect` ≥ 0.95 | valid | `api-provider`, `operations` |
| `03-minimal-requester.json` | minimal | `zosconnect` ≥ 0.95 | valid | `api-requester`, `operations` |
| `04-shared-structures-provider.json` | composition | `zosconnect` ≥ 0.95 | valid | `api-provider`, `operations`, `structure-reuse`, `path-parameters` |
| `05-stress-methods.json` | stress | `zosconnect` ≥ 0.95 | valid | `api-requester`, `operations`, `http-methods`, `path-parameters`, `pli` |
| `06-cics-catalog-provider.json` | real-world | `zosconnect` ≥ 0.95 | valid | `api-provider`, `operations`, `cics`, `cobol` |
| `negative/01-syntactic-trailing-comma.json` | — | `zosconnect` (no guarantee) | invalid | `negative`, `syntactic`, `trailing-comma` |
| `negative/02-semantic-missing-api-block.json` | — | `zosconnect` (no guarantee) | invalid | `negative`, `semantic`, `missing-api-block` |
| `negative/03-truncated-mid-string.json` | — | `zosconnect` (no guarantee) | invalid | `negative`, `truncated`, `mid-string` |
| `negative/04-wrong-format-protobuf-service.proto` | — | `zosconnect` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf-service` |
| `negative/05-encoding-utf16-bom.json` | — | `zosconnect` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bom` |

## Ladder waivers

Rungs that do not apply to an adapter's format, with the manifest-recorded justification (IXH-1.2 acceptance criterion).

| Adapter | Rung | Justification |
| --- | --- | --- |
| `apiblueprint` | multi-file | The API Blueprint adapter's parse_fileset only parses the root document and never resolves references across fileset members, so a multi-file set would exercise nothing beyond a single file. |
| `arazzo` | multi-file | The arazzo adapter has no parse_fileset, so a multi-file set cannot be imported together. |
| `asn1` | multi-file | Asn1ImportSource.parse_fileset only parses the root member (and the parser rejects more than one module per document), so cross-member resolution genuinely does not exist. |
| `avro` | multi-file | AvroImportSource.parse_fileset only parses the root member and never resolves references into other fileset members, so a multi-file set would demonstrate nothing. |
| `capnproto` | multi-file | CapnpImportSource.parse_fileset only parses the fileset root and never resolves imported members, so a multi-file set demonstrates nothing beyond a single file. |
| `cloudevents` | multi-file | CloudEventsImportSource.parse_fileset parses only the root member and resolves nothing across files, so a genuine multi-file set is not importable. |
| `cobolcopybook` | multi-file | COBOL COPY statements are not resolved and the cobolcopybook adapter's parse_fileset parses only the root member, so a multi-file set demonstrates nothing. |
| `corbaidl` | multi-file | CorbaIdlImportSource.parse_fileset only parses the fileset root and never resolves other members (and is_corbaidl rejects any text containing an include directive), so a multi-file set demonstrates nothing beyond a single file. |
| `edix12` | multi-file | EdiX12ImportSource.parse_fileset only parses the fileset root and resolves no references across members, so a multi-file set demonstrates nothing beyond a single interchange. |
| `fhir` | multi-file | The fhir adapter's parse_fileset only parses the root member and resolves nothing across members, so a genuine multi-file set does not apply. |
| `fix` | multi-file | FIX tag=value messages have no cross-file reference mechanism and the fix adapter's parse_fileset parses only the root member, so a multi-file set demonstrates nothing. |
| `flatbuffers` | multi-file | FlatBuffersImportSource.parse_fileset only parses the fileset root and never resolves included members, so a multi-file set demonstrates nothing beyond a single file. |
| `hl7v2` | composition | HL7 v2 pipe-and-hat messages are self-contained segment streams with no reference, include, import, or inheritance mechanism, so the composition rung does not apply. |
| `hl7v2` | multi-file | The hl7v2 adapter's parse_fileset only parses the root member and resolves nothing across members, so a genuine multi-file set does not apply. |
| `iso20022` | multi-file | Iso20022ImportSource.parse_fileset only parses the fileset root and resolves no references across members, so a multi-file set demonstrates nothing beyond a single message. |
| `iso8583` | composition | The ISO 8583 field-map grammar is a flat MTI plus numbered data elements with no reference, include, or reuse mechanism, so there is no composition to demonstrate. |
| `iso8583` | multi-file | Iso8583ImportSource.parse_fileset only parses the fileset root and resolves no references across members, so a multi-file set demonstrates nothing beyond a single document. |
| `json-schema` | multi-file | The json-schema adapter has no parse_fileset and does not resolve cross-file $ref targets, so schemas import as single self-contained documents. |
| `jtd` | multi-file | The jtd adapter has no parse_fileset; JTD (RFC 8927) documents carry their definitions inline and import as single self-contained files. |
| `odata` | multi-file | The odata adapter's parse_fileset only parses the root member and does not resolve edmx:Reference includes across other members, so a multi-file set exercises nothing. |
| `oncrpc` | multi-file | The ONC RPC adapter's parse_fileset only parses the root document and does not resolve references across fileset members, so a multi-file set would exercise nothing. |
| `openapi` | multi-file | The openapi adapter has no parse_fileset, so a multi-file set cannot be imported together. |
| `openrpc` | multi-file | The openrpc adapter's parse_fileset only parses the root member and does not resolve external $ref targets in other members, so a multi-file set exercises nothing. |
| `postman` | multi-file | The Postman adapter's parse_fileset only parses the root collection and never resolves references across fileset members, so a multi-file set would exercise nothing beyond a single file. |
| `raml` | multi-file | The RAML adapter's parse_fileset only parses the root document and never resolves !include or library references across fileset members, so a multi-file set would exercise nothing beyond a single file. |
| `smithy` | multi-file | The smithy adapter's parse_fileset parses only the root member and never resolves shapes defined in other members, so a multi-file set demonstrates nothing. |
| `thrift` | multi-file | ThriftImportSource.parse_fileset only parses the fileset root and never resolves included members, so a multi-file set demonstrates nothing beyond a single file. |
| `typespec` | multi-file | The typespec adapter's parse_fileset parses only the root member and does not resolve relative import statements across members, so a multi-file set demonstrates nothing. |
| `wadl` | multi-file | parse_fileset in wadl_import_source.py parses only the root member and never resolves references into other members (verified in source), so a multi-file set adds no coverage. |
| `wsdl` | multi-file | parse_fileset in wsdl_import_source.py parses only the root member and never reads or resolves other fileset members (verified in source), so a multi-file set would exercise nothing beyond the single-file rungs. |
| `xmlrpc` | multi-file | XmlRpcImportSource.parse_fileset parses only the root member and XML-RPC has no cross-file reference mechanism, so a genuine multi-file set is not importable. |
| `xsd` | multi-file | parse_fileset in xsd_import_source.py parses only the root member; xs:include/xs:import across members is never resolved (verified in source), so a multi-file set adds no coverage. |
| `zosconnect` | multi-file | The zosconnect adapter's parse_fileset only parses the root member and resolves no cross-file references (copybook structures are name references only), so a multi-file set exercises nothing. |

## Trying an import

In the ADE dashboard, open **Import**, pick **File Upload** (or **Clipboard Paste**), and drop one of these files. Detection names the format and the import lands as a catalog item (OpenAPI/Swagger/Arazzo route to publishable Projects).
