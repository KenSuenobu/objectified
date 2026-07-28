"""The verification-target contract — ECA-1.2 (#4730).

A compiled contract suite (ECA-1.1) describes requests *relative* to nothing: paths, methods,
bodies, expected outcomes. It deliberately carries no URL and no credential. This module owns the
other half — **where** a suite is executed and **how** the runner is allowed to behave while it
does — as a pure, database-free contract:

* :class:`VerificationTargetInput` / :class:`VerificationTargetPatch` — what a caller may define;
* :class:`TargetAuthReference` — a *pointer* to a credential, never the credential;
* :class:`VerificationPolicy` — timeouts, concurrency, retries, and what a failure does to a gate;
* :class:`VerificationTargetRecord` — a stored target as everyone reads it;
* :class:`ResolvedTarget` — what a runner is handed when it selects a target for a run.

Three invariants hold this module together, and each is enforced here *and* by a CHECK constraint
in apiome-db V211, so neither layer is the only thing standing between a mistake and the database:

**A target never holds a secret.** ``auth.kind`` says where the credential lives — ``env`` (a
variable name the runner reads from its own environment) or ``stored`` (a row id in the existing
encrypted credential vault) — and the reference is shape-validated so a pasted token cannot
masquerade as one. An env reference must match ``^[A-Z_][A-Z0-9_]*$``; a bearer token, a base64
blob, and a JWT all fail it. A stored reference must be a UUID.

**A target cannot point inward by accident.** :func:`validate_base_url` runs the URL through
:mod:`app.ssrf_guard`: http/https only, no ``user:pass@`` authority, and — for the default
``public`` network class — every resolved address must be globally routable. An internal target is
still reachable, but only by declaring ``network_class = "private"``, which V211 refuses to store
without an approver and a stated reason.

**Every refusal has a stable code.** Errors are :class:`TargetValidationError`, each carrying a
machine-readable ``code`` from the module's taxonomy, so a CLI, a UI, and an audit row can all
branch on the same string instead of parsing prose.

Nothing in this module reads or writes the database; :mod:`app.verification_target_store` does that,
and :mod:`app.verification_target_routes` exposes it.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .ssrf_guard import SSRFError, validate_host, validate_url_policy

__all__ = [
    "AUTH_KINDS",
    "CODE_AUTH_INVALID",
    "CODE_DISABLED",
    "CODE_NOT_FOUND",
    "CODE_POLICY_TLS_REQUIRED",
    "CODE_PRIVATE_NOT_APPROVED",
    "CODE_SLUG_INVALID",
    "CODE_SLUG_TAKEN",
    "CODE_URL_CREDENTIALS",
    "CODE_URL_MALFORMED",
    "CODE_URL_PRIVATE_NETWORK",
    "CODE_URL_SCHEME",
    "CODE_URL_UNRESOLVABLE",
    "AUTH_KIND_ENV",
    "AUTH_KIND_NONE",
    "AUTH_KIND_STORED",
    "AUTH_SCHEMES",
    "AUTH_SCHEME_BASIC",
    "AUTH_SCHEME_BEARER",
    "AUTH_SCHEME_HEADER",
    "ENVIRONMENTS",
    "FAILURE_ACTIONS",
    "FAILURE_ACTION_BLOCK",
    "FAILURE_ACTION_WARN",
    "NETWORK_CLASSES",
    "NETWORK_CLASS_PRIVATE",
    "NETWORK_CLASS_PUBLIC",
    "ResolvedTarget",
    "TargetAuthReference",
    "TargetValidationError",
    "VerificationPolicy",
    "VerificationTargetInput",
    "VerificationTargetPatch",
    "VerificationTargetRecord",
    "auth_reference_from_row",
    "normalize_base_url",
    "policy_violations",
    "record_from_row",
    "resolve_target_record",
    "target_identity",
    "validate_base_url",
    "validate_slug",
]

# ---------------------------------------------------------------------------------------------
# Vocabularies (mirror the V211 CHECK constraints)
# ---------------------------------------------------------------------------------------------

ENVIRONMENT_MOCK = "mock"
ENVIRONMENT_DEVELOPMENT = "development"
ENVIRONMENT_TEST = "test"
ENVIRONMENT_STAGING = "staging"
ENVIRONMENT_PRODUCTION = "production"

#: Every environment class a target may declare, ordered from least to most consequential.
ENVIRONMENTS = (
    ENVIRONMENT_MOCK,
    ENVIRONMENT_DEVELOPMENT,
    ENVIRONMENT_TEST,
    ENVIRONMENT_STAGING,
    ENVIRONMENT_PRODUCTION,
)

NETWORK_CLASS_PUBLIC = "public"
NETWORK_CLASS_PRIVATE = "private"

#: ``public`` must resolve to a globally routable address; ``private`` is an approved exception.
NETWORK_CLASSES = (NETWORK_CLASS_PUBLIC, NETWORK_CLASS_PRIVATE)

AUTH_KIND_NONE = "none"
AUTH_KIND_ENV = "env"
AUTH_KIND_STORED = "stored"

#: Where a credential lives. The target holds this and the reference; never the value.
AUTH_KINDS = (AUTH_KIND_NONE, AUTH_KIND_ENV, AUTH_KIND_STORED)

AUTH_SCHEME_BEARER = "bearer"
AUTH_SCHEME_HEADER = "header"
AUTH_SCHEME_BASIC = "basic"

#: How the runner presents the resolved secret. A shape, not a secret.
AUTH_SCHEMES = (AUTH_SCHEME_BEARER, AUTH_SCHEME_HEADER, AUTH_SCHEME_BASIC)

FAILURE_ACTION_BLOCK = "block"
FAILURE_ACTION_WARN = "warn"

#: What a failing run does to a gate. ``block`` is the default: a gate that warns by default is
#: not a gate.
FAILURE_ACTIONS = (FAILURE_ACTION_BLOCK, FAILURE_ACTION_WARN)

# ---------------------------------------------------------------------------------------------
# Error taxonomy — stable codes a CLI, a UI, and an audit row can all branch on.
# ---------------------------------------------------------------------------------------------

#: The URL could not be parsed at all.
CODE_URL_MALFORMED = "target-url-malformed"
#: A scheme other than http/https (``file:``, ``data:``, …).
CODE_URL_SCHEME = "target-url-scheme"
#: The authority embedded ``user:pass@`` — a credential in a target record.
CODE_URL_CREDENTIALS = "target-url-credentials"
#: A ``public`` target that resolves to a private, loopback, link-local, or otherwise
#: non-routable address. The SSRF refusal.
CODE_URL_PRIVATE_NETWORK = "target-url-private-network"
#: DNS could not resolve the host, so its address class is unknown — treated as unsafe.
CODE_URL_UNRESOLVABLE = "target-url-unresolvable"
#: A private-network target with no approver / no stated reason.
CODE_PRIVATE_NOT_APPROVED = "target-private-not-approved"
#: The credential reference is malformed for its kind (or would corrupt a header).
CODE_AUTH_INVALID = "target-auth-invalid"
#: TLS verification was disabled on a target that is not an approved private one.
CODE_POLICY_TLS_REQUIRED = "target-policy-tls-required"
#: The slug is not a usable handle.
CODE_SLUG_INVALID = "target-slug-invalid"
#: A resolve named a target that does not exist (or is not visible to this tenant).
CODE_NOT_FOUND = "target-not-found"
#: A resolve named a target that exists but is disabled.
CODE_DISABLED = "target-disabled"
#: A slug already belongs to a live target in this tenant.
CODE_SLUG_TAKEN = "target-slug-taken"

# Lowercase kebab, 1..128 chars: survives a shell argument, a YAML key, and a URL path segment.
_SLUG_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?$")
# POSIX-ish environment variable name. Deliberately narrow: no token, JWT, or base64 blob matches.
_ENV_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# RFC 9110 §5.1 field-name token grammar (the same one app.mcp_auth enforces), so a stored header
# name can never split a request.
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")


class TargetValidationError(ValueError):
    """A target definition or selection was refused, with a stable machine code.

    Subclasses ``ValueError`` so a call site that already maps ``ValueError`` onto a 4xx keeps
    working; ``code`` is what a CLI, the UI, and the audit ledger branch on.

    Attributes:
        code: One of the module's ``CODE_*`` constants.
    """

    def __init__(self, code: str, message: str) -> None:
        """Build the error.

        Args:
            code: Stable taxonomy code.
            message: Human-readable, secret-free explanation.
        """
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------------------------
# Credential reference
# ---------------------------------------------------------------------------------------------


class TargetAuthReference(BaseModel):
    """How a runner obtains the credential for a target — a pointer, never the secret.

    ``kind`` selects the mechanism and ``ref`` names the credential within it:

    * ``none``   — an anonymous target. Every other field must be absent.
    * ``env``    — ``ref`` is an **environment variable name** the runner reads from its own
      environment (``APIOME_STAGING_TOKEN``). The platform stores the name and never sees the
      value, which is what makes a self-hosted CI run work without handing the platform a secret.
    * ``stored`` — ``ref`` is the **id** of a row in the encrypted credential vault
      (``apiome.mcp_endpoint_credentials``). The ciphertext and its key version stay there.

    ``scheme`` says how the resolved value is presented (``Authorization: Bearer …``, a named
    header, or HTTP Basic) and ``header_name`` names the header for the ``header`` scheme. Both
    are shapes rather than secrets.
    """

    model_config = ConfigDict(extra="forbid")

    kind: str = Field(
        default=AUTH_KIND_NONE,
        description="Where the credential lives: `none`, `env`, or `stored`.",
    )
    scheme: Optional[str] = Field(
        default=None,
        description="How the resolved secret is presented: `bearer`, `header`, or `basic`.",
    )
    ref: Optional[str] = Field(
        default=None,
        description=(
            "The reference itself: an environment-variable NAME for `env`, a credential-vault "
            "UUID for `stored`. Never a secret value — a token cannot satisfy either shape."
        ),
    )
    header_name: Optional[str] = Field(
        default=None,
        description="Header field-name for the `header` scheme (RFC 9110 token grammar).",
    )

    @field_validator("kind")
    @classmethod
    def _known_kind(cls, value: str) -> str:
        """Reject a reference kind outside the closed vocabulary."""
        if value not in AUTH_KINDS:
            raise ValueError(f"auth.kind must be one of {', '.join(AUTH_KINDS)}")
        return value

    @field_validator("scheme")
    @classmethod
    def _known_scheme(cls, value: Optional[str]) -> Optional[str]:
        """Reject a presentation scheme outside the closed vocabulary."""
        if value is not None and value not in AUTH_SCHEMES:
            raise ValueError(f"auth.scheme must be one of {', '.join(AUTH_SCHEMES)}")
        return value

    @model_validator(mode="after")
    def _coherent(self) -> "TargetAuthReference":
        """Enforce the per-kind shape rules that keep a secret out of ``ref``.

        Mirrors the V211 CHECK constraints exactly: ``none`` carries nothing, anything else needs
        a scheme, an ``env`` ref is a variable name, a ``stored`` ref is a UUID, and only the
        ``header`` scheme carries a (token-grammar) header name.

        Returns:
            ``self``, unchanged, when every rule holds.

        Raises:
            ValueError: with a secret-free message naming the rule that failed.
        """
        if self.kind == AUTH_KIND_NONE:
            if self.scheme or self.ref or self.header_name:
                raise ValueError(
                    "auth.kind 'none' takes no scheme, ref, or header_name; drop them or "
                    "choose a credential reference kind"
                )
            return self

        if not self.scheme:
            raise ValueError("auth.scheme is required whenever a credential is referenced")
        if not self.ref:
            raise ValueError("auth.ref is required whenever a credential is referenced")

        if self.kind == AUTH_KIND_ENV and not _ENV_NAME_RE.match(self.ref):
            raise ValueError(
                "auth.ref must be an environment variable NAME (^[A-Z_][A-Z0-9_]*$) — this "
                "field holds a reference to a secret, never the secret itself"
            )
        if self.kind == AUTH_KIND_STORED and not _UUID_RE.match(self.ref):
            raise ValueError(
                "auth.ref must be the UUID of a stored credential — this field holds a "
                "reference to a secret, never the secret itself"
            )

        if self.scheme == AUTH_SCHEME_HEADER:
            if not self.header_name:
                raise ValueError("auth.header_name is required for the 'header' scheme")
            if not _HEADER_NAME_RE.match(self.header_name):
                raise ValueError(
                    "auth.header_name must be an RFC 9110 token (letters, digits, and "
                    "!#$%&'*+-.^_`|~)"
                )
        elif self.header_name:
            raise ValueError("auth.header_name is only meaningful for the 'header' scheme")
        return self


def auth_reference_from_row(row: Mapping[str, Any]) -> TargetAuthReference:
    """Rebuild a :class:`TargetAuthReference` from a ``verification_target`` row.

    Args:
        row: The stored row (``auth_kind``, ``auth_scheme``, ``auth_ref``, ``auth_header_name``).

    Returns:
        The reference. A row with no ``auth_kind`` reads as ``none``, which is what an
        unauthenticated target is.
    """
    return TargetAuthReference(
        kind=str(row.get("auth_kind") or AUTH_KIND_NONE),
        scheme=row.get("auth_scheme"),
        ref=row.get("auth_ref"),
        header_name=row.get("auth_header_name"),
    )


# ---------------------------------------------------------------------------------------------
# Execution / failure policy
# ---------------------------------------------------------------------------------------------


class VerificationPolicy(BaseModel):
    """How a runner is allowed to behave against this target, and what a failure means.

    Every bound is deliberate rather than advisory: a target is a *permission* to send traffic to
    someone's system, so the registry — not the runner — decides the ceiling on concurrency, the
    per-request timeout, and whether mutating methods may be exercised at all.

    The defaults are the safe reading of "verify a contract": four concurrent requests, a 30-second
    timeout, no retries, read-only methods, no redirect following, TLS verified, and a failure that
    blocks the gate.
    """

    model_config = ConfigDict(extra="forbid")

    request_timeout_seconds: int = Field(
        default=30, ge=1, le=300, description="Per-request timeout, in seconds."
    )
    max_concurrency: int = Field(
        default=4, ge=1, le=32, description="Maximum concurrent in-flight requests."
    )
    retry_attempts: int = Field(
        default=0,
        ge=0,
        le=5,
        description=(
            "Retries per case for *transport* failures only. A contract failure is never "
            "retried — that would let a flaky pass mask a real incompatibility (ECA-2.1)."
        ),
    )
    retry_backoff_ms: int = Field(
        default=250, ge=0, le=60000, description="Backoff between retries, in milliseconds."
    )
    allow_mutating_methods: bool = Field(
        default=False,
        description=(
            "Whether POST/PUT/PATCH/DELETE cases may be executed. Off by default: a contract "
            "run against a live system should not write to it unless someone said so."
        ),
    )
    follow_redirects: bool = Field(
        default=False,
        description=(
            "Whether the runner follows 3xx responses. Off by default, because a redirect "
            "silently changes which host answered a contract case."
        ),
    )
    verify_tls: bool = Field(
        default=True,
        description=(
            "Whether TLS certificates are verified. Only an approved private-network target "
            "may turn this off (a self-signed internal box)."
        ),
    )
    failure_action: str = Field(
        default=FAILURE_ACTION_BLOCK,
        description="What a failing run does to a gate: `block` or `warn`.",
    )
    max_allowed_failures: int = Field(
        default=0,
        ge=0,
        description=(
            "Case failures tolerated before the run is considered failed. Zero — a contract is "
            "not partially binding."
        ),
    )

    @field_validator("failure_action")
    @classmethod
    def _known_failure_action(cls, value: str) -> str:
        """Reject a gate action outside the closed vocabulary."""
        if value not in FAILURE_ACTIONS:
            raise ValueError(f"policy.failure_action must be one of {', '.join(FAILURE_ACTIONS)}")
        return value


def _policy_from_json(value: Any) -> VerificationPolicy:
    """Rebuild a policy from a stored JSONB value, tolerating an older/looser record.

    A stored policy that predates a field, or carries one that has since been removed, must still
    read — a registry entry is configuration, not evidence, and refusing to load it would strand a
    tenant's target. Unknown keys are dropped and missing ones take their defaults.

    Args:
        value: The ``policy`` column (dict, or anything else for a legacy/empty row).

    Returns:
        The policy, defaults filled in.
    """
    if not isinstance(value, Mapping):
        return VerificationPolicy()
    known = {k: v for k, v in value.items() if k in VerificationPolicy.model_fields}
    try:
        return VerificationPolicy(**known)
    except ValueError:
        # A stored value outside the current bounds (a lowered ceiling, say) still has to load;
        # falling back to defaults keeps the target usable and visibly conservative.
        return VerificationPolicy()


# ---------------------------------------------------------------------------------------------
# URL validation
# ---------------------------------------------------------------------------------------------


def normalize_base_url(base_url: str) -> str:
    """Trim a base URL to the canonical form paths are joined onto.

    Whitespace is stripped and trailing slashes are removed, so ``https://api.example.com/v1/``
    and ``https://api.example.com/v1`` are the same target and a compiled case's ``/pets`` joins
    onto either identically.

    Args:
        base_url: The URL as supplied.

    Returns:
        The normalized URL (never with a trailing ``/``, unless it is the whole path).
    """
    trimmed = (base_url or "").strip()
    while len(trimmed) > 1 and trimmed.endswith("/"):
        trimmed = trimmed[:-1]
    return trimmed


def validate_base_url(
    base_url: str,
    network_class: str = NETWORK_CLASS_PUBLIC,
    *,
    resolve: bool = True,
) -> str:
    """Vet a target URL against the SSRF policy and return its normalized form.

    The scheme and credential rules always apply — no target may be ``file:``, ``data:``, or
    ``https://user:pass@host`` regardless of network class. The *address* rule applies to the
    default ``public`` class: the host is resolved and every address it answers with must be
    globally routable, which is what stops a target from being pointed at ``169.254.169.254``,
    ``localhost``, or an RFC1918 range.

    A ``private`` target skips the address check — that is the entire point of declaring one — and
    V211 refuses to store such a target without an approver and a reason, so the exception is
    always attributable.

    Args:
        base_url: The URL to vet.
        network_class: ``public`` (default) or ``private``.
        resolve: Set ``False`` to run only the DNS-free shape checks. Used when re-validating a
            stored target in an environment where a resolution failure should not hide the
            definition (a list read); a *resolve* always uses the full check.

    Returns:
        The normalized URL.

    Raises:
        TargetValidationError: with the code naming which rule failed.
    """
    normalized = normalize_base_url(base_url)
    if not normalized:
        raise TargetValidationError(CODE_URL_MALFORMED, "base_url is required")

    try:
        host = validate_url_policy(normalized)
    except SSRFError as exc:
        message = str(exc)
        if "scheme" in message:
            code = CODE_URL_SCHEME
        elif "credentials" in message:
            code = CODE_URL_CREDENTIALS
        else:
            code = CODE_URL_MALFORMED
        raise TargetValidationError(code, message) from exc

    if not resolve or network_class == NETWORK_CLASS_PRIVATE:
        return normalized

    try:
        validate_host(host)
    except SSRFError as exc:
        message = str(exc)
        code = CODE_URL_UNRESOLVABLE if "could not resolve" in message else CODE_URL_PRIVATE_NETWORK
        raise TargetValidationError(
            code,
            (
                f"{message}. A target that must reach an internal address has to declare "
                "network_class 'private', which requires an approval reason."
            ),
        ) from exc
    return normalized


def validate_slug(slug: str) -> str:
    """Return ``slug`` when it is a usable handle, else raise.

    Args:
        slug: The proposed handle.

    Returns:
        The slug, unchanged.

    Raises:
        TargetValidationError: ``CODE_SLUG_INVALID`` when the shape is unusable.
    """
    candidate = (slug or "").strip()
    if not _SLUG_RE.match(candidate):
        raise TargetValidationError(
            CODE_SLUG_INVALID,
            "slug must be 1-128 lowercase letters, digits, or hyphens, starting and ending "
            "with a letter or digit (e.g. 'staging', 'eu-prod')",
        )
    return candidate


# ---------------------------------------------------------------------------------------------
# Definition models
# ---------------------------------------------------------------------------------------------


class VerificationTargetInput(BaseModel):
    """A complete target definition, as a caller supplies it on create."""

    model_config = ConfigDict(extra="forbid")

    slug: str = Field(
        description="Stable handle used from the CLI and CI (`--target staging`).",
        max_length=128,
    )
    name: str = Field(description="Human-readable display name.", min_length=1, max_length=200)
    description: Optional[str] = Field(
        default=None, description="Optional note about what this target is.", max_length=2000
    )
    environment: str = Field(
        default=ENVIRONMENT_STAGING,
        description="`mock`, `development`, `test`, `staging`, or `production`.",
    )
    base_url: str = Field(description="Base URL the suite's relative paths are joined onto.")
    network_class: str = Field(
        default=NETWORK_CLASS_PUBLIC,
        description=(
            "`public` (must resolve to a globally routable address) or `private` (an internal "
            "target, which requires `approval_reason`)."
        ),
    )
    approval_reason: Optional[str] = Field(
        default=None,
        description="Why a private-network target is justified. Required when `network_class` "
        "is `private`; the approver is the authenticated caller.",
        max_length=2000,
    )
    auth: TargetAuthReference = Field(
        default_factory=TargetAuthReference,
        description="The credential reference — never a credential.",
    )
    policy: VerificationPolicy = Field(
        default_factory=VerificationPolicy, description="Execution and failure policy."
    )
    enabled: bool = Field(
        default=True, description="A disabled target stays defined but cannot be resolved."
    )

    @field_validator("environment")
    @classmethod
    def _known_environment(cls, value: str) -> str:
        """Reject an environment outside the closed vocabulary."""
        if value not in ENVIRONMENTS:
            raise ValueError(f"environment must be one of {', '.join(ENVIRONMENTS)}")
        return value

    @field_validator("network_class")
    @classmethod
    def _known_network_class(cls, value: str) -> str:
        """Reject a network class outside the closed vocabulary."""
        if value not in NETWORK_CLASSES:
            raise ValueError(f"network_class must be one of {', '.join(NETWORK_CLASSES)}")
        return value


class VerificationTargetPatch(BaseModel):
    """A partial update. Every field is optional; omitted fields are left as they are.

    ``auth`` and ``policy`` are replaced wholesale when present, because a half-applied credential
    reference (a new ``ref`` against an old ``kind``) is exactly the kind of state that stores a
    secret in the wrong column.
    """

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=2000)
    environment: Optional[str] = None
    base_url: Optional[str] = None
    network_class: Optional[str] = None
    approval_reason: Optional[str] = Field(default=None, max_length=2000)
    auth: Optional[TargetAuthReference] = None
    policy: Optional[VerificationPolicy] = None
    enabled: Optional[bool] = None

    @field_validator("environment")
    @classmethod
    def _known_environment(cls, value: Optional[str]) -> Optional[str]:
        """Reject an environment outside the closed vocabulary."""
        if value is not None and value not in ENVIRONMENTS:
            raise ValueError(f"environment must be one of {', '.join(ENVIRONMENTS)}")
        return value

    @field_validator("network_class")
    @classmethod
    def _known_network_class(cls, value: Optional[str]) -> Optional[str]:
        """Reject a network class outside the closed vocabulary."""
        if value is not None and value not in NETWORK_CLASSES:
            raise ValueError(f"network_class must be one of {', '.join(NETWORK_CLASSES)}")
        return value

    def has_changes(self) -> bool:
        """True when the patch actually sets something."""
        return bool(self.model_dump(exclude_unset=True))


class VerificationTargetRecord(BaseModel):
    """A stored target, as every reader sees it.

    There is no redacted variant of this model because there is nothing to redact: the schema
    cannot hold credential material, so the full record is always safe to return.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Target id — the identity an evidence row records.")
    tenant_id: str = Field(description="Tenant that owns the target.")
    slug: str = Field(description="Stable handle used from the CLI and CI.")
    name: str = Field(description="Human-readable display name.")
    description: Optional[str] = Field(default=None, description="Operator note.")
    environment: str = Field(description="Environment class.")
    base_url: str = Field(description="Base URL, normalized (no trailing slash).")
    network_class: str = Field(description="`public` or `private`.")
    approved_by: Optional[str] = Field(
        default=None, description="User who approved a private-network target."
    )
    approved_at: Optional[datetime] = Field(
        default=None, description="When the private-network exception was approved."
    )
    approval_reason: Optional[str] = Field(
        default=None, description="Why a private-network target is justified."
    )
    auth: TargetAuthReference = Field(description="The credential reference — never a credential.")
    policy: VerificationPolicy = Field(description="Execution and failure policy.")
    enabled: bool = Field(description="Whether the target may be resolved for a run.")
    created_by: Optional[str] = Field(default=None, description="User who created the target.")
    updated_by: Optional[str] = Field(default=None, description="User who last modified it.")
    created_at: Optional[datetime] = Field(default=None, description="When it was defined.")
    updated_at: Optional[datetime] = Field(default=None, description="When it last changed.")
    deleted_at: Optional[datetime] = Field(
        default=None, description="Soft-delete timestamp; a retired target is still resolvable "
        "by id for the evidence rows that name it."
    )


