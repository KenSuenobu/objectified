"""WSDL 2.0 import — FMT-3.3 (#5428).

The WSDL adapter read 1.1 only. WSDL 2.0 renamed almost the whole vocabulary
(``description``/``interface``/``endpoint`` for ``definitions``/``portType``/``port``),
deleted the ``message`` element so an operation names its payload element directly, and put
the transmission primitive on the operation as a message exchange pattern URI — so a 2.0
document either failed to parse or was mis-read. This suite pins the four acceptance
criteria of that ticket:

#. a 2.0 document is detected as WSDL **with its version recorded**, and normalizes to the
   same canonical shape a semantically equivalent 1.1 document produces;
#. every MEP maps to the right :class:`~app.canonical_model.OperationKind`;
#. a 1.1 document's behaviour is unchanged — asserted here from both sides (no version
   extras key, no MEP on a 1.1 operation) and proven wholesale by the committed 1.1
   goldens, which this change leaves byte-identical;
#. the negative corpus covers a 2.0 document with an unresolvable interface reference.

Fixtures are selected through :mod:`tests.corpus_loader` by manifest tag rather than by
path, so a corpus rename cannot silently re-point an assertion at a different document.
"""

from __future__ import annotations

from typing import Dict, List

import pytest
from corpus_loader import ValidityClass, load_corpus, unique_corpus_entry

from app.canonical_model import CanonicalApi, OperationKind
from app.fileset import IntakeFileset
from app.format_lint_capabilities import normalize_format_key
from app.import_source import DetectionInput, ImportSourceError
from app.wsdl_import_source import WsdlImportSource
from app.wsdl_normalizer import WsdlNormalizer
from app.wsdl_parser import WsdlParseError, is_wsdl, parse_wsdl
from app.wsdl_versions import (
    MEP_IN_ONLY,
    MEP_IN_OPT_OUT,
    MEP_IN_OUT,
    MEP_OUT_IN,
    MEP_OUT_ONLY,
    MEP_OUT_OPT_IN,
    MEP_ROBUST_IN_ONLY,
    MEP_ROBUST_OUT_ONLY,
    VERSION_1_1,
    VERSION_2_0,
    detect_wsdl_version,
    format_key_for_version,
    operation_kind_for_pattern,
)


@pytest.fixture()
def adapter() -> WsdlImportSource:
    return WsdlImportSource()


def _text(*features: str) -> str:
    """The one valid 2.0 corpus fixture carrying every given feature tag."""
    return unique_corpus_entry(format="wsdl2", features=features).read_text()


def _negative(failure_class: str) -> str:
    """The one 2.0 negative fixture in a given failure class."""
    matches = [
        entry
        for entry in load_corpus(format="wsdl2", validity_class=ValidityClass.INVALID)
        if entry.failure_class is not None and entry.failure_class.value == failure_class
    ]
    assert len(matches) == 1, f"{failure_class}: expected one fixture, got {matches}"
    return matches[0].read_text()


def _normalize(text: str) -> CanonicalApi:
    """Parse and normalize one document, without the raw copy."""
    return WsdlNormalizer().normalize(parse_wsdl(text), include_raw=False)


def _shape(api: CanonicalApi) -> Dict[str, object]:
    """The comparable canonical shape of an API: services, operations, payloads, types.

    Identity, servers and the version provenance key are excluded: they are the parts a 1.1
    and a 2.0 spelling of the same service are *expected* to differ in (a ``description``
    has no ``name`` attribute, and the version key is the thing being recorded).
    """
    return {
        "services": [
            {
                "name": service.name,
                "operations": [
                    {
                        "name": operation.name,
                        "kind": operation.kind.value,
                        "messages": [
                            (message.role.value, message.payload.name if message.payload else None)
                            for message in operation.messages
                        ],
                    }
                    for operation in service.operations
                ],
            }
            for service in api.services
        ],
        "types": [
            {
                "name": type_.name,
                "fields": [(field.name, field.type.name) for field in type_.fields],
            }
            for type_ in api.types
        ],
    }


