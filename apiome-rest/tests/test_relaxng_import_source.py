"""Unit tests for the RELAX NG ImportSource — FMT-4.1 (#5434).

Organised around the ticket's four acceptance criteria:

#. ``.rng`` and ``.rnc`` import to the same canonical model for the same grammar;
#. ``include`` and ``externalRef`` resolve across a fileset, with SSRF-guarded remote refs;
#. ``interleave`` and the datatype-library constructs that cannot be modelled are declared
   parsing limits in the capability registry rather than silent omissions;
#. the corpus covers a document grammar, a modular grammar with includes, compact syntax,
   and a malformed grammar (asserted here against the shipped fixtures, so the suite fails
   if a fixture is deleted rather than only if it changes).
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Dict

import pytest

from app.canonical_model import ApiParadigm, TypeKind
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
    get_import_source,
    load_builtin_import_sources,
)
from app.relaxng_compact import (
    MAX_COMPACT_BYTES,
    MAX_COMPACT_DEPTH,
    read_compact_components,
    tokenize_compact,
)
from app.relaxng_grammar import (
    LIMIT_DETAILS,
    LimitRecorder,
    PatternKind,
    RelaxNgParseError,
    combine_defines,
    resolve_href,
)
from app.relaxng_import_source import RELAXNG_CAPABILITIES, RelaxNgImportSource
from app.relaxng_normalizer import RELAXNG_EXTRAS_KEY
from app.relaxng_parser import is_relaxng, is_relaxng_compact, parse_relaxng

load_builtin_import_sources()

#: The shipped corpus, which the acceptance-criteria tests read directly.
CORPUS = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples" / "relaxng"


@pytest.fixture
def adapter() -> RelaxNgImportSource:
    return RelaxNgImportSource()


def _fixture(name: str) -> str:
    return (CORPUS / name).read_text(encoding="utf-8")


def _members(directory: str) -> Dict[str, str]:
    return {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((CORPUS / directory).iterdir())
        if path.is_file()
    }


CATALOGUE_RNG = """\
<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0"
         datatypeLibrary="http://www.w3.org/2001/XMLSchema-datatypes">
  <start><ref name="root"/></start>
  <define name="root">
    <element name="root">
      <attribute name="id"><data type="string"><param name="minLength">3</param></data></attribute>
      <optional><element name="note"><text/></element></optional>
      <zeroOrMore><element name="item"><data type="int"/></element></zeroOrMore>
    </element>
  </define>
</grammar>
"""

CATALOGUE_RNC = """\
datatypes xsd = "http://www.w3.org/2001/XMLSchema-datatypes"

start = root

root =
  element root {
    attribute id { xsd:string { minLength = "3" } },
    element note { text }?,
    element item { xsd:int }*
  }
