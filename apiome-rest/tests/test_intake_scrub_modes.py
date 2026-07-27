"""Intake scrub mode behaviour — MFI-29.6 (#4393).

Where :mod:`tests.test_intake_secret_scrub` pins *what* counts as a credential and
:mod:`tests.test_intake_scrub_policy` pins *which mode* applies, this module pins what the
two combine into at the persistence boundary — the ticket's acceptance criteria, stated as
tests against :func:`app.import_source_pipeline.scrub_intake_source`:

* a fixture with embedded tokens persists only redacted content;
* the report lists the redactions (types and locations, never values);
* scrubbing alters values only, never fingerprint-relevant structure;
* **warn-only surfaces the findings without modifying content.**

The credential below is realistic in shape only and is assembled from fragments so that no
credential-shaped literal is committed.
"""

from __future__ import annotations

import base64
import json
import zipfile
from io import BytesIO
from typing import Dict

import pytest

from app.fileset import IntakeFileset
from app.import_source_pipeline import _ResolvedIntake, scrub_intake_source
from app.intake_scrub_policy import (
    MODE_ENFORCE,
    MODE_WARN_ONLY,
    ScrubPolicy,
    resolve_scrub_mode,
)
from app.intake_secret_scrub import REDACTION_MARKER

_TOKEN = "AIza" + "SyD-0a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P"
_PASSWORD = "S3cr3t-Staging-Pass"

#: An OpenAPI document carrying two credentials in the two places they really appear: a
#: server URL's userinfo and a vendor-extension key.
_DOCUMENT = json.dumps(
    {
        "openapi": "3.1.0",
        "info": {"title": "Orders", "version": "1.0.0"},
        "servers": [{"url": f"https://svc:{_PASSWORD}@staging.example.com/v1"}],
        "x-gateway": {"api_key": _TOKEN},
        "paths": {"/orders": {"get": {"responses": {"200": {"description": "ok"}}}}},
    },
    indent=2,
)


def _text_intake(text: str) -> _ResolvedIntake:
    """A single-document intake, as an upload or paste produces."""
    return _ResolvedIntake(
        raw_bytes=text.encode("utf-8"), text=text, fileset=None, archive_root=None
    )


def _fileset_intake(members: Dict[str, str], root: str) -> _ResolvedIntake:
    """An archive intake, as a zip upload or a packed git selection produces."""
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, body in sorted(members.items()):
            archive.writestr(path, body)
    return _ResolvedIntake(
        raw_bytes=buffer.getvalue(),
        text=None,
        fileset=IntakeFileset.from_members(members, root=root),
        archive_root=root,
    )


def _resolution(mode: str, *, entropy_detection: bool = True):
    """A resolution for ``mode`` under an ordinary (non-capture) format."""
    policy = ScrubPolicy(
        policy_version_id="44444444-4444-4444-8444-444444444444",
        version_number=2,
        content_fingerprint="fp",
        mode=mode,
        entropy_detection=entropy_detection,
        is_default=False,
    )
    return resolve_scrub_mode(policy, format_key="openapi")


# --- enforce ---------------------------------------------------------------------------


def test_enforce_persists_only_redacted_content():
    """Acceptance: a fixture with embedded tokens persists only redacted content."""
    fields, report = scrub_intake_source(_text_intake(_DOCUMENT), _resolution(MODE_ENFORCE))

    stored = fields["sourceContent"]
    assert _TOKEN not in stored
    assert _PASSWORD not in stored
    assert REDACTION_MARKER in stored
    assert report["mode"] == MODE_ENFORCE
    assert report["applied"] is True


def test_enforce_report_lists_the_redactions_without_the_values():
    """Acceptance: the summary lists redactions — what and where, never the secret."""
    _fields, report = scrub_intake_source(_text_intake(_DOCUMENT), _resolution(MODE_ENFORCE))

    assert report["scrubbed"] is True
    assert report["redactions"] >= 2
    assert set(report["secret_types"]) == {"google-api-key", "url-embedded-credential"}
    assert all(finding["line"] >= 1 for finding in report["findings"])
    serialized = json.dumps(report)
    assert _TOKEN not in serialized
    assert _PASSWORD not in serialized


def test_enforce_alters_values_only():
    """Acceptance: scrubbing never alters fingerprint-relevant structure."""
    fields, _report = scrub_intake_source(_text_intake(_DOCUMENT), _resolution(MODE_ENFORCE))

    original = json.loads(_DOCUMENT)
    scrubbed = json.loads(fields["sourceContent"])
    assert set(scrubbed) == set(original)
    assert scrubbed["info"] == original["info"]
    assert scrubbed["paths"] == original["paths"]
    assert scrubbed["x-gateway"]["api_key"] == REDACTION_MARKER
    # The URL keeps scheme, user, host and path; only the password is gone.
    url = scrubbed["servers"][0]["url"]
    assert url.startswith("https://svc:") and url.endswith("@staging.example.com/v1")


def test_default_resolution_enforces():
    """A caller with no tenant context still redacts — the omitted argument is not a bypass."""
    fields, report = scrub_intake_source(_text_intake(_DOCUMENT))
    assert _TOKEN not in fields["sourceContent"]
    assert report["applied"] is True
    assert report["mode"] == MODE_ENFORCE


# --- warn only -------------------------------------------------------------------------


def test_warn_only_surfaces_findings_without_modifying_content():
    """Acceptance: warn-only surfaces findings without modifying content."""
    fields, report = scrub_intake_source(_text_intake(_DOCUMENT), _resolution(MODE_WARN_ONLY))

    assert fields["sourceContent"] == _DOCUMENT, "warn-only rewrote the source"
    assert REDACTION_MARKER not in fields["sourceContent"]
    assert report["scrubbed"] is True
    assert report["mode"] == MODE_WARN_ONLY
    assert report["applied"] is False


