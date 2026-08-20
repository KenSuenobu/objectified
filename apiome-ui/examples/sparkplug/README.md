# MQTT Sparkplug B — `sparkplug`

Fixtures for **FMT-9.2** ([#5469](https://github.com/apiome/apiome/issues/5469)). Sparkplug B defines
the payload **and** the topic namespace for industrial MQTT, and it rides AsyncAPI's MQTT bindings,
which Apiome already supports. Entries carry `adapter_key: null` and the `pending-adapter` tag.

**Two inputs, one model.**

| Input | Files | Detection marker |
| --- | --- | --- |
| Protobuf payload | `.bin` | field 1 varint (timestamp) + repeated field 2 length-delimited `Metric` messages; reached through the **binary intake SPI** (`accepts_bytes` / `parse_bytes`), the same path protobuf descriptor sets use |
| Topic-namespace description | `.json` | `"namespace": "spBv1.0"` with `groupId` / `edgeNodeId` and a `topics[]` list |

**Topic grammar.** `spBv1.0/<group_id>/<message_type>/<edge_node_id>[/<device_id>]`, where
`message_type` is one of `NBIRTH`, `NDEATH`, `NDATA`, `NCMD`, `DBIRTH`, `DDEATH`, `DDATA`, `DCMD` or
`STATE`. The parsed components become the canonical channel address; metrics become the message
schema.

> **The `.bin` fixtures are hand-encoded**, byte by byte, by the corpus authoring script — no Sparkplug
> library was used and no real device was recorded. Timestamps are fixed so the bytes are reproducible.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-topic-namespace.json` | minimal | One group, one edge node, three topics. |
| `02-typical-nbirth.bin` | typical | An **NBIRTH**: `bdSeq`, node control metrics, hardware properties, `seq = 0`. |
| `03-composition-dbirth.bin` | composition | A **DBIRTH**: metrics with **aliases**, engineering-unit property sets, metadata descriptions — the birth certificate later DDATA payloads refer to by alias alone. |
| `04-stress-ddata-all-datatypes.bin` | stress | Every scalar datatype, a null metric, historical and transient flags, a full property set with metadata, a payload `uuid`, and an **alias-only** metric whose name lives in the BIRTH. |
| `05-real-world-namespace-description.json` | real-world | A line's full namespace: broker settings, eleven topics including `NCMD`/`DCMD` inbound and a retained `STATE`, two devices with their metric catalogues. |
| `06-typical-ddata.bin` | typical | A **DDATA** carrying three alias-only metrics — unreadable without the DBIRTH. |
| `07-session-set/` | multi-file | DBIRTH → DDATA → DDEATH: the alias-only DDATA is nameable only through the DBIRTH. |
| `negative/` | — | A length-delimited field that runs past the buffer, a payload with no metrics, a truncated payload, the Sparkplug **`.proto` schema** (which describes the payloads rather than being one), UTF-16, and topics whose namespace/group/edge-node segments contradict the declared identity. |

**Provenance rule.** Where only payloads are supplied, everything is `inferred`: a DDATA alone cannot
name its metrics, and the adapter must say so rather than inventing names.
