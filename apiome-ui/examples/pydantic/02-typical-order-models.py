"""Order domain models with the constraints a plain annotation cannot carry."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class OrderStatus(str, Enum):
    NEW = "new"
    PAID = "paid"
    SHIPPED = "shipped"
    CANCELLED = "cancelled"


class OrderLine(BaseModel):
    sku: str = Field(pattern=r"^[A-Z]{3}-[0-9]{4}$")
    quantity: int = Field(gt=0, le=9999)
    unit_price: float = Field(ge=0)
    discount: Optional[float] = Field(default=None, ge=0, le=1)


class Order(BaseModel):
    order_id: str = Field(description="Business identifier of the order.")
    customer_id: str = Field(min_length=3, max_length=20)
    status: OrderStatus = OrderStatus.NEW
    placed_at: datetime
    lines: list[OrderLine] = Field(min_length=1, max_length=200)
    total: float = Field(ge=0)
    currency: str = Field(min_length=3, max_length=3)
    note: Optional[str] = Field(default=None, max_length=500)
    contact_email: EmailStr


class NewOrder(BaseModel):
    customer_id: str
    lines: list[OrderLine]
    note: Optional[str] = None
