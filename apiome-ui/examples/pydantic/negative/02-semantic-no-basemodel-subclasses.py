"""
Imports pydantic but defines no BaseModel subclass: a helpers module with nothing a
schema importer can model.
"""

from __future__ import annotations

from pydantic import TypeAdapter

StringList = TypeAdapter(list[str])


def parse_tags(raw: str) -> list[str]:
    return StringList.validate_python([part.strip() for part in raw.split(",") if part.strip()])
