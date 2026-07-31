"""Signature verification and delivery parsing (REPO-4.3, #2781).

Pure: no database, no network, no clock. Everything here is exercised against literal
payloads and literal header dicts, so a failure names a decision rather than an environment.

The two things under test are the two things a forged delivery has to beat: the signature
check (which must fail closed for every kind of "I could not verify that") and the parser
(which must refuse anything that is not an actionable push or pull request rather than
degrade into an empty event that drives an empty scan).
"""

import hashlib
import hmac
import json

import pytest

from app.repository_webhook_ingest import (
    EVENT_KIND_PULL_REQUEST,
    EVENT_KIND_PUSH,
    SUPPORTED_PROVIDERS,
    WebhookEventError,
    generate_webhook_secret,
    normalize_provider,
    parse_webhook_event,
    repo_full_name_from_payload,
    secret_fingerprint,
    signature_header_for_provider,
    verify_signature,
)

_SECRET = "s3cr3t-signing-key"
_REPO = "octocat/hello-world"


def _body(payload: dict) -> bytes:
    """Serialise a payload the way a provider would send it."""
    return json.dumps(payload).encode("utf-8")


def _github_sig(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


# --- Provider normalization -------------------------------------------------------------


@pytest.mark.parametrize("provider", SUPPORTED_PROVIDERS)
def test_every_supported_provider_normalizes_to_itself(provider: str) -> None:
    assert normalize_provider(provider) == provider
    assert normalize_provider(provider.upper()) == provider
    assert normalize_provider(f"  {provider} ") == provider


@pytest.mark.parametrize("raw", ["", None, "gogs", "github.com", "../github", 7])
def test_an_unknown_provider_is_never_guessed_at(raw: object) -> None:
    """Guessing the provider would mean guessing which scheme protects the endpoint."""
    assert normalize_provider(raw) is None


def test_each_provider_declares_the_header_it_signs_with() -> None:
    assert signature_header_for_provider("github") == "X-Hub-Signature-256"
    assert signature_header_for_provider("gitlab") == "X-Gitlab-Token"
    assert signature_header_for_provider("bitbucket") == "X-Hub-Signature"
    assert signature_header_for_provider("gogs") is None


# --- Secret generation + fingerprints ---------------------------------------------------


def test_generated_secrets_are_long_and_distinct() -> None:
    first = generate_webhook_secret()
    second = generate_webhook_secret()
    assert len(first) == 64
    assert first != second
    assert all(c in "0123456789abcdef" for c in first)


def test_a_fingerprint_identifies_a_secret_without_containing_it() -> None:
    fp = secret_fingerprint(_SECRET)
    assert fp is not None
    assert len(fp) == 16
    assert fp not in _SECRET and _SECRET not in fp
    assert secret_fingerprint(_SECRET) == fp
    assert secret_fingerprint(_SECRET + "x") != fp


@pytest.mark.parametrize("blank", [None, ""])
def test_a_missing_secret_has_no_fingerprint(blank) -> None:
    assert secret_fingerprint(blank) is None


# --- Signature verification -------------------------------------------------------------


def test_a_correctly_signed_github_delivery_verifies() -> None:
    body = _body({"ref": "refs/heads/main"})
    headers = {"X-Hub-Signature-256": _github_sig(_SECRET, body)}
    assert verify_signature("github", _SECRET, body, headers) is True


def test_github_verification_is_case_insensitive_in_the_header_name() -> None:
    """Header casing is transport detail; a lowercased header must still verify."""
    body = _body({"ref": "refs/heads/main"})
    headers = {"x-hub-signature-256": _github_sig(_SECRET, body)}
    assert verify_signature("github", _SECRET, body, headers) is True


def test_a_single_changed_body_byte_invalidates_the_signature() -> None:
    """The provider signed the exact bytes; verification must never see a re-serialisation."""
    body = _body({"ref": "refs/heads/main"})
    headers = {"X-Hub-Signature-256": _github_sig(_SECRET, body)}
    assert verify_signature("github", _SECRET, body + b" ", headers) is False


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-Hub-Signature-256": ""},
        {"X-Hub-Signature-256": "   "},
        {"X-Hub-Signature-256": "deadbeef"},
        {"X-Hub-Signature-256": "sha1=deadbeef"},
        {"X-Hub-Signature-256": "sha256="},
        {"X-Hub-Signature-256": "sha256=not-hex"},
    ],
)
def test_every_malformed_github_signature_fails_closed(headers: dict) -> None:
    body = _body({"ref": "refs/heads/main"})
    assert verify_signature("github", _SECRET, body, headers) is False


