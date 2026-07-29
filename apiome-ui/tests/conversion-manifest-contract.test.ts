/**
 * Conversion projection wire-contract tests over recorded REST output (CPDO-4.1, #4804).
 *
 * Every other conversion-projection suite builds its pages by hand; this one feeds the *recorded*
 * conversation the apiome-rest routes produced — the dry-run plus the full projection cursor walk
 * for the multi-group X12 corpus fixture, real payload analysis attached — through the UI's
 * parsing and view-model layers. What it pins:
 *
 * - the recorded pages pass `conversionEvidencePageIssues` (the integrity gate the paging hook
 *   refuses on), so the UI's idea of a well-formed page is the server's;
 * - `buildConversionProjectionRows` + `reconcileConversionCounts` reproduce the summary's
 *   declared totals from the pages — the manifest-status-totals-reconcile acceptance criterion,
 *   asserted on the wire shape rather than a hand-built one;
 * - every non-retained recorded row carries a reason and lands in the documented lane, and the
 *   `inferred` → `synthesized` vocabulary bridge holds;
 * - safe-default remediation recognises exactly the recorded `info.title` / `info.version` /
 *   `servers` checklist rows it is documented to;
 * - the recorded wire text carries none of the fixture's business values (redaction by
 *   construction, verified on this side of the wire too).
 *
 * Fixture: `tests/fixtures/conversionProjectionParity.json`, a checked-in copy of the apiome-rest
 * recorded envelope `tests/fixtures/conversion_projection_parity.json` (also copied to
 * `apiome-cli/tests/fixtures/conversion-projection-parity.json`). Regenerate all copies together
 * when the contract changes: in apiome-rest run
 * `pytest tests/test_conversion_manifest_golden.py --update-golden`, then re-copy.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  conversionEvidencePageIssues,
  type CatalogProjectionResponse,
  type ConversionProjectionEdge,
  type ConversionProjectionNode,
} from '@/app/utils/conversion-projection';
import {
  buildConversionProjectionRows,
  buildConversionProjectionView,
  conversionEntryAriaLabel,
  conversionLaneForStatus,
  reconcileConversionCounts,
  safeDefaultForRow,
  sharedStatusFor,
  type ConversionProjectionRow,
} from '@/app/components/ade/dashboard/catalog/conversionProjectionGraph';

interface ParityEnvelope {
  envelope_version: number;
  corpus_path: string;
  dry_run_projection: CatalogProjectionResponse['summary'];
  responses: CatalogProjectionResponse[];
  expected: {
    edge_count: number;
    node_count: number;
    page_count: number;
    status_totals: Record<string, number>;
    manifest_hash: string;
  };
}

const RAW = readFileSync(join(__dirname, 'fixtures', 'conversionProjectionParity.json'), 'utf-8');
const ENVELOPE: ParityEnvelope = JSON.parse(RAW);

/** A fresh deep copy per test, so mutation in one test cannot leak into another. */
function envelope(): ParityEnvelope {
  return JSON.parse(RAW) as ParityEnvelope;
}

/** Assemble rows exactly as the paging hook does: every page's edges, nodes de-duplicated. */
function assembleRows(responses: CatalogProjectionResponse[]): ConversionProjectionRow[] {
  const nodes = new Map<string, ConversionProjectionNode>();
  const edges: ConversionProjectionEdge[] = [];
  for (const response of responses) {
    for (const node of response.page.nodes) nodes.set(node.id, node);
    edges.push(...response.page.edges);
  }
  return buildConversionProjectionRows([...nodes.values()], edges);
}

describe('recorded wire pages', () => {
  it('pass the integrity gate the paging hook refuses on', () => {
    for (const response of envelope().responses) {
      expect(conversionEvidencePageIssues(response.page)).toEqual([]);
    }
  });

  it('agree with each other and the dry run about the snapshot identity', () => {
    const { responses, dry_run_projection: dryRun, expected } = envelope();
    for (const response of responses) {
      expect(response.summary.manifest_hash).toBe(expected.manifest_hash);
      expect(response.page.manifest_hash).toBe(expected.manifest_hash);
      expect(response.page.total).toBe(expected.edge_count);
    }
    expect(dryRun.manifest_hash).toBe(expected.manifest_hash);
  });

  it('carry none of the fixture payload values the interchange holds', () => {
    // Business values from edi-x12/04-multi-group-po-ack.edi; construct names may appear, values
    // must not (CPDO-3.2 redaction by construction).
    for (const probe of ['PO-0002', 'SENDERID', 'PART-100']) {
      expect(RAW).not.toContain(probe);
    }
  });
});

describe('view model over recorded pages', () => {
  it('reassembles exactly the totals the summary declares', () => {
    const { responses, expected } = envelope();
    const rows = assembleRows(responses);

    expect(rows).toHaveLength(expected.edge_count);
    expect(reconcileConversionCounts(responses[0].summary, rows)).toEqual([]);

    const tally: Record<string, number> = {};
    for (const row of rows) tally[row.conversionStatus] = (tally[row.conversionStatus] ?? 0) + 1;
    expect(tally).toEqual(expected.status_totals);
  });

  it('maps every recorded status onto the shared vocabulary and its documented lane', () => {
    const rows = assembleRows(envelope().responses);
    for (const row of rows) {
      expect(row.status).toBe(sharedStatusFor(row.conversionStatus));
      expect(conversionLaneForStatus(row.conversionStatus)).toBeTruthy();
    }
    // The bridge the recorded conversion happens not to exercise stays pinned: the manifest's
    // `inferred` has no shared-machinery twin and must ride on `synthesized`.
    expect(sharedStatusFor('inferred')).toBe('synthesized');
  });

  it('gives every non-retained recorded row a reason', () => {
    for (const row of assembleRows(envelope().responses)) {
      if (row.conversionStatus === 'retained') continue;
      expect(row.reason).toBeTruthy();
    }
  });

  it('recognises safe-default remediation on exactly the documented checklist rows', () => {
    const rows = assembleRows(envelope().responses);
    const byKey = new Map(rows.map((row) => [row.constructKey, row]));

    const expectations: Array<[string, 'title' | 'version' | 'servers']> = [
      ['info.title', 'title'],
      ['info.version', 'version'],
      ['servers', 'servers'],
    ];
    for (const [key, field] of expectations) {
      const row = byKey.get(key);
      expect(row).toBeDefined();
      const remediation = safeDefaultForRow(row as ConversionProjectionRow);
      if (row!.conversionStatus === 'retained') {
        expect(remediation).toBeNull();
      } else {
        expect(remediation?.field).toBe(field);
      }
    }

    // And never on a row that is not one of the three safe defaults.
    const other = rows.find(
      (row) =>
        row.scope === 'checklist' &&
        !['info.title', 'info.version', 'servers'].includes(row.constructKey ?? ''),
    );
    expect(other).toBeDefined();
    expect(safeDefaultForRow(other as ConversionProjectionRow)).toBeNull();
  });

  it('builds an accessible view: every entry names itself', () => {
    const view = buildConversionProjectionView(assembleRows(envelope().responses));
    expect(view.entries.length).toBeGreaterThan(0);
    for (const entry of view.entries) {
      expect(conversionEntryAriaLabel(entry)).not.toHaveLength(0);
    }
  });
});
