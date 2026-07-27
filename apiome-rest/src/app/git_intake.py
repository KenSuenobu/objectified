"""Git-repository intake for registry adapters — MFI-29.3 (#4390).

The legacy git source card fetches **one** file and feeds it to the OpenAPI-family
importer. CI-adjacent teams want the other shape: *"import ``protos/**`` from this
repo at this ref"* — a whole directory of ``.proto`` / ``.graphql`` / AsyncAPI
documents compiled together.

This module is that intake. Given a repository URL, a ref (branch / tag / commit),
and a path or glob, it:

1. resolves the ref to an immutable **commit sha** (the provenance anchor),
2. lists the commit's tree and selects the members matching the path/glob,
3. downloads each selected blob under the same sandbox budget archive intake uses
   (:class:`~app.archive_intake.ArchivePolicy`),
4. resolves the root document with the shared
   :func:`~app.archive_intake.resolve_fileset_root` rules, and
5. packs the selection into a deterministic zip.

That last step is deliberate: the packed zip is exactly what MFI-29.1 archive intake
already accepts, so the whole downstream chain — pre-flight, preview manifest,
quality gate, ``run_adapter_import_job`` → :meth:`ImportSource.parse_fileset` (29.2),
catalog persistence — runs unmodified. Git intake adds a *source*, not a second
pipeline.

Network access is confined to :class:`GitHubApiClient` and reached only through the
:class:`GitRepositoryClient` protocol, so tests inject a fake tree instead of
mocking HTTP. Only ``github.com`` is supported today (the provider the existing git
plumbing speaks); another host raises ``SOURCE_PROVIDER_UNSUPPORTED`` rather than
silently degrading.

Credentials are never accepted from the request: the caller resolves a token from
stored linked-account credentials (see
:func:`app.git_import_routes.resolve_stored_git_token`) and passes it here.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Protocol, Sequence, Tuple
from urllib.parse import quote

import httpx

from .archive_intake import (
    ArchiveIntakeError,
    ArchivePolicy,
    archive_policy_from_settings,
    resolve_fileset_root,
)
from .format_detection import FormatDetection
from .intake_paths import IntakePathError, normalised_member_name, validated_intake_path
from .repository_validation import parse_github_owner_repo_from_url

__all__ = [
    "GIT_INTAKE_KIND",
    "GitBlob",
    "GitCommitRef",
    "GitFilesetResult",
    "GitHubApiClient",
    "GitIntakeError",
    "GitProvenance",
    "GitRepositoryClient",
    "GitSelector",
    "GitSkippedMember",
    "fetch_git_fileset",
    "git_provenance_metadata",
    "matches_git_path",
    "pack_fileset_zip",
    "selection_prefix",
]

#: ``format_metadata.intakeKind`` recorded for a git-sourced revision.
GIT_INTAKE_KIND = "git"

#: Provider key recorded on provenance. Only GitHub is wired today.
GITHUB_PROVIDER = "github"

_UA = "Apiome-GitIntake/1.0"
_HTTP_TIMEOUT = httpx.Timeout(60.0, connect=20.0)
_GITHUB_API = "https://api.github.com"

#: Extensions never worth downloading as spec text (images, binaries, archives).
#: A curated archive upload contains what the user chose; a repository directory
#: also contains logos and fonts, so these are skipped (and reported) rather than
#: failing the whole selection.
_BINARY_SUFFIXES: Tuple[str, ...] = (
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svgz",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".jar", ".war",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".so", ".dylib", ".dll", ".exe", ".class", ".pyc", ".wasm",
    ".mp3", ".mp4", ".mov", ".avi", ".webm",
)

#: Path segments never ingested from a repository tree (VCS/tooling noise).
_SKIP_SEGMENTS: Tuple[str, ...] = (".git", ".github", "node_modules", "vendor", "__pycache__")

#: Glob metacharacters that make a selection a pattern rather than a literal path.
_GLOB_META = ("*", "?", "[")


class GitIntakeError(ValueError):
    """A repository selection could not be fetched or resolved.

    Attributes:
        code: Intake-taxonomy code (``SOURCE_NOT_FOUND``, ``SOURCE_UNREACHABLE``,
            ``SOURCE_AUTH_REQUIRED``, ``SOURCE_SELECTION_EMPTY``,
            ``SOURCE_PROVIDER_UNSUPPORTED``, or a resource/input code inherited
            from the shared fileset rules).
    """

    def __init__(self, message: str, *, code: str = "SOURCE_UNREACHABLE") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class GitSelector:
    """What to import from a repository.

    Attributes:
        repo_url: Repository URL (``https://github.com/owner/repo``).
        ref: Branch, tag, or commit sha. ``None`` uses the repository's default branch.
        path: Directory prefix, exact file path, or glob (``protos/**``,
            ``**/*.proto``). Empty selects the whole tree.
        root: Optional explicit root document, relative to the selection (see
            :func:`selection_prefix`). Resolved automatically when omitted.
    """

    repo_url: str
    ref: Optional[str] = None
    path: str = ""
    root: Optional[str] = None


@dataclass(frozen=True)
class GitProvenance:
    """Immutable record of *where* an imported fileset came from.

    ``commit_sha`` — not the ref — is the anchor: a branch moves, a commit does not,
    so this is what a later re-import-on-change comparison (EPIC-31) diffs against.
    """

    provider: str
    repo_url: str
    owner: str
    repo: str
    ref: str
    commit_sha: str
    path: str
    browse_url: str

    def as_dict(self) -> Dict[str, str]:
        """Return the provenance as a plain JSON-serializable mapping."""
        return {
            "provider": self.provider,
            "repo_url": self.repo_url,
            "owner": self.owner,
            "repo": self.repo,
            "ref": self.ref,
            "commit_sha": self.commit_sha,
            "path": self.path,
            "browse_url": self.browse_url,
        }


@dataclass(frozen=True)
class GitBlob:
    """One file entry in a repository tree listing."""

    path: str
    size: int


@dataclass(frozen=True)
class GitCommitRef:
    """A ref resolved to the commit it points at."""

    ref: str
    commit_sha: str


@dataclass(frozen=True)
class GitSkippedMember:
    """A tree entry that was deliberately not ingested, and why."""

    path: str
    reason: str


@dataclass(frozen=True)
class GitFilesetResult:
    """The fetched selection, ready to hand to the archive/fileset pipeline.

    Attributes:
        members: Selected files keyed by **selection-relative** path (the static
            prefix of the selector's path is stripped, so ``protos/`` selections
            keep proto ``import`` paths resolvable).
        root_path: The resolved root document, a key of ``members``.
        detection: Format detection for the root document.
        provenance: Repository, ref, and resolved commit.
        skipped: Tree entries excluded from the selection, each with a reason.
        ambiguous_roots: Runner-up root candidates, when detection had to choose.
    """

    members: Dict[str, str]
    root_path: str
    detection: FormatDetection
    provenance: GitProvenance
    skipped: Tuple[GitSkippedMember, ...] = ()
    ambiguous_roots: Tuple[str, ...] = ()

    def total_bytes(self) -> int:
        """Return the decoded size of every member, in bytes."""
        return sum(len(text.encode("utf-8", errors="replace")) for text in self.members.values())


class GitRepositoryClient(Protocol):
    """The network boundary git intake speaks to (one implementation per provider)."""

    def resolve_ref(self, owner: str, repo: str, ref: Optional[str]) -> GitCommitRef:
        """Resolve a branch/tag/sha (or the default branch) to a commit."""

    def list_tree(self, owner: str, repo: str, commit_sha: str) -> Sequence[GitBlob]:
        """List every file blob reachable from *commit_sha*."""

    def read_file(
        self, owner: str, repo: str, path: str, commit_sha: str, *, max_bytes: int
    ) -> str:
        """Read one file's text at *commit_sha*, capped at *max_bytes*."""


def _github_error(status_code: int, *, rate_limited: bool, what: str) -> GitIntakeError:
    """Map a GitHub API status onto a taxonomy-coded intake error."""
    if status_code == 404:
        return GitIntakeError(
            f"{what} was not found (check the repository URL, the ref, and your access).",
            code="SOURCE_NOT_FOUND",
        )
    if status_code in (401, 403):
        if rate_limited:
            return GitIntakeError(
                f"GitHub rate-limited the request while reading {what}.",
                code="SOURCE_UNREACHABLE",
            )
        return GitIntakeError(
            f"{what} requires authorization (link a GitHub account with access to it).",
            code="SOURCE_AUTH_REQUIRED",
        )
    return GitIntakeError(
        f"GitHub returned HTTP {status_code} while reading {what}.",
        code="SOURCE_UNREACHABLE",
    )


class GitHubApiClient:
    """:class:`GitRepositoryClient` backed by the GitHub REST API.

    Uses the same "shallow fetch" plumbing the repository store already uses — the
    commit, tree, and contents endpoints — rather than shelling out to ``git``, so no
    subprocess or working copy is involved.

    Args:
        access_token: Stored linked-account token, or ``None`` for public reads.
        timeout: HTTP timeout; the module default when omitted.
    """

    def __init__(
        self,
        access_token: Optional[str] = None,
        *,
        timeout: Optional[httpx.Timeout] = None,
    ) -> None:
        self._token = access_token
        self._timeout = timeout or _HTTP_TIMEOUT

    def _headers(self) -> Dict[str, str]:
        headers = {
            "User-Agent": _UA,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _get(self, url: str, *, what: str, accept: Optional[str] = None) -> httpx.Response:
        headers = self._headers()
        if accept:
            headers["Accept"] = accept
        try:
            with httpx.Client(timeout=self._timeout) as client:
                response = client.get(url, headers=headers, follow_redirects=True)
        except httpx.HTTPError as exc:
            raise GitIntakeError(
                f"Could not reach GitHub while reading {what}: {exc}",
                code="SOURCE_UNREACHABLE",
            ) from exc
        if response.status_code != 200:
            rate_limited = response.headers.get("x-ratelimit-remaining") == "0"
            raise _github_error(response.status_code, rate_limited=rate_limited, what=what)
        return response

    def resolve_ref(self, owner: str, repo: str, ref: Optional[str]) -> GitCommitRef:
        """Resolve *ref* (or the repository's default branch) to its commit sha."""
        owner_q, repo_q = quote(owner, safe=""), quote(repo, safe="")
        chosen = (ref or "").strip()
        if not chosen:
            repo_response = self._get(
                f"{_GITHUB_API}/repos/{owner_q}/{repo_q}",
                what=f"repository {owner}/{repo}",
            )
            chosen = str((repo_response.json() or {}).get("default_branch") or "").strip()
            if not chosen:
                raise GitIntakeError(
                    f"Repository {owner}/{repo} reports no default branch; name a ref explicitly.",
                    code="SOURCE_NOT_FOUND",
                )
        commit_response = self._get(
            f"{_GITHUB_API}/repos/{owner_q}/{repo_q}/commits/{quote(chosen, safe='')}",
            what=f"ref {chosen!r} of {owner}/{repo}",
        )
        sha = str((commit_response.json() or {}).get("sha") or "").strip()
        if not sha:
            raise GitIntakeError(
                f"GitHub did not return a commit for ref {chosen!r}.",
                code="SOURCE_NOT_FOUND",
            )
        return GitCommitRef(ref=chosen, commit_sha=sha)

    def list_tree(self, owner: str, repo: str, commit_sha: str) -> Sequence[GitBlob]:
        """List every blob reachable from *commit_sha* (recursive tree read)."""
        owner_q, repo_q = quote(owner, safe=""), quote(repo, safe="")
        response = self._get(
            f"{_GITHUB_API}/repos/{owner_q}/{repo_q}/git/trees/"
            f"{quote(commit_sha, safe='')}?recursive=1",
            what=f"tree of {owner}/{repo}@{commit_sha[:7]}",
        )
        body = response.json() or {}
        if body.get("truncated"):
            raise GitIntakeError(
                "The repository tree is too large to enumerate in one request. "
                "Import a narrower path (for example 'protos/') instead of the whole repository.",
                code="INPUT_TOO_LARGE",
            )
        blobs: List[GitBlob] = []
        for entry in body.get("tree") or []:
            if not isinstance(entry, dict) or entry.get("type") != "blob":
                continue
            path = str(entry.get("path") or "").strip()
            if not path:
                continue
            try:
                size = int(entry.get("size") or 0)
            except (TypeError, ValueError):
                size = 0
            blobs.append(GitBlob(path=path, size=size))
        return blobs

    def read_file(
        self, owner: str, repo: str, path: str, commit_sha: str, *, max_bytes: int
    ) -> str:
        """Read one file's text at *commit_sha*, capped at *max_bytes* bytes.

        Streamed rather than buffered: the tree's declared size already filtered the
        obvious cases, but a declared size is the *server's* claim, so the read stops
        one byte past the limit instead of materializing whatever arrives.
        """
        owner_q, repo_q = quote(owner, safe=""), quote(repo, safe="")
        path_q = quote(path.strip().replace("\\", "/").lstrip("/"), safe="/")
        url = (
            f"{_GITHUB_API}/repos/{owner_q}/{repo_q}/contents/{path_q}"
            f"?ref={quote(commit_sha, safe='')}"
        )
        headers = self._headers()
        headers["Accept"] = "application/vnd.github.raw"
        what = f"file {path!r}"
        ceiling = max_bytes + 1
        chunks: List[bytes] = []
        total = 0
        try:
            with httpx.Client(timeout=self._timeout) as client:
                with client.stream(
                    "GET", url, headers=headers, follow_redirects=True
                ) as response:
                    if response.status_code != 200:
                        response.read()
                        rate_limited = response.headers.get("x-ratelimit-remaining") == "0"
                        raise _github_error(
                            response.status_code, rate_limited=rate_limited, what=what
                        )
                    for chunk in response.iter_bytes():
                        if not chunk:
                            continue
                        chunks.append(chunk)
                        total += len(chunk)
                        if total >= ceiling:
                            break
        except httpx.HTTPError as exc:
            raise GitIntakeError(
                f"Could not reach GitHub while reading {what}: {exc}",
                code="SOURCE_UNREACHABLE",
            ) from exc
        if total > max_bytes:
            raise GitIntakeError(
                f"Repository file {path!r} exceeds the {max_bytes}-byte per-file limit.",
                code="INPUT_TOO_LARGE",
            )
        return b"".join(chunks).decode("utf-8", errors="replace")


def _is_glob(pattern: str) -> bool:
    """Return whether *pattern* contains glob metacharacters."""
    return any(meta in pattern for meta in _GLOB_META)


def _normalise_selection(path: str) -> str:
    """Normalise a selector path to POSIX form with no leading/trailing slashes."""
    return path.strip().replace("\\", "/").strip("/")


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Compile a POSIX-style glob into a full-match regex.

    Supports ``**`` (any number of path segments), ``*`` (within one segment),
    ``?`` (one character within a segment), and ``[...]`` character classes.

    Args:
        pattern: The glob, already normalised by :func:`_normalise_selection`.

    Returns:
        A compiled pattern that full-matches repository-relative paths.
    """
    out: List[str] = []
    index = 0
    length = len(pattern)
    while index < length:
        char = pattern[index]
        if char == "*":
            if pattern.startswith("**", index):
                index += 2
                if pattern.startswith("/", index):
                    index += 1
                    out.append("(?:.*/)?")
                else:
                    out.append(".*")
                continue
            out.append("[^/]*")
            index += 1
            continue
        if char == "?":
            out.append("[^/]")
            index += 1
            continue
        if char == "[":
            close = pattern.find("]", index + 1)
            if close != -1:
                body = pattern[index + 1 : close].replace("\\", "\\\\")
                if body.startswith("!"):
                    body = "^" + body[1:]
                out.append(f"[{body}]")
                index = close + 1
                continue
        out.append(re.escape(char))
        index += 1
    return re.compile("".join(out) + r"\Z")


def matches_git_path(path: str, pattern: str) -> bool:
    """Return whether a repository-relative *path* is selected by *pattern*.

    Selection rules, in the order a user expects them:

    * empty pattern — everything;
    * exact file path — only that file;
    * directory prefix — everything beneath it;
    * glob — ``**`` crosses directory boundaries, ``*``/``?`` do not.

    Args:
        path: Repository-relative path of a tree blob.
        pattern: The selector's ``path``.

    Returns:
        True when the blob belongs to the selection.
    """
    normalised_path = _normalise_selection(path)
    normalised_pattern = _normalise_selection(pattern)
    if not normalised_pattern:
        return True
    if _is_glob(normalised_pattern):
        return bool(_glob_to_regex(normalised_pattern).match(normalised_path))
    if normalised_path == normalised_pattern:
        return True
    return normalised_path.startswith(f"{normalised_pattern}/")


def selection_prefix(pattern: str, *, exact_file: bool = False) -> str:
    """Return the static directory prefix stripped from selected member paths.

    ``protos/`` and ``protos/**`` both anchor at ``protos/``, so a member's key
    becomes ``user/user_service.proto`` — the path its siblings ``import``. A
    pattern with no static directory part (``**/*.proto``) strips nothing, and an
    exact file selection strips its directory so the file lands at the root.

    Args:
        pattern: The selector's ``path``.
        exact_file: Whether *pattern* names one existing file rather than a
            directory. The caller knows this from the tree listing; guessing from the
            path (say, "it has a dot") would mis-anchor a directory named ``v1.0``.

    Returns:
        The prefix including its trailing slash, or ``""`` when nothing is stripped.
    """
    normalised = _normalise_selection(pattern)
    if not normalised:
        return ""
    segments = normalised.split("/")
    static: List[str] = []
    for segment in segments:
        if _is_glob(segment):
            break
        static.append(segment)
    if exact_file and len(static) == len(segments) and static:
        # A fully static selection naming a file anchors at its directory, so the
        # file's own name stays in the member key.
        static = static[:-1]
    if not static:
        return ""
    return "/".join(static) + "/"


def _should_skip_tree_path(path: str) -> Optional[str]:
    """Return a skip reason for a tree path, or ``None`` when it is ingestible."""
    segments = path.split("/")
    if any(segment in _SKIP_SEGMENTS for segment in segments):
        return "excluded-directory"
    base = segments[-1]
    if base.startswith("."):
        return "dotfile"
    lower = base.lower()
    if lower.endswith(_BINARY_SUFFIXES):
        return "binary-file"
    return None


def _validated_member_key(path: str, *, prefix: str, max_depth: int) -> str:
    """Strip the selection prefix from *path* and validate the remainder.

    Raises:
        GitIntakeError: If the resulting member path is unsafe (traversal, absolute,
            or deeper than the policy allows).
    """
    relative = path[len(prefix) :] if prefix and path.startswith(prefix) else path
    try:
        pure = validated_intake_path(relative, max_depth=max_depth, label="Repository file")
    except IntakePathError as exc:
        raise GitIntakeError(str(exc), code="INPUT_UNSAFE_CONSTRUCT") from exc
    return normalised_member_name(pure)


def _browse_url(owner: str, repo: str, commit_sha: str, path: str) -> str:
    """Build the human GitHub URL for the imported selection at its commit."""
    static = _normalise_selection(selection_prefix(path)) or _normalise_selection(path)
    base = f"https://github.com/{owner}/{repo}/tree/{commit_sha}"
    return f"{base}/{static}" if static else base


def fetch_git_fileset(
    selector: GitSelector,
    *,
    access_token: Optional[str] = None,
    policy: Optional[ArchivePolicy] = None,
    client: Optional[GitRepositoryClient] = None,
) -> GitFilesetResult:
    """Fetch a repository selection as a fileset, anchored to an immutable commit.

    Args:
        selector: Repository, ref, path/glob, and optional explicit root.
        access_token: Stored credential for private repositories (never a
            request-supplied secret); ``None`` reads anonymously.
        policy: Sandbox budget; defaults to the archive policy from settings so a
            repository selection can never cost more than an archive upload.
        client: Repository client to use; defaults to :class:`GitHubApiClient`.

    Returns:
        The selected members, resolved root, detection, and commit provenance.

    Raises:
        GitIntakeError: For an unsupported provider, an unreachable/missing
            repository or ref, an empty selection, a budget breach, or a selection
            whose root document has no recognisable format.
    """
    owner_repo = parse_github_owner_repo_from_url(selector.repo_url)
    if not owner_repo:
        raise GitIntakeError(
            "Git intake currently supports github.com repository URLs only "
            "(for example https://github.com/owner/repo).",
            code="SOURCE_PROVIDER_UNSUPPORTED",
        )
    owner, repo = owner_repo
    active = policy or archive_policy_from_settings()
    api = client or GitHubApiClient(access_token)

    commit = api.resolve_ref(owner, repo, selector.ref)
    blobs = api.list_tree(owner, repo, commit.commit_sha)

    # Whether the selection names one existing file decides where members anchor, and
    # only the tree can answer that (a directory may be named "v1.0").
    normalised_selection = _normalise_selection(selector.path)
    exact_file = bool(normalised_selection) and not _is_glob(normalised_selection) and any(
        _normalise_selection(blob.path) == normalised_selection for blob in blobs
    )
    prefix = selection_prefix(selector.path, exact_file=exact_file)
    selected: List[GitBlob] = []
    skipped: List[GitSkippedMember] = []
    for blob in blobs:
        if not matches_git_path(blob.path, selector.path):
            continue
        reason = _should_skip_tree_path(blob.path)
        if reason:
            skipped.append(GitSkippedMember(path=blob.path, reason=reason))
            continue
        if blob.size > active.max_file_bytes:
            skipped.append(GitSkippedMember(path=blob.path, reason="too-large"))
            continue
        selected.append(blob)

    if not selected:
        where = f" matching {selector.path!r}" if selector.path.strip() else ""
        raise GitIntakeError(
            f"No importable files{where} were found in {owner}/{repo} at "
            f"{commit.ref} ({commit.commit_sha[:7]}).",
            code="SOURCE_SELECTION_EMPTY",
        )
    if len(selected) > active.max_entries:
        raise GitIntakeError(
            f"The selection matches {len(selected)} files, over the "
            f"{active.max_entries}-file limit (limit archive_max_entries="
            f"{active.max_entries}). Narrow the path or glob.",
            code="INPUT_TOO_LARGE",
        )

    members: Dict[str, str] = {}
    total = 0
    for blob in sorted(selected, key=lambda item: item.path):
        key = _validated_member_key(blob.path, prefix=prefix, max_depth=active.max_depth)
        if key in members:
            raise GitIntakeError(
                f"Selection maps two repository files onto member {key!r}; "
                "narrow the path so member names stay unique.",
                code="INPUT_ARCHIVE_INVALID",
            )
        text = api.read_file(
            owner, repo, blob.path, commit.commit_sha, max_bytes=active.max_file_bytes
        )
        total += len(text.encode("utf-8", errors="replace"))
        if total > active.max_total_bytes:
            raise GitIntakeError(
                f"The selection exceeds the {active.max_total_bytes}-byte intake limit "
                f"(limit archive_max_total_bytes={active.max_total_bytes}). "
                "Narrow the path or glob.",
                code="INPUT_TOO_LARGE",
            )
        members[key] = text

    where = f" ({owner}/{repo}@{commit.ref})"
    try:
        root, detection, ambiguous = resolve_fileset_root(
            members,
            explicit_root=selector.root,
            where=where,
            label="Repository selection",
        )
    except ArchiveIntakeError as exc:
        raise GitIntakeError(str(exc), code=getattr(exc, "code", "INPUT_ARCHIVE_INVALID")) from exc

    provenance = GitProvenance(
        provider=GITHUB_PROVIDER,
        repo_url=f"https://github.com/{owner}/{repo}",
        owner=owner,
        repo=repo,
        ref=commit.ref,
        commit_sha=commit.commit_sha,
        path=_normalise_selection(selector.path),
        browse_url=_browse_url(owner, repo, commit.commit_sha, selector.path),
    )
    return GitFilesetResult(
        members=members,
        root_path=root,
        detection=detection,
        provenance=provenance,
        skipped=tuple(skipped),
        ambiguous_roots=ambiguous,
    )


def pack_fileset_zip(members: Mapping[str, str]) -> bytes:
    """Pack fileset members into a deterministic zip archive.

    The bytes are the intake payload for the existing archive path, and they are
    also stored verbatim as the revision's source, so two imports of the same
    commit must produce identical bytes: members are written in sorted order with a
    pinned timestamp (zip entries otherwise embed the current time).

    Args:
        members: Member text keyed by module-relative path.

    Returns:
        The zip archive bytes.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(members):
            info = zipfile.ZipInfo(filename=name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, members[name].encode("utf-8"))
    return buffer.getvalue()


def git_provenance_metadata(source: Mapping[str, object]) -> Dict[str, object]:
    """Build the ``format_metadata`` provenance fields for a git-sourced revision.

    Recorded so the catalog can answer "which repo, which commit?" without a second
    lookup, and so a later re-import-on-change (EPIC-31) has the commit to diff from.
    Only non-empty values are written, and ``intakeKind`` is set to ``git`` so the
    revision is not mistaken for a plain archive upload.

    Args:
        source: The job's ``options.git_source`` mapping (repo_url / ref /
            commit_sha / path / browse_url / provider).

    Returns:
        Fields to merge into the revision's ``format_metadata``.
    """
    fields: Dict[str, object] = {"intakeKind": GIT_INTAKE_KIND}
    mapping = {
        "gitProvider": "provider",
        "gitRepoUrl": "repo_url",
        "gitRef": "ref",
        "gitCommit": "commit_sha",
        "gitPath": "path",
    }
    for target, key in mapping.items():
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            fields[target] = value.strip()
    browse = source.get("browse_url")
    if isinstance(browse, str) and browse.strip():
        fields["sourceUri"] = browse.strip()
    return fields