"""


# ---------------------------------------------------------------------------
# Registration & detection
# ---------------------------------------------------------------------------


def test_adapter_is_registered_under_both_syntax_keys() -> None:
    source = get_import_source("relaxng")
    assert isinstance(source, RelaxNgImportSource)
    assert source.paradigm is ApiParadigm.DATA_SCHEMA
    assert source.formats == ("relaxng", "relaxng-compact")
    assert set(source.file_extensions) == {".rng", ".rnc"}


def test_detect_claims_the_xml_syntax(adapter: RelaxNgImportSource) -> None:
    result = adapter.detect(DetectionInput(text=CATALOGUE_RNG, filename="c.rng"))
    assert result.matched
    assert result.format == "relaxng"
    assert result.confidence >= 0.9


def test_detect_claims_the_compact_syntax_under_its_own_key(
    adapter: RelaxNgImportSource,
) -> None:
    result = adapter.detect(DetectionInput(text=CATALOGUE_RNC, filename="c.rnc"))
    assert result.matched
    assert result.format == "relaxng-compact"


def test_detect_claims_a_bare_element_pattern(adapter: RelaxNgImportSource) -> None:
    result = adapter.detect(
        DetectionInput(text=_fixture("01-minimal-note.rng"), filename="01-minimal-note.rng")
    )
    assert result.matched and result.format == "relaxng"


def test_detect_does_not_claim_an_xsd(adapter: RelaxNgImportSource) -> None:
    assert not adapter.detect(
        DetectionInput(text=_fixture("negative/04-wrong-format-xsd.xsd"), filename="x.xsd")
    ).matched


def test_detect_does_not_claim_a_document_that_only_quotes_the_namespace(
    adapter: RelaxNgImportSource,
) -> None:
    # The namespace URI inside an XSD annotation must not make the document ours: the root
    # element is what decides, which is why the sniff parses rather than substring-matching.
    quoting = (
        '<?xml version="1.0"?>\n'
        '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">\n'
        "  <xs:annotation><xs:documentation>See "
        "http://relaxng.org/ns/structure/1.0</xs:documentation></xs:annotation>\n"
        '  <xs:element name="a" type="xs:string"/>\n'
        "</xs:schema>\n"
    )
    assert not adapter.detect(DetectionInput(text=quoting, filename="q.xsd")).matched


def test_detect_claims_a_bare_compact_pattern(adapter: RelaxNgImportSource) -> None:
    """A `.rnc` may be one pattern with no `start`, so the sniff must not require one."""
    result = adapter.detect(
        DetectionInput(text="element foo { attribute id { text }, text }\n", filename="b.rnc")
    )
    assert result.matched and result.format == "relaxng-compact"


@pytest.mark.parametrize(
    "text",
    [
        "The element attribute is described in the manual.\n",
        "type Query { user: User }\n",
        "struct Foo { 1: string bar }\n",
        '{"element": {"a": 1}}\n',
    ],
)
def test_the_compact_sniff_does_not_claim_neighbouring_languages(text: str) -> None:
    assert is_relaxng_compact(text) is False


def test_sniffers_never_raise_on_hostile_input() -> None:
    hostile = '<!DOCTYPE x [<!ENTITY a "aaa">]><grammar xmlns="http://relaxng.org/ns/structure/1.0"/>'
    assert is_relaxng(hostile) is True  # claims it; parse reports the real reason
    assert is_relaxng("") is False
    assert is_relaxng_compact("\x00\x00") is False


# ---------------------------------------------------------------------------
# AC 1: the two syntaxes are one language
# ---------------------------------------------------------------------------


def test_both_syntaxes_produce_the_same_ast() -> None:
    xml = parse_relaxng(CATALOGUE_RNG, source_label="c.rng")
    compact = parse_relaxng(CATALOGUE_RNC, source_label="c.rnc")
    assert xml.syntax == "xml"
    assert compact.syntax == "compact"
    # `raw` and `syntax` are the only fields allowed to differ.
    assert dataclasses.replace(xml, raw="", syntax="") == dataclasses.replace(
        compact, raw="", syntax=""
    )


def test_both_syntaxes_produce_the_same_canonical_model(
    adapter: RelaxNgImportSource,
) -> None:
    xml = adapter.normalize(adapter.parse(CATALOGUE_RNG, source_label="c.rng"))
    compact = adapter.normalize(adapter.parse(CATALOGUE_RNC, source_label="c.rnc"))
    assert canonical_fingerprint(xml) == canonical_fingerprint(compact)


def test_the_shipped_corpus_pair_agrees_fingerprint(adapter: RelaxNgImportSource) -> None:
    """The fixtures the corpus README pairs (`02` and `06`) must actually agree."""
    xml = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.rng")))
    compact = adapter.normalize(adapter.parse(_fixture("06-compact-catalogue.rnc")))
    assert canonical_fingerprint(xml) == canonical_fingerprint(compact)


def test_the_syntax_is_not_part_of_the_canonical_model(adapter: RelaxNgImportSource) -> None:
    api = adapter.normalize(adapter.parse(CATALOGUE_RNC, source_label="c.rnc"))
    assert "compact" not in str(api.extras)
    assert api.format == "relaxng"


def test_compact_tokenizer_handles_comments_literals_and_escapes() -> None:
    tokens = tokenize_compact(
        '# plain\n## docs\nnamespace a = "urn:a"\n\\element = element x { """q"une""" }\n'
    )
    kinds = [token.kind for token in tokens]
    assert "doc" in kinds
    assert [token.value for token in tokens if token.kind == "literal"] == [
        "urn:a",
        'q"une',
    ]
    assert tokens[kinds.index("doc")].value == "docs"


