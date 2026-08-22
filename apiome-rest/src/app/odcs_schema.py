"""ODCS JSON Schema vocabulary and validation — FMT-5.2 (#5440).

The rules the published Open Data Contract Standard JSON Schema enforces on a data
contract, available to both halves of the ODCS round trip: :mod:`app.odcs_emitter`
builds documents that satisfy them, and :func:`validate_odcs_document` re-checks a
finished document against them independently of how it was produced.

**Why the schema is vendored rather than restated.** Every other "the target's own
validator is not in this runtime" case in this fleet (``deck validate`` for Kong, the
``HTTPRoute`` CRD for Gateway API) had to be re-expressed in Python because the
authority is a Go binary or a cluster. ODCS's authority is *a JSON Schema document*,
and this service already validates JSON Schema — so the honest implementation is to
ship the published file and run it, exactly as :mod:`app.openapi_validator` does with
the OpenAPI meta-schema. The two files under ``data/`` are the upstream
``bitol-io/open-data-contract-standard`` releases, byte for byte:

* ``data/odcs_3_0_2_schema.json`` — ``schema/odcs-json-schema-v3.0.2.json``
* ``data/odcs_3_1_0_schema.json`` — ``schema/odcs-json-schema-v3.1.0.json``

Both are self-contained (every ``$ref`` is a local ``#/$defs`` pointer), so validation
is fully offline — no network fetch, ever.

**Two schemas, because v3.0 and v3.1 are not the same document.** The v3.x *reader*
(FMT-5.1) does not branch on the minor version, and it is right not to: both lines
spell a dataset as ``schema[].properties[]`` and everything a reader consumes is
common. Validation is a stricter question and the two lines genuinely differ — v3.1
turned ``team`` from an array of members into an object with a ``members`` list,
closed ``quality`` with ``unevaluatedProperties: false`` (so the v3.0 ``rule:``
spelling no longer validates), and added the ``timestamp``/``time`` logical types.
A document is therefore validated against **the schema for the version it declares**,
which is the same rule :mod:`app.openapi_validator` applies to OpenAPI 3.1 vs 3.2.

**The JSON projection.** ODCS documents are usually YAML, and YAML's core schema types
an unquoted ``2026-01-15`` as a *date*, not a string — while the standard's schema
(a JSON Schema, describing the JSON serialization) says ``dateIn`` is a string. A
loaded YAML document is therefore projected onto its JSON equivalent before
validation: dates and timestamps become their ISO-8601 spellings, which is exactly
what a JSON serialization of the same document contains. Nothing else is coerced —
a genuinely wrong type still fails.
"""

from __future__ import annotations

import datetime
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from jsonschema.validators import Draft201909Validator
from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "DEFAULT_ODCS_API_VERSION",
    "LOGICAL_TYPE_OPTION_KEYS",
    "LOGICAL_TYPE_OPTION_SCHEMAS",
    "ODCS_LOGICAL_TYPES",
    "ODCS_SCHEMA_RELEASES",
    "OdcsSchemaViolation",
    "admitted_option_keys",
    "option_value_is_admitted",
    "json_projection",
    "load_odcs_schema",
    "odcs_document_violations",
    "schema_line_for",
    "validate_odcs_document",
]


# ===========================================================================
# Vendored schema files
# ===========================================================================

_DATA_DIR = Path(__file__).parent / "data"

#: ``major.minor`` line → the vendored release of the standard that validates it.
#: One entry per schema file; a line the fleet does not ship cannot be validated.
ODCS_SCHEMA_RELEASES: Dict[str, str] = {
    "3.0": "v3.0.2",
    "3.1": "v3.1.0",
}

_SCHEMA_PATHS: Dict[str, Path] = {
    "3.0": _DATA_DIR / "odcs_3_0_2_schema.json",
    "3.1": _DATA_DIR / "odcs_3_1_0_schema.json",
}

#: The line a document is validated against when it declares no readable ``apiVersion``.
#: The newest vendored line, because a contract this service *writes* declares it.
DEFAULT_SCHEMA_LINE = "3.1"

#: The ``apiVersion`` a contract this service authors declares when nothing sourced one.
DEFAULT_ODCS_API_VERSION = ODCS_SCHEMA_RELEASES[DEFAULT_SCHEMA_LINE]

#: ``apiVersion`` spelling, matching :mod:`app.odcs_contract`'s reader: an optional
#: ``v``, then two or three dot-separated numbers with an optional pre-release suffix.
_API_VERSION_RE = re.compile(r"^v?(?P<major>\d+)\.(?P<minor>\d+)(?:\.\d+)?(?:[-+][0-9A-Za-z.\-+]+)?$")