def record_from_row(row: Mapping[str, Any]) -> VerificationTargetRecord:
    """Adapt a ``verification_target`` row into a :class:`VerificationTargetRecord`.

    Args:
        row: The database row.

    Returns:
        The record, with the credential reference and policy rebuilt from their columns.
    """
    return VerificationTargetRecord(
        id=str(row.get("id")),
        tenant_id=str(row.get("tenant_id")),
        slug=str(row.get("slug") or ""),
        name=str(row.get("name") or ""),
        description=row.get("description"),
        environment=str(row.get("environment") or ENVIRONMENT_STAGING),
        base_url=str(row.get("base_url") or ""),
        network_class=str(row.get("network_class") or NETWORK_CLASS_PUBLIC),
        approved_by=_text(row.get("approved_by")),
        approved_at=row.get("approved_at"),
        approval_reason=row.get("approval_reason"),
        auth=auth_reference_from_row(row),
        policy=_policy_from_json(row.get("policy")),
        enabled=bool(row.get("enabled", True)),
        created_by=_text(row.get("created_by")),
        updated_by=_text(row.get("updated_by")),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
        deleted_at=row.get("deleted_at"),
    )


def _text(value: Any) -> Optional[str]:
    """Render an id as a string, preserving ``None`` (a UUID arrives as an object)."""
    return None if value is None else str(value)