# ---------------------------------------------------------------------------
# AC 1 — detection, version provenance, and 1.1/2.0 canonical equivalence
# ---------------------------------------------------------------------------


def test_detect_reports_the_two_dot_zero_format_key(adapter: WsdlImportSource):
    result = adapter.detect(DetectionInput(text=_text("interface", "in-out", "endpoint")))
    assert result.matched
    assert result.format == "wsdl-2.0"
    assert result.confidence >= 0.95
    assert "2.0" in result.reason


def test_detect_still_reports_the_family_key_for_one_dot_one(adapter: WsdlImportSource):
    [calculator] = [
        entry for entry in load_corpus(format="wsdl", rung="minimal") if entry.rung is not None
    ]
    result = adapter.detect(DetectionInput(text=calculator.read_text()))
    assert result.format == "wsdl"


def test_detect_falls_back_to_the_family_key_for_a_filename_only_claim(
    adapter: WsdlImportSource,
):
    result = adapter.detect(DetectionInput(text=None, filename="service.wsdl"))
    assert result.matched
    assert result.format == "wsdl"


def test_version_is_sniffed_from_the_namespace_not_the_root_name():
    assert detect_wsdl_version(_text("interface", "in-out", "endpoint")) == VERSION_2_0
    assert detect_wsdl_version('<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"/>')\
        == VERSION_1_1
    # A `description` root in some other dialect is not WSDL 2.0.
    assert detect_wsdl_version('<description xmlns="http://example.com/other"/>') is None


def test_format_key_for_version_maps_each_grammar():
    assert format_key_for_version(VERSION_2_0) == "wsdl-2.0"
    assert format_key_for_version(VERSION_1_1) == "wsdl"
    assert format_key_for_version(None) == "wsdl"


def test_adapter_declares_both_grammars_as_version_coverage(adapter: WsdlImportSource):
    assert adapter.formats[0] == "wsdl"
    assert "wsdl-2.0" in adapter.formats


def test_two_dot_zero_import_records_its_version():
    api = _normalize(_text("interface", "in-out", "endpoint"))
    assert api.extras["wsdl_version"] == VERSION_2_0
    assert api.format == "wsdl"
    assert api.protocol == "soap"


def test_the_version_key_is_absent_from_a_one_dot_one_import():
    [calculator] = [entry for entry in load_corpus(format="wsdl", rung="minimal")]
    assert "wsdl_version" not in _normalize(calculator.read_text()).extras


_EQUIVALENT_1_1 = """<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions name="EchoService"
    targetNamespace="http://example.com/echo"
    xmlns:tns="http://example.com/echo"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">
  <wsdl:types>
    <xsd:schema targetNamespace="http://example.com/echo">
      <xsd:complexType name="EchoRequest">
        <xsd:sequence>
          <xsd:element name="text" type="xsd:string"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:complexType name="EchoResponse">
        <xsd:sequence>
          <xsd:element name="text" type="xsd:string"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:element name="echo" type="tns:EchoRequest"/>
      <xsd:element name="echoResult" type="tns:EchoResponse"/>
    </xsd:schema>
  </wsdl:types>
  <wsdl:message name="EchoIn">
    <wsdl:part name="parameters" element="tns:echo"/>
  </wsdl:message>
  <wsdl:message name="EchoOut">
    <wsdl:part name="parameters" element="tns:echoResult"/>
  </wsdl:message>
  <wsdl:portType name="EchoPort">
    <wsdl:operation name="echo">
      <wsdl:input message="tns:EchoIn"/>
      <wsdl:output message="tns:EchoOut"/>
    </wsdl:operation>
  </wsdl:portType>
</wsdl:definitions>
"""

