"""Tests for the convert-to-project/version job + provenance — MFI-22.5 (#4006).

Covers the acceptance criteria with fakes (no DB / no import worker):

* a **first** conversion mints a new Project + ``v1`` with valid OAS, an attached fidelity report,
  and a provenance row linking back to the source revision;
* a **re-convert** of the same source appends a *new version* to the previously-converted Project
  (via ``target_project_id``) instead of duplicating the Project, and bumps the version label;
* the OpenAPI lint/score is captured onto the result and into the provenance row;

plus the units the orchestration leans on: default gap-filling (title/version/servers applied only
where the source is empty), version-label bumping, converter tool-version stamping, and the two
production adapters (:class:`SpecImportCommitter` metadata/polling, :class:`DbConversionProvenanceStore`
field mapping, :class:`DbLintScorer` best-effort capture).
"""

from __future__ import annotations

import types
from typing import Any, Dict, List, Optional

import pytest

import app.database as database
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Server,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.conversion_job import (
    CONVERT_IMPORT_SOURCE_KIND,
    ConversionCommit,
    ConversionDefaults,
    ConversionError,
    ConversionPreview,
    ConversionResult,
    ConversionSource,
    DbConversionProvenanceStore,
    DbLintScorer,
    LintScore,
    SpecImportCommitter,
    _apply_defaults,
    _converted_project_identity,
    _next_version_label,
    _slugify,
    converter_tool_versions,
    preview_conversion,
    run_conversion,
)
from app.conversion_projection import (
    ConversionAnalysisRef,
    ConversionManifest,
    ConversionManifestSource,
    ConversionManifestSummary,
)
from app.fidelity import FidelityReport, FidelityTier
from app.payload_analysis import source_digest

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _projection_summary() -> ConversionManifestSummary:
    """A minimal CPDO-1.3 manifest summary for adapter-level tests."""
    return ConversionManifestSummary(
        schema_version="1.0.0",
        manifest_hash="cafe1234",
        source=ConversionManifestSource(
            source_format="rest",
            analysis=ConversionAnalysisRef(available=False, status="unavailable"),
        ),
        target_format="openapi-3.1",
        conversion_mode="lossy",
        tool_versions={"apiome-rest": "9.9.9"},
        defaults={},
        status_counts={},
        reason_counts={},
        scope_counts={},
        node_count=0,
        edge_count=0,
        total_constructs=0,
        is_lossless=True,
    )


def _manifest() -> ConversionManifest:
    """A minimal full manifest naming the same snapshot as :func:`_projection_summary`."""
    return ConversionManifest(
        schema_version="1.0.0",
        manifest_hash="cafe1234",
        source=ConversionManifestSource(
            project_id="cat-1",
            version_record_id="srcver-1",
            source_format="rest",
            analysis=ConversionAnalysisRef(available=False, status="unavailable"),
        ),
        target_format="openapi-3.1",
        conversion_mode="lossy",
        tool_versions={"apiome-rest": "9.9.9"},
        defaults={},
    )


@pytest.fixture(autouse=True)
def _stub_identity_auto_link(monkeypatch: pytest.MonkeyPatch) -> None:
    """Conversion auto-link (MFI-6.4) is DB-backed; stub it so orchestrator tests stay port-only."""
    monkeypatch.setattr(
        database.db,
        "link_identity_projects",
        lambda **kwargs: "identity-group-stub",
    )


def _record(key: str, name: str) -> Type:
    """A one-field RECORD type usable as a message payload."""
    return Type(
        key=key,
        name=name,
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key=f"{key}.id", name="id", type=TypeRef(name="integer", nullable=False))
        ],
    )


def _rest_api(*, title: Optional[str] = "Widgets", version: Optional[str] = "1.4.0",
              servers: bool = True) -> CanonicalApi:
    """A small, well-formed REST model. Args let a test remove the info gaps defaults fill."""
    widget = _record("Widget", "Widget")
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="odata",
        protocol="http",
        identity=ApiIdentity(name="acme.Widgets"),
        title=title,
        version=version,
        servers=[Server(url="https://svc.example.com")] if servers else [],
        types=[widget],
        services=[
            Service(
                key="WidgetsSvc",
                name="WidgetsSvc",
                operations=[
                    Operation(
                        key="GET /widgets",
                        name="listWidgets",
                        kind=OperationKind.REQUEST_RESPONSE,
                        http_method="GET",
                        http_path="/widgets",
                        extras={"operationId": "listWidgets"},
                        messages=[
                            Message(
                                key="GET /widgets#resp",
                                role=MessageRole.RESPONSE,
                                status_code="200",
                                content_types=["application/json"],
                                payload=TypeRef(name="Widget"),
                            )
                        ],
                    )
                ],
            )
        ],
    )