# ---------------------------------------------------------------------------------------------
# Resolution — what a runner is handed
# ---------------------------------------------------------------------------------------------


class ResolvedTarget(BaseModel):
    """A target selected for a run: identity, endpoint, policy, and a credential *reference*.

    This is the object an ECA-2.1 runner executes against and the one ECA-1.3 records the identity
    of. It is deliberately the same secret-free shape as the stored record plus the resolution's
    own facts — because "what the run used" and "what is configured" should never be two different
    truths.
    """

    model_config = ConfigDict(extra="forbid")

    target_id: str = Field(description="The resolved target's id — the run's target identity.")
    slug: str = Field(description="The handle that was resolved.")
    name: str = Field(description="Display name at resolution time.")
    environment: str = Field(description="Environment class.")
    network_class: str = Field(description="`public` or `private`.")
    base_url: str = Field(description="Normalized base URL to join relative paths onto.")
    policy: VerificationPolicy = Field(description="The policy the runner must honour.")
    auth: TargetAuthReference = Field(
        description=(
            "Where the runner obtains the credential. No credential material is returned by "
            "this API — an `env` reference is read from the runner's own environment, and a "
            "`stored` one is unsealed only at request time by the runner service."
        )
    )
    resolved_at: datetime = Field(description="When the target was resolved.")


