"""Mock callback and webhook simulation format (PMR-2.3, #4746).

A mock that only answers inbound requests cannot exercise the *outbound* half of a contract:
the callbacks and webhooks a provider promises to send. A **callback definition** closes that
gap. It is a named, versioned, digestible document that tells the mock runtime what to send,
where it is allowed to send it, what the payload must look like, and how to retry.

Definitions live in ``versions.mock_settings`` under the ``"callbacks"`` key::

    {
      "callbacks": {
        "order-created": {
          "callbackFormat": "apiome.mock.callback/v1",
          "callbackFormatVersion": 1,
          "description": "POST /orders notifies the consumer's webhook.",
          "trigger": {"operation": "POST /orders", "statuses": [201]},
          "destinations": ["https://hooks.example.com/orders"],
          "request": {
            "method": "POST",
            "headers": {"X-Event": "order.created"},
            "body": {"id": "{{request.body#/id}}", "sample": "{{fixture.orderEvent}}"}
          },
          "payloadSchema": {"$ref": "#/components/schemas/OrderEvent"},
          "retry": {"maxAttempts": 3, "backoffMs": 100, "retryOn": [500, 502, 503]}
        }
      }
    }

The four halves of the acceptance boundary map onto four parts of the document:

* ``payloadSchema`` — the declared schema the rendered payload is validated against before a
  single byte leaves the runtime. A payload that does not validate is never delivered.
* ``destinations`` — the **allowlist**. A delivery target must match one of these entries on
  scheme, host, port, and path prefix; the runtime additionally applies the SSRF policy
  (:mod:`app.ssrf_guard`) so an allowlisted-but-internal address is still refused.
* ``request`` — the outbound message. Its body and header values are the same bounded
  ``{{ ... }}`` templates scenario responses use (:mod:`app.mock_template`), so event payloads
  can be driven by fixture packs (``{{fixture.<name>}}``) and by the triggering request.
* ``retry`` — a **deterministic** attempt schedule. Delays are a pure function of the stored
  knobs (:func:`retry_delays`) with no jitter and no wall-clock input, so replaying the same
  fixture-driven event always produces the same sequence of attempts.

**Versioning and digests.** Every definition declares :data:`CALLBACK_FORMAT` and
:data:`CALLBACK_FORMAT_VERSION`; a runtime skips definitions whose version it does not support
rather than misreading them. A definition's **digest** is SHA-256 over the canonical JSON of its
canonicalized document (:func:`callback_digest`), so the same content always produces the same
digest author-side, runtime-side, and inside a portable bundle.

This module owns the *author-time* contract (strict validation on save) plus the destination
matching and retry-schedule rules both sides must agree on. The runtime's lenient loader lives in
``apiome_mock.callbacks`` and reuses the helpers here so the two can never drift.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

from .mock_bundle import canonical_json, content_digest
from .mock_routing import extract_operations
from .mock_settings_util import parse_mock_settings
from .mock_template import validate_template_text, validate_template_value
from .ssrf_guard import SSRFError, validate_url_policy

__all__ = [
    "CALLBACK_FORMAT",
    "CALLBACK_FORMAT_VERSION",
    "CALLBACK_NAME_PATTERN",
    "DEFAULT_BACKOFF_MS",
    "DEFAULT_BACKOFF_MULTIPLIER",
    "DEFAULT_MAX_ATTEMPTS",
    "DEFAULT_METHOD",
    "DEFAULT_RETRY_ON",
    "DEFAULT_TIMEOUT_MS",
    "MAX_ATTEMPTS",
    "MAX_BACKOFF_MS",
    "MAX_CALLBACKS",
    "MAX_CALLBACK_BYTES",
    "MAX_DESTINATIONS",
    "MAX_HEADERS",
    "MAX_TIMEOUT_MS",
    "MAX_TOTAL_DELIVERY_MS",
    "MAX_TRIGGER_STATUSES",
    "SUPPORTED_CALLBACK_FORMAT_VERSIONS",
    "ALLOWED_METHODS",
    "callback_digest",
    "callback_digests",
    "callbacks_from_storage",
    "callbacks_to_storage",
    "canonical_callback",
    "match_destination",
    "normalize_destination",
    "retry_delays",
    "validate_mock_callbacks",
]

#: Media-type-shaped identifier of the callback document family. A breaking change to the layout
#: mints a new one (``/v2``) rather than reusing this id with a different meaning.
CALLBACK_FORMAT = "apiome.mock.callback/v1"

#: Additive revision of :data:`CALLBACK_FORMAT`. Bumped when new *optional* fields appear; a
#: runtime skips definitions whose version is not in :data:`SUPPORTED_CALLBACK_FORMAT_VERSIONS`.
CALLBACK_FORMAT_VERSION = 1

#: Format versions this build can produce and consume.
SUPPORTED_CALLBACK_FORMAT_VERSIONS: Tuple[int, ...] = (1,)

#: Header/URL-safe callback names — the same shape as scenario and fixture-pack names, so a name
#: is always safe to echo in a JSON response, a URL path, and a log line.
CALLBACK_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

#: Maximum callback definitions per version.
MAX_CALLBACKS = 20

#: Maximum canonical JSON size (bytes) of one definition (64 KiB).
MAX_CALLBACK_BYTES = 65_536

#: Maximum allowlisted destinations per definition.
MAX_DESTINATIONS = 10

#: Maximum outbound headers per definition.
MAX_HEADERS = 20

#: Maximum trigger status codes per definition.
MAX_TRIGGER_STATUSES = 10

#: Maximum delivery attempts (initial attempt included) one definition may request.
MAX_ATTEMPTS = 10

#: Maximum base backoff between attempts, in milliseconds.
MAX_BACKOFF_MS = 60_000

#: Ceiling on the worst-case cost of one delivery — every attempt's timeout plus every backoff.
#: A definition that could exceed it is rejected at save time rather than silently truncated at
#: delivery time (truncating would make the retry schedule non-deterministic, which is the one
#: property PMR-2.3 promises). Deliveries are awaited before the triggering response returns, so
#: this ceiling is also what bounds how long a mocked request can take.
MAX_TOTAL_DELIVERY_MS = 60_000

#: Maximum per-attempt request timeout, in milliseconds.
MAX_TIMEOUT_MS = 30_000

#: HTTP methods an outbound callback may use. Bodies are only meaningful on the first three, but
#: a contract may legitimately model a webhook as a ``DELETE`` or a ``GET`` ping.
ALLOWED_METHODS: Tuple[str, ...] = ("POST", "PUT", "PATCH", "DELETE", "GET")

#: Outbound method when ``request.method`` is omitted.
DEFAULT_METHOD = "POST"

#: Delivery attempts when ``retry.maxAttempts`` is omitted (one initial + two retries).
DEFAULT_MAX_ATTEMPTS = 3

#: Base delay before the first retry, in milliseconds, when ``retry.backoffMs`` is omitted.
DEFAULT_BACKOFF_MS = 100

#: Growth factor applied to the backoff for each subsequent retry.
DEFAULT_BACKOFF_MULTIPLIER = 2.0

#: Response statuses that make a delivery worth retrying when ``retry.retryOn`` is omitted:
#: the transient ones. Everything else is a verdict, not a hiccup.
DEFAULT_RETRY_ON: Tuple[int, ...] = (408, 425, 429, 500, 502, 503, 504)

#: Per-attempt request timeout when ``retry.timeoutMs`` is omitted.
DEFAULT_TIMEOUT_MS = 5_000

_ALLOWED_CALLBACK_KEYS = frozenset(
    {
        "callbackFormat",
        "callbackFormatVersion",
        "description",
        "trigger",
        "destinations",
        "request",
        "payloadSchema",
        "retry",
    }
)
_ALLOWED_TRIGGER_KEYS = frozenset({"operation", "statuses"})
_ALLOWED_REQUEST_KEYS = frozenset({"method", "headers", "body"})
_ALLOWED_RETRY_KEYS = frozenset({"maxAttempts", "backoffMs", "backoffMultiplier", "retryOn", "timeoutMs"})

_MAX_DESCRIPTION_LENGTH = 500
_MAX_DESTINATION_LENGTH = 2_000
_MAX_SETTINGS_BYTES = 262_144
_MIN_STATUS = 100
_MAX_STATUS = 599

_HEADER_NAME_PATTERN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

#: Headers the runtime owns; a definition may not set them because doing so would either corrupt
#: the outbound framing or forge the runtime's own provenance markers.
_RESERVED_HEADERS = frozenset(
    {"content-length", "transfer-encoding", "connection", "host", "x-mock-callback", "x-mock-callback-attempt"}
)

_DEFAULT_PORTS = {"http": 80, "https": 443}


def normalize_destination(url: Any) -> Optional[str]:
    """Return the canonical form of one destination URL, or ``None`` when unusable.

    Canonicalization lower-cases the scheme and host, drops the scheme's default port, drops any
    query and fragment, and strips a trailing slash from a non-root path. Two destinations that
    differ only in those respects therefore compare — and digest — as one.

    Args:
        url: The candidate destination (any type; non-strings yield ``None``).

    Returns:
        ``scheme://host[:port]/path`` in canonical form, or ``None`` when the value is not a
        usable absolute ``http``/``https`` URL.
    """
    if not isinstance(url, str):
        return None
    text = url.strip()
    if not text or len(text) > _MAX_DESTINATION_LENGTH:
        return None
    try:
        validate_url_policy(text)
    except SSRFError:
        return None
    parts = urlsplit(text)
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if not host:
        return None
    authority = host
    if parts.port is not None and parts.port != _DEFAULT_PORTS.get(scheme):
        authority = f"{host}:{parts.port}"
    path = parts.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/") or "/"
    return f"{scheme}://{authority}{path}"


def match_destination(url: Any, allowlist: Sequence[str]) -> Optional[str]:
    """Return the allowlist entry authorizing ``url``, or ``None`` when none does.

    A destination is authorized when, after canonicalization, it shares the entry's scheme, host,
    and port and its path is the entry's path or a descendant of it at a segment boundary. An
    entry of ``https://hooks.example.com/orders`` therefore authorizes
    ``https://hooks.example.com/orders/42`` but not ``https://hooks.example.com/orders-archive``
    and not ``https://hooks.example.com`` — matching by raw string prefix would authorize both.

    The requested URL's query string is ignored for matching (and preserved for delivery), so a
    consumer may pass a per-test correlation token without every variant needing its own entry.

    Args:
        url: The requested delivery target.
        allowlist: Canonical allowlist entries from the definition's ``destinations``.

    Returns:
        The matching entry, or ``None``.
    """
    candidate = normalize_destination(url)
    if candidate is None:
        return None
    candidate_parts = urlsplit(candidate)
    for entry in allowlist:
        entry_parts = urlsplit(entry)
        if (candidate_parts.scheme, candidate_parts.netloc) != (entry_parts.scheme, entry_parts.netloc):
            continue
        base = entry_parts.path or "/"
        if base == "/":
            return entry
        if candidate_parts.path == base or candidate_parts.path.startswith(base + "/"):
            return entry
    return None


def retry_delays(retry: Mapping[str, Any] | None) -> Tuple[int, ...]:
    """Return the delay (milliseconds) before each retry, in order.

    The schedule is a pure function of the stored knobs — ``backoffMs * multiplier ** n`` for the
    n-th retry, truncated to whole milliseconds, with no jitter and no clock input. That is what
    makes fixture-driven retries deterministic: the same definition always yields the same
    sequence, so a test can assert the exact attempt timeline instead of a tolerance band.

    An empty tuple means "no retries" (a single attempt).

    Args:
        retry: The definition's ``retry`` block, or ``None`` for the defaults.

    Returns:
        One delay per retry; ``len(...) == maxAttempts - 1``.
    """
    block = retry if isinstance(retry, Mapping) else {}
    attempts = _coerce_int(block.get("maxAttempts"), DEFAULT_MAX_ATTEMPTS)
    attempts = max(1, min(attempts, MAX_ATTEMPTS))
    backoff = _coerce_int(block.get("backoffMs"), DEFAULT_BACKOFF_MS)
    backoff = max(0, min(backoff, MAX_BACKOFF_MS))
    multiplier = _coerce_float(block.get("backoffMultiplier"), DEFAULT_BACKOFF_MULTIPLIER)
    if multiplier < 1.0:
        multiplier = 1.0

    delays: List[int] = []
    for index in range(attempts - 1):
        delays.append(min(int(backoff * (multiplier**index)), MAX_BACKOFF_MS))
    return tuple(delays)


def _coerce_int(value: Any, fallback: int) -> int:
    """Return ``value`` as an int, falling back for booleans and non-integers."""
    if isinstance(value, bool) or not isinstance(value, int):
        return fallback
    return value


def _coerce_float(value: Any, fallback: float) -> float:
    """Return ``value`` as a float, falling back for booleans and non-numbers."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    return float(value)


