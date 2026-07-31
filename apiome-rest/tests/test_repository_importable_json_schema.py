"""JSON Schema files count as importable in the repository file index.

``json-schema`` is a first-class import source (``import_pipeline._DETECTORS``), but the
scanner collapses every ``.json`` blob to the generic ``json-candidate`` kind, so the kind
alone cannot separate a schema from a ``package.json``. Importability is decided on the
filename shape instead — the same two shapes the ``json_schema`` browser preset advertises.

These pin both halves: the Python predicate the scanner counts with, and the SQL mirror the
file browser filters with (the two must agree, or the header count and the list disagree).
"""

import inspect

import pytest

from app.database import REPOSITORY_FILE_IMPORTABLE_SQL, Database
from app.repository_file_scan import (
    _importable_hint,
    detected_kind_from_path,
    json_schema_shaped_path,
)


@pytest.mark.parametrize(
    "path",
    [
        "user.schema.json",
        "schemas/example.json",
        "enterprise/e2e/auth-closed/schemas/classified.json",
        "enterprise/e2e/auth-path/schemas/nested/deep.json",
        "SCHEMAS/Example.JSON",
        "models/order.schema.json",
    ],
)
def test_schema_shaped_names_are_importable(path: str) -> None:
    # The scanner labels all of these with the generic JSON kind...
    assert detected_kind_from_path(path) == "json-candidate"
    # ...but the filename shape promotes them to importable.
    assert json_schema_shaped_path(path) is True
    assert _importable_hint(detected_kind_from_path(path), path) is True


@pytest.mark.parametrize(
    "path",
    [
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "src/config/settings.json",
        "one.json",
        "enterprise/e2e/auth-closed/realm.json",
    ],
)
def test_plain_json_names_are_not_importable(path: str) -> None:
    assert detected_kind_from_path(path) == "json-candidate"
    assert json_schema_shaped_path(path) is False
    assert _importable_hint(detected_kind_from_path(path), path) is False


def test_non_json_paths_are_never_schema_shaped() -> None:
    assert json_schema_shaped_path("schemas/notes.md") is False
    assert json_schema_shaped_path("schemas/") is False
    assert json_schema_shaped_path("") is False


def test_established_kinds_stay_importable_without_a_path() -> None:
    # The path argument is a tiebreak for JSON only; every other kind is decided by kind
    # alone, so callers that pass no path keep working.
    assert _importable_hint("openapi-candidate") is True
    assert _importable_hint("protobuf-candidate") is True
    assert _importable_hint("yaml-candidate", "config/values.yaml") is False
    assert _importable_hint(None, "user.schema.json") is False


def test_sql_mirror_matches_the_python_predicate() -> None:
    """The browser's SQL filter must admit the same JSON shapes the scanner counts.

    Deriving importability from the stored ``path`` is what lets already-indexed
    repositories pick this up without a re-scan, so the SQL arm is load-bearing.
    """
    assert "f.detected_kind ILIKE 'json%%'" in REPOSITORY_FILE_IMPORTABLE_SQL
    assert "f.path ILIKE '%%.schema.json'" in REPOSITORY_FILE_IMPORTABLE_SQL
    assert "f.path ILIKE '%%/schemas/%%.json'" in REPOSITORY_FILE_IMPORTABLE_SQL
    assert "f.path ILIKE 'schemas/%%.json'" in REPOSITORY_FILE_IMPORTABLE_SQL


def test_every_sql_consumer_uses_the_shared_predicate() -> None:
    """Both the browser page query and the scan's count helper share one mirror.

    REPO-2.5 added ``count_tenant_repository_files``; keeping both on the module
    constant is what stops the two from drifting apart.
    """
    for method in (
        Database.tenant_repository_files_stats_and_page,
        Database.count_tenant_repository_files,
    ):
        src = inspect.getsource(method)
        assert "REPOSITORY_FILE_IMPORTABLE_SQL" in src
