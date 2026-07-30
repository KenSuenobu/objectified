"""APX-3.4 agent outputs — deterministic, machine-readable portal metadata (#2459).

Coding agents cannot safely consume a human documentation portal from HTML pages
alone. This module turns the **approved content** of one published version (the
:class:`~app.canonical_model.CanonicalApi` for that revision) plus its portal
policy into the deterministic agent-facing artifacts a Slate portal exposes:

* ``llms.txt`` — an agent-readable index of the portal, linking every operation
  and schema to its canonical human page (the `llms.txt` convention).
* a **catalog / format-capability manifest** — the machine-readable inventory of
  operations, schemas and channels, plus the capabilities Slate actually supports
  for the source format (Try It, code samples, search, changelog, …).
* a **release manifest** — the versioned release metadata (version label, publish
  time, content digest, canonical/changelog URLs, latest/deprecated flags).
* ``robots.txt`` — the crawl policy, which honours the portal's public/private
  state so private portals are never advertised to crawlers or agents.
* an **index** document — the versioned machine-readable metadata that lists every
  output above with its stable URL, media type, ETag and size.

**Determinism contract.** This module is pure: it touches no database, no network
and no clock. Every timestamp is supplied by the caller, ordering is total and
stable (operations/schemas sorted by canonical key, fragment ids disambiguated by
a content hash of the key), and JSON is emitted as canonical, sorted text. Identical
input therefore yields byte-identical output, so an ETag computed over the body is a
stable cache validator (the route layer adds ``Cache-Control`` + ``If-None-Match``).

**Privacy contract.** When the portal is not indexable (a published-but-private
portal, or a robots-excluded lane), the content-bearing outputs withhold every API
name, description, URL and count — ``robots.txt`` disallows all crawling and the
manifests carry ``contentWithheld: true`` with an empty inventory. Private or
unauthorized content is never emitted, independent of who calls the route.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .canonical_model import ApiParadigm, CanonicalApi, Operation, Type

__all__ = [
    "AGENT_OUTPUTS_SCHEMA_VERSION",
    "CATALOG_MANIFEST_SCHEMA_VERSION",
    "RELEASE_MANIFEST_SCHEMA_VERSION",
    "AGENT_OUTPUT_GENERATOR",
    "AGENT_OUTPUT_GENERATOR_VERSION",
    "AGENT_OUTPUT_NAMES",
    "AGENT_OUTPUT_MEDIA_TYPES",
    "FORMAT_CAPABILITIES",
    "AgentOutput",
    "AgentOutputBundle",
    "ChangelogSummary",
    "PortalContext",
    "build_agent_outputs",
    "build_catalog_manifest",
    "build_llms_txt",
    "build_release_manifest",
    "build_robots_txt",
    "capabilities_for_paradigm",
    "output_etag",
]

#: Stable schema id of the index / envelope document.
AGENT_OUTPUTS_SCHEMA_VERSION = "slate.agent-outputs.v1"
#: Stable schema id of the catalog / format-capability manifest.
CATALOG_MANIFEST_SCHEMA_VERSION = "slate.catalog.v1"
#: Stable schema id of the release manifest.
RELEASE_MANIFEST_SCHEMA_VERSION = "slate.release.v1"

#: Generator identity stamped into every manifest (provenance for consumers).
AGENT_OUTPUT_GENERATOR = "apiome-slate-agent-outputs"
#: Generator version — bump when the *output shape* changes in a way consumers observe.
AGENT_OUTPUT_GENERATOR_VERSION = "1"

#: The ordered, stable set of output names this module produces.
AGENT_OUTPUT_NAMES: Tuple[str, ...] = ("index", "llms.txt", "robots.txt", "catalog", "release")

#: Content-type each output is served with (the route mirrors this on the wire).
AGENT_OUTPUT_MEDIA_TYPES: Dict[str, str] = {
    "index": "application/json; charset=utf-8",
    "llms.txt": "text/plain; charset=utf-8",
    "robots.txt": "text/plain; charset=utf-8",
    "catalog": "application/json; charset=utf-8",
    "release": "application/json; charset=utf-8",
}

#: Longest description echoed into a bullet / summary field (keeps outputs bounded on
#: large catalogs). Descriptions are first-line-only and hard-trimmed to this length.
_SUMMARY_MAX_CHARS = 160


@dataclass(frozen=True)
class _FormatCapability:
    """What Slate actually supports for one API paradigm — the honest product state.

    ``support_tier`` mirrors the roadmap launch-format tiers ("native" launch formats
    vs enterprise-render vs legacy-migration). The booleans mirror the commercial-MVP
    boundary: interactive execution and code samples are REST-only at launch; reference
    rendering, search and changelog apply to every native format.
    """

    support_tier: str
    reference: bool
    search: bool
    changelog: bool
    try_it: bool
    code_samples: bool

    def as_dict(self) -> Dict[str, Any]:
        """Emit the camelCase capability object, always including the agent-outputs flag."""
        return {
            "supportTier": self.support_tier,
            "reference": self.reference,
            "search": self.search,
            "changelog": self.changelog,
            "tryIt": self.try_it,
            "codeSamples": self.code_samples,
            "agentOutputs": True,
        }


# Capability matrix keyed by canonical paradigm. Values reflect the *actual* supported
# product state at the commercial MVP boundary, not aspiration: REST (OpenAPI/Swagger)
# is the only paradigm with interactive Try It and generated code samples at launch;
# multi-protocol execution is V2. Every native paradigm gets protocol-aware reference
# rendering, client-side search and deterministic changelog.
FORMAT_CAPABILITIES: Dict[ApiParadigm, _FormatCapability] = {
    ApiParadigm.REST: _FormatCapability("native", True, True, True, True, True),
    ApiParadigm.RPC: _FormatCapability("native", True, True, True, False, False),
    ApiParadigm.EVENT: _FormatCapability("native", True, True, True, False, False),
    ApiParadigm.GRAPH: _FormatCapability("native", True, True, True, False, False),
    ApiParadigm.DATA_SCHEMA: _FormatCapability("native", True, True, True, False, False),
    ApiParadigm.AGENT: _FormatCapability("native", True, True, True, False, False),
}

# Fallback for any paradigm not in the matrix (defensive; keeps output well-formed).
_UNKNOWN_CAPABILITY = _FormatCapability("render-only", True, True, False, False, False)


def capabilities_for_paradigm(paradigm: ApiParadigm) -> Dict[str, Any]:
    """Return the camelCase capability object for ``paradigm`` (never raises)."""
    return FORMAT_CAPABILITIES.get(paradigm, _UNKNOWN_CAPABILITY).as_dict()


@dataclass(frozen=True)
class ChangelogSummary:
    """Optional per-severity change counts, linked from the release manifest.

    Sourced by the caller from the stored ``ctg.changelog.v1`` payload (APX-2.3). Kept
    optional so agent outputs still generate for revisions without a stored changelog.
    """

    breaking: int = 0
    non_breaking: int = 0
    docs_only: int = 0

    def as_dict(self) -> Dict[str, int]:
        """Emit the camelCase counts object."""
        return {
            "breaking": self.breaking,
            "nonBreaking": self.non_breaking,
            "docsOnly": self.docs_only,
        }


@dataclass(frozen=True)
class PortalContext:
    """Everything the generators need about the portal and the published revision.

    All values are supplied by the route from the resolved project/version rows and
    settings, so this module stays pure and deterministic. ``published_at`` is used as
    the manifests' timestamp (portal content is immutable once published), which keeps
    the ETag stable across calls.

    Attributes:
        base_url: Canonical portal base URL, no trailing slash
            (for example ``https://portal.apiome.dev/acme-api``).
        project_name: Human project name (content — withheld when not indexable).
        project_slug: Project slug (part of the shareable URL — always emitted).
        version_label: The version's semver label (for example ``1.0.65``).
        version_record_id: The version record UUID.
        published_at: ISO-8601 publish timestamp, or ``None``.
        indexable: ``True`` only when the portal is published *and* public *and*
            not robots-excluded — the single gate for emitting content.
        access: ``"public"`` or ``"private"``.
    """

    base_url: str
    project_name: str
    project_slug: str
    version_label: str
    version_record_id: str
    published_at: Optional[str]
    indexable: bool
    access: str

    @property
    def version_base(self) -> str:
        """Version-scoped portal root, for example ``{base}/v/1.0.65``."""
        return f"{self.base_url.rstrip('/')}/v/{_version_segment(self.version_label)}"


@dataclass(frozen=True)
class AgentOutput:
    """One rendered output — its stable URL path, media type, body and ETag."""

    name: str
    path: str
    media_type: str
    body: str
    etag: str


@dataclass(frozen=True)
class AgentOutputBundle:
    """The full set of agent outputs for one published revision, keyed by name."""

    outputs: Mapping[str, AgentOutput]

    def get(self, name: str) -> Optional[AgentOutput]:
        """Return the output named ``name`` (``index``/``llms.txt``/…), or ``None``."""
        return self.outputs.get(name)


# --------------------------------------------------------------------------- helpers


def _canonical_json(payload: Any) -> str:
    """Serialize ``payload`` as compact canonical JSON (sorted keys) for hashing/digests."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _json_document(payload: Mapping[str, Any]) -> str:
    """Serialize a manifest as stable, human-diffable JSON text with a trailing newline."""
    return json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False, default=str) + "\n"


