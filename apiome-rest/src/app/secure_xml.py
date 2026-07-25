"""Hardened XML parsing for import intake — IXH-1.4 (#5090).

Every XML-based import adapter (XSD, WSDL, WADL, OData/EDMX, ISO 20022, XML-RPC)
used to call :func:`xml.etree.ElementTree.fromstring` directly, which expands
internal entities. A three-line "billion laughs" document therefore turned into
gigabytes of text during *detection*, before an adapter was even chosen. This
module is the single seam those adapters now share:

* **No DTDs.** A ``DOCTYPE`` declaration is rejected outright, so entity
  definitions (and their expansion) never exist in the first place.
* **No entity expansion.** Internal and parameter entities are refused by
  :mod:`defusedxml` even when a DTD slips through a future code path.
* **No external references.** ``SYSTEM``/``PUBLIC`` identifiers and XInclude
  targets are never fetched, so an uploaded document cannot reach the network or
  the filesystem.
* **Bounded size and depth.** A byte ceiling is checked before parsing, and the
  parsed tree's nesting depth is measured iteratively afterwards. The depth cap
  is what keeps the adapters' own *recursive* element walkers (XML-RPC values,
  ISO 20022 elements) from dying with an uncaught ``RecursionError``.

All violations surface as :class:`SecureXmlError`, which adapters map onto the
intake error taxonomy (see :mod:`app.intake_error_taxonomy`). Sniffers must never
raise, so they catch it and report "not my format" instead.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import List, Optional

from defusedxml import DTDForbidden, EntitiesForbidden, ExternalReferenceForbidden
from defusedxml.ElementTree import fromstring as _defused_fromstring

__all__ = [
    "DEFAULT_MAX_XML_BYTES",
    "DEFAULT_MAX_XML_DEPTH",
    "SecureXmlError",
    "parse_xml",
    "xml_tree_depth",
]

#: Byte ceiling for a single XML document, matching the OAS resource-limits
#: artifact's ``maxDocumentBytes`` (10 MiB) so every intake surface agrees.
DEFAULT_MAX_XML_BYTES = 10 * 1024 * 1024

#: Maximum element nesting depth. Comfortably above real schemas (deeply nested
#: XSDs sit well under 100) and far below CPython's default recursion limit, so
#: the adapters' recursive element walkers cannot exhaust the stack.
DEFAULT_MAX_XML_DEPTH = 256

#: XInclude namespace. ``ElementTree`` does not process ``xi:include`` unless
#: :mod:`xml.etree.ElementInclude` is invoked, so such a directive is inert *today* —
#: but it is inert by accident, not by policy. An uploaded document has no
#: legitimate reason to pull in another resource, so the directive is rejected
#: outright rather than left for a future caller to expand.
_XINCLUDE_NS = "http://www.w3.org/2001/XInclude"


class SecureXmlError(ValueError):
    """An XML document was rejected by the hardened parser.

    Attributes:
        code: The intake-taxonomy code this violation maps onto — either
            ``INPUT_UNSAFE_CONSTRUCT`` (DTD, entity, or external reference),
            ``INPUT_TOO_LARGE``, ``INPUT_DEPTH_LIMIT``, or ``INPUT_MALFORMED``
            for ordinary syntax faults.
    """

    def __init__(self, message: str, *, code: str = "INPUT_MALFORMED") -> None:
        super().__init__(message)
        self.code = code


def xml_tree_depth(root: ET.Element) -> int:
    """Return the maximum element nesting depth of a parsed tree, iteratively.

    Args:
        root: The parsed root element.

    Returns:
        The depth, counting the root as 1.
    """
    max_depth = 0
    # (element, depth) — an explicit stack, so measuring a hostile document can
    # never itself recurse.
    stack: List[tuple[ET.Element, int]] = [(root, 1)]
    while stack:
        element, depth = stack.pop()
        if depth > max_depth:
            max_depth = depth
        for child in element:
            stack.append((child, depth + 1))
    return max_depth


def parse_xml(
    text: str,
    *,
    source_label: Optional[str] = None,
    max_bytes: int = DEFAULT_MAX_XML_BYTES,
    max_depth: int = DEFAULT_MAX_XML_DEPTH,
) -> ET.Element:
    """Parse XML text with DTD, entity, external-reference, size and depth guards.

    Args:
        text: The raw XML document text.
        source_label: Optional label (filename) used to make errors specific.
        max_bytes: UTF-8 byte ceiling, checked before parsing.
        max_depth: Maximum element nesting depth, checked after parsing.

    Returns:
        The parsed root :class:`xml.etree.ElementTree.Element`.

    Raises:
        SecureXmlError: If the document declares a DTD, defines or references an
            entity, points at an external resource, exceeds ``max_bytes`` or
            ``max_depth``, or is not well-formed XML.
    """
    where = f" ({source_label})" if source_label else ""
    if text is None or not text.strip():
        raise SecureXmlError(f"XML document is empty{where}", code="INPUT_EMPTY")

    size = len(text.encode("utf-8", errors="replace"))
    if size > max_bytes:
        raise SecureXmlError(
            f"XML document is too large{where}: {size} bytes exceeds the "
            f"{max_bytes}-byte limit",
            code="INPUT_TOO_LARGE",
        )

    try:
        # defusedxml refuses entities and external references by default;
        # forbid_dtd additionally rejects the DOCTYPE that would declare them.
        root = _defused_fromstring(text, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except DTDForbidden as exc:
        raise SecureXmlError(
            f"XML document declares a DTD{where}, which is not allowed on import "
            f"(document type {exc.name!r})",
            code="INPUT_UNSAFE_CONSTRUCT",
        ) from exc
    except EntitiesForbidden as exc:
        raise SecureXmlError(
            f"XML document defines or references an entity{where}, which is not "
            f"allowed on import (entity {exc.name!r})",
            code="INPUT_UNSAFE_CONSTRUCT",
        ) from exc
    except ExternalReferenceForbidden as exc:
        raise SecureXmlError(
            f"XML document references an external resource{where}, which is not "
            f"allowed on import (system id {exc.system_id!r})",
            code="INPUT_UNSAFE_CONSTRUCT",
        ) from exc
    except ET.ParseError as exc:
        raise SecureXmlError(f"XML document is not well-formed{where}: {exc}") from exc

    depth = xml_tree_depth(root)
    if depth > max_depth:
        raise SecureXmlError(
            f"XML document nests too deeply{where}: {depth} levels exceeds the "
            f"{max_depth}-level limit",
            code="INPUT_DEPTH_LIMIT",
        )

    directive = _find_xinclude(root)
    if directive is not None:
        raise SecureXmlError(
            f"XML document uses an XInclude directive{where} "
            f"(href {directive!r}), which is not allowed on import",
            code="INPUT_UNSAFE_CONSTRUCT",
        )
    return root


def _find_xinclude(root: ET.Element) -> Optional[str]:
    """Return the ``href`` of the first XInclude directive found, if any.

    Args:
        root: The parsed root element.

    Returns:
        The directive's ``href`` (or ``"<no href>"`` when it has none), or ``None``
        when the document contains no XInclude element.
    """
    prefix = f"{{{_XINCLUDE_NS}}}"
    stack: List[ET.Element] = [root]
    while stack:
        element = stack.pop()
        if isinstance(element.tag, str) and element.tag.startswith(prefix):
            return element.attrib.get("href", "<no href>")
        stack.extend(list(element))
    return None
