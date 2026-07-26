"""The spec example-conformance rule pack — IXH-5.4 (#5116).

Adapts the pure walker/checker in :mod:`app.example_conformance` into the lint surface: one
registered rule, one finding per non-conforming example, reachable from **both** lint entry
points the codebase has.

Why a pack of its own, and why unconditional
--------------------------------------------
Example conformance is not a property of one ecosystem — an OpenAPI media-type example, an
AsyncAPI message example, and a JSON Schema ``examples`` array are the same defect wearing
different syntax. It therefore belongs beside :class:`app.lint_engine.CommonRulePack`: a pack
with no ``format`` key that always runs and self-gates on whether the artifact's retained source
document is one :mod:`app.example_conformance` walks. Registering it per format instead would
collide with the packs already registered under ``asyncapi-2`` / ``asyncapi-3``
(:func:`app.lint_engine.register_rule_pack` allows one pack per format key) and would silently
skip every format whose pack slot is taken.

The two entry points, and why both are wired
--------------------------------------------
* :func:`app.lint_engine.lint_canonical_model` — the default for every adapter. The pack reads
  the source document off :attr:`~app.canonical_model.CanonicalApi.raw`, which the normalizers
  retain under two different shapes (see :func:`source_document`).
* :func:`app.schema_lint.lint_openapi_spec` — the OpenAPI adapter's override, which lints the
  native document directly and never reaches the canonical engine. It calls
  :func:`example_conformance_findings` with the document it already holds, so an OpenAPI
  revision is covered by the same rule id, with the same severity, as everything else.

One example, one finding
------------------------
A single bad example can miss its schema in a dozen places. That is **one** defect for the
author to fix, so the pack collapses every violation of one example into a single finding whose
``path`` is the example's JSON Pointer and whose message names the governing schema's pointer,
the primary violation, and how many further violations were folded in. Because the finding is an
ordinary :class:`~app.schema_lint.LintFinding` with the usual stable ``path|rule|message`` id, it
participates in the style-guide machinery (enable/disable and severity override, via the
registered rule id) and in the lint-workspace waiver machinery (which keys decisions on that
finding id) with no special-casing anywhere.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from .canonical_model import CanonicalApi
from .example_conformance import ExampleConformanceIssue, check_example_conformance
from .lint_engine import LintRule, RulePack
from .schema_lint import LintFinding, Severity

__all__ = [
    "EXAMPLE_CONFORMANCE_CATEGORY",
    "EXAMPLE_CONFORMANCE_RULE_ID",
    "EXAMPLE_CONFORMANCE_SEVERITY",
    "ExampleConformanceRulePack",
    "example_conformance_findings",
    "source_document",
]

#: The one rule this pack registers. Stable and never renamed: it is hashed into finding ids
#: and into every report fingerprint, and style guides and waivers key on it.
EXAMPLE_CONFORMANCE_RULE_ID = "examples.non-conforming-example"

#: Category the rule reports under. Distinct from ``documentation`` on purpose: a missing
#: example is a documentation gap, while an example that contradicts its own schema is a
#: correctness defect, and rolling them together would hide it in the documentation bar.
EXAMPLE_CONFORMANCE_CATEGORY = "validation"

#: Default severity when no style guide overrides it. ``warning``, not ``error``: the spec is
#: still structurally valid and importable — a consumer is merely being handed a payload that
#: would be rejected. A tenant that ships examples as contract fixtures raises it to ``error``
#: through its style guide.
EXAMPLE_CONFORMANCE_SEVERITY: Severity = "warning"

#: One-line rationale published through the rule registry and the generated docs page.
EXAMPLE_CONFORMANCE_RATIONALE = (
    "An example that does not satisfy its own schema ships a payload consumers cannot use — "
    "docs render it, mocks replay it, and generated clients seed fixtures from it."
)


def source_document(api: CanonicalApi) -> Optional[Mapping[str, Any]]:
    """Return the retained native source document of a canonical artifact, if any.

    Normalizers retain the parsed source on :attr:`~app.canonical_model.CanonicalApi.raw` under
    two shapes: the document *itself* (OpenAPI, Swagger 2, AsyncAPI — ``raw = source``) or
    wrapped under a single key (JSON Schema — ``raw = {"source": document}``). Both are accepted;
    a wrapper whose value is not a mapping, and a model normalized with ``include_raw=False``,
    yield ``None`` so the rule simply does not fire.

    Args:
        api: The canonical artifact.

    Returns:
        The source document mapping, or ``None`` when none was retained.
    """
    raw = api.raw
    if not isinstance(raw, Mapping):
        return None
    # The wrapped shape: a single ``source`` key holding the document.
    inner = raw.get("source")
    if isinstance(inner, Mapping):
        return inner
    return raw


def example_conformance_findings(
    document: Any, *, format_key: Optional[str] = None
) -> List[LintFinding]:
    """Check every example in ``document`` and return one finding per non-conforming example.

    Args:
        document: The parsed source document (OpenAPI, Swagger 2, AsyncAPI, or JSON Schema).
        format_key: Adapter/catalog format token, used only as a fallback family hint; the
            document's own version marker wins.

    Returns:
        Findings in document-pointer order, one per non-conforming example. Empty when the
        document is not a walked family, carries no examples, or every example conforms.
    """
    report = check_example_conformance(document, format_key=format_key)
    return [
        LintFinding(
            path=example_pointer,
            category=EXAMPLE_CONFORMANCE_CATEGORY,
            rule=EXAMPLE_CONFORMANCE_RULE_ID,
            severity=EXAMPLE_CONFORMANCE_SEVERITY,
            message=_message(issues),
        )
        for example_pointer, issues in _group_by_example(report.issues)
    ]


def _group_by_example(
    issues: Iterable[ExampleConformanceIssue],
) -> List[Tuple[str, List[ExampleConformanceIssue]]]:
    """Group violations by the example that produced them, preserving first-seen order.

    ``check_example_conformance`` already emits in a deterministic traversal order, so
    first-seen order is itself deterministic and no re-sort is needed (the lint assembler sorts
    the final report by path anyway).
    """
    grouped: Dict[str, List[ExampleConformanceIssue]] = {}
    for issue in issues:
        grouped.setdefault(issue.example_pointer, []).append(issue)
    return list(grouped.items())


def _message(issues: List[ExampleConformanceIssue]) -> str:
    """Compose one finding message naming the schema pointer and the primary violation.

    Args:
        issues: Every violation of one example, in validator order (already deterministic).

    Returns:
        A single sentence naming the example's human location, the JSON Pointer of the schema it
        failed, where inside the example the primary violation sits, and — when the example
        failed in more than one way — how many further violations were folded into this finding.
    """
    primary = issues[0]
    # A root-level schema has the empty pointer, which renders as an empty pair of backticks
    # and reads like a bug; name it in words instead.
    schema_where = (
        f"at `{primary.schema_pointer}`" if primary.schema_pointer else "at the document root"
    )
    where = f" at `{primary.instance_pointer}`" if primary.instance_pointer else ""
    extra = (
        f" (and {len(issues) - 1} further violation{'s' if len(issues) > 2 else ''})"
        if len(issues) > 1
        else ""
    )
    return (
        f"The {primary.label} does not satisfy its schema {schema_where}: "
        f"{primary.message}{where}{extra}."
    )


def _check_example_conformance(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Rule check: yield ``(example pointer, message)`` for every non-conforming example.

    Self-gating — it does nothing at all unless the artifact retained a source document from a
    family :mod:`app.example_conformance` walks, so it is safe to run unconditionally for every
    format.

    Args:
        api: The canonical artifact. Not mutated.

    Yields:
        ``(path, message)`` pairs the rule turns into findings.
    """
    document = source_document(api)
    if document is None:
        return
    # No format gate here on purpose: the family is resolved from the *document's* own version
    # marker (see ``resolve_example_family``), which is authoritative and already returns
    # nothing for a format this module does not walk. Gating on ``api.format`` as well would
    # only add a way for the two answers to disagree.
    for finding in example_conformance_findings(document, format_key=api.format):
        yield (finding.path, finding.message)


class ExampleConformanceRulePack(RulePack):
    """The cross-format example-conformance pack — always runs, self-gates on the document.

    Its :attr:`format` is empty, so (like :class:`app.lint_engine.CommonRulePack`) it is never
    registered under a format key and is executed unconditionally by
    :func:`app.lint_engine.lint_canonical_model`. See the module docstring for why per-format
    registration is not an option here.
    """

    pack_id = "examples"

    _RULES: Tuple[LintRule, ...] = (
        LintRule(
            rule_id=EXAMPLE_CONFORMANCE_RULE_ID,
            category=EXAMPLE_CONFORMANCE_CATEGORY,
            severity=EXAMPLE_CONFORMANCE_SEVERITY,
            description=EXAMPLE_CONFORMANCE_RATIONALE,
            check=_check_example_conformance,
        ),
    )

    def rules(self) -> List[LintRule]:
        """Return the pack's rules in deterministic execution order."""
        return list(self._RULES)
