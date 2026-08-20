# OPC UA NodeSet2 — `opcua-nodeset`

Fixtures for **FMT-9.1** ([#5468](https://github.com/apiome/apiome/issues/5468)) — the information
model of industrial automation: object types, variable types, data types, methods and the reference
graph a factory's machines expose. It is a genuine, formal interface description, its owners are large
manufacturers, and no API catalog on the market reads it. Entries carry `adapter_key: null` and the
`pending-adapter` tag.

**Detection marker.** Root element `UANodeSet` in
`http://opcfoundation.org/UA/2011/03/UANodeSet.xsd`.

**Normalization contract**

| NodeSet2 | Canonical |
| --- | --- |
| `UAObjectType` / `UAVariableType` | type |
| `UADataType` with `<Definition>` fields | record, or enum when the fields carry `Value` |
| `UAMethod` + its `InputArguments` / `OutputArguments` properties | `rpc` operation with request/response |
| `References` graph | relationships |
| `NamespaceUris`, `Models`/`RequiredModel` | provenance |
| `UAObject` / `UAVariable` **instances** | payload analysis only — **never promoted to canonical types** |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-nodeset.xml` | minimal | One object type with one component variable. |
| `02-typical-machine-type.xml` | typical | Enum data type, object type with components and a property, a method with `InputArguments`, a `Models` block with a required model. |
| `03-composition-subtypes.xml` | composition | An abstract base type with two subtypes, a custom `UAReferenceType` with an inverse name, a `UAVariableType` with its own property, mandatory vs optional modelling rules. |
| `04-stress-datatypes-and-methods.xml` | stress | Enumerated, **option-set**, structured (with optional and array fields) and **union** data types; a two-dimensional array variable with `AccessLevel`/`Historizing`; a method with both input and output arguments; a method with none; an encoding object. |
| `05-real-world-companion-nodeset.xml` | real-world | A companion-specification-shaped model: state enum, counters structure, identification sub-object, analog item with engineering units, two methods. |
| `06-typical-instance-address-space.xml` | typical | Instances only — a plant/line/machine hierarchy with a live value. The fixture that proves instances stay in the payload analysis. |
| `07-companion-set/` | multi-file | A vendor nodeset whose `RequiredModel` supplies the base type and data type it subtypes. |
| `negative/` | — | Unclosed node, a nodeset with no nodes, truncation, an **XSD**, UTF-16, and references to node ids that no node declares. |

**Bounded by design.** The reference graph is preserved in the payload analysis and **bounded by the
analyzer's node budget**; a nodeset that exceeds it must report `partial` / `bounds_exceeded` rather
than truncating silently. That over-budget case is generated at test time, not committed here.
