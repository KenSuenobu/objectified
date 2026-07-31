"""Pure webhook logic: signature verification and event parsing (REPO-4.3, #2781).

Everything here is a function of its inputs — there is no database handle, no HTTP client
and no clock — so the whole surface is exercised against literals, the same discipline as
:mod:`app.slate_git_preview`. The one exception is :func:`generate_webhook_secret`, which
draws from the OS entropy pool and so is asserted on its shape, not its value.

The persistence and the enqueue decisions live
in :mod:`app.repository_webhook_dispatch`; the subscription lifecycle in
:mod:`app.repository_webhook_subscriptions`; the REST surface in
:mod:`app.repository_webhook_routes`.

Two jobs:

**Verify.** Each provider signs deliveries its own way, and the ticket asks for "each
provider's standard scheme" rather than one scheme we impose:

============  ==========================================================================
``github``    ``X-Hub-Signature-256: sha256=<hex>``, HMAC-SHA256 of the **raw** body.
``gitlab``    ``X-Gitlab-Token: <secret>``, a shared token compared constant-time.
``bitbucket`` ``X-Hub-Signature: sha256=<hex>``, HMAC-SHA256 of the **raw** body.
============  ==========================================================================

All three fail **closed**: a missing secret, a missing or malformed header, an unknown
provider, and a mismatch are all indistinguishable ``False``. Every comparison runs through
:func:`hmac.compare_digest` so a caller cannot recover the expected value a byte at a time,
and the HMAC schemes hash the exact received bytes — never a re-serialisation of the parsed
JSON, which a single whitespace difference would invalidate.

**Parse.** :func:`parse_webhook_event` turns a delivery into the four facts a poll needs:
which repository, which branch, which head commit, and — for a pull request — which PR and
whether its head lives in this repository or in a fork. Anything that is not an actionable
push or pull request is refused with a named code rather than silently becoming an empty
event, so the ledger records *why* a delivery did nothing.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

__all__ = [
    "SUPPORTED_PROVIDERS",
    "EVENT_KIND_PUSH",
    "EVENT_KIND_PULL_REQUEST",
    "PULL_REQUEST_ACTIONS",
    "WebhookEventError",
    "ParsedWebhookEvent",
    "normalize_provider",
    "generate_webhook_secret",
    "secret_fingerprint",
    "signature_header_for_provider",
    "verify_signature",
    "parse_webhook_event",
]

#: Providers whose deliveries this endpoint can verify and parse.
SUPPORTED_PROVIDERS: Tuple[str, ...] = ("github", "gitlab", "bitbucket")

#: The two event kinds a delivery can reduce to.
EVENT_KIND_PUSH = "push"
EVENT_KIND_PULL_REQUEST = "pull_request"

#: Pull-request actions that mean "there is a head to look at, and it may have moved". A
#: closed, labelled, assigned or ``edited`` PR moves no code — ``edited`` fires on a title or
#: description change — so none of those is worth a walk of the provider's tree.
PULL_REQUEST_ACTIONS: Tuple[str, ...] = (
    "opened",
    "reopened",
    "synchronize",
    "synchronized",
    "ready_for_review",
    # GitLab merge-request actions.
    "open",
    "reopen",
    "update",
    # Bitbucket maps its event key to these actions before parsing.
    "created",
    "updated",
)

#: Length of a generated signing secret, in bytes of entropy (64 hex characters).
_SECRET_BYTES = 32

#: Characters of the SHA-256 hex digest kept as a displayable secret fingerprint.
_FINGERPRINT_CHARS = 16

# Per-provider signature header names, exposed so the routes layer can declare them and the
# subscription layer can tell an operator which header to configure.
_SIGNATURE_HEADERS: Dict[str, str] = {
    "github": "X-Hub-Signature-256",
    "gitlab": "X-Gitlab-Token",
    "bitbucket": "X-Hub-Signature",
}


class WebhookEventError(Exception):
    """A delivery could not be turned into an actionable event.

    Carries a machine-readable ``code`` so the ingestion path records a stable reason in the
    ledger instead of string-matching a message. Codes: ``unsupported_event``,
    ``not_a_branch``, ``branch_deleted``, ``missing_commit``, ``missing_repository``,
    ``missing_branch``, ``unsupported_provider``.
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class ParsedWebhookEvent:
    """The facts a delivery carries that a poll decision is made from.

    Attributes:
        kind: :data:`EVENT_KIND_PUSH` or :data:`EVENT_KIND_PULL_REQUEST`.
        repo_full_name: Lowercased ``owner/name`` of the repository the delivery names.
        branch: The branch the event is *about* — the pushed branch for a push, the **base**
            branch for a pull request. This is the branch matched against the repository's
            tracked (import-spec) branches.
        head_sha: The commit the event points at: the pushed head for a push, the PR head
            commit for a pull request. Empty string when the provider did not send one.
        action: The provider's action string for a pull request (``opened`` /
            ``synchronize`` / …); empty for a push.
        pr_number: The pull-request number, or ``None`` for a push.
        pr_head_branch: The PR's head branch name, or ``None`` for a push.
        pr_head_in_repo: True when the PR head lives in *this* repository rather than a
            fork. A fork head cannot be scanned by branch name through the repository's own
            tree API, so only same-repository heads can be preview-scanned.
    """

    kind: str
    repo_full_name: str
    branch: str
    head_sha: str = ""
    action: str = ""
    pr_number: Optional[int] = None
    pr_head_branch: Optional[str] = None
    pr_head_in_repo: bool = False


