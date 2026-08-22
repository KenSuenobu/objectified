"""Evidence resolver for the declared version-coverage conformance suite — FMT-3.8 (#5433).

:mod:`app.format_version_coverage` declares, per format, the versions Apiome reads and writes.
A declaration is worth nothing on its own — the prose in the adapter docstrings it replaces was
also a declaration, and it drifted. This module resolves each declared version to the artifact
that demonstrates it:

* a **read** version is demonstrated by a ``valid`` corpus entry whose adapter is the declaring
  adapter and whose ``expected_detection.format`` is the version's ``format_key``. That is the
  ticket's "at least one corpus entry that detects at that version" — the manifest states the
  contract, and :mod:`tests.test_corpus_import` proves detection actually meets it, so a hit here
  is a fixture the detection suite already exercises rather than a second opinion about it;
* a **write** version is demonstrated by a row in the committed round-trip matrix artifact whose
  ``emit_format`` is the version's ``format_key``.

**Deterministic and environment-independent**, for the same reason :mod:`tests.corpus_parity` is:
the inputs are the corpus manifest and the *committed* matrix artifact, never a live parse, emit
or toolchain probe. A developer without ``buf`` installed sees the same conformance result CI
does, because the question is "does the evidence exist", not "does it run here".

A version that genuinely cannot be evidenced is waived **by name and reason** in
:data:`KNOWN_VERSION_COVERAGE_WAIVERS`, never by silence — and the waiver is strict, so a waived
version that starts being evidenced fails the suite until the waiver is deleted.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple

from corpus_adapter_support import valid_entries
from corpus_roundtrip import ARTIFACT_PATH as MATRIX_ARTIFACT_PATH

from app.format_version_coverage import FormatVersion, declared_version_coverage
from app.import_source import ImportSourceDescriptor, describe_import_sources
from app.supported_formats_doc import INTERNAL_FORMAT_KEYS, is_shipped_import_source

__all__ = [
    "KNOWN_VERSION_COVERAGE_WAIVERS",
    "ConformanceRow",
    "Direction",
    "conformance_rows",
    "covered_descriptors",
    "read_evidence",
    "waiver_for",
    "write_evidence",
]

#: ``(import_source_key, direction, version) -> reason`` for a declared version whose evidence
#: cannot exist.
#:
#: Empty: every version FMT-3.8 declares is demonstrated by a fixture. An entry here must say *why
#: the fixture cannot exist* — "not authored yet" means the version should not be declared, and the
#: suite is supposed to say so.
KNOWN_VERSION_COVERAGE_WAIVERS: Dict[Tuple[str, str, str], str] = {}


class Direction(str, Enum):
    """Which half of a format's coverage a row belongs to."""

    #: Versions the format is read at; evidenced by a corpus fixture that detects at the key.
    READ = "read"
    #: Versions the format is written at; evidenced by a round-trip matrix row for the emit key.
    WRITE = "write"


@dataclass(frozen=True)
class ConformanceRow:
    """One declared version and the evidence resolved for it.

    Attributes:
        format_key: The import-source registry key that declared the version.
        direction: See :class:`Direction`.
        version: The declared version, as :attr:`app.format_version_coverage.FormatVersion.version`
            spells it.
        selector: The registry key the version is selected by — a detection key for a read, an
            emitter output-format key for a write.
        evidence: The artifacts demonstrating it: corpus paths for a read, emit-target keys for a
            write. Empty when nothing demonstrates it.
        waiver: The recorded reason this version has no evidence, or ``None``.
    """

    format_key: str
    direction: Direction
    version: str
    selector: str
    evidence: Tuple[str, ...]
    waiver: Optional[str]

    @property
    def evidenced(self) -> bool:
        """Whether at least one artifact demonstrates this version."""
        return bool(self.evidence)


def covered_descriptors() -> List[ImportSourceDescriptor]:
    """Return the descriptors every format must declare version coverage for.

    The same population the FMT-1.4 parity gate and the generated docs page use: adapters this
    repository ships, minus the internal machinery keys. Excluding ``sample`` here rather than
    declaring coverage for it keeps one answer to "which formats does Apiome publish?" — a format
    that is not published is not required to carry fixtures either, and a version claim with no
    fixture is exactly what this suite exists to reject.

    Returns:
        The shipped, non-internal import-source descriptors, in registry order.
    """
    return [
        descriptor
        for descriptor in describe_import_sources()
        if is_shipped_import_source(descriptor.key) and descriptor.key not in INTERNAL_FORMAT_KEYS
    ]


