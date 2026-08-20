"""Standard-library dataclasses: annotations without pydantic's constraint vocabulary."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True)
class OrderLine:
    sku: str
    quantity: int
    unit_price: float


@dataclass
class Order:
    order_id: str
    customer_id: str
    placed_at: datetime
    lines: list[OrderLine] = field(default_factory=list)
    note: str | None = None
