"""Reading exactly the ticked repository files, plus what they reference (BLK-1.5).

:func:`app.git_intake.fetch_git_files` exists because the two questions are different. A
*selection* ("specs/", "**/*.yaml") is answered by reading everything it matches; four rows
ticked in a repository's Files tab cannot be, because narrowing the read to their shared
directory drops the siblings they compile and not narrowing it means reading a whole monorepo —
which the intake budget refuses outright, however small the ticked files are.

What is under test is that reading from the ticked end stays *small* and stays *complete*: the
tree listing is free, only the closure is downloaded, and a ticked document arrives with
everything it needs to compile.
"""

from __future__ import annotations

from typing import Dict

import pytest
from test_git_intake import _COMMIT, _REPO_URL, FakeRepositoryClient

from app.archive_intake import ArchivePolicy
from app.git_intake import GitIntakeError, GitSelector, fetch_git_files

_ORDERS_PROTO = """
syntax = "proto3";
package orders;
import "protos/common/types.proto";
message Order { Money total = 1; }
"""

_TYPES_PROTO = """
syntax = "proto3";
package common;
message Money { string currency = 1; }
"""

_OPENAPI = """
openapi: 3.0.3
info:
  title: Orders API
  version: 1.0.0
paths: {}
components:
  schemas:
    Money:
      $ref: './shared/money.yaml#/Money'
"""

_MONEY = """
Money:
  type: object
"""

_REPO: Dict[str, str] = {
    "protos/orders/orders.proto": _ORDERS_PROTO,
    "protos/common/types.proto": _TYPES_PROTO,
    "openapi/orders.yaml": _OPENAPI,
    "openapi/shared/money.yaml": _MONEY,
    "README.md": "# specs\n",
    **{f"noise/file-{index}.yaml": "unrelated: true\n" for index in range(60)},
}


def _selector() -> GitSelector:
    return GitSelector(repo_url=_REPO_URL, ref="main", path="", root=None)


def _fetch(paths, *, files=None, policy=None):
    repo = FakeRepositoryClient(files or _REPO)
    result = fetch_git_files(_selector(), paths, client=repo, policy=policy)
    return result, repo


def test_only_the_ticked_file_is_downloaded() -> None:
    """The tree listing is cheap; blob reads are not, and a monorepo is mostly noise."""
    result, repo = _fetch(["README.md"])

    assert set(result.members) == {"README.md"}
    assert repo.read_paths == ["README.md"]


def test_a_protobuf_import_outside_the_ticked_directory_comes_too() -> None:
    """The reason narrowing the read to the ticked files' directory is not a valid shortcut."""
    result, repo = _fetch(["protos/orders/orders.proto"])

    assert set(result.members) == {
        "protos/orders/orders.proto",
        "protos/common/types.proto",
    }
    assert "protos/common/types.proto" in repo.read_paths


def test_a_relative_ref_is_followed_the_same_way() -> None:
    result, _repo = _fetch(["openapi/orders.yaml"])

    assert set(result.members) == {"openapi/orders.yaml", "openapi/shared/money.yaml"}


def test_the_sixty_unrelated_files_are_never_read() -> None:
    """A selection over this repository breaches the entry budget; ticked files do not."""
    _result, repo = _fetch(["protos/orders/orders.proto"])

    assert not [path for path in repo.read_paths if path.startswith("noise/")]
    assert len(repo.read_paths) == 2


def test_members_are_keyed_from_the_repository_root() -> None:
    """So an item's path matches the Files tab and the gitPath an earlier import recorded."""
    result, _repo = _fetch(["openapi/orders.yaml"])

    assert "openapi/orders.yaml" in result.members
    assert result.provenance.path == ""
    assert result.provenance.commit_sha == _COMMIT
    # No single root: a ticked batch is partitioned per item downstream, like any bulk payload.
    assert result.root_path == ""


def test_ticking_several_files_reads_each_of_them() -> None:
    result, _repo = _fetch(["README.md", "openapi/orders.yaml"])

    assert set(result.members) == {
        "README.md",
        "openapi/orders.yaml",
        "openapi/shared/money.yaml",
    }


def test_duplicate_and_blank_ticks_are_harmless() -> None:
    result, repo = _fetch(["README.md", "README.md", "", "   "])

    assert set(result.members) == {"README.md"}
    assert repo.read_paths == ["README.md"]


def test_a_path_the_commit_does_not_hold_is_skipped_rather_than_fatal() -> None:
    """A stale file index names files the commit has since dropped."""
    result, _repo = _fetch(["README.md", "gone/deleted.yaml"])

    assert set(result.members) == {"README.md"}


def test_naming_nothing_the_commit_holds_is_an_empty_selection() -> None:
    with pytest.raises(GitIntakeError) as excinfo:
        _fetch(["gone/deleted.yaml"])

    assert excinfo.value.code == "SOURCE_SELECTION_EMPTY"


def test_the_entry_budget_counts_the_closure_not_the_tree() -> None:
    """Bounded from the ticked end: what was asked for, plus what it needs."""
    policy = ArchivePolicy(
        max_entries=1, max_file_bytes=1_000_000, max_total_bytes=1_000_000, max_depth=10
    )

    with pytest.raises(GitIntakeError) as excinfo:
        _fetch(["protos/orders/orders.proto"], policy=policy)

    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_the_byte_budget_still_applies() -> None:
    policy = ArchivePolicy(
        max_entries=50, max_file_bytes=1_000_000, max_total_bytes=10, max_depth=10
    )

    with pytest.raises(GitIntakeError) as excinfo:
        _fetch(["openapi/orders.yaml"], policy=policy)

    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_an_oversized_file_is_skipped_with_a_reason_rather_than_failing() -> None:
    repo = FakeRepositoryClient(_REPO, sizes={"README.md": 5_000_000})
    policy = ArchivePolicy(
        max_entries=50, max_file_bytes=1_000, max_total_bytes=1_000_000, max_depth=10
    )

    result = fetch_git_files(
        _selector(), ["README.md", "openapi/orders.yaml"], client=repo, policy=policy
    )

    assert "README.md" not in result.members
    assert ("README.md", "too-large") in [(s.path, s.reason) for s in result.skipped]
    assert "openapi/orders.yaml" in result.members


def test_a_reference_cycle_terminates() -> None:
    """Two documents referencing each other must close, not walk forever."""
    files = {
        "a.yaml": "x:\n  $ref: './b.yaml#/y'\n",
        "b.yaml": "y:\n  $ref: './a.yaml#/x'\n",
    }
    result, repo = _fetch(["a.yaml"], files=files)

    assert set(result.members) == {"a.yaml", "b.yaml"}
    assert sorted(repo.read_paths) == ["a.yaml", "b.yaml"]
