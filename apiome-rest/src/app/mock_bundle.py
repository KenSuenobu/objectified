"""Portable mock bundle format (PMR-1.1, #4741).

A **mock bundle** is the offline, version-pinned representation of a hosted mock: everything
apiome-mock needs to serve a version in CI, on a laptop, or inside an air-gapped network, with
no database, no network, and no tenant credentials.

The document has two halves:

* ``manifest`` — the *authoritative*, byte-stable description of the bundle: the format id and
  version, the runtime compatibility window, the API coordinates, a **version digest** over the
  canonically serialized version snapshot, and a content digest for every payload part (spec,
  mock settings, each fixture). The manifest never carries a wall clock, so republishing the same
  version with the same settings yields the *same* manifest digest.
* the payload parts themselves — ``spec`` (the generated OpenAPI document), ``settings`` (the
  portable subset of ``versions.mock_settings``), and ``fixtures`` (base64 blobs). They are
  embedded rather than referenced so the bundle loads with nothing else on disk.

``manifestDigest`` is SHA-256 over the manifest's canonical JSON, and ``signature`` is an
HMAC-SHA256 over the DSSE PAEv1 encoding of those same manifest bytes — the identical scheme used
by :mod:`app.lint_attestation`, so any holder of the shared secret can verify a bundle with stdlib
code alone. When no secret is configured the bundle is emitted unsigned (``signature: null``): a
well-formed bundle, just not verifiable.

**No tenant credentials.** Three layers enforce the acceptance criterion:

1. Only an allowlisted subset of ``mock_settings`` is bundled (:data:`BUNDLED_SETTINGS_KEYS`) —
   hosted-only access control such as the private-mock ``mode`` never travels.
2. :func:`redact_mock_settings` drops every credential-shaped key inside that subset (an author
   can type ``Authorization: Bearer …`` into a canned scenario response) and records the dropped
   JSON pointers in ``manifest.redactions``.
3. :func:`verify_bundle` re-scans the settings and fixtures of a *received* bundle and fails it
   with :data:`CODE_CREDENTIAL_PRESENT` if anything credential-shaped survived.

The generated OpenAPI document is deliberately **not** credential-scanned: it is the version's
published contract (``Authorization`` there is a security-scheme declaration, not a secret), and
it is already public wherever the hosted mock is.

Consumers: :mod:`apiome_mock.bundle` loads and verifies bundles; the CLI/Docker runtime (PMR-1.2)
and release-proof attestation (PMR-3.2) build on ``manifestDigest``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .mock_settings_util import parse_mock_settings

__all__ = [
    "BUNDLED_SETTINGS_KEYS",
    "BUNDLE_FORMAT",
    "BUNDLE_FORMAT_VERSION",
    "CODE_BUNDLE_FORMAT_UNSUPPORTED",
    "CODE_CREDENTIAL_PRESENT",
    "CODE_DIGEST_MISMATCH",
    "CODE_MALFORMED",
    "CODE_RUNTIME_TOO_NEW",
    "CODE_RUNTIME_TOO_OLD",
    "CODE_RUNTIME_VERSION_INVALID",
    "CODE_SIGNATURE_INVALID",
    "CODE_SIGNATURE_MISSING",
    "COMPATIBILITY_CODES",
    "DEFAULT_KEY_ID",
    "MAX_RUNTIME_VERSION",
    "MIN_RUNTIME_VERSION",
    "PAYLOAD_TYPE",
    "SUPPORTED_BUNDLE_FORMAT_VERSIONS",
    "BundleIdentity",
    "BundleProblem",
    "BundleVerification",
    "FixtureSource",
    "build_bundle",
    "bundle_bytes",
    "canonical_json",
    "content_digest",
    "find_credential_fields",
    "manifest_digest",
    "redact_mock_settings",
    "verify_bundle",
    "version_digest",
]

#: Media-type-shaped identifier of the bundle document family. A breaking change to the layout
#: mints a new one (``/v2``) rather than reusing this id with a different meaning.
BUNDLE_FORMAT = "apiome.mock.bundle/v1"

#: Additive revision of :data:`BUNDLE_FORMAT`. Bumped when new *optional* manifest fields appear;
#: a runtime rejects a bundle whose version is not in :data:`SUPPORTED_BUNDLE_FORMAT_VERSIONS`.
BUNDLE_FORMAT_VERSION = 1

#: Format versions this build can produce and consume.
SUPPORTED_BUNDLE_FORMAT_VERSIONS: Tuple[int, ...] = (1,)

#: Oldest apiome-mock that understands a bundle produced here (inclusive).
MIN_RUNTIME_VERSION = "0.2.0"

#: First apiome-mock assumed *not* to understand it (exclusive) — the next major line.
MAX_RUNTIME_VERSION = "1.0.0"

#: DSSE payload type of the signed manifest bytes.
PAYLOAD_TYPE = "application/vnd.apiome.mock-bundle+json"

#: Signature key id verifiers use to select the shared secret.
DEFAULT_KEY_ID = "apiome-mock-bundle-hmac-v1"

#: Digest algorithm label prefixed onto every digest string (``sha256:<hex>``).
DIGEST_ALGORITHM = "sha256"

#: The only ``versions.mock_settings`` keys that travel in a bundle. Everything else — notably the
#: private-mock ``mode`` — is hosted-plane access control with no meaning offline.
BUNDLED_SETTINGS_KEYS: Tuple[str, ...] = ("scenarios", "chaos")

# --- verification problem codes ---------------------------------------------------------------

#: The document is not a bundle at all (wrong/missing format id, non-object manifest, bad base64).
CODE_MALFORMED = "bundle-malformed"

#: ``manifest.bundleFormatVersion`` is outside :data:`SUPPORTED_BUNDLE_FORMAT_VERSIONS`.
CODE_BUNDLE_FORMAT_UNSUPPORTED = "bundle-format-unsupported"

#: This runtime is older than ``manifest.runtime.minRuntimeVersion``.
CODE_RUNTIME_TOO_OLD = "runtime-too-old"

#: This runtime is at or past ``manifest.runtime.maxRuntimeVersion``.
CODE_RUNTIME_TOO_NEW = "runtime-too-new"

#: A runtime bound (or the runtime's own version) is not parseable as ``major.minor.patch``.
CODE_RUNTIME_VERSION_INVALID = "runtime-version-invalid"

#: A recomputed content digest does not match the manifest.
CODE_DIGEST_MISMATCH = "digest-mismatch"

#: The bundle is unsigned but a signature was required.
CODE_SIGNATURE_MISSING = "signature-missing"

#: The signature does not verify against the shared secret.
CODE_SIGNATURE_INVALID = "signature-invalid"

#: Credential-shaped content survived into the bundle.
CODE_CREDENTIAL_PRESENT = "credential-present"

#: The subset of codes that mean "this bundle is fine, this runtime cannot run it" — the caller
#: reports these as a compatibility failure rather than a corrupt or untrusted bundle.
COMPATIBILITY_CODES = frozenset(
    {
        CODE_BUNDLE_FORMAT_UNSUPPORTED,
        CODE_RUNTIME_TOO_OLD,
        CODE_RUNTIME_TOO_NEW,
        CODE_RUNTIME_VERSION_INVALID,
    }
)

#: Substrings that make a JSON key credential-shaped. Matched case-insensitively against keys with
#: separators stripped, so ``api_key``, ``apiKey``, and ``API-KEY`` all hit ``apikey``.
_CREDENTIAL_KEY_FRAGMENTS: Tuple[str, ...] = (
    "secret",
    "password",
    "passwd",
    "token",
    "credential",
    "apikey",
    "privatekey",
    "authorization",
    "accesskey",
    "signingkey",
    "encryptionkey",
    "proxyauthorization",
)

#: Value prefixes that are credentials regardless of the key they hang off.
_CREDENTIAL_VALUE_PREFIXES: Tuple[str, ...] = (
    "-----begin ",  # PEM private keys / certificates
    "bearer ",
    "basic ",
)


# ==================================================================================================
# Canonical serialization and digests
# ==================================================================================================


def canonical_json(value: Any) -> str:
    """Serialize ``value`` to byte-stable JSON: keys sorted recursively, compact separators.

    Args:
        value: Any JSON-serializable value.

    Returns:
        The canonical JSON text. Two structurally equal values always produce identical bytes,
        which is what makes bundle digests reproducible.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def content_digest(value: Any) -> str:
    """Return ``sha256:<hex>`` over the canonical JSON of ``value``.

    Args:
        value: Any JSON-serializable value.

    Returns:
        The prefixed digest string stored in a manifest.
    """
    return _digest_bytes(canonical_json(value).encode("utf-8"))


