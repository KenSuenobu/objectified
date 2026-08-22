# CDDL (RFC 8610) — `cddl`

Fixtures for **FMT-4.4** ([#5437](https://github.com/apiome/apiome/issues/5437)) — the Concise Data
Definition Language that describes CBOR and JSON structures. It is the schema language of COSE,
WebAuthn/FIDO, the EU Digital Identity Wallet and a large slice of IETF IoT work: the binary-schema
gap beside ASN.1. **Live** — the `cddl` adapter reads a grammar or a fileset and the `cddl` emitter
writes one back, and every entry here is exercised by the corpus suites.

**Detection marker.** `name = { … }` / `name = [ … ]` rule assignments *plus* something only CDDL
has — a prelude type (`tstr`/`bstr`/`uint`/`nint`/`nil`) or one of its own operators (`=>`, `/=`,
`//=`, `#6.`, `.size`, `.regexp`, `.cbor`, `.bits`, `.within`). An assignment alone is shared with a
dozen configuration languages and is deliberately not enough.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-person.cddl` | minimal | One map rule, one optional member. |
| `02-typical-order.cddl` | typical | Maps, arrays with `+` occurrence, rule references, a literal type choice. |
| `03-composition-sockets-and-generics.cddl` | composition | Type sockets (`$`), group sockets (`$$`), `/=` and `//=` extension, and generic parameters instantiated twice. |
| `04-stress-control-operators.cddl` | stress | `.size`, `.regexp`, `.cbor`, `.cborseq`, `.within`, `.and`, `.default`, `.bits`, `.ne`/`.gt`/`.le`, ranges (`..`/`...`), tags (`#6.n`), unwrap (`~`), tables, group choice, major-type shorthands. |
| `05-real-world-cose-shaped.cddl` | real-world | COSE message, header and key structures with their tag numbers and negative-integer labels. |
| `06-real-world-webauthn-shaped.cddl` | real-world | WebAuthn attestation object, statement formats, flag bit set, embedded COSE key. |
| `07-modules-set/` | multi-file | CDDL has no `include`: composition is a *fileset* property, so the root and its shared types must be loaded together. |
| `negative/` | — | Unclosed map, a rule assigned twice with `=`, truncation, a JSON Schema document, UTF-16, and a reference to an undefined rule. |

**Every entry round-trips.** `cddl -> cddl` is a passing round-trip matrix cell: each of the seven
valid entries above imports, re-emits and re-imports to a canonical model with **zero** diff. That
holds because the reader records each construct's source spelling — which prelude type a leaf used, a
tag, an unmapped control operator, whether a record came from a map or an array — in `extras`, and
the emitter writes every one of them back rather than re-deriving it.

**Composition is resolved, not approximated.** A type socket's `/=` plugs become a choice, a group
socket's `//=` plugs become a group choice, and `page<T>` is instantiated once per distinct argument
list (`page<$message>` and `page<tstr>` become two types). Instantiation is bounded and refuses to
re-enter an identical instantiation, so a self-instantiating generic fails rather than running. A
reference that resolves in no supplied file fails the import naming the missing rule — CDDL has no
`include`, so treating it as an open type would silently produce a smaller grammar than the author
wrote, which is what `negative/06` proves.

**Declared limits the capability registry carries.** Sockets and generics are *modelled* and the part
that cannot be carried — a socket's open-endedness, and a parameterised rule having no type of its
own — is *declared*: `cddl.type_socket`, `cddl.group_socket` and `cddl.generic_rule`. Beside them
`cddl.tag`, `cddl.major_type`, `cddl.unwrap`, `cddl.open_map_entry`, `cddl.group_choice` and the
control operators with no constraint analogue (`cddl.control_cbor`, `cddl.control_bits`,
`cddl.control_within`, `cddl.control_intersection`, `cddl.control_unmapped`) are published by
`GET /v1/import/format-capabilities` and rendered per document as partially-mapped coverage-ledger
rows. Control operators *with* an analogue are constraints, never limits: `.size` becomes lengths
(or, on an integer, the value range that many bytes admit), `.regexp` becomes `pattern`,
`.lt`/`.le`/`.gt`/`.ge` become the numeric bounds, `.eq` becomes a single-valued `enum` and
`.default` becomes the member's default.
