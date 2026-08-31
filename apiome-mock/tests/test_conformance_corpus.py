"""Shared mock conformance corpus tests (#4742, PMR-1.2).

The acceptance criterion is "the CLI and the image pass the shared mock conformance corpus". These
tests run the *same* corpus against the two process shapes a deployment can take:

* the application in-process, which is what every other unit test exercises; and
* a real ``apiome-mock run`` subprocess reached over HTTP — the exact command the official image
  runs as its ``run`` entrypoint and the exact command ``apiome mock run`` launches.

They also protect the corpus itself: the committed bundle has to match a fresh deterministic build,
and the runner has to actually fail when a response is wrong (a green corpus that cannot go red
proves nothing).
"""

from __future__ import annotations

import importlib.util
import json
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterator

import pytest
from app.mock_bundle import bundle_bytes
from fastapi.testclient import TestClient

from apiome_mock.bundle import load_bundle_file
from apiome_mock.conformance import (
    CORPUS_FORMAT,
    DEFAULT_BUNDLE_PATH,
    DEFAULT_CORPUS_PATH,
    ConformanceRequest,
    ConformanceResponse,
    check_response,
    discover_mount,
    http_sender,
    load_corpus,
    run_corpus,
    wait_for_ready,
)
from apiome_mock.portable import create_portable_app, version_prefix
from apiome_mock.portable_config import PortableSettings

_REPO = Path(__file__).resolve().parent.parent
_BUILDER = _REPO / "scripts" / "build_conformance_bundle.py"


