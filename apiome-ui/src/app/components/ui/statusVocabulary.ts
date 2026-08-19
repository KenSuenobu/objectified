/**
 * The Hive status vocabulary — one mapping from the app's enum strings to a tone
 * (HIVE-2.4, #5283).
 *
 * Authority: `docs/mockups/DESIGN.md` §3.1 ("Status vocabulary → color") and
 * `docs/mockups/assets/hive.css` §11 (`.badge[data-status]`).
 *
 * Before this module, a status colour was a per-page decision: a published version was
 * emerald in one table and `green-600` in another, catalog formats used one palette and the
 * MCP health pill a second. Nothing was wrong on any single screen, and the colour language
 * was unlearnable across them.
 *
 * The fix is one table, here, keyed by the *string the API already returns*. A surface hands
 * over `"published"` / `"degraded"` / `"revoked"` and gets back a tone; the tone names a set of
 * token classes. Adding a state is a line in {@link STATUS_TONE}, not a new component and not a
 * new colour — and because every class below is a Hive token, a tone follows the reader's theme,
 * density and font scale for free.
 *
 * There is deliberately **no React** in this file. The components that render the vocabulary
 * (`Badge`, `ui/mcp/HealthPill`, `ui/mcp/FreshnessPill`, `ui/mcp/GradeGlyph`,
 * `ui/catalog/GradeChip`) all resolve through the pure helpers here, so the mapping is unit
 * tested directly and no consumer ever spells a colour.
 *
 * The two vocabularies that are *not* here are the ones where colour is an identity rather
 * than a state — `FormatPill` (a format's hue) and `MethodChip` (an HTTP verb's hue). Those
 * are fixed hex in `globals.css` (`.fmt--*`, `.method--*`) precisely so they do **not** move
 * with the theme.
 */

/**
 * The tones the design language spends on meaning.
 *
 * `outline` and `ink` are the two that carry no hue: `outline` is the "set aside" state
 * (archived, disabled) drawn as a hairline, and `ink` is the page's own foreground, used when
 * a chip has to out-rank every coloured one around it.
 */
export type StatusTone =
  | 'neutral'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'accent'
  | 'honey'
  | 'violet'
  | 'orange'
  | 'rose'
  | 'outline'
  | 'ink';

/** Every tone, in the order the design-system gallery shows them. */
export const STATUS_TONES: readonly StatusTone[] = [
  'neutral',
  'ok',
  'warn',
  'danger',
  'accent',
  'honey',
  'violet',
  'orange',
  'rose',
  'outline',
  'ink',
] as const;

/**
 * A tone as a **soft tinted fill plus its matching ink** — the body of a badge or pill.
 *
 * This is the shape `.badge[data-status]` has in hive.css §11: a `-soft` background with the
 * `-fg` ink that was chosen to clear WCAG AA on it in every theme.
 *
 * `outline` is the exception and takes `--fg-muted`: it has no fill of its own, so its ink is
 * read against whatever surface it lands on, and only the muted step clears AA on all of them.
 * `--fg-subtle` — the quieter step DESIGN.md §3.2 gives section labels — measures 3.1:1 on the
 * canvas, which is a serious axe finding for an 11 px badge.
 */
export const STATUS_TONE_SOFT_CLASS: Readonly<Record<StatusTone, string>> = {
  neutral: 'bg-neutral-soft text-neutral-fg',
  ok: 'bg-ok-soft text-ok-fg',
  warn: 'bg-warn-soft text-warn-fg',
  danger: 'bg-danger-soft text-danger-fg',
  accent: 'bg-accent-soft text-accent-fg',
  honey: 'bg-honey-soft text-honey-fg',
  violet: 'bg-violet-soft text-violet-fg',
  orange: 'bg-orange-soft text-orange-fg',
  rose: 'bg-rose-soft text-rose-fg',
  outline: 'bg-transparent text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)]',
  ink: 'bg-fg text-surface',
};

/**
 * A tone as a **solid fill** with a foreground that stays legible on it — the grade chip, and
 * anything else that has to read as a single saturated swatch rather than a tint.
 *
 * `--fg-on-accent` is the same "ink drawn on a solid role fill" token `Button` uses for its
 * primary and danger variants, so solid chips and solid buttons agree.
 */
export const STATUS_TONE_SOLID_CLASS: Readonly<Record<StatusTone, string>> = {
  neutral: 'bg-neutral text-fg-on-accent',
  ok: 'bg-ok text-fg-on-accent',
  warn: 'bg-warn text-fg-on-accent',
  danger: 'bg-danger text-fg-on-accent',
  accent: 'bg-accent text-fg-on-accent',
  // Solid honey is a fixed brand hue in every theme, so its ink is the fixed dark one.
  honey: 'bg-honey text-honey-ink',
  violet: 'bg-violet text-fg-on-accent',
  orange: 'bg-orange text-fg-on-accent',
  rose: 'bg-rose text-fg-on-accent',
  // "Set aside" has no fill to be solid about — it stays a well with subdued ink.
  outline: 'bg-inset text-fg-muted',
  ink: 'bg-fg text-surface',
};

