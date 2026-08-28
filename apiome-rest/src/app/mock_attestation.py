"""Release-proof mock attestation — PMR-3.2 (#4749).

A release proof may say "this version's mock passed" only if it can say **which mock**. This module
owns the block that makes that possible: the mock attestation a verification run carries, attaching
the four identities that turn a claim into evidence —

* the **bundle digest** (PMR-1.1) — the immutable identity of what was served;
* the **runtime version** (PMR-1.2) — which apiome-mock produced the behavior;
* the **conformance result** (PMR-3.1) — the corpus that was executed, by digest, and how it went;
* the **fixture-pack digests** (PMR-2.2) — which seed data the behavior was proved against.

Four rules hold the block together, each one an acceptance criterion turned into a refusal rather
than a convention:

**Only immutable digests are linked.** ``bundle.digest`` must be ``sha256:<64 hex>`` — the form
:func:`app.mock_bundle.manifest_digest` produces — and the pinned revision must be published and
carry a revision id. A draft revision can still change; a digest that names one proves nothing
later, so :data:`CODE_BUNDLE_MUTABLE` refuses it. Fixture-pack digests are held to the same shape.

**A verification names its runtime and its corpus.** ``runtime.version`` must parse as a semantic
version inside the bundle format's declared runtime window (:data:`app.mock_bundle.MIN_RUNTIME_VERSION`
… :data:`app.mock_bundle.MAX_RUNTIME_VERSION`), and a conformance result must carry the corpus
digest that identifies what was run. "It passed" with no corpus behind it is not a result.

**The status is derived, never asserted.** :func:`derive_mock_status` computes ``verified`` /
``failed`` / ``missing`` from the conformance counts, mirroring the ECA-1.3 rule that a verdict
comes from the records. A submitted ``status`` that disagrees is refused, so no upload can record a
verified mock over a red corpus.

**A non-verified verification is explicit.** Every non-``verified`` status carries a
``reason_code`` from the closed taxonomy below. And when a run executed against a ``mock``
environment without attaching any attestation at all,
:func:`missing_mock_attestation` writes the *absence* down as
:data:`REASON_ATTESTATION_MISSING` — a release proof whose mock block is simply not there cannot be
told apart from one whose mock verification was skipped, and that ambiguity is exactly what this
issue removes.

The statement builders at the bottom render a stored attestation as an **in-toto Statement v1** in a
DSSE envelope, signed by :mod:`app.lint_attestation` with the shared attestation secret and the same
key id as the lint and delivery flavours — so a self-hosted verifier that already holds that secret
verifies a mock attestation with no new configuration and ~10 lines of stdlib code.

This module never touches the database. :mod:`app.verification_evidence` embeds its models in the
run contract, :mod:`app.verification_evidence_store` persists them, and
:mod:`app.verification_evidence_routes` exposes them. It deliberately imports nothing from
:mod:`app.verification_evidence` — the dependency runs one way only — so its refusals are raised as
:class:`MockAttestationError` and translated into the evidence taxonomy by
:func:`app.verification_evidence.validate_mock_attestation_input`, the single seam every evidence
caller goes through, so one exception type and one set of codes still reach the route and the CLI.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .intake_secret_scrub import scrub_message
from .lint_attestation import (
    CONTENT_DIGEST_ALGORITHM,
    PAYLOAD_TYPE,
    STATEMENT_TYPE,
    attestation_envelope,
)
from .mock_bundle import MAX_RUNTIME_VERSION, MIN_RUNTIME_VERSION

__all__ = [
    "ATTESTATION_KEY_ID",
    "CODE_BUNDLE_DIGEST_INVALID",
    "CODE_BUNDLE_MUTABLE",
    "CODE_CONFORMANCE_COUNTS_MISMATCH",
    "CODE_CORPUS_UNIDENTIFIED",
    "CODE_FIXTURE_DIGEST_INVALID",
    "CODE_REASON_REQUIRED",
    "CODE_RUNTIME_INCOMPATIBLE",
    "CODE_RUNTIME_VERSION_INVALID",
    "CODE_STATUS_INVALID",
    "CODE_STATUS_MISMATCH",
    "DIGEST_PATTERN",
    "MOCK_PREDICATE_TYPE",
    "MOCK_STATUSES",
    "MOCK_STATUS_FAILED",
    "MOCK_STATUS_MISSING",
    "MOCK_STATUS_VERIFIED",
    "PAYLOAD_TYPE",
    "REASON_ATTESTATION_MISSING",
    "REASON_CODES",
    "REASON_CONFORMANCE_FAILED",
    "REASON_CONFORMANCE_MISSING",
    "MockAttestationError",
    "MockAttestationInput",
    "MockAttestationRecord",
    "MockBundleApi",
    "MockBundleRef",
    "MockConformanceResult",
    "MockFixturePackRef",
    "MockRuntimeRef",
    "attestation_from_row",
    "build_mock_attestation_statement",
    "derive_mock_status",
    "missing_mock_attestation",
    "mock_attestation_envelope",
    "validate_mock_attestation",
]

# ---------------------------------------------------------------------------------------------
# Vocabularies (mirror the V249 CHECK constraints)
# ---------------------------------------------------------------------------------------------

#: A corpus ran against the pinned bundle and every case passed.
MOCK_STATUS_VERIFIED = "verified"
#: A corpus ran and at least one case failed.
MOCK_STATUS_FAILED = "failed"
#: Nothing was proved — no corpus ran, or no attestation was attached at all.
MOCK_STATUS_MISSING = "missing"

#: The closed status vocabulary. Three values, because a release proof needs to distinguish "proved
#: good" from "proved bad" from "not proved" — collapsing the last two loses the only distinction
#: that matters when a gate is deciding whether to trust the evidence.
MOCK_STATUSES = (MOCK_STATUS_VERIFIED, MOCK_STATUS_FAILED, MOCK_STATUS_MISSING)

#: The corpus ran and cases failed.
REASON_CONFORMANCE_FAILED = "mock-conformance-failed"
#: An attestation was attached, but no conformance corpus was run against the runtime.
REASON_CONFORMANCE_MISSING = "mock-conformance-missing"
#: A run executed against a ``mock`` environment and attached no attestation at all.
REASON_ATTESTATION_MISSING = "mock-attestation-missing"

#: Every reason a non-``verified`` status may state. Closed, so a gate branches on the code rather
#: than parsing prose.
REASON_CODES = (
    REASON_CONFORMANCE_FAILED,
    REASON_CONFORMANCE_MISSING,
    REASON_ATTESTATION_MISSING,
)

#: The digest form every linked artifact uses — the same shape ``manifestDigest`` and a fixture
#: pack digest already take. Anything else is not a digest this platform produced.
DIGEST_PATTERN = r"^sha256:[0-9a-f]{64}$"

#: in-toto predicate type of a mock attestation. A distinct type from the lint-gate and
#: export-delivery flavours, because the predicate body is a different shape — which is precisely
#: what in-toto predicate types are for.
MOCK_PREDICATE_TYPE = "https://apiome.dev/attestations/mock-runtime/v1"

#: Key id on the DSSE signature. A mock attestation is signed with the *same* shared secret as a
#: lint gate attestation, so it names the same key: a verifier that already holds the CLX-4.2
#: secret verifies one with no new configuration.
ATTESTATION_KEY_ID = "apiome-lint-hmac-v1"

#: Stored length ceiling for the human-readable reason. Long enough for a list of failing case
#: names, short enough that evidence cannot become a log sink.
REASON_TEXT_LIMIT = 1000

#: How many failing case names a conformance result may carry. The full detail lives in the run's
#: own case records; this is the summary a reader sees first.
MAX_FAILED_CASE_NAMES = 20

_DIGEST_RE = re.compile(DIGEST_PATTERN)
_SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)")

# ---------------------------------------------------------------------------------------------
# Error taxonomy — stable codes a CLI, a UI, and a gate can all branch on
# ---------------------------------------------------------------------------------------------

#: The bundle digest is not ``sha256:<64 hex>``.
CODE_BUNDLE_DIGEST_INVALID = "mock-bundle-digest-invalid"
#: The attested bundle pins a revision that can still change (unpublished, or no revision id).
CODE_BUNDLE_MUTABLE = "mock-bundle-mutable"
#: The runtime version does not parse as a semantic version.
CODE_RUNTIME_VERSION_INVALID = "mock-runtime-version-invalid"
#: The runtime version falls outside the bundle format's supported runtime window.
CODE_RUNTIME_INCOMPATIBLE = "mock-runtime-incompatible"
#: A conformance result arrived without the corpus digest that says what was run.
CODE_CORPUS_UNIDENTIFIED = "mock-corpus-unidentified"
#: A conformance result's passed/failed counts do not sum to its total.
CODE_CONFORMANCE_COUNTS_MISMATCH = "mock-conformance-counts-mismatch"
#: A declared status contradicts the one the conformance counts imply.
CODE_STATUS_MISMATCH = "mock-status-mismatch"
#: A status outside :data:`MOCK_STATUSES`, or a reason code outside :data:`REASON_CODES`.
CODE_STATUS_INVALID = "mock-status-invalid"
#: A fixture-pack digest is not ``sha256:<64 hex>``.
CODE_FIXTURE_DIGEST_INVALID = "mock-fixture-digest-invalid"
#: A non-verified status arrived with no reason code to explain it.
CODE_REASON_REQUIRED = "mock-reason-required"


class MockAttestationError(ValueError):
    """A submitted mock attestation was refused — with a stable machine code.

    Subclasses ``ValueError`` so a call site that already maps ``ValueError`` onto a 4xx keeps
    working. :mod:`app.verification_evidence` translates it into an ``EvidenceValidationError``
    carrying the same code, so evidence callers still see exactly one exception type and one
    taxonomy.

    Attributes:
        code: One of this module's ``CODE_*`` constants.
    """

    def __init__(self, code: str, message: str) -> None:
        """Build the error.

        Args:
            code: Stable taxonomy code.
            message: Human-readable, secret-free explanation.
        """
        super().__init__(message)
        self.code = code


def _redact(value: Optional[str], limit: int = REASON_TEXT_LIMIT) -> Optional[str]:
    """Scrub credentials out of free text and bound its length.

    A runner's reason quotes what it saw, and what it saw may be a token echoed in a response body.
    Truncation happens after scrubbing, so a secret cannot survive by sitting past the cut.

    Args:
        value: The text; ``None`` passes through.
        limit: Maximum stored length.

    Returns:
        The redacted, bounded text, or ``None``.
    """
    if value is None:
        return None
    scrubbed = scrub_message(value) or ""
    if len(scrubbed) <= limit:
        return scrubbed
    return scrubbed[:limit] + "…"


def _parse_version(text: str) -> Optional[Tuple[int, int, int]]:
    """Parse the leading ``major.minor.patch`` of a version string.

    Args:
        text: The version string (a pre-release suffix is ignored).

    Returns:
        The ``(major, minor, patch)`` tuple, or ``None`` when it does not parse.
    """
    match = _SEMVER_RE.match(text.strip())
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


# ---------------------------------------------------------------------------------------------
# The block's parts
# ---------------------------------------------------------------------------------------------


class MockBundleApi(BaseModel):
    """The API coordinates the attested bundle pins — the manifest's own ``api`` block."""

    model_config = ConfigDict(extra="forbid")

    tenant: str = Field(description="Tenant slug the bundle was exported for.", max_length=200)
    project: str = Field(description="Project slug.", max_length=200)
    version: str = Field(description="Version label the bundle pins.", max_length=200)
    revision_id: str = Field(
        default="",
        description=(
            "The immutable `versions.id` of the pinned revision. Required for a linkable "
            "attestation: without it the digest names no fixed revision."
        ),
        max_length=100,
    )
    published: bool = Field(
        default=False,
        description=(
            "Whether the pinned revision was published. A draft can still change, so an "
            "attestation over one is refused."
        ),
    )
    protocol: Optional[str] = Field(
        default=None, description="Protocol/paradigm label (e.g. `openapi`).", max_length=50
    )


