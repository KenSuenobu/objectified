# Catalog import examples

Sample source documents for exercising the catalog **Import** flow (the ImportDialog source cards → format auto-detection → catalog item). Each file is a small, self-contained document with a header comment explaining what it demonstrates.

> **Generated file — do not edit.** This README is the human index of [`corpus.manifest.json`](corpus.manifest.json) (schema: [`corpus.schema.json`](corpus.schema.json)). Edit the manifest, then run `python3 scripts/generate_examples_readme.py` from the repo root; CI fails on drift.

The corpus holds **256 files** across **36 format directories**. Every file has a manifest entry declaring its format family, the adapter that must claim it, its validity class, the detection contract (format key + minimum confidence), feature tags, and the expected import outcome.

## How the corpus is used

- **Format auto-detection** (`apiome-rest` `format_detection.py`) sniffs each file's content and names the format; the manifest's `expected_detection` records the contract detection must meet.
- **Tests select fixtures by tag, not by path**: `load_corpus(...)` in `apiome-rest/tests/corpus_loader.py` (pytest) and `loadCorpus(...)` in `apiome-ui/lib/corpus/corpus.ts` (Jest) filter entries by `format`, `validity_class`, `feature`, or `adapter_key`.
- **Catalog pills** (`apiome-ui` `catalog-format-registry.ts`) render the format, protocol/paradigm, and source-material badges off the imported item.

## Layout

### REST / HTTP

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `api-blueprint/` | API Blueprint | rest | `FORMAT: 1A` metadata line | 6 |
| `arazzo/` | Arazzo workflows | rest | top-level `arazzo:` version | 7 |
| `odata/` | OData v4 (EDMX) | rest | `<edmx:Edmx>` root | 6 |
| `openapi/` | OpenAPI 3.x | rest | top-level `openapi:` version | 32 |
| `postman/` | Postman v2.1 | rest | collection `info.schema` URL | 6 |
| `raml/` | RAML 1.0 | rest | `#%RAML 1.0` header | 6 |
| `swagger/` | Swagger 2.0 | rest | `swagger: "2.0"` | 1 |
| `typespec/` | TypeSpec | rest | `import "@typespec/..."` | 6 |
| `wadl/` | WADL | rest | `<application>` root (WADL namespace) | 6 |
| `wsdl/` | WSDL 1.1 (SOAP) | soap | `<wsdl:definitions>` root | 6 |
| `zos-connect/` | z/OS Connect | rest | `apiRequester` / `apiProvider` descriptor | 6 |

### RPC

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `connectrpc/` | Connect-RPC | rpc | Protobuf `service` (Connect) | 7 |
| `corba-idl/` | CORBA / OMG IDL | rpc | `module` + `interface` | 6 |
| `onc-rpc/` | ONC RPC / XDR | rpc | `program {} = N` + XDR types | 6 |
| `openrpc/` | OpenRPC (JSON-RPC) | rpc | top-level `openrpc:` version | 6 |
| `protobuf/` | Protobuf / gRPC | rpc | `syntax = "proto3"` | 7 |
| `smithy/` | Smithy 2.0 | rpc | `$version` + Smithy shapes | 6 |
| `thrift/` | Apache Thrift | rpc | `service` / `struct` shapes | 6 |
| `xml-rpc/` | XML-RPC | rpc | `<methodCall>` / `<methodResponse>` root | 6 |

### Event / messaging

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `asyncapi/` | AsyncAPI 2.x/3.0 | event | top-level `asyncapi:` version | 8 |
| `cloudevents/` | CloudEvents 1.0 | event | `specversion` + `type` + `source` envelope | 6 |

### Graph

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `graphql/` | GraphQL SDL | graph | root `type Query` / `schema {}` | 14 |

