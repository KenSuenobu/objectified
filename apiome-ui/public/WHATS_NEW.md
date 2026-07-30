# Apiome 07-2026 RC4

We continue to improve the platform based on your feedback with improvements and new features!

---

## Features/Improvements

- Primitives
  - Major UX improvements in the import functionality
  - Shows unregistered namespaces that were detected
  - Import now cautions when a type declares no "type" of its own, since it will accept any value
  - Now shows unassigned/unspecified namespaces in JSON Type definitions
  - Grouping primitives in a namespace now works logically as expected
  - Primitives are now clickable inside the reference graph
  - Example form now builds inputs from the schema and allows for testing
  - Cards for reference resolution and base chain details now include traversable $refs if any apply
  - Clarifies language when importing and creating $ref for a system type based on "format" in a property
  - Documentation-only schemas that contain no type still get imported, but are treated as warnings
  - Review section of import for primitives now classifies unresolved $ref as a warning, so now shows warning counts
  - Changed "Test this type" to be expand/collapse with a chevron for testing
  - Now shows any warnings generated during import

## Bug Fixes

- Primitives
  - Added $ref lookups during primitive import, warning of unresolved $refs if any exist
  - Now shows the JSON Schema using monaco-editor
  - Added the ability to test a primitive by presenting a usable form that represents the content of the JSON Schema
  - Duplicate names are no longer treated as duplicates unless the namespace is identical
  - Removed invalid previously created primitives
  - Corrected resolution for $ref values in native system types
  - Updated import so that names with dashes are imported properly
  - Schemas that carry only documentation now import as the empty object type it describes instead of being rejected
  - Dependents card now shows properly
  - Added clarifying verbiage on unresolved $refs at import

---

View our YouTube channel [here](https://www.youtube.com/) for detailed tutorials and walkthroughs!

---

## Feedback

We'd love to hear your thoughts! Your feedback helps us make Apiome better.

---

**Thank you for using Apiome!**

*Last updated: June 23, 2026*

