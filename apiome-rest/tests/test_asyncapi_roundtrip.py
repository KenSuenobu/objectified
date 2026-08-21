"""AsyncAPI emitter validate + round-trip tests — MFX-11.4 (#3877).

Exercises :mod:`app.asyncapi_roundtrip`, which closes the emit loop opened by the
AsyncAPI emitter (MFX-11.1) and its fidelity pack (MFX-11.2): emit → validate →
re-import through the matching MFI AsyncAPI parser → diff the re-imported model against
the source. The acceptance criteria proven here:

* **Valid output passes; deliberately broken output is caught** (MFX-5.1) — an emitted
  document the parser rejects is ``INVALID``; a document that validates but does not
  normalize is ``UNPARSEABLE``; a real emission is ``valid``.
* **Same-format round-trip is lossless** — a native event source round-trips to an
  *empty* entity diff (``LOSSLESS``).
* **Empirical loss corroborates the predicted loss; divergences are flagged** (MFX-2.6)
  — a cross-paradigm REST source with predicted losses round-trips to a non-empty diff
  (they agree), and a mismatch flips :attr:`RoundTripReport.diverges`.
* **A 2.6 emission round-trips through the same path** (FMT-3.2) — the downgrade target
  is measured, not asserted: a 2.x source emitted back to AsyncAPI 2.6 re-imports to an
  empty diff, which is the "round-trip 2.6 → canonical → 2.6 preserves channels,
  operations, messages and bindings" criterion.

Because the authoritative ``@asyncapi/parser`` is a Node subprocess, the orchestration is
tested two ways: with a fake toolchain runner replaying the parser's JSON contract (always
runs — no Node needed), and, when the bundled parser is actually installed, end to end
through the real parser (``TestAsyncApiParserRoundTrip``).
"""

import asyncio
import json
from dataclasses import dataclass
from typing import Any, List, Optional, Sequence

import pytest

from app.asyncapi_emitter import AsyncApiEmitOptions, AsyncApiEmitter
from app.asyncapi_normalizer import AsyncApiNormalizer
from app.asyncapi_parser import (
    ASYNCAPI_PARSER_TOOL_KEY,
    AsyncApiParseError,
    parse_asyncapi,
)
from app.asyncapi_roundtrip import (
    RoundTripReport,
    RoundTripStatus,
    round_trip_asyncapi,
)
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Server,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.diff import diff
from app.emitter import Loss, LossKind
from app.toolchain_packaging import probe_tool
from app.toolchain_runner import ToolNotAvailableError

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _event_doc() -> dict:
    """A small native-event AsyncAPI 3.0 document with an inline payload.

    Inline payloads (no ``components.schemas`` ``$ref``) make this a clean fixed point of
    ``normalize ∘ emit``: nothing the parser dereferences changes the normalized model, so
    a same-format round trip is expected to be lossless.
    """
    return {
        "asyncapi": "3.0.0",
        "info": {
            "title": "User Events",
            "version": "1.2.0",
            "description": "User lifecycle events",
        },
        "servers": {
            "prod": {
                "host": "broker.example.com",
                "pathname": "/v1",
                "protocol": "kafka",
            }
        },
        "channels": {
            "userSignedUp": {
                "address": "user/signedup",
                "messages": {
                    "UserSignedUp": {
                        "name": "UserSignedUp",
                        "contentType": "application/json",
                        "payload": {
                            "type": "object",
                            "properties": {"id": {"type": "string"}},
                        },
                    }
                },
            }
        },
        "operations": {
            "publishUserSignedUp": {
                "action": "send",
                "channel": {"$ref": "#/channels/userSignedUp"},
                "messages": [
                    {"$ref": "#/channels/userSignedUp/messages/UserSignedUp"}
                ],
            }
        },
    }


def _event_model() -> CanonicalApi:
    """The canonical model the native-event fixture normalizes to."""
    return AsyncApiNormalizer().normalize(_event_doc(), include_raw=False)


def _event_doc_2() -> dict:
    """A native-event AsyncAPI **2.6** document, messages inline (FMT-3.2).

    The 2.x shape the downgrade target emits back: channels keyed by address, each
    carrying its own ``publish``/``subscribe`` operation, its message, and its bindings.
    """
    return {
        "asyncapi": "2.6.0",
        "info": {"title": "User Events", "version": "1.2.0"},
        "servers": {
            "prod": {"url": "mqtt://broker.example.com", "protocol": "mqtt"}
        },
        "channels": {
            "user/signedup": {
                "description": "Signup stream.",
                "bindings": {"mqtt": {"qos": 1}},
                "publish": {
                    "operationId": "onUserSignedUp",
                    "message": {
                        "name": "UserSignedUp",
                        "contentType": "application/json",
                        "payload": {
                            "type": "object",
                            "properties": {"id": {"type": "string"}},
                        },
                    },
                },
            }
        },
    }


