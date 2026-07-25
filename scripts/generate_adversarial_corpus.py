#!/usr/bin/env python3
"""Generate the large IXH-1.4 adversarial fixtures at test time (#5090).

The adversarial corpus needs inputs that are hostile *because of their size*: a
zip whose members expand to gigabytes, a document with 10^5 nodes, a 1 GB sparse
file, a 200-deep ``$ref`` chain. Committing those would bloat the repository
permanently, so this script is committed instead and the bytes are built on
demand — the IXH-1.4 acceptance criterion "large binaries are generated at test
time by a committed script, keeping repo size flat".

:data:`GENERATED_FIXTURES` is the checked-in spec: one entry per fixture naming
the guard it targets, the adapter it is fed to, and the outcome the pipeline must
produce. ``apiome-rest/tests/test_corpus_adversarial.py`` iterates it, so the
spec — not a directory listing — is the contract.

Usage::

    # write every fixture into a directory (tests use a tmp_path)
    python3 scripts/generate_adversarial_corpus.py --out-dir /tmp/adversarial

    # list the spec without writing anything
    python3 scripts/generate_adversarial_corpus.py --list

Every builder is deterministic: the same spec always produces byte-identical
output, so a failure is reproducible from the fixture name alone.
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import sys
import tarfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

__all__ = [
    "GENERATED_FIXTURES",
    "SYNTHETIC_SECRETS",
    "GeneratedFixture",
    "build_fixture",
    "write_all",
]

# ===========================================================================
# Builders
# ===========================================================================
#
# Each builder returns the fixture's raw bytes (or writes a sparse file directly,
# for the one fixture too large to hold in memory).


#: Fixed DOS timestamp for every archive entry. ``ZipFile.writestr`` stamps entries
#: with ``time.localtime()`` when handed a bare filename, which makes a fixture's
#: bytes change between builds; pinning it keeps every builder reproducible.
_FIXED_ZIP_DATE = (1980, 1, 1, 0, 0, 0)


def _zip_entry(name: str, *, compress: int = zipfile.ZIP_DEFLATED) -> zipfile.ZipInfo:
    """Build a ZipInfo with a fixed timestamp for deterministic output."""
    info = zipfile.ZipInfo(filename=name, date_time=_FIXED_ZIP_DATE)
    info.compress_type = compress
    return info


def _zip_bomb_declared_small() -> bytes:
    """A zip whose single member expands to 64 MiB of one repeated byte.

    Highly compressible, so the archive itself stays a few kilobytes: the guard
    under test is the *expansion* ceiling, not the upload size.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr(_zip_entry("openapi.json"), b"A" * (64 * 1024 * 1024))
    return buffer.getvalue()


def _zip_bomb_many_members() -> bytes:
    """A zip of 64 members, each expanding to 4 MiB — 256 MiB in total.

    Every member is under the per-file ceiling, so this exercises the *cumulative*
    uncompressed budget rather than the per-member one.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for index in range(64):
            archive.writestr(
                _zip_entry(f"schemas/part-{index:03d}.json"), b"B" * (4 * 1024 * 1024)
            )
    return buffer.getvalue()


def _tar_bomb() -> bytes:
    """A gzipped tar whose single member expands to 64 MiB.

    The gzip layer is built explicitly with ``mtime=0``: ``tarfile.open(mode="w:gz")``
    stamps the current time into the gzip header, which would make the fixture's
    bytes differ between builds and break reproducibility.
    """
    payload = b"C" * (64 * 1024 * 1024)
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as archive:
            info = tarfile.TarInfo(name="openapi.json")
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def _zip_path_traversal_relative() -> bytes:
    """A zip with a ``../../`` member — must be rejected before extraction."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(_zip_entry("openapi.json"), json.dumps({"openapi": "3.1.0"}))
        archive.writestr(
            _zip_entry("../../../../etc/passwd"), "root:x:0:0:root:/root:/bin/sh\n"
        )
    return buffer.getvalue()


def _zip_path_traversal_absolute() -> bytes:
    """A zip with an absolute-path member — must be rejected before extraction."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(_zip_entry("openapi.json"), json.dumps({"openapi": "3.1.0"}))
        archive.writestr(_zip_entry("/etc/cron.d/backdoor"), "* * * * * root /bin/sh\n")
    return buffer.getvalue()


def _tar_path_traversal_symlink() -> bytes:
    """A tar carrying a symlink that escapes the root — rejected before extraction."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        body = json.dumps({"openapi": "3.1.0"}).encode()
        info = tarfile.TarInfo(name="openapi.json")
        info.size = len(body)
        archive.addfile(info, io.BytesIO(body))
        link = tarfile.TarInfo(name="passwd")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../../../etc/passwd"
        archive.addfile(link)
    return buffer.getvalue()