def resolve_target_record(
    record: VerificationTargetRecord, *, revalidate_url: bool = True
) -> ResolvedTarget:
    """Turn a stored record into a :class:`ResolvedTarget`, re-checking it is still usable.

    Resolution is not a read: it is the moment a target becomes traffic. Three things are checked
    here that a list read does not care about — the target is not retired, it is enabled, and its
    URL *still* satisfies the network policy. That last one matters because DNS moves: a hostname
    that resolved publicly when the target was created can point at an internal address today, and
    the definition would look unchanged.

    Args:
        record: The stored target.
        revalidate_url: Set ``False`` only where a resolution must not depend on DNS (an offline
            or air-gapped path); the shape checks still run.

    Returns:
        The resolved target.

    Raises:
        TargetValidationError: ``target-not-found`` for a retired target, ``target-disabled`` for
            a disabled one, or a URL code when the endpoint no longer satisfies its network class.
    """
    if record.deleted_at is not None:
        raise TargetValidationError(
            CODE_NOT_FOUND, f"target '{record.slug}' has been deleted and cannot be resolved"
        )
    if not record.enabled:
        raise TargetValidationError(
            CODE_DISABLED,
            f"target '{record.slug}' is disabled; enable it before running verification "
            "against it",
        )

    base_url = validate_base_url(
        record.base_url, record.network_class, resolve=revalidate_url
    )
    if record.network_class == NETWORK_CLASS_PRIVATE and not (record.approval_reason or "").strip():
        raise TargetValidationError(
            CODE_PRIVATE_NOT_APPROVED,
            f"target '{record.slug}' reaches a private network but carries no approval reason",
        )

    return ResolvedTarget(
        target_id=record.id,
        slug=record.slug,
        name=record.name,
        environment=record.environment,
        network_class=record.network_class,
        base_url=base_url,
        policy=record.policy,
        auth=record.auth,
        resolved_at=datetime.now(timezone.utc),
    )


