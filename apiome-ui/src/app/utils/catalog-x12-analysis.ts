/**
 * EDI X12 interchange derivations for the Format details tab (CPDO-2.2, #4798).
 *
 * CPDO-2.1 gave every analyzer one shell: a generic tree, a generic attribute renderer, a generic
 * value statement. That is the right *floor*, and for X12 it is not the ceiling. An interchange is
 * not a bag of nodes — it is an envelope with declared delimiters, control totals that either agree
 * with the body or do not, functional groups carrying transaction sets identified by number and
 * version, segments that repeat, and element positions that were written and left empty. Reading
 * those off a tree of generic rows is work a reader should not have to do.
 *
 * This module does it, as **pure functions over the record CPDO-1.2's X12 extractor produced**.
 * Nothing here parses anything, and nothing derives a fact the record does not carry: an attribute
 * the analyzer did not set yields an absent field, never a default. The panel that renders these is
 * `CatalogX12InspectorPanel`; keeping the rules here makes every one of them testable without a DOM.
 *
 * **Two things it will not do.**
 *
 *  - It never presents an *observed* fact as a *validated* one. Everything in an X12 record is what
 *    the interchange said; no implementation guide (4010/5010) was consulted, and an ST03
 *    convention reference is the sender's claim rather than a checked one. {@link x12ConformanceStatement}
 *    is that sentence, and the panel always renders it.
 *  - It never reads an observed value. The envelope attributes it surfaces are structure — ids,
 *    controls, delimiters, counts — and element values stay behind {@link nodeValueStatement}, where
 *    the value-visibility policy governs them.
 */

import {
  analysisNodeLabel,
  type AnalysisDocument,
  type AnalysisNode,
  type AnalysisSourceLocation,
} from './catalog-payload-analysis';

/** Node kinds the X12 extractor emits, in nesting order (mirrors `edix12_analysis.py`). */
export const X12_KIND_INTERCHANGE = 'interchange';
export const X12_KIND_FUNCTIONAL_GROUP = 'functional_group';
export const X12_KIND_TRANSACTION_SET = 'transaction_set';
export const X12_KIND_SEGMENT = 'segment';
export const X12_KIND_ELEMENT = 'element';
export const X12_KIND_COMPOSITE = 'composite';
export const X12_KIND_COMPONENT = 'component';
export const X12_KIND_REPETITION = 'repetition';

/** The analyzer key and the source-format aliases an X12 record can be filed under. */
const X12_ANALYZER_KEY = 'edix12';
const X12_FORMAT_KEYS = new Set(['edix12', 'edi-x12', 'x12', 'edi']);

/** The analyzer warning codes this inspector gives dedicated wording to. */
export const X12_WARNING_CANONICAL_SUBSET = 'x12.canonical_projection_subset';

/**
 * Whether a record was produced by the X12 extractor and can drive this inspector.
 *
 * The analyzer key is the authority — a record says which analyzer wrote it — and the item's
 * `sourceFormat` is only a fallback for a record that did not record one. A generic walk over some
 * other format is never rendered as an interchange just because the catalog item is filed under an
 * EDI-ish key.
 *
 * @param document The analysis document, if one is loaded.
 * @param sourceFormat The catalog item's raw source format.
 * @returns True when the X12 inspector applies.
 */
export function isX12Analysis(
  document: AnalysisDocument | null | undefined,
  sourceFormat?: string | null,
): boolean {
  const analyzerKey = document?.analyzer?.key;
  if (analyzerKey) return analyzerKey === X12_ANALYZER_KEY;
  const format = (document?.sourceFormat ?? sourceFormat ?? '').trim().toLowerCase();
  return X12_FORMAT_KEYS.has(format);
}

// ---------------------------------------------------------------------------
// Attribute readers
// ---------------------------------------------------------------------------

/**
 * One attribute as a trimmed string, or null when the analyzer did not set it.
 *
 * @param node The tree node.
 * @param name The attribute key.
 * @returns The value, or null. An empty string is null: an attribute set to nothing states nothing.
 */
