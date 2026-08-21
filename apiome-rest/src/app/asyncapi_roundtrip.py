"""AsyncAPI emitter validate + round-trip — MFX-11.4 (#3877).

The AsyncAPI emitter (:class:`app.asyncapi_emitter.AsyncApiEmitter`, MFX-11.1) converts
a :class:`~app.canonical_model.CanonicalApi` *out* to an AsyncAPI 3.1 document, and the
fidelity pack (:class:`~app.asyncapi_emitter.AsyncApiFidelityRulePack`, MFX-11.2)
*predicts* what that projection cannot carry — a REST/RPC operation reframed as a
send/reply message exchange, its HTTP method/path/status dropped. This module closes the
loop by **measuring** what actually survived: it feeds the emitted artifact back through
the matching MFI AsyncAPI parser and diffs the re-imported model against the source, the
AsyncAPI analogue of :mod:`app.openapi_roundtrip` (MFX-9.3).

It composes three pieces that already exist rather than reimplementing any of them
(the MFX-5.1 / MFX-2.6 directive — *reuse, don't rebuild*):

* **emit** — :class:`app.asyncapi_emitter.AsyncApiEmitter` (MFX-11.1);
* **validate + re-import** — :func:`app.asyncapi_parser.parse_asyncapi` (MFI-8.1) runs the
  authoritative ``@asyncapi/parser``, which both *validates* the emitted document against
  the AsyncAPI spec (plus the ``spectral:asyncapi`` ruleset) and *dereferences* it into
  canonical JSON; the dereferenced document is then mapped back to a canonical model by
  :class:`app.asyncapi_normalizer.AsyncApiNormalizer` (MFI-8.2). Unlike OpenAPI — whose
  MFX-9.3 round trip validates against a bundled Python meta-schema — AsyncAPI has no
  in-process validator: the Node parser *is* the validator, so a real parse both proves
  the artifact is legal AsyncAPI (the MFX-5.1 "validate emitted artifact" check) and
  yields the model to diff. This is the exact re-import path a user re-importing the file
  through the AsyncAPI source card would hit (:class:`app.asyncapi_import_source.AsyncApiImportSource`),
  composed directly here because it is ``async`` (the parser drives a Node subprocess);
* **round-trip diff** — :func:`app.diff.diff` (MFI-3.2) compares the re-imported model
  against the source, yielding the *empirical* loss list that corroborates the
  *predicted* one (the MFX-2.6 round-trip measurement).

Every piece is version-agnostic, so the FMT-3.2 **2.6 downgrade target** round-trips
through the same three steps unchanged: the parser validates 2.x and 3.x alike, and the
normalizer reads both. That is what lets the "2.6 → canonical → 2.6 preserves channels,
operations, messages and bindings" criterion be *measured* rather than asserted — a 2.x
source emitted back to 2.6 is expected to re-import to an empty diff.

The core statement is the **same-format round-trip is lossless**: a native event source
emitted to AsyncAPI 3.1 and re-imported produces an *empty* entity diff (the fixed-point
property MFX-11.1 already proves for ``normalize ∘ emit``, here proven end to end through
the real parser). When the emitter recorded losses (a cross-paradigm REST/RPC source whose
operations AsyncAPI can only reframe), the round-trip diff is expected to be non-empty —
and :attr:`RoundTripReport.diverges` flags the cases where prediction and measurement
disagree (predicted lossless yet the diff is non-empty, or vice versa), the MFX-2.6
"flagged where they diverge" acceptance criterion.

Because the authoritative parse is a Node subprocess, :func:`round_trip_asyncapi` is
``async`` (mirroring :func:`app.asyncapi_lint.lint_asyncapi`) and raises
:class:`app.asyncapi_parser.AsyncApiParseError` for *infrastructure* failures only — the
bundled parser tool being unavailable in this runtime, or timing out. A merely *invalid*
emitted document does not raise: it comes back as :attr:`RoundTripStatus.INVALID` with the
error diagnostics attached. Everything else is pure, so the emitter's tests, the export
job (MFX-EPIC-3), and the CLI/UI target card (MFX-11.5) can share one round-trip
implementation.
"""

from __future__ import annotations

import json
from enum import Enum
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

from .asyncapi_emitter import AsyncApiEmitOptions, AsyncApiEmitter
from .asyncapi_normalizer import AsyncApiNormalizer
from .asyncapi_parser import AsyncApiDiagnostic, parse_asyncapi
from .canonical_model import CanonicalApi
from .diff import ModelDiff, diff
from .emitter import EmitOptions, EmitResult, Loss

