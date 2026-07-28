"""HTTP contract runner — ECA-2.1 (#4732).

Takes a compiled ECA-1.1 suite and an ECA-1.2 resolved target, executes each case against the
target with the target's policy bounds, validates status codes and response schemas, and returns
the ECA-1.3 operation records a caller persists as evidence.

Guarantees
----------
* **Bounded.** Concurrency and per-case timeouts come from the target policy, not the caller.
* **Honest about retries.** ``retry_attempts`` applies only to *transport* failures
  (connect/timeout/network). A status or schema mismatch is never retried — a flaky pass must
  not mask a real incompatibility.
* **Secret-free evidence.** Auth material is applied to the request and never written into
  failure messages beyond what :mod:`app.verification_evidence` already redacts.
* **Read-only by default.** Mutating methods are skipped unless the target policy allows them.

This module is pure relative to the platform store: it takes a manifest, a resolved target, an
httpx client (or builds one), and optional auth headers. Compiling, resolving, and recording
live in :mod:`app.contract_runner_service`.
"""

from __future__ import annotations

import base64
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urljoin

import httpx

from .contract_suite import (
    OUTCOME_CLIENT_ERROR,
    OUTCOME_SUCCESS,
    ContractCase,
    ContractSuiteManifest,
)
from .schema_instance_validation import validate_json_instance
from .ssrf_guard import build_guarded_client
from .verification_evidence import (
    ASSERTION_KIND_RESPONSE_SCHEMA,
    ASSERTION_KIND_STATUS_CODE,
    ASSERTION_OUTCOME_FAILED,
    ASSERTION_OUTCOME_PASSED,
    ASSERTION_OUTCOME_SKIPPED,
    OPERATION_OUTCOME_ERRORED,
    OPERATION_OUTCOME_FAILED,
    OPERATION_OUTCOME_PASSED,
    OPERATION_OUTCOME_SKIPPED,
    AssertionInput,
    OperationResultInput,
)
from .verification_target import (
    AUTH_KIND_ENV,
    AUTH_KIND_NONE,
    AUTH_KIND_STORED,
    AUTH_SCHEME_BASIC,
    AUTH_SCHEME_BEARER,
    AUTH_SCHEME_HEADER,
    NETWORK_CLASS_PRIVATE,
    ResolvedTarget,
    TargetAuthReference,
    VerificationPolicy,
)

__all__ = [
    "FAILURE_AUTH_UNAVAILABLE",
    "FAILURE_MUTATING_METHOD_BLOCKED",
    "FAILURE_RESPONSE_SCHEMA_MISMATCH",
    "FAILURE_STATUS_MISMATCH",
    "FAILURE_TIMEOUT",
    "FAILURE_TRANSPORT_ERROR",
    "RUNNER_NAME",
    "RUNNER_VERSION",
    "AuthResolutionError",
    "SuiteRunResult",
    "materialize_auth_headers",
    "run_suite",
    "status_code_matches",
]

RUNNER_NAME = "apiome-contract-runner"
RUNNER_VERSION = "1"

FAILURE_STATUS_MISMATCH = "status-mismatch"
FAILURE_RESPONSE_SCHEMA_MISMATCH = "response-schema-mismatch"
FAILURE_TRANSPORT_ERROR = "transport-error"
FAILURE_TIMEOUT = "timeout"
FAILURE_AUTH_UNAVAILABLE = "auth-unavailable"
FAILURE_MUTATING_METHOD_BLOCKED = "mutating-method-blocked"

_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class AuthResolutionError(RuntimeError):
    """The target's credential reference could not be turned into request headers.

    Raised before any case runs when ``auth.kind`` is ``env`` or ``stored`` and the secret is
    missing or unusable. The message is secret-free.
    """


class SuiteRunResult:
    """What :func:`run_suite` returns — timing plus one operation record per case.

    Attributes:
        started_at: When the run began (UTC).
        finished_at: When the run finished (UTC).
        operations: Per-case evidence inputs, in suite case order.
    """

    __slots__ = ("started_at", "finished_at", "operations")

    def __init__(
        self,
        *,
        started_at: datetime,
        finished_at: datetime,
        operations: List[OperationResultInput],
    ) -> None:
        self.started_at = started_at
        self.finished_at = finished_at
        self.operations = operations


