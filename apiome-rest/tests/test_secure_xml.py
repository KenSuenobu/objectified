"""Hardened XML intake tests — IXH-1.4 (#5090).

The IXH-1.4 acceptance criterion is per adapter: *"XML adapters resolve no external
entities and expand no DTDs; asserted per adapter."* Every XML-based import source
is therefore driven directly with each hostile construct, so a future adapter that
forgets to route through :mod:`app.secure_xml` fails here rather than shipping an
XXE.

The module-level unit tests pin the guard itself; the parametrized adapter tests
pin the wiring.
"""

from __future__ import annotations

from typing import List, Tuple

import pytest

from app.import_source import (
    DetectionInput,
    ImportSourceError,
    get_import_source,
    load_builtin_import_sources,
)
from app.secure_xml import (
    DEFAULT_MAX_XML_DEPTH,
    SecureXmlError,
    parse_xml,
    xml_tree_depth,
)

load_builtin_import_sources()

#: Every XML-based adapter, with a minimal well-formed document skeleton that its
#: sniffer claims. ``{payload}`` is where each hostile construct is spliced in, and
#: ``{doctype}`` is where a DTD is declared.
XML_ADAPTERS: List[Tuple[str, str]] = [
    (
        "xsd",
        '<?xml version="1.0"?>{doctype}'
        '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">'
        '<xs:annotation><xs:documentation>{payload}</xs:documentation></xs:annotation>'
        '<xs:element name="A" type="xs:string"/></xs:schema>',
    ),
    (
        "wsdl",
        '<?xml version="1.0"?>{doctype}'
        '<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" '
        'xmlns:xs="http://www.w3.org/2001/XMLSchema">'
        "<wsdl:documentation>{payload}</wsdl:documentation>"
        '<wsdl:types><xs:schema><xs:element name="A" type="xs:string"/></xs:schema></wsdl:types>'
        '<wsdl:portType name="P"><wsdl:operation name="O"/></wsdl:portType>'
        "</wsdl:definitions>",
    ),
    (
        "wadl",
        '<?xml version="1.0"?>{doctype}'
        '<application xmlns="http://wadl.dev.java.net/2009/02">'
        '<doc title="D">{payload}</doc>'
        '<resources base="https://api.example.com/"><resource path="a">'
        '<method name="GET" id="a"><response status="200"/></method>'
        "</resource></resources></application>",
    ),
    (
        "odata",
        '<?xml version="1.0"?>{doctype}'
        '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">'
        "<edmx:DataServices>"
        '<Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="N">'
        '<EntityType Name="E"><Key><PropertyRef Name="Id"/></Key>'
        '<Property Name="Id" Type="Edm.String"/><Property Name="X" Type="Edm.String"/>'
        "</EntityType></Schema></edmx:DataServices></edmx:Edmx>",
    ),
    (
        "iso20022",
        '<?xml version="1.0"?>{doctype}'
        '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">'
        "<CstmrCdtTrfInitn><GrpHdr><MsgId>{payload}</MsgId>"
        "<CreDtTm>2026-07-24T12:00:00</CreDtTm><NbOfTxs>1</NbOfTxs>"
        "<InitgPty><Nm>N</Nm></InitgPty></GrpHdr></CstmrCdtTrfInitn></Document>",
    ),
    (
        "xmlrpc",
        '<?xml version="1.0"?>{doctype}'
        "<methodCall><methodName>m</methodName><params><param>"
        "<value><string>{payload}</string></value>"
        "</param></params></methodCall>",
    ),
]

#: A DTD declaring nested entities: the billion-laughs shape.
_EXPANSION_DOCTYPE = (
    "<!DOCTYPE root ["
    '<!ENTITY a "aaaaaaaaaa">'
    '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">'
    '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">'
    "]>"
)

#: A DTD declaring an external entity pointed at a local file.
_EXTERNAL_FILE_DOCTYPE = '<!DOCTYPE root [<!ENTITY ext SYSTEM "file:///etc/passwd">]>'

#: A DTD pointed at a remote resource (the SSRF shape).
_EXTERNAL_SYSTEM_DOCTYPE = '<!DOCTYPE root SYSTEM "http://169.254.169.254/latest/meta-data/">'


def _adapter(key: str):
    return get_import_source(key)


# ---------------------------------------------------------------------------
# The guard itself
# ---------------------------------------------------------------------------


def test_plain_xml_parses():
    root = parse_xml("<a><b>x</b></a>")
    assert root.tag == "a"
    assert xml_tree_depth(root) == 2


def test_dtd_is_rejected():
    with pytest.raises(SecureXmlError) as excinfo:
        parse_xml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


def test_external_entity_is_rejected():
    with pytest.raises(SecureXmlError) as excinfo:
        parse_xml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>')
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


def test_xinclude_directive_is_rejected():
    with pytest.raises(SecureXmlError) as excinfo:
        parse_xml(
            '<a xmlns:xi="http://www.w3.org/2001/XInclude">'
            '<xi:include href="file:///etc/passwd" parse="text"/></a>'
        )
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"
    assert "XInclude" in str(excinfo.value)


