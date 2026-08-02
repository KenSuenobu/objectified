"""Multi-file and archive intake explorer — IXH-3.5 (#5107).

Pins the ticket's acceptance criteria for the bundle graph
(:mod:`app.intake_bundle_graph`) and ``POST /v1/tenants/{slug}/import/bundle-inventory``:

* **every file appears with a role and a verdict**, and an ignored file always states
  *why* it was ignored — nothing a user put in the archive is allowed to vanish;
* **unresolved imports list the search paths that were tried**, in order, and an import
  the format's own toolchain supplies (protobuf well-known types) is never reported as
  missing;
* **the entry point can be overridden** — a pinned ``archive_root`` is honoured, shows
  as the selected candidate, and re-derives the whole inventory;
* **per-file contribution to canonical entities is inspectable**, by the declared
  ``declaration-scan`` attribution method (never presented as parser provenance);
* **bounded** — files are cursor-paginated with truncation stated, and a repeat request
  is served from the inventory cache rather than re-unpacking;
* **degradation** — an ambiguous root and a failed parse still return the complete file
  list, because that is the bundle the panel exists for;
* **nothing persisted** — the persistence hooks are booby-trapped for every test.
"""

from __future__ import annotations

import base64
import io
import zipfile
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

from app import import_source_pipeline
from app.archive_intake import IgnoredMember, member_skip_reason, rank_root_candidates
from app.auth import validate_authentication
from app.import_bundle_explorer import (
    DEFAULT_FILE_PAGE_SIZE,
    MAX_UNRESOLVED_LISTED,
    ImportBundleInventoryRequest,
    build_bundle_inventory,
    bundle_inventory_cache_size,
    clear_bundle_inventory_cache,
    paginate_bundle_inventory,
)
from app.import_preflight import clear_preflight_cache
from app.import_source import load_builtin_import_sources
from app.intake_bundle_graph import (
    ATTRIBUTION_METHOD,
    BundleFileRole,
    BundleFileVerdict,
    EntityRef,
    ImportResolution,
    attribute_entities,
    classify_roles,
    declared_symbols,
    diagnostics_by_member,
    extract_directives,
    reachable_from,
    resolve_bundle_imports,
    unreadable_reason,
)
from app.main import app

load_builtin_import_sources()

client = TestClient(app)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"
USER_ID = "660e8400-e29b-41d4-a716-446655440001"

_MOCK_AUTH = {
    "tenant_id": TENANT_ID,
    "tenant_slug": TENANT_SLUG,
    "user_id": USER_ID,
    "auth_method": "jwt",
}

ROUTE = f"/v1/tenants/{TENANT_SLUG}/import/bundle-inventory"

#: A proto tree whose entry point imports a sibling through the *include root*
#: (``proto/``), a compiler-provided well-known type, and one file that does not exist.
ENTRY_PROTO = """
syntax = "proto3";
package user;
import "user/types.proto";
import "google/protobuf/timestamp.proto";
import "missing/gone.proto";

service UserService {
  rpc GetUser (GetUserRequest) returns (User);
}
""".strip()

TYPES_PROTO = """
syntax = "proto3";
package user;

message User { string id = 1; }
message GetUserRequest { string id = 1; }
""".strip()

PROTO_MEMBERS: Dict[str, str] = {
    "proto/user/user_service.proto": ENTRY_PROTO,
    "proto/user/types.proto": TYPES_PROTO,
    "README.md": "# Protos\n",
}
PROTO_ENTRY = "proto/user/user_service.proto"

#: A two-file GraphQL bundle — the endpoint tests use it because the GraphQL adapter
#: needs no external toolchain, so the pre-flight really runs.
GRAPHQL_ROOT = """
# import "types.graphql"

type Query {
  order(id: ID!): Order
}
""".strip()

GRAPHQL_TYPES = """
type Order {
  id: ID!
  total: Float
}
""".strip()


def _b64(data: bytes) -> str:
    return base64.standard_b64encode(data).decode("ascii")


