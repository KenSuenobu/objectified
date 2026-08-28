"""The verification-evidence contract — ECA-1.3 (#4731).

A contract run ends, today, as runner output: a log, a console scrollback, maybe a JUnit file in a
CI artifact bucket. None of that can be queried, compared across runs, or pointed at by a gate.
This module owns the record that replaces it — a **normalized, immutable** account of one execution
— as a pure, database-free contract:

* :class:`VerificationRunInput` — what a runner submits when a run finishes;
* :class:`OperationResultInput` / :class:`AssertionInput` — the per-case and per-check detail that
  makes "it failed" into "``GET /pets/{petId}`` returned 500 where the contract declares 200";
* :class:`ArtifactReferenceInput` — a *link* to a redacted artifact, never the artifact;
* :class:`VerificationRunRecord` and friends — stored evidence, as every reader (and both exporters)
  sees it;
* the optional ``mock`` block (:mod:`app.mock_attestation`, PMR-3.2) — the immutable mock bundle
  digest, runtime version, conformance result, and fixture-pack digests that let a release proof
  claim a runnable mock, and that say so *explicitly* when it cannot.

Four invariants hold this module together, each mirrored by a CHECK constraint in apiome-db V212, so
neither layer is the only thing standing between a mistake and the evidence:

**Evidence describes one suite against one target.** A run names the ECA-1.1 manifest digest
(``sha256:<hex>``) and the ECA-1.2 target identity — snapshotted, because a target may later be
renamed, repointed, or retired and the evidence must keep saying what it meant.

**A verdict is derived, never asserted.** :func:`derive_counts` and :func:`derive_outcome` compute
the run's counts and outcome from the operation records. A submitted ``outcome`` is *checked*
against the derived one and refused when it disagrees, so no upload can record a green run over red
cases. ``cancelled`` is the single exception — a run that stopped early is a fact only the runner
knows.

**A failure always says why.** A non-passing case must carry a stable ``failure_code``, and a failed
assertion must carry a ``code``. An outcome with no stated reason is exactly the evidence that
cannot drive a gate (ECA-3.1) or be compared across runs.

**Artifacts are linked, redacted, and verifiable.** :func:`validate_artifact_uri` refuses a ``data:``
URI (that is embedding, not linking) and any URI carrying ``user:pass@``; every free-text field is
run through :func:`redact_text`, which delegates to the platform's own secret scrubber
(:func:`app.intake_secret_scrub.scrub_message`) before bounding the length.

Nothing in this module reads or writes the database; :mod:`app.verification_evidence_store` does
that, :mod:`app.verification_evidence_export` renders it as JSON and JUnit, and
:mod:`app.verification_evidence_routes` exposes it.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .intake_secret_scrub import scrub_message
from .mock_attestation import (
    MockAttestationError,
    MockAttestationInput,
    MockAttestationRecord,
    attestation_from_row,
    validate_mock_attestation,
)

__all__ = [
    "ARTIFACT_KINDS",
    "ARTIFACT_KIND_DIFF",
    "ARTIFACT_KIND_HAR",
    "ARTIFACT_KIND_LOG",
    "ARTIFACT_KIND_OTHER",
    "ARTIFACT_KIND_REPORT",
    "ARTIFACT_KIND_REQUEST",
    "ARTIFACT_KIND_RESPONSE",
    "ARTIFACT_URI_SCHEMES",
    "ASSERTION_KINDS",
    "ASSERTION_KIND_CONTENT_TYPE",
    "ASSERTION_KIND_CUSTOM",
    "ASSERTION_KIND_HEADER",
    "ASSERTION_KIND_LATENCY",
    "ASSERTION_KIND_RESPONSE_SCHEMA",
    "ASSERTION_KIND_STATUS_CODE",
    "ASSERTION_OUTCOMES",
    "AssertionInput",
    "AssertionRecord",
    "ArtifactReferenceInput",
    "ArtifactRecord",
    "CODE_ARTIFACT_EMBEDDED",
    "CODE_ARTIFACT_UNREDACTED",
    "CODE_ARTIFACT_URI_INVALID",
    "CODE_DUPLICATE_CASE",
    "CODE_EXPORT_FORMAT",
    "CODE_FAILURE_DETAIL_REQUIRED",
    "CODE_MOCK_ATTESTATION_ABSENT",
    "CODE_NO_OPERATIONS",
    "CODE_OUTCOME_MISMATCH",
    "CODE_RUN_NOT_FOUND",
    "CODE_SUITE_DIGEST_INVALID",
    "CODE_TARGET_NOT_FOUND",
    "CODE_TIMING_INVALID",
    "EvidenceValidationError",
    "FIELD_TEXT_LIMIT",
    "MESSAGE_TEXT_LIMIT",
    "MockAttestationInput",
    "MockAttestationRecord",
    "OPERATION_OUTCOMES",
    "OPERATION_OUTCOME_ERRORED",
    "OPERATION_OUTCOME_FAILED",
    "OPERATION_OUTCOME_PASSED",
    "OPERATION_OUTCOME_SKIPPED",
    "OperationRecord",
    "OperationResultInput",
    "RUN_OUTCOMES",
    "RUN_OUTCOME_CANCELLED",
    "RUN_OUTCOME_ERRORED",
    "RUN_OUTCOME_FAILED",
    "RUN_OUTCOME_PASSED",
    "SUITE_DIGEST_PATTERN",
    "VerificationRunInput",
    "VerificationRunRecord",
    "VerificationRunSummary",
    "derive_counts",
    "derive_outcome",
    "duration_ms_between",
    "record_from_rows",
    "redact_text",
    "summary_from_row",
    "validate_artifact_uri",
    "validate_mock_attestation_input",
    "validate_run_input",
]

# ---------------------------------------------------------------------------------------------
# Vocabularies (mirror the V212 CHECK constraints)
# ---------------------------------------------------------------------------------------------

RUN_OUTCOME_PASSED = "passed"
RUN_OUTCOME_FAILED = "failed"
RUN_OUTCOME_ERRORED = "errored"
RUN_OUTCOME_CANCELLED = "cancelled"

#: What a whole run concluded. ``errored`` outranks ``failed``: a run that could not execute part of
#: the suite has not shown the implementation to be compatible *or* incompatible.
RUN_OUTCOMES = (
    RUN_OUTCOME_PASSED,
    RUN_OUTCOME_FAILED,
    RUN_OUTCOME_ERRORED,
    RUN_OUTCOME_CANCELLED,
)

OPERATION_OUTCOME_PASSED = "passed"
OPERATION_OUTCOME_FAILED = "failed"
OPERATION_OUTCOME_ERRORED = "errored"
OPERATION_OUTCOME_SKIPPED = "skipped"

#: One case's outcome. ``failed`` means the implementation contradicted the contract; ``errored``
#: means the runner never got an answer to judge — a distinction a gate must be able to make.
OPERATION_OUTCOMES = (
    OPERATION_OUTCOME_PASSED,
    OPERATION_OUTCOME_FAILED,
    OPERATION_OUTCOME_ERRORED,
    OPERATION_OUTCOME_SKIPPED,
)

ASSERTION_OUTCOME_PASSED = "passed"
ASSERTION_OUTCOME_FAILED = "failed"
ASSERTION_OUTCOME_SKIPPED = "skipped"

#: One check's outcome inside a case.
ASSERTION_OUTCOMES = (
    ASSERTION_OUTCOME_PASSED,
    ASSERTION_OUTCOME_FAILED,
    ASSERTION_OUTCOME_SKIPPED,
)

ASSERTION_KIND_STATUS_CODE = "status_code"
ASSERTION_KIND_RESPONSE_SCHEMA = "response_schema"
ASSERTION_KIND_HEADER = "header"
ASSERTION_KIND_CONTENT_TYPE = "content_type"
ASSERTION_KIND_LATENCY = "latency"
ASSERTION_KIND_CUSTOM = "custom"

#: What kind of check an assertion is. Closed, because "which kind of contract violation is this"
#: is a question a comparison across runs has to answer without parsing prose.
ASSERTION_KINDS = (
    ASSERTION_KIND_STATUS_CODE,
    ASSERTION_KIND_RESPONSE_SCHEMA,
    ASSERTION_KIND_HEADER,
    ASSERTION_KIND_CONTENT_TYPE,
    ASSERTION_KIND_LATENCY,
    ASSERTION_KIND_CUSTOM,
)

ARTIFACT_KIND_REQUEST = "request"
ARTIFACT_KIND_RESPONSE = "response"
ARTIFACT_KIND_LOG = "log"
ARTIFACT_KIND_HAR = "har"
ARTIFACT_KIND_REPORT = "report"
ARTIFACT_KIND_DIFF = "diff"
ARTIFACT_KIND_OTHER = "other"

#: What a referenced artifact is.
ARTIFACT_KINDS = (
    ARTIFACT_KIND_REQUEST,
    ARTIFACT_KIND_RESPONSE,
    ARTIFACT_KIND_LOG,
    ARTIFACT_KIND_HAR,
    ARTIFACT_KIND_REPORT,
    ARTIFACT_KIND_DIFF,
    ARTIFACT_KIND_OTHER,
)

#: Schemes an artifact link may use. A scheme-less value is accepted too — that is an object-store
#: key relative to wherever the tenant keeps its run artifacts. ``data:`` is absent on purpose: a
#: data URI *is* the content, and evidence links rather than embeds.
ARTIFACT_URI_SCHEMES = ("http", "https", "s3", "gs")

#: The ECA-1.1 digest form. A run naming anything else is not referring to a suite this platform
#: compiled, and could not be compared with one that is.
SUITE_DIGEST_PATTERN = r"^sha256:[0-9a-f]{64}$"

#: Stored length ceiling for a human-readable message. Generous enough to hold a schema-validation
#: explanation, small enough that evidence cannot become a log sink.
MESSAGE_TEXT_LIMIT = 2000
#: Stored length ceiling for an expected/actual rendering. The artifact holds the full body.
FIELD_TEXT_LIMIT = 1000

_SUITE_DIGEST_RE = re.compile(SUITE_DIGEST_PATTERN)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# Scheme-and-authority prefix, used to spot an embedded ``user:pass@`` credential.
_URI_CREDENTIALS_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://[^/?#]*@")
_URI_SCHEME_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.\-]*):")

# ---------------------------------------------------------------------------------------------
# Error taxonomy — stable codes a CLI, a UI, and a gate can all branch on.
# ---------------------------------------------------------------------------------------------

#: The suite digest is not ``sha256:<64 hex>``.
CODE_SUITE_DIGEST_INVALID = "evidence-suite-digest-invalid"
#: A run finished before it started, or a case's window falls outside its run's.
CODE_TIMING_INVALID = "evidence-timing-invalid"
#: A declared outcome contradicts the records it summarizes (including a "passed" case carrying a
#: failure code, or one whose own assertions failed).
CODE_OUTCOME_MISMATCH = "evidence-outcome-mismatch"
#: A non-passing case, or a failed assertion, arrived with no stable code to explain it.
CODE_FAILURE_DETAIL_REQUIRED = "evidence-failure-detail-required"
#: The same case id was recorded twice in one run.
CODE_DUPLICATE_CASE = "evidence-duplicate-case"
#: A run carried no operation records and did not declare itself cancelled.
CODE_NO_OPERATIONS = "evidence-no-operations"
#: An artifact tried to carry its content inline (a ``data:`` URI).
CODE_ARTIFACT_EMBEDDED = "evidence-artifact-embedded"
#: An artifact link is malformed, uses an unsupported scheme, or embeds credentials.
CODE_ARTIFACT_URI_INVALID = "evidence-artifact-uri-invalid"
#: An artifact was submitted without asserting that it had been redacted.
CODE_ARTIFACT_UNREDACTED = "evidence-artifact-unredacted"
#: The run named a target that does not exist in this tenant.
CODE_TARGET_NOT_FOUND = "evidence-target-not-found"
#: No such run in this tenant.
CODE_RUN_NOT_FOUND = "evidence-run-not-found"
#: An export format outside ``json`` | ``junit``.
CODE_EXPORT_FORMAT = "evidence-export-format-unsupported"
#: A mock attestation was asked for on a run that recorded none — a run that never involved a mock
#: (PMR-3.2). Distinct from a run whose attestation says ``missing``, which *is* returned.
CODE_MOCK_ATTESTATION_ABSENT = "evidence-mock-attestation-absent"


class EvidenceValidationError(ValueError):
    """A submitted run, or a read of one, was refused — with a stable machine code.

    Subclasses ``ValueError`` so a call site that already maps ``ValueError`` onto a 4xx keeps
    working; ``code`` is what a CLI, the UI, and a gate branch on.

    Attributes:
        code: One of the module's ``CODE_*`` constants.
    """

    def __init__(self, code: str, message: str) -> None:
        """Build the error.

        Args:
            code: Stable taxonomy code.
            message: Human-readable, secret-free explanation.
        """
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------------------------


def redact_text(value: Optional[str], limit: int = MESSAGE_TEXT_LIMIT) -> Optional[str]:
    """Scrub credentials out of a free-text field and bound its length.

    Every human-readable string in this module passes through here before it is stored, because a
    runner's failure message quotes what it saw — and what it saw may be an ``Authorization``
    header, a signed URL, or a token echoed in an error body. Detection is the platform's own
    scrubber (:func:`app.intake_secret_scrub.scrub_message`): named credential shapes plus an
    entropy pass, so a bespoke opaque token is caught alongside the well-known ones.

    Truncation happens *after* scrubbing, so a secret can never survive by sitting past the cut.

    Args:
        value: The text to redact; ``None`` passes through.
        limit: Maximum stored length. The result is suffixed with ``…`` when it is truncated, so a
            reader can tell a bounded message from a complete one.

    Returns:
        The redacted, bounded text, or ``None``.
    """
    if value is None:
        return None
    scrubbed = scrub_message(value) or ""
    if len(scrubbed) <= limit:
        return scrubbed
    return scrubbed[:limit] + "…"


def _redacted_field(value: Optional[str]) -> Optional[str]:
    """Validator helper: redact an expected/actual rendering to :data:`FIELD_TEXT_LIMIT`."""
    return redact_text(value, FIELD_TEXT_LIMIT)


def _redacted_message(value: Optional[str]) -> Optional[str]:
    """Validator helper: redact a message to :data:`MESSAGE_TEXT_LIMIT`."""
    return redact_text(value, MESSAGE_TEXT_LIMIT)


# ---------------------------------------------------------------------------------------------
# Artifact references
# ---------------------------------------------------------------------------------------------


def validate_artifact_uri(uri: str) -> str:
    """Return ``uri`` when it is a usable *link*, else raise.

    Three rules, in the order a mistake is most likely to be made:

    * a ``data:`` URI is refused — it carries the artifact instead of pointing at it, which is
      precisely what "artifacts are linked rather than embedded" rules out;
    * a URI whose authority contains ``user:pass@`` is refused — an artifact link is not a place to
      keep a credential, and the V212 CHECK refuses it a second time;
    * the scheme, when there is one, must be in :data:`ARTIFACT_URI_SCHEMES`. A scheme-less value is
      accepted as an object-store key.

    Args:
        uri: The proposed link.

    Returns:
        The trimmed URI.

    Raises:
        EvidenceValidationError: ``evidence-artifact-embedded`` for inline content, or
            ``evidence-artifact-uri-invalid`` for anything else.
    """
    candidate = (uri or "").strip()
    if not candidate:
        raise EvidenceValidationError(
            CODE_ARTIFACT_URI_INVALID, "an artifact reference must carry a uri"
        )
    if candidate.lower().startswith("data:"):
        raise EvidenceValidationError(
            CODE_ARTIFACT_EMBEDDED,
            "an artifact is linked, not embedded: store the bytes and reference them, rather "
            "than inlining a data: URI in the evidence record",
        )
    if _URI_CREDENTIALS_RE.match(candidate):
        raise EvidenceValidationError(
            CODE_ARTIFACT_URI_INVALID,
            "an artifact uri may not embed 'user:pass@' credentials",
        )
    scheme_match = _URI_SCHEME_RE.match(candidate)
    if scheme_match and scheme_match.group(1).lower() not in ARTIFACT_URI_SCHEMES:
        raise EvidenceValidationError(
            CODE_ARTIFACT_URI_INVALID,
            f"an artifact uri scheme must be one of {', '.join(ARTIFACT_URI_SCHEMES)}, or the "
            "value must be a scheme-less object-store key",
        )
    return candidate


class ArtifactReferenceInput(BaseModel):
    """A pointer to a redacted run artifact — a link and a hash, never the bytes.

    There is deliberately no field for content. A request/response capture, a HAR file, or a runner
    log belongs in the tenant's artifact storage; the evidence record says *where* it is, *what* it
    is, and *what it hashes to*, so a reader can fetch it and confirm they got the same bytes the
    run recorded.
    """

    model_config = ConfigDict(extra="forbid")

    kind: str = Field(
        description=f"What the artifact is: {', '.join(ARTIFACT_KINDS)}.",
    )
    uri: str = Field(
        description=(
            "Where the artifact lives — an `http(s)`, `s3`, or `gs` URL, or a scheme-less "
            "object-store key. A `data:` URI is refused: that would embed the artifact."
        ),
        max_length=4000,
    )
    label: Optional[str] = Field(
        default=None, description="Short human label for the artifact.", max_length=200
    )
    media_type: Optional[str] = Field(
        default=None, description="Media type of the referenced artifact.", max_length=200
    )
    size_bytes: Optional[int] = Field(
        default=None, ge=0, description="Size of the referenced artifact, when known."
    )
    content_sha256: Optional[str] = Field(
        default=None,
        description="SHA-256 of the referenced bytes, so a reader can verify what they fetched.",
        max_length=64,
    )
    redacted: bool = Field(
        default=True,
        description=(
            "Asserts the artifact was redacted before it was stored. Submitting `false` is "
            "refused — the schema has no representation for unredacted evidence."
        ),
    )
    redaction: Dict[str, int] = Field(
        default_factory=dict,
        description=(
            "Counts of what redaction removed (`{\"headers\": 2, \"body_fields\": 1}`). Counts "
            "only — naming the removed values would defeat the redaction."
        ),
    )

    @field_validator("kind")
    @classmethod
    def _known_kind(cls, value: str) -> str:
        """Reject an artifact kind outside the closed vocabulary."""
        if value not in ARTIFACT_KINDS:
            raise ValueError(f"artifact kind must be one of {', '.join(ARTIFACT_KINDS)}")
        return value

    @field_validator("content_sha256")
    @classmethod
    def _hex_digest(cls, value: Optional[str]) -> Optional[str]:
        """Reject a content hash that is not 64 lowercase hex characters."""
        if value is not None and not _SHA256_RE.match(value):
            raise ValueError("content_sha256 must be 64 lowercase hexadecimal characters")
        return value

    @field_validator("label", "media_type")
    @classmethod
    def _redact_label(cls, value: Optional[str]) -> Optional[str]:
        """Redact the free-text descriptors, which a runner may build from response data."""
        return _redacted_field(value)


# ---------------------------------------------------------------------------------------------
# Assertions and operations
# ---------------------------------------------------------------------------------------------


class AssertionInput(BaseModel):
    """One check inside a case: what was asserted, what was expected, and what was observed."""

    model_config = ConfigDict(extra="forbid")

    kind: str = Field(description=f"What was checked: {', '.join(ASSERTION_KINDS)}.")
    outcome: str = Field(description=f"One of: {', '.join(ASSERTION_OUTCOMES)}.")
    subject: Optional[str] = Field(
        default=None,
        description="What was asserted on: a JSON Pointer, a header name, or a label.",
        max_length=500,
    )
    expected: Optional[str] = Field(
        default=None,
        description="Redacted rendering of what the contract required.",
        max_length=10000,
    )
    actual: Optional[str] = Field(
        default=None,
        description="Redacted rendering of what was observed.",
        max_length=10000,
    )
    code: Optional[str] = Field(
        default=None,
        description="Stable machine code; required when the assertion failed.",
        max_length=120,
    )
    message: Optional[str] = Field(
        default=None, description="Redacted human explanation.", max_length=20000
    )

    @field_validator("kind")
    @classmethod
    def _known_kind(cls, value: str) -> str:
        """Reject an assertion kind outside the closed vocabulary."""
        if value not in ASSERTION_KINDS:
            raise ValueError(f"assertion kind must be one of {', '.join(ASSERTION_KINDS)}")
        return value

    @field_validator("outcome")
    @classmethod
    def _known_outcome(cls, value: str) -> str:
        """Reject an assertion outcome outside the closed vocabulary."""
        if value not in ASSERTION_OUTCOMES:
            raise ValueError(f"assertion outcome must be one of {', '.join(ASSERTION_OUTCOMES)}")
        return value

    @field_validator("subject", "expected", "actual")
    @classmethod
    def _redact_fields(cls, value: Optional[str]) -> Optional[str]:
        """Redact and bound the expected/actual renderings, which quote live traffic."""
        return _redacted_field(value)

    @field_validator("message")
    @classmethod
    def _redact_message(cls, value: Optional[str]) -> Optional[str]:
        """Redact and bound the explanation."""
        return _redacted_message(value)


class OperationResultInput(BaseModel):
    """One executed case: which operation it exercised, how it went, and why it did not pass."""

    model_config = ConfigDict(extra="forbid")

    case_id: str = Field(
        description="The ECA-1.1 case id, so evidence traces back to the compiled case.",
        min_length=1,
        max_length=300,
    )
    operation_key: str = Field(
        description="Canonical operation key (`GET /pets/{petId}`).", min_length=1, max_length=500
    )
    operation_name: Optional[str] = Field(
        default=None, description="Source operation name, when the suite carried one.",
        max_length=300,
    )
    case_source: Optional[str] = Field(
        default=None,
        description="Where the case came from: a declared example, a generated body, a negative "
        "case.",
        max_length=120,
    )
    http_method: str = Field(description="HTTP verb executed.", min_length=1, max_length=20)
    http_path: str = Field(
        description="Request path executed, relative to the target base URL.",
        min_length=1,
        max_length=2000,
    )
    outcome: str = Field(description=f"One of: {', '.join(OPERATION_OUTCOMES)}.")
    failure_code: Optional[str] = Field(
        default=None,
        description="Stable machine code; required for anything that did not pass.",
        max_length=120,
    )
    failure_message: Optional[str] = Field(
        default=None, description="Redacted explanation of the failure.", max_length=20000
    )
    expected_status: Optional[str] = Field(
        default=None,
        description="Status the contract declared; may be a range (`2XX`).",
        max_length=20,
    )
    actual_status: Optional[int] = Field(
        default=None, ge=100, le=599, description="Status the implementation returned."
    )
    started_at: Optional[datetime] = Field(default=None, description="When the case started.")
    finished_at: Optional[datetime] = Field(default=None, description="When the case finished.")
    duration_ms: int = Field(default=0, ge=0, description="Case duration in milliseconds.")
    attempts: int = Field(
        default=1,
        ge=1,
        le=100,
        description=(
            "Transport attempts. A contract failure is never retried (the ECA-1.2 policy), so a "
            "value above 1 always means the transport was retried — never that a red result was "
            "re-rolled until it went green."
        ),
    )
    assertions: List[AssertionInput] = Field(
        default_factory=list, description="The individual checks this case performed."
    )
    artifacts: List[ArtifactReferenceInput] = Field(
        default_factory=list, description="References to this case's redacted artifacts."
    )

    @field_validator("outcome")
    @classmethod
    def _known_outcome(cls, value: str) -> str:
        """Reject a case outcome outside the closed vocabulary."""
        if value not in OPERATION_OUTCOMES:
            raise ValueError(f"outcome must be one of {', '.join(OPERATION_OUTCOMES)}")
        return value

    @field_validator("http_method")
    @classmethod
    def _upper_method(cls, value: str) -> str:
        """Upper-case the verb, so ``get`` and ``GET`` group together across runs."""
        return value.strip().upper()

    @field_validator("failure_message")
    @classmethod
    def _redact_message(cls, value: Optional[str]) -> Optional[str]:
        """Redact and bound the failure explanation, which quotes what the runner saw."""
        return _redacted_message(value)


class VerificationRunInput(BaseModel):
    """A complete run, as a runner submits it once execution has finished.

    Evidence is recorded in **one** shot rather than opened, appended to, and closed: that is what
    makes immutability enforceable rather than aspirational (V212 rejects every UPDATE), and it
    means a half-written run can never be mistaken for a finished one.
    """

    model_config = ConfigDict(extra="forbid")

    target_ref: str = Field(
        description=(
            "The verification target this run executed against — its slug or its id. Recorded as "
            "an identity snapshot, so a later rename or retirement cannot rewrite the evidence."
        ),
        min_length=1,
        max_length=200,
    )
    suite_digest: str = Field(
        description="The ECA-1.1 manifest digest that was executed (`sha256:<hex>`).",
        max_length=100,
    )
    suite_schema_version: Optional[int] = Field(
        default=None, ge=0, description="Manifest envelope version of the executed suite."
    )
    suite_compiler_version: Optional[int] = Field(
        default=None, ge=0, description="Compiler rules version of the executed suite."
    )
    suite_case_count: Optional[int] = Field(
        default=None,
        ge=0,
        description=(
            "How many cases the manifest declared. Recorded so a run that executed fewer is "
            "visibly partial rather than silently so."
        ),
    )
    runner_name: str = Field(
        description="Which runner produced the evidence.", min_length=1, max_length=200
    )
    runner_version: Optional[str] = Field(
        default=None, description="Runner version, so a behaviour change is attributable.",
        max_length=100,
    )
    started_at: datetime = Field(description="When the run began.")
    finished_at: datetime = Field(description="When the run ended.")
    outcome: Optional[str] = Field(
        default=None,
        description=(
            "Optional declared verdict. It is *checked* against the outcome derived from the "
            "operation records and refused when it disagrees; only `cancelled` — which no record "
            "can imply — is taken on the runner's word."
        ),
    )
    source: Dict[str, Any] = Field(
        default_factory=dict,
        description="Provenance of the compiled suite (artifact kind, reference, revision, "
        "version label), as the manifest reports it.",
    )
    context: Dict[str, Any] = Field(
        default_factory=dict,
        description="Non-secret CI context (commit, branch, workflow URL). Never credentials.",
    )
    idempotency_key: Optional[str] = Field(
        default=None,
        description=(
            "Retry key. A runner that uploads evidence and loses the response can repeat the "
            "request with the same key and get the original run back instead of a duplicate."
        ),
        max_length=200,
    )
    operations: List[OperationResultInput] = Field(
        default_factory=list, description="One record per executed case."
    )
    artifacts: List[ArtifactReferenceInput] = Field(
        default_factory=list,
        description="Run-level artifact references (the runner log, a summary report).",
    )
    mock: Optional[MockAttestationInput] = Field(
        default=None,
        description=(
            "Release-proof mock attestation (PMR-3.2): the immutable bundle digest the run was "
            "served from, the runtime version, the conformance corpus and result, and every "
            "fixture-pack digest. Attach it verbatim from `apiome-mock attest`. A run against a "
            "`mock` environment that omits it is recorded as an *explicitly* missing mock "
            "verification rather than as silence."
        ),
    )

    @field_validator("outcome")
    @classmethod
    def _known_outcome(cls, value: Optional[str]) -> Optional[str]:
        """Reject a run outcome outside the closed vocabulary."""
        if value is not None and value not in RUN_OUTCOMES:
            raise ValueError(f"outcome must be one of {', '.join(RUN_OUTCOMES)}")
        return value


# ---------------------------------------------------------------------------------------------
# Derivation — the verdict comes from the records, not from the claim
# ---------------------------------------------------------------------------------------------


def duration_ms_between(started_at: datetime, finished_at: datetime) -> int:
    """Milliseconds between two instants, floored at zero.

    Args:
        started_at: The earlier instant.
        finished_at: The later instant.

    Returns:
        The non-negative duration in milliseconds.
    """
    delta = (finished_at - started_at).total_seconds() * 1000
    return max(0, int(round(delta)))


def derive_counts(operations: Sequence[OperationResultInput]) -> Dict[str, int]:
    """Count the case outcomes a run recorded.

    Args:
        operations: The submitted case records.

    Returns:
        ``{"total", "passed", "failed", "errored", "skipped"}``, always summing to ``total``.
    """
    counts = {"total": len(operations), "passed": 0, "failed": 0, "errored": 0, "skipped": 0}
    for operation in operations:
        counts[operation.outcome] += 1
    return counts


def derive_outcome(counts: Mapping[str, int]) -> str:
    """The run verdict implied by its case counts.

    ``errored`` outranks ``failed`` because the two mean different things to a gate: a failed run
    showed an incompatibility, an errored one never got far enough to show anything. A run whose
    cases were all skipped is ``passed`` — nothing contradicted the contract — and its counts say
    plainly that nothing was exercised, which is the honest reading.

    Args:
        counts: The result of :func:`derive_counts`.

    Returns:
        ``passed``, ``failed``, or ``errored``. Never ``cancelled``: no set of records implies a
        run was stopped, so only the runner can say that.
    """
    if counts.get("errored", 0) > 0:
        return RUN_OUTCOME_ERRORED
    if counts.get("failed", 0) > 0:
        return RUN_OUTCOME_FAILED
    return RUN_OUTCOME_PASSED


# ---------------------------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------------------------


def _validate_assertions(operation: OperationResultInput) -> None:
    """Check one case's assertions against the case's own outcome.

    Args:
        operation: The case record.

    Raises:
        EvidenceValidationError: ``evidence-failure-detail-required`` when a failed assertion has
            no code, or ``evidence-outcome-mismatch`` when a passing case contains a failed check.
    """
    for assertion in operation.assertions:
        if assertion.outcome == ASSERTION_OUTCOME_FAILED and not (assertion.code or "").strip():
            raise EvidenceValidationError(
                CODE_FAILURE_DETAIL_REQUIRED,
                f"case '{operation.case_id}' has a failed {assertion.kind} assertion with no "
                "code; a failure that does not say why cannot be compared or gated on",
            )
        if (
            assertion.outcome == ASSERTION_OUTCOME_FAILED
            and operation.outcome == OPERATION_OUTCOME_PASSED
        ):
            raise EvidenceValidationError(
                CODE_OUTCOME_MISMATCH,
                f"case '{operation.case_id}' is recorded as passed but carries a failed "
                f"{assertion.kind} assertion",
            )


def _validate_operation(operation: OperationResultInput, run: VerificationRunInput) -> None:
    """Check one case record for internal and run-relative consistency.

    Args:
        operation: The case record.
        run: The run it belongs to, for the timing window.

    Raises:
        EvidenceValidationError: with the code naming which rule failed.
    """
    if operation.outcome in (OPERATION_OUTCOME_FAILED, OPERATION_OUTCOME_ERRORED) and not (
        operation.failure_code or ""
    ).strip():
        raise EvidenceValidationError(
            CODE_FAILURE_DETAIL_REQUIRED,
            f"case '{operation.case_id}' is recorded as {operation.outcome} with no "
            "failure_code; an outcome with no stated reason cannot drive a gate",
        )
    if operation.outcome == OPERATION_OUTCOME_PASSED and (operation.failure_code or "").strip():
        raise EvidenceValidationError(
            CODE_OUTCOME_MISMATCH,
            f"case '{operation.case_id}' is recorded as passed but carries a failure_code",
        )

    if (
        operation.started_at is not None
        and operation.finished_at is not None
        and operation.finished_at < operation.started_at
    ):
        raise EvidenceValidationError(
            CODE_TIMING_INVALID, f"case '{operation.case_id}' finished before it started"
        )
    # A case belongs to its run's window: all of these timestamps come from the same runner clock,
    # so one falling outside means the upload mixed runs rather than that clocks disagree.
    if operation.started_at is not None and operation.started_at < run.started_at:
        raise EvidenceValidationError(
            CODE_TIMING_INVALID,
            f"case '{operation.case_id}' started before the run it belongs to",
        )
    if operation.finished_at is not None and operation.finished_at > run.finished_at:
        raise EvidenceValidationError(
            CODE_TIMING_INVALID,
            f"case '{operation.case_id}' finished after the run it belongs to",
        )

    _validate_assertions(operation)
    for artifact in operation.artifacts:
        _validate_artifact(artifact)


def _validate_artifact(artifact: ArtifactReferenceInput) -> None:
    """Check one artifact reference is a redacted link rather than embedded content.

    Args:
        artifact: The reference.

    Raises:
        EvidenceValidationError: ``evidence-artifact-unredacted``, ``evidence-artifact-embedded``,
            or ``evidence-artifact-uri-invalid``.
    """
    if not artifact.redacted:
        raise EvidenceValidationError(
            CODE_ARTIFACT_UNREDACTED,
            "an artifact reference must assert that the artifact was redacted; there is no way "
            "to record an unredacted one",
        )
    validate_artifact_uri(artifact.uri)


def validate_mock_attestation_input(
    attestation: MockAttestationInput,
) -> MockAttestationRecord:
    """Validate an attached mock attestation, in this module's taxonomy (PMR-3.2, #4749).

    :mod:`app.mock_attestation` owns the rules and deliberately does not import this module — the
    dependency runs one way only, so the mock contract stays usable on its own. This is the single
    seam that translates its refusal into an :class:`EvidenceValidationError` carrying the *same*
    code, so every evidence caller keeps branching on one exception type and one taxonomy.

    Args:
        attestation: The submitted mock block.

    Returns:
        The record that will be stored, with its status derived from the conformance result.

    Raises:
        EvidenceValidationError: with the ``mock-*`` code naming which rule failed.
    """
    try:
        return validate_mock_attestation(attestation)
    except MockAttestationError as exc:
        raise EvidenceValidationError(exc.code, str(exc)) from exc


def validate_run_input(run: VerificationRunInput) -> Dict[str, int]:
    """Vet a submitted run end to end and return its derived counts.

    This is the single place a run is judged, so every caller — the REST route, the store, a future
    CLI — applies the same rules. What is checked, in the order a mistake is most likely to be
    made: the suite digest's shape, the run's own timing, that there is something to record at all,
    each case (detail, timing, assertions, artifacts), no duplicate case, the run-level artifacts,
    the mock attestation when one is attached, and finally that any *declared* outcome agrees with
    the one the records imply.

    Args:
        run: The submitted run.

    Returns:
        The derived counts, so the caller need not recompute them.

    Raises:
        EvidenceValidationError: with the code naming which rule failed.
    """
    if not _SUITE_DIGEST_RE.match(run.suite_digest or ""):
        raise EvidenceValidationError(
            CODE_SUITE_DIGEST_INVALID,
            "suite_digest must be the ECA-1.1 manifest digest in 'sha256:<64 hex>' form",
        )
    if run.finished_at < run.started_at:
        raise EvidenceValidationError(CODE_TIMING_INVALID, "the run finished before it started")
    if not run.operations and run.outcome != RUN_OUTCOME_CANCELLED:
        raise EvidenceValidationError(
            CODE_NO_OPERATIONS,
            "a run must record at least one case; a run that stopped before executing anything "
            "declares outcome 'cancelled'",
        )

    seen: Dict[str, int] = {}
    for index, operation in enumerate(run.operations):
        if operation.case_id in seen:
            raise EvidenceValidationError(
                CODE_DUPLICATE_CASE,
                f"case '{operation.case_id}' was recorded twice (positions "
                f"{seen[operation.case_id]} and {index}); case ids are unique within a suite",
            )
        seen[operation.case_id] = index
        _validate_operation(operation, run)

    for artifact in run.artifacts:
        _validate_artifact(artifact)

    if run.mock is not None:
        validate_mock_attestation_input(run.mock)

    counts = derive_counts(run.operations)
    derived = derive_outcome(counts)
    if run.outcome is not None and run.outcome != RUN_OUTCOME_CANCELLED and run.outcome != derived:
        raise EvidenceValidationError(
            CODE_OUTCOME_MISMATCH,
            f"the run declares outcome '{run.outcome}' but its cases imply '{derived}' "
            f"({counts['failed']} failed, {counts['errored']} errored of {counts['total']})",
        )
    return counts


# ---------------------------------------------------------------------------------------------
# Stored records
# ---------------------------------------------------------------------------------------------


class AssertionRecord(BaseModel):
    """A stored assertion, as every reader and both exporters see it."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Assertion id.")
    sequence: int = Field(description="Stored order within the case.")
    kind: str = Field(description="What was checked.")
    outcome: str = Field(description="`passed`, `failed`, or `skipped`.")
    subject: Optional[str] = Field(default=None, description="What was asserted on.")
    expected: Optional[str] = Field(default=None, description="What the contract required.")
    actual: Optional[str] = Field(default=None, description="What was observed.")
    code: Optional[str] = Field(default=None, description="Stable code for a failed assertion.")
    message: Optional[str] = Field(default=None, description="Redacted explanation.")