def target_identity(record: VerificationTargetRecord) -> Dict[str, Any]:
    """The secret-free identity block a run record embeds (the ECA-1.3 seam).

    A run says *which* target it used, not *how to authenticate* to it: id, slug, environment,
    network class, and base URL. The credential reference is deliberately absent — an evidence row
    that named the vault entry would tell a reader where to go looking.

    Args:
        record: The resolved target's record.

    Returns:
        A JSON-ready dict for embedding in a run/evidence record.
    """
    return {
        "target_id": record.id,
        "slug": record.slug,
        "environment": record.environment,
        "network_class": record.network_class,
        "base_url": record.base_url,
    }


def policy_violations(
    *,
    network_class: str,
    policy: VerificationPolicy,
) -> List[str]:
    """Cross-field policy rules that no single field validator can express.

    Currently one: TLS verification may only be disabled on a private-network target. A
    self-signed certificate is a fact of internal infrastructure; over the public internet,
    skipping verification means the run may have verified a contract against an attacker.

    Args:
        network_class: The target's network class.
        policy: The proposed policy.

    Returns:
        A list of human-readable violations; empty when the policy is coherent.
    """
    violations: List[str] = []
    if not policy.verify_tls and network_class != NETWORK_CLASS_PRIVATE:
        violations.append(
            "policy.verify_tls may only be disabled on an approved private-network target"
        )
    return violations
