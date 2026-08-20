# Matter cluster and device-type definitions — `matter`

Fixtures for the Matter half of **FMT-9.5** ([#5472](https://github.com/apiome/apiome/issues/5472)).
The LwM2M half lives in `lwm2m/`. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection markers.** Root element `configurator` containing `<cluster>` (with `name`, `code`,
`define`) or `<deviceType>` (with `deviceId`, `clusters/include`).

**Mapping**

| Matter | Canonical |
| --- | --- |
| `cluster` | type |
| `attribute` | property (type from `type`/`entryType`, `writable`/`access` → access mode, `isNullable` → nullability, `min`/`max`/`length` → constraints) |
| `command source="client"` | `rpc` operation; its `response` attribute names the reply command |
| `command source="server"` | response type |
| `event` | event with a priority |
| `enum` / `bitmap` | enum / flag set |
| `struct` | nested type |
| `deviceType` + `clusters/include` | composition: a device is a set of clusters with required members |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-cluster.xml` | minimal | One attribute, one command with one argument. |
| `02-typical-onoff-cluster.xml` | typical | Enum and bitmap declarations bound to the cluster, optional and nullable attributes with defaults, five commands. |
| `03-device-type-set/` | multi-file | A **device type** plus the two cluster definitions its `include` elements name — the composition only resolves across the set. |
| `04-stress-structs-enums-bitmaps.xml` | stress | Structs (including a struct field that is an array of structs), features with conformance, list-typed attributes, per-operation `access` privileges, a command/response pair, and events at three priorities. |
| `05-real-world-thermostat-cluster.xml` | real-world | The Thermostat cluster: setpoints with min/max and defaults, mode enums, running-state bitmap, schedule commands with a response. |
| `06-typical-events-and-access.xml` | typical | Basic Information: identity attributes with write privileges, a struct-typed attribute, and four lifecycle events. |
| `07-composition-derived-cluster.xml` | composition | A struct built from two structs, reused across a base cluster and a derived one. |
| `negative/` | — | Unclosed cluster, a cluster with no members, truncation, an **LwM2M object** (the sibling format), UTF-16, and an attribute and command argument whose types are never declared. |
