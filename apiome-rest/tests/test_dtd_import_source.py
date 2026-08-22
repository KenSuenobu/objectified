"""Unit tests for the DTD ImportSource — FMT-4.2 (#5435).

Organised around the ticket's four acceptance criteria:

#. internal and external subsets import, and entity expansion is bounded and never
   recursive;
#. attribute defaults and enumerations map to canonical constraints;
#. mixed content is modelled *and* declared a limit, explicitly;
#. the adversarial entity-expansion shapes terminate within budget and fail cleanly.

The shipped corpus fixtures are asserted against directly, so the suite fails if one is
deleted rather than only if one changes.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Dict

import pytest

from app.canonical_model import ApiParadigm, TypeKind
from app.dtd_grammar import (
    LIMIT_DETAILS,
    MAX_ENTITY_EXPANSIONS,
    MAX_MODEL_DEPTH,
    AttributeDefault,
    AttributeType,
    ContentKind,
    DtdParseError,
    ExpansionBudget,
    LimitRecorder,
    Occurrence,
    is_absolute_system_id,
    resolve_system_id,
)
from app.dtd_import_source import DTD_CAPABILITIES, DtdImportSource
from app.dtd_normalizer import (
    ATTRIBUTE_FIELD_SIGIL,
    DTD_EXTRAS_KEY,
    TEXT_FIELD_NAME,
    WILDCARD_FIELD_NAME,
)
from app.dtd_parser import is_dtd, parse_dtd, parse_dtd_fileset
from app.fileset import IntakeFileset
from app.format_capability_registry import (
    CapabilityProvenance,
    ProjectionCoverage,
    capability_for,
)
from app.format_version_coverage import VersionSupport, version_coverage_for
from app.import_preview_manifest import (
    PROVENANCE_EXTRA_KEYS,
    CoverageClass,
    build_import_preview_manifest,
    paginate_import_preview_manifest,
)
from app.import_routing import ImportTarget, decide_import_routing
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    canonical_fingerprint,
    detect_import_source,
    get_import_source,
    load_builtin_import_sources,
)

load_builtin_import_sources()

CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "dtd"

#: The smallest DTD that exercises an element, an attribute and a default.
MINIMAL = '<!ELEMENT note (#PCDATA)>\n<!ATTLIST note id ID #REQUIRED>\n'


@pytest.fixture()
def adapter() -> DtdImportSource:
    """The registered DTD adapter."""
    return get_import_source("dtd")


def _fixture(name: str) -> str:
    """Return a shipped corpus fixture's text."""
    return (CORPUS / name).read_text(encoding="utf-8")


def _modular_set() -> IntakeFileset:
    """Return the shipped three-module DTD set as an intake fileset."""
    members: Dict[str, str] = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / "03-modular-set").iterdir())
        if path.is_file()
    }
    return IntakeFileset.from_members(members, root="document.dtd")


def _type(model, name: str):
    """Return one named type from a canonical model."""
    return next(item for item in model.types if item.name == name)


def _field(model, type_name: str, field_name: str):
    """Return one named field of one named type from a canonical model."""
    return next(
        field for field in _type(model, type_name).fields if field.name == field_name
    )


# ===========================================================================
# Registration and detection
# ===========================================================================


def test_adapter_is_registered_as_a_data_schema_reader(adapter: DtdImportSource) -> None:
    assert adapter.key == "dtd"
    assert adapter.paradigm is ApiParadigm.DATA_SCHEMA
    assert adapter.formats == ("dtd",)
    assert ".dtd" in adapter.file_extensions


def test_detect_claims_a_standalone_external_subset(adapter: DtdImportSource) -> None:
    result = adapter.detect(
        DetectionInput(text=_fixture("02-typical-catalogue.dtd"), filename="catalogue.dtd")
    )
    assert result.matched
    assert result.format == "dtd"
    assert result.confidence >= 0.9


def test_detect_claims_an_internal_subset_inside_an_instance_document(
    adapter: DtdImportSource,
) -> None:
    result = adapter.detect(
        DetectionInput(text=_fixture("06-internal-subset-invoice.xml"), filename="invoice.xml")
    )
    assert result.matched
    assert result.confidence >= 0.85


