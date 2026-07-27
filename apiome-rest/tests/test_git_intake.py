"""Git-repository intake for adapter formats — MFI-29.3 (#4390).

The network boundary is the :class:`~app.git_intake.GitRepositoryClient` protocol, so
every test here drives a deterministic in-memory repository rather than mocking HTTP.
"""

from __future__ import annotations

import base64
import io
import zipfile
from pathlib import Path
from typing import Dict, Optional, Sequence

import pytest

from app.archive_intake import ArchivePolicy, unpack_archive
from app.fileset import IntakeFileset
from app.git_intake import (
    GIT_INTAKE_KIND,
    GitBlob,
    GitCommitRef,
    GitIntakeError,
    GitSelector,
    fetch_git_fileset,
    git_provenance_metadata,
    matches_git_path,
    pack_fileset_zip,
    selection_prefix,
)
from app.graphql_import_source import GraphQlImportSource
from app.import_source_pipeline import run_adapter_import_job

_FIXTURES = Path(__file__).parent / "fixtures"
_PROTO = _FIXTURES / "proto"
_GRAPHQL = _FIXTURES / "graphql"

_COMMIT = "9f1c0de5b4a37821cc0d4f3a6a5b0e2d1c8a7b60"
_REPO_URL = "https://github.com/acme/specs"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class FakeRepositoryClient:
    """In-memory :class:`GitRepositoryClient` over a fixed path → text mapping.

    Records the files it was asked to read so tests can assert that only selected
    blobs are downloaded (the tree listing is cheap; blob reads are not).
    """

    def __init__(
        self,
        files: Dict[str, str],
        *,
        default_branch: str = "main",
        commit_sha: str = _COMMIT,
        sizes: Optional[Dict[str, int]] = None,
    ) -> None:
        self.files = files
        self.default_branch = default_branch
        self.commit_sha = commit_sha
        self.sizes = sizes or {}
        self.read_paths: list[str] = []

    def resolve_ref(self, owner: str, repo: str, ref: Optional[str]) -> GitCommitRef:
        return GitCommitRef(ref=(ref or self.default_branch), commit_sha=self.commit_sha)

    def list_tree(self, owner: str, repo: str, commit_sha: str) -> Sequence[GitBlob]:
        return [
            GitBlob(
                path=path,
                size=self.sizes.get(path, len(text.encode("utf-8"))),
            )
            for path, text in sorted(self.files.items())
        ]

    def read_file(
        self, owner: str, repo: str, path: str, commit_sha: str, *, max_bytes: int
    ) -> str:
        self.read_paths.append(path)
        return self.files[path]


def _proto_repo() -> FakeRepositoryClient:
    """A repository whose protos live under ``protos/`` beside unrelated files."""
    return FakeRepositoryClient(
        {
            "README.md": "# Specs\n",
            "protos/common/types.proto": _read(_PROTO / "common" / "types.proto"),
            "protos/user/user_service.proto": _read(_PROTO / "user" / "user_service.proto"),
            "docs/logo.png": "binary-ish",
            ".github/workflows/ci.yml": "on: push\n",
            "node_modules/pkg/index.proto": 'syntax = "proto3";\n',
        }
    )


def _graphql_repo() -> FakeRepositoryClient:
    return FakeRepositoryClient(
        {
            "schema/schema.query.graphql": _read(_GRAPHQL / "schema.query.graphql"),
            "schema/schema.types.graphql": _read(_GRAPHQL / "schema.types.graphql"),
            "schema/schema.mutation.graphql": _read(_GRAPHQL / "schema.mutation.graphql"),
        }
    )


# ---------------------------------------------------------------------------
# Selection matching
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "pattern", "expected"),
    [
        ("protos/user/user_service.proto", "", True),
        ("protos/user/user_service.proto", "protos", True),
        ("protos/user/user_service.proto", "protos/", True),
        ("protos/user/user_service.proto", "protos/**", True),
        ("protos/user/user_service.proto", "**/*.proto", True),
        ("protos/user/user_service.proto", "protos/*.proto", False),
        ("protos/types.proto", "protos/*.proto", True),
        ("protos/user/user_service.proto", "protos/user/user_service.proto", True),
        ("protos/user/user_service.proto", "schemas/**", False),
        ("README.md", "**/*.proto", False),
        ("api.graphql", "*.graphql", True),
        ("nested/api.graphql", "*.graphql", False),
        ("v1/api.yaml", "v?/api.yaml", True),
        ("v1/api.yaml", "v[0-9]/api.yaml", True),
        ("vx/api.yaml", "v[0-9]/api.yaml", False),
    ],
)
def test_matches_git_path(path: str, pattern: str, expected: bool) -> None:
    assert matches_git_path(path, pattern) is expected


@pytest.mark.parametrize(
    ("pattern", "expected"),
    [
        ("", ""),
        ("protos", "protos/"),
        ("protos/", "protos/"),
        ("protos/**", "protos/"),
        ("protos/**/*.proto", "protos/"),
        ("**/*.proto", ""),
        ("api/v1", "api/v1/"),
        # A directory whose name contains a dot still anchors at itself.
        ("api/v1.0", "api/v1.0/"),
    ],
)
def test_selection_prefix(pattern: str, expected: str) -> None:
    assert selection_prefix(pattern) == expected


