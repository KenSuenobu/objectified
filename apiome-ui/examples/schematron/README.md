# Schematron — `schematron`

Fixtures for **FMT-4.3** ([#5436](https://github.com/apiome/apiome/issues/5436)). Schematron is not a
schema language — it is a **rule** language, so it projects onto Apiome's lint engine and imports as a
**style guide**, one rule per assertion, not onto the canonical schema model. Entries carry
`adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** Root `schema` (or a bare `pattern` module) in the ISO namespace
`http://purl.oclc.org/dsdl/schematron`.

**The projection these fixtures are shaped for**

| Schematron | Lint engine |
| --- | --- |
| `assert`/`report` `@id` | rule id |
| `@role` (`fatal`/`error`/`warning`/`info`) | severity |
| assertion text | message |
| `@context` XPath | rule target, recorded as-is |
| `phase`/`active` | rule selection within the guide |
| `diagnostic` | remediation text |
| XPath that cannot be evaluated against the canonical model | **declared-but-unevaluable**, with a reason |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-single-assert.sch` | minimal | One pattern, one rule, one assertion. |
| `02-typical-invoice-rules.sch` | typical | Three patterns, `ns` bindings, `let` variables, `assert` and `report`, ids and roles. |
| `03-composition-abstract-patterns.sch` | composition | Abstract pattern + `is-a`/`param` instantiation, abstract rule + `extends`. |
| `04-stress-phases-and-diagnostics.sch` | stress | `phase`/`active`, `defaultPhase`, `diagnostics`, `flag`, prose `p`, and one rule whose XPath deliberately cannot be evaluated (the declared-but-unevaluable case). |
| `05-real-world-billing-bis-rules.sch` | real-world | A numbered business-rule pack (BR-nn) over a UBL-derived invoice — the shape a European e-invoicing profile ships. |
| `06-include-set/` | multi-file | `include` of a `pattern` module — the rule set only exists once the set is assembled. |
| `negative/` | — | Unclosed rule, patterns with no assertions, truncation, an XSLT stylesheet, UTF-16, and an `is-a` naming an abstract pattern that does not exist. |

**Contract the adapter must meet.** One imported rule per assertion; severity and phase map to the
lint severity vocabulary; unevaluable rules are visible with a reason rather than silently dropped;
applying the imported guide re-scores a catalog item.
