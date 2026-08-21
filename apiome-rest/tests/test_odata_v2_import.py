"""OData v2 / v3 CSDL import — FMT-3.4 (#5429).

The OData adapter read v4 EDMX only. SAP Gateway and older Dynamics deployments emit v2 or
v3, whose CSDL uses different namespaces and describes relationships with
``Association``/``AssociationSet`` instead of typed navigation properties. This suite pins
the four acceptance criteria of that ticket:

#. v2, v3 and v4 documents all import **and record their version**;
#. associations normalize to the same canonical relationships v4 navigation properties do;
#. a v4 document's canonical model is **unchanged** — proven here by asserting that none of
   the new extras keys appear on a v4 import, and by the committed v4 goldens elsewhere;
#. the corpus carries an SAP-shaped v2 metadata document, and it imports.

Fixtures are selected through :mod:`tests.corpus_loader` by manifest tag rather than by
path, so a corpus rename cannot silently re-point an assertion at a different document.
"""

from __future__ import annotations

from typing import Dict

import pytest
from corpus_loader import ValidityClass, load_corpus, unique_corpus_entry

from app.canonical_model import ApiParadigm
from app.emitter import get_emitter
from app.fileset import IntakeFileset
from app.import_source import DetectionInput, ImportSourceError
from app.odata_associations import (
    ODataAssociation,
    ODataAssociationEnd,
    ODataUnresolvedRelationshipError,
    association_index,
    navigation_type_expr,
    resolve_target_end,
)
from app.odata_csdl_versions import (
    ODATA_V4_EDM_NS,
    ODATA_V4_EDMX_NS,
    annotation_key,
    detect_odata_version,
    format_key_for_version,
    resolve_dialect,
    uses_association_model,
)
from app.odata_import_source import ODataImportSource
from app.odata_normalizer import ODataNormalizer
from app.odata_parser import ODataParseError, parse_odata

_V2_EDMX_NS = "http://schemas.microsoft.com/ado/2007/06/edmx"
_V2_EDM_NS = "http://schemas.microsoft.com/ado/2008/09/edm"
_V3_EDMX_NS = "http://schemas.microsoft.com/ado/2009/11/edmx"
_V3_EDM_NS = "http://schemas.microsoft.com/ado/2009/11/edm"


@pytest.fixture()
def adapter() -> ODataImportSource:
    return ODataImportSource()


def _text(*features: str) -> str:
    """The one v2/v3 corpus fixture carrying every given feature tag."""
    return unique_corpus_entry(format="odata-v2", features=features).read_text()


def _negative(failure_class: str) -> str:
    """The one v2/v3 negative fixture in a given failure class."""
    matches = [
        entry
        for entry in load_corpus(format="odata-v2", validity_class=ValidityClass.INVALID)
        if entry.failure_class is not None and entry.failure_class.value == failure_class
    ]
    assert len(matches) == 1, f"{failure_class}: expected one fixture, got {matches}"
    return matches[0].read_text()


def _model_extras(text: str) -> Dict[str, object]:
    """Normalize a document and return its canonical ``extras`` bag."""
    return ODataNormalizer().normalize(parse_odata(text), include_raw=False).extras


# ---------------------------------------------------------------------------
# Dialect resolution — the namespace table
# ---------------------------------------------------------------------------


def test_resolve_dialect_reads_the_version_from_the_edm_namespace():
    dialect = resolve_dialect(
        edmx_namespace=_V2_EDMX_NS,
        edmx_version="1.0",
        edm_namespaces=(_V2_EDM_NS,),
        data_service_version="2.0",
    )
    assert dialect.version == "2.0"
    assert dialect.edmx_version == "1.0"
    assert dialect.is_v4 is False


def test_resolve_dialect_never_reads_the_edmx_version_attribute_as_the_odata_version():
    """A v2 document says ``Version="1.0"`` — that versions the wrapper, not the service."""
    dialect = resolve_dialect(
        edmx_namespace=_V2_EDMX_NS,
        edmx_version="1.0",
        edm_namespaces=(),
        data_service_version=None,
    )
    assert dialect.version == "2.0"


