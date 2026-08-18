'use client';

import * as React from 'react';
import { History, ShieldCheck } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from '@/app/components/ui/Card';
import { Checkbox } from '@/app/components/ui/Checkbox';
import { Label } from '@/app/components/ui/Label';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { Spinner } from '@/app/components/ui/Spinner';
import { Switch } from '@/app/components/ui/Switch';
import { buildGovernanceDocsHref, POLICY_DOCS_PAGE } from '@/app/utils/lint-axis-ui';

import {
  BREAKING_PUBLISH_POLICY_OPTIONS,
  POLICY_COVERAGE_AXES,
  POLICY_GRADE_OPTIONS,
  truncatePolicyFingerprint,
  type BreakingPublishPolicyLevel,
  type GuideCiOutcomes,
} from '@/app/ade/dashboard/style-guides/api';

import { formatPolicyInstant } from '../styleGuidesModel';
import type { GuidePolicyState } from './guideEditorState';

/**
 * The policy tab — HIVE-5.7 (#5310).
 *
 * Authority: `docs/mockups/govern/style-guide-detail.html`, its third panel.
 *
 * The gates applied when lint evidence is judged against this guide: the quality floor, the
 * axes that must carry evidence at all, what a breaking publish without a major bump does,
 * and the three outcomes `GET …/lint/gate` reports as failed. Saving snapshots an immutable
 * policy version, which is why the history sits under the form rather than behind a link —
 * a gate whose changes cannot be seen is not governance.
 *
 * ### What HIVE-5.7 changed
 *
 * The fields, their copy, the save gate and every call are the screen's own (CLX-1.3). What
 * changed is the skin — `Card`s on tokens rather than `border-slate-200` boxes with
 * `bg-indigo-600` buttons and `focus:ring-indigo-500` on every field — plus three things
 * that were missing: each choice now says what it *does* (the three CI switches had bare
 * labels), the wait is a shaped skeleton rather than a spinner, and the draft survives a
 * tab switch because it lives in `useGuidePolicy` on the page.
 */

/** The three CI outcome switches, with the sentence each one is really asking. */
const CI_OUTCOMES: ReadonlyArray<{
  key: keyof GuideCiOutcomes;
  id: string;
  title: string;
  description: string;
}> = [
  {
    key: 'failOnUnwaivedErrors',
    id: 'ci-fail-unwaived',
    title: 'Fail on unwaived errors',
    description:
      'Any open error-severity finding without an active waiver fails the gate.',
  },
  {
    key: 'failOnRequiredCoverage',
    id: 'ci-fail-coverage',
    title: 'Fail on required coverage',
    description: 'Missing evidence for a required axis fails the gate.',
  },
  {
    key: 'failOnAxisGates',
    id: 'ci-fail-axis-gates',
    title: 'Fail on axis gates',
    description: 'An axis scoring below its floor fails the gate.',
  },
];

/** Props for {@link PolicyTab}. */
export interface PolicyTabProps {
  /** The policy, its history and its write, from `useGuidePolicy`. */
  state: GuidePolicyState;
  /** Whether the viewer may save. A member sees every value and no Save. */
  readOnly: boolean;
}

/**
 * The policy form and the version history under it.
 *
 * @param props See {@link PolicyTabProps}.
 * @returns The policy form and the version history under it.
 */
