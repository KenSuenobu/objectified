/**
 * X12 derivations for the Format details tab (CPDO-2.2, #4798).
 *
 * These are the rules the inspector renders, tested without a DOM. The theme running through them
 * is that nothing is derived that the record does not carry: a missing control total is not
 * agreement, an absent repetition separator is not a missing one, an empty element is not a
 * withheld one, and a location with no length is not a range.
 */

import {
  isX12Analysis,
  x12CanonicalSubsetWarning,
  x12CodePoint,
  x12ConformanceStatement,
  x12ControlTotal,
  x12ConversionScope,
  x12ElementPresence,
  x12Envelope,
  x12Groups,
  x12Number,
  x12PresencePresentation,
  x12Reference,
  x12RepeatedSegments,
  x12Separators,
  x12SourceRange,
  x12Text,
} from '../src/app/utils/catalog-x12-analysis';
import type { AnalysisNode } from '../src/app/utils/catalog-payload-analysis';
import {
  COPYBOOK_TREE,
  X12_SCANNED_SOURCE,
  X12_SCANNED_TREE,
  X12_TREE,
  copybookRecord,
  x12Record,
  x12ScannedRecord,
} from './helpers/payload-analysis-fixture';

const scanned = x12ScannedRecord().analysis;
const pathOnly = x12Record().analysis;

/** A deep copy, so a test that mutates a fixture cannot leak into the next one. */
function clone(tree: readonly AnalysisNode[]): AnalysisNode[] {
  return JSON.parse(JSON.stringify(tree)) as AnalysisNode[];
}

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

// ---------------------------------------------------------------------------
// Applicability
// ---------------------------------------------------------------------------