def test_oversized_document_is_rejected():
    with pytest.raises(SecureXmlError) as excinfo:
        parse_xml("<a>" + ("x" * 2048) + "</a>", max_bytes=1024)
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_over_deep_document_is_rejected():
    deep = "<a>" * (DEFAULT_MAX_XML_DEPTH + 10) + "x" + "</a>" * (DEFAULT_MAX_XML_DEPTH + 10)
    with pytest.raises(SecureXmlError) as excinfo:
        parse_xml(deep)
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_depth_measurement_is_iterative_not_recursive():
    """Measuring a 50k-deep tree must not itself recurse."""
    root = parse_xml(
        "<a>" * 50_000 + "x" + "</a>" * 50_000, max_depth=100_000, max_bytes=10 * 1024 * 1024
    )
    assert xml_tree_depth(root) == 50_000


def test_malformed_xml_keeps_the_malformed_code():
    with pytest.raises(SecureXmlError) as excinfo:
        parse_xml("<a><b></a>")
    assert excinfo.value.code == "INPUT_MALFORMED"


def test_empty_document_is_rejected():
    with pytest.raises(SecureXmlError) as excinfo:
        parse_xml("   ")
    assert excinfo.value.code == "INPUT_EMPTY"


# ---------------------------------------------------------------------------
# Per-adapter wiring (the acceptance criterion)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("adapter_key", "skeleton"), XML_ADAPTERS, ids=[key for key, _ in XML_ADAPTERS]
)
def test_adapter_expands_no_dtd(adapter_key, skeleton):
    """Entity expansion is refused, and no expanded text reaches the AST."""
    document = skeleton.format(doctype=_EXPANSION_DOCTYPE, payload="&c;")
    with pytest.raises(ImportSourceError) as excinfo:
        _adapter(adapter_key).parse(document)
    assert getattr(excinfo.value, "code", None) == "INPUT_UNSAFE_CONSTRUCT", (
        f"{adapter_key}: expanded or misreported a DTD ({excinfo.value})"
    )
    # 1000 'a's would be the expansion of &c;: it must appear nowhere.
    assert "a" * 1000 not in str(excinfo.value)


@pytest.mark.parametrize(
    ("adapter_key", "skeleton"), XML_ADAPTERS, ids=[key for key, _ in XML_ADAPTERS]
)
def test_adapter_resolves_no_external_file_entity(adapter_key, skeleton):
    """An external entity naming a local file is refused, and the file is not read."""
    document = skeleton.format(doctype=_EXTERNAL_FILE_DOCTYPE, payload="&ext;")
    with pytest.raises(ImportSourceError) as excinfo:
        _adapter(adapter_key).parse(document)
    assert getattr(excinfo.value, "code", None) == "INPUT_UNSAFE_CONSTRUCT", (
        f"{adapter_key}: did not refuse an external entity ({excinfo.value})"
    )
    assert "root:" not in str(excinfo.value), f"{adapter_key}: leaked /etc/passwd content"


@pytest.mark.parametrize(
    ("adapter_key", "skeleton"), XML_ADAPTERS, ids=[key for key, _ in XML_ADAPTERS]
)
def test_adapter_refuses_external_doctype(adapter_key, skeleton):
    """A DOCTYPE pointed at a remote URL is refused without a fetch."""
    document = skeleton.format(doctype=_EXTERNAL_SYSTEM_DOCTYPE, payload="ok")
    with pytest.raises(ImportSourceError) as excinfo:
        _adapter(adapter_key).parse(document)
    assert getattr(excinfo.value, "code", None) == "INPUT_UNSAFE_CONSTRUCT", (
        f"{adapter_key}: did not refuse an external DOCTYPE ({excinfo.value})"
    )


@pytest.mark.parametrize(
    ("adapter_key", "skeleton"), XML_ADAPTERS, ids=[key for key, _ in XML_ADAPTERS]
)
def test_adapter_sniffer_never_raises_on_hostile_input(adapter_key, skeleton):
    """``detect()`` must return a verdict, never raise, on every hostile construct.

    Detection runs before an adapter is chosen, so a raising sniffer turns hostile
    input into an HTTP 5xx on ``POST /v1/import/detect``.
    """
    for doctype in (_EXPANSION_DOCTYPE, _EXTERNAL_FILE_DOCTYPE, _EXTERNAL_SYSTEM_DOCTYPE):
        document = skeleton.format(doctype=doctype, payload="&ext;" if "ENTITY ext" in doctype else "x")
        result = _adapter(adapter_key).detect(
            DetectionInput(text=document, filename=f"hostile.{adapter_key}")
        )
        assert result is not None, f"{adapter_key}: detect returned None"


def test_registry_detection_survives_a_raising_adapter(monkeypatch):
    """Registry-level detection demotes a raising ``detect()`` to a no-match.

    Guards ``POST /v1/import/detect`` against a sniffer bug becoming a 500 — the
    known ``is_fix`` raise is exactly this shape.
    """
    from app import import_source as module

    class _Exploding:
        key = "exploding"

        def detect(self, payload):  # noqa: D401 - test double
            raise RuntimeError("sniffer bug")

    assert module._safe_detect(_Exploding(), DetectionInput(text="x")) is module.NO_MATCH


def test_format_detection_never_raises_on_xml_bombs():
    """The whole detection sweep tolerates every hostile XML construct."""
    from app.format_detection import detect_format

    for _key, skeleton in XML_ADAPTERS:
        for doctype in (_EXPANSION_DOCTYPE, _EXTERNAL_FILE_DOCTYPE, _EXTERNAL_SYSTEM_DOCTYPE):
            document = skeleton.format(doctype=doctype, payload="x")
            detection = detect_format(DetectionInput(text=document, filename="hostile.xml"))
            assert detection is not None
