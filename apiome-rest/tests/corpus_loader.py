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
from typing import Dict, List, Literal, Optional

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


class CorpusCategory(str, Enum):
    """README grouping section for a corpus directory."""

    REST_HTTP = "rest-http"
    RPC = "rpc"
    EVENT_MESSAGING = "event-messaging"
    GRAPH = "graph"
    DATA_SCHEMA = "data-schema"
    INDUSTRY_MESSAGING = "industry-messaging"


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
) -> List[CorpusEntry]:
    """Return the corpus entries matching every given filter (AND semantics).

    Args:
        format: Format family key to match (e.g. ``"openapi"``, ``"avro"``).
        validity_class: Validity class to match, as enum or string.
        feature: Feature tag the entry must carry (exact match).
        adapter_key: ImportSource registry key the entry must map to.

    Returns:
        Matching entries in manifest (path-sorted) order; empty list when
        nothing matches. With no filters, the full corpus.
    """
    wanted_class = ValidityClass(validity_class) if validity_class is not None else None
    entries = load_manifest().entries
    return [
        entry
        for entry in entries
        if (format is None or entry.format == format)
        and (wanted_class is None or entry.validity_class is wanted_class)
        and (feature is None or feature in entry.features)
        and (adapter_key is None or entry.adapter_key == adapter_key)
    ]


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
