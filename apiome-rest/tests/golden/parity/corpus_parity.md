# Corpus parity report

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: cd apiome-rest && uv run python scripts/generate_corpus_parity_report.py -->

Every shipped, non-preview import adapter must carry four artifacts: corpus examples (at least one valid and one negative), a golden snapshot directory, a round-trip matrix row, and a `format_capability_registry` entry. This report is what the FMT-1.4 parity gate (`apiome-rest/tests/test_corpus_parity.py`) asserts.

- **Formats gated:** 50
- **Formats with an unwaived gap:** 0
- **Formats with a waived requirement:** 0

## Fixture counts

| Format | Label | Paradigm | Valid | Negative | Adversarial | Scale | Total | Rungs | Goldens | Emitter |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---|
| `apiblueprint` | API Blueprint | rest | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `apiblueprint` |
| `arazzo` | Arazzo | rest | 14 | 11 | 0 | 0 | 25 | 6/6 | 13 | `arazzo` |
| `arrow` | Apache Arrow | data_schema | 10 | 7 | 0 | 0 | 17 | 6/6 | 9 | — |
| `asn1` | ASN.1 | data_schema | 7 | 5 | 0 | 0 | 12 | 5/6 (+1 waived) | 6 | `asn1` |
| `asyncapi` | AsyncAPI | event | 9 | 5 | 0 | 0 | 14 | 6/6 | 7 | `asyncapi` |
| `avro` | Avro | data_schema | 14 | 11 | 0 | 0 | 25 | 6/6 | 12 | `avro` |
| `capnproto` | Cap'n Proto | rpc | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `capnproto` |
| `cddl` | CDDL | data_schema | 8 | 6 | 0 | 0 | 14 | 6/6 | 7 | `cddl` |
| `cloudevents` | CloudEvents | event | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 5 | `cloudevents` |
| `cobolcopybook` | COBOL Copybook | data_schema | 8 | 5 | 0 | 0 | 13 | 5/6 (+1 waived) | 8 | `cobolcopybook` |
| `connectrpc` | Connect RPC | rpc | 7 | 5 | 0 | 0 | 12 | 6/6 | 6 | `connectrpc` |
| `corbaidl` | CORBA IDL | rpc | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `corbaidl` |
| `dbt` | dbt Project | data_schema | 10 | 6 | 0 | 0 | 16 | 6/6 | 7 | — |
| `discovery` | Google API Discovery | rest | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | — |
| `dtd` | DTD | data_schema | 9 | 6 | 0 | 0 | 15 | 6/6 | 7 | — |
| `edix12` | EDI X12 | data_schema | 7 | 5 | 0 | 0 | 12 | 5/6 (+1 waived) | 7 | `edix12` |
| `fhir` | FHIR | rest | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `fhir` |
| `fix` | FIX | data_schema | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 5 | `fix` |
| `flatbuffers` | FlatBuffers | data_schema | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `flatbuffers` |
| `gateway-api` | Gateway API HTTPRoute | rest | 8 | 5 | 0 | 0 | 13 | 6/6 | 6 | `gateway-api` |
| `graphql` | GraphQL | graph | 18 | 5 | 0 | 0 | 23 | 6/6 | 14 | `graphql` |
| `grpc` | gRPC / Protobuf | rpc | 18 | 13 | 0 | 0 | 31 | 6/6 | 16 | `protobuf` |
| `hl7v2` | HL7 v2 | data_schema | 6 | 5 | 0 | 0 | 11 | 4/6 (+2 waived) | 6 | `hl7v2` |
| `http-file` | HTTP Request File | rest | 10 | 5 | 0 | 0 | 15 | 6/6 | 8 | `http-file` |
| `iso20022` | ISO 20022 | data_schema | 6 | 5 | 1 | 0 | 12 | 5/6 (+1 waived) | 6 | `iso20022` |
| `iso8583` | ISO 8583 | data_schema | 6 | 5 | 0 | 0 | 11 | 4/6 (+2 waived) | 6 | `iso8583` |
| `json-schema` | JSON Schema | data_schema | 12 | 5 | 0 | 0 | 17 | 5/6 (+1 waived) | 12 | `json-schema` |
| `jtd` | JSON Type Definition | data_schema | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `jtd` |
| `k8s-crd` | Kubernetes CRD | data_schema | 7 | 5 | 0 | 0 | 12 | 5/6 (+1 waived) | 7 | `k8s-crd` |
| `kafka-connect` | Kafka Connect Schema | data_schema | 9 | 6 | 0 | 0 | 15 | 6/6 | 7 | `kafka-connect` |
| `kong` | Kong Declarative Config | rest | 7 | 5 | 0 | 0 | 12 | 6/6 | 6 | `kong` |
| `llm-tools` | LLM Tools | agent | 8 | 5 | 0 | 0 | 13 | 5/6 (+1 waived) | 8 | `llm-tools` |
| `mcp` | MCP Server Manifest | agent | 7 | 5 | 0 | 0 | 12 | 6/6 | 6 | — |
| `odata` | OData | rest | 14 | 11 | 1 | 0 | 26 | 6/6 | 13 | `odata` |
| `odcs` | ODCS Data Contract | data_schema | 9 | 6 | 0 | 0 | 15 | 6/6 | 7 | `odcs` |
| `oncrpc` | ONC RPC | rpc | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `oncrpc` |
| `openapi` | OpenAPI / Swagger | rest | 47 | 12 | 0 | 0 | 59 | 6/6 | 42 | `openapi` |
| `openrpc` | OpenRPC | rpc | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `openrpc` |
| `postman` | Postman | rest | 13 | 11 | 0 | 0 | 24 | 6/6 | 12 | `postman` |
| `raml` | RAML | rest | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `raml` |
| `relaxng` | RELAX NG | data_schema | 9 | 6 | 0 | 0 | 15 | 6/6 | 7 | — |
| `smithy` | Smithy | rpc | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `smithy` |
| `thrift` | Thrift | rpc | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `thrift` |
| `typespec` | TypeSpec | rest | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `typespec` |
| `wadl` | WADL | rest | 6 | 5 | 1 | 0 | 12 | 5/6 (+1 waived) | 6 | `wadl` |
| `wit` | WIT (WebAssembly) | rpc | 11 | 5 | 0 | 0 | 16 | 6/6 | 9 | `wit` |
| `wsdl` | WSDL | rest | 13 | 11 | 2 | 0 | 26 | 6/6 | 12 | `wsdl` |
| `xmlrpc` | XML-RPC | rpc | 6 | 5 | 2 | 0 | 13 | 5/6 (+1 waived) | 6 | `xmlrpc` |
| `xsd` | XSD | data_schema | 6 | 5 | 2 | 0 | 13 | 5/6 (+1 waived) | 6 | `xsd` |
| `zosconnect` | z/OS Connect | rest | 6 | 5 | 0 | 0 | 11 | 5/6 (+1 waived) | 6 | `zosconnect` |

