"""Pure logic for ``apiome schema test`` — IXH-5.5 (#5117).

Everything here is side-effect free: suite discovery, test-case construction from the
IXH-5.1 validate and IXH-5.2 synthesize responses, the pass/fail verdict rules, the exit
code, and the stable ``--json`` / ``--junit`` renderings. No HTTP, no typer — the command
module (:mod:`apiome_cli.commands.schema`) owns both.

**Verdict rules.** A case *passes* when a validator actually ran and its verdict matches
the expectation (a payload expected valid came out valid; a mutant expected invalid came
out invalid). It *fails* when a validator ran and the verdict does not match. It is an
*error* when no verdict exists at all — the server answered ``ok: false`` (unserviceable
payload) or ``valid: null`` (no validator ran, e.g. a missing XML toolchain) — because an
unchecked payload is evidence of nothing, neither pass nor failure.

**Exit code.** Failures dominate: any failed case exits
:data:`~apiome_cli.exit_codes.EXIT_SCHEMA_TEST_FAILED` (6); otherwise any error case
exits :data:`~apiome_cli.exit_codes.EXIT_ERROR` (1); otherwise
:data:`~apiome_cli.exit_codes.EXIT_SUCCESS` (0). Transport, auth, and schema-resolution
faults never reach these rules — the REST client exits first (5xx/network → 1, any
4xx → 2), which is what keeps "the tests failed" distinguishable from "the tests could
not run" in CI.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence
from xml.sax.saxutils import escape, quoteattr

from apiome_cli.exit_codes import EXIT_ERROR, EXIT_SCHEMA_TEST_FAILED, EXIT_SUCCESS
from apiome_cli.taxonomy_exit import format_taxonomy_error

#: Media types the IXH-5.1 validate endpoint accepts.
MEDIA_TYPE_JSON = "application/json"
MEDIA_TYPE_XML = "application/xml"

#: Case statuses, in the order the exit-code rules consider them.
STATUS_PASSED = "passed"
STATUS_FAILED = "failed"
STATUS_ERROR = "error"

#: Where a case came from: an explicit ``--payload`` file, a ``--suite`` set, or the
#: IXH-5.2 generated set.
SOURCE_PAYLOAD = "payload"
SOURCE_SUITE = "suite"
SOURCE_GENERATED = "generated"

#: The corpus-manifest feature tag the Test Bench stamps on exported instance payloads
#: (IXH-5.3 ``buildCorpusFixture``). Manifest suites run exactly these entries — the other
#: entries of a corpus manifest are spec *documents*, not instances of one schema.
INSTANCE_PAYLOAD_FEATURE = "instance-payload"

#: File suffixes a directory suite picks up (everything else is ignored, not an error:
#: a saved-payload directory routinely also holds the manifest and a README).
_SUITE_SUFFIXES = (".json", ".xml")


class SuiteLoadError(ValueError):
    """A ``--suite`` path that cannot be turned into test cases (a usage error)."""


@dataclass(frozen=True)
class SuitePayload:
    """One payload file selected for a run.

    Attributes:
        name: Display name (file stem for directories, entry path for manifests).
        path: Where the payload text was read from.
        payload_text: The payload exactly as the file held it.
        media_type: How the server should read it (by file suffix: ``.xml`` → XML).
        expected_valid: Whether the payload is expected to satisfy the schema.
    """

    name: str
    path: str
    payload_text: str
    media_type: str
    expected_valid: bool


@dataclass
class SchemaTestCase:
    """One executed test case, in the exact shape the ``--json`` report carries.

    Attributes:
        id: Stable identifier (``payload:<name>``, ``suite:<name>``, or the server's own
            instance id for generated cases, e.g. ``mutant:type-wrong:type:/age``).
        name: Human-readable name.
        source: :data:`SOURCE_PAYLOAD`, :data:`SOURCE_SUITE`, or :data:`SOURCE_GENERATED`.
        kind: ``payload`` for file cases; the server's instance kind (``minimal`` /
            ``full`` / ``branch`` / ``mutant``) for generated cases.
        path: The payload file, when the case came from one.
        expected_valid: The expectation the verdict is judged against.
        valid: The validator's verdict (``None`` when no validator ran).
        validated: Whether a validator actually executed.
        status: :data:`STATUS_PASSED`, :data:`STATUS_FAILED`, or :data:`STATUS_ERROR`.
        message: One line saying what happened, for a human or a JUnit attribute.
        findings: The server's findings, verbatim (violations the payload provoked).
        mutation: For a mutant, the server's mutation detail — including ``keyword`` (the
            constraint the mutant was built to violate) and ``reported_keyword`` (what the
            validator actually reported).
    """

    id: str
    name: str
    source: str
    kind: str
    path: Optional[str]
    expected_valid: bool
    valid: Optional[bool]
    validated: bool
    status: str
    message: str
    findings: list[dict[str, Any]] = field(default_factory=list)
    mutation: Optional[dict[str, Any]] = None

    def as_dict(self) -> dict[str, Any]:
        """The stable ``--json`` shape of this case."""
        return {
            "id": self.id,
            "name": self.name,
            "source": self.source,
            "kind": self.kind,
            "path": self.path,
            "expected_valid": self.expected_valid,
            "valid": self.valid,
            "validated": self.validated,
            "status": self.status,
            "message": self.message,
            "findings": self.findings,
            "mutation": self.mutation,
        }


# ===========================================================================
# Suite discovery
# ===========================================================================


def media_type_for_path(path: Path) -> str:
    """Pick the validate media type from a payload file's suffix."""
    return MEDIA_TYPE_XML if path.suffix.lower() == ".xml" else MEDIA_TYPE_JSON


