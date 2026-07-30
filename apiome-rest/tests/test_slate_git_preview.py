"""Pure logic for git-triggered preview builds — APX-3.3 (private-suite#2458).

These tests pin the four acceptance criteria at the level they are decided: the signature is
verified over raw bytes and fails closed, the source digest is a stable idempotency key, the
commit URL is derived from the commit and the alias from the branch, the changed pages are
derived from the pushed files, the alias-advance gate opens only on passed checks, and the
provider-status payload always admits it was neither built nor dispatched. No database is
touched — every function here is pure.
"""

from __future__ import annotations

import hashlib
import hmac

import pytest

from app.slate_git_preview import (
    BUILD_PENDING_REASON,
    STATUS_PENDING_REASON,
    ParsedGitEvent,
    SlatePreviewEventError,
    compute_source_digest,
    derive_branch_alias_url,
    derive_immutable_url,
    describe_provider_status,
    evaluate_alias_advance,
    map_changed_files,
    parse_push_event,
    verify_github_signature,
)

SECRET = "s3cr3t-webhook"
COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4"


def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


class TestSignatureVerification:
    def test_a_correct_signature_over_the_raw_body_verifies(self):
        body = b'{"ref":"refs/heads/main","after":"abc"}'
        assert verify_github_signature(SECRET, body, _sign(SECRET, body)) is True

    def test_a_single_changed_byte_in_the_body_fails(self):
        body = b'{"ref":"refs/heads/main"}'
        sig = _sign(SECRET, body)
        assert verify_github_signature(SECRET, body + b" ", sig) is False

    def test_the_wrong_secret_fails(self):
        body = b"payload"
        assert verify_github_signature("other", body, _sign(SECRET, body)) is False

    def test_a_missing_or_absent_secret_fails_closed(self):
        body = b"payload"
        assert verify_github_signature(None, body, _sign(SECRET, body)) is False
        assert verify_github_signature("", body, _sign(SECRET, body)) is False

    def test_a_missing_or_malformed_header_fails(self):
        body = b"payload"
        assert verify_github_signature(SECRET, body, None) is False
        assert verify_github_signature(SECRET, body, "") is False
        # A bare hex digest without the sha256= scheme prefix is not accepted.
        raw_hex = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
        assert verify_github_signature(SECRET, body, raw_hex) is False


class TestSourceDigest:
    def test_the_same_commit_yields_the_same_digest(self):
        a = compute_source_digest("acme/docs", COMMIT)
        b = compute_source_digest("acme/docs", COMMIT)
        assert a == b
        assert a.startswith("sha256:")
        assert len(a) == len("sha256:") + 64

    def test_case_does_not_change_the_digest(self):
        assert compute_source_digest("Acme/Docs", COMMIT.upper()) == compute_source_digest(
            "acme/docs", COMMIT
        )

    def test_a_different_repository_or_commit_changes_the_digest(self):
        base = compute_source_digest("acme/docs", COMMIT)
        assert compute_source_digest("acme/other", COMMIT) != base
        assert compute_source_digest("acme/docs", "f" * 40) != base


class TestUrlDerivation:
    def test_the_immutable_url_is_keyed_on_the_commit(self):
        url = derive_immutable_url("previews.apiome.dev", "acme-docs", COMMIT)
        assert url == "https://previews.apiome.dev/acme-docs/commit/a1b2c3d4e5f6"

    def test_the_alias_url_is_keyed_on_the_branch(self):
        url = derive_branch_alias_url("previews.apiome.dev", "acme-docs", "feature/new-api")
        assert url == "https://previews.apiome.dev/acme-docs/branch/feature-new-api"

    def test_a_host_with_a_scheme_and_trailing_slash_is_normalised(self):
        url = derive_immutable_url("https://host.example/", "s", COMMIT)
        assert url == "https://host.example/s/commit/a1b2c3d4e5f6"


class TestParsePushEvent:
    def _payload(self, **overrides):
        base = {
            "ref": "refs/heads/main",
            "after": COMMIT,
            "repository": {"full_name": "Acme/Docs"},
            "head_commit": {
                "id": COMMIT,
                "message": "Document invoices\n\nlonger body",
                "added": ["docs/paths/invoices.md"],
                "modified": [],
                "removed": [],
            },
        }
        base.update(overrides)
        return base

    def test_a_branch_push_parses_to_its_facts(self):
        event = parse_push_event(self._payload())
        assert event.repo_full_name == "acme/docs"
        assert event.branch == "main"
        assert event.commit == COMMIT
        assert event.message == "Document invoices"  # first line only
        assert event.changed_files_added == ("docs/paths/invoices.md",)

    def test_a_tag_push_is_refused(self):
        with pytest.raises(SlatePreviewEventError) as exc:
            parse_push_event(self._payload(ref="refs/tags/v1.0.0"))
        assert exc.value.code == "not_a_branch"

    def test_a_branch_deletion_is_refused(self):
        with pytest.raises(SlatePreviewEventError) as exc:
            parse_push_event(self._payload(deleted=True))
        assert exc.value.code == "branch_deleted"

    def test_an_all_zero_head_commit_is_refused(self):
        with pytest.raises(SlatePreviewEventError) as exc:
            parse_push_event(self._payload(after="0" * 40, head_commit={}))
        assert exc.value.code == "missing_commit"

    def test_a_payload_with_no_repository_is_refused(self):
        with pytest.raises(SlatePreviewEventError) as exc:
            parse_push_event(self._payload(repository={}))
        assert exc.value.code == "missing_repository"


