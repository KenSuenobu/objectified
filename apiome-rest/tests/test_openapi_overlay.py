"""OpenAPI Overlay 1.0 pre-processor tests — IXH-7.7 (#5132).

Covers the pure core (:mod:`app.openapi_overlay`), the adapter seams
(:class:`app.openapi_import_source.OpenApiImportSource` — detection, the bare-overlay
prompt, ``parse_fileset``, extras publication, lint merge), the preview coverage
ledger's provenance rows (:mod:`app.import_preview_manifest`), the in-process
pipeline end to end (archive intake → resolved import; bare overlay → the
``INPUT_OVERLAY_BASE_MISSING`` prompt), and the corpus ladder sets the manifest
declares for add/remove/update actions and the multi-overlay chain.
"""

from __future__ import annotations

import base64
from typing import Any, Dict, List, Tuple

import pytest
import yaml
from corpus_adapter_support import build_fileset, build_fileset_archive
from corpus_loader import load_corpus

from app.fileset import IntakeFileset
from app.import_preview_manifest import (
    PROVENANCE_EXTRA_KEYS,
    build_import_preview_manifest,
)
from app.import_source import DetectionInput, ImportSourceError, LintReport
from app.import_source_pipeline import run_adapter_import_job
from app.intake_error_taxonomy import INTAKE_ERROR_TAXONOMY
from app.intake_lint_rules import (
    RULE_OVERLAY_ACTION_INVALID,
    RULE_OVERLAY_UNMATCHED_TARGET,
)
from app.lint_rule_registry import builtin_rule_descriptors
from app.openapi_import_source import OpenApiImportSource
from app.openapi_overlay import (
    FINDING_ACTION_INVALID,
    FINDING_UNMATCHED_TARGET,
    MAX_PROVENANCE_RECORDS,
    OVERLAY_EXTRA_KEY,
    OverlayedOpenApiDocument,
    apply_overlays,
    is_overlay_document,
    overlay_lint_findings,
    overlay_version,
)

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


def _base_document() -> Dict[str, Any]:
    """A small OpenAPI 3.1 base the action tests modify."""
    return {
        "openapi": "3.1.0",
        "info": {"title": "Pets", "version": "1.0.0", "description": "base copy"},
        "servers": [{"url": "http://localhost"}],
        "tags": [{"name": "pets"}, {"name": "internal"}],
        "paths": {
            "/pets": {
                "get": {
                    "summary": "List pets",
                    "deprecated": False,
                    "responses": {"200": {"description": "ok"}},
                }
            },
            "/internal": {"get": {"responses": {"204": {"description": "ok"}}}},
        },
    }


def _overlay(actions: List[Dict[str, Any]], version: str = "1.0.0") -> Dict[str, Any]:
    return {
        "overlay": version,
        "info": {"title": "Test overlay", "version": "1.0.0"},
        "actions": actions,
    }


BASE_YAML = """
openapi: 3.1.0
info: {title: Pets, version: 1.0.0, description: base copy}
paths:
  /pets:
    get:
      summary: List pets
      responses:
        '200': {description: ok}
"""

OVERLAY_YAML = """
overlay: 1.0.0
info: {title: Overrides, version: '1.0.0'}
actions:
  - target: $.info
    update: {description: overlay copy}
  - target: $.paths['/missing']
    remove: true
"""


# ---------------------------------------------------------------------------
# Pure core: recognition
# ---------------------------------------------------------------------------


class TestOverlayRecognition:
    def test_overlay_marker_is_recognized(self) -> None:
        assert is_overlay_document({"overlay": "1.0.0", "actions": []})
        assert overlay_version({"overlay": "1.0.0"}) == "1.0.0"

    def test_truncated_overlay_is_still_recognized(self) -> None:
        # Marker present, actions cut off — recognition must not require actions,
        # or a truncated overlay would fall back to an obscure error.
        assert is_overlay_document({"overlay": "1.0.0", "info": {"title": "x"}})

    def test_non_overlay_shapes_are_not_recognized(self) -> None:
        assert not is_overlay_document({"openapi": "3.1.0"})
        assert not is_overlay_document({"overlay": {"nested": True}})
        assert not is_overlay_document({"overlay": "not-a-version"})
        assert not is_overlay_document(["overlay"])
        assert not is_overlay_document(None)


