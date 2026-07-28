"""Hosted vs portable conformance parity (#4748, PMR-3.1).

The portable runtime only earns the word "portable" if a request answered by the *hosted* mock is
answered the same way by a bundle running in CI. :mod:`apiome_mock.conformance` proves each
deployment satisfies the shared corpus on its own; this module proves the two agree **response by
response**, which is the stronger claim and the one that catches drift a per-side pass/fail can
hide (both sides "passing" a case while differing in a header the corpus does not assert).

The comparison runs the same :class:`~apiome_mock.conformance.ConformanceCorpus` through two
:data:`~apiome_mock.conformance.Sender` callables — one per deployment — and diffs what came back:

* **status** — always compared.
* **body** — compared as decoded JSON when both sides parse, else byte for byte.
* **headers** — only the mock's *semantic* headers (:data:`COMPARED_HEADERS`). Transport headers
  (``date``, ``server``, ``content-length``, connection management) are per-deployment noise, and
  comparing them would report a difference that means nothing about mock behavior.

Two things are deliberately **not** compared:

* **Reserved operational endpoints.** Corpus cases marked ``absolute`` (``/health``, ``/ready``)
  describe the *deployment shape*, not the contract: the hosted runtime has no ``/ready`` and no
  bundle to report there. They are skipped and listed as such in the report, so a reader can see
  the exclusion rather than infer it.
* **Timing.** An injected chaos delay is asserted through its ``X-Mock-Chaos-Delay-Ms`` header
  (which *is* compared), never through wall-clock duration.

Both senders must address a runtime serving the same version, and any session state they touch is
per-deployment — the corpus keys its stateful cases by ``X-Mock-Session``, so running it twice
against two deployments never crosses state between them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from apiome_mock.conformance import (
    ConformanceCorpus,
    ConformanceRequest,
    ConformanceResponse,
    Sender,
    load_corpus,
)

__all__ = [
    "COMPARED_HEADERS",
    "ParityCase",
    "ParityReport",
    "compare_responses",
    "run_parity",
]

#: Response headers compared between deployments: everything the *mock* decides. Anything else
#: (``date``, ``server``, ``content-length``, ``connection``) is transport noise that differs
#: between a container and an in-process app without any behavior differing.
COMPARED_HEADERS: tuple[str, ...] = (
    "content-type",
    "allow",
    "retry-after",
    "x-mock-scenario",
    "x-mock-scenario-call",
    "x-mock-scenario-rule",
    "x-mock-chaos",
    "x-mock-chaos-delay-ms",
    "x-mock-fixture",
)


@dataclass(frozen=True)
class ParityCase:
    """One case's hosted/portable comparison.

    Attributes:
        name: The corpus case id.
        why: The behavior the case pins down.
        matched: True when both deployments answered identically (False when either failed to
            answer at all).
        differences: One message per differing aspect, in comparison order; empty when matched.
        skipped: True when the case describes a deployment-shape endpoint and was excluded.
        hosted_status: Status the hosted deployment returned, or ``None`` when unreachable.
        portable_status: Status the portable deployment returned, or ``None`` when unreachable.
    """

    name: str
    why: str
    matched: bool
    differences: tuple[str, ...] = ()
    skipped: bool = False
    hosted_status: int | None = None
    portable_status: int | None = None

    def as_dict(self) -> dict[str, Any]:
        """Render for JSON output."""
        return {
            "name": self.name,
            "why": self.why,
            "matched": self.matched,
            "skipped": self.skipped,
            "hostedStatus": self.hosted_status,
            "portableStatus": self.portable_status,
            "differences": list(self.differences),
        }


@dataclass(frozen=True)
class ParityReport:
    """The outcome of a whole parity run.

    Attributes:
        cases: One entry per corpus case, in corpus order (skipped cases included).
        hosted_url: The hosted deployment compared, when it was reached over the network.
        portable_url: The portable deployment compared, when it was reached over the network.
    """

    cases: tuple[ParityCase, ...]
    hosted_url: str | None = None
    portable_url: str | None = None

    @property
    def compared(self) -> tuple[ParityCase, ...]:
        """The cases that were actually compared (skipped ones excluded)."""
        return tuple(case for case in self.cases if not case.skipped)

    @property
    def mismatched(self) -> tuple[ParityCase, ...]:
        """The compared cases whose deployments disagreed."""
        return tuple(case for case in self.compared if not case.matched)

    @property
    def ok(self) -> bool:
        """True when every compared case matched."""
        return not self.mismatched

    def summary(self) -> str:
        """One-line rollup suitable for CLI output and CI logs."""
        compared = len(self.compared)
        matched = compared - len(self.mismatched)
        skipped = len(self.cases) - compared
        tail = f" ({skipped} deployment-shape cases skipped)" if skipped else ""
        return f"{matched}/{compared} cases match between hosted and portable{tail}"

    def as_dict(self) -> dict[str, Any]:
        """Render the whole report for ``--json`` output."""
        return {
            "ok": self.ok,
            "hostedUrl": self.hosted_url,
            "portableUrl": self.portable_url,
            "compared": len(self.compared),
            "matched": len(self.compared) - len(self.mismatched),
            "mismatched": len(self.mismatched),
            "skipped": len(self.cases) - len(self.compared),
            "cases": [case.as_dict() for case in self.cases],
        }


def _decoded_body(response: ConformanceResponse) -> tuple[bool, Any]:
    """Return ``(is_json, value)`` for a response body.

    JSON is compared structurally so key ordering and whitespace never register as a difference;
    anything else is compared as raw bytes.
    """
    decoded = response.json()
    if decoded is None and response.body:
        return False, response.body
    if not response.body:
        return False, b""
    return True, decoded


def compare_responses(
    hosted: ConformanceResponse,
    portable: ConformanceResponse,
    *,
    headers: tuple[str, ...] = COMPARED_HEADERS,
) -> tuple[str, ...]:
    """Diff two deployments' answers to the same request.

    Args:
        hosted: The hosted deployment's response.
        portable: The portable deployment's response.
        headers: Header names to compare (lowercase). Defaults to :data:`COMPARED_HEADERS`.

    Returns:
        One message per difference, in comparison order (status, headers, body); empty when the
        two responses are equivalent.
    """
    differences: list[str] = []

    if hosted.status != portable.status:
        differences.append(f"status: hosted {hosted.status}, portable {portable.status}")

    for name in headers:
        hosted_value = hosted.headers.get(name)
        portable_value = portable.headers.get(name)
        if name == "content-type":
            hosted_value = hosted_value.split(";")[0].strip() if hosted_value else hosted_value
            portable_value = portable_value.split(";")[0].strip() if portable_value else portable_value
        if hosted_value != portable_value:
            differences.append(f"header {name}: hosted {hosted_value!r}, portable {portable_value!r}")

    hosted_is_json, hosted_body = _decoded_body(hosted)
    portable_is_json, portable_body = _decoded_body(portable)
    if hosted_is_json != portable_is_json:
        differences.append(
            f"body: hosted is {'JSON' if hosted_is_json else 'non-JSON'}, "
            f"portable is {'JSON' if portable_is_json else 'non-JSON'}"
        )
    elif hosted_body != portable_body:
        differences.append(f"body: hosted {hosted_body!r}, portable {portable_body!r}")

    return tuple(differences)


def _answer(send: Sender, request: ConformanceRequest, setup: tuple[ConformanceRequest, ...]) -> ConformanceResponse:
    """Drive one case against one deployment: setup requests first, then the asserted request."""
    for setup_request in setup:
        send(setup_request)
    return send(request)


def run_parity(
    hosted_send: Sender,
    portable_send: Sender,
    *,
    corpus: ConformanceCorpus | None = None,
    hosted_url: str | None = None,
    portable_url: str | None = None,
    headers: tuple[str, ...] = COMPARED_HEADERS,
) -> ParityReport:
    """Run one corpus against two deployments and compare every answer.

    Each case is driven independently against each deployment (its setup requests included), so a
    stateful case starts from the same place on both sides.

    Args:
        hosted_send: Sender addressing the hosted (database-backed) deployment.
        portable_send: Sender addressing the portable (bundle-backed) deployment.
        corpus: The corpus to run; defaults to the corpus shipped with the runtime.
        hosted_url: Recorded in the report for provenance.
        portable_url: Recorded in the report for provenance.
        headers: Header names to compare; see :data:`COMPARED_HEADERS`.

    Returns:
        The report. A deployment that cannot answer a case makes that case a mismatch carrying the
        transport error, rather than raising — one unreachable route never hides the other cases.
    """
    active = corpus if corpus is not None else load_corpus()
    cases: list[ParityCase] = []

    for case in active.cases:
        if case.request.absolute:
            # Reserved operational endpoints describe the deployment, not the contract.
            cases.append(
                ParityCase(
                    name=case.name,
                    why=case.why,
                    matched=True,
                    skipped=True,
                )
            )
            continue

        try:
            hosted = _answer(hosted_send, case.request, case.setup)
        except Exception as exc:  # noqa: BLE001 - transport failures are mismatches, not crashes
            cases.append(
                ParityCase(
                    name=case.name,
                    why=case.why,
                    matched=False,
                    differences=(f"hosted request failed: {exc}",),
                )
            )
            continue
        try:
            portable = _answer(portable_send, case.request, case.setup)
        except Exception as exc:  # noqa: BLE001 - transport failures are mismatches, not crashes
            cases.append(
                ParityCase(
                    name=case.name,
                    why=case.why,
                    matched=False,
                    differences=(f"portable request failed: {exc}",),
                    hosted_status=hosted.status,
                )
            )
            continue

        differences = compare_responses(hosted, portable, headers=headers)
        cases.append(
            ParityCase(
                name=case.name,
                why=case.why,
                matched=not differences,
                differences=differences,
                hosted_status=hosted.status,
                portable_status=portable.status,
            )
        )

    return ParityReport(cases=tuple(cases), hosted_url=hosted_url, portable_url=portable_url)
