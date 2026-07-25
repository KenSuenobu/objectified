# Catalog import examples

Sample source documents for exercising the catalog **Import** flow (the ImportDialog source cards → format auto-detection → catalog item). Each file is a small, self-contained document with a header comment explaining what it demonstrates.

> **Generated file — do not edit.** This README is the human index of [`corpus.manifest.json`](corpus.manifest.json) (schema: [`corpus.schema.json`](corpus.schema.json)). Edit the manifest, then run `python3 scripts/generate_examples_readme.py` from the repo root; CI fails on drift.

The corpus holds **109 files** across **36 format directories**. Every file has a manifest entry declaring its format family, the adapter that must claim it, its validity class, the detection contract (format key + minimum confidence), feature tags, and the expected import outcome.

## How the corpus is used

- **Format auto-detection** (`apiome-rest` `format_detection.py`) sniffs each file's content and names the format; the manifest's `expected_detection` records the contract detection must meet.
- **Tests select fixtures by tag, not by path**: `load_corpus(...)` in `apiome-rest/tests/corpus_loader.py` (pytest) and `loadCorpus(...)` in `apiome-ui/lib/corpus/corpus.ts` (Jest) filter entries by `format`, `validity_class`, `feature`, or `adapter_key`.
- **Catalog pills** (`apiome-ui` `catalog-format-registry.ts`) render the format, protocol/paradigm, and source-material badges off the imported item.

## Layout

### REST / HTTP

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `api-blueprint/` | API Blueprint | rest | `FORMAT: 1A` metadata line | 1 |
| `arazzo/` | Arazzo workflows | rest | top-level `arazzo:` version | 5 |
| `odata/` | OData v4 (EDMX) | rest | `<edmx:Edmx>` root | 2 |
| `openapi/` | OpenAPI 3.x | rest | top-level `openapi:` version | 32 |
| `postman/` | Postman v2.1 | rest | collection `info.schema` URL | 1 |
| `raml/` | RAML 1.0 | rest | `#%RAML 1.0` header | 1 |
| `swagger/` | Swagger 2.0 | rest | `swagger: "2.0"` | 1 |
| `typespec/` | TypeSpec | rest | `import "@typespec/..."` | 2 |
| `wadl/` | WADL | rest | `<application>` root (WADL namespace) | 1 |
| `wsdl/` | WSDL 1.1 (SOAP) | soap | `<wsdl:definitions>` root | 1 |
| `zos-connect/` | z/OS Connect | rest | `apiRequester` / `apiProvider` descriptor | 2 |

### RPC

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `connectrpc/` | Connect-RPC | rpc | Protobuf `service` (Connect) | 1 |
| `corba-idl/` | CORBA / OMG IDL | rpc | `module` + `interface` | 2 |
| `onc-rpc/` | ONC RPC / XDR | rpc | `program {} = N` + XDR types | 2 |
| `openrpc/` | OpenRPC (JSON-RPC) | rpc | top-level `openrpc:` version | 1 |
| `protobuf/` | Protobuf / gRPC | rpc | `syntax = "proto3"` | 2 |
| `smithy/` | Smithy 2.0 | rpc | `$version` + Smithy shapes | 1 |
| `thrift/` | Apache Thrift | rpc | `service` / `struct` shapes | 1 |
| `xml-rpc/` | XML-RPC | rpc | `<methodCall>` / `<methodResponse>` root | 2 |

### Event / messaging

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `asyncapi/` | AsyncAPI 2.x/3.0 | event | top-level `asyncapi:` version | 2 |
| `cloudevents/` | CloudEvents 1.0 | event | `specversion` + `type` + `source` envelope | 1 |

### Graph

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `graphql/` | GraphQL SDL | graph | root `type Query` / `schema {}` | 10 |

### Data schema

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `asn1/` | ASN.1 | data_schema | `DEFINITIONS ::= BEGIN … END` | 2 |
| `avro/` | Avro schema | data_schema | `type: record` + `fields` | 2 |
| `capnproto/` | Cap'n Proto | data_schema | `@0x…` file id + `struct` | 1 |
| `cobol-copybook/` | COBOL copybook | data_schema | level numbers + `PIC` clauses | 2 |
| `flatbuffers/` | FlatBuffers | data_schema | `table`/`struct` + `root_type` | 1 |
| `json-schema/` | JSON Schema | data_schema | `$schema` / `type` + `properties` | 10 |
| `jtd/` | JSON Type Definition | data_schema | `properties`/`optionalProperties` | 2 |
| `xsd/` | XML Schema (XSD) | data_schema | `xs:schema` root element | 1 |

