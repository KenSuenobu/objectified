"""``apiome-mock run``/``verify``/``conformance``/``parity``/``serverless``/``attest``.

The portable-runtime command implementations (#4742, PMR-1.2; ``parity`` #4748, PMR-3.1;
``serverless`` #4743, PMR-1.3; ``attest`` #4749, PMR-3.2; ``preview`` #5530, MSC-1.4).

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
7     Serverless preflight failures — the bundle cannot be deployed to the chosen provider.
===== ==========================================================================================
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

import structlog
from fastapi import HTTPException
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
    report_from_dict,
    run_corpus,
    wait_for_ready,
)
from apiome_mock.logging_config import configure_portable_logging, uvicorn_log_config
from apiome_mock.parity import ParityReport, run_parity
from apiome_mock.portable_config import PortableSettings, settings_from_args
from apiome_mock.preview import ENCODING_EMPTY, ENCODING_JSON, PreviewResult, render_preview
from apiome_mock.preview_routes import PreviewRequestModel

if TYPE_CHECKING:  # pragma: no cover - import cycle avoidance; the module is imported lazily
    from apiome_mock.serverless_preflight import PreflightReport

__all__ = [
    "EXIT_BUNDLE_INCOMPATIBLE",
    "EXIT_BUNDLE_INVALID",
    "EXIT_CONFIG_ERROR",
    "EXIT_CONFORMANCE_FAILED",
    "EXIT_OK",
    "EXIT_PARITY_FAILED",
    "EXIT_SERVERLESS_FAILED",
    "attest_command",
    "conformance_command",
    "parity_command",
    "preview_command",
    "run_command",
    "selftest_command",
    "serverless_command",
    "serve_in_background",
    "verify_command",
]

EXIT_OK = 0
EXIT_CONFIG_ERROR = 2
EXIT_BUNDLE_INVALID = 3
EXIT_BUNDLE_INCOMPATIBLE = 4
EXIT_CONFORMANCE_FAILED = 5
EXIT_PARITY_FAILED = 6
EXIT_SERVERLESS_FAILED = 7

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


def _read_preview_request(source: str) -> Any:
    """Read and parse the synthetic-request document for ``preview``.

    The request never travels on a command line, so a header carrying a bearer token cannot leak
    into ``ps`` output or shell history. ``-`` reads standard input, which is how ``apiome mock
    preview --bundle`` feeds this command without writing a temporary file.

    Args:
        source: Path to a JSON document, or ``"-"`` for standard input.

    Returns:
        The parsed request document.

    Raises:
        SystemExit: Exit code 2 when the document cannot be read or is not JSON.
    """
    try:
        text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"Cannot read the request document: {exc}", file=sys.stderr)
        raise SystemExit(EXIT_CONFIG_ERROR) from exc
    if not text.strip():
        # An empty document is the documented way to say "GET /", not an error.
        return {}
    try:
        return json.loads(text)
    except ValueError as exc:
        print(f"The request document is not valid JSON: {exc}", file=sys.stderr)
        raise SystemExit(EXIT_CONFIG_ERROR) from exc


def _print_preview(result: PreviewResult) -> None:
    """Print a preview result as a short human summary."""
    print(f"{result.status} {result.media_type}  ({result.operation or 'no operation matched'})")
    print(f"  layer      {result.trace.layer}")
    if result.trace.detail:
        print(f"  detail     {result.trace.detail}")
    if result.chaos.suppressed:
        print(
            f"  chaos      suppressed (delay {result.chaos.delay_ms}ms "
            f"±{result.chaos.jitter_ms}ms, errors {result.chaos.error_rate}%)"
        )
    if result.body_encoding != ENCODING_EMPTY:
        print("  body")
        rendered = (
            json.dumps(result.body, indent=2, sort_keys=True)
            if result.body_encoding == ENCODING_JSON
            else str(result.body)
        )
        for line in rendered.splitlines():
            print(f"    {line}")


def preview_command(args: argparse.Namespace) -> int:
    """Render one synthetic request against a bundle and report what the mock would serve.

    The offline half of ``apiome mock preview`` (#5530, MSC-1.4). It renders through
    :func:`apiome_mock.preview.render_preview` — the same function the hosted control plane reaches
    over its internal hop — so a bundle previewed here and the same bundle previewed through the
    service answer identically. Nothing is served, nothing is written, and no control plane is
    contacted.

    Args:
        args: Parsed ``preview`` namespace (bundle flags plus ``--request-file`` and ``--json``).

    Returns:
        0 when the request was rendered. The status the *mock* would return is data, not an
        outcome: a previewed 404 is a successful preview.

    Raises:
        SystemExit: On configuration, request-document, or bundle failures (see the module
            docstring).
    """
    settings = _resolve_settings(args)
    configure_portable_logging(settings.log_level)
    document = _read_preview_request(args.request_file)

    try:
        # The same model the internal preview endpoint validates with, so the offline path cannot
        # accept a request shape the hosted path rejects (or the other way round).
        request = PreviewRequestModel.model_validate(document).to_preview_request()
    except ValidationError as exc:
        print(f"The request document is not a valid preview request:\n{exc}", file=sys.stderr)
        raise SystemExit(EXIT_CONFIG_ERROR) from exc
    except HTTPException as exc:
        print(f"The request document exceeds a preview limit: {exc.detail}", file=sys.stderr)
        raise SystemExit(EXIT_CONFIG_ERROR) from exc

    bundle = _load(settings)
    result = asyncio.run(render_preview(bundle.to_compiled_spec(), request))

    if args.json:
        print(json.dumps(result.as_dict(), indent=2, sort_keys=True))
    else:
        _print_preview(result)
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


def attest_command(args: argparse.Namespace) -> int:
    """Emit the release-proof mock verification record for a bundle (#4749, PMR-3.2).

    Three inputs are accepted for the conformance half, in falling order of preference:

    * ``--base-url`` — run the corpus against an already-running runtime now;
    * ``--conformance PATH`` — read a report a previous ``conformance --json`` step wrote, which is
      the usual CI shape (one job runs the corpus, another attests);
    * neither — record an **explicitly unverified** mock. This is not an error and not silence: the
      record says ``status: missing`` with a reason, because a release proof that simply omits its
      mock block cannot be told from one whose verification was skipped.

    The record is always written. A failing corpus still produces a record — it just says ``failed``
    — so the evidence of a bad build is as durable as the evidence of a good one; the exit code is
    what fails the job.

    Args:
        args: Parsed ``attest`` namespace.

    Returns:
        0 when the record says ``verified`` or ``missing``, 5 when conformance failed.

    Raises:
        SystemExit: 2 (configuration, unreadable report, or unwritable ``--out``), 3, or 4 — see
            the module docstring.
    """
    from apiome_mock.attestation import STATUS_FAILED, build_verification_record

    settings = _resolve_settings(args)
    configure_portable_logging("WARNING")
    bundle = _load(settings)

    report: ConformanceReport | None = None
    if args.base_url:
        base_url = str(args.base_url).rstrip("/")
        if args.wait > 0 and not wait_for_ready(base_url, timeout=args.wait):
            print(f"{base_url} did not become ready within {args.wait:g}s.", file=sys.stderr)
            raise SystemExit(EXIT_CONFIG_ERROR)
        try:
            corpus = load_corpus(args.corpus)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"Conformance corpus could not be loaded: {exc}", file=sys.stderr)
            raise SystemExit(EXIT_CONFIG_ERROR) from exc
        mount = args.mount if args.mount is not None else discover_mount(base_url)
        report = run_corpus(
            http_sender(base_url, mount=mount, timeout=args.timeout),
            corpus=corpus,
            base_url=base_url,
        )
    elif args.conformance:
        try:
            document = json.loads(Path(args.conformance).read_text(encoding="utf-8"))
            report = report_from_dict(document)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"Conformance report could not be read: {exc}", file=sys.stderr)
            raise SystemExit(EXIT_CONFIG_ERROR) from exc

    record = build_verification_record(bundle, report, image=args.image)
    rendered = json.dumps(record, indent=2, sort_keys=True)

    if args.out:
        try:
            Path(args.out).write_text(rendered + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"Cannot write {args.out}: {exc}", file=sys.stderr)
            raise SystemExit(EXIT_CONFIG_ERROR) from exc

    print(rendered)
    return EXIT_CONFORMANCE_FAILED if record["mock"]["status"] == STATUS_FAILED else EXIT_OK


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


def serverless_command(args: argparse.Namespace) -> int:
    """Preflight a bundle for a function environment (#4743, PMR-1.3).

    Two things a serverless deployment can only find out the hard way are checked here instead: the
    bundle's size and initialization cost against the provider's published budgets, and whether the
    bundle carries a provider credential. ``--conformance`` adds the third — that a *function
    invocation*, event translation included, answers the shared corpus exactly as every other
    runtime does.

    The two halves are independently useful, so each runs on its own: with a bundle configured the
    preflight runs, with ``--conformance`` the corpus runs, and with both, both. Only a run with
    neither is a configuration error — there would be nothing to do.

    Args:
        args: Parsed ``serverless`` namespace (``provider``, ``conformance``, ``json``, plus the
            declared runtime options).

    Returns:
        0 when the bundle is deployable and any requested corpus run passed, 7 when preflight found
        an error, 5 when a corpus case failed.

    Raises:
        SystemExit: Exit code 2 when nothing was asked for or a flag is invalid.
    """
    from apiome_mock.serverless import create_adapter, serverless_sender
    from apiome_mock.serverless_preflight import preflight
    from apiome_mock.serverless_providers import provider_for

    settings = _resolve_settings(args)
    configure_portable_logging("WARNING" if args.json else settings.log_level)
    provider = provider_for(args.provider)

    report: PreflightReport | None = None
    if settings.bundle.strip() or not args.conformance:
        report = preflight(
            _require_bundle_path(settings),
            provider=provider,
            secret=settings.bundle_secret,
            require_signature=settings.require_signature,
        )

    conformance: ConformanceReport | None = None
    if args.conformance:
        # The packaged bundle is used deliberately, as ``selftest`` does: the subject under test is
        # the adapter and the provider's event translation, not whichever bundle is being deployed.
        adapter = create_adapter(PortableSettings.isolated(bundle=str(DEFAULT_BUNDLE_PATH)))
        try:
            conformance = run_corpus(
                serverless_sender(adapter, provider=provider),
                corpus=load_corpus(),
                base_url=f"{provider.name}:{provider.entrypoint}",
            )
        finally:
            adapter.close()

    if args.json:
        payload: dict[str, Any] = {}
        if report is not None:
            payload["preflight"] = report.as_dict()
        if conformance is not None:
            payload["conformance"] = conformance.as_dict()
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        if report is not None:
            _print_preflight_report(report)
        if conformance is not None:
            if report is not None:
                print("")
            print(f"Conformance through {provider.title} events:")
            _print_report(conformance)

    if report is not None and not report.ok:
        return EXIT_SERVERLESS_FAILED
    if conformance is not None and not conformance.ok:
        return EXIT_CONFORMANCE_FAILED
    return EXIT_OK


def _print_preflight_report(report: "PreflightReport") -> None:
    """Print a human-readable serverless preflight report."""
    provider = report.provider
    print(f"Serverless preflight: {provider.title} ({provider.name})")
    print(f"  handler    {provider.entrypoint}")
    print(f"  bundle     {report.bundle_path}")
    if report.digest is not None:
        signed = "signed" if report.signed else "unsigned"
        print(f"  digest     {report.digest} ({signed})")
    if report.bundle_bytes is not None:
        print(f"  size       {report.bundle_bytes} bytes")
    if report.cold_start is not None:
        print(f"  cold start {report.cold_start.total_ms:.0f} ms")
    if report.warm_ms is not None:
        print(f"  warm call  {report.warm_ms:.1f} ms")
    print(f"  limits     {provider.limits.docs_url} (read {provider.limits.verified_on})")
    for finding in report.findings:
        print(f"[{finding.level.upper():7}] {finding.code}: {finding.detail}")
    print(report.summary())
