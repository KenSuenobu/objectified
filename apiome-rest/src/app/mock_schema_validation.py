"""Author-time JSON Schema checking for mock configuration (#5532, MSC-2.2).

The mock's *response synthesis* lives in ``apiome_mock.schema_synthesizer`` and always has: it is
format-aware and property-name-hint aware, and MSC-2.2 retired the weaker ``app.mock_data_generator``
that used to duplicate it here.

What did not move is the other half of that module — checking a value the **author** wrote against
the schema the spec declares for it. That question is asked at save time, in this package, by the
scenario/fixture validators, and it has no runtime counterpart to consolidate with: a canned
scenario response is validated once when it is stored, not on every request.

So this module holds exactly one function, and it is deliberately small enough that nobody is
tempted to grow a second generator beside it.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import jsonschema

__all__ = ["validate_value"]


def validate_value(value: Any, schema: Any, root: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Validate ``value`` against ``schema``, resolving ``$ref`` pointers against ``root``.

    Args:
        value: The value to check — typically a canned scenario response body.
        schema: The JSON Schema fragment from the version's generated OpenAPI document. A
            non-mapping or empty schema constrains nothing and always passes.
        root: The full document, so ``"#/components/..."`` pointers inside ``schema`` resolve.

    Returns:
        ``None`` when the value is valid, else a human-readable message naming the first failure
        and the JSON path it occurred at.
    """
    if not isinstance(schema, dict) or not schema:
        return None
    try:
        if root and root is not schema:
            wrapper = dict(schema)
            wrapper.setdefault("$defs", {})
            # Expose the document's components so any "#/components/..." $ref resolves.
            check_schema: Dict[str, Any] = {**root, **wrapper}
        else:
            check_schema = schema
        jsonschema.validate(instance=value, schema=check_schema)
        return None
    except jsonschema.ValidationError as exc:
        location = "/".join(str(p) for p in exc.absolute_path) or "<root>"
        return f"{location}: {exc.message}"
    except jsonschema.SchemaError as exc:  # pragma: no cover - malformed stored spec
        return f"invalid schema: {exc.message}"
