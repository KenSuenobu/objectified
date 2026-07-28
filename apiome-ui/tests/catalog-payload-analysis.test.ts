/**
 * Payload-analysis contract and tree derivations (CPDO-2.1, #4797).
 *
 * The Format details tab is a renderer; every rule it applies lives in
 * `catalog-payload-analysis.ts`, and this suite is where those rules are pinned. The assertions are
 * deliberately about *truthfulness* rather than shape, because the whole point of the analysis
 * contract is that absence has a vocabulary:
 *
 * - a withheld value, an observed-empty value and an absent value produce three different
 *   sentences, and none of them can be mistaken for another;
 * - only a location carrying a **line** can be opened in the line-addressed raw viewer, so an X12
 *   node (envelope path + ordinal, no byte offsets) yields no line and therefore no "view source";
 * - the filter searches names, constructs and locations and **never observed values**, because
 *   under a `full` visibility policy those are payload material;
 * - a status outside the contract's vocabulary claims nothing;
 * - a deep link into a node the analysis does not carry resolves to nothing rather than to the
 *   nearest node.
 */

import { describe, expect, it } from '@jest/globals';

import {
  analysisKindLabel,
  analysisNodeLabel,
  analysisNodeMatchesFilter,
  analysisStatusPresentation,
  buildAnalysisTreeRows,
  countAnalysisNodes,
  defaultExpandedAnalysisIds,
  findAnalysisTypeaheadIndex,
  isAnalysisRecord,
  kindCountEntries,
  locateAnalysisNode,
  nodeAttributeEntries,
  nodeSourceLine,
  nodeValueStatement,
  analysisHref,
  sortAnalysisWarnings,
  sourceLocationText,
  valueVisibilityStatement,
  warningsByNode,
  type AnalysisNode,
  type AnalysisWarning,
} from '../src/app/utils/catalog-payload-analysis';
import { X12_NODE_COUNT, X12_TREE } from './helpers/payload-analysis-fixture';

describe('status and vocabulary presentation', () => {
  it('gives each contract status its own label, tone, and tree expectation', () => {
    expect(analysisStatusPresentation('available')).toMatchObject({
      label: 'Available',
      tone: 'positive',
      treeExpected: true,
    });
    expect(analysisStatusPresentation('partial')).toMatchObject({
      label: 'Partial',
      tone: 'caution',
      treeExpected: true,
    });
    expect(analysisStatusPresentation('unavailable')).toMatchObject({
      label: 'Unavailable',
      treeExpected: false,
    });
    expect(analysisStatusPresentation('failed')).toMatchObject({
      label: 'Analyzer failed',
      tone: 'negative',
      treeExpected: false,
    });
  });

  it('claims nothing for a status outside the contract vocabulary', () => {
    const presentation = analysisStatusPresentation('quantum');
    expect(presentation.treeExpected).toBe(false);
    expect(presentation.tone).toBe('neutral');
    expect(presentation.statement).toMatch(/nothing is claimed/i);
  });

  it('states each value-visibility level, and never invents wording for an unknown one', () => {
    expect(valueVisibilityStatement('none')).toMatch(/not even whether a value was there/i);
    expect(valueVisibilityStatement('structural')).toMatch(/never what it said/i);
    expect(valueVisibilityStatement('full')).toMatch(/observed values are carried/i);
    expect(valueVisibilityStatement('telepathic')).toMatch(/no wording for/i);
  });

  it('labels every shipped analyzer kind and passes an unknown kind through verbatim', () => {
    expect(analysisKindLabel('functional_group')).toBe('Functional group');
    expect(analysisKindLabel('transaction_set')).toBe('Transaction set');
    expect(analysisKindLabel('condition')).toBe('Condition');
    expect(analysisKindLabel('opaque')).toBe('Opaque');
    expect(analysisKindLabel('edifact_interchange')).toBe('edifact_interchange');
  });

  it('prefers the analyzer label, then the name, then the id for a row label', () => {
    expect(analysisNodeLabel({ id: 'a', kind: 'segment', name: 'NM1', label: 'Name segment' })).toBe(
      'Name segment',
    );
    expect(analysisNodeLabel({ id: 'a', kind: 'segment', name: 'NM1', label: '  ' })).toBe('NM1');
    expect(analysisNodeLabel({ id: 'a', kind: 'segment' })).toBe('a');
  });
});

