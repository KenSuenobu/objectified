# Import preview — budgets, virtualization, and accessibility (IXH-3.6, #5108)

The import wizard's preview step (quality gate → entity explorer → projection map →
re-import delta → raw viewer) renders user-supplied data of unbounded size. This document
is the contract that keeps it fast and usable at real-world scale: every surface's budget,
what happens above it, the path to the complete data, and the accessibility guarantees the
step makes — plus the manual keyboard-only walkthrough script.

The budgets are **code**, not just prose: every constant lives in
`src/app/utils/preview-budgets.ts`, the components import it from there, and
`tests/preview-budgets.test.ts` fails if this registry and the enforced values drift.

## Budgets

Two mechanisms appear below, with different obligations:

- **Windowed** (virtualization): the full data is client-side; only the rows near the
  viewport are mounted (`computeWindowedRange`, `src/app/utils/windowed-rows.ts`). Nothing
  is hidden — scrolling reaches everything — so no truncation statement is required, but
  the surface shows a "windowed" note so the behavior is discoverable.
- **Truncated**: part of the data is genuinely not present. Truncation is **always stated
  in the UI, never silent**, and the statement names the path to the complete data.

| Surface | Budget (constant) | Mechanism | Above the budget | Path to the complete data |
|---|---|---|---|---|
| Entity explorer tree (IXH-3.2) | 50 rows (`TREE_VIRTUALIZE_ABOVE`) | Windowed | Rows window around the viewport; the focused row is pinned | Scroll — the loaded list is complete |
| Preview-manifest payload (IXH-3.1) | 1000 entities/request (`PREVIEW_PAGE_SIZE`) | Truncated | Banner: "showing X of Y entities — this preview is truncated" | The banner's **Load all entities** walks the cursor pages |
| "Load all entities" walk | 20 pages/click (`LOAD_ALL_PAGE_CAP`) | Truncated | The walk pauses; the banner stays up with loaded-of-total | Click **Load more entities** again |
| Ranked findings list (IXH-2.2) | 50 rows (`FINDINGS_VIRTUALIZE_ABOVE`) | Windowed | Rows window ("windowed" note); the selected row is pinned | Scroll — every finding is reachable |
| Projection-map clean rows (IXH-3.3) | 48 rows (`GRAPH_AGGREGATION_THRESHOLD`, shared with EFP-2.2) | Truncated | Clean info rows collapse into per-family aggregates; a note states the rule. Dropped/non-info evidence never aggregates | Expand the aggregate row in the evidence table |
| Projection-map SVG (IXH-3.3) | 120 drawn entries (`GRAPH_DRAW_BUDGET`) | Truncated | Worst-first drawing; note: "drawing X of Y constructs (worst first)" | The evidence table below always lists every construct |
| Projection evidence table (IXH-3.3) | 60 display rows (`PROJECTION_TABLE_VIRTUALIZE_ABOVE`) | Windowed | Rows window with truthful `aria-rowcount`/`aria-rowindex`; the focused row is pinned | Scroll — every evidence row is reachable |
| Re-import delta family lists (IXH-3.4) | 50 entries/family (`DELTA_LIST_VIRTUALIZE_ABOVE`) | Windowed | The family list windows ("windowed" note); the focused row is pinned | Scroll; the header chips always state full counts |
| Raw source viewer (IXH-2.2/3.2) | 400 lines mounted (`RAW_VIEWER_CONTEXT`) | Truncated | "… N earlier lines" / "… N later lines" around the window | Follow any source link — the window re-centers, so every line is reachable |

Draw-budget selection is **worst-first** (`selectDrawnGraphEntries`,
`importProjectionGraph.ts`): aggregates always draw, then rows by severity
(critical → warn → info), then by how lossy the status is (dropped → unavailable →
approximated → synthesized → transformed → not-applicable → retained). The cap can only
ever remove clean evidence; a dropped construct is never what the cap hides.

### Scale material

