"""Hosted vs portable conformance parity tests (#4748, PMR-3.1).

The acceptance criterion is "hosted and portable results match for every fixture". These tests run
the *same* shared corpus against both deployment shapes and diff every response:

* the **hosted** runtime — ``apiome_mock.server.create_app``, the Postgres-backed application, with
  its spec resolution answered from the conformance bundle instead of a database (the corpus
  fixture *is* the published version, so there is nothing for a database to add); and
* the **portable** runtime — ``apiome_mock.portable.create_portable_app`` serving that same bundle.

They also protect the comparison itself: a parity runner that cannot report a difference would
prove nothing, so the differing-response cases below are as important as the matching ones.
"""

from __future__ import annotations

from typing import Any, Iterator
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from apiome_mock.bundle import load_bundle_file
from apiome_mock.conformance import (
    DEFAULT_BUNDLE_PATH,
    ConformanceRequest,
    ConformanceResponse,
    load_corpus,
)
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.parity import COMPARED_HEADERS, compare_responses, run_parity
from apiome_mock.portable import create_portable_app, version_prefix
from apiome_mock.portable_config import PortableSettings
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache

MOUNT = "/conformance/petstore/1.0.0"


def _client_sender(client: TestClient, mount: str) -> Any:
    """Adapt a :class:`TestClient` to the corpus sender protocol."""

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


def _session_store() -> InMemorySessionStore:
    """A session store with the same caps both deployments run with by default."""
    return InMemorySessionStore(
        SessionCaps(ttl_seconds=3600.0, max_resources=200, max_bytes=1_048_576, max_sessions=10_000),
    )


@pytest.fixture
def portable_client() -> Iterator[TestClient]:
    """The portable runtime serving the conformance bundle."""
    bundle = load_bundle_file(DEFAULT_BUNDLE_PATH)
    settings = PortableSettings(bundle=str(DEFAULT_BUNDLE_PATH))
    with TestClient(create_portable_app(bundle, settings)) as client:
        assert version_prefix(bundle) == MOUNT
        yield client


@pytest.fixture
def hosted_client(monkeypatch: pytest.MonkeyPatch, mock_pool: Any) -> Iterator[TestClient]:
    """The hosted (database-backed) runtime serving the same bundle's compiled spec.

    Only the *resolution* of the spec is stubbed — access status and the Postgres read. Everything
    the parity comparison observes (routing, validation, scenarios, chaos, sessions, templates,
    fixture packs, the lifecycle control plane) is the hosted application's own code path.
    """
    compiled = load_bundle_file(DEFAULT_BUNDLE_PATH).to_compiled_spec()
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    with (
        patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
        patch("apiome_mock.server.resolve_limits_for_tenant", new=AsyncMock(return_value=None)),
        patch("apiome_mock.server.record_mock_request"),
        patch("apiome_mock.handler.get_mock_access_status", new=AsyncMock(return_value="ok")),
        patch("apiome_mock.handler.load_compiled_spec", new=AsyncMock(return_value=compiled)),
    ):
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            app.state.db_pool = mock_pool
            app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
            app.state.session_store = _session_store()
            yield client
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# The acceptance criterion
# ---------------------------------------------------------------------------


@pytest.fixture
def parity_report(hosted_client: TestClient, portable_client: TestClient) -> Any:
    """Run the whole shared corpus against both deployments and diff every response."""
    return run_parity(
        _client_sender(hosted_client, MOUNT),
        _client_sender(portable_client, MOUNT),
        corpus=load_corpus(),
        hosted_url="hosted://in-process",
        portable_url="portable://in-process",
    )


def test_hosted_and_portable_answer_every_case_identically(parity_report: Any) -> None:
    differences = {case.name: case.differences for case in parity_report.mismatched}

    assert differences == {}
    assert parity_report.ok


def test_parity_compares_the_whole_corpus_minus_deployment_endpoints(parity_report: Any) -> None:
    corpus = load_corpus()
    skipped = {case.name for case in parity_report.cases if case.skipped}

    # Only the reserved operational endpoints are excluded, and they are reported as skipped
    # rather than quietly dropped.
    assert skipped == {case.name for case in corpus.cases if case.request.absolute}
    assert skipped == {"health-is-reserved-and-live", "ready-reports-the-served-bundle"}
    assert len(parity_report.compared) == len(corpus.cases) - len(skipped)


def test_parity_report_renders_for_ci(parity_report: Any) -> None:
    payload = parity_report.as_dict()

    assert payload["ok"] is True
    assert payload["mismatched"] == 0
    assert payload["compared"] == len(parity_report.compared)
    assert payload["skipped"] == 2
    assert payload["hostedUrl"] == "hosted://in-process"
    assert payload["portableUrl"] == "portable://in-process"
    assert {case["name"] for case in payload["cases"]} == {case.name for case in load_corpus().cases}
    assert "deployment-shape cases skipped" in parity_report.summary()


def test_both_deployments_serve_the_fixture_pack_lifecycle(
    hosted_client: TestClient, portable_client: TestClient
) -> None:
    """The lifecycle control plane is the newest surface; assert it explicitly on both shapes."""
    for client in (hosted_client, portable_client):
        listing = client.get(f"{MOUNT}/__mock__/fixture-packs")
        assert listing.status_code == 200
        assert [pack["name"] for pack in listing.json()["packs"]] == ["seeded-pets"]

        reset = client.post(
            f"{MOUNT}/__mock__/session/reset",
            headers={"X-Mock-Session": "parity"},
            json={"pack": "seeded-pets"},
        )
        assert reset.status_code == 200
        assert reset.json()["resources"] == 2

        seeded = client.get(f"{MOUNT}/pets", headers={"X-Mock-Session": "parity"})
        assert [pet["name"] for pet in seeded.json()] == ["Rex", "Bella"]