def test_selection_prefix_anchors_an_exact_file_at_its_directory() -> None:
    # Only the tree knows a static path names a file, so the caller passes that in.
    assert selection_prefix("protos/user/user_service.proto", exact_file=True) == "protos/user/"
    assert (
        selection_prefix("protos/user/user_service.proto") == "protos/user/user_service.proto/"
    )


# ---------------------------------------------------------------------------
# Fetching a selection
# ---------------------------------------------------------------------------


def test_fetch_directory_selection_strips_prefix_and_resolves_root() -> None:
    client = _proto_repo()
    result = fetch_git_fileset(
        GitSelector(repo_url=_REPO_URL, ref="main", path="protos/"), client=client
    )

    # Prefix stripping keeps proto import paths ("common/types.proto") resolvable.
    assert sorted(result.members) == ["common/types.proto", "user/user_service.proto"]
    assert result.root_path == "user/user_service.proto"
    assert result.detection.matched
    assert client.read_paths == [
        "protos/common/types.proto",
        "protos/user/user_service.proto",
    ]


def test_selection_skips_noise_without_dropping_it_silently() -> None:
    client = _proto_repo()
    result = fetch_git_fileset(GitSelector(repo_url=_REPO_URL, path=""), client=client)

    skipped = {item.path: item.reason for item in result.skipped}
    assert skipped["docs/logo.png"] == "binary-file"
    assert skipped[".github/workflows/ci.yml"] == "excluded-directory"
    assert skipped["node_modules/pkg/index.proto"] == "excluded-directory"
    assert "README.md" in result.members


def test_provenance_records_repo_ref_and_commit() -> None:
    client = _proto_repo()
    result = fetch_git_fileset(
        GitSelector(repo_url=f"{_REPO_URL}.git", ref="v2.1.0", path="protos/**"),
        client=client,
    )

    provenance = result.provenance
    assert provenance.provider == "github"
    assert provenance.repo_url == _REPO_URL
    assert provenance.owner == "acme"
    assert provenance.repo == "specs"
    assert provenance.ref == "v2.1.0"
    assert provenance.commit_sha == _COMMIT
    assert provenance.path == "protos/**"
    assert provenance.browse_url == f"{_REPO_URL}/tree/{_COMMIT}/protos"


def test_default_branch_is_used_when_no_ref_given() -> None:
    client = FakeRepositoryClient(
        {"api.graphql": _read(_GRAPHQL / "schema.query.graphql")}, default_branch="trunk"
    )
    result = fetch_git_fileset(GitSelector(repo_url=_REPO_URL), client=client)
    assert result.provenance.ref == "trunk"


def test_exact_file_selection_anchors_at_its_directory() -> None:
    client = _proto_repo()
    result = fetch_git_fileset(
        GitSelector(repo_url=_REPO_URL, path="protos/user/user_service.proto"),
        client=client,
    )
    assert sorted(result.members) == ["user_service.proto"]
    assert result.root_path == "user_service.proto"


def test_explicit_root_overrides_detection() -> None:
    client = _proto_repo()
    result = fetch_git_fileset(
        GitSelector(repo_url=_REPO_URL, path="protos/", root="common/types.proto"),
        client=client,
    )
    assert result.root_path == "common/types.proto"


def test_empty_selection_is_a_taxonomy_error() -> None:
    client = _proto_repo()
    with pytest.raises(GitIntakeError) as excinfo:
        fetch_git_fileset(GitSelector(repo_url=_REPO_URL, path="schemas/**"), client=client)
    assert excinfo.value.code == "SOURCE_SELECTION_EMPTY"


def test_non_github_repo_url_is_rejected_before_any_fetch() -> None:
    client = _proto_repo()
    with pytest.raises(GitIntakeError) as excinfo:
        fetch_git_fileset(
            GitSelector(repo_url="https://gitlab.com/acme/specs", path="protos/"),
            client=client,
        )
    assert excinfo.value.code == "SOURCE_PROVIDER_UNSUPPORTED"
    assert client.read_paths == []


def test_selection_over_entry_budget_is_refused() -> None:
    client = _proto_repo()
    policy = ArchivePolicy(
        max_entries=1, max_total_bytes=1_000_000, max_file_bytes=100_000, max_depth=8
    )
    with pytest.raises(GitIntakeError) as excinfo:
        fetch_git_fileset(
            GitSelector(repo_url=_REPO_URL, path="protos/"), client=client, policy=policy
        )
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_selection_over_total_byte_budget_is_refused() -> None:
    client = _proto_repo()
    policy = ArchivePolicy(
        max_entries=50, max_total_bytes=64, max_file_bytes=100_000, max_depth=8
    )
    with pytest.raises(GitIntakeError) as excinfo:
        fetch_git_fileset(
            GitSelector(repo_url=_REPO_URL, path="protos/"), client=client, policy=policy
        )
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_oversized_blob_is_skipped_not_fetched() -> None:
    client = _proto_repo()
    client.sizes["protos/common/types.proto"] = 10_000_000
    policy = ArchivePolicy(
        max_entries=50, max_total_bytes=1_000_000, max_file_bytes=1_000, max_depth=8
    )
    result = fetch_git_fileset(
        GitSelector(repo_url=_REPO_URL, path="protos/"), client=client, policy=policy
    )
    assert [item.reason for item in result.skipped] == ["too-large"]
    assert "common/types.proto" not in result.members
    assert "protos/common/types.proto" not in client.read_paths