class MockBundleRef(BaseModel):
    """The immutable identity of the served bundle."""

    model_config = ConfigDict(extra="forbid")

    digest: str = Field(
        description="The bundle's `manifestDigest` (`sha256:<hex>`) — what the proof links.",
        max_length=100,
    )
    format: Optional[str] = Field(
        default=None, description="Bundle format id (`apiome.mock.bundle/v1`).", max_length=100
    )
    format_version: Optional[int] = Field(
        default=None, ge=0, description="Additive revision of the bundle format."
    )
    signed: bool = Field(
        default=False, description="Whether the bundle carried a manifest signature."
    )
    api: MockBundleApi = Field(description="The API coordinates the bundle pins.")


class MockRuntimeRef(BaseModel):
    """Which runtime served the bundle."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        default="apiome-mock", description="Runtime that served the bundle.", max_length=100
    )
    version: str = Field(
        description="Runtime version (semantic). A conformance pass means nothing without it.",
        max_length=100,
    )
    image: Optional[str] = Field(
        default=None,
        description=(
            "Container image reference the runtime ran as. Pin a digest in CI; a floating tag "
            "identifies nothing."
        ),
        max_length=500,
    )


class MockConformanceResult(BaseModel):
    """What the shared conformance corpus (PMR-3.1) said about the running runtime."""

    model_config = ConfigDict(extra="forbid")

    corpus_format: Optional[str] = Field(
        default=None, description="Corpus format id (`apiome.mock.conformance/v1`).", max_length=100
    )
    corpus_version: Optional[str] = Field(
        default=None, description="Version label the corpus document declared.", max_length=100
    )
    corpus_digest: str = Field(
        description=(
            "`sha256:<hex>` over the corpus document's canonical JSON — the identity that makes "
            "two conformance results comparable."
        ),
        max_length=100,
    )
    corpus_case_count: Optional[int] = Field(
        default=None, ge=0, description="How many cases the corpus declared."
    )
    total: int = Field(ge=0, description="Cases executed.")
    passed: int = Field(ge=0, description="Cases that passed.")
    failed: int = Field(ge=0, description="Cases that failed.")
    failed_cases: List[str] = Field(
        default_factory=list,
        description=f"Names of failing cases (at most {MAX_FAILED_CASE_NAMES}).",
    )

    @field_validator("failed_cases")
    @classmethod
    def _bound_failed_cases(cls, value: List[str]) -> List[str]:
        """Bound and redact the failing case names — evidence, not a log."""
        return [_redact(str(name), 200) or "" for name in value[:MAX_FAILED_CASE_NAMES]]


class MockFixturePackRef(BaseModel):
    """One fixture pack the attested bundle carried, by digest."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="Pack name.", max_length=100)
    digest: str = Field(
        description="`sha256:<hex>` over the pack's canonical content.", max_length=100
    )
    format: Optional[str] = Field(
        default=None, description="Pack format id.", max_length=100
    )
    format_version: Optional[int] = Field(
        default=None, ge=0, description="Declared `packFormatVersion`."
    )
    origin: Optional[str] = Field(
        default=None,
        description="`authored` or `capture` (PMR-2.4), so replayed data says where it came from.",
        max_length=50,
    )
    redaction_status: Optional[str] = Field(
        default=None,
        description="`not-applicable`, `clean`, or `redacted` for a captured pack.",
        max_length=50,
    )


