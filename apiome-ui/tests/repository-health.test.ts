/**
 * Repository health badge — client-side contract (REPO-6.5, #2798).
 *
 * The level itself is the API's verdict and is rendered verbatim; what this module owns is
 * parsing that payload defensively, naming the levels, and composing the tooltip copy. These
 * tests pin all three, including the two shapes that must not blow up a repositories page:
 * an older payload with no `health` key at all, and a malformed one.
 */

import {
  type RepositoryHealth,
  parseRepositoryHealth,
  repositoryHealthAriaLabel,
  repositoryHealthLabel,
  repositoryHealthRank,
  repositoryHealthTooltipLines,
} from '../src/app/components/ade/dashboard/repositories/repositoryHealth';

function apiHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    level: 'healthy',
    score: 100,
    window_days: 30,
    scans_attempted: 12,
    scans_succeeded: 12,
    scan_success_rate: 1,
    parse_error_count: 0,
    primary_factor: null,
    factors: [],
    ...overrides,
  };
}

const SCAN_FACTOR = {
  code: 'scan-failing',
  level: 'error',
  summary: 'Scanning is failing. 6 of 10 scans failed in the last 30 days (40% succeeded).',
  observed_at: '2026-07-20T10:00:00+00:00',
};

const PARSE_FACTOR = {
  code: 'parse-errors',
  level: 'warnings',
  summary: '2 discovered specs on the default branch could not be parsed or scored.',
  observed_at: '2026-07-29T10:00:00+00:00',
};

function parsed(overrides: Record<string, unknown> = {}): RepositoryHealth {
  const health = parseRepositoryHealth(apiHealth(overrides));
  if (!health) throw new Error('expected the fixture to parse');
  return health;
}

describe('parseRepositoryHealth', () => {
  it('parses a healthy payload', () => {
    const health = parsed();
    expect(health.level).toBe('healthy');
    expect(health.score).toBe(100);
    expect(health.factors).toEqual([]);
    expect(health.primary_factor).toBeNull();
  });

  it('parses factors and the tooltip factor', () => {
    const health = parsed({
      level: 'error',
      primary_factor: PARSE_FACTOR,
      factors: [SCAN_FACTOR, PARSE_FACTOR],
    });
    expect(health.level).toBe('error');
    expect(health.factors.map((f) => f.code)).toEqual(['scan-failing', 'parse-errors']);
    expect(health.primary_factor?.code).toBe('parse-errors');
    expect(health.primary_factor?.observed_at).toBe('2026-07-29T10:00:00+00:00');
  });

  it('returns null when the repository carries no health at all', () => {
    // An older API payload, or a repository whose signals could not be read: the row must
    // render no badge rather than a guessed verdict.
    expect(parseRepositoryHealth(undefined)).toBeNull();
    expect(parseRepositoryHealth(null)).toBeNull();
    expect(parseRepositoryHealth({})).toBeNull();
    expect(parseRepositoryHealth('healthy')).toBeNull();
  });

  it('treats an unrecognised level as healthy rather than throwing', () => {
    expect(parsed({ level: 'catastrophic' }).level).toBe('healthy');
  });

  it('accepts the singular spelling of the warning level', () => {
    expect(parsed({ level: 'warning' }).level).toBe('warnings');
  });

  it('clamps the score into 0-100', () => {
    expect(parsed({ score: 400 }).score).toBe(100);
    expect(parsed({ score: -9 }).score).toBe(0);
    expect(parsed({ score: 'not a number' }).score).toBe(0);
  });

  it('never reports a negative count or a zero-day window', () => {
    const health = parsed({ scans_attempted: -4, parse_error_count: -1, window_days: 0 });
    expect(health.scans_attempted).toBe(0);
    expect(health.parse_error_count).toBe(0);
    expect(health.window_days).toBe(1);
  });

  it('reads a missing success rate as unknown, not as zero', () => {
    expect(parsed({ scan_success_rate: null }).scan_success_rate).toBeNull();
  });

  it('drops factors with no summary to render', () => {
    const health = parsed({
      level: 'warnings',
      factors: [PARSE_FACTOR, { code: 'mystery', level: 'warnings' }, null, 'nonsense'],
    });
    expect(health.factors.map((f) => f.code)).toEqual(['parse-errors']);
  });

  it('falls back to the first factor when the API sent no primary one', () => {
    const health = parsed({ level: 'error', primary_factor: null, factors: [SCAN_FACTOR] });
    expect(health.primary_factor?.code).toBe('scan-failing');
  });

  it('reads a blank observation timestamp as absent', () => {
    const health = parsed({
      level: 'warnings',
      factors: [{ ...PARSE_FACTOR, observed_at: '   ' }],
    });
    expect(health.factors[0].observed_at).toBeNull();
  });
});

