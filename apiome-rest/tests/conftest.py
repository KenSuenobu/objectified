"""Shared pytest fixtures for apiome-rest tests."""

from pathlib import Path

import pytest


def pytest_addoption(parser: pytest.Parser) -> None:
    """Register repo-wide test options.

    ``--update-golden`` regenerates the IXH-1.6 canonical corpus snapshots
    (``tests/golden/corpus/``) instead of comparing against them, so an intended
    contract change is a one-command refresh whose diff lands in review. The
    ``UPDATE_CORPUS_GOLDENS=1`` environment variable does the same, mirroring the
    EFP-1.3 projection corpus's idiom.

    ``--update-roundtrip-matrix`` regenerates the IXH-1.7 round-trip matrix
    artifact (``tests/golden/roundtrip/matrix.json``); ``UPDATE_ROUNDTRIP_MATRIX=1``
    does the same.

    ``--scale`` opts this run into the IXH-1.5 scale benchmark suite, which is
    otherwise skipped because it costs minutes and hundreds of megabytes;
    ``RUN_SCALE_SUITE=1`` does the same. ``--update-scale-budgets`` rewrites its
    committed baseline (``tests/scale/scale_budgets.json``) from the run instead of
    asserting against it.
    """
    parser.addoption(
        "--update-golden",
        action="store_true",
        default=False,
        help=(
            "Regenerate canonical corpus golden snapshots (tests/golden/corpus/) "
            "instead of asserting against them."
        ),
    )
    parser.addoption(
        "--update-roundtrip-matrix",
        action="store_true",
        default=False,
        help=(
            "Regenerate the round-trip conformance matrix artifact "
            "(tests/golden/roundtrip/matrix.json) instead of asserting against it."
        ),
    )
    parser.addoption(
        "--scale",
        action="store_true",
        default=False,
        help=(
            "Run the IXH-1.5 scale benchmark suite (tests/test_scale_corpus.py), "
            "which is opt-in because it costs minutes and hundreds of megabytes."
        ),
    )
    parser.addoption(
        "--update-scale-budgets",
        action="store_true",
        default=False,
        help=(
            "Rewrite the committed scale budgets (tests/scale/scale_budgets.json) "
            "from this run instead of asserting against them."
        ),
    )


#: Test module holding the opt-in IXH-1.5 scale benchmark suite (#5091).
_SCALE_SUITE_MODULE = "test_scale_corpus.py"


def pytest_collection_modifyitems(config: pytest.Config, items: list) -> None:
    """Skip the opt-in scale benchmark suite unless this run asked for it.

    The IXH-1.5 suite builds multi-megabyte documents and runs minutes of real
    pipeline work, so by acceptance criterion it is opt-in locally (``--scale`` /
    ``RUN_SCALE_SUITE=1``) and scheduled — not per-PR — in CI. The decision lives
    here rather than in the module because pytest only honours collection hooks from
    ``conftest.py`` and plugins.

    Args:
        config: The pytest config carrying the ``--scale`` option.
        items: The collected test items, mutated in place.
    """
    from scale_corpus_spec import scale_suite_enabled

    if scale_suite_enabled(config):
        return
    skip = pytest.mark.skip(
        reason="scale suite is opt-in: run with --scale or RUN_SCALE_SUITE=1"
    )
    for item in items:
        if item.nodeid.split("::", 1)[0].endswith(_SCALE_SUITE_MODULE):
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def _disable_rate_limiting(monkeypatch):
    """
    Disable the per-tenant rate-limit middleware (#3612) for the test session.

    ``RateLimitMiddleware`` keeps an in-process fixed-window counter that is shared across every
    request the app handles. The route tests reuse one ``TestClient`` / app per module and hammer the
    same API-key bucket, so the cumulative request count trips the ``429`` limit partway through the
    full suite — making otherwise-passing tests fail purely as a function of suite ordering and size.
    Route tests assert endpoint behaviour, not throttling, so the limiter is switched off by default
    here. The dedicated coverage in ``test_rate_limit.py`` re-enables it explicitly (it builds its own
    app and monkeypatches ``settings`` per-test), so this default does not weaken limiter coverage.
    """
    try:
        from app.config import settings
    except Exception:
        return
    monkeypatch.setattr(settings, "rate_limit_enabled", False)


