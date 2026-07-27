"""Remote ``$ref`` resolution through the import pipeline — MFI-29.4 (#4391).

Where :mod:`tests.test_remote_ref_resolver` covers the resolver itself, these tests drive
:func:`app.import_source_pipeline.run_adapter_import_job` end to end and assert the wiring
the ticket asks for:

* a document with external ``$ref``\\s imports **fully resolved** when the import opts in —
  the canonical model, and therefore the fingerprint, covers the referenced definitions;
* with the opt-in off (the default) nothing is fetched and the unresolved externals are
  reported as lint findings on the same report the revision persists;
* the deployment kill switch overrides the per-import opt-in;
* a format that cannot carry external references is never scanned;
* the resolver rewrites only what the adapter parses — the intake the catalog persists
  verbatim is untouched.

Every run is a ``dry_run`` so nothing reaches the database, and the network is replaced by
a fake fetcher at the resolver's own seam.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Dict, List, Optional

import pytest

from app import remote_ref_resolver
from app.fileset import IntakeFileset
from app.import_source_pipeline import (
    ImportRunArtifacts,
    _ResolvedIntake,
    resolve_intake_remote_refs,
    run_adapter_import_job,
)
from app.intake_lint_rules import RULE_BLOCKED_EXTERNAL_REF, RULE_UNRESOLVED_EXTERNAL_REF
from app.jsonschema_import_source import JsonSchemaImportSource
from app.models import SpecImportJobStatus
from app.remote_ref_resolver import default_cache
from app.sample_import_source import SampleImportSource

CUSTOMER_URL = "https://schemas.example.com/customer.json"

#: The remote schema library the root document references.
CUSTOMER_LIBRARY = {
    "$defs": {
        "Customer": {
            "type": "object",
            "description": "A paying customer.",
            "properties": {"id": {"type": "string"}, "email": {"type": "string"}},
            "required": ["id"],
        }
    }
}

#: A JSON Schema whose only definition lives in another document.
ROOT_SCHEMA: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Orders",
    "$defs": {"Customer": {"$ref": f"{CUSTOMER_URL}#/$defs/Customer"}},
}


@pytest.fixture(autouse=True)
def _clear_reference_cache():
    """Keep the process-wide document cache from leaking between tests."""
    default_cache().clear()
    yield
    default_cache().clear()


@pytest.fixture
def fetches(monkeypatch: pytest.MonkeyPatch) -> List[str]:
    """Replace the resolver's HTTP fetcher with the in-memory schema library."""
    calls: List[str] = []

    def _fetch(url: str, *, max_bytes: int, timeout: float) -> bytes:
        calls.append(url)
        if url != CUSTOMER_URL:
            raise remote_ref_resolver._FetchError(
                remote_ref_resolver.REASON_FETCH_FAILED, f"HTTP 404 from {url}"
            )
        return json.dumps(CUSTOMER_LIBRARY).encode("utf-8")

    monkeypatch.setattr(remote_ref_resolver, "_http_fetch", _fetch)
    return calls


def _payload(document: Dict[str, Any], *, options: Optional[dict] = None) -> dict:
    """Build a worker-style payload for a JSON Schema import."""
    text = json.dumps(document)
    merged = {"dry_run": True}
    merged.update(options or {})
    return {
        "rest_job_id": "job-refs",
        "metadata": {"source_kind": "json-schema", "options": merged},
        "document_base64": base64.standard_b64encode(text.encode("utf-8")).decode("ascii"),
        "filename": "orders.schema.json",
        "content_type": "application/json",
    }


async def _run(
    document: Dict[str, Any], *, options: Optional[dict] = None
) -> tuple[SpecImportJobStatus, ImportRunArtifacts]:
    """Run one JSON Schema import, returning its terminal status and artifacts."""
    artifacts = ImportRunArtifacts()
    status = await run_adapter_import_job(
        JsonSchemaImportSource(), _payload(document, options=options), artifacts=artifacts
    )
    return status, artifacts


def _type_named(model, name: str):
    """Return the canonical type called ``name``, or ``None``."""
    return next((t for t in model.types if t.name == name), None)


