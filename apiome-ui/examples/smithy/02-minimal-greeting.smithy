$version: "2.0"

// Smithy 2.0 minimal example — the smallest canonical model: a `$version`
// control statement, a namespace, and a single structure shape.

namespace example.minimal

/// A greeting returned to the caller.
structure Greeting {
    @required
    message: String
}
