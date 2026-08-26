"""Unit tests for narrowing a bulk batch to ticked repository files (BLK-1.5, #5524 follow-up).

:mod:`app.bulk_import_selection` is the translation between a repository *selection* (a
directory, a glob, the whole tree) and what a reader actually ticked in the Files tab. These
drive the pure rules directly: path cleaning, re-anchoring a member onto the repository root,
and the partition of planned item roots into "ticked" and "ticked but not a root".
"""

from __future__ import annotations

import pytest

from app.bulk_import_selection import (
    NOT_AN_ITEM_ROOT,
    normalize_selection_paths,
    partition_requested_roots,
    repository_relative_path,
)

# ---------------------------------------------------------------------------
# normalize_selection_paths
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("paths", [None, [], ["", "   "], [None, 7]])
def test_nothing_usable_means_no_narrowing_requested(paths):
    """Empty is how a caller says "plan everything" — it must never mean "plan nothing"."""
    assert normalize_selection_paths(paths) == ()


def test_leading_slashes_and_dot_segments_are_stripped():
    """The repository index stores 'specs/a.yaml'; a client may send any of these spellings."""
    assert normalize_selection_paths(
        ["/specs/a.yaml", "./specs/b.yaml", ".//specs/c.yaml", "  specs/d.yaml  "]
    ) == ("specs/a.yaml", "specs/b.yaml", "specs/c.yaml", "specs/d.yaml")


def test_duplicate_ticks_collapse_but_order_is_kept():
    assert normalize_selection_paths(["b.yaml", "a.yaml", "b.yaml", "/b.yaml"]) == (
        "b.yaml",
        "a.yaml",
    )


# ---------------------------------------------------------------------------
# repository_relative_path
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "prefix,member,expected",
    [
        ("", "specs/orders.yaml", "specs/orders.yaml"),
        ("specs", "orders.yaml", "specs/orders.yaml"),
        ("specs/", "orders.yaml", "specs/orders.yaml"),
        ("/specs/", "orders.yaml", "specs/orders.yaml"),
    ],
)
def test_members_re_anchor_onto_the_repository_root(prefix, member, expected):
    """The comparable form is also what MFI-29.3 records as format_metadata.gitPath."""
    assert repository_relative_path(prefix, member) == expected


# ---------------------------------------------------------------------------
# partition_requested_roots
# ---------------------------------------------------------------------------


_ROOTS = [
    ("orders.yaml", "specs/orders.yaml"),
    ("shipping.yaml", "specs/shipping.yaml"),
    ("orders.proto", "protos/orders.proto"),
]


def test_only_ticked_roots_are_kept_and_plan_order_survives():
    kept, unmatched = partition_requested_roots(
        _ROOTS, ["protos/orders.proto", "specs/orders.yaml"]
    )
    assert kept == ["orders.yaml", "orders.proto"]
    assert unmatched == []


def test_a_ticked_file_that_is_no_items_root_is_reported_rather_than_dropped():
    """Ticking a shared type file another item compiles names no item of its own."""
    kept, unmatched = partition_requested_roots(
        _ROOTS, ["specs/orders.yaml", "protos/common/types.proto"]
    )
    assert kept == ["orders.yaml"]
    assert unmatched == ["protos/common/types.proto"]


def test_ticking_nothing_that_matches_keeps_nothing_and_reports_everything():
    kept, unmatched = partition_requested_roots(_ROOTS, ["nope.yaml"])
    assert kept == []
    assert unmatched == ["nope.yaml"]


def test_the_reason_token_is_stable():
    """The wire value the UI keys its explanation off."""
    assert NOT_AN_ITEM_ROOT == "not-an-item-root"
