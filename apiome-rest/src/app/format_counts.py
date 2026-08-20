"""The format-count truth pass — one registry-derived number, written into every surface that
states it (FMT-1.6, #5417).

`README.md` described Apiome as "an OpenAPI 3.2.0 Specification Application". The guide said
"40+ formats". The export guide said "35+". The portal's hero named three formats. The catalog
help entry said "40+". Every one of those was typed by a person on a day when it was roughly true,
and none of them had any way to notice when it stopped being true — which is the whole failure mode
this module exists to remove. Apiome's strongest single claim about itself is a *measurement*, and
a measurement that is retyped by hand is a claim about the past.

### What this module owns

:func:`build_format_counts` projects :func:`app.format_matrix.build_format_matrix` — the one
traversal of the import-source, emitter and capability registries that FMT-1.5 established — down
to the handful of integers a human-facing surface ever quotes, plus a per-paradigm breakdown. It
adds no traversal of its own: if the matrix is right, these counts are right, and if a format is
registered tomorrow every surface below moves together.

Everything here is deliberately **deployment-independent**. The matrix also carries runtime facts
(`unavailable_here`, each row's `available` flag) that depend on which bundled binaries this
machine has; a count derived from those would differ between a laptop and CI and could not be
committed. The counts below are functions of the *source tree* alone — a format this deployment
cannot run is still a format Apiome supports, which is exactly the distinction FMT-1.5 drew.

### How a surface gets a count

Two mechanisms, chosen by what the surface is:

* **Markdown** (`README.md`, the guide pages) carries an inline **count token** — the number
  followed by the tag that names it, ``42<!--format-count:importable-->``. The comment does not
  render, so a reader sees "42 formats"; :func:`apply_count_tokens` rewrites the digits in front of
  it. A count therefore lives in prose, in the sentence that needs it, without that prose being
  generated. The tag trails the value rather than bracketing it for a mechanical reason: a line that
  *begins* with ``<!--`` starts an HTML block in CommonMark and would silently split the paragraph
  around it, which a bracketing marker invites every time somebody rewraps a sentence.
* **TypeScript** (`apiome-browse`, `apiome-ui`) imports a generated module rendered by
  :func:`render_typescript_module`. The copy interpolates the constant, so the number is resolved
  when the app is built and there is no literal to go stale.

Both are written by ``scripts/generate_format_counts.py``, which also verifies them with
``--check``; :mod:`tests.test_format_counts` asserts the same thing, so the pytest suite is the
gate whether or not anyone remembers to run the script.

### The guard

Regenerating stale numbers is only half of it. :data:`GUARDED_SOURCES` names the human-facing
surfaces, and :func:`find_unmanaged_counts` fails when any of them states a format count that is
*not* one of the two managed forms — a new hand-typed "40+ formats" is rejected the moment it is
committed, which is the acceptance criterion that keeps this pass from having to be repeated.
"""

from __future__ import annotations

import json
import re
from typing import Dict, List, Mapping, Sequence, Tuple

from pydantic import BaseModel, ConfigDict, Field

from .browse_facets import protocol_label
from .canonical_model import ApiParadigm
from .format_matrix import FormatMatrixRow, build_format_matrix

__all__ = [
    "COUNTS_JSON_PATH",
    "FORMAT_COUNTS_VERSION",
    "GENERATED_TS_MODULES",
    "GUARDED_SOURCES",
    "MARKED_DOCUMENTS",
    "REGENERATE_COMMAND",
    "UnmanagedCount",
    "FormatCounts",
    "ParadigmCount",
    "apply_count_tokens",
    "build_format_counts",
    "count_tokens",
    "find_unmanaged_counts",
    "render_counts_json",
    "render_typescript_module",
]


#: Contract version of the counts payload and of the generated artifacts. Bumped when a field is
#: removed or changes meaning — never when a count changes, which is the change this whole
#: mechanism exists to absorb silently.
FORMAT_COUNTS_VERSION = "1"