_EQUIVALENT_2_0 = """<?xml version="1.0" encoding="UTF-8"?>
<description xmlns="http://www.w3.org/ns/wsdl"
             xmlns:tns="http://example.com/echo"
             xmlns:xs="http://www.w3.org/2001/XMLSchema"
             targetNamespace="http://example.com/echo">
  <types>
    <xs:schema targetNamespace="http://example.com/echo">
      <xs:complexType name="EchoRequest">
        <xs:sequence>
          <xs:element name="text" type="xs:string"/>
        </xs:sequence>
      </xs:complexType>
      <xs:complexType name="EchoResponse">
        <xs:sequence>
          <xs:element name="text" type="xs:string"/>
        </xs:sequence>
      </xs:complexType>
      <xs:element name="echo" type="tns:EchoRequest"/>
      <xs:element name="echoResult" type="tns:EchoResponse"/>
    </xs:schema>
  </types>
  <interface name="EchoPort">
    <operation name="echo" pattern="http://www.w3.org/ns/wsdl/in-out">
      <input messageLabel="In" element="tns:echo"/>
      <output messageLabel="Out" element="tns:echoResult"/>
    </operation>
  </interface>
</description>
"""


def test_equivalent_documents_normalize_to_the_same_canonical_shape():
    """The headline claim: the grammar a service is written in does not reach the model."""
    assert _shape(_normalize(_EQUIVALENT_2_0)) == _shape(_normalize(_EQUIVALENT_1_1))


def test_the_two_documents_differ_only_where_the_grammars_do():
    one_one = _normalize(_EQUIVALENT_1_1)
    two_zero = _normalize(_EQUIVALENT_2_0)
    assert one_one.identity.namespace == two_zero.identity.namespace
    # `definitions` carries a name; `description` has none and no service to fall back on,
    # so the interface names the API.
    assert one_one.identity.name == "EchoService"
    assert two_zero.identity.name == "EchoPort"


# ---------------------------------------------------------------------------
# AC 2 — message exchange patterns
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("pattern", "expected"),
    [
        (MEP_IN_OUT, OperationKind.REQUEST_RESPONSE),
        (MEP_IN_OPT_OUT, OperationKind.REQUEST_RESPONSE),
        (MEP_OUT_IN, OperationKind.REQUEST_RESPONSE),
        (MEP_OUT_OPT_IN, OperationKind.REQUEST_RESPONSE),
        (MEP_IN_ONLY, OperationKind.ONE_WAY),
        (MEP_ROBUST_IN_ONLY, OperationKind.ONE_WAY),
        (MEP_OUT_ONLY, OperationKind.PUBLISH),
        (MEP_ROBUST_OUT_ONLY, OperationKind.PUBLISH),
    ],
)
def test_every_mep_maps_to_an_operation_kind(pattern: str, expected: OperationKind):
    assert operation_kind_for_pattern(pattern) is expected


def test_an_absent_or_unknown_pattern_degrades_to_request_response():
    assert operation_kind_for_pattern(None) is OperationKind.REQUEST_RESPONSE
    assert operation_kind_for_pattern("") is OperationKind.REQUEST_RESPONSE
    assert operation_kind_for_pattern("urn:vendor:mep:weird") is OperationKind.REQUEST_RESPONSE


def test_the_mep_stress_fixture_normalizes_each_pattern():
    api = _normalize(_text("in-out", "in-only", "robust-in-only", "in-opt-out", "out-only"))
    [service] = api.services
    kinds = {operation.name: operation.kind for operation in service.operations}
    assert kinds == {
        "inOut": OperationKind.REQUEST_RESPONSE,
        "inOnly": OperationKind.ONE_WAY,
        "robustInOnly": OperationKind.ONE_WAY,
        "inOptionalOut": OperationKind.REQUEST_RESPONSE,
        "outOnly": OperationKind.PUBLISH,
    }


# ---------------------------------------------------------------------------
# AC 3 — WSDL 1.1 is untouched
# ---------------------------------------------------------------------------


def test_a_one_dot_one_operation_carries_no_pattern():
    """The seam from the parser side: 1.1 has no MEP vocabulary, so nothing to read."""
    document = parse_wsdl(_EQUIVALENT_1_1)
    assert document.version == VERSION_1_1
    assert all(
        operation.pattern is None and operation.input_element is None
        for port_type in document.port_types
        for operation in port_type.operations
    )