describe('level presentation', () => {
  it('names each level', () => {
    expect(repositoryHealthLabel('healthy')).toBe('Healthy');
    expect(repositoryHealthLabel('warnings')).toBe('Warnings');
    expect(repositoryHealthLabel('error')).toBe('Error');
  });

  it('ranks the levels by severity', () => {
    expect(repositoryHealthRank('healthy')).toBeLessThan(repositoryHealthRank('warnings'));
    expect(repositoryHealthRank('warnings')).toBeLessThan(repositoryHealthRank('error'));
  });

  // The palette used to live here as three `bg-emerald-100 … dark:…` triples. HIVE-7.3
  // (#5320) moved it to `repositoriesModel`'s `REPOSITORY_HEALTH_TONE`, which resolves
  // through the shared status vocabulary — see `tests/repositories-model.test.ts`.
});

describe('repositoryHealthTooltipLines', () => {
  it('leads with the most recent contributing factor', () => {
    const lines = repositoryHealthTooltipLines(
      parsed({
        level: 'error',
        primary_factor: PARSE_FACTOR,
        factors: [SCAN_FACTOR, PARSE_FACTOR],
        scans_attempted: 10,
        scans_succeeded: 4,
        scan_success_rate: 0.4,
      })
    );
    expect(lines[0]).toBe(PARSE_FACTOR.summary);
  });

  it('lists the other contributing factors after it, without repeating the first', () => {
    const lines = repositoryHealthTooltipLines(
      parsed({
        level: 'error',
        primary_factor: PARSE_FACTOR,
        factors: [SCAN_FACTOR, PARSE_FACTOR],
      })
    );
    expect(lines).toContain(SCAN_FACTOR.summary);
    expect(lines.filter((l) => l === PARSE_FACTOR.summary)).toHaveLength(1);
  });

  it('closes with the scan rate that puts the verdict in context', () => {
    const lines = repositoryHealthTooltipLines(
      parsed({
        level: 'error',
        primary_factor: SCAN_FACTOR,
        factors: [SCAN_FACTOR],
        scans_attempted: 10,
        scans_succeeded: 4,
        scan_success_rate: 0.4,
      })
    );
    expect(lines[lines.length - 1]).toBe(
      '4 of 10 scans succeeded in the last 30 days (40%).'
    );
  });

  it('says so plainly when nothing has been scanned yet', () => {
    const lines = repositoryHealthTooltipLines(
      parsed({ scans_attempted: 0, scans_succeeded: 0, scan_success_rate: null })
    );
    expect(lines[lines.length - 1]).toBe('No scans finished in the last 30 days.');
  });

  it('uses the singular for a single scan', () => {
    const lines = repositoryHealthTooltipLines(
      parsed({ scans_attempted: 1, scans_succeeded: 1, scan_success_rate: 1 })
    );
    expect(lines[lines.length - 1]).toBe('1 of 1 scan succeeded in the last 30 days (100%).');
  });

  it('explains a healthy repository rather than showing an empty tooltip', () => {
    const lines = repositoryHealthTooltipLines(parsed());
    expect(lines[0]).toBe('No scan failures, spec parse errors or credential problems.');
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe('repositoryHealthAriaLabel', () => {
  it('names the level and the reason behind it', () => {
    const label = repositoryHealthAriaLabel(
      parsed({ level: 'error', primary_factor: SCAN_FACTOR, factors: [SCAN_FACTOR] })
    );
    expect(label).toContain('Repository health: error.');
    expect(label).toContain(SCAN_FACTOR.summary);
  });

  it('names the level alone when there is no reason to give', () => {
    expect(repositoryHealthAriaLabel(parsed())).toBe('Repository health: healthy.');
  });
});
