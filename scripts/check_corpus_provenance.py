#!/usr/bin/env python3
"""Provenance and licensing gate for the import example corpus — IXH-1.9 (#5095).

``apiome-ui/examples/corpus.manifest.json`` declares where every corpus file came
from. This script is the CI check that keeps those declarations honest, so the
corpus cannot accumulate legal debt (a vendored third-party document with no
license) or privacy debt (a payload captured from a real system with no
anonymization statement).

The rules it enforces are documented for contributors in
``docs/CORPUS_CONTRIBUTOR_GUIDE.md``; this module is their executable form::

    python3 scripts/check_corpus_provenance.py           # human report, exit 1 on violations
    python3 scripts/check_corpus_provenance.py --json    # machine-readable violations

The module is import-safe (no side effects) and depends only on the standard
library, so CI can run it without installing the apiome-rest test environment.
:func:`check_manifest` is the pure rule engine that
``apiome-rest/tests/test_corpus_provenance.py`` exercises directly.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

#: Repo-root-relative location of the corpus manifest.
MANIFEST_RELATIVE_PATH = Path("apiome-ui/examples/corpus.manifest.json")

#: The reserved ``source`` value for files written in this repository.
HAND_AUTHORED_SOURCE = "hand-authored"

#: The ``origin`` values an entry may declare, with what each one means.
#: An entry with no ``origin`` is treated as :data:`HAND_AUTHORED_SOURCE`.
ORIGINS: Dict[str, str] = {
    "hand-authored": "written in this repository from the format specification",
    "derived": "copied or adapted from a third-party document",
    "captured": "recorded from a real running system",
}

#: The default ``origin`` for entries that do not declare one.
DEFAULT_ORIGIN = "hand-authored"

#: SPDX identifiers a corpus file may be licensed under, with the reason each is
#: acceptable. Anything outside this map fails the gate: adding a license is a
#: reviewed change to this table, not a manifest edit.
APPROVED_LICENSES: Dict[str, str] = {
    "Apache-2.0": "the repository's own license",
    "MIT": "permissive, attribution-only",
    "BSD-2-Clause": "permissive, attribution-only",
    "BSD-3-Clause": "permissive, attribution-only",
    "ISC": "permissive, attribution-only",
    "CC0-1.0": "public-domain dedication",
    "CC-BY-4.0": "permissive with attribution",
    "Unlicense": "public-domain dedication",
}

#: Licenses a contributor can grant on their own for content that has no
#: upstream license — which is every ``captured`` payload, since a recording of
#: a running system carries no license from anyone else.
CONTRIBUTOR_GRANTABLE_LICENSES = frozenset({"Apache-2.0", "CC0-1.0"})

#: Shape a ``source_url`` must have (an actual fetchable upstream location).
_URL_PATTERN = re.compile(r"^https?://[^\s]+$")


@dataclass(frozen=True)
class Violation:
    """One broken provenance rule.

    Attributes:
        path: Corpus path of the offending entry (or ``<root>`` for
            manifest-level problems).
        rule: Stable rule id, e.g. ``license-required``.
        message: Human-readable explanation, including how to fix it.
    """

    path: str
    rule: str
    message: str

    def render(self) -> str:
        """Return the one-line report form of this violation."""
        return f"{self.path}: [{self.rule}] {self.message}"

    def as_dict(self) -> Dict[str, str]:
        """Return the violation as a JSON-serializable mapping."""
        return {"path": self.path, "rule": self.rule, "message": self.message}


def _text(entry: Mapping[str, Any], field: str) -> str:
    """Return a manifest string field, or ``""`` when absent/blank/not a string."""
    value = entry.get(field)
    return value.strip() if isinstance(value, str) else ""


def declared_origin(entry: Mapping[str, Any]) -> str:
    """Return an entry's declared origin, defaulting to ``hand-authored``.

    Args:
        entry: A raw manifest entry mapping.

    Returns:
        The ``origin`` value, or :data:`DEFAULT_ORIGIN` when the entry omits it.
    """
    return _text(entry, "origin") or DEFAULT_ORIGIN


def is_third_party_derived(entry: Mapping[str, Any]) -> bool:
    """Return whether an entry's content did not originate in this repository.

    Derived (vendored from an upstream document) and captured (recorded from a
    real system) entries are both third-party-derived: the repository is not the
    author of the bytes, so the licensing and privacy rules apply.

    Args:
        entry: A raw manifest entry mapping.

    Returns:
        ``True`` for derived/captured entries and for any entry whose ``source``
        is not the reserved ``hand-authored`` value.
    """
    return declared_origin(entry) != DEFAULT_ORIGIN or _text(entry, "source") != HAND_AUTHORED_SOURCE


def check_entry(entry: Mapping[str, Any]) -> List[Violation]:
    """Apply every provenance rule to a single manifest entry.

    The rules, in the order they are checked:

    * ``source-required`` — every entry says where it came from.
    * ``license-required`` — every entry declares a license, which in particular
      covers every entry with a non-empty ``source`` (the IXH-1.9 acceptance
      criterion).
    * ``license-not-approved`` — the license is on the reviewed allowlist
      (:data:`APPROVED_LICENSES`).
    * ``provenance-required`` — every entry carries its one-sentence origin story.
    * ``origin-unknown`` / ``origin-source-mismatch`` — ``origin`` is a known
      value and agrees with ``source``.
    * ``source-url-required`` / ``source-url-misplaced`` / ``source-url-invalid``
      — derived entries link the upstream document, and only they do.
    * ``anonymization-required`` / ``anonymization-misplaced`` — captured
      entries state how they were anonymized, and only they do.
    * ``capture-license-not-grantable`` — a captured payload is licensed under a
      license the contributor can actually grant.

    Args:
        entry: A raw manifest entry mapping.

    Returns:
        The violations found, in rule order; empty when the entry is clean.
    """
    path = _text(entry, "path") or "<unnamed entry>"
    violations: List[Violation] = []

    def add(rule: str, message: str) -> None:
        violations.append(Violation(path=path, rule=rule, message=message))

    source = _text(entry, "source")
    license_id = _text(entry, "license")
    provenance = _text(entry, "provenance")
    origin = declared_origin(entry)
    source_url = _text(entry, "source_url")
    anonymization = _text(entry, "anonymization")

    if not source:
        add(
            "source-required",
            f"no source declared; use {HAND_AUTHORED_SOURCE!r} or name the upstream "
            "project / capturing system",
        )
    if not license_id:
        add(
            "license-required",
            (
                f"source {source!r} is declared but no license is; "
                if source
                else "no license declared; "
            )
            + "every corpus file must name the SPDX license covering its content",
        )
    elif license_id not in APPROVED_LICENSES:
        add(
            "license-not-approved",
            f"license {license_id!r} is not on the corpus allowlist "
            f"({', '.join(sorted(APPROVED_LICENSES))}); do not vendor it without a "
            "reviewed addition to APPROVED_LICENSES in "
            "scripts/check_corpus_provenance.py",
        )
    if not provenance:
        add("provenance-required", "no provenance sentence; say how this file came to exist")

    if origin not in ORIGINS:
        add(
            "origin-unknown",
            f"origin {origin!r} is not one of {', '.join(sorted(ORIGINS))}",
        )
        return violations

    if origin == DEFAULT_ORIGIN and source and source != HAND_AUTHORED_SOURCE:
        add(
            "origin-source-mismatch",
            f"source {source!r} is not {HAND_AUTHORED_SOURCE!r}, so the entry must "
            "declare origin 'derived' (adapted from a third-party document) or "
            "'captured' (recorded from a real system)",
        )
    if origin != DEFAULT_ORIGIN and source == HAND_AUTHORED_SOURCE:
        add(
            "origin-source-mismatch",
            f"origin {origin!r} contradicts source {HAND_AUTHORED_SOURCE!r}; name the "
            "upstream project or capturing system in source",
        )

    if origin == "derived":
        if not source_url:
            add(
                "source-url-required",
                "derived entries must link the upstream document they came from "
                "in source_url",
            )
        elif not _URL_PATTERN.match(source_url):
            add("source-url-invalid", f"source_url {source_url!r} is not an http(s) URL")
    elif source_url:
        add(
            "source-url-misplaced",
            f"source_url is only meaningful on derived entries, not {origin!r} ones",
        )

    if origin == "captured":
        if not anonymization:
            add(
                "anonymization-required",
                "captured payloads must state how they were anonymized before "
                "commit (what was removed or replaced, and with what)",
            )
        if license_id and license_id not in CONTRIBUTOR_GRANTABLE_LICENSES:
            add(
                "capture-license-not-grantable",
                f"a captured payload carries no upstream license, so it must be "
                f"contributed under one of "
                f"{', '.join(sorted(CONTRIBUTOR_GRANTABLE_LICENSES))}, not {license_id!r}",
            )
    elif anonymization:
        add(
            "anonymization-misplaced",
            f"anonymization is only meaningful on captured entries, not {origin!r} ones",
        )

    return violations


def check_manifest(manifest: Mapping[str, Any]) -> List[Violation]:
    """Apply the provenance rules to a whole parsed manifest.

    Args:
        manifest: The parsed ``corpus.manifest.json`` mapping.

    Returns:
        Every violation found, entry order preserved; empty when the corpus is
        clean.

    Raises:
        TypeError: If ``manifest`` has no ``entries`` list.
    """
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise TypeError("manifest has no 'entries' list")
    violations: List[Violation] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            violations.append(
                Violation(path="<root>", rule="entry-not-an-object", message="entry is not an object")
            )
            continue
        violations.extend(check_entry(entry))
    return violations


def _summarize(manifest: Mapping[str, Any]) -> str:
    """Return a one-line count of the corpus by origin, for the success report."""
    counts: Dict[str, int] = {origin: 0 for origin in ORIGINS}
    for entry in manifest.get("entries", []):
        if isinstance(entry, Mapping):
            origin = declared_origin(entry)
            counts[origin] = counts.get(origin, 0) + 1
    return ", ".join(f"{count} {origin}" for origin, count in counts.items() if count)


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point: check the corpus manifest's provenance declarations.

    Args:
        argv: Argument list (defaults to ``sys.argv[1:]``).

    Returns:
        Process exit code: 0 when every entry is clean, 1 when any rule is
        broken.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--json",
        action="store_true",
        help="print violations as a JSON array instead of a human report",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="monorepo root containing apiome-ui/examples (default: inferred)",
    )
    args = parser.parse_args(argv)

    manifest_path = args.repo_root / MANIFEST_RELATIVE_PATH
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    violations = check_manifest(manifest)

    if args.json:
        print(json.dumps([violation.as_dict() for violation in violations], indent=2))
        return 1 if violations else 0

    if violations:
        print(
            f"{len(violations)} corpus provenance violation(s) in {manifest_path}:",
            file=sys.stderr,
        )
        for violation in violations:
            print(f"  {violation.render()}", file=sys.stderr)
        print(
            "\nSee docs/CORPUS_CONTRIBUTOR_GUIDE.md for the provenance, licensing "
            "and anonymization rules.",
            file=sys.stderr,
        )
        return 1

    print(f"corpus provenance OK ({_summarize(manifest)}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