/**
 * A tone as a **dot** — the small saturated swatch that sits beside a label.
 *
 * DESIGN.md §6 forbids colour as the only signal, so a dot never travels alone: the pills that
 * use this always draw a text label (or an `sr-only` one when the label is hidden for density).
 */
export const STATUS_TONE_DOT_CLASS: Readonly<Record<StatusTone, string>> = {
  neutral: 'bg-neutral',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  accent: 'bg-accent',
  honey: 'bg-honey',
  violet: 'bg-violet',
  orange: 'bg-orange',
  rose: 'bg-rose',
  outline: 'bg-fg-subtle',
  ink: 'bg-fg',
};

/**
 * A tone as a **rule** — the leading edge that marks a row without tinting it (HIVE-7.8, #5325).
 *
 * The saturated role colour, like {@link STATUS_TONE_DOT_CLASS}: a 2 px rule is a mark, not
 * text, so it is held to the 3:1 non-text floor rather than to AA, and the `-fg` step would
 * read as a smudge at that width. Use it where a *list* of tinted rows would be a wall of
 * colour — the lint findings and the version diff both are — and let the row's own badge carry
 * the tone in a form a reader can name.
 */
export const STATUS_TONE_BORDER_CLASS: Readonly<Record<StatusTone, string>> = {
  neutral: 'border-neutral',
  ok: 'border-ok',
  warn: 'border-warn',
  danger: 'border-danger',
  accent: 'border-accent',
  honey: 'border-honey',
  violet: 'border-violet',
  orange: 'border-orange',
  rose: 'border-rose',
  outline: 'border-border-strong',
  ink: 'border-fg',
};

/**
 * A tone as **text on a page surface** — a pill's label, a gauge's centred letter.
 *
 * These are the `-fg` inks rather than the saturated `-` ones: the saturated hue is calibrated
 * to be read as a *fill*, and would not clear AA as body text on the canvas.
 */
export const STATUS_TONE_TEXT_CLASS: Readonly<Record<StatusTone, string>> = {
  neutral: 'text-neutral-fg',
  ok: 'text-ok-fg',
  warn: 'text-warn-fg',
  danger: 'text-danger-fg',
  accent: 'text-accent-fg',
  honey: 'text-honey-fg',
  violet: 'text-violet-fg',
  orange: 'text-orange-fg',
  rose: 'text-rose-fg',
  outline: 'text-fg-muted',
  ink: 'text-fg',
};

/**
 * The app's enum strings → tone. **This is the ticket.**
 *
 * Every entry is a value some part of the product actually returns: version lifecycle from the
 * REST versions API, visibility from projects and MCP endpoints, discovery/job status from the
 * sweep engine, lint severity from the linter, key and member state from admin, and the
 * maturity markers the UI adds itself. Grouped by the DESIGN.md §3.1 vocabulary they belong
 * to; the aliases beside each canonical value are the spellings other surfaces use for the
 * same idea, listed so nothing has to normalise before asking.
 *
 * A string that is not here resolves to `neutral` — the honest answer for a state the design
 * language has not been told about, and never a wrong colour.
 */
