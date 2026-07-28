"""``apiome-mock run``/``verify``/``conformance``/``parity`` implementations (#4742, PMR-1.2).

These are the portable-runtime commands: they never touch Postgres, and everything they need comes
from a mock bundle plus the knobs declared in :mod:`apiome_mock.portable_config`. ``parity``
(#4748, PMR-3.1) is the exception in one respect — it *addresses* a hosted deployment over HTTP to
compare it against a portable one — but it still needs no database of its own.

Exit codes are stable, because CI scripts branch on them:

===== ==========================================================================================
Code  Meaning
===== ==========================================================================================
0     Success.
2     Configuration error — a missing or invalid flag/environment value.
3     Bundle verification failed — malformed, tampered, unsigned when required, or credential-bearing.
4     Bundle is well-formed but incompatible with this runtime version.
5     Conformance failures — the runtime answered at least one corpus case wrongly.
6     Parity failures — hosted and portable deployments answered at least one case differently.
===== ==========================================================================================
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import structlog
from pydantic import ValidationError

from apiome_mock import __version__
from apiome_mock.bundle import (
    LoadedBundle,
    MockBundleError,
    MockBundleIncompatibleError,
    load_bundle_file,
)
from apiome_mock.conformance import (
    DEFAULT_BUNDLE_PATH,
    ConformanceReport,
    discover_mount,
    http_sender,
    load_corpus,
    run_corpus,
    wait_for_ready,
)
from apiome_mock.logging_config import configure_portable_logging, uvicorn_log_config
from apiome_mock.parity import ParityReport, run_parity
from apiome_mock.portable_config import PortableSettings, settings_from_args

__all__ = [
    "EXIT_BUNDLE_INCOMPATIBLE",
    "EXIT_BUNDLE_INVALID",
    "EXIT_CONFIG_ERROR",
    "EXIT_CONFORMANCE_FAILED",
    "EXIT_OK",
    "EXIT_PARITY_FAILED",
    "conformance_command",
    "parity_command",
    "run_command",
    "selftest_command",
    "serve_in_background",
    "verify_command",
]

EXIT_OK = 0
EXIT_CONFIG_ERROR = 2
EXIT_BUNDLE_INVALID = 3
EXIT_BUNDLE_INCOMPATIBLE = 4
EXIT_CONFORMANCE_FAILED = 5
EXIT_PARITY_FAILED = 6

_log = structlog.get_logger(__name__)


def _resolve_settings(args: argparse.Namespace) -> PortableSettings:
    """Resolve declared flags over declared environment, or exit 2 with a readable message.

    Args:
        args: Parsed command-line namespace.

    Returns:
        The validated portable settings.

    Raises:
        SystemExit: Exit code 2 when a value fails validation.
    """
    try:
        return settings_from_args(args)
    except ValidationError as exc:
        print(f"Configuration error:\n{exc}", file=sys.stderr)
        raise SystemExit(EXIT_CONFIG_ERROR) from exc


def _require_bundle_path(settings: PortableSettings) -> Path:
    """Return the configured bundle path, or exit 2 when none was configured."""
    if not settings.bundle.strip():
        print(
            "No bundle configured. Pass --bundle PATH or set APIOME_MOCK_BUNDLE.",
            file=sys.stderr,
        )
        raise SystemExit(EXIT_CONFIG_ERROR)
    return Path(settings.bundle.strip())


def _load(settings: PortableSettings) -> LoadedBundle:
    """Load and verify the configured bundle, mapping failures onto the documented exit codes.

    Args:
        settings: Resolved portable settings.

    Returns:
        The verified bundle.

    Raises:
        SystemExit: 2 (no bundle configured), 3 (verification failed), or 4 (incompatible).
    """
    path = _require_bundle_path(settings)
    try:
        return load_bundle_file(
            path,
            secret=settings.bundle_secret,
            require_signature=settings.require_signature,
        )
    except MockBundleIncompatibleError as exc:
        _log.error("bundle_incompatible", runtime_version=__version__, **exc.as_dict())
        print(str(exc), file=sys.stderr)
        raise SystemExit(EXIT_BUNDLE_INCOMPATIBLE) from exc
    except MockBundleError as exc:
        _log.error("bundle_invalid", **exc.as_dict())
        print(str(exc), file=sys.stderr)
        raise SystemExit(EXIT_BUNDLE_INVALID) from exc


def _bundle_report(bundle: LoadedBundle) -> dict[str, Any]:
    """Describe a verified bundle for ``verify`` output and startup logs."""
    return {
        "digest": bundle.digest,
        "signed": bundle.signed,
        "tenant": bundle.tenant_slug,
        "project": bundle.project_slug,
        "version": bundle.version_label,
        "operations": [operation.key for operation in bundle.operations],
        "scenarios": sorted(bundle.scenarios),
        "fixtures": sorted(str(entry.get("name", "")) for entry in bundle.fixtures),
        "source": str(bundle.source) if bundle.source is not None else None,
    }


def run_command(args: argparse.Namespace) -> int:
    """Serve a mock bundle over HTTP.

    Configuration is resolved and logged first, then the bundle is verified, and only then is the
    listener started — a bad bundle or a bad flag fails the process instead of failing every
    request, which is what makes a CI job's failure message useful.

    Args:
        args: Parsed ``run`` namespace.

    Returns:
        The process exit code (0 when the server shuts down cleanly).

    Raises:
        SystemExit: On configuration or bundle failures (see the module docstring).
    """
    settings = _resolve_settings(args)
    configure_portable_logging(settings.log_level)

    if args.print_config:
        print(json.dumps(settings.redacted(), indent=2, sort_keys=True))
        return EXIT_OK

    bundle = _load(settings)
    _log.info(
        "portable_runtime_starting",
        runtime_version=__version__,
        host=settings.http_host,
        port=settings.http_port,
        config=settings.redacted(),
        digest=bundle.digest,
    )

    import uvicorn

    from apiome_mock.portable import create_portable_app

    uvicorn.run(
        create_portable_app(bundle, settings),
        host=settings.http_host,
        port=settings.http_port,
        log_config=uvicorn_log_config(settings.log_level),
        access_log=False,  # the app emits one structured mock_request line per request instead
    )
    return EXIT_OK


def verify_command(args: argparse.Namespace) -> int:
    """Verify a bundle without serving it.

    Args:
        args: Parsed ``verify`` namespace.

    Returns:
        0 when the bundle verifies.

    Raises:
        SystemExit: On configuration or bundle failures (see the module docstring).
    """
    settings = _resolve_settings(args)
    configure_portable_logging(settings.log_level)
    bundle = _load(settings)
    report = _bundle_report(bundle)

    if args.json:
        print(json.dumps({"ok": True, "bundle": report}, indent=2, sort_keys=True))
        return EXIT_OK

    print(f"Bundle verified: {report['tenant']}/{report['project']}/{report['version']}")
    print(f"  digest     {report['digest']}")
    print(f"  signed     {'yes' if report['signed'] else 'no'}")
    print(f"  operations {len(report['operations'])}")
    print(f"  scenarios  {', '.join(report['scenarios']) or '(none)'}")
    print(f"  fixtures   {', '.join(report['fixtures']) or '(none)'}")
    return EXIT_OK


def selftest_command(args: argparse.Namespace) -> int:
    """Serve the packaged conformance bundle and run the corpus against it, in one process.

    This is how a *deployment* proves itself: ``docker run --rm <image> selftest`` needs no mount,
    no port publishing, and no external corpus, so "the image passes the conformance corpus" is a
    single reproducible command rather than a runbook. The same command run from a checkout proves
    the CLI path, which is why both can be held to the identical corpus.

    The packaged bundle is used deliberately, ignoring ``--bundle``/``APIOME_MOCK_BUNDLE``: the
    subject under test is the runtime, not whichever bundle happens to be mounted.

    Args:
        args: Parsed ``selftest`` namespace (``port``, ``json``).

    Returns:
        0 when every case passes, 5 when any case fails.
    """
    from apiome_mock.portable import create_portable_app, version_prefix

    configure_portable_logging("WARNING" if args.json else "INFO")
    # Declared defaults only: a deployment's ambient tuning must not change what the corpus sees,
    # and the packaged bundle is loaded with no secret because it is deliberately unsigned.
    settings = PortableSettings.isolated(bundle=str(DEFAULT_BUNDLE_PATH))
    try:
        bundle = load_bundle_file(DEFAULT_BUNDLE_PATH)
    except MockBundleError as exc:  # pragma: no cover - a broken packaged bundle is a build defect
        _log.error("packaged_bundle_invalid", **exc.as_dict())
        print(str(exc), file=sys.stderr)
        raise SystemExit(EXIT_BUNDLE_INVALID) from exc
    app = create_portable_app(bundle, settings)

    with serve_in_background(app, host="127.0.0.1", port=args.port) as base_url:
        if not wait_for_ready(base_url, timeout=30.0):
            print(f"Runtime did not become ready at {base_url}.", file=sys.stderr)
            return EXIT_CONFORMANCE_FAILED
        report = run_corpus(
            http_sender(base_url, mount=version_prefix(bundle)),
            corpus=load_corpus(),
            base_url=base_url,
        )

    if args.json:
        print(json.dumps(report.as_dict(), indent=2, sort_keys=True))
    else:
        _print_report(report)
    return EXIT_OK if report.ok else EXIT_CONFORMANCE_FAILED


@contextmanager
def serve_in_background(app: Any, *, host: str, port: int) -> Iterator[str]:
    """Run an ASGI app on a background thread for the duration of the context.

    Args:
        app: The ASGI application to serve.
        host: Bind address.
        port: TCP port; ``0`` binds an ephemeral port, which the yielded URL reflects.

    Yields:
        The base URL the app is reachable at.

    Raises:
        RuntimeError: The server thread did not bind within the startup timeout.
    """
    import uvicorn

    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 30.0
        while not server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("Mock runtime did not start within 30s.")
            time.sleep(0.05)
        bound_port = server.servers[0].sockets[0].getsockname()[1]
        yield f"http://{host}:{bound_port}"
    finally:
        server.should_exit = True
        thread.join(timeout=30.0)


def _print_report(report: ConformanceReport) -> None:
    """Print a human-readable conformance report."""
    for result in report.results:
        marker = "PASS" if result.passed else "FAIL"
        print(f"[{marker}] {result.name}")
        for failure in result.failures:
            print(f"         {failure}")
    print(report.summary())


def _print_parity_report(report: ParityReport) -> None:
    """Print a human-readable hosted/portable parity report."""
    for case in report.cases:
        if case.skipped:
            print(f"[SKIP] {case.name} (deployment-shape endpoint)")
            continue
        marker = "MATCH" if case.matched else "DIFF"
        print(f"[{marker}] {case.name}")
        for difference in case.differences:
            print(f"        {difference}")
    print(report.summary())


def parity_command(args: argparse.Namespace) -> int:
    """Compare a hosted deployment against a portable one, case by case (#4748, PMR-3.1).

    Both deployments answer the same corpus and every response is diffed (status, mock semantic
    headers, body), which catches drift that per-side pass/fail cannot: two runtimes can each
    satisfy the corpus while disagreeing on something the corpus does not assert.

    Args:
        args: Parsed ``parity`` namespace (``hosted_url``, ``portable_url``, ``hosted_mount``,
            ``portable_mount``, ``corpus``, ``timeout``, ``wait``, ``json``).

    Returns:
        0 when every compared case matches, 6 when any case differs, 5 when a deployment never
        became ready.

    Raises:
        SystemExit: Exit code 2 when the corpus file cannot be read or is not a supported corpus.
    """
    try:
        corpus = load_corpus(args.corpus)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Conformance corpus could not be loaded: {exc}", file=sys.stderr)
        raise SystemExit(EXIT_CONFIG_ERROR) from exc

    hosted_url = str(args.hosted_url).rstrip("/")
    portable_url = str(args.portable_url).rstrip("/")

    # Only the portable runtime publishes readiness; a hosted mock is a long-lived service whose
    # availability is the caller's concern, so waiting applies to the portable side alone.
    if args.wait > 0 and not wait_for_ready(portable_url, timeout=args.wait):
        print(f"{portable_url} did not become ready within {args.wait:g}s.", file=sys.stderr)
        return EXIT_CONFORMANCE_FAILED

    # The corpus stores spec-relative paths, so each side needs its mount prefix. The portable
    # runtime reports one on /ready; a hosted mock always serves /{tenant}/{project}/{version},
    # which the caller passes explicitly.
    portable_mount = args.portable_mount if args.portable_mount is not None else discover_mount(portable_url)
    hosted_mount = args.hosted_mount if args.hosted_mount is not None else portable_mount

    report = run_parity(
        http_sender(hosted_url, mount=hosted_mount, timeout=args.timeout),
        http_sender(portable_url, mount=portable_mount, timeout=args.timeout),
        corpus=corpus,
        hosted_url=hosted_url,
        portable_url=portable_url,
    )
    if args.json:
        print(json.dumps(report.as_dict(), indent=2, sort_keys=True))
    else:
        _print_parity_report(report)
    return EXIT_OK if report.ok else EXIT_PARITY_FAILED


def conformance_command(args: argparse.Namespace) -> int:
    """Run the shared conformance corpus against a running mock runtime.

    Args:
        args: Parsed ``conformance`` namespace.

    Returns:
        0 when every case passes, 5 when any case fails.

    Raises:
        SystemExit: Exit code 2 when the corpus file cannot be read or is not a supported corpus.
    """
    try:
        corpus = load_corpus(args.corpus)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Conformance corpus could not be loaded: {exc}", file=sys.stderr)
        raise SystemExit(EXIT_CONFIG_ERROR) from exc

    base_url = str(args.base_url).rstrip("/")
    if args.wait > 0 and not wait_for_ready(base_url, timeout=args.wait):
        print(f"{base_url} did not become ready within {args.wait:g}s.", file=sys.stderr)
        return EXIT_CONFORMANCE_FAILED

    # The corpus stores spec-relative paths; ask the runtime where it mounted the spec unless the
    # caller pinned a prefix explicitly.
    mount = args.mount if args.mount is not None else discover_mount(base_url)

    report = run_corpus(
        http_sender(base_url, mount=mount, timeout=args.timeout),
        corpus=corpus,
        base_url=base_url,
    )
    if args.json:
        print(json.dumps(report.as_dict(), indent=2, sort_keys=True))
    else:
        _print_report(report)
    return EXIT_OK if report.ok else EXIT_CONFORMANCE_FAILED