def load_payload_file(path: Path, *, expected_valid: bool = True) -> SuitePayload:
    """Read one ``--payload`` file.

    Args:
        path: The payload file.
        expected_valid: The expectation to judge the verdict against.

    Returns:
        The :class:`SuitePayload`.

    Raises:
        SuiteLoadError: When the file cannot be read.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SuiteLoadError(f"cannot read payload file {path}: {exc}") from exc
    return SuitePayload(
        name=path.stem,
        path=str(path),
        payload_text=text,
        media_type=media_type_for_path(path),
        expected_valid=expected_valid,
    )


def load_suite(path: Path) -> list[SuitePayload]:
    """Turn a ``--suite`` path into the ordered payload set it names.

    Two forms are accepted:

    * **A directory** — every ``*.json`` / ``*.xml`` file under it (recursively, sorted
      by relative path so runs are deterministic) is a payload expected to be **valid**.
      This is the shape the Test Bench's saved-payload exports produce.
    * **A corpus-manifest file** (IXH-1.1 shape: a JSON object with ``entries``) — the
      entries carrying the ``instance-payload`` feature are run, each payload read from
      ``path`` relative to the manifest's directory, with the expectation taken from
      ``validity_class`` (``valid`` → expected valid; ``invalid`` / ``adversarial`` →
      expected invalid).

    Args:
        path: The directory or manifest file.

    Returns:
        The payloads, in deterministic order.

    Raises:
        SuiteLoadError: When the path is missing, the manifest is malformed or names no
            instance payloads, or a named payload file cannot be read.
    """
    if path.is_dir():
        return _load_suite_directory(path)
    if path.is_file():
        return _load_suite_manifest(path)
    raise SuiteLoadError(f"suite path {path} is neither a directory nor a manifest file")


def _load_suite_directory(root: Path) -> list[SuitePayload]:
    """Every payload file under ``root``, sorted by relative path, expected valid."""
    files = sorted(
        (p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in _SUITE_SUFFIXES),
        key=lambda p: p.relative_to(root).as_posix(),
    )
    if not files:
        raise SuiteLoadError(f"suite directory {root} contains no .json or .xml payloads")
    payloads: list[SuitePayload] = []
    for file in files:
        loaded = load_payload_file(file)
        payloads.append(
            SuitePayload(
                name=file.relative_to(root).as_posix(),
                path=loaded.path,
                payload_text=loaded.payload_text,
                media_type=loaded.media_type,
                expected_valid=True,
            )
        )
    return payloads


def _load_suite_manifest(manifest_path: Path) -> list[SuitePayload]:
    """The ``instance-payload`` entries of an IXH-1.1 corpus manifest."""
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SuiteLoadError(f"cannot read suite manifest {manifest_path}: {exc}") from exc
    entries = manifest.get("entries") if isinstance(manifest, dict) else None
    if not isinstance(entries, list):
        raise SuiteLoadError(
            f"suite manifest {manifest_path} has no 'entries' list — expected the "
            "IXH-1.1 corpus manifest shape, or pass a directory of payload files"
        )
    root = manifest_path.parent
    payloads: list[SuitePayload] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        features = entry.get("features")
        if not isinstance(features, list) or INSTANCE_PAYLOAD_FEATURE not in features:
            continue
        rel = entry.get("path")
        if not isinstance(rel, str) or not rel:
            raise SuiteLoadError(f"suite manifest {manifest_path} has an entry without a path")
        file = root / rel
        validity = entry.get("validity_class", "valid")
        loaded = load_payload_file(file)
        payloads.append(
            SuitePayload(
                name=rel,
                path=str(file),
                payload_text=loaded.payload_text,
                media_type=loaded.media_type,
                expected_valid=validity == "valid",
            )
        )
    if not payloads:
        raise SuiteLoadError(
            f"suite manifest {manifest_path} names no '{INSTANCE_PAYLOAD_FEATURE}' entries — "
            "only instance payloads (the shape the Test Bench exports) can be tested "
            "against a schema"
        )
    return payloads


# ===========================================================================
# Case construction
# ===========================================================================


def case_from_validation(
    payload: SuitePayload,
    response: Mapping[str, Any],
    *,
    source: str,
) -> SchemaTestCase:
    """Judge one IXH-5.1 validate response against a payload's expectation.

    Args:
        payload: The payload that was submitted.
        response: The parsed ``…/validate`` response body.
        source: :data:`SOURCE_PAYLOAD` or :data:`SOURCE_SUITE`.

    Returns:
        The judged :class:`SchemaTestCase`.
    """
    case_id = f"{source}:{payload.name}"
    findings = _findings_list(response.get("findings"))
    valid = response.get("valid")
    validated = bool(response.get("validated"))

    if not response.get("ok"):
        message = _unserviceable_message(response)
        return SchemaTestCase(
            id=case_id,
            name=payload.name,
            source=source,
            kind="payload",
            path=payload.path,
            expected_valid=payload.expected_valid,
            valid=None,
            validated=False,
            status=STATUS_ERROR,
            message=message,
        )

    if valid is None:
        return SchemaTestCase(
            id=case_id,
            name=payload.name,
            source=source,
            kind="payload",
            path=payload.path,
            expected_valid=payload.expected_valid,
            valid=None,
            validated=validated,
            status=STATUS_ERROR,
            message=_not_checked_message(response),
        )

    if bool(valid) == payload.expected_valid:
        status = STATUS_PASSED
        message = "valid" if valid else "invalid, as expected"
    else:
        status = STATUS_FAILED
        if payload.expected_valid:
            message = f"expected valid but {_findings_summary(findings)}"
        else:
            message = "expected invalid but the payload validated cleanly"

    return SchemaTestCase(
        id=case_id,
        name=payload.name,
        source=source,
        kind="payload",
        path=payload.path,
        expected_valid=payload.expected_valid,
        valid=bool(valid),
        validated=validated,
        status=status,
        message=message,
        findings=findings,
    )


def cases_from_synthesis(response: Mapping[str, Any]) -> list[SchemaTestCase]:
    """Judge every instance of an IXH-5.2 synthesize (``verify: true``) response.

    The synthesizer already re-validated each instance through the IXH-5.1 validator
    server-side, so each instance carries its verdict: ``expected_valid`` (what it was
    built to be) and ``valid`` (what the validator said). A mutant additionally carries
    its ``mutation`` — the keyword it was built to violate and the keyword the validator
    actually reported — which is exactly what the report surfaces.

    Args:
        response: The parsed ``…/synthesize`` response body.

    Returns:
        One judged case per instance; a single error case when the generation itself was
        unserviceable (``ok: false``).
    """
    if not response.get("ok"):
        return [
            SchemaTestCase(
                id="generated:synthesis",
                name="payload synthesis",
                source=SOURCE_GENERATED,
                kind="synthesis",
                path=None,
                expected_valid=True,
                valid=None,
                validated=False,
                status=STATUS_ERROR,
                message=_unserviceable_message(response),
            )
        ]

    cases: list[SchemaTestCase] = []
    for instance in response.get("instances") or []:
        if not isinstance(instance, dict):
            continue
        cases.append(_case_from_instance(instance))
    return cases


def _case_from_instance(instance: Mapping[str, Any]) -> SchemaTestCase:
    """Judge one synthesized instance."""
    instance_id = str(instance.get("id") or "instance")
    kind = str(instance.get("kind") or "instance")
    expected_valid = bool(instance.get("expected_valid"))
    valid = instance.get("valid")
    findings = _findings_list(instance.get("findings"))
    mutation = instance.get("mutation") if isinstance(instance.get("mutation"), dict) else None

    if valid is None:
        # ``verify: true`` was requested, so a missing verdict means verification could
        # not run for this instance — an error, never a silent pass.
        status, message = STATUS_ERROR, "verification did not run for this instance"
    elif kind == "mutant":
        keyword = str((mutation or {}).get("keyword") or "?")
        reported = str((mutation or {}).get("reported_keyword") or keyword)
        if valid is False:
            status = STATUS_PASSED
            message = f"intended to violate '{keyword}' — violated (reported '{reported}')"
        else:
            status = STATUS_FAILED
            message = f"intended to violate '{keyword}' — did not: the mutant validated cleanly"
    elif bool(valid) == expected_valid:
        status = STATUS_PASSED
        message = "valid" if valid else "invalid, as expected"
    else:
        status = STATUS_FAILED
        if expected_valid:
            message = f"generated instance expected valid but {_findings_summary(findings)}"
        else:
            message = "generated instance expected invalid but validated cleanly"

    return SchemaTestCase(
        id=instance_id,
        name=str(instance.get("title") or instance_id),
        source=SOURCE_GENERATED,
        kind=kind,
        path=None,
        expected_valid=expected_valid,
        valid=valid if valid is None else bool(valid),
        validated=valid is not None,
        status=status,
        message=message,
        findings=findings,
        mutation=dict(mutation) if mutation else None,
    )


def _findings_list(value: Any) -> list[dict[str, Any]]:
    """The findings array as a list of dicts, dropping anything unrecognizable."""
    if not isinstance(value, list):
        return []
    return [f for f in value if isinstance(f, dict)]


def _findings_summary(findings: Sequence[Mapping[str, Any]]) -> str:
    """One clause naming the first violation and the total count."""
    if not findings:
        return "the validator reported it invalid"
    first = findings[0]
    head = f"failed '{first.get('keyword', '?')}' at '{first.get('pointer', '')}'"
    more = len(findings) - 1
    return f"{head} (+{more} more)" if more > 0 else head


def _unserviceable_message(response: Mapping[str, Any]) -> str:
    """The taxonomy line for an ``ok: false`` response."""
    error = response.get("error")
    formatted = format_taxonomy_error(error) if isinstance(error, dict) else None
    return formatted or "the server could not service this request"


def _not_checked_message(response: Mapping[str, Any]) -> str:
    """Explain a ``valid: null`` verdict from the diagnostics the server sent."""
    diagnostics = response.get("diagnostics")
    if isinstance(diagnostics, list):
        for diagnostic in diagnostics:
            if isinstance(diagnostic, dict) and diagnostic.get("message"):
                code = diagnostic.get("code")
                prefix = f"[{code}] " if code else ""
                return f"no validator ran — {prefix}{diagnostic['message']}"
    return "no validator ran for this payload"


# ===========================================================================
# Report, exit code, renderings
# ===========================================================================


def summarize_cases(cases: Sequence[SchemaTestCase]) -> dict[str, int]:
    """Count cases by outcome."""
    return {
        "total": len(cases),
        "passed": sum(1 for c in cases if c.status == STATUS_PASSED),
        "failed": sum(1 for c in cases if c.status == STATUS_FAILED),
        "errors": sum(1 for c in cases if c.status == STATUS_ERROR),
    }


def exit_code_for_cases(cases: Sequence[SchemaTestCase]) -> int:
    """The process exit code: failures → 6, otherwise errors → 1, otherwise 0.

    An empty case list is an error (exit 1): a run that tested nothing must never be a
    green gate.
    """
    if any(c.status == STATUS_FAILED for c in cases):
        return EXIT_SCHEMA_TEST_FAILED
    if not cases or any(c.status == STATUS_ERROR for c in cases):
        return EXIT_ERROR
    return EXIT_SUCCESS


def build_report(
    *,
    schema_ref: str,
    seed: int,
    cases: Sequence[SchemaTestCase],
    source: Optional[Mapping[str, Any]],
    rejected_mutants: int,
    diagnostics: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Assemble the stable ``--json`` report.

    Args:
        schema_ref: The schema reference the run addressed.
        seed: The synthesis seed (echoed even when nothing was generated, so the same
            invocation can be reproduced).
        cases: Every judged case, in run order.
        source: What the reference resolved to (the first response's ``source`` echo).
        rejected_mutants: The server's count of mutant candidates dropped for failing
            with the wrong keyword — surfaced so a shrinking mutant set is visible.
        diagnostics: Conditions that limited the run, aggregated across responses.

    Returns:
        The report dict, JSON-serializable and stable across runs of the same inputs.
    """
    return {
        "command": "schema test",
        "schema_ref": schema_ref,
        "seed": seed,
        "summary": summarize_cases(cases),
        "cases": [case.as_dict() for case in cases],
        "rejected_mutants": rejected_mutants,
        "source": dict(source) if source else None,
        "diagnostics": [dict(d) for d in diagnostics],
    }


