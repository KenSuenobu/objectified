"""Unit tests for the format-matrix rendering helpers (FMT-1.5, #5416).

These drive the pure projection — payload in, cells out — against a literal that mirrors the
endpoint's shape, so the table's behaviour is pinned without a terminal, a server or a Rich render.

The malformed-payload cases matter more than they look: ``apiome formats`` is a read-only listing
command, and a partial or unexpected body should degrade to an empty cell, never to a ``KeyError``
traceback in front of someone who just asked what formats exist.
"""

from __future__ import annotations

from typing import Any

import pytest

from apiome_cli.format_matrix import (
    DIRECTIONS,
    direction_label,
    routing_label,
    runtime_label,
    summary_lines,
    table_rows,
    unknown_direction_message,
)

_OPENAPI_ROW: dict[str, Any] = {
    "key": "openapi",
    "label": "OpenAPI / Swagger",
    "description": "REST API description.",
    "icon": "file-json",
    "paradigm": "rest",
    "direction": "both",
    "version_coverage": ["openapi-3.0", "openapi-3.1"],
    "file_extensions": [".json", ".yaml"],
    "import_support": {
        "supported": True,
        "input_kinds": ["file", "url", "paste"],
        "supports_live_discovery": False,
        "supports_remote_refs": True,
        "publishable": True,
        "available": True,
        "unavailable_reason": None,
    },
    "export_support": {
        "supported": True,
        "target_key": "openapi",
        "label": "OpenAPI 3.1",
        "format": "openapi-3.1",
        "multi_file": False,
        "capability_profile": {"operations": True},
        "available": True,
        "unavailable_reason": None,
    },
    "toolchain": {
        "required_tools": [],
        "import_tools": [],
        "export_tools": [],
        "missing_tools": [],
        "satisfied": True,
    },
    "capability": {"provenance": "reviewed", "notes": []},
}

_GRPC_ROW: dict[str, Any] = {
    "key": "grpc",
    "label": "gRPC / Protobuf",
    "description": "Protocol buffer service definitions.",
    "icon": "boxes",
    "paradigm": "rpc",
    "direction": "import_only",
    "version_coverage": ["protobuf-3"],
    "file_extensions": [".proto"],
    "import_support": {
        "supported": True,
        "input_kinds": ["file", "fileset"],
        "supports_live_discovery": True,
        "supports_remote_refs": False,
        "publishable": False,
        "available": False,
        "unavailable_reason": "buf is not installed.",
    },
    "export_support": {
        "supported": False,
        "target_key": None,
        "label": None,
        "format": None,
        "multi_file": False,
        "capability_profile": None,
        "available": False,
        "unavailable_reason": None,
    },
    "toolchain": {
        "required_tools": ["buf"],
        "import_tools": ["buf"],
        "export_tools": [],
        "missing_tools": ["buf"],
        "satisfied": False,
    },
    "capability": {"provenance": "derived", "notes": []},
}

_EXPORT_ONLY_ROW: dict[str, Any] = {
    "key": "markdown",
    "label": "Markdown",
    "description": "Human-readable reference output.",
    "icon": "file-text",
    "paradigm": "rest",
    "direction": "export_only",
    "version_coverage": [],
    "file_extensions": [],
    "import_support": {
        "supported": False,
        "input_kinds": [],
        "supports_live_discovery": False,
        "supports_remote_refs": False,
        "publishable": False,
        "available": False,
        "unavailable_reason": None,
    },
    "export_support": {
        "supported": True,
        "target_key": "markdown",
        "label": "Markdown",
        "format": "markdown-1",
        "multi_file": False,
        "capability_profile": {"operations": True},
        "available": True,
        "unavailable_reason": None,
    },
    "toolchain": {
        "required_tools": [],
        "import_tools": [],
        "export_tools": [],
        "missing_tools": [],
        "satisfied": True,
    },
    "capability": {"provenance": "derived", "notes": []},
}

_PAYLOAD: dict[str, Any] = {
    "version": "1",
    "capability_registry_version": "3",
    "filters": {"paradigm": None, "direction": None},
    "counts": {
        "total": 3,
        "importable": 2,
        "exportable": 2,
        "round_trip": 1,
        "import_only": 1,
        "export_only": 1,
        "live_discovery": 1,
        "publishable": 1,
        "toolchain_gated": 1,
        "unavailable_here": 1,
    },
    "formats": [_OPENAPI_ROW, _GRPC_ROW, _EXPORT_ONLY_ROW],
}


# ===========================================================================
# Cell projections
# ===========================================================================


def test_direction_labels_read_as_english() -> None:
    """``import_only`` is precise on the wire and jargon in a table cell."""
    assert direction_label(_OPENAPI_ROW) == "import + export"
    assert direction_label(_GRPC_ROW) == "import"
    assert direction_label(_EXPORT_ONLY_ROW) == "export"


