"""AGX-2.4 mock-target mode — route agent invocations to the SIM mock (#4536).

A tenant toolset (``apiome.agent_toolsets``, AGX-1.2 / #4530) carries a ``target``
column with two values. ``prod`` sends ``tools/call`` traffic to the real upstream
API; ``mock`` sends it to the hosted SIM mock runtime (``apiome-mock``, SIM EPIC-1 /
#4412) for the same published version. Mock mode is the **agent sandbox**: an agent
exercises the identical toolset — same tool names, same input schemas — with zero
upstream risk and **no upstream credentials configured at all**, which is what makes
first demos and CI agent tests safe to run.

What this module owns is one pure decision per invocation::

    (toolset target, version coordinates, config) -> InvocationRoute

:class:`InvocationRoute` tells the AGX-2.1 invocation proxy (#4533) three things: the
base URL to build the upstream request against, whether to inject credentials from
the AGX-2.2 upstream vault (#4534), and the label the AGX-3.3 invocation audit
(#4539) records so mock traffic stays distinguishable from production traffic in
analytics.

**Switching target never recompiles a toolset.** The route is resolved *per
invocation* from the toolset row; nothing in this module reads or produces a tool
definition. Flipping a toolset from ``mock`` to ``prod`` therefore changes only where
the *next* call goes — the compiled tools (AGX-1.1 / #4529) are identical either way.
That is the promotion path the ticket asks for: let the agent practise against the
mock, validate the behaviour, flip the target, keep the same toolset and the same
agent key.

**URL shape.** The SIM mock serves published versions at
``{mock_public_base_url}/{tenant}/{project}/{version}`` using *slug* coordinates (see
``apiome_mock.server``'s router). That is the same URL ``apiome-rest`` publishes to
the Control Panel as a version's ``mock_base_url``, so an agent and a human hit the
same mock; ``tests/test_mock_target_parity.py`` fails the build if the two ever
disagree.

**Safety.** Path segments are validated (non-empty, no separators, no traversal
markers, no control characters, length-capped) and percent-encoded before joining, so
a malformed slug cannot escape the version's mount point. Base URLs must be
``http``/``https`` with a host — the full SSRF/method/size rails are AGX-2.3 (#4535),
but a scheme check here costs nothing and keeps ``file://`` out of the proxy. An
unrecognised ``target`` value **raises** rather than falling back to a default:
silently sending sandbox traffic to production, or production traffic to a mock, are
both wrong in ways the calling agent cannot detect.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Mapping
from urllib.parse import quote, urlsplit

#: Header the SIM mock reads for private (unpublished draft) mocks — SIM-2.5 (#4446).
#: Public published mocks need no credential at all.
MOCK_API_KEY_HEADER = "X-Api-Key"

#: Longest accepted slug / version label, matching the platform's ``max_length=255``.
MAX_SEGMENT_LENGTH = 255

_ALLOWED_URL_SCHEMES = frozenset({"http", "https"})
_REJECTED_SEGMENTS = frozenset({".", ".."})


class InvocationTarget(str, Enum):
    """Where a toolset's ``tools/call`` traffic goes (``agent_toolsets.target``)."""

    PROD = "prod"
    MOCK = "mock"


#: Applied when a toolset row carries no target at all, matching the AGX-1.2 column
#: default. A *present but unrecognised* value is an error, not a default.
DEFAULT_TARGET = InvocationTarget.PROD


class InvocationTargetError(ValueError):
    """Base class for every routing failure raised by this module."""


class UnknownInvocationTargetError(InvocationTargetError):
    """The toolset's ``target`` value is not one of ``prod`` / ``mock``."""


class InvalidMockCoordinateError(InvocationTargetError):
    """A tenant / project / version path segment is unusable or unsafe."""


class InvalidBaseUrlError(InvocationTargetError):
    """A configured base URL is not an absolute ``http(s)`` URL with a host."""


class MissingRouteInputError(InvocationTargetError):
    """The inputs a target requires (upstream URL, or mock URL + coordinates) are absent."""


