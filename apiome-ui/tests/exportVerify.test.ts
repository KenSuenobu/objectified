/**
 * exportVerify — verdict derivation, banner copy, lens badge counts, and the Generate gate
 * (MFX-42.1, #4354). Pure logic, tested directly (no React, no fetch), mirroring
 * `exportFidelityPreview.test.ts` / `exportTargetCatalog.test.ts`.
 */

import {
  deriveVerifyVerdict,
  emittedLintLensState,
  emittedLintScore,
  fidelityAcknowledgementMode,
  groupLintFindingsBySeverity,
  isSevereConversion,
  lensBadgeCount,
  lintRulesTriggered,
  lintSeverityCounts,
  validationLensState,
  validationLensTone,
  validatorToolLabel,
  verifyGatePasses,
  verifyVerdictBanner,
  verifyVerdictAlertVariant,
  type EmittedArtifactLintReport,
  type EmittedValidationReport,
  type ExportTranscodeGuard,
  type ExportVerifyResponse,
  type TranscodeVerdict,
} from '../src/app/components/ade/dashboard/export/exportVerify';
import type {
  ExportFidelityEnvelope,
  ExportFidelityTier,
} from '../src/app/components/ade/dashboard/export/exportFidelityPreview';

/** A minimal fidelity envelope with the given tier and kind counts. */
function fidelity(
  tier: ExportFidelityTier,
  kindCounts: Partial<Record<string, number>> = {},
): ExportFidelityEnvelope {
  return {
    target: {
      key: 'proto',
      format: 'proto-3',
      label: 'gRPC / Protobuf',
      description: 'Export services as a .proto file.',
      icon: 'binary',
      paradigm: 'rpc',
      multi_file: false,
      needs_toolchain: false,
      available: true,
      unavailable_reason: null,
    },
    summary: {
      tier,
      preserved_percent: tier === 'lossless' ? 100 : 64,
      total: 10,
      preserved: 6,
      dropped: kindCounts.drop ?? 0,
      approximated: kindCounts.approx ?? 0,
      synthesized: kindCounts.synth ?? 0,
    },
    report: {
      items: [],
      kind_counts: { drop: 0, approx: 0, synth: 0, ok: 0, ...kindCounts },
      severity_counts: { info: 0, warn: 0, critical: 0 },
    },
    advisory: {
      show: tier !== 'lossless',
      severity: tier === 'lossless' ? null : 'warn',
      requires_ack: tier !== 'lossless',
      target_format: 'gRPC / Protobuf',
      dropped: kindCounts.drop ?? 0,
      approximated: kindCounts.approx ?? 0,
      synthesized: kindCounts.synth ?? 0,
      affected: 0,
      headline: 'x',
      message: 'x',
    },
  };
}

/** A validation report with the given verdict; findings default to empty. */
function validation(
  verdict: EmittedValidationReport['verdict'],
  overrides: Partial<EmittedValidationReport> = {},
): EmittedValidationReport {
  return {
    verdict,
    target: 'openapi-3.1',
    blocks_delivery: verdict === 'invalid',
    warns: verdict === 'skipped',
    valid: verdict === 'valid',
    findings: [],
    detail: verdict === 'skipped' ? 'Validator not installed on server.' : null,
    headline: verdict === 'invalid' ? 'Invalid — export blocked' : 'Valid',
    message: 'x',
    ...overrides,
  };
}

/** A transcoding guard with the given band; fields default to a REST→Avro near-empty shape. */
function guard(
  verdict: TranscodeVerdict,
  overrides: Partial<ExportTranscodeGuard> = {},
): ExportTranscodeGuard {
  return {
    verdict,
    requires_confirmation: verdict === 'severe',
    target_format: 'Apache Avro',
    preserved_percent: 31,
    dropped_operations: verdict === 'clean' || verdict === 'lossy' ? 0 : 6,
    dropped_events: 0,
    headline: 'Only schemas will be exported to Apache Avro.',
    message: 'Apache Avro is a types-only format: it can carry this API\'s schemas but not its operations.',
    reasons: [],
    ...overrides,
  };
}

/** Assemble a verify result from its lens parts. */
function result(
  fid: ExportFidelityEnvelope,
  val: EmittedValidationReport,
  lint: EmittedArtifactLintReport | null = null,
  verdict?: ExportVerifyResponse['verdict'],
  grd?: ExportTranscodeGuard | null,
): ExportVerifyResponse {
  return {
    artifact: 'proj-1',
    version: null,
    version_record_id: 'rev-1',
    version_label: '1.0.0',
    fidelity: fid,
    guard: grd ?? null,
    validation: val,
    lint,
    verdict: verdict ?? null,
  };
}