def _event_model_2() -> CanonicalApi:
    """The canonical model the AsyncAPI 2.6 fixture normalizes to."""
    return AsyncApiNormalizer().normalize(_event_doc_2(), include_raw=False)


def _opts_2() -> AsyncApiEmitOptions:
    """Emit options selecting the FMT-3.2 AsyncAPI 2.6 downgrade target."""
    return AsyncApiEmitOptions(asyncapi_version="2.6")


def _rest_model() -> CanonicalApi:
    """A canonical model as an OpenAPI/REST normalizer would produce.

    AsyncAPI has no faithful REST-operation vocabulary, so its emission reframes each
    request/response operation as a send/reply exchange and records the dropped HTTP
    semantics as losses — a cross-paradigm source whose round trip is expected to be lossy.
    """
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Pet Store"),
        version="1.0.0",
        title="Pet Store",
        servers=[Server(url="https://api.example.com/v1", description="prod")],
        services=[
            Service(
                key="pets",
                name="pets",
                operations=[
                    Operation(
                        key="GET /pets/{id}",
                        name="getPet",
                        kind=OperationKind.REQUEST_RESPONSE,
                        http_method="GET",
                        http_path="/pets/{id}",
                        tags=["pets"],
                        messages=[
                            Message(
                                key="GET /pets/{id}#request",
                                role=MessageRole.REQUEST,
                                payload=TypeRef(name="Pet", nullable=False),
                            ),
                            Message(
                                key="GET /pets/{id}#response.200",
                                role=MessageRole.RESPONSE,
                                status_code="200",
                                payload=TypeRef(name="Pet", nullable=False),
                            ),
                        ],
                    )
                ],
            )
        ],
        types=[
            Type(
                key="Pet",
                name="Pet",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(
                        key="Pet.id",
                        name="id",
                        type=TypeRef(name="string", nullable=False),
                    )
                ],
            )
        ],
    )


# ---------------------------------------------------------------------------
# A fake toolchain runner replaying the @asyncapi/parser wrapper's JSON contract
# ---------------------------------------------------------------------------


@dataclass
class _FakeRunResult:
    """Minimal stand-in for ``ToolRunResult`` — the parser only reads ``parsed_json``."""

    parsed_json: Any


class _FakeRunner:
    """A toolchain-runner double returning a fixed payload (or raising a fixed error).

    Stands in for the Node ``@asyncapi/parser`` subprocess so the round-trip orchestration
    — emit → parse-contract → normalize → diff — is exercised with the real emitter,
    normalizer, and diff and only the subprocess faked. Records each call so a test can
    assert the document was serialized onto ``stdin`` under the right tool key.
    """

    def __init__(self, *, payload: Any = None, error: Optional[Exception] = None) -> None:
        self._payload = payload
        self._error = error
        self.calls: List[dict] = []

    async def run(
        self,
        key: str,
        args: Sequence[str] = (),
        *,
        stdin: Optional[str] = None,
        timeout: Optional[float] = None,
        **_: Any,
    ) -> _FakeRunResult:
        self.calls.append(
            {"key": key, "args": list(args), "stdin": stdin, "timeout": timeout}
        )
        if self._error is not None:
            raise self._error
        return _FakeRunResult(parsed_json=self._payload)


def _wrapper_payload(
    document: Optional[dict],
    *,
    ok: bool = True,
    version: str = "3.1.0",
    diagnostics: Optional[list] = None,
) -> dict:
    """Build a wrapper payload mirroring the real ``@asyncapi/parser`` JSON contract.

    ``document`` stands in for the parser's *dereferenced* output; the fake replays it
    verbatim (a real parser would inline every ``$ref``, which the AsyncAPI normalizer
    also tolerates via its ``$ref`` fallback, so an emitted document round-trips either way).
    """
    info = (document or {}).get("info", {}) if isinstance(document, dict) else {}
    return {
        "ok": ok,
        "asyncapiVersion": version,
        "identity": {
            "title": info.get("title"),
            "version": info.get("version"),
            "id": (document or {}).get("id") if isinstance(document, dict) else None,
        },
        "document": document,
        "diagnostics": diagnostics or [],
    }


