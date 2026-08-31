#!/usr/bin/env python3
"""Fold legacy mock instance configs onto the single mock engine (MSC-2.2 / #5532).

After applying V250 (which adds ``mock_instances.settings`` and ``migration_notes``), run from
apiome-rest:

    PYTHONPATH=src python scripts/fold_mock_instance_configs.py
    # or
    uv run python scripts/fold_mock_instance_configs.py

The data plane folds each instance lazily on first read, so this script is not required for
correctness — it exists so an operator can do the whole estate at once and, more importantly, *read
the report* before any traffic arrives. Rules that could not be translated are printed here and
stored on the instance; they are never silently dropped.

Optional ``--limit N`` processes at most N instances, ``--dry-run`` translates and reports without
writing anything. Safe to re-run: only instances whose ``settings`` is still NULL are candidates.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

project_root = Path(__file__).resolve().parent.parent
src = project_root / "src"
if str(src) not in sys.path:
    sys.path.insert(0, str(src))

from app.database import db  # noqa: E402
from app.mock_instance_config import fold_instance_config  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    """Fold every unfolded mock instance and report what could not be translated.

    Args:
        argv: Command-line arguments; ``None`` reads ``sys.argv``.

    Returns:
        A process exit code: ``0`` always, since an untranslatable rule is a thing to report, not
        a failure to fold.
    """
    parser = argparse.ArgumentParser(
        description="Translate legacy mock_instances.config into the engine's settings shape."
    )
    parser.add_argument("--limit", type=int, default=500, help="Max instances to fold in this run")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Translate and report without writing settings back",
    )
    args = parser.parse_args(argv)

    instances = db.list_unfolded_mock_instances(limit=args.limit)
    if not instances:
        print("No mock instances need folding.")
        return 0

    total_notes = 0
    for instance in instances:
        fold = fold_instance_config(instance.get("config"), instance.get("spec"))
        scenarios = fold.settings.get("scenarios") or {}
        print(
            f"{instance['id']}  {instance['tenant_slug']}/{instance['project_slug']}/"
            f"{instance['version_slug']}  scenarios={len(scenarios)}  notes={len(fold.notes)}"
        )
        for note in fold.notes:
            print(f"    ! {note}")
        total_notes += len(fold.notes)
        if not args.dry_run:
            db.fold_mock_instance_config(str(instance["id"]), fold.settings, fold.notes)

    verb = "Would fold" if args.dry_run else "Folded"
    print(f"\n{verb} {len(instances)} instance(s); {total_notes} rule(s) could not be translated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
