"""Response-correlation settings for the hosted mock (#5527, MSC-1.1).

Correlation makes the mock answer ``GET /pets/42`` with an id of ``42`` **without the caller
sending any header**, which is what a generated SDK or a browser app needs. The settings live in
``versions.mock_settings`` under the ``"responseCorrelation"`` key and are applied at serve time by
:mod:`apiome_mock.correlation`; this module owns the author-time contract:

* the accepted ``mode`` values and what each one implies;
* structural limits (operation count, pointers per operation, total size);
* spec conformance — every operation key must name an operation this version actually has;
* pointer and template validity — every explicit expression is parsed by
  :func:`app.mock_template.validate_template_value`, so a bad expression is a 422 on save rather
  than a surprise at serve time;
* canonicalization into the storage shape the runtime reads.

The engine itself is *not* reimplemented here. Correlation is a binding of the existing bounded
template language onto the default response path plus an inference pass, and it lives in exactly
one place — apiome-mock — so the hosted and portable runtimes cannot drift.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .mock_correlation_rules import CORRELATION_MODES
from .mock_routing import MockOperation, extract_operations
from .mock_scenario_settings import normalize_operation_key
from .mock_template import validate_template_value
from .models import MockResponseCorrelationSpec

__all__ = [
    "CORRELATION_MODES",
    "MAX_CORRELATION_BYTES",
    "MAX_CORRELATION_OPERATIONS",
    "MAX_POINTERS_PER_OPERATION",
    "correlation_from_storage",
    "correlation_to_storage",
    "validate_mock_correlation",
]

MAX_CORRELATION_OPERATIONS = 200
"""Maximum operation entries in one explicit pointer map (matches the runtime's read cap)."""

MAX_POINTERS_PER_OPERATION = 50
"""Maximum pointer bindings per operation (matches the runtime's read cap)."""

MAX_CORRELATION_BYTES = 65_536
"""Maximum serialized size (bytes) of the canonical correlation block (64 KiB)."""


def _validate_pointer(pointer: str, *, context: str, errors: List[str]) -> None:
    """Check one RFC 6901 pointer key: ``""`` (the whole body) or a ``/``-rooted path."""
    if pointer != "" and not pointer.startswith("/"):
        errors.append(f'{context}: JSON Pointer must be "" or start with "/" (got "{pointer}").')


def validate_mock_correlation(
    correlation: Optional[MockResponseCorrelationSpec],
    spec: Mapping[str, Any],
    *,
    context: str = "Correlation",
    operations_by_key: Optional[Mapping[str, MockOperation]] = None,
) -> List[str]:
    """Validate one correlation block against structural limits, the spec, and template syntax.

    Args:
        correlation: The block to validate; ``None`` is valid (correlation stays off).
        spec: The version's generated OpenAPI document.
        context: Prefix for error messages.
        operations_by_key: Pre-extracted operations, to avoid re-extracting when validating several
            blocks against the same spec.

    Returns:
        A list of human-readable error strings; empty when everything is valid.
    """
    if correlation is None:
        return []

    errors: List[str] = []
    if correlation.mode not in CORRELATION_MODES:
        allowed = ", ".join(CORRELATION_MODES)
        errors.append(f"{context}: unknown mode '{correlation.mode}' (allowed: {allowed}).")

    if correlation.mode == "off" and correlation.operations:
        # The runtime drops the whole block when the mode is off, so bindings saved alongside it
        # would never run. Refusing them here is what keeps this from becoming another config
        # surface that silently does nothing.
        errors.append(
            f"{context}: mode 'off' cannot carry operation bindings — they would never run. "
            "Choose 'explicit' to apply only the pointer map."
        )

    if len(correlation.operations) > MAX_CORRELATION_OPERATIONS:
        errors.append(f"{context}: at most {MAX_CORRELATION_OPERATIONS} operation bindings are allowed.")

    if operations_by_key is None:
        operations_by_key = {op.key: op for op in extract_operations(dict(spec))}

    for op_key_raw, pointers in correlation.operations.items():
        op_context = f"{context}, operation '{op_key_raw}'"
        op_key = normalize_operation_key(op_key_raw)
        if op_key is None:
            errors.append(f"{op_context}: operation keys must look like 'GET /pets/{{petId}}'.")
            continue
        if op_key not in operations_by_key:
            errors.append(f"{op_context}: no operation {op_key} exists in this version's spec.")
            continue
        if not pointers:
            errors.append(f"{op_context}: declares no pointer bindings.")
            continue
        if len(pointers) > MAX_POINTERS_PER_OPERATION:
            errors.append(f"{op_context}: at most {MAX_POINTERS_PER_OPERATION} pointer bindings are allowed.")
        for pointer, expression in pointers.items():
            pointer_context = f"{op_context}, pointer '{pointer}'"
            _validate_pointer(pointer, context=pointer_context, errors=errors)
            errors.extend(validate_template_value(expression, context=pointer_context))

    storage = correlation_to_storage(correlation)
    serialized_size = len(json.dumps(storage, separators=(",", ":"), default=str).encode("utf-8"))
    if serialized_size > MAX_CORRELATION_BYTES:
        errors.append(
            f"{context}: the correlation block is too large ({serialized_size} bytes; "
            f"max {MAX_CORRELATION_BYTES})."
        )
    return errors


def correlation_to_storage(correlation: MockResponseCorrelationSpec) -> Dict[str, Any]:
    """Canonicalize a correlation block into the ``mock_settings.responseCorrelation`` shape.

    Operation keys are normalized to ``"METHOD /template"`` so the runtime's exact-match lookup
    always hits, and an empty ``operations`` map is omitted so an inference-only block stores as
    just its mode.

    Args:
        correlation: The validated block.

    Returns:
        The canonical JSON-serializable storage value.
    """
    out: Dict[str, Any] = {"mode": correlation.mode}
    if correlation.operations:
        out["operations"] = {
            (normalize_operation_key(op_key_raw) or op_key_raw): dict(pointers)
            for op_key_raw, pointers in correlation.operations.items()
        }
    return out


def correlation_from_storage(mock_settings: Any) -> Tuple[Optional[Dict[str, Any]], bool]:
    """Extract the stored ``responseCorrelation`` block from a raw ``mock_settings`` value.

    Args:
        mock_settings: The raw ``versions.mock_settings`` JSONB value (dict, JSON text, or ``None``).

    Returns:
        ``(correlation, valid)`` — ``correlation`` is ``None`` when nothing is stored, and ``valid``
        is ``False`` when the stored blob is not a mapping (the caller should treat it as absent).
    """
    settings: Any = mock_settings
    if settings is None:
        return None, True
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            return None, False
    if not isinstance(settings, dict):
        return None, False
    correlation = settings.get("responseCorrelation")
    if correlation is None:
        return None, True
    if not isinstance(correlation, dict):
        return None, False
    return correlation, True
