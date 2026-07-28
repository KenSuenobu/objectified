"""Pure helpers for ``apiome verify contract`` — ECA-2.2 (#4733).

The CLI does not execute cases or invent serializers. These helpers build the run request,
decide the process exit from a ``ContractRunResponse``, and format the actionable failure
lines a CI log needs. HTTP and Typer stay in the command module.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SUCCESS

#: Artifact formats the ECA-1.3 export endpoint accepts.
EXPORT_FORMATS = ("json", "junit")

#: Reference kinds the run endpoint addresses, mirroring the suite command.
REFERENCE_KINDS = ("project", "catalog")

#: Run outcomes that count as a green gate (until ECA-3.1 adds richer policy).
PASSED_OUTCOME = "passed"


def parse_context_pairs(pairs: Optional[Sequence[str]]) -> dict[str, str]:
    """Parse repeatable ``--context KEY=VALUE`` flags into a dict.

    :param pairs: Raw ``KEY=VALUE`` strings from the CLI, or ``None``.
    :returns: A mapping suitable for ``ContractRunRequest.context``.
    :raises ValueError: When an entry is missing ``=`` or has an empty key.
    """
    if not pairs:
        return {}
    context: dict[str, str] = {}
    for raw in pairs:
        text = (raw or "").strip()
        if "=" not in text:
            raise ValueError(f"context entry must be KEY=VALUE, got {raw!r}")
        key, _, value = text.partition("=")
        key = key.strip()
        if not key:
            raise ValueError(f"context entry must have a non-empty key, got {raw!r}")
        context[key] = value
    return context


def build_run_request(
    *,
    target_ref: str,
    options: Mapping[str, Any],
    idempotency_key: Optional[str] = None,
    context: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """Build the JSON body for ``POST …/contracts/{ref}/run``.

    :param target_ref: Verification target slug or id.
    :param options: Compiler options (same shape as suite compilation).
    :param idempotency_key: Optional evidence upload retry key.
    :param context: Optional non-secret CI context.
    :returns: A JSON-serialisable request body.
    """
    body: dict[str, Any] = {
        "target_ref": target_ref,
        "options": dict(options),
    }
    if idempotency_key:
        body["idempotency_key"] = idempotency_key
    if context:
        body["context"] = dict(context)
    return body


def build_suite_options(
    *,
    seed: int,
    examples: bool,
    generated: bool,
    negative: bool,
    operation: Optional[Sequence[str]],
    max_operations: Optional[int],
) -> dict[str, Any]:
    """Build compiler options matching ``apiome contract suite`` so digests align.

    :param seed: Seed for generated values.
    :param examples: Include declared examples.
    :param generated: Include schema-valid generated bodies.
    :param negative: Include negative cases.
    :param operation: Optional operation-key filter (repeatable).
    :param max_operations: Optional cap on compiled operations.
    :returns: Options dict for the run request.
    """
    options: dict[str, Any] = {
        "seed": seed,
        "include_declared_examples": examples,
        "include_generated": generated,
        "include_negative": negative,
    }
    if operation:
        options["operations"] = list(operation)
    if max_operations is not None:
        options["max_operations"] = max_operations
    return options


def exit_code_for_run(payload: Mapping[str, Any]) -> int:
    """Map a ``ContractRunResponse`` to a process exit code.

    Exit ``0`` only when the suite executed and the stored outcome is ``passed``.
    ``ok: false`` (compile/auth refusal) and any non-passing outcome exit ``1``.
    HTTP faults are handled by the REST client before this runs.

    :param payload: Parsed run response body.
    :returns: ``EXIT_SUCCESS`` or ``EXIT_ERROR``.
    """
    if not payload.get("ok"):
        return EXIT_ERROR
    run = payload.get("run") or {}
    outcome = str(run.get("outcome") or "").strip().lower()
    if outcome == PASSED_OUTCOME:
        return EXIT_SUCCESS
    return EXIT_ERROR


def non_passing_operations(run: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return operation records that are not ``passed`` or ``skipped``.

    Skipped cases (e.g. mutating methods blocked by target policy) are expected
    and already reflected in the run outcome; only failures and errors need callouts.

    :param run: The ``VerificationRunRecord`` dict from the response.
    :returns: Failed/errored operations in stored order.
    """
    results: list[dict[str, Any]] = []
    for op in run.get("operations") or []:
        if not isinstance(op, dict):
            continue
        outcome = str(op.get("outcome") or "").strip().lower()
        if outcome in ("failed", "errored"):
            results.append(op)
    return results


def format_operation_failure(op: Mapping[str, Any]) -> str:
    """One human line for a failed or errored case.

    :param op: An operation record from the evidence.
    :returns: A single-line summary naming evidence fields a gate can cite.
    """
    case_id = op.get("case_id") or op.get("caseId") or "?"
    outcome = op.get("outcome") or "?"
    code = op.get("failure_code") or op.get("failureCode") or "-"
    message = (op.get("failure_message") or op.get("failureMessage") or "").strip()
    expected = op.get("expected_status") or op.get("expectedStatus")
    actual = op.get("actual_status") if "actual_status" in op else op.get("actualStatus")
    operation_key = op.get("operation_key") or op.get("operationKey") or ""

    parts = [f"[{outcome}] {case_id}", f"code={code}"]
    if operation_key:
        parts.append(f"op={operation_key}")
    if expected is not None or actual is not None:
        parts.append(f"status expected={expected!s} actual={actual!s}")
    if message:
        parts.append(message)
    return "  " + " — ".join(parts)


def format_run_error(error: Mapping[str, Any]) -> list[str]:
    """Human lines for an ``ok: false`` taxonomy error.

    :param error: The ``SpecImportJobError``-shaped dict from the response.
    :returns: Lines to print on stderr.
    """
    code = error.get("code") or "ERROR"
    message = error.get("message") or ""
    lines = [f"[{code}] {message}".rstrip()]
    remediation = error.get("remediation")
    if remediation:
        lines.append(f"  remediation: {remediation}")
    return lines