__all__ = [
    "RoundTripStatus",
    "RoundTripReport",
    "round_trip_asyncapi",
]


class RoundTripStatus(str, Enum):
    """The outcome of an emit → validate → re-import → diff round trip.

    A single ordered verdict callers can gate on, from worst to best:

    * :attr:`INVALID` — the emitted document failed AsyncAPI validation (the
      ``@asyncapi/parser`` reported at least one error diagnostic); the emitter produced
      structurally illegal output.
    * :attr:`UNPARSEABLE` — the document validated but the AsyncAPI normalizer could not
      map it back into a canonical model; the artifact is not legal input for its own
      re-import path.
    * :attr:`LOSSY` — the artifact re-imported cleanly, but the re-imported model differs
      from the source (the round-trip lost or altered constructs).
    * :attr:`LOSSLESS` — the artifact re-imported cleanly and the re-imported model is
      entity-for-entity identical to the source (a perfect round trip).
    """

    INVALID = "invalid"
    UNPARSEABLE = "unparseable"
    LOSSY = "lossy"
    LOSSLESS = "lossless"


class RoundTripReport(BaseModel):
    """The result of round-tripping an emitted AsyncAPI artifact back to canonical.

    Deterministic for a given source model and emit options, so two round trips of the
    same input compare equal. Combines the MFX-5.1 validation verdict
    (:attr:`validation_errors` + :attr:`reimported`) with the MFX-2.6 empirical loss
    measurement (:attr:`diff`) and the emitter's *predicted* losses
    (:attr:`predicted_losses`) so a caller can confirm the two agree.
    """

    model_config = ConfigDict(extra="forbid")

    asyncapi_version: str = Field(
        description="The declared ``asyncapi`` version of the emitted document — "
        "``3.1.0`` for the emitter's native target, or ``2.6.0`` when the "
        "``asyncapi_version`` option asked for the 2.x downgrade (FMT-3.2).",
    )
    validation_errors: List[Dict[str, str]] = Field(
        default_factory=list,
        description="The error-severity ``@asyncapi/parser`` diagnostics "
        "(severity/code/message/path) that render the emitted document invalid AsyncAPI. "
        "Empty when the document validated cleanly.",
    )
    reimported: bool = Field(
        description="Whether the emitted artifact parsed, dereferenced, and normalized "
        "back into a canonical model through the matching MFI AsyncAPI import path.",
    )
    import_error: Optional[str] = Field(
        default=None,
        description="The normalizer's failure message when ``reimported`` is false "
        "despite a valid document; ``None`` on a successful re-import.",
    )
    diff: Optional[ModelDiff] = Field(
        default=None,
        description="The structured diff from the source model to the re-imported model. "
        "``None`` when re-import failed (there is nothing to diff against).",
    )
    predicted_losses: List[Loss] = Field(
        default_factory=list,
        description="The losses the emitter recorded while projecting the source to "
        "AsyncAPI (MFI-22.2). Empty when the emitter predicted a lossless conversion.",
    )

    @property
    def valid(self) -> bool:
        """Whether the emitted artifact is legal: validation-clean *and* re-importable.

        The MFX-5.1 acceptance criterion — "valid output passes; deliberately broken
        output is caught". A document can validate against the spec yet still trip the
        normalizer, so both checks must hold.
        """
        return not self.validation_errors and self.reimported

    @property
    def empirically_lossless(self) -> bool:
        """Whether the *measured* round trip preserved every itemized entity.

        ``True`` when the artifact re-imported and the source→re-import diff records no
        service/operation/message/channel/type/field change. This is the entity-level
        round-trip guarantee; artifact-level metadata (``version`` / ``servers`` /
        ``identity``) is deliberately outside the diff's categories and does not count as
        a round-trip loss.
        """
        return self.diff is not None and self.diff.is_empty()

    @property
    def predicted_lossless(self) -> bool:
        """Whether the emitter *predicted* a lossless conversion (no recorded losses)."""
        return not self.predicted_losses

    @property
    def diverges(self) -> bool:
        """Whether prediction and measurement disagree (the MFX-2.6 divergence flag).

        For a re-importable artifact, prediction and measurement should agree: a
        predicted-lossless conversion round-trips with an empty diff, and a predicted loss
        shows up as a non-empty diff. ``True`` flags the mismatch — a silent loss
        (predicted lossless, yet the diff is non-empty) or an over-prediction (predicted
        lossy, yet the diff is empty) — so a fixture can assert the two corroborate. Always
        ``False`` when the artifact did not re-import (there is no measurement to compare
        against).
        """
        if self.diff is None:
            return False
        return self.empirically_lossless != self.predicted_lossless

    @property
    def status(self) -> RoundTripStatus:
        """The single ordered verdict for the round trip (see :class:`RoundTripStatus`)."""
        if self.validation_errors:
            return RoundTripStatus.INVALID
        if not self.reimported:
            return RoundTripStatus.UNPARSEABLE
        if self.empirically_lossless:
            return RoundTripStatus.LOSSLESS
        return RoundTripStatus.LOSSY


