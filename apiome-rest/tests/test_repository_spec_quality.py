"""Quality scoring per discovered spec (REPO-2.8, #2769).

Covers the ticket's three acceptance criteria, plus the guardrails that keep the score honest:

1. *Score computed only for classified specs (skip ``unknown_spec``)* — the classification
   helpers admit exactly the kinds the scanner calls importable and reject everything else,
   and an unclassified file is skipped with a distinguishable reason.
2. *Score visible in the Repository detail Files tab* — the listing model carries the score,
   grade, status and reason, range-checked, all optional.
3. *Score is informational only* — no scoring path raises, so nothing it touches can fail a
   scan, a refresh, or an import.

No network and no database: documents are supplied inline, exactly as the sweep supplies the
already-fetched text.
"""

from pathlib import Path

import pytest

from app.models import TenantRepositoryFileRow
from app.repository_spec_quality import (
    MAX_SCORE_BYTES,
    REASON_ADAPTER_UNAVAILABLE,
    REASON_EMPTY,
    REASON_LINT_FAILED,
    REASON_NO_ADAPTER,
    REASON_PARSE_FAILED,
    REASON_TOO_LARGE,
    REASON_UNCLASSIFIED,
    REASON_UNSCORED,
    STATUS_ERROR,
    STATUS_SCORED,
    STATUS_SKIPPED,
    is_classified_spec,
    resolve_spec_source_key,
    score_spec_text,
)

_MIGRATION = "apiome-db/scripts/V222__repository_file_quality_score_repo_2_8.sql"

# A small but complete OpenAPI document: documented operation, documented schema with an
# example, so the linter has nothing to penalise and the score lands at the top of the scale.
_GOOD_OPENAPI = """
openapi: 3.0.3
info:
  title: Widget API
  version: 1.0.0
  description: Widgets and their care.
paths:
  /widgets:
    get:
      operationId: listWidgets
      summary: List widgets
      description: Lists every widget.
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Widget"
components:
  schemas:
    Widget:
      type: object
      description: A widget.
      properties:
        id:
          type: string
          description: Identifier.
          example: w-1
"""

# The same shape stripped of everything the linter rewards: no descriptions, a snake_case
# component name, a space-separated property name, no example.
_POOR_OPENAPI = """
{
  "openapi": "3.0.3",
  "info": {"title": "x", "version": "1"},
  "paths": {"/a": {"get": {"responses": {"200": {"description": ""}}}}},
  "components": {
    "schemas": {"bad_name": {"type": "object", "properties": {"Some Field": {"type": "string"}}}}
  }
}
"""

_JSON_SCHEMA = """
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Thing",
  "description": "A thing.",
  "type": "object",
  "properties": {"id": {"type": "string", "description": "Identifier."}}
}
"""


# --- AC1: only classified specs are scored --------------------------------------------------


@pytest.mark.parametrize(
    "detected_kind,path",
    [
        ("openapi-candidate", "api/openapi.yaml"),
        ("arazzo-candidate", "flows/checkout.arazzo.yaml"),
        ("asyncapi-candidate", "events/asyncapi.yaml"),
        ("graphql-candidate", "schema.graphql"),
        ("protobuf-candidate", "proto/widget.proto"),
        ("postman-candidate", "postman_collection.json"),
        ("avro-candidate", "events/widget.avsc"),
        ("prisma-candidate", "db/schema.prisma"),
        ("sql-ddl-candidate", "db/schema.sql"),
        ("dbml-candidate", "db/schema.dbml"),
        ("json-candidate", "schemas/widget.json"),
        ("json-candidate", "types/widget.schema.json"),
    ],
)
def test_classified_specs_are_recognised(detected_kind: str, path: str) -> None:
    """Every kind the scanner counts as importable is a classified spec here too."""
    assert is_classified_spec(detected_kind, path) is True


@pytest.mark.parametrize(
    "detected_kind,path",
    [
        (None, "README.md"),
        ("", "README.md"),
        ("yaml-candidate", ".github/workflows/ci.yaml"),
        ("json-candidate", "package.json"),
        ("json-candidate", "tsconfig.json"),
    ],
)
def test_unknown_specs_are_not_classified(detected_kind, path: str) -> None:
    """``unknown_spec`` — no classification, or a generic container kind — is never scored."""
    assert is_classified_spec(detected_kind, path) is False


def test_unclassified_file_is_skipped_with_its_own_reason() -> None:
    """A non-spec file is skipped, and says *why*, so the Files tab can explain the blank."""
    outcome = score_spec_text("yaml-candidate", ".github/workflows/ci.yaml", _GOOD_OPENAPI)
    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_UNCLASSIFIED
    assert outcome.score is None
    assert outcome.scored is False


