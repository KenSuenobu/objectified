/**
 * COBOL copybook layout derivations for the Format details tab (CPDO-2.3, #4799).
 *
 * These are the rules the inspector renders, tested without a DOM. The theme running through them
 * is the ticket's last acceptance criterion — *no semantics are guessed from absent source data* —
 * so most of this file is about what the derivations **refuse** to produce: no length from an
 * unsized item, no offset from an item after a variable table, no canonical link from a name the
 * parsed model does not carry, and no assumption list the analyzer did not actually state.
 */

import {
  copybookAssumptions,
  copybookBasisLabel,
  copybookCanonicalTarget,
  copybookFlag,
  copybookLengthStatement,
  copybookList,
  copybookNumber,
  copybookOffsetStatement,
  copybookOverlays,
  copybookParentNames,
  copybookRecordSummary,
  copybookStorage,
  copybookStorageMap,
  copybookTables,
  copybookText,
  isCopybookAnalysis,
} from '../src/app/utils/catalog-copybook-analysis';
import type { AnalysisNode } from '../src/app/utils/catalog-payload-analysis';
import {
  COPYBOOK_LAYOUT_TREE,
  COPYBOOK_VARIABLE_TREE,
  X12_TREE,
  copybookLayoutRecord,
  copybookVariableRecord,
  x12ScannedRecord,
} from './helpers/payload-analysis-fixture';

const layout = copybookLayoutRecord().analysis;
const variable = copybookVariableRecord().analysis;

/** Find a node by id anywhere in a tree. */
function node(tree: readonly AnalysisNode[], id: string): AnalysisNode {
  const stack = [...tree];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next.id === id) return next;
    stack.push(...(next.children ?? []));
  }
  throw new Error(`no node ${id}`);
}

