"""
Above the divider: annotations and Field constraints a *static* reader can resolve.
Below it: constructs that require executing the module, which FMT-8.4 forbids — every
one of them must be a declared parsing limit.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from enum import Enum, IntEnum
from ipaddress import IPv4Address
from pathlib import Path
from typing import Annotated, Any, Generic, Literal, Optional, TypeVar, Union

from pydantic import (
    AnyUrl,
    BaseModel,
    ConfigDict,
    Field,
    Json,
    SecretStr,
    StringConstraints,
    computed_field,
    field_validator,
    model_validator,
)

# ---------------------------------------------------------------- statically resolvable

T = TypeVar("T")


class Role(str, Enum):
    READER = "reader"
    WRITER = "writer"


class Priority(IntEnum):
    LOW = 1
    HIGH = 2


Sku = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}-[0-9]{4}$")]
Percent = Annotated[float, Field(ge=0, le=100)]
ShortText = Annotated[str, StringConstraints(min_length=1, max_length=80, strip_whitespace=True)]


class Scalars(BaseModel):
    text: str
    count: int
    ratio: float
    flag: bool
    blob: bytes
    when: datetime
    day: date
    at: time
    span: timedelta
    exact: Decimal = Field(max_digits=12, decimal_places=2)
    ident: uuid.UUID
    href: AnyUrl
    host: IPv4Address
    where: Path
    secret: SecretStr
    raw: Json[dict[str, int]]


class Containers(BaseModel):
    items: list[str]
    lookup: dict[str, int]
    pair: tuple[str, int]
    variadic: tuple[int, ...]
    unique: set[str]
    frozen: frozenset[int]
    optional_list: Optional[list[int]] = None
    nested: list[dict[str, list[int]]] = Field(default_factory=list)


class Shape(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=False)

    aliased: str = Field(alias="aliasedName", serialization_alias="aliased_name")
    with_default: str = "unset"
    factory_default: list[str] = Field(default_factory=list)
    excluded: str = Field(default="", exclude=True)
    described: int = Field(default=0, description="Documented field.", examples=[1, 2])
    deprecated_field: Optional[str] = Field(default=None, deprecated=True)
    role: Role = Role.READER
    priority: Priority = Priority.LOW
    literal: Literal["a", "b", "c"] = "a"
    union: Union[int, str, None] = None
    modern_union: int | str | None = None
    percent: Percent = 0.0
    sku: Sku = "ABC-0001"
    short: ShortText = "x"


class Cat(BaseModel):
    kind: Literal["cat"]
    lives: int = 9


class Dog(BaseModel):
    kind: Literal["dog"]
    good: bool = True


class Pet(BaseModel):
    animal: Union[Cat, Dog] = Field(discriminator="kind")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    next_cursor: Optional[str] = None


class OrderPage(Page[Scalars]):
    """Generic instantiated by subclassing: statically resolvable."""


class Node(BaseModel):
    """Self-referential model."""

    name: str
    children: list["Node"] = Field(default_factory=list)


# ---------------------------------------------------------------- declared limits


class WithValidators(BaseModel):
    """Validators are arbitrary code: their effect on the schema cannot be read statically."""

    value: int

    @field_validator("value")
    @classmethod
    def must_be_even(cls, v: int) -> int:
        if v % 2:
            raise ValueError("value must be even")
        return v

    @model_validator(mode="after")
    def cross_field(self) -> "WithValidators":
        return self

    @computed_field
    @property
    def doubled(self) -> int:
        return self.value * 2


class DynamicBase(BaseModel):
    """Base whose fields are assembled at class-creation time."""

    model_config = ConfigDict(extra="allow")

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)


FIELD_SPECS = {"alpha": (str, ...), "beta": (int, 0)}
