#!/usr/bin/env python3
"""
Generate the supported-formats reference page (FMT-1.2, #5413).

Writes:
  - docs/guide/supported-formats.md

The page is derived from the import-source registry, the emitter registry and the source-format
capability registry, so registering an adapter is all it takes to document a format. A test
(`tests/test_supported_formats_doc.py`) regenerates the page in memory and compares it against the
committed copy, so CI fails when the two drift.

Run from apiome-rest:
    uv run python scripts/generate_supported_formats_doc.py

Exits non-zero when `--check` is passed and the committed page is stale, so the same script can be
used as a pre-commit gate.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

project_root = Path(__file__).resolve().parent.parent
src = project_root / "src"
if str(src) not in sys.path:
    sys.path.insert(0, str(src))

from app.supported_formats_doc import (  # noqa: E402
    REGENERATE_COMMAND,
    SUPPORTED_FORMATS_DOCS_PAGE,
    render_supported_formats_page,
)

MONOREPO = project_root.parent


def main() -> int:
    """Write (or check) the generated page.

    Returns:
        ``0`` on success; ``1`` when ``--check`` found the committed page stale.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Do not write; exit non-zero if the committed page differs from a fresh generation.",
    )
    args = parser.parse_args()

    target = MONOREPO / SUPPORTED_FORMATS_DOCS_PAGE
    rendered = render_supported_formats_page()

    if args.check:
        current = target.read_text(encoding="utf-8") if target.is_file() else ""
        if current != rendered:
            print(
                f"{SUPPORTED_FORMATS_DOCS_PAGE} is out of date.\n"
                f"Regenerate with: {REGENERATE_COMMAND}",
                file=sys.stderr,
            )
            return 1
        print(f"{SUPPORTED_FORMATS_DOCS_PAGE} is up to date.")
        return 0

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(rendered, encoding="utf-8")
    print(f"Wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
