# WSDL 2.0 — `wsdl2`

Fixtures for **FMT-3.3** ([#5428](https://github.com/apiome/apiome/issues/5428)) — the import half of
WSDL 2.0. The shipped `wsdl/` corpus is WSDL **1.1** (`<wsdl:definitions>`, `portType`, `message`);
2.0 is a different vocabulary (`<description>`, `interface`, `binding`/`endpoint`, MEP URIs) under
the `http://www.w3.org/ns/wsdl` namespace, so it lives here until the adapter reads it. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** Root element `description` in the `http://www.w3.org/ns/wsdl` namespace.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-ping.wsdl` | minimal | One in-out operation, one SOAP binding, one endpoint. |
| `02-typical-orders.wsdl` | typical | Three operations, an interface-level fault, `wsdlx:safe`, inline schema. |
| `03-composition-interface-extension.wsdl` | composition | `interface/@extends` — inherited operations and faults must flatten onto the derived interface. |
| `04-stress-message-exchange-patterns.wsdl` | stress | in-out, in-only, robust-in-only, in-opt-out, out-only, plus an HTTP binding with `whttp:method`/`whttp:location` and a SOAP binding with `wsoap:mep`. |
| `05-real-world-shipment-tracking.wsdl` | real-world | Carrier-shaped tracking service: restricted simple types, repeated elements, two endpoints. |
| `06-imported-set/` | multi-file | `xs:import` of a sibling `.xsd` — the types are only resolvable across the set. |
| `negative/` | — | Unclosed element, a document with no interface, truncation, a bare XSD, UTF-16, and a binding/service pointing at a **missing interface** (the unresolvable-ref case FMT-3.3 names explicitly). |

**Contract the adapter must meet.** A 2.0 document must normalize to the same canonical shape a
semantically equivalent 1.1 document produces, with the version recorded in provenance and each MEP
mapped to the right `OperationKind`. WSDL 2.0 *output* is a separate ticket (**#4182**).
