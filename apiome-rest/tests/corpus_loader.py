"""Typed loader for the import example corpus manifest — IXH-1.1 (#5087).

``apiome-ui/examples/`` is the de facto import test corpus, and
``apiome-ui/examples/corpus.manifest.json`` is its machine-readable contract:
one entry per corpus file declaring what the file demonstrates, whether it is
valid, which adapter must claim it, and what detection/import outcome it is
expected to produce (published JSON Schema: ``corpus.schema.json`` alongside
it; TypeScript twin: ``apiome-ui/lib/corpus/corpus.ts``).

Tests select fixtures **by tag, not by path**::

    from corpus_loader import load_corpus

    [weather] = load_corpus(format="smithy")
    [orders] = load_corpus(format="avro", feature="enum")
    text = orders.read_text()

so adding, renaming, or reclassifying corpus files is a manifest edit rather
than a hunt through hard-coded ``Path(...)`` literals.
:mod:`tests.test_corpus_manifest` keeps the manifest honest (completeness in
both directions, schema validity, README drift).
"""

from __future__ import annotations

import json
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Literal, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "EXAMPLES_DIR",
    "MANIFEST_PATH",
    "SCHEMA_PATH",
    "CorpusCategory",
    "CorpusDirectory",
    "CorpusEntry",
    "CorpusManifest",
    "ExpectedDetection",
    "ExpectedOutcome",
    "FailureClass",
    "FilesetRole",
    "IntakeGuard",
    "Rung",
    "ValidityClass",
    "corpus_files",
    "load_corpus",
    "load_manifest",
]

#: Monorepo root (parent of ``apiome-rest/``).
_REPO_ROOT = Path(__file__).resolve().parents[2]

#: The corpus directory holding the example files, manifest, and schema.
EXAMPLES_DIR = _REPO_ROOT / "apiome-ui" / "examples"

#: The machine-readable corpus contract this module loads.
MANIFEST_PATH = EXAMPLES_DIR / "corpus.manifest.json"

#: The published JSON Schema the manifest must validate against.
SCHEMA_PATH = EXAMPLES_DIR / "corpus.schema.json"

#: Files under ``EXAMPLES_DIR`` that are corpus *infrastructure*, not corpus
#: fixtures — excluded from completeness checks and never listed in the manifest.
NON_CORPUS_FILENAMES = frozenset({"README.md", "corpus.manifest.json", "corpus.schema.json"})


class ValidityClass(str, Enum):
    """What kind of input a corpus file is, and therefore what it proves.

    ``VALID`` files are well-formed and must import cleanly; ``INVALID`` files
    are malformed on purpose and must be rejected with a useful error;
    ``ADVERSARIAL`` files are crafted to confuse detection or normalization;
    ``SCALE`` files stress size/volume limits.
    """

    VALID = "valid"
    INVALID = "invalid"
    ADVERSARIAL = "adversarial"
    SCALE = "scale"


class ExpectedOutcome(str, Enum):
    """What a full import of the file must do."""

    IMPORTS = "imports"
    REJECTS = "rejects"
    IMPORTS_WITH_WARNINGS = "imports_with_warnings"


class Rung(str, Enum):
    """Ladder rung a valid example occupies — the IXH-1.2 depth ladder (#5088).

    Every valid corpus entry sits on exactly one rung; every non-preview
    adapter must cover all six rungs or carry a manifest ``rung_waivers``
    justification for the rungs that do not apply to its format.
    """

    MINIMAL = "minimal"
    TYPICAL = "typical"
    COMPOSITION = "composition"
    STRESS = "stress"
    REAL_WORLD = "real-world"
    MULTI_FILE = "multi-file"


class FilesetRole(str, Enum):
    """Role of a file inside a multi-file example set."""

    ROOT = "root"
    MEMBER = "member"


class IntakeGuard(str, Enum):
    """The intake guard an adversarial example targets — IXH-1.4 (#5090).

    Every ``adversarial`` corpus entry names exactly one guard, so a fixture is
    traceable to the defense it proves and a guard with no fixture is visible.
    """

    XML_ENTITY_EXPANSION = "xml-entity-expansion"
    XML_EXTERNAL_ENTITY = "xml-external-entity"
    DOCUMENT_SIZE = "document-size"
    NESTING_DEPTH = "nesting-depth"
    ALIAS_EXPANSION = "alias-expansion"
    REFERENCE_RECURSION = "reference-recursion"
    ARCHIVE_BOMB = "archive-bomb"
    ARCHIVE_PATH_TRAVERSAL = "archive-path-traversal"
    SECRET_SCRUBBING = "secret-scrubbing"


