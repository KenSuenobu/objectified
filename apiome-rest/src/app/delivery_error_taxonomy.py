"""Stable error taxonomy for export / delivery failures (IXH-6.4).

Every terminal export job failure maps onto exactly one *code* from this module.
A code carries a category, a retriability flag, and remediation copy, so the
UI/CLI can key guidance off the code instead of parsing exception strings.

Contract (IXH-6.4):
    * Codes are **additive-only** — a shipped code is never renamed, removed, or
      repurposed. New failure conditions get new codes.
    * Categories come from the fixed :class:`~app.intake_error_taxonomy.JobErrorCategory`
      set shared with intake.
    * Remediation text is user-facing: it must say what the *user* can do next.
    * Internal faults never surface a bare stringified exception; the user-facing
      message carries a correlation id (the job id) instead.

The intake twin is :mod:`app.intake_error_taxonomy`. Projection fidelity reasons
(:mod:`app.projection_taxonomy`) are a separate vocabulary for loss classification,
not terminal job failures.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

from .intake_error_taxonomy import JobErrorCategory

__all__ = [
    "DeliveryErrorDescriptor",
    "DELIVERY_ERROR_TAXONOMY",
    "descriptor_for",
    "resolve_delivery_error_code",
    "sanitize_delivery_message",
]


@dataclass(frozen=True)
class DeliveryErrorDescriptor:
    """One stable delivery failure code and the guidance attached to it.

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
) -> DeliveryErrorDescriptor:
    return DeliveryErrorDescriptor(
        code=code, category=category, retriable=retriable, remediation=remediation
    )


#: The registry, keyed by code. Additive-only (see module docstring).
DELIVERY_ERROR_TAXONOMY: Dict[str, DeliveryErrorDescriptor] = {
    d.code: d
    for d in (
        _d(
            "SOURCE_LOAD_FAILED",
            JobErrorCategory.TRANSPORT,
            True,
            "The source version could not be loaded for export. Retry the export; "
            "if it persists, confirm the project and version still exist and try again.",
        ),
        _d(
            "UNSUPPORTED_TARGET",
            JobErrorCategory.CAPABILITY,
            False,
            "This target format is not available for this source. Choose a different "
            "export target and try again.",
        ),
        _d(
            "STALE_PREVIEW",
            JobErrorCategory.INPUT,
            False,
            "The preview you acknowledged no longer matches the current export inputs. "
            "Re-run the preview, acknowledge the new snapshot, and generate again.",
        ),
        _d(
            "TRANSCODE_CONFIRMATION_REQUIRED",
            JobErrorCategory.POLICY,
            False,
            "This conversion is severe or lossy and needs an explicit confirmation. "
            "Acknowledge the loss (confirm) and resubmit the export.",
        ),
        _d(
            "EMIT_FAILED",
            JobErrorCategory.INTERNAL,
            True,
            "The target emitter failed unexpectedly. Retry the export; if it persists, "
            "report the job id to support.",
        ),
        _d(
            "EMPTY_EMIT",
            JobErrorCategory.CAPABILITY,
            False,
            "The emitter produced no document for this source. Adjust the target "
            "options or choose a different target, then try again.",
        ),
        _d(
            "EMITTED_ARTIFACT_INVALID",
            JobErrorCategory.FORMAT,
            False,
            "The generated artifact failed re-import validation. Review the validation "
            "findings, adjust the source or options, and try again.",
        ),
        _d(
            "EXPORT_DELIVERY_BLOCKED",
            JobErrorCategory.POLICY,
            False,
            "The tenant's export quality policy refused this delivery. Review the named "
            "reasons, then either raise the source's quality (or pick a higher-fidelity "
            "target) and export again, or ask a permitted role to record an export waiver "
            "for this revision.",
        ),
        _d(
            "EXPORT_ARTIFACT_TOO_LARGE",
            JobErrorCategory.RESOURCE,
            False,
            "The emitted artifact exceeds the retained-artifact size limit. Narrow the "
            "export (fewer files or options) and try again.",
        ),
        _d(
            "EXPORT_ARTIFACT_STORE_UNAVAILABLE",
            JobErrorCategory.CAPABILITY,
            True,
            "Artifact storage is unavailable or misconfigured on this server. Retry "
            "once; if it persists, contact your administrator.",
        ),
        _d(
            "EXPORT_ARTIFACT_PERSIST_FAILED",
            JobErrorCategory.INTERNAL,
            True,
            "The artifact was generated but could not be stored for download. Retry "
            "the export; if it persists, report the job id to support.",
        ),
        _d(
            "EXPORT_EXCEPTION",
            JobErrorCategory.INTERNAL,
            True,
            "The export pipeline hit an unexpected internal error. Retry once, and if "
            "it persists report the job id to support.",
        ),
        _d(
            "PACKAGING_FAILED",
            JobErrorCategory.TRANSPORT,
            True,
            "The emitted files could not be bundled for delivery. Retry the export; "
            "if it persists, report the job id to support.",
        ),
        _d(
            "DELIVERY_FAILED",
            JobErrorCategory.TRANSPORT,
            True,
            "The artifact was generated but could not be delivered. Retry the download "
            "or the export; if it persists, report the job id to support.",
        ),
    )
}


