/**
 * Shared client helpers for the Governance → Style Guides surfaces (GOV-2.1 / GOV-2.2).
 *
 * The list screen (`StyleGuidesClient`) and the guide editor (`GuideEditorClient`) both talk
 * to the `/api/style-guides` proxy, which forwards to the REST layer's tenant-scoped
 * `/v1/style-guides/{slug}/...` endpoints. Types mirror the REST models' camelCase
 * serialization aliases.
 */

export interface ProjectAssignment {
  projectId: string;
  projectName: string;
}

/** One tenant style guide with its list-view rollups (GOV-2.1). */
export interface StyleGuide {
  id: string;
  name: string;
  description: string | null;
  source: 'builtin' | 'custom';
  isDefault: boolean;
  ruleCount: number;
  enabledRuleCount: number;
  tenantAssigned: boolean;
  projectAssignments: ProjectAssignment[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface StyleGuideList {
  guides: StyleGuide[];
  count: number;
}

/** Severity a guide can assign a rule — matches the linter's Severity type. */
export type RuleSeverity = 'error' | 'warning' | 'info';

/** One built-in rule as the guide editor sees it: registry facts + guide state (GOV-2.2). */
export interface GuideRule {
  ruleId: string;
  pack: string;
  category: string;
  defaultSeverity: RuleSeverity;
  rationale: string;
  docsAnchor: string;
  enabled: boolean;
  severity: RuleSeverity;
}

/** The guide's full rule catalog view — `GET/PUT /api/style-guides/{id}/rules` (GOV-2.2). */
export interface GuideRulesView {
  guideId: string;
  guideName: string;
  source: 'builtin' | 'custom';
  rules: GuideRule[];
  count: number;
  enabledCount: number;
  docsPage: string;
}

/** Custom-rules YAML document — `GET/PUT /api/style-guides/{id}/custom-rules` (GOV-2.3). */
export interface GuideCustomRulesView {
  guideId: string;
  guideName: string;
  source: 'builtin' | 'custom';
  yaml: string;
  ruleCount: number;
}

/** One violation from the custom-rules dry-run preview (GOV-2.3). */
export interface CustomRulePreviewFinding {
  id: string;
  path: string;
  category: string;
  rule: string;
  severity: RuleSeverity;
  message: string;
}

/** Dry-run preview response — `POST .../custom-rules/preview` (GOV-2.3). */
export interface CustomRulesPreviewResult {
  projectId: string;
  versionRecordId: string;
  versionId: string;
  count: number;
  findings: CustomRulePreviewFinding[];
  ruleErrors: Record<string, string>;
}

/** Minimal project / version pickers for the test-against pane. */
export interface ProjectOption {
  id: string;
  name: string;
}

export interface VersionOption {
  id: string;
  versionId: string;
  label: string;
}

/** CI outcome toggles on a policy pack / draft guide settings (CLX-1.3, #4850). */
export interface GuideCiOutcomes {
  failOnUnwaivedErrors: boolean;
  failOnRequiredCoverage: boolean;
  failOnAxisGates: boolean;
}

/**
 * Breaking-publish guardrail level (CTG-3.4, #4478).
 *
 * `off` never surfaces; `warn` (default) warns in the publish dialog; `block` refuses the
 * publish until the major is bumped or the publish is forced with a reason.
 */
export type BreakingPublishPolicyLevel = 'off' | 'warn' | 'block';

/** Draft policy gate settings — `GET/PUT /api/style-guides/{id}/policy` (CLX-1.3, #4850). */
export interface GuidePolicySettings {
  guideId: string;
  axisGates: Record<string, { minGrade?: string; minScore?: number }>;
  requiredCoverage: string[];
  ciOutcomes: GuideCiOutcomes;
  /** Breaking-publish guardrail level (CTG-3.4, #4478). */
  breakingPublishPolicy: BreakingPublishPolicyLevel;
}

/** One immutable policy pack version (CLX-1.3, #4850). */
export interface GuidePolicyVersion {
  id: string;
  guideId: string;
  versionNumber: number;
  contentFingerprint: string;
  axisGates: Record<string, unknown>;
  requiredCoverage: string[];
  ciOutcomes: GuideCiOutcomes;
  actorLabel: string | null;
  createdAt: string | null;
}

/** List response — `GET /api/style-guides/{id}/policy-versions` (CLX-1.3, #4850). */
export interface GuidePolicyVersionList {
  versions: GuidePolicyVersion[];
  count: number;
}

/** Default CI outcome toggles when the API omits partial keys. */
export const DEFAULT_GUIDE_CI_OUTCOMES: GuideCiOutcomes = {
  failOnUnwaivedErrors: true,
  failOnRequiredCoverage: true,
  failOnAxisGates: true,
};

/** Required-coverage axes offered in the policy editor (CLX-1.2 quality axis). */
export const POLICY_COVERAGE_AXES = ['quality'] as const;

/** Letter grades for axis gate floors (best → worst). */
export const POLICY_GRADE_OPTIONS = ['A', 'B', 'C', 'D', 'F'] as const;

/** What a guide gets without configuring the guardrail (CTG-3.4, #4478). */
export const DEFAULT_BREAKING_PUBLISH_POLICY: BreakingPublishPolicyLevel = 'warn';

/** Breaking-publish guardrail levels, with the copy the policy editor shows (CTG-3.4). */
export const BREAKING_PUBLISH_POLICY_OPTIONS: ReadonlyArray<{
  value: BreakingPublishPolicyLevel;
  label: string;
  description: string;
}> = [
  {
    value: 'off',
    label: 'Off',
    description: 'Never check for breaking changes at publish time.',
  },
  {
    value: 'warn',
    label: 'Warn (default)',
    description:
      'Warn when a publish is breaking without a major-version bump; publishing proceeds.',
  },
  {
    value: 'block',
    label: 'Block',
    description:
      'Refuse the publish until the major version is bumped, or it is force-published with a reason.',
  },
];

/** Truncate a content fingerprint for list display. */
export function truncatePolicyFingerprint(fingerprint: string, length = 12): string {
  if (fingerprint.length <= length) return fingerprint;
  return `${fingerprint.slice(0, length)}…`;
}

/** The caller's permissions from `/api/access/permissions/me` (admin-gates mutations). */
export interface MyPermissions {
  is_admin: boolean;
  permissions: string[];
}

/**
 * Call the style-guides proxy (`/api/style-guides/...`).
 *
 * The proxy wraps REST responses as `{success, data, error}`; FastAPI error details can be
 * a string or a `{code, message}` object (read-only / name-conflict), so both are
 * normalized into the thrown Error's message.
 */
export async function styleGuidesApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`/api/style-guides${path ? `/${path}` : ''}`, init);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!json.success) {
    const err = json.error;
    const message =
      typeof err === 'object' && err !== null
        ? (err as { message?: string }).message || 'Request failed'
        : err || 'Request failed';
    throw new Error(message);
  }
  return json.data as T;
}