def test_detect_does_not_claim_another_xml_schema_language(adapter: DtdImportSource) -> None:
    grammar = _fixture("negative/04-wrong-format-relaxng.rng")
    assert not adapter.detect(DetectionInput(text=grammar, filename="x.rng")).matched
    # ...and the document is still confidently claimed by the adapter it belongs to, which
    # is what makes the pipeline classify a misrouted upload as FORMAT_MISMATCH.
    best = detect_import_source(DetectionInput(text=grammar, filename="x.rng"))
    assert best is not None and best[0].key == "relaxng"


@pytest.mark.parametrize(
    "text",
    [
        # An entity-only DOCTYPE is how a hostile XSD/WSDL/ISO 20022 document smuggles an
        # expansion bomb. Those belong to their own adapters, whose hardened XML readers
        # reject them; a DTD reader claiming them would move the rejection somewhere else.
        '<?xml version="1.0"?>\n<!DOCTYPE xs:schema [\n  <!ENTITY lol "lol">\n]>\n<xs:schema/>',
        '<?xml version="1.0"?>\n<root><child/></root>',
        "",
        "   ",
    ],
)
def test_detect_declines_documents_that_are_not_dtds(
    adapter: DtdImportSource, text: str
) -> None:
    assert not adapter.detect(DetectionInput(text=text, filename="doc.xml")).matched


def test_is_dtd_claims_an_entity_only_module() -> None:
    """A `.ent`/`.mod` module holds only entities and is still a DTD."""
    assert is_dtd('<!ENTITY % commonAtts "id ID #IMPLIED">\n')


def test_is_dtd_looks_past_a_leading_comment_and_xml_declaration() -> None:
    assert is_dtd('<?xml version="1.0"?>\n<!-- header -->\n<!ELEMENT a (#PCDATA)>')


# ===========================================================================
# AC 1 — internal and external subsets import
# ===========================================================================


def test_external_subset_imports(adapter: DtdImportSource) -> None:
    document = adapter.parse(_fixture("02-typical-catalogue.dtd"))
    assert document.name is None  # a standalone subset declares no DOCTYPE
    assert document.root == "catalogue"
    assert [element.name for element in document.elements][:2] == ["catalogue", "product"]


def test_internal_subset_imports_and_records_its_doctype(adapter: DtdImportSource) -> None:
    document = adapter.parse(_fixture("06-internal-subset-invoice.xml"))
    assert document.name == "invoice"
    assert document.root == "invoice"
    api = adapter.normalize(document)
    assert api.extras[DTD_EXTRAS_KEY]["doctype"] == "invoice"
    # The instance document's own content is not read: only the subset is.
    assert not any(entity.name == "Acme Retail BV" for entity in document.entities)


def test_a_standalone_subset_derives_its_root_structurally(adapter: DtdImportSource) -> None:
    """No `<!DOCTYPE>` names a root, so the element nothing references is the root."""
    document = adapter.parse("<!ELEMENT leaf (#PCDATA)>\n<!ELEMENT top (leaf)>\n")
    assert document.name is None
    assert document.root == "top"


def test_modular_set_composes_through_parameter_entities(adapter: DtdImportSource) -> None:
    document = adapter.parse_fileset(_modular_set(), source_label="03-modular-set")
    names = {element.name for element in document.elements}
    # `report`/`section` are the root module's; `title`/`para`/`emphasis` come from
    # common.dtd and `table`/`row`/`cell` from table.dtd, both pulled in by `%module;`.
    assert {"report", "section", "title", "para", "table", "row", "cell"} <= names
    assert document.external_subsets == ("common.dtd", "table.dtd")
    assert document.root == "report"


def test_a_module_supplies_an_attribute_set_to_a_later_module(
    adapter: DtdImportSource,
) -> None:
    """`table.dtd` uses `%commonAtts;`, which only `common.dtd` declares."""
    document = adapter.parse_fileset(_modular_set())
    table = next(element for element in document.elements if element.name == "table")
    assert {attribute.name for attribute in table.attributes} == {"id", "lang", "border"}


def test_a_fileset_without_its_root_is_rejected() -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd_fileset({"a.dtd": MINIMAL}, root="missing.dtd")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_parameter_entities_expand_inside_a_content_model(adapter: DtdImportSource) -> None:
    document = adapter.parse(
        '<!ENTITY % inline "(#PCDATA | b)*">\n<!ELEMENT b (#PCDATA)>\n<!ELEMENT p %inline;>\n'
    )
    paragraph = next(element for element in document.elements if element.name == "p")
    assert paragraph.content.kind is ContentKind.MIXED
    assert [child.name for child in paragraph.content.children] == ["b"]