def _load_builder() -> Any:
    """Import the bundle builder script by path (it lives in scripts/, not in the package)."""
    spec = importlib.util.spec_from_file_location("build_conformance_bundle", _BUILDER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _free_port() -> int:
    """Reserve and release a port, returning its number for a subprocess to bind."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _client_sender(client: TestClient, mount: str) -> Any:
    """Adapt a :class:`TestClient` to the corpus :data:`~apiome_mock.conformance.Sender` protocol."""

    def send(request: ConformanceRequest) -> ConformanceResponse:
        url = request.path if request.absolute else f"{mount}{request.path}"
        response = None
        for _ in range(request.repeat):
            response = client.request(
                request.method,
                url,
                headers=dict(request.headers),
                params=dict(request.query),
                json=request.json_body,
            )
        assert response is not None
        return ConformanceResponse(
            status=response.status_code,
            headers={key.lower(): value for key, value in response.headers.items()},
            body=response.content,
        )

    return send


# ---------------------------------------------------------------------------
# The corpus and its bundle
# ---------------------------------------------------------------------------


def test_corpus_declares_the_supported_format() -> None:
    corpus = load_corpus()

    assert corpus.format == CORPUS_FORMAT
    assert corpus.bundle == "bundle.json"
    assert len(corpus.cases) >= 20


def test_every_case_explains_why_it_exists() -> None:
    """A failing case has to be diagnosable by someone who has never read the corpus."""
    for case in load_corpus().cases:
        assert case.why, f"case '{case.name}' has no 'why'"
        assert "status" in case.expect


def test_corpus_and_bundle_ship_inside_the_package() -> None:
    """The image must be able to verify itself with nothing mounted."""
    package_root = Path(__import__("apiome_mock").__file__ or "").resolve().parent

    assert DEFAULT_CORPUS_PATH.is_file()
    assert DEFAULT_BUNDLE_PATH.is_file()
    assert package_root in DEFAULT_CORPUS_PATH.parents
    assert package_root in DEFAULT_BUNDLE_PATH.parents


def test_committed_bundle_matches_a_fresh_deterministic_build() -> None:
    """Bundles are byte-deterministic, so an edited spec without a regenerate is caught here."""
    rebuilt = bundle_bytes(_load_builder().build())

    assert DEFAULT_BUNDLE_PATH.read_bytes() == rebuilt


def test_the_committed_bundle_verifies_offline() -> None:
    loaded = load_bundle_file(DEFAULT_BUNDLE_PATH)

    assert loaded.tenant_slug == "conformance"
    assert loaded.signed is False  # unsigned on purpose: the corpus must run with no secret
    # The built-ins are defined on every mock (#5532, MSC-2.2); this corpus's own `slow` shadows
    # the built-in of that name.
    assert sorted(loaded.scenarios) == [
        "flaky-list",
        "happy-path",
        "not-found",
        "outage",
        "quota-exceeded",
        "server-error",
        "slow",
        "templated-lookup",
    ]
    assert sorted(loaded.fixture_packs) == ["seeded-pets"]


def test_the_corpus_pins_the_bundled_fixture_pack_digest() -> None:
    """The corpus asserts a pack digest literally; this catches an edit that moves it (#4748).

    Without this, changing the pack's seed data would fail the corpus with a digest mismatch that
    reads like a runtime bug rather than "you edited the pack and did not update the corpus".
    """
    pack = load_bundle_file(DEFAULT_BUNDLE_PATH).fixture_packs["seeded-pets"]
    pinned = {
        case.expect["jsonEquals"]["packs"][0]["digest"]
        for case in load_corpus().cases
        if case.name == "fixture-pack-listing-reports-the-pack-digest"
    }

    assert pinned == {pack.digest}, (
        f"corpus pins {pinned}, bundled pack digests to {pack.digest}; "
        "regenerate the bundle and update the corpus together"
    )


def test_the_corpus_covers_every_behavior_family() -> None:
    """PMR-3.1 acceptance: scenario, session, validation, chaos, and fixture behavior are covered.

    Families are matched against case names so a corpus that loses a whole area of coverage fails
    here rather than silently shrinking.
    """
    names = [case.name for case in load_corpus().cases]
    families = {
        "routing": ("path-parameters", "unmatched-path", "wrong-method"),
        "validation": ("validation", "missing-required-body", "undeclared-status", "unsatisfiable-accept"),
        "scenario": ("scenario-header", "scenario-sequences", "unknown-scenario"),
        "rules-and-templates": ("declarative-rule", "unmatched-rule"),
        "session": ("session-state-is-readable", "session-state-does-not-leak", "session-reset"),
        "chaos": ("chaos-error-injection", "chaos-delay"),
        "fixture": ("fixture-pack-listing", "seeded-session", "unknown-fixture-pack"),
        "determinism": ("seeded-synthesis",),
    }

    missing = {
        family: markers
        for family, markers in families.items()
        if not all(any(marker in name for name in names) for marker in markers)
    }

    assert missing == {}


# ---------------------------------------------------------------------------
# Running the corpus
# ---------------------------------------------------------------------------


@pytest.fixture
def in_process_report() -> Any:
    """Run the whole corpus against the in-process application."""
    bundle = load_bundle_file(DEFAULT_BUNDLE_PATH)
    settings = PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH))
    with TestClient(create_portable_app(bundle, settings)) as client:
        return run_corpus(_client_sender(client, version_prefix(bundle)), corpus=load_corpus())


def test_in_process_runtime_passes_every_case(in_process_report: Any) -> None:
    failures = {result.name: result.failures for result in in_process_report.failed}

    assert failures == {}
    assert in_process_report.ok


def test_report_records_every_case(in_process_report: Any) -> None:
    payload = in_process_report.as_dict()

    assert payload["total"] == len(load_corpus().cases)
    assert payload["failed"] == 0
    assert payload["ok"] is True


@pytest.fixture(scope="module")
def running_runtime() -> Iterator[str]:
    """Launch ``apiome-mock run`` as a real subprocess and yield its base URL.

    This is the process the official image runs and the process ``apiome mock run`` launches, so
    passing the corpus here is what makes the CLI/image parity claim concrete.
    """
    port = _free_port()
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "apiome_mock",
            "run",
            "--bundle",
            str(DEFAULT_BUNDLE_PATH),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        if not wait_for_ready(base_url, timeout=60.0):
            process.terminate()
            output = process.communicate(timeout=30)[0]
            pytest.fail(f"apiome-mock run did not become ready:\n{output}")
        yield base_url
    finally:
        process.terminate()
        try:
            process.communicate(timeout=30)
        except subprocess.TimeoutExpired:  # pragma: no cover - defensive
            process.kill()


def test_launched_runtime_passes_every_case(running_runtime: str) -> None:
    """The corpus over real HTTP, against the command the CLI and the image both execute."""
    mount = discover_mount(running_runtime)
    assert mount == "/conformance/petstore/1.0.0"

    report = run_corpus(http_sender(running_runtime, mount=mount), corpus=load_corpus(), base_url=running_runtime)

    assert {result.name: result.failures for result in report.failed} == {}


# ---------------------------------------------------------------------------
# The runner has to be able to fail
# ---------------------------------------------------------------------------


def test_status_mismatch_is_reported() -> None:
    response = ConformanceResponse(status=500, headers={}, body=b"")

    failures = check_response(response, {"status": 200})

    assert failures == ("status: expected 200, got 500",)


def test_header_and_content_type_mismatches_are_reported() -> None:
    response = ConformanceResponse(
        status=200,
        headers={"content-type": "text/plain", "x-mock-chaos": "delay"},
        body=b"",
    )

    failures = check_response(
        response,
        {
            "status": 200,
            "contentType": "application/json",
            "headers": {"X-Mock-Chaos": "error"},
            "headerPresent": ["Retry-After"],
        },
    )

    assert len(failures) == 3


def test_json_contains_reports_the_offending_pointer() -> None:
    response = ConformanceResponse(
        status=200,
        headers={},
        body=json.dumps({"bundle": {"tenant": "other"}}).encode("utf-8"),
    )

    failures = check_response(response, {"status": 200, "jsonContains": {"bundle": {"tenant": "conformance"}}})

    assert failures == ("/bundle/tenant: expected 'conformance', got 'other'",)


def test_body_empty_and_json_equals_are_enforced() -> None:
    response = ConformanceResponse(status=204, headers={}, body=b"{}")

    assert check_response(response, {"status": 204, "bodyEmpty": True})
    assert check_response(response, {"status": 204, "jsonEquals": {"a": 1}})


def test_a_transport_failure_fails_the_case_without_aborting_the_run() -> None:
    """One unreachable route must not hide the verdicts of every other case."""

    def broken(_: ConformanceRequest) -> ConformanceResponse:
        raise ConnectionRefusedError("nothing is listening")

    report = run_corpus(broken, corpus=load_corpus())

    assert not report.ok
    assert len(report.failed) == len(load_corpus().cases)
    assert "nothing is listening" in report.failed[0].failures[0]


# ---------------------------------------------------------------------------
# Corpus validation
# ---------------------------------------------------------------------------


def test_an_unknown_corpus_format_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps({"corpusFormat": "something/v9", "cases": []}), encoding="utf-8")

    with pytest.raises(ValueError, match="Unsupported conformance corpus format"):
        load_corpus(path)


@pytest.mark.parametrize(
    ("cases", "message"),
    [
        ([], "non-empty"),
        ([{"name": "", "request": {"method": "GET", "path": "/"}, "expect": {"status": 200}}], "needs a 'name'"),
        ([{"name": "a", "request": {"method": "GET", "path": "pets"}, "expect": {"status": 200}}], "must start with"),
        ([{"name": "a", "request": {"method": "GET", "path": "/"}, "expect": {}}], "must expect a status"),
        (
            [
                {"name": "a", "request": {"method": "GET", "path": "/"}, "expect": {"status": 200}},
                {"name": "a", "request": {"method": "GET", "path": "/"}, "expect": {"status": 200}},
            ],
            "Duplicate",
        ),
    ],
)
def test_malformed_cases_are_refused(tmp_path: Path, cases: list[dict[str, Any]], message: str) -> None:
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps({"corpusFormat": CORPUS_FORMAT, "cases": cases}), encoding="utf-8")

    with pytest.raises(ValueError, match=message):
        load_corpus(path)


def test_discover_mount_returns_empty_when_the_runtime_is_unreachable() -> None:
    """An unreachable runtime is reported by the cases themselves, not by an exception here."""
    assert discover_mount("http://127.0.0.1:1", timeout=0.5) == ""
