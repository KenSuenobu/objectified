"""Release-proof mock verification records — PMR-3.2 (#4749).

A CI job can already start a version-pinned mock (PMR-1.2), run the shared conformance corpus
against it (PMR-3.1), and see it pass. What it could not do was *say so afterwards in a way a
release proof can carry*: the job's console output is not evidence, and "the mock was fine" with no
bundle digest behind it is a claim, not a proof.

This module produces that evidence — the **mock verification record**, a small, deterministic JSON
document naming exactly four things and nothing else:

``bundle``
    The immutable identity of what was served: the bundle's ``manifestDigest``, its format and
    format version, whether it was signed, and the API coordinates it pins. The digest is the
    subject a release proof attaches; the coordinates are context.
``runtime``
    Which apiome-mock served it, and (when the job knows it) the container image reference. A
    conformance pass means nothing without the runtime version that produced it.
``conformance``
    The corpus identity — format, declared version, and content digest — plus the counts and the
    names of any cases that failed. The digest is what makes two runs comparable at all.
``fixture_packs``
    The digest of every fixture pack the bundle carried, so "which seed data was this proved
    against" is answerable months later.

**A status is derived, never asserted.** :func:`build_attestation_block` computes ``status`` from
the conformance counts: ``verified`` only when a corpus actually ran and every case passed,
``failed`` when any case failed, and ``missing`` when no corpus ran at all. A non-verified status
always carries a ``reason_code`` from the closed taxonomy below, because the acceptance criterion
is that a missing or failed mock verification is *explicit* — a release proof with no mock block is
indistinguishable from one whose mock verification was quietly skipped, and this document exists to
remove that ambiguity.

**The record is deterministic.** No wall clock, no hostname, no base URL: two runs of the same
bundle on the same runtime against the same corpus produce byte-identical records. Timing belongs
to the verification run that carries the record, not to the record.

The emitted document's ``mock`` block is *exactly* the shape
``app.mock_attestation.MockAttestationInput`` accepts, so a CI job attaches it to a verification run
(``POST /v1/tenants/{tenant}/verification-runs``) without reshaping anything. That is also why the
block is snake_case where the rest of this package is camelCase: it is an evidence submission, not
a runtime document.
"""

from __future__ import annotations

from typing import Any, Mapping

from app.mock_fixture_packs import PACK_FORMAT

from apiome_mock import __version__
from apiome_mock.bundle import LoadedBundle
from apiome_mock.conformance import ConformanceReport

__all__ = [
    "REASON_CONFORMANCE_FAILED",
    "REASON_CONFORMANCE_MISSING",
    "RECORD_FORMAT",
    "RUNTIME_NAME",
    "STATUS_FAILED",
    "STATUS_MISSING",
    "STATUS_VERIFIED",
    "build_attestation_block",
    "build_verification_record",
]

#: Format id every record declares, so a consumer can tell a v1 record from a later shape.
RECORD_FORMAT = "apiome.mock.verification/v1"

#: The runtime that produces these records. Recorded explicitly rather than assumed, because the
#: reader of a release proof should not have to know which tool wrote it.
RUNTIME_NAME = "apiome-mock"

#: A corpus ran and every case passed.
STATUS_VERIFIED = "verified"
#: A corpus ran and at least one case failed.
STATUS_FAILED = "failed"
#: No corpus ran, so nothing about this bundle's behavior was proved.
STATUS_MISSING = "missing"

#: Reason recorded when the corpus ran and cases failed.
REASON_CONFORMANCE_FAILED = "mock-conformance-failed"
#: Reason recorded when no conformance result was produced at all.
REASON_CONFORMANCE_MISSING = "mock-conformance-missing"

#: How many failing case names travel in the record. A record is evidence, not a log: the full
#: failure detail lives in the conformance report the job also uploads.
MAX_FAILED_CASE_NAMES = 20


def _bundle_block(bundle: LoadedBundle) -> dict[str, Any]:
    """Describe the served bundle by its immutable identity.

    Args:
        bundle: The verified bundle the runtime served.

    Returns:
        ``{"digest", "format", "format_version", "signed", "api"}``. ``api`` is the manifest's own
        coordinate block, rendered snake_case so it matches the evidence submission shape.
    """
    manifest = bundle.manifest if isinstance(bundle.manifest, Mapping) else {}
    api = bundle.api
    return {
        "digest": bundle.digest,
        "format": str(manifest.get("bundleFormat") or ""),
        "format_version": manifest.get("bundleFormatVersion"),
        "signed": bool(bundle.signed),
        "api": {
            "tenant": str(api.get("tenant") or ""),
            "project": str(api.get("project") or ""),
            "version": str(api.get("version") or ""),
            "revision_id": str(api.get("revisionId") or ""),
            "published": bool(api.get("published")),
            "protocol": api.get("protocol"),
        },
    }


