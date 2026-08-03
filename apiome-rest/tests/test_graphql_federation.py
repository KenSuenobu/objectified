"""Tests for GraphQL Federation supergraph/subgraph support (IXH-7.6, #5131).

Covers the acceptance criteria end to end over the real parser/normalizer/
emitter chain (``graphql-core`` is a first-class dependency — nothing here is
tool-gated except the ``rover`` wrapper, which is exercised with a fake runner):

* supergraph SDL and subgraph sets both import, with per-type / per-field
  subgraph ownership recorded in canonical ``extras``;
* the canonical diff attributes each change to its owning subgraph (the
  ``graphql`` :class:`~app.diff.DiffLabeler`);
* composition errors surface as ``composition``-category lint findings naming
  the offending subgraph (pure checks + the ``rover`` verdict rule);
* federation directives are preserved rather than stripped — through the
  stored SDL (:func:`~app.graphql_federation.print_schema_with_directives`)
  and through a GraphQL→GraphQL emit round-trip.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest
from graphql import parse

from app.diff import diff
from app.fileset import IntakeFileset
from app.graphql_emitter import GraphQlEmitter
from app.graphql_federation import (
    FEDERATION_EXTENSIONS_KEY,
    CompositionFinding,
    FederationInfo,
    SubgraphRef,
    _rover_findings_from_output,
    attach_directive_applications,
    check_composition,
    compose_subgraphs,
    compose_subgraphs_sync,
    document_federation_role,
    federation_prelude_document,
    print_schema_with_directives,
    subgraph_name_from_label,
    subgraph_set_info,
    supergraph_info,
)
from app.graphql_import_source import GraphQlImportSource
from app.graphql_lint import lint_graphql_result
from app.graphql_parser import build_graphql_schema, build_schema_from_sources

# ===========================================================================
# Fixtures: a three-subgraph storefront and its composed supergraph
# ===========================================================================

_PRODUCTS_SDL = '''
extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable"])

type Query {
  product(id: ID!): Product
  topProducts(first: Int = 5): [Product!]
}

type Product @key(fields: "id") {
  id: ID!
  name: String!
  priceCents: Int!
  weightGrams: Int @shareable
}
'''

_REVIEWS_SDL = '''
extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@external", "@requires"])

type Query {
  latestReviews(limit: Int = 10): [Review!]
}

type Review {
  id: ID!
  body: String!
  product: Product!
}

type Product @key(fields: "id") {
  id: ID!
  priceCents: Int! @external
  reviews: [Review!]
  valueScore: Float @requires(fields: "priceCents")
}
'''

_INVENTORY_SDL = '''
extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable"])

type Query {
  inStock: [Product!]
}

type Product @key(fields: "id") {
  id: ID!
  weightGrams: Int @shareable
  unitsInStock: Int!
}
'''

_SUPERGRAPH_SDL = '''
schema @link(url: "https://specs.apollo.dev/link/v1.0")
  @link(url: "https://specs.apollo.dev/join/v0.3", for: EXECUTION) {
  query: Query
}

directive @join__field(graph: join__Graph, requires: join__FieldSet, provides: join__FieldSet,
  type: String, external: Boolean, override: String, usedOverridden: Boolean
) repeatable on FIELD_DEFINITION | INPUT_FIELD_DEFINITION

directive @join__graph(name: String!, url: String!) on ENUM_VALUE

directive @join__type(graph: join__Graph!, key: join__FieldSet, extension: Boolean! = false,
  resolvable: Boolean! = true, isInterfaceObject: Boolean! = false
) repeatable on OBJECT | INTERFACE | UNION | ENUM | INPUT_OBJECT | SCALAR

directive @link(url: String, as: String, for: link__Purpose, import: [link__Import]) repeatable on SCHEMA

scalar join__FieldSet

scalar link__Import

enum link__Purpose {
  SECURITY
  EXECUTION
}

enum join__Graph {
  PRODUCTS @join__graph(name: "products", url: "http://products.local/graphql")
  REVIEWS @join__graph(name: "reviews", url: "http://reviews.local/graphql")
}

type Query @join__type(graph: PRODUCTS) @join__type(graph: REVIEWS) {
  topProducts: [Product] @join__field(graph: PRODUCTS)
  latestReviews: [Review] @join__field(graph: REVIEWS)
}

type Product @join__type(graph: PRODUCTS, key: "id") @join__type(graph: REVIEWS, key: "id") {
  id: ID!
  name: String! @join__field(graph: PRODUCTS)
  priceCents: Int! @join__field(graph: PRODUCTS) @join__field(graph: REVIEWS, external: true)
  reviews: [Review!] @join__field(graph: REVIEWS)
}

type Review @join__type(graph: REVIEWS) {
  id: ID!
  body: String
}
'''

_PLAIN_SDL = "type Query { hello: String }"


def _subgraph_fileset() -> IntakeFileset:
    return IntakeFileset.from_members(
        {
            "products.graphql": _PRODUCTS_SDL,
            "reviews.graphql": _REVIEWS_SDL,
            "inventory.graphql": _INVENTORY_SDL,
        },
        root="products.graphql",
    )


def _subgraph_set_model():
    source = GraphQlImportSource()
    return source.normalize(source.parse_fileset(_subgraph_fileset()))


def _supergraph_model():
    source = GraphQlImportSource()
    return source.normalize(source.parse(_SUPERGRAPH_SDL))


# ===========================================================================
# Role detection + definition prelude
# ===========================================================================


class TestRoleDetection:
    def test_supergraph_recognized_by_join_machinery(self) -> None:
        assert document_federation_role(parse(_SUPERGRAPH_SDL)) == "supergraph"

    def test_subgraph_recognized_by_federation_directives(self) -> None:
        assert document_federation_role(parse(_PRODUCTS_SDL)) == "subgraph"

    def test_subgraph_recognized_by_federation_link_alone(self) -> None:
        sdl = '''
        extend schema @link(url: "https://specs.apollo.dev/federation/v2.3")
        type Query { ping: String }
        '''
        assert document_federation_role(parse(sdl)) == "subgraph"

    def test_plain_sdl_is_neither(self) -> None:
        assert document_federation_role(parse(_PLAIN_SDL)) is None


class TestFederationPrelude:
    def test_injects_only_missing_used_definitions(self) -> None:
        prelude = federation_prelude_document([parse(_PRODUCTS_SDL)])
        assert prelude is not None
        names = {definition.name.value for definition in prelude.definitions}
        # @key/@shareable/@link are applied; their support types ride along.
        assert {"key", "shareable", "link"} <= names
        assert "federation__FieldSet" in names
        # @requires is not applied in the products subgraph → not injected.
        assert "requires" not in names

    def test_author_defined_directives_are_not_overridden(self) -> None:
        sdl = '''
        directive @key(fields: String!) repeatable on OBJECT
        type Query { a: A }
        type A @key(fields: "id") { id: ID! }
        '''
        assert federation_prelude_document([parse(sdl)]) is None

    def test_plain_sdl_gets_no_prelude(self) -> None:
        assert federation_prelude_document([parse(_PLAIN_SDL)]) is None

    def test_subgraph_sdl_builds_without_hand_written_definitions(self) -> None:
        # The load-bearing behavior: real-world subgraph SDL (no directive
        # definitions) builds through the standard validate/build pipeline.
        schema = build_graphql_schema(_PRODUCTS_SDL)
        assert schema.type_map["Product"] is not None


# ===========================================================================
# Ownership extraction
# ===========================================================================


class TestSupergraphInfo:
    def test_roster_types_and_fields(self) -> None:
        info = supergraph_info(build_graphql_schema(_SUPERGRAPH_SDL))
        assert info is not None and info.role == "supergraph"
        assert [(ref.name, ref.url) for ref in info.subgraphs] == [
            ("products", "http://products.local/graphql"),
            ("reviews", "http://reviews.local/graphql"),
        ]
        assert info.type_owners["Product"] == ["products", "reviews"]
        assert info.type_owners["Review"] == ["reviews"]
        # Declared @join__field wins; no @join__field inherits the type owners.
        assert info.field_owners["Product.name"] == ["products"]
        assert info.field_owners["Product.id"] == ["products", "reviews"]
        assert info.field_owners["Query.topProducts"] == ["products"]

    def test_external_join_field_is_not_ownership(self) -> None:
        info = supergraph_info(build_graphql_schema(_SUPERGRAPH_SDL))
        assert info is not None
        assert info.field_owners["Product.priceCents"] == ["products"]

    def test_join_machinery_types_stay_unowned(self) -> None:
        info = supergraph_info(build_graphql_schema(_SUPERGRAPH_SDL))
        assert info is not None
        assert "join__Graph" not in info.type_owners
        assert "link__Purpose" not in info.type_owners

    def test_non_supergraph_returns_none(self) -> None:
        assert supergraph_info(build_graphql_schema(_PLAIN_SDL)) is None


class TestSubgraphSetInfo:
    def test_per_file_ownership(self) -> None:
        sources = [
            (label, parse(text), text)
            for label, text in (
                ("products.graphql", _PRODUCTS_SDL),
                ("reviews.graphql", _REVIEWS_SDL),
                ("inventory.graphql", _INVENTORY_SDL),
            )
        ]
        info = subgraph_set_info(sources)
        assert info is not None and info.role == "subgraph"
        assert [ref.name for ref in info.subgraphs] == [
            "inventory",
            "products",
            "reviews",
        ]
        assert info.type_owners["Product"] == ["inventory", "products", "reviews"]
        assert info.field_owners["Product.name"] == ["products"]
        assert info.field_owners["Product.reviews"] == ["reviews"]
        # @external stubs are references, not resolvers.
        assert info.field_owners["Product.priceCents"] == ["products"]
        assert info.subgraph_sdls["reviews"] == _REVIEWS_SDL

    def test_plain_sources_yield_none(self) -> None:
        assert subgraph_set_info([("a.graphql", parse(_PLAIN_SDL), _PLAIN_SDL)]) is None

    @pytest.mark.parametrize(
        ("label", "index", "expected"),
        [
            ("12-set/products.graphql", 0, "products"),
            ("reviews.graphql", 3, "reviews"),
            ("source[0]", 0, "subgraph"),
            (None, 2, "subgraph-2"),
            ("weird name!.graphql", 0, "weird-name"),
        ],
    )
    def test_subgraph_name_from_label(
        self, label: Optional[str], index: int, expected: str
    ) -> None:
        assert subgraph_name_from_label(label, index) == expected


# ===========================================================================
# Canonical model integration (normalizer)
# ===========================================================================


class TestNormalizerIntegration:
    def test_subgraph_set_extras_and_raw(self) -> None:
        model = _subgraph_set_model()
        assert model.extras["federation"] == {
            "role": "subgraph",
            "subgraphs": [
                {"name": "inventory"},
                {"name": "products"},
                {"name": "reviews"},
            ],
        }
        product = model.type_by_key("Product")
        assert product.extras["subgraphs"] == ["inventory", "products", "reviews"]
        owners = {field.key: field.extras.get("subgraphs") for field in product.fields}
        assert owners["Product.name"] == ["products"]
        assert owners["Product.unitsInStock"] == ["inventory"]
        operations = {
            operation.key: operation.extras.get("subgraphs")
            for service in model.services
            for operation in service.operations
        }
        assert operations["Query.latestReviews"] == ["reviews"]
        assert set(model.raw["subgraphs"]) == {"inventory", "products", "reviews"}
        # Schema-level @link applications are preserved on the artifact.
        assert any("@link(" in item for item in model.extras["directives"])

    def test_supergraph_extras(self) -> None:
        model = _supergraph_model()
        assert model.extras["federation"]["role"] == "supergraph"
        assert model.extras["federation"]["subgraphs"][0] == {
            "name": "products",
            "url": "http://products.local/graphql",
        }
        product = model.type_by_key("Product")
        assert product.extras["subgraphs"] == ["products", "reviews"]
        assert any(
            item.startswith("@join__type") for item in product.extras["directives"]
        )
        # Root-type @join__type applications live on the service.
        query = next(service for service in model.services if service.key == "Query")
        assert query.extras["subgraphs"] == ["products", "reviews"]
        assert any(
            item.startswith("@join__type") for item in query.extras["directives"]
        )

    def test_raw_sdl_keeps_applied_directives(self) -> None:
        model = _supergraph_model()
        assert "@join__type(graph: PRODUCTS, key: \"id\")" in model.raw["sdl"]
        assert "@join__graph(name: \"products\"" in model.raw["sdl"]

    def test_plain_sdl_gains_no_federation_extras(self) -> None:
        source = GraphQlImportSource()
        model = source.normalize(source.parse(_PLAIN_SDL))
        assert "federation" not in model.extras
        assert "directives" not in model.extras
        assert "subgraphs" not in (model.raw or {})

    def test_fingerprint_is_stable_across_reimports(self) -> None:
        from app.import_source import canonical_fingerprint

        first = canonical_fingerprint(_subgraph_set_model())
        second = canonical_fingerprint(_subgraph_set_model())
        assert first == second


# ===========================================================================
# Directive preservation (printer + emitter round-trip)
# ===========================================================================


class TestDirectivePreservation:
    def test_print_schema_with_directives_restores_applications(self) -> None:
        printed = print_schema_with_directives(build_graphql_schema(_SUPERGRAPH_SDL))
        assert "@join__type(graph: PRODUCTS, key: \"id\")" in printed
        assert "@join__field(graph: PRODUCTS)" in printed
        assert printed.lstrip().startswith("schema @link(")
        # The preserved SDL still builds.
        build_graphql_schema(printed)

    def test_print_schema_with_directives_does_not_duplicate_deprecated(self) -> None:
        sdl = '''
        type Query { old: String @deprecated(reason: "gone") }
        '''
        printed = print_schema_with_directives(build_graphql_schema(sdl))
        assert printed.count("@deprecated") == 1

    def test_emit_round_trip_preserves_federation_directives(self) -> None:
        source = GraphQlImportSource()
        base = source.normalize(source.parse(_SUPERGRAPH_SDL), include_raw=False)
        emitted = GraphQlEmitter().emit(base)
        sdl = emitted.files[0].content
        assert "directive @join__type" in sdl
        assert "@join__type(graph: PRODUCTS, key: \"id\")" in sdl
        reimported = source.normalize(source.parse(sdl), include_raw=False)
        assert diff(base, reimported).changes == []

    def test_emit_round_trip_preserves_plain_custom_directives(self) -> None:
        sdl = '''
        directive @auth(role: String!) on FIELD_DEFINITION | OBJECT
        type Query { me: User @auth(role: "user") }
        type User @auth(role: "admin") { id: ID! }
        '''
        source = GraphQlImportSource()
        base = source.normalize(source.parse(sdl), include_raw=False)
        emitted_sdl = GraphQlEmitter().emit(base).files[0].content
        reimported = source.normalize(source.parse(emitted_sdl), include_raw=False)
        assert diff(base, reimported).changes == []

    def test_attach_skips_directive_without_definition(self) -> None:
        attached, skipped = attach_directive_applications(
            "type Query {\n  hello: String\n}",
            {"Query.hello": ["@mystery(x: 1)"]},
        )
        assert attached == "type Query {\n  hello: String\n}"
        assert any("no directive definition" in reason for reason in skipped)

    def test_attach_skips_unknown_coordinate(self) -> None:
        sdl = "directive @tag(name: String!) on FIELD_DEFINITION\ntype Query { hello: String }"
        _attached, skipped = attach_directive_applications(
            sdl, {"Missing.field": ['@tag(name: "x")']}
        )
        assert any("not present" in reason for reason in skipped)

    def test_attach_synthesizes_schema_block_for_schema_level(self) -> None:
        sdl = (
            "directive @link(url: String) repeatable on SCHEMA\n"
            "type Query { hello: String }"
        )
        attached, skipped = attach_directive_applications(
            sdl, {"": ['@link(url: "https://example.com/spec")']}
        )
        assert skipped == []
        assert attached.lstrip().startswith("schema @link(")
        build_graphql_schema(attached)


# ===========================================================================
# Diff attribution
# ===========================================================================


class TestDiffAttribution:
    def test_added_field_is_attributed_to_its_subgraph(self) -> None:
        source = GraphQlImportSource()
        base = source.normalize(source.parse_fileset(_subgraph_fileset()))
        grown = _REVIEWS_SDL.replace(
            "reviews: [Review!]", "reviews: [Review!]\n  reviewCount: Int"
        )
        target_fileset = IntakeFileset.from_members(
            {
                "products.graphql": _PRODUCTS_SDL,
                "reviews.graphql": grown,
                "inventory.graphql": _INVENTORY_SDL,
            },
            root="products.graphql",
        )
        target = source.normalize(source.parse_fileset(target_fileset))
        changes = diff(base, target).changes
        added = [change for change in changes if change.key == "Product.reviewCount"]
        assert added and added[0].label == "owned by subgraph 'reviews'"

    def test_ownership_move_is_labeled_as_transition(self) -> None:
        source = GraphQlImportSource()
        base = source.normalize(source.parse(_SUPERGRAPH_SDL))
        moved = _SUPERGRAPH_SDL.replace(
            "name: String! @join__field(graph: PRODUCTS)",
            "name: String! @join__field(graph: REVIEWS)",
        )
        target = source.normalize(source.parse(moved))
        changes = diff(base, target).changes
        modified = [change for change in changes if change.key == "Product.name"]
        assert modified
        assert modified[0].label == "subgraph ownership: products → reviews"

    def test_non_federated_changes_stay_unlabeled(self) -> None:
        source = GraphQlImportSource()
        base = source.normalize(source.parse(_PLAIN_SDL))
        target = source.normalize(
            source.parse("type Query { hello: String\n  extra: Int }")
        )
        changes = diff(base, target).changes
        assert changes and all(change.label is None for change in changes)


# ===========================================================================
# Composition checks + lint dimension
# ===========================================================================


class TestCompositionChecks:
    def test_clean_set_has_no_findings(self) -> None:
        findings = check_composition(
            {
                "products": _PRODUCTS_SDL,
                "reviews": _REVIEWS_SDL,
                "inventory": _INVENTORY_SDL,
            }
        )
        assert findings == []

    def test_invalid_key_names_the_subgraph(self) -> None:
        bad = _PRODUCTS_SDL.replace('@key(fields: "id")', '@key(fields: "id uuid")')
        findings = check_composition({"products": bad, "reviews": _REVIEWS_SDL})
        rules = {(finding.rule, finding.subgraph) for finding in findings}
        assert ("invalid-key", "products") in rules

    def test_unparsable_key_selection_is_flagged(self) -> None:
        bad = _PRODUCTS_SDL.replace('@key(fields: "id")', '@key(fields: "id {")')
        findings = check_composition({"products": bad, "reviews": _REVIEWS_SDL})
        assert any(
            finding.rule == "invalid-key" and "not a valid selection" in finding.message
            for finding in findings
        )

    def test_non_shareable_duplicate_field_flags_each_subgraph(self) -> None:
        products = _PRODUCTS_SDL.replace("weightGrams: Int @shareable", "stock: Int")
        inventory = _INVENTORY_SDL.replace(
            "weightGrams: Int @shareable", "stock: Int"
        )
        findings = check_composition({"products": products, "inventory": inventory})
        flagged = {
            finding.subgraph
            for finding in findings
            if finding.rule == "non-shareable-field"
            and finding.field_name == "stock"
        }
        assert flagged == {"products", "inventory"}

    def test_shareable_everywhere_is_clean(self) -> None:
        findings = check_composition(
            {"products": _PRODUCTS_SDL, "inventory": _INVENTORY_SDL}
        )
        assert [f for f in findings if f.rule == "non-shareable-field"] == []

    def test_key_fields_are_exempt_from_shareable(self) -> None:
        # ``id`` is declared (non-@external, non-@shareable) by every subgraph.
        findings = check_composition(
            {"products": _PRODUCTS_SDL, "inventory": _INVENTORY_SDL}
        )
        assert not any(finding.field_name == "id" for finding in findings)

    def test_root_type_fields_are_exempt(self) -> None:
        findings = check_composition(
            {"products": _PRODUCTS_SDL, "reviews": _REVIEWS_SDL}
        )
        assert not any(finding.type_name == "Query" for finding in findings)

    def test_unresolvable_requires_selection(self) -> None:
        bad = _REVIEWS_SDL.replace(
            '@requires(fields: "priceCents")', '@requires(fields: "warehouse")'
        )
        findings = check_composition({"products": _PRODUCTS_SDL, "reviews": bad})
        assert any(
            finding.rule == "unresolvable-selection"
            and finding.subgraph == "reviews"
            and "'warehouse'" in finding.message
            for finding in findings
        )

    def test_unresolvable_provides_selection(self) -> None:
        reviews = _REVIEWS_SDL.replace(
            "product: Product!", 'product: Product! @provides(fields: "nope")'
        )
        findings = check_composition({"products": _PRODUCTS_SDL, "reviews": reviews})
        assert any(
            finding.rule == "unresolvable-selection" and "@provides" in finding.message
            for finding in findings
        )


class TestCompositionLintDimension:
    def test_composition_errors_surface_as_lint_findings(self) -> None:
        source = GraphQlImportSource()
        bad_products = _PRODUCTS_SDL.replace(
            '@key(fields: "id")', '@key(fields: "id uuid")'
        )
        fileset = IntakeFileset.from_members(
            {"products.graphql": bad_products, "reviews.graphql": _REVIEWS_SDL},
            root="products.graphql",
        )
        model = source.normalize(source.parse_fileset(fileset))
        report = source.lint(model)
        composition = [
            finding for finding in report.findings if finding.category == "composition"
        ]
        assert composition, "composition findings expected"
        assert all(finding.severity == "error" for finding in composition)
        invalid_key = [
            finding
            for finding in composition
            if finding.rule == "graphql.composition-invalid-key"
        ]
        assert invalid_key and "subgraph 'products'" in invalid_key[0].message

    def test_clean_set_has_no_composition_findings(self) -> None:
        model = _subgraph_set_model()
        report = GraphQlImportSource().lint(model)
        assert [f for f in report.findings if f.category == "composition"] == []

    def test_rover_findings_from_raw_surface_via_lint(self) -> None:
        model = _subgraph_set_model()
        model.raw["composition"] = [
            {
                "rule": "rover",
                "subgraph": "reviews",
                "message": "[E029] field mismatch in subgraph 'reviews'",
            }
        ]
        result = lint_graphql_result(model)
        rover = [
            finding
            for finding in result.findings
            if finding.rule == "graphql.composition-error"
        ]
        assert rover and rover[0].path == "subgraphs.reviews"
        assert "E029" in rover[0].message

    def test_models_without_raw_skip_composition_rules(self) -> None:
        source = GraphQlImportSource()
        model = source.normalize(
            source.parse_fileset(_subgraph_fileset()), include_raw=False
        )
        result = lint_graphql_result(model)
        assert [f for f in result.findings if f.category == "composition"] == []

    def test_spec_machinery_names_are_exempt_from_naming_rules(self) -> None:
        model = _supergraph_model()
        result = lint_graphql_result(model)
        machinery = [
            finding
            for finding in result.findings
            if finding.rule == "graphql.naming-type-pascal-case"
            and "__" in finding.message
        ]
        assert machinery == []


# ===========================================================================
# rover supergraph compose wrapper
# ===========================================================================


class _FakeRunner:
    """Captures the rover invocation and replays a canned stdout."""

    def __init__(self, stdout: str) -> None:
        self.stdout = stdout
        self.calls: List[Dict[str, Any]] = []

    async def run_spec(self, spec: Any, args: Any, **kwargs: Any) -> Any:
        import pathlib

        config_path = args[args.index("--config") + 1]
        self.calls.append(
            {
                "spec_key": spec.key,
                "args": list(args),
                "config": pathlib.Path(config_path).read_text(),
                "files": sorted(
                    p.name for p in pathlib.Path(config_path).parent.iterdir()
                ),
            }
        )
        return SimpleNamespace(stdout=self.stdout)


_ROVER_ERROR_OUTPUT = """
{
  "json_version": "1",
  "data": {"success": false},
  "error": {
    "message": "composition failed",
    "code": "E029",
    "details": {
      "build_errors": [
        {
          "message": "Field \\"Product.name\\" is not @shareable",
          "code": "INVALID_FIELD_SHARING",
          "nodes": [{"subgraph": "reviews", "source": "reviews.graphql"}]
        }
      ]
    }
  }
}
"""


class TestRoverWrapper:
    @pytest.mark.asyncio
    async def test_compose_materialises_config_and_maps_errors(self) -> None:
        runner = _FakeRunner(_ROVER_ERROR_OUTPUT)
        findings = await compose_subgraphs(
            [SubgraphRef(name="products"), SubgraphRef(name="reviews", url="http://r")],
            {"products": _PRODUCTS_SDL, "reviews": _REVIEWS_SDL},
            runner=runner,
        )
        assert findings == [
            CompositionFinding(
                rule="rover",
                subgraph="reviews",
                message='[INVALID_FIELD_SHARING] Field "Product.name" is not @shareable',
            )
        ]
        call = runner.calls[0]
        assert call["spec_key"] == "rover"
        assert call["args"][:2] == ["--config", call["args"][1]]
        assert "--format" in call["args"] and "json" in call["args"]
        assert "products.graphql" in call["files"]
        assert "routing_url: http://r" in call["config"]
        assert "federation_version" in call["config"]

    @pytest.mark.asyncio
    async def test_clean_compose_returns_empty_list(self) -> None:
        runner = _FakeRunner('{"json_version": "1", "data": {"success": true}}')
        findings = await compose_subgraphs(
            [SubgraphRef(name="products")], {"products": _PRODUCTS_SDL}, runner=runner
        )
        assert findings == []

    @pytest.mark.asyncio
    async def test_unparseable_output_yields_no_verdict(self) -> None:
        runner = _FakeRunner("error: could not fetch composition plugin")
        findings = await compose_subgraphs(
            [SubgraphRef(name="products")], {"products": _PRODUCTS_SDL}, runner=runner
        )
        assert findings is None

    def test_environmental_error_yields_no_verdict(self) -> None:
        payload = '{"error": {"message": "no plugin", "code": "E010", "details": {}}}'
        assert _rover_findings_from_output(payload) is None

    def test_sync_bridge_skips_when_rover_unavailable(self, monkeypatch) -> None:
        import app.toolchain_runner as toolchain_runner

        monkeypatch.setattr(toolchain_runner, "is_tool_available", lambda key: False)
        result = compose_subgraphs_sync(
            [SubgraphRef(name="products")], {"products": _PRODUCTS_SDL}
        )
        assert result is None

    def test_import_source_attaches_rover_findings(self, monkeypatch) -> None:
        import app.graphql_federation as graphql_federation

        finding = CompositionFinding(
            rule="rover", subgraph="reviews", message="[E029] boom"
        )
        monkeypatch.setattr(
            graphql_federation,
            "compose_subgraphs_sync",
            lambda subgraphs, sdls: [finding],
        )
        source = GraphQlImportSource()
        model = source.normalize(source.parse_fileset(_subgraph_fileset()))
        assert model.raw["composition"] == [
            {"rule": "rover", "subgraph": "reviews", "message": "[E029] boom"}
        ]
        report = source.lint(model)
        assert any(
            finding.rule == "graphql.composition-error" for finding in report.findings
        )


# ===========================================================================
# Parser extension stash
# ===========================================================================


class TestParserStash:
    def test_built_schema_carries_federation_info(self) -> None:
        schema = build_schema_from_sources(
            [
                ("products.graphql", _PRODUCTS_SDL),
                ("reviews.graphql", _REVIEWS_SDL),
            ]
        )
        info = schema.extensions.get(FEDERATION_EXTENSIONS_KEY)
        assert isinstance(info, FederationInfo)
        assert info.role == "subgraph"
        assert [ref.name for ref in info.subgraphs] == ["products", "reviews"]

    def test_plain_schema_has_no_stash(self) -> None:
        schema = build_graphql_schema(_PLAIN_SDL)
        assert FEDERATION_EXTENSIONS_KEY not in schema.extensions
