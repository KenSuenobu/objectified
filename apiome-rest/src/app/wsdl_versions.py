"""WSDL dialect table, version sniff, and MEP vocabulary — FMT-3.3 (#5428).

WSDL ships in two grammars that share a name and almost nothing else. 1.1 describes a
service with ``definitions`` / ``message`` / ``portType`` / ``binding`` / ``service``;
2.0 replaced that with ``description`` / ``interface`` / ``binding`` / ``service``, dropped
the ``message`` element entirely (an operation names its payload *element* directly), and
moved the transmission primitive onto the operation as a **message exchange pattern** URI.

The two are told apart by the namespace of the root element, never by the element name
alone: ``<definitions>`` and ``<description>`` are both legal roots in *some* XML dialect,
and a bare local name is not evidence of anything. This module owns:

* the two namespace URIs and the version strings they resolve to,
* :func:`detect_wsdl_version`, a text-only sniff that never parses (detection runs on
  hostile input and must not raise),
* :func:`format_key_for_version`, the detection/format key each version reports, and
* the 2.0 MEP vocabulary and its projection onto :class:`~app.canonical_model.OperationKind`.

WSDL 2.0 **output** is a separate ticket (#4182); this module exists so that the version
vocabulary is shared when it lands rather than re-derived.
"""

from __future__ import annotations

from typing import Dict, Optional

from .canonical_model import OperationKind

__all__ = [
    "MEP_IN_ONLY",
    "MEP_IN_OPT_OUT",
    "MEP_IN_OUT",
    "MEP_OUT_ONLY",
    "MEP_OUT_IN",
    "MEP_OUT_OPT_IN",
    "MEP_ROBUST_IN_ONLY",
    "MEP_ROBUST_OUT_ONLY",
    "MEP_OPERATION_KINDS",
    "VERSION_1_1",
    "VERSION_2_0",
    "WSDL_1_1_NAMESPACE",
    "WSDL_2_0_NAMESPACE",
    "detect_wsdl_version",
    "format_key_for_version",
    "operation_kind_for_pattern",
    "version_for_namespace",
]

#: The WSDL 1.1 namespace (SOAP-era ``<wsdl:definitions>`` documents).
WSDL_1_1_NAMESPACE = "http://schemas.xmlsoap.org/wsdl/"

#: The WSDL 2.0 namespace (``<description>`` documents, W3C Recommendation 2007).
WSDL_2_0_NAMESPACE = "http://www.w3.org/ns/wsdl"

#: Version string for a 1.1 document.
VERSION_1_1 = "1.1"

#: Version string for a 2.0 document.
VERSION_2_0 = "2.0"

#: The detection/format key each version reports. 1.1 keeps the bare ``wsdl`` key it has
#: always reported — it is the adapter's registry key and what every existing caller sends
#: — so only 2.0 needs a version-scoped key of its own.
_FORMAT_KEYS: Dict[str, str] = {
    VERSION_1_1: "wsdl",
    VERSION_2_0: "wsdl-2.0",
}

#: Format key reported when the version cannot be resolved (a ``.wsdl`` filename with no
#: readable text, for instance). The family key, which resolves back to this adapter.
_DEFAULT_FORMAT_KEY = "wsdl"

# --- WSDL 2.0 message exchange patterns (Part 2, "Adjuncts", §2) -----------------------

MEP_IN_OUT = "http://www.w3.org/ns/wsdl/in-out"
MEP_IN_ONLY = "http://www.w3.org/ns/wsdl/in-only"
MEP_ROBUST_IN_ONLY = "http://www.w3.org/ns/wsdl/robust-in-only"
MEP_IN_OPT_OUT = "http://www.w3.org/ns/wsdl/in-opt-out"
MEP_OUT_ONLY = "http://www.w3.org/ns/wsdl/out-only"
MEP_ROBUST_OUT_ONLY = "http://www.w3.org/ns/wsdl/robust-out-only"
MEP_OUT_IN = "http://www.w3.org/ns/wsdl/out-in"
MEP_OUT_OPT_IN = "http://www.w3.org/ns/wsdl/out-opt-in"

