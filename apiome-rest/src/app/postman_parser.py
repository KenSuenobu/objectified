"""Postman Collection v2.0 / v2.1 parser.

Parses Postman Collection JSON into a typed :class:`PostmanDocument` AST.

**Both v2 minors read identically (FMT-3.6, #5431).** Collection v2.0 — the form
Insomnia and several older exporters write — was detected by its ``info.schema``
URL but was not guaranteed to *normalize* like v2.1, because three shapes changed
between the two minors:

===================  =====================================  ===============================
                     v2.0                                   v2.1
===================  =====================================  ===============================
``request.url``      a **string** (``{{baseUrl}}/orders``)  an object (``raw``/``path``/…)
``auth.<scheme>``    an **object** (``{username, …}``)      an array of ``{key, value}``
``variable[]``       identified by ``id``                   identified by ``key``
===================  =====================================  ===============================

Each is read here in both spellings, so a v2.0 export produces the same canonical
model a v2.1 export of the same collection does — the FMT-3.6 acceptance
criterion. The minor itself is recorded on :attr:`PostmanDocument.collection_version`
and published in the canonical model's extras, so "which version was this?" stays a
fact about the import rather than a guess from the schema URL.

**Credentials are never read.** :class:`PostmanAuth` carries the scheme and the
*names* of its parameters — never their values, which are bearer tokens, passwords
and API keys. The scheme is what a reader needs ("this collection is OAuth2"); the
secret is not ours to store.

Known limitation, unchanged by FMT-3.6 and identical in both minors: only ``raw``
request bodies are projected onto a schema. ``urlencoded``/``formdata``/``graphql``
bodies are recorded by mode but contribute no payload schema.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import unquote, urlsplit

from .import_ingestion import IngestionError, parse_document

__all__ = [
    "PostmanParseError",
    "PostmanAuth",
    "PostmanQueryParam",
    "PostmanPathVariable",
    "PostmanUrl",
    "PostmanBody",
    "PostmanHeader",
    "PostmanRequest",
    "PostmanResponse",
    "PostmanOperation",
    "PostmanVariable",
    "PostmanDocument",
    "collection_version",
    "is_postman",
    "is_postman_document",
    "is_postman_environment",
    "parse_environment",
    "parse_postman",
]

_API_MARKERS = ("openapi", "swagger", "asyncapi", "arazzo", "openrpc", "avro")
_ALLOWED_METHODS = frozenset({"GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"})

#: ``…/json/collection/v2.0.0/collection.json`` → ``2.0``. The schema URL is the only
#: place a collection states its own minor.
_SCHEMA_VERSION_RE = re.compile(r"/collection/v(\d+\.\d+)(?:\.\d+)?/", re.IGNORECASE)

#: Top-level keys that identify a Postman Collection **v1** export: a flat
#: ``requests`` array keyed by ``collectionId``, with no ``info`` block at all.
#: FMT-3.6 extends intake to v2.0, not to v1, so a v1 upload is rejected by version
#: rather than mis-read as a malformed v2 collection.
_V1_MARKERS = ("requests", "order")


class PostmanParseError(ValueError):
    """Raised when Postman collection text cannot be parsed.

    Args:
        message: Human-readable description of what was wrong.
        code: The intake-taxonomy code the import pipeline should report (see
            :mod:`app.intake_error_taxonomy`). The adapter copies it onto the
            :class:`~app.import_source.ImportSourceError` it raises, so a
            semantically empty collection and an unsupported collection version
            land under their own codes instead of the coarse parse-phase default.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PostmanQueryParam:
    name: str
    value: Optional[str]
    disabled: bool = False


@dataclass(frozen=True)
class PostmanPathVariable:
    key: str
    value: Optional[str]


@dataclass(frozen=True)
class PostmanUrl:
    raw: Optional[str]
    path: Tuple[str, ...]
    query: Tuple[PostmanQueryParam, ...]
    variables: Tuple[PostmanPathVariable, ...]


@dataclass(frozen=True)
class PostmanBody:
    mode: Optional[str]
    raw: Optional[str]
    language: Optional[str]


