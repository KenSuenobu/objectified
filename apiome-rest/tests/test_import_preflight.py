"""Pre-flight lint and rank API — IXH-2.1 (#5096).

Covers the acceptance criteria for ``POST /v1/tenants/{slug}/import/preflight``:

* nothing is persisted — the persistence hooks are booby-trapped for every call;
* the reported lint score/grade/fingerprint is byte-identical to what the committing
  import produces for the same document and style guide;
* findings come back ranked, with rule id, severity, message, location, and remediation;
* failures carry an IXH-6.4 taxonomy code (never a stringified exception), over a 200;
* identical bytes are served from a tenant-scoped cache that reports the hit and is
  invalidated when the tenant's style guide changes.

The corpus-wide sweep (every valid entry pre-flights, every negative entry returns its
taxonomy code) lives in :mod:`tests.test_corpus_preflight`.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any, Dict, Optional

import pytest
from fastapi.testclient import TestClient

from app import import_export_quality_policy as quality_policy
from app import import_preflight, import_source_pipeline
from app.auth import validate_authentication
from app.import_preflight import (
    PREFLIGHT_CACHE_MAX_ENTRIES,
    clear_preflight_cache,
    preflight_cache_size,
    run_import_preflight,
)
from app.import_source import get_import_source, load_builtin_import_sources
from app.import_source_pipeline import ImportRunArtifacts, run_adapter_import_job
from app.intake_resource_guard import IntakeLimitError
from app.main import app
from app.models import ImportPreflightRequest
from app.schema_lint import SEVERITY_PENALTY

load_builtin_import_sources()

client = TestClient(app)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"
USER_ID = "660e8400-e29b-41d4-a716-446655440001"

_MOCK_AUTH = {
    "tenant_id": TENANT_ID,
    "tenant_slug": TENANT_SLUG,
    "user_id": USER_ID,
    "auth_method": "jwt",
}

#: A GraphQL schema that lints with findings of more than one severity, so the ranking
#: assertions have something to order. Undocumented on purpose.
GRAPHQL_DOC = """
type Query {
  order(id: ID!): Order
}

