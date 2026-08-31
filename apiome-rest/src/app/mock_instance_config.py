"""Folding a legacy mock instance config into the one engine's settings shape (#5532, MSC-2.2).

Hosted mock instances (#3615, RC1-2.2) stored their configuration as a **list** of scenarios, each
carrying ``rules`` that targeted operations by ``operation`` / ``method`` / ``path`` and set some
subset of ``status``, ``latency_ms`` and ``body``. apiome-mock — now the only engine — reads a
**dict keyed by scenario name** whose entries map canonical ``"METHOD /template"`` operation keys to
overrides, with latency expressed as chaos. Same product concept, two spellings; this module is the
one-way translation between them.

It is deliberately **spec-aware**, which the storage shapes alone are not. Three legacy behaviours
cannot be reproduced without the frozen OpenAPI document the instance was provisioned with:

* a rule that sets a ``body`` but no ``status`` served the operation's *default success* status,
  which differs per operation (``201`` for a create, ``200`` elsewhere, ``204`` for a delete);
* rule precedence was *first rule wins per operation*, so a global rule listed first made every
  later specific rule unreachable — the opposite of the dict shape, where an exact key beats the
  wildcard. Resolving each operation against the ordered rule list removes the ambiguity entirely;
* a rule that matched no operation in the spec did nothing, and saying so is the difference between
  a migration report and a silent drop.

So the translation walks the spec's operations, asks the legacy matcher which rule (if any) claimed
each one, and emits the equivalent override. Identical overrides across *every* operation collapse
back to the wildcard key so the common case ("every endpoint returns 500") stays one entry rather
than one per route.

Nothing is dropped quietly. Every rule that could not be expressed — unreachable, matching nothing,
or setting nothing — is reported in :attr:`InstanceConfigFold.notes`, which the management API
surfaces on the instance and the operator backfill script prints.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .mock_routing import MockOperation, extract_operations

__all__ = [
    "ACTIVE_SCENARIO_KEY",
    "DEFAULT_SCENARIO_NAME",
    "LEGACY_BUILTIN_SCENARIO_NAMES",
    "MAX_LATENCY_MS",
    "InstanceConfigFold",
    "fold_instance_config",
    "legacy_scenario_names",
]

ACTIVE_SCENARIO_KEY = "activeScenario"
"""``mock_settings`` key holding the default scenario, introduced by #5531 (MSC-2.1).

The legacy instance config spelled the same concept ``active_scenario``; this is the whole of what
"migrate ``active_scenario`` onto the mechanism MSC-2.1 built" means in storage terms.
"""

DEFAULT_SCENARIO_NAME = "happy-path"
"""The scenario the legacy engine fell back to when none was selected."""

LEGACY_BUILTIN_SCENARIO_NAMES: frozenset[str] = frozenset(
    {"happy-path", "server-error", "not-found", "slow"}
)
"""Scenario names the legacy engine merged into every stored config.

``apiome_mock.builtin_scenarios`` now provides these on every version, so a stored copy that still
matches the original is redundant and is skipped rather than translated — translating it would
write four scenarios into every migrated instance that the runtime already supplies.
"""

MAX_LATENCY_MS = 30_000
"""Injected-latency ceiling, matching both the retired engine's cap and the chaos delay cap."""

@dataclass
class InstanceConfigFold:
    """The result of folding one instance's ``config`` into ``mock_settings``.

    Attributes:
        settings: The ``versions.mock_settings``-shaped mapping the sandbox now serves from —
            ``scenarios`` keyed by name, plus ``activeScenario`` when one was set.
        notes: Human-readable reports for everything that could not be translated. Empty means the
            fold was lossless.
        seed: The instance's stored generation seed, carried separately because apiome-mock takes
            a seed per request (``?__seed=``) rather than storing one.
    """

    settings: Dict[str, Any] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)
    seed: int = 0


def legacy_scenario_names(config: Mapping[str, Any]) -> List[str]:
    """List the scenario names a legacy config declares, in stored order.

    Args:
        config: The legacy ``mock_instances.config`` mapping.

    Returns:
        The declared names, skipping malformed entries. Built-in names the runtime now always
        supplies are *not* added here — callers that want the full servable set merge
        :data:`~apiome_mock.builtin_scenarios.BUILTIN_SCENARIO_NAMES` themselves.
    """
    names: List[str] = []
    for entry in _legacy_scenarios(config):
        name = entry.get("name")
        if isinstance(name, str) and name.strip() and name.strip() not in names:
            names.append(name.strip())
    return names