export default function PolicyTab({ state, readOnly }: PolicyTabProps) {
  if (state.loading) {
    return (
      <div className="gd-policy" data-testid="guide-policy-loading">
        <span className="sr-only" role="status">
          Loading the policy…
        </span>
        <Skeleton className="gd-skeleton__block" />
        <Skeleton className="gd-skeleton__block" />
      </div>
    );
  }

  if (!state.draft) {
    return (
      <div className="gd-policy">
        {state.error && <Alert variant="error">{state.error}</Alert>}
        <Card>
          <CardContent>
            <p className="sg-quiet">Policy settings not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const draft = state.draft;
  const disabled = readOnly || state.saving;
  const breaking = BREAKING_PUBLISH_POLICY_OPTIONS.find(
    (option) => option.value === draft.breakingPublishPolicy
  );

  return (
    <div className="gd-policy" data-testid="guide-policy-panel">
      {state.error && (
        <Alert variant="error" onClose={state.clearError}>
          {state.error}
        </Alert>
      )}

      <Card>
        <CardHeader className="gd-card-header">
          <span className="gd-card-header__lead">
            <span className="tnt-icon-tile" data-tone="accent">
              <ShieldCheck aria-hidden />
            </span>
            <span className="gd-card-header__text">
              {/* `h3` takes its type from the unlayered base rules in `globals.css`, which
                  outrank every utility class — so it is not given one here. */}
              <h3 className="gd-card-title">Policy</h3>
              <p className="sg-quiet">
                Gate settings applied when evaluating lint evidence against this guide.
              </p>
            </span>
          </span>
        </CardHeader>

        <CardContent className="gd-policy-body">
          <div className="gd-policy-grid">
            <div className="sg-field">
              <Label htmlFor="quality-min-grade">Quality minimum grade</Label>
              <select
                id="quality-min-grade"
                aria-label="Quality minimum grade"
                className="hive-control sg-select"
                value={draft.axisGates.quality?.minGrade ?? ''}
                disabled={disabled}
                onChange={(event) => state.setQualityMinGrade(event.target.value)}
              >
                <option value="">No floor</option>
                {POLICY_GRADE_OPTIONS.map((grade) => (
                  <option key={grade} value={grade}>
                    {grade}
                  </option>
                ))}
              </select>
              <p className="sg-field__hint">
                Evidence graded below this floor fails the quality gate.
              </p>
            </div>

            <fieldset className="sg-field">
              <legend className="gd-legend">Required coverage</legend>
              <ul className="gd-coverage">
                {POLICY_COVERAGE_AXES.map((axis) => (
                  <li key={axis} className="gd-coverage__item">
                    <Checkbox
                      id={`coverage-${axis}`}
                      aria-label={`Require ${axis} coverage`}
                      checked={draft.requiredCoverage.includes(axis)}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        state.toggleCoverage(axis, checked === true)
                      }
                    />
                    <Label htmlFor={`coverage-${axis}`} className="gd-coverage__label">
                      {axis}
                    </Label>
                  </li>
                ))}
              </ul>
              <p className="sg-field__hint">More axes arrive with the axis-coverage roadmap.</p>
            </fieldset>
          </div>

          <div className="sg-field">
            <Label htmlFor="breaking-publish-policy">Breaking-change publishes</Label>
            <select
              id="breaking-publish-policy"
              aria-label="Breaking-change publish policy"
              className="hive-control sg-select gd-policy-select"
              value={draft.breakingPublishPolicy}
              disabled={disabled}
              onChange={(event) =>
                state.setBreakingPublishPolicy(
                  event.target.value as BreakingPublishPolicyLevel
                )
              }
            >
              {BREAKING_PUBLISH_POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="sg-field__hint">{breaking?.description}</p>
          </div>

          <div>
            <h4 className="sg-section-title">CI outcomes</h4>
            <p className="sg-section-desc">
              What <code className="mono">GET …/lint/gate</code> reports as failed for
              pipelines using this guide.
            </p>
            <ul className="gd-switch-list">
              {CI_OUTCOMES.map((outcome) => (
                <li key={outcome.key} className="gd-switch-row">
                  <span className="gd-switch-row__text">
                    <Label htmlFor={outcome.id} className="gd-switch-row__title">
                      {outcome.title}
                    </Label>
                    <span className="gd-switch-row__desc">{outcome.description}</span>
                  </span>
                  <Switch
                    id={outcome.id}
                    aria-label={outcome.title}
                    checked={draft.ciOutcomes[outcome.key]}
                    disabled={disabled}
                    onCheckedChange={(checked) => state.setCiOutcome(outcome.key, checked)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </CardContent>

        <CardFooter>
          <span className="sg-quiet">Saving creates an immutable policy version.</span>
          {!readOnly && (
            <Button
              disabled={state.saving || !state.dirty}
              onClick={() => void state.save()}
              data-testid="guide-policy-save"
            >
              {state.saving && <Spinner size="sm" aria-hidden />}
              {state.saving ? 'Saving…' : 'Save'}
            </Button>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader className="gd-card-header">
          <span className="gd-card-header__lead">
            <span className="tnt-icon-tile" data-tone="violet">
              <History aria-hidden />
            </span>
            <span className="gd-card-header__text">
              <h3 className="gd-card-title">Policy versions</h3>
              <p className="sg-quiet">
                Immutable snapshots created when policy is saved.{' '}
                <a
                  href={buildGovernanceDocsHref(POLICY_DOCS_PAGE)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sg-inline-link"
                  data-testid="policy-docs-link"
                >
                  Policy documentation
                </a>
              </p>
            </span>
          </span>
        </CardHeader>

        {state.versions.length === 0 ? (
          <CardContent>
            <p className="sg-quiet">No policy versions yet.</p>
          </CardContent>
        ) : (
          <ul className="gd-version-list">
            {state.versions.map((version) => (
              <li key={version.id} className="gd-version-row">
                <Badge variant="outline" mono>
                  v{version.versionNumber}
                </Badge>
                <code className="gd-fingerprint" title={version.contentFingerprint}>
                  {truncatePolicyFingerprint(version.contentFingerprint)}
                </code>
                <span className="gd-version-row__when">
                  {formatPolicyInstant(version.createdAt)}
                </span>
                {version.actorLabel && (
                  <span className="gd-version-row__actor">{version.actorLabel}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