#: The one command that regenerates every managed surface. Quoted in each generated file's header
#: and in every failure message, so a contributor who trips a gate is told the fix.
REGENERATE_COMMAND = "cd apiome-rest && uv run python scripts/generate_format_counts.py"

#: The machine-readable artifact, relative to the monorepo root. Committed so a surface outside
#: this repository (a deck, a partner page) has a stable file to read rather than a number to copy.
COUNTS_JSON_PATH = "docs/format-counts.json"

#: The generated TypeScript modules, relative to the monorepo root — one per app, because each
#: builds from its own directory and cannot import across package roots.
GENERATED_TS_MODULES: Tuple[str, ...] = (
    "apiome-browse/lib/generated/formatCounts.ts",
    "apiome-ui/src/app/generated/formatCounts.ts",
)

#: Markdown documents whose prose carries count tokens. Every one is rewritten in place by the
#: generator; nothing else in them is generated.
MARKED_DOCUMENTS: Tuple[str, ...] = (
    "README.md",
    "docs/guide/README.md",
    "docs/guide/import-a-spec.md",
    "docs/guide/export-a-spec.md",
)

#: Human-facing surfaces the guard scans for hand-typed counts. Deliberately a curated list rather
#: than a tree walk: the point is to protect the copy a reader actually sees, and a walk over two
#: Next.js apps would spend its time rejecting incidental numbers in unrelated code.
GUARDED_SOURCES: Tuple[str, ...] = MARKED_DOCUMENTS + (
    "apiome-browse/lib/browseFacets.ts",
    "apiome-browse/lib/formatSurface.ts",
    "apiome-browse/src/app/HomeClient.tsx",
    "apiome-ui/src/app/components/ade/help/helpCatalog.ts",
    "apiome-ui/src/app/components/ui/catalog/FormatPill.tsx",
)