## Required artifacts

✅ present · ⚠️ waived with a reason · ❌ missing (this is what fails the gate).

| Format | Valid examples | Negative examples | Golden snapshots | Round-trip row | Capability entry |
|---|:-:|:-:|:-:|:-:|:-:|
| `apiblueprint` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `arazzo` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `arrow` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `asn1` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `asyncapi` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `avro` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `capnproto` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cddl` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cloudevents` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cobolcopybook` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `connectrpc` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `corbaidl` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `dbt` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `discovery` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `dtd` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `edix12` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fhir` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fix` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `flatbuffers` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gateway-api` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `graphql` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `grpc` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `hl7v2` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `http-file` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `iso20022` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `iso8583` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `json-schema` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `jtd` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `k8s-crd` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `kafka-connect` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `kong` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `llm-tools` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `mcp` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `odata` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `odcs` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `oncrpc` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `openapi` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `openrpc` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `postman` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `raml` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `relaxng` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `smithy` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `thrift` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `typespec` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `wadl` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `wit` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `wsdl` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `xmlrpc` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `xsd` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `zosconnect` | ✅ | ✅ | ✅ | ✅ | ✅ |

## Gaps

None — every gated format carries all four artifacts.

## Waived requirements

None.

## Not gated

| Registry key | Why it is exempt |
|---|---|
| `sample` | internal machinery, not a format a user can import |

## Corpus directories awaiting an adapter

Fixtures staged ahead of the adapter that will claim them (`adapter_key: null`). They are not gated until an adapter registers, at which point every requirement above applies.

`apigee`, `aws-apigateway`, `azure-apim`, `cics-bms`, `consul`, `cue`, `dhall`, `dicom`, `edifact`, `envoy-xds`, `fix-orchestra`, `haproxy`, `hl7v3`, `hoppscotch`, `idoc`, `ims`, `istio`, `jsonld`, `lwm2m`, `matter`, `nacha`, `natural-ddm`, `ncpdp`, `nginx`, `opcua-nodeset`, `owl`, `pkl`, `pli`, `pydantic`, `ros2`, `schematron`, `sepa`, `shacl`, `soapui`, `sparkplug`, `sql-ddl`, `swift-mt`, `thunder-client`, `tradacoms`, `traefik`, `trpc`, `tyk`, `typescript-types`, `vsam-idcams`, `zod`