def parse_target(value: object) -> InvocationTarget:
    """Coerce a stored ``agent_toolsets.target`` value into an :class:`InvocationTarget`.

    :param value: Raw column value. ``None`` (or an empty/blank string) means "column
        default" and yields :data:`DEFAULT_TARGET`; an :class:`InvocationTarget` is
        returned unchanged; a string is matched case-insensitively after stripping.
    :returns: The resolved target.
    :raises UnknownInvocationTargetError: The value is present but is neither
        ``prod`` nor ``mock``. Never guess here — see the module docstring.
    """
    if isinstance(value, InvocationTarget):
        return value
    if value is None:
        return DEFAULT_TARGET
    if not isinstance(value, str):
        raise UnknownInvocationTargetError(
            f"toolset target must be a string, got {type(value).__name__}",
        )
    normalized = value.strip().lower()
    if not normalized:
        return DEFAULT_TARGET
    try:
        return InvocationTarget(normalized)
    except ValueError as exc:
        known = ", ".join(sorted(member.value for member in InvocationTarget))
        raise UnknownInvocationTargetError(
            f"unknown toolset target {value!r}; expected one of: {known}",
        ) from exc


def _validate_segment(name: str, value: object) -> str:
    """Return ``value`` if it is safe to use as one mock URL path segment.

    :param name: Field name used in the error message (e.g. ``"tenant_slug"``).
    :param value: Candidate segment, expected to be a non-empty ``str``.
    :returns: The segment, unchanged (encoding happens at join time).
    :raises InvalidMockCoordinateError: The segment is empty, over-long, contains a
        path separator, whitespace, or a control character, or is a traversal marker.
    """
    if not isinstance(value, str):
        raise InvalidMockCoordinateError(f"{name} must be a string, got {type(value).__name__}")
    if not value:
        raise InvalidMockCoordinateError(f"{name} must not be empty")
    if len(value) > MAX_SEGMENT_LENGTH:
        raise InvalidMockCoordinateError(f"{name} exceeds {MAX_SEGMENT_LENGTH} characters")
    if value in _REJECTED_SEGMENTS:
        raise InvalidMockCoordinateError(f"{name} must not be a path traversal marker ({value!r})")
    if "/" in value or "\\" in value:
        raise InvalidMockCoordinateError(f"{name} must not contain a path separator: {value!r}")
    for char in value:
        if char.isspace():
            raise InvalidMockCoordinateError(f"{name} must not contain whitespace: {value!r}")
        if ord(char) < 0x20 or ord(char) == 0x7F:
            raise InvalidMockCoordinateError(f"{name} must not contain control characters: {value!r}")
    return value


@dataclass(frozen=True)
class MockCoordinates:
    """The slug triple identifying one version's mount point on the SIM mock.

    These are the *same* coordinates the mock's router binds — tenant slug, project
    slug, and version label — not database UUIDs. Every field is validated on
    construction, so an instance is always safe to interpolate into a URL path.
    """

    tenant_slug: str
    project_slug: str
    version_label: str

    def __post_init__(self) -> None:
        """Validate all three segments so an instance can never carry an unsafe slug."""
        _validate_segment("tenant_slug", self.tenant_slug)
        _validate_segment("project_slug", self.project_slug)
        _validate_segment("version_label", self.version_label)

    @property
    def mount_path(self) -> str:
        """Percent-encoded ``/{tenant}/{project}/{version}`` path for this version."""
        segments = (self.tenant_slug, self.project_slug, self.version_label)
        return "".join(f"/{quote(segment, safe='')}" for segment in segments)


def normalize_base_url(name: str, value: object) -> str:
    """Return ``value`` as an absolute ``http(s)`` base URL with no trailing slash.

    :param name: Field name used in the error message.
    :param value: Candidate URL.
    :returns: The URL with any trailing slashes removed.
    :raises InvalidBaseUrlError: The value is not a string, is blank, uses a scheme
        other than ``http``/``https``, has no host, or carries a query/fragment.
    """
    if not isinstance(value, str):
        raise InvalidBaseUrlError(f"{name} must be a string, got {type(value).__name__}")
    candidate = value.strip()
    if not candidate:
        raise InvalidBaseUrlError(f"{name} must not be empty")
    parts = urlsplit(candidate)
    if parts.scheme.lower() not in _ALLOWED_URL_SCHEMES:
        raise InvalidBaseUrlError(
            f"{name} must use http or https, got {parts.scheme or '(none)'!r}",
        )
    if not parts.netloc:
        raise InvalidBaseUrlError(f"{name} must include a host: {value!r}")
    # A query or fragment cannot survive having a path appended to it, so reject it here
    # rather than emit a URL whose path lands inside the query string.
    if parts.query or parts.fragment:
        raise InvalidBaseUrlError(f"{name} must not carry a query string or fragment: {value!r}")
    return candidate.rstrip("/")