def normalize_provider(raw: Any) -> Optional[str]:
    """Normalize a provider path segment to a supported provider id.

    Args:
        raw: The value from the URL path (or a stored column).

    Returns:
        The lowercased provider id when it is one of :data:`SUPPORTED_PROVIDERS`, otherwise
        ``None`` — an unknown provider is never guessed at, because guessing would mean
        guessing which signature scheme protects the endpoint.
    """
    text = str(raw or "").strip().lower()
    return text if text in SUPPORTED_PROVIDERS else None


def generate_webhook_secret() -> str:
    """Generate a fresh HMAC signing secret.

    Returns:
        A 64-character hex string from :mod:`secrets` (256 bits). Hex rather than base64 so
        it can be pasted into any provider's secret field without escaping concerns.
    """
    return secrets.token_hex(_SECRET_BYTES)


def secret_fingerprint(secret: Optional[str]) -> Optional[str]:
    """Compute a short, non-reversible fingerprint of a signing secret.

    An operator needs to answer "is the secret I pasted at GitHub the one you hold?" without
    either side revealing it. A truncated SHA-256 answers exactly that and nothing else.

    Args:
        secret: The plaintext secret, or ``None``.

    Returns:
        The first :data:`_FINGERPRINT_CHARS` hex characters of the SHA-256 digest, or
        ``None`` for a missing/blank secret.
    """
    if not secret:
        return None
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()[:_FINGERPRINT_CHARS]


def signature_header_for_provider(provider: str) -> Optional[str]:
    """Return the header a provider signs its deliveries with.

    Args:
        provider: A provider id (normalized or not).

    Returns:
        The header name, or ``None`` for an unsupported provider.
    """
    key = normalize_provider(provider)
    return _SIGNATURE_HEADERS.get(key) if key else None


def _header(headers: Mapping[str, Any], name: str) -> Optional[str]:
    """Read a header case-insensitively from a plain mapping.

    Starlette's header mapping is already case-insensitive, but the verification helpers are
    also called from tests and from the subscription layer with ordinary dicts, so the
    lookup does not depend on which one it was handed.

    Args:
        headers: Any mapping of header name to value.
        name: The header to read.

    Returns:
        The stripped value, or ``None`` when absent or blank.
    """
    direct = headers.get(name)
    if direct is None:
        lowered = name.lower()
        for key, value in headers.items():
            if str(key).lower() == lowered:
                direct = value
                break
    if direct is None:
        return None
    text = str(direct).strip()
    return text or None


