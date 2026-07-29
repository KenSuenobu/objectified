"""Unit tests for the primitives listing query's dedupe key (#3453, V216).

``Database.get_primitives_for_tenant`` collapses the per-tenant copies of a system-core type
so the registry listing shows each type once. The key it collapses on has to be the type's
*identity* — ``(namespace, name)``, the pair ``$id`` is derived from and the pair
``primitives_tenant_namespace_name_unique`` keys on — not ``(category, name)``, which hid a
tenant's own ``uri`` behind the seeded core ``std/v0/types/uri``.

The SQL runs against Postgres in the integration suite; these guard the Python-side contract:
the dedupe key, the own-row preference, the placement of the category filter, and the
caller-facing ordering. The connection is mocked.
"""

import re
from unittest.mock import patch

from app.database import Database

_TID = "tenant-1"


def _query_for(category=None):
    """Run the listing and return its SQL with whitespace normalized, plus the params."""
    db = Database()
    with patch.object(db, "execute_query", return_value=[]) as mq:
        db.get_primitives_for_tenant(_TID, category)
    sql = re.sub(r"\s+", " ", mq.call_args.args[0]).strip()
    return sql, mq.call_args.args[1]


def test_dedupes_on_namespace_and_name():
    sql, _ = _query_for()
    assert "DISTINCT ON (namespace, name)" in sql


def test_does_not_dedupe_on_category():
    """The pre-V216 key. Category is descriptive metadata, not identity — two types sharing a
    name and a category in different namespaces are distinct rows and both must be listed."""
    sql, _ = _query_for()
    assert "DISTINCT ON (category, name)" not in sql


def test_prefers_the_callers_own_row_over_a_foreign_core_copy():
    sql, params = _query_for()
    assert "ORDER BY namespace, name, (tenant_id = %s) DESC" in sql
    # Tenant id twice: the visibility filter, then the preference tiebreak.
    assert params == (_TID, _TID)


def test_orders_the_listing_by_category_then_name():
    """DISTINCT ON forces its keys to lead ORDER BY, so the caller-facing ordering is applied
    outside the dedupe — the documented contract stays (category, name)."""
    sql, _ = _query_for()
    assert sql.rstrip().endswith("ORDER BY category, name")


def test_category_filter_applies_before_the_dedupe():
    """Filtering after the dedupe would drop a type whose surviving row is in another category."""
    sql, params = _query_for("string")
    dedupe = sql.index("DISTINCT ON")
    assert dedupe < sql.index("AND category = %s") < sql.index("ORDER BY namespace")
    assert params == (_TID, "string", _TID)


def test_read_scope_is_system_core_union_own():
    sql, _ = _query_for()
    assert "WHERE (tenant_id = %s OR is_system = true)" in sql
