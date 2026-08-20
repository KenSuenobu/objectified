#!/usr/bin/env python3
"""
Generate the corpus parity coverage report (FMT-1.4, #5415).

Writes:
  - apiome-rest/tests/golden/parity/corpus_parity.json
  - apiome-rest/tests/golden/parity/corpus_parity.md

The report is derived from the live import-source and emitter registries, the corpus manifest, the
committed golden snapshots and the committed round-trip matrix, so a newly registered adapter shows
up in it without anybody editing a list. `tests/test_corpus_parity.py` rebuilds the same report in
memory and both drift-checks it and fails on any unwaived coverage gap.

Run from apiome-rest:
    uv run python scripts/generate_corpus_parity_report.py

Exits non-zero when:
  - `--check` is passed and the committed report is stale, or
  - `--fail-on-gaps` is passed and a registered adapter is missing a required artifact.

Both flags are how CI uses this script: a named, readable gate that says "regenerate the report" or
"this format has no negatives" instead of burying either among thousands of test results.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

project_root = Path(__file__).resolve().parent.parent
for extra_path in (project_root / "src", project_root / "tests"):
    if str(extra_path) not in sys.path:
        sys.path.insert(0, str(extra_path))

from corpus_parity import (  # noqa: E402
    ARTIFACT_PATH,
    MARKDOWN_PATH,
    REGENERATE_COMMAND,
    build_report,
    gap_summary,
    render_markdown,
    write_report,
)

from app.emitter import load_builtin_emitters  # noqa: E402
from app.import_source import load_builtin_import_sources  # noqa: E402


def main() -> int:
    """Write, check, or gate on the parity report.

    Returns:
        ``0`` on success; ``1`` when ``--check`` found the committed report stale or
        ``--fail-on-gaps`` found an unwaived coverage gap.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Do not write; exit non-zero if the committed report differs from a fresh build.",
    )
    parser.add_argument(
        "--fail-on-gaps",
        action="store_true",
        help="Exit non-zero when a registered adapter is missing a required artifact.",
    )
    args = parser.parse_args()

    load_builtin_import_sources()
    load_builtin_emitters()
    report = build_report()
    gaps = gap_summary(report)

    if args.check:
        stale = []
        if not ARTIFACT_PATH.is_file() or ARTIFACT_PATH.read_text(encoding="utf-8") != report.to_json():
            stale.append(str(ARTIFACT_PATH))
        rendered = render_markdown(report)
        if not MARKDOWN_PATH.is_file() or MARKDOWN_PATH.read_text(encoding="utf-8") != rendered:
            stale.append(str(MARKDOWN_PATH))
        if stale:
            print(
                "Corpus parity report is out of date:\n  "
                + "\n  ".join(stale)
                + f"\nRegenerate with: {REGENERATE_COMMAND}",
                file=sys.stderr,
            )
            return 1
        print(f"Corpus parity report is up to date ({len(report.formats)} formats gated).")
    else:
        write_report(report)
        print(f"Wrote {ARTIFACT_PATH}")
        print(f"Wrote {MARKDOWN_PATH}")

    if gaps:
        print(
            f"{len(gaps)} corpus parity gap(s):\n  " + "\n  ".join(gaps),
            file=sys.stderr,
        )
        if args.fail_on_gaps:
            return 1
    else:
        print("No corpus parity gaps: every gated format carries all four artifacts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
