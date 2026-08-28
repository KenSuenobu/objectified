"""Shared mock conformance corpus and runner (#4742, PMR-1.2).

The portable runtime only earns the word "portable" if the *same* requests produce the *same*
responses wherever it runs. This module is how that is proven: a declarative corpus of
request/expectation pairs (``conformance_data/corpus.json``) paired with the bundle they run
against (``conformance_data/bundle.json``), plus a runner that can drive any deployment of the
runtime. Both files ship *inside the package*, so an image built from this runtime can verify
itself with nothing else mounted.

The runner deliberately talks plain HTTP through :mod:`urllib` instead of a test client, so the
identical corpus runs against:

* the in-process application (unit tests),
* a locally launched ``apiome-mock run`` process (the path ``apiome mock run`` takes), and
* a container started from the official image (``apiome-mock conformance --base-url ...``).

Corpus documents declare their own format id so a future corpus (PMR-3.1 extends this one) can
change shape without silently mis-running against an older runtime.

Assertion vocabulary — small on purpose, because a conformance corpus that can express anything
proves nothing repeatable:

``status``
    Required. Exact HTTP status code.
``contentType``
    Response ``Content-Type`` must start with this value (parameters such as ``charset`` ignored).
``headers``
    Mapping of header name to exact expected value (case-insensitive names).
``headerPresent``
    List of header names that must be present, whatever their value.
``jsonEquals``
    The decoded JSON body must equal this value exactly.
``jsonContains``
    Every key/value in this object must appear in the decoded JSON body (recursively for nested
    objects; lists compare exactly).
``bodyEmpty``
    ``true`` asserts a zero-length body.
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

__all__ = [
    "CORPUS_FORMAT",
    "DEFAULT_BUNDLE_PATH",
    "DEFAULT_CORPUS_PATH",
    "CaseResult",
    "ConformanceCase",
    "ConformanceCorpus",
    "ConformanceReport",
    "ConformanceRequest",
    "ConformanceResponse",
    "Sender",
    "corpus_digest",
    "discover_mount",
    "http_sender",
    "load_corpus",
    "report_from_dict",
    "run_corpus",
    "wait_for_ready",
]

#: Format id every corpus document must declare.
CORPUS_FORMAT = "apiome.mock.conformance/v1"

_CONFORMANCE_DIR = Path(__file__).resolve().parent / "conformance_data"

#: Corpus shipped with the runtime.
DEFAULT_CORPUS_PATH = _CONFORMANCE_DIR / "corpus.json"

#: Bundle the shipped corpus runs against.
DEFAULT_BUNDLE_PATH = _CONFORMANCE_DIR / "bundle.json"


def corpus_digest(document: Mapping[str, Any]) -> str:
    """Content digest of a corpus document — its immutable identity (#4749, PMR-3.2).

    The digest is taken over the document's *canonical* JSON (sorted keys, compact separators), so
    reindenting or reordering the file does not change it while adding, removing, or editing a case
    does. That is what makes "these two runs executed the same corpus" answerable from the record
    rather than from a filename, and it is the identity a release-proof mock attestation carries
    alongside the declared ``corpusVersion``.

    Args:
        document: The parsed corpus document.

    Returns:
        ``sha256:<hex>`` over the canonical bytes.
    """
    payload = json.dumps(document, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ConformanceRequest:
    """One HTTP request a conformance case sends.

    Attributes:
        method: HTTP method.
        path: Path *relative to the spec* (the runner prepends the runtime's mount prefix).
        headers: Request headers.
        query: Query parameters appended to ``path``.
        json_body: Body to send as ``application/json``; ``None`` sends no body.
        repeat: How many times to send the request; only the final response is asserted. Values
            above one exercise sequence behavior (scenario response sequences, stateful counters).
        absolute: True when ``path`` is relative to the runtime *root* rather than to the spec —
            used for the reserved ``/health`` and ``/ready`` endpoints, which are never mounted
            under the bundle's path prefix.
    """

    method: str
    path: str
    headers: Mapping[str, str] = field(default_factory=dict)
    query: Mapping[str, str] = field(default_factory=dict)
    json_body: Any | None = None
    repeat: int = 1
    absolute: bool = False


@dataclass(frozen=True)
class ConformanceResponse:
    """The response a :data:`Sender` observed.

    Attributes:
        status: HTTP status code.
        headers: Response headers, keyed by lowercase name.
        body: Raw response body.
    """

    status: int
    headers: Mapping[str, str]
    body: bytes

    def json(self) -> Any:
        """Decode the body as JSON.

        Returns:
            The decoded value, or ``None`` when the body is empty or not valid JSON.
        """
        if not self.body:
            return None
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None


#: Anything that can send a conformance request and report the response.
Sender = Callable[[ConformanceRequest], ConformanceResponse]


@dataclass(frozen=True)
class ConformanceCase:
    """One corpus case: a request, an expectation, and why the case exists.

    Attributes:
        name: Stable case id, used in reports and failure messages.
        why: The behavior the case pins down (published in reports so a failure is self-explaining).
        setup: Requests sent, in order, before the asserted one. Their responses are ignored; they
            exist to put the runtime into a state (for example, creating a resource in a mock
            session before reading it back).
        request: The request to send and assert on.
        expect: The raw expectation object (see the module docstring for the vocabulary).
    """

    name: str
    why: str
    request: ConformanceRequest
    expect: Mapping[str, Any]
    setup: tuple[ConformanceRequest, ...] = ()


@dataclass(frozen=True)
class ConformanceCorpus:
    """A parsed corpus document.

    Attributes:
        format: Declared corpus format id.
        description: Human summary of what the corpus covers.
        bundle: Bundle filename the corpus expects the runtime to be serving.
        cases: The cases, in document order.
        source: Path the corpus was read from.
        version: Label the document declared as ``corpusVersion`` (``""`` when undeclared).
        digest: ``sha256:<hex>`` over the document's canonical JSON — the corpus identity a
            release-proof mock attestation records (#4749, PMR-3.2).
    """

    format: str
    description: str
    bundle: str
    cases: tuple[ConformanceCase, ...]
    source: Path | None = None
    version: str = ""
    digest: str = ""

    def identity(self) -> dict[str, Any]:
        """The corpus identity a verification record carries (#4749, PMR-3.2).

        Returns:
            ``{"format", "version", "digest", "caseCount"}``. ``version`` is the label the document
            declared (``""`` when it declared none); ``digest`` is the authoritative identity.
        """
        return {
            "format": self.format,
            "version": self.version,
            "digest": self.digest,
            "caseCount": len(self.cases),
        }


@dataclass(frozen=True)
class CaseResult:
    """Outcome of one case.

    Attributes:
        name: The case id.
        why: The behavior the case pins down.
        passed: True when every assertion held.
        failures: One message per failed assertion (empty when passed).
        status: Observed HTTP status, or ``None`` when the request could not be sent.
    """

    name: str
    why: str
    passed: bool
    failures: tuple[str, ...] = ()
    status: int | None = None

    def as_dict(self) -> dict[str, Any]:
        """Render for JSON output."""
        return {
            "name": self.name,
            "why": self.why,
            "passed": self.passed,
            "status": self.status,
            "failures": list(self.failures),
        }


@dataclass(frozen=True)
class ConformanceReport:
    """The outcome of a whole corpus run.

    Attributes:
        results: One entry per case, in corpus order.
        base_url: The runtime the corpus ran against, when it ran over the network.
        corpus: Identity of the corpus that was executed (:meth:`ConformanceCorpus.identity`).
            Carried so a report can say *which* corpus produced it — the identity a release-proof
            mock attestation records (#4749, PMR-3.2).
    """

    results: tuple[CaseResult, ...]
    base_url: str | None = None
    corpus: Mapping[str, Any] | None = None

    @property
    def ok(self) -> bool:
        """True when every case passed."""
        return all(result.passed for result in self.results)

    @property
    def failed(self) -> tuple[CaseResult, ...]:
        """The failing cases, in corpus order."""
        return tuple(result for result in self.results if not result.passed)

    def summary(self) -> str:
        """One-line rollup suitable for CLI output and CI logs."""
        passed = len(self.results) - len(self.failed)
        return f"{passed}/{len(self.results)} conformance cases passed"

    def as_dict(self) -> dict[str, Any]:
        """Render the whole report for ``--json`` output."""
        return {
            "ok": self.ok,
            "baseUrl": self.base_url,
            "corpus": dict(self.corpus) if self.corpus is not None else None,
            "total": len(self.results),
            "passed": len(self.results) - len(self.failed),
            "failed": len(self.failed),
            "cases": [result.as_dict() for result in self.results],
        }


def report_from_dict(document: Mapping[str, Any]) -> ConformanceReport:
    """Rebuild a report from its ``--json`` rendering — the inverse of :meth:`ConformanceReport.as_dict`.

    A CI pipeline usually runs the corpus in one step and attests in another, so the report has to
    survive a round trip through a file. This is that loader; keeping it beside :meth:`as_dict`
    is what stops the two shapes drifting.

    Args:
        document: A parsed conformance report document.

    Returns:
        The report. Unknown keys are ignored; a missing ``cases`` array yields an empty report.

    Raises:
        ValueError: The document is not an object, or a case entry is not one.
    """
    body = _require_mapping(document, "report")
    raw_cases = body.get("cases") or []
    if not isinstance(raw_cases, Sequence) or isinstance(raw_cases, (str, bytes)):
        raise ValueError("Conformance report 'cases' must be an array.")
    results = []
    for entry in raw_cases:
        case = _require_mapping(entry, "report case")
        failures = case.get("failures") or []
        results.append(
            CaseResult(
                name=str(case.get("name", "")),
                why=str(case.get("why", "")),
                passed=bool(case.get("passed")),
                failures=tuple(str(failure) for failure in failures),
                status=case.get("status"),
            )
        )
    corpus = body.get("corpus")
    return ConformanceReport(
        results=tuple(results),
        base_url=body.get("baseUrl"),
        corpus=dict(corpus) if isinstance(corpus, Mapping) else None,
    )


# ==================================================================================================
# Loading
# ==================================================================================================


def _require_mapping(value: Any, what: str) -> Mapping[str, Any]:
    """Return ``value`` as a mapping or raise a corpus error naming ``what``."""
    if not isinstance(value, Mapping):
        raise ValueError(f"Conformance corpus {what} must be an object.")
    return value


def _parse_request(raw: Any, *, case_name: str) -> ConformanceRequest:
    """Build a :class:`ConformanceRequest` from its corpus JSON object."""
    body = _require_mapping(raw, f"case '{case_name}' request")
    path = str(body.get("path", ""))
    if not path.startswith("/"):
        raise ValueError(f"Conformance case '{case_name}' request.path must start with '/'.")
    repeat = int(body.get("repeat", 1))
    if repeat < 1:
        raise ValueError(f"Conformance case '{case_name}' request.repeat must be at least 1.")
    return ConformanceRequest(
        method=str(body.get("method", "GET")).upper(),
        path=path,
        headers={str(key): str(value) for key, value in dict(body.get("headers") or {}).items()},
        query={str(key): str(value) for key, value in dict(body.get("query") or {}).items()},
        json_body=body.get("json"),
        repeat=repeat,
        absolute=bool(body.get("absolute", False)),
    )


def load_corpus(path: str | Path | None = None) -> ConformanceCorpus:
    """Read and validate a corpus document.

    Args:
        path: Corpus file; defaults to the corpus shipped with the runtime.

    Returns:
        The parsed corpus.

    Raises:
        ValueError: The document is not a v1 corpus, or a case is malformed.
        OSError: The file could not be read.
        json.JSONDecodeError: The file is not JSON.
    """
    corpus_path = Path(path) if path is not None else DEFAULT_CORPUS_PATH
    document = json.loads(corpus_path.read_text(encoding="utf-8"))
    body = _require_mapping(document, "document")
    declared = str(body.get("corpusFormat", ""))
    if declared != CORPUS_FORMAT:
        raise ValueError(f"Unsupported conformance corpus format '{declared}' (expected {CORPUS_FORMAT}).")

    raw_cases = body.get("cases")
    if not isinstance(raw_cases, Sequence) or isinstance(raw_cases, (str, bytes)) or not raw_cases:
        raise ValueError("Conformance corpus must declare a non-empty 'cases' array.")

    cases: list[ConformanceCase] = []
    seen: set[str] = set()
    for entry in raw_cases:
        case = _require_mapping(entry, "case")
        name = str(case.get("name", "")).strip()
        if not name:
            raise ValueError("Every conformance case needs a 'name'.")
        if name in seen:
            raise ValueError(f"Duplicate conformance case name '{name}'.")
        seen.add(name)
        expect = _require_mapping(case.get("expect"), f"case '{name}' expect")
        if "status" not in expect:
            raise ValueError(f"Conformance case '{name}' must expect a status.")
        cases.append(
            ConformanceCase(
                name=name,
                why=str(case.get("why", "")).strip(),
                request=_parse_request(case.get("request"), case_name=name),
                expect=dict(expect),
                setup=tuple(_parse_request(entry, case_name=name) for entry in list(case.get("setup") or [])),
            )
        )

    return ConformanceCorpus(
        format=declared,
        description=str(body.get("description", "")),
        bundle=str(body.get("bundle", "")),
        cases=tuple(cases),
        source=corpus_path,
        version=str(body.get("corpusVersion", "")).strip(),
        digest=corpus_digest(body),
    )


# ==================================================================================================
# Assertions
# ==================================================================================================


def _contains(actual: Any, expected: Any, pointer: str) -> list[str]:
    """Recursively check that ``expected`` is contained in ``actual``.

    Mappings compare key-wise (extra keys in ``actual`` are fine); everything else compares equal.

    Args:
        actual: Observed value.
        expected: Expected subset.
        pointer: JSON-pointer-ish location used in failure messages.

    Returns:
        A list of failure messages (empty when contained).
    """
    if isinstance(expected, Mapping):
        if not isinstance(actual, Mapping):
            return [f"{pointer or '$'}: expected an object, got {type(actual).__name__}"]
        failures: list[str] = []
        for key, value in expected.items():
            if key not in actual:
                failures.append(f"{pointer}/{key}: missing")
                continue
            failures.extend(_contains(actual[key], value, f"{pointer}/{key}"))
        return failures
    if actual != expected:
        return [f"{pointer or '$'}: expected {expected!r}, got {actual!r}"]
    return []


def check_response(response: ConformanceResponse, expect: Mapping[str, Any]) -> tuple[str, ...]:
    """Evaluate one case's expectations against a response.

    Args:
        response: The observed response.
        expect: The case's expectation object.

    Returns:
        One message per failed assertion, in evaluation order; empty when the case passed.
    """
    failures: list[str] = []

    expected_status = int(expect["status"])
    if response.status != expected_status:
        failures.append(f"status: expected {expected_status}, got {response.status}")

    content_type = expect.get("contentType")
    if isinstance(content_type, str):
        actual = response.headers.get("content-type", "")
        if actual.split(";")[0].strip() != content_type:
            failures.append(f"content-type: expected {content_type!r}, got {actual!r}")

    for name, value in dict(expect.get("headers") or {}).items():
        actual_header = response.headers.get(name.lower())
        if actual_header != value:
            failures.append(f"header {name}: expected {value!r}, got {actual_header!r}")

    for name in list(expect.get("headerPresent") or []):
        if str(name).lower() not in response.headers:
            failures.append(f"header {name}: missing")

    if expect.get("bodyEmpty") is True and response.body:
        failures.append(f"body: expected empty, got {len(response.body)} bytes")

    if "jsonEquals" in expect:
        decoded = response.json()
        if decoded != expect["jsonEquals"]:
            failures.append(f"body: expected {expect['jsonEquals']!r}, got {decoded!r}")

    if "jsonContains" in expect:
        failures.extend(_contains(response.json(), expect["jsonContains"], ""))

    return tuple(failures)


# ==================================================================================================
# Running
# ==================================================================================================


def run_corpus(
    send: Sender,
    *,
    corpus: ConformanceCorpus | None = None,
    base_url: str | None = None,
) -> ConformanceReport:
    """Run every case in a corpus against a runtime.

    Args:
        send: How to send one request (see :func:`http_sender`).
        corpus: The corpus to run; defaults to the shipped corpus.
        base_url: Recorded in the report for provenance; does not affect sending.

    Returns:
        The report. A case whose request could not be sent at all fails with the transport error
        as its message rather than raising, so one unreachable route cannot hide the other cases.
    """
    active = corpus if corpus is not None else load_corpus()
    results: list[CaseResult] = []
    for case in active.cases:
        try:
            for setup_request in case.setup:
                send(setup_request)
            response = send(case.request)
        except Exception as exc:  # noqa: BLE001 - transport failures are case failures, not crashes
            results.append(CaseResult(name=case.name, why=case.why, passed=False, failures=(f"request failed: {exc}",)))
            continue
        failures = check_response(response, case.expect)
        results.append(
            CaseResult(
                name=case.name,
                why=case.why,
                passed=not failures,
                failures=failures,
                status=response.status,
            )
        )
    return ConformanceReport(results=tuple(results), base_url=base_url, corpus=active.identity())


def _build_url(base_url: str, mount: str, request: ConformanceRequest) -> str:
    """Join the base URL, the runtime mount prefix, the case path, and the query string.

    Reserved runtime endpoints (``absolute`` requests) skip the mount prefix entirely.
    """
    use_mount = mount.strip("/") and not request.absolute
    path = f"{mount.rstrip('/')}{request.path}" if use_mount else request.path
    url = f"{base_url.rstrip('/')}{path}"
    if request.query:
        url = f"{url}?{urllib.parse.urlencode(dict(request.query))}"
    return url


def http_sender(base_url: str, *, mount: str = "", timeout: float = 10.0) -> Sender:
    """Build a sender that talks to a running mock over HTTP.

    Uses only the standard library, so the sender works inside the runtime image with no extra
    dependencies installed.

    Args:
        base_url: Root URL of the runtime (e.g. ``http://127.0.0.1:8775``).
        mount: Path prefix the runtime serves the spec under (``/{tenant}/{project}/{version}``
            when the runtime runs with the default ``--base-path version``).
        timeout: Per-request timeout in seconds.

    Returns:
        A :data:`Sender` suitable for :func:`run_corpus`.
    """

    def send(request: ConformanceRequest) -> ConformanceResponse:
        response: ConformanceResponse | None = None
        for _ in range(request.repeat):
            response = _send_once(request, base_url=base_url, mount=mount, timeout=timeout)
        assert response is not None  # repeat is validated >= 1 at load time
        return response

    return send


def _send_once(
    request: ConformanceRequest,
    *,
    base_url: str,
    mount: str,
    timeout: float,
) -> ConformanceResponse:
    """Send one request and normalize the response (HTTP error statuses included)."""
    data: bytes | None = None
    headers = dict(request.headers)
    if request.json_body is not None:
        data = json.dumps(request.json_body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")

    url = _build_url(base_url, mount, request)
    http_request = urllib.request.Request(url, data=data, method=request.method, headers=headers)
    try:
        with urllib.request.urlopen(http_request, timeout=timeout) as raw:  # noqa: S310 - fixed http(s) base URL
            return ConformanceResponse(
                status=int(raw.status),
                headers={key.lower(): value for key, value in raw.headers.items()},
                body=raw.read(),
            )
    except urllib.error.HTTPError as exc:
        return ConformanceResponse(
            status=int(exc.code),
            headers={key.lower(): value for key, value in exc.headers.items()},
            body=exc.read(),
        )


def discover_mount(base_url: str, *, timeout: float = 5.0) -> str:
    """Ask a running runtime which path prefix it serves the spec under.

    The corpus stores spec-relative paths, so the runner has to know the mount before it can send
    anything. Rather than making the caller repeat the bundle coordinates, the runtime publishes
    them on ``/ready``.

    Args:
        base_url: Root URL of the runtime.
        timeout: Request timeout in seconds.

    Returns:
        The mount prefix (``""`` when the runtime serves the spec at the root, or when ``/ready``
        does not report one — in which case the corpus runs against the root and says so by
        failing).
    """
    try:
        with urllib.request.urlopen(f"{base_url.rstrip('/')}/ready", timeout=timeout) as raw:  # noqa: S310
            document = json.loads(raw.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - an unreachable runtime is reported by the cases themselves
        return ""
    runtime = document.get("runtime") if isinstance(document, Mapping) else None
    mount = runtime.get("mount") if isinstance(runtime, Mapping) else None
    return str(mount).rstrip("/") if isinstance(mount, str) and mount != "/" else ""


def wait_for_ready(base_url: str, *, timeout: float = 30.0, interval: float = 0.1) -> bool:
    """Poll ``/ready`` until the runtime reports readiness or the timeout elapses.

    Args:
        base_url: Root URL of the runtime.
        timeout: How long to keep polling, in seconds.
        interval: Delay between polls, in seconds.

    Returns:
        True when the runtime became ready, False when the timeout elapsed.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url.rstrip('/')}/ready", timeout=interval + 2.0) as raw:  # noqa: S310
                if int(raw.status) == 200:
                    return True
        except Exception:  # noqa: BLE001 - not up yet is the normal case while polling
            pass
        time.sleep(interval)
    return False
