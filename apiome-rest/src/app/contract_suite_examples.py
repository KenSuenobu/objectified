"""Attribute a spec's declared examples to the operations they belong to — ECA-1.1 (#4729).

The contract-suite compiler (:mod:`app.contract_suite`) puts **declared examples first**: a
request an author wrote by hand is better evidence of the contract than anything a generator can
invent. The canonical model, though, deliberately does not carry them — a normalizer resolves a
``$ref``-ed body to a named type and the ``example`` sitting next to it in the source document
does not survive that projection. The examples are still there, in
:attr:`~app.canonical_model.CanonicalApi.raw`, and this module is the bridge back to them.

It reuses the IXH-5.4 walker (:func:`app.example_conformance.walk_example_sites`) rather than
re-implementing "where do examples live in each format": that table is already declared per
family, already handles the two incompatible example shapes (a *schema* ``example`` versus a
*carrier* ``examples`` map of Example Objects), and is already tested. What this module adds is
**attribution** — turning the walker's JSON Pointer into "the request body of ``POST /pets``" or
"the ``petId`` path parameter of ``GET /pets/{petId}``" — because a compiler needs to know which
request an example belongs to, not merely that the document holds one.

Attribution is pointer-driven, and only two families have operations to attribute to:

* **OpenAPI 3.x** — ``/paths/{path}/{method}/requestBody/content/{media}/example``,
  ``…/parameters/{index}/example``, ``…/responses/{code}/content/{media}/example``, and the
  ``examples/{name}/value`` form of each.
* **Swagger 2** — ``/paths/{path}/{method}/parameters/{index}/schema/…`` for a body parameter
  and ``…/responses/{code}/examples/{mime}`` for a response.

A path-level parameter (``/paths/{path}/parameters/{index}/example``) belongs to *every*
operation on that path and is attributed with :attr:`DeclaredExample.http_method` unset, which
the compiler reads as "applies to all methods of this path".

Anything else the walker found — a component schema's example, a webhook, an AsyncAPI channel —
is **counted, never dropped silently**: :attr:`DeclaredExampleHarvest.unattributed` is what the
compiler turns into a suite finding, so a reader can tell "this spec has examples we did not
compile" from "this spec has no examples".

**Honesty about validity.** An example that does not satisfy its own schema is a defect the
author shipped (IXH-5.4 exists because specs do this routinely), and compiling it into a
positive test case would manufacture a contract failure that is really a documentation bug. When
``verify`` is on, every site is checked through :func:`app.example_conformance.
check_example_conformance` and the offenders are listed in
:attr:`DeclaredExampleHarvest.nonconforming` for the compiler to report and exclude.

Pure: no I/O, no clock, no network, no randomness. Deterministic: the walker's own traversal
order (sorted keys at every mapping) is preserved, so the same document always yields the same
examples in the same order.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Mapping, Optional, Tuple

from .example_conformance import (
    MAX_EXAMPLE_SITES,
    check_example_conformance,
    walk_example_sites,
)

__all__ = [
    "HTTP_METHODS",
    "SITE_PARAMETER",
    "SITE_REQUEST_BODY",
    "SITE_RESPONSE",
    "DeclaredExample",
    "DeclaredExampleHarvest",
    "harvest_declared_examples",
]

#: Site kinds an attributed example can carry.
SITE_REQUEST_BODY = "request_body"
SITE_PARAMETER = "parameter"
SITE_RESPONSE = "response"

#: HTTP methods that name an operation inside a Path Item Object. Mirrors the walker's own set;
#: a Path Item key outside it (``parameters``, ``summary``, ``$ref``) is not an operation.
HTTP_METHODS: Tuple[str, ...] = (
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
)


@dataclass(frozen=True)
class DeclaredExample:
    """One example from the source document, attributed to where a request would carry it.

    Attributes:
        http_path: The route template the example's operation is declared under
            (``/pets/{petId}``), exactly as the document spells it.
        http_method: Upper-cased HTTP verb, or ``None`` for a **path-level** parameter example,
            which applies to every operation on ``http_path``.
        site: Which part of the exchange the example describes — :data:`SITE_REQUEST_BODY`,
            :data:`SITE_PARAMETER`, or :data:`SITE_RESPONSE`.
        value: The example instance itself.
        pointer: RFC 6901 JSON Pointer to the example value in the source document — the
            example's stable identity, echoed on every case compiled from it.
        label: The walker's human-readable location, for messages.
        name: The key an ``examples`` map entry was found under (``adult``), or ``None`` for a
            singular ``example``.
        media_type: The media type the example was declared under, when the site has one.
        status_code: The response status code, for :data:`SITE_RESPONSE` examples.
        parameter_name: The parameter's source name, for :data:`SITE_PARAMETER` examples.
        parameter_location: ``path``/``query``/``header``/``cookie``, for parameter examples.
    """

    http_path: str
    http_method: Optional[str]
    site: str
    value: Any
    pointer: str
    label: str
    name: Optional[str] = None
    media_type: Optional[str] = None
    status_code: Optional[str] = None
    parameter_name: Optional[str] = None
    parameter_location: Optional[str] = None


@dataclass(frozen=True)
class DeclaredExampleHarvest:
    """Everything one harvest found in one document.

    Attributes:
        examples: The attributed examples, in the walker's deterministic traversal order.
        family: The example family the document was read as (``openapi-3.1``, ``swagger-2``, …),
            or ``None`` when it belongs to no walked family — in which case nothing was read and
            nothing is claimed.
        unattributed: Example sites the walker found that name no operation (component schemas,
            webhooks, AsyncAPI channels). Reported by the compiler, never silently dropped.
        nonconforming: Pointers of examples that fail the schema governing them. Empty when
            ``verify`` was off — which is *not* the same as "all examples conform".
        verified: Whether conformance was actually checked.
        truncated: Whether the walk hit its site ceiling and stopped early.
    """

    examples: Tuple[DeclaredExample, ...] = ()
    family: Optional[str] = None
    unattributed: int = 0
    nonconforming: frozenset = field(default_factory=frozenset)
    verified: bool = False
    truncated: bool = False


def harvest_declared_examples(
    document: Any,
    *,
    format_key: Optional[str] = None,
    verify: bool = True,
    max_sites: int = MAX_EXAMPLE_SITES,
) -> DeclaredExampleHarvest:
    """Collect a document's examples and attribute each to an operation site.

    Args:
        document: The parsed source document (a canonical model's ``raw``).
        format_key: Adapter/catalog format token, used only as a fallback family hint when the
            document does not self-identify.
        verify: Check every example against the schema governing it, so the compiler can exclude
            (and report) examples that do not satisfy their own contract.
        max_sites: Ceiling on example sites walked, passed straight through to the walker.

    Returns:
        The :class:`DeclaredExampleHarvest`. A document from an unwalked family — or one that is
        not a mapping at all — yields an empty harvest with ``family = None``.
    """
    sites, family, truncated = walk_example_sites(
        document, format_key=format_key, max_sites=max_sites
    )
    if family is None:
        return DeclaredExampleHarvest()

    root = document if isinstance(document, Mapping) else {}
    examples: List[DeclaredExample] = []
    unattributed = 0
    for site in sites:
        attributed = _attribute(site.example_pointer, site.value, site.label, root)
        if attributed is None:
            unattributed += 1
            continue
        examples.append(attributed)

    nonconforming: frozenset = frozenset()
    if verify and examples:
        report = check_example_conformance(
            document, format_key=format_key, max_sites=max_sites
        )
        nonconforming = frozenset(issue.example_pointer for issue in report.issues)

    return DeclaredExampleHarvest(
        examples=tuple(examples),
        family=family.key,
        unattributed=unattributed,
        nonconforming=nonconforming,
        verified=verify,
        truncated=truncated,
    )


# ===========================================================================
# Pointer attribution
# ===========================================================================


def _attribute(
    pointer: str, value: Any, label: str, document: Mapping[str, Any]
) -> Optional[DeclaredExample]:
    """Turn one example pointer into a :class:`DeclaredExample`, or ``None`` if it names no site.

    Args:
        pointer: The walker's JSON Pointer to the example value.
        value: The example instance.
        label: The walker's human-readable location.
        document: The whole source document, needed to read a positional parameter's name.

    Returns:
        The attributed example, or ``None`` when the pointer does not address an operation's
        request body, parameter, or response.
    """
    tokens = _split_pointer(pointer)
    # Only `paths` holds callable operations. `webhooks` describes calls the *provider* makes,
    # which a contract suite cannot originate, so it is left unattributed on purpose.
    if len(tokens) < 3 or tokens[0] != "paths":
        return None
    http_path = tokens[1]

    # Path-level parameter: /paths/{path}/parameters/{index}/…
    if tokens[2] == "parameters":
        return _parameter_example(
            tokens[2:],
            http_path=http_path,
            http_method=None,
            container=_navigate(document, ("paths", http_path)),
            value=value,
            pointer=pointer,
            label=label,
        )

    method = tokens[2].lower()
    if method not in HTTP_METHODS or len(tokens) < 4:
        return None
    rest = tokens[3:]
    operation = _navigate(document, ("paths", http_path, method))

    if rest[0] == "parameters":
        return _parameter_example(
            rest,
            http_path=http_path,
            http_method=method.upper(),
            container=operation,
            value=value,
            pointer=pointer,
            label=label,
        )

    if rest[0] == "requestBody":
        # OpenAPI 3.x: /requestBody/content/{media}/(example | examples/{name}/value)
        media_type, name = _content_site(rest[1:])
        if media_type is None:
            return None
        return DeclaredExample(
            http_path=http_path,
            http_method=method.upper(),
            site=SITE_REQUEST_BODY,
            value=value,
            pointer=pointer,
            label=label,
            name=name,
            media_type=media_type,
        )

    if rest[0] == "responses" and len(rest) >= 2:
        return _response_example(
            rest,
            http_path=http_path,
            http_method=method.upper(),
            value=value,
            pointer=pointer,
            label=label,
        )

    return None


def _parameter_example(
    tokens: List[str],
    *,
    http_path: str,
    http_method: Optional[str],
    container: Any,
    value: Any,
    pointer: str,
    label: str,
) -> Optional[DeclaredExample]:
    """Attribute an example found under a positional ``parameters`` array.

    Swagger 2 carries a request body as a ``parameters`` entry with ``in: body``, so the same
    pointer shape yields either a parameter example or a request-body example depending on the
    parameter object the index resolves to.

    Args:
        tokens: Pointer tokens from ``parameters`` onward.
        http_path: The route template.
        http_method: Upper-cased verb, or ``None`` for a path-level parameter.
        container: The Path Item or Operation Object holding the ``parameters`` array.
        value: The example instance.
        pointer: The full pointer to the example.
        label: The walker's location label.

    Returns:
        The attributed example, or ``None`` when the index resolves to no parameter object.
    """
    if len(tokens) < 3:
        return None
    parameter = _navigate(container, ("parameters", tokens[1]))
    if not isinstance(parameter, Mapping):
        return None
    name = parameter.get("name")
    location = parameter.get("in")
    if not isinstance(name, str) or not isinstance(location, str):
        return None

    if location == "body":
        # Swagger 2 body parameter: the example lives inside its `schema`, so it is a *body*
        # example wearing a parameter's pointer.
        return DeclaredExample(
            http_path=http_path,
            http_method=http_method,
            site=SITE_REQUEST_BODY,
            value=value,
            pointer=pointer,
            label=label,
            name=None,
            media_type=None,
        )

    return DeclaredExample(
        http_path=http_path,
        http_method=http_method,
        site=SITE_PARAMETER,
        value=value,
        pointer=pointer,
        label=label,
        name=_example_map_name(tokens[2:]),
        parameter_name=name,
        parameter_location=location,
    )


def _response_example(
    tokens: List[str],
    *,
    http_path: str,
    http_method: str,
    value: Any,
    pointer: str,
    label: str,
) -> Optional[DeclaredExample]:
    """Attribute an example found under an operation's ``responses`` map.

    Handles both response shapes: OpenAPI 3.x's ``content/{media}/example`` and Swagger 2's
    ``examples/{mime}``, where the map is keyed by media type rather than by example name.

    Args:
        tokens: Pointer tokens from ``responses`` onward.
        http_path: The route template.
        http_method: Upper-cased verb.
        value: The example instance.
        pointer: The full pointer to the example.
        label: The walker's location label.

    Returns:
        The attributed example, or ``None`` when the pointer addresses a response *header*
        example, which describes no body.
    """
    status_code = tokens[1]
    rest = tokens[2:]
    if not rest:
        return None

    if rest[0] == "content":
        media_type, name = _content_site(rest)
        if media_type is None:
            return None
    elif rest[0] == "examples" and len(rest) == 2:
        # Swagger 2: `examples` is keyed by MIME type and its value is the instance itself.
        media_type, name = rest[1], None
    elif rest[0] == "schema":
        media_type, name = None, _example_map_name(rest[1:])
    else:
        # `headers/…` — a header example is not a response body.
        return None

    return DeclaredExample(
        http_path=http_path,
        http_method=http_method,
        site=SITE_RESPONSE,
        value=value,
        pointer=pointer,
        label=label,
        name=name,
        media_type=media_type,
        status_code=status_code,
    )


def _content_site(tokens: List[str]) -> Tuple[Optional[str], Optional[str]]:
    """Read ``content/{media}/(example | examples/{name}/value)`` tokens.

    Args:
        tokens: Pointer tokens starting at ``content``.

    Returns:
        ``(media_type, example_name)``; ``media_type`` is ``None`` when the tokens do not
        describe a Media Type Object example.
    """
    if len(tokens) < 3 or tokens[0] != "content":
        return None, None
    return tokens[1], _example_map_name(tokens[2:])


def _example_map_name(tokens: List[str]) -> Optional[str]:
    """Return the key of an ``examples/{name}/value`` site, or ``None`` for a bare ``example``.

    Args:
        tokens: Pointer tokens starting at ``example`` or ``examples``.
    """
    if len(tokens) >= 2 and tokens[0] == "examples":
        return tokens[1]
    return None


def _split_pointer(pointer: str) -> List[str]:
    """Split an RFC 6901 JSON Pointer into unescaped reference tokens.

    Args:
        pointer: The pointer, always absolute (leading ``/``) as the walker emits it.
    """
    if not pointer.startswith("/"):
        return []
    return [token.replace("~1", "/").replace("~0", "~") for token in pointer[1:].split("/")]


def _navigate(node: Any, tokens: Tuple[Any, ...]) -> Any:
    """Follow reference tokens into a document, returning ``None`` at the first miss.

    Args:
        node: The document (or subtree) to walk from.
        tokens: Mapping keys, and list indices as decimal strings.
    """
    current: Any = node
    for token in tokens:
        if isinstance(current, Mapping):
            current = current.get(token)
        elif isinstance(current, list):
            index = _as_index(token)
            current = current[index] if index is not None and index < len(current) else None
        else:
            return None
        if current is None:
            return None
    return current


def _as_index(token: Any) -> Optional[int]:
    """Read a pointer token as a non-negative list index, or ``None`` when it is not one."""
    text = str(token)
    if not text.isdigit():
        return None
    return int(text)