def test_warn_only_reports_exactly_what_enforce_would_have_redacted():
    """The mode changes the *action*, never the detection — otherwise it is not a preview."""
    _enforced_fields, enforced = scrub_intake_source(
        _text_intake(_DOCUMENT), _resolution(MODE_ENFORCE)
    )
    _warned_fields, warned = scrub_intake_source(
        _text_intake(_DOCUMENT), _resolution(MODE_WARN_ONLY)
    )

    assert warned["findings"] == enforced["findings"]
    assert warned["secret_types"] == enforced["secret_types"]
    assert warned["redactions"] == enforced["redactions"]


def test_warn_only_report_still_carries_policy_provenance():
    _fields, report = scrub_intake_source(_text_intake(_DOCUMENT), _resolution(MODE_WARN_ONLY))
    assert report["policy_tier"] == "tenant"
    assert report["format_key"] == "openapi"
    assert report["policy_version_id"] == "44444444-4444-4444-8444-444444444444"
    assert report["policy_content_fingerprint"] == "fp"


def test_clean_document_is_untouched_in_both_modes():
    clean = json.dumps({"openapi": "3.1.0", "info": {"title": "Clean", "version": "1.0.0"}})
    for mode in (MODE_ENFORCE, MODE_WARN_ONLY):
        fields, report = scrub_intake_source(_text_intake(clean), _resolution(mode))
        assert fields["sourceContent"] == clean
        assert report["scrubbed"] is False
        assert report["redactions"] == 0
        assert report["source_withheld"] is False


# --- archives --------------------------------------------------------------------------


def test_enforce_withholds_an_archive_carrying_a_secret():
    """The blob cannot be rewritten safely, so enforcement drops it rather than storing it."""
    intake = _fileset_intake(
        {"main.yaml": "openapi: 3.1.0\n", "env.yaml": f'api_key: "{_TOKEN}"\n'}, "main.yaml"
    )
    fields, report = scrub_intake_source(intake, _resolution(MODE_ENFORCE))

    assert fields["sourceContent"] is None
    assert fields["sourceWithheld"] == "secrets-detected"
    assert report["source_withheld"] is True
    # The catalog item stays complete: the member list and root still persist.
    assert fields["filesetRoot"] == "main.yaml"
    assert fields["filesetMembers"] == ["env.yaml", "main.yaml"]


def test_warn_only_keeps_the_archive_whole():
    """Warn-only modifies nothing, so the upload stays re-downloadable."""
    members = {"main.yaml": "openapi: 3.1.0\n", "env.yaml": f'api_key: "{_TOKEN}"\n'}
    intake = _fileset_intake(members, "main.yaml")
    fields, report = scrub_intake_source(intake, _resolution(MODE_WARN_ONLY))

    assert "sourceWithheld" not in fields
    assert fields["sourceEncoding"] == "base64"
    assert base64.standard_b64decode(fields["sourceContent"]) == intake.raw_bytes
    assert report["scrubbed"] is True, "warn-only must still report what it found"
    assert report["source_withheld"] is False


def test_archive_report_names_the_members_that_carried_secrets():
    """A line number alone is ambiguous across an archive — the operator needs the file."""
    intake = _fileset_intake(
        {
            "main.yaml": "openapi: 3.1.0\n",
            "env.yaml": f'api_key: "{_TOKEN}"\n',
            "creds.yaml": f'password: "{_PASSWORD}"\n',
        },
        "main.yaml",
    )
    _fields, report = scrub_intake_source(intake, _resolution(MODE_ENFORCE))

    assert report["members"] == ["creds.yaml", "env.yaml"]
    assert "main.yaml" not in report["members"]
    # Still no values, only locations.
    assert _TOKEN not in json.dumps(report)
    assert _PASSWORD not in json.dumps(report)


def test_clean_archive_reports_no_members():
    intake = _fileset_intake({"main.yaml": "openapi: 3.1.0\n"}, "main.yaml")
    _fields, report = scrub_intake_source(intake, _resolution(MODE_ENFORCE))
    assert report["members"] == []


def test_clean_archive_is_stored_verbatim_in_both_modes():
    intake = _fileset_intake({"main.yaml": "openapi: 3.1.0\n"}, "main.yaml")
    for mode in (MODE_ENFORCE, MODE_WARN_ONLY):
        fields, report = scrub_intake_source(intake, _resolution(mode))
        assert base64.standard_b64decode(fields["sourceContent"]) == intake.raw_bytes
        assert report["source_withheld"] is False


# --- entropy toggle --------------------------------------------------------------------


@pytest.mark.parametrize("mode", [MODE_ENFORCE, MODE_WARN_ONLY])
def test_entropy_toggle_reaches_the_scrubber(mode):
    """The policy's entropy switch has to survive the trip to the detector."""
    opaque = "f4Kd9Lm2Qp7" + "Rt3Vw8Yz1Ab" + "5Cd6Ef0Gh"
    document = json.dumps({"openapi": "3.1.0", "x-auth": {"value": opaque}})

    _fields, on = scrub_intake_source(
        _text_intake(document), _resolution(mode, entropy_detection=True)
    )
    _fields, off = scrub_intake_source(
        _text_intake(document), _resolution(mode, entropy_detection=False)
    )

    assert on["scrubbed"] is True
    assert on["entropy_detection"] is True
    assert off["scrubbed"] is False
    assert off["entropy_detection"] is False