# ---------------------------------------------------------------------------
# The comparison has to be able to report a difference
# ---------------------------------------------------------------------------


def _response(status: int = 200, headers: dict[str, str] | None = None, body: bytes = b"{}") -> ConformanceResponse:
    """Build a response for the comparison unit tests."""
    return ConformanceResponse(status=status, headers=headers or {}, body=body)


def test_identical_responses_have_no_differences() -> None:
    hosted = _response(headers={"content-type": "application/json"}, body=b'{"a": 1}')
    portable = _response(headers={"content-type": "application/json"}, body=b'{"a":1}')

    # Same JSON, different whitespace: structural comparison, not byte comparison.
    assert compare_responses(hosted, portable) == ()


def test_status_difference_is_reported() -> None:
    differences = compare_responses(_response(status=200), _response(status=503))

    assert differences == ("status: hosted 200, portable 503",)


def test_semantic_header_difference_is_reported() -> None:
    hosted = _response(headers={"x-mock-scenario": "quota-exceeded"})
    portable = _response(headers={"x-mock-scenario": "outage"})

    differences = compare_responses(hosted, portable)

    assert differences == ("header x-mock-scenario: hosted 'quota-exceeded', portable 'outage'",)


def test_a_missing_header_on_one_side_is_reported() -> None:
    differences = compare_responses(_response(headers={"x-mock-chaos": "error"}), _response())

    assert differences == ("header x-mock-chaos: hosted 'error', portable None",)


def test_transport_headers_are_not_compared() -> None:
    hosted = _response(headers={"date": "Mon, 01 Jan 2035 00:00:00 GMT", "server": "uvicorn", "content-length": "2"})
    portable = _response(headers={"date": "Tue, 02 Jan 2035 00:00:00 GMT", "server": "gunicorn"})

    assert compare_responses(hosted, portable) == ()


def test_content_type_parameters_are_ignored() -> None:
    hosted = _response(headers={"content-type": "application/json; charset=utf-8"})
    portable = _response(headers={"content-type": "application/json"})

    assert compare_responses(hosted, portable) == ()


def test_body_difference_is_reported() -> None:
    differences = compare_responses(_response(body=b'{"a": 1}'), _response(body=b'{"a": 2}'))

    assert len(differences) == 1
    assert differences[0].startswith("body: hosted ")


def test_json_versus_non_json_body_is_reported() -> None:
    differences = compare_responses(_response(body=b'{"a": 1}'), _response(body=b"plain text"))

    assert differences == ("body: hosted is JSON, portable is non-JSON",)


def test_empty_bodies_match() -> None:
    assert compare_responses(_response(body=b""), _response(body=b"")) == ()


def test_extra_compared_headers_can_be_requested() -> None:
    hosted = _response(headers={"x-custom": "a"})
    portable = _response(headers={"x-custom": "b"})

    assert compare_responses(hosted, portable) == ()
    assert compare_responses(hosted, portable, headers=(*COMPARED_HEADERS, "x-custom")) == (
        "header x-custom: hosted 'a', portable 'b'",
    )


# ---------------------------------------------------------------------------
# Runner behavior
# ---------------------------------------------------------------------------


def _sender(responses: dict[str, ConformanceResponse], *, fail: str | None = None) -> Any:
    """Build a sender that answers by path, optionally raising for one path."""

    def send(request: ConformanceRequest) -> ConformanceResponse:
        if fail is not None and request.path == fail:
            raise ConnectionRefusedError("connection refused")
        return responses.get(request.path, _response())

    return send


def _one_case_corpus(tmp_path: Any, expect_status: int = 200) -> Any:
    """Write and load a single-case corpus for runner tests."""
    import json

    document = {
        "corpusFormat": "apiome.mock.conformance/v1",
        "description": "runner test",
        "bundle": "bundle.json",
        "cases": [
            {
                "name": "only-case",
                "why": "exercises the runner",
                "request": {"method": "GET", "path": "/pets"},
                "expect": {"status": expect_status},
            }
        ],
    }
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return load_corpus(path)


def test_an_unreachable_hosted_deployment_fails_the_case_without_aborting(tmp_path: Any) -> None:
    corpus = _one_case_corpus(tmp_path)

    report = run_parity(_sender({}, fail="/pets"), _sender({}), corpus=corpus)

    assert report.ok is False
    assert report.mismatched[0].differences == ("hosted request failed: connection refused",)
    assert report.mismatched[0].hosted_status is None


def test_an_unreachable_portable_deployment_keeps_the_hosted_status(tmp_path: Any) -> None:
    corpus = _one_case_corpus(tmp_path)

    report = run_parity(_sender({}), _sender({}, fail="/pets"), corpus=corpus)

    assert report.mismatched[0].differences == ("portable request failed: connection refused",)
    assert report.mismatched[0].hosted_status == 200
    assert report.mismatched[0].portable_status is None


def test_matching_deployments_report_both_statuses(tmp_path: Any) -> None:
    corpus = _one_case_corpus(tmp_path)

    report = run_parity(_sender({}), _sender({}), corpus=corpus)

    assert report.ok
    assert report.cases[0].hosted_status == 200
    assert report.cases[0].portable_status == 200
    assert report.summary() == "1/1 cases match between hosted and portable"
