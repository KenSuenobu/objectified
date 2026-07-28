# Source-Format Capability & Parsing-Limit Registry (CPDO-2.4)

> apiome#4796 — child of CPDO-EPIC-2 (#4791). Depends on CPDO-1.1 (#4794) for the
> analysis contract and CPDO-1.2 (#4795) for the per-record analyzer capability
> declaration. Consumed by the format-detail surfaces (CPDO-2.1 #4797, X12
> inspector #4798, copybook inspector #4799).
>
> The export-side mirror of this registry is
> [`app/capability_registry.py`](../src/app/capability_registry.py) (EFP-1.2),
> which does the same job for *destinations*.

## Why

"No details" is one sentence covering five unrelated situations:

1. the format has no native analyzer at all;
2. no source bytes were captured for the revision;
3. the parser met a grammar it does not read, or ran out of node budget;
4. a value-visibility policy withheld the value; or
5. the construct genuinely is not in the source.

Only (2) and (5) say anything about the customer's data — and they say opposite
things. Reporting (1), (3) or (4) as though the source were missing is a lie
about the customer's payload, and it is the specific failure this registry
exists to remove.

CPDO-1.1 gave a stored analysis a status and a closed reason code. CPDO-1.2 gave
each record the analyzer's own `AnalyzerCapabilities`. Both describe **one
revision that was actually analysed**. Neither answers the question a reader asks
*before* — or *instead of* — reading a record: *what can apiome ever tell me
about this format, and what will it never tell me?*

## Modules

| Module | Role |
|---|---|
| `app/format_capability_registry.py` | The registry: vocabulary, models, reviewed seeds, adapter-derived fallbacks, absence explanations, snapshot. Pure; no I/O. |
| `app/import_sources_routes.py` | `GET /v1/import/format-capabilities` (snapshot) and `GET /v1/import/format-capabilities/{format_key}` (one entry). |
| `scripts/format_capabilities/vocabulary.json` | The language-neutral vocabulary both language mirrors are asserted against. |
| `apiome-ui/.../catalog/formatCapabilityRegistry.ts` | The TypeScript mirror plus the UI's pure guards. |
| `apiome-ui/.../catalog/FormatCapabilityPanel.tsx` | The accessible rendering of one entry. |
| `apiome-ui/.../catalog/useFormatCapabilities.ts` | Loads and contract-validates the snapshot; one fetch per page load. |

## What an entry says

Each `FormatCapability` answers six questions about one source format, and
carries the evidence backing them.

| Field | Question it answers |
|---|---|
| `native_hierarchy` | Does the analysis tree keep this format's own structure (`native`), only the format-blind object/array/scalar walk (`generic`), or nothing (`none`)? |
| `source_location` | What is the best pointer a node can carry — `byte_offsets`, `line_numbers`, `path_only`, or `none`? A path-only analyzer must never be rendered as if it knew a line. |
| `value_visibility` | The `default` policy, and the `maximum` the *analyzer* can ever supply. A COBOL copybook is a layout, not data, so its ceiling is `none` — there is nothing to withhold. |
| `unsupported_constructs` | The grammar it knowingly does not read. An entry here is a capability boundary, never a defect in the source. |
| `canonical_projection` | How much of what it observes survives normalization onto the canonical model, and which reviewed constructs do not. |
| `conversion` | Whether the format participates in the conversion graph, and by which route. |

Plus `analyzer` — key, version, and the underlying parser/library versions — so a
claim is checkable rather than asserted. `x12.composite_elements are modelled` is
only meaningful if the reader knows *which* extractor, at *which* version, over
*which* `pyx12` release.

## Every format resolves — the safe fallback

`capability_for(key)` never returns nothing:

| Provenance | When | What it claims |
|---|---|---|
| `reviewed` | A hand-checked seed exists (`edix12`, `cobolcopybook`). | Everything, including projection coverage and reviewed boundary notes. |
| `derived` | Any other registered adapter. | Only what the adapter itself declares — analyzer identity, construct lists, limits, normalizer routes — with pessimistic defaults (`projection = unknown`, `source_location = path_only`) wherever it does not say. |
| `unknown_format` | No adapter is registered under the key. | Nothing. The entry exists so a catalog item naming a retired adapter still renders an explanation instead of a dead end. |

Even a reviewed entry reads its analyzer identity, construct lists, limits and
conversion route off the **live adapter** on every call, so a seed can go stale
only about the judgements a person made, never about what the code does.

An arbitrary caller-supplied string is validated (`FORMAT_KEY_PATTERN`) before it
is echoed into an entry; the REST endpoint answers **422** for a key that could
never have been registered, and **200** with `unknown_format` for one that simply
is not registered *now*.

## Absence has a closed vocabulary

`AbsenceCategory` names the eight ways a detail can be missing, each with one
reviewed `AbsenceExplanation` (label, `{construct}`-slotted summary, remediation).

| Category | Means | `source_missing` |
|---|---|---|
| `source_missing` | No source material was captured for the revision. | **true** |
| `not_analyzed` | Legacy revision, or the analyzer has not run yet. | false |
| `format_unsupported` | No analyzer for this format. | false |
| `parse_limit` | The analyzer read the source and cannot describe this part — budget or grammar. | false |
| `analyzer_failed` | The analyzer raised. | false |
| `value_redacted` | A value-visibility policy withheld the value. | false |
| `absent_in_source` | The analyzer models it and did not observe it. | false |
| `undeclared` | The registry makes no statement; the absence is evidence of nothing. | false |

Two functions are the only ways to phrase an absence:

- `explain_analysis_absence(status=…, reason=…)` maps a stored CPDO-1.1 status +
  reason code onto its category. An unrecognised reason code, or a non-available
  status carrying no reason, resolves to `not_analyzed` — never to anything that
  claims more than is known.
- `explain_construct(format_key, construct)` resolves "the tree has no node for
  this" onto `absent_in_source` (modelled), `parse_limit` (declared unmodelled),
  or `undeclared`. **Its `source_missing` is always false**: a construct's
  absence from an analysis is never evidence that the source was not captured.

That table is the machine-checkable form of the ticket's *"the UI never reports
unparsed data as source-missing"*. It is enforced three times — in the Python
registry, on the wire by `validateFormatCapabilitySnapshot` (which refuses a
snapshot flagging any other category), and in the panel, which gates its "no
source material was captured" line on the flag rather than on the status.

## REST

```
GET /v1/import/format-capabilities
GET /v1/import/format-capabilities/{format_key}
```

Both are non-tenant registry metadata: authenticated (`validate_session_credentials`,
as for `/v1/import/sources`) but unscoped, since there is no `{tenant_slug}` path
segment. The snapshot is deterministic and source-independent, so the UI fetches it
once per page load and caches it by `version`.

## Contract tests, and changing the registry

The language-neutral vocabulary lives at
`scripts/format_capabilities/vocabulary.json`. Both sides are asserted against it:

- `apiome-rest/tests/test_format_capability_registry.py` for the Python registry;
- `apiome-ui/tests/format-capability-registry.test.ts` for the TypeScript mirror.

A change landing in one language and not the other turns a suite red.

**To change the registry:**

1. Edit `app/format_capability_registry.py` (a vocabulary member, a seed, an
   absence explanation).
2. Bump `REGISTRY_VERSION` and `REVIEW_DATE` together.
3. Update `scripts/format_capabilities/vocabulary.json` to match.
4. Mirror any vocabulary change in `formatCapabilityRegistry.ts`.
5. Run both suites.

`source_missing` must stay true on exactly one row. Both suites assert it
independently, including against the committed snapshot itself.

## Reviewed boundaries

### EDI X12 (`edix12`)

Native interchange → functional group → transaction set → segment → element, with
composites regrouped under their element position. Locates by envelope path and
ordinal only — the parser exposes no byte offsets, so a UI may highlight a segment
by position but must not claim a byte range. Element values *are* observed, so the
value ceiling is `full` and the stored record carries whatever the policy in force
allows.

Normalization reads the **first functional group's first transaction set**, so the
envelope, delimiters, control numbers and segment ordinals survive only in the
analysis. Not read at all: HL hierarchy, repeating-element separators, TA1/IEA
trailers, and any implementation-guide conformance. A present-but-empty element and
an absent one arrive from the parser identically, so neither is ever asserted.

### COBOL copybook (`cobolcopybook`)

Native record → group → field → 88-condition, with level numbers, PICTURE, USAGE and
OCCURS bounds, and the 1-based source line each was declared on (matched in traversal
order, so a repeated `FILLER` resolves to its own line). A name that cannot be placed
carries no line rather than a guessed one.

The value ceiling is **`none`**: a copybook is a layout, not data — there are no
runtime values to observe at any policy level, so "no value here" is the absence of
data, not a redaction. `test_copybook_value_ceiling_matches_what_its_analyzer_can_produce`
checks that claim against the analyzer that would have to produce them.

The canonical model keeps a field's name and inferred type; everything that makes a
copybook a layout survives only in the analysis. REDEFINES, level-66 RENAMES and
`COPY … REPLACING` are not read by the parser — they are found by scanning the source,
and each one found makes the record partial with a stated reason.