class ArtifactRecord(BaseModel):
    """A stored artifact reference: a link and a hash, never the bytes."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Artifact reference id.")
    operation_id: Optional[str] = Field(
        default=None, description="Owning case, or null for a run-level artifact."
    )
    kind: str = Field(description="What the artifact is.")
    label: Optional[str] = Field(default=None, description="Short human label.")
    media_type: Optional[str] = Field(default=None, description="Media type of the artifact.")
    uri: str = Field(description="Where the artifact lives.")
    size_bytes: Optional[int] = Field(default=None, description="Size in bytes, when known.")
    content_sha256: Optional[str] = Field(
        default=None, description="SHA-256 of the referenced bytes."
    )
    redacted: bool = Field(default=True, description="Always true — see the V212 CHECK.")
    redaction: Dict[str, Any] = Field(
        default_factory=dict, description="Counts of what redaction removed."
    )


class OperationRecord(BaseModel):
    """A stored case result, with its assertions and artifact references."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Case record id.")
    sequence: int = Field(description="Stored order within the run.")
    case_id: str = Field(description="ECA-1.1 case id.")
    operation_key: str = Field(description="Canonical operation key.")
    operation_name: Optional[str] = Field(default=None, description="Source operation name.")
    case_source: Optional[str] = Field(default=None, description="Where the case came from.")
    http_method: str = Field(description="HTTP verb executed.")
    http_path: str = Field(description="Request path executed.")
    outcome: str = Field(description="`passed`, `failed`, `errored`, or `skipped`.")
    failure_code: Optional[str] = Field(default=None, description="Stable code for a non-pass.")
    failure_message: Optional[str] = Field(default=None, description="Redacted explanation.")
    expected_status: Optional[str] = Field(default=None, description="Status the contract declared.")
    actual_status: Optional[int] = Field(default=None, description="Status returned.")
    started_at: Optional[datetime] = Field(default=None, description="When the case started.")
    finished_at: Optional[datetime] = Field(default=None, description="When the case finished.")
    duration_ms: int = Field(default=0, description="Case duration in milliseconds.")
    attempts: int = Field(default=1, description="Transport attempts.")
    assertions: List[AssertionRecord] = Field(
        default_factory=list, description="The case's assertions, in stored order."
    )
    artifacts: List[ArtifactRecord] = Field(
        default_factory=list, description="The case's artifact references."
    )