# ---------------------------------------------------------------------------
# Disabled by default
# ---------------------------------------------------------------------------


async def test_default_import_fetches_nothing_and_reports_the_externals(
    fetches: List[str],
) -> None:
    status, artifacts = await _run(ROOT_SCHEMA)

    assert status.state == "completed"
    assert fetches == []

    report = status.summary["remote_refs"]
    assert report["enabled"] is False
    assert report["resolved"] == 0
    assert report["unresolved"] == 1
    assert report["refs"][0]["url"] == CUSTOMER_URL
    assert report["refs"][0]["reason"] == "resolution-disabled"

    codes = [event.code for event in status.events]
    assert "REMOTE_REFS_UNRESOLVED" in codes
    assert "REMOTE_REFS_RESOLVED" not in codes

    rules = [finding.rule for finding in artifacts.lint.findings]
    assert RULE_UNRESOLVED_EXTERNAL_REF in rules
    # The unresolved reference is only an alias in the model — its fields are missing.
    assert _type_named(artifacts.model, "Customer").fields == []


async def test_a_document_without_external_refs_reports_nothing(fetches: List[str]) -> None:
    status, artifacts = await _run(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "Orders",
            "$defs": {"Customer": {"type": "object", "properties": {"id": {"type": "string"}}}},
        }
    )

    assert "remote_refs" not in status.summary
    assert artifacts.remote_refs is None
    assert not [
        f for f in artifacts.lint.findings if f.rule.startswith("intake.")
    ]


# ---------------------------------------------------------------------------
# Opted in: fully resolved
# ---------------------------------------------------------------------------


async def test_opted_in_import_resolves_the_external_ref(fetches: List[str]) -> None:
    status, artifacts = await _run(ROOT_SCHEMA, options={"resolve_remote_refs": True})

    assert status.state == "completed"
    assert fetches == [CUSTOMER_URL]

    report = status.summary["remote_refs"]
    assert report["enabled"] is True
    assert report["resolved"] == 1
    assert report["unresolved"] == 0
    assert report["resolved_refs"][0]["url"] == CUSTOMER_URL
    assert report["resolved_refs"][0]["digest"]

    assert "REMOTE_REFS_RESOLVED" in [event.code for event in status.events]

    customer = _type_named(artifacts.model, "Customer")
    assert [field.name for field in customer.fields] == ["id", "email"]
    assert customer.description == "A paying customer."
    assert not [f for f in artifacts.lint.findings if f.rule.startswith("intake.")]


async def test_resolved_import_fingerprints_like_the_inlined_document(
    fetches: List[str],
) -> None:
    # Resolution happens before normalization, so importing a document with an external
    # reference resolved must be indistinguishable from importing it already inlined.
    resolved, _ = await _run(ROOT_SCHEMA, options={"resolve_remote_refs": True})
    inlined_document = {
        "$schema": ROOT_SCHEMA["$schema"],
        "title": "Orders",
        "$defs": {"Customer": CUSTOMER_LIBRARY["$defs"]["Customer"]},
    }
    inlined, _ = await _run(inlined_document)

    assert resolved.summary["fingerprint"] == inlined.summary["fingerprint"]


async def test_resolution_changes_the_fingerprint(fetches: List[str]) -> None:
    unresolved, _ = await _run(ROOT_SCHEMA)
    resolved, _ = await _run(ROOT_SCHEMA, options={"resolve_remote_refs": True})

    assert unresolved.summary["fingerprint"] != resolved.summary["fingerprint"]


async def test_a_second_import_is_served_from_the_cache(fetches: List[str]) -> None:
    await _run(ROOT_SCHEMA, options={"resolve_remote_refs": True})
    status, _ = await _run(ROOT_SCHEMA, options={"resolve_remote_refs": True})

    assert fetches == [CUSTOMER_URL]  # fetched once across both imports
    assert status.summary["remote_refs"]["cache_hits"] == 1


# ---------------------------------------------------------------------------
# Failures degrade the import instead of failing it
# ---------------------------------------------------------------------------


