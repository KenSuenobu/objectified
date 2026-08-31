"""Built-in scenarios every mock always defines (#5532, MSC-2.2).

The retired in-REST mock engine shipped four scenario templates on every instance — ``happy-path``,
``server-error``, ``not-found`` and ``slow`` — and tenants wrote them into client code and CI jobs
by name. Folding that engine into this one must not silently take those names away, so they are
re-expressed here in the dict-keyed ``versions.mock_settings`` schema and merged into *every*
version's scenarios by :func:`apiome_mock.scenarios.parse_scenarios`.

Two consequences worth stating plainly:

* **Stored scenarios win.** A version that defines its own ``server-error`` gets its own, exactly
  as the old engine's ``normalize_scenarios`` resolved the same collision. The built-ins are a
  floor, never an override.
* **They apply everywhere.** A version that never had a hosted instance now answers
  ``X-Mock-Scenario: server-error`` too. That is a deliberate widening: one engine means one set of
  names, and a name that works on some versions and not others is the two-engine split wearing a
  different hat.

The bodies are carried over verbatim from the old engine so a client asserting on
``error.code == "internal_error"`` keeps passing. ``happy-path`` declares no overrides at all —
it is the *absence* of overrides, which is what made it the implicit default before — and ``slow``
is expressed as a scenario-scoped chaos block, this runtime's spelling of "respond normally, but
late".
"""

from __future__ import annotations

from typing import Any, Mapping

__all__ = [
    "BUILTIN_SCENARIOS",
    "BUILTIN_SCENARIO_NAMES",
    "DEFAULT_SCENARIO_NAME",
    "SLOW_SCENARIO_DELAY_MS",
    "merge_builtin_scenarios",
]

DEFAULT_SCENARIO_NAME = "happy-path"
"""The name the old engine treated as the implicit default when nothing else was selected."""

SLOW_SCENARIO_DELAY_MS = 1500
"""Latency the ``slow`` built-in injects, matching the retired engine's ``latency_ms``."""

BUILTIN_SCENARIOS: Mapping[str, Mapping[str, Any]] = {
    DEFAULT_SCENARIO_NAME: {
        "description": "Default: every operation returns its generated success response.",
        "operations": {},
    },
    "server-error": {
        "description": "Every endpoint returns HTTP 500.",
        "operations": {
            "*": {
                "responses": [
                    {
                        "status": 500,
                        "body": {
                            "error": {
                                "code": "internal_error",
                                "message": "Simulated server error.",
                            }
                        },
                    }
                ]
            }
        },
    },
    "not-found": {
        "description": "Every endpoint returns HTTP 404.",
        "operations": {
            "*": {
                "responses": [
                    {
                        "status": 404,
                        "body": {
                            "error": {
                                "code": "not_found",
                                "message": "Simulated not-found.",
                            }
                        },
                    }
                ]
            }
        },
    },
    "slow": {
        "description": "Every endpoint responds normally but with 1500ms of added latency.",
        "operations": {},
        "chaos": {"default": {"delayMs": SLOW_SCENARIO_DELAY_MS}},
    },
}
"""The built-in scenario definitions, in the order the old engine listed them."""

BUILTIN_SCENARIO_NAMES: frozenset[str] = frozenset(BUILTIN_SCENARIOS)
"""Names a version always resolves, whether or not it stores any scenarios of its own."""


def merge_builtin_scenarios(stored: Mapping[str, Any]) -> dict[str, Any]:
    """Overlay a version's stored scenario definitions on the built-ins.

    Args:
        stored: The raw ``mock_settings["scenarios"]`` mapping, name to definition.

    Returns:
        A new mapping containing every built-in plus every stored scenario, with a stored
        definition replacing the built-in of the same name outright (not merged into it — a
        half-overridden built-in would be a shape no author ever wrote).
    """
    merged: dict[str, Any] = {name: dict(entry) for name, entry in BUILTIN_SCENARIOS.items()}
    merged.update(stored)
    return merged