def _source(api: Optional[CanonicalApi] = None, **overrides: Any) -> ConversionSource:
    base: Dict[str, Any] = dict(
        api=api if api is not None else _rest_api(),
        source_project_id="cat-1",
        source_version_id="srcver-1",
        source_format="odata",
        source_protocol="http",
        source_version_label="1.4.0",
        source_tool_versions={"odata-lib": "9.9"},
    )
    base.update(overrides)
    return ConversionSource(**base)


# ---------------------------------------------------------------------------
# Fakes for the ports
# ---------------------------------------------------------------------------


class _FakeCommitter:
    """Records the commit call and returns a deterministic outcome."""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    async def commit(self, **kwargs: Any) -> ConversionCommit:
        self.calls.append(kwargs)
        target = kwargs["target_project_id"]
        label = kwargs["version_label"]
        return ConversionCommit(
            project_id=target or "proj-new",
            project_slug="widgets-openapi",
            version_id=label,
            version_record_id=f"ver-{label}",
            created_project=target is None,
        )


class _FakeScorer:
    def __init__(self, lint: Optional[LintScore] = LintScore(score=88, grade="B")) -> None:
        self.lint = lint
        self.calls: List[Dict[str, Any]] = []

    async def score(self, **kwargs: Any) -> Optional[LintScore]:
        self.calls.append(kwargs)
        return self.lint


class _FakeStore:
    def __init__(self, prior: Optional[Dict[str, Any]] = None) -> None:
        self.prior = prior
        self.recorded: List[Dict[str, Any]] = []
        self._n = 0

    def latest_for_source(self, tenant_id: str, source_project_id: str) -> Optional[Dict[str, Any]]:
        return self.prior

    def record(self, **kwargs: Any) -> Dict[str, Any]:
        self._n += 1
        self.recorded.append(kwargs)
        return {"id": f"prov-{self._n}", **kwargs}


async def _run(source: ConversionSource, *, committer: _FakeCommitter, scorer: _FakeScorer,
               store: _FakeStore, defaults: Optional[ConversionDefaults] = None) -> ConversionResult:
    return await run_conversion(
        tenant_slug="acme",
        tenant_id="tenant-1",
        user_id="user-1",
        source=source,
        committer=committer,
        scorer=scorer,
        store=store,
        defaults=defaults,
    )


# ---------------------------------------------------------------------------
# preview_conversion — the pure, side-effect-free dry-run
# ---------------------------------------------------------------------------


def test_preview_conversion_emits_document_and_report() -> None:
    """A preview emits the OAS document and analyzes fidelity without any ports (no side effects)."""
    preview = preview_conversion(_source())
    assert isinstance(preview, ConversionPreview)
    assert preview.document["openapi"].startswith("3.1")
    assert "/widgets" in preview.document["paths"]
    assert preview.fidelity.grade in {"A", "B", "C", "D", "F"}
    assert preview.target_format == "openapi-3.1"


def test_preview_conversion_applies_defaults_only_where_empty() -> None:
    """Defaults fill a missing title/version for the preview, mirroring what a commit would emit."""
    source = _source(api=_rest_api(title=None, version=None, servers=False))
    preview = preview_conversion(
        source, ConversionDefaults(title="Filled", version="9.9.9", servers=["https://d"])
    )
    assert preview.document["info"]["title"] == "Filled"
    assert preview.document["info"]["version"] == "9.9.9"


def test_preview_conversion_rejects_unsupported_target() -> None:
    """Targets without a registered emitter are a 400 ConversionError."""
    with pytest.raises(ConversionError) as exc:
        preview_conversion(_source(), target_format="no-such-format")
    assert exc.value.status_code == 400