class ParadigmCount(BaseModel):
    """How many formats sit in one canonical paradigm.

    The paradigm vocabulary is :class:`~app.canonical_model.ApiParadigm` itself, so a facet or a
    docs section built from these rows can never offer a paradigm no format belongs to.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="The stored paradigm value, e.g. ``data_schema``.")
    label: str = Field(description="Display label, e.g. ``Data schema``.")
    total: int = Field(description="Formats in this paradigm.")
    importable: int = Field(description="Formats in this paradigm Apiome can read.")
    exportable: int = Field(description="Formats in this paradigm Apiome can write.")


class FormatCounts(BaseModel):
    """Every number a human-facing surface is allowed to state about format support.

    Derived from the format matrix and **independent of this deployment**: no field here changes
    because a bundled binary is missing, so the payload is a function of the source tree and can be
    committed and drift-checked.
    """

    model_config = ConfigDict(extra="forbid")

    version: str = Field(
        description="Contract version of this payload (:data:`FORMAT_COUNTS_VERSION`).",
    )
    capability_registry_version: str = Field(
        description="The source-format capability registry version behind the matrix these counts "
        "were projected from.",
    )
    total: int = Field(description="Formats Apiome reads or writes.")
    importable: int = Field(description="Formats Apiome can read.")
    exportable: int = Field(description="Formats Apiome can write.")
    round_trip: int = Field(description="Formats Apiome can both read and write.")
    import_only: int = Field(description="Formats Apiome can read but not write.")
    export_only: int = Field(description="Formats Apiome can write but not read.")
    live_discovery: int = Field(
        description="Formats whose adapter can introspect a live endpoint rather than read a file.",
    )
    publishable: int = Field(
        description="Formats whose import mints a publishable Project (the Projects importer).",
    )
    catalog: int = Field(
        description="Formats whose import mints a catalog item (the Catalog importer).",
    )
    toolchain_gated: int = Field(
        description="Formats that hard-require at least one external tool. A declaration, not a "
        "runtime observation — the number is the same on every deployment.",
    )
    paradigms: List[ParadigmCount] = Field(
        default_factory=list,
        description="Per-paradigm breakdown in canonical paradigm order. Every paradigm appears, "
        "including one no format currently uses, so a consumer reading this list has the whole "
        "vocabulary and not just the populated part of it.",
    )


def _paradigm_counts(rows: Sequence[FormatMatrixRow]) -> List[ParadigmCount]:
    """Break ``rows`` down by canonical paradigm.

    Iterates :class:`~app.canonical_model.ApiParadigm` rather than the paradigms present in the
    rows, so the result is the full vocabulary in its declared order — the property that lets the
    browse facet be built from this list.

    Args:
        rows: The matrix rows to count.

    Returns:
        One entry per canonical paradigm, in enum declaration order.
    """
    return [
        ParadigmCount(
            id=paradigm.value,
            label=protocol_label(paradigm.value),
            total=sum(1 for row in rows if row.paradigm is paradigm),
            importable=sum(
                1 for row in rows if row.paradigm is paradigm and row.import_support.supported
            ),
            exportable=sum(
                1 for row in rows if row.paradigm is paradigm and row.export_support.supported
            ),
        )
        for paradigm in ApiParadigm
    ]


def build_format_counts() -> FormatCounts:
    """Measure the format surface from the registries.

    Projects the unfiltered format matrix, so these counts and ``GET /v1/formats/matrix`` are two
    views of one traversal and cannot disagree. Pure and deterministic: the same source tree always
    produces the same payload, which is what makes the generated artifacts drift-checkable.

    Returns:
        The counts, including the per-paradigm breakdown.
    """
    matrix = build_format_matrix()
    rows = matrix.formats
    counts = matrix.counts
    return FormatCounts(
        version=FORMAT_COUNTS_VERSION,
        capability_registry_version=matrix.capability_registry_version,
        total=counts.total,
        importable=counts.importable,
        exportable=counts.exportable,
        round_trip=counts.round_trip,
        import_only=counts.import_only,
        export_only=counts.export_only,
        live_discovery=counts.live_discovery,
        publishable=counts.publishable,
        catalog=sum(
            1 for row in rows if row.import_support.supported and not row.import_support.publishable
        ),
        toolchain_gated=counts.toolchain_gated,
        paradigms=_paradigm_counts(rows),
    )


def count_tokens(counts: FormatCounts) -> Dict[str, int]:
    """The tokens a Markdown count marker may name, and the value each resolves to.

    Args:
        counts: The measured counts.

    Returns:
        Token name → integer. A marker naming anything outside this mapping is an error, not a
        silently-ignored comment, so a typo in a token name is caught by the generator.
    """
    tokens = {
        "total": counts.total,
        "importable": counts.importable,
        "exportable": counts.exportable,
        "round_trip": counts.round_trip,
        "import_only": counts.import_only,
        "export_only": counts.export_only,
        "live_discovery": counts.live_discovery,
        "publishable": counts.publishable,
        "catalog": counts.catalog,
        "toolchain_gated": counts.toolchain_gated,
        "paradigms": len(counts.paradigms),
    }
    for paradigm in counts.paradigms:
        tokens[f"paradigm.{paradigm.id}"] = paradigm.total
    return tokens


#: An inline count marker in Markdown prose: the value, then the tag naming the token it came from.
#: The digits are whatever the generator last wrote; only the tag is authored. HTML comments do not
#: render, so the reader sees a bare number in the sentence.
_COUNT_TOKEN_RE = re.compile(r"(?P<value>\d+)<!--format-count:(?P<token>[a-z_.]+)-->")


def apply_count_tokens(text: str, tokens: Mapping[str, int]) -> str:
    """Rewrite every count marker in ``text`` with its current value.

    Args:
        text: A Markdown document that may contain count markers.
        tokens: The token → value mapping from :func:`count_tokens`.

    Returns:
        The document with every marker's value refreshed. Text outside markers is untouched.

    Raises:
        KeyError: When a marker names a token that does not exist — a typo that would otherwise
            leave a stale number in place forever.
    """

    def replace(match: re.Match[str]) -> str:
        token = match.group("token")
        if token not in tokens:
            raise KeyError(
                f"unknown format-count token {token!r}; known tokens: {', '.join(sorted(tokens))}"
            )
        return f"{tokens[token]}<!--format-count:{token}-->"

    return _COUNT_TOKEN_RE.sub(replace, text)


def render_counts_json(counts: FormatCounts) -> str:
    """Render the committed machine-readable artifact.

    Args:
        counts: The measured counts.

    Returns:
        Pretty-printed JSON, newline-terminated, with stable key order — a diff on this file shows
        which count moved rather than a reflowed blob.
    """
    return json.dumps(counts.model_dump(mode="json"), indent=2, sort_keys=False) + "\n"


def _ts_header() -> List[str]:
    """The generated-file banner shared by both TypeScript modules."""
    return [
        "/**",
        " * Registry-derived format counts (FMT-1.6, #5417).",
        " *",
        " * GENERATED FILE — do not edit by hand.",
        f" * Regenerate with: {REGENERATE_COMMAND}",
        " *",
        " * Every count is measured from the import-source, emitter and capability registries by",
        " * `app.format_counts`, the same traversal behind `GET /v1/formats/matrix` and the",
        " * generated `docs/guide/supported-formats.md` page. Copy that states a format count",
        " * interpolates these constants so the number is resolved at build time and cannot go",
        " * stale; a hand-typed count in guarded copy fails `tests/test_format_counts.py`.",
        " *",
        " * The counts are deployment-independent: a format whose toolchain is missing from a",
        " * particular deployment is still a format Apiome supports, and is still counted here.",
        " */",
        "",
    ]


def render_typescript_module(counts: FormatCounts) -> str:
    """Render the generated TypeScript module the two Next.js apps import.

    Args:
        counts: The measured counts.

    Returns:
        The module source, newline-terminated. Deterministic for a given source tree.
    """
    lines = _ts_header()
    lines.extend(
        [
            "/** One canonical paradigm and how many formats belong to it. */",
            "export interface FormatParadigmCount {",
            "  /** The stored paradigm value, e.g. `data_schema`. */",
            "  readonly id: string;",
            "  /** Display label, e.g. `Data schema`. */",
            "  readonly label: string;",
            "  /** Formats in this paradigm. */",
            "  readonly total: number;",
            "  /** Formats in this paradigm Apiome can read. */",
            "  readonly importable: number;",
            "  /** Formats in this paradigm Apiome can write. */",
            "  readonly exportable: number;",
            "}",
            "",
            "/** The measured format surface. Field meanings match `FormatCounts` in apiome-rest. */",
            "export interface FormatCounts {",
            "  /** Contract version of this payload. */",
            "  readonly version: string;",
            "  /** Capability-registry version behind the matrix these counts were projected from. */",
            "  readonly capabilityRegistryVersion: string;",
            "  /** Formats Apiome reads or writes. */",
            "  readonly total: number;",
            "  /** Formats Apiome can read. */",
            "  readonly importable: number;",
            "  /** Formats Apiome can write. */",
            "  readonly exportable: number;",
            "  /** Formats Apiome can both read and write. */",
            "  readonly roundTrip: number;",
            "  /** Formats Apiome can read but not write. */",
            "  readonly importOnly: number;",
            "  /** Formats Apiome can write but not read. */",
            "  readonly exportOnly: number;",
            "  /** Formats whose adapter can introspect a live endpoint rather than read a file. */",
            "  readonly liveDiscovery: number;",
            "  /** Formats whose import mints a publishable Project. */",
            "  readonly publishable: number;",
            "  /** Formats whose import mints a catalog item. */",
            "  readonly catalog: number;",
            "  /** Formats that hard-require at least one external tool. */",
            "  readonly toolchainGated: number;",
            "  /** Per-paradigm breakdown, in canonical paradigm order. */",
            "  readonly paradigms: readonly FormatParadigmCount[];",
            "}",
            "",
            "/**",
            " * The measured counts. Import this rather than writing a number into copy.",
            " */",
            "export const FORMAT_COUNTS: FormatCounts = {",
            f"  version: '{counts.version}',",
            f"  capabilityRegistryVersion: '{counts.capability_registry_version}',",
            f"  total: {counts.total},",
            f"  importable: {counts.importable},",
            f"  exportable: {counts.exportable},",
            f"  roundTrip: {counts.round_trip},",
            f"  importOnly: {counts.import_only},",
            f"  exportOnly: {counts.export_only},",
            f"  liveDiscovery: {counts.live_discovery},",
            f"  publishable: {counts.publishable},",
            f"  catalog: {counts.catalog},",
            f"  toolchainGated: {counts.toolchain_gated},",
            "  paradigms: [",
        ]
    )
    for paradigm in counts.paradigms:
        lines.append(
            "    {{ id: '{id}', label: '{label}', total: {total}, "
            "importable: {importable}, exportable: {exportable} }},".format(
                id=paradigm.id,
                label=paradigm.label,
                total=paradigm.total,
                importable=paradigm.importable,
                exportable=paradigm.exportable,
            )
        )
    lines.extend(
        [
            "  ],",
            "};",
            "",
            "/**",
            " * The canonical paradigm vocabulary, in canonical order — the values",
            " * `ApiParadigm` declares in apiome-rest. A facet built from this list can never",
            " * offer a paradigm no import produces, and gains a new one the moment the registry",
            " * does.",
            " */",
            "export const FORMAT_PARADIGMS: readonly FormatParadigmCount[] = FORMAT_COUNTS.paradigms;",
            "",
        ]
    )
    return "\n".join(lines)


#: A format count as a reader would see it: a whole number, optionally a ``+``, then
#: "format"/"formats". Deliberately loose about what sits between them — the guard's job is to
#: catch the *shape* of a hand-typed claim. The leading lookbehind is the one deliberate
#: narrowing: it rejects a version number, because "the OpenAPI 3.1 format family" is a name and
#: not a count, and a guard that cried wolf on prose like that is the first thing anyone would
#: switch off.
_HARD_CODED_COUNT_RE = re.compile(
    r"(?<![\d.])\d+\s*\+?[\s -]*(?:api[\s-]+)?(?:description[\s-]+)?formats?\b",
    re.IGNORECASE,
)


class UnmanagedCount(BaseModel):
    """One hand-typed format count the guard rejected."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Monorepo-relative path of the offending file.")
    line_number: int = Field(description="1-based line the count appears on.")
    line: str = Field(description="The offending line, stripped.")
    matched: str = Field(description="The text that looked like a hand-typed count.")


