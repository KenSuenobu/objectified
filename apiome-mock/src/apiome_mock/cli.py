"""CLI entrypoint for the apiome-mock console script and ``python -m`` runs.

Two runtimes live behind one command:

``apiome-mock serve``
    The hosted runtime. Resolves published versions from Postgres and serves every tenant.
``apiome-mock run``
    The portable runtime (#4742, PMR-1.2). Serves exactly one mock bundle with no database, no
    network, and no credentials — the command ``apiome mock run`` and the official image both
    execute.

``preview`` (#5530, MSC-1.4) renders one synthetic request against a bundle and prints what the
mock would serve, with the decision trace — the offline half of ``apiome mock preview``.

``verify``, ``conformance``, ``parity``, ``serverless``, and ``attest`` support the portable path:
the first proves a bundle is loadable before a job depends on it, the second proves a *running*
runtime answers the shared conformance corpus correctly (how the CLI and the image are held to
identical behavior), the third (#4748, PMR-3.1) diffs a hosted deployment against a portable one
response by response, the fourth (#4743, PMR-1.3) checks a bundle against a function environment's
published limits and can run the corpus through that provider's real event shape, and the fifth
(#4749, PMR-3.2) turns what the others proved into the record a release proof attaches.

Every ``run`` flag is generated from :data:`apiome_mock.portable_config.RUNTIME_OPTIONS`, so the
help text, the environment variables, and the documented reference table cannot drift apart.
"""

from __future__ import annotations

import argparse
import sys

from apiome_mock import __version__
from apiome_mock.portable_config import add_runtime_arguments
from apiome_mock.serverless_providers import PROVIDER_NAMES


