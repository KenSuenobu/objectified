# Custom lint rules (Spectral-compatible DSL)

> **GOV-1.3 (#4429).** Author organization-specific lint rules ("all list endpoints paginate",
> "headers use Train-Case") in a YAML dialect that is a strict subset of the
> [Spectral](https://stoplight.io/open-source/spectral) ruleset format, easing migration from
> Stoplight/Redocly. Rules are validated by `POST /v1/lint/custom-rules/validate`; since
> GOV-1.4 (#4430), the custom rules of the resolved style guide (project → tenant → default)
> are evaluated in every lint path and their findings count toward the quality score.

## The format

A style-guide document is a YAML mapping with one top-level key, `rules`:

```yaml
rules:
  servers-use-https:
    description: Every server URL uses https.
    severity: error
    given: "$.servers[*].url"
    then:
      function: pattern
      functionOptions:
        match: "^https://"

  operations-have-summary:
    description: Every operation carries a summary.
    severity: warning
    given: "$.paths[*][*]"
    then:
      field: summary
      function: truthy
```

Each rule id maps to a definition with exactly these keys (anything else is rejected):

| Key | Required | Meaning |
|---|---|---|
| `description` | yes | Human explanation; becomes the base finding message. |
| `severity` | no | `error` \| `warning` \| `info` (default `warning`). |
| `given` | yes | One JSONPath expression, or a list of them, selecting the values to test. |
| `then` | yes | One clause, or a list of clauses, applied to every `given` match. |

A `then` clause:

| Key | Required | Meaning |
|---|---|---|
| `field` | no | Test this property of each matched object instead of the match itself. The special value `@key` tests each **key** of a matched object. |
| `function` | yes | One of the core functions below. |
| `functionOptions` | per function | The function's options (unknown options are rejected). |

Rule ids are lowercase alphanumeric segments separated by `.`, `-` or `_`, and may not shadow a
[built-in rule id](lint-rules.md).

## Core functions

| Function | Options | Passes when |
|---|---|---|
| `truthy` | — | The target is defined and truthy (not `false`, `0`, `""`, `[]`, `{}`, `null`). |
| `defined` | — | The target exists. |
| `undefined` | — | The target does not exist. |
| `pattern` | `match` and/or `notMatch` (regex) | A **string** target matches `match` / does not match `notMatch`. Non-string or absent targets pass — combine with `truthy`/`defined` to require presence. |
| `casing` | `type` (required), `disallowDigits` | A string target is `flat`, `camel`, `pascal`, `kebab`, `cobol`, `snake` or `macro` case. |
| `enumeration` | `values` (required) | The target equals one of `values` (scalars only). |
| `length` | `min` and/or `max` | Strings/arrays/objects: their length is within bounds. Numbers: the value itself is within bounds (Spectral semantics). |

JS-function custom rules (Spectral's `functions:` directory) are **not** supported. An existing
`.spectral.yaml` does not have to be re-authored by hand, though: `POST
/v1/lint/custom-rules/import` translates one onto this subset and reports every rule it could
not map, with a reason each — see [spectral-import.md](spectral-import.md).

## Validation: actionable errors with pointers

`POST /v1/lint/custom-rules/validate` accepts `{"yaml": "<document>"}`. A well-formed guide
returns the parsed rules (the exact shape stored in `style_guide_rules.custom_def`). Anything
malformed returns **HTTP 422** whose `detail` carries a `message` and a `pointer` to the
offending YAML node:

```json
{
  "detail": {
    "message": "'match' is not a valid regular expression: missing ), unterminated subpattern at position 0",
    "pointer": "rules.broken.then.functionOptions.match"
  }
}
```

Strictness is deliberate: unknown keys anywhere, duplicate rule ids, invalid regexes/JSONPath,
wrong option types, and out-of-range cardinalities (max 200 rules per guide, 10 `given` / 10
`then` per rule) are all rejected at authoring time, never at lint time.

## Sandboxed evaluation

Rule authors control two potentially explosive inputs, so evaluation is sandboxed:

- **Regexes** run through the `regex` engine with a hard per-match timeout (re2-style bound), so
  catastrophic backtracking (`(a|aa)+$`) cannot hang the service. Pattern length is capped, and
  the JSONPath filter operator `=~` is rejected (its regexes would bypass the timeout).
- **JSONPath** evaluation spends from a fixed per-rule node budget; adversarial expressions such
  as `$..*..*..*` (cost exponential in the number of `..` operators) abort deterministically
  instead of hanging. Expression length and the number of `..` operators are also capped.

A rule that trips the sandbox is aborted and reported per rule; the rest of the guide still
evaluates.

## JSONPath notes

- `[*]` iterates **object properties and array items** (Spectral semantics), so
  `$.paths[*][*]` selects every operation and findings carry real key paths
  (`paths./pets/{id}.get`).
- Filters are supported: `$.paths[*][*].parameters[?(@.in == 'path')]`.
- Finding paths are dotted, with `[i]` for array positions — the same style built-in lint
  findings use.

## Related

- [lint-rules.md](lint-rules.md) — the built-in rule catalog custom ids may not shadow
- [spectral-import.md](spectral-import.md) — importing an existing `.spectral.yaml` onto this DSL
- [lint-and-quality.md](lint-and-quality.md) — the lint/scoring surface style guides plug into
