"""Format auto-detection — MFI-1.5 (#3737).

Users should not have to know whether a file is RAML, OpenAPI, or Smithy. This
module extends the MFI-1.1 detection seam (:func:`app.import_source.detect_import_source`)
so an ingested document is routed to the right format by a cheap content sniff —
*highest confidence wins*, and genuinely ambiguous inputs are reported so a
caller (UI/CLI) can prompt the user instead of guessing.

Two kinds of detector feed one ranking:

* **Registered adapters.** Every :class:`~app.import_source.ImportSource` already
  contributes a :meth:`~app.import_source.ImportSource.detect`; those matches are
  *importable* (an adapter exists to parse/normalize them today, e.g. OpenAPI).
* **Format sniffers (this module).** Cheap marker sniffers for the formats whose
  full adapters land in later format epics (AsyncAPI, gRPC/Protobuf, GraphQL,
  RAML, API Blueprint, Smithy, TypeSpec, WSDL, OData, Avro, Arazzo). They let the
  importer *name* the format — and tell the user it is recognized but not yet
  importable — rather than failing with an opaque "unsupported document".

  Arazzo is the one Project-destined sniffer: unlike the catalog formats above, the
  §0.3 routing policy (MFI-26.6, #4101) sends it to the publishable **Projects** path
  (with OpenAPI/Swagger), so naming it here keeps it off the catalog branch until its
  Project-import adapter ships.

The sniffers are deliberately not registered as no-op :class:`ImportSource`
adapters: that would pollute the source list (UI cards / CLI ``import --list``)
with formats that cannot actually be imported yet. When a format epic ships a real
adapter, its ``detect()`` supersedes the sniffer here (the adapter match is
importable and dedup keeps the importable candidate), so this module shrinks over
time without callers changing.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, replace
from typing import Callable, List, Optional

from .import_ingestion import IngestionError, parse_document
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    detect_import_source_candidates,
)
from .intake_resource_guard import IntakeLimitError

logger = logging.getLogger(__name__)

# When the top two distinct-format candidates are within this confidence margin of
# each other, the input is treated as ambiguous (the importer should ask the user
# which format to use rather than silently picking one).
DEFAULT_AMBIGUITY_MARGIN = 0.15


@dataclass(frozen=True)
class FormatCandidate:
    """One ranked format guess for an ingested document.

    Attributes:
        format: The detected format key (e.g. ``asyncapi-2``, ``graphql``,
            ``openapi-3.1``).
        confidence: ``0.0``…``1.0`` certainty from the detector that matched.
        reason: Short human justification (the marker found), for disambiguation.
        source_key: The registry key of the importable adapter that matched, or
            ``None`` when this came from a not-yet-importable sniffer.
        importable: Whether a registered adapter can actually import this format
            today (``True`` for adapter matches, ``False`` for sniffer-only).
    """

    format: str
    confidence: float
    reason: Optional[str]
    source_key: Optional[str]
    importable: bool


@dataclass(frozen=True)
class FormatDetection:
    """The outcome of auto-detecting a document's format.

    Attributes:
        detected: The single best candidate, or ``None`` when nothing matched.
        candidates: All distinct-format candidates, sorted by descending
            confidence then format key (deterministic).
        ambiguous: ``True`` when two or more distinct formats matched with
            confidences within :data:`DEFAULT_AMBIGUITY_MARGIN` — the caller
            should prompt the user to choose.
        ambiguous_candidates: The close cluster (the best plus everything within
            the margin) when :attr:`ambiguous`; empty otherwise.
    """

    detected: Optional[FormatCandidate]
    candidates: List[FormatCandidate]
    ambiguous: bool
    ambiguous_candidates: List[FormatCandidate]

    @property
    def matched(self) -> bool:
        """Whether any detector recognized the document."""
        return self.detected is not None


# ===========================================================================
# Format sniffers (cheap content markers; no full parse)
# ===========================================================================
#
# Each sniffer takes a :class:`DetectionInput` and returns a
# :class:`DetectionResult` — ``NO_MATCH`` when its marker is absent, or a
# confidence + ``format`` key + ``reason`` when present. They must be cheap and
# must never raise (an unrecognized input is simply not a match).

# A leading ``#%RAML`` comment is the spec-mandated first line of a RAML document.
_RAML_RE = re.compile(r"^\s*#%RAML\s+(\d+\.\d+)", re.IGNORECASE)
# API Blueprint declares its version with a ``FORMAT: 1A`` metadata line.
_API_BLUEPRINT_RE = re.compile(r"^\s*FORMAT\s*:\s*1A\b", re.IGNORECASE | re.MULTILINE)
# Protobuf files pin the wire syntax with ``syntax = "proto2"|"proto3"``.
_PROTOBUF_RE = re.compile(r"""\bsyntax\s*=\s*['"]proto([23])['"]""")
# Smithy IDL opens with a control statement ``$version: "2.0"``.
_SMITHY_VERSION_RE = re.compile(r"""^\s*\$version\s*:\s*['"]\d""", re.MULTILINE)
_SMITHY_KEYWORD_RE = re.compile(r"^\s*(service|structure|operation|resource)\s+\w", re.MULTILINE)
# A namespace declaration is shared by Smithy and TypeSpec, so it is only a weak
# signal on its own (the two disambiguate via their distinctive markers below).
_NAMESPACE_RE = re.compile(r"^\s*namespace\s+[\w.]+", re.MULTILINE)
# TypeSpec imports its standard library and declares models/operations.
_TYPESPEC_IMPORT_RE = re.compile(r"""^\s*import\s+['"]@typespec/""", re.MULTILINE)
_TYPESPEC_DECL_RE = re.compile(r"^\s*(model|op|interface)\s+\w", re.MULTILINE)
# GraphQL SDL defines a root operation type or an explicit schema block.
_GRAPHQL_RE = re.compile(r"^\s*(type\s+(Query|Mutation|Subscription)\b|schema\s*\{)", re.MULTILINE)