class MockAttestationInput(BaseModel):
    """The mock attestation a runner attaches to a verification run.

    This is exactly the shape ``apiome-mock attest`` emits under its ``mock`` key, so a CI job
    merges the record into its evidence submission without reshaping anything.
    """

    model_config = ConfigDict(extra="forbid")

    bundle: MockBundleRef = Field(description="The immutable identity of the served bundle.")
    runtime: MockRuntimeRef = Field(description="The runtime that served it.")
    conformance: Optional[MockConformanceResult] = Field(
        default=None,
        description=(
            "The conformance result. `null` records an explicitly unverified mock — a status of "
            "`missing` with a stated reason, never silence."
        ),
    )
    fixture_packs: List[MockFixturePackRef] = Field(
        default_factory=list, description="Digest of every fixture pack the bundle carried."
    )
    status: Optional[str] = Field(
        default=None,
        description=(
            "Optional declared status. It is *checked* against the status derived from the "
            "conformance result and refused when it disagrees."
        ),
    )
    reason_code: Optional[str] = Field(
        default=None,
        description=f"Why the mock is not verified. One of: {', '.join(REASON_CODES)}.",
        max_length=100,
    )
    reason: Optional[str] = Field(
        default=None, description="Human-readable explanation, scrubbed for credentials."
    )