### Data schema

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `asn1/` | ASN.1 | data_schema | `DEFINITIONS ::= BEGIN … END` | 7 |
| `avro/` | Avro schema | data_schema | `type: record` + `fields` | 6 |
| `capnproto/` | Cap'n Proto | data_schema | `@0x…` file id + `struct` | 6 |
| `cobol-copybook/` | COBOL copybook | data_schema | level numbers + `PIC` clauses | 6 |
| `flatbuffers/` | FlatBuffers | data_schema | `table`/`struct` + `root_type` | 6 |
| `json-schema/` | JSON Schema | data_schema | `$schema` / `type` + `properties` | 11 |
| `jtd/` | JSON Type Definition | data_schema | `properties`/`optionalProperties` | 6 |
| `xsd/` | XML Schema (XSD) | data_schema | `xs:schema` root element | 6 |

### Industry / domain messaging

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `edi-x12/` | EDI ASC X12 | message | `ISA`/`GS`/`ST` envelopes | 6 |
| `fhir/` | FHIR R4 | data_schema | `resourceType` (+ StructureDefinition) | 6 |
| `fix/` | FIX / FIX Orchestra | message | `8=FIX.` tags / `<fixr:repository>` | 6 |
| `hl7v2/` | HL7 v2.x | message | `MSH\|^~\&\|` message header | 6 |
| `iso20022/` | ISO 20022 | message | `urn:iso:std:iso:20022` XML namespace | 6 |
| `iso8583/` | ISO 8583 | message | `mti` + numbered `dataElements` | 6 |

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

### `arazzo/` — Arazzo workflows

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `06-pet-coupons-real-world.yaml` | real-world | `arazzo` ≥ 0.95 | valid | `pet-coupons`, `workflows`, `steps`, `success-criteria`, `outputs`, `inputs` |
| `07-spec-grammar-stress.yaml` | stress | `arazzo` ≥ 0.95 | valid | `spec-grammar-stress`, `workflows`, `success-criteria`, `components`, `operationRef`, `dependsOn` |
| `edge-cases.yaml` | stress | `arazzo` ≥ 0.95 | valid | `edge-cases`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `mixed-scenarios.yaml` | composition | `arazzo` ≥ 0.95 | valid | `mixed-scenarios`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `property-conflicts.yaml` ⚠ | — | `arazzo` (no guarantee) | invalid | `property-conflicts`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `property-reuse.yaml` | typical | `arazzo` ≥ 0.95 | valid | `property-reuse`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `simple-workflow.yaml` | minimal | `arazzo` ≥ 0.95 | valid | `simple-workflow`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |

> ⚠ **`property-conflicts.yaml`** — Malformed YAML (mapping error at line 2) — the arazzo sniffer needs a parsed document, so detection currently falls through to a weak graphql match. Kept as the corpus's canonical `invalid` example; no detection guarantee.

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

> ⚠ **`06-payment-events-set/messages.yaml`** — Fileset member without an `asyncapi` marker — not independently detectable; imported only through the set root asyncapi.yaml, whose bundler chases this file's $refs into schemas.yaml.

> ⚠ **`06-payment-events-set/schemas.yaml`** — Fileset member without an `asyncapi` marker — not independently detectable; imported only through the set root asyncapi.yaml.