def test_resolve_dialect_keeps_a_v4_point_release_from_the_version_attribute():
    """At v4 the ``Version`` attribute *is* the OData version — and the only thing that
    tells 4.01 from 4.0. Below v4 a recognized namespace always outranks it."""
    assert (
        resolve_dialect(
            edmx_namespace=ODATA_V4_EDMX_NS,
            edmx_version="4.01",
            edm_namespaces=(ODATA_V4_EDM_NS,),
            data_service_version=None,
        ).version
        == "4.01"
    )
    assert (
        resolve_dialect(
            edmx_namespace=_V2_EDMX_NS,
            edmx_version="4.0",
            edm_namespaces=(_V2_EDM_NS,),
            data_service_version="2.0",
        ).version
        == "2.0"
    )


def test_resolve_dialect_falls_back_through_edmx_namespace_then_protocol_version():
    assert (
        resolve_dialect(
            edmx_namespace=_V3_EDMX_NS,
            edmx_version=None,
            edm_namespaces=("urn:unknown",),
            data_service_version=None,
        ).version
        == "3.0"
    )
    assert (
        resolve_dialect(
            edmx_namespace=None,
            edmx_version=None,
            edm_namespaces=(),
            data_service_version="2.0",
        ).version
        == "2.0"
    )


def test_resolve_dialect_defaults_to_v4_when_nothing_is_recognizable():
    dialect = resolve_dialect(
        edmx_namespace=None, edmx_version=None, edm_namespaces=(), data_service_version=None
    )
    assert dialect.version == "4.0"
    assert dialect.is_v4 is True


@pytest.mark.parametrize(
    ("version", "legacy"),
    [("1.0", True), ("2.0", True), ("3.0", True), ("4.0", False), ("4.01", False), ("", False)],
)
def test_uses_association_model_splits_at_v4(version: str, legacy: bool):
    assert uses_association_model(version) is legacy


def test_annotation_key_renders_known_prefixes_and_keeps_unknown_uris():
    assert (
        annotation_key(
            "{http://schemas.microsoft.com/ado/2007/08/dataservices/metadata}FC_TargetPath"
        )
        == "m:FC_TargetPath"
    )
    assert annotation_key("{http://www.sap.com/Protocols/SAPData}label") == "sap:label"
    assert annotation_key("{urn:vendor:x}Thing") == "{urn:vendor:x}Thing"
    assert annotation_key("MaxLength") == "MaxLength"


# ---------------------------------------------------------------------------
# Version sniffing — runs on hostile input, so it must never parse or raise
# ---------------------------------------------------------------------------


def test_detect_odata_version_matches_quoted_namespaces_only():
    """The v3/v4 EDMX namespaces contain their EDM namespace as a plain substring.

    An unquoted search would read the wrapper's namespace as a ``Schema`` declaration; the
    v3 case would still land on 3.0 by luck, but a document that declares *only* the v4
    wrapper must not be read as if a schema had spoken.
    """
    assert detect_odata_version(f'<edmx:Edmx xmlns:edmx="{_V3_EDMX_NS}"/>') == "3.0"
    assert detect_odata_version(f"<edmx:Edmx xmlns:edmx='{ODATA_V4_EDMX_NS}'/>") == "4.0"
    assert detect_odata_version(f'<Schema xmlns="{ODATA_V4_EDM_NS}"/>') == "4.0"
    assert detect_odata_version(f"mentions {_V2_EDM_NS} unquoted") is None
    assert detect_odata_version("") is None


def test_detect_odata_version_reads_the_shipped_fixtures():
    assert detect_odata_version(_text("v2", "FC-TargetPath")) == "2.0"
    assert detect_odata_version(_text("v3", "IsSideEffecting")) == "3.0"


@pytest.mark.parametrize(
    ("version", "key"),
    [(None, "odata"), ("2.0", "odata-v2"), ("3.0", "odata-v3"), ("4.0", "odata"), ("1.1", "odata")],
)
def test_format_key_for_version_only_names_declared_keys(version, key):
    assert format_key_for_version(version) == key
    assert key in ODataImportSource.formats


# ---------------------------------------------------------------------------
# Association → navigation projection
# ---------------------------------------------------------------------------


