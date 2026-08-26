"""Deployment preflight for the serverless mock adapter (#4743, PMR-1.3).

A function environment fails late and opaquely: an oversized package is rejected at deploy time, a
slow cold start shows up as a timeout on somebody else's first request, and a credential inside a
bundle is only ever discovered by whoever finds it. This module makes all three a check that runs
*before* the deploy, and prints numbers rather than reassurance.

It answers three questions, which are exactly PMR-1.3's acceptance criteria:

**Does the bundle fit?**  Its on-disk size is compared against the provider's published package
limit (:class:`~apiome_mock.serverless_providers.ProviderLimits`), with a warning well before the
hard edge, because the runtime and its dependencies share that budget.

**Is the cold start inside the provider's budget?**  Initialization is actually performed — the
bundle is read, verified, and compiled, and the application is started — and the measured cost is
compared against the metered initialization budget where the provider has one (AWS Lambda) or the
front door's timeout where it does not. A warm invocation is measured too, so the two numbers can
be read against each other.

**Does the bundle carry a provider credential?**  :func:`apiome_mock.serverless.scan_provider_secrets`
runs as part of loading, so a bundle carrying one cannot even be compiled; preflight reports the
finding instead of raising, so a CI job gets the whole picture in one run rather than one problem
at a time.

Findings have three levels: ``error`` (this will not work — the report is not ``ok``), ``warning``
(this works today and is close to an edge), and ``note`` (a constraint worth knowing that nothing
is wrong with).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from apiome_mock.bundle import MockBundleError, MockBundleIncompatibleError
from apiome_mock.portable_config import PortableSettings
from apiome_mock.serverless import (
    ColdStart,
    ProviderSecretError,
    ServerlessAdapter,
    create_adapter,
)
from apiome_mock.serverless_providers import FunctionRequest, Provider

__all__ = [
    "COLD_START_WARNING_RATIO",
    "ERROR",
    "NOTE",
    "PACKAGE_BUDGET_WARNING_RATIO",
    "WARNING",
    "PreflightFinding",
    "PreflightReport",
    "preflight",
]

#: Finding levels, in decreasing severity.
ERROR = "error"
WARNING = "warning"
NOTE = "note"

#: Warn once a bundle occupies this share of the provider's package budget. The runtime, its
#: dependencies, and the bundle share one limit, so a bundle that is merely "under the limit" on
#: its own is already a deployment problem.
PACKAGE_BUDGET_WARNING_RATIO = 0.25

#: Warn once initialization consumes this share of the provider's cold-start budget.
COLD_START_WARNING_RATIO = 0.5

#: Bytes in a kibibyte and a mebibyte, for readable size rendering.
_KIB = 1024
_MIB = 1024 * 1024


@dataclass(frozen=True)
class PreflightFinding:
    """One thing preflight has to say about a deployment.

    Attributes:
        level: :data:`ERROR`, :data:`WARNING`, or :data:`NOTE`.
        code: Stable machine-readable id, so CI can allow-list a known finding.
        detail: What it means and what to do about it.
    """

    level: str
    code: str
    detail: str

    def as_dict(self) -> dict[str, str]:
        """Render the finding for JSON output."""
        return {"level": self.level, "code": self.code, "detail": self.detail}


@dataclass(frozen=True)
class PreflightReport:
    """Everything preflight learned about deploying one bundle to one provider.

    Attributes:
        provider: The target provider.
        bundle_path: The bundle that was checked.
        bundle_bytes: Its on-disk size, or ``None`` when it could not be read.
        digest: Its manifest digest, or ``None`` when it could not be verified.
        signed: Whether it carries a signature, or ``None`` when it could not be verified.
        cold_start: Measured initialization cost, or ``None`` when it was not measured.
        warm_ms: Measured cost of one warm invocation, or ``None`` when it was not measured.
        findings: Everything worth saying, most severe first.
    """

    provider: Provider
    bundle_path: Path
    bundle_bytes: int | None
    digest: str | None
    signed: bool | None
    cold_start: ColdStart | None
    warm_ms: float | None
    findings: tuple[PreflightFinding, ...]

    @property
    def ok(self) -> bool:
        """True when nothing would prevent this bundle from working on this provider."""
        return not self.errors

    @property
    def errors(self) -> tuple[PreflightFinding, ...]:
        """The error-level findings, in report order."""
        return tuple(finding for finding in self.findings if finding.level == ERROR)

    @property
    def warnings(self) -> tuple[PreflightFinding, ...]:
        """The warning-level findings, in report order."""
        return tuple(finding for finding in self.findings if finding.level == WARNING)

    def summary(self) -> str:
        """One-line rollup suitable for CLI output and CI logs."""
        verdict = "ready" if self.ok else "not deployable"
        return f"{self.provider.title}: {verdict} ({len(self.errors)} error(s), {len(self.warnings)} warning(s))"

    def as_dict(self) -> dict[str, Any]:
        """Render the whole report for ``--json`` output."""
        return {
            "ok": self.ok,
            "provider": self.provider.as_dict(),
            "bundle": {
                "path": str(self.bundle_path),
                "bytes": self.bundle_bytes,
                "digest": self.digest,
                "signed": self.signed,
            },
            "coldStart": self.cold_start.as_dict() if self.cold_start is not None else None,
            "warmMs": round(self.warm_ms, 3) if self.warm_ms is not None else None,
            "findings": [finding.as_dict() for finding in self.findings],
        }


def _mib(value: int) -> str:
    """Render a byte count in the largest unit that keeps it readable.

    Args:
        value: A byte count.

    Returns:
        The size in MiB, KiB, or bytes. A 4 KB bundle reported as "0.0 MiB" tells a reader nothing,
        and these findings compare sizes that legitimately differ by orders of magnitude.
    """
    if value >= _MIB:
        return f"{value / _MIB:.1f} MiB"
    if value >= _KIB:
        return f"{value / _KIB:.1f} KiB"
    return f"{value} bytes"


def _load_findings(exc: MockBundleError) -> list[PreflightFinding]:
    """Turn a bundle-loading failure into the findings that explain it.

    Args:
        exc: The failure raised while loading the bundle.

    Returns:
        One finding per underlying problem, so a caller sees every reason at once.
    """
    if isinstance(exc, ProviderSecretError):
        return [
            PreflightFinding(
                level=ERROR,
                code=f"provider-secret-{finding.code}",
                detail=f"{finding.detail} Remove it from {finding.pointer} and re-export the bundle.",
            )
            for finding in exc.findings
        ]
    code = "bundle-incompatible" if isinstance(exc, MockBundleIncompatibleError) else "bundle-invalid"
    return [PreflightFinding(level=ERROR, code=code, detail=str(exc))]


def _size_findings(document_bytes: int, provider: Provider) -> list[PreflightFinding]:
    """Check the bundle against the provider's deployment package budget."""
    limit = provider.limits.max_package_bytes
    share = document_bytes / limit if limit else 0.0
    if document_bytes >= limit:
        return [
            PreflightFinding(
                level=ERROR,
                code="bundle-exceeds-package-limit",
                detail=(
                    f"The bundle alone is {_mib(document_bytes)}; {provider.title} accepts a "
                    f"{_mib(limit)} package, which also has to hold the runtime and its "
                    "dependencies."
                ),
            )
        ]
    if share >= PACKAGE_BUDGET_WARNING_RATIO:
        return [
            PreflightFinding(
                level=WARNING,
                code="bundle-uses-most-of-package-budget",
                detail=(
                    f"The bundle is {_mib(document_bytes)} — {share:.0%} of the {_mib(limit)} "
                    f"package budget on {provider.title}, which it shares with the runtime and "
                    "its dependencies."
                ),
            )
        ]
    return [
        PreflightFinding(
            level=NOTE,
            code="bundle-fits-package-budget",
            detail=(
                f"The bundle is {_mib(document_bytes)}, {share:.1%} of the {_mib(limit)} "
                f"package budget on {provider.title}."
            ),
        )
    ]