# ---------------------------------------------------------------------------
# Pure core: action semantics
# ---------------------------------------------------------------------------


class TestApplyOverlays:
    def test_object_update_deep_merges_and_records_leaf_provenance(self) -> None:
        base = _base_document()
        result = apply_overlays(
            base,
            [
                (
                    "o.yaml",
                    _overlay(
                        [
                            {
                                "target": "$.info",
                                "update": {"description": "new", "x-audience": "public"},
                            }
                        ]
                    ),
                )
            ],
        )
        assert result.document["info"]["description"] == "new"
        assert result.document["info"]["x-audience"] == "public"
        assert result.document["info"]["title"] == "Pets"  # untouched keys survive
        kinds = {r.pointer: r.kind for r in result.provenance}
        assert kinds == {
            "/info/description": "replaced",
            "/info/x-audience": "set",
        }
        assert base["info"]["description"] == "base copy"  # base never mutated

    def test_array_target_appends_the_update_value(self) -> None:
        result = apply_overlays(
            _base_document(),
            [
                (
                    "o.yaml",
                    _overlay(
                        [{"target": "$.servers", "update": {"url": "https://api"}}]
                    ),
                )
            ],
        )
        assert result.document["servers"][1] == {"url": "https://api"}
        [record] = result.provenance
        assert (record.pointer, record.kind) == ("/servers/1", "appended")

    def test_primitive_target_is_replaced_in_place(self) -> None:
        result = apply_overlays(
            _base_document(),
            [
                (
                    "o.yaml",
                    _overlay(
                        [{"target": "$.paths['/pets'].get.deprecated", "update": True}]
                    ),
                )
            ],
        )
        assert result.document["paths"]["/pets"]["get"]["deprecated"] is True
        [record] = result.provenance
        assert (record.pointer, record.kind) == (
            "/paths/~1pets/get/deprecated",
            "replaced",
        )

    def test_remove_deletes_dict_members_and_filtered_list_items(self) -> None:
        result = apply_overlays(
            _base_document(),
            [
                (
                    "o.yaml",
                    _overlay(
                        [
                            {"target": "$.paths['/internal']", "remove": True},
                            {
                                "target": "$.tags[?(@.name == 'internal')]",
                                "remove": True,
                            },
                        ]
                    ),
                )
            ],
        )
        assert "/internal" not in result.document["paths"]
        assert result.document["tags"] == [{"name": "pets"}]
        kinds = {r.pointer: r.kind for r in result.provenance}
        assert kinds == {"/paths/~1internal": "removed", "/tags/1": "removed"}

    def test_remove_true_ignores_update_per_spec(self) -> None:
        result = apply_overlays(
            _base_document(),
            [
                (
                    "o.yaml",
                    _overlay(
                        [
                            {
                                "target": "$.paths['/internal']",
                                "remove": True,
                                "update": {"description": "never applied"},
                            }
                        ]
                    ),
                )
            ],
        )
        assert "/internal" not in result.document["paths"]
        assert all(r.kind == "removed" for r in result.provenance)

    def test_wildcard_removal_deletes_list_items_in_one_pass(self) -> None:
        # Removing several indices of one list must delete from the highest index
        # down, or the survivors shift under the removals.
        base = {
            "openapi": "3.1.0",
            "info": {"title": "x", "version": "1"},
            "tags": [{"name": "a"}, {"name": "b"}, {"name": "c"}],
        }
        result = apply_overlays(
            base, [("o.yaml", _overlay([{"target": "$.tags[*]", "remove": True}]))]
        )
        assert result.document["tags"] == []
        assert [r.pointer for r in result.provenance] == ["/tags/2", "/tags/1", "/tags/0"]

    def test_later_overlay_wins_and_both_writes_are_recorded(self) -> None:
        result = apply_overlays(
            _base_document(),
            [
                (
                    "01.yaml",
                    _overlay([{"target": "$.info.description", "update": "first"}]),
                ),
                (
                    "02.yaml",
                    _overlay([{"target": "$.info.description", "update": "second"}]),
                ),
            ],
        )
        assert result.document["info"]["description"] == "second"
        writes = [
            (r.overlay, r.kind)
            for r in result.provenance
            if r.pointer == "/info/description"
        ]
        assert writes == [("01.yaml", "replaced"), ("02.yaml", "replaced")]
        assert result.applied == ["01.yaml", "02.yaml"]

    def test_unmatched_target_is_a_finding_not_silence(self) -> None:
        result = apply_overlays(
            _base_document(),
            [
                (
                    "o.yaml",
                    _overlay([{"target": "$.paths['/absent']", "update": {"x": 1}}]),
                )
            ],
        )
        [finding] = result.findings
        assert finding.code == FINDING_UNMATCHED_TARGET
        assert finding.target == "$.paths['/absent']"
        assert not result.provenance

    @pytest.mark.parametrize(
        "action",
        [
            "not-an-object",
            {"update": {"x": 1}},  # no target
            {"target": "   ", "update": {"x": 1}},  # blank target
            {"target": "$.info", "remove": "yes"},  # non-boolean remove
            {"target": "$.info"},  # neither update nor remove
            {"target": "$.[unparsable", "update": {}},  # invalid JSONPath
            {"target": "$.info", "update": "not-an-object"},  # object needs object
        ],
        ids=[
            "non-object-action",
            "missing-target",
            "blank-target",
            "non-boolean-remove",
            "no-update-no-remove",
            "invalid-jsonpath",
            "object-update-type-mismatch",
        ],
    )
    def test_structurally_unusable_actions_become_findings(self, action: Any) -> None:
        result = apply_overlays(_base_document(), [("o.yaml", _overlay([action]))])
        [finding] = result.findings
        assert finding.code == FINDING_ACTION_INVALID
        assert not result.provenance

    def test_removing_the_document_root_is_a_finding(self) -> None:
        result = apply_overlays(
            _base_document(), [("o.yaml", _overlay([{"target": "$", "remove": True}]))]
        )
        [finding] = result.findings
        assert finding.code == FINDING_ACTION_INVALID
        assert "root" in finding.message

    def test_unsupported_overlay_version_fails_the_import(self) -> None:
        with pytest.raises(ImportSourceError) as excinfo:
            apply_overlays(
                _base_document(),
                [("o.yaml", _overlay([{"target": "$.info", "update": {}}], version="2.0.0"))],
            )
        assert excinfo.value.code == "FORMAT_VERSION_UNSUPPORTED"

    def test_overlay_without_actions_fails_the_import(self) -> None:
        overlay = {"overlay": "1.0.0", "info": {"title": "x", "version": "1"}}
        with pytest.raises(ImportSourceError) as excinfo:
            apply_overlays(_base_document(), [("o.yaml", overlay)])
        assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"

    def test_provenance_is_capped_and_the_cap_is_declared(self) -> None:
        big = {
            "openapi": "3.1.0",
            "info": {"title": "x", "version": "1"},
            "paths": {
                f"/p{i}": {"get": {"responses": {"200": {"description": "ok"}}}}
                for i in range(MAX_PROVENANCE_RECORDS + 25)
            },
        }
        result = apply_overlays(
            big,
            [
                (
                    "o.yaml",
                    _overlay([{"target": "$.paths.*.get", "update": {"x-flag": True}}]),
                )
            ],
        )
        assert len(result.provenance) == MAX_PROVENANCE_RECORDS
        assert result.provenance_truncated
        assert result.provenance_total == MAX_PROVENANCE_RECORDS + 25

    def test_report_shape_is_deterministic(self) -> None:
        result = apply_overlays(
            _base_document(),
            [("o.yaml", _overlay([{"target": "$.info.description", "update": "x"}]))],
        )
        report = result.report()
        assert report["applied"] == ["o.yaml"]
        assert report["provenance"] == [
            {
                "pointer": "/info/description",
                "kind": "replaced",
                "overlay": "o.yaml",
                "action_index": 0,
                "target": "$.info.description",
            }
        ]
        assert report["findings"] == []
        assert report["provenance_truncated"] is False
        assert report["provenance_total"] == 1


