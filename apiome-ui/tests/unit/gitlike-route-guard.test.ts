import { isGitlikePath } from '@lib/gitlike-route-guard';

describe('isGitlikePath (FEATURE_GITLIKE=false guard)', () => {
  describe('always-blocked git-like routes (any method)', () => {
    const cases: Array<[string, string]> = [
      ['/api/versions/fork', 'POST'],
      ['/api/versions/abc-123/freeze-schema', 'POST'],
      ['/api/versions/abc-123/draft-lock', 'POST'],
      ['/api/versions/abc-123/draft-lock', 'GET'],
      ['/api/versions/abc-123/change-report', 'GET'],
      ['/api/versions/abc-123/change-report/regenerate', 'POST'],
      ['/api/versions/abc-123/change-report/publish-preview', 'POST'],
      ['/api/projects/proj-1/version-branches', 'GET'],
      ['/api/projects/proj-1/version-branches/branch-2', 'PUT'],
      ['/api/projects/proj-1/version-branches/merge', 'POST'],
      ['/api/projects/proj-1/version-branches/merge-preview', 'POST'],
      ['/api/projects/proj-1/version-branches/rollback', 'POST'],
      ['/api/projects/proj-1/version-branches/rollback-preview', 'POST'],
      ['/api/projects/proj-1/version-branches/from-revision', 'POST'],
      ['/api/projects/proj-1/version-branches/branch-2/divergence', 'GET'],
      ['/api/projects/proj-1/version-tags', 'GET'],
      ['/api/projects/proj-1/version-tags/tag-1', 'DELETE'],
      ['/api/projects/proj-1/compatibility', 'GET'],
      ['/api/projects/proj-1/change-report-template-default', 'GET'],
      ['/api/projects/proj-1/versions/ver-1/revision-lock', 'POST'],
      ['/api/change-report-template-versions', 'GET'],
      ['/api/change-report-template-default', 'GET'],
    ];

    it.each(cases)('blocks %s %s', (path, method) => {
      expect(isGitlikePath(path, method)).toBe(true);
    });
  });

  describe('method-aware blocks', () => {
    it('blocks POST /api/versions (commit)', () => {
      expect(isGitlikePath('/api/versions', 'POST')).toBe(true);
      expect(isGitlikePath('/api/versions/', 'POST')).toBe(true);
    });

    it('allows GET /api/versions (list for selection)', () => {
      expect(isGitlikePath('/api/versions', 'GET')).toBe(false);
    });

    it('blocks DELETE /api/versions/[id] (destructive)', () => {
      expect(isGitlikePath('/api/versions/abc-123', 'DELETE')).toBe(true);
      expect(isGitlikePath('/api/versions/abc-123/', 'DELETE')).toBe(true);
    });

    it('allows GET /api/versions/[id] (read)', () => {
      expect(isGitlikePath('/api/versions/abc-123', 'GET')).toBe(false);
    });

    it('allows PUT /api/versions/[id] (edit revision metadata)', () => {
      expect(isGitlikePath('/api/versions/abc-123', 'PUT')).toBe(false);
    });

    it('allows publish/unpublish (release-management, not git push)', () => {
      expect(isGitlikePath('/api/versions/abc-123/publish', 'POST')).toBe(false);
      expect(isGitlikePath('/api/versions/abc-123/unpublish', 'POST')).toBe(false);
    });
  });

  describe('always-allowed routes', () => {
    const cases: Array<[string, string]> = [
      ['/api/versions/sunset-timeline', 'GET'],
      ['/api/versions/sunset-timeline/something', 'GET'],
      ['/api/auth/get-session', 'GET'],
      ['/api/projects', 'GET'],
      ['/api/projects/proj-1', 'GET'],
      ['/api/projects/proj-1', 'PUT'],
      ['/api/classes', 'GET'],
      ['/api/classes/class-1', 'PUT'],
      ['/api/classes/class-1', 'DELETE'],
      ['/api/properties/proj-1', 'GET'],
      ['/api/paths/ver-1', 'GET'],
      ['/api/primitives', 'GET'],
      ['/api/database/snapshot', 'GET'],
      ['/api/database/snapshot/insert', 'POST'],
      ['/api/sso/github/repos', 'GET'],
      ['/api/migration-plans', 'GET'],
      ['/api/migration-plans/evaluate', 'POST'],
      ['/api/admin/stats', 'GET'],
      ['/api/ollama/models', 'GET'],
    ];

    it.each(cases)('allows %s %s', (path, method) => {
      expect(isGitlikePath(path, method)).toBe(false);
    });
  });
});