def _build_parser() -> argparse.ArgumentParser:
    """Construct the full argument parser.

    Returns:
        The parser, with the ``serve``, ``run``, ``verify``, ``preview``, ``conformance``,
        ``parity``, ``selftest``, ``serverless``, and ``attest`` subcommands.
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

    preview_parser = subparsers.add_parser(
        "preview",
        help="Render one synthetic request against a bundle and print what the mock would serve.",
        description=(
            "Render one synthetic request against a mock bundle, offline. The request document is "
            "read from a file or standard input so nothing about it — headers included — ever "
            "appears on a command line."
        ),
    )
    add_runtime_arguments(preview_parser)
    preview_parser.add_argument(
        "--request-file",
        default="-",
        metavar="PATH",
        help="Synthetic request JSON document, or '-' for standard input (default: '-').",
    )
    preview_parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the preview result as JSON.",
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

    parity_parser = subparsers.add_parser(
        "parity",
        help="Compare a hosted mock deployment against a portable one, case by case.",
        description=(
            "Run the shared conformance corpus against both a hosted mock and a portable runtime "
            "and diff every response (status, mock headers, body). This proves the two agree "
            "rather than merely that each passes on its own (#4748, PMR-3.1)."
        ),
    )
    parity_parser.add_argument(
        "--hosted-url",
        required=True,
        metavar="URL",
        help="Root URL of the hosted mock, e.g. https://mock.apiome.dev.",
    )
    parity_parser.add_argument(
        "--portable-url",
        required=True,
        metavar="URL",
        help="Root URL of the portable runtime, e.g. http://127.0.0.1:8775.",
    )
    parity_parser.add_argument(
        "--hosted-mount",
        default=None,
        metavar="PREFIX",
        help=(
            "Path prefix the hosted mock serves the version under, e.g. /acme/petstore/1.0.0 "
            "(default: the portable runtime's mount, which is the same shape)."
        ),
    )
    parity_parser.add_argument(
        "--portable-mount",
        default=None,
        metavar="PREFIX",
        help="Path prefix the portable runtime serves the spec under (default: read from /ready).",
    )
    parity_parser.add_argument(
        "--corpus",
        default=None,
        metavar="PATH",
        help="Corpus document to run (default: the corpus shipped with this runtime).",
    )
    parity_parser.add_argument(
        "--wait",
        type=float,
        default=30.0,
        metavar="SECONDS",
        help="Wait this long for the portable runtime's /ready before running (0 disables waiting).",
    )
    parity_parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        metavar="SECONDS",
        help="Per-request timeout.",
    )
    parity_parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the parity report as JSON.",
    )

    serverless_parser = subparsers.add_parser(
        "serverless",
        help="Check a bundle against a function environment's limits, and run the corpus through it.",
        description=(
            "Preflight a mock bundle for a serverless deployment (#4743, PMR-1.3). Reports the "
            "provider's published package, payload, timeout, and cold-start limits, measures what "
            "initialization actually costs, and refuses a bundle carrying provider credentials. "
            "With --conformance, the shared corpus is additionally run through the provider's own "
            "event shape against the packaged conformance bundle."
        ),
    )
    add_runtime_arguments(serverless_parser)
    serverless_parser.add_argument(
        "--provider",
        default=PROVIDER_NAMES[0],
        choices=PROVIDER_NAMES,
        help=f"Target function environment (default: {PROVIDER_NAMES[0]}).",
    )
    serverless_parser.add_argument(
        "--conformance",
        action="store_true",
        help=(
            "Also run the shared conformance corpus through the provider's event shape, against "
            "the bundle packaged with this runtime (not --bundle)."
        ),
    )
    serverless_parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the preflight report as JSON.",
    )

    attest_parser = subparsers.add_parser(
        "attest",
        help="Emit a release-proof mock verification record for a bundle.",
        description=(
            "Produce the mock verification record a release proof attaches (#4749, PMR-3.2): the "
            "bundle's immutable digest, this runtime's version, the conformance corpus identity "
            "and result, and every fixture-pack digest. A record is always emitted — a mock that "
            "was never verified says so explicitly rather than being absent."
        ),
    )
    add_runtime_arguments(attest_parser)
    attest_parser.add_argument(
        "--base-url",
        default=None,
        metavar="URL",
        help=(
            "Run the conformance corpus against this already-running runtime before attesting. "
            "Omit (and omit --conformance) to record an explicitly unverified mock."
        ),
    )
    attest_parser.add_argument(
        "--conformance",
        default=None,
        metavar="PATH",
        help="Attest from an existing `conformance --json` report instead of running the corpus.",
    )
    attest_parser.add_argument(
        "--corpus",
        default=None,
        metavar="PATH",
        help="Corpus document to run with --base-url (default: the corpus shipped here).",
    )
    attest_parser.add_argument(
        "--mount",
        default=None,
        metavar="PREFIX",
        help="Path prefix the spec is served under (default: read from the runtime's /ready).",
    )
    attest_parser.add_argument(
        "--wait",
        type=float,
        default=30.0,
        metavar="SECONDS",
        help="With --base-url, wait this long for /ready before running (0 disables waiting).",
    )
    attest_parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        metavar="SECONDS",
        help="Per-request timeout when running the corpus.",
    )
    attest_parser.add_argument(
        "--image",
        default=None,
        metavar="REF",
        help="Container image the runtime ran as. Pin a digest; a floating tag identifies nothing.",
    )
    attest_parser.add_argument(
        "--out",
        default=None,
        metavar="PATH",
        help="Write the record to this file as well as printing it.",
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

    if args.command in {
        "run",
        "verify",
        "preview",
        "conformance",
        "parity",
        "selftest",
        "serverless",
        "attest",
    }:
        from apiome_mock import cli_run

        handlers = {
            "run": cli_run.run_command,
            "verify": cli_run.verify_command,
            "preview": cli_run.preview_command,
            "conformance": cli_run.conformance_command,
            "parity": cli_run.parity_command,
            "selftest": cli_run.selftest_command,
            "serverless": cli_run.serverless_command,
            "attest": cli_run.attest_command,
        }
        return handlers[args.command](args)

    parser.print_help()
    return 0
