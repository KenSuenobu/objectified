// TypeSpec with imports, a namespace, and an alias, but no model, enum,
// or interface — nothing importable.
import "@typespec/http";

using TypeSpec.Http;

namespace EmptyService;

alias Name = string;
