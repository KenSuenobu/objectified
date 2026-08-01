"""SQL contract of the cross-repo spec catalog DAO (REPO-6.4, #2797).

``Database.tenant_repository_spec_catalog`` assembles its query from predicate fragments, so
these tests read the SQL it hands to psycopg2 and the parameters that go with it. What matters
is not the exact text but the invariants a wrong assembly would break: tenant scoping, the
joins that resolve project and import state, parameter/placeholder alignment, and the clamps
that stop a caller asking for a million rows.
"""

from typing import Any, Dict, List, Tuple
from unittest.mock import patch

import pytest

from app.database import Database

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_REPO = "880e8400-e29b-41d4-a716-446655440003"
_PROJECT = "770e8400-e29b-41d4-a716-446655440002"


class _Recorder:
    """Stands in for ``Database.execute_query``, recording every (sql, params) pair."""

    def __init__(self, page_rows: List[Dict[str, Any]] | None = None) -> None:
        self.calls: List[Tuple[str, Tuple[Any, ...]]] = []
        self._page_rows = page_rows or []

    def __call__(self, sql: str, params: Tuple[Any, ...] = ()) -> List[Dict[str, Any]]:
        self.calls.append((sql, tuple(params or ())))
        if sql.lstrip().startswith("SELECT COUNT(*) AS c "):
            return [{"c": 7, "ic": 7}]
        if " AS k, COUNT(*) AS c " in sql:
            return [{"k": "openapi", "c": 4}]
        if " AS label, COUNT(*) AS c " in sql or " AS id, r.repository_full_name" in sql:
            return [{"id": _REPO, "label": "acme/api-platform", "c": 4}]
        return self._page_rows

    @property
    def page_call(self) -> Tuple[str, Tuple[Any, ...]]:
        """The row-fetching query — the only one that carries LIMIT/OFFSET."""
        for sql, params in self.calls:
            if " LIMIT %s OFFSET %s" in sql:
                return sql, params
        raise AssertionError("no page query was issued")


def _run(**kwargs) -> Tuple[_Recorder, Dict[str, Any]]:
    db = Database.__new__(Database)  # no connection: execute_query is the only I/O seam
    rec = _Recorder()
    with patch.object(Database, "execute_query", rec):
        result = db.tenant_repository_spec_catalog(_TENANT, **kwargs)
    return rec, result


# --- scoping ----------------------------------------------------------------------------


def test_every_query_is_scoped_to_the_tenant() -> None:
    """Cross-repo listing is exactly where a missing tenant predicate leaks another tenant."""
    rec, _ = _run(include_facets=True)
    assert rec.calls
    for sql, params in rec.calls:
        assert "r.tenant_id = %s::uuid" in sql
        assert params[0] == _TENANT


def test_soft_deleted_repositories_are_excluded() -> None:
    rec, _ = _run()
    for sql, _params in rec.calls:
        assert "r.deleted_at IS NULL" in sql


def test_only_default_branches_are_listed_by_default() -> None:
    """Otherwise one spec tracked on five branches becomes five catalog rows."""
    rec, _ = _run()
    sql, _ = rec.page_call
    assert "f.branch = COALESCE(NULLIF(r.default_branch, ''), 'main')" in sql


def test_all_branches_widens_the_scope() -> None:
    rec, _ = _run(all_branches=True)
    sql, _ = rec.page_call
    assert "f.branch = COALESCE(" not in sql


#: A fragment unique to ``REPOSITORY_FILE_IMPORTABLE_SQL`` — the format CASE the catalog
#: projects also tests ``detected_kind ILIKE 'openapi%%'``, so that alone proves nothing.
_IMPORTABLE_MARKER = "f.detected_kind IS NOT NULL AND ("


def test_importable_only_is_the_default() -> None:
    rec, _ = _run()
    sql, _ = rec.page_call
    assert _IMPORTABLE_MARKER in sql


def test_importable_only_can_be_turned_off() -> None:
    rec, _ = _run(importable_only=False)
    sql, _ = rec.page_call
    assert _IMPORTABLE_MARKER not in sql


def test_vendored_and_hidden_paths_are_always_excluded() -> None:
    """At tenant scale a single node_modules checkout would dominate the catalog."""
    rec, _ = _run()
    sql, _ = rec.page_call
    assert "f.path NOT ILIKE '%%/node_modules/%%'" in sql
    assert "f.path !~ '(^|/)\\.[^/]+(/|$)'" in sql


# --- joins ------------------------------------------------------------------------------


def test_the_project_mapping_is_joined_on_repo_branch_and_path() -> None:
    rec, _ = _run()
    sql, _ = rec.page_call
    assert "LEFT JOIN apiome.repository_import_spec spec" in sql
    assert "spec.repository_id = f.repository_id" in sql
    assert "spec.branch = f.branch" in sql
    assert "spec.path = f.path" in sql


def test_only_the_most_recent_import_is_joined() -> None:
    """A file imported fifty times must still contribute exactly one catalog row."""
    rec, _ = _run()
    sql, _ = rec.page_call
    assert "LEFT JOIN LATERAL (" in sql
    assert "ORDER BY i.created_at DESC" in sql
    assert "LIMIT 1" in sql


def test_deleted_projects_do_not_supply_a_name() -> None:
    rec, _ = _run()
    sql, _ = rec.page_call
    assert "sp.deleted_at IS NULL" in sql
    assert "ip.deleted_at IS NULL" in sql