def _digest_bytes(payload: bytes) -> str:
    """Return ``sha256:<hex>`` over raw bytes (used for fixture blobs and manifest bytes)."""
    return f"{DIGEST_ALGORITHM}:{hashlib.sha256(payload).hexdigest()}"


def version_digest(identity: "BundleIdentity", spec: Mapping[str, Any]) -> str:
    """Digest the canonically serialized version snapshot (coordinates + contract document).

    This is the "same version in, same digest out" anchor: it depends only on *what the version
    is*, never on when the bundle was built or who asked for it.

    Args:
        identity: The API coordinates the bundle pins.
        spec: The generated OpenAPI document for that version.

    Returns:
        ``sha256:<hex>`` over ``{"api": <identity>, "spec": <spec>}``.
    """
    return content_digest({"api": identity.as_dict(), "spec": spec})


def bundle_bytes(bundle: Mapping[str, Any]) -> bytes:
    """Render a bundle document to the exact bytes that should be written to disk.

    Args:
        bundle: A bundle produced by :func:`build_bundle`.

    Returns:
        Canonical JSON bytes (trailing newline included), so the *file* is byte-reproducible too.
    """
    return (canonical_json(bundle) + "\n").encode("utf-8")


def manifest_digest(manifest: Mapping[str, Any]) -> str:
    """Return ``sha256:<hex>`` over the manifest's canonical JSON — the bundle's identity.

    Args:
        manifest: The ``manifest`` object of a bundle.

    Returns:
        The digest string published as ``manifestDigest`` and attached to release proofs.
    """
    return content_digest(manifest)


