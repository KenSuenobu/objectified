"""Bulk grouping engine — MFI-29.5 (#4392).

The engine is pure, so every test here is a member mapping in and a plan out: the
question each one asks is "which files are one spec, and which are several?".
"""

from __future__ import annotations

from typing import Dict

import pytest

from app.archive_intake import unpack_archive
from app.bulk_intake import (
    DEFAULT_MAX_BULK_ITEMS,
    group_document_bytes,
    member_references,
    plan_bulk_import,
    predicted_import_target,
    suggested_item_name,
)

# --------------------------------------------------------------------------- fixtures

_TYPES_PROTO = """syntax = "proto3";
package demo;
message Money { string currency = 1; int64 amount = 2; }
"""

_ORDERS_PROTO = """syntax = "proto3";
package demo;
import "common/types.proto";
service Orders {
  rpc Get (Money) returns (Money);
}
"""

_SHIPPING_PROTO = """syntax = "proto3";
package demo;
import "common/types.proto";
service Shipping {
  rpc Track (Money) returns (Money);
}
"""

_ASYNCAPI_ORDERS = """asyncapi: 2.6.0
info:
  title: Orders Events
  version: 1.0.0
channels:
  order/created:
    subscribe:
      message:
        payload:
          type: object
"""

_ASYNCAPI_SHIPPING = """asyncapi: 2.6.0
info:
  title: Shipping Events
  version: 1.0.0
channels:
  shipment/created:
    subscribe:
      message:
        payload:
          type: object
"""

_OPENAPI = """openapi: 3.0.3
info:
  title: Orders API
  version: 1.0.0
paths:
  /orders:
    get:
      responses:
        '200':
          description: ok
"""


def _mixed_payload() -> Dict[str, str]:
    """The ticket's acceptance fixture: a proto tree + 2 AsyncAPI docs + 1 OpenAPI."""
    return {
        "protos/common/types.proto": _TYPES_PROTO,
        "protos/orders/orders.proto": _ORDERS_PROTO.replace(
            'import "common/types.proto";', 'import "protos/common/types.proto";'
        ),
        "events/orders.asyncapi.yaml": _ASYNCAPI_ORDERS,
        "events/shipping.asyncapi.yaml": _ASYNCAPI_SHIPPING,
        "openapi/orders.yaml": _OPENAPI,
        "README.md": "# Team specs\n",
    }


# --------------------------------------------------------------------------- grouping


def test_mixed_archive_yields_one_item_per_independent_spec() -> None:
    plan = plan_bulk_import(_mixed_payload())

    assert [group.key for group in plan.groups] == [
        "events/orders.asyncapi.yaml",
        "events/shipping.asyncapi.yaml",
        "openapi/orders.yaml",
        "protos/orders/orders.proto",
    ]
    assert plan.total_groups == 4
    assert plan.truncated is False


def test_routes_each_item_by_the_policy_its_format_implies() -> None:
    plan = plan_bulk_import(_mixed_payload())
    targets = {group.key: predicted_import_target(group.format) for group in plan.groups}

    assert targets["openapi/orders.yaml"] == "project"
    assert targets["events/orders.asyncapi.yaml"] == "catalog"
    assert targets["events/shipping.asyncapi.yaml"] == "catalog"
    assert targets["protos/orders/orders.proto"] == "catalog"


def test_a_proto_tree_stays_one_item_with_its_imports() -> None:
    plan = plan_bulk_import(_mixed_payload())
    proto = next(group for group in plan.groups if group.key.endswith("orders.proto"))

    assert sorted(proto.members) == [
        "protos/common/types.proto",
        "protos/orders/orders.proto",
    ]
    assert proto.source_kind == "grpc"