### Industry / domain messaging

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `edi-x12/` | EDI ASC X12 | message | `ISA`/`GS`/`ST` envelopes | 2 |
| `fhir/` | FHIR R4 | data_schema | `resourceType` (+ StructureDefinition) | 3 |
| `fix/` | FIX / FIX Orchestra | message | `8=FIX.` tags / `<fixr:repository>` | 3 |
| `hl7v2/` | HL7 v2.x | message | `MSH\|^~\&\|` message header | 2 |
| `iso20022/` | ISO 20022 | message | `urn:iso:std:iso:20022` XML namespace | 2 |
| `iso8583/` | ISO 8583 | message | `mti` + numbered `dataElements` | 2 |

## File index

Validity classes: `valid` imports cleanly · `invalid` must be rejected · `adversarial` tries to confuse detection · `scale` stresses limits.

### `api-blueprint/` — API Blueprint

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-simple-api.apib` | `api-blueprint` ≥ 0.95 | valid | `responses`, `parameters`, `resources` |

### `arazzo/` — Arazzo workflows

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `edge-cases.yaml` | `arazzo` ≥ 0.95 | valid | `edge-cases`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `mixed-scenarios.yaml` | `arazzo` ≥ 0.95 | valid | `mixed-scenarios`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `property-conflicts.yaml` ⚠ | `arazzo` (no guarantee) | invalid | `property-conflicts`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `property-reuse.yaml` | `arazzo` ≥ 0.95 | valid | `property-reuse`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `simple-workflow.yaml` | `arazzo` ≥ 0.95 | valid | `simple-workflow`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |

> ⚠ **`property-conflicts.yaml`** — Malformed YAML (mapping error at line 2) — the arazzo sniffer needs a parsed document, so detection currently falls through to a weak graphql match. Kept as the corpus's canonical `invalid` example; no detection guarantee.

### `asn1/` — ASN.1

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-person.asn1` | `asn1` ≥ 0.9 | valid | `sequence-of`, `sequence`, `choice`, `enumerated`, `optional`, `defaults` |
| `02-identifier.asn1` | `asn1` ≥ 0.9 | valid | `sequence`, `choice`, `enumerated`, `defaults` |

### `asyncapi/` — AsyncAPI 2.x/3.0

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-user-events-2.6.yaml` | `asyncapi-2` ≥ 0.95 | valid | `channels`, `subscribe`, `messages`, `components`, `servers`, `payload` |
| `02-order-events-3.0.yaml` | `asyncapi-3` ≥ 0.95 | valid | `channels`, `operations`, `messages`, `components`, `servers`, `payload` |

### `avro/` — Avro schema

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-user-record.avsc` | `avro` ≥ 0.9 | valid | `record`, `enum`, `array`, `logical-types`, `nullable-union`, `defaults`, `docs` |
| `02-order-record.avsc` | `avro` ≥ 0.9 | valid | `record`, `array`, `nested-records`, `logical-types`, `defaults`, `docs` |

### `capnproto/` — Cap'n Proto

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-address-book.capnp` | `capnproto` ≥ 0.95 | valid | `file-id`, `struct`, `enum`, `interface`, `list` |

### `cloudevents/` — CloudEvents 1.0

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-order-created.json` | `cloudevents` ≥ 0.95 | valid | `envelope`, `data-content-type`, `data-payload` |

### `cobol-copybook/` — COBOL copybook

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-customer-record.cpy` | `cobolcopybook` ≥ 0.95 | valid | `occurs-depending-on`, `occurs`, `comp-3`, `pic`, `level-88`, `values` |
| `02-order-line.cpy` | `cobolcopybook` ≥ 0.95 | valid | `comp-3`, `pic` |

### `connectrpc/` — Connect-RPC

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-greeter.proto` | `connectrpc` ≥ 0.95 | valid | `proto3`, `message`, `service`, `rpc`, `streaming`, `repeated`, `package` |

