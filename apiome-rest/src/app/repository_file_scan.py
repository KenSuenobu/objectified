"""
Background processing for tenant_repository_file_scan_jobs.

Fetches the default-branch Git tree from GitHub (public or via linked-account token),
persists paths to apiome.tenant_repository_files, then marks the repository ready.

Large monorepos (REPO-2.5, #2766) are walked in bounded, resumable passes:

* entries stream to the database in chunks of at most
  ``repository_scan_budget.MAX_WALK_CHUNK_SIZE`` (1000) instead of one in-memory
  list per branch;
* each pass runs under a per-tenant wall-clock budget (default 5 min) and stores a
  resume cursor when it runs out, so the next pass continues where it stopped;
* a transient provider failure (network error, 429, 5xx) also stores the cursor and
  re-queues the job rather than discarding the walk; and
* when GitHub reports the ``recursive=1`` Trees response ``truncated`` — the
  provider's own signal that the repository is too large for one call — the walk
  falls back to a per-directory breadth-first descent using the non-recursive
  Trees primitive, which is both bounded and resumable.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence, Tuple
from urllib.parse import quote

import httpx

from .database import Database
from .repository_scan_budget import (
    WALK_MODE_RECURSIVE,
    WALK_MODE_SPARSE,
    ScanBudget,
    ScanCursor,
    TransientScanError,
    is_cursor_expired,
    resolve_chunk_size,
    resolve_scan_budget_seconds,
    should_abandon_cursor,
)
from .repository_validation import parse_github_owner_repo_from_url, parse_owner_repo_slash

_logger = logging.getLogger(__name__)

UA = "Apiome-RepositoryFileScan/1.0"
_HTTP_TIMEOUT = httpx.Timeout(90.0, connect=20.0)

#: HTTP statuses worth resuming from rather than failing the scan outright.
_TRANSIENT_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


def detected_kind_from_path(path: str) -> Optional[str]:
    """Filename-only classification (Repository Store README / mockups)."""
    raw = path.strip()
    if not raw:
        return None
    lower = raw.lower()
    base = lower.rsplit("/", 1)[-1]

    if re.search(r"/schema\.prisma$|(^|/)schema\.prisma$", lower):
        return "prisma-candidate"
    if base in ("postman_collection.json",) or base.endswith(".postman.json"):
        return "postman-candidate"
    if "openapi" in base and (base.endswith(".yaml") or base.endswith(".yml") or base.endswith(".json")):
        return "openapi-candidate"
    if "swagger" in base and (base.endswith(".yaml") or base.endswith(".yml") or base.endswith(".json")):
        return "openapi-candidate"
    if "arazzo" in base and (base.endswith(".yaml") or base.endswith(".yml") or base.endswith(".json")):
        return "arazzo-candidate"
    if ".arazzo.yaml" in base or ".arazzo.yml" in lower:
        return "arazzo-candidate"
    if "asyncapi" in base and (base.endswith(".yaml") or base.endswith(".yml") or base.endswith(".json")):
        return "asyncapi-candidate"
    if base.endswith(".proto"):
        return "protobuf-candidate"
    if base.endswith(".avsc"):
        return "avro-candidate"
    if base.endswith(".graphql") or base.endswith(".gql"):
        return "graphql-candidate"
    if base.endswith(".dbml"):
        return "dbml-candidate"
    if base.endswith(".sql") or base.endswith(".ddl"):
        return "sql-ddl-candidate"
    if "/schemas/" in lower and base.endswith(".json"):
        return "json-candidate"
    if base.endswith(".schema.json"):
        return "json-candidate"
    if base.endswith(".yaml") or base.endswith(".yml"):
        return "yaml-candidate"
    if base.endswith(".json"):
        return "json-candidate"
    return None


def json_schema_shaped_path(path: str) -> bool:
    """Whether a ``.json`` path carries a JSON-Schema-shaped *name*.

    ``detected_kind_from_path`` collapses every ``.json`` file to ``json-candidate``,
    so the kind alone cannot tell a schema from a ``package.json``. This is the
    filename-only tiebreak used to decide importability: the same two shapes the
    ``json_schema`` browser preset advertises — a ``*.schema.json`` basename, or a
    ``.json`` under a ``schemas/`` directory (at any depth, including the root).

    Kept in lockstep with the SQL mirror in
    ``Database.tenant_repository_files_stats_and_page`` (``importable_sql``) so the
    stored per-file counts and the live browser filter agree.
    """
    lower = (path or "").strip().lower().replace("\\", "/")
    if not lower.endswith(".json"):
        return False
    if lower.rsplit("/", 1)[-1].endswith(".schema.json"):
        return True
    return "/schemas/" in lower or lower.startswith("schemas/")


def _importable_hint(kind: Optional[str], path: str = "") -> bool:
    if not kind:
        return False
    k = kind.lower()
    if any(
        k.startswith(p)
        for p in (
            "openapi",
            "arazzo",
            "asyncapi",
            "graphql",
            "protobuf",
            "postman",
            "prisma",
            "sql-ddl",
            "avro",
            "dbml",
        )
    ):
        return True
    # JSON Schema is a first-class import source (``json-schema`` in
    # ``import_pipeline._DETECTORS``), but it shares the generic ``json-candidate``
    # kind with config/lockfiles — so admit it on the filename shape only.
    return k.startswith("json") and json_schema_shaped_path(path)


def _github_owner_repo(repo_row: Dict[str, Any]) -> Tuple[str, str]:
    clone = str(repo_row.get("clone_url") or "")
    parts = parse_github_owner_repo_from_url(clone)
    if parts:
        return parts
    full = (repo_row.get("repository_full_name") or "").strip()
    pr = parse_owner_repo_slash(full)
    if pr:
        return pr
    raise ValueError("could not resolve GitHub owner/repo from repository row")


def _github_headers(access_token: Optional[str]) -> Dict[str, str]:
    """Build the GitHub REST headers used by every walk request."""
    headers: Dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    return headers


def _get_github_json(
    client: httpx.Client, url: str, headers: Dict[str, str], *, what: str
) -> Dict[str, Any]:
    """GET a GitHub JSON document, classifying failures as transient or fatal.

    Args:
        client: The open HTTP client for this pass.
        url: Fully-qualified GitHub API URL.
        headers: Request headers from :func:`_github_headers`.
        what: Short label for the resource, used in error messages.

    Returns:
        The decoded JSON object (an empty mapping when the body is not an object).

    Raises:
        TransientScanError: On a network error or a retryable status (timeouts,
            429 rate limiting, 5xx). The caller stores its cursor and resumes.
        ValueError: On any other non-200 status — a fatal scan error.
    """
    try:
        resp = client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise TransientScanError(f"GitHub {what} request failed: {exc}") from exc

    if resp.status_code in _TRANSIENT_STATUSES:
        raise TransientScanError(f"GitHub {what} API error: HTTP {resp.status_code}")
    if resp.status_code == 404:
        raise ValueError(f"GitHub {what} not found")
    if resp.status_code != 200:
        raise ValueError(f"GitHub {what} API error: HTTP {resp.status_code}")

    payload = resp.json()
    return payload if isinstance(payload, dict) else {}


def _start_cursor_for_branch(
    client: httpx.Client, headers: Dict[str, str], owner_q: str, repo_q: str, branch: str
) -> ScanCursor:
    """Resolve a branch's root tree and tip recency into a fresh walk cursor.

    Pinning the tree SHA here is what makes a resumed pass consistent: later passes
    keep walking the same snapshot even if the branch moves underneath them.

    The branch tip commit recency (RAR-2.1) is captured at the same time — the
    branch API already returns the tip commit SHA and its committed-at date — so
    every entry written across every pass carries the same comparable "newer-than"
    anchor. Granularity is branch-tip (one value per scan), which the newer-than
    comparator (RAR-2.2) pairs with content-checksum idempotency.

    Args:
        client: The open HTTP client for this pass.
        headers: Request headers from :func:`_github_headers`.
        owner_q: URL-quoted repository owner.
        repo_q: URL-quoted repository name.
        branch: The branch to walk (quoted internally).

    Returns:
        A fresh :class:`ScanCursor` in ``recursive`` mode at offset 0.

    Raises:
        ValueError: When the branch is missing or carries no tree SHA.
        TransientScanError: On a retryable provider failure.
    """
    branch_q = quote(branch, safe="")
    try:
        payload = _get_github_json(
            client,
            f"https://api.github.com/repos/{owner_q}/{repo_q}/branches/{branch_q}",
            headers,
            what="branches",
        )
    except ValueError as exc:
        if "not found" in str(exc):
            raise ValueError(f"GitHub branch not found: {branch}") from exc
        raise

    tip = payload.get("commit") if isinstance(payload.get("commit"), dict) else {}
    inner = tip.get("commit") if isinstance(tip.get("commit"), dict) else {}
    tree_obj = inner.get("tree") if isinstance(inner.get("tree"), dict) else None
    tree_sha = tree_obj.get("sha") if tree_obj else None
    if not tree_sha:
        raise ValueError("GitHub response missing tree sha for branch")

    committer = inner.get("committer") if isinstance(inner.get("committer"), dict) else {}
    return ScanCursor(
        tree_sha=str(tree_sha),
        mode=WALK_MODE_RECURSIVE,
        tip_commit_sha=str(tip.get("sha") or "")[:64] or None,
        tip_committed_at=(committer.get("date") or "").strip() or None,
    )


def _blob_entry(entry: Dict[str, Any], path: str, cursor: ScanCursor) -> Dict[str, Any]:
    """Convert one GitHub tree blob into an indexable file row.

    Args:
        entry: The raw ``tree[]`` element from the GitHub Trees API.
        path: The blob's repository-relative path (already prefixed in sparse mode).
        cursor: The walk cursor supplying the branch-tip recency anchors.

    Returns:
        The mapping consumed by ``Database.append_tenant_repository_files``.
    """
    name = path.rsplit("/", 1)[-1]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if len(ext) > 64:
        ext = ext[:64]

    raw_sz = entry.get("size")
    size_i: Optional[int] = None
    if isinstance(raw_sz, int):
        size_i = raw_sz
    elif isinstance(raw_sz, float) and raw_sz == int(raw_sz):
        size_i = int(raw_sz)
    elif isinstance(raw_sz, str) and raw_sz.isdigit():
        size_i = int(raw_sz)

    return {
        "path": path,
        "name": name[:512] if len(name) > 512 else name,
        "ext": ext or None,
        "size_bytes": size_i,
        "blob_sha": str(entry.get("sha") or "")[:64] or None,
        "detected_kind": detected_kind_from_path(path),
        "commit_sha": cursor.tip_commit_sha,
        "committed_at": cursor.tip_committed_at,
    }


class WalkOutcome(NamedTuple):
    """Result of one bounded walk pass (REPO-2.5).

    Attributes:
        completed: True when the whole tree was walked; False when the pass
            stopped on its wall-clock budget and must be resumed.
        cursor: The position to resume from when ``completed`` is False; None when
            the walk finished.
        truncated_prefixes: Directories GitHub itself reported as truncated, so a
            necessarily incomplete index is visible rather than silent.
    """

    completed: bool
    cursor: Optional[ScanCursor]
    truncated_prefixes: List[str]


def walk_github_tree_in_chunks(
    owner: str,
    repo: str,
    branch: str,
    access_token: Optional[str],
    *,
    on_chunk: Callable[[List[Dict[str, Any]]], None],
    cursor: Optional[ScanCursor] = None,
    budget: Optional[ScanBudget] = None,
    chunk_size: int = 0,
) -> WalkOutcome:
    """Walk a branch's Git tree, streaming entries to ``on_chunk`` (REPO-2.5).

    Two walk modes, chosen from the provider's own size signal:

    * ``recursive`` — one ``git/trees/{sha}?recursive=1`` call. Used first because
      it is a single request. A resumed pass re-issues it and skips
      ``cursor.emitted`` blobs; the pinned tree SHA makes that offset stable.
    * ``sparse`` — entered when GitHub answers ``truncated: true`` (the repository
      is too large for one call). The walk descends directory by directory with
      the non-recursive Trees primitive, keeping only a queue of unvisited
      sub-trees in memory. This is the mode that makes a >25k-entry monorepo
      walkable at all, and its queue *is* the resume position.

    Memory is bounded in both modes: at most ``chunk_size`` entries are buffered
    before being handed to ``on_chunk``.

    The budget is only checked at a safe resume point — a chunk boundary in
    recursive mode, a directory boundary in sparse mode — so a paused pass never
    loses entries it has already read but not written.

    Args:
        owner: GitHub repository owner.
        repo: GitHub repository name.
        branch: The branch to walk. Ignored when ``cursor`` is supplied, since the
            cursor pins the tree the earlier pass started on.
        access_token: OAuth token for private repositories, or None.
        on_chunk: Sink invoked with each chunk of at most ``chunk_size`` entries.
            It must be idempotent per path: a pass that dies after writing but
            before its cursor is stored re-emits its last chunk.
        cursor: Resume position from a previous pass, or None to start fresh.
        budget: Wall-clock budget for this pass; None (or an unbounded budget)
            walks to completion.
        chunk_size: Requested entries per chunk; clamped to at most 1000 by
            :func:`repository_scan_budget.resolve_chunk_size`.

    Returns:
        A :class:`WalkOutcome`.

    Raises:
        TransientScanError: On a retryable provider failure. ``exc.cursor`` holds
            the position covering everything already handed to ``on_chunk``.
        ValueError: On a fatal provider error (missing branch, bad status).
    """
    limit = resolve_chunk_size(chunk_size)
    headers = _github_headers(access_token)
    owner_q = quote(owner, safe="")
    repo_q = quote(repo, safe="")

    buffer: List[Dict[str, Any]] = []

    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        state = cursor
        if state is None:
            state = _start_cursor_for_branch(client, headers, owner_q, repo_q, branch)

        def flush() -> None:
            """Hand the buffered entries to the sink and advance the cursor."""
            nonlocal buffer
            if not buffer:
                return
            on_chunk(buffer)
            state.emitted += len(buffer)
            buffer = []

        def paused() -> WalkOutcome:
            """Flush what is buffered and report a resumable stop."""
            flush()
            return WalkOutcome(completed=False, cursor=state, truncated_prefixes=state.truncated_prefixes)

        try:
            if state.mode == WALK_MODE_RECURSIVE:
                payload = _get_github_json(
                    client,
                    f"https://api.github.com/repos/{owner_q}/{repo_q}/git/trees/{state.tree_sha}?recursive=1",
                    headers,
                    what="tree",
                )
                if payload.get("truncated"):
                    # Provider-side sparse-tree signal: fall back to the bounded
                    # per-directory descent, restarting the emit counter. Re-emitted
                    # paths are absorbed by the sink's upsert.
                    _logger.info(
                        "repository tree truncated; switching to sparse walk owner=%s repo=%s branch=%s",
                        owner,
                        repo,
                        branch,
                    )
                    state.mode = WALK_MODE_SPARSE
                    state.pending = [{"sha": state.tree_sha, "prefix": ""}]
                    state.emitted = 0
                else:
                    skip = state.emitted
                    seen = 0
                    for raw in payload.get("tree") or []:
                        if not isinstance(raw, dict) or raw.get("type") != "blob":
                            continue
                        path = str(raw.get("path") or "")
                        if not path:
                            continue
                        seen += 1
                        if seen <= skip:
                            continue
                        buffer.append(_blob_entry(raw, path, state))
                        if len(buffer) >= limit:
                            flush()
                            if budget is not None and budget.exhausted():
                                return paused()
                    flush()
                    return WalkOutcome(True, None, state.truncated_prefixes)

            # Sparse mode: breadth-first descent, one directory per request.
            while state.pending:
                if budget is not None and budget.exhausted():
                    return paused()

                node = state.pending[0]
                payload = _get_github_json(
                    client,
                    f"https://api.github.com/repos/{owner_q}/{repo_q}/git/trees/{node['sha']}",
                    headers,
                    what="tree",
                )
                # Only drop the directory once its listing is safely in hand, so a
                # transient failure resumes on the same directory.
                state.pending.pop(0)

                prefix = node.get("prefix") or ""
                if payload.get("truncated") and prefix not in state.truncated_prefixes:
                    _logger.warning(
                        "GitHub truncated a directory listing; index will be incomplete "
                        "owner=%s repo=%s branch=%s prefix=%r",
                        owner,
                        repo,
                        branch,
                        prefix,
                    )
                    state.truncated_prefixes.append(prefix)

                for raw in payload.get("tree") or []:
                    if not isinstance(raw, dict):
                        continue
                    name = str(raw.get("path") or "")
                    if not name:
                        continue
                    full = f"{prefix}/{name}" if prefix else name
                    kind = raw.get("type")
                    if kind == "tree":
                        sha = str(raw.get("sha") or "")
                        if sha:
                            state.pending.append({"sha": sha, "prefix": full})
                    elif kind == "blob":
                        buffer.append(_blob_entry(raw, full, state))
                        if len(buffer) >= limit:
                            flush()

            flush()
            return WalkOutcome(True, None, state.truncated_prefixes)
        except TransientScanError as exc:
            # Persist whatever was read before the failure so the resume cursor and
            # the written rows agree, then hand the position to the caller.
            try:
                flush()
            except Exception:  # pragma: no cover - sink failure masks the original
                _logger.exception("failed to flush buffered scan entries after a transient error")
            exc.cursor = state
            raise


def fetch_github_tree_blobs(owner: str, repo: str, branch: str, access_token: Optional[str]) -> List[Dict[str, Any]]:
    """Collect a branch's blobs into one list (unbounded convenience wrapper).

    Runs :func:`walk_github_tree_in_chunks` with no budget and accumulates every
    chunk, so it holds the whole tree in memory. Kept for callers that genuinely
    want the full list; the scan path uses the chunked walker directly.

    Args:
        owner: GitHub repository owner.
        repo: GitHub repository name.
        branch: The branch to walk.
        access_token: OAuth token for private repositories, or None.

    Returns:
        Every blob on the branch as an indexable file row.
    """
    out: List[Dict[str, Any]] = []
    walk_github_tree_in_chunks(owner, repo, branch, access_token, on_chunk=out.extend)
    return out


def fetch_github_repository_file_text(
    owner: str,
    repo: str,
    path: str,
    ref: str,
    access_token: Optional[str],
    *,
    max_bytes: int = 900_000,
) -> Tuple[str, bool]:
    """
    Download file bytes from GitHub (raw contents API).

    Returns ``(text, truncated)`` where ``text`` is UTF-8 with replacement for invalid bytes.
    ``truncated`` is True when the file exceeded ``max_bytes``.
    """
    headers: Dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"

    owner_q = quote(owner, safe="")
    repo_q = quote(repo, safe="")
    ref_q = quote(ref, safe="")
    norm_path = path.strip().replace("\\", "/").lstrip("/")
    path_q = quote(norm_path, safe="/")

    url = f"https://api.github.com/repos/{owner_q}/{repo_q}/contents/{path_q}?ref={ref_q}"

    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        with client.stream("GET", url, headers=headers) as resp:
            if resp.status_code == 404:
                raise ValueError("GitHub file not found (path or ref may be stale)")
            if resp.status_code == 403:
                raise ValueError("GitHub returned 403 (private repo needs a linked account token or rate limit)")
            if resp.status_code != 200:
                raise ValueError(f"GitHub contents API error: HTTP {resp.status_code}")

            chunks: List[bytes] = []
            total = 0
            truncated = False
            for chunk in resp.iter_bytes():
                if not chunk:
                    continue
                if total >= max_bytes:
                    truncated = True
                    break
                take = chunk[: max(0, max_bytes - total)]
                if take:
                    chunks.append(take)
                    total += len(take)
                if total >= max_bytes and len(chunk) > len(take):
                    truncated = True
                    break

    raw = b"".join(chunks)
    text = raw.decode("utf-8", errors="replace")
    return text, truncated


def _resolve_scan_token(db: Database, repo_row: Dict[str, Any]) -> Optional[str]:
    """Resolve the linked-account OAuth token to walk this repository with.

    Args:
        db: Database handle.
        repo_row: A ``tenant_repositories`` row.

    Returns:
        The stored access token, or None for a public repository registered
        without a linked account.

    Raises:
        ValueError: When the repository is private and no token is available.
    """
    token: Optional[str] = None
    linked = repo_row.get("linked_account_id")
    created_by = repo_row.get("created_by")
    if linked and created_by:
        oauth = db.get_external_auth_provider_for_user(str(linked), str(created_by))
        if oauth and oauth.get("access_token"):
            token = str(oauth["access_token"])

    if str(repo_row.get("visibility") or "").lower() == "private" and not token:
        raise ValueError("private repository requires a linked account token")
    return token


class ResumeState(NamedTuple):
    """A trusted resume position plus the progress already persisted for it.

    Attributes:
        cursor: The walker position to continue from.
        entries_indexed: Entries earlier passes already wrote for this branch.
        importable_indexed: Importable entries among them.
    """

    cursor: ScanCursor
    entries_indexed: int
    importable_indexed: int


def _load_resume_state(db: Database, repository_id: str, branch: str) -> Optional[ResumeState]:
    """Load a branch's stored resume cursor, dropping it when it cannot be trusted.

    A cursor is discarded (and the branch walked from scratch) when it is
    unreadable, or when it has aged past ``DEFAULT_CURSOR_MAX_AGE_SECONDS`` — the
    branch has almost certainly moved, so resuming would splice two snapshots.
    A cursor that has already been resumed more times than the attempt cap allows
    is both cleared and reported as an error, so a walk that can never finish
    cannot retry forever.

    Args:
        db: Database handle.
        repository_id: The repository being scanned.
        branch: The branch being scanned.

    Returns:
        The resume state, or None to start a fresh walk.

    Raises:
        ValueError: When the cursor exceeded its resume-attempt cap. The cursor is
            cleared first, so a later retry starts clean.
    """
    stored = db.get_repository_scan_cursor(repository_id, branch)
    if not stored:
        return None

    if should_abandon_cursor(stored.get("attempt_count")):
        db.clear_repository_scan_cursor(repository_id, branch)
        raise ValueError(
            "repository scan exceeded its resume attempt cap; "
            f"last error: {stored.get('last_error') or 'unknown'}"
        )

    if is_cursor_expired(stored.get("updated_at")):
        _logger.info(
            "discarding expired repository scan cursor repository_id=%s branch=%s",
            repository_id,
            branch,
        )
        db.clear_repository_scan_cursor(repository_id, branch)
        return None

    cursor = ScanCursor.from_json(stored.get("cursor_json"))
    if cursor is None:
        db.clear_repository_scan_cursor(repository_id, branch)
        return None

    return ResumeState(
        cursor=cursor,
        entries_indexed=int(stored.get("entries_indexed") or 0),
        importable_indexed=int(stored.get("importable_indexed") or 0),
    )


class ScanPass(NamedTuple):
    """Outcome of one scan pass over a branch (REPO-2.5).

    Attributes:
        total_files: Entries indexed for the branch so far (the final total when
            ``completed``).
        importable_count: Importable entries among them.
        completed: True when the branch's walk finished; False when the pass
            stopped on its wall-clock budget and a resume cursor was stored.
        resumed: True when this pass continued a stored cursor rather than
            starting a fresh walk.
    """

    total_files: int
    importable_count: int
    completed: bool
    resumed: bool


def scan_repository_branch_into_index(
    db: Database,
    repo_row: Dict[str, Any],
    branch: str,
    *,
    budget_seconds: Optional[int] = None,
    chunk_size: Optional[int] = None,
) -> ScanPass:
    """Rescan one branch's Git tree into its indexed file rows (REPO-2 / REPO-2.5).

    The shared core of the repository walk: resolve the GitHub owner/repo and a
    linked-account token, walk the branch tree in bounded chunks (with the
    branch-tip recency signals, RAR-2.1), stream every blob into
    ``apiome.tenant_repository_files``, and update the repository's file counts /
    status. Used both by the one-shot scan job
    (``process_next_repository_file_scan_job``) and the periodic auto-refresh sweep
    (RAR-3.2), so the two paths walk the tree identically.

    REPO-2.5 makes the pass bounded and resumable:

    * A fresh walk clears the branch's existing rows first; a resumed walk appends
      to what earlier passes already wrote.
    * The pass runs under the tenant's wall-clock budget. When it runs out, the
      walker's position is stored in ``tenant_repository_scan_cursors``, the
      repository stays in ``scanning``, and ``completed`` comes back False.
    * A transient provider failure stores the same cursor before re-raising, so
      the caller can re-queue rather than discard the work.
    * On completion the cursor row is deleted and the stored counts are re-read
      from the persisted rows (rather than from in-flight counters), so a re-emitted
      chunk cannot inflate them.

    Unlike the job path this raises on any error rather than recording job/repo
    failure state; the caller owns failure bookkeeping.

    Args:
        db: Database handle.
        repo_row: A ``tenant_repositories`` row (must include ``id``,
            ``tenant_id``, ``provider``, ``visibility`` and the GitHub locators;
            ``linked_account_id`` / ``created_by`` are used for private repos).
        branch: The branch to rescan.
        budget_seconds: Overrides the tenant's configured wall-clock budget for
            this pass. None reads ``tenants.repository_scan_budget_seconds``.
        chunk_size: Overrides the streaming chunk size; always capped at 1000.

    Returns:
        A :class:`ScanPass` describing this pass.

    Raises:
        ValueError: For an unsupported provider, an unresolvable owner/repo, a
            private repository with no token, an exhausted resume-attempt cap, or
            a fatal GitHub API error.
        TransientScanError: When a retryable provider failure interrupted the pass.
            A resume cursor has already been stored.
    """
    from .config import settings

    tenant_id = str(repo_row["tenant_id"])
    repository_id = str(repo_row["id"])

    provider = str(repo_row.get("provider") or "").lower()
    if provider != "github":
        raise ValueError(f"file scan not implemented for provider: {provider}")

    owner, repo = _github_owner_repo(repo_row)
    token = _resolve_scan_token(db, repo_row)

    resume = _load_resume_state(db, repository_id, branch)
    resumed = resume is not None
    if resume is not None:
        cursor: Optional[ScanCursor] = resume.cursor
        entries = resume.entries_indexed
        importable = resume.importable_indexed
    else:
        # A fresh walk owns the branch's index; drop the previous snapshot first.
        cursor = None
        db.delete_tenant_repository_files(repository_id, branch)
        entries = 0
        importable = 0

    configured = budget_seconds
    if configured is None:
        configured = db.get_tenant_repository_scan_budget_seconds(tenant_id)
    budget = ScanBudget(
        resolve_scan_budget_seconds(
            configured,
            default_seconds=settings.repository_scan_budget_seconds,
            floor_seconds=settings.repository_scan_budget_min_seconds,
            ceiling_seconds=settings.repository_scan_budget_max_seconds,
        )
    )
    limit = resolve_chunk_size(
        chunk_size if chunk_size is not None else settings.repository_scan_chunk_size
    )

    counts = {"entries": entries, "importable": importable}

    def _sink(chunk: Sequence[Dict[str, Any]]) -> None:
        """Persist one chunk and advance the running counters."""
        db.append_tenant_repository_files(repository_id, branch, chunk)
        counts["entries"] += len(chunk)
        counts["importable"] += sum(
            1 for e in chunk if _importable_hint(e.get("detected_kind"), str(e.get("path") or ""))
        )

    def _store_cursor(state: Optional[ScanCursor], error: Optional[str]) -> None:
        """Persist the walker position and leave the repository in ``scanning``."""
        if state is None:
            return
        db.save_repository_scan_cursor(
            repository_id,
            branch,
            cursor_json=state.to_json(),
            entries_indexed=counts["entries"],
            importable_indexed=counts["importable"],
            last_error=error,
        )
        db.update_tenant_repository_after_file_scan(
            tenant_id=tenant_id,
            repository_id=repository_id,
            total_files=counts["entries"],
            importable_count=counts["importable"],
            status="scanning",
            touch_last_scanned_at=False,
        )

    try:
        outcome = walk_github_tree_in_chunks(
            owner,
            repo,
            branch,
            token,
            on_chunk=_sink,
            cursor=cursor,
            budget=budget,
            chunk_size=limit,
        )
    except TransientScanError as exc:
        _store_cursor(exc.cursor, str(exc)[:2000])
        raise

    if not outcome.completed:
        _store_cursor(outcome.cursor, None)
        _logger.info(
            "repository scan paused on its wall-clock budget repository_id=%s branch=%s "
            "budget_seconds=%s entries=%s",
            repository_id,
            branch,
            budget.seconds,
            counts["entries"],
        )
        return ScanPass(counts["entries"], counts["importable"], False, resumed)

    db.clear_repository_scan_cursor(repository_id, branch)
    total_files, importable_count = db.count_tenant_repository_files(repository_id, branch)
    db.update_tenant_repository_after_file_scan(
        tenant_id=tenant_id,
        repository_id=repository_id,
        total_files=total_files,
        importable_count=importable_count,
        status="ready",
        touch_last_scanned_at=True,
    )
    return ScanPass(total_files, importable_count, True, resumed)


def _branch_owns_repository_status(repo_row: Optional[Dict[str, Any]], branch: str) -> bool:
    """Whether a failed scan of ``branch`` should mark the whole repository errored.

    A repository's ``status`` / ``total_files`` / ``importable_count`` describe its *default*
    branch — that is what registration scans and what the dashboard shows. A side branch is a
    different question, and since REPO-4.3 the scan queue also carries genuinely ephemeral
    branches: a pull-request head that a merge-and-delete removes between the delivery and the
    walk. Letting that vanished branch flip a healthy repository to ``error`` and zero its file
    counts would be a lie about the repository.

    Unknown default branch (a row we could not read, or a caller that supplies a partial row)
    resolves to ``True``, preserving the pre-REPO-4.3 behaviour: when in doubt, surface the
    failure.

    Args:
        repo_row: The ``tenant_repositories`` row, when it could be read.
        branch: The branch whose scan failed.

    Returns:
        True when the failure should be reflected in the repository's own status.
    """
    if not repo_row:
        return True
    default_branch = str(repo_row.get("default_branch") or "").strip()
    if not default_branch:
        return True
    return branch == default_branch


def _fail_job_and_repo(
    db: Database,
    tenant_id: str,
    repository_id: str,
    job_id: str,
    message: str,
    *,
    fail_repository: bool = True,
) -> None:
    """Mark a scan job failed, and the repository with it when the branch owns its status.

    Args:
        db: Database handle.
        tenant_id: Owning tenant id.
        repository_id: The repository whose scan failed.
        job_id: The failed job.
        message: Short diagnostic recorded on the job.
        fail_repository: When False only the job is failed — see
            :func:`_branch_owns_repository_status`.
    """
    db.mark_repository_file_scan_job_failed(job_id, message)
    if not fail_repository:
        return
    db.update_tenant_repository_after_file_scan(
        tenant_id=tenant_id,
        repository_id=repository_id,
        total_files=0,
        importable_count=0,
        status="error",
        touch_last_scanned_at=True,
    )


def process_next_repository_file_scan_job(db: Database) -> int:
    """Claim and run at most one queued file-scan job.

    A pass that stops early does not fail the job. When the walk paused on its
    wall-clock budget, or when a transient provider failure left a stored resume
    cursor behind (REPO-2.5), the job goes back to ``queued`` and the next sweep
    tick resumes it from that cursor. Only a fatal error — or a transient failure
    that produced no cursor to resume from — marks the job failed.

    Whether that failure also marks the *repository* failed depends on the branch
    (:func:`_branch_owns_repository_status`): the repository's status describes its
    default branch, so a side branch — including the ephemeral pull-request heads
    REPO-4.3 queues — fails its own job without zeroing the repository's counts.

    Args:
        db: Database handle for this tick.

    Returns:
        1 if a job ran, 0 if the queue was empty.
    """
    job = db.claim_next_repository_file_scan_job()
    if not job:
        return 0

    job_id = str(job["id"])
    tenant_id = str(job["tenant_id"])
    repository_id = str(job["repository_id"])
    branch = str(job["branch"])
    repo_row: Optional[Dict[str, Any]] = None

    try:
        repo_row = db.get_tenant_repository(tenant_id, repository_id)
        if not repo_row:
            db.mark_repository_file_scan_job_failed(job_id, "repository row missing")
            return 1

        # Unsupported provider / private-without-token / fatal GitHub errors all
        # raise ValueError from the shared walker; retryable ones raise
        # TransientScanError. Both are recorded by the handlers below.
        result = scan_repository_branch_into_index(db, repo_row, branch)
        if result.completed:
            db.mark_repository_file_scan_job_succeeded(job_id)
            _logger.info(
                "repository file scan succeeded repository_id=%s branch=%s files=%s "
                "importable_hints=%s resumed=%s",
                repository_id,
                branch,
                result.total_files,
                result.importable_count,
                result.resumed,
            )
        else:
            db.requeue_repository_file_scan_job(
                job_id,
                "scan paused on its wall-clock budget; resuming from the stored cursor",
            )
            _logger.info(
                "repository file scan paused, re-queued for resume job_id=%s repository_id=%s "
                "branch=%s files_so_far=%s",
                job_id,
                repository_id,
                branch,
                result.total_files,
            )
    except TransientScanError as exc:
        msg = str(exc) or type(exc).__name__
        if db.get_repository_scan_cursor(repository_id, branch):
            # Resumable: keep the partial index and let the next tick continue.
            db.requeue_repository_file_scan_job(job_id, msg[:2000])
            _logger.warning(
                "repository file scan interrupted, re-queued for resume job_id=%s: %s",
                job_id,
                msg,
            )
        else:
            # Nothing to resume from (the failure preceded any progress); fail so a
            # permanently broken repository cannot re-queue itself forever.
            _logger.exception("repository file scan failed job_id=%s", job_id)
            _fail_job_and_repo(
                db,
                tenant_id,
                repository_id,
                job_id,
                msg[:2000],
                fail_repository=_branch_owns_repository_status(repo_row, branch),
            )
    except Exception as exc:
        _logger.exception("repository file scan failed job_id=%s", job_id)
        msg = str(exc) if str(exc) else type(exc).__name__
        _fail_job_and_repo(
            db,
            tenant_id,
            repository_id,
            job_id,
            msg[:2000],
            fail_repository=_branch_owns_repository_status(repo_row, branch),
        )
    return 1
