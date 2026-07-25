// Broken TypeSpec: the model's closing brace is missing.
import "@typespec/http";

using TypeSpec.Http;

namespace BrokenService;

model Greeting {
  message: string;
