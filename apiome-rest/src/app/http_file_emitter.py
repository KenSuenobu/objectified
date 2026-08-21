"""HTTP request-file emitter: canonical model → ``.http`` / ``.rest`` / cURL — FMT-2.4 (#5422).

The inverse of :mod:`app.http_file_parser`: where that module reads a VS Code / JetBrains
request file (or a cURL paste) and *infers* a REST surface from it, this emitter walks a
:class:`~app.canonical_model.CanonicalApi` and writes a runnable request collection covering
the whole API — a ``@baseUrl`` file variable and one request block per HTTP operation, with
the method, the templated path, the query string, the headers (auth as clearly-marked
placeholders) and an example body.

**Reuse, not a second synthesizer.** Every request this emitter writes comes from
:func:`app.snippet_render.synthesize_request` — the same function the per-operation snippet
service (SDK-2.3) renders from — and the ``curl`` output mode renders each command through
:func:`app.snippet_render.render_curl`. That is what makes the single-operation snippet and
the bulk file agree on the same operation instead of drifting apart: there is one value
synthesizer, one placeholder vocabulary and one shell-quoting rule in the codebase.

**Nothing credential-shaped is ever invented.** A header or query parameter whose *name* says
it carries a credential is emitted as its placeholder token (``$API_KEY``, ``$AUTHORIZATION``,
``$ACCESS_TOKEN``, ``$CREDENTIALS``, ``$SECRET``) or, under the ``environment`` variable
style, as an intentionally *undefined* ``{{apiKey}}`` reference the reader resolves from their
editor's environment. Neither spelling is a value, and the emitter never writes a value for
one — not even an empty string, which a reader could mistake for "no credential needed".
Every placeholder that reaches the output is listed in the document's header block, so the
file says what must be filled in before it will run.

**Bodies.** A request body is the minimal instance
:func:`app.schema_instance_synthesis.synthesize_instances` produces for the operation's
request schema — which prefers a ``const``, then the schema's own ``example``, then its
``default`` before it invents anything, so a spec that documents an example gets that
example back. The canonical model records no *message*-level example (the normalizers drop
OpenAPI's ``example`` / ``examples`` alongside the media type), so a schema-level keyword
is the only example a request file can carry.

**Auth from canonical security.** When the model records a security scheme — a gateway
import's ``operation.extras["security"]`` or an inferred import's
``api.extras["inferred_auth_schemes"]`` — the scheme decides how the credential *travels*
(:data:`AUTH_SCHEME_HEADERS`), so ``bearer`` becomes ``Authorization: Bearer $ACCESS_TOKEN``
rather than an untyped placeholder. The mapping is the inverse of the one
:mod:`app.inferred_spec` reads schemes back out with, so an emitted file re-imports to the
scheme it was emitted from. A scheme with no header representation (``mutualTLS``) is
reported as a loss rather than approximated.

**Dialects.** The two request-file dialects differ in how a request is *named* and how a
comment is spelled, so the same model produces an idiomatic file for either editor:

* ``vscode`` (VS Code REST Client) — ``###`` separators carrying the operation key, the
  request name on its own ``# @name <id>`` line, ``#`` comments.
* ``jetbrains`` (IntelliJ HTTP Client) — the request name *is* the separator
  (``### <id>``), with ``//`` comments.

**Provenance pointers.** A request file is text, not a JSON document, so there is no RFC-6901
pointer into it. The tracker uses a synthetic but stable coordinate instead:
``/requests/<name>`` for a whole block and ``/requests/<name>/<part>`` for one of its parts
(``method`` / ``url`` / ``headers/<header>`` / ``body``), plus ``/baseUrl`` for the file
variable. Two emissions of the same model produce the same coordinates.
"""

from __future__ import annotations

import dataclasses
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple, Union

from pydantic import Field, field_validator

from .canonical_model import (
    ApiParadigm,
    CanonicalApi,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
)
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitOptionsError,
    EmitResult,
    EmittedFile,
    Emitter,
    LossKind,
    LossTracker,
    Provenance,
    ProvenanceTracker,
)
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict
from .snippet_render import (
    FALLBACK_SERVER_URL,
    SnippetPlaceholder,
    SnippetRenderError,
    SnippetRequest,
    render_curl,
    resolve_server_base,
    shell_quote,
    synthesize_request,
)

__all__ = [
    "HTTP_FILE_FORMAT_KEY",
    "DIALECTS",
    "OUTPUT_MODES",
    "VARIABLE_STYLES",
    "BASE_URL_VARIABLE",
    "AUTH_SCHEME_HEADERS",
    "camel_case",
    "collapse_headers",
    "optional_parameters",
    "optional_parameter_comments",
    "HttpFileEmitOptions",
    "HttpFileEmitter",
    "HttpFileFidelityRulePack",
]

#: Registry key of this emitter; matches the ``http-file`` import adapter so the
#: round-trip matrix joins emit and re-import without an alias.
HTTP_FILE_FORMAT_KEY = "http-file"

#: Request-file dialects this emitter can write.
DIALECTS: Tuple[str, ...] = ("vscode", "jetbrains")

#: Output modes: a request file, or a shell script of ``curl`` commands.
OUTPUT_MODES: Tuple[str, ...] = ("http", "curl")

#: Environment-variable styles — how the base URL and credentials are referenced.
VARIABLE_STYLES: Tuple[str, ...] = ("file", "environment", "inline")

#: Name of the file variable holding the server base URL.
BASE_URL_VARIABLE = "baseUrl"

#: Canonical security-scheme identifier → the ``(header, value)`` the credential travels in.
#: The value always contains a placeholder token, never a credential. This table is the
#: inverse of :func:`app.inferred_spec._auth_scheme_from_headers`: emitting a scheme's row
#: and re-importing the result recovers the same scheme, which is what keeps a request file
#: round-tripping through the ``http-file`` adapter. A scheme absent from this table has no
#: header representation and is reported as a loss instead of being approximated.
AUTH_SCHEME_HEADERS: Dict[str, Tuple[str, str]] = {
    "authorization": ("Authorization", "$AUTHORIZATION"),
    "bearer": ("Authorization", "Bearer $ACCESS_TOKEN"),
    "basic": ("Authorization", "Basic $CREDENTIALS"),
    "digest": ("Authorization", "Digest $CREDENTIALS"),
    "oauth2": ("Authorization", "Bearer $ACCESS_TOKEN"),
    "openIdConnect": ("Authorization", "Bearer $ACCESS_TOKEN"),
    "apiKey": ("X-API-Key", "$API_KEY"),
    "cookie": ("Cookie", "$SECRET"),
}