def _cold_start_findings(cold_start: ColdStart, provider: Provider) -> list[PreflightFinding]:
    """Check measured initialization against the provider's cold-start budget."""
    budget_ms = provider.limits.cold_start_budget_seconds * 1000.0
    share = cold_start.total_ms / budget_ms if budget_ms else 0.0
    measured = (
        f"Initialization took {cold_start.total_ms:.0f} ms "
        f"({cold_start.bundle_ms:.0f} ms verifying and compiling the bundle, "
        f"{cold_start.app_ms:.0f} ms starting the app)"
    )
    budget = f"{provider.title} allows {provider.limits.cold_start_budget_seconds:g}s" + (
        " for initialization"
        if provider.limits.max_init_seconds is not None
        else " for the request a cold start is charged to"
    )
    if cold_start.total_ms >= budget_ms:
        return [PreflightFinding(level=ERROR, code="cold-start-exceeds-budget", detail=f"{measured}. {budget}.")]
    if share >= COLD_START_WARNING_RATIO:
        return [
            PreflightFinding(
                level=WARNING,
                code="cold-start-uses-most-of-budget",
                detail=f"{measured} — {share:.0%} of the budget. {budget}.",
            )
        ]
    return [
        PreflightFinding(
            level=NOTE,
            code="cold-start-within-budget",
            detail=f"{measured}, {share:.1%} of the budget. {budget}.",
        )
    ]


