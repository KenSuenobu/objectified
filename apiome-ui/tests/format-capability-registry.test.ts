/**
 * TS ⇄ canonical-vocabulary contract test for the source-format capability registry
 * (CPDO-2.4, #4796).
 *
 * The capability vocabulary is duplicated across languages: the Python registry
 * (`apiome-rest/src/app/format_capability_registry.py`) and its TypeScript mirror
 * (`apiome-ui/src/app/components/ade/dashboard/catalog/formatCapabilityRegistry.ts`). REST cannot
 * import TypeScript, so drift between the two is a real risk — a category added on one side but
 * not the other silently turns an honest explanation into a blank.
 *
 * The guard is a single source-of-truth snapshot committed at
 * `scripts/format_capabilities/vocabulary.json`. This test asserts the TypeScript mirror matches
 * it; the Python counterpart (`test_format_capability_registry.py::test_vocabulary_snapshot_
 * matches_the_python_registry`) asserts the same for the Python registry. Either side drifting
 * turns one suite red.
 *
 * It also pins the invariant the whole ticket turns on: `source_missing` is true for exactly one
 * absence category, no analysis reason other than `no_source_captured` reaches it, and no
 * construct-level explanation can ever set it.
 *
 * Follows the mirror-test precedent in `tests/provider-registry-mirror.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ABSENCE_CATEGORIES,
  ANALYSIS_REASON_CODES,
  REASON_ABSENCE_CATEGORIES,
  SOURCE_MISSING_CATEGORY,
  absenceExplanation,
  capabilityForFormat,
  explainAnalysisAbsence,
  explainConstruct,
  isKnownAbsenceCategory,
  isKnownAnalysisReason,
  renderAbsence,
  validateFormatCapabilitySnapshot,
  type AbsenceCategory,
  type AbsenceExplanation,
  type AnalysisReasonCode,
  type FormatCapability,
  type FormatCapabilitySnapshot,
} from '@/app/components/ade/dashboard/catalog/formatCapabilityRegistry';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VOCABULARY_PATH = path.join(REPO_ROOT, 'scripts', 'format_capabilities', 'vocabulary.json');

interface Vocabulary {
  registry_version: string;
  review_date: string;
  analysis_schema_version: string;
  vocabularies: Record<string, string[]>;
  reason_absence_categories: Record<string, string>;
  absences: {
    category: string;
    category_label: string;
    summary_template: string;
    remediation: string;
    source_missing: boolean;
  }[];
}

const vocabulary = JSON.parse(fs.readFileSync(VOCABULARY_PATH, 'utf8')) as Vocabulary;

/** Build a snapshot from the canonical vocabulary, so the fixture cannot drift from the contract. */
function snapshotFromVocabulary(formats: FormatCapability[] = []): FormatCapabilitySnapshot {
  return {
    version: vocabulary.registry_version,
    review_date: vocabulary.review_date,
    analysis_schema_version: vocabulary.analysis_schema_version,
    absence_categories: [...vocabulary.vocabularies.absence_category].sort(),
    absences: vocabulary.absences as AbsenceExplanation[],
    reason_absence_categories: vocabulary.reason_absence_categories,
    formats,
  };
}

const X12_CAPABILITY: FormatCapability = {
  format: 'edix12',
  label: 'EDI X12',
  paradigm: 'data_schema',
  provenance: 'reviewed',
  availability: 'available',
  unavailable_reason: null,
  native_hierarchy: 'native',
  native_hierarchy_note: 'Interchange → functional group → transaction set → segment → element.',
  analyzer: { key: 'edix12', version: '1.0.0', tool_versions: { pyx12: '4.0.0' } },
  source_location: { quality: 'path_only', note: 'Envelope path and sibling ordinal only.' },
  value_visibility: { default: 'structural', maximum: 'full', note: 'Element values are observed.' },
  supported_constructs: ['x12.functional_group', 'x12.segment'],
  unsupported_constructs: ['x12.byte_offsets', 'x12.hl_hierarchy'],
  limits: { maxNodes: 5000, maxDepth: 32 },
  canonical_projection: {
    coverage: 'partial',
    dropped_constructs: ['x12.functional_group'],
    note: 'Normalization reads the first transaction set.',
  },
  conversion: {
    support: 'supported',
    canonical_formats: ['edix12'],
    normalizes_in_adapter: false,
    declared_formats: ['edi', 'edix12', 'x12'],
    note: 'Reaches the canonical model through edix12.',
  },
  notes: ['HL loops are described as segments, not as a hierarchy.'],
  registry_version: vocabulary.registry_version,
  review_date: vocabulary.review_date,
};

