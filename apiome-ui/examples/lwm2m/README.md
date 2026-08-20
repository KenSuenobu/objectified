# LwM2M / IPSO object definitions — `lwm2m`

Fixtures for the LwM2M half of **FMT-9.5** ([#5472](https://github.com/apiome/apiome/issues/5472)).
Device models are the interface descriptions of consumer and industrial IoT devices; the Matter half
lives in `matter/`. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** Root element `LWM2M` containing `<Object ObjectType="MODefinition">` with
`ObjectID` / `ObjectURN` and a `Resources` list of `<Item ID="…">`.

**Mapping**

| LwM2M | Canonical |
| --- | --- |
| `Object` | type (paradigm `data_schema`, with `rpc` operations for executables) |
| `Resources/Item` with `R`, `W` or `RW` | property |
| `Operations` | access mode: `R` read-only, `W` write-only, `RW` read-write |
| `Operations = E` | **`rpc` operation**, not a property |
| `MultipleInstances = Multiple` | array |
| `Mandatory` | required |
| `Type` | scalar type (`Objlnk` is a reference) |
| `RangeEnumeration` | numeric range, length range, or enum |
| `Units` | unit metadata |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-object.xml` | minimal | One object, one read-only string resource. |
| `02-typical-ipso-temperature.xml` | typical | An IPSO smart object: sensor value with units, min/max measured values, an executable reset. |
| `03-composition-multi-object-file.xml` | composition | Two objects in one file linked by an `Objlnk` resource — neither is complete alone. |
| `04-stress-resource-forms.xml` | stress | Every resource type (`String`, `Integer`, `Unsigned Integer`, `Float`, `Boolean`, `Opaque`, `Time`, `Objlnk`, `Corelnk`), every operation set including write-only and executable, single vs multiple instances, ranges and enumerations. |
| `05-real-world-device-object.xml` | real-world | The Device object: identification, multi-instance power sources and error codes, reboot and factory-reset actions, timezone. |
| `06-typical-firmware-update-object.xml` | typical | Firmware Update: a write-only `Opaque` package, a URI, an executable trigger, and two state enums. |
| `07-object-registry-set/` | multi-file | The registry convention: one file per object, linked by `Objlnk` resources. |
| `negative/` | — | Unclosed item, an object with an empty `Resources`, truncation, a **Matter cluster** (the sibling format), UTF-16, and resources with an unknown `Type` and an invalid `Operations` value. |

**Registry crawling is out of scope.** FMT-9.5 reads supplied definition files; pulling the public
LwM2M and Matter registries is deferred to the registry-as-source seam (**#3978**).
