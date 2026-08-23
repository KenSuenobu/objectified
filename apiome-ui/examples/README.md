# Catalog import examples

Sample source documents for exercising the catalog **Import** flow (the ImportDialog source cards → format auto-detection → catalog item). Each file is a small, self-contained document with a header comment explaining what it demonstrates.

> **Generated file — do not edit.** This README is the human index of [`corpus.manifest.json`](corpus.manifest.json) (schema: [`corpus.schema.json`](corpus.schema.json)). Edit the manifest, then run `python3 scripts/generate_examples_readme.py` from the repo root; CI fails on drift.

> **Adding an example?** Read the [corpus contributor guide](../../docs/CORPUS_CONTRIBUTOR_GUIDE.md) first — it covers the ladder, every manifest field, the licensing rules for documents derived from third-party specs, the anonymization rule for captured payloads, and the review checklist. `python3 scripts/check_corpus_provenance.py` enforces the provenance rules in CI.

The corpus holds **1421 files** across **103 format directories**. Every file has a manifest entry declaring its format family, the adapter that must claim it, its validity class, the detection contract (format key + minimum confidence), feature tags, and the expected import outcome.

## How the corpus is used

- **Format auto-detection** (`apiome-rest` `format_detection.py`) sniffs each file's content and names the format; the manifest's `expected_detection` records the contract detection must meet.
- **Tests select fixtures by tag, not by path**: `load_corpus(...)` in `apiome-rest/tests/corpus_loader.py` (pytest) and `loadCorpus(...)` in `apiome-ui/lib/corpus/corpus.ts` (Jest) filter entries by `format`, `validity_class`, `feature`, or `adapter_key`.
- **Catalog pills** (`apiome-ui` `catalog-format-registry.ts`) render the format, protocol/paradigm, and source-material badges off the imported item.

## Layout