#: MEP URI -> canonical operation kind.
#:
#: The three in-bound patterns that can carry a reply (``in-out``, ``in-opt-out``) and the
#: two client-initiated out-bound ones (``out-in``, ``out-opt-in``) are request/response:
#: the requester sends and may receive. ``in-only`` and ``robust-in-only`` are fire-and-
#: forget — ``robust-in-only`` may reply with a *fault*, which is an error channel, not an
#: output message, so it is still one-way. ``out-only`` and ``robust-out-only`` are the
#: service emitting unsolicited, which is a publish.
MEP_OPERATION_KINDS: Dict[str, OperationKind] = {
    MEP_IN_OUT: OperationKind.REQUEST_RESPONSE,
    MEP_IN_OPT_OUT: OperationKind.REQUEST_RESPONSE,
    MEP_OUT_IN: OperationKind.REQUEST_RESPONSE,
    MEP_OUT_OPT_IN: OperationKind.REQUEST_RESPONSE,
    MEP_IN_ONLY: OperationKind.ONE_WAY,
    MEP_ROBUST_IN_ONLY: OperationKind.ONE_WAY,
    MEP_OUT_ONLY: OperationKind.PUBLISH,
    MEP_ROBUST_OUT_ONLY: OperationKind.PUBLISH,
}


def detect_wsdl_version(text: str) -> Optional[str]:
    """Resolve the WSDL grammar ``text`` is written in, without parsing it.

    The namespace decides, because it is the only unambiguous evidence: a 2.0 document
    binds ``http://www.w3.org/ns/wsdl`` (usually as the default namespace, so its root
    reads ``<description>`` with no prefix), while a 1.1 document binds
    ``http://schemas.xmlsoap.org/wsdl/``.

    Both URIs are matched as substrings rather than as quoted attribute values because,
    unlike the OData EDMX namespaces, neither WSDL namespace is a prefix of the other, so
    there is no wrapper-versus-body confusion to guard against.

    Args:
        text: The raw document text.

    Returns:
        :data:`VERSION_2_0`, :data:`VERSION_1_1`, or ``None`` when neither namespace
        appears (the caller decides whether that is a rejection or a filename-only guess).
    """
    if not text or not isinstance(text, str):
        return None
    if WSDL_2_0_NAMESPACE in text:
        return VERSION_2_0
    if WSDL_1_1_NAMESPACE in text:
        return VERSION_1_1
    return None


def version_for_namespace(namespace: Optional[str]) -> Optional[str]:
    """Resolve the grammar a root element's namespace names.

    The authoritative reading, used once a document has actually been parsed: a namespace
    *declared* on the root element is the grammar, where :func:`detect_wsdl_version`'s
    substring sniff can only say the URI appears somewhere in the text — a 1.1 document
    quoting the 2.0 namespace in its ``documentation`` would read as 2.0 there.

    Args:
        namespace: The root element's namespace URI, or ``None`` for an unqualified root.

    Returns:
        The version string, or ``None`` when the namespace is not a WSDL one.
    """
    if not namespace:
        return None
    trimmed = namespace.rstrip("/")
    if trimmed == WSDL_2_0_NAMESPACE.rstrip("/"):
        return VERSION_2_0
    if trimmed == WSDL_1_1_NAMESPACE.rstrip("/"):
        return VERSION_1_1
    return None


def format_key_for_version(version: Optional[str]) -> str:
    """Return the detection/format key a document of ``version`` reports.

    Args:
        version: A version string from :func:`detect_wsdl_version`, or ``None``.

    Returns:
        ``wsdl-2.0`` for a 2.0 document; ``wsdl`` for 1.1 and for an unresolved version.
    """
    return _FORMAT_KEYS.get(version or "", _DEFAULT_FORMAT_KEY)


def operation_kind_for_pattern(pattern: Optional[str]) -> OperationKind:
    """Project a WSDL 2.0 MEP URI onto a canonical operation kind.

    Args:
        pattern: The operation's ``pattern`` attribute, or ``None`` when the document
            states none — which is every WSDL 1.1 operation, since 1.1 has no MEP
            vocabulary at all.

    Returns:
        The mapped kind, or :attr:`~app.canonical_model.OperationKind.REQUEST_RESPONSE`
        for an absent or unrecognised pattern. That default is what the 1.1 path has
        always produced, so a 1.1 document's canonical shape is untouched, and an
        unknown extension MEP degrades to the commonest shape instead of failing an
        otherwise-valid import.
    """
    if not pattern:
        return OperationKind.REQUEST_RESPONSE
    return MEP_OPERATION_KINDS.get(pattern.strip(), OperationKind.REQUEST_RESPONSE)
