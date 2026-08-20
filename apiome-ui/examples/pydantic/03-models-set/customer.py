from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class Address(BaseModel):
    line1: str = Field(min_length=1, max_length=60)
    line2: Optional[str] = Field(default=None, max_length=60)
    city: str
    postal_code: str
    country_code: str = Field(min_length=2, max_length=2)


class Customer(BaseModel):
    customer_id: str
    display_name: str
    email: EmailStr
    address: Optional[Address] = None
    segments: list[str] = Field(default_factory=list)
