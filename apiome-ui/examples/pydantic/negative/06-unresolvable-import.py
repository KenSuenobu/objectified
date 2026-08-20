"""
`shared.value_objects` is not present in the fileset, so `Money` can never be resolved.
Static analysis must report a named unresolved reference rather than modelling the field
as `Any`.
"""

from __future__ import annotations

from pydantic import BaseModel

from shared.value_objects import Money


class Invoice(BaseModel):
    invoice_id: str
    total: Money