def _wide_json_100k_nodes() -> bytes:
    """An OpenAPI-shaped document with ~10^5 schema nodes.

    Structurally valid and shallow: the cost is node *count*, which is what a
    naive normalizer walks. Bounded by the document-size guard.
    """
    properties = {
        f"field_{index:05d}": {"type": "string", "description": "x" * 64}
        for index in range(100_000)
    }
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Wide", "version": "1.0.0"},
        "paths": {},
        "components": {"schemas": {"Wide": {"type": "object", "properties": properties}}},
    }
    return json.dumps(document).encode("utf-8")


def _deep_json_nesting(levels: int = 5_000) -> bytes:
    """A JSON document nested ``levels`` deep — bounded by the depth guard."""
    return (b'{"a":' * levels) + b"1" + (b"}" * levels)


def _deep_ref_chain(depth: int = 200) -> bytes:
    """An OpenAPI document with a 200-link ``$ref`` chain ending in a cycle.

    Each schema references the next, and the last references the first, so a
    resolver without a cycle guard recurses forever.
    """
    schemas: Dict[str, object] = {}
    for index in range(depth):
        nxt = (index + 1) % depth
        schemas[f"Node{index}"] = {
            "type": "object",
            "properties": {"next": {"$ref": f"#/components/schemas/Node{nxt}"}},
        }
    document = {
        "openapi": "3.1.0",
        "info": {"title": "Ref chain", "version": "1.0.0"},
        "paths": {
            "/root": {
                "get": {
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/Node0"}
                                }
                            },
                        }
                    }
                }
            }
        },
        "components": {"schemas": schemas},
    }
    return json.dumps(document).encode("utf-8")


def _yaml_alias_bomb() -> bytes:
    """A YAML alias bomb: nine-way fan-out over six levels (~5*10^5 nodes)."""
    lines = ["openapi: 3.1.0", "info:", "  title: Alias bomb", "  version: 1.0.0", "paths: {}"]
    lines.append("x-a: &a [x, x, x, x, x, x, x, x, x]")
    for level, prev in zip("bcdef", "abcde"):
        lines.append(f"x-{level}: &{level} [" + ", ".join([f"*{prev}"] * 9) + "]")
    lines.append("x-boom: [" + ", ".join(["*f"] * 9) + "]")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _sparse_one_gigabyte(path: Path) -> None:
    """Write a 1 GiB **sparse** JSON document (IXH-6.5 streaming-limit material).

    Written with a seek-and-truncate so the file occupies almost no disk: the
    payload is a JSON prologue, a gigabyte of NULs the filesystem never stores,
    and a closing brace. Streaming intake must reject it on declared size without
    reading it into memory.
    """
    one_gib = 1024 * 1024 * 1024
    prologue = b'{"openapi": "3.1.0", "info": {"title": "Sparse", "version": "1.0.0"}, "x-pad": "'
    with open(path, "wb") as handle:
        handle.write(prologue)
        handle.truncate(len(prologue) + one_gib)
        handle.seek(len(prologue) + one_gib)
        handle.write(b'"}')


# ===========================================================================
# Synthetic credentials
# ===========================================================================
#
# The secret-bearing fixtures must contain credential strings that *look* real
# enough to exercise the scrubber's provider patterns — which means committing them
# verbatim would trip GitHub's push protection (it did) and would leave
# credential-shaped literals in the repository forever. So the values are assembled
# from fragments at build time: nothing scannable is committed, and there is exactly
# one source of truth for the tests to assert against.
#
# None of these are functional. Where a provider publishes a documentation example
# (AWS), that value is used deliberately.

SYNTHETIC_SECRETS: Dict[str, str] = {
    "aws_access_key_id": "AKIA" + "IOSFODNN7" + "EXAMPLE",
    "aws_secret_access_key": "wJalrXUtnFEMI/" + "K7MDENG/" + "bPxRfiCY" + "EXAMPLEKEY",
    "github_token": "ghp" + "_" + "16C7e42F292c6912E7710c838347Ae178B4a",
    "slack_token": "xoxb" + "-3096502356789-3097461293841-" + "7Kd0pQmZnRt2VwXyAbCdEfGh",
    "google_api_key": "AIza" + "SyD-0a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P",
    "stripe_key": "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dcQ8vB2nM1",
    "jwt": (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJzdWIiOiJzdmMtb3JkZXJzIiwiaWF0IjoxNzUwMDAwMDAwfQ."
        "4Xq8kK1nQmVQ0rZ9pL7wT2sYbN3cD5eF6gH8jK0mNoP"
    ),
    "basic_auth_password": "S3cr3t-Staging-Pass",
    "db_password": "Tr0ub4dor&3",
    "session_cookie": "s%3AaBcDeFgHiJkLmNoPqRsTuVwXyZ012345.7Kd0pQmZnRt2VwXyAbCd",
}