def render_junit(report: Mapping[str, Any]) -> str:
    """Render a report as JUnit XML, deterministically.

    One ``<testsuite name="apiome.schema-test">`` holds every case: a failed case gets a
    ``<failure>``, an error case an ``<error>``, and nothing is ever emitted as skipped.
    ``schema_ref`` and ``seed`` ride along as suite properties so the artifact alone
    identifies what was tested.

    Args:
        report: The dict from :func:`build_report`.

    Returns:
        The XML document text (with trailing newline).
    """
    summary = report.get("summary") or {}
    cases = report.get("cases") or []
    schema_ref = str(report.get("schema_ref") or "")
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            f"<testsuite name=\"apiome.schema-test\" tests={quoteattr(str(summary.get('total', 0)))} "
            f"failures={quoteattr(str(summary.get('failed', 0)))} "
            f"errors={quoteattr(str(summary.get('errors', 0)))} skipped=\"0\">"
        ),
        "  <properties>",
        f"    <property name=\"schema_ref\" value={quoteattr(schema_ref)}/>",
        f"    <property name=\"seed\" value={quoteattr(str(report.get('seed', 0)))}/>",
        "  </properties>",
    ]
    for case in cases:
        name = str(case.get("id") or case.get("name") or "case")
        classname = f"{schema_ref}.{case.get('source', 'case')}"
        status = case.get("status")
        message = str(case.get("message") or "")
        open_tag = (
            f"  <testcase classname={quoteattr(classname)} name={quoteattr(name)} time=\"0\""
        )
        if status == STATUS_PASSED:
            lines.append(f"{open_tag}/>")
            continue
        tag = "failure" if status == STATUS_FAILED else "error"
        detail = _case_detail_text(case)
        lines.append(f"{open_tag}>")
        if detail:
            lines.append(
                f"    <{tag} message={quoteattr(message)}>{escape(detail)}</{tag}>"
            )
        else:
            lines.append(f"    <{tag} message={quoteattr(message)}/>")
        lines.append("  </testcase>")
    lines.append("</testsuite>")
    return "\n".join(lines) + "\n"