export const STATUS_TONE: Readonly<Record<string, StatusTone>> = {
  // ---- Version lifecycle ---------------------------------------------------
  draft: 'neutral',
  review: 'warn',
  published: 'ok',
  deprecated: 'orange',
  sunsetting: 'orange',
  sunset: 'danger',
  archived: 'outline',
  // A published revision is immutable (#2586): `locked` is the chip the Published surface
  // draws on every row (HIVE-8.1, #5327). `accent` is the mockup's `badge--info` — a
  // statement of fact about the artefact, not a step on a health scale. (`stable` and `beta`,
  // the other two `#739` lifecycle tags, are already spelled under *Maturity* below.)
  locked: 'accent',

  // ---- Visibility ----------------------------------------------------------
  private: 'violet',
  public: 'ok',
  internal: 'violet',

  // ---- Health / jobs -------------------------------------------------------
  healthy: 'ok',
  ok: 'ok',
  completed: 'ok',
  complete: 'ok',
  success: 'ok',
  succeeded: 'ok',
  pass: 'ok',
  passed: 'ok',
  verified: 'ok',
  reachable: 'ok',
  degraded: 'warn',
  running: 'warn',
  pending: 'warn',
  queued: 'warn',
  partial: 'warn',
  stale: 'warn',
  backoff: 'warn',
  down: 'danger',
  failed: 'danger',
  failure: 'danger',
  unreachable: 'danger',
  timeout: 'danger',
  quarantined: 'danger',
  blocked: 'danger',
  breaking: 'danger',
  unknown: 'neutral',

  // ---- Repository scanning and auto-refresh (HIVE-7.3, #5320) --------------
  // The states `/ade/dashboard/repositories` prints. `pending`, `stale`, `failed`, `error`
  // and `archived` were already in this table and are not restated. A scan in progress is
  // `accent` — the tone this table already spends on "informational, in flight" — and a
  // repository that has finished one is `ready`, which is the same fact as `active`.
  // `diverged` (RAR-4.4: the imported copy was edited after import, so auto-refresh is held)
  // is `violet` for the reason `false_positive` and `private` are: it records a *judgement*,
  // not a step on the healthy → broken scale, and amber would file it in a queue it does not
  // belong to.
  scanning: 'accent',
  ready: 'ok',
  'up-to-date': 'ok',
  refreshing: 'accent',
  diverged: 'violet',
  /** The middle of the three repository health levels (REPO-6.5). */
  warnings: 'warn',

  // ---- Discovered specs (HIVE-7.6, #5323) ----------------------------------
  // The four states `/ade/dashboard/repositories/catalog` files every discovered spec into.
  // They were four pairs of Tailwind palette classes inside the catalog's own module, which
  // is how the same "imported" ended up a different green from a published version. A spec
  // that has produced a version is `ok` for the same reason `completed` is; one the scanner
  // could not score is `warn`; one bound to a project but not yet imported is `accent`, the
  // tone this table already spends on "informational, in flight"; and one that has only been
  // indexed is `outline` — set aside, awaiting a decision, not a step on a health scale.
  needs_attention: 'warn',
  imported: 'ok',
  mapped: 'accent',
  discovered: 'outline',

  // ---- Lint severity -------------------------------------------------------
  error: 'danger',
  warning: 'warn',
  warn: 'warn',
  info: 'accent',
  hint: 'accent',

  // ---- Lint decision states (CLX-1.3; adopted by HIVE-5.8, #5311) -----------
  // The waiver state machine the lint workspace triages findings through. `open` is listed
  // rather than left to the fallback because it is the *start* of that machine, not a string
  // the vocabulary has not been told about — and a reader of this table should see all six
  // steps together. The tones are the ones `govern/lint-posture.html` paints: a decision
  // nobody has taken is neutral, one somebody has read is accent, a request is orange, a
  // granted waiver is warn (accepted risk, not a pass), a fix is ok, and a false positive is
  // violet — the same tone `private` takes, for the same reason: a judgement, not a level.
  open: 'neutral',
  acknowledged: 'accent',
  waiver_requested: 'orange',
  waived: 'warn',
  fixed: 'ok',
  false_positive: 'violet',

  // ---- Keys / members ------------------------------------------------------
  active: 'ok',
  revoked: 'danger',
  // Soft delete (HIVE-6.1, #5312). The same tone as `revoked`, and for the same reason: the
  // record still exists, but nothing may use it. `build/projects.html` paints it `--warn` on
  // the card and `--danger` in the table; one word cannot be two colours, and danger is the
  // one the rest of this table already spends on "withdrawn". The card's amber frame is
  // untouched — that marks the *Needs attention* facet, which disabled projects share.
  deleted: 'danger',
  disabled: 'outline',
  suspended: 'warn',
  invited: 'accent',
  expired: 'danger',

  // ---- Maturity ------------------------------------------------------------
  preview: 'accent',
  beta: 'accent',
  experimental: 'accent',
  stable: 'ok',
  new: 'honey',

  // ---- Marked by a person --------------------------------------------------
  pinned: 'honey',
  starred: 'honey',
};

/**
 * The tone a status string resolves to.
 *
 * @param status A vocabulary string in any case and with any surrounding space — `"Published"`,
 *   `" published "` and `"published"` all agree.
 * @returns The tone from {@link STATUS_TONE}, or `neutral` when the string is not in the
 *   vocabulary (including for an empty or absent string).
 */
export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) return 'neutral';
  return STATUS_TONE[status.trim().toLowerCase()] ?? 'neutral';
}

// ============================================================================
// Quality grades
// ============================================================================
// The A–F band is its own small vocabulary — five ordered steps rather than a set of states —
// but it belongs here for the same reason the rest does: the catalog table's `GradeChip` and
// the MCP `GradeGlyph` were each carrying their own A–F palette, so the same B meant two
// different greens. Both now read the bands below.

/** The five quality bands, best to worst. */
export type GradeLetter = 'A' | 'B' | 'C' | 'D' | 'F';