def _legacy_scenarios(config: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Extract the well-formed scenario entries from a legacy config."""
    raw = config.get("scenarios")
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, dict) and isinstance(entry.get("name"), str)]


def _is_untouched_builtin(entry: Mapping[str, Any]) -> bool:
    """Is this stored scenario a legacy built-in nobody customised?

    A stored built-in that still has the shape provisioning wrote is redundant now that the runtime
    supplies it. One that was edited — a ``server-error`` narrowed to a single route, say — is a
    real scenario and is translated like any other.
    """
    name = str(entry.get("name", "")).strip()
    if name not in LEGACY_BUILTIN_SCENARIO_NAMES:
        return False
    rules = entry.get("rules")
    rules = rules if isinstance(rules, list) else []
    if name == "happy-path":
        return not rules
    if name == "slow":
        return _rules_equal(rules, [{"operation": "*", "latency_ms": 1500}])
    status = 500 if name == "server-error" else 404
    code = "internal_error" if name == "server-error" else "not_found"
    message = "Simulated server error." if name == "server-error" else "Simulated not-found."
    return _rules_equal(
        rules,
        [
            {
                "operation": "*",
                "status": status,
                "body": {"error": {"code": code, "message": message}},
            }
        ],
    )


def _rules_equal(left: Sequence[Any], right: Sequence[Any]) -> bool:
    """Compare two rule lists by canonical JSON, so key order never matters."""
    return json.dumps(list(left), sort_keys=True, default=str) == json.dumps(
        list(right), sort_keys=True, default=str
    )


def _rule_targets(rule: Mapping[str, Any], op: MockOperation) -> bool:
    """Does a legacy ``rule`` target ``op``?

    Reproduces the retired engine's ``_rule_matches`` exactly: a rule targets an operation by its
    ``operation`` field (``"METHOD /template"`` or ``"*"``) or by separate ``method`` / ``path``
    fields, each ``"*"``-wildcardable. A rule with no targeting fields is global.
    """
    operation = rule.get("operation")
    if isinstance(operation, str):
        target = operation.strip()
        if target == "*":
            return True
        return target.upper() == op.key.upper()
    rule_method = rule.get("method")
    rule_path = rule.get("path")
    if rule_method is None and rule_path is None:
        return True
    method_ok = rule_method in (None, "*") or str(rule_method).upper() == op.method
    path_ok = rule_path in (None, "*") or str(rule_path) == op.path_template
    return method_ok and path_ok


def _default_success_status(operation: Mapping[str, Any]) -> int:
    """The status the legacy engine served when a rule set no status: lowest 2xx, else 200.

    Args:
        operation: The raw OpenAPI operation object.

    Returns:
        The default success status code.
    """
    responses = operation.get("responses")
    if not isinstance(responses, dict) or not responses:
        return 200
    success = sorted(int(code) for code in responses if str(code).isdigit() and 200 <= int(code) < 300)
    if success:
        return success[0]
    if "default" in responses:
        return 200
    first = sorted(responses.keys())[0]
    return int(first) if str(first).isdigit() else 200


def _rule_status(rule: Mapping[str, Any]) -> Optional[int]:
    """The rule's explicit status, or ``None`` when it sets none (or an impossible one)."""
    candidate = rule.get("status")
    if isinstance(candidate, bool) or not isinstance(candidate, int):
        return None
    return candidate if 100 <= candidate <= 599 else None


def _rule_latency_ms(rule: Mapping[str, Any]) -> int:
    """The rule's injected latency, clamped to :data:`MAX_LATENCY_MS`; ``0`` when it sets none."""
    candidate = rule.get("latency_ms")
    if isinstance(candidate, bool) or not isinstance(candidate, (int, float)):
        return 0
    if candidate <= 0:
        return 0
    return int(min(candidate, MAX_LATENCY_MS))


def _override_for(rule: Mapping[str, Any], op: MockOperation) -> Dict[str, Any]:
    """Translate one legacy rule into the override it becomes for one operation.

    Args:
        rule: The legacy rule that claimed this operation.
        op: The operation, whose spec supplies the default status a body-only rule relied on.

    Returns:
        The override mapping — a canned ``responses`` entry when the rule sets a body, a bare
        ``status`` pin when it sets only a status, or an empty mapping when the rule's only effect
        is latency (which becomes chaos, not an override).
    """
    status = _rule_status(rule)
    if "body" in rule:
        resolved = status if status is not None else _default_success_status(op.operation)
        return {"responses": [{"status": resolved, "body": rule["body"]}]}
    if status is not None:
        # Status without a body: pin the status and let the spec supply the body, which is what the
        # retired engine did by generating from the response object for that status.
        return {"status": status}
    return {}


def _compact(
    per_operation: Mapping[str, Dict[str, Any]], operation_count: int
) -> Dict[str, Any]:
    """Collapse identical per-operation overrides back onto the wildcard key.

    Args:
        per_operation: Override mapping keyed by canonical operation key.
        operation_count: How many operations the spec declares.

    Returns:
        Either the input unchanged, or a single ``{"*": override}`` entry when every operation in
        the spec resolved to the same override.
    """
    if not per_operation or len(per_operation) != operation_count:
        return dict(per_operation)
    canonical = {json.dumps(value, sort_keys=True, default=str) for value in per_operation.values()}
    if len(canonical) != 1:
        return dict(per_operation)
    return {"*": next(iter(per_operation.values()))}


def _compact_chaos(delays: Mapping[str, int], operation_count: int) -> Optional[Dict[str, Any]]:
    """Build the scenario's chaos block from per-operation delays, collapsing a uniform one.

    Args:
        delays: Non-zero injected delay in milliseconds, keyed by canonical operation key.
        operation_count: How many operations the spec declares.

    Returns:
        The chaos block, or ``None`` when no operation had a delay.
    """
    if not delays:
        return None
    if len(delays) == operation_count and len(set(delays.values())) == 1:
        return {"default": {"delayMs": next(iter(delays.values()))}}
    return {"operations": {key: {"delayMs": value} for key, value in delays.items()}}


def _fold_scenario(
    entry: Mapping[str, Any],
    operations: Sequence[MockOperation],
) -> Tuple[Dict[str, Any], List[str]]:
    """Fold one legacy scenario into its dict-keyed equivalent.

    Args:
        entry: The legacy scenario entry (``name``, ``description``, ``rules``).
        operations: The frozen spec's operations, in document order.

    Returns:
        ``(scenario, notes)`` — the translated scenario and any reports about rules that could not
        be expressed.
    """
    name = str(entry.get("name", "")).strip()
    rules = [rule for rule in (entry.get("rules") or []) if isinstance(rule, dict)]

    overrides: Dict[str, Dict[str, Any]] = {}
    delays: Dict[str, int] = {}
    claimed: set[int] = set()

    for op in operations:
        for index, rule in enumerate(rules):
            if not _rule_targets(rule, op):
                continue
            # First rule wins per operation, exactly as the retired engine resolved it.
            claimed.add(index)
            override = _override_for(rule, op)
            if override:
                overrides[op.key] = override
            latency = _rule_latency_ms(rule)
            if latency:
                delays[op.key] = latency
            break

    notes: List[str] = []
    for index, rule in enumerate(rules):
        label = f"Scenario '{name}', rule {index + 1}"
        if index not in claimed:
            notes.append(
                f"{label} ({_describe_target(rule)}) was not migrated: it matches no operation in "
                "the instance's frozen spec, or an earlier rule already claimed every operation it "
                "targets."
            )
            continue
        if not _rule_status(rule) and "body" not in rule and not _rule_latency_ms(rule):
            notes.append(
                f"{label} ({_describe_target(rule)}) was not migrated: it sets no status, body or "
                "latency, so it changed nothing."
            )
        raw_latency = rule.get("latency_ms")
        if isinstance(raw_latency, (int, float)) and not isinstance(raw_latency, bool) and raw_latency > MAX_LATENCY_MS:
            notes.append(
                f"{label} ({_describe_target(rule)}) had its latency clamped from {int(raw_latency)}ms "
                f"to the {MAX_LATENCY_MS}ms ceiling."
            )

    scenario: Dict[str, Any] = {
        "description": str(entry.get("description") or ""),
        "operations": _compact(overrides, len(operations)),
    }
    chaos = _compact_chaos(delays, len(operations))
    if chaos is not None:
        scenario["chaos"] = chaos
    return scenario, notes


def _describe_target(rule: Mapping[str, Any]) -> str:
    """Render a legacy rule's targeting fields for a migration note."""
    operation = rule.get("operation")
    if isinstance(operation, str):
        return f"operation '{operation.strip()}'"
    method = rule.get("method")
    path = rule.get("path")
    if method is None and path is None:
        return "every operation"
    return f"method '{method or '*'}', path '{path or '*'}'"


def fold_instance_config(config: Any, spec: Any) -> InstanceConfigFold:
    """Fold a legacy instance ``config`` into the ``mock_settings`` shape apiome-mock reads.

    Args:
        config: The raw ``mock_instances.config`` value. Anything that is not a mapping folds to
            empty settings rather than raising — an unreadable stored blob must not be able to
            take an instance's data plane down.
        spec: The instance's frozen OpenAPI document, used to resolve per-operation default
            statuses and to decide which rules were reachable at all.

    Returns:
        The fold: the settings to serve from, the notes for anything untranslatable, and the
        instance's stored generation seed.
    """
    if not isinstance(config, dict):
        return InstanceConfigFold()

    operations = extract_operations(spec if isinstance(spec, dict) else {})
    scenarios: Dict[str, Any] = {}
    notes: List[str] = []

    for entry in _legacy_scenarios(config):
        name = str(entry.get("name", "")).strip()
        if not name or _is_untouched_builtin(entry):
            continue
        scenario, scenario_notes = _fold_scenario(entry, operations)
        scenarios[name] = scenario
        notes.extend(scenario_notes)

    settings: Dict[str, Any] = {}
    if scenarios:
        settings["scenarios"] = scenarios

    active = config.get("active_scenario")
    if isinstance(active, str) and active.strip() and active.strip() != DEFAULT_SCENARIO_NAME:
        # happy-path is the runtime's behaviour with no stored default at all, so storing it would
        # add a key that means nothing.
        settings[ACTIVE_SCENARIO_KEY] = active.strip()

    raw_seed = config.get("seed")
    seed = int(raw_seed) if isinstance(raw_seed, int) and not isinstance(raw_seed, bool) else 0

    return InstanceConfigFold(settings=settings, notes=notes, seed=seed)
