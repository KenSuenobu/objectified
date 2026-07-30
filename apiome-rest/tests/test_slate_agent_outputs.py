"""Golden tests for the APX-3.4 agent-output generator (#2459).

Locks the deterministic, machine-readable portal outputs — `llms.txt`, the catalog /
format-capability manifest, the release manifest, `robots.txt` and the index — over the
pure :mod:`app.slate_agent_outputs` generator. Covers determinism (byte-identical output
and stable ETags), URL/fragment stability, capability-matches-product-state, robots
behavior for public vs private portals, the private-content-withholding gate, and a large
catalog.
"""

from __future__ import annotations

import json

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Channel,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
)
from app.slate_agent_outputs import (
    AGENT_OUTPUT_MEDIA_TYPES,
    AGENT_OUTPUTS_SCHEMA_VERSION,
    CATALOG_MANIFEST_SCHEMA_VERSION,
    RELEASE_MANIFEST_SCHEMA_VERSION,
    ChangelogSummary,
    PortalContext,
    build_agent_outputs,
    build_catalog_manifest,
    build_llms_txt,
    build_release_manifest,
    build_robots_txt,
    capabilities_for_paradigm,
    output_etag,
)

# --------------------------------------------------------------------------- fixtures


def _rest_api() -> CanonicalApi:
    """A small REST (OpenAPI) canonical API with two operations and one schema."""
    pet = Type(
        key="Pet",
        name="Pet",
        kind=TypeKind.RECORD,
        description="A pet available in the store.\nMore detail on the next line.",
    )
    tag = Type(key="Tag", name="Tag", kind=TypeKind.RECORD, deprecated=True)
    list_pets = Operation(
        key="GET /pets",
        name="listPets",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="get",
        http_path="/pets",
        description="List all pets.",
        tags=["pets", "read"],
    )
    get_pet = Operation(
        key="GET /pets/{id}",
        name="getPet",
        kind=OperationKind.REQUEST_RESPONSE,
        http_method="get",
        http_path="/pets/{id}",
        description="Fetch one pet by id.",
        deprecated=True,
    )
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        protocol="http",
        identity=ApiIdentity(name="Pet Store", namespace="com.acme.pets", id="urn:acme:petstore"),
        version="1.4.0",
        title="Pet Store API",
        description="A sample pet store.\nSecond line ignored in summary.",
        services=[Service(key="pets", name="pets", operations=[list_pets, get_pet])],
        types=[pet, tag],
        channels=[Channel(key="pet/adopted", address="pet/adopted", protocol="kafka")],
    )


def _ctx(*, indexable: bool = True, access: str = "public") -> PortalContext:
    """A portal context for the pet store portal."""
    return PortalContext(
        base_url="https://portal.apiome.dev/pet-store",
        project_name="Pet Store",
        project_slug="pet-store",
        version_label="1.0.65",
        version_record_id="11111111-1111-1111-1111-111111111111",
        published_at="2026-07-22T10:00:00+00:00",
        indexable=indexable,
        access=access,
    )


# ----------------------------------------------------------------------- determinism


def test_output_etag_is_strong_16_hex() -> None:
    etag = output_etag("hello\n")
    assert etag.startswith('"') and etag.endswith('"')
    assert len(etag) == 18  # two quotes + 16 hex
    assert output_etag("hello\n") == etag  # stable
    assert output_etag("other\n") != etag  # content-addressed


def test_bundle_is_byte_identical_across_builds() -> None:
    api, ctx = _rest_api(), _ctx()
    first = build_agent_outputs(api, ctx, latest=True)
    second = build_agent_outputs(api, ctx, latest=True)
    for name in ("index", "llms.txt", "robots.txt", "catalog", "release"):
        assert first.get(name).body == second.get(name).body
        assert first.get(name).etag == second.get(name).etag


def test_bundle_media_types_and_paths() -> None:
    bundle = build_agent_outputs(_rest_api(), _ctx())
    for name in ("index", "llms.txt", "robots.txt", "catalog", "release"):
        out = bundle.get(name)
        assert out.media_type == AGENT_OUTPUT_MEDIA_TYPES[name]
        assert out.etag == output_etag(out.body)
    # robots.txt is served from the portal root, not the version scope.
    assert bundle.get("robots.txt").path == "https://portal.apiome.dev/pet-store/robots.txt"
    assert bundle.get("llms.txt").path == "https://portal.apiome.dev/pet-store/v/1.0.65/llms.txt"


