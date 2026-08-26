"""Helpers for ``apiome repos verify`` integrity and signature output."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import typer
from rich.table import Table

from apiome_cli.output import emit_json
from apiome_cli.terminal import make_console

_INTEGRITY_FAILURE = "content_integrity_failed"
_SIGNATURE_INVALID_FAILURE = "signature_invalid"


def format_integrity_status(value: object) -> str:
    """Format ``content_integrity_verified`` for human-readable output."""
    if value is True:
        return "verified"
    if value is False:
        return "failed"
    return "pending"


def format_signature_status(value: object) -> str:
    """Format ``signature_status`` for human-readable output."""
    if value is None:
        return "unverified"
    text = str(value).strip()
    return text if text else "unverified"


def assess_repository_file_trust(file_row: dict[str, Any]) -> dict[str, Any]:
    """
    Evaluate integrity and signature trust for one repository file row.

    Returns a summary dict with ``passed`` and ``failures`` suitable for table/JSON
    output and exit-code decisions.
    """
    integrity = file_row.get("content_integrity_verified")
    signature = format_signature_status(file_row.get("signature_status"))
    failures: list[str] = []
    if integrity is False:
        failures.append(_INTEGRITY_FAILURE)
    if signature == "invalid":
        failures.append(_SIGNATURE_INVALID_FAILURE)
    return {
        "file_id": file_row.get("id"),
        "path": file_row.get("path"),
        "commit_sha": file_row.get("commit_sha"),
        "content_integrity_verified": integrity,
        "integrity_status": format_integrity_status(integrity),
        "signature_status": signature,
        "import_blocked_reason": file_row.get("import_blocked_reason"),
        "passed": not failures,
        "failures": failures,
    }


def assess_repository_files_trust(
    items: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return trust assessments for each repository file row."""
    return [assess_repository_file_trust(item) for item in items]


def count_trust_failures(assessments: Sequence[dict[str, Any]]) -> int:
    """Return the number of files that failed integrity or signature checks."""
    return sum(1 for item in assessments if not item.get("passed", False))


def emit_repository_verify_results(
    assessments: Sequence[dict[str, Any]],
    *,
    repository_id: str,
    total: int,
    json_mode: bool,
) -> None:
    """Print per-file integrity and signature trust results."""
    failure_count = count_trust_failures(assessments)
    if json_mode:
        emit_json(
            {
                "repository_id": repository_id,
                "total": total,
                "failure_count": failure_count,
                "passed": failure_count == 0,
                "items": list(assessments),
            }
        )
        return

    if not assessments:
        typer.echo("No repository files to verify.")
        typer.echo(f"Total: {total}")
        return

    typer.echo(f"Repository trust verification · {repository_id}")
    table = Table(show_header=True, header_style="bold")
    table.add_column("Path")
    table.add_column("Integrity")
    table.add_column("Signature")
    table.add_column("Commit")
    table.add_column("Result")

    for item in assessments:
        result = "pass" if item.get("passed") else "fail"
        failures = item.get("failures")
        if isinstance(failures, list) and failures:
            result = f"fail ({', '.join(str(code) for code in failures)})"
        commit_sha = item.get("commit_sha")
        commit_label = (
            str(commit_sha)[:12]
            if isinstance(commit_sha, str) and commit_sha
            else "—"
        )
        table.add_row(
            str(item.get("path") or ""),
            str(item.get("integrity_status") or "pending"),
            str(item.get("signature_status") or "unverified"),
            commit_label,
            result,
        )

    make_console().print(table)
    typer.echo(f"Showing {len(assessments)} of {total}")
    if failure_count:
        typer.echo(f"Failures: {failure_count}")
    else:
        typer.echo("All checked files passed integrity and signature verification.")