@dataclass(frozen=True)
class PostmanHeader:
    key: str
    value: Optional[str]
    disabled: bool = False


@dataclass(frozen=True)
class PostmanAuth:
    """A collection- or request-level auth declaration, without its secrets.

    Attributes:
        type: The Postman auth scheme (``basic``, ``bearer``, ``oauth2``, …).
        parameters: The *names* of the scheme's parameters, sorted. Their values
            are credentials and are deliberately not read: the shape a v2.0 export
            writes (an object) and the shape v2.1 writes (an array of entries) both
            reduce to this same set of names, which is what makes the two minors
            comparable without ever touching a secret.
    """

    type: str
    parameters: Tuple[str, ...] = ()


@dataclass(frozen=True)
class PostmanRequest:
    method: str
    url: PostmanUrl
    headers: Tuple[PostmanHeader, ...]
    body: Optional[PostmanBody]
    description: Optional[str]
    auth: Optional[PostmanAuth] = None


@dataclass(frozen=True)
class PostmanResponse:
    name: str
    status: Optional[str]
    code: Optional[int]
    body: Optional[PostmanBody]


@dataclass(frozen=True)
class PostmanOperation:
    name: str
    folder_path: Tuple[str, ...]
    request: PostmanRequest
    responses: Tuple[PostmanResponse, ...]


@dataclass(frozen=True)
class PostmanVariable:
    key: str
    value: Optional[str]


@dataclass(frozen=True)
class PostmanDocument:
    """A parsed Postman collection.

    Attributes:
        name: The collection's ``info.name``.
        description: Its ``info.description``, when it has one.
        schema_url: The ``info.schema`` URL exactly as the export wrote it.
        collection_version: The collection minor the schema URL states
            (``"2.0"``/``"2.1"``), or ``None`` when the export named no schema.
        variables: Collection variables, merged with any environment files the
            import supplied (collection values win).
        operations: Every request in the collection, folders flattened.
        auth: The collection-level auth scheme, without its secrets.
        raw: The source text, kept for store-raw catalog persistence.
    """

    name: str
    description: Optional[str]
    schema_url: Optional[str]
    variables: Tuple[PostmanVariable, ...]
    operations: Tuple[PostmanOperation, ...]
    raw: str
    collection_version: Optional[str] = None
    auth: Optional[PostmanAuth] = None


def _is_postman_mapping(document: Any) -> bool:
    if not isinstance(document, Mapping):
        return False
    if any(marker in document for marker in _API_MARKERS):
        return False
    info = document.get("info")
    if isinstance(info, Mapping):
        schema = info.get("schema")
        if isinstance(schema, str):
            lowered = schema.lower()
            if "postman.com" in lowered and "collection" in lowered:
                return True
    if isinstance(document.get("item"), list) and (
        isinstance(info, Mapping) or len(document.get("item") or []) > 0
    ):
        return "item" in document and "info" in document
    return False


def is_postman_document(document: Any) -> bool:
    """Return ``True`` when a parsed mapping looks like a Postman collection."""
    return _is_postman_mapping(document)


