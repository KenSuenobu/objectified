/**
 * The rules the Catalog item detail runs on (HIVE-7.2, #5319).
 *
 * The screen this ticket redesigned is the largest in the epic — eight panes, two format
 * inspectors, a projection graph and a test bench — and every decision it makes used to live
 * inside a 1,431-line client component. That is why this suite exists at all: the ticket's
 * acceptance criteria are about *decisions* ("Convert and Export are hidden when deleted",
 * "a deleted source keeps its struck-through, read-only treatment", "the waive dialog is
 * preserved"), and asserting a decision by mounting a screen and reading its DOM is slower to
 * run, slower to read, and stops telling you *which* rule broke.
 *
 * Everything here is pure. Nothing renders.
 *
 * @see `src/app/components/ade/catalog/detail/catalogItemView.ts`
 */

import {
  CATALOG_DETAIL_TAB_IDS,
  CATALOG_LIST_HREF,
  CATALOG_PROVENANCE_STEPS,
  CATALOG_SURFACE_TILES,
  CONVERTED_PROJECT_DELETED_HINT,
  PROVENANCE_ABSENT,
  catalogConvertedStrip,
  catalogDetailActions,
  catalogDetailBreadcrumb,
  catalogDetailDescription,
  catalogDetailIdLine,
  catalogDetailLifecycle,
  catalogDetailOrbs,
  catalogDetailStatusLabel,
  catalogDetailTabFromQuery,
  catalogDetailTabs,
  catalogDetailTimestamp,
  catalogFormatNodeHref,
  catalogImportJobRef,
  catalogModelCountLine,
  catalogQualityBand,
  catalogSourceChips,
  catalogSourceHeadline,
  catalogSourceKindView,
  catalogSurfaceCountLine,
  catalogSurfaceTileFoot,
  catalogToolVersions,
  isCatalogDetailReadonly,
  type CatalogDetailItem,
  type CatalogSourceDescriptor,
} from '@/app/components/ade/catalog/detail/catalogItemView';
import type { ProjectQualitySnapshot } from '@/app/utils/project-quality-score-history';

/** A live, scored, converted item — the state the mockup draws. */
const ITEM: CatalogDetailItem = {
  id: 'c3a5e1f0-0000-4000-8000-000000000001',
  name: 'Claims 837P',
  slug: 'claims-837p',
  description: 'Professional healthcare claim interchange from the Contoso Health clearinghouse.',
  enabled: true,
  deleted_at: null,
  qualityScore: 84,
  qualityGrade: 'B',
  sourceFormat: 'x12',
  conversion: null,
};

/** A file upload whose bytes were captured. */
const SOURCE: CatalogSourceDescriptor = {
  kind: 'file',
  label: 'claims-837p-sample.edi',
  uri: 'upload://claims-837p-sample.edi',
  hasContent: true,
  downloadable: true,
};

