# Scale corpus and import/export performance budgets (IXH-1.5)

Nothing in the committed example corpus approaches the size of the specs teams actually
hold — a multi-megabyte OpenAPI document, a registry snapshot with nine hundred record
types, an EDI interchange carrying fifteen hundred transaction sets. Import and export
timings at that size were therefore unmeasured, and a regression in normalization or
fidelity analysis would have shipped unnoticed.

This is the scale tier and the benchmark harness that gates it.

## What it measures

One generated document per paradigm is driven through the ten stages the import and
export pipelines are actually built from, and each stage's wall-clock and peak memory is
recorded:

| Half | Stages |
| --- | --- |
| Import | `parse` → `normalize` → `fingerprint` → `lint` → `persist` |
| Export | `load-source` → `analyze-fidelity` → `emit` → `validate` → `package` |

Every stage calls the same function the running pipeline calls, so a regression in the
product is a regression here. Two need a note, because in production they straddle the
database:

- **`persist`** measures `import_source_pipeline.scrub_intake_source` — the source
  capture and secret scrub `persist_adapter_import` performs over the whole document
  before it writes anything. The row write itself is excluded: its cost belongs to
  Postgres, varies with the machine, and cannot be attributed to a code change, which is
  the only thing this suite exists to catch.
- **`load-source`** measures `catalog_conversion.build_conversion_source` over the item
  dict a revision row projects into — the entire CPU half of
  `export_source.load_export_source` (re-parse plus re-normalize the captured source).
  Only the single row fetch is left out.

### How memory is measured

Per stage, the figure is the `tracemalloc` peak: the high-water mark of Python
allocations made *by that stage*, which is attributable and comparable across runs. The
process-wide peak RSS (`resource.getrusage`) is recorded once per fixture as
`process_peak_rss_bytes`; it is a monotonic high-water mark for the whole process, so it
cannot be split per stage — it is reported for context (and for IXH-6.5, which sizes its
per-job ceiling from these numbers) rather than budgeted.

## The corpus

`scripts/generate_scale_corpus.py` is the committed spec and builder set. The documents
themselves are **not committed** — building them at test time keeps repository size flat,
the same rule IXH-1.4 established for the large adversarial fixtures.

| Fixture | Paradigm | Adapter | Export target | Shape |
| --- | --- | --- | --- | --- |
| `rest-openapi-large.json` | `rest` | `openapi` | `openapi-3.1` | 550 paths, 380 component schemas |
| `rpc-openrpc-large.json` | `rpc` | `openrpc` | `openrpc` | 1500 methods over 400 payload schemas |
| `event-cloudevents-large.json` | `event` | `cloudevents` | `cloudevents` | one envelope, 15000-attribute payload |
| `data-schema-avro-registry.avsc` | `data_schema` | `avro` | `avro` | 900 nested record types |
| `message-edi-x12-interchange.edi` | `message` | `edix12` | `edix12` | 1500 X12 850 transaction sets |
| `mainframe-cobol-copybook-large.cpy` | `data_schema` | `cobolcopybook` | `cobolcopybook` | 7500 elementary items |

Every builder is deterministic — the same spec always produces byte-identical output, so
a failure is reproducible from the fixture name alone — and every document is a **valid**
instance of its format, sized below the 10 MiB `maxDocumentBytes` intake ceiling
(`src/app/data/oas_resource_limits.json`). A document the guards reject never reaches the
stages being measured, and a broken document would measure error handling instead of
parsing.

The spec deliberately uses only adapters with no `required_tools`. A tool-gated adapter
(`buf` for protobuf, `asyncapi-parser` for AsyncAPI) would skip wherever the toolchain is
absent, quietly dropping a paradigm from the tier; `tests/test_scale_harness.py` asserts
this.

Build the documents by hand with:

```bash
python3 scripts/generate_scale_corpus.py --list
python3 scripts/generate_scale_corpus.py --out-dir /tmp/scale
```

## Budgets and the regression margin

`apiome-rest/tests/scale/scale_budgets.json` is the single committed place a baseline
lives. It carries the policy and one block per fixture:

```jsonc
{
  "budget_version": 1,
  "regression_margin": 1.6,      // wall-clock multiplier a stage may drift by
  "memory_margin": 1.5,          // peak-memory multiplier
  "wall_floor_ms": 100.0,        // absolute noise floor before a ratio counts
  "peak_floor_bytes": 16777216,
  "measured_on": { "python": "…", "platform": "…", "machine": "…", "cpu_count": 20 },
  "fixtures": {
    "rest-openapi-large.json": {
      "paradigm": "rest",
      "source_bytes": 1545684,
      "stages": { "parse": { "wall_ms": 2415.4, "peak_bytes": 6198983 }, "…": {} }
    }
  }
}
```

A stage fails only when it is **both** over `baseline × margin` **and** over the noise
floor. That pairing is deliberate: a 2 ms stage going to 6 ms is a 3x ratio and utterly
meaningless, and a suite that fails on scheduler jitter is ignored within a week — while a
30 % slowdown of a two-second stage still fails.

Two escape hatches sit beside it:

- `SCALE_REGRESSION_MARGIN` / `SCALE_MEMORY_MARGIN` override the margins for one run (a
  value below `1.0` is rejected — that is a typo, not a policy).
- **Absolute ceilings** (180 s and 1 GiB per stage) fail regardless of any baseline, so a
  hang or a memory explosion is caught on a fresh checkout or a new runner that has no
  usable numbers.

Because `measured_on` records the machine, a reviewer seeing the runner change knows why
the numbers moved. Refresh the baseline on the machine that will run it.

### Why the budgets are not in `corpus.manifest.json`

The corpus manifest is keyed by files **on disk**: `test_corpus_manifest.py` checks
completeness in both directions, so an entry without a file fails and a file without an
entry fails. The scale documents are generated at test time and never committed, so they
cannot be manifest entries — the same reason the large IXH-1.4 adversarial fixtures live in
their generator's spec rather than the manifest. `scale_budgets.json` is therefore the
scale tier's manifest: one committed file, keyed by the generator spec's fixture names,
which `test_scale_harness.py` holds to exactly that key set. The examples README points at
it so the corpus documentation still leads a reader to the tier.

## Running it

The suite is **opt-in**: it runs about a minute of real pipeline work per fixture and
allocates hundreds of megabytes.

```bash
# locally, either form
RUN_SCALE_SUITE=1 uv run pytest tests/test_scale_corpus.py
uv run pytest tests/test_scale_corpus.py --scale

# refresh the committed baseline (one command, one file)
RUN_SCALE_SUITE=1 uv run pytest tests/test_scale_corpus.py --update-scale-budgets
```

In CI it is **scheduled, not per-PR** — `.github/workflows/apiome-rest-scale.yml` runs it
weekly and on manual dispatch (which can also override the margins or refresh the
baseline and upload it as an artifact).

The per-PR gate is `tests/test_scale_harness.py`, which runs in the normal suite and keeps
the machinery honest between scheduled runs: that the spec covers every paradigm with
runnable adapters, that the committed baseline covers exactly the spec's fixtures and all
ten stages with a policy that could actually fail a build, and that the comparison rules
behave (over the margin fails, under it passes, sub-floor noise is suppressed).

## The report artifact

Every run writes a machine-readable report to `apiome-rest/reports/scale-benchmark.json`
(override with `SCALE_REPORT_PATH`; the directory is git-ignored). The scheduled workflow
uploads it and renders a per-stage table into the job summary.

```jsonc
{
  "report_version": 1,
  "generated_at": "2026-08-02T03:46:45+00:00",
  "environment": { "python": "3.14.4", "platform": "…", "cpu_count": 20 },
  "policy": { "regression_margin": 1.6, "absolute_stage_seconds": 180.0, "…": {} },
  "totals": { "fixtures": 6, "stages": 10, "wall_ms": 56621.7, "peak_rss_bytes": 555728896 },
  "fixtures": [
    {
      "name": "rest-openapi-large.json",
      "detail": { "types": 380, "operations": 550, "fidelity_tier": "lossless", "…": {} },
      "stages": {
        "parse": {
          "wall_ms": 2361.1,
          "peak_bytes": 6198983,
          "budget": { "wall_ms": 2415.4, "peak_bytes": 6198983 },
          "wall_ratio": 0.98,
          "peak_ratio": 1.0
        }
      }
    }
  ],
  "regressions": [], "breaches": [], "problems": [], "passed": true
}
```

Stage keys are written in pipeline order (not sorted), because the point of the artifact
is to read a document's journey in the order it takes. The committed budget file sorts
instead — there the priority is a reviewable diff.

`detail` is what makes a timing interpretable: the entity counts the import produced, the
fidelity tier, how many files the export emitted, and whether the emitted artifact
re-validated.

## What the first measurements say

Taken on a 20-core x86-64 Linux workstation; treat the shape, not the absolute numbers, as
the signal.

- **`analyze-fidelity` is the memory hot spot.** The 900-type Avro snapshot peaks at
  ~265 MiB in fidelity analysis alone — roughly 300 KiB per canonical type. That is the
  number IXH-6.5 should size its per-job memory ceiling from, and the stage to watch.
- **`validate` dominates the OpenAPI export.** Re-importing and diffing the emitted
  document costs ~15 s for a 1.5 MiB spec, an order of magnitude more than emitting it.
- **`load-source` is a full re-parse.** Exporting a revision costs about what importing it
  did, because the canonical model is rebuilt from the captured source rather than stored.
- **`persist` is dominated by the secret scrub**, which walks the whole document: ~0.5 s
  per 1.5 MiB, and flat in memory.

## Adding a fixture

1. Add a builder and a `ScaleFixture` entry to `scripts/generate_scale_corpus.py`. Keep it
   deterministic, valid, under 10 MiB, and on an adapter with no `required_tools`.
2. Refresh the baseline: `RUN_SCALE_SUITE=1 uv run pytest tests/test_scale_corpus.py
   --update-scale-budgets`.
3. Commit the new `scale_budgets.json`. A fixture with no budget fails the suite rather
   than passing silently, and a budget whose fixture left the spec fails as stale.
