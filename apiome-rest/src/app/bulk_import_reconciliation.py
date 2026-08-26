"""Batch reconciliation: match each planned item to an existing project (BLK-1.2, #5524).

``POST …/import/bulk/plan`` (MFI-29.5) partitions a repository selection or an archive into
independent items and describes each one — root path, members, detected format, suggested
identity, predicted destination. What it never asked is the question that decides the whole
batch: **does a project for this spec already exist?** Every item was described as if the
tenant were empty, so a ``specs/`` folder re-imported after a change looked identical to a
first-time import, and there was nothing for a user to verify and nothing for an apply step
to act on.

This module is that missing answer. It is the reconciliation half of the plan:

.. code-block:: text

    item ──► match a project ──► apply the policy ──► resolution + proposed version

Matching
--------
:class:`ProjectReconciler` resolves a candidate project in the precedence order the ticket
specifies, stopping at the first hit:

1. :attr:`MatchBasis.REPOSITORY_PROVENANCE` — a prior import from the **same repository and
   file path**. The strongest signal, and the one that makes re-import of a tracked folder
   correct. The provenance is already recorded on the revision's ``format_metadata`` by
   MFI-29.3 (:func:`app.git_intake.git_provenance_metadata` writes ``gitRepoUrl`` /
   ``gitPath``); nothing read it back until now.
2. :attr:`MatchBasis.SLUG` — an existing project whose slug equals the item's
   ``suggested_slug``.
3. :attr:`MatchBasis.SPEC_IDENTITY` — the document's own title, for a file that **moved**
   within the repository: its path no longer resolves, but the API it describes is the same
   one.

Each basis carries its own :data:`MATCH_CONFIDENCE`, distinct from the *detection* confidence
already on a plan item — one says "this is an OpenAPI document", the other says "this is a new
version of the API you already have".

Policy
------
A match is a fact; what to *do* with it is configuration. :func:`resolve_version_policy`
applies the two scopes BLK-1.2 defines, most specific first::

    repository override ──► tenant default ──► append-when-matched

and :func:`decide_resolution` turns ``(match, policy)`` into one of
:class:`Resolution`. ``always-create`` still reports the match it is ignoring — a plan that
hid the match would be asserting the tenant is empty, which is the bug this ticket exists to
fix — and ``always-ask`` reports every item unresolved so the apply step must be told what to
do per item.

Versions
--------
:func:`propose_version` says which version label the item would create, and **how it got
there** (:class:`VersionDerivation`), so a verify screen can explain itself rather than
assert. It reads the matched project's existing labels and never writes: an append bumps the
minor of the highest semver label, a create takes the batch's default first version, and a
project whose labels are not semver falls back to the first free label at or after that
default — which is exactly what :meth:`app.database.Database.allocate_version_id` would pick
at apply time, so the plan does not promise a label the apply would rename.

Deliberately not filtered
-------------------------
**Publishability.** A matched project is reported whether or not it is publishable. A
non-publishable catalog item is where a re-imported non-OpenAPI spec genuinely lands today —
:func:`app.import_source_pipeline._resolve_import_project` reuses a live catalog item with the
same slug rather than minting a second one — so skipping those matches would make every
catalog re-import look like a first-time import, the exact failure this module removes. The
item's ``predicted_target`` already tells a client which kind of destination it is looking at,
and BLK-1.1's ``TARGET_NOT_PUBLISHABLE`` remains the authority at apply time.

Nothing here writes. Every function is a pure decision except
:class:`ProjectReconciler`, which only reads, and the plan endpoint's read-only guarantee is
unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .semver_version import parse_semver

__all__ = [
    "DEFAULT_VERSION_POLICY",
    "MATCH_CONFIDENCE",
    "ItemResolution",
    "MatchBasis",
    "ProjectMatch",
    "ProjectReconciler",
    "ProposedVersion",
    "Resolution",
    "ResolvedVersionPolicy",
    "VersionDerivation",
    "VersionPolicy",
    "VersionPolicySource",
    "decide_resolution",
    "normalize_repo_url",
    "parse_version_policy",
    "propose_version",
    "reconcile_item",
    "resolve_version_policy",
]


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------


class VersionPolicy(str, Enum):
    """What a bulk plan does with an item that matches an existing project.

    These are the stored, wire-visible tokens: the values match the ``CHECK`` constraints on
    ``tenants.bulk_import_version_policy`` and
    ``tenant_repositories.bulk_import_version_policy`` (migration
    ``V247__bulk_import_version_policy_blk_1_2.sql``), and are what the plan response reports.
    """

    #: The default. A matched item appends a version to the project it matched; an unmatched
    #: item creates a project. This is the behaviour the batch flow exists to provide.
    APPEND_WHEN_MATCHED = "append-when-matched"
    #: Every item creates a project, ignoring matches. The matches are still *reported* on the
    #: plan, so ignoring them is visible rather than hidden.
    ALWAYS_CREATE = "always-create"
    #: Every item is reported unresolved and requires an explicit per-item choice at apply
    #: time, whether it matched or not.
    ALWAYS_ASK = "always-ask"


#: The policy in force when neither the repository nor the tenant specifies one. BLK-1.2 makes
#: the *useful* behaviour the default: a tenant with no opinion gets re-import that appends.
DEFAULT_VERSION_POLICY = VersionPolicy.APPEND_WHEN_MATCHED


class VersionPolicySource(str, Enum):
    """Where the applied policy came from, reported so nobody has to guess which tier won."""

    #: The repository's ``tenant_repositories.bulk_import_version_policy`` override.
    REPOSITORY = "repository"
    #: The tenant's ``tenants.bulk_import_version_policy`` default.
    TENANT = "tenant"
    #: Neither was set (or both were unrecognised) -> :data:`DEFAULT_VERSION_POLICY`.
    DEFAULT = "default"


#: Tolerated spellings of the stored tokens. The API and the DB agree on the hyphenated forms;
#: these mean a hand-written config or an older caller still resolves to what it meant instead
#: of silently degrading to the default.
_POLICY_ALIASES = {
    "append_when_matched": VersionPolicy.APPEND_WHEN_MATCHED,
    "appendwhenmatched": VersionPolicy.APPEND_WHEN_MATCHED,
    "append": VersionPolicy.APPEND_WHEN_MATCHED,
    "always_create": VersionPolicy.ALWAYS_CREATE,
    "alwayscreate": VersionPolicy.ALWAYS_CREATE,
    "create": VersionPolicy.ALWAYS_CREATE,
    "always_ask": VersionPolicy.ALWAYS_ASK,
    "alwaysask": VersionPolicy.ALWAYS_ASK,
    "ask": VersionPolicy.ALWAYS_ASK,
}


def parse_version_policy(
    value: Optional[object], *, default: Optional[VersionPolicy] = None
) -> Optional[VersionPolicy]:
    """Parse a stored or submitted policy token into a :class:`VersionPolicy`.

    Accepts the canonical tokens case-insensitively plus the underscore and shorthand
    spellings in :data:`_POLICY_ALIASES`. Anything unrecognised — including ``None`` and blank
    — yields ``default``.

    Args:
        value: The raw token (typically a DB column), or ``None``.
        default: What to return when ``value`` is missing or unrecognised. Defaults to ``None``
            so a caller can tell "not set" from "set to the default";
            :func:`resolve_version_policy` relies on that.

    Returns:
        The parsed :class:`VersionPolicy`, or ``default``.
    """
    if isinstance(value, VersionPolicy):
        return value
    if not isinstance(value, str):
        return default
    token = value.strip().lower()
    if not token:
        return default
    try:
        return VersionPolicy(token)
    except ValueError:
        return _POLICY_ALIASES.get(token.replace("-", "_"), default)


@dataclass(frozen=True)
class ResolvedVersionPolicy:
    """Which policy applies to a plan, and where it came from.

    Attributes:
        policy: The :class:`VersionPolicy` in force for this plan.
        source: The :class:`VersionPolicySource` it was read from.
    """

    policy: VersionPolicy
    source: VersionPolicySource


def resolve_version_policy(
    *,
    repository_policy: Optional[object] = None,
    tenant_policy: Optional[object] = None,
    default: VersionPolicy = DEFAULT_VERSION_POLICY,
) -> ResolvedVersionPolicy:
    """Resolve the reconciliation policy for one plan (BLK-1.2).

    Applies the precedence the ticket specifies — a repository states intent for its own
    contents, the tenant states it for everything else::

        repository override ──► tenant default ──► append-when-matched

    An unrecognised value at either level is treated as *not set* rather than as an error, so
    one bad row degrades to the next-broadest policy instead of failing the plan. Because the
    plan writes nothing, every degradation path is harmless: the worst case is a plan the user
    re-runs after fixing the setting.

    Args:
        repository_policy: ``tenant_repositories.bulk_import_version_policy``, or ``None`` when
            the payload is an archive or the repository has no override.
        tenant_policy: ``tenants.bulk_import_version_policy``, or ``None``.
        default: The policy backing both levels.

    Returns:
        A :class:`ResolvedVersionPolicy` carrying the policy and its source.
    """
    parsed_repository = parse_version_policy(repository_policy)
    if parsed_repository is not None:
        return ResolvedVersionPolicy(
            policy=parsed_repository, source=VersionPolicySource.REPOSITORY
        )

    parsed_tenant = parse_version_policy(tenant_policy)
    if parsed_tenant is not None:
        return ResolvedVersionPolicy(policy=parsed_tenant, source=VersionPolicySource.TENANT)

    return ResolvedVersionPolicy(policy=default, source=VersionPolicySource.DEFAULT)


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


class MatchBasis(str, Enum):
    """Why an item matched a project — the explanation a verify screen leads with."""

    #: A prior import from the same repository *and the same file path*.
    REPOSITORY_PROVENANCE = "repository-provenance"
    #: An existing project already uses the slug this item would take.
    SLUG = "slug"
    #: An existing project is named for the same API this document declares.
    SPEC_IDENTITY = "spec-identity"


#: Confidence per basis, distinct from a plan item's *detection* confidence. Provenance is
#: certainty — the same repository path produced that project's revision — while a slug or a
#: title is an inference from an identity two different APIs could in principle share.
MATCH_CONFIDENCE: Dict[MatchBasis, float] = {
    MatchBasis.REPOSITORY_PROVENANCE: 1.0,
    MatchBasis.SLUG: 0.8,
    MatchBasis.SPEC_IDENTITY: 0.6,
}


@dataclass(frozen=True)
class ProjectMatch:
    """The existing project an item resolves to, and why.

    Attributes:
        project_id: The matched project's id — what an apply step passes as
            ``project.project_id`` (BLK-1.1).
        name: The matched project's display name.
        slug: The matched project's slug.
        basis: Which :class:`MatchBasis` found it.
        confidence: :data:`MATCH_CONFIDENCE` for that basis.
        detail: One sentence explaining the match in the user's terms.
    """

    project_id: str
    name: str
    slug: str
    basis: MatchBasis
    confidence: float
    detail: str


def normalize_repo_url(repo_url: Optional[str]) -> str:
    """Reduce a repository URL to a comparable form.

    The provenance a plan holds and the provenance stored on an older revision came from the
    same selector, but not necessarily typed the same way: ``…/repo`` and ``…/repo.git`` are
    the same repository, and the hosts and owner/repo names of the providers this reads from
    are case-insensitive. Comparing the normalized forms means a trailing ``.git`` cannot make
    a re-import look like a first-time import. Both sides are folded the same way, so the
    comparison stays symmetric.

    Args:
        repo_url: The URL to normalize, or ``None``.

    Returns:
        The lowercased URL without a trailing ``/`` or ``.git``; ``""`` when there is none.
    """
    text = (repo_url or "").strip().lower().rstrip("/")
    if text.endswith(".git"):
        text = text[: -len(".git")]
    return text.rstrip("/")


class ProjectReconciler:
    """Resolve planned items to existing projects, reading each answer at most once.

    A plan reconciles every item of a batch against the same tenant, and the batch ceiling is
    in the hundreds. Caching the three lookups per key keeps a plan's DB cost proportional to
    the *distinct* paths, slugs and titles it holds rather than to its item count, and makes
    the reads deterministic for a test double.

    Blocking DB work (the psycopg driver is synchronous) — call via ``asyncio.to_thread`` from
    async code.

    Args:
        handle: The database handle (``app.database.db``, or a fake in tests).
        tenant_id: The acting tenant; every read is scoped to it.
    """

    def __init__(self, handle: Any, *, tenant_id: str) -> None:
        self._db = handle
        self._tenant_id = tenant_id
        self._by_path: Dict[Tuple[str, str], Optional[Dict[str, Any]]] = {}
        self._by_slug: Dict[str, Optional[Dict[str, Any]]] = {}
        self._by_title: Dict[str, Optional[Dict[str, Any]]] = {}
        self._labels: Dict[str, Tuple[str, ...]] = {}

    def match(
        self,
        *,
        repo_url: Optional[str] = None,
        git_path: Optional[str] = None,
        slug: Optional[str] = None,
        title: Optional[str] = None,
    ) -> Optional[ProjectMatch]:
        """Find the project this item resolves to, in the BLK-1.2 precedence order.

        Args:
            repo_url: Repository the payload came from, or ``None`` for an archive upload.
            git_path: The item's own path inside that repository (the batch selection path
                plus the item's root, exactly as recorded on the revision it would match).
            slug: The item's ``suggested_slug``.
            title: The item's ``suggested_name`` — the document's declared title when it has
                one, which is what "spec identity" means here.

        Returns:
            The first :class:`ProjectMatch` found, or ``None`` when the item is genuinely new.
        """
        provenance = self._match_provenance(repo_url, git_path)
        if provenance is not None:
            return provenance

        by_slug = self._match_slug(slug)
        if by_slug is not None:
            return by_slug

        return self._match_title(title)

    def version_labels(self, project_id: str) -> Tuple[str, ...]:
        """Return the live version labels of a project, read once per plan.

        Args:
            project_id: The matched project.

        Returns:
            Its ``versions.version_id`` labels, in no particular order.
        """
        cached = self._labels.get(project_id)
        if cached is None:
            cached = tuple(self._db.list_project_version_labels(project_id, self._tenant_id))
            self._labels[project_id] = cached
        return cached

    def _match_provenance(
        self, repo_url: Optional[str], git_path: Optional[str]
    ) -> Optional[ProjectMatch]:
        """Match a prior import from the same repository *and* path (MFI-29.3 provenance)."""
        path = (git_path or "").strip()
        normalized = normalize_repo_url(repo_url)
        if not path or not normalized:
            return None

        cache_key = (normalized, path)
        if cache_key not in self._by_path:
            self._by_path[cache_key] = self._read_provenance(normalized, path)
        row = self._by_path[cache_key]
        if not row:
            return None
        return _project_match(
            row,
            MatchBasis.REPOSITORY_PROVENANCE,
            detail=(
                f"A previous import of {path!r} from this repository created "
                f"{str(row.get('name') or '').strip() or 'this project'}."
            ),
        )

    def _read_provenance(self, normalized_repo_url: str, path: str) -> Optional[Dict[str, Any]]:
        """Read the newest project imported from ``path``, filtered to the same repository.

        The index is on the path (the selective half of the key — a monorepo has one URL and
        thousands of paths), so the URL is compared here, on the handful of rows a path can
        return, in its normalized form rather than verbatim.
        """
        rows = self._db.find_projects_by_git_path(self._tenant_id, path) or []
        for row in rows:
            if normalize_repo_url(row.get("git_repo_url")) == normalized_repo_url:
                return dict(row)
        return None

    def _match_slug(self, slug: Optional[str]) -> Optional[ProjectMatch]:
        """Match an existing project that already uses the slug this item would take."""
        candidate = (slug or "").strip()
        if not candidate:
            return None
        if candidate not in self._by_slug:
            self._by_slug[candidate] = self._db.get_project_by_slug(candidate, self._tenant_id)
        row = self._by_slug[candidate]
        if not row:
            return None
        return _project_match(
            row,
            MatchBasis.SLUG,
            detail=f"An existing project already uses the slug {candidate!r}.",
        )

    def _match_title(self, title: Optional[str]) -> Optional[ProjectMatch]:
        """Match an existing project named for the same API — the moved-file fallback."""
        candidate = (title or "").strip()
        if not candidate:
            return None
        folded = candidate.casefold()
        if folded not in self._by_title:
            self._by_title[folded] = self._db.find_project_by_name(self._tenant_id, candidate)
        row = self._by_title[folded]
        if not row:
            return None
        return _project_match(
            row,
            MatchBasis.SPEC_IDENTITY,
            detail=(
                f"An existing project is named {candidate!r}, matching this document's "
                "own identity."
            ),
        )


def _project_match(row: Dict[str, Any], basis: MatchBasis, *, detail: str) -> ProjectMatch:
    """Adapt a project row into a :class:`ProjectMatch` for ``basis``."""
    return ProjectMatch(
        project_id=str(row.get("id") or ""),
        name=str(row.get("name") or ""),
        slug=str(row.get("slug") or ""),
        basis=basis,
        confidence=MATCH_CONFIDENCE[basis],
        detail=detail,
    )


# ---------------------------------------------------------------------------
# Resolution and version proposal
# ---------------------------------------------------------------------------


class Resolution(str, Enum):
    """What would happen to one item if the plan were applied now."""

    #: The item appends a new version to :attr:`ItemResolution.match`'s project.
    APPEND_VERSION = "append-version"
    #: The item creates a project. Either nothing matched, or the policy ignores matches.
    CREATE_PROJECT = "create-project"
    #: Neither — the ``always-ask`` policy defers the choice to an explicit per-item decision
    #: at apply time.
    UNRESOLVED = "unresolved"


def decide_resolution(
    match: Optional[ProjectMatch], policy: VersionPolicy
) -> Resolution:
    """Turn a match and a policy into the item's resolution.

    Args:
        match: The project the item resolves to, or ``None`` when it is genuinely new.
        policy: The resolved :class:`VersionPolicy`.

    Returns:
        The :class:`Resolution`. Note that ``always-create`` returns
        :attr:`Resolution.CREATE_PROJECT` *without* discarding ``match`` — the caller still
        reports it, so a plan that ignores a match says so.
    """
    if policy is VersionPolicy.ALWAYS_ASK:
        return Resolution.UNRESOLVED
    if policy is VersionPolicy.ALWAYS_CREATE:
        return Resolution.CREATE_PROJECT
    return Resolution.APPEND_VERSION if match is not None else Resolution.CREATE_PROJECT


class VersionDerivation(str, Enum):
    """How :func:`propose_version` arrived at the label it proposes."""

    #: The batch's default first version — a new project, or a matched project with no live
    #: revisions.
    DEFAULT = "default"
    #: The next minor after the matched project's highest semver label.
    VERSION_BUMP = "version-bump"
    #: The matched project has revisions but none of its labels is semver, so the first free
    #: label at or after the default was taken — exactly what ``allocate_version_id`` would
    #: pick at apply time.
    NEXT_AVAILABLE = "next-available"


@dataclass(frozen=True)
class ProposedVersion:
    """The version label the item would create, and how it was derived.

    Attributes:
        version_id: The label itself.
        derived_from: Which :class:`VersionDerivation` produced it.
        previous_version_id: The label it follows, set only for
            :attr:`VersionDerivation.VERSION_BUMP`.
    """

    version_id: str
    derived_from: VersionDerivation
    previous_version_id: Optional[str] = None


def propose_version(
    existing_labels: Sequence[str], *, default_version_id: str
) -> ProposedVersion:
    """Propose the version label an item would create, without writing anything.

    Three outcomes, in the order they are tried:

    * No live revisions — a new project, or a matched one that is empty — so the batch's
      default first version is free and is what an apply would use.
    * At least one label parses as semver: bump the **minor** of the highest one and keep
      bumping while the candidate is taken. A re-import is a new revision of the same API, not
      a new API, so the minor is the conservative move; the major is a claim about breaking
      changes that only a diff can make.
    * Labels exist but none is semver: fall back to the first free label at or after the
      default (``1.0.0``, then ``1.0.0-2``, …), which is exactly what
      :meth:`app.database.Database.allocate_version_id` picks — the plan must not promise a
      label the apply would silently rename.

    Args:
        existing_labels: The matched project's live ``version_id`` labels. Empty for a create.
        default_version_id: The batch's default first version (``1.0.0``).

    Returns:
        The :class:`ProposedVersion`.
    """
    taken = {str(label).strip() for label in existing_labels if str(label).strip()}
    if not taken:
        return ProposedVersion(version_id=default_version_id, derived_from=VersionDerivation.DEFAULT)

    ranked: List[Tuple[Tuple[int, int, int], str]] = []
    for label in taken:
        parts = parse_semver(label)
        # A pre-release ("2.0.0-rc.1") sorts *below* its release under semver, so bumping from
        # it would propose a label the release already holds. Ranking on the core triple and
        # then skipping taken candidates below reaches the same free label either way.
        if parts is not None:
            ranked.append(((parts[0], parts[1], parts[2]), label))

    if ranked:
        (major, minor, _patch), highest = max(ranked)
        next_minor = minor + 1
        while f"{major}.{next_minor}.0" in taken:
            next_minor += 1
        return ProposedVersion(
            version_id=f"{major}.{next_minor}.0",
            derived_from=VersionDerivation.VERSION_BUMP,
            previous_version_id=highest,
        )

    if default_version_id not in taken:
        return ProposedVersion(
            version_id=default_version_id, derived_from=VersionDerivation.NEXT_AVAILABLE
        )
    suffix = 2
    while f"{default_version_id}-{suffix}" in taken:
        suffix += 1
    return ProposedVersion(
        version_id=f"{default_version_id}-{suffix}",
        derived_from=VersionDerivation.NEXT_AVAILABLE,
    )


@dataclass(frozen=True)
class ItemResolution:
    """One item's reconciliation: what would happen, against what, and as which version.

    Attributes:
        resolution: What applying the plan now would do to this item.
        match: The project it resolves to, or ``None`` when nothing matched. Populated even
            when ``resolution`` is :attr:`Resolution.CREATE_PROJECT` under ``always-create``,
            so an ignored match is reported rather than hidden.
        proposed_version: The version label the item would create.
    """

    resolution: Resolution
    match: Optional[ProjectMatch]
    proposed_version: ProposedVersion


def reconcile_item(
    reconciler: ProjectReconciler,
    *,
    policy: VersionPolicy,
    repo_url: Optional[str] = None,
    git_path: Optional[str] = None,
    slug: Optional[str] = None,
    title: Optional[str] = None,
    default_version_id: str,
) -> ItemResolution:
    """Reconcile one planned item against the tenant's existing projects.

    The proposed version follows the item's *effective* outcome. ``append-version`` proposes a
    bump on the matched project; ``create-project`` proposes the batch default. ``unresolved``
    has not chosen yet, so it proposes what the default ``append-when-matched`` policy would
    have — the candidate the user is being asked to confirm — rather than nothing, since a
    screen that asks "append or create?" has to be able to say what appending means.

    Blocking DB work — call via ``asyncio.to_thread`` from async code.

    Args:
        reconciler: The per-plan :class:`ProjectReconciler`.
        policy: The resolved :class:`VersionPolicy` for this plan.
        repo_url: Repository the payload came from, or ``None`` for an archive.
        git_path: The item's path inside that repository.
        slug: The item's ``suggested_slug``.
        title: The item's ``suggested_name``.
        default_version_id: The batch's default first version.

    Returns:
        The :class:`ItemResolution`.
    """
    match = reconciler.match(repo_url=repo_url, git_path=git_path, slug=slug, title=title)
    resolution = decide_resolution(match, policy)

    appends = resolution is Resolution.APPEND_VERSION or (
        resolution is Resolution.UNRESOLVED and match is not None
    )
    labels = reconciler.version_labels(match.project_id) if appends and match else ()
    return ItemResolution(
        resolution=resolution,
        match=match,
        proposed_version=propose_version(labels, default_version_id=default_version_id),
    )
