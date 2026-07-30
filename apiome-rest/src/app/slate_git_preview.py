"""Pure logic for git-triggered immutable preview builds — APX-3.3 (private-suite#2458).

Everything here is a pure function of its inputs: signature verification, the source digest,
URL derivation, push-event parsing, the changed-page mapping, the branch-alias-advance gate and
the provider-status payload. There is no I/O and no database access, so the whole surface is
exercised against literals — the same discipline as :mod:`app.slate_artifacts` and
:mod:`app.slate_releases`. The persistence that calls these functions lives in
:mod:`app.slate_git_preview_store`; the REST surface in :mod:`app.slate_git_preview_routes`.

The four acceptance criteria of #2458 are each anchored to a function here:

1. *Signed, idempotent events, one preview per source digest* —
   :func:`verify_github_signature` (over the raw request body) and
   :func:`compute_source_digest` (the idempotency key).
2. *Immutable commit URL; branch alias advances only after checks* —
   :func:`derive_immutable_url` / :func:`derive_branch_alias_url` and
   :func:`evaluate_alias_advance`.
3. *Status includes changed-page links, expiry/access, failure evidence* —
   :func:`map_changed_files` and :func:`describe_provider_status`.
4. *Tokens never reach the browser; retry and cleanup audited* — enforced in the store and
   routes; this module only shapes the (secret-free) status payload.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence

__all__ = [
    "SlatePreviewEventError",
    "ParsedGitEvent",
    "ChangedPage",
    "AliasAdvanceDecision",
    "DIGEST_PATTERN",
    "verify_github_signature",
    "compute_source_digest",
    "derive_immutable_url",
    "derive_branch_alias_url",
    "parse_push_event",
    "map_changed_files",
    "evaluate_alias_advance",
    "describe_provider_status",
]

# Same wire/storage shape the database enforces on source_digest.
DIGEST_PATTERN = "sha256:"

# Domain-separation tag for the source digest, mirroring slate_artifacts. Two different kinds of
# input that happen to serialise identically must not collide.
_SOURCE_DIGEST_TAG = b"apiome.slate.preview.source.v1"

# File extensions whose changes map to a documentation route. A push touching a CI config or a
# lockfile does not change a rendered page, so it produces no changed-page link.
_DOC_EXTENSIONS = (".md", ".mdx", ".markdown", ".html", ".htm", ".yaml", ".yml", ".json")

# The reason surfaced whenever a build or status is not actually dispatched. Names the ticket
# that will attach the missing tier, exactly as the cache/security control planes do.
BUILD_PENDING_REASON = (
    "Preview recorded but not built: the Slate build worker (Slate 7.3, #3419) is not yet "
    "attached, so no bytes were produced."
)
STATUS_PENDING_REASON = (
    "Status recorded but not posted to the provider: the first-party provider check-run "
    "adapter (ROADMAP_GIT_NATIVE_COLLABORATION) is not yet attached."
)


class SlatePreviewEventError(Exception):
    """A provider event could not be turned into a preview.

    Carries a machine-readable ``code`` so the REST layer maps it to a status without
    string-matching. Codes: ``unsupported_event``, ``not_a_branch``, ``branch_deleted``,
    ``missing_commit``, ``missing_repository``.
    """

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class ChangedPage:
    """A page a push touched, with the route it renders to and the file it came from."""

    route: str
    kind: str  # 'added' | 'changed' | 'removed'
    source_path: str


@dataclass(frozen=True)
class ParsedGitEvent:
    """The facts a push event carries that a preview is built from."""

    repo_full_name: str
    branch: str
    commit: str
    message: str
    changed_files_added: Sequence[str] = field(default_factory=tuple)
    changed_files_modified: Sequence[str] = field(default_factory=tuple)
    changed_files_removed: Sequence[str] = field(default_factory=tuple)


@dataclass(frozen=True)
class AliasAdvanceDecision:
    """Whether a branch alias may advance to a build, and why not when it may not."""

    advance: bool
    reason: Optional[str] = None


def verify_github_signature(
    secret: Optional[str], raw_body: bytes, header: Optional[str]
) -> bool:
    """Verify a GitHub ``X-Hub-Signature-256`` header against the raw request body.

    GitHub computes ``"sha256=" + HMAC_SHA256(secret, body)`` over the **exact bytes** it sent,
    so verification must run over the raw body, never a re-serialisation of the parsed JSON — a
    single whitespace difference would break an otherwise-valid signature. The comparison is
    constant-time (:func:`hmac.compare_digest`) so a caller cannot use timing to recover the
    expected value byte by byte.

    Args:
        secret: The connection's webhook signing secret, or ``None`` when the server has no
            encryption key configured to recover it.
        raw_body: The exact bytes of the received request body.
        header: The value of the ``X-Hub-Signature-256`` header, if present.

    Returns:
        ``True`` only when the secret is present and the header verifies. A missing secret, a
        missing or malformed header, or a mismatch all return ``False`` — verification fails
        closed.
    """
    if not secret or not header:
        return False
    if not header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, header)


def compute_source_digest(repo_full_name: str, commit: str) -> str:
    """Compute the idempotency key for a preview: a digest of the source it would build.

    Two deliveries of the same commit on the same repository produce the same digest, so the
    ``UNIQUE (connection_id, source_digest)`` constraint turns a redelivered webhook into a
    no-op rather than a duplicate preview. The repository is folded in so the same commit sha in
    two repositories (possible for a fork) stays distinct.

    Args:
        repo_full_name: The lowercased ``owner/name`` of the repository.
        commit: The full commit sha the preview would build.

    Returns:
        A ``sha256:``-prefixed digest string, matching the database CHECK constraint.
    """
    payload = json.dumps(
        {"repo": repo_full_name.lower(), "commit": commit.lower()},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    digest = hashlib.sha256(_SOURCE_DIGEST_TAG + b"\x00" + payload).hexdigest()
    return f"sha256:{digest}"


def _normalise_host(preview_host: str) -> str:
    """Return ``scheme://host`` with no trailing slash, defaulting to https."""
    host = preview_host.strip().rstrip("/")
    if "://" not in host:
        host = f"https://{host}"
    return host


