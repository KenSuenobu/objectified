// TypeSpec composition example — models composed with the spread operator
// (`...Base`) so shared field sets (identity, audit timestamps) are declared
// once and reused, plus model-typed fields nesting one model in another.
import "@typespec/http";
import "@typespec/rest";

using TypeSpec.Http;
using TypeSpec.Rest;

@service(#{ title: "Library API" })
namespace Library;

/// Shared identity fields, spread into every persisted model.
model ResourceBase {
  @key id: string;
}

/// Shared audit timestamps, spread into every persisted model.
model AuditFields {
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
}

/// A publisher, nested inside Book as a model-typed field.
model Publisher {
  name: string;
  country?: string;
}

/// A book composed from the shared base models plus its own fields.
model Book {
  ...ResourceBase;
  ...AuditFields;
  title: string;
  author: string;
  publisher: Publisher;
  isbn?: string;
}

/// A borrower record reusing the same shared base models.
model Borrower {
  ...ResourceBase;
  ...AuditFields;
  fullName: string;
  email: string;
}

@route("/books")
interface Books {
  /// List all books.
  @get list(): Book[];

  /// Fetch a book by id.
  @get read(@path id: string): Book;
}

@route("/borrowers")
interface Borrowers {
  /// Fetch a borrower by id.
  @get read(@path id: string): Borrower;
}
