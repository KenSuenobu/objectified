"""Mock verification record and ``apiome-mock attest`` tests (#4749, PMR-3.2).

The record is what a CI job hands to a release proof, so what matters is that it says the *right*
things and never says more than it knows:

* the corpus has an identity — a declared version and a content digest that survives reformatting
  but not an edit — because "which corpus proved this" is unanswerable from a filename;
* the record carries the bundle digest, runtime version, corpus identity, and fixture-pack digests,
  and nothing that would make it non-deterministic;
* the status is derived from the corpus result, so a job cannot record a verified mock over a red
  one, and a mock that was never exercised says so explicitly;
* the CLI writes a record either way and branches its exit code on the outcome, which is what lets
  a pipeline fail loudly while still keeping the evidence.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from app.mock_bundle import BundleIdentity, build_bundle, bundle_bytes

from apiome_mock import __version__
from apiome_mock.attestation import (
    REASON_CONFORMANCE_FAILED,
    REASON_CONFORMANCE_MISSING,
    RECORD_FORMAT,
    STATUS_FAILED,
    STATUS_MISSING,
    STATUS_VERIFIED,
    build_attestation_block,
    build_verification_record,
)
from apiome_mock.bundle import load_bundle_file
from apiome_mock.cli import main
from apiome_mock.cli_run import EXIT_CONFIG_ERROR, EXIT_CONFORMANCE_FAILED, EXIT_OK
from apiome_mock.conformance import (
    DEFAULT_BUNDLE_PATH,
    DEFAULT_CORPUS_PATH,
    CaseResult,
    ConformanceReport,
    corpus_digest,
    load_corpus,
    report_from_dict,
)

_SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Tiny", "version": "1.0.0"},
    "paths": {"/things": {"get": {"responses": {"200": {"description": "ok"}}}}},
}


def _write_bundle(tmp_path: Path, **identity: Any) -> Path:
    """Write a deterministic bundle to disk exactly as the exporter would."""
    coordinates: dict[str, Any] = {
        "tenant": "acme",
        "project": "tiny",
        "version": "1.0.0",
        "revision_id": "11111111-2222-3333-4444-555555555555",
    }
    coordinates.update(identity)
    document = build_bundle(identity=BundleIdentity(**coordinates), spec=_SPEC)
    path = tmp_path / "bundle.json"
    path.write_bytes(bundle_bytes(document))
    return path


def _report(*, failures: int = 0, total: int = 3) -> ConformanceReport:
    """A conformance report with ``failures`` of ``total`` cases failing."""
    results = []
    for index in range(total):
        failed = index < failures
        results.append(
            CaseResult(
                name=f"case-{index}",
                why="pinned behavior",
                passed=not failed,
                failures=("status 500, expected 200",) if failed else (),
                status=500 if failed else 200,
            )
        )
    return ConformanceReport(
        results=tuple(results),
        base_url="http://127.0.0.1:8775",
        corpus=load_corpus().identity(),
    )


# ---------------------------------------------------------------------------
# Corpus identity
# ---------------------------------------------------------------------------


def test_the_shipped_corpus_declares_a_version_and_resolves_a_digest() -> None:
    """A record has to name the corpus it ran; both halves of that name come from the document."""
    corpus = load_corpus()

    assert corpus.version == "1.0.0"
    assert corpus.digest.startswith("sha256:")
    assert corpus.identity() == {
        "format": corpus.format,
        "version": "1.0.0",
        "digest": corpus.digest,
        "caseCount": len(corpus.cases),
    }


def test_the_corpus_digest_ignores_formatting_but_not_content() -> None:
    """Reindenting a corpus must not look like a different corpus; editing a case must."""
    document = json.loads(DEFAULT_CORPUS_PATH.read_text(encoding="utf-8"))
    reordered = dict(reversed(list(document.items())))

    assert corpus_digest(reordered) == corpus_digest(document)

    edited = json.loads(json.dumps(document))
    edited["cases"][0]["why"] = "something else entirely"
    assert corpus_digest(edited) != corpus_digest(document)


def test_a_report_survives_a_round_trip_through_its_json_rendering() -> None:
    """CI runs the corpus in one step and attests in another, so the report crosses a file."""
    original = _report(failures=1)

    restored = report_from_dict(json.loads(json.dumps(original.as_dict())))

    assert restored.ok == original.ok
    assert [result.name for result in restored.failed] == [result.name for result in original.failed]
    assert restored.corpus == original.corpus


# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------


def test_a_passing_corpus_produces_a_verified_record_with_every_identity(
    tmp_path: Path,
) -> None:
    """All four identities the release proof needs come out of one call."""
    bundle = load_bundle_file(_write_bundle(tmp_path))

    block = build_attestation_block(bundle, _report(), image="ghcr.io/apiome/apiome-mock:0.9.0")

    assert block["status"] == STATUS_VERIFIED
    assert block["reason_code"] is None
    assert block["bundle"]["digest"] == bundle.digest
    assert block["bundle"]["api"]["revision_id"] == "11111111-2222-3333-4444-555555555555"
    assert block["runtime"] == {
        "name": "apiome-mock",
        "version": __version__,
        "image": "ghcr.io/apiome/apiome-mock:0.9.0",
    }
    assert block["conformance"]["corpus_digest"] == load_corpus().digest
    assert block["conformance"]["passed"] == 3


def test_a_failing_corpus_produces_a_failed_record_naming_the_cases(tmp_path: Path) -> None:
    """A job cannot record a verified mock over a red corpus — the status is derived."""
    bundle = load_bundle_file(_write_bundle(tmp_path))

    block = build_attestation_block(bundle, _report(failures=2))

    assert block["status"] == STATUS_FAILED
    assert block["reason_code"] == REASON_CONFORMANCE_FAILED
    assert block["conformance"]["failed_cases"] == ["case-0", "case-1"]
    assert "case-0" in block["reason"]


def test_no_corpus_at_all_produces_an_explicitly_missing_record(tmp_path: Path) -> None:
    """Not running the corpus is a fact worth recording, not a reason to record nothing."""
    bundle = load_bundle_file(_write_bundle(tmp_path))

    block = build_attestation_block(bundle, None)

    assert block["status"] == STATUS_MISSING
    assert block["reason_code"] == REASON_CONFORMANCE_MISSING
    assert block["conformance"] is None
    assert block["bundle"]["digest"] == bundle.digest  # the bundle is still identified


def test_fixture_pack_digests_travel_without_their_contents() -> None:
    """A release proof records which seed data was used, never the data itself."""
    bundle = load_bundle_file(DEFAULT_BUNDLE_PATH)

    block = build_attestation_block(bundle, _report())

    assert block["fixture_packs"], "the packaged conformance bundle carries a fixture pack"
    for pack in block["fixture_packs"]:
        assert pack["digest"].startswith("sha256:")
        assert set(pack) == {
            "name",
            "digest",
            "format",
            "format_version",
            "origin",
            "redaction_status",
        }


def test_the_record_is_deterministic(tmp_path: Path) -> None:
    """Two runs of the same bundle, runtime, and corpus must produce identical evidence."""
    bundle = load_bundle_file(_write_bundle(tmp_path))

    first = build_verification_record(bundle, _report())
    second = build_verification_record(bundle, _report())

    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    assert first["record_format"] == RECORD_FORMAT


# ---------------------------------------------------------------------------
# apiome-mock attest
# ---------------------------------------------------------------------------


def test_attest_without_a_corpus_writes_a_missing_record_and_succeeds(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """An unverified mock is not a CLI failure — the record just says it was never proved."""
    bundle = _write_bundle(tmp_path)
    out = tmp_path / "attestation.json"

    assert main(["attest", "--bundle", str(bundle), "--out", str(out)]) == EXIT_OK

    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["mock"]["status"] == STATUS_MISSING
    assert json.loads(capsys.readouterr().out)["mock"]["status"] == STATUS_MISSING


def test_attest_from_a_stored_report_records_the_verified_result(tmp_path: Path) -> None:
    """The usual CI shape: one job runs the corpus, another turns it into evidence."""
    bundle = _write_bundle(tmp_path)
    report = tmp_path / "conformance.json"
    report.write_text(json.dumps(_report().as_dict()), encoding="utf-8")
    out = tmp_path / "attestation.json"

    exit_code = main(
        [
            "attest",
            "--bundle",
            str(bundle),
            "--conformance",
            str(report),
            "--out",
            str(out),
        ]
    )

    assert exit_code == EXIT_OK
    written = json.loads(out.read_text(encoding="utf-8"))["mock"]
    assert written["status"] == STATUS_VERIFIED
    assert written["conformance"]["corpus_digest"] == load_corpus().digest


def test_attest_from_a_failing_report_still_writes_the_record_but_fails_the_job(
    tmp_path: Path,
) -> None:
    """Evidence of a bad build must be as durable as evidence of a good one."""
    bundle = _write_bundle(tmp_path)
    report = tmp_path / "conformance.json"
    report.write_text(json.dumps(_report(failures=1).as_dict()), encoding="utf-8")
    out = tmp_path / "attestation.json"

    exit_code = main(["attest", "--bundle", str(bundle), "--conformance", str(report), "--out", str(out)])

    assert exit_code == EXIT_CONFORMANCE_FAILED
    assert json.loads(out.read_text(encoding="utf-8"))["mock"]["status"] == STATUS_FAILED


def test_attest_refuses_an_unreadable_conformance_report(tmp_path: Path) -> None:
    """A configuration mistake exits 2, distinct from "the mock failed"."""
    bundle = _write_bundle(tmp_path)

    with pytest.raises(SystemExit) as excinfo:
        main(["attest", "--bundle", str(bundle), "--conformance", str(tmp_path / "nope.json")])

    assert excinfo.value.code == EXIT_CONFIG_ERROR


def test_attest_needs_a_bundle(tmp_path: Path) -> None:
    """There is nothing to attest without one, and the message says which flag to pass."""
    with pytest.raises(SystemExit) as excinfo:
        main(["attest"])

    assert excinfo.value.code == EXIT_CONFIG_ERROR
