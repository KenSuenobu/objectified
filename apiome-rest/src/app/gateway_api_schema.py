"""Gateway API ``HTTPRoute`` vocabulary and validation — FMT-2.3 (#5421).

The rules the ``gateway.networking.k8s.io`` ``HTTPRoute`` CustomResourceDefinition
enforces on a manifest, expressed once so both halves of the Gateway API round trip
can rely on them: :mod:`app.gateway_api_emitter` builds manifests that satisfy them,
and :func:`validate_httproute_manifest` re-checks a finished manifest against them
independently of how it was produced.

A cluster (and its CRD) is not part of this runtime, so this module is the
*vendored equivalent* — the same structural contract, expressed in Python and
runnable in CI on every emit. It encodes the parts of the published schema an
emitter can get wrong:

* the resource envelope: a known ``apiVersion``/``kind`` pair and a ``metadata.name``
  Kubernetes accepts (an RFC 1123 subdomain, with an RFC 1123 label namespace);
* the ``spec`` **list bounds** the CRD declares — 16 hostnames, 32 ``parentRefs``,
  16 ``rules``, 64 ``matches`` per rule, 16 header/query matches per match, 16
  ``backendRefs`` and 16 ``filters`` per rule — because exceeding one is rejected
  on apply, not merely discouraged;
* the closed vocabularies: path match types, header/query match types, HTTP
  methods, and filter types;
* the ``path`` **CEL rules** the v1 CRD carries — an ``Exact``/``PathPrefix`` value
  must be an absolute path and must not contain ``//``, ``/./``, ``/../``, ``%2f``,
  ``%2F`` or ``#``;
* the filter **companion-field rules**: a ``RequestHeaderModifier`` filter must
  carry ``requestHeaderModifier`` and must carry no other filter's field;
* the reference shapes: ``name``/``kind``/``group``/``namespace``/``sectionName``
  patterns, ``port`` in ``1..65535`` and ``weight`` in ``0..1000000``.

It deliberately does *not* validate an implementation's own extensions (an
``ExtensionRef`` target's schema belongs to the controller that defines it) or the
RE2 dialect of a ``RegularExpression`` value, which is implementation-defined.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Tuple

__all__ = [
    "GATEWAY_API_GROUP",
    "HTTPROUTE_API_VERSIONS",
    "HTTPROUTE_KIND",
    "HTTPROUTE_VERSIONS",
    "HTTP_METHODS",
    "FILTER_COMPANION_FIELDS",
    "HEADER_MATCH_TYPES",
    "MAX_BACKEND_REFS",
    "MAX_FILTERS",
    "MAX_HEADER_MATCHES",
    "MAX_HOSTNAMES",
    "MAX_MATCHES",
    "MAX_PARENT_REFS",
    "MAX_QUERY_MATCHES",
    "MAX_RULES",
    "PATH_MATCH_TYPES",
    "QUERY_MATCH_TYPES",
    "hostname_violations",
    "httproute_document_violations",
    "httproute_stream_violations",
    "validate_httproute_manifest",
]


# ===========================================================================
# Gateway API vocabulary
# ===========================================================================

#: The API group every Gateway API resource lives in.
GATEWAY_API_GROUP = "gateway.networking.k8s.io"

#: The resource kind this module validates.
HTTPROUTE_KIND = "HTTPRoute"

#: API versions that serve ``HTTPRoute``. ``v1`` is the GA version; ``v1beta1`` is
#: still served by clusters on older Gateway API releases and carries the same
#: HTTPRoute schema, which is why both are accepted.
HTTPROUTE_VERSIONS: Tuple[str, ...] = ("v1", "v1beta1")

#: Fully-qualified ``apiVersion`` values for :data:`HTTPROUTE_VERSIONS`.
HTTPROUTE_API_VERSIONS: frozenset = frozenset(
    f"{GATEWAY_API_GROUP}/{version}" for version in HTTPROUTE_VERSIONS
)

#: ``matches[].path.type`` vocabulary.
PATH_MATCH_TYPES: frozenset = frozenset({"Exact", "PathPrefix", "RegularExpression"})

#: ``matches[].headers[].type`` vocabulary.
HEADER_MATCH_TYPES: frozenset = frozenset({"Exact", "RegularExpression"})

#: ``matches[].queryParams[].type`` vocabulary.
QUERY_MATCH_TYPES: frozenset = frozenset({"Exact", "RegularExpression"})

#: ``matches[].method`` vocabulary — the CRD's closed enum, not the wider IANA set.
HTTP_METHODS: frozenset = frozenset(
    {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"}
)

#: Filter type → the sibling field that must accompany it. The CRD carries one CEL
#: rule per pair in both directions ("must be specified for", "must be nil if"), so
#: a filter that names a type and carries a *different* type's field is rejected.
FILTER_COMPANION_FIELDS: Dict[str, str] = {
    "RequestHeaderModifier": "requestHeaderModifier",
    "ResponseHeaderModifier": "responseHeaderModifier",
    "RequestMirror": "requestMirror",
    "RequestRedirect": "requestRedirect",
    "URLRewrite": "urlRewrite",
    "ExtensionRef": "extensionRef",
}

# --- list bounds (``maxItems`` in the CRD) ---------------------------------

MAX_HOSTNAMES = 16
MAX_PARENT_REFS = 32
MAX_RULES = 16
MAX_MATCHES = 64
MAX_HEADER_MATCHES = 16
MAX_QUERY_MATCHES = 16
MAX_BACKEND_REFS = 16
MAX_FILTERS = 16

# --- string bounds and patterns -------------------------------------------

#: RFC 1123 subdomain — a Kubernetes object name and a Gateway API ``Hostname``
#: without its wildcard prefix.
_DNS_SUBDOMAIN = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$")

#: RFC 1123 label — a Kubernetes namespace.
_DNS_LABEL = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")

#: Gateway API ``ObjectName``: a referenced object's name (no dots).
_OBJECT_NAME = re.compile(r"^[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?$")

#: Gateway API ``SectionName``: a listener/section name.
_SECTION_NAME = re.compile(r"^[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?$")

#: Gateway API ``Kind``: a Kubernetes kind.
_KIND = re.compile(r"^[a-zA-Z]([-a-zA-Z0-9]*[a-zA-Z0-9])?$")

#: Gateway API ``Group``: an API group, or the empty string for the core group.
_GROUP = re.compile(r"^$|^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$")

#: Gateway API ``Hostname``: a DNS subdomain, optionally wildcarded at the front.
_HOSTNAME = re.compile(
    r"^(\*\.)?[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$"
)

#: An HTTP header / query-parameter name (RFC 7230 token characters).
_HEADER_NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$")

_MAX_NAME_LENGTH = 253
_MAX_NAMESPACE_LENGTH = 63
_MAX_KIND_LENGTH = 63
_MAX_HOSTNAME_LENGTH = 253
_MAX_PATH_VALUE_LENGTH = 1024
_MAX_MATCH_NAME_LENGTH = 256
_MAX_HEADER_VALUE_LENGTH = 4096
_MAX_QUERY_VALUE_LENGTH = 1024
_MAX_WEIGHT = 1_000_000

#: Substrings an ``Exact`` / ``PathPrefix`` value may not contain, each carrying its
#: own CEL rule in the v1 CRD.
_FORBIDDEN_PATH_SUBSTRINGS: Tuple[str, ...] = ("//", "/./", "/../", "%2f", "%2F", "#")


# ===========================================================================
# Field-level checks
# ===========================================================================


def _pattern_violations(
    value: Any,
    *,
    path: str,
    pattern: re.Pattern,
    max_length: int,
    label: str,
    required: bool = False,
) -> List[str]:
    """Check one optional string field against its pattern and length bound.

    Args:
        value: The field value (``None`` is absent).
        path: JSON-path-ish location used in the message.
        pattern: The CRD's ``pattern`` for the field.
        max_length: The CRD's ``maxLength`` for the field.
        label: How to name the field's type in a message (``hostname``, …).
        required: True when the field must be present.

    Returns:
        One message per violation (empty when the field is legal or absent).
    """
    if value is None:
        return [f"{path}: is required"] if required else []
    if not isinstance(value, str) or not value:
        return [f"{path}: must be a non-empty string"]
    problems: List[str] = []
    if len(value) > max_length:
        problems.append(f"{path}: {label} is longer than {max_length} characters")
    if not pattern.match(value):
        problems.append(f"{path}: {value!r} is not a valid {label}")
    return problems


def _bounded_list(value: Any, *, path: str, maximum: int) -> Tuple[List[Any], List[str]]:
    """Check a list field's type and ``maxItems`` bound.

    Args:
        value: The field value.
        path: Location used in the message.
        maximum: The CRD's ``maxItems`` for the field.

    Returns:
        ``(entries, problems)`` — the entries to walk (empty when the value is not
        a list) and one message per violation.
    """
    if not isinstance(value, list):
        return [], [f"{path}: must be a list"]
    if len(value) > maximum:
        return value, [f"{path}: declares {len(value)} entries; the maximum is {maximum}"]
    return value, []


def _int_violations(
    value: Any, *, path: str, minimum: int, maximum: int
) -> List[str]:
    """Check one optional integer field against its inclusive bounds."""
    if value is None:
        return []
    if not isinstance(value, int) or isinstance(value, bool):
        return [f"{path}: must be an integer"]
    if value < minimum or value > maximum:
        return [f"{path}: {value} is outside {minimum}..{maximum}"]
    return []


def _path_match_violations(value: Any, *, path: str) -> List[str]:
    """Check one ``matches[].path`` against its vocabulary and CEL rules."""
    if not isinstance(value, Mapping):
        return [f"{path}: must be a mapping"]
    problems: List[str] = []
    kind = value.get("type", "PathPrefix")
    if kind not in PATH_MATCH_TYPES:
        problems.append(
            f"{path}.type: {kind!r} is not a path match type "
            f"({', '.join(sorted(PATH_MATCH_TYPES))})"
        )
    raw = value.get("value", "/")
    if not isinstance(raw, str) or not raw:
        return problems + [f"{path}.value: must be a non-empty string"]
    if len(raw) > _MAX_PATH_VALUE_LENGTH:
        problems.append(
            f"{path}.value: is longer than {_MAX_PATH_VALUE_LENGTH} characters"
        )
    if kind in ("Exact", "PathPrefix"):
        if not raw.startswith("/"):
            problems.append(
                f"{path}.value: {raw!r} must be an absolute path and start with '/' "
                f"when type is {kind}"
            )
        problems.extend(
            f"{path}.value: {raw!r} must not contain {forbidden!r} when type is {kind}"
            for forbidden in _FORBIDDEN_PATH_SUBSTRINGS
            if forbidden in raw
        )
    for key in sorted(value):
        if key not in ("type", "value"):
            problems.append(f"{path}: `{key}` is not a path match field")
    return problems


def _name_value_match_violations(
    entries: Any,
    *,
    path: str,
    maximum: int,
    types: frozenset,
    max_value_length: int,
) -> List[str]:
    """Check a ``headers`` / ``queryParams`` match list."""
    values, problems = _bounded_list(entries, path=path, maximum=maximum)
    for index, entry in enumerate(values):
        location = f"{path}[{index}]"
        if not isinstance(entry, Mapping):
            problems.append(f"{location}: must be a mapping")
            continue
        problems.extend(
            _pattern_violations(
                entry.get("name"),
                path=f"{location}.name",
                pattern=_HEADER_NAME,
                max_length=_MAX_MATCH_NAME_LENGTH,
                label="header name",
                required=True,
            )
        )
        value = entry.get("value")
        if not isinstance(value, str) or not value:
            problems.append(f"{location}.value: must be a non-empty string")
        elif len(value) > max_value_length:
            problems.append(
                f"{location}.value: is longer than {max_value_length} characters"
            )
        kind = entry.get("type", "Exact")
        if kind not in types:
            problems.append(
                f"{location}.type: {kind!r} is not a match type "
                f"({', '.join(sorted(types))})"
            )
    return problems


def _reference_violations(
    entry: Mapping[str, Any],
    *,
    path: str,
    section_name: bool,
) -> List[str]:
    """Check the object-reference fields shared by ``parentRefs`` and ``backendRefs``."""
    problems = _pattern_violations(
        entry.get("name"),
        path=f"{path}.name",
        pattern=_OBJECT_NAME,
        max_length=_MAX_NAME_LENGTH,
        label="object name",
        required=True,
    )
    problems.extend(
        _pattern_violations(
            entry.get("namespace"),
            path=f"{path}.namespace",
            pattern=_DNS_LABEL,
            max_length=_MAX_NAMESPACE_LENGTH,
            label="namespace",
        )
    )
    problems.extend(
        _pattern_violations(
            entry.get("kind"),
            path=f"{path}.kind",
            pattern=_KIND,
            max_length=_MAX_KIND_LENGTH,
            label="kind",
        )
    )
    group = entry.get("group")
    if group is not None:
        if not isinstance(group, str):
            problems.append(f"{path}.group: must be a string")
        elif len(group) > _MAX_NAME_LENGTH or not _GROUP.match(group):
            problems.append(f"{path}.group: {group!r} is not a valid API group")
    if section_name:
        problems.extend(
            _pattern_violations(
                entry.get("sectionName"),
                path=f"{path}.sectionName",
                pattern=_SECTION_NAME,
                max_length=_MAX_NAME_LENGTH,
                label="section name",
            )
        )
    problems.extend(
        _int_violations(entry.get("port"), path=f"{path}.port", minimum=1, maximum=65535)
    )
    return problems


def _filter_violations(entry: Any, *, path: str) -> List[str]:
    """Check one ``filters[]`` entry against the CRD's companion-field rules."""
    if not isinstance(entry, Mapping):
        return [f"{path}: must be a mapping"]
    kind = entry.get("type")
    if not isinstance(kind, str) or kind not in FILTER_COMPANION_FIELDS:
        return [
            f"{path}.type: {kind!r} is not a filter type "
            f"({', '.join(sorted(FILTER_COMPANION_FIELDS))})"
        ]
    problems: List[str] = []
    companion = FILTER_COMPANION_FIELDS[kind]
    if entry.get(companion) is None:
        problems.append(f"{path}.{companion}: must be specified for a {kind} filter")
    problems.extend(
        f"{path}.{field}: must not be set on a {kind} filter"
        for other, field in sorted(FILTER_COMPANION_FIELDS.items())
        if other != kind and entry.get(field) is not None
    )
    return problems


