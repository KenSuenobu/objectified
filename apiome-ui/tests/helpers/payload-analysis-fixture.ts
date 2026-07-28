/**
 * Shared payload-analysis fixtures (CPDO-2.1, #4797).
 *
 * One place for the analysis records the Format details suites read, so the derivation tests, the
 * component tests, the shell wiring test and the a11y scan all describe the *same* payloads. A
 * fixture that drifted between suites would let one of them keep passing against a shape the others
 * no longer produce.
 *
 * The trees are deliberately different in the ways the tab's behaviour turns on:
 *
 *  - {@link X12_TREE} locates by envelope path and sibling ordinal only — the record of an
 *    interchange whose delimiter scan could not be matched to its parse (CPDO-2.2) — so no node in
 *    it can open the raw viewer, and it carries both a withheld element value and an
 *    observed-*empty* one, which must never be described the same way;
 *  - {@link X12_SCANNED_TREE} is the ordinary case: exact source ranges, declared delimiters,
 *    control totals, two functional groups and a repeated segment, which is what the CPDO-2.2
 *    inspector reads;
 *  - {@link COPYBOOK_TREE} locates by file and line, so its fields open the viewer at a line and
 *    never at a byte range;
 *  - {@link COPYBOOK_LAYOUT_TREE} and {@link COPYBOOK_VARIABLE_TREE} carry CPDO-2.3's storage
 *    arithmetic — computed offsets, REDEFINES overlays, tables and, deliberately, the two ways a
 *    position can be *unknowable*.
 */

import type {
  AnalysisNode,
  AnalysisRecord,
  AnalysisSummary,
} from '../../src/app/utils/catalog-payload-analysis';
import type { FormatCapabilitySnapshot } from '../../src/app/components/ade/dashboard/catalog/formatCapabilityRegistry';