def test_compact_rejects_an_unterminated_literal() -> None:
    with pytest.raises(RelaxNgParseError) as excinfo:
        tokenize_compact('start = element a { "oops\n }\n')
    assert excinfo.value.code == "INPUT_MALFORMED"


def test_compact_reads_declarations_and_wildcards() -> None:
    components = read_compact_components(
        'default namespace = "urn:doc"\n'
        'namespace other = "urn:other"\n'
        "start = element root { attribute * { text }, element * - other:* { text } }\n",
        source_label="w.rnc",
        limits=LimitRecorder(),
    )
    assert components.namespace == "urn:doc"
    assert components.start.kind is PatternKind.ELEMENT
    assert components.start.name_class.ns == "urn:doc"


def test_compact_combine_operators_merge_one_named_pattern() -> None:
    document = parse_relaxng(
        "start = a\n"
        "a = element a { b }\n"
        "b |= element x { empty }\n"
        "b |= element y { empty }\n",
        source_label="combine.rnc",
    )
    merged = document.define_map()["b"]
    assert merged.combine == "choice"
    assert merged.pattern.kind is PatternKind.CHOICE
    assert len(merged.pattern.children) == 2


def test_repeated_start_declarations_combine_in_both_syntaxes() -> None:
    """`start |=` / `<start combine="choice">` state one start, not the last one wins."""
    compact = parse_relaxng(
        "start |= element a { text }\nstart |= element b { text }\n", source_label="s.rnc"
    )
    xml = parse_relaxng(
        '<grammar xmlns="http://relaxng.org/ns/structure/1.0">'
        '<start combine="choice"><element name="a"><text/></element></start>'
        '<start combine="choice"><element name="b"><text/></element></start>'
        "</grammar>",
        source_label="s.rng",
    )
    assert compact.start.kind is PatternKind.CHOICE
    assert len(compact.start.children) == 2
    assert dataclasses.replace(compact, raw="", syntax="") == dataclasses.replace(
        xml, raw="", syntax=""
    )


def test_combine_defines_rejects_a_conflicting_merge() -> None:
    pattern = parse_relaxng(CATALOGUE_RNG).start
    with pytest.raises(ValueError, match="conflicting"):
        combine_defines([("x", pattern, "choice"), ("x", pattern, "interleave")])


# ---------------------------------------------------------------------------
# AC 2: composition across a fileset, SSRF-guarded remote refs
# ---------------------------------------------------------------------------


def test_include_merges_and_overrides_across_a_fileset(
    adapter: RelaxNgImportSource,
) -> None:
    members = _members("03-modular-set")
    document = adapter.parse_fileset(IntakeFileset.from_members(members, root="main.rng"))
    assert document.includes == ("address.rng",)
    defines = document.define_map()
    # `address` comes from the included module...
    assert "address" in defines
    # ...and `postalCode` is the *including* grammar's override, not the module's.
    assert dict(defines["postalCode"].pattern.params) == {"pattern": "[0-9]{4} [A-Z]{2}"}


def test_external_ref_substitutes_the_referenced_pattern(
    adapter: RelaxNgImportSource,
) -> None:
    members = _members("03-modular-set")
    document = adapter.parse_fileset(IntakeFileset.from_members(members, root="main.rng"))
    assert document.external_refs == ("parcel.rng",)
    api = adapter.normalize(document)
    # `parcelContent` only exists in parcel.rng, so its presence proves substitution ran.
    assert any(
        entity.extras.get("relaxng_element") == "parcelContent" for entity in api.types
    )