class VerificationRunSummary(BaseModel):
    """A run without its per-case detail — what a list read returns."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Run id — what a gate decision cites as its evidence.")
    tenant_id: str = Field(description="Tenant that owns the evidence.")
    suite_digest: str = Field(description="The executed ECA-1.1 manifest digest.")
    suite_schema_version: Optional[int] = Field(default=None, description="Manifest envelope version.")
    suite_compiler_version: Optional[int] = Field(default=None, description="Compiler rules version.")
    suite_case_count: Optional[int] = Field(
        default=None, description="Cases the manifest declared."
    )
    target_id: Optional[str] = Field(default=None, description="Target used, when it still exists.")
    target_slug: str = Field(description="Target handle at run time.")
    target_environment: str = Field(description="Environment class at run time.")
    target_network_class: str = Field(description="`public` or `private`, at run time.")
    target_base_url: str = Field(description="Base URL at run time.")
    runner_name: str = Field(description="Which runner produced the evidence.")
    runner_version: Optional[str] = Field(default=None, description="Runner version.")
    recorded_by: Optional[str] = Field(default=None, description="User who recorded the evidence.")
    actor_label: Optional[str] = Field(default=None, description="Actor email/name at the time.")
    actor_kind: str = Field(default="user", description="`user`, `api_key`, or `system`.")
    started_at: Optional[datetime] = Field(default=None, description="When the run began.")
    finished_at: Optional[datetime] = Field(default=None, description="When the run ended.")
    duration_ms: int = Field(default=0, description="Wall-clock duration in milliseconds.")
    outcome: str = Field(description="`passed`, `failed`, `errored`, or `cancelled`.")
    counts: Dict[str, int] = Field(
        default_factory=dict,
        description="`total`, `passed`, `failed`, `errored`, `skipped` — always summing to total.",
    )
    source: Dict[str, Any] = Field(
        default_factory=dict, description="Provenance of the compiled suite."
    )
    context: Dict[str, Any] = Field(default_factory=dict, description="Non-secret CI context.")
    idempotency_key: Optional[str] = Field(default=None, description="Caller-supplied retry key.")
    created_at: Optional[datetime] = Field(
        default=None, description="When the evidence was recorded (server clock)."
    )


class VerificationRunRecord(VerificationRunSummary):
    """A run with its full detail — what a read of one run, and both exporters, work from."""

    operations: List[OperationRecord] = Field(
        default_factory=list, description="Case records, in stored order."
    )
    artifacts: List[ArtifactRecord] = Field(
        default_factory=list, description="Run-level artifact references."
    )
    mock: Optional[MockAttestationRecord] = Field(
        default=None,
        description=(
            "The run's mock attestation (PMR-3.2). Present whenever the run named a mock — "
            "carrying `status: missing` with a reason when nothing was attested — and `null` for "
            "a run that had nothing to do with a mock."
        ),
    )


def _text(value: Any) -> Optional[str]:
    """Render an id as a string, preserving ``None`` (a UUID arrives as an object)."""
    return None if value is None else str(value)


def _mapping(value: Any) -> Dict[str, Any]:
    """Return a JSONB column as a dict, tolerating a legacy row that stored something else."""
    return dict(value) if isinstance(value, Mapping) else {}


def summary_from_row(row: Mapping[str, Any]) -> VerificationRunSummary:
    """Adapt a ``verification_run`` row into a :class:`VerificationRunSummary`.

    Args:
        row: The database row.

    Returns:
        The summary, with the count columns folded into the ``counts`` block readers expect.
    """
    return VerificationRunSummary(**_summary_fields(row))


def _summary_fields(row: Mapping[str, Any]) -> Dict[str, Any]:
    """The summary field map shared by :func:`summary_from_row` and :func:`record_from_rows`.

    Args:
        row: A ``verification_run`` row.

    Returns:
        Keyword arguments for :class:`VerificationRunSummary`.
    """
    return {
        "id": str(row.get("id")),
        "tenant_id": str(row.get("tenant_id")),
        "suite_digest": str(row.get("suite_digest") or ""),
        "suite_schema_version": row.get("suite_schema_version"),
        "suite_compiler_version": row.get("suite_compiler_version"),
        "suite_case_count": row.get("suite_case_count"),
        "target_id": _text(row.get("target_id")),
        "target_slug": str(row.get("target_slug") or ""),
        "target_environment": str(row.get("target_environment") or ""),
        "target_network_class": str(row.get("target_network_class") or "public"),
        "target_base_url": str(row.get("target_base_url") or ""),
        "runner_name": str(row.get("runner_name") or ""),
        "runner_version": row.get("runner_version"),
        "recorded_by": _text(row.get("recorded_by")),
        "actor_label": row.get("actor_label"),
        "actor_kind": str(row.get("actor_kind") or "user"),
        "started_at": row.get("started_at"),
        "finished_at": row.get("finished_at"),
        "duration_ms": int(row.get("duration_ms") or 0),
        "outcome": str(row.get("outcome") or ""),
        "counts": {
            "total": int(row.get("total_cases") or 0),
            "passed": int(row.get("passed_cases") or 0),
            "failed": int(row.get("failed_cases") or 0),
            "errored": int(row.get("errored_cases") or 0),
            "skipped": int(row.get("skipped_cases") or 0),
        },
        "source": _mapping(row.get("source")),
        "context": _mapping(row.get("context")),
        "idempotency_key": row.get("idempotency_key"),
        "created_at": row.get("created_at"),
    }


def _assertion_from_row(row: Mapping[str, Any]) -> AssertionRecord:
    """Adapt a ``verification_run_assertion`` row into an :class:`AssertionRecord`."""
    return AssertionRecord(
        id=str(row.get("id")),
        sequence=int(row.get("sequence") or 0),
        kind=str(row.get("kind") or ""),
        outcome=str(row.get("outcome") or ""),
        subject=row.get("subject"),
        expected=row.get("expected"),
        actual=row.get("actual"),
        code=row.get("code"),
        message=row.get("message"),
    )


def _artifact_from_row(row: Mapping[str, Any]) -> ArtifactRecord:
    """Adapt a ``verification_run_artifact`` row into an :class:`ArtifactRecord`."""
    return ArtifactRecord(
        id=str(row.get("id")),
        operation_id=_text(row.get("operation_id")),
        kind=str(row.get("kind") or ARTIFACT_KIND_OTHER),
        label=row.get("label"),
        media_type=row.get("media_type"),
        uri=str(row.get("uri") or ""),
        size_bytes=row.get("size_bytes"),
        content_sha256=row.get("content_sha256"),
        redacted=bool(row.get("redacted", True)),
        redaction=_mapping(row.get("redaction")),
    )


def record_from_rows(
    run_row: Mapping[str, Any],
    operation_rows: Sequence[Mapping[str, Any]] = (),
    assertion_rows: Sequence[Mapping[str, Any]] = (),
    artifact_rows: Sequence[Mapping[str, Any]] = (),
    mock_row: Optional[Mapping[str, Any]] = None,
) -> VerificationRunRecord:
    """Assemble stored rows into one :class:`VerificationRunRecord`.

    The four tables are read flat — one query each, rather than a join per case — and stitched
    here, so reading a run costs a fixed number of queries no matter how many cases it recorded.

    Args:
        run_row: The ``verification_run`` row.
        operation_rows: Its ``verification_run_operation`` rows, in stored order.
        assertion_rows: Every ``verification_run_assertion`` row for the run, in stored order.
        artifact_rows: Every ``verification_run_artifact`` row for the run.
        mock_row: The run's ``verification_run_mock`` row, when it has one (PMR-3.2).

    Returns:
        The complete record. Artifacts with no ``operation_id`` become run-level ones; the rest are
        attached to their case.
    """
    assertions_by_operation: Dict[str, List[AssertionRecord]] = {}
    for row in assertion_rows:
        assertions_by_operation.setdefault(str(row.get("operation_id")), []).append(
            _assertion_from_row(row)
        )

    artifacts_by_operation: Dict[str, List[ArtifactRecord]] = {}
    run_artifacts: List[ArtifactRecord] = []
    for row in artifact_rows:
        artifact = _artifact_from_row(row)
        if artifact.operation_id:
            artifacts_by_operation.setdefault(artifact.operation_id, []).append(artifact)
        else:
            run_artifacts.append(artifact)

    operations: List[OperationRecord] = []
    for row in operation_rows:
        operation_id = str(row.get("id"))
        operations.append(
            OperationRecord(
                id=operation_id,
                sequence=int(row.get("sequence") or 0),
                case_id=str(row.get("case_id") or ""),
                operation_key=str(row.get("operation_key") or ""),
                operation_name=row.get("operation_name"),
                case_source=row.get("case_source"),
                http_method=str(row.get("http_method") or ""),
                http_path=str(row.get("http_path") or ""),
                outcome=str(row.get("outcome") or ""),
                failure_code=row.get("failure_code"),
                failure_message=row.get("failure_message"),
                expected_status=row.get("expected_status"),
                actual_status=row.get("actual_status"),
                started_at=row.get("started_at"),
                finished_at=row.get("finished_at"),
                duration_ms=int(row.get("duration_ms") or 0),
                attempts=int(row.get("attempts") or 1),
                assertions=assertions_by_operation.get(operation_id, []),
                artifacts=artifacts_by_operation.get(operation_id, []),
            )
        )

    return VerificationRunRecord(
        **_summary_fields(run_row),
        operations=operations,
        artifacts=run_artifacts,
        mock=attestation_from_row(mock_row) if mock_row is not None else None,
    )