#: Operation kinds that describe an event flow rather than a request/response call.
_EVENT_OPERATION_KINDS = frozenset({OperationKind.PUBLISH, OperationKind.SUBSCRIBE})

#: Comment prefix per dialect.
_COMMENT_PREFIX: Dict[str, str] = {"vscode": "#", "jetbrains": "//"}

#: Output filename per output mode. Both dialects share the ``.http`` name because that
#: extension is what both editors key on.
_OUTPUT_FILENAMES: Dict[str, str] = {"http": "requests.http", "curl": "requests.sh"}

#: Media type per output mode. Neither is IANA-registered, so both use the conventional
#: ``text/x-*`` spelling the other source-text emitters use.
_MEDIA_TYPES: Dict[str, str] = {"http": "text/x-http", "curl": "text/x-shellscript"}


# ===========================================================================
# Fidelity
# ===========================================================================


class HttpFileFidelityRulePack(CapabilityRulePack):
    """Fidelity rules for request-file export.

    A request file is a *call* surface: it carries operations — method, path, query,
    headers, an example body — and no declaration of the types those bodies conform to,
    because the format has no schema vocabulary at all. Events have no representation
    either: there is no request to write for a publish or a subscribe.
    """

    target_label = "HTTP request file"

    def event_verdict(self, event) -> FidelityVerdict:
        """An event channel has no request block; it is dropped."""
        return FidelityVerdict.drop(
            message=(
                f"{self.target_label} has no event/channel representation; "
                f"event {event.key!r} is dropped"
            ),
            target_mapping="event → dropped",
        )

    def operation_verdict(self, operation: Operation) -> FidelityVerdict:
        """Only operations with an HTTP binding become request blocks."""
        if operation.kind in _EVENT_OPERATION_KINDS:
            return FidelityVerdict.drop(
                message=(
                    f"{self.target_label} has no event vocabulary; "
                    f"{operation.kind.value} operation {operation.key!r} is dropped"
                ),
                target_mapping="event operation → dropped",
            )
        if not operation.http_method or not operation.http_path:
            return FidelityVerdict.drop(
                message=(
                    f"{self.target_label} requires an HTTP binding; "
                    f"operation {operation.key!r} is dropped"
                ),
                target_mapping="non-HTTP operation → dropped",
            )
        return FidelityVerdict.ok(message=f"operation carried to {self.target_label}")


# ===========================================================================
# Options
# ===========================================================================


class HttpFileEmitOptions(EmitOptions):
    """Per-target options for :class:`HttpFileEmitter`.

    The defaults produce the file a developer most often wants: a VS Code REST Client
    ``.http`` document with a ``@baseUrl`` variable, example bodies and one block per
    operation — the shape that re-imports through the ``http-file`` adapter unchanged.
    """

    dialect: str = Field(
        default="vscode",
        description="Request-file dialect: `vscode` (VS Code REST Client — `# @name` "
        "request names, `#` comments) or `jetbrains` (IntelliJ HTTP Client — the name on "
        "the `###` separator, `//` comments).",
    )
    output: str = Field(
        default="http",
        description="`http` emits a request file; `curl` emits a POSIX shell script of "
        "`curl` commands instead.",
    )
    include_examples: bool = Field(
        default=True,
        description="Emit an example request body synthesized from the operation's request "
        "schema. Disable for a body-less collection of call shapes.",
    )
    variable_style: str = Field(
        default="file",
        description="How the base URL and credentials are referenced: `file` declares "
        "`@baseUrl` in the document and keeps credential placeholders as `$TOKEN`; "
        "`environment` declares nothing and references `{{baseUrl}}` / `{{apiKey}}` for the "
        "reader's environment file to resolve; `inline` writes no variables at all — "
        "absolute URLs with the same example path values a single-operation snippet uses.",
    )
    base_url: Optional[str] = Field(
        default=None,
        description="Base URL to emit instead of the model's first server. A trailing "
        "slash is trimmed.",
    )

    @field_validator("dialect")
    @classmethod
    def _known_dialect(cls, value: str) -> str:
        """Reject a dialect this emitter does not write."""
        if value not in DIALECTS:
            raise ValueError(f"dialect must be one of {', '.join(DIALECTS)}")
        return value

    @field_validator("output")
    @classmethod
    def _known_output(cls, value: str) -> str:
        """Reject an unknown output mode."""
        if value not in OUTPUT_MODES:
            raise ValueError(f"output must be one of {', '.join(OUTPUT_MODES)}")
        return value

    @field_validator("variable_style")
    @classmethod
    def _known_variable_style(cls, value: str) -> str:
        """Reject an unknown environment-variable style."""
        if value not in VARIABLE_STYLES:
            raise ValueError(f"variable_style must be one of {', '.join(VARIABLE_STYLES)}")
        return value


# ===========================================================================
# Emitter
# ===========================================================================


class HttpFileEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as a runnable ``.http`` request file or cURL script."""

    key = HTTP_FILE_FORMAT_KEY
    format = HTTP_FILE_FORMAT_KEY
    label = "HTTP Request File"
    description = (
        "Export as a runnable .http request collection (VS Code / JetBrains) or a cURL "
        "shell script: one request per operation, with a @baseUrl variable, example "
        "bodies and clearly-marked auth placeholders."
    )
    icon = "file-code"
    paradigm = ApiParadigm.REST
    multi_file = False
    options_model = HttpFileEmitOptions

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """Declare what a request collection carries faithfully.

        A request collection is a *call* surface. It carries operations — method, path,
        query and headers — and one example body per operation, and has no vocabulary at
        all for the types behind those bodies: no union, no nullable member, no validation
        facet, no field identity, no event channel. Every one of those axes is therefore
        ``False``, stated here before an emit runs rather than discovered in the artifact.
        """
        return CapabilityProfile(
            operations=True,
            events=False,
            unions=False,
            nullability=False,
            constraints=False,
            field_identity=False,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[CapabilityRulePack]:
        """Return the request-file degradation rules."""
        return HttpFileFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[HttpFileEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Emit ``api`` as one request file (or one cURL shell script).

        Args:
            api: The canonical model to export.
            opts: Per-target options; the defaults emit a VS Code ``.http`` document with
                a ``@baseUrl`` variable and example bodies.

        Returns:
            A single-file :class:`~app.emitter.EmitResult` whose content is the
            request-file (or shell-script) text, with the provenance of every emitted value
            and a loss for every construct a request collection cannot carry.

        Raises:
            EmitOptionsError: When ``opts`` names an unknown option value.
            ValueError: When ``api`` declares no HTTP operation, so there is no request to
                write.
        """
        options = _coerce_options(opts)
        writer = _HttpFileWriter(api, options)
        content = writer.render()
        media_type = _MEDIA_TYPES[options.output]
        return EmitResult(
            files=[
                EmittedFile(
                    path=_OUTPUT_FILENAMES[options.output],
                    content=content,
                    media_type=media_type,
                )
            ],
            media_type=media_type,
            provenance=writer.tracker.records(),
            losses=writer.losses.records(),
        )


def _coerce_options(
    opts: Optional[Union[HttpFileEmitOptions, EmitOptions]],
) -> HttpFileEmitOptions:
    """Validate caller-supplied options into a :class:`HttpFileEmitOptions`."""
    if isinstance(opts, HttpFileEmitOptions):
        return opts
    try:
        return HttpFileEmitOptions.model_validate(opts.model_dump() if opts else {})
    except ValueError as exc:
        raise EmitOptionsError(f"Invalid HTTP request-file emit options: {exc}") from exc


# ===========================================================================
# Naming helpers
# ===========================================================================

_NON_IDENTIFIER = re.compile(r"[^A-Za-z0-9]+")


def camel_case(text: str) -> str:
    """Turn arbitrary text into a lowerCamelCase identifier.

    ``GET /pets/{id}`` → ``getPetsId``; ``$API_KEY`` → ``apiKey``; an identifier that is
    already camelCase (``listUsers``) is returned unchanged. A word that is entirely
    upper-case is lower-cased first, so an HTTP method or a shouting-snake token does not
    come back as ``gETPets``.

    Args:
        text: The source text (an operation key, a placeholder token, a scheme name).

    Returns:
        A non-empty identifier starting with a lower-case letter.
    """
    words = [word for word in _NON_IDENTIFIER.split(text or "") if word]
    words = [word.lower() if word.isupper() else word for word in words]
    if not words:
        return "request"
    head, *tail = words
    identifier = head[:1].lower() + head[1:] + "".join(word[:1].upper() + word[1:] for word in tail)
    if not identifier[:1].isalpha():
        identifier = "r" + identifier
    return identifier


def _variable_name(token: str) -> str:
    """Turn a placeholder token into the variable name the ``environment`` style references.

    ``$API_KEY`` → ``apiKey``; ``PET_ID`` → ``petId``. The leading ``$`` is dropped because
    a ``{{…}}`` reference names a variable, not a shell expansion.
    """
    return camel_case(token.lstrip("$"))


def _request_identifier(operation: Operation, taken: Sequence[str]) -> str:
    """Derive a unique request name for one operation.

    Prefers the source ``operationId`` (the name the API itself gave the call), then the
    operation name, then the canonical key. A name already used earlier in the document
    gets a numeric suffix, because both editors address a named request's response as
    ``{{name.response.body.…}}`` and two blocks sharing a name make that ambiguous.

    Args:
        operation: The operation to name.
        taken: Identifiers already emitted in this document.

    Returns:
        A unique lowerCamelCase identifier.
    """
    source = operation.extras.get("operationId")
    if not isinstance(source, str) or not source.strip():
        source = operation.name or operation.key
    identifier = camel_case(source)
    if identifier not in taken:
        return identifier
    suffix = 2
    while f"{identifier}{suffix}" in taken:
        suffix += 1
    return f"{identifier}{suffix}"


def _token_present(token: str, text: str) -> bool:
    """Whether ``token`` appears in ``text`` as a whole token rather than a substring."""
    return re.search(
        r"(?<![A-Za-z0-9_])" + re.escape(token) + r"(?![A-Za-z0-9_])", text or ""
    ) is not None


def _template_path_parameters(
    url: str, placeholders: Sequence[SnippetPlaceholder]
) -> Tuple[str, List[Tuple[str, str]]]:
    """Put the canonical ``{name}`` template back into a synthesized URL's path.

    :func:`~app.snippet_render.synthesize_request` fills a path parameter with an example
    *value* (``/users/ID``), which is what a snippet wants — the reader is about to run one
    call. A request collection wants the opposite: the path a developer edits, and the path
    a re-import can recognize. ``/users/ID`` re-imports as a literal ``ID`` segment, while
    ``/users/{id}`` is the spelling :mod:`app.inferred_spec` already recognizes as a
    parameter, so templating is what makes the emitted file round-trip to the same
    operation set it came from.

    Only the query string is left alone: a templated query value is not a path segment and
    the importer reads it as an ordinary parameter either way.

    Args:
        url: The absolute URL the snippet synthesizer produced.
        placeholders: That request's placeholder inventory.

    Returns:
        ``(url, replacements)`` — the templated URL, and the ``(template, parameter name)``
        pairs that were substituted in, in the order they appear.
    """
    path, separator, query = url.partition("?")
    replacements: List[Tuple[str, str]] = []
    for placeholder in placeholders:
        if placeholder.kind != "path":
            continue
        template = "{" + placeholder.name + "}"
        pattern = r"(?<![A-Za-z0-9_])" + re.escape(placeholder.token) + r"(?![A-Za-z0-9_])"
        templated = re.sub(pattern, lambda _match, value=template: value, path)
        if templated != path:
            path = templated
            replacements.append((template, placeholder.name))
    return path + separator + query, replacements