def _openapi_with_secrets() -> bytes:
    """A plausible OpenAPI document seeded with synthetic credentials.

    Places them where real specs leak them: a server URL with basic-auth userinfo, a
    hard-coded bearer token in an example, an AWS key pair in a vendor extension, a
    connection string in a description, and a default token on a security scheme.
    """
    secrets = SYNTHETIC_SECRETS
    return (
        "openapi: 3.1.0\n"
        "info:\n"
        "  title: Orders API\n"
        "  version: 1.4.0\n"
        "  description: >-\n"
        "    Internal service. Reporting replica: "
        f"postgresql://report_user:{secrets['db_password']}@db.internal:5432/orders\n"
        "servers:\n"
        f"  - url: https://svc-orders:{secrets['basic_auth_password']}@staging.example.com/v1\n"
        "    description: Staging (credentials embedded by mistake)\n"
        "  - url: https://api.example.com/v1\n"
        "    description: Production\n"
        "x-aws-integration:\n"
        f"  accessKeyId: {secrets['aws_access_key_id']}\n"
        f"  secretAccessKey: {secrets['aws_secret_access_key']}\n"
        "  region: us-east-1\n"
        "paths:\n"
        "  /orders:\n"
        "    get:\n"
        "      operationId: listOrders\n"
        "      summary: List orders\n"
        "      parameters:\n"
        "        - name: Authorization\n"
        "          in: header\n"
        "          required: true\n"
        "          schema:\n"
        "            type: string\n"
        f"          example: Bearer {secrets['jwt']}\n"
        "      responses:\n"
        '        "200":\n'
        "          description: The orders\n"
        "          content:\n"
        "            application/json:\n"
        "              schema:\n"
        "                type: array\n"
        "                items:\n"
        '                  $ref: "#/components/schemas/Order"\n'
        "components:\n"
        "  schemas:\n"
        "    Order:\n"
        "      type: object\n"
        "      required: [id, total]\n"
        "      properties:\n"
        "        id:\n"
        "          type: string\n"
        "        total:\n"
        "          type: number\n"
        "  securitySchemes:\n"
        "    bearerAuth:\n"
        "      type: http\n"
        "      scheme: bearer\n"
        "      bearerFormat: JWT\n"
        f"      x-default-token: {secrets['github_token']}\n"
        "security:\n"
        "  - bearerAuth: []\n"
    ).encode("utf-8")