### `avro/` — Avro schema

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-user-record.avsc` | typical | `avro` ≥ 0.9 | valid | `record`, `enum`, `array`, `logical-types`, `nullable-union`, `defaults`, `docs` |
| `02-order-record.avsc` | typical | `avro` ≥ 0.9 | valid | `record`, `array`, `nested-records`, `logical-types`, `defaults`, `docs` |
| `03-minimal-record.avsc` | minimal | `avro` ≥ 0.9 | valid | `record`, `single-field` |
| `04-shared-types.avsc` | composition | `avro` ≥ 0.9 | valid | `record`, `enum`, `named-type-refs`, `map`, `array`, `logical-types` |
| `05-stress-mixed-types.avsc` | stress | `avro` ≥ 0.9 | valid | `record`, `fixed`, `map`, `multi-branch-union`, `aliases`, `logical-types` |
| `06-stripe-charge-shape.avsc` | real-world | `avro` ≥ 0.9 | valid | `record`, `enum`, `nested-records`, `nullable-union`, `map`, `logical-types` |

### `capnproto/` — Cap'n Proto

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-address-book.capnp` | typical | `capnproto` ≥ 0.95 | valid | `file-id`, `struct`, `enum`, `interface`, `list` |
| `02-minimal-ping.capnp` | minimal | `capnproto` ≥ 0.95 | valid | `file-id`, `struct` |
| `03-invoice-imports.capnp` | composition | `capnproto` ≥ 0.95 | valid | `file-id`, `imports`, `using-alias`, `nested-struct`, `interface` |
| `04-event-stress.capnp` ⚠ | stress | `capnproto` ≥ 0.95 | valid | `union`, `group`, `nested-enum`, `list`, `AnyPointer`, `const` |
| `05-compiler-schema.capnp` | real-world | `capnproto` ≥ 0.95 | valid | `file-id`, `struct`, `enum`, `nested-struct`, `list` |
| `06-task-queue.capnp` | typical | `capnproto` ≥ 0.95 | valid | `file-id`, `struct`, `enum`, `interface` |

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

> ⚠ **`03-order-lifecycle-batch.json`** — CloudEvents batch arrays are documented in cloudevents_parser (and is_cloudevents_document accepts lists), but both detect and parse delegate to parse_document, which rejects top-level JSON arrays — the adapter's detect returns no match (only the standalone sniffer reports cloudevents 0.85) and import currently fails; expected_detection records the intended contract for the detection-hardening work.

### `cobol-copybook/` — COBOL copybook

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-customer-record.cpy` | typical | `cobolcopybook` ≥ 0.95 | valid | `occurs-depending-on`, `occurs`, `comp-3`, `pic`, `level-88`, `values` |
| `02-order-line.cpy` | minimal | `cobolcopybook` ≥ 0.95 | valid | `comp-3`, `pic` |
| `03-payment-redefines.cpy` | composition | `cobolcopybook` ≥ 0.95 | valid | `redefines`, `level-88`, `comp-3`, `pic`, `filler` |
| `04-warehouse-stress.cpy` | stress | `cobolcopybook` ≥ 0.95 | valid | `occurs-depending-on`, `comp-3`, `comp`, `binary`, `filler`, `level-88` |
| `05-ach-entry-detail.cpy` | real-world | `cobolcopybook` ≥ 0.95 | valid | `pic`, `level-88`, `values` |
| `06-account-master.cpy` | typical | `cobolcopybook` ≥ 0.95 | valid | `pic`, `comp-3`, `level-88`, `nested-groups` |

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

### `corba-idl/` — CORBA / OMG IDL

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-bank.idl` | typical | `corbaidl` ≥ 0.95 | valid | `module`, `interface`, `struct`, `enum`, `exceptions`, `raises` |
| `02-inventory.idl` | typical | `corbaidl` ≥ 0.95 | valid | `module`, `interface`, `struct`, `exceptions`, `raises`, `sequence` |
| `03-minimal-echo.idl` | minimal | `corbaidl` ≥ 0.95 | valid | `module`, `interface` |
| `04-nested-modules.idl` | composition | `corbaidl` ≥ 0.95 | valid | `module`, `nested-modules`, `typedef`, `sequence`, `interface`, `raises` |
| `05-trading-stress.idl` | stress | `corbaidl` ≥ 0.95 | valid | `oneway`, `parameter-directions`, `attributes`, `sequence`, `exceptions`, `enum` |
| `06-cosnaming.idl` | real-world | `corbaidl` ≥ 0.95 | valid | `module`, `interface`, `struct`, `exceptions`, `raises`, `sequence` |