def _text_of(payload: DetectionInput) -> str:
    """Return the raw document text for content sniffing (empty when absent)."""
    return payload.text or ""


def _sniff_raml(payload: DetectionInput) -> DetectionResult:
    match = _RAML_RE.match(_text_of(payload))
    if match:
        return DetectionResult(
            confidence=0.99, format="raml", reason=f"`#%RAML {match.group(1)}` header"
        )
    return NO_MATCH


def _sniff_api_blueprint(payload: DetectionInput) -> DetectionResult:
    if _API_BLUEPRINT_RE.search(_text_of(payload)):
        return DetectionResult(
            confidence=0.95, format="api-blueprint", reason="`FORMAT: 1A` marker"
        )
    return NO_MATCH


def _sniff_protobuf(payload: DetectionInput) -> DetectionResult:
    match = _PROTOBUF_RE.search(_text_of(payload))
    if match:
        return DetectionResult(
            confidence=0.97, format="protobuf", reason=f"`syntax = \"proto{match.group(1)}\"` marker"
        )
    if payload.data is not None:
        # IXH-7.5: a binary serialized FileDescriptorSet / buf image has no text marker —
        # the undecoded bytes either parse as one or they do not. Imported lazily so the
        # sniffer table stays cheap for the (overwhelmingly common) text payloads.
        from .proto_descriptor import sniff_file_descriptor_set

        if sniff_file_descriptor_set(payload.data):
            return DetectionResult(
                confidence=0.9,
                format="protobuf",
                reason="binary FileDescriptorSet / buf image",
            )
    return NO_MATCH


def _sniff_graphql(payload: DetectionInput) -> DetectionResult:
    if _GRAPHQL_RE.search(_text_of(payload)):
        return DetectionResult(
            confidence=0.9, format="graphql", reason="GraphQL root type / `schema {}` block"
        )
    return NO_MATCH


def _sniff_wsdl(payload: DetectionInput) -> DetectionResult:
    text = _text_of(payload)
    if "<wsdl:definitions" in text or (
        "<definitions" in text and "schemas.xmlsoap.org/wsdl" in text
    ):
        return DetectionResult(confidence=0.97, format="wsdl", reason="`<wsdl:definitions>` root")
    return NO_MATCH


