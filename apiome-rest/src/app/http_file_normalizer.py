"""HTTP request-file → canonical model normalizer (IXH-7.4).

Thin wrapper: a parsed :class:`~app.http_file_parser.HttpFileDocument` is handed to
the shared inferred-spec engine so path templating, param union, and schema
widening stay format-agnostic (align with MFI-EPIC-32 — do not fork).
"""

from __future__ import annotations

from typing import Any

from .canonical_model import ApiParadigm, CanonicalApi
from .http_file_parser import HttpFileDocument
from .inferred_spec import infer_canonical_api
from .normalizer import Normalizer

__all__ = ["HttpFileNormalizer"]

_FORMAT_KEY = "http-file"


class HttpFileNormalizer(Normalizer, register=True):
    """Normalize a parsed HTTP request file via the shared inferred-spec engine."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.REST

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(source, HttpFileDocument):
            raise ValueError(
                "HTTP-file source must be an HttpFileDocument "
                "(see app.http_file_parser.parse_http_file)"
            )
        result = infer_canonical_api(
            source.observations,
            title=source.title or "HTTP requests",
            format_key=_FORMAT_KEY,
            include_raw=include_raw,
        )
        api = result.api
        if source.variables:
            api.extras = {
                **api.extras,
                "http_file_variables": [
                    {"key": key, "value": value}
                    for key, value in sorted(source.variables.items())
                ],
            }
        if include_raw and source.raw is not None:
            raw = dict(api.raw or {})
            raw["http_file"] = source.raw
            api.raw = raw
        return api