def _match_violations(entry: Any, *, path: str) -> List[str]:
    """Check one ``rules[].matches[]`` entry."""
    if not isinstance(entry, Mapping):
        return [f"{path}: must be a mapping"]
    problems: List[str] = []
    if entry.get("path") is not None:
        problems.extend(_path_match_violations(entry["path"], path=f"{path}.path"))
    method = entry.get("method")
    if method is not None and method not in HTTP_METHODS:
        problems.append(
            f"{path}.method: {method!r} is not an HTTP method "
            f"({', '.join(sorted(HTTP_METHODS))})"
        )
    if entry.get("headers") is not None:
        problems.extend(
            _name_value_match_violations(
                entry["headers"],
                path=f"{path}.headers",
                maximum=MAX_HEADER_MATCHES,
                types=HEADER_MATCH_TYPES,
                max_value_length=_MAX_HEADER_VALUE_LENGTH,
            )
        )
    if entry.get("queryParams") is not None:
        problems.extend(
            _name_value_match_violations(
                entry["queryParams"],
                path=f"{path}.queryParams",
                maximum=MAX_QUERY_MATCHES,
                types=QUERY_MATCH_TYPES,
                max_value_length=_MAX_QUERY_VALUE_LENGTH,
            )
        )
    return problems


def _rule_violations(entry: Any, *, path: str) -> List[str]:
    """Check one ``spec.rules[]`` entry."""
    if not isinstance(entry, Mapping):
        return [f"{path}: must be a mapping"]
    problems: List[str] = []

    if entry.get("matches") is not None:
        matches, bound = _bounded_list(
            entry["matches"], path=f"{path}.matches", maximum=MAX_MATCHES
        )
        problems.extend(bound)
        for index, match in enumerate(matches):
            problems.extend(_match_violations(match, path=f"{path}.matches[{index}]"))

    if entry.get("backendRefs") is not None:
        backends, bound = _bounded_list(
            entry["backendRefs"], path=f"{path}.backendRefs", maximum=MAX_BACKEND_REFS
        )
        problems.extend(bound)
        for index, backend in enumerate(backends):
            location = f"{path}.backendRefs[{index}]"
            if not isinstance(backend, Mapping):
                problems.append(f"{location}: must be a mapping")
                continue
            problems.extend(
                _reference_violations(backend, path=location, section_name=False)
            )
            problems.extend(
                _int_violations(
                    backend.get("weight"),
                    path=f"{location}.weight",
                    minimum=0,
                    maximum=_MAX_WEIGHT,
                )
            )

    if entry.get("filters") is not None:
        filters, bound = _bounded_list(
            entry["filters"], path=f"{path}.filters", maximum=MAX_FILTERS
        )
        problems.extend(bound)
        for index, filter_entry in enumerate(filters):
            problems.extend(
                _filter_violations(filter_entry, path=f"{path}.filters[{index}]")
            )

    return problems