def _validate_trigger(
    name: str,
    trigger: Any,
    *,
    operation_keys: Mapping[str, Any],
    errors: List[str],
) -> None:
    """Validate one definition's ``trigger`` block against the version's spec."""
    label = f"Callback '{name}' trigger"
    if not isinstance(trigger, dict):
        errors.append(f"{label}: must be an object.")
        return
    unknown = sorted(set(trigger) - _ALLOWED_TRIGGER_KEYS)
    if unknown:
        errors.append(f"{label}: unknown keys: {', '.join(unknown)}.")

    operation = trigger.get("operation")
    if operation is not None:
        if not isinstance(operation, str):
            errors.append(f"{label}: 'operation' must be a \"METHOD /path\" string.")
        else:
            key = _normalize_operation_key(operation)
            if key is None:
                errors.append(f"{label}: operation keys must look like 'POST /orders'.")
            elif key not in operation_keys:
                errors.append(f"{label}: no operation {key} exists in this version's spec.")

    statuses = trigger.get("statuses")
    if statuses is not None:
        if not isinstance(statuses, list) or not statuses:
            errors.append(f"{label}: 'statuses' must be a non-empty list of response status codes.")
        elif len(statuses) > MAX_TRIGGER_STATUSES:
            errors.append(f"{label}: at most {MAX_TRIGGER_STATUSES} trigger statuses are allowed.")
        else:
            for status in statuses:
                if isinstance(status, bool) or not isinstance(status, int) or not _MIN_STATUS <= status <= _MAX_STATUS:
                    errors.append(f"{label}: status {status!r} must be an integer between 100 and 599.")