async def test_unreachable_reference_still_completes_with_a_finding(
    fetches: List[str],
) -> None:
    document = dict(ROOT_SCHEMA)
    document["$defs"] = {"Customer": {"$ref": "https://schemas.example.com/gone.json#/x"}}

    status, artifacts = await _run(document, options={"resolve_remote_refs": True})

    assert status.state == "completed"
    assert status.summary["remote_refs"]["unresolved"] == 1
    assert RULE_UNRESOLVED_EXTERNAL_REF in [f.rule for f in artifacts.lint.findings]


async def test_guard_refusal_is_reported_as_its_own_event_and_rule(
    fetches: List[str],
) -> None:
    document = dict(ROOT_SCHEMA)
    document["$defs"] = {"Customer": {"$ref": "file:///etc/passwd#/x"}}

    status, artifacts = await _run(document, options={"resolve_remote_refs": True})

    assert status.state == "completed"
    assert fetches == []
    assert status.summary["remote_refs"]["blocked"] == 1
    assert "REMOTE_REFS_BLOCKED" in [event.code for event in status.events]
    assert RULE_BLOCKED_EXTERNAL_REF in [f.rule for f in artifacts.lint.findings]


# ---------------------------------------------------------------------------
# Gating
# ---------------------------------------------------------------------------


async def test_deployment_kill_switch_overrides_the_per_import_opt_in(
    fetches: List[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        remote_ref_resolver.settings, "remote_ref_resolution_allowed", False
    )

    status, _ = await _run(ROOT_SCHEMA, options={"resolve_remote_refs": True})

    assert fetches == []
    assert status.summary["remote_refs"]["enabled"] is False


async def test_a_format_without_remote_refs_is_never_scanned(fetches: List[str]) -> None:
    payload = {
        "rest_job_id": "job-sample",
        "metadata": {"source_kind": "sample", "options": {"resolve_remote_refs": True}},
        "document_base64": base64.standard_b64encode(b"hello").decode("ascii"),
        "filename": "doc.txt",
    }

    status = await run_adapter_import_job(SampleImportSource(), payload)

    assert status.state == "completed"
    assert "remote_refs" not in status.summary
    assert fetches == []


# ---------------------------------------------------------------------------
# The intake seam: what the adapter parses vs. what the catalog persists
# ---------------------------------------------------------------------------


def test_resolution_rewrites_only_what_the_adapter_parses(fetches: List[str]) -> None:
    text = json.dumps(ROOT_SCHEMA)
    intake = _ResolvedIntake(
        raw_bytes=text.encode("utf-8"), text=text, fileset=None, archive_root=None
    )

    resolution = resolve_intake_remote_refs(
        JsonSchemaImportSource(), intake, {"resolve_remote_refs": True}
    )

    assert resolution is not None
    assert "email" in resolution.text  # the document handed to parse() is resolved…
    assert intake.text == text  # …and the intake the catalog persists is untouched
    assert intake.raw_bytes == text.encode("utf-8")


def test_fileset_members_are_resolved_individually(fetches: List[str]) -> None:
    members = {
        "root.json": json.dumps(ROOT_SCHEMA),
        "notes.md": "# not a schema",
    }
    fileset = IntakeFileset.from_members(members, root="root.json")
    intake = _ResolvedIntake(raw_bytes=b"", text=None, fileset=fileset, archive_root="root.json")

    resolution = resolve_intake_remote_refs(
        JsonSchemaImportSource(), intake, {"resolve_remote_refs": True}
    )

    assert resolution is not None and resolution.fileset is not None
    assert "email" in resolution.fileset.members["root.json"]
    assert resolution.fileset.members["notes.md"] == "# not a schema"
    assert fileset.members["root.json"] == members["root.json"]  # original untouched


def test_unparseable_intake_is_left_to_the_adapter(fetches: List[str]) -> None:
    intake = _ResolvedIntake(
        raw_bytes=b"{ nope", text="{ nope", fileset=None, archive_root=None
    )

    assert (
        resolve_intake_remote_refs(
            JsonSchemaImportSource(), intake, {"resolve_remote_refs": True}
        )
        is None
    )
