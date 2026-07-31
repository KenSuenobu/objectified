"""The background pass that fills in per-spec quality scores (REPO-2.8, #2769).

Scoring one document is :mod:`app.repository_spec_quality`'s job and is covered in
``test_repository_spec_quality.py``. This file covers the worker around it:

* it claims only classified specs, and only ones whose stored score is missing or stale;
* it stamps every claimed row with the blob it read — success, skip, or error — so a file is
  downloaded at most once per revision and an unscorable file settles;
* it is bounded per tick and can be switched off entirely; and
* no provider failure, token failure, or write failure escapes it.

Runs with a fake database and a stubbed downloader, so there is no network and no DB.
"""

from typing import Any, Dict, List, Optional

import pytest

from app import repository_quality_sweep as sweep
from app.repository_quality_sweep import (
    REASON_NO_TOKEN,
    process_repository_spec_quality_batch,
    score_repository_file_row,
)
from app.repository_spec_quality import (
    REASON_FETCH_FAILED,
    REASON_PROVIDER_UNSUPPORTED,
    REASON_TOO_LARGE,
    STATUS_ERROR,
    STATUS_SCORED,
    STATUS_SKIPPED,
)

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


def _row(**overrides: Any) -> Dict[str, Any]:
    """One claimed row, shaped like the DAO's join output."""
    row: Dict[str, Any] = {
        "id": "11111111-1111-1111-1111-111111111111",
        "repository_id": "22222222-2222-2222-2222-222222222222",
        "tenant_id": "33333333-3333-3333-3333-333333333333",
        "branch": "main",
        "path": "api/openapi.yaml",
        "name": "openapi.yaml",
        "size_bytes": 512,
        "blob_sha": "abc123",
        "detected_kind": "openapi-candidate",
        "provider": "github",
        "clone_url": "https://github.com/acme/widgets.git",
        "repository_full_name": "acme/widgets",
        "linked_account_id": None,
        "created_by": None,
        "visibility": "public",
    }
    row.update(overrides)
    return row


