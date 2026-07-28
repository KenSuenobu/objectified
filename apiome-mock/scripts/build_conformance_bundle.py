#!/usr/bin/env python
"""Regenerate the conformance bundle shipped with the portable runtime (#4742, PMR-1.2).

The conformance corpus needs a bundle to run against, and that bundle has to be a *real* one —
built by the same :func:`app.mock_bundle.build_bundle` the REST exporter uses — or the corpus would
prove the runtime against a fiction. Bundles are byte-deterministic, so the generated file is
committed and ``tests/test_conformance_corpus.py`` re-runs this builder to prove the committed copy
still matches (a spec edit here without a regenerate is caught immediately).

The bundle is intentionally **unsigned**: the corpus must run with no secret configured, on any
machine, as the "portable" claim requires. Signature handling is covered separately by the bundle
tests (#4741) and by the runtime's ``--require-signature`` flag.

Usage::

    uv run python scripts/build_conformance_bundle.py          # rewrite the committed bundle
    uv run python scripts/build_conformance_bundle.py --check  # verify it is up to date (CI)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "src"))
sys.path.insert(0, str(_REPO_ROOT.parent / "apiome-rest" / "src"))
sys.path.insert(0, str(_REPO_ROOT.parent / "apiome-mcp" / "src"))

from app.mock_bundle import BundleIdentity, build_bundle, bundle_bytes  # noqa: E402

#: Where the generated bundle is committed (inside the package, so the image ships it).
BUNDLE_PATH = _REPO_ROOT / "src" / "apiome_mock" / "conformance_data" / "bundle.json"

#: Coordinates the corpus expects to see at ``/ready`` and in the served URL prefix.
IDENTITY = BundleIdentity(
    tenant="conformance",
    project="petstore",
    version="1.0.0",
    revision_id="8f14e45f-ceea-467a-9d0e-6a7b6c1f4a21",
    published=True,
    protocol="openapi",
)

_PET = {
    "type": "object",
    "required": ["id", "name"],
    "properties": {
        "id": {"type": "integer"},
        "name": {"type": "string"},
    },
    "additionalProperties": False,
}

#: The OpenAPI document the corpus exercises. Every construct here exists to pin one runtime
#: behavior: examples, path parameters, query validation, required bodies, 204s, declared 5xx
#: (chaos injection reuses it), and a schema-only response (seeded synthesis).
SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Conformance Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "parameters": [
                    {
                        "name": "limit",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "integer", "minimum": 1, "maximum": 100},
                    }
                ],
                "responses": {
                    "200": {
                        "description": "A list of pets.",
                        "content": {
                            "application/json": {
                                "schema": {"type": "array", "items": _PET},
                                "example": [{"id": 1, "name": "Rex"}],
                            }
                        },
                    },
                    "500": {
                        "description": "Upstream failure.",
                        "content": {
                            "application/json": {
                                "schema": {"type": "object"},
                                "example": {"error": "pet store is on fire"},
                            }
                        },
                    },
                },
            },
            "post": {
                "operationId": "createPet",
                "requestBody": {
                    "required": True,
                    "content": {"application/json": {"schema": _PET}},
                },
                "responses": {
                    "201": {
                        "description": "The created pet.",
                        "content": {
                            "application/json": {
                                "schema": _PET,
                                "example": {"id": 9, "name": "Nym"},
                            }
                        },
                    }
                },
            },
        },
        "/pets/{petId}": {
            "parameters": [
                {
                    "name": "petId",
                    "in": "path",
                    "required": True,
                    "schema": {"type": "integer"},
                }
            ],
            "get": {
                "operationId": "getPet",
                "responses": {
                    "200": {
                        "description": "One pet.",
                        "content": {
                            "application/json": {
                                "schema": _PET,
                                "example": {"id": 1, "name": "Rex"},
                            }
                        },
                    },
                    "404": {
                        "description": "No such pet.",
                        "content": {
                            "application/json": {
                                "schema": {"type": "object"},
                                "example": {"detail": "No pet with that id."},
                            }
                        },
                    },
                },
            },
            "delete": {
                "operationId": "deletePet",
                "responses": {"204": {"description": "Deleted."}},
            },
        },
        "/pets/{petId}/tags": {
            "parameters": [
                {
                    "name": "petId",
                    "in": "path",
                    "required": True,
                    "schema": {"type": "integer"},
                }
            ],
            "get": {
                "operationId": "listPetTags",
                "responses": {
                    "200": {
                        "description": "Tags, synthesized from the schema (no example on purpose).",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["tags"],
                                    "properties": {"tags": {"type": "array", "items": {"type": "string"}}},
                                }
                            }
                        },
                    }
                },
            },
        },
    },
}

#: Mock settings embedded in the bundle. Only the portable subset survives export (scenarios and
#: chaos); the redaction pass in ``app.mock_bundle`` drops everything else.
SETTINGS: dict[str, Any] = {
    "scenarios": {
        "quota-exceeded": {
            "description": "Listing pets is throttled.",
            "operations": {
                "GET /pets": {
                    "responses": [
                        {
                            "status": 429,
                            "headers": {"Retry-After": "60"},
                            "body": {"detail": "Quota exceeded."},
                        }
                    ]
                }
            },
        },
        "flaky-list": {
            "description": "The first list call fails, the second succeeds.",
            "operations": {
                "GET /pets": {
                    "responses": [
                        {"status": 503, "body": {"detail": "Try again."}},
                        {"status": 200, "body": [{"id": 1, "name": "Rex"}]},
                    ]
                }
            },
        },
        "outage": {
            "description": "Every list call is chaos-injected as the spec-defined 500.",
            "operations": {},
            "chaos": {"operations": {"GET /pets": {"errorRate": 100}}},
        },
        "slow": {
            "description": "A small, bounded injected delay on listing.",
            "operations": {},
            "chaos": {"operations": {"GET /pets": {"delayMs": 5}}},
        },
    }
}


def build() -> dict[str, Any]:
    """Build the conformance bundle document.

    Returns:
        The unsigned ``apiome.mock.bundle/v1`` document for the conformance API.
    """
    return build_bundle(identity=IDENTITY, spec=SPEC, mock_settings=SETTINGS, secret=None)


def main() -> int:
    """Write (or verify) the committed bundle.

    Returns:
        Process exit code: 0 when written or already current, 1 when ``--check`` found a drift.
    """
    parser = argparse.ArgumentParser(description="Regenerate the mock conformance bundle.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the committed bundle differs from a fresh build.",
    )
    args = parser.parse_args()

    payload = bundle_bytes(build())
    current = BUNDLE_PATH.read_bytes() if BUNDLE_PATH.exists() else b""
    if args.check:
        if payload != current:
            print(f"{BUNDLE_PATH} is out of date; run scripts/build_conformance_bundle.py", file=sys.stderr)
            return 1
        print(f"{BUNDLE_PATH} is up to date.")
        return 0

    BUNDLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BUNDLE_PATH.write_bytes(payload)
    print(f"Wrote {BUNDLE_PATH} ({len(payload)} bytes).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