/** The storage-map row for one item. */
function row(tree: readonly AnalysisNode[], name: string) {
  const found = copybookStorageMap(tree).find((entry) => entry.name === name);
  if (!found) throw new Error(`no storage row for ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// Applicability
// ---------------------------------------------------------------------------

describe('isCopybookAnalysis', () => {
  it('trusts the analyzer key over the catalog item’s format', () => {
    expect(isCopybookAnalysis(layout, 'edix12')).toBe(true);
    expect(isCopybookAnalysis(x12ScannedRecord().analysis, 'cobolcopybook')).toBe(false);
  });

  it('falls back to the source format only when no analyzer is named', () => {
    const anonymous = { ...layout, analyzer: undefined, sourceFormat: null } as never;
    expect(isCopybookAnalysis(anonymous, 'cobol-copybook')).toBe(true);
    expect(isCopybookAnalysis(anonymous, 'openapi')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Attribute readers
// ---------------------------------------------------------------------------

describe('attribute readers', () => {
  const record = node(COPYBOOK_LAYOUT_TREE, 'rec-payment');

  it('returns null rather than a default for an attribute the analyzer did not set', () => {
    expect(copybookNumber(record, 'nothingHere')).toBeNull();
    expect(copybookText(record, 'nothingHere')).toBeNull();
    expect(copybookFlag(record, 'nothingHere')).toBe(false);
    expect(copybookList(record, 'nothingHere')).toEqual([]);
  });

  it('never reads a missing number as a zero', () => {
    expect(copybookNumber({ id: 'z', kind: 'field', attributes: { offset: 0 } }, 'offset')).toBe(0);
    expect(copybookNumber({ id: 'z', kind: 'field', attributes: {} }, 'offset')).toBeNull();
  });

  it('drops non-string entries from a list attribute', () => {
    const messy: AnalysisNode = {
      id: 'm',
      kind: 'field',
      attributes: { redefinedBy: ['A', 2, '', null, 'B'] },
    };
    expect(copybookList(messy, 'redefinedBy')).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// One item's storage
// ---------------------------------------------------------------------------

describe('copybookStorage', () => {
  it('reads a packed field’s span, basis, digits and sign', () => {
    const storage = copybookStorage(node(COPYBOOK_LAYOUT_TREE, 'fld-amount'));

    expect(storage).toMatchObject({
      offset: 12,
      length: 6,
      totalLength: 6,
      endOffset: 17,
      basis: 'packed',
      digits: 11,
      decimals: 2,
      signed: true,
    });
  });

  it('computes an end offset only when both ends are known', () => {
    expect(copybookStorage(node(COPYBOOK_VARIABLE_TREE, 'fld-note')).endOffset).toBeNull();
    expect(copybookStorage(node(COPYBOOK_LAYOUT_TREE, 'fld-id')).endOffset).toBe(10);
  });

  it('reads both ends of a REDEFINES relationship', () => {
    expect(copybookStorage(node(COPYBOOK_LAYOUT_TREE, 'grp-card')).redefines).toBe(
      'PAYMENT-DETAIL',
    );
    expect(copybookStorage(node(COPYBOOK_LAYOUT_TREE, 'fld-detail')).redefinedBy).toEqual([
      'CARD-DETAIL',
      'BANK-DETAIL',
    ]);
  });

  it('labels each storage basis rather than printing a bare enum value', () => {
    expect(copybookBasisLabel('packed')).toMatch(/two digits per byte/i);
    expect(copybookBasisLabel('display')).toMatch(/one byte per character/i);
    expect(copybookBasisLabel('binary')).toMatch(/digit count/i);
    // A basis this build does not know claims nothing rather than mislabelling it.
    expect(copybookBasisLabel('something-new')).toBe('something-new');
  });
});

describe('offset and length statements', () => {
  it('states a known span as a byte range', () => {
    const statement = copybookOffsetStatement(copybookStorage(node(COPYBOOK_LAYOUT_TREE, 'fld-amount')));
    expect(statement).toBe('Bytes 12–17 of the record.');
  });

  it('says a variable offset depends on runtime data, not that it is missing', () => {
    const statement = copybookOffsetStatement(copybookStorage(node(COPYBOOK_VARIABLE_TREE, 'fld-note')));

    expect(statement).toMatch(/only exists at runtime/i);
    expect(statement).toMatch(/range of offsets rather than an offset/i);
  });

  it('distinguishes a variable offset from one an unsized item made incomputable', () => {
    const blocked = copybookStorage({ id: 'b', kind: 'field', attributes: { length: 4 } });
    expect(copybookOffsetStatement(blocked)).toMatch(/earlier item’s storage length is unknown/i);
  });

  it('says a length was not computed rather than reporting zero', () => {
    const statement = copybookLengthStatement(copybookStorage(node(COPYBOOK_VARIABLE_TREE, 'fld-note')));
    expect(statement).toMatch(/could not be computed/i);
    expect(statement).not.toMatch(/\b0 bytes\b/);
  });

  it('states a table’s length as a range and names the per-occurrence size', () => {
    const table = copybookStorage(node(COPYBOOK_VARIABLE_TREE, 'grp-lines'));
    expect(copybookLengthStatement(table)).toMatch(/4–36 bytes/);

    const fixed = copybookStorage({
      id: 'f',
      kind: 'group',
      attributes: { length: 4, totalLength: 20 },
    });
    expect(copybookLengthStatement(fixed)).toBe('20 bytes in total — 4 per occurrence.');
  });

  it('renders a single byte without a plural', () => {
    const single = copybookStorage(node(COPYBOOK_LAYOUT_TREE, 'fld-type'));
    expect(copybookLengthStatement(single)).toBe('1 byte.');
  });
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

describe('copybookRecordSummary', () => {
  it('states a fixed record’s single length', () => {
    const summary = copybookRecordSummary(COPYBOOK_LAYOUT_TREE)!;

    expect(summary.name).toBe('PAYMENT-RECORD');
    expect(summary.maxLength).toBe(55);
    expect(summary.variable).toBe(false);
    expect(summary.statement).toMatch(/55 bytes, the same for every record/i);
  });

  it('counts the items it could size against the items there are', () => {
    const summary = copybookRecordSummary(COPYBOOK_LAYOUT_TREE)!;

    // Ten groups and fields. Conditions are not items — they occupy no storage — so the two
    // condition names in this record are in neither count.
    expect(summary.itemCount).toBe(10);
    expect(summary.sizedItemCount).toBe(10);
  });

  it('reports an unsized record without inventing a length', () => {
    const summary = copybookRecordSummary(COPYBOOK_VARIABLE_TREE)!;

    expect(summary.maxLength).toBeNull();
    expect(summary.statement).toMatch(/could not be computed/i);
    expect(summary.sizedItemCount).toBeLessThan(summary.itemCount);
  });

  it('returns null for a tree with no level-01 record', () => {
    expect(copybookRecordSummary(X12_TREE)).toBeNull();
    expect(copybookRecordSummary([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The storage map
// ---------------------------------------------------------------------------

describe('copybookStorageMap', () => {
  it('lists every item in declaration order, indented by nesting depth', () => {
    const rows = copybookStorageMap(COPYBOOK_LAYOUT_TREE);

    expect(rows.map((entry) => entry.name)).toEqual([
      'PAYMENT-ID',
      'PAYMENT-TYPE',
      'PAYMENT-AMOUNT',
      'PAYMENT-DETAIL',
      'CARD-DETAIL',
      'CARD-NUMBER',
      'CARD-EXPIRY-YYMM',
      'BANK-DETAIL',
      'BANK-ROUTING',
      'PAYMENT-POSTED-DATE',
    ]);
    expect(row(COPYBOOK_LAYOUT_TREE, 'CARD-DETAIL').depth).toBe(1);
    expect(row(COPYBOOK_LAYOUT_TREE, 'CARD-NUMBER').depth).toBe(2);
  });

  it('does not give a condition name a row of its own', () => {
    const rows = copybookStorageMap(COPYBOOK_LAYOUT_TREE);
    expect(rows.some((entry) => entry.name === 'PAY-BY-CARD')).toBe(false);
  });

  it('rides condition names on the item they qualify', () => {
    expect(row(COPYBOOK_LAYOUT_TREE, 'PAYMENT-TYPE').conditions).toEqual([
      { name: 'PAY-BY-CARD', value: 'C' },
      { name: 'PAY-BY-BANK', value: 'B' },
    ]);
  });

  it('carries each item’s picture, usage and occurrence bounds', () => {
    const amount = row(COPYBOOK_LAYOUT_TREE, 'PAYMENT-AMOUNT');
    expect(amount.picture).toBe('S9(9)V99');
    expect(amount.usage).toBe('COMP-3');

    const lines = row(COPYBOOK_VARIABLE_TREE, 'ORDER-LINES');
    expect([lines.occursMin, lines.occursMax]).toEqual([1, 9]);
    expect(lines.dependingOn).toBe('OUTER-LINE-COUNT');
  });

  it('is empty for a tree with no record', () => {
    expect(copybookStorageMap(X12_TREE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

describe('copybookOverlays', () => {
  it('groups redefining items under the storage they share', () => {
    const overlays = copybookOverlays(COPYBOOK_LAYOUT_TREE);

    expect(overlays).toHaveLength(1);
    expect(overlays[0].baseName).toBe('PAYMENT-DETAIL');
    expect(overlays[0].offset).toBe(18);
    expect(overlays[0].baseLength).toBe(30);
    expect(overlays[0].overlays.map((entry) => entry.name)).toEqual([
      'CARD-DETAIL',
      'BANK-DETAIL',
    ]);
  });

  it('flags an overlay that needs more storage than it redefines, without adjusting either', () => {
    const tree = JSON.parse(JSON.stringify(COPYBOOK_LAYOUT_TREE)) as AnalysisNode[];
    const card = node(tree, 'grp-card');
    card.attributes = { ...card.attributes, totalLength: 44 };

    const [overlay] = copybookOverlays(tree);
    const [cardEntry, bankEntry] = overlay.overlays;
    expect(cardEntry.oversized).toBe(true);
    expect(cardEntry.length).toBe(44);
    expect(bankEntry.oversized).toBe(false);
    // The base is untouched — nothing is reconciled to make the two agree.
    expect(overlay.baseLength).toBe(30);
  });

  it('does not call an overlay oversized when either length is unknown', () => {
    const tree = JSON.parse(JSON.stringify(COPYBOOK_LAYOUT_TREE)) as AnalysisNode[];
    const card = node(tree, 'grp-card');
    delete (card.attributes as Record<string, unknown>).totalLength;

    const [overlay] = copybookOverlays(tree);
    expect(overlay.overlays[0].length).toBeNull();
    expect(overlay.overlays[0].oversized).toBe(false);
  });

  it('is empty for a copybook with no REDEFINES', () => {
    expect(copybookOverlays(COPYBOOK_VARIABLE_TREE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

describe('copybookTables', () => {
  it('reports a variable table’s bounds and its controller', () => {
    const [table] = copybookTables(COPYBOOK_VARIABLE_TREE);

    expect(table.name).toBe('ORDER-LINES');
    expect([table.occursMin, table.occursMax]).toEqual([1, 9]);
    expect(table.variable).toBe(true);
    expect(table.dependingOn).toBe('OUTER-LINE-COUNT');
  });

  it('says when a controller is not declared in this copybook', () => {
    expect(copybookTables(COPYBOOK_VARIABLE_TREE)[0].controllerResolved).toBe(false);
  });

  it('resolves a controller the copybook does declare', () => {
    const tree = JSON.parse(JSON.stringify(COPYBOOK_VARIABLE_TREE)) as AnalysisNode[];
    const lines = node(tree, 'grp-lines');
    lines.attributes = { ...lines.attributes, dependingOn: 'ORDER-ID' };

    expect(copybookTables(tree)[0].controllerResolved).toBe(true);
  });

  it('does not call a fixed table variable', () => {
    const tree = JSON.parse(JSON.stringify(COPYBOOK_VARIABLE_TREE)) as AnalysisNode[];
    const lines = node(tree, 'grp-lines');
    lines.attributes = { ...lines.attributes, occursMin: 9, occursMax: 9 };

    expect(copybookTables(tree)[0].variable).toBe(false);
  });

  it('is empty for a copybook with no tables', () => {
    expect(copybookTables(COPYBOOK_LAYOUT_TREE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

describe('copybookAssumptions', () => {
  it('reads the assumptions from the analyzer’s own warning rather than restating them', () => {
    const assumptions = copybookAssumptions(layout);

    expect(assumptions.length).toBeGreaterThan(1);
    expect(assumptions.join(' ')).toMatch(/single-byte encoding/i);
    expect(assumptions.join(' ')).toMatch(/SYNCHRONIZED/);
    // The lead-in is not one of the assumptions.
    expect(assumptions[0]).not.toMatch(/does not state/i);
  });

  it('yields nothing when the record carries no assumption warning', () => {
    expect(copybookAssumptions({ ...layout, warnings: [] })).toEqual([]);
    expect(copybookAssumptions(null)).toEqual([]);
  });

  it('yields nothing for a warning whose message it cannot split', () => {
    const odd = { ...layout, warnings: [{ code: 'copybook.layout_assumptions', severity: 'info', message: 'no marker here' }] };
    expect(copybookAssumptions(odd)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Canonical targets
// ---------------------------------------------------------------------------

describe('copybookCanonicalTarget', () => {
  const parents = copybookParentNames(COPYBOOK_LAYOUT_TREE);
  const entities = new Set(['PAYMENT-RECORD', 'CARD-DETAIL', 'BANK-DETAIL']);

  it('links a group item to its own canonical entity', () => {
    const target = copybookCanonicalTarget(
      row(COPYBOOK_LAYOUT_TREE, 'CARD-DETAIL'),
      parents.get('grp-card') ?? null,
      entities,
    );
    expect(target).toEqual({ entity: 'CARD-DETAIL', field: null });
  });

  it('links an elementary item to the entity that carries it as a field', () => {
    const target = copybookCanonicalTarget(
      row(COPYBOOK_LAYOUT_TREE, 'CARD-NUMBER'),
      parents.get('fld-card-number') ?? null,
      entities,
    );
    expect(target).toEqual({ entity: 'CARD-DETAIL', field: 'CARD-NUMBER' });
  });

  it('links a top-level field to the record entity', () => {
    const target = copybookCanonicalTarget(
      row(COPYBOOK_LAYOUT_TREE, 'PAYMENT-ID'),
      parents.get('fld-id') ?? null,
      entities,
    );
    expect(target).toEqual({ entity: 'PAYMENT-RECORD', field: 'PAYMENT-ID' });
  });

  it('links to nothing when the parsed model carries no such entity', () => {
    const target = copybookCanonicalTarget(
      row(COPYBOOK_LAYOUT_TREE, 'CARD-NUMBER'),
      parents.get('fld-card-number') ?? null,
      new Set(['SOMETHING-ELSE']),
    );
    expect(target).toBeNull();
  });

  it('links to nothing when the item has no parent group to belong to', () => {
    expect(
      copybookCanonicalTarget(row(COPYBOOK_LAYOUT_TREE, 'PAYMENT-ID'), null, entities),
    ).toBeNull();
  });
});

describe('copybookParentNames', () => {
  it('names each item’s parent group, skipping condition names', () => {
    const parents = copybookParentNames(COPYBOOK_LAYOUT_TREE);

    expect(parents.get('fld-id')).toBe('PAYMENT-RECORD');
    expect(parents.get('grp-card')).toBe('PAYMENT-RECORD');
    expect(parents.get('fld-card-number')).toBe('CARD-DETAIL');
    expect(parents.has('cond-card')).toBe(false);
  });

  it('is empty for a tree with no record', () => {
    expect(copybookParentNames(X12_TREE).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The variable record end to end
// ---------------------------------------------------------------------------

describe('the variable-length record', () => {
  it('keeps the item after the table without an offset, but with its own length', () => {
    const note = row(COPYBOOK_VARIABLE_TREE, 'ORDER-NOTE');

    expect(note.storage.offset).toBeNull();
    expect(note.storage.offsetVariable).toBe(true);
    // And its length is genuinely unknown too, for an unrelated reason — PIC N is not sized.
    expect(note.storage.totalLength).toBeNull();
  });

  it('is reported partial by the analyzer rather than presented as complete', () => {
    expect(variable.status).toBe('partial');
    expect(variable.warnings.some((warning) => warning.code === 'copybook.unsized_item')).toBe(true);
  });
});