describe('deriveVerifyVerdict', () => {
  it('is invalid when validation blocks delivery — regardless of fidelity tier', () => {
    expect(deriveVerifyVerdict(result(fidelity('lossless'), validation('invalid')))).toBe('invalid');
  });

  it('is lossy when the conversion is loss-bearing but the operational surface survives', () => {
    expect(deriveVerifyVerdict(result(fidelity('lossy', { drop: 2 }), validation('valid')))).toBe(
      'lossy',
    );
  });

  it('is severe for a types-only (near-empty) reduction — MFX-42.4', () => {
    // Fallback path: no guard rode along, so the types-only tier stands in.
    expect(deriveVerifyVerdict(result(fidelity('types-only'), validation('valid')))).toBe('severe');
    // With the guard present: near-empty and severe both promote to the severe band.
    expect(
      deriveVerifyVerdict(result(fidelity('types-only'), validation('valid'), null, null, guard('near-empty'))),
    ).toBe('severe');
    expect(
      deriveVerifyVerdict(result(fidelity('lossy', { drop: 4 }), validation('valid'), null, null, guard('severe'))),
    ).toBe('severe');
  });

  it('promotes a server "lossy" verdict to severe when the guard is near-empty/severe', () => {
    // The endpoint has no severe band (it reports a types-only conversion as lossy); the client
    // must still surface the typed-acknowledgement gate.
    const r = result(fidelity('types-only'), validation('valid'), null, 'lossy', guard('near-empty'));
    expect(deriveVerifyVerdict(r)).toBe('severe');
  });

  it('is clean for a lossless, valid conversion', () => {
    expect(deriveVerifyVerdict(result(fidelity('lossless'), validation('valid')))).toBe('clean');
  });

  it('treats a skipped (toolchain-unavailable) validation as non-blocking', () => {
    // Skipped warns but does not demote a lossless conversion below clean.
    expect(deriveVerifyVerdict(result(fidelity('lossless'), validation('skipped')))).toBe('clean');
  });

  it('prefers a server-supplied verdict over the derived one', () => {
    // Server says invalid even though the lenses would derive clean.
    const r = result(fidelity('lossless'), validation('valid'), null, 'invalid');
    expect(deriveVerifyVerdict(r)).toBe('invalid');
  });

  it('honours a server "lossy" for a lossy-tier conversion with no severe guard', () => {
    const r = result(fidelity('lossy', { drop: 2 }), validation('valid'), null, 'lossy', guard('lossy'));
    expect(deriveVerifyVerdict(r)).toBe('lossy');
  });
});

describe('isSevereConversion (MFX-42.4)', () => {
  it('uses the guard when present — near-empty and severe are severe; clean and lossy are not', () => {
    expect(isSevereConversion(result(fidelity('lossy'), validation('valid'), null, null, guard('near-empty')))).toBe(true);
    expect(isSevereConversion(result(fidelity('lossy'), validation('valid'), null, null, guard('severe')))).toBe(true);
    expect(isSevereConversion(result(fidelity('lossy'), validation('valid'), null, null, guard('lossy')))).toBe(false);
    expect(isSevereConversion(result(fidelity('lossless'), validation('valid'), null, null, guard('clean')))).toBe(false);
  });

  it('falls back to the types-only tier when no guard rode along', () => {
    expect(isSevereConversion(result(fidelity('types-only'), validation('valid')))).toBe(true);
    expect(isSevereConversion(result(fidelity('lossy'), validation('valid')))).toBe(false);
    expect(isSevereConversion(result(fidelity('lossless'), validation('valid')))).toBe(false);
  });
});

describe('fidelityAcknowledgementMode (MFX-42.4)', () => {
  it('maps each verdict to its acknowledgement control', () => {
    expect(fidelityAcknowledgementMode('severe')).toBe('typed');
    expect(fidelityAcknowledgementMode('lossy')).toBe('checkbox');
    expect(fidelityAcknowledgementMode('clean')).toBe('hidden');
    expect(fidelityAcknowledgementMode('invalid')).toBe('hidden');
    expect(fidelityAcknowledgementMode(null)).toBe('hidden');
  });
});

