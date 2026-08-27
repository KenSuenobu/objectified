"""Guarded proxy capture: policy, redaction, and capture records (PMR-2.4, #4747).

Teams want mock fixtures that look like their real traffic. The obvious way to get them — point
the mock at the real service and record what comes back — is also the fastest way to build two
serious problems: a server-side request forgery pivot (anyone who can name an upstream can make
Apiome fetch it) and a database full of bearer tokens, cookies, and customer data.

This module is the *rule set* that makes recording safe. It owns four things, all pure functions
over JSON so they can be reasoned about and tested without a socket or a database:

**1. The capture policy** (``apiome.mock.capture-policy/v1``). Stored in ``versions.mock_settings``
under :data:`CAPTURE_SETTINGS_KEY`, alongside the other mock knobs::

    {
      "proxyCapture": {
        "policyFormat": "apiome.mock.capture-policy/v1",
        "policyFormatVersion": 1,
        "enabled": true,
        "upstreams": ["https://api.example.com/v1"],
        "authorization": {
          "authorizedBy": "<user id>",
          "authorizedAt": "2026-08-26T18:00:00Z",
          "expiresAt": "2026-08-27T18:00:00Z"
        },
        "redaction": {
          "headers": ["x-internal-trace"],
          "queryParams": ["customer"],
          "bodyFields": ["ssn", "/customer/dateOfBirth"],
          "patterns": ["email"]
        },
        "validateResponses": true
      }
    }

The ``authorization`` block is **server-stamped**, never client-supplied: an author asks for
capture and the API records who they were and when the grant lapses. Capture is off unless the
policy says ``enabled``, names at least one upstream, and has not expired — three independent
conditions, all fail-closed (:func:`capture_authorization_state`).

**2. The upstream allowlist.** :func:`resolve_capture_upstream` answers exactly one question: for
this relative request path, which allowlist entry authorizes a fetch, and what absolute URL does
it produce? Matching reuses the callback destination rules (:func:`app.mock_callbacks.
match_destination`) so "allowlisted" means the same thing for outbound webhooks and for upstream
capture — scheme, host and port equal, path a descendant at a segment boundary. Address-level SSRF
defence (public IPs only, on every redirect hop) stays where it already lives, in
:mod:`app.ssrf_guard`; this module never resolves DNS.

**3. The redaction engine.** :func:`redact_exchange` turns one live request/response pair into the
record that may be persisted. Four rule families run over it, and every removal is *recorded*:

* always-on credential rules — the header names in :data:`ALWAYS_REDACTED_HEADERS`, the query
  parameters in :data:`ALWAYS_REDACTED_QUERY_PARAMS`, anything *credential-shaped* by the
  definition portable bundles already use (:func:`app.mock_bundle.find_credential_fields`), whether
  it is a header, a query parameter, or a body field, and JWT-shaped values anywhere;
* policy rules — the extra header names, query parameters, and body fields this version's author
  declared;
* pattern rules — the opt-in value detectors in :data:`REDACTION_PATTERNS` (email, phone, credit
  card, national id, IPv4) for personal data that is not a credential;
* size and type rules — a body that is too large or not textual is dropped whole rather than
  stored unexamined.

Redaction **removes**; it never masks. A masked secret still leaks its length and shape, and a
reviewer reading the pack cannot tell a masked token from a real value someone typed. What is
kept instead is the *decision*: an RFC 6901 pointer, the rule that fired, and a sentence saying
why (:class:`RedactionDecision`). That list is the audit trail acceptance criterion 3 asks for.

**4. The capture record and its conversion.** :func:`build_capture_record` assembles the
redacted exchange, its provenance (which upstream, which allowlist entry, which operation, which
policy digest, who captured it and when), its schema-validation outcome, and its redaction
decisions into one ``apiome.mock.capture/v1`` document. :func:`residual_credential_pointers`
re-scans that finished document; the caller refuses to persist anything it still flags, so a gap
in the rules above fails closed instead of silently storing a secret.

Nothing reaches a fixture pack automatically. :func:`fixture_pack_from_captures` converts records
an owner has explicitly approved into a PMR-2.2 fixture pack, and stamps the pack with a
``provenance`` block naming the upstreams it came from and how many redactions were applied — the
block the runtime reports back on every listing and reset, so a replayed fixture always says where
it came from (acceptance criterion 4).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit, urlunsplit

from .mock_bundle import canonical_json, content_digest, find_credential_fields, redact_credentials
from .mock_callbacks import match_destination, normalize_destination
from .mock_fixture_packs import (
    MAX_PACK_BYTES,
    MAX_RESOURCES_PER_COLLECTION,
    PACK_NAME_PATTERN,
    collection_resource_id,
)
from .mock_settings_util import parse_mock_settings

__all__ = [
    "ALWAYS_REDACTED_HEADERS",
    "ALWAYS_REDACTED_QUERY_PARAMS",
    "CAPTURE_FORMAT",
    "CAPTURE_FORMAT_VERSION",
    "CAPTURE_POLICY_FORMAT",
    "CAPTURE_POLICY_FORMAT_VERSION",
    "CAPTURE_SETTINGS_KEY",
    "DEFAULT_AUTHORIZATION_HOURS",
    "MAX_AUTHORIZATION_HOURS",
    "MAX_CAPTURE_BODY_BYTES",
    "MAX_PENDING_CAPTURES",
    "MAX_UPSTREAMS",
    "REDACTION_PATTERNS",
    "REVIEW_STATES",
    "SUPPORTED_CAPTURE_POLICY_FORMAT_VERSIONS",
    "CaptureProvenance",
    "CaptureUpstream",
    "RedactedExchange",
    "RedactionDecision",
    "RedactionRules",
    "authorization_block",
    "build_capture_record",
    "canonical_capture_policy",
    "capture_authorization_state",
    "capture_policy_digest",
    "capture_policy_from_storage",
    "capture_policy_to_storage",
    "capture_record_digest",
    "fixture_pack_from_captures",
    "redact_exchange",
    "redaction_rules_from_policy",
    "residual_credential_pointers",
    "resolve_capture_upstream",
    "validate_capture_policy",
]

# ==================================================================================================
# Format identity and limits
# ==================================================================================================

#: Key in ``versions.mock_settings`` holding the capture policy. Deliberately *not* in
#: :data:`app.mock_bundle.BUNDLED_SETTINGS_KEYS`: an authorization to record real traffic is a
#: hosted, revocable grant and must never travel inside a portable bundle.
CAPTURE_SETTINGS_KEY = "proxyCapture"

#: Media-type-shaped identifier of the capture policy document family.
CAPTURE_POLICY_FORMAT = "apiome.mock.capture-policy/v1"

#: Additive revision of :data:`CAPTURE_POLICY_FORMAT`.
CAPTURE_POLICY_FORMAT_VERSION = 1

#: Policy format versions this build can produce and consume.
SUPPORTED_CAPTURE_POLICY_FORMAT_VERSIONS: Tuple[int, ...] = (1,)

#: Media-type-shaped identifier of one recorded exchange.
CAPTURE_FORMAT = "apiome.mock.capture/v1"

#: Additive revision of :data:`CAPTURE_FORMAT`.
CAPTURE_FORMAT_VERSION = 1

#: Maximum allowlisted upstreams in one policy.
MAX_UPSTREAMS = 10

#: Maximum redaction rules of any one kind (headers, query parameters, body fields).
MAX_REDACTION_RULES = 50

#: Longest an authorization may run before it must be renewed (7 days).
MAX_AUTHORIZATION_HOURS = 168

#: Authorization lifetime when the author does not ask for one.
DEFAULT_AUTHORIZATION_HOURS = 24

#: Largest request or response body a capture keeps (64 KiB). Larger bodies are dropped whole:
#: a fixture nobody will read is not worth the storage or the redaction risk.
MAX_CAPTURE_BODY_BYTES = 65_536

#: Captures one version may hold awaiting review before the runtime stops recording.
MAX_PENDING_CAPTURES = 500

#: Review states one stored capture moves through. ``pending`` on arrival; an owner moves it to
#: ``approved`` or ``rejected``; publishing an approved capture into a pack marks it ``published``.
REVIEW_STATES: Tuple[str, ...] = ("pending", "approved", "rejected", "published")

#: Maximum length of an upstream entry, matching the callback destination ceiling.
_MAX_UPSTREAM_LENGTH = 2000

#: Top-level policy keys; anything else fails author-time validation so a typo is an error rather
#: than silently dead configuration.
_ALLOWED_POLICY_KEYS = frozenset(
    {
        "policyFormat",
        "policyFormatVersion",
        "enabled",
        "upstreams",
        "authorization",
        "redaction",
        "validateResponses",
    }
)

_ALLOWED_AUTHORIZATION_KEYS = frozenset({"authorizedBy", "authorizedAt", "expiresAt"})

_ALLOWED_REDACTION_KEYS = frozenset({"headers", "queryParams", "bodyFields", "patterns"})


# ==================================================================================================
# Always-on credential rules
# ==================================================================================================

#: Request/response headers whose values are never persisted, whatever the policy says. Matched
#: case-insensitively against the exact header name.
ALWAYS_REDACTED_HEADERS: frozenset[str] = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
        "api-key",
        "apikey",
        "x-auth-token",
        "x-access-token",
        "x-refresh-token",
        "x-session-token",
        "x-amz-security-token",
        "x-amz-content-sha256",
        "x-goog-api-key",
        "x-csrf-token",
        "x-xsrf-token",
        "authentication",
    }
)

#: Query parameters whose values are never persisted. Some of these (``key``, ``code``) have
#: innocent uses; capture prefers dropping a harmless filter to keeping one live token.
ALWAYS_REDACTED_QUERY_PARAMS: frozenset[str] = frozenset(
    {
        "access_token",
        "refresh_token",
        "id_token",
        "token",
        "api_key",
        "apikey",
        "key",
        "secret",
        "password",
        "signature",
        "sig",
        "code",
        "auth",
        "session",
    }
)

#: A compact JWT: three base64url segments. Recognized wherever it appears, because a token is a
#: token whatever field it was handed to.
_JWT_PATTERN = re.compile(r"^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$")

#: Opt-in value detectors for personal data that is not a credential. Selected by name in the
#: policy's ``redaction.patterns``; a value matching a selected detector is dropped like a secret.
REDACTION_PATTERNS: Dict[str, re.Pattern[str]] = {
    "email": re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"),
    "phone": re.compile(r"^\+?[0-9][0-9 ()\-.]{6,20}$"),
    "creditCard": re.compile(r"^(?:[0-9][ -]?){12,18}[0-9]$"),
    "nationalId": re.compile(r"^\d{3}-\d{2}-\d{4}$"),
    "ipv4": re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$"),
}


def _normalize_name(name: str) -> str:
    """Lowercase a name and drop separators, so ``X-API-Key``/``x_api_key`` compare equal."""
    return "".join(ch for ch in name.lower() if ch.isalnum())


_ALWAYS_REDACTED_HEADER_KEYS = frozenset(_normalize_name(name) for name in ALWAYS_REDACTED_HEADERS)
_ALWAYS_REDACTED_QUERY_KEYS = frozenset(_normalize_name(name) for name in ALWAYS_REDACTED_QUERY_PARAMS)


def _escape_pointer_segment(segment: str) -> str:
    """Escape one RFC 6901 pointer segment (``~`` → ``~0``, ``/`` → ``~1``)."""
    return segment.replace("~", "~0").replace("/", "~1")


# ==================================================================================================
# Policy validation and canonicalization
# ==================================================================================================


def _validate_upstreams(raw: Any, errors: List[str]) -> None:
    """Validate the ``upstreams`` allowlist."""
    if not isinstance(raw, list) or not raw:
        errors.append("Capture policy: 'upstreams' must be a non-empty list of absolute http(s) URLs.")
        return
    if len(raw) > MAX_UPSTREAMS:
        errors.append(f"Capture policy: at most {MAX_UPSTREAMS} allowlisted upstreams are permitted.")
        return
    for index, entry in enumerate(raw):
        if not isinstance(entry, str) or len(entry) > _MAX_UPSTREAM_LENGTH:
            errors.append(
                f"Capture policy: upstreams[{index}] must be a string of at most "
                f"{_MAX_UPSTREAM_LENGTH} characters."
            )
            continue
        if normalize_destination(entry) is None:
            errors.append(
                f"Capture policy: upstreams[{index}] ({entry!r}) is not a usable absolute "
                "http(s) URL without embedded credentials."
            )


def _validate_rule_list(label: str, raw: Any, errors: List[str]) -> None:
    """Validate one redaction rule list (header names, query parameters, or body fields)."""
    if not isinstance(raw, list):
        errors.append(f"Capture policy: redaction.{label} must be a list of names.")
        return
    if len(raw) > MAX_REDACTION_RULES:
        errors.append(f"Capture policy: redaction.{label} allows at most {MAX_REDACTION_RULES} entries.")
        return
    for index, entry in enumerate(raw):
        if not isinstance(entry, str) or not entry.strip() or len(entry) > 200:
            errors.append(
                f"Capture policy: redaction.{label}[{index}] must be a non-blank name "
                "of at most 200 characters."
            )


def _validate_redaction(raw: Any, errors: List[str]) -> None:
    """Validate the optional ``redaction`` block."""
    if raw is None:
        return
    if not isinstance(raw, dict):
        errors.append("Capture policy: 'redaction' must be an object.")
        return
    unknown = sorted(set(raw) - _ALLOWED_REDACTION_KEYS)
    if unknown:
        errors.append(f"Capture policy: redaction has unknown keys: {', '.join(unknown)}.")
    for key in ("headers", "queryParams", "bodyFields"):
        if key in raw:
            _validate_rule_list(key, raw[key], errors)
    patterns = raw.get("patterns")
    if patterns is not None:
        if not isinstance(patterns, list):
            errors.append("Capture policy: redaction.patterns must be a list of detector names.")
        else:
            for index, name in enumerate(patterns):
                if name not in REDACTION_PATTERNS:
                    errors.append(
                        f"Capture policy: redaction.patterns[{index}] ({name!r}) is not a known "
                        f"detector; available: {', '.join(sorted(REDACTION_PATTERNS))}."
                    )


def _parse_timestamp(value: Any) -> Optional[datetime]:
    """Parse an ISO 8601 timestamp into an aware UTC datetime, or ``None`` when unusable."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _validate_authorization(raw: Any, errors: List[str]) -> None:
    """Validate the server-stamped ``authorization`` block."""
    if not isinstance(raw, dict):
        errors.append("Capture policy: 'authorization' must be an object naming who authorized capture.")
        return
    unknown = sorted(set(raw) - _ALLOWED_AUTHORIZATION_KEYS)
    if unknown:
        errors.append(f"Capture policy: authorization has unknown keys: {', '.join(unknown)}.")
    authorized_by = raw.get("authorizedBy")
    if not isinstance(authorized_by, str) or not authorized_by.strip():
        errors.append("Capture policy: authorization.authorizedBy must name the authorizing user.")
    for key in ("authorizedAt", "expiresAt"):
        if _parse_timestamp(raw.get(key)) is None:
            errors.append(f"Capture policy: authorization.{key} must be an ISO 8601 timestamp.")
    granted = _parse_timestamp(raw.get("authorizedAt"))
    expires = _parse_timestamp(raw.get("expiresAt"))
    if granted is not None and expires is not None:
        if expires <= granted:
            errors.append("Capture policy: authorization.expiresAt must be after authorization.authorizedAt.")
        elif expires - granted > timedelta(hours=MAX_AUTHORIZATION_HOURS):
            errors.append(
                f"Capture policy: an authorization may not run longer than {MAX_AUTHORIZATION_HOURS} hours."
            )