def _constraint_notes(provider: Provider, signed: bool) -> list[PreflightFinding]:
    """The constraints that are true of every deployment to this provider."""
    limits = provider.limits
    findings = [
        PreflightFinding(
            level=NOTE,
            code="request-timeout",
            detail=(
                f"An invocation has {limits.max_gateway_timeout_seconds}s at the front door and "
                f"{limits.max_function_timeout_seconds}s in the function; the shorter one is the "
                "deadline a chaos delay has to stay inside."
            ),
        ),
        PreflightFinding(
            level=NOTE,
            code="payload-limits",
            detail=(
                f"Requests above {_mib(limits.max_request_bytes)} and responses above "
                f"{_mib(limits.max_response_bytes)} are refused as problem+json by the adapter "
                "rather than truncated by the provider."
            ),
        ),
        PreflightFinding(
            level=NOTE,
            code="session-state-is-per-instance",
            detail=(
                "X-Mock-Session state lives in the instance's memory: it survives warm "
                "invocations and is absent on a cold one. Seed with a fixture pack per session "
                "rather than assuming state from an earlier request."
            ),
        ),
    ]
    findings.extend(PreflightFinding(level=NOTE, code="provider-note", detail=note) for note in limits.notes)
    if not signed:
        findings.append(
            PreflightFinding(
                level=WARNING,
                code="bundle-unsigned",
                detail=(
                    "The bundle carries no signature. Sign it at export and set "
                    "APIOME_MOCK_BUNDLE_SECRET with APIOME_MOCK_REQUIRE_SIGNATURE=true, so a "
                    "swapped bundle cannot answer as this version."
                ),
            )
        )
    return findings


def _measure_warm(adapter: ServerlessAdapter) -> float:
    """Time one warm invocation, so cold and warm can be read against each other.

    ``/health`` is used deliberately: it is reserved by the runtime, needs no bundle content, and
    therefore measures the invocation path itself rather than any one operation's resolution.

    One invocation is discarded first. The very first request through a fresh event loop still
    imports and binds parts of the request path, so timing it would report cold-start work as warm
    latency — precisely the distinction this measurement exists to make.

    Args:
        adapter: The initialized adapter.

    Returns:
        Milliseconds a warm invocation took.
    """
    request = FunctionRequest(method="GET", path="/health")
    adapter.invoke(request)
    started = time.perf_counter()
    adapter.invoke(request)
    return (time.perf_counter() - started) * 1000.0


_LEVEL_ORDER = {ERROR: 0, WARNING: 1, NOTE: 2}


def preflight(
    bundle_path: str | Path,
    *,
    provider: Provider,
    secret: str | None = None,
    require_signature: bool = False,
) -> PreflightReport:
    """Check one bundle against one provider's published constraints.

    Initialization is really performed rather than estimated — the same load, verify, compile, and
    start a cold invocation pays for — which is what makes the cold-start number worth reporting.

    Args:
        bundle_path: The bundle to check.
        provider: The target provider.
        secret: Shared HMAC secret the signature must verify against, read from the environment by
            the caller. It is never written into the report.
        require_signature: Refuse an unsigned bundle instead of warning about it.

    Returns:
        The report. Loading failures are findings rather than exceptions, so one run tells the
        caller everything that is wrong.
    """
    path = Path(bundle_path)
    settings = PortableSettings.isolated(bundle=str(path))
    settings = settings.model_copy(update={"bundle_secret": secret, "require_signature": require_signature})

    try:
        adapter = create_adapter(settings)
    except MockBundleError as exc:
        return PreflightReport(
            provider=provider,
            bundle_path=path,
            bundle_bytes=path.stat().st_size if path.exists() else None,
            digest=None,
            signed=None,
            cold_start=None,
            warm_ms=None,
            findings=tuple(_load_findings(exc)),
        )

    try:
        findings: list[PreflightFinding] = []
        findings.extend(_size_findings(adapter.document_bytes, provider))
        findings.extend(_cold_start_findings(adapter.cold_start, provider))
        findings.extend(_constraint_notes(provider, adapter.bundle.signed))
        warm_ms = _measure_warm(adapter)
        return PreflightReport(
            provider=provider,
            bundle_path=path,
            bundle_bytes=adapter.document_bytes,
            digest=adapter.bundle.digest,
            signed=adapter.bundle.signed,
            cold_start=adapter.cold_start,
            warm_ms=warm_ms,
            findings=tuple(sorted(findings, key=lambda finding: _LEVEL_ORDER[finding.level])),
        )
    finally:
        adapter.close()