describe('identity', () => {
  it('reads the lifecycle the list reads, with deleted winning over disabled', () => {
    expect(catalogDetailLifecycle(ITEM)).toBe('active');
    expect(catalogDetailLifecycle({ ...ITEM, enabled: false })).toBe('disabled');
    // Both flags set: a deleted item is not merely switched off, and the header's one badge
    // has to say the stronger of the two.
    expect(catalogDetailLifecycle({ ...ITEM, enabled: false, deleted_at: '2026-08-15' })).toBe(
      'deleted',
    );
  });

  it('labels the status badge with the list vocabulary, so the two screens cannot drift', () => {
    expect(catalogDetailStatusLabel(ITEM)).toBe('Active');
    expect(catalogDetailStatusLabel({ ...ITEM, enabled: false })).toBe('Disabled');
    expect(catalogDetailStatusLabel({ ...ITEM, deleted_at: '2026-08-15' })).toBe('Deleted');
  });

  it('builds the Home › Bring in › Catalog › item trail, with the group step unlinked', () => {
    const trail = catalogDetailBreadcrumb(ITEM);
    expect(trail.map((step) => step.label)).toEqual([
      'Home',
      'Bring in',
      'Catalog',
      'Claims 837P',
    ]);
    // "Bring in" is a rail section, not a destination.
    expect(trail[1].href).toBeUndefined();
    expect(trail[2].href).toBe(CATALOG_LIST_HREF);
    // The item itself is where the reader already is.
    expect(trail[3].href).toBeUndefined();
  });

  it('prints the short id, and the slug after it when there is one', () => {
    expect(catalogDetailIdLine(ITEM)).toBe('cat_c3a5e · claims-837p');
    expect(catalogDetailIdLine({ ...ITEM, slug: null })).toBe('cat_c3a5e');
    // Whitespace is not a slug.
    expect(catalogDetailIdLine({ ...ITEM, slug: '   ' })).toBe('cat_c3a5e');
  });

  it('stands in for a missing description rather than leaving the line blank', () => {
    expect(catalogDetailDescription(ITEM)).toBe(ITEM.description);
    expect(catalogDetailDescription({ ...ITEM, description: null })).toBe('No description.');
    expect(catalogDetailDescription({ ...ITEM, description: '  ' })).toBe('No description.');
  });
});

describe("the header's verbs", () => {
  it('offers Convert, Export and View code on a live item', () => {
    const actions = catalogDetailActions(ITEM);
    expect(actions.convert.shown).toBe(true);
    expect(actions.export.shown).toBe(true);
    expect(actions.viewCode.shown).toBe(true);
  });

  it('relabels Convert once the item has been converted', () => {
    expect(catalogDetailActions(ITEM).convert.label).toBe('Convert to OpenAPI Project');
    const reconverted = catalogDetailActions({
      ...ITEM,
      conversion: { projectId: 'p1', projectName: 'Claims 837P (OpenAPI)', reconverted: true },
    });
    expect(reconverted.convert.label).toMatch(/^Re-convert/);
  });

  it('hides the two verbs that would write once the item is deleted, and keeps the one that reads', () => {
    // This is the acceptance criterion, stated once. Convert mints a project and Export starts
    // a generation run; neither is meaningful against a tombstone. Reading what was imported
    // still is.
    const actions = catalogDetailActions({ ...ITEM, deleted_at: '2026-08-15T09:41:00Z' });
    expect(actions.convert.shown).toBe(false);
    expect(actions.export.shown).toBe(false);
    expect(actions.viewCode.shown).toBe(true);
  });

  it('freezes the Related artifacts panel for a deleted item', () => {
    expect(isCatalogDetailReadonly(ITEM)).toBe(false);
    expect(isCatalogDetailReadonly({ ...ITEM, deleted_at: '2026-08-15T09:41:00Z' })).toBe(true);
  });
});

describe('the orbs', () => {
  const snapshot = (overall: number, grade: string): ProjectQualitySnapshot =>
    ({ overall, grade, recordedAt: '2026-08-15T09:41:00Z' }) as ProjectQualitySnapshot;

  it('lets the server score win over a browser-local snapshot', () => {
    const orbs = catalogDetailOrbs(ITEM, [snapshot(62, 'C')]);
    expect(orbs.quality).toBe(84);
    expect(orbs.grade).toBe('B');
  });

  it('falls back to the newest local snapshot when the server never scored it', () => {
    const orbs = catalogDetailOrbs({ ...ITEM, qualityScore: null, qualityGrade: null }, [
      snapshot(50, 'D'),
      snapshot(76, 'B'),
    ]);
    expect(orbs.quality).toBe(76);
    expect(orbs.grade).toBe('B');
  });

  it('draws the unscored ring when neither exists', () => {
    const orbs = catalogDetailOrbs({ ...ITEM, qualityScore: null, qualityGrade: null }, []);
    expect(orbs.quality).toBeNull();
    expect(orbs.grade).toBeNull();
  });

  it('sends the Quality orb to the server report whenever there is a server score', () => {
    // Even with stale local snapshots from an unrelated import flow — the rule
    // `catalogQualityOpensServerLintReport` already states, delegated rather than restated.
    expect(catalogDetailOrbs(ITEM, [snapshot(62, 'C')]).qualityOpensLintReport).toBe(true);
    expect(
      catalogDetailOrbs({ ...ITEM, qualityScore: null }, [snapshot(62, 'C')])
        .qualityOpensLintReport,
    ).toBe(false);
  });
});

