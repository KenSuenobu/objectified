/**
 * The rules behind the response-correlation editor (#5529, MSC-1.3).
 *
 * Everything here is pure — mode copy, draft ⇄ wire conversion, row validation, and the mapping
 * from a REST 422 back onto the row that caused it. Keeping it out of the dialog is what lets the
 * contract be tested directly, and the mode copy be written once for the cards, the preview panel
 * and the scenario editor's note.
 *
 * The mode/pointer-map contract is MSC-1.1's and is not re-litigated here: `mode` selects which
 * *inference* passes run, and the `operations` pointer map applies in every mode except `off`,
 * always last, always winning. Bindings saved with `mode: "off"` are a 422 rather than a silent
 * no-op, so this module refuses them client-side too and says which mode to pick instead.
 */

/** The four correlation modes, in increasing order of what they bind. */
export type CorrelationMode = 'off' | 'path-params' | 'inferred' | 'explicit';

/** Every mode, in the order the cards render. */
export const CORRELATION_MODES: readonly CorrelationMode[] = [
  'off',
  'path-params',
  'inferred',
  'explicit',
] as const;

/** How one mode is presented: a short name and one line about what it does to a response. */
export interface CorrelationModeCopy {
  /** The card's title. */
  label: string;
  /**
   * One line describing the effect on a response — deliberately about values, not vocabulary, so
   * an author can choose without first learning what "inference pass" means.
   */
  description: string;
  /** Whether this mode runs any inference (drives the read-only bindings preview). */
  infers: boolean;
}

/** The two modes that run an inference pass — the ones the bindings preview can project. */
export type CorrelationInferenceMode = Extract<CorrelationMode, 'path-params' | 'inferred'>;

/**
 * Whether a mode runs inference, narrowing the type so the preview cannot be handed `off`.
 *
 * @param mode - The mode to test.
 * @returns True for `path-params` and `inferred`.
 */
export function isInferenceMode(mode: CorrelationMode): mode is CorrelationInferenceMode {
  return mode === 'path-params' || mode === 'inferred';
}

/** Card copy for every mode. */
export const CORRELATION_MODE_COPY: Record<CorrelationMode, CorrelationModeCopy> = {
  off: {
    label: 'Off',
    description:
      'Responses ignore the request. GET /pets/42 comes back with whatever the spec example says, the same for every id.',
    infers: false,
  },
  'path-params': {
    label: 'Match path parameters',
    description:
      'A response property named after a path parameter takes the request’s value, so GET /pets/42 answers with an id of 42.',
    infers: true,
  },
  inferred: {
    label: 'Match and echo',
    description:
      'Everything above, plus POST and PUT send back the fields you posted — enriched with the server-assigned ones like id and createdAt.',
    infers: true,
  },
  explicit: {
    label: 'Only my bindings',
    description:
      'No guessing at all. Only the bindings you list below are applied, for the cases where a guess would be wrong.',
    infers: false,
  },
};

/** One explicit binding row as the editor holds it (text fields until save). */
export interface CorrelationBindingDraft {
  /** The operation this binding targets, as `"METHOD /path/{template}"`; blank until picked. */
  operationKey: string;
  /** The response JSON Pointer the value lands at. */
  pointer: string;
  /** The template expression that produces the value. */
  expression: string;
}

/** The whole editor's state. */
export interface CorrelationDraft {
  mode: CorrelationMode;
  bindings: CorrelationBindingDraft[];
}

/** The stored wire shape (`GET|PUT .../mock/correlation`). */
export interface CorrelationPayload {
  mode: CorrelationMode;
  operations: Record<string, Record<string, string>>;
}

/** The empty editor state: correlation off, no bindings. */
export const EMPTY_CORRELATION_DRAFT: CorrelationDraft = { mode: 'off', bindings: [] };

/** One validation message, attached to the row that caused it when there is one. */
export interface CorrelationRowError {
  /** Index into `CorrelationDraft.bindings`, or `null` for a message about the block as a whole. */
  row: number | null;
  message: string;
}

/**
 * Turn the stored block into editor state.
 *
 * Rows are flattened out of the `{operation: {pointer: expression}}` map in stored order, because
 * a row editor cannot show a nested map and stored order is what the runtime applies.
 *
 * @param payload - The stored block, or `null` when the version has none.
 * @returns The editable draft.
 */
export function draftFromPayload(payload: CorrelationPayload | null | undefined): CorrelationDraft {
  if (!payload) return { ...EMPTY_CORRELATION_DRAFT, bindings: [] };
  const bindings: CorrelationBindingDraft[] = [];
  for (const [operationKey, pointers] of Object.entries(payload.operations ?? {})) {
    for (const [pointer, expression] of Object.entries(pointers ?? {})) {
      bindings.push({ operationKey, pointer, expression: String(expression) });
    }
  }
  return { mode: payload.mode ?? 'off', bindings };
}

/**
 * Validate one binding row on its own.
 *
 * Checks only what the editor can know without the server: that the row is filled in, that the
 * pointer is a pointer, and that the expression looks like a template. Template *grammar* is the
 * server's to judge — it owns the language — and its verdict comes back onto this same row.
 *
 * @param row - The row to check.
 * @returns A message per problem, in the order a reader would fix them.
 */
