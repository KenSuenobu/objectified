"""OData CSDL / EDMX dialect detection — FMT-3.4 (#5429).

The OData adapter reads three CSDL generations that share one file shape and almost
nothing else. Which grammar a document uses is decided by its **XML namespaces**, not by
the ``Version`` attribute on ``<edmx:Edmx>`` — a v2 document carries ``Version="1.0"``
there, because that attribute versions the *EDMX wrapper* and not the OData service.

This module owns that knowledge and nothing else: the namespace tables, the precedence
rule that turns a document's namespaces into a version string, and the single predicate
(:func:`uses_association_model`) the parser branches on. Keeping it separate from the
document walker means "which dialect is this?" and "what does this element mean?" fail
independently and are tested independently.

Version markers, for reference:

===========  ==========================================  ==========================================
Version      ``edmx`` namespace                          ``Schema`` (EDM) namespace
===========  ==========================================  ==========================================
1.0          ``…/ado/2007/06/edmx``                      ``…/ado/2006/04/edm``
1.1          ``…/ado/2007/06/edmx``                      ``…/ado/2007/05/edm``
1.2          ``…/ado/2007/06/edmx``                      ``…/ado/2008/01/edm``
2.0          ``…/ado/2007/06/edmx``                      ``…/ado/2008/09/edm``
3.0          ``…/ado/2009/11/edmx``                      ``…/ado/2009/11/edm``
4.0          ``http://docs.oasis-open.org/odata/ns/edmx``  ``http://docs.oasis-open.org/odata/ns/edm``
===========  ==========================================  ==========================================
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

__all__ = [
    "DEFAULT_FORMAT_KEY",
    "EDM_NAMESPACE_VERSIONS",
    "EDMX_NAMESPACE_VERSIONS",
    "ODATA_METADATA_NS",
    "ODATA_V4_EDM_NS",
    "ODATA_V4_EDMX_NS",
    "SAP_DATA_NS",
    "XML_NS",
    "ODataDialect",
    "annotation_key",
    "detect_odata_version",
    "format_key_for_version",
    "resolve_dialect",
    "uses_association_model",
]

#: The OData v4 EDM (``Schema``) namespace — the only one this adapter treated as OData
#: before FMT-3.4.
ODATA_V4_EDM_NS = "http://docs.oasis-open.org/odata/ns/edm"

#: The OData v4 EDMX (document wrapper) namespace.
ODATA_V4_EDMX_NS = "http://docs.oasis-open.org/odata/ns/edmx"

#: The v2/v3 ``m:`` metadata namespace — carries ``DataServiceVersion``, ``HasStream``,
#: ``HttpMethod``, ``IsDefaultEntityContainer`` and the ``FC_*`` customizable-feed
#: attributes, none of which have a v4 analogue.
ODATA_METADATA_NS = "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"

#: SAP Gateway's annotation namespace (``sap:label``, ``sap:creatable``, ``sap:semantics``…).
SAP_DATA_NS = "http://www.sap.com/Protocols/SAPData"

#: The reserved XML namespace, source of ``xml:lang`` on SAP schemas.
XML_NS = "http://www.w3.org/XML/1998/namespace"

#: EDM (``Schema``) namespace → CSDL version. The most precise version marker a document
#: carries, and the one :func:`resolve_dialect` prefers.
EDM_NAMESPACE_VERSIONS: Dict[str, str] = {
    "http://schemas.microsoft.com/ado/2006/04/edm": "1.0",
    "http://schemas.microsoft.com/ado/2007/05/edm": "1.1",
    "http://schemas.microsoft.com/ado/2008/01/edm": "1.2",
    "http://schemas.microsoft.com/ado/2008/09/edm": "2.0",
    "http://schemas.microsoft.com/ado/2009/11/edm": "3.0",
    ODATA_V4_EDM_NS: "4.0",
}

#: EDMX (wrapper) namespace → CSDL version. Coarser than the EDM namespace — the
#: ``2007/06`` wrapper covers every 1.x and 2.0 document — so it is only consulted when no
#: ``Schema`` element carries a namespace of its own.
EDMX_NAMESPACE_VERSIONS: Dict[str, str] = {
    "http://schemas.microsoft.com/ado/2007/06/edmx": "2.0",
    "http://schemas.microsoft.com/ado/2009/11/edmx": "3.0",
    ODATA_V4_EDMX_NS: "4.0",
}

#: Namespace URI → the prefix an annotation key is rendered with in ``extras``. A
#: namespace absent here keeps its full URI so nothing is silently collapsed.
_ANNOTATION_PREFIXES: Dict[str, str] = {
    ODATA_METADATA_NS: "m",
    SAP_DATA_NS: "sap",
    XML_NS: "xml",
}

#: The version assumed when a document carries no recognizable namespace at all. v4 is the
#: generation this adapter has always read, so an unmarked document keeps its old meaning.
_FALLBACK_VERSION = "4.0"


@dataclass(frozen=True)
class ODataDialect:
    """The CSDL generation one parsed document belongs to.

    Attributes:
        version: The CSDL version, ``"1.0"`` … ``"4.0"``. This is what the canonical model
            records as the API version and what provenance reports.
        edm_namespace: The ``Schema`` namespace the version was read from, or ``None`` when
            no schema declared one.
        edmx_namespace: The document wrapper's namespace, or ``None``.
        edmx_version: The literal ``Version`` attribute on ``<edmx:Edmx>``. Kept because it
            is *not* the OData version below v4 and a reader deserves to see both.
        data_service_version: The ``m:DataServiceVersion`` the service advertises, when
            present. The protocol version, which can differ from the CSDL version.
    """

    version: str
    edm_namespace: Optional[str] = None
    edmx_namespace: Optional[str] = None
    edmx_version: Optional[str] = None
    data_service_version: Optional[str] = None

    @property
    def is_v4(self) -> bool:
        """Whether this document uses the v4 grammar (navigation properties, no associations)."""
        return not uses_association_model(self.version)


def uses_association_model(version: str) -> bool:
    """Whether ``version`` describes relationships with ``Association``/``AssociationSet``.

    Every CSDL generation before 4.0 does; 4.0 replaced them with typed navigation
    properties and inline referential constraints. The parser branches on this rather than
    on an exact version so a 1.x document — which SAP still emits occasionally — reads with
    the same code path as 2.0.

    Args:
        version: A CSDL version string such as ``"2.0"``.

    Returns:
        ``True`` for anything below 4.0, ``False`` for 4.0 and above (and for a version
        string that cannot be read as a number, which is treated as v4 — the generation this
        adapter has always defaulted to).
    """
    head = version.split(".", 1)[0].strip()
    try:
        return int(head) < 4
    except ValueError:
        return False


def resolve_dialect(
    *,
    edmx_namespace: Optional[str],
    edmx_version: Optional[str],
    edm_namespaces: tuple[str, ...],
    data_service_version: Optional[str],
) -> ODataDialect:
    """Decide which CSDL generation a document belongs to.

    The namespaces decide the *generation*; the ``Version`` attribute is trusted for the
    *point release* only once the namespaces have said the document is v4:

    #. the first recognized ``Schema`` (EDM) namespace — the only marker that names the
       generation exactly;
    #. the ``edmx`` wrapper namespace — distinguishes v3 from v1/v2 but not v1 from v2;
    #. once either says v4, the ``Version`` attribute wins if it also names a 4.x version,
       because at v4 that attribute *is* the OData version and is the only thing that tells
       ``4.01`` from ``4.0``. Below v4 it versions the EDMX wrapper — a v2 document says
       ``"1.0"`` — and reading it as an OData version is the mistake this module exists to
       prevent, so a recognized pre-v4 namespace always wins over it;
    #. with no recognized namespace, ``m:DataServiceVersion`` (the protocol version) and
       then the ``Version`` attribute, either of which is better evidence than a guess;
    #. otherwise v4, the generation the adapter has always assumed.

    Args:
        edmx_namespace: Namespace URI of the ``<Edmx>`` root element, if any.
        edmx_version: The root's literal ``Version`` attribute, if any.
        edm_namespaces: Namespace URIs of the document's ``Schema`` elements, in order.
        data_service_version: The ``m:DataServiceVersion`` attribute, if any.

    Returns:
        The resolved :class:`ODataDialect`.
    """
    edm_namespace = next((ns for ns in edm_namespaces if ns in EDM_NAMESPACE_VERSIONS), None)
    if edm_namespace is None:
        edm_namespace = next((ns for ns in edm_namespaces if ns), None)

    declared = (edmx_version or "").strip()
    version = EDM_NAMESPACE_VERSIONS.get(edm_namespace or "") or EDMX_NAMESPACE_VERSIONS.get(
        edmx_namespace or ""
    )
    if version is not None:
        if not uses_association_model(version) and declared.startswith("4"):
            version = declared
    else:
        candidates = [(data_service_version or "").strip(), declared]
        version = next((item for item in candidates if item[:1].isdigit()), None)

    return ODataDialect(
        version=version or _FALLBACK_VERSION,
        edm_namespace=edm_namespace,
        edmx_namespace=edmx_namespace,
        edmx_version=edmx_version,
        data_service_version=data_service_version,
    )


def annotation_key(qualified_attribute: str) -> str:
    """Render an ElementTree attribute name as the key an ``extras`` bag records it under.

    ElementTree hands back ``{namespace-uri}local``; a reader wants ``m:FC_TargetPath`` or
    ``sap:label``. An unrecognized namespace keeps its URI in the key rather than being
    dropped or flattened onto a prefix that would collide.

    Args:
        qualified_attribute: An attribute name as ElementTree reports it.

    Returns:
        The annotation key: ``prefix:local`` for a known namespace, ``{uri}local`` for an
        unknown one, and the name unchanged when it carries no namespace.
    """
    if not qualified_attribute.startswith("{"):
        return qualified_attribute
    uri, _, local = qualified_attribute[1:].partition("}")
    prefix = _ANNOTATION_PREFIXES.get(uri)
    return f"{prefix}:{local}" if prefix else qualified_attribute


#: The format key a v4 — or unrecognized — document detects as. Unchanged since MFI-22.1:
#: every caller that sends ``odata`` as a ``source_kind`` keeps working, and the v4 corpus
#: keeps its recorded detection contract.
DEFAULT_FORMAT_KEY = "odata"

#: CSDL major version → the version-scoped format key detection reports. A generation with
#: no key of its own (1.x) reports :data:`DEFAULT_FORMAT_KEY`; the version itself is still
#: named in the detection *reason* and recorded in the canonical model's provenance, so
#: nothing is lost by not minting a key the adapter does not declare coverage for.
_FORMAT_KEYS_BY_MAJOR: Dict[str, str] = {
    "2": "odata-v2",
    "3": "odata-v3",
}


def detect_odata_version(text: str) -> Optional[str]:
    """Sniff a document's CSDL version from its raw text, without parsing it.

    Detection runs before an adapter is chosen and on input that may be hostile, so this
    never parses XML and never raises — it looks for a known namespace URI as a quoted
    attribute value. Quoting matters: the v3 and v4 EDMX namespaces each contain their
    document's EDM namespace as a plain substring, and an unquoted search would read the
    wrapper's namespace as if a ``Schema`` had declared it.

    Args:
        text: The document text.

    Returns:
        The CSDL version (``"2.0"``, ``"3.0"``, ``"4.0"``, …), or ``None`` when the document
        declares no namespace this module recognizes.
    """
    for table in (EDM_NAMESPACE_VERSIONS, EDMX_NAMESPACE_VERSIONS):
        for namespace, version in table.items():
            if f'"{namespace}"' in text or f"'{namespace}'" in text:
                return version
    return None


def format_key_for_version(version: Optional[str]) -> str:
    """The detection format key that names a CSDL version.

    Args:
        version: A CSDL version string, or ``None`` when the sniff found nothing.

    Returns:
        One of the keys :attr:`app.odata_import_source.ODataImportSource.formats` declares,
        so the result always resolves back to the OData adapter.
    """
    if not version:
        return DEFAULT_FORMAT_KEY
    major = version.split(".", 1)[0].strip()
    return _FORMAT_KEYS_BY_MAJOR.get(major, DEFAULT_FORMAT_KEY)