# Built once per line, on first use — a Draft 2019-09 validator over an 86 KB schema
# is not free to construct and every emit re-validates.
_VALIDATORS: Dict[str, Draft201909Validator] = {}


def load_odcs_schema(line: str = DEFAULT_SCHEMA_LINE) -> Dict[str, Any]:
    """Return the vendored ODCS JSON Schema document for one ``major.minor`` line.

    Args:
        line: The line key, one of :data:`ODCS_SCHEMA_RELEASES` (``"3.0"`` / ``"3.1"``).

    Returns:
        The schema document, freshly parsed so a caller cannot mutate a shared copy.

    Raises:
        KeyError: If no schema is vendored for ``line``.
    """
    path = _SCHEMA_PATHS[line]
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def schema_line_for(api_version: Any) -> str:
    """Return the schema line a declared ``apiVersion`` should be validated against.

    Args:
        api_version: The document's ``apiVersion`` value, of whatever type it had.

    Returns:
        The matching key of :data:`ODCS_SCHEMA_RELEASES`. A version inside a vendored
        line selects that line; anything else — a v2 contract, a v3 minor this fleet
        does not vendor, an unparseable string, a missing value — selects
        :data:`DEFAULT_SCHEMA_LINE`, so the document is still checked rather than
        waved through.
    """
    if not isinstance(api_version, str):
        return DEFAULT_SCHEMA_LINE
    match = _API_VERSION_RE.match(api_version.strip())
    if match is None:
        return DEFAULT_SCHEMA_LINE
    line = f"{int(match.group('major'))}.{int(match.group('minor'))}"
    return line if line in ODCS_SCHEMA_RELEASES else DEFAULT_SCHEMA_LINE


def _validator_for(line: str) -> Draft201909Validator:
    """Return the shared validator for one schema line, building it on first use."""
    cached = _VALIDATORS.get(line)
    if cached is None:
        cached = Draft201909Validator(load_odcs_schema(line))
        _VALIDATORS[line] = cached
    return cached


# ===========================================================================
# The logical-type vocabulary the emitter has to respect
# ===========================================================================

#: ``logicalType`` values the standard admits on a property, per schema line. The v3.1
#: line added ``timestamp`` and ``time``; on v3.0 a point in time is spelled ``date``.
#: Read off the schemas' own enums rather than transcribed, so the two cannot drift.
ODCS_LOGICAL_TYPES: Dict[str, Tuple[str, ...]] = {
    line: tuple(
        load_odcs_schema(line)["$defs"]["SchemaBaseProperty"]["properties"]["logicalType"]["enum"]
    )
    for line in ODCS_SCHEMA_RELEASES
}

#: ``logicalType`` → the ``logicalTypeOptions`` keys the standard admits beside it, per
#: schema line.
#:
#: This is the constraint an emitter is most likely to get wrong, and it fails
#: *closed*: each branch of the schema declares ``additionalProperties: false``, so a
#: facet that is legal on a ``string`` (``maxLength``) invalidates the document on an
#: ``integer``. A ``logicalType`` absent from a line's mapping — ``boolean`` on both
#: lines — is unconstrained, because the schema declares no branch for it.
#:
#: **A property with no ``logicalType`` may carry no options at all.** Each branch's
#: ``if`` tests only the *value* of ``logicalType``, so an absent one satisfies every
#: branch at once and the admitted sets intersect to nothing. That is why the emitter
#: always writes a ``logicalType`` beside any options it writes.
#:
#: Derived from the schema files for the same reason as :data:`ODCS_LOGICAL_TYPES`.
LOGICAL_TYPE_OPTION_KEYS: Dict[str, Dict[str, frozenset]] = {}

#: ``logicalType`` → option key → the subschema the standard declares for it, per schema
#: line. The *key* being admitted is only half the rule, and the rest is more than a
#: type check: a ``date``'s ``minimum`` is a string (``"2020-01-01"``) while an
#: ``integer``'s is a number, and on the v3.1 line an ``integer``'s ``format`` is a
#: closed enum (``i8``…``u128``). Keeping the subschemas — rather than a transcription
#: of them — means the admission check is the standard's own rule, run by the same
#: validator that checks the finished document.
LOGICAL_TYPE_OPTION_SCHEMAS: Dict[str, Dict[str, Dict[str, Any]]] = {}


