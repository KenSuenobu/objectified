"""Within-document composition: a mixin plus a base model, two specialisations, a
generic envelope instantiated by subclassing, and a model composed of other models."""

from __future__ import annotations

from datetime import datetime
from typing import Generic, Literal, Optional, TypeVar, Union

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class TimestampMixin(BaseModel):
    created_at: datetime
    updated_at: Optional[datetime] = None


class IdentifiedBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[A-Z]{3}-[0-9]{6}$")


class Record(IdentifiedBase, TimestampMixin):
    """Multiple inheritance: fields from both parents are merged."""

    label: str = Field(min_length=1, max_length=80)


class ActiveRecord(Record):
    status: Literal["active"] = "active"
    updated_at: datetime


class ArchivedRecord(Record):
    status: Literal["archived"] = "archived"
    archived_at: datetime


AnyRecord = Union[ActiveRecord, ArchivedRecord]


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int = Field(ge=0)
    next_cursor: Optional[str] = None


class RecordPage(Page[AnyRecord]):
    """Generic instantiated by subclassing — statically resolvable."""


class RecordSet(BaseModel):
    """Composed of other models rather than of scalars."""

    active: list[ActiveRecord] = Field(default_factory=list)
    archived: list[ArchivedRecord] = Field(default_factory=list)
    by_id: dict[str, Record] = Field(default_factory=dict)
    page: Optional[RecordPage] = None