def test_a_wrong_secret_does_not_verify() -> None:
    body = _body({"ref": "refs/heads/main"})
    headers = {"X-Hub-Signature-256": _github_sig("other-secret", body)}
    assert verify_signature("github", _SECRET, body, headers) is False


@pytest.mark.parametrize("secret", [None, ""])
def test_no_recoverable_secret_means_no_verification(secret) -> None:
    """A deployment with no encryption key rejects deliveries; it does not accept on trust."""
    body = _body({"ref": "refs/heads/main"})
    headers = {"X-Hub-Signature-256": _github_sig(_SECRET, body)}
    assert verify_signature("github", secret, body, headers) is False


def test_an_unsupported_provider_never_verifies_even_with_a_valid_hmac() -> None:
    body = _body({"ref": "refs/heads/main"})
    headers = {"X-Hub-Signature-256": _github_sig(_SECRET, body)}
    assert verify_signature("gogs", _SECRET, body, headers) is False


def test_gitlab_compares_the_shared_token() -> None:
    body = _body({"object_kind": "push"})
    assert verify_signature("gitlab", _SECRET, body, {"X-Gitlab-Token": _SECRET}) is True
    assert verify_signature("gitlab", _SECRET, body, {"X-Gitlab-Token": "nope"}) is False
    assert verify_signature("gitlab", _SECRET, body, {}) is False


def test_gitlab_does_not_accept_a_github_style_signature() -> None:
    """Each provider's scheme is its own; a header from another provider is not a fallback."""
    body = _body({"object_kind": "push"})
    headers = {"X-Hub-Signature-256": _github_sig(_SECRET, body)}
    assert verify_signature("gitlab", _SECRET, body, headers) is False


def test_bitbucket_verifies_its_own_hmac_header() -> None:
    body = _body({"push": {}})
    sig = _github_sig(_SECRET, body)  # same construction, different header name
    assert verify_signature("bitbucket", _SECRET, body, {"X-Hub-Signature": sig}) is True
    assert verify_signature("bitbucket", _SECRET, body, {"X-Hub-Signature": "sha256=00"}) is False


# --- Repository resolution --------------------------------------------------------------


def test_github_repository_is_read_from_full_name_and_lowercased() -> None:
    payload = {"repository": {"full_name": "OctoCat/Hello-World"}}
    assert repo_full_name_from_payload("github", payload) == _REPO


def test_gitlab_repository_uses_the_namespaced_project_path() -> None:
    """``repository.name`` is only the trailing segment and would collide across groups."""
    payload = {
        "project": {"path_with_namespace": "Group/Sub/Proj"},
        "repository": {"name": "Proj"},
    }
    assert repo_full_name_from_payload("gitlab", payload) == "group/sub/proj"


@pytest.mark.parametrize("payload", [{}, {"repository": {}}, {"repository": None}])
def test_a_payload_with_no_repository_resolves_to_nothing(payload: dict) -> None:
    assert repo_full_name_from_payload("github", payload) == ""


# --- GitHub push parsing ----------------------------------------------------------------


def test_a_github_branch_push_parses_to_branch_and_head() -> None:
    event = parse_webhook_event(
        "github",
        "push",
        {
            "ref": "refs/heads/main",
            "after": "a" * 40,
            "repository": {"full_name": "OctoCat/Hello-World"},
            "head_commit": {"id": "a" * 40},
        },
    )
    assert event.kind == EVENT_KIND_PUSH
    assert event.repo_full_name == _REPO
    assert event.branch == "main"
    assert event.head_sha == "a" * 40