def _derive_option_keys() -> None:
    """Populate the two ``logicalTypeOptions`` tables from the vendored schema files.

    Walks each line's ``SchemaBaseProperty.allOf`` conditionals, reading the
    ``logicalType`` constants a branch fires on, the ``logicalTypeOptions``
    properties it then admits, and the subschema each of those declares.
    """
    for line in ODCS_SCHEMA_RELEASES:
        branches = load_odcs_schema(line)["$defs"]["SchemaBaseProperty"].get("allOf", [])
        per_line: Dict[str, frozenset] = {}
        schemas_per_line: Dict[str, Dict[str, Any]] = {}
        for branch in branches:
            condition = branch.get("if")
            if not isinstance(condition, dict):
                continue
            options = (branch.get("then", {}).get("properties") or {}).get("logicalTypeOptions")
            if not isinstance(options, dict):
                continue
            declared = options.get("properties", {})
            admitted = frozenset(declared)
            declared_schemas = {
                key: dict(schema)
                for key, schema in declared.items()
                if isinstance(schema, Mapping)
            }
            for logical_type in _logical_type_constants(condition):
                per_line[logical_type] = admitted
                schemas_per_line[logical_type] = declared_schemas
        LOGICAL_TYPE_OPTION_KEYS[line] = per_line
        LOGICAL_TYPE_OPTION_SCHEMAS[line] = schemas_per_line


def _logical_type_constants(condition: Mapping[str, Any]) -> List[str]:
    """Return the ``logicalType`` values one schema conditional fires on.

    Args:
        condition: A branch's ``if`` subschema, either a direct
            ``properties.logicalType.const`` or an ``anyOf`` of them.

    Returns:
        Every constant named, in declaration order; empty when the branch does not
        discriminate on ``logicalType``.
    """
    alternatives = condition.get("anyOf")
    if isinstance(alternatives, list):
        found: List[str] = []
        for alternative in alternatives:
            if isinstance(alternative, Mapping):
                found.extend(_logical_type_constants(alternative))
        return found
    declared = (condition.get("properties") or {}).get("logicalType")
    if isinstance(declared, Mapping) and isinstance(declared.get("const"), str):
        return [declared["const"]]
    return []


_derive_option_keys()


def admitted_option_keys(logical_type: Optional[str], line: str) -> Optional[frozenset]:
    """Return the ``logicalTypeOptions`` keys legal beside ``logical_type``.

    Args:
        logical_type: The property's declared logical type, or ``None``.
        line: The schema line key (see :data:`ODCS_SCHEMA_RELEASES`).

    Returns:
        The admitted key set; the empty set when ``logical_type`` is ``None`` (every
        branch applies at once and the sets intersect to nothing); and ``None`` when
        the type has no branch and therefore no restriction.
    """
    if logical_type is None:
        return frozenset()
    return LOGICAL_TYPE_OPTION_KEYS.get(line, {}).get(logical_type)


def option_value_is_admitted(logical_type: Optional[str], key: str, value: Any, line: str) -> bool:
    """Whether ``key: value`` may appear in ``logical_type``'s ``logicalTypeOptions``.

    Both halves of the rule are checked, and both are the standard's own: the key must
    be admitted beside this logical type, and the value must satisfy the subschema
    declared for it — which on the v3.1 line is more than a type check, because an
    ``integer``'s ``format`` is a closed enum (``i8``…``u128``) and a ``date``'s
    ``minimum`` is a string. Running the declared subschema through the same validator
    that checks the finished document is what keeps the emitter's filter and the
    document gate from ever disagreeing. A ``logicalType`` the schema declares no
    branch for (``boolean``) admits anything.

    Args:
        logical_type: The property's declared logical type, or ``None``.
        key: The option key.
        value: The option value.
        line: The schema line key (see :data:`ODCS_SCHEMA_RELEASES`).

    Returns:
        ``True`` when writing the pair keeps the document schema-valid.
    """
    admitted = admitted_option_keys(logical_type, line)
    if admitted is None:
        return True
    if key not in admitted:
        return False
    declared = LOGICAL_TYPE_OPTION_SCHEMAS.get(line, {}).get(logical_type or "", {}).get(key)
    if not declared:
        return True
    return _option_validator(line, logical_type or "", key, declared).is_valid(
        json_projection(value)
    )


# One validator per (line, logicalType, option) — an emit checks every facet of every
# column, and rebuilding a validator per value would dominate the emit cost.
_OPTION_VALIDATORS: Dict[Tuple[str, str, str], Draft201909Validator] = {}


