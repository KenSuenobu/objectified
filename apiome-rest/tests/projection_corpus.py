"""Cross-format projection fixture & contract corpus — EFP-1.3 (#4812).

EFP-1.1 (:mod:`app.export_projection`) builds the deterministic source→target projection
manifest and EFP-1.2 (:mod:`app.capability_registry`) attaches reviewed, reason-scoped
explanations and documentation to it. What neither can prove alone is that the evidence
**stays true** over time: that the manifest agrees with the emitted artifact, that every
surface (fidelity report, target cards, preview/verify, CLI JSON, job result) describes
the same snapshot, and that the full status/reason vocabulary keeps validating as
emitters and registry entries evolve. This module is the *corpus* those proofs run on —
the shared fixtures, coverage declaration, redaction rules, golden-file IO, and parity
checker that :mod:`tests.test_projection_corpus` drives.

**Coverage declaration & waiver policy** (the "new emitters add fixtures or waive them"
gate). :data:`CORPUS_COVERAGE` must name **every** registered emitter format exactly once:

* ``DEEP`` — the MVP matrix (OpenAPI 3.1, AsyncAPI 3, GraphQL SDL, Proto3, Avro): manifest
  goldens, artifact emission, and target-pointer resolution;
* ``GENERIC`` — the all-emitter sweep: determinism, report reconciliation, envelope
  parity, and registry-evidence completeness (no artifact-level golden);
* :class:`Waiver` — an explicit, documented opt-out (non-empty ``reason``), for a target
  whose manifest genuinely cannot be exercised in CI.

``test_every_emitter_declares_projection_coverage`` fails when a newly registered emitter
is absent from the declaration (or a stale entry lingers), with an error message pointing
here — so a new emitter contribution *must* either add fixtures or record a waiver.

**Redaction.** Golden files must never embed source-sensitive values. The only manifest
fields that can carry raw source excerpts are the native-evidence ``native_id`` and
``source_location`` (read from normalizer ``extras``); :func:`redact_manifest_payload`
replaces their values with :data:`REDACTED` before a golden is written or compared, and
the corpus plants a sentinel secret in a fixture's extras to prove redaction sticks.

**Parity.** :func:`envelope_parity_issues` is the disagreement detector for a serialized
:class:`~app.export_fidelity.ExportFidelity` envelope: the report's kind counts, the
coarse summary counts, and the projection summary's status/reason counts must all
describe the same outcome, and every reason code must be a member of the canonical
taxonomy. The CLI (``apiome_cli.export_output.projection_parity_issues``) and the UI
(``exportFidelityPreview.projectionParityIssues``) mirror this checker over the same
serialized shape, and the UI's jest fixture is a golden this corpus writes — so all three
surfaces reject the same disagreements over the same bytes.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Union

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Constraints,
    EnumValue,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.capability_registry import REASON_CODES
from app.emitter import available_emit_formats, get_emitter

__all__ = [
    "DEEP",
    "GENERIC",
    "Waiver",
    "CORPUS_COVERAGE",
    "DEEP_TARGETS",
    "builtin_formats",
    "SENSITIVE_SENTINEL",
    "REDACTED",
    "GOLDEN_DIR",
    "UPDATE_GOLDENS_ENV",
    "rich_api",
    "event_api",
    "types_only_api",
    "empty_api",
    "redact_manifest_payload",
    "normalize_volatile_provenance",
    "VOLATILE",
    "golden_path",
    "assert_matches_golden",
    "assert_golden_is_redacted",
    "envelope_parity_issues",
    "parity_fixture_payload",
]


# ===========================================================================
# Coverage declaration (the add-fixtures-or-waive gate)
# ===========================================================================

#: Deep coverage: manifest golden + artifact emission + target-pointer resolution.
DEEP = "deep"
#: Generic coverage: the all-emitter sweep (determinism, reconciliation, parity, evidence).
GENERIC = "generic"


@dataclass(frozen=True)
class Waiver:
    """An explicit, documented opt-out from projection fixtures for one emitter.

    Attributes:
        reason: Why this target cannot be exercised by the corpus (must be non-empty).
    """

    reason: str


#: Emitter format key → coverage level (``DEEP`` / ``GENERIC``) or a documented
#: :class:`Waiver`. Every registered emitter format must appear exactly once; the
#: corpus's coverage test fails otherwise. **New emitters: add your format here** with
#: ``DEEP`` (and a golden) when your target claims addressable output locations,
#: ``GENERIC`` to join the sweep, or a ``Waiver("…")`` explaining the opt-out.
CORPUS_COVERAGE: Dict[str, Union[str, Waiver]] = {
    # --- MVP deep matrix (operation / event / graph / RPC / schema-only targets) ---
    "openapi-3.1": DEEP,
    "asyncapi-3": DEEP,
    "graphql": DEEP,
    "proto3": DEEP,
    "avro": DEEP,
    # --- generic sweep coverage ---
    "apiblueprint": GENERIC,
    "arazzo": GENERIC,
    "asn1": GENERIC,
    "capnproto": GENERIC,
    "cloudevents": GENERIC,
    "cobolcopybook": GENERIC,
    "connectrpc": GENERIC,
    "corbaidl": GENERIC,
    "edix12": GENERIC,
    "fhir": GENERIC,
    "fix": GENERIC,
    "flatbuffers": GENERIC,
    "hl7v2": GENERIC,
    "iso20022": GENERIC,
    "iso8583": GENERIC,
    "json-schema": GENERIC,
    "jtd": GENERIC,
    "k8s-crd": GENERIC,
    "odata": GENERIC,
    "oncrpc": GENERIC,
    "openrpc": GENERIC,
    "postman": GENERIC,
    "raml": GENERIC,
    "sample-noop": GENERIC,
    "smithy": GENERIC,
    "thrift": GENERIC,
    "typespec": GENERIC,
    "wadl": GENERIC,
    "wsdl": GENERIC,
    "xmlrpc": GENERIC,
    "xsd": GENERIC,
    "zosconnect": GENERIC,
}

#: The MVP deep-matrix format keys, in declaration order (derived from the coverage map).
DEEP_TARGETS: List[str] = [fmt for fmt, level in CORPUS_COVERAGE.items() if level == DEEP]


def builtin_formats() -> List[str]:
    """Every registered **built-in** emitter format, in stable (sorted) order.

    The coverage gate governs real emitters — the ones shipped in the ``app`` package.
    Other test modules register throwaway emitters into the shared registry (their
    classes live in ``tests.*`` modules), and those must not trip the gate when the
    whole suite runs together, so registration module is the filter.
    """
    formats: List[str] = []
    for fmt in available_emit_formats():
        emitter = get_emitter(fmt)
        if emitter is not None and emitter.__module__.startswith("app."):
            formats.append(fmt)
    return formats


# ===========================================================================
# Source fixtures
# ===========================================================================

#: A fake secret planted into fixture extras; redaction must keep it out of every golden.
SENSITIVE_SENTINEL = "SECRET-SENTINEL-c0ffee"

#: The replacement value redaction writes over source-sensitive golden fields.
REDACTED = "[redacted]"


def rich_api() -> CanonicalApi:
    """A REST source exercising operation, channel, record + lossy fields, union, enum.

    Mirrors EFP-1.1's rich fixture so results stay comparable, and additionally plants
    :data:`SENSITIVE_SENTINEL` into native-evidence extras (``native_id`` /
    ``source_location``) so the corpus can prove redaction keeps raw source detail out
    of golden files.

    Returns:
        The canonical source model.
    """
    get_user = Operation(
        key="GET /users/{id}",
        name="getUser",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="GET",
        http_path="/users/{id}",
    )
    service = Service(key="Users", name="Users", operations=[get_user])
    channel = Channel(key="user/signedup", address="user/signedup", protocol="kafka")
    user = Type(
        key="User",
        name="User",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="User.id", name="id", type=TypeRef(name="string", nullable=False)),
            CanonicalField(
                key="User.age",
                name="age",
                type=TypeRef(name="integer", nullable=True),
                constraints=Constraints(minimum=0, maximum=120),
            ),
            CanonicalField(
                key="User.email",
                name="email",
                type=TypeRef(name="string", nullable=False),
                constraints=Constraints(pattern=r".+@.+"),
                extras={
                    # Source-sensitive native evidence: must never reach a golden verbatim.
                    "native_id": f"field-{SENSITIVE_SENTINEL}",
                    "source_location": f"line 7: apiKey={SENSITIVE_SENTINEL}",
                },
            ),
        ],
    )
    contact = Type(key="Contact", name="Contact", kind=TypeKind.UNION, union_members=["User", "Org"])
    status = Type(
        key="Status",
        name="Status",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="Status.ACTIVE", name="ACTIVE"),
            EnumValue(key="Status.CLOSED", name="CLOSED"),
        ],
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Demo"),
        services=[service],
        channels=[channel],
        types=[user, contact, status],
    )


def event_api() -> CanonicalApi:
    """An event-paradigm source: channels + payload record, no HTTP operations."""
    payload = Type(
        key="SignupEvent",
        name="SignupEvent",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="SignupEvent.userId", name="userId", type=TypeRef(name="string")),
            CanonicalField(
                key="SignupEvent.at", name="at", type=TypeRef(name="string", nullable=True)
            ),
        ],
    )
    channel = Channel(key="user/signedup", address="user/signedup", protocol="kafka")
    return CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="Events"),
        channels=[channel],
        types=[payload],
    )


def types_only_api() -> CanonicalApi:
    """A schema-only source: record + enum, no operations and no channels."""
    record = Type(
        key="Invoice",
        name="Invoice",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="Invoice.id", name="id", type=TypeRef(name="string")),
            CanonicalField(
                key="Invoice.total",
                name="total",
                type=TypeRef(name="number"),
                constraints=Constraints(minimum=0),
            ),
        ],
    )
    currency = Type(
        key="Currency",
        name="Currency",
        kind=TypeKind.ENUM,
        enum_values=[
            EnumValue(key="Currency.USD", name="USD"),
            EnumValue(key="Currency.EUR", name="EUR"),
        ],
    )
    return CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="json-schema",
        identity=ApiIdentity(name="Billing"),
        types=[record, currency],
    )


def empty_api() -> CanonicalApi:
    """A source with no constructs — the lossless-by-vacuity degenerate case."""
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Empty"),
    )


# ===========================================================================
# Redaction + golden IO
# ===========================================================================

#: Directory the corpus's golden files live in.
GOLDEN_DIR = Path(__file__).resolve().parent / "fixtures" / "projection_corpus"

#: Set this env var to ``1`` and re-run the corpus tests to regenerate golden files.
UPDATE_GOLDENS_ENV = "UPDATE_PROJECTION_GOLDENS"

# Native-evidence fields that may carry raw source excerpts; redaction overwrites their
# values (when present) before a golden is written or compared.
_SENSITIVE_NATIVE_FIELDS = ("native_id", "source_location")


def redact_manifest_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return a deep-copied manifest JSON payload with source-sensitive values redacted.

    Replaces every present, non-null ``native_id`` / ``source_location`` value inside
    node native-evidence blocks with :data:`REDACTED`. Construct keys, labels, statuses,
    reasons, explanations, and documentation are structural (apiome-controlled) and stay.

    Args:
        payload: A ``ProjectionManifest.model_dump(mode="json")`` payload.

    Returns:
        The redacted copy (the input is not mutated).
    """
    redacted = json.loads(json.dumps(payload))
    for node in redacted.get("nodes", []):
        native = node.get("native")
        if isinstance(native, dict):
            for field in _SENSITIVE_NATIVE_FIELDS:
                if native.get(field) is not None:
                    native[field] = REDACTED
    return redacted