export function validateBindingRow(row: CorrelationBindingDraft): string[] {
  const messages: string[] = [];
  if (!row.operationKey.trim()) {
    messages.push('Pick the operation this binding applies to.');
  }
  const pointer = row.pointer.trim();
  if (!pointer) {
    messages.push('Enter the response property this binds, as a JSON Pointer like /id.');
  } else if (pointer !== '' && !pointer.startsWith('/')) {
    messages.push('A JSON Pointer must start with "/" — /id, not id.');
  }
  const expression = row.expression.trim();
  if (!expression) {
    messages.push('Enter the value to bind, e.g. {{request.path.petId}}.');
  } else if (!expression.includes('{{')) {
    messages.push(
      'This binds a constant. Insert a token like {{request.path.petId}} to use a request value.'
    );
  }
  return messages;
}

/** How an untouched row is treated when the draft is converted. */
export interface PayloadOptions {
  /**
   * Drop a wholly blank row instead of reporting it.
   *
   * The live preview passes `true`: an author who has just clicked *Add binding* still wants to see
   * what the current mode does, and refusing to render until the new row is filled in would break
   * the loop this editor exists to provide. A **save** leaves it `false`, because storing a block
   * that quietly discards a row an author deliberately added is the kind of silent no-op MSC-1.1
   * already refused for `mode: "off"`.
   */
  ignoreBlankRows?: boolean;
}

/**
 * Convert the editor state into the wire shape, reporting per-row problems.
 *
 * @param draft - The current editor state.
 * @param options - see {@link PayloadOptions}.
 * @returns The payload to send (`null` clears the block), and any errors that block the save.
 */
export function payloadFromDraft(
  draft: CorrelationDraft,
  options: PayloadOptions = {}
): {
  payload: CorrelationPayload | null;
  errors: CorrelationRowError[];
} {
  const { ignoreBlankRows = false } = options;
  const errors: CorrelationRowError[] = [];
  const rows = draft.bindings.filter(
    (row) => row.operationKey.trim() || row.pointer.trim() || row.expression.trim()
  );

  if (draft.mode === 'off') {
    if (rows.length > 0) {
      // MSC-1.1's contract: the runtime drops the whole block when the mode is off, so bindings
      // saved beside it would never run. Say which mode keeps them instead of failing silently.
      errors.push({
        row: null,
        message:
          'Bindings cannot be saved with correlation off — they would never run. Choose “Only my bindings” to apply just the list below.',
      });
    }
    return { payload: errors.length > 0 ? null : { mode: 'off', operations: {} }, errors };
  }

  const operations: Record<string, Record<string, string>> = {};
  draft.bindings.forEach((row, index) => {
    const blank = !row.operationKey.trim() && !row.pointer.trim() && !row.expression.trim();
    if (blank && ignoreBlankRows) return;
    const rowErrors = validateBindingRow(row);
    if (rowErrors.length > 0) {
      errors.push(...rowErrors.map((message) => ({ row: index, message })));
      return;
    }
    const key = row.operationKey.trim();
    const pointer = row.pointer.trim();
    const existing = operations[key];
    if (existing && pointer in existing) {
      errors.push({
        row: index,
        message: `${key} already binds ${pointer} above — one pointer can only take one value.`,
      });
      return;
    }
    operations[key] = { ...(existing ?? {}), [pointer]: row.expression.trim() };
  });

  if (errors.length > 0) return { payload: null, errors };
  return { payload: { mode: draft.mode, operations }, errors: [] };
}

/**
 * Whether a draft is worth persisting at all.
 *
 * @param draft - The current editor state.
 * @returns True when the version would be left with no correlation.
 */
export function draftIsEmpty(draft: CorrelationDraft): boolean {
  return (
    draft.mode === 'off' &&
    draft.bindings.every(
      (row) => !row.operationKey.trim() && !row.pointer.trim() && !row.expression.trim()
    )
  );
}

/** REST spells its correlation errors `Correlation, operation 'KEY'[, pointer 'PTR']: message`. */
const SERVER_ERROR_CONTEXT = /operation '([^']+)'(?:, pointer '([^']*)')?/;

/**
 * Attach the server's validation messages to the rows that caused them.
 *
 * The 422 list REST returns is flat, and a flat list under a form is the feedback loop this editor
 * exists to replace. Each message names its operation (and often its pointer), so it can be put
 * back on the row an author has to change; anything that names no row stays at block level rather
 * than being guessed onto one.
 *
 * @param messages - The `errors` array from a failed save.
 * @param bindings - The rows currently on screen.
 * @returns One entry per message, with `row` set when it could be placed.
 */
export function attachServerErrors(
  messages: readonly string[],
  bindings: readonly CorrelationBindingDraft[]
): CorrelationRowError[] {
  return messages.map((message) => {
    const match = SERVER_ERROR_CONTEXT.exec(message);
    if (!match) return { row: null, message };
    const [, operationKey, pointer] = match;
    const candidates = bindings
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.operationKey.trim() === operationKey);
    if (candidates.length === 0) return { row: null, message };
    const exact =
      pointer !== undefined
        ? candidates.find(({ row }) => row.pointer.trim() === pointer)
        : undefined;
    return { row: (exact ?? candidates[0]).index, message };
  });
}

/**
 * Pick the messages that belong to one row.
 *
 * @param errors - Every error currently held.
 * @param index - The row being rendered.
 * @returns The messages to show under that row.
 */
export function errorsForRow(
  errors: readonly CorrelationRowError[],
  index: number
): CorrelationRowError[] {
  return errors.filter((error) => error.row === index);
}

/**
 * Pick the messages that belong to no particular row.
 *
 * @param errors - Every error currently held.
 * @returns The messages to show above the rows.
 */
export function blockErrors(errors: readonly CorrelationRowError[]): CorrelationRowError[] {
  return errors.filter((error) => error.row === null);
}
