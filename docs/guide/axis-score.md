# Axis score algorithm (`clx-axis-v1`)

Apiome rolls catalog and MCP lint evidence into a multi-axis evaluation. The algorithm
identity shown in the UI is:

| Field | Value |
|-------|--------|
| Algorithm id | `clx-axis-v1` |
| Algorithm version | `2` (implementation revision) |

Source: `apiome-rest/src/app/axis_score.py` (`ALGORITHM_ID`, `ALGORITHM_VERSION`).

## What the axes mean

Axes include quality, protocol, security, supply chain, supportability, and compatibility.
An axis that has not been scanned is **not assessed** — that is not a clean score.

Composite scores are withheld until required coverage is met (v1: the `quality` axis).

### Supportability, for data contracts

Since implementation revision `2` (FMT-5.5), the **supportability** axis is assessed for a
data contract — an item imported from ODCS or dbt — from the `governance` findings the
[data-contract rule pack](lint-rules.md) produces: is there a reachable owner, a stated
service level, a freshness expectation, a documented retention window, a declared serving
location. Those findings score that axis instead of `quality`, so they are never counted
twice.

Every other subject is unchanged. A schema *language* — Avro, XSD, RELAX NG, CDDL, a Kafka
Connect schema — shares the `data_schema` paradigm but has no syntax in which to state an
owner or an SLA, so the pack does not run for it and its supportability axis stays **not
assessed**: a capability limit of the format is not a defect of the document. An API-paradigm
item is untouched in every respect, including its score, grade and report fingerprint.

## Honesty guarantees

- Skipped rules (missing transcript, source, SBOM, or probe consent) never count as passes.
- Static trust-posture findings are **signals**, not proven exploits, until a consent-gated
  probe demonstrates exploitability ([MCP probes](../../apiome-rest/docs/mcp_probes.md)).

## Related documentation

- [Lint & quality](lint-and-quality.md)
- [Scanner evaluation corpus](../../apiome-rest/docs/scanner_evaluation.md) (CLX-4.3)
- [MCP trust posture](../../apiome-rest/docs/mcp_trust_posture.md)
- Built-in schema rules: [lint-rules.md](lint-rules.md)