# -------------------------------------------------------------------------- llms.txt


def test_llms_txt_structure_and_links() -> None:
    body = build_llms_txt(_rest_api(), _ctx())
    lines = body.splitlines()
    assert lines[0] == "# Pet Store API"
    assert lines[2].startswith("> A sample pet store.")  # first line only
    assert "## API Reference" in lines
    assert "## Schemas" in lines
    assert "## Changelog" in lines
    # Operations render as METHOD /path with canonical version-scoped URLs.
    assert (
        "- [GET /pets](https://portal.apiome.dev/pet-store/v/1.0.65/reference/operations/"
        "operation-get-pets): List all pets." in body
    )
    # Deprecated operation is flagged.
    assert "Deprecated. Fetch one pet by id." in body
    assert body.endswith("\n")


def test_llms_txt_withheld_when_not_indexable() -> None:
    body = build_llms_txt(_rest_api(), _ctx(indexable=False, access="private"))
    assert body.startswith("# API documentation")
    assert "not published for automated agents" in body
    # No operation/schema names leak.
    assert "Pet Store" not in body
    assert "/pets" not in body


# ------------------------------------------------------------------ catalog manifest


def test_catalog_manifest_inventory_and_capabilities() -> None:
    manifest = build_catalog_manifest(_rest_api(), _ctx())
    assert manifest["schemaVersion"] == CATALOG_MANIFEST_SCHEMA_VERSION
    assert manifest["access"] == "public"
    assert manifest["counts"] == {"operations": 2, "schemas": 2, "channels": 1}
    # Capabilities reflect actual REST product state: Try It + code samples ON.
    caps = manifest["capabilities"]
    assert caps["tryIt"] is True and caps["codeSamples"] is True
    assert caps["reference"] and caps["search"] and caps["changelog"] and caps["agentOutputs"]
    assert caps["supportTier"] == "native"
    # Operations are sorted by canonical key and carry fragment + human URL.
    op_keys = [o["key"] for o in manifest["operations"]]
    assert op_keys == sorted(op_keys)
    first = manifest["operations"][0]
    assert first["fragment"] == "operation-get-pets"
    assert first["humanUrl"].endswith("/reference/operations/operation-get-pets")
    assert first["method"] == "GET" and first["path"] == "/pets"
    assert first["tags"] == ["pets", "read"]
    # Schemas carry deprecated flags and human URLs.
    tag_entry = next(s for s in manifest["schemas"] if s["name"] == "Tag")
    assert tag_entry["deprecated"] is True
    # Channels are inventoried.
    assert manifest["channels"][0]["address"] == "pet/adopted"
    assert manifest["contentDigest"].startswith("sha256:")


def test_catalog_manifest_withheld_when_not_indexable() -> None:
    manifest = build_catalog_manifest(_rest_api(), _ctx(indexable=False, access="private"))
    assert manifest["contentWithheld"] is True
    assert manifest["access"] == "private"
    assert "operations" not in manifest and "schemas" not in manifest and "api" not in manifest
    # Capabilities are product state (not content) and may still be advertised.
    assert manifest["capabilities"]["tryIt"] is True
    # No content names leak beyond the shareable base URL.
    assert manifest["portal"] == {"baseUrl": "https://portal.apiome.dev/pet-store"}


def test_capabilities_are_rest_only_for_execution() -> None:
    assert capabilities_for_paradigm(ApiParadigm.REST)["tryIt"] is True
    for paradigm in (
        ApiParadigm.RPC,
        ApiParadigm.EVENT,
        ApiParadigm.GRAPH,
        ApiParadigm.DATA_SCHEMA,
        ApiParadigm.AGENT,
    ):
        caps = capabilities_for_paradigm(paradigm)
        assert caps["tryIt"] is False
        assert caps["codeSamples"] is False
        assert caps["reference"] is True and caps["search"] is True


# ------------------------------------------------------------------ release manifest


def test_release_manifest_fields() -> None:
    manifest = build_release_manifest(
        _rest_api(),
        _ctx(),
        latest=True,
        deprecated=False,
        changelog=ChangelogSummary(breaking=1, non_breaking=2, docs_only=3),
    )
    assert manifest["schemaVersion"] == RELEASE_MANIFEST_SCHEMA_VERSION
    release = manifest["release"]
    assert release["versionLabel"] == "1.0.65"
    assert release["apiVersion"] == "1.4.0"
    assert release["latest"] is True
    assert release["canonicalUrl"] == "https://portal.apiome.dev/pet-store/v/1.0.65"
    assert release["changelogUrl"] == "https://portal.apiome.dev/pet-store/v/1.0.65/changelog"
    assert release["changes"] == {"breaking": 1, "nonBreaking": 2, "docsOnly": 3}
    assert manifest["format"]["supportTier"] == "native"


