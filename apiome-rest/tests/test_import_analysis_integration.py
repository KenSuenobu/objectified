"""Import-time payload analysis, end to end (CPDO-1.2, #4795).

These drive the real pipeline — :func:`app.import_source_pipeline.run_adapter_import_job` — against a
fake data layer, so what is asserted is what an import actually does rather than what a helper does
in isolation. The acceptance criteria they stand for:

* **import and re-import cover persistence** — an import records an analysis against the revision it
  created; a re-import of unchanged source is recognised by content and does not append a redundant
  one; a re-import of *changed* source appends the next sequence, and the older record stays
  readable;
* **analysis failures are non-fatal but explicit** — an analyzer that crashes, and a store that
  refuses the write, each leave the import completed and say so in an event and in the summary;
* **output is redaction-safe** — what reaches the store carries no observed payload value;
* **no detail read requires reconstruction when a stored analysis exists** — the catalog summary is
  built from the stored row alone, without going near the captured source.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest

from app.cobolcopybook_import_source import CobolCopybookImportSource
from app.edix12_import_source import EdiX12ImportSource
from app.import_source_pipeline import ImportRunArtifacts, run_adapter_import_job
from app.payload_analysis import (
    PAYLOAD_ANALYSIS_SCHEMA_VERSION,
    REASON_ANALYZER_FAILED,
    STATUS_AVAILABLE,
    STATUS_FAILED,
    analysis_content_fingerprint,
)

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples"
_PO_850 = (_EXAMPLES / "edi-x12/01-850-purchase-order.edi").read_text(encoding="utf-8")
_MULTI_GROUP = (_EXAMPLES / "edi-x12/04-multi-group-po-ack.edi").read_text(encoding="utf-8")
_CUSTOMER = (_EXAMPLES / "cobol-copybook/01-customer-record.cpy").read_text(encoding="utf-8")

_TENANT = "11111111-1111-4111-8111-111111111111"
_USER = "44444444-4444-4444-8444-444444444444"


class _FakeDb:
    """A data layer that behaves the way the analysis store depends on it behaving.

    Only the parts the import path touches: project/version resolution, the source-format write, and
    ``payload_analysis`` with its two real behaviours — append at ``max(sequence) + 1``, and return
    the existing row when the revision's current analysis already carries the same content
    fingerprint.
    """

    def __init__(self, *, insert_error: Optional[Exception] = None) -> None:
        self.analyses: Dict[str, List[Dict[str, Any]]] = {}
        self.projects: Dict[str, Dict[str, Any]] = {}
        self.versions: Dict[str, Dict[str, Any]] = {}
        self.source_format_calls: List[Dict[str, Any]] = []
        self.insert_error = insert_error
        self._next_id = 0

    # --- project / version resolution ------------------------------------

    def _mint(self, prefix: str) -> str:
        self._next_id += 1
        return f"{prefix}-{self._next_id}"

    def get_project_by_slug(self, slug: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        return self.projects.get(slug)

    def get_project_by_id(self, project_id: str, tenant_id: str) -> Optional[Dict[str, Any]]:
        for project in self.projects.values():
            if project["id"] == project_id:
                return project
        return None

    def allocate_project_slug(self, tenant_id: str, base_slug: str) -> str:
        return base_slug or "imported-source"

    def create_project(self, tenant_id, creator_id, name, slug, description, metadata, publishable):
        project = {"id": self._mint("proj"), "slug": slug, "publishable": publishable}
        self.projects[slug] = project
        return project

    def get_version_by_version_id(self, project_id, version_id, tenant_id):
        return self.versions.get(f"{project_id}:{version_id}")

    def allocate_version_id(self, project_id: str, base_version_id: str) -> str:
        return base_version_id or "1.0.0"

    def create_version(self, project_id, creator_id, version_id, description=None):
        version = {"id": self._mint("ver"), "version_id": version_id}
        self.versions[f"{project_id}:{version_id}"] = version
        return version

    def set_version_source_format(self, version_record_id, tenant_id, **kwargs):
        self.source_format_calls.append({"version_record_id": version_record_id, **kwargs})
        return True

    def set_version_quality_score(self, *args, **kwargs):
        return True

    def get_latest_intake_secret_scrub_policy(self, tenant_id: str) -> None:
        return None

    # --- payload analysis -------------------------------------------------

    def insert_payload_analysis(self, **kwargs) -> Optional[Dict[str, Any]]:
        if self.insert_error is not None:
            raise self.insert_error
        version_id = kwargs["version_id"]
        rows = self.analyses.setdefault(version_id, [])
        if rows and rows[-1]["content_fingerprint"] == kwargs["content_fingerprint"]:
            return rows[-1]
        row = {
            "id": self._mint("analysis"),
            "analysis_sequence": len(rows) + 1,
            "created_at": None,
            **kwargs,
        }
        rows.append(row)
        return row

    def get_payload_analysis_for_version(self, version_id: str) -> Optional[Dict[str, Any]]:
        rows = self.analyses.get(version_id or "", [])
        return rows[-1] if rows else None

    def get_payload_analysis_summary_row_for_version(
        self, version_id: str
    ) -> Optional[Dict[str, Any]]:
        # Deliberately does not go through ``get_payload_analysis_for_version``: the real query
        # selects every column *except* ``tree``, and a test that asserts the tree is never fetched
        # needs the two reads to be genuinely separate here too.
        rows = self.analyses.get(version_id or "", [])
        if not rows:
            return None
        return {key: value for key, value in rows[-1].items() if key != "tree"}

    def get_latest_revision_id_for_project(self, project_id: str, tenant_id: str) -> Optional[str]:
        for version in self.versions.values():
            return version["id"]
        return None


def _payload(
    text: str,
    *,
    source_kind: str = "edix12",
    filename: str = "po.edi",
    options: Optional[Dict[str, Any]] = None,
    version_id: str = "1.0.0",
    tenant_id: Optional[str] = _TENANT,
) -> Dict[str, Any]:
    """Build a worker payload for an adapter import."""
    payload: Dict[str, Any] = {
        "rest_job_id": "job-analysis",
        "user_id": _USER,
        "filename": filename,
        "metadata": {
            "source_kind": source_kind,
            "project": {"name": "Feed", "slug": "feed"},
            "version": {"version_id": version_id},
            "options": options or {},
        },
        "document_base64": base64.standard_b64encode(text.encode("utf-8")).decode("ascii"),
    }
    if tenant_id:
        payload["tenant_id"] = tenant_id
    return payload


async def _run(adapter, payload: Dict[str, Any], db: _FakeDb, artifacts=None):
    """Run one import with both data-layer bindings pointed at ``db``."""
    with patch("app.database.db", db), patch("app.payload_analysis_store.db", db):
        return await run_adapter_import_job(adapter, payload, artifacts=artifacts)


def _stored_rows(db: _FakeDb) -> List[Dict[str, Any]]:
    return [row for rows in db.analyses.values() for row in rows]


def _walk(nodes) -> List[Any]:
    """Yield every node of a **stored** (JSON) tree, depth-first."""
    out: List[Any] = []
    stack = list(reversed(list(nodes)))
    while stack:
        node = stack.pop()
        out.append(node)
        stack.extend(reversed(node.get("children") or []))
    return out


def _walk_nodes(nodes) -> List[Any]:
    """Yield every node of an in-memory :class:`~app.payload_analysis.AnalysisNode` tree."""
    out: List[Any] = []
    stack = list(reversed(list(nodes)))
    while stack:
        node = stack.pop()
        out.append(node)
        stack.extend(reversed(node.children))
    return out


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


async def test_an_import_records_the_native_analysis_against_its_revision() -> None:
    db = _FakeDb()

    final = await _run(EdiX12ImportSource(), _payload(_MULTI_GROUP), db)

    assert final.state == "completed"
    rows = _stored_rows(db)
    assert len(rows) == 1
    row = rows[0]
    assert row["version_id"] == final.result.version_record_id
    assert row["project_id"] == final.result.project_id
    assert row["tenant_id"] == _TENANT
    assert row["created_by"] == _USER
    assert row["status"] == STATUS_AVAILABLE
    assert row["analyzer_key"] == "edix12"
    assert row["schema_version"] == PAYLOAD_ANALYSIS_SCHEMA_VERSION
    assert row["source_hash"].startswith("sha256:")


async def test_the_stored_tree_keeps_every_group_and_transaction_set() -> None:
    """The canonical model normalizes one transaction set; the stored analysis has both."""
    db = _FakeDb()

    await _run(EdiX12ImportSource(), _payload(_MULTI_GROUP), db)

    nodes = _walk(_stored_rows(db)[0]["tree"])
    assert [n["name"] for n in nodes if n["kind"] == "functional_group"] == ["PO", "FA"]
    assert [n["name"] for n in nodes if n["kind"] == "transaction_set"] == ["850", "997"]


async def test_the_stored_record_carries_capabilities_tool_versions_and_locations() -> None:
    db = _FakeDb()

    await _run(EdiX12ImportSource(), _payload(_PO_850), db)
    row = _stored_rows(db)[0]

    assert "x12.functional_group" in row["capabilities"]["supported"]
    # CPDO-2.2: the delimiter scan aligned to the parse, so this record can see an element position
    # written and left empty. A record whose scan failed declares the same construct unsupported.
    assert "x12.empty_elements" in row["capabilities"]["supported"]
    assert "x12.hl_hierarchy" in row["capabilities"]["unsupported"]
    assert row["capabilities"]["limits"]["maxNodes"] > 0
    assert row["tool_versions"]["pyx12"]
    assert all(node["location"]["path"] for node in _walk(row["tree"]))


async def test_nothing_observed_reaches_the_store(caplog) -> None:
    """The interchange carries a buyer name and a phone number; neither may be in the stored row."""
    db = _FakeDb()

    await _run(EdiX12ImportSource(), _payload(_PO_850), db)
    row = _stored_rows(db)[0]

    assert "Jane Buyer" in _PO_850
    assert "Jane Buyer" not in str(row["tree"])
    assert row["redaction"]["value_visibility"] == "structural"
    elements = [node for node in _walk(row["tree"]) if node["kind"] == "element"]
    assert elements
    assert all(node["value"] is None for node in elements)
    assert all(node["value_present"] is True for node in elements)


async def test_a_copybook_import_records_its_layout() -> None:
    db = _FakeDb()

    final = await _run(
        CobolCopybookImportSource(),
        _payload(_CUSTOMER, source_kind="cobolcopybook", filename="customer.cpy"),
        db,
    )

    assert final.state == "completed"
    row = _stored_rows(db)[0]
    assert row["analyzer_key"] == "cobolcopybook"
    record = row["tree"][0]
    assert record["kind"] == "record"
    assert record["name"] == "CUSTOMER-RECORD"
    assert any(node["kind"] == "condition" for node in _walk(row["tree"]))


async def test_a_format_with_no_native_extractor_still_records_an_analysis() -> None:
    """Every adapter analyses: the default walk is format-blind, and says so in its capabilities."""
    db = _FakeDb()
    from app.jsonschema_import_source import JsonSchemaImportSource

    schema = '{"$id": "https://acme.test/user.json", "type": "object", "title": "User"}'
    final = await _run(
        JsonSchemaImportSource(), _payload(schema, source_kind="json-schema", filename="u.json"), db
    )

    assert final.state == "completed"
    row = _stored_rows(db)[0]
    assert row["analyzer_key"] == "generic"
    assert "generic.format_semantics" in row["capabilities"]["unsupported"]


# ---------------------------------------------------------------------------
# Re-import
# ---------------------------------------------------------------------------


async def test_re_importing_unchanged_source_does_not_append_a_second_analysis() -> None:
    """A catalog re-import under the same version label reuses its revision, so an identical
    analysis must be recognised by content rather than stored again."""
    db = _FakeDb()

    first = await _run(EdiX12ImportSource(), _payload(_PO_850), db)
    second = await _run(EdiX12ImportSource(), _payload(_PO_850), db)

    assert first.result.version_record_id == second.result.version_record_id
    rows = _stored_rows(db)
    assert len(rows) == 1
    assert rows[0]["analysis_sequence"] == 1
    assert second.summary["analysis"]["stored"] is True


async def test_re_importing_changed_source_appends_the_next_sequence() -> None:
    db = _FakeDb()

    await _run(EdiX12ImportSource(), _payload(_PO_850), db)
    await _run(EdiX12ImportSource(), _payload(_MULTI_GROUP), db)

    rows = _stored_rows(db)
    assert [row["analysis_sequence"] for row in rows] == [1, 2]
    # The superseded record stays readable — an evidence reference to it must still resolve.
    assert rows[0]["source_hash"] != rows[1]["source_hash"]
    assert rows[0]["content_fingerprint"] != rows[1]["content_fingerprint"]


async def test_a_new_revision_gets_its_own_analysis() -> None:
    db = _FakeDb()

    first = await _run(EdiX12ImportSource(), _payload(_PO_850, version_id="1.0.0"), db)
    second = await _run(EdiX12ImportSource(), _payload(_PO_850, version_id="2.0.0"), db)

    assert first.result.version_record_id != second.result.version_record_id
    assert len(db.analyses) == 2
    assert all(rows[0]["analysis_sequence"] == 1 for rows in db.analyses.values())


# ---------------------------------------------------------------------------
# Non-fatal but explicit
# ---------------------------------------------------------------------------


async def test_a_crashing_analyzer_does_not_fail_the_import() -> None:
    db = _FakeDb()

    with patch(
        "app.edix12_import_source.analyze_edix12", side_effect=RuntimeError("analyzer bug")
    ):
        final = await _run(EdiX12ImportSource(), _payload(_PO_850), db)

    assert final.state == "completed"
    assert final.result is not None
    analyzed = [event for event in final.events if event.code == "PAYLOAD_ANALYZED"]
    assert len(analyzed) == 1
    assert analyzed[0].level == "warn"
    assert final.summary["analysis"]["status"] == STATUS_FAILED
    assert final.summary["analysis"]["status_reason"] == REASON_ANALYZER_FAILED
    # The failure is recorded, not swallowed: "the analyzer failed" and "nothing analysed it" are
    # different facts and the stored record says which.
    assert _stored_rows(db)[0]["status"] == STATUS_FAILED


async def test_a_store_fault_does_not_fail_a_committed_import() -> None:
    db = _FakeDb(insert_error=RuntimeError("connection reset"))

    final = await _run(EdiX12ImportSource(), _payload(_PO_850), db)

    assert final.state == "completed"
    assert final.result is not None
    codes = [event.code for event in final.events]
    assert "PAYLOAD_ANALYSIS_STORE_FAILED" in codes
    assert "PAYLOAD_ANALYSIS_STORED" not in codes
    assert final.summary["analysis"]["stored"] is False


async def test_a_dry_run_analyses_without_storing() -> None:
    db = _FakeDb()

    final = await _run(
        EdiX12ImportSource(), _payload(_PO_850, options={"dry_run": True}), db
    )

    assert final.state == "completed"
    assert _stored_rows(db) == []
    assert final.summary["analysis"]["status"] == STATUS_AVAILABLE
    assert final.summary["analysis"]["stored"] is False


async def test_an_import_with_no_tenant_analyses_without_storing() -> None:
    db = _FakeDb()

    final = await _run(EdiX12ImportSource(), _payload(_PO_850, tenant_id=None), db)

    assert final.state == "completed"
    assert _stored_rows(db) == []
    assert final.summary["analysis"]["status"] == STATUS_AVAILABLE


# ---------------------------------------------------------------------------
# The summary and the run artifacts
# ---------------------------------------------------------------------------


async def test_the_summary_reports_the_analysis_without_carrying_any_of_it() -> None:
    db = _FakeDb()

    final = await _run(EdiX12ImportSource(), _payload(_PO_850), db)
    block = final.summary["analysis"]

    assert block["analyzer"] == "edix12"
    assert block["node_count"] > 0
    assert block["truncated"] is False
    assert block["stored"] is True
    assert "x12.hl_hierarchy" in block["unsupported"]
    assert "tree" not in block


async def test_the_run_artifacts_expose_the_analysis_to_the_preflight_caller() -> None:
    db = _FakeDb()
    artifacts = ImportRunArtifacts()

    await _run(EdiX12ImportSource(), _payload(_PO_850), db, artifacts=artifacts)

    assert artifacts.analysis is not None
    assert artifacts.analysis.status == STATUS_AVAILABLE
    # The out-parameter is pre-policy on purpose (the store redacts on the way in), which is why it
    # is documented as unsafe to surface. What reached the store carries none of these values.
    values = [node.value for node in _walk_nodes(artifacts.analysis.tree) if node.value]
    assert "Jane Buyer" in values
    assert "Jane Buyer" not in str(_stored_rows(db)[0]["tree"])


async def test_the_analysis_event_precedes_normalization() -> None:
    """It has to: normalization is what reduces the native AST to the canonical model."""
    db = _FakeDb()

    final = await _run(EdiX12ImportSource(), _payload(_PO_850), db)
    codes = [event.code for event in final.events]

    assert codes.index("PARSE_OK") < codes.index("PAYLOAD_ANALYZED")
    assert codes.index("PAYLOAD_ANALYZED") < codes.index("NORMALIZE_OK")
    assert codes.index("PERSISTED") < codes.index("PAYLOAD_ANALYSIS_STORED")


# ---------------------------------------------------------------------------
# The detail read
# ---------------------------------------------------------------------------


async def test_a_detail_read_serves_the_stored_analysis_without_reconstructing_it() -> None:
    """With an analysis on file, the catalog summary comes from the row alone. Nothing re-reads the
    captured source, so the detail read's cost does not grow with the analysed payload."""
    from app.payload_analysis_store import analysis_summary_for_item

    db = _FakeDb()
    final = await _run(EdiX12ImportSource(), _payload(_MULTI_GROUP), db)
    item = {"id": final.result.project_id, "tenant_id": _TENANT, "source_format": "edix12"}

    with patch("app.payload_analysis_store.db", db), patch(
        "app.payload_analysis_store.derive_catalog_source",
        side_effect=AssertionError("a stored analysis must never re-read the source"),
    ):
        summary = analysis_summary_for_item(_TENANT, item)

    assert summary.available is True
    assert summary.status == STATUS_AVAILABLE
    assert summary.analyzer_key == "edix12"
    assert summary.kind_counts["transaction_set"] == 2
    assert "x12.hl_hierarchy" in summary.capabilities.unsupported
    assert "x12.empty_elements" in summary.capabilities.supported