def _verify_hex_hmac(secret: str, raw_body: bytes, header_value: str, prefix: str) -> bool:
    """Verify a ``<prefix>=<hex>`` HMAC-SHA256 header over the raw body, constant-time."""
    if not header_value.startswith(prefix):
        return False
    expected = prefix + hmac.new(
        secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, header_value)


def verify_signature(
    provider: str,
    secret: Optional[str],
    raw_body: bytes,
    headers: Mapping[str, Any],
) -> bool:
    """Verify a delivery against the provider's standard signing scheme.

    Fails closed on every uncertainty: an unsupported provider, a missing secret (which is
    what a deployment with no Fernet key has), a missing or malformed header, and a genuine
    mismatch are all ``False``, and the caller cannot tell them apart. The HMAC schemes run
    over ``raw_body`` — the exact bytes received — because the provider signed those bytes,
    not the JSON we parsed out of them.

    Args:
        provider: The provider the delivery arrived for.
        secret: The subscription's plaintext signing secret, or ``None`` when it could not
            be recovered.
        raw_body: The exact bytes of the received request body.
        headers: The request headers.

    Returns:
        ``True`` only when the delivery genuinely verifies.
    """
    key = normalize_provider(provider)
    if not key or not secret:
        return False

    header_name = _SIGNATURE_HEADERS[key]
    header_value = _header(headers, header_name)
    if not header_value:
        return False

    if key == "github":
        return _verify_hex_hmac(secret, raw_body, header_value, "sha256=")
    if key == "bitbucket":
        return _verify_hex_hmac(secret, raw_body, header_value, "sha256=")
    # GitLab does not sign the body; it echoes the configured secret token. Compared
    # constant-time all the same, so the endpoint is not a byte-at-a-time oracle.
    return hmac.compare_digest(secret, header_value)


def _branch_from_ref(ref: str) -> Optional[str]:
    """Extract a branch name from a ``refs/heads/...`` ref, or ``None`` for anything else."""
    prefix = "refs/heads/"
    if ref.startswith(prefix):
        name = ref[len(prefix) :]
        return name or None
    return None


def _is_null_sha(sha: str) -> bool:
    """True for the all-zero SHA a provider sends when a branch is deleted."""
    return bool(sha) and set(sha) == {"0"}


def _mapping(value: Any) -> Dict[str, Any]:
    """Return ``value`` when it is a mapping, otherwise an empty dict.

    Webhook payloads are attacker-adjacent input: every nested access goes through this so a
    ``null`` or a string where an object was expected produces a named parse error rather
    than an ``AttributeError`` five frames deep.
    """
    return dict(value) if isinstance(value, Mapping) else {}


def _parse_github_push(payload: Mapping[str, Any], repo_full_name: str) -> ParsedWebhookEvent:
    """Parse a GitHub ``push`` delivery."""
    ref = str(payload.get("ref") or "")
    branch = _branch_from_ref(ref)
    if branch is None:
        raise WebhookEventError(
            "not_a_branch", "Only branch pushes trigger a poll; this ref is not a branch."
        )
    if payload.get("deleted") is True:
        raise WebhookEventError(
            "branch_deleted", "This push deletes the branch; there is nothing to scan."
        )
    head = str(payload.get("after") or _mapping(payload.get("head_commit")).get("id") or "")
    if not head or _is_null_sha(head):
        raise WebhookEventError("missing_commit", "Push delivery has no head commit.")
    return ParsedWebhookEvent(
        kind=EVENT_KIND_PUSH,
        repo_full_name=repo_full_name,
        branch=branch,
        head_sha=head[:64],
    )