type Order {
  id: ID!
  total: Float
}
""".strip()

#: Syntactically broken GraphQL — the parse phase must reject it with a taxonomy code.
BROKEN_GRAPHQL_DOC = "type Query { order(id: ID! : Order"


def _b64(text: str) -> str:
    return base64.standard_b64encode(text.encode("utf-8")).decode("ascii")


def _raise_too_large(*_args: Any, **_kwargs: Any) -> None:
    """Stand in for the intake size guard tripping, without a multi-megabyte fixture."""
    raise IntakeLimitError("Source document is too large", code="INPUT_TOO_LARGE")


def _request(**overrides: Any) -> ImportPreflightRequest:
    """Build a pre-flight request for :data:`GRAPHQL_DOC` with optional overrides."""
    payload: Dict[str, Any] = {
        "document_base64": _b64(GRAPHQL_DOC),
        "filename": "schema.graphql",
    }
    payload.update(overrides)
    return ImportPreflightRequest(**payload)


@pytest.fixture(autouse=True)
def _auth_override():
    def _fake_auth(tenant_slug: str):
        return {**_MOCK_AUTH, "tenant_slug": tenant_slug}

    app.dependency_overrides[validate_authentication] = _fake_auth
    app.openapi_schema = None
    yield
    app.dependency_overrides.pop(validate_authentication, None)
    app.openapi_schema = None


@pytest.fixture(autouse=True)
def _clean_cache():
    """Every test starts and ends with an empty pre-flight cache."""
    clear_preflight_cache()
    yield
    clear_preflight_cache()


@pytest.fixture(autouse=True)
def _no_persistence(monkeypatch):
    """Booby-trap every persistence hook for the whole module.

    Pre-flight must never write a catalog item, project, version, type row, or job
    artifact, so reaching any store call is itself the failure — asserted for every test
    in the module rather than only the one that names it.
    """
    reached: list[str] = []

    def _trap(name: str):
        def _hook(*args: Any, **kwargs: Any):
            reached.append(name)
            raise AssertionError(f"pre-flight reached {name}")

        return _hook

    monkeypatch.setattr(
        import_source_pipeline, "persist_adapter_import", _trap("persist_adapter_import")
    )
    monkeypatch.setattr(
        import_source_pipeline, "persist_types_as_current", _trap("persist_types_as_current")
    )
    monkeypatch.setattr(
        import_source_pipeline,
        "capture_canonical_quality_score",
        _trap("capture_canonical_quality_score"),
    )
    return reached


# ---------------------------------------------------------------------------
# Contract surface
# ---------------------------------------------------------------------------


def test_openapi_exposes_the_preflight_operation():
    spec = app.openapi()
    path = "/v1/tenants/{tenant_slug}/import/preflight"
    assert path in spec["paths"], "pre-flight route missing from the OpenAPI contract"
    assert "post" in spec["paths"][path]
    schema_ref = spec["paths"][path]["post"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]["$ref"]
    assert schema_ref.endswith("ImportPreflightReport")


def test_preflight_route_returns_a_full_report():
    response = client.post(
        f"/v1/tenants/{TENANT_SLUG}/import/preflight",
        json={"document_base64": _b64(GRAPHQL_DOC), "filename": "schema.graphql"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["detection"]["adapter_key"] == "graphql"
    assert body["detection"]["confidence"] > 0
    assert body["routing"]["target"] == "catalog"
    assert body["fingerprint"]
    assert body["counts"]["operations"] >= 1
    assert body["lint"]["grade"]
    assert body["style_guide"]["name"]
    assert body["policy"]["blocking"] is False
    assert body["cache"]["hit"] is False
    assert body["cache"]["content_hash"]


def test_preflight_policy_permits_override_while_nothing_blocks():
    """The default verdict must never read as "override forbidden" (IXH-2.2).

    The wizard's quality step only offers an "Import anyway" waiver path when policy
    permits an override, so a tenant with no policy has to say so explicitly.
    """
    response = client.post(
        f"/v1/tenants/{TENANT_SLUG}/import/preflight",
        json={"document_base64": _b64(GRAPHQL_DOC), "filename": "schema.graphql"},
    )
    assert response.status_code == 200, response.text
    policy = response.json()["policy"]
    assert policy["blocking"] is False
    assert policy["allow_override"] is True
    assert policy["source"] == "default"
    assert policy["failures"] == []


def test_preflight_rejects_unknown_request_fields():
    response = client.post(
        f"/v1/tenants/{TENANT_SLUG}/import/preflight",
        json={"document_base64": _b64(GRAPHQL_DOC), "not_a_field": 1},
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# No writes, and parity with the committing import
# ---------------------------------------------------------------------------


async def test_preflight_never_persists(_no_persistence):
    report = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG, user_id=USER_ID
    )
    assert report.ok is True
    assert _no_persistence == [], "pre-flight reached a persistence hook"


def test_preflight_creates_no_import_job():
    """No async job artifact: the endpoint runs the pipeline itself, it never schedules one."""
    from app import spec_import_engine

    spec_import_engine._jobs.clear()
    response = client.post(
        f"/v1/tenants/{TENANT_SLUG}/import/preflight",
        json={"document_base64": _b64(GRAPHQL_DOC), "filename": "schema.graphql"},
    )
    assert response.status_code == 200, response.text
    assert spec_import_engine._jobs == {}, "pre-flight registered an import job"
    listed = client.get(f"/v1/tenants/{TENANT_SLUG}/imports")
    assert listed.status_code == 200
    assert listed.json()["jobs"] == []


async def test_oversized_payload_is_rejected_before_detection(monkeypatch):
    """The IXH-1.4 byte ceiling applies to pre-flight too, ahead of any sniffing."""
    monkeypatch.setattr(
        import_preflight,
        "detect_format",
        lambda *_a, **_k: pytest.fail("an oversized payload must never reach detection"),
    )
    monkeypatch.setattr(
        import_preflight,
        "guard_payload_bytes",
        _raise_too_large,
    )
    report = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert report.ok is False
    assert report.error is not None and report.error.code == "INPUT_TOO_LARGE"
    assert report.error.category == "resource"


async def test_preflight_forces_dry_run_on_the_pipeline(monkeypatch):
    """The pipeline is driven with dry-run semantics, whatever the caller asked for."""
    seen: Dict[str, Any] = {}
    original = import_preflight.run_adapter_import_job

    async def _spy(adapter, payload, **kwargs):
        seen["options"] = payload["metadata"]["options"]
        seen["tenant_id"] = payload["tenant_id"]
        return await original(adapter, payload, **kwargs)

    monkeypatch.setattr(import_preflight, "run_adapter_import_job", _spy)
    await run_import_preflight(
        _request(import_target="catalog", input_kind="paste"),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert seen["options"]["dry_run"] is True
    assert seen["options"]["import_target"] == "catalog"
    assert seen["options"]["input_kind"] == "paste"
    assert seen["tenant_id"] == TENANT_ID


async def test_lint_verdict_matches_the_committing_import(monkeypatch):
    """The reported score/grade/fingerprint is the committing import's, byte for byte."""
    report = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG, user_id=USER_ID
    )

    # Drive the *committing* path (no dry_run) with only the store call stubbed out, so
    # every scoring step — including style-guide resolution — runs exactly as it would
    # for a real import of the same document under the same tenant.
    monkeypatch.setattr(import_source_pipeline, "persist_adapter_import", lambda *a, **k: None)
    artifacts = ImportRunArtifacts()
    status = await run_adapter_import_job(
        get_import_source("graphql"),
        {
            "rest_job_id": "commit-parity",
            "tenant_slug": TENANT_SLUG,
            "tenant_id": TENANT_ID,
            "user_id": USER_ID,
            "metadata": {
                "source_kind": "graphql",
                "project": {"name": "Parity", "slug": "parity"},
                "version": {"version_id": "1.0.0"},
                "options": {},
            },
            "document_base64": _b64(GRAPHQL_DOC),
            "filename": "schema.graphql",
        },
        artifacts=artifacts,
    )
    assert status.state == "completed", status.error

    committed = status.summary["lint"]
    assert report.lint is not None
    assert report.lint.score == committed["score"]
    assert report.lint.grade == committed["grade"]
    assert report.lint.report_fingerprint == committed["report_fingerprint"]
    assert report.lint.severity_counts == committed["severity_counts"]
    assert len(report.lint.findings) == committed["findings"]
    assert report.fingerprint == status.summary["fingerprint"]
    assert report.routing == status.summary["routing"]
    assert artifacts.lint is not None
    assert report.lint.rule_hits == dict(artifacts.lint.rule_hits)


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------


