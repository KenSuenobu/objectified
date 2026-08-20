"""Root of the set: composes the sibling modules into the public model surface.

Named `models.py` rather than `__init__.py` because the corpus path contract does not
allow a leading underscore in a file name; the cross-module resolution it exercises is
the same either way.
"""

from __future__ import annotations

from customer import Address, Customer
from order import Order, OrderLine, OrderStatus

from pydantic import BaseModel

__all__ = ["Address", "Customer", "Order", "OrderLine", "OrderStatus", "CustomerWithOrders"]


class CustomerWithOrders(BaseModel):
    """Aggregate declared in the root, built from types defined in both members."""

    customer: Customer
    orders: list[Order]
    total_spend: float = 0.0
