"""
Background processing for tenant_repository_file_scan_jobs.

Fetches the default-branch Git tree from GitHub (public or via linked-account token),
persists paths to apiome.tenant_repository_files, then marks the repository ready.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import httpx

from .database import Database
from .repository_validation import parse_github_owner_repo_from_url, parse_owner_repo_slash

_logger = logging.getLogger(__name__)

UA = "Apiome-RepositoryFileScan/1.0"
_HTTP_TIMEOUT = httpx.Timeout(90.0, connect=20.0)


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


def fetch_github_tree_blobs(owner: str, repo: str, branch: str, access_token: Optional[str]) -> List[Dict[str, Any]]:
    headers: Dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"

    owner_q = quote(owner, safe="")
    repo_q = quote(repo, safe="")
    branch_q = quote(branch, safe="")

    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        br = client.get(
            f"https://api.github.com/repos/{owner_q}/{repo_q}/branches/{branch_q}",
            headers=headers,
        )
        if br.status_code == 404:
            raise ValueError(f"GitHub branch not found: {branch}")
        if br.status_code != 200:
            raise ValueError(f"GitHub branches API error: HTTP {br.status_code}")
        bj = br.json()
        tip = bj.get("commit") if isinstance(bj.get("commit"), dict) else {}
        inner = tip.get("commit") if isinstance(tip.get("commit"), dict) else {}
        tree_obj = inner.get("tree") if isinstance(inner.get("tree"), dict) else None
        tree_sha = tree_obj.get("sha") if tree_obj else None
        if not tree_sha:
            raise ValueError("GitHub response missing tree sha for branch")

        # Branch tip commit recency (RAR-2.1): the branch API already returns the
        # tip commit SHA and its committed-at date; capture them here so the scan
        # can stamp every indexed file with a comparable "newer-than" anchor.
        # Granularity is branch-tip (one value per scan), which the newer-than
        # comparator (RAR-2.2) pairs with content-checksum idempotency.
        tip_commit_sha = str(tip.get("sha") or "")[:64] or None
        committer = inner.get("committer") if isinstance(inner.get("committer"), dict) else {}
        tip_committed_at = (committer.get("date") or "").strip() or None

        tr = client.get(
            f"https://api.github.com/repos/{owner_q}/{repo_q}/git/trees/{tree_sha}?recursive=1",
            headers=headers,
        )
        if tr.status_code != 200:
            raise ValueError(f"GitHub tree API error: HTTP {tr.status_code}")
        tj = tr.json()
        if tj.get("truncated"):
            raise ValueError("GitHub tree response truncated; repository too large for this scan pass")

        out: List[Dict[str, Any]] = []
        for e in tj.get("tree") or []:
            if not isinstance(e, dict):
                continue
            if e.get("type") != "blob":
                continue
            path = str(e.get("path") or "")
            if not path:
                continue
            name = path.rsplit("/", 1)[-1]
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            if len(ext) > 64:
                ext = ext[:64]
            raw_sz = e.get("size")
            size_i: Optional[int] = None
            if isinstance(raw_sz, int):
                size_i = raw_sz
            elif isinstance(raw_sz, float) and raw_sz == int(raw_sz):
                size_i = int(raw_sz)
            elif isinstance(raw_sz, str) and raw_sz.isdigit():
                size_i = int(raw_sz)
            sha = str(e.get("sha") or "")[:64] or None
            kind = detected_kind_from_path(path)
            out.append(
                {
                    "path": path,
                    "name": name[:512] if len(name) > 512 else name,
                    "ext": ext or None,
                    "size_bytes": size_i,
                    "blob_sha": sha,
                    "detected_kind": kind,
                    "commit_sha": tip_commit_sha,
                    "committed_at": tip_committed_at,
                }
            )
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


def scan_repository_branch_into_index(
    db: Database, repo_row: Dict[str, Any], branch: str
) -> Tuple[int, int]:
    """Rescan one branch's Git tree and replace its indexed file rows (REPO-2 walker).

    The shared core of the repository walk: resolve the GitHub owner/repo and a
    linked-account token, fetch the branch tree (with the branch-tip recency
    signals, RAR-2.1), persist every blob to ``apiome.tenant_repository_files``, and
    update the repository's file counts / status. Used both by the one-shot scan
    job (``process_next_repository_file_scan_job``) and the periodic auto-refresh
    sweep (RAR-3.2), so the two paths walk the tree identically.

    Unlike the job path this raises on any error rather than recording job/repo
    failure state; the caller owns failure bookkeeping.

    Args:
        db: Database handle.
        repo_row: A ``tenant_repositories`` row (must include ``id``,
            ``tenant_id``, ``provider``, ``visibility`` and the GitHub locators;
            ``linked_account_id`` / ``created_by`` are used for private repos).
        branch: The branch to rescan.

    Returns:
        ``(total_files, importable_count)`` for the rescanned branch.

    Raises:
        ValueError: For an unsupported provider, an unresolvable owner/repo, a
            private repository with no token, or a GitHub API error.
    """
    tenant_id = str(repo_row["tenant_id"])
    repository_id = str(repo_row["id"])

    provider = str(repo_row.get("provider") or "").lower()
    if provider != "github":
        raise ValueError(f"file scan not implemented for provider: {provider}")

    owner, repo = _github_owner_repo(repo_row)

    token: Optional[str] = None
    linked = repo_row.get("linked_account_id")
    created_by = repo_row.get("created_by")
    if linked and created_by:
        oauth = db.get_external_auth_provider_for_user(str(linked), str(created_by))
        if oauth and oauth.get("access_token"):
            token = str(oauth["access_token"])

    vis = str(repo_row.get("visibility") or "").lower()
    if vis == "private" and not token:
        raise ValueError("private repository requires a linked account token")

    blobs = fetch_github_tree_blobs(owner, repo, branch, token)
    importable = sum(
        1 for b in blobs if _importable_hint(b.get("detected_kind"), str(b.get("path") or ""))
    )

    db.replace_tenant_repository_files(repository_id, branch, blobs)
    db.update_tenant_repository_after_file_scan(
        tenant_id=tenant_id,
        repository_id=repository_id,
        total_files=len(blobs),
        importable_count=importable,
        status="ready",
        touch_last_scanned_at=True,
    )
    return len(blobs), importable


def _fail_job_and_repo(db: Database, tenant_id: str, repository_id: str, job_id: str, message: str) -> None:
    db.mark_repository_file_scan_job_failed(job_id, message)
    db.update_tenant_repository_after_file_scan(
        tenant_id=tenant_id,
        repository_id=repository_id,
        total_files=0,
        importable_count=0,
        status="error",
        touch_last_scanned_at=True,
    )


def process_next_repository_file_scan_job(db: Database) -> int:
    """
    Claim and run at most one queued file-scan job. Returns 1 if a job ran, 0 if none.
    """
    job = db.claim_next_repository_file_scan_job()
    if not job:
        return 0

    job_id = str(job["id"])
    tenant_id = str(job["tenant_id"])
    repository_id = str(job["repository_id"])
    branch = str(job["branch"])

    try:
        repo_row = db.get_tenant_repository(tenant_id, repository_id)
        if not repo_row:
            db.mark_repository_file_scan_job_failed(job_id, "repository row missing")
            return 1

        # Unsupported provider / private-without-token / GitHub errors all raise
        # ValueError from the shared walker and are recorded by the except below.
        total, importable = scan_repository_branch_into_index(db, repo_row, branch)
        db.mark_repository_file_scan_job_succeeded(job_id)
        _logger.info(
            "repository file scan succeeded repository_id=%s branch=%s files=%s importable_hints=%s",
            repository_id,
            branch,
            total,
            importable,
        )
    except Exception as exc:
        _logger.exception("repository file scan failed job_id=%s", job_id)
        msg = str(exc) if str(exc) else type(exc).__name__
        _fail_job_and_repo(db, tenant_id, repository_id, job_id, msg[:2000])
    return 1