/** The bands in order, for legends and for exhaustive tests. */
export const GRADE_LETTERS: readonly GradeLetter[] = ['A', 'B', 'C', 'D', 'F'] as const;

/**
 * B sits between "good" and "needs a look", and hive.css §20 gives it exactly that: `--ok`
 * pulled 30% of the way towards honey. Spelled as a `color-mix` of two tokens rather than as a
 * sixth colour, so it swaps with the theme like everything else.
 */
const GRADE_B_FILL = 'bg-[color-mix(in_srgb,var(--ok)_70%,var(--honey))]';
/** The on-surface ink for band B — the same mix taken between the two `-fg` inks. */
const GRADE_B_INK = 'text-[color-mix(in_srgb,var(--ok-fg)_70%,var(--honey-fg))]';
/** The gauge arc for band B. The arc paints from `currentColor`, so this is a text colour. */
const GRADE_B_ARC = 'text-[color-mix(in_srgb,var(--ok)_70%,var(--honey))]';

/** How one quality band is painted, in the three places a grade appears. */
export interface GradeBand {
  /** The band letter, or `null` for the unscored band. */
  letter: GradeLetter | null;
  /** The status tone the band belongs to — its place in the wider vocabulary. */
  tone: StatusTone;
  /** Solid tile: the fill plus an ink that stays legible on it (the letter chip). */
  solidClass: string;
  /** The band as text on a page surface (the score beside the letter, the gauge centre). */
  textClass: string;
  /** The band as a gauge arc. The arc strokes `currentColor`, so this is a `text-*` class. */
  arcClass: string;
}

/**
 * The A–F bands, mirroring `hive.css` §20 `.grade[data-grade]`: A is `--ok`, B is ok-towards-
 * honey, C is `--warn`, D is `--orange`, F is `--danger`.
 */
export const GRADE_BANDS: Readonly<Record<GradeLetter, GradeBand>> = {
  A: {
    letter: 'A',
    tone: 'ok',
    solidClass: STATUS_TONE_SOLID_CLASS.ok,
    textClass: STATUS_TONE_TEXT_CLASS.ok,
    arcClass: 'text-ok',
  },
  B: {
    letter: 'B',
    tone: 'ok',
    solidClass: `${GRADE_B_FILL} text-fg-on-accent`,
    textClass: GRADE_B_INK,
    arcClass: GRADE_B_ARC,
  },
  C: {
    letter: 'C',
    tone: 'warn',
    solidClass: STATUS_TONE_SOLID_CLASS.warn,
    textClass: STATUS_TONE_TEXT_CLASS.warn,
    arcClass: 'text-warn',
  },
  D: {
    letter: 'D',
    tone: 'orange',
    solidClass: STATUS_TONE_SOLID_CLASS.orange,
    textClass: STATUS_TONE_TEXT_CLASS.orange,
    arcClass: 'text-orange',
  },
  F: {
    letter: 'F',
    tone: 'danger',
    solidClass: STATUS_TONE_SOLID_CLASS.danger,
    textClass: STATUS_TONE_TEXT_CLASS.danger,
    arcClass: 'text-danger',
  },
};

/**
 * The band for something that has not been graded yet — a well rather than a fill, so an
 * ungraded row reads as *absent* rather than as a sixth, worse grade.
 */
export const GRADE_BAND_UNSCORED: GradeBand = {
  letter: null,
  tone: 'outline',
  solidClass: STATUS_TONE_SOLID_CLASS.outline,
  textClass: STATUS_TONE_TEXT_CLASS.outline,
  arcClass: 'text-fg-subtle',
};

/**
 * Normalise a raw grade token to one of the A–F bands.
 *
 * Uses the uppercased first character, so a fuller grade (`A+`, `b-`) still lands on its band.
 *
 * @param grade The raw grade token, or null/undefined.
 * @returns The band letter, or `null` when the token is empty or is not one of A/B/C/D/F
 *   (`E` is deliberately not a band).
 */
export function normalizeGradeLetter(grade: string | null | undefined): GradeLetter | null {
  if (!grade || !grade.trim()) return null;
  const first = grade.trim().charAt(0).toUpperCase();
  return (GRADE_LETTERS as readonly string[]).includes(first) ? (first as GradeLetter) : null;
}

/**
 * Resolve a raw grade token to the band that paints it.
 *
 * @param grade The raw grade token, or null/undefined.
 * @returns The matching {@link GradeBand}, or {@link GRADE_BAND_UNSCORED} when there is no
 *   recognised band — which is also what an unknown-but-present token gets, so its raw letter
 *   can still be shown without inventing a colour for it.
 */
export function gradeBand(grade: string | null | undefined): GradeBand {
  const letter = normalizeGradeLetter(grade);
  return letter ? GRADE_BANDS[letter] : GRADE_BAND_UNSCORED;
}
