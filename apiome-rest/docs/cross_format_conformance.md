# Cross-format instance conformance (canonical → target) — IXH-5.6

Structural fidelity (`app/lossiness.py`, `app/export_fidelity.py`) predicts which
constructs survive an emit. It does not answer the loss that actually breaks a consumer at
runtime: **does a payload that is valid against the source schema remain valid against the
emitted target schema?** `app/cross_format_conformance.py` answers that question
empirically.

## What one check does

1. Every RECORD entity is projected to its validator-safe JSON Schema
   (`build_type_json_schema`, IXH-5.1) and the IXH-5.2 synthesizer generates its
   **source-valid** instances — minimal, full, and branch instances only, verified against
   the source projection. Mutants are never used: cross-format conformance is about
   payloads that *should* survive.
2. The target schema is **actually emitted** through the registered emitter (no
   prediction).
3. Each instance is transcoded to the target's wire format where it differs
   (`app/conformance_transcoding.py`) and validated with the target's own validator.

## Validatable targets

| Emit format | Validator | Wire transcoding |
|---|---|---|
| `json-schema` | `validate_json_instance` (IXH-5.1) | none — instances are JSON |
| `avro` | `fastavro.validation.validate` (strict) | base64 text → `bytes` where the schema demands Avro binary |
| `proto3` | `buf` compile → `json_format.ParseDict` | the proto3 canonical JSON mapping |
| `graphql` | `graphql-core` input coercion | none — coerced as input values |
| `xsd` | `xmllint` via `validate_xml_instance` | canonical-model-driven JSON → XML mirroring the emitted grammar |

Every other registered target is reported **not applicable — never passing** (the report
says so explicitly). GraphQL checks the emitted *input* representation: the synthesized
`<Name>Input` type when present, otherwise a structural input mirror of the emitted output
type; a shape GraphQL cannot accept as input (a union member, a field with arguments) is
*skipped* with a reason.

The XSD path appends one global `<xs:element>` per checked entity to the emitted document
(`build_xsd_validation_harness`) because `xmllint` validates documents against global
element declarations only; the emitted types themselves are referenced untouched.

## Honesty contract

The verdict vocabulary mirrors `app/export_validation.py`:

* `applicable` — the target's schema language has an instance validator here;
* `validated` — the check actually ran (`False` with a reason when the emit failed, a
  toolchain is missing, or the emitted schema could not be loaded);
* `valid` — `True`/`False` only when instances were actually judged; `None` otherwise.

Failure rows carry `kind`:

* `conformance` — the emitted schema's validator rejected a source-valid instance;
  `constraint` names the target-side constraint that rejected it.
* `transcode` — the instance has no representation on the target wire, so the schema never
  judged it. Transcode failures are counted separately and never produce a pass **or** a
  fail.

An entity the emitted schema does not define at all is reported `missing` and counts as a
conformance failure — losing the whole entity is the strongest instance-level loss.

## Feeding the IXH-2.4 readiness rank

`POST /v1/tenants/{slug}/export/preflight` accepts `include_conformance: true`
(off by default — it emits every ranked target for real). The route then calls
`apply_instance_conformance`, which:

* attaches each target's `TargetConformance` beside its structural `fidelity` envelope;
* demotes a `ready` target to `caution` when its validator ran and rejected instances
  (band is the ranking's primary key, so the demotion re-orders the list);
* re-assigns ranks and recomputes `ranking_fingerprint`.

The readiness *score* stays the weighted prediction mix; transcode-only failures never
demote.

## Determinism and bounds

Entity order is sorted canonical-key order; synthesis is seeded (`seed` echoes in the
report); every list is emitted in stable order. Entity and per-entity instance counts are
capped (`DEFAULT_MAX_ENTITIES`, `DEFAULT_MAX_INSTANCES_PER_ENTITY`, with ceilings) and the
report says when the entity list was truncated — never a silent sample.

## Coverage

`tests/test_cross_format_conformance.py` covers each target's pass path, induced
conformance failures (dropped/renamed fields, narrowed scalars), the transcode/conformance
distinction, toolchain honesty, the pre-flight demotion, and — for the IXH-1.7 matrix axis
— a corpus sweep of every source-format representative × every production emit target
asserting the applicability split and that nothing passes without evidence.