def _zip(members: Dict[str, str], *, extra_names: tuple = ()) -> bytes:
    """Build a real .zip so the tests exercise MFI-29.1 unpack, not a stub."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, text in members.items():
            archive.writestr(path, text)
        for name in extra_names:
            archive.writestr(name, "ignored")
    return buffer.getvalue()


def _post(payload: Dict[str, Any]):
    return client.post(ROUTE, json=payload)


def _graphql_zip_payload(**overrides: Any) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "document_base64": _b64(
            _zip(
                {"schema.graphql": GRAPHQL_ROOT, "types.graphql": GRAPHQL_TYPES},
                extra_names=("__MACOSX/._schema.graphql", ".DS_Store"),
            )
        ),
        "filename": "bundle.zip",
    }
    payload.update(overrides)
    return payload


@pytest.fixture(autouse=True)
def _auth_override():
    def _fake_auth(tenant_slug: str):
        return {**_MOCK_AUTH, "tenant_slug": tenant_slug}

    app.dependency_overrides[validate_authentication] = _fake_auth
    app.openapi_schema = None
    yield
    app.dependency_overrides.pop(validate_authentication, None)
    app.openapi_schema = None


@pytest.fixture(autouse=True)
def _clean_caches():
    """Every test starts and ends with empty pre-flight and inventory caches."""
    clear_preflight_cache()
    clear_bundle_inventory_cache()
    yield
    clear_preflight_cache()
    clear_bundle_inventory_cache()


@pytest.fixture(autouse=True)
def _no_persistence(monkeypatch):
    """Booby-trap every persistence hook: the inventory must never write anything."""

    def _trap(name: str):
        def _hook(*args: Any, **kwargs: Any):
            raise AssertionError(f"bundle inventory reached {name}")

        return _hook

    monkeypatch.setattr(
        import_source_pipeline, "persist_adapter_import", _trap("persist_adapter_import")
    )
    monkeypatch.setattr(
        import_source_pipeline, "persist_types_as_current", _trap("persist_types_as_current")
    )


def _inventory(**overrides: Any):
    """Build the proto bundle's full inventory with the entry point resolved."""
    options: Dict[str, Any] = {
        "entry_point": PROTO_ENTRY,
        "entry_point_pinned": False,
        "entry_point_error": None,
    }
    options.update(overrides)
    return build_bundle_inventory(dict(PROTO_MEMBERS), [], **options)


# ===========================================================================
# Directive extraction
# ===========================================================================


def test_extracts_proto_imports_with_line_numbers():
    directives = extract_directives("a.proto", ENTRY_PROTO)

    assert [directive.target for directive in directives] == [
        "user/types.proto",
        "google/protobuf/timestamp.proto",
        "missing/gone.proto",
    ]
    assert [directive.directive for directive in directives] == ["import"] * 3
    # Line 3 of the stripped document is the first import.
    assert directives[0].line == 3


def test_extracts_public_and_weak_proto_imports():
    text = 'import public "a.proto";\nimport weak "b.proto";\n'

    assert [d.target for d in extract_directives("x.proto", text)] == ["a.proto", "b.proto"]


def test_extracts_graphql_yaml_and_xml_references():
    graphql = extract_directives("schema.graphql", '# import "types.graphql"\ntype Q { a: Int }')
    yaml_doc = extract_directives(
        "openapi.yaml",
        "paths:\n  /pets:\n    $ref: './paths/pets.yaml#/get'\n  /x:\n    $ref: '#/components/x'\n",
    )
    xsd = extract_directives("a.xsd", '<xsd:import schemaLocation="common.xsd"/>')

    assert [d.target for d in graphql] == ["types.graphql"]
    assert [d.directive for d in graphql] == ["# import"]
    assert [d.target for d in yaml_doc] == ["./paths/pets.yaml#/get", "#/components/x"]
    assert [d.target for d in xsd] == ["common.xsd"]


def test_suffix_without_import_syntax_declares_no_edges():
    assert extract_directives("README.md", 'import "not-a-directive"\n') == []


# ===========================================================================
# Resolution + search paths
# ===========================================================================


def test_resolves_sibling_import_through_the_include_root():
    edges = resolve_bundle_imports(PROTO_MEMBERS, entry_point=PROTO_ENTRY)
    sibling = next(edge for edge in edges if edge.target == "user/types.proto")

    assert sibling.resolution is ImportResolution.MEMBER
    assert sibling.to_path == "proto/user/types.proto"
    # The include-root walk is deepest-first, and the hit is the second candidate.
    assert sibling.search_paths[0] == "proto/user/user/types.proto"
    assert "proto/user/types.proto" in sibling.search_paths