def status_code_matches(actual: int, expected_tokens: Sequence[str]) -> bool:
    """Return whether ``actual`` satisfies any of the contract's status tokens.

    Tokens are either exact codes (``"200"``) or class wildcards (``"2XX"``, ``"4XX"``).

    Args:
        actual: The HTTP status the implementation returned.
        expected_tokens: Tokens from ``ContractCaseExpectation.status_codes``.

    Returns:
        ``True`` when at least one token matches.
    """
    for token in expected_tokens:
        text = (token or "").strip().upper()
        if not text:
            continue
        if text.endswith("XX") and len(text) == 3 and text[0].isdigit():
            if actual // 100 == int(text[0]):
                return True
            continue
        try:
            if actual == int(text):
                return True
        except ValueError:
            continue
    return False


def materialize_auth_headers(
    auth: TargetAuthReference,
    *,
    environ: Optional[Mapping[str, str]] = None,
    stored_headers: Optional[Mapping[str, str]] = None,
) -> Dict[str, str]:
    """Turn a secret-free auth reference into request headers.

    Args:
        auth: The target's credential reference.
        environ: Environment map for ``kind=env`` (defaults to ``os.environ``).
        stored_headers: Already-unsealed headers for ``kind=stored`` (the service loads them
            via the credential vault; this module never opens ciphertext).

    Returns:
        Headers to attach to every case request — empty for ``kind=none``.

    Raises:
        AuthResolutionError: When a required secret is missing or the reference is unusable.
    """
    if auth.kind == AUTH_KIND_NONE:
        return {}

    if auth.kind == AUTH_KIND_STORED:
        if not stored_headers:
            raise AuthResolutionError(
                "stored credential could not be resolved for this target; "
                "check the vault reference and encryption keys"
            )
        return dict(stored_headers)

    if auth.kind != AUTH_KIND_ENV:
        raise AuthResolutionError(f"unsupported auth.kind {auth.kind!r}")

    env = environ if environ is not None else os.environ
    ref = (auth.ref or "").strip()
    if not ref:
        raise AuthResolutionError("env auth reference has no variable name")
    value = env.get(ref)
    if value is None or not str(value).strip():
        raise AuthResolutionError(
            f"environment variable {ref!r} is unset or empty; the runner cannot authorize"
        )

    scheme = (auth.scheme or "").strip().lower()
    if scheme == AUTH_SCHEME_BEARER:
        return {"Authorization": f"Bearer {value}"}
    if scheme == AUTH_SCHEME_HEADER:
        name = (auth.header_name or "").strip()
        if not name:
            raise AuthResolutionError("header auth requires auth.header_name")
        return {name: value}
    if scheme == AUTH_SCHEME_BASIC:
        token = value
        if ":" in value and not value.strip().endswith("="):
            token = base64.b64encode(value.encode("utf-8")).decode("ascii")
        return {"Authorization": f"Basic {token}"}
    raise AuthResolutionError(f"unsupported auth.scheme {scheme!r}")


def _join_url(base_url: str, path: str) -> str:
    """Join a target base URL with a case's resolved path."""
    base = base_url if base_url.endswith("/") else base_url + "/"
    rel = path[1:] if path.startswith("/") else path
    return urljoin(base, rel)


def _expected_status_label(tokens: Sequence[str]) -> Optional[str]:
    """Compact expected-status string that fits evidence field bounds."""
    if not tokens:
        return None
    joined = ",".join(tokens)
    return joined[:20]


def _query_and_headers(
    case: ContractCase,
) -> Tuple[List[Tuple[str, str]], Dict[str, str]]:
    """Split case parameters into query pairs and request headers."""
    query: List[Tuple[str, str]] = []
    headers: Dict[str, str] = {}
    for param in case.request.parameters:
        location = (param.location or "").strip().lower()
        if location == "query":
            query.append((param.name, param.value))
        elif location == "header":
            headers[param.name] = param.value
    return query, headers


