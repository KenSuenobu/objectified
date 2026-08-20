from pydantic import BaseModel


class Broken(BaseModel):
    id: str
      name: str
    count: int