### `corba-idl/` — CORBA / OMG IDL

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-bank.idl` | `corbaidl` ≥ 0.95 | valid | `module`, `interface`, `struct`, `enum`, `exceptions`, `raises` |
| `02-inventory.idl` | `corbaidl` ≥ 0.95 | valid | `module`, `interface`, `struct`, `exceptions`, `raises`, `sequence` |

### `edi-x12/` — EDI ASC X12

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-850-purchase-order.edi` | `edix12` ≥ 0.9 | valid | `850-purchase-order`, `isa-envelope`, `iea-trailer` |
| `02-810-invoice.edi` | `edix12` ≥ 0.9 | valid | `810-invoice`, `isa-envelope`, `iea-trailer` |

### `fhir/` — FHIR R4

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-patient.json` | `fhir` ≥ 0.95 | valid | `patient` |
| `02-patient-structuredefinition.json` | `fhir` ≥ 0.95 | valid | `structure-definition`, `profiles-observation`, `differential` |
| `03-patient-profile.json` | `fhir` ≥ 0.95 | valid | `structure-definition`, `profiles-patient`, `differential` |

### `fix/` — FIX / FIX Orchestra

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-newordersingle.fix` | `fix` ≥ 0.95 | valid | `new-order-single` |
| `02-executionreport.fix` | `fix` ≥ 0.95 | valid | `execution-report` |
| `02-orchestra.xml` ⚠ | `fix` ≥ 0.9 | valid | `fixr-repository`, `code-sets`, `messages` |

> ⚠ **`02-orchestra.xml`** — FIX Orchestra XML is not yet recognized — currently misdetected as protobuf (weak 0.70 grpc-adapter keyword match) and the fix adapter has no Orchestra parser; expected_detection records the intended contract.

### `flatbuffers/` — FlatBuffers

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-monster.fbs` | `flatbuffers` ≥ 0.95 | valid | `table`, `struct`, `enum`, `root-type`, `vector` |

### `graphql/` — GraphQL SDL

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-simple-user.graphql` | `graphql` ≥ 0.85 | valid | `simple-user`, `query`, `list-type` |
| `02-scalar-types.graphql` | `graphql` ≥ 0.85 | valid | `scalar-types`, `query`, `scalar`, `list-type` |
| `03-enum-types.graphql` ⚠ | `graphql` ≥ 0.85 | valid | `enum-types`, `query`, `enum`, `list-type` |
| `04-input-types.graphql` ⚠ | `graphql` ≥ 0.85 | valid | `input-types`, `query`, `mutation`, `enum`, `input`, `defaults`, `list-type` |
| `05-interfaces.graphql` | `graphql` ≥ 0.85 | valid | `interfaces`, `query`, `interface`, `list-type` |
| `06-union-types.graphql` ⚠ | `graphql` ≥ 0.85 | valid | `union-types`, `query`, `union`, `defaults`, `list-type` |
| `07-nested-types.graphql` ⚠ | `graphql` ≥ 0.85 | valid | `nested-types`, `query`, `enum`, `list-type` |
| `08-arguments-defaults.graphql` ⚠ | `graphql` ≥ 0.85 | valid | `arguments-defaults`, `query`, `enum`, `defaults`, `list-type` |
| `09-custom-scalars.graphql` | `graphql` ≥ 0.85 | valid | `custom-scalars`, `query`, `mutation`, `scalar`, `list-type` |
| `10-comprehensive-ecommerce.graphql` ⚠ | `graphql` ≥ 0.85 | valid | `comprehensive-ecommerce`, `query`, `mutation`, `subscription`, `interface`, `union`, `enum`, `input`, `scalar`, `defaults`, `list-type` |

> ⚠ **`03-enum-types.graphql`** — Currently outranked: detection ranks `smithy` (0.95) above `graphql` (0.90); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`04-input-types.graphql`** — Currently outranked: detection ranks `smithy` (0.95) above `graphql` (0.90); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`06-union-types.graphql`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