describe('isX12Analysis', () => {
  it('trusts the analyzer key over the catalog item’s format', () => {
    expect(isX12Analysis(scanned, 'cobolcopybook')).toBe(true);
    expect(isX12Analysis(copybookRecord().analysis, 'edix12')).toBe(false);
  });

  it('falls back to the source format only when no analyzer is named', () => {
    const anonymous = { ...scanned, analyzer: undefined, sourceFormat: null } as never;
    expect(isX12Analysis(anonymous, 'edi-x12')).toBe(true);
    expect(isX12Analysis(anonymous, 'openapi')).toBe(false);
    // The record's own declared format outranks the catalog item's.
    const declared = { ...scanned, analyzer: undefined, sourceFormat: 'edix12' } as never;
    expect(isX12Analysis(declared, 'openapi')).toBe(true);
  });

  it('claims nothing without a record', () => {
    expect(isX12Analysis(null, 'edix12')).toBe(true);
    expect(isX12Analysis(null, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Attribute readers
// ---------------------------------------------------------------------------

describe('attribute readers', () => {
  const isa = node(X12_SCANNED_TREE, 'isa');

  it('returns null rather than a default for an attribute the analyzer did not set', () => {
    expect(x12Text(isa, 'nothingHere')).toBeNull();
    expect(x12Number(isa, 'nothingHere')).toBeNull();
    expect(x12Text(null, 'senderId')).toBeNull();
  });

  it('never reads a zero as “not recorded”, or “not recorded” as a zero', () => {
    const zeroed: AnalysisNode = { id: 'z', kind: 'segment', attributes: { repeatCount: 0 } };
    expect(x12Number(zeroed, 'repeatCount')).toBe(0);
    expect(x12Number(zeroed, 'missing')).toBeNull();
  });

  it('treats an attribute set to whitespace as unset', () => {
    const blank: AnalysisNode = { id: 'b', kind: 'segment', attributes: { setId: '   ' } };
    expect(x12Text(blank, 'setId')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delimiters
// ---------------------------------------------------------------------------

describe('separators', () => {
  it('renders each delimiter with its code point so a look-alike is identifiable', () => {
    expect(x12CodePoint('*')).toBe('U+002A');
    expect(x12CodePoint('~')).toBe('U+007E');
    expect(x12CodePoint('')).toBeNull();
    expect(x12CodePoint(null)).toBeNull();
  });

  it('reports the four delimiters the interchange declared', () => {
    const [element, component, repetition, terminator] = x12Separators(node(X12_SCANNED_TREE, 'isa'));

    expect(element).toMatchObject({ label: 'Element', character: '*', codePoint: 'U+002A' });
    expect(component).toMatchObject({ label: 'Component', character: '>' });
    expect(terminator).toMatchObject({ label: 'Segment terminator', character: '~' });
    expect(repetition.character).toBeNull();
  });

  it('says a repetition separator does not exist at this version rather than that it is missing', () => {
    const [, , repetition] = x12Separators(node(X12_SCANNED_TREE, 'isa'));
    expect(repetition.absence).toMatch(/does not define a repetition separator/i);
  });

  it('distinguishes “this version has none” from “the record does not say”', () => {
    const silent: AnalysisNode = { id: 'isa', kind: 'interchange', attributes: {} };
    const [, , repetition] = x12Separators(silent);
    expect(repetition.absence).toMatch(/does not state a repetition separator/i);
  });

  it('reports a declared repetition separator when there is one', () => {
    const fiveTen: AnalysisNode = {
      id: 'isa',
      kind: 'interchange',
      attributes: { repetitionSeparatorDeclared: true, repetitionSeparator: '^' },
    };
    const [, , repetition] = x12Separators(fiveTen);
    expect(repetition).toMatchObject({ character: '^', codePoint: 'U+005E', absence: null });
  });
});

// ---------------------------------------------------------------------------
// Control totals
// ---------------------------------------------------------------------------

describe('control totals', () => {
  it('flags a disagreement between what a trailer declared and what was observed', () => {
    expect(x12ControlTotal('Segments', 'SE01', 4, 3).mismatched).toBe(true);
    expect(x12ControlTotal('Segments', 'SE01', 3, 3).mismatched).toBe(false);
  });

  it('does not read a missing declaration as agreement', () => {
    const total = x12ControlTotal('Functional groups', 'IEA01', null, 2);
    expect(total.mismatched).toBe(false);
    expect(total.declared).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe('x12Envelope', () => {
  it('reads the envelope identity, controls and delimiters off the interchange node', () => {
    const envelope = x12Envelope(X12_SCANNED_TREE)!;

    expect(envelope.senderId).toBe('SENDERID');
    expect(envelope.receiverId).toBe('RECEIVERID');
    expect(envelope.controlNumber).toBe('000000004');
    expect(envelope.version).toBe('00401');
    expect(envelope.date).toBe('260116');
    expect(envelope.separators).toHaveLength(4);
    expect(envelope.groupTotal).toMatchObject({ declared: 2, observed: 2, mismatched: false });
  });

  it('carries the usage indicator’s word from the record rather than re-deriving it', () => {
    const envelope = x12Envelope(X12_SCANNED_TREE)!;
    expect(envelope.usageIndicator).toBe('P');
    expect(envelope.usageLabel).toBe('Production');
    expect(envelope.isProduction).toBe(true);
  });

  it('treats a non-production indicator as not production, whatever its code', () => {
    const test = clone(X12_SCANNED_TREE);
    test[0].attributes = { ...test[0].attributes, usageIndicator: 'T', usageIndicatorLabel: 'Test' };
    const envelope = x12Envelope(test)!;
    expect(envelope.isProduction).toBe(false);
    expect(envelope.usageLabel).toBe('Test');
  });

  it('returns null for a tree with no interchange root', () => {
    expect(x12Envelope(COPYBOOK_TREE)).toBeNull();
    expect(x12Envelope([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Groups and transaction sets
// ---------------------------------------------------------------------------

describe('x12Groups', () => {
  const groups = x12Groups(X12_SCANNED_TREE);

  it('reads every functional group and every transaction set, not just the converted one', () => {
    expect(groups.map((group) => group.functionalId)).toEqual(['PO', 'FA']);
    expect(groups.flatMap((group) => group.transactions.map((t) => t.setId))).toEqual(['850', '997']);
  });

  it('keeps each group’s declared version, control number and agency code', () => {
    expect(groups[0]).toMatchObject({
      version: '004010',
      controlNumber: '10',
      responsibleAgencyCode: 'X',
    });
  });

  it('flags exactly the transaction set the canonical conversion was derived from', () => {
    const converted = groups.flatMap((group) => group.transactions).filter((t) => t.converted);
    expect(converted).toHaveLength(1);
    expect(converted[0].setId).toBe('850');
  });

  it('surfaces a segment total that disagrees with what SE01 declared', () => {
    const [po, fa] = groups;
    expect(po.transactions[0].segmentTotal.mismatched).toBe(false);
    expect(fa.transactions[0].segmentTotal).toMatchObject({
      declared: 4,
      observed: 3,
      mismatched: true,
    });
  });

  it('counts a repeated segment from its own repeat count rather than from surviving rows', () => {
    expect(groups[0].transactions[0].repeatedSegments).toEqual([{ segmentId: 'PO1', count: 2 }]);
    expect(groups[1].transactions[0].repeatedSegments).toEqual([]);
  });

  it('reports nothing for a transaction set whose segments the budget dropped', () => {
    const bounded: AnalysisNode = { id: 'st', kind: 'transaction_set', children: [] };
    expect(x12RepeatedSegments(bounded)).toEqual([]);
    expect(x12RepeatedSegments(null)).toEqual([]);
  });

  it('is empty for a tree with no interchange', () => {
    expect(x12Groups(COPYBOOK_TREE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conversion scope
// ---------------------------------------------------------------------------

describe('x12ConversionScope', () => {
  it('states outright when the conversion read less than the interchange carried', () => {
    const scope = x12ConversionScope(x12Groups(X12_SCANNED_TREE));

    expect(scope.isSubset).toBe(true);
    expect(scope.observedTransactions).toBe(2);
    expect(scope.observedGroups).toBe(2);
    expect(scope.convertedLabel).toBe('850 (0001)');
    expect(scope.statement).toMatch(/derived from transaction set 850 \(0001\) alone/);
    expect(scope.statement).toMatch(/described here and nowhere else/);
  });

  it('says the conversion describes the whole interchange when it does', () => {
    const single = clone(X12_SCANNED_TREE);
    single[0].children = [single[0].children![0]];
    const scope = x12ConversionScope(x12Groups(single));

    expect(scope.isSubset).toBe(false);
    expect(scope.statement).toMatch(/describes the whole interchange/);
  });

  it('claims nothing when there is no transaction set to have converted', () => {
    const scope = x12ConversionScope([]);
    expect(scope.convertedLabel).toBeNull();
    expect(scope.isSubset).toBe(false);
    expect(scope.statement).toMatch(/carries no transaction set/);
  });

  it('reads the analyzer’s own subset warning when the panel needs to confirm it', () => {
    expect(x12CanonicalSubsetWarning(scanned)).toMatch(/derived from transaction set 850/);
    expect(x12CanonicalSubsetWarning(pathOnly)).toBeNull();
    expect(x12CanonicalSubsetWarning(null)).toBeNull();
  });
});

describe('x12ConformanceStatement', () => {
  it('says the record is observed and not validated against any implementation guide', () => {
    const statement = x12ConformanceStatement();
    expect(statement).toMatch(/what the interchange itself declared/i);
    expect(statement).toMatch(/no 4010 or 5010 implementation guide/i);
    expect(statement).toMatch(/ST03/);
  });
});

// ---------------------------------------------------------------------------
// Source ranges
// ---------------------------------------------------------------------------

describe('x12SourceRange', () => {
  it('selects exactly the bytes the construct was read from', () => {
    for (const id of ['isa', 'gs-0', 'st-0', 'seg-beg', 'seg-po1-0', 'seg-po1-1']) {
      const found = node(X12_SCANNED_TREE, id);
      const range = x12SourceRange(found.location)!;
      expect(range).not.toBeNull();
      const text = X12_SCANNED_SOURCE.slice(range.offset, range.offset + range.length);
      expect(text).toBe(X12_SCANNED_SOURCE.slice(range.offset, range.offset + range.length).trim());
      expect(text.length).toBe(range.length);
    }
  });

  it('distinguishes the two repeats of one segment by their range', () => {
    const first = x12SourceRange(node(X12_SCANNED_TREE, 'seg-po1-0').location)!;
    const second = x12SourceRange(node(X12_SCANNED_TREE, 'seg-po1-1').location)!;

    expect(X12_SCANNED_SOURCE.slice(first.offset, first.offset + first.length)).toBe(
      'PO1*1*10*EA*4.99',
    );
    expect(X12_SCANNED_SOURCE.slice(second.offset, second.offset + second.length)).toBe(
      'PO1*2*20*EA*9.99',
    );
  });

  it('refuses a location that addresses no bytes', () => {
    expect(x12SourceRange(node(X12_TREE, 'gs-0').location)).toBeNull();
    expect(x12SourceRange({ line: 12, file: 'claim.cpy' })).toBeNull();
    expect(x12SourceRange({ offset: 10 })).toBeNull();
    expect(x12SourceRange({ offset: 10, length: 0 })).toBeNull();
    expect(x12SourceRange({ offset: -1, length: 5 })).toBeNull();
    expect(x12SourceRange(null)).toBeNull();
  });

  it('carries the line only when the record states a usable one', () => {
    expect(x12SourceRange({ offset: 0, length: 5, line: 3 })!.line).toBe(3);
    expect(x12SourceRange({ offset: 0, length: 5, line: 0 })!.line).toBeNull();
    expect(x12SourceRange({ offset: 0, length: 5 })!.line).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Element presence
// ---------------------------------------------------------------------------

describe('x12ElementPresence', () => {
  it('keeps an observed-empty element apart from a withheld one', () => {
    expect(x12ElementPresence(node(X12_SCANNED_TREE, 'el-beg04'))).toBe('empty');
    expect(x12ElementPresence(node(X12_SCANNED_TREE, 'el-beg03'))).toBe('withheld');
  });

  it('keeps an absent position apart from an empty one', () => {
    expect(x12ElementPresence({ id: 'a', kind: 'element', valuePresent: false })).toBe('absent');
    expect(
      x12ElementPresence({ id: 'e', kind: 'element', valuePresent: true, valueLength: 0 }),
    ).toBe('empty');
  });

  it('reports a carried value as valued', () => {
    expect(x12ElementPresence({ id: 'v', kind: 'element', value: 'PO-1' })).toBe('valued');
  });

  it('does not call a repeated element unrecorded — it holds occurrences, not a value', () => {
    const repeated: AnalysisNode = {
      id: 'r',
      kind: 'element',
      attributes: { repeatCount: 3 },
      children: [
        { id: 'r0', kind: 'repetition', value: 'A' },
        { id: 'r1', kind: 'repetition', value: 'B' },
        { id: 'r2', kind: 'repetition', value: 'C' },
      ],
    };
    expect(x12ElementPresence(repeated)).toBe('valued');
  });

  it('says nothing is recorded when nothing is', () => {
    expect(x12ElementPresence({ id: 'n', kind: 'element' })).toBe('unrecorded');
  });

  it('gives every state a label that carries the meaning without colour', () => {
    for (const state of ['valued', 'empty', 'withheld', 'absent', 'unrecorded'] as const) {
      expect(x12PresencePresentation(state).label).toBeTruthy();
    }
    expect(x12PresencePresentation('empty').label).toMatch(/empty/i);
    expect(x12PresencePresentation('absent').label).toMatch(/not present/i);
  });
});

describe('x12Reference', () => {
  it('prefers the recorded reference designator and falls back to the node name', () => {
    expect(x12Reference(node(X12_SCANNED_TREE, 'el-beg04'))).toBe('BEG04');
    expect(x12Reference({ id: 'x', kind: 'element', name: 'NM103' })).toBe('NM103');
    expect(x12Reference({ id: 'x', kind: 'element' })).toBeNull();
  });
});