def _normalize_operation_key(raw: str) -> Optional[str]:
    """Normalize an operation key to canonical ``"METHOD /template"`` form.

    Mirrors ``apiome_mock.scenarios.normalize_operation_key`` so author-time validation and the
    runtime agree on the key shape.
    """
    parts = raw.strip().split(None, 1)
    if len(parts) != 2:
        return None
    method, path = parts
    if not method.isalpha() or not path.startswith("/"):
        return None
    return f"{method.upper()} {path}"


def _validate_destinations(name: str, destinations: Any, errors: List[str]) -> None:
    """Validate the allowlist: present, bounded, and every entry a safe absolute URL."""
    label = f"Callback '{name}' destinations"
    if not isinstance(destinations, list) or not destinations:
        errors.append(
            f"{label}: at least one allowlisted destination URL is required — "
            "a callback with no authorized destination can never be delivered."
        )
        return
    if len(destinations) > MAX_DESTINATIONS:
        errors.append(f"{label}: at most {MAX_DESTINATIONS} destinations are allowed.")
    for entry in destinations:
        if not isinstance(entry, str) or not entry.strip():
            errors.append(f"{label}: each entry must be an absolute http(s) URL.")
            continue
        try:
            validate_url_policy(entry.strip())
        except SSRFError as exc:
            errors.append(f"{label}: {entry.strip()!r} is not an allowed destination ({exc}).")
            continue
        if normalize_destination(entry) is None:
            errors.append(f"{label}: {entry.strip()!r} could not be normalized to a delivery target.")