describe('verifyVerdictBanner', () => {
  it('uses the roadmap label strings verbatim', () => {
    expect(verifyVerdictBanner('clean').label).toBe('Clean');
    expect(verifyVerdictBanner('lossy').label).toBe('Lossy — acknowledge to continue');
    expect(verifyVerdictBanner('severe').label).toBe('Severe — acknowledge to continue');
    expect(verifyVerdictBanner('invalid').label).toBe('Invalid — export blocked');
  });

  it('names the types-only outcome in the severe description (MFX-42.4)', () => {
    expect(verifyVerdictBanner('severe').description).toMatch(/types-only artifact/);
  });

  it('maps each verdict to its tone', () => {
    expect(verifyVerdictBanner('clean').tone).toBe('clean');
    expect(verifyVerdictBanner('lossy').tone).toBe('lossy');
    expect(verifyVerdictBanner('severe').tone).toBe('severe');
    expect(verifyVerdictBanner('invalid').tone).toBe('invalid');
  });

  it('routes each verdict to an alert variant, with both stop verdicts on error', () => {
    expect(verifyVerdictAlertVariant('clean')).toBe('success');
    expect(verifyVerdictAlertVariant('lossy')).toBe('warning');
    // HIVE-8.3: `severe` and `invalid` share `error` — the words separate them, not a redder
    // red. What must stay distinct is the go/no-go, which the three variants carry.
    expect(verifyVerdictAlertVariant('severe')).toBe('error');
    expect(verifyVerdictAlertVariant('invalid')).toBe('error');
  });
});

describe('lensBadgeCount', () => {
  const r = result(
    fidelity('lossy', { drop: 2, approx: 1, synth: 3, ok: 5 }),
    validation('invalid', {
      findings: [
        { message: 'a' },
        { message: 'b' },
      ],
    }),
    { applicable: true, findings: [{ severity: 'warning', rule: 'r1', message: 'm' }] },
  );

  it('counts non-faithful constructs (drop + approx + synth, not ok) for fidelity', () => {
    expect(lensBadgeCount('fidelity', r)).toBe(6);
  });

  it('counts validation findings', () => {
    expect(lensBadgeCount('validation', r)).toBe(2);
  });

  it('counts lint findings, 0 when there is no lint report', () => {
    expect(lensBadgeCount('lint', r)).toBe(1);
    expect(lensBadgeCount('lint', result(fidelity('lossless'), validation('valid'), null))).toBe(0);
  });

  it('is 0 for every lens before a result exists', () => {
    expect(lensBadgeCount('fidelity', null)).toBe(0);
    expect(lensBadgeCount('validation', null)).toBe(0);
    expect(lensBadgeCount('lint', null)).toBe(0);
  });
});

describe('lintSeverityCounts', () => {
  it('tallies per severity, zero-filled', () => {
    expect(
      lintSeverityCounts([
        { severity: 'error', rule: 'a', message: 'm' },
        { severity: 'error', rule: 'b', message: 'm' },
        { severity: 'warning', rule: 'c', message: 'm' },
      ]),
    ).toEqual({ error: 2, warning: 1, info: 0 });
  });

  it('is all-zero for no findings', () => {
    expect(lintSeverityCounts([])).toEqual({ error: 0, warning: 0, info: 0 });
  });
});

describe('emittedLintLensState (MFX-42.3)', () => {
  it('is not_applicable when no pack is registered (or no report at all)', () => {
    expect(emittedLintLensState(null)).toBe('not_applicable');
    expect(emittedLintLensState({ applicable: false, findings: [] })).toBe('not_applicable');
    // Applicability wins even if stray findings are present.
    expect(
      emittedLintLensState({ applicable: false, findings: [{ severity: 'info', rule: 'r', message: 'm' }] }),
    ).toBe('not_applicable');
  });

  it('is clean when a pack ran with zero findings', () => {
    expect(emittedLintLensState({ applicable: true, findings: [] })).toBe('clean');
  });

  it('is findings when a pack ran with one or more findings', () => {
    expect(
      emittedLintLensState({ applicable: true, findings: [{ severity: 'warning', rule: 'r', message: 'm' }] }),
    ).toBe('findings');
  });
});

describe('groupLintFindingsBySeverity (MFX-42.3)', () => {
  it('orders groups error → warning → info and drops empty severities', () => {
    const groups = groupLintFindingsBySeverity([
      { severity: 'info', rule: 'i', message: 'm' },
      { severity: 'error', rule: 'e', message: 'm' },
      { severity: 'warning', rule: 'w', message: 'm' },
    ]);
    expect(groups.map((g) => g.severity)).toEqual(['error', 'warning', 'info']);
    // A severity with no findings produces no group.
    const noInfo = groupLintFindingsBySeverity([{ severity: 'error', rule: 'e', message: 'm' }]);
    expect(noInfo.map((g) => g.severity)).toEqual(['error']);
  });

  it('preserves the server order within a severity group', () => {
    const [group] = groupLintFindingsBySeverity([
      { severity: 'warning', rule: 'first', message: 'm' },
      { severity: 'warning', rule: 'second', message: 'm' },
    ]);
    expect(group.findings.map((f) => f.rule)).toEqual(['first', 'second']);
  });

  it('is empty for no findings', () => {
    expect(groupLintFindingsBySeverity([])).toEqual([]);
  });
});