export function x12Text(node: AnalysisNode | null | undefined, name: string): string | null {
  const value = node?.attributes?.[name];
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * One attribute as a number, or null when it is absent or not a finite number.
 *
 * @param node The tree node.
 * @param name The attribute key.
 * @returns The number, or null — never a zero standing in for "not recorded".
 */
export function x12Number(node: AnalysisNode | null | undefined, name: string): number | null {
  const value = node?.attributes?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Delimiters
// ---------------------------------------------------------------------------

/** One declared delimiter, rendered so an invisible or ambiguous character is still readable. */
export interface X12Separator {
  /** What the delimiter separates (`Element`, `Component`, …). */
  label: string;
  /** The character itself, when the record carries it. */
  character: string | null;
  /** Its Unicode code point (`U+002A`), so a look-alike character is not mistaken for another. */
  codePoint: string | null;
  /** Why there is no character, when there is none. Null when there is one. */
  absence: string | null;
}

/**
 * `U+002A`-style rendering of a single character.
 *
 * @param character The delimiter character.
 * @returns The code point, or null for an empty string. Astral characters render their full point.
 */
export function x12CodePoint(character: string | null | undefined): string | null {
  if (!character) return null;
  const point = character.codePointAt(0);
  if (point === undefined) return null;
  return `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The four delimiters the interchange declared in its own ISA header.
 *
 * A repetition separator is genuinely optional: X12 only made ISA11 a delimiter at version 00501,
 * so at 00401 there is no such thing rather than a missing one. The record states which, and this
 * carries that statement through instead of rendering an empty cell either way.
 *
 * @param interchange The `interchange` root node.
 * @returns The four separators in declaration order.
 */
export function x12Separators(interchange: AnalysisNode | null | undefined): X12Separator[] {
  const declared = interchange?.attributes?.repetitionSeparatorDeclared;
  const repetition = x12Text(interchange, 'repetitionSeparator');
  const repetitionAbsence =
    declared === false
      ? 'This interchange version does not define a repetition separator, so nothing repeats by delimiter.'
      : repetition === null
        ? 'The record does not state a repetition separator for this interchange.'
        : null;

  return [
    entry('Element', x12Text(interchange, 'elementSeparator')),
    entry('Component', x12Text(interchange, 'componentSeparator')),
    { label: 'Repetition', character: repetition, codePoint: x12CodePoint(repetition), absence: repetitionAbsence },
    entry('Segment terminator', x12Text(interchange, 'segmentTerminator')),
  ];

  function entry(label: string, character: string | null): X12Separator {
    return {
      label,
      character,
      codePoint: x12CodePoint(character),
      absence: character === null ? 'The record does not carry this delimiter.' : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Control totals
// ---------------------------------------------------------------------------

/** A count the interchange declared in a trailer, beside the count actually observed. */
export interface X12ControlTotal {
  /** What is being counted (`Functional groups`, `Transaction sets`, `Segments`). */
  label: string;
  /** The trailer element the declaration came from (`IEA01`, `GE01`, `SE01`). */
  declaredBy: string;
  /** What the trailer said, or null when the record carries no declaration. */
  declared: number | null;
  /** What the analysis actually observed. */
  observed: number;
  /** True only when both numbers are known and they disagree. */
  mismatched: boolean;
}

/**
 * Build one declared-versus-observed row.
 *
 * A missing declaration is **not** a mismatch: an interchange truncated before its IEA, or a
 * trailer whose count could not be read as a number, has nothing to disagree with. Only two known
 * numbers that differ are ever flagged.
 *
 * @param label What is counted.
 * @param declaredBy The trailer element the declaration came from.
 * @param declared The declared count, or null.
 * @param observed The observed count.
 * @returns The row.
 */
export function x12ControlTotal(
  label: string,
  declaredBy: string,
  declared: number | null,
  observed: number,
): X12ControlTotal {
  return {
    label,
    declaredBy,
    declared,
    observed,
    mismatched: declared !== null && declared !== observed,
  };
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/** The interchange envelope as the inspector's header renders it. */
export interface X12Envelope {
  node: AnalysisNode;
  senderId: string | null;
  receiverId: string | null;
  controlNumber: string | null;
  version: string | null;
  date: string | null;
  time: string | null;
  /** The raw ISA15 code (`P`/`T`/`I`), when recorded. */
  usageIndicator: string | null;
  /** The word the analyzer paired with that code — never re-derived here. */
  usageLabel: string | null;
  /** True only for a code the analyzer resolved to production. */
  isProduction: boolean;
  acknowledgmentRequested: string | null;
  separators: X12Separator[];
  groupTotal: X12ControlTotal;
}

/**
 * Read the interchange envelope off the tree.
 *
 * @param tree The record's root nodes.
 * @returns The envelope, or null when the record carries no `interchange` root — no record, no
 *   inspector, exactly as CPDO-2.1's shell behaves.
 */
export function x12Envelope(tree: readonly AnalysisNode[]): X12Envelope | null {
  const node = tree.find((root) => root.kind === X12_KIND_INTERCHANGE);
  if (!node) return null;
  const usageLabel = x12Text(node, 'usageIndicatorLabel');
  return {
    node,
    senderId: x12Text(node, 'senderId'),
    receiverId: x12Text(node, 'receiverId'),
    controlNumber: x12Text(node, 'controlNumber'),
    version: x12Text(node, 'interchangeVersion'),
    date: x12Text(node, 'date'),
    time: x12Text(node, 'time'),
    usageIndicator: x12Text(node, 'usageIndicator'),
    usageLabel,
    isProduction: usageLabel === 'Production',
    acknowledgmentRequested: x12Text(node, 'acknowledgmentRequested'),
    separators: x12Separators(node),
    groupTotal: x12ControlTotal(
      'Functional groups',
      'IEA01',
      x12Number(node, 'declaredFunctionalGroupCount'),
      (node.children ?? []).filter((child) => child.kind === X12_KIND_FUNCTIONAL_GROUP).length,
    ),
  };
}

// ---------------------------------------------------------------------------
// Groups and transaction sets
// ---------------------------------------------------------------------------

/** One transaction set as the inspector's table renders it. */
export interface X12TransactionSummary {
  node: AnalysisNode;
  /** The set id — `850`, `997`, `837`. */
  setId: string | null;
  controlNumber: string | null;
  /** ST03, the implementation convention the *sender claims* to have followed. Never validated. */
  implementationConvention: string | null;
  segmentTotal: X12ControlTotal;
  /** Segment ids that occur more than once, with their counts, most frequent first. */
  repeatedSegments: Array<{ segmentId: string; count: number }>;
  /** True when this is the set the canonical conversion was derived from. */
  converted: boolean;
}

/** One functional group as the inspector's table renders it. */
export interface X12GroupSummary {
  node: AnalysisNode;
  functionalId: string | null;
  /** GS08 — the version/release/industry code the group declares. */
  version: string | null;
  controlNumber: string | null;
  sender: string | null;
  receiver: string | null;
  date: string | null;
  time: string | null;
  responsibleAgencyCode: string | null;
  transactionTotal: X12ControlTotal;
  transactions: X12TransactionSummary[];
}

/**
 * Count each segment id that occurs more than once inside one transaction set.
 *
 * Read from the segments' own `repeatCount` attribute rather than by counting rows, so a bounded
 * analysis that dropped some segment nodes still reports what the source had rather than what
 * survived the budget. A transaction set whose segments were dropped entirely reports nothing,
 * which is the truthful answer for it.
 *
 * @param transaction The `transaction_set` node.
 * @returns `{segmentId, count}` for each repeated id, highest count first then alphabetical.
 */
export function x12RepeatedSegments(
  transaction: AnalysisNode | null | undefined,
): Array<{ segmentId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const child of transaction?.children ?? []) {
    if (child.kind !== X12_KIND_SEGMENT) continue;
    const id = x12Text(child, 'segmentId') ?? child.name;
    const count = x12Number(child, 'repeatCount');
    if (!id || count === null || count <= 1) continue;
    counts.set(id, count);
  }
  return [...counts.entries()]
    .map(([segmentId, count]) => ({ segmentId, count }))
    .sort((a, b) => b.count - a.count || a.segmentId.localeCompare(b.segmentId));
}

/**
 * Read every functional group and every transaction set the record carries.
 *
 * "Every" is the point. The canonical model keeps the first group's first transaction set, and the
 * whole reason a stored analysis exists is that the rest are here — so this walks the tree rather
 * than stopping at the first of anything.
 *
 * @param tree The record's root nodes.
 * @returns The groups in source order, each with its transaction sets. The first transaction set of
 *   the first group is flagged `converted`, which is the one the OpenAPI projection came from.
 */
export function x12Groups(tree: readonly AnalysisNode[]): X12GroupSummary[] {
  const interchange = tree.find((root) => root.kind === X12_KIND_INTERCHANGE);
  const groups = (interchange?.children ?? []).filter(
    (child) => child.kind === X12_KIND_FUNCTIONAL_GROUP,
  );

  return groups.map((group, groupIndex) => {
    const transactions = (group.children ?? []).filter(
      (child) => child.kind === X12_KIND_TRANSACTION_SET,
    );
    return {
      node: group,
      functionalId: x12Text(group, 'functionalId'),
      version: x12Text(group, 'version'),
      controlNumber: x12Text(group, 'controlNumber'),
      sender: x12Text(group, 'sender'),
      receiver: x12Text(group, 'receiver'),
      date: x12Text(group, 'date'),
      time: x12Text(group, 'time'),
      responsibleAgencyCode: x12Text(group, 'responsibleAgencyCode'),
      transactionTotal: x12ControlTotal(
        'Transaction sets',
        'GE01',
        x12Number(group, 'declaredTransactionSetCount'),
        x12Number(group, 'transactionSetCount') ?? transactions.length,
      ),
      transactions: transactions.map((transaction, transactionIndex) => ({
        node: transaction,
        setId: x12Text(transaction, 'setId'),
        controlNumber: x12Text(transaction, 'controlNumber'),
        implementationConvention: x12Text(transaction, 'implementationConventionReference'),
        segmentTotal: x12ControlTotal(
          'Segments',
          'SE01',
          x12Number(transaction, 'declaredSegmentCount'),
          x12Number(transaction, 'envelopeSegmentCount') ??
            (x12Number(transaction, 'segmentCount') ?? 0) + 2,
        ),
        repeatedSegments: x12RepeatedSegments(transaction),
        converted: groupIndex === 0 && transactionIndex === 0,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** What the canonical conversion was derived from, and what it was not. */
export interface X12ConversionScope {
  /** Total transaction sets the interchange carried. */
  observedTransactions: number;
  /** Total functional groups it carried. */
  observedGroups: number;
  /** The set the conversion came from, e.g. `850 (0001)`. Null when the record has no set at all. */
  convertedLabel: string | null;
  /** True when the conversion read less than the interchange carried. */
  isSubset: boolean;
  /** The sentence to render. Never hedged — it either was a subset or it was not. */
  statement: string;
}

/**
 * State what the OpenAPI conversion was derived from.
 *
 * The X12 normalizer reads the first functional group's first transaction set, because a canonical
 * model describes one schema. That is correct and, on every other screen, invisible: a reader
 * looking at a converted OpenAPI has no way to tell whether it describes their whole interchange or
 * a sixth of it. The analysis knows both numbers, so the inspector says so outright.
 *
 * @param groups The groups from {@link x12Groups}.
 * @returns The scope, with a rendered sentence for either case.
 */
export function x12ConversionScope(groups: readonly X12GroupSummary[]): X12ConversionScope {
  const observedTransactions = groups.reduce((total, group) => total + group.transactions.length, 0);
  const converted = groups[0]?.transactions[0] ?? null;
  const convertedLabel = converted
    ? `${converted.setId ?? analysisNodeLabel(converted.node)}${
        converted.controlNumber ? ` (${converted.controlNumber})` : ''
      }`
    : null;
  const isSubset = observedTransactions > 1;

  const statement = !convertedLabel
    ? 'This analysis carries no transaction set, so nothing can be said about what the conversion was derived from.'
    : isSubset
      ? `The canonical model and the converted OpenAPI are derived from transaction set ${convertedLabel} alone. This interchange carries ${observedTransactions} transaction sets across ${groups.length} functional ${
          groups.length === 1 ? 'group' : 'groups'
        }; the other ${observedTransactions - 1} are described here and nowhere else.`
    : `This interchange carries one transaction set, ${convertedLabel}, and the canonical model is derived from it — so the conversion describes the whole interchange.`;

  return {
    observedTransactions,
    observedGroups: groups.length,
    convertedLabel,
    isSubset,
    statement,
  };
}

/**
 * The observed-versus-validated sentence, rendered on every X12 record without exception.
 *
 * An X12 inspector that shows segment ids, element positions and version codes looks exactly like a
 * conformance report, and it is not one. Saying so once, always, in the same place, is the only
 * thing that stops the resemblance from becoming a claim.
 *
 * @returns The sentence.
 */
export function x12ConformanceStatement(): string {
  return 'Everything here is what the interchange itself declared. No 4010 or 5010 implementation guide was consulted, no segment or element was checked against one, and an ST03 implementation convention reference is recorded as the sender’s claim rather than as a verified fact.';
}

// ---------------------------------------------------------------------------
// Source ranges
// ---------------------------------------------------------------------------

/** An exact range of the raw source a construct was read from. */
export interface X12SourceRange {
  /** 0-based character offset. */
  offset: number;
  /** Length in characters; always at least 1. */
  length: number;
  /** The 1-based line the range starts on, when the record carries one. */
  line: number | null;
}

/**
 * The raw-source range a node points at, or null when it points at no range.
 *
 * This is the narrower question than {@link sourceLocationText}: a location may describe a
 * structural path and still address no bytes. Only an offset *and* a positive length is a range a
 * viewer can select — anything less would highlight the wrong thing, which is worse than
 * highlighting nothing.
 *
 * @param location The node's location, if any.
 * @returns The range, or null.
 */
export function x12SourceRange(
  location: AnalysisSourceLocation | null | undefined,
): X12SourceRange | null {
  const offset = location?.offset;
  const length = location?.length;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null;
  if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0) return null;
  const line = location?.line;
  return {
    offset,
    length,
    line: typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null,
  };
}

// ---------------------------------------------------------------------------
// Element presence
// ---------------------------------------------------------------------------

/** How an element position's value stands, as one closed vocabulary. */
export type X12ElementPresence = 'valued' | 'empty' | 'withheld' | 'absent' | 'unrecorded';

/** Reviewed wording per presence state. The badge text always carries the meaning. */
const PRESENCE_PRESENTATION: Record<
  X12ElementPresence,
  { label: string; tone: 'positive' | 'neutral' | 'caution' }
> = {
  valued: { label: 'Has a value', tone: 'positive' },
  empty: { label: 'Present, empty', tone: 'caution' },
  withheld: { label: 'Withheld', tone: 'neutral' },
  absent: { label: 'Not present', tone: 'neutral' },
  unrecorded: { label: 'Not recorded', tone: 'neutral' },
};

/**
 * Classify what an element node says about its value.
 *
 * The four X12-relevant states are genuinely different facts about the payload and the whole reason
 * CPDO-2.2 re-reads the source text:
 *
 *  - **empty** — the source wrote the delimiter and put nothing between them;
 *  - **absent** — the source never wrote the position at all;
 *  - **withheld** — a value was observed and the visibility policy suppressed it;
 *  - **valued** — the record carries what was there.
 *
 * A node that carries a repeat count is classified from its occurrences instead: the element itself
 * holds no value, and calling it unrecorded would misdescribe a position that repeated three times.
 *
 * @param node The element node.
 * @returns The presence state.
 */
export function x12ElementPresence(node: AnalysisNode): X12ElementPresence {
  if (typeof node.value === 'string') return 'valued';
  if (node.redacted) return 'withheld';
  const repeats = x12Number(node, 'repeatCount');
  if (repeats !== null && repeats > 1) return 'valued';
  if ((node.children ?? []).length > 0) return 'valued';
  if (node.valuePresent === true) return node.valueLength === 0 ? 'empty' : 'withheld';
  if (node.valuePresent === false) return 'absent';
  return 'unrecorded';
}

/**
 * The reviewed badge for a presence state.
 *
 * @param presence The state from {@link x12ElementPresence}.
 * @returns Its label and colour-independent tone.
 */
export function x12PresencePresentation(presence: X12ElementPresence): {
  label: string;
  tone: 'positive' | 'neutral' | 'caution';
} {
  return PRESENCE_PRESENTATION[presence];
}

/**
 * The reference designator a node is known by, e.g. `BEG04` or `CLM05-2`.
 *
 * @param node The element/composite/component node.
 * @returns The designator from `attributes.reference`, falling back to the node's name, or null.
 */
export function x12Reference(node: AnalysisNode): string | null {
  return x12Text(node, 'reference') ?? (node.name?.trim() || null);
}

// ---------------------------------------------------------------------------
// Warning wording
// ---------------------------------------------------------------------------

/**
 * The analyzer's own canonical-subset warning, when the record carries one.
 *
 * The panel prefers its own {@link x12ConversionScope} sentence — derived from the tree, so it is
 * true of the record in hand — and uses this only to confirm the analyzer agrees. Surfacing both
 * would say the same thing twice.
 *
 * @param document The analysis document.
 * @returns The warning message, or null.
 */
export function x12CanonicalSubsetWarning(
  document: AnalysisDocument | null | undefined,
): string | null {
  const warning = (document?.warnings ?? []).find(
    (entry) => entry.code === X12_WARNING_CANONICAL_SUBSET,
  );
  return warning?.message?.trim() || null;
}