# ==================================================================================================
# Credential scanning and redaction
# ==================================================================================================


def _normalize_key(key: str) -> str:
    """Lowercase a key and strip separators so ``api_key``/``apiKey``/``API-KEY`` all compare equal."""
    return "".join(ch for ch in key.lower() if ch.isalnum())


def _is_credential_key(key: str) -> bool:
    """Does this key name a credential?"""
    normalized = _normalize_key(key)
    return any(fragment in normalized for fragment in _CREDENTIAL_KEY_FRAGMENTS)


def _is_credential_value(value: Any) -> bool:
    """Does this value look like a credential regardless of the key it hangs off (PEM, ``Bearer …``)?"""
    if not isinstance(value, str):
        return False
    lowered = value.strip().lower()
    return any(lowered.startswith(prefix) for prefix in _CREDENTIAL_VALUE_PREFIXES)


def _escape_pointer_segment(segment: str) -> str:
    """Escape one RFC 6901 JSON pointer segment (``~`` → ``~0``, ``/`` → ``~1``)."""
    return segment.replace("~", "~0").replace("/", "~1")


def find_credential_fields(value: Any, *, pointer: str = "") -> List[str]:
    """Find credential-shaped content anywhere in ``value``.

    A field is credential-shaped when its **key** matches :data:`_CREDENTIAL_KEY_FRAGMENTS` and it
    holds anything non-empty (including a wrapper object, so a secret cannot hide one level down),
    or when its **value** starts with a credential marker (a PEM block, ``Bearer``/``Basic``
    authorization). Empty strings, empty containers, and ``None`` are ignored: a declared-but-blank
    header is a placeholder, not a secret.

    Args:
        value: Any JSON-shaped value (typically bundled settings or a fixture payload).
        pointer: RFC 6901 pointer prefix for the reported locations.

    Returns:
        Sorted RFC 6901 JSON pointers of every offending field (empty when clean).
    """
    found: List[str] = []
    _walk_for_credentials(value, pointer, found)
    return sorted(found)


def _walk_for_credentials(value: Any, pointer: str, found: List[str]) -> None:
    """Recursive worker for :func:`find_credential_fields`."""
    if isinstance(value, Mapping):
        for raw_key, child in value.items():
            key = str(raw_key)
            child_pointer = f"{pointer}/{_escape_pointer_segment(key)}"
            if _is_credential_key(key) and _is_populated(child):
                found.append(child_pointer)
                continue
            _walk_for_credentials(child, child_pointer, found)
        return
    if isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            _walk_for_credentials(child, f"{pointer}/{index}", found)
        return
    if _is_credential_value(value):
        found.append(pointer)


