/**
 * The pure rules the Export Studio redesign added (HIVE-8.3, #5329).
 *
 * Two modules, one suite, because the two answer the same kind of question — "what does this
 * word mean on screen?" — and both are the *only* place their answer is written:
 *
 *   * `exportTargetFamilies` partitions the thirty-six registry targets into the four family
 *     headings the mockup's Target step draws. The rule that matters is not the partition but
 *     its totality: a paradigm nobody has taught it about still gets a heading, because a
 *     dropped card would silently break "all 36 targets reachable".
 *   * `exportStudioView` maps a status, a severity, a heat level or a job state to a tone from
 *     the shared vocabulary. Before it, the same word chose its own colour in each of the
 *     twenty-three components the five steps are built from.
 */

import {
  EXPORT_TARGET_FAMILIES,
  OTHER_FAMILY,
  familyForParadigm,
  groupTargetsByFamily,
} from '../src/app/components/ade/export-studio/exportTargetFamilies';
import {
  DELIVERY_SEVERITY_TONE,
  ENTITY_KIND_TONE,
  PROJECTION_STATUS_TONE,
  VALIDATION_LENS_TONE,
  deliverySeverityTone,
  entityKindTone,
  eventLevelState,
  lensBadgeTone,
  projectionStatusTone,
  roundtripDiffTone,
  stageRowState,
  validationToneName,
} from '../src/app/components/ade/export-studio/exportStudioView';
import { STATUS_TONES } from '../src/app/components/ui/statusVocabulary';

/* -------------------------------------------------------------------------
   Target families
   ------------------------------------------------------------------------- */

describe('familyForParadigm', () => {
  it('names the headings the mockup prints, in its order', () => {
    expect(EXPORT_TARGET_FAMILIES.map((family) => family.label)).toEqual([
      'REST & HTTP',
      'RPC',
      'Events',
      'Data schema & graph',
      'Agents & tools',
    ]);
  });

  it('routes every paradigm REST actually sends', () => {
    // The wire values of `ApiParadigm` in `apiome-rest/src/app/canonical_model.py`.
    expect(familyForParadigm('rest').key).toBe('rest');
    expect(familyForParadigm('rpc').key).toBe('rpc');
    expect(familyForParadigm('event').key).toBe('event');
    expect(familyForParadigm('data_schema').key).toBe('data');
    // GraphQL joins the data-schema heading: to a reader choosing an export, an SDL is the
    // same kind of answer as Avro — a type system rather than a transport.
    expect(familyForParadigm('graph').key).toBe('data');
    // FMT-2.7 (#5425): the LLM tool-array target made `agent` a paradigm with an emitter
    // behind it, so it has a heading of its own rather than falling to the catch-all.
    expect(familyForParadigm('agent').key).toBe('agent');
  });

  it('normalises case and either spelling of the word separator', () => {
    for (const spelling of ['DATA_SCHEMA', 'data-schema', 'Data Schema', '  data_schema  ']) {
      expect({ spelling, key: familyForParadigm(spelling).key }).toEqual({
        spelling,
        key: 'data',
      });
    }
  });

  it('gives an unknown paradigm a heading rather than dropping its card', () => {
    // A paradigm this table does not know must still appear in the grid, not vanish from
    // it — which is what keeps "every registered target is reachable" true of a registry
    // that grows a member before it grows a heading.
    expect(familyForParadigm('quantum')).toEqual(OTHER_FAMILY);
    expect(familyForParadigm('')).toEqual(OTHER_FAMILY);
    expect(familyForParadigm(null)).toEqual(OTHER_FAMILY);
    expect(familyForParadigm(undefined)).toEqual(OTHER_FAMILY);
  });
});