def test_a_reference_the_set_does_not_supply_is_an_unresolved_reference(
    adapter: RelaxNgImportSource,
) -> None:
    lone = _members("03-modular-set")["main.rng"]
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(lone, source_label="main.rng")
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


def test_a_ref_to_an_undefined_named_pattern_is_reported(
    adapter: RelaxNgImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture("negative/06-unresolvable-ref.rng"))
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"
    assert "money" in str(excinfo.value)


def test_a_remote_href_is_recorded_never_fetched(adapter: RelaxNgImportSource) -> None:
    remote = (
        '<grammar xmlns="http://relaxng.org/ns/structure/1.0">\n'
        '  <include href="https://example.com/module.rng"/>\n'
        '  <start><element name="a"><text/></element></start>\n'
        "</grammar>\n"
    )
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(remote, source_label="remote.rng")
    # The href is legal in shape but never retrieved, so what it would have defined is
    # absent — which surfaces as an unresolved reference, not as a smaller grammar.
    assert excinfo.value.code == "INPUT_REFERENCE_UNRESOLVED"


@pytest.mark.parametrize(
    "href",
    ["file:///etc/passwd", "data:text/xml,<grammar/>", "https://user:pw@example.com/m.rng"],
)
def test_an_ssrf_forbidden_href_is_an_unsafe_construct(href: str) -> None:
    with pytest.raises(RelaxNgParseError) as excinfo:
        resolve_href(href, members={}, base=None, limits=LimitRecorder())
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


def test_href_resolution_prefers_the_referring_documents_directory() -> None:
    members = {"a/main.rng": "root", "b/mod.rng": "wrong", "a/mod.rng": "right"}
    resolved = resolve_href("mod.rng", members=members, base="a/main.rng", limits=LimitRecorder())
    assert resolved == ("a/mod.rng", "right")


