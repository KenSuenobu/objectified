# COBOL copybook layout inspector (CPDO-2.3, #4799)

> Builds on the **Format details** tab ([CATALOG_FORMAT_DETAILS.md](./CATALOG_FORMAT_DETAILS.md),
> CPDO-2.1 #4797) and the payload analysis it reads
> ([payload_analysis.md](../../apiome-rest/docs/payload_analysis.md) CPDO-1.1 #4794,
> [payload_analyzers.md](../../apiome-rest/docs/payload_analyzers.md) CPDO-1.2 #4795).
> Parallel with the X12 inspector ([CATALOG_X12_INSPECTOR.md](./CATALOG_X12_INSPECTOR.md),
> CPDO-2.2 #4798). Parser changes coordinated with #3991.

## Why

A copybook normalizes into records and fields with types. That is a field list, and a copybook is a
**positional description**: `PIC S9(9)V99 COMP-3` says *six bytes, packed two digits per byte with a
sign nibble*, and the field after it starts six bytes further into the record. `REDEFINES` says two
items describe the *same* bytes. `OCCURS 1 TO 10 DEPENDING ON` says the record has no single length
at all. None of that survives normalization, and none of it is legible as generic key/value pairs on
a tree row.

CPDO-1.2 already kept levels, PICTURE, USAGE, OCCURS, ODO and 88-conditions. Three things were still
missing, and this ticket adds them:

| Gap | Before CPDO-2.3 |
|---|---|
| `REDEFINES` | Not parsed. Detected by scanning the source, warned about, and the overlays described as independent fields — which is what they are *not* |
| Byte offsets and lengths | Not computed at all (`copybook.computed_storage_length` was declared unsupported) |
| A clause split across two source lines | Skipped, so the `DEPENDING ON` of any table that declared it on a second line was silently lost |

## The storage calculator

`apiome-rest/src/app/cobolcopybook_layout.py` is the arithmetic, and nothing else — no parsing, no
analysis document, no I/O. It takes the parsed field tree and returns one `FieldLayout` per item:
how many bytes it occupies, where it starts, and — the part that matters more — **whether either is
actually knowable**.

```text
01 PAYMENT-RECORD                       offset 1   len 55
  05 PAYMENT-ID       PIC 9(10)         offset 1   len 10
  05 PAYMENT-TYPE     PIC X(1)          offset 11  len 1
  05 PAYMENT-AMOUNT   PIC S9(9)V99 C-3  offset 12  len 6
  05 PAYMENT-DETAIL   PIC X(30)         offset 18  len 30
  05 CARD-DETAIL      REDEFINES         offset 18  len 30   ← same storage
  05 BANK-DETAIL      REDEFINES         offset 18  len 30   ← same storage
  05 PAYMENT-POSTED-DATE PIC 9(8)       offset 48  len 8
```

Three rules do all the work:

- an item's length is its PICTURE's, or — for a group — the sum of its children's;
- a **REDEFINES** item starts where its target started and does **not** advance the cursor;
- a **variable table** advances the cursor by an amount that is not a number, so everything after it
  has a *range* of offsets rather than an offset.

`05-ach-entry-detail.cpy` computes to **94 bytes**, which is the length the public NACHA file format
fixes the Entry Detail record at — an arithmetic check against something other than our own tests.

### What it refuses to compute

Three situations make a number unknowable, and each is reported as unknown rather than filled in:

| Situation | What the record carries |
|---|---|
| A PICTURE the calculator does not read (`PIC N`, an unfamiliar USAGE, digits beyond a binary item) | No length, **plus a stated reason**; the containing group has no length either, and nothing after it has an offset |
| An item after a variable-length table | `offsetVariable: true` and **no** `offset` — a minimum presented as *the* offset is the single most misleading number this could emit |
| An item with neither PICTURE nor children | No length. It is not assumed to be zero bytes |

A zero would silently shift every offset after it, which is exactly the failure the module exists to
prevent, so a length and a reason are never both present.

### Assumptions, declared rather than asserted

Storage arithmetic is only true under an encoding and a compiler's representation choices, and the
copybook states neither. `LAYOUT_ASSUMPTIONS` names them — a single-byte encoding, packed decimal at
two digits per byte plus a sign nibble, the common IBM binary width table, an overpunched rather
than separate sign, and no `SYNCHRONIZED` slack — and every record carries them as an `info` warning.
The panel reads that warning rather than restating the list, so the screen cannot drift from the
arithmetic. A record with no such warning gets *"treat the lengths above as computed rather than
observed"*, not an invented list.

## What the pane shows

| Piece | Where |
|---|---|
| The storage calculator | `apiome-rest/src/app/cobolcopybook_layout.py` |
| REDEFINES / fixed-OCCURS / continuation-line parsing | `apiome-rest/src/app/cobolcopybook_parser.py` |
| The extractor that puts it on the record | `apiome-rest/src/app/cobolcopybook_analysis.py` |
| Every UI derivation | `apiome-ui/src/app/utils/catalog-copybook-analysis.ts` |
| The panel | `apiome-ui/.../catalog/CatalogCopybookInspectorPanel.tsx` |
| Tests | `test_cobolcopybook_layout.py`, `test_cobolcopybook_analysis.py`, `catalog-copybook-analysis.test.ts`, `catalog-copybook-inspector-panel.test.tsx` |

**The record** — its byte length, or its length *range* when a variable table makes it one, and how
many of its items could actually be sized (`10 of 10`, or `3 of 4` when one could not).

**The storage map** — every group and elementary item in declaration order, indented by nesting
level, with its PICTURE, USAGE, byte span, computed length and derivation (`display` / `packed` /
`binary` / `float`, plus `signed` and decimal places). Condition names are **not** rows: an 88-level
name is a value enumeration, occupies no storage, and rides on the item it qualifies.

**Shared storage (REDEFINES)** — grouped by the span the items share rather than listed as siblings,
because "what else claims these bytes?" is the direction the question is actually asked in. An
overlay needing more storage than its target is flagged and **neither length is adjusted to fit** —
that is a fact about the copybook, and the inspector is not the place to correct it.

**Tables** — occurrence bounds, the `DEPENDING ON` controller, and whether that controller is
declared in this copybook at all. An unresolved one is not called an error: it may well live in a
surrounding copybook this one is copied into, and the panel says so.

## Mapped details link to canonical fields

The normalizer turns every **group** item into a canonical type of the same name and every
elementary item into a field on its parent group's type. So the map links a group to its own parsed
entity and an elementary item to the entity that carries it, jumping to the Overview tab through the
pre-existing `navigateToEntity` path (MFI-28.2's).

The link is offered **only when the parsed model actually carries that name**. An item that matches
nothing gets no link rather than the nearest guess — the panel is handed the Overview's entity names
and refuses to offer a jump it cannot honour.

## Source navigation

Copybook nodes carry the 1-based fixed-format source line they were declared on, recovered by
scanning the copybook and matched in traversal order, so a repeated `FILLER` resolves to its own
line. Selecting an item in the storage map reveals it in the structure tree; from there the existing
CPDO-2.1 jump opens **Source & Code** centred on that line. A copybook knows its line and not its
bytes, so no character range is claimed (that is X12's, CPDO-2.2).

## Status: what makes a record partial

The distinction this pane depends on, and the same one CPDO-2.2 draws for X12 control totals:

| Finding | Severity | Record status |
|---|---|---|
| An item whose storage cannot be computed | `warning` | **partial** — a boundary of the *analyzer* |
| A variable-length record | `info` | available — a property of the layout the copybook declared |
| An unresolved ODO controller | `info` | available — the controller may be declared elsewhere |
| A REDEFINES that does not fit, or names a missing target | `info` | available — a fact about the copybook, recorded rather than graded |
| `RENAMES`, `COPY … REPLACING` | `warning` | **partial** — grammar the parser does not read |

## What this does not do

- It does not represent a REDEFINES as a canonical **union**. The overlays normalize to ordinary
  sibling fields; the union modelling is #3991's, and normalization is deliberately unchanged here.
- It does not detect the source encoding. Lengths are computed under stated assumptions, and
  `copybook.character_encoding_detection` stays in the analyzer's unsupported list.
- It does not read `RENAMES` (level 66), `COPY … REPLACING`, or `VALUE` on ordinary fields.
- It does not apply `SYNCHRONIZED` alignment, so no slack bytes are inserted between items.