class FailureClass(str, Enum):
    """IXH-1.3 failure-taxonomy class a negative example exercises (#5089).

    Every ``invalid`` corpus entry declares exactly one class; the negative
    coverage test requires each shipped adapter to span at least five distinct
    classes.
    """

    SYNTACTIC = "syntactic"  # broken grammar for the claimed format
    SEMANTIC = "semantic"  # parses, but not a valid instance of the format
    TRUNCATED = "truncated"  # cut off mid-document
    WRONG_FORMAT = "wrong-format"  # plausible document of some *other* format
    ENCODING = "encoding"  # BOM / UTF-16 / invalid UTF-8 / mixed line endings
    UNRESOLVABLE_REF = "unresolvable-ref"  # dangling $ref / import / include
    VERSION_OUT_OF_RANGE = "version-out-of-range"  # unsupported format version


class CorpusCategory(str, Enum):
    """README grouping section for a corpus directory."""

    REST_HTTP = "rest-http"
    RPC = "rpc"
    EVENT_MESSAGING = "event-messaging"
    GRAPH = "graph"
    DATA_SCHEMA = "data-schema"
    INDUSTRY_MESSAGING = "industry-messaging"
    AGENT = "agent"


class ExpectedDetection(BaseModel):
    """The detection contract for one corpus file.

    Format detection must report :attr:`format` for the file with at least
    :attr:`min_confidence` among its candidates. A ``min_confidence`` of ``0``
    means no detection guarantee (e.g. deliberately malformed input).
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    format: str
    min_confidence: float = Field(ge=0.0, le=1.0)


class CorpusEntry(BaseModel):
    """One corpus file's manifest entry (see ``corpus.schema.json``).

    Attributes:
        path: File path relative to ``apiome-ui/examples/`` (POSIX separators).
        format: Format family key (the ``load_corpus(format=...)`` selection key).
        adapter_key: Registry key of the ImportSource adapter that must claim
            the file (``None`` when no adapter is expected to handle it).
        validity_class: See :class:`ValidityClass`.
        expected_detection: See :class:`ExpectedDetection`.
        features: Tags for what the file demonstrates (spec keywords keep native
            casing, e.g. ``oneOf``; concepts are kebab-case).
        expected_outcome: See :class:`ExpectedOutcome`.
        source: Where the file came from (e.g. ``hand-authored``).
        license: SPDX license identifier covering the file's content.
        provenance: One-sentence origin story.
        notes: Optional caveats (e.g. known detection deviations).
        rung: Ladder rung the example occupies (required on valid entries).
        fileset_role: Role inside a multi-file set (set only for files in a
            per-set subdirectory).
        failure_class: IXH-1.3 failure-taxonomy class (required on invalid
            entries, omitted otherwise).
        expected_error_code: Stable intake-taxonomy code the import job must
            fail with (required on invalid entries and on rejecting adversarial
            entries, omitted otherwise).
        guard: IXH-1.4 intake guard the entry targets (required on adversarial
            entries, omitted otherwise).
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str
    format: str
    adapter_key: Optional[str]
    validity_class: ValidityClass
    expected_detection: ExpectedDetection
    features: List[str] = Field(min_length=1)
    expected_outcome: ExpectedOutcome
    source: str
    license: str
    provenance: str
    notes: Optional[str] = None
    rung: Optional[Rung] = None
    fileset_role: Optional[FilesetRole] = None
    failure_class: Optional[FailureClass] = None
    expected_error_code: Optional[str] = None
    guard: Optional[IntakeGuard] = None

    @property
    def absolute_path(self) -> Path:
        """The corpus file's absolute filesystem path."""
        return EXAMPLES_DIR / self.path

    def read_text(self, encoding: str = "utf-8") -> str:
        """Return the corpus file's content as text.

        Args:
            encoding: Text encoding to decode with (default UTF-8).

        Returns:
            The file content.
        """
        return self.absolute_path.read_text(encoding=encoding)

    def read_bytes(self) -> bytes:
        """Return the corpus file's raw bytes.

        Negative encoding-fault fixtures (IXH-1.3) are deliberately not valid
        UTF-8, so pipeline-driving tests read bytes and let intake decode.
        """
        return self.absolute_path.read_bytes()


