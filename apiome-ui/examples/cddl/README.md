# CDDL (RFC 8610) — `cddl`

Fixtures for **FMT-4.4** ([#5437](https://github.com/apiome/apiome/issues/5437)) — the Concise Data
Definition Language that describes CBOR and JSON structures. It is the schema language of COSE,
WebAuthn/FIDO, the EU Digital Identity Wallet and a large slice of IETF IoT work: the binary-schema
gap beside ASN.1. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** `name = { … }` / `name = [ … ]` rule assignments with `tstr`/`bstr`/`uint`
prelude types and `;` comments, in a `.cddl` file.

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

**Declared limits the capability registry must carry.** Sockets/plugs and generics are the two
constructs most likely to exceed the canonical model, and open-ended `* label => values` tables have
no closed-world analogue. FMT-4.4 requires each to be modelled or declared — never approximated
silently — and the emitter must declare what it cannot carry back.