def _is_populated(value: Any) -> bool:
    """True when a value carries content (a blank placeholder is not a secret).

    Containers count as populated when non-empty, so a credential-shaped key never smuggles a
    secret past the scan by wrapping it (``{"token": {"value": "…"}}`` is dropped whole).
    """
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (Mapping, list, tuple)):
        return bool(value)
    return True


def redact_mock_settings(mock_settings: Any) -> Tuple[Dict[str, Any], Tuple[str, ...]]:
    """Project ``versions.mock_settings`` to the portable, credential-free subset.

    Keeps only :data:`BUNDLED_SETTINGS_KEYS`, then removes every credential-shaped field found
    inside them (see :func:`find_credential_fields`). Removal — rather than masking — keeps even
    the *length* of a secret out of the bundle.

    Args:
        mock_settings: The raw ``versions.mock_settings`` JSONB value (dict, JSON text, or ``None``).

    Returns:
        ``(settings, redactions)`` where ``settings`` is the bundled subset and ``redactions`` is
        the sorted tuple of JSON pointers (relative to ``settings``) that were dropped.
    """
    parsed = parse_mock_settings(mock_settings)
    subset: Dict[str, Any] = {
        key: parsed[key] for key in BUNDLED_SETTINGS_KEYS if key in parsed and parsed[key] is not None
    }
    redactions: List[str] = []
    cleaned = _redact(subset, "", redactions)
    if not isinstance(cleaned, dict):  # pragma: no cover - subset is always a dict
        cleaned = {}
    return cleaned, tuple(sorted(redactions))


def _redact(value: Any, pointer: str, redactions: List[str]) -> Any:
    """Return a copy of ``value`` with credential-shaped fields removed, recording their pointers."""
    if isinstance(value, Mapping):
        result: Dict[str, Any] = {}
        for raw_key, child in value.items():
            key = str(raw_key)
            child_pointer = f"{pointer}/{_escape_pointer_segment(key)}"
            if (_is_credential_key(key) and _is_populated(child)) or _is_credential_value(child):
                redactions.append(child_pointer)
                continue
            result[key] = _redact(child, child_pointer, redactions)
        return result
    if isinstance(value, (list, tuple)):
        return [_redact(child, f"{pointer}/{index}", redactions) for index, child in enumerate(value)]
    return value


# ==================================================================================================
# Bundle construction
# ==================================================================================================


@dataclass(frozen=True)
class BundleIdentity:
    """The API coordinates a bundle pins.

    Attributes:
        tenant: Tenant slug that owns the version.
        project: Project slug.
        version: Version label (e.g. ``"1.0.0"``).
        revision_id: The immutable ``versions.id`` of the pinned revision.
        published: Whether the pinned revision is published.
        protocol: Optional protocol/paradigm label (e.g. ``"openapi"``).
    """

    tenant: str
    project: str
    version: str
    revision_id: str
    published: bool = True
    protocol: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        """Render the coordinates as the manifest's ``api`` object (``protocol`` omitted when unset)."""
        api: Dict[str, Any] = {
            "tenant": self.tenant,
            "project": self.project,
            "version": self.version,
            "revisionId": self.revision_id,
            "published": bool(self.published),
        }
        if self.protocol:
            api["protocol"] = self.protocol
        return api


@dataclass(frozen=True)
class FixtureSource:
    """One fixture blob to embed in a bundle.

    Attributes:
        name: Unique name within the bundle (fixture pack entry name).
        content: Raw fixture bytes.
        media_type: Media type recorded in the manifest.
    """

    name: str
    content: bytes
    media_type: str = "application/json"


@dataclass(frozen=True)
class BundleProblem:
    """One reason a bundle failed verification.

    Attributes:
        code: Stable machine code (one of the ``CODE_*`` constants).
        message: Human-readable explanation, safe to log and to show in CLI output.
        pointer: Optional RFC 6901 pointer to the offending field.
    """

    code: str
    message: str
    pointer: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        """Render for JSON output (``pointer`` omitted when absent)."""
        payload: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.pointer is not None:
            payload["pointer"] = self.pointer
        return payload


@dataclass(frozen=True)
class BundleVerification:
    """Outcome of :func:`verify_bundle`.

    Attributes:
        ok: True when no problems were found.
        problems: Every problem discovered, in detection order.
        digest: The recomputed manifest digest (``None`` when the document is too malformed).
    """

    ok: bool
    problems: Tuple[BundleProblem, ...] = ()
    digest: Optional[str] = None

    @property
    def incompatible(self) -> bool:
        """True when at least one problem is a runtime/format compatibility failure."""
        return any(problem.code in COMPATIBILITY_CODES for problem in self.problems)

    def summary(self) -> str:
        """One-line, human-readable rollup of the problems (``"verified"`` when clean)."""
        if self.ok:
            return "verified"
        return "; ".join(f"{problem.code}: {problem.message}" for problem in self.problems)


