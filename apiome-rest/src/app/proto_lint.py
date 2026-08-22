"""Protobuf lint pack — MFI-9.4 (#3767).

Quality signals for gRPC / Protocol Buffers (RPC) APIs, layered on the canonical lint engine
(MFI-4.1 :mod:`app.lint_engine`) and the shared scoring/grade/fingerprint formula
(MFI-4.2 :mod:`app.schema_lint`). Like the GraphQL pack (MFI-10.4 :mod:`app.graphql_lint`) and
the AsyncAPI pack (MFI-8.3 :mod:`app.asyncapi_lint`) it has two complementary halves:

* **Native rules** (:class:`ProtobufRulePack`) — a :class:`~app.lint_engine.RulePack` registered
  under the ``protobuf`` format key (the one the MFI-9.2 normalizer emits). The rules run purely
  over the :class:`~app.canonical_model.CanonicalApi` — no I/O, no ``buf`` — encoding the three
  Protobuf-specific checks the roadmap calls out, which ``buf``'s default categories do *not*
  cover but which are decidable over a single compiled descriptor set:

  - **versioned package** — the package should carry a version suffix (``foo.v1`` /
    ``foo.v1beta1``), mirroring ``buf``'s ``PACKAGE_VERSION_SUFFIX`` so the always-on score is
    meaningful even when ``buf`` is unavailable.
  - **no ``required``** — a proto2 / Editions ``required`` field is a one-way door (it can never
    be safely removed), so it is flagged. ``buf`` has no default rule for this.
  - **``reserved`` on deletion** — a *gap* in a message's field numbers (or an enum's value
    numbers) that no ``reserved`` range covers suggests a field/value was deleted without
    reserving its number, the single-artifact heuristic for the "always reserve on delete" rule
    (the authoritative cross-version check is the MFI-9.5 ``buf breaking`` detector).

  Because the pack is registered, it runs automatically via the engine default
  (:func:`app.lint_engine.lint_canonical_model`) for any ``protobuf`` artifact — i.e. the
  always-on import-time score (MFI-4.2) — even with no ``buf`` binary present.

* **``buf lint`` findings** (:func:`buf_findings`) — the authoritative ``buf lint`` ruleset
  (categories MINIMAL→STANDARD plus COMMENTS) is the bundled ``buf`` tool. :func:`run_buf_lint`
  runs it through the MFI-4.3 / MFI-5.1 polyglot toolchain runner (:mod:`app.toolchain_runner`)
  against a scratch ``buf`` module, and :func:`buf_findings` maps its ``--error-format=json``
  output into :class:`~app.schema_lint.LintFinding`\\s so they merge into the *very same*
  weighted score — i.e. we *wrap* ``buf``'s verdicts rather than re-implementing every rule.

The two halves come together in :func:`lint_protobuf_result` (sync, pure — takes a model plus
optional already-obtained ``buf lint`` output) and the convenience :func:`lint_protobuf`
(async — compiles ``.proto`` source, runs ``buf lint``, normalizes, then lints). The ``buf``
findings are **opt-in and degrade gracefully**: with no ``buf`` output supplied the native +
common packs still produce a deterministic score, exactly as MFI-4.3 requires of an
external-linter adapter.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from .canonical_model import (
    CanonicalApi,
    CanonicalField,
    EnumValue,
    Type,
    TypeKind,
)
from .lint_engine import (
    LintRule,
    RulePack,
    lint_canonical_model,
)
from .proto_editions import (
    EDITIONS_PROVENANCE_EXTRA_KEY,
    ENUM_CLOSED_EXTRA_KEY,
    FEATURES_EXTRA_KEY,
    FIELD_PRESENCE_EXTRA_KEY,
    FIELD_PRESENCE_LEGACY_REQUIRED,
    JSON_FORMAT_LEGACY_BEST_EFFORT,
    MESSAGE_ENCODING_DELIMITED,
    UTF8_VALIDATION_NONE,
)
from .schema_lint import LintFinding, LintResult, Severity

__all__ = [
    "ProtobufRulePack",
    "ProtoLintError",
    "buf_findings",
    "run_buf_lint",
    "lint_protobuf_result",
    "lint_protobuf",
    "BUF_LINT_RULE_PREFIX",
    "BUF_LINT_MODULE_YAML",
]


# ===========================================================================
# Package version suffix (buf `PACKAGE_VERSION_SUFFIX`)
# ===========================================================================
#
# buf requires the last component of a package to be a version, e.g. `acme.user.v1`. The
# accepted forms are `v1`, `v1alpha`/`v1alpha1`, `v1beta1`, `v1test`, and the point releases
# `v1p1alpha1`. This mirrors buf's `protoversion` grammar closely enough to back the native
# rule when buf itself is unavailable (buf remains the authoritative check via run_buf_lint).
_VERSION_COMPONENT = re.compile(
    r"^v\d+(?:(?:alpha|beta)\d*|test|p\d+(?:alpha|beta)\d+)?$"
)


def _is_versioned_package(package: Optional[str]) -> bool:
    """True when ``package``'s last dotted component is a buf-style version suffix."""
    if not (isinstance(package, str) and package.strip()):
        return False
    last = package.strip().rsplit(".", 1)[-1]
    return bool(_VERSION_COMPONENT.match(last))