def _managed_spans(text: str) -> List[Tuple[int, int]]:
    """Character ranges of ``text`` that a count marker owns.

    Args:
        text: A guarded document's full text.

    Returns:
        ``(start, end)`` offsets of every count marker, marker comments included.
    """
    return [(match.start(), match.end()) for match in _COUNT_TOKEN_RE.finditer(text)]


def find_unmanaged_counts(path: str, text: str) -> List[UnmanagedCount]:
    """Find format counts in ``text`` that are neither generated nor carried by a count marker.

    A count is *managed* when it carries a ``format-count`` tag. Anything else — a bare "40+
    formats" in prose, a number baked into a TypeScript string — is a claim with no way to stay
    true, and is reported.

    Args:
        path: Monorepo-relative path, used only for reporting.
        text: The file's full text.

    Returns:
        One entry per unmanaged count, in file order. Empty when the file is clean.
    """
    spans = _managed_spans(text)
    findings: List[UnmanagedCount] = []
    for match in _HARD_CODED_COUNT_RE.finditer(text):
        # A marker owns its digits and its trailing tag, and the word "formats" that follows sits
        # outside both. Containment is therefore tested on where the number *starts*.
        if any(start <= match.start() < end for start, end in spans):
            continue
        line_number = text.count("\n", 0, match.start()) + 1
        line = text.splitlines()[line_number - 1] if text else ""
        findings.append(
            UnmanagedCount(
                path=path,
                line_number=line_number,
                line=line.strip(),
                matched=match.group(0).strip(),
            )
        )
    return findings
