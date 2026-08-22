"""Postman import source.

The :class:`~app.import_source.ImportSource` adapter that makes Postman Collection
v2.0 and v2.1 documents importable into the catalog (store-raw).

FMT-3.6 (#5431) added the v2.0 half. Both minors resolve to the same parser and the
same normalizer — the divergences between them are read in
:mod:`app.postman_parser` — so the only version-aware things here are the detection
key (``postman-2.0`` when the schema URL states that minor, so the routing UI can
say which version it saw) and the ``postman-2.0`` entry in :attr:`formats`, which
is what the capability registry serves as this format's declared version coverage.

A fileset is a collection plus its **environment** files: their ``{{variable}}``
values are merged under the collection's own, which is the only thing that makes a
Postman multi-file set more than its root.
"""

from __future__ import annotations

from typing import Any, List, Optional

from . import postman_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)
from .postman_parser import (
    PostmanDocument,
    PostmanParseError,
    PostmanVariable,
    collection_version,
    is_postman,
    is_postman_document,
    parse_environment,
    parse_postman,
)

__all__ = ["PostmanImportSource"]

#: Collection minor → the detection format key that names it. Only v2.0 gets a
#: version-scoped key: v2.1 keeps the bare ``postman`` key it has always reported,
#: so no existing detection result moves (the same rule FMT-3.4 used for OData).
_VERSION_FORMATS = {"2.0": "postman-2.0"}


class PostmanImportSource(ImportSource, register=True):
    """Adapter for Postman Collection v2.0 / v2.1 JSON documents."""

    key = "postman"
    label = "Postman"
    description = (
        "Import a Postman Collection v2.0 or v2.1 with HTTP requests and inferred schemas."
    )
    icon = "file-json"
    paradigm = ApiParadigm.REST
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("postman", "postmancollection", "postman-2.0")
    file_extensions = (".postman_collection.json", ".postman.json", ".json")

    @staticmethod
    def _format_for(document: Any) -> str:
        """The detection format key for a parsed collection (FMT-3.6).

        Args:
            document: The parsed collection mapping, when one is in hand.

        Returns:
            ``postman-2.0`` for a Collection v2.0 export; ``postman`` for v2.1 and
            for an export that names no schema URL.
        """
        return _VERSION_FORMATS.get(collection_version(document) or "", "postman")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        document = payload.document
        if document is not None and is_postman_document(document):
            return DetectionResult(
                confidence=0.98,
                format=self._format_for(document),
                reason="Postman collection `info.schema` marker",
            )

        text = payload.text
        if text is not None and is_postman(text):
            return DetectionResult(
                confidence=0.98,
                format=self._format_for(_safe_document(text)),
                reason="Postman collection `info.schema` marker",
            )
        return NO_MATCH

    def parse(
        self,
        raw: str,
        *,
        source_label: Optional[str] = None,
        environment_variables: Optional[List[PostmanVariable]] = None,
    ) -> PostmanDocument:
        """Parse one collection document.

        Args:
            raw: The collection text.
            source_label: Optional label used only to make errors specific.
            environment_variables: Variables recovered from environment members of
                the same fileset, merged under the collection's own.

        Returns:
            The parsed collection.

        Raises:
            ImportSourceError: Carrying the parser's own taxonomy code, so a
                Collection v1 upload reports ``FORMAT_VERSION_UNSUPPORTED`` and an
                empty collection reports ``INPUT_SEMANTIC_INVALID`` rather than
                both landing on the coarse parse-phase default.
        """
        try:
            return parse_postman(
                raw,
                source_label=source_label,
                environment_variables=tuple(environment_variables or ()),
            )
        except PostmanParseError as exc:
            raise ImportSourceError(str(exc), code=getattr(exc, "code", None)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> PostmanDocument:
        """Parse a collection together with the environment files beside it.

        Every non-root member is offered to :func:`~app.postman_parser.parse_environment`;
        the ones that are environment (or globals) exports contribute their enabled
        variables, in member-path order, merged *under* the collection's own values.
        A member that is neither is ignored — a set may carry a README.

        Args:
            fileset: The uploaded set, rooted at the collection.
            source_label: Optional label used only to make errors specific.

        Returns:
            The parsed collection, with the set's variables merged in.

        Raises:
            ImportSourceError: When the set has no root document, or the root does
                not parse as a collection.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError("Postman fileset is missing its root document")
        environment: List[PostmanVariable] = []
        for path in sorted(fileset.members):
            if path == root:
                continue
            environment.extend(parse_environment(fileset.members[path], source_label=path))
        return self.parse(
            fileset.members[root],
            source_label=root or source_label,
            environment_variables=environment,
        )

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(native_ast, PostmanDocument):
            raise ImportSourceError(
                "Postman source must be a PostmanDocument (see app.postman_parser.parse_postman)"
            )
        return self._normalize_via_registry("postman", native_ast, include_raw=include_raw)


def _safe_document(text: str) -> Any:
    """Parse collection text for the version sniff, never raising.

    Detection must be total: a document that is Postman-shaped enough for
    :func:`~app.postman_parser.is_postman` but does not re-parse here simply falls
    back to the unversioned key.

    Args:
        text: The collection text.

    Returns:
        The parsed mapping, or ``None``.
    """
    from .import_ingestion import parse_document

    try:
        return parse_document(text)
    except Exception:  # noqa: BLE001 - detection never raises
        return None