# ===========================================================================
# Deterministic, sorted iteration over the canonical Protobuf model
# ===========================================================================
#
# Every check yields ``(path, message)`` pairs in sorted-key order so the engine's
# deterministic re-sort never depends on emission order. Paths mirror the common pack's
# coordinates — ``types.{type}``, ``types.{type}.fields.{field}`` — so a defect carries the
# same path no matter which pack reports it.


def _types_sorted(api: CanonicalApi) -> List[Type]:
    return sorted(api.types, key=lambda t: t.key)


def _fields_sorted(api_type: Type) -> List[CanonicalField]:
    return sorted(api_type.fields, key=lambda f: f.key)


def _enum_values_sorted(api_type: Type) -> List[EnumValue]:
    return sorted(api_type.enum_values, key=lambda v: v.key)


# ===========================================================================
# Native rule checks (pure generators over the canonical model)
# ===========================================================================


def _check_package_version_suffix(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """The artifact's package should be versioned (buf ``PACKAGE_VERSION_SUFFIX``).

    The MFI-9.2 normalizer records the proto package as the artifact's
    :attr:`~app.canonical_model.ApiIdentity.namespace`. A package with no version-suffixed
    final component (``acme.user`` rather than ``acme.user.v1``) — or no package at all — is
    flagged once at the ``package`` coordinate. buf, when run, checks every file's package;
    this native rule covers the primary package on the always-on path.
    """
    package = api.identity.namespace
    if not _is_versioned_package(package):
        shown = package.strip() if isinstance(package, str) and package.strip() else "(none)"
        yield (
            "package",
            f"Package '{shown}' is not versioned; its last component should be a version "
            "such as 'v1' or 'v1beta1' (e.g. 'foo.v1').",
        )


def _is_required_field(field: CanonicalField) -> bool:
    """Whether a field is required, in either of the two spellings the normalizer emits.

    proto2 says so in the descriptor's ``label``, which the normalizer keeps as
    ``extras['label'] == 'required'``. An Editions file says the same thing as a *feature*,
    ``field_presence = LEGACY_REQUIRED``, and its descriptor label stays ``optional`` — so a
    label-only check silently passed every Editions document that carried the construct
    (FMT-3.7). Both spellings mean the identical wire contract, so both are read here.
    """
    return (
        field.extras.get("label") == "required"
        or field.extras.get(FIELD_PRESENCE_EXTRA_KEY) == FIELD_PRESENCE_LEGACY_REQUIRED
    )


def _check_field_no_required(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """No field should be ``required`` (a proto2 / Editions one-way door).

    A ``required`` field can never be removed without breaking the wire contract, so each is
    flagged. proto3 has no ``required``, so this only ever fires on proto2 inputs and on
    Editions inputs that resolve a field to ``LEGACY_REQUIRED``.
    """
    for api_type in _types_sorted(api):
        if api_type.kind is not TypeKind.RECORD:
            continue
        for field in _fields_sorted(api_type):
            if _is_required_field(field):
                yield (
                    f"types.{api_type.key}.fields.{field.key}",
                    f"Field '{field.name}' is 'required'; required fields cannot be removed "
                    "without breaking compatibility — prefer 'optional'.",
                )


def _covered_by_reserved(number: int, ranges: Any, *, inclusive_end: bool) -> bool:
    """Whether ``number`` falls inside any ``[start, end]`` reserved range.

    The MFI-9.2 normalizer preserves ``reserved`` ranges verbatim, and the two paradigms differ:
    a **message**'s ranges are half-open ``[start, end)`` (the descriptor's exclusive end), while
    an **enum**'s are inclusive ``[start, end]``. ``inclusive_end`` selects which.
    """
    if not isinstance(ranges, list):
        return False
    for pair in ranges:
        if not (isinstance(pair, (list, tuple)) and len(pair) == 2):
            continue
        start, end = pair
        if not (isinstance(start, int) and isinstance(end, int)):
            continue
        if start <= number and (number <= end if inclusive_end else number < end):
            return True
    return False


def _number_gaps(numbers: List[int], ranges: Any, *, inclusive_end: bool) -> List[Tuple[int, int]]:
    """Return the contiguous ``(lo, hi)`` gaps in ``numbers`` not covered by ``reserved``.

    Only gaps strictly *between* the smallest and largest used number are considered — a sparse
    layout below the minimum (intentionally high starting numbers) is never flagged. Each
    returned ``(lo, hi)`` is an inclusive run of missing, un-reserved numbers.
    """
    present = sorted({n for n in numbers if isinstance(n, int)})
    if len(present) < 2:
        return []
    present_set = set(present)
    missing = [
        n
        for n in range(present[0] + 1, present[-1])
        if n not in present_set
        and not _covered_by_reserved(n, ranges, inclusive_end=inclusive_end)
    ]
    gaps: List[Tuple[int, int]] = []
    for n in missing:
        if gaps and n == gaps[-1][1] + 1:
            gaps[-1] = (gaps[-1][0], n)
        else:
            gaps.append((n, n))
    return gaps


def _gap_phrase(lo: int, hi: int) -> str:
    """Render a gap run as ``'3'`` or ``'3 to 5'`` for a finding message."""
    return str(lo) if lo == hi else f"{lo} to {hi}"


def _check_reserved_on_deletion(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """A field/enum-value number gap should be ``reserved`` (the delete-then-reserve rule).

    Best practice is to ``reserved`` a field number (or enum value number) the moment its
    field/value is removed, so it is never silently reused. On a single artifact a deletion
    cannot be observed directly, so this flags the next-best signal: a number missing from the
    used range that no ``reserved`` declaration covers. It runs over both message field numbers
    (half-open reserved ranges) and enum value numbers (inclusive), in deterministic key order.
    The authoritative cross-version check is MFI-9.5's ``buf breaking``.
    """
    for api_type in _types_sorted(api):
        if api_type.kind is TypeKind.RECORD:
            numbers = [f.field_number for f in _fields_sorted(api_type) if f.field_number is not None]
            for lo, hi in _number_gaps(
                numbers, api_type.extras.get("reserved_ranges"), inclusive_end=False
            ):
                yield (
                    f"types.{api_type.key}",
                    f"Field number {_gap_phrase(lo, hi)} on '{api_type.name}' is unused and "
                    "not reserved; reserve removed field numbers so they are never reused.",
                )
        elif api_type.kind is TypeKind.ENUM:
            numbers = [v.value for v in _enum_values_sorted(api_type) if v.value is not None]
            for lo, hi in _number_gaps(
                numbers, api_type.extras.get("reserved_ranges"), inclusive_end=True
            ):
                yield (
                    f"types.{api_type.key}",
                    f"Enum value {_gap_phrase(lo, hi)} on '{api_type.name}' is unused and "
                    "not reserved; reserve removed value numbers so they are never reused.",
                )


# ===========================================================================
# Editions feature checks (FMT-3.7) — wire and JSON compatibility hazards
# ===========================================================================
#
# Every rule below reads the *resolved* feature values the FMT-3.7 normalizer records
# (``extras['field_presence']`` / ``extras['enum_closed']`` / ``extras['proto_features']``),
# which only an Editions document carries. A proto2/proto3 artifact has none of them, so these
# rules are silent on one — the pack's findings for the syntaxes that shipped before Editions
# are unchanged. They flag settings that are *legal* but change what a peer on the other end of
# the wire, or a JSON client, will do with the document.


def _entity_feature(extras: Mapping[str, Any], name: str) -> Optional[str]:
    """Return an entity's resolved value for one Editions feature, or ``None`` when unrecorded.

    Serves fields, messages and enums alike — the normalizer writes the same bag on all three.
    The normalizer records a feature at the scope that owns it and only where the value
    deviates from its file's, so an unrecorded feature means "this entity agrees with its file",
    which is not a hazard worth a finding on its own. Every read is defensive because ``extras``
    is an open bag: a model round-tripped through JSONB can hold anything under this key.
    """
    features = extras.get(FEATURES_EXTRA_KEY)
    if isinstance(features, dict):
        value = features.get(name)
        if isinstance(value, str):
            return value
    return None


def _is_editions(api: CanonicalApi) -> bool:
    """Whether this artifact carries the FMT-3.7 Editions provenance record."""
    return isinstance(api.extras.get(EDITIONS_PROVENANCE_EXTRA_KEY), dict)


def _file_feature(api: CanonicalApi, name: str) -> Optional[str]:
    """Return the value ``name`` resolves to for **every** target file, or ``None``.

    A document whose files disagree has no single answer, so a file-scoped rule stays silent
    rather than picking one file's setting and reporting it as the document's.
    """
    record = api.extras.get(EDITIONS_PROVENANCE_EXTRA_KEY)
    if not isinstance(record, dict):
        return None
    files = record.get("files")
    if not isinstance(files, list) or not files:
        return None
    values = set()
    for entry in files:
        if not isinstance(entry, dict):
            return None
        features = entry.get("features")
        if not isinstance(features, dict):
            return None
        value = features.get(name)
        # A non-string means the bag was written by something other than the normalizer; a
        # lint rule reads ``extras`` defensively rather than trusting its shape.
        if not isinstance(value, str):
            return None
        values.add(value)
    return values.pop() if len(values) == 1 else None


def _check_editions_delimited_encoding(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """``message_encoding = DELIMITED`` is the proto2 group wire format.

    A delimited field is written as a start/end group pair rather than a length-prefixed
    submessage. It is a different encoding on the wire — a peer that resolves the field to
    ``LENGTH_PREFIXED`` cannot read it — and several runtimes and JSON mappers have only
    partial support for it, so it is flagged wherever a field opts into it.
    """
    if not _is_editions(api):
        return
    for api_type in _types_sorted(api):
        if api_type.kind is not TypeKind.RECORD:
            continue
        for field in _fields_sorted(api_type):
            if _entity_feature(field.extras, "message_encoding") == MESSAGE_ENCODING_DELIMITED:
                yield (
                    f"types.{api_type.key}.fields.{field.key}",
                    f"Field '{field.name}' uses 'message_encoding = DELIMITED' (the proto2 "
                    "group encoding); it is a different wire format from the "
                    "length-prefixed default and is not portable across runtimes.",
                )


def _check_editions_utf8_validation(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """``utf8_validation = NONE`` lets invalid UTF-8 into a ``string`` field.

    Turning validation off means the field can carry bytes that are not valid UTF-8. Those
    bytes have no JSON representation and will fail — or be silently mangled by — a
    JSON-mapping client, and a peer that resolves the field to ``VERIFY`` rejects the message
    outright. It is occasionally the right call for opaque pass-through text, which is why the
    finding is informational rather than an error.
    """
    if not _is_editions(api):
        return
    for api_type in _types_sorted(api):
        if api_type.kind is not TypeKind.RECORD:
            continue
        for field in _fields_sorted(api_type):
            if _entity_feature(field.extras, "utf8_validation") == UTF8_VALIDATION_NONE:
                yield (
                    f"types.{api_type.key}.fields.{field.key}",
                    f"Field '{field.name}' sets 'utf8_validation = NONE'; it may carry bytes "
                    "that are not valid UTF-8, which have no JSON representation and are "
                    "rejected by a peer that validates.",
                )


def _check_editions_json_format(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """``json_format = LEGACY_BEST_EFFORT`` gives up the guaranteed JSON mapping.

    ``ALLOW`` is the guarantee that the message has a well-defined, round-trippable JSON
    encoding — the compiler enforces it by rejecting the shapes that break it (a duplicate
    JSON name, for instance). ``LEGACY_BEST_EFFORT`` lifts that check, so what a JSON client
    receives becomes implementation-defined. Reported once per scope that opts out, plus once
    at the artifact when every file does.
    """
    if not _is_editions(api):
        return
    if _file_feature(api, "json_format") == JSON_FORMAT_LEGACY_BEST_EFFORT:
        yield (
            "package",
            "Every file sets 'json_format = LEGACY_BEST_EFFORT'; the JSON encoding of these "
            "messages is implementation-defined rather than guaranteed round-trippable.",
        )
    for api_type in _types_sorted(api):
        if _entity_feature(api_type.extras, "json_format") == JSON_FORMAT_LEGACY_BEST_EFFORT:
            yield (
                f"types.{api_type.key}",
                f"Type '{api_type.name}' sets 'json_format = LEGACY_BEST_EFFORT'; its JSON "
                "encoding is implementation-defined rather than guaranteed round-trippable.",
            )


def _check_editions_closed_enum(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """A closed enum cannot receive a value a newer peer added.

    ``enum_type = CLOSED`` (proto2's behaviour) makes an unrecognised number fail to parse into
    the field — it lands in the unknown-field set, and a required-style reader sees the field as
    absent. An ``OPEN`` enum keeps the number, so a peer can add values without breaking older
    readers. Closed is a deliberate choice when migrating from proto2, so the finding is a
    warning about the forward-compatibility cost rather than a defect claim.
    """
    if not _is_editions(api):
        return
    for api_type in _types_sorted(api):
        if api_type.kind is TypeKind.ENUM and api_type.extras.get(ENUM_CLOSED_EXTRA_KEY) is True:
            yield (
                f"types.{api_type.key}",
                f"Enum '{api_type.name}' is closed ('enum_type = CLOSED'); a value added by a "
                "newer peer will not parse into it, so it cannot be extended compatibly.",
            )


# ===========================================================================
# The Protobuf native rule pack
# ===========================================================================


class ProtobufRulePack(RulePack, register=True):
    """Native, deterministic hygiene rules for Protobuf (gRPC) artifacts.

    Runs in addition to the always-on :class:`~app.lint_engine.CommonRulePack` whenever the
    canonical model's ``format`` is ``protobuf`` (the key the MFI-9.2 normalizer emits). Pure
    over the model — no I/O, no ``buf`` — so it is safe on the always-on lint path even when the
    ``buf`` binary is unavailable; that linter's findings, when supplied, are merged in
    separately by :func:`lint_protobuf_result`.
    """

    format = "protobuf"
    pack_id = "protobuf"

    #: Built once at class-definition time (the pack is stateless). The engine re-sorts findings
    #: deterministically, so this order is for readability only.
    _RULES: Tuple[LintRule, ...] = (
        LintRule(
            rule_id="protobuf.package-version-suffix",
            category="naming",
            severity="warning",
            description="A package should carry a version suffix (foo.v1).",
            check=_check_package_version_suffix,
        ),
        LintRule(
            rule_id="protobuf.field-no-required",
            category="structure",
            severity="warning",
            description="Fields should not be 'required'.",
            check=_check_field_no_required,
        ),
        LintRule(
            rule_id="protobuf.reserved-on-deletion",
            category="structure",
            severity="info",
            description="Removed field/value numbers should be reserved, not left as gaps.",
            check=_check_reserved_on_deletion,
        ),
        LintRule(
            rule_id="protobuf.editions.delimited-encoding",
            category="structure",
            severity="warning",
            description="Editions 'message_encoding = DELIMITED' is the proto2 group wire format.",
            check=_check_editions_delimited_encoding,
        ),
        LintRule(
            rule_id="protobuf.editions.utf8-validation-off",
            category="structure",
            severity="info",
            description="Editions 'utf8_validation = NONE' admits strings with no JSON encoding.",
            check=_check_editions_utf8_validation,
        ),
        LintRule(
            rule_id="protobuf.editions.legacy-json-format",
            category="structure",
            severity="warning",
            description="Editions 'json_format = LEGACY_BEST_EFFORT' gives up the JSON guarantee.",
            check=_check_editions_json_format,
        ),
        LintRule(
            rule_id="protobuf.editions.closed-enum",
            category="structure",
            severity="warning",
            description="A closed enum cannot receive a value a newer peer added.",
            check=_check_editions_closed_enum,
        ),
    )

    def rules(self) -> List[LintRule]:
        """Return the Protobuf native rules in deterministic execution order."""
        return list(self._RULES)


# ===========================================================================
# buf lint output -> canonical findings
# ===========================================================================

#: Namespace every buf-sourced finding's rule id lives under, so they group cleanly against the
#: ``protobuf.*`` native rules and the ``common.*`` cross-format rules.
BUF_LINT_RULE_PREFIX = "protobuf.buf"

# buf lint reports no per-finding severity — every emitted item is a rule violation. They fold
# uniformly to ``warning`` (a style/governance signal, not a hard error) so they contribute to
# the score the way the GraphQL/AsyncAPI external linters' warnings do.
_BUF_SEVERITY: Severity = "warning"


def _buf_rule_id(raw_type: Any) -> str:
    """Normalize a buf ``type`` (``PACKAGE_VERSION_SUFFIX``) into a namespaced rule id.

    ``PACKAGE_VERSION_SUFFIX`` → ``protobuf.buf.package_version_suffix``. A missing/blank type
    becomes ``protobuf.buf.unknown`` so the finding still groups and scores.
    """
    rule = str(raw_type).strip().lower() if raw_type is not None else ""
    return f"{BUF_LINT_RULE_PREFIX}.{rule or 'unknown'}"


def _buf_path(finding: Dict[str, Any]) -> str:
    """Build a stable finding path from a buf finding's ``path`` + ``start_line``/``column``."""
    base = finding.get("path")
    base = base.strip() if isinstance(base, str) and base.strip() else "(proto)"
    line = finding.get("start_line")
    column = finding.get("start_column")
    if isinstance(line, int):
        if isinstance(column, int):
            return f"{base}:{line}:{column}"
        return f"{base}:{line}"
    return base


def buf_findings(report: Any) -> List[LintFinding]:
    """Map ``buf lint`` ``--error-format=json`` output into canonical :class:`LintFinding`\\s.

    ``buf lint --error-format=json`` emits one JSON object per violation (newline-delimited),
    each carrying ``path`` / ``start_line`` / ``start_column`` / ``type`` / ``message``. Each
    becomes one finding whose ``rule`` is the buf rule type re-namespaced
    ``protobuf.buf.<type>`` (so it merges into the score and groups with the native rules), at
    ``warning`` severity (buf reports no per-finding severity).

    Args:
        report: The parsed ``buf lint`` output. Accepted forms, all degrading gracefully:
            a list of finding mappings (e.g. from :func:`run_buf_lint`); a single such mapping;
            or the raw newline-delimited JSON string (parsed line by line, non-JSON lines
            skipped). Anything falsy (``None``, ``[]``, ``""``) yields no findings, so the
            report degrades to the native + common packs.

    Returns:
        One :class:`LintFinding` per buf violation. The list preserves input order; the engine
        re-sorts deterministically.
    """
    findings: List[LintFinding] = []
    for finding in _iter_buf_findings(report):
        if not isinstance(finding, dict):
            continue
        findings.append(
            LintFinding(
                path=_buf_path(finding),
                category="buf-lint",
                rule=_buf_rule_id(finding.get("type")),
                severity=_BUF_SEVERITY,
                message=str(finding.get("message", "") or ""),
            )
        )
    return findings


def _iter_buf_findings(report: Any) -> Iterable[Any]:
    """Yield each buf finding mapping from a report that is a list, a mapping, or raw JSONL."""
    if not report:
        return
    if isinstance(report, dict):
        yield report
        return
    if isinstance(report, (str, bytes)):
        yield from parse_buf_lint_output(
            report.decode("utf-8", "replace") if isinstance(report, bytes) else report
        )
        return
    try:
        yield from report
    except TypeError:
        return


def parse_buf_lint_output(stdout: str) -> List[Dict[str, Any]]:
    """Parse ``buf lint --error-format=json`` newline-delimited JSON into finding dicts.

    buf writes one JSON object per line (JSON Lines). Blank lines and any line that is not a
    JSON object are skipped, so a stray banner or progress line never derails parsing.

    Args:
        stdout: The captured ``buf lint`` standard output.

    Returns:
        The list of parsed finding objects, in emission order.
    """
    findings: List[Dict[str, Any]] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            findings.append(obj)
    return findings


# ===========================================================================
# buf lint runner (MFI-4.3 toolchain adapter)
# ===========================================================================


class ProtoLintError(Exception):
    """Raised when ``buf lint`` cannot be run (unavailable / times out / operational error).

    A non-zero exit caused by lint *violations* is **not** an error — those are the findings and
    are returned normally; this is reserved for ``buf`` being absent, timing out, or failing to
    build the module (a syntax error / unresolved import surfaced in ``diagnostics``).
    """

    def __init__(self, message: str, *, diagnostics: Optional[str] = None) -> None:
        self.diagnostics = diagnostics
        super().__init__(message if not diagnostics else f"{message}\n{diagnostics}")


#: ``buf`` v2 module config for linting: the same single-module layout MFI-9.1 builds with, plus
#: the lint categories the roadmap calls out — MINIMAL→STANDARD (``STANDARD`` is the superset)
#: and ``COMMENTS`` (which ``STANDARD`` does not include).
BUF_LINT_MODULE_YAML = (
    "version: v2\n"
    "modules:\n"
    "  - path: .\n"
    "lint:\n"
    "  use:\n"
    "    - STANDARD\n"
    "    - COMMENTS\n"
)

#: buf's exit code for "lint violations were found" (as opposed to an operational failure).
_BUF_LINT_VIOLATIONS_EXIT = 100


async def run_buf_lint(
    files: "Any",
    *,
    runner: "Any" = None,
    timeout: Optional[float] = None,
    policy: "Any" = None,
) -> List[Dict[str, Any]]:
    """Run ``buf lint`` over a set of ``.proto`` files and return its parsed findings.

    Delegates to the CLX-2.1 :class:`~app.external_linter_adapter.BufLintAdapter` under the
    restricted runner (no-network sandbox, redacted logs). Lint violations make ``buf`` exit
    non-zero (code 100); that is the *normal* outcome here — its JSON findings are returned.
    An operational failure (``buf`` absent, a timeout, a proto that does not build) raises
    :class:`ProtoLintError` instead.

    Args:
        files: The ``.proto`` files to lint (each :class:`~app.proto_descriptor.ProtoFile` with
            a module-relative path). Must be non-empty.
        runner: The toolchain runner to use; defaults to the shared default. Injectable for
            tests. May also be a :class:`~app.external_linter_runner.RestrictedRunner`.
        timeout: Optional per-call timeout in seconds; falls back to the tool/service default.
        policy: Optional sandbox policy override; falls back to the runner's default.

    Returns:
        The parsed ``buf lint`` finding dicts (empty when the sample is clean), ready for
        :func:`buf_findings`.

    Raises:
        ProtoLintError: If ``files`` is empty, ``buf`` is unavailable in this runtime (MFI-5.2),
            it times out, or it fails to build the module (syntax error / unresolved import).
        app.proto_descriptor.ProtoCompileError: If a file carries an unsafe/duplicate path.
    """
    # Imported lazily so importing this pack (e.g. for native-rule registration on the always-on
    # lint path) never pulls in the toolchain/descriptor / adapter machinery.
    from .external_linter_adapter import (
        AdapterInput,
        BufLintAdapter,
        InputFormat,
        ScanMode,
        run_adapter,
    )
    from .external_linter_runner import (
        FAILURE_CRASH,
        FAILURE_FAILED,
        FAILURE_TIMEOUT,
        FAILURE_UNAVAILABLE,
        RestrictedRunner,
        default_restricted_runner,
    )

    file_list = list(files)
    if not file_list:
        raise ProtoLintError("At least one .proto file is required to lint")

    if runner is None:
        restricted: RestrictedRunner = default_restricted_runner
    elif isinstance(runner, RestrictedRunner):
        restricted = runner
    else:
        restricted = RestrictedRunner(inner=runner)

    file_map = {str(f.path): str(f.content) for f in file_list}
    try:
        result = await run_adapter(
            BufLintAdapter(),
            AdapterInput(
                files=file_map,
                format=InputFormat.PROTOBUF,
                scan_mode=ScanMode.LINT,
            ),
            runner=restricted,
            timeout=timeout,
            policy=policy,
        )
    except Exception as exc:
        # ProtoCompileError (unsafe path) and unexpected errors surface unchanged.
        from .proto_descriptor import ProtoCompileError

        if isinstance(exc, ProtoCompileError):
            raise
        raise ProtoLintError(f"buf lint failed: {exc}") from exc

    if result.failure_kind == FAILURE_UNAVAILABLE:
        raise ProtoLintError(
            "The 'buf' tool is not available in this runtime; protobuf/gRPC lint is "
            "unavailable here (see the bundled toolchain packaging, MFI-5.2)."
        )
    if result.failure_kind == FAILURE_TIMEOUT:
        raise ProtoLintError(
            f"buf lint timed out: {result.diagnostics or 'timeout'}"
        )
    if result.failure_kind in (FAILURE_CRASH, FAILURE_FAILED):
        # Prefer stderr/stdout diagnostics the way the pre-SPI path did.
        diagnostics = (
            (result.stderr.strip() or result.stdout.strip()) or result.diagnostics
        ) or None
        # Exit 100 with no parseable rows is still the violations-exit convention.
        if result.exit_code == _BUF_LINT_VIOLATIONS_EXIT:
            return list(result.raw_findings)
        raise ProtoLintError(
            "buf lint failed to process the supplied .proto files",
            diagnostics=diagnostics,
        )
    if result.failure_kind:
        raise ProtoLintError(
            f"buf lint failed: {result.diagnostics or result.failure_kind}"
        )

    return list(result.raw_findings)


# ===========================================================================
# Merge entry points
# ===========================================================================


def lint_protobuf_result(
    model: CanonicalApi,
    buf_report: Any = None,
) -> LintResult:
    """Lint a Protobuf model, merging ``buf lint`` findings into the score when available.

    Combines three sources through the shared engine so the score, grade, and
    ``report_fingerprint`` use the exact same formula as every other format:

    * the always-on :class:`~app.lint_engine.CommonRulePack` (cross-format hygiene),
    * the registered :class:`ProtobufRulePack` (native Protobuf rules), looked up by the model's
      ``protobuf`` format, and
    * the ``buf lint`` output in ``buf_report`` (from :func:`run_buf_lint`), if any.

    Args:
        model: The canonical Protobuf artifact (from the MFI-9.2 normalizer). Not mutated.
        buf_report: Optional parsed ``buf lint`` output (see :func:`buf_findings`). When ``None``
            / empty, ``buf`` contributes nothing and the report degrades gracefully to the
            native + common packs.

    Returns:
        A deterministic :class:`~app.schema_lint.LintResult`.
    """
    return lint_canonical_model(model, extra_findings=buf_findings(buf_report))


async def lint_protobuf(
    files: "Any",
    *,
    runner: "Any" = None,
    timeout: Optional[float] = None,
    policy: "Any" = None,
) -> LintResult:
    """Compile, lint with ``buf``, normalize, and score raw ``.proto`` source end-to-end.

    A convenience that ties MFI-9.1 (``buf build`` → descriptor set), this pack's
    :func:`run_buf_lint`, and MFI-9.2 (normalize) together: it compiles ``files`` to a descriptor
    set and normalizes it into the canonical model, runs ``buf lint`` over the same sources, then
    merges everything via :func:`lint_protobuf_result`. The MFI-9.6 import pipeline, which
    already holds the normalized model, calls :func:`lint_protobuf_result` directly with a
    previously-obtained :func:`run_buf_lint` report instead.

    Args:
        files: The ``.proto`` files to lint (each :class:`~app.proto_descriptor.ProtoFile`).
        runner: Optional toolchain runner override (injectable for tests); defaults to the
            shared runner.
        timeout: Optional per-call timeout in seconds.
        policy: Optional sandbox policy override.

    Returns:
        A deterministic :class:`~app.schema_lint.LintResult`.

    Raises:
        app.proto_descriptor.ProtoCompileError: If the sources do not compile (so there is no
            model to lint).
        ProtoLintError: If ``buf lint`` cannot be run (unavailable / timeout / build failure).
    """
    # Imported lazily so importing this pack for native-rule registration never pulls in the
    # compiler/normalizer machinery.
    from .proto_descriptor import compile_proto_descriptor_set
    from .proto_normalizer import ProtoNormalizer

    compiled = await compile_proto_descriptor_set(
        files, runner=runner, timeout=timeout, policy=policy
    )
    model = ProtoNormalizer().normalize(compiled)
    buf_report = await run_buf_lint(files, runner=runner, timeout=timeout, policy=policy)
    return lint_protobuf_result(model, buf_report)