describe('source locations', () => {
  it('yields a line only for a location that carries a positive integer line', () => {
    expect(nodeSourceLine({ line: 42 })).toBe(42);
    expect(nodeSourceLine({ line: 0 })).toBeNull();
    expect(nodeSourceLine({ line: -3 })).toBeNull();
    expect(nodeSourceLine({ line: 4.5 })).toBeNull();
    expect(nodeSourceLine(null)).toBeNull();
    expect(nodeSourceLine(undefined)).toBeNull();
  });

  it('never yields a line for an X12 node, which locates by envelope path and ordinal', () => {
    const element = locateAnalysisNode(X12_TREE, 'el-nm101')!.node;
    expect(element.location?.path).toBe('ISA/GS[0]/ST[0]/NM1[4]/NM101');
    // The consequence the tab depends on: no line means no raw-viewer jump is offered.
    expect(nodeSourceLine(element.location)).toBeNull();
  });

  it('renders a copybook location as file:line plus its structural path', () => {
    expect(sourceLocationText({ file: 'claim.cpy', line: 42, path: 'CLAIM/AMOUNT' })).toBe(
      'claim.cpy:42 · CLAIM/AMOUNT',
    );
    expect(sourceLocationText({ line: 7 })).toBe('line 7');
  });

  it('falls back to ordinal, then byte offset, and yields null for a location addressing nothing', () => {
    expect(sourceLocationText({ ordinal: 3 })).toBe('#3');
    expect(sourceLocationText({ offset: 128 })).toBe('byte 128');
    expect(sourceLocationText({})).toBeNull();
    expect(sourceLocationText(null)).toBeNull();
  });
});

describe('node value statements', () => {
  it('says withheld — never empty — for a value policy took away', () => {
    const withheld = nodeValueStatement(locateAnalysisNode(X12_TREE, 'el-nm101')!.node, 'structural');
    expect(withheld.withheld).toBe(true);
    expect(withheld.value).toBeNull();
    expect(withheld.text).toMatch(/20 characters was observed and withheld/i);
    expect(withheld.text).not.toMatch(/empty/i);
  });

  it('distinguishes an observed-empty value from an absent one', () => {
    const empty = nodeValueStatement(locateAnalysisNode(X12_TREE, 'el-nm102')!.node, 'structural');
    expect(empty.withheld).toBe(false);
    expect(empty.text).toMatch(/present in the source and it was empty/i);

    const absent = nodeValueStatement(
      { id: 'x', kind: 'element', valuePresent: false },
      'structural',
    );
    expect(absent.text).toMatch(/no value was present in the source/i);
    expect(absent.text).not.toMatch(/empty/i);
  });

  it('returns the observed value only when the record actually carries one', () => {
    const full = nodeValueStatement({ id: 'x', kind: 'field', value: 'ACME CLINIC' }, 'full');
    expect(full.value).toBe('ACME CLINIC');
    expect(full.text).toBe('Value: ACME CLINIC');
    expect(full.withheld).toBe(false);
  });

  it('attributes a `none`-visibility silence to the policy rather than to the source', () => {
    const silent = nodeValueStatement({ id: 'x', kind: 'element' }, 'none');
    expect(silent.text).toMatch(/carries nothing about values/i);
    // Under any other policy the honest statement is about the record, not the policy.
    expect(nodeValueStatement({ id: 'x', kind: 'element' }, 'structural').text).toMatch(
      /no value was recorded/i,
    );
  });

  it('pluralises a one-character value correctly', () => {
    expect(
      nodeValueStatement({ id: 'x', kind: 'element', valuePresent: true, valueLength: 1 }, 'structural')
        .text,
    ).toMatch(/1 character was present/);
  });
});

describe('node attributes', () => {
  it('renders scalars, key-sorted, and drops what the analyzer never set', () => {
    expect(
      nodeAttributeEntries({
        id: 'x',
        kind: 'field',
        attributes: {
          usage: 'COMP-3',
          level: 5,
          redefines: null,
          blank: '   ',
          signed: false,
          picture: 'S9(7)V99',
        },
      }),
    ).toEqual([
      ['level', '5'],
      ['picture', 'S9(7)V99'],
      ['signed', 'false'],
      ['usage', 'COMP-3'],
    ]);
  });

  it('JSON-renders a container attribute rather than printing [object Object]', () => {
    expect(
      nodeAttributeEntries({ id: 'x', kind: 'group', attributes: { occurs: { min: 1, max: 9 } } }),
    ).toEqual([['occurs', '{"min":1,"max":9}']]);
  });

  it('drops an attribute that cannot be serialized instead of rendering a broken value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(nodeAttributeEntries({ id: 'x', kind: 'group', attributes: { cyclic } })).toEqual([]);
  });
});