async def test_findings_are_ranked_by_severity_then_rule_weight():
    report = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert report.lint is not None
    findings = report.lint.findings
    assert findings, "the fixture should produce lint findings to rank"

    assert [f.rank for f in findings] == list(range(1, len(findings) + 1))
    keys = [(-SEVERITY_PENALTY.get(f.severity, 0.0), -f.rule_penalty) for f in findings]
    assert keys == sorted(keys), "findings are not ordered by severity then rule weight"

    for finding in findings:
        assert finding.rule
        assert finding.severity in {"error", "warning", "info"}
        assert finding.message.strip()
        assert finding.weight == SEVERITY_PENALTY.get(finding.severity, 0.0)
        # Every built-in rule is registered, so guidance and a docs pointer resolve.
        assert finding.remediation and finding.remediation.strip()
        assert finding.docs_url and "#" in finding.docs_url


async def test_ranking_is_stable_across_runs():
    first = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    clear_preflight_cache()
    second = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert first.lint is not None and second.lint is not None
    assert [(f.rank, f.rule, f.path) for f in first.lint.findings] == [
        (f.rank, f.rule, f.path) for f in second.lint.findings
    ]


# ---------------------------------------------------------------------------
# Failure taxonomy
# ---------------------------------------------------------------------------


async def test_malformed_document_reports_a_taxonomy_code():
    report = await run_import_preflight(
        _request(document_base64=_b64(BROKEN_GRAPHQL_DOC)),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.ok is False
    assert report.error is not None
    assert report.error.code == "INPUT_MALFORMED"
    assert report.error.category == "input"
    assert report.error.remediation.strip()
    assert report.lint is None


async def test_failure_messages_are_scrubbed_of_credentials():
    """A parse error quotes the offending line, so a secret on it must not come back."""
    secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0" + "K1l2M3n4O5p6Q7r8S9"
    report = await run_import_preflight(
        _request(document_base64=_b64(f'type Query {{ token: "{secret}" ')),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.ok is False
    assert report.error is not None
    assert secret not in report.error.message


def test_malformed_document_is_a_200_not_a_5xx():
    response = client.post(
        f"/v1/tenants/{TENANT_SLUG}/import/preflight",
        json={"document_base64": _b64(BROKEN_GRAPHQL_DOC), "source_kind": "graphql"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INPUT_MALFORMED"


async def test_empty_document_reports_input_empty():
    report = await run_import_preflight(
        _request(document_base64=_b64("   "), source_kind="graphql"),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.ok is False
    assert report.error is not None and report.error.code == "INPUT_EMPTY"


async def test_invalid_base64_reports_encoding_code():
    report = await run_import_preflight(
        ImportPreflightRequest(document_base64="not base64 !!"),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.ok is False
    assert report.error is not None and report.error.code == "INPUT_ENCODING_INVALID"
    assert report.cache.hit is False


async def test_unrecognized_document_reports_format_unrecognized():
    report = await run_import_preflight(
        ImportPreflightRequest(
            document_base64=_b64("just some prose that is no API description at all"),
            filename="notes.txt",
        ),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.ok is False
    assert report.error is not None and report.error.code == "FORMAT_UNRECOGNIZED"
    assert report.detection.matched is False
    assert report.detection.adapter_key is None


async def test_unknown_source_kind_reports_format_unrecognized():
    report = await run_import_preflight(
        _request(source_kind="no-such-format"),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.ok is False
    assert report.error is not None and report.error.code == "FORMAT_UNRECOGNIZED"


async def test_unavailable_adapter_reports_capability_code(monkeypatch):
    """A format whose toolchain is missing is a capability failure, not a bad document."""
    monkeypatch.setattr("app.toolchain_runner.is_tool_available", lambda _tool: False)
    report = await run_import_preflight(
        _request(source_kind="grpc"),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.ok is False
    assert report.error is not None and report.error.code == "ADAPTER_UNAVAILABLE"
    assert report.error.category == "capability"


async def test_adapter_crash_is_reported_not_raised(monkeypatch):
    """An adapter that raises something the pipeline does not model still yields a report."""

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("adapter exploded")

    monkeypatch.setattr(import_preflight, "run_adapter_import_job", _boom)
    report = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert report.ok is False
    assert report.error is not None and report.error.code == "INTERNAL_ADAPTER_FAULT"
    assert report.error.retriable is True


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


async def test_explicit_source_kind_overrides_detection():
    """A caller-named format runs even when detection disagrees; the report says so."""
    report = await run_import_preflight(
        _request(source_kind="json-schema", filename="schema.graphql"),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.detection.requested_adapter_key == "json-schema"
    assert report.detection.adapter_key == "json-schema"
    assert report.detection.detected_adapter_key == "graphql"
    assert report.detection.agrees_with_request is False


async def test_source_kind_aliases_resolve():
    report = await run_import_preflight(
        _request(source_kind="PROTOBUF"),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.detection.requested_adapter_key == "grpc"


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _StubGuide:
    """Minimal stand-in for a compiled style guide's cache-relevant identity."""

    fingerprint: str
    guide_id: Optional[str] = None
    name: str = "Stub"
    source: str = "custom"


async def test_identical_bytes_are_served_from_cache():
    first = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    second = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert first.cache.hit is False
    assert second.cache.hit is True
    assert second.cache.key == first.cache.key
    assert second.lint is not None and first.lint is not None
    assert second.lint.report_fingerprint == first.lint.report_fingerprint
    assert preflight_cache_size() == 1


async def test_cache_is_tenant_scoped():
    await run_import_preflight(_request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG)
    other = await run_import_preflight(
        _request(), tenant_id="770e8400-e29b-41d4-a716-446655440002", tenant_slug="other"
    )
    assert other.cache.hit is False
    assert preflight_cache_size() == 2


async def test_cache_key_separates_requested_adapters_and_targets():
    await run_import_preflight(_request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG)
    explicit = await run_import_preflight(
        _request(source_kind="graphql"), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    targeted = await run_import_preflight(
        _request(source_kind="graphql", import_target="types"),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert explicit.cache.hit is False
    assert targeted.cache.hit is False
    assert preflight_cache_size() == 3


async def test_cache_entry_is_dropped_when_the_style_guide_changes(monkeypatch):
    await run_import_preflight(_request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG)
    monkeypatch.setattr(
        import_preflight, "resolve_style_guide", lambda *_a, **_k: _StubGuide("changed")
    )
    again = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert again.cache.hit is False, "an edited style guide must not serve a stale grade"


async def test_failed_reports_are_cached_without_a_guide_dependency(monkeypatch):
    first = await run_import_preflight(
        _request(document_base64=_b64(BROKEN_GRAPHQL_DOC)),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    monkeypatch.setattr(
        import_preflight,
        "resolve_style_guide",
        lambda *_a, **_k: pytest.fail("a failed report must not depend on the style guide"),
    )
    second = await run_import_preflight(
        _request(document_base64=_b64(BROKEN_GRAPHQL_DOC)),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert first.cache.hit is False
    assert second.cache.hit is True
    assert second.error is not None and second.error.code == "INPUT_MALFORMED"


async def test_cache_is_bounded_and_evicts_least_recently_used():
    for index in range(PREFLIGHT_CACHE_MAX_ENTRIES + 5):
        await run_import_preflight(
            _request(document_base64=_b64(f"{GRAPHQL_DOC}\n# variant {index}")),
            tenant_id=TENANT_ID,
            tenant_slug=TENANT_SLUG,
        )
    assert preflight_cache_size() == PREFLIGHT_CACHE_MAX_ENTRIES


# ---------------------------------------------------------------------------
# Tenant quality policy (IXH-2.3, #5098)
# ---------------------------------------------------------------------------


def _policy_row(**overrides: Any) -> Dict[str, Any]:
    """A stored quality-policy row that blocks anything below grade A by default."""
    row: Dict[str, Any] = {
        "id": "11111111-1111-1111-1111-111111111111",
        "tenant_id": TENANT_ID,
        "version_number": 1,
        "content_fingerprint": "fp-policy",
        "import_min_grade": "A",
        "import_min_score": None,
        "import_block_on_severity": None,
        "import_enforcement": "block",
        "export_min_grade": None,
        "export_min_score": None,
        "export_block_on_severity": None,
        "export_enforcement": "advisory",
        "format_overrides": {},
        "allow_override": True,
        "override_roles": ["owner"],
        "waiver_ttl_hours": 24,
        "actor_user_id": None,
        "actor_label": "admin@example.com",
        "created_at": "2026-07-25T00:00:00+00:00",
    }
    row.update(overrides)
    return row


@pytest.fixture
def _blocking_policy(monkeypatch):
    """Point the policy engine at a blocking tenant policy with no waivers."""
    monkeypatch.setattr(
        quality_policy.db,
        "get_latest_import_export_quality_policy",
        lambda _tenant_id: _policy_row(),
    )
    monkeypatch.setattr(
        quality_policy.db, "list_active_import_export_quality_waivers", lambda *_a, **_k: []
    )


async def test_preflight_reports_a_blocking_tenant_policy(_blocking_policy):
    report = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert report.ok is True, "the candidate is importable; only policy objects"
    assert report.policy.verdict == "block"
    assert report.policy.blocking is True
    assert report.policy.source == "tenant"
    assert report.policy.min_grade == "A"
    assert report.policy.format_key == "graphql"
    assert report.policy.override_roles == ["owner"]
    assert [f.kind for f in report.policy.failures] == ["grade"]
    assert report.policy.policy_version_id == "11111111-1111-1111-1111-111111111111"


async def test_preflight_honours_an_active_waiver(monkeypatch):
    monkeypatch.setattr(
        quality_policy.db,
        "get_latest_import_export_quality_policy",
        lambda _tenant_id: _policy_row(),
    )
    monkeypatch.setattr(
        quality_policy.db,
        "list_active_import_export_quality_waivers",
        lambda *_a, **_k: [
            {
                "id": "33333333-3333-3333-3333-333333333333",
                "format_key": "graphql",
                "expires_at": "2026-08-01T00:00:00+00:00",
                "actor_label": "lead@example.com",
            }
        ],
    )
    report = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert report.policy.verdict == "warn"
    assert report.policy.blocking is False
    assert report.policy.waiver_id == "33333333-3333-3333-3333-333333333333"


async def test_a_format_override_can_gate_one_format_only(monkeypatch):
    monkeypatch.setattr(
        quality_policy.db,
        "get_latest_import_export_quality_policy",
        lambda _tenant_id: _policy_row(
            import_min_grade=None,
            import_enforcement="advisory",
            format_overrides={
                "graphql": {"import": {"minScore": 100, "enforcement": "block"}}
            },
        ),
    )
    monkeypatch.setattr(
        quality_policy.db, "list_active_import_export_quality_waivers", lambda *_a, **_k: []
    )
    report = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert report.policy.source == "format_override"
    assert report.policy.threshold_score == 100
    assert report.policy.blocking is True


async def test_a_cached_report_re_evaluates_policy(monkeypatch):
    """A waiver recorded between two pre-flights of the same bytes must take effect."""
    monkeypatch.setattr(
        quality_policy.db,
        "get_latest_import_export_quality_policy",
        lambda _tenant_id: _policy_row(),
    )
    waivers: list = []
    monkeypatch.setattr(
        quality_policy.db,
        "list_active_import_export_quality_waivers",
        lambda *_a, **_k: list(waivers),
    )

    first = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert first.cache.hit is False and first.policy.blocking is True

    waivers.append(
        {
            "id": "44444444-4444-4444-4444-444444444444",
            "format_key": "graphql",
            "expires_at": "2026-08-01T00:00:00+00:00",
            "actor_label": "lead@example.com",
        }
    )
    second = await run_import_preflight(
        _request(), tenant_id=TENANT_ID, tenant_slug=TENANT_SLUG
    )
    assert second.cache.hit is True, "the lint verdict is still reusable"
    assert second.policy.blocking is False
    assert second.policy.waiver_id == "44444444-4444-4444-4444-444444444444"
    assert second.lint is not None and second.lint.score == first.lint.score


async def test_policy_never_blocks_an_unimportable_candidate(_blocking_policy):
    """The taxonomy error is the answer for a broken document, not "quality policy"."""
    report = await run_import_preflight(
        _request(document_base64=_b64(BROKEN_GRAPHQL_DOC)),
        tenant_id=TENANT_ID,
        tenant_slug=TENANT_SLUG,
    )
    assert report.ok is False
    assert report.error is not None and report.error.code == "INPUT_MALFORMED"
    assert report.policy.blocking is False
