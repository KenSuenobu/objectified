"""
Request and response models as a FastAPI service ships them: shared value objects,
per-endpoint request bodies, a paginated envelope and a problem-details union.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints

CustomerId = Annotated[str, StringConstraints(pattern=r"^CUS-[0-9]{6}$")]
MerchantId = Annotated[str, StringConstraints(pattern=r"^MER-[0-9]{6}$")]
CurrencyCode = Annotated[str, StringConstraints(min_length=3, max_length=3, to_upper=True)]


class Currency(str, Enum):
    EUR = "EUR"
    GBP = "GBP"
    USD = "USD"


class CaptureMode(str, Enum):
    AUTOMATIC = "AUTOMATIC"
    MANUAL = "MANUAL"


class AuthorizationResult(str, Enum):
    APPROVED = "APPROVED"
    DECLINED = "DECLINED"
    REFERRAL = "REFERRAL"
    EXPIRED_CARD = "EXPIRED_CARD"
    INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS"


class Money(BaseModel):
    model_config = ConfigDict(frozen=True)

    value: int = Field(ge=0, description="Minor units; 1250 is EUR 12.50.")
    currency: Currency


class Address(BaseModel):
    line1: str = Field(min_length=1, max_length=60)
    line2: Optional[str] = Field(default=None, max_length=60)
    city: str = Field(min_length=1, max_length=40)
    postal_code: str = Field(min_length=3, max_length=10, alias="postalCode")
    country_code: str = Field(min_length=2, max_length=2, alias="countryCode")


class Customer(BaseModel):
    customer_id: CustomerId = Field(alias="customerId")
    display_name: str = Field(min_length=1, max_length=120, alias="displayName")
    email: EmailStr
    billing_address: Optional[Address] = Field(default=None, alias="billingAddress")
    created_at: datetime = Field(alias="createdAt")


class CardReference(BaseModel):
    network_token: str = Field(min_length=16, max_length=64, alias="networkToken")
    expiry_month: int = Field(ge=1, le=12, alias="expiryMonth")
    expiry_year: int = Field(ge=2026, le=2099, alias="expiryYear")
    cardholder_name_hint: Optional[str] = Field(default=None, max_length=80, alias="cardholderNameHint")


class AuthorizationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    merchant_id: MerchantId = Field(alias="merchantId")
    amount: Money
    card: CardReference
    capture_mode: CaptureMode = Field(default=CaptureMode.AUTOMATIC, alias="captureMode")
    idempotency_key: str = Field(alias="idempotencyKey")


class Authorization(BaseModel):
    authorization_id: str = Field(alias="authorizationId")
    result: AuthorizationResult
    amount: Money
    authorized_amount: Optional[Money] = Field(default=None, alias="authorizedAmount")
    network_code: Optional[str] = Field(default=None, min_length=2, max_length=2, alias="networkCode")
    decided_at: datetime = Field(alias="decidedAt")


class CaptureRequest(BaseModel):
    amount: Money
    final_capture: bool = Field(default=True, alias="finalCapture")


class SettlementRow(BaseModel):
    authorization_id: str = Field(alias="authorizationId")
    settled_amount: Decimal = Field(max_digits=15, decimal_places=2, alias="settledAmount")
    settlement_date: date = Field(alias="settlementDate")


class ValidationProblem(BaseModel):
    type: Literal["validation"]
    field: str
    message: str


class RateLimitProblem(BaseModel):
    type: Literal["rate_limit"]
    retry_after_seconds: int = Field(gt=0, alias="retryAfterSeconds")


class UpstreamProblem(BaseModel):
    type: Literal["upstream"]
    component: str
    transient: bool


Problem = Annotated[
    Union[ValidationProblem, RateLimitProblem, UpstreamProblem],
    Field(discriminator="type"),
]


class ApiError(BaseModel):
    status: int = Field(ge=400, le=599)
    problem: Problem
    request_id: str = Field(alias="requestId")


class AuthorizationPage(BaseModel):
    items: list[Authorization]
    next_cursor: Optional[str] = Field(default=None, alias="nextCursor")
    has_more: bool = Field(alias="hasMore")
