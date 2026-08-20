from pydantic import BaseModel


class Beacon(BaseModel):
    id: str
    seen_at: int
