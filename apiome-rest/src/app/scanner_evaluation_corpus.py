"""Loader and runners for the CLX-4.3 scanner-evaluation corpus (#4861).

The corpus lives under ``tests/fixtures/scanner_evaluation/``. Each fixture is a JSON
document with a ``kind`` that selects how to build engine inputs and which engine to run.
The ``manifest.json`` indexes fixtures, expected blocking rule ids, and operational-failure
inventory paths reused from the external-linter fixture tree.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from .mcp_client.handshake import ServerInfo
from .mcp_client.normalize import (
    ITEM_TYPE_PROMPT,
    ITEM_TYPE_RESOURCE,
    ITEM_TYPE_RESOURCE_TEMPLATE,
    ITEM_TYPE_TOOL,
    CapabilityItem,
    DiscoverySurface,
)
from .mcp_conformance import (
    PROFILE_PROTOCOL,
    ConformanceContext,
    run_conformance,
)
from .mcp_lint import lint_mcp_surface
from .mcp_protocol_transcript import TranscriptRecorder
from .mcp_source_link import SOURCE_GIT, parse_source_reference
from .mcp_static_checks import documents_from_mapping, scan_documents
from .mcp_trust_posture import (
    PROFILE_FULL,
    PROFILE_METADATA,
    PROFILE_SUPPLY_CHAIN,
    PostureContext,
    run_trust_posture,
)

#: Soft wall-clock budget for a full corpus correctness pass (CI-stable, not a leaderboard).
CORPUS_SOFT_BUDGET_SECONDS = 30.0

_ITEM_TYPES = {
    "tool": ITEM_TYPE_TOOL,
    "resource": ITEM_TYPE_RESOURCE,
    "resource_template": ITEM_TYPE_RESOURCE_TEMPLATE,
    "prompt": ITEM_TYPE_PROMPT,
}


def corpus_root() -> Path:
    """Return the on-disk corpus root (``tests/fixtures/scanner_evaluation``)."""
    return Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "scanner_evaluation"


def load_manifest(root: Optional[Path] = None) -> Dict[str, Any]:
    """Load and return ``manifest.json`` from the corpus root."""
    path = (root or corpus_root()) / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _capability_item(raw: Mapping[str, Any], ordinal: int = 0) -> CapabilityItem:
    item_type = str(raw.get("item_type") or raw.get("type") or "tool")
    mapped = _ITEM_TYPES.get(item_type, item_type)
    wire = dict(raw.get("raw") or {})
    name = raw.get("name", wire.get("name", ""))
    kwargs: Dict[str, Any] = {
        "item_type": mapped,
        "name": name if name is not None else "",
        "ordinal": int(raw.get("ordinal", ordinal)),
        "raw": wire or {"name": name},
    }
    if "description" in raw:
        kwargs["description"] = raw["description"]
    if "title" in raw:
        kwargs["title"] = raw["title"]
    if "uri" in raw:
        kwargs["uri"] = raw["uri"]
    if "uri_template" in raw or "uriTemplate" in raw:
        kwargs["uri_template"] = raw.get("uri_template", raw.get("uriTemplate"))
    if "input_schema" in raw or "inputSchema" in raw:
        kwargs["input_schema"] = raw.get("input_schema", raw.get("inputSchema"))
    return CapabilityItem(**kwargs)


def surface_from_fixture(data: Mapping[str, Any]) -> DiscoverySurface:
    """Build a :class:`DiscoverySurface` from a ``mcp_surface`` fixture document."""
    info = data.get("server_info") or {}
    tools = tuple(
        _capability_item(item, i) for i, item in enumerate(data.get("tools") or [])
    )
    resources = tuple(
        _capability_item(item, i) for i, item in enumerate(data.get("resources") or [])
    )
    templates = tuple(
        _capability_item(item, i)
        for i, item in enumerate(data.get("resource_templates") or [])
    )
    prompts = tuple(
        _capability_item(item, i) for i, item in enumerate(data.get("prompts") or [])
    )
    return DiscoverySurface(
        protocol_version=data.get("protocol_version"),
        server_info=ServerInfo(
            name=str(info.get("name") or ""),
            title=info.get("title"),
            version=str(info.get("version") or "1.0.0"),
        ),
        capabilities=dict(data.get("capabilities") or {}),
        instructions=data.get("instructions"),
        tools=tools,
        resources=resources,
        resource_templates=templates,
        prompts=prompts,
    )


def transcript_from_fixture(data: Mapping[str, Any]):
    """Build a protocol transcript from fixture ``transcript_records``."""
    recorder = TranscriptRecorder()
    for record in data.get("transcript_records") or []:
        recorder.record(
            str(record["method"]),
            request_id=record.get("request_id"),
            params=record.get("params"),
            http_status=int(record.get("http_status") or 200),
            envelope=record.get("envelope") or {},
        )
    return recorder.transcript()


def _blocking_rule_ids(findings: Sequence[Mapping[str, Any]]) -> Set[str]:
    return {
        str(f.get("rule") or "")
        for f in findings
        if str(f.get("severity") or "") == "error" and f.get("rule")
    }


def run_fixture(data: Mapping[str, Any]) -> Tuple[Set[str], List[Dict[str, Any]]]:
    """Run the engine declared by ``data['kind']`` and return (blocking rule ids, findings)."""
    kind = str(data.get("kind") or "")
    if kind == "mcp_surface":
        surface = surface_from_fixture(data)
        findings = [f.as_dict() for f in lint_mcp_surface(surface)]
        return _blocking_rule_ids(findings), findings

    if kind == "mcp_conformance":
        surface = surface_from_fixture(data.get("surface") or data)
        transcript = None
        if data.get("transcript_records"):
            transcript = transcript_from_fixture(data)
        profile = str(data.get("profile") or PROFILE_PROTOCOL)
        report = run_conformance(
            ConformanceContext(surface=surface, transcript=transcript),
            profile=profile,
        )
        findings = list(report.report_dict().get("findings") or [])
        return _blocking_rule_ids(findings), findings

    if kind == "mcp_posture_metadata":
        surface = surface_from_fixture(data.get("surface") or data)
        report = run_trust_posture(
            PostureContext(surface=surface),
            profile=PROFILE_METADATA,
        )
        findings = list(report.report_dict().get("findings") or [])
        return _blocking_rule_ids(findings), findings

    if kind == "mcp_posture_source":
        surface = surface_from_fixture(
            data.get("surface")
            or {
                "protocol_version": "2025-06-18",
                "server_info": {"name": "srv", "version": "1.0.0"},
                "capabilities": {"tools": {}},
                "tools": [{"name": "noop", "raw": {"name": "noop", "inputSchema": {"type": "object"}}}],
            }
        )
        files = dict(data.get("files") or {})
        scan = scan_documents(documents_from_mapping(files))
        source = parse_source_reference(
            SOURCE_GIT,
            str(data.get("source_reference") or "https://github.com/acme/srv"),
            revision=str(data.get("revision") or ("a" * 40)),
        )
        report = run_trust_posture(
            PostureContext(surface=surface, source=source, static_scan=scan),
            profile=PROFILE_SUPPLY_CHAIN,
        )
        findings = list(report.report_dict().get("findings") or [])
        return _blocking_rule_ids(findings), findings

    if kind == "catalog_arazzo":
        from .arazzo_import_source import ArazzoImportSource
        from .arazzo_lint import lint_arazzo_result

        doc = data.get("document") or {}
        adapter = ArazzoImportSource()
        report = lint_arazzo_result(adapter.normalize(doc))
        findings = [
            f.as_dict() if hasattr(f, "as_dict") else {"rule": f.rule, "severity": f.severity, "path": getattr(f, "path", ""), "id": getattr(f, "id", ""), "message": getattr(f, "message", "")}
            for f in report.findings
        ]
        return _blocking_rule_ids(findings), findings

    if kind == "catalog_compatibility":
        from .schema_compatibility import analyze_schema_compatibility
        from .schema_lint import merge_compatibility_findings

        base = data.get("base") or {}
        head = data.get("head") or {}
        _overall, compat_findings = analyze_schema_compatibility(base, head)
        merged = merge_compatibility_findings(compat_findings)
        findings = []
        for f in merged:
            if hasattr(f, "as_dict"):
                findings.append(f.as_dict())
            else:
                findings.append(
                    {
                        "rule": getattr(f, "rule", ""),
                        "severity": getattr(f, "severity", ""),
                        "path": getattr(f, "path", ""),
                        "id": getattr(f, "id", ""),
                        "message": getattr(f, "message", ""),
                    }
                )
        return _blocking_rule_ids(findings), findings

    if kind == "mcp_posture_proven":
        from .mcp_trust_posture import ProbeEvidence

        surface = surface_from_fixture(
            data.get("surface")
            or {
                "protocol_version": "2025-06-18",
                "server_info": {"name": "srv", "version": "1.0.0"},
                "capabilities": {"tools": {}},
                "tools": [
                    {
                        "name": "noop",
                        "raw": {"name": "noop", "inputSchema": {"type": "object"}},
                    }
                ],
            }
        )
        # Probe id strings (avoid importing mcp_probe_probes here — circular with mcp_probe).
        probe_id = str(data.get("probe_id") or "active.auth.unauthenticated-read")
        allowed = {"active.auth.unauthenticated-read", "fuzz.parameter-injection"}
        if probe_id not in allowed:
            raise ValueError(f"unsupported proven probe_id for corpus: {probe_id!r}")
        evidence = ProbeEvidence(
            probe_id=probe_id,
            observed=str(data.get("observed") or "corpus-synthetic exploit evidence"),
            probe_run_id=str(data.get("probe_run_id") or "corpus-probe-run"),
        )
        import app.mcp_probe  # noqa: F401

        report = run_trust_posture(
            PostureContext(surface=surface, probes=(evidence,)),
            profile=PROFILE_FULL,
        )
        findings = list(report.report_dict().get("findings") or [])
        return _blocking_rule_ids(findings), findings

    if kind == "catalog_graphql_fileset":
        # Federated GraphQL subgraph set (IXH-7.6): lint the composition dimension.
        from .fileset import IntakeFileset
        from .graphql_import_source import GraphQlImportSource

        members = {str(path): str(text) for path, text in (data.get("members") or {}).items()}
        root = str(data.get("root") or next(iter(members)))
        adapter = GraphQlImportSource()
        model = adapter.normalize(adapter.parse_fileset(IntakeFileset.from_members(members, root=root)))
        rover_composition = data.get("rover_composition")
        if isinstance(rover_composition, list) and model.raw is not None:
            # A captured `rover supergraph compose` verdict (the tool itself is
            # not available in the evaluation environment) — the fixture
            # exercises the lint surface of the stored verdict.
            model.raw["composition"] = rover_composition
        report = adapter.lint(model)
        findings = [
            f.as_dict()
            if hasattr(f, "as_dict")
            else {
                "rule": f.rule,
                "severity": f.severity,
                "path": getattr(f, "path", ""),
                "id": getattr(f, "id", ""),
                "message": getattr(f, "message", ""),
            }
            for f in report.findings
        ]
        return _blocking_rule_ids(findings), findings

    if kind == "catalog_pointer_index":
        # Inventory-only fixture: multi-format pointers validated in tests by path existence.
        return set(), []

    raise ValueError(f"unknown scanner-evaluation fixture kind: {kind!r}")


def load_fixture(fixture_id: str, root: Optional[Path] = None) -> Dict[str, Any]:
    """Load one fixture document by corpus-relative id (directory or ``.json`` path)."""
    base = root or corpus_root()
    path = base / fixture_id
    if path.is_dir():
        path = path / "fixture.json"
    elif not path.suffix:
        path = path.with_suffix(".json")
    return json.loads(path.read_text(encoding="utf-8"))


def run_corpus(
    root: Optional[Path] = None,
) -> Tuple[Dict[str, Set[str]], float]:
    """Run every fixture in the manifest; return {fixture_id: blocking_rules} and elapsed seconds."""
    base = root or corpus_root()
    manifest = load_manifest(base)
    started = time.perf_counter()
    results: Dict[str, Set[str]] = {}
    for entry in manifest.get("fixtures") or []:
        fixture_id = str(entry["id"])
        data = load_fixture(fixture_id, base)
        blocking, _findings = run_fixture(data)
        results[fixture_id] = blocking
    elapsed = time.perf_counter() - started
    return results, elapsed


def finding_fingerprint(findings: Sequence[Mapping[str, Any]]) -> Tuple[Tuple[str, str, str], ...]:
    """Stable fingerprint of findings for determinism checks."""
    return tuple(
        sorted(
            (
                str(f.get("path") or ""),
                str(f.get("rule") or ""),
                str(f.get("id") or f.get("message") or ""),
            )
            for f in findings
        )
    )