def test_a_two_dot_zero_operation_carries_no_message_reference():
    """And the mirror: 2.0 has no `message` element, so the 1.1 fields stay empty."""
    document = parse_wsdl(_EQUIVALENT_2_0)
    assert document.version == VERSION_2_0
    assert document.messages == ()
    assert all(
        operation.input_message is None and operation.output_message is None
        for port_type in document.port_types
        for operation in port_type.operations
    )


def test_lint_capability_folds_the_version_key_onto_the_family():
    assert normalize_format_key("wsdl-2.0") == "wsdl"
    assert normalize_format_key("wsdl") == "wsdl"
    assert normalize_format_key("soap") == "wsdl"


# ---------------------------------------------------------------------------
# AC 4 — negatives
# ---------------------------------------------------------------------------


def test_an_unresolvable_interface_reference_is_reported_as_such(adapter: WsdlImportSource):
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative("unresolvable-ref"))
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "MissingInterface" in str(excinfo.value)


def test_a_two_dot_zero_document_with_no_interface_is_semantically_invalid(
    adapter: WsdlImportSource,
):
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative("semantic"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_bare_schema_is_not_claimed_as_wsdl(adapter: WsdlImportSource):
    text = _negative("wrong-format")
    assert is_wsdl(text) is False
    payload = DetectionInput(text=text, filename="04-wrong-format-xsd.xsd")
    assert adapter.detect(payload).matched is False


def test_a_two_dot_zero_root_in_a_one_dot_one_namespace_is_rejected():
    with pytest.raises(WsdlParseError, match="root element must be `definitions`"):
        parse_wsdl(
            '<description xmlns="http://schemas.xmlsoap.org/wsdl/" '
            'xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"><wsdl:definitions/></description>'
        )


# ---------------------------------------------------------------------------
# Grammar details the 2.0 corpus exercises
# ---------------------------------------------------------------------------


def test_interface_extension_flattens_inherited_operations():
    api = _normalize(_text("interface-extends", "inherited-operations"))
    by_name = {service.name: service for service in api.services}
    assert [op.name for op in by_name["ReadCatalogue"].operations] == ["getProduct"]
    # The derived interface exposes both its own operation and the inherited one.
    assert [op.name for op in by_name["ReadWriteCatalogue"].operations] == [
        "getProduct",
        "upsertProduct",
    ]


_EXTENDS_CYCLE = """<?xml version="1.0" encoding="UTF-8"?>
<description xmlns="http://www.w3.org/ns/wsdl"
             xmlns:tns="http://example.com/loop"
             targetNamespace="http://example.com/loop">
  <interface name="A" extends="tns:B">
    <operation name="a" pattern="http://www.w3.org/ns/wsdl/in-only"/>
  </interface>
  <interface name="B" extends="tns:A">
    <operation name="b" pattern="http://www.w3.org/ns/wsdl/in-only"/>
  </interface>
</description>
"""


def test_an_extends_cycle_terminates_instead_of_recursing():
    document = parse_wsdl(_EXTENDS_CYCLE)
    by_name = {port_type.name: port_type for port_type in document.port_types}
    assert {op.name for op in by_name["A"].operations} == {"a", "b"}
    assert {op.name for op in by_name["B"].operations} == {"a", "b"}


_EXTENDS_OVERRIDE = """<?xml version="1.0" encoding="UTF-8"?>
<description xmlns="http://www.w3.org/ns/wsdl"
             xmlns:tns="http://example.com/override"
             targetNamespace="http://example.com/override">
  <interface name="Base">
    <operation name="run" pattern="http://www.w3.org/ns/wsdl/in-only"/>
  </interface>
  <interface name="Derived" extends="tns:Base">
    <operation name="run" pattern="http://www.w3.org/ns/wsdl/in-out"/>
  </interface>
</description>
"""


def test_a_redeclared_operation_overrides_the_inherited_one():
    document = parse_wsdl(_EXTENDS_OVERRIDE)
    derived = next(pt for pt in document.port_types if pt.name == "Derived")
    assert [op.pattern for op in derived.operations] == [MEP_IN_OUT]


def test_anonymous_inline_types_are_named_after_their_element():
    api = _normalize(_text("interface", "faults", "in-only", "inline-schema"))
    names = {type_.name for type_ in api.types}
    # `<xs:element name="order"><xs:complexType>` becomes the type `order` ...
    assert {"order", "getOrder", "placeOrder"} <= names
    # ... and a complex type nested one level deeper is named for its path.
    assert "orderLine" in names
    order = next(type_ for type_ in api.types if type_.name == "order")
    assert ("line", "http://example.com/orders.orderLine") in [
        (field.name, field.type.name) for field in order.fields
    ]


_ANONYMOUS_COLLISION = """<?xml version="1.0" encoding="UTF-8"?>
<description xmlns="http://www.w3.org/ns/wsdl"
             xmlns:tns="http://example.com/clash"
             xmlns:xs="http://www.w3.org/2001/XMLSchema"
             targetNamespace="http://example.com/clash">
  <types>
    <xs:schema targetNamespace="http://example.com/clash">
      <xs:complexType name="order">
        <xs:sequence>
          <xs:element name="declared" type="xs:string"/>
        </xs:sequence>
      </xs:complexType>
      <xs:element name="order">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="inline" type="xs:string"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:schema>
  </types>
  <interface name="ClashInterface">
    <operation name="place" pattern="http://www.w3.org/ns/wsdl/in-only">
      <input messageLabel="In" element="tns:order"/>
    </operation>
  </interface>
</description>
"""


def test_an_anonymous_type_never_overwrites_a_declared_one_of_the_same_name():
    document = parse_wsdl(_ANONYMOUS_COLLISION)
    by_name = {type_.name: type_ for type_ in document.complex_types}
    assert [field.name for field in by_name["order"].fields] == ["declared"]
    assert [field.name for field in by_name["orderType"].fields] == ["inline"]


def test_nested_anonymous_fields_are_not_flattened_into_their_parent():
    document = parse_wsdl(_text("interface", "faults", "in-only", "inline-schema"))
    order = next(type_ for type_ in document.complex_types if type_.name == "order")
    assert [field.name for field in order.fields] == [
        "orderId",
        "customerId",
        "total",
        "line",
    ]


# ---------------------------------------------------------------------------
# Multi-file sets
# ---------------------------------------------------------------------------


def _imported_set() -> IntakeFileset:
    """The 2.0 multi-file corpus set, assembled as intake would hand it over."""
    entries = load_corpus(format="wsdl2", feature="multi-file")
    members = {entry.path.rsplit("/", 1)[-1]: entry.read_text() for entry in entries}
    [root] = [entry for entry in entries if entry.fileset_role is not None
              and entry.fileset_role.value == "root"]
    return IntakeFileset.from_members(members, root=root.path.rsplit("/", 1)[-1])


def test_a_schema_import_resolves_against_the_sets_members(adapter: WsdlImportSource):
    api = adapter.normalize(adapter.parse_fileset(_imported_set()), include_raw=False)
    assert {type_.name for type_ in api.types} == {"getInvoice", "invoice"}
    [service] = api.services
    [operation] = service.operations
    payloads = [message.payload.name for message in operation.messages]
    assert payloads == [
        "http://example.com/billing.getInvoice",
        "http://example.com/billing.invoice",
    ]


def test_the_same_root_parsed_alone_has_no_types(adapter: WsdlImportSource):
    """The set is what makes the import whole — the waiver this replaced said otherwise."""
    fileset = _imported_set()
    document = adapter.parse(fileset.root_content())
    assert document.complex_types == ()
    assert [port_type.name for port_type in document.port_types] == ["BillingInterface"]


def test_an_unresolvable_schema_location_leaves_the_document_importable(
    adapter: WsdlImportSource,
):
    fileset = _imported_set()
    trimmed = IntakeFileset.from_members(
        {fileset.root: fileset.root_content()}, root=fileset.root
    )
    document = adapter.parse_fileset(trimmed)
    assert document.complex_types == ()
    assert document.port_types


# ---------------------------------------------------------------------------
# Corpus contract
# ---------------------------------------------------------------------------


def test_every_two_dot_zero_corpus_entry_is_owned_by_the_wsdl_adapter():
    entries = load_corpus(format="wsdl2")
    assert entries, "the wsdl2 corpus directory has no manifest entries"
    assert {entry.adapter_key for entry in entries} == {"wsdl"}
    assert not any("pending-adapter" in entry.features for entry in entries)


def test_the_two_dot_zero_corpus_covers_the_meps_the_ticket_names():
    features: List[str] = [
        feature
        for entry in load_corpus(format="wsdl2", validity_class=ValidityClass.VALID)
        for feature in entry.features
    ]
    assert {"in-out", "in-only", "robust-in-only", "in-opt-out"} <= set(features)


# ---------------------------------------------------------------------------
# XSD shapes the shared reader has to survive in either grammar
# ---------------------------------------------------------------------------

_DERIVED_AND_NESTED_PARTICLES = """<?xml version="1.0" encoding="UTF-8"?>
<description xmlns="http://www.w3.org/ns/wsdl"
             xmlns:tns="http://example.com/shapes"
             xmlns:xs="http://www.w3.org/2001/XMLSchema"
             targetNamespace="http://example.com/shapes">
  <types>
    <xs:schema targetNamespace="http://example.com/shapes">
      <xs:complexType name="Base">
        <xs:sequence>
          <xs:element name="id" type="xs:string"/>
        </xs:sequence>
      </xs:complexType>
      <xs:complexType name="Derived">
        <xs:complexContent>
          <xs:extension base="tns:Base">
            <xs:sequence>
              <xs:element name="extra" type="xs:string"/>
              <xs:choice>
                <xs:element name="either" type="xs:string"/>
                <xs:element name="or" type="xs:int"/>
              </xs:choice>
            </xs:sequence>
          </xs:extension>
        </xs:complexContent>
      </xs:complexType>
    </xs:schema>
  </types>
  <interface name="ShapeInterface">
    <operation name="noop" pattern="http://www.w3.org/ns/wsdl/in-only"/>
  </interface>
</description>
"""


def test_a_derived_type_reports_the_fields_it_declares():
    """`<complexContent><extension>` stands between the type and its particle group."""
    document = parse_wsdl(_DERIVED_AND_NESTED_PARTICLES)
    derived = next(type_ for type_ in document.complex_types if type_.name == "Derived")
    assert [field.name for field in derived.fields] == ["extra", "either", "or"]


def test_a_particle_nested_in_another_particle_still_yields_its_fields():
    document = parse_wsdl(_DERIVED_AND_NESTED_PARTICLES)
    derived = next(type_ for type_ in document.complex_types if type_.name == "Derived")
    assert ("or", "int") in [(field.name, field.type_expr) for field in derived.fields]


_ONE_ONE_QUOTING_THE_TWO_ZERO_NAMESPACE = """<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions name="LegacyService"
    targetNamespace="http://example.com/legacy"
    xmlns:tns="http://example.com/legacy"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">
  <wsdl:documentation>
    Not yet migrated to http://www.w3.org/ns/wsdl — see the 2.0 spec.
  </wsdl:documentation>
  <wsdl:types>
    <xsd:schema targetNamespace="http://example.com/legacy">
      <xsd:complexType name="Ping"><xsd:sequence/></xsd:complexType>
    </xsd:schema>
  </wsdl:types>
  <wsdl:portType name="LegacyPort">
    <wsdl:operation name="ping"/>
  </wsdl:portType>
</wsdl:definitions>
"""


def test_the_parsed_roots_namespace_beats_a_mention_in_the_prose():
    """The sniff sees the 2.0 URI in the documentation; the root element does not lie."""
    assert detect_wsdl_version(_ONE_ONE_QUOTING_THE_TWO_ZERO_NAMESPACE) == VERSION_2_0
    document = parse_wsdl(_ONE_ONE_QUOTING_THE_TWO_ZERO_NAMESPACE)
    assert document.version == VERSION_1_1
    assert document.name == "LegacyService"
