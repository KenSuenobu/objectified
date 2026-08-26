"""Offline mock bundle loading for the portable runtime (#4741, PMR-1.1).

The hosted runtime resolves a spec from Postgres (:mod:`apiome_mock.spec_loader`). The *portable*
runtime resolves the same thing from a single signed JSON file, with no database, no network, and
no tenant credentials — which is what lets a mock run in CI, on a laptop, or inside an air-gapped
network.

This module is the consumer half of the format defined in :mod:`app.mock_bundle` (the format
itself lives there so the publisher and the runtime can never drift). It:

* reads and parses a bundle document from disk or memory;
* verifies it — format id, **runtime compatibility window**, every content digest, the HMAC
  signature when a secret is configured, and a re-scan for credential-shaped content;
* compiles the embedded OpenAPI document, scenarios, and chaos knobs into the very same
  :class:`~apiome_mock.spec_loader.CompiledSpec` the hosted path produces, so every downstream
  behavior (routing, validation, sessions, scenarios, chaos) is identical.

Failures are explicit and typed: :class:`MockBundleIncompatibleError` means "this bundle is fine,
this runtime cannot run it" (with the required version range in the message), while
:class:`MockBundleError` covers corrupt, tampered, unsigned-but-required, or credential-bearing
bundles. Both carry the machine-readable ``problems`` list for structured logs and CLI output.

Bundles carry no wall clock — that is what makes their digest reproducible — so a loaded bundle
reports :data:`BUNDLE_EPOCH` as its ``updated_at``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, NoReturn
from uuid import UUID, uuid5

from app.mock_bundle import (
    COMPATIBILITY_CODES,
    BundleProblem,
    BundleVerification,
    verify_bundle,
)
from app.mock_engine import MockOperation, extract_operations

from apiome_mock import __version__
from apiome_mock.callbacks import CallbackDefinition, parse_callbacks
from apiome_mock.chaos import ChaosConfig, parse_chaos
from apiome_mock.fixture_data import decode_bundle_fixtures
from apiome_mock.fixture_packs import FixturePack, merged_template_data, parse_fixture_packs
from apiome_mock.scenarios import Scenario, parse_scenarios
from apiome_mock.spec_loader import CompiledSpec

__all__ = [
    "BUNDLE_EPOCH",
    "RUNTIME_VERSION",
    "LoadedBundle",
    "MockBundleError",
    "MockBundleIncompatibleError",
    "load_bundle_document",
    "load_bundle_file",
]

#: This runtime's own version, compared against every bundle's compatibility window.
RUNTIME_VERSION = __version__

#: Timestamp reported for bundle-served specs. A bundle is immutable and deliberately timestamp-free
#: (a clock in the manifest would break digest reproducibility), so the runtime uses the Unix epoch
#: rather than inventing a "loaded at" time that would look like content provenance.
BUNDLE_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

#: Namespace for deriving a stable revision UUID when a manifest pins a non-UUID revision id. Real
#: exports always carry the ``versions.id`` UUID; hand-written bundles (tests, fixtures corpora) may
#: not, and a bundle should still load rather than fail on an identifier the runtime only logs.
_REVISION_NAMESPACE = UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")


class MockBundleError(RuntimeError):
    """A bundle could not be loaded: malformed, tampered, unsigned, or credential-bearing.

    Attributes:
        problems: The structured verification problems behind the failure.
    """

    def __init__(self, message: str, problems: tuple[BundleProblem, ...] = ()) -> None:
        super().__init__(message)
        self.problems = problems

    @property
    def codes(self) -> tuple[str, ...]:
        """The machine-readable code of each problem, in detection order."""
        return tuple(problem.code for problem in self.problems)

    def as_dict(self) -> dict[str, Any]:
        """Render the failure for structured logging or CLI JSON output."""
        return {"error": str(self), "problems": [problem.as_dict() for problem in self.problems]}


class MockBundleIncompatibleError(MockBundleError):
    """The bundle is well-formed but targets a different runtime or bundle-format version."""


@dataclass(frozen=True)
class LoadedBundle:
    """A verified bundle, compiled into everything the runtime needs to serve it.

    Attributes:
        manifest: The verified manifest object.
        digest: The manifest digest (``sha256:<hex>``) — the bundle's stable identity.
        spec: The embedded OpenAPI document.
        operations: The compiled routing table.
        scenarios: Scenario overrides parsed from the bundled settings.
        chaos: Version-level chaos knobs parsed from the bundled settings.
        fixtures: Fixture entries declared by the manifest (name, media type, digest, size).
        fixture_data: Decoded fixture values by name, readable by response templates
            (#4744, PMR-2.1).
        fixture_packs: Versioned fixture packs parsed from the bundled settings, so portable
            sessions can seed and reset exactly like hosted ones (#4745, PMR-2.2).
        callbacks: Outbound callback/webhook definitions parsed from the bundled settings, so a
            portable mock exercises the same contract callbacks the hosted one does
            (#4746, PMR-2.3).
        signed: Whether the bundle carried a signature block.
        source: Filesystem path the bundle was read from, when it came from a file.
    """

    manifest: Mapping[str, Any]
    digest: str
    spec: dict[str, Any]
    operations: tuple[MockOperation, ...]
    scenarios: Mapping[str, Scenario]
    chaos: ChaosConfig
    fixtures: tuple[Mapping[str, Any], ...] = ()
    fixture_data: Mapping[str, Any] = field(default_factory=dict)
    fixture_packs: Mapping[str, FixturePack] = field(default_factory=dict)
    callbacks: Mapping[str, CallbackDefinition] = field(default_factory=dict)
    signed: bool = False
    source: Path | None = None

    @property
    def api(self) -> Mapping[str, Any]:
        """The pinned API coordinates (``tenant``/``project``/``version``/``revisionId``)."""
        api = self.manifest.get("api")
        return api if isinstance(api, Mapping) else {}

    @property
    def tenant_slug(self) -> str:
        """Tenant slug the bundle was exported for."""
        return str(self.api.get("tenant") or "")

    @property
    def project_slug(self) -> str:
        """Project slug the bundle was exported for."""
        return str(self.api.get("project") or "")

    @property
    def version_label(self) -> str:
        """Version label the bundle pins."""
        return str(self.api.get("version") or "")

    @property
    def cache_key(self) -> tuple[str, str, str]:
        """Slug coordinates, matching :attr:`CompiledSpec.cache_key`."""
        return (self.tenant_slug, self.project_slug, self.version_label)

    def to_compiled_spec(self) -> CompiledSpec:
        """Compile into the hosted runtime's serving unit.

        Returns:
            A :class:`~apiome_mock.spec_loader.CompiledSpec` identical in shape to one built from
            Postgres, so routing, validation, scenarios, and chaos behave the same offline.
        """
        return CompiledSpec(
            revision_id=_revision_uuid(self.api.get("revisionId")),
            tenant_slug=self.tenant_slug,
            project_slug=self.project_slug,
            version_label=self.version_label,
            updated_at=BUNDLE_EPOCH,
            spec=self.spec,
            operations=self.operations,
            scenarios=self.scenarios,
            chaos=self.chaos,
            # Pack data overlays the embedded fixture payloads, mirroring the hosted
            # fixtures-then-packs precedence (#4745, PMR-2.2).
            fixtures={**self.fixture_data, **merged_template_data(self.fixture_packs)},
            fixture_packs=self.fixture_packs,
            callbacks=self.callbacks,
        )


def _revision_uuid(raw: Any) -> UUID:
    """Coerce a manifest revision id to a UUID, deriving a stable one from non-UUID text."""
    text = str(raw or "")
    try:
        return UUID(text)
    except ValueError:
        return uuid5(_REVISION_NAMESPACE, text)


def _raise_for(verification: BundleVerification, *, source: Path | None) -> NoReturn:
    """Raise the typed error for a failed verification (compatibility failures first)."""
    where = f" ({source})" if source is not None else ""
    if verification.incompatible:
        codes = ", ".join(problem.code for problem in verification.problems if problem.code in COMPATIBILITY_CODES)
        raise MockBundleIncompatibleError(
            f"Mock bundle{where} is not compatible with apiome-mock {RUNTIME_VERSION} "
            f"[{codes}]: {verification.summary()}",
            verification.problems,
        )
    raise MockBundleError(
        f"Mock bundle{where} failed verification: {verification.summary()}",
        verification.problems,
    )


def load_bundle_document(
    document: Any,
    *,
    secret: str | None = None,
    require_signature: bool = False,
    source: Path | None = None,
) -> LoadedBundle:
    """Verify an already-parsed bundle document and compile it for serving.

    Args:
        document: The parsed bundle (as produced by ``app.mock_bundle.build_bundle``).
        secret: Shared HMAC secret. When supplied, the bundle must carry a signature that verifies.
        require_signature: Reject an unsigned bundle even when no ``secret`` is configured.
        source: Path the document came from, used only in error messages.

    Returns:
        The verified, compiled :class:`LoadedBundle`.

    Raises:
        MockBundleIncompatibleError: The bundle targets a different runtime or format version.
        MockBundleError: The bundle is malformed, tampered with, unsigned when required, or carries
            credential-shaped content.
    """
    verification = verify_bundle(
        document,
        runtime_version=RUNTIME_VERSION,
        secret=secret,
        require_signature=require_signature,
    )
    if not verification.ok or verification.digest is None:
        _raise_for(verification, source=source)

    # verify_bundle guarantees the shapes below once it reports ok.
    manifest: Mapping[str, Any] = document["manifest"]
    spec = dict(document.get("spec") or {})
    settings = document.get("settings") or {}
    contents = manifest.get("contents")
    fixtures = contents.get("fixtures") if isinstance(contents, Mapping) else []
    fixture_entries = tuple(entry for entry in fixtures or [] if isinstance(entry, Mapping))

    return LoadedBundle(
        manifest=manifest,
        digest=str(verification.digest),
        spec=spec,
        operations=tuple(extract_operations(spec)),
        scenarios=parse_scenarios(settings),
        chaos=parse_chaos(settings),
        fixtures=fixture_entries,
        fixture_data=decode_bundle_fixtures(fixture_entries, document.get("fixtures")),
        fixture_packs=parse_fixture_packs(settings),
        callbacks=parse_callbacks(settings),
        signed=document.get("signature") is not None,
        source=source,
    )


def load_bundle_file(
    path: str | Path,
    *,
    secret: str | None = None,
    require_signature: bool = False,
) -> LoadedBundle:
    """Read, verify, and compile a bundle file — the offline entry point.

    Nothing outside ``path`` is read: the bundle embeds its spec, settings, and fixtures, so this
    works with no database, no network, and no credentials.

    Args:
        path: Filesystem path of the bundle JSON document.
        secret: Shared HMAC secret. When supplied, the bundle must carry a signature that verifies.
        require_signature: Reject an unsigned bundle even when no ``secret`` is configured.

    Returns:
        The verified, compiled :class:`LoadedBundle`.

    Raises:
        MockBundleIncompatibleError: The bundle targets a different runtime or format version.
        MockBundleError: The file is missing, is not JSON, or the bundle fails verification.
    """
    bundle_path = Path(path)
    try:
        text = bundle_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise MockBundleError(f"Mock bundle could not be read ({bundle_path}): {exc}") from exc
    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        raise MockBundleError(f"Mock bundle ({bundle_path}) is not valid JSON: {exc}") from exc
    return load_bundle_document(
        document,
        secret=secret,
        require_signature=require_signature,
        source=bundle_path,
    )