class MockAttestationRecord(BaseModel):
    """A stored mock attestation, as every reader and both exporters see it.

    ``bundle`` and ``runtime`` are optional here but required on the input: a record whose status is
    ``missing`` because *no attestation was attached* has neither, and writing that absence down is
    the point (see :func:`missing_mock_attestation`).
    """

    model_config = ConfigDict(extra="forbid")

    status: str = Field(description=f"One of: {', '.join(MOCK_STATUSES)}.")
    reason_code: Optional[str] = Field(
        default=None, description="Why the mock is not verified; `null` only when verified."
    )
    reason: Optional[str] = Field(default=None, description="Human-readable explanation.")
    bundle: Optional[MockBundleRef] = Field(
        default=None, description="The attested bundle; absent when no attestation was attached."
    )
    runtime: Optional[MockRuntimeRef] = Field(
        default=None, description="The runtime; absent when no attestation was attached."
    )
    conformance: Optional[MockConformanceResult] = Field(
        default=None, description="The conformance result; absent when no corpus ran."
    )
    fixture_packs: List[MockFixturePackRef] = Field(
        default_factory=list, description="Fixture packs the bundle carried."
    )


# ---------------------------------------------------------------------------------------------
# Derivation — the status comes from the result, not from the claim
# ---------------------------------------------------------------------------------------------


