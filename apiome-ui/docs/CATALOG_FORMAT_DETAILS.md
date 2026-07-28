# Catalog **Format details** tab (CPDO-2.1, #4797)

The catalog item detail screen's sixth pane shows an imported payload in **its own
vocabulary** — the one the canonical projection does not keep. An EDI interchange has
functional groups and transaction sets; a COBOL copybook has level numbers, PICTURE clauses
and OCCURS bounds. Overview shows what those *became*; this pane shows what they *were*.

It is driven by `payload_analysis` and nothing else: the immutable, revision-scoped record
CPDO-1.1 (#4794) defined and CPDO-1.2 (#4795) fills. It reconstructs nothing, derives
nothing from the source, and never fills a gap the record left.

| Piece | Where |
|---|---|
| Contract mirror + every derivation | `src/app/utils/catalog-payload-analysis.ts` |
| The pane | `src/app/components/ade/dashboard/catalog/CatalogFormatDetailPanel.tsx` |
| Proxy to the REST record | `src/app/api/catalog/[itemId]/analysis/route.ts` |
| Tab wiring, deep links, source hand-off | `src/app/ade/dashboard/catalog/[id]/CatalogItemDetailClient.tsx` |
| Capability & absence wording (CPDO-2.4) | `FormatCapabilityPanel.tsx`, `formatCapabilityRegistry.ts` |
| Tests | `tests/catalog-payload-analysis.test.ts`, `tests/catalog-format-detail-panel.test.tsx`, `tests/catalog-format-detail-a11y.test.tsx`, `tests/catalog-detail-format-tab.test.tsx`, `tests/api/catalog-analysis-proxy.test.ts` |
| Shared fixtures | `tests/helpers/payload-analysis-fixture.ts` |

## What is fetched, and when

Nothing, until the tab is selected.

The catalog detail read (`GET /api/catalog/{id}`) already embeds the **summary**: status,
reason code, analyzer identity and node counts, no payload material. The pane renders from
that immediately, and only asks for the record when the summary says a tree is actually
fetchable (`available` / `partial`). An `unavailable` or `failed` revision is therefore
explained at **no extra request** — and a reader without `imports:view` is never shown a
permission error about an item that had nothing to show anyway.

`GET /api/catalog/{id}/analysis` is gated on `imports:view`, because a native tree is a
structural description of the payload itself. The proxy passes the upstream status through
unchanged, so the pane can distinguish the two facts that must never be conflated:

- **403** → "You do not have permission to read this item's native payload structure." The
  analysis may well exist.
- an `unavailable` record → "Nothing was analysed for this revision", plus the reviewed
  reason from the CPDO-2.4 registry.

## The five declared states

Every state is a **text** badge; colour only reinforces it. The wording per state lives in
`analysisStatusPresentation`, and a status this build does not know claims nothing.

| State | Rendered as |
|---|---|
| `available` | "Available" — the analyzer described the whole captured source within budget |
| `partial` | "Partial" — plus a **bounding note** naming the dropped-node count |
| `unavailable` | "Unavailable" — plus the registry's reviewed reason |
| `failed` | "Analyzer failed" — the analyzer ran and errored |
| analyzer warnings | "N analyzer warnings", worst-first, with stable codes; node-scoped ones badge their own row |
| redacted | "N values withheld", from the record's own `redaction.redactedNodeCount` |

**Bounding is not a source gap.** When `metrics.truncated` is set, the note says the missing
nodes "are absent from the record, not from your source, and scrolling cannot reach them" —
the opposite statement from the client-side windowing note, which promises everything *is*
reachable by scrolling.

## Value statements

The analysis stores structure, not a second copy of the payload. What a node can say about
its value is governed by the record's stored `valueVisibility` (`none` / `structural` /
`full`), and the pane keeps four *distinct* sentences (`nodeValueStatement`):

| The record says | The pane says |
|---|---|
| `value` present (`full` policy) | `Value: …` — shown verbatim |
| `redacted: true` | "A value of N characters was observed and **withheld** by the value-visibility policy" |
| `valuePresent: true`, `valueLength: 0` | "A value was present in the source and it was **empty**" |
| `valuePresent: false` | "**No value** was present in the source here" |
| nothing, under `none` | "This record carries nothing about values — not even whether one was there" |

An empty X12 element and an absent one are different facts; so are a withheld value and a
missing one. None of the four is ever rendered as another.

The structure filter searches names, constructs, human construct labels and source
locations — and **never observed values**. Under a `full` policy those are payload material,
and a filter that quietly searched them would be a disclosure surface.

## Evidence navigation