class TestChangedFileMapping:
    def _event(self, **files):
        return ParsedGitEvent(
            repo_full_name="acme/docs",
            branch="main",
            commit=COMMIT,
            message="",
            changed_files_added=files.get("added", ()),
            changed_files_modified=files.get("modified", ()),
            changed_files_removed=files.get("removed", ()),
        )

    def test_a_doc_file_maps_to_a_route(self):
        pages = map_changed_files(self._event(modified=["docs/paths/invoices.md"]))
        assert len(pages) == 1
        assert pages[0].route == "/paths/invoices"
        assert pages[0].kind == "changed"
        assert pages[0].source_path == "docs/paths/invoices.md"

    def test_an_index_file_maps_to_its_directory(self):
        pages = map_changed_files(self._event(added=["docs/guides/index.md"]))
        assert pages[0].route == "/guides"

    def test_a_top_level_index_maps_to_root(self):
        pages = map_changed_files(self._event(modified=["docs/index.md"]))
        assert pages[0].route == "/"

    def test_a_non_documentation_file_produces_no_page(self):
        pages = map_changed_files(
            self._event(modified=["docs/logo.png", ".github/workflows/ci.yml", "yarn.lock"])
        )
        assert pages == []

    def test_a_file_outside_the_docs_prefix_is_ignored(self):
        pages = map_changed_files(self._event(modified=["src/app.md"]))
        assert pages == []

    def test_removed_beats_modified_for_the_same_route(self):
        # A route both modified and removed in one push is reported as removed — the more
        # consequential state for a reviewer.
        pages = map_changed_files(
            self._event(modified=["docs/a.md"], removed=["docs/a.md"])
        )
        assert len(pages) == 1
        assert pages[0].kind == "removed"

    def test_pages_are_ordered_by_route(self):
        pages = map_changed_files(
            self._event(added=["docs/z.md", "docs/a.md", "docs/m.md"])
        )
        assert [p.route for p in pages] == ["/a", "/m", "/z"]


class TestAliasAdvanceGate:
    def test_passed_checks_open_the_gate(self):
        d = evaluate_alias_advance(checks_state="passed", status="queued", cleaned_up=False)
        assert d.advance is True

    def test_pending_checks_hold_the_alias(self):
        d = evaluate_alias_advance(checks_state="pending", status="queued", cleaned_up=False)
        assert d.advance is False
        assert "not completed" in d.reason

    def test_failed_checks_hold_the_alias(self):
        d = evaluate_alias_advance(checks_state="failed", status="queued", cleaned_up=False)
        assert d.advance is False
        assert "failed" in d.reason

    def test_an_expired_or_cleaned_up_preview_holds_the_alias(self):
        assert (
            evaluate_alias_advance(
                checks_state="passed", status="expired", cleaned_up=False
            ).advance
            is False
        )
        assert (
            evaluate_alias_advance(
                checks_state="passed", status="queued", cleaned_up=True
            ).advance
            is False
        )


class TestProviderStatusPayload:
    def _build(self, **overrides):
        base = {
            "immutable_url": "https://p/acme/commit/a1b2c3d4e5f6",
            "source_commit": COMMIT,
            "source_ref": "main",
            "status": "queued",
            "checks_state": "pending",
            "access_policy": "tenant",
            "robots_excluded": True,
            "expires_at": "2026-08-01T00:00:00+00:00",
            "failure_evidence": {"reason": "build failed"},
        }
        base.update(overrides)
        return base

    def test_pending_checks_report_a_pending_state(self):
        status = describe_provider_status(build=self._build(), changed_pages=[], alias_url=None)
        assert status["state"] == "pending"

    def test_passed_checks_report_success_with_changed_page_links(self):
        pages = [
            {"route": "/paths/invoices", "kind": "changed", "link_url": "https://p/x/paths/invoices", "path_id": None}
        ]
        status = describe_provider_status(
            build=self._build(checks_state="passed"),
            changed_pages=pages,
            alias_url="https://p/acme/branch/main",
        )
        assert status["state"] == "success"
        assert status["changedPageCount"] == 1
        assert status["changedPages"][0]["linkUrl"] == "https://p/x/paths/invoices"
        assert status["aliasUrl"] == "https://p/acme/branch/main"

    def test_a_failed_build_surfaces_its_failure_evidence(self):
        status = describe_provider_status(
            build=self._build(status="failed"), changed_pages=[], alias_url=None
        )
        assert status["state"] == "failure"
        assert status["failureEvidence"] == {"reason": "build failed"}

    def test_a_non_failed_status_hides_failure_evidence(self):
        status = describe_provider_status(build=self._build(), changed_pages=[], alias_url=None)
        assert status["failureEvidence"] is None

    def test_the_access_block_carries_expiry_and_policy(self):
        status = describe_provider_status(build=self._build(), changed_pages=[], alias_url=None)
        assert status["access"]["policy"] == "tenant"
        assert status["access"]["robotsExcluded"] is True
        assert status["access"]["expiresAt"] == "2026-08-01T00:00:00+00:00"

    def test_the_delivery_block_always_admits_nothing_was_dispatched(self):
        status = describe_provider_status(build=self._build(), changed_pages=[], alias_url=None)
        assert status["delivery"]["buildDispatched"] is False
        assert status["delivery"]["statusDispatched"] is False
        assert status["delivery"]["buildReason"] == BUILD_PENDING_REASON
        assert status["delivery"]["statusReason"] == STATUS_PENDING_REASON