def test_a_composition_cycle_is_bounded(adapter: RelaxNgImportSource) -> None:
    looping = (
        '<grammar xmlns="http://relaxng.org/ns/structure/1.0">\n'
        '  <include href="loop.rng"/>\n'
        '  <start><element name="a"><text/></element></start>\n'
        "</grammar>\n"
    )
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse_fileset(
            IntakeFileset.from_members({"loop.rng": looping}, root="loop.rng")
        )
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_fileset_without_its_root_is_rejected(adapter: RelaxNgImportSource) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse_fileset(
            IntakeFileset(root="missing.rng", members={"a.rng": CATALOGUE_RNG})
        )
    assert excinfo.value.code == "INPUT_SEMANTIC_INVALID"


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def test_named_patterns_become_canonical_types(adapter: RelaxNgImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.rng")))
    by_name = {entity.name: entity for entity in api.types}
    assert set(by_name) == {"catalogue", "money", "product"}
    assert by_name["product"].kind is TypeKind.RECORD


def test_attributes_and_elements_become_fields_with_their_cardinality(
    adapter: RelaxNgImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.rng")))
    product = next(entity for entity in api.types if entity.name == "product")
    fields = {field.name: field for field in product.fields}
    assert fields["sku"].extras["relaxng_kind"] == "attribute"
    assert fields["sku"].constraints.pattern == "[A-Z]{3}-[0-9]{4}"
    # `optional` -> nullable, `zeroOrMore` -> a nullable list.
    assert fields["discontinued"].type.nullable is True
    assert fields["tag"].type.item is not None
    assert fields["name"].type.nullable is False


def test_a_choice_of_literal_values_becomes_an_enum_constraint(
    adapter: RelaxNgImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.rng")))
    money = next(entity for entity in api.types if entity.name == "money")
    currency = next(field for field in money.fields if field.name == "currency")
    assert currency.constraints.enum == ["EUR", "GBP", "USD"]


def test_a_choice_of_patterns_becomes_a_union(adapter: RelaxNgImportSource) -> None:
    api = adapter.normalize(
        adapter.parse(_fixture("07-composition-named-pattern-reuse.rng"))
    )
    block = next(entity for entity in api.types if entity.name == "block")
    assert block.kind is TypeKind.UNION
    assert len(block.union_members) == 2
    assert all(member in {t.key for t in api.types} for member in block.union_members)


def test_a_combine_choice_pattern_becomes_one_union(adapter: RelaxNgImportSource) -> None:
    api = adapter.normalize(
        adapter.parse(_fixture("07-composition-named-pattern-reuse.rng"))
    )
    inline_element = next(entity for entity in api.types if entity.name == "inlineElement")
    assert inline_element.kind is TypeKind.UNION
    assert inline_element.extras["relaxng_combine"] == "choice"
    assert len(inline_element.union_members) == 3


def test_a_text_only_named_pattern_becomes_a_scalar(adapter: RelaxNgImportSource) -> None:
    members = _members("03-modular-set")
    api = adapter.normalize(
        adapter.parse_fileset(IntakeFileset.from_members(members, root="main.rng"))
    )
    postal = next(entity for entity in api.types if entity.name == "postalCode")
    assert postal.kind is TypeKind.SCALAR
    assert postal.constraints.pattern == "[0-9]{4} [A-Z]{2}"


def test_datatype_parameters_become_canonical_constraints() -> None:
    document = parse_relaxng(
        '<element xmlns="http://relaxng.org/ns/structure/1.0" name="a"\n'
        '         datatypeLibrary="http://www.w3.org/2001/XMLSchema-datatypes">\n'
        '  <attribute name="code"><data type="token">'
        '<param name="length">4</param></data></attribute>\n'
        '  <attribute name="qty"><data type="int">'
        '<param name="minInclusive">1</param><param name="maxInclusive">9</param></data></attribute>\n'
        "  <text/>\n"
        "</element>\n"
    )
    api = RelaxNgImportSource().normalize(document)
    fields = {field.name: field for field in api.types[0].fields}
    assert fields["code"].constraints.min_length == 4
    assert fields["code"].constraints.max_length == 4
    assert fields["qty"].constraints.minimum == 1
    assert fields["qty"].constraints.maximum == 9
    assert fields["qty"].type.name == "i32"


def test_a_named_pattern_is_referenced_rather_than_copied(
    adapter: RelaxNgImportSource,
) -> None:
    """A content model reused in several places must not grow one anonymous copy per use."""
    api = adapter.normalize(adapter.parse(_fixture("05-real-world-article-grammar.rng")))
    names = [entity.name for entity in api.types]
    assert names.count("inline") == 1
    assert not [name for name in names if name.startswith("infoTitleChoice")]


def test_normalize_rejects_a_foreign_ast(adapter: RelaxNgImportSource) -> None:
    with pytest.raises(ImportSourceError):
        adapter.normalize({"not": "a grammar"})


def test_fingerprint_is_stable_across_repeated_imports(
    adapter: RelaxNgImportSource,
) -> None:
    first = adapter.normalize(adapter.parse(_fixture("05-real-world-article-grammar.rng")))
    second = adapter.normalize(adapter.parse(_fixture("05-real-world-article-grammar.rng")))
    assert canonical_fingerprint(first) == canonical_fingerprint(second)


def test_routing_sends_relaxng_to_the_catalog(adapter: RelaxNgImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("01-minimal-note.rng")))
    decision = decide_import_routing(adapter, api)
    assert decision.target is ImportTarget.CATALOG
    assert decision.publishable is False


def test_lint_produces_a_scored_report(adapter: RelaxNgImportSource) -> None:
    api = adapter.normalize(adapter.parse(_fixture("05-real-world-article-grammar.rng")))
    report = adapter.lint(api)
    assert report.score is not None and report.grade is not None


# ---------------------------------------------------------------------------
# AC 3: declared limits, never silent omissions
# ---------------------------------------------------------------------------


def test_every_declared_limit_key_has_reviewed_wording() -> None:
    assert set(RELAXNG_CAPABILITIES.unsupported) == set(LIMIT_DETAILS)


def test_the_capability_registry_publishes_the_limits() -> None:
    capability = capability_for("relaxng")
    assert capability.provenance is CapabilityProvenance.REVIEWED
    assert capability.canonical_projection.coverage is ProjectionCoverage.PARTIAL
    assert "relaxng.interleave" in capability.unsupported_constructs
    assert "relaxng.interleave" in capability.canonical_projection.dropped_constructs
    assert set(capability.canonical_projection.dropped_constructs) <= set(LIMIT_DETAILS)


def test_interleave_is_declared_and_its_members_are_tagged(
    adapter: RelaxNgImportSource,
) -> None:
    document = adapter.parse(_fixture("05-real-world-article-grammar.rng"))
    limits = {limit.construct: limit for limit in document.declared_limits}
    assert "relaxng.interleave" in limits
    assert limits["relaxng.interleave"].locations == ("info",)

    api = adapter.normalize(document)
    info = next(entity for entity in api.types if entity.name == "info")
    # Every branch survives as a member; only the order-independence is inexpressible.
    assert {field.name for field in info.fields} >= {"title", "author", "published", "keyword"}
    assert all(field.extras.get("relaxng_interleaved") for field in info.fields)


def test_the_stress_grammar_declares_every_limit_it_exercises(
    adapter: RelaxNgImportSource,
) -> None:
    document = adapter.parse(_fixture("04-stress-interleave-and-datatypes.rng"))
    constructs = {limit.construct for limit in document.declared_limits}
    assert constructs == {
        "relaxng.datatype_except",
        "relaxng.interleave",
        "relaxng.list",
        "relaxng.mixed",
        "relaxng.name_class_wildcard",
    }


def test_an_uninterpreted_datatype_library_is_declared() -> None:
    document = parse_relaxng(
        '<element xmlns="http://relaxng.org/ns/structure/1.0" name="a"\n'
        '         datatypeLibrary="urn:acme:types">\n'
        '  <data type="widget"/>\n'
        "</element>\n"
    )
    constructs = {limit.construct for limit in document.declared_limits}
    assert "relaxng.external_datatype_library" in constructs
    api = RelaxNgImportSource().normalize(document)
    # The type name is carried verbatim rather than guessed at.
    assert api.types[0].extras["relaxng_datatype"] == "widget"


def test_a_wildcard_name_class_becomes_one_open_content_member(
    adapter: RelaxNgImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-interleave-and-datatypes.rng")))
    any_element = next(entity for entity in api.types if entity.name == "anyElement")
    assert any_element.extras["relaxng_name_class"] == "*"


def test_the_extras_key_is_registered_as_provenance() -> None:
    assert RELAXNG_EXTRAS_KEY in PROVENANCE_EXTRA_KEYS


def test_preview_manifest_renders_a_row_per_declared_limit(
    adapter: RelaxNgImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("04-stress-interleave-and-datatypes.rng")))
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(api, adapter_key="relaxng", options={})
    )
    rows = {
        entry.source_construct: entry
        for entry in page.coverage
        if entry.source_construct.startswith("relaxng.")
    }
    assert set(rows) == {
        "relaxng.datatype_except",
        "relaxng.interleave",
        "relaxng.list",
        "relaxng.mixed",
        "relaxng.name_class_wildcard",
    }
    assert rows["relaxng.interleave"].coverage is CoverageClass.PARTIALLY_MAPPED
    assert "capability limit" in rows["relaxng.interleave"].detail
    assert "record" in rows["relaxng.interleave"].detail


def test_a_grammar_with_no_limits_renders_no_limit_rows(
    adapter: RelaxNgImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_fixture("02-typical-catalogue.rng")))
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(api, adapter_key="relaxng", options={})
    )
    assert not [
        entry for entry in page.coverage if entry.source_construct.startswith("relaxng.")
    ]