Selecting a construct opens its evidence: format-specific attributes (rendered generically
from `attributes`, so one renderer walks any analyzer's output), its source location, its
value statement, its own warnings, a shareable deep link, and — conditionally — a raw-source
jump.

**The jump is offered only when the location addresses the raw source** — an exact character range,
or failing that a line. Source-location quality differs by analyzer and the pane refuses to hide
that:

| Analyzer | Location | Raw-viewer jump |
|---|---|---|
| COBOL copybook | `file` + `line` + path | **Yes** — opens Source & Code centred on the line |
| EDI X12 envelope / segment | `offset` + `length` + `line` + path (CPDO-2.2) | **Yes** — selects the exact characters the construct was read from |
| EDI X12 element / component | envelope `path` + sibling `ordinal` | No — the scan positions segments, and the pane says so |
| Generic walk | `path` only | No — same statement |

A jump switches to the **Source & Code** tab, whose viewer re-centres on the requested line
without re-fetching (`CatalogSourceViewer` keeps the mounted editor in a ref) and states
which construct sent it there. The raw bytes still stream through the pre-existing
`/api/catalog/{id}/source` proxy, so this pane adds **no** new path to raw content and
changes no authorization. When the source was never captured, the jump is replaced by the
honest "there is nothing to open".

### Deep links

`/ade/dashboard/catalog/{id}?tab=format&node={nodeId}` opens the pane, expands the node's
ancestors, and selects and focuses it. Node ids are stable **within one analysis**: a
re-import or an analyzer upgrade mints a new one, so a link into a node this analysis does
not carry is *stated* as unresolvable rather than resolved to the nearest row.

## Accessibility contract

Pinned by `tests/catalog-format-detail-a11y.test.tsx` (axe, WCAG 2.1 A/AA; contrast and the
page-landmark rule need a real renderer) in six states: loading, available with a construct
selected, bounded-with-warnings, unavailable, permission-refused, and large/windowed.

- **Real tree semantics.** `role="tree"` over `role="treeitem"` buttons carrying
  `aria-level`, `aria-setsize`, `aria-posinset`, `aria-expanded` (only where there are
  children) and `aria-selected`. Rows are a flat projection of the expanded nodes, so the
  ARIA facts stay correct under windowing. `aria-setsize`/`aria-posinset` are computed
  against the *filtered* siblings, so they never describe rows that are not there.
- **One Tab stop.** Roving `tabindex`; the tree is a single stop and the arrow keys move
  inside it.
- **Keyboard.** ↓/↑ move, → expands then steps into the first child, ← collapses then steps
  to the parent, Home/End jump to the ends, Enter/Space select (and toggle a parent), and
  printable characters type-ahead by construct label. A one-character buffer walks to the
  next match; a longer buffer refines the current one.
- **Focus restoration.** Two cases: a filter change or a collapse that removes the focused
  row leaves the tab stop on a row that still exists; and following a construct's source
  location returns focus to that row when the reader comes back to the tab. The return is
  armed *only* by that action, so merely selecting the tab never steals focus from the tab
  button.
- **Text alternatives.** The tree is named and described (`aria-describedby` carries the
  keyboard model); the metrics strip is a `<dl>` that states the structure's shape without
  walking it; every badge pairs an `sr-only` label with a visible value; every decorative
  icon is `aria-hidden`.
- **Reduced motion.** Every movement class is `motion-safe:`-guarded. Colour and opacity
  fades are exempt — `prefers-reduced-motion` targets movement.

## Performance budget

Two independent bounds, stated differently because they mean different things:

| Bound | Where it comes from | Above it |
|---|---|---|
| 50 visible rows (`ANALYSIS_TREE_VIRTUALIZE_ABOVE`) | This pane, client-side | Rows window around the viewport ("windowed" note); the focused row is **pinned** at its true offset so focus is never dropped. Everything stays reachable by scrolling. |
| 5000 nodes / 32 levels | The analyzer, server-side (CPDO-1.1) | The stored record is `partial` with `metrics.truncated`; the pane's bounding note names the dropped count. Those nodes are **not** reachable — they were never recorded. |

Progressive expansion keeps the first paint small regardless: only the roots and their
branching children are expanded (`defaultExpandedAnalysisIds`), so a wide interchange paints
its envelopes rather than its elements.

The budget constant lives in `src/app/utils/preview-budgets.ts` with every other bound, and
`tests/preview-budgets.test.ts` fails if the registry and the enforced value drift. See
[IMPORT_PREVIEW_BUDGETS_AND_A11Y.md](./IMPORT_PREVIEW_BUDGETS_AND_A11Y.md).

## What this pane deliberately does not do

- It does not reconstruct, re-parse or infer anything. No record, no rows.
- It does not add editing: catalog items are read-only on this screen.
- It does not describe conversion. What the projection keeps or drops is the **Convert to
  OpenAPI** graph's job (CPDO-3.1, #4801) over CPDO-1.3's projection manifest.
- It does not own format-specific presentation. The X12 and copybook inspectors (CPDO-2.2
  #4798, CPDO-2.3 #4799) build on this common shell — both are mounted above the tree and
  documented in [CATALOG_X12_INSPECTOR.md](./CATALOG_X12_INSPECTOR.md) and
  [CATALOG_COPYBOOK_INSPECTOR.md](./CATALOG_COPYBOOK_INSPECTOR.md).