@pytest.fixture
def repo_root() -> Path:
    """Monorepo root (parent of ``apiome-rest/``)."""
    return Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _restore_dependency_overrides():
    """
    Snapshot and restore FastAPI dependency overrides around every test.

    Many route tests install ``app.dependency_overrides[...]`` to stub authentication and clear it in
    their own teardown. If a test body raises *before* that cleanup runs (e.g. a ``patch()`` whose
    target was renamed away in the product code), the override leaks into subsequent, unrelated tests
    and corrupts their auth context — producing order-dependent failures that pass in isolation.
    Snapshotting the overrides before the test and restoring them afterwards makes the suite
    deterministic regardless of per-test cleanup discipline.
    """
    try:
        from app.main import app
    except Exception:
        # If the app cannot be imported (pure-unit modules that never touch FastAPI), there is
        # nothing to guard; let the test run untouched.
        yield
        return
    saved = dict(app.dependency_overrides)
    try:
        yield
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


@pytest.fixture(autouse=True)
def _in_memory_async_job_store(monkeypatch):
    """Back the shared async-job store (migration V158) with a per-test in-memory fake.

    The spec-import and export engines mirror every job state change to ``apiome.async_job`` and
    read polls back from it so a round-robin deployment can poll any instance (previously the
    in-memory dict 404'd on instances that didn't create the job). Routing those five ``db``
    methods to a fresh dict per test keeps the engine tests hermetic and deterministic — no
    Postgres dependency, no cross-test accumulation in the table — while still exercising the
    real mirror→read round-trip through the fake. Tests that replace the whole ``db`` singleton
    with their own mock are unaffected (this patches the real singleton's methods only).

    Also backs the export artifact store (IXH-6.1 / V206) so completed exports persist download
    bytes into the same in-memory dict and a simulated non-owning instance can serve them.
    """
    try:
        module = __import__("app.database", fromlist=["db"])
    except Exception:
        yield
        return

    store: dict = {}
    artifacts: dict = {}

    def _upsert(*, job_id, kind, tenant_slug, state, status, extra=None):
        row = store.get(job_id) or {"cancel_requested": False, "extra": None}
        row.update(
            {
                "job_id": job_id,
                "kind": kind,
                "tenant_slug": tenant_slug,
                "state": state,
                "status": status,
            }
        )
        if extra is not None:  # COALESCE: never null out a value already recorded
            row["extra"] = extra
        store[job_id] = row

    def _matches(row, tenant_slug, kind):
        return row is not None and row["tenant_slug"] == tenant_slug and row["kind"] == kind

    def _get(job_id, tenant_slug, kind):
        row = store.get(job_id)
        return dict(row) if _matches(row, tenant_slug, kind) else None

    def _list(
        tenant_slug,
        kind,
        *,
        limit=50,
        offset=0,
        state=None,
        created_after=None,
        created_before=None,
    ):
        page_limit = max(1, min(int(limit), 200))
        page_offset = max(0, int(offset))
        rows = [dict(r) for r in store.values() if _matches(r, tenant_slug, kind)]
        if state is not None and str(state).strip():
            want = str(state).strip()
            rows = [r for r in rows if r.get("state") == want]
        # Fake store has no created_at; date filters are no-ops in unit tests.
        _ = (created_after, created_before)
        rows.sort(key=lambda r: r.get("job_id") or "", reverse=True)
        total = len(rows)
        page = rows[page_offset : page_offset + page_limit]
        return {
            "jobs": page,
            "total": total,
            "limit": page_limit,
            "offset": page_offset,
        }

    def _request_cancel(job_id, tenant_slug, kind):
        row = store.get(job_id)
        if _matches(row, tenant_slug, kind):
            row["cancel_requested"] = True
            return True
        return False

    def _cancel_requested(job_id):
        row = store.get(job_id)
        return bool(row and row.get("cancel_requested"))

    def _upsert_artifact(
        *,
        job_id,
        tenant_slug,
        content_sha256,
        size_bytes,
        media_type,
        filename,
        backend,
        content,
        storage_uri,
        expires_at,
    ):
        raw = content
        if raw is not None and hasattr(raw, "adapted"):
            # psycopg2.Binary wrapper from database.upsert_export_job_artifact
            raw = raw.adapted
        if isinstance(raw, memoryview):
            raw = raw.tobytes()
        elif isinstance(raw, bytearray):
            raw = bytes(raw)
        artifacts[job_id] = {
            "job_id": job_id,
            "tenant_slug": tenant_slug,
            "content_sha256": content_sha256,
            "size_bytes": size_bytes,
            "media_type": media_type,
            "filename": filename,
            "backend": backend,
            "content": bytes(raw) if raw is not None else None,
            "storage_uri": storage_uri,
            "expires_at": expires_at,
            "reaped_at": None,
            "created_at": None,
        }

    def _get_artifact(job_id, tenant_slug):
        row = artifacts.get(job_id)
        if row is None or row["tenant_slug"] != tenant_slug:
            return None
        return dict(row)

    def _delete_artifact(job_id, tenant_slug):
        row = artifacts.get(job_id)
        if row is None or row["tenant_slug"] != tenant_slug:
            return False
        del artifacts[job_id]
        return True

    def _reap_expired(*, now=None, limit=100):
        from datetime import datetime, timezone

        cutoff = now or datetime.now(timezone.utc)
        if getattr(cutoff, "tzinfo", None) is None:
            cutoff = cutoff.replace(tzinfo=timezone.utc)
        reaped = 0
        for row in list(artifacts.values()):
            if reaped >= limit:
                break
            if row.get("reaped_at") is not None:
                continue
            exp = row.get("expires_at")
            if exp is None:
                continue
            if getattr(exp, "tzinfo", None) is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp <= cutoff:
                row["reaped_at"] = cutoff
                row["content"] = None
                row["storage_uri"] = None
                reaped += 1
        return reaped

    monkeypatch.setattr(module.db, "upsert_async_job", _upsert)
    monkeypatch.setattr(module.db, "get_async_job", _get)
    monkeypatch.setattr(module.db, "list_async_jobs", _list)
    monkeypatch.setattr(module.db, "request_async_job_cancel", _request_cancel)
    monkeypatch.setattr(module.db, "async_job_cancel_requested", _cancel_requested)
    monkeypatch.setattr(module.db, "upsert_export_job_artifact", _upsert_artifact)
    monkeypatch.setattr(module.db, "get_export_job_artifact", _get_artifact)
    monkeypatch.setattr(module.db, "delete_export_job_artifact", _delete_artifact)
    monkeypatch.setattr(module.db, "reap_expired_export_job_artifacts", _reap_expired)
    yield

