"""Scenario override and chaos settings for the hosted mock (#4454 SIM-4.2, #4455 SIM-4.3).

Scenario definitions live in ``versions.mock_settings`` under the
``"scenarios"`` key and are served at runtime by apiome-mock. This module owns
the author-time contract:

* structural limits (scenario count, name shape, sequence length, total size);
* spec conformance — each canned response is checked against the version's
  generated OpenAPI document (operation exists, status defined, media type
  declared, body matches the response schema) unless the response opts out
  with the explicit ``offSpec`` flag (deliberately broken responses);
* canonicalization into the storage shape read by ``apiome_mock.scenarios``.

The version's *active scenario* (#5531, MSC-2.1) — the sibling ``"activeScenario"``
key, which the runtime applies to every request that sends no ``X-Mock-Scenario``
header — is owned here too: it is validated against the scenarios in the same
write, so a version can never store a default that names nothing.

Chaos knobs (#4455, SIM-4.3) — per-route/version-default latency and error
injection — live under the sibling ``"chaos"`` key (and optionally inside a
scenario), validated and canonicalized here with the same rules; value
ranges (delay/jitter <= 30s, error rate 0-100%) are enforced by the
``MockChaosKnobsSpec`` pydantic model.

Declarative rules and templates (#4744, PMR-2.1): an operation override may
carry ordered ``rules`` — request predicates (``when``) validated by
``app.mock_match`` plus the responses they select — and any response body or
header value may embed the bounded ``{{ ... }}`` templates validated by
``app.mock_template``. Templated bodies skip the response-schema conformance
check (their rendered values are request-dependent) but still validate
status, media type, and template syntax, so a scenario that saves cleanly
can never contain an unparseable template.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .mock_data_generator import validate_value
from .mock_engine import MockOperation, extract_operations
from .mock_match import validate_when
from .mock_template import validate_template_text, validate_template_value, value_contains_template
from .models import (
    MockChaosKnobsSpec,
    MockChaosSpec,
    MockScenarioOperationSpec,
    MockScenarioResponseSpec,
    MockScenarioSpec,
)

MAX_SCENARIOS = 50
"""Maximum named scenarios per version."""

MAX_OPERATIONS_PER_SCENARIO = 100
"""Maximum operation overrides per scenario."""

MAX_SETTINGS_BYTES = 262_144
"""Maximum serialized size (bytes) of the scenarios blob (256 KiB)."""

MAX_CHAOS_OPERATIONS = 100
"""Maximum per-route chaos overrides in one chaos block."""

SCENARIO_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
"""Header-safe scenario names: alphanumeric start, then ``[A-Za-z0-9._-]``, max 64 chars."""

_HEADER_NAME_PATTERN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_RESERVED_HEADERS = frozenset({"content-length", "transfer-encoding", "connection"})


def normalize_operation_key(raw: str) -> Optional[str]:
    """Normalize an operation key to canonical ``"METHOD /template"`` form.

    Mirrors ``apiome_mock.scenarios.normalize_operation_key`` so author-time
    validation and the runtime agree on the key shape. Returns ``None`` when
    ``raw`` is not a ``"method path"`` string.
    """
    parts = raw.strip().split(None, 1)
    if len(parts) != 2:
        return None
    method, path = parts
    if not method.isalpha() or not path.startswith("/"):
        return None
    return f"{method.upper()} {path}"


def _deref(node: Any, spec: Mapping[str, Any]) -> Any:
    """Resolve a local ``$ref`` (``#/...``) one level deep; pass through otherwise."""
    if not isinstance(node, dict):
        return node
    ref = node.get("$ref")
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return node
    target: Any = spec
    for segment in ref[2:].split("/"):
        if not isinstance(target, dict) or segment not in target:
            return node
        target = target[segment]
    return target


def _response_object_for_status(
    operation: Mapping[str, Any], status: int, spec: Mapping[str, Any]
) -> Optional[Dict[str, Any]]:
    """Locate the operation's response object for ``status`` (exact match only)."""
    responses = operation.get("responses")
    if not isinstance(responses, dict):
        return None
    response_obj = responses.get(str(status))
    if response_obj is None:
        return None
    resolved = _deref(response_obj, spec)
    return resolved if isinstance(resolved, dict) else None


def _validate_headers(
    headers: Mapping[str, str], *, context: str, errors: List[str]
) -> None:
    """Reject malformed or reserved header names and control characters in values."""
    for name, value in headers.items():
        if not _HEADER_NAME_PATTERN.match(name):
            errors.append(f"{context}: invalid header name '{name}'.")
        elif name.lower() in _RESERVED_HEADERS:
            errors.append(f"{context}: header '{name}' is managed by the server and cannot be overridden.")
        if "\r" in value or "\n" in value:
            errors.append(f"{context}: header '{name}' value must not contain CR/LF characters.")


def _validate_response_against_spec(
    response: MockScenarioResponseSpec,
    *,
    operation: MockOperation,
    spec: Mapping[str, Any],
    context: str,
    errors: List[str],
) -> None:
    """Check one canned response against the operation's spec response schemas."""
    response_obj = _response_object_for_status(operation.operation, response.status, spec)
    if response_obj is None:
        errors.append(
            f"{context}: status {response.status} is not defined for {operation.key} "
            "(set offSpec to allow a deliberately off-spec response)."
        )
        return

    has_body = "body" in response.model_fields_set
    if not has_body:
        return

    content = response_obj.get("content")
    if not isinstance(content, dict) or not content:
        errors.append(
            f"{context}: {operation.key} status {response.status} declares no response content, "
            "but a body was provided (set offSpec to allow it)."
        )
        return

    media_type = response.media_type or "application/json"
    media_obj = content.get(media_type)
    if media_obj is None:
        declared = ", ".join(sorted(content))
        errors.append(
            f"{context}: media type '{media_type}' is not declared for {operation.key} "
            f"status {response.status} (declared: {declared}; set offSpec to allow it)."
        )
        return

    schema = media_obj.get("schema") if isinstance(media_obj, dict) else None
    if not isinstance(schema, dict):
        return
    if value_contains_template(response.body):
        # A templated body renders per request (#4744, PMR-2.1), so its final
        # values cannot be checked against the response schema at save time.
        # Template syntax is still validated in _validate_response_entry, and
        # the status/media-type checks above still apply.
        return
    validation_error = validate_value(response.body, schema, dict(spec))
    if validation_error is not None:
        errors.append(
            f"{context}: body does not match the {operation.key} status {response.status} "
            f"response schema ({validation_error}); set offSpec to store it anyway."
        )


def _validate_response_entry(
    response: MockScenarioResponseSpec,
    *,
    operation: MockOperation,
    spec: Mapping[str, Any],
    context: str,
    errors: List[str],
) -> None:
    """Run every save-time check for one canned response.

    Headers are checked for shape and CR/LF safety, header values and the body
    for template validity (#4744, PMR-2.1), and — unless the response opts out
    with ``offSpec`` — the response is checked against the operation's spec.
    """
    _validate_headers(response.headers, context=context, errors=errors)
    for name, value in response.headers.items():
        errors.extend(validate_template_text(value, context=f"{context}, header '{name}'"))
    if "body" in response.model_fields_set:
        errors.extend(validate_template_value(response.body, context=f"{context}, body"))
    if not response.off_spec:
        _validate_response_against_spec(
            response,
            operation=operation,
            spec=spec,
            context=context,
            errors=errors,
        )


def _validate_operation_override(
    override: MockScenarioOperationSpec,
    *,
    operation: MockOperation,
    spec: Mapping[str, Any],
    context: str,
    errors: List[str],
) -> None:
    """Validate one operation override: its rules (#4744, PMR-2.1) and fallback responses."""
    for rule_index, rule in enumerate(override.rules):
        rule_context = f"{context}, rule {rule_index + 1}"
        errors.extend(validate_when(rule.when.to_storage(), context=f"{rule_context} when"))
        for response_index, response in enumerate(rule.responses):
            _validate_response_entry(
                response,
                operation=operation,
                spec=spec,
                context=f"{rule_context}, response {response_index + 1}",
                errors=errors,
            )
    for index, response in enumerate(override.responses):
        _validate_response_entry(
            response,
            operation=operation,
            spec=spec,
            context=f"{context}, response {index + 1}",
            errors=errors,
        )


def validate_mock_chaos(
    chaos: Optional[MockChaosSpec],
    spec: Mapping[str, Any],
    *,
    context: str = "Chaos",
    operations_by_key: Optional[Mapping[str, MockOperation]] = None,
) -> List[str]:
    """Validate one chaos block against structural limits and the OpenAPI spec.

    Args:
        chaos: The chaos block to validate; ``None`` is valid (no chaos).
        spec: The version's generated OpenAPI document.
        context: Prefix for error messages (e.g. ``"Scenario 'degraded' chaos"``).
        operations_by_key: Pre-extracted operations, to avoid re-extracting
            when validating many blocks against the same spec.

    Returns:
        A list of human-readable error strings; empty when everything is valid.
    """
    if chaos is None:
        return []

    errors: List[str] = []
    if operations_by_key is None:
        operations_by_key = {op.key: op for op in extract_operations(dict(spec))}

    if len(chaos.operations) > MAX_CHAOS_OPERATIONS:
        errors.append(f"{context}: at most {MAX_CHAOS_OPERATIONS} per-route chaos overrides are allowed.")

    for op_key_raw in chaos.operations:
        op_key = normalize_operation_key(op_key_raw)
        if op_key is None:
            errors.append(f"{context}, operation '{op_key_raw}': operation keys must look like 'GET /pets/{{petId}}'.")
            continue
        if op_key not in operations_by_key:
            errors.append(f"{context}, operation '{op_key_raw}': no operation {op_key} exists in this version's spec.")

    return errors


def validate_mock_scenarios(
    scenarios: Mapping[str, MockScenarioSpec],
    spec: Mapping[str, Any],
) -> List[str]:
    """Validate scenario definitions against structural limits and the OpenAPI spec.

    Args:
        scenarios: Parsed scenario definitions keyed by scenario name.
        spec: The version's generated OpenAPI document.

    Returns:
        A list of human-readable error strings; empty when everything is valid.
    """
    errors: List[str] = []

    if len(scenarios) > MAX_SCENARIOS:
        errors.append(f"At most {MAX_SCENARIOS} scenarios are allowed per version.")

    operations_by_key = {op.key: op for op in extract_operations(dict(spec))}

    for name, scenario in scenarios.items():
        if not SCENARIO_NAME_PATTERN.match(name):
            errors.append(
                f"Scenario name '{name}' is invalid: use 1-64 characters from "
                "[A-Za-z0-9._-], starting with a letter or digit."
            )
        if len(scenario.operations) > MAX_OPERATIONS_PER_SCENARIO:
            errors.append(
                f"Scenario '{name}': at most {MAX_OPERATIONS_PER_SCENARIO} operation overrides are allowed."
            )
        for op_key_raw, override in scenario.operations.items():
            context = f"Scenario '{name}', operation '{op_key_raw}'"
            op_key = normalize_operation_key(op_key_raw)
            if op_key is None:
                errors.append(f"{context}: operation keys must look like 'GET /pets/{{petId}}'.")
                continue
            operation = operations_by_key.get(op_key)
            if operation is None:
                errors.append(f"{context}: no operation {op_key} exists in this version's spec.")
                continue
            _validate_operation_override(
                override,
                operation=operation,
                spec=spec,
                context=context,
                errors=errors,
            )
        errors.extend(
            validate_mock_chaos(
                scenario.chaos,
                spec,
                context=f"Scenario '{name}' chaos",
                operations_by_key=operations_by_key,
            )
        )

    storage = scenarios_to_storage(scenarios)
    serialized_size = len(json.dumps(storage, separators=(",", ":"), default=str).encode("utf-8"))
    if serialized_size > MAX_SETTINGS_BYTES:
        errors.append(
            f"Scenario definitions are too large ({serialized_size} bytes; max {MAX_SETTINGS_BYTES})."
        )

    return errors


def _response_to_storage(response: MockScenarioResponseSpec) -> Dict[str, Any]:
    """Canonicalize one response into the JSONB shape read by apiome-mock."""
    out: Dict[str, Any] = {"status": response.status}
    if response.headers:
        out["headers"] = dict(response.headers)
    if "body" in response.model_fields_set:
        out["body"] = response.body
    if response.media_type:
        out["mediaType"] = response.media_type
    if response.off_spec:
        out["offSpec"] = True
    return out


def _override_to_storage(override: MockScenarioOperationSpec) -> Dict[str, Any]:
    """Canonicalize one operation override (rules first, then fallback responses)."""
    out: Dict[str, Any] = {}
    if override.rules:
        out["rules"] = [
            {
                "when": rule.when.to_storage(),
                "responses": [_response_to_storage(response) for response in rule.responses],
            }
            for rule in override.rules
        ]
    if override.responses or not override.rules:
        out["responses"] = [_response_to_storage(response) for response in override.responses]
    return out


def _chaos_knobs_to_storage(knobs: MockChaosKnobsSpec) -> Dict[str, Any]:
    """Canonicalize one knob set, omitting unset knobs so they keep inheriting."""
    out: Dict[str, Any] = {}
    if knobs.delay_ms is not None:
        out["delayMs"] = knobs.delay_ms
    if knobs.jitter_ms is not None:
        out["jitterMs"] = knobs.jitter_ms
    if knobs.error_rate is not None:
        out["errorRate"] = knobs.error_rate
    return out


def chaos_to_storage(chaos: MockChaosSpec) -> Dict[str, Any]:
    """Canonicalize one chaos block into the ``mock_settings.chaos`` shape.

    Operation keys are normalized to ``"METHOD /template"`` so the runtime's
    exact-match lookup always hits.
    """
    out: Dict[str, Any] = {}
    if chaos.default is not None:
        out["default"] = _chaos_knobs_to_storage(chaos.default)
    if chaos.operations:
        out["operations"] = {
            (normalize_operation_key(op_key_raw) or op_key_raw): _chaos_knobs_to_storage(knobs)
            for op_key_raw, knobs in chaos.operations.items()
        }
    return out


def scenarios_to_storage(scenarios: Mapping[str, MockScenarioSpec]) -> Dict[str, Any]:
    """Canonicalize scenario definitions into the ``mock_settings.scenarios`` shape.

    Operation keys are normalized to ``"METHOD /template"`` so the runtime's
    exact-match lookup always hits.
    """
    out: Dict[str, Any] = {}
    for name, scenario in scenarios.items():
        operations: Dict[str, Any] = {}
        for op_key_raw, override in scenario.operations.items():
            op_key = normalize_operation_key(op_key_raw) or op_key_raw
            operations[op_key] = _override_to_storage(override)
        entry: Dict[str, Any] = {"operations": operations}
        if scenario.description:
            entry["description"] = scenario.description
        if scenario.chaos is not None:
            entry["chaos"] = chaos_to_storage(scenario.chaos)
        out[name] = entry
    return out


def scenarios_from_storage(mock_settings: Any) -> Tuple[Dict[str, Any], bool]:
    """Extract the stored ``scenarios`` mapping from a raw ``mock_settings`` value.

    Returns ``(scenarios, valid)`` where ``valid`` is ``False`` when the stored
    blob is not a mapping (the caller should treat it as empty).
    """
    settings: Any = mock_settings
    if settings is None:
        return {}, True
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            return {}, False
    if not isinstance(settings, dict):
        return {}, False
    scenarios = settings.get("scenarios")
    if scenarios is None:
        return {}, True
    if not isinstance(scenarios, dict):
        return {}, False
    return scenarios, True


def validate_active_scenario(
    active_scenario: Optional[str],
    scenarios: Mapping[str, MockScenarioSpec],
) -> List[str]:
    """Validate the version's active scenario against the scenarios being saved (#5531, MSC-2.1).

    The runtime is lenient with a stored name it cannot resolve — it warns and serves the default
    flow rather than failing the request — which is exactly why the *author-time* check has to be
    strict: a silently inert default is the failure mode this ticket exists to remove, so the one
    moment it can be caught and reported is the save.

    Args:
        active_scenario: The proposed active scenario name, or ``None`` for "no default".
        scenarios: The scenario definitions being saved in the same request.

    Returns:
        A list of human-readable error strings; empty when the value is valid.
    """
    if active_scenario is None:
        return []
    name = active_scenario.strip()
    if not name:
        return ["activeScenario must name a scenario, or be null to clear it."]
    if name not in scenarios:
        available = ", ".join(f"'{key}'" for key in sorted(scenarios)) or "none are defined"
        return [f"activeScenario '{name}' is not one of this version's scenarios ({available})."]
    return []


def active_scenario_from_storage(mock_settings: Any) -> Optional[str]:
    """Extract the stored ``activeScenario`` from a raw ``mock_settings`` value (#5531, MSC-2.1).

    Mirrors ``apiome_mock.scenarios.parse_active_scenario`` so the editor reports exactly what the
    runtime would apply — including reporting "none" for a stored value the runtime would ignore.

    Args:
        mock_settings: The raw ``versions.mock_settings`` value (dict, JSON text, or ``None``).

    Returns:
        The trimmed scenario name, or ``None`` when none is stored or the stored value is not a
        non-empty string.
    """
    settings: Any = mock_settings
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            return None
    if not isinstance(settings, dict):
        return None
    raw = settings.get("activeScenario")
    if not isinstance(raw, str):
        return None
    name = raw.strip()
    return name or None


def chaos_from_storage(mock_settings: Any) -> Tuple[Optional[Dict[str, Any]], bool]:
    """Extract the stored ``chaos`` mapping from a raw ``mock_settings`` value.

    Returns ``(chaos, valid)`` where ``chaos`` is ``None`` when no chaos is
    stored and ``valid`` is ``False`` when the stored blob is not a mapping
    (the caller should treat it as absent).
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
    chaos = settings.get("chaos")
    if chaos is None:
        return None, True
    if not isinstance(chaos, dict):
        return None, False
    return chaos, True