def _sniff_wadl(payload: DetectionInput) -> DetectionResult:
    text = _text_of(payload)
    if "<application" in text and any(marker in text for marker in (
        "http://wadl.dev.java.net/2009/02",
        "http://wadl.dev.java.net/ns/wadl",
    )):
        return DetectionResult(
            confidence=0.97, format="wadl", reason="`<application>` root with WADL namespace"
        )
    return NO_MATCH


def _sniff_odata(payload: DetectionInput) -> DetectionResult:
    text = _text_of(payload)
    if "<edmx:Edmx" in text or ("<Edmx" in text and "docs.oasis-open.org/odata" in text):
        return DetectionResult(confidence=0.97, format="odata", reason="`<edmx:Edmx>` root")
    return NO_MATCH


def _sniff_smithy(payload: DetectionInput) -> DetectionResult:
    text = _text_of(payload)
    has_version = bool(_SMITHY_VERSION_RE.search(text))
    has_namespace = bool(_NAMESPACE_RE.search(text))
    has_keyword = bool(_SMITHY_KEYWORD_RE.search(text))
    if has_version and (has_namespace or has_keyword):
        return DetectionResult(confidence=0.95, format="smithy", reason="`$version` + Smithy shapes")
    if has_version:
        return DetectionResult(confidence=0.8, format="smithy", reason="`$version` control statement")
    if has_namespace and has_keyword:
        return DetectionResult(confidence=0.7, format="smithy", reason="namespace + Smithy shapes")
    if has_namespace:
        # A bare `namespace` is shared with TypeSpec — a weak, deliberately
        # ambiguous signal so the importer asks rather than guesses.
        return DetectionResult(confidence=0.4, format="smithy", reason="`namespace` declaration")
    return NO_MATCH


def _sniff_typespec(payload: DetectionInput) -> DetectionResult:
    text = _text_of(payload)
    if _TYPESPEC_IMPORT_RE.search(text):
        return DetectionResult(confidence=0.97, format="typespec", reason="`import \"@typespec/...\"`")
    has_namespace = bool(_NAMESPACE_RE.search(text))
    has_decl = bool(_TYPESPEC_DECL_RE.search(text))
    if has_namespace and has_decl:
        return DetectionResult(confidence=0.7, format="typespec", reason="namespace + model/op")
    if has_namespace:
        return DetectionResult(confidence=0.4, format="typespec", reason="`namespace` declaration")
    return NO_MATCH


def _sniff_hl7v2(payload: DetectionInput) -> DetectionResult:
    from .hl7v2_parser import is_hl7v2

    text = _text_of(payload)
    if is_hl7v2(text):
        return DetectionResult(confidence=0.97, format="hl7v2", reason="`MSH|^~\\&|` message header")
    return NO_MATCH


def _sniff_iso20022(payload: DetectionInput) -> DetectionResult:
    from .iso20022_parser import is_iso20022

    text = _text_of(payload)
    if is_iso20022(text):
        return DetectionResult(
            confidence=0.97,
            format="iso20022",
            reason="`urn:iso:std:iso:20022:tech:xsd:` namespace",
        )
    return NO_MATCH


def _sniff_iso8583(payload: DetectionInput) -> DetectionResult:
    from .iso8583_parser import is_iso8583

    text = _text_of(payload)
    if is_iso8583(text):
        return DetectionResult(
            confidence=0.97,
            format="iso8583",
            reason="`mti` + `dataElements` ISO 8583 field map",
        )
    document = payload.document
    if isinstance(document, dict):
        import json

        if is_iso8583(json.dumps(document, separators=(",", ":"))):
            return DetectionResult(
                confidence=0.96,
                format="iso8583",
                reason="`mti` + `dataElements` ISO 8583 field map",
            )
    return NO_MATCH


