"""
Style-guide management API — GOV-2.1 (#4433).

GOV-EPIC-1 delivered storage (V159), the rule registry, the custom-rule DSL, and engine
integration — but guides and assignments were only writable by the SQL seed. This module
adds the tenant-admin CRUD surface the Control Panel's Governance → Style Guides screen
drives:

* **List** — every guide with its list-view rollups (rules on, assignments, default badge).
  Listing self-heals the seeded read-only "Apiome Recommended" guide for tenants created
  after the V159 migration (``ensure_builtin_roles`` pattern).
* **Create / duplicate** — a create with an optional ``sourceGuideId`` whose rule rows are
  copied, which is both "duplicate" and "start from Recommended".
* **Assign** — set a guide as tenant default (moves ``is_default`` *and* the tenant-wide
  ``style_guide_assignments`` row, keeping resolution tiers 1 and 2 agreeing) or bind it to
  a single project. The next lint run picks assignments up live — GOV-1.4 resolution
  queries the tables on every run and the compiled-guide cache is content-addressed.
* **Rules** (GOV-2.2, #4434) — the guide editor's rule catalog tab: read every GOV-1.2
  registry rule merged with the guide's ``style_guide_rules`` state, and save the full
  built-in rule set (enable flags + severity overrides) in one transactional replace.
* **Custom rules** (GOV-2.3, #4435) — the guide editor's custom-rules tab: read/write the
  guide's Spectral-compatible YAML document and dry-run draft rules against a project revision.
* **Revisions & audit** (GOV-1.6, #4432) — every create/edit appends an immutable revision
  (:mod:`app.style_guide_revisions`) that lint results pin to, readable at
  ``GET …/{guideId}/revisions`` and ``GET …/{guideId}/revisions/{revisionId}``; create, edit
  and assign additionally emit ``style_guide.*`` events into the tenant's access-audit ledger.

Reads require tenant authentication; every mutation requires a **tenant administrator**
user session — governance is the buyer-admin persona's surface, and API keys cannot
administer it. The builtin guide is read-only: rename/delete return ``409
STYLE_GUIDE_READ_ONLY`` (duplicate it instead), though it can be assigned like any guide.
"""

from dataclasses import replace
from typing import Any, Dict, List, Optional

import psycopg2
from fastapi import APIRouter, Depends, HTTPException

from .auth import get_authenticated_user_id, validate_authentication
from .compatibility_engine import openapi_for_revision
from .custom_rule_dsl import (
    CustomRuleValidationError,
    EMPTY_STYLE_GUIDE_YAML,
    evaluate_custom_rules,
    parse_style_guide_yaml_for_save,
    serialize_style_guide_yaml,
    validate_custom_definition,
)
from .database import db
from .lint_rule_registry import LINT_RULE_DOCS_PAGE, builtin_rule_descriptors, builtin_rule_ids
from .models import (
    StyleGuideCreateRequest,
    StyleGuideCustomRulesPreviewRequest,
    StyleGuideCustomRulesPreviewResponse,
    StyleGuideCustomRulesPutRequest,
    StyleGuideCustomRulesResponse,
    StyleGuideListResponse,
    StyleGuideOut,
    StyleGuidePolicySettingsOut,
    StyleGuidePolicySettingsPutRequest,
    StyleGuidePolicyVersionListResponse,
    StyleGuidePolicyVersionOut,
    StyleGuideProjectAssignmentOut,
    StyleGuideRuleOut,
    StyleGuideRevisionDetailOut,
    StyleGuideRevisionListResponse,
    StyleGuideRulesPutRequest,
    StyleGuideRulesResponse,
    StyleGuideUpdateRequest,
    LintFindingOut,
    style_guide_ci_outcomes_from_raw,
    style_guide_policy_version_out_from_row,
    style_guide_revision_detail_from_row,
    style_guide_revision_out_from_row,
)
from .lint_policy_service import snapshot_style_guide_policy
from .policy_evaluate import (
    default_axis_gates,
    default_ci_outcomes,
    default_required_coverage,
)
from .style_guide_revisions import (
    AUDIT_ASSIGNED,
    AUDIT_CREATED,
    AUDIT_CUSTOM_RULES_UPDATED,
    AUDIT_DELETED,
    AUDIT_POLICY_UPDATED,
    AUDIT_RULES_UPDATED,
    AUDIT_UNASSIGNED,
    AUDIT_UPDATED,
    CHANGE_CREATED,
    CHANGE_CUSTOM_RULES_CHANGED,
    CHANGE_EDITED,
    CHANGE_POLICY_CHANGED,
    CHANGE_RULES_CHANGED,
    audit_style_guide_event,
    ensure_guide_revision,
    record_guide_revision,
)