def optional_parameters(operation: Operation) -> List[Parameter]:
    """Return the query/header parameters a runnable request deliberately omits.

    :func:`~app.snippet_render.synthesize_request` sends only *required* parameters, which
    is what makes the emitted call runnable — ``?page=PAGE`` with a placeholder value would
    break a real request. These are the rest.
    """
    return [
        parameter
        for parameter in operation.parameters
        if not parameter.required
        and parameter.location in (ParameterLocation.QUERY, ParameterLocation.HEADER)
    ]


def optional_parameter_comments(operation: Operation, prefix: str) -> List[str]:
    """Render one operation's optional parameters as ``prefix``-marked comment lines.

    A collection is a reference as well as a script, and a developer opening it wants to
    see what else the operation accepts — so the optional parameters are written next to
    the request rather than dropped silently. They stay commented, so the emitted call
    remains runnable and a re-import does not read them back (recorded as the
    ``optional-parameters-commented`` loss).

    Args:
        operation: The operation whose optional parameters are being listed.
        prefix: The dialect's comment marker (``#`` or ``//``).

    Returns:
        The comment lines, or an empty list when every parameter is required.
    """
    lines: List[str] = []
    for parameter in optional_parameters(operation):
        if not lines:
            lines.append(f"{prefix} optional:")
        if parameter.location is ParameterLocation.QUERY:
            lines.append(f"{prefix}   ?{parameter.name}=…")
        else:
            lines.append(f"{prefix}   {parameter.name}: …")
    return lines


def collapse_headers(headers: Dict[str, str]) -> List[Tuple[str, str]]:
    """Collapse case-insensitively duplicate header names, keeping the last spelling.

    HTTP header names are case-insensitive, so a model that declares a ``content-type``
    *parameter* and a request message that pins ``Content-Type`` describes one header, not
    two. :func:`~app.snippet_render.synthesize_request` returns them as two entries (its
    dict is case-sensitive); writing both into a request file would emit the same header
    twice and make ``curl`` send it twice. The later entry wins — it is the concrete media
    type rather than a placeholder — while the earlier entry's position is kept, so header
    order still follows the model's parameter order.

    Args:
        headers: The synthesized headers, in synthesis order.

    Returns:
        ``(name, value)`` pairs with one entry per distinct case-insensitive name.
    """
    order: List[str] = []
    resolved: Dict[str, Tuple[str, str]] = {}
    for name, value in headers.items():
        lowered = name.lower()
        if lowered not in resolved:
            order.append(lowered)
        resolved[lowered] = (name, value)
    return [resolved[lowered] for lowered in order]


def _security_schemes(api: CanonicalApi, operation: Operation) -> Tuple[List[str], str]:
    """Return the canonical security schemes that apply to ``operation``, and their scope.

    Reads the two shapes a canonical model records auth in, and keeps them apart because
    they are different statements:

    * ``operation.extras["security"]`` (what a gateway import writes) is a *per-operation*
      requirement — this call needs this credential — so the emitter may add the header.
    * ``api.extras["inferred_auth_schemes"]`` (what an inferred import writes) says only
      that the API was *observed* using a scheme somewhere. Adding its header to every
      operation would assert a requirement no source stated, and would make a re-import
      report auth on calls that never carried it; so a model-scoped scheme may only refine
      a header the operation already declares.

    Args:
        api: The canonical model.
        operation: The operation whose auth is wanted.

    Returns:
        ``(schemes, scope)`` — scheme identifiers in declaration order, deduplicated, and
        ``"operation"`` or ``"api"`` for where they were declared. An empty list has scope
        ``"api"`` and no effect.
    """

    def _collect(entries: object) -> List[str]:
        schemes: List[str] = []
        if not isinstance(entries, (list, tuple)):
            return schemes
        for entry in entries:
            scheme: Optional[str] = None
            if isinstance(entry, str):
                scheme = entry
            elif isinstance(entry, dict) and isinstance(entry.get("scheme"), str):
                scheme = entry["scheme"]
            if scheme and scheme not in schemes:
                schemes.append(scheme)
        return schemes

    declared = _collect(operation.extras.get("security"))
    if declared:
        return declared, "operation"
    return _collect(api.extras.get("inferred_auth_schemes")), "api"


# ===========================================================================
# Planning
# ===========================================================================


@dataclass(frozen=True)
class _EmittedPlaceholder:
    """One substitutable token that actually reaches the emitted document.

    Distinct from :class:`~app.snippet_render.SnippetPlaceholder` because the emitter
    carries two things the snippet inventory does not: the *explanation* the header block
    prints for the token, and tokens that came from a canonical security scheme rather than
    from a declared parameter.

    Attributes:
        token: The literal token as the synthesizer spells it (``PET_ID``, ``$API_KEY``).
        kind: ``path`` / ``query`` / ``header`` / ``server`` for structural placeholders,
            ``secret`` for credentials — only ``secret`` tokens are re-spelled by
            :meth:`_HttpFileWriter._secret_reference`.
        description: One line explaining what the reader must substitute.
    """

    token: str
    kind: str
    description: str

    @classmethod
    def from_snippet(cls, placeholder: SnippetPlaceholder) -> "_EmittedPlaceholder":
        """Describe a placeholder the snippet synthesizer produced from a parameter."""
        if placeholder.kind == "secret":
            where = placeholder.location or "request"
            description = (
                f"credential for the {placeholder.name!r} {where} — never generated, "
                "supply your own"
            )
        elif placeholder.kind == "server":
            description = (
                "stand-in base URL — the model declares no server"
                if placeholder.token == FALLBACK_SERVER_URL and placeholder.name == "server"
                else f"value for the {placeholder.name!r} server variable"
            )
        else:
            description = f"value for the {placeholder.name!r} {placeholder.kind} parameter"
        return cls(token=placeholder.token, kind=placeholder.kind, description=description)

    @classmethod
    def from_scheme(cls, token: str, scheme: str) -> "_EmittedPlaceholder":
        """Describe a credential token derived from a canonical security scheme."""
        return cls(
            token=token,
            kind="secret",
            description=(
                f"credential for the {scheme!r} security scheme — never generated, "
                "supply your own"
            ),
        )


