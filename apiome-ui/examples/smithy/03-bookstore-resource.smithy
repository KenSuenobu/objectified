$version: "2.0"

// Smithy 2.0 composition example — a `resource` shape that binds lifecycle
// operations, with structures reused across several operation inputs and
// outputs (BookSummary appears in both the read and list responses).

namespace example.bookstore

service BookstoreService {
    version: "2026-01-01"
    operations: [GetBook, ListBooks, CreateBook]
}

/// A book catalog entry modeled as a Smithy resource.
resource Book {
    read: GetBook
    list: ListBooks
    create: CreateBook
}

/// Fetch a single book by id.
operation GetBook {
    input: GetBookInput
    output: BookSummary
}

/// List all books in the catalog.
operation ListBooks {
    input: ListBooksInput
    output: ListBooksOutput
}

/// Add a new book to the catalog.
operation CreateBook {
    input: CreateBookInput
    output: BookSummary
}

structure GetBookInput {
    @required
    bookId: String
}

structure ListBooksInput {
    pageSize: Integer
    pageToken: String
}

structure ListBooksOutput {
    @required
    books: BookSummaryList
    nextPageToken: String
}

structure CreateBookInput {
    @required
    title: String

    @required
    author: String

    isbn: String
}

/// Shared representation of a book, reused by read and list operations.
structure BookSummary {
    @required
    bookId: String

    @required
    title: String

    @required
    author: String

    isbn: String
}

list BookSummaryList {
    member: BookSummary
}