def _build_request(
    case: ContractCase,
    *,
    base_url: str,
    auth_headers: Mapping[str, str],
) -> httpx.Request:
    """Build the outbound httpx request for one case."""
    url = _join_url(base_url, case.request.path)
    query, headers = _query_and_headers(case)
    headers = {**headers, **auth_headers}
    content: Optional[bytes] = None
    if case.request.has_body:
        media = case.request.media_type or "application/json"
        headers.setdefault("Content-Type", media)
        if isinstance(case.request.body, (dict, list)):
            content = json.dumps(case.request.body, separators=(",", ":"), ensure_ascii=False).encode(
                "utf-8"
            )
        elif case.request.body is None:
            content = b"null"
        elif isinstance(case.request.body, str):
            content = case.request.body.encode("utf-8")
        else:
            content = json.dumps(case.request.body, separators=(",", ":"), ensure_ascii=False).encode(
                "utf-8"
            )
    return httpx.Request(
        case.request.method.upper(),
        url,
        params=query or None,
        headers=headers,
        content=content,
    )


def _assert_status(case: ContractCase, actual: int) -> AssertionInput:
    """Build the status_code assertion for a case."""
    expected = list(case.expect.status_codes)
    matched = status_code_matches(actual, expected)
    return AssertionInput(
        kind=ASSERTION_KIND_STATUS_CODE,
        outcome=ASSERTION_OUTCOME_PASSED if matched else ASSERTION_OUTCOME_FAILED,
        subject="status",
        expected=",".join(expected) if expected else None,
        actual=str(actual),
        code=None if matched else FAILURE_STATUS_MISMATCH,
        message=None if matched else f"expected status in [{', '.join(expected)}], got {actual}",
    )


def _assert_response_schema(
    case: ContractCase,
    *,
    schemas: Mapping[str, Dict[str, Any]],
    body: Any,
) -> Optional[AssertionInput]:
    """Validate the response body against the case's response schema, when declared."""
    schema_id = case.expect.response_schema_id
    if not schema_id:
        return None
    # Negative cases expect a client error; schema of a success response does not apply.
    if case.expect.outcome == OUTCOME_CLIENT_ERROR:
        return AssertionInput(
            kind=ASSERTION_KIND_RESPONSE_SCHEMA,
            outcome=ASSERTION_OUTCOME_SKIPPED,
            subject=schema_id,
            expected="success response schema",
            actual="skipped for client_error expectation",
        )
    schema = schemas.get(schema_id)
    if schema is None:
        return AssertionInput(
            kind=ASSERTION_KIND_RESPONSE_SCHEMA,
            outcome=ASSERTION_OUTCOME_FAILED,
            subject=schema_id,
            expected=schema_id,
            actual="schema missing from suite",
            code=FAILURE_RESPONSE_SCHEMA_MISMATCH,
            message=f"suite has no schema for id {schema_id!r}",
        )
    result = validate_json_instance(schema, body)
    if result.valid is True:
        return AssertionInput(
            kind=ASSERTION_KIND_RESPONSE_SCHEMA,
            outcome=ASSERTION_OUTCOME_PASSED,
            subject=schema_id,
            expected=schema_id,
            actual="conforming",
        )
    finding = next(iter(result.findings), None)
    if finding is not None:
        detail = finding.message
    elif result.diagnostics:
        detail = result.diagnostics[0].message
    else:
        detail = "response body does not satisfy schema"
    return AssertionInput(
        kind=ASSERTION_KIND_RESPONSE_SCHEMA,
        outcome=ASSERTION_OUTCOME_FAILED,
        subject=schema_id,
        expected=schema_id,
        actual=detail[:1000],
        code=FAILURE_RESPONSE_SCHEMA_MISMATCH,
        message=detail,
    )


def _parse_json_body(response: httpx.Response) -> Any:
    """Best-effort JSON parse; returns raw text when the body is not JSON."""
    if not response.content:
        return None
    try:
        return response.json()
    except Exception:  # noqa: BLE001 - non-JSON is a valid observation
        return response.text


