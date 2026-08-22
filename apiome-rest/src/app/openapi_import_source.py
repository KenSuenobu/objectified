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

**Swagger 1.2 (FMT-3.6).** The adapter also reads the version *below* 2.0. Swagger
1.2 is a resource listing plus one API declaration per resource, which
:mod:`app.swagger12_projection` rewrites onto the Swagger 2.0 document shape before
anything else runs — so a 1.2 upload is normalized, linted, and routed by the code
that already reads 2.0, and its canonical ``format`` is ``swagger-2.0``. The 1.2
provenance (source version, the declarations merged, and the constructs 2.0 cannot
hold) rides on the projected document and is published on the canonical model's
extras under ``swagger_1_2``.

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
from . import (
    openapi_normalizer,  # noqa: F401
    swagger2_normalizer,  # noqa: F401
)
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
from .swagger12_projection import (
    Swagger12Error,
    declaration_resource,
    is_resource_listing,
    is_swagger12_document,
    project_swagger12,
    swagger12_version,
)

__all__ = ["OpenApiImportSource", "SWAGGER_12_EXTRA_KEY"]

#: Canonical-model extras key carrying a Swagger 1.2 import's provenance (FMT-3.6).
SWAGGER_12_EXTRA_KEY = "swagger_1_2"


class OpenApiImportSource(ImportSource, register=True):
    """Adapter for OpenAPI 3.x / Swagger 2.0 / Swagger 1.2 REST descriptions."""

    key = "openapi"
    label = "OpenAPI / Swagger"
    description = (
        "Import an OpenAPI 3.0/3.1/3.2, Swagger 2.0 or Swagger 1.2 REST API description."
    )
    icon = "file-json"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("openapi-3.0", "openapi-3.1", "openapi-3.2", "swagger-2.0", "swagger-1.2")
    file_extensions = (".yaml", ".yml", ".json")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Recognize an OpenAPI/Swagger document by its version marker.

        Reads the already-parsed ``document`` when present, else parses ``text``
        cheaply (a malformed document is simply not a match — never raises). An
        ``openapi: 3.x`` marker pins ``openapi-3.0``/``openapi-3.1``/``openapi-3.2``
        with high confidence; a ``swagger: 2.x`` marker pins ``swagger-2.0``; a
        ``swaggerVersion: 1.2`` marker pins ``swagger-1.2`` (FMT-3.6), which the
        adapter reads by projecting onto the 2.0 path. Swagger 1.0/1.1 share that
        marker but not the grammar, so they are deliberately *not* claimed here —
        routed to this adapter explicitly they fail as ``FORMAT_VERSION_UNSUPPORTED``
        rather than being mis-read as 1.2.

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

        if is_swagger12_document(document):
            shape = (
                "resource listing" if is_resource_listing(document) else "API declaration"
            )
            return DetectionResult(
                confidence=0.95,
                format="swagger-1.2",
                reason=f"`swaggerVersion: 1.2` marker ({shape})",
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

        A Swagger 1.2 document (FMT-3.6) is projected onto the 2.0 shape here, so
        everything downstream — normalization, lint, routing — sees an ordinary
        Swagger 2.0 mapping. A 1.2 *resource listing* cannot be imported alone: it
        only names its declarations, so it fails with
        ``INPUT_REFERENCE_UNRESOLVED`` and the "upload them together" prompt.

        Raises:
            ImportSourceError: If the text is not valid JSON/YAML or is not a
                mapping at the top level — or is a *bare* Overlay document
                (``INPUT_OVERLAY_BASE_MISSING``, IXH-7.7): an overlay modifies a
                base OpenAPI document, so importing one alone prompts for its base
                rather than failing downstream with a confusing "no version
                marker" error — or is a Swagger 1.x document this adapter cannot
                project (see :func:`app.swagger12_projection.project_swagger12` for
                the codes it raises).
        """
        try:
            document = parse_document(raw, source_label=source_label)
        except IngestionError as exc:
            raise ImportSourceError(str(exc)) from exc
        if swagger12_version(document) is not None:
            return self._project_swagger12(document, source_label=source_label)
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

        A set whose members carry the Swagger 1.2 marker takes the FMT-3.6 route
        instead: the *resource listing* is the root and every API declaration
        beside it is merged into one projected Swagger 2.0 document, so a 1.2 API
        published as a listing plus N declarations imports as **one** API. A set of
        declarations with no listing merges just the same.

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

        swagger12 = [
            (path, document)
            for path, document in documents.items()
            if swagger12_version(document) is not None
        ]
        if swagger12:
            return self._project_swagger12_fileset(swagger12, source_label=source_label)

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

    @staticmethod
    def _project_swagger12(
        document: Dict[str, Any],
        *,
        declarations: Optional[List[Tuple[str, Dict[str, Any]]]] = None,
        source_label: Optional[str] = None,
    ) -> Any:
        """Project a Swagger 1.x document onto the Swagger 2.0 shape (FMT-3.6).

        Args:
            document: The parsed root — a 1.2 resource listing or API declaration.
            declarations: The listing's declarations as ``(member path, document)``
                pairs, when the import is a fileset.
            source_label: Label used only to make error messages specific.

        Returns:
            The projected :class:`~app.swagger12_projection.Swagger12ProjectedDocument`.

        Raises:
            ImportSourceError: Carrying the projection's own taxonomy code, so an
                unsupported 1.x revision, an empty listing, and a listing whose
                declarations were not uploaded each report as themselves.
        """
        try:
            return project_swagger12(
                document,
                declarations=tuple(declarations or ()),
                source_label=source_label,
            )
        except Swagger12Error as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def _project_swagger12_fileset(
        self,
        members: List[Tuple[str, Dict[str, Any]]],
        *,
        source_label: Optional[str] = None,
    ) -> Any:
        """Project a Swagger 1.2 fileset (resource listing + declarations) as one API.

        The listing is the root when the set has one; otherwise the declarations
        merge on their own, in member-path order, which is deterministic and
        directly controllable by naming.

        Args:
            members: Every 1.2 member as ``(member path, parsed document)``, in
                member-path order.
            source_label: Label used only to make error messages specific.

        Returns:
            The projected :class:`~app.swagger12_projection.Swagger12ProjectedDocument`.

        Raises:
            ImportSourceError: With the projection's own taxonomy code — including
                ``INPUT_REFERENCE_UNRESOLVED`` when the listing names a resource no
                member declares.
        """
        listings = [(path, doc) for path, doc in members if is_resource_listing(doc)]
        declarations = [(path, doc) for path, doc in members if not is_resource_listing(doc)]

        if not listings:
            root_path, root_document = declarations[0]
            return self._project_swagger12(
                root_document,
                declarations=declarations[1:],
                source_label=root_path or source_label,
            )

        listing_path, listing = listings[0]
        if len(listings) > 1:
            names = ", ".join(path for path, _ in listings)
            raise ImportSourceError(
                f"The fileset contains more than one Swagger 1.2 resource listing "
                f"({names}); a 1.2 import needs exactly one.",
                code="INPUT_SEMANTIC_INVALID",
            )
        self._require_declared_resources(listing, declarations, source_label=listing_path)
        return self._project_swagger12(
            listing, declarations=declarations, source_label=listing_path or source_label
        )

    @staticmethod
    def _require_declared_resources(
        listing: Dict[str, Any],
        declarations: List[Tuple[str, Dict[str, Any]]],
        *,
        source_label: Optional[str],
    ) -> None:
        """Fail when a resource listing names a resource no member declares.

        A 1.2 listing's ``apis[].path`` is a *reference* to a declaration document.
        A member is taken to answer it when its ``resourcePath`` matches, or — for
        exports that drop ``resourcePath`` — when its filename stem does.

        Args:
            listing: The parsed resource listing.
            declarations: Every declaration member as ``(member path, document)``.
            source_label: The listing's member path, for the error message.

        Raises:
            ImportSourceError: ``INPUT_REFERENCE_UNRESOLVED`` naming the resources
                whose declarations are missing.
        """
        resolved = set()
        for path, declaration in declarations:
            resource = declaration_resource(declaration)
            if resource:
                resolved.add(resource.strip("/").lower())
            stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            if stem:
                resolved.add(stem.strip("/").lower())

        missing = [
            path
            for api in listing.get("apis") or []
            if isinstance(api, dict)
            for path in [api.get("path")]
            if isinstance(path, str) and path.strip()
            and path.strip().strip("/").lower() not in resolved
        ]
        if missing:
            where = f" {source_label!r}" if source_label else ""
            names = ", ".join(missing)
            raise ImportSourceError(
                f"The Swagger 1.2 resource listing{where} names {names}, for which the "
                "upload contains no API declaration. Add the missing declaration "
                "file(s) to the upload.",
                code="INPUT_REFERENCE_UNRESOLVED",
            )

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a parsed OpenAPI/Swagger document into a :class:`CanonicalApi`.

        Detects the precise format and delegates to its registered normalizer. A
        Swagger 1.2 document that reaches this method unprojected (``normalize``
        called without ``parse``, as the conversion and preview paths may) is
        projected here first, so the 1.2 grammar has exactly one reader.

        Raises:
            ImportSourceError: If ``native_ast`` is not a mapping, is not an
                OpenAPI/Swagger document, or names a format with no registered
                normalizer.
        """
        if not isinstance(native_ast, dict):
            raise ImportSourceError("OpenAPI/Swagger source must be a parsed mapping (dict)")
        if swagger12_version(native_ast) is not None:
            native_ast = self._project_swagger12(native_ast)

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
        # FMT-3.6: a projected Swagger 1.2 import normalizes as Swagger 2.0 (which is
        # what keeps it publishable and lintable); its 1.2 provenance is published here
        # so the model still states which version, and which declarations, it came from.
        provenance = getattr(native_ast, "swagger12_provenance", None)
        if provenance is not None and isinstance(model.extras, dict):
            model.extras[SWAGGER_12_EXTRA_KEY] = provenance.as_extras()
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
