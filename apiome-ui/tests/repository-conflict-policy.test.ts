/**
 * Conflict-policy presentation rules (RAR-4.5, #3531).
 *
 * DOM-free fixtures over `repositoryConflictPolicy.ts`: the `file -> repository -> default`
 * precedence the panel mirrors from the server, the defensive payload parsing (a malformed
 * response must render the safe default rather than throw inside a render), and the summary
 * sentence that has to keep the override count visible.
 */

import { describe, test, expect } from '@jest/globals';
import {
  CONFLICT_POLICIES,
  DEFAULT_CONFLICT_POLICY,
  POLICY_COPY,
  asConflictPolicy,
  conflictPolicySummary,
  effectivePolicyFor,
  parseConflictPolicyResponse,
  type ConflictPolicyOverride,
} from '@/app/components/ade/dashboard/repositories/repositoryConflictPolicy';

const override = (path: string, policy: string, branch = 'main'): ConflictPolicyOverride => ({
  branch,
  path,
  policy: asConflictPolicy(policy),
  createdBy: null,
  createdAt: null,
  updatedAt: null,
});

describe('policy tokens', () => {
  test('the token list matches the API contract exactly', () => {
    expect([...CONFLICT_POLICIES].sort()).toEqual(
      ['hold-for-review', 'new-branch', 'overwrite'].sort()
    );
  });

  test('the default remains hold-for-review', () => {
    expect(DEFAULT_CONFLICT_POLICY).toBe('hold-for-review');
  });

  test('every policy has copy, and overwrite is the only warning tone', () => {
    for (const policy of CONFLICT_POLICIES) {
      expect(POLICY_COPY[policy].label.length).toBeGreaterThan(0);
      expect(POLICY_COPY[policy].detail.length).toBeGreaterThan(0);
    }
    expect(POLICY_COPY.overwrite.tone).toBe('warn');
    expect(POLICY_COPY['hold-for-review'].tone).not.toBe('warn');
    expect(POLICY_COPY['new-branch'].tone).not.toBe('warn');
  });

  test('an unknown token narrows to the safe default', () => {
    expect(asConflictPolicy('yolo')).toBe('hold-for-review');
    expect(asConflictPolicy(undefined)).toBe('hold-for-review');
    expect(asConflictPolicy(7)).toBe('hold-for-review');
    expect(asConflictPolicy('yolo', 'overwrite')).toBe('overwrite');
  });
});

describe('effectivePolicyFor', () => {
  const overrides = [override('specs/petstore.yaml', 'overwrite')];

  test('a matching override wins over the repository policy', () => {
    expect(effectivePolicyFor('specs/petstore.yaml', 'main', 'hold-for-review', overrides)).toEqual({
      policy: 'overwrite',
      source: 'file',
    });
  });

  test('a file with no override inherits the repository policy', () => {
    expect(effectivePolicyFor('specs/other.yaml', 'main', 'new-branch', overrides)).toEqual({
      policy: 'new-branch',
      source: 'repository',
    });
  });

  test('an override on another branch does not apply', () => {
    expect(effectivePolicyFor('specs/petstore.yaml', 'develop', 'hold-for-review', overrides)).toEqual(
      { policy: 'hold-for-review', source: 'repository' }
    );
  });
});

describe('parseConflictPolicyResponse', () => {
  test('a well-formed payload round-trips', () => {
    const parsed = parseConflictPolicyResponse({
      success: true,
      repositoryId: 'repo-1',
      policy: 'overwrite',
      defaultPolicy: 'hold-for-review',
      availablePolicies: ['overwrite', 'hold-for-review', 'new-branch'],
      overrides: [
        {
          branch: 'main',
          path: 'specs/petstore.yaml',
          policy: 'new-branch',
          createdBy: 'user-1',
          createdAt: '2026-08-01T10:00:00Z',
          updatedAt: null,
        },
      ],
    });
    expect(parsed.policy).toBe('overwrite');
    expect(parsed.repositoryId).toBe('repo-1');
    expect(parsed.overrides).toHaveLength(1);
    expect(parsed.overrides[0]).toEqual({
      branch: 'main',
      path: 'specs/petstore.yaml',
      policy: 'new-branch',
      createdBy: 'user-1',
      createdAt: '2026-08-01T10:00:00Z',
      updatedAt: null,
    });
  });

  test('a malformed payload degrades to the safe default rather than throwing', () => {
    const parsed = parseConflictPolicyResponse({ policy: 42, overrides: 'nope' });
    expect(parsed.policy).toBe('hold-for-review');
    expect(parsed.overrides).toEqual([]);
    expect(parsed.availablePolicies).toEqual([...CONFLICT_POLICIES]);
  });

  test('an empty body parses without throwing', () => {
    expect(parseConflictPolicyResponse(null).policy).toBe('hold-for-review');
  });

  test('a policy token from a newer server narrows instead of leaking through', () => {
    const parsed = parseConflictPolicyResponse({
      policy: 'quantum-merge',
      overrides: [{ branch: 'main', path: 'a.yaml', policy: 'quantum-merge' }],
    });
    expect(parsed.policy).toBe('hold-for-review');
    expect(parsed.overrides[0].policy).toBe('hold-for-review');
  });
});

describe('conflictPolicySummary', () => {
  test('no exceptions reads as a plain statement', () => {
    expect(conflictPolicySummary('overwrite', 0)).toBe(
      'Overwrite applies to every file in this repository.'
    );
  });

  test('one exception is singular', () => {
    expect(conflictPolicySummary('overwrite', 1)).toContain('except 1 file has its own policy');
  });

  test('several exceptions are counted, never hidden', () => {
    expect(conflictPolicySummary('hold-for-review', 4)).toContain(
      'except 4 files have their own policy'
    );
  });
});
