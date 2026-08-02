"""
Quality-scoring / linting API: deterministic score + itemized findings for a schema revision.

Replaces the old client-side (localStorage) quality score with a real service (#3609). The
generated OpenAPI document for a version is reconstructed via the shared
``openapi_for_revision`` helper and fed to the deterministic :mod:`app.schema_lint` engine.
Breaking-change risk can optionally be folded in by comparing against a base revision using the
existing :mod:`app.compatibility_engine`.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from .auth import validate_authentication, validate_session_credentials
from .axis_score import catalog_axis_evaluation
from .compatibility_engine import CompatibilityCheckEngine, openapi_for_revision
from .config import settings
from .custom_rule_dsl import CustomRuleValidationError, parse_style_guide_yaml
from .database import db
from .gate_report_emit import GATE_FORMAT_JSON, normalize_gate_format
from .import_routing import PUBLISHABLE_FORMATS
from .lint_evidence import SUBJECT_CATALOG_REVISION
from .lint_gate import evaluate_lint_gate, gate_payload
from .lint_gate_emit import serialize_lint_gate
from .lint_policy_service import evaluate_catalog_revision_policy
from .lint_rule_registry import LINT_RULE_DOCS_PAGE, builtin_rule_descriptors, builtin_rule_ids
from .lint_workspace import (
    ACTION_PUBLISH,
    required_action_for_transition,
    transition_error,
)
from .models import (
    CustomRuleOut,
    CustomRulesValidateRequest,
    CustomRulesValidateResponse,
    CustomRuleThenOut,
    ExternalLintAdapterOut,
    ExternalLintAdaptersResponse,
    FormatLintCapabilitiesResponse,
    FormatLintCapabilityOut,
    LintAxesResponse,
    LintCategoryScoreOut,
    LintEvidenceResponse,
    LintFindingDecisionEventOut,
    LintFindingDecisionListResponse,
    LintFindingDecisionOut,
    LintFindingDecisionUpsertRequest,
    LintFindingOut,
    LintGateResponse,
    LintPolicyResponse,
    LintReportResponse,
    LintRuleCatalogResponse,
    LintRuleOut,
    SpectralImportBuiltinRuleOut,
    SpectralImportEntryOut,
    SpectralImportExtendsOut,
    SpectralImportRequest,
    SpectralImportResponse,
    lint_axis_evaluation_out_from_row,
    lint_axis_fields_from_evaluation,
    lint_evidence_response_from_rows,
    lint_finding_decision_out_from_row,
)
from .permissions import Action, Resource, enforce_permission
from .policy_evaluate import match_decision_for_fingerprint
from .schema_lint import merge_compatibility_findings
from .spectral_import import (
    SpectralImportError,
    fetch_spectral_ruleset,
    import_spectral_ruleset,
)
from .style_guide_engine import guided_lint_openapi_spec
from .style_guide_revisions import pin_guide_revision_id

router = APIRouter(prefix="/v1/versions", tags=["lint"])
decisions_router = APIRouter(prefix="/v1/lint/decisions", tags=["lint-decisions"])

# The rule-catalog registry (GOV-1.2) is not version-scoped, so it lives under its own prefix.
rules_router = APIRouter(prefix="/v1/lint", tags=["lint"])


@rules_router.get("/rules", response_model=LintRuleCatalogResponse)
async def list_lint_rules(
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> LintRuleCatalogResponse:
    """
    List every registered built-in lint rule (GOV-1.2, #4428).

    Returns the full rule-catalog registry: each rule's stable id (the exact string lint
    findings carry in their ``rule`` field), its pack, category, default severity, one-line
    rationale, and a docs anchor into the rule reference page. Sorted by rule id, so the
    payload is deterministic. The catalog is the same for every tenant — style guides
    (GOV-1.1/GOV-1.4) layer per-tenant enable/disable and severity overrides on top of it.
    """
    descriptors = builtin_rule_descriptors()
    rules = []
    for d in descriptors:
        payload = d.as_dict()
        rules.append(
            LintRuleOut(
                rule_id=d.rule_id,
                pack=d.pack,
                category=d.category,
                default_severity=d.default_severity,
                rationale=d.rationale,
                docs_anchor=d.docs_anchor,
                reference=payload.get("reference"),
                remediation=payload.get("remediation"),
                false_positive_guidance=payload.get("false_positive_guidance"),
                fixture_id=payload.get("fixture_id"),
                scan_modes=payload.get("scan_modes"),
            )
        )
    return LintRuleCatalogResponse(rules=rules, count=len(rules), docs_page=LINT_RULE_DOCS_PAGE)


@rules_router.get("/external-adapters", response_model=ExternalLintAdaptersResponse)
async def list_external_lint_adapters(
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> ExternalLintAdaptersResponse:
    """Discover Spectral / Vacuum / Redocly OpenAPI validation packs (CLX-2.2 / #4852)."""
    _ = auth_data
    from .openapi_validation_pack import (
        DEFAULT_BULK_RUNNER,
        list_openapi_validation_adapters,
        parity_default_runner_rationale,
    )
    from .openapi_validation_profiles import VALIDATION_PROFILES

    adapters_raw = list_openapi_validation_adapters()
    adapters = [ExternalLintAdapterOut(**a) for a in adapters_raw]
    return ExternalLintAdaptersResponse(
        adapters=adapters,
        count=len(adapters),
        default_bulk_runner=DEFAULT_BULK_RUNNER,
        profiles=list(VALIDATION_PROFILES),
        rationale=parity_default_runner_rationale(),
    )


_FORMAT_CAPABILITIES_DOCS = "apiome-rest/docs/format_lint_capabilities.md"


@rules_router.get("/format-capabilities", response_model=FormatLintCapabilitiesResponse)
async def list_format_lint_capabilities(
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> FormatLintCapabilitiesResponse:
    """Publish the per-format lint capability matrix (CLX-2.4 / #4854).

    Every sniffed / importable format reports ``native``, ``adapted``, or
    ``unsupported``. Unsupported planned packs link their existing MFI issues
    rather than duplicating parser/normalizer work.
    """
    _ = auth_data
    from .format_lint_capabilities import capability_dicts

    rows = capability_dicts()
    formats = [FormatLintCapabilityOut(**row) for row in rows]
    return FormatLintCapabilitiesResponse(
        formats=formats,
        count=len(formats),
        docs_page=_FORMAT_CAPABILITIES_DOCS,
    )


@rules_router.post(
    "/custom-rules/validate",
    response_model=CustomRulesValidateResponse,
    responses={
        422: {
            "description": "Malformed guide: `detail.message` explains the problem and "
            "`detail.pointer` points at the offending YAML node (e.g. "
            "`rules.my-rule.then.functionOptions.match`)."
        }
    },
)
async def validate_custom_rules(
    payload: CustomRulesValidateRequest,
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> CustomRulesValidateResponse:
    """
    Strictly validate a custom-rule style guide (GOV-1.3, #4429).

    Accepts the Spectral-compatible subset DSL: a YAML document with `rules.<id>:
    {description, severity, given, then}` where `then` uses the core functions `pattern`,
    `casing`, `enumeration`, `truthy`, `defined`, `undefined`, and `length`. On success the
    parsed rules are echoed back (the shape stored in `style_guide_rules.custom_def`).
    A malformed guide returns HTTP 422 whose `detail` carries a `message` and a `pointer`
    to the offending definition. Custom rule ids may not shadow built-in rule ids.
    """
    try:
        ruleset = parse_style_guide_yaml(
            payload.yaml, reserved_rule_ids=frozenset(builtin_rule_ids())
        )
    except CustomRuleValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={"message": exc.message, "pointer": exc.pointer},
        ) from exc

    rules = [
        CustomRuleOut(
            rule_id=rule.rule_id,
            description=rule.description,
            severity=rule.severity,
            given=list(rule.given),
            then=[
                CustomRuleThenOut(
                    field=t.field,
                    function=t.function,
                    function_options=dict(t.function_options),
                )
                for t in rule.then
            ],
        )
        for rule in ruleset.rules
    ]
    return CustomRulesValidateResponse(valid=True, count=len(rules), rules=rules)


@rules_router.post(
    "/custom-rules/import",
    response_model=SpectralImportResponse,
    responses={
        400: {
            "description": "The ruleset could not be read: empty, invalid YAML, not a mapping, "
            "oversized, or (for `url`) unfetchable / blocked by the SSRF guard."
        }
    },
)
async def import_spectral_ruleset_document(
    payload: SpectralImportRequest,
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> SpectralImportResponse:
    """
    Import a Spectral ruleset (GOV-1.5, #4431).

    Accepts a `.spectral.yaml` document (`content` — a paste or an uploaded file's text) or a
    `url` to fetch one from, and translates it into Apiome governance state: `extends:
    spectral:oas` resolves onto the built-in rule catalog (GOV-1.2), custom rule definitions are
    translated into the custom-rule DSL (GOV-1.3), and everything the subset cannot express is
    listed in `entries` with a machine-readable `reason`. Lossy-but-successful translations
    carry `notes`, so coverage is transparent rather than silently partial.

    Nothing is persisted: `yaml` is ready for
    `PUT /v1/style-guides/{tenantSlug}/{guideId}/custom-rules` and `builtinRules` for
    `PUT /v1/style-guides/{tenantSlug}/{guideId}/rules`.
    """
    _ = auth_data
    text = payload.content or ""
    source_label = payload.source_label
    if payload.url:
        try:
            text, resolved = fetch_spectral_ruleset(payload.url.strip())
        except SpectralImportError as exc:
            raise HTTPException(status_code=400, detail=exc.message) from exc
        source_label = source_label or resolved

    try:
        result = import_spectral_ruleset(
            text,
            source_label=source_label,
            reserved_rule_ids=frozenset(builtin_rule_ids()),
        )
    except SpectralImportError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc

    return SpectralImportResponse(
        source_label=result.source_label,
        rule_count=result.rule_count,
        mapped_count=result.mapped_count,
        unsupported_count=result.unsupported_count,
        coverage=result.coverage,
        custom_rule_count=len(result.custom_rules.rules),
        yaml=result.yaml,
        builtin_rules=[
            SpectralImportBuiltinRuleOut(
                rule_id=row.rule_id,
                enabled=row.enabled,
                severity=row.severity,
                source_rule_id=row.source_rule_id,
            )
            for row in result.builtin_rules
        ],
        entries=[
            SpectralImportEntryOut(
                source_rule_id=entry.source_rule_id,
                outcome=entry.outcome,
                rule_id=entry.rule_id,
                builtin_rule_ids=list(entry.builtin_rule_ids),
                severity=entry.severity,
                enabled=entry.enabled,
                reason=entry.reason,
                detail=entry.detail,
                pointer=entry.pointer,
                notes=list(entry.notes),
            )
            for entry in result.entries
        ],
        extends=[
            SpectralImportExtendsOut(
                target=item.target,
                supported=item.supported,
                modifier=item.modifier,
                mapped_rule_count=item.mapped_rule_count,
                reason=item.reason,
                detail=item.detail,
            )
            for item in result.extends
        ],
        notes=list(result.notes),
    )


def _coerce_quality_report(raw: Any) -> Dict[str, Any]:
    """Normalize ``quality_report`` from the DB (dict or JSON string) to a dict."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        import json

        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def lint_report_response_from_persisted_dict(
    *,
    version: Dict[str, Any],
    project_id: str,
    report: Dict[str, Any],
    captured: Optional[Dict[str, Any]] = None,
    base_revision_id: Optional[str] = None,
    compatibility_overall: Optional[str] = None,
    guide: Optional[Any] = None,
) -> LintReportResponse:
    """Build a :class:`LintReportResponse` from a persisted ``quality_report`` dict.

    The import-time report and the MCP ``mcp_version_scores.report`` JSONB share the same key
    set (score/grade/fingerprint/tallies/findings/categories), so stored reports flow through
    one shaping path.
    """
    findings_out = [
        LintFindingOut(
            id=str(f.get("id") or ""),
            path=str(f.get("path") or ""),
            category=str(f.get("category") or ""),
            rule=str(f.get("rule") or ""),
            severity=str(f.get("severity") or "info"),
            message=str(f.get("message") or ""),
        )
        for f in (report.get("findings") or [])
        if isinstance(f, dict)
    ]
    fingerprint = str(report.get("report_fingerprint") or "")
    score = int(report.get("score") or 0)
    grade = str(report.get("grade") or "F")
    captured = captured or {}
    captured_score = captured.get("quality_score")
    captured_grade = captured.get("quality_grade")
    captured_fingerprint = captured.get("quality_report_fingerprint")

    # Merge compatibility context into the report for axis evaluation when available.
    axis_report = dict(report)
    if base_revision_id and "base_revision_id" not in axis_report:
        axis_report["base_revision_id"] = base_revision_id
    if compatibility_overall and "compatibility_overall" not in axis_report:
        axis_report["compatibility_overall"] = compatibility_overall
    axis_eval = catalog_axis_evaluation(axis_report).as_dict()
    return LintReportResponse(
        project_id=project_id,
        version_record_id=version["id"],
        version_id=version["version_id"],
        score=score,
        grade=grade,
        findings=findings_out,
        rule_hits=dict(report.get("rule_hits") or {}),
        severity_counts=dict(report.get("severity_counts") or {}),
        categories=[
            LintCategoryScoreOut(name=str(c["name"]), score=int(c["score"]))
            for c in (report.get("categories") or [])
            if isinstance(c, dict) and "name" in c and "score" in c
        ],
        report_fingerprint=fingerprint,
        base_revision_id=base_revision_id,
        compatibility_overall=compatibility_overall,
        captured_score=captured_score if captured_score is not None else score,
        captured_grade=captured_grade if captured_grade is not None else grade,
        captured_report_fingerprint=(
            captured_fingerprint if captured_fingerprint is not None else fingerprint
        ),
        score_is_stale=False,
        guide_id=getattr(guide, "guide_id", None) if guide is not None else None,
        guide_name=getattr(guide, "name", None) if guide is not None else None,
        guide_source=getattr(guide, "source", None) if guide is not None else None,
        **lint_axis_fields_from_evaluation(axis_eval),
    )


def _try_relint_canonical_source(
    version: Dict[str, Any],
    *,
    catalog_item: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Re-lint from the native canonical model when no stored report exists (legacy imports).

    Native catalog imports capture score/grade from the canonical-model linter at import time,
    but pre-V160 rows lack persisted findings. Reconstruct the canonical model from the stored
    source and re-run the adapter lint so GET lint returns the same findings the card score
    reflects — without requiring a re-import.
    """
    from .catalog_parsed_model import reconstruct_catalog_api
    from .import_source import get_import_source

    item: Dict[str, Any] = dict(catalog_item) if catalog_item else {}
    source_format = (
        item.get("source_format") or version.get("source_format") or ""
    ).strip().lower()
    if not source_format or source_format in PUBLISHABLE_FORMATS:
        return None
    if source_format.startswith("openapi") or source_format in ("swagger", "swagger-2.0"):
        return None

    item.setdefault("id", item.get("id") or version.get("project_id") or "catalog-item")
    if not item.get("format_metadata"):
        item.setdefault("source_format", version.get("source_format"))
        item.setdefault("format_metadata", version.get("format_metadata") or {})
    if not item.get("source_format"):
        item["source_format"] = version.get("source_format")

    api = reconstruct_catalog_api(item)
    if api is None:
        return None

    adapter = get_import_source(source_format) or get_import_source(api.format)
    if adapter is None:
        return None

    lint_report = adapter.lint(api)
    if lint_report.score is None or lint_report.grade is None:
        return None
    return lint_report.to_persisted_dict()


async def build_lint_report(
    version: Dict[str, Any],
    project_id: str,
    tenant_slug: str,
    tenant_id: str,
    base_version: Optional[Dict[str, Any]] = None,
    resolved_base_id: Optional[str] = None,
    catalog_item: Optional[Dict[str, Any]] = None,
) -> LintReportResponse:
    """
    Compute the deterministic lint report for an already-resolved revision.

    This is the post-validation core shared by the per-version lint route and the catalog
    lint-report analog (MFI-23.10): callers resolve and authorize ``version`` (and, optionally,
    ``base_version``) first, then delegate the OpenAPI reconstruction, scoring and captured-score
    surfacing here so both surfaces produce an identical :class:`LintReportResponse`.

    Args:
        version: The resolved ``versions`` row (must carry ``id``/``project_id``/``version_id``).
        project_id: The owning project id (a catalog item's id is a project id).
        tenant_slug: The tenant slug, used to reconstruct the OpenAPI document.
        tenant_id: The authenticated tenant id.
        base_version: An optional resolved base revision row; when given, breaking/unknown
            compatibility findings relative to it are folded into the report.
        resolved_base_id: The base revision's ``versions.id`` echoed back on the response (and used
            to suppress staleness, since a base comparison legitimately changes the fingerprint).
        catalog_item: Optional catalog item row for canonical-model re-lint fallback on native
            imports that predate full report persistence.

    Returns:
        The server-computed quality score, grade and itemized findings for ``version``.
    """
    try:
        captured = db.get_version_quality_score(version["id"], tenant_id) or {}
    except Exception:  # pragma: no cover - defensive; surfacing must not break the live report
        captured = {}

    stored_report = _coerce_quality_report(captured.get("quality_report"))
    if (
        resolved_base_id is None
        and stored_report.get("report_fingerprint")
    ):
        return lint_report_response_from_persisted_dict(
            version=version,
            project_id=project_id,
            report=stored_report,
            captured=captured,
        )

    if resolved_base_id is None:
        canonical_report = _try_relint_canonical_source(version, catalog_item=catalog_item)
        if canonical_report and canonical_report.get("report_fingerprint"):
            return lint_report_response_from_persisted_dict(
                version=version,
                project_id=project_id,
                report=canonical_report,
                captured=captured,
            )

    head_spec = openapi_for_revision(version, tenant_slug, tenant_id)

    extra_findings = []
    compatibility_overall: Optional[str] = None
    if base_version is not None:
        base_spec = openapi_for_revision(base_version, tenant_slug, tenant_id)
        compat = CompatibilityCheckEngine.run(base_spec, head_spec)
        compatibility_overall = compat.overall
        extra_findings = merge_compatibility_findings(compat.findings)

    # GOV-1.4: score under the resolved style guide (project → tenant → default). A catalog
    # item id passed as ``project_id`` simply misses the project tier and resolves onward.
    result, guide = guided_lint_openapi_spec(
        head_spec, tenant_id, project_id=project_id, extra_findings=extra_findings
    )

    # CLX-2.2: run default bulk external validation pack → evidence (native score unchanged).
    try:
        from .openapi_validation_evidence import capture_openapi_external_validation_evidence

        await capture_openapi_external_validation_evidence(
            head_spec,
            version_record_id=str(version["id"]),
            tenant_id=tenant_id,
            project_id=project_id,
        )
    except Exception:  # noqa: BLE001 — evidence must never break lint
        pass

    # CLX-2.3: when a base revision is supplied, capture independent oasdiff evidence.
    if base_version is not None:
        try:
            from .openapi_compatibility_evidence import (
                capture_oasdiff_compatibility_evidence,
            )

            await capture_oasdiff_compatibility_evidence(
                base_document=base_spec,
                head_document=head_spec,
                version_record_id=str(version["id"]),
                base_revision_id=str(base_version["id"]),
                head_revision_id=str(version["id"]),
            )
        except Exception:  # noqa: BLE001
            pass

    findings_out = [
        LintFindingOut(
            id=f.id,
            path=f.path,
            category=f.category,
            rule=f.rule,
            severity=f.severity,
            message=f.message,
        )
        for f in result.findings
    ]

    # MFI-4.4: surface the score persisted on the version at import time (#3609 / MFI-4.2)
    # alongside the live recompute, so REST/ADE/CLI all show the authoritative captured score.
    # When the captured fingerprint differs from this live report's, the stored score is stale.
    # A base-revision comparison folds in extra findings, so its fingerprint legitimately differs
    # from the (base-less) captured one — never flag staleness in that case. Best-effort: a read
    # failure must never break the authoritative live lint, so fall back to "no captured score".
    captured_fingerprint = captured.get("quality_report_fingerprint")
    score_is_stale = (
        resolved_base_id is None
        and captured_fingerprint is not None
        and captured_fingerprint != result.report_fingerprint
    )

    axis_report = result.report_dict()
    if resolved_base_id:
        axis_report["base_revision_id"] = resolved_base_id
    if compatibility_overall:
        axis_report["compatibility_overall"] = compatibility_overall

    return LintReportResponse(
        project_id=project_id,
        version_record_id=version["id"],
        version_id=version["version_id"],
        score=result.score,
        grade=result.grade,
        findings=findings_out,
        rule_hits=dict(result.rule_hits),
        severity_counts=dict(result.severity_counts),
        categories=[
            LintCategoryScoreOut(name=c.name, score=c.score) for c in result.categories
        ],
        report_fingerprint=result.report_fingerprint,
        base_revision_id=resolved_base_id,
        compatibility_overall=compatibility_overall,
        captured_score=captured.get("quality_score"),
        captured_grade=captured.get("quality_grade"),
        captured_report_fingerprint=captured_fingerprint,
        score_is_stale=score_is_stale,
        guide_id=guide.guide_id,
        guide_name=guide.name,
        guide_source=guide.source,
        # GOV-1.6: pin the report to the immutable revision of the guide that scored it, so
        # the result stays explainable after the guide is edited.
        guide_revision_id=pin_guide_revision_id(guide, tenant_id),
        **lint_axis_fields_from_evaluation(catalog_axis_evaluation(axis_report).as_dict()),
    )


@router.get(
    "/{tenant_slug}/{project_id}/{version_record_id}/lint",
    response_model=LintReportResponse,
)
async def lint_revision(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    base_revision_id: Optional[str] = Query(
        default=None,
        alias="baseRevisionId",
        description="Optional base revision (versions.id) to flag breaking changes against.",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintReportResponse:
    """
    Score the quality of a schema revision and return itemized, deterministic lint findings.

    The score (0-100) and A-F grade are computed by the server from the reconstructed
    OpenAPI/JSON-Schema — no client-side scoring. When ``baseRevisionId`` is supplied, breaking
    and unknown compatibility findings relative to that revision are folded into the report.
    """
    tenant_id = auth_data["tenant_id"]

    project = db.get_project_by_id(project_id, tenant_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    version = db.get_version_by_id(version_record_id, tenant_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Revision not found: {version_record_id}")
    if version["project_id"] != project_id:
        raise HTTPException(
            status_code=400,
            detail="Revision does not belong to the specified project",
        )

    base_version: Optional[Dict[str, Any]] = None
    resolved_base_id: Optional[str] = None
    base_id = (base_revision_id or "").strip()
    if base_id:
        if base_id == version_record_id:
            raise HTTPException(
                status_code=400,
                detail="baseRevisionId must differ from the linted revision",
            )
        base_version = db.get_version_by_id(base_id, tenant_id)
        if not base_version:
            raise HTTPException(status_code=404, detail=f"Base revision not found: {base_id}")
        if base_version["project_id"] != project_id:
            raise HTTPException(
                status_code=400,
                detail="Base revision must belong to the specified project",
            )
        resolved_base_id = base_id

    return await build_lint_report(
        version,
        project_id,
        tenant_slug,
        tenant_id,
        base_version=base_version,
        resolved_base_id=resolved_base_id,
    )


@router.get(
    "/{tenant_slug}/{project_id}/{version_record_id}/lint/evidence",
    response_model=LintEvidenceResponse,
)
async def lint_revision_evidence(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintEvidenceResponse:
    """
    Return the immutable lint evidence recorded for a schema revision (CLX-1.1, #4848).

    Lists every evidence run captured for the revision — provenance (scanner, adapter,
    profile, fingerprints), outcome, normalized findings, and coverage — plus a per-scanner
    coverage summary in which a scanner that never ran reads as ``not_run`` (never as clean).
    Raw output artifacts are access-controlled: responses expose only their availability,
    never the storage reference or command metadata. Evidence is read-only by design; rows
    are written at score-capture time and are immutable.
    """
    _ = tenant_slug
    tenant_id = auth_data["tenant_id"]

    project = db.get_project_by_id(project_id, tenant_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    version = db.get_version_by_id(version_record_id, tenant_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Revision not found: {version_record_id}")
    if version["project_id"] != project_id:
        raise HTTPException(
            status_code=400,
            detail="Revision does not belong to the specified project",
        )

    source_projection = db.get_version_source_projection(version_record_id, tenant_id)
    raw_format = (
        source_projection.get("source_format")
        if isinstance(source_projection, dict)
        else None
    )
    source_format = raw_format if isinstance(raw_format, str) else None
    # CLX-2.4: ensure Buf / GraphQL ESLint evidence exists when viewing coverage.
    try:
        from .format_adapter_evidence import capture_format_adapters_for_revision

        await capture_format_adapters_for_revision(
            version_record_id=version_record_id,
            tenant_id=tenant_id,
            source_format=source_format,
        )
    except Exception:  # noqa: BLE001 — evidence must never break the read path
        pass

    rows = db.list_lint_evidence_runs_for_version(version_record_id, tenant_id)
    return lint_evidence_response_from_rows(
        SUBJECT_CATALOG_REVISION,
        version_record_id,
        rows,
        source_format=source_format,
    )


@router.get(
    "/{tenant_slug}/{project_id}/{version_record_id}/lint/axes",
    response_model=LintAxesResponse,
)
async def lint_revision_axes(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintAxesResponse:
    """
    Return the multi-axis score and coverage evaluation for a schema revision (CLX-1.2, #4849).

    Prefers the latest stored ``lint_axis_evaluations`` row for algorithm ``clx-axis-v1``.
    When no evaluation has been persisted yet, computes one from the revision's captured
    quality report (and optionally records it). Legacy ``qualityScore`` / ``qualityGrade``
    list fields are unchanged — quality remains the backwards-compatible axis.
    """
    _ = tenant_slug
    tenant_id = auth_data["tenant_id"]

    project = db.get_project_by_id(project_id, tenant_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    version = db.get_version_by_id(version_record_id, tenant_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Revision not found: {version_record_id}")
    if version["project_id"] != project_id:
        raise HTTPException(
            status_code=400,
            detail="Revision does not belong to the specified project",
        )

    stored = db.get_latest_axis_evaluation_for_version(version_record_id, tenant_id)
    if stored:
        return LintAxesResponse(
            evaluation=lint_axis_evaluation_out_from_row(
                stored,
                subject_type=SUBJECT_CATALOG_REVISION,
                subject_id=version_record_id,
            )
        )

    captured = db.get_version_quality_score(version_record_id, tenant_id) or {}
    report = (
        captured.get("quality_report")
        if isinstance(captured.get("quality_report"), dict)
        else {}
    )
    if not report and captured.get("quality_score") is not None:
        report = {
            "score": captured.get("quality_score"),
            "grade": captured.get("quality_grade"),
            "findings": [],
            "severity_counts": {"error": 0, "warning": 0, "info": 0},
            "report_fingerprint": captured.get("quality_report_fingerprint"),
        }
    evaluation = catalog_axis_evaluation(report or {})
    try:
        from .axis_score import evaluation_row

        db.record_axis_evaluation(
            evaluation_row(
                evaluation,
                subject_type=SUBJECT_CATALOG_REVISION,
                subject_id=version_record_id,
            )
        )
    except Exception:  # noqa: BLE001 - persistence is best-effort on read path
        pass

    payload = evaluation.as_dict()
    payload["subject_type"] = SUBJECT_CATALOG_REVISION
    payload["version_record_id"] = version_record_id
    return LintAxesResponse(
        evaluation=lint_axis_evaluation_out_from_row(
            payload,
            subject_type=SUBJECT_CATALOG_REVISION,
            subject_id=version_record_id,
        )
    )


@router.get(
    "/{tenant_slug}/{project_id}/{version_record_id}/lint/policy",
    response_model=LintPolicyResponse,
)
async def lint_revision_policy(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    policy_version_id: Optional[str] = Query(
        default=None,
        alias="policyVersionId",
        description="Optional historical policy pack id; defaults to the latest for the assigned guide.",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintPolicyResponse:
    """
    Evaluate the assigned style-guide policy pack against revision evidence (CLX-1.3, #4850).

    Separates raw findings from policy decisions. Waivers require rationale + expiry and reopen
    when expired. Persists an append-only ``lint_policy_evaluations`` row for reproducibility.
    """
    _ = tenant_slug
    tenant_id = auth_data["tenant_id"]

    project = db.get_project_by_id(project_id, tenant_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    version = db.get_version_by_id(version_record_id, tenant_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Revision not found: {version_record_id}")
    if version["project_id"] != project_id:
        raise HTTPException(
            status_code=400,
            detail="Revision does not belong to the specified project",
        )

    try:
        return evaluate_catalog_revision_policy(
            tenant_id=tenant_id,
            project_id=project_id,
            version_record_id=version_record_id,
            policy_version_id=policy_version_id,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get(
    "/{tenant_slug}/{project_id}/{version_record_id}/lint/gate",
    response_model=None,
)
async def lint_revision_gate(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    request: Request,
    format: Optional[str] = Query(
        default=None,
        description=(
            "Artifact format: json (default) | sarif | junit | markdown | attestation. "
            "The Accept header is honored when the query parameter is absent."
        ),
    ),
    baseline_revision_id: Optional[str] = Query(
        default=None,
        alias="baselineRevisionId",
        description=(
            "Optional baseline revision (versions.id) to diff regressions against; must "
            "belong to the same project. Without it, regressions compare each scanner's "
            "latest run to its own previous run."
        ),
    ),
    new_only: bool = Query(
        default=False,
        alias="newOnly",
        description=(
            "Scope the CI verdict's unwaived-errors gate to newly introduced findings, so "
            "pre-existing debt does not block. Coverage and axis gates always evaluate the "
            "full head revision."
        ),
    ),
    policy_version_id: Optional[str] = Query(
        default=None,
        alias="policyVersionId",
        description="Optional historical policy pack id; defaults to the latest for the assigned guide.",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Any:
    """
    Evaluate the lint CI gate for a revision and emit a machine-readable artifact (CLX-4.2).

    Runs the pinned policy pack over the revision's current evidence (persisting a
    reproducible ``lint_policy_evaluations`` row), optionally compares against a baseline
    revision for regressions, and serializes the verdict as JSON, SARIF 2.1.0, JUnit XML,
    Markdown, or a signed in-toto attestation. The HTTP status is always 200 — the pass/fail
    verdict lives in the body (``gate.passed``), so CI exit codes stay under the CLI's
    control and reflect only configured policy failures.
    """
    _ = tenant_slug
    tenant_id = auth_data["tenant_id"]

    project = db.get_project_by_id(project_id, tenant_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    version = db.get_version_by_id(version_record_id, tenant_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Revision not found: {version_record_id}")
    if version["project_id"] != project_id:
        raise HTTPException(
            status_code=400,
            detail="Revision does not belong to the specified project",
        )

    baseline_id = (baseline_revision_id or "").strip() or None
    if baseline_id:
        if baseline_id == version_record_id:
            raise HTTPException(
                status_code=400,
                detail="baselineRevisionId must differ from the gated revision",
            )
        baseline = db.get_version_by_id(baseline_id, tenant_id)
        if not baseline:
            raise HTTPException(
                status_code=404, detail=f"Baseline revision not found: {baseline_id}"
            )
        if baseline["project_id"] != project_id:
            raise HTTPException(
                status_code=400,
                detail="Baseline revision must belong to the specified project",
            )

    try:
        gate = evaluate_lint_gate(
            tenant_id=tenant_id,
            subject_type=SUBJECT_CATALOG_REVISION,
            subject_id=version_record_id,
            project_id=project_id,
            tenant_slug=tenant_slug,
            baseline_subject_id=baseline_id,
            policy_version_id=policy_version_id,
            new_only=new_only,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    payload = gate_payload(gate)
    fmt = normalize_gate_format(format or request.headers.get("accept"))
    if fmt == GATE_FORMAT_JSON:
        return LintGateResponse.model_validate(payload)
    body, media = serialize_lint_gate(
        fmt, payload, secret=settings.lint_attestation_signing_secret
    )
    return Response(content=body, media_type=media)


@decisions_router.get("", response_model=LintFindingDecisionListResponse)
async def list_lint_finding_decisions(
    project_id: Optional[str] = Query(default=None, alias="projectId"),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintFindingDecisionListResponse:
    """List finding remediation / waiver decisions for the tenant (CLX-1.3, #4850)."""
    tenant_id = auth_data["tenant_id"]
    rows = db.list_lint_finding_decisions(tenant_id, project_id=project_id)
    decisions = [lint_finding_decision_out_from_row(r) for r in rows]
    return LintFindingDecisionListResponse(decisions=decisions, count=len(decisions))


@decisions_router.get("/{decision_id}", response_model=LintFindingDecisionOut)
async def get_lint_finding_decision(
    decision_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintFindingDecisionOut:
    """Fetch one finding decision by id (CLX-1.3, #4850)."""
    tenant_id = auth_data["tenant_id"]
    row = db.get_lint_finding_decision(decision_id, tenant_id)
    if not row:
        raise HTTPException(status_code=404, detail="Decision not found")
    return lint_finding_decision_out_from_row(row)


@decisions_router.post("", response_model=LintFindingDecisionOut, status_code=201)
async def upsert_lint_finding_decision(
    body: LintFindingDecisionUpsertRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintFindingDecisionOut:
    """Create or update a finding decision / waiver (CLX-1.3, #4850; guarded by CLX-4.1, #4859).

    Waived state requires non-empty rationale and an expiry timestamp. The transition is
    RBAC-guarded on the ``lint_findings`` resource: triage transitions need ``edit``;
    approval-tier transitions (entering/leaving ``waived``, resolving a ``waiver_requested``
    row) need ``publish`` — the same rules the workspace bulk endpoint enforces, so bulk
    authorization can never be bypassed one decision at a time.
    """
    tenant_id = auth_data["tenant_id"]
    state = (body.state or "").strip().lower()
    error = transition_error(
        state, rationale=body.rationale, expires_at=body.expires_at
    )
    if error:
        raise HTTPException(status_code=400, detail=error)

    if body.project_id:
        project = db.get_project_by_id(body.project_id, tenant_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

    current_rows = db.list_lint_finding_decisions(
        tenant_id, fingerprints=[body.source_fingerprint.strip()]
    )
    current = match_decision_for_fingerprint(
        current_rows, body.source_fingerprint.strip(), project_id=body.project_id
    )
    before_state = str(current["state"]) if current else None
    required_action = required_action_for_transition(before_state, state)
    actor = enforce_permission(
        db,
        auth_data,
        Resource.LINT_FINDINGS,
        Action.PUBLISH if required_action == ACTION_PUBLISH else Action.EDIT,
        target=f"lint-decision:{body.source_fingerprint.strip()}",
    )
    row = db.upsert_lint_finding_decision(
        tenant_id=tenant_id,
        source_fingerprint=body.source_fingerprint.strip(),
        state=state,
        project_id=body.project_id,
        rule_id=body.rule_id,
        owner_user_id=body.owner_user_id,
        rationale=(body.rationale or "").strip() or None,
        linked_ticket=body.linked_ticket,
        expires_at=body.expires_at,
        policy_version_id=body.policy_version_id,
        evidence_fingerprint_at_decision=body.source_fingerprint.strip(),
        actor_user_id=actor,
        actor_label=actor,
    )
    return lint_finding_decision_out_from_row(row)


@decisions_router.get(
    "/{decision_id}/events",
    response_model=list[LintFindingDecisionEventOut],
)
async def list_lint_finding_decision_events(
    decision_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> list[LintFindingDecisionEventOut]:
    """Audit history for a finding decision (CLX-1.3, #4850)."""
    tenant_id = auth_data["tenant_id"]
    decision = db.get_lint_finding_decision(decision_id, tenant_id)
    if not decision:
        raise HTTPException(status_code=404, detail="Decision not found")
    rows = db.list_lint_finding_decision_events(decision_id, tenant_id)
    out: list[LintFindingDecisionEventOut] = []
    for row in rows:
        out.append(
            LintFindingDecisionEventOut(
                id=str(row["id"]),
                decision_id=str(row["decision_id"]),
                before_state=row.get("before_state"),
                after_state=str(row["after_state"]),
                rationale=row.get("rationale"),
                expires_at=str(row["expires_at"]) if row.get("expires_at") else None,
                linked_ticket=row.get("linked_ticket"),
                policy_version_id=(
                    str(row["policy_version_id"]) if row.get("policy_version_id") else None
                ),
                actor_user_id=(
                    str(row["actor_user_id"]) if row.get("actor_user_id") else None
                ),
                actor_label=row.get("actor_label"),
                created_at=str(row["created_at"]) if row.get("created_at") else None,
            )
        )
    return out
