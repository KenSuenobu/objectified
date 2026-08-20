#!/usr/bin/env python3
"""
Write the registry-derived format counts into every surface that states one (FMT-1.6, #5417).

Writes:
  - docs/format-counts.json                        (the machine-readable artifact)
  - apiome-browse/lib/generated/formatCounts.ts    (the portal's build-time constants)
  - apiome-ui/src/app/generated/formatCounts.ts    (the app's build-time constants)
  - README.md, docs/guide/*.md                     (the count tokens embedded in their prose)

Every number comes from `app.format_counts`, which projects the one registry traversal behind
`GET /v1/formats/matrix`. Registering an adapter is all it takes to move every count above.

Run from apiome-rest:
    uv run python scripts/generate_format_counts.py

Exits non-zero when `--check` is passed and any surface is stale, so the same script is usable as a
CI gate. `tests/test_format_counts.py` asserts the same thing, so the pytest suite catches drift
whether or not this step runs.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, List

project_root = Path(__file__).resolve().parent.parent
src = project_root / "src"
if str(src) not in sys.path:
    sys.path.insert(0, str(src))

from app.format_counts import (  # noqa: E402
    COUNTS_JSON_PATH,
    GENERATED_TS_MODULES,
    GUARDED_SOURCES,
    MARKED_DOCUMENTS,
    REGENERATE_COMMAND,
    apply_count_tokens,
    build_format_counts,
    count_tokens,
    find_unmanaged_counts,
    render_counts_json,
    render_typescript_module,
)

MONOREPO = project_root.parent


def _render_all() -> Dict[str, str]:
    """Render every managed surface.

    Returns:
        Monorepo-relative path → the file's full intended text. Marked documents are rendered from
        their committed text with only the marker values refreshed, so authored prose survives.
    """
    counts = build_format_counts()
    tokens = count_tokens(counts)

    rendered: Dict[str, str] = {COUNTS_JSON_PATH: render_counts_json(counts)}

    typescript = render_typescript_module(counts)
    for module in GENERATED_TS_MODULES:
        rendered[module] = typescript

    for document in MARKED_DOCUMENTS:
        target = MONOREPO / document
        rendered[document] = apply_count_tokens(target.read_text(encoding="utf-8"), tokens)

    return rendered


def _guard() -> List[str]:
    """Scan the guarded surfaces for hand-typed counts.

    Returns:
        One human-readable line per offence, empty when every surface is clean.
    """
    problems: List[str] = []
    for source in GUARDED_SOURCES:
        target = MONOREPO / source
        if not target.is_file():
            problems.append(f"{source}: guarded surface is missing")
            continue
        for finding in find_unmanaged_counts(source, target.read_text(encoding="utf-8")):
            problems.append(
                f"{finding.path}:{finding.line_number}: hand-typed format count "
                f"{finding.matched!r} — {finding.line}"
            )
    return problems


def main() -> int:
    """Write (or check) every managed surface, then run the hand-typed-count guard.

    Returns:
        ``0`` on success; ``1`` when ``--check`` found a stale surface, or when any surface states a
        hand-typed count (which is a failure in both modes — regenerating cannot fix it).
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Do not write; exit non-zero if any managed surface differs from a fresh generation.",
    )
    args = parser.parse_args()

    rendered = _render_all()
    stale: List[str] = []

    for path, text in sorted(rendered.items()):
        target = MONOREPO / path
        current = target.read_text(encoding="utf-8") if target.is_file() else None
        if current == text:
            continue
        if args.check:
            stale.append(path)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        print(f"Wrote {path}")

    problems = _guard()

    if stale:
        print(
            "Format counts are out of date in:\n  "
            + "\n  ".join(stale)
            + f"\nRegenerate with: {REGENERATE_COMMAND}",
            file=sys.stderr,
        )
    if problems:
        print(
            "Hand-typed format counts found. State a count in Markdown as the number followed "
            "by its tag — `42<!--format-count:importable-->` — or in TypeScript by interpolating "
            "`FORMAT_COUNTS` from the generated module:\n  "
            + "\n  ".join(problems),
            file=sys.stderr,
        )

    if stale or problems:
        return 1

    if args.check:
        print("Format counts are up to date on every managed surface.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