def _validate_request(name: str, request: Any, errors: List[str]) -> None:
    """Validate the outbound message shape: method, headers, and templated body."""
    label = f"Callback '{name}' request"
    if not isinstance(request, dict):
        errors.append(f"{label}: must be an object.")
        return
    unknown = sorted(set(request) - _ALLOWED_REQUEST_KEYS)
    if unknown:
        errors.append(f"{label}: unknown keys: {', '.join(unknown)}.")

    method = request.get("method")
    if method is not None:
        if not isinstance(method, str) or method.upper() not in ALLOWED_METHODS:
            errors.append(f"{label}: method must be one of {', '.join(ALLOWED_METHODS)}.")

    headers = request.get("headers")
    if headers is not None:
        if not isinstance(headers, dict):
            errors.append(f"{label}: headers must be an object of string values.")
        else:
            if len(headers) > MAX_HEADERS:
                errors.append(f"{label}: at most {MAX_HEADERS} headers are allowed.")
            for header_name, value in headers.items():
                if not isinstance(header_name, str) or not _HEADER_NAME_PATTERN.match(header_name):
                    errors.append(f"{label}: invalid header name {header_name!r}.")
                    continue
                if header_name.lower() in _RESERVED_HEADERS:
                    errors.append(
                        f"{label}: header '{header_name}' is managed by the runtime and cannot be set."
                    )
                if not isinstance(value, str):
                    errors.append(f"{label}: header '{header_name}' value must be a string.")
                    continue
                if "\r" in value or "\n" in value:
                    errors.append(f"{label}: header '{header_name}' value must not contain CR/LF characters.")
                    continue
                errors.extend(validate_template_text(value, context=f"{label} header '{header_name}'"))

    if "body" in request:
        errors.extend(validate_template_value(request.get("body"), context=f"{label} body"))