def descriptor_for(code: Optional[str]) -> Optional[DeliveryErrorDescriptor]:
    """Look up the descriptor for a delivery taxonomy code (``None`` if unknown)."""
    if not code:
        return None
    return DELIVERY_ERROR_TAXONOMY.get(code)


def resolve_delivery_error_code(code: Optional[str]) -> Optional[str]:
    """Resolve a raw failure code to a registered delivery taxonomy code.

    Returns ``None`` when the code is missing or unregistered.
    """
    if not code:
        return None
    if code in DELIVERY_ERROR_TAXONOMY:
        return code
    return None


def sanitize_delivery_message(
    code: str,
    message: str,
    *,
    correlation_id: Optional[str] = None,
) -> str:
    """Return the user-facing message for a delivery failure.

    Internal-category codes never echo a stringified exception; they carry a generic
    sentence plus the job id as correlation id (IXH-6.4). Non-internal codes keep the
    caller-supplied message when it is non-empty.
    """
    descriptor = descriptor_for(code)
    if descriptor is None or descriptor.category is not JobErrorCategory.INTERNAL:
        return message.strip() if message and message.strip() else (
            descriptor.remediation if descriptor else "The export failed."
        )
    if correlation_id:
        return (
            f"An internal error occurred while exporting this artifact "
            f"(correlation id: {correlation_id})."
        )
    return (
        "An internal error occurred while exporting this artifact. Retry once, "
        "and if it persists report the job id to support."
    )


def delivery_error_fields(
    code: str,
    message: str,
    *,
    context: Optional[Mapping[str, Any]] = None,
    correlation_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Build the field dict for an :class:`~app.export_job_engine.ExportJobError`.

    Unknown codes fall back to ``EXPORT_EXCEPTION`` so a failed job always carries
    a registered taxonomy code with non-empty remediation.
    """
    resolved = resolve_delivery_error_code(code) or "EXPORT_EXCEPTION"
    descriptor = descriptor_for(resolved)
    assert descriptor is not None
    safe_message = sanitize_delivery_message(
        resolved, message, correlation_id=correlation_id
    )
    fields: Dict[str, Any] = {
        "code": descriptor.code,
        "category": descriptor.category.value,
        "message": safe_message,
        "remediation": descriptor.remediation,
        "retriable": descriptor.retriable,
        "context": dict(context) if context else None,
        # Structural, not just embedded in internal-category message text (IXH-6.6):
        # the caller quotes it to correlate the failure with the job's log lines.
        "correlation_id": correlation_id,
    }
    return fields