# ---------------------------------------------------------------------------
# Adapter: detection and the bare-overlay prompt
# ---------------------------------------------------------------------------


class TestAdapterOverlaySeams:
    @pytest.fixture()
    def adapter(self) -> OpenApiImportSource:
        return OpenApiImportSource()

    def test_detect_claims_a_bare_overlay_without_pinning_a_format(self, adapter) -> None:
        result = adapter.detect(DetectionInput(text=OVERLAY_YAML))
        assert result.matched
        assert result.confidence >= 0.9
        assert result.format is None
        assert "overlay" in (result.reason or "").lower()

    def test_detect_still_rejects_unrelated_documents(self, adapter) -> None:
        assert not adapter.detect(DetectionInput(text="just: yaml")).matched

    def test_parse_of_a_bare_overlay_prompts_for_its_base(self, adapter) -> None:
        with pytest.raises(ImportSourceError) as excinfo:
            adapter.parse(OVERLAY_YAML, source_label="overlay.yaml")
        assert excinfo.value.code == "INPUT_OVERLAY_BASE_MISSING"
        assert "base" in str(excinfo.value).lower()

    def test_taxonomy_registers_the_prompt_code(self) -> None:
        descriptor = INTAKE_ERROR_TAXONOMY["INPUT_OVERLAY_BASE_MISSING"]
        assert descriptor.category.value == "input"
        assert not descriptor.retriable
        assert "base" in descriptor.remediation.lower()

    def test_parse_fileset_resolves_base_plus_overlay(self, adapter) -> None:
        fileset = IntakeFileset.from_members(
            {"openapi.yaml": BASE_YAML, "overlay.yaml": OVERLAY_YAML},
            root="openapi.yaml",
        )
        resolved = adapter.parse_fileset(fileset, source_label="set.zip")
        assert isinstance(resolved, OverlayedOpenApiDocument)
        assert resolved["info"]["description"] == "overlay copy"
        report = resolved.overlay_report
        assert report["base"] == "openapi.yaml"
        assert report["applied"] == ["overlay.yaml"]
        assert [f["code"] for f in report["findings"]] == [FINDING_UNMATCHED_TARGET]

    def test_parse_fileset_orders_overlays_by_member_path(self, adapter) -> None:
        second = OVERLAY_YAML.replace("overlay copy", "second copy")
        # Insertion order deliberately reversed: member-path order must win.
        fileset = IntakeFileset.from_members(
            {
                "02-b.yaml": second,
                "01-a.yaml": OVERLAY_YAML,
                "openapi.yaml": BASE_YAML,
            },
            root="openapi.yaml",
        )
        resolved = adapter.parse_fileset(fileset)
        assert resolved.overlay_report["applied"] == ["01-a.yaml", "02-b.yaml"]
        assert resolved["info"]["description"] == "second copy"

    def test_parse_fileset_without_a_base_prompts_for_one(self, adapter) -> None:
        fileset = IntakeFileset.from_members(
            {"overlay.yaml": OVERLAY_YAML}, root="overlay.yaml"
        )
        with pytest.raises(ImportSourceError) as excinfo:
            adapter.parse_fileset(fileset)
        assert excinfo.value.code == "INPUT_OVERLAY_BASE_MISSING"

    def test_parse_fileset_with_nothing_recognizable_is_a_format_mismatch(
        self, adapter
    ) -> None:
        fileset = IntakeFileset.from_members({"readme.yaml": "just: notes"}, root="readme.yaml")
        with pytest.raises(ImportSourceError) as excinfo:
            adapter.parse_fileset(fileset)
        assert excinfo.value.code == "FORMAT_MISMATCH"

    def test_parse_fileset_with_two_bases_is_ambiguous(self, adapter) -> None:
        fileset = IntakeFileset.from_members(
            {"a.yaml": BASE_YAML, "b.yaml": BASE_YAML, "o.yaml": OVERLAY_YAML},
            root="a.yaml",
        )
        with pytest.raises(ImportSourceError) as excinfo:
            adapter.parse_fileset(fileset)
        assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"

    def test_parse_fileset_with_a_malformed_member_names_it(self, adapter) -> None:
        fileset = IntakeFileset.from_members(
            {"openapi.yaml": BASE_YAML, "broken.yaml": "a: [unclosed"},
            root="openapi.yaml",
        )
        with pytest.raises(ImportSourceError) as excinfo:
            adapter.parse_fileset(fileset)
        assert excinfo.value.code == "INPUT_MALFORMED"
        assert "broken.yaml" in str(excinfo.value)

    def test_parse_fileset_with_only_a_base_returns_it_unwrapped(self, adapter) -> None:
        fileset = IntakeFileset.from_members(
            {"openapi.yaml": BASE_YAML, "notes.yaml": "just: notes"},
            root="openapi.yaml",
        )
        resolved = adapter.parse_fileset(fileset)
        assert not isinstance(resolved, OverlayedOpenApiDocument)
        assert resolved["info"]["description"] == "base copy"

    def test_unclassified_members_are_reported_as_ignored(self, adapter) -> None:
        fileset = IntakeFileset.from_members(
            {
                "openapi.yaml": BASE_YAML,
                "overlay.yaml": OVERLAY_YAML,
                "notes.yaml": "just: notes",
            },
            root="openapi.yaml",
        )
        resolved = adapter.parse_fileset(fileset)
        assert resolved.overlay_report["ignored_members"] == ["notes.yaml"]

    def test_normalize_publishes_the_report_on_extras(self, adapter) -> None:
        fileset = IntakeFileset.from_members(
            {"openapi.yaml": BASE_YAML, "overlay.yaml": OVERLAY_YAML},
            root="openapi.yaml",
        )
        model = adapter.normalize(adapter.parse_fileset(fileset))
        report = model.extras[OVERLAY_EXTRA_KEY]
        assert report["applied"] == ["overlay.yaml"]
        assert model.raw["info"]["description"] == "overlay copy"

    def test_normalize_without_overlays_adds_no_extras_key(self, adapter) -> None:
        model = adapter.normalize(adapter.parse(BASE_YAML))
        assert OVERLAY_EXTRA_KEY not in (model.extras or {})

    def test_lint_merges_overlay_findings_under_registered_rules(self, adapter) -> None:
        fileset = IntakeFileset.from_members(
            {"openapi.yaml": BASE_YAML, "overlay.yaml": OVERLAY_YAML},
            root="openapi.yaml",
        )
        model = adapter.normalize(adapter.parse_fileset(fileset))
        report = adapter.lint(model)
        overlay_rules = [f.rule for f in report.findings if f.rule.startswith("intake.overlay")]
        assert overlay_rules == [RULE_OVERLAY_UNMATCHED_TARGET]
        assert report.score is not None  # merged findings keep the report scored

    def test_lint_without_findings_matches_the_plain_report(self, adapter) -> None:
        clean_overlay = """
overlay: 1.0.0
info: {title: Clean, version: '1.0.0'}
actions:
  - target: $.info
    update: {description: overlay copy}
"""
        fileset = IntakeFileset.from_members(
            {"openapi.yaml": BASE_YAML, "overlay.yaml": clean_overlay},
            root="openapi.yaml",
        )
        model = adapter.normalize(adapter.parse_fileset(fileset))
        report = adapter.lint(model)
        assert not [f for f in report.findings if f.rule.startswith("intake.overlay")]

    def test_overlay_rules_are_registered(self) -> None:
        registered = {d.rule_id for d in builtin_rule_descriptors()}
        assert RULE_OVERLAY_UNMATCHED_TARGET in registered
        assert RULE_OVERLAY_ACTION_INVALID in registered

    def test_overlay_lint_findings_adapts_unknown_codes_conservatively(self) -> None:
        findings = overlay_lint_findings(
            {"findings": [{"code": "unknown", "target": "", "message": "m"}, "junk"]}
        )
        [finding] = findings
        assert finding.rule == RULE_OVERLAY_ACTION_INVALID
        assert finding.path == "#"