def build_bundle(
    *,
    identity: BundleIdentity,
    spec: Mapping[str, Any],
    mock_settings: Any = None,
    fixtures: Sequence[FixtureSource] = (),
    secret: Optional[str] = None,
    key_id: str = DEFAULT_KEY_ID,
) -> Dict[str, Any]:
    """Build a signed, self-contained mock bundle for one version.

    The result is fully deterministic: the same version, settings, and fixtures always produce an
    identical document (and therefore an identical ``manifestDigest``), because nothing in it is
    derived from a clock, a request, or process state.

    Args:
        identity: API coordinates to pin.
        spec: The generated OpenAPI document for the version.
        mock_settings: Raw ``versions.mock_settings``; projected and redacted before embedding.
        fixtures: Fixture blobs to embed. Names must be unique.
        secret: Shared HMAC secret; ``None`` emits an unsigned (``signature: null``) bundle.
        key_id: Signature key id recorded for verifiers.

    Returns:
        The bundle document, ready to serialize with :func:`bundle_bytes`.

    Raises:
        ValueError: If two fixtures share a name.
    """
    settings, redactions = redact_mock_settings(mock_settings)
    entries, payloads = _fixture_entries(fixtures)

    manifest: Dict[str, Any] = {
        "bundleFormat": BUNDLE_FORMAT,
        "bundleFormatVersion": BUNDLE_FORMAT_VERSION,
        "runtime": {
            "minRuntimeVersion": MIN_RUNTIME_VERSION,
            "maxRuntimeVersion": MAX_RUNTIME_VERSION,
        },
        "api": identity.as_dict(),
        "versionDigest": version_digest(identity, spec),
        "contents": {
            "spec": {"digest": content_digest(spec), "mediaType": "application/json"},
            "settings": {"digest": content_digest(settings)},
            "fixtures": entries,
        },
        "fixturesDigest": content_digest(entries),
        "redactions": list(redactions),
    }

    payload_bytes = canonical_json(manifest).encode("utf-8")
    return {
        "bundleFormat": BUNDLE_FORMAT,
        "manifest": manifest,
        "manifestDigest": _digest_bytes(payload_bytes),
        "signature": _sign(payload_bytes, secret=secret, key_id=key_id),
        "spec": dict(spec),
        "settings": settings,
        "fixtures": payloads,
    }


def _fixture_entries(
    fixtures: Sequence[FixtureSource],
) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """Build the manifest fixture entries and the base64 payload map.

    Entries are sorted by name so fixture ordering at the call site never changes the digest.

    Args:
        fixtures: The fixture blobs to embed.

    Returns:
        ``(entries, payloads)`` — manifest entries and ``{name: base64 content}``.

    Raises:
        ValueError: If two fixtures share a name.
    """
    entries: List[Dict[str, Any]] = []
    payloads: Dict[str, str] = {}
    for fixture in sorted(fixtures, key=lambda item: item.name):
        if fixture.name in payloads:
            raise ValueError(f"duplicate fixture name in bundle: {fixture.name!r}")
        entries.append(
            {
                "name": fixture.name,
                "mediaType": fixture.media_type,
                "digest": _digest_bytes(fixture.content),
                "bytes": len(fixture.content),
            }
        )
        payloads[fixture.name] = base64.b64encode(fixture.content).decode("ascii")
    return entries, payloads


# ==================================================================================================
# Signing
# ==================================================================================================


def _pae(payload_type: str, payload: bytes) -> bytes:
    """DSSE Pre-Authentication Encoding v1: ``DSSEv1 <len> <type> <len> <payload>``."""
    type_bytes = payload_type.encode("utf-8")
    return b" ".join(
        [
            b"DSSEv1",
            str(len(type_bytes)).encode("ascii"),
            type_bytes,
            str(len(payload)).encode("ascii"),
            payload,
        ]
    )


def _signature_hex(payload: bytes, secret: str) -> str:
    """Hex HMAC-SHA256 over the PAE bytes of the manifest payload."""
    return hmac.new(secret.encode("utf-8"), _pae(PAYLOAD_TYPE, payload), hashlib.sha256).hexdigest()


