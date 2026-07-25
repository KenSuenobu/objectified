// TypeSpec minimal example — the smallest canonical definition: a TypeSpec
// library import, a namespace, and a single model.
import "@typespec/http";

using TypeSpec.Http;

namespace HelloService;

/// The one and only resource.
model Greeting {
  message: string;
}