def validate_capture_policy(policy: Any) -> List[str]:
    """Validate a capture policy document (author-time, strict).

    Args:
        policy: The proposed policy document.

    Returns:
        Every validation error found (empty when the policy is valid). Errors are stable,
        human-readable sentences suitable for a 422 response body.
    """
    errors: List[str] = []
    if not isinstance(policy, dict):
        return ["Capture policy must be a JSON object."]

    unknown = sorted(set(policy) - _ALLOWED_POLICY_KEYS)
    if unknown:
        errors.append(f"Capture policy has unknown keys: {', '.join(unknown)}.")

    declared_format = policy.get("policyFormat", CAPTURE_POLICY_FORMAT)
    if declared_format != CAPTURE_POLICY_FORMAT:
        errors.append(
            f"Capture policy declares policyFormat {declared_format!r}; expected '{CAPTURE_POLICY_FORMAT}'."
        )
    declared_version = policy.get("policyFormatVersion", CAPTURE_POLICY_FORMAT_VERSION)
    if isinstance(declared_version, bool) or declared_version not in SUPPORTED_CAPTURE_POLICY_FORMAT_VERSIONS:
        errors.append(
            f"Capture policy declares policyFormatVersion {declared_version!r}; supported: "
            f"{', '.join(str(v) for v in SUPPORTED_CAPTURE_POLICY_FORMAT_VERSIONS)}."
        )

    enabled = policy.get("enabled", False)
    if not isinstance(enabled, bool):
        errors.append("Capture policy: 'enabled' must be true or false.")
    validate_responses = policy.get("validateResponses", True)
    if not isinstance(validate_responses, bool):
        errors.append("Capture policy: 'validateResponses' must be true or false.")

    _validate_upstreams(policy.get("upstreams"), errors)
    _validate_authorization(policy.get("authorization"), errors)
    _validate_redaction(policy.get("redaction"), errors)
    return errors


