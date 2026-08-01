"""Vocabulary of the cross-repo discovered-spec catalog (REPO-6.4, #2797).

``app.repository_spec_catalog`` is where the catalog's format families, derived status, sort
allowlist and search-term hardening live. Everything downstream — the DAO's predicates, the
route's validation, the facet labels — is composed from these, so pinning them here is what
stops a row being *listed* under a value it cannot be *filtered* by.
"""

import pytest

from app.repository_spec_catalog import (
    DEFAULT_SPEC_SORT,
    MAX_SEARCH_TERM_LENGTH,
    SPEC_FORMAT_LABELS,
    SPEC_FORMAT_SQL,
    SPEC_SORT_SQL,
    SPEC_STATUS_LABELS,
    SPEC_STATUS_RANK_SQL,
    SPEC_STATUS_SQL,
    escape_like,
    format_facet_options,
    normalize_format,
    normalize_sort,
    normalize_status,
    search_term_to_like,
    status_facet_options,
    validate_search_term,
)


# --- sorting ----------------------------------------------------------------------------


def test_every_offered_sort_has_an_order_by() -> None:
    assert DEFAULT_SPEC_SORT in SPEC_SORT_SQL


@pytest.mark.parametrize("key", sorted(SPEC_SORT_SQL))
def test_every_sort_ends_with_a_unique_tiebreaker(key: str) -> None:
    """Without one, two rows sharing a sort value can swap pages — shown twice, or skipped."""
    assert SPEC_SORT_SQL[key].strip().endswith("f.id ASC"), key


@pytest.mark.parametrize("raw", ["path", "PATH", " Format ", "recent"])
def test_a_known_sort_survives_normalization(raw: str) -> None:
    assert normalize_sort(raw) == raw.strip().lower()


@pytest.mark.parametrize("raw", [None, "", "; DROP TABLE users", "created_at"])
def test_an_unknown_sort_falls_back_rather_than_reaching_sql(raw) -> None:
    """The sort key is interpolated into SQL, so it must never be the caller's string."""
    assert normalize_sort(raw) == DEFAULT_SPEC_SORT


# --- format families --------------------------------------------------------------------


@pytest.mark.parametrize("raw", [None, "", "all", "ALL"])
def test_no_format_filter_means_no_filter(raw) -> None:
    assert normalize_format(raw) is None


def test_a_known_format_is_lowercased() -> None:
    assert normalize_format(" OpenAPI ") == "openapi"


def test_an_unknown_format_is_rejected_rather_than_ignored() -> None:
    """Ignoring it would show every row while the filter chip claims one format."""
    with pytest.raises(ValueError) as exc:
        normalize_format("raml")
    assert "raml" in str(exc.value)


def test_the_format_expression_covers_every_labelled_family() -> None:
    """A family with a label but no SQL arm would be an unselectable filter option."""
    for key in SPEC_FORMAT_LABELS:
        if key in {"other", "unclassified"}:
            continue  # the CASE's fallbacks, not arms of their own
        assert f"'{key}'" in SPEC_FORMAT_SQL, key


def test_the_format_expression_doubles_its_percent_signs() -> None:
    """psycopg2 reads a lone ``%`` as a parameter placeholder and raises at execute time."""
    assert "%" in SPEC_FORMAT_SQL
    assert "%%" in SPEC_FORMAT_SQL
    assert "%%%" not in SPEC_FORMAT_SQL.replace("%%", "")


# --- derived status ---------------------------------------------------------------------


@pytest.mark.parametrize("raw", [None, "", "all"])
def test_no_status_filter_means_no_filter(raw) -> None:
    assert normalize_status(raw) is None


def test_a_known_status_is_accepted() -> None:
    assert normalize_status("Needs_Attention") == "needs_attention"


def test_an_unknown_status_is_rejected() -> None:
    with pytest.raises(ValueError):
        normalize_status("broken")


def test_status_precedence_puts_attention_first() -> None:
    """Order is the contract: an operator triaging the catalog reads it as a severity ladder."""
    assert list(SPEC_STATUS_LABELS) == ["needs_attention", "imported", "mapped", "discovered"]


def test_the_status_expression_covers_every_labelled_status() -> None:
    for key in SPEC_STATUS_LABELS:
        assert f"'{key}'" in SPEC_STATUS_SQL, key


def test_the_status_rank_mirrors_the_status_expression() -> None:
    """The two are read together on every page; a drift makes the severity sort silently wrong."""
    conditions = [
        "f.quality_status = 'error' OR f.external_ref_warning IS NOT NULL",
        "imp.id IS NOT NULL",
        "spec.id IS NOT NULL",
    ]
    for condition in conditions:
        assert condition in SPEC_STATUS_SQL
        assert condition in SPEC_STATUS_RANK_SQL
    for rank in ("0", "1", "2", "3"):
        assert f"THEN {rank}" in SPEC_STATUS_RANK_SQL or f"ELSE {rank}" in SPEC_STATUS_RANK_SQL


# --- search hardening -------------------------------------------------------------------


def test_like_metacharacters_are_escaped() -> None:
    """Unescaped, ``user_id`` would also match ``userXid`` and ``100%`` would match everything."""
    assert escape_like("100%") == "100\\%"
    assert escape_like("user_id") == "user\\_id"
    assert escape_like("a\\b") == "a\\\\b"


def test_a_search_term_becomes_a_contains_pattern() -> None:
    assert search_term_to_like("  orders  ") == "%orders%"


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_a_blank_search_term_disables_the_search(raw) -> None:
    assert validate_search_term(raw) is None


def test_a_search_term_is_trimmed() -> None:
    assert validate_search_term("  openapi  ") == "openapi"


def test_a_nul_byte_is_rejected() -> None:
    with pytest.raises(ValueError):
        validate_search_term("open\x00api")


def test_an_overlong_search_term_is_rejected() -> None:
    with pytest.raises(ValueError):
        validate_search_term("x" * (MAX_SEARCH_TERM_LENGTH + 1))


def test_a_search_term_at_the_limit_is_accepted() -> None:
    term = "x" * MAX_SEARCH_TERM_LENGTH
    assert validate_search_term(term) == term


# --- facet presentation -----------------------------------------------------------------


def test_format_facets_lead_with_the_biggest_family() -> None:
    options = format_facet_options([("asyncapi", 2), ("openapi", 9), ("arazzo", 2)])
    assert [o["value"] for o in options] == ["openapi", "arazzo", "asyncapi"]
    assert options[0]["label"] == "OpenAPI"


def test_format_facets_label_an_unknown_family_with_its_key() -> None:
    """A family added server-side must still render before the label ships."""
    options = format_facet_options([("raml", 3)])
    assert options == [{"value": "raml", "label": "raml", "count": 3}]


def test_status_facets_keep_severity_order_not_count_order() -> None:
    options = status_facet_options([("discovered", 90), ("needs_attention", 1)])
    assert [o["value"] for o in options] == ["needs_attention", "discovered"]


def test_status_facets_omit_statuses_with_no_rows() -> None:
    options = status_facet_options([("imported", 4)])
    assert [o["value"] for o in options] == ["imported"]
