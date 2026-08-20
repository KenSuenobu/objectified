# ROS 2 interfaces — `ros2`

Fixtures for **FMT-9.3** ([#5470](https://github.com/apiome/apiome/issues/5470)). **AsyncAPI 3.1.0
added ROS 2 bindings in January 2026** — the ecosystem is moving toward standards Apiome already
speaks, and reading the native files makes Apiome the bridge. Entries carry `adapter_key: null` and
the `pending-adapter` tag.

**Three file kinds, one grammar.**

| Extension | Shape | Canonical target |
| --- | --- | --- |
| `.msg` | fields and constants | a type |
| `.srv` | request `---` response | an `rpc` request/response operation |
| `.action` | goal `---` result `---` feedback | a goal operation **plus** a feedback channel |

**Field grammar.** `<type> <name> [default]`, `<TYPE> <NAME>=<value>` for constants, arrays as
`T[]` (unbounded), `T[N]` (fixed) and `T[<=N]` (bounded), bounded strings as `string<=N`, and type
references as either a bare name (same package) or `package/Type`.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-message.msg` | minimal | Two primitive fields. |
| `02-typical-sensor-message.msg` | typical | Constants as enum members, a `std_msgs/Header`, unbounded arrays, comments as documentation. |
| `03-package-set/` | multi-file | An interface package: `package.xml` plus a message that references a **sibling by bare name** and a service that references both. |
| `04-stress-idl-grammar.msg` | stress | Every primitive and constant form, `wstring`, bounded strings, fixed/bounded/unbounded arrays, array defaults, cross-package references. |
| `05-real-world-navigate-to-pose.action` | real-world | A navigation action: goal with defaults, result with error-code constants and a `Duration`, feedback with progress fields. |
| `06-typical-service.srv` | typical | Request/response with result-code constants. |
| `07-composition-nested-messages.msg` | composition | A message composed of same-package and cross-package types, including a bounded array of a composed type. |
| `negative/` | — | A malformed field line, a message with no fields, a truncated `.action`, a **protobuf** schema, UTF-16, and references to a package and a local type that do not exist. |

**Cross-package resolution.** Bare-name references resolve **within the fileset**; anything else is a
declared unresolved reference — never an opaque field.