@dataclass(frozen=True)
class _PlannedRequest:
    """One request block, fully resolved before any text is rendered.

    Attributes:
        operation: The canonical operation the block calls.
        identifier: The unique request name inside the document.
        request: The effective request — the synthesized one with its headers collapsed,
            its auth headers merged in and its body honouring ``include_examples``.
        placeholders: The substitutable tokens that actually reach the output, in the
            order the reader meets them.
        headers: The effective headers as ordered ``(name, value)`` pairs.
    """

    operation: Operation
    identifier: str
    request: SnippetRequest
    placeholders: Tuple[_EmittedPlaceholder, ...]
    headers: Tuple[Tuple[str, str], ...]


@dataclass(frozen=True)
class _Substitution:
    """How one absolute URL is rewritten against the emitted base-URL reference.

    Attributes:
        base_url: The absolute base URL every request was *synthesized* against — the
            prefix actually present in :attr:`~app.snippet_render.SnippetRequest.url`.
        reference: The text standing in for it in the emitted document: ``{{baseUrl}}``,
            ``$BASE_URL``, or — under the ``inline`` style — the emitted base URL itself,
            which is how a ``base_url`` override reaches an inline document.
    """

    base_url: str
    reference: str

    def apply(self, url: str) -> str:
        """Replace the leading synthesized base URL in ``url`` with :attr:`reference`."""
        if self.reference == self.base_url:
            return url
        if self.base_url and url.startswith(self.base_url):
            return self.reference + url[len(self.base_url) :]
        return url