def test_two_service_protos_sharing_an_import_are_one_compilation_unit() -> None:
    # Neither service references the other, but both compile against the same file, so
    # splitting them would import ``common/types.proto`` twice into two half-items.
    plan = plan_bulk_import(
        {
            "common/types.proto": _TYPES_PROTO,
            "orders/orders.proto": _ORDERS_PROTO,
            "shipping/shipping.proto": _SHIPPING_PROTO,
        }
    )

    assert len(plan.groups) == 1
    assert sorted(plan.groups[0].members) == [
        "common/types.proto",
        "orders/orders.proto",
        "shipping/shipping.proto",
    ]


def test_documents_linked_by_a_relative_ref_are_one_item() -> None:
    plan = plan_bulk_import(
        {
            "api/openapi.yaml": _OPENAPI
            + "components:\n  schemas:\n    Order:\n      $ref: './schemas/order.yaml'\n",
            "api/schemas/order.yaml": "type: object\nproperties:\n  id:\n    type: string\n",
        }
    )

    assert len(plan.groups) == 1
    assert plan.groups[0].root_path == "api/openapi.yaml"
    assert sorted(plan.groups[0].members) == ["api/openapi.yaml", "api/schemas/order.yaml"]


def test_unrelated_documents_of_the_same_format_stay_separate_items() -> None:
    plan = plan_bulk_import(
        {
            "a.asyncapi.yaml": _ASYNCAPI_ORDERS,
            "b.asyncapi.yaml": _ASYNCAPI_SHIPPING,
        }
    )

    assert [group.key for group in plan.groups] == ["a.asyncapi.yaml", "b.asyncapi.yaml"]


def test_files_belonging_to_no_importable_item_are_reported_not_dropped() -> None:
    plan = plan_bulk_import(_mixed_payload())

    assert [(entry.path, entry.reason) for entry in plan.skipped] == [
        ("README.md", "no-recognisable-format")
    ]
    # Every input file is accounted for: an item member or a skipped row.
    accounted = {path for group in plan.groups for path in group.members}
    accounted |= {entry.path for entry in plan.skipped}
    assert accounted == set(_mixed_payload())


def test_planning_is_deterministic_for_identical_input() -> None:
    first = plan_bulk_import(_mixed_payload())
    second = plan_bulk_import(_mixed_payload())

    assert [g.key for g in first.groups] == [g.key for g in second.groups]
    assert [(s.path, s.reason) for s in first.skipped] == [
        (s.path, s.reason) for s in second.skipped
    ]


def test_item_ceiling_reports_the_overflow_instead_of_truncating_silently() -> None:
    members = {f"spec-{index}.asyncapi.yaml": _ASYNCAPI_ORDERS for index in range(5)}

    plan = plan_bulk_import(members, max_items=2)

    assert len(plan.groups) == 2
    assert plan.truncated is True
    assert plan.total_groups == 5
    assert {entry.reason for entry in plan.skipped} == {"over-item-limit"}
    assert len(plan.skipped) == 3


def test_an_empty_payload_is_a_planning_error() -> None:
    with pytest.raises(ValueError):
        plan_bulk_import({})


def test_default_ceiling_is_positive() -> None:
    assert DEFAULT_MAX_BULK_ITEMS >= 1


# --------------------------------------------------------------------------- references


def test_reference_extraction_resolves_proto_imports_against_the_fileset_root() -> None:
    members = {
        "common/types.proto": _TYPES_PROTO,
        "orders/orders.proto": _ORDERS_PROTO,
    }

    assert member_references("orders/orders.proto", _ORDERS_PROTO, members) == (
        "common/types.proto",
    )


def test_reference_extraction_resolves_refs_against_the_referring_directory() -> None:
    members = {
        "api/openapi.yaml": "",
        "api/schemas/order.yaml": "",
        "shared/common.yaml": "",
    }
    text = (
        "components:\n"
        "  schemas:\n"
        "    Order:\n"
        "      $ref: './schemas/order.yaml#/Order'\n"
        "    Common:\n"
        '      $ref: "../shared/common.yaml"\n'
    )

    assert member_references("api/openapi.yaml", text, members) == (
        "api/schemas/order.yaml",
        "shared/common.yaml",
    )