def _run(*args: Any, **kwargs: Any) -> RoundTripReport:
    """Drive the async :func:`round_trip_asyncapi` to completion for a test."""
    return asyncio.run(round_trip_asyncapi(*args, **kwargs))


# ---------------------------------------------------------------------------
# Orchestration (fake parser — always runs, no Node toolchain required)
# ---------------------------------------------------------------------------


def test_event_source_round_trips_lossless() -> None:
    """A native event source emits, validates, re-imports, and diffs to nothing."""
    api = _event_model()
    emitted = AsyncApiEmitter().emit(api)
    runner = _FakeRunner(payload=_wrapper_payload(emitted.document))

    report = _run(api, emit_result=emitted, runner=runner)

    assert report.asyncapi_version == "3.1.0"
    assert report.validation_errors == []
    assert report.reimported is True
    assert report.import_error is None
    assert report.empirically_lossless is True
    assert report.predicted_lossless is True
    assert report.diverges is False
    assert report.valid is True
    assert report.status is RoundTripStatus.LOSSLESS


def test_round_trip_emits_internally_when_no_emit_result() -> None:
    """With no pre-computed emission the round trip emits ``api`` itself (deterministically)."""
    api = _event_model()
    # The emitter is deterministic, so the document the fake replays matches the one the
    # round trip emits internally.
    document = AsyncApiEmitter().emit(api).document
    runner = _FakeRunner(payload=_wrapper_payload(document))

    report = _run(api, runner=runner)

    assert report.status is RoundTripStatus.LOSSLESS
    assert report.reimported is True


def test_rest_source_round_trips_lossy_corroborating_prediction() -> None:
    """A REST source is valid AsyncAPI but round-trips lossy, matching its predicted losses."""
    api = _rest_model()
    emitted = AsyncApiEmitter().emit(api)
    assert emitted.losses, "the REST reframe must record predicted losses"
    runner = _FakeRunner(payload=_wrapper_payload(emitted.document))

    report = _run(api, emit_result=emitted, runner=runner)

    assert report.valid is True  # the emitted document is legal AsyncAPI
    assert report.reimported is True
    assert report.empirically_lossless is False  # reframing lost the REST semantics
    assert report.predicted_lossless is False
    # Prediction (lossy) and measurement (lossy) agree — no silent loss, no over-prediction.
    assert report.diverges is False
    assert report.status is RoundTripStatus.LOSSY
    assert report.predicted_losses == list(emitted.losses)


def test_invalid_document_is_flagged_invalid() -> None:
    """An error diagnostic from the parser makes the round trip ``INVALID`` (MFX-5.1)."""
    api = _event_model()
    emitted = AsyncApiEmitter().emit(api)
    runner = _FakeRunner(
        payload=_wrapper_payload(
            emitted.document,
            ok=False,
            diagnostics=[
                {
                    "severity": "error",
                    "code": "asyncapi-is-asyncapi",
                    "message": "document is not a valid AsyncAPI file",
                    "path": "",
                }
            ],
        )
    )

    report = _run(api, emit_result=emitted, runner=runner)

    assert report.validation_errors == [
        {
            "severity": "error",
            "code": "asyncapi-is-asyncapi",
            "message": "document is not a valid AsyncAPI file",
            "path": "",
        }
    ]
    assert report.reimported is False
    assert report.diff is None
    assert report.valid is False
    assert report.diverges is False
    assert report.status is RoundTripStatus.INVALID


def test_advisory_diagnostics_do_not_invalidate() -> None:
    """A warning-severity diagnostic is not an error, so the document stays valid."""
    api = _event_model()
    emitted = AsyncApiEmitter().emit(api)
    runner = _FakeRunner(
        payload=_wrapper_payload(
            emitted.document,
            diagnostics=[
                {
                    "severity": "warning",
                    "code": "asyncapi-operation-description",
                    "message": "operation should have a description",
                    "path": "operations/publishUserSignedUp",
                }
            ],
        )
    )

    report = _run(api, emit_result=emitted, runner=runner)

    assert report.validation_errors == []
    assert report.valid is True
    assert report.status is RoundTripStatus.LOSSLESS


