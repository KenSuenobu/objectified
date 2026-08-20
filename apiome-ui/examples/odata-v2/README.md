# OData v2 / v3 (CSDL) — `odata-v2`

Fixtures for **FMT-3.4** ([#5429](https://github.com/apiome/apiome/issues/5429)) — the CSDL versions
SAP Gateway and older Dynamics deployments emit. The shipped `odata/` corpus is **v4**
(`http://docs.oasis-open.org/odata/ns/edm`); v2 and v3 use different EDM namespaces and describe
relationships with `Association`/`AssociationSet` instead of v4 navigation properties, so they live
here until the adapter reads them. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection markers.**

| Version | `edmx` namespace | `Schema` namespace |
| --- | --- | --- |
| v2 | `…/ado/2007/06/edmx` | `…/ado/2008/09/edm` |
| v3 | `…/ado/2009/11/edmx` | `…/ado/2009/11/edm` |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-v2-single-entity.xml` | minimal | One entity type, one key, one entity set. |
| `02-typical-v2-orders.xml` | typical | Two associations with a referential constraint, a compound key, a `FunctionImport`. |
| `03-composition-v3-inheritance.xml` | composition | v3 `BaseType` inheritance, abstract entity, `ComplexType`, `EnumType`. |
| `04-stress-v2-customizable-feeds.xml` | stress | `FC_TargetPath`/`FC_ContentKind`/`FC_KeepInContent` (no v4 analogue — must land in extras), `m:HasStream`, the full v2 primitive set including `Edm.Time`. |
| `05-real-world-sap-gateway-service.xml` | real-world | SAP-shaped `$metadata`: `sap:label`, `sap:creatable`/`updatable`/`deletable`, `sap:semantics`, `sap:unit`, `sap:action-for`. |
| `06-typical-v3-catalog.xml` | typical | A v3 service with `IsSideEffecting` on a function import. |
| `07-referenced-set/` | multi-file | v3 `edmx:Reference`/`edmx:Include` pulling a `ComplexType` from a sibling document. |
| `negative/` | — | Unclosed entity type, no entity container, truncation, a WSDL 1.1 document, UTF-16, and a navigation property whose `Relationship` names an undeclared association. |

**Contract the adapter must meet.** v2, v3 and v4 all import and record their version; associations
normalize to the same canonical relationships v4 navigation properties produce; v4 goldens are
unchanged; constructs with no v4 analogue are carried in extras rather than discarded.
