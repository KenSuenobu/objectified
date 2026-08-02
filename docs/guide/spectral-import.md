# Importing a Spectral ruleset

> **GOV-1.5 (#4431).** Teams migrating from Stoplight/Redocly arrive with a `.spectral.yaml`
> that encodes years of org standards. `POST /v1/lint/custom-rules/import` reads that file (or
> fetches it from a URL) and translates it into Apiome governance state: built-in rule
> overrides, [custom rules](custom-rules.md), and an itemized list of everything it could not
> translate — with a reason per rule.

## The call

```bash
curl -X POST https://<host>/v1/lint/custom-rules/import \
  -H 'Content-Type: application/json' \
  -d '{"content": "<the .spectral.yaml text>", "sourceLabel": "org.spectral.yaml"}'
```

Supply exactly one source:

| Field | Meaning |
|---|---|
| `content` | The document text — a paste, or the body of an uploaded `.spectral.yaml`. |
| `url` | An http/https URL to fetch it from. Fetching goes through the SSRF guard (private/metadata addresses are refused, redirects are re-validated) and is capped at 256 KiB. |
| `sourceLabel` | Optional human label (e.g. the uploaded filename), echoed back. |

**Nothing is persisted.** The response is a translation you review, then store:

```
yaml         ->  PUT /v1/style-guides/{tenantSlug}/{guideId}/custom-rules
builtinRules ->  PUT /v1/style-guides/{tenantSlug}/{guideId}/rules
```

## What the response says

```json
{
  "sourceLabel": "org.spectral.yaml",
  "ruleCount": 27, "mappedCount": 22, "unsupportedCount": 5, "coverage": 0.8148,
  "customRuleCount": 19,
  "yaml": "rules:\n  must-use-snake-case-property-names:\n    ...",
  "builtinRules": [
    {"ruleId": "documentation.info-missing-description", "enabled": true,
     "severity": "error", "sourceRuleId": "info-description"}
  ],
  "entries": [
    {"sourceRuleId": "info-description", "outcome": "builtin",
     "builtinRuleIds": ["documentation.info-missing-description"], "severity": "error",
     "enabled": true, "notes": []},
    {"sourceRuleId": "must-support-idempotency-keys", "outcome": "unsupported",
     "reason": "js_function",
     "detail": "'checkIdempotencyKey' is a JavaScript function from the ruleset's 'functions' list; custom code cannot be imported",
     "pointer": "rules.must-support-idempotency-keys.then.function"}
  ],
  "extends": [{"target": "spectral:oas", "supported": true, "mappedRuleCount": 5}],
  "notes": ["top-level 'overrides' ... was ignored"]
}
```

Every `rules.<id>` entry of the source lands in exactly one **outcome**, so the report accounts
for the whole document:

| Outcome | Meaning |
|---|---|
| `custom` | Translated into the custom-rule DSL. `ruleId` is the id it imported as. |
| `builtin` | Resolved onto one or more built-in rules (`builtinRuleIds`). |
| `unsupported` | Not translated — `reason`, `detail`, and (for DSL rejections) `pointer` say why. |

`coverage` is `mappedCount / ruleCount`.

## What maps

### `extends: spectral:oas`

Spectral's bundled OpenAPI ruleset is mapped onto the [built-in rule catalog](lint-rules.md).
The rules with an Apiome equivalent:

| `spectral:oas` rule | Apiome built-in rules |
|---|---|
| `info-description` | `documentation.info-missing-description`, `common.api-missing-description` |
| `operation-description` | `documentation.operation-missing-summary`, `common.operation-missing-description` |
| `oas2-valid-media-example`, `oas2-valid-schema-example`, `oas3-valid-media-example`, `oas3-valid-schema-example` | `examples.non-conforming-example` |

Extending the ruleset turns those built-ins on at their registry defaults;
`extends: [[spectral:oas, off]]` inherits them disabled. Any other `extends` target — another
bundled ruleset, an npm package, a relative path, a URL — is reported in `extends` with
`unsupported_extends` and contributes no rules.

### Severity overrides

`rules: {info-description: error}` overrides an inherited rule. Spectral's severities map as
`error`/`warn`/`info` → `error`/`warning`/`info`, `hint` → `info` (Apiome has no lower
severity), `off`/`false` → the rule is stored disabled, `true` → keep the inherited severity.
Numeric severities (`0`–`3`, `-1` for off) work too.

> In YAML, the bare word `off` is the boolean `false` — which the importer treats identically.

### Custom rule definitions

A rule with `given`/`then` is translated into the [custom-rule DSL](custom-rules.md) and
validated by it, so anything the importer emits is guaranteed storable and evaluable. Rule ids
are folded to the DSL's id grammar (lowercase, `.`/`-`/`_` segments); an id that would shadow a
built-in is prefixed with `imported.`. Simple `aliases` (a list of JSONPaths) are inlined,
including `#Alias.suffix` references.

## What does not map — the reason codes

| `reason` | Meaning |
|---|---|
| `unsupported_extends` | The `extends` target is not a bundled ruleset the importer maps. |
| `unmapped_builtin` | A real `spectral:oas` rule with no Apiome equivalent (re-author it as a custom rule). |
| `unknown_rule` | A severity for a rule that is neither defined here nor inherited from a supported `extends`. |
| `js_function` | `then.function` resolves to custom JavaScript (declared in `functions`, or simply not a core function). |
| `unsupported_function` | A Spectral core function outside the supported six (`schema`, `alphabetical`, `xor`, `falsy`, `unreferencedReusableObject`). |
| `unsupported_severity` | The severity token is not one Spectral defines. |
| `invalid_definition` | The translated rule was rejected by the DSL — `detail` and `pointer` name the offending node (unsupported `functionOptions`, an invalid regex, a `=~` filter, …). |
| `malformed_rule` | The rule is not a definition or a severity (missing `given`/`then`, a `then` without a `function`, an unusable id). |
| `unknown_alias` | `given` references an alias the importer cannot inline (the format-scoped `targets` form). |
| `rule_limit` | Beyond the 200-rules-per-guide cap. |

## Lossy but successful: `notes`

A rule can import while losing something. Rather than fail it, the importer imports it and says
what it dropped, per rule in `entries[].notes` and per document in `notes`:

- a custom `message` template (findings use the rule description),
- a `formats` restriction (imported rules apply to every linted document),
- `resolved: false` (rules evaluate the resolved document),
- `severity: hint` (imported as `info`),
- `recommended: false` / `severity: off` (reported as `enabled: false` and **left out of
  `yaml`**, so applying the import never silently switches a rule on),
- a normalized rule id,
- top-level `overrides` (per-file rule targeting — assign a style guide per project instead),
  `parserOptions`, and unknown keys.

## Related

- [custom-rules.md](custom-rules.md) — the DSL imported rules land in
- [lint-rules.md](lint-rules.md) — the built-in rule catalog `extends` maps onto
- [lint-and-quality.md](lint-and-quality.md) — the lint/scoring surface style guides plug into