describe('format capability vocabulary (TS ⇄ canonical snapshot)', () => {
  it('mirrors the canonical absence categories, in order', () => {
    expect(ABSENCE_CATEGORIES).toEqual(vocabulary.vocabularies.absence_category);
  });

  it('mirrors the canonical analysis reason codes, in order', () => {
    expect(ANALYSIS_REASON_CODES).toEqual(vocabulary.vocabularies.analysis_reason);
  });

  it('mirrors the canonical reason → absence-category map', () => {
    expect(REASON_ABSENCE_CATEGORIES).toEqual(vocabulary.reason_absence_categories);
  });

  it('names the same source-missing category the canonical vocabulary flags', () => {
    const flagged = vocabulary.absences.filter((row) => row.source_missing).map((r) => r.category);
    expect(flagged).toEqual([SOURCE_MISSING_CATEGORY]);
  });

  it('recognises every canonical code and rejects anything else', () => {
    for (const category of vocabulary.vocabularies.absence_category) {
      expect(isKnownAbsenceCategory(category)).toBe(true);
    }
    for (const reason of vocabulary.vocabularies.analysis_reason) {
      expect(isKnownAnalysisReason(reason)).toBe(true);
    }
    expect(isKnownAbsenceCategory('category_from_the_future')).toBe(false);
    expect(isKnownAnalysisReason('reason_from_the_future')).toBe(false);
  });
});

describe('explainAnalysisAbsence', () => {
  const snapshot = snapshotFromVocabulary();

  it('returns nothing for an available analysis — there is no absence to explain', () => {
    expect(explainAnalysisAbsence(snapshot, 'available', null)).toBeNull();
  });

  it.each(Object.entries(vocabulary.reason_absence_categories))(
    'resolves %s onto its reviewed category',
    (reason, category) => {
      const explanation = explainAnalysisAbsence(snapshot, 'unavailable', reason);
      expect(explanation?.category).toBe(category);
    },
  );

  it('claims the source is missing only for no_source_captured', () => {
    const statuses = ['available', 'partial', 'unavailable', 'failed'];
    const reasons: (AnalysisReasonCode | null)[] = [null, ...ANALYSIS_REASON_CODES];
    for (const status of statuses) {
      for (const reason of reasons) {
        const explanation = explainAnalysisAbsence(snapshot, status, reason);
        if (!explanation) {
          expect(status === 'available' && reason === null).toBe(true);
          continue;
        }
        expect(explanation.source_missing).toBe(reason === 'no_source_captured');
      }
    }
  });

  it('treats a bounds limit as a parser limit, not a missing source', () => {
    const explanation = explainAnalysisAbsence(snapshot, 'partial', 'bounds_exceeded');
    expect(explanation?.category).toBe('parse_limit');
    expect(explanation?.source_missing).toBe(false);
  });

  it('claims nothing about the source for a reason code it has never seen', () => {
    const explanation = explainAnalysisAbsence(snapshot, 'unavailable', 'reason_from_the_future');
    expect(explanation?.category).toBe('not_analyzed');
    expect(explanation?.source_missing).toBe(false);
  });

  it('claims nothing about the source for a non-available status with no reason', () => {
    const explanation = explainAnalysisAbsence(snapshot, 'failed', null);
    expect(explanation?.source_missing).toBe(false);
  });
});