async def test_preview_matches_commit_document() -> None:
    """The dry-run document equals what the commit path emits (they share preview_conversion)."""
    source = _source()
    preview = preview_conversion(source)
    committer, scorer, store = _FakeCommitter(), _FakeScorer(), _FakeStore(prior=None)
    committed = await _run(source, committer=committer, scorer=scorer, store=store)
    assert committed.document == preview.document
    assert committed.fidelity == preview.fidelity


# ---------------------------------------------------------------------------
# Orchestrator — acceptance criteria
# ---------------------------------------------------------------------------


async def test_first_convert_mints_project_v1_with_report_and_provenance() -> None:
    committer, scorer, store = _FakeCommitter(), _FakeScorer(), _FakeStore(prior=None)

    result = await _run(_source(), committer=committer, scorer=scorer, store=store)

    # A new Project + v1 with a valid-looking OAS document.
    assert result.created_project is True
    assert result.reconverted is False
    assert result.version_id == "1.0.0"
    assert result.document["openapi"].startswith("3.1")
    assert "/widgets" in result.document["paths"]

    # Committer was asked to mint (no existing project) with the v1 label.
    assert committer.calls[0]["target_project_id"] is None
    assert committer.calls[0]["version_label"] == "1.0.0"

    # Fidelity report attached; lint captured on the created revision.
    assert isinstance(result.fidelity, FidelityReport)
    assert result.lint == LintScore(score=88, grade="B")
    assert scorer.calls[0]["version_record_id"] == "ver-1.0.0"

    # Provenance links back to the source revision + carries the report + tool versions.
    assert result.provenance_id == "prov-1"
    rec = store.recorded[0]
    assert rec["source"].source_version_id == "srcver-1"
    assert rec["commit"].project_id == "proj-new"
    assert rec["reconverted"] is False
    assert rec["fidelity"] is result.fidelity
    assert rec["lint"] == LintScore(score=88, grade="B")
    assert rec["converter_tool_versions"]["emitter"] == "openapi-3.1"


async def test_reconvert_appends_version_to_existing_project() -> None:
    prior = {"target_project_id": "proj-existing", "target_version_label": "1.0.0"}
    committer, scorer, store = _FakeCommitter(), _FakeScorer(), _FakeStore(prior=prior)

    result = await _run(_source(), committer=committer, scorer=scorer, store=store)

    # Re-convert: no new project, a bumped version on the existing one.
    assert result.created_project is False
    assert result.reconverted is True
    assert result.project_id == "proj-existing"
    assert result.version_id == "1.0.1"
    assert committer.calls[0]["target_project_id"] == "proj-existing"
    assert store.recorded[0]["reconverted"] is True


async def test_lint_capture_failure_leaves_result_but_still_records() -> None:
    committer, scorer, store = _FakeCommitter(), _FakeScorer(lint=None), _FakeStore()

    result = await _run(_source(), committer=committer, scorer=scorer, store=store)

    assert result.lint is None
    assert store.recorded[0]["lint"] is None  # provenance still written


async def test_record_receives_full_manifest_and_source_digest() -> None:
    """CPDO-3.3: the store gets the full approved manifest + the digest of the exact source text."""
    committer, scorer, store = _FakeCommitter(), _FakeScorer(), _FakeStore()
    source = _source(source_text='type Query { widgets: [String!]! }')

    await _run(source, committer=committer, scorer=scorer, store=store)

    rec = store.recorded[0]
    manifest = rec["manifest"]
    assert isinstance(manifest, ConversionManifest)
    # The persisted graph is the one the summary names — same content address.
    assert manifest.manifest_hash == rec["projection"].manifest_hash
    assert rec["source_hash"] == source_digest(source.source_text)
    assert rec["source_hash"].startswith("sha256:")


async def test_record_source_hash_is_none_without_captured_source_text() -> None:
    """No captured source text → no digest; the store records the truthful absence."""
    committer, scorer, store = _FakeCommitter(), _FakeScorer(), _FakeStore()

    await _run(_source(), committer=committer, scorer=scorer, store=store)

    assert store.recorded[0]["source_hash"] is None