/** Like {@link styleGuidesApi} but surfaces HTTP 422 validation `detail` for inline YAML markers. */
export async function styleGuidesApiWithValidation<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const res = await fetch(`/api/style-guides${path ? `/${path}` : ''}`, init);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!json.success) {
    const err = json.error;
    if (typeof err === 'object' && err !== null && 'message' in err) {
      const e = new Error((err as { message?: string }).message || 'Request failed');
      (e as Error & { detail: unknown }).detail = err;
      throw e;
    }
    const message =
      typeof err === 'object' && err !== null
        ? (err as { message?: string }).message || 'Request failed'
        : err || 'Request failed';
    throw new Error(message);
  }
  return json.data as T;
}

/** Fetch projects for the custom-rules "Test against…" picker. */
export async function fetchProjectOptions(): Promise<ProjectOption[]> {
  const res = await fetch('/api/projects');
  const json = await res.json();
  if (!json.success || !Array.isArray(json.projects)) return [];
  return (json.projects as { id: string; name: string }[]).map((p) => ({
    id: p.id,
    name: p.name,
  }));
}

/** Fetch versions for one project (revision record id + version label). */
export async function fetchVersionOptions(projectId: string): Promise<VersionOption[]> {
  const res = await fetch(`/api/versions?projectId=${encodeURIComponent(projectId)}`);
  const json = await res.json();
  if (!json.success || !Array.isArray(json.versions)) return [];
  return (json.versions as { id: string; version_id: string; name?: string }[]).map((v) => ({
    id: v.id,
    versionId: v.version_id,
    label: v.name ? `${v.version_id} — ${v.name}` : v.version_id,
  }));
}

/** Fetch the caller's permissions, degrading to `null` (read-only UI) on any failure. */
export async function fetchMyPermissions(): Promise<MyPermissions | null> {
  return fetch('/api/access/permissions/me')
    .then((r) => r.json())
    .then((j) => (j.success ? (j.data as MyPermissions) : null))
    .catch(() => null);
}