describe('emittedLintScore (MFX-42.3)', () => {
  it('returns the score and letter grade when the pack computes a numeric score', () => {
    expect(emittedLintScore({ applicable: true, score: 88, grade: 'B', findings: [] })).toEqual({
      score: 88,
      grade: 'B',
    });
    // A zero score is still a score (not treated as absent).
    expect(emittedLintScore({ applicable: true, score: 0, grade: 'F', findings: [] })).toEqual({
      score: 0,
      grade: 'F',
    });
  });

  it('falls back to a dash grade when the pack supplies a score but no grade', () => {
    expect(emittedLintScore({ applicable: true, score: 70, grade: null, findings: [] })).toEqual({
      score: 70,
      grade: '–',
    });
    expect(emittedLintScore({ applicable: true, score: 70, grade: '  ', findings: [] })?.grade).toBe('–');
  });

  it('is null when there is no numeric score (or no report)', () => {
    expect(emittedLintScore(null)).toBeNull();
    expect(emittedLintScore({ applicable: true, score: null, grade: 'B', findings: [] })).toBeNull();
    expect(emittedLintScore({ applicable: true, findings: [] })).toBeNull();
  });
});

describe('lintRulesTriggered (MFX-42.3)', () => {
  it('counts distinct rule ids', () => {
    expect(
      lintRulesTriggered([
        { severity: 'error', rule: 'a', message: 'm' },
        { severity: 'warning', rule: 'a', message: 'm' },
        { severity: 'info', rule: 'b', message: 'm' },
      ]),
    ).toBe(2);
  });

  it('is 0 for no findings', () => {
    expect(lintRulesTriggered([])).toBe(0);
  });
});

describe('verifyGatePasses', () => {
  it('never passes before a verdict exists', () => {
    expect(verifyGatePasses(null, false)).toBe(false);
    expect(verifyGatePasses(null, true)).toBe(false);
  });

  it('blocks invalid regardless of acknowledgement', () => {
    expect(verifyGatePasses('invalid', false)).toBe(false);
    expect(verifyGatePasses('invalid', true)).toBe(false);
  });

  it('passes lossy only once acknowledged', () => {
    expect(verifyGatePasses('lossy', false)).toBe(false);
    expect(verifyGatePasses('lossy', true)).toBe(true);
  });

  it('passes severe only once acknowledged (the typed acknowledgement) — MFX-42.4', () => {
    expect(verifyGatePasses('severe', false)).toBe(false);
    expect(verifyGatePasses('severe', true)).toBe(true);
  });

  it('always passes clean', () => {
    expect(verifyGatePasses('clean', false)).toBe(true);
  });
});

describe('validationLensState (MFX-42.2)', () => {
  it('maps each verdict to its lens state, renaming skipped to unavailable', () => {
    expect(validationLensState(validation('valid'))).toBe('valid');
    expect(validationLensState(validation('invalid'))).toBe('invalid');
    expect(validationLensState(validation('skipped'))).toBe('unavailable');
    expect(validationLensState(validation('not_applicable'))).toBe('not_applicable');
  });
});

describe('validationLensTone (MFX-42.2)', () => {
  it('tones a missing toolchain as a warning, distinct from a clean pass', () => {
    // The whole point of 42.2: unavailable is a warning, never silent success.
    expect(validationLensTone('unavailable')).toBe('warn');
    expect(validationLensTone('valid')).toBe('ok');
    expect(validationLensTone('invalid')).toBe('invalid');
    expect(validationLensTone('not_applicable')).toBe('neutral');
  });

  it('gives clean and toolchain-unavailable different tones', () => {
    expect(validationLensTone('valid')).not.toBe(validationLensTone('unavailable'));
  });
});

describe('validatorToolLabel (MFX-42.2)', () => {
  it('returns the trimmed validator identity when present', () => {
    expect(validatorToolLabel(validation('invalid', { tool: 'buf build' }))).toBe('buf build');
    expect(validatorToolLabel(validation('skipped', { tool: '  xmlschema  ' }))).toBe('xmlschema');
  });

  it('is null when the report names no tool (null, undefined, or blank)', () => {
    expect(validatorToolLabel(validation('not_applicable', { tool: null }))).toBeNull();
    expect(validatorToolLabel(validation('valid', { tool: undefined }))).toBeNull();
    expect(validatorToolLabel(validation('valid', { tool: '   ' }))).toBeNull();
  });
});