def test_classified_format_without_an_adapter_is_a_distinct_skip() -> None:
    """Prisma is classified but has no importer, which must not read as "not a spec"."""
    outcome = score_spec_text("prisma-candidate", "db/schema.prisma", "model Widget {}")
    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_NO_ADAPTER


def test_source_key_resolution_maps_kinds_onto_adapters() -> None:
    assert resolve_spec_source_key("openapi-candidate", "openapi.yaml") == "openapi"
    assert resolve_spec_source_key("swagger-candidate", "swagger.json") == "openapi"
    assert resolve_spec_source_key("protobuf-candidate", "a.proto") == "grpc"
    assert resolve_spec_source_key("json-candidate", "schemas/a.json") == "json-schema"
    # Generic JSON that is not schema-shaped resolves to nothing at all.
    assert resolve_spec_source_key("json-candidate", "package.json") is None
    assert resolve_spec_source_key(None, "anything") is None


# --- Scoring: the reused engines produce a 0–100 score --------------------------------------


def test_a_well_documented_openapi_spec_scores_at_the_top_of_the_scale() -> None:
    outcome = score_spec_text("openapi-candidate", "api/openapi.yaml", _GOOD_OPENAPI)
    assert outcome.status == STATUS_SCORED
    assert outcome.scored is True
    assert outcome.score == 100
    assert outcome.grade == "A"
    assert outcome.reason is None


def test_a_poor_spec_scores_lower_than_a_good_one() -> None:
    """The score has to discriminate, or it is not a signal."""
    good = score_spec_text("openapi-candidate", "good.yaml", _GOOD_OPENAPI)
    poor = score_spec_text("openapi-candidate", "poor.json", _POOR_OPENAPI)
    assert poor.status == STATUS_SCORED
    assert poor.score is not None and good.score is not None
    assert poor.score < good.score


def test_scores_are_deterministic() -> None:
    """Same document, same score — the engines are pure, and the stored value must be stable."""
    first = score_spec_text("openapi-candidate", "api/openapi.yaml", _GOOD_OPENAPI)
    second = score_spec_text("openapi-candidate", "api/openapi.yaml", _GOOD_OPENAPI)
    assert first == second


def test_every_score_lands_in_the_zero_to_hundred_band() -> None:
    for text, path in ((_GOOD_OPENAPI, "a.yaml"), (_POOR_OPENAPI, "b.json")):
        outcome = score_spec_text("openapi-candidate", path, text)
        assert outcome.score is not None
        assert 0 <= outcome.score <= 100


def test_json_schema_documents_are_scored_through_their_own_adapter() -> None:
    outcome = score_spec_text("json-candidate", "schemas/thing.json", _JSON_SCHEMA)
    assert outcome.status == STATUS_SCORED
    assert outcome.score is not None


# --- AC3: informational only — nothing here may raise ---------------------------------------


def test_an_unparseable_document_reports_an_error_instead_of_raising() -> None:
    outcome = score_spec_text("openapi-candidate", "api/openapi.yaml", "not: [a spec")
    assert outcome.status == STATUS_ERROR
    assert outcome.reason == REASON_PARSE_FAILED
    assert outcome.score is None


def test_an_empty_document_is_skipped() -> None:
    for text in (None, "", "   \n\t"):
        outcome = score_spec_text("openapi-candidate", "api/openapi.yaml", text)
        assert outcome.status == STATUS_SKIPPED
        assert outcome.reason == REASON_EMPTY


def test_a_truncated_download_is_skipped_rather_than_scored_on_half_a_file() -> None:
    outcome = score_spec_text(
        "openapi-candidate", "api/openapi.yaml", _GOOD_OPENAPI, truncated=True
    )
    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_TOO_LARGE


def test_an_oversized_document_is_skipped() -> None:
    outcome = score_spec_text("openapi-candidate", "big.yaml", "x" * 64, max_bytes=32)
    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_TOO_LARGE


def test_the_size_cap_matches_the_file_content_endpoint() -> None:
    """A file the UI refuses to open in one response is not silently linted in the background."""
    from app.tenant_repositories_routes import _MAX_FILE_CONTENT_BYTES

    assert MAX_SCORE_BYTES == _MAX_FILE_CONTENT_BYTES