describe('tree rows', () => {
  it('flattens only expanded branches, with ARIA level/setsize/posinset precomputed', () => {
    const rows = buildAnalysisTreeRows(X12_TREE, new Set(['isa']), '');
    // Only the interchange is expanded, so its two functional groups render and nothing below them.
    expect(rows.map((row) => row.id)).toEqual(['isa', 'gs-0', 'gs-1']);
    expect(rows[0]).toMatchObject({ depth: 1, setSize: 1, posInSet: 1, hasChildren: true, expanded: true });
    expect(rows[1]).toMatchObject({ depth: 2, hasChildren: true, expanded: false, ancestorIds: ['isa'] });
    // A leaf carries no expansion state at all — there is nothing under it to promise.
    expect(rows[2]).toMatchObject({ depth: 2, hasChildren: false, expanded: false, posInSet: 2 });
  });

  it('expands roots and their branching children on first paint', () => {
    expect([...defaultExpandedAnalysisIds(X12_TREE)]).toEqual(['isa', 'gs-0']);
  });

  it('records the ancestors a deep link must expand for every row', () => {
    const rows = buildAnalysisTreeRows(X12_TREE, new Set(['isa', 'gs-0', 'st-0', 'seg-nm1']), '');
    const element = rows.find((row) => row.id === 'el-nm101')!;
    expect(element.ancestorIds).toEqual(['isa', 'gs-0', 'st-0', 'seg-nm1']);
    expect(element.depth).toBe(5);
    expect(element.setSize).toBe(2);
    expect(element.posInSet).toBe(1);
  });

  it('force-expands while filtering so a deep match is never hidden by a collapsed parent', () => {
    // Nothing is expanded, and the match is five levels down.
    const rows = buildAnalysisTreeRows(X12_TREE, new Set<string>(), 'NM102');
    expect(rows.map((row) => row.id)).toEqual(['isa', 'gs-0', 'st-0', 'seg-nm1', 'el-nm102']);
    // Its non-matching sibling is not kept — only matches and the ancestors that reveal them.
    expect(rows.some((row) => row.id === 'el-nm101')).toBe(false);
  });

  it('renumbers posinset/setsize against the filtered siblings, not the full set', () => {
    const rows = buildAnalysisTreeRows(X12_TREE, new Set<string>(), 'NM102');
    const match = rows.find((row) => row.id === 'el-nm102')!;
    expect(match).toMatchObject({ setSize: 1, posInSet: 1 });
  });

  it('yields no rows for an empty tree — nothing here invents structure', () => {
    expect(buildAnalysisTreeRows([], new Set(['isa']), '')).toEqual([]);
  });
});

describe('filtering', () => {
  const element = locateAnalysisNode(X12_TREE, 'el-nm101')!.node;

  it('matches on name, kind, human kind label, and source location', () => {
    expect(analysisNodeMatchesFilter(element, 'nm101')).toBe(true);
    expect(analysisNodeMatchesFilter(element, 'element')).toBe(true);
    expect(analysisNodeMatchesFilter(element, 'Element')).toBe(true);
    expect(analysisNodeMatchesFilter(element, 'GS[0]')).toBe(true);
    expect(
      analysisNodeMatchesFilter(
        { id: 'x', kind: 'transaction_set', name: '837', label: 'Transaction set 837 (0001)' },
        'transaction set',
      ),
    ).toBe(true);
  });

  it('never searches observed values — under a `full` policy those are payload material', () => {
    const withValue: AnalysisNode = {
      id: 'x',
      kind: 'element',
      name: 'NM103',
      value: 'SENSITIVE-ACCOUNT-42',
      attributes: { position: 'NM103', note: 'SENSITIVE-ACCOUNT-42' },
    };
    expect(analysisNodeMatchesFilter(withValue, 'SENSITIVE')).toBe(false);
    expect(analysisNodeMatchesFilter(withValue, 'NM103')).toBe(true);
  });

  it('treats a blank query as matching everything', () => {
    expect(analysisNodeMatchesFilter(element, '   ')).toBe(true);
  });
});