router = APIRouter(prefix="/v1/style-guides", tags=["style-guides"])

#: ``detail.code`` for mutations against the read-only builtin guide.
READ_ONLY_CODE = "STYLE_GUIDE_READ_ONLY"

#: ``detail.code`` for a per-tenant guide-name collision.
NAME_CONFLICT_CODE = "STYLE_GUIDE_NAME_CONFLICT"


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """Return the authenticated tenant id or fail loudly when the context is missing."""
    tid = auth_data.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tid)


def _require_tenant_admin(auth_data: Dict[str, Any]) -> str:
    """Gate a mutation to tenant administrators; returns the tenant id.

    Style guides govern how every project in the tenant is scored, so mutations are an
    admin-only, user-session-only operation (an API key carries no administrator).
    """
    tenant_id = _tenant_id(auth_data)
    user_id = get_authenticated_user_id(auth_data)
    if not user_id or not db.is_user_tenant_admin(tenant_id, user_id):
        raise HTTPException(
            status_code=403,
            detail="Only tenant administrators can manage style guides",
        )
    return tenant_id


def _actor(auth_data: Dict[str, Any]) -> tuple:
    """Return ``(user_id, label)`` for the caller — the actor stamped on history and audit."""
    user_id = get_authenticated_user_id(auth_data)
    label = auth_data.get("email") or auth_data.get("username") or user_id
    return user_id, label


def _audit(
    auth_data: Dict[str, Any],
    tenant_id: str,
    action: str,
    target: Optional[str],
    detail: Dict[str, Any],
) -> None:
    """Emit one ``style_guide.*`` governance audit event (GOV-1.6, #4432).

    Thin wrapper over :func:`app.style_guide_revisions.audit_style_guide_event` that fills the
    actor from the request's auth context. Best-effort by contract: an audit failure is logged
    there and never surfaces to the caller.
    """
    user_id, label = _actor(auth_data)
    audit_style_guide_event(
        tenant_id=tenant_id,
        action=action,
        actor_user_id=user_id,
        actor_label=label,
        target=target,
        detail=detail,
    )


def _capture_before_edit(guide_id: str, tenant_id: str) -> None:
    """Record the guide's pre-edit state as a revision when it is not already recorded.

    Guides created before GOV-1.6 have no history; capturing here means the state an edit
    replaces is always preserved, so "prior revisions are immutable and queryable" holds even
    for guides that predate the feature. A guide already in sync is untouched.
    """
    ensure_guide_revision(guide_id, tenant_id)


def _record_edit(
    guide_id: str,
    tenant_id: str,
    change_kind: str,
    auth_data: Dict[str, Any],
) -> None:
    """Append the post-edit revision for a completed guide mutation."""
    user_id, label = _actor(auth_data)
    record_guide_revision(
        guide_id,
        tenant_id,
        change_kind=change_kind,
        actor_user_id=user_id,
        actor_label=label,
    )