def derive_mock_status(
    conformance: Optional[MockConformanceResult],
) -> Tuple[str, Optional[str], Optional[str]]:
    """The status a conformance result implies, with the reason that must accompany it.

    Args:
        conformance: The submitted conformance result, or ``None`` when no corpus ran.

    Returns:
        ``(status, reason_code, reason)``. ``reason_code`` and ``reason`` are ``None`` only for
        ``verified``; every other status states why.
    """
    if conformance is None:
        return (
            MOCK_STATUS_MISSING,
            REASON_CONFORMANCE_MISSING,
            "No conformance corpus was run against this runtime, so its behavior is unproved.",
        )
    if conformance.failed > 0:
        names = ", ".join(conformance.failed_cases)
        detail = f": {names}" if names else "."
        return (
            MOCK_STATUS_FAILED,
            REASON_CONFORMANCE_FAILED,
            f"{conformance.failed} of {conformance.total} conformance cases failed{detail}",
        )
    if conformance.total == 0:
        return (
            MOCK_STATUS_MISSING,
            REASON_CONFORMANCE_MISSING,
            "The conformance corpus executed no cases, so nothing was proved.",
        )
    return MOCK_STATUS_VERIFIED, None, None


def _require_digest(value: str, *, code: str, what: str) -> str:
    """Return ``value`` when it is a ``sha256:<64 hex>`` digest, else refuse.

    Args:
        value: The submitted digest.
        code: Taxonomy code to raise.
        what: What the digest names, for the message.

    Returns:
        The digest, stripped.

    Raises:
        MockAttestationError: When the shape is wrong.
    """
    digest = (value or "").strip()
    if not _DIGEST_RE.match(digest):
        raise MockAttestationError(
            code,
            f"{what} must be a sha256:<hex> digest; a release proof links only immutable digests",
        )
    return digest


