# Contributing to the import example corpus

`apiome-ui/examples/` is the import test corpus: every fixture the import pipeline is proven
against, from a three-line hello-world to a deliberately hostile document. It is governed by
[`corpus.manifest.json`](../apiome-ui/examples/corpus.manifest.json) (schema:
[`corpus.schema.json`](../apiome-ui/examples/corpus.schema.json)) — one entry per file, declaring
what the file demonstrates, what it must do on import, **and where it came from**.

This page is the contributor guide for adding to it: the ladder, the manifest fields, the licensing
rules for documents that came from somewhere else, the anonymization rule for captured payloads, and
the checklist a reviewer works through. The provenance and licensing rules here are enforced in CI by
[`scripts/check_corpus_provenance.py`](../scripts/check_corpus_provenance.py) — this document and
that script must always say the same thing.

> **Why this exists.** Real-world examples are the most valuable tier and the easiest to add
> carelessly. A third-party spec carries a license the repository must honor; a payload captured from
> a running system carries personal data that must never be committed. Both are cheap to get right at
> authoring time and expensive to unwind later.

---

## 1. Where things live

| Thing | Path |
|---|---|
| Fixture files | `apiome-ui/examples/<format>/…` |
| The contract | `apiome-ui/examples/corpus.manifest.json` |
| Its JSON Schema | `apiome-ui/examples/corpus.schema.json` |
| Generated human index | `apiome-ui/examples/README.md` (**do not hand-edit**) |
| README generator | `scripts/generate_examples_readme.py` |
| Provenance gate | `scripts/check_corpus_provenance.py` |
| Python loader | `apiome-rest/tests/corpus_loader.py` (`load_corpus(...)`) |
| TypeScript loader | `apiome-ui/lib/corpus/corpus.ts` (`loadCorpus(...)`) |

Any file named `README.md`, plus `corpus.manifest.json` and `corpus.schema.json`, may exist under
`apiome-ui/examples/` without being a corpus fixture — including a `README.md` **inside a format
directory**, which is the right place to document what that format is, which ticket its fixtures
serve, and what each file exercises. Everything else on disk needs a manifest entry, and every
manifest entry needs a file on disk — the completeness test checks both directions.

**Tests select fixtures by tag, never by path.** Use `load_corpus(format=…, feature=…, rung=…)` (or
`loadCorpus({ … })` from Jest) so renaming or reclassifying a file is a manifest edit rather than a
hunt through hard-coded paths.

---

## 1.1 Fixtures for a format that has no adapter yet

A format's corpus may be written **before** its adapter exists — that is the normal order when a
roadmap ticket is scoped, and it is what the FMT (format-matrix expansion) directories do. Such an
entry declares:

- `adapter_key: null` — no adapter is expected to claim the file yet. This is what keeps the fixture
  out of the live tier suites: `test_corpus_import.py`, `test_corpus_negative.py`,
  `test_corpus_golden.py` and `test_corpus_adversarial.py` all select entries **by adapter key**, so
  a null-keyed entry is inert until the adapter lands.
- the `pending-adapter` feature tag on every file, so the whole pending set is selectable with
  `load_corpus(feature="pending-adapter")`.
- a directory `label` ending `(pending #NNNN)`, naming the issue that will register the adapter — the
  generated README index then shows at a glance which formats are declared and which are live.
- `expected_detection.format` set to the key detection **will** report, at the confidence the ticket
  intends (`0` on negative entries, as usual). These are contracts to implement, not measurements.

**Do not** add a `rung_waivers` entry for a pending format: waivers are keyed by *registered*
adapter key, and one for an unknown key fails `test_rung_waivers_are_registered_and_not_stale`.

When the adapter lands, the ticket flips the set live: set `adapter_key`, drop the `pending-adapter`
tag and the `(pending …)` label suffix, re-ground `expected_detection` against real detection output,
add any needed `rung_waivers`, and record known deviations in `notes` / `KNOWN_DETECTION_BUGS` rather
than deleting the fixture.

---

## 2. Tiers and the depth ladder

Every entry has a **validity class** — which tier it belongs to:

| Class | Lives in | Means | Must |
|---|---|---|---|
| `valid` | `<format>/` | well-formed | import cleanly |
| `invalid` | `<format>/negative/` | malformed on purpose | be rejected with a useful, classified error |
| `adversarial` | `<format>/adversarial/` | crafted to exhaust or subvert intake | trip a named guard, never hang or crash |
| `scale` | *not committed* | very large | stay inside the performance budgets |

`scale` documents and the large `adversarial` ones are **generated at test time**
(`scripts/generate_scale_corpus.py`, `scripts/generate_adversarial_corpus.py`) rather than committed:
files that size would bloat the repository permanently.

Valid entries also sit on exactly one **ladder rung**, and every shipped adapter must cover all six
(or record a justification in the manifest's `rung_waivers`):

| Rung | What it is |
|---|---|
| `minimal` | the canonical hello-world for the format |
| `typical` | a realistic everyday service |
| `composition` | inheritance, `$ref`s, imports, includes |
| `stress` | the format's less common grammar |
| `real-world` | a public spec or a faithful reconstruction of one |
| `multi-file` | a set the adapter must import together (per-set subdirectory, one `root`) |

Standing floors, enforced by `apiome-rest/tests/test_corpus_manifest.py`: **≥ 6 valid** entries per
non-preview adapter, and **≥ 5 negative** entries spanning **≥ 5 distinct failure classes**.

The `real-world` rung is where provenance questions actually bite — see §4 and §5 before you copy
anything into it.

---

## 3. The manifest entry, field by field

```json
{
  "path": "openapi/12-orders-api.yaml",
  "format": "openapi",
  "adapter_key": "openapi",
  "validity_class": "valid",
  "expected_detection": { "format": "openapi-3.1", "min_confidence": 0.95 },
  "features": ["oneOf", "webhooks"],
  "expected_outcome": "imports",
  "source": "hand-authored",
  "license": "Apache-2.0",
  "provenance": "Authored in-repo for the apiome catalog import examples.",
  "rung": "typical"
}
```

| Field | Required | Notes |
|---|---|---|
| `path` | always | Relative to `apiome-ui/examples/`, POSIX separators. Entries stay path-sorted. |
| `format` | always | Format family key — the `load_corpus(format=…)` selector. |
| `adapter_key` | always | ImportSource registry key that must claim the file, or `null`. Note the registry key is not always the directory name (`protobuf/` → `grpc`, `swagger/` → `openapi`). |
| `validity_class` | always | See §2. |
| `expected_detection` | always | `{format, min_confidence}` — the detection contract. Ground it by actually running detection; record intent in the field and any current deviation in `notes`. |
| `features` | always | What the file demonstrates. Spec keywords keep native casing (`oneOf`); concepts are kebab-case (`occurs-depending-on`). Must match `^[A-Za-z0-9][A-Za-z0-9.$-]*$` — so use `defs`, not `$defs`. |
| `expected_outcome` | always | `imports` / `rejects` / `imports_with_warnings`. |
| `source` | always | The reserved literal `hand-authored`, or the name of the upstream project / capturing system. |
| `license` | always | SPDX identifier from the allowlist in §4. |
| `provenance` | always | One sentence: how this file came to exist. |
| `origin` | when not hand-authored | `hand-authored` (default when omitted) / `derived` / `captured`. See §4. |
| `source_url` | derived only | Public URL of the upstream document. |
| `anonymization` | captured only | One sentence on what was removed or replaced, and with what. See §5. |
| `rung` | valid entries | See §2. Only valid entries carry one. |
| `fileset_role` | multi-file sets | `root` (exactly one per set directory) or `member`. |
| `failure_class` | invalid entries | `syntactic` / `semantic` / `truncated` / `wrong-format` / `encoding` / `unresolvable-ref` / `version-out-of-range`. |
| `expected_error_code` | invalid + rejecting adversarial | A code registered in `apiome-rest/src/app/intake_error_taxonomy.py`. |
| `guard` | adversarial entries | The intake guard the fixture proves (e.g. `xml-entity-expansion`, `archive-bomb`). |
| `notes` | optional | Caveats — notably where current behavior deviates from the declared intent. Renders as a ⚠ callout in the README. |

---

## 4. Provenance and licensing

Every entry declares an **origin**. This is the field that decides which extra rules apply:

| `origin` | Means | Also requires |
|---|---|---|
| `hand-authored` (default) | Written in this repository from the format specification. | `source` must be the literal `hand-authored`. |
| `derived` | Copied or adapted from a third-party document. | `source` names the upstream project; `source_url` links the document. |
| `captured` | Recorded from a real running system (traffic capture, exported payload, support attachment). | `source` names the capturing system; `anonymization` states what was scrubbed (§5). |

`origin` and `source` must agree in both directions: a non-`hand-authored` source with no origin
fails, and a `derived`/`captured` origin with `source: "hand-authored"` fails.

### Approved licenses

`license` is required on every entry and must be one of these SPDX identifiers:

| SPDX id | Why it is acceptable |
|---|---|
| `Apache-2.0` | the repository's own license — the default for anything written here |
| `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC` | permissive, attribution-only |
| `CC0-1.0`, `Unlicense` | public-domain dedication |
| `CC-BY-4.0` | permissive with attribution |

Anything else — including copyleft (`GPL-*`, `AGPL-*`, `MPL-*`), share-alike (`CC-BY-SA-*`),
non-commercial (`CC-BY-NC-*`), and "no license stated" — **fails the gate**. Do not vendor it. The
allowlist lives in `APPROVED_LICENSES` in `scripts/check_corpus_provenance.py`; extending it is a
reviewed code change, not a manifest edit.

### If the upstream license is not acceptable

Do not copy the document. Write a **faithful reconstruction** instead: an original file that exercises
the same constructs — the same nesting, the same unusual keywords, the same size profile — with your
own names and values. That is a `hand-authored`, `Apache-2.0`, `real-world`-rung entry, and it is the
normal way this corpus gets its hard cases. Say so in `provenance` ("Reconstructed from the shape of
…, no upstream text copied.").

### Practical rules for derived entries

- Copy the **smallest** fragment that demonstrates the construct; a corpus fixture is not a mirror.
- Keep any upstream copyright header the license requires you to keep.
- `source_url` must point at the actual document (a raw file or spec page), not a project homepage.
- Anything a captured payload rule would catch (§5) applies to derived documents too: upstream
  examples sometimes embed real hostnames, tokens, and account numbers.

---

## 5. Captured payloads must be anonymized before commit

A `captured` entry is one whose bytes came off a real system. **Anonymize it before it is committed —
never rely on the intake secret-scrubber to do it for you.** That scrubber protects the product at
runtime; it does not protect a fixture that is already in git history, where a later deletion does not
undo the disclosure.

Remove or replace, at minimum:

- **Credentials** — API keys, bearer/session tokens, passwords, signatures, private keys, connection
  strings. (GitHub push protection also blocks realistic credential literals, so a fixture that needs
  to *look* credential-bearing should assemble the value from fragments or be generated at test time.)
- **Personal data** — names, emails, phone numbers, postal addresses, dates of birth, national and
  tax identifiers, account and card numbers, IPs, device and user ids.
- **Customer identity** — company names, internal hostnames, non-public URLs, ticket ids, tenant ids,
  and anything else that identifies whose system this was.
- **Business-sensitive values** — real prices, volumes, balances, and internal endpoint names.

Replace, do not delete: keep the *shape* (field presence, string length class, format of an
identifier) so the fixture still exercises what it is meant to. Use obviously synthetic values —
`acme-corp`, `ada@example.com`, `+1-555-0100`, `4111 1111 1111 1111`.

Then record it. `anonymization` is one sentence naming what you replaced and with what, e.g.
`"Customer names, emails and account numbers replaced with example.com placeholders; auth headers
removed."` Because a recording of a running system carries no upstream license, a captured entry must
be contributed under a license you can actually grant: **`Apache-2.0` or `CC0-1.0`**.

If you cannot anonymize a payload without destroying what makes it interesting, do not commit it —
reconstruct it by hand instead (§4).

---

## 6. Adding an example, end to end

1. **Write or obtain the file** and drop it in the right directory and tier
   (`<format>/`, `<format>/negative/`, `<format>/adversarial/`, or a per-set subdirectory).
2. **Ground the detection contract** — run the file through format detection and record what it
   actually reports; if that disagrees with what it *should* report, keep the intent in
   `expected_detection` and describe the deviation in `notes`.
3. **Add the manifest entry** in path-sorted position, with the provenance fields from §4/§5.
4. **Regenerate the README** (never edit it by hand):
   ```bash
   python3 scripts/generate_examples_readme.py
   ```
5. **Run the gates**:
   ```bash
   python3 scripts/check_corpus_provenance.py         # provenance / licensing / anonymization
   python3 scripts/generate_examples_readme.py --check # README drift
   cd apiome-rest && uv run pytest tests/test_corpus_manifest.py tests/test_corpus_provenance.py
   ```
6. **Run the tier suite your file belongs to** — `tests/test_corpus_import.py` (valid),
   `tests/test_corpus_negative.py` (invalid), `tests/test_corpus_adversarial.py` (adversarial).
7. **Refresh the golden snapshot** if you added a valid entry:
   ```bash
   cd apiome-rest && uv run pytest tests/test_corpus_golden.py --update-golden
   ```
   Review the generated snapshot — it is the canonical model your fixture produces, and reviewing it
   is how a wrong fixture gets caught.
8. **Run the TypeScript twin** so both loaders agree:
   ```bash
   cd apiome-ui && yarn test tests/corpus-loader.test.ts
   ```

---

## 7. Review checklist

A reviewer should be able to tick every box. If any of them cannot be ticked, the entry does not land.

**Provenance**

- [ ] `origin` is correct, and `source` agrees with it.
- [ ] Derived entries link the real upstream document in `source_url`, and copy only the fragment
      that is needed.
- [ ] `license` is on the §4 allowlist and is genuinely the license of the copied content — not an
      assumption from the project's top-level LICENSE file.
- [ ] Required upstream copyright/attribution headers are intact.
- [ ] `provenance` explains the origin in one sentence a stranger can act on.

**Privacy**

- [ ] No credentials, tokens, keys, or connection strings anywhere in the file.
- [ ] No personal data, customer identity, or internal hostnames — checked by reading the file, not
      by trusting the description.
- [ ] Captured entries carry an `anonymization` sentence that matches what the file actually contains.
- [ ] Captured entries are licensed `Apache-2.0` or `CC0-1.0`.

**Corpus health**

- [ ] The file is in the right tier directory for its `validity_class`.
- [ ] `rung` is honest — a `typical` file is not a `minimal` one with more comments.
- [ ] `features` describe what the file demonstrates and let a test select it without a path.
- [ ] `expected_detection` / `expected_outcome` were grounded by running the pipeline, and any
      deviation from intent is written down in `notes`.
- [ ] Invalid entries carry a `failure_class` and a registered `expected_error_code`; adversarial
      entries carry a `guard`.
- [ ] `README.md` was regenerated, and the golden snapshot was reviewed rather than blindly accepted.

---

## 8. What CI runs

| Check | Command | Fails when |
|---|---|---|
| Provenance & licensing | `python3 scripts/check_corpus_provenance.py` | an entry is missing a license, uses one outside the allowlist, contradicts its `origin`, or is a capture with no anonymization statement |
| README drift | `python3 scripts/generate_examples_readme.py --check` | the manifest changed without a README regen |
| Manifest contract | `apiome-rest/tests/test_corpus_manifest.py` | completeness, schema validity, adapter-registry drift, ladder floors, tier placement |
| Provenance rules | `apiome-rest/tests/test_corpus_provenance.py` | the rule engine itself regresses, or the manifest breaks a rule |
| Tier behavior | `test_corpus_import.py`, `test_corpus_negative.py`, `test_corpus_adversarial.py`, `test_corpus_golden.py` | a fixture does not do what its entry says it does |
| TypeScript twin | `apiome-ui/tests/corpus-loader.test.ts` | the two loaders disagree about the contract |

The provenance and README checks also run as their own lightweight workflow
(`.github/workflows/corpus-provenance.yml`) on any change to the corpus, so a manifest-only pull
request still gets gated.