### `edi-x12/` — EDI ASC X12

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-850-purchase-order.edi` | typical | `edix12` ≥ 0.9 | valid | `850-purchase-order`, `isa-envelope`, `iea-trailer` |
| `02-810-invoice.edi` | typical | `edix12` ≥ 0.9 | valid | `810-invoice`, `isa-envelope`, `iea-trailer` |
| `03-997-acknowledgment.edi` | minimal | `edix12` ≥ 0.9 | valid | `997-acknowledgment`, `isa-envelope`, `iea-trailer` |
| `04-multi-group-po-ack.edi` | composition | `edix12` ≥ 0.9 | valid | `multi-functional-group`, `850-purchase-order`, `997-acknowledgment`, `isa-envelope` |
| `05-856-asn-hierarchical.edi` | stress | `edix12` ≥ 0.9 | valid | `856-ship-notice`, `hl-loops`, `ta1-acknowledgment`, `multi-transaction-set` |
| `06-834-benefit-enrollment.edi` | real-world | `edix12` ≥ 0.9 | valid | `834-benefit-enrollment`, `hipaa-5010`, `isa-envelope`, `iea-trailer` |

### `fhir/` — FHIR R4

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-patient.json` | typical | `fhir` ≥ 0.95 | valid | `patient` |
| `02-patient-structuredefinition.json` | composition | `fhir` ≥ 0.95 | valid | `structure-definition`, `profiles-observation`, `differential` |
| `03-patient-profile.json` | composition | `fhir` ≥ 0.95 | valid | `structure-definition`, `profiles-patient`, `differential` |
| `04-minimal-patient.json` | minimal | `fhir` ≥ 0.95 | valid | `patient`, `resource-instance` |
| `05-vitals-panel-stress.json` | stress | `fhir` ≥ 0.95 | valid | `structure-definition`, `snapshot`, `choice-types`, `profiles-observation` |
| `06-capability-statement.json` | real-world | `fhir` ≥ 0.95 | valid | `capability-statement`, `rest-capabilities`, `search-parameters` |

### `fix/` — FIX / FIX Orchestra

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-newordersingle.fix` | minimal | `fix` ≥ 0.95 | valid | `new-order-single` |
| `02-executionreport.fix` | typical | `fix` ≥ 0.95 | valid | `execution-report` |
| `02-orchestra.xml` ⚠ | composition | `fix` ≥ 0.9 | valid | `fixr-repository`, `code-sets`, `messages` |
| `03-cancel-replace-flow.fix` | typical | `fix` ≥ 0.95 | valid | `order-cancel-replace`, `order-cancel-request`, `session-log` |
| `04-repeating-groups-stress.fix` | stress | `fix` ≥ 0.95 | valid | `repeating-groups`, `party-ids`, `user-defined-tags`, `execution-report` |
| `05-order-lifecycle-session.fix` | real-world | `fix` ≥ 0.95 | valid | `logon`, `heartbeat`, `order-lifecycle`, `execution-report`, `logout` |

> ⚠ **`02-orchestra.xml`** — FIX Orchestra XML is not yet recognized — currently misdetected as protobuf (weak 0.70 grpc-adapter keyword match) and the fix adapter has no Orchestra parser; expected_detection records the intended contract.

### `flatbuffers/` — FlatBuffers

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-monster.fbs` | typical | `flatbuffers` ≥ 0.95 | valid | `table`, `struct`, `enum`, `root-type`, `vector` |
| `02-minimal-ping.fbs` | minimal | `flatbuffers` ≥ 0.95 | valid | `table`, `root-type` |
| `03-shop-includes.fbs` | composition | `flatbuffers` ≥ 0.95 | valid | `include`, `namespace`, `table`, `vector`, `enum` |
| `04-robot-stress.fbs` | stress | `flatbuffers` ≥ 0.95 | valid | `union`, `struct`, `enum`, `vector`, `file-identifier`, `defaults` |
| `05-reflection.fbs` | real-world | `flatbuffers` ≥ 0.95 | valid | `table`, `enum`, `vector`, `root-type`, `defaults` |
| `06-telemetry.fbs` | typical | `flatbuffers` ≥ 0.95 | valid | `table`, `struct`, `enum`, `vector`, `root-type` |

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

