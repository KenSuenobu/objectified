![Apiome Logo](docs/apiome.png)

# Apiome

Apiome reads, converts and publishes API descriptions.  It provides a visual editor for creating
and editing Schema Objects and Properties on OpenAPI 3.2.0 documents, and a catalog that keeps every
other description format in its own shape rather than forcing it into OpenAPI's.

**48<!--format-count:total--> formats, any-to-any**, spanning all 6<!--format-count:paradigms-->
canonical paradigms — REST, RPC, event-driven, graph, data schema and agent:

- Imports 48<!--format-count:importable--> formats.
- Exports 42<!--format-count:exportable--> formats.
- Round-trips 42<!--format-count:round_trip--> of them — import *and* export.
- Introspects a live endpoint, rather than reading a file, for
  5<!--format-count:live_discovery--> of them.

Those numbers are measured from the adapter registries rather than maintained by hand, and so is the
full list:

- **[Supported formats](docs/guide/supported-formats.md)** — every format, its registry key,
  direction, version coverage, file extensions and boundaries, generated and drift-checked in CI.
- `GET /v1/formats/matrix` — the same answer, machine-readable.
- `apiome formats` — the same answer, at a terminal.

## Goals

The Apiome application is a work in progress.

The goals of the project are:

- Provide user and group tenancy for schema definitions and sharing
- Provide visual editing of schemas class and property definitions
- Provide a database for storing schemas
- Provide a visual editor to create REST schemas using OpenAPI 3.2.0 Specifications

Eventually, the project will provide a database for storing data according to the
defined schemas.

## The Story

This is the 5th iteration of the project, effectively started in 2001 with Webplasm (see Webplasm
database, now defunct.)  Official work on this project started in 2021.

## LLMs Used

LLMs are used in conjunction with development.  They do not replace development, they simply augment the
engineering tasks.

This is a list of the LLMs used, and their purposes.

| Model       | Purpose                                          |
|-------------|--------------------------------------------------|
| qwen3.6     | Pull request code reviews                        |
| opus4.8     | UI/UX component improvements, issue completeness |
| Cursor Auto | Most trivial development tasks                   |
| gpt-5.6-sol | Planning, Roadmaps, Ticket Implementation        |
| fable5      | UI/UX improvements, gap analysis                 |

## Development Tools Used

Engineering tools all vary, but the primary ones used are:

- Cursor
- Copilot CLI
- Claude CLI

## Skills

See the .github/skills directory.

## Contributing

Fork the project, and off you go.  Please feel free to contribute to the project in the form of pull requests,
bug reports, fixes, and so on.  We encourage users to contribute!

Adding an example to the import corpus (`apiome-ui/examples/`)?  Read the
[corpus contributor guide](docs/CORPUS_CONTRIBUTOR_GUIDE.md) first — it covers the manifest fields,
the licensing rules for documents derived from third-party specs, the anonymization rule for
captured payloads, and the review checklist.

## Donations

Donations to help with the Anthropic Claude, Cursor, and GitHub Copilot token budget are always appreciated.

## License

Apache 2.0 Licensed!

