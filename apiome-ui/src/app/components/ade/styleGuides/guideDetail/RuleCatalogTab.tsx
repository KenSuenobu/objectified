'use client';

import * as React from 'react';
import { ListChecks, PencilLine } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card } from '@/app/components/ui/Card';
import {
  DataTableFilterChip,
  DataTableFoot,
  DataTableSearch,
  DataTableToolbar,
  DataTableToolbarSpacer,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { Switch } from '@/app/components/ui/Switch';

import GuideReadOnlyNotice from './GuideReadOnlyNotice';
import GuideSaveBar from './GuideSaveBar';
import {
  ALL_CATEGORIES,
  EMPTY_RULE_FILTER,
  SEVERITY_OPTIONS,
  catalogFootSentence,
  filterRules,
  groupRulesByCategory,
  isRuleModified,
  modifiedRuleIds,
  ruleCategories,
  unsavedRulesSentence,
  type GuideReadOnlyReason,
  type RuleFilter,
  type RuleSeverity,
} from './guideDetailModel';
import type { RuleCatalogState } from './guideEditorState';

/**
 * The rule catalog tab — HIVE-5.7 (#5310).
 *
 * Authority: `docs/mockups/govern/style-guide-detail.html`, its first panel.
 *
 * ### What changed
 *
 * The rules were a flat list of every rule the registry ships, in one column, with a
 * `border-slate-200` box per category and no way to answer the question a reader actually
 * arrives with: *what have I changed?* Three things fix that, and they are the ticket's
 * scope for this tab:
 *
 *   * **Grouping is a real section.** Each category carries its own "{on} of {total} on",
 *     so the shape of the guide is legible before a single rule is read.
 *   * **A rule states both severities.** The guide's severity is the select; the registry's
 *     is the `default: …` pill beside the id, in the tone of the severity it names. That is
 *     the ticket's second acceptance criterion, and it is what makes "modified" mean
 *     something — the reader can see what it is modified *from*.
 *   * **"Modified only" is a filter.** With a 41-rule catalog and five edits, the edits were
 *     unfindable; the chip carries their count, so it is also the answer to "how many".
 *
 * The tab is presentational: every draft it edits lives in `useRuleCatalog` on the page, so
 * switching tabs cannot throw it away. Its own filter state is local, because a filter is
 * about looking rather than about editing and losing one costs nothing.
 */

/** How many placeholder rows the skeleton draws while the catalog loads. */
const SKELETON_ROWS = 6;

/** Props for {@link RuleCatalogTab}. */
export interface RuleCatalogTabProps {
  /** The catalog's data and writes, from `useRuleCatalog`. */
  state: RuleCatalogState;
  /** Why the guide cannot be edited, or `null`. */
  readOnlyReason: GuideReadOnlyReason;
}

/**
 * The rule catalog.
 *
 * @param props See {@link RuleCatalogTabProps}.
 * @returns The toolbar, the grouped rules and the save bar.
 */
export default function RuleCatalogTab({ state, readOnlyReason }: RuleCatalogTabProps) {
  const [filter, setFilter] = React.useState<RuleFilter>(EMPTY_RULE_FILTER);

  const rules = React.useMemo(() => state.view?.rules ?? [], [state.view]);
  const categories = React.useMemo(() => ruleCategories(rules), [rules]);
  const readOnly = readOnlyReason !== null;
  const locked = readOnly || state.saving;

  const visible = React.useMemo(
    () => filterRules(rules, filter, state.draft, state.baseline),
    [rules, filter, state.draft, state.baseline]
  );
  const groups = React.useMemo(
    () => groupRulesByCategory(visible, state.draft),
    [visible, state.draft]
  );

  // The chip's count is what the chip *would* leave, so it is computed from the whole
  // catalog rather than from what is currently on screen — a count that changed as the
  // search narrowed would be answering a different question each time it was read.
  const modifiedCount = React.useMemo(
    () => modifiedRuleIds(state.draft, state.baseline).length,
    [state.draft, state.baseline]
  );

  if (state.loading) {
    return (
      <Card className="gd-skeleton" data-testid="rule-catalog-loading">
        <span className="sr-only" role="status">
          Loading the rule catalog…
        </span>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} className="gd-skeleton__row" />
        ))}
      </Card>
    );
  }

  return (
    <div className="gd-panel">
      <GuideReadOnlyNotice reason={readOnlyReason} surface="rules" />

      <Card className="gd-catalog">
        <DataTableToolbar>
          <DataTableSearch
            aria-label="Search rules"
            placeholder="Search rules by id, rationale, or category…"
            value={filter.search}
            onChange={(event) => setFilter((prev) => ({ ...prev, search: event.target.value }))}
          />
          <select
            aria-label="Filter by category"
            className="hive-control sg-select gd-category-select"
            value={filter.category}
            onChange={(event) =>
              setFilter((prev) => ({ ...prev, category: event.target.value }))
            }
          >
            <option value={ALL_CATEGORIES}>All categories</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <DataTableFilterChip
            active={filter.modifiedOnly}
            count={modifiedCount}
            data-testid="rule-catalog-modified-chip"
            onClick={() => setFilter((prev) => ({ ...prev, modifiedOnly: !prev.modifiedOnly }))}
          >
            <PencilLine aria-hidden className="gd-chip-glyph" />
            Modified only
          </DataTableFilterChip>
          <DataTableToolbarSpacer />
          <span className="sg-quiet">
            Severity is per guide; the default pill shows the catalog baseline.
          </span>
        </DataTableToolbar>

        {groups.length === 0 ? (
          <EmptyState
            variant="compact"
            // The card it sits in is already the surface; a second one would draw a panel
            // inside a panel.
            surface={false}
            icon={<ListChecks aria-hidden />}
            title={
              filter.modifiedOnly && modifiedCount === 0
                ? 'No rules have been modified.'
                : 'No rules match your search.'
            }
            description="Clear the search, the category or the Modified only filter to see the rest of the catalog."
            data-testid="rule-catalog-empty"
          />
        ) : (
          groups.map((group) => (
            <section
              key={group.category}
              aria-label={`${group.category} rules`}
              className="gd-rule-group"
            >
              <div className="gd-rule-group__head">
                <span className="gd-rule-group__name">{group.category}</span>
                <span className="gd-rule-group__count">
                  {group.enabled} of {group.rules.length} on
                </span>
              </div>
              <ul>
                {group.rules.map((rule) => {
                  const draft = state.draft[rule.ruleId];
                  const modified = isRuleModified(rule.ruleId, state.draft, state.baseline);
                  return (
                    <li
                      key={rule.ruleId}
                      className="gd-rule-row"
                      // `data-off` rather than an opacity class: the row is *quieter* when
                      // the rule is off, but its ink still has to clear AA, so the styling
                      // is a token swap in the stylesheet rather than a fade.
                      data-off={draft?.enabled ? undefined : ''}
                    >
                      <Switch
                        aria-label={`Enable ${rule.ruleId}`}
                        checked={Boolean(draft?.enabled)}
                        disabled={locked}
                        onCheckedChange={(checked) =>
                          state.setRuleState(rule.ruleId, { enabled: checked })
                        }
                      />
                      <div className="gd-rule-row__text">
                        <div className="gd-rule-row__line">
                          <code className="gd-rule-id">{rule.ruleId}</code>
                          <Badge status={rule.defaultSeverity}>
                            default: {rule.defaultSeverity}
                          </Badge>
                          {modified && <Badge variant="accent">modified</Badge>}
                        </div>
                        <p className="gd-rule-row__why">{rule.rationale}</p>
                      </div>
                      <select
                        aria-label={`Severity for ${rule.ruleId}`}
                        className="hive-control sg-select gd-severity-select"
                        value={draft?.severity ?? rule.severity}
                        // A rule that is off has no severity to speak of: the select is
                        // inert until it is switched on, which is what the mockup draws.
                        disabled={locked || !draft?.enabled}
                        onChange={(event) =>
                          state.setRuleState(rule.ruleId, {
                            severity: event.target.value as RuleSeverity,
                          })
                        }
                      >
                        {SEVERITY_OPTIONS.map((severity) => (
                          <option key={severity.value} value={severity.value}>
                            {severity.label}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}

        <DataTableFoot>
          <span data-testid="rule-catalog-foot">
            {catalogFootSentence(visible.length, rules.length, groups.length)}
          </span>
        </DataTableFoot>
      </Card>

      {state.dirty && (
        <GuideSaveBar
          data-testid="rule-catalog-save-bar"
          label={unsavedRulesSentence(state.modifiedIds.length)}
          saving={state.saving}
          canSave={!readOnly}
          saveLabel="Save changes"
          onDiscard={state.discard}
          onSave={() => void state.save()}
        />
      )}
    </div>
  );
}
