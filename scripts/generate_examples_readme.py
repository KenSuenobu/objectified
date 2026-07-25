#!/usr/bin/env python3
"""Regenerate apiome-ui/examples/README.md from corpus.manifest.json (IXH-1.1, #5087).

The manifest is the single source of truth for the import example corpus; the
README is its generated human index. Editing the README by hand therefore drifts
and fails CI (``apiome-rest/tests/test_corpus_manifest.py`` regenerates it and
compares). Workflow: edit ``apiome-ui/examples/corpus.manifest.json``, then run::

    python3 scripts/generate_examples_readme.py            # rewrite README.md
    python3 scripts/generate_examples_readme.py --check    # exit 1 on drift

The module is import-safe (no side effects): :func:`build_readme` is a pure
function the drift test loads via ``importlib`` so CI and the CLI can never
disagree about what "regenerated" means.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

#: Repo-root-relative location of the corpus (manifest + example files + README).
EXAMPLES_DIR = Path("apiome-ui/examples")

#: README section order and headings, by manifest directory ``category`` key.
CATEGORY_ORDER: List[tuple[str, str]] = [
    ("rest-http", "REST / HTTP"),
    ("rpc", "RPC"),
    ("event-messaging", "Event / messaging"),
    ("graph", "Graph"),
    ("data-schema", "Data schema"),
    ("industry-messaging", "Industry / domain messaging"),
]


def _cell(text: str) -> str:
    """Escape a value for use inside a Markdown table cell (pipes break rows)."""
    return text.replace("|", "\\|")


def _detection_cell(entry: Dict[str, Any]) -> str:
    """Render an entry's expected_detection as ``key >= confidence`` for the index."""
    detection = entry["expected_detection"]
    min_conf = detection["min_confidence"]
    if min_conf <= 0:
        return f"`{detection['format']}` (no guarantee)"
    return f"`{detection['format']}` ≥ {min_conf:g}"


def build_readme(manifest: Dict[str, Any]) -> str:
    """Render the full README.md content for a parsed corpus manifest.

    Args:
        manifest: The parsed ``corpus.manifest.json`` mapping (``directories``
            plus ``entries``).

    Returns:
        The complete Markdown document, ending in a single trailing newline.
    """
    directories: Dict[str, Dict[str, Any]] = manifest["directories"]
    entries: List[Dict[str, Any]] = manifest["entries"]
    by_dir: Dict[str, List[Dict[str, Any]]] = {}
    for entry in entries:
        by_dir.setdefault(entry["path"].split("/", 1)[0], []).append(entry)

    lines: List[str] = []
    out = lines.append

    out("# Catalog import examples")
    out("")
    out(
        "Sample source documents for exercising the catalog **Import** flow (the "
        "ImportDialog source cards → format auto-detection → catalog item). Each file "
        "is a small, self-contained document with a header comment explaining what it "
        "demonstrates."
    )
    out("")
    out(
        "> **Generated file — do not edit.** This README is the human index of "
        "[`corpus.manifest.json`](corpus.manifest.json) (schema: "
        "[`corpus.schema.json`](corpus.schema.json)). Edit the manifest, then run "
        "`python3 scripts/generate_examples_readme.py` from the repo root; CI fails on drift."
    )
    out("")
    out(
        f"The corpus holds **{len(entries)} files** across **{len(by_dir)} format "
        "directories**. Every file has a manifest entry declaring its format family, the "
        "adapter that must claim it, its validity class, the detection contract "
        "(format key + minimum confidence), feature tags, and the expected import outcome."
    )
    out("")
    out("## How the corpus is used")
    out("")
    out(
        "- **Format auto-detection** (`apiome-rest` `format_detection.py`) sniffs each "
        "file's content and names the format; the manifest's `expected_detection` records "
        "the contract detection must meet."
    )
    out(
        "- **Tests select fixtures by tag, not by path**: `load_corpus(...)` in "
        "`apiome-rest/tests/corpus_loader.py` (pytest) and `loadCorpus(...)` in "
        "`apiome-ui/lib/corpus/corpus.ts` (Jest) filter entries by `format`, "
        "`validity_class`, `feature`, or `adapter_key`."
    )
    out(
        "- **Catalog pills** (`apiome-ui` `catalog-format-registry.ts`) render the format, "
        "protocol/paradigm, and source-material badges off the imported item."
    )
    out("")
    out("## Layout")

    for category_key, heading in CATEGORY_ORDER:
        dirs = sorted(d for d, meta in directories.items() if meta["category"] == category_key)
        if not dirs:
            continue
        out("")
        out(f"### {heading}")
        out("")
        out("| Directory | Format | Paradigm | Marker / shape | Files |")
        out("| --- | --- | --- | --- | --- |")
        for d in dirs:
            meta = directories[d]
            out(
                f"| `{d}/` | {_cell(meta['label'])} | {_cell(meta['paradigm'])} "
                f"| {_cell(meta['marker'])} | {len(by_dir.get(d, []))} |"
            )

    out("")
    out("## File index")
    out("")
    out(
        "Validity classes: `valid` imports cleanly · `invalid` must be rejected · "
        "`adversarial` tries to confuse detection · `scale` stresses limits."
    )
    for d in sorted(by_dir):
        meta = directories[d]
        out("")
        out(f"### `{d}/` — {meta['label']}")
        out("")
        out("| File | Expected detection | Class | Features |")
        out("| --- | --- | --- | --- |")
        notes: List[tuple[str, str]] = []
        for entry in by_dir[d]:
            name = entry["path"].split("/", 1)[1]
            marker = " ⚠" if "notes" in entry else ""
            features = ", ".join(f"`{feature}`" for feature in entry["features"])
            out(
                f"| `{name}`{marker} | {_cell(_detection_cell(entry))} "
                f"| {entry['validity_class']} | {_cell(features)} |"
            )
            if "notes" in entry:
                notes.append((name, entry["notes"]))
        for name, note in notes:
            out("")
            out(f"> ⚠ **`{name}`** — {note}")

    out("")
    out("## Trying an import")
    out("")
    out(
        "In the ADE dashboard, open **Import**, pick **File Upload** (or **Clipboard "
        "Paste**), and drop one of these files. Detection names the format and the import "
        "lands as a catalog item (OpenAPI/Swagger/Arazzo route to publishable Projects)."
    )
    out("")
    return "\n".join(lines)


def main(argv: List[str] | None = None) -> int:
    """CLI entry point: rewrite the README, or verify it with ``--check``.

    Args:
        argv: Argument list (defaults to ``sys.argv[1:]``).

    Returns:
        Process exit code: 0 on success/no drift, 1 when ``--check`` found drift.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="do not write; exit 1 if README.md differs from the manifest rendering",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="monorepo root containing apiome-ui/examples (default: inferred)",
    )
    args = parser.parse_args(argv)

    examples = args.repo_root / EXAMPLES_DIR
    manifest = json.loads((examples / "corpus.manifest.json").read_text(encoding="utf-8"))
    rendered = build_readme(manifest)
    readme = examples / "README.md"

    if args.check:
        current = readme.read_text(encoding="utf-8") if readme.exists() else ""
        if current != rendered:
            print(
                f"{readme} is out of date with corpus.manifest.json; "
                "run scripts/generate_examples_readme.py to regenerate.",
                file=sys.stderr,
            )
            return 1
        print(f"{readme} is up to date.")
        return 0

    readme.write_text(rendered, encoding="utf-8")
    print(f"wrote {readme}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