def _validate_payload_schema(name: str, schema: Any, spec: Mapping[str, Any], errors: List[str]) -> None:
    """Validate the declared payload schema: an object, and any ``$ref`` resolvable in the spec."""
    label = f"Callback '{name}' payloadSchema"
    if not isinstance(schema, dict):
        errors.append(f"{label}: must be a JSON Schema object.")
        return
    ref = schema.get("$ref")
    if ref is None:
        return
    if not isinstance(ref, str) or not ref.startswith("#/"):
        errors.append(f"{label}: $ref must be a local reference such as '#/components/schemas/OrderEvent'.")
        return
    target: Any = spec
    for segment in ref[2:].split("/"):
        if not isinstance(target, Mapping) or segment not in target:
            errors.append(f"{label}: $ref '{ref}' does not resolve in this version's spec.")
            return
        target = target[segment]
    if not isinstance(target, Mapping):
        errors.append(f"{label}: $ref '{ref}' does not point at a schema object.")


def _validate_retry(name: str, retry: Any, errors: List[str]) -> None:
    """Validate the retry knobs and the worst-case cost of the schedule they describe."""
    label = f"Callback '{name}' retry"
    if not isinstance(retry, dict):
        errors.append(f"{label}: must be an object.")
        return

    # Knob errors collect locally: the cost check at the end is only meaningful once *these*
    # knobs are known good, and gating it on the caller's accumulated list would skip it whenever
    # any earlier callback happened to be invalid.
    local: List[str] = []

    unknown = sorted(set(retry) - _ALLOWED_RETRY_KEYS)
    if unknown:
        local.append(f"{label}: unknown keys: {', '.join(unknown)}.")

    attempts = retry.get("maxAttempts")
    if attempts is not None and (
        isinstance(attempts, bool) or not isinstance(attempts, int) or not 1 <= attempts <= MAX_ATTEMPTS
    ):
        local.append(f"{label}: maxAttempts must be an integer between 1 and {MAX_ATTEMPTS}.")

    backoff = retry.get("backoffMs")
    if backoff is not None and (
        isinstance(backoff, bool) or not isinstance(backoff, int) or not 0 <= backoff <= MAX_BACKOFF_MS
    ):
        local.append(f"{label}: backoffMs must be an integer between 0 and {MAX_BACKOFF_MS}.")

    multiplier = retry.get("backoffMultiplier")
    if multiplier is not None and (
        isinstance(multiplier, bool) or not isinstance(multiplier, (int, float)) or not 1.0 <= float(multiplier) <= 10.0
    ):
        local.append(f"{label}: backoffMultiplier must be a number between 1.0 and 10.0.")

    retry_on = retry.get("retryOn")
    if retry_on is not None:
        if not isinstance(retry_on, list):
            local.append(f"{label}: retryOn must be a list of response status codes.")
        elif len(retry_on) > MAX_TRIGGER_STATUSES:
            local.append(f"{label}: at most {MAX_TRIGGER_STATUSES} retryOn statuses are allowed.")
        else:
            for status in retry_on:
                if isinstance(status, bool) or not isinstance(status, int) or not _MIN_STATUS <= status <= _MAX_STATUS:
                    local.append(f"{label}: retryOn status {status!r} must be an integer between 100 and 599.")

    timeout = retry.get("timeoutMs")
    if timeout is not None and (
        isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= MAX_TIMEOUT_MS
    ):
        local.append(f"{label}: timeoutMs must be an integer between 1 and {MAX_TIMEOUT_MS}.")

    if not local:
        delays = retry_delays(retry)
        timeout = _coerce_int(retry.get("timeoutMs"), DEFAULT_TIMEOUT_MS)
        total = sum(delays) + (len(delays) + 1) * timeout
        if total > MAX_TOTAL_DELIVERY_MS:
            local.append(
                f"{label}: the schedule could take {total} ms in the worst case "
                f"({len(delays) + 1} attempts of up to {timeout} ms plus {sum(delays)} ms of backoff); "
                f"at most {MAX_TOTAL_DELIVERY_MS} ms is allowed."
            )
    errors.extend(local)