#: The placeholder golden files carry for release-volatile provenance values.
VOLATILE = "[volatile]"

# Keys whose values change with every apiome-rest release without any projection-behavior
# change: the package version and the manifest hash that folds it. Golden files replace
# them with :data:`VOLATILE` so a routine version bump does not invalidate the corpus —
# hash determinism itself is pinned by the double-build sweep, not by goldens.
_VOLATILE_KEYS = frozenset({"apiome_version", "manifest_hash"})


def normalize_volatile_provenance(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return a deep copy of ``payload`` with release-volatile values normalized.

    Recursively replaces every ``apiome_version`` / ``manifest_hash`` value with
    :data:`VOLATILE`, wherever it appears (manifest root, target block, projection
    summary). Meaningful provenance — ``emitter_version`` and ``registry_version``,
    which only change when behavior changes — is left intact so goldens still catch it.

    Args:
        payload: Any JSON-serialized corpus payload.

    Returns:
        The normalized copy (the input is not mutated).
    """

    def _walk(node: Any) -> Any:
        if isinstance(node, dict):
            return {
                key: (VOLATILE if key in _VOLATILE_KEYS and isinstance(value, str) else _walk(value))
                for key, value in node.items()
            }
        if isinstance(node, list):
            return [_walk(item) for item in node]
        return node

    return _walk(json.loads(json.dumps(payload)))


def _canonical_json(payload: Dict[str, Any]) -> str:
    """Serialize a payload deterministically (sorted keys, 2-space indent, newline-terminated)."""
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def golden_path(name: str) -> Path:
    """Return the golden file path for ``name`` (e.g. ``manifest_avro``)."""
    return GOLDEN_DIR / f"{name}.json"


def assert_matches_golden(name: str, payload: Dict[str, Any]) -> None:
    """Assert ``payload`` equals the checked-in golden ``name`` (or regenerate it).

    With ``UPDATE_PROJECTION_GOLDENS=1`` in the environment the golden is (re)written
    instead of compared, so intentional contract changes are a one-command refresh.
    The comparison is on canonical JSON text, so any drift — ordering included — fails.

    Args:
        name: The golden file's base name.
        payload: The live payload to compare (already redacted where applicable).

    Raises:
        AssertionError: When the golden is missing or differs (and updating is off).
    """
    path = golden_path(name)
    rendered = _canonical_json(payload)
    if os.environ.get(UPDATE_GOLDENS_ENV) == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")
        return
    assert path.exists(), (
        f"missing golden {path.name}; run `{UPDATE_GOLDENS_ENV}=1 pytest "
        f"tests/test_projection_corpus.py` to generate it, then review + commit it"
    )
    assert path.read_text(encoding="utf-8") == rendered, (
        f"golden {path.name} disagrees with the live manifest; if the change is intended, "
        f"regenerate with `{UPDATE_GOLDENS_ENV}=1` and review the diff"
    )


def assert_golden_is_redacted(name: str) -> None:
    """Assert the checked-in golden ``name`` carries no planted source-sensitive sentinel."""
    text = golden_path(name).read_text(encoding="utf-8")
    assert SENSITIVE_SENTINEL not in text, (
        f"golden {name}.json leaked a source-sensitive value; redact_manifest_payload must "
        "cover every field that can carry raw source detail"
    )


# ===========================================================================
# Envelope parity (the cross-surface disagreement detector)
# ===========================================================================

# ``LossinessKind`` value → the ProjectionStatus values it reconciles with. ``transformed``
# reconciles to ``ok`` (a documented transformation preserves meaning) exactly as
# ``app.export_projection.reconcile_with_report`` does.
_KINDS_TO_STATUSES: Dict[str, tuple] = {
    "ok": ("retained", "transformed"),
    "approx": ("approximated",),
    "synth": ("synthesized",),
    "drop": ("dropped",),
}

# Coarse-summary count field → the report kind it must equal.
_SUMMARY_TO_KIND = {
    "preserved": "ok",
    "approximated": "approx",
    "synthesized": "synth",
    "dropped": "drop",
}


def envelope_parity_issues(envelope: Mapping[str, Any]) -> List[str]:
    """Return every parity disagreement inside one serialized ``ExportFidelity`` envelope.

    The corpus's cross-surface guarantee in checkable form: given the JSON-serialized
    envelope any surface carries (preview, verify, dispatch, CLI ``--json``, job result),
    verify that its three descriptions of the same export agree —

    * ``report.kind_counts`` ↔ ``projection.status_counts`` (per-kind, with
      ``transformed`` reconciling to ``ok``, and ``unavailable`` / ``not-applicable``
      excluded as reportless statuses);
    * ``summary`` counts (``preserved`` / ``dropped`` / ``approximated`` /
      ``synthesized`` / ``total``) ↔ ``report.kind_counts``;
    * ``projection.reason_counts`` keys ⊆ the canonical reason taxonomy;
    * ``projection.is_lossless`` ↔ every evidence row retained.

    Args:
        envelope: The serialized fidelity envelope (``target`` / ``summary`` / ``report``
            / ``advisory`` / ``projection``).

    Returns:
        A list of human-readable disagreement descriptions; empty when the envelope is
        internally consistent.
    """
    issues: List[str] = []

    report = envelope.get("report")
    summary = envelope.get("summary")
    projection = envelope.get("projection")
    if not isinstance(report, Mapping) or not isinstance(summary, Mapping):
        return ["envelope is missing its report/summary blocks"]
    if not isinstance(projection, Mapping):
        return ["envelope is missing its projection summary block (EFP-1.1)"]
    if not projection.get("manifest_hash"):
        issues.append("projection summary has no manifest_hash (snapshot id)")

    kind_counts = report.get("kind_counts") or {}
    status_counts = projection.get("status_counts") or {}
    reason_counts = projection.get("reason_counts") or {}

    # Report kinds ↔ projection statuses.
    for kind, statuses in _KINDS_TO_STATUSES.items():
        kind_total = int(kind_counts.get(kind, 0))
        status_total = sum(int(status_counts.get(status, 0)) for status in statuses)
        if kind_total != status_total:
            issues.append(
                f"report kind_counts[{kind!r}]={kind_total} disagrees with projection "
                f"status_counts{list(statuses)}={status_total}"
            )

    # Coarse summary ↔ report kinds.
    for field, kind in _SUMMARY_TO_KIND.items():
        summary_value = int(summary.get(field, 0))
        kind_value = int(kind_counts.get(kind, 0))
        if summary_value != kind_value:
            issues.append(
                f"summary {field}={summary_value} disagrees with report kind_counts[{kind!r}]={kind_value}"
            )
    report_total = sum(int(kind_counts.get(kind, 0)) for kind in _KINDS_TO_STATUSES)
    if int(summary.get("total", 0)) != report_total:
        issues.append(
            f"summary total={summary.get('total')} disagrees with report item total={report_total}"
        )

    # Reason codes must be members of the canonical taxonomy.
    for code in reason_counts:
        if code not in REASON_CODES:
            issues.append(f"projection reason_counts carries unknown reason code {code!r}")

    # is_lossless ↔ every evidence row retained.
    evidence_count = int(projection.get("evidence_count", 0))
    retained = int(status_counts.get("retained", 0))
    is_lossless = bool(projection.get("is_lossless", False))
    if is_lossless != (evidence_count == retained):
        issues.append(
            f"projection is_lossless={is_lossless} disagrees with retained {retained} of "
            f"{evidence_count} evidence rows"
        )

    return issues


def parity_fixture_payload(envelope_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Build the compact parity-fixture payload the UI jest corpus shares bytes with.

    A reduced envelope — the ``summary`` block, the report's ``kind_counts``, and the
    full ``projection`` summary — that is small enough to check in twice (REST golden +
    UI jest fixture) yet sufficient for every check :func:`envelope_parity_issues`
    performs, so both test suites reject the same disagreements over the same bytes.

    Args:
        envelope_payload: The serialized full fidelity envelope.

    Returns:
        The reduced parity payload.
    """
    return {
        "summary": envelope_payload["summary"],
        "report": {"kind_counts": envelope_payload["report"]["kind_counts"]},
        "projection": envelope_payload["projection"],
    }