def test_valid_but_unnormalizable_document_is_unparseable() -> None:
    """A document the parser accepts but the normalizer rejects is ``UNPARSEABLE``."""
    api = _event_model()
    emitted = AsyncApiEmitter().emit(api)
    # A payload the wrapper reports ``ok`` for, but whose document has no ``asyncapi``
    # version marker — the normalizer raises ``ValueError`` mapping it.
    runner = _FakeRunner(
        payload=_wrapper_payload({"info": {"title": "No Version"}}, version="")
    )

    report = _run(api, emit_result=emitted, runner=runner)

    assert report.validation_errors == []
    assert report.reimported is False
    assert report.import_error is not None
    assert report.diff is None
    assert report.valid is False
    assert report.status is RoundTripStatus.UNPARSEABLE


def test_parser_receives_serialized_document_on_stdin() -> None:
    """The round trip re-parses the *serialized* emitted document, forwarding the timeout."""
    api = _event_model()
    emitted = AsyncApiEmitter().emit(api)
    runner = _FakeRunner(payload=_wrapper_payload(emitted.document))

    _run(api, emit_result=emitted, runner=runner, timeout=9.0)

    assert len(runner.calls) == 1
    call = runner.calls[0]
    assert call["key"] == ASYNCAPI_PARSER_TOOL_KEY
    assert call["stdin"] == json.dumps(emitted.document)
    assert call["timeout"] == 9.0


def test_missing_parser_tool_raises_infrastructure_error() -> None:
    """An unavailable parser tool is an infrastructure failure, not a document verdict."""
    api = _event_model()
    runner = _FakeRunner(
        error=ToolNotAvailableError(ASYNCAPI_PARSER_TOOL_KEY, "asyncapi-parser")
    )

    with pytest.raises(AsyncApiParseError):
        _run(api, runner=runner)


def test_asyncapi_2_target_round_trips_lossless() -> None:
    # FMT-3.2: a 2.x source emitted back to 2.6 re-imports entity-for-entity.
    api = _event_model_2()
    emitted = AsyncApiEmitter().emit(api, opts=_opts_2())
    runner = _FakeRunner(payload=_wrapper_payload(emitted.document, version="2.6.0"))

    report = _run(api, emit_result=emitted, runner=runner)

    assert report.asyncapi_version == "2.6.0"
    assert report.status is RoundTripStatus.LOSSLESS
    assert report.predicted_losses == []
    assert report.diverges is False


def test_asyncapi_2_target_is_selected_through_the_emit_options() -> None:
    # The round trip emits internally when handed no result, so the option has to
    # reach the emitter through ``opts``.
    api = _event_model_2()
    document = AsyncApiEmitter().emit(api, opts=_opts_2()).document
    runner = _FakeRunner(payload=_wrapper_payload(document, version="2.6.0"))

    report = _run(api, opts=_opts_2(), runner=runner)

    assert report.asyncapi_version == "2.6.0"
    assert report.valid is True


def test_report_is_deterministic() -> None:
    """Two round trips of the same input produce equal reports (pure + deterministic)."""
    api = _rest_model()
    emitted = AsyncApiEmitter().emit(api)
    payload = _wrapper_payload(emitted.document)

    first = _run(api, emit_result=emitted, runner=_FakeRunner(payload=payload))
    second = _run(api, emit_result=emitted, runner=_FakeRunner(payload=payload))

    assert first == second


# ---------------------------------------------------------------------------
# RoundTripReport derived-verdict logic (pure — no runner)
# ---------------------------------------------------------------------------


