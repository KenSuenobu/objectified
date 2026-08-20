"""
Dynamic model construction: the case FMT-8.4 must declare a parsing limit for, because a
static reader cannot know the fields without running the module — and running arbitrary
user Python is an unacceptable execution risk in a multi-tenant service.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, create_model

# Statically visible: this model is readable.
class Base(BaseModel):
    id: str
    created_at: Optional[str] = None


# Not statically visible: the field set is computed.
COLUMNS = {
    "sku": (str, ...),
    "quantity": (int, 0),
    "unit_price": (float, 0.0),
}

OrderLine = create_model("OrderLine", **COLUMNS)  # type: ignore[call-overload]

# Also not statically visible: fields assembled in a loop.
_extra_fields = {name: (str, Field(default="")) for name in ("note", "reference")}
Order = create_model("Order", __base__=Base, **_extra_fields)  # type: ignore[call-overload]


def model_for(table: str, columns: dict[str, type]) -> type[BaseModel]:
    """A factory: the returned model's shape depends on runtime arguments."""
    return create_model(table, **{k: (v, ...) for k, v in columns.items()})  # type: ignore[call-overload]