### `iso20022/` — ISO 20022

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-pain.001-credit-transfer.xml` | typical | `iso20022` ≥ 0.95 | valid | `pain.001`, `group-header` |
| `02-camt.053-statement.xml` | typical | `iso20022` ≥ 0.95 | valid | `camt.053`, `group-header` |
| `03-admi.004-system-event.xml` | minimal | `iso20022` ≥ 0.95 | valid | `admi.004`, `system-event` |
| `04-pain.008-direct-debit.xml` | composition | `iso20022` ≥ 0.95 | valid | `pain.008`, `group-header`, `component-reuse`, `sepa-mandate` |
| `05-camt.054-notification.xml` | stress | `iso20022` ≥ 0.95 | valid | `camt.054`, `prefixed-namespace`, `supplementary-data`, `currency-attributes` |
| `06-pacs.008-interbank-transfer.xml` | real-world | `iso20022` ≥ 0.95 | valid | `pacs.008`, `group-header`, `settlement-information`, `uetr` |

### `iso8583/` — ISO 8583

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-authorization-0100.json` | typical | `iso8583` ≥ 0.95 | valid | `mti-0100`, `data-elements` |
| `02-authorization-response-0110.json` | typical | `iso8583` ≥ 0.95 | valid | `mti-0110`, `data-elements` |
| `03-network-echo-0800.json` | minimal | `iso8583` ≥ 0.95 | valid | `mti-0800`, `data-elements`, `network-management` |
| `04-financial-request-0200.json` | typical | `iso8583` ≥ 0.95 | valid | `mti-0200`, `data-elements`, `track2`, `pos-entry-mode` |
| `05-reversal-advice-0420.json` | stress | `iso8583` ≥ 0.95 | valid | `mti-0420`, `snake-case-data-elements`, `variable-length`, `secondary-bitmap` |
| `06-atm-withdrawal-0200.json` | real-world | `iso8583` ≥ 0.95 | valid | `mti-0200`, `data-elements`, `atm-withdrawal`, `pin-block` |

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

### `jtd/` — JSON Type Definition

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-user.jtd.json` | typical | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `elements`, `enum` |
| `02-order.jtd.json` | composition | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `elements`, `discriminator`, `definitions`, `ref` |
| `03-minimal-ping.jtd.json` | minimal | `jtd` ≥ 0.9 | valid | `properties`, `metadata` |
| `04-support-ticket.jtd.json` | typical | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `enum`, `elements`, `values`, `nullable` |
| `05-sensor-envelope-stress.jtd.json` | stress | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `definitions`, `discriminator`, `values`, `empty-form` |
| `06-github-push-event.jtd.json` | real-world | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `definitions`, `ref`, `elements`, `nullable` |

### `odata/` — OData v4 (EDMX)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-northwind.edmx` | real-world | `odata` ≥ 0.95 | valid | `entity-type`, `navigation`, `entity-set`, `keys` |
| `02-orders.edmx` | typical | `odata` ≥ 0.95 | valid | `entity-type`, `complex-type`, `entity-set`, `keys` |
| `03-minimal-service.edmx` | minimal | `odata` ≥ 0.95 | valid | `entity-type`, `entity-set`, `keys` |
| `04-inheritance-two-schemas.edmx` | composition | `odata` ≥ 0.95 | valid | `inheritance`, `base-type`, `multiple-schemas`, `complex-type`, `navigation` |
| `05-stress-service-surface.edmx` | stress | `odata` ≥ 0.95 | valid | `enum-type`, `type-definition`, `singleton`, `function`, `action`, `annotations` |
| `06-trippin-reference.edmx` | real-world | `odata` ≥ 0.95 | valid | `entity-type`, `complex-type`, `enum-type`, `singleton`, `navigation` |