# ===========================================================================
# Document-level checks
# ===========================================================================


def httproute_document_violations(document: Any) -> List[str]:
    """Return every way ``document`` breaks the ``HTTPRoute`` schema.

    Args:
        document: One parsed Kubernetes resource (a mapping; anything else is
            itself a violation).

    Returns:
        One message per violation, in document order. An empty list means the
        resource is an ``HTTPRoute`` a cluster would accept.
    """
    if not isinstance(document, Mapping):
        return [f"$: a manifest must be a mapping, got {type(document).__name__}"]

    problems: List[str] = []

    api_version = document.get("apiVersion")
    if api_version not in HTTPROUTE_API_VERSIONS:
        problems.append(
            f"$.apiVersion: {api_version!r} is not a served HTTPRoute version "
            f"({', '.join(sorted(HTTPROUTE_API_VERSIONS))})"
        )
    if document.get("kind") != HTTPROUTE_KIND:
        problems.append(f"$.kind: must be {HTTPROUTE_KIND!r}, got {document.get('kind')!r}")

    metadata = document.get("metadata")
    if not isinstance(metadata, Mapping):
        problems.append("$.metadata: must be a mapping declaring at least a `name`")
    else:
        problems.extend(
            _pattern_violations(
                metadata.get("name"),
                path="$.metadata.name",
                pattern=_DNS_SUBDOMAIN,
                max_length=_MAX_NAME_LENGTH,
                label="object name",
                required=True,
            )
        )
        problems.extend(
            _pattern_violations(
                metadata.get("namespace"),
                path="$.metadata.namespace",
                pattern=_DNS_LABEL,
                max_length=_MAX_NAMESPACE_LENGTH,
                label="namespace",
            )
        )

    spec = document.get("spec")
    if not isinstance(spec, Mapping):
        return problems + ["$.spec: must be a mapping declaring at least one rule"]

    if spec.get("hostnames") is not None:
        hostnames, bound = _bounded_list(
            spec["hostnames"], path="$.spec.hostnames", maximum=MAX_HOSTNAMES
        )
        problems.extend(bound)
        for index, hostname in enumerate(hostnames):
            problems.extend(
                _pattern_violations(
                    hostname,
                    path=f"$.spec.hostnames[{index}]",
                    pattern=_HOSTNAME,
                    max_length=_MAX_HOSTNAME_LENGTH,
                    label="hostname",
                )
            )

    if spec.get("parentRefs") is not None:
        parents, bound = _bounded_list(
            spec["parentRefs"], path="$.spec.parentRefs", maximum=MAX_PARENT_REFS
        )
        problems.extend(bound)
        for index, parent in enumerate(parents):
            location = f"$.spec.parentRefs[{index}]"
            if not isinstance(parent, Mapping):
                problems.append(f"{location}: must be a mapping")
                continue
            problems.extend(_reference_violations(parent, path=location, section_name=True))

    rules = spec.get("rules")
    if rules is None:
        problems.append("$.spec.rules: an HTTPRoute with no rules routes nothing")
    else:
        entries, bound = _bounded_list(rules, path="$.spec.rules", maximum=MAX_RULES)
        problems.extend(bound)
        if isinstance(rules, list) and not rules:
            problems.append("$.spec.rules: an HTTPRoute with no rules routes nothing")
        for index, rule in enumerate(entries):
            problems.extend(_rule_violations(rule, path=f"$.spec.rules[{index}]"))

    return problems