def _validate_runtime(runtime: MockRuntimeRef) -> None:
    """Refuse a runtime that cannot be identified, or that no bundle of this format supports.

    Args:
        runtime: The submitted runtime reference.

    Raises:
        MockAttestationError: ``mock-runtime-version-invalid`` when the version does not parse;
            ``mock-runtime-incompatible`` when it falls outside the bundle format's runtime window.
    """
    parsed = _parse_version(runtime.version)
    if parsed is None:
        raise MockAttestationError(
            CODE_RUNTIME_VERSION_INVALID,
            f"runtime version {runtime.version!r} is not a semantic version; a conformance "
            "result is meaningless without the runtime that produced it",
        )
    minimum = _parse_version(MIN_RUNTIME_VERSION)
    maximum = _parse_version(MAX_RUNTIME_VERSION)
    if minimum is not None and parsed < minimum:
        raise MockAttestationError(
            CODE_RUNTIME_INCOMPATIBLE,
            f"runtime {runtime.version} predates the oldest runtime that understands this bundle "
            f"format ({MIN_RUNTIME_VERSION})",
        )
    if maximum is not None and parsed >= maximum:
        raise MockAttestationError(
            CODE_RUNTIME_INCOMPATIBLE,
            f"runtime {runtime.version} is at or beyond {MAX_RUNTIME_VERSION}, which this bundle "
            "format does not claim to support",
        )


def _validate_conformance(conformance: MockConformanceResult) -> None:
    """Refuse a conformance result that cannot be identified or does not add up.

    Args:
        conformance: The submitted result.

    Raises:
        MockAttestationError: ``mock-corpus-unidentified`` or ``mock-conformance-counts-mismatch``.
    """
    _require_digest(
        conformance.corpus_digest,
        code=CODE_CORPUS_UNIDENTIFIED,
        what="the conformance corpus digest",
    )
    if conformance.passed + conformance.failed != conformance.total:
        raise MockAttestationError(
            CODE_CONFORMANCE_COUNTS_MISMATCH,
            f"conformance counts do not sum: {conformance.passed} passed + "
            f"{conformance.failed} failed != {conformance.total} total",
        )
    if conformance.failed > 0 and not conformance.failed_cases:
        # A failure with no case named cannot be acted on, and a gate reading it can only guess.
        raise MockAttestationError(
            CODE_CONFORMANCE_COUNTS_MISMATCH,
            "a conformance result with failures must name at least one failing case",
        )


def validate_mock_attestation(attestation: MockAttestationInput) -> MockAttestationRecord:
    """Check one submitted attestation and return the record that will be stored.

    Order matters: the cheap structural refusals first (digest shapes, mutable revision), then the
    runtime and corpus identities, and only then the derived status. A submission that is wrong in a
    cheap way never reaches the derivation.

    Args:
        attestation: The submitted block.

    Returns:
        The record, with ``status``/``reason_code``/``reason`` **derived** from the conformance
        result and every free-text field scrubbed.

    Raises:
        MockAttestationError: with the code naming which rule failed.
    """
    bundle = attestation.bundle
    digest = _require_digest(
        bundle.digest, code=CODE_BUNDLE_DIGEST_INVALID, what="the mock bundle digest"
    )
    if not bundle.api.revision_id.strip() or not bundle.api.published:
        raise MockAttestationError(
            CODE_BUNDLE_MUTABLE,
            "a release proof links only immutable bundles: the attested bundle must pin a "
            "published revision by id",
        )

    _validate_runtime(attestation.runtime)

    if attestation.conformance is not None:
        _validate_conformance(attestation.conformance)

    for pack in attestation.fixture_packs:
        _require_digest(
            pack.digest,
            code=CODE_FIXTURE_DIGEST_INVALID,
            what=f"fixture pack {pack.name!r} digest",
        )

    status, reason_code, reason = derive_mock_status(attestation.conformance)
    if attestation.status is not None:
        if attestation.status not in MOCK_STATUSES:
            raise MockAttestationError(
                CODE_STATUS_INVALID,
                f"status must be one of {', '.join(MOCK_STATUSES)}",
            )
        if attestation.status != status:
            raise MockAttestationError(
                CODE_STATUS_MISMATCH,
                f"declared status {attestation.status!r} contradicts the conformance result, "
                f"which implies {status!r}",
            )
    if attestation.reason_code is not None and attestation.reason_code not in REASON_CODES:
        raise MockAttestationError(
            CODE_STATUS_INVALID,
            f"reason_code must be one of {', '.join(REASON_CODES)}",
        )
    if status != MOCK_STATUS_VERIFIED and reason_code is None:  # pragma: no cover - unreachable
        # Belt and braces: derive_mock_status never returns a bare non-verified status, and a
        # future edit that broke that would otherwise store an unexplained one.
        raise MockAttestationError(
            CODE_REASON_REQUIRED, "a mock that is not verified must state why"
        )

    return MockAttestationRecord(
        status=status,
        reason_code=reason_code,
        # A reason travels with a reason code. Keeping a submitted explanation on a *verified*
        # record would leave prose with nothing to explain, which a reader can only misread.
        reason=None if reason_code is None else (_redact(attestation.reason) or reason),
        bundle=bundle.model_copy(update={"digest": digest}),
        runtime=attestation.runtime,
        conformance=attestation.conformance,
        fixture_packs=list(attestation.fixture_packs),
    )