def test_release_manifest_omits_changes_when_absent() -> None:
    manifest = build_release_manifest(_rest_api(), _ctx())
    assert "changes" not in manifest["release"]


def test_release_manifest_withheld_when_not_indexable() -> None:
    manifest = build_release_manifest(_rest_api(), _ctx(indexable=False, access="private"))
    assert manifest["contentWithheld"] is True
    assert "release" not in manifest


# ------------------------------------------------------------------------ robots.txt


def test_robots_public_allows_and_advertises() -> None:
    body = build_robots_txt(_ctx())
    assert "User-agent: *" in body
    assert "Allow: /" in body
    assert "Sitemap: https://portal.apiome.dev/pet-store/sitemap.xml" in body
    assert "llms.txt" in body


def test_robots_private_disallows_everything() -> None:
    body = build_robots_txt(_ctx(indexable=False, access="private"))
    assert body == "User-agent: *\nDisallow: /\n"
    assert "Allow" not in body and "Sitemap" not in body


# ------------------------------------------------------------------------- index doc


def test_index_lists_every_output() -> None:
    bundle = build_agent_outputs(_rest_api(), _ctx(), latest=True)
    index = json.loads(bundle.get("index").body)
    assert index["schemaVersion"] == AGENT_OUTPUTS_SCHEMA_VERSION
    assert index["indexable"] is True
    assert index["access"] == "public"
    names = {o["name"] for o in index["outputs"]}
    assert names == {"llms.txt", "robots.txt", "catalog", "release"}
    for entry in index["outputs"]:
        out = bundle.get(entry["name"])
        assert entry["etag"] == out.etag
        assert entry["bytes"] == len(out.body.encode("utf-8"))
        assert entry["mediaType"] == out.media_type


def test_index_reports_private_and_still_withholds() -> None:
    bundle = build_agent_outputs(_rest_api(), _ctx(indexable=False, access="private"))
    index = json.loads(bundle.get("index").body)
    assert index["indexable"] is False
    assert index["access"] == "private"
    # The catalog/release outputs referenced by the index are the withheld variants.
    catalog = json.loads(bundle.get("catalog").body)
    assert catalog["contentWithheld"] is True


# ------------------------------------------------------- stable fragments & large catalog


def test_colliding_operation_keys_get_unique_fragments() -> None:
    # Two keys that slug to the same base must be disambiguated deterministically.
    a = Operation(key="GET /pets", name="a", kind=OperationKind.REQUEST_RESPONSE)
    b = Operation(key="get pets", name="b", kind=OperationKind.REQUEST_RESPONSE)
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="x"),
        services=[Service(key="s", name="s", operations=[a, b])],
    )
    manifest = build_catalog_manifest(api, _ctx())
    fragments = [o["fragment"] for o in manifest["operations"]]
    assert len(fragments) == len(set(fragments))  # unique
    assert all(f.startswith("operation-get-pets") for f in fragments)
    # Deterministic across rebuilds.
    again = build_catalog_manifest(api, _ctx())
    assert [o["fragment"] for o in again["operations"]] == fragments


def test_large_catalog_is_deterministic_and_unique() -> None:
    ops = [
        Operation(
            key=f"GET /resource/{i}",
            name=f"getResource{i}",
            kind=OperationKind.REQUEST_RESPONSE,
            http_method="get",
            http_path=f"/resource/{i}",
        )
        for i in range(500)
    ]
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Big"),
        title="Big API",
        services=[Service(key="s", name="s", operations=ops)],
    )
    ctx = _ctx()
    first = build_agent_outputs(api, ctx)
    second = build_agent_outputs(api, ctx)
    assert first.get("catalog").etag == second.get("catalog").etag
    manifest = json.loads(first.get("catalog").body)
    assert manifest["counts"]["operations"] == 500
    fragments = [o["fragment"] for o in manifest["operations"]]
    assert len(set(fragments)) == 500  # all unique
    keys = [o["key"] for o in manifest["operations"]]
    assert keys == sorted(keys)  # total, stable order