def _short_commit(commit: str) -> str:
    """The 12-char short sha used in a commit URL; the full sha stays the stored identity."""
    return commit.lower()[:12]


def _slug(value: str) -> str:
    """Lowercase a branch/name into a URL-safe slug: non-alphanumerics collapse to a hyphen."""
    out = []
    prev_dash = False
    for ch in value.lower():
        if ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    return "".join(out).strip("-") or "branch"


def derive_immutable_url(preview_host: str, site_slug: str, commit: str) -> str:
    """Derive the immutable commit URL — keyed on the commit, so it never moves.

    Args:
        preview_host: The connection's preview host (e.g. ``previews.apiome.dev``).
        site_slug: The site's slug.
        commit: The full commit sha.

    Returns:
        A stable URL of the form ``https://<host>/<site>/commit/<shortsha>``.
    """
    return f"{_normalise_host(preview_host)}/{site_slug}/commit/{_short_commit(commit)}"


def derive_branch_alias_url(preview_host: str, site_slug: str, branch: str) -> str:
    """Derive the moving branch alias URL — keyed on the branch, so it follows the branch.

    Args:
        preview_host: The connection's preview host.
        site_slug: The site's slug.
        branch: The branch name.

    Returns:
        A stable URL of the form ``https://<host>/<site>/branch/<branch-slug>``.
    """
    return f"{_normalise_host(preview_host)}/{site_slug}/branch/{_slug(branch)}"