def test_parameter_entities_expand_inside_an_attlist(adapter: DtdImportSource) -> None:
    document = adapter.parse(
        '<!ENTITY % common "id ID #IMPLIED lang NMTOKEN #IMPLIED">\n'
        "<!ELEMENT a EMPTY>\n"
        "<!ATTLIST a %common; href CDATA #REQUIRED>\n"
    )
    element = document.elements[0]
    assert [attribute.name for attribute in element.attributes] == ["id", "lang", "href"]


def test_a_parameter_entity_may_be_built_from_other_fragments(
    adapter: DtdImportSource,
) -> None:
    """`07`'s `%body;` is `(%blocks; | figure)+` — a fragment defined from a fragment."""
    document = adapter.parse(_fixture("07-composition-parameter-entities.dtd"))
    names = {element.name for element in document.elements}
    assert {"para", "list", "figure"} <= names


def test_a_comment_is_text_and_never_expands_an_entity(adapter: DtdImportSource) -> None:
    """A DTD that documents `%missing;` in a comment must not try to resolve it."""
    document = adapter.parse(
        "<!-- %missing; is only mentioned here -->\n<!ELEMENT a (#PCDATA)>\n"
    )
    assert [element.name for element in document.elements] == ["a"]


def test_general_entity_values_are_expanded_before_normalization(
    adapter: DtdImportSource,
) -> None:
    document = adapter.parse(_fixture("04-stress-content-models-and-entities.dtd"))
    tagline = next(entity for entity in document.entities if entity.name == "tagline")
    assert tagline.value == "Example Corporation Widget — built by Example Corporation"


def test_conditional_sections_are_honoured(adapter: DtdImportSource) -> None:
    document = adapter.parse(
        '<!ENTITY % draft "INCLUDE">\n'
        "<![%draft;[ <!ELEMENT kept (#PCDATA)> ]]>\n"
        "<![IGNORE[ <!ELEMENT dropped (nonsense) ]]>\n"
    )
    assert [element.name for element in document.elements] == ["kept"]


def test_multiple_attlists_for_one_element_merge_first_declaration_wins(
    adapter: DtdImportSource,
) -> None:
    document = adapter.parse(
        "<!ELEMENT a EMPTY>\n"
        "<!ATTLIST a href CDATA #REQUIRED>\n"
        "<!ATTLIST a href CDATA #IMPLIED\n          rel CDATA #IMPLIED>\n"
    )
    attributes = {a.name: a for a in document.elements[0].attributes}
    assert set(attributes) == {"href", "rel"}
    assert attributes["href"].default is AttributeDefault.REQUIRED


# ===========================================================================
# AC 1 — expansion is bounded and never recursive
# ===========================================================================


def test_a_directly_recursive_parameter_entity_is_refused(adapter: DtdImportSource) -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd('<!ENTITY % a "%a;">\n%a;\n<!ELEMENT d (#PCDATA)>')
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"
    assert "recursive" in str(excinfo.value)


def test_mutually_recursive_parameter_entities_are_refused() -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd('<!ENTITY % a "%b;">\n<!ENTITY % b "%a;">\n%a;\n<!ELEMENT d (#PCDATA)>')
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"
    assert "%a -> %b -> %a" in str(excinfo.value)


def test_a_recursive_general_entity_is_refused() -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd('<!ENTITY a "&b;">\n<!ENTITY b "&a;">\n<!ELEMENT d (#PCDATA)>')
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


def test_the_same_entity_used_twice_in_sequence_is_not_recursion() -> None:
    """Recursion is *re-entry*, not reuse: `%a;%a;` is two finished expansions."""
    document = parse_dtd(
        '<!ENTITY % a "<!ELEMENT x (#PCDATA)>">\n'
        '<!ENTITY % b "<!ELEMENT y (#PCDATA)>">\n'
        "%a;\n%b;\n"
    )
    assert [element.name for element in document.elements] == ["x", "y"]


def test_a_general_entity_billion_laughs_fails_within_budget() -> None:
    lines = ['<!ENTITY lol "lollollollollollollollollollol">']
    for level in range(1, 10):
        previous = "lol" if level == 1 else f"lol{level - 1}"
        lines.append(f'<!ENTITY lol{level} "' + f"&{previous};" * 10 + '">')
    lines.append("<!ELEMENT boom (#PCDATA)>")
    started = time.monotonic()
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd("\n".join(lines))
    assert excinfo.value.code == "INPUT_EXPANSION_LIMIT"
    assert time.monotonic() - started < 5.0