async def test_the_detail_summary_is_built_without_reading_the_tree_column() -> None:
    db = _FakeDb()
    from app.payload_analysis_store import analysis_summary_for_item

    final = await _run(EdiX12ImportSource(), _payload(_PO_850), db)
    item = {"id": final.result.project_id, "tenant_id": _TENANT, "source_format": "edix12"}

    with patch("app.payload_analysis_store.db", db), patch.object(
        _FakeDb,
        "get_payload_analysis_for_version",
        side_effect=AssertionError("the summary must not fetch the tree"),
    ):
        summary = analysis_summary_for_item(_TENANT, item)

    assert summary.node_count > 0


@pytest.mark.parametrize("source", [_PO_850, _CUSTOMER])
async def test_an_import_is_reproducible(source: str) -> None:
    """Two imports of the same bytes must fingerprint identically — the property the idempotent
    write depends on."""
    adapter = EdiX12ImportSource() if source is _PO_850 else CobolCopybookImportSource()
    kind = "edix12" if source is _PO_850 else "cobolcopybook"

    first, second = ImportRunArtifacts(), ImportRunArtifacts()
    await _run(adapter, _payload(source, source_kind=kind), _FakeDb(), artifacts=first)
    await _run(adapter, _payload(source, source_kind=kind), _FakeDb(), artifacts=second)

    assert analysis_content_fingerprint(first.analysis) == analysis_content_fingerprint(
        second.analysis
    )