def test_the_mapping_project_wins_over_the_imported_one() -> None:
    """Re-pointing a spec at another project must change what the catalog shows."""
    rec, _ = _run()
    sql, _ = rec.page_call
    assert "COALESCE(spec.project_id, imp.project_id) AS project_id" in sql
    assert "COALESCE(sp.name, ip.name) AS project_name" in sql


# --- filters ----------------------------------------------------------------------------


def test_the_search_spans_path_kind_repository_and_project() -> None:
    rec, _ = _run(search="orders")
    sql, params = rec.page_call
    assert "f.path ILIKE %s" in sql
    assert "COALESCE(f.detected_kind, '') ILIKE %s" in sql
    assert "COALESCE(r.repository_full_name, '') ILIKE %s" in sql
    assert "COALESCE(sp.name, ip.name, '') ILIKE %s" in sql
    assert params.count("%orders%") == 4


def test_the_search_declares_its_escape_character() -> None:
    """Without ``ESCAPE``, the backslashes the term escaper adds are literal characters."""
    rec, _ = _run(search="a_b")
    sql, params = rec.page_call
    assert "ESCAPE E'\\\\'" in sql
    assert "%a\\_b%" in params


def test_a_repository_filter_binds_the_id_as_a_parameter() -> None:
    rec, _ = _run(repository_id=_REPO)
    sql, params = rec.page_call
    assert "r.id = %s::uuid" in sql
    assert _REPO in params


def test_a_project_filter_matches_mapped_or_imported() -> None:
    """A spec imported into a project but not (yet) mapped still belongs to that project."""
    rec, _ = _run(project_id=_PROJECT)
    sql, params = rec.page_call
    assert "COALESCE(spec.project_id, imp.project_id) = %s::uuid" in sql
    assert _PROJECT in params


def test_the_format_filter_reuses_the_projected_expression() -> None:
    """Filtering with a different expression than the one shown is how rows go missing."""
    rec, _ = _run(format_key="openapi")
    sql, params = rec.page_call
    assert "'openapi'" in sql
    assert "openapi" in params


def test_the_status_filter_reuses_the_projected_expression() -> None:
    rec, _ = _run(status_key="imported")
    sql, params = rec.page_call
    assert "imported" in params


def test_placeholders_and_parameters_stay_aligned() -> None:
    """A mismatch is not a wrong answer — psycopg2 raises, and the page 500s."""
    rec, _ = _run(
        search="orders", repository_id=_REPO, project_id=_PROJECT,
        format_key="openapi", status_key="mapped",
    )
    for sql, params in rec.calls:
        assert sql.count("%s") == len(params), sql


# --- counts, ordering and clamps --------------------------------------------------------


def test_the_unfiltered_total_ignores_the_user_filters() -> None:
    """`catalog_total` is the denominator "N indexed", not "N matched"."""
    rec, _ = _run(search="orders")
    count_calls = [c for c in rec.calls if c[0].lstrip().startswith("SELECT COUNT(*) AS c ")]
    assert len(count_calls) == 2
    assert "ILIKE %s" not in count_calls[0][0]
    assert "ILIKE %s" in count_calls[1][0]


def test_an_unfiltered_catalog_does_not_count_twice() -> None:
    rec, result = _run()
    count_calls = [c for c in rec.calls if c[0].lstrip().startswith("SELECT COUNT(*) AS c ")]
    assert len(count_calls) == 1
    assert result["match_count"] == result["catalog_total"] == 7


def test_an_unknown_sort_never_reaches_the_query() -> None:
    rec, result = _run(sort="; DROP TABLE apiome.tenants")
    sql, _ = rec.page_call
    assert "DROP TABLE" not in sql
    assert result["sort"] == "repository"


@pytest.mark.parametrize(
    "requested,expected", [(0, 1), (1, 1), (50, 50), (500, 500), (5000, 500)]
)
def test_the_page_size_is_clamped(requested: int, expected: int) -> None:
    rec, result = _run(limit=requested)
    _sql, params = rec.page_call
    assert result["limit"] == expected
    assert params[-2] == expected


@pytest.mark.parametrize("requested,expected", [(-5, 0), (0, 0), (900_000, 500_000)])
def test_the_offset_is_clamped(requested: int, expected: int) -> None:
    rec, result = _run(offset=requested)
    _sql, params = rec.page_call
    assert result["offset"] == expected
    assert params[-1] == expected


# --- facets -----------------------------------------------------------------------------


def test_facets_are_not_computed_unless_asked_for() -> None:
    """Four extra GROUP BY scans on every page turn is the whole reason this is opt-in."""
    rec, result = _run()
    assert result["facets"] is None
    assert not any("GROUP BY" in sql for sql, _ in rec.calls)


def test_facets_ignore_the_active_filters() -> None:
    """A shrinking facet list would strand the operator inside their first filter."""
    rec, result = _run(search="orders", format_key="openapi", include_facets=True)
    group_by_calls = [c for c in rec.calls if "GROUP BY" in c[0]]
    assert len(group_by_calls) == 4
    for sql, params in group_by_calls:
        assert "ILIKE %s" not in sql
        assert params == (_TENANT,)
    assert set(result["facets"]) == {"formats", "statuses", "repositories", "projects"}


def test_the_project_facet_skips_unmapped_specs() -> None:
    rec, _ = _run(include_facets=True)
    project_facet = [
        c for c in rec.calls if "COALESCE(spec.project_id, imp.project_id) AS id" in c[0]
    ]
    assert len(project_facet) == 1
    assert "IS NOT NULL" in project_facet[0][0]
