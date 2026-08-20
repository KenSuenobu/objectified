# FIX Orchestra — `fix-orchestra`

Fixtures for **FMT-6.9** ([#5453](https://github.com/apiome/apiome/issues/5453)). The shipped `fix`
adapter reads `tag=value` **messages** and *infers* a field schema from them; Orchestra is the
machine-readable **specification** — an XML repository of message definitions, field types, code sets,
components, groups, actors, flows and state machines. Reading it turns inference into fact, which in
capital markets is the difference between a sample and a contract. Entries carry `adapter_key: null`
and the `pending-adapter` tag.

**Detection marker.** Root `repository` in `http://fixprotocol.io/2020/orchestra/repository`.

**Presence is the whole point.** `presence` on a `fieldRef`/`componentRef`/`groupRef` is not a
boolean:

| `presence` | Canonical meaning |
| --- | --- |
| `required` | non-nullable |
| `optional` | nullable |
| `conditional` | nullable **plus** a rule with a `when` expression |
| `forbidden` | a **declared constraint** — the field must be modelled and marked disallowed, never dropped |
| `ignored` | accepted but never acted on |
| `constant` | fixed value, carried as a constraint |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-repository.xml` | minimal | One code set, two fields, one message. |
| `02-typical-order-repository.xml` | typical | Datatypes, three code sets, a component, two messages, field documentation, metadata. |
| `03-composition-components-and-groups.xml` | composition | A repeating group containing another repeating group, `numInGroup`, `componentRef`/`groupRef`. |
| `04-stress-presence-and-rules.xml` | stress | Every `presence` value, conditional rules with `when` expressions, two **scenarios** of the same message, `responses`. |
| `05-real-world-execution-flow.xml` | real-world | A venue's rules of engagement: order entry and execution flows, actors, conditional trade fields, cancel-reject reasons. |
| `06-typical-actors-and-state-machine.xml` | typical | `actors`, `flow` reliability, and a `states`/`transition` order-state machine. |
| `07-modular-set/` | multi-file | A repository that pulls its code sets in with XInclude from a shared library file. |
| `negative/` | — | Unclosed message, a repository with no messages, truncation, a **`tag=value` FIX message log** (what the shipped `fix` adapter reads), UTF-16, and refs to a field and component that do not exist. |

**Cross-links.** The Orchestra **emitter** is filed as **#4323**; coordinate the type model with it.
An Orchestra-derived item should link to message-derived `fix` items where the message type matches —
the shipped corpus's `fix/02-orchestra.xml` is the same family and is currently a recorded
known-detection-bug fixture.
