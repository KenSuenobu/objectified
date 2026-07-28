/**
 * COBOL copybook layout derivations for the Format details tab (CPDO-2.3, #4799).
 *
 * CPDO-2.1's tree renders any analyzer's nodes as rows and any analyzer's attributes as key/value
 * pairs. For a copybook that floor leaves out the thing a copybook actually *is*: a positional
 * description. `PIC S9(9)V99 COMP-3` does not merely say "a number with two decimals" — it says six
 * bytes, packed, and the field after it starts six bytes further into the record. A reader who
 * cannot see that is reading a field list, not a layout.
 *
 * This module turns the record CPDO-1.2's extractor produced (with CPDO-2.3's storage arithmetic on
 * it) into the shapes the inspector renders, as **pure functions over the record and nothing else**.
 * The rule it exists to keep is the ticket's last acceptance criterion — *no semantics are guessed
 * from absent source data* — and it shows up in every derivation here:
 *
 * - an item with no computed length yields **no** length, never a zero;
 * - an item after a variable-length table yields **no** offset, never its minimum
 *   ({@link copybookOffsetStatement} says which of the two is true);
 * - a redefining item is shown as sharing storage, not following it;
 * - a computed byte count is always presented with the assumptions it rests on
 *   ({@link copybookAssumptions}), because the copybook states none of them.
 */

import type {
  AnalysisDocument,
  AnalysisNode,
  AnalysisWarning,
} from './catalog-payload-analysis';

/** Node kinds the copybook extractor emits (mirrors `cobolcopybook_analysis.py`). */
export const COPYBOOK_KIND_RECORD = 'record';
export const COPYBOOK_KIND_GROUP = 'group';
export const COPYBOOK_KIND_FIELD = 'field';
export const COPYBOOK_KIND_CONDITION = 'condition';

/** The analyzer key and the source-format aliases a copybook record can be filed under. */
const COPYBOOK_ANALYZER_KEY = 'cobolcopybook';
const COPYBOOK_FORMAT_KEYS = new Set(['cobolcopybook', 'cobol-copybook', 'copybook', 'cobol']);

/** The analyzer warning code carrying the storage assumptions every computed length rests on. */
export const COPYBOOK_WARNING_ASSUMPTIONS = 'copybook.layout_assumptions';

/**
 * Whether a record was produced by the copybook extractor and can drive this inspector.
 *
 * The analyzer key is the authority — a record says which analyzer wrote it — and the item's
 * `sourceFormat` is only a fallback for a record that named none.
 *
 * @param document The analysis document, if one is loaded.
 * @param sourceFormat The catalog item's raw source format.
 * @returns True when the copybook inspector applies.
 */
export function isCopybookAnalysis(
  document: AnalysisDocument | null | undefined,
  sourceFormat?: string | null,
): boolean {
  const analyzerKey = document?.analyzer?.key;
  if (analyzerKey) return analyzerKey === COPYBOOK_ANALYZER_KEY;
  const format = (document?.sourceFormat ?? sourceFormat ?? '').trim().toLowerCase();
  return COPYBOOK_FORMAT_KEYS.has(format);
}

// ---------------------------------------------------------------------------
// Attribute readers
// ---------------------------------------------------------------------------

/**
 * One attribute as a number, or null when it is absent or not a finite number.
 *
 * @param node The tree node.
 * @param name The attribute key.
 * @returns The number, or null — never a zero standing in for "not computed". The whole point of
 *   the analyzer omitting an unknown attribute is that this can tell the two apart.
 */