def _customer_orders() -> ODataAssociation:
    return ODataAssociation(
        name="CustomerOrders",
        namespace="NS",
        ends=(
            ODataAssociationEnd(role="Customer", type_expr="NS.Customer", multiplicity="1"),
            ODataAssociationEnd(role="Order", type_expr="NS.Order", multiplicity="*"),
        ),
    )


def test_resolve_target_end_picks_the_end_the_traversal_lands_on():
    association = _customer_orders()
    to_many = resolve_target_end(association, from_role="Customer", to_role="Order")
    assert (to_many.type_expr, navigation_type_expr(to_many)) == (
        "NS.Order",
        "Collection(NS.Order)",
    )
    to_one = resolve_target_end(association, from_role="Order", to_role="Customer")
    assert navigation_type_expr(to_one) == "NS.Customer"


def test_resolve_target_end_recovers_a_missing_to_role_on_a_binary_association():
    end = resolve_target_end(_customer_orders(), from_role="Customer", to_role=None)
    assert end.role == "Order"


def test_resolve_target_end_refuses_to_guess_on_a_wider_association():
    tripartite = ODataAssociation(
        name="CustomerOrders",
        namespace="NS",
        ends=(
            *_customer_orders().ends,
            ODataAssociationEnd(role="Broker", type_expr="NS.Broker", multiplicity="0..1"),
        ),
    )
    with pytest.raises(ODataUnresolvedRelationshipError):
        resolve_target_end(tripartite, from_role="Customer", to_role=None)
    with pytest.raises(ODataUnresolvedRelationshipError):
        resolve_target_end(tripartite, from_role="Order", to_role="Shipper")


def test_a_v2_document_projects_both_directions_of_one_association():
    """The v4 spelling, derived: a to-many end becomes ``Collection(...)`` and each side's
    ``Partner`` is the property pointing back along the same association."""
    schema = parse_odata(_text("v2", "compound-key")).schemas[0]
    by_name = {entity.name: entity for entity in schema.entity_types}

    orders = by_name["Customer"].navigation_properties[0]
    assert (orders.name, orders.type_expr, orders.partner, orders.multiplicity) == (
        "Orders",
        "Collection(Northbound.Orders.Order)",
        "Customer",
        "*",
    )
    customer = next(
        item for item in by_name["Order"].navigation_properties if item.name == "Customer"
    )
    assert (customer.type_expr, customer.partner, customer.multiplicity) == (
        "Northbound.Orders.Customer",
        "Orders",
        "1",
    )


def test_a_traversal_whose_target_declares_no_inverse_has_no_partner():
    schema = parse_odata(_text("v2", "compound-key")).schemas[0]
    order = next(entity for entity in schema.entity_types if entity.name == "Order")
    items = next(item for item in order.navigation_properties if item.name == "Items")
    assert items.type_expr == "Collection(Northbound.Orders.Item)"
    assert items.partner is None, "Item declares no navigation property back to Order"


def test_v4_navigation_properties_are_left_exactly_as_declared():
    for entry in load_corpus(format="odata", validity_class=ValidityClass.VALID):
        for schema in parse_odata(entry.read_text()).schemas:
            for entity in schema.entity_types:
                for navigation in entity.navigation_properties:
                    assert navigation.relationship is None, entry.path
                    assert navigation.multiplicity is None, entry.path
                    assert navigation.type_expr, entry.path


def test_association_index_registers_a_bare_name_only_when_unambiguous():
    other = ODataAssociation(
        name="CustomerOrders",
        namespace="Other",
        ends=_customer_orders().ends,
    )
    assert "CustomerOrders" in association_index([_customer_orders()])
    ambiguous = association_index([_customer_orders(), other])
    assert "CustomerOrders" not in ambiguous
    assert set(ambiguous) == {"NS.CustomerOrders", "Other.CustomerOrders"}


# ---------------------------------------------------------------------------
# Parsing the shipped v2/v3 corpus
# ---------------------------------------------------------------------------


def test_v2_and_v3_documents_record_their_version():
    assert parse_odata(_text("v2", "EntityType", "EntitySet")).version == "2.0"
    assert parse_odata(_text("v3", "BaseType")).version == "3.0"
    v4 = load_corpus(format="odata", validity_class=ValidityClass.VALID)[0]
    assert parse_odata(v4.read_text()).version == "4.0"


