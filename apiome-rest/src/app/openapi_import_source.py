"""OpenAPI / Swagger import source — MFI-1.1 (#3733).

The reference :class:`~app.import_source.ImportSource` adapter and the seam the
existing OpenAPI/Swagger import path is refactored behind. It wraps machinery that
already exists rather than reimplementing it:

* **parse** reuses :func:`app.import_ingestion.parse_document` (the JSON-or-YAML
  loader the import pipeline already uses);
* **normalize** delegates to the registered OpenAPI
  :class:`~app.normalizer.Normalizer` (MFI-2.3,
  :class:`app.openapi_normalizer.OpenApiNormalizer`) — no normalization logic is
  duplicated here;
* **lint** delegates to the existing deterministic OpenAPI linter
  (:func:`app.schema_lint.lint_openapi_spec`) when the native OpenAPI document is
  preserved on :attr:`CanonicalApi.raw`;
* **fingerprint**/**diff** use the canonical-model defaults from
  :mod:`app.import_source`.

Because nothing in the live import flow is rewired by this adapter (generalizing
the job engine onto adapters is MFI-1.2), wrapping the OpenAPI path behind the SPI
is **behavior-preserving**: the same parser, normalizer, and linter run.

Detection recognizes both OpenAPI 3.x and Swagger 2.0 so each routes to this
adapter. Swagger 2.0 normalization is handled by
:class:`app.swagger2_normalizer.Swagger2Normalizer` (MFI-30.1); OpenAPI 3.x by
:class:`app.openapi_normalizer.OpenApiNormalizer` (MFI-2.3).

**Overlays (IXH-7.7).** The adapter is also the Overlay 1.0 pre-processor seam: a
fileset whose members carry an ``overlay`` version marker resolves base + overlays
through :func:`app.openapi_overlay.apply_overlays` before normalization, publishing
per-value provenance on the canonical model's extras (rendered by the preview
coverage ledger) and surfacing unapplied actions as ``intake.overlay-*`` lint
findings. A *bare* overlay — uploaded without its base — is detected and rejected
with the ``INPUT_OVERLAY_BASE_MISSING`` taxonomy code, whose remediation prompts
for the base document instead of failing with a parse error.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# Importing the normalizers self-registers format keys resolved by
# :meth:`OpenApiImportSource.normalize`.
from . import openapi_normalizer  # noqa: F401
from . import swagger2_normalizer  # noqa: F401
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .import_ingestion import IngestionError, parse_document
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
    LintReport,
)
from .openapi_overlay import (
    OVERLAY_EXTRA_KEY,
    OverlayedOpenApiDocument,
    apply_overlays,
    is_overlay_document,
    overlay_lint_findings,
    overlay_version,
)

__all__ = ["OpenApiImportSource"]


class OpenApiImportSource(ImportSource, register=True):
    """Adapter for OpenAPI 3.x / Swagger 2.0 REST descriptions."""

    key = "openapi"
    label = "OpenAPI / Swagger"
    description = "Import an OpenAPI 3.0/3.1/3.2 or Swagger 2.0 REST API description."
    icon = "file-json"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("openapi-3.0", "openapi-3.1", "openapi-3.2", "swagger-2.0")
    file_extensions = (".yaml", ".yml", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Recognize an OpenAPI/Swagger document by its version marker.

        Reads the already-parsed ``document`` when present, else parses ``text``
        cheaply (a malformed document is simply not a match — never raises). An
        ``openapi: 3.x`` marker pins ``openapi-3.0``/``openapi-3.1``/``openapi-3.2``
        with high confidence; a ``swagger: 2.x`` marker pins ``swagger-2.0``.

        An Overlay 1.0 document (``overlay: 1.x`` marker, IXH-7.7) is also claimed
        — with no ``format`` pinned, since an overlay is not itself an importable
        API description — so a bare overlay routes here and gets the
        "provide its base" guidance from :meth:`parse` instead of falling through
        to another sniffer or a generic parse error.
        """
        document = payload.document
        if document is None and payload.text:
            try:
                document = parse_document(payload.text, source_label=payload.filename)
            except IngestionError:
                return NO_MATCH
        if not isinstance(document, dict):
            return NO_MATCH

        version = document.get("openapi")
        if isinstance(version, str) and version.startswith("3."):
            if version.startswith("3.0"):
                fmt = "openapi-3.0"
            elif version.startswith("3.2"):
                fmt = "openapi-3.2"
            elif version.startswith("3.1"):
                fmt = "openapi-3.1"
            else:
                # Future 3.x minors normalize under the latest supported key.
                fmt = "openapi-3.2"
            return DetectionResult(
                confidence=0.99, format=fmt, reason=f"`openapi: {version}` marker"
            )

        swagger = document.get("swagger")
        if isinstance(swagger, str) and swagger.startswith("2."):
            return DetectionResult(
                confidence=0.95, format="swagger-2.0", reason=f"`swagger: {swagger}` marker"
            )

        version = overlay_version(document)
        if version is not None:
            return DetectionResult(
                confidence=0.9, reason=f"OpenAPI Overlay `overlay: {version}` marker"
            )

        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Any:
        """Parse OpenAPI/Swagger source text (JSON or YAML) into a ``dict``.

        Reuses the import pipeline's loader so YAML- and JSON-authored documents
        behave identically.

        Raises:
            ImportSourceError: If the text is not valid JSON/YAML or is not a
                mapping at the top level — or is a *bare* Overlay document
                (``INPUT_OVERLAY_BASE_MISSING``, IXH-7.7): an overlay modifies a
                base OpenAPI document, so importing one alone prompts for its base
                rather than failing downstream with a confusing "no version
                marker" error.
        """
        try:
            document = parse_document(raw, source_label=source_label)
        except IngestionError as exc:
            raise ImportSourceError(str(exc)) from exc
        if is_overlay_document(document):
            label = f" {source_label!r}" if source_label else ""
            raise ImportSourceError(
                f"Document{label} is an OpenAPI Overlay (overlay: "
                f"{overlay_version(document)}), which modifies a base OpenAPI "
                "document that was not provided. Provide the base document "
                "alongside the overlay (for example as an archive containing both).",
                code="INPUT_OVERLAY_BASE_MISSING",
            )
        return document

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> Any:
        """Parse a multi-document fileset: a base document plus Overlay 1.0 overlays.

        Members are classified by their version markers — exactly one member must
        be an OpenAPI/Swagger *base* (``openapi``/``swagger`` marker), any member
        with an ``overlay`` marker is an *overlay*, and anything else is left
        untouched (it may be a ``$ref`` target or a README riding in the archive;
        the report lists it as ignored). Overlays apply in member-path order —
        deterministic and directly controllable by naming (``01-…``, ``02-…``) —
        each seeing the previous one's result, per Overlay 1.0 ordering.

        The returned document is the resolved base with the application report
        attached (:class:`~app.openapi_overlay.OverlayedOpenApiDocument`), which
        :meth:`normalize` publishes on the canonical model's extras.

        Raises:
            ImportSourceError: When a member is not valid JSON/YAML
                (``INPUT_MALFORMED``); when the set has overlays but no base
                (``INPUT_OVERLAY_BASE_MISSING`` — the "provide a base" prompt);
                when it has no base and no overlays (``FORMAT_MISMATCH``); when it
                has more than one base (``INPUT_SEMANTIC_INVALID``); or when an
                overlay itself is structurally invalid (see
                :func:`~app.openapi_overlay.apply_overlays`).
        """
        documents: Dict[str, Any] = {}
        for path in sorted(fileset.members):
            try:
                documents[path] = parse_document(fileset.members[path], source_label=path)
            except IngestionError as exc:
                raise ImportSourceError(
                    f"Fileset member {path!r} is not valid JSON/YAML: {exc}",
                    code="INPUT_MALFORMED",
                ) from exc

        bases: List[Tuple[str, Dict[str, Any]]] = []
        overlays: List[Tuple[str, Dict[str, Any]]] = []
        ignored: List[str] = []
        for path, document in documents.items():
            if is_overlay_document(document):
                overlays.append((path, document))
            elif isinstance(document, dict) and (
                isinstance(document.get("openapi"), str)
                or isinstance(document.get("swagger"), str)
            ):
                bases.append((path, document))
            else:
                ignored.append(path)

        if not bases:
            if overlays:
                names = ", ".join(path for path, _ in overlays)
                raise ImportSourceError(
                    f"The fileset contains OpenAPI Overlay document(s) ({names}) but "
                    "no base OpenAPI document to apply them to. Add the base "
                    "document to the upload.",
                    code="INPUT_OVERLAY_BASE_MISSING",
                )
            raise ImportSourceError(
                "No member of the fileset is an OpenAPI/Swagger document "
                "(no `openapi`/`swagger` version marker).",
                code="FORMAT_MISMATCH",
            )
        if len(bases) > 1:
            names = ", ".join(path for path, _ in bases)
            raise ImportSourceError(
                f"The fileset contains more than one base OpenAPI document ({names}); "
                "an overlay import needs exactly one base.",
                code="INPUT_SEMANTIC_INVALID",
            )

        base_path, base_document = bases[0]
        if not overlays:
            return base_document

        application = apply_overlays(base_document, overlays)
        resolved = OverlayedOpenApiDocument(application.document)
        resolved.overlay_report = {
            **application.report(),
            "base": base_path,
            "ignored_members": sorted(ignored),
        }
        return resolved

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed OpenAPI/Swagger document into a :class:`CanonicalApi`.

        Detects the precise format and delegates to its registered normalizer.

        Raises:
            ImportSourceError: If ``native_ast`` is not a mapping, is not an
                OpenAPI/Swagger document, or names a format with no registered
                normalizer.
        """
        if not isinstance(native_ast, dict):
            raise ImportSourceError("OpenAPI/Swagger source must be a parsed mapping (dict)")

        detection = self.detect(DetectionInput(document=native_ast))
        if detection.format is None:
            raise ImportSourceError(
                "Document is not an OpenAPI 3.x or Swagger 2.0 description "
                "(no `openapi`/`swagger` version marker)"
            )
        model = self._normalize_via_registry(
            detection.format, native_ast, include_raw=include_raw
        )
        # IXH-7.7: an overlay-resolved document carries its application report; publish
        # it on the model's extras so the preview coverage ledger can render per-value
        # provenance and the lint path can surface unapplied actions as findings.
        report = getattr(native_ast, "overlay_report", None)
        if isinstance(report, dict) and isinstance(model.extras, dict):
            model.extras[OVERLAY_EXTRA_KEY] = report
        return model

    def lint(self, model: CanonicalApi) -> LintReport:
        """Lint via the existing OpenAPI linter when the native document is present.

        The deterministic OpenAPI linter (:func:`app.schema_lint.lint_openapi_spec`)
        operates on an OpenAPI document, which the normalizer preserves on
        :attr:`CanonicalApi.raw`. Its result is adapted into a :class:`LintReport` via
        :meth:`LintReport.from_lint_result`, so the report carries the same score, grade,
        and stable ``report_fingerprint`` the schema linter computes (MFI-4.2).

        When ``raw`` is absent (``include_raw=False`` at normalize time) or is not an OpenAPI
        document, the canonical-model engine default (:meth:`ImportSource.lint`) is used, so
        the revision is still rolled up to a deterministic score rather than left unscored.

        Overlay findings (IXH-7.7) — actions whose target matched nothing, or that were
        structurally unusable — are merged into the report under the registered
        ``intake.overlay-*`` rules on either path, so an overlay mistake is a visible,
        governable finding rather than a silently skipped modification.
        """
        raw = model.raw
        if not isinstance(raw, dict) or not isinstance(raw.get("openapi"), str):
            report = super().lint(model)
        else:
            # Imported lazily: the linter pulls in the schema-lint rule catalogue,
            # which is only needed on the lint path.
            from .schema_lint import lint_openapi_spec

            report = LintReport.from_lint_result(lint_openapi_spec(raw))

        overlay_report = (
            model.extras.get(OVERLAY_EXTRA_KEY) if isinstance(model.extras, dict) else None
        )
        if isinstance(overlay_report, dict):
            report = report.with_extra_findings(overlay_lint_findings(overlay_report))
        return report