def output_etag(body: str) -> str:
    """Return a strong, content-addressed ETag (double-quoted 16-hex sha256 prefix).

    Mirrors the feed/badge convention: identical body → identical ETag, so the route can
    answer ``If-None-Match`` with ``304 Not Modified`` without recomputing anything.
    """
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
    return f'"{digest}"'


_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def _slug(text: str) -> str:
    """Lowercase, hyphenate and trim ``text`` into a stable URL/fragment slug."""
    return _SLUG_STRIP.sub("-", text.lower()).strip("-")


_VERSION_SEGMENT_STRIP = re.compile(r"[^a-zA-Z0-9._-]+")


def _version_segment(text: str) -> str:
    """URL segment for a version label, preserving dots (``1.0.65`` stays intact).

    Semver labels are valid URL path segments, so we keep ``.``/``-``/``_`` and only
    replace other characters; an empty result falls back to ``x`` so a URL is well-formed.
    """
    cleaned = _VERSION_SEGMENT_STRIP.sub("-", text).strip("-")
    return cleaned or "x"


def _key_hash(key: str) -> str:
    """Short, stable disambiguator derived from a canonical key (order-independent)."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:6]


def _first_line(text: Optional[str]) -> Optional[str]:
    """First non-empty line of ``text``, trimmed to ``_SUMMARY_MAX_CHARS`` (``None`` if empty)."""
    if not text:
        return None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            if len(stripped) > _SUMMARY_MAX_CHARS:
                return stripped[: _SUMMARY_MAX_CHARS - 1].rstrip() + "…"
            return stripped
    return None


def _operation_label(op: Operation) -> str:
    """Human label for an operation: ``METHOD /path`` for REST, else its name/key."""
    if op.http_method and op.http_path:
        return f"{op.http_method.upper()} {op.http_path}"
    return op.name or op.key


def _sorted_operations(canonical: CanonicalApi) -> List[Operation]:
    """All operations in a total, stable order (by canonical key)."""
    return sorted(canonical.operations(), key=lambda op: op.key)


def _sorted_types(canonical: CanonicalApi) -> List[Type]:
    """All named types in a total, stable order (by canonical key)."""
    return sorted(canonical.types, key=lambda t: t.key)


def _assign_fragments(entries: Sequence[Tuple[str, str]]) -> Dict[str, str]:
    """Map each ``(kind, key)`` to a unique, stable fragment id.

    The base fragment is ``<kind>-<slug(key)>``. When two keys slug to the same base
    (possible on large catalogs), every colliding key is disambiguated with a short hash
    of its own key — deterministic and independent of iteration order.

    Args:
        entries: ``(kind, key)`` pairs, ``kind`` being ``"operation"`` / ``"schema"``.

    Returns:
        Mapping from ``key`` to its assigned fragment id.
    """
    base_by_key: Dict[str, str] = {}
    base_counts: Dict[str, int] = {}
    for kind, key in entries:
        base = f"{kind}-{_slug(key)}".strip("-")
        base_by_key[key] = base
        base_counts[base] = base_counts.get(base, 0) + 1

    fragments: Dict[str, str] = {}
    for key, base in base_by_key.items():
        if base_counts[base] > 1:
            fragments[key] = f"{base}-{_key_hash(key)}"
        else:
            fragments[key] = base
    return fragments


def _generator_block() -> Dict[str, str]:
    """Provenance block stamped into every manifest."""
    return {"name": AGENT_OUTPUT_GENERATOR, "version": AGENT_OUTPUT_GENERATOR_VERSION}


def _content_digest(canonical: CanonicalApi, ctx: PortalContext) -> str:
    """Stable ``sha256:`` fingerprint over the version's agent-visible content + policy.

    Folds the API identity/version, the sorted operation and schema keys, the paradigm/
    format and the access state so any content or policy change moves the digest. Pure
    and order-stable, so it is a usable cache/version key for downstream consumers.
    """
    payload = {
        "paradigm": canonical.paradigm.value,
        "format": canonical.format,
        "protocol": canonical.protocol,
        "apiVersion": canonical.version,
        "title": canonical.title,
        "versionLabel": ctx.version_label,
        "access": ctx.access,
        "operations": [
            [op.key, _operation_label(op), bool(op.deprecated)] for op in _sorted_operations(canonical)
        ],
        "schemas": [[t.key, t.name, t.kind.value, bool(t.deprecated)] for t in _sorted_types(canonical)],
        "channels": sorted(ch.key for ch in canonical.channels),
    }
    return "sha256:" + hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------- llms.txt


def build_llms_txt(canonical: CanonicalApi, ctx: PortalContext) -> str:
    """Render the ``llms.txt`` index for the portal (or a withheld shell if not indexable).

    Follows the `llms.txt` convention: an H1 title, a ``>`` summary blockquote, then
    ``##`` sections of ``- [label](url): summary`` links into the canonical human pages.
    """
    if not ctx.indexable:
        return (
            "# API documentation\n\n"
            "> This documentation portal is not published for automated agents.\n"
        )

    fragments = _assign_fragments(
        [("operation", op.key) for op in _sorted_operations(canonical)]
        + [("schema", t.key) for t in _sorted_types(canonical)]
    )
    version_base = ctx.version_base

    title = canonical.title or ctx.project_name or ctx.project_slug
    summary = _first_line(canonical.description) or (
        f"{title} — {canonical.paradigm.value} API reference, version {ctx.version_label}."
    )

    lines: List[str] = [f"# {title}", "", f"> {summary}", ""]

    operations = _sorted_operations(canonical)
    if operations:
        lines.append("## API Reference")
        lines.append("")
        for op in operations:
            url = f"{version_base}/reference/operations/{fragments[op.key]}"
            bullet = f"- [{_operation_label(op)}]({url})"
            desc = _first_line(op.description)
            if op.deprecated:
                desc = f"Deprecated. {desc}" if desc else "Deprecated."
            if desc:
                bullet += f": {desc}"
            lines.append(bullet)
        lines.append("")

    types = _sorted_types(canonical)
    if types:
        lines.append("## Schemas")
        lines.append("")
        for type_ in types:
            url = f"{version_base}/reference/schemas/{fragments[type_.key]}"
            bullet = f"- [{type_.name}]({url})"
            desc = _first_line(type_.description)
            if type_.deprecated:
                desc = f"Deprecated. {desc}" if desc else "Deprecated."
            if desc:
                bullet += f": {desc}"
            lines.append(bullet)
        lines.append("")

    lines.append("## Changelog")
    lines.append("")
    lines.append(
        f"- [Changelog]({version_base}/changelog): Version history, breaking changes and "
        "release notes."
    )
    lines.append("")

    return "\n".join(lines).rstrip("\n") + "\n"


# ------------------------------------------------------------------ catalog manifest


def _operation_entry(op: Operation, fragment: str, version_base: str) -> Dict[str, Any]:
    """Machine-readable catalog entry for one operation, linked to its human page."""
    entry: Dict[str, Any] = {
        "key": op.key,
        "name": op.name or op.key,
        "kind": op.kind.value,
        "deprecated": bool(op.deprecated),
        "fragment": fragment,
        "humanUrl": f"{version_base}/reference/operations/{fragment}",
    }
    if op.http_method:
        entry["method"] = op.http_method.upper()
    if op.http_path:
        entry["path"] = op.http_path
    summary = _first_line(op.description)
    if summary:
        entry["summary"] = summary
    if op.tags:
        entry["tags"] = sorted(op.tags)
    return entry


def _schema_entry(type_: Type, fragment: str, version_base: str) -> Dict[str, Any]:
    """Machine-readable catalog entry for one named type, linked to its human page."""
    entry: Dict[str, Any] = {
        "key": type_.key,
        "name": type_.name,
        "kind": type_.kind.value,
        "deprecated": bool(type_.deprecated),
        "fragment": fragment,
        "humanUrl": f"{version_base}/reference/schemas/{fragment}",
    }
    summary = _first_line(type_.description)
    if summary:
        entry["summary"] = summary
    return entry


def build_catalog_manifest(canonical: CanonicalApi, ctx: PortalContext) -> Dict[str, Any]:
    """Build the catalog / format-capability manifest dict for the published revision.

    When the portal is not indexable, every API name/description/URL/count is withheld;
    only the capability matrix (product state, not content) and ``contentWithheld: true``
    remain.
    """
    capabilities = capabilities_for_paradigm(canonical.paradigm)

    if not ctx.indexable:
        return {
            "schemaVersion": CATALOG_MANIFEST_SCHEMA_VERSION,
            "generator": _generator_block(),
            "portal": {"baseUrl": ctx.base_url},
            "access": ctx.access,
            "contentWithheld": True,
            "capabilities": capabilities,
        }

    version_base = ctx.version_base
    operations = _sorted_operations(canonical)
    types = _sorted_types(canonical)
    fragments = _assign_fragments(
        [("operation", op.key) for op in operations] + [("schema", t.key) for t in types]
    )

    channels = [
        {
            "key": ch.key,
            "address": ch.address,
            **({"protocol": ch.protocol} if ch.protocol else {}),
            **({"summary": s} if (s := _first_line(ch.description)) else {}),
        }
        for ch in sorted(canonical.channels, key=lambda c: c.key)
    ]

    return {
        "schemaVersion": CATALOG_MANIFEST_SCHEMA_VERSION,
        "generator": _generator_block(),
        "portal": {
            "baseUrl": ctx.base_url,
            "projectSlug": ctx.project_slug,
            "projectName": ctx.project_name,
        },
        "api": {
            "title": canonical.title or ctx.project_name,
            "paradigm": canonical.paradigm.value,
            "format": canonical.format,
            "protocol": canonical.protocol,
            "version": canonical.version,
            "identity": {
                "name": canonical.identity.name,
                "namespace": canonical.identity.namespace,
                "id": canonical.identity.id,
            },
        },
        "access": ctx.access,
        "publishedAt": ctx.published_at,
        "contentDigest": _content_digest(canonical, ctx),
        "capabilities": capabilities,
        "counts": {
            "operations": len(operations),
            "schemas": len(types),
            "channels": len(channels),
        },
        "operations": [_operation_entry(op, fragments[op.key], version_base) for op in operations],
        "schemas": [_schema_entry(t, fragments[t.key], version_base) for t in types],
        "channels": channels,
    }


# ------------------------------------------------------------------ release manifest


def build_release_manifest(
    canonical: CanonicalApi,
    ctx: PortalContext,
    *,
    latest: bool = False,
    deprecated: bool = False,
    changelog: Optional[ChangelogSummary] = None,
) -> Dict[str, Any]:
    """Build the release manifest dict describing this published revision as a release.

    Args:
        canonical: The version's approved content.
        ctx: Portal + revision context.
        latest: Whether this revision is the project's current latest published release.
        deprecated: Whether this revision is deprecated.
        changelog: Optional per-severity change counts to link (from APX-2.3).

    When the portal is not indexable the release detail is withheld.
    """
    if not ctx.indexable:
        return {
            "schemaVersion": RELEASE_MANIFEST_SCHEMA_VERSION,
            "generator": _generator_block(),
            "portal": {"baseUrl": ctx.base_url},
            "access": ctx.access,
            "contentWithheld": True,
        }

    version_base = ctx.version_base
    release: Dict[str, Any] = {
        "versionLabel": ctx.version_label,
        "versionRecordId": ctx.version_record_id,
        "apiVersion": canonical.version,
        "publishedAt": ctx.published_at,
        "contentDigest": _content_digest(canonical, ctx),
        "canonicalUrl": version_base,
        "changelogUrl": f"{version_base}/changelog",
        "latest": latest,
        "deprecated": deprecated,
    }
    if changelog is not None:
        release["changes"] = changelog.as_dict()

    return {
        "schemaVersion": RELEASE_MANIFEST_SCHEMA_VERSION,
        "generator": _generator_block(),
        "portal": {"baseUrl": ctx.base_url, "projectSlug": ctx.project_slug},
        "access": ctx.access,
        "format": {
            "paradigm": canonical.paradigm.value,
            "format": canonical.format,
            "supportTier": capabilities_for_paradigm(canonical.paradigm)["supportTier"],
        },
        "release": release,
    }


# ------------------------------------------------------------------------ robots.txt


def build_robots_txt(ctx: PortalContext) -> str:
    """Render ``robots.txt`` for the portal, honouring its public/private state.

    A public, indexable portal allows crawling and advertises its sitemap and the
    agent-readable ``llms.txt``; a private / robots-excluded portal disallows everything.
    """
    if not ctx.indexable:
        return "User-agent: *\nDisallow: /\n"
    return (
        "User-agent: *\n"
        "Allow: /\n\n"
        f"Sitemap: {ctx.base_url.rstrip('/')}/sitemap.xml\n"
        f"# Agent-readable index: {ctx.version_base}/llms.txt\n"
    )


# --------------------------------------------------------------------------- bundle


def _output_paths(ctx: PortalContext) -> Dict[str, str]:
    """Stable canonical URL for each output. ``robots.txt`` sits at the portal root."""
    version_base = ctx.version_base
    return {
        "index": f"{version_base}/agent/index.json",
        "llms.txt": f"{version_base}/llms.txt",
        "robots.txt": f"{ctx.base_url.rstrip('/')}/robots.txt",
        "catalog": f"{version_base}/agent/catalog.json",
        "release": f"{version_base}/agent/release.json",
    }


def build_agent_outputs(
    canonical: CanonicalApi,
    ctx: PortalContext,
    *,
    latest: bool = False,
    deprecated: bool = False,
    changelog: Optional[ChangelogSummary] = None,
) -> AgentOutputBundle:
    """Render every agent output for one published revision as a keyed bundle.

    Produces the content-bearing documents first (``llms.txt``, ``robots.txt``, catalog
    and release manifests), then the ``index`` document that lists them with their stable
    URL, media type, ETag and byte size. All bodies are byte-stable for identical input.

    Args:
        canonical: The version's approved content.
        ctx: Portal + revision context (carries the ``indexable`` privacy gate).
        latest: Whether this is the project's latest published release.
        deprecated: Whether this revision is deprecated.
        changelog: Optional change counts linked from the release manifest.

    Returns:
        An :class:`AgentOutputBundle` keyed by output name.
    """
    paths = _output_paths(ctx)

    bodies: Dict[str, str] = {
        "llms.txt": build_llms_txt(canonical, ctx),
        "robots.txt": build_robots_txt(ctx),
        "catalog": _json_document(build_catalog_manifest(canonical, ctx)),
        "release": _json_document(
            build_release_manifest(
                canonical, ctx, latest=latest, deprecated=deprecated, changelog=changelog
            )
        ),
    }

    outputs: Dict[str, AgentOutput] = {}
    for name in ("llms.txt", "robots.txt", "catalog", "release"):
        body = bodies[name]
        outputs[name] = AgentOutput(
            name=name,
            path=paths[name],
            media_type=AGENT_OUTPUT_MEDIA_TYPES[name],
            body=body,
            etag=output_etag(body),
        )

    index_payload = {
        "schemaVersion": AGENT_OUTPUTS_SCHEMA_VERSION,
        "generator": _generator_block(),
        "portal": {"baseUrl": ctx.base_url, "projectSlug": ctx.project_slug},
        "version": {
            "label": ctx.version_label,
            "recordId": ctx.version_record_id,
            "publishedAt": ctx.published_at,
        },
        "access": ctx.access,
        "indexable": ctx.indexable,
        "contentDigest": _content_digest(canonical, ctx),
        "outputs": [
            {
                "name": name,
                "path": outputs[name].path,
                "mediaType": outputs[name].media_type,
                "etag": outputs[name].etag,
                "bytes": len(outputs[name].body.encode("utf-8")),
            }
            for name in ("llms.txt", "robots.txt", "catalog", "release")
        ],
    }
    index_body = _json_document(index_payload)
    outputs["index"] = AgentOutput(
        name="index",
        path=paths["index"],
        media_type=AGENT_OUTPUT_MEDIA_TYPES["index"],
        body=index_body,
        etag=output_etag(index_body),
    )

    return AgentOutputBundle(outputs=outputs)