async def test_unsupported_target_format_raises() -> None:
    with pytest.raises(ConversionError) as exc:
        await run_conversion(
            tenant_slug="acme", tenant_id="t", user_id="u", source=_source(),
            committer=_FakeCommitter(), scorer=_FakeScorer(), store=_FakeStore(),
            target_format="no-such-format",
        )
    assert exc.value.status_code == 400


async def test_commit_without_project_raises() -> None:
    class _EmptyCommitter:
        async def commit(self, **kwargs: Any) -> ConversionCommit:
            return ConversionCommit(
                project_id="", project_slug="", version_id="1.0.0",
                version_record_id="", created_project=True,
            )

    with pytest.raises(ConversionError) as exc:
        await run_conversion(
            tenant_slug="acme", tenant_id="t", user_id="u", source=_source(),
            committer=_EmptyCommitter(), scorer=_FakeScorer(), store=_FakeStore(),
        )
    assert exc.value.status_code == 502


async def test_defaults_fill_gaps_and_reflect_in_fidelity() -> None:
    """A gappy source (no title/version/servers) + defaults → the emitted doc carries them."""
    gappy = _rest_api(title=None, version=None, servers=False)
    committer, scorer, store = _FakeCommitter(), _FakeScorer(), _FakeStore()
    defaults = ConversionDefaults(title="Given", version="2.0.0", servers=["https://given.example"])

    result = await _run(_source(gappy), committer=committer, scorer=scorer, store=store, defaults=defaults)

    assert result.document["info"]["title"] == "Given"
    assert result.document["info"]["version"] == "2.0.0"
    assert result.document["servers"][0]["url"] == "https://given.example"


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_apply_defaults_never_overwrites_source_values() -> None:
    api = _rest_api(title="Real", version="9.9", servers=True)
    out = _apply_defaults(api, ConversionDefaults(title="X", version="Y", servers=["https://z"]))
    assert out.title == "Real"
    assert out.version == "9.9"
    assert out.servers[0].url == "https://svc.example.com"


def test_apply_defaults_none_returns_same_object() -> None:
    api = _rest_api()
    assert _apply_defaults(api, None) is api


def test_apply_defaults_fills_only_missing() -> None:
    api = _rest_api(title="Real", version=None, servers=False)
    out = _apply_defaults(api, ConversionDefaults(title="X", version="2.0", servers=["https://z"]))
    assert out.title == "Real"  # kept
    assert out.version == "2.0"  # filled
    assert out.servers[0].url == "https://z"  # filled


@pytest.mark.parametrize(
    "prior,expected",
    [
        (None, "1.0.0"),
        ({}, "1.0.0"),
        ({"target_version_label": "1.0.0"}, "1.0.1"),
        ({"target_version_label": "2.5.9"}, "2.5.10"),
        ({"target_version_label": ""}, "1.0.0"),
        ({"target_version_label": "v3"}, "v3.1"),
    ],
)
def test_next_version_label(prior: Optional[Dict[str, Any]], expected: str) -> None:
    assert _next_version_label(prior) == expected


def test_converter_tool_versions_keys() -> None:
    tv = converter_tool_versions()
    assert set(tv) >= {"apiome-rest", "emitter", "fidelity-analyzer", "conversion-mode"}
    assert tv["emitter"] == "openapi-3.1"
    assert tv["conversion-mode"] == "lossy"
    assert converter_tool_versions(conversion_mode="passthrough")["emitter"] == "passthrough"
    assert converter_tool_versions(conversion_mode="typespec_native")["emitter"] == "typespec-native"


def test_slugify_and_identity_are_deterministic() -> None:
    src = _source()
    name1, slug1 = _converted_project_identity(src)
    name2, slug2 = _converted_project_identity(src)
    assert (name1, slug1) == (name2, slug2)
    assert name1 == "Widgets (OpenAPI)"
    assert slug1 == "widgets-openapi-cat-1"
    assert _slugify("  Foo/Bar  !!") == "foo-bar"
    assert _slugify("///") == "converted-api"


# ---------------------------------------------------------------------------
# SpecImportCommitter (production adapter) — reuses the spec-import engine
# ---------------------------------------------------------------------------


