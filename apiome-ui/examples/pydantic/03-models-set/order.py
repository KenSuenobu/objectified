from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from customer import Address


class OrderStatus(str, Enum):
    NEW = "new"
    PAID = "paid"
    SHIPPED = "shipped"
    CANCELLED = "cancelled"


class OrderLine(BaseModel):
    sku: str
    quantity: int = Field(gt=0)
    unit_price: float = Field(ge=0)


class Order(BaseModel):
    order_id: str
    customer_id: str
    status: OrderStatus = OrderStatus.NEW
    lines: list[OrderLine] = Field(min_length=1)
    ship_to: Address
    total: float = Field(ge=0)