describe('type-ahead', () => {
  const rows = buildAnalysisTreeRows(X12_TREE, new Set(['isa', 'gs-0', 'st-0', 'seg-nm1']), '');

  it('finds the next row whose label starts with the buffer, wrapping', () => {
    const nm1 = rows.findIndex((row) => row.id === 'seg-nm1');
    expect(findAnalysisTypeaheadIndex(rows, nm1, 'nm10')).toBe(
      rows.findIndex((row) => row.id === 'el-nm101'),
    );
    // Wrapping: searching forward from the last row reaches the first match again.
    expect(findAnalysisTypeaheadIndex(rows, rows.length - 1, 'interchange')).toBe(0);
  });

  it('returns null for an empty buffer or when nothing matches', () => {
    expect(findAnalysisTypeaheadIndex(rows, 0, '')).toBeNull();
    expect(findAnalysisTypeaheadIndex(rows, 0, 'zzz')).toBeNull();
    expect(findAnalysisTypeaheadIndex([], 0, 'a')).toBeNull();
  });
});

describe('node lookup', () => {
  it('locates a node and the ancestors a deep link must expand', () => {
    expect(locateAnalysisNode(X12_TREE, 'seg-nm1')).toMatchObject({
      ancestorIds: ['isa', 'gs-0', 'st-0'],
    });
  });

  it('resolves an unknown or blank id to nothing rather than to the nearest node', () => {
    expect(locateAnalysisNode(X12_TREE, 'no-such-node')).toBeNull();
    expect(locateAnalysisNode(X12_TREE, '')).toBeNull();
  });

  it('counts every node in the tree', () => {
    expect(countAnalysisNodes(X12_TREE)).toBe(X12_NODE_COUNT);
    expect(countAnalysisNodes([])).toBe(0);
  });
});

describe('metrics presentation', () => {
  it('orders kind counts highest-first, ties by name, and drops empty kinds', () => {
    expect(
      kindCountEntries({ element: 12, segment: 12, interchange: 1, composite: 0 }),
    ).toEqual([
      ['element', 12],
      ['segment', 12],
      ['interchange', 1],
    ]);
    expect(kindCountEntries(null)).toEqual([]);
  });
});

describe('warnings', () => {
  const warnings: AnalysisWarning[] = [
    { code: 'x12.info', severity: 'info', message: 'first' },
    { code: 'copybook.redefines_unsupported', severity: 'error', message: 'boom', nodeId: 'seg-nm1' },
    { code: 'x12.bounds', severity: 'warning', message: 'bounded', nodeId: 'seg-nm1' },
  ];

  it('sorts worst-first without mutating the record', () => {
    const sorted = sortAnalysisWarnings(warnings);
    expect(sorted.map((warning) => warning.severity)).toEqual(['error', 'warning', 'info']);
    expect(warnings[0].severity).toBe('info');
  });

  it('indexes node-scoped warnings worst-first and leaves record-scoped ones unindexed', () => {
    const byNode = warningsByNode(warnings);
    expect([...byNode.keys()]).toEqual(['seg-nm1']);
    expect(byNode.get('seg-nm1')!.map((warning) => warning.severity)).toEqual(['error', 'warning']);
  });
});

describe('transport contract', () => {
  it('accepts a record whose status and tree can be read', () => {
    expect(isAnalysisRecord({ analysis: { status: 'available', tree: [] } })).toBe(true);
  });

  it('refuses a payload whose status or tree cannot be read', () => {
    expect(isAnalysisRecord(null)).toBe(false);
    expect(isAnalysisRecord({})).toBe(false);
    expect(isAnalysisRecord({ analysis: {} })).toBe(false);
    expect(isAnalysisRecord({ analysis: { status: 'available' } })).toBe(false);
    expect(isAnalysisRecord({ analysis: { status: 7, tree: [] } })).toBe(false);
  });

  it('encodes the item id into the proxy path', () => {
    expect(analysisHref('a/b c')).toBe('/api/catalog/a%2Fb%20c/analysis');
  });
});