def test_well_known_imports_resolve_as_provided_not_missing():
    edges = resolve_bundle_imports(PROTO_MEMBERS, entry_point=PROTO_ENTRY)
    well_known = next(
        edge for edge in edges if edge.target == "google/protobuf/timestamp.proto"
    )

    assert well_known.resolution is ImportResolution.PROVIDED
    assert well_known.provider == "protobuf well-known types"
    assert well_known.to_path is None


def test_unresolved_import_lists_every_search_path_tried():
    edges = resolve_bundle_imports(PROTO_MEMBERS, entry_point=PROTO_ENTRY)
    missing = next(edge for edge in edges if edge.target == "missing/gone.proto")

    assert missing.resolution is ImportResolution.UNRESOLVED
    assert missing.to_path is None
    assert list(missing.search_paths) == [
        "proto/user/missing/gone.proto",
        "proto/missing/gone.proto",
        "missing/gone.proto",
    ]


def test_internal_pointers_and_remote_urls_are_not_bundle_edges():
    members = {
        "openapi.yaml": (
            "a:\n  $ref: '#/components/schemas/Pet'\n"
            "b:\n  $ref: 'https://example.com/pet.yaml'\n"
            "c:\n  $ref: './pet.yaml'\n"
        ),
        "pet.yaml": "type: object\n",
    }
    edges = resolve_bundle_imports(members, entry_point="openapi.yaml")

    assert [edge.target for edge in edges] == ["./pet.yaml"]
    assert edges[0].to_path == "pet.yaml"


def test_reference_escaping_the_bundle_root_is_never_tried():
    members = {"a/one.proto": 'import "../../../etc/passwd";\n'}
    edges = resolve_bundle_imports(members, entry_point="a/one.proto")

    assert edges[0].resolution is ImportResolution.UNRESOLVED
    assert all(".." not in candidate for candidate in edges[0].search_paths)


def test_reachability_terminates_on_a_cycle():
    members = {"a.proto": 'import "b.proto";\n', "b.proto": 'import "a.proto";\n'}
    edges = resolve_bundle_imports(members, entry_point="a.proto")

    assert reachable_from("a.proto", edges) == {"b.proto"}


# ===========================================================================
# Roles + readability
# ===========================================================================


def test_roles_name_the_entry_point_dependency_and_unreferenced_files():
    edges = resolve_bundle_imports(PROTO_MEMBERS, entry_point=PROTO_ENTRY)
    roles = classify_roles(PROTO_MEMBERS, entry_point=PROTO_ENTRY, edges=edges)

    assert roles[PROTO_ENTRY] is BundleFileRole.ENTRY_POINT
    assert roles["proto/user/types.proto"] is BundleFileRole.DEPENDENCY
    assert roles["README.md"] is BundleFileRole.UNREFERENCED


def test_without_an_entry_point_nothing_is_claimed_to_be_a_dependency():
    edges = resolve_bundle_imports(PROTO_MEMBERS, entry_point=None)
    roles = classify_roles(PROTO_MEMBERS, entry_point=None, edges=edges)

    assert set(roles.values()) == {BundleFileRole.UNREFERENCED}


def test_binary_and_undecodable_members_are_unreadable_with_a_reason():
    assert "Binary file type" in (unreadable_reason("logo.png", "anything") or "")
    assert "not valid utf-8" in (unreadable_reason("a.proto", "ok \ufffd here") or "").lower()
    assert unreadable_reason("a.proto", "syntax = \"proto3\";") is None


def test_unreadable_members_take_the_unreadable_role():
    members = {**PROTO_MEMBERS, "logo.png": "\ufffd\ufffdPNG"}
    edges = resolve_bundle_imports(members, entry_point=PROTO_ENTRY)
    roles = classify_roles(
        members, entry_point=PROTO_ENTRY, edges=edges, unreadable=["logo.png"]
    )

    assert roles["logo.png"] is BundleFileRole.UNREADABLE


# ===========================================================================
# Entity attribution (declaration scan)
# ===========================================================================


def test_declaration_scan_reads_schema_keywords_and_mapping_keys():
    assert {"UserService", "User", "GetUserRequest"} <= declared_symbols(
        "a.proto", ENTRY_PROTO + "\n" + TYPES_PROTO
    )
    assert "Pet" in declared_symbols("openapi.yaml", "components:\n  schemas:\n    Pet:\n      type: object\n")
    assert "listPets" in declared_symbols("openapi.yaml", "get:\n  operationId: listPets\n")