@pytest.fixture(autouse=True)
def _allow_permissions_by_default(monkeypatch):
    """
    Default the RBAC permission guard (#3611) to "allow" for route unit tests.

    Every mutating route now calls ``db.user_has_permission(...)`` via the central guard. Route unit
    tests that exercise the real ``db`` singleton (patching only the specific data methods they care
    about) would otherwise drive the guard into Postgres with synthetic ids (e.g. ``"t1"``). These
    tests assert route behaviour, not authorization, so the guard is stubbed to allow here. Tests
    that replace the whole module-level ``db`` with a mock are unaffected (the guard uses that mock),
    and the dedicated guard tests in ``test_permission_guard.py`` exercise the real predicate.

    The guard (and ``get_authenticated_user_id``) also resolve an *acting* user id before authorizing.
    For keyless (legacy) API-key callers that id comes from
    ``db.get_fallback_creator_user_id_for_tenant(tenant_id)`` — a real Postgres lookup. It is stubbed
    to return ``None`` (the "no legacy fallback user" default), which keeps the guard out of the
    database and preserves the JWT-only routes' behaviour: a keyless API key resolves to no user and
    is rejected with ``403``. Tests that need a resolvable API-key actor set ``user_id`` on their auth
    payload or patch their module-level ``db`` directly, so this default does not affect them.
    """
    allow = lambda *a, **k: True  # noqa: E731 - tiny stub
    no_fallback_actor = lambda *a, **k: None  # noqa: E731
    try:
        module = __import__("app.database", fromlist=["db"])
    except Exception:
        yield
        return
    monkeypatch.setattr(module.db, "user_has_permission", allow)
    monkeypatch.setattr(module.db, "get_fallback_creator_user_id_for_tenant", no_fallback_actor)
    yield