def httproute_stream_violations(documents: Any) -> List[str]:
    """Return every violation across a stream of parsed manifests.

    Args:
        documents: The parsed YAML documents, in stream order.

    Returns:
        One message per violation, each prefixed with its document index so a
        multi-document stream stays diagnosable.
    """
    if not isinstance(documents, (list, tuple)):
        return ["$: a manifest stream must be a list of documents"]
    if not documents:
        return ["$: the manifest stream contains no documents"]
    problems: List[str] = []
    for index, document in enumerate(documents):
        problems.extend(
            f"document[{index}]{message.lstrip('$')}" if message.startswith("$") else message
            for message in httproute_document_violations(document)
        )
    return problems


def validate_httproute_manifest(
    content: str,
    *,
    source_label: str = "emitted",
) -> None:
    """Validate emitted manifest text as a stream of applicable ``HTTPRoute``\\ s.

    Re-parses ``content`` through the import adapter — so the text really is a
    manifest the Gateway API reader accepts — and then applies
    :func:`httproute_stream_violations` to the raw documents, which is where the
    CRD's own field rules live.

    Args:
        content: The emitted YAML text (one or more ``---``-separated documents).
        source_label: Label used in the parse error, when parsing is what fails.

    Raises:
        ValueError: When the text cannot be parsed as Gateway API manifests, or
            breaks any schema rule. The message names every violation found.
    """
    import yaml

    from .gateway_api_import_source import GatewayApiImportSource
    from .import_source import ImportSourceError

    try:
        GatewayApiImportSource().parse(content, source_label=source_label)
    except ImportSourceError as exc:
        # The adapter raises its own intake error; this function has one failure
        # type so a caller validating an artifact need not know which half failed.
        raise ValueError(f"Invalid Gateway API manifest: {exc}") from exc
    documents: List[Any] = [
        document for document in yaml.safe_load_all(content) if document is not None
    ]
    problems = httproute_stream_violations(documents)
    if problems:
        raise ValueError("Invalid Gateway API manifest: " + "; ".join(problems))


def hostname_violations(value: str) -> Optional[str]:
    """Return why ``value`` is not a legal Gateway API hostname, or ``None``.

    Exposed for the emitter, which drops a canonical server host it cannot spell
    as a hostname rather than emitting a manifest the cluster would reject.

    Args:
        value: The candidate hostname.

    Returns:
        A one-line reason, or ``None`` when the hostname is legal.
    """
    problems = _pattern_violations(
        value,
        path="hostname",
        pattern=_HOSTNAME,
        max_length=_MAX_HOSTNAME_LENGTH,
        label="hostname",
        required=True,
    )
    return problems[0].split(": ", 1)[1] if problems else None