def parse_push_event(payload: Mapping[str, Any]) -> ParsedGitEvent:
    """Parse a GitHub push webhook payload into the facts a preview needs.

    Only branch pushes that carry a head commit produce a preview. A tag push, a branch
    deletion (``deleted: true`` or an all-zero ``after``) and a payload with no repository or no
    commit are each refused with a named code rather than a silent empty preview.

    Args:
        payload: The parsed JSON body of a GitHub ``push`` event.

    Returns:
        The parsed event.

    Raises:
        SlatePreviewEventError: When the payload is not a buildable branch push.
    """
    repo = payload.get("repository") or {}
    repo_full_name = repo.get("full_name")
    if not repo_full_name:
        raise SlatePreviewEventError(
            "missing_repository", "Push event has no repository.full_name."
        )

    ref = payload.get("ref") or ""
    if not ref.startswith("refs/heads/"):
        raise SlatePreviewEventError(
            "not_a_branch",
            "Only branch pushes produce previews; this ref is not under refs/heads/.",
        )
    branch = ref[len("refs/heads/") :]

    if payload.get("deleted") is True:
        raise SlatePreviewEventError(
            "branch_deleted", "This push deletes the branch; there is nothing to preview."
        )

    commit = payload.get("after") or (payload.get("head_commit") or {}).get("id")
    if not commit or set(commit) == {"0"}:
        raise SlatePreviewEventError(
            "missing_commit", "Push event has no head commit to build."
        )

    head = payload.get("head_commit") or {}
    message = (head.get("message") or "").splitlines()[0] if head.get("message") else ""

    return ParsedGitEvent(
        repo_full_name=str(repo_full_name).lower(),
        branch=branch,
        commit=str(commit),
        message=message,
        changed_files_added=tuple(head.get("added") or ()),
        changed_files_modified=tuple(head.get("modified") or ()),
        changed_files_removed=tuple(head.get("removed") or ()),
    )


def _route_for_file(path: str, docs_prefix: str) -> Optional[str]:
    """Map a repository documentation file path to a portal route, or None if not a doc.

    The mapping is deterministic and convention-based: a file under ``docs_prefix`` with a known
    documentation extension becomes ``/`` + its path with the prefix and extension stripped; an
    ``index`` file maps to its directory. Anything else (a CI config, a lockfile, an asset) has
    no rendered page and returns ``None``.
    """
    lowered = path.lower()
    if not any(lowered.endswith(ext) for ext in _DOC_EXTENSIONS):
        return None

    rel = path
    prefix = docs_prefix.strip("/")
    if prefix:
        if rel == prefix or rel.startswith(prefix + "/"):
            rel = rel[len(prefix) :].lstrip("/")
        else:
            # Outside the documentation root — not a rendered page for this site.
            return None

    # Strip the extension.
    dot = rel.rfind(".")
    if dot > rel.rfind("/"):
        rel = rel[:dot]

    # An index file renders as its containing directory.
    if rel.endswith("/index"):
        rel = rel[: -len("/index")]
    elif rel == "index":
        rel = ""

    return "/" + rel.strip("/")


def map_changed_files(event: ParsedGitEvent, *, docs_prefix: str = "docs") -> List[ChangedPage]:
    """Map a push event's changed files to the documentation pages it touches.

    A preview does not need to be built to know which pages a change *touches* — that is
    derivable from the pushed file list. Each returned page carries the route it renders to and
    the file it came from, so the provider status can link a reviewer straight at the changed
    page. Deduplicated by route; when the same route is both modified and removed, ``removed``
    wins because it is the more consequential state to review.

    Args:
        event: The parsed push event.
        docs_prefix: The repository directory the site's documentation lives under.

    Returns:
        The changed pages, ordered by route.
    """
    by_route: Dict[str, ChangedPage] = {}
    # Lower precedence first, higher last, so the last write per route wins.
    for kind, files in (
        ("changed", event.changed_files_modified),
        ("added", event.changed_files_added),
        ("removed", event.changed_files_removed),
    ):
        for path in files:
            route = _route_for_file(path, docs_prefix)
            if route is None:
                continue
            by_route[route] = ChangedPage(route=route, kind=kind, source_path=path)
    return [by_route[route] for route in sorted(by_route)]


