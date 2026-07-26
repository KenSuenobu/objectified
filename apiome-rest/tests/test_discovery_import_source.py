"""Tests for Google API Discovery catalog import adapter — IXH-7.1 (#5126)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import httpx
import pytest

from app.canonical_model import ApiParadigm, ParameterLocation
from app.discovery_directory import (
    DEFAULT_DIRECTORY_URL,
    DiscoveryDirectoryError,
    list_directory_apis,
)
from app.discovery_import_source import DiscoveryImportSource
from app.discovery_normalizer import DiscoveryNormalizer
from app.discovery_parser import is_discovery, parse_discovery
from app.format_lint_capabilities import MODE_UNSUPPORTED, capability_for_format
from app.import_source import DetectionInput, ImportSourceError, get_import_source

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/discovery"
_BOOKSTORE = (_EXAMPLES / "01-bookstore-api.json").read_text(encoding="utf-8")
_MINIMAL = (_EXAMPLES / "02-minimal-ping.json").read_text(encoding="utf-8")


def _directory_payload(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "kind": "discovery#directoryList",
        "discoveryVersion": "v1",
        "items": items,
    }


def _transport(handlers: Dict[str, Any]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url not in handlers:
            return httpx.Response(404, text=f"missing mock for {url}")
        body = handlers[url]
        if isinstance(body, tuple):
            status, payload = body
            if isinstance(payload, (dict, list)):
                return httpx.Response(status, json=payload)
            return httpx.Response(status, text=str(payload))
        if isinstance(body, (dict, list)):
            return httpx.Response(200, json=body)
        return httpx.Response(200, text=str(body))

    return httpx.MockTransport(handler)


@pytest.fixture()
def adapter() -> DiscoveryImportSource:
    return DiscoveryImportSource()


def test_is_discovery_recognizes_bookstore_and_declines_openapi():
    assert is_discovery(_BOOKSTORE) is True
    assert is_discovery('{"openapi":"3.0.0","paths":{}}') is False
    assert is_discovery('{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}') is False


def test_parse_collects_nested_resources_methods_and_schemas():
    doc = parse_discovery(_BOOKSTORE)
    assert doc.discovery_version == "v1"
    assert doc.kind == "discovery#restDescription"
    assert doc.name == "bookstore"
    assert doc.title == "Bookstore API"
    assert {name for name in doc.schemas} >= {"Book", "Author", "BookList"}
    method_ids = {method.id for method in doc.methods}
    assert "bookstore.books.get" in method_ids
    assert "bookstore.books.reviews.list" in method_ids
    nested = next(m for m in doc.methods if m.id == "bookstore.books.reviews.list")
    assert nested.resource_path == "books/reviews"


def test_normalizer_maps_rest_service_with_stable_keys():
    doc = parse_discovery(_BOOKSTORE)
    api = DiscoveryNormalizer().normalize(doc)
    assert api.format == "discovery"
    assert api.paradigm is ApiParadigm.REST
    assert api.protocol == "http"
    assert api.extras.get("discovery_version") == "v1"
    book = next(t for t in api.types if t.name == "Book")
    assert any(f.name == "title" for f in book.fields)
    assert any(f.name == "status" for f in book.fields)
    service = api.services[0]
    get_book = next(op for op in service.operations if op.name == "bookstore.books.get")
    assert get_book.http_method == "GET"
    assert get_book.http_path.endswith("books/{bookId}")
    path_params = [p for p in get_book.parameters if p.location is ParameterLocation.PATH]
    assert any(p.name == "bookId" for p in path_params)
    assert api.servers and "bookstore.example.com" in api.servers[0].url


def test_adapter_detect_parse_normalize(adapter: DiscoveryImportSource):
    detected = adapter.detect(
        DetectionInput(text=_BOOKSTORE, filename="01-bookstore-api.json")
    )
    assert detected.matched
    assert detected.format == "discovery"
    assert detected.confidence >= 0.95
    doc = adapter.parse(_BOOKSTORE, source_label="01-bookstore-api.json")
    api = adapter.normalize(doc)
    assert len(api.types) >= 3
    assert len(api.services) == 1
    assert len(api.services[0].operations) >= 4


def test_adapter_declines_openapi_and_json_schema(adapter: DiscoveryImportSource):
    assert not adapter.detect(
        DetectionInput(text='{"openapi":"3.1.0","info":{"title":"x","version":"1"},"paths":{}}')
    ).matched
    assert not adapter.detect(
        DetectionInput(
            text='{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}'
        )
    ).matched


def test_adapter_invalid_source_raises(adapter: DiscoveryImportSource):
    with pytest.raises(ImportSourceError):
        adapter.parse('{"title":"nope"}')


def test_registry_resolves_discovery_adapter():
    assert get_import_source("discovery") is not None
    assert get_import_source("discovery").key == "discovery"


def test_lint_capability_matrix_includes_discovery():
    cap = capability_for_format("discovery")
    assert cap is not None
    assert cap.importable is True
    assert cap.mode in (MODE_UNSUPPORTED, "adapted", "native")
    # No native Discovery pack yet — common-pack-only / unsupported is expected.
    assert cap.common_pack_only or cap.mode == MODE_UNSUPPORTED or cap.native_pack


def test_list_directory_and_import_selected(adapter: DiscoveryImportSource):
    rest_url = "https://example.com/$discovery/rest?version=v1"
    directory = _directory_payload(
        [
            {
                "id": "ping:v1",
                "name": "ping",
                "version": "v1",
                "title": "Ping API",
                "discoveryRestUrl": rest_url,
                "preferred": True,
            }
        ]
    )
    handlers = {
        DEFAULT_DIRECTORY_URL: directory,
        rest_url: _MINIMAL,
    }
    transport = _transport(handlers)
    with httpx.Client(transport=transport) as client:
        listings = adapter.list_directory(DEFAULT_DIRECTORY_URL, client=client)
        assert len(listings) == 1
        assert listings[0].id == "ping:v1"
        doc = adapter.import_from_directory("ping:v1", client=client)
        assert doc.name == "ping"
        api = adapter.normalize(doc)
        assert api.services[0].operations


def test_introspect_rest_url(adapter: DiscoveryImportSource):
    rest_url = "https://example.com/$discovery/rest?version=v1"
    transport = _transport({rest_url: _MINIMAL})
    with httpx.Client(transport=transport) as client:
        doc = adapter.introspect(rest_url, client=client)
        assert doc.title == "Ping API"


def test_introspect_directory_without_api_id_raises(adapter: DiscoveryImportSource):
    transport = _transport(
        {
            DEFAULT_DIRECTORY_URL: _directory_payload(
                [
                    {
                        "id": "ping:v1",
                        "name": "ping",
                        "version": "v1",
                        "discoveryRestUrl": "https://example.com/rest",
                        "preferred": True,
                    }
                ]
            )
        }
    )
    with httpx.Client(transport=transport) as client:
        with pytest.raises(ImportSourceError, match="directory listing"):
            adapter.introspect(DEFAULT_DIRECTORY_URL, client=client)


def test_introspect_directory_with_api_id(adapter: DiscoveryImportSource):
    rest_url = "https://example.com/$discovery/rest?version=v1"
    transport = _transport(
        {
            DEFAULT_DIRECTORY_URL: _directory_payload(
                [
                    {
                        "id": "ping:v1",
                        "name": "ping",
                        "version": "v1",
                        "discoveryRestUrl": rest_url,
                        "preferred": True,
                    }
                ]
            ),
            rest_url: _MINIMAL,
        }
    )
    with httpx.Client(transport=transport) as client:
        doc = adapter.introspect(
            DEFAULT_DIRECTORY_URL, api_id="ping:v1", client=client
        )
        assert doc.name == "ping"


def test_list_directory_ssrf_rejection():
    with pytest.raises(DiscoveryDirectoryError):
        list_directory_apis("http://127.0.0.1/apis")


def test_catalog_conversion_resolves_discovery_adapter():
    from app.catalog_conversion import resolve_conversion_adapter

    assert resolve_conversion_adapter("discovery", _MINIMAL).key == "discovery"
