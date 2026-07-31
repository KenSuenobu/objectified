/**
 * Quality badge for a discovered spec in the Repository detail Files tab (REPO-2.8, #2769).
 *
 * The badge is the only place the score is surfaced, so these cover the three states an
 * operator can hit — scored, deliberately not scored, and not scored yet — plus the promise
 * that the score is presented as information rather than as a gate.
 */

import { repositoryFileQualityBadge } from '@/app/utils/repository-file-quality';
import { getNumericScoreTier } from '@/app/utils/numeric-score-tier';

describe('repositoryFileQualityBadge', () => {
  it('renders the score for a scored spec', () => {
    const badge = repositoryFileQualityBadge({
      quality_score: 87,
      quality_grade: 'B',
      quality_status: 'scored',
    });

    expect(badge.label).toBe('87');
    expect(badge.title).toContain('87/100');
    expect(badge.title).toContain('(B)');
    expect(badge.tier).not.toBeNull();
  });

  it('colours the badge from the shared 0–100 tier scale', () => {
    for (const score of [12, 55, 78, 96]) {
      const badge = repositoryFileQualityBadge({ quality_score: score });
      expect(badge.className).toContain(getNumericScoreTier(score).textClass);
      expect(badge.tier?.band).toBe(getNumericScoreTier(score).band);
    }
  });

  it('says the score is informational, never a gate', () => {
    const badge = repositoryFileQualityBadge({ quality_score: 40 });
    expect(badge.title).toMatch(/does not gate/i);
  });

  it('renders an em dash and explains why when a file was deliberately skipped', () => {
    const badge = repositoryFileQualityBadge({
      quality_status: 'skipped',
      quality_reason: 'unclassified',
    });

    expect(badge.label).toBe('—');
    expect(badge.title).toMatch(/classified spec/i);
    expect(badge.tier).toBeNull();
  });

  it('explains each machine reason the API can return', () => {
    const reasons = [
      'no-adapter',
      'adapter-unavailable',
      'empty-document',
      'too-large',
      'fetch-failed',
      'provider-unsupported',
      'no-token',
      'parse-failed',
      'normalize-failed',
      'lint-failed',
      'unscored',
    ];

    for (const reason of reasons) {
      const badge = repositoryFileQualityBadge({ quality_status: 'skipped', quality_reason: reason });
      // A recognised reason is explained in prose, not echoed back as a slug.
      expect(badge.title).not.toContain(reason);
      expect(badge.title.length).toBeGreaterThan(reason.length);
    }
  });

  it('falls back to the raw reason for a reason it does not know yet', () => {
    const badge = repositoryFileQualityBadge({
      quality_status: 'error',
      quality_reason: 'some-future-reason',
    });

    expect(badge.title).toContain('some-future-reason');
  });

  it('treats a row with no attempt as pending, not as a failure', () => {
    const badge = repositoryFileQualityBadge({});

    expect(badge.label).toBe('—');
    expect(badge.title).toMatch(/not scored yet/i);
    expect(badge.tier).toBeNull();
  });

  it('ignores a null or non-finite score', () => {
    for (const score of [null, undefined, Number.NaN]) {
      const badge = repositoryFileQualityBadge({ quality_score: score as number | null });
      expect(badge.label).toBe('—');
      expect(badge.tier).toBeNull();
    }
  });

  it('renders the score band boundaries without decimals', () => {
    expect(repositoryFileQualityBadge({ quality_score: 0 }).label).toBe('0');
    expect(repositoryFileQualityBadge({ quality_score: 100 }).label).toBe('100');
  });
});
