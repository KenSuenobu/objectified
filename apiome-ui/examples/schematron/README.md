# Schematron — `schematron`

Fixtures for **FMT-4.3** ([#5436](https://github.com/apiome/apiome/issues/5436)). Schematron is not a
schema language — it is a **rule** language, so it projects onto Apiome's lint engine and imports as a
**style guide**, one rule per assertion, not onto the canonical schema model. Entries therefore carry
`adapter_key: null` and the `style-guide-import` tag: there is no `ImportSource` adapter to claim them,
because nothing here becomes a `CanonicalApi`.

**The importer.** `POST /v1/lint/schematron/import` — see
[`docs/guide/schematron-import.md`](../../../docs/guide/schematron-import.md). It is built from
`app.schematron_parser` (composition and phases), `app.schematron_projection` (XPath → canonical-model
rule, or a reason there is none) and `app.schematron_import` (the style-guide state), and is driven by
these fixtures in `apiome-rest/tests/test_schematron_import.py`.

**Detection marker.** Root `schema` (or a bare `pattern` module) in the ISO namespace
`http://purl.oclc.org/dsdl/schematron`.

**The projection these fixtures are shaped for**

| Schematron | Lint engine |
| --- | --- |
| `assert`/`report` `@id` | rule id, as `schematron.<id>` |
| `@role` (`fatal`/`error`/`warning`/`info`) | severity |
| assertion text | message |
| `@context` XPath | rule target, recorded as-is |
| `phase`/`active` | rule selection within the guide |
| `diagnostic` | remediation text, appended to the message |
| XPath that cannot be evaluated against the canonical model | **declared-but-unevaluable**, with a reason |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-single-assert.sch` | minimal | One pattern, one rule, one assertion (and no `@id`, so the id is derived). |
| `02-typical-invoice-rules.sch` | typical | Three patterns, `ns` bindings, `let` variables, `assert` and `report`, ids and roles. |
| `03-composition-abstract-patterns.sch` | composition | Abstract pattern + `is-a`/`param` instantiation, abstract rule + `extends`. |
| `04-stress-phases-and-diagnostics.sch` | stress | `phase`/`active`, `defaultPhase`, `diagnostics`, `flag`, prose `p`, and one rule whose XPath deliberately cannot be evaluated (the declared-but-unevaluable case). |
| `05-real-world-billing-bis-rules.sch` | real-world | A numbered business-rule pack (BR-nn) over a UBL-derived invoice — the shape a European e-invoicing profile ships. |
| `06-include-set/` | multi-file | `include` of a `pattern` module — the rule set only exists once the set is assembled. |
| `negative/` | — | Unclosed rule, patterns with no assertions, truncation, an XSLT stylesheet, UTF-16, and an `is-a` naming an abstract pattern that does not exist. |

**What the importer makes of them.** Coverage is `projected / assertions` — the share of a rule
language about *instances* that a *model* can be scored against. It is reported, never gated on.

| File | Assertions | Projected | Declared, with a reason |
| --- | --- | --- | --- |
| `01-minimal-single-assert.sch` | 1 | 1 | — |
| `02-typical-invoice-rules.sch` | 9 | 1 | context predicates, a computed `let`, value comparisons |
| `03-composition-abstract-patterns.sch` | 8 | 6 | two `or`-composed tests |
| `04-stress-phases-and-diagnostics.sch` | 10 | 3 | a `report` on a count bound, `string-length`, `matches`, a user function, an out-of-phase rule |
| `05-real-world-billing-bis-rules.sch` | 16 | 10 | the calculation and VAT-code rules |
| `06-include-set/main.sch` | 4 | 4 | — |

**Negative classes and the code each grounds on**

| File | `expected_error_code` | Grounded in |
| --- | --- | --- |
| `negative/01-syntactic-unclosed-rule.sch` | `INPUT_MALFORMED` | a mismatched tag |
| `negative/02-semantic-pattern-without-rules.sch` | `INPUT_SEMANTIC_INVALID` | no `assert`/`report` anywhere |
| `negative/03-truncated-mid-assert.sch` | `INPUT_TRUNCATED` | the parser ran out of input mid-token |
| `negative/04-wrong-format-xslt.xsl` | `FORMAT_MISMATCH` | an XSLT root, not a Schematron one |
| `negative/05-encoding-utf16.sch` | `INPUT_ENCODING_INVALID` | the bytes do not decode as UTF-8 |
| `negative/06-unresolvable-is-a-reference.sch` | `INPUT_REFERENCE_UNRESOLVED` | `is-a` names an undeclared abstract pattern |

**Contract the adapter must meet.** One imported rule per assertion; severity and phase map to the
lint severity vocabulary; unevaluable rules are visible with a reason rather than silently dropped;
applying the imported guide re-scores a catalog item.