def _sniff_jtd(payload: DetectionInput) -> DetectionResult:
    from .jtd_import_source import is_jtd

    text = _text_of(payload)
    if is_jtd(text):
        return DetectionResult(
            confidence=0.94,
            format="jtd",
            reason="`optionalProperties` / `elements` JTD schema document",
        )
    document = payload.document
    if isinstance(document, dict):
        import json

        if is_jtd(json.dumps(document, separators=(",", ":"))):
            return DetectionResult(
                confidence=0.93,
                format="jtd",
                reason="`optionalProperties` / `elements` JTD schema document",
            )
    return NO_MATCH


def _sniff_jsonschema(payload: DetectionInput) -> DetectionResult:
    from .jsonschema_import_source import JsonSchemaImportSource

    # Delegate so dialect tags (e.g. json-schema-2020-12) match the adapter and do not
    # create a false ambiguity against a parallel json-schema candidate.
    return JsonSchemaImportSource().detect(payload)


def _sniff_zosconnect(payload: DetectionInput) -> DetectionResult:
    from .zosconnect_parser import is_zosconnect

    text = _text_of(payload)
    if is_zosconnect(text):
        return DetectionResult(
            confidence=0.97,
            format="zosconnect",
            reason="`apiRequester` / `apiProvider` with mapped `operations`",
        )
    document = payload.document
    if isinstance(document, dict):
        import json

        if is_zosconnect(json.dumps(document, separators=(",", ":"))):
            return DetectionResult(
                confidence=0.96,
                format="zosconnect",
                reason="`apiRequester` / `apiProvider` with mapped `operations`",
            )
    return NO_MATCH


def _sniff_fix(payload: DetectionInput) -> DetectionResult:
    from .fix_parser import is_fix

    text = _text_of(payload)
    if is_fix(text):
        return DetectionResult(
            confidence=0.97,
            format="fix",
            reason="`8=FIX.` BeginString with tag=value fields",
        )
    return NO_MATCH


def _sniff_cobolcopybook(payload: DetectionInput) -> DetectionResult:
    from .cobolcopybook_parser import is_cobolcopybook

    text = _text_of(payload)
    if is_cobolcopybook(text):
        return DetectionResult(
            confidence=0.97,
            format="cobolcopybook",
            reason="level-01 group with `PIC` clauses",
        )
    return NO_MATCH


def _sniff_asyncapi(payload: DetectionInput) -> DetectionResult:
    document = payload.document
    if not isinstance(document, dict):
        return NO_MATCH
    version = document.get("asyncapi")
    if isinstance(version, str) and version.strip():
        fmt = "asyncapi-3" if version.startswith("3.") else "asyncapi-2"
        return DetectionResult(confidence=0.98, format=fmt, reason=f"`asyncapi: {version}` marker")
    return NO_MATCH


def _sniff_arazzo(payload: DetectionInput) -> DetectionResult:
    """Recognize an Arazzo workflow description by its ``arazzo: <version>`` marker.

    Arazzo is a **Project-destined** (publishable) format under the §0.3 routing policy
    (MFI-26.6, #4101) — alongside OpenAPI/Swagger — not a catalog format. It is sniffed
    here (rather than via a registered :class:`ImportSource`) because its Project-import
    adapter lands in a later epic; detecting it now lets the importer *name* Arazzo and
    route it to the Projects path instead of letting it fall through to the catalog. The
    top-level ``arazzo`` key is the spec-mandated version discriminator, exactly like
    ``openapi``/``swagger``/``asyncapi``.
    """
    document = payload.document
    if not isinstance(document, dict):
        return NO_MATCH
    version = document.get("arazzo")
    if isinstance(version, str) and version.strip():
        return DetectionResult(
            confidence=0.98, format="arazzo", reason=f"`arazzo: {version}` marker"
        )
    return NO_MATCH


def _sniff_openrpc(payload: DetectionInput) -> DetectionResult:
    document = payload.document
    if not isinstance(document, dict):
        return NO_MATCH
    version = document.get("openrpc")
    if isinstance(version, str) and version.strip():
        return DetectionResult(
            confidence=0.98, format="openrpc", reason=f"`openrpc: {version}` marker"
        )
    return NO_MATCH