def evaluate_alias_advance(
    *, checks_state: str, status: str, cleaned_up: bool
) -> AliasAdvanceDecision:
    """Decide whether a branch alias may advance to a build (acceptance criterion 2).

    The alias advances only when the build's checks have passed and the build is still a live
    preview. A pending or failed check, an expired/failed build, or a cleaned-up preview each
    hold the alias where it is, with a named reason — the alias must never point a reviewer at a
    preview that has not passed its checks.

    Args:
        checks_state: The build's ``checks_state`` (``pending`` | ``passed`` | ``failed``).
        status: The build's lifecycle ``status``.
        cleaned_up: Whether the preview has been reaped.

    Returns:
        The decision, carrying a reason when it refuses.
    """
    if cleaned_up:
        return AliasAdvanceDecision(False, "the preview has been cleaned up")
    if status in ("failed", "expired"):
        return AliasAdvanceDecision(False, f"the preview is {status}")
    if checks_state == "pending":
        return AliasAdvanceDecision(False, "checks have not completed")
    if checks_state == "failed":
        return AliasAdvanceDecision(False, "checks failed")
    if checks_state == "passed":
        return AliasAdvanceDecision(True)
    return AliasAdvanceDecision(False, f"unknown checks state {checks_state!r}")


def _iso(value: Any) -> Optional[str]:
    """Render a datetime as ISO-8601, or pass a string through, or None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def describe_provider_status(
    *,
    build: Mapping[str, Any],
    changed_pages: Sequence[Mapping[str, Any]],
    alias_url: Optional[str],
) -> Dict[str, Any]:
    """Assemble the provider-status payload for a preview (acceptance criterion 3).

    Gathers everything a status write-back carries: the state, the immutable and alias links,
    the changed-page deep links, the expiry and access state of the preview lane, and — when the
    build failed — its failure evidence. It also carries the ``delivery`` honesty block: the
    build was not executed and the status was not posted, each with the reason naming the
    missing tier, so a consumer cannot mistake a recorded status for a dispatched one. The
    payload contains no secret or token — only the (non-sensitive) preview facts.

    Args:
        build: The preview build row.
        changed_pages: The build's changed-page rows.
        alias_url: The branch alias URL, when the alias points at this build.

    Returns:
        A JSON-serialisable status payload.
    """
    checks_state = str(build.get("checks_state") or "pending")
    status = str(build.get("status") or "queued")
    if status == "failed" or checks_state == "failed":
        state = "failure"
    elif checks_state == "passed":
        state = "success"
    else:
        state = "pending"

    failure_evidence = build.get("failure_evidence") if state == "failure" else None

    return {
        "state": state,
        "status": status,
        "checksState": checks_state,
        "immutableUrl": build.get("immutable_url"),
        "aliasUrl": alias_url,
        "commit": build.get("source_commit"),
        "branch": build.get("source_ref"),
        "changedPages": [
            {
                "route": page.get("route"),
                "kind": page.get("kind"),
                "linkUrl": page.get("link_url"),
                "pathId": (str(page["path_id"]) if page.get("path_id") else None),
            }
            for page in changed_pages
        ],
        "changedPageCount": len(changed_pages),
        "access": {
            "policy": build.get("access_policy"),
            "robotsExcluded": bool(build.get("robots_excluded")),
            "expiresAt": _iso(build.get("expires_at")),
        },
        "failureEvidence": failure_evidence,
        "delivery": {
            "buildDispatched": False,
            "statusDispatched": False,
            "buildReason": BUILD_PENDING_REASON,
            "statusReason": STATUS_PENDING_REASON,
        },
    }