def _install_fake_import_engine(monkeypatch: pytest.MonkeyPatch, *, states: List[str],
                                result: Optional[types.SimpleNamespace],
                                error_msg: Optional[str] = None) -> Dict[str, Any]:
    """Patch schedule_spec_import + get_spec_import_status to walk ``states`` then hold the last."""
    import app.spec_import_engine as engine

    captured: Dict[str, Any] = {}

    async def _schedule(tenant_slug, tenant_id, user_id, body):  # noqa: ANN001
        captured["schedule"] = (tenant_slug, tenant_id, user_id, body)
        return types.SimpleNamespace(job_id="job-1")

    seq = list(states)

    async def _status(tenant_slug, job_id):  # noqa: ANN001
        state = seq.pop(0) if len(seq) > 1 else seq[0]
        events = [types.SimpleNamespace(level="error", message=error_msg)] if error_msg else []
        return types.SimpleNamespace(state=state, result=result, events=events)

    monkeypatch.setattr(engine, "schedule_spec_import", _schedule)
    monkeypatch.setattr(engine, "get_spec_import_status", _status)
    return captured


async def test_spec_import_committer_completes_and_maps_result(monkeypatch: pytest.MonkeyPatch) -> None:
    result = types.SimpleNamespace(
        project_id="p-9", project_slug="widgets-openapi", version_id="1.0.0", version_record_id="v-9"
    )
    captured = _install_fake_import_engine(monkeypatch, states=["running", "completed"], result=result)

    committer = SpecImportCommitter(poll_interval=0.001, timeout=5.0)
    out = await committer.commit(
        tenant_slug="acme", tenant_id="t", user_id="u",
        document={"openapi": "3.1.0", "info": {"title": "W", "version": "1"}},
        source=_source(), target_project_id=None, version_label="1.0.0",
    )

    assert out.project_id == "p-9"
    assert out.version_record_id == "v-9"
    assert out.created_project is True
    # The emitted doc was submitted as an OpenAPI import.
    _, _, _, body = captured["schedule"]
    assert body.metadata.source_kind == CONVERT_IMPORT_SOURCE_KIND
    assert body.metadata.existing_project_id is None