def _sniff_discovery(payload: DetectionInput) -> DetectionResult:
    document = payload.document
    if not isinstance(document, dict):
        return NO_MATCH
    if any(marker in document for marker in ("openapi", "swagger", "asyncapi", "arazzo", "openrpc")):
        return NO_MATCH
    kind = document.get("kind")
    if isinstance(kind, str) and kind.strip() == "discovery#restDescription":
        return DetectionResult(
            confidence=0.98,
            format="discovery",
            reason="`kind: discovery#restDescription` marker",
        )
    version = document.get("discoveryVersion")
    if isinstance(version, str) and version.strip():
        if "resources" in document or "schemas" in document:
            return DetectionResult(
                confidence=0.95,
                format="discovery",
                reason=f"`discoveryVersion: {version}` marker",
            )
    return NO_MATCH


def _sniff_k8s_crd(payload: DetectionInput) -> DetectionResult:
    from .k8s_crd_parser import is_k8s_crd, is_k8s_crd_document

    document = payload.document
    if isinstance(document, dict) and is_k8s_crd_document(document):
        return DetectionResult(
            confidence=0.98,
            format="k8s-crd",
            reason="`apiVersion: apiextensions.k8s.io/*` + `kind: CustomResourceDefinition`",
        )
    text = _text_of(payload)
    if text and is_k8s_crd(text):
        return DetectionResult(
            confidence=0.98,
            format="k8s-crd",
            reason="`apiVersion: apiextensions.k8s.io/*` + `kind: CustomResourceDefinition`",
        )
    return NO_MATCH


def _sniff_llm_tools(payload: DetectionInput) -> DetectionResult:
    from .llm_tools_parser import is_llm_tools, is_llm_tools_document

    document = payload.document
    if document is not None and is_llm_tools_document(document):
        return DetectionResult(
            confidence=0.97,
            format="llm-tools",
            reason="OpenAI / Anthropic / bare tool-array shape",
        )
    text = _text_of(payload)
    if text and is_llm_tools(text):
        return DetectionResult(
            confidence=0.97,
            format="llm-tools",
            reason="OpenAI / Anthropic / bare tool-array shape",
        )
    return NO_MATCH


def _sniff_avro(payload: DetectionInput) -> DetectionResult:
    document = payload.document
    if not isinstance(document, dict):
        return NO_MATCH
    if document.get("type") == "record" and isinstance(document.get("fields"), list):
        name = document.get("name")
        reason = f"Avro record `{name}`" if isinstance(name, str) and name else "Avro `type: record`"
        return DetectionResult(confidence=0.9, format="avro", reason=reason)
    return NO_MATCH


def _sniff_xmlrpc(payload: DetectionInput) -> DetectionResult:
    text = _text_of(payload)
    if not text:
        return NO_MATCH
    if "<methodCall" in text or "<methodResponse" in text:
        if "<wsdl:definitions" in text or (
            "<definitions" in text and "schemas.xmlsoap.org/wsdl" in text
        ):
            return NO_MATCH
        kind = "methodCall" if "<methodCall" in text else "methodResponse"
        return DetectionResult(confidence=0.95, format="xmlrpc", reason=f"`<{kind}>` root element")
    return NO_MATCH


def _sniff_xsd(payload: DetectionInput) -> DetectionResult:
    text = _text_of(payload)
    if not text:
        return NO_MATCH
    if "<wsdl:definitions" in text or (
        "<definitions" in text and "schemas.xmlsoap.org/wsdl" in text
    ):
        return NO_MATCH
    if "<application" in text and "wadl.dev.java.net" in text:
        return NO_MATCH
    if "<xs:schema" in text or "<xsd:schema" in text or (
        "http://www.w3.org/2001/XMLSchema" in text and "<schema" in text
    ):
        return DetectionResult(confidence=0.95, format="xsd", reason="W3C `schema` root element")
    return NO_MATCH