def _validate_callback(
    name: str,
    callback: Any,
    *,
    spec: Mapping[str, Any],
    operation_keys: Mapping[str, Any],
    errors: List[str],
) -> None:
    """Validate one callback definition against the v1 schema and the version's spec."""
    if not isinstance(name, str) or not CALLBACK_NAME_PATTERN.match(name):
        errors.append(
            f"Callback name {name!r} is invalid: use 1-64 characters from [A-Za-z0-9._-], "
            "starting with a letter or digit."
        )
        return
    if not isinstance(callback, dict):
        errors.append(f"Callback '{name}' must be a JSON object.")
        return

    unknown = sorted(set(callback) - _ALLOWED_CALLBACK_KEYS)
    if unknown:
        errors.append(f"Callback '{name}' has unknown keys: {', '.join(unknown)}.")

    declared_format = callback.get("callbackFormat", CALLBACK_FORMAT)
    if declared_format != CALLBACK_FORMAT:
        errors.append(
            f"Callback '{name}' declares callbackFormat {declared_format!r}; expected '{CALLBACK_FORMAT}'."
        )
    declared_version = callback.get("callbackFormatVersion", CALLBACK_FORMAT_VERSION)
    if isinstance(declared_version, bool) or declared_version not in SUPPORTED_CALLBACK_FORMAT_VERSIONS:
        errors.append(
            f"Callback '{name}' declares callbackFormatVersion {declared_version!r}; "
            f"supported: {', '.join(str(v) for v in SUPPORTED_CALLBACK_FORMAT_VERSIONS)}."
        )

    description = callback.get("description")
    if description is not None:
        if not isinstance(description, str):
            errors.append(f"Callback '{name}': description must be a string.")
        elif len(description) > _MAX_DESCRIPTION_LENGTH:
            errors.append(f"Callback '{name}': description exceeds {_MAX_DESCRIPTION_LENGTH} characters.")

    if callback.get("trigger") is not None:
        _validate_trigger(name, callback.get("trigger"), operation_keys=operation_keys, errors=errors)
    _validate_destinations(name, callback.get("destinations"), errors)
    if callback.get("request") is not None:
        _validate_request(name, callback.get("request"), errors)
    if callback.get("payloadSchema") is not None:
        _validate_payload_schema(name, callback.get("payloadSchema"), spec, errors)
    if callback.get("retry") is not None:
        _validate_retry(name, callback.get("retry"), errors)

    canonical = canonical_callback(callback)
    if len(canonical_json(canonical).encode("utf-8")) > MAX_CALLBACK_BYTES:
        errors.append(f"Callback '{name}' exceeds the {MAX_CALLBACK_BYTES} byte size limit.")