> ⚠ **`07-nested-types.graphql`** — Currently outranked: detection ranks `smithy` (0.95) above `graphql` (0.90); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`08-arguments-defaults.graphql`** — Currently outranked: detection ranks `smithy` (0.95) above `graphql` (0.90); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`10-comprehensive-ecommerce.graphql`** — detect_format() currently raises FixParseError on this file (the FIX sniffer's is_fix() parses any `|`-containing text instead of returning no-match); expected_detection records the intended contract for the detection-hardening work.

### `hl7v2/` — HL7 v2.x

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-adt-a01.hl7` | `hl7v2` ≥ 0.95 | valid | `adt-a01`, `pid`, `pv1`, `nk1` |
| `02-oru-r01.hl7` | `hl7v2` ≥ 0.95 | valid | `oru-r01`, `pid`, `obx`, `obr` |

### `iso20022/` — ISO 20022

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-pain.001-credit-transfer.xml` | `iso20022` ≥ 0.95 | valid | `pain.001`, `group-header` |
| `02-camt.053-statement.xml` | `iso20022` ≥ 0.95 | valid | `camt.053`, `group-header` |

### `iso8583/` — ISO 8583

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-authorization-0100.json` | `iso8583` ≥ 0.95 | valid | `mti-0100`, `data-elements` |
| `02-authorization-response-0110.json` | `iso8583` ≥ 0.95 | valid | `mti-0110`, `data-elements` |

### `json-schema/` — JSON Schema

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-simple-person.json` | `json-schema-2020-12` ≥ 0.9 | valid | `simple-person` |
| `02-product-types.json` | `json-schema-2020-12` ≥ 0.9 | valid | `product-types`, `enum` |
| `03-multiple-defs.json` | `json-schema-2020-12` ≥ 0.9 | valid | `multiple-defs`, `enum`, `defs` |
| `04-draft07-definitions.json` | `json-schema` ≥ 0.9 | valid | `draft07-definitions`, `enum`, `defs` |
| `05-allof-inheritance.json` | `json-schema-2020-12` ≥ 0.9 | valid | `allof-inheritance`, `oneOf`, `allOf`, `enum`, `const`, `defs` |
| `06-oneof-polymorphism.json` | `json-schema-2020-12` ≥ 0.9 | valid | `oneof-polymorphism`, `oneOf`, `enum`, `const`, `defs` |
| `07-anyof-flexible.json` | `json-schema-2020-12` ≥ 0.9 | valid | `anyof-flexible`, `anyOf`, `enum`, `const`, `defs` |
| `08-if-then-else.json` | `json-schema-2020-12` ≥ 0.9 | valid | `if-then-else`, `allOf`, `enum`, `const`, `defs` |
| `09-advanced-features.json` | `json-schema-2020-12` ≥ 0.9 | valid | `features`, `nullable`, `enum`, `const`, `contains`, `prefixItems`, `patternProperties`, `propertyNames`, `additionalProperties`, `dependentSchemas`, `dependentRequired`, `defs` |
| `10-comprehensive-ecommerce.json` | `json-schema-2020-12` ≥ 0.9 | valid | `comprehensive-ecommerce`, `allOf`, `enum`, `patternProperties`, `additionalProperties`, `defs`, `multipleOf` |

### `jtd/` — JSON Type Definition

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-user.jtd.json` | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `elements`, `enum` |
| `02-order.jtd.json` | `jtd` ≥ 0.9 | valid | `properties`, `optional-properties`, `elements`, `discriminator`, `definitions`, `ref` |

### `odata/` — OData v4 (EDMX)

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-northwind.edmx` | `odata` ≥ 0.95 | valid | `entity-type`, `navigation`, `entity-set`, `keys` |
| `02-orders.edmx` | `odata` ≥ 0.95 | valid | `entity-type`, `complex-type`, `entity-set`, `keys` |

### `onc-rpc/` — ONC RPC / XDR

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-key-value-store.x` ⚠ | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `union`, `typedef`, `enum`, `opaque` |
| `02-file-stat.x` ⚠ | `oncrpc` ≥ 0.9 | valid | `program`, `version`, `struct`, `enum` |

> ⚠ **`01-key-value-store.x`** — Currently outranked: detection ranks `flatbuffers` (0.96) above `oncrpc` (0.95); expected_detection records the intended winner for the detection-hardening work.

> ⚠ **`02-file-stat.x`** — Currently outranked: detection ranks `flatbuffers` (0.96) above `oncrpc` (0.95); expected_detection records the intended winner for the detection-hardening work.

### `openapi/` — OpenAPI 3.x

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-numeric-constraints.yaml` | `openapi-3.1` ≥ 0.95 | valid | `numeric-constraints`, `multipleOf` |
| `02-array-contains.yaml` | `openapi-3.1` ≥ 0.95 | valid | `array-contains`, `enum`, `contains` |
| `03-object-properties.yaml` | `openapi-3.1` ≥ 0.95 | valid | `object-properties`, `patternProperties` |
| `04-constant-not.yaml` | `openapi-3.1` ≥ 0.95 | valid | `constant-not`, `not`, `const` |
| `05-dependent-schemas.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `dependent-schemas`, `if-then-else`, `enum`, `const`, `dependentSchemas` |
| `06-dependent-required.yaml` | `openapi-3.1` ≥ 0.95 | valid | `dependent-required`, `dependentRequired` |
| `07-nullable-types.yaml` | `openapi-3.1` ≥ 0.95 | valid | `nullable-types`, `nullable` |
| `08-multiple-examples.yaml` | `openapi-3.1` ≥ 0.95 | valid | `multiple-examples`, `enum` |
| `09-unevaluated-properties.yaml` | `openapi-3.1` ≥ 0.95 | valid | `unevaluated-properties`, `allOf`, `unevaluatedProperties` |
| `10-if-then-else.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `if-then-else`, `allOf`, `enum`, `const` |
| `10b-if-then-else-separate-rules.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `if-then-else-separate-rules`, `oneOf`, `allOf`, `discriminator`, `enum`, `const` |
| `11-unevaluated-items.yaml` | `openapi-3.1` ≥ 0.95 | valid | `unevaluated-items`, `const`, `prefixItems`, `unevaluatedItems` |
| `12-additional-properties-ref.yaml` | `openapi-3.1` ≥ 0.95 | valid | `additional-properties-ref`, `const`, `additionalProperties` |
| `13-property-name-constraints.yaml` | `openapi-3.1` ≥ 0.95 | valid | `property-name-constraints`, `propertyNames`, `additionalProperties` |
| `14-custom-extensions.yaml` | `openapi-3.1` ≥ 0.95 | valid | `custom-extensions`, `additionalProperties`, `x-extensions` |
| `15-external-docs.yaml` | `openapi-3.1` ≥ 0.95 | valid | `external-docs`, `enum`, `externalDocs` |
| `16-discriminator-mapping.yaml` | `openapi-3.1` ≥ 0.95 | valid | `discriminator-mapping`, `allOf`, `discriminator`, `x-extensions` |
| `17-deprecated-features.yaml` | `openapi-3.1` ≥ 0.95 | valid | `deprecated-features`, `deprecated`, `x-extensions` |
| `18-prefix-items-tuples.yaml` | `openapi-3.1` ≥ 0.95 | valid | `prefix-items-tuples`, `nullable`, `enum`, `prefixItems` |
| `19-enumeration-sorting.yaml` | `openapi-3.1` ≥ 0.95 | valid | `enumeration-sorting`, `enum` |
| `20-comprehensive-features.yaml` | `openapi-3.1` ≥ 0.95 | valid | `comprehensive-features`, `if-then-else`, `enum`, `const`, `contains`, `prefixItems`, `propertyNames`, `additionalProperties`, `unevaluatedProperties`, `unevaluatedItems`, `dependentSchemas`, `dependentRequired`, `externalDocs`, `x-extensions`, `multipleOf` |
| `21-advanced-allof-inheritance.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `allof-inheritance`, `allOf`, `enum`, `additionalProperties` |
| `22-advanced-oneof-polymorphism.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `oneof-polymorphism`, `oneOf`, `discriminator`, `enum`, `const`, `additionalProperties` |
| `23-advanced-anyof-flexible.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `anyof-flexible`, `anyOf`, `enum`, `const` |
| `24-advanced-combined-composition.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `combined-composition`, `oneOf`, `anyOf`, `allOf`, `discriminator`, `enum`, `const`, `additionalProperties` |
| `25-test-property-conflict-diff.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `property-conflict-diff`, `enum`, `defs` |
| `26-test-property-edge-cases.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `property-edge-cases` |
| `27-test-property-mixed.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `property-mixed`, `additionalProperties`, `defs` |
| `28-test-property-reuse-same.yaml` ⚠ | `openapi-3.1` ≥ 0.95 | valid | `property-reuse-same`, `enum` |
| `30-openapi-3.0-petstore.yaml` | `openapi-3.0` ≥ 0.95 | valid | `openapi-3.0-petstore`, `nullable` |
| `31-paths-comprehensive.yaml` | `openapi-3.1` ≥ 0.95 | valid | `paths-comprehensive`, `enum` |
| `32-openapi-3.2.0-minimal.yaml` | `openapi-3.2` ≥ 0.95 | valid | `openapi-3.2.0-minimal` |

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

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-wallet-api.json` | `openrpc` ≥ 0.95 | valid | `methods`, `params`, `result`, `components` |

### `postman/` — Postman v2.1

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-tasks-collection.postman_collection.json` | `postman` ≥ 0.95 | valid | `items`, `requests`, `variables` |

### `protobuf/` — Protobuf / gRPC

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-simple-user.proto` | `protobuf` ≥ 0.95 | valid | `proto3`, `message`, `enum`, `repeated`, `package` |
| `02-grpc-service.proto` | `protobuf` ≥ 0.95 | valid | `proto3`, `message`, `service`, `rpc`, `repeated`, `map`, `package` |

### `raml/` — RAML 1.0

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-simple-api.raml` | `raml` ≥ 0.95 | valid | `types`, `methods`, `responses`, `base-uri` |

### `smithy/` — Smithy 2.0

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-weather-service.smithy` | `smithy` ≥ 0.9 | valid | `service`, `operations`, `structure`, `list`, `enum`, `required` |

### `swagger/` — Swagger 2.0

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-swagger-2-petstore.yaml` ⚠ | `swagger-2.0` ≥ 0.9 | valid | `nullable`, `enum`, `additionalProperties`, `defs`, `x-extensions` |

> ⚠ **`01-swagger-2-petstore.yaml`** — Currently outranked: detection ranks `api-blueprint` (0.98) above `swagger-2.0` (0.95); expected_detection records the intended winner for the detection-hardening work.

### `thrift/` — Apache Thrift

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-user-service.thrift` ⚠ | `thrift` ≥ 0.9 | valid | `struct`, `service`, `enum`, `exceptions`, `optional`, `containers` |

> ⚠ **`01-user-service.thrift`** — Currently outranked: detection ranks `oncrpc` (0.95) above `thrift` (0.95); expected_detection records the intended winner for the detection-hardening work.

### `typespec/` — TypeSpec

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-pets-api.tsp` | `typespec` ≥ 0.95 | valid | `model`, `interface`, `routes`, `http-verbs`, `enum`, `namespace` |
| `02-orders-api.tsp` | `typespec` ≥ 0.95 | valid | `model`, `interface`, `routes`, `http-verbs`, `enum`, `namespace` |

### `wadl/` — WADL

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-bookstore.wadl` | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `params`, `representations` |

### `wsdl/` — WSDL 1.1 (SOAP)

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-calculator.wsdl` | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `soap` |

### `xml-rpc/` — XML-RPC

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-method-call.xml` | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params`, `struct`, `array` |
| `02-method-response.xml` | `xmlrpc` ≥ 0.95 | valid | `method-response`, `params`, `struct`, `fault` |

### `xsd/` — XML Schema (XSD)

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-purchase-order.xsd` | `xsd` ≥ 0.95 | valid | `complex-type`, `simple-type`, `sequence`, `restrictions`, `enumeration`, `occurrence`, `attribute` |

### `zos-connect/` — z/OS Connect

| File | Expected detection | Class | Features |
| --- | --- | --- | --- |
| `01-api-requester.json` | `zosconnect` ≥ 0.95 | valid | `api-requester`, `operations` |
| `02-api-provider.json` | `zosconnect` ≥ 0.95 | valid | `api-provider`, `operations` |

## Trying an import

In the ADE dashboard, open **Import**, pick **File Upload** (or **Clipboard Paste**), and drop one of these files. Detection names the format and the import lands as a catalog item (OpenAPI/Swagger/Arazzo route to publishable Projects).
