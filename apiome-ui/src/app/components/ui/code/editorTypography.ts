/**
 * The one place a Monaco editor's type metrics are written down (HIVE-1.6, #5279).
 *
 * Monaco measures glyphs itself and positions every line absolutely, so its `fontSize`,
 * `lineHeight` and `padding` options are **numbers of CSS pixels** — it cannot read a
 * custom property, and handing it anything else silently breaks its cursor maths. It is
 * therefore one of the few genuinely physical measurements DESIGN.md §3.2 exempts, in the
 * same family as a hairline or a canvas coordinate.
 *
 * That exemption is only safe while it is *narrow*, so the numbers live here instead of
 * being re-typed at each of the ~19 editors in the app: one constant to change, one place
 * for the lint rule (`eslint-rules/hive.mjs → hive/no-px-typography`) to be satisfied by,
 * and no doubt at a call site about whether a literal `13` was a considered choice or a
 * leftover. Everything *around* the editor — labels, toolbars, status lines — is ordinary
 * UI and uses the Hive type scale.
 *
 * The values sit at the bottom of the scale on purpose: code is scanned in bulk, and a
 * dense editor next to §3.2 body copy reads as a distinct surface rather than as prose.
 */

/**
 * Font size, in CSS pixels, for a full source editor (`Editor` / `DiffEditor`).
 *
 * 13 px — the §3.2 `sm` step — so an editor pane sits a half-step below the body copy of
 * the dialog or panel that frames it.
 */
export const CODE_EDITOR_FONT_SIZE = 13;

/**
 * Font size, in CSS pixels, for an inline read-only code block (`JsonViewer`,
 * `JsonDiffViewer`).
 *
 * 12 px — the §3.2 `xs` step. These render *inside* cards and drawers rather than owning a
 * pane, so they take the smaller of the two code sizes.
 */
export const CODE_BLOCK_FONT_SIZE = 12;

/**
 * Line height, in CSS pixels, that Monaco lays {@link CODE_BLOCK_FONT_SIZE} out on.
 *
 * Stated rather than derived because the auto-sizing viewers multiply it by a line count
 * to pick their own height; a ratio would round differently there than inside Monaco and
 * leave a partial last line.
 */
export const CODE_BLOCK_LINE_HEIGHT = 19;

/** Total vertical padding, in CSS pixels, Monaco adds inside its viewport. */
export const CODE_BLOCK_PADDING = 16;