class _HttpFileWriter:
    """Render one canonical model as a request file or cURL script, tracking fidelity."""

    def __init__(self, api: CanonicalApi, options: HttpFileEmitOptions) -> None:
        """Plan every request block for ``api`` under ``options``.

        Raises:
            ValueError: When no operation has an HTTP binding, so there is nothing to call.
        """
        self._api = api
        self._options = options
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        self._comment = _COMMENT_PREFIX[options.dialect]
        # Resolved before planning: a plan needs to know how a URL will be rewritten
        # before it can tell which placeholders survive into the emitted text.
        self._synthesized_base = resolve_server_base(api)[0]
        self._base_url = self._resolve_base_url()
        self._requests: List[_PlannedRequest] = self._plan_requests()
        if not self._requests:
            raise ValueError(
                "HTTP request-file export requires at least one HTTP operation: a request "
                "file is a collection of calls, and a model with no HTTP binding has no "
                "request to write."
            )
        self._record_model_level_losses()

    # -- planning ---------------------------------------------------------

    def _plan_requests(self) -> List[_PlannedRequest]:
        """Synthesize one request per HTTP operation, recording what could not be carried."""
        planned: List[_PlannedRequest] = []
        identifiers: List[str] = []
        for service in self._api.services:
            for operation in service.operations:
                if operation.kind in _EVENT_OPERATION_KINDS:
                    self.losses.record(
                        LossKind.NA,
                        "event-operation",
                        f"{operation.kind.value} operation {operation.key!r} has no request "
                        "block: a request file describes calls, not event flows.",
                        pointer=operation.key,
                    )
                    continue
                try:
                    request, placeholders = synthesize_request(self._api, operation)
                except SnippetRenderError:
                    self.losses.record(
                        LossKind.NA,
                        "unroutable-operation",
                        f"Operation {operation.key!r} has no HTTP method/path, so no request "
                        "line can be written for it.",
                        pointer=operation.key,
                    )
                    continue
                identifier = _request_identifier(operation, identifiers)
                identifiers.append(identifier)
                planned.append(self._plan_one(operation, identifier, request, placeholders))
        return planned

    def _plan_one(
        self,
        operation: Operation,
        identifier: str,
        request: SnippetRequest,
        placeholders: Sequence[SnippetPlaceholder],
    ) -> _PlannedRequest:
        """Resolve one synthesized request into the exact block that will be written."""
        headers = collapse_headers(request.headers)
        headers, auth_placeholders = self._merge_auth_headers(operation, headers)
        body = request.body if self._options.include_examples else None
        url, path_placeholders = self._resolve_url(request.url, placeholders)
        self._record_request_losses(
            operation, dropped_body=request.body if body is None else None
        )
        effective = dataclasses.replace(
            request,
            url=url,
            headers=dict(headers),
            body=body,
            body_json=request.body_json if body is not None else None,
        )
        emitted = self._emitted_placeholders(
            effective, placeholders, path_placeholders + auth_placeholders
        )
        return _PlannedRequest(
            operation=operation,
            identifier=identifier,
            request=effective,
            placeholders=tuple(emitted),
            headers=tuple(headers),
        )

    def _resolve_url(
        self, url: str, placeholders: Sequence[SnippetPlaceholder]
    ) -> Tuple[str, List[_EmittedPlaceholder]]:
        """Return the URL to write, plus the path placeholders the reader must fill in.

        Every style but ``inline`` puts the canonical ``{name}`` template back into the path
        (see :func:`_template_path_parameters`); ``inline`` is snippet-verbatim and keeps the
        example value, which is recorded as a loss by :meth:`_record_request_losses`.
        """
        if self._options.variable_style == "inline":
            return url, []
        url, replacements = _template_path_parameters(url, placeholders)
        return url, [
            _EmittedPlaceholder(
                token=template,
                kind="path",
                description=f"value for the {name!r} path parameter",
            )
            for template, name in replacements
        ]

    def _record_request_losses(
        self, operation: Operation, *, dropped_body: Optional[str]
    ) -> None:
        """Record what one request block could not carry.

        Args:
            operation: The operation the block was planned for.
            dropped_body: The body text that ``include_examples`` suppressed, if any.
        """
        if dropped_body is not None:
            self.losses.record(
                LossKind.NA,
                "example-body-omitted",
                f"The request body for {operation.key!r} was omitted because "
                "`include_examples` is disabled.",
                pointer=operation.key,
            )
        omitted = optional_parameters(operation)
        if omitted:
            names = ", ".join(sorted(parameter.name for parameter in omitted))
            self.losses.record(
                LossKind.NA,
                "optional-parameters-commented",
                f"{operation.key!r} accepts optional parameter(s) {names}; a runnable "
                "request cannot send them with placeholder values, so they are written as "
                "comments and a re-import does not recover them.",
                pointer=operation.key,
            )
        if self._options.variable_style == "inline" and any(
            parameter.location is ParameterLocation.PATH for parameter in operation.parameters
        ):
            self.losses.record(
                LossKind.INFERRED,
                "lossy-path-template",
                f"The `inline` variable style writes {operation.key!r} with example path "
                "values instead of its `{name}` template, so a re-import reads those "
                "segments as literals.",
                pointer=operation.key,
            )

    def _merge_auth_headers(
        self, operation: Operation, headers: List[Tuple[str, str]]
    ) -> Tuple[List[Tuple[str, str]], List[_EmittedPlaceholder]]:
        """Fold the operation's canonical security schemes into its headers.

        A scheme whose header the request already carries only *upgrades* the value, and
        only when that value is a bare placeholder — a declared default is a statement the
        model made and is left alone. A scheme whose header is absent is appended. A scheme
        with no header representation is recorded as a loss.

        Args:
            operation: The operation whose security is being applied.
            headers: The collapsed headers, in emission order.

        Returns:
            ``(headers, placeholders)`` — the merged headers and the credential
            placeholders the merge introduced.
        """
        merged = list(headers)
        introduced: List[_EmittedPlaceholder] = []
        schemes, scope = _security_schemes(self._api, operation)
        for scheme in schemes:
            mapping = AUTH_SCHEME_HEADERS.get(scheme)
            if mapping is None:
                self.losses.record(
                    LossKind.NA,
                    "unrepresentable-auth-scheme",
                    f"Security scheme {scheme!r} on {operation.key!r} does not travel in a "
                    "request header, so a request file cannot express it.",
                    pointer=operation.key,
                )
                continue
            name, value = mapping
            token = value.rsplit(" ", 1)[-1]
            index = next(
                (i for i, (existing, _) in enumerate(merged) if existing.lower() == name.lower()),
                None,
            )
            if index is None:
                if scope != "operation":
                    # Model-scoped schemes are an observation, not a requirement — see
                    # `_security_schemes`. Nothing is added and nothing is lost.
                    continue
                merged.append((name, value))
                self.losses.record(
                    LossKind.INFERRED,
                    "synthesized-auth-header",
                    f"{operation.key!r} declares no {name} parameter, so the {scheme!r} "
                    "security scheme was written as an added placeholder header.",
                    pointer=operation.key,
                )
            elif merged[index][1].startswith("$"):
                merged[index] = (merged[index][0], value)
            else:
                continue
            introduced.append(_EmittedPlaceholder.from_scheme(token, scheme))
        return merged, introduced

    def _emitted_placeholders(
        self,
        request: SnippetRequest,
        placeholders: Sequence[SnippetPlaceholder],
        auth_placeholders: Sequence[_EmittedPlaceholder],
    ) -> List[_EmittedPlaceholder]:
        """Keep only the placeholders that survive into ``request``, plus the auth ones.

        Collapsing duplicate headers and merging auth can remove a synthesized placeholder
        from the output (the ``content-type`` placeholder loses to the concrete media type,
        an ``$AUTHORIZATION`` token loses to ``Bearer $ACCESS_TOKEN``). Listing a token in
        the header block that no longer appears in the file would send the reader looking
        for something that is not there.
        """
        haystack = " ".join(
            [
                self._substitution().apply(request.url),
                *(f"{name}: {value}" for name, value in request.headers.items()),
                *([self._base_url] if self._declares_base_url() else []),
            ]
        )
        kept = [
            _EmittedPlaceholder.from_snippet(placeholder)
            for placeholder in placeholders
            if _token_present(placeholder.token, haystack)
        ]
        for placeholder in auth_placeholders:
            if any(existing.token == placeholder.token for existing in kept):
                continue
            kept.append(placeholder)
        return kept

    def _resolve_base_url(self) -> str:
        """Pick the base URL to emit: the emit option, else the synthesized one.

        The synthesized base comes from :func:`~app.snippet_render.resolve_server_base` —
        the very function that prefixed every request URL — rather than being re-derived
        from a request line, so the emitted ``@baseUrl`` and the emitted request lines
        cannot disagree about where the base ends.
        """
        if self._options.base_url:
            return self._options.base_url.rstrip("/")
        return self._synthesized_base

    def _declares_base_url(self) -> bool:
        """Whether the output writes the base URL out as a declaration of its own.

        True for the ``file`` style's ``@baseUrl`` line and for the shell script's
        ``BASE_URL`` default — the two places a placeholder can appear in the document
        without appearing in any request line.
        """
        if self._options.variable_style == "inline":
            return False
        return self._options.output == "curl" or self._options.variable_style == "file"

    def _record_model_level_losses(self) -> None:
        """Record every whole-model construct a request collection cannot carry."""
        if not self._api.servers and not self._options.base_url:
            self.losses.record(
                LossKind.INFERRED,
                "synthesized-base-url",
                "The model declares no server, so the emitted base URL is the snippet "
                "fallback rather than a real host.",
                pointer="servers",
            )
        base_path = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+", "", self._base_url)
        if base_path:
            self.losses.record(
                LossKind.NA,
                "server-base-path",
                f"The base URL carries the path {base_path!r}; a request file has no way to "
                "mark where the server ends and the operation path begins, so a re-import "
                "reads the whole path as the operation's.",
                pointer="servers",
            )
        if self._api.title:
            self.losses.record(
                LossKind.NA,
                "api-title",
                "A request file has no title field; the API title survives only as a "
                "comment, and a re-import names the surface after the file instead.",
                pointer="",
            )
        if self._api.channels:
            self.losses.record(
                LossKind.NA,
                "channels-dropped",
                "A request file has no channel vocabulary; event channels are dropped.",
                pointer="channels",
            )
        if self._api.types:
            self.losses.record(
                LossKind.NA,
                "types-not-declared",
                f"{len(self._api.types)} named type(s) have no declaration in a request "
                "file; they survive only as the shape of an example body.",
                pointer="types",
            )
        if len(self._api.servers) > 1:
            self.losses.record(
                LossKind.NA,
                "additional-servers",
                "A request file resolves one base URL at a time; the servers beyond the "
                "first are listed as comments only.",
                pointer="servers",
            )

    # -- shared rendering pieces -----------------------------------------

    def render(self) -> str:
        """Render the planned requests as the configured output."""
        if self._options.output == "curl":
            return self._render_shell_script()
        return self._render_request_file()

    def _substitution(self) -> _Substitution:
        """Return how a synthesized URL is rewritten for the configured variable style."""
        if self._options.variable_style == "inline":
            return _Substitution(base_url=self._synthesized_base, reference=self._base_url)
        if self._options.output == "curl":
            return _Substitution(base_url=self._synthesized_base, reference="$BASE_URL")
        return _Substitution(
            base_url=self._synthesized_base, reference="{{" + BASE_URL_VARIABLE + "}}"
        )

    def _secret_reference(self, token: str) -> str:
        """Return how a credential placeholder ``token`` is spelled in the output.

        Under the ``environment`` style a credential becomes a ``{{name}}`` reference the
        reader's environment file resolves. Every other style — and every ``curl`` output,
        because a shell has no ``{{…}}`` mechanism — keeps the snippet token, which is both
        unmistakably a placeholder and a real shell variable. No style emits a value.
        """
        if self._options.variable_style == "environment" and self._options.output != "curl":
            return "{{" + _variable_name(token) + "}}"
        return token

    def _spelled(self, planned: _PlannedRequest, value: str) -> str:
        """Re-spell every credential token inside one header value for the output style."""
        spelled = value
        for placeholder in planned.placeholders:
            if placeholder.kind != "secret":
                continue
            reference = self._secret_reference(placeholder.token)
            if reference != placeholder.token:
                spelled = spelled.replace(placeholder.token, reference)
        return spelled

    def _placeholder_inventory(self) -> List[Tuple[str, str]]:
        """List every placeholder in the document as ``(spelling, explanation)``.

        Deduplicated by spelling and ordered by first appearance, so the header block reads
        in the order the reader meets the tokens.
        """
        seen: Dict[str, str] = {}
        for planned in self._requests:
            for placeholder in planned.placeholders:
                spelling = (
                    self._secret_reference(placeholder.token)
                    if placeholder.kind == "secret"
                    else placeholder.token
                )
                if spelling not in seen:
                    seen[spelling] = placeholder.description
        return list(seen.items())

    def _inventory_lines(self, prefix: str) -> List[str]:
        """Render the "replace before running" block with ``prefix`` as the comment marker."""
        inventory = self._placeholder_inventory()
        if not inventory:
            return []
        width = max(len(spelling) for spelling, _ in inventory)
        lines = [prefix, f"{prefix} Replace before running:"]
        lines.extend(
            f"{prefix}   {spelling.ljust(width)}  {explanation}"
            for spelling, explanation in inventory
        )
        return lines

    # -- request file ------------------------------------------------------

    def _comment_line(self, text: str = "") -> str:
        """Render one comment line in the configured dialect."""
        return f"{self._comment} {text}".rstrip()

    def _header_comment_lines(self) -> List[str]:
        """Build the document's header block: what this is, and what must be filled in."""
        lines = [self._comment_line(self._api.title or "Exported API")]
        if self._api.description:
            lines.append(self._comment_line(self._api.description.strip().splitlines()[0]))
        lines.append(self._comment_line())
        lines.append(
            self._comment_line(
                f"{len(self._requests)} request(s) generated by apiome from the canonical "
                "model. Every value is an example, not recorded traffic."
            )
        )
        lines.extend(self._inventory_lines(self._comment))
        if self._options.variable_style == "environment":
            lines.append(self._comment_line())
            lines.append(
                self._comment_line(
                    f"Define {BASE_URL_VARIABLE} (and the variables above) in your "
                    "environment file; this document declares none on purpose."
                )
            )
        extra_servers = [server.url for server in self._api.servers[1:] if server.url]
        if extra_servers:
            lines.append(self._comment_line())
            lines.append(self._comment_line("Other servers this API declares:"))
            lines.extend(self._comment_line(f"  {url}") for url in extra_servers)
        return lines

    def _render_request_file(self) -> str:
        """Render the ``.http`` document: header block, ``@baseUrl``, one block per request."""
        lines = self._header_comment_lines()
        if self._options.variable_style == "file":
            lines.append("")
            lines.append(f"@{BASE_URL_VARIABLE} = {self._base_url}")
            self._record_base_url_provenance()
        substitution = self._substitution()
        for planned in self._requests:
            lines.append("")
            lines.extend(self._render_request_block(planned, substitution))
        return "\n".join(lines).rstrip("\n") + "\n"

    def _record_base_url_provenance(self) -> None:
        """Note whether the emitted base URL came from the model or from a fallback."""
        from_model = bool(self._api.servers) and not self._options.base_url
        self.tracker.record(
            "/baseUrl",
            Provenance.SOURCE if from_model else Provenance.DEFAULT,
            "First canonical server."
            if from_model
            else "Base URL supplied by the emit options or the snippet fallback; the model "
            "declares no server.",
        )

    def _render_request_block(
        self, planned: _PlannedRequest, substitution: _Substitution
    ) -> List[str]:
        """Render one ``###``-separated request block."""
        pointer = ProvenanceTracker.child("/requests", planned.identifier)
        operation = planned.operation
        named_by_source = isinstance(operation.extras.get("operationId"), str)
        lines: List[str] = []
        if self._options.dialect == "jetbrains":
            lines.append(f"### {planned.identifier}")
            lines.append(self._comment_line(operation.key))
        else:
            lines.append(f"### {operation.key}")
            lines.append(f"# @name {planned.identifier}")
        self.tracker.record(
            pointer,
            Provenance.SOURCE if named_by_source else Provenance.INFERRED,
            "Request name from the source operationId."
            if named_by_source
            else "Request name derived from the canonical operation key.",
        )
        if operation.description:
            lines.append(self._comment_line(operation.description.strip().splitlines()[0]))

        lines.append(f"{planned.request.method} {substitution.apply(planned.request.url)}")
        self.tracker.record(
            ProvenanceTracker.child(pointer, "method"),
            Provenance.SOURCE,
            "Canonical HTTP method.",
        )
        self.tracker.record(
            ProvenanceTracker.child(pointer, "url"),
            Provenance.INFERRED,
            "Server base URL, the canonical path (templated unless the `inline` style is "
            "in effect) and the required query parameters.",
        )

        lines.extend(optional_parameter_comments(operation, self._comment))
        for name, value in planned.headers:
            spelled = self._spelled(planned, value)
            lines.append(f"{name}: {spelled}")
            is_placeholder = any(
                _token_present(placeholder.token, value) for placeholder in planned.placeholders
            )
            self.tracker.record(
                ProvenanceTracker.child(pointer, "headers", name),
                Provenance.INFERRED if is_placeholder else Provenance.SOURCE,
                "Placeholder standing in for a value the model does not record."
                if is_placeholder
                else "Declared header value.",
            )

        if planned.request.body is not None:
            lines.append("")
            lines.extend(planned.request.body.splitlines())
            self.tracker.record(
                ProvenanceTracker.child(pointer, "body"),
                Provenance.INFERRED,
                "Minimal instance synthesized from the request schema.",
            )
            self.losses.record(
                LossKind.INFERRED,
                "synthesized-example-body",
                f"The example body for {operation.key!r} was synthesized from the request "
                "schema; the model records no example.",
                pointer=operation.key,
            )
            if not any(
                parameter.location is ParameterLocation.HEADER
                and parameter.name.lower() == "content-type"
                for parameter in operation.parameters
            ):
                self.losses.record(
                    LossKind.INFERRED,
                    "media-type-as-header",
                    f"The request media type for {operation.key!r} can only travel as a "
                    "`Content-Type` header, so a re-import reads it back as a declared "
                    "header parameter the model did not have.",
                    pointer=operation.key,
                )
        return lines

    # -- cURL --------------------------------------------------------------

    def _render_shell_script(self) -> str:
        """Render the planned requests as a POSIX shell script of ``curl`` commands.

        Under the ``inline`` variable style each command is rendered by
        :func:`~app.snippet_render.render_curl` from the very request the snippet service
        would render, so the two agree byte for byte. The other styles rewrite the base URL
        to ``$BASE_URL`` and keep credentials as shell variables, which needs double quoting
        so the shell expands them — the same command with the quoting the substitution
        requires.
        """
        substitution = self._substitution()
        lines = ["#!/usr/bin/env bash"]
        lines.extend(self._script_header_lines())
        lines.append("")
        lines.append("set -euo pipefail")
        lines.append("")
        if self._options.variable_style != "inline":
            lines.append(f'BASE_URL="${{BASE_URL:-{self._base_url}}}"')
            self._record_base_url_provenance()
            for token in self._secret_tokens():
                guard = token.lstrip("$")
                lines.append(f': "${{{guard}:?set {guard} before running this script}}"')
            lines.append("")
        for planned in self._requests:
            lines.append(f"# {planned.operation.key}")
            lines.extend(optional_parameter_comments(planned.operation, "#"))
            lines.append(self._curl_command(planned, substitution))
            lines.append("")
            self.tracker.record(
                ProvenanceTracker.child("/requests", planned.identifier),
                Provenance.SOURCE,
                "One curl command per canonical HTTP operation.",
            )
        return "\n".join(lines).rstrip("\n") + "\n"

    def _script_header_lines(self) -> List[str]:
        """Comment header for the shell script (always ``#`` — a script has one comment form)."""
        lines = [f"# {self._api.title or 'Exported API'}"]
        lines.append(
            f"# {len(self._requests)} request(s) generated by apiome from the canonical model."
        )
        lines.extend(self._inventory_lines("#"))
        return lines

    def _secret_tokens(self) -> List[str]:
        """Credential placeholder tokens the script requires from the environment."""
        tokens: List[str] = []
        for planned in self._requests:
            for placeholder in planned.placeholders:
                if placeholder.kind == "secret" and placeholder.token not in tokens:
                    tokens.append(placeholder.token)
        return tokens

    def _curl_command(self, planned: _PlannedRequest, substitution: _Substitution) -> str:
        """Render one ``curl`` command, honouring the variable style's quoting needs."""
        request = planned.request
        if self._options.variable_style == "inline":
            # Still substituted: `inline` writes an absolute URL, and a `base_url` option
            # is how a caller points that absolute URL somewhere else.
            return render_curl(
                dataclasses.replace(request, url=substitution.apply(request.url))
            )
        expandable = ["$BASE_URL", *self._secret_tokens()]
        parts = ["curl"]
        if request.method != "GET":
            parts.extend(["-X", request.method])
        parts.append(_shell_expandable(substitution.apply(request.url), expandable))
        for name, value in planned.headers:
            parts.extend(["-H", _shell_expandable(f"{name}: {value}", expandable)])
        if request.body is not None:
            parts.extend(["--data-raw", shell_quote(request.body)])
        return " ".join(parts)


def _shell_expandable(value: str, expandable: Sequence[str]) -> str:
    """Double-quote a shell argument so *only* the named ``$VAR`` references expand.

    Every ``$`` is escaped first and then un-escaped for the tokens this document actually
    declares (``$BASE_URL`` and its credential placeholders). Escaping none of them would
    make a real ``$`` in a path an expansion — OData's ``/$metadata`` would become ``/`` —
    and escaping all of them would defeat the point of the double quotes.
    :func:`~app.snippet_render.shell_quote` remains the right function for anything that
    must stay literal end to end (a JSON body).

    Args:
        value: The argument text.
        expandable: The ``$``-prefixed tokens that must survive as shell expansions.

    Returns:
        The double-quoted argument.
    """
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("`", "\\`")
        .replace("$", "\\$")
    )
    for token in sorted(expandable, key=len, reverse=True):
        escaped = re.sub(
            r"\\" + re.escape(token) + r"(?![A-Za-z0-9_])",
            token.replace("\\", "\\\\"),
            escaped,
        )
    return f'"{escaped}"'