def test_a_push_falls_back_to_the_head_commit_id() -> None:
    event = parse_webhook_event(
        "github",
        "push",
        {
            "ref": "refs/heads/release/2.0",
            "repository": {"full_name": _REPO},
            "head_commit": {"id": "b" * 40},
        },
    )
    assert event.branch == "release/2.0"
    assert event.head_sha == "b" * 40


@pytest.mark.parametrize(
    "payload,code",
    [
        ({"ref": "refs/tags/v1", "after": "a" * 40}, "not_a_branch"),
        ({"ref": "", "after": "a" * 40}, "not_a_branch"),
        ({"ref": "refs/heads/main", "after": "a" * 40, "deleted": True}, "branch_deleted"),
        ({"ref": "refs/heads/main", "after": "0" * 40}, "missing_commit"),
        ({"ref": "refs/heads/main"}, "missing_commit"),
    ],
)
def test_a_push_that_moves_no_scannable_code_is_refused_by_name(payload: dict, code: str) -> None:
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event("github", "push", {**payload, "repository": {"full_name": _REPO}})
    assert exc.value.code == code


def test_a_delivery_with_no_repository_is_refused() -> None:
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event("github", "push", {"ref": "refs/heads/main"})
    assert exc.value.code == "missing_repository"


@pytest.mark.parametrize("event_type", ["ping", "issues", "release", "", None])
def test_a_github_event_we_do_not_act_on_is_refused_by_name(event_type) -> None:
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event("github", event_type, {"repository": {"full_name": _REPO}})
    assert exc.value.code == "unsupported_event"


def test_an_unsupported_provider_is_refused_before_anything_is_parsed() -> None:
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event("gogs", "push", {"repository": {"full_name": _REPO}})
    assert exc.value.code == "unsupported_provider"


# --- GitHub pull-request parsing --------------------------------------------------------


def _github_pr(action: str = "opened", head_repo: str = _REPO) -> dict:
    return {
        "action": action,
        "number": 42,
        "repository": {"full_name": _REPO},
        "pull_request": {
            "number": 42,
            "base": {"ref": "main"},
            "head": {
                "ref": "feature/widgets",
                "sha": "c" * 40,
                "repo": {"full_name": head_repo},
            },
        },
    }


def test_a_pull_request_parses_base_head_and_number() -> None:
    event = parse_webhook_event("github", "pull_request", _github_pr("synchronize"))
    assert event.kind == EVENT_KIND_PULL_REQUEST
    assert event.branch == "main"  # the BASE branch is what tracking is matched against
    assert event.pr_head_branch == "feature/widgets"
    assert event.head_sha == "c" * 40
    assert event.pr_number == 42
    assert event.action == "synchronize"
    assert event.pr_head_in_repo is True


def test_a_fork_pull_request_is_marked_as_living_elsewhere() -> None:
    """A fork's branch is not in this repository's tree, so it cannot be walked."""
    event = parse_webhook_event("github", "pull_request", _github_pr(head_repo="someone/fork"))
    assert event.pr_head_in_repo is False


def test_a_pull_request_with_no_base_branch_is_refused() -> None:
    payload = _github_pr()
    payload["pull_request"]["base"] = {}
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event("github", "pull_request", payload)
    assert exc.value.code == "missing_branch"


def test_nested_nulls_in_a_pull_request_do_not_crash_the_parser() -> None:
    """Webhook bodies are attacker-adjacent; a null where an object belongs is a named error."""
    payload = {
        "action": "opened",
        "repository": {"full_name": _REPO},
        "pull_request": {"base": None, "head": None},
    }
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event("github", "pull_request", payload)
    assert exc.value.code == "missing_branch"


# --- GitLab parsing ---------------------------------------------------------------------


def test_a_gitlab_push_parses() -> None:
    event = parse_webhook_event(
        "gitlab",
        "Push Hook",
        {
            "object_kind": "push",
            "ref": "refs/heads/main",
            "after": "d" * 40,
            "project": {"path_with_namespace": "group/proj"},
        },
    )
    assert event.kind == EVENT_KIND_PUSH
    assert event.repo_full_name == "group/proj"
    assert event.branch == "main"
    assert event.head_sha == "d" * 40