def test_entities_are_attributed_to_the_file_that_declares_them():
    entities = [
        EntityRef(key="user.UserService", name="UserService"),
        EntityRef(key="user.User", name="User"),
        EntityRef(key="synthesized-only", name="NothingDeclaresThis"),
    ]

    keys, counts, unattributed = attribute_entities(PROTO_MEMBERS, entities)

    assert keys[PROTO_ENTRY] == ["user.UserService"]
    assert keys["proto/user/types.proto"] == ["user.User"]
    assert counts[PROTO_ENTRY] == 1
    assert unattributed == ["synthesized-only"]


def test_attribution_matches_the_qualified_key_tail_as_well_as_the_name():
    entities = [EntityRef(key="user.UserService#GetUser", name="GetUser")]

    keys, _counts, unattributed = attribute_entities(PROTO_MEMBERS, entities)

    assert keys[PROTO_ENTRY] == ["user.UserService#GetUser"]
    assert unattributed == []


# ===========================================================================
# Diagnostics
# ===========================================================================


def test_a_compiler_diagnostic_is_attached_to_the_file_it_names():
    message = (
        "proto compile failed\n"
        "proto/user/types.proto:4:1: syntax error: unexpected '}'\n"
    )

    attached = diagnostics_by_member(message, PROTO_MEMBERS)

    assert list(attached) == ["proto/user/types.proto"]
    assert "syntax error" in attached["proto/user/types.proto"]


def test_a_bare_basename_only_matches_when_it_is_unique():
    members = {"a/types.proto": "", "b/types.proto": "", "a/only.proto": ""}

    assert diagnostics_by_member("types.proto:1:1: boom", members) == {}
    assert "a/only.proto" in diagnostics_by_member("only.proto:1:1: boom", members)


# ===========================================================================
# Inventory build
# ===========================================================================


def test_every_file_appears_with_a_role_and_a_verdict():
    page = paginate_bundle_inventory(_inventory())

    assert [entry.path for entry in page.files] == sorted(PROTO_MEMBERS)
    assert all(entry.role for entry in page.files)
    assert all(entry.verdict is BundleFileVerdict.ANALYSED for entry in page.files)
    assert page.total_files == len(PROTO_MEMBERS)
    assert page.role_counts["entry-point"] == 1
    assert page.role_counts["dependency"] == 1
    assert page.role_counts["unreferenced"] == 1


def test_ignored_files_appear_and_state_why_they_were_ignored():
    ignored = [
        IgnoredMember(path="__MACOSX/._schema", reason="resource-fork"),
        IgnoredMember(path=".DS_Store", reason="os-metadata"),
    ]

    full = build_bundle_inventory(
        dict(PROTO_MEMBERS),
        ignored,
        entry_point=PROTO_ENTRY,
        entry_point_pinned=False,
        entry_point_error=None,
    )
    page = paginate_bundle_inventory(full)
    rows = {entry.path: entry for entry in page.files if entry.role is BundleFileRole.IGNORED}

    assert set(rows) == {"__MACOSX/._schema", ".DS_Store"}
    assert rows["__MACOSX/._schema"].ignored_reason == "resource-fork"
    assert rows[".DS_Store"].ignored_reason == "os-metadata"
    assert all(row.verdict is BundleFileVerdict.NOT_ANALYSED for row in rows.values())
    assert page.role_counts["ignored"] == 2


def test_skip_reasons_cover_the_entries_unpack_drops():
    assert member_skip_reason("__MACOSX/._a") == "resource-fork"
    assert member_skip_reason(".git/config") == "vcs-metadata"
    assert member_skip_reason("a/.DS_Store") == "os-metadata"
    assert member_skip_reason(".gitignore") == "hidden-file"
    assert member_skip_reason("dir/") == "directory-entry"
    assert member_skip_reason("a/b.proto") is None


def test_inventory_carries_edges_incoming_references_and_unresolved_imports():
    page = paginate_bundle_inventory(_inventory())
    by_path = {entry.path: entry for entry in page.files}

    assert [edge.target for edge in by_path[PROTO_ENTRY].imports] == [
        "user/types.proto",
        "google/protobuf/timestamp.proto",
        "missing/gone.proto",
    ]
    assert by_path["proto/user/types.proto"].imported_by == [PROTO_ENTRY]
    assert page.total_edges == 3
    assert page.total_unresolved == 1
    assert page.unresolved[0].target == "missing/gone.proto"
    assert page.unresolved[0].search_paths[-1] == "missing/gone.proto"