def _runtime_block(image: str | None) -> dict[str, Any]:
    """Describe the runtime that served the bundle.

    Args:
        image: Container image reference the job ran, when it ran one. Pin a digest in CI; a
            floating tag identifies nothing.

    Returns:
        ``{"name", "version", "image"}``.
    """
    return {
        "name": RUNTIME_NAME,
        "version": __version__,
        "image": image.strip() if isinstance(image, str) and image.strip() else None,
    }


def _conformance_block(report: ConformanceReport) -> dict[str, Any]:
    """Describe one conformance run: which corpus, and how it went.

    Args:
        report: The corpus report.

    Returns:
        The conformance block, with corpus identity, counts, and the failing case names (bounded by
        :data:`MAX_FAILED_CASE_NAMES`).
    """
    identity = report.corpus or {}
    failed = [result.name for result in report.failed]
    return {
        "corpus_format": str(identity.get("format") or ""),
        "corpus_version": str(identity.get("version") or "") or None,
        "corpus_digest": str(identity.get("digest") or ""),
        "corpus_case_count": identity.get("caseCount"),
        "total": len(report.results),
        "passed": len(report.results) - len(report.failed),
        "failed": len(report.failed),
        "failed_cases": failed[:MAX_FAILED_CASE_NAMES],
    }


def _fixture_pack_blocks(bundle: LoadedBundle) -> list[dict[str, Any]]:
    """Describe every fixture pack the bundle carried, name-sorted for determinism.

    Args:
        bundle: The verified bundle.

    Returns:
        One entry per pack: name, digest, format, format version, origin, and redaction status.
        Never resource bodies — a release proof records what data was used, not the data.
    """
    blocks: list[dict[str, Any]] = []
    for name in sorted(bundle.fixture_packs):
        pack = bundle.fixture_packs[name]
        blocks.append(
            {
                "name": pack.name,
                "digest": pack.digest,
                "format": PACK_FORMAT,
                "format_version": pack.format_version,
                "origin": pack.origin,
                "redaction_status": pack.redaction_status,
            }
        )
    return blocks


def build_attestation_block(
    bundle: LoadedBundle,
    report: ConformanceReport | None = None,
    *,
    image: str | None = None,
) -> dict[str, Any]:
    """Build the mock attestation block for one bundle and (optionally) one conformance run.

    The status is derived from the report rather than taken from the caller, so a job cannot record
    a verified mock over a red corpus:

    * no report at all → ``missing`` / ``mock-conformance-missing``;
    * a report with failures → ``failed`` / ``mock-conformance-failed``;
    * a report with none → ``verified``.

    Args:
        bundle: The verified bundle the runtime served.
        report: The conformance report, when a corpus was run. ``None`` records an explicitly
            missing verification rather than an absent one.
        image: Container image reference the runtime ran as, when the job knows it.

    Returns:
        The attestation block, ready to attach to a verification run as its ``mock`` field.
    """
    conformance = _conformance_block(report) if report is not None else None
    if conformance is None:
        status = STATUS_MISSING
        reason_code: str | None = REASON_CONFORMANCE_MISSING
        reason: str | None = "No conformance corpus was run against this runtime, so its behavior is unproved."
    elif conformance["failed"]:
        status = STATUS_FAILED
        reason_code = REASON_CONFORMANCE_FAILED
        reason = f"{conformance['failed']} of {conformance['total']} conformance cases failed: " + ", ".join(
            conformance["failed_cases"]
        )
    else:
        status = STATUS_VERIFIED
        reason_code = None
        reason = None

    return {
        "status": status,
        "reason_code": reason_code,
        "reason": reason,
        "bundle": _bundle_block(bundle),
        "runtime": _runtime_block(image),
        "conformance": conformance,
        "fixture_packs": _fixture_pack_blocks(bundle),
    }


def build_verification_record(
    bundle: LoadedBundle,
    report: ConformanceReport | None = None,
    *,
    image: str | None = None,
) -> dict[str, Any]:
    """Wrap an attestation block in the self-describing record document.

    Args:
        bundle: The verified bundle the runtime served.
        report: The conformance report, when a corpus was run.
        image: Container image reference the runtime ran as, when the job knows it.

    Returns:
        ``{"record_format": "apiome.mock.verification/v1", "mock": {...}}`` — the ``mock`` value is
        exactly the block a verification run accepts, so a CI job can merge it into an evidence
        submission without reshaping it.
    """
    return {
        "record_format": RECORD_FORMAT,
        "mock": build_attestation_block(bundle, report, image=image),
    }