def is_postman(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a Postman collection."""
    if not content or not isinstance(content, str):
        return False
    if not content.strip():
        return False
    try:
        document = parse_document(content)
    except IngestionError:
        return False
    return _is_postman_mapping(document)


def _normalize_method(method: Any) -> str:
    value = str(method or "GET").upper()
    return value if value in _ALLOWED_METHODS else "GET"


def _clean_path_segment(segment: str) -> str:
    cleaned = segment.strip()
    if cleaned.startswith("{{") and cleaned.endswith("}}"):
        return ""
    if cleaned.startswith(":"):
        return "{" + cleaned[1:] + "}"
    return cleaned


def _parse_string_url(raw: str) -> PostmanUrl:
    """Parse the **v2.0** string URL form into the same shape v2.1's object gives.

    Collection v2.0 writes ``request.url`` as one string
    (``{{baseUrl}}/orders/:orderId?status=new``). Reading only its path — as the
    pre-FMT-3.6 parser did — dropped every query parameter and left ``{{var}}``
    templating in the path, so the same collection exported as v2.0 and as v2.1
    normalized differently. This splits the string the way Postman itself does:
    scheme/authority off the front, fragment and query off the back, then the same
    per-segment cleaning the object form gets.

    Args:
        raw: The URL string exactly as the collection wrote it.

    Returns:
        The parsed URL, with query parameters and path variables recovered.
    """
    text = raw.strip()
    remainder = text
    rooted = False
    if "://" in remainder:
        try:
            split = urlsplit(remainder)
        except ValueError:
            split = None
        if split is not None:
            remainder = split.path or "/"
            if split.query:
                remainder = f"{remainder}?{split.query}"
            rooted = True
    remainder = remainder.split("#", 1)[0]
    path_part, _, query_part = remainder.partition("?")

    segments = path_part.split("/")
    if not rooted and not path_part.startswith("/") and segments:
        # No scheme and no leading slash: Postman reads the first token as the
        # authority — a literal host, a `{{baseUrl}}`, or a `{{host}}:{{port}}`
        # pair. It is not a path segment, and keeping it would mint a bogus one.
        segments = segments[1:]

    path = tuple(
        cleaned
        for segment in segments
        for cleaned in [_clean_path_segment(segment)]
        if cleaned
    )

    query: List[PostmanQueryParam] = []
    for pair in query_part.split("&"):
        if not pair:
            continue
        name, _, value = pair.partition("=")
        name = _decode_query_token(name)
        if not name:
            continue
        query.append(PostmanQueryParam(name=name, value=_decode_query_token(value) or None))

    return PostmanUrl(raw=text, path=path, query=tuple(query), variables=())


def _decode_query_token(token: str) -> str:
    """Percent-decode one query token, leaving ``{{variable}}`` templating intact."""
    try:
        return unquote(token).strip()
    except (UnicodeDecodeError, ValueError):  # pragma: no cover - unquote is total in practice
        return token.strip()


def _parse_url(url_value: Any) -> PostmanUrl:
    if isinstance(url_value, str):
        return _parse_string_url(url_value)

    if not isinstance(url_value, Mapping):
        return PostmanUrl(raw=None, path=(), query=(), variables=())

    raw = url_value.get("raw")
    path_value = url_value.get("path")
    path: Tuple[str, ...]
    if isinstance(path_value, list):
        path = tuple(
            cleaned
            for segment in path_value
            if isinstance(segment, str)
            for cleaned in [_clean_path_segment(segment)]
            if cleaned
        )
    elif isinstance(path_value, str):
        path = tuple(segment for segment in path_value.strip("/").split("/") if segment)
    else:
        path = ()

    query: List[PostmanQueryParam] = []
    raw_query = url_value.get("query")
    if isinstance(raw_query, list):
        for entry in raw_query:
            if not isinstance(entry, Mapping):
                continue
            name = entry.get("key")
            if not isinstance(name, str) or not name.strip():
                continue
            query.append(
                PostmanQueryParam(
                    name=name.strip(),
                    value=entry.get("value") if isinstance(entry.get("value"), str) else None,
                    disabled=entry.get("disabled") is True,
                )
            )

    variables: List[PostmanPathVariable] = []
    raw_variables = url_value.get("variable")
    if isinstance(raw_variables, list):
        for entry in raw_variables:
            if not isinstance(entry, Mapping):
                continue
            key = entry.get("key")
            if not isinstance(key, str) or not key.strip():
                continue
            variables.append(
                PostmanPathVariable(
                    key=key.strip(),
                    value=entry.get("value") if isinstance(entry.get("value"), str) else None,
                )
            )

    return PostmanUrl(
        raw=raw if isinstance(raw, str) else None,
        path=path,
        query=tuple(query),
        variables=tuple(variables),
    )


def _http_path(url: PostmanUrl) -> str:
    if not url.path:
        return "/"
    segments: List[str] = []
    for segment in url.path:
        if segment.startswith("{") and segment.endswith("}"):
            segments.append(segment)
        elif segment.startswith(":"):
            segments.append("{" + segment[1:] + "}")
        else:
            segments.append(segment)
    return "/" + "/".join(segments)


def _parse_body(body_value: Any) -> Optional[PostmanBody]:
    if not isinstance(body_value, Mapping):
        return None
    mode = body_value.get("mode")
    raw = body_value.get("raw")
    language = None
    options = body_value.get("options")
    if isinstance(options, Mapping):
        raw_opts = options.get("raw")
        if isinstance(raw_opts, Mapping) and isinstance(raw_opts.get("language"), str):
            language = raw_opts["language"]
    return PostmanBody(
        mode=mode if isinstance(mode, str) else None,
        raw=raw if isinstance(raw, str) else None,
        language=language,
    )


def _parse_headers(headers_value: Any) -> Tuple[PostmanHeader, ...]:
    if not isinstance(headers_value, list):
        return ()
    headers: List[PostmanHeader] = []
    for entry in headers_value:
        if not isinstance(entry, Mapping):
            continue
        key = entry.get("key")
        if not isinstance(key, str) or not key.strip():
            continue
        headers.append(
            PostmanHeader(
                key=key.strip(),
                value=entry.get("value") if isinstance(entry.get("value"), str) else None,
                disabled=entry.get("disabled") is True,
            )
        )
    return tuple(headers)


def _parse_auth(auth_value: Any) -> Optional[PostmanAuth]:
    """Read an auth block in either the v2.0 object shape or the v2.1 array shape.

    v2.0 writes the scheme's parameters as an object
    (``{"basic": {"username": "…", "password": "…"}}``); v2.1 writes them as an
    array of ``{key, value, type}`` entries. Both reduce to the scheme name plus
    the parameter names — the values are credentials and are never read.

    Args:
        auth_value: The ``auth`` block of a collection, folder, or request.

    Returns:
        The parsed :class:`PostmanAuth`, or ``None`` when the block names no
        scheme (including Postman's explicit ``"type": "noauth"``).
    """
    if not isinstance(auth_value, Mapping):
        return None
    kind = auth_value.get("type")
    if not isinstance(kind, str) or not kind.strip():
        return None
    kind = kind.strip()
    if kind.lower() == "noauth":
        return None

    parameters: List[str] = []
    payload = auth_value.get(kind)
    if isinstance(payload, Mapping):
        parameters = [str(key) for key in payload if str(key).strip()]
    elif isinstance(payload, list):
        parameters = [
            entry["key"].strip()
            for entry in payload
            if isinstance(entry, Mapping)
            and isinstance(entry.get("key"), str)
            and entry["key"].strip()
        ]
    return PostmanAuth(type=kind, parameters=tuple(sorted(set(parameters))))


def _parse_responses(responses_value: Any) -> Tuple[PostmanResponse, ...]:
    if not isinstance(responses_value, list):
        return ()
    responses: List[PostmanResponse] = []
    for entry in responses_value:
        if not isinstance(entry, Mapping):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        code = entry.get("code")
        responses.append(
            PostmanResponse(
                name=name.strip(),
                status=entry.get("status") if isinstance(entry.get("status"), str) else None,
                code=int(code) if isinstance(code, int) else None,
                body=_parse_body(entry.get("body")),
            )
        )
    return tuple(responses)


def _parse_operations(
    items: Any,
    *,
    folder_path: Tuple[str, ...] = (),
) -> List[PostmanOperation]:
    if not isinstance(items, list):
        return []
    operations: List[PostmanOperation] = []
    for entry in items:
        if not isinstance(entry, Mapping):
            continue
        request_value = entry.get("request")
        if isinstance(request_value, Mapping):
            name = entry.get("name")
            if not isinstance(name, str) or not name.strip():
                name = "Request"
            url = _parse_url(request_value.get("url"))
            operations.append(
                PostmanOperation(
                    name=name.strip(),
                    folder_path=folder_path,
                    request=PostmanRequest(
                        method=_normalize_method(request_value.get("method")),
                        url=url,
                        headers=_parse_headers(request_value.get("header")),
                        body=_parse_body(request_value.get("body")),
                        description=(
                            request_value.get("description")
                            if isinstance(request_value.get("description"), str)
                            else (
                                entry.get("description")
                                if isinstance(entry.get("description"), str)
                                else None
                            )
                        ),
                        auth=_parse_auth(request_value.get("auth")),
                    ),
                    responses=_parse_responses(entry.get("response")),
                )
            )
            continue
        nested = entry.get("item")
        if isinstance(nested, list):
            nested_name = entry.get("name")
            next_folder = (
                (*folder_path, str(nested_name).strip())
                if isinstance(nested_name, str) and nested_name.strip()
                else folder_path
            )
            operations.extend(_parse_operations(nested, folder_path=next_folder))
    return operations


def _variable_name(entry: Mapping[str, Any]) -> Optional[str]:
    """The name of one variable entry, in either v2 minor's spelling.

    v2.1 identifies a variable by ``key``; v2.0 exports (and Postman environment
    files) frequently carry only ``id``. Reading just ``key`` silently dropped
    every v2.0 collection variable, taking the collection's ``baseUrl`` — and
    therefore its server — with it.

    Args:
        entry: One entry of a ``variable``/``values`` array.

    Returns:
        The variable's name, or ``None`` when it declares neither spelling.
    """
    for field in ("key", "id", "name"):
        value = entry.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _parse_variables(raw_variables: Any) -> Tuple[PostmanVariable, ...]:
    if not isinstance(raw_variables, list):
        return ()
    variables: List[PostmanVariable] = []
    for entry in raw_variables:
        if not isinstance(entry, Mapping):
            continue
        key = _variable_name(entry)
        if key is None:
            continue
        if entry.get("enabled") is False or entry.get("disabled") is True:
            continue
        variables.append(
            PostmanVariable(
                key=key,
                value=entry.get("value") if isinstance(entry.get("value"), str) else None,
            )
        )
    return tuple(variables)


def _merge_variables(
    collection: Sequence[PostmanVariable],
    environment: Iterable[PostmanVariable],
) -> Tuple[PostmanVariable, ...]:
    """Merge environment-file variables under a collection's own.

    A collection variable is the value shipped *with* the requests, so it wins over
    an environment file's value for the same name; a name only the environment
    declares is added. Order is collection-first, then the environment's own order,
    so the merge is deterministic.

    Args:
        collection: Variables declared by the collection itself.
        environment: Variables from every environment member of the fileset.

    Returns:
        The merged variables.
    """
    merged: List[PostmanVariable] = list(collection)
    seen = {variable.key for variable in merged}
    for variable in environment:
        if variable.key in seen:
            continue
        seen.add(variable.key)
        merged.append(variable)
    return tuple(merged)


def collection_version(document: Any) -> Optional[str]:
    """The Collection minor a parsed collection declares (``"2.0"`` / ``"2.1"``).

    Args:
        document: A parsed collection mapping.

    Returns:
        The minor read from ``info.schema``, or ``None`` when the export names no
        schema URL (which older tooling omits) or names one in an unknown shape.
    """
    if not isinstance(document, Mapping):
        return None
    info = document.get("info")
    if not isinstance(info, Mapping):
        return None
    schema = info.get("schema")
    if not isinstance(schema, str):
        return None
    match = _SCHEMA_VERSION_RE.search(schema)
    return match.group(1) if match else None


def is_postman_environment(document: Any) -> bool:
    """Whether a parsed mapping is a Postman *environment* (or globals) export.

    An environment file rides alongside a collection in a fileset and supplies the
    ``{{variable}}`` values its requests resolve through. It is not a collection —
    it has no ``item`` array — so it is never importable on its own.

    Args:
        document: A parsed mapping.

    Returns:
        ``True`` for a ``_postman_variable_scope`` export, or for a bare
        ``{"values": [...]}`` document with no ``item`` array.
    """
    if not isinstance(document, Mapping) or "item" in document:
        return False
    if isinstance(document.get("_postman_variable_scope"), str):
        return True
    return isinstance(document.get("values"), list) and "name" in document


def parse_environment(content: str, *, source_label: Optional[str] = None) -> Tuple[
    PostmanVariable, ...
]:
    """Parse a Postman environment/globals export into its variables.

    Args:
        content: The environment file's text.
        source_label: Optional label used only to make error messages specific.

    Returns:
        Its enabled variables, in declaration order. A member that is not an
        environment export contributes nothing rather than failing the import — a
        fileset may legitimately carry a README beside its collection.
    """
    try:
        document = parse_document(content, source_label=source_label)
    except IngestionError:
        return ()
    if not is_postman_environment(document):
        return ()
    return _parse_variables(document.get("values"))


def _reject_collection_v1(document: Mapping[str, Any], source_label: Optional[str]) -> None:
    """Reject a Postman Collection **v1** export by version, not as a parse error.

    Args:
        document: The parsed mapping.
        source_label: Optional label used only to make the message specific.

    Raises:
        PostmanParseError: ``FORMAT_VERSION_UNSUPPORTED`` when the document is a v1
            collection, whose remediation is "re-export as v2" rather than "fix
            your JSON".
    """
    if "item" in document or isinstance(document.get("info"), Mapping):
        return
    if not isinstance(document.get("requests"), list):
        return
    if not any(marker in document for marker in _V1_MARKERS):
        return
    label = f" ({source_label})" if source_label else ""
    raise PostmanParseError(
        f"This is a Postman Collection v1 export{label} (a flat `requests` array with "
        "no `info.schema`). Apiome reads Collection v2.0 and v2.1 — re-export the "
        "collection from Postman in either v2 format.",
        code="FORMAT_VERSION_UNSUPPORTED",
    )


def parse_postman(
    content: str,
    *,
    source_label: Optional[str] = None,
    environment_variables: Sequence[PostmanVariable] = (),
) -> PostmanDocument:
    """Parse Postman collection JSON into a :class:`PostmanDocument`.

    Args:
        content: The collection's text (JSON; YAML is tolerated by the loader).
        source_label: Optional label used only to make error messages specific and
            to name an untitled collection.
        environment_variables: Variables from environment members of the same
            fileset, merged under the collection's own (see
            :func:`parse_environment`).

    Returns:
        The parsed collection.

    Raises:
        PostmanParseError: When the text is empty or unparseable (no code — the
            pipeline classifies it), is a Collection **v1** export
            (``FORMAT_VERSION_UNSUPPORTED``), is not a collection at all, or is a
            well-formed collection with no requests (``INPUT_SEMANTIC_INVALID``:
            there is nothing to import, which is a semantic failure, not a
            malformed document).
    """
    if not content or not content.strip():
        raise PostmanParseError("Invalid or empty Postman collection")
    try:
        document = parse_document(content, source_label=source_label)
    except IngestionError as exc:
        raise PostmanParseError(str(exc)) from exc

    _reject_collection_v1(document, source_label)
    if not _is_postman_mapping(document):
        raise PostmanParseError("Content does not appear to be a Postman collection")

    info = document.get("info") or {}
    if not isinstance(info, Mapping):
        info = {}
    name = info.get("name")
    if not isinstance(name, str) or not name.strip():
        name = source_label or "Postman Collection"

    operations = tuple(_parse_operations(document.get("item")))
    if not operations:
        label = f" ({source_label})" if source_label else ""
        raise PostmanParseError(
            f"No Postman requests found in collection{label}",
            code="INPUT_SEMANTIC_INVALID",
        )

    return PostmanDocument(
        name=name.strip(),
        description=info.get("description") if isinstance(info.get("description"), str) else None,
        schema_url=info.get("schema") if isinstance(info.get("schema"), str) else None,
        collection_version=collection_version(document),
        variables=_merge_variables(
            _parse_variables(document.get("variable")), environment_variables
        ),
        operations=operations,
        auth=_parse_auth(document.get("auth")),
        raw=content,
    )


def postman_http_path(url: PostmanUrl) -> str:
    """Return the canonical HTTP path for a Postman URL."""
    return _http_path(url)
