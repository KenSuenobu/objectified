from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class OrderLine(BaseModel):
    sku: str = Field(pattern=r"^[A-Z]{3}-[0-9]{4}$")
    quantity: int = Field(gt=0, le=9999)
    unit_price: float = Field(ge
