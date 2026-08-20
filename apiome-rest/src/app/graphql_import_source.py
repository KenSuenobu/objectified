"""GraphQL import source — MFI-10.6 (#3775).

The :class:`~app.import_source.ImportSource` adapter that makes the GraphQL work of
MFI-10.1…10.5 reachable from the UI source card and the CLI ``import`` command. Like the
reference OpenAPI adapter (:mod:`app.openapi_import_source`) and the AsyncAPI adapter
(:mod:`app.asyncapi_import_source`) it wraps machinery that already exists rather than
reimplementing it:

* **parse** builds a ``graphql-core`` :class:`~graphql.GraphQLSchema` from **SDL** text via the
  MFI-10.1 parser (:func:`app.graphql_parser.build_graphql_schema`); an invalid schema becomes a
  clean :class:`~app.import_source.ImportSourceError`. A *captured introspection response*
  (``{"data": {"__schema": …}}`` or a bare ``{"__schema": …}`` payload) is recognized and rebuilt
  through the same path (:func:`app.graphql_introspection.sdl_from_introspection`), so a discovery
  import whose document is the live ``__schema`` answer flows through the standard pipeline;
* **normalize** delegates to the registered GraphQL :class:`~app.normalizer.Normalizer` (MFI-10.2,
  :class:`app.graphql_normalizer.GraphQlNormalizer`) under the ``graphql`` format key — no mapping
  logic is duplicated here;
* **lint** delegates to the GraphQL lint pack (MFI-10.4,
  :func:`app.graphql_lint.lint_graphql_result`), which is pure over the canonical model (the
  authoritative ``graphql-eslint`` findings are folded in by the MFI-4.3 external-linter adapter
  when present; with none on hand the native + common packs still produce a deterministic score);
* **fingerprint** / **diff** use the canonical-model defaults from :mod:`app.import_source` (the
  GraphQL breaking-change overlay of MFI-10.5 layers onto the diff view through its own SPI).

**Live introspection.** GraphQL is the first source that advertises ``supports_live_discovery``:
:meth:`introspect` is the discovery counterpart to :meth:`parse`. It runs the SSRF-guarded MFI-10.3
introspection service (:func:`app.graphql_introspection.introspect_endpoint`) against a live
endpoint — falling back to caller-supplied uploaded SDL when introspection is disabled — and returns
the built schema, ready for :meth:`normalize`. So **both** acceptance paths catalog a version
through one adapter: SDL text via :meth:`parse`, a live endpoint via :meth:`introspect`.

Registering this adapter (``register=True``) is all the UI and CLI need for the SDL path: the source
card grid (:mod:`app.import_sources_routes` → ``GET /v1/import/sources``) and the CLI
``import --list`` / ``import graphql`` dispatch are both data-driven off the registry, so a
``graphql`` card with file/url/paste/discovery inputs and the graph paradigm appears with no other
change.
"""

from __future__ import annotations

import json
from typing import Any, Mapping, Optional

from graphql import GraphQLSchema

# Importing the GraphQL normalizer self-registers the ``graphql`` format key, which
# :meth:`GraphQlImportSource.normalize` resolves through the normalizer registry.
# Importing the GraphQL diff module self-registers the breaking-change classifier
# (MFI-10.5) and the subgraph-attribution diff labeler (IXH-7.6), so the default
# canonical diff labels every change with its owning subgraph for federated schemas.
from . import (
    graphql_diff,  # noqa: F401
    graphql_normalizer,  # noqa: F401
)
from .canonical_model import ApiParadigm, CanonicalApi
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
    LintReport,
)

__all__ = ["GraphQlImportSource"]

#: SDL keywords that mark a document as GraphQL schema text. A real SDL source contains at least
#: one of these top-level definitions; matching any one is enough to recognize the format cheaply.
_SDL_MARKERS = (
    "type ",
    "interface ",
    "input ",
    "enum ",
    "union ",
    "scalar ",
    "schema ",
    "directive ",
)


def _introspection_data(payload: Any) -> Optional[Mapping[str, Any]]:
    """Return the ``__schema``-bearing mapping if ``payload`` is an introspection response.

    Accepts either a full introspection response (``{"data": {"__schema": …}}``) or a bare
    ``data`` object (``{"__schema": …}``) and returns the mapping that holds ``__schema`` —
    exactly what :func:`app.graphql_introspection.sdl_from_introspection` consumes. Returns
    ``None`` for anything that is not a recognizable introspection payload.
    """
    if not isinstance(payload, Mapping):
        return None
    if "__schema" in payload:
        return payload
    data = payload.get("data")
    if isinstance(data, Mapping) and "__schema" in data:
        return data
    return None