def _sniff_cloudevents(payload: DetectionInput) -> DetectionResult:
    document = payload.document
    if isinstance(document, dict):
        specversion = document.get("specversion")
        event_type = document.get("type")
        source = document.get("source")
        if (
            isinstance(specversion, str)
            and specversion.strip()
            and isinstance(event_type, str)
            and event_type.strip()
            and isinstance(source, str)
            and source.strip()
            and "openapi" not in document
            and "swagger" not in document
            and "asyncapi" not in document
            and not (isinstance(document.get("info"), dict) and "item" in document)
        ):
            return DetectionResult(
                confidence=0.95,
                format="cloudevents",
                reason="CloudEvents `specversion` + `type` + `source` markers",
            )
    text = _text_of(payload)
    if text and '"specversion"' in text and '"type"' in text and '"source"' in text:
        if "openapi" not in text and "swagger" not in text and "asyncapi" not in text:
            if '"info"' not in text or '"item"' not in text:
                return DetectionResult(
                    confidence=0.85,
                    format="cloudevents",
                    reason="CloudEvents envelope markers",
                )
    return NO_MATCH


def _sniff_postman(payload: DetectionInput) -> DetectionResult:
    document = payload.document
    if isinstance(document, dict):
        info = document.get("info")
        if isinstance(info, dict):
            schema = info.get("schema")
            if isinstance(schema, str) and "postman.com" in schema.lower() and "collection" in schema.lower():
                return DetectionResult(
                    confidence=0.95,
                    format="postman",
                    reason="Postman collection `info.schema` marker",
                )
    text = _text_of(payload)
    if text and "postman.com" in text.lower() and '"item"' in text and '"info"' in text:
        return DetectionResult(
            confidence=0.9,
            format="postman",
            reason="Postman collection markers",
        )
    return NO_MATCH


#: Every standalone sniffer, in a stable order. Each yields a not-yet-importable
#: format candidate (their full adapters arrive in the format epics).
_SNIFFERS: tuple[Callable[[DetectionInput], DetectionResult], ...] = (
    _sniff_raml,
    _sniff_api_blueprint,
    _sniff_protobuf,
    _sniff_graphql,
    _sniff_wsdl,
    _sniff_wadl,
    _sniff_odata,
    _sniff_smithy,
    _sniff_typespec,
    _sniff_hl7v2,
    _sniff_iso20022,
    _sniff_iso8583,
    _sniff_cobolcopybook,
    _sniff_fix,
    _sniff_zosconnect,
    _sniff_jtd,
    _sniff_jsonschema,
    _sniff_asyncapi,
    _sniff_arazzo,
    _sniff_openrpc,
    _sniff_discovery,
    _sniff_k8s_crd,
    _sniff_llm_tools,
    _sniff_avro,
    _sniff_xmlrpc,
    _sniff_xsd,
    _sniff_postman,
    _sniff_cloudevents,
)

#: The format keys this module can sniff (for tests/docs); adapter formats are
#: enumerated separately from the registry.
SNIFFED_FORMATS = frozenset(
    {
        "raml",
        "api-blueprint",
        "protobuf",
        "graphql",
        "wsdl",
        "wadl",
        "odata",
        "smithy",
        "typespec",
        "hl7v2",
        "iso20022",
        "iso8583",
        "cobolcopybook",
        "fix",
        "zosconnect",
        "jtd",
        "json-schema",
        "asyncapi-2",
        "asyncapi-3",
        "arazzo",
        "openrpc",
        "discovery",
        "k8s-crd",
        "llm-tools",
        "avro",
        "xmlrpc",
        "xsd",
        "postman",
        "cloudevents",
    }
)


# ===========================================================================
# Orchestration
# ===========================================================================


def _ensure_document(payload: DetectionInput) -> DetectionInput:
    """Return ``payload`` with ``document`` filled from ``text`` when possible.

    The structured sniffers (AsyncAPI, Avro) and the registered adapters read an
    already-parsed mapping. Parsing once here (JSON or YAML, best effort) means a
    document supplied as raw text is sniffed just like one supplied pre-parsed.
    Text-only formats (protobuf, GraphQL, RAML, …) simply fail to parse, which is
    harmless — their sniffers read the raw text.

    A document that breaches an intake resource limit (IXH-1.4) is likewise left
    unparsed: detection is best-effort and must never raise, so the text-based
    sniffers still get their chance and the limit is reported by the parse phase.
    """
    if payload.document is not None or not payload.text:
        return payload
    try:
        document = parse_document(payload.text, source_label=payload.filename)
    except (IngestionError, IntakeLimitError):
        return payload
    return replace(payload, document=document)