describe('the quality band', () => {
  it('speaks the grade vocabulary, not the attention one', () => {
    // 84 is a B in the product's grade bands (70–89) even though the ring paints it `accent`
    // rather than `ok`. The two vocabularies are deliberately different; this is the words.
    expect(catalogQualityBand(84)).toEqual({
      band: 'Good · 70–89',
      detail: 'Minor improvements needed.',
    });
    expect(catalogQualityBand(95)?.band).toBe('Excellent · 90–100');
    expect(catalogQualityBand(10)?.band).toBe('Poor · 0–49');
  });

  it('has nothing to say about a score that was never taken', () => {
    expect(catalogQualityBand(null)).toBeNull();
    expect(catalogQualityBand(undefined)).toBeNull();
    expect(catalogQualityBand(Number.NaN)).toBeNull();
  });
});

describe('the converted strip', () => {
  const conversion = {
    projectId: 'proj_5c0d21',
    projectName: 'Claims 837P (OpenAPI)',
    versionId: 'ver_5c0d21',
    reconverted: true,
  };

  it('draws nothing at all for an item that was never converted', () => {
    expect(catalogConvertedStrip(null)).toBeNull();
    expect(catalogConvertedStrip(undefined)).toBeNull();
  });

  it('states the conversion, its version and its live target', () => {
    const strip = catalogConvertedStrip(conversion, 2)!;
    expect(strip.title).toBe('Re-converted to OpenAPI project');
    expect(strip.versionId).toBe('ver_5c0d21');
    expect(strip.projectLabel).toBe('Claims 837P (OpenAPI)');
    expect(strip.projectHref).toContain('proj_5c0d21');
    expect(strip.deletedHint).toBeNull();
    expect(strip.countLine).toBe('2 conversions on record');
  });

  it('says "Converted" for a first conversion', () => {
    expect(catalogConvertedStrip({ ...conversion, reconverted: false })!.title).toBe(
      'Converted to OpenAPI project',
    );
  });

  it('strikes the name through, with the mockup wording, when the target project was deleted', () => {
    // The acceptance criterion: "Deleted-source states keep their struck-through, read-only
    // treatment". No href is what strikes it through; the hint is what says why.
    const strip = catalogConvertedStrip({ ...conversion, projectDeleted: true }, 1)!;
    expect(strip.projectHref).toBeNull();
    expect(strip.deletedHint).toBe(CONVERTED_PROJECT_DELETED_HINT);
    expect(strip.countLine).toBe('1 conversion on record');
  });

  it('counts nothing until the history has loaded', () => {
    expect(catalogConvertedStrip(conversion, 0)!.countLine).toBeNull();
  });
});