def _parse_github_pull_request(
    payload: Mapping[str, Any], repo_full_name: str
) -> ParsedWebhookEvent:
    """Parse a GitHub ``pull_request`` delivery."""
    pr = _mapping(payload.get("pull_request"))
    base = _mapping(pr.get("base"))
    head = _mapping(pr.get("head"))
    base_branch = str(base.get("ref") or "")
    if not base_branch:
        raise WebhookEventError(
            "missing_branch", "Pull-request delivery has no base branch."
        )
    head_repo = str(_mapping(head.get("repo")).get("full_name") or "").lower()
    number = payload.get("number") or pr.get("number")
    return ParsedWebhookEvent(
        kind=EVENT_KIND_PULL_REQUEST,
        repo_full_name=repo_full_name,
        branch=base_branch,
        head_sha=str(head.get("sha") or "")[:64],
        action=str(payload.get("action") or "").strip().lower(),
        pr_number=int(number) if isinstance(number, int) else None,
        pr_head_branch=str(head.get("ref") or "") or None,
        pr_head_in_repo=bool(head_repo) and head_repo == repo_full_name,
    )


def _parse_gitlab(
    payload: Mapping[str, Any], event_type: str, repo_full_name: str
) -> ParsedWebhookEvent:
    """Parse a GitLab ``Push Hook`` / ``Merge Request Hook`` delivery."""
    kind = (event_type or str(payload.get("object_kind") or "")).strip().lower()
    if kind in ("push", "push hook"):
        branch = _branch_from_ref(str(payload.get("ref") or ""))
        if branch is None:
            raise WebhookEventError(
                "not_a_branch", "Only branch pushes trigger a poll; this ref is not a branch."
            )
        head = str(payload.get("after") or payload.get("checkout_sha") or "")
        if not head or _is_null_sha(head):
            raise WebhookEventError(
                "branch_deleted" if _is_null_sha(head) else "missing_commit",
                "Push delivery has no head commit.",
            )
        return ParsedWebhookEvent(
            kind=EVENT_KIND_PUSH,
            repo_full_name=repo_full_name,
            branch=branch,
            head_sha=head[:64],
        )

    if kind in ("merge_request", "merge request hook"):
        attrs = _mapping(payload.get("object_attributes"))
        base_branch = str(attrs.get("target_branch") or "")
        if not base_branch:
            raise WebhookEventError(
                "missing_branch", "Merge-request delivery has no target branch."
            )
        source_project = attrs.get("source_project_id")
        target_project = attrs.get("target_project_id")
        number = attrs.get("iid")
        head_sha = str(_mapping(attrs.get("last_commit")).get("id") or "")
        return ParsedWebhookEvent(
            kind=EVENT_KIND_PULL_REQUEST,
            repo_full_name=repo_full_name,
            branch=base_branch,
            head_sha=head_sha[:64],
            action=str(attrs.get("action") or "").strip().lower(),
            pr_number=int(number) if isinstance(number, int) else None,
            pr_head_branch=str(attrs.get("source_branch") or "") or None,
            pr_head_in_repo=(
                source_project is not None and source_project == target_project
            ),
        )

    raise WebhookEventError(
        "unsupported_event", f"GitLab event {kind or 'unknown'!r} does not trigger a poll."
    )