def build_mock_base_url(mock_public_base_url: str, coordinates: MockCoordinates) -> str:
    """Build the SIM mock base URL an agent's requests are issued against.

    :param mock_public_base_url: Public root of the hosted mock runtime, e.g.
        ``https://mock.apiome.dev`` (``APIOME_MCP_MOCK_PUBLIC_BASE_URL``). A trailing
        slash is tolerated; a path prefix is preserved.
    :param coordinates: The version's slug triple.
    :returns: ``{root}/{tenant}/{project}/{version}`` — the mount point the AGX-2.1
        proxy appends spec paths to, exactly as ``apiome-rest`` publishes it.
    :raises InvalidBaseUrlError: ``mock_public_base_url`` is not an absolute http(s) URL.
    """
    return normalize_base_url("mock_public_base_url", mock_public_base_url) + coordinates.mount_path


@dataclass(frozen=True)
class InvocationRoute:
    """The resolved destination for one ``tools/call``, consumed by the AGX-2.1 proxy."""

    target: InvocationTarget
    base_url: str
    inject_upstream_credentials: bool
    extra_headers: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Freeze ``extra_headers`` so a caller cannot mutate a resolved route."""
        object.__setattr__(self, "extra_headers", MappingProxyType(dict(self.extra_headers)))

    @property
    def is_mock(self) -> bool:
        """Whether this call is sandboxed against the SIM mock."""
        return self.target is InvocationTarget.MOCK

    @property
    def audit_target(self) -> str:
        """Value the AGX-3.3 invocation audit stores so mock traffic is filterable."""
        return self.target.value


def resolve_route(
    *,
    target: object,
    upstream_base_url: str | None = None,
    mock_public_base_url: str | None = None,
    coordinates: MockCoordinates | None = None,
    mock_api_key: str | None = None,
) -> InvocationRoute:
    """Resolve where one ``tools/call`` goes, from the toolset's stored target.

    This is a pure function: same inputs, same route, no I/O and no cached state, so
    a target flipped in the database takes effect on the very next call.

    :param target: Raw ``agent_toolsets.target`` value (see :func:`parse_target`).
    :param upstream_base_url: Production API root from the spec's ``servers[]``.
        Required for ``prod``; **ignored entirely** for ``mock`` so a sandbox toolset
        works with no upstream — and no upstream credentials — configured at all.
    :param mock_public_base_url: Public root of the hosted mock runtime. Required for
        ``mock``, ignored for ``prod``.
    :param coordinates: The version's slug triple. Required for ``mock``, ignored for
        ``prod``.
    :param mock_api_key: Optional tenant API key for a *private* draft mock (SIM-2.5).
        Sent as :data:`MOCK_API_KEY_HEADER`; public published mocks need none. This is
        mock-runtime auth, never an upstream credential.
    :returns: The :class:`InvocationRoute` for this call.
    :raises UnknownInvocationTargetError: ``target`` is present but unrecognised.
    :raises MissingRouteInputError: The chosen target's required inputs are absent.
    :raises InvalidBaseUrlError: A supplied base URL is not an absolute http(s) URL.
    """
    resolved = parse_target(target)

    if resolved is InvocationTarget.MOCK:
        if mock_public_base_url is None:
            raise MissingRouteInputError(
                "target 'mock' requires mock_public_base_url (APIOME_MCP_MOCK_PUBLIC_BASE_URL)",
            )
        if coordinates is None:
            raise MissingRouteInputError(
                "target 'mock' requires coordinates (tenant/project/version slugs)",
            )
        headers = {MOCK_API_KEY_HEADER: mock_api_key} if mock_api_key else {}
        return InvocationRoute(
            target=resolved,
            base_url=build_mock_base_url(mock_public_base_url, coordinates),
            # The vault is not consulted in mock mode: the sandbox must run with no
            # upstream credentials stored for the toolset at all (AGX-2.4 criterion).
            inject_upstream_credentials=False,
            extra_headers=headers,
        )

    if upstream_base_url is None:
        raise MissingRouteInputError("target 'prod' requires upstream_base_url from the spec servers")
    return InvocationRoute(
        target=resolved,
        base_url=normalize_base_url("upstream_base_url", upstream_base_url),
        inject_upstream_credentials=True,
        extra_headers={},
    )


__all__ = [
    "DEFAULT_TARGET",
    "MAX_SEGMENT_LENGTH",
    "MOCK_API_KEY_HEADER",
    "InvalidBaseUrlError",
    "InvalidMockCoordinateError",
    "InvocationRoute",
    "InvocationTarget",
    "InvocationTargetError",
    "MissingRouteInputError",
    "MockCoordinates",
    "UnknownInvocationTargetError",
    "build_mock_base_url",
    "normalize_base_url",
    "parse_target",
    "resolve_route",
]
