"""Stable error taxonomy for import intake failures (IXH-1.3, nucleus of IXH-6.4).

Every terminal import failure maps onto exactly one *code* from this module. A code
carries a category, a retriability flag, and remediation copy, so the UI/CLI can key
guidance off the code instead of parsing exception strings.

Contract (IXH-6.4):
    * Codes are **additive-only** — a shipped code is never renamed, removed, or
      repurposed. New failure conditions get new codes.
    * Categories come from the fixed IXH-6.4 set below.
    * Remediation text is user-facing: it must say what the *user* can do next.

The negative corpus (``apiome-ui/examples/*/negative/`` + ``corpus.manifest.json``)
declares an ``expected_error_code`` per entry and
``apiome-rest/tests/test_corpus_negative.py`` asserts the pipeline emits it, so a
change here that breaks the mapping fails the suite.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Dict, Mapping, Optional

__all__ = [
    "JobErrorCategory",
    "IntakeErrorCategory",
    "IntakeErrorDescriptor",
    "INTAKE_ERROR_TAXONOMY",
    "LEGACY_EVENT_CODE_MAP",
    "descriptor_for",
    "resolve_intake_error_code",
]


class JobErrorCategory(str, Enum):
    """Broad failure family shared by intake and delivery (IXH-6.4).

    Fixed set; codes refine within a category. Additive-only for codes — this enum
    itself is closed.
    """

    INPUT = "input"  # the user's document / acknowledgement is at fault
    FORMAT = "format"  # document/format routing or emitted artifact shape is at fault
    CAPABILITY = "capability"  # this deployment cannot service the request
    POLICY = "policy"  # rejected by tenant/instance policy or confirmation gate
    RESOURCE = "resource"  # a size / depth / expansion limit was exceeded
    TRANSPORT = "transport"  # upstream fetch or delivery fault
    INTERNAL = "internal"  # our fault: unexpected exception, worker fault, storage fault


#: Backward-compatible alias — intake code predates the shared name (IXH-1.3).
IntakeErrorCategory = JobErrorCategory


@dataclass(frozen=True)
class IntakeErrorDescriptor:
    """One stable intake failure code and the guidance attached to it.

    Attributes:
        code: Stable machine-readable identifier (additive-only, never repurposed).
        category: The :class:`JobErrorCategory` the code belongs to.
        retriable: Whether retrying the same request may succeed without the user
            changing the input (transient faults) — drives UI retry affordances.
        remediation: Actionable, user-facing guidance (always non-empty).
    """

    code: str
    category: JobErrorCategory
    retriable: bool
    remediation: str


def _d(
    code: str, category: JobErrorCategory, retriable: bool, remediation: str
) -> IntakeErrorDescriptor:
    return IntakeErrorDescriptor(
        code=code, category=category, retriable=retriable, remediation=remediation
    )


#: The registry, keyed by code. Additive-only (see module docstring).
INTAKE_ERROR_TAXONOMY: Dict[str, IntakeErrorDescriptor] = {
    d.code: d
    for d in (
        # --- input: the document itself is at fault -----------------------------
        _d(
            "INPUT_EMPTY",
            IntakeErrorCategory.INPUT,
            False,
            "The document is empty or contains only whitespace. Paste or upload the "
            "full specification content and try again.",
        ),
        _d(
            "INPUT_ENCODING_INVALID",
            IntakeErrorCategory.INPUT,
            False,
            "The document is not valid UTF-8 text (it may be UTF-16, have a byte-order "
            "mark, or contain binary bytes). Re-save the file as UTF-8 without a BOM "
            "and try again.",
        ),
        _d(
            "INPUT_MALFORMED",
            IntakeErrorCategory.INPUT,
            False,
            "The document is not syntactically valid for the selected format. Check "
            "the reported location for the syntax fault (or validate the file with "
            "the format's own tooling), fix it, and re-import.",
        ),
        _d(
            "INPUT_TRUNCATED",
            IntakeErrorCategory.INPUT,
            False,
            "The document appears to be cut off before its end. Re-export or re-copy "
            "the complete file and try again.",
        ),
        _d(
            "INPUT_SEMANTIC_INVALID",
            IntakeErrorCategory.INPUT,
            False,
            "The document parses, but its content is not a valid instance of the "
            "format (a required element is missing, inconsistent, or contradicts "
            "another). Fix the reported element and re-import.",
        ),
        _d(
            "INPUT_REFERENCE_UNRESOLVED",
            IntakeErrorCategory.INPUT,
            False,
            "The document points at a reference that cannot be resolved (for example "
            "a $ref, import, or include target that is missing). Bundle the referenced "
            "files into the upload, or inline the reference, and try again.",
        ),
        _d(
            "INPUT_ARCHIVE_INVALID",
            IntakeErrorCategory.INPUT,
            False,
            "The uploaded archive could not be unpacked (corrupt, unsupported layout, "
            "or missing the expected root document). Re-create the archive and try "
            "again.",
        ),
        _d(
            "INPUT_OVERLAY_BASE_MISSING",
            IntakeErrorCategory.INPUT,
            False,
            "The document is an OpenAPI Overlay, which modifies a base OpenAPI "
            "document that was not provided. Upload the base document together "
            "with the overlay (for example as a .zip archive containing both), "
            "and import them as one.",
        ),
        _d(
            "INPUT_UNSAFE_CONSTRUCT",
            IntakeErrorCategory.INPUT,
            False,
            "The document uses a construct that is not allowed on import for "
            "security reasons (an XML DTD, an entity definition, an external "
            "reference, or an archive entry pointing outside its root). Remove the "
            "construct — inline what it referenced — and try again.",
        ),
        # --- transport: the upstream source could not be read (MFI-29.3) ---------
        _d(
            "SOURCE_NOT_FOUND",
            IntakeErrorCategory.TRANSPORT,
            False,
            "The source repository, ref, or path does not exist (or your account "
            "cannot see it). Check the repository URL and the branch/tag/commit, "
            "then try again.",
        ),
        _d(
            "SOURCE_AUTH_REQUIRED",
            IntakeErrorCategory.TRANSPORT,
            False,
            "The source repository is private and no stored credential authorized "
            "the read. Link an account with access to it (Settings → Linked "
            "accounts) and import again.",
        ),
        _d(
            "SOURCE_UNREACHABLE",
            IntakeErrorCategory.TRANSPORT,
            True,
            "The source repository could not be reached — the provider may be "
            "rate-limiting or temporarily unavailable. Wait a moment and retry.",
        ),
        _d(
            "SOURCE_PROVIDER_UNSUPPORTED",
            IntakeErrorCategory.CAPABILITY,
            False,
            "Importing from this hosting provider is not supported yet. Use a "
            "github.com repository, or upload the files as a .zip/.tar.gz archive.",
        ),
        _d(
            "SOURCE_SELECTION_EMPTY",
            IntakeErrorCategory.INPUT,
            False,
            "No importable files matched the path or glob in the selected repository "
            "and ref. Widen the pattern (for example 'protos/**') or check that the "
            "files exist on that ref.",
        ),
        # --- resource: a limit was exceeded (IXH-1.4; IXH-6.5 extends this set) --
        _d(
            "INPUT_TOO_LARGE",
            IntakeErrorCategory.RESOURCE,
            False,
            "The document is larger than the import size limit. Split it into "
            "smaller documents, or remove embedded data such as inline examples, "
            "and try again.",
        ),
        _d(
            "INPUT_DEPTH_LIMIT",
            IntakeErrorCategory.RESOURCE,
            False,
            "The document nests more deeply than the import limit allows. Flatten "
            "the deepest structures — or replace a recursive chain of references "
            "with a bounded one — and try again.",
        ),
        _d(
            "INPUT_EXPANSION_LIMIT",
            IntakeErrorCategory.RESOURCE,
            False,
            "Expanding the document's aliases, references, or entities would "
            "produce far more content than the import limit allows. Inline the "
            "repeated content directly instead of aliasing it, and try again.",
        ),
        _d(
            "INPUT_ENTITY_LIMIT",
            IntakeErrorCategory.RESOURCE,
            False,
            "The document declares more entities than the import limit allows. "
            "Split the document into smaller packages, or remove unused types and "
            "examples, and try again.",
        ),
        _d(
            "INPUT_REF_LIMIT",
            IntakeErrorCategory.RESOURCE,
            False,
            "The document's $ref or include graph is deeper or wider than the "
            "import limit allows. Flatten the reference chain — or reduce how many "
            "references leave a single node — and try again.",
        ),
        _d(
            "INPUT_TIME_LIMIT",
            IntakeErrorCategory.RESOURCE,
            False,
            "Processing this document exceeded the per-stage time budget. Simplify "
            "the document (fewer nested references, smaller archives) and try "
            "again; contact your administrator if a larger budget is needed.",
        ),
        _d(
            "INPUT_MEMORY_LIMIT",
            IntakeErrorCategory.RESOURCE,
            False,
            "Processing this document exceeded the per-job memory ceiling. Split "
            "the document, remove large embedded examples or binaries, and try "
            "again; contact your administrator if a larger ceiling is needed.",
        ),
        # --- format: routing between document and adapter is at fault -----------
        _d(
            "FORMAT_MISMATCH",
            IntakeErrorCategory.FORMAT,
            False,
            "The document does not look like the selected format. Double-check which "
            "format the file actually is, and re-import with that format selected (or "
            "use auto-detection).",
        ),
        _d(
            "FORMAT_UNRECOGNIZED",
            IntakeErrorCategory.FORMAT,
            False,
            "No importer recognized this document's format. Select the format "
            "explicitly if you know it, or convert the document to a supported "
            "format and try again.",
        ),
        _d(
            "FORMAT_VERSION_UNSUPPORTED",
            IntakeErrorCategory.FORMAT,
            False,
            "The document declares a format version this importer does not support. "
            "Convert the document to a supported version and try again.",
        ),
        # --- capability: this deployment cannot service the request --------------
        _d(
            "ADAPTER_UNAVAILABLE",
            IntakeErrorCategory.CAPABILITY,
            False,
            "The importer for this format needs a tool that is not available on this "
            "server. Contact your administrator to enable it, or import the document "
            "in another supported format.",
        ),
        _d(
            "SYNTHESIS_UNSUPPORTED_CONSTRUCT",
            IntakeErrorCategory.CAPABILITY,
            False,
            "The payload synthesizer could not generate a value — or a clean single-rule "
            "violation — for a construct in this schema. Declare an `examples` or `default` "
            "value on the affected subschema to control what is generated for it.",
        ),
        # --- policy: rejected by tenant policy -----------------------------------
        _d(
            "QUALITY_POLICY_BLOCKED",
            IntakeErrorCategory.POLICY,
            False,
            "Your tenant's import quality policy refuses this document at its current "
            "lint grade. Fix the findings the pre-flight report ranks first and import "
            "again, or ask someone with a permitted role to record a waiver.",
        ),
        # --- internal: our fault -------------------------------------------------
        _d(
            "INTERNAL_ADAPTER_FAULT",
            IntakeErrorCategory.INTERNAL,
            True,
            "The importer hit an unexpected internal error while processing the "
            "document. This is a bug on our side — retry once, and if it persists "
            "report the job id to support.",
        ),
        _d(
            "INTERNAL_WORKER_FAULT",
            IntakeErrorCategory.INTERNAL,
            True,
            "The import worker failed unexpectedly. Retry the import, and if it "
            "persists report the job id to support.",
        ),
        _d(
            "INTERNAL_PERSIST_FAULT",
            IntakeErrorCategory.INTERNAL,
            True,
            "The import was parsed successfully but could not be stored. Retry the "
            "import, and if it persists report the job id to support.",
        ),
    )
}


#: Failure event/engine codes that predate the taxonomy, mapped onto it. The event
#: codes stay as-is on the wire (they are part of the job event contract); this map
#: only supplies taxonomy metadata for terminal statuses that carry no explicit code.
LEGACY_EVENT_CODE_MAP: Mapping[str, str] = {
    "PARSE_ERROR": "INPUT_MALFORMED",
    "NORMALIZE_ERROR": "INPUT_SEMANTIC_INVALID",
    "PERSIST_ERROR": "INTERNAL_PERSIST_FAULT",
    "ADAPTER_EXCEPTION": "INTERNAL_ADAPTER_FAULT",
    "ADAPTER_UNAVAILABLE": "ADAPTER_UNAVAILABLE",
    "WORKER_ERROR": "INTERNAL_WORKER_FAULT",
    "WORKER_EXCEPTION": "INTERNAL_WORKER_FAULT",
    "WORKER_FAILED": "INTERNAL_WORKER_FAULT",
    "BAD_WORKER_PAYLOAD": "INTERNAL_WORKER_FAULT",
    "INVALID_STATUS": "INTERNAL_WORKER_FAULT",
}


def descriptor_for(code: Optional[str]) -> Optional[IntakeErrorDescriptor]:
    """Look up the descriptor for a taxonomy code (``None`` for unknown codes)."""
    if not code:
        return None
    return INTAKE_ERROR_TAXONOMY.get(code)


def resolve_intake_error_code(code: Optional[str]) -> Optional[str]:
    """Resolve a raw failure code to a taxonomy code.

    Accepts either a taxonomy code (returned as-is) or a legacy event/engine code
    (mapped via :data:`LEGACY_EVENT_CODE_MAP`); returns ``None`` when neither.
    """
    if not code:
        return None
    if code in INTAKE_ERROR_TAXONOMY:
        return code
    return LEGACY_EVENT_CODE_MAP.get(code)