describe('the tabs', () => {
  it('draws the eight panes in the mockup order, with the mockup labels', () => {
    expect(catalogDetailTabs().map((tab) => tab.id)).toEqual([...CATALOG_DETAIL_TAB_IDS]);
    expect(catalogDetailTabs().map((tab) => tab.label)).toEqual([
      'Overview',
      'Format details',
      'Source & code',
      'Provenance',
      'Conversions',
      'Lint & score',
      'Test bench',
      'Versions',
    ]);
  });

  it('draws no chip until a counted pane has loaded — and draws "0" once it has', () => {
    // The distinction the whole function exists for: `0` is a count, "not loaded" is not.
    const cold = catalogDetailTabs();
    expect(cold.find((tab) => tab.id === 'conversions')!.count).toBeNull();
    const loaded = catalogDetailTabs({ conversions: 0, lint: 6, versions: 3 });
    expect(loaded.find((tab) => tab.id === 'conversions')!.count).toBe(0);
    expect(loaded.find((tab) => tab.id === 'lint')!.count).toBe(6);
    expect(loaded.find((tab) => tab.id === 'versions')!.count).toBe(3);
    // The five uncounted panes never grow one.
    expect(loaded.filter((tab) => tab.count !== null)).toHaveLength(3);
  });

  it('ignores a count that is not a finite number', () => {
    const tabs = catalogDetailTabs({ lint: Number.NaN, versions: null });
    expect(tabs.find((tab) => tab.id === 'lint')!.count).toBeNull();
    expect(tabs.find((tab) => tab.id === 'versions')!.count).toBeNull();
  });

  describe('deep links', () => {
    it('lets a compatibility source link win over any ?tab=', () => {
      // `?tab=source&sourcePath=&line=` (CLX-2.3) names a place in the raw source, so it opens
      // Source & code even when `?tab=` says something else.
      expect(catalogDetailTabFromQuery('lint', { sourcePath: 'main.proto', line: null })).toBe(
        'source',
      );
      expect(catalogDetailTabFromQuery(null, { sourcePath: null, line: 42 })).toBe('source');
      expect(catalogDetailTabFromQuery('source', null)).toBe('source');
    });

    it('honours a ?tab= naming a known pane', () => {
      expect(catalogDetailTabFromQuery('format', null)).toBe('format');
      expect(catalogDetailTabFromQuery('test-bench', null)).toBe('test-bench');
    });

    it('leaves the reader where they are for anything else', () => {
      // `null`, not `overview`: an unknown value must not blank the shell.
      expect(catalogDetailTabFromQuery('nonsense', null)).toBeNull();
      expect(catalogDetailTabFromQuery(null, null)).toBeNull();
      expect(catalogDetailTabFromQuery('', { sourcePath: '', line: null })).toBeNull();
    });
  });

  it('addresses one native construct with a shareable, encoded URL', () => {
    expect(catalogFormatNodeHref('cat_1', 'n_1f2a')).toBe(
      '/ade/dashboard/catalog/cat_1?tab=format&node=n_1f2a',
    );
    expect(catalogFormatNodeHref('cat/1', 'n 2')).toBe(
      '/ade/dashboard/catalog/cat%2F1?tab=format&node=n%202',
    );
  });
});

describe('the Overview pane', () => {
  it('names and draws the four surfaces in one place', () => {
    expect(CATALOG_SURFACE_TILES.map((tile) => tile.key)).toEqual([
      'services',
      'operations',
      'types',
      'channels',
    ]);
    // The tone is an identity: the tile's glyph and the bar slice beside it are the same
    // colour, which is the reason the two are drawn together at all.
    expect(CATALOG_SURFACE_TILES.map((tile) => tile.tone)).toEqual([
      'ok',
      'accent',
      'violet',
      'rose',
    ]);
  });

  it('separates "not captured" from "captured, and none"', () => {
    expect(catalogSurfaceTileFoot(27, 94)).toBe('94% of surface');
    expect(catalogSurfaceTileFoot(0, null)).toBe('None captured');
    expect(catalogSurfaceTileFoot(null, null)).toBe('Not captured');
    expect(catalogSurfaceTileFoot(undefined, 3)).toBe('Not captured');
  });

  it('pluralises the two count lines and stays silent when there is nothing to count', () => {
    expect(catalogSurfaceCountLine(29)).toBe('29 normalized entities');
    expect(catalogSurfaceCountLine(1)).toBe('1 normalized entity');
    expect(catalogSurfaceCountLine(0)).toBeNull();
    expect(catalogModelCountLine(28, 143)).toBe('28 entities · 143 fields');
    expect(catalogModelCountLine(1, 1)).toBe('1 entity · 1 field');
  });

  it('speaks each intake kind, and has a word for the one it was never told', () => {
    expect(catalogSourceKindView('file').label).toBe('File upload');
    expect(catalogSourceKindView('url').label).toBe('Fetched from URL');
    expect(catalogSourceKindView('paste').label).toBe('Pasted content');
    expect(catalogSourceKindView('discovery').label).toBe('Discovered endpoint');
    expect(catalogSourceKindView(null).label).toBe('Unknown intake');
  });

  it('distinguishes "we kept the bytes" from "we kept a pointer"', () => {
    const captured = catalogSourceChips(SOURCE);
    expect(captured.map((chip) => chip.label)).toEqual([
      'Content captured',
      'Downloadable',
      'upload://claims-837p-sample.edi',
    ]);
    expect(captured[0].tone).toBe('ok');
    expect(captured[2].uri).toBe(true);

    // Not a silent omission — the two are different promises.
    const referenced = catalogSourceChips({ ...SOURCE, hasContent: false, downloadable: false });
    expect(referenced.map((chip) => chip.label)).toEqual([
      'Reference only',
      'upload://claims-837p-sample.edi',
    ]);
    expect(referenced[0].tone).toBe('neutral');
  });

  it('names the source, falling back to the URI and then to a sentence', () => {
    expect(catalogSourceHeadline(SOURCE)).toBe('claims-837p-sample.edi');
    expect(catalogSourceHeadline({ ...SOURCE, label: null })).toBe(SOURCE.uri);
    expect(catalogSourceHeadline({ ...SOURCE, label: null, uri: null })).toBe(
      'No source reference captured',
    );
    expect(catalogSourceHeadline(null)).toBe('No source reference captured');
  });
});