def test_v2_associations_and_referential_constraints_are_parsed():
    schema = parse_odata(_text("v2", "compound-key")).schemas[0]
    by_name = {association.name: association for association in schema.associations}
    assert set(by_name) == {"CustomerOrders", "OrderItems"}

    constraint = by_name["CustomerOrders"].referential_constraints[0]
    assert constraint.principal_role == "Customer"
    assert constraint.principal_properties == ("CustomerId",)
    assert constraint.dependent_properties == ("CustomerId",)

    container = schema.entity_container
    assert {item.name for item in container.association_sets} == {
        "CustomerOrdersSet",
        "OrderItemsSet",
    }
    cancel = next(item for item in container.function_imports if item.name == "CancelOrder")
    assert cancel.return_type == "Northbound.Orders.Order"
    assert [parameter.name for parameter in cancel.parameters] == ["OrderId", "Reason"]
    assert dict(cancel.annotations)["m:HttpMethod"] == "POST"


def test_customizable_feed_annotations_survive_on_the_property():
    """``FC_TargetPath`` has no v4 analogue, so it must land in extras, not be discarded."""
    schema = parse_odata(_text("v2", "FC-TargetPath")).schemas[0]
    article = next(entity for entity in schema.entity_types if entity.name == "Article")
    assert dict(article.annotations)["m:HasStream"] == "true"
    title = next(prop for prop in article.properties if prop.name == "Title")
    assert dict(title.annotations) == {
        "MaxLength": "200",
        "m:FC_TargetPath": "SyndicationTitle",
        "m:FC_ContentKind": "text",
        "m:FC_KeepInContent": "false",
    }


def test_v3_inheritance_attributes_are_kept_even_though_they_are_not_modelled():
    """``BaseType``/``Abstract`` have a v4 analogue the v4 path does not model either, so
    v2/v3 keeps parity — but the source text is carried in extras rather than dropped."""
    schema = parse_odata(_text("v3", "BaseType")).schemas[0]
    vehicle = next(entity for entity in schema.entity_types if entity.name == "Vehicle")
    truck = next(entity for entity in schema.entity_types if entity.name == "Truck")
    assert dict(vehicle.annotations)["Abstract"] == "true"
    assert dict(truck.annotations)["BaseType"] == "Fleet.Vehicle"


def test_sap_gateway_metadata_imports_with_its_annotations():
    document = parse_odata(_text("v2", "sap-annotations"))
    assert document.version == "2.0"
    schema = document.schemas[0]
    partner = next(entity for entity in schema.entity_types if entity.name == "BusinessPartner")
    assert dict(partner.annotations)["sap:label"] == "Business Partner"
    currency = next(prop for prop in partner.properties if prop.name == "CurrencyCode")
    assert dict(currency.annotations)["sap:semantics"] == "currency-code"
    partner_set = next(
        item for item in schema.entity_container.entity_sets if item.name == "BusinessPartnerSet"
    )
    assert dict(partner_set.annotations)["sap:deletable"] == "false"


def test_v4_parsing_captures_no_annotations_so_its_model_is_unchanged():
    """FMT-3.4's third criterion, at the seam that would break it.

    Annotation capture, association parsing and function-import signatures are all gated on
    the document predating v4. A v4 document must therefore come out of the parser with
    empty bags everywhere, which is what makes its canonical model byte-identical.
    """
    for entry in load_corpus(format="odata", validity_class=ValidityClass.VALID):
        document = parse_odata(entry.read_text())
        assert document.version == "4.0", entry.path
        for schema in document.schemas:
            assert schema.annotations == (), entry.path
            assert schema.associations == (), entry.path
            if schema.entity_container is not None:
                assert schema.entity_container.function_imports == (), entry.path
                assert schema.entity_container.association_sets == (), entry.path
            for entity in schema.entity_types:
                assert entity.annotations == (), entry.path
                assert all(prop.annotations == () for prop in entity.properties), entry.path


