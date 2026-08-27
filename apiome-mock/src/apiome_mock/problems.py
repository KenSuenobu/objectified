"""RFC 7807 problem+json helpers for mock infrastructure errors."""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse

PROBLEM_CONTENT_TYPE = "application/problem+json"
PROBLEM_BASE = "https://apiome.dev/problems"


def problem_response(
    *,
    status: int,
    title: str,
    detail: str,
    problem_type: str,
    instance: str | None = None,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    """Return a problem+json response for mock infrastructure errors."""
    body: dict[str, Any] = {
        "type": f"{PROBLEM_BASE}/{problem_type}",
        "title": title,
        "status": status,
        "detail": detail,
    }
    if instance is not None:
        body["instance"] = instance
    if extra:
        body.update(extra)
    return JSONResponse(status_code=status, content=body, media_type=PROBLEM_CONTENT_TYPE)


def unauthorized(detail: str, *, instance: str | None = None) -> JSONResponse:
    return problem_response(
        status=401,
        title="Unauthorized",
        detail=detail,
        problem_type="unauthorized",
        instance=instance,
    )


def not_found(detail: str, *, instance: str | None = None) -> JSONResponse:
    return problem_response(
        status=404,
        title="Not Found",
        detail=detail,
        problem_type="not-found",
        instance=instance,
    )


def mock_disabled(detail: str, *, instance: str | None = None) -> JSONResponse:
    return problem_response(
        status=404,
        title="Mock Disabled",
        detail=detail,
        problem_type="mock-disabled",
        instance=instance,
    )


def not_acceptable(detail: str, *, instance: str | None = None) -> JSONResponse:
    return problem_response(
        status=406,
        title="Not Acceptable",
        detail=detail,
        problem_type="not-acceptable",
        instance=instance,
    )


def bad_request(
    detail: str,
    *,
    instance: str | None = None,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    return problem_response(
        status=400,
        title="Bad Request",
        detail=detail,
        problem_type="bad-request",
        instance=instance,
        extra=extra,
    )


def unsupported_media_type(
    detail: str,
    *,
    instance: str | None = None,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    return problem_response(
        status=415,
        title="Unsupported Media Type",
        detail=detail,
        problem_type="unsupported-media-type",
        instance=instance,
        extra=extra,
    )


def undefined_response_status(
    detail: str,
    *,
    instance: str | None = None,
    requested_status: int,
) -> JSONResponse:
    return problem_response(
        status=400,
        title="Undefined Response Status",
        detail=detail,
        problem_type="undefined-response-status",
        instance=instance,
        extra={"requestedStatus": requested_status},
    )


def unknown_scenario(
    detail: str,
    *,
    instance: str | None = None,
    available: list[str] | None = None,
) -> JSONResponse:
    return problem_response(
        status=400,
        title="Unknown Scenario",
        detail=detail,
        problem_type="unknown-scenario",
        instance=instance,
        extra={"availableScenarios": available or []},
    )


def unknown_fixture_pack(
    detail: str,
    *,
    instance: str | None = None,
    available: list[str] | None = None,
) -> JSONResponse:
    """400 returned when a session reset names a fixture pack that does not exist (#4745, PMR-2.2)."""
    return problem_response(
        status=400,
        title="Unknown Fixture Pack",
        detail=detail,
        problem_type="unknown-fixture-pack",
        instance=instance,
        extra={"availablePacks": available or []},
    )


def unknown_callback(
    detail: str,
    *,
    instance: str | None = None,
    available: list[str] | None = None,
) -> JSONResponse:
    """400 returned when a trigger names a callback that does not exist (#4746, PMR-2.3)."""
    return problem_response(
        status=400,
        title="Unknown Callback",
        detail=detail,
        problem_type="unknown-callback",
        instance=instance,
        extra={"availableCallbacks": available or []},
    )


def destination_not_allowed(
    detail: str,
    *,
    instance: str | None = None,
    allowed: list[str] | None = None,
) -> JSONResponse:
    """403 returned when a requested callback destination is not allowlisted (#4746, PMR-2.3).

    The response echoes the definition's allowlist — it is author-declared configuration, not a
    secret — so a consumer can see immediately which targets it may use.
    """
    return problem_response(
        status=403,
        title="Destination Not Allowed",
        detail=detail,
        problem_type="destination-not-allowed",
        instance=instance,
        extra={"allowedDestinations": allowed or []},
    )


def callbacks_disabled(detail: str, *, instance: str | None = None) -> JSONResponse:
    """503 returned when outbound callbacks are not enabled for this deployment (#4746)."""
    return problem_response(
        status=503,
        title="Callbacks Disabled",
        detail=detail,
        problem_type="callbacks-disabled",
        instance=instance,
    )


def capture_not_authorized(
    detail: str,
    *,
    instance: str | None = None,
    state: str,
) -> JSONResponse:
    """403 returned when a request asks to be captured without a live grant (#4747, PMR-2.4).

    Deliberately loud rather than silent: a developer who set ``X-Mock-Capture: on`` and got a
    mocked response back would believe they were recording real traffic when they were not.
    ``captureState`` names which gate refused — unconfigured, disabled, no-upstreams,
    unauthorized, expired, or no-api-key — so the fix is obvious from the response.
    """
    return problem_response(
        status=403,
        title="Capture Not Authorized",
        detail=detail,
        problem_type="capture-not-authorized",
        instance=instance,
        extra={"captureState": state},
    )


def capture_upstream_not_allowed(
    detail: str,
    *,
    instance: str | None = None,
    allowed: list[str] | None = None,
) -> JSONResponse:
    """403 returned when no allowlisted upstream authorizes capturing a path (#4747, PMR-2.4)."""
    return problem_response(
        status=403,
        title="Upstream Not Allowlisted",
        detail=detail,
        problem_type="capture-upstream-not-allowed",
        instance=instance,
        extra={"allowedUpstreams": allowed or []},
    )


def capture_upstream_unreachable(
    detail: str,
    *,
    instance: str | None = None,
    upstream: str,
) -> JSONResponse:
    """502 returned when an allowlisted upstream could not be reached (#4747, PMR-2.4).

    Also the answer when the SSRF guard refuses the address at connect time: from the caller's
    side, an upstream that resolves somewhere it may not be fetched is simply unreachable.
    """
    return problem_response(
        status=502,
        title="Upstream Unreachable",
        detail=detail,
        problem_type="capture-upstream-unreachable",
        instance=instance,
        extra={"upstream": upstream},
    )


def session_required(detail: str, *, instance: str | None = None) -> JSONResponse:
    """400 returned when a session lifecycle operation lacks the X-Mock-Session header (#4745)."""
    return problem_response(
        status=400,
        title="Session Required",
        detail=detail,
        problem_type="session-required",
        instance=instance,
    )


def session_store_unavailable(detail: str, *, instance: str | None = None) -> JSONResponse:
    """503 returned when session lifecycle operations have no session store to act on (#4745)."""
    return problem_response(
        status=503,
        title="Session Store Unavailable",
        detail=detail,
        problem_type="session-store-unavailable",
        instance=instance,
    )


def template_limits_exceeded(detail: str, *, instance: str | None = None) -> JSONResponse:
    """500 returned when a scenario response template exhausts its render budget (#4744, PMR-2.1)."""
    return problem_response(
        status=500,
        title="Template Limits Exceeded",
        detail=detail,
        problem_type="template-limits-exceeded",
        instance=instance,
    )


def chaos_injected_error(detail: str, *, instance: str | None = None) -> JSONResponse:
    """500 returned by chaos error injection when the spec defines no 5xx (#4455, SIM-4.3)."""
    return problem_response(
        status=500,
        title="Injected Server Error",
        detail=detail,
        problem_type="chaos-injected-error",
        instance=instance,
        extra={"chaosInjected": True},
    )


def too_many_requests(
    detail: str,
    *,
    instance: str | None = None,
    retry_after: int,
    limit_type: str,
) -> JSONResponse:
    headers = {"Retry-After": str(max(1, retry_after))}
    response = problem_response(
        status=429,
        title="Too Many Requests",
        detail=detail,
        problem_type="rate-limited",
        instance=instance,
        extra={"limitType": limit_type},
    )
    response.headers.update(headers)
    return response


def method_not_allowed(
    detail: str,
    *,
    instance: str | None = None,
    allow: list[str] | None = None,
) -> JSONResponse:
    headers: dict[str, str] = {}
    if allow:
        headers["Allow"] = ", ".join(sorted(allow))
    response = problem_response(
        status=405,
        title="Method Not Allowed",
        detail=detail,
        problem_type="method-not-allowed",
        instance=instance,
    )
    response.headers.update(headers)
    return response