describe('groupTargetsByFamily', () => {
  const card = (key: string, paradigm: string) => ({ key, paradigm });
  const CARDS = [
    card('proto', 'rpc'),
    card('openapi', 'rest'),
    card('avro', 'data_schema'),
    card('asyncapi', 'event'),
    card('graphql', 'graph'),
    card('raml', 'rest'),
    card('tools', 'agent'),
    card('quantum', 'quantum'),
  ];

  it('draws the families in their declared order, with the catch-all last', () => {
    const groups = groupTargetsByFamily(CARDS, (c) => c.paradigm);
    expect(groups.map((group) => group.key)).toEqual([
      'rest',
      'rpc',
      'event',
      'data',
      'agent',
      'other',
    ]);
  });

  it('keeps the incoming order inside a family, so the readiness sort still ranks', () => {
    const groups = groupTargetsByFamily(CARDS, (c) => c.paradigm);
    const rest = groups.find((group) => group.key === 'rest')!;
    expect(rest.items.map((c) => c.key)).toEqual(['openapi', 'raml']);
    const data = groups.find((group) => group.key === 'data')!;
    expect(data.items.map((c) => c.key)).toEqual(['avro', 'graphql']);
  });

  it('loses no card — the partition is total', () => {
    const groups = groupTargetsByFamily(CARDS, (c) => c.paradigm);
    const drawn = groups.flatMap((group) => group.items.map((c) => c.key));
    expect(drawn.sort()).toEqual(CARDS.map((c) => c.key).sort());
  });

  it('draws no empty heading', () => {
    // A workspace whose registry has no event emitters should not be told there is an empty
    // Events section.
    const groups = groupTargetsByFamily([card('openapi', 'rest')], (c) => c.paradigm);
    expect(groups.map((group) => group.key)).toEqual(['rest']);
  });

  it('returns nothing at all for an empty grid', () => {
    expect(groupTargetsByFamily([], () => 'rest')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   Tones
   ------------------------------------------------------------------------- */

/** Every tone map in this module, so the shape checks below run over all of them at once. */
const TONE_MAPS = {
  PROJECTION_STATUS_TONE,
  ENTITY_KIND_TONE,
  DELIVERY_SEVERITY_TONE,
  VALIDATION_LENS_TONE,
} as const;

describe('every tone this module names is one the shared vocabulary knows', () => {
  it.each(Object.entries(TONE_MAPS))('%s spends only real tones', (_name, map) => {
    for (const [word, tone] of Object.entries(map)) {
      expect({ word, known: STATUS_TONES.includes(tone) }).toEqual({ word, known: true });
    }
  });

  it('names no palette class anywhere — the whole point of the module', () => {
    for (const map of Object.values(TONE_MAPS)) {
      for (const tone of Object.values(map)) {
        expect(tone).not.toMatch(/-\d{2,3}\b/);
        expect(tone).not.toContain('dark:');
      }
    }
  });
});

describe('projectionStatusTone', () => {
  it('covers all seven statuses REST can send', () => {
    expect(Object.keys(PROJECTION_STATUS_TONE).sort()).toEqual(
      [
        'approximated',
        'dropped',
        'not-applicable',
        'retained',
        'synthesized',
        'transformed',
        'unavailable',
      ].sort()
    );
  });

  it('separates a transformation from an untouched construct', () => {
    // A documented transformation is a thing that *happened*, and a reader scanning for "what
    // changed" needs it to separate from the untouched majority.
    expect(projectionStatusTone('retained')).toBe('ok');
    expect(projectionStatusTone('transformed')).toBe('accent');
  });

  it('gets louder as the loss gets worse', () => {
    expect(projectionStatusTone('approximated')).toBe('warn');
    expect(projectionStatusTone('dropped')).toBe('rose');
  });

  it('sets an unknown status aside rather than painting it as understood', () => {
    expect(projectionStatusTone('teleported')).toBe('outline');
    expect(projectionStatusTone(null)).toBe('outline');
  });
});

describe('entityKindTone', () => {
  it('treats a kind as an identity, never as a severity', () => {
    // None of the five may land on the ok/warn/danger axis: an operation is not "worse" than
    // a service, and a reader who has learned that amber means loss must not see it here.
    for (const tone of Object.values(ENTITY_KIND_TONE)) {
      expect(['ok', 'warn', 'danger']).not.toContain(tone);
    }
  });

  it('keeps the most numerous kind quiet', () => {
    // Fields outnumber every other kind by an order of magnitude; a hueful chip on each one
    // would drown the tree.
    expect(entityKindTone('field')).toBe('outline');
  });

  it('gives every kind a distinct tone, so the tree is scannable', () => {
    expect(new Set(Object.values(ENTITY_KIND_TONE)).size).toBe(
      Object.keys(ENTITY_KIND_TONE).length
    );
  });

  it('sets an unknown kind aside', () => {
    expect(entityKindTone('widget')).toBe('outline');
  });
});

describe('deliverySeverityTone', () => {
  it('spends a hue only on the two severities that ask for attention', () => {
    expect(deliverySeverityTone('blocking')).toBe('danger');
    expect(deliverySeverityTone('warning')).toBe('warn');
    expect(deliverySeverityTone('info')).toBe('neutral');
  });

  it('defaults an unknown severity to neutral', () => {
    expect(deliverySeverityTone('catastrophic')).toBe('neutral');
    expect(deliverySeverityTone(undefined)).toBe('neutral');
  });
});

describe('validationToneName', () => {
  it('maps each lens verdict to a vocabulary tone', () => {
    expect(validationToneName('ok')).toBe('ok');
    expect(validationToneName('invalid')).toBe('danger');
    expect(validationToneName('warn')).toBe('warn');
    expect(validationToneName('neutral')).toBe('neutral');
  });

  it('defaults an unknown verdict to neutral', () => {
    expect(validationToneName('sideways')).toBe('neutral');
  });
});

describe('lensBadgeTone', () => {
  it('reads zero findings as a clean pass', () => {
    expect(lensBadgeTone(0, false)).toBe('ok');
    // Zero is clean even if the lens *would* block: there is nothing to block on.
    expect(lensBadgeTone(0, true)).toBe('ok');
  });

  it('separates what blocks delivery from what merely advises', () => {
    expect(lensBadgeTone(3, true)).toBe('danger');
    expect(lensBadgeTone(3, false)).toBe('warn');
  });
});

describe('stageRowState', () => {
  it('passes the four states the stylesheet paints straight through', () => {
    for (const status of ['pending', 'active', 'done', 'failed'] as const) {
      expect(stageRowState(status)).toBe(status);
    }
  });

  it('draws a canceled stage at rest', () => {
    // A canceled run's unreached stages never started; the `Ban` glyph says so, and saying it
    // a second time in colour adds nothing.
    expect(stageRowState('canceled')).toBe('pending');
  });
});

describe('eventLevelState', () => {
  it('is total over what actually reaches the log', () => {
    // The panel filters `info` out, so only these two ever render.
    expect(eventLevelState('error')).toBe('error');
    expect(eventLevelState('warn')).toBe('warn');
    expect(eventLevelState('info')).toBe('warn');
    expect(eventLevelState('')).toBe('warn');
  });
});

describe('roundtripDiffTone', () => {
  it('treats an explained difference as ordinary and an unexplained one as the finding', () => {
    // A difference the fidelity report accounts for is the report being *right*.
    expect(roundtripDiffTone(true)).toBe('neutral');
    expect(roundtripDiffTone(false)).toBe('danger');
  });
});
