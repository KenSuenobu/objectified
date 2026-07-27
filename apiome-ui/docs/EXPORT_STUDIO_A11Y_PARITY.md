# Export Studio — design parity & accessibility contract (MFX-41.5, #4352)

The Export Studio (MFX-EPIC-41), the Verify workbench (EPIC-42), and the Monaco viewer + bundle
explorer (EPIC-43) were built against a mockup that only covered the dialog, the fidelity panel,
the result, and the public browse screens. This document closes that gap from both ends:

1. the reference mockup now carries the **Studio screens** —
   `private-suite/docs/mockups/multi-format-export/index.html` (Studio stepper, Verify three-lens,
   Monaco + bundle tree, test-drive tabs, export history), each with the a11y contract its surface
   owes stated on the screen itself; and
2. the **built** surfaces were audited against that contract, the findings fixed, and the contract
   pinned by an automated suite so it cannot silently regress.

Automated gate: `tests/export-studio-a11y.test.tsx` — deterministic jsdom axe scans (WCAG 2.1
A/AA; the contrast and page-landmark rules need a real browser, the same exemption
`tests/login-a11y.test.tsx` and `tests/import-preview-a11y.test.tsx` take) plus the structural
keyboard contract. Run it with:

```bash
yarn jest export-studio-a11y export-bundle exportFidelityPreview exportTargetCatalog
```

## What the audit found, and what changed

| # | Surface | Finding | Fix |
|---|---------|---------|-----|
| 1 | Fidelity report + count chips | Loss kind was **colour + a three-letter word**; `DROP` vs `APPROX` at 10px relied on red vs amber, and the jargon was unexplained to a screen reader | Chips lead with a per-kind glyph (`✕ ≈ ✚ ✓`, `kindGlyph`) and carry a spoken expansion (`kindDescription`, e.g. "dropped — not representable in the target"). Count chips carry the same glyph |
| 2 | Studio stepper | Completed and current steps shared one indigo treatment; the `<ol>` was unnamed; step state existed only as colour + `aria-current` | Three distinct treatments (check glyph + emerald for done, ringed indigo for current, outlined for upcoming), `aria-label="Export steps"`, and a visually-hidden state word per pill ("completed" / "current step, 2 of 5" / "not started") |
| 3 | Studio step change | Stepping swapped the panel content under a Back/Continue pair that never moves — no focus or announcement signal | The step panel is a named region (`Step N of 5: <label>`), focusable, and takes focus on every step change (the first render is skipped so a deep link does not steal landing focus) |
| 4 | Verify lens tabs | `role="tab"` buttons with no `aria-controls`, no panel relationship, every tab a Tab stop, no arrow-key movement | Full WAI-ARIA tabs: ids + `aria-controls`/`aria-labelledby`, roving `tabindex`, ←/→/↑/↓/Home/End, and a focusable `tabpanel` |
| 5 | Verify lens badges | A bare digit in a coloured pill (`7`) named nothing | The digit is `aria-hidden`; the badge speaks "7 constructs affected" / "0 validation problems" / "1 lint finding" |
| 6 | Verify verdict + progress | The go/no-go appeared without focus moving, so it was never announced | The verdict banner is `role="status"`; the per-lens progress list is wrapped in a `role="status"` region (wrapped, so the rows stay list items) |
| 7 | Target grid | Selection was an indigo fill only | Cards carry `aria-pressed`; the grid is a named group |
| 8 | Bundle tree | `role="treeitem"` containers wrapped focusable buttons (nested interactive), every row was a Tab stop, and no row reported level/position | The row button *is* the tree item, over a pure flattener (`flattenBundleTree`): roving `tabindex`, ↑/↓/←/→/Home/End/Enter, and truthful `aria-level` / `aria-setsize` / `aria-posinset` |
| 9 | Bundle file tabs | The tablist owned non-tab children (a focusable close button per file), and tabs had no roving `tabindex` or arrow keys | Roving `tabindex` + ←/→/Home/End; **Delete/Backspace** closes the focused tab and the ✕ became a pointer shortcut, so the tablist owns only tabs |
| 10 | Finding badges (tree + tabs) | `aria-label` on a plain `<span>` — an attribute that role cannot take | The digit is `aria-hidden` and the phrase ("1 error") is real text |
| 11 | Monaco viewer | The editor container was unnamed and Monaco's textarea kept its generic default name | The container is a named region and Monaco receives the same `ariaLabel`: `<document> — read-only <language> viewer` (`documentLabel` from the artifact filename / bundle path) |