def test_traversal_in_a_repository_path_is_refused() -> None:
    client = FakeRepositoryClient({"protos/../../escape.proto": 'syntax = "proto3";\n'})
    with pytest.raises(GitIntakeError) as excinfo:
        fetch_git_fileset(GitSelector(repo_url=_REPO_URL, path=""), client=client)
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


def test_selection_without_a_recognisable_format_is_refused() -> None:
    client = FakeRepositoryClient({"docs/notes.txt": "just some prose\n"})
    with pytest.raises(GitIntakeError) as excinfo:
        fetch_git_fileset(GitSelector(repo_url=_REPO_URL, path="docs/"), client=client)
    assert "Repository selection" in str(excinfo.value)


# ---------------------------------------------------------------------------
# Packing and provenance metadata
# ---------------------------------------------------------------------------


def test_pack_fileset_zip_is_deterministic_and_unpacks_to_the_same_members() -> None:
    client = _proto_repo()
    result = fetch_git_fileset(GitSelector(repo_url=_REPO_URL, path="protos/"), client=client)

    first = pack_fileset_zip(result.members)
    second = pack_fileset_zip(dict(reversed(list(result.members.items()))))
    assert first == second

    with zipfile.ZipFile(io.BytesIO(first)) as archive:
        assert [info.date_time for info in archive.infolist()] == [
            (1980, 1, 1, 0, 0, 0)
        ] * len(result.members)

    unpacked = unpack_archive(first, source_label="specs.zip")
    assert unpacked.members == result.members
    assert unpacked.root_path == result.root_path


def test_git_provenance_metadata_marks_intake_kind_and_source_uri() -> None:
    fields = git_provenance_metadata(
        {
            "provider": "github",
            "repo_url": _REPO_URL,
            "ref": "main",
            "commit_sha": _COMMIT,
            "path": "protos/**",
            "browse_url": f"{_REPO_URL}/tree/{_COMMIT}/protos",
        }
    )
    assert fields["intakeKind"] == GIT_INTAKE_KIND
    assert fields["gitRepoUrl"] == _REPO_URL
    assert fields["gitCommit"] == _COMMIT
    assert fields["gitRef"] == "main"
    assert fields["gitPath"] == "protos/**"
    assert fields["sourceUri"] == f"{_REPO_URL}/tree/{_COMMIT}/protos"


def test_git_provenance_metadata_omits_absent_fields() -> None:
    fields = git_provenance_metadata({"repo_url": _REPO_URL, "ref": "", "commit_sha": _COMMIT})
    assert "gitRef" not in fields
    assert "sourceUri" not in fields
    assert fields["intakeKind"] == GIT_INTAKE_KIND


# ---------------------------------------------------------------------------
# End-to-end through the existing adapter pipeline
# ---------------------------------------------------------------------------


def test_fetched_selection_is_a_valid_fileset_for_adapters() -> None:
    client = _graphql_repo()
    # Split SDL has no single detectable entrypoint (every file is valid GraphQL), so the
    # root is named explicitly — the same choice an archive upload of this tree requires.
    result = fetch_git_fileset(
        GitSelector(repo_url=_REPO_URL, path="schema/", root="schema.query.graphql"),
        client=client,
    )
    fileset = IntakeFileset.from_members(result.members, root=result.root_path)
    schema = GraphQlImportSource().parse_fileset(fileset)
    assert schema.query_type is not None


@pytest.mark.asyncio
async def test_pipeline_imports_a_packed_git_selection() -> None:
    """The packed selection runs the unchanged archive → fileset → adapter path."""
    client = _graphql_repo()
    result = fetch_git_fileset(
        GitSelector(
            repo_url=_REPO_URL, ref="main", path="schema/", root="schema.query.graphql"
        ),
        client=client,
    )
    payload = {
        "rest_job_id": "job-git-1",
        "tenant_id": "tenant-1",
        "filename": "specs-main.zip",
        "document_base64": base64.standard_b64encode(
            pack_fileset_zip(result.members)
        ).decode("ascii"),
        "metadata": {
            "source_kind": "graphql",
            "project": {"name": "Specs", "slug": "specs"},
            "version": {"version_id": "1.0.0"},
            "options": {
                "dry_run": True,
                "input_kind": "fileset",
                "archive_root": result.root_path,
                "git_source": result.provenance.as_dict(),
            },
        },
    }
    status = await run_adapter_import_job(GraphQlImportSource(), payload)
    assert status.state == "completed", [event.message for event in status.events]
