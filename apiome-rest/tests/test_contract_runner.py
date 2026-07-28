"""Unit tests for the HTTP contract runner — ECA-2.1 (#4732).

Acceptance criteria covered here:

* status / schema matching (including ``2XX`` wildcards);
* **retries cannot mask a contract failure** — a status mismatch is never re-attempted even when
  ``retry_attempts > 0``;
* transport retries increment ``attempts``;
* mutating methods are skipped when the policy forbids them;
* a deliberate incompatible response fails with ``status-mismatch`` /
  ``response-schema-mismatch``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List

import httpx
import pytest

from app.contract_runner import (
    FAILURE_MUTATING_METHOD_BLOCKED,
    FAILURE_RESPONSE_SCHEMA_MISMATCH,
    FAILURE_STATUS_MISMATCH,
    FAILURE_TIMEOUT,
    AuthResolutionError,
    materialize_auth_headers,
    run_suite,
    status_code_matches,
)
from app.contract_suite import (
    OUTCOME_CLIENT_ERROR,
    OUTCOME_SUCCESS,
    ContractCase,
    ContractCaseExpectation,
    ContractCaseRequest,
    ContractSuiteManifest,
    ContractSuiteOptions,
    SuiteApiInfo,
)
from app.verification_evidence import (
    OPERATION_OUTCOME_ERRORED,
    OPERATION_OUTCOME_FAILED,
    OPERATION_OUTCOME_PASSED,
    OPERATION_OUTCOME_SKIPPED,
)
from app.verification_target import (
    AUTH_KIND_ENV,
    AUTH_KIND_NONE,
    AUTH_SCHEME_BEARER,
    AUTH_SCHEME_HEADER,
    NETWORK_CLASS_PRIVATE,
    NETWORK_CLASS_PUBLIC,
    ResolvedTarget,
    TargetAuthReference,
    VerificationPolicy,
)

_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["id", "name"],
    "additionalProperties": False,
    "properties": {
        "id": {"type": "integer"},
        "name": {"type": "string", "minLength": 1},
    },
}


def _case(
    *,
    case_id: str = "get-pets-example",
    method: str = "GET",
    path: str = "/pets",
    outcome: str = OUTCOME_SUCCESS,
    status_codes: List[str] | None = None,
    schema_id: str | None = "type:Pet",
    body: Any = None,
    has_body: bool = False,
) -> ContractCase:
    """Build one executable case for runner tests."""
    return ContractCase(
        case_id=case_id,
        operation_key=f"{method} {path}",
        operation_name="listPets" if method == "GET" else "writePet",
        source="declared_example",
        title=case_id,
        description="test case",
        synthetic=False,
        request=ContractCaseRequest(
            method=method,
            path_template=path,
            path=path,
            has_body=has_body,
            body=body,
            media_type="application/json" if has_body else None,
        ),
        expect=ContractCaseExpectation(
            outcome=outcome,
            status_codes=status_codes or (["4XX"] if outcome == OUTCOME_CLIENT_ERROR else ["200"]),
            status_declared=True,
            response_schema_id=schema_id,
            reason="contract says so",
        ),
    )


def _manifest(cases: List[ContractCase], *, schemas: Dict[str, Any] | None = None) -> ContractSuiteManifest:
    """Minimal suite wrapping ``cases``."""
    return ContractSuiteManifest(
        digest="sha256:" + "a" * 64,
        options=ContractSuiteOptions(),
        api=SuiteApiInfo(
            name="pets",
            namespace="pets",
            title="Pets",
            version="1.0.0",
            format="openapi",
            paradigm="rest",
            protocol="http",
        ),
        cases=cases,
        schemas=schemas if schemas is not None else {"type:Pet": _SCHEMA},
    )


def _target(**policy_overrides: Any) -> ResolvedTarget:
    """Resolved mock target pointing at a fake base URL."""
    policy = VerificationPolicy(**policy_overrides)
    return ResolvedTarget(
        target_id="22222222-2222-4222-8222-222222222222",
        slug="mock",
        name="Mock",
        environment="mock",
        network_class=NETWORK_CLASS_PRIVATE,
        base_url="http://mock.test/acme/pets/1.0.0",
        policy=policy,
        auth=TargetAuthReference(),
        resolved_at=datetime(2026, 7, 27, tzinfo=timezone.utc),
    )


# ---------------------------------------------------------------------------
# status_code_matches
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "actual,tokens,expected",
    [
        (200, ["200"], True),
        (201, ["200"], False),
        (204, ["2XX"], True),
        (404, ["4XX"], True),
        (500, ["4XX"], False),
        (400, ["400", "404"], True),
        (418, ["400", "404"], False),
    ],
)
def test_status_code_matches(actual: int, tokens: List[str], expected: bool) -> None:
    assert status_code_matches(actual, tokens) is expected


# ---------------------------------------------------------------------------
# Auth materialization
# ---------------------------------------------------------------------------


def test_materialize_auth_none() -> None:
    assert materialize_auth_headers(TargetAuthReference()) == {}


def test_materialize_auth_env_bearer() -> None:
    auth = TargetAuthReference(kind=AUTH_KIND_ENV, scheme=AUTH_SCHEME_BEARER, ref="TOK")
    headers = materialize_auth_headers(auth, environ={"TOK": "secret-token"})
    assert headers == {"Authorization": "Bearer secret-token"}


def test_materialize_auth_env_missing_raises() -> None:
    auth = TargetAuthReference(kind=AUTH_KIND_ENV, scheme=AUTH_SCHEME_BEARER, ref="MISSING")
    with pytest.raises(AuthResolutionError, match="unset"):
        materialize_auth_headers(auth, environ={})


def test_materialize_auth_env_header() -> None:
    auth = TargetAuthReference(
        kind=AUTH_KIND_ENV, scheme=AUTH_SCHEME_HEADER, ref="KEY", header_name="X-Api-Key"
    )
    headers = materialize_auth_headers(auth, environ={"KEY": "abc"})
    assert headers == {"X-Api-Key": "abc"}


# ---------------------------------------------------------------------------
# Golden-path pass / incompatible staging
# ---------------------------------------------------------------------------


def test_golden_path_conformant_mock_passes() -> None:
    """Acceptance: passes the Apiome mock golden path (conformant responses)."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        assert request.url.path.endswith("/pets")
        return httpx.Response(200, json={"id": 1, "name": "Rex"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = run_suite(_manifest([_case()]), _target(), client=client)
    client.close()

    assert calls["n"] == 1
    assert len(result.operations) == 1
    assert result.operations[0].outcome == OPERATION_OUTCOME_PASSED
    assert result.operations[0].attempts == 1
    assert result.operations[0].actual_status == 200


def test_deliberate_incompatible_status_is_detected() -> None:
    """Acceptance: detects a deliberate incompatible staging response (wrong status)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = run_suite(_manifest([_case()]), _target(), client=client)
    client.close()

    op = result.operations[0]
    assert op.outcome == OPERATION_OUTCOME_FAILED
    assert op.failure_code == FAILURE_STATUS_MISMATCH
    assert op.actual_status == 500
    assert op.attempts == 1


def test_deliberate_incompatible_schema_is_detected() -> None:
    """Acceptance: detects a deliberate incompatible staging response (schema drift)."""

    def handler(request: httpx.Request) -> httpx.Response:
        # Missing required ``name``.
        return httpx.Response(200, json={"id": 1})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = run_suite(_manifest([_case()]), _target(), client=client)
    client.close()

    op = result.operations[0]
    assert op.outcome == OPERATION_OUTCOME_FAILED
    assert op.failure_code == FAILURE_RESPONSE_SCHEMA_MISMATCH
    assert any(a.code == FAILURE_RESPONSE_SCHEMA_MISMATCH for a in op.assertions)


# ---------------------------------------------------------------------------
# Retries cannot mask a contract failure
# ---------------------------------------------------------------------------


def test_retries_cannot_mask_contract_failure() -> None:
    """A status mismatch is never retried, even when retry_attempts > 0."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        # First response fails the contract; a retry would return 200 — if we retried,
        # the case would spuriously pass.
        if calls["n"] == 1:
            return httpx.Response(500, json={"error": "nope"})
        return httpx.Response(200, json={"id": 1, "name": "Rex"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = run_suite(
        _manifest([_case()]),
        _target(retry_attempts=3, retry_backoff_ms=0),
        client=client,
    )
    client.close()

    assert calls["n"] == 1, "contract failure must not be retried"
    op = result.operations[0]
    assert op.outcome == OPERATION_OUTCOME_FAILED
    assert op.failure_code == FAILURE_STATUS_MISMATCH
    assert op.attempts == 1


def test_transport_retries_increment_attempts() -> None:
    """Transport failures honour retry_attempts and record the attempt count."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("refused")
        return httpx.Response(200, json={"id": 1, "name": "Rex"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = run_suite(
        _manifest([_case()]),
        _target(retry_attempts=2, retry_backoff_ms=0),
        client=client,
    )
    client.close()

    assert calls["n"] == 3
    op = result.operations[0]
    assert op.outcome == OPERATION_OUTCOME_PASSED
    assert op.attempts == 3


def test_transport_exhaustion_is_errored() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = run_suite(
        _manifest([_case()]),
        _target(retry_attempts=1, retry_backoff_ms=0),
        client=client,
    )
    client.close()

    op = result.operations[0]
    assert op.outcome == OPERATION_OUTCOME_ERRORED
    assert op.failure_code == FAILURE_TIMEOUT
    assert op.attempts == 2


def test_mutating_method_skipped_when_disallowed() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(201, json={"id": 1, "name": "Rex"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = run_suite(
        _manifest([_case(case_id="post-pet", method="POST", path="/pets", has_body=True, body={"name": "Rex"})]),
        _target(allow_mutating_methods=False),
        client=client,
    )
    client.close()

    assert calls["n"] == 0
    op = result.operations[0]
    assert op.outcome == OPERATION_OUTCOME_SKIPPED
    assert op.failure_code == FAILURE_MUTATING_METHOD_BLOCKED


def test_negative_case_accepts_4xx() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "bad request"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = run_suite(
        _manifest(
            [
                _case(
                    case_id="neg-missing",
                    outcome=OUTCOME_CLIENT_ERROR,
                    status_codes=["4XX"],
                    schema_id=None,
                )
            ]
        ),
        _target(),
        client=client,
    )
    client.close()

    assert result.operations[0].outcome == OPERATION_OUTCOME_PASSED


def test_auth_header_is_attached() -> None:
    seen: Dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update({k: v for k, v in request.headers.items() if k.lower() == "authorization"})
        return httpx.Response(200, json={"id": 1, "name": "Rex"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    run_suite(
        _manifest([_case()]),
        _target(),
        auth_headers={"Authorization": "Bearer abc"},
        client=client,
    )
    client.close()
    assert seen.get("authorization") == "Bearer abc"


def test_public_target_builds_without_allow_private_flag() -> None:
    """Smoke: public network class still constructs a client (mocked DNS via MockTransport)."""
    target = _target()
    target = ResolvedTarget(
        target_id=target.target_id,
        slug=target.slug,
        name=target.name,
        environment=target.environment,
        network_class=NETWORK_CLASS_PUBLIC,
        base_url="https://staging.example.com/api",
        policy=target.policy,
        auth=TargetAuthReference(kind=AUTH_KIND_NONE),
        resolved_at=target.resolved_at,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": 1, "name": "Rex"})

    # Inject a client so we do not hit real DNS / SSRF resolution in the unit test.
    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = run_suite(_manifest([_case()]), target, client=client)
    client.close()
    assert result.operations[0].outcome == OPERATION_OUTCOME_PASSED
