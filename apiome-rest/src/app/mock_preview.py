"""Dry-run mock preview: the control-plane half of "what does this mock return?" (#5528, MSC-1.2).

Mock templates are validated when they are saved, so a stored scenario or correlation block is
guaranteed well-formed. That answers the wrong question. The one an author has is *what comes
back* — and answering it used to mean enabling a mock, sending a real request to the data plane
with the right headers, and reading the result.

The rendering itself is deliberately **not** here. The mock engine lives in apiome-mock, which
depends on this package; re-implementing the serving sequence in REST would create a second
resolver free to disagree with the one that actually serves traffic, which is the failure mode a
preview exists to prevent. So this module owns the control-plane half only:

* :func:`effective_mock_settings` — overlay an unsaved draft on the version's stored settings, so
  an editor can preview a change it has not committed.
* :func:`validate_draft_settings` — run the *same* author-time validators the save routes run, so
  a draft that could never be saved is a 422 here rather than a silently ignored no-op there.
* :func:`request_mock_preview` — build nothing and decide nothing; hand the version's portable
  mock bundle to apiome-mock's internal ``/__preview__`` endpoint and return what it says.

The bundle is the unit that crosses the hop because it is already the self-contained document the
portable runtime serves: it embeds the generated spec plus the allowlisted, credential-redacted
settings keys and carries content digests the far side verifies. A preview therefore renders the
same configuration a downloaded bundle would, with no second projection to keep in step.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping, Optional

import httpx

from .config import settings
from .mock_callbacks import callbacks_to_storage, validate_mock_callbacks
from .mock_correlation import correlation_to_storage, validate_mock_correlation
from .mock_fixture_packs import fixture_packs_to_storage, validate_fixture_packs
from .mock_scenario_settings import (
    chaos_to_storage,
    scenarios_to_storage,
    validate_mock_chaos,
    validate_mock_scenarios,
)
from .mock_settings_util import parse_mock_settings
from .models import MockPreviewSettingsSpec

logger = logging.getLogger(__name__)

__all__ = [
    "FORWARDED_PREVIEW_STATUSES",
    "INTERNAL_TOKEN_HEADER",
    "NOT_CONFIGURED_DETAIL",
    "PREVIEW_PATH",
    "MockPreviewError",
    "MockPreviewRejected",
    "MockPreviewUnavailable",
    "draft_to_storage",
    "effective_mock_settings",
    "preview_is_configured",
    "request_mock_preview",
    "validate_draft_settings",
]

#: Path of apiome-mock's internal preview endpoint.
PREVIEW_PATH = "/__preview__"

#: Header carrying the shared internal token, matching the convention established by
#: ``/v1/internal/auth-providers/resolved`` (OLO-8.5).
INTERNAL_TOKEN_HEADER = "X-Internal-Service-Token"

#: Statuses from the mock runtime that describe something about the *caller's* payload, and are
#: therefore safe and useful to pass straight through. Everything else the runtime returns (a
#: rejected service token, an internal fault) is a deployment problem the caller cannot act on and
#: must not be shown, so it becomes a plain 502.
FORWARDED_PREVIEW_STATUSES = frozenset({413, 422})

#: The one wording for "this deployment cannot render previews", shared by the route's early guard
#: and the transport's own check so the two can never say different things.
NOT_CONFIGURED_DETAIL = (
    "Mock preview is not configured on this deployment: set APIOME_MOCK_INTERNAL_BASE_URL "
    "and APIOME_MOCK_INTERNAL_TOKEN."
)


class MockPreviewError(RuntimeError):
    """The preview could not be rendered because the mock runtime could not be reached."""


class MockPreviewUnavailable(MockPreviewError):
    """Preview is not configured on this deployment (no internal URL or token)."""


class MockPreviewRejected(MockPreviewError):
    """The mock runtime refused the request; ``detail`` carries its structured explanation.

    Attributes:
        status_code: The status the mock runtime returned.
        detail: Its structured error detail, forwarded to the caller unchanged.
    """

    def __init__(self, status_code: int, detail: Any) -> None:
        super().__init__(f"Mock preview rejected the request ({status_code}).")
        self.status_code = status_code
        self.detail = detail


def preview_is_configured() -> bool:
    """Whether this deployment can render previews at all.

    Returns:
        ``True`` when both the internal mock URL and the shared token are configured. Both halves
        are required: without them the endpoint would either have nowhere to go or would reach an
        endpoint that (correctly) refuses to render for an unauthenticated caller.
    """
    return bool((settings.mock_internal_base_url or "").strip() and (settings.mock_internal_token or "").strip())


def draft_to_storage(draft: MockPreviewSettingsSpec) -> Dict[str, Any]:
    """Project a draft onto the ``versions.mock_settings`` keys it would be saved under.

    Only the fields the caller actually sent appear — ``model_fields_set`` distinguishes "omitted"
    from "sent as null", which is the difference between keeping a stored key and clearing it.

    Each value goes through the *same* canonicalizer its save route uses, so a draft renders
    exactly as it would once saved: operation keys normalize the same way, defaults fill in the
    same way, and a preview of a draft is a promise about the version it would become rather than
    about the JSON that happened to be typed.

    Args:
        draft: The caller's unsaved override.

    Returns:
        A map of ``mock_settings`` key to its canonical draft value; ``None`` means "clear it".
    """
    projection: Dict[str, Any] = {}
    declared = draft.model_fields_set
    if "scenarios" in declared:
        projection["scenarios"] = None if draft.scenarios is None else scenarios_to_storage(draft.scenarios)
    if "chaos" in declared:
        projection["chaos"] = None if draft.chaos is None else chaos_to_storage(draft.chaos)
    if "fixture_packs" in declared:
        projection["fixturePacks"] = (
            None
            if draft.fixture_packs is None
            else fixture_packs_to_storage(
                {name: pack.model_dump(by_alias=True, exclude_none=True) for name, pack in draft.fixture_packs.items()}
            )
        )
    if "callbacks" in declared:
        projection["callbacks"] = (
            None
            if draft.callbacks is None
            else callbacks_to_storage(
                {
                    name: callback.model_dump(by_alias=True, exclude_none=True)
                    for name, callback in draft.callbacks.items()
                }
            )
        )
    if "correlation" in declared:
        projection["responseCorrelation"] = (
            None if draft.correlation is None else correlation_to_storage(draft.correlation)
        )
    return projection


def effective_mock_settings(stored: Any, draft: Optional[MockPreviewSettingsSpec]) -> Dict[str, Any]:
    """Overlay an unsaved draft on the version's stored ``mock_settings``.

    The overlay is per top-level key, not a deep merge: a key the draft declares replaces the
    stored one outright, and a key it omits keeps the stored value. That is what an editor needs —
    previewing a reworked correlation block should not require resending every scenario — while
    keeping "what am I previewing?" answerable by looking at one key at a time.

    Nothing is written. The result is a value in memory used to build one bundle.

    Args:
        stored: The raw ``versions.mock_settings`` value.
        draft: The caller's unsaved override, or ``None`` to preview the stored settings.

    Returns:
        The merged settings mapping to build the preview bundle from.
    """
    merged = dict(parse_mock_settings(stored))
    if draft is None:
        return merged
    for key, value in draft_to_storage(draft).items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


def validate_draft_settings(
    draft: Optional[MockPreviewSettingsSpec],
    spec: Mapping[str, Any],
) -> List[str]:
    """Validate an unsaved draft with the same rules its save route would apply.

    A draft that would be rejected on save must be rejected here too. The alternative — letting it
    through — hands the author a preview rendered by the runtime's *lenient* parser, which drops
    what it cannot read: they would see a correlation block quietly doing nothing and have no way
    to tell that from a block that legitimately bound nothing.

    Args:
        draft: The caller's unsaved override; ``None`` is valid and returns no errors.
        spec: The version's generated OpenAPI document, which operation keys must exist in.

    Returns:
        Human-readable error strings, empty when the draft is valid.
    """
    if draft is None:
        return []

    errors: List[str] = []
    if draft.scenarios is not None:
        errors.extend(validate_mock_scenarios(draft.scenarios, spec))
    if draft.chaos is not None:
        errors.extend(validate_mock_chaos(draft.chaos, spec))
    if draft.fixture_packs is not None:
        errors.extend(
            validate_fixture_packs(
                {name: pack.model_dump(by_alias=True, exclude_none=True) for name, pack in draft.fixture_packs.items()}
            )
        )
    if draft.callbacks is not None:
        errors.extend(
            validate_mock_callbacks(
                {
                    name: callback.model_dump(by_alias=True, exclude_none=True)
                    for name, callback in draft.callbacks.items()
                },
                spec,
            )
        )
    if draft.correlation is not None:
        errors.extend(validate_mock_correlation(draft.correlation, spec))
    return errors


async def request_mock_preview(
    *,
    bundle: Mapping[str, Any],
    request: Mapping[str, Any],
) -> Dict[str, Any]:
    """Ask the mock runtime to render one synthetic request against a bundle.

    Args:
        bundle: The version's portable mock bundle document.
        request: The synthetic request (``method``/``path``/``headers``/``query``/``body``/
            ``scenario``/``seed``).

    Returns:
        The runtime's preview result: matched operation, status, headers, media type, body, the
        decision trace, and the chaos report.

    Raises:
        MockPreviewUnavailable: Preview is not configured on this deployment.
        MockPreviewRejected: The runtime refused the request (bad bundle, bad token, limits).
        MockPreviewError: The runtime could not be reached or answered unintelligibly.
    """
    if not preview_is_configured():
        raise MockPreviewUnavailable(NOT_CONFIGURED_DETAIL)

    url = settings.mock_internal_base_url.rstrip("/") + PREVIEW_PATH
    try:
        async with httpx.AsyncClient(timeout=settings.mock_preview_timeout_seconds) as client:
            response = await client.post(
                url,
                json={"bundle": dict(bundle), "request": dict(request)},
                headers={INTERNAL_TOKEN_HEADER: str(settings.mock_internal_token)},
            )
    except httpx.HTTPError as exc:
        logger.warning("Mock preview transport failure: %s", exc)
        raise MockPreviewError(f"The mock runtime could not be reached: {exc}") from exc

    if response.status_code >= 400:
        try:
            detail = response.json().get("detail")
        except ValueError:
            detail = response.text[:500]
        raise MockPreviewRejected(response.status_code, detail)

    try:
        payload = response.json()
    except ValueError as exc:
        raise MockPreviewError("The mock runtime returned a response that is not JSON.") from exc
    if not isinstance(payload, dict):
        raise MockPreviewError("The mock runtime returned an unexpected preview shape.")
    return payload
