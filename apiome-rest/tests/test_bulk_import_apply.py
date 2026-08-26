"""Unit tests for the batch apply decision (BLK-1.3, #5525).

:mod:`app.bulk_import_apply` turns one plan row plus one reviewer override into the
destination a job is submitted with. These drive that function directly — no plan, no HTTP,
no database — so every branch of "append or create, which project, which version" is covered
where it is decided rather than through a batch that happens to exercise it.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

import pytest

from app.bulk_import_apply import (
    TARGET_DECISION_REQUIRED,
    ItemOverride,
    ItemTargetError,
    OverrideMode,
    TargetAction,
    decide_item_target,
    parse_override_mode,
)
from app.bulk_import_reconciliation import (
    ItemResolution,
    MatchBasis,
    ProjectMatch,
    ProposedVersion,
    Resolution,
    VersionDerivation,
)

PROJECT = "660e8400-e29b-41d4-a716-446655440001"
OTHER_PROJECT = "660e8400-e29b-41d4-a716-4466554400ff"
DEFAULT_VERSION = "1.0.0"


def _match(
    project_id: str = PROJECT,
    *,
    name: str = "Orders API",
    slug: str = "orders-api",
    publishable: bool = True,
) -> ProjectMatch:
    return ProjectMatch(
        project_id=project_id,
        name=name,
        slug=slug,
        basis=MatchBasis.SLUG,
        confidence=0.8,
        detail="An existing project already uses this slug.",
        publishable=publishable,
    )


def _resolution(
    resolution: Resolution,
    *,
    match: Optional[ProjectMatch] = None,
    version_id: str = DEFAULT_VERSION,
) -> ItemResolution:
    return ItemResolution(
        resolution=resolution,
        match=match,
        proposed_version=ProposedVersion(
            version_id=version_id, derived_from=VersionDerivation.DEFAULT
        ),
    )


class _Labels:
    """Version labels per project, counting the reads the decision makes."""

    def __init__(self, labels: Optional[Dict[str, List[str]]] = None) -> None:
        self.labels = labels or {}
        self.reads: List[str] = []

    def __call__(self, project_id: str) -> Sequence[str]:
        self.reads.append(project_id)
        return tuple(self.labels.get(project_id, ()))


def _decide(resolved: ItemResolution, override: Optional[ItemOverride] = None, **kwargs):
    labels = kwargs.pop("labels", None) or _Labels()
    return decide_item_target(
        resolved,
        override,
        suggested_name=kwargs.pop("suggested_name", "Orders API"),
        suggested_slug=kwargs.pop("suggested_slug", "orders-api"),
        default_version_id=DEFAULT_VERSION,
        version_labels=labels,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Applying the plan, with no override at all
# ---------------------------------------------------------------------------


def test_an_unmatched_item_creates_a_project_at_the_batch_default():
    target = _decide(_resolution(Resolution.CREATE_PROJECT))

    assert target.action is TargetAction.CREATE_PROJECT
    assert target.project_id is None
    assert (target.name, target.slug) == ("Orders API", "orders-api")
    assert target.version_id == DEFAULT_VERSION
    assert target.lands_on is None
    assert target.overridden is False


def test_a_matched_item_appends_the_next_version_to_that_project():
    labels = _Labels({PROJECT: ["1.0.0", "1.1.0"]})

    target = _decide(
        _resolution(Resolution.APPEND_VERSION, match=_match()), labels=labels
    )

    assert target.action is TargetAction.APPEND_VERSION
    assert target.project_id == PROJECT
    assert target.lands_on == PROJECT
    # Derived from the target project's own labels — the same computation the plan used.
    assert target.version_id == "1.2.0"
    assert labels.reads == [PROJECT]
    assert "Orders API" in target.detail


def test_an_append_derives_the_first_version_when_the_project_is_empty():
    target = _decide(_resolution(Resolution.APPEND_VERSION, match=_match()))

    assert target.version_id == DEFAULT_VERSION


def test_an_unresolved_item_with_no_override_is_refused_rather_than_guessed_at():
    with pytest.raises(ItemTargetError) as excinfo:
        _decide(_resolution(Resolution.UNRESOLVED, match=_match()))

    assert excinfo.value.code == TARGET_DECISION_REQUIRED
    assert "always-ask" in excinfo.value.message


def test_an_append_resolution_that_matched_nothing_cannot_append():
    """A resolution says append but carries no project — refuse, never invent one."""
    with pytest.raises(ItemTargetError) as excinfo:
        _decide(_resolution(Resolution.APPEND_VERSION, match=None))

    assert excinfo.value.code == TARGET_DECISION_REQUIRED


# ---------------------------------------------------------------------------
# Overrides
# ---------------------------------------------------------------------------


def test_overriding_an_append_to_new_creates_a_project_instead():
    target = _decide(
        _resolution(Resolution.APPEND_VERSION, match=_match(), version_id="1.4.0"),
        ItemOverride(mode=OverrideMode.NEW),
    )

    assert target.action is TargetAction.CREATE_PROJECT
    assert target.project_id is None
    assert target.lands_on is None
    # A project that does not exist yet has no history, so it starts at the batch default
    # rather than at the label the abandoned append had proposed.
    assert target.version_id == DEFAULT_VERSION
    assert target.overridden is True


def test_overriding_a_create_to_existing_appends_to_the_named_project():
    labels = _Labels({OTHER_PROJECT: ["2.3.0"]})

    target = _decide(
        _resolution(Resolution.CREATE_PROJECT),
        ItemOverride(mode=OverrideMode.EXISTING, project_id=OTHER_PROJECT),
        labels=labels,
    )

    assert target.action is TargetAction.APPEND_VERSION
    assert target.project_id == OTHER_PROJECT
    assert target.lands_on == OTHER_PROJECT
    # The label follows *that* project's history, not the abandoned create's default.
    assert target.version_id == "2.4.0"
    assert target.overridden is True


def test_naming_a_project_is_itself_the_decision():
    """`project_id` without a mode still means "append to this one"."""
    target = _decide(
        _resolution(Resolution.CREATE_PROJECT), ItemOverride(project_id=OTHER_PROJECT)
    )

    assert target.action is TargetAction.APPEND_VERSION
    assert target.project_id == OTHER_PROJECT


def test_existing_with_no_project_id_falls_back_to_the_match():
    target = _decide(
        _resolution(Resolution.CREATE_PROJECT, match=_match()),
        ItemOverride(mode=OverrideMode.EXISTING),
    )

    assert target.action is TargetAction.APPEND_VERSION
    assert target.project_id == PROJECT


def test_existing_with_neither_a_project_id_nor_a_match_is_refused():
    with pytest.raises(ItemTargetError) as excinfo:
        _decide(
            _resolution(Resolution.CREATE_PROJECT), ItemOverride(mode=OverrideMode.EXISTING)
        )

    assert excinfo.value.code == TARGET_DECISION_REQUIRED
    assert "project_id" in excinfo.value.message


def test_an_unresolved_item_is_decidable_by_an_override():
    target = _decide(
        _resolution(Resolution.UNRESOLVED, match=_match()),
        ItemOverride(mode=OverrideMode.EXISTING),
    )

    assert target.action is TargetAction.APPEND_VERSION
    assert target.project_id == PROJECT


def test_a_version_only_override_keeps_the_plans_resolution():
    labels = _Labels({PROJECT: ["1.0.0"]})

    target = _decide(
        _resolution(Resolution.APPEND_VERSION, match=_match()),
        ItemOverride(version_id="2.0.0"),
        labels=labels,
    )

    assert target.action is TargetAction.APPEND_VERSION
    assert target.project_id == PROJECT
    assert target.version_id == "2.0.0"
    assert target.overridden is True
    # The pinned label makes the derivation unnecessary, so the project is never read.
    assert labels.reads == []


def test_a_version_only_override_also_names_a_created_projects_first_version():
    target = _decide(
        _resolution(Resolution.CREATE_PROJECT), ItemOverride(version_id="0.9.0")
    )

    assert target.action is TargetAction.CREATE_PROJECT
    assert target.version_id == "0.9.0"


def test_a_blank_override_decides_nothing():
    assert ItemOverride().is_empty() is True
    # Whitespace is absence, not a decision.
    assert ItemOverride(version_id="  ", project_id=" ").is_empty() is True

    target = _decide(_resolution(Resolution.CREATE_PROJECT), ItemOverride())

    assert target.overridden is False
    assert target.version_id == DEFAULT_VERSION


# ---------------------------------------------------------------------------
# Catalog items append by slug, not by id
# ---------------------------------------------------------------------------


def test_a_matched_catalog_item_is_appended_to_by_slug():
    """BLK-1.1 refuses a catalog item by id, so the append is expressed the way it lands."""
    labels = _Labels({PROJECT: ["1.0.0"]})

    target = _decide(
        _resolution(
            Resolution.APPEND_VERSION,
            match=_match(slug="orders-proto", name="orders", publishable=False),
        ),
        labels=labels,
    )

    assert target.action is TargetAction.APPEND_VERSION
    # The revision still lands on that project — it just is not named by id.
    assert target.lands_on == PROJECT
    assert target.project_id is None
    assert (target.name, target.slug) == ("orders", "orders-proto")
    assert target.version_id == "1.1.0"
    assert "by slug" in target.detail


def test_an_explicitly_named_catalog_item_is_left_for_blk_1_1_to_refuse():
    target = _decide(
        _resolution(
            Resolution.APPEND_VERSION,
            match=_match(slug="orders-proto", publishable=False),
        ),
        ItemOverride(mode=OverrideMode.EXISTING, project_id=PROJECT),
    )

    # The reviewer named the project rather than accepting a match, so the id is submitted
    # as an id and TARGET_NOT_PUBLISHABLE is the honest answer to it.
    assert target.project_id == PROJECT


# ---------------------------------------------------------------------------
# Mode parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("existing", OverrideMode.EXISTING),
        ("EXISTING", OverrideMode.EXISTING),
        ("append", OverrideMode.EXISTING),
        ("append-version", OverrideMode.EXISTING),
        ("new", OverrideMode.NEW),
        ("create", OverrideMode.NEW),
        ("create-project", OverrideMode.NEW),
        ("  new  ", OverrideMode.NEW),
        (None, None),
        ("", None),
    ],
)
def test_parse_override_mode(token, expected):
    assert parse_override_mode(token) is expected


def test_parse_override_mode_refuses_a_word_it_does_not_know():
    with pytest.raises(ValueError, match="not a target mode"):
        parse_override_mode("maybe")