### `onc-rpc/` — ONC RPC / XDR

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-key-value-store.x` ⚠ | typical | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `union`, `typedef`, `enum`, `opaque` |
| `02-file-stat.x` ⚠ | minimal | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `enum` |
| `03-inventory-composition.x` ⚠ | composition | `oncrpc` ≥ 0.9 | valid | `typedef`, `struct`, `union`, `enum`, `program` |
| `04-job-queue-stress.x` ⚠ | stress | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `union`, `opaque`, `hyper`, `bool` |
| `05-portmapper-style.x` ⚠ | real-world | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `opaque` |
| `06-metrics-collector.x` ⚠ | typical | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `enum`, `hyper` |

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

### `openrpc/` — OpenRPC (JSON-RPC)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-wallet-api.json` | typical | `openrpc` ≥ 0.95 | valid | `methods`, `params`, `result`, `components` |
| `02-minimal-ping.json` | minimal | `openrpc` ≥ 0.95 | valid | `methods`, `result` |
| `03-components-refs.json` | composition | `openrpc` ≥ 0.95 | valid | `methods`, `components`, `refs`, `errors`, `contentDescriptors` |
| `04-stress-notifications.json` | stress | `openrpc` ≥ 0.95 | valid | `methods`, `params`, `notifications`, `paramStructure`, `errors`, `examples` |
| `05-ethereum-json-rpc.json` | real-world | `openrpc` ≥ 0.95 | valid | `methods`, `components`, `refs`, `oneOf` |
| `06-booking-service.json` | typical | `openrpc` ≥ 0.95 | valid | `methods`, `params`, `result`, `components`, `servers` |

### `postman/` — Postman v2.1

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-tasks-collection.postman_collection.json` | typical | `postman` ≥ 0.95 | valid | `items`, `requests`, `variables` |
| `02-minimal-ping.postman_collection.json` | minimal | `postman` ≥ 0.95 | valid | `requests`, `items` |
| `03-orders-service.postman_collection.json` | typical | `postman` ≥ 0.95 | valid | `requests`, `variables`, `headers`, `request-bodies`, `path-variables` |
| `04-folders-and-variables.postman_collection.json` | composition | `postman` ≥ 0.95 | valid | `folders`, `variables`, `requests` |
| `05-grammar-corners.postman_collection.json` | stress | `postman` ≥ 0.95 | valid | `query-parameters`, `path-variables`, `response-examples`, `headers`, `folders` |
| `06-stripe-style-payments.postman_collection.json` | real-world | `postman` ≥ 0.95 | valid | `requests`, `variables`, `headers`, `request-bodies`, `folders` |

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

### `raml/` — RAML 1.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-simple-api.raml` | typical | `raml` ≥ 0.95 | valid | `types`, `methods`, `responses`, `base-uri` |
| `02-minimal-ping.raml` | minimal | `raml` ≥ 0.95 | valid | `methods`, `responses` |
| `03-orders-service.raml` | typical | `raml` ≥ 0.95 | valid | `types`, `methods`, `query-parameters`, `responses` |
| `04-resource-types-and-traits.raml` | composition | `raml` ≥ 0.95 | valid | `traits`, `resource-types`, `type-inheritance`, `enum` |
| `05-grammar-corners.raml` | stress | `raml` ≥ 0.95 | valid | `enum`, `optional-properties`, `security-schemes`, `annotations`, `file-type`, `nested-resources` |
| `06-github-style-api.raml` | real-world | `raml` ≥ 0.95 | valid | `types`, `methods`, `responses`, `nested-resources`, `query-parameters` |