def _canonical_rule_list(raw: Any) -> List[str]:
    """Return a sorted, de-duplicated rule list; blanks and non-strings drop out."""
    if not isinstance(raw, (list, tuple)):
        return []
    seen: Dict[str, None] = {}
    for entry in raw:
        if isinstance(entry, str) and entry.strip():
            seen.setdefault(entry.strip(), None)
    return sorted(seen)


def canonical_capture_policy(policy: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the canonical (digestible, storable) form of a capture policy.

    The canonical form always declares the format id and version, normalizes every upstream to
    its canonical URL, sorts and de-duplicates the redaction rules, and drops unknown keys —
    so two policies that differ only cosmetically digest identically.

    Args:
        policy: A policy document (validated author-side, or lenient-parsed runtime-side).

    Returns:
        The canonical policy document.
    """
    canonical: Dict[str, Any] = {
        "policyFormat": CAPTURE_POLICY_FORMAT,
        "policyFormatVersion": CAPTURE_POLICY_FORMAT_VERSION,
        "enabled": bool(policy.get("enabled", False)),
    }

    upstreams: List[str] = []
    raw_upstreams = policy.get("upstreams")
    if isinstance(raw_upstreams, (list, tuple)):
        for entry in raw_upstreams:
            normalized = normalize_destination(entry)
            if normalized is not None and normalized not in upstreams:
                upstreams.append(normalized)
    canonical["upstreams"] = sorted(upstreams)

    authorization = policy.get("authorization")
    if isinstance(authorization, Mapping):
        block: Dict[str, Any] = {}
        for key in ("authorizedBy", "authorizedAt", "expiresAt"):
            value = authorization.get(key)
            if isinstance(value, str) and value.strip():
                block[key] = value.strip()
        if block:
            canonical["authorization"] = block

    redaction = policy.get("redaction")
    if isinstance(redaction, Mapping):
        cleaned: Dict[str, Any] = {}
        for key in ("headers", "queryParams", "bodyFields"):
            values = _canonical_rule_list(redaction.get(key))
            if values:
                cleaned[key] = values
        patterns = [name for name in _canonical_rule_list(redaction.get("patterns")) if name in REDACTION_PATTERNS]
        if patterns:
            cleaned["patterns"] = patterns
        if cleaned:
            canonical["redaction"] = cleaned

    canonical["validateResponses"] = bool(policy.get("validateResponses", True))
    return canonical


def capture_policy_digest(policy: Mapping[str, Any]) -> str:
    """Return ``sha256:<hex>`` over the canonical JSON of the canonicalized policy.

    Every capture record stores the digest of the policy that authorized it, so a reviewer can
    tell captures taken under one grant from captures taken after the rules changed.

    Args:
        policy: A policy document.

    Returns:
        The prefixed digest string.
    """
    return content_digest(canonical_capture_policy(policy))


def capture_policy_from_storage(mock_settings: Any) -> Dict[str, Any]:
    """Extract the stored capture policy from raw ``versions.mock_settings``.

    Accepts the raw JSONB value (dict, JSON text, or ``None``) and never raises; a malformed blob
    yields an empty mapping.

    Args:
        mock_settings: The raw ``versions.mock_settings`` value.

    Returns:
        The stored policy document, or ``{}`` when none is stored.
    """
    settings = parse_mock_settings(mock_settings)
    raw = settings.get(CAPTURE_SETTINGS_KEY)
    return dict(raw) if isinstance(raw, dict) else {}


def capture_policy_to_storage(policy: Mapping[str, Any]) -> Dict[str, Any]:
    """Canonicalize a validated policy into the shape stored under ``proxyCapture``."""
    return canonical_capture_policy(policy)


def authorization_block(
    *,
    authorized_by: str,
    now: datetime,
    ttl_hours: Optional[int] = None,
) -> Dict[str, str]:
    """Build the server-stamped ``authorization`` block for a capture grant.

    The caller never supplies these values: the API records the authenticated user and clamps the
    lifetime, so "who authorized this and until when" is a server fact rather than a client claim.

    Args:
        authorized_by: The authenticated user id granting capture.
        now: The moment of the grant (an aware datetime).
        ttl_hours: Requested lifetime; clamped to ``1..``:data:`MAX_AUTHORIZATION_HOURS`, and
            defaulted to :data:`DEFAULT_AUTHORIZATION_HOURS` when omitted.

    Returns:
        The ``authorization`` block, with UTC ISO 8601 (``Z``-suffixed) timestamps.
    """
    hours = DEFAULT_AUTHORIZATION_HOURS if ttl_hours is None else int(ttl_hours)
    hours = max(1, min(hours, MAX_AUTHORIZATION_HOURS))
    granted = now.astimezone(timezone.utc)
    return {
        "authorizedBy": authorized_by,
        "authorizedAt": _iso(granted),
        "expiresAt": _iso(granted + timedelta(hours=hours)),
    }


def _iso(moment: datetime) -> str:
    """Format an aware datetime as a ``Z``-suffixed UTC ISO 8601 string (seconds precision)."""
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def capture_authorization_state(policy: Mapping[str, Any], *, now: datetime) -> str:
    """Return why capture is (or is not) authorized right now.

    Three independent conditions all have to hold, and each has its own answer so the runtime can
    tell a developer precisely what to fix rather than "capture is off".

    Args:
        policy: The stored policy document (``{}`` when none).
        now: The current time (an aware datetime).

    Returns:
        ``"authorized"``, or one of ``"unconfigured"`` (no policy at all), ``"disabled"``
        (present but switched off), ``"no-upstreams"`` (nothing allowlisted), ``"unauthorized"``
        (no authorization block), or ``"expired"``.
    """
    if not policy:
        return "unconfigured"
    canonical = canonical_capture_policy(policy)
    if not canonical.get("enabled"):
        return "disabled"
    if not canonical.get("upstreams"):
        return "no-upstreams"
    authorization = canonical.get("authorization")
    if not isinstance(authorization, Mapping) or not authorization.get("authorizedBy"):
        return "unauthorized"
    expires = _parse_timestamp(authorization.get("expiresAt"))
    if expires is None:
        return "unauthorized"
    if expires <= now.astimezone(timezone.utc):
        return "expired"
    return "authorized"


# ==================================================================================================
# Upstream resolution
# ==================================================================================================


@dataclass(frozen=True)
class CaptureUpstream:
    """One resolved upstream fetch target.

    Attributes:
        url: The absolute URL to fetch, query string included.
        allowlist_entry: The canonical allowlist entry that authorized it.
        logged_url: The same target with its query string dropped — the form safe to store and
            log, since an upstream query routinely carries a token.
    """

    url: str
    allowlist_entry: str
    logged_url: str


def resolve_capture_upstream(
    policy: Mapping[str, Any],
    *,
    relative_path: str,
    query_string: str = "",
) -> Optional[CaptureUpstream]:
    """Resolve the upstream URL for one mock request, or ``None`` when nothing authorizes it.

    The candidate URL is the allowlist entry's own path joined with the request's spec-relative
    path, so an entry of ``https://api.example.com/v1`` turns ``GET /pets/7`` into
    ``https://api.example.com/v1/pets/7``.

    The joined path is then **normalized** — ``.``, ``..`` and duplicate separators resolved —
    *before* it is re-checked against the allowlist with
    :func:`app.mock_callbacks.match_destination`. Normalizing first is what closes the traversal
    hole: ``/pets/../../admin`` under an entry of ``…/v1/pets`` reads as a descendant while it
    still contains dot segments, and only becomes the escape it really is once resolved. Matching
    the resolved form means the URL that is actually fetched is the URL that was authorized.

    Args:
        policy: The stored capture policy.
        relative_path: The request path relative to ``/{tenant}/{project}/{version}``.
        query_string: The request's raw query string (no leading ``?``), preserved for the fetch
            and dropped from :attr:`CaptureUpstream.logged_url`.

    Returns:
        The resolved target, or ``None`` when no allowlist entry authorizes this path.
    """
    canonical = canonical_capture_policy(policy)
    upstreams: Sequence[str] = canonical.get("upstreams") or ()
    if not upstreams:
        return None

    suffix = relative_path if relative_path.startswith("/") else f"/{relative_path}"
    for entry in upstreams:
        parts = urlsplit(entry)
        base = parts.path.rstrip("/")
        candidate_path = _normalize_path(f"{base}{suffix}" if suffix != "/" else (base or "/"))
        candidate = urlunsplit((parts.scheme, parts.netloc, candidate_path, "", ""))
        matched = match_destination(candidate, [entry])
        if matched is None:
            continue
        target = candidate if not query_string else f"{candidate}?{query_string}"
        return CaptureUpstream(url=target, allowlist_entry=entry, logged_url=candidate)
    return None


def _normalize_path(path: str) -> str:
    """Resolve ``.``/``..`` and duplicate separators in an absolute URL path.

    :func:`posixpath.normpath` alone is not enough: it silently *clamps* a path that climbs above
    the root (``/a/../../b`` becomes ``/b``), which would turn an escape into an innocent-looking
    sibling. Climbing past the root is treated as a distinct answer here — ``/..`` — so the
    allowlist check that follows can never match it.

    Args:
        path: The joined absolute path.

    Returns:
        The normalized absolute path, or ``"/.."`` when it climbed above the root.
    """
    segments: List[str] = []
    for segment in path.split("/"):
        if not segment or segment == ".":
            continue
        if segment == "..":
            if not segments:
                return "/.."
            segments.pop()
            continue
        segments.append(segment)
    return "/" + "/".join(segments)


# ==================================================================================================
# Redaction
# ==================================================================================================


@dataclass(frozen=True)
class RedactionDecision:
    """One thing removed from a capture, and why.

    Attributes:
        pointer: RFC 6901 pointer to the removed location *within the capture record*
            (``/request/headers/authorization``, ``/response/body/customer/email``).
        rule: The rule family that fired — one of ``always-header``, ``always-query``,
            ``credential-header``, ``credential-query``, ``credential-field``, ``jwt-value``,
            ``policy-header``, ``policy-query``, ``policy-field``, ``pattern:<name>``,
            ``body-too-large``, ``body-not-textual``.
        reason: A sentence a reviewer can read without knowing the rule names.
    """

    pointer: str
    rule: str
    reason: str

    def as_dict(self) -> Dict[str, str]:
        """Return the JSON form stored in the capture record."""
        return {"pointer": self.pointer, "rule": self.rule, "reason": self.reason}


@dataclass(frozen=True)
class RedactionRules:
    """The effective redaction rules for one capture: always-on plus this policy's additions.

    Attributes:
        header_keys: Normalized header names to drop (always-on set already merged in).
        policy_header_keys: The subset the policy added, so a decision can name the right rule.
        query_keys: Normalized query parameter names to drop.
        policy_query_keys: The subset the policy added.
        field_names: Normalized body field names to drop at any depth.
        pointers: RFC 6901 pointers (policy entries starting with ``/``) to drop exactly.
        patterns: Selected value detectors by name.
    """

    header_keys: frozenset[str] = field(default_factory=frozenset)
    policy_header_keys: frozenset[str] = field(default_factory=frozenset)
    query_keys: frozenset[str] = field(default_factory=frozenset)
    policy_query_keys: frozenset[str] = field(default_factory=frozenset)
    field_names: frozenset[str] = field(default_factory=frozenset)
    pointers: frozenset[str] = field(default_factory=frozenset)
    patterns: Tuple[str, ...] = ()


def redaction_rules_from_policy(policy: Mapping[str, Any]) -> RedactionRules:
    """Build the effective :class:`RedactionRules` for a policy.

    The always-on credential rules are merged in unconditionally: a policy can add to them and
    can never subtract from them.

    Args:
        policy: The stored capture policy (``{}`` yields the always-on rules alone).

    Returns:
        The effective rules.
    """
    redaction = canonical_capture_policy(policy).get("redaction")
    block: Mapping[str, Any] = redaction if isinstance(redaction, Mapping) else {}

    policy_headers = frozenset(_normalize_name(name) for name in block.get("headers", ()))
    policy_queries = frozenset(_normalize_name(name) for name in block.get("queryParams", ()))

    field_names: List[str] = []
    pointers: List[str] = []
    for entry in block.get("bodyFields", ()):
        if entry.startswith("/"):
            pointers.append(entry)
        else:
            field_names.append(_normalize_name(entry))

    return RedactionRules(
        header_keys=_ALWAYS_REDACTED_HEADER_KEYS | policy_headers,
        policy_header_keys=policy_headers,
        query_keys=_ALWAYS_REDACTED_QUERY_KEYS | policy_queries,
        policy_query_keys=policy_queries,
        field_names=frozenset(name for name in field_names if name),
        pointers=frozenset(pointers),
        patterns=tuple(name for name in block.get("patterns", ()) if name in REDACTION_PATTERNS),
    )


def _matches_pattern(value: Any, patterns: Iterable[str]) -> Optional[str]:
    """Return the name of the first selected detector matching ``value``, if any."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    for name in patterns:
        matcher = REDACTION_PATTERNS.get(name)
        if matcher is not None and matcher.match(text):
            return name
    return None


def _is_jwt(value: Any) -> bool:
    """Whether a value is a compact JWT (a credential wherever it appears)."""
    return isinstance(value, str) and bool(_JWT_PATTERN.match(value.strip()))


def _redact_headers(
    headers: Mapping[str, str],
    *,
    rules: RedactionRules,
    base_pointer: str,
    decisions: List[RedactionDecision],
) -> Dict[str, str]:
    """Drop credential and policy-named headers, recording one decision per removal."""
    kept: Dict[str, str] = {}
    for name, value in headers.items():
        key = _normalize_name(str(name))
        pointer = f"{base_pointer}/{_escape_pointer_segment(str(name).lower())}"
        if key in rules.header_keys:
            policy_rule = key in rules.policy_header_keys and key not in _ALWAYS_REDACTED_HEADER_KEYS
            decisions.append(
                RedactionDecision(
                    pointer=pointer,
                    rule="policy-header" if policy_rule else "always-header",
                    reason=(
                        f"Header '{name}' is redacted by this version's capture policy."
                        if policy_rule
                        else f"Header '{name}' carries credentials and is never persisted."
                    ),
                )
            )
            continue
        if find_credential_fields({str(name): value}):
            # Catches the names the exact-on list cannot enumerate (``X-Tenant-Token``,
            # ``X-Signing-Key``) and values that are credentials whatever they hang off (a PEM
            # block, ``Bearer …``). Without it those headers would survive redaction only to be
            # caught by the final re-scan, which refuses the *whole* capture — a strictly worse
            # outcome than dropping the one header.
            decisions.append(
                RedactionDecision(
                    pointer=pointer,
                    rule="credential-header",
                    reason=f"Header '{name}' is credential-shaped and is never persisted.",
                )
            )
            continue
        if _is_jwt(value):
            decisions.append(
                RedactionDecision(
                    pointer=pointer,
                    rule="jwt-value",
                    reason=f"Header '{name}' held a JSON Web Token.",
                )
            )
            continue
        pattern = _matches_pattern(value, rules.patterns)
        if pattern is not None:
            decisions.append(
                RedactionDecision(
                    pointer=pointer,
                    rule=f"pattern:{pattern}",
                    reason=f"Header '{name}' matched the '{pattern}' sensitive-data detector.",
                )
            )
            continue
        kept[str(name).lower()] = str(value)
    return kept


def _redact_query(
    query_params: Sequence[Tuple[str, str]],
    *,
    rules: RedactionRules,
    base_pointer: str,
    decisions: List[RedactionDecision],
) -> List[Tuple[str, str]]:
    """Drop credential and policy-named query parameters, recording one decision per removal."""
    kept: List[Tuple[str, str]] = []
    for name, value in query_params:
        key = _normalize_name(name)
        pointer = f"{base_pointer}/{_escape_pointer_segment(name)}"
        if key in rules.query_keys:
            policy_rule = key in rules.policy_query_keys and key not in _ALWAYS_REDACTED_QUERY_KEYS
            decisions.append(
                RedactionDecision(
                    pointer=pointer,
                    rule="policy-query" if policy_rule else "always-query",
                    reason=(
                        f"Query parameter '{name}' is redacted by this version's capture policy."
                        if policy_rule
                        else f"Query parameter '{name}' commonly carries credentials and is never persisted."
                    ),
                )
            )
            continue
        if find_credential_fields({name: value}):
            decisions.append(
                RedactionDecision(
                    pointer=pointer,
                    rule="credential-query",
                    reason=f"Query parameter '{name}' is credential-shaped and is never persisted.",
                )
            )
            continue
        if _is_jwt(value):
            decisions.append(
                RedactionDecision(
                    pointer=pointer,
                    rule="jwt-value",
                    reason=f"Query parameter '{name}' held a JSON Web Token.",
                )
            )
            continue
        pattern = _matches_pattern(value, rules.patterns)
        if pattern is not None:
            decisions.append(
                RedactionDecision(
                    pointer=pointer,
                    rule=f"pattern:{pattern}",
                    reason=f"Query parameter '{name}' matched the '{pattern}' sensitive-data detector.",
                )
            )
            continue
        kept.append((name, value))
    return kept


def _redact_body_rules(
    value: Any,
    *,
    rules: RedactionRules,
    pointer: str,
    relative: str,
    decisions: List[RedactionDecision],
) -> Any:
    """Apply the policy field, pointer, JWT, and pattern rules to a parsed body, recursively.

    Two pointers are threaded through: ``pointer`` locates the value in the finished capture
    record (what a decision reports), while ``relative`` locates it *within the body* — the form a
    policy's ``bodyFields`` pointer is written against, so an author writes ``/customer/dob``
    rather than repeating ``/response/body`` in every rule.
    """
    if relative and relative in rules.pointers:
        decisions.append(
            RedactionDecision(
                pointer=pointer,
                rule="policy-field",
                reason=f"'{relative}' is redacted by this version's capture policy.",
            )
        )
        return _DROPPED

    if isinstance(value, Mapping):
        result: Dict[str, Any] = {}
        for raw_key, child in value.items():
            key = str(raw_key)
            segment = _escape_pointer_segment(key)
            child_pointer = f"{pointer}/{segment}"
            if _normalize_name(key) in rules.field_names:
                decisions.append(
                    RedactionDecision(
                        pointer=child_pointer,
                        rule="policy-field",
                        reason=f"Field '{key}' is redacted by this version's capture policy.",
                    )
                )
                continue
            cleaned = _redact_body_rules(
                child,
                rules=rules,
                pointer=child_pointer,
                relative=f"{relative}/{segment}",
                decisions=decisions,
            )
            if cleaned is not _DROPPED:
                result[key] = cleaned
        return result

    if isinstance(value, (list, tuple)):
        items: List[Any] = []
        for index, child in enumerate(value):
            cleaned = _redact_body_rules(
                child,
                rules=rules,
                pointer=f"{pointer}/{index}",
                relative=f"{relative}/{index}",
                decisions=decisions,
            )
            if cleaned is not _DROPPED:
                items.append(cleaned)
        return items

    if _is_jwt(value):
        decisions.append(
            RedactionDecision(pointer=pointer, rule="jwt-value", reason="Value was a JSON Web Token.")
        )
        return _DROPPED
    pattern = _matches_pattern(value, rules.patterns)
    if pattern is not None:
        decisions.append(
            RedactionDecision(
                pointer=pointer,
                rule=f"pattern:{pattern}",
                reason=f"Value matched the '{pattern}' sensitive-data detector.",
            )
        )
        return _DROPPED
    return value


class _Dropped:
    """Sentinel marking a value the rules removed (distinct from a legitimate ``None``)."""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<dropped>"


_DROPPED = _Dropped()


def _redact_body(
    body: Any,
    *,
    rules: RedactionRules,
    base_pointer: str,
    decisions: List[RedactionDecision],
) -> Any:
    """Redact one parsed JSON body: credential-shaped fields first, then the policy rules."""
    if body is None:
        return None
    cleaned, credential_pointers = redact_credentials(body)
    for suffix in credential_pointers:
        decisions.append(
            RedactionDecision(
                pointer=f"{base_pointer}{suffix}",
                rule="credential-field",
                reason="Field is credential-shaped and is never persisted.",
            )
        )
    result = _redact_body_rules(
        cleaned, rules=rules, pointer=base_pointer, relative="", decisions=decisions
    )
    return None if result is _DROPPED else result


@dataclass(frozen=True)
class RedactedExchange:
    """One request/response pair, reduced to what may be persisted.

    Attributes:
        request: ``{"method", "path", "query", "headers", "body", "mediaType"}``.
        response: ``{"status", "headers", "body", "mediaType"}``.
        decisions: Every removal made, in the order the rules fired.
    """

    request: Dict[str, Any]
    response: Dict[str, Any]
    decisions: Tuple[RedactionDecision, ...]

    @property
    def clean(self) -> bool:
        """Whether nothing at all had to be removed."""
        return not self.decisions

    def decisions_as_json(self) -> List[Dict[str, str]]:
        """Return the decision list in its stored JSON form."""
        return [decision.as_dict() for decision in self.decisions]


def _body_section(
    body: Any,
    media_type: Optional[str],
    *,
    textual: bool,
    oversize: bool,
    rules: RedactionRules,
    base_pointer: str,
    decisions: List[RedactionDecision],
) -> Tuple[Any, Optional[str]]:
    """Reduce one body to its stored form, recording a decision when it is dropped whole."""
    if oversize:
        decisions.append(
            RedactionDecision(
                pointer=f"{base_pointer}/body",
                rule="body-too-large",
                reason=f"Body exceeded the {MAX_CAPTURE_BODY_BYTES} byte capture limit and was not stored.",
            )
        )
        return None, media_type
    # The type check comes before the "no body" shortcut on purpose: a binary body decodes to
    # nothing, and returning early would drop it with no decision recorded — the one outcome
    # redaction must never produce. Callers pass ``textual=True`` when there is no body at all.
    if not textual:
        decisions.append(
            RedactionDecision(
                pointer=f"{base_pointer}/body",
                rule="body-not-textual",
                reason=(
                    f"Body media type {media_type or 'unknown'!r} is not JSON or text; "
                    "binary payloads are not stored."
                ),
            )
        )
        return None, media_type
    if body is None:
        return None, media_type
    return (
        _redact_body(body, rules=rules, base_pointer=f"{base_pointer}/body", decisions=decisions),
        media_type,
    )


def redact_exchange(
    *,
    policy: Mapping[str, Any],
    method: str,
    path: str,
    query_params: Sequence[Tuple[str, str]] = (),
    request_headers: Mapping[str, str] | None = None,
    request_body: Any = None,
    request_media_type: Optional[str] = None,
    request_body_textual: bool = True,
    request_body_oversize: bool = False,
    status: int,
    response_headers: Mapping[str, str] | None = None,
    response_body: Any = None,
    response_media_type: Optional[str] = None,
    response_body_textual: bool = True,
    response_body_oversize: bool = False,
) -> RedactedExchange:
    """Reduce one live exchange to the record that may be persisted.

    Every rule family in this module runs here, and every removal is recorded. The caller is
    expected to have already parsed textual bodies into JSON values (or to pass the raw text) and
    to say whether each body was textual and within :data:`MAX_CAPTURE_BODY_BYTES`; this function
    makes no I/O decisions of its own.

    Args:
        policy: The stored capture policy whose rules apply.
        method: The request method.
        path: The request path, relative to the mock's version prefix.
        query_params: Request query parameters as ordered ``(name, value)`` pairs.
        request_headers: Request headers as sent.
        request_body: The parsed request body (JSON value or text), or ``None``.
        request_media_type: The request's declared media type.
        request_body_textual: Whether the request body was JSON/text and decodable (binary is
            dropped with a recorded decision). Pass ``True`` when there is no body at all.
        request_body_oversize: Whether the request body exceeded the capture limit.
        status: The upstream response status.
        response_headers: Response headers as received.
        response_body: The parsed response body (JSON value or text), or ``None``.
        response_media_type: The response's declared media type.
        response_body_textual: Whether the response body was JSON/text and decodable.
        response_body_oversize: Whether the response body exceeded the capture limit.

    Returns:
        The :class:`RedactedExchange` — what may be stored, plus why anything is missing.
    """
    rules = redaction_rules_from_policy(policy)
    decisions: List[RedactionDecision] = []

    kept_query = _redact_query(
        list(query_params), rules=rules, base_pointer="/request/query", decisions=decisions
    )
    kept_request_headers = _redact_headers(
        dict(request_headers or {}), rules=rules, base_pointer="/request/headers", decisions=decisions
    )
    stored_request_body, request_type = _body_section(
        request_body,
        request_media_type,
        textual=request_body_textual,
        oversize=request_body_oversize,
        rules=rules,
        base_pointer="/request",
        decisions=decisions,
    )
    kept_response_headers = _redact_headers(
        dict(response_headers or {}), rules=rules, base_pointer="/response/headers", decisions=decisions
    )
    stored_response_body, response_type = _body_section(
        response_body,
        response_media_type,
        textual=response_body_textual,
        oversize=response_body_oversize,
        rules=rules,
        base_pointer="/response",
        decisions=decisions,
    )

    request: Dict[str, Any] = {
        "method": method.upper(),
        "path": path,
        "query": [{"name": name, "value": value} for name, value in kept_query],
        "headers": kept_request_headers,
        "body": stored_request_body,
    }
    if request_type:
        request["mediaType"] = request_type
    response: Dict[str, Any] = {
        "status": int(status),
        "headers": kept_response_headers,
        "body": stored_response_body,
    }
    if response_type:
        response["mediaType"] = response_type

    return RedactedExchange(request=request, response=response, decisions=tuple(decisions))


# ==================================================================================================
# Capture records
# ==================================================================================================


@dataclass(frozen=True)
class CaptureProvenance:
    """Where one captured exchange came from.

    Every field is a server fact, recorded at capture time and never editable afterwards, so a
    fixture built from captures can always answer "which system said this, under whose grant".

    Attributes:
        tenant: Tenant slug of the mock that recorded it.
        project: Project slug.
        version: Version label.
        upstream: The fetched URL with its query string dropped.
        allowlist_entry: The allowlist entry that authorized the fetch.
        policy_digest: Digest of the capture policy in force at the time.
        captured_at: ISO 8601 UTC instant of the capture.
        captured_by: The API key id that drove the capture, when known.
        operation_key: The spec operation the request matched (``"GET /pets/{petId}"``).
        path_template: The matched operation's path template.
    """

    tenant: str
    project: str
    version: str
    upstream: str
    allowlist_entry: str
    policy_digest: str
    captured_at: str
    captured_by: Optional[str] = None
    operation_key: Optional[str] = None
    path_template: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        """Return the JSON form stored in the capture record (absent fields omitted)."""
        block: Dict[str, Any] = {
            "tenant": self.tenant,
            "project": self.project,
            "version": self.version,
            "upstream": self.upstream,
            "allowlistEntry": self.allowlist_entry,
            "policyDigest": self.policy_digest,
            "capturedAt": self.captured_at,
        }
        if self.captured_by:
            block["capturedBy"] = self.captured_by
        if self.operation_key:
            block["operationKey"] = self.operation_key
        if self.path_template:
            block["pathTemplate"] = self.path_template
        return block


def build_capture_record(
    *,
    exchange: RedactedExchange,
    provenance: CaptureProvenance,
    validation_errors: Sequence[str] = (),
    validated: bool = True,
) -> Dict[str, Any]:
    """Assemble one ``apiome.mock.capture/v1`` document.

    Args:
        exchange: The redacted exchange.
        provenance: Where it came from.
        validation_errors: Schema validation errors for the captured response (empty when it
            matched the contract, or when validation did not run).
        validated: Whether response schema validation ran at all.

    Returns:
        The capture document, ready to persist and to review.
    """
    return {
        "captureFormat": CAPTURE_FORMAT,
        "captureFormatVersion": CAPTURE_FORMAT_VERSION,
        "provenance": provenance.as_dict(),
        "request": exchange.request,
        "response": exchange.response,
        "redaction": {
            "clean": exchange.clean,
            "count": len(exchange.decisions),
            "decisions": exchange.decisions_as_json(),
        },
        "validation": {
            "checked": bool(validated),
            "valid": bool(validated) and not validation_errors,
            "errors": list(validation_errors),
        },
    }


def capture_record_digest(record: Mapping[str, Any]) -> str:
    """Return ``sha256:<hex>`` over the canonical JSON of a capture record."""
    return content_digest(dict(record))


def residual_credential_pointers(record: Mapping[str, Any]) -> List[str]:
    """Re-scan a finished capture record for anything still credential-shaped.

    The last gate before persistence, and the reason a gap in the rules above fails closed: the
    caller refuses to store any record this flags. It is the same scan
    :func:`app.mock_bundle.verify_bundle` runs over a received bundle, pointed at a capture.

    Args:
        record: A capture document from :func:`build_capture_record`.

    Returns:
        Sorted RFC 6901 pointers of every surviving credential-shaped field (empty when clean).
        The ``redaction`` block is excluded: it *describes* removals and legitimately names
        ``/request/headers/authorization``.
    """
    scanned = {key: value for key, value in record.items() if key != "redaction"}
    return find_credential_fields(scanned)


# ==================================================================================================
# Review-before-publish conversion
# ==================================================================================================


def _collection_path_for(record: Mapping[str, Any]) -> Optional[str]:
    """Return the CRUD collection path a captured response seeds, or ``None``.

    Derived from the matched operation's path template, not from the concrete request path, so
    ``GET /pets/7`` and ``GET /pets/8`` seed the same ``/pets`` collection. A template whose last
    segment is a parameter names the item route of its parent collection; anything else is the
    collection itself. Templates with parameters anywhere but the final segment are declined —
    ``/tenants/{id}/pets`` has no single collection identity in a session store keyed by path.
    """
    provenance = record.get("provenance")
    if not isinstance(provenance, Mapping):
        return None
    template = provenance.get("pathTemplate")
    if not isinstance(template, str) or not template.startswith("/"):
        return None
    segments = [segment for segment in template.split("/") if segment]
    if not segments:
        return None
    if segments[-1].startswith("{") and segments[-1].endswith("}"):
        segments = segments[:-1]
    if not segments or any(segment.startswith("{") for segment in segments):
        return None
    return "/" + "/".join(segments)


def _fixture_data_name(record: Mapping[str, Any], used: Mapping[str, Any]) -> str:
    """Derive a unique, pattern-legal fixture data name for one captured response."""
    request = record.get("request") if isinstance(record.get("request"), Mapping) else {}
    method = str(request.get("method", "get")).lower()
    path = str(request.get("path", "/"))
    stem = re.sub(r"[^A-Za-z0-9]+", "-", path).strip("-") or "root"
    base = f"{method}-{stem}"[:56].strip("-") or "capture"
    if not PACK_NAME_PATTERN.match(base):
        base = f"c{base}"[:56]
    name = base
    suffix = 2
    while name in used:
        name = f"{base}-{suffix}"[:64]
        suffix += 1
    return name


def _seed_resources(body: Any) -> List[Dict[str, Any]]:
    """Return the seed resources a captured response body contributes, if any."""
    if isinstance(body, Mapping):
        return [dict(body)]
    if isinstance(body, list):
        return [dict(item) for item in body if isinstance(item, Mapping)]
    return []


def fixture_pack_from_captures(
    records: Sequence[Mapping[str, Any]],
    *,
    description: str = "",
    approved_by: str,
    approved_at: str,
) -> Tuple[Dict[str, Any], List[str]]:
    """Convert approved capture records into a fixture pack document.

    This is the "review-before-publish" step: nothing here happens automatically, and the caller
    is expected to pass only records an owner explicitly approved. Successful (2xx) JSON responses
    become session seed data where their operation identifies a collection, and named template
    fixture data otherwise. The resulting pack carries a ``provenance`` block naming every upstream
    it drew from and the total redactions applied, so the runtime can report the fixture's origin
    on every listing and reset.

    Args:
        records: The approved capture documents.
        description: Author-supplied description for the pack.
        approved_by: The user id approving publication.
        approved_at: ISO 8601 UTC instant of the approval.

    Returns:
        ``(pack, notes)`` — the pack document (in the shape
        :func:`app.mock_fixture_packs.validate_fixture_packs` accepts) and human-readable notes
        about captures that contributed nothing, so the API can tell the reviewer what was skipped
        rather than silently dropping it.
    """
    collections: Dict[str, List[Dict[str, Any]]] = {}
    data: Dict[str, Any] = {}
    notes: List[str] = []
    upstreams: List[str] = []
    redactions = 0
    used_ids: Dict[str, set[str]] = {}

    for index, record in enumerate(records):
        provenance = record.get("provenance") if isinstance(record.get("provenance"), Mapping) else {}
        # The pack lists the *allowlist entries* it drew from, not every captured URL: an entry
        # is the meaningful source, and a hundred-capture pack would otherwise blow past the
        # provenance upstream cap and fail its own validation.
        origin = provenance.get("allowlistEntry") or provenance.get("upstream")
        if isinstance(origin, str) and origin and origin not in upstreams:
            upstreams.append(origin)
        redaction = record.get("redaction")
        if isinstance(redaction, Mapping) and isinstance(redaction.get("count"), int):
            redactions += int(redaction["count"])

        response = record.get("response") if isinstance(record.get("response"), Mapping) else {}
        status = response.get("status")
        label = f"capture {index + 1}"
        if not isinstance(status, int) or not 200 <= status < 300:
            notes.append(f"{label}: skipped, response status {status} is not a success.")
            continue
        body = response.get("body")
        if body is None:
            notes.append(f"{label}: skipped, no response body survived redaction.")
            continue

        path = _collection_path_for(record)
        resources = _seed_resources(body) if path is not None else []
        if path is not None and resources:
            bucket = collections.setdefault(path, [])
            seen = used_ids.setdefault(path, set())
            for resource in resources:
                resource_id = collection_resource_id(resource, len(bucket))
                if resource_id in seen:
                    continue
                if len(bucket) >= MAX_RESOURCES_PER_COLLECTION:
                    notes.append(
                        f"{label}: collection {path} reached the "
                        f"{MAX_RESOURCES_PER_COLLECTION} resource limit; extra resources dropped."
                    )
                    break
                seen.add(resource_id)
                bucket.append(resource)
            continue

        name = _fixture_data_name(record, data)
        data[name] = body

    pack: Dict[str, Any] = {}
    if description.strip():
        pack["description"] = description.strip()
    if data:
        pack["data"] = data
    if collections:
        pack["collections"] = {path: collections[path] for path in sorted(collections)}
    pack["provenance"] = {
        "source": "capture",
        "capturedFrom": sorted(upstreams),
        "captures": len(records),
        "redactions": redactions,
        "approvedBy": approved_by,
        "approvedAt": approved_at,
    }

    if len(canonical_json(pack).encode("utf-8")) > MAX_PACK_BYTES:
        notes.append(
            f"The converted pack exceeds the {MAX_PACK_BYTES} byte limit; approve fewer captures "
            "or publish them as separate packs."
        )
    return pack, notes