def _is_transport_failure(exc: BaseException) -> Tuple[bool, str, str]:
    """Classify an httpx/network exception as transport vs timeout.

    Returns:
        ``(is_transport, failure_code, message)``.
    """
    if isinstance(exc, httpx.TimeoutException):
        return True, FAILURE_TIMEOUT, "request timed out"
    if isinstance(exc, (httpx.TransportError, httpx.NetworkError, httpx.RemoteProtocolError)):
        return True, FAILURE_TRANSPORT_ERROR, f"transport error: {exc.__class__.__name__}"
    if isinstance(exc, httpx.HTTPError):
        return True, FAILURE_TRANSPORT_ERROR, f"http error: {exc.__class__.__name__}"
    return False, FAILURE_TRANSPORT_ERROR, f"unexpected error: {exc.__class__.__name__}"


def _execute_case(
    case: ContractCase,
    *,
    target: ResolvedTarget,
    auth_headers: Mapping[str, str],
    client: httpx.Client,
    schemas: Mapping[str, Dict[str, Any]],
) -> OperationResultInput:
    """Execute one case under the target policy and return its evidence record."""
    method = case.request.method.upper()
    started = datetime.now(timezone.utc)
    t0 = time.perf_counter()

    if method in _MUTATING_METHODS and not target.policy.allow_mutating_methods:
        finished = datetime.now(timezone.utc)
        return OperationResultInput(
            case_id=case.case_id,
            operation_key=case.operation_key,
            operation_name=case.operation_name,
            case_source=case.source,
            http_method=method,
            http_path=case.request.path,
            outcome=OPERATION_OUTCOME_SKIPPED,
            failure_code=FAILURE_MUTATING_METHOD_BLOCKED,
            failure_message=(
                f"{method} is a mutating method and the target policy has "
                "allow_mutating_methods=false"
            ),
            expected_status=_expected_status_label(case.expect.status_codes),
            started_at=started,
            finished_at=finished,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            attempts=1,
            assertions=[],
        )

    policy: VerificationPolicy = target.policy
    max_attempts = 1 + max(0, int(policy.retry_attempts))
    backoff_s = max(0, int(policy.retry_backoff_ms)) / 1000.0
    attempts = 0
    last_error_code = FAILURE_TRANSPORT_ERROR
    last_error_message = "transport error"
    response: Optional[httpx.Response] = None

    request = _build_request(case, base_url=target.base_url, auth_headers=auth_headers)

    while attempts < max_attempts:
        attempts += 1
        try:
            response = client.send(request)
            break
        except Exception as exc:  # noqa: BLE001 - classify per attempt
            is_transport, code, message = _is_transport_failure(exc)
            last_error_code = code
            last_error_message = message
            if not is_transport or attempts >= max_attempts:
                finished = datetime.now(timezone.utc)
                return OperationResultInput(
                    case_id=case.case_id,
                    operation_key=case.operation_key,
                    operation_name=case.operation_name,
                    case_source=case.source,
                    http_method=method,
                    http_path=case.request.path,
                    outcome=OPERATION_OUTCOME_ERRORED,
                    failure_code=last_error_code,
                    failure_message=last_error_message,
                    expected_status=_expected_status_label(case.expect.status_codes),
                    started_at=started,
                    finished_at=finished,
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                    attempts=attempts,
                    assertions=[],
                )
            if backoff_s:
                time.sleep(backoff_s)

    assert response is not None
    status_assertion = _assert_status(case, response.status_code)
    assertions: List[AssertionInput] = [status_assertion]

    # Contract failure: never retry. Status mismatch ends the case immediately.
    if status_assertion.outcome == ASSERTION_OUTCOME_FAILED:
        finished = datetime.now(timezone.utc)
        return OperationResultInput(
            case_id=case.case_id,
            operation_key=case.operation_key,
            operation_name=case.operation_name,
            case_source=case.source,
            http_method=method,
            http_path=case.request.path,
            outcome=OPERATION_OUTCOME_FAILED,
            failure_code=FAILURE_STATUS_MISMATCH,
            failure_message=status_assertion.message,
            expected_status=_expected_status_label(case.expect.status_codes),
            actual_status=response.status_code,
            started_at=started,
            finished_at=finished,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            attempts=attempts,
            assertions=assertions,
        )

    body = _parse_json_body(response)
    schema_assertion = _assert_response_schema(case, schemas=schemas, body=body)
    if schema_assertion is not None:
        assertions.append(schema_assertion)
        if schema_assertion.outcome == ASSERTION_OUTCOME_FAILED:
            finished = datetime.now(timezone.utc)
            return OperationResultInput(
                case_id=case.case_id,
                operation_key=case.operation_key,
                operation_name=case.operation_name,
                case_source=case.source,
                http_method=method,
                http_path=case.request.path,
                outcome=OPERATION_OUTCOME_FAILED,
                failure_code=FAILURE_RESPONSE_SCHEMA_MISMATCH,
                failure_message=schema_assertion.message,
                expected_status=_expected_status_label(case.expect.status_codes),
                actual_status=response.status_code,
                started_at=started,
                finished_at=finished,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                attempts=attempts,
                assertions=assertions,
            )

    # Success expectation: status matched. Client-error expectation: status matched the 4xx
    # class (or declared codes) — that is a pass for a negative case.
    if case.expect.outcome not in (OUTCOME_SUCCESS, OUTCOME_CLIENT_ERROR):
        finished = datetime.now(timezone.utc)
        return OperationResultInput(
            case_id=case.case_id,
            operation_key=case.operation_key,
            operation_name=case.operation_name,
            case_source=case.source,
            http_method=method,
            http_path=case.request.path,
            outcome=OPERATION_OUTCOME_FAILED,
            failure_code=FAILURE_STATUS_MISMATCH,
            failure_message=f"unknown expectation outcome {case.expect.outcome!r}",
            expected_status=_expected_status_label(case.expect.status_codes),
            actual_status=response.status_code,
            started_at=started,
            finished_at=finished,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            attempts=attempts,
            assertions=assertions,
        )

    finished = datetime.now(timezone.utc)
    return OperationResultInput(
        case_id=case.case_id,
        operation_key=case.operation_key,
        operation_name=case.operation_name,
        case_source=case.source,
        http_method=method,
        http_path=case.request.path,
        outcome=OPERATION_OUTCOME_PASSED,
        expected_status=_expected_status_label(case.expect.status_codes),
        actual_status=response.status_code,
        started_at=started,
        finished_at=finished,
        duration_ms=int((time.perf_counter() - t0) * 1000),
        attempts=attempts,
        assertions=assertions,
    )