class CorpusDirectory(BaseModel):
    """Per-directory human-index metadata used to regenerate the README."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    label: str
    category: CorpusCategory
    paradigm: str
    marker: str


class CorpusManifest(BaseModel):
    """The parsed, validated corpus manifest."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_ref: Optional[str] = Field(default=None, alias="$schema")
    manifest_version: Literal[1]
    directories: Dict[str, CorpusDirectory]
    entries: List[CorpusEntry]
    #: Per-adapter justifications for ladder rungs that do not apply
    #: (adapter registry key -> rung -> one-sentence reason).
    rung_waivers: Dict[str, Dict[Rung, str]] = Field(default_factory=dict)


@lru_cache(maxsize=1)
def load_manifest() -> CorpusManifest:
    """Load and validate ``corpus.manifest.json`` (cached for the test session).

    Returns:
        The validated manifest.

    Raises:
        FileNotFoundError: If the manifest file is missing.
        pydantic.ValidationError: If the manifest does not match the contract.
    """
    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return CorpusManifest.model_validate(raw)


def load_corpus(
    *,
    format: Optional[str] = None,
    validity_class: Optional[ValidityClass | str] = None,
    feature: Optional[str] = None,
    adapter_key: Optional[str] = None,
    rung: Optional[Rung | str] = None,
    failure_class: Optional[FailureClass | str] = None,
    guard: Optional[IntakeGuard | str] = None,
) -> List[CorpusEntry]:
    """Return the corpus entries matching every given filter (AND semantics).

    Args:
        format: Format family key to match (e.g. ``"openapi"``, ``"avro"``).
        validity_class: Validity class to match, as enum or string.
        feature: Feature tag the entry must carry (exact match).
        adapter_key: ImportSource registry key the entry must map to.
        rung: Ladder rung to match, as enum or string.
        failure_class: IXH-1.3 failure class to match, as enum or string.
        guard: IXH-1.4 intake guard to match, as enum or string.

    Returns:
        Matching entries in manifest (path-sorted) order; empty list when
        nothing matches. With no filters, the full corpus.
    """
    wanted_class = ValidityClass(validity_class) if validity_class is not None else None
    wanted_rung = Rung(rung) if rung is not None else None
    wanted_failure = FailureClass(failure_class) if failure_class is not None else None
    wanted_guard = IntakeGuard(guard) if guard is not None else None
    entries = load_manifest().entries
    return [
        entry
        for entry in entries
        if (format is None or entry.format == format)
        and (wanted_class is None or entry.validity_class is wanted_class)
        and (feature is None or feature in entry.features)
        and (adapter_key is None or entry.adapter_key == adapter_key)
        and (wanted_rung is None or entry.rung is wanted_rung)
        and (wanted_failure is None or entry.failure_class is wanted_failure)
        and (wanted_guard is None or entry.guard is wanted_guard)
    ]


def unique_corpus_entry(*, format: str, features: Sequence[str]) -> CorpusEntry:
    """Return the single valid entry of ``format`` carrying every tag in ``features``.

    The selector for tests that pin facts about one *specific* fixture (its group layout, its
    warning set) rather than a class of them: selection stays by manifest tag — the corpus rule
    since IXH-1.1 — while ambiguity is an error instead of a silent first-match, so growing the
    corpus can never quietly re-point an assertion at a different fixture.

    Args:
        format: Format family key (e.g. ``"edix12"``).
        features: Feature tags the entry must all carry; together they must be unique.

    Returns:
        The matching entry.

    Raises:
        LookupError: When no valid entry, or more than one, carries all the tags.
    """
    matches = [
        entry
        for entry in load_corpus(format=format, validity_class=ValidityClass.VALID)
        if all(tag in entry.features for tag in features)
    ]
    if len(matches) != 1:
        raise LookupError(
            f"features {list(features)!r} select {len(matches)} valid {format!r} entries "
            f"({[entry.path for entry in matches]}); a unique-fixture selector must select one"
        )
    return matches[0]


def corpus_files() -> List[Path]:
    """Return every corpus fixture file on disk, path-sorted.

    Walks ``EXAMPLES_DIR`` recursively, skipping the corpus infrastructure
    files (:data:`NON_CORPUS_FILENAMES`). This is the ground truth the
    completeness test compares the manifest against.
    """
    return sorted(
        path
        for path in EXAMPLES_DIR.rglob("*")
        if path.is_file() and path.name not in NON_CORPUS_FILENAMES
    )