def _sign(payload: bytes, *, secret: Optional[str], key_id: str) -> Optional[Dict[str, Any]]:
    """Return the signature block for manifest bytes, or ``None`` when no secret is configured."""
    if not secret:
        return None
    return {
        "payloadType": PAYLOAD_TYPE,
        "keyId": key_id,
        "alg": "hmac-sha256",
        "sig": _signature_hex(payload, secret),
    }


# ==================================================================================================
# Verification
# ==================================================================================================


@dataclass
class _ProblemCollector:
    """Mutable problem list shared by the verification steps."""

    problems: List[BundleProblem] = field(default_factory=list)

    def add(self, code: str, message: str, pointer: Optional[str] = None) -> None:
        """Record one problem."""
        self.problems.append(BundleProblem(code=code, message=message, pointer=pointer))


def verify_bundle(
    bundle: Any,
    *,
    runtime_version: Optional[str] = None,
    secret: Optional[str] = None,
    require_signature: bool = False,
) -> BundleVerification:
    """Verify a bundle end to end: structure, compatibility, digests, signature, credentials.

    Every check runs even after an earlier one fails (except when the document is too malformed to
    inspect further), so a caller reports *all* the reasons a bundle was rejected instead of the
    first one.

    Args:
        bundle: The parsed bundle document.
        runtime_version: The consuming runtime's own ``major.minor.patch`` version. When given, the
            format id/version and the manifest's runtime window are enforced; when ``None`` the
            compatibility checks are skipped (useful for producer-side self-checks).
        secret: Shared HMAC secret. When given, the signature must be present and valid.
        require_signature: Fail an unsigned bundle even when no ``secret`` was supplied.

    Returns:
        A :class:`BundleVerification`; ``ok`` is True only when nothing was found.
    """
    collector = _ProblemCollector()

    if not isinstance(bundle, Mapping):
        collector.add(CODE_MALFORMED, "Bundle document is not a JSON object.")
        return BundleVerification(ok=False, problems=tuple(collector.problems))

    manifest = bundle.get("manifest")
    if not isinstance(manifest, Mapping):
        collector.add(CODE_MALFORMED, "Bundle is missing its 'manifest' object.", "/manifest")
        return BundleVerification(ok=False, problems=tuple(collector.problems))

    if bundle.get("bundleFormat") != BUNDLE_FORMAT or manifest.get("bundleFormat") != BUNDLE_FORMAT:
        collector.add(
            CODE_MALFORMED,
            f"Bundle format id must be {BUNDLE_FORMAT!r} on both the document and its manifest.",
            "/bundleFormat",
        )

    digest = manifest_digest(manifest)

    if runtime_version is not None:
        _check_compatibility(manifest, runtime_version, collector)
    _check_digests(bundle, manifest, collector)
    _check_manifest_digest(bundle, digest, collector)
    _check_signature(bundle, manifest, secret=secret, require_signature=require_signature, collector=collector)
    _check_credentials(bundle, collector)

    return BundleVerification(ok=not collector.problems, problems=tuple(collector.problems), digest=digest)


def _parse_version(text: Any) -> Optional[Tuple[int, int, int]]:
    """Parse ``major.minor.patch`` (pre-release/build suffixes ignored); ``None`` when unparseable."""
    if not isinstance(text, str):
        return None
    core = text.strip().split("+", 1)[0].split("-", 1)[0]
    parts = core.split(".")
    if len(parts) != 3:
        return None
    try:
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None


