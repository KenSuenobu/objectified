"""Per-repo/file conflict policy tests (RAR-4.5, #3531).

Deterministic, DB-free fixtures over ``app.repository_conflict_policy``. They cover
the ticket's acceptance criteria — the policy is configurable per repo with a
per-file override, each policy behaves correctly on a diverged refresh, and the
default remains hold-for-review — plus the resolution precedence, the tolerant
token parsing, the degradation path when a stored token is unrecognised, and the
deterministic branch naming the ``new-branch`` policy relies on.
"""

from app.repository_conflict_policy import (
    DEFAULT_CONFLICT_POLICY,
    ConflictAction,
    ConflictPolicy,
    ConflictPolicySource,
    decide_conflict,
    parse_conflict_policy,
    refresh_branch_name,
    resolve_conflict_policy,
)
from app.repository_divergence_guard import DivergenceReason

SNAPSHOT = "checksum-as-imported"
EDITED = "checksum-after-hand-edit"


def _diverged(**kwargs):
    """Run the decision for a file that *was* hand-edited after import."""
    return decide_conflict(
        post_import_checksum=SNAPSHOT, current_checksum=EDITED, **kwargs
    )


# --- acceptance criteria ----------------------------------------------------


def test_policy_is_configurable_per_repo() -> None:
    """AC1a: the repository-wide setting decides when no override exists."""
    outcome = _diverged(repository_policy="overwrite")
    assert outcome.policy is ConflictPolicy.OVERWRITE
    assert outcome.source is ConflictPolicySource.REPOSITORY
    assert outcome.action is ConflictAction.APPLY


def test_per_file_override_beats_the_repository_policy() -> None:
    """AC1b: a per-file override wins over the repository-wide setting."""
    outcome = _diverged(repository_policy="overwrite", file_policy="hold-for-review")
    assert outcome.policy is ConflictPolicy.HOLD_FOR_REVIEW
    assert outcome.source is ConflictPolicySource.FILE
    assert outcome.action is ConflictAction.HOLD


def test_overwrite_policy_applies_the_refresh_and_still_reports_divergence() -> None:
    """AC2a: ``overwrite`` clobbers the hand edit but never hides that it did."""
    outcome = _diverged(repository_policy="overwrite")
    assert outcome.action is ConflictAction.APPLY
    assert outcome.diverged is True  # audit/notifications still see the truth
    assert outcome.reason is DivergenceReason.MANUAL_EDIT
    assert outcome.branch_name is None


def test_hold_for_review_policy_blocks_the_overwrite() -> None:
    """AC2b: ``hold-for-review`` skips the refresh and flags the file."""
    outcome = _diverged(repository_policy="hold-for-review")
    assert outcome.action is ConflictAction.HOLD
    assert outcome.diverged is True
    assert outcome.branch_name is None


def test_new_branch_policy_diverts_the_refresh_to_a_branch() -> None:
    """AC2c: ``new-branch`` leaves the current version alone and names a branch."""
    outcome = _diverged(
        repository_policy="new-branch",
        base_branch="main",
        path="specs/petstore.yaml",
        commit_sha="abcdef1234567890",
    )
    assert outcome.action is ConflictAction.NEW_BRANCH
    assert outcome.diverged is True
    assert outcome.branch_name == "apiome-refresh/main/petstore-abcdef123456"


def test_default_policy_remains_hold_for_review() -> None:
    """AC3: with nothing configured at either level, the refresh is held."""
    outcome = _diverged()
    assert DEFAULT_CONFLICT_POLICY is ConflictPolicy.HOLD_FOR_REVIEW
    assert outcome.policy is ConflictPolicy.HOLD_FOR_REVIEW
    assert outcome.source is ConflictPolicySource.DEFAULT
    assert outcome.action is ConflictAction.HOLD


# --- resolution precedence --------------------------------------------------


def test_resolution_walks_file_then_repository_then_default() -> None:
    """The three-level precedence, each level reported by its source."""
    from_file = resolve_conflict_policy(
        file_policy="new-branch", repository_policy="overwrite"
    )
    assert (from_file.policy, from_file.source) == (
        ConflictPolicy.NEW_BRANCH,
        ConflictPolicySource.FILE,
    )

    from_repo = resolve_conflict_policy(file_policy=None, repository_policy="overwrite")
    assert (from_repo.policy, from_repo.source) == (
        ConflictPolicy.OVERWRITE,
        ConflictPolicySource.REPOSITORY,
    )

    from_default = resolve_conflict_policy(file_policy=None, repository_policy=None)
    assert (from_default.policy, from_default.source) == (
        DEFAULT_CONFLICT_POLICY,
        ConflictPolicySource.DEFAULT,
    )


def test_an_unrecognised_token_degrades_to_the_next_broadest_level() -> None:
    """A junk value is "not set", not an error — and every fallback is the safe one."""
    resolved = resolve_conflict_policy(
        file_policy="not-a-policy", repository_policy="overwrite"
    )
    assert resolved.policy is ConflictPolicy.OVERWRITE
    assert resolved.source is ConflictPolicySource.REPOSITORY

    both_junk = resolve_conflict_policy(
        file_policy="not-a-policy", repository_policy=""
    )
    assert both_junk.policy is ConflictPolicy.HOLD_FOR_REVIEW
    assert both_junk.source is ConflictPolicySource.DEFAULT