### REST / HTTP

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `api-blueprint/` | API Blueprint | rest | `FORMAT: 1A` metadata line | 11 |
| `apigee/` | Apigee proxy bundle (pending #5457) | rest | zip with `apiproxy/` members and an `APIProxy` manifest, or a `ProxyEndpoint`/`TargetEndpoint` root | 15 |
| `arazzo/` | Arazzo workflows | rest | top-level `arazzo:` version | 11 |
| `arazzo-1.1/` | Arazzo 1.1 workflows | rest | top-level `arazzo: 1.1.x` | 14 |
| `aws-apigateway/` | AWS API Gateway (pending #5455) | rest | OpenAPI document carrying `x-amazon-apigateway-*` extensions | 13 |
| `azure-apim/` | Azure API Management (pending #5456) | rest | `<policies>` sections, or `Microsoft.ApiManagement/service/apis` ARM resources | 14 |
| `consul/` | Consul service definitions (pending #5459) | rest | `service`/`services` definitions, or `Kind: service-router`/`ingress-gateway` | 15 |
| `discovery/` | Google API Discovery | rest | `kind: discovery#restDescription` / `discoveryVersion` | 11 |
| `envoy-xds/` | Envoy xDS routes (pending #5458) | rest | `static_resources` + `HttpConnectionManager`, or `virtual_hosts[]` route config | 15 |
| `gateway-api/` | Gateway API HTTPRoute | rest | `apiVersion: gateway.networking.k8s.io/*` + `kind: HTTPRoute` | 13 |
| `haproxy/` | HAProxy configuration (pending #5459) | rest | `frontend`/`backend`/`listen` sections with `bind`, `acl`, `use_backend` | 16 |
| `hoppscotch/` | Hoppscotch collections (pending #5473) | rest | top-level `v` + `folders[]`/`requests[]` with `endpoint` and `auth.authType` | 14 |
| `http-file/` | HTTP Request File | rest | HTTP request line / `###` separators / `curl` / `.http` `.rest` | 15 |
| `istio/` | Istio traffic resources (pending #5458) | rest | `apiVersion: networking.istio.io/*` + `kind: VirtualService` | 15 |
| `kong/` | Kong Declarative Config | rest | `_format_version` + `services:`/`routes:` declarative sections | 12 |
| `nginx/` | nginx configuration (pending #5459) | rest | `server { listen … location … }` / `upstream … { server … }` blocks | 15 |
| `odata/` | OData v4 (EDMX) | rest | `<edmx:Edmx>` root | 12 |
| `odata-v2/` | OData v2 / v3 (CSDL) | rest | `<edmx:Edmx>` with the 2007/06 or 2009/11 EDM namespaces | 14 |
| `openapi/` | OpenAPI 3.x | rest | top-level `openapi:` version | 44 |
| `postman/` | Postman v2.1 | rest | collection `info.schema` URL | 11 |
| `postman-v2/` | Postman Collection v2.0 | rest | `info.schema` ending `/collection/v2.0.0/collection.json` | 13 |
| `raml/` | RAML 1.0 | rest | `#%RAML 1.0` header | 11 |
| `soapui/` | SoapUI / ReadyAPI projects (pending #5477) | rest | `<con:soapui-project>` root in the eviware config namespace | 14 |
| `swagger/` | Swagger 2.0 | rest | `swagger: "2.0"` | 1 |
| `swagger-1.2/` | Swagger 1.2 | rest | `"swaggerVersion": "1.2"` | 14 |
| `thunder-client/` | Thunder Client collections (pending #5475) | rest | `"clientName": "Thunder Client"` + `requests[]` or environment `data[]` | 14 |
| `traefik/` | Traefik dynamic config (pending #5459) | rest | `http.routers` + `http.services` (YAML/TOML), or `kind: IngressRoute` | 15 |
| `tyk/` | Tyk API definition (pending #5459) | rest | `api_id` + `proxy.listen_path`, or an OpenAPI document with `x-tyk-api-gateway` | 14 |
| `typespec/` | TypeSpec | rest | `import "@typespec/..."` | 11 |
| `wadl/` | WADL | rest | `<application>` root (WADL namespace) | 12 |
| `wsdl/` | WSDL 1.1 (SOAP) | soap | `<wsdl:definitions>` root | 13 |
| `wsdl2/` | WSDL 2.0 | soap | `<description>` root in the `http://www.w3.org/ns/wsdl` namespace | 13 |
| `zos-connect/` | z/OS Connect | rest | `apiRequester` / `apiProvider` descriptor | 11 |

### RPC

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `connectrpc/` | Connect-RPC | rpc | Protobuf `service` (Connect) | 12 |
| `corba-idl/` | CORBA / OMG IDL | rpc | `module` + `interface` | 11 |
| `onc-rpc/` | ONC RPC / XDR | rpc | `program {} = N` + XDR types | 11 |
| `openrpc/` | OpenRPC (JSON-RPC) | rpc | top-level `openrpc:` version | 11 |
| `protobuf/` | Protobuf / gRPC | rpc | `syntax = "proto3"` | 17 |
| `protobuf-editions/` | Protobuf editions (2023/2024) | rpc | `edition = "2023"` / `"2024"` in place of `syntax` | 14 |
| `ros2/` | ROS 2 interfaces (pending #5470) | rpc | `.msg`/`.srv`/`.action` field lines with ROS primitive types and `---` separators | 16 |
| `smithy/` | Smithy 2.0 | rpc | `$version` + Smithy shapes | 11 |
| `thrift/` | Apache Thrift | rpc | `service` / `struct` shapes | 11 |
| `trpc/` | tRPC routers (pending #5464) | rpc | `initTRPC` + exported `t.router({...})` with `.query`/`.mutation` procedures | 16 |
| `wit/` | WIT (WebAssembly Component Model) | rpc | `package ns:name` + `interface`/`world` blocks | 16 |
| `xml-rpc/` | XML-RPC | rpc | `<methodCall>` / `<methodResponse>` root | 13 |

### Event / messaging

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `asyncapi/` | AsyncAPI 2.x/3.0 | event | top-level `asyncapi:` version | 14 |
| `cloudevents/` | CloudEvents 1.0 | event | `specversion` + `type` + `source` envelope | 11 |
| `sparkplug/` | MQTT Sparkplug B (pending #5469) | event | `spBv1.0/...` topic namespace, or a Sparkplug protobuf `Payload` on the binary intake path | 15 |

### Graph

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `graphql/` | GraphQL SDL | graph | root `type Query` / `schema {}` | 23 |

### Data schema

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `arrow/` | Apache Arrow / Flight schema | data_schema | `schema.fields[].type.name` in the Arrow JSON integration form | 17 |
| `asn1/` | ASN.1 | data_schema | `DEFINITIONS ::= BEGIN … END` | 12 |
| `avro/` | Avro schema | data_schema | `type: record` + `fields` | 11 |
| `avro-idl/` | Avro IDL | data_schema / rpc | `protocol … {` or `namespace …;` + `record` declarations in `.avdl` | 14 |
| `capnproto/` | Cap'n Proto | data_schema | `@0x…` file id + `struct` | 11 |
| `cddl/` | CDDL (RFC 8610) | data_schema | `name = { … }` rules with `tstr`/`bstr`/`uint` prelude types | 14 |
| `cics-bms/` | CICS BMS maps (pending #5484) | data_schema | `DFHMSD`/`DFHMDI`/`DFHMDF` macro source with column-72 continuations | 14 |
| `cobol-copybook/` | COBOL copybook | data_schema | level numbers + `PIC` clauses | 13 |
| `cue/` | CUE (pending #5466) | data_schema | `package …` + `#Definition: {…}` with `&`/`\|`/`=~` constraints | 15 |
| `dbt/` | dbt models and manifests | data_schema | `version: 2` + `models:`/`sources:`, or `metadata.dbt_schema_version` in a manifest | 16 |
| `dhall/` | Dhall (pending #5466) | data_schema | `let … in …` with type annotations, union types and `::` completion | 14 |
| `dtd/` | DTD | data_schema | `<!ELEMENT>`/`<!ATTLIST>` declarations, or a `<!DOCTYPE …[…]>` internal subset | 15 |
| `flatbuffers/` | FlatBuffers | data_schema | `table`/`struct` + `root_type` | 11 |
| `ims/` | IMS DBD and PSB (pending #5482) | data_schema | `DBD NAME=…,ACCESS=(…)` with `SEGM`/`FIELD`, or `PCB TYPE=DB` with `SENSEG` | 14 |
| `json-schema/` | JSON Schema | data_schema | `$schema` / `type` + `properties` | 17 |
| `jsonld/` | JSON-LD contexts (pending #5471) | data_schema | top-level `@context` with term definitions (`@id`/`@type`/`@container`) | 14 |
| `jtd/` | JSON Type Definition | data_schema | `properties`/`optionalProperties` | 11 |
| `k8s-crd/` | Kubernetes CRD | data_schema | `apiVersion: apiextensions.k8s.io/*` + `kind: CustomResourceDefinition` | 12 |
| `kafka-connect/` | Kafka Connect schema | data_schema | `"type": "struct"` + `fields[].field` | 15 |
| `lwm2m/` | LwM2M / IPSO objects (pending #5472) | data_schema | `<LWM2M>` root with `<Object ObjectType="MODefinition">` and `Resources/Item` | 15 |
| `matter/` | Matter clusters and device types (pending #5472) | rpc | `<configurator>` root with `<cluster>` (name/code/define) or `<deviceType>` | 15 |
| `natural-ddm/` | Natural / ADABAS DDM (pending #5486) | data_schema | `DDM Name ......` header + the `T L DB Name … F Leng S D Remark` banner | 14 |
| `odcs/` | Open Data Contract Standard v3.1 | data_schema | `apiVersion: v3.x` + `kind: DataContract` + `schema:` | 15 |
| `opcua-nodeset/` | OPC UA NodeSet2 (pending #5468) | rpc | `<UANodeSet>` root in the OPC Foundation NodeSet2 namespace | 14 |
| `owl/` | OWL / RDFS ontologies (pending #5471) | data_schema | `owl:Ontology`/`owl:Class`/`owl:*Property` in the OWL namespace (Turtle or RDF/XML) | 14 |
| `pkl/` | Pkl (pending #5466) | data_schema | `module …` + `class`/`typealias` with member constraints and `Listing<…>` types | 14 |
| `pli/` | PL/I structures (pending #5480) | data_schema | `DCL`/`DECLARE` level-numbered structures with PL/I attributes and `%INCLUDE` | 15 |
| `pydantic/` | Pydantic models (pending #5465) | data_schema | `from pydantic import BaseModel` + `class X(BaseModel):` definitions | 15 |
| `relaxng/` | RELAX NG (pending #5434) | data_schema | `grammar`/`element` root in the RELAX NG namespace, or a `.rnc` compact grammar | 15 |
| `schematron/` | Schematron rules | data_schema | `schema`/`pattern` root in `http://purl.oclc.org/dsdl/schematron` | 13 |
| `shacl/` | SHACL shapes (pending #5471) | data_schema | `sh:NodeShape`/`sh:property` in the SHACL namespace (Turtle or JSON-LD) | 15 |
| `sql-ddl/` | SQL DDL (pending #5444) | data_schema | `CREATE TABLE`/`CREATE VIEW`/`ALTER TABLE … ADD CONSTRAINT` | 15 |
| `typescript-types/` | TypeScript type declarations (pending #5462) | data_schema | `export interface`/`export type`/`export enum` declarations in `.ts`/`.d.ts` | 15 |
| `vsam-idcams/` | VSAM cluster definitions (pending #5484) | data_schema | `DEFINE CLUSTER`/`AIX`/`PATH` with parenthesised parameters, or `LISTCAT` output | 14 |
| `xsd/` | XML Schema (XSD) | data_schema | `xs:schema` root element | 13 |
| `zod/` | Zod schemas (pending #5463) | data_schema | `import { z } from 'zod'` + exported `z.object(...)` values | 15 |

### Industry / domain messaging

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `dicom/` | DICOM (pending #5451) | data_schema | `DICM` magic at offset 128, or 8-hex-digit keys with `vr`/`Value` (DICOM JSON) | 15 |
| `edi-x12/` | EDI ASC X12 | message | `ISA`/`GS`/`ST` envelopes | 12 |
| `edifact/` | UN/EDIFACT (pending #5445) | message | `UNB`/`UNH` envelopes, optional `UNA` service string advice | 16 |
| `fhir/` | FHIR R4 | data_schema | `resourceType` (+ StructureDefinition) | 11 |
| `fix/` | FIX / FIX Orchestra | message | `8=FIX.` tags / `<fixr:repository>` | 11 |
| `fix-orchestra/` | FIX Orchestra (pending #5453) | message | `<fixr:repository>` root in the Orchestra namespace | 14 |
| `hl7v2/` | HL7 v2.x | message | `MSH\|^~\&\|` message header | 11 |
| `hl7v3/` | HL7 v3 / CDA (pending #5448) | message | `<ClinicalDocument>` root in the `urn:hl7-org:v3` namespace | 14 |
| `idoc/` | SAP IDoc (pending #5446) | message | `EDI_DC40` control record (flat) or `<IDOC>` + `<EDI_DC40>` (XML) | 14 |
| `iso20022/` | ISO 20022 | message | `urn:iso:std:iso:20022` XML namespace | 12 |
| `iso8583/` | ISO 8583 | message | `mti` + numbered `dataElements` | 11 |
| `nacha/` | NACHA ACH (pending #5450) | message | 94-character records: `1` file header, `5`/`6`/`7`/`8`/`9` types | 14 |
| `ncpdp/` | NCPDP SCRIPT / Telecom (pending #5452) | message | `Message` root in the NCPDP SCRIPT namespace, or a `D0` Telecom transaction header | 14 |
| `sepa/` | SEPA payment files (pending #5450) | message | `urn:iso:std:iso:20022:tech:xsd:pain.*`/`pacs.*`/`camt.*` namespace | 14 |
| `swift-mt/` | SWIFT MT (pending #5447) | message | `{1:` basic header + `{4:` text block terminated by `-}` | 14 |
| `tradacoms/` | TRADACOMS (pending #5449) | message | `STX=` transmission header + `END=` trailer | 15 |

### Agent / LLM tools

| Directory | Format | Paradigm | Marker / shape | Files |
| --- | --- | --- | --- | --- |
| `llm-tools/` | LLM Tools | agent | OpenAI / Anthropic / bare tool-array shape | 13 |
| `mcp/` | MCP server manifest | agent | `mcpVersion` + `tools[].inputSchema` | 12 |

## File index

Validity classes: `valid` imports cleanly · `invalid` must be rejected · `adversarial` tries to confuse detection · `scale` stresses limits.

The `scale` tier is **not committed here**: documents that size would bloat the repository permanently, so `scripts/generate_scale_corpus.py` builds one large document per paradigm at test time and `apiome-rest/tests/test_scale_corpus.py` (IXH-1.5) holds each import and export stage to the budgets in `apiome-rest/tests/scale/scale_budgets.json`. The large `adversarial` fixtures are generated the same way, by `scripts/generate_adversarial_corpus.py`.

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

### `apigee/` — Apigee proxy bundle (pending #5457)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-proxy-endpoint.xml` | minimal | `apigee` ≥ 0.9 | valid | `proxy-endpoint`, `base-path`, `route-rule`, `flow-condition`, `pending-adapter` |
| `02-typical-proxy-bundle.zip` | typical | `apigee` ≥ 0.9 | valid | `bundle`, `archive-intake`, `flows`, `VerifyAPIKey`, `SpikeArrest`, `Quota`, `cors`, `pending-adapter` |
| `03-composition-multi-target-bundle.zip` | composition | `apigee` ≥ 0.9 | valid | `bundle`, `archive-intake`, `multi-target`, `ordered-route-rules`, `conditioned-route`, `no-route-rule`, `pending-adapter` |
| `04-stress-policy-coverage-bundle.zip` | stress | `apigee` ≥ 0.9 | valid | `bundle`, `archive-intake`, `OAuthV2`, `JSONThreatProtection`, `ServiceCallout`, `Javascript`, `ResponseCache`, `FaultRules`, `load-balancer`, `unconditional-flow`, `script-resource`, `pending-adapter` |
| `05-real-world-payments-bundle.zip` | real-world | `apigee` ≥ 0.9 | valid | `bundle`, `archive-intake`, `oauth-scopes`, `quota`, `hmac`, `idempotency`, `environment-routing`, `mtls`, `pending-adapter` |
| `06-typical-target-endpoint.xml` | typical | `apigee` ≥ 0.9 | valid | `target-endpoint`, `load-balancer`, `ssl-info`, `timeouts`, `success-codes`, `pending-adapter` |
| `07-shared-flow-set/flow-callout.xml` ⚠ | multi-file (member) | `apigee` (no guarantee) | valid | `flow-callout-policy`, `shared-flow-bundle`, `parameters`, `pending-adapter` |
| `07-shared-flow-set/proxy-endpoint.xml` | multi-file (root) | `apigee` ≥ 0.9 | valid | `flow-callout`, `delegated-security`, `pending-adapter` |
| `07-shared-flow-set/shared-flow.xml` ⚠ | multi-file (member) | `apigee` (no guarantee) | valid | `shared-flow`, `oauth`, `quota`, `pending-adapter` |
| `negative/01-syntactic-unclosed-flow.xml` | — | `apigee` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-no-proxy-endpoint.zip` | — | `apigee` (no guarantee) | invalid | `negative`, `semantic`, `no-proxy-endpoint`, `bundle`, `pending-adapter` |
| `negative/03-truncated-bundle.zip` ⚠ | — | `apigee` (no guarantee) | invalid | `negative`, `truncated`, `truncated-archive`, `pending-adapter` |
| `negative/04-wrong-format-gateway-api.yaml` | — | `apigee` (no guarantee) | invalid | `negative`, `wrong-format`, `gateway-api`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `apigee` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-target-endpoint.zip` ⚠ | — | `apigee` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-target-endpoint`, `bundle`, `pending-adapter` |

> ⚠ **`07-shared-flow-set/flow-callout.xml`** — Fileset member: the FlowCallout policy that binds the proxy step to the shared flow bundle.

> ⚠ **`07-shared-flow-set/shared-flow.xml`** — Fileset member: the shared flow where the proxy's security and quota steps actually live.

> ⚠ **`negative/03-truncated-bundle.zip`** — The zip's central directory is cut off, so the archive cannot be opened at all — the failure surfaces as an archive error rather than an XML parse error.

> ⚠ **`negative/06-unresolvable-target-endpoint.zip`** — The FMT-7.3 acceptance case: a bundle with a missing target endpoint.

### `arazzo/` — Arazzo workflows

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `06-pet-coupons-real-world.yaml` | real-world | `arazzo` ≥ 0.95 | valid | `pet-coupons`, `workflows`, `steps`, `success-criteria`, `outputs`, `inputs` |
| `07-spec-grammar-stress.yaml` | stress | `arazzo` ≥ 0.95 | valid | `spec-grammar-stress`, `workflows`, `success-criteria`, `components`, `operationRef`, `dependsOn` |
| `edge-cases.yaml` | stress | `arazzo` ≥ 0.95 | valid | `edge-cases`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `mixed-scenarios.yaml` | composition | `arazzo` ≥ 0.95 | valid | `mixed-scenarios`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `negative/02-semantic-root-not-a-mapping.yaml` ⚠ | — | `arazzo` (no guarantee) | invalid | `negative`, `semantic`, `root-not-a-mapping` |
| `negative/03-truncated-mid-string.yaml` ⚠ | — | `arazzo` (no guarantee) | invalid | `negative`, `truncated`, `mid-quoted-scalar` |
| `negative/04-wrong-format-openapi.yaml` ⚠ | — | `arazzo` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi` |
| `negative/05-encoding-utf16.yaml` | — | `arazzo` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/property-conflicts.yaml` ⚠ | — | `arazzo` (no guarantee) | invalid | `property-conflicts`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `property-reuse.yaml` | typical | `arazzo` ≥ 0.95 | valid | `property-reuse`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |
| `simple-workflow.yaml` | minimal | `arazzo` ≥ 0.95 | valid | `simple-workflow`, `workflows`, `steps`, `success-criteria`, `source-descriptions`, `outputs`, `parameters` |

> ⚠ **`negative/02-semantic-root-not-a-mapping.yaml`** — The shared ingestion loader rejects top-level YAML sequences at the parse phase, so the code is INPUT_MALFORMED rather than a normalize-phase INPUT_SEMANTIC_INVALID.

> ⚠ **`negative/03-truncated-mid-string.yaml`** — The document ends inside a quoted scalar; FMT-3.1 (#5426) taught the adapter to report that as truncation rather than as a generic malformed document.

> ⚠ **`negative/04-wrong-format-openapi.yaml`** — An OpenAPI document routed to the Arazzo importer; FMT-3.1 (#5426) reports the missing `arazzo` marker as a format mismatch rather than a semantic error.

> ⚠ **`negative/property-conflicts.yaml`** — The line-scrambled YAML fails to parse, so the arazzo sniffer cannot claim it; the greedy graphql sniffer claims the text at 0.9 confidence, so the pipeline classifies FORMAT_MISMATCH instead of INPUT_MALFORMED.

### `arazzo-1.1/` — Arazzo 1.1 workflows

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-single-step.yaml` | minimal | `arazzo` ≥ 0.95 | valid | `workflows`, `steps`, `successCriteria`, `sourceDescriptions` |
| `02-typical-checkout-flow.yaml` | typical | `arazzo` ≥ 0.95 | valid | `workflows`, `inputs`, `outputs`, `requestBody`, `step-outputs` |
| `03-composition-reusable-components.yaml` | composition | `arazzo` ≥ 0.95 | valid | `components`, `ref-reuse`, `dependsOn`, `failureActions`, `successActions` |
| `04-stress-criteria-vocabulary.yaml` | stress | `arazzo` ≥ 0.95 | valid | `successCriteria`, `regex`, `jsonpath`, `xpath`, `operationPath`, `operationRef` |
| `05-real-world-order-to-cash.yaml` | real-world | `arazzo` ≥ 0.95 | valid | `asyncapi-source`, `mixed-sync-async`, `message-payload-criteria`, `retry` |
| `06-sourced-set/inventory.openapi.yaml` ⚠ | multi-file (member) | `openapi-3.1` (no guarantee) | valid | `multi-file`, `openapi-source` |
| `06-sourced-set/workflow.arazzo.yaml` | multi-file (root) | `arazzo` ≥ 0.95 | valid | `multi-file`, `relative-source-url`, `workflows` |
| `07-version-1.0-baseline.yaml` ⚠ | typical | `arazzo` ≥ 0.95 | valid | `version-1.0`, `no-upgrade`, `workflows` |
| `negative/01-syntactic-unclosed-flow-sequence.yaml` | — | `arazzo` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-flow-sequence` |
| `negative/02-semantic-step-without-operation.yaml` | — | `arazzo` (no guarantee) | invalid | `negative`, `semantic`, `step-without-operation` |
| `negative/03-truncated-mid-workflow.yaml` | — | `arazzo` (no guarantee) | invalid | `negative`, `truncated`, `mid-quoted-scalar` |
| `negative/04-wrong-format-asyncapi.yaml` ⚠ | — | `arazzo` (no guarantee) | invalid | `negative`, `wrong-format`, `asyncapi` |
| `negative/05-encoding-utf16.yaml` | — | `arazzo` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-version-out-of-range-2.0.yaml` | — | `arazzo` (no guarantee) | invalid | `negative`, `version-out-of-range`, `arazzo-2.0` |

> ⚠ **`06-sourced-set/inventory.openapi.yaml`** — Fileset member: the OpenAPI document the workflow's sourceDescriptions resolve to; detected as OpenAPI on its own.

> ⚠ **`07-version-1.0-baseline.yaml`** — A 1.0.1 document kept beside the 1.1 ladder so FMT-3.1 can assert that a 1.0 source still emits as 1.0.

> ⚠ **`negative/04-wrong-format-asyncapi.yaml`** — An AsyncAPI 3 document — plausible neighbour now that 1.1 reads AsyncAPI sources, and exactly the confusion detection must not make.

### `arrow/` — Apache Arrow / Flight schema

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-schema.json` | minimal | `arrow` ≥ 0.85 | valid | `json-form`, `flat-fields` |
| `02-typical-orders-schema.json` | typical | `arrow` ≥ 0.85 | valid | `json-form`, `timestamp-timezone`, `fixedsizebinary`, `schema-metadata` |
| `03-composition-nested-types.json` | composition | `arrow` ≥ 0.85 | valid | `struct`, `list`, `map`, `nested` |
| `04-stress-type-coverage.json` | stress | `arrow` ≥ 0.85 | valid | `decimal`, `union`, `dictionary`, `interval`, `duration`, `largeutf8`, `fixedsizelist`, `extension-type`, `all-int-widths` |
| `05-real-world-trip-records-schema.json` | real-world | `arrow` ≥ 0.85 | valid | `dictionary`, `decimal`, `map`, `partition-metadata` |
| `06-typical-flight-getschema-response.json` | typical | `arrow` ≥ 0.85 | valid | `flight`, `GetSchema`, `flight-descriptor`, `dictionary` |
| `07-flight-set/flight-info.json` | multi-file (root) | `arrow` ≥ 0.85 | valid | `multi-file`, `flight`, `GetFlightInfo`, `endpoints` |
| `07-flight-set/inventory-schema.json` | multi-file (member) | `arrow` (no guarantee) | valid | `multi-file`, `flight`, `json-form` |
| `08-composition-nested-types.arrow` ⚠ | composition | `arrow` ≥ 0.85 | valid | `binary-intake`, `binary-pair-composition`, `ipc`, `struct`, `list`, `map`, `nested` |
| `09-real-world-trip-records.arrow` ⚠ | real-world | `arrow` ≥ 0.85 | valid | `binary-intake`, `binary-pair-real-world`, `ipc`, `dictionary`, `decimal`, `map` |
| `negative/01-syntactic-trailing-comma.json` | — | `arrow` (no guarantee) | invalid | `negative`, `syntactic`, `trailing-comma` |
| `negative/02-semantic-unknown-type-name.json` | — | `arrow` (no guarantee) | invalid | `negative`, `semantic`, `unknown-type-name` |
| `negative/03-truncated-mid-field.json` | — | `arrow` (no guarantee) | invalid | `negative`, `truncated`, `mid-type` |
| `negative/04-wrong-format-avro.avsc` | — | `arrow` (no guarantee) | invalid | `negative`, `wrong-format`, `avro` |
| `negative/05-encoding-utf16.json` | — | `arrow` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-semantic-struct-without-children.json` ⚠ | — | `arrow` (no guarantee) | invalid | `negative`, `semantic`, `nested-without-children` |
| `negative/07-truncated-ipc-schema.arrow` ⚠ | — | `arrow` (no guarantee) | invalid | `negative`, `truncated`, `binary-intake`, `ipc` |

> ⚠ **`08-composition-nested-types.arrow`** — IPC twin of 03-composition-nested-types.json. FMT-4.5 asserts the pair imports to one canonical model, so the two entries share a golden snapshot body.

> ⚠ **`09-real-world-trip-records.arrow`** — IPC twin of 05-real-world-trip-records-schema.json, carrying the dictionary-encoded and decimal columns the acceptance criteria name.

> ⚠ **`negative/06-semantic-struct-without-children.json`** — Second semantic case: struct and list fields are meaningless with an empty children array, so the schema cannot describe a record batch.

> ⚠ **`negative/07-truncated-ipc-schema.arrow`** — An IPC stream message declares its own metadata length, so a payload that delivers less than it promised is truncation as a framing fact rather than a heuristic.

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
| `07-nonconforming-examples-3.0.yaml` ⚠ | typical | `asyncapi-3` ≥ 0.95 | valid | `non-conforming-examples`, `message-examples`, `schema-examples`, `enum` |
| `negative/01-syntactic-unclosed-flow-sequence.yaml` ⚠ | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-flow-sequence` |
| `negative/02-semantic-channels-not-a-mapping.yaml` ⚠ | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `semantic`, `channels-not-a-mapping` |
| `negative/03-truncated-mid-ref.yaml` ⚠ | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `truncated`, `mid-ref` |
| `negative/04-wrong-format-protobuf.proto` | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf` |
| `negative/05-encoding-utf16.yaml` | — | `asyncapi-2` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`06-payment-events-set/messages.yaml`** — Fileset member without an `asyncapi` marker — not independently detectable; imported only through the set root asyncapi.yaml, whose bundler chases this file's $refs into schemas.yaml.

> ⚠ **`06-payment-events-set/schemas.yaml`** — Fileset member without an `asyncapi` marker — not independently detectable; imported only through the set root asyncapi.yaml.

> ⚠ **`07-nonconforming-examples-3.0.yaml`** — Every message example object and schema example deliberately violates its schema; the document itself is valid AsyncAPI 3 and must import cleanly. Drives tests/test_example_conformance_corpus.py. The `x-expected-violation` intent marker sits only on the schema: an AsyncAPI 3 `MessageExample` object takes no vendor extensions, so each message example states its intent in its `summary` instead (FMT-1.3, #5414 — caught the first time CI ran with the required parser installed).

> ⚠ **`negative/01-syntactic-unclosed-flow-sequence.yaml`** — The flaw is broken YAML, so classification is text-grounded and tool-independent. Originally verified without asyncapi-parser installed; re-verified with the required parser present (FMT-1.3, #5414), which now runs in CI.

> ⚠ **`negative/02-semantic-channels-not-a-mapping.yaml`** — The asyncapi sniffer claims the document (detect_matched true) and the blatantly wrong `channels` type also fails parser validation. Originally verified without asyncapi-parser installed; re-verified with the required parser present (FMT-1.3, #5414), which now runs in CI.

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

### `avro-idl/` — Avro IDL

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-record.avdl` | minimal | `avro-idl` ≥ 0.9 | valid | `schema-only`, `record` |
| `02-typical-orders-protocol.avdl` ⚠ | typical | `avro-idl` ≥ 0.9 | valid | `protocol`, `messages`, `oneway`, `throws`, `enum`, `union` |
| `03-composition-named-type-reuse.avdl` | composition | `avro-idl` ≥ 0.9 | valid | `named-type-reuse`, `self-reference`, `map`, `array`, `schema-only` |
| `04-stress-grammar-corners.avdl` | stress | `avro-idl` ≥ 0.9 | valid | `fixed`, `decimal`, `logicalType`, `order`, `aliases`, `escaped-name`, `nested-union` |
| `05-real-world-payments-protocol.avdl` | real-world | `avro-idl` ≥ 0.9 | valid | `protocol`, `messages`, `decimal`, `errors`, `oneway` |
| `06-imports-set/common.avdl` | multi-file (member) | `avro-idl` (no guarantee) | valid | `multi-file`, `import-idl`, `schema-only` |
| `06-imports-set/main.avdl` | multi-file (root) | `avro-idl` ≥ 0.9 | valid | `multi-file`, `import-idl`, `import-schema`, `protocol` |
| `06-imports-set/parcel.avsc` ⚠ | multi-file (member) | `avro` (no guarantee) | valid | `multi-file`, `import-schema`, `record` |
| `negative/01-syntactic-missing-semicolon.avdl` | — | `avro-idl` (no guarantee) | invalid | `negative`, `syntactic`, `missing-semicolon` |
| `negative/02-semantic-duplicate-union-branch.avdl` | — | `avro-idl` (no guarantee) | invalid | `negative`, `semantic`, `duplicate-union-branch` |
| `negative/03-truncated-mid-record.avdl` | — | `avro-idl` (no guarantee) | invalid | `negative`, `truncated`, `mid-record` |
| `negative/04-wrong-format-protobuf.proto` | — | `avro-idl` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf` |
| `negative/05-encoding-utf16.avdl` | — | `avro-idl` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-unresolvable-import.avdl` | — | `avro-idl` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-import` |

> ⚠ **`02-typical-orders-protocol.avdl`** — Protocol form: messages must normalize to rpc-paradigm operations, unlike the schema-only files.

> ⚠ **`06-imports-set/parcel.avsc`** — Fileset member reached by `import schema`; on its own it is a plain .avsc the shipped avro adapter already claims.

### `aws-apigateway/` — AWS API Gateway (pending #5455)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-rest-api.yaml` | minimal | `aws-apigateway` ≥ 0.9 | valid | `rest-api`, `mock-integration`, `pending-adapter` |
| `02-typical-rest-api-export.json` | typical | `aws-apigateway` ≥ 0.9 | valid | `rest-api`, `aws-proxy`, `http-proxy`, `vpc-link`, `custom-authorizer`, `request-validator`, `cors-mock`, `pending-adapter` |
| `03-composition-stage-variables-and-refs.yaml` | composition | `aws-apigateway` ≥ 0.9 | valid | `stage-variables`, `shared-parameters`, `server-variables`, `binary-media-types`, `pending-adapter` |
| `04-stress-extension-coverage.yaml` ⚠ | stress | `aws-apigateway` ≥ 0.9 | valid | `any-method`, `greedy-proxy`, `aws-service-integration`, `gateway-responses`, `resource-policy`, `cognito-authorizer`, `token-authorizer`, `unknown-extension`, `pending-adapter` |
| `05-real-world-payments-rest-api.json` | real-world | `aws-apigateway` ≥ 0.9 | valid | `lambda-authorizer`, `idempotency-header`, `sqs-integration`, `cors`, `regional-endpoint`, `request-validator`, `pending-adapter` |
| `06-typical-http-api-export.yaml` | typical | `aws-apigateway` ≥ 0.9 | valid | `http-api`, `jwt-authorizer`, `payload-format-2.0`, `default-route`, `cors-extension`, `vpc-link`, `pending-adapter` |
| `07-split-set/api.yaml` | multi-file (root) | `aws-apigateway` ≥ 0.9 | valid | `relative-ref`, `split-definition`, `aws-proxy`, `vpc-link`, `pending-adapter` |
| `07-split-set/components.yaml` ⚠ | multi-file (member) | `aws-apigateway` (no guarantee) | valid | `schema-half`, `shared-parameters`, `pending-adapter` |
| `negative/01-syntactic-bad-yaml.yaml` | — | `aws-apigateway` (no guarantee) | invalid | `negative`, `syntactic`, `bad-indentation`, `pending-adapter` |
| `negative/02-semantic-integration-without-type.yaml` | — | `aws-apigateway` (no guarantee) | invalid | `negative`, `semantic`, `integration-without-type`, `pending-adapter` |
| `negative/03-truncated-mid-integration.json` | — | `aws-apigateway` (no guarantee) | invalid | `negative`, `truncated`, `mid-uri`, `pending-adapter` |
| `negative/04-wrong-format-plain-openapi.yaml` ⚠ | — | `aws-apigateway` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi`, `greedy-detection`, `pending-adapter` |
| `negative/05-encoding-utf16.yaml` | — | `aws-apigateway` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |

> ⚠ **`04-stress-extension-coverage.yaml`** — Carries x-example-unknown-extension: FMT-7.1 requires unknown extensions preserved in extras and reported, never dropped.

> ⚠ **`07-split-set/components.yaml`** — Fileset member: schemas and parameters reached by relative $ref; declares no paths and no AWS extensions of its own.

> ⚠ **`negative/04-wrong-format-plain-openapi.yaml`** — The FMT-7.1 acceptance case: a plain OpenAPI document with no AWS extensions must route to the openapi adapter, so this adapter's detect() must not claim it.

### `azure-apim/` — Azure API Management (pending #5456)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-policy.xml` | minimal | `azure-apim` ≥ 0.85 | valid | `policy`, `pipeline-sections`, `set-backend-service`, `pending-adapter` |
| `02-typical-arm-api.json` | typical | `azure-apim` ≥ 0.85 | valid | `arm-template`, `api-resource`, `operations`, `operation-policy`, `rate-limit-by-key`, `subscription-keys`, `pending-adapter` |
| `03-api-with-policy-set/orders.openapi.yaml` | multi-file (root) | `azure-apim` ≥ 0.85 | valid | `multi-file`, `definition-half`, `openapi`, `subscription-key`, `pending-adapter` |
| `03-api-with-policy-set/policy.xml` ⚠ | multi-file (member) | `azure-apim` (no guarantee) | valid | `multi-file`, `policy-half`, `validate-jwt`, `cors`, `quota-by-key`, `rewrite-uri`, `pending-adapter` |
| `04-stress-policy-vocabulary.xml` ⚠ | stress | `azure-apim` ≥ 0.85 | valid | `validate-jwt`, `ip-filter`, `rate-limit`, `quota`, `choose`, `retry`, `cache-lookup`, `send-request`, `set-variable`, `unknown-policy`, `pending-adapter` |
| `05-real-world-soap-passthrough-arm.json` | real-world | `azure-apim` ≥ 0.85 | valid | `soap-passthrough`, `wsdl-derived`, `backends-resource`, `product`, `xml-to-json`, `authentication-certificate`, `pending-adapter` |
| `06-typical-arm-api-versionset.json` | typical | `azure-apim` ≥ 0.85 | valid | `apiVersionSets`, `segment-versioning`, `two-versions`, `operation-policy`, `pending-adapter` |
| `07-composition-policy-inheritance.xml` ⚠ | composition | `azure-apim` ≥ 0.85 | valid | `base-element`, `scope-inheritance`, `global-scope`, `product-scope`, `api-scope`, `operation-scope`, `pending-adapter` |
| `negative/01-syntactic-unclosed-policy.xml` | — | `azure-apim` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-policy-without-sections.xml` | — | `azure-apim` (no guarantee) | invalid | `negative`, `semantic`, `no-pipeline-sections`, `pending-adapter` |
| `negative/03-truncated-mid-policy.xml` | — | `azure-apim` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute`, `pending-adapter` |
| `negative/04-wrong-format-kong.yaml` | — | `azure-apim` (no guarantee) | invalid | `negative`, `wrong-format`, `kong`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `azure-apim` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-backend-reference.xml` | — | `azure-apim` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-backend-id`, `missing-named-value`, `pending-adapter` |

> ⚠ **`03-api-with-policy-set/policy.xml`** — Fileset member: the policy document. Facts here are policy-derived provenance, distinct from the definition-derived facts in the root.

> ⚠ **`04-stress-policy-vocabulary.xml`** — Carries <example-unknown-policy>: FMT-7.2 requires unmapped policy elements preserved verbatim in extras and visible in the detail view.

> ⚠ **`07-composition-policy-inheritance.xml`** — Carries all four policy scopes in evaluation order; <base /> is the composition operator, and its position decides whether the inherited fragment runs before or after the local one.

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

### `cddl/` — CDDL (RFC 8610)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-person.cddl` | minimal | `cddl` ≥ 0.85 | valid | `map`, `optional-member` |
| `02-typical-order.cddl` | typical | `cddl` ≥ 0.85 | valid | `map`, `array`, `occurrence`, `type-choice`, `rule-reference` |
| `03-composition-sockets-and-generics.cddl` ⚠ | composition | `cddl` ≥ 0.85 | valid | `socket`, `plug`, `group-socket`, `generics`, `type-extension` |
| `04-stress-control-operators.cddl` | stress | `cddl` ≥ 0.85 | valid | `size`, `regexp`, `cbor`, `within`, `and`, `default`, `bits`, `ranges`, `tags`, `unwrap`, `table`, `group-choice` |
| `05-real-world-cose-shaped.cddl` | real-world | `cddl` ≥ 0.85 | valid | `tags`, `header-map`, `negative-labels`, `cbor`, `cose` |
| `06-real-world-webauthn-shaped.cddl` | real-world | `cddl` ≥ 0.85 | valid | `attestation`, `bits`, `cbor`, `webauthn`, `type-choice` |
| `07-modules-set/api.cddl` | multi-file (root) | `cddl` ≥ 0.85 | valid | `multi-file`, `cross-file-reference` |
| `07-modules-set/common.cddl` ⚠ | multi-file (member) | `cddl` (no guarantee) | valid | `multi-file`, `shared-types` |
| `negative/01-syntactic-unclosed-map.cddl` | — | `cddl` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-map` |
| `negative/02-semantic-duplicate-rule.cddl` | — | `cddl` (no guarantee) | invalid | `negative`, `semantic`, `duplicate-rule` |
| `negative/03-truncated-mid-rule.cddl` | — | `cddl` (no guarantee) | invalid | `negative`, `truncated`, `mid-rule` |
| `negative/04-wrong-format-json-schema.json` | — | `cddl` (no guarantee) | invalid | `negative`, `wrong-format`, `json-schema` |
| `negative/05-encoding-utf16.cddl` | — | `cddl` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-unresolvable-type-reference.cddl` | — | `cddl` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `undefined-rule` |

> ⚠ **`03-composition-sockets-and-generics.cddl`** — Sockets/plugs and generics are the constructs FMT-4.4 expects to model or declare as parsing limits; a clean import here should carry declared-limit warnings, not silence.

> ⚠ **`07-modules-set/common.cddl`** — Fileset member: shared value types with no entry point of their own — CDDL has no include, so the set is the unit of import.

### `cics-bms/` — CICS BMS maps (pending #5484)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-mapset.bms` | minimal | `cics-bms` ≥ 0.9 | valid | `dfhmsd`, `dfhmdi`, `dfhmdf`, `literal-field`, `pending-adapter` |
| `02-typical-enquiry-map.bms` | typical | `cics-bms` ≥ 0.9 | valid | `picin`, `picout`, `edited-picture`, `message-line`, `color`, `initial-cursor`, `pending-adapter` |
| `03-mapset-and-copybook-set/ORDRMAP.cpy` ⚠ | multi-file (member) | `cics-bms` (no guarantee) | valid | `multi-file`, `symbolic-map`, `length-attribute-data-triple`, `input-output-redefine`, `pending-adapter` |
| `03-mapset-and-copybook-set/ORDRSET.bms` | multi-file (root) | `cics-bms` ≥ 0.9 | valid | `multi-file`, `mapset`, `screen-positions`, `pending-adapter` |
| `04-stress-field-attributes.bms` | stress | `cics-bms` ≥ 0.9 | valid | `attrb-combinations`, `askip`, `dark`, `numeric`, `fset`, `extended-attributes`, `validn`, `occurs`, `grpname`, `second-map`, `pending-adapter` |
| `05-real-world-order-entry-mapset.bms` | real-world | `cics-bms` ≥ 0.9 | valid | `three-maps`, `repeating-table`, `occurs`, `edited-pictures`, `confirmation-map`, `pending-adapter` |
| `06-typical-dsect-copybook.cpy` | typical | `cics-bms` ≥ 0.9 | valid | `symbolic-map`, `length-attribute-data-triple`, `input-output-redefine`, `comp-length`, `pending-adapter` |
| `07-composition-map-inheritance.bms` | composition | `cics-bms` ≥ 0.9 | valid | `shared-chrome`, `mapset-defaults`, `field-group`, `repeating-table`, `multiple-maps`, `pending-adapter` |
| `negative/01-syntactic-missing-continuation.bms` | — | `cics-bms` (no guarantee) | invalid | `negative`, `syntactic`, `missing-continuation-mark`, `pending-adapter` |
| `negative/02-semantic-map-without-fields.bms` | — | `cics-bms` (no guarantee) | invalid | `negative`, `semantic`, `no-fields`, `pending-adapter` |
| `negative/03-truncated-mid-field.bms` | — | `cics-bms` (no guarantee) | invalid | `negative`, `truncated`, `mid-initial-value`, `pending-adapter` |
| `negative/04-wrong-format-idcams.idcams` | — | `cics-bms` (no guarantee) | invalid | `negative`, `wrong-format`, `vsam-idcams`, `pending-adapter` |
| `negative/05-encoding-utf16.bms` | — | `cics-bms` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-overlapping-field-positions.bms` | — | `cics-bms` (no guarantee) | invalid | `negative`, `semantic`, `overlapping-fields`, `off-screen-position`, `pending-adapter` |

> ⚠ **`03-mapset-and-copybook-set/ORDRMAP.cpy`** — Fileset member: the generated symbolic map. It carries the record layout; the .bms carries the geometry.

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
| `05-ach-entry-detail.cpy` | real-world | `cobolcopybook` ≥ 0.95 | valid | `pic`, `level-88`, `values`, `fixed-length-record` |
| `06-account-master.cpy` | typical | `cobolcopybook` ≥ 0.95 | valid | `pic`, `comp-3`, `level-88`, `nested-groups` |
| `07-ledger-unmodelled.cpy` ⚠ | composition | `cobolcopybook` ≥ 0.95 | valid | `renames-66`, `copy-statement`, `copy-replacing`, `national-pic`, `comp-3`, `pic`, `level-88` |
| `08-overlay-warnings.cpy` ⚠ | composition | `cobolcopybook` ≥ 0.95 | valid | `redefines`, `redefines-target-missing`, `redefines-size-mismatch`, `pic` |
| `negative/01-syntactic-garbled-level.cpy` | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `syntactic`, `garbled-level-number` |
| `negative/02-semantic-level-05-before-01.cpy` | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `semantic`, `level-05-before-01` |
| `negative/03-truncated-order-line.cpy` ⚠ | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-inventory.idl` | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `wrong-format`, `corba-idl-document` |
| `negative/05-encoding-utf16-order-line.cpy` | — | `cobolcopybook` (no guarantee) | invalid | `negative`, `encoding`, `utf-16-bytes` |

> ⚠ **`07-ledger-unmodelled.cpy`** — Carries the documented-unmodelled clauses (level-66 regrouping, nested member inclusion with substitution, PIC N). CPDO-4.1 pins the analysis warnings copybook.renames_66 / copybook.copy_statement / copybook.copy_replacing / copybook.unsized_item and the resulting partial status.

> ⚠ **`08-overlay-warnings.cpy`** — REDEFINES overlays that are deliberately imperfect: one redefining item outgrows its target, one names a target declared in a surrounding copybook. CPDO-4.1 pins copybook.redefines_target_missing / copybook.redefines_size_mismatch as evidence, not errors.

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

### `consul/` — Consul service definitions (pending #5459)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-service.json` | minimal | `consul` ≥ 0.8 | valid | `service-definition`, `port`, `pending-adapter` |
| `02-typical-service-with-checks.json` | typical | `consul` ≥ 0.8 | valid | `tags`, `urlprefix-tag`, `meta`, `health-checks`, `weights`, `pending-adapter` |
| `03-service-set/catalogue.json` | multi-file (member) | `consul` (no guarantee) | valid | `multi-file`, `service-definition`, `pending-adapter` |
| `03-service-set/orders.json` | multi-file (root) | `consul` ≥ 0.8 | valid | `multi-file`, `service-definition`, `connect-sidecar`, `pending-adapter` |
| `03-service-set/service-router.json` ⚠ | multi-file (member) | `consul` (no guarantee) | valid | `multi-file`, `service-router`, `path-prefix`, `prefix-rewrite`, `pending-adapter` |
| `04-stress-connect-and-resolvers.hcl` | stress | `consul` ≥ 0.8 | valid | `hcl`, `connect`, `sidecar-upstreams`, `grpc-check`, `alias-check`, `service-router`, `path-exact`, `path-regex`, `header-match`, `query-match`, `subset`, `retries`, `pending-adapter` |
| `05-real-world-catalog-export.json` | real-world | `consul` ≥ 0.8 | valid | `catalog-export`, `nodes`, `check-status`, `service-meta`, `datacenter`, `pending-adapter` |
| `06-typical-ingress-gateway.json` | typical | `consul` ≥ 0.8 | valid | `ingress-gateway`, `listeners`, `http`, `grpc`, `tcp`, `pending-adapter` |
| `07-composition-resolver-and-splitter.hcl` | composition | `consul` ≥ 0.8 | valid | `service-defaults`, `service-resolver`, `service-splitter`, `service-router`, `subsets`, `failover`, `hcl`, `pending-adapter` |
| `negative/01-syntactic-trailing-comma.json` | — | `consul` (no guarantee) | invalid | `negative`, `syntactic`, `trailing-comma`, `pending-adapter` |
| `negative/02-semantic-service-without-port.json` | — | `consul` (no guarantee) | invalid | `negative`, `semantic`, `no-port`, `pending-adapter` |
| `negative/03-truncated-mid-check.json` | — | `consul` (no guarantee) | invalid | `negative`, `truncated`, `mid-check`, `pending-adapter` |
| `negative/04-wrong-format-tyk.json` | — | `consul` (no guarantee) | invalid | `negative`, `wrong-format`, `tyk`, `pending-adapter` |
| `negative/05-encoding-utf16.json` | — | `consul` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-service-reference.json` | — | `consul` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-service`, `missing-subset`, `pending-adapter` |

> ⚠ **`03-service-set/service-router.json`** — Fileset member: the only file in the set that carries paths — the service definitions alone describe no routes.

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

### `cue/` — CUE (pending #5466)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-schema.cue` | minimal | `cue` ≥ 0.85 | valid | `definition`, `scalars`, `pending-adapter` |
| `02-typical-order-schema.cue` | typical | `cue` ≥ 0.85 | valid | `disjunction`, `regex-constraint`, `range-constraint`, `list-type`, `optional-field`, `default-branch`, `pending-adapter` |
| `03-imports-set/cue.mod` ⚠ | multi-file (member) | `cue` (no guarantee) | valid | `multi-file`, `module-file`, `pending-adapter` |
| `03-imports-set/schema.cue` | multi-file (root) | `cue` ≥ 0.85 | valid | `multi-file`, `import`, `package`, `pending-adapter` |
| `03-imports-set/shared.cue` | multi-file (member) | `cue` (no guarantee) | valid | `multi-file`, `package`, `definitions`, `pending-adapter` |
| `04-stress-lattice.cue` ⚠ | stress | `cue` ≥ 0.85 | valid | `open-struct`, `closed-struct`, `embedding`, `unification`, `comprehension`, `conditional-field`, `hidden-field`, `let-binding`, `recursion`, `interpolation`, `pattern-constraint`, `pending-adapter` |
| `05-real-world-service-config.cue` | real-world | `cue` ≥ 0.85 | valid | `defaults`, `cross-field-constraint`, `pattern-keyed-map`, `schema-plus-instance`, `pending-adapter` |
| `06-typical-schema-and-data.cue` | typical | `cue` ≥ 0.85 | valid | `schema-plus-data`, `unification`, `defaults`, `pending-adapter` |
| `07-composition-embedding.cue` | composition | `cue` ≥ 0.85 | valid | `embedding`, `unification`, `disjunction`, `pattern-constraint`, `pending-adapter` |
| `negative/01-syntactic-unclosed-struct.cue` | — | `cue` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-struct`, `pending-adapter` |
| `negative/02-semantic-conflicting-unification.cue` | — | `cue` (no guarantee) | invalid | `negative`, `semantic`, `bottom-value`, `conflicting-constraints`, `pending-adapter` |
| `negative/03-truncated-mid-constraint.cue` | — | `cue` (no guarantee) | invalid | `negative`, `truncated`, `mid-constraint`, `pending-adapter` |
| `negative/04-wrong-format-hcl.hcl` | — | `cue` (no guarantee) | invalid | `negative`, `wrong-format`, `hcl`, `pending-adapter` |
| `negative/05-encoding-utf16.cue` | — | `cue` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-incomplete-value.cue` ⚠ | — | `cue` (no guarantee) | invalid | `negative`, `semantic`, `incomplete-value`, `pending-adapter` |

> ⚠ **`03-imports-set/cue.mod`** — Fileset member: the module descriptor that makes the import path resolvable.

> ⚠ **`04-stress-lattice.cue`** — Second half is deliberately outside JSON Schema's reach; FMT-8.5 requires those declared rather than approximated.

> ⚠ **`negative/06-semantic-incomplete-value.cue`** — Valid CUE that `cue export` refuses: the sandboxed evaluation produces no JSON, so the import must fail with that reason rather than an empty model.

### `dbt/` — dbt models and manifests

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-schema.yml` | minimal | `dbt` ≥ 0.85 | valid | `models`, `columns` |
| `02-typical-schema.yml` | typical | `dbt` ≥ 0.85 | valid | `not-null`, `unique`, `accepted-values`, `relationships`, `meta`, `tags` |
| `03-project-set/dbt_project.yml` | multi-file (root) | `dbt` ≥ 0.85 | valid | `multi-file`, `dbt-project`, `materialization-config` |
| `03-project-set/fct_orders.sql` ⚠ | multi-file (member) | `dbt` (no guarantee) | valid | `multi-file`, `ref`, `lineage` |
| `03-project-set/schema.yml` | multi-file (member) | `dbt` (no guarantee) | valid | `multi-file`, `models`, `relationships` |
| `03-project-set/stg_orders.sql` | multi-file (member) | `dbt` (no guarantee) | valid | `multi-file`, `source`, `lineage` |
| `04-stress-contracts-sources-and-exposures.yml` | stress | `dbt` ≥ 0.85 | valid | `contract`, `constraints`, `sources`, `freshness`, `versions`, `seeds`, `snapshots`, `exposures`, `package-test`, `severity` |
| `05-real-world-manifest.json` | real-world | `dbt` ≥ 0.85 | valid | `manifest`, `nodes`, `test-metadata`, `parent-map`, `child-map`, `exposures` |
| `06-semantic-manifest.yml` | typical | `dbt` ≥ 0.85 | valid | `semantic-models`, `entities`, `dimensions`, `measures`, `metrics`, `derived-metric` |
| `07-composition-model-inheritance.yml` | composition | `dbt` ≥ 0.85 | valid | `yaml-anchors`, `shared-column-groups`, `shared-tests`, `versions` |
| `negative/01-syntactic-bad-indentation.yml` | — | `dbt` (no guarantee) | invalid | `negative`, `syntactic`, `bad-indentation` |
| `negative/02-semantic-no-models.yml` | — | `dbt` (no guarantee) | invalid | `negative`, `semantic`, `no-resources` |
| `negative/03-truncated-mid-test.yml` | — | `dbt` (no guarantee) | invalid | `negative`, `truncated`, `mid-flow-sequence` |
| `negative/04-wrong-format-odcs.yaml` | — | `dbt` (no guarantee) | invalid | `negative`, `wrong-format`, `odcs` |
| `negative/05-encoding-utf16.yml` | — | `dbt` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-unresolvable-ref.yml` ⚠ | — | `dbt` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `broken-ref` |

> ⚠ **`03-project-set/fct_orders.sql`** — Fileset member: the model SQL whose ref() calls are the lineage edges; not independently detectable as dbt.

> ⚠ **`negative/06-unresolvable-ref.yml`** — The FMT-5.4 acceptance case: a project with a broken ref().

### `dhall/` — Dhall (pending #5466)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-schema.dhall` | minimal | `dhall` ≥ 0.85 | valid | `schema-record`, `default`, `pending-adapter` |
| `02-typical-order-schema.dhall` | typical | `dhall` ≥ 0.85 | valid | `record-type`, `union-type`, `Optional`, `List`, `typed-default`, `pending-adapter` |
| `03-imports-set/package.dhall` | multi-file (root) | `dhall` ≥ 0.85 | valid | `multi-file`, `package-file`, `import`, `pending-adapter` |
| `03-imports-set/shared.dhall` | multi-file (member) | `dhall` (no guarantee) | valid | `multi-file`, `shared-types`, `pending-adapter` |
| `04-stress-type-system.dhall` ⚠ | stress | `dhall` ≥ 0.85 | valid | `union-with-payload`, `map-list`, `record-type-merge`, `record-prefer`, `type-function`, `generic-record`, `fold`, `hash-pinned-import`, `pending-adapter` |
| `05-real-world-service-config.dhall` | real-world | `dhall` ≥ 0.85 | valid | `nested-schema-records`, `completion-operator`, `defaults`, `enumerated-environment`, `pending-adapter` |
| `06-typical-union-and-defaults.dhall` | typical | `dhall` ≥ 0.85 | valid | `union-constructors`, `completion-operator`, `defaults`, `pending-adapter` |
| `07-composition-record-merge.dhall` | composition | `dhall` ≥ 0.85 | valid | `record-type-merge`, `record-prefer`, `schema-record-reuse`, `union-of-composed`, `pending-adapter` |
| `negative/01-syntactic-missing-in.dhall` | — | `dhall` (no guarantee) | invalid | `negative`, `syntactic`, `missing-in`, `pending-adapter` |
| `negative/02-semantic-type-mismatch.dhall` | — | `dhall` (no guarantee) | invalid | `negative`, `semantic`, `type-mismatch`, `pending-adapter` |
| `negative/03-truncated-mid-record.dhall` | — | `dhall` (no guarantee) | invalid | `negative`, `truncated`, `mid-union`, `pending-adapter` |
| `negative/04-wrong-format-nickel.ncl` | — | `dhall` (no guarantee) | invalid | `negative`, `wrong-format`, `nickel`, `pending-adapter` |
| `negative/05-encoding-utf16.dhall` | — | `dhall` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-import.dhall` | — | `dhall` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-import`, `pending-adapter` |

> ⚠ **`04-stress-type-system.dhall`** — Type-level functions and the hash-pinned import are the declared limits; the sandbox must also refuse remote imports outright.

### `dicom/` — DICOM (pending #5451)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-json.json` | minimal | `dicom` ≥ 0.9 | valid | `dicom-json`, `sop-class`, `patient-module`, `pending-adapter` |
| `02-typical-ct-instance-json.json` | typical | `dicom` ≥ 0.9 | valid | `dicom-json`, `ct`, `image-plane`, `image-pixel-descriptors`, `rescale`, `pending-adapter` |
| `03-composition-structured-report-json.json` | composition | `dicom` ≥ 0.9 | valid | `structured-report`, `ContentSequence`, `nested-sequences`, `coded-concepts`, `measured-value`, `pending-adapter` |
| `04-stress-part10-sequences-and-pixeldata.dcm` ⚠ | stress | `dicom` ≥ 0.9 | valid | `part10`, `binary-intake`, `explicit-vr`, `nested-sequences`, `private-block`, `pixel-data-skipped`, `multi-valued`, `pending-adapter` |
| `05-real-world-mr-series-json.json` | real-world | `dicom` ≥ 0.9 | valid | `dicom-json`, `mr`, `acquisition-parameters`, `frame-of-reference`, `referenced-pps`, `pending-adapter` |
| `06-typical-part10-minimal.dcm` | typical | `dicom` ≥ 0.9 | valid | `part10`, `binary-intake`, `file-meta-group`, `explicit-vr`, `pending-adapter` |
| `07-study-set/series-1-instance.json` ⚠ | multi-file (member) | `dicom` (no guarantee) | valid | `instance`, `series-1`, `pending-adapter` |
| `07-study-set/series-2-instance.json` ⚠ | multi-file (member) | `dicom` (no guarantee) | valid | `instance`, `series-2`, `image-plane`, `pending-adapter` |
| `07-study-set/study-index.json` | multi-file (root) | `dicom` ≥ 0.9 | valid | `study-level-query`, `series-counts`, `dicomweb-url`, `pending-adapter` |
| `negative/01-syntactic-broken-json.json` | — | `dicom` (no guarantee) | invalid | `negative`, `syntactic`, `missing-comma`, `pending-adapter` |
| `negative/02-semantic-no-sop-class.json` | — | `dicom` (no guarantee) | invalid | `negative`, `semantic`, `missing-sop-class`, `pending-adapter` |
| `negative/03-truncated-mid-element.dcm` | — | `dicom` (no guarantee) | invalid | `negative`, `truncated`, `part10`, `mid-element`, `pending-adapter` |
| `negative/04-wrong-format-fhir-imagingstudy.json` | — | `dicom` (no guarantee) | invalid | `negative`, `wrong-format`, `fhir`, `ImagingStudy`, `pending-adapter` |
| `negative/05-encoding-utf16.json` | — | `dicom` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-missing-dicm-preamble.dcm` ⚠ | — | `dicom` (no guarantee) | invalid | `negative`, `semantic`, `missing-magic`, `pending-adapter` |

> ⚠ **`04-stress-part10-sequences-and-pixeldata.dcm`** — Contains a (7FE0,0010) PixelData element of eight zero bytes so the skip can be asserted; the private (0009,10xx) block with VR UN is a declared parsing limit.

> ⚠ **`07-study-set/series-1-instance.json`** — Fileset member: an instance of the first series, keyed by the same StudyInstanceUID.

> ⚠ **`07-study-set/series-2-instance.json`** — Fileset member: an instance of the second series.

> ⚠ **`negative/06-semantic-missing-dicm-preamble.dcm`** — 128-byte preamble present but the magic is not DICM, so the file cannot be claimed as Part 10.

### `discovery/` — Google API Discovery

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-bookstore-api.json` | typical | `discovery` ≥ 0.95 | valid | `resources`, `nested-resources`, `methods`, `parameters`, `enums`, `schemas`, `refs` |
| `02-minimal-ping.json` | minimal | `discovery` ≥ 0.95 | valid | `resources`, `methods`, `schemas` |
| `03-components-refs.json` | composition | `discovery` ≥ 0.95 | valid | `resources`, `nested-resources`, `schemas`, `refs` |
| `04-stress-widgets.json` | stress | `discovery` ≥ 0.95 | valid | `resources`, `methods`, `stress` |
| `05-webfonts-sample.json` | real-world | `discovery` ≥ 0.95 | valid | `resources`, `methods`, `enums`, `schemas`, `refs` |
| `06-booking-service.json` | typical | `discovery` ≥ 0.95 | valid | `resources`, `methods`, `parameters`, `headers`, `schemas` |
| `negative/01-syntactic-unclosed-brace.json` | — | `discovery` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-missing-name.json` | — | `discovery` (no guarantee) | invalid | `negative`, `semantic`, `missing-name` |
| `negative/03-truncated-mid-token.json` | — | `discovery` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-protobuf.proto` | — | `discovery` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf-idl` |
| `negative/05-encoding-utf16.json` | — | `discovery` (no guarantee) | invalid | `negative`, `encoding`, `utf16` |

### `dtd/` — DTD

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-note.dtd` | minimal | `dtd` ≥ 0.85 | valid | `ELEMENT`, `ATTLIST`, `PCDATA` |
| `02-typical-catalogue.dtd` | typical | `dtd` ≥ 0.85 | valid | `sequence`, `occurrence-indicators`, `enumerated-attribute`, `REQUIRED`, `IMPLIED`, `FIXED`, `default-value` |
| `03-modular-set/common.dtd` | multi-file (member) | `dtd` (no guarantee) | valid | `multi-file`, `parameter-entity`, `shared-attributes` |
| `03-modular-set/document.dtd` | multi-file (root) | `dtd` ≥ 0.85 | valid | `multi-file`, `parameter-entity`, `external-subset` |
| `03-modular-set/table.dtd` | multi-file (member) | `dtd` (no guarantee) | valid | `multi-file`, `parameter-entity` |
| `04-stress-content-models-and-entities.dtd` ⚠ | stress | `dtd` ≥ 0.85 | valid | `ANY`, `EMPTY`, `mixed-content`, `choice`, `parameter-entity`, `general-entity`, `NOTATION`, `unparsed-entity`, `NMTOKENS` |
| `05-real-world-rss-2.0-subset.dtd` | real-world | `dtd` ≥ 0.85 | valid | `optional-heavy`, `repeated-elements`, `FIXED` |
| `06-internal-subset-invoice.xml` | typical | `dtd` ≥ 0.85 | valid | `internal-subset`, `DOCTYPE`, `general-entity`, `instance-document` |
| `07-composition-parameter-entities.dtd` | composition | `dtd` ≥ 0.85 | valid | `parameter-entity`, `attribute-set`, `content-model-fragment`, `nested-fragments` |
| `negative/01-syntactic-unterminated-declaration.dtd` | — | `dtd` (no guarantee) | invalid | `negative`, `syntactic`, `unterminated-declaration` |
| `negative/02-semantic-undeclared-element-in-model.dtd` | — | `dtd` (no guarantee) | invalid | `negative`, `semantic`, `undeclared-element` |
| `negative/03-truncated-mid-attlist.dtd` | — | `dtd` (no guarantee) | invalid | `negative`, `truncated`, `mid-attlist` |
| `negative/04-wrong-format-relaxng.rng` | — | `dtd` (no guarantee) | invalid | `negative`, `wrong-format`, `relaxng` |
| `negative/05-encoding-utf16.dtd` | — | `dtd` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-unresolvable-parameter-entity.dtd` | — | `dtd` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-parameter-entity` |

> ⚠ **`04-stress-content-models-and-entities.dtd`** — Bounded, non-recursive three-level entity chain — exercises expansion accounting without being an expansion bomb; mixed content is a declared limit.

### `edi-x12/` — EDI ASC X12

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-850-purchase-order.edi` | typical | `edix12` ≥ 0.9 | valid | `850-purchase-order`, `isa-envelope`, `iea-trailer` |
| `02-810-invoice.edi` | typical | `edix12` ≥ 0.9 | valid | `810-invoice`, `isa-envelope`, `iea-trailer` |
| `03-997-acknowledgment.edi` | minimal | `edix12` ≥ 0.9 | valid | `997-acknowledgment`, `isa-envelope`, `iea-trailer` |
| `04-multi-group-po-ack.edi` | composition | `edix12` ≥ 0.9 | valid | `multi-functional-group`, `850-purchase-order`, `997-acknowledgment`, `isa-envelope` |
| `05-856-asn-hierarchical.edi` | stress | `edix12` ≥ 0.9 | valid | `856-ship-notice`, `hl-loops`, `ta1-acknowledgment`, `multi-transaction-set` |
| `06-834-benefit-enrollment.edi` | real-world | `edix12` ≥ 0.9 | valid | `834-benefit-enrollment`, `hipaa-5010`, `isa-envelope`, `iea-trailer` |
| `07-837-composite-claim.edi` ⚠ | composition | `edix12` ≥ 0.9 | valid | `composite-elements`, `repeated-segments`, `837-claim`, `isa-envelope` |
| `negative/01-syntactic-missing-se.edi` ⚠ | — | `edix12` (no guarantee) | invalid | `negative`, `syntactic`, `missing-se-trailer` |
| `negative/02-semantic-nested-gs.edi` ⚠ | — | `edix12` (no guarantee) | invalid | `negative`, `semantic`, `nested-gs-groups` |
| `negative/03-truncated-850-purchase-order.edi` | — | `edix12` (no guarantee) | invalid | `negative`, `truncated`, `mid-token-cut` |
| `negative/04-wrong-format-adt-admit.hl7` | — | `edix12` (no guarantee) | invalid | `negative`, `wrong-format`, `hl7v2-message` |
| `negative/05-encoding-utf16-invoice.edi` | — | `edix12` (no guarantee) | invalid | `negative`, `encoding`, `utf-16-bytes` |

> ⚠ **`07-837-composite-claim.edi`** — The only corpus interchange whose elements carry composites (CLM05 11>B>1, SV1 HC>code>modifier under the ISA16 sub-element separator). CPDO-4.1 pins composite/component analysis nodes from a shipped fixture instead of an inline test literal.

> ⚠ **`negative/01-syntactic-missing-se.edi`** — ISA-level syntactic faults were avoided on purpose: pyx12 raises X12Error/IndexError out of X12Reader iteration for a short or reordered ISA envelope and the exception escapes parse_edix12 unwrapped (UNHANDLED in the pipeline); the missing-SE variant fails cleanly via the adapter's own EdiX12ParseError.

> ⚠ **`negative/02-semantic-nested-gs.edi`** — The canonical semantic negative (SE segment-count mismatch, e.g. SE*9 over 6 segments) does NOT fail here: pyx12 treats the count mismatch as non-fatal and the import completes all the way to persist, so the nested-GS contradiction is used instead.

### `edifact/` — UN/EDIFACT (pending #5445)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-orders-d96a.edi` | minimal | `edifact` ≥ 0.9 | valid | `ORDERS`, `D96A`, `default-delimiters`, `pending-adapter` |
| `02-typical-invoic-d96a.edi` | typical | `edifact` ≥ 0.9 | valid | `INVOIC`, `D96A`, `UNA`, `NAD`, `TAX`, `MOA`, `CUX`, `pending-adapter` |
| `03-typical-desadv-d01b.edi` | typical | `edifact` ≥ 0.9 | valid | `DESADV`, `D01B`, `PAC`, `MEA`, `GIN`, `TDT`, `CPS`, `pending-adapter` |
| `04-stress-multi-message-group.edi` ⚠ | stress | `edifact` ≥ 0.9 | valid | `UNG`, `UNE`, `multi-message`, `comma-decimal`, `release-character`, `empty-elements`, `pending-adapter` |
| `05-real-world-eancom-orders.edi` | real-world | `edifact` ≥ 0.9 | valid | `EANCOM`, `ORDERS`, `GLN`, `PIA`, `IMD`, `LOC`, `association-code`, `pending-adapter` |
| `06-typical-odette-delfor.edi` ⚠ | typical | `edifact` ≥ 0.9 | valid | `ODETTE`, `DELFOR`, `SCC`, `schedule-lines`, `UNOA`, `pending-adapter` |
| `07-stress-control-count-mismatch.edi` ⚠ | stress | `edifact` ≥ 0.9 | valid | `control-counts`, `declared-vs-observed`, `self-inconsistent`, `pending-adapter` |
| `08-composition-nested-segment-groups.edi` | composition | `edifact` ≥ 0.9 | valid | `nested-segment-groups`, `contact-group`, `allowance-charge`, `tax-group`, `INVOIC`, `pending-adapter` |
| `09-interchange-set/contrl.edi` ⚠ | multi-file (member) | `edifact` (no guarantee) | valid | `CONTRL`, `functional-acknowledgment`, `UCI`, `UCM`, `pending-adapter` |
| `09-interchange-set/orders.edi` | multi-file (root) | `edifact` ≥ 0.9 | valid | `ORDERS`, `interchange`, `pending-adapter` |
| `negative/01-syntactic-missing-segment-terminator.edi` | — | `edifact` (no guarantee) | invalid | `negative`, `syntactic`, `missing-terminator`, `pending-adapter` |
| `negative/02-semantic-no-message-in-interchange.edi` | — | `edifact` (no guarantee) | invalid | `negative`, `semantic`, `no-message`, `pending-adapter` |
| `negative/03-truncated-mid-segment.edi` | — | `edifact` (no guarantee) | invalid | `negative`, `truncated`, `mid-segment`, `pending-adapter` |
| `negative/04-wrong-format-x12.edi` ⚠ | — | `edifact` (no guarantee) | invalid | `negative`, `wrong-format`, `x12`, `pending-adapter` |
| `negative/05-encoding-utf16.edi` | — | `edifact` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-unh-without-unt.edi` | — | `edifact` (no guarantee) | invalid | `negative`, `semantic`, `unterminated-message`, `pending-adapter` |

> ⚠ **`04-stress-multi-message-group.edi`** — Two functional groups and three messages: the canonical model is derived from the first group's first message and the extras must be reported, exactly as the X12 analyzer does.

> ⚠ **`06-typical-odette-delfor.edi`** — The ODETTE/VDA dialect sample FMT-6.5 needs; detection must record the profile rather than treating it as plain EDIFACT.

> ⚠ **`07-stress-control-count-mismatch.edi`** — UNT declares 99 segments and UNZ declares 7 interchanges; both disagree with what is present. The acceptance criterion is that both numbers are shown, not that the interchange is rejected.

> ⚠ **`09-interchange-set/contrl.edi`** — Fileset member: the CONTRL acknowledgment referring to the ORDERS interchange by its control reference.

> ⚠ **`negative/04-wrong-format-x12.edi`** — An ISA/GS/ST interchange: the same file extension, the same industry, a different syntax — the misroute the EDIFACT sniffer must not make.

### `envoy-xds/` — Envoy xDS routes (pending #5458)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-route-config.yaml` | minimal | `envoy-xds` ≥ 0.85 | valid | `route-config`, `virtual-host`, `prefix-match`, `pending-adapter` |
| `02-typical-bootstrap.yaml` | typical | `envoy-xds` ≥ 0.85 | valid | `bootstrap`, `listener`, `http-connection-manager`, `clusters`, `direct-response`, `prefix-rewrite`, `pending-adapter` |
| `03-composition-multi-virtualhost.yaml` | composition | `envoy-xds` ≥ 0.85 | valid | `multi-virtual-host`, `wildcard-domain`, `require-tls`, `header-match`, `redirect`, `response-headers`, `pending-adapter` |
| `04-stress-matchers.yaml` | stress | `envoy-xds` ≥ 0.85 | valid | `path-match`, `prefix-match`, `path-separated-prefix`, `safe-regex`, `header-match`, `query-parameter-match`, `runtime-fraction`, `grpc-match`, `connect-matcher`, `weighted-clusters`, `retry-policy`, `regex-rewrite`, `typed-per-filter-config`, `cors`, `rate-limits`, `pending-adapter` |
| `05-real-world-mesh-bootstrap.yaml` | real-world | `envoy-xds` ≥ 0.85 | valid | `sidecar-bootstrap`, `node-metadata`, `ads`, `jwt-authn`, `inbound-listener`, `pending-adapter` |
| `06-typical-discovery-response.json` | typical | `envoy-xds` ≥ 0.85 | valid | `discovery-response`, `type-url`, `route-config`, `retry-policy`, `pending-adapter` |
| `07-filesystem-xds-set/bootstrap.yaml` | multi-file (root) | `envoy-xds` ≥ 0.85 | valid | `filesystem-xds`, `rds`, `path-config-source`, `pending-adapter` |
| `07-filesystem-xds-set/cds.yaml` ⚠ | multi-file (member) | `envoy-xds` (no guarantee) | valid | `clusters`, `discovery-resources`, `pending-adapter` |
| `07-filesystem-xds-set/rds.yaml` ⚠ | multi-file (member) | `envoy-xds` (no guarantee) | valid | `route-configuration`, `discovery-resources`, `pending-adapter` |
| `negative/01-syntactic-bad-yaml.yaml` | — | `envoy-xds` (no guarantee) | invalid | `negative`, `syntactic`, `bad-indentation`, `pending-adapter` |
| `negative/02-semantic-no-virtual-hosts.yaml` | — | `envoy-xds` (no guarantee) | invalid | `negative`, `semantic`, `no-virtual-hosts`, `pending-adapter` |
| `negative/03-truncated-mid-route.yaml` | — | `envoy-xds` (no guarantee) | invalid | `negative`, `truncated`, `mid-value`, `pending-adapter` |
| `negative/04-wrong-format-istio-virtualservice.yaml` ⚠ | — | `envoy-xds` (no guarantee) | invalid | `negative`, `wrong-format`, `istio`, `pending-adapter` |
| `negative/05-encoding-utf16.yaml` | — | `envoy-xds` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-cluster-reference.yaml` | — | `envoy-xds` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-cluster`, `pending-adapter` |

> ⚠ **`07-filesystem-xds-set/cds.yaml`** — Fileset member: the clusters the routes target.

> ⚠ **`07-filesystem-xds-set/rds.yaml`** — Fileset member: the route configuration the bootstrap's rds block names.

> ⚠ **`negative/04-wrong-format-istio-virtualservice.yaml`** — The sibling sub-format from the same ticket: it must route to the istio front end, not be parsed as an Envoy route config.

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

### `fix-orchestra/` — FIX Orchestra (pending #5453)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-repository.xml` | minimal | `fix-orchestra` ≥ 0.9 | valid | `codeSet`, `fields`, `message`, `structure`, `pending-adapter` |
| `02-typical-order-repository.xml` | typical | `fix-orchestra` ≥ 0.9 | valid | `datatypes`, `codeSets`, `component`, `componentRef`, `documentation`, `metadata`, `pending-adapter` |
| `03-composition-components-and-groups.xml` | composition | `fix-orchestra` ≥ 0.9 | valid | `group`, `nested-group`, `numInGroup`, `groupRef`, `componentRef`, `pending-adapter` |
| `04-stress-presence-and-rules.xml` | stress | `fix-orchestra` ≥ 0.9 | valid | `presence-required`, `presence-optional`, `presence-conditional`, `presence-forbidden`, `presence-ignored`, `presence-constant`, `rule`, `when`, `scenario`, `responses`, `pending-adapter` |
| `05-real-world-execution-flow.xml` | real-world | `fix-orchestra` ≥ 0.9 | valid | `actors`, `flow`, `responses`, `conditional-rules`, `execution-report`, `cancel-reject`, `pending-adapter` |
| `06-typical-actors-and-state-machine.xml` | typical | `fix-orchestra` ≥ 0.9 | valid | `actors`, `flow-reliability`, `states`, `transition`, `state-machine`, `pending-adapter` |
| `07-modular-set/codesets.xml` ⚠ | multi-file (member) | `fix-orchestra` (no guarantee) | valid | `shared-code-sets`, `xinclude-target`, `pending-adapter` |
| `07-modular-set/repository.xml` | multi-file (root) | `fix-orchestra` ≥ 0.9 | valid | `xinclude`, `modular-repository`, `conditional-rule`, `pending-adapter` |
| `negative/01-syntactic-unclosed-message.xml` | — | `fix-orchestra` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-no-messages.xml` | — | `fix-orchestra` (no guarantee) | invalid | `negative`, `semantic`, `no-messages`, `pending-adapter` |
| `negative/03-truncated-mid-codeset.xml` | — | `fix-orchestra` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute`, `pending-adapter` |
| `negative/04-wrong-format-fix-tagvalue.fix` ⚠ | — | `fix-orchestra` (no guarantee) | invalid | `negative`, `wrong-format`, `fix-tagvalue`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `fix-orchestra` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-field-ref.xml` | — | `fix-orchestra` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-field`, `missing-component`, `pending-adapter` |

> ⚠ **`07-modular-set/codesets.xml`** — Fileset member: the shared code-set library; on its own it types nothing.

> ⚠ **`negative/04-wrong-format-fix-tagvalue.fix`** — A tag=value message log: the shipped fix adapter's input, and the thing Orchestra is the specification *for*. Detection must not confuse the two.

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

### `gateway-api/` — Gateway API HTTPRoute

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-httproute.yaml` | minimal | `gateway-api` ≥ 0.9 | valid | `minimal`, `single-route` |
| `02-typical-hostnames-methods.yaml` | typical | `gateway-api` ≥ 0.9 | valid | `typical`, `hostnames`, `regex-paths`, `multi-rule` |
| `03-multi-route-stream.yaml` ⚠ | composition | `gateway-api` ≥ 0.9 | valid | `composition`, `multi-document`, `gateway-resource` |
| `04-stress-filters-matches.yaml` | stress | `gateway-api` ≥ 0.9 | valid | `stress`, `filters`, `header-matches`, `query-matches`, `weighted-backends`, `extension-ref` |
| `05-real-world-microservices.yaml` | real-world | `gateway-api` ≥ 0.9 | valid | `real-world`, `multi-document`, `namespaces`, `weighted-backends` |
| `06-manifest-set/gateway.yaml` ⚠ | multi-file (member) | `gateway-api` (no guarantee) | valid | `multi-file`, `manifest-directory`, `gateway-resource` |
| `06-manifest-set/routes-billing.yaml` | multi-file (root) | `gateway-api` ≥ 0.9 | valid | `multi-file`, `manifest-directory` |
| `06-manifest-set/routes-ledger.yaml` | multi-file (member) | `gateway-api` ≥ 0.9 | valid | `multi-file`, `manifest-directory` |
| `negative/01-syntactic-bad-yaml.yaml` | — | `gateway-api` (no guarantee) | invalid | `negative`, `syntactic` |
| `negative/02-semantic-no-httproute.yaml` ⚠ | — | `gateway-api` (no guarantee) | invalid | `negative`, `semantic` |
| `negative/03-truncated-mid-rule.yaml` | — | `gateway-api` (no guarantee) | invalid | `negative`, `truncated` |
| `negative/04-wrong-format-deployment.yaml` | — | `gateway-api` (no guarantee) | invalid | `negative`, `wrong-format` |
| `negative/05-encoding-utf16.yaml` ⚠ | — | `gateway-api` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`03-multi-route-stream.yaml`** — Multi-document stream; the Gateway resource is recorded as an ignored construct, only HTTPRoutes import.

> ⚠ **`06-manifest-set/gateway.yaml`** — Gateway infrastructure resource; not independently importable, merged as an ignored construct through the set.

> ⚠ **`negative/02-semantic-no-httproute.yaml`** — Gateway API resources are present (Gateway, TCPRoute) but no HTTPRoute — nothing importable.

> ⚠ **`negative/05-encoding-utf16.yaml`** — A minimal HTTPRoute re-encoded as UTF-16 (BOM + NUL bytes).

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
| `13-federation-set/inventory.graphql` | multi-file (member) | `graphql` ≥ 0.85 | valid | `federation`, `federation-set`, `key`, `shareable`, `link` |
| `13-federation-set/products.graphql` | multi-file (root) | `graphql` ≥ 0.85 | valid | `federation`, `federation-set`, `key`, `shareable`, `link`, `query`, `defaults` |
| `13-federation-set/reviews.graphql` | multi-file (member) | `graphql` ≥ 0.85 | valid | `federation`, `federation-set`, `key`, `external`, `requires`, `link` |
| `14-federation-supergraph.graphql` ⚠ | composition | `graphql` ≥ 0.85 | valid | `federation`, `supergraph`, `join-spec`, `enum`, `query`, `defaults` |
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

> ⚠ **`14-federation-supergraph.graphql`** — expected_detection records intent: the greedy flatbuffers sniffer (is_flatbuffers matches the join__Graph enum block) claims this file at 0.96, with smithy/thrift at 0.95, outranking graphql's 0.9 — the same sniffer-ranking bug family recorded for graphql/03-04/07-08 (IXH-1.2).

### `haproxy/` — HAProxy configuration (pending #5459)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal.cfg` | minimal | `haproxy` ≥ 0.8 | valid | `frontend`, `backend`, `default-backend`, `pending-adapter` |
| `02-typical-path-acls.cfg` | typical | `haproxy` ≥ 0.8 | valid | `path-acl`, `use-backend`, `http-request-return`, `httpchk`, `replace-path`, `tls-bind`, `pending-adapter` |
| `03-composition-multi-frontend.cfg` | composition | `haproxy` ≥ 0.8 | valid | `multi-frontend`, `listen-section`, `shared-backends`, `map-file-backend`, `mtls-bind`, `cookie-affinity`, `pending-adapter` |
| `04-stress-acl-vocabulary.cfg` ⚠ | stress | `haproxy` ≥ 0.8 | valid | `path`, `path-beg`, `path-end`, `path-sub`, `path-dir`, `path-reg`, `method-acl`, `header-acl`, `urlp`, `src-acl`, `ssl-acl`, `stick-table`, `lua-acl`, `capture`, `pending-adapter` |
| `05-real-world-edge.cfg` | real-world | `haproxy` ≥ 0.8 | valid | `rate-limiting`, `maintenance-switch`, `websocket-tunnel`, `mtls-backend`, `hsts`, `error-files`, `pending-adapter` |
| `06-typical-tcp-mode.cfg` | typical | `haproxy` ≥ 0.8 | valid | `tcp-mode`, `sni-routing`, `pgsql-check`, `listen-section`, `pending-adapter` |
| `07-composition-defaults-inheritance.cfg` | composition | `haproxy` ≥ 0.8 | valid | `defaults-inheritance`, `named-defaults`, `shared-backend`, `mode-switch`, `pending-adapter` |
| `08-map-file-set/haproxy.cfg` | multi-file (root) | `haproxy` ≥ 0.8 | valid | `map-file-backend`, `host-allowlist`, `runtime-backend-selection`, `pending-adapter` |
| `08-map-file-set/hosts.map` ⚠ | multi-file (member) | `haproxy` (no guarantee) | valid | `map-file`, `allowlist`, `pending-adapter` |
| `08-map-file-set/tenants.map` ⚠ | multi-file (member) | `haproxy` (no guarantee) | valid | `map-file`, `key-to-backend`, `pending-adapter` |
| `negative/01-syntactic-unknown-section.cfg` | — | `haproxy` (no guarantee) | invalid | `negative`, `syntactic`, `unknown-section-keyword`, `pending-adapter` |
| `negative/02-semantic-no-frontend.cfg` | — | `haproxy` (no guarantee) | invalid | `negative`, `semantic`, `no-frontend`, `pending-adapter` |
| `negative/03-truncated-mid-backend.cfg` | — | `haproxy` (no guarantee) | invalid | `negative`, `truncated`, `mid-directive`, `pending-adapter` |
| `negative/04-wrong-format-traefik.yml` | — | `haproxy` (no guarantee) | invalid | `negative`, `wrong-format`, `traefik`, `pending-adapter` |
| `negative/05-encoding-utf16.cfg` | — | `haproxy` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-backend-reference.cfg` | — | `haproxy` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-backend`, `pending-adapter` |

> ⚠ **`04-stress-acl-vocabulary.cfg`** — Includes a Lua-backed ACL and stick-table rate conditions: FMT-7.5 requires each declared as outside the documented subset rather than guessed at.

> ⚠ **`08-map-file-set/hosts.map`** — Fileset member: a one-column map used as a Host allowlist.

> ⚠ **`08-map-file-set/tenants.map`** — Fileset member: tenant header value to backend name, read by map_str at request time.

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

### `hl7v3/` — HL7 v3 / CDA (pending #5448)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-clinical-document.xml` | minimal | `hl7v3` ≥ 0.9 | valid | `header`, `recordTarget`, `structuredBody`, `narrative-section`, `pending-adapter` |
| `02-typical-ccd.xml` | typical | `hl7v3` ≥ 0.9 | valid | `CCD`, `templateId`, `sections`, `entries`, `substanceAdministration`, `narrative-table`, `pending-adapter` |
| `03-composition-nested-entries.xml` | composition | `hl7v3` ≥ 0.9 | valid | `organizer`, `entryRelationship`, `nested-observations`, `translation`, `referenceRange`, `pending-adapter` |
| `04-stress-rim-datatypes.xml` | stress | `hl7v3` ≥ 0.9 | valid | `II`, `CD`, `IVL-TS`, `AD`, `PN`, `TEL`, `PQ`, `RTO-PQ-PQ`, `ED`, `nullFlavor`, `sdtc-extension`, `relatedDocument`, `pending-adapter` |
| `05-real-world-discharge-summary.xml` | real-world | `hl7v3` ≥ 0.9 | valid | `discharge-summary`, `encompassingEncounter`, `informationRecipient`, `coded-diagnosis`, `procedure`, `pending-adapter` |
| `06-typical-unknown-template.xml` ⚠ | typical | `hl7v3` ≥ 0.9 | valid | `unknown-templateId`, `asserted-conformance`, `local-section`, `pending-adapter` |
| `07-transmission-set/discharge-summary.xml` ⚠ | multi-file (member) | `hl7v3` (no guarantee) | valid | `cda`, `payload`, `sections`, `pending-adapter` |
| `07-transmission-set/transmission-wrapper.xml` | multi-file (root) | `hl7v3` ≥ 0.9 | valid | `transmission-wrapper`, `MCCI`, `sender-receiver`, `payload-reference`, `pending-adapter` |
| `negative/01-syntactic-unclosed-section.xml` | — | `hl7v3` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-no-record-target.xml` | — | `hl7v3` (no guarantee) | invalid | `negative`, `semantic`, `missing-participations`, `pending-adapter` |
| `negative/03-truncated-mid-entry.xml` | — | `hl7v3` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute`, `pending-adapter` |
| `negative/04-wrong-format-fhir.json` ⚠ | — | `hl7v3` (no guarantee) | invalid | `negative`, `wrong-format`, `fhir`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `hl7v3` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-narrative-reference.xml` | — | `hl7v3` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `dangling-narrative-anchor`, `pending-adapter` |

> ⚠ **`06-typical-unknown-template.xml`** — The FMT-6.4 acceptance case: template ids are asserted claims, so an unrecognised OID must import with a 'not validated' statement rather than failing.

> ⚠ **`07-transmission-set/discharge-summary.xml`** — Fileset member: the CDA payload the wrapper carries; the document id is the edge between the two files.

> ⚠ **`negative/04-wrong-format-fhir.json`** — A FHIR Composition describing the same discharge summary — the neighbour the shipped fhir adapter owns.

### `hoppscotch/` — Hoppscotch collections (pending #5473)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-collection.json` | minimal | `hoppscotch` ≥ 0.85 | valid | `single-request`, `no-auth`, `pending-adapter` |
| `02-typical-orders-collection.json` | typical | `hoppscotch` ≥ 0.85 | valid | `inherited-auth`, `inactive-params`, `request-variables`, `test-script`, `collection-headers`, `pending-adapter` |
| `03-environment-set/collection.json` | multi-file (root) | `hoppscotch` ≥ 0.85 | valid | `multi-file`, `environment-variables`, `pending-adapter` |
| `03-environment-set/environment.json` | multi-file (member) | `hoppscotch` (no guarantee) | valid | `multi-file`, `environment-file`, `secret-flag`, `pending-adapter` |
| `04-stress-auth-and-bodies.json` | stress | `hoppscotch` ≥ 0.85 | valid | `raw-body`, `urlencoded-body`, `multipart-body`, `graphql-body`, `basic-auth`, `api-key-auth`, `oauth2-auth`, `nested-folders`, `disabled-headers`, `scripts`, `pending-adapter` |
| `05-real-world-payments-collection.json` | real-world | `hoppscotch` ≥ 0.85 | valid | `token-capture`, `idempotency-key`, `feature-folders`, `inherited-auth`, `pending-adapter` |
| `06-typical-nested-folders.json` | typical | `hoppscotch` ≥ 0.85 | valid | `nested-folders`, `operation-groups`, `request-variables`, `pending-adapter` |
| `07-composition-inherited-auth.json` | composition | `hoppscotch` ≥ 0.85 | valid | `auth-inheritance`, `nested-folders`, `folder-headers`, `request-override`, `pending-adapter` |
| `negative/01-syntactic-missing-brace.json` | — | `hoppscotch` (no guarantee) | invalid | `negative`, `syntactic`, `missing-brace`, `pending-adapter` |
| `negative/02-semantic-no-requests.json` | — | `hoppscotch` (no guarantee) | invalid | `negative`, `semantic`, `no-requests`, `pending-adapter` |
| `negative/03-truncated-mid-request.json` | — | `hoppscotch` (no guarantee) | invalid | `negative`, `truncated`, `mid-endpoint`, `pending-adapter` |
| `negative/04-wrong-format-postman.json` | — | `hoppscotch` (no guarantee) | invalid | `negative`, `wrong-format`, `postman`, `pending-adapter` |
| `negative/05-encoding-utf16.json` | — | `hoppscotch` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-request-without-endpoint.json` | — | `hoppscotch` (no guarantee) | invalid | `negative`, `semantic`, `empty-endpoint`, `unresolvable-variable`, `pending-adapter` |

### `http-file/` — HTTP Request File

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-ping.http` | minimal | `http-file` ≥ 0.9 | valid | `minimal`, `get` |
| `02-typical-vars-auth.http` | typical | `http-file` ≥ 0.9 | valid | `variables`, `bearer`, `json-body`, `request-name` |
| `03-path-templating.http` | composition | `http-file` ≥ 0.9 | valid | `path-templating`, `inferred`, `repeated-urls` |
| `04-stress-methods-curl.http` | stress | `http-file` ≥ 0.9 | valid | `stress`, `methods`, `curl`, `query` |
| `05-vscode-style-orders.http` | real-world | `http-file` ≥ 0.9 | valid | `real-world`, `vscode`, `uuid-path`, `api-key` |
| `06-users-set/admin.http` ⚠ | multi-file (member) | `http-file` (no guarantee) | valid | `multi-file`, `member` |
| `06-users-set/api.http` | multi-file (root) | `http-file` ≥ 0.9 | valid | `multi-file`, `env`, `provenance` |
| `06-users-set/http-client.env.json` ⚠ | multi-file (member) | `http-file` (no guarantee) | valid | `multi-file`, `env` |
| `07-emitted-vscode-collection.http` ⚠ | real-world | `http-file` ≥ 0.9 | valid | `emitted`, `vscode`, `collection`, `path-template`, `header-param` |
| `08-emitted-jetbrains-collection.http` ⚠ | real-world | `http-file` ≥ 0.9 | valid | `emitted`, `jetbrains`, `collection`, `path-template`, `header-param` |
| `negative/01-syntactic-no-request.http` | — | `http-file` (no guarantee) | invalid | `negative`, `syntactic` |
| `negative/02-semantic-curl-missing-url.http` | — | `http-file` (no guarantee) | invalid | `negative`, `semantic`, `curl` |
| `negative/03-truncated-mid-body.http` | — | `http-file` (no guarantee) | invalid | `negative`, `truncated` |
| `negative/04-wrong-format-openapi.json` | — | `http-file` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi` |
| `negative/05-encoding-utf16.http` | — | `http-file` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`06-users-set/admin.http`** — Fileset member imported through the set root api.http together with http-client.env.json.

> ⚠ **`06-users-set/http-client.env.json`** — JetBrains-style environment file; not independently importable as requests.

> ⚠ **`07-emitted-vscode-collection.http`** — Round-trip fixture for the request-file emitter: the VS Code dialect names each request on a `# @name` line and comments with `#`.

> ⚠ **`08-emitted-jetbrains-collection.http`** — The same API as 07 in the other dialect: the request name is the `###` separator itself and comments use `//`.

### `idoc/` — SAP IDoc (pending #5446)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-xml-orders05.xml` | minimal | `idoc` ≥ 0.9 | valid | `xml-form`, `control-record`, `ORDERS05`, `pending-adapter` |
| `02-typical-xml-orders05.xml` | typical | `idoc` ≥ 0.9 | valid | `xml-form`, `ORDERS05`, `partners`, `items`, `summary`, `pending-adapter` |
| `03-composition-xml-nested-segments.xml` | composition | `idoc` ≥ 0.9 | valid | `xml-form`, `nested-segments`, `extension-type`, `repeated-qualifiers`, `text-segments`, `pending-adapter` |
| `04-stress-flat-multi-idoc.txt` | stress | `idoc` ≥ 0.9 | valid | `flat-form`, `multi-idoc`, `PSGNUM`, `HLEVEL`, `test-flag`, `edi-standard-fields`, `empty-fields`, `pending-adapter` |
| `05-real-world-xml-invoic02.xml` | real-world | `idoc` ≥ 0.9 | valid | `xml-form`, `INVOIC02`, `vat-per-line`, `payment-terms`, `incoterms`, `summary-rows`, `pending-adapter` |
| `06-typical-flat-orders05.txt` ⚠ | typical | `idoc` ≥ 0.9 | valid | `flat-form`, `ORDERS05`, `fixed-width`, `same-document-as-02`, `pending-adapter` |
| `07-with-definition-set/custmas01.txt` | multi-file (root) | `idoc` ≥ 0.9 | valid | `multi-file`, `flat-form`, `custom-basic-type`, `segment-definition`, `pending-adapter` |
| `07-with-definition-set/segments.xml` ⚠ | multi-file (member) | `idoc` (no guarantee) | valid | `multi-file`, `segment-definition`, `field-offsets`, `pending-adapter` |
| `negative/01-syntactic-unclosed-segment.xml` | — | `idoc` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-missing-control-record.xml` | — | `idoc` (no guarantee) | invalid | `negative`, `semantic`, `no-control-record`, `pending-adapter` |
| `negative/03-truncated-mid-segment.xml` | — | `idoc` (no guarantee) | invalid | `negative`, `truncated`, `mid-element`, `pending-adapter` |
| `negative/04-wrong-format-edifact.edi` | — | `idoc` (no guarantee) | invalid | `negative`, `wrong-format`, `edifact`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `idoc` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-short-control-record.txt` ⚠ | — | `idoc` (no guarantee) | invalid | `negative`, `semantic`, `malformed-control-record`, `short-record`, `pending-adapter` |

> ⚠ **`06-typical-flat-orders05.txt`** — Byte-exact flat twin of 02-typical-xml-orders05.xml: both forms must produce the same canonical model.

> ⚠ **`07-with-definition-set/segments.xml`** — Fileset member: the WE60-style segment definition that supplies the SDATA field offsets; without it the flat record's payload is opaque.

> ⚠ **`negative/06-semantic-short-control-record.txt`** — The FMT-6.2 acceptance case: a flat control record shorter than 524 bytes, so the fixed-width cut cannot find IDOCTYP/MESTYP at their declared offsets.

### `ims/` — IMS DBD and PSB (pending #5482)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-dbd.dbd` | minimal | `ims` ≥ 0.85 | valid | `dbd`, `segm`, `field`, `sequence-field`, `pending-adapter` |
| `02-typical-hdam-dbd.dbd` | typical | `ims` ≥ 0.85 | valid | `hdam`, `parent-hierarchy`, `packed-field`, `randomizer`, `continuation`, `pending-adapter` |
| `03-dbd-psb-set/CUSTDB.dbd` | multi-file (root) | `ims` ≥ 0.85 | valid | `multi-file`, `dbd`, `hierarchy`, `pending-adapter` |
| `03-dbd-psb-set/CUSTINQ.psb` ⚠ | multi-file (member) | `ims` (no guarantee) | valid | `multi-file`, `psb`, `senseg`, `senfld`, `procopt`, `pending-adapter` |
| `04-stress-secondary-indexes.dbd` | stress | `ims` ≥ 0.85 | valid | `hidam`, `lchild`, `xdfld`, `subseq`, `ddata`, `nullval`, `non-unique-key`, `variable-length-segment`, `logical-child`, `pointer-options`, `pending-adapter` |
| `05-real-world-policy-dbd.dbd` | real-world | `ims` ≥ 0.85 | valid | `four-level-hierarchy`, `packed-money`, `secondary-index`, `variable-length-segment`, `free-space`, `pending-adapter` |
| `06-typical-psb.psb` | typical | `ims` ≥ 0.85 | valid | `psb`, `multiple-pcbs`, `procopt`, `senfld`, `tp-pcb`, `procseq`, `pending-adapter` |
| `07-composition-logical-database.dbd` | composition | `ims` ≥ 0.85 | valid | `logical-database`, `source-operand`, `concatenated-segment`, `cross-database-hierarchy`, `pending-adapter` |
| `negative/01-syntactic-unterminated-continuation.dbd` | — | `ims` (no guarantee) | invalid | `negative`, `syntactic`, `dangling-continuation`, `pending-adapter` |
| `negative/02-semantic-no-segments.dbd` | — | `ims` (no guarantee) | invalid | `negative`, `semantic`, `no-segments`, `pending-adapter` |
| `negative/03-truncated-mid-field.dbd` | — | `ims` (no guarantee) | invalid | `negative`, `truncated`, `mid-operand`, `pending-adapter` |
| `negative/04-wrong-format-cobol-copybook.cpy` | — | `ims` (no guarantee) | invalid | `negative`, `wrong-format`, `cobol-copybook`, `pending-adapter` |
| `negative/05-encoding-utf16.dbd` | — | `ims` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-parent-reference.dbd` ⚠ | — | `ims` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `dangling-parent`, `missing-index-dbd`, `pending-adapter` |

> ⚠ **`03-dbd-psb-set/CUSTINQ.psb`** — Fileset member: the program view. PROCOPT is the access contract FMT-11.2 carries in extras, and it only makes sense against the DBD in the same set.

> ⚠ **`negative/06-unresolvable-parent-reference.dbd`** — The FMT-11.2 acceptance case: a DBD with a dangling PARENT.

### `iso20022/` — ISO 20022

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-pain.001-credit-transfer.xml` | typical | `iso20022` ≥ 0.95 | valid | `pain.001`, `group-header` |
| `02-camt.053-statement.xml` | typical | `iso20022` ≥ 0.95 | valid | `camt.053`, `group-header` |
| `03-admi.004-system-event.xml` | minimal | `iso20022` ≥ 0.95 | valid | `admi.004`, `system-event` |
| `04-pain.008-direct-debit.xml` | composition | `iso20022` ≥ 0.95 | valid | `pain.008`, `group-header`, `component-reuse`, `sepa-mandate` |
| `05-camt.054-notification.xml` | stress | `iso20022` ≥ 0.95 | valid | `camt.054`, `prefixed-namespace`, `supplementary-data`, `currency-attributes` |
| `06-pacs.008-interbank-transfer.xml` | real-world | `iso20022` ≥ 0.95 | valid | `pacs.008`, `group-header`, `settlement-information`, `uetr` |
| `adversarial/01-billion-laughs-pain001.xml` ⚠ | — | `iso20022` (no guarantee) | adversarial | `adversarial`, `billion-laughs`, `entity-expansion`, `pain.001` |
| `negative/01-syntactic-unclosed-tag.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-tag` |
| `negative/02-semantic-empty-document.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `semantic`, `empty-document` |
| `negative/03-truncated-mid-tag.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `truncated`, `mid-tag` |
| `negative/04-wrong-format-xsd-schema.xsd` | — | `iso20022` (no guarantee) | invalid | `negative`, `wrong-format`, `xsd-schema` |
| `negative/05-encoding-utf16-event.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`adversarial/01-billion-laughs-pain001.xml`** — parse_iso20022 parses before its shape check (IXH-1.4) because is_iso20022 needs a successful secure parse; without that order the security code would be masked as a format mismatch.

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

### `istio/` — Istio traffic resources (pending #5458)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-virtualservice.yaml` | minimal | `istio` ≥ 0.9 | valid | `VirtualService`, `single-route`, `pending-adapter` |
| `02-typical-virtualservice.yaml` | typical | `istio` ≥ 0.9 | valid | `VirtualService`, `uri-exact`, `uri-prefix`, `method-match`, `directResponse`, `rewrite`, `retries`, `timeout`, `pending-adapter` |
| `03-composition-multidoc.yaml` | composition | `istio` ≥ 0.9 | valid | `multi-document`, `Gateway`, `DestinationRule`, `subsets`, `weighted-routes`, `header-match`, `pending-adapter` |
| `04-stress-match-and-traffic-policy.yaml` | stress | `istio` ≥ 0.9 | valid | `withoutHeaders`, `queryParams`, `scheme`, `authority`, `sourceLabels`, `corsPolicy`, `fault-injection`, `mirror`, `delegate`, `header-mutation`, `tls-routes`, `tcp-routes`, `pending-adapter` |
| `05-real-world-canary-rollout.yaml` | real-world | `istio` ≥ 0.9 | valid | `canary`, `weighted-routes`, `consistentHash`, `outlierDetection`, `gone-response`, `multi-document`, `pending-adapter` |
| `06-typical-serviceentry-and-sidecar.yaml` | typical | `istio` ≥ 0.9 | valid | `ServiceEntry`, `Sidecar`, `egress`, `REGISTRY-ONLY`, `multi-document`, `pending-adapter` |
| `07-gitops-set/destinationrule.yaml` ⚠ | multi-file (member) | `istio` (no guarantee) | valid | `destinationrule`, `subsets`, `outlierDetection`, `pending-adapter` |
| `07-gitops-set/gateway.yaml` ⚠ | multi-file (member) | `istio` (no guarantee) | valid | `gateway`, `tls-credential`, `pending-adapter` |
| `07-gitops-set/virtualservice.yaml` | multi-file (root) | `istio` ≥ 0.9 | valid | `gitops-layout`, `canary`, `subset-reference`, `pending-adapter` |
| `negative/01-syntactic-bad-yaml.yaml` | — | `istio` (no guarantee) | invalid | `negative`, `syntactic`, `bad-indentation`, `pending-adapter` |
| `negative/02-semantic-no-routes.yaml` | — | `istio` (no guarantee) | invalid | `negative`, `semantic`, `no-route-blocks`, `pending-adapter` |
| `negative/03-truncated-mid-route.yaml` | — | `istio` (no guarantee) | invalid | `negative`, `truncated`, `mid-value`, `pending-adapter` |
| `negative/04-wrong-format-envoy-route.yaml` | — | `istio` (no guarantee) | invalid | `negative`, `wrong-format`, `envoy-xds`, `pending-adapter` |
| `negative/05-encoding-utf16.yaml` | — | `istio` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-subset-reference.yaml` | — | `istio` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-subset`, `pending-adapter` |

> ⚠ **`07-gitops-set/destinationrule.yaml`** — Fileset member: defines the subsets the routes name.

> ⚠ **`07-gitops-set/gateway.yaml`** — Fileset member: the Gateway the VirtualService binds to.

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
| `12-nonconforming-examples.json` ⚠ | typical | `json-schema-2020-12` ≥ 0.9 | valid | `non-conforming-examples`, `schema-examples`, `enum`, `defs` |
| `negative/01-syntactic-unclosed-brace.json` | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-brace` |
| `negative/02-semantic-top-level-array.json` | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `semantic`, `top-level-array` |
| `negative/03-truncated-mid-token.json` ⚠ | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `truncated`, `cut-mid-token` |
| `negative/04-wrong-format-protobuf.proto` | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf-idl` |
| `negative/05-encoding-utf16.json` | — | `json-schema-2020-12` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

> ⚠ **`12-nonconforming-examples.json`** — Every `examples` entry deliberately violates the subschema it sits in (root required, minimum, minLength, enum, maxItems, and a $defs pattern); the document is a valid JSON Schema and must import cleanly. Drives tests/test_example_conformance_corpus.py.

> ⚠ **`negative/03-truncated-mid-token.json`** — Grounded FORMAT_MISMATCH rather than INPUT_MALFORMED: the greedy graphql sniffer claims the truncated JSON at 0.9 (`type` keyword match), while json-schema's own detect cannot claim broken JSON.

### `jsonld/` — JSON-LD contexts (pending #5471)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-context.jsonld` | minimal | `jsonld` ≥ 0.85 | valid | `context`, `vocab`, `keyword-alias`, `pending-adapter` |
| `02-typical-context.jsonld` | typical | `jsonld` ≥ 0.85 | valid | `typed-term`, `set-container`, `list-container`, `language-container`, `scoped-context`, `pending-adapter` |
| `03-contexts-set/context.jsonld` | multi-file (root) | `jsonld` ≥ 0.85 | valid | `multi-file`, `context-array`, `relative-context`, `pending-adapter` |
| `03-contexts-set/shared-context.jsonld` | multi-file (member) | `jsonld` (no guarantee) | valid | `multi-file`, `shared-terms`, `scoped-context`, `pending-adapter` |
| `04-stress-keyword-coverage.jsonld` | stress | `jsonld` ≥ 0.85 | valid | `index-container`, `id-container`, `type-container`, `graph-container`, `compound-container`, `reverse`, `protected`, `prefix`, `nest`, `direction`, `base`, `json-type`, `pending-adapter` |
| `05-real-world-catalog-context.jsonld` | real-world | `jsonld` ≥ 0.85 | valid | `dcat`, `dublin-core`, `skos`, `vcard`, `language-map`, `typed-dates`, `scoped-context`, `pending-adapter` |
| `06-typical-document-with-context.jsonld` | typical | `jsonld` ≥ 0.85 | valid | `context-plus-graph`, `instance-data`, `typed-values`, `pending-adapter` |
| `07-composition-context-array.jsonld` | composition | `jsonld` ≥ 0.85 | valid | `context-array`, `scoped-context`, `nested-scoped-context`, `type-scoped-values`, `pending-adapter` |
| `negative/01-syntactic-trailing-comma.jsonld` | — | `jsonld` (no guarantee) | invalid | `negative`, `syntactic`, `trailing-comma`, `pending-adapter` |
| `negative/02-semantic-no-context.jsonld` | — | `jsonld` (no guarantee) | invalid | `negative`, `semantic`, `no-context`, `pending-adapter` |
| `negative/03-truncated-mid-term.jsonld` | — | `jsonld` (no guarantee) | invalid | `negative`, `truncated`, `mid-term-definition`, `pending-adapter` |
| `negative/04-wrong-format-json-schema.json` | — | `jsonld` (no guarantee) | invalid | `negative`, `wrong-format`, `json-schema`, `pending-adapter` |
| `negative/05-encoding-utf16.jsonld` | — | `jsonld` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-remote-context.jsonld` ⚠ | — | `jsonld` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `remote-context`, `missing-relative-context`, `pending-adapter` |

> ⚠ **`negative/06-unresolvable-remote-context.jsonld`** — Remote contexts must resolve under the SSRF guard; an unreachable one is a named unresolved reference, not an empty term map.

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

### `k8s-crd/` — Kubernetes CRD

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-widget.yaml` | minimal | `k8s-crd` ≥ 0.95 | valid | `crd`, `single-version`, `structural-schema` |
| `02-typical-cronwidget.yaml` | typical | `k8s-crd` ≥ 0.95 | valid | `crd`, `required`, `spec-status` |
| `03-multi-version.yaml` | composition | `k8s-crd` ≥ 0.95 | valid | `crd`, `multi-version`, `deprecated`, `not-served` |
| `04-x-kubernetes-extensions.yaml` | stress | `k8s-crd` ≥ 0.95 | valid | `crd`, `x-kubernetes`, `int-or-string`, `list-type`, `map-type`, `preserve-unknown-fields` |
| `05-cert-manager-like.yaml` | real-world | `k8s-crd` ≥ 0.95 | valid | `crd`, `real-world`, `nested-objects`, `enums` |
| `06-multi-crd-stream.yaml` ⚠ | typical | `k8s-crd` ≥ 0.95 | valid | `crd`, `multi-document`, `multiple-services` |
| `07-status-subresource.yaml` | composition | `k8s-crd` ≥ 0.95 | valid | `crd`, `status-subresource`, `scale-subresource`, `printer-columns`, `spec-status` |
| `negative/01-syntactic-unclosed-mapping.yaml` | — | `k8s-crd` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-mapping` |
| `negative/02-semantic-missing-group.yaml` | — | `k8s-crd` (no guarantee) | invalid | `negative`, `semantic`, `missing-group` |
| `negative/03-truncated-mid-doc.yaml` | — | `k8s-crd` (no guarantee) | invalid | `negative`, `truncated`, `mid-doc-cut` |
| `negative/04-wrong-format-openapi.yaml` | — | `k8s-crd` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi` |
| `negative/05-encoding-utf16.yaml` | — | `k8s-crd` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`06-multi-crd-stream.yaml`** — Multi-document YAML stream with two CRDs; imports as one CanonicalApi with two Services. The multi-file ladder rung is waived because CRDs do not resolve cross-file references.

### `kafka-connect/` — Kafka Connect schema

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-struct.json` | minimal | `kafka-connect` ≥ 0.85 | valid | `struct`, `primitives` |
| `02-typical-order-schema.json` | typical | `kafka-connect` ≥ 0.85 | valid | `struct`, `version`, `doc`, `optional`, `defaults` |
| `03-composition-nested-and-map.json` | composition | `kafka-connect` ≥ 0.85 | valid | `nested-struct`, `array`, `map`, `Decimal` |
| `04-stress-logical-types-and-parameters.json` | stress | `kafka-connect` ≥ 0.85 | valid | `Decimal`, `Date`, `Time`, `Timestamp`, `connector-logical-types`, `parameters`, `array-of-array`, `map-of-struct`, `null-default` |
| `05-real-world-change-event-schema.json` | real-world | `kafka-connect` ≥ 0.85 | valid | `cdc-envelope`, `before-after`, `source-block`, `Decimal`, `enum-parameters` |
| `06-typical-schema-payload-envelope.json` | typical | `kafka-connect` ≥ 0.85 | valid | `schema-payload-envelope`, `array`, `Timestamp` |
| `07-pipeline-set/connector.json` | multi-file (root) | `kafka-connect` ≥ 0.85 | valid | `connector-config`, `converters`, `transforms` |
| `07-pipeline-set/key-schema.json` ⚠ | multi-file (member) | `kafka-connect` (no guarantee) | valid | `key-schema`, `struct` |
| `07-pipeline-set/value-schema.json` ⚠ | multi-file (member) | `kafka-connect` (no guarantee) | valid | `value-schema`, `Decimal`, `Timestamp`, `array-of-struct`, `map` |
| `negative/01-syntactic-missing-brace.json` | — | `kafka-connect` (no guarantee) | invalid | `negative`, `syntactic`, `missing-brace` |
| `negative/02-semantic-struct-without-fields.json` | — | `kafka-connect` (no guarantee) | invalid | `negative`, `semantic`, `no-fields` |
| `negative/03-truncated-mid-field.json` | — | `kafka-connect` (no guarantee) | invalid | `negative`, `truncated`, `mid-type` |
| `negative/04-wrong-format-avro.avsc` ⚠ | — | `kafka-connect` (no guarantee) | invalid | `negative`, `wrong-format`, `avro` |
| `negative/05-encoding-utf16.json` | — | `kafka-connect` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-semantic-field-without-type.json` | — | `kafka-connect` (no guarantee) | invalid | `negative`, `semantic`, `missing-type`, `unknown-type` |

> ⚠ **`07-pipeline-set/key-schema.json`** — Fileset member: the key schema the pipeline carries.

> ⚠ **`07-pipeline-set/value-schema.json`** — Fileset member: the value schema that lands in the sink.

> ⚠ **`negative/04-wrong-format-avro.avsc`** — Avro uses `name`/`fields[].name`; Connect uses `field`. The two are the pair most easily confused, and the transcode FMT-5.3 promises depends on telling them apart.

### `kong/` — Kong Declarative Config

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-single-service.yaml` | minimal | `kong` ≥ 0.9 | valid | `minimal`, `single-service` |
| `02-typical-single-service-auth.yaml` | typical | `kong` ≥ 0.9 | valid | `typical`, `single-service`, `key-auth`, `regex-paths` |
| `03-multi-service.yaml` | composition | `kong` ≥ 0.9 | valid | `composition`, `multi-service`, `top-level-routes`, `upstreams` |
| `04-stress-plugin-heavy.yaml` ⚠ | stress | `kong` ≥ 0.9 | valid | `stress`, `plugin-heavy`, `jwt`, `oauth2`, `hmac-auth`, `consumers`, `credential-redaction` |
| `05-real-world-ecommerce.json` | real-world | `kong` ≥ 0.9 | valid | `real-world`, `json`, `multi-service`, `key-auth` |
| `06-split-set/kong-routes.yaml` ⚠ | multi-file (member) | `kong` ≥ 0.9 | valid | `multi-file`, `split-config`, `top-level-routes` |
| `06-split-set/kong-services.yaml` | multi-file (root) | `kong` ≥ 0.9 | valid | `multi-file`, `split-config` |
| `negative/01-syntactic-bad-yaml.yaml` | — | `kong` (no guarantee) | invalid | `negative`, `syntactic` |
| `negative/02-semantic-no-routes.yaml` ⚠ | — | `kong` (no guarantee) | invalid | `negative`, `semantic` |
| `negative/03-truncated-mid-route.yaml` | — | `kong` (no guarantee) | invalid | `negative`, `truncated` |
| `negative/04-wrong-format-openapi.yaml` | — | `kong` (no guarantee) | invalid | `negative`, `wrong-format` |
| `negative/05-encoding-utf16.yaml` ⚠ | — | `kong` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`04-stress-plugin-heavy.yaml`** — Consumer credential values are fixtures only and are redacted at parse time; the import records the redaction count.

> ⚠ **`06-split-set/kong-routes.yaml`** — deck-style split file: top-level routes referencing a service declared in kong-services.yaml.

> ⚠ **`negative/02-semantic-no-routes.yaml`** — Well-formed Kong config that declares a service but no routes — no API surface to import.

> ⚠ **`negative/05-encoding-utf16.yaml`** — The hand-authored kong/01-minimal-single-service.yaml shape re-encoded as UTF-16 (BOM + NUL bytes).

### `llm-tools/` — LLM Tools

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-openai.json` | minimal | `llm-tools` ≥ 0.95 | valid | `openai`, `single-tool`, `function-calling` |
| `02-typical-anthropic.json` | typical | `llm-tools` ≥ 0.95 | valid | `anthropic`, `multi-tool`, `enums` |
| `03-mixed-dialects.json` | composition | `llm-tools` ≥ 0.95 | valid | `mixed-dialect`, `openai`, `anthropic`, `bare` |
| `04-enums-and-required.json` | stress | `llm-tools` ≥ 0.95 | valid | `enums`, `required`, `oneOf-const`, `lint-triggers` |
| `05-assistant-tool-bundle.json` | real-world | `llm-tools` ≥ 0.95 | valid | `real-world`, `openai`, `anthropic`, `multi-tool` |
| `06-tools-wrapper-object.json` ⚠ | composition | `llm-tools` ≥ 0.95 | valid | `tools-wrapper`, `mixed-dialect` |
| `07-emitted-openai-tools.json` ⚠ | real-world | `llm-tools` ≥ 0.95 | valid | `emitted`, `openai`, `multi-tool`, `merged-parameters`, `function-calling` |
| `08-emitted-anthropic-strict.json` ⚠ | stress | `llm-tools` ≥ 0.95 | valid | `emitted`, `anthropic`, `strict-schema`, `multi-tool`, `nullable-optional` |
| `negative/01-syntactic-unclosed-array.json` | — | `llm-tools` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-array` |
| `negative/02-semantic-missing-name.json` | — | `llm-tools` (no guarantee) | invalid | `negative`, `semantic`, `missing-name` |
| `negative/03-truncated-mid-doc.json` | — | `llm-tools` (no guarantee) | invalid | `negative`, `truncated`, `mid-doc-cut` |
| `negative/04-wrong-format-openapi.json` | — | `llm-tools` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi` |
| `negative/05-encoding-utf16.json` | — | `llm-tools` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`06-tools-wrapper-object.json`** — Object wrapper with a tools array; multi-file ladder rung is waived because tool bundles do not resolve cross-file references.

> ⚠ **`07-emitted-openai-tools.json`** — Round-trip fixture for the tool-array emitter: each REST operation becomes one tool whose parameters merge the path, query, header and body arguments.

> ⚠ **`08-emitted-anthropic-strict.json`** — The same API as 07 in the strict structured-output subset: every object is closed and every property is required, with the optional ones widened to accept null.

### `lwm2m/` — LwM2M / IPSO objects (pending #5472)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-object.xml` | minimal | `lwm2m` ≥ 0.9 | valid | `object-definition`, `resource`, `read-only`, `pending-adapter` |
| `02-typical-ipso-temperature.xml` | typical | `lwm2m` ≥ 0.9 | valid | `ipso`, `units`, `executable-resource`, `optional-resources`, `multiple-instances`, `pending-adapter` |
| `03-composition-multi-object-file.xml` | composition | `lwm2m` ≥ 0.9 | valid | `multi-object`, `objlnk`, `cross-object-reference`, `pending-adapter` |
| `04-stress-resource-forms.xml` | stress | `lwm2m` ≥ 0.9 | valid | `all-resource-types`, `write-only`, `executable-resource`, `multiple-instances`, `range`, `enumeration`, `objlnk`, `corelnk`, `units`, `pending-adapter` |
| `05-real-world-device-object.xml` | real-world | `lwm2m` ≥ 0.9 | valid | `device-object`, `multi-instance-resources`, `error-codes`, `reboot`, `factory-reset`, `timezone`, `pending-adapter` |
| `06-typical-firmware-update-object.xml` | typical | `lwm2m` ≥ 0.9 | valid | `firmware-update`, `write-only`, `executable-resource`, `state-enum`, `result-enum`, `pending-adapter` |
| `07-object-registry-set/32710.xml` | multi-file (root) | `lwm2m` ≥ 0.9 | valid | `objlnk-composition`, `registry-convention`, `pending-adapter` |
| `07-object-registry-set/32711.xml` ⚠ | multi-file (member) | `lwm2m` (no guarantee) | valid | `temperature-object`, `executable-resource`, `pending-adapter` |
| `07-object-registry-set/32712.xml` ⚠ | multi-file (member) | `lwm2m` (no guarantee) | valid | `actuator-object`, `executable-resource`, `pending-adapter` |
| `negative/01-syntactic-unclosed-item.xml` | — | `lwm2m` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-no-resources.xml` | — | `lwm2m` (no guarantee) | invalid | `negative`, `semantic`, `empty-resources`, `pending-adapter` |
| `negative/03-truncated-mid-resource.xml` | — | `lwm2m` (no guarantee) | invalid | `negative`, `truncated`, `mid-element`, `pending-adapter` |
| `negative/04-wrong-format-matter-cluster.xml` | — | `lwm2m` (no guarantee) | invalid | `negative`, `wrong-format`, `matter`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `lwm2m` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-unknown-resource-type.xml` | — | `lwm2m` (no guarantee) | invalid | `negative`, `semantic`, `unknown-type`, `invalid-operations`, `pending-adapter` |

> ⚠ **`07-object-registry-set/32711.xml`** — Fileset member: the sensor object the unit links to.

> ⚠ **`07-object-registry-set/32712.xml`** — Fileset member: the actuator object the unit links to.

### `matter/` — Matter clusters and device types (pending #5472)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-cluster.xml` | minimal | `matter` ≥ 0.9 | valid | `cluster`, `attribute`, `command`, `pending-adapter` |
| `02-typical-onoff-cluster.xml` | typical | `matter` ≥ 0.9 | valid | `enum`, `bitmap`, `optional-attribute`, `nullable-attribute`, `defaults`, `commands`, `pending-adapter` |
| `03-device-type-set/device-type.xml` | multi-file (root) | `matter` ≥ 0.9 | valid | `multi-file`, `deviceType`, `cluster-include`, `required-members`, `pending-adapter` |
| `03-device-type-set/levelcontrol-cluster.xml` | multi-file (member) | `matter` (no guarantee) | valid | `multi-file`, `cluster`, `bitmap`, `access`, `pending-adapter` |
| `03-device-type-set/onoff-cluster.xml` | multi-file (member) | `matter` (no guarantee) | valid | `multi-file`, `cluster`, `pending-adapter` |
| `04-stress-structs-enums-bitmaps.xml` | stress | `matter` ≥ 0.9 | valid | `struct`, `nested-struct-array`, `features`, `conformance`, `list-attribute`, `access-privilege`, `command-response`, `events`, `event-priority`, `nullable`, `pending-adapter` |
| `05-real-world-thermostat-cluster.xml` | real-world | `matter` ≥ 0.9 | valid | `thermostat`, `setpoint-limits`, `mode-enum`, `running-state-bitmap`, `schedule-commands`, `command-response`, `pending-adapter` |
| `06-typical-events-and-access.xml` | typical | `matter` ≥ 0.9 | valid | `basic-information`, `struct-attribute`, `write-privilege`, `lifecycle-events`, `pending-adapter` |
| `07-composition-derived-cluster.xml` | composition | `matter` ≥ 0.9 | valid | `struct-of-structs`, `shared-types`, `derived-cluster`, `command-response`, `events`, `pending-adapter` |
| `negative/01-syntactic-unclosed-cluster.xml` | — | `matter` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-cluster-without-members.xml` | — | `matter` (no guarantee) | invalid | `negative`, `semantic`, `no-members`, `pending-adapter` |
| `negative/03-truncated-mid-attribute.xml` | — | `matter` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute`, `pending-adapter` |
| `negative/04-wrong-format-lwm2m.xml` | — | `matter` (no guarantee) | invalid | `negative`, `wrong-format`, `lwm2m`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `matter` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-type-reference.xml` | — | `matter` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-enum`, `missing-struct`, `pending-adapter` |

### `mcp/` — MCP server manifest

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-echo-tool.json` | minimal | `mcp` ≥ 0.9 | valid | `tools`, `single-tool`, `inputSchema` |
| `02-typical-tickets-server.json` | typical | `mcp` ≥ 0.9 | valid | `tools`, `resources`, `resourceTemplates`, `prompts`, `annotations`, `streamable-http` |
| `03-composition-shared-schemas.json` | composition | `mcp` ≥ 0.9 | valid | `defs`, `ref-reuse`, `outputSchema`, `tools` |
| `04-stress-grammar-corners.json` | stress | `mcp` ≥ 0.9 | valid | `oneOf`, `anyOf`, `outputSchema`, `meta`, `experimental-capabilities`, `uri-template`, `stdio` |
| `05-real-world-filesystem-server.json` | real-world | `mcp` ≥ 0.9 | valid | `tools`, `annotations`, `resources`, `stdio` |
| `06-split-set/manifest.json` | multi-file (root) | `mcp` ≥ 0.9 | valid | `multi-file`, `cross-file-ref`, `tools` |
| `06-split-set/schemas.json` ⚠ | multi-file (member) | `mcp` (no guarantee) | valid | `multi-file`, `cross-file-ref`, `schemas` |
| `negative/01-syntactic-trailing-comma.json` | — | `mcp` (no guarantee) | invalid | `negative`, `syntactic`, `trailing-comma` |
| `negative/02-semantic-tool-without-input-schema.json` ⚠ | — | `mcp` (no guarantee) | invalid | `negative`, `semantic`, `missing-inputSchema` |
| `negative/03-truncated-mid-tool.json` | — | `mcp` (no guarantee) | invalid | `negative`, `truncated`, `mid-tool` |
| `negative/04-wrong-format-openapi.yaml` | — | `mcp` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi` |
| `negative/05-encoding-utf16.json` ⚠ | — | `mcp` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |

> ⚠ **`06-split-set/schemas.json`** — Fileset member with no mcpVersion marker — not independently detectable; imported only through 06-split-set/manifest.json.

> ⚠ **`negative/02-semantic-tool-without-input-schema.json`** — Well-formed JSON whose tools declare no inputSchema, so the manifest describes no callable surface.

> ⚠ **`negative/05-encoding-utf16.json`** — 01-minimal-echo-tool.json re-encoded as UTF-16 (BOM + NUL bytes).

### `nacha/` — NACHA ACH (pending #5450)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-ppd-credit.ach` | minimal | `nacha` ≥ 0.9 | valid | `PPD`, `single-entry`, `fixed-width`, `block-padding`, `pending-adapter` |
| `02-typical-ppd-batch.ach` | typical | `nacha` ≥ 0.9 | valid | `PPD`, `multiple-entries`, `transaction-codes`, `entry-hash`, `pending-adapter` |
| `03-composition-ccd-with-addenda.ach` | composition | `nacha` ≥ 0.9 | valid | `CCD`, `addenda`, `RMR`, `addenda-indicator`, `pending-adapter` |
| `04-stress-multi-batch-sec-codes.ach` | stress | `nacha` ≥ 0.9 | valid | `PPD`, `CCD`, `WEB`, `TEL`, `multi-batch`, `service-class`, `savings-transaction-codes`, `file-id-modifier`, `pending-adapter` |
| `05-real-world-payroll-and-tax.ach` | real-world | `nacha` ≥ 0.9 | valid | `payroll`, `TXP`, `two-batches`, `credit-and-debit`, `pending-adapter` |
| `06-stress-control-total-mismatch.ach` ⚠ | stress | `nacha` ≥ 0.9 | valid | `control-totals`, `declared-vs-observed`, `entry-hash-mismatch`, `pending-adapter` |
| `07-return-set/forward-file.ach` | multi-file (root) | `nacha` ≥ 0.9 | valid | `PPD`, `forward-file`, `pending-adapter` |
| `07-return-set/return-file.ach` ⚠ | multi-file (member) | `nacha` (no guarantee) | valid | `return-entry`, `R03`, `addenda-99`, `pending-adapter` |
| `negative/01-syntactic-short-record.ach` ⚠ | — | `nacha` (no guarantee) | invalid | `negative`, `syntactic`, `record-length`, `pending-adapter` |
| `negative/02-semantic-batch-without-entries.ach` | — | `nacha` (no guarantee) | invalid | `negative`, `semantic`, `empty-batch`, `pending-adapter` |
| `negative/03-truncated-mid-entry.ach` | — | `nacha` (no guarantee) | invalid | `negative`, `truncated`, `mid-record`, `pending-adapter` |
| `negative/04-wrong-format-sepa-pain001.xml` ⚠ | — | `nacha` (no guarantee) | invalid | `negative`, `wrong-format`, `sepa`, `pain.001`, `pending-adapter` |
| `negative/05-encoding-utf16.ach` | — | `nacha` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-orphan-addenda.ach` ⚠ | — | `nacha` (no guarantee) | invalid | `negative`, `semantic`, `orphan-addenda`, `pending-adapter` |

> ⚠ **`06-stress-control-total-mismatch.ach`** — Batch and file control records declare five entries, a zero hash and a 999999 credit total; none of it matches the two entries present. The acceptance criterion is that both numbers are shown.

> ⚠ **`07-return-set/return-file.ach`** — Fileset member: the return file. Transaction code 26 plus a 99 addenda carry the return reason, and the trace number is the edge back to the original entry.

> ⚠ **`negative/01-syntactic-short-record.ach`** — A 32-character batch header: in a fixed-width format a short record is a grammar error, not a semantic one.

> ⚠ **`negative/04-wrong-format-sepa-pain001.xml`** — The European half of FMT-6.6: it must route to the shipped iso20022 adapter with its message identifier recorded, never to the ACH parser.

> ⚠ **`negative/06-semantic-orphan-addenda.ach`** — A `7` addenda record before any `6` entry detail: the addenda has no entry to attach to.

### `natural-ddm/` — Natural / ADABAS DDM (pending #5486)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-ddm.ddm` | minimal | `natural-ddm` ≥ 0.9 | valid | `ddm-header`, `fields`, `descriptor`, `pending-adapter` |
| `02-typical-customer-ddm.ddm` | typical | `natural-ddm` ≥ 0.9 | valid | `alpha`, `numeric`, `packed`, `unique-descriptor`, `multiple-value`, `superdescriptor`, `pending-adapter` |
| `03-view-set/CUSTINQ.nsp` ⚠ | multi-file (member) | `natural-ddm` (no guarantee) | valid | `multi-file`, `define-data-view`, `occurrence-bounds`, `field-subset`, `pending-adapter` |
| `03-view-set/CUSTOMER.ddm` | multi-file (root) | `natural-ddm` ≥ 0.9 | valid | `multi-file`, `ddm`, `periodic-group`, `superdescriptor`, `pending-adapter` |
| `04-stress-formats-and-descriptors.ddm` | stress | `natural-ddm` ≥ 0.9 | valid | `all-formats`, `binary`, `float`, `logical`, `unicode`, `date`, `time`, `lob`, `mu-in-pe`, `two-periodic-groups`, `null-suppression`, `fixed-storage`, `hyperdescriptor`, `subdescriptor`, `pending-adapter` |
| `05-real-world-policy-ddm.ddm` | real-world | `natural-ddm` ≥ 0.9 | valid | `periodic-groups`, `packed-money`, `multiple-value`, `superdescriptors`, `status-codes`, `pending-adapter` |
| `06-typical-periodic-groups.ddm` | typical | `natural-ddm` ≥ 0.9 | valid | `periodic-group`, `mu-in-pe`, `superdescriptor`, `packed`, `pending-adapter` |
| `07-composition-redefines-and-groups.ddm` | composition | `natural-ddm` ≥ 0.9 | valid | `redefinition`, `group-field`, `group-in-periodic-group`, `superdescriptor-across-levels`, `pending-adapter` |
| `negative/01-syntactic-malformed-column-layout.ddm` | — | `natural-ddm` (no guarantee) | invalid | `negative`, `syntactic`, `malformed-columns`, `pending-adapter` |
| `negative/02-semantic-no-fields.ddm` | — | `natural-ddm` (no guarantee) | invalid | `negative`, `semantic`, `no-field-lines`, `pending-adapter` |
| `negative/03-truncated-mid-field-list.ddm` | — | `natural-ddm` (no guarantee) | invalid | `negative`, `truncated`, `mid-field-line`, `pending-adapter` |
| `negative/04-wrong-format-cobol-copybook.cpy` | — | `natural-ddm` (no guarantee) | invalid | `negative`, `wrong-format`, `cobol-copybook`, `pending-adapter` |
| `negative/05-encoding-utf16.ddm` | — | `natural-ddm` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-superdescriptor-source.ddm` | — | `natural-ddm` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-source-field`, `pending-adapter` |

> ⚠ **`03-view-set/CUSTINQ.nsp`** — Fileset member: the program's VIEW over the DDM, carrying occurrence bounds the DDM itself does not state.

### `ncpdp/` — NCPDP SCRIPT / Telecom (pending #5452)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-newrx.xml` | minimal | `ncpdp` ≥ 0.85 | valid | `script`, `NewRx`, `participants`, `pending-adapter` |
| `02-typical-newrx.xml` | typical | `ncpdp` ≥ 0.85 | valid | `script`, `NewRx`, `coded-drug`, `diagnosis`, `sig`, `sender-software`, `pending-adapter` |
| `03-composition-rxchangerequest.xml` | composition | `ncpdp` ≥ 0.85 | valid | `script`, `RxChangeRequest`, `prescribed-and-requested`, `prior-authorization`, `benefits-coordination`, `pending-adapter` |
| `04-stress-multiple-transactions.xml` | stress | `ncpdp` ≥ 0.85 | valid | `script`, `RxFill`, `RxRenewalRequest`, `CancelRx`, `Status`, `Error`, `multi-transaction`, `pending-adapter` |
| `05-real-world-telecom-b1-claim.dat` | real-world | `ncpdp` ≥ 0.85 | valid | `telecom`, `D0`, `B1`, `insurance-segment`, `claim-segment`, `pricing-segment`, `control-characters`, `pending-adapter` |
| `06-typical-telecom-b2-reversal.dat` | typical | `ncpdp` ≥ 0.85 | valid | `telecom`, `D0`, `B2`, `reversal`, `control-characters`, `pending-adapter` |
| `07-transaction-set/newrx.xml` | multi-file (root) | `ncpdp` ≥ 0.85 | valid | `NewRx`, `script`, `pending-adapter` |
| `07-transaction-set/status.xml` ⚠ | multi-file (member) | `ncpdp` (no guarantee) | valid | `Status`, `RelatesToMessageID`, `script`, `pending-adapter` |
| `negative/01-syntactic-unclosed-body.xml` | — | `ncpdp` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-empty-body.xml` | — | `ncpdp` (no guarantee) | invalid | `negative`, `semantic`, `no-transaction`, `pending-adapter` |
| `negative/03-truncated-mid-medication.xml` | — | `ncpdp` (no guarantee) | invalid | `negative`, `truncated`, `mid-element`, `pending-adapter` |
| `negative/04-wrong-format-hl7v2.hl7` ⚠ | — | `ncpdp` (no guarantee) | invalid | `negative`, `wrong-format`, `hl7v2`, `RDE`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `ncpdp` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-unknown-telecom-version.dat` | — | `ncpdp` (no guarantee) | invalid | `negative`, `semantic`, `unknown-version`, `telecom`, `pending-adapter` |

> ⚠ **`07-transaction-set/status.xml`** — Fileset member: the pharmacy's response, tied to the NewRx by RelatesToMessageID.

> ⚠ **`negative/04-wrong-format-hl7v2.hl7`** — An HL7 v2 pharmacy order for the same prescription — the neighbour the shipped hl7v2 adapter owns.

### `nginx/` — nginx configuration (pending #5459)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-server.conf` | minimal | `nginx` ≥ 0.8 | valid | `server-block`, `location`, `proxy-pass`, `pending-adapter` |
| `02-typical-reverse-proxy.conf` | typical | `nginx` ≥ 0.8 | valid | `upstream`, `exact-location`, `prefix-location`, `alias`, `redirect-server`, `tls`, `proxy-headers`, `pending-adapter` |
| `03-includes-set/api.example.com.conf` | multi-file (member) | `nginx` (no guarantee) | valid | `multi-file`, `server-block`, `location`, `pending-adapter` |
| `03-includes-set/nginx.conf` | multi-file (root) | `nginx` ≥ 0.8 | valid | `multi-file`, `include`, `http-block`, `pending-adapter` |
| `03-includes-set/upstreams.conf` | multi-file (member) | `nginx` (no guarantee) | valid | `multi-file`, `upstream`, `pending-adapter` |
| `04-stress-location-modifiers.conf` ⚠ | stress | `nginx` ≥ 0.8 | valid | `exact-modifier`, `preferential-prefix`, `regex-location`, `case-insensitive-regex`, `named-location`, `map`, `geo`, `limit-req`, `if-in-location`, `internal`, `try-files`, `nested-location`, `websocket`, `pending-adapter` |
| `05-real-world-edge.conf` | real-world | `nginx` ≥ 0.8 | valid | `canonical-redirect`, `proxy-cache`, `gzip`, `security-headers`, `allow-deny`, `gone-response`, `least-conn`, `pending-adapter` |
| `06-typical-grpc-and-stream.conf` | typical | `nginx` ≥ 0.8 | valid | `grpc-pass`, `stream-block`, `error-page`, `http2`, `pending-adapter` |
| `07-composition-shared-snippets.conf` | composition | `nginx` ≥ 0.8 | valid | `directive-inheritance`, `map`, `shared-upstreams`, `server-override`, `location-override`, `pending-adapter` |
| `negative/01-syntactic-missing-brace.conf` | — | `nginx` (no guarantee) | invalid | `negative`, `syntactic`, `missing-brace`, `pending-adapter` |
| `negative/02-semantic-no-server-block.conf` | — | `nginx` (no guarantee) | invalid | `negative`, `semantic`, `no-server-block`, `pending-adapter` |
| `negative/03-truncated-mid-location.conf` | — | `nginx` (no guarantee) | invalid | `negative`, `truncated`, `mid-directive`, `pending-adapter` |
| `negative/04-wrong-format-haproxy.cfg` | — | `nginx` (no guarantee) | invalid | `negative`, `wrong-format`, `haproxy`, `pending-adapter` |
| `negative/05-encoding-utf16.conf` | — | `nginx` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-upstream-reference.conf` | — | `nginx` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-upstream`, `pending-adapter` |

> ⚠ **`04-stress-location-modifiers.conf`** — Deliberately reaches past the documented subset (if, map, geo, nested locations): FMT-7.5 requires each of those declared as a parsing limit rather than guessed at.

### `odata/` — OData v4 (EDMX)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-northwind.edmx` | real-world | `odata` ≥ 0.95 | valid | `entity-type`, `navigation`, `entity-set`, `keys` |
| `02-orders.edmx` | typical | `odata` ≥ 0.95 | valid | `entity-type`, `complex-type`, `entity-set`, `keys` |
| `03-minimal-service.edmx` | minimal | `odata` ≥ 0.95 | valid | `entity-type`, `entity-set`, `keys` |
| `04-inheritance-two-schemas.edmx` | composition | `odata` ≥ 0.95 | valid | `inheritance`, `base-type`, `multiple-schemas`, `complex-type`, `navigation` |
| `05-stress-service-surface.edmx` | stress | `odata` ≥ 0.95 | valid | `enum-type`, `type-definition`, `singleton`, `function`, `action`, `annotations` |
| `06-trippin-reference.edmx` | real-world | `odata` ≥ 0.95 | valid | `entity-type`, `complex-type`, `enum-type`, `singleton`, `navigation` |
| `adversarial/01-external-dtd-entity.xml` | — | `odata` (no guarantee) | adversarial | `adversarial`, `xxe`, `external-entity`, `edmx` |
| `negative/01-syntactic-mismatched-tag.edmx` | — | `odata` (no guarantee) | invalid | `negative`, `syntactic`, `mismatched-tag` |
| `negative/02-semantic-no-schema.edmx` | — | `odata` (no guarantee) | invalid | `negative`, `semantic`, `empty-data-services` |
| `negative/03-truncated-mid-tag.edmx` | — | `odata` (no guarantee) | invalid | `negative`, `truncated`, `cut-mid-token` |
| `negative/04-wrong-format-wsdl.wsdl` | — | `odata` (no guarantee) | invalid | `negative`, `wrong-format`, `wsdl-definitions` |
| `negative/05-encoding-utf16.edmx` | — | `odata` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |

### `odata-v2/` — OData v2 / v3 (CSDL)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-v2-single-entity.xml` | minimal | `odata-v2` ≥ 0.9 | valid | `EntityType`, `EntitySet`, `v2` |
| `02-typical-v2-orders.xml` | typical | `odata-v2` ≥ 0.9 | valid | `Association`, `AssociationSet`, `ReferentialConstraint`, `compound-key`, `FunctionImport`, `v2` |
| `03-composition-v3-inheritance.xml` | composition | `odata-v3` ≥ 0.9 | valid | `BaseType`, `abstract-entity`, `ComplexType`, `EnumType`, `v3` |
| `04-stress-v2-customizable-feeds.xml` | stress | `odata-v2` ≥ 0.9 | valid | `FC-TargetPath`, `customizable-feeds`, `HasStream`, `Edm.Time`, `many-to-many`, `v2` |
| `05-real-world-sap-gateway-service.xml` | real-world | `odata-v2` ≥ 0.9 | valid | `sap-annotations`, `sap-semantics`, `ReferentialConstraint`, `FunctionImport`, `v2` |
| `06-typical-v3-catalog.xml` | typical | `odata-v3` ≥ 0.9 | valid | `v3`, `IsSideEffecting`, `Association` |
| `07-referenced-set/service.xml` | multi-file (root) | `odata-v3` ≥ 0.9 | valid | `multi-file`, `edmx-Reference`, `v3` |
| `07-referenced-set/shared-types.xml` ⚠ | multi-file (member) | `odata-v3` (no guarantee) | valid | `multi-file`, `ComplexType`, `v3` |
| `negative/01-syntactic-unclosed-entitytype.xml` | — | `odata-v2` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element` |
| `negative/02-semantic-no-entity-container.xml` | — | `odata-v2` (no guarantee) | invalid | `negative`, `semantic`, `no-entity-container` |
| `negative/03-truncated-mid-property.xml` ⚠ | — | `odata-v2` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute` |
| `negative/04-wrong-format-wsdl.wsdl` | — | `odata-v2` (no guarantee) | invalid | `negative`, `wrong-format`, `wsdl` |
| `negative/05-encoding-utf16.xml` | — | `odata-v2` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-unresolvable-association-ref.xml` | — | `odata-v2` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-association` |

> ⚠ **`07-referenced-set/shared-types.xml`** — Fileset member: the shared ComplexType namespace the root includes by edmx:Reference.

> ⚠ **`negative/03-truncated-mid-property.xml`** — Truncation reaches the secure XML parser as a not-well-formed document, so the grounded code is INPUT_MALFORMED rather than INPUT_TRUNCATED - the same reading every XML adapter's truncated fixture gets. The intent stays in failure_class.

### `odcs/` — Open Data Contract Standard v3.1

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-contract.yaml` | minimal | `odcs` ≥ 0.9 | valid | `schema`, `properties`, `primaryKey` |
| `02-typical-orders-contract.yaml` | typical | `odcs` ≥ 0.9 | valid | `quality`, `servers`, `team`, `support`, `slaProperties`, `partitioned`, `classification`, `tags` |
| `03-composition-nested-schema.yaml` | composition | `odcs` ≥ 0.9 | valid | `nested-object`, `array-of-objects`, `authoritativeDefinitions`, `multiple-schema-objects` |
| `04-stress-quality-sla-and-custom.yaml` | stress | `odcs` ≥ 0.9 | valid | `quality-sql`, `quality-text`, `quality-custom`, `logicalTypeOptions`, `transformLogic`, `encryptedName`, `roles`, `price`, `customProperties`, `slaProperties` |
| `05-real-world-transactions-contract.yaml` | real-world | `odcs` ≥ 0.9 | valid | `compound-key`, `partitioned`, `pii`, `roles`, `retention`, `quality-sql` |
| `06-typical-contract.json` | typical | `odcs` ≥ 0.9 | valid | `json-serialization`, `quality`, `servers`, `slaProperties` |
| `07-contract-set/contract.yaml` | multi-file (root) | `odcs` ≥ 0.9 | valid | `authoritativeDefinitions`, `delegated-schema`, `slaProperties` |
| `07-contract-set/quality.yaml` ⚠ | multi-file (member) | `odcs` (no guarantee) | valid | `quality-pack`, `sql-rule`, `freshness` |
| `07-contract-set/shipment-event.schema.json` ⚠ | multi-file (member) | `odcs` (no guarantee) | valid | `json-schema`, `payload-definition` |
| `negative/01-syntactic-bad-yaml-indent.yaml` | — | `odcs` (no guarantee) | invalid | `negative`, `syntactic`, `bad-indentation` |
| `negative/02-semantic-schema-without-properties.yaml` | — | `odcs` (no guarantee) | invalid | `negative`, `semantic`, `no-properties` |
| `negative/03-truncated-mid-property.yaml` | — | `odcs` (no guarantee) | invalid | `negative`, `truncated`, `mid-quoted-scalar` |
| `negative/04-wrong-format-dbt-schema.yml` | — | `odcs` (no guarantee) | invalid | `negative`, `wrong-format`, `dbt` |
| `negative/05-encoding-utf16.yaml` | — | `odcs` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-version-out-of-range-v2.yaml` ⚠ | — | `odcs` (no guarantee) | invalid | `negative`, `version-out-of-range`, `odcs-v2.2` |

> ⚠ **`07-contract-set/quality.yaml`** — Fileset member: the quality rule pack, maintained separately and keyed by contract id.

> ⚠ **`07-contract-set/shipment-event.schema.json`** — Fileset member: the structural definition the contract delegates to via authoritativeDefinitions.

> ⚠ **`negative/06-version-out-of-range-v2.yaml`** — The FMT-5.1 acceptance case: a v2.2.x contract (quantumName/dataset/columns) must be rejected with a version-out-of-range taxonomy code and remediation text, not a parse error.

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

### `opcua-nodeset/` — OPC UA NodeSet2 (pending #5468)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-nodeset.xml` | minimal | `opcua-nodeset` ≥ 0.9 | valid | `UAObjectType`, `UAVariable`, `aliases`, `references`, `pending-adapter` |
| `02-typical-machine-type.xml` | typical | `opcua-nodeset` ≥ 0.9 | valid | `UADataType`, `enum-definition`, `UAMethod`, `InputArguments`, `Models`, `RequiredModel`, `modelling-rule`, `pending-adapter` |
| `03-composition-subtypes.xml` | composition | `opcua-nodeset` ≥ 0.9 | valid | `abstract-type`, `subtypes`, `UAReferenceType`, `inverse-name`, `UAVariableType`, `optional-modelling-rule`, `pending-adapter` |
| `04-stress-datatypes-and-methods.xml` | stress | `opcua-nodeset` ≥ 0.9 | valid | `option-set`, `structured-datatype`, `optional-fields`, `union-datatype`, `array-dimensions`, `AccessLevel`, `Historizing`, `output-arguments`, `encoding-object`, `multi-namespace`, `pending-adapter` |
| `05-real-world-companion-nodeset.xml` | real-world | `opcua-nodeset` ≥ 0.9 | valid | `companion-spec`, `state-enum`, `counters-structure`, `identification`, `analog-item`, `engineering-units`, `methods`, `pending-adapter` |
| `06-typical-instance-address-space.xml` ⚠ | typical | `opcua-nodeset` ≥ 0.9 | valid | `instances`, `address-space`, `hierarchy`, `live-value`, `pending-adapter` |
| `07-companion-set/companion.xml` ⚠ | multi-file (member) | `opcua-nodeset` (no guarantee) | valid | `companion-model`, `base-type`, `enum-datatype`, `pending-adapter` |
| `07-companion-set/model.xml` | multi-file (root) | `opcua-nodeset` ≥ 0.9 | valid | `RequiredModel`, `cross-namespace-subtype`, `cross-namespace-datatype`, `pending-adapter` |
| `negative/01-syntactic-unclosed-node.xml` | — | `opcua-nodeset` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-no-nodes.xml` | — | `opcua-nodeset` (no guarantee) | invalid | `negative`, `semantic`, `no-nodes`, `pending-adapter` |
| `negative/03-truncated-mid-definition.xml` | — | `opcua-nodeset` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute`, `pending-adapter` |
| `negative/04-wrong-format-xsd.xsd` | — | `opcua-nodeset` (no guarantee) | invalid | `negative`, `wrong-format`, `xsd`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `opcua-nodeset` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-node-reference.xml` | — | `opcua-nodeset` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-node-id`, `missing-datatype`, `pending-adapter` |

> ⚠ **`06-typical-instance-address-space.xml`** — Instances are described in the payload analysis but must not be promoted to canonical types — the FMT-9.1 boundary rule.

> ⚠ **`07-companion-set/companion.xml`** — Fileset member: the companion specification supplying the base type and data type the root references by ns=2 ids.

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
| `33-nonconforming-examples.yaml` ⚠ | typical | `openapi-3.1` ≥ 0.95 | valid | `non-conforming-examples`, `multiple-examples`, `response-examples`, `enum` |
| `34-overlay-basic-set/openapi.yaml` | multi-file (root) | `openapi-3.1` ≥ 0.99 | valid | `overlay`, `overlay-base`, `parameters`, `servers` |
| `34-overlay-basic-set/overlay.yaml` ⚠ | multi-file (member) | `openapi-3.1` (no guarantee) | valid | `overlay`, `overlay-add`, `overlay-update`, `overlay-remove` |
| `35-overlay-chain-set/01-region-defaults.yaml` ⚠ | multi-file (member) | `openapi-3.1` (no guarantee) | valid | `overlay`, `overlay-chain`, `overlay-add`, `overlay-update` |
| `35-overlay-chain-set/02-production.yaml` ⚠ | multi-file (member) | `openapi-3.1` (no guarantee) | valid | `overlay`, `overlay-chain`, `overlay-update`, `overlay-remove` |
| `35-overlay-chain-set/openapi.yaml` | multi-file (root) | `openapi-3.1` ≥ 0.99 | valid | `overlay`, `overlay-chain`, `overlay-base`, `requestBody` |
| `negative/01-syntactic-unclosed-flow-sequence.yaml` | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-flow-sequence` |
| `negative/02-truncated-mid-quoted-ref.yaml` | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `truncated`, `cut-mid-token` |
| `negative/03-wrong-format-graphql-sdl.graphql` | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `wrong-format`, `graphql-sdl` |
| `negative/04-encoding-utf16.yaml` | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |
| `negative/05-version-out-of-range.yaml` ⚠ | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `version-out-of-range`, `openapi-9.0.0` |
| `negative/06-bare-overlay.yaml` ⚠ | — | `openapi-3.1` (no guarantee) | invalid | `negative`, `semantic`, `overlay`, `bare-overlay` |

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

> ⚠ **`33-nonconforming-examples.yaml`** — Every example carrier (component schema, nested property, path- and operation-level parameter, request body, response media type with an examples map, and a response header) deliberately violates its schema; the document is valid OpenAPI 3.1 and must import cleanly. Drives tests/test_example_conformance_corpus.py.

> ⚠ **`34-overlay-basic-set/overlay.yaml`** — Fileset member: an Overlay document, not an API description. The openapi adapter claims a bare overlay at 0.9 with no format pinned, and importing it alone fails with INPUT_OVERLAY_BASE_MISSING (see openapi/negative/06-bare-overlay.yaml); it imports only through the set root openapi.yaml.

> ⚠ **`35-overlay-chain-set/01-region-defaults.yaml`** — Fileset member: an Overlay document applied in member-path order before 02-production.yaml; imports only through the set root openapi.yaml.

> ⚠ **`35-overlay-chain-set/02-production.yaml`** — Fileset member: an Overlay document applied in member-path order after 01-region-defaults.yaml; imports only through the set root openapi.yaml.

> ⚠ **`negative/05-version-out-of-range.yaml`** — Fails at the normalize phase (parse succeeds since the YAML is well-formed); the adapter's detect declines the 9.0.0 marker, so normalize raises and the pipeline grounds INPUT_SEMANTIC_INVALID.

> ⚠ **`negative/06-bare-overlay.yaml`** — The openapi adapter deliberately claims a bare overlay (confidence 0.9, no format pinned) so the import fails with INPUT_OVERLAY_BASE_MISSING, whose remediation prompts for the base document, instead of an obscure parse error.

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

### `owl/` — OWL / RDFS ontologies (pending #5471)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-ontology.ttl` | minimal | `owl` ≥ 0.85 | valid | `ontology-header`, `class`, `datatype-property`, `pending-adapter` |
| `02-typical-classes-and-properties.ttl` | typical | `owl` ≥ 0.85 | valid | `subClassOf`, `object-property`, `domain-range`, `inverseOf`, `FunctionalProperty`, `disjointWith`, `named-individuals`, `pending-adapter` |
| `03-imports-set/core.ttl` | multi-file (member) | `owl` (no guarantee) | valid | `multi-file`, `shared-classes`, `pending-adapter` |
| `03-imports-set/domain.ttl` | multi-file (root) | `owl` ≥ 0.85 | valid | `multi-file`, `owl-imports`, `cross-ontology-subclass`, `pending-adapter` |
| `04-stress-owl-constructs.ttl` ⚠ | stress | `owl` ≥ 0.85 | valid | `qualified-cardinality`, `oneOf`, `datatype-restriction`, `unionOf`, `intersectionOf`, `complementOf`, `someValuesFrom`, `allValuesFrom`, `TransitiveProperty`, `SymmetricProperty`, `propertyChainAxiom`, `sameAs`, `equivalentClass`, `pending-adapter` |
| `05-real-world-domain-ontology.ttl` | real-world | `owl` ≥ 0.85 | valid | `versionIRI`, `disjoint-subclasses`, `cardinality-restriction`, `skos-code-list`, `language-tagged-labels`, `licence`, `pending-adapter` |
| `06-typical-rdfxml.owl` | typical | `owl` ≥ 0.85 | valid | `rdf-xml`, `restriction`, `inverseOf`, `disjointWith`, `pending-adapter` |
| `07-composition-class-hierarchy.ttl` | composition | `owl` ≥ 0.85 | valid | `subClassOf`, `subPropertyOf`, `restriction-inheritance`, `disjointWith`, `pending-adapter` |
| `negative/01-syntactic-unterminated-iri.ttl` | — | `owl` (no guarantee) | invalid | `negative`, `syntactic`, `unterminated-iri`, `pending-adapter` |
| `negative/02-semantic-no-classes.ttl` | — | `owl` (no guarantee) | invalid | `negative`, `semantic`, `header-only`, `pending-adapter` |
| `negative/03-truncated-mid-restriction.ttl` | — | `owl` (no guarantee) | invalid | `negative`, `truncated`, `mid-typed-literal`, `pending-adapter` |
| `negative/04-wrong-format-shacl.ttl` | — | `owl` (no guarantee) | invalid | `negative`, `wrong-format`, `shacl`, `pending-adapter` |
| `negative/05-encoding-utf16.ttl` | — | `owl` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-import.ttl` | — | `owl` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-owl-imports`, `pending-adapter` |

> ⚠ **`04-stress-owl-constructs.ttl`** — The second half is open-world reasoning, not record structure; FMT-9.4 requires it declared rather than approximated.

### `pkl/` — Pkl (pending #5466)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-schema.pkl` | minimal | `pkl` ≥ 0.85 | valid | `module-properties`, `scalars`, `pending-adapter` |
| `02-typical-order-schema.pkl` | typical | `pkl` ≥ 0.85 | valid | `typealias`, `union-type`, `regex-constraint`, `range-constraint`, `listing`, `nullable`, `default`, `pending-adapter` |
| `03-modules-set/shared.pkl` | multi-file (member) | `pkl` (no guarantee) | valid | `multi-file`, `classes`, `pending-adapter` |
| `03-modules-set/shipping.pkl` | multi-file (root) | `pkl` ≥ 0.85 | valid | `multi-file`, `import`, `cross-module-class`, `pending-adapter` |
| `04-stress-type-system.pkl` ⚠ | stress | `pkl` ≥ 0.85 | valid | `Duration`, `DataSize`, `Mapping`, `Listing`, `open-class`, `abstract-class`, `inheritance`, `union`, `amending`, `late-binding`, `generator`, `conditional`, `read-env`, `output-renderer`, `function`, `pending-adapter` |
| `05-real-world-service-config.pkl` | real-world | `pkl` ≥ 0.85 | valid | `open-class-template`, `amending`, `subclass-tightening`, `defaults`, `mapping-of-services`, `pending-adapter` |
| `06-typical-template-and-instance.pkl` | typical | `pkl` ≥ 0.85 | valid | `template-plus-instance`, `listing-of-objects`, `defaults`, `pending-adapter` |
| `07-composition-mixins.pkl` | composition | `pkl` ≥ 0.85 | valid | `open-class`, `inheritance-chain`, `amending`, `listing-of-classes`, `pending-adapter` |
| `negative/01-syntactic-unclosed-class.pkl` | — | `pkl` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-class`, `pending-adapter` |
| `negative/02-semantic-type-constraint-violation.pkl` | — | `pkl` (no guarantee) | invalid | `negative`, `semantic`, `constraint-violation`, `pending-adapter` |
| `negative/03-truncated-mid-property.pkl` | — | `pkl` (no guarantee) | invalid | `negative`, `truncated`, `mid-constraint`, `pending-adapter` |
| `negative/04-wrong-format-cue.cue` | — | `pkl` (no guarantee) | invalid | `negative`, `wrong-format`, `cue`, `pending-adapter` |
| `negative/05-encoding-utf16.pkl` | — | `pkl` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-import.pkl` | — | `pkl` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-module`, `pending-adapter` |

> ⚠ **`04-stress-type-system.pkl`** — Second half exceeds JSON Schema and the sandbox: `read("env:…")` must be refused by the evaluation sandbox, and amending/late binding declared as limits.

### `pli/` — PL/I structures (pending #5480)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-structure.pli` | minimal | `pli` ≥ 0.85 | valid | `declare`, `char`, `fixed-bin`, `pending-adapter` |
| `02-typical-customer-record.pli` | typical | `pli` ≥ 0.85 | valid | `nested-group`, `fixed-dec`, `bit-flags`, `array-of-structures`, `filler`, `pending-adapter` |
| `03-includes-set/ADDRBLK.inc` | multi-file (member) | `pli` (no guarantee) | valid | `multi-file`, `include-member`, `pending-adapter` |
| `03-includes-set/MONYBLK.inc` | multi-file (member) | `pli` (no guarantee) | valid | `multi-file`, `include-member`, `pending-adapter` |
| `03-includes-set/main.pli` | multi-file (root) | `pli` ≥ 0.85 | valid | `multi-file`, `include`, `like-clone`, `occurs-table`, `pending-adapter` |
| `04-stress-attribute-coverage.pli` ⚠ | stress | `pli` ≥ 0.85 | valid | `char-varying`, `graphic`, `picture`, `fixed-bin-widths`, `float`, `bit`, `pointer`, `area`, `arrays`, `two-dimensional`, `union`, `like`, `based`, `aligned`, `unaligned`, `refer`, `pending-adapter` |
| `05-real-world-payment-record.pli` | real-world | `pli` ≥ 0.85 | valid | `header-trailer`, `party-blocks`, `address-arrays`, `charges-table`, `status-flags`, `packed-decimal`, `pending-adapter` |
| `06-typical-union-record.pli` | typical | `pli` ≥ 0.85 | valid | `union`, `shared-storage`, `record-type-discriminator`, `pending-adapter` |
| `07-composition-like-and-nesting.pli` | composition | `pli` ≥ 0.85 | valid | `like-clone`, `shared-blocks`, `record-of-records`, `array-of-structures`, `pending-adapter` |
| `negative/01-syntactic-missing-semicolon.pli` | — | `pli` (no guarantee) | invalid | `negative`, `syntactic`, `missing-semicolon`, `pending-adapter` |
| `negative/02-semantic-level-number-gap.pli` | — | `pli` (no guarantee) | invalid | `negative`, `semantic`, `level-number-gap`, `orphan-level`, `pending-adapter` |
| `negative/03-truncated-mid-declare.pli` | — | `pli` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute`, `pending-adapter` |
| `negative/04-wrong-format-cobol-copybook.cpy` ⚠ | — | `pli` (no guarantee) | invalid | `negative`, `wrong-format`, `cobol-copybook`, `pending-adapter` |
| `negative/05-encoding-utf16.pli` | — | `pli` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-include.pli` ⚠ | — | `pli` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-include`, `pending-adapter` |

> ⚠ **`04-stress-attribute-coverage.pli`** — REFER extents are runtime values: FMT-11.1 must declare that limit rather than guessing a length.

> ⚠ **`negative/04-wrong-format-cobol-copybook.cpy`** — The sibling format in the same estates, already shipped as cobolcopybook: level numbers plus PIC clauses rather than DCL plus attributes.

> ⚠ **`negative/06-unresolvable-include.pli`** — The FMT-11.1 acceptance case: an unresolved %INCLUDE makes the record partial with a named reason, never a silently short layout.

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

### `postman-v2/` — Postman Collection v2.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-single-request.json` | minimal | `postman-2.0` ≥ 0.95 | valid | `string-url`, `single-request` |
| `02-typical-crud-collection.json` | typical | `postman-2.0` ≥ 0.95 | valid | `string-url`, `collection-variables`, `path-variables`, `saved-response` |
| `03-composition-nested-folders.json` | composition | `postman-2.0` ≥ 0.95 | valid | `nested-folders`, `operation-groups` |
| `04-stress-auth-bodies-and-scripts.json` | stress | `postman-2.0` ≥ 0.95 | valid | `raw-body`, `urlencoded-body`, `formdata-body`, `graphql-body`, `v2.0-auth-shape`, `scripts`, `disabled-entries` |
| `05-real-world-payments-collection.json` | real-world | `postman-2.0` ≥ 0.95 | valid | `oauth-token-capture`, `idempotency-key`, `saved-response`, `nested-folders` |
| `06-environment-set/collection.json` | multi-file (root) | `postman-2.0` ≥ 0.95 | valid | `multi-file`, `environment-variables` |
| `06-environment-set/environment.json` ⚠ | multi-file (member) | `postman-2.0` (no guarantee) | valid | `multi-file`, `environment-file` |
| `negative/01-syntactic-unterminated-string.json` | — | `postman-2.0` (no guarantee) | invalid | `negative`, `syntactic`, `unterminated-string` |
| `negative/02-semantic-no-items.json` | — | `postman-2.0` (no guarantee) | invalid | `negative`, `semantic`, `no-items` |
| `negative/03-truncated-mid-item.json` ⚠ | — | `postman-2.0` (no guarantee) | invalid | `negative`, `truncated`, `mid-url` |
| `negative/04-wrong-format-openapi.json` | — | `postman-2.0` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi` |
| `negative/05-encoding-utf16.json` | — | `postman-2.0` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-version-out-of-range-v1.json` ⚠ | — | `postman-2.0` (no guarantee) | invalid | `negative`, `version-out-of-range`, `collection-v1` |

> ⚠ **`06-environment-set/environment.json`** — Fileset member: a Postman environment export (_postman_variable_scope), not a collection — not independently detectable as one.

> ⚠ **`negative/03-truncated-mid-item.json`** — JSON truncation surfaces as a parse error indistinguishable from any other malformed document, so the pipeline reports INPUT_MALFORMED — the same code the shipped postman/ truncation fixture carries.

> ⚠ **`negative/06-version-out-of-range-v1.json`** — Postman Collection v1: no info.schema at all. FMT-3.6 extends intake to v2.0, not to v1, so this must reject with a version message rather than a parse error.

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
| `07-inventory-source.proto` ⚠ | typical | `protobuf` ≥ 0.95 | valid | `proto3`, `service`, `rpc`, `message`, `enum`, `map`, `package`, `binary-pair`, `binary-pair-source` |
| `08-inventory-descriptor-set.binpb` ⚠ | typical | `protobuf` ≥ 0.9 | valid | `binary`, `descriptor-set`, `binary-pair`, `binary-pair-descriptor-set` |
| `09-inventory-buf-image.binpb` ⚠ | typical | `protobuf` ≥ 0.9 | valid | `binary`, `buf-image`, `binary-pair`, `binary-pair-buf-image` |
| `negative/01-syntactic-unclosed-message.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-message` |
| `negative/02-semantic-duplicate-field-number.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `semantic`, `duplicate-field-number` |
| `negative/03-truncated-mid-message.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `truncated`, `mid-message` |
| `negative/04-unresolvable-ref-missing-import.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-import` |
| `negative/05-encoding-utf16-user.proto` | — | `protobuf` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bytes` |
| `negative/06-truncated-descriptor-set.binpb` | — | `protobuf` (no guarantee) | invalid | `negative`, `truncated`, `binary`, `descriptor-set` |
| `negative/07-garbage-descriptor-set.binpb` | — | `protobuf` (no guarantee) | invalid | `negative`, `syntactic`, `binary`, `descriptor-set` |

> ⚠ **`07-inventory-source.proto`** — Paired fixture (IXH-7.5): the descriptor-set and buf-image entries compiled from this source must import to the same canonical model.

> ⚠ **`08-inventory-descriptor-set.binpb`** — Paired fixture (IXH-7.5): must import to the same canonical model as protobuf/07-inventory-source.proto.

> ⚠ **`09-inventory-buf-image.binpb`** — Paired fixture (IXH-7.5): must import to the same canonical model as protobuf/07-inventory-source.proto.

### `protobuf-editions/` — Protobuf editions (2023/2024)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-edition-2023.proto` | minimal | `protobuf-editions` ≥ 0.9 | valid | `edition-2023`, `defaults-only` |
| `02-typical-orders-edition-2023.proto` | typical | `protobuf-editions` ≥ 0.9 | valid | `edition-2023`, `field-presence`, `EXPLICIT`, `IMPLICIT`, `service` |
| `03-imports-set/common.proto` ⚠ | multi-file (member) | `protobuf-editions` (no guarantee) | valid | `multi-file`, `edition-2023`, `IMPLICIT` |
| `03-imports-set/orders.proto` | multi-file (root) | `protobuf-editions` ≥ 0.9 | valid | `multi-file`, `import`, `edition-2023`, `feature-scope` |
| `04-stress-feature-overrides.proto` | stress | `protobuf-editions` ≥ 0.9 | valid | `field-presence`, `enum-type`, `repeated-field-encoding`, `utf8-validation`, `message-encoding`, `json-format`, `LEGACY-REQUIRED`, `DELIMITED`, `oneof`, `map`, `extension` |
| `05-real-world-telemetry-edition-2023.proto` | real-world | `protobuf-editions` ≥ 0.9 | valid | `edition-2023`, `LEGACY-REQUIRED`, `utf8-validation`, `streaming`, `well-known-types` |
| `06-typical-edition-2024.proto` | typical | `protobuf-editions` ≥ 0.9 | valid | `edition-2024`, `enum-type`, `IMPLICIT` |
| `07-composition-nested-and-extended.proto` | composition | `protobuf-editions` ≥ 0.9 | valid | `nested-message`, `nested-enum`, `message-reuse`, `extensions`, `feature-scope` |
| `negative/01-syntactic-missing-semicolon.proto` | — | `protobuf-editions` (no guarantee) | invalid | `negative`, `syntactic`, `missing-semicolon` |
| `negative/02-semantic-unknown-feature-value.proto` ⚠ | — | `protobuf-editions` (no guarantee) | invalid | `negative`, `semantic`, `unknown-feature-value` |
| `negative/03-truncated-mid-message.proto` ⚠ | — | `protobuf-editions` (no guarantee) | invalid | `negative`, `truncated`, `mid-field-option` |
| `negative/04-wrong-format-flatbuffers.fbs` | — | `protobuf-editions` (no guarantee) | invalid | `negative`, `wrong-format`, `flatbuffers` |
| `negative/05-encoding-utf16.proto` | — | `protobuf-editions` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-version-out-of-range-edition-2099.proto` | — | `protobuf-editions` (no guarantee) | invalid | `negative`, `version-out-of-range`, `edition-2099` |

> ⚠ **`03-imports-set/common.proto`** — Fileset member with the opposite file-level presence default from its importer — the leak test.

> ⚠ **`negative/02-semantic-unknown-feature-value.proto`** — Grounded on current behaviour: `buf build` reports an unknown feature enum value as an ordinary name-resolution fault ("cannot find `SOMETIMES` in this scope"), and every compile failure the adapter surfaces carries the parse phase's default INPUT_MALFORMED. The intent that this is a *semantic* fault is recorded in failure_class.

> ⚠ **`negative/03-truncated-mid-message.proto`** — Grounded on current behaviour: a .proto cut off mid-message reaches the compiler as unbalanced delimiters, so it is reported as INPUT_MALFORMED rather than INPUT_TRUNCATED (the same re-grounding FMT-3.3/3.4/3.5/3.6 made for truncated text inputs). Only the binary descriptor-set path can tell truncation from corruption, and it does — see protobuf/negative.

### `pydantic/` — Pydantic models (pending #5465)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-model.py` | minimal | `pydantic` ≥ 0.85 | valid | `BaseModel`, `annotations`, `pending-adapter` |
| `02-typical-order-models.py` | typical | `pydantic` ≥ 0.85 | valid | `Field-constraints`, `str-enum`, `optional`, `list-cardinality`, `EmailStr`, `pattern`, `pending-adapter` |
| `03-models-set/customer.py` | multi-file (member) | `pydantic` (no guarantee) | valid | `multi-file`, `BaseModel`, `pending-adapter` |
| `03-models-set/models.py` ⚠ | multi-file (root) | `pydantic` ≥ 0.85 | valid | `multi-file`, `cross-module-import`, `aggregate-model`, `pending-adapter` |
| `03-models-set/order.py` | multi-file (member) | `pydantic` (no guarantee) | valid | `multi-file`, `cross-module-type`, `enum`, `pending-adapter` |
| `04-stress-annotation-coverage.py` ⚠ | stress | `pydantic` ≥ 0.85 | valid | `Annotated`, `StringConstraints`, `Decimal`, `Literal`, `discriminator`, `generic-model`, `self-reference`, `ConfigDict`, `alias`, `default-factory`, `field-validator`, `computed-field`, `create-model-constants`, `pending-adapter` |
| `05-real-world-api-models.py` | real-world | `pydantic` ≥ 0.85 | valid | `camelCase-alias`, `Decimal`, `discriminated-union`, `pagination`, `populate-by-name`, `extra-forbid`, `pending-adapter` |
| `06-typical-dynamic-models.py` ⚠ | typical | `pydantic` ≥ 0.85 | valid | `create-model`, `dynamic-construction`, `declared-limit`, `pending-adapter` |
| `07-composition-inheritance.py` | composition | `pydantic` ≥ 0.85 | valid | `mixin`, `multiple-inheritance`, `generic-subclass`, `model-of-models`, `discriminated-union`, `pending-adapter` |
| `negative/01-syntactic-bad-indentation.py` | — | `pydantic` (no guarantee) | invalid | `negative`, `syntactic`, `bad-indentation`, `pending-adapter` |
| `negative/02-semantic-no-basemodel-subclasses.py` | — | `pydantic` (no guarantee) | invalid | `negative`, `semantic`, `no-models`, `pending-adapter` |
| `negative/03-truncated-mid-class.py` | — | `pydantic` (no guarantee) | invalid | `negative`, `truncated`, `mid-field`, `pending-adapter` |
| `negative/04-wrong-format-dataclasses.py` | — | `pydantic` (no guarantee) | invalid | `negative`, `wrong-format`, `dataclasses`, `pending-adapter` |
| `negative/05-encoding-utf16.py` | — | `pydantic` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-import.py` | — | `pydantic` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-module`, `pending-adapter` |

> ⚠ **`03-models-set/models.py`** — Set root: named models.py rather than __init__.py because the corpus path contract forbids a leading underscore; it plays the package-root role.

> ⚠ **`04-stress-annotation-coverage.py`** — Organised as statically-resolvable / declared-limits halves: validators and computed fields cannot be read without executing the module, which FMT-8.4 forbids.

> ⚠ **`06-typical-dynamic-models.py`** — The FMT-8.4 acceptance case: dynamic model construction must be declared a parsing limit, with the statically visible base still modelled.

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

### `relaxng/` — RELAX NG (pending #5434)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-note.rng` | minimal | `relaxng` ≥ 0.9 | valid | `element-pattern`, `attribute`, `text` |
| `02-typical-catalogue.rng` | typical | `relaxng` ≥ 0.9 | valid | `grammar`, `define`, `ref`, `optional`, `zeroOrMore`, `choice`, `data-param` |
| `03-modular-set/address.rng` | multi-file (member) | `relaxng` (no guarantee) | valid | `multi-file`, `include`, `define` |
| `03-modular-set/main.rng` | multi-file (root) | `relaxng` ≥ 0.9 | valid | `multi-file`, `include`, `define-override`, `externalRef` |
| `03-modular-set/parcel.rng` | multi-file (member) | `relaxng` (no guarantee) | valid | `multi-file`, `externalRef`, `element-pattern` |
| `04-stress-interleave-and-datatypes.rng` ⚠ | stress | `relaxng` ≥ 0.9 | valid | `interleave`, `mixed`, `list`, `except`, `anyName`, `nsName`, `empty`, `recursion` |
| `05-real-world-article-grammar.rng` | real-world | `relaxng` ≥ 0.9 | valid | `interleave`, `recursion`, `mixed`, `ID`, `IDREF`, `ns` |
| `06-compact-catalogue.rnc` ⚠ | typical | `relaxng-compact` ≥ 0.9 | valid | `compact-syntax`, `datatypes`, `same-grammar-as-02` |
| `07-composition-named-pattern-reuse.rng` | composition | `relaxng` ≥ 0.9 | valid | `define`, `ref`, `combine-choice`, `shared-attributes`, `recursion` |
| `negative/01-syntactic-unclosed-define.rng` | — | `relaxng` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element` |
| `negative/02-semantic-grammar-without-start.rng` | — | `relaxng` (no guarantee) | invalid | `negative`, `semantic`, `no-start` |
| `negative/03-truncated-mid-pattern.rng` ⚠ | — | `relaxng` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute` |
| `negative/04-wrong-format-xsd.xsd` | — | `relaxng` (no guarantee) | invalid | `negative`, `wrong-format`, `xsd` |
| `negative/05-encoding-utf16.rng` | — | `relaxng` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-unresolvable-ref.rng` | — | `relaxng` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `undefined-pattern` |

> ⚠ **`04-stress-interleave-and-datatypes.rng`** — interleave and the wildcard/except constructs have no canonical analogue; FMT-4.1 requires them declared as parsing limits, so a clean import here is expected to carry declared-loss warnings.

> ⚠ **`06-compact-catalogue.rnc`** — The compact form of 02-typical-catalogue.rng; the acceptance criterion is that both produce the same canonical model.

> ⚠ **`negative/03-truncated-mid-pattern.rng`** — Truncation is grounded at INPUT_MALFORMED, as for every other XML adapter's truncated fixture: a document cut mid-attribute is rejected by the XML parser before RELAX NG semantics are reached, and the intent is kept in failure_class.

### `ros2/` — ROS 2 interfaces (pending #5470)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-message.msg` | minimal | `ros2` ≥ 0.85 | valid | `msg`, `primitives`, `pending-adapter` |
| `02-typical-sensor-message.msg` | typical | `ros2` ≥ 0.85 | valid | `msg`, `constants`, `header`, `unbounded-array`, `comments`, `pending-adapter` |
| `03-package-set/LiftPallet.srv` | multi-file (member) | `ros2` (no guarantee) | valid | `multi-file`, `srv`, `bare-name-reference`, `pending-adapter` |
| `03-package-set/LoadCell.msg` | multi-file (member) | `ros2` (no guarantee) | valid | `multi-file`, `msg`, `pending-adapter` |
| `03-package-set/PalletStatus.msg` | multi-file (member) | `ros2` (no guarantee) | valid | `multi-file`, `bare-name-reference`, `cross-package-reference`, `constants`, `pending-adapter` |
| `03-package-set/package.xml` | multi-file (root) | `ros2` ≥ 0.85 | valid | `multi-file`, `package-manifest`, `dependencies`, `pending-adapter` |
| `04-stress-idl-grammar.msg` | stress | `ros2` ≥ 0.85 | valid | `all-primitives`, `constants`, `wstring`, `bounded-string`, `fixed-array`, `bounded-array`, `array-default`, `cross-package-reference`, `pending-adapter` |
| `05-real-world-navigate-to-pose.action` | real-world | `ros2` ≥ 0.85 | valid | `action`, `goal-result-feedback`, `error-constants`, `duration`, `defaults`, `pending-adapter` |
| `06-typical-service.srv` | typical | `ros2` ≥ 0.85 | valid | `srv`, `request-response`, `result-constants`, `defaults`, `pending-adapter` |
| `07-composition-nested-messages.msg` | composition | `ros2` ≥ 0.85 | valid | `same-package-reference`, `cross-package-reference`, `bounded-array-of-composed`, `constants`, `pending-adapter` |
| `negative/01-syntactic-bad-field-line.msg` | — | `ros2` (no guarantee) | invalid | `negative`, `syntactic`, `malformed-field-line`, `pending-adapter` |
| `negative/02-semantic-empty-message.msg` | — | `ros2` (no guarantee) | invalid | `negative`, `semantic`, `no-fields`, `pending-adapter` |
| `negative/03-truncated-mid-action.action` | — | `ros2` (no guarantee) | invalid | `negative`, `truncated`, `mid-field`, `missing-feedback-section`, `pending-adapter` |
| `negative/04-wrong-format-protobuf.proto` | — | `ros2` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf`, `pending-adapter` |
| `negative/05-encoding-utf16.msg` | — | `ros2` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-type-reference.msg` ⚠ | — | `ros2` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-package`, `missing-local-type`, `pending-adapter` |

> ⚠ **`negative/06-unresolvable-type-reference.msg`** — The FMT-9.3 acceptance case: cross-package references resolve within a fileset and are declared unresolved otherwise.

### `schematron/` — Schematron rules

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-single-assert.sch` | minimal | `schematron` ≥ 0.9 | valid | `pattern`, `rule`, `assert`, `style-guide-import` |
| `02-typical-invoice-rules.sch` | typical | `schematron` ≥ 0.9 | valid | `pattern`, `rule`, `assert`, `report`, `let`, `ns`, `role`, `rule-ids`, `style-guide-import` |
| `03-composition-abstract-patterns.sch` | composition | `schematron` ≥ 0.9 | valid | `abstract-pattern`, `is-a`, `param`, `abstract-rule`, `extends`, `style-guide-import` |
| `04-stress-phases-and-diagnostics.sch` ⚠ | stress | `schematron` ≥ 0.9 | valid | `phase`, `active`, `defaultPhase`, `diagnostics`, `flag`, `unevaluable-xpath`, `style-guide-import` |
| `05-real-world-billing-bis-rules.sch` | real-world | `schematron` ≥ 0.9 | valid | `business-rules`, `calculation-rules`, `vat-rules`, `role`, `rule-ids`, `style-guide-import` |
| `06-include-set/main.sch` | multi-file (root) | `schematron` ≥ 0.9 | valid | `multi-file`, `include`, `pattern`, `style-guide-import` |
| `06-include-set/structure-rules.sch` ⚠ | multi-file (member) | `schematron` (no guarantee) | valid | `multi-file`, `include`, `pattern-module`, `style-guide-import` |
| `negative/01-syntactic-unclosed-rule.sch` | — | `schematron` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `style-guide-import` |
| `negative/02-semantic-pattern-without-rules.sch` | — | `schematron` (no guarantee) | invalid | `negative`, `semantic`, `no-assertions`, `style-guide-import` |
| `negative/03-truncated-mid-assert.sch` | — | `schematron` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute`, `style-guide-import` |
| `negative/04-wrong-format-xslt.xsl` ⚠ | — | `schematron` (no guarantee) | invalid | `negative`, `wrong-format`, `xslt`, `style-guide-import` |
| `negative/05-encoding-utf16.sch` | — | `schematron` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `style-guide-import` |
| `negative/06-unresolvable-is-a-reference.sch` | — | `schematron` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-abstract-pattern`, `style-guide-import` |

> ⚠ **`04-stress-phases-and-diagnostics.sch`** — Carries one deliberately unevaluable XPath (doc:resolve-external) so the declared-but-unevaluable path is exercised; import succeeds with that rule flagged.

> ⚠ **`06-include-set/structure-rules.sch`** — Fileset member: a bare pattern module with no schema root — only meaningful once included.

> ⚠ **`negative/04-wrong-format-xslt.xsl`** — Schematron is usually compiled to XSLT, so a stylesheet is the neighbour most likely to be mistaken for one.

### `sepa/` — SEPA payment files (pending #5450)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-pain001.xml` | minimal | `iso20022` ≥ 0.9 | valid | `pain.001`, `single-transaction`, `iban`, `pending-adapter` |
| `02-typical-pain001-batch.xml` | typical | `iso20022` ≥ 0.9 | valid | `pain.001`, `batch-booking`, `PmtTpInf`, `category-purpose`, `postal-address`, `pending-adapter` |
| `03-composition-pain001-multi-pmtinf.xml` | composition | `iso20022` ≥ 0.9 | valid | `pain.001`, `multiple-PmtInf`, `structured-remittance`, `instant-payment`, `purpose-code`, `pending-adapter` |
| `04-stress-pain008-direct-debit.xml` | stress | `iso20022` ≥ 0.9 | valid | `pain.008`, `CORE`, `B2B`, `FRST`, `RCUR`, `mandate`, `mandate-amendment`, `creditor-scheme-id`, `pending-adapter` |
| `05-real-world-pacs008-interbank.xml` | real-world | `iso20022` ≥ 0.9 | valid | `pacs.008`, `clearing-system`, `UETR`, `intermediary-agent`, `regulatory-reporting`, `pending-adapter` |
| `06-typical-camt053-statement.xml` | typical | `iso20022` ≥ 0.9 | valid | `camt.053`, `balances`, `bank-transaction-code`, `entry-details`, `pending-adapter` |
| `07-status-set/pain001.xml` | multi-file (root) | `iso20022` ≥ 0.9 | valid | `pain.001`, `two-transactions`, `pending-adapter` |
| `07-status-set/pain002.xml` ⚠ | multi-file (member) | `iso20022` (no guarantee) | valid | `pain.002`, `status-report`, `reject-reason`, `partial-acceptance`, `pending-adapter` |
| `negative/01-syntactic-unclosed-element.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-no-transactions.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `semantic`, `no-transactions`, `pending-adapter` |
| `negative/03-truncated-mid-transaction.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `truncated`, `mid-amount`, `pending-adapter` |
| `negative/04-wrong-format-nacha.ach` ⚠ | — | `iso20022` (no guarantee) | invalid | `negative`, `wrong-format`, `nacha`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-version-out-of-range-pain001-099.xml` | — | `iso20022` (no guarantee) | invalid | `negative`, `version-out-of-range`, `unpublished-message-version`, `pending-adapter` |

> ⚠ **`07-status-set/pain002.xml`** — Fileset member: the status report. It references the initiation by OrgnlMsgId and each transaction by OrgnlEndToEndId.

> ⚠ **`negative/04-wrong-format-nacha.ach`** — The US twin from the same ticket: fixed-width ACH must route to the NACHA parser, not to the ISO 20022 adapter.

### `shacl/` — SHACL shapes (pending #5471)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-shape.ttl` | minimal | `shacl` ≥ 0.85 | valid | `NodeShape`, `property-shape`, `datatype`, `cardinality`, `pending-adapter` |
| `02-typical-person-shapes.ttl` | typical | `shacl` ≥ 0.85 | valid | `targetClass`, `pattern`, `in`, `severity`, `message`, `class-reference`, `order`, `pending-adapter` |
| `03-composition-node-shapes.ttl` | composition | `shacl` ≥ 0.85 | valid | `sh-node`, `and`, `or`, `xone`, `sequence-path`, `inverse-path`, `pending-adapter` |
| `04-stress-constraint-components.ttl` ⚠ | stress | `shacl` ≥ 0.85 | valid | `all-core-components`, `closed`, `ignoredProperties`, `qualifiedValueShape`, `property-pair`, `languageIn`, `uniqueLang`, `property-group`, `sparql-constraint`, `zeroOrMorePath`, `alternativePath`, `pending-adapter` |
| `05-real-world-dataset-shapes.ttl` | real-world | `shacl` ≥ 0.85 | valid | `dcat`, `publication-profile`, `ordered-properties`, `severity`, `lessThanOrEquals`, `pending-adapter` |
| `06-typical-shapes.jsonld` | typical | `shacl` ≥ 0.85 | valid | `json-ld-serialization`, `NodeShape`, `pattern`, `in`, `pending-adapter` |
| `07-stress-cyclic-shape-graph.ttl` ⚠ | stress | `shacl` ≥ 0.85 | valid | `cyclic-shapes`, `mutual-reference`, `self-reference`, `recursion`, `pending-adapter` |
| `08-imported-shapes-set/core-shapes.ttl` ⚠ | multi-file (member) | `shacl` (no guarantee) | valid | `shared-shapes`, `reusable-node-shapes`, `pending-adapter` |
| `08-imported-shapes-set/shapes.ttl` | multi-file (root) | `shacl` ≥ 0.85 | valid | `owl-imports`, `sh-node-across-files`, `pending-adapter` |
| `negative/01-syntactic-missing-dot.ttl` | — | `shacl` (no guarantee) | invalid | `negative`, `syntactic`, `missing-statement-terminator`, `pending-adapter` |
| `negative/02-semantic-no-node-shapes.ttl` | — | `shacl` (no guarantee) | invalid | `negative`, `semantic`, `no-shapes`, `pending-adapter` |
| `negative/03-truncated-mid-property.ttl` | — | `shacl` (no guarantee) | invalid | `negative`, `truncated`, `mid-literal`, `pending-adapter` |
| `negative/04-wrong-format-owl.ttl` ⚠ | — | `shacl` (no guarantee) | invalid | `negative`, `wrong-format`, `owl`, `pending-adapter` |
| `negative/05-encoding-utf16.ttl` | — | `shacl` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-shape-reference.ttl` | — | `shacl` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-shape`, `pending-adapter` |

> ⚠ **`04-stress-constraint-components.ttl`** — SPARQL constraints and unbounded property paths have no canonical analogue; FMT-9.4 requires them declared, not approximated.

> ⚠ **`07-stress-cyclic-shape-graph.ttl`** — The FMT-9.4 cyclic case: SHACL leaves recursion undefined, so the reader must terminate within budget and declare the cycle.

> ⚠ **`08-imported-shapes-set/core-shapes.ttl`** — Fileset member: the shared shapes module the root imports; it targets nothing on its own.

> ⚠ **`negative/04-wrong-format-owl.ttl`** — Same syntax (Turtle), different vocabulary: the split between shapes and ontologies is the namespace, not the file type.

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

### `soapui/` — SoapUI / ReadyAPI projects (pending #5477)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-project.xml` | minimal | `soapui` ≥ 0.9 | valid | `rest-interface`, `resource`, `method`, `pending-adapter` |
| `02-typical-rest-project.xml` | typical | `soapui` ≥ 0.9 | valid | `rest-interface`, `query-parameter`, `template-parameter`, `representations`, `multiple-endpoints`, `project-properties`, `pending-adapter` |
| `03-wsdl-set/catalogue.wsdl` ⚠ | multi-file (member) | `wsdl` (no guarantee) | valid | `multi-file`, `wsdl`, `pending-adapter` |
| `03-wsdl-set/project.xml` | multi-file (root) | `soapui` ≥ 0.9 | valid | `multi-file`, `wsdl-interface`, `local-definition`, `pending-adapter` |
| `04-stress-test-suites.xml` | stress | `soapui` ≥ 0.9 | valid | `test-suite`, `test-case`, `restrequest-step`, `transfer-step`, `groovy-step`, `datasource-step`, `assertions`, `test-properties`, `pending-adapter` |
| `05-real-world-soap-project.xml` | real-world | `soapui` ≥ 0.9 | valid | `wsdl-interface`, `one-way-operation`, `saved-envelopes`, `ws-security`, `environments`, `smoke-suite`, `pending-adapter` |
| `06-typical-mock-service.xml` | typical | `soapui` ≥ 0.9 | valid | `mock-service`, `canned-responses`, `dispatch-style`, `pending-adapter` |
| `07-composition-shared-endpoints.xml` | composition | `soapui` ≥ 0.9 | valid | `shared-endpoints`, `project-properties`, `property-expansion`, `cross-interface-testcase`, `environments`, `pending-adapter` |
| `negative/01-syntactic-unclosed-interface.xml` | — | `soapui` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element`, `pending-adapter` |
| `negative/02-semantic-no-interfaces.xml` | — | `soapui` (no guarantee) | invalid | `negative`, `semantic`, `no-interfaces`, `pending-adapter` |
| `negative/03-truncated-mid-operation.xml` | — | `soapui` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute`, `pending-adapter` |
| `negative/04-wrong-format-wsdl.wsdl` | — | `soapui` (no guarantee) | invalid | `negative`, `wrong-format`, `wsdl`, `pending-adapter` |
| `negative/05-encoding-utf16.xml` | — | `soapui` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-wsdl-definition.xml` ⚠ | — | `soapui` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-wsdl`, `pending-adapter` |

> ⚠ **`03-wsdl-set/catalogue.wsdl`** — Fileset member: the WSDL the interface delegates to; on its own the shipped wsdl adapter claims it.

> ⚠ **`negative/06-unresolvable-wsdl-definition.xml`** — The FMT-10.3 acceptance case: a project with a missing WSDL.

### `sparkplug/` — MQTT Sparkplug B (pending #5469)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-topic-namespace.json` | minimal | `sparkplug` ≥ 0.8 | valid | `topic-namespace`, `node-topics`, `pending-adapter` |
| `02-typical-nbirth.bin` | typical | `sparkplug` ≥ 0.8 | valid | `binary-intake`, `NBIRTH`, `bdSeq`, `node-control`, `properties`, `pending-adapter` |
| `03-composition-dbirth.bin` | composition | `sparkplug` ≥ 0.8 | valid | `binary-intake`, `DBIRTH`, `aliases`, `property-set`, `metadata`, `engineering-units`, `pending-adapter` |
| `04-stress-ddata-all-datatypes.bin` | stress | `sparkplug` ≥ 0.8 | valid | `binary-intake`, `all-datatypes`, `is-null`, `is-historical`, `is-transient`, `payload-uuid`, `alias-only-metric`, `pending-adapter` |
| `05-real-world-namespace-description.json` | real-world | `sparkplug` ≥ 0.8 | valid | `topic-namespace`, `devices`, `metric-catalogue`, `NCMD`, `DCMD`, `STATE`, `broker`, `pending-adapter` |
| `06-typical-ddata.bin` ⚠ | typical | `sparkplug` ≥ 0.8 | valid | `binary-intake`, `DDATA`, `alias-only-metric`, `pending-adapter` |
| `07-session-set/dbirth.bin` | multi-file (root) | `sparkplug` ≥ 0.8 | valid | `DBIRTH`, `aliases`, `property-set`, `binary-intake`, `pending-adapter` |
| `07-session-set/ddata.bin` ⚠ | multi-file (member) | `sparkplug` (no guarantee) | valid | `DDATA`, `alias-only-metric`, `binary-intake`, `pending-adapter` |
| `07-session-set/ddeath.bin` ⚠ | multi-file (member) | `sparkplug` (no guarantee) | valid | `DDEATH`, `bdSeq`, `binary-intake`, `pending-adapter` |
| `negative/01-syntactic-malformed-wire-format.bin` | — | `sparkplug` (no guarantee) | invalid | `negative`, `syntactic`, `malformed-varint-length`, `pending-adapter` |
| `negative/02-semantic-no-metrics.bin` | — | `sparkplug` (no guarantee) | invalid | `negative`, `semantic`, `no-metrics`, `pending-adapter` |
| `negative/03-truncated-mid-metric.bin` | — | `sparkplug` (no guarantee) | invalid | `negative`, `truncated`, `mid-metric`, `pending-adapter` |
| `negative/04-wrong-format-protobuf-schema.proto` ⚠ | — | `sparkplug` (no guarantee) | invalid | `negative`, `wrong-format`, `protobuf-schema`, `pending-adapter` |
| `negative/05-encoding-utf16.json` | — | `sparkplug` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-topic-namespace-mismatch.json` | — | `sparkplug` (no guarantee) | invalid | `negative`, `semantic`, `namespace-mismatch`, `group-mismatch`, `missing-edge-node`, `pending-adapter` |

> ⚠ **`06-typical-ddata.bin`** — Alias-only metrics: without the matching DBIRTH the names cannot be resolved, so the import must report inferred, unnamed metrics rather than inventing names.

> ⚠ **`07-session-set/ddata.bin`** — Fileset member: alias-only metrics that are only nameable through the DBIRTH in the same set.

> ⚠ **`07-session-set/ddeath.bin`** — Fileset member: the death certificate closing the session opened by the DBIRTH.

> ⚠ **`negative/04-wrong-format-protobuf-schema.proto`** — The Sparkplug payload *schema* rather than a payload: the shipped grpc adapter's input, not this one's.

### `sql-ddl/` — SQL DDL (pending #5444)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-ansi.sql` | minimal | `sql-ddl` ≥ 0.85 | valid | `ansi`, `create-table`, `primary-key`, `pending-adapter` |
| `02-typical-postgres.sql` | typical | `sql-ddl` ≥ 0.85 | valid | `postgres`, `enum-type`, `foreign-key`, `check-constraint`, `expression-index`, `comment-on`, `view`, `pending-adapter` |
| `03-migrations-set/V1__create_core.sql` ⚠ | multi-file (root) | `sql-ddl` ≥ 0.85 | valid | `multi-file`, `migrations`, `postgres`, `final-state`, `pending-adapter` |
| `03-migrations-set/V2__widen_and_rename.sql` | multi-file (member) | `sql-ddl` (no guarantee) | valid | `multi-file`, `migrations`, `rename-column`, `alter-type`, `pending-adapter` |
| `03-migrations-set/V3__constraints_and_indexes.sql` | multi-file (member) | `sql-ddl` (no guarantee) | valid | `multi-file`, `migrations`, `constraints`, `index`, `pending-adapter` |
| `04-stress-mysql.sql` ⚠ | stress | `sql-ddl` ≥ 0.85 | valid | `mysql`, `auto-increment`, `enum`, `set`, `json`, `generated-column`, `fulltext`, `partitions`, `alter-table`, `pending-adapter` |
| `05-real-world-sqlserver.sql` | real-world | `sql-ddl` ≥ 0.85 | valid | `sqlserver`, `identity`, `computed-column`, `filtered-index`, `rowversion`, `go-batches`, `view`, `pending-adapter` |
| `06-typical-oracle.sql` | typical | `sql-ddl` ≥ 0.85 | valid | `oracle`, `varchar2`, `number`, `clob`, `sequence`, `partitions`, `comment-on`, `pending-adapter` |
| `07-composition-inheritance-and-views.sql` | composition | `sql-ddl` ≥ 0.85 | valid | `domain`, `composite-type`, `table-inheritance`, `partitioning`, `view`, `materialized-view`, `postgres`, `pending-adapter` |
| `negative/01-syntactic-missing-paren.sql` | — | `sql-ddl` (no guarantee) | invalid | `negative`, `syntactic`, `missing-paren`, `pending-adapter` |
| `negative/02-semantic-table-without-columns.sql` | — | `sql-ddl` (no guarantee) | invalid | `negative`, `semantic`, `no-columns`, `pending-adapter` |
| `negative/03-truncated-mid-statement.sql` | — | `sql-ddl` (no guarantee) | invalid | `negative`, `truncated`, `mid-column`, `pending-adapter` |
| `negative/04-wrong-format-dbml.dbml` | — | `sql-ddl` (no guarantee) | invalid | `negative`, `wrong-format`, `dbml`, `pending-adapter` |
| `negative/05-encoding-utf16.sql` | — | `sql-ddl` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-foreign-key.sql` | — | `sql-ddl` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-referenced-table`, `pending-adapter` |

> ⚠ **`03-migrations-set/V1__create_core.sql`** — Set root: the migration series imports as its final state, so V1's shape is deliberately not what the canonical model should contain.

> ⚠ **`04-stress-mysql.sql`** — Storage clauses, partitions and FULLTEXT indexes have no canonical analogue; FMT-5.6 requires them declared as parsing limits rather than dropped.

### `swagger/` — Swagger 2.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-swagger-2-petstore.yaml` ⚠ | real-world | `swagger-2.0` ≥ 0.9 | valid | `nullable`, `enum`, `additionalProperties`, `defs`, `x-extensions` |

> ⚠ **`01-swagger-2-petstore.yaml`** — Currently outranked: detection ranks `api-blueprint` (0.98) above `swagger-2.0` (0.95); expected_detection records the intended winner for the detection-hardening work.

### `swagger-1.2/` — Swagger 1.2

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-declaration.json` | minimal | `swagger-1.2` ≥ 0.95 | valid | `api-declaration`, `operations` |
| `02-typical-orders-declaration.json` | typical | `swagger-1.2` ≥ 0.95 | valid | `api-declaration`, `models`, `responseMessages`, `body-parameter`, `enum` |
| `03-composition-model-subtypes.json` | composition | `swagger-1.2` ≥ 0.95 | valid | `subTypes`, `discriminator`, `inheritance` |
| `04-stress-parameter-and-auth-forms.json` | stress | `swagger-1.2` ≥ 0.95 | valid | `form-parameter`, `header-parameter`, `allowMultiple`, `File`, `oauth2`, `apiKey`, `grantTypes` |
| `05-petstore-set/api-docs.json` | multi-file (root) | `swagger-1.2` ≥ 0.95 | valid | `multi-file`, `resource-listing`, `authorizations` |
| `05-petstore-set/carts.json` | multi-file (member) | `swagger-1.2` (no guarantee) | valid | `multi-file`, `api-declaration` |
| `05-petstore-set/products.json` | multi-file (member) | `swagger-1.2` (no guarantee) | valid | `multi-file`, `api-declaration` |
| `06-real-world-user-directory.json` | real-world | `swagger-1.2` ≥ 0.95 | valid | `api-declaration`, `models`, `apiKey`, `cursor-paging` |
| `negative/01-syntactic-unclosed-apis-array.json` ⚠ | — | `swagger-1.2` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-array` |
| `negative/02-semantic-empty-resource-listing.json` | — | `swagger-1.2` (no guarantee) | invalid | `negative`, `semantic`, `empty-listing` |
| `negative/03-truncated-mid-model.json` ⚠ | — | `swagger-1.2` (no guarantee) | invalid | `negative`, `truncated`, `mid-model` |
| `negative/04-wrong-format-wsdl.wsdl` ⚠ | — | `swagger-1.2` (no guarantee) | invalid | `negative`, `wrong-format`, `wsdl` |
| `negative/05-encoding-utf16.json` | — | `swagger-1.2` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-unresolvable-declaration-ref.json` ⚠ | — | `swagger-1.2` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-declaration` |

> ⚠ **`negative/01-syntactic-unclosed-apis-array.json`** — An unquoted JSON key is valid YAML, and the intake loader falls back to YAML, so "unquoted key" is not a syntactic failure here; the fixture leaves the `apis` array unclosed instead, which neither parser accepts.

> ⚠ **`negative/03-truncated-mid-model.json`** — JSON/YAML truncation surfaces as a parse error the loader cannot distinguish from any other malformed document, so the pipeline reports INPUT_MALFORMED — the same code the shipped openapi/ truncation fixture carries.

> ⚠ **`negative/04-wrong-format-wsdl.wsdl`** — A Swagger 2.0 document cannot serve as this directory's wrong-format negative: the same adapter reads 1.2 and 2.0, so a 2.0 upload imports rather than failing. That routing is asserted directly in tests/test_swagger_1_2_import.py; this entry carries a SOAP description, which the openapi adapter never claims.

> ⚠ **`negative/06-unresolvable-declaration-ref.json`** — The FMT-3.6 acceptance case: a 1.2 listing whose declaration is missing from the fileset.

### `swift-mt/` — SWIFT MT (pending #5447)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-mt103.txt` | minimal | `swift-mt` ≥ 0.9 | valid | `MT103`, `block-structure`, `tag-fields`, `pending-adapter` |
| `02-typical-mt103.txt` | typical | `swift-mt` ≥ 0.9 | valid | `MT103`, `user-header`, `UETR`, `remittance-codes`, `sender-to-receiver`, `pending-adapter` |
| `03-composition-mt202cov.txt` | composition | `swift-mt` ≥ 0.9 | valid | `MT202COV`, `two-sequences`, `option-letters`, `50F`, `59F`, `validation-flag`, `pending-adapter` |
| `04-stress-mt940-statement.txt` | stress | `swift-mt` ≥ 0.9 | valid | `MT940`, `statement-lines`, `transaction-type-codes`, `reversal`, `supplementary-details`, `balances`, `pending-adapter` |
| `05-real-world-mt103-charges-chain.txt` | real-world | `swift-mt` ≥ 0.9 | valid | `MT103`, `cross-currency`, `exchange-rate`, `correspondent-chain`, `charges`, `regulatory-reporting`, `pending-adapter` |
| `06-typical-mt942-interim.txt` | typical | `swift-mt` ≥ 0.9 | valid | `MT942`, `floor-limit`, `summary-counts`, `statement-lines`, `pending-adapter` |
| `07-cover-set/mt103.txt` | multi-file (root) | `swift-mt` ≥ 0.9 | valid | `MT103`, `customer-transfer`, `pending-adapter` |
| `07-cover-set/mt202cov.txt` ⚠ | multi-file (member) | `swift-mt` (no guarantee) | valid | `MT202COV`, `cover-payment`, `field-21-reference`, `pending-adapter` |
| `negative/01-syntactic-unterminated-block4.txt` | — | `swift-mt` (no guarantee) | invalid | `negative`, `syntactic`, `unterminated-block`, `pending-adapter` |
| `negative/02-semantic-no-transaction-reference.txt` | — | `swift-mt` (no guarantee) | invalid | `negative`, `semantic`, `missing-field-20`, `pending-adapter` |
| `negative/03-truncated-mid-field.txt` | — | `swift-mt` (no guarantee) | invalid | `negative`, `truncated`, `mid-field`, `pending-adapter` |
| `negative/04-wrong-format-iso20022.xml` ⚠ | — | `swift-mt` (no guarantee) | invalid | `negative`, `wrong-format`, `iso20022`, `pacs.008`, `pending-adapter` |
| `negative/05-encoding-utf16.txt` | — | `swift-mt` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-unknown-message-type.txt` | — | `swift-mt` (no guarantee) | invalid | `negative`, `semantic`, `unsupported-mt-type`, `free-format`, `pending-adapter` |

> ⚠ **`07-cover-set/mt202cov.txt`** — Fileset member: the cover payment. Field 21 carries the MT103's field 20, which is the only link between the two messages.

> ⚠ **`negative/04-wrong-format-iso20022.xml`** — The MX twin of an MT103. Routing this to the shipped iso20022 adapter rather than claiming it is the whole point of the MT/MX split.

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

### `thunder-client/` — Thunder Client collections (pending #5475)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-collection.json` | minimal | `thunder-client` ≥ 0.9 | valid | `collection`, `single-request`, `pending-adapter` |
| `02-typical-orders-collection.json` | typical | `thunder-client` ≥ 0.9 | valid | `folders`, `containerId`, `collection-auth`, `path-params`, `declarative-tests`, `pending-adapter` |
| `03-environment-set/thunder-collection_inventory.json` | multi-file (root) | `thunder-client` ≥ 0.9 | valid | `multi-file`, `collection`, `environment-variables`, `pending-adapter` |
| `03-environment-set/thunder-environment_staging.json` | multi-file (member) | `thunder-client` (no guarantee) | valid | `multi-file`, `environment-file`, `pending-adapter` |
| `04-stress-bodies-auth-and-tests.json` | stress | `thunder-client` ≥ 0.9 | valid | `json-body`, `formencoded-body`, `formdata-body`, `graphql-body`, `basic-auth`, `oauth2-auth`, `nested-folder`, `disabled-entries`, `preReq`, `test-kinds`, `pending-adapter` |
| `05-real-world-payments-collection.json` | real-world | `thunder-client` ≥ 0.9 | valid | `token-capture`, `idempotency-key`, `auth-override`, `folders`, `json-query-test`, `pending-adapter` |
| `06-typical-environment.json` | typical | `thunder-client` ≥ 0.9 | valid | `environment`, `empty-credentials`, `default-flag`, `pending-adapter` |
| `07-composition-folder-hierarchy.json` | composition | `thunder-client` ≥ 0.9 | valid | `folder-hierarchy`, `containerId-chain`, `settings-inheritance`, `auth-override`, `pending-adapter` |
| `negative/01-syntactic-missing-comma.json` | — | `thunder-client` (no guarantee) | invalid | `negative`, `syntactic`, `missing-comma`, `pending-adapter` |
| `negative/02-semantic-no-requests.json` | — | `thunder-client` (no guarantee) | invalid | `negative`, `semantic`, `no-requests`, `pending-adapter` |
| `negative/03-truncated-mid-request.json` | — | `thunder-client` (no guarantee) | invalid | `negative`, `truncated`, `mid-url`, `pending-adapter` |
| `negative/04-wrong-format-hoppscotch.json` | — | `thunder-client` (no guarantee) | invalid | `negative`, `wrong-format`, `hoppscotch`, `pending-adapter` |
| `negative/05-encoding-utf16.json` | — | `thunder-client` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-orphan-container-id.json` ⚠ | — | `thunder-client` (no guarantee) | invalid | `negative`, `semantic`, `orphan-containerId`, `pending-adapter` |

> ⚠ **`negative/06-semantic-orphan-container-id.json`** — Folders and requests reference container ids that no folder declares, so the hierarchy cannot be reconstructed.

### `tradacoms/` — TRADACOMS (pending #5449)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-order-file.edi` | minimal | `tradacoms` ≥ 0.9 | valid | `ORDHDR`, `ORDERS`, `ORDTLR`, `STX-envelope`, `pending-adapter` |
| `02-typical-order-file.edi` | typical | `tradacoms` ≥ 0.9 | valid | `ORDERS`, `OLD`, `DIN`, `delivery-window`, `trading-party-codes`, `pending-adapter` |
| `03-typical-invoice-file.edi` | typical | `tradacoms` ≥ 0.9 | valid | `INVFIL`, `INVOIC`, `VATTLR`, `INVTLR`, `vat-rate-lines`, `settlement-totals`, `pending-adapter` |
| `04-stress-multi-message-file.edi` | stress | `tradacoms` ≥ 0.9 | valid | `multi-message`, `uncoded-line`, `stx-password`, `application-reference`, `pending-adapter` |
| `05-real-world-grocery-order-file.edi` | real-world | `tradacoms` ≥ 0.9 | valid | `ORDERS`, `gtin`, `case-quantities`, `multi-depot`, `delivery-window`, `pending-adapter` |
| `06-typical-delivery-file.edi` | typical | `tradacoms` ≥ 0.9 | valid | `DELHDR`, `DELIVR`, `DELTLR`, `ordered-vs-delivered`, `pending-adapter` |
| `07-composition-nested-files.edi` | composition | `tradacoms` ≥ 0.9 | valid | `multiple-files-one-transmission`, `ORDERS`, `DELIVR`, `nested-message-structure`, `pending-adapter` |
| `08-transmission-set/ack-file.edi` ⚠ | multi-file (member) | `tradacoms` (no guarantee) | valid | `ACKHDR`, `ACKMNT`, `acknowledgment`, `pending-adapter` |
| `08-transmission-set/order-file.edi` | multi-file (root) | `tradacoms` ≥ 0.9 | valid | `ORDERS`, `transmission`, `pending-adapter` |
| `negative/01-syntactic-missing-equals.edi` | — | `tradacoms` (no guarantee) | invalid | `negative`, `syntactic`, `missing-equals`, `pending-adapter` |
| `negative/02-semantic-no-end-segment.edi` | — | `tradacoms` (no guarantee) | invalid | `negative`, `semantic`, `no-end-segment`, `pending-adapter` |
| `negative/03-truncated-mid-segment.edi` | — | `tradacoms` (no guarantee) | invalid | `negative`, `truncated`, `mid-segment`, `pending-adapter` |
| `negative/04-wrong-format-edifact.edi` ⚠ | — | `tradacoms` (no guarantee) | invalid | `negative`, `wrong-format`, `edifact`, `pending-adapter` |
| `negative/05-encoding-utf16.edi` | — | `tradacoms` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-message-count-mismatch.edi` | — | `tradacoms` (no guarantee) | invalid | `negative`, `semantic`, `sequence-mismatch`, `pending-adapter` |

> ⚠ **`08-transmission-set/ack-file.edi`** — Fileset member: the acknowledgment transmission referring to the order file by its file generation number.

> ⚠ **`negative/04-wrong-format-edifact.edi`** — TRADACOMS must parse as its own structure, not as an EDIFACT interchange — the misroute FMT-6.5 names explicitly.

### `traefik/` — Traefik dynamic config (pending #5459)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-router.yml` | minimal | `traefik` ≥ 0.85 | valid | `router`, `service`, `path-rule`, `pending-adapter` |
| `02-typical-dynamic.yml` | typical | `traefik` ≥ 0.85 | valid | `routers`, `services`, `middlewares`, `entrypoints`, `tls`, `health-check`, `sticky-cookie`, `rate-limit`, `pending-adapter` |
| `03-composition-middleware-chains.yml` | composition | `traefik` ≥ 0.85 | valid | `chain-middleware`, `weighted-service`, `mirroring-service`, `serversTransports`, `tls-options`, `basic-auth`, `pending-adapter` |
| `04-stress-rule-grammar.yml` | stress | `traefik` ≥ 0.85 | valid | `Path`, `PathPrefix`, `PathRegexp`, `Host`, `HostRegexp`, `Header`, `Query`, `ClientIP`, `negation`, `grouping`, `tcp-router`, `udp-router`, `forwardAuth`, `buffering`, `errors`, `pending-adapter` |
| `05-real-world-dynamic.toml` | real-world | `traefik` ≥ 0.85 | valid | `toml`, `redirect-regex`, `cert-domains`, `ip-allowlist`, `priority`, `compress`, `pending-adapter` |
| `06-typical-ingressroute-crd.yaml` | typical | `traefik` ≥ 0.85 | valid | `IngressRoute`, `crd`, `Middleware`, `multi-document`, `pending-adapter` |
| `07-provider-directory-set/middlewares.yml` ⚠ | multi-file (member) | `traefik` (no guarantee) | valid | `middlewares`, `rate-limit`, `stripPrefix`, `pending-adapter` |
| `07-provider-directory-set/routers.yml` | multi-file (root) | `traefik` ≥ 0.85 | valid | `file-provider-directory`, `routers`, `tls`, `pending-adapter` |
| `07-provider-directory-set/services.yml` ⚠ | multi-file (member) | `traefik` (no guarantee) | valid | `services`, `health-check`, `pending-adapter` |
| `negative/01-syntactic-bad-yaml.yml` | — | `traefik` (no guarantee) | invalid | `negative`, `syntactic`, `bad-indentation`, `pending-adapter` |
| `negative/02-semantic-routers-without-rules.yml` | — | `traefik` (no guarantee) | invalid | `negative`, `semantic`, `no-rule`, `no-servers`, `pending-adapter` |
| `negative/03-truncated-mid-service.yml` | — | `traefik` (no guarantee) | invalid | `negative`, `truncated`, `mid-url`, `pending-adapter` |
| `negative/04-wrong-format-nginx.conf` | — | `traefik` (no guarantee) | invalid | `negative`, `wrong-format`, `nginx`, `pending-adapter` |
| `negative/05-encoding-utf16.yml` | — | `traefik` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-service-reference.yml` | — | `traefik` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-service`, `missing-middleware`, `pending-adapter` |

> ⚠ **`07-provider-directory-set/middlewares.yml`** — Fileset member: the middlewares the routers reference by name.

> ⚠ **`07-provider-directory-set/services.yml`** — Fileset member: the services the routers target.

### `trpc/` — tRPC routers (pending #5464)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-router.ts` | minimal | `trpc` ≥ 0.85 | valid | `router`, `query`, `zod-input`, `pending-adapter` |
| `02-typical-order-router.ts` | typical | `trpc` ≥ 0.85 | valid | `query`, `mutation`, `input`, `output`, `typed-context`, `TRPCError`, `pending-adapter` |
| `03-routers-set/customer-router.ts` | multi-file (member) | `trpc` (no guarantee) | valid | `multi-file`, `query`, `pending-adapter` |
| `03-routers-set/order-router.ts` | multi-file (member) | `trpc` (no guarantee) | valid | `multi-file`, `query`, `mutation`, `pending-adapter` |
| `03-routers-set/root.ts` | multi-file (root) | `trpc` ≥ 0.85 | valid | `multi-file`, `router-merge`, `pending-adapter` |
| `03-routers-set/schemas.ts` | multi-file (member) | `trpc` (no guarantee) | valid | `multi-file`, `shared-schemas`, `pending-adapter` |
| `04-stress-procedure-forms.ts` ⚠ | stress | `trpc` ≥ 0.85 | valid | `no-input-query`, `meta`, `middleware`, `chained-input`, `subscription`, `non-zod-validator`, `inline-nested-router`, `pending-adapter` |
| `05-real-world-app-router.ts` | real-world | `trpc` ≥ 0.85 | valid | `session-middleware`, `shared-pagination`, `feature-routers`, `output-schemas`, `error-codes`, `pending-adapter` |
| `06-typical-nested-routers.ts` | typical | `trpc` ≥ 0.85 | valid | `nested-routers`, `operation-groups`, `top-level-procedure`, `pending-adapter` |
| `07-composition-shared-builders.ts` | composition | `trpc` ≥ 0.85 | valid | `shared-schemas`, `middleware-builders`, `router-merge`, `schema-factory`, `pending-adapter` |
| `negative/01-syntactic-unclosed-router.ts` | — | `trpc` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-call`, `pending-adapter` |
| `negative/02-semantic-no-procedures.ts` | — | `trpc` (no guarantee) | invalid | `negative`, `semantic`, `empty-router`, `pending-adapter` |
| `negative/03-truncated-mid-procedure.ts` | — | `trpc` (no guarantee) | invalid | `negative`, `truncated`, `mid-chain`, `pending-adapter` |
| `negative/04-wrong-format-zod.ts` ⚠ | — | `trpc` (no guarantee) | invalid | `negative`, `wrong-format`, `zod`, `pending-adapter` |
| `negative/05-encoding-utf16.ts` | — | `trpc` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-non-zod-input-only.ts` ⚠ | — | `trpc` (no guarantee) | invalid | `negative`, `semantic`, `non-zod-validators`, `pending-adapter` |

> ⚠ **`04-stress-procedure-forms.ts`** — The non-Zod validator and the subscription are the two constructs FMT-8.3 must declare rather than invent a schema for.

> ⚠ **`negative/04-wrong-format-zod.ts`** — Zod schemas with no router: the zod adapter's input, not this one's.

> ⚠ **`negative/06-semantic-non-zod-input-only.ts`** — The FMT-8.3 acceptance case: a router with a non-Zod input must be reported, not turned into an operation with an empty request body.

### `tyk/` — Tyk API definition (pending #5459)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-classic.json` | minimal | `tyk` ≥ 0.85 | valid | `classic`, `listen-path`, `keyless`, `pending-adapter` |
| `02-typical-classic-with-paths.json` | typical | `tyk` ≥ 0.85 | valid | `classic`, `white-list`, `method-actions`, `cache`, `hard-timeouts`, `global-rate-limit`, `pending-adapter` |
| `03-composition-versions-and-middleware.json` | composition | `tyk` ≥ 0.85 | valid | `classic`, `two-versions`, `header-versioning`, `black-list`, `ignored`, `validate-json`, `url-rewrites`, `custom-middleware`, `pending-adapter` |
| `04-stress-oas-extension.json` ⚠ | stress | `tyk` ≥ 0.85 | valid | `tyk-oas`, `x-tyk-api-gateway`, `load-balancing`, `uptime-tests`, `jwt`, `cors`, `per-operation-middleware`, `circuit-breaker`, `mock-response`, `pending-adapter` |
| `05-real-world-payments-classic.json` | real-world | `tyk` ≥ 0.85 | valid | `classic`, `oauth2`, `target-list`, `uptime-tests`, `validate-json`, `circuit-breakers`, `cors`, `response-processors`, `pending-adapter` |
| `06-typical-graphql-proxy.json` | typical | `tyk` ≥ 0.85 | valid | `graphql`, `proxyOnly`, `inline-sdl`, `paradigm-switch`, `pending-adapter` |
| `07-policies-set/api-definition.json` | multi-file (root) | `tyk` ≥ 0.85 | valid | `classic`, `white-list`, `versioned`, `pending-adapter` |
| `07-policies-set/policies.json` ⚠ | multi-file (member) | `tyk` (no guarantee) | valid | `policies`, `quotas`, `access-rights`, `allowed-urls`, `pending-adapter` |
| `negative/01-syntactic-missing-comma.json` | — | `tyk` (no guarantee) | invalid | `negative`, `syntactic`, `missing-comma`, `pending-adapter` |
| `negative/02-semantic-no-listen-path.json` | — | `tyk` (no guarantee) | invalid | `negative`, `semantic`, `no-listen-path`, `pending-adapter` |
| `negative/03-truncated-mid-version.json` | — | `tyk` (no guarantee) | invalid | `negative`, `truncated`, `mid-value`, `pending-adapter` |
| `negative/04-wrong-format-kong.yaml` | — | `tyk` (no guarantee) | invalid | `negative`, `wrong-format`, `kong`, `pending-adapter` |
| `negative/05-encoding-utf16.json` | — | `tyk` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-empty-versions.json` | — | `tyk` (no guarantee) | invalid | `negative`, `semantic`, `empty-versions`, `pending-adapter` |

> ⚠ **`04-stress-oas-extension.json`** — The non-greedy detection case in the positive direction: a real OpenAPI document that this adapter may claim only because of the x-tyk-api-gateway extension.

> ⚠ **`07-policies-set/policies.json`** — Fileset member: quotas, rate limits and per-URL access rights keyed by the api_id in the root.

### `typescript-types/` — TypeScript type declarations (pending #5462)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-model.d.ts` | minimal | `typescript-types` ≥ 0.8 | valid | `interface`, `primitives`, `pending-adapter` |
| `02-typical-order-model.ts` | typical | `typescript-types` ≥ 0.8 | valid | `literal-union`, `optional`, `nullable`, `array`, `readonly`, `Pick`, `Omit`, `pending-adapter` |
| `03-modules-set/customer.d.ts` | multi-file (member) | `typescript-types` (no guarantee) | valid | `multi-file`, `interface`, `pending-adapter` |
| `03-modules-set/index.d.ts` | multi-file (root) | `typescript-types` ≥ 0.8 | valid | `multi-file`, `re-export`, `import-type`, `pending-adapter` |
| `03-modules-set/order.d.ts` | multi-file (member) | `typescript-types` (no guarantee) | valid | `multi-file`, `cross-module-type`, `pending-adapter` |
| `04-stress-type-system.ts` ⚠ | stress | `typescript-types` ≥ 0.8 | valid | `tuple`, `index-signature`, `intersection`, `enum`, `const-enum`, `generic-instantiation`, `conditional-type`, `mapped-type`, `template-literal-type`, `declaration-merging`, `unique-symbol`, `function-type`, `pending-adapter` |
| `05-real-world-api-client-types.d.ts` | real-world | `typescript-types` ≥ 0.8 | valid | `client-package`, `generic-instantiation`, `discriminated-union`, `money`, `pagination`, `pending-adapter` |
| `06-typical-discriminated-unions.ts` | typical | `typescript-types` ≥ 0.8 | valid | `discriminated-union`, `extends`, `indexed-access`, `nested-object`, `pending-adapter` |
| `07-composition-inheritance.ts` | composition | `typescript-types` ≥ 0.8 | valid | `multiple-extends`, `intersection`, `generic-instantiation`, `index-signature`, `pending-adapter` |
| `negative/01-syntactic-missing-brace.ts` | — | `typescript-types` (no guarantee) | invalid | `negative`, `syntactic`, `missing-brace`, `pending-adapter` |
| `negative/02-semantic-no-exported-types.ts` | — | `typescript-types` (no guarantee) | invalid | `negative`, `semantic`, `no-exported-types`, `pending-adapter` |
| `negative/03-truncated-mid-interface.ts` | — | `typescript-types` (no guarantee) | invalid | `negative`, `truncated`, `mid-type-reference`, `pending-adapter` |
| `negative/04-wrong-format-zod.ts` ⚠ | — | `typescript-types` (no guarantee) | invalid | `negative`, `wrong-format`, `zod`, `pending-adapter` |
| `negative/05-encoding-utf16.ts` | — | `typescript-types` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-import.ts` | — | `typescript-types` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-module`, `pending-adapter` |

> ⚠ **`04-stress-type-system.ts`** — Organised as modellable-subset / declared-limits halves; the second half must produce named parsing limits, never `any`.

> ⚠ **`negative/04-wrong-format-zod.ts`** — A Zod module is TypeScript too: the split between this adapter and the zod adapter is the `zod` import plus runtime schema values, not the file extension.

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

### `vsam-idcams/` — VSAM cluster definitions (pending #5484)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-define-cluster.idcams` | minimal | `vsam-idcams` ≥ 0.85 | valid | `define-cluster`, `indexed`, `keys`, `recordsize`, `pending-adapter` |
| `02-typical-ksds.idcams` | typical | `vsam-idcams` ≥ 0.85 | valid | `jcl-wrapper`, `data-index-subdefinitions`, `freespace`, `shareoptions`, `listcat`, `pending-adapter` |
| `03-cluster-and-index-set/alternate-index.idcams` ⚠ | multi-file (member) | `vsam-idcams` (no guarantee) | valid | `multi-file`, `alternate-index`, `path`, `bldindex`, `pending-adapter` |
| `03-cluster-and-index-set/cluster.idcams` | multi-file (root) | `vsam-idcams` ≥ 0.85 | valid | `multi-file`, `base-cluster`, `keys`, `pending-adapter` |
| `04-stress-cluster-forms.idcams` ⚠ | stress | `vsam-idcams` ≥ 0.85 | valid | `ksds`, `esds`, `rrds`, `vrrds`, `lds`, `space-forms`, `sms-classes`, `alternate-index`, `path`, `gdg`, `spanned`, `reuse`, `pending-adapter` |
| `05-real-world-account-cluster.idcams` | real-world | `vsam-idcams` ≥ 0.85 | valid | `delete-define`, `two-alternate-indexes`, `unique-and-nonunique`, `paths`, `bldindex`, `sms-classes`, `pending-adapter` |
| `06-typical-listcat-output.idcams` | typical | `vsam-idcams` ≥ 0.85 | valid | `listcat`, `attributes`, `associations`, `statistics`, `pending-adapter` |
| `07-composition-alternate-index-family.idcams` | composition | `vsam-idcams` ≥ 0.85 | valid | `base-cluster`, `alternate-index-family`, `paths`, `repro`, `bldindex`, `pending-adapter` |
| `negative/01-syntactic-unbalanced-parens.idcams` | — | `vsam-idcams` (no guarantee) | invalid | `negative`, `syntactic`, `unbalanced-parentheses`, `pending-adapter` |
| `negative/02-semantic-indexed-without-keys.idcams` | — | `vsam-idcams` (no guarantee) | invalid | `negative`, `semantic`, `indexed-without-keys`, `no-recordsize`, `pending-adapter` |
| `negative/03-truncated-mid-parameter.idcams` | — | `vsam-idcams` (no guarantee) | invalid | `negative`, `truncated`, `mid-parameter`, `pending-adapter` |
| `negative/04-wrong-format-bms.bms` | — | `vsam-idcams` (no guarantee) | invalid | `negative`, `wrong-format`, `cics-bms`, `pending-adapter` |
| `negative/05-encoding-utf16.idcams` | — | `vsam-idcams` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-unresolvable-relate-target.idcams` | — | `vsam-idcams` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-base-cluster`, `pending-adapter` |

> ⚠ **`03-cluster-and-index-set/alternate-index.idcams`** — Fileset member: KEYS(8 40) describes an offset into the *base* cluster's record, so the two files must be read together.

> ⚠ **`04-stress-cluster-forms.idcams`** — LINEAR datasets have no record structure at all: FMT-11.3 must declare that limit rather than inventing one.

### `wadl/` — WADL

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-bookstore.wadl` | typical | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `params`, `representations` |
| `02-status-ping.wadl` | minimal | `wadl` ≥ 0.95 | valid | `resources`, `methods` |
| `03-nested-catalog.wadl` | composition | `wadl` ≥ 0.95 | valid | `nested-resources`, `template-params`, `grammars`, `representations`, `element-refs` |
| `04-kitchen-sink.wadl` | stress | `wadl` ≥ 0.95 | valid | `params`, `matrix-params`, `header-params`, `status-codes`, `representations`, `doc` |
| `05-yahoo-news-search.wadl` | real-world | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `query-params`, `representations`, `grammars` |
| `06-task-tracker.wadl` | typical | `wadl` ≥ 0.95 | valid | `resources`, `methods`, `params`, `representations` |
| `adversarial/01-billion-laughs.wadl` | — | `wadl` (no guarantee) | adversarial | `adversarial`, `billion-laughs`, `entity-expansion`, `dtd` |
| `negative/01-syntactic-mismatched-close-tag.wadl` | — | `wadl` (no guarantee) | invalid | `negative`, `syntactic`, `mismatched-close-tag` |
| `negative/02-semantic-no-resources.wadl` | — | `wadl` (no guarantee) | invalid | `negative`, `semantic`, `no-resources` |
| `negative/03-truncated-mid-element.wadl` | — | `wadl` (no guarantee) | invalid | `negative`, `truncated`, `mid-element` |
| `negative/04-wrong-format-wsdl-definitions.wsdl` | — | `wadl` (no guarantee) | invalid | `negative`, `wrong-format`, `wsdl-definitions` |
| `negative/05-encoding-utf16-bom.wadl` | — | `wadl` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bom` |

### `wit/` — WIT (WebAssembly Component Model)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-greeter.wit` | minimal | `wit` ≥ 0.9 | valid | `minimal`, `single-interface`, `world` |
| `02-typical-calculator.wit` | typical | `wit` ≥ 0.9 | valid | `typical`, `record`, `enum`, `variant`, `result-type` |
| `03-composition-notifier.wit` | composition | `wit` ≥ 0.9 | valid | `composition`, `cross-interface-use`, `world`, `inline-interface` |
| `04-stress-type-system.wit` ⚠ | stress | `wit` ≥ 0.9 | valid | `stress`, `resource`, `borrow`, `flags`, `tuple`, `type-alias`, `gate-annotations` |
| `05-real-world-keyvalue.wit` ⚠ | real-world | `wit` ≥ 0.9 | valid | `real-world`, `resource`, `borrow`, `variant` |
| `06-package-set/api.wit` ⚠ | multi-file (root) | `wit` ≥ 0.9 | valid | `multi-file`, `package-directory`, `cross-file-use` |
| `06-package-set/service.wit` | multi-file (member) | `wit` ≥ 0.9 | valid | `multi-file`, `package-directory`, `world` |
| `06-package-set/types.wit` | multi-file (member) | `wit` ≥ 0.9 | valid | `multi-file`, `package-directory` |
| `07-emitted-types-only.wit` ⚠ | minimal | `wit` ≥ 0.95 | valid | `emitted`, `types-only`, `record`, `no-world`, `doc-comments` |
| `08-emitted-interface-functions.wit` ⚠ | composition | `wit` ≥ 0.95 | valid | `emitted`, `interface-functions`, `use`, `cross-interface-reference`, `map-approximation` |
| `09-emitted-world-exports.wit` ⚠ | real-world | `wit` ≥ 0.95 | valid | `emitted`, `world`, `export`, `synthesized-world`, `use-alias` |
| `negative/01-syntactic-missing-colon.wit` ⚠ | — | `wit` (no guarantee) | invalid | `negative`, `syntactic` |
| `negative/02-semantic-no-definitions.wit` ⚠ | — | `wit` (no guarantee) | invalid | `negative`, `semantic` |
| `negative/03-truncated-mid-record.wit` | — | `wit` (no guarantee) | invalid | `negative`, `truncated` |
| `negative/04-wrong-format-openapi.yaml` | — | `wit` (no guarantee) | invalid | `negative`, `wrong-format` |
| `negative/05-encoding-utf16.wit` ⚠ | — | `wit` (no guarantee) | invalid | `negative`, `encoding` |

> ⚠ **`04-stress-type-system.wit`** — Resources with methods, borrow/own handles, tuples, and nested results normalize with capability-limit ledger entries (IXH-7.9), never silent drops.

> ⚠ **`05-real-world-keyvalue.wit`** — Modeled after the WASI key-value proposal's interface surface (wasi:keyvalue).

> ⚠ **`06-package-set/api.wit`** — `use order-types.{…}` resolves against the sibling types.wit through the merged package fileset.

> ⚠ **`07-emitted-types-only.wit`** — A schema-only source has no callables, so the package is types only and carries no world; the shared `types` interface is where types belonging to no operation group land.

> ⚠ **`08-emitted-interface-functions.wit`** — An RPC service becomes one interface of `func` items that `use` the shared types interface; the protobuf map field is approximated as `list<tuple<k, v>>`.

> ⚠ **`09-emitted-world-exports.wit`** — A source that declares no world gets one synthesized to export the generated interfaces; the imported `user` type is aliased because the interface already declares a `user` function.

> ⚠ **`negative/01-syntactic-missing-colon.wit`** — Function statement missing the `name: func` colon.

> ⚠ **`negative/02-semantic-no-definitions.wit`** — A lone package declaration with no interfaces or worlds — nothing to import.

> ⚠ **`negative/05-encoding-utf16.wit`** — UTF-16 encoded WIT text; surviving NUL bytes are rejected as a binary/encoding fault.

### `wsdl/` — WSDL 1.1 (SOAP)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-calculator.wsdl` | minimal | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `soap` |
| `02-order-service.wsdl` | typical | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `faults` |
| `03-shared-types-import.wsdl` | composition | `wsdl` ≥ 0.95 | valid | `xsd-import`, `namespaces`, `type-reuse`, `port-type`, `binding` |
| `04-kitchen-sink.wsdl` | stress | `wsdl` ≥ 0.95 | valid | `rpc-style`, `one-way`, `soap12`, `multi-port`, `typed-parts`, `enumeration` |
| `05-global-weather.wsdl` | real-world | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `soap` |
| `06-bank-transfer.wsdl` | typical | `wsdl` ≥ 0.95 | valid | `port-type`, `binding`, `message`, `service`, `faults` |
| `adversarial/01-external-entity-ssrf.wsdl` | — | `wsdl` (no guarantee) | adversarial | `adversarial`, `xxe`, `external-entity`, `ssrf`, `instance-metadata` |
| `adversarial/02-parameter-entity-dtd.wsdl` | — | `wsdl` (no guarantee) | adversarial | `adversarial`, `parameter-entity`, `blind-xxe`, `dtd` |
| `negative/01-syntactic-mismatched-close-tag.wsdl` | — | `wsdl` (no guarantee) | invalid | `negative`, `syntactic`, `mismatched-close-tag` |
| `negative/02-semantic-no-types-or-porttypes.wsdl` | — | `wsdl` (no guarantee) | invalid | `negative`, `semantic`, `no-types-or-porttypes` |
| `negative/03-truncated-mid-element.wsdl` | — | `wsdl` (no guarantee) | invalid | `negative`, `truncated`, `mid-element` |
| `negative/04-wrong-format-wadl-application.wadl` | — | `wsdl` (no guarantee) | invalid | `negative`, `wrong-format`, `wadl-application` |
| `negative/05-encoding-utf16-bom.wsdl` | — | `wsdl` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bom` |

### `wsdl2/` — WSDL 2.0

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-ping.wsdl` | minimal | `wsdl-2.0` ≥ 0.95 | valid | `interface`, `in-out`, `soap-binding`, `endpoint` |
| `02-typical-orders.wsdl` | typical | `wsdl-2.0` ≥ 0.95 | valid | `interface`, `faults`, `in-only`, `safe`, `inline-schema` |
| `03-composition-interface-extension.wsdl` | composition | `wsdl-2.0` ≥ 0.95 | valid | `interface-extends`, `inherited-operations`, `inherited-faults` |
| `04-stress-message-exchange-patterns.wsdl` | stress | `wsdl-2.0` ≥ 0.95 | valid | `in-out`, `in-only`, `robust-in-only`, `in-opt-out`, `out-only`, `http-binding`, `wsoap-mep` |
| `05-real-world-shipment-tracking.wsdl` | real-world | `wsdl-2.0` ≥ 0.95 | valid | `restricted-types`, `enumeration`, `repeated-elements`, `multiple-endpoints` |
| `06-imported-set/invoice.xsd` ⚠ | multi-file (member) | `xsd` (no guarantee) | valid | `multi-file`, `xs-import`, `types` |
| `06-imported-set/service.wsdl` | multi-file (root) | `wsdl-2.0` ≥ 0.95 | valid | `multi-file`, `xs-import`, `interface` |
| `negative/01-syntactic-unclosed-element.wsdl` | — | `wsdl-2.0` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-element` |
| `negative/02-semantic-no-interface.wsdl` | — | `wsdl-2.0` (no guarantee) | invalid | `negative`, `semantic`, `no-interface` |
| `negative/03-truncated-mid-binding.wsdl` ⚠ | — | `wsdl-2.0` (no guarantee) | invalid | `negative`, `truncated`, `mid-attribute` |
| `negative/04-wrong-format-xsd.xsd` | — | `wsdl-2.0` (no guarantee) | invalid | `negative`, `wrong-format`, `xsd` |
| `negative/05-encoding-utf16.wsdl` | — | `wsdl-2.0` (no guarantee) | invalid | `negative`, `encoding`, `utf-16` |
| `negative/06-unresolvable-interface-ref.wsdl` ⚠ | — | `wsdl-2.0` (no guarantee) | invalid | `negative`, `unresolvable-ref`, `missing-interface` |

> ⚠ **`06-imported-set/invoice.xsd`** — Fileset member: the imported schema; on its own it is an XSD, not a WSDL 2.0 description.

> ⚠ **`negative/03-truncated-mid-binding.wsdl`** — Grounded at INPUT_MALFORMED: a document cut mid-attribute is not well-formed XML, so every XML adapter reports it as malformed rather than truncated; the intent is kept in failure_class.

> ⚠ **`negative/06-unresolvable-interface-ref.wsdl`** — The 2.0 unresolvable-interface case FMT-3.3's acceptance criteria call for: binding and service both reference tns:MissingInterface.

### `xml-rpc/` — XML-RPC

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-method-call.xml` | typical | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params`, `struct`, `array` |
| `02-method-response.xml` ⚠ | typical | `xmlrpc` ≥ 0.95 | valid | `method-response`, `params`, `struct`, `fault` |
| `03-minimal-call.xml` | minimal | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params` |
| `04-system-multicall.xml` | composition | `xmlrpc` ≥ 0.95 | valid | `method-call`, `multicall`, `array`, `struct` |
| `05-all-types-response.xml` | stress | `xmlrpc` ≥ 0.95 | valid | `method-response`, `scalar-types`, `base64`, `dateTime.iso8601`, `nil`, `nested-arrays` |
| `06-wordpress-get-post.xml` | real-world | `xmlrpc` ≥ 0.95 | valid | `method-call`, `params`, `array` |
| `adversarial/01-xinclude-file-read.xml` | — | `xmlrpc` (no guarantee) | adversarial | `adversarial`, `xinclude`, `external-reference`, `file-disclosure` |
| `adversarial/02-deep-struct-nesting.xml` | — | `xmlrpc` (no guarantee) | adversarial | `adversarial`, `nesting-depth`, `stack-exhaustion`, `recursive-walker` |
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
| `adversarial/01-billion-laughs.xsd` | — | `xsd` (no guarantee) | adversarial | `adversarial`, `billion-laughs`, `entity-expansion`, `dtd` |
| `adversarial/02-external-entity-file-read.xsd` | — | `xsd` (no guarantee) | adversarial | `adversarial`, `xxe`, `external-entity`, `file-disclosure` |
| `negative/01-syntactic-mismatched-close-tag.xsd` | — | `xsd` (no guarantee) | invalid | `negative`, `syntactic`, `mismatched-close-tag` |
| `negative/02-semantic-no-types-or-elements.xsd` | — | `xsd` (no guarantee) | invalid | `negative`, `semantic`, `no-types-or-elements` |
| `negative/03-truncated-mid-element.xsd` | — | `xsd` (no guarantee) | invalid | `negative`, `truncated`, `mid-element` |
| `negative/04-wrong-format-openapi-document.json` | — | `xsd` (no guarantee) | invalid | `negative`, `wrong-format`, `openapi-document` |
| `negative/05-encoding-utf16-bom.xsd` | — | `xsd` (no guarantee) | invalid | `negative`, `encoding`, `utf16-bom` |

### `zod/` — Zod schemas (pending #5463)

| File | Rung | Expected detection | Class | Features |
| --- | --- | --- | --- | --- |
| `01-minimal-schema.ts` | minimal | `zod` ≥ 0.85 | valid | `object`, `primitives`, `pending-adapter` |
| `02-typical-order-schemas.ts` | typical | `zod` ≥ 0.85 | valid | `regex`, `bounds`, `enum`, `default`, `array-cardinality`, `pick`, `infer`, `pending-adapter` |
| `03-modules-set/index.ts` | multi-file (root) | `zod` ≥ 0.85 | valid | `multi-file`, `cross-module-schema`, `pending-adapter` |
| `03-modules-set/order-line.ts` | multi-file (member) | `zod` (no guarantee) | valid | `multi-file`, `cross-module-schema`, `pending-adapter` |
| `03-modules-set/shared.ts` | multi-file (member) | `zod` (no guarantee) | valid | `multi-file`, `shared-schemas`, `pending-adapter` |
| `04-stress-constraint-coverage.ts` ⚠ | stress | `zod` ≥ 0.85 | valid | `string-constraints`, `number-constraints`, `tuple`, `record`, `set`, `map`, `strict`, `passthrough`, `catchall`, `discriminatedUnion`, `nativeEnum`, `refine`, `superRefine`, `transform`, `preprocess`, `brand`, `pipe`, `custom`, `function-schema`, `pending-adapter` |
| `05-real-world-api-validation.ts` | real-world | `zod` ≥ 0.85 | valid | `request-validation`, `response-validation`, `coerce`, `discriminatedUnion`, `shared-value-schemas`, `pending-adapter` |
| `06-typical-recursive-and-lazy.ts` | typical | `zod` ≥ 0.85 | valid | `lazy`, `recursion`, `json-value-union`, `self-reference`, `pending-adapter` |
| `07-composition-schema-reuse.ts` | composition | `zod` ≥ 0.85 | valid | `merge`, `extend`, `pick`, `omit`, `partial`, `discriminatedUnion`, `schema-factory`, `pending-adapter` |
| `negative/01-syntactic-unclosed-call.ts` | — | `zod` (no guarantee) | invalid | `negative`, `syntactic`, `unclosed-call`, `pending-adapter` |
| `negative/02-semantic-no-exported-schemas.ts` | — | `zod` (no guarantee) | invalid | `negative`, `semantic`, `private-schemas`, `pending-adapter` |
| `negative/03-truncated-mid-schema.ts` | — | `zod` (no guarantee) | invalid | `negative`, `truncated`, `mid-chain`, `pending-adapter` |
| `negative/04-wrong-format-typescript-types.ts` | — | `zod` (no guarantee) | invalid | `negative`, `wrong-format`, `typescript-types`, `pending-adapter` |
| `negative/05-encoding-utf16.ts` | — | `zod` (no guarantee) | invalid | `negative`, `encoding`, `utf-16`, `pending-adapter` |
| `negative/06-semantic-throws-on-import.ts` ⚠ | — | `zod` (no guarantee) | invalid | `negative`, `semantic`, `throws-on-import`, `sandbox`, `pending-adapter` |

> ⚠ **`04-stress-constraint-coverage.ts`** — Split into a modellable half and a declared-limits half; refine/transform/brand/custom must surface as named limits.

> ⚠ **`negative/06-semantic-throws-on-import.ts`** — The FMT-8.2 acceptance case for sandboxed evaluation: a module that throws must fail the job cleanly inside the time budget.

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
| `asn1` | multi-file | Asn1ImportSource.parse_fileset only parses the root member (and the parser rejects more than one module per document), so cross-member resolution genuinely does not exist. |
| `capnproto` | multi-file | CapnpImportSource.parse_fileset only parses the fileset root and never resolves imported members, so a multi-file set demonstrates nothing beyond a single file. |
| `cloudevents` | multi-file | CloudEventsImportSource.parse_fileset parses only the root member and resolves nothing across files, so a genuine multi-file set is not importable. |
| `cobolcopybook` | multi-file | COBOL COPY statements are not resolved and the cobolcopybook adapter's parse_fileset parses only the root member, so a multi-file set demonstrates nothing. |
| `corbaidl` | multi-file | CorbaIdlImportSource.parse_fileset only parses the fileset root and never resolves other members (and is_corbaidl rejects any text containing an include directive), so a multi-file set demonstrates nothing beyond a single file. |
| `discovery` | multi-file | DiscoveryImportSource.parse_fileset only parses the root member and Discovery documents do not resolve cross-file $ref targets, so a multi-file set exercises nothing. |
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
| `k8s-crd` | multi-file | K8sCrdImportSource.parse_fileset only parses the root member and CRD structural schemas do not resolve cross-file references; multi-document YAML streams (k8s-crd/06-multi-crd-stream.yaml) cover multi-entity intake instead. |
| `llm-tools` | multi-file | LlmToolsImportSource.parse_fileset only parses the root member and tool bundles do not resolve cross-file references, so a multi-file set demonstrates nothing beyond a single document. |
| `oncrpc` | multi-file | The ONC RPC adapter's parse_fileset only parses the root document and does not resolve references across fileset members, so a multi-file set would exercise nothing. |
| `openrpc` | multi-file | The openrpc adapter's parse_fileset only parses the root member and does not resolve external $ref targets in other members, so a multi-file set exercises nothing. |
| `raml` | multi-file | The RAML adapter's parse_fileset only parses the root document and never resolves !include or library references across fileset members, so a multi-file set would exercise nothing beyond a single file. |
| `smithy` | multi-file | The smithy adapter's parse_fileset parses only the root member and never resolves shapes defined in other members, so a multi-file set demonstrates nothing. |
| `thrift` | multi-file | ThriftImportSource.parse_fileset only parses the fileset root and never resolves included members, so a multi-file set demonstrates nothing beyond a single file. |
| `typespec` | multi-file | The typespec adapter's parse_fileset parses only the root member and does not resolve relative import statements across members, so a multi-file set demonstrates nothing. |
| `wadl` | multi-file | parse_fileset in wadl_import_source.py parses only the root member and never resolves references into other members (verified in source), so a multi-file set adds no coverage. |
| `xmlrpc` | multi-file | XmlRpcImportSource.parse_fileset parses only the root member and XML-RPC has no cross-file reference mechanism, so a genuine multi-file set is not importable. |
| `xsd` | multi-file | parse_fileset in xsd_import_source.py parses only the root member; xs:include/xs:import across members is never resolved (verified in source), so a multi-file set adds no coverage. |
| `zosconnect` | multi-file | The zosconnect adapter's parse_fileset only parses the root member and resolves no cross-file references (copybook structures are name references only), so a multi-file set exercises nothing. |

## Provenance and licensing

Every entry declares where its bytes came from (`origin`), under what license, and — for payloads captured from a real system — how they were anonymized. See the [corpus contributor guide](../../docs/CORPUS_CONTRIBUTOR_GUIDE.md); `scripts/check_corpus_provenance.py` enforces the rules in CI.

| Origin | Files | Licenses |
| --- | --- | --- |
| `hand-authored` | 1421 | `Apache-2.0` |

## Trying an import

In the ADE dashboard, open **Import**, pick **File Upload** (or **Clipboard Paste**), and drop one of these files. Detection names the format and the import lands as a catalog item (OpenAPI/Swagger/Arazzo route to publishable Projects).