def test_an_unavailable_adapter_is_skipped_not_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing toolchain (MFI-5.2) is a deployment fact, not a defect in the file."""
    import app.import_source as import_source

    class _Descriptor:
        available = False

    class _Adapter:
        def descriptor(self):
            return _Descriptor()

    monkeypatch.setattr(import_source, "get_import_source", lambda key: _Adapter())
    outcome = score_spec_text("openapi-candidate", "api/openapi.yaml", _GOOD_OPENAPI)
    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_ADAPTER_UNAVAILABLE


def test_a_linter_that_raises_is_contained(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.import_source as import_source

    class _Descriptor:
        available = True

    class _Adapter:
        def descriptor(self):
            return _Descriptor()

        def parse(self, raw, *, source_label=None):
            return {"openapi": "3.0.3"}

        def normalize(self, native, *, include_raw=True):
            return object()

        def lint(self, model):
            raise RuntimeError("linter exploded")

    monkeypatch.setattr(import_source, "get_import_source", lambda key: _Adapter())
    outcome = score_spec_text("openapi-candidate", "api/openapi.yaml", _GOOD_OPENAPI)
    assert outcome.status == STATUS_ERROR
    assert outcome.reason == REASON_LINT_FAILED


def test_an_adapter_that_declines_to_score_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.import_source as import_source
    from app.import_source import LintReport

    class _Descriptor:
        available = True

    class _Adapter:
        def descriptor(self):
            return _Descriptor()

        def parse(self, raw, *, source_label=None):
            return {"openapi": "3.0.3"}

        def normalize(self, native, *, include_raw=True):
            return object()

        def lint(self, model):
            return LintReport()

    monkeypatch.setattr(import_source, "get_import_source", lambda key: _Adapter())
    outcome = score_spec_text("openapi-candidate", "api/openapi.yaml", _GOOD_OPENAPI)
    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_UNSCORED


# --- AC2: the score reaches the Files tab ---------------------------------------------------


def test_the_files_listing_row_carries_the_score() -> None:
    row = TenantRepositoryFileRow(
        id="11111111-1111-1111-1111-111111111111",
        path="api/openapi.yaml",
        name="openapi.yaml",
        display_kind="OpenAPI",
        quality_score=87,
        quality_grade="B",
        quality_status=STATUS_SCORED,
    )
    assert row.quality_score == 87
    assert row.quality_grade == "B"
    assert row.quality_reason is None


def test_the_files_listing_row_defaults_to_unscored() -> None:
    """Every pre-REPO-2.8 row still serializes — the fields are optional."""
    row = TenantRepositoryFileRow(
        id="11111111-1111-1111-1111-111111111111",
        path="README.md",
        name="README.md",
        display_kind="Uncategorised",
    )
    assert row.quality_score is None
    assert row.quality_status is None


@pytest.mark.parametrize("bad", [-1, 101])
def test_the_listing_row_refuses_an_out_of_band_score(bad: int) -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        TenantRepositoryFileRow(
            id="11111111-1111-1111-1111-111111111111",
            path="api/openapi.yaml",
            name="openapi.yaml",
            display_kind="OpenAPI",
            quality_score=bad,
        )


# --- Migration guardrails -------------------------------------------------------------------

_REQUIRED_MIGRATION_FRAGMENTS = (
    "ALTER TABLE apiome.tenant_repository_files",
    "ADD COLUMN IF NOT EXISTS quality_score SMALLINT",
    "ADD COLUMN IF NOT EXISTS quality_grade VARCHAR(2)",
    "ADD COLUMN IF NOT EXISTS quality_status VARCHAR(32)",
    "ADD COLUMN IF NOT EXISTS quality_reason VARCHAR(64)",
    "ADD COLUMN IF NOT EXISTS quality_scored_at TIMESTAMPTZ",
    "ADD COLUMN IF NOT EXISTS quality_scored_blob_sha VARCHAR(64)",
    "quality_score >= 0 AND quality_score <= 100",
    "quality_status IN ('scored', 'skipped', 'error')",
    "idx_tenant_repository_files_quality_pending",
)


def test_migration_adds_the_quality_columns_and_their_guards(repo_root: Path) -> None:
    text = (repo_root / _MIGRATION).read_text()
    missing = [frag for frag in _REQUIRED_MIGRATION_FRAGMENTS if frag not in text]
    assert not missing, f"Migration missing expected fragments: {missing}"


def test_migration_adds_columns_nullably_so_existing_rows_survive(repo_root: Path) -> None:
    """Every column is nullable: an already-indexed repository reads as "not scored yet"."""
    text = (repo_root / _MIGRATION).read_text()
    assert "NOT NULL" not in text


def test_migration_does_not_backfill_or_drop_indexed_rows(repo_root: Path) -> None:
    """Scoring needs file contents, so it happens in the sweep — never in a migration."""
    text = (repo_root / _MIGRATION).read_text().upper()
    assert "DELETE FROM" not in text
    assert "UPDATE APIOME.TENANT_REPOSITORY_FILES" not in text