# ---------------------------------------------------------------------------
# Preview coverage ledger
# ---------------------------------------------------------------------------


class TestPreviewLedgerProvenance:
    def _model_with_overlay(self):
        adapter = OpenApiImportSource()
        fileset = IntakeFileset.from_members(
            {"openapi.yaml": BASE_YAML, "overlay.yaml": OVERLAY_YAML},
            root="openapi.yaml",
        )
        return adapter.normalize(adapter.parse_fileset(fileset))

    def test_overlay_extras_are_provenance_not_unmodeled(self) -> None:
        assert OVERLAY_EXTRA_KEY in PROVENANCE_EXTRA_KEYS

    def test_ledger_carries_one_mapped_row_per_provenance_record(self) -> None:
        model = self._model_with_overlay()
        full = build_import_preview_manifest(model, adapter_key="openapi")
        rows = [
            row
            for row in full.document_coverage
            if row.source_construct.startswith("overlay#")
        ]
        [row] = rows
        assert row.source_construct == "overlay#/info/description"
        assert row.coverage.value == "mapped"
        assert row.document_scoped
        assert "overlay.yaml" in row.detail and "action #0" in row.detail
        # And no unsupported-by-canonical-model row for the extras key itself.
        assert not any(
            row.source_construct == "document#overlay" for row in full.document_coverage
        )

    def test_ledger_declares_provenance_truncation(self) -> None:
        model = self._model_with_overlay()
        report = model.extras[OVERLAY_EXTRA_KEY]
        report["provenance_truncated"] = True
        report["provenance_total"] = 999
        full = build_import_preview_manifest(model, adapter_key="openapi")
        [row] = [
            row
            for row in full.document_coverage
            if row.source_construct == "overlay#(truncated)"
        ]
        assert "999" in row.detail

    def test_manifest_hash_is_stable_for_a_fixed_overlay_input(self) -> None:
        first = build_import_preview_manifest(
            self._model_with_overlay(), adapter_key="openapi"
        )
        second = build_import_preview_manifest(
            self._model_with_overlay(), adapter_key="openapi"
        )
        assert first.manifest_hash == second.manifest_hash