def _check_compatibility(
    manifest: Mapping[str, Any], runtime_version: str, collector: _ProblemCollector
) -> None:
    """Enforce the format version and the manifest's runtime window against this runtime."""
    format_version = manifest.get("bundleFormatVersion")
    if format_version not in SUPPORTED_BUNDLE_FORMAT_VERSIONS:
        collector.add(
            CODE_BUNDLE_FORMAT_UNSUPPORTED,
            (
                f"Bundle format version {format_version!r} is not supported by this runtime "
                f"(supported: {', '.join(str(v) for v in SUPPORTED_BUNDLE_FORMAT_VERSIONS)})."
            ),
            "/manifest/bundleFormatVersion",
        )

    runtime = manifest.get("runtime") if isinstance(manifest.get("runtime"), Mapping) else {}
    current = _parse_version(runtime_version)
    if current is None:
        collector.add(
            CODE_RUNTIME_VERSION_INVALID,
            f"Runtime version {runtime_version!r} is not a major.minor.patch version.",
        )
        return

    minimum_raw = runtime.get("minRuntimeVersion")
    maximum_raw = runtime.get("maxRuntimeVersion")
    minimum = _parse_version(minimum_raw)
    maximum = _parse_version(maximum_raw)

    if minimum_raw is not None and minimum is None:
        collector.add(
            CODE_RUNTIME_VERSION_INVALID,
            f"Manifest minRuntimeVersion {minimum_raw!r} is not a major.minor.patch version.",
            "/manifest/runtime/minRuntimeVersion",
        )
    elif minimum is not None and current < minimum:
        collector.add(
            CODE_RUNTIME_TOO_OLD,
            (
                f"Bundle requires apiome-mock >= {minimum_raw}; this runtime is {runtime_version}. "
                "Upgrade the runtime or rebuild the bundle."
            ),
            "/manifest/runtime/minRuntimeVersion",
        )

    if maximum_raw is not None and maximum is None:
        collector.add(
            CODE_RUNTIME_VERSION_INVALID,
            f"Manifest maxRuntimeVersion {maximum_raw!r} is not a major.minor.patch version.",
            "/manifest/runtime/maxRuntimeVersion",
        )
    elif maximum is not None and current >= maximum:
        collector.add(
            CODE_RUNTIME_TOO_NEW,
            (
                f"Bundle supports apiome-mock < {maximum_raw}; this runtime is {runtime_version}. "
                "Rebuild the bundle with a runtime-compatible publisher."
            ),
            "/manifest/runtime/maxRuntimeVersion",
        )


def _check_digests(
    bundle: Mapping[str, Any], manifest: Mapping[str, Any], collector: _ProblemCollector
) -> None:
    """Recompute every payload digest and compare it with the manifest."""
    contents = manifest.get("contents")
    if not isinstance(contents, Mapping):
        collector.add(CODE_MALFORMED, "Manifest is missing its 'contents' object.", "/manifest/contents")
        return

    _compare_digest(
        contents.get("spec"), bundle.get("spec"), part="spec", pointer="/spec", collector=collector
    )
    _compare_digest(
        contents.get("settings"),
        bundle.get("settings"),
        part="settings",
        pointer="/settings",
        collector=collector,
    )

    entries = contents.get("fixtures")
    if not isinstance(entries, list):
        collector.add(
            CODE_MALFORMED, "Manifest fixtures must be a list.", "/manifest/contents/fixtures"
        )
        return

    if manifest.get("fixturesDigest") != content_digest(entries):
        collector.add(
            CODE_DIGEST_MISMATCH,
            "Fixture list digest does not match the manifest.",
            "/manifest/fixturesDigest",
        )

    payloads = bundle.get("fixtures")
    if not isinstance(payloads, Mapping):
        payloads = {}
    for index, entry in enumerate(entries):
        _check_fixture(entry, payloads, index, collector)


def _compare_digest(
    entry: Any, payload: Any, *, part: str, pointer: str, collector: _ProblemCollector
) -> None:
    """Compare one manifest content entry's digest against the bundled payload."""
    expected = entry.get("digest") if isinstance(entry, Mapping) else None
    if not isinstance(expected, str):
        collector.add(
            CODE_MALFORMED, f"Manifest has no digest for the {part} payload.", f"/manifest/contents/{part}"
        )
        return
    if content_digest(payload if payload is not None else {}) != expected:
        collector.add(
            CODE_DIGEST_MISMATCH, f"Bundled {part} does not match its manifest digest.", pointer
        )


def _check_fixture(
    entry: Any, payloads: Mapping[str, Any], index: int, collector: _ProblemCollector
) -> None:
    """Verify one fixture entry against its embedded base64 blob."""
    pointer = f"/manifest/contents/fixtures/{index}"
    if not isinstance(entry, Mapping):
        collector.add(CODE_MALFORMED, "Fixture entry is not an object.", pointer)
        return
    name = entry.get("name")
    if not isinstance(name, str) or not name:
        collector.add(CODE_MALFORMED, "Fixture entry has no name.", pointer)
        return
    encoded = payloads.get(name)
    if not isinstance(encoded, str):
        collector.add(
            CODE_MALFORMED,
            f"Fixture {name!r} is declared in the manifest but not embedded in the bundle.",
            f"/fixtures/{_escape_pointer_segment(name)}",
        )
        return
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        collector.add(
            CODE_MALFORMED,
            f"Fixture {name!r} is not valid base64.",
            f"/fixtures/{_escape_pointer_segment(name)}",
        )
        return
    if _digest_bytes(content) != entry.get("digest") or len(content) != entry.get("bytes"):
        collector.add(
            CODE_DIGEST_MISMATCH,
            f"Fixture {name!r} does not match its manifest digest.",
            f"/fixtures/{_escape_pointer_segment(name)}",
        )