describe('the Provenance pane', () => {
  it('keeps the four step titles and captions verbatim, in one place', () => {
    // The mockup's Keeps list fixes these; four inline JSX blocks is where a typo hides.
    expect(CATALOG_PROVENANCE_STEPS.map((step) => step.title)).toEqual([
      'Source intake',
      'Format detection',
      'Normalization',
      'Catalog record',
    ]);
    expect(CATALOG_PROVENANCE_STEPS.map((step) => step.step)).toEqual([1, 2, 3, 4]);
    expect(CATALOG_PROVENANCE_STEPS[0].caption).toBe('Where the imported document came from.');
    expect(CATALOG_PROVENANCE_STEPS[3].caption).toBe(
      'The import job that minted this item, and who ran it when.',
    );
  });

  it('has a stand-in for every fact that was never recorded', () => {
    expect(PROVENANCE_ABSENT.detection).toBe('No detected format or protocol was recorded.');
    expect(PROVENANCE_ABSENT.normalization).toBe(
      'Tool versions were not recorded for this import.',
    );
  });

  it('finds the import job under whichever of six spellings the importer used', () => {
    expect(catalogImportJobRef({ importJobId: 'job_2c9f4a71' })).toBe('job_2c9f4a71');
    expect(catalogImportJobRef({ import_job_id: ' job_2 ' })).toBe('job_2');
    expect(catalogImportJobRef({ job_id: 41 })).toBe('41');
    expect(catalogImportJobRef({ importJob: '' })).toBeNull();
    expect(catalogImportJobRef(null)).toBeNull();
    expect(catalogImportJobRef({ somethingElse: 'x' })).toBeNull();
  });

  it('drops the empty entries from the toolchain rather than printing blank chips', () => {
    expect(
      catalogToolVersions({
        'x12-adapter': '1.4.0',
        pyx12: ' 3.1.0 ',
        blank: '',
        missing: null,
        undef: undefined,
      }),
    ).toEqual([
      { tool: 'x12-adapter', version: '1.4.0' },
      { tool: 'pyx12', version: '3.1.0' },
    ]);
    expect(catalogToolVersions(null)).toEqual([]);
  });

  it('tolerates a timestamp it cannot parse instead of printing "Invalid Date"', () => {
    expect(catalogDetailTimestamp(null)).toBe('—');
    expect(catalogDetailTimestamp(undefined)).toBe('—');
    expect(catalogDetailTimestamp('not a date')).toBe('not a date');
    expect(catalogDetailTimestamp('2026-08-15T09:41:00Z')).not.toBe('—');
  });
});