def validate_mock_callbacks(callbacks: Any, spec: Mapping[str, Any]) -> List[str]:
    """Validate a ``{name: definition}`` mapping against the v1 schema (author-time, strict).

    Args:
        callbacks: The proposed callback definitions, keyed by callback name.
        spec: The version's generated OpenAPI document, used to check that a trigger names a real
            operation and that a ``payloadSchema`` ``$ref`` resolves.

    Returns:
        Every validation error found (empty when the definitions are valid). Errors are stable,
        human-readable sentences suitable for a 422 response body.
    """
    errors: List[str] = []
    if not isinstance(callbacks, dict):
        return ["Callbacks must be an object keyed by callback name."]
    if len(callbacks) > MAX_CALLBACKS:
        errors.append(f"At most {MAX_CALLBACKS} callbacks are allowed per version.")

    operation_keys = {op.key: op for op in extract_operations(dict(spec))}
    for name, callback in callbacks.items():
        _validate_callback(name, callback, spec=spec, operation_keys=operation_keys, errors=errors)

    storage = callbacks_to_storage(callbacks) if not errors else {}
    if storage:
        size = len(canonical_json(storage).encode("utf-8"))
        if size > _MAX_SETTINGS_BYTES:
            errors.append(f"Callback definitions are too large ({size} bytes; max {_MAX_SETTINGS_BYTES}).")
    return errors


def _canonical_trigger(trigger: Any) -> Optional[Dict[str, Any]]:
    """Return the canonical ``trigger`` block, or ``None`` when it declares nothing."""
    if not isinstance(trigger, Mapping):
        return None
    canonical: Dict[str, Any] = {}
    operation = trigger.get("operation")
    if isinstance(operation, str):
        key = _normalize_operation_key(operation)
        if key is not None:
            canonical["operation"] = key
    statuses = trigger.get("statuses")
    if isinstance(statuses, (list, tuple)):
        codes = sorted({s for s in statuses if isinstance(s, int) and not isinstance(s, bool)})
        if codes:
            canonical["statuses"] = codes
    return canonical or None


def _canonical_request(request: Any) -> Optional[Dict[str, Any]]:
    """Return the canonical outbound ``request`` block, or ``None`` when it declares nothing."""
    if not isinstance(request, Mapping):
        return None
    canonical: Dict[str, Any] = {}
    method = request.get("method")
    if isinstance(method, str) and method.upper() in ALLOWED_METHODS:
        canonical["method"] = method.upper()
    headers = request.get("headers")
    if isinstance(headers, Mapping):
        pairs = {
            str(key): value
            for key, value in headers.items()
            if isinstance(key, str) and isinstance(value, str)
        }
        if pairs:
            canonical["headers"] = pairs
    if "body" in request:
        canonical["body"] = request.get("body")
    return canonical or None


def _canonical_retry(retry: Any) -> Optional[Dict[str, Any]]:
    """Return the canonical ``retry`` block, or ``None`` when it declares nothing."""
    if not isinstance(retry, Mapping):
        return None
    canonical: Dict[str, Any] = {}
    for key in ("maxAttempts", "backoffMs", "timeoutMs"):
        value = retry.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            canonical[key] = value
    multiplier = retry.get("backoffMultiplier")
    if isinstance(multiplier, (int, float)) and not isinstance(multiplier, bool):
        canonical["backoffMultiplier"] = float(multiplier)
    retry_on = retry.get("retryOn")
    if isinstance(retry_on, (list, tuple)):
        codes = sorted({s for s in retry_on if isinstance(s, int) and not isinstance(s, bool)})
        if codes:
            canonical["retryOn"] = codes
    return canonical or None