def _parse_bitbucket(
    payload: Mapping[str, Any], event_type: str, repo_full_name: str
) -> ParsedWebhookEvent:
    """Parse a Bitbucket ``repo:push`` / ``pullrequest:*`` delivery."""
    key = (event_type or "").strip().lower()
    if key == "repo:push":
        changes = payload.get("push")
        entries = _mapping(changes).get("changes")
        first = entries[0] if isinstance(entries, list) and entries else None
        change = _mapping(first)
        new = change.get("new")
        if new is None:
            raise WebhookEventError(
                "branch_deleted", "This push deletes the branch; there is nothing to scan."
            )
        new_map = _mapping(new)
        if str(new_map.get("type") or "").lower() != "branch":
            raise WebhookEventError(
                "not_a_branch", "Only branch pushes trigger a poll; this change is not a branch."
            )
        branch = str(new_map.get("name") or "")
        if not branch:
            raise WebhookEventError("missing_branch", "Push delivery has no branch name.")
        head = str(_mapping(new_map.get("target")).get("hash") or "")
        if not head:
            raise WebhookEventError("missing_commit", "Push delivery has no head commit.")
        return ParsedWebhookEvent(
            kind=EVENT_KIND_PUSH,
            repo_full_name=repo_full_name,
            branch=branch,
            head_sha=head[:64],
        )

    if key.startswith("pullrequest:"):
        pr = _mapping(payload.get("pullrequest"))
        destination = _mapping(pr.get("destination"))
        source = _mapping(pr.get("source"))
        base_branch = str(_mapping(destination.get("branch")).get("name") or "")
        if not base_branch:
            raise WebhookEventError(
                "missing_branch", "Pull-request delivery has no destination branch."
            )
        source_repo = str(
            _mapping(source.get("repository")).get("full_name") or ""
        ).lower()
        number = pr.get("id")
        return ParsedWebhookEvent(
            kind=EVENT_KIND_PULL_REQUEST,
            repo_full_name=repo_full_name,
            branch=base_branch,
            head_sha=str(_mapping(source.get("commit")).get("hash") or "")[:64],
            action=key.split(":", 1)[1],
            pr_number=int(number) if isinstance(number, int) else None,
            pr_head_branch=str(_mapping(source.get("branch")).get("name") or "") or None,
            pr_head_in_repo=bool(source_repo) and source_repo == repo_full_name,
        )

    raise WebhookEventError(
        "unsupported_event", f"Bitbucket event {key or 'unknown'!r} does not trigger a poll."
    )


def repo_full_name_from_payload(provider: str, payload: Mapping[str, Any]) -> str:
    """Extract the lowercased ``owner/name`` a delivery is about.

    Resolving the repository is the *first* thing the ingestion path does, before it can
    verify anything, because the secret to verify with is stored per repository.

    Args:
        provider: The normalized provider id.
        payload: The parsed delivery body.

    Returns:
        The lowercased full name, or an empty string when the payload does not carry one.
    """
    repo = _mapping(payload.get("repository"))
    if provider == "gitlab":
        # GitLab sends `project.path_with_namespace` on both hooks; `repository.name` is
        # only the trailing segment, which would collide across groups.
        project = _mapping(payload.get("project"))
        candidate = project.get("path_with_namespace") or repo.get("path_with_namespace")
        return str(candidate or "").strip().lower()
    return str(repo.get("full_name") or "").strip().lower()


def parse_webhook_event(
    provider: str, event_type: Optional[str], payload: Mapping[str, Any]
) -> ParsedWebhookEvent:
    """Parse a delivery into the facts a poll decision needs.

    Args:
        provider: The normalized provider id.
        event_type: The provider's event header value (``X-GitHub-Event``,
            ``X-Gitlab-Event``, ``X-Event-Key``), when sent.
        payload: The parsed delivery body.

    Returns:
        The parsed event.

    Raises:
        WebhookEventError: When the delivery is not an actionable push or pull request. The
            error's ``code`` is what the ledger records as the reason.
    """
    key = normalize_provider(provider)
    if not key:
        raise WebhookEventError(
            "unsupported_provider", f"Provider {provider!r} is not supported."
        )

    repo_full_name = repo_full_name_from_payload(key, payload)
    if not repo_full_name:
        raise WebhookEventError(
            "missing_repository", "Delivery does not name a repository."
        )

    event = (event_type or "").strip().lower()
    if key == "github":
        if event == "push":
            return _parse_github_push(payload, repo_full_name)
        if event == "pull_request":
            return _parse_github_pull_request(payload, repo_full_name)
        raise WebhookEventError(
            "unsupported_event", f"GitHub event {event or 'unknown'!r} does not trigger a poll."
        )
    if key == "gitlab":
        return _parse_gitlab(payload, event, repo_full_name)
    return _parse_bitbucket(payload, event, repo_full_name)