class TestRoundTripReportDerivations:
    """The status / valid / diverges derivations across every branch."""

    @staticmethod
    def _empty_diff():
        model = _event_model()
        return diff(model, model)

    @staticmethod
    def _nonempty_diff():
        d = diff(_event_model(), _rest_model())
        assert not d.is_empty()
        return d

    @staticmethod
    def _loss() -> Loss:
        return Loss(
            kind=LossKind.NA,
            subject="http-status",
            detail="response status '200' has no AsyncAPI representation",
            pointer="GET /pets/{id}#response.200",
        )

    def test_lossless(self) -> None:
        report = RoundTripReport(
            asyncapi_version="3.1.0",
            reimported=True,
            diff=self._empty_diff(),
        )
        assert report.valid is True
        assert report.empirically_lossless is True
        assert report.predicted_lossless is True
        assert report.diverges is False
        assert report.status is RoundTripStatus.LOSSLESS

    def test_lossy_corroborated(self) -> None:
        report = RoundTripReport(
            asyncapi_version="3.1.0",
            reimported=True,
            diff=self._nonempty_diff(),
            predicted_losses=[self._loss()],
        )
        assert report.valid is True
        assert report.diverges is False
        assert report.status is RoundTripStatus.LOSSY

    def test_diverges_on_silent_loss(self) -> None:
        # Predicted lossless, yet the measured diff is non-empty — an unpredicted loss.
        report = RoundTripReport(
            asyncapi_version="3.1.0",
            reimported=True,
            diff=self._nonempty_diff(),
        )
        assert report.predicted_lossless is True
        assert report.empirically_lossless is False
        assert report.diverges is True
        assert report.status is RoundTripStatus.LOSSY

    def test_diverges_on_over_prediction(self) -> None:
        # Predicted lossy, yet the measured diff is empty — an over-prediction.
        report = RoundTripReport(
            asyncapi_version="3.1.0",
            reimported=True,
            diff=self._empty_diff(),
            predicted_losses=[self._loss()],
        )
        assert report.empirically_lossless is True
        assert report.predicted_lossless is False
        assert report.diverges is True
        assert report.status is RoundTripStatus.LOSSLESS

    def test_invalid_has_no_divergence(self) -> None:
        report = RoundTripReport(
            asyncapi_version="3.1.0",
            reimported=False,
            validation_errors=[{"severity": "error", "code": "x", "message": "m", "path": ""}],
            predicted_losses=[self._loss()],
        )
        assert report.valid is False
        assert report.diverges is False  # no measurement to compare against
        assert report.status is RoundTripStatus.INVALID

    def test_unparseable_has_no_divergence(self) -> None:
        report = RoundTripReport(
            asyncapi_version="3.1.0",
            reimported=False,
            import_error="not an AsyncAPI 2.x/3.x document",
        )
        assert report.valid is False
        assert report.diverges is False
        assert report.status is RoundTripStatus.UNPARSEABLE


# ---------------------------------------------------------------------------
# Integration: round-trip through the real @asyncapi/parser (needs Node)
# ---------------------------------------------------------------------------

_PARSER_AVAILABLE = bool(
    getattr(probe_tool(ASYNCAPI_PARSER_TOOL_KEY), "available", False)
)


@pytest.mark.skipif(
    not _PARSER_AVAILABLE,
    reason="the bundled @asyncapi/parser toolchain is not installed in this runtime",
)
class TestAsyncApiParserRoundTrip:
    """End-to-end round trips validated + dereferenced by the authoritative parser.

    The acceptance-criterion checks exercised with the real ``@asyncapi/parser``: a native
    event source round-trips lossless, and a REST source is legal AsyncAPI yet round-trips
    lossy with its reframing losses corroborated.
    """

    def test_event_source_round_trips_lossless(self) -> None:
        api = _event_model()
        report = asyncio.run(round_trip_asyncapi(api))
        assert report.validation_errors == []
        assert report.status is RoundTripStatus.LOSSLESS
        assert report.valid is True
        assert report.diverges is False

    def test_rest_source_round_trips_lossy(self) -> None:
        api = _rest_model()
        report = asyncio.run(round_trip_asyncapi(api))
        assert report.valid is True
        assert report.status is RoundTripStatus.LOSSY
        assert report.predicted_losses
        assert report.diverges is False

    def test_asyncapi_2_source_round_trips_lossless(self) -> None:
        # FMT-3.2 end to end: emitted 2.6, validated by the authoritative parser, and
        # re-imported to an empty diff.
        api = _event_model_2()
        report = asyncio.run(round_trip_asyncapi(api, opts=_opts_2()))
        assert report.validation_errors == []
        assert report.asyncapi_version == "2.6.0"
        assert report.status is RoundTripStatus.LOSSLESS
        assert report.diverges is False

    def test_asyncapi_2_rest_source_validates_and_is_lossy(self) -> None:
        report = asyncio.run(round_trip_asyncapi(_rest_model(), opts=_opts_2()))
        assert report.valid is True
        assert report.status is RoundTripStatus.LOSSY
        assert any(
            loss.subject == "asyncapi2-operation-reply"
            for loss in report.predicted_losses
        )

    def test_reparse_matches_a_direct_parse(self) -> None:
        # The document the round trip re-parses is exactly the serialized emission.
        api = _event_model()
        emitted = AsyncApiEmitter().emit(api)
        direct = asyncio.run(parse_asyncapi(json.dumps(emitted.document)))
        assert direct.ok, [d.message for d in direct.errors]
        report = asyncio.run(round_trip_asyncapi(api, emit_result=emitted))
        assert report.status is RoundTripStatus.LOSSLESS