def canonical_callback(callback: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the canonical (digestible, storable) form of one callback definition.

    The canonical form always declares the format id and version, normalizes every destination
    (:func:`normalize_destination`) and drops unusable ones, keeps optional blocks only when they
    declare something, and drops unknown keys. Digesting this shape — rather than the raw input —
    means cosmetic differences (an omitted-vs-explicit format id, a trailing slash on a
    destination, a lower-case method) never change a definition's digest.

    Args:
        callback: A definition document (validated author-side, or lenient-parsed runtime-side).

    Returns:
        The canonical definition document.
    """
    canonical: Dict[str, Any] = {
        "callbackFormat": CALLBACK_FORMAT,
        "callbackFormatVersion": CALLBACK_FORMAT_VERSION,
    }
    description = callback.get("description")
    if isinstance(description, str) and description.strip():
        canonical["description"] = description

    trigger = _canonical_trigger(callback.get("trigger"))
    if trigger is not None:
        canonical["trigger"] = trigger

    raw_destinations = callback.get("destinations")
    destinations: List[str] = []
    if isinstance(raw_destinations, (list, tuple)):
        for entry in raw_destinations:
            normalized = normalize_destination(entry)
            if normalized is not None and normalized not in destinations:
                destinations.append(normalized)
    if destinations:
        canonical["destinations"] = destinations

    request = _canonical_request(callback.get("request"))
    if request is not None:
        canonical["request"] = request

    payload_schema = callback.get("payloadSchema")
    if isinstance(payload_schema, Mapping) and payload_schema:
        canonical["payloadSchema"] = dict(payload_schema)

    retry = _canonical_retry(callback.get("retry"))
    if retry is not None:
        canonical["retry"] = retry
    return canonical


def callback_digest(callback: Mapping[str, Any]) -> str:
    """Return ``sha256:<hex>`` over the canonical JSON of the canonicalized definition.

    This is the definition's stable identity: the value the authoring API returns on save, the
    runtime reports from its control endpoints and delivery records, and a test asserts to pin
    exactly which callback contract it exercised.

    Args:
        callback: A callback definition document.

    Returns:
        The prefixed digest string.
    """
    return content_digest(canonical_callback(callback))


def callback_digests(callbacks: Mapping[str, Any]) -> Dict[str, str]:
    """Return the digest of every definition in a mapping, keyed by callback name.

    Args:
        callbacks: Definitions keyed by name.

    Returns:
        ``{name: "sha256:<hex>"}`` for every definition.
    """
    return {name: callback_digest(callback) for name, callback in callbacks.items()}


def callbacks_from_storage(mock_settings: Any) -> Dict[str, Any]:
    """Extract the stored ``callbacks`` mapping from raw ``versions.mock_settings``.

    Accepts the raw JSONB value (dict, JSON text, or ``None``) and never raises; a malformed blob
    yields an empty mapping. Entries are returned as stored — callers validate or lenient-parse as
    their context requires.

    Args:
        mock_settings: The raw ``versions.mock_settings`` value.

    Returns:
        The ``{name: definition}`` mapping (possibly empty).
    """
    settings = parse_mock_settings(mock_settings)
    raw = settings.get("callbacks")
    if not isinstance(raw, dict):
        return {}
    return {name: callback for name, callback in raw.items() if isinstance(name, str)}


def callbacks_to_storage(callbacks: Mapping[str, Any]) -> Dict[str, Any]:
    """Canonicalize validated definitions into the shape stored under ``callbacks``.

    Args:
        callbacks: Validated definitions keyed by name.

    Returns:
        The canonical ``{name: definition}`` mapping to persist.
    """
    return {
        name: canonical_callback(callback)
        for name, callback in callbacks.items()
        if isinstance(callback, Mapping)
    }