def test_reference_extraction_ignores_urls_fragments_and_absent_files() -> None:
    members = {"a.yaml": "", "b.yaml": ""}
    text = (
        "x:\n"
        '  $ref: "https://example.com/remote.yaml#/X"\n'
        '  y: {"$ref": "#/components/schemas/Local"}\n'
        '  z: {"$ref": "/etc/passwd"}\n'
        '  w: {"$ref": "missing.yaml"}\n'
    )

    assert member_references("a.yaml", text, members) == ()


def test_reference_extraction_reads_xsd_and_wsdl_locations() -> None:
    members = {"service.wsdl": "", "types.xsd": ""}
    text = '<xsd:import namespace="urn:demo" schemaLocation="types.xsd"/>'

    assert member_references("service.wsdl", text, members) == ("types.xsd",)


def test_a_reference_escaping_the_fileset_is_not_a_member_link() -> None:
    members = {"api/openapi.yaml": "", "api/schemas/order.yaml": ""}

    assert member_references("api/openapi.yaml", '$ref: "../../outside.yaml"', members) == ()


# --------------------------------------------------------------------------- payloads


def test_a_single_file_item_is_submitted_verbatim() -> None:
    plan = plan_bulk_import({"a.asyncapi.yaml": _ASYNCAPI_ORDERS})

    document, input_kind, archive_root = group_document_bytes(plan.groups[0])

    assert input_kind == "file"
    assert archive_root is None
    assert document.decode("utf-8") == _ASYNCAPI_ORDERS


def test_a_multi_file_item_is_packed_as_the_archive_intake_already_accepts() -> None:
    plan = plan_bulk_import(
        {
            "common/types.proto": _TYPES_PROTO,
            "orders/orders.proto": _ORDERS_PROTO,
        }
    )

    document, input_kind, archive_root = group_document_bytes(plan.groups[0])

    assert input_kind == "fileset"
    assert archive_root == "orders/orders.proto"
    unpacked = unpack_archive(document, root_path=archive_root)
    assert sorted(unpacked.members) == ["common/types.proto", "orders/orders.proto"]


def test_packed_items_are_byte_stable_across_plans() -> None:
    members = {"common/types.proto": _TYPES_PROTO, "orders/orders.proto": _ORDERS_PROTO}

    first = group_document_bytes(plan_bulk_import(members).groups[0])[0]
    second = group_document_bytes(plan_bulk_import(members).groups[0])[0]

    assert first == second


# --------------------------------------------------------------------------- naming


def test_item_names_prefer_the_documents_declared_title() -> None:
    plan = plan_bulk_import(_mixed_payload())
    names = {group.key: suggested_item_name(group) for group in plan.groups}

    assert names["events/orders.asyncapi.yaml"] == "Orders Events"
    assert names["openapi/orders.yaml"] == "Orders API"


def test_item_names_fall_back_to_the_filename_stem() -> None:
    plan = plan_bulk_import({"payments.proto": _TYPES_PROTO})

    assert suggested_item_name(plan.groups[0]) == "payments"


def test_a_role_named_root_is_named_after_its_directory() -> None:
    plan = plan_bulk_import(
        {
            "protos/common/types.proto": _TYPES_PROTO,
            "protos/orders/service.proto": _ORDERS_PROTO.replace(
                'import "common/types.proto";', 'import "protos/common/types.proto";'
            ),
        }
    )

    assert suggested_item_name(plan.groups[0]) == "orders"


def test_a_json_documents_title_is_read_without_a_full_parse() -> None:
    document = '{"openapi": "3.0.0", "info": {"title": "Billing API", "version": "1.0.0"}, "paths": {}}'
    plan = plan_bulk_import({"billing.json": document})

    assert suggested_item_name(plan.groups[0]) == "Billing API"