def test_a_blank_override_does_not_shadow_the_repository_policy() -> None:
    """Blank/None at the file level means "no override", not "hold"."""
    for blank in (None, "", "   "):
        resolved = resolve_conflict_policy(
            file_policy=blank, repository_policy="new-branch"
        )
        assert resolved.policy is ConflictPolicy.NEW_BRANCH, blank
        assert resolved.source is ConflictPolicySource.REPOSITORY, blank


# --- token parsing ----------------------------------------------------------


def test_canonical_tokens_parse() -> None:
    assert parse_conflict_policy("overwrite") is ConflictPolicy.OVERWRITE
    assert parse_conflict_policy("hold-for-review") is ConflictPolicy.HOLD_FOR_REVIEW
    assert parse_conflict_policy("new-branch") is ConflictPolicy.NEW_BRANCH


def test_token_parsing_tolerates_case_padding_and_aliases() -> None:
    """Underscore/legacy spellings resolve rather than silently defaulting."""
    assert parse_conflict_policy("  NEW-BRANCH  ") is ConflictPolicy.NEW_BRANCH
    assert parse_conflict_policy("hold_for_review") is ConflictPolicy.HOLD_FOR_REVIEW
    # The RAR-4.4 guard's internal token still means hold-for-review here.
    assert parse_conflict_policy("hold") is ConflictPolicy.HOLD_FOR_REVIEW
    assert parse_conflict_policy("new_branch") is ConflictPolicy.NEW_BRANCH


def test_token_parsing_returns_the_supplied_default_when_unusable() -> None:
    assert parse_conflict_policy(None) is None
    assert parse_conflict_policy(42) is None
    assert (
        parse_conflict_policy("nonsense", default=DEFAULT_CONFLICT_POLICY)
        is ConflictPolicy.HOLD_FOR_REVIEW
    )


def test_an_enum_value_passes_through_unchanged() -> None:
    assert parse_conflict_policy(ConflictPolicy.NEW_BRANCH) is ConflictPolicy.NEW_BRANCH


def test_policy_tokens_match_the_stored_check_constraint() -> None:
    """The wire/DB tokens are the contract; changing one is a migration."""
    assert [p.value for p in ConflictPolicy] == [
        "overwrite",
        "hold-for-review",
        "new-branch",
    ]


# --- non-diverged refreshes -------------------------------------------------


def test_an_unchanged_version_applies_under_every_policy() -> None:
    """No divergence -> nothing to resolve; every policy applies the refresh."""
    for policy in ConflictPolicy:
        outcome = decide_conflict(
            post_import_checksum=SNAPSHOT,
            current_checksum=SNAPSHOT,
            repository_policy=policy.value,
            base_branch="main",
        )
        assert outcome.action is ConflictAction.APPLY, policy
        assert outcome.diverged is False, policy
        assert outcome.reason is DivergenceReason.UNCHANGED, policy
        assert outcome.branch_name is None, policy


def test_no_baseline_fails_open_under_every_policy() -> None:
    """Without a post-import snapshot the guard cannot prove an edit (RAR-4.4)."""
    for policy in ConflictPolicy:
        outcome = decide_conflict(
            post_import_checksum=None,
            current_checksum=EDITED,
            repository_policy=policy.value,
        )
        assert outcome.action is ConflictAction.APPLY, policy
        assert outcome.diverged is False, policy
        assert outcome.reason is DivergenceReason.NO_BASELINE, policy


def test_missing_current_content_is_treated_as_a_difference() -> None:
    """A snapshot with no readable current content holds under the default."""
    outcome = decide_conflict(post_import_checksum=SNAPSHOT, current_checksum=None)
    assert outcome.action is ConflictAction.HOLD
    assert outcome.diverged is True


# --- branch naming ----------------------------------------------------------


def test_branch_name_is_deterministic() -> None:
    """Two refreshes of the same commit target one branch, not near-duplicates."""
    args = dict(base_branch="main", path="specs/petstore.yaml", commit_sha="deadbeefcafe1234")
    assert refresh_branch_name(**args) == refresh_branch_name(**args)


def test_branch_name_sanitises_unsafe_ref_characters() -> None:
    name = refresh_branch_name(
        base_branch="feature/API v2 (draft)",
        path="specs/pet store.yaml",
        commit_sha="abc123",
    )
    assert name is not None
    assert " " not in name and "(" not in name and ")" not in name
    assert name.startswith("apiome-refresh/feature/API-v2-draft")


def test_branch_name_needs_a_base_branch() -> None:
    """No branch context -> no name; the caller must supply one."""
    assert refresh_branch_name(base_branch=None) is None
    assert refresh_branch_name(base_branch="   ") is None


def test_branch_name_tolerates_missing_path_and_sha() -> None:
    assert refresh_branch_name(base_branch="main") == "apiome-refresh/main"
    assert (
        refresh_branch_name(base_branch="main", commit_sha="abcdef123456789")
        == "apiome-refresh/main/abcdef123456"
    )


def test_new_branch_policy_without_branch_context_still_protects_the_version() -> None:
    """The action stands even when no name could be built; nothing is clobbered."""
    outcome = _diverged(repository_policy="new-branch")
    assert outcome.action is ConflictAction.NEW_BRANCH
    assert outcome.branch_name is None