def missing_mock_attestation(
    reason: Optional[str] = None,
) -> MockAttestationRecord:
    """The record written when a mock-targeted run attached no attestation at all.

    This is the acceptance criterion "missing mock verification is explicit" made structural: rather
    than storing nothing — which reads identically to a run that never involved a mock — the
    evidence stores a ``missing`` status naming :data:`REASON_ATTESTATION_MISSING`.

    Args:
        reason: Optional human-readable explanation; a default is used when omitted.

    Returns:
        The record. It has no ``bundle`` and no ``runtime``, because there is no bundle or runtime
        it could honestly name.
    """
    return MockAttestationRecord(
        status=MOCK_STATUS_MISSING,
        reason_code=REASON_ATTESTATION_MISSING,
        reason=_redact(reason)
        or (
            "This run executed against a mock environment but attached no mock attestation, so "
            "the mock it used cannot be identified."
        ),
    )


# ---------------------------------------------------------------------------------------------
# Storage adaptation
# ---------------------------------------------------------------------------------------------


def _mapping(value: Any) -> Dict[str, Any]:
    """Return a JSONB column as a dict, tolerating a row that stored something else."""
    return dict(value) if isinstance(value, Mapping) else {}


def attestation_from_row(row: Mapping[str, Any]) -> MockAttestationRecord:
    """Adapt a ``verification_run_mock`` row into a :class:`MockAttestationRecord`.

    Args:
        row: The database row.

    Returns:
        The record. The bundle and runtime blocks are rebuilt only when the row actually names one,
        so an explicitly-missing attestation reads back as explicitly missing.
    """
    bundle: Optional[MockBundleRef] = None
    if row.get("bundle_digest"):
        api = _mapping(row.get("bundle_api"))
        bundle = MockBundleRef(
            digest=str(row.get("bundle_digest")),
            format=row.get("bundle_format"),
            format_version=row.get("bundle_format_version"),
            signed=bool(row.get("bundle_signed")),
            api=MockBundleApi(
                tenant=str(api.get("tenant") or ""),
                project=str(api.get("project") or ""),
                version=str(api.get("version") or ""),
                revision_id=str(api.get("revision_id") or ""),
                published=bool(api.get("published")),
                protocol=api.get("protocol"),
            ),
        )

    runtime: Optional[MockRuntimeRef] = None
    if row.get("runtime_version"):
        runtime = MockRuntimeRef(
            name=str(row.get("runtime_name") or "apiome-mock"),
            version=str(row.get("runtime_version")),
            image=row.get("runtime_image"),
        )

    conformance: Optional[MockConformanceResult] = None
    if row.get("corpus_digest"):
        conformance = MockConformanceResult(
            corpus_format=row.get("corpus_format"),
            corpus_version=row.get("corpus_version"),
            corpus_digest=str(row.get("corpus_digest")),
            corpus_case_count=row.get("corpus_case_count"),
            total=int(row.get("conformance_total") or 0),
            passed=int(row.get("conformance_passed") or 0),
            failed=int(row.get("conformance_failed") or 0),
            failed_cases=[
                str(name)
                for name in (
                    row["failed_cases"] if isinstance(row.get("failed_cases"), list) else []
                )
            ],
        )

    packs = row.get("fixture_packs")
    fixture_packs = [
        MockFixturePackRef(
            name=str(entry.get("name") or ""),
            digest=str(entry.get("digest") or ""),
            format=entry.get("format"),
            format_version=entry.get("format_version"),
            origin=entry.get("origin"),
            redaction_status=entry.get("redaction_status"),
        )
        for entry in (packs if isinstance(packs, list) else [])
        if isinstance(entry, Mapping)
    ]

    return MockAttestationRecord(
        status=str(row.get("status") or MOCK_STATUS_MISSING),
        reason_code=row.get("reason_code"),
        reason=row.get("reason"),
        bundle=bundle,
        runtime=runtime,
        conformance=conformance,
        fixture_packs=fixture_packs,
    )