class FakeDb:
    """Minimal stand-in for :class:`app.database.Database` on the sweep's call surface."""

    def __init__(self, rows: Optional[List[Dict[str, Any]]] = None, token: Optional[str] = None):
        self.rows = rows or []
        self.token = token
        self.claims: List[int] = []
        self.writes: List[Dict[str, Any]] = []
        self.write_error: Optional[Exception] = None
        #: REPO-3.9: the external-$ref policy step the sweep runs on every downloaded blob.
        #: No stored row means the fail-closed default (``block``), which is what these
        #: scoring tests want — nothing is fetched and no document is rewritten.
        self.external_ref_policy_row: Optional[Dict[str, Any]] = None
        self.external_ref_warnings: List[Any] = []
        self.audits: List[Dict[str, Any]] = []

    def claim_repository_files_for_quality_scoring(self, limit: int = 25) -> List[Dict[str, Any]]:
        self.claims.append(limit)
        return self.rows[:limit]

    def set_repository_file_quality(self, file_id: str, **kwargs: Any) -> int:
        if self.write_error is not None:
            raise self.write_error
        self.writes.append({"file_id": file_id, **kwargs})
        return 1

    def get_external_auth_provider_for_user(self, linked: str, user: str) -> Optional[Dict[str, Any]]:
        return {"access_token": self.token} if self.token else None

    def get_tenant_external_ref_policy(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        return self.external_ref_policy_row

    def set_repository_file_external_ref_warning(self, file_id: str, warning: Any) -> int:
        self.external_ref_warnings.append({"file_id": file_id, "warning": warning})
        return 1

    def insert_workflow_audit(
        self, tenant_id, project_id, version_id, action, outcome, actor_id, detail=None
    ) -> None:
        self.audits.append({"action": action, "detail": detail})


@pytest.fixture()
def stub_download(monkeypatch: pytest.MonkeyPatch):
    """Replace the GitHub content reader with a scripted one; returns the call log."""
    calls: List[Dict[str, Any]] = []

    def _install(text: str = _GOOD_OPENAPI, truncated: bool = False, error: Optional[Exception] = None):
        def _fetch(owner, repo, path, ref, token, *, max_bytes=0):
            calls.append(
                {"owner": owner, "repo": repo, "path": path, "ref": ref, "token": token}
            )
            if error is not None:
                raise error
            return text, truncated

        monkeypatch.setattr(sweep, "fetch_github_repository_file_text", _fetch)
        return calls

    return _install


# --- Scoring one claimed row ----------------------------------------------------------------


def test_a_public_openapi_file_is_downloaded_and_scored(stub_download) -> None:
    calls = stub_download()
    db = FakeDb()

    outcome = score_repository_file_row(db, _row())

    assert outcome.status == STATUS_SCORED
    assert outcome.score == 100
    assert outcome.grade == "A"
    assert calls == [
        {"owner": "acme", "repo": "widgets", "path": "api/openapi.yaml", "ref": "main", "token": None}
    ]


def test_a_private_repository_uses_its_linked_account_token(stub_download) -> None:
    calls = stub_download()
    db = FakeDb(token="gho_secret")

    outcome = score_repository_file_row(
        db,
        _row(
            visibility="private",
            linked_account_id="44444444-4444-4444-4444-444444444444",
            created_by="55555555-5555-5555-5555-555555555555",
        ),
    )

    assert outcome.status == STATUS_SCORED
    assert calls[0]["token"] == "gho_secret"


def test_a_private_repository_without_a_token_is_skipped_without_a_request(stub_download) -> None:
    """No token means no read — the sweep must not probe a private repo it cannot open."""
    calls = stub_download()
    db = FakeDb(token=None)

    outcome = score_repository_file_row(db, _row(visibility="private"))

    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_NO_TOKEN
    assert calls == []


def test_a_non_github_repository_is_skipped_without_a_request(stub_download) -> None:
    calls = stub_download()
    outcome = score_repository_file_row(FakeDb(), _row(provider="gitlab"))

    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_PROVIDER_UNSUPPORTED
    assert calls == []


def test_an_oversized_file_is_skipped_before_it_is_downloaded(stub_download) -> None:
    """The indexed size is checked first, so a huge blob never crosses the wire."""
    calls = stub_download()
    outcome = score_repository_file_row(FakeDb(), _row(size_bytes=50_000_000))

    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_TOO_LARGE
    assert calls == []


def test_a_provider_failure_is_recorded_not_raised(stub_download) -> None:
    stub_download(error=ValueError("GitHub returned 403"))
    outcome = score_repository_file_row(FakeDb(), _row())

    assert outcome.status == STATUS_ERROR
    assert outcome.reason == REASON_FETCH_FAILED


def test_a_token_lookup_failure_degrades_to_no_token(stub_download) -> None:
    stub_download()

    class _ExplodingDb(FakeDb):
        def get_external_auth_provider_for_user(self, linked: str, user: str):
            raise RuntimeError("auth store down")

    outcome = score_repository_file_row(
        _ExplodingDb(),
        _row(
            visibility="private",
            linked_account_id="44444444-4444-4444-4444-444444444444",
            created_by="55555555-5555-5555-5555-555555555555",
        ),
    )

    assert outcome.status == STATUS_SKIPPED
    assert outcome.reason == REASON_NO_TOKEN


# --- One sweep tick -------------------------------------------------------------------------


def test_a_tick_scores_its_batch_and_stamps_every_row(stub_download) -> None:
    stub_download()
    db = FakeDb(rows=[_row(id=f"row-{i}") for i in range(3)])

    result = process_repository_spec_quality_batch(db, limit=3)

    assert result.claimed == 3
    assert result.scored == 3
    assert result.skipped == 0
    assert result.errored == 0
    assert len(db.writes) == 3
    for write in db.writes:
        assert write["status"] == STATUS_SCORED
        assert write["score"] == 100
        # The blob is stamped so this (file, blob) pair is never claimed again.
        assert write["blob_sha"] == "abc123"


def test_a_skip_still_stamps_the_blob_so_the_row_settles(stub_download) -> None:
    """Without this the sweep would re-claim every unscorable file forever."""
    stub_download()
    db = FakeDb(rows=[_row(provider="gitlab")])

    result = process_repository_spec_quality_batch(db, limit=5)

    assert result.skipped == 1
    assert db.writes[0]["status"] == STATUS_SKIPPED
    assert db.writes[0]["reason"] == REASON_PROVIDER_UNSUPPORTED
    assert db.writes[0]["blob_sha"] == "abc123"


def test_an_error_row_is_tallied_separately(stub_download) -> None:
    stub_download(error=ValueError("boom"))
    db = FakeDb(rows=[_row()])

    result = process_repository_spec_quality_batch(db, limit=5)

    assert result.errored == 1
    assert result.scored == 0
    assert db.writes[0]["status"] == STATUS_ERROR


def test_a_tick_with_nothing_due_does_no_work(stub_download) -> None:
    calls = stub_download()
    db = FakeDb(rows=[])

    result = process_repository_spec_quality_batch(db)

    assert result == (0, 0, 0, 0)
    assert calls == []
    assert db.writes == []


def test_the_batch_size_bounds_one_tick(stub_download) -> None:
    stub_download()
    db = FakeDb(rows=[_row(id=f"row-{i}") for i in range(50)])

    result = process_repository_spec_quality_batch(db, limit=4)

    assert db.claims == [4]
    assert result.claimed == 4


def test_the_configured_batch_size_is_used_by_default(
    stub_download, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_download()
    monkeypatch.setattr(sweep.settings, "repository_quality_batch_size", 7)
    db = FakeDb(rows=[_row(id=f"row-{i}") for i in range(20)])

    process_repository_spec_quality_batch(db)

    assert db.claims == [7]


def test_scoring_can_be_switched_off_entirely(
    stub_download, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The kill switch has to stop the claim too, not just the download."""
    calls = stub_download()
    monkeypatch.setattr(sweep.settings, "repository_quality_scoring_enabled", False)
    db = FakeDb(rows=[_row()])

    result = process_repository_spec_quality_batch(db)

    assert result == (0, 0, 0, 0)
    assert db.claims == []
    assert calls == []


def test_a_write_failure_does_not_abort_the_rest_of_the_batch(stub_download) -> None:
    stub_download()
    db = FakeDb(rows=[_row(id=f"row-{i}") for i in range(2)])
    db.write_error = RuntimeError("write failed")

    result = process_repository_spec_quality_batch(db, limit=2)

    # Both rows were attempted; neither was counted, and nothing propagated.
    assert result.claimed == 2
    assert result.scored == 0
    assert db.writes == []


# --- The claim + write DAO ------------------------------------------------------------------


class _RecordingDatabase:
    """A :class:`app.database.Database` with its two SQL entry points recorded.

    Built with ``__new__`` so no connection is opened; only the two methods under test are
    exercised, and both are pure query builders above ``execute_query`` / ``_execute_write``.
    """

    @staticmethod
    def build():
        from app.database import Database

        db = Database.__new__(Database)
        db.queries = []  # type: ignore[attr-defined]
        db.writes = []  # type: ignore[attr-defined]

        def _execute_query(query: str, params: tuple = None):
            db.queries.append((query, params))  # type: ignore[attr-defined]
            return []

        def _execute_write(query: str, params: tuple = None) -> int:
            db.writes.append((query, params))  # type: ignore[attr-defined]
            return 1

        db.execute_query = _execute_query  # type: ignore[assignment]
        db._execute_write = _execute_write  # type: ignore[assignment]
        return db


def test_the_claim_selects_only_classified_specs_with_a_stale_score() -> None:
    """The ``unknown_spec`` exclusion lives in SQL, so it has to be asserted in SQL."""
    from app.database import REPOSITORY_FILE_IMPORTABLE_SQL

    db = _RecordingDatabase.build()
    db.claim_repository_files_for_quality_scoring(10)

    query, params = db.queries[0]
    assert REPOSITORY_FILE_IMPORTABLE_SQL in query
    assert "f.quality_scored_blob_sha IS DISTINCT FROM f.blob_sha" in query
    assert "f.blob_sha IS NOT NULL" in query
    assert "r.deleted_at IS NULL" in query
    assert params == (10,)


def test_the_claim_limit_is_clamped_to_a_sane_batch() -> None:
    db = _RecordingDatabase.build()
    db.claim_repository_files_for_quality_scoring(0)
    db.claim_repository_files_for_quality_scoring(10_000)

    assert db.queries[0][1] == (1,)
    assert db.queries[1][1] == (500,)


def test_the_write_stamps_the_blob_and_the_attempt_time() -> None:
    db = _RecordingDatabase.build()
    db.set_repository_file_quality(
        "11111111-1111-1111-1111-111111111111",
        status=STATUS_SCORED,
        score=91,
        grade="A",
        reason=None,
        blob_sha="abc123",
    )

    query, params = db.writes[0]
    assert "UPDATE apiome.tenant_repository_files" in query
    assert "quality_scored_at = NOW()" in query
    assert "quality_scored_blob_sha = %s" in query
    assert params == (91, "A", STATUS_SCORED, None, "abc123", "11111111-1111-1111-1111-111111111111")


def test_the_files_listing_page_returns_the_quality_columns() -> None:
    """AC2: the Files tab can only show what the page query selects."""
    import inspect

    from app.database import Database

    source = inspect.getsource(Database.tenant_repository_files_stats_and_page)
    for column in ("f.quality_score", "f.quality_grade", "f.quality_status", "f.quality_reason"):
        assert column in source


# --- REPO-3.9: the external $ref policy runs on the blob this sweep downloads ------------------


_SPEC_WITH_EXTERNAL_REF = """
openapi: 3.0.3
info:
  title: Widget API
  version: 1.0.0
  description: Widgets and their care.
paths: {}
components:
  schemas:
    Price:
      $ref: "https://schemas.acme.com/common.json#/Money"
"""


def test_the_default_policy_warns_the_file_instead_of_fetching(stub_download) -> None:
    """AC4: under `block` the file gains a warning naming the reference it is missing."""
    stub_download(_SPEC_WITH_EXTERNAL_REF)
    db = FakeDb()

    score_repository_file_row(db, _row())

    assert len(db.external_ref_warnings) == 1
    written = db.external_ref_warnings[0]
    assert written["file_id"] == "11111111-1111-1111-1111-111111111111"
    warning = written["warning"]
    assert warning["policy"] == "block"
    assert warning["unresolved_count"] == 1
    assert warning["unresolved"][0]["url"] == "https://schemas.acme.com/common.json"


def test_a_file_with_no_external_refs_has_its_warning_cleared(stub_download) -> None:
    stub_download()  # the plain OpenAPI fixture: in-document $refs only
    db = FakeDb()

    score_repository_file_row(db, _row())

    assert db.external_ref_warnings == [
        {"file_id": "11111111-1111-1111-1111-111111111111", "warning": None}
    ]


def test_an_inline_tenant_scores_the_snapshot_the_policy_produced(
    stub_download, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The point of `inline`: the graded document is the one the tenant will import."""
    from app.repository_external_ref_policy import EXTERNAL_REF_FETCHED_ACTION
    from app.repository_spec_quality import skipped

    stub_download(_SPEC_WITH_EXTERNAL_REF)
    db = FakeDb()
    db.external_ref_policy_row = {
        "repository_external_ref_policy": "inline",
        "repository_external_ref_allowlist": [],
    }
    graded: List[str] = []

    def _capture(detected_kind, path, text, *, truncated=False):
        graded.append(text)
        return skipped("unclassified")

    monkeypatch.setattr(sweep, "score_spec_text", _capture)
    # Substituted at the resolver's own fetch seam, so the SSRF-guarded client is never built
    # and the test stays off the network.
    monkeypatch.setattr(
        "app.remote_ref_resolver._http_fetch",
        lambda url, *, max_bytes, timeout: b'{"Money": {"type": "object"}}',
    )

    score_repository_file_row(db, _row())

    assert len(graded) == 1
    assert "schemas.acme.com" not in graded[0], "the reference should have been inlined"
    assert '"type":"object"' in graded[0]
    # AC3: the fetch is auditable; AC4's warning is cleared because nothing is unresolved.
    assert [audit["action"] for audit in db.audits] == [EXTERNAL_REF_FETCHED_ACTION]
    assert db.audits[0]["detail"]["path"] == "api/openapi.yaml"
    assert db.external_ref_warnings == [
        {"file_id": "11111111-1111-1111-1111-111111111111", "warning": None}
    ]