export function copybookNumber(
  node: AnalysisNode | null | undefined,
  name: string,
): number | null {
  const value = node?.attributes?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One attribute as a trimmed string, or null when the analyzer did not set it.
 *
 * @param node The tree node.
 * @param name The attribute key.
 * @returns The value, or null. An empty string is null.
 */
export function copybookText(
  node: AnalysisNode | null | undefined,
  name: string,
): string | null {
  const value = node?.attributes?.[name];
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** One attribute as a boolean flag; anything other than a literal `true` is false. */
export function copybookFlag(node: AnalysisNode | null | undefined, name: string): boolean {
  return node?.attributes?.[name] === true;
}

/** One attribute as a list of strings, dropping anything that is not one. */
export function copybookList(
  node: AnalysisNode | null | undefined,
  name: string,
): string[] {
  const value = node?.attributes?.[name];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

// ---------------------------------------------------------------------------
// One item's storage
// ---------------------------------------------------------------------------

/** How a computed byte count was arrived at (mirrors the layout module's `BASIS_*`). */
export type CopybookStorageBasis = 'display' | 'packed' | 'binary' | 'float';

/** Reviewed wording per storage basis, so a byte count is never a number with no derivation. */
const BASIS_LABEL: Record<CopybookStorageBasis, string> = {
  display: 'DISPLAY — one byte per character position',
  packed: 'Packed decimal — two digits per byte plus a sign nibble',
  binary: 'Binary — width chosen by digit count',
  float: 'Floating point — fixed width from USAGE',
};

/**
 * The reviewed label for a storage basis.
 *
 * @param basis The recorded basis.
 * @returns Its sentence, or the raw value for a basis this build does not know — which claims
 *   nothing rather than mislabelling it.
 */
export function copybookBasisLabel(basis: string): string {
  return BASIS_LABEL[basis as CopybookStorageBasis] ?? basis;
}

/** Everything the analysis worked out about where one item sits and how big it is. */
export interface CopybookStorage {
  /** 1-based byte offset, or null when the record carries none. */
  offset: number | null;
  /** True when the item follows a variable table, so no single offset exists. */
  offsetVariable: boolean;
  /** Bytes for one occurrence, or null when unknown. */
  length: number | null;
  /** Bytes for every occurrence, or null when unknown. */
  totalLength: number | null;
  /** Bytes at the minimum occurrence count, only when it differs from {@link totalLength}. */
  minTotalLength: number | null;
  /** True when this item, or anything under it, is a variable-length table. */
  variable: boolean;
  basis: string | null;
  digits: number | null;
  decimals: number | null;
  signed: boolean;
  /** The item this one redefines — it shares that item's storage rather than following it. */
  redefines: string | null;
  /** The items that redefine this one. */
  redefinedBy: string[];
  /** The 1-based end offset, when both an offset and a total length are known. */
  endOffset: number | null;
}

/**
 * Read one item's computed storage off its attributes.
 *
 * @param node The tree node.
 * @returns The storage facts, each null/false where the analysis recorded nothing.
 */
export function copybookStorage(node: AnalysisNode): CopybookStorage {
  const offset = copybookNumber(node, 'offset');
  const totalLength = copybookNumber(node, 'totalLength');
  return {
    offset,
    offsetVariable: copybookFlag(node, 'offsetVariable'),
    length: copybookNumber(node, 'length'),
    totalLength,
    minTotalLength: copybookNumber(node, 'minTotalLength'),
    variable: copybookFlag(node, 'variableLength'),
    basis: copybookText(node, 'storageBasis'),
    digits: copybookNumber(node, 'digits'),
    decimals: copybookNumber(node, 'decimals'),
    signed: copybookFlag(node, 'signed'),
    redefines: copybookText(node, 'redefines'),
    redefinedBy: copybookList(node, 'redefinedBy'),
    endOffset: offset !== null && totalLength !== null ? offset + totalLength - 1 : null,
  };
}

/**
 * The sentence describing where an item starts.
 *
 * Three genuinely different situations, kept apart because collapsing them is how a layout screen
 * lies: a known position, a position that only exists at runtime, and a position that could not be
 * computed because something earlier could not be sized.
 *
 * @param storage The item's storage facts.
 * @returns The sentence to render.
 */
export function copybookOffsetStatement(storage: CopybookStorage): string {
  if (storage.offset !== null) {
    return storage.endOffset !== null
      ? `Bytes ${storage.offset}–${storage.endOffset} of the record.`
      : `Starts at byte ${storage.offset} of the record.`;
  }
  if (storage.offsetVariable) {
    return 'This item follows a variable-length table, so where it starts depends on a value that only exists at runtime. It has a range of offsets rather than an offset, and none is recorded.';
  }
  return 'No offset was computed for this item, because an earlier item’s storage length is unknown.';
}

/**
 * The sentence describing how much room an item takes.
 *
 * @param storage The item's storage facts.
 * @returns The sentence to render.
 */
export function copybookLengthStatement(storage: CopybookStorage): string {
  if (storage.totalLength === null) {
    return 'This item’s storage length could not be computed from its PICTURE and USAGE, so no length is claimed for it.';
  }
  if (storage.minTotalLength !== null && storage.minTotalLength !== storage.totalLength) {
    return `${storage.minTotalLength}–${storage.totalLength} bytes, depending on how many occurrences the table carries.`;
  }
  const plural = storage.totalLength === 1 ? '' : 's';
  if (storage.length !== null && storage.length !== storage.totalLength) {
    return `${storage.totalLength} byte${plural} in total — ${storage.length} per occurrence.`;
  }
  return `${storage.totalLength} byte${plural}.`;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** The level-01 record as the inspector's header renders it. */
export interface CopybookRecordSummary {
  node: AnalysisNode;
  name: string;
  /** Minimum bytes one record occupies, or null when it could not be computed. */
  minLength: number | null;
  /** Maximum bytes one record occupies, or null. */
  maxLength: number | null;
  /** True when the record's length is a range because it carries a variable table. */
  variable: boolean;
  /** The sentence stating the record's size, or why there isn't one. */
  statement: string;
  /** Every group and field under the record, flattened in declaration order. */
  itemCount: number;
  /** How many items carry a computed length — the honest denominator for the one above. */
  sizedItemCount: number;
}

/** Walk a subtree depth-first, in declaration order. */
function walk(node: AnalysisNode): AnalysisNode[] {
  const items: AnalysisNode[] = [node];
  for (const child of node.children ?? []) items.push(...walk(child));
  return items;
}

/**
 * Read the level-01 record off the tree.
 *
 * @param tree The record's root nodes.
 * @returns The summary, or null when the record carries no `record` root — no record, no inspector.
 */
export function copybookRecordSummary(
  tree: readonly AnalysisNode[],
): CopybookRecordSummary | null {
  const node = tree.find((root) => root.kind === COPYBOOK_KIND_RECORD);
  if (!node) return null;

  const storage = copybookStorage(node);
  const maxLength = storage.totalLength;
  const minLength = storage.minTotalLength ?? storage.totalLength;
  const items = walk(node).filter((entry) => entry.kind !== COPYBOOK_KIND_CONDITION);

  const statement =
    maxLength === null
      ? 'This record’s total length could not be computed, because at least one item’s storage is unknown.'
      : storage.variable && minLength !== null && minLength !== maxLength
        ? `One record occupies ${minLength}–${maxLength} bytes; it carries a variable-length table, so its size depends on the data.`
        : `One record occupies ${maxLength} bytes, the same for every record.`;

  return {
    node,
    name: node.name?.trim() || node.id,
    minLength,
    maxLength,
    variable: storage.variable,
    statement,
    itemCount: items.length - 1,
    sizedItemCount: items.filter(
      (entry) => entry !== node && copybookNumber(entry, 'totalLength') !== null,
    ).length,
  };
}

// ---------------------------------------------------------------------------
// The storage map
// ---------------------------------------------------------------------------

/** One row of the record's storage map — an elementary item, in declaration order. */
export interface CopybookStorageRow {
  node: AnalysisNode;
  name: string;
  /** 1-based nesting depth under the record, so the map can indent like the source does. */
  depth: number;
  level: number | null;
  picture: string | null;
  usage: string | null;
  storage: CopybookStorage;
  /** Occurrence bounds, when the item is a table. */
  occursMin: number | null;
  occursMax: number | null;
  /** The ODO controller the table depends on. */
  dependingOn: string | null;
  /** 88-level condition names declared under this item. */
  conditions: Array<{ name: string; value: string | null }>;
}

/**
 * Flatten the record into its storage map: every group and elementary item, in declaration order.
 *
 * Condition names are *not* rows. An 88-level name is a value enumeration rather than a field — it
 * occupies no storage of its own — so it rides on the item it qualifies instead of taking a line in
 * a map of where bytes live.
 *
 * @param tree The record's root nodes.
 * @returns The rows, in declaration order.
 */
export function copybookStorageMap(tree: readonly AnalysisNode[]): CopybookStorageRow[] {
  const record = tree.find((root) => root.kind === COPYBOOK_KIND_RECORD);
  if (!record) return [];

  const rows: CopybookStorageRow[] = [];
  const visit = (node: AnalysisNode, depth: number) => {
    if (node.kind === COPYBOOK_KIND_CONDITION) return;
    if (depth > 0) {
      rows.push({
        node,
        name: node.name?.trim() || node.id,
        depth,
        level: copybookNumber(node, 'level'),
        picture: copybookText(node, 'picture'),
        usage: copybookText(node, 'usage'),
        storage: copybookStorage(node),
        occursMin: copybookNumber(node, 'occursMin'),
        occursMax: copybookNumber(node, 'occursMax'),
        dependingOn: copybookText(node, 'dependingOn'),
        conditions: (node.children ?? [])
          .filter((child) => child.kind === COPYBOOK_KIND_CONDITION)
          .map((child) => ({
            name: child.name?.trim() || child.id,
            value: copybookText(child, 'conditionValue'),
          })),
      });
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };

  visit(record, 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Tables and overlays
// ---------------------------------------------------------------------------

/** One OCCURS table and what controls its length. */
export interface CopybookTable {
  node: AnalysisNode;
  name: string;
  occursMin: number;
  occursMax: number;
  /** True when the bounds differ, so the table's length depends on the data. */
  variable: boolean;
  /** The ODO controller named by DEPENDING ON, when there is one. */
  dependingOn: string | null;
  /** True when an item of that name is declared elsewhere in this copybook. */
  controllerResolved: boolean;
}

/**
 * Every OCCURS table in the record, with its controller resolved against the copybook's own items.
 *
 * A controller the copybook does not declare is not an error — it may live in a surrounding
 * copybook this one is copied into — but it is a fact the reader needs, because the table's bounds
 * cannot be reasoned about from this file alone.
 *
 * @param tree The record's root nodes.
 * @returns The tables, in declaration order.
 */
export function copybookTables(tree: readonly AnalysisNode[]): CopybookTable[] {
  const record = tree.find((root) => root.kind === COPYBOOK_KIND_RECORD);
  if (!record) return [];
  const declared = new Set(
    walk(record)
      .filter((node) => node.kind !== COPYBOOK_KIND_CONDITION)
      .map((node) => node.name?.trim())
      .filter((name): name is string => Boolean(name)),
  );

  return walk(record)
    .filter((node) => copybookNumber(node, 'occursMax') !== null)
    .map((node) => {
      const max = copybookNumber(node, 'occursMax') ?? 0;
      const min = copybookNumber(node, 'occursMin') ?? max;
      const dependingOn = copybookText(node, 'dependingOn');
      return {
        node,
        name: node.name?.trim() || node.id,
        occursMin: min,
        occursMax: max,
        variable: min !== max,
        dependingOn,
        controllerResolved: dependingOn !== null && declared.has(dependingOn),
      };
    });
}

/** One span of storage described more than once, and every item that describes it. */
export interface CopybookOverlay {
  /** The item the others redefine. */
  base: AnalysisNode;
  baseName: string;
  /** Bytes the base item occupies, or null when unknown. */
  baseLength: number | null;
  /** The redefining items, in declaration order. */
  overlays: Array<{ node: AnalysisNode; name: string; length: number | null; oversized: boolean }>;
  /** The offset all of them share, or null when it could not be computed. */
  offset: number | null;
}

/**
 * Group the record's REDEFINES clauses by the storage they share.
 *
 * This is the direction the question is actually asked in — "what else claims these bytes?" — which
 * a tree of independent rows cannot answer at all.
 *
 * @param tree The record's root nodes.
 * @returns One entry per redefined item, in declaration order.
 */
export function copybookOverlays(tree: readonly AnalysisNode[]): CopybookOverlay[] {
  const record = tree.find((root) => root.kind === COPYBOOK_KIND_RECORD);
  if (!record) return [];

  const overlays: CopybookOverlay[] = [];
  const visit = (node: AnalysisNode) => {
    const children = (node.children ?? []).filter(
      (child) => child.kind !== COPYBOOK_KIND_CONDITION,
    );
    for (const child of children) {
      const redefinedBy = copybookList(child, 'redefinedBy');
      if (redefinedBy.length > 0) {
        const baseLength = copybookNumber(child, 'totalLength');
        overlays.push({
          base: child,
          baseName: child.name?.trim() || child.id,
          baseLength,
          offset: copybookNumber(child, 'offset'),
          overlays: children
            .filter((sibling) => redefinedBy.includes(sibling.name?.trim() ?? ''))
            .map((sibling) => {
              const length = copybookNumber(sibling, 'totalLength');
              return {
                node: sibling,
                name: sibling.name?.trim() || sibling.id,
                length,
                // Reported, never reconciled: a copybook whose overlay does not fit is a fact
                // about the copybook, and the inspector is not the place to correct it.
                oversized: length !== null && baseLength !== null && length > baseLength,
              };
            }),
        });
      }
    }
    for (const child of children) visit(child);
  };

  visit(record);
  return overlays;
}

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

/**
 * The assumptions every computed length in this record rests on, as the analyzer stated them.
 *
 * Read from the record's own warning rather than restated here, so the UI cannot drift from what
 * the arithmetic actually assumed. A record with no such warning yields nothing — the panel then
 * says the assumptions were not recorded rather than inventing a list.
 *
 * @param document The analysis document.
 * @returns The assumption sentences, or an empty array.
 */
export function copybookAssumptions(
  document: AnalysisDocument | null | undefined,
): string[] {
  const warning = (document?.warnings ?? []).find(
    (entry: AnalysisWarning) => entry.code === COPYBOOK_WARNING_ASSUMPTIONS,
  );
  const message = warning?.message ?? '';
  const marker = 'does not state:';
  const index = message.indexOf(marker);
  if (index < 0) return [];
  return message
    .slice(index + marker.length)
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * The canonical entity a copybook item maps onto, when one plausibly exists.
 *
 * The normalizer turns every **group** item into a canonical type of the same name and every
 * elementary item into a field on its parent group's type. So a group links to its own entity and a
 * field links to the entity that carries it — and an item whose name matches nothing in the parsed
 * model links to nothing at all, which is the honest answer rather than the nearest guess.
 *
 * @param row The storage-map row.
 * @param parentName The name of the row's parent group, when it has one.
 * @param entityNames The parsed-entity names rendered on the Overview tab.
 * @returns `{ entity, field }` — `field` is set only when the row is an elementary item — or null.
 */
export function copybookCanonicalTarget(
  row: CopybookStorageRow,
  parentName: string | null,
  entityNames: ReadonlySet<string>,
): { entity: string; field: string | null } | null {
  const isGroup = (row.node.children ?? []).some(
    (child) => child.kind !== COPYBOOK_KIND_CONDITION,
  );
  if (isGroup && entityNames.has(row.name)) return { entity: row.name, field: null };
  if (!isGroup && parentName && entityNames.has(parentName)) {
    return { entity: parentName, field: row.name };
  }
  return null;
}

/**
 * Index each storage-map row's parent group name, so canonical targets can be resolved.
 *
 * @param tree The record's root nodes.
 * @returns `node id → parent group name`. The record's own children map to the record's name.
 */
export function copybookParentNames(
  tree: readonly AnalysisNode[],
): Map<string, string> {
  const parents = new Map<string, string>();
  const record = tree.find((root) => root.kind === COPYBOOK_KIND_RECORD);
  if (!record) return parents;

  const visit = (node: AnalysisNode) => {
    const name = node.name?.trim();
    for (const child of node.children ?? []) {
      if (child.kind === COPYBOOK_KIND_CONDITION) continue;
      if (name) parents.set(child.id, name);
      visit(child);
    }
  };

  visit(record);
  return parents;
}