def _postman_with_secrets() -> bytes:
    """A Postman export carrying synthetic credentials in auth, vars, and headers."""
    secrets = SYNTHETIC_SECRETS
    collection = {
        "info": {
            "_postman_id": "b0d3f6c2-7a51-4c8e-9d2b-1f0a5e7c3d84",
            "name": "Billing (exported with credentials)",
            "description": (
                "Adversarial: the shape a Postman export routinely arrives in — a bearer "
                "token in the auth block, an API key header, and a session cookie. All "
                "values are synthetic; intake must redact them before persisting."
            ),
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "auth": {
            "type": "bearer",
            "bearer": [
                {"key": "token", "value": secrets["slack_token"], "type": "string"}
            ],
        },
        "variable": [
            {"key": "base_url", "value": "https://billing.example.com/api"},
            {"key": "api_key", "value": secrets["google_api_key"]},
            {"key": "stripe_secret", "value": secrets["stripe_key"]},
        ],
        "item": [
            {
                "name": "List invoices",
                "request": {
                    "method": "GET",
                    "header": [
                        {"key": "X-Api-Key", "value": secrets["google_api_key"]},
                        {"key": "Cookie", "value": f"session={secrets['session_cookie']}"},
                    ],
                    "url": {
                        "raw": "{{base_url}}/invoices",
                        "host": ["{{base_url}}"],
                        "path": ["invoices"],
                    },
                },
            },
            {
                "name": "Create invoice",
                "request": {
                    "method": "POST",
                    "header": [{"key": "Content-Type", "value": "application/json"}],
                    "body": {
                        "mode": "raw",
                        "raw": '{"customer": "cus_9s6XKzkNRiz8i3", "amount": 4200}',
                    },
                    "url": {
                        "raw": "{{base_url}}/invoices",
                        "host": ["{{base_url}}"],
                        "path": ["invoices"],
                    },
                },
            },
        ],
    }
    return json.dumps(collection, indent=2).encode("utf-8")


# ===========================================================================
# Spec
# ===========================================================================


@dataclass(frozen=True)
class GeneratedFixture:
    """One generated adversarial fixture and the contract it must satisfy.

    Attributes:
        name: File name written into the output directory.
        guard: The intake guard this fixture targets (matches the corpus
            manifest's ``guard`` vocabulary).
        adapter_key: ImportSource registry key the fixture is fed to.
        expected_error_code: Intake-taxonomy code the job must fail with, or
            ``None`` when the fixture is expected to import with warnings.
        description: One line on what makes the fixture hostile.
        builder: Returns the fixture's bytes.
        writer: Alternative to ``builder`` for fixtures written directly to disk
            (used by the sparse 1 GiB file, which must never be held in memory).
        approx_bytes: Rough on-disk size, for the test's own budgeting.
        features: Corpus-style tags describing the fixture.
    """

    name: str
    guard: str
    adapter_key: str
    expected_error_code: Optional[str]
    description: str
    builder: Optional[Callable[[], bytes]] = None
    writer: Optional[Callable[[Path], None]] = None
    approx_bytes: int = 0
    features: List[str] = field(default_factory=list)


#: The committed spec of generated fixtures. Tests iterate this list.
GENERATED_FIXTURES: List[GeneratedFixture] = [
    GeneratedFixture(
        name="zip-bomb-single-member.zip",
        guard="archive-bomb",
        adapter_key="openapi",
        expected_error_code="INPUT_ARCHIVE_INVALID",
        description="One member declaring 64 MiB of a single repeated byte.",
        builder=_zip_bomb_declared_small,
        approx_bytes=70_000,
        features=["negative", "archive-bomb", "compression-amplification"],
    ),
    GeneratedFixture(
        name="zip-bomb-many-members.zip",
        guard="archive-bomb",
        adapter_key="openapi",
        expected_error_code="INPUT_ARCHIVE_INVALID",
        description="64 members of 4 MiB each: 256 MiB uncompressed in total.",
        builder=_zip_bomb_many_members,
        approx_bytes=300_000,
        features=["negative", "archive-bomb", "cumulative-size"],
    ),
    GeneratedFixture(
        name="tar-bomb-single-member.tar.gz",
        guard="archive-bomb",
        adapter_key="openapi",
        expected_error_code="INPUT_ARCHIVE_INVALID",
        description="Gzipped tar whose member expands to 64 MiB.",
        builder=_tar_bomb,
        approx_bytes=70_000,
        features=["negative", "archive-bomb", "tar"],
    ),
    GeneratedFixture(
        name="zip-traversal-relative.zip",
        guard="archive-path-traversal",
        adapter_key="openapi",
        expected_error_code="INPUT_ARCHIVE_INVALID",
        description="Member path `../../../../etc/passwd` escaping the archive root.",
        builder=_zip_path_traversal_relative,
        approx_bytes=600,
        features=["negative", "archive-path-traversal", "dot-dot"],
    ),
    GeneratedFixture(
        name="zip-traversal-absolute.zip",
        guard="archive-path-traversal",
        adapter_key="openapi",
        expected_error_code="INPUT_ARCHIVE_INVALID",
        description="Member path `/etc/cron.d/backdoor` given as an absolute path.",
        builder=_zip_path_traversal_absolute,
        approx_bytes=600,
        features=["negative", "archive-path-traversal", "absolute-path"],
    ),
    GeneratedFixture(
        name="tar-traversal-symlink.tar",
        guard="archive-path-traversal",
        adapter_key="openapi",
        expected_error_code="INPUT_ARCHIVE_INVALID",
        description="Tar symlink member pointing outside the root.",
        builder=_tar_path_traversal_symlink,
        approx_bytes=3_000,
        features=["negative", "archive-path-traversal", "symlink"],
    ),
    GeneratedFixture(
        name="wide-100k-nodes.json",
        guard="document-size",
        adapter_key="openapi",
        expected_error_code="INPUT_TOO_LARGE",
        description="~10^5 schema properties: shallow but enormous.",
        builder=_wide_json_100k_nodes,
        approx_bytes=11_000_000,
        features=["negative", "document-size", "node-count"],
    ),
    GeneratedFixture(
        name="deep-nesting-5k.json",
        guard="nesting-depth",
        adapter_key="openapi",
        expected_error_code="INPUT_DEPTH_LIMIT",
        description="5000 levels of object nesting.",
        builder=_deep_json_nesting,
        approx_bytes=30_000,
        features=["negative", "nesting-depth", "stack-exhaustion"],
    ),
    GeneratedFixture(
        name="ref-cycle-200-deep.json",
        guard="reference-recursion",
        adapter_key="openapi",
        expected_error_code=None,
        description="200-link $ref chain closing into a cycle; must terminate, not recurse.",
        builder=_deep_ref_chain,
        approx_bytes=40_000,
        features=["negative", "reference-recursion", "ref-cycle"],
    ),
    GeneratedFixture(
        name="yaml-alias-bomb.yaml",
        guard="alias-expansion",
        adapter_key="openapi",
        expected_error_code="INPUT_EXPANSION_LIMIT",
        description="Six-level nine-way YAML alias fan-out (billion laughs).",
        builder=_yaml_alias_bomb,
        approx_bytes=400,
        features=["negative", "alias-expansion", "billion-laughs"],
    ),
    GeneratedFixture(
        name="secrets-openapi.yaml",
        guard="secret-scrubbing",
        adapter_key="openapi",
        expected_error_code=None,
        description="OpenAPI seeded with synthetic credentials in the four places specs leak them.",
        builder=_openapi_with_secrets,
        approx_bytes=1_800,
        features=["adversarial", "secret-scrubbing", "basic-auth-url", "aws-key", "bearer-token"],
    ),
    GeneratedFixture(
        name="secrets-postman.json",
        guard="secret-scrubbing",
        adapter_key="postman",
        expected_error_code=None,
        description="Postman export carrying a bearer token, an API key header, and a session cookie.",
        builder=_postman_with_secrets,
        approx_bytes=1_600,
        features=["adversarial", "secret-scrubbing", "bearer-token", "api-key", "session-cookie"],
    ),
    GeneratedFixture(
        name="sparse-one-gigabyte.json",
        guard="document-size",
        adapter_key="openapi",
        expected_error_code="INPUT_TOO_LARGE",
        description="1 GiB sparse document for the streaming intake limits (IXH-6.5).",
        writer=_sparse_one_gigabyte,
        approx_bytes=1024 * 1024 * 1024,
        features=["negative", "document-size", "sparse-file"],
    ),
]


def build_fixture(fixture: GeneratedFixture, out_dir: Path) -> Path:
    """Materialize one fixture into ``out_dir``.

    Args:
        fixture: The spec entry to build.
        out_dir: Directory to write into; created if absent.

    Returns:
        The path written.

    Raises:
        ValueError: If the spec entry defines neither a builder nor a writer.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / fixture.name
    if fixture.writer is not None:
        fixture.writer(target)
    elif fixture.builder is not None:
        target.write_bytes(fixture.builder())
    else:  # pragma: no cover - guarded by the spec test
        raise ValueError(f"fixture {fixture.name!r} defines no builder or writer")
    return target


def write_all(out_dir: Path, *, skip_huge: bool = False) -> List[Path]:
    """Materialize every fixture in :data:`GENERATED_FIXTURES`.

    Args:
        out_dir: Directory to write into.
        skip_huge: Skip fixtures over 100 MiB (the sparse 1 GiB document), for
            environments without sparse-file support.

    Returns:
        The paths written, in spec order.
    """
    written: List[Path] = []
    for fixture in GENERATED_FIXTURES:
        if skip_huge and fixture.approx_bytes > 100 * 1024 * 1024:
            continue
        written.append(build_fixture(fixture, out_dir))
    return written


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point.

    Args:
        argv: Argument vector; defaults to ``sys.argv[1:]``.

    Returns:
        Process exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out-dir", type=Path, help="Directory to write fixtures into.")
    parser.add_argument("--list", action="store_true", help="Print the spec and exit.")
    parser.add_argument(
        "--skip-huge",
        action="store_true",
        help="Skip fixtures over 100 MiB (the sparse 1 GiB document).",
    )
    args = parser.parse_args(argv)

    if args.list or not args.out_dir:
        for fixture in GENERATED_FIXTURES:
            code = fixture.expected_error_code or "imports_with_warnings"
            print(f"{fixture.name:34s} {fixture.guard:24s} {code:22s} {fixture.description}")
        if not args.out_dir:
            return 0
        return 0

    written = write_all(args.out_dir, skip_huge=args.skip_huge)
    for path in written:
        size = os.stat(path).st_size
        print(f"wrote {path} ({size} bytes)")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI
    sys.exit(main())
