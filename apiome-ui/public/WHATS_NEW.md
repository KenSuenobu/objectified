# Apiome 08-2026 RC5

We continue to improve the platform based on your feedback with improvements and new features!

---

## Features/Improvements

- API Formats:
  - Hardening import functionality
  - Adds formats:
    - MCP import and export
    - Kong import and export
    - Arazzo 1.1 import and export
    - AsyncAPI 2.x export
    - OData v2/v3 import and export
    - WSDL 2.0 import and export
    - Avro IDL (`.avdl`) import and export
    - Swagger 1.2 import
    - Postman Collection v2.0 import
    - Protobuf editions 2023/2024 normalization parity
    - RELAX NG import
    - DTD import
    - Schematron import
    - CDDL (RFC-8610) import and export
    - Apache Arrow/Flight import
    - Open Data Contract Standard (ODCS v3.1) import and export
    - Kafka Connect schema import and export
    - dbt model and semantic-manifest import
    - SQL DDL import
  - Linting rule pack updates for scoring new import types
    - Data contracts are now scored on their own terms: ownership, service levels, freshness,
      retention, column documentation, row identity, classification and declared quality checks
  - Added pills to supported format list to show the source and type that the API format provides
  - Every format now declares which versions it reads and writes, and which version an export produces by default
- Mock Services:
  - Several mock services have been improved including mock rules and testing via UI and JSON rules

## Bug Fixes

- Import:
  - Fixed upload to accept all file format extensions instead of just the 10 it had previously
  - Fixes dependency for AsyncAPI to re-enable import functionality
  - Fixing durability of import process, added extra tests to REST service test suite
  - Fixing bulk import functionality:
    - Now includes the ability to bulk import into existing or new projects without having to validate all selections
    - Visual indicator of the bulk import is now implemented properly
- MCP:
  - Hardens tool array emit for LLM tool summary

---

View our YouTube channel [here](https://www.youtube.com/) for detailed tutorials and walkthroughs!

---

## Feedback

We'd love to hear your thoughts! Your feedback helps us make Apiome better.

---

**Thank you for using Apiome!**

*Last updated: June 23, 2026*