# ---------------------------------------------------------------------------
# Semantic rejections
# ---------------------------------------------------------------------------


def test_a_document_with_no_entity_container_is_semantically_invalid():
    with pytest.raises(ODataParseError) as excinfo:
        parse_odata(_negative("semantic"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_navigation_property_naming_no_association_is_an_unresolved_reference():
    with pytest.raises(ODataParseError) as excinfo:
        parse_odata(_negative("unresolvable-ref"))
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_the_adapter_reports_the_parser_code_on_the_import_error(adapter: ODataImportSource):
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_negative("unresolvable-ref"))
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


# ---------------------------------------------------------------------------
# Multi-file sets: edmx:Reference
# ---------------------------------------------------------------------------


def _referenced_set() -> IntakeFileset:
    root = unique_corpus_entry(format="odata-v2", features=("multi-file", "edmx-Reference"))
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(root.absolute_path.parent.iterdir())
        if path.is_file()
    }
    return IntakeFileset.from_members(members, root=root.absolute_path.name)


def test_a_referenced_document_is_merged_into_the_set(adapter: ODataImportSource):
    document = adapter.parse_fileset(_referenced_set())
    assert [schema.namespace for schema in document.schemas] == ["Invoicing", "Shared.Types"]
    assert document.references[0].resolved is True
    assert document.references[0].includes == (("Shared.Types", "Shared"),)


def test_a_referenced_complex_type_resolves_instead_of_dangling(adapter: ODataImportSource):
    api = adapter.normalize(adapter.parse_fileset(_referenced_set()), include_raw=False)
    invoice = next(type_ for type_ in api.types if type_.name == "Invoice")
    bill_to = next(field for field in invoice.fields if field.name == "BillTo")
    assert bill_to.type.name in {type_.key for type_ in api.types}


def test_a_reference_already_merged_is_recorded_resolved_and_not_merged_twice():
    """Two documents in a set may name the same third one; its schemas merge once."""
    root = unique_corpus_entry(format="odata-v2", features=("multi-file", "edmx-Reference"))
    text = root.read_text()
    reference = text[
        text.index("<edmx:Reference") : text.index("</edmx:Reference>") + len("</edmx:Reference>")
    ]
    doubled = text.replace("<edmx:DataServices", reference + "\n  <edmx:DataServices", 1)
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(root.absolute_path.parent.iterdir())
        if path.is_file()
    }
    members[root.absolute_path.name] = doubled
    document = parse_odata(doubled, members=members)
    assert [reference.resolved for reference in document.references] == [True, True]
    assert [schema.namespace for schema in document.schemas] == ["Invoicing", "Shared.Types"]


def test_an_unanswered_reference_is_recorded_rather_than_fatal():
    """A v4 service routinely references vocabularies that are not shipped beside it."""
    root = unique_corpus_entry(format="odata-v2", features=("multi-file", "edmx-Reference"))
    document = parse_odata(root.read_text(), members={"unrelated.xml": ""})
    assert [reference.resolved for reference in document.references] == [False]
    assert [schema.namespace for schema in document.schemas] == ["Invoicing"]


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def test_v2_navigation_normalizes_to_the_same_relationship_shape_as_v4():
    api = ODataNormalizer().normalize(
        parse_odata(_text("v2", "compound-key")), include_raw=False
    )
    assert api.paradigm is ApiParadigm.REST
    assert api.format == "odata"
    assert api.version == "2.0"

    customer = next(type_ for type_ in api.types if type_.name == "Customer")
    navigation = customer.extras["odata_navigation_properties"][0]
    # The v4 triple every generation produces...
    assert navigation["name"] == "Orders"
    assert navigation["type"] == "Collection(Northbound.Orders.Order)"
    assert navigation["partner"] == "Customer"
    # ...plus the v2 spelling it was derived from.
    assert navigation["relationship"] == "Northbound.Orders.CustomerOrders"
    assert navigation["from_role"] == "Customer"
    assert navigation["to_role"] == "Order"


