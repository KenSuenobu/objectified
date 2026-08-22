# Importing a Schematron rule set

> **FMT-4.3 (#5436).** Schematron is not a schema language — it is a **rule** language, and the
> validation layer of UBL/Peppol, national e-invoicing profiles, health-data programmes and
> government exchanges. Because it is rules and not structure, it lands on Apiome's governance
> engine rather than on the canonical schema model: `POST /v1/lint/schematron/import` reads a
> `.sch` file and turns every `assert`/`report` into a [style-guide](custom-rules.md) rule.

## The call

```bash
curl -X POST https://<host>/v1/lint/schematron/import \
  -H 'Content-Type: application/json' \
  -d '{"content": "<the .sch text>", "sourceLabel": "billing-rules.sch"}'
```

| Field | Meaning |
|---|---|
| `content` | The rule set's text — the root document of the set. Required, capped at 256 KiB. |
| `sourceLabel` | Optional path of `content` within the upload (`main.sch`), echoed back and used to resolve a relative `include` href. |
| `members` | Other files of a multi-file rule set, keyed by path relative to the set root. Only consulted by `include`. Up to 64 files, 1 MiB in total. |

**Nothing is persisted.** The response is a translation you review, then store:

```
yaml  ->  PUT /v1/style-guides/{tenantSlug}/{guideId}/custom-rules
```

Nothing is fetched, either: an `include` that names a file outside `members` fails with
`INPUT_REFERENCE_UNRESOLVED` rather than reaching the network.

## The projection

| Schematron | Apiome |
|---|---|
| `assert` / `report` `@id` | rule id, as `schematron.<id>` |
| `@role` (`fatal`/`error`/`warn`/`info`) | severity (`error`/`error`/`warning`/`info`) |
| assertion text | the rule's message |
| `diagnostic` (via `@diagnostics`) | remediation, appended to the message |
| `@context` XPath | the rule's target |
| `phase` / `active` / `defaultPhase` | which rules are evaluated |
| an XPath with no canonical analogue | **declared-but-unevaluable**, with a reason |

Composition is resolved before anything is projected, so a rule set that only exists once
assembled still imports as one flat guide:

- **`include`** splices a module in at its position; the modules used are listed in `modules`.
- **Abstract patterns** (`abstract="true"` + `is-a`/`param`) are instantiated once per `is-a`,
  with the `param` values substituted into `context`, `test` and message text.
- **Abstract rules** (`rule abstract="true"` + `extends`) are inlined into every concrete rule
  that extends them, the extended rule's assertions first.
- **`let`** variables whose value is a literal (`'urn:example:3.0'`, `120`,
  `('EUR', 'GBP', 'USD')`) are substituted; a computed `let` (`sum(…)`, `current-date()`) stays
  a variable and its assertions import as declared.

An assertion that repeats an `@id` — the same abstract rule extended by two concrete rules —
keeps both, as `schematron.id-r001` and `schematron.id-r001-2`.

## What the response says

```json
{
  "sourceLabel": "billing-rules.sch",
  "guideName": "Cross-border billing profile — business rules",
  "assertionCount": 16, "projectedCount": 10, "declaredCount": 6, "coverage": 0.625,
  "resolvedPhase": "#ALL", "phases": [], "modules": [],
  "namespaces": {"cbc": "urn:example:components"},
  "yaml": "rules:\n  schematron.br-02:\n    ...",
  "entries": [
    {"assertionId": "BR-02", "kind": "assert", "outcome": "projected",
     "ruleId": "schematron.br-02", "severity": "error", "role": "fatal",
     "context": "ubl:Invoice", "test": "cbc:ID", "target": "Invoice", "notes": []},
    {"assertionId": "BR-CO-10", "kind": "assert", "outcome": "declared",
     "ruleId": "schematron.br-co-10", "severity": "error",
     "context": "cac:LegalMonetaryTotal", "test": "cbc:LineExtensionAmount = $lineExtension",
     "reason": "variable_reference",
     "detail": "`cbc:LineExtensionAmount = $lineExtension` reads $lineExtension, a `let` whose value is computed at validation time rather than a literal constant"}
  ],
  "notes": []
}
```

Every assertion lands in exactly one **outcome**, and every assertion is in `yaml` — a rule that
cannot be evaluated is stored, not dropped:

| Outcome | Meaning |
|---|---|
| `projected` | An evaluable rule, scored against the canonical model. |
| `declared` | Stored with `scope: declared` and an `unevaluable` reason; never evaluated. |

`coverage` is `projectedCount / assertionCount`. It is **reported, never gated on**: Schematron
asserts things about document instances and Apiome scores a model, so a low coverage is a fact
about the rule language, not a defect in the import.

## What maps

A Schematron assertion projects when it is a statement about **shape** — something a schema
actually declares. Against a context that names one element:

| `test` | Becomes |
|---|---|
| `Total`, `exists(Total)`, `count(Total) >= 1`, `count(Total) > 0` | `Total` must be declared on the context element |
| `@currency` | the attribute `currency` must be declared |
| `not(Total)`, `empty(Total)`, `count(Total) = 0` | `Total` must **not** be declared |
| `Currency = ('EUR', 'GBP')`, `Id = 'urn:example:3.0'` | every value `Currency` is declared to allow is one of the listed values |

A `report` inverts the test, because a report fires when its test *holds*.

Rules are evaluated against a **governance document** rendered from the canonical model: every
named type keyed by name, its members split into `children` and `attributes`, each carrying the
declared facts a rule can test (`enum` — resolved through a referenced enum type — `pattern`,
lengths, `required`, `repeated`). A rule whose context names no declared type simply never fires,
which is exactly Schematron's own `rule context` semantics.

Two narrowings are imported with a `notes` entry rather than refused:

- a namespace prefix is dropped (`cbc:ID` targets a member named `ID`);
- a multi-step path checks only its first step (`Supplier/Party/Name` checks `Supplier`).

## What does not map — the reason codes

| `reason` | Meaning |
|---|---|
| `context_predicate` | The `@context` filters instances (`Party[@role='seller']`). Applying the rule to every `Party` would invent violations for the rest. |
| `context_not_projectable` | The `@context` is a wildcard, an axis, `//`, a union, or the document root — it names no single declared element. |
| `variable_reference` | The `test` reads a `let` computed at validation time. |
| `unsupported_xpath_function` | The `test` calls a function with no canonical analogue (`string-length`, `matches`, `current-date`, a user-defined function). |
| `unsupported_xpath_operator` | The `test` combines sub-expressions (`and`, `or`, arithmetic, `castable as`). |
| `instance_value_assertion` | The `test` compares instance values (`Total > 0`, `a = b`). |
| `unsupported_xpath_path` | A value restriction on a multi-step path, which only addresses one step. |
| `unsupported_report_inversion` | A `report` on a value set — the rule vocabulary expresses allowed sets, not forbidden ones. |
| `no_test` | The assertion carries no `@test`. |
| `inactive_phase` | The resolved phase does not activate the assertion's pattern, so the profile itself says it does not apply. |
| `rule_limit` | Beyond the 200-rules-per-guide cap (also reported as `stored: false`). |
| `invalid_projection` | The projected rule was rejected by the DSL — an element name too long to address, most often. `detail` carries the validation pointer. |

When an assertion is both out of phase *and* unprojectable, the projection reason wins — it is
the more useful fact.

## Scoring a catalog item

Store `yaml` on a style guide, assign the guide to the tenant or project, and the next canonical
lint re-scores under it. The rules imported from a Schematron are evaluated against the canonical
model, so a Peppol-shaped profile scores any XSD- or UBL-derived catalog item.

Rules of a guide that were written against a *document* (hand-authored rules, and everything
[imported from Spectral](spectral-import.md)) are untouched by this: each rule declares the model
it reads, and only rules of the matching scope run.

## Failures

A rule set that cannot be read at all returns `400` with `detail.code` from the intake taxonomy:

| `code` | Cause |
|---|---|
| `INPUT_MALFORMED` | Not well-formed XML. |
| `INPUT_TRUNCATED` | The document stops mid-element. |
| `INPUT_ENCODING_INVALID` | Not UTF-8 (a UTF-16 export, most often). |
| `FORMAT_MISMATCH` | Not Schematron — most commonly the compiled XSLT stylesheet. |
| `INPUT_SEMANTIC_INVALID` | Well-formed, but declares no `assert` or `report`. |
| `INPUT_REFERENCE_UNRESOLVED` | An `include`, `is-a` or `extends` names something the set does not contain. |
| `INPUT_UNSAFE_CONSTRUCT` | A DTD, an entity, an external reference, an XInclude, or an `include` cycle. |

## Related

- [custom-rules.md](custom-rules.md) — the DSL imported rules land in
- [spectral-import.md](spectral-import.md) — the same shape for `.spectral.yaml`
- [lint-and-quality.md](lint-and-quality.md) — the lint/scoring surface style guides plug into