### `smithy/` — Smithy 2.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-weather-service.smithy` | typical | `smithy` ≥ 0.9 | valid | `service`, `operations`, `structure`, `list`, `enum`, `required` |
| `02-minimal-greeting.smithy` | minimal | `smithy` ≥ 0.9 | valid | `structure`, `required`, `namespace` |
| `03-bookstore-resource.smithy` | composition | `smithy` ≥ 0.9 | valid | `resource`, `service`, `operations`, `structure`, `list` |
| `04-grammar-corners.smithy` ⚠ | stress | `smithy` ≥ 0.9 | valid | `union`, `map`, `enum`, `error`, `traits`, `operations` |
| `05-dynamodb-style.smithy` ⚠ | real-world | `smithy` ≥ 0.9 | valid | `service`, `operations`, `union`, `map`, `list` |
| `06-orders-service.smithy` | typical | `smithy` ≥ 0.9 | valid | `service`, `operations`, `structure`, `list`, `enum` |

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

### `wadl/` — WADL

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-bookstore.wadl` | typical | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `params`, `representations` |
| `02-status-ping.wadl` | minimal | `wadl` ≥ 0.95 | valid | `resources`, `methods` |
| `03-nested-catalog.wadl` | composition | `wadl` ≥ 0.95 | valid | `nested-resources`, `template-params`, `grammars`, `representations`, `element-refs` |
| `04-kitchen-sink.wadl` | stress | `wadl` ≥ 0.95 | valid | `params`, `matrix-params`, `header-params`, `status-codes`, `representations`, `doc` |
| `05-yahoo-news-search.wadl` | real-world | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `query-params`, `representations`, `grammars` |
| `06-task-tracker.wadl` | typical | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `params`, `representations` |

### `wsdl/` — WSDL 1.1 (SOAP)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-calculator.wsdl` | minimal | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `soap` |
| `02-order-service.wsdl` | typical | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `faults` |
| `03-shared-types-import.wsdl` | composition | `wsdl` ≥ 0.95 | valid | `xsd-import`, `namespaces`, `type-reuse`, `port-type`, `binding` |
| `04-kitchen-sink.wsdl` | stress | `wsdl` ≥ 0.95 | valid | `rpc-style`, `one-way`, `soap12`, `multi-port`, `typed-parts`, `enumeration` |
| `05-global-weather.wsdl` | real-world | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `soap` |
| `06-bank-transfer.wsdl` | typical | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `faults` |

### `xml-rpc/` — XML-RPC

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-method-call.xml` | typical | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params`, `struct`, `array` |
| `02-method-response.xml` ⚠ | typical | `xmlrpc` ≥ 0.95 | valid | `method-response`, `params`, `struct`, `fault` |
| `03-minimal-call.xml` | minimal | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params` |
| `04-system-multicall.xml` | composition | `xmlrpc` ≥ 0.95 | valid | `method-call`, `multicall`, `array`, `struct` |
| `05-all-types-response.xml` | stress | `xmlrpc` ≥ 0.95 | valid | `method-response`, `scalar-types`, `base64`, `dateTime.iso8601`, `nil`, `nested-arrays` |
| `06-wordpress-get-post.xml` | real-world | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params`, `array` |

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

### `zos-connect/` — z/OS Connect

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-api-requester.json` | typical | `zosconnect` ≥ 0.95 | valid | `api-requester`, `operations` |
| `02-api-provider.json` | typical | `zosconnect` ≥ 0.95 | valid | `api-provider`, `operations` |
| `03-minimal-requester.json` | minimal | `zosconnect` ≥ 0.95 | valid | `api-requester`, `operations` |
| `04-shared-structures-provider.json` | composition | `zosconnect` ≥ 0.95 | valid | `api-provider`, `operations`, `structure-reuse`, `path-parameters` |
| `05-stress-methods.json` | stress | `zosconnect` ≥ 0.95 | valid | `api-requester`, `operations`, `http-methods`, `path-parameters`, `pli` |
| `06-cics-catalog-provider.json` | real-world | `zosconnect` ≥ 0.95 | valid | `api-provider`, `operations`, `cics`, `cobol` |

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