## The contract

- **Never colour alone.** Loss kinds are glyph + word + colour. Stepper states differ by glyph and
  weight. Verdicts are icon + label + description. Validation/lint severities are words. Export
  history outcomes read as text. Colour is always the third channel.
- **Named counts.** No badge is a bare number: the digit is decorative and the phrase is the text.
- **One Tab stop per composite widget.** The verify lens tabs, the bundle tree, and the bundle file
  tab strip each hold a single Tab stop with arrow-key movement inside (roving `tabindex`), the
  pattern the import preview's tree and findings list already follow.
- **No nested interactive controls.** A `treeitem` or a `tab` never contains another focusable
  element; secondary affordances (the ✕ on a file tab) are presentational with a keyboard
  equivalent on the owning widget.
- **Announcements without focus theft.** Anything that resolves while focus sits elsewhere — the
  verify verdict, the run progress, the manifest truncation banner — is a `role="status"` region.
- **Editors are named and escapable.** Every Monaco container names its document and language.
  The export viewers are read-only, which is also what keeps Tab moving focus out of them: Monaco
  only binds Tab to indentation on an editable model.
- **Focus follows the step.** Changing Studio step moves focus to the newly-rendered, named step
  panel, so a keyboard user is never left on a button whose page changed underneath it.

### Contrast

The chip palettes are unchanged by this pass and already clear WCAG AA 4.5:1 for text — light
`*-100` backgrounds with `*-800` text (rose/amber/violet/emerald), dark `*-900/40` with `*-300`.
jsdom cannot compute contrast, so `color-contrast` is disabled in the axe scans and remains a
manual/browser check (step 8 of the walkthrough below); the automated suite guarantees the
*redundancy* channels instead, which is what protects the user if a future palette edit narrows a
pair.

## Manual keyboard-only walkthrough

Run once per release that touches the Studio (dashboard → a version → **Export this version**, with
a multi-file target such as gRPC / Protobuf so the bundle explorer appears):

1. **Tab** into the route. Verify focus lands visibly on **Back to Versions**, and that every stop
   through the walkthrough shows a visible focus ring.
2. **Tab** to **Continue** / **Choose target** and press **Enter**. Verify focus lands on the step
   panel, that a screen reader announces "Step 2 of 5: Target", and that step 1 now reads
   "Source — completed".
3. In the target grid, **Tab** to a card and press **Enter**. Verify the chosen card reports itself
   as pressed and the fidelity headline updates.
4. On **Options**, **Tab** through the generated form. Verify a required field's error is announced
   (it is `aria-describedby` the message) and that **Continue** stays disabled until it validates.
5. On **Verify**, activate **Run verification** and — without moving focus — verify the verdict is
   announced when the run settles.
6. **Tab** once into the lens strip. Verify **only one** tab is reachable, that **←/→** move
   between Fidelity / Validation / Lint, that **Home/End** jump, and that a further **Tab** lands
   inside the lens panel rather than on the next tab.
7. In the fidelity lens, expand **Show per-construct report**. Verify each row announces its kind in
   words ("DROP, dropped — not representable in the target"), and check the report in greyscale (or
   with a colour-blindness simulator): every kind must remain distinguishable.
8. Zoom to 200% and re-check the chips, stepper, and verdict banner for contrast and truncation.
9. Acknowledge the loss and continue to **Review**. **Tab** into the bundle tree: verify one Tab
   stop, **↑/↓** movement, **→/←** expand/collapse, **Enter** to open a file, and that each row
   announces its level and position ("level 3, 1 of 2").
10. **Tab** to the file tab strip: **←/→** switch files, **Delete** closes the focused tab.
11. **Tab** into the editor. Verify it announces "<file> — read-only <language> viewer", and that a
    single **Tab** leaves it again (no keyboard trap).
12. **Tab** to the problems panel and activate a row; verify the editor reveals that line and the
    row stays identifiable without relying on the marker colour.

## Mockup parity

Every screen in `private-suite/docs/mockups/multi-format-export/index.html` states the roadmap ids
it maps to and the a11y contract it owes. When a Studio surface changes shape, update the mockup
screen in the same change — the mockup is the reviewed design of record for EPIC-41 through 46, and
the test-drive (EPIC-44) and history (46.1) screens are the design that later work builds against.