# ---------------------------------------------------------------------------
# Pipeline end to end
# ---------------------------------------------------------------------------


def _job_payload(
    document: bytes, filename: str, *, archive_root: str | None = None
) -> Dict[str, Any]:
    options: Dict[str, Any] = {"dry_run": True}
    if archive_root is not None:
        # Both members look like candidate roots to archive intake; the overlay
        # classification does not depend on which one the caller picks.
        options["archive_root"] = archive_root
    return {
        "rest_job_id": f"overlay-test-{filename}",
        "metadata": {
            "source_kind": "openapi",
            "project": {"name": "Overlay", "slug": "overlay"},
            "version": {"version_id": "1.0.0"},
            "options": options,
        },
        "document_base64": base64.standard_b64encode(document).decode("ascii"),
        "filename": filename,
    }


class TestPipelineIntegration:
    async def test_archive_of_base_plus_overlay_imports_resolved(self) -> None:
        [entry] = [
            e
            for e in load_corpus(format="openapi", feature="overlay-base")
            if "34-overlay-basic-set" in e.path
        ]
        archive = build_fileset_archive(entry)
        final = await run_adapter_import_job(
            OpenApiImportSource(),
            _job_payload(archive, "overlay-set.zip", archive_root="openapi.yaml"),
        )
        assert final.state == "completed", (final.error, final.events)
        assert final.summary is not None and final.summary.get("dry_run") is True

    async def test_bare_overlay_job_fails_with_the_prompt_code(self) -> None:
        final = await run_adapter_import_job(
            OpenApiImportSource(),
            _job_payload(OVERLAY_YAML.encode("utf-8"), "overlay.yaml"),
        )
        assert final.state == "failed"
        assert final.error is not None
        assert final.error.code == "INPUT_OVERLAY_BASE_MISSING"
        assert "base" in final.error.remediation.lower()


