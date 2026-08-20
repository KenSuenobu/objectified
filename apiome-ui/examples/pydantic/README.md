# Pydantic models — `pydantic`

Fixtures for **FMT-8.4** ([#5465](https://github.com/apiome/apiome/issues/5465)). Pydantic is Python's
equivalent of Zod and — unusually — needs no external toolchain, because the REST service is itself
Python. Entries carry `adapter_key: null` and the `pending-adapter` tag.

> **No user module is ever executed.** FMT-8.4 parses source with `ast`, because importing arbitrary
> user Python is an unacceptable execution risk in a multi-tenant service. That decision is what makes
> `06-typical-dynamic-models.py` a *declared limit* rather than a feature.

**Detection markers.** `from pydantic import BaseModel` (or `import pydantic`) plus one or more
`class X(BaseModel):` definitions with annotated fields.

**Constraint mapping.** `Field(gt/ge/lt/le/multiple_of)` → numeric constraints; `Field(min_length/
max_length/pattern)` and `Annotated[str, StringConstraints(...)]` → string constraints;
`Optional[...]`/`| None` → nullability; `Field(default=…)`/`default_factory` → defaults;
`Field(alias=…)` → property naming; `Literal[...]` and `Enum` subclasses → enums;
`Field(discriminator=…)` → discriminated unions; `ConfigDict(extra="forbid")` → additional properties.

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-model.py` | minimal | One model, two fields. |
| `02-typical-order-models.py` | typical | `Field` constraints, `str, Enum`, optional fields, list cardinality, `EmailStr`. |
| `03-models-set/` | multi-file | A package: `__init__.py` re-exporting two modules with a cross-module type reference. |
| `04-stress-annotation-coverage.py` | stress | Every scalar type pydantic understands, containers, `Annotated` aliases, aliases and exclusions, discriminated union, generic model, self-reference — then validators and dynamic construction as declared limits. |
| `05-real-world-api-models.py` | real-world | A FastAPI service's model module: camelCase aliases, `Decimal` money, discriminated problem details, a paginated envelope. |
| `06-typical-dynamic-models.py` | typical | `create_model` in three forms — the parsing limit a static reader must declare rather than guess. |
| `07-composition-inheritance.py` | composition | Mixin + base multiple inheritance, a generic instantiated by subclassing, a model composed of models. |
| `negative/` | — | Bad indentation, a module with no `BaseModel` subclass, truncation, standard-library **dataclasses**, UTF-16, and an import from a module that is not in the set. |