# ---------------------------------------------------------------------------------------------
# in-toto statement — what self-hosted verification tooling consumes
# ---------------------------------------------------------------------------------------------


def build_mock_attestation_statement(
    record: MockAttestationRecord,
    *,
    run: Mapping[str, Any],
    generated_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Build the in-toto Statement v1 for one stored mock attestation.

    The subject is the **bundle itself**, named by its digest under the plain ``sha256`` algorithm,
    so a holder of the bundle file can tie it to this statement with ``sha256sum`` alone. A record
    with no bundle — one that says its verification is missing — has no subject to name, and emits
    an empty subject list rather than inventing one: the statement still exists and still says, in
    signed form, that the mock was not verified.

    The predicate carries identities and verdicts only: bundle coordinates, runtime, corpus, counts,
    fixture-pack digests, and the verification run the attestation belongs to. Never spec text,
    fixture bodies, or credentials.

    Args:
        record: The stored attestation.
        run: The verification run it belongs to — ``id``, ``suite_digest``, ``outcome``,
            ``target_slug``, ``target_environment``, ``started_at``, ``finished_at``.
        generated_at: Statement timestamp; defaults to now (UTC). Pass a fixed value for
            deterministic output in tests.

    Returns:
        An in-toto Statement v1 dict (unsigned) — wrap it with :func:`mock_attestation_envelope`.
    """
    subjects: List[Dict[str, Any]] = []
    if record.bundle is not None:
        api = record.bundle.api
        subjects.append(
            {
                "name": f"{api.tenant}/{api.project}/{api.version}",
                "digest": {CONTENT_DIGEST_ALGORITHM: record.bundle.digest.split(":", 1)[-1]},
            }
        )

    stamp = (generated_at or datetime.now(timezone.utc)).isoformat()
    return {
        "_type": STATEMENT_TYPE,
        "subject": subjects,
        "predicateType": MOCK_PREDICATE_TYPE,
        "predicate": {
            "status": record.status,
            "reasonCode": record.reason_code,
            "reason": record.reason,
            "bundle": record.bundle.model_dump(mode="json") if record.bundle else None,
            "runtime": record.runtime.model_dump(mode="json") if record.runtime else None,
            "conformance": (
                record.conformance.model_dump(mode="json") if record.conformance else None
            ),
            "fixturePacks": [pack.model_dump(mode="json") for pack in record.fixture_packs],
            "verificationRun": dict(run),
            "generatedAt": stamp,
        },
    }


def mock_attestation_envelope(
    statement: Mapping[str, Any], *, secret: Optional[str] = None
) -> Dict[str, Any]:
    """Wrap a mock attestation statement in a DSSE envelope, signed when a secret is configured.

    Args:
        statement: Output of :func:`build_mock_attestation_statement`.
        secret: The shared HMAC secret; ``None`` emits a well-formed but unsigned envelope.

    Returns:
        ``{"payloadType", "payload", "signatures"}`` — identical in construction to a lint gate
        attestation, so one verifier covers all three flavours.
    """
    return attestation_envelope(statement, secret=secret, key_id=ATTESTATION_KEY_ID)