def _check_manifest_digest(
    bundle: Mapping[str, Any], digest: str, collector: _ProblemCollector
) -> None:
    """Compare the document's published ``manifestDigest`` with the recomputed one."""
    published = bundle.get("manifestDigest")
    if not isinstance(published, str):
        collector.add(CODE_MALFORMED, "Bundle is missing 'manifestDigest'.", "/manifestDigest")
        return
    if not hmac.compare_digest(published, digest):
        collector.add(
            CODE_DIGEST_MISMATCH,
            f"Manifest digest mismatch: document says {published}, content hashes to {digest}.",
            "/manifestDigest",
        )


def _check_signature(
    bundle: Mapping[str, Any],
    manifest: Mapping[str, Any],
    *,
    secret: Optional[str],
    require_signature: bool,
    collector: _ProblemCollector,
) -> None:
    """Verify the HMAC signature over the manifest bytes when one is required."""
    signature = bundle.get("signature")
    if signature is None:
        if secret or require_signature:
            collector.add(
                CODE_SIGNATURE_MISSING,
                "Bundle is unsigned but a verified signature was required.",
                "/signature",
            )
        return
    if not isinstance(signature, Mapping):
        collector.add(CODE_MALFORMED, "Bundle signature is not an object.", "/signature")
        return
    if signature.get("payloadType") != PAYLOAD_TYPE:
        collector.add(
            CODE_SIGNATURE_INVALID,
            f"Signature payload type must be {PAYLOAD_TYPE!r}.",
            "/signature/payloadType",
        )
        return
    if not secret:
        # Nothing to verify against: an unverified signature is reported only when one was asked for.
        if require_signature:
            collector.add(
                CODE_SIGNATURE_MISSING,
                "No shared secret was supplied, so the bundle signature could not be verified.",
                "/signature",
            )
        return
    expected = _signature_hex(canonical_json(manifest).encode("utf-8"), secret)
    if not hmac.compare_digest(str(signature.get("sig") or ""), expected):
        collector.add(
            CODE_SIGNATURE_INVALID,
            "Bundle signature does not verify against the configured secret.",
            "/signature/sig",
        )


def _check_credentials(bundle: Mapping[str, Any], collector: _ProblemCollector) -> None:
    """Fail the bundle if credential-shaped content survived into settings or fixtures.

    The OpenAPI document is exempt by design: it is the version's public contract, where
    ``Authorization`` names a security scheme rather than carrying a secret.
    """
    for pointer in find_credential_fields(bundle.get("settings"), pointer="/settings"):
        collector.add(
            CODE_CREDENTIAL_PRESENT, "Credential-shaped value present in bundled settings.", pointer
        )
    for pointer in find_credential_fields(_decoded_fixtures(bundle), pointer="/fixtures"):
        collector.add(
            CODE_CREDENTIAL_PRESENT, "Credential-shaped value present in a bundled fixture.", pointer
        )


def _decoded_fixtures(bundle: Mapping[str, Any]) -> Dict[str, Any]:
    """Decode embedded fixtures to JSON where possible so they can be credential-scanned.

    Fixtures that are not base64, not UTF-8, or not JSON are scanned as opaque text (or skipped
    when undecodable) — a binary blob has no keys to inspect.
    """
    payloads = bundle.get("fixtures")
    if not isinstance(payloads, Mapping):
        return {}
    decoded: Dict[str, Any] = {}
    for name, encoded in payloads.items():
        if not isinstance(encoded, str):
            continue
        try:
            text = base64.b64decode(encoded, validate=True).decode("utf-8")
        except (binascii.Error, ValueError, UnicodeDecodeError):
            continue
        try:
            decoded[str(name)] = json.loads(text)
        except json.JSONDecodeError:
            decoded[str(name)] = text
    return decoded
