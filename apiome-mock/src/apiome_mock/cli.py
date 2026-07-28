"""CLI entrypoint for the apiome-mock console script and ``python -m`` runs.

Two runtimes live behind one command:

``apiome-mock serve``
    The hosted runtime. Resolves published versions from Postgres and serves every tenant.
``apiome-mock run``
    The portable runtime (#4742, PMR-1.2). Serves exactly one mock bundle with no database, no
    network, and no credentials — the command ``apiome mock run`` and the official image both
    execute.

``verify`` and ``conformance`` support the portable path: the first proves a bundle is loadable
before a job depends on it, the second proves a *running* runtime answers the shared conformance
corpus correctly, which is how the CLI and the image are held to identical behavior.

Every ``run`` flag is generated from :data:`apiome_mock.portable_config.RUNTIME_OPTIONS`, so the
help text, the environment variables, and the documented reference table cannot drift apart.
"""

from __future__ import annotations

import argparse
import sys

from apiome_mock import __version__
from apiome_mock.portable_config import add_runtime_arguments


def _build_parser() -> argparse.ArgumentParser:
    """Construct the full argument parser.

    Returns:
        The parser, with the ``serve``, ``run``, ``verify``, and ``conformance`` subcommands.
    """
    parser = argparse.ArgumentParser(
        prog="apiome-mock",
        description="Apiome mock server (FastAPI).",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    subparsers = parser.add_subparsers(dest="command")

    serve_parser = subparsers.add_parser(
        "serve",
        help="Validate configuration and run the hosted (database-backed) mock HTTP server.",
    )
    serve_parser.add_argument(
        "--host",
        default=None,
        metavar="ADDR",
        help="Bind address (default: APIOME_MOCK_HTTP_HOST).",
    )
    serve_parser.add_argument(
        "--port",
        type=int,
        default=None,
        metavar="PORT",
        help="TCP port (default: APIOME_MOCK_HTTP_PORT).",
    )

    run_parser = subparsers.add_parser(
        "run",
        help="Serve one portable mock bundle (no database).",
        description=(
            "Serve a portable mock bundle. Configuration comes only from the flags below and "
            "their declared APIOME_MOCK_* environment variables; no configuration file is read."
        ),
    )
    add_runtime_arguments(run_parser)
    run_parser.add_argument(
        "--print-config",
        action="store_true",
        help="Print the resolved configuration as JSON and exit without serving.",
    )

    verify_parser = subparsers.add_parser(
        "verify",
        help="Verify a mock bundle and print what it contains, without serving it.",
    )
    add_runtime_arguments(verify_parser)
    verify_parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the verification result as JSON.",
    )

    conformance_parser = subparsers.add_parser(
        "conformance",
        help="Run the shared mock conformance corpus against a running mock runtime.",
    )
    conformance_parser.add_argument(
        "--base-url",
        required=True,
        metavar="URL",
        help="Root URL of the runtime to test, e.g. http://127.0.0.1:8775.",
    )
    conformance_parser.add_argument(
        "--corpus",
        default=None,
        metavar="PATH",
        help="Corpus document to run (default: the corpus shipped with this runtime).",
    )
    conformance_parser.add_argument(
        "--mount",
        default=None,
        metavar="PREFIX",
        help="Path prefix the spec is served under (default: read from the runtime's /ready).",
    )
    conformance_parser.add_argument(
        "--wait",
        type=float,
        default=30.0,
        metavar="SECONDS",
        help="Wait this long for /ready before running (0 disables waiting).",
    )
    conformance_parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        metavar="SECONDS",
        help="Per-request timeout.",
    )
    conformance_parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the conformance report as JSON.",
    )

    selftest_parser = subparsers.add_parser(
        "selftest",
        help="Serve the packaged conformance bundle and run the corpus against it.",
        description=(
            "Prove this deployment of the runtime answers the shared conformance corpus. Serves "
            "the bundle packaged with the runtime (not --bundle/APIOME_MOCK_BUNDLE) on a local "
            "port, runs every case, and exits non-zero on any failure."
        ),
    )
    selftest_parser.add_argument(
        "--port",
        type=int,
        default=0,
        metavar="PORT",
        help="Port to bind while testing (default: an ephemeral port).",
    )
    selftest_parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the conformance report as JSON.",
    )

    return parser


def _serve(args: argparse.Namespace) -> None:
    """Run the hosted, database-backed mock server."""
    import uvicorn
    from pydantic import ValidationError

    from apiome_mock.logging_config import configure_logging
    from apiome_mock.server import create_app
    from apiome_mock.settings import get_settings

    try:
        settings = get_settings()
    except ValidationError as exc:
        print(f"Configuration error:\n{exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    configure_logging(settings)
    host = (args.host.strip() if args.host else None) or settings.http_host
    if not host:
        print("Bind host must be non-empty.", file=sys.stderr)
        raise SystemExit(2)
    port = args.port if args.port is not None else settings.http_port
    if not (1 <= port <= 65535):
        print("--port must be between 1 and 65535", file=sys.stderr)
        raise SystemExit(2)

    uvicorn.run(create_app(), host=host, port=port, log_level=settings.log_level.lower())


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and dispatch to the selected command.

    Args:
        argv: Argument vector to parse; ``None`` uses ``sys.argv``.

    Returns:
        The process exit code.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command == "serve":
        _serve(args)
        return 0

    if args.command in {"run", "verify", "conformance", "selftest"}:
        from apiome_mock import cli_run

        handlers = {
            "run": cli_run.run_command,
            "verify": cli_run.verify_command,
            "conformance": cli_run.conformance_command,
            "selftest": cli_run.selftest_command,
        }
        return handlers[args.command](args)

    parser.print_help()
    return 0