async def test_spec_import_committer_passes_existing_project_on_reconvert(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = types.SimpleNamespace(
        project_id="p-1", project_slug="s", version_id="1.0.1", version_record_id="v-2"
    )
    captured = _install_fake_import_engine(monkeypatch, states=["completed"], result=result)

    committer = SpecImportCommitter(poll_interval=0.001, timeout=5.0)
    out = await committer.commit(
        tenant_slug="acme", tenant_id="t", user_id="u", document={"openapi": "3.1.0"},
        source=_source(), target_project_id="p-1", version_label="1.0.1",
    )

    assert out.created_project is False
    _, _, _, body = captured["schedule"]
    assert body.metadata.existing_project_id == "p-1"


async def test_spec_import_committer_raises_on_failed_job(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_import_engine(monkeypatch, states=["failed"], result=None, error_msg="boom")
    committer = SpecImportCommitter(poll_interval=0.001, timeout=5.0)
    with pytest.raises(ConversionError) as exc:
        await committer.commit(
            tenant_slug="acme", tenant_id="t", user_id="u", document={"openapi": "3.1.0"},
            source=_source(), target_project_id=None, version_label="1.0.0",
        )
    assert exc.value.status_code == 502
    assert "boom" in str(exc.value)


async def test_spec_import_committer_times_out(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_import_engine(monkeypatch, states=["running"], result=None)
    committer = SpecImportCommitter(poll_interval=0.001, timeout=0.0)
    with pytest.raises(ConversionError) as exc:
        await committer.commit(
            tenant_slug="acme", tenant_id="t", user_id="u", document={"openapi": "3.1.0"},
            source=_source(), target_project_id=None, version_label="1.0.0",
        )
    assert exc.value.status_code == 504


# ---------------------------------------------------------------------------
# DbConversionProvenanceStore + DbLintScorer (production adapters)
# ---------------------------------------------------------------------------


def test_db_provenance_store_maps_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.database as database

    captured: Dict[str, Any] = {}

    calls: List[str] = []

    def _create(**kwargs: Any) -> Dict[str, Any]:
        calls.append("provenance")
        captured.update(kwargs)
        return {"id": "prov-x"}

    def _latest(tenant_id: str, source_project_id: str) -> Optional[Dict[str, Any]]:
        captured["latest"] = (tenant_id, source_project_id)
        return {"target_project_id": "p-prior"}

    def _upsert(**kwargs: Any) -> Dict[str, Any]:
        calls.append("snapshot")
        captured["snapshot"] = kwargs
        return kwargs

    monkeypatch.setattr(database.db, "create_conversion_provenance", _create)
    monkeypatch.setattr(database.db, "get_latest_conversion_for_source", _latest)
    monkeypatch.setattr(database.db, "upsert_conversion_evidence_snapshot", _upsert)

    store = DbConversionProvenanceStore()
    assert store.latest_for_source("t", "cat-1") == {"target_project_id": "p-prior"}

    api = _rest_api()
    fidelity = FidelityReport(
        score=77, grade="C", tier=FidelityTier.MEDIUM, items=[], losses=[],
        coverage_counts={}, penalty=23,
    )
    row = store.record(
        tenant_id="t", created_by="u", source=_source(api),
        commit=ConversionCommit(
            project_id="p-new", project_slug="s", version_id="1.0.0",
            version_record_id="v-1", created_project=True,
        ),
        fidelity=fidelity, lint=LintScore(score=90, grade="A"),
        converter_tool_versions={"apiome-rest": "9.9.9"}, reconverted=False,
        projection=_projection_summary(),
        manifest=_manifest(),
        source_hash="sha256:" + "ab" * 32,
    )
    assert row == {"id": "prov-x"}
    # CPDO-3.3: snapshot first, ledger second — a row never names a hash never even attempted.
    assert calls == ["snapshot", "provenance"]
    # CPDO-1.3: the manifest snapshot is persisted alongside the fidelity report.
    assert captured["projection_manifest_hash"] == "cafe1234"
    assert captured["projection_manifest"]["manifest_hash"] == "cafe1234"
    assert captured["source_project_id"] == "cat-1"
    assert captured["target_version_id"] == "v-1"
    assert captured["fidelity_score"] == 77
    assert captured["fidelity_tier"] == "medium"
    assert captured["lint_score"] == 90
    assert captured["source_tool_versions"] == {"odata-lib": "9.9"}
    # The fidelity report is serialized to JSON-safe primitives for the JSONB column.
    assert captured["fidelity_report"]["tier"] == "medium"
    # CPDO-3.3: the per-conversion source digest rides on the ledger row.
    assert captured["source_hash"] == "sha256:" + "ab" * 32
    # The stored snapshot is keyed by the content address and sized without loading the graph.
    snap = captured["snapshot"]
    assert snap["tenant_id"] == "t"
    assert snap["manifest_hash"] == "cafe1234"
    assert snap["schema_version"] == "1.0.0"
    assert snap["conversion_mode"] == "lossy"
    assert snap["target_format"] == "openapi-3.1"
    assert snap["node_count"] == 0 and snap["edge_count"] == 0
    # Hash-excluded source ids are nulled so a deduped snapshot never leaks the first
    # writer's coordinates; readers take coordinates from the provenance row.
    assert snap["manifest"]["source"]["project_id"] is None
    assert snap["manifest"]["source"]["version_record_id"] is None
    assert snap["manifest"]["source"]["source_format"] == "rest"


def test_db_provenance_store_survives_snapshot_write_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The snapshot write is best-effort: a failing upsert must not lose the provenance row."""
    captured: Dict[str, Any] = {}

    def _create(**kwargs: Any) -> Dict[str, Any]:
        captured.update(kwargs)
        return {"id": "prov-y"}

    def _boom(**kwargs: Any) -> Dict[str, Any]:
        raise RuntimeError("snapshot store down")

    monkeypatch.setattr(database.db, "create_conversion_provenance", _create)
    monkeypatch.setattr(database.db, "upsert_conversion_evidence_snapshot", _boom)

    fidelity = FidelityReport(
        score=77, grade="C", tier=FidelityTier.MEDIUM, items=[], losses=[],
        coverage_counts={}, penalty=23,
    )
    row = DbConversionProvenanceStore().record(
        tenant_id="t", created_by="u", source=_source(),
        commit=ConversionCommit(
            project_id="p-new", project_slug="s", version_id="1.0.0",
            version_record_id="v-1", created_project=True,
        ),
        fidelity=fidelity, lint=None,
        converter_tool_versions={"apiome-rest": "9.9.9"}, reconverted=False,
        projection=_projection_summary(),
        manifest=_manifest(),
        source_hash=None,
    )
    assert row == {"id": "prov-y"}
    assert captured["projection_manifest_hash"] == "cafe1234"
    assert captured["source_hash"] is None


def test_snapshot_upsert_dedupes_in_sql_and_reads_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """The dedupe guarantee lives in SQL: ON CONFLICT DO NOTHING + read-back of the existing row."""
    executed: Dict[str, Any] = {}

    class _Cursor:
        def __enter__(self) -> "_Cursor":
            return self

        def __exit__(self, *exc: Any) -> None:
            return None

        def execute(self, query: str, params: Any) -> None:
            executed["query"] = query
            executed["params"] = params

        def fetchone(self) -> None:
            return None  # the conflict path: the row already existed, nothing returned

    class _Conn:
        def cursor(self) -> _Cursor:
            return _Cursor()

        def commit(self) -> None:
            executed["committed"] = True

        def rollback(self) -> None:  # pragma: no cover - not hit in this test
            executed["rolled_back"] = True

    monkeypatch.setattr(database.db, "connect", lambda: _Conn())
    monkeypatch.setattr(
        database.db,
        "get_conversion_evidence_snapshot",
        lambda tenant_id, manifest_hash: {"tenant_id": tenant_id, "manifest_hash": manifest_hash},
    )

    row = database.db.upsert_conversion_evidence_snapshot(
        tenant_id="t", manifest_hash="cafe1234", schema_version="1.0.0",
        conversion_mode="lossy", source_format="rest", target_format="openapi-3.1",
        tool_versions={}, defaults={}, manifest={"schema_version": "1.0.0"},
        node_count=0, edge_count=0, truncated=False, created_by=None,
    )

    assert "ON CONFLICT (tenant_id, manifest_hash) DO NOTHING" in executed["query"]
    assert executed["committed"] is True
    # Deduped insert returns the pre-existing stored row, so callers always get the stored truth.
    assert row == {"tenant_id": "t", "manifest_hash": "cafe1234"}


async def test_db_lint_scorer_success(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.compatibility_engine as compat
    import app.database as database
    import app.style_guide_engine as style_guide_engine

    monkeypatch.setattr(database.db, "get_version_by_id", lambda vid, tid: {"id": vid})
    monkeypatch.setattr(compat, "openapi_for_revision", lambda v, s, t: {"openapi": "3.1.0"})
    # GOV-1.4: the scorer lints through the style-guide-aware entry point.
    saved: Dict[str, Any] = {}
    monkeypatch.setattr(
        style_guide_engine, "guided_lint_openapi_spec",
        lambda spec, tenant_id, project_id=None: (
            types.SimpleNamespace(
                score=82,
                grade="B",
                report_fingerprint="fp",
                report_dict=lambda: {
                    "score": 82,
                    "grade": "B",
                    "report_fingerprint": "fp",
                    "findings": [],
                    "rule_hits": {},
                    "severity_counts": {},
                    "categories": [],
                },
            ),
            types.SimpleNamespace(guide_id=None, name="Apiome Recommended", source="fallback"),
        ),
    )
    monkeypatch.setattr(
        database.db, "set_version_quality_score",
        lambda vid, tid, score, grade, fp, quality_report=None: saved.update(
            score=score, grade=grade, fp=fp, quality_report=quality_report
        )
        or True,
    )

    lint = await DbLintScorer().score(tenant_slug="acme", tenant_id="t", version_record_id="v-1")
    assert lint == LintScore(score=82, grade="B", report_fingerprint="fp")
    assert saved["score"] == 82
    assert saved["quality_report"]["score"] == 82


async def test_db_lint_scorer_missing_version_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.database as database

    monkeypatch.setattr(database.db, "get_version_by_id", lambda vid, tid: None)
    lint = await DbLintScorer().score(tenant_slug="acme", tenant_id="t", version_record_id="v-1")
    assert lint is None