def _case_detail_text(case: Mapping[str, Any]) -> str:
    """Multi-line detail for a JUnit failure/error body: one line per finding."""
    lines: list[str] = []
    mutation = case.get("mutation")
    if isinstance(mutation, dict) and mutation.get("description"):
        lines.append(str(mutation["description"]))
    for finding in case.get("findings") or []:
        if not isinstance(finding, dict):
            continue
        lines.append(
            f"{finding.get('pointer', '')} "
            f"[{finding.get('keyword', '?')}] {finding.get('message', '')}".strip()
        )
    return "\n".join(lines)


def render_human(report: Mapping[str, Any]) -> list[str]:
    """The human summary lines for stdout: verdict, counts, then non-passing cases."""
    summary = report.get("summary") or {}
    failed = int(summary.get("failed", 0))
    errors = int(summary.get("errors", 0))
    verdict = "passed" if failed == 0 and errors == 0 else "FAILED"
    lines = [
        f"Schema test for {report.get('schema_ref')} — {verdict}",
        (
            "  cases: {total} total, {passed} passed, {failed} failed, {errors} errors".format(
                total=summary.get("total", 0),
                passed=summary.get("passed", 0),
                failed=failed,
                errors=errors,
            )
        ),
    ]
    rejected = int(report.get("rejected_mutants", 0) or 0)
    if rejected:
        lines.append(
            f"  note: {rejected} generated mutant candidate(s) were rejected server-side "
            "(failed for a different keyword than intended)"
        )
    non_passing = [
        c for c in report.get("cases") or [] if c.get("status") != STATUS_PASSED
    ]
    if non_passing:
        lines.append(f"  non-passing cases ({len(non_passing)}):")
        for case in non_passing:
            lines.append(
                f"    [{case.get('status')}] {case.get('id')} — {case.get('message')}"
            )
    return lines