def test_version_coverage_declares_both_syntaxes_and_no_writer() -> None:
    coverage = version_coverage_for("relaxng")
    assert coverage.declared is True
    assert coverage.read_format_keys == ["relaxng", "relaxng-compact"]
    assert all(row.support is VersionSupport.UNGATED for row in coverage.reads)
    # RELAX NG output is #4134, so the format is import-only today.
    assert coverage.writes == ()
    assert coverage.default_write is None


# ---------------------------------------------------------------------------
# AC 4: the corpus covers the four shapes, and malformed grammars are rejected
# ---------------------------------------------------------------------------


def test_the_corpus_covers_the_four_required_shapes() -> None:
    assert (CORPUS / "05-real-world-article-grammar.rng").is_file()  # document grammar
    assert (CORPUS / "03-modular-set" / "main.rng").is_file()  # modular with includes
    assert (CORPUS / "06-compact-catalogue.rnc").is_file()  # compact syntax
    assert (CORPUS / "negative" / "01-syntactic-unclosed-define.rng").is_file()  # malformed


@pytest.mark.parametrize(
    ("fixture", "code"),
    [
        ("negative/01-syntactic-unclosed-define.rng", None),
        ("negative/02-semantic-grammar-without-start.rng", "INPUT_SEMANTIC_INVALID"),
        ("negative/03-truncated-mid-pattern.rng", None),
        ("negative/04-wrong-format-xsd.xsd", None),
        ("negative/06-unresolvable-ref.rng", "INPUT_REFERENCE_UNRESOLVED"),
    ],
)
def test_negative_fixtures_are_rejected_with_their_declared_code(
    adapter: RelaxNgImportSource, fixture: str, code: str | None
) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(_fixture(fixture), source_label=fixture)
    # A `None` code is deliberate: the reader does not classify a well-formedness fault, so
    # the pipeline attributes it (INPUT_MALFORMED, or FORMAT_MISMATCH when another adapter
    # confidently claims the document).
    assert excinfo.value.code == code