def test_a_parameter_entity_bomb_fails_within_budget() -> None:
    lines = ['<!ENTITY % p0 "<!ELEMENT a0 (#PCDATA)>">']
    for level in range(1, 10):
        lines.append(f'<!ENTITY % p{level} "' + f"%p{level - 1};" * 10 + '">')
    lines.append("%p9;")
    started = time.monotonic()
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd("\n".join(lines))
    assert excinfo.value.code == "INPUT_EXPANSION_LIMIT"
    assert time.monotonic() - started < 5.0


def test_the_two_expansion_mechanisms_share_one_budget() -> None:
    """A document cannot move work between mechanisms to spend past a guard."""
    budget = ExpansionBudget(max_expansions=2)
    budget.enter("%a")
    budget.leave()
    budget.enter("&b")
    budget.leave()
    with pytest.raises(DtdParseError) as excinfo:
        budget.enter("%c")
    assert excinfo.value.code == "INPUT_EXPANSION_LIMIT"


def test_the_byte_budget_is_charged_incrementally() -> None:
    budget = ExpansionBudget(max_bytes=10)
    budget.charge_bytes(6)
    with pytest.raises(DtdParseError) as excinfo:
        budget.charge_bytes(6)
    assert excinfo.value.code == "INPUT_EXPANSION_LIMIT"


def test_expansion_depth_is_bounded() -> None:
    budget = ExpansionBudget(max_depth=2)
    budget.enter("%a")
    budget.enter("%b")
    with pytest.raises(DtdParseError) as excinfo:
        budget.enter("%c")
    assert excinfo.value.code == "INPUT_EXPANSION_LIMIT"


def test_the_declared_expansion_ceiling_is_generous_enough_for_a_real_dtd(
    adapter: DtdImportSource,
) -> None:
    """The corpus's deliberately entity-heavy fixtures stay orders of magnitude under."""
    document = adapter.parse(_fixture("04-stress-content-models-and-entities.dtd"))
    assert 0 < document.expansions < MAX_ENTITY_EXPANSIONS // 100


def test_a_deeply_nested_content_model_fails_rather_than_exhausting_the_stack() -> None:
    text = "<!ELEMENT d " + "(" * 300 + "a" + ")" * 300 + ">\n<!ELEMENT a (#PCDATA)>"
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd(text)
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"
    assert str(MAX_MODEL_DEPTH) in str(excinfo.value)


def test_an_oversized_document_is_refused_before_it_is_scanned() -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd("<!ELEMENT d (#PCDATA)>\n<!-- " + "x" * (11 * 1024 * 1024) + " -->")
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_too_many_declared_entities_is_refused() -> None:
    text = "\n".join(f'<!ENTITY e{i} "v">' for i in range(10_001))
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd(text + "\n<!ELEMENT d (#PCDATA)>")
    assert excinfo.value.code == "INPUT_ENTITY_LIMIT"


# ===========================================================================
# External identifiers are never fetched
# ===========================================================================


@pytest.mark.parametrize(
    "system_id",
    ["file:///etc/passwd", "data:text/plain,x", "http://user:pass@example.com/a.dtd"],
)
def test_an_ssrf_unsafe_system_identifier_fails_the_import(system_id: str) -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd(f'<!ENTITY % x SYSTEM "{system_id}">\n%x;\n<!ELEMENT d (#PCDATA)>')
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


def test_a_policy_legal_url_is_recorded_and_never_fetched(adapter: DtdImportSource) -> None:
    document = parse_dtd(
        '<!ENTITY % remote SYSTEM "https://example.com/m.dtd">\n%remote;\n'
        "<!ELEMENT d (#PCDATA)>"
    )
    assert document.unresolved_system_ids == ("https://example.com/m.dtd",)
    assert [limit.construct for limit in document.limits] == ["dtd.remote_system_id"]
    api = adapter.normalize(document)
    assert api.extras[DTD_EXTRAS_KEY]["unresolved_system_ids"] == [
        "https://example.com/m.dtd"
    ]


def test_a_module_outside_the_uploaded_set_is_an_unresolved_reference() -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd(_fixture("negative/06-unresolvable-parameter-entity.dtd"))
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "does-not-exist.dtd" in str(excinfo.value)