def read_evidence() -> Dict[Tuple[str, str], Tuple[str, ...]]:
    """Index the corpus by ``(adapter key, detection format key)`` → the paths demonstrating it.

    Only ``valid`` entries count. An ``invalid`` fixture proves a rejection, not a version, and an
    entry claimed by a *different* adapter proves that adapter's coverage rather than this one's —
    an Arazzo fileset whose companion is an OpenAPI document is Arazzo's evidence, not OpenAPI's.

    Returns:
        ``(adapter_key, expected_detection.format)`` → the corpus paths, sorted.
    """
    index: Dict[Tuple[str, str], List[str]] = defaultdict(list)
    for entry in valid_entries():
        assert entry.adapter_key is not None  # valid_entries() filters these out
        index[(entry.adapter_key, entry.expected_detection.format)].append(entry.path)
    return {key: tuple(sorted(paths)) for key, paths in index.items()}


def write_evidence() -> Dict[str, Tuple[str, ...]]:
    """Index the committed round-trip matrix by emit format → the emit keys producing it.

    Reads the artifact rather than running the matrix, so the answer does not depend on which
    bundled binaries this machine happens to have.

    Returns:
        ``emit_format`` → the emit-target keys with a row for it, sorted.
    """
    matrix = json.loads(MATRIX_ARTIFACT_PATH.read_text(encoding="utf-8"))
    index: Dict[str, set] = defaultdict(set)
    for cell in matrix.get("cells", []):
        emit_format = cell.get("emit_format")
        if isinstance(emit_format, str):
            index[emit_format].add(str(cell.get("emit_key") or emit_format))
    return {emit_format: tuple(sorted(keys)) for emit_format, keys in index.items()}


def waiver_for(format_key: str, direction: Direction, version: str) -> Optional[str]:
    """Return the recorded reason this version needs no evidence, or ``None``.

    Args:
        format_key: The import-source registry key.
        direction: Read or write.
        version: The declared version string.

    Returns:
        The waiver reason, or ``None`` when the version is not waived.
    """
    return KNOWN_VERSION_COVERAGE_WAIVERS.get((format_key, direction.value, version))


def _rows_for(
    format_key: str,
    direction: Direction,
    versions: Sequence[FormatVersion],
    evidence_of,
) -> List[ConformanceRow]:
    """Build the conformance rows for one format and direction.

    Args:
        format_key: The import-source registry key.
        direction: Read or write.
        versions: The declared versions for that direction.
        evidence_of: Callable resolving one version to its evidence tuple.

    Returns:
        One :class:`ConformanceRow` per declared version, in declaration order.
    """
    return [
        ConformanceRow(
            format_key=format_key,
            direction=direction,
            version=version.version,
            selector=version.format_key,
            evidence=evidence_of(version),
            waiver=waiver_for(format_key, direction, version.version),
        )
        for version in versions
    ]


def conformance_rows() -> List[ConformanceRow]:
    """Resolve every declared version to its evidence, for every declared format.

    The suite's whole input: one row per declared version, carrying what demonstrates it (or the
    recorded reason nothing can).

    Returns:
        Every format's read rows then write rows, in declaration order.
    """
    reads = read_evidence()
    writes = write_evidence()
    rows: List[ConformanceRow] = []
    for format_key, coverage in declared_version_coverage().items():
        rows.extend(
            _rows_for(
                format_key,
                Direction.READ,
                coverage.reads,
                # ``key=format_key`` binds the loop variable now rather than at call time. The
                # lambda is applied eagerly inside ``_rows_for``, so late binding would not
                # actually bite here — but a closure over a loop variable is a trap a later edit
                # would fall into.
                lambda version, key=format_key: reads.get((key, version.format_key), ()),
            )
        )
        rows.extend(
            _rows_for(
                format_key,
                Direction.WRITE,
                coverage.writes,
                lambda version: writes.get(version.format_key, ()),
            )
        )
    return rows