/** An X12 interchange: two functional groups, path-only locations, one withheld element value. */
export const X12_TREE: AnalysisNode[] = [
  {
    id: 'isa',
    kind: 'interchange',
    name: 'ISA',
    label: 'Interchange 000000101',
    attributes: { senderId: 'ACME', elementSeparator: '*' },
    location: { ordinal: 0, path: 'ISA' },
    children: [
      {
        id: 'gs-0',
        kind: 'functional_group',
        name: 'HC',
        label: 'Functional group HC (1)',
        location: { ordinal: 0, path: 'ISA/GS[0]' },
        children: [
          {
            id: 'st-0',
            kind: 'transaction_set',
            name: '837',
            label: 'Transaction set 837 (0001)',
            attributes: { setId: '837', controlNumber: '0001' },
            location: { ordinal: 0, path: 'ISA/GS[0]/ST[0]' },
            children: [
              {
                id: 'seg-nm1',
                kind: 'segment',
                name: 'NM1',
                attributes: { segmentId: 'NM1', elementCount: 2 },
                location: { ordinal: 4, path: 'ISA/GS[0]/ST[0]/NM1[4]' },
                children: [
                  {
                    id: 'el-nm101',
                    kind: 'element',
                    name: 'NM101',
                    attributes: { position: 'NM101' },
                    location: { ordinal: 0, path: 'ISA/GS[0]/ST[0]/NM1[4]/NM101' },
                    valuePresent: true,
                    valueLength: 20,
                    redacted: true,
                  },
                  {
                    id: 'el-nm102',
                    kind: 'element',
                    name: 'NM102',
                    location: { ordinal: 1, path: 'ISA/GS[0]/ST[0]/NM1[4]/NM102' },
                    valuePresent: true,
                    valueLength: 0,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'gs-1',
        kind: 'functional_group',
        name: 'FA',
        label: 'Functional group FA (2)',
        location: { ordinal: 1, path: 'ISA/GS[1]' },
      },
    ],
  },
];

/** Nodes in {@link X12_TREE} — the number the pane's metrics and row counts are asserted against. */
export const X12_NODE_COUNT = 7;

/**
 * The raw interchange {@link X12_SCANNED_TREE} describes, so a source range can be asserted against
 * the bytes it selects rather than against a remembered number.
 */
export const X12_SCANNED_SOURCE = [
  'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *260116*1015*U*00401*000000004*0*P*>~',
  'GS*PO*SENDERID*RECEIVERID*20260116*1015*10*X*004010~',
  'ST*850*0001~',
  'BEG*00*NE*PO-0002**20260116~',
  'PO1*1*10*EA*4.99~',
  'PO1*2*20*EA*9.99~',
  'SE*5*0001~',
  'GE*1*10~',
  'GS*FA*SENDERID*RECEIVERID*20260116*1015*11*X*004010~',
  'ST*997*0002~',
  'AK1*PO*10~',
  'SE*3*0002~',
  'GE*1*11~',
  'IEA*2*000000004~',
].join('\n');

/** Offset of one segment's text in {@link X12_SCANNED_SOURCE}, so the fixture cannot drift. */
function at(text: string): { offset: number; length: number; line: number } {
  const offset = X12_SCANNED_SOURCE.indexOf(text);
  if (offset < 0) throw new Error(`fixture source does not contain ${text}`);
  return {
    offset,
    length: text.length,
    line: X12_SCANNED_SOURCE.slice(0, offset).split('\n').length,
  };
}

/**
 * An interchange whose scan aligned to its parse: two functional groups, exact source ranges, all
 * four delimiters, declared control totals, a repeated `PO1` and an element written and left empty.
 *
 * Every fact the CPDO-2.2 inspector renders is here, and only facts the Python extractor actually
 * emits — an attribute this tree carries that `edix12_analysis.py` does not would let the UI suite
 * pass against a record the backend never produces.
 */
export const X12_SCANNED_TREE: AnalysisNode[] = [
  {
    id: 'isa',
    kind: 'interchange',
    name: 'ISA',
    label: 'Interchange 000000004',
    attributes: {
      senderId: 'SENDERID',
      receiverId: 'RECEIVERID',
      interchangeVersion: '00401',
      controlNumber: '000000004',
      elementSeparator: '*',
      componentSeparator: '>',
      repetitionSeparatorDeclared: false,
      segmentTerminator: '~',
      functionalGroupCount: 2,
      declaredFunctionalGroupCount: 2,
      date: '260116',
      time: '1015',
      acknowledgmentRequested: '0',
      usageIndicator: 'P',
      usageIndicatorLabel: 'Production',
    },
    location: { ...at(X12_SCANNED_SOURCE.split('~')[0]), ordinal: 0, path: 'ISA' },
    children: [
      {
        id: 'gs-0',
        kind: 'functional_group',
        name: 'PO',
        label: 'Functional group PO (10)',
        attributes: {
          functionalId: 'PO',
          version: '004010',
          sender: 'SENDERID',
          receiver: 'RECEIVERID',
          controlNumber: '10',
          transactionSetCount: 1,
          declaredTransactionSetCount: 1,
          date: '20260116',
          time: '1015',
          responsibleAgencyCode: 'X',
        },
        location: {
          ...at('GS*PO*SENDERID*RECEIVERID*20260116*1015*10*X*004010'),
          ordinal: 0,
          path: 'ISA/GS[0]',
        },
        children: [
          {
            id: 'st-0',
            kind: 'transaction_set',
            name: '850',
            label: 'Transaction set 850 (0001)',
            attributes: {
              setId: '850',
              controlNumber: '0001',
              segmentCount: 3,
              declaredSegmentCount: 5,
              envelopeSegmentCount: 5,
            },
            location: { ...at('ST*850*0001'), ordinal: 0, path: 'ISA/GS[0]/ST[0]' },
            children: [
              {
                id: 'seg-beg',
                kind: 'segment',
                name: 'BEG',
                attributes: {
                  segmentId: 'BEG',
                  elementCount: 4,
                  elementPositionCount: 5,
                  repeatIndex: 0,
                  repeatCount: 1,
                },
                location: {
                  ...at('BEG*00*NE*PO-0002**20260116'),
                  ordinal: 0,
                  path: 'ISA/GS[0]/ST[0]/BEG[0]',
                },
                children: [
                  {
                    id: 'el-beg03',
                    kind: 'element',
                    name: 'BEG03',
                    attributes: { position: '03', reference: 'BEG03' },
                    location: { ordinal: 2, path: 'ISA/GS[0]/ST[0]/BEG[0]/BEG03' },
                    valuePresent: true,
                    valueLength: 7,
                    redacted: true,
                  },
                  {
                    id: 'el-beg04',
                    kind: 'element',
                    name: 'BEG04',
                    attributes: { position: '04', reference: 'BEG04' },
                    location: { ordinal: 3, path: 'ISA/GS[0]/ST[0]/BEG[0]/BEG04' },
                    valuePresent: true,
                    valueLength: 0,
                  },
                ],
              },
              {
                id: 'seg-po1-0',
                kind: 'segment',
                name: 'PO1',
                label: 'PO1 (1 of 2)',
                attributes: {
                  segmentId: 'PO1',
                  elementCount: 4,
                  elementPositionCount: 4,
                  repeatIndex: 0,
                  repeatCount: 2,
                },
                location: {
                  ...at('PO1*1*10*EA*4.99'),
                  ordinal: 1,
                  path: 'ISA/GS[0]/ST[0]/PO1[1]',
                },
              },
              {
                id: 'seg-po1-1',
                kind: 'segment',
                name: 'PO1',
                label: 'PO1 (2 of 2)',
                attributes: {
                  segmentId: 'PO1',
                  elementCount: 4,
                  elementPositionCount: 4,
                  repeatIndex: 1,
                  repeatCount: 2,
                },
                location: {
                  ...at('PO1*2*20*EA*9.99'),
                  ordinal: 2,
                  path: 'ISA/GS[0]/ST[0]/PO1[2]',
                },
              },
            ],
          },
        ],
      },
      {
        id: 'gs-1',
        kind: 'functional_group',
        name: 'FA',
        label: 'Functional group FA (11)',
        attributes: {
          functionalId: 'FA',
          version: '004010',
          sender: 'SENDERID',
          receiver: 'RECEIVERID',
          controlNumber: '11',
          transactionSetCount: 1,
          declaredTransactionSetCount: 1,
        },
        location: {
          ...at('GS*FA*SENDERID*RECEIVERID*20260116*1015*11*X*004010'),
          ordinal: 1,
          path: 'ISA/GS[1]',
        },
        children: [
          {
            id: 'st-1',
            kind: 'transaction_set',
            name: '997',
            label: 'Transaction set 997 (0002)',
            attributes: {
              setId: '997',
              controlNumber: '0002',
              segmentCount: 1,
              // Deliberately disagreeing with the body: SE01 says 4, the envelope holds 3.
              declaredSegmentCount: 4,
              envelopeSegmentCount: 3,
            },
            location: { ...at('ST*997*0002'), ordinal: 0, path: 'ISA/GS[1]/ST[0]' },
            children: [
              {
                id: 'seg-ak1',
                kind: 'segment',
                name: 'AK1',
                attributes: {
                  segmentId: 'AK1',
                  elementCount: 2,
                  elementPositionCount: 2,
                  repeatIndex: 0,
                  repeatCount: 1,
                },
                location: { ...at('AK1*PO*10'), ordinal: 0, path: 'ISA/GS[1]/ST[0]/AK1[0]' },
              },
            ],
          },
        ],
      },
    ],
  },
];

/** A copybook layout: line-addressed locations, so the raw viewer *can* be opened at a field. */
export const COPYBOOK_TREE: AnalysisNode[] = [
  {
    id: 'rec-claim',
    kind: 'record',
    name: 'CLAIM-RECORD',
    attributes: { level: 1 },
    location: { file: 'claim.cpy', line: 1, path: 'CLAIM-RECORD' },
    children: [
      {
        id: 'fld-amount',
        kind: 'field',
        name: 'CLAIM-AMOUNT',
        attributes: { level: 5, picture: 'S9(7)V99', usage: 'COMP-3' },
        location: { file: 'claim.cpy', line: 12, path: 'CLAIM-RECORD/CLAIM-AMOUNT' },
        valuePresent: false,
      },
    ],
  },
];

/**
 * An `available` X12 analysis stored under the default `structural` value-visibility policy.
 *
 * @param overrides Fields to replace on the document (status, metrics, warnings, …).
 */
export function x12Record(overrides: Partial<AnalysisRecord['analysis']> = {}): AnalysisRecord {
  return {
    analysisId: 'an-1',
    analysisSequence: 1,
    versionRecordId: 'ver-1',
    contentFingerprint: 'f'.repeat(64),
    analyzedAt: '2026-07-01T00:00:00Z',
    analysis: {
      schemaVersion: '1.1.0',
      status: 'available',
      statusReason: null,
      sourceFormat: 'edix12',
      sourceHash: `sha256:${'a'.repeat(64)}`,
      analyzer: { key: 'edix12', version: '1.0.0', toolVersions: { pyx12: '4.0.1' } },
      capabilities: {
        supported: ['x12.functional_group'],
        unsupported: ['x12.hl_hierarchy'],
        limits: {},
      },
      tree: X12_TREE,
      metrics: {
        nodeCount: X12_NODE_COUNT,
        maxDepth: 5,
        truncated: false,
        droppedNodeCount: 0,
        kindCounts: {
          interchange: 1,
          functional_group: 2,
          transaction_set: 1,
          segment: 1,
          element: 2,
        },
        warningCount: 0,
      },
      warnings: [],
      redaction: {
        valueVisibility: 'structural',
        redactedNodeCount: 1,
        policySource: 'default',
        valuePreviewLimit: 120,
      },
      ...overrides,
    },
  };
}

/**
 * A fixed-length copybook laid out end to end, with two REDEFINES overlays over one span of storage
 * and a set of 88-level conditions (CPDO-2.3).
 *
 * The numbers mirror what `cobolcopybook_analysis.py` computes for the shipped
 * `03-payment-redefines.cpy`: a 55-byte record whose overlays both start at byte 18 and neither of
 * which pushes `PAYMENT-POSTED-DATE` past 48. A fixture that drifted from the extractor would let
 * this suite pass against a record the backend never produces.
 */
export const COPYBOOK_LAYOUT_TREE: AnalysisNode[] = [
  {
    id: 'rec-payment',
    kind: 'record',
    name: 'PAYMENT-RECORD',
    attributes: { level: 1, childCount: 6, offset: 1, length: 55, totalLength: 55 },
    location: { file: 'payment.cpy', line: 7, path: 'PAYMENT-RECORD' },
    children: [
      {
        id: 'fld-id',
        kind: 'field',
        name: 'PAYMENT-ID',
        attributes: {
          level: 5,
          picture: '9(10)',
          offset: 1,
          length: 10,
          totalLength: 10,
          storageBasis: 'display',
          digits: 10,
        },
        location: { file: 'payment.cpy', line: 8, path: 'PAYMENT-RECORD/PAYMENT-ID' },
      },
      {
        id: 'fld-type',
        kind: 'field',
        name: 'PAYMENT-TYPE',
        attributes: {
          level: 5,
          picture: 'X(1)',
          conditionCount: 2,
          offset: 11,
          length: 1,
          totalLength: 1,
          storageBasis: 'display',
        },
        location: { file: 'payment.cpy', line: 9, path: 'PAYMENT-RECORD/PAYMENT-TYPE' },
        children: [
          {
            id: 'cond-card',
            kind: 'condition',
            name: 'PAY-BY-CARD',
            attributes: { level: 88, conditionValue: 'C' },
            location: { file: 'payment.cpy', line: 10, path: 'PAYMENT-RECORD/PAYMENT-TYPE/PAY-BY-CARD' },
          },
          {
            id: 'cond-bank',
            kind: 'condition',
            name: 'PAY-BY-BANK',
            attributes: { level: 88, conditionValue: 'B' },
            location: { file: 'payment.cpy', line: 11, path: 'PAYMENT-RECORD/PAYMENT-TYPE/PAY-BY-BANK' },
          },
        ],
      },
      {
        id: 'fld-amount',
        kind: 'field',
        name: 'PAYMENT-AMOUNT',
        attributes: {
          level: 5,
          picture: 'S9(9)V99',
          usage: 'COMP-3',
          offset: 12,
          length: 6,
          totalLength: 6,
          storageBasis: 'packed',
          digits: 11,
          decimals: 2,
          signed: true,
        },
        location: { file: 'payment.cpy', line: 12, path: 'PAYMENT-RECORD/PAYMENT-AMOUNT' },
      },
      {
        id: 'fld-detail',
        kind: 'field',
        name: 'PAYMENT-DETAIL',
        attributes: {
          level: 5,
          picture: 'X(30)',
          offset: 18,
          length: 30,
          totalLength: 30,
          storageBasis: 'display',
          redefinedBy: ['CARD-DETAIL', 'BANK-DETAIL'],
        },
        location: { file: 'payment.cpy', line: 13, path: 'PAYMENT-RECORD/PAYMENT-DETAIL' },
      },
      {
        id: 'grp-card',
        kind: 'group',
        name: 'CARD-DETAIL',
        attributes: {
          level: 5,
          childCount: 2,
          offset: 18,
          length: 30,
          totalLength: 30,
          redefines: 'PAYMENT-DETAIL',
        },
        location: { file: 'payment.cpy', line: 14, path: 'PAYMENT-RECORD/CARD-DETAIL' },
        children: [
          {
            id: 'fld-card-number',
            kind: 'field',
            name: 'CARD-NUMBER',
            attributes: {
              level: 10,
              picture: '9(16)',
              offset: 18,
              length: 16,
              totalLength: 16,
              storageBasis: 'display',
              digits: 16,
            },
            location: { file: 'payment.cpy', line: 15, path: 'PAYMENT-RECORD/CARD-DETAIL/CARD-NUMBER' },
          },
          {
            id: 'fld-card-expiry',
            kind: 'field',
            name: 'CARD-EXPIRY-YYMM',
            attributes: {
              level: 10,
              picture: '9(4)',
              offset: 34,
              length: 4,
              totalLength: 4,
              storageBasis: 'display',
              digits: 4,
            },
            location: {
              file: 'payment.cpy',
              line: 16,
              path: 'PAYMENT-RECORD/CARD-DETAIL/CARD-EXPIRY-YYMM',
            },
          },
        ],
      },
      {
        id: 'grp-bank',
        kind: 'group',
        name: 'BANK-DETAIL',
        attributes: {
          level: 5,
          childCount: 1,
          offset: 18,
          length: 30,
          totalLength: 30,
          redefines: 'PAYMENT-DETAIL',
        },
        location: { file: 'payment.cpy', line: 17, path: 'PAYMENT-RECORD/BANK-DETAIL' },
        children: [
          {
            id: 'fld-bank-routing',
            kind: 'field',
            name: 'BANK-ROUTING',
            attributes: {
              level: 10,
              picture: '9(9)',
              offset: 18,
              length: 9,
              totalLength: 9,
              storageBasis: 'display',
              digits: 9,
            },
            location: { file: 'payment.cpy', line: 18, path: 'PAYMENT-RECORD/BANK-DETAIL/BANK-ROUTING' },
          },
        ],
      },
      {
        id: 'fld-posted',
        kind: 'field',
        name: 'PAYMENT-POSTED-DATE',
        attributes: {
          level: 5,
          picture: '9(8)',
          offset: 48,
          length: 8,
          totalLength: 8,
          storageBasis: 'display',
          digits: 8,
        },
        location: { file: 'payment.cpy', line: 19, path: 'PAYMENT-RECORD/PAYMENT-POSTED-DATE' },
      },
    ],
  },
];

/**
 * A copybook carrying both ways a position becomes unknowable (CPDO-2.3): a variable table, whose
 * DEPENDING ON controller this copybook does not declare, and an item whose PICTURE cannot be
 * sized — so the record has no total length at all.
 */
export const COPYBOOK_VARIABLE_TREE: AnalysisNode[] = [
  {
    id: 'rec-order',
    kind: 'record',
    name: 'ORDER-RECORD',
    attributes: { level: 1, childCount: 3, offset: 1, variableLength: true },
    location: { file: 'order.cpy', line: 1, path: 'ORDER-RECORD' },
    children: [
      {
        id: 'fld-order-id',
        kind: 'field',
        name: 'ORDER-ID',
        attributes: {
          level: 5,
          picture: '9(6)',
          offset: 1,
          length: 6,
          totalLength: 6,
          storageBasis: 'display',
          digits: 6,
        },
        location: { file: 'order.cpy', line: 2, path: 'ORDER-RECORD/ORDER-ID' },
      },
      {
        id: 'grp-lines',
        kind: 'group',
        name: 'ORDER-LINES',
        attributes: {
          level: 5,
          childCount: 1,
          occursMin: 1,
          occursMax: 9,
          dependingOn: 'OUTER-LINE-COUNT',
          offset: 7,
          length: 4,
          totalLength: 36,
          minTotalLength: 4,
          variableLength: true,
        },
        location: { file: 'order.cpy', line: 3, path: 'ORDER-RECORD/ORDER-LINES' },
        children: [
          {
            id: 'fld-line-sku',
            kind: 'field',
            name: 'LINE-SKU',
            attributes: {
              level: 10,
              picture: 'X(4)',
              offset: 7,
              length: 4,
              totalLength: 4,
              storageBasis: 'display',
            },
            location: { file: 'order.cpy', line: 4, path: 'ORDER-RECORD/ORDER-LINES/LINE-SKU' },
          },
        ],
      },
      {
        id: 'fld-note',
        kind: 'field',
        name: 'ORDER-NOTE',
        // No length: PIC N is a national item, whose width depends on an encoding the copybook
        // does not state. And no offset: it sits after the variable table.
        attributes: { level: 5, picture: 'N(8)', offsetVariable: true },
        location: { file: 'order.cpy', line: 5, path: 'ORDER-RECORD/ORDER-NOTE' },
      },
    ],
  },
];

/**
 * The CPDO-2.2 case: an X12 analysis whose scan aligned, so it carries source ranges, delimiters,
 * control totals and repeat counts — and an `info` warning stating that the canonical conversion
 * read one of its two transaction sets.
 *
 * @param overrides Fields to replace on the document.
 */
export function x12ScannedRecord(
  overrides: Partial<AnalysisRecord['analysis']> = {},
): AnalysisRecord {
  return x12Record({
    // Deep-copied, because these suites edit a returned record to build their cases — a shared tree
    // would let one test's edit decide the next test's fixture.
    analyzer: { key: 'edix12', version: '1.1.0', toolVersions: { pyx12: '4.0.1' } },
    capabilities: {
      supported: [
        'x12.byte_offsets',
        'x12.empty_elements',
        'x12.envelope_control_totals',
        'x12.functional_group',
        'x12.repeating_elements',
        'x12.segment_repeat_counts',
      ],
      unsupported: ['x12.hl_hierarchy', 'x12.implementation_guide_validation'],
      limits: { maxNodes: 5000, maxDepth: 32 },
    },
    tree: JSON.parse(JSON.stringify(X12_SCANNED_TREE)) as AnalysisNode[],
    metrics: {
      nodeCount: 11,
      maxDepth: 5,
      truncated: false,
      droppedNodeCount: 0,
      kindCounts: {
        interchange: 1,
        functional_group: 2,
        transaction_set: 2,
        segment: 4,
        element: 2,
      },
      warningCount: 1,
    },
    warnings: [
      {
        code: 'x12.canonical_projection_subset',
        severity: 'info',
        message:
          'The canonical model is derived from transaction set 850 (0001) in functional group PO alone.',
      },
    ],
    ...overrides,
  });
}

/** The assumption sentences the copybook analyzer publishes with every computed length. */
export const COPYBOOK_ASSUMPTION_MESSAGE =
  'Storage offsets and lengths are computed under assumptions this copybook does not state: ' +
  'One byte per character position — a single-byte encoding (EBCDIC or ASCII). ' +
  'COMP-3 items are packed two digits per byte with a trailing sign nibble. ' +
  'No SYNCHRONIZED alignment is applied, so no slack bytes are inserted between items.';

/**
 * The CPDO-2.3 case: a fixed-length copybook laid out end to end, with REDEFINES overlays and the
 * assumptions its byte counts rest on.
 *
 * @param overrides Fields to replace on the document.
 */
export function copybookLayoutRecord(
  overrides: Partial<AnalysisRecord['analysis']> = {},
): AnalysisRecord {
  return copybookRecord({
    analyzer: { key: 'cobolcopybook', version: '1.1.0', toolVersions: { cobolcopybook_parser: '1.1.0' } },
    capabilities: {
      supported: [
        'copybook.computed_storage_length',
        'copybook.redefines',
        'copybook.storage_offsets',
        'copybook.variable_length_records',
      ],
      unsupported: ['copybook.character_encoding_detection', 'copybook.renames_66'],
      limits: { maxNodes: 5000, maxDepth: 32 },
    },
    // Deep-copied, because these suites edit a returned record to build their cases.
    tree: JSON.parse(JSON.stringify(COPYBOOK_LAYOUT_TREE)) as AnalysisNode[],
    metrics: {
      nodeCount: 11,
      maxDepth: 3,
      truncated: false,
      droppedNodeCount: 0,
      kindCounts: { record: 1, group: 2, field: 6, condition: 2 },
      warningCount: 1,
    },
    warnings: [
      { code: 'copybook.layout_assumptions', severity: 'info', message: COPYBOOK_ASSUMPTION_MESSAGE },
    ],
    ...overrides,
  });
}

/**
 * The CPDO-2.3 hard case: a variable-length record whose ODO controller this copybook does not
 * declare, and one item whose PICTURE cannot be sized at all.
 *
 * @param overrides Fields to replace on the document.
 */
export function copybookVariableRecord(
  overrides: Partial<AnalysisRecord['analysis']> = {},
): AnalysisRecord {
  return copybookLayoutRecord({
    status: 'partial',
    statusReason: 'unsupported_format',
    tree: JSON.parse(JSON.stringify(COPYBOOK_VARIABLE_TREE)) as AnalysisNode[],
    metrics: {
      nodeCount: 5,
      maxDepth: 3,
      truncated: false,
      droppedNodeCount: 0,
      kindCounts: { record: 1, group: 1, field: 3 },
      warningCount: 4,
    },
    warnings: [
      {
        code: 'copybook.unsized_item',
        severity: 'warning',
        message:
          "1 item(s) have no computable storage length (ORDER-NOTE). The PICTURE 'N(8)' uses a symbol this analysis does not size.",
      },
      {
        code: 'copybook.variable_length_record',
        severity: 'info',
        message:
          'This record carries a variable-length table, so one record occupies a range this analysis could not compute rather than a fixed size.',
      },
      {
        code: 'copybook.odo_controller_unresolved',
        severity: 'info',
        message:
          'DEPENDING ON names OUTER-LINE-COUNT, which this copybook does not declare. The controller may be declared in a surrounding copybook this one is copied into.',
      },
      { code: 'copybook.layout_assumptions', severity: 'info', message: COPYBOOK_ASSUMPTION_MESSAGE },
    ],
    ...overrides,
  });
}

/** An `available`, unbounded, warning-free copybook analysis. */
export function copybookRecord(overrides: Partial<AnalysisRecord['analysis']> = {}): AnalysisRecord {
  return {
    analysisId: 'an-2',
    analysisSequence: 1,
    analyzedAt: '2026-07-01T00:00:00Z',
    analysis: {
      schemaVersion: '1.1.0',
      status: 'available',
      statusReason: null,
      sourceFormat: 'cobolcopybook',
      sourceHash: `sha256:${'b'.repeat(64)}`,
      analyzer: { key: 'cobolcopybook', version: '1.0.0', toolVersions: {} },
      capabilities: { supported: ['copybook.occurs'], unsupported: ['copybook.redefines'], limits: {} },
      tree: COPYBOOK_TREE,
      metrics: {
        nodeCount: 2,
        maxDepth: 2,
        truncated: false,
        droppedNodeCount: 0,
        kindCounts: { record: 1, field: 1 },
        warningCount: 0,
      },
      warnings: [],
      redaction: {
        valueVisibility: 'none',
        redactedNodeCount: 0,
        policySource: 'format',
        valuePreviewLimit: 120,
      },
      ...overrides,
    },
  };
}

/**
 * The same copybook analysis as {@link copybookRecord}, but `partial` because the analyzer's node
 * budget bounded it — with one record-scoped error (REDEFINES is not parsed) and one node-scoped
 * warning, so the two warning surfaces can be told apart.
 */
export function boundedCopybookRecord(): AnalysisRecord {
  return copybookRecord({
    status: 'partial',
    statusReason: 'bounds_exceeded',
    metrics: {
      nodeCount: 2,
      maxDepth: 2,
      truncated: true,
      droppedNodeCount: 314,
      kindCounts: { record: 1, field: 1 },
      warningCount: 2,
    },
    warnings: [
      {
        code: 'copybook.redefines_unsupported',
        severity: 'error',
        message: 'REDEFINES is not parsed; the redefining field is not described.',
      },
      {
        code: 'copybook.odo_uncalculable',
        severity: 'warning',
        message: 'The OCCURS DEPENDING ON controller was not resolvable.',
        nodeId: 'fld-amount',
        location: { file: 'claim.cpy', line: 12 },
      },
    ],
  });
}

/**
 * An analysis wide enough to exceed the tree's windowing budget once its root is expanded.
 *
 * @param childCount Segments to hang off the single interchange root.
 */
export function wideRecord(childCount: number): AnalysisRecord {
  const record = x12Record();
  record.analysis.tree = [
    {
      id: 'isa',
      kind: 'interchange',
      name: 'ISA',
      label: 'Interchange wide',
      children: Array.from({ length: childCount }, (_, index) => ({
        id: `seg-${index}`,
        kind: 'segment',
        name: `SEG${index}`,
        location: { ordinal: index, path: `ISA/SEG[${index}]` },
      })),
    },
  ];
  record.analysis.metrics.nodeCount = childCount + 1;
  return record;
}

/** The tree-free summary the catalog detail read embeds for {@link x12Record}. */
export const AVAILABLE_SUMMARY: AnalysisSummary = {
  available: true,
  status: 'available',
  statusReason: null,
  schemaVersion: '1.1.0',
  sourceFormat: 'edix12',
  analyzerKey: 'edix12',
  analyzerVersion: '1.0.0',
  nodeCount: X12_NODE_COUNT,
  maxDepth: 5,
  truncated: false,
  warningCount: 0,
  kindCounts: { interchange: 1 },
  capabilities: { supported: [], unsupported: [], limits: {} },
  valueVisibility: 'structural',
  analysisId: 'an-1',
  versionRecordId: 'ver-1',
  analyzedAt: '2026-07-01T00:00:00Z',
};

/** The summary of a revision whose source material was never captured — no tree is fetchable. */
export const UNAVAILABLE_SUMMARY: AnalysisSummary = {
  ...AVAILABLE_SUMMARY,
  available: false,
  status: 'unavailable',
  statusReason: 'no_source_captured',
  nodeCount: 0,
  maxDepth: 0,
  kindCounts: {},
  analysisId: null,
};

/** A trustworthy CPDO-2.4 snapshot: one reviewed format plus the absences these suites resolve. */
export const REGISTRY_SNAPSHOT: FormatCapabilitySnapshot = {
  version: '1',
  review_date: '2026-07-28',
  analysis_schema_version: '1.1.0',
  absence_categories: [
    'source_missing',
    'not_analyzed',
    'format_unsupported',
    'parse_limit',
    'analyzer_failed',
    'value_redacted',
    'absent_in_source',
    'undeclared',
  ],
  absences: [
    {
      category: 'source_missing',
      category_label: 'Source not captured',
      summary_template:
        'No source material was captured, so there is nothing to analyse for {construct}.',
      remediation: 'Re-import the item so its source is captured.',
      source_missing: true,
    },
    {
      category: 'parse_limit',
      category_label: 'Parser limit',
      summary_template: 'apiome does not describe {construct}; the source may well contain it.',
      remediation: 'Read the original source to confirm.',
      source_missing: false,
    },
  ],
  reason_absence_categories: {
    not_analyzed: 'not_analyzed',
    no_source_captured: 'source_missing',
    unsupported_format: 'format_unsupported',
    bounds_exceeded: 'parse_limit',
    analyzer_failed: 'analyzer_failed',
  },
  formats: [
    {
      format: 'edix12',
      label: 'EDI X12',
      paradigm: 'data_schema',
      provenance: 'reviewed',
      availability: 'available',
      unavailable_reason: null,
      native_hierarchy: 'native',
      native_hierarchy_note: 'Interchange → functional group → transaction set → segment → element.',
      analyzer: { key: 'edix12', version: '1.0.0', tool_versions: { pyx12: '4.0.1' } },
      source_location: { quality: 'path_only', note: 'Envelope path and sibling ordinal only.' },
      value_visibility: {
        default: 'structural',
        maximum: 'full',
        note: 'Element values are observed; the default keeps presence and length.',
      },
      supported_constructs: ['x12.functional_group'],
      unsupported_constructs: ['x12.hl_hierarchy'],
      limits: { maxNodes: 5000, maxDepth: 32 },
      canonical_projection: {
        coverage: 'partial',
        dropped_constructs: ['x12.interchange_envelope'],
        note: 'Normalization reads the first functional group.',
      },
      conversion: {
        support: 'supported',
        canonical_formats: ['edix12'],
        normalizes_in_adapter: false,
        declared_formats: ['edi', 'x12'],
        note: 'Reaches the canonical model through edix12.',
      },
      notes: [],
      registry_version: '1',
      review_date: '2026-07-28',
    },
  ],
};