def test_a_gitlab_branch_deletion_is_refused() -> None:
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event(
            "gitlab",
            "Push Hook",
            {
                "ref": "refs/heads/gone",
                "after": "0" * 40,
                "project": {"path_with_namespace": "group/proj"},
            },
        )
    assert exc.value.code == "branch_deleted"


def test_a_gitlab_merge_request_parses_target_and_source() -> None:
    event = parse_webhook_event(
        "gitlab",
        "Merge Request Hook",
        {
            "object_kind": "merge_request",
            "project": {"path_with_namespace": "group/proj"},
            "object_attributes": {
                "iid": 7,
                "action": "update",
                "target_branch": "main",
                "source_branch": "feature",
                "source_project_id": 11,
                "target_project_id": 11,
                "last_commit": {"id": "e" * 40},
            },
        },
    )
    assert event.kind == EVENT_KIND_PULL_REQUEST
    assert event.branch == "main"
    assert event.pr_head_branch == "feature"
    assert event.pr_number == 7
    assert event.head_sha == "e" * 40
    assert event.pr_head_in_repo is True


def test_a_gitlab_merge_request_from_a_fork_project_is_marked_external() -> None:
    event = parse_webhook_event(
        "gitlab",
        "Merge Request Hook",
        {
            "object_kind": "merge_request",
            "project": {"path_with_namespace": "group/proj"},
            "object_attributes": {
                "target_branch": "main",
                "source_branch": "feature",
                "source_project_id": 99,
                "target_project_id": 11,
            },
        },
    )
    assert event.pr_head_in_repo is False


def test_a_gitlab_event_we_do_not_act_on_is_refused() -> None:
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event(
            "gitlab", "Issue Hook", {"project": {"path_with_namespace": "group/proj"}}
        )
    assert exc.value.code == "unsupported_event"


# --- Bitbucket parsing ------------------------------------------------------------------


def test_a_bitbucket_push_parses() -> None:
    event = parse_webhook_event(
        "bitbucket",
        "repo:push",
        {
            "repository": {"full_name": "Team/Proj"},
            "push": {
                "changes": [
                    {"new": {"type": "branch", "name": "main", "target": {"hash": "f" * 40}}}
                ]
            },
        },
    )
    assert event.kind == EVENT_KIND_PUSH
    assert event.repo_full_name == "team/proj"
    assert event.branch == "main"
    assert event.head_sha == "f" * 40


def test_a_bitbucket_branch_deletion_is_refused() -> None:
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event(
            "bitbucket",
            "repo:push",
            {"repository": {"full_name": "team/proj"}, "push": {"changes": [{"new": None}]}},
        )
    assert exc.value.code == "branch_deleted"


def test_a_bitbucket_tag_push_is_refused() -> None:
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event(
            "bitbucket",
            "repo:push",
            {
                "repository": {"full_name": "team/proj"},
                "push": {"changes": [{"new": {"type": "tag", "name": "v1"}}]},
            },
        )
    assert exc.value.code == "not_a_branch"


def test_a_bitbucket_pull_request_parses() -> None:
    event = parse_webhook_event(
        "bitbucket",
        "pullrequest:updated",
        {
            "repository": {"full_name": "team/proj"},
            "pullrequest": {
                "id": 3,
                "destination": {"branch": {"name": "main"}},
                "source": {
                    "branch": {"name": "feature"},
                    "commit": {"hash": "9" * 40},
                    "repository": {"full_name": "Team/Proj"},
                },
            },
        },
    )
    assert event.kind == EVENT_KIND_PULL_REQUEST
    assert event.branch == "main"
    assert event.pr_head_branch == "feature"
    assert event.pr_number == 3
    assert event.action == "updated"
    assert event.pr_head_in_repo is True


def test_a_bitbucket_event_we_do_not_act_on_is_refused() -> None:
    with pytest.raises(WebhookEventError) as exc:
        parse_webhook_event(
            "bitbucket", "issue:created", {"repository": {"full_name": "team/proj"}}
        )
    assert exc.value.code == "unsupported_event"