# ---------------------------------------------------------------------------
# Corpus ladder sets
# ---------------------------------------------------------------------------


def _resolve_set(root_path_fragment: str) -> Tuple[Any, Dict[str, Any]]:
    """Resolve one overlay corpus set through the adapter, returning (model, report)."""
    [root] = [
        entry
        for entry in load_corpus(format="openapi", feature="overlay-base")
        if root_path_fragment in entry.path
    ]
    adapter = OpenApiImportSource()
    resolved = adapter.parse_fileset(build_fileset(root), source_label=root.path)
    model = adapter.normalize(resolved)
    return model, model.extras[OVERLAY_EXTRA_KEY]


class TestCorpusOverlaySets:
    def test_basic_set_covers_add_update_and_remove(self) -> None:
        model, report = _resolve_set("34-overlay-basic-set")
        document = model.raw
        # update (deep merge + primitive replace)
        assert document["info"]["description"].startswith("Public production")
        assert document["info"]["x-audience"] == "public"
        limit = document["paths"]["/pets"]["get"]["parameters"][0]
        assert limit["schema"]["maximum"] == 100
        # add (array append)
        assert document["servers"][-1]["url"] == "https://api.adoption.example.com"
        # remove (path + filtered tag)
        assert "/internal/reindex" not in document["paths"]
        assert [tag["name"] for tag in document["tags"]] == ["pets"]
        kinds = {record["kind"] for record in report["provenance"]}
        assert kinds == {"set", "replaced", "appended", "removed"}
        assert report["findings"] == []

    def test_chain_set_applies_in_order_with_last_writer_provenance(self) -> None:
        model, report = _resolve_set("35-overlay-chain-set")
        document = model.raw
        assert report["applied"] == ["01-region-defaults.yaml", "02-production.yaml"]
        # 02 overrode 01's description; both writes are on record.
        assert document["info"]["description"] == "Payments gateway, EU region, production."
        writers = [
            record["overlay"]
            for record in report["provenance"]
            if record["pointer"] == "/info/description"
        ]
        assert writers == ["01-region-defaults.yaml", "02-production.yaml"]
        # both servers appended, in chain order after the base's own.
        assert [server["url"] for server in document["servers"]] == [
            "http://localhost:9000",
            "https://staging.eu.payments.example.com",
            "https://payments.eu.example.com",
        ]
        # 02 removed the listing operation.
        assert "get" not in document["paths"]["/charges"]

    def test_negative_bare_overlay_entry_declares_the_prompt_code(self) -> None:
        [entry] = load_corpus(format="openapi", feature="bare-overlay")
        assert entry.expected_error_code == "INPUT_OVERLAY_BASE_MISSING"
        document = yaml.safe_load(entry.read_text())
        assert is_overlay_document(document)


# ---------------------------------------------------------------------------
# Report → LintReport merge behaviour
# ---------------------------------------------------------------------------


def test_with_extra_findings_rescoring_keeps_overlay_findings() -> None:
    report = LintReport(findings=[], score=100, grade="A", report_fingerprint="x")
    merged = report.with_extra_findings(
        overlay_lint_findings(
            {
                "findings": [
                    {
                        "code": FINDING_UNMATCHED_TARGET,
                        "target": "$.x",
                        "message": "missed",
                    }
                ]
            }
        )
    )
    assert [f.rule for f in merged.findings] == [RULE_OVERLAY_UNMATCHED_TARGET]
    assert merged.score is not None
