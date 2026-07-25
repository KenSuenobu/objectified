"""Negative corpus contract tests — IXH-1.3 (#5089).

Every ``invalid`` corpus entry is driven through the REAL in-process import
pipeline (:func:`app.import_source_pipeline.run_adapter_import_job`) with
persistence blocked, asserting the IXH-1.3 acceptance criteria:

* the job reaches a terminal ``failed`` state (never an unhandled exception),
* the terminal status carries the manifest-declared taxonomy ``error.code``
  with a non-empty remediation hint,
* persistence is never invoked, so no catalog item / project / version / type
  row can be left behind,
* wrong-format entries are either not claimed by the target adapter's
  ``detect()`` or rejected with the ``FORMAT_MISMATCH`` code.

Coverage floors (>= 5 entries spanning >= 5 distinct failure classes per
shipped adapter) live in :mod:`tests.test_corpus_manifest`; the HTTP-level
"never a 5xx" smoke lives in :mod:`tests.test_spec_import_contract`.
"""

from __future__ import annotations

import base64
from functools import lru_cache
from typing import List

import pytest
from corpus_loader import CorpusEntry, FailureClass, ValidityClass, load_corpus

from app import import_source_pipeline
from app.import_source import (
    DetectionInput,
    ImportSource,
    get_import_source,
    load_builtin_import_sources,
    resolve_import_source_key,
)

load_builtin_import_sources()


@lru_cache(maxsize=None)
def _tool_available(tool: str) -> bool:
    from app.toolchain_packaging import probe_tool

    return probe_tool(tool).available


def _missing_tools(adapter_key: str) -> List[str]:
    """Bundled tools the adapter needs that are not resolvable here."""
    adapter = get_import_source(resolve_import_source_key(adapter_key))
    return [tool for tool in getattr(adapter, "required_tools", ()) if not _tool_available(tool)]


def _adapter_for(entry: CorpusEntry) -> ImportSource:
    assert entry.adapter_key is not None
    return get_import_source(resolve_import_source_key(entry.adapter_key))


def _negative_entries() -> List[CorpusEntry]:
    return [
        entry
        for entry in load_corpus(validity_class=ValidityClass.INVALID)
        if entry.adapter_key is not None
    ]


def _negative_param(entry: CorpusEntry) -> "pytest.param":
    marks = []
    missing = _missing_tools(entry.adapter_key)  # type: ignore[arg-type]
    if missing:
        marks.append(
            pytest.mark.skip(reason=f"bundled {', '.join(missing)} not resolvable in this environment")
        )
    return pytest.param(entry, id=entry.path, marks=marks)


def _payload_for(entry: CorpusEntry) -> dict:
    """Worker-style payload carrying the fixture's raw bytes (never pre-decoded)."""
    return {
        "rest_job_id": f"negative-{entry.path}",
        "metadata": {
            "source_kind": entry.adapter_key,
            "project": {"name": "Negative", "slug": "negative"},
            "version": {"version_id": "0.0.1"},
            "options": {},
        },
        "document_base64": base64.standard_b64encode(entry.read_bytes()).decode("ascii"),
        "filename": entry.path.rsplit("/", 1)[-1],
    }


@pytest.fixture()
def _blocked_persistence(monkeypatch):
    """Fail the test if the pipeline ever reaches a persistence hook.

    Parse/normalize failures must terminate the job before any store call, so a
    negative fixture can never leave a catalog item, project, version, or type
    row behind. Reaching either hook is itself the failure being asserted.
    """
    calls: List[str] = []

    def _record(name):
        def _hook(*args, **kwargs):
            calls.append(name)
            raise AssertionError(f"negative fixture reached {name}")

        return _hook

    monkeypatch.setattr(
        import_source_pipeline, "persist_adapter_import", _record("persist_adapter_import")
    )
    monkeypatch.setattr(
        import_source_pipeline, "persist_types_as_current", _record("persist_types_as_current")
    )
    return calls


@pytest.mark.parametrize("entry", [_negative_param(e) for e in _negative_entries()])
async def test_negative_entry_fails_with_declared_code(entry, _blocked_persistence):
    """IXH-1.3 acceptance: terminal failed job, declared code, hint, no writes."""
    final = await import_source_pipeline.run_adapter_import_job(
        _adapter_for(entry), _payload_for(entry)
    )

    assert final.state == "failed", (
        f"{entry.path}: expected the import job to fail, got {final.state!r}"
    )
    assert final.error is not None, f"{entry.path}: failed job carries no error payload"
    assert final.error.code == entry.expected_error_code, (
        f"{entry.path}: job failed with {final.error.code}, "
        f"manifest declares {entry.expected_error_code} ({final.error.message!r})"
    )
    assert final.error.remediation.strip(), f"{entry.path}: remediation hint is empty"
    assert final.error.message.strip(), f"{entry.path}: error message is empty"
    assert final.result is None, f"{entry.path}: failed job must not carry a result"
    assert _blocked_persistence == [], (
        f"{entry.path}: persistence reached for a negative fixture"
    )


@pytest.mark.parametrize(
    "entry",
    [
        _negative_param(e)
        for e in _negative_entries()
        if e.failure_class is FailureClass.WRONG_FORMAT
    ],
)
def test_wrong_format_entry_is_unclaimed_or_rejected_as_mismatch(entry):
    """IXH-1.3 acceptance: wrong-format inputs are either not claimed by
    ``detect()`` or rejected with a format-mismatch code."""
    adapter = _adapter_for(entry)
    text = entry.read_bytes().decode("utf-8", errors="replace")
    try:
        claimed = adapter.detect(
            DetectionInput(text=text, filename=entry.path.rsplit("/", 1)[-1])
        ).matched
    except Exception:  # noqa: BLE001 - a raising sniffer certainly did not claim it
        claimed = False
    assert (not claimed) or entry.expected_error_code == "FORMAT_MISMATCH", (
        f"{entry.path}: claimed by {adapter.key}.detect() but declared "
        f"{entry.expected_error_code} instead of FORMAT_MISMATCH"
    )


def test_negative_corpus_is_nonempty():
    """Guard against the parametrized suites silently collecting nothing."""
    assert len(_negative_entries()) >= 5