def test_an_undeclared_parameter_entity_is_an_unresolved_reference() -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd("<!ELEMENT a EMPTY>\n<!ATTLIST a %nope;>\n")
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


@pytest.mark.parametrize(
    ("system_id", "absolute"),
    [
        ("common.dtd", False),
        ("modules/common.dtd", False),
        ("http://example.com/a.dtd", True),
        ("urn:x:y", True),
        ("c:/a.dtd", False),  # a one-letter "scheme" is a Windows drive, not a URL
    ],
)
def test_absolute_system_identifiers_are_recognised(system_id: str, absolute: bool) -> None:
    assert is_absolute_system_id(system_id) is absolute


def test_a_relative_identifier_resolves_by_directory_then_by_filename() -> None:
    limits = LimitRecorder()
    members = {"schemas/common.dtd": "<!ELEMENT a EMPTY>"}
    resolved = resolve_system_id(
        "common.dtd", members=members, base="schemas/document.dtd", limits=limits, recorded=[]
    )
    assert resolved is not None and resolved[0] == "schemas/common.dtd"
    # An archive that flattened its directories still resolves.
    flat = resolve_system_id(
        "modules/common.dtd", members=members, base=None, limits=limits, recorded=[]
    )
    assert flat is not None and flat[0] == "schemas/common.dtd"


# ===========================================================================
# Failure classification
# ===========================================================================


def test_a_syntax_error_carries_no_code_so_the_pipeline_classifies_it(
    adapter: DtdImportSource,
) -> None:
    """A code-less parse failure is what lets a UTF-16 upload read as an encoding fault."""
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/01-syntactic-unterminated-declaration.dtd"))
    assert excinfo.value.code is None


def test_input_that_ends_inside_a_declaration_is_truncated(adapter: DtdImportSource) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/03-truncated-mid-attlist.dtd"))
    assert excinfo.value.code == "INPUT_TRUNCATED"