def _guide_out(
    row: Dict[str, Any],
    project_assignments: Optional[List[StyleGuideProjectAssignmentOut]] = None,
) -> StyleGuideOut:
    """Map a ``style_guides`` row (with optional rollups) onto the response model."""
    return StyleGuideOut(
        id=str(row["id"]),
        name=row["name"],
        description=row.get("description"),
        source=row["source"],
        is_default=bool(row.get("is_default")),
        rule_count=int(row.get("rule_count") or 0),
        enabled_rule_count=int(row.get("enabled_rule_count") or 0),
        tenant_assigned=bool(row.get("tenant_assigned")),
        project_assignments=project_assignments or [],
        external_lint_profile=str(row.get("external_lint_profile") or "baseline"),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


def _load_guide_or_404(guide_id: str, tenant_id: str) -> Dict[str, Any]:
    """Fetch a tenant's guide row or raise 404."""
    guide = db.get_style_guide_by_id(guide_id, tenant_id)
    if not guide:
        raise HTTPException(status_code=404, detail="Style guide not found")
    return guide


def _reject_builtin(guide: Dict[str, Any], operation: str) -> None:
    """Raise the read-only 409 for the seeded builtin guide."""
    if guide.get("source") == "builtin":
        raise HTTPException(
            status_code=409,
            detail={
                "code": READ_ONLY_CODE,
                "message": (
                    f"'{guide['name']}' is the built-in guide and cannot be {operation}. "
                    "Duplicate it to customize."
                ),
            },
        )


def _name_conflict() -> HTTPException:
    """The 409 for a per-tenant guide-name collision (UNIQUE (tenant_id, name))."""
    return HTTPException(
        status_code=409,
        detail={
            "code": NAME_CONFLICT_CODE,
            "message": "A style guide with this name already exists in this tenant",
        },
    )


@router.get("/{tenant_slug}", response_model=StyleGuideListResponse)
async def list_style_guides(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideListResponse:
    """List the tenant's style guides with list-view rollups (rules on, assignments)."""
    tenant_id = _tenant_id(auth_data)
    db.ensure_builtin_style_guide(tenant_id)
    assignment_rows = db.list_style_guide_project_assignments(tenant_id)
    by_guide: Dict[str, List[StyleGuideProjectAssignmentOut]] = {}
    for row in assignment_rows:
        by_guide.setdefault(str(row["guide_id"]), []).append(
            StyleGuideProjectAssignmentOut(
                project_id=str(row["project_id"]),
                project_name=row["project_name"],
            )
        )
    guides = [
        _guide_out(row, by_guide.get(str(row["id"])))
        for row in db.list_style_guides(tenant_id)
    ]
    return StyleGuideListResponse(guides=guides, count=len(guides))


@router.post("/{tenant_slug}", response_model=StyleGuideOut, status_code=201)
async def create_style_guide(
    tenant_slug: str,
    body: StyleGuideCreateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideOut:
    """Create a custom guide; ``sourceGuideId`` copies that guide's rules (duplicate)."""
    tenant_id = _require_tenant_admin(auth_data)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Style guide name cannot be blank")
    rule_count = 0
    if body.source_guide_id:
        source = db.get_style_guide_by_id(body.source_guide_id, tenant_id)
        if not source:
            raise HTTPException(status_code=404, detail="Source style guide not found")
        rule_count = len(db.get_style_guide_rules(str(source["id"]), tenant_id))
    try:
        row = db.create_style_guide(
            tenant_id,
            name,
            body.description,
            body.source_guide_id or None,
            external_lint_profile=body.external_lint_profile,
        )
    except psycopg2.IntegrityError:
        raise _name_conflict()
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    # GOV-1.6: the guide's first immutable revision, then the audit event.
    _record_edit(str(row["id"]), tenant_id, CHANGE_CREATED, auth_data)
    _audit(
        auth_data,
        tenant_id,
        AUDIT_CREATED,
        str(row["id"]),
        {
            "name": name,
            "sourceGuideId": body.source_guide_id or None,
            "ruleCount": rule_count,
        },
    )
    return _guide_out({**row, "rule_count": rule_count, "enabled_rule_count": rule_count})


@router.patch("/{tenant_slug}/{guide_id}", response_model=StyleGuideOut)
async def update_style_guide(
    tenant_slug: str,
    guide_id: str,
    body: StyleGuideUpdateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideOut:
    """Rename / re-describe a custom guide (the builtin guide is read-only)."""
    tenant_id = _require_tenant_admin(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    _reject_builtin(guide, "edited")
    name = body.name.strip() if body.name is not None else guide["name"]
    if not name:
        raise HTTPException(status_code=400, detail="Style guide name cannot be blank")
    if "description" in body.model_fields_set:
        description = body.description or None
    else:
        description = guide.get("description")
    profile = None
    if "external_lint_profile" in body.model_fields_set and body.external_lint_profile:
        from .openapi_validation_profiles import VALIDATION_PROFILES, normalize_profile

        profile = normalize_profile(body.external_lint_profile)
        if profile not in VALIDATION_PROFILES:
            raise HTTPException(status_code=400, detail="Invalid externalLintProfile")
    _capture_before_edit(str(guide["id"]), tenant_id)
    try:
        row = db.update_style_guide(
            str(guide["id"]),
            tenant_id,
            name,
            description,
            external_lint_profile=profile,
        )
    except psycopg2.IntegrityError:
        raise _name_conflict()
    if not row:
        raise HTTPException(status_code=404, detail="Style guide not found")
    _record_edit(str(row["id"]), tenant_id, CHANGE_EDITED, auth_data)
    _audit(
        auth_data,
        tenant_id,
        AUDIT_UPDATED,
        str(row["id"]),
        {"name": row["name"], "previousName": guide["name"]},
    )
    rules = db.get_style_guide_rules(str(row["id"]), tenant_id)
    return _guide_out(
        {
            **row,
            "rule_count": len(rules),
            "enabled_rule_count": sum(1 for r in rules if r.get("enabled")),
        }
    )


@router.delete("/{tenant_slug}/{guide_id}")
async def delete_style_guide(
    tenant_slug: str,
    guide_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, str]:
    """Delete a custom guide; its assignments cascade and the affected projects fall back
    to the tenant default. Deleting the current default promotes the builtin guide."""
    tenant_id = _require_tenant_admin(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    _reject_builtin(guide, "deleted")
    if not db.delete_style_guide(str(guide["id"]), tenant_id):
        raise HTTPException(status_code=404, detail="Style guide not found")
    # The guide's revisions cascade away with it, so the audit ledger is what remains as
    # evidence the guide ever existed — record the name, not just the id.
    _audit(
        auth_data,
        tenant_id,
        AUDIT_DELETED,
        str(guide["id"]),
        {"name": guide["name"], "wasDefault": bool(guide.get("is_default"))},
    )
    return {"status": "deleted", "id": str(guide["id"])}


def _rules_view(guide: Dict[str, Any], rows: List[Dict[str, Any]]) -> StyleGuideRulesResponse:
    """Merge the GOV-1.2 registry with a guide's rule rows into the catalog-tab view.

    Every registry rule appears exactly once: ``enabled``/``severity`` come from the guide's
    built-in row when one exists (rows carrying a ``custom_def`` are custom rules and are
    skipped), otherwise the rule is disabled at its default severity. Rows for rule ids the
    registry no longer knows are ignored — they cannot render a category or rationale.
    """
    overrides = {
        row["rule_id"]: row for row in rows if row.get("custom_def") is None
    }
    rules = []
    for d in builtin_rule_descriptors():
        row = overrides.get(d.rule_id)
        rules.append(
            StyleGuideRuleOut(
                rule_id=d.rule_id,
                pack=d.pack,
                category=d.category,
                default_severity=d.default_severity,
                rationale=d.rationale,
                docs_anchor=d.docs_anchor,
                enabled=bool(row and row.get("enabled")),
                severity=(row.get("severity") if row and row.get("severity") else d.default_severity),
            )
        )
    return StyleGuideRulesResponse(
        guide_id=str(guide["id"]),
        guide_name=guide["name"],
        source=guide["source"],
        rules=rules,
        count=len(rules),
        enabled_count=sum(1 for r in rules if r.enabled),
        docs_page=LINT_RULE_DOCS_PAGE,
    )


@router.get("/{tenant_slug}/{guide_id}/rules", response_model=StyleGuideRulesResponse)
async def get_style_guide_rules(
    tenant_slug: str,
    guide_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideRulesResponse:
    """The guide's built-in rule catalog view (GOV-2.2, #4434).

    Every GOV-1.2 registry rule with its category, default severity and rationale, merged
    with this guide's ``style_guide_rules`` state (enabled + severity override). Readable by
    any tenant member — the rule catalog tab renders read-only for non-admins.
    """
    tenant_id = _tenant_id(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    rows = db.get_style_guide_rules(str(guide["id"]), tenant_id)
    return _rules_view(guide, rows)


@router.put("/{tenant_slug}/{guide_id}/rules", response_model=StyleGuideRulesResponse)
async def put_style_guide_rules(
    tenant_slug: str,
    guide_id: str,
    body: StyleGuideRulesPutRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideRulesResponse:
    """Replace the guide's built-in rule rows (GOV-2.2, #4434) — the catalog tab's save.

    The body is the guide's complete desired built-in rule state (at most one entry per
    registered rule id; unknown ids are rejected). Custom-rule rows are untouched. The next
    lint run under the guide picks the new rows up via GOV-1.4's content-addressed compile.
    """
    tenant_id = _require_tenant_admin(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    _reject_builtin(guide, "edited")

    registered = {d.rule_id for d in builtin_rule_descriptors()}
    seen: set = set()
    for rule in body.rules:
        if rule.rule_id not in registered:
            raise HTTPException(
                status_code=400, detail=f"Unknown built-in rule id: {rule.rule_id}"
            )
        if rule.rule_id in seen:
            raise HTTPException(
                status_code=400, detail=f"Duplicate rule id in request: {rule.rule_id}"
            )
        seen.add(rule.rule_id)

    rows = [
        {"rule_id": r.rule_id, "enabled": r.enabled, "severity": r.severity}
        for r in body.rules
    ]
    _capture_before_edit(str(guide["id"]), tenant_id)
    if not db.replace_style_guide_builtin_rules(str(guide["id"]), tenant_id, rows):
        raise HTTPException(status_code=404, detail="Style guide not found")
    actor = get_authenticated_user_id(auth_data)
    snapshot_style_guide_policy(
        str(guide["id"]),
        tenant_id,
        actor_user_id=actor,
        actor_label=actor,
    )
    _record_edit(str(guide["id"]), tenant_id, CHANGE_RULES_CHANGED, auth_data)
    _audit(
        auth_data,
        tenant_id,
        AUDIT_RULES_UPDATED,
        str(guide["id"]),
        {
            "name": guide["name"],
            "ruleCount": len(rows),
            "enabledRuleCount": sum(1 for r in rows if r["enabled"]),
        },
    )
    return _rules_view(guide, db.get_style_guide_rules(str(guide["id"]), tenant_id))


def _custom_rules_yaml(rows: List[Dict[str, Any]]) -> str:
    """Serialize stored custom-rule rows back to editor YAML."""
    from .custom_rule_dsl import CustomRuleSet

    custom_rows = [row for row in rows if row.get("custom_def") is not None]
    if not custom_rows:
        return EMPTY_STYLE_GUIDE_YAML
    reserved = frozenset(builtin_rule_ids())
    rules = []
    for row in custom_rows:
        rule = validate_custom_definition(
            row["rule_id"], row["custom_def"], reserved_rule_ids=reserved
        )
        if row.get("severity") and rule.severity != row["severity"]:
            rule = replace(rule, severity=row["severity"])
        rules.append(rule)
    return serialize_style_guide_yaml(CustomRuleSet(rules=tuple(rules)))


def _custom_rules_view(guide: Dict[str, Any], rows: List[Dict[str, Any]]) -> StyleGuideCustomRulesResponse:
    """Build the custom-rules tab payload from stored rows."""
    yaml_text = _custom_rules_yaml(rows)
    rule_count = sum(1 for row in rows if row.get("custom_def") is not None)
    return StyleGuideCustomRulesResponse(
        guide_id=str(guide["id"]),
        guide_name=guide["name"],
        source=guide["source"],
        yaml=yaml_text,
        rule_count=rule_count,
    )


def _validation_http_error(exc: CustomRuleValidationError) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail={"message": exc.message, "pointer": exc.pointer},
    )


@router.get(
    "/{tenant_slug}/{guide_id}/custom-rules",
    response_model=StyleGuideCustomRulesResponse,
)
async def get_style_guide_custom_rules(
    tenant_slug: str,
    guide_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideCustomRulesResponse:
    """The guide's custom-rules YAML document (GOV-2.3, #4435).

    Returns the Spectral-compatible YAML the custom-rules tab edits. Readable by any tenant
    member — the tab renders read-only for non-admins and the built-in guide.
    """
    tenant_id = _tenant_id(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    rows = db.get_style_guide_rules(str(guide["id"]), tenant_id)
    return _custom_rules_view(guide, rows)


@router.put(
    "/{tenant_slug}/{guide_id}/custom-rules",
    response_model=StyleGuideCustomRulesResponse,
    responses={
        422: {
            "description": "Malformed guide: `detail.message` explains the problem and "
            "`detail.pointer` points at the offending YAML node."
        }
    },
)
async def put_style_guide_custom_rules(
    tenant_slug: str,
    guide_id: str,
    body: StyleGuideCustomRulesPutRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideCustomRulesResponse:
    """Replace the guide's custom-rule rows from YAML (GOV-2.3, #4435).

    Strictly validates the document (same contract as ``POST /v1/lint/custom-rules/validate``,
    but ``rules: {}`` clears every custom rule). Built-in rows are untouched. Malformed YAML
    returns HTTP 422 with a pointer for inline editor markers.
    """
    tenant_id = _require_tenant_admin(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    _reject_builtin(guide, "edited")

    try:
        ruleset = parse_style_guide_yaml_for_save(
            body.yaml, reserved_rule_ids=frozenset(builtin_rule_ids())
        )
    except CustomRuleValidationError as exc:
        raise _validation_http_error(exc) from exc

    rows = [
        {
            "rule_id": rule.rule_id,
            "enabled": True,
            "severity": rule.severity,
            "custom_def": rule.as_dict(),
        }
        for rule in ruleset.rules
    ]
    _capture_before_edit(str(guide["id"]), tenant_id)
    if not db.replace_style_guide_custom_rules(str(guide["id"]), tenant_id, rows):
        raise HTTPException(status_code=404, detail="Style guide not found")
    actor = get_authenticated_user_id(auth_data)
    snapshot_style_guide_policy(
        str(guide["id"]),
        tenant_id,
        actor_user_id=actor,
        actor_label=actor,
    )
    _record_edit(str(guide["id"]), tenant_id, CHANGE_CUSTOM_RULES_CHANGED, auth_data)
    _audit(
        auth_data,
        tenant_id,
        AUDIT_CUSTOM_RULES_UPDATED,
        str(guide["id"]),
        {"name": guide["name"], "customRuleCount": len(rows)},
    )
    return _custom_rules_view(guide, db.get_style_guide_rules(str(guide["id"]), tenant_id))


@router.post(
    "/{tenant_slug}/{guide_id}/custom-rules/preview",
    response_model=StyleGuideCustomRulesPreviewResponse,
    responses={
        422: {
            "description": "Malformed draft YAML: `detail.message` + `detail.pointer`."
        }
    },
)
async def preview_style_guide_custom_rules(
    tenant_slug: str,
    guide_id: str,
    body: StyleGuideCustomRulesPreviewRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideCustomRulesPreviewResponse:
    """Dry-run draft custom rules against a project revision (GOV-2.3, #4435).

    Parses the draft YAML, reconstructs the revision's OpenAPI document, evaluates only the
    custom rules, and returns their violations — nothing is persisted.
    """
    tenant_id = _tenant_id(auth_data)
    _load_guide_or_404(guide_id, tenant_id)

    try:
        ruleset = parse_style_guide_yaml_for_save(
            body.yaml, reserved_rule_ids=frozenset(builtin_rule_ids())
        )
    except CustomRuleValidationError as exc:
        raise _validation_http_error(exc) from exc

    project = db.get_project_by_id(body.project_id, tenant_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    version = db.get_version_by_id(body.version_record_id, tenant_id)
    if not version or str(version.get("project_id")) != str(project["id"]):
        raise HTTPException(status_code=404, detail="Version not found")

    spec = openapi_for_revision(version, tenant_slug, tenant_id)
    evaluation = evaluate_custom_rules(ruleset, spec)
    findings = [
        LintFindingOut(
            id=f.id,
            path=f.path,
            category=f.category,
            rule=f.rule,
            severity=f.severity,
            message=f.message,
        )
        for f in evaluation.findings
    ]
    return StyleGuideCustomRulesPreviewResponse(
        project_id=str(project["id"]),
        version_record_id=str(version["id"]),
        version_id=str(version["version_id"]),
        count=len(findings),
        findings=findings,
        rule_errors=dict(evaluation.rule_errors),
    )


@router.put("/{tenant_slug}/{guide_id}/default", response_model=StyleGuideOut)
async def set_tenant_default(
    tenant_slug: str,
    guide_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideOut:
    """Make a guide the tenant default — what every project without its own assignment
    lints under from the next run onward."""
    tenant_id = _require_tenant_admin(auth_data)
    row = db.set_style_guide_tenant_default(guide_id, tenant_id)
    if not row:
        raise HTTPException(status_code=404, detail="Style guide not found")
    _audit(
        auth_data,
        tenant_id,
        AUDIT_ASSIGNED,
        str(row["id"]),
        {"name": row["name"], "scope": "tenant"},
    )
    rules = db.get_style_guide_rules(str(row["id"]), tenant_id)
    return _guide_out(
        {
            **row,
            "rule_count": len(rules),
            "enabled_rule_count": sum(1 for r in rules if r.get("enabled")),
            "tenant_assigned": True,
        }
    )


@router.put("/{tenant_slug}/{guide_id}/assignments/projects/{project_id}")
async def assign_project(
    tenant_slug: str,
    guide_id: str,
    project_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, str]:
    """Assign a guide to one project (replaces the project's previous assignment).

    A project-level assignment wins over the tenant default in the GOV-1.4 resolution
    order, so the project's next lint run scores under this guide.
    """
    tenant_id = _require_tenant_admin(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    if not db.assign_style_guide_to_project(guide_id, tenant_id, project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    _audit(
        auth_data,
        tenant_id,
        AUDIT_ASSIGNED,
        f"{guide_id}:{project_id}",
        {"name": guide["name"], "scope": "project", "projectId": project_id},
    )
    return {"status": "assigned", "guideId": guide_id, "projectId": project_id}


@router.delete("/{tenant_slug}/assignments/projects/{project_id}")
async def unassign_project(
    tenant_slug: str,
    project_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, str]:
    """Remove a project's guide assignment; it falls back to the tenant default."""
    tenant_id = _require_tenant_admin(auth_data)
    if not db.unassign_style_guide_from_project(tenant_id, project_id):
        raise HTTPException(status_code=404, detail="No assignment found for this project")
    _audit(
        auth_data,
        tenant_id,
        AUDIT_UNASSIGNED,
        project_id,
        {"scope": "project", "projectId": project_id},
    )
    return {"status": "unassigned", "projectId": project_id}


@router.get(
    "/{tenant_slug}/{guide_id}/revisions",
    response_model=StyleGuideRevisionListResponse,
)
async def list_style_guide_revisions(
    tenant_slug: str,
    guide_id: str,
    limit: int = 100,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideRevisionListResponse:
    """The guide's immutable revision history, newest first (GOV-1.6, #4432).

    One entry per edit — create, rename, rule-catalog save, custom-rule save, policy-gate
    change — with the change kind, the actor, and the fingerprints a lint result pins to.
    Saves that changed nothing are not entries: the history is real changes only.

    Reading self-heals a guide with no history yet (created before GOV-1.6, or seeded by the
    V159 migration): its current state is captured as revision 1 rather than showing an empty
    list for a guide that demonstrably exists. Readable by any tenant member — compliance
    review is not an admin-only activity.
    """
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    ensure_guide_revision(str(guide["id"]), tenant_id)
    rows = db.list_style_guide_revisions(
        str(guide["id"]), tenant_id, limit=max(1, min(int(limit), 500))
    )
    revisions = [style_guide_revision_out_from_row(row) for row in rows]
    return StyleGuideRevisionListResponse(
        guide_id=str(guide["id"]),
        guide_name=guide["name"],
        revisions=revisions,
        count=len(revisions),
    )


@router.get(
    "/{tenant_slug}/{guide_id}/revisions/{revision_id}",
    response_model=StyleGuideRevisionDetailOut,
)
async def get_style_guide_revision(
    tenant_slug: str,
    guide_id: str,
    revision_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuideRevisionDetailOut:
    """One immutable revision with the rules and policy gates it froze (GOV-1.6, #4432).

    This is what makes a past lint result defendable: a report carries ``guideRevisionId``, and
    this endpoint returns exactly the ruleset that produced it — including custom rule
    definitions — no matter how the live guide has changed since.
    """
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    _load_guide_or_404(guide_id, tenant_id)
    row = db.get_style_guide_revision(revision_id, tenant_id)
    if not row or str(row.get("guide_id")) != str(guide_id):
        raise HTTPException(status_code=404, detail="Style guide revision not found")
    return style_guide_revision_detail_from_row(row)


def _policy_settings_out(guide: Dict[str, Any]) -> StyleGuidePolicySettingsOut:
    """Map a guide row's draft gate columns onto the settings response."""
    ci = default_ci_outcomes(guide.get("ci_outcomes"))
    return StyleGuidePolicySettingsOut(
        guide_id=str(guide["id"]),
        axis_gates=default_axis_gates(guide.get("axis_gates")),
        required_coverage=default_required_coverage(guide.get("required_coverage")),
        ci_outcomes=style_guide_ci_outcomes_from_raw(ci),
    )


@router.get(
    "/{tenant_slug}/{guide_id}/policy",
    response_model=StyleGuidePolicySettingsOut,
)
async def get_style_guide_policy_settings(
    tenant_slug: str,
    guide_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuidePolicySettingsOut:
    """Return draft policy gate settings for a style guide (CLX-1.3, #4850)."""
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    return _policy_settings_out(guide)


@router.put(
    "/{tenant_slug}/{guide_id}/policy",
    response_model=StyleGuidePolicySettingsOut,
)
async def put_style_guide_policy_settings(
    tenant_slug: str,
    guide_id: str,
    body: StyleGuidePolicySettingsPutRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuidePolicySettingsOut:
    """Update draft policy gates and optionally snapshot a policy pack (CLX-1.3, #4850)."""
    _ = tenant_slug
    tenant_id = _require_tenant_admin(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    _reject_builtin(guide, "edited")

    ci_payload = None
    if body.ci_outcomes is not None:
        ci_payload = {
            "failOnUnwaivedErrors": body.ci_outcomes.fail_on_unwaived_errors,
            "failOnRequiredCoverage": body.ci_outcomes.fail_on_required_coverage,
            "failOnAxisGates": body.ci_outcomes.fail_on_axis_gates,
        }

    _capture_before_edit(str(guide["id"]), tenant_id)
    updated = db.update_style_guide_policy_settings(
        str(guide["id"]),
        tenant_id,
        axis_gates=body.axis_gates,
        required_coverage=body.required_coverage,
        ci_outcomes=ci_payload,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Style guide not found")
    _record_edit(str(guide["id"]), tenant_id, CHANGE_POLICY_CHANGED, auth_data)
    _audit(
        auth_data,
        tenant_id,
        AUDIT_POLICY_UPDATED,
        str(guide["id"]),
        {"name": guide["name"], "snapshot": bool(body.snapshot)},
    )

    if body.snapshot:
        actor = get_authenticated_user_id(auth_data)
        snapshot_style_guide_policy(
            str(guide["id"]),
            tenant_id,
            actor_user_id=actor,
            actor_label=actor,
        )
    return _policy_settings_out(updated)


@router.get(
    "/{tenant_slug}/{guide_id}/policy-versions",
    response_model=StyleGuidePolicyVersionListResponse,
)
async def list_style_guide_policy_versions(
    tenant_slug: str,
    guide_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuidePolicyVersionListResponse:
    """List immutable policy pack versions for a style guide (CLX-1.3, #4850)."""
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    _load_guide_or_404(guide_id, tenant_id)
    rows = db.list_style_guide_policy_versions(guide_id, tenant_id)
    versions = [style_guide_policy_version_out_from_row(r) for r in rows]
    return StyleGuidePolicyVersionListResponse(versions=versions, count=len(versions))


@router.get(
    "/{tenant_slug}/{guide_id}/policy-versions/{policy_version_id}",
    response_model=StyleGuidePolicyVersionOut,
)
async def get_style_guide_policy_version(
    tenant_slug: str,
    guide_id: str,
    policy_version_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuidePolicyVersionOut:
    """Fetch one policy pack version for a style guide (CLX-1.3, #4850)."""
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    _load_guide_or_404(guide_id, tenant_id)
    row = db.get_style_guide_policy_version(policy_version_id, tenant_id)
    if not row or str(row.get("guide_id")) != str(guide_id):
        raise HTTPException(status_code=404, detail="Policy version not found")
    return style_guide_policy_version_out_from_row(row)


@router.post(
    "/{tenant_slug}/{guide_id}/policy-versions",
    response_model=StyleGuidePolicyVersionOut,
    status_code=201,
)
async def publish_style_guide_policy_version(
    tenant_slug: str,
    guide_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StyleGuidePolicyVersionOut:
    """Snapshot the live guide into a new immutable policy pack (CLX-1.3, #4850)."""
    _ = tenant_slug
    tenant_id = _require_tenant_admin(auth_data)
    guide = _load_guide_or_404(guide_id, tenant_id)
    actor = get_authenticated_user_id(auth_data)
    row = snapshot_style_guide_policy(
        str(guide["id"]),
        tenant_id,
        actor_user_id=actor,
        actor_label=actor,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Style guide not found")
    return style_guide_policy_version_out_from_row(row)