def test_inventory_states_how_attribution_was_derived():
    entities = [EntityRef(key="user.User", name="User")]
    full = build_bundle_inventory(
        dict(PROTO_MEMBERS),
        [],
        entry_point=PROTO_ENTRY,
        entry_point_pinned=False,
        entry_point_error=None,
        model=type("_Model", (), {"services": (), "channels": (), "types": ()})(),
    )
    page = paginate_bundle_inventory(full)

    assert page.attribution == ATTRIBUTION_METHOD == "declaration-scan"
    # A model with no entities attributes nothing, and says so rather than guessing.
    assert page.total_entities == 0
    assert page.unattributed_entities == 0
    assert all(entry.entity_count == 0 for entry in page.files)
    assert entities  # the ref shape stays exercised by the attribution tests above


def test_a_failed_parse_marks_the_file_the_diagnostic_names():
    full = build_bundle_inventory(
        dict(PROTO_MEMBERS),
        [],
        entry_point=PROTO_ENTRY,
        entry_point_pinned=False,
        entry_point_error=None,
        parse_error="proto/user/types.proto:4:1: syntax error",
    )
    page = paginate_bundle_inventory(full)
    by_path = {entry.path: entry for entry in page.files}

    assert by_path["proto/user/types.proto"].verdict is BundleFileVerdict.FAILED
    assert "syntax error" in (by_path["proto/user/types.proto"].error or "")
    assert by_path[PROTO_ENTRY].verdict is BundleFileVerdict.ANALYSED
    assert page.verdict_counts["failed"] == 1


def test_entry_point_candidates_are_ranked_and_mark_the_selection():
    page = paginate_bundle_inventory(_inventory())
    candidates = page.entry_point_candidates

    assert [candidate.path for candidate in candidates] == [
        candidate.path for candidate in rank_root_candidates(PROTO_MEMBERS)
    ]
    assert candidates[0].path == PROTO_ENTRY
    assert candidates[0].selected is True
    assert sum(1 for candidate in candidates if candidate.selected) == 1


def test_a_pinned_entry_point_outside_the_ranking_is_still_shown_as_selected():
    full = _inventory(entry_point="README.md", entry_point_pinned=True)
    page = paginate_bundle_inventory(full)

    assert page.entry_point == "README.md"
    assert page.entry_point_pinned is True
    assert page.entry_point_candidates[0].path == "README.md"
    assert page.entry_point_candidates[0].selected is True


def test_an_unresolvable_root_still_returns_the_complete_file_list():
    full = _inventory(entry_point=None, entry_point_error="Archive root is ambiguous")
    page = paginate_bundle_inventory(full)

    assert page.entry_point is None
    assert page.entry_point_error == "Archive root is ambiguous"
    assert page.total_files == len(PROTO_MEMBERS)


# ===========================================================================
# Pagination
# ===========================================================================


def test_files_page_with_a_cursor_and_state_truncation():
    full = _inventory()

    first = paginate_bundle_inventory(full, page_size=2)
    assert len(first.files) == 2
    assert first.truncated is True
    assert first.next_cursor is not None
    assert first.total_files == 3
    # Unresolved references ride the first page only, so a page walk sees each once.
    assert first.unresolved

    second = paginate_bundle_inventory(full, cursor=first.next_cursor, page_size=2)
    assert [entry.path for entry in second.files] == [sorted(PROTO_MEMBERS)[2]]
    assert second.next_cursor is None
    assert second.unresolved == []
    assert second.truncated is True  # a later page is by definition a partial view


def test_a_single_page_is_not_marked_truncated():
    page = paginate_bundle_inventory(_inventory(), page_size=DEFAULT_FILE_PAGE_SIZE)

    assert page.truncated is False
    assert page.next_cursor is None