def run_suite(
    manifest: ContractSuiteManifest,
    target: ResolvedTarget,
    *,
    auth_headers: Optional[Mapping[str, str]] = None,
    client: Optional[httpx.Client] = None,
) -> SuiteRunResult:
    """Execute every case in ``manifest`` against ``target``.

    Args:
        manifest: The compiled suite (ECA-1.1).
        target: The resolved verification target (ECA-1.2).
        auth_headers: Headers from :func:`materialize_auth_headers` (or empty).
        client: Optional shared httpx client. When omitted, a guarded client is created that
            honours the target's TLS / redirect / private-network policy.

    Returns:
        Timing plus one :class:`OperationResultInput` per case, in suite order.
    """
    headers = dict(auth_headers or {})
    started_at = datetime.now(timezone.utc)
    own_client = client is None
    if client is None:
        client = build_guarded_client(
            allow_private=target.network_class == NETWORK_CLASS_PRIVATE,
            timeout=httpx.Timeout(target.policy.request_timeout_seconds),
            follow_redirects=target.policy.follow_redirects,
            verify=target.policy.verify_tls,
        )

    cases = list(manifest.cases)
    results: List[Optional[OperationResultInput]] = [None] * len(cases)
    concurrency = max(1, min(int(target.policy.max_concurrency), max(1, len(cases) or 1)))

    try:
        if not cases:
            finished_at = datetime.now(timezone.utc)
            return SuiteRunResult(started_at=started_at, finished_at=finished_at, operations=[])

        def _run_one(index: int, case: ContractCase) -> Tuple[int, OperationResultInput]:
            return index, _execute_case(
                case,
                target=target,
                auth_headers=headers,
                client=client,
                schemas=manifest.schemas,
            )

        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(_run_one, i, case) for i, case in enumerate(cases)]
            for future in as_completed(futures):
                index, result = future.result()
                results[index] = result
    finally:
        if own_client:
            client.close()

    operations = [op for op in results if op is not None]
    finished_at = datetime.now(timezone.utc)
    return SuiteRunResult(started_at=started_at, finished_at=finished_at, operations=operations)