class GraphQlImportSource(ImportSource, register=True):
    """Adapter for GraphQL schemas (SDL file/paste/url, or live introspection)."""

    key = "graphql"
    label = "GraphQL"
    description = "Import a GraphQL schema from SDL or live endpoint introspection."
    icon = "waypoints"
    paradigm = ApiParadigm.GRAPH
    input_kinds = (
        InputKind.FILE,
        InputKind.URL,
        InputKind.PASTE,
        InputKind.DISCOVERY,
        InputKind.FILESET,
    )
    supports_live_discovery = True
    formats = ("graphql",)
    file_extensions = (".graphql", ".gql", ".graphqls")

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Recognize GraphQL SDL text (or a captured introspection response).

        SDL is plain schema text — not the JSON/YAML *mapping* the OpenAPI/AsyncAPI adapters
        sniff — so detection reads ``text`` (or the ``.graphql`` / ``.gql`` filename) and matches a
        top-level SDL keyword. A captured introspection JSON response (``__schema``) is also
        recognized so a discovery document auto-detects. Never raises: an unrecognized input
        returns :data:`NO_MATCH`.
        """
        document = payload.document
        if _introspection_data(document) is not None:
            return DetectionResult(
                confidence=0.99, format="graphql", reason="introspection `__schema` payload"
            )

        text = payload.text
        if text is not None:
            stripped = text.lstrip()
            # A captured introspection response may arrive as raw text rather than a parsed dict.
            if stripped.startswith("{"):
                try:
                    if _introspection_data(json.loads(stripped)) is not None:
                        return DetectionResult(
                            confidence=0.99,
                            format="graphql",
                            reason="introspection `__schema` payload",
                        )
                except ValueError:
                    pass
            if stripped.startswith("<"):
                return NO_MATCH
            if any(marker in text for marker in _SDL_MARKERS):
                return DetectionResult(
                    confidence=0.9, format="graphql", reason="GraphQL SDL definition keyword"
                )

        filename = (payload.filename or "").lower()
        if filename.endswith((".graphql", ".gql", ".graphqls")):
            return DetectionResult(
                confidence=0.7, format="graphql", reason="`.graphql` file extension"
            )
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> GraphQLSchema:
        """Build a ``graphql-core`` schema from SDL text (or a captured introspection response).

        SDL text is built directly through the MFI-10.1 parser. A captured introspection response
        — recognized by its ``__schema`` payload — is rebuilt to canonical SDL first
        (:func:`app.graphql_introspection.sdl_from_introspection`), so a discovery import whose
        document is the live ``__schema`` answer parses through the same path.

        Returns:
            The built :class:`graphql.GraphQLSchema` (the typed schema the MFI-10.2 normalizer
            consumes — no SDL re-parse).

        Raises:
            ImportSourceError: If the text is neither valid SDL nor a rebuildable introspection
                response (the parse/build error message is surfaced verbatim).
        """
        from .graphql_parser import GraphQlParseError, build_graphql_schema

        sdl = self._sdl_from_raw(raw, source_label=source_label)
        try:
            return build_graphql_schema(sdl, source_label=source_label)
        except GraphQlParseError as exc:
            raise ImportSourceError(str(exc)) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> GraphQLSchema:
        """Merge and build a schema from every SDL member of *fileset* (MFI-29.2).

        A fileset whose members carry Federation subgraph markers (``@key`` /
        ``@shareable`` / a federation ``@link``) is a **subgraph set** (IXH-7.6):
        the parser records per-file subgraph ownership on the built schema, and —
        when the bundled ``rover`` toolchain is present — the set is additionally
        composed with ``rover supergraph compose``, whose composition errors are
        attached for the ``composition`` lint dimension. Both are best-effort
        annotations: a missing/failed ``rover`` never fails the import.
        """
        from .graphql_parser import GraphQlParseError, GraphQlSource, build_schema_from_sources

        ordered = sorted(fileset.members.keys(), key=lambda path: (path != fileset.root, path))
        sources = [
            GraphQlSource(label=path, text=fileset.members[path]) for path in ordered
        ]
        try:
            schema = build_schema_from_sources(sources)
        except GraphQlParseError as exc:
            raise ImportSourceError(str(exc)) from exc

        self._attach_rover_composition(schema)
        return schema

    @staticmethod
    def _attach_rover_composition(schema: GraphQLSchema) -> None:
        """Compose a subgraph set with the bundled ``rover``, attaching its findings.

        No-op unless the parser marked the schema as a multi-subgraph set. The
        compose runs on the gRPC-adapter-style worker-loop bridge
        (:func:`app.graphql_federation.compose_subgraphs_sync`) and degrades to
        "no verdict" when ``rover`` (or its composition plugin) is unavailable.
        """
        from .graphql_federation import (
            FEDERATION_EXTENSIONS_KEY,
            FederationInfo,
            compose_subgraphs_sync,
        )

        info = (schema.extensions or {}).get(FEDERATION_EXTENSIONS_KEY)
        if not isinstance(info, FederationInfo):
            return
        if info.role != "subgraph" or len(info.subgraphs) < 2 or not info.subgraph_sdls:
            return
        findings = compose_subgraphs_sync(info.subgraphs, info.subgraph_sdls)
        if findings:
            schema.extensions[FEDERATION_EXTENSIONS_KEY] = info.model_copy(
                update={"composition_findings": findings}
            )

    def _sdl_from_raw(self, raw: str, *, source_label: Optional[str]) -> str:
        """Return SDL for ``raw``, rebuilding it from an introspection response when needed."""
        stripped = raw.lstrip()
        if not stripped.startswith("{"):
            return raw  # plain SDL text — the common case.

        from .graphql_introspection import GraphQlIntrospectionError, sdl_from_introspection

        try:
            decoded = json.loads(stripped)
        except ValueError:
            return raw  # not JSON after all; let the SDL builder report the real error.

        data = _introspection_data(decoded)
        if data is None:
            return raw  # JSON, but not an introspection response — treat as (invalid) SDL.
        try:
            return sdl_from_introspection(data)
        except GraphQlIntrospectionError as exc:
            raise ImportSourceError(str(exc)) from exc

    def introspect(
        self,
        endpoint_url: str,
        *,
        auth_type: Optional[str] = None,
        auth_payload: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        fallback_sdl: Optional[str] = None,
        source_label: Optional[str] = None,
        client: Optional[Any] = None,
    ) -> GraphQLSchema:
        """Introspect a live GraphQL endpoint and return the built schema (the discovery seam).

        The live-endpoint counterpart to :meth:`parse`: it runs the SSRF-guarded MFI-10.3
        introspection service (:func:`app.graphql_introspection.introspect_endpoint`) — which POSTs
        the standard introspection query, rebuilds the schema from the ``__schema`` response, and
        falls back to ``fallback_sdl`` when the endpoint has introspection disabled — then returns
        the built schema, ready for :meth:`normalize` / :meth:`fingerprint` / :meth:`lint`. So a
        live endpoint catalogs a version through the same canonical path SDL does.

        Args:
            endpoint_url: The GraphQL endpoint to introspect (http/https; SSRF-validated).
            auth_type: Credential-vault auth type (``none``/``bearer``/``header``/``oauth2``).
            auth_payload: The decrypted credential payload for ``auth_type``.
            headers: Extra request headers merged in after the auth headers.
            fallback_sdl: Uploaded SDL parsed when live introspection is unavailable.
            source_label: Label used to attribute parse diagnostics; defaults to the endpoint URL.
            client: An httpx client to inject (tests); production omits it for the guarded client.

        Returns:
            The built :class:`graphql.GraphQLSchema`.

        Raises:
            ImportSourceError: If the request is misconfigured (unsafe URL / malformed credential)
                or no schema could be obtained (introspection unavailable and no usable fallback).
        """
        from .graphql_introspection import GraphQlIntrospectionError, introspect_endpoint

        try:
            result = introspect_endpoint(
                endpoint_url,
                auth_type=auth_type,
                auth_payload=auth_payload,
                headers=headers,
                fallback_sdl=fallback_sdl,
                source_label=source_label,
                client=client,
            )
        except GraphQlIntrospectionError as exc:
            raise ImportSourceError(str(exc)) from exc

        if not result.ok or result.sdl is None:
            raise ImportSourceError(
                result.reason or "GraphQL introspection produced no schema for this endpoint."
            )
        # The result already carries the canonical, validated schema as SDL; build it into the
        # typed schema the normalizer consumes (the introspection service has already validated it).
        return self.parse(result.sdl, source_label=source_label or endpoint_url)

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a built GraphQL schema into a :class:`CanonicalApi` (paradigm GRAPH).

        Accepts the :class:`graphql.GraphQLSchema` :meth:`parse` / :meth:`introspect` return, or
        bare SDL text (the latter keeps the adapter testable without first calling :meth:`parse`).
        Delegates to the registered GraphQL normalizer (MFI-10.2).

        Raises:
            ImportSourceError: If the source is neither a built schema nor valid SDL text.
        """
        if isinstance(native_ast, str):
            native_ast = self.parse(native_ast)
        if not isinstance(native_ast, GraphQLSchema):
            raise ImportSourceError(
                "GraphQL source must be a built graphql.GraphQLSchema or SDL text "
                "(see app.graphql_parser.build_graphql_schema)"
            )
        return self._normalize_via_registry("graphql", native_ast, include_raw=include_raw)

    def lint(self, model: CanonicalApi) -> LintReport:
        """Lint via the GraphQL pack (MFI-10.4), folding native + common rules into the score.

        :func:`app.graphql_lint.lint_graphql_result` is pure over the canonical model, so the
        revision always rolls up to a deterministic score / grade / ``report_fingerprint`` even with
        no Node toolchain present; the authoritative ``graphql-eslint`` findings are folded in by the
        MFI-4.3 external-linter adapter when available.
        """
        from .graphql_lint import lint_graphql_result

        return LintReport.from_lint_result(lint_graphql_result(model))
