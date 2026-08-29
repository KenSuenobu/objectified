"""Name-matching rules shared by the correlation engine and its author-time surfaces (#5529, MSC-1.3).

Correlation decides *by name* which response property takes which request value: ``petId`` binds
``petId``, ``pet_id`` and the bare ``id``; ``createdAt`` is never echoed from a request body
because a real server assigns it. Two very different callers need those rules to agree:

* :mod:`apiome_mock.correlation` applies them at serve time, to a materialized response body;
* :mod:`app.mock_correlation_bindings` projects them at author time, over the response *schema*,
  so the editor can show what inference would decide **before** anything is saved.

If each declared its own copy, the preview would eventually promise a binding the runtime does not
make — the one failure a preview must not have. So the rules live here, in the ``app`` package,
which apiome-mock already depends on. It is the same call :mod:`app.mock_match` and
:mod:`app.mock_template` made, for the same reason.

Deliberately dependency-free (only :mod:`re`): this module sits on apiome-mock's serving import
path, and nothing here needs more than string folding.
"""

from __future__ import annotations

import re
from typing import Dict, Mapping, Tuple

__all__ = [
    "CORRELATION_MODES",
    "ECHOED_METHODS",
    "MODE_EXPLICIT",
    "MODE_INFERRED",
    "MODE_OFF",
    "MODE_PATH_PARAMS",
    "SERVER_OWNED_FIELDS",
    "normalize_property_name",
    "path_parameter_aliases",
]

MODE_OFF = "off"
"""No correlation; the version behaves exactly as it did before MSC-1.1."""

MODE_PATH_PARAMS = "path-params"
"""Bind response properties named after a path parameter to the request's value."""

MODE_INFERRED = "inferred"
"""``path-params`` plus echoing request-body fields back on writes."""

MODE_EXPLICIT = "explicit"
"""Only the per-operation pointer map; no inference."""

CORRELATION_MODES: Tuple[str, ...] = (MODE_OFF, MODE_PATH_PARAMS, MODE_INFERRED, MODE_EXPLICIT)
"""Every accepted ``mode`` value, in increasing order of what they bind."""

SERVER_OWNED_FIELDS: frozenset = frozenset({"id", "createdat", "updatedat", "deletedat"})
"""Normalized property names ``inferred`` never echoes from the request body.

These are the fields a real server *assigns*: echoing a client-supplied ``id`` back would make the
mock agree with a request the real API would have overruled. They are compared after
:func:`normalize_property_name`, so ``created_at`` and ``createdAt`` are the same field. An author
who genuinely wants one of them bound says so with an ``explicit`` pointer entry.
"""

ECHOED_METHODS: frozenset = frozenset({"POST", "PUT", "PATCH"})
"""Methods whose request body the ``inferred`` pass echoes back."""

_NON_ALPHANUMERIC = re.compile(r"[^a-z0-9]+")


def normalize_property_name(name: str) -> str:
    """Fold a property or path-parameter name to its comparison form.

    Lower-cases and drops every non-alphanumeric character, so ``petId``, ``pet_id`` and ``Pet-Id``
    all become ``petid``.

    Args:
        name: The raw property or parameter name.

    Returns:
        The normalized form used for name-based matching.
    """
    return _NON_ALPHANUMERIC.sub("", name.lower())


def path_parameter_aliases(path_params: Mapping[str, str]) -> Dict[str, str]:
    """Build the ``normalized property name -> request value`` map the name pass matches on.

    Every parameter registers its own normalized name, and a parameter whose name *ends* in ``id``
    (``petId``, ``pet_id``) additionally registers the bare ``id`` — the spelling most response
    schemas actually use. When several parameters would claim the bare ``id``
    (``/users/{userId}/pets/{petId}``) the **last** one wins: it addresses the resource the
    response is about.

    Args:
        path_params: Path parameters as extracted by routing, in template order.

    Returns:
        Normalized property name to raw request value.
    """
    aliases: Dict[str, str] = {}
    for name, value in path_params.items():
        normalized = normalize_property_name(name)
        if not normalized:
            continue
        aliases[normalized] = value
        if normalized.endswith("id") and len(normalized) > 2:
            aliases["id"] = value
    return aliases