def test_unresolved_listing_is_capped_with_the_total_stated():
    members = {
        "root.proto": "\n".join(
            f'import "missing/{index}.proto";' for index in range(MAX_UNRESOLVED_LISTED + 5)
        )
    }
    full = build_bundle_inventory(
        members,
        [],
        entry_point="root.proto",
        entry_point_pinned=False,
        entry_point_error=None,
    )
    page = paginate_bundle_inventory(full)

    assert page.total_unresolved == MAX_UNRESOLVED_LISTED + 5
    assert len(page.unresolved) == MAX_UNRESOLVED_LISTED
    assert page.truncated is True


def test_a_malformed_cursor_is_rejected():
    with pytest.raises(ValueError):
        paginate_bundle_inventory(_inventory(), cursor="not-a-cursor")


# ===========================================================================
# Endpoint
# ===========================================================================


def test_a_single_document_is_not_a_bundle_and_is_not_an_error():
    response = _post(
        {
            "document_base64": _b64(GRAPHQL_ROOT.encode("utf-8")),
            "filename": "schema.graphql",
        }
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["kind"] == "single-document"
    assert body["inventory"] is None


def test_an_archive_returns_a_full_inventory():
    response = _post(_graphql_zip_payload())

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["kind"] == "archive"
    inventory = body["inventory"]
    assert inventory["entry_point"] in {"schema.graphql", "types.graphql"}
    assert inventory["entry_point_pinned"] is False
    assert inventory["attribution"] == "declaration-scan"
    paths = {entry["path"] for entry in inventory["files"]}
    assert {"schema.graphql", "types.graphql"} <= paths
    assert all(entry["role"] for entry in inventory["files"])


def test_the_archives_ignored_entries_are_reported_with_reasons():
    inventory = _post(_graphql_zip_payload()).json()["inventory"]
    ignored = {
        entry["path"]: entry["ignored_reason"]
        for entry in inventory["files"]
        if entry["role"] == "ignored"
    }

    assert ignored.get("__MACOSX/._schema.graphql") == "resource-fork"
    assert ignored.get(".DS_Store") == "os-metadata"


def test_the_entry_point_can_be_overridden_by_the_request():
    inventory = _post(_graphql_zip_payload(archive_root="types.graphql")).json()["inventory"]

    assert inventory["entry_point"] == "types.graphql"
    assert inventory["entry_point_pinned"] is True
    selected = [c for c in inventory["entry_point_candidates"] if c["selected"]]
    assert [candidate["path"] for candidate in selected] == ["types.graphql"]


def test_an_unusable_archive_reports_the_stable_taxonomy_code():
    response = _post({"document_base64": _b64(b"PK\x03\x04garbage"), "filename": "broken.zip"})

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["kind"] == "archive"
    assert body["inventory"] is None
    assert body["error"]["code"] == "INPUT_ARCHIVE_INVALID"
    assert body["error"]["remediation"]


def test_a_malformed_cursor_is_a_client_error():
    response = _post(_graphql_zip_payload(cursor="not-a-cursor"))

    assert response.status_code == 422


def test_a_repeat_request_is_served_from_the_inventory_cache():
    assert bundle_inventory_cache_size() == 0

    first = _post(_graphql_zip_payload())
    assert first.status_code == 200
    assert bundle_inventory_cache_size() == 1

    second = _post(_graphql_zip_payload())
    assert second.json()["inventory"] == first.json()["inventory"]
    assert bundle_inventory_cache_size() == 1


def test_the_request_model_clamps_the_page_size():
    with pytest.raises(ValueError):
        ImportBundleInventoryRequest(document_base64="", page_size=0)
    with pytest.raises(ValueError):
        ImportBundleInventoryRequest(document_base64="", page_size=10_000)


def test_the_route_is_documented_in_the_openapi_schema():
    schema = app.openapi()
    path = "/v1/tenants/{tenant_slug}/import/bundle-inventory"

    assert path in schema["paths"]
    operation = schema["paths"][path]["post"]
    assert "IXH-3.5" in operation["description"]
    assert "search paths" in operation["description"]


def test_pages_of_one_archive_walk_every_file() -> None:
    walked: List[str] = []
    cursor = None
    for _ in range(10):
        body = _post(_graphql_zip_payload(page_size=1, **({"cursor": cursor} if cursor else {})))
        inventory = body.json()["inventory"]
        walked.extend(entry["path"] for entry in inventory["files"])
        cursor = inventory["next_cursor"]
        if not cursor:
            break

    assert cursor is None
    assert len(walked) == len(set(walked)) == inventory["total_files"]
