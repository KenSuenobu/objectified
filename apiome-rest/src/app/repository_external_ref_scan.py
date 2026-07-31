"""Scan-time enforcement of the tenant external ``$ref`` policy — REPO-3.9 (#2778).

:mod:`app.repository_external_ref_policy` decides *what a tenant permits*;
:mod:`app.remote_ref_resolver` knows *how to fetch safely*. This module is the thin seam
between them and the repository scanner: given one discovered file's document, it

1. loads the tenant's policy (fail-closed to ``block``),
2. runs the shared resolver with that policy as its per-URL gate — so ``block`` fetches
   nothing, ``inline`` snapshots what it fetches into the document, and ``proxy-fetch`` does
   the same but only for allowlisted hosts,
3. writes one ``repository.external_ref_fetched`` audit row per reference obtained, and
4. attaches (or clears) the file row's ``external_ref_warning``, itemizing what is still
   unresolved and why.

Two properties the callers depend on:

* **Never raises.** Every step is best-effort. A store fault, a resolver fault, or an audit
  fault degrades to "the document is unchanged and the file keeps whatever warning it had".
  Nothing here may fail a scan, a refresh, or an import — the policy governs *fetching*, and
  a file whose references were blocked is still indexed, still scored, and still importable.
* **Only ever fetches less.** The gate is consulted before the resolver's cache and before
  any HTTP client exists, and everything it allows still passes the SSRF guard. The
  deployment kill switch (``APIOME_REMOTE_REF_RESOLUTION_ALLOWED=false``) overrides every
  tenant policy.

The one caller today is the REPO-2.8 quality sweep (:mod:`app.repository_quality_sweep`),
which is the scanner's only pass that holds a discovered file's *content*. Hosting the step
there means a scanned file costs one download, not two — and it means the step runs only
while spec scoring is enabled.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .config import settings
from .repository_external_ref_policy import (
    DEFAULT_POLICY,
    ExternalRefPolicy,
    build_gate,
    build_warning,
    load_tenant_policy,
    record_external_ref_fetched,
)

logger = logging.getLogger(__name__)

__all__ = [
    "ExternalRefScanOutcome",
    "apply_external_ref_policy",
    "apply_policy_to_document_text",
]


@dataclass(frozen=True)
class ExternalRefScanOutcome:
    """What the policy did to one scanned file.

    Attributes:
        policy: The policy that applied.
        documents: Label → document, rewritten where references were inlined. The caller's
            objects are returned untouched where nothing changed.
        changed_documents: Labels whose document was rewritten (the ``inline`` snapshot).
        resolved_count: References fetched (or served from the resolver's cache) and inlined.
        unresolved_count: References left in place.
        audited_count: Audit rows written — one per reference obtained.
        warning: The payload written to the file row, or ``None`` when nothing is
            unresolved (which clears any previous warning).
        skipped_reason: Why the step did nothing, when it did nothing (``no-refs``,
            ``no-documents``, ``error``); ``None`` when it ran.
    """

    policy: ExternalRefPolicy = DEFAULT_POLICY
    documents: Dict[str, Any] = field(default_factory=dict)
    changed_documents: Tuple[str, ...] = ()
    resolved_count: int = 0
    unresolved_count: int = 0
    audited_count: int = 0
    warning: Optional[Dict[str, Any]] = None
    skipped_reason: Optional[str] = None

    @property
    def changed(self) -> bool:
        """Whether any document was rewritten with an inlined snapshot."""
        return bool(self.changed_documents)


def apply_external_ref_policy(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    branch: str,
    path: str,
    documents: Mapping[str, Any],
    file_id: Optional[str] = None,
    project_id: Optional[str] = None,
    actor_id: Optional[str] = None,
    policy: Optional[ExternalRefPolicy] = None,
    persist_warning: bool = True,
    **resolver_kwargs: Any,
) -> ExternalRefScanOutcome:
    """Apply the tenant's external ``$ref`` policy to one scanned file's documents.

    Args:
        db: Database handle (policy read, audit rows, warning write). May be ``None`` in a
            pure unit test, in which case the caller must pass ``policy`` and
            ``persist_warning=False``.
        tenant_id: The tenant owning the repository.
        repository_id: The repository the file belongs to.
        branch: The branch the file was scanned on.
        path: The repository-relative file path.
        documents: Label → parsed document. A single document uses the ``""`` label, which
            is what :func:`apply_policy_to_document_text` passes.
        file_id: The ``tenant_repository_files`` row id; required to persist a warning.
        project_id: Catalog project the scan feeds, recorded on the audit rows when known.
        actor_id: The user who triggered the scan; ``None`` for a background sweep.
        policy: Pre-resolved policy; omit to load the tenant's.
        persist_warning: Whether to write the warning to the file row. ``False`` computes it
            without touching the database.
        **resolver_kwargs: Forwarded to
            :func:`app.remote_ref_resolver.resolve_remote_refs` (``budget``, ``cache``,
            ``fetcher``) — tests substitute a fetcher here.

    Returns:
        The :class:`ExternalRefScanOutcome`. Never raises.
    """
    effective_policy = policy if policy is not None else load_tenant_policy(tenant_id, db=db)
    docs = dict(documents or {})
    if not docs:
        return ExternalRefScanOutcome(
            policy=effective_policy, documents=docs, skipped_reason="no-documents"
        )

    try:
        # Imported here rather than at module scope: the resolver pulls in httpx and the
        # ingestion machinery, and a scan tick with no external references should not pay
        # for either.
        from .remote_ref_resolver import resolve_remote_refs, scan_external_refs

        if not scan_external_refs(docs):
            # The overwhelmingly common case. Still clear a stale warning: the file may have
            # dropped its external references since the last scan.
            _persist(db, file_id, None, persist_warning=persist_warning)
            return ExternalRefScanOutcome(
                policy=effective_policy, documents=docs, skipped_reason="no-refs"
            )

        audited: List[str] = []

        def on_fetch(url: str, digest: str, fetched: int, from_cache: bool) -> None:
            record_external_ref_fetched(
                db,
                tenant_id=tenant_id,
                repository_id=repository_id,
                branch=branch,
                path=path,
                url=url,
                policy=effective_policy,
                digest=digest,
                bytes_fetched=fetched,
                from_cache=from_cache,
                file_id=file_id,
                project_id=project_id,
                actor_id=actor_id,
            )
            audited.append(url)

        outcome = resolve_remote_refs(
            docs,
            enabled=True,
            gate=build_gate(
                effective_policy,
                resolution_allowed=bool(settings.remote_ref_resolution_allowed),
            ),
            on_fetch=on_fetch,
            **resolver_kwargs,
        )
    except Exception:  # noqa: BLE001 - a policy fault must never fail a scan
        logger.warning(
            "external $ref policy could not be applied to %s (%s@%s)",
            path,
            repository_id,
            branch,
            exc_info=True,
        )
        return ExternalRefScanOutcome(
            policy=effective_policy, documents=docs, skipped_reason="error"
        )

    warning = build_warning(effective_policy, outcome.unresolved)
    _persist(db, file_id, warning, persist_warning=persist_warning)
    return ExternalRefScanOutcome(
        policy=effective_policy,
        documents=outcome.documents,
        changed_documents=tuple(outcome.changed_documents),
        resolved_count=len(outcome.resolved),
        unresolved_count=len(outcome.unresolved),
        audited_count=len(audited),
        warning=warning,
    )


def _persist(
    db: Any, file_id: Optional[str], warning: Optional[Dict[str, Any]], *, persist_warning: bool
) -> None:
    """Write the warning (or the clear) to the file row, swallowing store faults."""
    if not persist_warning or not file_id or db is None:
        return
    try:
        db.set_repository_file_external_ref_warning(str(file_id), warning)
    except Exception:  # noqa: BLE001 - the warning is informational; the scan matters more
        logger.warning(
            "could not persist the external $ref warning for file %s", file_id, exc_info=True
        )


def apply_policy_to_document_text(
    db: Any,
    *,
    tenant_id: str,
    repository_id: str,
    branch: str,
    path: str,
    text: str,
    file_id: Optional[str] = None,
    project_id: Optional[str] = None,
    actor_id: Optional[str] = None,
    policy: Optional[ExternalRefPolicy] = None,
    persist_warning: bool = True,
    **resolver_kwargs: Any,
) -> Tuple[str, ExternalRefScanOutcome]:
    """Apply the policy to one file's *text*, returning the text the scan should read on.

    A convenience wrapper for the scanner, which holds file content rather than parsed
    documents. The returned text differs from the input only when a fetching policy actually
    inlined something — the ``inline`` snapshot — in which case it is the rewritten document
    re-serialized as JSON. Key order is preserved (never sorted), matching what the import
    pipeline does with a resolved intake, so the snapshot describes the same model in the
    same order.

    A document that is not JSON/YAML, or does not parse, yields the original text and a
    ``skipped_reason`` — reporting a parse error is the scoring engine's job, not this
    step's.

    Args:
        db: Database handle; see :func:`apply_external_ref_policy`.
        tenant_id: The tenant owning the repository.
        repository_id: The repository the file belongs to.
        branch: The branch the file was scanned on.
        path: The repository-relative file path (also the parser's source label).
        text: The file's content as fetched by the scanner.
        file_id: The ``tenant_repository_files`` row id.
        project_id: Catalog project the scan feeds, when known.
        actor_id: The user who triggered the scan; ``None`` for a background sweep.
        policy: Pre-resolved policy; omit to load the tenant's.
        persist_warning: Whether to write the warning to the file row.
        **resolver_kwargs: Forwarded to the resolver (``budget``, ``cache``, ``fetcher``).

    Returns:
        ``(text, outcome)`` — the possibly-rewritten text and the
        :class:`ExternalRefScanOutcome`. Never raises.
    """
    source = text if isinstance(text, str) else ""
    if not source.strip():
        return source, ExternalRefScanOutcome(
            policy=policy or DEFAULT_POLICY, skipped_reason="no-documents"
        )

    try:
        from .import_ingestion import IngestionError, parse_document
        from .intake_resource_guard import IntakeLimitError

        document = parse_document(source, source_label=path)
    except Exception as exc:  # noqa: BLE001 - an unparseable file is ordinary here
        if not isinstance(exc, (IngestionError, IntakeLimitError)):
            logger.warning("external $ref policy could not parse %s", path, exc_info=True)
        return source, ExternalRefScanOutcome(
            policy=policy or DEFAULT_POLICY, skipped_reason="no-documents"
        )

    outcome = apply_external_ref_policy(
        db,
        tenant_id=tenant_id,
        repository_id=repository_id,
        branch=branch,
        path=path,
        documents={"": document},
        file_id=file_id,
        project_id=project_id,
        actor_id=actor_id,
        policy=policy,
        persist_warning=persist_warning,
        **resolver_kwargs,
    )
    if not outcome.changed:
        return source, outcome
    try:
        return json.dumps(outcome.documents[""], separators=(",", ":")), outcome
    except (TypeError, ValueError):  # pragma: no cover - a parsed document is serializable
        logger.warning("could not serialize the inlined snapshot for %s", path, exc_info=True)
        return source, outcome