describe('explainConstruct', () => {
  const snapshot = snapshotFromVocabulary([X12_CAPABILITY]);

  it('reads a modelled construct’s absence as absent from the source', () => {
    const explanation = explainConstruct(snapshot, X12_CAPABILITY, 'x12.functional_group');
    expect(explanation.availability).toBe('modelled');
    expect(explanation.category).toBe('absent_in_source');
    expect(explanation.summary).toContain('`x12.functional_group`');
  });

  it('reads a knowingly unmodelled construct as a parser limit', () => {
    const explanation = explainConstruct(snapshot, X12_CAPABILITY, 'x12.hl_hierarchy');
    expect(explanation.availability).toBe('unmodelled');
    expect(explanation.category).toBe('parse_limit');
    expect(explanation.remediation).toBeTruthy();
  });

  it('makes no claim about a construct neither list names', () => {
    const explanation = explainConstruct(snapshot, X12_CAPABILITY, 'x12.nobody_declared_this');
    expect(explanation.availability).toBe('undeclared');
    expect(explanation.category).toBe('undeclared');
  });

  it('never reports a construct’s absence as a missing source', () => {
    const constructs = [
      ...X12_CAPABILITY.supported_constructs,
      ...X12_CAPABILITY.unsupported_constructs,
      'something.undeclared',
      '',
    ];
    for (const construct of constructs) {
      const explanation = explainConstruct(snapshot, X12_CAPABILITY, construct);
      expect(explanation.source_missing).toBe(false);
      expect(explanation.category).not.toBe(SOURCE_MISSING_CATEGORY);
    }
  });
});

describe('renderAbsence', () => {
  const snapshot = snapshotFromVocabulary();

  it('substitutes the construct slot with a backticked key', () => {
    const explanation = absenceExplanation(snapshot, 'parse_limit') as AbsenceExplanation;
    expect(renderAbsence(explanation, 'x12.segment')).toContain('`x12.segment`');
    expect(renderAbsence(explanation, 'x12.segment')).not.toContain('{construct}');
  });

  it('reads without a construct', () => {
    const explanation = absenceExplanation(snapshot, 'parse_limit') as AbsenceExplanation;
    expect(renderAbsence(explanation)).toContain('this detail');
    expect(renderAbsence(explanation)).not.toContain('{construct}');
  });
});

describe('capabilityForFormat', () => {
  const snapshot = snapshotFromVocabulary([X12_CAPABILITY]);

  it('resolves case-insensitively and ignores surrounding space', () => {
    expect(capabilityForFormat(snapshot, '  EDIX12 ')?.format).toBe('edix12');
  });

  it('returns null for a format the snapshot does not carry', () => {
    expect(capabilityForFormat(snapshot, 'retired-format')).toBeNull();
    expect(capabilityForFormat(snapshot, null)).toBeNull();
  });
});

describe('validateFormatCapabilitySnapshot', () => {
  it('accepts the canonical vocabulary', () => {
    expect(validateFormatCapabilitySnapshot(snapshotFromVocabulary([X12_CAPABILITY]))).toEqual([]);
  });

  it('rejects an unknown declared absence category', () => {
    const snapshot = snapshotFromVocabulary();
    snapshot.absence_categories = [...snapshot.absence_categories, 'category_from_the_future'];
    expect(validateFormatCapabilitySnapshot(snapshot)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('category_from_the_future') }),
    ]);
  });

  it('rejects an explanation that carries an unknown category', () => {
    const snapshot = snapshotFromVocabulary();
    snapshot.absences = [
      ...snapshot.absences,
      {
        category: 'category_from_the_future' as AbsenceCategory,
        category_label: 'Invented',
        summary_template: '{construct} is unexplained.',
        remediation: 'None.',
        source_missing: false,
      },
    ];
    expect(validateFormatCapabilitySnapshot(snapshot).length).toBeGreaterThan(0);
  });

  it('rejects a parse limit that claims the source is missing', () => {
    const snapshot = snapshotFromVocabulary();
    snapshot.absences = snapshot.absences.map((entry) =>
      entry.category === 'parse_limit' ? { ...entry, source_missing: true } : entry,
    );
    expect(validateFormatCapabilitySnapshot(snapshot)).toEqual([
      expect.objectContaining({
        path: expect.stringContaining('source_missing'),
        message: expect.stringContaining('must not claim'),
      }),
    ]);
  });

  it('rejects a source-missing category that stops claiming it', () => {
    const snapshot = snapshotFromVocabulary();
    snapshot.absences = snapshot.absences.map((entry) =>
      entry.category === SOURCE_MISSING_CATEGORY ? { ...entry, source_missing: false } : entry,
    );
    expect(validateFormatCapabilitySnapshot(snapshot)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('must be the source-missing') }),
    ]);
  });

  it('rejects an unknown reason code in the reason map', () => {
    const snapshot = snapshotFromVocabulary();
    snapshot.reason_absence_categories = {
      ...snapshot.reason_absence_categories,
      reason_from_the_future: 'parse_limit',
    };
    expect(validateFormatCapabilitySnapshot(snapshot)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('reason_from_the_future') }),
    ]);
  });
});