def test_unknown_direction_value_is_shown_not_swallowed() -> None:
    """A newer server may add a direction this CLI predates; hiding it would be worse than
    printing it raw."""
    assert direction_label({"direction": "sideways"}) == "sideways"
    assert direction_label({}) == ""


def test_routing_label_reports_the_servers_rule() -> None:
    assert routing_label(_OPENAPI_ROW) == "Project"
    assert routing_label(_GRPC_ROW) == "Catalog"


def test_export_only_format_is_routed_nowhere() -> None:
    """A destination is never imported, so a Project/Catalog verdict would be a fiction."""
    assert routing_label(_EXPORT_ONLY_ROW) == ""


def test_runtime_label_names_the_missing_tool() -> None:
    """"Apiome does not support gRPC" and "this box has no buf" are different facts."""
    assert runtime_label(_OPENAPI_ROW) == "ready"
    assert runtime_label(_GRPC_ROW) == "needs buf"


def test_runtime_label_defaults_to_ready_without_a_toolchain_block() -> None:
    assert runtime_label({}) == "ready"


# ===========================================================================
# The table projection
# ===========================================================================


def test_table_rows_flatten_every_column() -> None:
    rows = table_rows(_PAYLOAD)
    assert [row["key"] for row in rows] == ["openapi", "grpc", "markdown"]
    openapi = rows[0]
    assert openapi["label"] == "OpenAPI / Swagger"
    assert openapi["paradigm"] == "rest"
    assert openapi["direction"] == "import + export"
    assert openapi["routing"] == "Project"
    assert openapi["input_kinds"] == ["file", "url", "paste"]
    assert openapi["live_discovery"] == ""
    assert openapi["version_coverage"] == ["openapi-3.0", "openapi-3.1"]
    assert openapi["file_extensions"] == [".json", ".yaml"]
    assert openapi["runtime"] == "ready"


def test_table_rows_mark_live_discovery() -> None:
    rows = {row["key"]: row for row in table_rows(_PAYLOAD)}
    assert rows["grpc"]["live_discovery"] == "yes"


def test_table_rows_preserve_payload_order() -> None:
    """The server orders by label then key; re-sorting here would break the one shared ordering."""
    assert [row["key"] for row in table_rows(_PAYLOAD)] == [
        row["key"] for row in _PAYLOAD["formats"]
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"formats": None},
        {"formats": "not-a-list"},
        {"formats": [None, "nope", 7]},
    ],
)
def test_table_rows_tolerate_a_malformed_payload(payload: dict[str, Any]) -> None:
    """A listing command degrades to an empty table rather than a traceback."""
    assert table_rows(payload) == []


def test_table_rows_tolerate_a_row_missing_its_import_block() -> None:
    rows = table_rows({"formats": [{"key": "x", "label": "X"}]})
    assert rows == [
        {
            "key": "x",
            "label": "X",
            "paradigm": "",
            "direction": "",
            "routing": "",
            "input_kinds": [],
            "live_discovery": "",
            "version_coverage": [],
            "file_extensions": [],
            "runtime": "ready",
        }
    ]


# ===========================================================================
# The summary
# ===========================================================================


def test_summary_uses_the_responses_own_counts() -> None:
    """The counts describe the rows the response carries, so a filtered listing never prints a
    whole-registry total beside a partial table."""
    lines = summary_lines(_PAYLOAD)
    assert "3 formats — 2 importable, 2 exportable, 1 round-trip." in lines[0]
    assert "1 with live discovery" in lines[1]
    assert "1 publishable as a Project" in lines[1]


def test_summary_calls_out_a_missing_toolchain() -> None:
    lines = summary_lines(_PAYLOAD)
    assert any("supported, just not runnable here" in line for line in lines)


def test_summary_omits_the_toolchain_line_when_nothing_is_missing() -> None:
    payload = {**_PAYLOAD, "counts": {**_PAYLOAD["counts"], "unavailable_here": 0}}
    assert len(summary_lines(payload)) == 2


def test_summary_is_empty_without_counts() -> None:
    assert summary_lines({"formats": []}) == []
    assert summary_lines({"formats": [], "counts": {}}) == []


def test_summary_tolerates_non_integer_counts() -> None:
    """A count the server did not send reads as zero rather than crashing the render."""
    lines = summary_lines({"counts": {"total": None, "importable": 4}})
    assert lines[0].startswith("0 formats — 4 importable")


# ===========================================================================
# Direction validation
# ===========================================================================


def test_accepted_directions_are_the_three_documented_values() -> None:
    assert DIRECTIONS == ("import", "export", "both")


def test_unknown_direction_message_names_the_accepted_values() -> None:
    message = unknown_direction_message("sideways")
    assert "sideways" in message
    assert "import, export, both" in message