def test_a_dtd_is_refused_by_the_hardened_reader(adapter: RelaxNgImportSource) -> None:
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(
            '<!DOCTYPE grammar [<!ENTITY x "y">]>\n'
            '<grammar xmlns="http://relaxng.org/ns/structure/1.0">\n'
            '  <start><element name="a"><text/></element></start>\n'
            "</grammar>\n"
        )
    assert excinfo.value.code == "INPUT_UNSAFE_CONSTRUCT"


def test_empty_input_is_rejected(adapter: RelaxNgImportSource) -> None:
    with pytest.raises(ImportSourceError):
        adapter.parse("   ")


# ---------------------------------------------------------------------------
# Adversarial input: a hostile grammar must fail, never crash the pipeline
# ---------------------------------------------------------------------------


def test_a_deeply_nested_compact_grammar_is_bounded_not_recursive(
    adapter: RelaxNgImportSource,
) -> None:
    """IXH-1.3: adversarial input must never 5xx, so recursive descent is bounded."""
    depth = MAX_COMPACT_DEPTH * 4
    deep = "start = element a { " + "(" * depth + "text" + ")" * depth + " }\n"
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(deep, source_label="deep.rnc")
    assert excinfo.value.code == "INPUT_DEPTH_LIMIT"


def test_an_oversized_compact_grammar_is_refused(adapter: RelaxNgImportSource) -> None:
    oversized = "# " + ("x" * (MAX_COMPACT_BYTES + 16)) + "\nstart = element a { text }\n"
    with pytest.raises(ImportSourceError) as excinfo:
        adapter.parse(oversized, source_label="big.rnc")
    assert excinfo.value.code == "INPUT_TOO_LARGE"


def test_a_named_pattern_cycle_terminates(adapter: RelaxNgImportSource) -> None:
    """`a = b` / `b = a` is accepted by the parser, so normalization must not spin on it."""
    api = adapter.normalize(
        adapter.parse("start = a\na = b\nb = a | element z { text }\n", source_label="cycle.rnc")
    )
    assert {entity.name for entity in api.types} >= {"a", "b"}