def _option_validator(
    line: str, logical_type: str, key: str, declared: Dict[str, Any]
) -> Draft201909Validator:
    """Return the cached validator for one declared ``logicalTypeOptions`` subschema."""
    cache_key = (line, logical_type, key)
    cached = _OPTION_VALIDATORS.get(cache_key)
    if cached is None:
        cached = Draft201909Validator(declared)
        _OPTION_VALIDATORS[cache_key] = cached
    return cached


# ===========================================================================
# The JSON projection
# ===========================================================================


def json_projection(value: Any) -> Any:
    """Return ``value`` as its JSON serialization would spell it.

    YAML's core schema types an unquoted ``2026-01-15`` as a date and
    ``2026-01-15T00:00:00Z`` as a timestamp; the standard's JSON Schema describes the
    *JSON* document, where both are strings. Projecting before validation is what
    makes a legal YAML contract validate, without loosening any rule: only date and
    time scalars are rewritten, and only into the ISO-8601 spelling JSON would carry.

    Args:
        value: Any loaded document fragment.

    Returns:
        The same structure with date/time scalars rendered as ISO-8601 strings and
        tuples widened to lists. Every other value is returned unchanged.
    """
    if isinstance(value, Mapping):
        return {key: json_projection(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_projection(item) for item in value]
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, datetime.time):
        return value.isoformat()
    return value


# ===========================================================================
# Violations
# ===========================================================================


class OdcsSchemaViolation(BaseModel):
    """One place a document fails the ODCS JSON Schema.

    Attributes:
        path: RFC-6901 JSON Pointer to the offending value, ``""`` for the document
            root.
        message: The validator's message, verbatim.
        keyword: The schema keyword that rejected the value (``required``, ``enum``,
            ``unevaluatedProperties``, …).
    """

    model_config = ConfigDict(frozen=True)

    path: str = Field(description="RFC-6901 JSON Pointer to the offending value.")
    message: str = Field(description="The validator's message.")
    keyword: str = Field(description="The schema keyword that rejected the value.")


def _pointer(path: Any) -> str:
    """Render a jsonschema error path as an RFC-6901 JSON Pointer."""
    tokens = [str(part).replace("~", "~0").replace("/", "~1") for part in path]
    return "".join(f"/{token}" for token in tokens)


def odcs_document_violations(
    document: Any, *, line: Optional[str] = None
) -> List[OdcsSchemaViolation]:
    """Validate a loaded ODCS document against the vendored JSON Schema.

    Args:
        document: The loaded contract (a mapping for any real document).
        line: Force a schema line instead of reading the document's ``apiVersion``.
            Used by tests and by callers that already resolved the version.

    Returns:
        Every violation, sorted by pointer then message so two runs over the same
        document return an identical list. Empty when the document validates.
    """
    projected = json_projection(document)
    resolved = line or schema_line_for(
        projected.get("apiVersion") if isinstance(projected, Mapping) else None
    )
    errors = _validator_for(resolved).iter_errors(projected)
    violations = [
        OdcsSchemaViolation(
            path=_pointer(error.absolute_path),
            message=error.message,
            keyword=str(error.validator),
        )
        for error in errors
    ]
    return sorted(violations, key=lambda violation: (violation.path, violation.message))


def validate_odcs_document(content: str) -> None:
    """Parse and schema-validate an emitted ODCS contract.

    The emitted-artifact gate (MFX-5.1) calls this: it proves both halves of "this is
    a data contract" — that the ``odcs`` reader can read it back, and that it
    satisfies the published schema for the version it declares.

    Args:
        content: The emitted document text (YAML or its JSON serialization).

    Raises:
        ValueError: If the text does not parse as an ODCS contract, or if it fails
            the vendored JSON Schema. The message names every violation.
    """
    from .odcs_contract import OdcsParseError
    from .odcs_parser import load_odcs_document, parse_odcs

    try:
        document = load_odcs_document(content)
    except OdcsParseError as exc:
        raise ValueError(str(exc)) from exc
    if not isinstance(document, Mapping):
        raise ValueError("ODCS document must be a mapping.")

    try:
        parse_odcs(content)
    except OdcsParseError as exc:
        raise ValueError(str(exc)) from exc

    violations = odcs_document_violations(document)
    if violations:
        detail = "; ".join(
            f"{violation.path or '/'}: {violation.message}" for violation in violations[:10]
        )
        more = "" if len(violations) <= 10 else f" (+{len(violations) - 10} more)"
        raise ValueError(
            f"Emitted ODCS contract fails the ODCS "
            f"{ODCS_SCHEMA_RELEASES[schema_line_for(document.get('apiVersion'))]} "
            f"JSON Schema: {detail}{more}"
        )