The IXH-1.5 scale corpus (#5091) is the acceptance material for these budgets. Until it
lands, `tests/import-preview-scale.test.tsx` pins the same guarantees against synthetic
corpora of that magnitude (6000-entity tree, 2000-construct graph, 3000-entry delta):
bounded mounted DOM, focus pinning under scroll, and soft time budgets on the pure view
builders (`BUILD_PROJECTION_VIEW_SOFT_BUDGET_MS`). When #5091 lands, point those fixtures
at the `scale/` tier.

## Accessibility contract

Automated gate: `tests/import-preview-a11y.test.tsx` — deterministic jsdom axe scans
(WCAG 2.1 A/AA; the contrast and page-landmark rules need a real browser and are covered
by the Playwright a11y suite pattern of OLO-3.5) across the loading, pass, blocked, and
large/windowed states, plus the structural keyboard contract. Run it with:

```bash
yarn jest import-preview-a11y import-preview-scale preview-budgets
```

Guarantees:

- **ARIA semantics.** The entity tree is a real `role="tree"` (level/setsize/posinset,
  roving tabindex, type-ahead). The findings list is a `role="listbox"` whose options
  carry `aria-setsize`/`aria-posinset`, so windowing never misreports the list size. The
  evidence table carries `aria-rowcount`, and every row `aria-rowindex`, so windowed rows
  keep their true positions. Windowed delta rows carry `aria-setsize`/`aria-posinset`.
- **Focus management.** Every composite widget has exactly one Tab stop (roving
  tabindex). A focused row that windowing would unmount is *pinned* — kept mounted at its
  true offset — in the tree, the findings list, the evidence table, and the delta lists.
  Keyboard moves focus after render, so the target is always mounted first.
- **No nested interactive controls.** Source-location links inside tree rows are styled
  spans; Enter on the row follows the link (the span's click is a pointer shortcut).
- **Text alternatives for every graph.** The projection-map SVG is named by its
  synchronized table's caption (`aria-labelledby`); table rows and graph nodes share the
  same `aria-label` strings, so the two surfaces say the same thing. The grade orb's ring
  is `aria-hidden` with the grade and score as adjacent text. Status is always conveyed as
  text + symbol + stroke pattern — colour is never the only channel.
- **Visible focus.** Graph nodes draw an explicit focus ring (SVG rect) when focused;
  DOM rows use `focus-visible` rings.
- **Reduced motion.** Every motion class (`animate-*`, `transition`,
  `transition-transform`) is guarded with `motion-safe:`, so
  `prefers-reduced-motion: reduce` disables spinners and transform transitions. Colour and
  opacity fades are exempt (reduced-motion targets movement). The a11y suite asserts no
  unguarded motion class renders anywhere in the step.
- **Live announcements.** The truncation banner and the no-op re-import banner are
  `role="status"`; the evidence card renders inside an `aria-live="polite"` region;
  waiver-grant failures are `role="alert"`.

## Manual keyboard-only walkthrough

Run once per release touching the preview step (import wizard → quality step, with a
document big enough to window — e.g. a generated 6000-type GraphQL schema):

1. **Tab** into the step. Verify focus lands visibly on the first control and every
   focus stop has a visible indicator throughout the walkthrough.
2. In the **entity filter**, type a query; verify the match count announces the filtered
   state ("X of Y") and **Escape**/clear button empties it.
3. **Tab** to the entity tree (one Tab stop). Use **↓/↑** to move, **→/←** to
   expand/collapse, **Home/End** to jump, and type a name prefix (type-ahead). Verify the
   focused row stays visible while the list scrolls, including after **End** on a
   windowed tree.
4. On a row with a source location, press **Enter**; verify the raw viewer jumps to the
   line and states any clipped head/tail ("… N earlier lines").
5. If the truncation banner is present, **Tab** to **Load all entities**, activate it,
   and verify the banner's counts update.
6. In the **re-import delta**, toggle a family disclosure with **Enter** (aria-expanded
   flips), then **Tab** to a reveal link and activate it; verify focus and selection move
   to the revealed tree row. On a windowed family, scroll with arrow keys inside the
   region and verify the focused row never disappears.
7. **Tab** to the **projection graph** (one Tab stop). Move with **↓/↑**, verify the
   focus ring is visible, press **Enter** and verify the evidence card announces. Verify
   the drawn-of-total note is present when the graph is capped.
8. **Tab** into the **evidence table**; activate a construct button; verify it selects
   the same node the graph shows. Expand an aggregate row and verify its members appear
   in place. On a windowed table, scroll and verify the focused row stays mounted.
9. **Tab** to the **ranked findings** (one Tab stop). **↓/↑/Home/End** move selection
   and the raw viewer follows; after **End** on a windowed list the focused row is
   visible and focused.
10. Verify all exits (**Cancel / Back / Retry / Import anyway / Import**) are reachable
    and operable with **Enter**, and that the blocked state's justification field is
    labelled and reachable.
11. With **prefers-reduced-motion: reduce** enabled in the OS, reload: verify no spinner
    rotation and no chevron/row animation anywhere in the step.