def test_v2_provenance_records_the_csdl_version_and_its_evidence():
    extras = _model_extras(_text("v2", "compound-key"))
    assert extras["odata_version"] == "2.0"
    assert extras["odata_csdl_version"] == "2.0"
    assert extras["odata_edm_namespace"] == _V2_EDM_NS
    assert extras["odata_edmx_namespace"] == _V2_EDMX_NS
    assert extras["odata_edmx_version"] == "1.0"
    assert extras["odata_data_service_version"] == "2.0"


def test_v3_provenance_records_the_v3_namespaces():
    extras = _model_extras(_text("v3", "IsSideEffecting"))
    assert extras["odata_csdl_version"] == "3.0"
    assert extras["odata_edm_namespace"] == _V3_EDM_NS


def test_v4_normalization_adds_none_of_the_new_extras_keys():
    """The other half of criterion three: nothing new may appear on a v4 model."""
    new_keys = {
        "odata_csdl_version",
        "odata_edm_namespace",
        "odata_edmx_namespace",
        "odata_edmx_version",
        "odata_data_service_version",
        "odata_references",
    }
    for entry in load_corpus(format="odata", validity_class=ValidityClass.VALID):
        extras = _model_extras(entry.read_text())
        assert not new_keys & set(extras), entry.path
        assert extras["odata_version"] == "4.0", entry.path
        for schema in extras["odata_schemas"]:
            assert "associations" not in schema, entry.path
            assert "annotations" not in schema, entry.path


def test_association_declarations_reach_the_canonical_extras():
    schema = _model_extras(_text("v2", "compound-key"))["odata_schemas"][0]
    association = next(item for item in schema["associations"] if item["name"] == "CustomerOrders")
    assert [end["multiplicity"] for end in association["ends"]] == ["1", "*"]
    assert association["referential_constraints"][0]["dependent_role"] == "Order"
    assert schema["entity_container"]["function_imports"][0]["name"] == "CancelOrder"


def test_v2_only_primitives_map_to_scalars_rather_than_dangling_type_refs():
    """``Edm.DateTime`` and ``Edm.Time`` were removed in v4 and are all over SAP metadata."""
    api = ODataNormalizer().normalize(parse_odata(_text("v2", "FC-TargetPath")), include_raw=False)
    article = next(type_ for type_ in api.types if type_.name == "Article")
    fields = {field.name: field for field in article.fields}
    assert fields["PublishedOn"].type.name == "string"
    assert fields["Duration"].extras["odata_type"] == "Edm.Time"
    assert fields["Duration"].type.name == "string"


# ---------------------------------------------------------------------------
# Adapter surface
# ---------------------------------------------------------------------------


def test_detect_reports_the_csdl_generation(adapter: ODataImportSource):
    v2 = adapter.detect(DetectionInput(text=_text("v2", "sap-annotations"), filename="s.xml"))
    assert (v2.format, v2.matched) == ("odata-v2", True)
    assert "CSDL 2.0" in v2.reason

    v3 = adapter.detect(DetectionInput(text=_text("v3", "IsSideEffecting"), filename="c.xml"))
    assert v3.format == "odata-v3"

    v4_entry = load_corpus(format="odata", validity_class=ValidityClass.VALID)[0]
    v4 = adapter.detect(DetectionInput(text=v4_entry.read_text(), filename="v4.edmx"))
    assert v4.format == "odata", "a v4 document must keep detecting as the plain family key"


def test_declared_version_coverage_names_every_generation_read():
    assert ODataImportSource.formats == ("odata", "odata-v2", "odata-v3", "edmx")


def test_a_version_scoped_key_still_resolves_to_the_odata_adapter():
    from app.catalog_conversion import resolve_conversion_adapter

    text = _text("v2", "sap-annotations")
    assert resolve_conversion_adapter("odata-v2", text).key == "odata"
    assert resolve_conversion_adapter("odata-v3", text).key == "odata"


def test_a_v2_model_still_emits_a_valid_v4_document():
    """FMT-3.4 is import-only: a v2 source emits as v4, losing the association model."""
    from app.odata_emitter import validate_odata_document

    api = ODataNormalizer().normalize(
        parse_odata(_text("v2", "compound-key"))
    )
    emitted = get_emitter("odata")().emit(api).files[0].content
    assert 'EntityType Name="Customer"' in emitted
    validate_odata_document(emitted)