def _dedupe_by_format(candidates: List[FormatCandidate]) -> List[FormatCandidate]:
    """Collapse candidates sharing a format key, keeping the strongest.

    Two detectors can name the same format (e.g. a future adapter and the legacy
    sniffer for it). The importable, higher-confidence candidate wins so the
    ranking never double-counts one format or reports false ambiguity.
    """
    best_by_format: dict[str, FormatCandidate] = {}
    for candidate in candidates:
        current = best_by_format.get(candidate.format)
        if current is None:
            best_by_format[candidate.format] = candidate
            continue
        # Prefer higher confidence; break ties in favour of the importable match.
        if (candidate.confidence, candidate.importable) > (current.confidence, current.importable):
            best_by_format[candidate.format] = candidate
    return list(best_by_format.values())


def detect_format(
    payload: DetectionInput,
    *,
    ambiguity_margin: float = DEFAULT_AMBIGUITY_MARGIN,
) -> FormatDetection:
    """Auto-detect the format of an ingested document.

    Polls every registered import-source adapter and every standalone format
    sniffer, ranks the matches by confidence (highest wins), and flags ambiguity
    when the leading distinct formats are within ``ambiguity_margin`` of each
    other so the caller can prompt the user.

    Args:
        payload: The document to classify — raw ``text`` and/or a parsed
            ``document`` plus filename/content-type/URL hints. Text is parsed once
            (best effort) so structured sniffers see a mapping.
        ambiguity_margin: Confidence gap below which the top two distinct formats
            are considered ambiguous (default :data:`DEFAULT_AMBIGUITY_MARGIN`).

    Returns:
        A :class:`FormatDetection` carrying the best guess, all ranked candidates,
        and the ambiguity verdict. :attr:`FormatDetection.matched` is ``False``
        when nothing recognized the input.
    """
    enriched = _ensure_document(payload)

    candidates: List[FormatCandidate] = []

    # Importable adapter matches (e.g. OpenAPI today).
    for adapter, result in detect_import_source_candidates(enriched):
        candidates.append(
            FormatCandidate(
                format=result.format or adapter.key,
                confidence=result.confidence,
                reason=result.reason,
                source_key=adapter.key,
                importable=True,
            )
        )

    # Not-yet-importable sniffer matches (later format epics). A raising sniffer is
    # treated as no-match: detection feeds a live endpoint and adversarial input
    # must never turn into a 5xx (IXH-1.3).
    for sniffer in _SNIFFERS:
        try:
            result = sniffer(enriched)
        except Exception as exc:  # noqa: BLE001 - a broken sniffer must not break detection
            # Type only, no message/traceback: parser errors quote source spans that
            # may carry credentials (IXH-1.4).
            logger.warning(
                "format sniffer %r raised %s; treating as no-match",
                getattr(sniffer, "__name__", sniffer),
                type(exc).__name__,
            )
            continue
        if result.matched and result.format is not None:
            candidates.append(
                FormatCandidate(
                    format=result.format,
                    confidence=result.confidence,
                    reason=result.reason,
                    source_key=None,
                    importable=False,
                )
            )

    ranked = _dedupe_by_format(candidates)
    ranked.sort(key=lambda c: (-c.confidence, c.format))

    if not ranked:
        return FormatDetection(
            detected=None, candidates=[], ambiguous=False, ambiguous_candidates=[]
        )

    best = ranked[0]
    close = [c for c in ranked if best.confidence - c.confidence <= ambiguity_margin]
    ambiguous = len(close) >= 2
    return FormatDetection(
        detected=best,
        candidates=ranked,
        ambiguous=ambiguous,
        ambiguous_candidates=close if ambiguous else [],
    )
