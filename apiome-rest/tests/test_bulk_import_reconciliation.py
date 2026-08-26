"""Unit tests for batch reconciliation (BLK-1.2, #5524).

:mod:`app.bulk_import_reconciliation` answers "which of these items is a new version of
something the tenant already has?" before a bulk plan is rendered. These drive the three
decisions it makes — which project matched and why, what the policy says a match means, and
which version label the item would create — directly against a fake DB, so every branch is
covered without a database, a plan, or a job.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from app.bulk_import_reconciliation import (
    DEFAULT_VERSION_POLICY,
    MATCH_CONFIDENCE,
    MatchBasis,
    ProjectReconciler,
    Resolution,
    VersionDerivation,
    VersionPolicy,
    VersionPolicySource,
    decide_resolution,
    normalize_repo_url,
    parse_version_policy,
    propose_version,
    reconcile_item,
    resolve_version_policy,
)

TENANT = "550e8400-e29b-41d4-a716-446655440000"
REPO_URL = "https://github.com/acme/specs"
PROJECT = "660e8400-e29b-41d4-a716-446655440001"
OTHER_PROJECT = "660e8400-e29b-41d4-a716-4466554400ff"


class _FakeDb:
    """Stand-in for the four tenant-scoped reads the reconciler makes.

    Records every call so the caching contract — a plan reads each distinct path, slug, title
    and project once — is assertable rather than assumed.
    """

    def __init__(
        self,
        *,
        by_path: Optional[Dict[str, List[Dict[str, Any]]]] = None,
        by_slug: Optional[Dict[str, Dict[str, Any]]] = None,
        by_name: Optional[Dict[str, Dict[str, Any]]] = None,
        labels: Optional[Dict[str, List[str]]] = None,
        tenant_policy: Optional[str] = None,
    ) -> None:
        self.by_path = by_path or {}
        self.by_slug = by_slug or {}
        self.by_name = by_name or {}
        self.labels = labels or {}
        self.tenant_policy = tenant_policy
        self.path_reads: List[str] = []
        self.slug_reads: List[str] = []
        self.name_reads: List[str] = []
        self.label_reads: List[str] = []

    def find_projects_by_git_path(self, tenant_id: str, git_path: str) -> List[Dict[str, Any]]:
        assert tenant_id == TENANT
        self.path_reads.append(git_path)
        return [dict(row) for row in self.by_path.get(git_path, [])]

    def get_project_by_slug(self, slug: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        assert tenant_id == TENANT
        self.slug_reads.append(slug)
        row = self.by_slug.get(slug)
        return dict(row) if row else None

    def find_project_by_name(self, tenant_id: str, name: str) -> Optional[Dict[str, Any]]:
        assert tenant_id == TENANT
        self.name_reads.append(name)
        row = self.by_name.get(name.casefold())
        return dict(row) if row else None

    def list_project_version_labels(self, project_id: str, tenant_id: str) -> List[str]:
        assert tenant_id == TENANT
        self.label_reads.append(project_id)
        return list(self.labels.get(project_id, []))

    def get_tenant_bulk_import_version_policy(self, tenant_id: str) -> Optional[str]:
        assert tenant_id == TENANT
        return self.tenant_policy


def _project(project_id: str = PROJECT, **overrides: Any) -> Dict[str, Any]:
    row = {"id": project_id, "name": "Orders API", "slug": "orders-api", "publishable": True}
    row.update(overrides)
    return row


def _provenance_row(repo_url: str = REPO_URL, **overrides: Any) -> Dict[str, Any]:
    row = _project()
    row["git_repo_url"] = repo_url
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# Policy resolution
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "token,expected",
    [
        ("append-when-matched", VersionPolicy.APPEND_WHEN_MATCHED),
        ("ALWAYS-CREATE", VersionPolicy.ALWAYS_CREATE),
        ("always_ask", VersionPolicy.ALWAYS_ASK),
        ("ask", VersionPolicy.ALWAYS_ASK),
        ("  append  ", VersionPolicy.APPEND_WHEN_MATCHED),
    ],
)
def test_parse_version_policy_accepts_stored_and_alias_spellings(token, expected):
    assert parse_version_policy(token) is expected


@pytest.mark.parametrize("token", [None, "", "   ", "nonsense", 7, {"policy": "ask"}])
def test_parse_version_policy_treats_unusable_values_as_not_set(token):
    """Not-set and unrecognised must be indistinguishable, so resolution can fall through."""
    assert parse_version_policy(token) is None
    assert parse_version_policy(token, default=VersionPolicy.ALWAYS_ASK) is VersionPolicy.ALWAYS_ASK


def test_repository_override_wins_over_the_tenant_default():
    resolved = resolve_version_policy(
        repository_policy="always-create", tenant_policy="always-ask"
    )
    assert resolved.policy is VersionPolicy.ALWAYS_CREATE
    assert resolved.source is VersionPolicySource.REPOSITORY


def test_tenant_default_applies_when_the_repository_has_no_opinion():
    resolved = resolve_version_policy(repository_policy=None, tenant_policy="always-ask")
    assert resolved.policy is VersionPolicy.ALWAYS_ASK
    assert resolved.source is VersionPolicySource.TENANT


def test_built_in_default_backs_both_tiers():
    resolved = resolve_version_policy()
    assert resolved.policy is DEFAULT_VERSION_POLICY is VersionPolicy.APPEND_WHEN_MATCHED
    assert resolved.source is VersionPolicySource.DEFAULT


def test_an_unrecognised_tier_degrades_to_the_next_one_rather_than_failing():
    """One bad row must cost the next-broadest policy, never the plan."""
    resolved = resolve_version_policy(repository_policy="clobber", tenant_policy="always-create")
    assert resolved.policy is VersionPolicy.ALWAYS_CREATE
    assert resolved.source is VersionPolicySource.TENANT


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "left,right",
    [
        ("https://github.com/acme/specs", "https://github.com/acme/specs.git"),
        ("https://github.com/acme/specs/", "https://GitHub.com/Acme/Specs"),
    ],
)
def test_normalize_repo_url_collapses_spellings_of_the_same_repository(left, right):
    assert normalize_repo_url(left) == normalize_repo_url(right)


def test_repository_provenance_is_the_first_basis_tried():
    db = _FakeDb(
        by_path={"specs/orders.yaml": [_provenance_row()]},
        by_slug={"orders-api": _project(OTHER_PROJECT)},
    )
    match = ProjectReconciler(db, tenant_id=TENANT).match(
        repo_url=REPO_URL, git_path="specs/orders.yaml", slug="orders-api", title="Orders API"
    )
    assert match is not None
    assert match.project_id == PROJECT
    assert match.basis is MatchBasis.REPOSITORY_PROVENANCE
    assert match.confidence == MATCH_CONFIDENCE[MatchBasis.REPOSITORY_PROVENANCE]
    assert "specs/orders.yaml" in match.detail
    # Provenance hit: the cheaper fallbacks were never consulted.
    assert db.slug_reads == [] and db.name_reads == []


def test_provenance_matching_tolerates_a_dot_git_spelling_difference():
    db = _FakeDb(by_path={"orders.yaml": [_provenance_row(f"{REPO_URL}.git")]})
    match = ProjectReconciler(db, tenant_id=TENANT).match(
        repo_url=f"{REPO_URL}/", git_path="orders.yaml"
    )
    assert match is not None and match.basis is MatchBasis.REPOSITORY_PROVENANCE


def test_the_same_path_in_a_different_repository_is_not_a_provenance_match():
    """A monorepo path like 'openapi/orders.yaml' is not unique across repositories."""
    db = _FakeDb(by_path={"orders.yaml": [_provenance_row("https://github.com/other/specs")]})
    assert (
        ProjectReconciler(db, tenant_id=TENANT).match(repo_url=REPO_URL, git_path="orders.yaml")
        is None
    )


def test_slug_is_the_second_basis():
    db = _FakeDb(by_slug={"orders-api": _project()}, by_name={"orders api": _project(OTHER_PROJECT)})
    match = ProjectReconciler(db, tenant_id=TENANT).match(slug="orders-api", title="Orders API")
    assert match is not None
    assert match.project_id == PROJECT
    assert match.basis is MatchBasis.SLUG
    assert match.confidence == MATCH_CONFIDENCE[MatchBasis.SLUG]
    assert db.name_reads == []


def test_spec_identity_is_the_moved_file_fallback():
    """The path no longer resolves and the slug was suffixed — the title still matches."""
    db = _FakeDb(by_name={"orders api": _project(slug="orders-api-2")})
    match = ProjectReconciler(db, tenant_id=TENANT).match(
        repo_url=REPO_URL, git_path="v2/orders.yaml", slug="orders-api", title="Orders API"
    )
    assert match is not None
    assert match.basis is MatchBasis.SPEC_IDENTITY
    assert match.confidence == MATCH_CONFIDENCE[MatchBasis.SPEC_IDENTITY]
    assert db.path_reads == ["v2/orders.yaml"] and db.slug_reads == ["orders-api"]


def test_a_genuinely_new_item_matches_nothing():
    reconciler = ProjectReconciler(_FakeDb(), tenant_id=TENANT)
    assert reconciler.match(repo_url=REPO_URL, git_path="new.yaml", slug="new", title="New") is None


def test_an_archive_upload_skips_the_provenance_lookup_entirely():
    """No repository means no path to look one up by — not a lookup that returns nothing."""
    db = _FakeDb(by_slug={"orders-api": _project()})
    match = ProjectReconciler(db, tenant_id=TENANT).match(slug="orders-api", title="Orders API")
    assert match is not None and db.path_reads == []


def test_each_distinct_lookup_is_read_once_per_plan():
    """A batch reconciles hundreds of items against one tenant; repeats must not re-query."""
    db = _FakeDb(by_slug={"orders-api": _project()}, labels={PROJECT: ["1.0.0"]})
    reconciler = ProjectReconciler(db, tenant_id=TENANT)
    for _ in range(3):
        reconciler.match(slug="orders-api", title="Orders API")
        reconciler.version_labels(PROJECT)
    assert db.slug_reads == ["orders-api"]
    assert db.label_reads == [PROJECT]


def test_matching_is_case_insensitive_on_the_declared_title():
    db = _FakeDb(by_name={"orders api": _project(name="orders api")})
    assert ProjectReconciler(db, tenant_id=TENANT).match(title="ORDERS API") is not None


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def test_append_when_matched_appends_a_matched_item_and_creates_an_unmatched_one():
    match = ProjectReconciler(
        _FakeDb(by_slug={"orders-api": _project()}), tenant_id=TENANT
    ).match(slug="orders-api")
    assert decide_resolution(match, VersionPolicy.APPEND_WHEN_MATCHED) is Resolution.APPEND_VERSION
    assert decide_resolution(None, VersionPolicy.APPEND_WHEN_MATCHED) is Resolution.CREATE_PROJECT


@pytest.mark.parametrize("policy,expected", [
    (VersionPolicy.ALWAYS_CREATE, Resolution.CREATE_PROJECT),
    (VersionPolicy.ALWAYS_ASK, Resolution.UNRESOLVED),
])
def test_the_other_policies_ignore_whether_the_item_matched(policy, expected):
    match = ProjectReconciler(
        _FakeDb(by_slug={"orders-api": _project()}), tenant_id=TENANT
    ).match(slug="orders-api")
    assert decide_resolution(match, policy) is expected
    assert decide_resolution(None, policy) is expected


# ---------------------------------------------------------------------------
# Version proposal
# ---------------------------------------------------------------------------


def test_an_empty_project_takes_the_batch_default():
    proposed = propose_version([], default_version_id="1.0.0")
    assert proposed.version_id == "1.0.0"
    assert proposed.derived_from is VersionDerivation.DEFAULT
    assert proposed.previous_version_id is None


def test_a_semver_project_gets_the_next_minor():
    proposed = propose_version(["1.0.0", "1.1.0", "0.9.0"], default_version_id="1.0.0")
    assert proposed.version_id == "1.2.0"
    assert proposed.derived_from is VersionDerivation.VERSION_BUMP
    assert proposed.previous_version_id == "1.1.0"


def test_the_bump_skips_labels_that_are_already_taken():
    proposed = propose_version(["2.3.0", "2.4.0", "2.5.0"], default_version_id="1.0.0")
    assert proposed.version_id == "2.6.0"


def test_a_prerelease_never_proposes_a_label_its_release_already_holds():
    proposed = propose_version(["2.0.0", "2.0.0-rc.1"], default_version_id="1.0.0")
    assert proposed.version_id == "2.1.0"


def test_non_semver_labels_fall_back_to_the_first_free_label():
    """Matches what allocate_version_id would pick, so the plan is not silently renamed."""
    proposed = propose_version(["draft", "release-candidate"], default_version_id="1.0.0")
    assert proposed.version_id == "1.0.0"
    assert proposed.derived_from is VersionDerivation.NEXT_AVAILABLE


def test_one_semver_label_among_free_form_ones_is_enough_to_bump():
    proposed = propose_version(["draft", "1.0.0"], default_version_id="1.0.0")
    assert proposed.version_id == "1.1.0"
    assert proposed.derived_from is VersionDerivation.VERSION_BUMP


def test_a_free_form_default_that_is_already_taken_takes_the_next_suffix():
    proposed = propose_version(["draft"], default_version_id="draft")
    assert proposed.version_id == "draft-2"
    assert proposed.derived_from is VersionDerivation.NEXT_AVAILABLE


def test_blank_labels_are_ignored():
    assert propose_version(["", "   "], default_version_id="1.0.0").derived_from is (
        VersionDerivation.DEFAULT
    )


# ---------------------------------------------------------------------------
# End to end: reconcile_item
# ---------------------------------------------------------------------------


def _reconcile(db: _FakeDb, policy: VersionPolicy, **kwargs: Any):
    return reconcile_item(
        ProjectReconciler(db, tenant_id=TENANT),
        policy=policy,
        default_version_id="1.0.0",
        **kwargs,
    )


def test_a_re_imported_repository_item_appends_the_next_version():
    db = _FakeDb(
        by_path={"specs/orders.yaml": [_provenance_row()]},
        labels={PROJECT: ["1.0.0", "1.1.0"]},
    )
    resolved = _reconcile(
        db,
        VersionPolicy.APPEND_WHEN_MATCHED,
        repo_url=REPO_URL,
        git_path="specs/orders.yaml",
        slug="orders-api",
        title="Orders API",
    )
    assert resolved.resolution is Resolution.APPEND_VERSION
    assert resolved.match is not None and resolved.match.project_id == PROJECT
    assert resolved.proposed_version.version_id == "1.2.0"
    assert resolved.proposed_version.previous_version_id == "1.1.0"


def test_a_new_item_in_the_same_folder_creates_a_project_at_the_default_version():
    db = _FakeDb(by_path={"specs/orders.yaml": [_provenance_row()]})
    resolved = _reconcile(
        db,
        VersionPolicy.APPEND_WHEN_MATCHED,
        repo_url=REPO_URL,
        git_path="specs/shipping.yaml",
        slug="shipping-api",
        title="Shipping API",
    )
    assert resolved.resolution is Resolution.CREATE_PROJECT
    assert resolved.match is None
    assert resolved.proposed_version.version_id == "1.0.0"
    assert resolved.proposed_version.derived_from is VersionDerivation.DEFAULT
    # Creating a project needs no version-label read at all.
    assert db.label_reads == []


def test_always_create_reports_the_match_it_is_ignoring():
    db = _FakeDb(by_slug={"orders-api": _project()}, labels={PROJECT: ["1.0.0"]})
    resolved = _reconcile(
        db, VersionPolicy.ALWAYS_CREATE, slug="orders-api", title="Orders API"
    )
    assert resolved.resolution is Resolution.CREATE_PROJECT
    assert resolved.match is not None and resolved.match.basis is MatchBasis.SLUG
    # The version it proposes is the one *creating* would take, not the ignored append.
    assert resolved.proposed_version.version_id == "1.0.0"
    assert resolved.proposed_version.derived_from is VersionDerivation.DEFAULT


def test_always_ask_leaves_the_item_unresolved_but_still_shows_what_appending_would_mean():
    db = _FakeDb(by_slug={"orders-api": _project()}, labels={PROJECT: ["1.4.0"]})
    resolved = _reconcile(db, VersionPolicy.ALWAYS_ASK, slug="orders-api", title="Orders API")
    assert resolved.resolution is Resolution.UNRESOLVED
    assert resolved.match is not None
    assert resolved.proposed_version.version_id == "1.5.0"


def test_always_ask_on_an_unmatched_item_proposes_the_create_version():
    resolved = _reconcile(_FakeDb(), VersionPolicy.ALWAYS_ASK, slug="new-api", title="New API")
    assert resolved.resolution is Resolution.UNRESOLVED
    assert resolved.match is None
    assert resolved.proposed_version.version_id == "1.0.0"


def test_a_moved_file_still_appends_to_its_project_via_spec_identity():
    db = _FakeDb(
        by_path={"specs/orders.yaml": [_provenance_row()]},
        by_name={"orders api": _project(slug="orders-api-2")},
        labels={PROJECT: ["1.0.0"]},
    )
    resolved = _reconcile(
        db,
        VersionPolicy.APPEND_WHEN_MATCHED,
        repo_url=REPO_URL,
        git_path="v2/orders.yaml",
        slug="orders-api",
        title="Orders API",
    )
    assert resolved.resolution is Resolution.APPEND_VERSION
    assert resolved.match is not None
    assert resolved.match.basis is MatchBasis.SPEC_IDENTITY
    assert resolved.proposed_version.version_id == "1.1.0"


def test_a_non_publishable_catalog_item_is_still_a_match():
    """Catalog re-imports genuinely land back in the same item; hiding that is the old bug."""
    db = _FakeDb(by_slug={"orders-proto": _project(publishable=False)}, labels={PROJECT: ["1.0.0"]})
    resolved = _reconcile(
        db, VersionPolicy.APPEND_WHEN_MATCHED, slug="orders-proto", title="orders"
    )
    assert resolved.resolution is Resolution.APPEND_VERSION
    assert resolved.match is not None and resolved.match.project_id == PROJECT