def test_a_content_model_naming_an_undeclared_element_is_semantically_invalid(
    adapter: DtdImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/02-semantic-undeclared-element-in-model.dtd"))
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"
    assert "price" in str(excinfo.value)


def test_an_element_declared_twice_is_semantically_invalid() -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd("<!ELEMENT a (#PCDATA)>\n<!ELEMENT a EMPTY>\n")
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_a_dtd_that_declares_no_elements_is_semantically_invalid() -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd('<!ENTITY % only "x">\n')
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


def test_an_empty_document_is_reported_as_empty() -> None:
    with pytest.raises(DtdParseError) as excinfo:
        parse_dtd("   \n")
    assert excinfo.value.code == "INPUT_EMPTY"


def test_normalize_rejects_a_foreign_ast(adapter: DtdImportSource) -> None:
    with pytest.raises(ImportSourceError):
        adapter.normalize({"not": "a dtd"})


# ===========================================================================
# AC 2 — attribute defaults and enumerations become canonical constraints
# ===========================================================================


def test_an_enumeration_becomes_an_enum_constraint(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.dtd")))
    kind = _field(api, "product", f"{ATTRIBUTE_FIELD_SIGIL}kind")
    assert kind.constraints is not None
    assert kind.constraints.enum == ["physical", "digital", "service"]
    assert kind.type.nullable is False  # #REQUIRED


def test_a_fixed_default_becomes_a_default_and_a_single_valued_enum(
    adapter: DtdImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.dtd")))
    scheme = _field(api, "price", f"{ATTRIBUTE_FIELD_SIGIL}scheme")
    assert scheme.default == "iso-4217"
    assert scheme.constraints is not None and scheme.constraints.enum == ["iso-4217"]
    assert scheme.type.nullable is False


def test_a_literal_default_becomes_a_default_and_keeps_its_enumeration(
    adapter: DtdImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.dtd")))
    discontinued = _field(api, "product", f"{ATTRIBUTE_FIELD_SIGIL}discontinued")
    assert discontinued.default == "no"
    assert discontinued.constraints is not None
    assert discontinued.constraints.enum == ["yes", "no"]


def test_implied_is_the_only_nullable_attribute_default(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.dtd")))
    assert _field(api, "catalogue", f"{ATTRIBUTE_FIELD_SIGIL}generator").type.nullable is True
    assert _field(api, "catalogue", f"{ATTRIBUTE_FIELD_SIGIL}version").type.nullable is False


def test_the_declared_attribute_type_survives_on_the_member(
    adapter: DtdImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.dtd")))
    sku = _field(api, "product", f"{ATTRIBUTE_FIELD_SIGIL}sku")
    assert sku.extras["dtd_attribute_type"] == AttributeType.ID.value
    assert sku.extras["dtd_identity"] is True


def test_a_tokenized_attribute_becomes_a_list_of_strings(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-content-models-and-entities.dtd")))
    classes = _field(api, "document", f"{ATTRIBUTE_FIELD_SIGIL}class")
    assert classes.type.name == "list"
    assert classes.extras["dtd_tokenized"] is True


def test_an_attribute_and_a_child_of_the_same_name_do_not_collide() -> None:
    adapter = get_import_source("dtd")
    api = adapter.normalize(
        adapter.parse("<!ELEMENT a (name)>\n<!ELEMENT name (#PCDATA)>\n<!ATTLIST a name CDATA #IMPLIED>\n")
    )
    keys = {field.key for field in _type(api, "a").fields}
    assert keys == {"a.name", "a.@name"}


def test_a_notation_attribute_keeps_its_permitted_notations() -> None:
    adapter = get_import_source("dtd")
    document = adapter.parse(
        '<!NOTATION png SYSTEM "image/png">\n'
        '<!NOTATION jpg SYSTEM "image/jpeg">\n'
        "<!ELEMENT img EMPTY>\n"
        "<!ATTLIST img type NOTATION (png|jpg) #REQUIRED>\n"
    )
    attribute = document.elements[0].attributes[0]
    assert attribute.type is AttributeType.NOTATION
    assert attribute.enumeration == ("png", "jpg")


# ===========================================================================
# AC 3 — mixed content is modelled *and* declared a limit
# ===========================================================================


def test_mixed_content_keeps_its_children_and_its_text(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-content-models-and-entities.dtd")))
    title = _type(api, "title")
    names = {field.name for field in title.fields}
    assert {"emphasis", "code", "link", TEXT_FIELD_NAME} <= names
    for name in ("emphasis", "code", "link"):
        member = _field(api, "title", name)
        assert member.type.name == "list"
        assert member.extras["dtd_mixed"] is True


def test_mixed_content_is_declared_a_limit_explicitly(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-content-models-and-entities.dtd")))
    limits = {
        limit["construct"]: limit
        for limit in api.extras[DTD_EXTRAS_KEY]["capability_limits"]
    }
    assert "dtd.mixed_content" in limits
    assert limits["dtd.mixed_content"]["count"] >= 1
    assert "title" in limits["dtd.mixed_content"]["locations"]
    assert "interleav" in limits["dtd.mixed_content"]["detail"]


def test_text_only_content_is_not_mixed_content(adapter: DtdImportSource) -> None:
    """`(#PCDATA)` is exactly expressible, so it must not be declared a limit."""
    api = adapter.normalize(adapter.parse(_fixture("05-real-world-rss-2.0-subset.dtd")))
    assert api.extras[DTD_EXTRAS_KEY]["capability_limits"] == []
    assert _type(api, "title").kind is TypeKind.SCALAR


def test_text_only_content_with_attributes_is_a_record_with_a_text_member(
    adapter: DtdImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("01-minimal-note.dtd")))
    note = _type(api, "note")
    assert note.kind is TypeKind.RECORD
    assert {field.name for field in note.fields} == {TEXT_FIELD_NAME, "@id"}


def test_any_content_becomes_one_open_content_member(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-content-models-and-entities.dtd")))
    appendix = _type(api, "appendix")
    assert [field.name for field in appendix.fields] == [WILDCARD_FIELD_NAME]
    assert appendix.fields[0].extras["dtd_open_content"] is True


def test_an_empty_element_has_only_its_attributes(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-content-models-and-entities.dtd")))
    published = _type(api, "published")
    assert [field.name for field in published.fields] == [f"{ATTRIBUTE_FIELD_SIGIL}date"]


# ===========================================================================
# The rest of the projection
# ===========================================================================


def test_occurrence_indicators_become_nullability_and_lists(
    adapter: DtdImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.dtd")))
    assert _field(api, "product", "name").type.nullable is False  # (name)
    assert _field(api, "product", "description").type.nullable is True  # description?
    tag = _field(api, "product", "tag")  # tag*
    assert tag.type.name == "list" and tag.type.nullable is True
    product = _field(api, "catalogue", "product")  # product+
    assert product.type.name == "list" and product.type.nullable is False


def test_a_choice_becomes_a_union_rather_than_optional_siblings(
    adapter: DtdImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-content-models-and-entities.dtd")))
    body = _type(api, "body")
    assert len(body.fields) == 1
    union = _type(api, body.fields[0].type.item.name)
    assert union.kind is TypeKind.UNION
    assert union.union_members == ["para", "list", "figure", "table"]


def test_a_name_in_a_content_model_is_a_reference_not_a_copy(
    adapter: DtdImportSource,
) -> None:
    """A DTD that reuses an element in many models must not produce many copies of it."""
    api = adapter.normalize(adapter.parse(_fixture("05-real-world-rss-2.0-subset.dtd")))
    assert [entity.name for entity in api.types].count("title") == 1
    assert _field(api, "channel", "title").type.name == "title"
    assert _field(api, "item", "title").type.name == "title"


def test_an_element_named_twice_folds_into_one_bounded_member(
    adapter: DtdImportSource,
) -> None:
    """`(party, party, line+, total)` means exactly two parties."""
    api = adapter.normalize(adapter.parse(_fixture("06-internal-subset-invoice.xml")))
    party = _field(api, "invoice", "party")
    assert party.type.name == "list"
    assert party.constraints is not None
    assert (party.constraints.min_items, party.constraints.max_items) == (2, 2)
    assert party.extras["dtd_particles"] == 2


def test_a_repeated_group_distributes_and_declares_the_loss(
    adapter: DtdImportSource,
) -> None:
    document = parse_dtd(
        "<!ELEMENT d (a, b)+>\n<!ELEMENT a (#PCDATA)>\n<!ELEMENT b (#PCDATA)>\n"
    )
    assert "dtd.repeated_group" in {limit.construct for limit in document.limits}
    api = get_import_source("dtd").normalize(document)
    assert _field(api, "d", "a").type.name == "list"
    assert _field(api, "d", "b").type.name == "list"


def test_an_orphan_attlist_is_recorded_rather_than_failing_the_import(
    adapter: DtdImportSource,
) -> None:
    """XML permits an `<!ATTLIST>` for an undeclared element; legacy DTDs contain them."""
    document = parse_dtd("<!ELEMENT a (#PCDATA)>\n<!ATTLIST ghost x CDATA #IMPLIED>\n")
    assert "dtd.orphan_attlist" in {limit.construct for limit in document.limits}
    api = adapter.normalize(document)
    assert api.extras[DTD_EXTRAS_KEY]["orphan_attlists"]["ghost"][0]["name"] == "x"
    assert [entity.name for entity in api.types] == ["a"]


def test_unparsed_entities_and_notations_are_recorded(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-content-models-and-entities.dtd")))
    report = api.extras[DTD_EXTRAS_KEY]
    assert {"name": "png", "system_id": "image/png"} in report["notations"]
    logo = next(entity for entity in report["entities"] if entity["name"] == "logo")
    assert logo["notation"] == "png"
    assert "dtd.unparsed_entity" in {
        limit["construct"] for limit in report["capability_limits"]
    }


def test_an_element_name_with_xml_punctuation_is_folded_for_the_key(
    adapter: DtdImportSource,
) -> None:
    api = adapter.normalize(
        adapter.parse("<!ELEMENT doc (my:part)>\n<!ELEMENT my:part (#PCDATA)>\n")
    )
    assert {entity.name for entity in api.types} == {"doc", "my_part"}
    assert _type(api, "my_part").extras["dtd_element"] == "my:part"


def test_normalization_is_deterministic(adapter: DtdImportSource) -> None:
    text = _fixture("04-stress-content-models-and-entities.dtd")
    first = adapter.normalize(adapter.parse(text))
    second = adapter.normalize(adapter.parse(text))
    assert canonical_fingerprint(first) == canonical_fingerprint(second)


def test_routing_sends_a_dtd_to_the_catalog(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("01-minimal-note.dtd")))
    decision = decide_import_routing(adapter, api)
    assert decision.target is ImportTarget.CATALOG
    assert decision.publishable is False


def test_lint_produces_a_report(adapter: DtdImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("05-real-world-rss-2.0-subset.dtd")))
    assert adapter.lint(api) is not None


# ===========================================================================
# The declared-limit vocabulary is one vocabulary
# ===========================================================================


def test_the_limit_vocabulary_is_the_same_in_all_three_places() -> None:
    """`LIMIT_DETAILS`, the adapter's `unsupported`, and the registry seed must agree."""
    entry = capability_for("dtd")
    assert set(LIMIT_DETAILS) == set(DTD_CAPABILITIES.unsupported)
    assert set(LIMIT_DETAILS) == set(entry.canonical_projection.dropped_constructs)


def test_recording_an_unknown_limit_key_is_a_programming_error() -> None:
    with pytest.raises(KeyError):
        LimitRecorder().record("dtd.not-a-real-limit")


def test_limits_are_counted_and_located() -> None:
    recorder = LimitRecorder()
    recorder.record("dtd.mixed_content", location="para")
    recorder.record("dtd.mixed_content", location="title")
    recorder.record("dtd.mixed_content", location="para")
    (limit,) = recorder.limits()
    assert limit.count == 3
    assert limit.locations == ("para", "title")


def test_the_capability_entry_is_reviewed_and_partial() -> None:
    entry = capability_for("dtd")
    assert entry.provenance is CapabilityProvenance.REVIEWED
    assert entry.canonical_projection.coverage is ProjectionCoverage.PARTIAL
    assert "mixed content" in entry.canonical_projection.note.lower()


def test_version_coverage_declares_one_ungated_read_and_no_writes() -> None:
    coverage = version_coverage_for("dtd")
    assert [version.support for version in coverage.reads] == [VersionSupport.UNGATED]
    assert list(coverage.writes) == []
    assert coverage.default_write is None


def test_the_extras_key_is_registered_as_provenance() -> None:
    assert DTD_EXTRAS_KEY in PROVENANCE_EXTRA_KEYS


def test_preview_manifest_renders_a_row_per_declared_limit(
    adapter: DtdImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-content-models-and-entities.dtd")))
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(api, adapter_key="dtd", options={})
    )
    rows = {
        entry.source_construct: entry
        for entry in page.coverage
        if entry.source_construct.startswith("dtd.")
    }
    assert set(rows) == {
        "dtd.any_content",
        "dtd.id_uniqueness",
        "dtd.mixed_content",
        "dtd.repeated_group",
        "dtd.tokenized_attribute",
        "dtd.unparsed_entity",
    }
    assert rows["dtd.mixed_content"].coverage is CoverageClass.PARTIALLY_MAPPED
    assert "capability limit" in rows["dtd.mixed_content"].detail
    assert "title" in rows["dtd.mixed_content"].detail


# ===========================================================================
# Algebra helpers
# ===========================================================================


@pytest.mark.parametrize(
    ("occurrence", "optional", "repeated"),
    [
        (Occurrence.ONE, False, False),
        (Occurrence.OPTIONAL, True, False),
        (Occurrence.ZERO_OR_MORE, True, True),
        (Occurrence.ONE_OR_MORE, False, True),
    ],
)
def test_occurrence_indicator_semantics(
    occurrence: Occurrence, optional: bool, repeated: bool
) -> None:
    assert occurrence.optional is optional
    assert occurrence.repeated is repeated


def test_a_particle_reports_the_element_names_beneath_it() -> None:
    document = parse_dtd(
        "<!ELEMENT d (a, (b | c))>\n"
        "<!ELEMENT a (#PCDATA)>\n<!ELEMENT b (#PCDATA)>\n<!ELEMENT c (#PCDATA)>\n"
    )
    assert document.elements[0].content.element_names() == ("a", "b", "c")


def test_the_predefined_xml_entities_need_no_declaration() -> None:
    """XML predefines `&amp;`/`&lt;`/`&gt;`/`&quot;`/`&apos;`; a DTD never declares them."""
    document = parse_dtd(
        "<!ELEMENT a EMPTY>\n<!ATTLIST a owner CDATA \"AT&amp;T &lt;legal&gt;\">\n"
    )
    assert document.elements[0].attributes[0].default_value == "AT&T <legal>"


def test_character_references_are_decoded_in_a_replacement_text() -> None:
    document = parse_dtd('<!ENTITY dash "&#8212;&#x2014;">\n<!ELEMENT a (#PCDATA)>\n')
    assert document.entities[0].value == "——"