def _diagnostic_dict(diagnostic: AsyncApiDiagnostic) -> Dict[str, str]:
    """Flatten one parser diagnostic into a serializable ``severity/code/message/path`` dict."""
    return {
        "severity": diagnostic.severity,
        "code": diagnostic.code,
        "message": diagnostic.message,
        "path": diagnostic.path,
    }


def _document_version(document: Dict[str, Any]) -> str:
    """Return the declared ``asyncapi`` version string of an emitted document (``""`` if absent)."""
    version = document.get("asyncapi")
    return version if isinstance(version, str) else ""


async def round_trip_asyncapi(
    api: CanonicalApi,
    *,
    opts: Optional[Union[AsyncApiEmitOptions, EmitOptions]] = None,
    emit_result: Optional[EmitResult] = None,
    runner: Optional[Any] = None,
    timeout: Optional[float] = None,
) -> RoundTripReport:
    """Validate and round-trip the AsyncAPI emission of ``api``.

    Emits ``api`` to AsyncAPI (unless a pre-computed ``emit_result`` is supplied),
    validates *and* dereferences the emitted document through the authoritative
    ``@asyncapi/parser`` (MFI-8.1), re-imports the dereferenced document through the
    AsyncAPI normalizer (MFI-8.2), and diffs the re-imported model against ``api``. The
    returned :class:`RoundTripReport` carries the validation verdict, the empirical diff,
    and the emitter's predicted losses so a caller can confirm the measured loss matches
    the predicted one.

    Args:
        api: The source canonical model to emit and round-trip.
        opts: Optional emit options. Ignored when ``emit_result`` is supplied.
        emit_result: A pre-computed emission to round-trip instead of emitting here — lets
            a caller that already emitted (the export job) avoid emitting twice. When
            supplied, ``opts`` is not consulted.
        runner: Optional :class:`~app.toolchain_runner.ToolchainRunner` override forwarded
            to the parser (injectable for tests); defaults to the shared runner.
        timeout: Optional per-call parse timeout in seconds.

    Returns:
        A :class:`RoundTripReport`. When the emitted document fails validation,
        :attr:`RoundTripReport.validation_errors` is non-empty and the status is
        :attr:`RoundTripStatus.INVALID`; when it validates but does not normalize,
        :attr:`RoundTripReport.import_error` carries the reason.

    Raises:
        app.asyncapi_parser.AsyncApiParseError: For *infrastructure* failures only — the
            bundled ``@asyncapi/parser`` tool is unavailable in this runtime or timed out.
            A merely-invalid emitted document does **not** raise (it is ``INVALID``).
    """
    if emit_result is None:
        emit_result = AsyncApiEmitter().emit(api, opts=opts)

    document = emit_result.document

    # Re-import through the real MFI parser via the serialized wire format, so the round
    # trip exercises exactly the path a user re-importing the file would hit (and catches
    # any non-JSON-serializable content the emitter should never emit). The parser both
    # validates the document and dereferences it into the canonical JSON the normalizer
    # consumes — an invalid document comes back as diagnostics, not an exception.
    parse_result = await parse_asyncapi(
        json.dumps(document), runner=runner, timeout=timeout
    )
    validation_errors = [_diagnostic_dict(d) for d in parse_result.errors]

    reimported_model: Optional[CanonicalApi] = None
    import_error: Optional[str] = None
    if parse_result.ok and parse_result.document is not None:
        try:
            reimported_model = AsyncApiNormalizer().normalize(
                parse_result.document, include_raw=False
            )
        except (ValueError, KeyError, TypeError) as exc:
            import_error = str(exc)

    round_trip_diff = (
        diff(api, reimported_model) if reimported_model is not None else None
    )

    return RoundTripReport(
        asyncapi_version=_document_version(document),
        validation_errors=validation_errors,
        reimported=reimported_model is not None,
        import_error=import_error,
        diff=round_trip_diff,
        predicted_losses=list(emit_result.losses),
    )
