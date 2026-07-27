# Built-in lint rules

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: cd apiome-rest && uv run python scripts/generate_lint_rule_docs.py -->

Reference for every built-in lint rule in the rule-catalog registry (GOV-1.2). Each rule's
**id is stable** — it is exactly the string lint findings carry in their `rule` field, so a
violation always links back to the rule documented here. The **default severity** is what the
rule applies when no style guide overrides it.

Blocking (`error`) rules additionally publish reference, remediation, false-positive guidance,
fixture id, and scan-mode requirements (CLX-4.3 / #4861). See
[scanner evaluation](../../apiome-rest/docs/scanner_evaluation.md).

Fetch this catalog programmatically with `GET /v1/lint/rules` (see
[lint-and-quality.md](lint-and-quality.md)).


## Pack: `arazzo`

<a id="arazzo-dangling-operation-id"></a>
### `arazzo.dangling-operation-id`

- **Category:** reference
- **Default severity:** error
- **Rationale:** Step operationId must resolve to an embedded sourceDescription.
- **Reference:** https://github.com/apiome/apiome/blob/main/docs/guide/lint-rules.md#arazzo-dangling-operation-id
- **Remediation:** Point the step's operationId at an operation declared in an embedded OpenAPI sourceDescription, or remove the step.
- **False-positive guidance:** Only false if the engine cannot see an operation that exists only in an external (non-embedded) source — embed the description or switch to operationRef.
- **Fixture:** `catalog/arazzo-dangling-operation-id`
- **Scan modes:** `lint`

<a id="arazzo-missing-success-criteria"></a>
### `arazzo.missing-success-criteria`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** Every workflow step should declare successCriteria.

<a id="arazzo-unused-workflow-input"></a>
### `arazzo.unused-workflow-input`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** Workflow inputs should be referenced by at least one step.

<a id="arzzo-unresolvable-operation-ref"></a>
### `arzzo.unresolvable-operation-ref`

- **Category:** reference
- **Default severity:** error
- **Rationale:** Step operationRef must point at a declared sourceDescription.
- **Reference:** https://github.com/apiome/apiome/blob/main/docs/guide/lint-rules.md#arzzo-unresolvable-operation-ref
- **Remediation:** Use a local JSON Pointer under #/sourceDescriptions/<name>/… for a declared source, or fix the sourceDescription name.
- **False-positive guidance:** External HTTP operationRef targets are out of scope for static resolution — prefer embedded sources for gateable workflows.
- **Fixture:** `catalog/arzzo-unresolvable-operation-ref`
- **Scan modes:** `lint`


## Pack: `asyncapi`

<a id="asyncapi-message-missing-name"></a>
### `asyncapi.message-missing-name`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** Every event message should carry an author-given name.

<a id="asyncapi-message-missing-payload"></a>
### `asyncapi.message-missing-payload`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** Every event message should declare a payload schema.

<a id="asyncapi-message-unstable-name"></a>
### `asyncapi.message-unstable-name`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** Message names should be author-chosen, not generator output.

<a id="asyncapi-server-missing-protocol"></a>
### `asyncapi.server-missing-protocol`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** Every server should declare its transport protocol.

<a id="asyncapi-server-missing-security"></a>
### `asyncapi.server-missing-security`

- **Category:** structure
- **Default severity:** info
- **Rationale:** Servers should usually declare a security scheme.


## Pack: `common`

<a id="common-api-missing-description"></a>
### `common.api-missing-description`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** The API artifact should carry a top-level description.

<a id="common-channel-missing-description"></a>
### `common.channel-missing-description`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** Every event channel should describe itself.

<a id="common-field-missing-description"></a>
### `common.field-missing-description`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** Every field should describe itself.

<a id="common-message-missing-description"></a>
### `common.message-missing-description`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** Every message payload should describe itself.

<a id="common-operation-missing-description"></a>
### `common.operation-missing-description`

- **Category:** documentation
- **Default severity:** warning
- **Rationale:** Every operation should describe what it does.

<a id="common-type-missing-description"></a>
### `common.type-missing-description`

- **Category:** documentation
- **Default severity:** warning
- **Rationale:** Every named type should describe itself.

<a id="common-unstable-field-name"></a>
### `common.unstable-field-name`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** Field names should be author-chosen, not generator output.

<a id="common-unstable-type-name"></a>
### `common.unstable-type-name`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** Type names should be author-chosen, not generator output.


## Pack: `examples`

<a id="examples-non-conforming-example"></a>
### `examples.non-conforming-example`

- **Category:** validation
- **Default severity:** warning
- **Rationale:** An example that does not satisfy its own schema ships a payload consumers cannot use — docs render it, mocks replay it, and generated clients seed fixtures from it.


## Pack: `graphql`

<a id="graphql-argument-missing-description"></a>
### `graphql.argument-missing-description`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** Every operation argument should describe itself.

<a id="graphql-enum-value-missing-description"></a>
### `graphql.enum-value-missing-description`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** Every enum value should describe itself.

<a id="graphql-naming-argument-camel-case"></a>
### `graphql.naming-argument-camel-case`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** Operation arguments should be camelCase.

<a id="graphql-naming-enum-value-upper-case"></a>
### `graphql.naming-enum-value-upper-case`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** Enum values should be UPPER_CASE.

<a id="graphql-naming-field-camel-case"></a>
### `graphql.naming-field-camel-case`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** Fields and operations should be camelCase.

<a id="graphql-naming-type-pascal-case"></a>
### `graphql.naming-type-pascal-case`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** Type definitions should be PascalCase.

<a id="graphql-require-deprecation-reason"></a>
### `graphql.require-deprecation-reason`

- **Category:** documentation
- **Default severity:** warning
- **Rationale:** A @deprecated entity should carry a deprecation reason.


## Pack: `intake`

<a id="intake-blocked-external-ref"></a>
### `intake.blocked-external-ref`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** An external $ref pointing at a non-public address (loopback, RFC1918, link-local, or the cloud metadata endpoint) or at a non-HTTP scheme is refused by the SSRF guard and is never fetched. Publish the referenced document at a public HTTPS URL, or bundle it into the import instead of referencing it.

<a id="intake-unresolved-external-ref"></a>
### `intake.unresolved-external-ref`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** An external $ref that is never resolved leaves the imported model incomplete: the referenced messages, schemas, or types are missing from every downstream view (diff, lint, export) with no indication that anything was dropped. Enable remote $ref resolution for the import, bundle the referenced documents into the upload, or inline the definitions in the source document.


## Pack: `k8s-crd`

<a id="k8s-crd-required-field-hygiene"></a>
### `k8s-crd.required-field-hygiene`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** Flag required lists with missing, duplicate, or undescribed fields.

<a id="k8s-crd-structural-schema-pruning"></a>
### `k8s-crd.structural-schema-pruning`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** Flag non-structural JSON Schema keywords and preserve-unknown-fields hygiene issues that affect Kubernetes pruning.


## Pack: `llm-tools`

<a id="llm-tools-duplicate-tool-name"></a>
### `llm-tools.duplicate-tool-name`

- **Category:** naming
- **Default severity:** error
- **Rationale:** Flag colliding tool names within a bundle.

<a id="llm-tools-param-missing-description"></a>
### `llm-tools.param-missing-description`

- **Category:** quality
- **Default severity:** warning
- **Rationale:** Flag parameters without descriptions.

<a id="llm-tools-prefer-enum-over-freetext"></a>
### `llm-tools.prefer-enum-over-freetext`

- **Category:** quality
- **Default severity:** info
- **Rationale:** Flag free-text parameters that look enumerable.

<a id="llm-tools-required-field-hygiene"></a>
### `llm-tools.required-field-hygiene`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** Flag required lists with missing or duplicate names.

<a id="llm-tools-tool-missing-description"></a>
### `llm-tools.tool-missing-description`

- **Category:** quality
- **Default severity:** warning
- **Rationale:** Flag tools with no description.

<a id="llm-tools-tool-weak-description"></a>
### `llm-tools.tool-weak-description`

- **Category:** quality
- **Default severity:** info
- **Rationale:** Flag tools whose description is too short or equals the name.


## Pack: `openapi`

<a id="compatibility-breaking"></a>
### `compatibility.breaking`

- **Category:** compatibility
- **Default severity:** error
- **Rationale:** A change relative to the base revision breaks existing consumers.
- **Reference:** https://github.com/apiome/apiome/blob/main/docs/guide/lint-rules.md#compatibility-breaking
- **Remediation:** Restore the removed/changed contract surface, introduce a new path or version, or deliberately gate with a documented breaking-change process.
- **False-positive guidance:** Diff noise from reorder-only or documentation-only revisions should not appear; if it does, file a scanner bug with the base/head pair.
- **Fixture:** `catalog/compatibility-breaking`
- **Scan modes:** `breaking`, `lint`

<a id="compatibility-unknown"></a>
### `compatibility.unknown`

- **Category:** compatibility
- **Default severity:** warning
- **Rationale:** A change relative to the base revision has an unclassified compatibility impact.

<a id="documentation-info-missing-description"></a>
### `documentation.info-missing-description`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** The API info block should describe what the API is for.

<a id="documentation-operation-missing-summary"></a>
### `documentation.operation-missing-summary`

- **Category:** documentation
- **Default severity:** warning
- **Rationale:** An operation needs a summary or description to produce usable reference docs.

<a id="documentation-property-missing-description"></a>
### `documentation.property-missing-description`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** Every property should describe what it holds.

<a id="documentation-property-missing-example"></a>
### `documentation.property-missing-example`

- **Category:** documentation
- **Default severity:** info
- **Rationale:** Scalar leaf properties should carry an example so docs and mocks stay realistic.

<a id="documentation-schema-missing-description"></a>
### `documentation.schema-missing-description`

- **Category:** documentation
- **Default severity:** warning
- **Rationale:** A schema without a description forces consumers to guess what it models.

<a id="naming-property-name"></a>
### `naming.property-name`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** Property names should be camelCase or snake_case for predictable client bindings.

<a id="naming-schema-pascal-case"></a>
### `naming.schema-pascal-case`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** Component schema names should be PascalCase so generated client types are idiomatic.

<a id="structure-unbounded-array"></a>
### `structure.unbounded-array`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** An array without maxItems permits unbounded payloads that strain clients and servers.


## Pack: `protobuf`

<a id="protobuf-field-no-required"></a>
### `protobuf.field-no-required`

- **Category:** structure
- **Default severity:** warning
- **Rationale:** Fields should not be 'required'.

<a id="protobuf-package-version-suffix"></a>
### `protobuf.package-version-suffix`

- **Category:** naming
- **Default severity:** warning
- **Rationale:** A package should carry a version suffix (foo.v1).

<a id="protobuf-reserved-on-deletion"></a>
### `protobuf.reserved-on-deletion`

- **Category:** structure
- **Default severity:** info
- **Rationale:** Removed field/value numbers should be reserved, not left as gaps.
